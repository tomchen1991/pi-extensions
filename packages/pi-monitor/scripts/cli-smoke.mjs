// Real RPC/print/JSON subprocesses; synthetic provider, isolated HOME, temporary loopback WS.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { ClientFrameSchema } from "../dist/src/contract.js";

const sdk = process.env.PI_SDK_DIR;
assert.ok(sdk && path.isAbsolute(sdk) && existsSync(path.join(sdk, "dist/cli.js")), "Set PI_SDK_DIR to the installed SDK package root");
const root = realpathSync(mkdtempSync(path.join(tmpdir(), "monitor-cli-")));
const children = [];
const frames = [];
let serverFailure;
const server = new WebSocketServer({ host: "127.0.0.1", port: 0, perMessageDeflate: false });
async function until(test, label, child) {
  const deadline = Date.now() + 15000;
  while (!test()) {
    if (serverFailure) throw serverFailure;
    if (child?.failure) throw child.failure;
    if (child?.exit) throw Error(`Early child exit awaiting ${label}: ${JSON.stringify(child.exit)}`);
    if (Date.now() >= deadline) throw Error(`Deadline awaiting ${label}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
try {
  await new Promise((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
  server.on("connection", (socket, request) => {
    try { assert.equal(request.headers.authorization, "Bearer synthetic-token"); } catch (error) { serverFailure = error; }
    socket.on("message", raw => {
      try {
        const frame = ClientFrameSchema.parse(JSON.parse(raw.toString()));
        frames.push(frame);
        if (frame.type === "hello") socket.send(JSON.stringify({ version: 1, type: "ready", collectorEpoch: frame.collectorEpoch }));
        if (frame.type === "events") socket.send(JSON.stringify({ version: 1, type: "ack", collectorEpoch: frame.collectorEpoch, eventIds: frame.events.map(e => e.eventId) }));
      } catch (error) { serverFailure = error; }
    });
  });
  const events = device => frames.filter(f => f.type === "events" && f.source.deviceId === device).flatMap(f => f.events);
  function start(mode, activation) {
    const device = `cli-${children.length}`;
    const cwd = path.join(root, device);
    // Separate agent directories; no inherited credentials, telemetry flags or user configuration.
    const args = [path.join(sdk, "dist/cli.js"), ...(mode === "text" ? ["--print"] : ["--mode", mode]),
      "--offline", "--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-tools",
      "-e", fileURLToPath(new URL("./fixtures/cli-provider.mjs", import.meta.url)),
      "-e", fileURLToPath(new URL("../src/extension.ts", import.meta.url)),
      "--provider", "monitor-offline", "--model", "fixture",
      ...(mode === "rpc" ? [] : ["SECRET_CLI_PROMPT"]), ...(activation === "flag" ? ["--monitor"] : [])];
    const child = spawn(process.execPath, args, { cwd: root, env: {
      PATH: process.env.PATH, HOME: root, PI_CODING_AGENT_DIR: cwd, PI_SKIP_VERSION_CHECK: "1",
      PI_MONITOR_URL: `ws://127.0.0.1:${server.address().port}/ingest`, PI_MONITOR_TOKEN: "synthetic-token",
      PI_MONITOR_DEVICE_ID: device, PI_MONITOR_PROJECT_ID: "synthetic-project",
      ...(activation === "env" ? { PI_MONITOR_ENABLED: "1" } : {}),
    }, stdio: ["pipe", "pipe", "pipe"] });
    const state = { child, device, records: [], stdout: "", exit: null, failure: null };
    state.done = new Promise(resolve => child.once("close", (code, signal) => { state.exit = { code, signal }; resolve(); }));
    child.on("error", error => { state.failure = error; });
    child.stderr.resume(); // Do not log raw protocol/error payloads.
    let buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", chunk => {
      state.stdout += chunk;
      if (state.stdout.length > 1024 * 1024) { state.failure = Error("CLI output exceeded smoke limit"); child.kill("SIGKILL"); return; }
      if (mode !== "rpc") return;
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        if (!line.trim()) continue;
        try { state.records.push(JSON.parse(line)); } catch { state.failure = Error("Invalid RPC JSONL"); }
      }
    });
    let sequence = 0;
    state.command = async (type, fields = {}) => {
      const id = `test-${++sequence}`;
      child.stdin.write(JSON.stringify({ id, type, ...fields }) + "\n");
      await until(() => state.records.some(r => r.type === "response" && r.id === id), `RPC ${type}`, state);
      assert.equal(state.records.find(r => r.id === id)?.success, true, `RPC ${type} failed`);
    };
    children.push(state);
    return state;
  }
  async function finish(state) {
    const timer = setTimeout(() => { state.failure = Error("Child shutdown exceeded 5s"); state.child.kill("SIGKILL"); }, 5000);
    try { await state.done; } finally { clearTimeout(timer); }
    if (state.failure) throw state.failure;
    assert.deepEqual(state.exit, { code: 0, signal: null });
  }
  for (const mode of ["text", "json", "rpc"]) {
    for (const activation of ["off", "flag", "env"]) {
      const state = start(mode, activation);
      if (mode === "rpc") {
        await state.command("get_state"); // Readiness, not a fixed startup sleep.
        await state.command("prompt", { message: "SECRET_CLI_PROMPT" });
        await until(() => state.records.some(r => r.type === "agent_settled"), "RPC settle", state);
        if (activation !== "off") {
          await until(() => events(state.device).some(e => e.type === "pi.activity.settled"), "telemetry settle", state);
          const first = events(state.device).find(e => e.type === "pi.collector.started");
          await state.command("prompt", { message: "/monitor-test-reload" });
          await until(() => events(state.device).filter(e => e.type === "pi.collector.started").length === 2, "reload", state);
          const second = events(state.device).filter(e => e.type === "pi.collector.started")[1];
          assert.equal(second.source.instanceId, first.source.instanceId);
          assert.notEqual(second.collectorEpoch, first.collectorEpoch);
          assert.equal(second.data.state.usage.totalTokens, 0);
          await state.command("prompt", { message: "/monitor disable" });
          await state.command("prompt", { message: "/monitor-test-reload" });
          await state.command("get_state");
          await state.command("prompt", { message: "/monitor status" });
          const notice = state.records.filter(r => r.type === "extension_ui_request" && r.method === "notify").at(-1);
          assert.equal(JSON.parse(notice.message).enabled, false);
          assert.equal(events(state.device).filter(e => e.type === "pi.collector.started").length, 2);
        }
        // ExtensionContext shutdown executes the real mode cleanup path.
        state.child.stdin.write(JSON.stringify({ type: "prompt", message: "/monitor-test-quit" }) + "\n");
      } else state.child.stdin.end();
      await finish(state);
      const observed = events(state.device);
      if (activation === "off") {
        assert.equal(frames.filter(f => f.source.deviceId === state.device).length, 0, "Default-off must not connect");
      } else {
        assert.ok(observed.some(e => e.type === "pi.collector.started"));
        const request = observed.find(e => e.type === "pi.request.finished");
        assert.ok(request, `${mode}: missing request telemetry (${observed.map(e => e.type).join(",")})`);
        assert.equal(request.data.outcome, "completed");
        assert.equal(request.data.usage.tokens.totalTokens, 5);
        assert.ok(observed.some(e => e.type === "pi.activity.settled" && e.data.outcome === "completed"));
        assert.ok(observed.some(e => e.type === "pi.collector.stopped"));
        assert.equal(observed.find(e => e.type === "pi.collector.started").data.state.mode, mode === "text" ? "print" : mode);
      }
      if (mode === "text") assert.equal(state.stdout.trim(), "SECRET_CLI_REPLY");
      if (mode === "json") assert.ok(state.stdout.trim().split("\n").map(line => JSON.parse(line)).some(r => r.type === "message_end"));
      console.log(`Monitor CLI smoke passed: ${mode} --no-session, ${activation}`);
    }
  }
  assert.ok(!readdirSync(root, { recursive: true }).some(name => String(name).endsWith(".jsonl")), "--no-session must not persist transcripts");
  assert.ok(!JSON.stringify(frames).includes("SECRET_"));
  assert.ok(!JSON.stringify(frames).includes(root));
  assert.ok(!JSON.stringify(frames).includes("synthetic-token"));
  if (serverFailure) throw serverFailure;
} finally {
  for (const state of children) if (!state.exit) state.child.kill("SIGKILL");
  await Promise.all(children.map(state => state.done));
  for (const socket of server.clients) socket.terminate();
  await new Promise(resolve => server.close(resolve));
  rmSync(root, { recursive: true, force: true });
}
