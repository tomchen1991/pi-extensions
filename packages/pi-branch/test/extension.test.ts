import { beforeEach, expect, it, vi } from "vitest";
const git = vi.hoisted(() => ({ signature: vi.fn(), state: vi.fn(), ensureReady: vi.fn(), fetch: vi.fn(), target: vi.fn(), report: vi.fn(), returnMain: vi.fn() }));
vi.mock("../src/git.js", () => ({ Git: class { constructor() { return git; } }, GitError: class extends Error {} }));
import extension from "../src/extension.js";
function setup() {
  let command: any; const events: Record<string, any> = {};
  extension({ on: (name: string, handler: any) => { events[name] = handler; }, registerCommand: (_: string, value: any) => { command = value; } } as any);
  const ctx = { cwd: "/synthetic", hasUI: true, isIdle: () => true, model: { provider: "fake", id: "fake" },
    ui: { notify: vi.fn(), select: vi.fn(), confirm: vi.fn() },
    modelRegistry: { streamSimple: vi.fn(() => ({ result: async () => ({ stopReason: "stop", content: [{ type: "text", text: "synthetic summary" }] }) })) } };
  return { command, events, ctx };
}
beforeEach(() => {
  vi.clearAllMocks(); git.state.mockResolvedValue({ root: "/synthetic", branch: "feat/x", dirty: true, status: "?? x" });
  git.target.mockResolvedValue({ branch: "master", ref: "refs/remotes/origin/master", oid: "abc" });
  git.report.mockResolvedValue({ facts: "synthetic facts", evidence: "synthetic diff" }); git.returnMain.mockResolvedValue("success");
});
it("registers only commands and shutdown cleanup, no automatic checks", () => {
  const { events } = setup(); expect(Object.keys(events)).toEqual(["session_shutdown"]); expect(git.fetch).not.toHaveBeenCalled();
});
it("canceling dirty return does not stash or switch", async () => {
  const { command, ctx } = setup(); ctx.ui.select.mockResolvedValue(undefined);
  await command.handler("main", ctx); expect(git.returnMain).not.toHaveBeenCalled();
});
it("authorizes stash only after the explicit selection", async () => {
  const { command, ctx } = setup(); ctx.ui.select.mockImplementation(async (_title, choices) => choices[1]);
  await command.handler("main", ctx); expect(git.returnMain).toHaveBeenCalledWith(expect.anything(), expect.anything(), true, expect.any(AbortSignal), expect.any(Function));
});
it("shows Git facts even when model consent is declined", async () => {
  const { command, ctx } = setup(); ctx.ui.confirm.mockResolvedValue(false);
  await command.handler("status", ctx); expect(ctx.ui.notify).toHaveBeenCalledWith("synthetic facts", "info"); expect(ctx.modelRegistry.streamSimple).not.toHaveBeenCalled();
});
it("uses a separate tool-free request without session history", async () => {
  const { command, ctx } = setup(); ctx.ui.confirm.mockResolvedValue(true); await command.handler("status", ctx);
  expect(ctx.modelRegistry.streamSimple).toHaveBeenCalledTimes(1);
  const request = ctx.modelRegistry.streamSimple.mock.calls[0] as any;
  expect(request[1].messages).toHaveLength(1); expect(request[1].tools).toBeUndefined();
  expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("synthetic summary"), "info");
});
it("does nothing without UI or when agent is busy", async () => {
  const { command, ctx } = setup(); await command.handler("main", { ...ctx, hasUI: false });
  await command.handler("main", { ...ctx, isIdle: () => false }); expect(git.state).not.toHaveBeenCalled();
});
it("rejects concurrent branch commands while a confirmation is open", async () => {
  const { command, ctx } = setup(); let finish!: (value: undefined) => void;
  ctx.ui.select.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const first = command.handler("main", ctx);
  await vi.waitFor(() => expect(ctx.ui.select).toHaveBeenCalledTimes(1));
  await command.handler("main", ctx);
  expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("等待"), "warning");
  finish(undefined); await first; expect(git.returnMain).not.toHaveBeenCalled();
});
it("shutdown during confirmation prevents mutations", async () => {
  const { command, ctx, events } = setup(); ctx.ui.select.mockImplementation(async (_title, choices) => { events.session_shutdown(); return choices[1]; });
  await command.handler("main", ctx); expect(git.returnMain).not.toHaveBeenCalled();
});
