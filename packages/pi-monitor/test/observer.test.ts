import { describe, expect, it } from "vitest";
import type { ExtensionContext, ExtensionEvent } from "@earendil-works/pi-coding-agent";
import { EventSchema, LIMITS, type MonitorEvent } from "../src/contract.js";
import { Observer, usageMetadata } from "../src/observer.js";
import { readConfig } from "../src/config.js";

const secret = "SECRET_PROMPT_TOKEN_PATH";
const usage = { input: 10, output: 20, cacheRead: 5, cacheWrite: 2, reasoning: 7, totalTokens: 37, cost: { total: 0.03 } };
function setup() {
  const records: MonitorEvent[] = [];
  const ctx = { cwd: secret, mode: "tui", thinkingLevel: "off", model: { id: "selected", provider: "fake" },
    isIdle: () => true, sessionManager: { getSessionId: () => "session", getEntries: () => { throw Error("Must not scan history"); } },
    getContextUsage: () => { throw Error("Must not scan context/history"); },
  } as unknown as ExtensionContext;
  const observer = new Observer("device", null, { instanceId: "instance", processStartedAt: "2026-07-01T00:00:00.000Z" }, ctx, "1.4.0",
    event => records.push(structuredClone(EventSchema.parse(event))), () => {});
  const emit = (event: object) => observer.handle(event as ExtensionEvent, ctx);
  observer.start();
  return { observer, records, emit, ctx };
}
const message = (stopReason = "stop", u: unknown = usage) => ({ role: "assistant", model: "actual", provider: "fake", api: "fake",
  content: [{ type: "text", text: secret }], usage: u, stopReason, errorMessage: secret, timestamp: Date.now(), durationMs: 12 });

describe("content-free lifecycle collector", () => {
  it("records actual model, usage and final settlement without scanning history or retaining content", () => {
    const { observer, records, emit } = setup();
    emit({ type: "agent_start" });
    emit({ type: "message_start", message: message() });
    emit({ type: "message_update", message: message(), assistantMessageEvent: { type: "text_delta", delta: secret } });
    emit({ type: "message_end", message: message() });
    emit({ type: "agent_end", messages: [message()] });
    expect(observer.state.status).toBe("active");
    emit({ type: "agent_before_settle", outcome: "completed" });
    emit({ type: "agent_settled", aborted: false });
    const finished = records.find(e => e.type === "pi.request.finished")!;
    expect(finished.type === "pi.request.finished" && finished.data.model?.model).toBe("actual");
    expect(observer.state.model?.model).toBe("selected");
    expect(observer.state.usage.totalTokens).toBe(37); // Reasoning is a subset, not additive.
    expect(observer.state.lastOutcome).toBe("completed");
    expect(observer.state.activityId).toBeNull();
    expect(JSON.stringify(records)).not.toContain(secret);
    expect(records.map(e => e.sequence)).toEqual(records.map((_, i) => i + 1));
    observer.stop("reload");
    const length = records.length;
    observer.stop("quit");
    emit({ type: "agent_start" });
    expect(records).toHaveLength(length);
  });

  it.each(["error", "aborted", "length", "deferred"])("preserves request outcome %s without guessing a cause", reason => {
    const { records, emit } = setup();
    emit({ type: "message_end", message: message(reason, undefined) });
    const e = records.at(-1)!;
    expect(e.type).toBe("pi.request.finished");
    if (e.type !== "pi.request.finished") return;
    expect(e.data.outcome).toBe(reason === "length" ? "length_limit" : reason);
    expect(e.data.error?.category ?? null).toBe(reason === "error" ? "unknown" : null);
    expect(JSON.stringify(e)).not.toContain(secret);
  });

  it("does not confuse a failed request/tool with final failure; abort and unknown are explicit", () => {
    const { observer, emit } = setup();
    emit({ type: "message_end", message: message("error") });
    emit({ type: "agent_end", messages: [] });
    emit({ type: "agent_start" });
    emit({ type: "message_end", message: message() });
    emit({ type: "agent_before_settle", outcome: "completed" });
    emit({ type: "agent_settled", aborted: false });
    expect(observer.state.lastOutcome).toBe("completed");
    emit({ type: "agent_start" });
    emit({ type: "agent_settled", aborted: false });
    expect(observer.state.lastOutcome).toBe("unknown");
    emit({ type: "agent_settled", aborted: true });
    expect(observer.state.lastOutcome).toBe("aborted");
  });

  it("tracks parallel and nested tools, omits arguments/output, counts only root aggregated usage", () => {
    const { observer, records, emit } = setup();
    for (const toolCallId of ["a", "b", "a/1"]) emit({ type: "tool_execution_start", toolCallId, toolName: "bash", args: { command: secret }, parentToolCallId: toolCallId === "a/1" ? "a" : undefined });
    expect(observer.state.activeTools).toHaveLength(3);
    emit({ type: "tool_execution_end", toolCallId: "a/1", parentToolCallId: "a", toolName: "bash", result: { usage, content: secret }, isError: false });
    expect(observer.state.usage.totalTokens).toBe(0);
    emit({ type: "tool_execution_end", toolCallId: "a", toolName: "bash", result: { usage, content: secret }, isError: true, durationMs: 10 });
    expect(observer.state.activeTools).toHaveLength(1);
    expect(observer.state.usage.totalTokens).toBe(0);
    const result = { role: "toolResult", toolCallId: "a", toolName: "bash", usage, content: secret, isError: true, durationMs: 10 };
    emit({ type: "message_start", message: result });
    expect(observer.state.usage.totalTokens).toBe(37);
    emit({ type: "message_end", message: result });
    expect(observer.state.usage.totalTokens).toBe(37);
    const finished = records.at(-1)!;
    expect(finished.type === "pi.tool.finished" && finished.data.error?.category).toBe("tool_failed");
    expect(JSON.stringify(records)).not.toContain(secret);
    for (let i = 0; i < 100; i++) emit({ type: "tool_execution_start", toolCallId: `c${i}`, toolName: "test", args: {} });
    expect(observer.state.activeTools).toHaveLength(LIMITS.activeTools);
    expect(observer.state.toolsTruncated).toBe(true);
  });

  it.each([false, true])("counts SDK-finalized nested usage exactly once (root owns usage: %s)", ownUsage => {
    const { observer, records, emit } = setup();
    for (const [toolCallId, parentToolCallId] of [["root", undefined], ["root/1", "root"], ["root/1/1", "root/1"]]) {
      emit({ type: "tool_execution_start", toolCallId, parentToolCallId, toolName: "synthetic", args: { secret } });
    }
    for (const [toolCallId, parentToolCallId] of [["root/1/1", "root/1"], ["root/1", "root"]]) {
      emit({ type: "tool_execution_end", toolCallId, parentToolCallId, toolName: "synthetic", result: { usage, content: secret }, isError: false });
    }
    emit({ type: "tool_execution_end", toolCallId: "root", toolName: "synthetic", result: { usage: ownUsage ? usage : undefined }, isError: false });
    expect(observer.state.usage.totalTokens).toBe(0);
    expect(records.filter(e => e.type === "pi.tool.finished")).toHaveLength(2);
    // Pi 在根执行结束之后、message_start 之前才聚合所有深度的嵌套用量。
    const count = ownUsage ? 3 : 2;
    const aggregated = { input: usage.input * count, output: usage.output * count, cacheRead: usage.cacheRead * count,
      cacheWrite: usage.cacheWrite * count, totalTokens: usage.totalTokens * count, cost: { total: usage.cost.total * count } };
    const result = { role: "toolResult", toolCallId: "root", toolName: "synthetic", usage: aggregated, content: secret, isError: false, durationMs: 17 };
    emit({ type: "message_start", message: result });
    emit({ type: "message_end", message: result });
    const finished = records.filter(e => e.type === "pi.tool.finished");
    expect(finished).toHaveLength(3);
    expect(finished.map(e => e.data.usage)).toEqual([null, null, usageMetadata(aggregated)]);
    expect(finished.at(-1)?.data.durationMs).toBe(17);
    expect(observer.snapshot().state.usage).toEqual({ scope: "collector_epoch", input: aggregated.input, output: aggregated.output,
      cacheRead: aggregated.cacheRead, cacheWrite: aggregated.cacheWrite, totalTokens: aggregated.totalTokens,
      estimatedCostUSD: aggregated.cost.total, unknownRecords: 0, unknownCostRecords: 0 });
    expect(observer.state.activeToolCount).toBe(0);
    expect(JSON.stringify(records)).not.toContain(secret);
  });

  it.each([undefined, { ...usage, totalTokens: 0 }, { ...usage, cost: { total: 0 } }])("preserves missing/unknown tool usage and pricing (%j)", finalUsage => {
    const { observer, records, emit } = setup();
    emit({ type: "tool_execution_end", toolCallId: "root", toolName: "synthetic", result: { usage }, isError: true });
    const result = { role: "toolResult", toolCallId: "root", toolName: "synthetic", usage: finalUsage, isError: true, content: secret };
    emit({ type: "message_start", message: result });
    emit({ type: "message_end", message: result });
    const finished = records.filter(e => e.type === "pi.tool.finished");
    expect(finished).toHaveLength(1);
    expect(finished[0]?.data.usage).toEqual(finalUsage ? usageMetadata(finalUsage, true) : null);
    expect(finished[0]?.data.error?.category).toBe("tool_failed");
    expect(observer.state.usage.totalTokens).toBe(finalUsage?.totalTokens ? 37 : 0);
    expect(observer.state.usage.unknownRecords).toBe(finalUsage ? 1 : 0);
    expect(observer.state.usage.unknownCostRecords).toBe(finalUsage ? 1 : 0);
  });

  it("bounds snapshot size even for hostile Unicode/control-character metadata", () => {
    const { observer, emit } = setup();
    for (let i = 0; i < LIMITS.activeTools; i++) emit({ type: "tool_execution_start", toolCallId: `id-${i}`, toolName: "\u0000😀".repeat(1000), args: {} });
    expect(Buffer.byteLength(JSON.stringify(observer.snapshot()))).toBeLessThan(LIMITS.frameBytes - 2048);
  });

  it("records waits, model changes, compaction outcomes and branch summary usage", () => {
    const { observer, records, emit } = setup();
    emit({ type: "ui_prompt_start", kind: "confirm", title: secret });
    emit({ type: "ui_prompt_start", kind: "input", title: secret });
    emit({ type: "ui_prompt_end", kind: "confirm", title: secret });
    expect(observer.state.waitingInteractions).toBe(1);
    emit({ type: "thinking_level_select", level: "high" });
    expect(observer.state.model?.thinkingLevel).toBe("high");
    emit({ type: "session_before_compact", reason: "overflow", willRetry: true });
    expect(observer.state.compacting).toBe(true);
    emit({ type: "session_compact_failed", reason: "overflow", willRetry: true, aborted: true, errorMessage: secret });
    expect(observer.state.compacting).toBe(false);
    emit({ type: "session_compact", reason: "manual", willRetry: false, compactionEntry: { usage, summary: secret } });
    emit({ type: "session_tree", summaryEntry: { usage, summary: secret } });
    expect(observer.state.usage.totalTokens).toBe(74);
    expect(JSON.stringify(records)).not.toContain(secret);
  });
});

describe("usage and configuration", () => {
  it("does not call missing/zero usage or zero pricing free", () => {
    expect(usageMetadata(null).tokens).toBeNull();
    expect(usageMetadata({ ...usage, totalTokens: 0 }).availability).toBe("unknown");
    expect(usageMetadata({ ...usage, cost: { total: 0 } }).estimatedCost).toBeNull();
    expect(usageMetadata(usage, true).availability).toBe("partial");
    expect(usageMetadata({ ...usage, input: -1 }).availability).toBe("unknown");
  });
  it("allows only literal loopback ws or secure remote wss, without credentials in URLs", () => {
    const base = { PI_MONITOR_TOKEN: "synthetic-token", PI_MONITOR_DEVICE_ID: "synthetic-device" };
    for (const url of ["ws://127.0.0.1:1234/ingest", "ws://[::1]:1234/ingest", "wss://monitor.example/ingest"]) expect(readConfig({ ...base, PI_MONITOR_URL: url }).endpoint).toBe(url);
    for (const url of ["ws://localhost:1234", "ws://monitor.example", "https://monitor.example", "wss://user:secret@monitor.example", "wss://monitor.example?token=x", "wss://monitor.example#x"]) expect(() => readConfig({ ...base, PI_MONITOR_URL: url })).toThrow(/^monitor_/);
    expect(() => readConfig({})).toThrow("monitor_missing_config");
    expect(() => readConfig({ ...base, PI_MONITOR_URL: "wss://monitor.example", PI_MONITOR_TOKEN: "secret\r\ninjected" })).toThrow("monitor_invalid_token");
  });
});
