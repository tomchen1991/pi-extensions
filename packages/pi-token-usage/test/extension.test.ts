import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
vi.mock("@earendil-works/pi-coding-agent", () => ({ getAgentDir: () => { throw Error("Test must set explicit temporary output"); } }));
import extension from "../src/extension.js";
import type { ExtensionAPI, ExtensionContext, MessageEndEvent } from "@earendil-works/pi-coding-agent";

let root: string;
afterEach(async () => { vi.unstubAllEnvs(); if (root) await rm(root, { recursive: true, force: true }); });
async function setup() {
  root = await mkdtemp(join(tmpdir(), "token-extension-test-"));
  vi.stubEnv("PI_TOKEN_USAGE_DIR", join(root, "output"));
  let handler!: (event: MessageEndEvent, ctx: ExtensionContext) => Promise<unknown>;
  extension({ on: (name: string, callback: typeof handler) => { expect(name).toBe("message_end"); handler = callback; } } as unknown as ExtensionAPI);
  const notify = vi.fn();
  const ctx = { cwd: root, hasUI: true, ui: { notify } } as unknown as ExtensionContext;
  const message = { role: "assistant", provider: "synthetic", model: "fake", stopReason: "stop",
    usage: { input: 1, cacheRead: 2, cacheWrite: 3, output: 4 }, content: "DO_NOT_SAVE" };
  const event = { type: "message_end", message } as unknown as MessageEndEvent;
  return { handler, ctx, event, notify };
}
async function files() {
  return (await readdir(join(root, "output"), { recursive: true })).filter(file => file.endsWith(".json"));
}
it("does nothing at load; collects only new events, coalesces duplicate delivery", async () => {
  const { handler, ctx, event, notify } = await setup();
  expect(await readdir(root)).toEqual([]);
  await Promise.all([handler(event, ctx), handler(event, ctx)]);
  await handler(event, ctx);
  const saved = await files();
  expect(saved).toHaveLength(1);
  const text = await readFile(join(root, "output", saved[0]), "utf8");
  expect(text).not.toContain("DO_NOT_SAVE");
  expect(JSON.parse(text).tokens).toEqual({ cachedInput: 2, uncachedInput: 4, output: 4 });
  expect(notify).not.toHaveBeenCalled();
});
it("warns without sensitive errors, recovers from a failed write", async () => {
  const { handler, ctx, event, notify } = await setup();
  vi.stubEnv("PI_TOKEN_USAGE_DIR", join(root, "blocked"));
  await writeFile(join(root, "blocked"), "synthetic");
  await Promise.all([handler(event, ctx), handler(event, ctx)]);
  expect(notify).toHaveBeenCalledTimes(1);
  expect(notify.mock.calls[0][0]).toContain("TOKEN_USAGE_WRITE_FAILED");
  expect(notify.mock.calls[0][0]).not.toContain(root);
  vi.stubEnv("PI_TOKEN_USAGE_DIR", join(root, "output"));
  await handler(event, ctx);
  expect(await files()).toHaveLength(1);
});
it("ignores user messages and rejects relative output directories", async () => {
  const { handler, ctx, event, notify } = await setup();
  await handler({ ...event, message: { role: "user" } } as MessageEndEvent, ctx);
  expect(await readdir(root)).toEqual([]);
  vi.stubEnv("PI_TOKEN_USAGE_DIR", "relative");
  await handler(event, ctx);
  expect(notify).toHaveBeenCalledTimes(1);
  expect(await readdir(root)).toEqual([]);
});
