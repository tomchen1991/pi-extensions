// Real SDK loader + agent loop, synthetic providers and temporary sessions only.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const sdkDir = process.env.PI_SDK_DIR;
if (!sdkDir || !path.isAbsolute(sdkDir)) throw Error("Set PI_SDK_DIR to the installed pi-coding-agent package root");
const dir = mkdtempSync(path.join(tmpdir(), "pi-fallback-sdk-"));
const saved = Object.fromEntries(["HOME", "PI_CODING_AGENT_DIR"].map(key => [key, process.env[key]]));
const originalFetch = globalThis.fetch;
const sessions = [];
try {
  process.env.HOME = process.env.PI_CODING_AGENT_DIR = dir;
  globalThis.fetch = async () => { throw Error("Network forbidden in offline smoke"); };
  const require = createRequire(path.join(sdkDir, "package.json"));
  const aiPath = require.resolve.paths("@earendil-works/pi-ai").map(root => path.join(root, "@earendil-works/pi-ai/dist/index.js")).find(existsSync);
  assert.ok(aiPath, "SDK pi-ai dependency must be available");
  const { fauxProvider, fauxAssistantMessage: reply, fauxToolCall } = await import(pathToFileURL(aiPath));
  const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } =
    await import(pathToFileURL(path.join(sdkDir, "dist/index.js")));
  const errors = [];
  const notices = [];
  const modelId = "synthetic-codex";
  const codex = fauxProvider({ provider: "openai-codex", models: [{ id: modelId, reasoning: true }] });
  const api = fauxProvider({ provider: "openai", models: [{ id: modelId, reasoning: true }] });
  api.models[0].baseUrl = "https://api.openai.com/v1";
  const runtime = await ModelRuntime.create({ authPath: path.join(dir, "auth.json"), modelsPath: null, refreshOnCreate: false });
  runtime.registerNativeProvider(codex.provider);
  runtime.registerNativeProvider(api.provider);
  await runtime.setRuntimeApiKey("openai-codex", "synthetic-codex-key");
  await runtime.setRuntimeApiKey("openai", "synthetic-api-key");
  let toolCalls = 0;
  async function start(sm = SessionManager.create(dir, path.join(dir, "sessions")), model) {
    const settings = SettingsManager.inMemory({ defaultProvider: "openai-codex", defaultModel: modelId,
      enabledModels: [`openai-codex/${modelId}`], compaction: { enabled: false }, retry: { enabled: false } });
    const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager: settings,
      noExtensions: true, additionalExtensionPaths: [fileURLToPath(new URL("../src/extension.ts", import.meta.url))],
      noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const { session } = await createAgentSession({ cwd: dir, agentDir: dir, modelRuntime: runtime, model: model ?? (sm.getEntries().length === 0 ? codex.getModel() : undefined),
      scopedModels: [{ model: codex.getModel() }], resourceLoader: loader, noTools: "builtin", sessionManager: sm,
      settingsManager: settings, customTools: [{ name: "synthetic_tool", label: "Synthetic", description: "Offline fixture",
        parameters: { type: "object", properties: {} }, execute: async () => {
          toolCalls++; return { content: [{ type: "text", text: "synthetic tool result" }], details: undefined };
        } }] });
    sessions.push(session);
    await session.bindExtensions({ mode: "tui", uiContext: { ...session.extensionRunner.getUIContext(),
      notify: (message) => notices.push(message) }, onError: error => errors.push(error) });
    return { session, settings };
  }
  async function prompt(session, text) {
    let timer;
    try {
      await Promise.race([session.prompt(text), new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error("Offline SDK prompt timed out")), 5000);
      })]);
    } finally { clearTimeout(timer); }
  }
  const { session, settings } = await start();
  session.setThinkingLevel("high");
  codex.setResponses([
    reply(fauxToolCall("synthetic_tool", {}), { stopReason: "toolUse" }),
    reply("", { stopReason: "error", errorMessage: "usage_limit_reached" }),
  ]);
  api.setResponses([(context) => {
    const messages = context.messages;
    assert.equal(messages.filter(m => m.role === "user").length, 1, "No duplicate user prompt");
    assert.equal(messages.filter(m => m.role === "toolResult").length, 1, "Completed tool is preserved");
    assert.ok(!messages.some(m => m.role === "assistant" && m.stopReason === "error"));
    return reply("synthetic resumed reply");
  }, reply("synthetic second reply")]);
  await prompt(session, "synthetic original request");
  assert.equal(session.model.provider, "openai");
  assert.equal(session.thinkingLevel, "high");
  assert.equal(toolCalls, 1);
  assert.equal(api.state.callCount, 1);
  assert.equal(session.scopedModels.length, 1);
  assert.equal(session.scopedModels[0].model.provider, "openai-codex");
  assert.equal(settings.getDefaultProvider(), "openai-codex");
  assert.deepEqual(settings.getEnabledModels(), [`openai-codex/${modelId}`]);
  assert.ok(session.sessionManager.getEntries().some(e => e.type === "context_edit"));
  await prompt(session, "synthetic next request");
  assert.equal(api.state.callCount, 2);
  assert.equal(codex.state.callCount, 2);
  const sessionFile = session.sessionManager.getSessionFile();
  assert.ok(sessionFile && existsSync(sessionFile));
  // Restoration selects the persisted API model, without forcing it via start's model argument.
  const restored = await start(SessionManager.open(sessionFile), undefined);
  assert.equal(restored.session.model.provider, "openai");

  for (const errorMessage of ["429 Too many requests", "You have hit your ChatGPT usage limit. Try again in ~10080 min.", "fetch failed", "insufficient_quota"]) {
    const { session: test } = await start();
    const apiCalls = api.state.callCount;
    codex.setResponses([reply("", { stopReason: "error", errorMessage })]);
    await prompt(test, "synthetic failure");
    assert.equal(test.model.provider, "openai-codex", errorMessage);
    assert.equal(api.state.callCount, apiCalls);
  }
  // Actual SDK response-hook path: normalized friendly text plus quota headers.
  const { session: headerCase } = await start();
  codex.setResponses([async (_context, options, _state, model) => {
    assert.equal(typeof options.onResponse, "function");
    await options.onResponse({ status: 429, headers: { "x-codex-secondary-used-percent": "100" } }, model);
    return reply("", { stopReason: "error", errorMessage: "You have hit your ChatGPT usage limit." });
  }]);
  api.setResponses([reply("synthetic header recovery")]);
  await prompt(headerCase, "synthetic quota headers");
  assert.equal(headerCase.model.provider, "openai");

  const { session: cancelled } = await start();
  let requestStarted;
  const started = new Promise(resolve => { requestStarted = resolve; });
  codex.setResponses([async (_context, options) => {
    requestStarted();
    await new Promise(resolve => {
      if (options.signal.aborted) resolve();
      else options.signal.addEventListener("abort", resolve, { once: true });
    });
    return reply("", { stopReason: "aborted" });
  }]);
  const beforeAbort = api.state.callCount;
  const pending = prompt(cancelled, "synthetic cancellation");
  await Promise.race([started, new Promise((_, reject) => {
    const timer = setTimeout(() => reject(Error("Request did not start")), 4000);
    timer.unref();
  })]);
  await cancelled.abort();
  await pending;
  assert.equal(cancelled.model.provider, "openai-codex");
  assert.equal(api.state.callCount, beforeAbort);

  const { session: disabled } = await start();
  await prompt(disabled, "/model-fallback disable");
  codex.setResponses([reply("", { stopReason: "error", errorMessage: "usage_limit_reached" })]);
  await prompt(disabled, "synthetic disabled");
  assert.equal(disabled.model.provider, "openai-codex");
  const disabledRestored = await start(SessionManager.open(disabled.sessionManager.getSessionFile()), codex.getModel());
  codex.setResponses([reply("", { stopReason: "error", errorMessage: "usage_limit_reached" })]);
  await prompt(disabledRestored.session, "synthetic disabled after restore");
  assert.equal(disabledRestored.session.model.provider, "openai-codex");

  const { session: apiFailure } = await start();
  codex.setResponses([reply("", { stopReason: "error", errorMessage: "usage_limit_reached" })]);
  api.setResponses([reply("", { stopReason: "error", errorMessage: "insufficient_quota" })]);
  const count = api.state.callCount;
  await prompt(apiFailure, "synthetic API failure");
  assert.equal(api.state.callCount, count + 1, "No fallback loop on API errors");
  assert.equal(apiFailure.model.provider, "openai");
  assert.ok(notices.some(n => n.includes("按 API 计费")));
  assert.deepEqual(errors, []);
  console.log("pi-model-fallback SDK smoke passed (offline)");
} finally {
  for (const session of sessions) { await session.abort(); session.dispose(); }
  globalThis.fetch = originalFetch;
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  rmSync(dir, { recursive: true, force: true });
}
