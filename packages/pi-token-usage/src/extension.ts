import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isAbsolute, join } from "node:path";
import { createRecord, type Project } from "./record.js";
import { resolveProject } from "./project.js";
import { storeRecord } from "./storage.js";

export default function (pi: ExtensionAPI) {
  let project: Project | undefined;
  let cwd: string | undefined;
  // Only live events are observed. No historical session scan/replay on resume or fork.
  const pending = new WeakMap<object, Promise<void>>();

  pi.on("message_end", async (event, ctx) => {
    if (event.message.role !== "assistant") return;
    const previous = pending.get(event.message);
    if (previous) return previous;
    const completed = Date.now();
    // Snapshot relevant scalars before asynchronous project lookup or downstream mutations.
    const message = { role: event.message.role, provider: event.message.provider,
      model: event.message.model, stopReason: event.message.stopReason, usage: { ...event.message.usage } };
    const work = (async () => {
      const override = process.env.PI_TOKEN_USAGE_DIR;
      if (override !== undefined && !isAbsolute(override)) throw new Error("INVALID_OUTPUT_DIR");
      const root = override ?? join(getAgentDir(), "token-usage");
      if (!project || cwd !== ctx.cwd) {
        project = await resolveProject(ctx.cwd);
        cwd = ctx.cwd;
      }
      const record = createRecord(message, project, completed);
      if (record) await storeRecord(root, record);
    })().catch(() => {
      pending.delete(event.message);
      // Bounded diagnostics: no paths, message bodies, or raw filesystem/provider errors.
      const text = "pi-token-usage: collection failed; this response may be missing (TOKEN_USAGE_WRITE_FAILED)";
      if (ctx.hasUI) ctx.ui.notify(text, "warning");
      else process.stderr.write(`${text}\n`);
    });
    pending.set(event.message, work);
    await work;
  });
}
