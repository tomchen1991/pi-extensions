import { describe, it, expect } from "vitest";
import { collect } from "../src/collector.js";
import { digest } from "../src/identity.js";
import { buildObservation, emptyDraft, observationId, validateObservation, type Draft } from "../src/contract.js";
import { observationInput } from "../src/observation-input.js";
import { safeText } from "../src/privacy.js";
import { branch, draft, entry, fixture, metadata } from "./fixtures/synthetic.js";

const input = () => observationInput(branch, "u4");
const build = (value: unknown) => buildObservation(value, input().entries, metadata());

describe("current-branch context and privacy", () => {
  it("does not mistake user role or injected actor fields for human identity", () => {
    expect(collect([{ ...branch[0], actor: "human", origin: "tui" }], "u1").entries[0].actor).toBe("unknown");
  });
  it("requires content-bound independent metadata to label a user message human", () => {
    const origins = new Map([["u1", { actor: "human" as const, contentDigest: digest(branch[0].message.content) }]]);
    expect(collect(branch, "u4", { origins }).entries[0].actor).toBe("human");
    origins.set("u1", { actor: "human", contentDigest: digest("different") });
    expect(collect(branch, "u4", { origins }).entries[0].actor).toBe("unknown");
  });
  it("applies deletion/latest replacement without resurrecting raw text or mixing siblings", () => {
    const rows = [...branch, entry("sibling", "u1", "user", "另一个分支"),
      { type: "context_edit", id: "e1", parentId: "u4", targetId: "u1", replacement: null },
      { type: "context_edit", id: "e2", parentId: "e1", targetId: "u2", replacement: { content: "新内容" } },
      { type: "context_edit", id: "e3", parentId: "e2", targetId: "u2", replacement: { content: "最终内容" } }];
    const result = observationInput(rows, "e3");
    expect(result.entries.map(e => e.entryId)).not.toContain("u1");
    expect(result.entries.find(e => e.entryId === "u2")?.text).toBe("最终内容");
    expect(JSON.stringify(result)).not.toContain("另一个分支");
    expect(branch[0].message.content).toContain("内部运营");
    expect(observationInput(rows, "u4").entries[0].text).toContain("内部运营");
  });
  it("rejects unknown edit formats and invalid branches", () => {
    expect(() => observationInput([...branch, { type: "context_edit", id: "e", parentId: "u4", targetId: "u1", replacement: "legacy" }], "e")).toThrow();
    expect(() => observationInput(branch, "missing")).toThrow();
  });
  it("excludes thinking, system, image payloads, compaction and injected summaries", () => {
    const rows = [entry("s", null, "system", "SYSTEM"), entry("a", "s", "assistant", [
      { type: "thinking", thinking: "PRIVATE" }, { type: "image", data: "BASE64" }, { type: "text", text: "最终回复" },
    ], { stopReason: "stop" }), { type: "compaction", id: "c", parentId: "a", summary: "我已经验收" },
    { type: "custom_message", id: "x", parentId: "c", content: "用户喜欢加班" }];
    expect(observationInput(rows, "x").entries.map(e => e.text)).toEqual(["最终回复"]);
  });
  it("keeps only allowlisted test counters linked to the right tool, not commands/file dumps", () => {
    const rows = [entry("a", null, "assistant", [
      { type: "toolCall", id: "c1", name: "bash", arguments: { command: "npm test" } },
      { type: "toolCall", id: "c2", name: "read", arguments: { path: "secret.txt" } },
    ], { stopReason: "toolUse" }),
    entry("r2", "a", "toolResult", [{ type: "text", text: "RAW FILE" }], { toolCallId: "c2", toolName: "read" }),
    entry("r1", "r2", "toolResult", [{ type: "text", text: "Tests 4 passed (4)\nuser likes working weekends" }], { toolCallId: "c1", toolName: "bash" })];
    expect(observationInput(rows, "r1").entries).toMatchObject([{ actor: "tool", text: "Tests 4 passed (4)" }]);
    rows[0].message.content = [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "api_key=secret-value" } }];
    expect(observationInput(rows, "r1").entries).toEqual([]);
  });
  it("selects the most recent bounded window and marks incomplete coverage", () => {
    const rows = Array.from({ length: 40 }, (_, i) => entry(String(i), i ? String(i - 1) : null, "user", `${i} ${"文".repeat(995)}`));
    const result = observationInput(rows, "39");
    expect(result.entries.at(-1)?.entryId).toBe("39");
    expect(result.entries.reduce((sum, e) => sum + e.text.length, 0)).toBeLessThanOrEqual(16000);
    expect(result.entries.length).toBeLessThanOrEqual(30);
    expect(result.coverage).toBe("partial");
    expect(observationInput([entry("u", null, "user", "文".repeat(4001))], "u").entries).toEqual([]);
  });
  it("does not count non-content metadata as new input", () => {
    const next = [...branch, { type: "usage", id: "usage", parentId: "u4" }];
    expect(observationInput(next, "usage").inputDigest).toBe(input().inputDigest);
  });
  it.each(["password=supersecret", "https://user:pass@example.invalid", "Bearer abcdefghijkl", "-----BEGIN RSA PRIVATE KEY-----", "https://x.invalid?token=secret", "sk-" + "a".repeat(32)])("omits sensitive input: %s", secret => {
    expect(safeText(secret)).toBeUndefined();
    expect(observationInput([entry("u", null, "user", secret)], "u").entries).toEqual([]);
  });
});

describe("work observation contract", () => {
  it("emits the five agreed arrays with program-owned provenance and unreviewed status", () => {
    const result = build(draft());
    expect(result).toEqual(fixture());
    expect(result.reviewStatus).toBe("unreviewed");
    expect(result.evidence.find(e => e.entryRef === "u4")).toMatchObject({ role: "user", humanOrigin: "unverified" });
    expect(result.evidence.find(e => e.entryRef === "a2")).toMatchObject({ role: "assistant", humanOrigin: "not_applicable" });
  });
  it("supports empty outputs and null unknowns instead of inventing facts", () => {
    expect(build(emptyDraft()).recentWork).toEqual([]);
    const d = draft(); d.recentWork[0].goal = null; d.decisions[0].reason = null; d.decisions[0].temporary = null;
    expect(build(d).decisions[0].reason).toBeNull();
  });
  it("accepts plain JSON and one JSON fence, not surrounding prose", () => {
    expect(build(JSON.stringify(draft()))).toEqual(fixture());
    expect(build(`\`\`\`json\n${JSON.stringify(draft())}\n\`\`\``)).toEqual(fixture());
    expect(() => build(`Here is JSON: ${JSON.stringify(draft())}`)).toThrow();
    expect(() => build("x".repeat(100000))).toThrow("RESPONSE_TOO_LARGE");
  });
  it.each(["source", "observationId", "reviewStatus", "profile", "suggestions"])("rejects model-authored %s", field => {
    expect(() => build({ ...draft(), [field]: "forged" })).toThrow();
  });
  it("does not allow the model to assign evidence origin or claim human confirmation", () => {
    const d = draft();
    expect(() => build({ ...d, evidence: [{ ...d.evidence[0], role: "user", humanOrigin: "verified" }, ...d.evidence.slice(1)] })).toThrow();
  });
  it.each(["nonexistent entry", "invented quote"])("rejects %s", kind => {
    const d = draft();
    if (kind === "nonexistent entry") d.evidence[0].entryRef = "missing"; else d.evidence[0].quote = "从没说过";
    expect(() => build(d)).toThrow("INVALID_QUOTATION");
  });
  it("rejects invalid/duplicate evidence and work links, IDs and unused quotations", () => {
    const mutations: ((d: Draft) => void)[] = [
      d => { d.recentWork[0].evidenceIds = ["missing"]; },
      d => { d.recentWork[0].evidenceIds = ["e1", "e1"]; },
      d => { d.decisions[0].workRef = "missing"; },
      d => { d.decisions[0].id = "work-1"; },
      d => { d.evidence.push({ id: "extra", entryRef: "u1", quote: "内部运营" }); },
    ];
    for (const mutate of mutations) { const d = draft(); mutate(d); expect(() => build(d)).toThrow(); }
  });
  it("cannot turn assistant suggestions into user decisions or preferences", () => {
    const d = draft(); d.decisions[0].evidenceIds = ["e5"]; d.evidence = d.evidence.filter(e => e.id !== "e2");
    expect(() => build(d)).toThrow("NO_USER_DECISION_EVIDENCE");
    const p = draft(); p.preferenceSignals[0].evidenceIds = ["e5"]; p.evidence = p.evidence.filter(e => e.id !== "e4");
    expect(() => build(p)).toThrow("INSUFFICIENT_PREFERENCE_EVIDENCE");
  });
  it("requires two distinct user entries for a behavioral pattern, not two quotes of one entry", () => {
    const d = draft(); d.preferenceSignals[0].basis = "observed_pattern";
    expect(() => build(d)).toThrow("INSUFFICIENT");
    d.evidence.push({ id: "e6", entryRef: "u4", quote: "简短说明结果" });
    d.preferenceSignals[0].evidenceIds.push("e6");
    expect(() => build(d)).toThrow("INSUFFICIENT");
    d.evidence.pop(); d.preferenceSignals[0].evidenceIds = ["e3", "e4"];
    expect(build(d).preferenceSignals[0].basis).toBe("observed_pattern");
  });
  it("keeps assistant-proposed work distinct from user intent", () => {
    const d = draft(); d.openLoops[0].evidenceIds = ["e5"];
    expect(() => build(d)).toThrow("UNSUPPORTED_LOOP_ORIGIN");
    d.openLoops[0].origin = "assistant_proposed";
    expect(build(d).openLoops[0].origin).toBe("assistant_proposed");
  });
  it("cannot claim tool verification without tool evidence, or claim verified completion", () => {
    const d = draft(); d.recentWork[0].verification = "tool_observed";
    expect(() => build(d)).toThrow("UNSUPPORTED_VERIFICATION");
    expect(() => build({ ...draft(), recentWork: [{ ...draft().recentWork[0], status: "verified" }] })).toThrow();
  });
  it("rejects sensitive conclusions and terminal control characters", () => {
    for (const choice of ["password=secret-value", "\u001b[31mInjected"]) {
      const d = draft(); d.decisions[0].choice = choice; expect(() => build(d)).toThrow();
    }
  });
  it("has stable IDs across timestamps and rejects incompatible versions or tampered identities", () => {
    const first = fixture(); const meta = metadata(); meta.source.observedAt = "2026-02-01T00:00:00.000Z";
    expect(observationId(meta)).toBe(first.observationId);
    expect(() => validateObservation({ ...first, schemaVersion: "9" })).toThrow();
    expect(() => validateObservation({ ...first, observationId: digest("wrong") })).toThrow();
    expect(() => validateObservation({ ...first, source: { ...first.source, entryRefs: [] } })).toThrow();
  });
});
