# PI Monitor

默认关闭的 Pi 元数据采集插件。每个 Pi 仅作 WS 客户端，向用户配置的本机/远程采集中枢发送结构化事件和当前快照。**本包不实现中枢、看板、告警、远程控制或后台服务安装。**

第一版验证目标为 Node.js >=22、`@earendil-works/pi-coding-agent@1.4.0`。peer dependency 的 `*` 不是全版本兼容承诺。当前为私有开发包，未发布 npm。

## 开启

先由服务端实现[交接文档](../../docs/pi-monitor/02-server-handoff.md)中的 v1 上报协议；普通 WS echo server 不兼容。

从仓库根目录构建：

```sh
npm ci
npm run build --workspace=pi-monitor
```

由用户/宿主在启动环境配置：

| 变量 | 含义 |
| --- | --- |
| `PI_MONITOR_URL` | WS 上报完整地址，例如 `ws://127.0.0.1:4319/ingest` 或 `wss://monitor.example/ingest`；端口/路径由服务端决定 |
| `PI_MONITOR_DEVICE_ID` | 服务端授权的稳定设备 ID；用户显式设置，不扫描系统序列号或主机名 |
| `PI_MONITOR_TOKEN` | 该设备的 bearer 凭证，通过 WS Upgrade 的 Authorization header 发送 |
| `PI_MONITOR_PROJECT_ID` | 可选、不透明的项目 ID；不设置则为 null，不读取/散列工作目录 |
| `PI_MONITOR_ENABLED=1` | 显式允许启动时采集；默认关闭 |

设备/项目 ID 限制为 1–128 个 ASCII 字母、数字、`.`、`_`、`-`，首字符须为字母/数字。项目标签不会因 `/resume` 自动重新推导，跨项目时由启动环境决定。不要在这些 ID 中放敏感信息。

加载但不自动开启：

```sh
pi -e ./packages/pi-monitor/src/extension.ts
# Pi 内：/monitor enable
```

宿主已明确获得授权时，也可使用 `--monitor`：

```sh
pi -e ./packages/pi-monitor/src/extension.ts --monitor
```

命令：

- `/monitor status`：显示是否启用、连接状态、缓冲/丢弃计数、固定诊断码；不显示 URL 或凭证。
- `/monitor enable`：启用当前扩展周期；不会写个人配置。若未使用启动环境/flag 自动开启，reload 后须重新 enable。
- `/monitor disable`：停止上报；当前进程内 reload/会话切换不会因自动开启配置而恢复，须显式 enable。此暂停不跨进程保存。

配置无效时保持离线，使用 `/monitor status` 查看固定错误码。认证或协议明确拒绝后不无限重试，修正配置后 disable/enable。插件不自动刷新凭证。

开发和测试不会替你设置这些变量、安装个人 Pi、开启真实采集或连接公网服务。

## 采集范围

- 设备 ID、每进程随机 instance ID、PID、进程启动时间、Pi/插件版本、运行模式。
- 会话 ID、可选项目 ID、模型/思考等级切换、实际响应模型。
- Agent 活动起止、assistant 请求起止、工具起止、阻塞式扩展 UI 等待、压缩及 `/tree` 事件。
- 新发生且可观察的 token、缓存 token、reasoning 子集、SDK 估算费用、耗时、停止原因。
- 有界当前快照、周期内用量累计、交付缺口、连接健康。

不采集 prompt、回复、thinking 内容、工具参数/输出、UI 标题、原始错误全文、原始 provider 请求/响应/headers、认证文件、历史会话、真实目录、会话标题、机器硬件信息。模型名/工具名/自定义会话 ID 本身也可能含用户自定义信息；这是元数据白名单，不是完整匿名化或安全沙箱。

不调用模型、不注册模型工具、不注入上下文、不修改会话，不扫描整个 Mac 或历史文件。凭证仅用作传输认证、不写入事件；环境变量仍可能被同用户进程和 Pi 子进程访问，不能把此方案当作凭证隔离。配置及加载扩展本身需可信。

## 工作状态及用量限制

- `agent_end` 不表示最终空闲；最终活动结果取 `agent_before_settle`，在 `agent_settled` 发布。`completed` 只表示运行结算，不是任务验收。
- assistant 的一段响应是本协议的一个 request，**不是完整 HTTP 请求追踪**。不观察原始流、不采首 token 延迟、底层重试次数或实时生成速度。
- 工具可并行/嵌套；最多保存 64 个活动工具明细，另有总数和截断标记。没有结束事件不等于成功。
- 分类只用可靠 SDK 结构化字段。当前模型/压缩错误为 `unknown`、工具错误为 `tool_failed`；其他错误枚举为协议预留，不解析错误全文猜测 429、额度或网络原因。
- 仅计算本采集周期中新观察的用量。resume/fork/reload 不重算历史；切分支不撤销消费；根工具完成事件及用量取 SDK `toolResult message_start` 聚合后的结果，嵌套用量只计一次。
- 费用为 SDK 的 USD 估算，不等于账单。缺失/全零 token 视为未知；零/缺失价格不能可靠区分免费与未配置，保守记为未知。
- 未上报的其他插件模型调用、cache warming 的独立 usage entries、未暴露的失败费用等不在覆盖保证内。压缩/分支摘要及工具用量不强行归到当前选择的模型。
- 第一版不采当前上下文占用：当前 SDK 的接口需要遍历历史。也不采 CPU/RSS、进程树或工作语义摘要。
- 中途 enable 的已在运行操作可能只有结束事件。SDK 事件可能被其他扩展更改；协议提供可观察事实，不保证底层服务商数据真实性。

## 连接、缓冲与退出

完整协议见[输出契约](../../docs/pi-monitor/01-protocol.md)。WS 一条消息一个 JSON 对象；事件批量发送，不是逐 token 或逐心跳写 JSON 文件。

- 仅字面量 `127.0.0.1` / `[::1]` 允许明文 `ws:`；其他地址必须 `wss:`，TLS 验证开启，不跟随重定向。不接受 URL 用户名、密码、query 或 fragment。
- 不用 WS 压缩；单个 JSON frame 最大 64 KiB，批次最多 32 条/约 32 KiB，最多一个未确认批次。
- 待确认队列最多 512 条/256 KiB JSON 估算大小；不等于整个进程额外内存。满时淘汰最旧记录，并报告 `droppedUnconfirmed`，它不等于确认丢失。
- 状态快照最多约每秒一次，活跃心跳 10 秒、空闲 30 秒；传输 ping 10 秒，30 秒无 pong 重连。心跳不意味着工作有进展。
- 首次工作调度/批次发送通常在 250ms 后；没有高频 token 回调。空闲不运行固定 250ms 轮询，按下一个 deadline 唤醒。
- 连接与 ready 等待分别有 5 秒上限；ACK 超时 10 秒重连。重连指数退避带随机抖动，最大 30 秒；离线缓冲满不阻塞 Pi。
- 重连先发当前快照，再补发队列。相同 eventId 重发，服务端去重并仅在持久化后 ACK。
- 正常 shutdown 最多等待 250ms；无持久队列。强杀、崩溃、长期离线、队列溢出、reload/退出未 flush 完均可能丢数据。**不是 exactly-once 或账单级不丢保证。**
- 失联不能推断 Pi 已退出；Mac 睡眠、网络故障、服务端离线都可能断开连接。新采集周期不恢复旧周期内存队列。

协议只规定短期留档接口与语义；中枢留档、fsync、恢复、授权、消费订阅均由服务端 agent 实现。

## 验证

在仓库根目录：

```sh
npm run build --workspace=pi-monitor
npm run artifacts --workspace=pi-monitor
npx vitest run packages/pi-monitor/test

# PI_SDK_DIR 指向已安装 SDK 的包根目录；真实加载器/agent loop，假模型，回环 WS fixture
PI_SDK_DIR=/absolute/path/to/pi-coding-agent npm run test:sdk --workspace=pi-monitor
```

Schema 与合成样例从 `src/contract.ts` / `scripts/fixtures.ts` 生成，测试检查一致性。离线测试服务器只是测试替身，不是交付的采集中枢。

本次已通过和未验证范围见[验证记录](../../docs/pi-monitor/03-validation.md)。

SDK 冒烟覆盖 TUI 模式真实 loader/agent loop、默认关闭、手动开启、主模型及工具用量、错误/中止、reload 身份、历史不重计、disable 和内容排除。普通测试覆盖竞争/故障；RPC/print/JSON 的真实子进程和远程 WSS 部署尚需专门验收。CPU、内存、Mac 电量和真实远程服务端联调未实测，不承诺先前讨论的性能预算已经达成。
