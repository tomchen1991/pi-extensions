import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, realpathSync, rmSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
vi.mock("@earendil-works/pi-coding-agent", () => ({ getAgentDir: () => { throw Error("use test output directory"); } }));
import extension from "../src/extension.js";
import { ObservationStore } from "../src/storage.js";
import { DEBOUNCE_MS, MIN_INTERVAL_MS, REQUEST_TIMEOUT_MS } from "../src/config.js";
import { branch, destination, draft, entry, model } from "./fixtures/synthetic.js";

const dirs: string[] = [];
const shutdowns: (() => void)[] = [];
afterEach(() => {
  shutdowns.splice(0).forEach(fn => fn());
  vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks();
  dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true }));
});
function setup(rpc = false, auto = false) {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const cwd = realpathSync(mkdtempSync(path.join(os.tmpdir(), "pi-observation-extension-")));
  dirs.push(cwd); const base = path.join(cwd, "output"); vi.stubEnv("PI_WORK_INSIGHTS_DIR", base);
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  let command!: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
  const api = {
    registerFlag: vi.fn(), getFlag: (name: string) => name === "work-insights-auto" ? auto : rpc,
    on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => handlers.set(event, handler),
    registerCommand: (name: string, value: { handler: typeof command }) => { expect(name).toBe("insights"); command = value.handler; },
  };
  let output = JSON.stringify(draft());
  const response = () => ({ stopReason: "stop", content: [{ type: "text", text: output }], usage: { input: 50, output: 50, totalTokens: 100 } });
  const rows = structuredClone(branch);
  const ctx = {
    cwd, mode: rpc ? "rpc" : "tui", hasUI: true, isIdle: () => true, hasPendingMessages: () => false, model,
    sessionManager: {
      getSessionId: () => "synthetic-session", getSessionFile: () => path.join(cwd, "synthetic.jsonl"),
      getLeafId: () => rows.at(-1)?.id ?? null, getBranch: vi.fn(() => rows),
    },
    ui: { notify: vi.fn(), setStatus: vi.fn(), confirm: vi.fn(async () => true), getEditorText: vi.fn(() => ""), setEditorText: vi.fn() },
    modelRegistry: {
      find: vi.fn(() => model), getRegisteredProviderConfig: vi.fn(() => undefined as unknown),
      streamSimple: vi.fn(() => ({ result: async () => response() })),
    },
  };
  extension(api as unknown as ExtensionAPI);
  const store = new ObservationStore(base, cwd);
  const emit = (name: string, event: unknown = {}) => handlers.get(name)?.(event, ctx);
  shutdowns.push(() => { emit("session_shutdown"); });
  const run = (args: string) => command(args, ctx as unknown as ExtensionCommandContext);
  const outputs = () => existsSync(store.outputDirectory) ? readdirSync(store.outputDirectory).filter(f => f.endsWith(".json")) : [];
  const waitOutput = async (count = 1) => vi.waitFor(() => expect(outputs()).toHaveLength(count));
  const newInput = () => {
    emit("input"); rows.push(entry("new-user", rows.at(-1)!.id, "user", "下一步检查手机端"));
  };
  return { ctx, store, emit, run, outputs, waitOutput, response, rows, newInput, output: (raw: string) => { output = raw; } };
}

describe("automatic observation extension", () => {
  it("load and disabled settled do not collect, request, or create files", async () => {
    const f = setup(); expect(vi.getTimerCount()).toBe(0);
    expect(f.emit("agent_settled", { aborted: false })).toBeUndefined();
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    await f.run("status");
    expect(f.ctx.sessionManager.getBranch).not.toHaveBeenCalled();
    expect(f.ctx.modelRegistry.streamSimple).not.toHaveBeenCalled();
    expect(existsSync(f.store.directory)).toBe(false);
  });
  it("declining project authorization writes nothing and never starts automatic extraction", async () => {
    const f = setup(); f.ctx.ui.confirm.mockResolvedValue(false); await f.run("enable");
    f.emit("agent_settled", { aborted: false }); await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    await f.run("status");
    expect(existsSync(f.store.directory)).toBe(false);
    expect(f.ctx.modelRegistry.streamSimple).not.toHaveBeenCalled();
  });
  it("one consent enables background JSON output without per-record dialogs or agent/editor injection", async () => {
    const f = setup(); await f.run("enable");
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS - 1);
    expect(f.ctx.modelRegistry.streamSimple).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); await f.waitOutput();
    expect(f.ctx.ui.confirm).toHaveBeenCalledTimes(1);
    const latest = f.store.latest()!;
    expect(latest.file).toBe(`observations/${f.outputs()[0]}`);
    const record = f.store.read(latest.observationId)!;
    expect(record.reviewStatus).toBe("unreviewed");
    expect(record.preferenceSignals).toHaveLength(2);
    expect(record.evidence[0].humanOrigin).toBe("unverified");
    expect(f.ctx.ui.setEditorText).not.toHaveBeenCalled();
    expect(f.rows).toEqual(branch);
    const request = (f.ctx.modelRegistry.streamSimple.mock.calls as unknown[][])[0];
    expect(request[1]).not.toHaveProperty("tools");
    expect(request[2]).toMatchObject({ maxTokens: 4096 });
  });
  it("repeated settled and reload do not pay again for the same window", async () => {
    const f = setup(); await f.run("enable"); await f.run("extract");
    f.emit("agent_settled", { aborted: false }); f.emit("agent_settled", { aborted: false });
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS); await f.run("extract");
    f.emit("session_start"); await f.run("extract");
    expect(f.ctx.modelRegistry.streamSimple).toHaveBeenCalledTimes(1);
    expect(f.outputs()).toHaveLength(1);
  });
  it("status finds the persisted project latest pointer after session state is reset", async () => {
    const f = setup(); await f.run("enable"); await f.run("extract");
    const latest = f.store.latest()!;
    f.emit("session_start");
    await f.run("status");
    const message = f.ctx.ui.notify.mock.calls.at(-1)![0];
    expect(message).toContain(f.store.latestFile);
    expect(message).toContain(latest.observedAt);
    expect(message).toContain(path.join(f.store.directory, latest.file));
    expect(message).not.toContain("尚无成功输出");
    expect(f.ctx.modelRegistry.streamSimple).toHaveBeenCalledTimes(1);
  });
  it("new work waits out the persistent interval, then runs automatically without another prompt", async () => {
    const f = setup(); await f.run("enable"); await f.run("extract");
    f.newInput(); f.emit("agent_settled", { aborted: false });
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    await vi.waitFor(() => expect(f.ctx.ui.setStatus.mock.calls.some(call => String(call[1]).includes("等待提取")) || vi.getTimerCount() > 0).toBe(true));
    expect(f.ctx.modelRegistry.streamSimple).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(MIN_INTERVAL_MS);
    await f.waitOutput(2);
    expect(f.ctx.ui.confirm).toHaveBeenCalledTimes(1);
  });
  it("manual extraction shares the same budget and does not bypass cooldown", async () => {
    const f = setup(); await f.run("enable"); await f.run("extract"); f.newInput(); await f.run("extract");
    expect(f.ctx.modelRegistry.streamSimple).toHaveBeenCalledTimes(1);
    expect(f.store.settings().attempts).toHaveLength(1);
  });
  it.each(["rpc", "json", "print"])("does not observe or request in %s mode", async mode => {
    const f = setup(); f.ctx.mode = mode;
    f.store.authorize(destination, true); // An unsupported host must not restore a persisted grant.
    await f.run("enable"); f.emit("session_start"); f.emit("agent_settled", { aborted: false });
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(f.ctx.sessionManager.getBranch).not.toHaveBeenCalled();
    expect(f.ctx.modelRegistry.streamSimple).not.toHaveBeenCalled();
  });
  it.each([false, true])("host automatic mode (RPC=%s) collects without any consent command or dialog", async rpc => {
    const f = setup(false, true); f.ctx.mode = rpc ? "rpc" : "tui";
    f.ctx.ui.confirm.mockImplementation(async () => { throw Error("Automatic hosts must never prompt"); });
    f.emit("session_start");
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS); await f.waitOutput();
    expect(f.store.settings().enabled).toBe(true);
    expect(f.ctx.ui.confirm).not.toHaveBeenCalled();
    expect(f.ctx.modelRegistry.streamSimple).toHaveBeenCalledTimes(1);
    f.emit("session_start"); await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    await f.run("extract");
    expect(f.ctx.modelRegistry.streamSimple).toHaveBeenCalledTimes(1);
    if (rpc) {
      await f.run("status");
      expect(JSON.parse(f.ctx.ui.notify.mock.calls.at(-1)![0])).toMatchObject({ activation: "host_auto", enabled: true });
    }
    await f.run("pause"); f.newInput(); f.emit("session_start");
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS); await f.run("extract");
    expect(f.store.settings().enabled).toBe(false);
    expect(f.ctx.modelRegistry.streamSimple).toHaveBeenCalledTimes(1);
    await f.run("enable"); // Explicit resume/rebind, still without a dialog.
    expect(f.store.settings().enabled).toBe(true);
    await f.run("forget");
    expect(f.outputs()).toEqual([]); expect(f.store.latest()).toBeUndefined();
    f.emit("session_start"); await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(f.store.settings().enabled).toBe(false);
    expect(f.ctx.ui.confirm).not.toHaveBeenCalled();
  });
  it("automatic mode initializes an empty session without requesting a model", async () => {
    const f = setup(false, true); f.rows.splice(0);
    f.emit("session_start"); await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    await vi.waitFor(() => expect(f.store.settings().enabled).toBe(true));
    expect(f.ctx.sessionManager.getBranch).not.toHaveBeenCalled();
    expect(f.ctx.modelRegistry.streamSimple).not.toHaveBeenCalled();
    expect(f.ctx.ui.confirm).not.toHaveBeenCalled();
  });
  it.each(["pause", "forget"])("automatic startup respects a persisted %s even before initial activation", async action => {
    const f = setup(false, true);
    if (action === "pause") f.store.pause(); else f.store.forget();
    f.emit("session_start"); await vi.advanceTimersByTimeAsync(DEBOUNCE_MS); await f.run("extract");
    expect(f.store.settings().enabled).toBe(false);
    expect(f.ctx.modelRegistry.streamSimple).not.toHaveBeenCalled();
    expect(f.ctx.ui.confirm).not.toHaveBeenCalled();
  });
  it.each(["", "relative/output"])("automatic mode requires an explicit absolute host directory (%s)", async directory => {
    const f = setup(false, true); vi.stubEnv("PI_WORK_INSIGHTS_DIR", directory);
    f.emit("session_start"); await vi.advanceTimersByTimeAsync(DEBOUNCE_MS); await f.run("extract");
    expect(f.ctx.ui.confirm).not.toHaveBeenCalled();
    expect(f.ctx.sessionManager.getBranch).not.toHaveBeenCalled();
    expect(f.ctx.modelRegistry.streamSimple).not.toHaveBeenCalled();
    expect(existsSync(f.store.directory)).toBe(false);
    expect(JSON.stringify(f.ctx.ui.notify.mock.calls)).toContain("专属绝对路径");
  });
  it("automatic initialization cannot race past another instance's pause", async () => {
    const f = setup(false, true);
    const initialize = ObservationStore.prototype.initializeAutomatic;
    vi.spyOn(ObservationStore.prototype, "initializeAutomatic").mockImplementation(function (this: ObservationStore, destination) {
      f.store.pause();
      return initialize.call(this, destination);
    });
    f.emit("session_start"); await vi.advanceTimersByTimeAsync(DEBOUNCE_MS); await f.run("extract");
    expect(f.store.settings().enabled).toBe(false);
    expect(f.ctx.modelRegistry.streamSimple).not.toHaveBeenCalled();
  });
  it.each(["json", "print"])("automatic host flag cannot enable collection in %s mode", async mode => {
    const f = setup(false, true); f.ctx.mode = mode;
    f.emit("session_start"); await f.run("enable"); await f.run("extract");
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(existsSync(f.store.directory)).toBe(false);
    expect(f.ctx.sessionManager.getBranch).not.toHaveBeenCalled();
    expect(f.ctx.modelRegistry.streamSimple).not.toHaveBeenCalled();
  });
  it("automatic mode preserves the pinned model and requires an explicit rebind after routing changes", async () => {
    const f = setup(false, true);
    await f.run("extract"); await f.waitOutput();
    f.ctx.model = { ...model, id: "different-main-model" };
    f.newInput(); await vi.advanceTimersByTimeAsync(MIN_INTERVAL_MS);
    f.ctx.modelRegistry.getRegisteredProviderConfig.mockReturnValue({ baseUrl: "https://other.invalid" });
    await f.run("extract");
    expect(f.ctx.modelRegistry.streamSimple).toHaveBeenCalledTimes(1);
    expect(f.store.settings().destination!.model).toBe(model.id);
    expect(f.ctx.ui.confirm).not.toHaveBeenCalled();
  });
  it("RPC capability opt-in alone does not authorize; explicit consent enables the same outbox", async () => {
    const f = setup(true);
    f.emit("session_start"); await vi.advanceTimersByTimeAsync(DEBOUNCE_MS); await f.run("status");
    expect(f.ctx.modelRegistry.streamSimple).not.toHaveBeenCalled();
    expect(f.ctx.sessionManager.getBranch).not.toHaveBeenCalled();
    expect(existsSync(f.store.directory)).toBe(false);
    expect(JSON.parse(f.ctx.ui.notify.mock.calls.at(-1)![0])).toMatchObject({ type: "work_insights_status", version: 1, enabled: false, latest: null });
    await f.run("enable"); await vi.advanceTimersByTimeAsync(DEBOUNCE_MS); await f.waitOutput();
    expect(f.ctx.ui.confirm).toHaveBeenCalledWith(expect.any(String), expect.stringContaining("可能收费"), expect.objectContaining({ timeout: 60_000 }));
    expect(f.ctx.ui.getEditorText).not.toHaveBeenCalled(); // RPC cannot inspect host drafts.
    await f.run("status");
    expect(JSON.parse(f.ctx.ui.notify.mock.calls.at(-1)![0])).toMatchObject({ enabled: true, latest: { file: `observations/${f.outputs()[0]}` } });
    await f.run("pause"); f.newInput(); await f.run("extract");
    expect(f.ctx.modelRegistry.streamSimple).toHaveBeenCalledTimes(1);
    await f.run("forget"); expect(f.outputs()).toEqual([]); expect(f.store.latest()).toBeUndefined();
  });
  it("RPC without UI cannot restore even an existing grant", async () => {
    const f = setup(true); await f.run("enable"); f.emit("session_shutdown"); f.ctx.hasUI = false;
    f.emit("session_start"); await f.run("extract"); await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(f.ctx.modelRegistry.streamSimple).not.toHaveBeenCalled();
  });
  it.each(["pause", "forget"])("a concurrent %s revokes an outstanding RPC consent dialog", async action => {
    const f = setup(true);
    let approve!: (value: boolean) => void;
    f.ctx.ui.confirm.mockImplementation(() => new Promise(resolve => { approve = resolve; }));
    const pending = f.run("enable");
    await vi.waitFor(() => expect(f.ctx.ui.confirm).toHaveBeenCalled());
    if (action === "pause") f.store.pause(); else f.store.forget();
    approve(true); await pending;
    expect(f.store.settings().enabled).toBe(false);
    expect(f.ctx.modelRegistry.streamSimple).not.toHaveBeenCalled();
  });
  it("RPC cancellation invalidates an outstanding consent even if the UI responds late", async () => {
    const f = setup(true);
    let approve!: (value: boolean) => void;
    f.ctx.ui.confirm.mockImplementation(() => new Promise(resolve => { approve = resolve; }));
    const pending = f.run("enable");
    await vi.waitFor(() => expect(f.ctx.ui.confirm).toHaveBeenCalled());
    await f.run("pause"); approve(true); await pending;
    expect(f.store.settings().enabled).toBe(false);
  });
  it("RPC decline never authorizes or reads the branch", async () => {
    const f = setup(true); f.ctx.ui.confirm.mockResolvedValue(false); await f.run("enable");
    f.emit("agent_settled"); await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(existsSync(f.store.directory)).toBe(false);
    expect(f.ctx.sessionManager.getBranch).not.toHaveBeenCalled();
  });
  it("RPC status does not cancel a paid request, and pause discards its late result", async () => {
    const f = setup(true); await f.run("enable");
    let resolve!: (value: ReturnType<typeof f.response>) => void;
    f.ctx.modelRegistry.streamSimple.mockImplementation(() => ({ result: () => new Promise(done => { resolve = done; }) }));
    const pending = f.run("extract");
    await vi.waitFor(() => expect(f.ctx.modelRegistry.streamSimple).toHaveBeenCalled());
    await f.run("status");
    expect(JSON.parse(f.ctx.ui.notify.mock.calls.at(-1)![0])).toMatchObject({ enabled: true, active: true });
    await f.run("pause"); await pending; resolve(f.response()); await Promise.resolve();
    expect(f.outputs()).toEqual([]);
  });
  it("skips busy/queued/drafting states and aborted settlement", async () => {
    const f = setup(); await f.run("enable"); f.ctx.isIdle = () => false; await f.run("extract");
    f.ctx.isIdle = () => true; f.ctx.hasPendingMessages = () => true; await f.run("extract");
    f.ctx.hasPendingMessages = () => false; f.ctx.ui.getEditorText.mockReturnValue("draft"); await f.run("extract");
    f.ctx.ui.getEditorText.mockReturnValue(""); f.emit("agent_settled", { aborted: true });
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(f.ctx.modelRegistry.streamSimple).not.toHaveBeenCalled();
  });
  it.each([false, true].flatMap(rpc => ["input", "before_agent_start", "agent_start", "model_select", "session_tree", "session_compact", "session_shutdown"].map(event => ({ rpc, event }))))("cancels on $event (RPC=$rpc) and discards an uncancellable late response", async ({ rpc, event }) => {
    const f = setup(rpc); await f.run("enable");
    let resolve!: (value: ReturnType<typeof f.response>) => void;
    f.ctx.modelRegistry.streamSimple.mockImplementation(() => ({ result: () => new Promise(done => { resolve = done; }) }));
    const pending = f.run("extract");
    await vi.waitFor(() => expect(f.ctx.modelRegistry.streamSimple).toHaveBeenCalled());
    f.emit(event); await pending;
    resolve(f.response()); await Promise.resolve();
    expect(f.outputs()).toEqual([]);
    expect(f.store.settings().attempts).toHaveLength(1);
  });
  it("leaf changes without an event still invalidate the result", async () => {
    const f = setup(); await f.run("enable");
    f.ctx.modelRegistry.streamSimple.mockImplementation(() => ({ result: async () => {
      f.rows.push(entry("changed", "u4", "user", "改变上下文")); return f.response();
    } }));
    await f.run("extract"); expect(f.outputs()).toEqual([]);
  });
  it("status does not interrupt a running request", async () => {
    const f = setup(); await f.run("enable");
    let resolve!: (value: ReturnType<typeof f.response>) => void;
    f.ctx.modelRegistry.streamSimple.mockImplementation(() => ({ result: () => new Promise(done => { resolve = done; }) }));
    const pending = f.run("extract");
    await vi.waitFor(() => expect(f.ctx.modelRegistry.streamSimple).toHaveBeenCalled());
    await f.run("status"); resolve(f.response()); await pending;
    expect(f.outputs()).toHaveLength(1);
  });
  it("keeps using the authorized model rather than silently following the main model", async () => {
    const f = setup(); await f.run("enable");
    f.ctx.model = { ...model, id: "different-main-model" };
    await f.run("extract");
    expect(f.ctx.modelRegistry.find).toHaveBeenCalledWith(model.provider, model.id);
    expect((f.ctx.modelRegistry.streamSimple.mock.calls as unknown[][])[0][0]).toMatchObject({ id: model.id });
  });
  it("routing changes require renewed consent before another model request", async () => {
    const f = setup(); await f.run("enable");
    f.ctx.modelRegistry.getRegisteredProviderConfig.mockReturnValue({ baseUrl: "https://other.invalid" });
    await f.run("extract");
    expect(f.ctx.modelRegistry.streamSimple).not.toHaveBeenCalled();
    expect(f.outputs()).toEqual([]);
  });
  it("pause from another instance revokes an in-flight result", async () => {
    const f = setup(); await f.run("enable");
    f.ctx.modelRegistry.streamSimple.mockImplementation(() => ({ result: async () => { f.store.pause(); return f.response(); } }));
    await f.run("extract"); expect(f.outputs()).toEqual([]);
  });
  it("pause/forget stop automation and clear only the project's observation output", async () => {
    const f = setup(); await f.run("enable"); await f.run("extract");
    await f.run("pause"); f.newInput(); f.emit("agent_settled", { aborted: false });
    await f.run("extract"); expect(f.ctx.modelRegistry.streamSimple).toHaveBeenCalledTimes(1);
    await f.run("forget"); expect(f.outputs()).toEqual([]); expect(f.store.settings().enabled).toBe(false);
  });
  it("times out even when the model ignores AbortSignal", async () => {
    const f = setup(); await f.run("enable");
    f.ctx.modelRegistry.streamSimple.mockImplementation(() => ({ result: () => new Promise(() => {}) }));
    const pending = f.run("extract");
    await vi.waitFor(() => expect(f.ctx.modelRegistry.streamSimple).toHaveBeenCalled());
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS); await pending;
    expect(f.outputs()).toEqual([]);
    expect(JSON.stringify(f.ctx.ui.notify.mock.calls)).toContain("超时");
  });
  it("invalid output and provider errors are contained without exposing raw content", async () => {
    const f = setup(); await f.run("enable"); f.output("password=private-value"); await f.run("extract");
    expect(f.outputs()).toEqual([]);
    expect(JSON.stringify([...f.ctx.ui.notify.mock.calls, ...f.ctx.ui.setStatus.mock.calls])).not.toContain("private-value");
    await vi.advanceTimersByTimeAsync(MIN_INTERVAL_MS);
    f.ctx.modelRegistry.streamSimple.mockImplementation(() => ({ result: async () => { throw Error("secret-auth-error"); } }));
    await f.run("extract");
    expect(JSON.stringify(f.ctx.ui.notify.mock.calls)).not.toContain("secret-auth-error");
    expect(f.store.settings().attempts).toHaveLength(2);
  });
  it("a successful empty observation is saved and not automatically retried", async () => {
    const f = setup(); await f.run("enable");
    f.output('{"recentWork":[],"decisions":[],"openLoops":[],"preferenceSignals":[],"evidence":[]}');
    await f.run("extract"); await f.run("extract");
    expect(f.outputs()).toHaveLength(1);
    expect(f.ctx.modelRegistry.streamSimple).toHaveBeenCalledTimes(1);
  });
});
