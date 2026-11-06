import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { hasExhaustedQuotaHeaders, hasQuotaCode, isQuotaError } from "./quota.js";

const STATE = "pi-model-fallback";

/** Loading this package opts into paid fallback; it never installs or changes settings. */
export default function modelFallback(pi: ExtensionAPI) {
  let quotaEvidence = false;
  let enabled = true;
  let switching = false;

  function notify(ctx: ExtensionContext, message: string, kind: "info" | "warning" = "warning") {
    if (ctx.hasUI) ctx.ui.notify(message, kind);
  }

  function restore(ctx: ExtensionContext) {
    enabled = true;
    quotaEvidence = false;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === STATE &&
          typeof entry.data === "object" && entry.data !== null &&
          "enabled" in entry.data && typeof entry.data.enabled === "boolean") {
        enabled = entry.data.enabled;
      }
    }
  }
  pi.on("session_start", (_event, ctx) => restore(ctx));
  pi.on("session_tree", (_event, ctx) => restore(ctx));
  pi.on("session_shutdown", () => { quotaEvidence = false; enabled = false; });
  // Evidence is request-local: never reuse an earlier response's quota headers.
  pi.on("turn_start", () => { quotaEvidence = false; });
  pi.on("model_select", () => { quotaEvidence = false; });
  pi.on("after_provider_response", (event, ctx) => {
    if (ctx.model?.provider === "openai-codex" && event.status >= 400) {
      quotaEvidence ||= hasExhaustedQuotaHeaders(event.headers);
    }
  });
  pi.on("provider_stream_event", (event) => {
    if (event.provider === "openai-codex") quotaEvidence ||= hasQuotaCode(event.data);
  });

  pi.on("agent_before_settle", async (event, ctx) => {
    if (!enabled || switching || event.outcome !== "error" || ctx.signal?.aborted) return;
    // State-only entries may follow the assistant; locate the last actual message.
    const contributions = event.context.contextEntries.filter(entry => entry.messages.length > 0);
    const last = contributions.at(-1);
    const message = last?.messages.at(-1);
    if (!last || !message || message.role !== "assistant" || message.stopReason !== "error" ||
        message.provider !== "openai-codex" || ctx.model?.provider !== "openai-codex" ||
        ctx.model.id !== message.model) return;
    const evidence = quotaEvidence || isQuotaError(message.errorMessage);
    quotaEvidence = false;
    if (!evidence) {
      if (/usage limit/i.test(message.errorMessage ?? "")) {
        notify(ctx, "Codex 返回的 usage limit 信息不足以区分额度耗尽和普通限流；未自动切换付费 API。");
      }
      return;
    }
    // Never guess model aliases, strip suffixes, or silently downgrade.
    const target = ctx.modelRegistry.find("openai", message.model);
    if (!target) {
      notify(ctx, "Codex 额度耗尽，但 OpenAI API 目录没有同 ID 模型；未切换。");
      return;
    }
    // Respect the user's official-API-only boundary, including models.json overrides.
    try {
      const auth = await ctx.modelRegistry.getProviderAuth("openai");
      const endpoint = new URL(auth?.auth.baseUrl ?? target.baseUrl ?? "");
      if (endpoint.origin !== "https://api.openai.com" || endpoint.username || endpoint.password) {
        notify(ctx, "OpenAI 模型并非官方 API 地址；未自动切换。");
        return;
      }
    } catch {
      notify(ctx, "无法验证 OpenAI 官方 API 配置；未自动切换。");
      return;
    }
    if (!enabled || ctx.signal?.aborted) return;
    // A context-only continuation must have something to answer after omitting
    // the failed message. Preserve tool results and the original user input.
    const remaining = event.context.llmMessages.slice(0, -1);
    if (!remaining.some(m => m.role !== "system") || remaining.at(-1)?.role === "assistant") return;
    switching = true;
    try {
      const thinking = pi.getThinkingLevel();
      if (!await pi.setModel(target)) {
        notify(ctx, "OpenAI API 认证不可用；未切换，请检查 Pi 的 OpenAI 配置。");
        return;
      }
      pi.setThinkingLevel(thinking);
      notify(ctx, "Codex 额度耗尽，已切换到 OpenAI API 同模型；当前会话后续按 API 计费。", "info");
      // Context edits retain the original append-only error for inspection, but
      // omit it from future model context. No replay of the user's prompt/tools.
      return {
        entries: [...event.entries, { type: "context_edit" as const, targetId: last.sourceEntry.id, replacement: null }],
        continue: !ctx.signal?.aborted,
      };
    } catch {
      // Never expose credential resolver errors (they may contain secrets).
      notify(ctx, "OpenAI API 切换失败；已停止自动续接，请检查配置。");
    } finally {
      switching = false;
    }
  });

  pi.registerCommand("model-fallback", {
    description: "Codex quota fallback: status | enable | disable (current session)",
    handler: async (args, ctx) => {
      const action = args.trim() || "status";
      if (action === "enable" || action === "disable") {
        enabled = action === "enable";
        quotaEvidence = false;
        pi.appendEntry(STATE, { enabled });
      } else if (action !== "status") {
        notify(ctx, "用法：/model-fallback status|enable|disable");
        return;
      }
      notify(ctx, `额度自动切换：${enabled ? "开启（可能产生 API 费用）" : "关闭"}；仅作用于当前会话。`, "info");
    },
  });
}
