import { createHash, randomUUID } from "node:crypto";
import { basename, isAbsolute } from "node:path";

export interface Project {
  id: string;
  name: string;
  path: string;
}

export interface UsageRecord {
  schemaVersion: 1;
  id: string;
  source: "assistant_message_end";
  completedAt: string;
  hourStart: string;
  project: Project;
  provider: string;
  model: string;
  outcome: string;
  tokens: {
    cachedInput: number;
    uncachedInput: number;
    output: number;
  };
}

export function projectFromPath(path: string): Project {
  if (!isAbsolute(path)) throw new Error("INVALID_PROJECT_PATH");
  return { id: createHash("sha256").update(path).digest("hex"), name: basename(path), path };
}

function count(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("INVALID_USAGE");
  }
  return value;
}

/** Extract an allowlist only: never serialize a message, content, or provider payload. */
export function createRecord(message: unknown, project: Project, now = Date.now()): UsageRecord | undefined {
  if (!message || typeof message !== "object") return;
  const m = message as Record<string, unknown>;
  if (m.role !== "assistant") return;
  // Deferred/pending responses do not represent final usage.
  if (m.stopReason === "pending" || m.stopReason === "deferred") return;
  if (typeof m.provider !== "string" || !m.provider || typeof m.model !== "string" || !m.model ||
      typeof m.stopReason !== "string" || !m.stopReason || !m.usage || typeof m.usage !== "object") {
    throw new Error("INVALID_USAGE");
  }
  const usage = m.usage as Record<string, unknown>;
  const uncachedInput = count(count(usage.input) + count(usage.cacheWrite));
  const completedAt = new Date(now).toISOString();
  return {
    schemaVersion: 1,
    id: randomUUID(),
    source: "assistant_message_end",
    completedAt,
    hourStart: `${completedAt.slice(0, 13)}:00:00.000Z`,
    project: { ...project },
    provider: m.provider,
    model: m.model,
    outcome: m.stopReason,
    tokens: { cachedInput: count(usage.cacheRead), uncachedInput, output: count(usage.output) },
  };
}
