import { randomUUID } from "node:crypto";
import { VERSION, type ExtensionAPI, type ExtensionContext, type ExtensionEvent } from "@earendil-works/pi-coding-agent";
import { readConfig } from "./config.js";
import { Observer, type Identity } from "./observer.js";
import { Transport } from "./transport.js";

type ProcessState = Identity & { paused: boolean };
const identityKey = Symbol.for("pi-monitor.process.v1");
function processState(): ProcessState {
  const shared = process as unknown as Record<symbol, ProcessState>;
  return shared[identityKey] ??= { instanceId: randomUUID(), processStartedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(), paused: false };
}

export default function monitor(pi: ExtensionAPI): void {
  let observer: Observer | undefined;
  let transport: Transport | undefined;
  let lastError: string | null = null;
  let generation = 0;
  pi.registerFlag("monitor", { description: "Enable configured Pi metadata telemetry (no message content)", type: "boolean", default: false });

  async function stop(reason: Parameters<Observer["stop"]>[0]): Promise<void> {
    generation++;
    const oldObserver = observer, oldTransport = transport;
    observer = undefined;
    transport = undefined;
    oldObserver?.stop(reason);
    await oldTransport?.stop();
  }
  async function start(ctx: ExtensionContext): Promise<void> {
    const expected = generation + 1;
    await stop("replaced");
    if (expected !== generation) return;
    try {
      const config = readConfig();
      const identity = processState();
      let sender: Transport;
      const collector = new Observer(config.deviceId, config.projectId, identity, ctx, VERSION,
        event => sender.enqueue(event), () => sender.changed());
      sender = new Transport(config, collector.source, collector.epoch, () => collector.snapshot());
      observer = collector;
      transport = sender;
      lastError = null;
      collector.start();
      sender.start();
    } catch (error) {
      // Only our fixed configuration codes may reach UI. No endpoint, credential, or raw exception.
      const code = error instanceof Error ? error.message : "";
      lastError = /^monitor_[a-z_]+$/.test(code) ? code : "monitor_start_failed";
    }
  }
  pi.on("session_start", async (_event, ctx) => {
    if (!processState().paused && (pi.getFlag("monitor") === true || process.env.PI_MONITOR_ENABLED === "1")) await start(ctx);
  });
  pi.on("session_shutdown", event => stop(event.reason));
  pi.registerCommand("monitor", {
    description: "Pi telemetry: status | enable | disable (no persistent configuration changes)",
    handler: async (args, ctx) => {
      switch (args.trim() || "status") {
        case "enable":
          processState().paused = false;
          if (!observer) await start(ctx);
          break;
        case "disable":
          processState().paused = true;
          await stop("disabled");
          break;
        case "status": break;
        default:
          if (ctx.hasUI) ctx.ui.notify("Usage: /monitor status|enable|disable", "info");
          return;
      }
      if (ctx.hasUI) ctx.ui.notify(JSON.stringify({ enabled: !!observer, error: lastError, ...(transport?.health() ?? {}) }), lastError ? "warning" : "info");
    },
  });

  // No input/context/provider payload hooks, no message_update or tool_execution_update subscription.
  // Handlers never modify the agent or return actionable results.
  const observe = (event: ExtensionEvent, ctx: ExtensionContext): void => {
    try { observer?.handle(event, ctx); }
    catch { lastError = "monitor_observation_failed"; transport?.observationFailed(); }
  };
  pi.on("model_select", observe);
  pi.on("thinking_level_select", observe);
  pi.on("agent_start", observe);
  pi.on("message_start", observe);
  pi.on("message_end", observe);
  pi.on("agent_before_settle", observe);
  pi.on("agent_settled", observe);
  pi.on("tool_execution_start", observe);
  pi.on("tool_execution_end", observe);
  pi.on("ui_prompt_start", observe);
  pi.on("ui_prompt_end", observe);
  pi.on("session_before_compact", observe);
  pi.on("session_compact", observe);
  pi.on("session_compact_failed", observe);
  pi.on("session_tree", observe);
}
