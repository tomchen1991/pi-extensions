// Real SDK/loader/credential locks; synthetic OAuth and model responses only.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const sdkDir = process.env.PI_SDK_DIR;
if (!sdkDir || !path.isAbsolute(sdkDir)) throw Error("Set PI_SDK_DIR to an installed pi-coding-agent package root");
const dir = mkdtempSync(path.join(tmpdir(), "pi-accounts-sdk-"));
const saved = Object.fromEntries(["HOME", "PI_CODING_AGENT_DIR"].map(key => [key, process.env[key]]));
const originalFetch = globalThis.fetch;
const sessions = [];
async function bounded(operation, label) {
  let timer;
  try {
    return await Promise.race([operation, new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error(`Offline SDK timeout: ${label}`)), 8000);
    })]);
  } finally { clearTimeout(timer); }
}
try {
  process.env.HOME = process.env.PI_CODING_AGENT_DIR = path.join(dir, "agent");
  mkdirSync(process.env.HOME);
  globalThis.fetch = async () => { throw Error("Network forbidden in offline smoke"); };
  const require = createRequire(path.join(sdkDir, "package.json"));
  const aiPath = require.resolve.paths("@earendil-works/pi-ai")
    .map(root => path.join(root, "@earendil-works/pi-ai/dist/index.js")).find(existsSync);
  assert.ok(aiPath);
  const { fauxProvider, fauxAssistantMessage: reply, fauxToolCall } = await import(pathToFileURL(aiPath));
  const { CONFIG_DIR_NAME, createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } =
    await import(pathToFileURL(path.join(sdkDir, "dist/index.js")));
  const { AuthStorage } = await import(pathToFileURL(path.join(sdkDir, "dist/core/auth-storage.js")));
  const authPath = path.join(dir, "auth.json");
  const store = AuthStorage.create(authPath);
  const original = { type: "oauth", access: "synthetic-original", refresh: "synthetic-original-refresh", expires: Date.now() + 3600_000 };
  await store.modify("openai-codex", async () => original);
  const repos = ["a", "b"].map(name => {
    const cwd = path.join(dir, name); mkdirSync(cwd);
    execFileSync("git", ["init", "--quiet", cwd]);
    mkdirSync(path.join(cwd, CONFIG_DIR_NAME));
    writeFileSync(path.join(cwd, CONFIG_DIR_NAME, "codex-accounts.json"), JSON.stringify({ version: 1, account: "personal" }));
    return cwd;
  });
  const errors = [], notices = [], calls = [];
  const refreshes = { personal: 0, work: 0 };
  let toolCalls = 0;
  const routerId = "codex-accounts";
  const profileId = account => `codex-account-${account}`;
  async function start(cwd, sessionFile) {
    const runtime = await ModelRuntime.create({ authPath, modelsPath: null, modelsStorePath: path.join(dir, "catalog.json"), refreshOnCreate: false });
    const originalModel = runtime.getProvider("openai-codex").getModels()[0];
    assert.ok(originalModel);
    const settings = SettingsManager.inMemory({ defaultProvider: "openai-codex", defaultModel: originalModel.id,
      enabledModels: [`openai-codex/${originalModel.id}`], compaction: { enabled: false }, retry: { enabled: false } });
    settings.setProjectTrusted(true);
    const loader = new DefaultResourceLoader({ cwd, agentDir: process.env.HOME, settingsManager: settings,
      noExtensions: true, additionalExtensionPaths: [fileURLToPath(new URL("../src/extension.ts", import.meta.url))],
      noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
    await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
    const { session } = await createAgentSession({ cwd, agentDir: process.env.HOME, modelRuntime: runtime,
      model: sessionFile ? undefined : originalModel, resourceLoader: loader,
      sessionManager: sessionFile ? SessionManager.open(sessionFile) : SessionManager.create(cwd, path.join(dir, "sessions")),
      settingsManager: settings, scopedModels: [{ model: originalModel }], noTools: "builtin",
      customTools: [{ name: "synthetic_tool", label: "Synthetic", description: "Offline fixture",
        parameters: { type: "object", properties: {} }, execute: async () => {
          toolCalls++; return { content: [{ type: "text", text: "synthetic result" }], details: undefined };
        } }] });
    sessions.push(session);
    await session.bindExtensions({ mode: "tui", uiContext: { ...session.extensionRunner.getUIContext(),
      notify: message => notices.push(message) }, onError: error => errors.push(error) });
    // Replace only OAuth/network transport, preserving actual plugin registration and auth routing.
    for (const account of ["personal", "work"]) {
      const profile = runtime.getRegisteredNativeProvider(profileId(account));
      assert.ok(profile?.auth.oauth);
      runtime.registerNativeProvider({ ...profile, auth: { oauth: { ...profile.auth.oauth,
        login: async () => ({ type: "oauth", access: `synthetic-${account}-login`, refresh: `synthetic-${account}-refresh`, expires: Date.now() + 3600_000 }),
        refresh: async (credential, signal) => {
          signal.throwIfAborted(); refreshes[account]++;
          await new Promise(resolve => setTimeout(resolve, 30));
          return { ...credential, access: `synthetic-${account}-refreshed`, refresh: `synthetic-${account}-rotated`, expires: Date.now() + 3600_000 };
        },
        toAuth: async credential => ({ apiKey: credential.access, headers: { "ChatGPT-Account-Id": `synthetic-${account}` } }),
      } } });
    }
    const router = runtime.getRegisteredNativeProvider(routerId);
    assert.ok(router);
    const faux = fauxProvider({ provider: routerId, models: [{ id: originalModel.id, reasoning: true }] });
    runtime.registerNativeProvider({ ...router,
      stream: (model, context, options) => { calls.push({ apiKey: options.apiKey, headers: options.headers }); return faux.provider.stream(model, context, options); },
      streamSimple: (model, context, options) => { calls.push({ apiKey: options.apiKey, headers: options.headers }); return faux.provider.streamSimple(model, context, options); },
    });
    await runtime.refresh({ allowNetwork: false });
    return { runtime, session, settings, faux, modelId: originalModel.id };
  }
  const a = await bounded(start(repos[0]), "first startup");
  const interaction = { prompt: async () => { throw Error("Unexpected real login prompt"); }, notify: () => {} };
  // Exercise host-owned login persistence with synthetic provider flows.
  for (const account of ["personal", "work"]) await a.runtime.login(profileId(account), "oauth", interaction);
  const b = await bounded(start(repos[1]), "second startup");
  assert.equal(a.session.model.provider, routerId);
  assert.equal(a.session.model.id, a.modelId);
  assert.equal(b.session.model.provider, routerId);
  assert.equal(a.settings.getDefaultProvider(), "openai-codex");
  assert.equal(a.session.scopedModels[0].model.provider, "openai-codex");
  // Two independent runtimes sharing one file must rotate an expired refresh token only once.
  await store.modify(profileId("personal"), async credential => ({ ...credential, expires: 0 }));
  const auth = await bounded(Promise.all([a.runtime.getAuth(routerId), b.runtime.getAuth(routerId)]), "concurrent OAuth refresh");
  assert.equal(refreshes.personal, 1);
  assert.ok(auth.every(result => result.auth.apiKey === "synthetic-personal-refreshed"));
  assert.equal((await store.read(profileId("personal"))).refresh, "synthetic-personal-rotated");
  a.session.setThinkingLevel("high");
  a.faux.setResponses([reply(fauxToolCall("synthetic_tool", {}), { stopReason: "toolUse" }), reply("synthetic first reply")]);
  await bounded(a.session.prompt("synthetic first request"), "tool request");
  assert.equal(toolCalls, 1);
  await bounded(a.session.prompt("/codex-account use work"), "manual selection");
  assert.equal(a.session.thinkingLevel, "high");
  assert.equal(JSON.parse(readFileSync(path.join(repos[0], CONFIG_DIR_NAME, "codex-accounts.json"))).account, "work");
  assert.equal((await b.runtime.getAuth(routerId)).auth.apiKey, "synthetic-personal-refreshed");
  a.faux.setResponses([context => {
    assert.equal(context.messages.filter(m => m.role === "toolResult").length, 1);
    return reply("synthetic second reply");
  }]);
  await bounded(a.session.prompt("synthetic second request"), "post-switch request");
  assert.equal(toolCalls, 1, "No completed tool replay on account switch");
  assert.equal(calls.at(-1).apiKey, "synthetic-work-login");
  assert.equal(calls.at(-1).headers["ChatGPT-Account-Id"], "synthetic-work");
  const restored = await bounded(start(repos[0], a.session.sessionManager.getSessionFile()), "restore");
  assert.equal(restored.session.model.provider, routerId);
  assert.equal((await restored.runtime.getAuth(routerId)).auth.apiKey, "synthetic-work-login");
  // Quota failures never rotate accounts or submit another model request.
  const count = a.faux.state.callCount;
  a.faux.setResponses([reply("", { stopReason: "error", errorMessage: "usage_limit_reached" })]);
  await bounded(a.session.prompt("synthetic quota failure"), "quota error");
  assert.equal(a.faux.state.callCount, count + 1);
  assert.equal((await a.runtime.getAuth(routerId)).auth.apiKey, "synthetic-work-login");
  // Missing login fails before transport, rather than using the default or second account.
  await a.runtime.logout(profileId("work"));
  const noLoginCount = a.faux.state.callCount;
  await bounded(a.session.prompt("synthetic missing login"), "missing OAuth");
  assert.equal(a.faux.state.callCount, noLoginCount);
  assert.equal(a.session.model.provider, routerId);
  assert.deepEqual(await store.read("openai-codex"), original, "The original OAuth entry is unchanged");
  assert.deepEqual(errors, []);
  console.log(`pi-codex-accounts SDK smoke passed (offline, SDK ${JSON.parse(readFileSync(path.join(sdkDir, "package.json"))).version})`);
} finally {
  for (const session of sessions) { await session.abort(); session.dispose(); }
  globalThis.fetch = originalFetch;
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  rmSync(dir, { recursive: true, force: true });
}
