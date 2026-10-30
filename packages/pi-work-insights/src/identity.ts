import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

export function canonical(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  throw new Error("NON_CANONICAL_JSON");
}
export const digest = (value: unknown): string => createHash("sha256").update(canonical(value)).digest("hex");

export async function projectRoot(cwd: string): Promise<string> {
  const realCwd = await realpath(cwd);
  try {
    const result = await promisify(execFile)("git", ["-C", realCwd, "rev-parse", "--show-toplevel"], {
      timeout: 2000, maxBuffer: 16384, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    });
    return await realpath(result.stdout.trim());
  } catch (error) {
    // Only an ordinary non-repository result falls back. Timeouts/permissions fail closed.
    const e = error as { code?: number; stderr?: string };
    if (e.code === 128 && e.stderr?.includes("not a git repository")) return realCwd;
    throw new Error("PROJECT_ROOT_UNAVAILABLE");
  }
}
