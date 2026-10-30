// Real Pi loader + SessionManager, synthetic messages/UI/provider only. No credentials or network requests.
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { mkdtempSync, realpathSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import { ObservationStore, inspect, observationFilename } from "../dist/src/storage.js";
import { collect } from "../dist/src/collector.js";
import { branch, draft, model } from "../dist/test/fixtures/synthetic.js";
const base = process.env.PI_SDK_DIR;
if (!base) throw Error("Set PI_SDK_DIR to the installed pi-coding-agent package root");
const { SessionManager } = await import(pathToFileURL(path.join(base, "dist/core/session-manager.js")));
const { loadExtensions } = await import(pathToFileURL(path.join(base, "dist/core/extensions/loader.js")));
const session = SessionManager.inMemory("/synthetic/project");
const first = session.appendMessage({ role: "user", content: "原始内容", timestamp: Date.now() });
const second = session.appendMessage({ role: "user", content: "待删除的内容", timestamp: Date.now() });
session.appendContextEdit(first, { content: "替换后的内容" });
session.appendContextEdit(second, null);
const collected = collect(session.getBranch(), session.getLeafId());
assert.deepEqual(collected.entries.map(e => e.text), ["替换后的内容"]);
assert.deepEqual(collected.entries.map(e => e.text), session.buildSessionProjection().messages.filter(m => m.role === "user").map(m => m.content));
assert.equal(collected.entries[0].actor, "unknown");
session.appendCompaction("不能作为人类证据的摘要", first, 100);
assert.ok(!JSON.stringify(collect(session.getBranch(), session.getLeafId())).includes("不能作为人类证据"));
session.branch(second);
assert.deepEqual(collect(session.getBranch(), session.getLeafId()).entries.map(e => e.text), ["原始内容", "待删除的内容"]);

const cwd = realpathSync(mkdtempSync(path.join(os.tmpdir(), "pi-observation-sdk-")));
const oldDirectory = process.env.PI_WORK_INSIGHTS_DIR;
process.env.PI_WORK_INSIGHTS_DIR = path.join(cwd, "insights");
let shutdown = () => {};
try {
  const loaded = await loadExtensions([fileURLToPath(new URL("../src/extension.ts", import.meta.url))], cwd);
  assert.deepEqual(loaded.errors, []);
  const plugin = loaded.extensions[0];
  const command = plugin.commands.get("insights");
  assert.ok(command);
  const sm = SessionManager.inMemory(cwd);
  const mapping = new Map(branch.map(e => [e.id, sm.appendMessage({ ...e.message, timestamp: Date.now() })]));
  const output = draft();
  for (const evidence of output.evidence) evidence.entryRef = mapping.get(evidence.entryRef);
  let calls = 0;
  let confirmations = 0;
  const notifications = [];
  const ctx = {
    cwd, mode: "tui", sessionManager: sm, isIdle: () => true, hasPendingMessages: () => false, model,
    ui: {
      confirm: async () => { confirmations++; return true; },
      notify: (...args) => notifications.push(args), setStatus() {}, getEditorText: () => "",
      setEditorText() { assert.fail("Producer must not modify the editor"); },
    },
    modelRegistry: {
      find: () => model, getRegisteredProviderConfig: () => undefined,
      streamSimple(_model, context, options) {
        calls++;
        assert.equal(context.tools, undefined);
        assert.equal(options.maxTokens, 4096);
        return { result: async () => ({ stopReason: "stop", content: [{ type: "text", text: JSON.stringify(output) }], usage: { input: 20, output: 30, totalTokens: 50 } }) };
      },
    },
  };
  const emit = name => { for (const handler of plugin.handlers.get(name) ?? []) assert.equal(handler({ aborted: false }, ctx), undefined); };
  shutdown = () => emit("session_shutdown");
  assert.equal(calls, 0);
  await command.handler("enable", ctx);
  const store = new ObservationStore(process.env.PI_WORK_INSIGHTS_DIR, cwd);
  assert.equal(store.settings().enabled, true, JSON.stringify(notifications));
  emit("agent_settled"); // Must return immediately, not wait for the nested model call.
  const deadline = Date.now() + 15000;
  let files = [];
  while (Date.now() < deadline) {
    files = readdirSync(store.outputDirectory).filter(name => name.endsWith(".json"));
    if (files.length) break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.equal(files.length, 1, JSON.stringify(notifications));
  const latest = store.latest();
  assert.equal(latest.file, `observations/${files[0]}`);
  assert.equal(files[0], observationFilename(latest.observationId, latest.observedAt));
  const observation = inspect(store.latestFile);
  assert.deepEqual(store.read(latest.observationId), observation);
  assert.equal(observation.reviewStatus, "unreviewed");
  assert.equal(observation.preferenceSignals.length, 2);
  assert.equal(observation.evidence[0].humanOrigin, "unverified");
  assert.equal(confirmations, 1); // No per-record review dialogs.
  await command.handler("extract", ctx);
  assert.equal(calls, 1); // Same input is not sent twice, including manual extraction.
  await command.handler("forget", ctx);
  assert.deepEqual(readdirSync(store.outputDirectory), []);
  assert.equal(store.latest(), undefined);
  assert.equal(store.settings().enabled, false);
  assert.equal(sm.getBranch().length, branch.length); // No injected memory, summaries or agent turns.
  console.log("Pi SDK smoke passed: TS load, edited branch projection, automatic timestamped JSON extraction, latest pointer, provenance, deduplication, forget; zero real model calls");
} finally {
  shutdown();
  if (oldDirectory === undefined) delete process.env.PI_WORK_INSIGHTS_DIR;
  else process.env.PI_WORK_INSIGHTS_DIR = oldDirectory;
  rmSync(cwd, { recursive: true, force: true });
}
