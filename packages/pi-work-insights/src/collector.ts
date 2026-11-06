import { z } from "zod";
import type { Actor, AllowedEvidence } from "./contract.js";
import { digest } from "./identity.js";
import { safeText, hasSensitiveText } from "./privacy.js";

const Entry = z.looseObject({ type: z.string(), id: z.string().min(1).max(256), parentId: z.string().nullable() });
type Entry = z.infer<typeof Entry>;
const object = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
function textContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.filter(c => object(c).type === "text" && typeof object(c).text === "string")
    .map(c => object(c).text).join("\n");
}
export interface CollectedEntry extends AllowedEvidence { parentId: string | null; contentDigest: string }
export interface Collection {
  entries: CollectedEntry[];
  omitted: { entryId: string; reason: string }[];
  coverage: "complete" | "partial";
  sourceDigest: string;
}
export function collect(rawEntries: unknown[], leaf: string, options: {
  // Set only by trusted integration code, never from message fields or model output.
  origins?: ReadonlyMap<string, { actor: Actor; contentDigest: string }>;
  maxChars?: number; maxEntryChars?: number;
} = {}): Collection {
  if (rawEntries.length > 100_000) throw new Error("BRANCH_TOO_LARGE");
  const byId = new Map<string, Entry>();
  for (const raw of rawEntries) {
    const e = Entry.parse(raw);
    if (byId.has(e.id)) throw new Error("DUPLICATE_ENTRY_ID");
    byId.set(e.id, e);
  }
  const branch: Entry[] = [];
  const seen = new Set<string>();
  let id: string | null = leaf;
  while (id !== null) {
    const e: Entry | undefined = byId.get(id);
    if (!e || seen.has(id)) throw new Error("INVALID_BRANCH");
    seen.add(id); branch.push(e); id = e.parentId;
  }
  branch.reverse();
  const edits = new Map<string, unknown>();
  const previous = new Set<string>();
  for (const e of branch) {
    if (e.type === "context_edit") {
      if (typeof e.targetId !== "string" || !previous.has(e.targetId)) throw new Error("INVALID_CONTEXT_EDIT");
      // Pi 1.4.0 declarations: replacement is {content: ...} | null, NOT a raw string.
      if (e.replacement === null) edits.set(e.targetId, null);
      else if (e.replacement && typeof e.replacement === "object" && "content" in e.replacement) {
        edits.set(e.targetId, object(e.replacement).content);
      } else throw new Error("UNSUPPORTED_CONTEXT_EDIT");
    }
    previous.add(e.id);
  }
  const entries: CollectedEntry[] = [];
  const omitted: Collection["omitted"] = [];
  const calls = new Map<string, { name: string; sensitive: boolean }>();
  let size = 0;
  const omit = (e: Entry, reason: string) => omitted.push({ entryId: e.id, reason });
  for (const e of branch) {
    if (edits.has(e.id) && edits.get(e.id) === null) { omit(e, "context_deleted"); continue; }
    if (e.type === "compaction" || e.type === "branch_summary" || e.type === "custom_message") {
      omit(e, "derived_or_injected_context"); continue;
    }
    if (e.type !== "message") {
      if (!["context_edit", "usage", "model_change", "thinking_level_change", "label", "session_info", "custom"].includes(e.type)) omit(e, "unknown_entry_type");
      continue;
    }
    const message = object(e.message);
    const content = edits.has(e.id) ? edits.get(e.id) : message.content;
    if (message.role === "system") continue;
    if (message.role === "assistant" && Array.isArray(content)) {
      for (const c of content.map(object)) {
        if (c.type !== "toolCall" || typeof c.id !== "string" || typeof c.name !== "string") continue;
        if (calls.has(c.id)) throw new Error("AMBIGUOUS_TOOL_CALL");
        calls.set(c.id, { name: c.name, sensitive: hasSensitiveText(JSON.stringify(c.arguments ?? {})) });
      }
    }
    let text = textContent(content);
    let actor: Actor;
    let toolCallId: string | undefined;
    if (message.role === "user") {
      const origin = options.origins?.get(e.id);
      actor = origin && origin.contentDigest === digest(text) ? origin.actor : "unknown";
      // Even trusted origins may only label a user-shaped message as human/automation/unknown.
      if (!["human", "automation", "unknown"].includes(actor)) actor = "unknown";
    } else if (message.role === "assistant" && message.stopReason === "stop") {
      actor = "assistant";
    } else if (message.role === "toolResult") {
      toolCallId = typeof message.toolCallId === "string" ? message.toolCallId : undefined;
      const call = toolCallId ? calls.get(toolCallId) : undefined;
      if (!call || call.name !== message.toolName || call.sensitive) { omit(e, "untrusted_tool_link_or_sensitive_arguments"); continue; }
      // No file dumps, nested tool details, commands, or arbitrary output. Only bounded test counters.
      if (call.name !== "bash" || text.length > 8000 || hasSensitiveText(text)) { omit(e, "tool_output_not_allowlisted"); continue; }
      text = text.split(/\r?\n/).filter(line => /^\s*(?:Tests|Test Files)\s+\d+\s+(?:passed|failed)(?:\s+\(\d+\))?\s*$/.test(line)).join("\n").trim();
      if (!text) { omit(e, "no_safe_tool_summary"); continue; }
      // These are observed strings, not independent proof that a business requirement passed.
      actor = "tool";
    } else { omit(e, "unsupported_or_intermediate_message"); continue; }
    const safe = safeText(text);
    if (safe === undefined) { omit(e, "sensitive_content"); continue; }
    if (!safe.trim()) { omit(e, "no_text"); continue; }
    // Whole-entry omission avoids chopping secret-like values or changing assertion meaning.
    if (safe.length > (options.maxEntryChars ?? 6000)) { omit(e, "oversized_entry"); continue; }
    if (size + safe.length > (options.maxChars ?? 24000)) { omit(e, "batch_budget"); continue; }
    size += safe.length;
    entries.push({ entryId: e.id, parentId: e.parentId, actor, text: safe,
      contentDigest: digest(safe), ...(toolCallId ? { toolCallId } : {}) });
  }
  return { entries, omitted, coverage: omitted.length ? "partial" : "complete", sourceDigest: digest({ entries, omitted }) };
}
