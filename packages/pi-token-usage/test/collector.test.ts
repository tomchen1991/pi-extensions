import { afterEach, describe, expect, it } from "vitest";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRecord, projectFromPath } from "../dist/record.js";
import { resolveProject } from "../dist/project.js";
import { storeRecord } from "../dist/storage.js";

const dirs: string[] = [];
async function temporary() {
  const dir = await mkdtemp(join(tmpdir(), "token-usage-test-"));
  dirs.push(dir);
  return dir;
}
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
const message = (extra = {}) => ({ role: "assistant", provider: "synthetic", model: "fake-model",
  stopReason: "stop", usage: { input: 100, cacheRead: 700, cacheWrite: 30, output: 20 },
  content: [{ type: "text", text: "PRIVATE_CONTENT_NOT_TO_STORE" }], ...extra });
const project = projectFromPath("/synthetic/project");
const now = Date.parse("2026-06-01T23:59:59.123Z");

describe("record contract", () => {
  it("uses three disjoint categories and includes cache creation in uncached input", () => {
    const record = createRecord(message(), project, now)!;
    expect(record.tokens).toEqual({ cachedInput: 700, uncachedInput: 130, output: 20 });
    expect(Object.values(record.tokens).reduce((a, b) => a + b)).toBe(850);
    expect(record.completedAt).toBe("2026-06-01T23:59:59.123Z");
    expect(record.hourStart).toBe("2026-06-01T23:00:00.000Z");
    expect(record.provider).toBe("synthetic");
    expect(record.model).toBe("fake-model");
    expect(JSON.stringify(record)).not.toMatch(/PRIVATE_CONTENT|session|content|cost/);
  });
  it("keeps UTC hour boundaries and actual response model, independent of selection", () => {
    const record = createRecord(message({ provider: "fallback", model: "actual" }), project, now + 1000)!;
    expect(record.hourStart).toBe("2026-06-02T00:00:00.000Z");
    expect(record.provider).toBe("fallback");
    expect(record.model).toBe("actual");
  });
  it.each(["aborted", "error", "length", "toolUse"])("keeps reported usage for %s", stopReason => {
    expect(createRecord(message({ stopReason }), project, now)?.tokens.output).toBe(20);
  });
  it("does not count other roles or intermediate deferred responses", () => {
    for (const role of ["user", "toolResult", "custom"]) expect(createRecord(message({ role }), project, now)).toBeUndefined();
    for (const stopReason of ["pending", "deferred"]) expect(createRecord(message({ stopReason }), project, now)).toBeUndefined();
  });
  it.each([undefined, -1, 1.1, NaN, Infinity, "42", Number.MAX_SAFE_INTEGER + 1])("rejects invalid counters: %s", value => {
    expect(() => createRecord(message({ usage: { input: value, cacheRead: 0, cacheWrite: 0, output: 0 } }), project, now)).toThrow("INVALID_USAGE");
  });
  it("does not silently replace missing usage with zero or overflow sums", () => {
    expect(() => createRecord(message({ usage: undefined }), project, now)).toThrow();
    expect(() => createRecord(message({ usage: { input: Number.MAX_SAFE_INTEGER, cacheRead: 0, cacheWrite: 1, output: 0 } }), project, now)).toThrow();
    expect(createRecord(message({ usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 } }), project, now)?.tokens.output).toBe(0);
  });
});

describe("project identity", () => {
  it("groups nested repository directories; non-Git uses canonical cwd", async () => {
    const dir = await temporary();
    const repo = join(dir, "repo");
    const nested = join(repo, "src", "nested");
    await mkdir(nested, { recursive: true });
    execFileSync("git", ["init", repo], { stdio: "ignore" });
    expect(await resolveProject(nested)).toEqual(await resolveProject(repo));
    const outside = join(dir, "outside");
    await mkdir(outside);
    const result = await resolveProject(outside);
    expect(result.name).toBe("outside");
    expect(result.id).not.toBe((await resolveProject(repo)).id);
  });
});

describe("atomic immutable storage", () => {
  it("publishes independent concurrent records with private permissions", async () => {
    const root = await temporary();
    const records = Array.from({ length: 40 }, () => createRecord(message(), project, now)!);
    await Promise.all(records.map(record => storeRecord(root, record)));
    const dir = join(root, "events", "2026-06-01", "23");
    const files = await readdir(dir);
    expect(files).toHaveLength(40);
    expect(files.every(file => file.endsWith(".json"))).toBe(true);
    const saved = await Promise.all(files.map(async file => JSON.parse(await readFile(join(dir, file), "utf8"))));
    expect(new Set(saved.map(record => record.id)).size).toBe(40);
    expect(saved.every(record => record.tokens.uncachedInput === 130)).toBe(true);
    expect((await stat(join(dir, files[0]))).mode & 0o777).toBe(0o600);
  });
  it("publishes safely from independent processes and ignores interrupted temporary files", async () => {
    const root = await temporary();
    const storageUrl = new URL("../dist/storage.js", import.meta.url).href;
    const record = createRecord(message(), project, now)!;
    const run = promisify(execFile);
    await Promise.all(Array.from({ length: 4 }, () => run(process.execPath, ["--input-type=module", "-e",
      `import { storeRecord } from ${JSON.stringify(storageUrl)};
       import { randomUUID } from 'node:crypto';
       const record = JSON.parse(process.argv[2]);
       await Promise.all(Array.from({length: 8}, () => storeRecord(process.argv[1], {...record, id: randomUUID()})));`,
      root, JSON.stringify(record)], { timeout: 10000 })));
    const dir = join(root, "events", "2026-06-01", "23");
    // A killed writer can leave a partial .tmp, but no visible incomplete .json.
    await writeFile(join(dir, ".interrupted.tmp"), '{"partial":');
    const files = (await readdir(dir)).filter(file => file.endsWith(".json"));
    expect(files).toHaveLength(32);
    for (const file of files) expect(JSON.parse(await readFile(join(dir, file), "utf8")).tokens.output).toBe(20);
  });
  it("never overwrites a committed record, including concurrent same-ID publishers", async () => {
    const root = await temporary();
    const record = createRecord(message(), project, now)!;
    const outcomes = await Promise.allSettled([storeRecord(root, record), storeRecord(root, record)]);
    expect(outcomes.filter(outcome => outcome.status === "fulfilled")).toHaveLength(1);
    await expect(storeRecord(root, { ...record, model: "replacement" })).rejects.toThrow();
    const dir = join(root, "events", "2026-06-01", "23");
    expect(await readdir(dir)).toEqual([`${record.id}.json`]);
    expect(JSON.parse(await readFile(join(dir, `${record.id}.json`), "utf8")).model).toBe("fake-model");
  });
  it("reports unavailable output and invalid storage keys without publishing", async () => {
    const root = await temporary();
    await writeFile(join(root, "blocked"), "not a directory");
    const record = createRecord(message(), project, now)!;
    await expect(storeRecord(join(root, "blocked"), record)).rejects.toThrow();
    await expect(storeRecord(root, { ...record, id: "../../escape" })).rejects.toThrow("INVALID_STORAGE_KEY");
    expect(await readdir(root)).toEqual(["blocked"]);
  });
});
