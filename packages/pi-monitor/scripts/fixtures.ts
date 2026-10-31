import type { MonitorEvent, Source, State } from "../src/contract.js";
export const source: Source = { kind: "pi", deviceId: "synthetic-mac", instanceId: "synthetic-instance" };
export const epoch = "synthetic-epoch";
export const timestamp = "2026-07-01T10:00:00.000Z";
export function exampleState(): State {
  return {
    sessionId: "synthetic-session", projectId: null, mode: "tui", pid: 12345,
    processStartedAt: timestamp, piVersion: "1.4.0", pluginVersion: "0.1.0",
    status: "idle", activityId: null, requestId: null,
    model: { provider: "synthetic", model: "fake-model", responseModel: null, thinkingLevel: "off" },
    activeTools: [], activeToolCount: 0, toolsTruncated: false, waitingInteractions: 0, compacting: false,
    lastProgressAt: timestamp, lastOutcome: null,
    usage: { scope: "collector_epoch", input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, estimatedCostUSD: 0, unknownRecords: 0, unknownCostRecords: 0 },
  };
}
export function exampleEvent(sequence = 1): MonitorEvent {
  return { envelopeVersion: 1, dataVersion: 1, eventId: `${epoch}:${sequence}`, source, collectorEpoch: epoch,
    sequence, occurredAt: timestamp, sessionId: "synthetic-session", activityId: null,
    type: "pi.model.changed", data: { model: exampleState().model } };
}
export function exampleEvents(): MonitorEvent[] {
  const base = exampleEvent();
  const unknownUsage = { availability: "unknown", source: "pi_sdk", tokens: null, estimatedCost: null } as const;
  const events: MonitorEvent[] = [
    { ...base, type: "pi.collector.started", data: { state: exampleState() } },
    { ...base, type: "pi.model.changed", data: { model: exampleState().model } },
    { ...base, type: "pi.activity.started", data: {} },
    { ...base, type: "pi.request.started", data: { requestId: "synthetic-request", selectedModel: exampleState().model } },
    { ...base, type: "pi.request.finished", data: { requestId: "synthetic-request", model: exampleState().model, outcome: "error", durationMs: 1500, usage: unknownUsage, error: { category: "unknown", source: "model", classificationBasis: "sdk_stop_reason" } } },
    { ...base, type: "pi.tool.started", data: { toolId: "synthetic-tool", parentToolId: null, name: "read", startedAt: timestamp } },
    { ...base, type: "pi.tool.finished", data: { toolId: "synthetic-tool", parentToolId: null, name: "read", outcome: "error", durationMs: 5, usage: null, error: { category: "tool_failed", source: "tool", classificationBasis: "sdk_tool_error" } } },
    { ...base, type: "pi.interaction.wait.started", data: { kind: "confirm" } },
    { ...base, type: "pi.interaction.wait.ended", data: { kind: "confirm" } },
    { ...base, type: "pi.compaction.started", data: { reason: "overflow", willRetry: true } },
    { ...base, type: "pi.compaction.finished", data: { reason: "overflow", willRetry: true, outcome: "aborted", usage: unknownUsage, error: null } },
    { ...base, type: "pi.branch.changed", data: { usage: null } },
    { ...base, type: "pi.activity.settled", data: { outcome: "aborted" } },
    { ...base, type: "pi.collector.stopped", data: { reason: "quit" } },
  ];
  return events.map((event, index) => ({ ...event, sequence: index + 1, eventId: `${epoch}:${index + 1}` }));
}
export const delivery = { queuedEvents: 1, queuedBytes: 500, droppedUnconfirmed: 0, lastDroppedSequence: null, rejectedEvents: 0 };
export function examples(): unknown[] {
  return [
    { version: 1, type: "hello", protocol: "pi-monitor", source, collectorEpoch: epoch, delivery },
    { version: 1, type: "ready", collectorEpoch: epoch },
    { version: 1, type: "snapshot", source, collectorEpoch: epoch, throughSequence: 1, observedAt: timestamp, heartbeatIntervalMs: 30000, state: exampleState(), delivery },
    { version: 1, type: "events", source, collectorEpoch: epoch, events: [exampleEvent()] },
    { version: 1, type: "ack", collectorEpoch: epoch, eventIds: [exampleEvent().eventId] },
  ];
}
