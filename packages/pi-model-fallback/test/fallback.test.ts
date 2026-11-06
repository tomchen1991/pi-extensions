import { describe, expect, it, vi } from "vitest";
import extension from "../src/extension.js";
import { hasExhaustedQuotaHeaders, hasQuotaCode, isQuotaError } from "../src/quota.js";

function fixture() {
  const handlers: Record<string, Function> = {};
  let command: any;
  const model = { provider: "openai-codex", id: "synthetic-model" };
  const target = { ...model, provider: "openai", baseUrl: "https://api.openai.com/v1" };
  const signal = new AbortController();
  const notify = vi.fn();
  const pi = { on: (name: string, fn: Function) => { handlers[name] = fn; },
    registerCommand: (_name: string, value: any) => { command = value; }, appendEntry: vi.fn(),
    setModel: vi.fn(async () => true), getThinkingLevel: () => "high", setThinkingLevel: vi.fn() };
  const ctx: any = { model, signal: signal.signal, hasUI: true, ui: { notify },
    sessionManager: { getBranch: () => [] }, modelRegistry: { find: vi.fn(() => target),
      getProviderAuth: vi.fn(async () => ({ auth: { apiKey: "synthetic-key" } })) } };
  const message = { role: "assistant", provider: "openai-codex", model: model.id, stopReason: "error", errorMessage: "usage_limit_reached" };
  const event: any = { outcome: "error", entries: [], context: {
    contextEntries: [{ sourceEntry: { id: "synthetic-error" }, messages: [message] }],
    llmMessages: [{ role: "user", content: "synthetic" }, message] } };
  extension(pi as any);
  return { handlers, ctx, pi, target, event, message, signal, command: () => command };
}

describe("quota evidence", () => {
  it("requires an exact quota code, not a rate limit or generic friendly error", () => {
    expect(isQuotaError("usage_limit_reached")).toBe(true);
    for (const text of ["429", "rate_limit_exceeded", "usage_not_included", "insufficient_quota", "You have hit your ChatGPT usage limit. Try again in ~10080 min."]) {
      expect(isQuotaError(text)).toBe(false);
    }
    expect(hasQuotaCode({ type: "response.failed", response: { error: { code: "usage_limit_reached" } } })).toBe(true);
    expect(hasQuotaCode({ error: { code: "rate_limit_exceeded" } })).toBe(false);
  });
  it("recognizes exhausted subscription windows only", () => {
    expect(hasExhaustedQuotaHeaders({ "X-Codex-Secondary-Used-Percent": "100" })).toBe(true);
    expect(hasExhaustedQuotaHeaders({ "x-codex-primary-used-percent": "100.0" })).toBe(true);
    for (const value of ["99.9", "", "garbage", "Infinity"]) {
      expect(hasExhaustedQuotaHeaders({ "x-codex-secondary-used-percent": value })).toBe(false);
    }
    expect(hasExhaustedQuotaHeaders({ "retry-after": "60" })).toBe(false);
  });
});

describe("session fallback boundary", () => {
  it("switches exact IDs outside scoped models and omits only the failed message", async () => {
    const f = fixture();
    const result = await f.handlers.agent_before_settle(f.event, f.ctx);
    expect(f.ctx.modelRegistry.find).toHaveBeenCalledWith("openai", "synthetic-model");
    expect(f.pi.setModel).toHaveBeenCalledWith(f.target);
    expect(f.pi.setThinkingLevel).toHaveBeenCalledWith("high");
    expect(result).toEqual({ entries: [{ type: "context_edit", targetId: "synthetic-error", replacement: null }], continue: true });
  });
  it("uses exhausted response headers or structured stream errors for ambiguous text", async () => {
    for (const source of ["header", "stream"]) {
      const f = fixture();
      f.message.errorMessage = "You have hit your ChatGPT usage limit.";
      if (source === "header") f.handlers.after_provider_response({ status: 429, headers: { "x-codex-secondary-used-percent": "100" } }, f.ctx);
      else f.handlers.provider_stream_event({ provider: "openai-codex", data: { error: { type: "usage_limit_reached" } } });
      expect((await f.handlers.agent_before_settle(f.event, f.ctx)).continue).toBe(true);
    }
  });
  it("never reuses previous request evidence or successful quota headers", async () => {
    for (const reset of ["turn_start", "model_select", "session_start", "session_tree"]) {
      const f = fixture();
      f.message.errorMessage = "429";
      f.handlers.after_provider_response({ status: 429, headers: { "x-codex-secondary-used-percent": "100" } }, f.ctx);
      f.handlers[reset]({}, f.ctx);
      await f.handlers.agent_before_settle(f.event, f.ctx);
      expect(f.pi.setModel).not.toHaveBeenCalled();
    }
    const f = fixture();
    f.message.errorMessage = "429";
    f.handlers.after_provider_response({ status: 200, headers: { "x-codex-secondary-used-percent": "100" } }, f.ctx);
    await f.handlers.agent_before_settle(f.event, f.ctx);
    expect(f.pi.setModel).not.toHaveBeenCalled();
  });
  it("rejects missing models, unofficial endpoints and unavailable auth", async () => {
    for (const scenario of ["missing", "proxy", "auth", "throw"]) {
      const f = fixture();
      if (scenario === "missing") f.ctx.modelRegistry.find.mockReturnValue(undefined);
      if (scenario === "proxy") f.ctx.modelRegistry.getProviderAuth.mockResolvedValue({ auth: { baseUrl: "https://proxy.example/v1" } });
      if (scenario === "auth") f.pi.setModel.mockResolvedValue(false);
      if (scenario === "throw") f.pi.setModel.mockRejectedValue(Error("synthetic-secret"));
      expect(await f.handlers.agent_before_settle(f.event, f.ctx)).toBeUndefined();
      if (scenario === "missing" || scenario === "proxy") expect(f.pi.setModel).not.toHaveBeenCalled();
      expect(JSON.stringify(f.ctx.ui.notify.mock.calls)).not.toContain("synthetic-secret");
    }
  });
  it("never continues aborted, completed, disabled, or non-Codex turns", async () => {
    for (const scenario of ["abort", "outcome", "disabled", "api"]) {
      const f = fixture();
      if (scenario === "abort") f.signal.abort();
      if (scenario === "outcome") f.event.outcome = "completed";
      if (scenario === "disabled") await f.command().handler("disable", f.ctx);
      if (scenario === "api") f.message.provider = "openai";
      expect(await f.handlers.agent_before_settle(f.event, f.ctx)).toBeUndefined();
      expect(f.pi.setModel).not.toHaveBeenCalled();
    }
  });
  it("honors cancellation during credential resolution", async () => {
    const f = fixture();
    f.ctx.modelRegistry.getProviderAuth.mockImplementation(async () => { f.signal.abort(); return { auth: {} }; });
    expect(await f.handlers.agent_before_settle(f.event, f.ctx)).toBeUndefined();
    expect(f.pi.setModel).not.toHaveBeenCalled();
  });
  it("suppresses retry if cancellation arrives during model selection", async () => {
    const f = fixture();
    f.pi.setModel.mockImplementation(async () => { f.signal.abort(); return true; });
    expect((await f.handlers.agent_before_settle(f.event, f.ctx)).continue).toBe(false);
  });
  it("restores enablement from the active branch only", async () => {
    const f = fixture();
    f.ctx.sessionManager.getBranch = () => [{ type: "custom", customType: "pi-model-fallback", data: { enabled: false } }];
    f.handlers.session_start({}, f.ctx);
    await f.handlers.agent_before_settle(f.event, f.ctx);
    expect(f.pi.setModel).not.toHaveBeenCalled();
    f.ctx.sessionManager.getBranch = () => [];
    f.handlers.session_tree({}, f.ctx);
    expect((await f.handlers.agent_before_settle(f.event, f.ctx)).continue).toBe(true);
  });
});
