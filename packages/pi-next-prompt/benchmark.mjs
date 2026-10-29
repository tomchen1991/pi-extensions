// Opt-in live benchmark. Uses your selected model and credentials; incurs API usage.
// PI_SDK_DIR=... PI_PROVIDER=... PI_MODEL=... PI_SESSION_FILE=... node .../benchmark.mjs
import { pathToFileURL } from "node:url";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { SYSTEM_PROMPT, conversation } from "./core.mjs";
const base = process.env.PI_SDK_DIR;
if (!base) throw Error("Set PI_SDK_DIR");
const load = file => import(pathToFileURL(path.join(base, file)));
const { configureHttpDispatcher } = await load("dist/core/http-dispatcher.js");
configureHttpDispatcher();
const { ModelRuntime } = await load("dist/core/model-runtime.js");
const { SessionManager } = await load("dist/core/session-manager.js");
const runtime = await ModelRuntime.create();
const model = runtime.getModel(process.env.PI_PROVIDER, process.env.PI_MODEL);
if (!model) throw Error("Selected model not found");
const branch = SessionManager.open(process.env.PI_SESSION_FILE).getBranch();
const full = conversation(branch);
const compact = full.slice(-4).map(m => ({ ...m, text: m.text.slice(-1500) }));
const originalFetch = globalThis.fetch;
let timing;
globalThis.fetch = async (...args) => {
  const t = timing;
  if (t) {
    t.fetchStartMs ??= Math.round(performance.now() - t.start);
    t.fetches++;
    try { t.reasoning = JSON.parse(args[1]?.body).reasoning; } catch {}
  }
  const response = await originalFetch(...args);
  if (t) t.headersMs = Math.round(performance.now() - t.start);
  return response;
};
console.log(JSON.stringify({ model: model.id, thinkingLevelMap: model.thinkingLevelMap }));
const sessionId = randomUUID();
for (const [label, messages, extra] of [["sse", compact, { transport: "sse" }], ["reuse-1", compact, { sessionId }], ["reuse-2", compact, { sessionId }]]) {
  const input = JSON.stringify(messages);
  timing = { start: performance.now(), label, inputChars: input.length, fetches: 0 };
  const stream = runtime.streamSimple(model, {
    systemPrompt: SYSTEM_PROMPT,
    messages: [{ role: "user", content: input, timestamp: Date.now() }],
  }, { signal: AbortSignal.timeout(30000), maxTokens: 128, reasoning: "off", ...extra,
    onPayload(body) { timing.payloadMs = Math.round(performance.now() - timing.start); timing.reasoning = body.reasoning; },
  });
  for await (const event of stream) {
    if (event.type === "start") timing.streamStartMs = Math.round(performance.now() - timing.start);
    if (event.type === "text_delta") timing.firstTextMs ??= Math.round(performance.now() - timing.start);
  }
  const result = await stream.result();
  timing.totalMs = Math.round(performance.now() - timing.start);
  const { start, ...metrics } = timing;
  console.log(JSON.stringify({ ...metrics, stopReason: result.stopReason, error: result.errorMessage,
    usage: result.usage, outputChars: result.content.filter(c => c.type === "text").map(c => c.text).join("").length }));
  timing = undefined;
}
process.exit(0); // SDK websocket idle timers otherwise keep this standalone benchmark alive.
