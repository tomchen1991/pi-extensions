// Actual SDK loader/session/agent loop + faux provider + temporary loopback WS fixture.
// No real credentials, personal sessions, persistent services, or paid model requests.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WebSocketServer } from "ws";
import { ClientFrameSchema } from "../dist/src/contract.js";

const sdkDir = process.env.PI_SDK_DIR;
if (!sdkDir || !path.isAbsolute(sdkDir)) throw Error("Set PI_SDK_DIR to an installed pi-coding-agent package root");
const dir = mkdtempSync(path.join(tmpdir(), "pi-monitor-sdk-"));
const keys = ["HOME", "PI_CODING_AGENT_DIR", "PI_MONITOR_ENABLED", "PI_MONITOR_URL", "PI_MONITOR_TOKEN", "PI_MONITOR_DEVICE_ID", "PI_MONITOR_PROJECT_ID"];
const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
const originalFetch = globalThis.fetch;
let session;
let server;
try {
  process.env.HOME = process.env.PI_CODING_AGENT_DIR = dir;
  delete process.env.PI_MONITOR_ENABLED;
  delete process.env.PI_MONITOR_PROJECT_ID;
  globalThis.fetch = async () => { throw Error("Unexpected network fetch in offline SDK smoke"); };
  const require = createRequire(path.join(sdkDir, "package.json"));
  const aiPath = require.resolve.paths("@earendil-works/pi-ai").map(root => path.join(root, "@earendil-works/pi-ai/dist/index.js")).find(existsSync);
  assert.ok(aiPath);
  const { fauxProvider, fauxAssistantMessage, fauxToolCall } = await import(pathToFileURL(aiPath));
  const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = await import(pathToFileURL(path.join(sdkDir, "dist/index.js")));
  server = new WebSocketServer({ host: "127.0.0.1", port: 0, perMessageDeflate: false });
  await new Promise((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
  process.env.PI_MONITOR_URL = `ws://127.0.0.1:${server.address().port}/ingest`;
  process.env.PI_MONITOR_TOKEN = "synthetic-token";
  process.env.PI_MONITOR_DEVICE_ID = "synthetic-device";
  const frames = [], events = [];
  let connections = 0;
  let serverFailure;
  server.on("connection", (socket, request) => {
    connections++;
    try { assert.equal(request.headers.authorization, "Bearer synthetic-token"); } catch (error) { serverFailure = error; }
    socket.on("message", raw => {
      try {
        const frame = ClientFrameSchema.parse(JSON.parse(raw.toString()));
        frames.push(frame);
        if (frame.type === "hello") socket.send(JSON.stringify({ version: 1, type: "ready", collectorEpoch: frame.collectorEpoch }));
        if (frame.type === "events") {
          events.push(...frame.events);
          socket.send(JSON.stringify({ version: 1, type: "ack", collectorEpoch: frame.collectorEpoch, eventIds: frame.events.map(e => e.eventId) }));
        }
      } catch (error) { serverFailure = error; }
    });
  });
  async function until(condition) {
    const end = Date.now() + 5000;
    while (!condition()) {
      if (serverFailure) throw serverFailure;
      if (Date.now() >= end) throw Error("SDK smoke timed out awaiting telemetry");
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
  const faux = fauxProvider({ provider: "monitor-fake" });
  const runtime = await ModelRuntime.create({ authPath: path.join(dir, "auth.json"), modelsPath: null, refreshOnCreate: false });
  runtime.registerNativeProvider(faux.provider);
  const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager: settings,
    noExtensions: true, additionalExtensionPaths: [fileURLToPath(new URL("../src/extension.ts", import.meta.url))],
    noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  ({ session } = await createAgentSession({ cwd: dir, agentDir: dir, modelRuntime: runtime, model: faux.getModel(),
    resourceLoader: loader, noTools: "builtin", sessionManager: SessionManager.inMemory(dir), settingsManager: settings,
    customTools: [{ name: "synthetic_tool", label: "Synthetic", description: "Offline fixture", parameters: { type: "object", properties: {} },
      execute: async () => ({ content: [{ type: "text", text: "SECRET_TOOL_OUTPUT" }], details: undefined,
        usage: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 5, cost: { input: 0.001, output: 0.001, cacheRead: 0, cacheWrite: 0, total: 0.002 } } }) }] }));
  const extensionErrors = [];
  await session.bindExtensions({ mode: "tui", uiContext: { ...session.extensionRunner.getUIContext(), notify() {}, setStatus() {} },
    onError: error => extensionErrors.push(error) });
  assert.equal(connections, 0, "Default-off must not connect even when credentials are configured");
  faux.setResponses([fauxAssistantMessage("SECRET_DISABLED_REPLY")]);
  await session.prompt("SECRET_DISABLED_PROMPT");
  assert.equal(connections, 0);
  await session.prompt("/monitor enable");
  await until(() => events.some(e => e.type === "pi.collector.started"));
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("synthetic_tool", {}), { stopReason: "toolUse" }),
    fauxAssistantMessage("SECRET_RESPONSE"),
  ]);
  await session.prompt("SECRET_PROMPT");
  await until(() => events.some(e => e.type === "pi.activity.settled"));
  assert.equal(events.filter(e => e.type === "pi.request.finished").length, 2);
  assert.ok(events.some(e => e.type === "pi.tool.finished" && e.data.outcome === "completed"));
  assert.equal(events.find(e => e.type === "pi.activity.settled").data.outcome, "completed");
  // Faux provider calculates its own usage from context, overriding supplied fixture usage.
  // Compare to authoritative SDK messages, not a hand-written token count.
  const sdkUsage = session.messages.filter(m => m.role === "assistant").slice(-2).map(m => m.usage);
  const sdkTokens = sdkUsage.reduce((sum, u) => sum + u.totalTokens, 0);
  assert.ok(sdkTokens > 0);
  assert.deepEqual(events.filter(e => e.type === "pi.request.finished").map(e => e.data.usage.tokens),
    sdkUsage.map(u => ({ input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite, totalTokens: u.totalTokens, reasoning: u.reasoning ?? null })));
  assert.equal(events.find(e => e.type === "pi.tool.finished").data.usage.tokens.totalTokens, 5);
  await until(() => frames.some(f => f.type === "snapshot" && f.state.usage.totalTokens === sdkTokens + 5));
  const firstEpoch = events[0].collectorEpoch;
  const firstInstance = events[0].source.instanceId;
  assert.ok(!JSON.stringify(frames).includes("SECRET_"));
  assert.ok(!JSON.stringify(frames).includes(dir));
  assert.ok(!JSON.stringify(frames).includes("synthetic-token"));
  const before = events.filter(e => e.type === "pi.request.finished").length;
  // Simulate the documented shutdown/reload/start events with the real extension runner.
  await session.extensionRunner.emit({ type: "session_shutdown", reason: "reload" });
  process.env.PI_MONITOR_ENABLED = "1";
  await session.extensionRunner.emit({ type: "session_start" });
  await until(() => events.filter(e => e.type === "pi.collector.started").length === 2);
  const restarted = events.filter(e => e.type === "pi.collector.started").at(-1);
  assert.notEqual(restarted.collectorEpoch, firstEpoch);
  assert.equal(restarted.source.instanceId, firstInstance);
  assert.equal(restarted.data.state.usage.totalTokens, 0, "Reload must not recount prior usage");
  assert.equal(events.filter(e => e.type === "pi.request.finished").length, before);
  faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "SECRET_PROVIDER_ERROR" })]);
  await session.prompt("SECRET_FAILURE_PROMPT");
  await until(() => events.some(e => e.type === "pi.request.finished" && e.data.outcome === "error"));
  assert.ok(!JSON.stringify(frames).includes("SECRET_"));
  let abortRequestStarted = false;
  faux.setResponses([async (_context, options) => {
    abortRequestStarted = true;
    await new Promise(resolve => {
      if (options.signal.aborted) resolve();
      else options.signal.addEventListener("abort", resolve, { once: true });
    });
    return fauxAssistantMessage("", { stopReason: "aborted" });
  }]);
  const pending = session.prompt("SECRET_ABORT_PROMPT");
  await until(() => abortRequestStarted);
  await session.abort();
  await pending;
  await until(() => events.some(e => e.type === "pi.activity.settled" && e.data.outcome === "aborted"));
  assert.ok(events.some(e => e.type === "pi.request.finished" && e.data.outcome === "aborted"));
  await session.prompt("/monitor disable");
  const connectionCount = connections;
  await session.extensionRunner.emit({ type: "session_start" });
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(connections, connectionCount, "Disable must survive session replacement/reload in this process");
  assert.deepEqual(extensionErrors, []);
  if (serverFailure) throw serverFailure;
  console.log("Monitor SDK smoke passed: real loader + agent loop, opt-in, model/tool usage, error/abort, reload identity, no historical recount, disable, content exclusion; zero paid calls");
} finally {
  if (session) {
    await session.abort();
    await session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose();
  }
  if (server) { for (const socket of server.clients) socket.terminate(); await new Promise(resolve => server.close(resolve)); }
  globalThis.fetch = originalFetch;
  for (const key of keys) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
  rmSync(dir, { recursive: true, force: true });
}
