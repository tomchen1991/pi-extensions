import { describe, expect, it, vi } from "vitest";
import { Git, type Run, type State } from "../src/git.js";

const before: State = { root: "/synthetic", branch: "feat/test", oid: "task-oid", status: "", dirty: false };
const target = { branch: "main", ref: "refs/remotes/origin/main", oid: "remote-oid" };

// 只注入合成执行器，不执行真实 Git 写操作。
function setup(local: boolean, failure?: "switch" | "merge", dirty = false) {
  const execute = vi.fn<Run>(async args => {
    if (args[0] === "rev-parse") {
      if (args[1] === "refs/stash") return { code: 0, stdout: "saved-stash" };
      return { code: local ? 0 : 1, stdout: local ? "local-oid" : "" };
    }
    if (args[0] === failure || (failure === "merge" && args.includes("merge"))) return { code: 1, stdout: "" };
    return { code: 0, stdout: "" };
  });
  const git = new Git(execute);
  vi.spyOn(git, "ensureReady").mockResolvedValue();
  const initial = { ...before, dirty, status: dirty ? "?? new\n" : "" };
  const state = vi.spyOn(git, "state")
    .mockResolvedValueOnce(initial)
    .mockResolvedValueOnce(before)
    .mockResolvedValue({ ...before, branch: target.branch, oid: target.oid });
  return { git, execute, initial, state };
}

describe("ignored file overwrite guards (synthetic executor)", () => {
  it.each([true, false])("protects switch (local branch exists: %s) and fast-forward", async local => {
    const { git, execute, initial } = setup(local);
    await git.returnMain(initial, target, false);
    const commands = execute.mock.calls.map(([args]) => args);
    expect(commands.find(args => args[0] === "switch")).toEqual(local
      ? ["switch", "--no-overwrite-ignore", "--no-guess", target.branch]
      : ["switch", "--no-overwrite-ignore", "--track", "-c", target.branch, target.ref]);
    expect(commands.find(args => args.includes("merge"))).toEqual([
      "-c", "merge.autoStash=false", "merge", "--ff-only", "--no-overwrite-ignore", target.oid,
    ]);
  });

  it.each(["switch", "merge"] as const)("stops on %s refusal and retains an already saved stash", async failure => {
    const { git, execute, initial, state } = setup(true, failure, true);
    const onStash = vi.fn();
    await expect(git.returnMain(initial, target, true, undefined, onStash)).rejects.toThrow("stash 保留：saved-stash");
    expect(onStash).toHaveBeenCalledWith("saved-stash");
    expect(state).toHaveBeenCalledTimes(2);
    const commands = execute.mock.calls.map(([args]) => args);
    if (failure === "switch") expect(commands.some(args => args.includes("merge"))).toBe(false);
    expect(commands.some(args => args.includes("pop") || args.includes("drop") || args.includes("reset"))).toBe(false);
  });
});
