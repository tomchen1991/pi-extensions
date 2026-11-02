// Synthetic provider for CLI smoke only; never contacts a model service.
export default function (pi) {
  globalThis.fetch = async () => { throw Error("Unexpected fetch in offline monitor CLI smoke"); };
  pi.registerCommand("monitor-test-reload", { description: "Test-only reload", handler: async (_args, ctx) => { await ctx.reload(); } });
  pi.registerCommand("monitor-test-quit", { description: "Test-only shutdown", handler: async (_args, ctx) => { ctx.shutdown(); } });
  pi.registerProvider("monitor-offline", {
    baseUrl: "https://offline.invalid", apiKey: "synthetic", api: "monitor-offline-api",
    models: [{ id: "fixture", name: "Fixture", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 4096 }],
    streamSimple(model) {
      const text = "SECRET_CLI_REPLY";
      const message = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
        content: [{ type: "text", text }], stopReason: "stop", timestamp: Date.now(),
        usage: { input: 3, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 5,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      return { result: async () => message, async *[Symbol.asyncIterator]() {
        yield { type: "start", partial: message };
        yield { type: "text_start", contentIndex: 0, partial: message };
        yield { type: "text_delta", contentIndex: 0, delta: text, partial: message };
        yield { type: "text_end", contentIndex: 0, content: text, partial: message };
        yield { type: "done", reason: "stop", message };
      } };
    },
  });
}
