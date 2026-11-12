import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { projectFromPath, type Project } from "./record.js";

const exec = promisify(execFile);

export async function resolveProject(cwd: string): Promise<Project> {
  const canonical = await realpath(resolve(cwd));
  let root = canonical;
  try {
    const { stdout } = await exec("git", ["-C", canonical, "rev-parse", "--show-toplevel"], {
      timeout: 3000, maxBuffer: 64 * 1024, encoding: "utf8",
      // Do not let inherited Git overrides silently attribute to another repository.
      env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
    });
    root = await realpath(stdout.trim());
  } catch {
    // Non-Git directories and unavailable Git use the canonical working directory.
  }
  return projectFromPath(root);
}
