import { z } from "zod";

export const LIMITS = Object.freeze({
  frameBytes: 64 * 1024, batchBytes: 32 * 1024, batchEvents: 32,
  queueBytes: 256 * 1024, queueEvents: 512, activeTools: 64,
  connectMs: 5000, ackMs: 10000, flushMs: 250, snapshotMs: 1000,
  activeHeartbeatMs: 10000, idleHeartbeatMs: 30000, shutdownMs: 250,
});
const text = z.string().min(1).max(256);
const id = z.string().min(1).max(128);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const amount = z.number().nonnegative();
const time = z.iso.datetime();
const object = z.strictObject;
export const SourceSchema = object({ kind: z.literal("pi"), deviceId: id, instanceId: id });
export const ModelSchema = object({ provider: text, model: text, responseModel: text.nullable(), thinkingLevel: text.nullable() });
export const ErrorSchema = object({
  category: z.enum(["authentication", "permission_denied", "rate_limited", "quota_exceeded", "timeout", "network", "provider_unavailable", "context_limit", "invalid_request", "tool_failed", "internal", "unknown"]),
  source: z.enum(["model", "tool", "compaction"]),
  classificationBasis: z.enum(["sdk_stop_reason", "sdk_tool_error", "sdk_compaction_error"]),
});
export const TokensSchema = object({ input: count, output: count, cacheRead: count, cacheWrite: count, reasoning: count.nullable(), totalTokens: count });
export const UsageSchema = object({
  availability: z.enum(["reported", "partial", "unknown"]),
  source: z.literal("pi_sdk"), tokens: TokensSchema.nullable(),
  estimatedCost: object({ currency: z.literal("USD"), amount, basis: z.literal("sdk_estimate") }).nullable(),
});
const model = ModelSchema.nullable();
const outcome = z.enum(["completed", "aborted", "error", "unknown"]);
const tool = object({ toolId: id, parentToolId: id.nullable(), name: text, startedAt: time });
export const StateSchema = object({
  sessionId: id, projectId: id.nullable(), mode: z.enum(["tui", "rpc", "json", "print"]),
  pid: count, processStartedAt: time, piVersion: text, pluginVersion: z.literal("0.1.0"),
  status: z.enum(["idle", "active", "stopping", "unknown"]),
  activityId: id.nullable(), requestId: id.nullable(), model,
  activeTools: z.array(tool).max(LIMITS.activeTools), activeToolCount: count, toolsTruncated: z.boolean(),
  waitingInteractions: count, compacting: z.boolean(),
  lastProgressAt: time, lastOutcome: outcome.nullable(),
  usage: object({
    scope: z.literal("collector_epoch"), input: count, output: count, cacheRead: count, cacheWrite: count,
    totalTokens: count, estimatedCostUSD: amount, unknownRecords: count, unknownCostRecords: count,
  }),
});
const common = {
  envelopeVersion: z.literal(1), dataVersion: z.literal(1), eventId: id, source: SourceSchema,
  collectorEpoch: id, sequence: count.min(1), occurredAt: time, sessionId: id,
  activityId: id.nullable(),
};
const event = <T extends string, S extends z.ZodType>(type: T, data: S) => object({ ...common, type: z.literal(type), data });
export const EventSchema = z.discriminatedUnion("type", [
  event("pi.collector.started", object({ state: StateSchema })),
  event("pi.collector.stopped", object({ reason: z.enum(["quit", "reload", "new", "resume", "fork", "disabled", "replaced"]) })),
  event("pi.model.changed", object({ model })),
  event("pi.activity.started", object({})),
  event("pi.activity.settled", object({ outcome })),
  event("pi.request.started", object({ requestId: id, selectedModel: model })),
  event("pi.request.finished", object({
    requestId: id, model, outcome: z.enum(["completed", "tool_use", "length_limit", "aborted", "error", "deferred", "unknown"]),
    durationMs: amount.nullable(), usage: UsageSchema, error: ErrorSchema.nullable(),
  })),
  event("pi.tool.started", tool),
  event("pi.tool.finished", object({ toolId: id, parentToolId: id.nullable(), name: text, outcome: z.enum(["completed", "error"]), durationMs: amount.nullable(), usage: UsageSchema.nullable(), error: ErrorSchema.nullable() })),
  event("pi.interaction.wait.started", object({ kind: z.enum(["select", "confirm", "input", "editor", "custom"]) })),
  event("pi.interaction.wait.ended", object({ kind: z.enum(["select", "confirm", "input", "editor", "custom"]) })),
  event("pi.compaction.started", object({ reason: z.enum(["manual", "threshold", "overflow"]), willRetry: z.boolean() })),
  event("pi.compaction.finished", object({ reason: z.enum(["manual", "threshold", "overflow"]), willRetry: z.boolean(), outcome, usage: UsageSchema, error: ErrorSchema.nullable() })),
  event("pi.branch.changed", object({ usage: UsageSchema.nullable() })),
]);
export const DeliverySchema = object({
  queuedEvents: count, queuedBytes: count, droppedUnconfirmed: count,
  lastDroppedSequence: count.nullable(), rejectedEvents: count,
});
const connection = { version: z.literal(1), source: SourceSchema, collectorEpoch: id };
export const ClientFrameSchema = z.discriminatedUnion("type", [
  object({ ...connection, type: z.literal("hello"), protocol: z.literal("pi-monitor"), delivery: DeliverySchema }),
  object({ ...connection, type: z.literal("snapshot"), throughSequence: count, observedAt: time, heartbeatIntervalMs: count, state: StateSchema, delivery: DeliverySchema }),
  object({ ...connection, type: z.literal("events"), events: z.array(EventSchema).min(1).max(LIMITS.batchEvents) }),
]);
export const ServerFrameSchema = z.discriminatedUnion("type", [
  object({ version: z.literal(1), type: z.literal("ready"), collectorEpoch: id }),
  object({ version: z.literal(1), type: z.literal("ack"), collectorEpoch: id, eventIds: z.array(id).min(1).max(LIMITS.batchEvents) }),
  object({ version: z.literal(1), type: z.literal("reject"), code: z.enum(["unauthorized", "forbidden", "unsupported_version", "invalid_frame"]) }),
]);
export type MonitorEvent = z.infer<typeof EventSchema>;
export type EventType = MonitorEvent["type"];
export type EventData<T extends EventType> = Extract<MonitorEvent, { type: T }>["data"];
export type State = z.infer<typeof StateSchema>;
export type Usage = z.infer<typeof UsageSchema>;
export type Model = z.infer<typeof ModelSchema>;
export type Source = z.infer<typeof SourceSchema>;
export type Delivery = z.infer<typeof DeliverySchema>;
