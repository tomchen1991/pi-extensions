import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, lstat } from "node:fs/promises";
import { resolve } from "node:path";

export interface Result { code: number; stdout: string }
export type Run = (args: string[], cwd: string, signal?: AbortSignal) => Promise<Result>;
export const run: Run = (args, cwd, signal) => new Promise(resolve => {
  execFile("git", ["--no-pager", ...args], {
    cwd, signal, timeout: 30000, maxBuffer: 256 * 1024,
    env: { ...process.env, LC_ALL: "C", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
  }, (error, stdout) => resolve({ code: error ? -1 : 0, stdout: error ? "" : stdout }));
});
export class GitError extends Error {}
export interface State { root: string; branch: string; oid: string; status: string; dirty: boolean; signature?: string }
export interface Target { branch: string; ref: string; oid: string }
export interface Report { facts: string; evidence: string }
export class Git {
  constructor(private execute: Run = run) {}
  async command(cwd: string, args: string[], signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    const result = await this.execute(args, cwd, signal);
    signal?.throwIfAborted();
    if (result.code !== 0) throw new GitError(`Git 操作失败：${args[0]}（可能为网络、冲突、超时或输出超限；未使用部分输出）`);
    return result.stdout;
  }
  async optional(cwd: string, args: string[], signal?: AbortSignal): Promise<string | undefined> {
    signal?.throwIfAborted();
    const result = await this.execute(args, cwd, signal);
    signal?.throwIfAborted();
    return result.code === 0 ? result.stdout.trim() : undefined;
  }
  async state(cwd: string, signal?: AbortSignal): Promise<State> {
    const root = (await this.command(cwd, ["rev-parse", "--show-toplevel"], signal)).trim();
    const oid = (await this.command(root, ["rev-parse", "--verify", "HEAD"], signal)).trim();
    const branch = await this.optional(root, ["symbolic-ref", "--quiet", "--short", "HEAD"], signal) ?? "(detached HEAD)";
    const status = await this.command(root, ["status", "--porcelain=v1", "--untracked-files=all"], signal);
    return { root, oid, branch, status, dirty: !!status };
  }
  async signature(state: State, signal?: AbortSignal): Promise<string> {
    // Confirmed mutations fail closed on oversized diffs. No untracked file bodies are read.
    const diff = await this.command(state.root, ["diff", "--binary", "--no-ext-diff", "--no-textconv", "HEAD", "--"], signal);
    const paths = await this.command(state.root, ["ls-files", "--others", "--exclude-standard", "-z"], signal);
    const staged = await this.command(state.root, ["diff", "--cached", "--binary", "--no-ext-diff", "--no-textconv", "HEAD", "--"], signal);
    const hash = createHash("sha256").update(diff).update("\0").update(staged);
    for (const path of paths.split("\0").filter(Boolean)) {
      const stat = await lstat(resolve(state.root, path), { bigint: true });
      hash.update(JSON.stringify([path, String(stat.size), String(stat.mtimeNs), String(stat.ctimeNs)]));
    }
    signal?.throwIfAborted();
    return hash.digest("hex");
  }
  async fetch(root: string, signal?: AbortSignal): Promise<void> {
    await this.command(root, ["fetch", "--prune", "--no-tags", "--", "origin"], signal);
  }
  async target(root: string, signal?: AbortSignal): Promise<Target> {
    // Query the actual remote HEAD, not a possibly stale local origin/HEAD.
    const head = await this.command(root, ["ls-remote", "--symref", "--", "origin", "HEAD"], signal);
    const branch = /^ref: refs\/heads\/(.+)\tHEAD$/m.exec(head)?.[1];
    if (!branch || (await this.execute(["check-ref-format", "--branch", branch], root, signal)).code !== 0) {
      throw new GitError("无法确定 origin 默认分支；请手动检查远端 HEAD，不猜测 main/master。");
    }
    const ref = `refs/remotes/origin/${branch}`;
    const oid = (await this.command(root, ["rev-parse", "--verify", `${ref}^{commit}`], signal)).trim();
    return { branch, ref, oid };
  }
  async report(cwd: string, signal?: AbortSignal): Promise<Report> {
    const initial = await this.state(cwd, signal);
    let fresh = true;
    try { await this.fetch(initial.root, signal); } catch { signal?.throwIfAborted(); fresh = false; }
    const state = await this.state(cwd, signal);
    const facts = [`分支：${state.branch}`, `HEAD：${state.oid}`, `远端：${fresh ? "origin fetch 成功（查询时快照）" : "fetch 失败，引用可能过期"}`,
      `工作区（XY：暂存/未暂存；??：未跟踪）：\n${state.status ? state.status.slice(0, 12000) + (state.status.length > 12000 ? "\n[状态路径截断]" : "") : "干净"}`];
    const sections: string[] = [];
    const add = async (label: string, args: string[]) => {
      try { sections.push(`${label}\n${(await this.command(state.root, args, signal)).slice(0, 12000)}`); }
      catch { signal?.throwIfAborted(); sections.push(`${label}：不可用（失败或输出超限，未读取部分输出）`); }
    };
    const compare = async (label: string, ref: string) => {
      try {
        const counts = (await this.command(state.root, ["rev-list", "--left-right", "--count", `HEAD...${ref}`], signal)).trim().split(/\s+/);
        facts.push(`${label}：领先 ${counts[0]}，落后 ${counts[1]}（按提交祖先关系，不判断 squash/PR 是否合并）`);
        await add(`${label}：本地独有提交（最多30条）`, ["log", "-30", "--format=%h %s", `${ref}..HEAD`, "--"]);
        await add(`${label}：远端独有提交（最多30条）`, ["log", "-30", "--format=%h %s", `HEAD..${ref}`, "--"]);
        await add(`${label}：相对共同祖先的本地文件变化`, ["diff", "--no-ext-diff", "--no-textconv", "--stat", `${ref}...HEAD`, "--"]);
      } catch { signal?.throwIfAborted(); facts.push(`${label}：不可用（引用丢失或无共同历史）`); }
    };
    const upstream = await this.optional(state.root, ["rev-parse", "--symbolic-full-name", "@{upstream}"], signal);
    if (upstream) {
      // origin only is fetched; other tracking remotes are explicitly stale.
      await compare(`跟踪分支 ${upstream}${upstream.startsWith("refs/remotes/origin/") ? "" : "（未刷新该远端）"}`, upstream);
    } else facts.push("跟踪分支：未设置或已删除；不视为已同步");
    try { const target = await this.target(state.root, signal); await compare(`默认分支 origin/${target.branch}`, target.ref); }
    catch { signal?.throwIfAborted(); facts.push("默认分支：查询失败，进度未知"); }
    await add("已暂存 diff（仅前12000字符）", ["diff", "--cached", "--no-ext-diff", "--no-textconv", "--", "."]);
    await add("未暂存 diff（仅前12000字符）", ["diff", "--no-ext-diff", "--no-textconv", "--", "."]);
    sections.push("未跟踪文件仅包含上面的路径，不读取正文；二进制文件不分析正文。证据可能截断，不代表完整审查。");
    return { facts: facts.join("\n"), evidence: "以下证据有界且可能截断，不代表完整审查。\n" + sections.join("\n\n").slice(0, 47950) };
  }
  async ensureReady(state: State, signal?: AbortSignal): Promise<void> {
    for (const name of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply", "sequencer"]) {
      const location = (await this.command(state.root, ["rev-parse", "--git-path", name], signal)).trim();
      try { await access(resolve(state.root, location)); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw new GitError("无法检查 Git 操作状态。");
      }
      throw new GitError("存在进行中的 merge/rebase/cherry-pick 等操作，请先手动处理。");
    }
    if (/^(?:UU|AA|DD|AU|UA|DU|UD) /m.test(state.status)) throw new GitError("存在未解决冲突，请先手动处理。");
    const submodules = await this.command(state.root, ["submodule", "status", "--recursive"], signal);
    if (submodules) throw new GitError("含子模块的仓库暂不支持自动回主分支，请手动保管子模块修改。");
  }
  async returnMain(before: State, target: Target, stash: boolean, signal?: AbortSignal, onStash?: (oid: string) => void): Promise<string> {
    await this.ensureReady(before, signal);
    const current = await this.state(before.root, signal);
    if (current.oid !== before.oid || current.branch !== before.branch || current.status !== before.status ||
      (before.signature && before.signature !== await this.signature(current, signal))) {
      throw new GitError("确认期间仓库状态发生变化，请重新执行 /branch main。");
    }
    const local = await this.optional(current.root, ["rev-parse", "--verify", `refs/heads/${target.branch}`], signal);
    if (local) {
      const ancestor = await this.execute(["merge-base", "--is-ancestor", local, target.oid], current.root, signal);
      if (ancestor.code !== 0) throw new GitError("本地主分支领先或分叉（或无法验证），停止；不 stash、不 reset/rebase。");
    }
    let saved: string | undefined;
    try {
      if (current.dirty) {
        if (!stash) throw new GitError("未授权 stash，保持原状。");
        await this.command(current.root, ["stash", "push", "--include-untracked", "-m", `pi-branch ${randomUUID()}`], signal);
        saved = (await this.command(current.root, ["rev-parse", "refs/stash"], signal)).trim();
        onStash?.(saved);
      }
      const clean = await this.state(current.root, signal);
      if (clean.dirty || clean.oid !== before.oid || clean.branch !== before.branch) throw new GitError("工作区未清空或分支已变化，停止切换。");
      // ignored 文件不在状态指纹或 stash 中，切换和更新均须由 Git 拒绝覆盖。
      if (local) await this.command(current.root, ["switch", "--no-overwrite-ignore", "--no-guess", target.branch], signal);
      else await this.command(current.root, ["switch", "--no-overwrite-ignore", "--track", "-c", target.branch, target.ref], signal);
      await this.command(current.root, ["-c", "merge.autoStash=false", "merge", "--ff-only", "--no-overwrite-ignore", target.oid], signal);
      const after = await this.state(current.root, signal);
      if (after.branch !== target.branch || after.oid !== target.oid || after.dirty) throw new GitError("最终状态与预期不一致，请手动核对。");
      return `已回到 ${target.branch} 并 fast-forward 到 ${target.oid.slice(0, 12)}（本次 fetch 快照）。原任务分支未删除。${saved ? `\nstash 已保留：${saved}；回原分支核对后可 git stash apply --index ${saved}，不自动恢复或删除。` : ""}`;
    } catch (error) {
      throw new GitError(`${error instanceof GitError ? error.message : "操作被取消或失败。"}\n可能已 stash 或切换分支；未自动回滚，请检查 git status。${saved ? `\nstash 保留：${saved}；恢复：git stash apply --index ${saved}` : "如 stash 操作中断，请先检查 git stash list。"}`);
    }
  }
}
