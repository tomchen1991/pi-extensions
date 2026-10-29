// Run with PI_SDK_DIR pointing at an installed pi-coding-agent package.
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import path from "node:path";
const base = process.env.PI_SDK_DIR;
if (!base) throw Error("Set PI_SDK_DIR to your installed pi-coding-agent package");
const { loadExtensions } = await import(pathToFileURL(path.join(base, "dist/core/extensions/loader.js")));
const loaded = await loadExtensions([new URL("./extension.mjs", import.meta.url).pathname], process.cwd());
assert.deepEqual(loaded.errors, []);
const handlers = loaded.extensions[0].handlers;
const emit = async (name, event = {}) => {
  for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
};
let editor;
let calls = 0;
let lastStatus;
const ctx = {
  mode: "tui", model: { id: "fake" }, isIdle: () => true,
  ui: {
    theme: { fg: (_color, text) => text },
    setStatus(_key, value) { lastStatus = value; },
    notify() {},
    setEditorComponent(factory) {
      if (!factory) return;
      editor = factory({ requestRender() {}, terminal: { rows: 40, columns: 80 } },
        { borderColor: text => text, selectList: {} }, { matches: () => false });
    },
  },
  sessionManager: { getBranch: () => [
    { type: "message", message: { role: "user", content: "实现功能" } },
    { type: "message", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "完成" }] } },
  ] },
  modelRegistry: {
    find(provider, id) {
      assert.equal(provider, "deepseek");
      assert.equal(id, "deepseek-flash");
      return { provider, id };
    },
    streamSimple(model, context, options) {
    assert.equal(model.provider, "deepseek");
    assert.equal(model.id, "deepseek-flash");
    assert.equal(options.reasoning, "off");
    calls++;
    assert.equal(context.tools, undefined);
    return { result: async () => ({ stopReason: "stop", content: [{ type: "text", text: "补充测试 🙂" }] }) };
  } },
};
await emit("session_start");
editor.focused = true;
await emit("agent_settled");
await new Promise(resolve => setImmediate(resolve));
assert.equal(editor.getText(), "");
assert.ok(editor.render(80).join("\n").includes("补充测试"));
for (const width of [4, 8, 20, 80]) editor.render(width);
editor.handleInput("\t");
assert.equal(editor.getText(), "补充测试 🙂");
editor.setText("");
await emit("agent_settled");
await new Promise(resolve => setImmediate(resolve));
editor.handleInput("x");
assert.equal(editor.getText(), "x");
assert.ok(!editor.render(80).join("\n").includes("补充测试"));
editor.setText("");
assert.ok(!editor.render(80).join("\n").includes("补充测试"));
await emit("agent_settled", { aborted: true });
assert.equal(calls, 2);
assert.deepEqual(ctx.model, { id: "fake" }); // Main conversation model is unchanged.
ctx.modelRegistry.streamSimple = () => ({ result: async () => ({ stopReason: "error", errorMessage: "test provider unavailable", content: [] }) });
await emit("agent_settled");
await new Promise(resolve => setImmediate(resolve));
assert.ok(lastStatus.includes("test provider unavailable"));
assert.equal(editor.getText(), "");
await emit("session_shutdown");
console.log("SDK smoke passed: load, ghost render, Tab accept, typing dismissal, abort, cleanup");
