import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { configPath, parseConfig, readConfig, repositoryRoot, writeConfig } from "../src/config.js";

const dirs: string[] = [];
async function temp() { const dir = await mkdtemp(join(tmpdir(), "pi-accounts-config-")); dirs.push(dir); return dir; }
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

describe("repository config", () => {
  it("accepts only a version and one non-secret account selector", () => {
    expect(parseConfig('{"version":1,"account":"personal"}')).toEqual({ version: 1, account: "personal" });
    expect(parseConfig('{"version":1,"account":null}').account).toBeNull();
    for (const data of [null, [], {}, { version: 2, account: "work" }, { version: 1, account: "../other" },
      { version: 1, account: "work", access: "synthetic-token" }, { version: 1 }]) {
      expect(() => parseConfig(JSON.stringify(data))).toThrow();
    }
  });
  it("finds the checkout root from a nested directory; rejects non-repositories", async () => {
    const dir = await temp();
    await expect(repositoryRoot(dir)).rejects.toThrow();
    execFileSync("git", ["init", "--quiet", dir]);
    await mkdir(join(dir, "nested", "deep"), { recursive: true });
    expect(await repositoryRoot(join(dir, "nested", "deep"))).toBe(dir);
  });
  it("does not create config on reads; publishes only the selector with private permissions", async () => {
    const path = configPath(await temp(), ".pi");
    expect(await readConfig(path)).toBeUndefined();
    await writeConfig(path, { version: 1, account: "work" });
    expect(await readConfig(path)).toEqual({ version: 1, account: "work" });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readdir(join(path, ".."))).toEqual(["codex-accounts.json"]);
  });
  it("concurrent writers publish complete files without orphaned temporary files", async () => {
    const dir = await temp();
    const path = configPath(dir, ".pi");
    await Promise.all(Array.from({ length: 20 }, (_, i) => writeConfig(path, { version: 1, account: i % 2 ? "personal" : "work" })));
    expect(["personal", "work"]).toContain((await readConfig(path))?.account);
    expect(await readdir(join(dir, ".pi"))).toEqual(["codex-accounts.json"]);
  });
  it("rejects malformed/oversized configs and symlink targets without overwriting them", async () => {
    const dir = await temp();
    const path = configPath(dir, ".pi");
    await mkdir(join(dir, ".pi"));
    await writeFile(path, "x".repeat(4097));
    await expect(readConfig(path)).rejects.toThrow();
    await writeFile(path, "{bad json");
    await expect(readConfig(path)).rejects.toThrow();
    const target = join(dir, "synthetic-target");
    await writeFile(target, "untouched");
    await rm(path);
    await symlink(target, path);
    await expect(readConfig(path)).rejects.toThrow();
    await expect(writeConfig(path, { version: 1, account: "work" })).rejects.toThrow();
    expect(await readFile(target, "utf8")).toBe("untouched");
  });
  it("refuses a symlinked project config directory", async () => {
    const dir = await temp();
    const outside = await temp();
    await symlink(outside, join(dir, ".pi"));
    const path = configPath(dir, ".pi");
    await expect(readConfig(path)).rejects.toThrow();
    await expect(writeConfig(path, { version: 1, account: "work" })).rejects.toThrow();
    expect(await readdir(outside)).toEqual([]);
  });
});
