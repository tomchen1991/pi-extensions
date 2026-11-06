import { z } from "zod";
import { digest } from "./identity.js";
import { hasSensitiveText } from "./privacy.js";

// Kept independent of Pi's runtime; the collector never treats role=user as proof of a human.
export type Actor = "human" | "automation" | "assistant" | "tool" | "unknown";
export interface AllowedEvidence { entryId: string; actor: Actor; text: string; toolCallId?: string }
export const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const text = (max: number) => z.string().trim().min(1).max(max)
  .refine(value => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(value), "CONTROL_CHARACTERS");
const localId = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/);
const refs = z.array(localId).min(1).max(5);
const workRef = localId.nullable();
const RecentWork = z.strictObject({
  id: localId, topic: text(120), goal: text(300).nullable(), context: text(300).nullable(),
  progress: text(400).nullable(),
  status: z.enum(["planned", "in_progress", "blocked", "reported_done", "unknown"]),
  verification: z.enum(["user_reported", "assistant_reported", "tool_observed", "unknown"]),
  evidenceIds: refs,
});
const Decision = z.strictObject({
  id: localId, workRef, choice: text(300), reason: text(300).nullable(),
  scope: z.enum(["task", "project"]), temporary: z.boolean().nullable(), evidenceIds: refs,
});
const OpenLoop = z.strictObject({
  id: localId, workRef, description: text(300),
  kind: z.enum(["unfinished", "pending_validation", "blocked", "waiting_for_user", "next_step"]),
  origin: z.enum(["user_explicit", "assistant_proposed", "inferred"]), evidenceIds: refs,
});
const PreferenceSignal = z.strictObject({
  id: localId, category: z.enum(["prompting", "collaboration", "workflow"]),
  aspect: z.enum(["input_style", "response_detail", "response_format", "execution_order", "change_scope", "confirmation_boundary", "verification_style", "tooling", "other"]),
  condition: text(160).nullable(), preference: text(300),
  scope: z.enum(["task", "project", "user_candidate"]),
  basis: z.enum(["explicit_statement", "observed_pattern"]), evidenceIds: refs,
});
const DraftEvidence = z.strictObject({ id: localId, entryRef: text(256), quote: text(300) });
const Evidence = DraftEvidence.extend({
  role: z.enum(["user", "assistant", "tool"]),
  humanOrigin: z.enum(["unverified", "not_applicable"]),
});
const records = {
  recentWork: z.array(RecentWork).max(5), decisions: z.array(Decision).max(5),
  openLoops: z.array(OpenLoop).max(5), preferenceSignals: z.array(PreferenceSignal).max(5),
};
/** Only these five arrays may be authored by the model. Provenance is supplied by code. */
export const DraftSchema = z.strictObject({ ...records, evidence: z.array(DraftEvidence).max(16) });
export const ObservationSchema = z.strictObject({
  schemaVersion: z.literal("0.1"), observationId: Hash, reviewStatus: z.literal("unreviewed"),
  source: z.strictObject({
    producer: z.literal("pi-work-insights"), projectRef: Hash, sessionRef: Hash, branchRef: text(256),
    observedAt: z.iso.datetime(), inputDigest: Hash,
    entryRefs: z.array(text(256)).max(30), coverage: z.enum(["complete", "partial"]),
    omissionReasons: z.array(text(80)).max(32),
  }),
  extraction: z.strictObject({
    provider: text(256), model: text(256), extractorVersion: z.literal("work-observation-v1"),
    destinationRef: Hash, inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative(),
  }),
  ...records, evidence: z.array(Evidence).max(16),
});
export type Draft = z.infer<typeof DraftSchema>;
export type Observation = z.infer<typeof ObservationSchema>;
export type Metadata = Pick<Observation, "source" | "extraction">;
export const emptyDraft = (): Draft => ({ recentWork: [], decisions: [], openLoops: [], preferenceSignals: [], evidence: [] });

export function observationId(metadata: Metadata): string {
  // Repeated settled/reload events and non-content entries must not cause another paid extraction.
  return digest(["0.1", metadata.source.projectRef, metadata.source.sessionRef, metadata.source.inputDigest,
    metadata.extraction.extractorVersion, metadata.extraction.destinationRef]);
}
function validateLinks(observation: Observation): void {
  const { recentWork, decisions, openLoops, preferenceSignals, evidence, source } = observation;
  const items = [...recentWork, ...decisions, ...openLoops, ...preferenceSignals];
  if (items.length > 12) throw new Error("TOO_MANY_RECORDS");
  const ids = [...items, ...evidence].map(item => item.id);
  if (new Set(ids).size !== ids.length) throw new Error("DUPLICATE_ID");
  if (new Set(source.entryRefs).size !== source.entryRefs.length) throw new Error("DUPLICATE_SOURCE_ENTRY");
  if (source.coverage === "complete" && source.omissionReasons.length) throw new Error("INVALID_COVERAGE");
  const byId = new Map(evidence.map(e => [e.id, e]));
  const used = new Set<string>();
  for (const item of items) {
    if (new Set(item.evidenceIds).size !== item.evidenceIds.length) throw new Error("DUPLICATE_EVIDENCE_REF");
    for (const id of item.evidenceIds) {
      if (!byId.has(id)) throw new Error("UNKNOWN_EVIDENCE");
      used.add(id);
    }
  }
  for (const e of evidence) {
    if (!source.entryRefs.includes(e.entryRef) || !used.has(e.id)) throw new Error("UNUSED_OR_OUTSIDE_EVIDENCE");
    if (e.humanOrigin !== (e.role === "user" ? "unverified" : "not_applicable")) throw new Error("INVALID_HUMAN_ORIGIN");
  }
  const hasRole = (ids: string[], role: string) => ids.some(id => byId.get(id)?.role === role);
  for (const item of [...decisions, ...openLoops]) {
    if (item.workRef !== null && !recentWork.some(w => w.id === item.workRef)) throw new Error("UNKNOWN_WORK_REF");
  }
  for (const item of recentWork) {
    const role = { user_reported: "user", assistant_reported: "assistant", tool_observed: "tool", unknown: null }[item.verification];
    if (role && !hasRole(item.evidenceIds, role)) throw new Error("UNSUPPORTED_VERIFICATION");
    if (item.status === "reported_done" && !hasRole(item.evidenceIds, "user") && !hasRole(item.evidenceIds, "assistant")) {
      throw new Error("UNSUPPORTED_COMPLETION");
    }
  }
  for (const item of decisions) if (!hasRole(item.evidenceIds, "user")) throw new Error("NO_USER_DECISION_EVIDENCE");
  for (const item of openLoops) {
    const role = item.origin === "user_explicit" ? "user" : item.origin === "assistant_proposed" ? "assistant" : null;
    if (role && !hasRole(item.evidenceIds, role)) throw new Error("UNSUPPORTED_LOOP_ORIGIN");
  }
  for (const item of preferenceSignals) {
    // Assistant text may supply context, but never independently supports a user preference.
    const userEntries = new Set(item.evidenceIds.map(id => byId.get(id)!).filter(e => e.role === "user").map(e => e.entryRef));
    if (userEntries.size < (item.basis === "observed_pattern" ? 2 : 1)) throw new Error("INSUFFICIENT_PREFERENCE_EVIDENCE");
  }
  if (hasSensitiveText(JSON.stringify({ recentWork, decisions, openLoops, preferenceSignals, evidence }))) {
    throw new Error("SENSITIVE_OUTPUT");
  }
}
/** Consumer validation checks structure/references, not whether natural-language conclusions are true. */
export function validateObservation(raw: unknown): Observation {
  const observation = ObservationSchema.parse(raw);
  if (observation.observationId !== observationId(observation)) throw new Error("OBSERVATION_ID_MISMATCH");
  validateLinks(observation);
  return observation;
}
export function buildObservation(raw: string | unknown, allowed: readonly AllowedEvidence[], metadata: Metadata): Observation {
  if (typeof raw === "string") {
    if (Buffer.byteLength(raw) > 96 * 1024) throw new Error("RESPONSE_TOO_LARGE");
    raw = JSON.parse(raw.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/, "$1"));
  }
  const draft = DraftSchema.parse(raw);
  const evidence = draft.evidence.map(e => {
    const entry = allowed.find(item => item.entryId === e.entryRef);
    if (!entry || !entry.text.includes(e.quote) || entry.actor === "automation") throw new Error("INVALID_QUOTATION");
    const role = entry.actor === "assistant" ? "assistant" : entry.actor === "tool" ? "tool" : "user";
    return { ...e, role, humanOrigin: role === "user" ? "unverified" : "not_applicable" };
  });
  return validateObservation({ ...draft, evidence, ...metadata,
    schemaVersion: "0.1", observationId: observationId(metadata), reviewStatus: "unreviewed" });
}
