import { buildObservation, emptyDraft, type Draft, type Metadata } from "../../src/contract.js";
import { destinationFor } from "../../src/config.js";
import { digest } from "../../src/identity.js";
import { observationInput } from "../../src/observation-input.js";

export const entry = (id: string, parentId: string | null, role: string, content: unknown, extra = {}) => ({
  id, parentId, type: "message", message: { role, content, ...extra },
});
export const branch = [
  entry("u1", null, "user", "这是内部运营用的订单查询系统，先做可用版本，方便运营查订单。"),
  entry("a1", "u1", "assistant", [{ type: "text", text: "建议用 Redis。" }], { stopReason: "stop" }),
  entry("u2", "a1", "user", "暂时不用 Redis，先用现有 SQLite，减少部署复杂度。"),
  entry("u3", "u2", "user", "手机端还没验收。这个项目大改前先讨论方案，不要直接改代码。"),
  entry("a2", "u3", "assistant", [{ type: "text", text: "查询接口修改完成。" }], { stopReason: "stop" }),
  entry("u4", "a2", "user", "以后汇报简短说明结果、验证情况和遗留问题。"),
];
export const model = { provider: "mock", id: "fixture", baseUrl: "https://fixture.invalid/v1" };
export const destination = destinationFor(model, null);
export function draft(): Draft {
  return {
    recentWork: [{ id: "work-1", topic: "优化订单查询", goal: "方便运营查订单", context: "内部运营系统，先做可用版本",
      progress: "助手报告查询接口修改完成，手机端尚未验收", status: "in_progress", verification: "assistant_reported", evidenceIds: ["e1", "e3", "e5"] }],
    decisions: [{ id: "decision-1", workRef: "work-1", choice: "暂时使用现有 SQLite，不引入 Redis", reason: "减少部署复杂度",
      scope: "project", temporary: true, evidenceIds: ["e2"] }],
    openLoops: [{ id: "loop-1", workRef: "work-1", description: "手机端尚待验收", kind: "pending_validation", origin: "user_explicit", evidenceIds: ["e3"] }],
    preferenceSignals: [
      { id: "signal-1", category: "prompting", aspect: "response_detail", condition: "汇报结果时", preference: "简短说明结果、验证情况和遗留问题",
        scope: "user_candidate", basis: "explicit_statement", evidenceIds: ["e4"] },
      { id: "signal-2", category: "collaboration", aspect: "execution_order", condition: "这个项目涉及大改时", preference: "先讨论方案，不直接改代码",
        scope: "project", basis: "explicit_statement", evidenceIds: ["e3"] },
    ],
    evidence: [
      { id: "e1", entryRef: "u1", quote: "这是内部运营用的订单查询系统，先做可用版本，方便运营查订单。" },
      { id: "e2", entryRef: "u2", quote: "暂时不用 Redis，先用现有 SQLite，减少部署复杂度。" },
      { id: "e3", entryRef: "u3", quote: "手机端还没验收。这个项目大改前先讨论方案，不要直接改代码。" },
      { id: "e4", entryRef: "u4", quote: "以后汇报简短说明结果、验证情况和遗留问题。" },
      { id: "e5", entryRef: "a2", quote: "查询接口修改完成。" },
    ],
  };
}
export function metadata(input = observationInput(branch, "u4")): Metadata {
  return {
    source: { producer: "pi-work-insights", projectRef: digest("/synthetic/project"), sessionRef: digest("synthetic-session"), branchRef: "u4",
      observedAt: "2026-01-01T00:00:00.000Z", inputDigest: input.inputDigest, entryRefs: input.entries.map(e => e.entryId),
      coverage: input.coverage, omissionReasons: input.omissionReasons },
    extraction: { provider: model.provider, model: model.id, extractorVersion: "work-observation-v1", destinationRef: destination.fingerprint, inputTokens: 800, outputTokens: 500 },
  };
}
export function fixture(empty = false) {
  const input = observationInput(empty ? [entry("u0", null, "user", "谢谢")] : branch, empty ? "u0" : "u4");
  const meta = metadata(input);
  if (empty) meta.source.branchRef = "u0";
  return buildObservation(empty ? emptyDraft() : draft(), input.entries, meta);
}
