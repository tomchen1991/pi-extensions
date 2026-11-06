# PI Model Fallback

独立 Pi 插件：Codex 订阅额度耗尽后，将当前会话切换到已配置的 **OpenAI 官方 API 同 ID 模型**，自动续接失败请求。无需把 API 模型加入 `/scoped-models`。

## 行为与费用

- **加载即启用自动付费切换**；安装或加载前请确认愿意承担 OpenAI API 费用。插件不配置、复制或保存 API Key，使用 Pi 的模型目录和认证解析。
- 仅 `openai-codex/<id>` → `openai/<相同 id>`。不猜测别名、不删 `-codex` 后缀、不降级。目标模型必须已存在于 Pi 目录且有可用认证，有效地址必须是 `https://api.openai.com`。
- 切换只影响当前会话，不改全局默认模型或 scoped models。切换后后续轮次继续走 API，不自动切回；Pi 保存模型变更，恢复会话时继续生效。用户仍可主动 `/model` 切换，插件不锁定模型。新会话仍使用原默认值。
- 尽可能保持原 thinking level（受目标模型能力限制）。保留上下文与已完成的工具结果，不重发原用户消息、不重新执行工具；只从后续模型上下文中省略失败的助手消息，原始错误仍保留在历史中。
- 切换时在 TUI/RPC 提示后续按 API 计费。无 UI 模式不弹窗；加载本插件同样代表允许自动付费切换。
- API 认证、余额或请求失败不会触发另一层 fallback，也不会反复切回 Codex。Pi 自身的普通重试策略仍独立生效。

## 额度判断的已知限制

只接受下列明确证据，且必须对应当前 Codex 请求的错误响应：

1. 错误文本或结构化流错误中的精确 `usage_limit_reached` 错误码；或
2. HTTP 错误响应头 `x-codex-primary-used-percent` / `x-codex-secondary-used-percent` 达到 100%。覆盖订阅短窗口及周窗口耗尽，不针对普通每分钟限流。

**Pi SDK 1.4.0 / 1.5.0 会把某些普通 429、`rate_limit_exceeded` 和订阅额度错误统一显示为 `You have hit your ChatGPT usage limit...`。仅凭这句文案（即使包含重置时间）无法可靠区分，因此不会自动切换。** 如果服务端/传输没有暴露额度响应头或原始错误码，本插件会提示信息不足，需要手动切换；不能保证所有周额度错误都能自动识别。不读取个人用量页面、不额外请求额度接口、不轮询后台服务。

失败请求可能先经过 Pi 内置重试，插件在最终 `agent_before_settle` 边界处理仍未恢复的额度错误。网络错误、上下文溢出、取消、普通限流、API 余额不足及信息不足的错误均不触发切换。自动压缩等辅助模型调用不在本插件接管范围内。

## 使用

先在 Pi 中配置 OpenAI 官方 API，并保证 API 同 ID 模型在模型目录中可用。无需修改 scoped models。

在仓库根目录临时试用：

```sh
pi -e ./packages/pi-model-fallback/src/extension.ts
```

用户自行选择持久安装（会修改个人 Pi 配置）：

```sh
pi install ./packages/pi-model-fallback
```

会话内控制：

```text
/model-fallback status
/model-fallback disable
/model-fallback enable
```

开关写入当前会话的自定义状态条目，按当前分支恢复；disable 不会把已选的 API 模型切回 Codex。卸载使用 `pi remove <pi list 显示的 source>`，不会删除会话里已记录的模型变更。

## 验证

当前离线 SDK 冒烟已验证：`@earendil-works/pi-coding-agent@1.4.0` 和 `1.5.0`（类型构建使用 1.4.0）；peer dependency `*` 不代表全版本兼容。依赖 `agent_before_settle`、context edit、模型目录和会话级 `setModel`。

在仓库根目录运行：

```sh
npm ci
npm run build --workspace=pi-model-fallback
npx vitest run packages/pi-model-fallback/test
PI_SDK_DIR=/absolute/path/to/pi-coding-agent npm run test:sdk --workspace=pi-model-fallback
```

SDK 冒烟使用真实 loader / agent loop、假 provider、合成消息及临时会话，禁止 fetch，不访问个人配置，不调用真实模型。覆盖 scoped models 外切换、上下文续接、工具不重放、后续轮次、恢复会话及失败停止；普通测试补充额度证据、取消与配置故障。真实额度耗尽和付费 API 效果需另行授权验证。

扩展与 Pi 具有同等进程权限，不是隐私或计费安全沙箱。插件不新增认证存储或外部上报；切换后当前模型上下文会发送给 OpenAI API。
