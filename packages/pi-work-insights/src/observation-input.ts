import { collect, type CollectedEntry } from "./collector.js";
import { digest } from "./identity.js";

export interface ObservationInput {
  entries: CollectedEntry[];
  inputDigest: string;
  coverage: "complete" | "partial";
  omissionReasons: string[];
}
export function observationInput(branch: unknown[], leaf: string): ObservationInput {
  const collected = collect(branch, leaf, { maxChars: Number.MAX_SAFE_INTEGER, maxEntryChars: 4000 });
  const entries: CollectedEntry[] = [];
  const reasons = new Set(collected.omitted.map(e => e.reason));
  let chars = 0;
  for (const entry of collected.entries.slice().reverse()) {
    if (entry.actor === "automation") { reasons.add("automation"); continue; }
    if (entries.length === 30 || chars + entry.text.length > 16000) { reasons.add("recent_window_limit"); break; }
    chars += entry.text.length;
    entries.push(entry);
  }
  entries.reverse();
  return {
    entries, inputDigest: digest(entries.map(({ entryId, actor, text }) => ({ entryId, actor, text }))),
    coverage: reasons.size ? "partial" : "complete", omissionReasons: [...reasons].sort(),
  };
}
