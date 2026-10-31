import { afterEach, beforeEach, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({ instances: [] as any[], holdStop: undefined as undefined | (() => Promise<void>) }));
vi.mock("@earendil-works/pi-coding-agent", () => ({ VERSION: "1.4.0" }));
vi.mock("../src/transport.js", () => ({ Transport: class {
  events: any[] = [];
  started = false;
  stopped = false;
  failures = 0;
  constructor(...args: any[]) { fake.instances.push(this); }
  enqueue(event: unknown) { this.events.push(event); }
  changed() {}
  observationFailed() { this.failures++; }
  start() { this.started = true; }
  async stop() { if (fake.holdStop) await fake.holdStop(); this.stopped = true; }
  health() { return { connection: this.stopped ? "stopped" : "connected", rejectedEvents: this.failures }; }
} }));
import extension from "../src/extension.js";

function setup() {
  const handlers = new Map<string, Function>();
  const commands = new Map<string, any>();
  const flags = new Map<string, unknown>();
  const api = { on: (name: string, handler: Function) => handlers.set(name, handler),
    registerFlag: (name: string, config: any) => flags.set(name, config.default), getFlag: (name: string) => flags.get(name),
    registerCommand: (name: string, command: any) => commands.set(name, command) };
  extension(api as any);
  const ctx = { sessionManager: { getSessionId: () => "synthetic-session" }, mode: "tui", model: undefined,
    isIdle: () => true, hasUI: true, ui: { notify: vi.fn() } };
  return { ctx, flags, handlers, emit: (name: string, event: object = {}) => handlers.get(name)?.({ type: name, ...event }, ctx),
    command: (args: string) => commands.get("monitor").handler(args, ctx) };
}
beforeEach(() => {
  fake.instances.length = 0;
  fake.holdStop = undefined;
  delete (process as any)[Symbol.for("pi-monitor.process.v1")];
  vi.stubEnv("PI_MONITOR_ENABLED", "");
  vi.stubEnv("PI_MONITOR_URL", "ws://127.0.0.1:12345/ingest");
  vi.stubEnv("PI_MONITOR_TOKEN", "synthetic-token");
  vi.stubEnv("PI_MONITOR_DEVICE_ID", "synthetic-device");
  vi.stubEnv("PI_MONITOR_PROJECT_ID", "");
});
afterEach(() => { vi.unstubAllEnvs(); delete (process as any)[Symbol.for("pi-monitor.process.v1")]; });

it("does not allocate a transport in the factory or disabled session and subscribes to no content stream hooks", async () => {
  const { emit, handlers, command } = setup();
  expect(fake.instances).toHaveLength(0);
  await emit("session_start");
  expect(fake.instances).toHaveLength(0);
  for (const forbidden of ["input", "context", "before_provider_request", "provider_stream_event", "message_update", "tool_execution_update"]) expect(handlers.has(forbidden)).toBe(false);
  await command("enable");
  await command("enable");
  expect(fake.instances).toHaveLength(1);
  expect(emit("agent_start")).toBeUndefined();
  await emit("session_shutdown", { reason: "quit" });
  expect(fake.instances[0].stopped).toBe(true);
});

it("keeps disable across replacement and creates fresh epochs without copying historical usage", async () => {
  const { emit, command } = setup();
  vi.stubEnv("PI_MONITOR_ENABLED", "1");
  await emit("session_start");
  const first = fake.instances[0].events[0];
  await emit("session_shutdown", { reason: "resume" });
  await emit("session_start");
  const second = fake.instances[1].events[0];
  expect(second.collectorEpoch).not.toBe(first.collectorEpoch);
  expect(second.source.instanceId).toBe(first.source.instanceId);
  expect(second.data.state.usage.totalTokens).toBe(0);
  await command("disable");
  await emit("session_start");
  expect(fake.instances).toHaveLength(2);
});

it("does not resurrect a transport when shutdown races a delayed restart", async () => {
  const { emit, flags } = setup();
  flags.set("monitor", true);
  await emit("session_start");
  let release!: () => void;
  fake.holdStop = () => new Promise<void>(resolve => { release = resolve; });
  const restarting = emit("session_start");
  await emit("session_shutdown", { reason: "quit" });
  release();
  await restarting;
  expect(fake.instances).toHaveLength(1);
  expect(fake.instances[0].stopped).toBe(true);
});

it("reports only fixed configuration errors, keeps SDK handler failures out of the main run", async () => {
  const { emit, command, ctx } = setup();
  vi.stubEnv("PI_MONITOR_URL", "SECRET_BAD_ENDPOINT");
  await command("enable");
  expect(fake.instances).toHaveLength(0);
  expect(JSON.stringify(ctx.ui.notify.mock.calls)).not.toContain("SECRET_BAD_ENDPOINT");
  expect(JSON.stringify(ctx.ui.notify.mock.calls)).toContain("monitor_invalid_url");
  vi.stubEnv("PI_MONITOR_URL", "ws://127.0.0.1:12345/ingest");
  await command("enable");
  expect(() => emit("message_end", { message: null })).not.toThrow();
  expect(fake.instances[0].failures).toBe(1);
  await emit("session_shutdown", { reason: "quit" });
});
