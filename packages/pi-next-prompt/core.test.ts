import { describe, it, expect } from "vitest";
import { conversation, cleanSuggestion, SuggestionRequest } from "./core.mjs";

const entry = (role: string, content: unknown, stopReason = "stop") => ({
  type: "message", message: { role, content, stopReason },
});

describe("next prompt", () => {
  it("uses only user text and final assistant text on the supplied branch", () => {
    expect(conversation([
      entry("user", "帮我实现"),
      entry("assistant", [{ type: "text", text: "checking" }], "toolUse"),
      entry("toolResult", "secret tool output"),
      entry("assistant", [{ type: "thinking", thinking: "private" }, { type: "text", text: "完成" }]),
    ])).toEqual([{ role: "user", text: "帮我实现" }, { role: "assistant", text: "完成" }]);
  });
  it("bounds history and strips terminal control characters", () => {
    expect(conversation(Array.from({ length: 20 }, () => entry("user", "x".repeat(7000))))).toHaveLength(12);
    expect(conversation([entry("user", "x".repeat(7000))])[0].text).toHaveLength(6000);
    expect(cleanSuggestion('“补充\n测试”')).toBe("补充 测试");
    expect(cleanSuggestion("a\x1bb\x07c")).toBe("a b c");
  });
  it("discards late results after typing or session changes", async () => {
    const request = new SuggestionRequest();
    let resolve!: (text: string) => void;
    let result = "";
    const task = request.run(() => new Promise(r => { resolve = r; }), text => { result = text; });
    request.cancel();
    resolve("stale");
    await task;
    expect(result).toBe("");
  });
  it("only applies the newest request and ignores failures", async () => {
    const request = new SuggestionRequest();
    let resolve!: (text: string) => void;
    const results: string[] = [];
    const old = request.run(() => new Promise(r => { resolve = r; }), t => results.push(t));
    await request.run(async () => "new", t => results.push(t));
    resolve("old");
    await old;
    await request.run(async () => { throw Error("offline"); }, t => results.push(t));
    expect(results).toEqual(["new"]);
  });
});
