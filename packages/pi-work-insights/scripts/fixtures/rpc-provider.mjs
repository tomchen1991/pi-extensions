// Synthetic, in-process provider for the offline RPC smoke ONLY. No credentials or network.
export default function (pi) {
  pi.registerProvider("insights-offline", {
    baseUrl: "https://offline.invalid", apiKey: "synthetic-not-a-secret", api: "insights-offline-api",
    models: [{ id: "fixture", name: "Offline fixture", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 4096 }],
    streamSimple(model) {
      const text = JSON.stringify({ recentWork: [], decisions: [], openLoops: [], preferenceSignals: [], evidence: [] });
      const message = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
        content: [{ type: "text", text }], stopReason: "stop", timestamp: Date.now(),
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      return {
        result: async () => message,
        async *[Symbol.asyncIterator]() {
          yield { type: "start", partial: message };
          yield { type: "text_start", contentIndex: 0, partial: message };
          yield { type: "text_delta", contentIndex: 0, delta: text, partial: message };
          yield { type: "text_end", contentIndex: 0, content: text, partial: message };
          yield { type: "done", reason: "stop", message };
        },
      };
    },
  });
}
