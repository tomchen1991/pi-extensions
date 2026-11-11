import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, rename, unlink } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";

export const ACCOUNTS = ["personal", "work"] as const;
export type Account = (typeof ACCOUNTS)[number];
export interface RepoConfig { version: 1; account: Account | null }
export const CONFIG_FILE = "codex-accounts.json";
export function isAccount(value: unknown): value is Account {
  return value === "personal" || value === "work";
}
export function parseConfig(text: string): RepoConfig {
  const data: unknown = JSON.parse(text);
  if (!data || typeof data !== "object" || Array.isArray(data)) throw Error("Invalid account config");
  const record = data as Record<string, unknown>;
  if (Object.keys(record).some(key => key !== "version" && key !== "account") ||
      record.version !== 1 || !(record.account === null || isAccount(record.account))) {
    throw Error("Invalid account config");
  }
  return { version: 1, account: record.account };
}
export async function repositoryRoot(cwd: string): Promise<string> {
  const { stdout } = await promisify(execFile)("git", ["-C", cwd, "rev-parse", "--show-toplevel"],
    { timeout: 3000, maxBuffer: 16 * 1024, encoding: "utf8" });
  const root = await realpath(stdout.trim());
  const local = await realpath(cwd);
  const rel = relative(root, local);
  if (rel === ".." || rel.startsWith("../") || resolve(root, rel) !== local) throw Error("Invalid repository root");
  return root;
}
export function configPath(root: string, configDirName: string): string {
  return join(root, configDirName, CONFIG_FILE);
}
async function checkPath(path: string, directory = false): Promise<void> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile())) throw Error("Unsafe config path");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
export async function readConfig(path: string): Promise<RepoConfig | undefined> {
  await checkPath(dirname(path), true);
  await checkPath(path);
  try {
    const info = await lstat(path);
    if (info.size > 4096) throw Error("Account config too large");
    return parseConfig(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
/** Whole-file atomic publication; concurrent selectors use last successful rename wins. */
export async function writeConfig(path: string, config: RepoConfig): Promise<void> {
  const text = JSON.stringify(parseConfig(JSON.stringify(config)), null, 2) + "\n";
  await checkPath(dirname(path), true);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await checkPath(path);
  const temp = join(dirname(path), `.${CONFIG_FILE}.${randomUUID()}.tmp`);
  try {
    const file = await open(temp, "wx", 0o600);
    try { await file.writeFile(text); await file.sync(); } finally { await file.close(); }
    await rename(temp, path);
  } finally {
    await unlink(temp).catch(error => { if (error.code !== "ENOENT") throw error; });
  }
}
