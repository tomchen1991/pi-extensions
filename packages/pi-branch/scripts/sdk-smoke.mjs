// Actual SDK + loader, temporary Git remotes and synthetic model only.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const sdkDir = process.env.PI_SDK_DIR;
if (!sdkDir || !path.isAbsolute(sdkDir)) throw Error("Set PI_SDK_DIR to an installed pi-coding-agent package root");
const dir = mkdtempSync(path.join(tmpdir(), "pi-branch-sdk-"));
const saved = Object.fromEntries(["HOME", "PI_CODING_AGENT_DIR"].map(key => [key, process.env[key]]));
const originalFetch = globalThis.fetch;
let session;
async function bounded(operation) {
  let timer;
  try { return await Promise.race([operation, new Promise((_, reject) => { timer = setTimeout(() => reject(Error("Offline SDK timeout")), 15000); })]); }
  finally { clearTimeout(timer); }
}
try {
  const agentDir = path.join(dir, "agent"); mkdirSync(agentDir);
  process.env.HOME = process.env.PI_CODING_AGENT_DIR = agentDir;
  globalThis.fetch = async () => { throw Error("Network forbidden in offline smoke"); };
  const require = createRequire(path.join(sdkDir, "package.json"));
  const aiPath = require.resolve.paths("@earendil-works/pi-ai").map(root => path.join(root, "@earendil-works/pi-ai/dist/index.js")).find(existsSync);
  assert.ok(aiPath);
  const { fauxProvider, fauxAssistantMessage: reply } = await import(pathToFileURL(aiPath));
  const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = await import(pathToFileURL(path.join(sdkDir, "dist/index.js")));
  const cwd = path.join(dir, "repo"), remote = path.join(dir, "remote.git");
  const git = (args, at = cwd) => execFileSync("git", args, { cwd: at, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git(["init", "--bare", "--initial-branch", "master", remote], dir); git(["clone", remote, cwd], dir);
  git(["config", "user.name", "Synthetic"]); git(["config", "user.email", "synthetic@example.invalid"]);
  writeFileSync(path.join(cwd, "file"), "initial\n"); git(["add", "."]); git(["commit", "-m", "initial"]); git(["push", "-u", "origin", "master"]); git(["switch", "-c", "feat/synthetic"]);
  const faux = fauxProvider({ provider: "branch-synthetic", models: [{ id: "synthetic" }] });
  const runtime = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
  runtime.registerNativeProvider(faux.provider); await runtime.setRuntimeApiKey("branch-synthetic", "synthetic-key");
  const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager: settings, noExtensions: true,
    additionalExtensionPaths: [fileURLToPath(new URL("../src/extension.ts", import.meta.url))],
    noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
  await bounded(loader.reload()); assert.deepEqual(loader.getExtensions().errors, []);
  ({ session } = await bounded(createAgentSession({ cwd, agentDir, modelRuntime: runtime, model: faux.getModel(),
    resourceLoader: loader, settingsManager: settings, noTools: "builtin", sessionManager: SessionManager.inMemory(cwd) })));
  const notices = [], errors = [];
  let consent = false, proceed = false, confirms = 0, selections = 0;
  await bounded(session.bindExtensions({ mode: "tui", uiContext: { ...session.extensionRunner.getUIContext(),
    notify: text => notices.push(text), confirm: async () => { confirms++; return consent; },
    select: async (_title, options) => { selections++; return options[proceed ? 1 : 0]; } }, onError: error => errors.push(error) }));
  assert.equal(notices.length, 0, "No startup Git check");
  async function prompt(text) { await bounded(session.prompt(text)); }
  writeFileSync(path.join(cwd, "file"), "synthetic diff\n");
  writeFileSync(path.join(cwd, "new"), "synthetic untracked");
  await prompt("/branch status"); assert.equal(confirms, 1); assert.equal(faux.state.callCount, 0);
  assert.ok(notices.some(text => text.includes("origin fetch 成功")));
  consent = true;
  faux.setResponses([context => {
    assert.equal(context.messages.filter(message => message.role !== "system").length, 1, "No conversation history");
    assert.ok(!context.tools?.length, "No executable tools in summary request");
    assert.ok(JSON.stringify(context.messages).includes("synthetic diff"));
    return reply("synthetic branch summary");
  }]);
  await prompt("/branch status"); assert.equal(faux.state.callCount, 1);
  assert.ok(notices.some(text => text.includes("synthetic branch summary")), JSON.stringify(notices));
  await prompt("/branch main"); assert.equal(selections, 1); assert.equal(git(["branch", "--show-current"]), "feat/synthetic"); assert.equal(git(["stash", "list"]), "");
  proceed = true; await prompt("/branch main"); assert.equal(git(["branch", "--show-current"]), "master"); assert.equal(git(["status", "--porcelain"]), "");
  const stash = git(["rev-parse", "refs/stash"]); assert.ok(notices.some(text => text.includes(stash)));
  git(["switch", "feat/synthetic"]); git(["stash", "apply", "--index", stash]);
  assert.equal(readFileSync(path.join(cwd, "file"), "utf8"), "synthetic diff\n"); assert.ok(existsSync(path.join(cwd, "new")));
  assert.deepEqual(errors, []);
  console.log(`pi-branch SDK smoke passed (offline, SDK ${JSON.parse(readFileSync(path.join(sdkDir, "package.json"))).version})`);
} finally {
  if (session) { await session.abort(); session.dispose(); }
  globalThis.fetch = originalFetch;
  for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  rmSync(dir, { recursive: true, force: true });
}
