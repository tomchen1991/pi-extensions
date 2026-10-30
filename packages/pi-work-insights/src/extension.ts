import path from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildObservation, observationId, type Metadata } from "./contract.js";
import { DEBOUNCE_MS, destinationFor } from "./config.js";
import { extract } from "./extractor.js";
import { digest, projectRoot } from "./identity.js";
import { observationInput } from "./observation-input.js";
import { ObservationStore } from "./storage.js";

const HELP = "/insights enable 开启自动观察 · status 状态/输出目录 · extract 立即提取 · pause 暂停 · forget 清除本项目输出 · cancel 取消本次任务";
const ERRORS: Record<string, string> = {
  NOT_AUTHORIZED: "授权已变化，结果已丢弃", STORE_LOCKED: "输出目录正忙（崩溃遗留锁需停用实例后手动清理）",
  STORAGE_LIMIT: "输出达到容量上限，请先清理", REQUEST_TIMEOUT: "提取超时，本次未输出",
  LATEST_UPDATE_FAILED: "JSON 已保存，但最新指针更新失败；请检查文件，相同输入重试不会重复调用模型",
  INCOMPLETE_RESPONSE: "模型未完整返回，本次未输出", DESTINATION_CHANGED: "模型配置已变化，请重新 /insights enable 授权",
  MODEL_UNAVAILABLE: "授权模型不可用，请检查 Pi 配置", CONSENT_REQUIRED: "尚未授权自动提取",
};

export default function (pi: ExtensionAPI) {
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active: AbortController | undefined;
  let lastState = "尚未开启自动观察";
  let lastFile: string | undefined;
  const cancel = () => {
    generation++;
    clearTimeout(timer); timer = undefined;
    active?.abort(); active = undefined;
  };
  const status = (ctx: ExtensionContext, text: string, visible = true) => {
    lastState = text;
    ctx.ui.setStatus("work-insights", visible ? `工作洞察：${text}` : undefined);
  };
  const idle = (ctx: ExtensionContext) => ctx.mode === "tui" && ctx.isIdle() && !ctx.hasPendingMessages() && !ctx.ui.getEditorText().trim();
  const errorStatus = (ctx: ExtensionContext, error: unknown) => {
    // Never echo raw provider errors, invalid JSON, conversation fragments or credentials.
    status(ctx, ERRORS[error instanceof Error ? error.message : ""] ?? "提取未完成：请检查模型配置、输出格式或本地文件；未保存当前结果");
  };
  const storeFor = (root: string) => new ObservationStore(process.env.PI_WORK_INSIGHTS_DIR || path.join(getAgentDir(), "work-insights"), root);
  const configuredDestination = (ctx: ExtensionContext, model: NonNullable<ExtensionContext["model"]>) =>
    destinationFor(model, ctx.modelRegistry.getRegisteredProviderConfig(model.provider));

  function schedule(ctx: ExtensionContext, delay = DEBOUNCE_MS) {
    if (ctx.mode !== "tui" || timer || active) return;
    const expected = generation;
    timer = setTimeout(() => { timer = undefined; void run(ctx, expected); }, delay);
  }

  async function run(ctx: ExtensionContext, expected: number) {
    if (expected !== generation || active || !idle(ctx)) return;
    const controller = active = new AbortController();
    const sessionId = ctx.sessionManager.getSessionId();
    const leaf = ctx.sessionManager.getLeafId();
    let retryAfter: number | undefined;
    const valid = () => expected === generation && active === controller && !controller.signal.aborted && idle(ctx) &&
      ctx.sessionManager.getSessionId() === sessionId && ctx.sessionManager.getLeafId() === leaf;
    try {
      if (!leaf) return;
      const root = await projectRoot(ctx.cwd);
      if (!valid()) return;
      const store = storeFor(root);
      const settings = store.settings();
      if (!settings.enabled || !settings.destination) { status(ctx, "尚未开启或已暂停", false); return; }
      const destination = settings.destination;
      // Pin the extraction model chosen at enable time, independently of the main agent's model.
      const model = ctx.modelRegistry.find(destination.provider, destination.model);
      if (!model) throw new Error("MODEL_UNAVAILABLE");
      if (configuredDestination(ctx, model).fingerprint !== destination.fingerprint) throw new Error("DESTINATION_CHANGED");
      const input = observationInput(ctx.sessionManager.getBranch(), leaf);
      if (!input.entries.length) { status(ctx, "没有可安全提取的文本", false); return; }
      const metadata: Metadata = {
        source: {
          producer: "pi-work-insights", projectRef: store.projectRef,
          sessionRef: digest([store.projectRef, sessionId, ctx.sessionManager.getSessionFile() ?? null]),
          branchRef: leaf, observedAt: new Date().toISOString(), inputDigest: input.inputDigest,
          entryRefs: input.entries.map(e => e.entryId), coverage: input.coverage, omissionReasons: input.omissionReasons,
        },
        extraction: { provider: model.provider, model: model.id, extractorVersion: "work-observation-v1",
          destinationRef: destination.fingerprint, inputTokens: 0, outputTokens: 0 },
      };
      const id = observationId(metadata);
      const reservation = store.reserve(id, settings.revision, destination.fingerprint);
      if (reservation.status === "exists") { lastFile = store.file(id); status(ctx, "当前内容已有 JSON", false); return; }
      if (reservation.status === "wait") {
        retryAfter = reservation.delay;
        status(ctx, "等待提取间隔/每小时预算", false); return;
      }
      status(ctx, "自动提取中");
      const result = await extract(ctx.modelRegistry, model, input, controller.signal);
      if (!valid()) return;
      // Provider configuration can change without a model_select event.
      const currentModel = ctx.modelRegistry.find(destination.provider, destination.model);
      if (!currentModel || configuredDestination(ctx, currentModel).fingerprint !== destination.fingerprint) throw new Error("DESTINATION_CHANGED");
      metadata.extraction.inputTokens = result.usage.input;
      metadata.extraction.outputTokens = result.usage.output;
      const observation = buildObservation(result.raw, input.entries, metadata);
      store.publish(observation, settings.revision, reservation.token);
      lastFile = store.file(id);
      status(ctx, `已输出 JSON · 本次 ${result.usage.totalTokens} tokens`);
    } catch (error) {
      if (valid()) errorStatus(ctx, error);
    } finally {
      if (active === controller) {
        active = undefined;
        if (expected === generation && retryAfter !== undefined && !controller.signal.aborted) schedule(ctx, retryAfter);
      }
    }
  }

  const invalidate = (_event: unknown, ctx: ExtensionContext) => {
    cancel();
    if (ctx.mode === "tui") status(ctx, "等待下一次空闲", false);
  };
  pi.on("input", invalidate);
  pi.on("before_agent_start", invalidate);
  pi.on("agent_start", invalidate);
  pi.on("model_select", invalidate);
  pi.on("session_compact", invalidate);
  pi.on("session_tree", (event, ctx) => { invalidate(event, ctx); schedule(ctx); });
  pi.on("session_shutdown", (event, ctx) => { invalidate(event, ctx); lastFile = undefined; });
  pi.on("session_start", (event, ctx) => { invalidate(event, ctx); lastFile = undefined; schedule(ctx); });
  pi.on("agent_settled", (event, ctx) => {
    if (event.aborted) { invalidate(event, ctx); return; }
    // Notification handler returns immediately. No message injection, continuation, or agent loop.
    schedule(ctx);
  });

  pi.registerCommand("insights", {
    description: "自动输出最近工作、决策、未闭环事项与偏好线索 JSON（首次须授权）",
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") { ctx.ui.notify("工作洞察首版仅支持 TUI；其他模式不采集、不调用模型", "warning"); return; }
      const action = args.trim() || "status";
      // A status query must not cancel (and waste) an in-flight paid request.
      if (action === "status") {
        const expected = generation;
        try {
          const root = await projectRoot(ctx.cwd);
          if (expected !== generation) return;
          const store = storeFor(root);
          const settings = store.settings();
          const latest = store.latest();
          ctx.ui.notify(`工作洞察：${settings.enabled ? "自动模式" : "未开启/已暂停"}\n项目：${root}\n` +
            `模型：${settings.destination ? `${settings.destination.provider}/${settings.destination.model}` : "未授权"}\n` +
            `输出：${store.outputDirectory}\n最新入口：${store.latestFile}\n` +
            `${latest ? `项目最新观察：${latest.observedAt}\n文件：${path.join(store.directory, latest.file)}\n` : "尚无成功输出\n"}` +
            `状态：${lastState}${lastFile ? `\n本会话文件：${lastFile}` : ""}\n` +
            "空闲10秒提取；请求间隔至少2分钟、每项目每滚动小时最多6次。只输出未审核观察 JSON。", "info");
        } catch { if (expected === generation) ctx.ui.notify("无法读取工作洞察状态，请检查目录与配置", "error"); }
        return;
      }
      cancel();
      ctx.ui.setStatus("work-insights", undefined);
      if (action === "cancel") { status(ctx, "本次任务已取消；长期停用请用 pause", false); return; }
      if (!["enable", "extract", "pause", "forget"].includes(action)) { ctx.ui.notify(HELP, "info"); return; }
      if (action === "extract") {
        const expected = generation;
        if (!idle(ctx)) { ctx.ui.notify("请等主任务结束并清空输入框后再提取", "warning"); return; }
        await run(ctx, expected);
        if (expected === generation) ctx.ui.notify(`${lastState}${lastFile ? `\n${lastFile}` : ""}`, "info");
        return;
      }
      const controller = active = new AbortController();
      const expected = generation;
      const sessionId = ctx.sessionManager.getSessionId();
      const valid = () => active === controller && expected === generation && !controller.signal.aborted && ctx.sessionManager.getSessionId() === sessionId;
      let restart = false;
      try {
        const root = await projectRoot(ctx.cwd);
        if (!valid()) return;
        const store = storeFor(root);
        if (action === "pause") {
          store.pause(); status(ctx, "已暂停", false);
        } else if (action === "forget") {
          if (await ctx.ui.confirm("清除本项目观察 JSON？", "删除本插件的工作观察输出并暂停。不会删除 Pi 原会话，也不能撤回已发送的模型请求。", { signal: controller.signal })) {
            if (!valid()) return;
            store.forget(); lastFile = undefined; status(ctx, "已清除并暂停", false);
          }
        } else {
          if (!idle(ctx) || !ctx.model) throw new Error("MODEL_UNAVAILABLE");
          const destination = configuredDestination(ctx, ctx.model);
          const approved = await ctx.ui.confirm("开启本项目自动工作观察？",
            `项目：${root}\n固定提取模型：${destination.provider}/${destination.model}\n配置端点：${destination.endpoint}（实际路由和认证由 Pi 管理）\n` +
            "会在空闲后发送当前分支最近最多30条、16000字符的过滤文本，包含用户/助手文本及极少量测试计数。过滤不能识别全部秘密。\n" +
            "每次最多4096输出 tokens；至少间隔2分钟，每项目每小时最多6次。失败/取消也占请求额度，可能收费。\n" +
            "自动保存工作内容、决策、未闭环事项、偏好线索和短原话，不再逐条确认。不会生成画像、给出建议、上传 backend 或修改主会话。\n" +
            `输出目录：${store.outputDirectory}\n授权在本项目跨会话生效；/insights pause 停止。`, { signal: controller.signal });
          if (!approved || !valid()) return;
          if (!ctx.model || configuredDestination(ctx, ctx.model).fingerprint !== destination.fingerprint) throw new Error("DESTINATION_CHANGED");
          store.authorize(destination, true);
          status(ctx, "已开启，空闲后自动输出 JSON"); restart = true;
        }
      } catch (error) {
        if (valid()) { errorStatus(ctx, error); ctx.ui.notify(lastState, "error"); }
      } finally {
        if (active === controller) { active = undefined; if (restart && expected === generation) schedule(ctx); }
      }
    },
  });
}
