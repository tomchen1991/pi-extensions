// Real Pi loader and lifecycle; synthetic messages, temporary directories, no network.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const sdkDir = process.env.PI_SDK_DIR;
if (!sdkDir || !path.isAbsolute(sdkDir)) throw Error("Set PI_SDK_DIR to an installed pi-coding-agent package root");
const dir = mkdtempSync(path.join(tmpdir(), "pi-token-usage-sdk-"));
const saved = Object.fromEntries(["HOME", "PI_CODING_AGENT_DIR", "PI_TOKEN_USAGE_DIR"].map(key => [key, process.env[key]]));
const originalFetch = globalThis.fetch;
let session;
async function bounded(operation) {
  let timer;
  try { return await Promise.race([operation, new Promise((_, reject) => { timer = setTimeout(() => reject(Error("Offline SDK timeout")), 15000); })]); }
  finally { clearTimeout(timer); }
}
try {
  const agentDir = path.join(dir, "agent"), cwd = path.join(dir, "project"), output = path.join(dir, "output");
  mkdirSync(agentDir); mkdirSync(cwd);
  process.env.HOME = process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_TOKEN_USAGE_DIR = output;
  globalThis.fetch = async () => { throw Error("Network forbidden in offline smoke"); };
  const require = createRequire(path.join(sdkDir, "package.json"));
  const aiPath = require.resolve.paths("@earendil-works/pi-ai").map(root => path.join(root, "@earendil-works/pi-ai/dist/index.js")).find(existsSync);
  assert.ok(aiPath);
  const { fauxProvider, fauxAssistantMessage: reply, createAssistantMessageEventStream } = await import(pathToFileURL(aiPath));
  const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = await import(pathToFileURL(path.join(sdkDir, "dist/index.js")));
  const faux = fauxProvider({ provider: "usage-synthetic", models: [{ id: "synthetic" }] });
  const runtime = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
  // Faux normally replaces supplied usage with estimates. Use an explicit synthetic
  // stream so all three counters (including cache-write mapping) are tested exactly.
  const stream = model => {
    const events = createAssistantMessageEventStream();
    const message = { ...reply("SYNTHETIC_BODY_MUST_NOT_BE_STORED"), provider: model.provider, model: model.id,
      usage: { input: 100, output: 20, cacheRead: 300, cacheWrite: 40, totalTokens: 460,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    queueMicrotask(() => {
      events.push({ type: "start", partial: message });
      events.push({ type: "done", reason: "stop", message });
      events.end(message);
    });
    return events;
  };
  runtime.registerNativeProvider({ ...faux.provider, stream, streamSimple: stream });
  await runtime.setRuntimeApiKey("usage-synthetic", "synthetic-key");
  const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager: settings, noExtensions: true,
    additionalExtensionPaths: [fileURLToPath(new URL("../src/extension.ts", import.meta.url))],
    noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
  await bounded(loader.reload()); assert.deepEqual(loader.getExtensions().errors, []);
  assert.equal(existsSync(output), false, "No collection at factory load");
  ({ session } = await bounded(createAgentSession({ cwd, agentDir, modelRuntime: runtime, model: faux.getModel(),
    resourceLoader: loader, settingsManager: settings, noTools: "builtin", sessionManager: SessionManager.inMemory(cwd) })));
  const errors = [];
  await bounded(session.bindExtensions({ mode: "tui", uiContext: { ...session.extensionRunner.getUIContext(),
    notify: text => errors.push(text) }, onError: error => errors.push(error) }));
  assert.equal(existsSync(output), false, "No startup/history collection");
  await bounded(session.prompt("Synthetic prompt"));
  const files = readdirSync(output, { recursive: true }).filter(file => file.endsWith(".json"));
  assert.equal(files.length, 1);
  const text = readFileSync(path.join(output, files[0]), "utf8");
  const record = JSON.parse(text);
  assert.equal(record.provider, "usage-synthetic");
  assert.equal(record.model, "synthetic");
  assert.deepEqual(record.tokens, { cachedInput: 300, uncachedInput: 140, output: 20 });
  assert.equal(record.project.name, "project");
  assert.ok(record.hourStart.endsWith(":00:00.000Z"));
  assert.ok(!text.includes("SYNTHETIC_BODY") && !text.includes("Synthetic prompt"));
  assert.ok(!("sessionId" in record));
  assert.deepEqual(errors, []);
  console.log(`pi-token-usage SDK smoke passed (offline, SDK ${JSON.parse(readFileSync(path.join(sdkDir, "package.json"))).version})`);
} finally {
  if (session) { await session.abort(); session.dispose(); }
  globalThis.fetch = originalFetch;
  for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  rmSync(dir, { recursive: true, force: true });
}
