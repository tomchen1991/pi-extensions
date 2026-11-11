import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Git, run } from "../src/git.js";
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture(branch = "main") {
  const dir = mkdtempSync(join(tmpdir(), "branch-test-")); dirs.push(dir);
  const remote = join(dir, "remote.git"), cwd = join(dir, "repo");
  const g = (args: string[], at = cwd) => execFileSync("git", args, { cwd: at, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  g(["init", "--bare", "--initial-branch", branch, remote], dir);
  g(["clone", remote, cwd], dir);
  g(["config", "user.name", "Synthetic"]); g(["config", "user.email", "test@example.invalid"]);
  writeFileSync(join(cwd, "file"), "base\n"); g(["add", "."]); g(["commit", "-m", "initial"]); g(["push", "-u", "origin", branch]);
  g(["switch", "-c", "feat/test"]);
  return { cwd, g, remote };
}
describe("Git commands using temporary repositories only", () => {
  it.each(["main", "master", "trunk"])("returns to actual default %s and keeps a recoverable stash", async branch => {
    const { cwd, g } = fixture(branch); const git = new Git();
    writeFileSync(join(cwd, "file"), "staged\n"); g(["add", "file"]);
    writeFileSync(join(cwd, "file"), "unstaged\n"); writeFileSync(join(cwd, "new"), "untracked\n");
    const state = await git.state(cwd); await git.fetch(cwd); const target = await git.target(cwd);
    let saved = "";
    const result = await git.returnMain(state, target, true, undefined, oid => { saved = oid; });
    expect(result).toContain(branch); expect(saved).toMatch(/^[a-f0-9]{40,64}$/);
    expect((await git.state(cwd)).dirty).toBe(false);
    g(["switch", "feat/test"]); g(["stash", "apply", "--index", saved]);
    expect(readFileSync(join(cwd, "file"), "utf8")).toBe("unstaged\n");
    expect(g(["show", ":file"])).toBe("staged"); expect(readFileSync(join(cwd, "new"), "utf8")).toBe("untracked\n");
  });
  it("reports staged, unstaged, untracked and exact remote progress", async () => {
    const { cwd, g } = fixture(); const git = new Git();
    writeFileSync(join(cwd, "file"), "committed\n"); g(["commit", "-am", "feature work"]);
    writeFileSync(join(cwd, "file"), "staged\n"); g(["add", "."]); writeFileSync(join(cwd, "file"), "unstaged\n");
    writeFileSync(join(cwd, "new"), "PRIVATE_UNTRACKED_BODY");
    const report = await git.report(cwd);
    expect(report.facts).toContain("领先 1，落后 0"); expect(report.facts).toContain("未设置");
    expect(report.evidence).toContain("+staged"); expect(report.evidence).toContain("+unstaged");
    expect(JSON.stringify(report)).not.toContain("PRIVATE_UNTRACKED_BODY");
  });
  it("labels failed fetch as stale", async () => {
    const { cwd } = fixture(); const git = new Git((args, at, signal) => args[0] === "fetch" ? Promise.resolve({ code: 1, stdout: "" }) : run(args, at, signal));
    expect((await git.report(cwd)).facts).toContain("fetch 失败，引用可能过期");
  });
  it("never uses partial output after a diff command fails or exceeds its limit", async () => {
    const { cwd } = fixture();
    const git = new Git((args, at, signal) => args[0] === "diff" ? Promise.resolve({ code: -1, stdout: "UNTRUSTED_PARTIAL_OUTPUT" }) : run(args, at, signal));
    const report = await git.report(cwd);
    expect(report.evidence).toContain("不可用"); expect(report.evidence).not.toContain("UNTRUSTED_PARTIAL_OUTPUT");
    await expect(git.signature(await git.state(cwd))).rejects.toThrow("输出超限");
  });
  it("does not stash without explicit consent", async () => {
    const { cwd, g } = fixture(); const git = new Git(); writeFileSync(join(cwd, "new"), "preserve");
    await expect(git.returnMain(await git.state(cwd), await git.target(cwd), false)).rejects.toThrow("未授权");
    expect(g(["branch", "--show-current"])).toBe("feat/test"); expect(g(["stash", "list"])).toBe("");
  });
  it("rejects changed state after confirmation", async () => {
    const { cwd } = fixture(); const git = new Git(); const state = await git.state(cwd);
    writeFileSync(join(cwd, "new"), "racing change");
    await expect(git.returnMain(state, await git.target(cwd), true)).rejects.toThrow("状态发生变化");
  });
  it("detects edits to already-dirty files while confirmation is open", async () => {
    const { cwd } = fixture(); const git = new Git();
    writeFileSync(join(cwd, "file"), "before confirmation");
    const state = await git.state(cwd); state.signature = await git.signature(state);
    writeFileSync(join(cwd, "file"), "after confirmation");
    await expect(git.returnMain(state, await git.target(cwd), true)).rejects.toThrow("状态发生变化");
  });
  it("fast-forwards default branch to newly fetched commits", async () => {
    const { cwd, g, remote } = fixture(); const git = new Git();
    const other = join(cwd, "..", "other"); g(["clone", remote, other]);
    g(["config", "user.name", "Synthetic"], other); g(["config", "user.email", "test@example.invalid"], other);
    writeFileSync(join(other, "remote-only"), "new remote commit"); g(["add", "."], other); g(["commit", "-m", "remote progress"], other); g(["push"], other);
    await git.fetch(cwd); const target = await git.target(cwd);
    await git.returnMain(await git.state(cwd), target, false);
    expect(g(["rev-parse", "HEAD"])).toBe(target.oid); expect(readFileSync(join(cwd, "remote-only"), "utf8")).toBe("new remote commit");
  });
  it("creates a local default branch when only its remote ref exists", async () => {
    const { cwd, g } = fixture(); g(["branch", "-D", "main"]); const git = new Git();
    await git.returnMain(await git.state(cwd), await git.target(cwd), false);
    expect(g(["branch", "--show-current"])).toBe("main"); expect(g(["rev-parse", "--abbrev-ref", "@{upstream}"])).toBe("origin/main");
  });
  it("rejects local-ahead default branch without switching or resetting", async () => {
    const { cwd, g } = fixture(); g(["switch", "main"]); writeFileSync(join(cwd, "file"), "local ahead"); g(["commit", "-am", "ahead"]); g(["switch", "feat/test"]);
    const git = new Git(); await expect(git.returnMain(await git.state(cwd), await git.target(cwd), false)).rejects.toThrow();
    expect(g(["branch", "--show-current"])).toBe("feat/test"); expect(g(["log", "-1", "--format=%s", "main"])).toBe("ahead");
  });
  it("preserves and reports stash when switch fails", async () => {
    const { cwd, g } = fixture(); writeFileSync(join(cwd, "new"), "preserve");
    const git = new Git((args, at, signal) => args[0] === "switch" ? Promise.resolve({ code: 1, stdout: "" }) : run(args, at, signal));
    await expect(git.returnMain(await git.state(cwd), await git.target(cwd), true)).rejects.toThrow("stash 保留");
    expect(g(["stash", "list"])).toContain("pi-branch"); expect(g(["branch", "--show-current"])).toBe("feat/test");
  });
  it("rejects merge in progress and aborted work", async () => {
    const { cwd, g } = fixture(); writeFileSync(join(cwd, ".git", "MERGE_HEAD"), g(["rev-parse", "HEAD"]));
    const git = new Git(); await expect(git.ensureReady(await git.state(cwd))).rejects.toThrow("进行中");
    await expect(git.state(cwd, AbortSignal.abort())).rejects.toThrow();
  });
});
