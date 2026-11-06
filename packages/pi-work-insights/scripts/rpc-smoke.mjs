// Actual Pi RPC subprocess + extension UI protocol. Temporary HOME, fake provider, synthetic messages only.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ObservationStore } from "../dist/src/storage.js";

const automatic = process.argv.includes("--auto");
const sdk = process.env.PI_SDK_DIR;
if (!sdk) throw Error("Set PI_SDK_DIR to the installed pi-coding-agent package root");
const cwd = realpathSync(mkdtempSync(path.join(os.tmpdir(), "insights-rpc-smoke-")));
const output = path.join(cwd, "output");
const store = new ObservationStore(output, cwd);
const children = [];
function start(optIn = true, auto = false) {
  const args = [path.join(sdk, "dist/cli.js"), "--mode", "rpc", "--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes",
    "-e", fileURLToPath(new URL("./fixtures/rpc-provider.mjs", import.meta.url)),
    "-e", fileURLToPath(new URL("../src/extension.ts", import.meta.url)),
    "--provider", "insights-offline", "--model", "fixture", ...(auto ? ["--work-insights-auto"] : optIn ? ["--work-insights-rpc"] : [])];
  const child = spawn(process.execPath, args, { cwd, env: {
    PATH: process.env.PATH, HOME: cwd, PI_CODING_AGENT_DIR: path.join(cwd, "agent"),
    PI_WORK_INSIGHTS_DIR: output, PI_SKIP_VERSION_CHECK: "1",
  }, stdio: ["pipe", "pipe", "pipe"] });
  children.push(child);
  const records = [];
  const waiters = new Set();
  let failure;
  let buffer = "";
  let sequence = 0;
  const fail = error => { failure = error; for (const w of [...waiters]) w.reject(error); };
  child.on("error", fail);
  child.on("exit", code => fail(Error(`RPC child exited (${code})`)));
  child.stderr.resume(); // Never print provider errors or full protocol records.
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", chunk => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, end).replace(/\r$/, ""); buffer = buffer.slice(end + 1);
      if (!line) continue;
      let record;
      try { record = JSON.parse(line); } catch { fail(Error("Invalid RPC JSONL")); return; }
      records.push(record);
      for (const w of [...waiters]) if (w.match(record)) w.resolve(record);
    }
  });
  const send = record => child.stdin.write(JSON.stringify(record) + "\n");
  const wait = (match, timeout = 15000) => {
    if (failure) return Promise.reject(failure);
    const existing = records.find(match);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const finish = (fn, value) => { clearTimeout(timer); waiters.delete(w); fn(value); };
      const w = { match, resolve: value => finish(resolve, value), reject: error => finish(reject, error) };
      const timer = setTimeout(() => w.reject(Error("RPC smoke deadline exceeded")), timeout);
      waiters.add(w);
    });
  };
  function command(type, fields = {}, timeout) {
    const id = `req-${++sequence}`;
    const response = wait(r => r.type === "response" && r.id === id, timeout);
    send({ id, type, ...fields });
    return response.then(r => { assert.equal(r.success, true, `RPC ${type} failed`); return r; });
  }
  const prompt = message => command("prompt", { message });
  const seen = new Set();
  const dialog = () => wait(r => r.type === "extension_ui_request" && r.method === "confirm" && !seen.has(r.id)).then(r => { seen.add(r.id); return r; });
  async function status() {
    const offset = records.length;
    await prompt("/insights status");
    const r = records.slice(offset).find(r => r.method === "notify" && r.message?.startsWith('{"type":"work_insights_status"'));
    assert.ok(r, "Missing structured insights status");
    return JSON.parse(r.message);
  }
  const answer = (request, approved) => send({ type: "extension_ui_response", id: request.id, confirmed: approved });
  return { child, records, wait, command, prompt, dialog, status, answer };
}
async function stop(client) {
  const exited = once(client.child, "exit");
  client.child.stdin.end();
  const timer = setTimeout(() => client.child.kill("SIGKILL"), 5000);
  try { await exited; } finally { clearTimeout(timer); }
}
try {
  if (automatic) {
    const client = start(true, true); // No --work-insights-rpc or consent-capable host needed.
    await client.command("get_commands");
    assert.equal((await client.status()).activation, "host_auto");
    const settled = client.wait(r => r.type === "agent_settled");
    await client.prompt("合成用户任务：只验证自动采集，不能使用观察结果。");
    await settled;
    await client.wait(r => r.method === "setStatus" && r.statusText?.includes("已输出 JSON"));
    assert.ok(store.latest());
    assert.equal((await client.status()).enabled, true);
    assert.equal(store.settings().attempts.length, 1);
    await client.prompt("/insights extract");
    assert.equal(store.settings().attempts.length, 1);
    assert.ok(!client.records.some(r => r.method === "confirm"));
    await stop(client);

    const generic = start(false);
    await generic.command("get_commands");
    await generic.prompt("/insights extract");
    assert.ok(generic.records.some(r => r.method === "notify" && r.notifyType === "warning"));
    await stop(generic);
    assert.equal(store.settings().attempts.length, 1);

    const paused = start(true, true);
    assert.equal((await paused.status()).enabled, true);
    await paused.prompt("/insights pause");
    assert.equal((await paused.status()).enabled, false);
    await stop(paused);

    const restarted = start(true, true);
    await restarted.prompt("/insights extract");
    assert.equal((await restarted.status()).enabled, false);
    assert.equal(store.settings().attempts.length, 1);
    await restarted.prompt("/insights enable"); // Explicit resume has no modal either.
    assert.equal((await restarted.status()).enabled, true);
    await restarted.prompt("/insights forget");
    assert.equal(store.latest(), undefined);
    assert.equal((await restarted.status()).enabled, false);
    assert.ok(!restarted.records.some(r => r.method === "confirm"));
    await stop(restarted);

    const forgotten = start(true, true);
    await forgotten.prompt("/insights extract");
    assert.equal((await forgotten.status()).enabled, false);
    assert.ok(!forgotten.records.some(r => r.method === "confirm"));
    await stop(forgotten);
    console.log("Pi automatic RPC smoke passed: first-run output, zero dialogs, dedup, ordinary RPC gate, restart, pause persistence, explicit resume and forget; zero network/model API requests");
  } else {
  const client = start();
  const commands = await client.command("get_commands");
  assert.ok(commands.data.commands.some(c => c.name === "insights"));
  assert.equal((await client.status()).enabled, false);

  let pending = client.prompt("/insights enable");
  let request = await client.dialog();
  assert.equal(request.timeout, 60000);
  assert.match(request.message, /可能收费/);
  client.answer(request, false); await pending;
  assert.equal((await client.status()).enabled, false);

  // An unanswered native RPC dialog must time out closed, without a client-side fallback approval.
  pending = client.command("prompt", { message: "/insights enable" }, 65000);
  request = await client.dialog();
  await pending;
  assert.equal((await client.status()).enabled, false);
  client.answer(request, true); // Late reply to an expired ID must not authorize.
  assert.equal((await client.status()).enabled, false);

  pending = client.prompt("/insights enable"); request = await client.dialog();
  await client.prompt("/insights pause"); await pending;
  client.answer(request, true);
  assert.equal((await client.status()).enabled, false);

  pending = client.prompt("/insights enable"); request = await client.dialog();
  client.answer(request, true); await pending;
  assert.equal((await client.status()).enabled, true);
  const settled = client.wait(r => r.type === "agent_settled");
  await client.prompt("合成测试：本次只适配工作信息采集，不消费这些数据。");
  await settled;
  await client.wait(r => r.method === "setStatus" && r.statusText?.includes("已输出 JSON"));
  assert.ok(store.latest());
  assert.equal(store.read(store.latest().observationId).reviewStatus, "unreviewed");
  assert.equal(store.settings().attempts.length, 1);
  await client.prompt("/insights extract");
  assert.equal(store.settings().attempts.length, 1); // Same-window deduplication.
  await stop(client);

  // A generic RPC host must not restore this persisted grant without capability opt-in.
  const generic = start(false);
  await generic.command("get_commands");
  await generic.prompt("/insights extract");
  await stop(generic);
  assert.equal(store.settings().attempts.length, 1);

  const restored = start();
  assert.equal((await restored.status()).enabled, true); // Same persistent project authorization.
  await restored.prompt("/insights pause");
  assert.equal((await restored.status()).enabled, false);
  pending = restored.prompt("/insights forget"); request = await restored.dialog();
  restored.answer(request, true); await pending;
  assert.equal(store.latest(), undefined);
  assert.equal((await restored.status()).enabled, false);
  await stop(restored);
  console.log("Pi RPC smoke passed: actual JSONL commands, denial, timeout, late consent, pause, automatic output, dedup, restart, capability gate, forget; zero network/model API requests");
  }
} finally {
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  // Wait for all children before deleting their temporary files.
  await Promise.all(children.filter(c => c.exitCode === null && c.signalCode === null).map(c => once(c, "exit")));
  rmSync(cwd, { recursive: true, force: true });
}
