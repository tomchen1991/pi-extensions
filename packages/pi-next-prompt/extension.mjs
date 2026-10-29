import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, matchesKey, renderFakeCursor, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { SYSTEM_PROMPT, conversation, cleanSuggestion, SuggestionRequest } from "./core.mjs";

export default function (pi) {
  const request = new SuggestionRequest();
  let editor;
  let repaint = () => {};
  let suggestion = "";
  let context;
  let lastState = "已加载，等待 Agent 回复完成";
  function status(text, visible = false) {
    lastState = text;
    context?.ui.setStatus("next-prompt", visible ? `下一句：${text}` : undefined);
  }
  function clear() {
    request.cancel();
    suggestion = "";
    status("已取消或清除建议");
    repaint();
  }

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    context = ctx;
    ctx.ui.setEditorComponent((tui, theme, kb) => {
      repaint = () => tui.requestRender();
      editor = new class extends CustomEditor {
        handleInput(data) {
          if (suggestion && !this.getText() && matchesKey(data, "tab")) {
            const text = suggestion;
            clear();
            this.insertTextAtCursor(text);
            return;
          }
          // Any key dismisses/invalidate pending suggestions, including paste and history.
          clear();
          super.handleInput(data);
        }
        setText(text) {
          clear();
          super.setText(text);
        }
        render(width) {
          const lines = super.render(width);
          if (!suggestion || this.getText() || lines.length < 3 || width < 4) return lines;
          const padding = Math.min(this.getPaddingX(), Math.max(0, Math.floor((width - 1) / 2)));
          const available = width - padding * 2 - 1;
          const ghost = truncateToWidth(suggestion, available, "…");
          // Keep the real editor empty; Enter can never submit ghost text.
          lines[1] = " ".repeat(padding) + (this.focused ? CURSOR_MARKER : "")
            + (this.focused ? renderFakeCursor(" ") : " ") + ctx.ui.theme.fg("dim", ghost)
            + " ".repeat(Math.max(0, width - padding - 1 - visibleWidth(ghost)));
          return lines;
        }
      }(tui, theme, kb);
      return editor;
    });
  });

  function generate(ctx) {
    clear();
    if (ctx.mode !== "tui" || !editor) { status("编辑器未加载"); return; }
    const model = ctx.modelRegistry.find("deepseek", "deepseek-flash");
    if (!model) { status("未找到 deepseek/deepseek-flash，请检查 Pi 模型配置", true); return; }
    if (editor.getText()) { status("已有输入，跳过建议"); return; }
    if (!ctx.isIdle()) { status("Agent 仍在忙碌"); return; }
    const messages = conversation(ctx.sessionManager.getBranch());
    if (messages.at(-1)?.role !== "assistant") { status("没有可用的最终回复"); return; }
    status(`生成中 · ${model.id}`, true);
    // Fire and forget: do not hold up the idle lifecycle or run an agent/tool loop.
    void request.run(async signal => {
      const response = await ctx.modelRegistry.streamSimple(model, {
        systemPrompt: SYSTEM_PROMPT,
        messages: [{ role: "user", content: JSON.stringify(messages), timestamp: Date.now() }],
      }, { signal, maxTokens: 256, reasoning: "off" }).result();
      if (response.stopReason !== "stop") {
        throw new Error(response.errorMessage || `模型未生成完整建议：${response.stopReason}`);
      }
      return cleanSuggestion(response.content.filter(c => c.type === "text").map(c => c.text).join(""));
    }, text => {
      if (editor && !editor.getText() && ctx.isIdle()) {
        suggestion = text;
        status(text ? "建议就绪，Tab 接受" : "模型返回空建议", !text);
        repaint();
      } else {
        status("状态已变化，丢弃建议");
      }
    }, error => {
      status(cleanSuggestion(error instanceof Error ? error.message : String(error)), true);
    });
  }

  pi.on("agent_settled", (event, ctx) => {
    if (event.aborted) { clear(); return; }
    generate(ctx);
  });

  pi.registerCommand("next-prompt", {
    description: "手动生成下一句建议；/next-prompt status 查看插件状态",
    handler: async (args, ctx) => {
      if (args.trim() === "status") {
        ctx.ui.notify(`下一句插件：${lastState}；编辑器${editor ? "已加载" : "未加载"}`, "info");
      } else {
        generate(ctx);
      }
    },
  });

  for (const event of ["agent_start", "input", "model_select", "session_tree", "session_compact"]) {
    pi.on(event, () => { clear(); });
  }
  pi.on("session_shutdown", (_event, ctx) => {
    clear();
    if (ctx.mode === "tui") ctx.ui.setEditorComponent(undefined);
    editor = undefined;
    context = undefined;
    repaint = () => {};
  });
}
