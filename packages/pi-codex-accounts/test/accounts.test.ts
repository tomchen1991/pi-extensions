import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { registerAccounts } from "../src/extension.js";
import { configPath, readConfig, writeConfig } from "../src/config.js";
import { abortable, profileId, ROUTER } from "../src/providers.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function fixture(options: { repo?: boolean; trusted?: boolean; modelProvider?: string } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "pi-accounts-test-")); dirs.push(dir);
  if (options.repo !== false) execFileSync("git", ["init", "--quiet", dir]);
  const handlers: Record<string, Function> = {};
  const providers = new Map<string, any>();
  let command: any;
  let model: any = { provider: options.modelProvider ?? "openai-codex", id: "synthetic-model", baseUrl: "https://chatgpt.com/backend-api" };
  let thinking = "high";
  const oauth = { name: "Synthetic OAuth", isSubscription: true, login: vi.fn(), refresh: vi.fn(), toAuth: vi.fn() };
  const base: any = { id: "openai-codex", name: "Synthetic Codex", auth: { oauth },
    getModels: () => [{ ...model, provider: "openai-codex" }], stream: vi.fn(), streamSimple: vi.fn() };
  const pi: any = {
    on: (name: string, handler: Function) => { handlers[name] = handler; },
    registerProvider: (provider: any) => providers.set(provider.id, provider),
    registerCommand: (_name: string, value: any) => { command = value; },
    setModel: vi.fn(async (value: any) => { model = value; thinking = "low"; return true; }),
    getThinkingLevel: () => thinking, setThinkingLevel: vi.fn(value => { thinking = value; }),
    getSettings: () => ({ defaultProvider: "openai-codex", defaultModel: "synthetic-model" }),
  };
  const ctx: any = {
    cwd: dir, get model() { return model; }, hasUI: true,
    isProjectTrusted: vi.fn(() => options.trusted !== false), isIdle: vi.fn(() => true),
    sessionManager: { getBranch: vi.fn(() => []) },
    ui: { notify: vi.fn(), setStatus: vi.fn(), select: vi.fn() },
    modelRegistry: {
      refresh: vi.fn(async () => ({})),
      find: vi.fn((provider: string, id: string) => providers.get(provider)?.getModels().find((m: any) => m.id === id)),
      getProviderAuthStatus: vi.fn(() => ({ configured: true })),
      getProviderAuth: vi.fn(async (id: string) => ({ auth: { apiKey: `synthetic-${id}` } })),
    },
  };
  registerAccounts(pi, base);
  const path = configPath(dir, CONFIG_DIR_NAME);
  const start = () => handlers.session_start({}, ctx);
  const run = (text: string) => command.handler(text, ctx);
  const router = providers.get(ROUTER);
  const resolveAuth = (signal = new AbortController().signal) => router.auth.apiKey.resolve({ signal });
  return { dir, path, handlers, providers, command, ctx, pi, base, start, run, resolveAuth };
}

describe("manual repository selection", () => {
  it("registers two official OAuth login entries and a router, not duplicate catalogs", async () => {
    const f = await fixture();
    for (const account of ["personal", "work"] as const) {
      const profile = f.providers.get(profileId(account));
      expect(profile.auth.oauth.login).toBe(f.base.auth.oauth.login);
      expect(profile.auth.oauth.refresh).toBe(f.base.auth.oauth.refresh);
      expect(profile.getModels()).toEqual([]);
    }
    await f.start();
    expect(f.pi.setModel).not.toHaveBeenCalled();
    expect(await readConfig(f.path)).toBeUndefined();
    await expect(f.resolveAuth()).rejects.toThrow("Choose an account");
  });
  it("selects on startup, keeps model ID/thinking and uses only the repository's OAuth entry", async () => {
    const f = await fixture();
    await writeConfig(f.path, { version: 1, account: "work" });
    await f.start();
    expect(f.ctx.model).toMatchObject({ provider: ROUTER, id: "synthetic-model" });
    expect(f.pi.setThinkingLevel).toHaveBeenCalledWith("high");
    expect((await f.resolveAuth()).auth.apiKey).toBe(`synthetic-${profileId("work")}`);
    expect(f.ctx.modelRegistry.getProviderAuth).toHaveBeenCalledWith(profileId("work"));
    expect(() => f.providers.get("openai-codex").streamSimple(f.ctx.model, {})).toThrow("Repository account");
    expect(f.base.streamSimple).not.toHaveBeenCalled();
  });
  it("recovers the configured or persisted model ID when extensions bind after SDK model restoration", async () => {
    for (const saved of [false, true]) {
      const f = await fixture({ modelProvider: "unknown" });
      if (saved) f.ctx.sessionManager.getBranch.mockReturnValue([{ type: "model_change", provider: ROUTER, modelId: "synthetic-model" }]);
      await writeConfig(f.path, { version: 1, account: "work" }); await f.start();
      expect(f.ctx.model).toMatchObject({ provider: ROUTER, id: "synthetic-model" });
    }
  });
  it("applies an explicit off config on reload but does not silently use default login for a missing config on startup", async () => {
    const f = await fixture(); await f.start(); await f.run("use work");
    await writeConfig(f.path, { version: 1, account: null }); await f.run("reload");
    expect(f.ctx.model.provider).toBe("openai-codex");
    const restored = await fixture({ modelProvider: ROUTER }); await restored.start();
    expect(restored.pi.setModel).not.toHaveBeenCalled();
    await expect(restored.resolveAuth()).rejects.toThrow("Choose an account");
  });
  it("switches manually, persists only the selector, and never submits or retries a prompt", async () => {
    const f = await fixture(); await f.start();
    await f.run("use personal");
    expect(await readConfig(f.path)).toEqual({ version: 1, account: "personal" });
    await f.run("use work");
    expect((await f.resolveAuth()).auth.apiKey).toContain("work");
    expect(await readFile(f.path, "utf8")).not.toContain("synthetic");
    expect(f.base.streamSimple).not.toHaveBeenCalled();
    await f.run("off");
    expect(f.ctx.model.provider).toBe("openai-codex");
    expect((await readConfig(f.path))?.account).toBeNull();
    f.providers.get("openai-codex").streamSimple(f.ctx.model, {});
    expect(f.base.streamSimple).toHaveBeenCalledTimes(1);
  });
  it("keeps unrelated providers selected; the repo choice applies when selecting the router", async () => {
    const f = await fixture({ modelProvider: "anthropic" }); await f.start();
    await f.run("use work");
    expect(f.pi.setModel).not.toHaveBeenCalled();
    expect(f.ctx.model.provider).toBe("anthropic");
    expect((await f.resolveAuth()).source).toContain("work");
  });
  it("keeps another session pinned until explicit reload", async () => {
    const f = await fixture(); await f.start(); await f.run("use personal");
    await writeConfig(f.path, { version: 1, account: "work" });
    expect((await f.resolveAuth()).source).toContain("personal");
    await f.run("reload");
    expect((await f.resolveAuth()).source).toContain("work");
    const other = await fixture(); await other.start(); await other.run("use personal");
    expect((await other.resolveAuth()).source).toContain("personal");
    expect((await f.resolveAuth()).source).toContain("work");
  });
  it("rejects busy/concurrent operations and menu cancellation without publishing", async () => {
    const f = await fixture(); await f.start();
    f.ctx.isIdle.mockReturnValue(false);
    await f.run("use work"); expect(await readConfig(f.path)).toBeUndefined();
    f.ctx.isIdle.mockReturnValue(true);
    f.ctx.ui.select.mockResolvedValue(undefined);
    await f.run(""); expect(await readConfig(f.path)).toBeUndefined();
    let choose!: (value: string) => void;
    f.ctx.ui.select.mockImplementation(() => new Promise(resolve => { choose = resolve; }));
    const pending = f.run("");
    await f.run("use personal");
    choose("work"); await pending;
    expect((await readConfig(f.path))?.account).toBe("work");
  });
  it("checks idleness again after the picker and ignores stale shutdown callbacks", async () => {
    for (const shutdown of [false, true]) {
      const f = await fixture(); await f.start();
      let choose!: (value: string) => void;
      f.ctx.ui.select.mockImplementation(() => new Promise(resolve => { choose = resolve; }));
      const pending = f.run("");
      if (shutdown) f.handlers.session_shutdown({}, f.ctx);
      else f.ctx.isIdle.mockReturnValue(false);
      choose("work"); await pending;
      expect(await readConfig(f.path)).toBeUndefined();
      expect(f.pi.setModel).not.toHaveBeenCalled();
    }
  });
  it("requires trust and a login without reading credentials or creating config", async () => {
    const f = await fixture({ trusted: false });
    await mkdir(join(f.dir, CONFIG_DIR_NAME));
    await writeFile(f.path, "not json");
    await f.start(); await f.run("use work");
    expect(f.pi.setModel).not.toHaveBeenCalled();
    expect(f.ctx.modelRegistry.getProviderAuth).not.toHaveBeenCalled();
    f.providers.get("openai-codex").streamSimple(f.ctx.model, {});
    expect(f.base.streamSimple).toHaveBeenCalled();
    const missing = await fixture(); await missing.start();
    missing.ctx.modelRegistry.getProviderAuthStatus.mockReturnValue({ configured: false });
    await missing.run("use work");
    expect(await readConfig(missing.path)).toBeUndefined();
  });
  it("does not interfere with normal Pi outside Git repositories", async () => {
    const f = await fixture({ repo: false }); await f.start();
    expect(f.pi.setModel).not.toHaveBeenCalled();
    f.providers.get("openai-codex").streamSimple(f.ctx.model, {});
    expect(f.base.streamSimple).toHaveBeenCalled();
    await f.run("use work"); expect(await readConfig(f.path)).toBeUndefined();
  });
  it("fails closed for invalid config, missing credentials, refresh failures and unknown models", async () => {
    const f = await fixture();
    await mkdir(join(f.dir, CONFIG_DIR_NAME)); await writeFile(f.path, "not json"); await f.start();
    expect(f.ctx.model.provider).toBe(ROUTER);
    await expect(f.resolveAuth()).rejects.toThrow("config");
    await writeConfig(f.path, { version: 1, account: "work" }); await f.run("reload");
    f.ctx.modelRegistry.getProviderAuth.mockResolvedValue(undefined);
    await expect(f.resolveAuth()).rejects.toThrow("/login codex-account-work");
    f.ctx.modelRegistry.getProviderAuth.mockRejectedValue(Error("synthetic-sensitive-response"));
    await expect(f.resolveAuth()).rejects.toThrow("Account authentication failed");
    expect(JSON.stringify(f.ctx.ui.notify.mock.calls)).not.toContain("synthetic-sensitive-response");
    const unknown = await fixture();
    await writeConfig(unknown.path, { version: 1, account: "work" });
    unknown.ctx.modelRegistry.find.mockReturnValue(undefined); await unknown.start();
    expect(() => unknown.providers.get("openai-codex").streamSimple(unknown.ctx.model, {})).toThrow("Repository account");
    expect(unknown.base.streamSimple).not.toHaveBeenCalled();
  });
  it("does not overwrite a symlink on write failure; restores the prior selection", async () => {
    const f = await fixture(); await f.start();
    await mkdir(join(f.dir, CONFIG_DIR_NAME));
    const target = join(f.dir, "synthetic-file"); await writeFile(target, "untouched");
    await symlink(target, f.path);
    await f.run("use work");
    expect(await readFile(target, "utf8")).toBe("untouched");
    expect(f.ctx.model.provider).toBe("openai-codex");
    await expect(f.resolveAuth()).rejects.toThrow("Choose an account");
  });
  it("refuses off when the original login cannot be selected, without losing repo config", async () => {
    const f = await fixture(); await f.start(); await f.run("use work");
    f.pi.setModel.mockResolvedValue(false);
    await f.run("off");
    expect((await readConfig(f.path))?.account).toBe("work");
    expect((await f.resolveAuth()).source).toContain("work");
  });
  it("reports the active provider and login metadata, never resolves tokens for status", async () => {
    const f = await fixture(); await f.start(); await f.run("status");
    expect(f.ctx.modelRegistry.getProviderAuth).not.toHaveBeenCalled();
    expect(f.ctx.ui.notify.mock.lastCall?.[0]).toContain("Active provider: openai-codex");
  });
});

describe("request authentication isolation", () => {
  it("passes through official auth headers and rejects proxy endpoints before streaming", async () => {
    const f = await fixture(); await f.start(); await f.run("use personal");
    f.ctx.modelRegistry.getProviderAuth.mockResolvedValue({ auth: { apiKey: "synthetic-key", headers: { "ChatGPT-Account-Id": "synthetic-id" } } });
    expect((await f.resolveAuth()).auth.headers).toEqual({ "ChatGPT-Account-Id": "synthetic-id" });
    f.ctx.modelRegistry.getProviderAuth.mockResolvedValue({ auth: { apiKey: "synthetic-key", baseUrl: "https://proxy.example" } });
    await expect(f.resolveAuth()).rejects.toThrow("official");
    expect(() => f.providers.get(ROUTER).streamSimple({ ...f.ctx.model, baseUrl: "https://proxy.example" }, {})).toThrow("official");
    expect(f.base.streamSimple).not.toHaveBeenCalled();
  });
  it("cancels the caller promptly and refuses a result from a superseded selection", async () => {
    const f = await fixture(); await f.start(); await f.run("use work");
    let finish!: (value: any) => void;
    f.ctx.modelRegistry.getProviderAuth.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const abort = new AbortController();
    const pending = f.resolveAuth(abort.signal); abort.abort();
    await expect(pending).rejects.toThrow("authentication failed");
    finish({ auth: { apiKey: "synthetic-late" } });
    const stale = f.resolveAuth();
    await f.run("use personal");
    finish({ auth: { apiKey: "synthetic-old-account" } });
    await expect(stale).rejects.toThrow("changed during authentication");
  });
  it("the abort helper handles already-aborted and late-rejecting operations", async () => {
    const abort = new AbortController(); abort.abort();
    await expect(abortable(Promise.reject(Error("already rejected synthetic operation")), abort.signal)).rejects.toThrow();
    const second = new AbortController(); let reject!: (value: Error) => void;
    const pending = abortable(new Promise((_resolve, fail) => { reject = fail; }), second.signal);
    second.abort(); await expect(pending).rejects.toThrow("cancelled");
    reject(Error("late synthetic failure"));
  });
});
