import { createHmac, randomUUID } from "node:crypto";
import type { ExtensionContext, ExtensionEvent } from "@earendil-works/pi-coding-agent";
import { LIMITS, TokensSchema, type EventData, type EventType, type Model, type MonitorEvent, type Source, type State, type Usage } from "./contract.js";

// Bound serialized metadata, not just character count (Unicode/control characters expand in JSON).
const label = (value: unknown): string | null => {
  if (typeof value !== "string" || !value.length) return null;
  let result = "", bytes = 0;
  for (const character of value.slice(0, 256)) {
    const size = Buffer.byteLength(JSON.stringify(character)) - 2;
    if (bytes + size > 256) break;
    result += character;
    bytes += size;
  }
  return result || null;
};
const duration = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
export function modelMetadata(value: unknown, thinking?: unknown): Model | null {
  if (!value || typeof value !== "object") return null;
  const m = value as Record<string, unknown>;
  const provider = label(m.provider), model = label(m.id ?? m.model);
  if (!provider || !model) return null;
  return { provider, model, responseModel: label(m.responseModel), thinkingLevel: label(thinking ?? m.thinkingLevel) };
}
export function usageMetadata(value: unknown, partial = false): Usage {
  const unknown: Usage = { availability: "unknown", source: "pi_sdk", tokens: null, estimatedCost: null };
  if (!value || typeof value !== "object") return unknown;
  const u = value as Record<string, any>;
  const tokens = TokensSchema.safeParse({ input: u.input, output: u.output, cacheRead: u.cacheRead,
    cacheWrite: u.cacheWrite, totalTokens: u.totalTokens, reasoning: u.reasoning ?? null });
  // SDK may initialize all fields to zero even when a provider never reports usage.
  if (!tokens.success || tokens.data.totalTokens === 0) return unknown;
  const cost = duration(u.cost?.total);
  return { availability: partial ? "partial" : "reported", source: "pi_sdk", tokens: tokens.data,
    estimatedCost: cost !== null && cost > 0 ? { currency: "USD", amount: cost, basis: "sdk_estimate" } : null };
}
export interface Identity { instanceId: string; processStartedAt: string }
export class Observer {
  readonly epoch = randomUUID();
  readonly source: Source;
  readonly state: State;
  private sequence = 0;
  private agentActive: boolean;
  private finished = false;
  private outcome: State["lastOutcome"] = null;
  private requestStartedAt: number | null = null;
  private activeTools = new Map<string, State["activeTools"][number]>();
  constructor(deviceId: string, projectId: string | null, identity: Identity, ctx: ExtensionContext,
    piVersion: string, private emit: (event: MonitorEvent) => void, private changed: () => void) {
    this.source = { kind: "pi", deviceId, instanceId: identity.instanceId };
    this.agentActive = !ctx.isIdle();
    this.state = {
      sessionId: ctx.sessionManager.getSessionId().slice(0, 128), projectId, mode: ctx.mode,
      pid: process.pid, processStartedAt: identity.processStartedAt, piVersion, pluginVersion: "0.1.0",
      status: ctx.isIdle() ? "idle" : "active", activityId: null, requestId: null,
      model: modelMetadata(ctx.model, ctx.thinkingLevel), activeTools: [], activeToolCount: 0, toolsTruncated: false,
      waitingInteractions: 0, compacting: false, lastProgressAt: new Date().toISOString(), lastOutcome: null,
      usage: { scope: "collector_epoch", input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
        totalTokens: 0, estimatedCostUSD: 0, unknownRecords: 0, unknownCostRecords: 0 },
    };
  }
  snapshot(): { state: State; sequence: number } { this.refreshStatus(); return { state: this.state, sequence: this.sequence }; }
  private refreshStatus(): void {
    if (this.state.status !== "stopping") this.state.status = this.agentActive || this.state.activeToolCount > 0 || this.state.compacting || this.state.waitingInteractions > 0 ? "active" : "idle";
  }
  start(): void { this.record("pi.collector.started", { state: structuredClone(this.state) }); }
  stop(reason: EventData<"pi.collector.stopped">["reason"]): void {
    if (this.finished) return;
    this.state.status = "stopping";
    this.record("pi.collector.stopped", { reason });
    this.finished = true;
  }
  private record<T extends EventType>(type: T, data: EventData<T>): void {
    if (this.finished) return;
    this.refreshStatus();
    this.state.lastProgressAt = new Date().toISOString();
    const sequence = ++this.sequence;
    this.emit({ envelopeVersion: 1, dataVersion: 1, eventId: `${this.epoch}:${sequence}`, source: this.source,
      collectorEpoch: this.epoch, sequence, occurredAt: this.state.lastProgressAt,
      sessionId: this.state.sessionId, activityId: this.state.activityId, type, data } as MonitorEvent);
    this.changed();
  }
  private addUsage(usage: Usage): void {
    const total = this.state.usage;
    if (usage.tokens) for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) total[key] += usage.tokens[key];
    if (usage.availability !== "reported") total.unknownRecords++;
    if (usage.estimatedCost) total.estimatedCostUSD += usage.estimatedCost.amount;
    else total.unknownCostRecords++;
  }
  private toolId(raw: string): string { return createHmac("sha256", this.epoch).update(raw).digest("hex").slice(0, 32); }
  private ensureActivity(): void {
    if (this.state.activityId) return;
    this.agentActive = true;
    this.state.status = "active";
    this.state.activityId = randomUUID();
    this.outcome = null;
    this.record("pi.activity.started", {});
  }
  handle(event: ExtensionEvent, ctx: ExtensionContext): void {
    if (this.finished) return;
    switch (event.type) {
      case "model_select":
        this.state.model = modelMetadata(event.model, ctx.thinkingLevel);
        this.record("pi.model.changed", { model: this.state.model });
        break;
      case "thinking_level_select":
        this.state.model = modelMetadata(ctx.model, event.level);
        this.record("pi.model.changed", { model: this.state.model });
        break;
      case "agent_start":
        this.outcome = null;
        this.ensureActivity();
        break;
      case "message_start":
        if (event.message.role !== "assistant") break;
        this.ensureActivity();
        this.state.requestId = randomUUID();
        this.requestStartedAt = performance.now();
        this.record("pi.request.started", { requestId: this.state.requestId, selectedModel: this.state.model });
        break;
      case "message_end": {
        if (event.message.role !== "assistant") break;
        this.ensureActivity();
        const message = event.message;
        const requestId = this.state.requestId ?? randomUUID();
        const reason = message.stopReason;
        const outcome = ({ stop: "completed", toolUse: "tool_use", length: "length_limit", aborted: "aborted", error: "error", deferred: "deferred", pending: "unknown" } as const)[reason] ?? "unknown";
        const usage = usageMetadata(message.usage, reason === "error" || reason === "aborted");
        this.addUsage(usage);
        this.record("pi.request.finished", { requestId, model: modelMetadata(message), outcome,
          durationMs: duration(message.durationMs) ?? (this.requestStartedAt === null ? null : performance.now() - this.requestStartedAt),
          usage, error: reason === "error" ? { category: "unknown", source: "model", classificationBasis: "sdk_stop_reason" } : null });
        this.state.requestId = null;
        this.requestStartedAt = null;
        break;
      }
      case "agent_before_settle":
        this.outcome = event.outcome;
        break;
      case "agent_settled":
        this.state.lastOutcome = event.aborted ? "aborted" : this.outcome ?? "unknown";
        this.agentActive = false;
        this.state.status = "idle";
        this.state.requestId = null;
        this.requestStartedAt = null;
        this.activeTools.clear();
        this.state.activeTools = [];
        this.state.activeToolCount = 0;
        this.state.toolsTruncated = false;
        this.record("pi.activity.settled", { outcome: this.state.lastOutcome });
        this.state.activityId = null;
        break;
      case "tool_execution_start": {
        const tool = { toolId: this.toolId(event.toolCallId), parentToolId: event.parentToolCallId ? this.toolId(event.parentToolCallId) : null,
          name: label(event.toolName) ?? "unknown", startedAt: new Date().toISOString() };
        this.state.activeToolCount++;
        if (this.activeTools.size < LIMITS.activeTools) this.activeTools.set(tool.toolId, tool);
        else this.state.toolsTruncated = true;
        this.state.activeTools = [...this.activeTools.values()];
        this.record("pi.tool.started", tool);
        break;
      }
      case "tool_execution_end": {
        const toolId = this.toolId(event.toolCallId);
        this.activeTools.delete(toolId);
        this.state.activeToolCount = Math.max(0, this.state.activeToolCount - 1);
        this.state.activeTools = [...this.activeTools.values()];
        // Root results already aggregate nested usage. Never add both parent and child usage.
        const usage = !event.parentToolCallId && event.result?.usage ? usageMetadata(event.result.usage, event.isError) : null;
        if (usage) this.addUsage(usage);
        this.record("pi.tool.finished", { toolId, parentToolId: event.parentToolCallId ? this.toolId(event.parentToolCallId) : null,
          name: label(event.toolName) ?? "unknown", outcome: event.isError ? "error" : "completed", durationMs: duration(event.durationMs),
          usage, error: event.isError ? { category: "tool_failed", source: "tool", classificationBasis: "sdk_tool_error" } : null });
        break;
      }
      case "ui_prompt_start":
        this.state.waitingInteractions++;
        this.record("pi.interaction.wait.started", { kind: event.kind });
        break;
      case "ui_prompt_end":
        this.state.waitingInteractions = Math.max(0, this.state.waitingInteractions - 1);
        this.record("pi.interaction.wait.ended", { kind: event.kind });
        break;
      case "session_before_compact":
        this.state.compacting = true;
        this.record("pi.compaction.started", { reason: event.reason, willRetry: event.willRetry });
        break;
      case "session_compact": {
        this.state.compacting = false;
        const usage = usageMetadata(event.compactionEntry.usage);
        this.addUsage(usage);
        this.record("pi.compaction.finished", { reason: event.reason, willRetry: event.willRetry, outcome: "completed", usage, error: null });
        break;
      }
      case "session_compact_failed": {
        this.state.compacting = false;
        const usage = usageMetadata(null);
        this.addUsage(usage);
        this.record("pi.compaction.finished", { reason: event.reason, willRetry: event.willRetry, outcome: event.aborted ? "aborted" : "error", usage,
          error: event.aborted ? null : { category: "unknown", source: "compaction", classificationBasis: "sdk_compaction_error" } });
        break;
      }
      case "session_tree": {
        const usage = event.summaryEntry ? usageMetadata(event.summaryEntry.usage) : null;
        if (usage) this.addUsage(usage);
        this.record("pi.branch.changed", { usage });
        break;
      }
    }
  }
}
