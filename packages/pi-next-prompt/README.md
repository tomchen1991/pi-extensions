# 下一句自动建议

Agent 完成回复后，固定调用 `deepseek/deepseek-flash`，关闭思考，单次生成下一句用户提示词，不改变主对话模型。只读取当前分支最近 12 条用户/Agent 文本（每条最多 6000 字符），排除思考、工具调用轮次、工具结果和图片。不跑 ReAct，不启用工具，不把建议写入会话。

- 空输入框显示灰字；Tab 接受，可继续修改，Enter 才发送。
- 任意其他按键使建议消失，并取消未完成的请求；删除输入也不会让旧建议回来。
- 已有草稿、非 TUI 模式、被中止的回复不生成建议。
- 生成中、请求失败和 30 秒超时会显示在状态栏，不打断输入；切模型、换分支、启动新任务和退出会取消请求。
- 每次正常回复额外消耗一次 DeepSeek Flash 调用；沿用 Pi 的 DeepSeek 认证配置。不回退到主模型，缺少配置或调用失败会显示状态。

## 使用

在仓库根目录临时加载：

```sh
pi -e ./packages/pi-next-prompt/extension.mjs
```

安装到个人 Pi（可选）：

```sh
pi install ./packages/pi-next-prompt
```

要求支持 `agent_settled`、`modelRegistry.streamSimple`、`CustomEditor` 的当前 Pi SDK。插件使用自定义编辑器，因此不能与其他替换主编辑器的插件同时使用。灰字为单行，窄屏截断显示，Tab 接受完整建议（最多 300 字符）。

## 排查

安装或修改代码后运行 `/reload`。回复结束后状态栏应出现「下一句：生成中 · deepseek-flash」。本机一次短对话实测约 1 秒完成，实际速度取决于上下文和服务状态。

- `/next-prompt`：使用最近对话手动生成建议。
- `/next-prompt status`：检查插件是否加载及最近状态。
- 如果命令不存在，插件尚未加载；如果请求失败，状态栏显示错误原因。

## 测试

```sh
npx vitest run packages/pi-next-prompt/core.test.ts
PI_SDK_DIR=/absolute/path/to/pi-coding-agent node packages/pi-next-prompt/sdk-test.mjs
```

SDK 冒烟测试使用真实扩展加载器和编辑器、模拟模型响应，不发起付费 API 请求。
