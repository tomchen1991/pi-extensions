# Pi Monitor v1：上报协议与语义

本协议只约束 **Pi producer → WS collector**；消费端查询/订阅协议由 collector 项目实现，不冒充已经提供。先读[插件 README](../../packages/pi-monitor/README.md)，服务端开发见[交接清单](./02-server-handoff.md)。

运行时唯一结构定义：[contract.ts](../../packages/pi-monitor/src/contract.ts)。受控产物：

- [client-frame.schema.json](../../packages/pi-monitor/schema/client-frame.schema.json)
- [server-frame.schema.json](../../packages/pi-monitor/schema/server-frame.schema.json)
- [event.schema.json](../../packages/pi-monitor/schema/event.schema.json)
- [connection.jsonl](../../packages/pi-monitor/examples/connection.jsonl)：双向握手/ACK 合成示例
- [events.jsonl](../../packages/pi-monitor/examples/events.jsonl)：所有事件类型的独立合成示例，不是完整因果时间线

## 1. 传输与授权

WS/WSS，无特定 subprotocol，文本消息的 UTF-8 JSON，一个 WS message 一个对象，不用 NDJSON 分帧。禁止二进制和压缩；默认部署应关闭 permessage-deflate。最大 frame 65536 bytes。Pi 不跟随 HTTP redirect；WSS 验证证书。客户端发送：

```http
Authorization: Bearer <device credential>
```

服务端须在 Upgrade 时验证凭证并绑定 deviceId/允许的 source.kind 和事件命名空间。不能信任 JSON 中自报身份；必须防止凭证 A 冒充设备 B。生产者凭证不等于读取所有设备数据的权限。不要记录 Authorization、完整握手、原始错误或 IP 以外不必要的连接信息。

只有 `ws://127.0.0.1` / `ws://[::1]` 允许明文，本机以外一律 WSS。服务端默认回环监听，对外监听、反代 TLS、证书和设备授权须显式配置。协议不提供模型指令、shell、任务取消或配置下发。

## 2. 握手状态机

1. WS Upgrade 成功后 Pi 发 `hello`。
2. collector 校验协议、身份与周期；5 秒内回 `ready` 或 `reject`。
3. Pi 发送一次 `snapshot`，再发 `events` 批次。
4. collector 持久化事件后返回 `ack`。快照没有 ACK。
5. 后续快照合并发布，事件批次串行等待 ACK。断线后重新握手、先快照、再重放待确认事件。

共同连接字段：`version: 1`、`source: {kind: "pi", deviceId, instanceId}`、`collectorEpoch`。

### Pi → collector

| type | 附加字段 | 含义 |
| --- | --- | --- |
| `hello` | `protocol: "pi-monitor"`, `delivery` | 本连接请求绑定来源/周期；不含凭证副本 |
| `snapshot` | `throughSequence`, `observedAt`, `heartbeatIntervalMs`, `state`, `delivery` | 当前状态及本周期累计；不是新增消费 |
| `events` | `events: Event[]` | 1–32 条，客户端保守控制批次约 32 KiB；事件各自含完整身份 |

### collector → Pi

```json
{"version":1,"type":"ready","collectorEpoch":"synthetic-epoch"}
{"version":1,"type":"ack","collectorEpoch":"synthetic-epoch","eventIds":["synthetic-epoch:1"]}
{"version":1,"type":"reject","code":"unauthorized"}
```

reject code：`unauthorized | forbidden | unsupported_version | invalid_frame`。HTTP 401/403 或协议 reject 使客户端进入 `rejected`，不会自动重连，须用户修正配置并 disable/enable。

其他连接错误指数退避重连。重复 ready、ready/ack 的错误 epoch、未知字段、错误版本、无效 JSON 或二进制会断开重连。ACK 仅接受当前 in-flight batch 内的 ID；未知/重复 ACK 不删除未发送数据、不延长 ACK 超时。支持部分 ACK，但剩余事件必须在该批次原 10 秒 deadline 内确认。

v1 控制帧为严格 Schema；**不要添加自定义 serverTime、文本说明等字段**。后续增加字段需显式升级/协商版本，不能假设旧客户端会忽略。

## 3. 身份、排序与关联

事件信封：

| 字段 | 约定 |
| --- | --- |
| `envelopeVersion`, `dataVersion` | 当前均为 1；前者对应信封，后者对应该事件数据结构 |
| `source.kind` | 当前仅 `pi`；未来采集器使用独立命名空间和 Schema |
| `deviceId` | 配置提供的稳定设备标识，服务端授权绑定 |
| `instanceId` | Pi 进程内随机 UUID；通过 process Symbol 保留，reload 不换 |
| `collectorEpoch` | 每次启用/会话替换/reload 的新 UUID；不是进程启动时间 |
| `sequence` | 周期内从 1 严格递增；被拒绝/淘汰的记录可能留下缺口 |
| `eventId` | `<collectorEpoch>:<sequence>`，重发保持相同值 |
| `occurredAt` | 来源时钟 UTC ISO 时间，不代表跨机器全局顺序 |
| `sessionId` | 当前 SDK session ID，最多 128 字符；不带 session 文件路径 |
| `activityId` | 一段自动工作直到 settled 的关联 ID；非活动事件可为 null |

去重主键使用 `(authorized deviceId, instanceId, collectorEpoch, eventId)`。同键同内容可重复 ACK；同键不同内容是协议冲突，拒绝/审计，不能覆盖账本。每批外层身份与每条事件身份必须一致，且与连接授权一致。

模型/工具名称等字符串按每项最多 256 bytes 的 JSON 内容预算截断，超长名称不保证唯一；不把截断标签当作认证身份。请求 ID 为插件生成的关联 ID，不是 HTTP/provider response ID。工具 ID 是原始 toolCallId 用 epoch 作键的 HMAC 截断；parentToolId 使用同样映射，仅周期内关联，不包含原始工具参数。此散列不构成真实性或同账户隔离保证。

collector 应另记 `receivedAt` 和全局持久化游标。不能用不同设备 `occurredAt` 排序推导绝对因果；不能把不同 epoch 的 sequence 拼成单一连续序列。SDK 多会话嵌在同一进程时共享 instanceId，应同时用 epoch 区分采集器。

## 4. 事件语义

| type | 关键字段与注意事项 |
| --- | --- |
| `pi.collector.started` | 初始 state；只表示开始观察，可能在活动中途启用 |
| `pi.collector.stopped` | reason: quit/reload/new/resume/fork/disabled/replaced；非 quit 不是 Pi 退出 |
| `pi.model.changed` | 当前选定 provider/model/responseModel/thinkingLevel；无模型为 null |
| `pi.activity.started` | 一个观察到的自动活动；低层 agent_end 不结束它 |
| `pi.activity.settled` | outcome: completed/aborted/error/unknown；不是用户任务验收 |
| `pi.request.started` | requestId、selectedModel；基于 assistant message_start，不是 TCP/HTTP 起点 |
| `pi.request.finished` | requestId、实际 model、outcome、durationMs、usage、error |
| `pi.tool.started` | toolId、parentToolId、name、startedAt；工具可并行 |
| `pi.tool.finished` | toolId、parentToolId、name、outcome、durationMs、usage、error；工具错不等于活动错 |
| `pi.interaction.wait.started/ended` | kind: select/confirm/input/editor/custom；仅 SDK 暴露的阻塞式扩展 UI，无标题和回答 |
| `pi.compaction.started` | reason: manual/threshold/overflow，willRetry；是 before_compact 已观察边界，后续可能被其他扩展取消 |
| `pi.compaction.finished` | reason、willRetry、outcome、usage、error；失败可能没有已观察的 started |
| `pi.branch.changed` | 新生成分支摘要的 usage 或 null；不回扫旧分支消费 |

request outcome：`completed | tool_use | length_limit | aborted | error | deferred | unknown`。`length_limit` 不当作网络失败；`deferred` 不当作任务完成。耗时为毫秒，优先 SDK 单调耗时；缺失时 request 可用观察到的起止边界计时，未观察到起点则 null。工具无 SDK duration 时为 null。

最终 activity outcome 由 `agent_before_settle.outcome` 暂存，`agent_settled` 时发布；aborted 优先。没有可信结果时 unknown，不根据最后一个工具猜测。一次失败请求之后可继续重试并最终 completed。

不全量追踪 HTTP 子请求、底层重试、网络状态码、首 token、逐 token 进展、后台插件任务、所有用户 bash 或 OS 退出信号；看不到的开始/结束不补造。force kill/崩溃可能永远没有 stopped 事件。

## 5. 错误与用量

error 为 null 或 `{category, source, classificationBasis}`，没有原始 errorMessage、headers 或 stack。

v1 的实际映射：

- assistant stopReason=error → unknown / model / sdk_stop_reason。
- tool isError=true → tool_failed / tool / sdk_tool_error。
- compaction 非取消失败 → unknown / compaction / sdk_compaction_error。
- aborted 不自动附错误，不声称一定来自用户键盘。

分类枚举中的 authentication、permission_denied、rate_limited、quota_exceeded、timeout、network、provider_unavailable、context_limit、invalid_request、internal 是预留分类；当前没有可靠结构化依据时不发出。**服务端不可为了美观把 unknown 猜成上述原因。** 传输认证失败不冒充模型认证失败。

usage：

```json
{"availability":"reported","source":"pi_sdk","tokens":{"input":10,"output":20,"cacheRead":5,"cacheWrite":2,"reasoning":7,"totalTokens":37},"estimatedCost":{"currency":"USD","amount":0.03,"basis":"sdk_estimate"}}
```

- availability 为 reported/partial/unknown。失败/取消时仍有 SDK 正数用量则 partial；缺失、不合法、totalTokens=0 则 unknown，tokens=null。
- reasoning 是 output 的子集，不能重复加；totalTokens 保留 SDK 值，不自行改变服务商规范化口径。
- 零费用无法可靠证明免费；estimatedCost=null。已知正费用也只是 SDK USD 估算。
- 工具 usage=null 表示该工具未声明可统计的根级用量或它是嵌套子工具，不表示确认免费。根工具的 `pi.tool.finished` 在 SDK `toolResult message_start` 合并全部嵌套用量后发布，只加一次；不从更早的根 `tool_execution_end.result` 计量，也不在 `message_end` 重计。嵌套工具仍在各自 `tool_execution_end` 发布完成事件，usage=null。
- 压缩/分支摘要用量没有可靠模型归属，不强行使用当前选定模型。工具、压缩、分支摘要的粒度不等同于主模型 request。
- 快照累计 scope 固定为 collector_epoch，只加本周期新观察用量，不回扫历史，不跟随会话树回滚。unknownRecords 包含未知/部分用量记录；unknownCostRecords 表示这些已观察记录中费用未知的数量，**不计完全看不到的调用**。
- 累计 estimatedCostUSD=0 只表示已知正费用之和为零，必须结合 unknownCostRecords 和覆盖范围解释，不等于实际账单为零。
- 独立 cache-warm usage entries、其他插件绕过宿主上报的调用不保证覆盖。未知或部分用量不是完整账单。

## 6. 快照与交付缺口

state 包含身份元数据、选定模型、status、activityId、requestId、activeTools、activeToolCount、toolsTruncated、waitingInteractions、compacting、lastProgressAt、lastOutcome 和本周期 usage 累计。status 为 idle/active/stopping/unknown；工具、等待交互、压缩也会使快照 active。不能将 idle 等同于任务完成。

活动工具明细最多 64 项；activeToolCount 继续记录已观察的活动数量，toolsTruncated 标记明细不完整直到下一次 settled。进程中途启用可能漏掉起始事件，所有这些都是观察状态而非 OS 级真相。

throughSequence 是采集器已经处理到的位置，不是服务端已持久化的序号，也不是 ACK 水位。重连快照可能比随后重放的 events 更新：

- 当前状态只应用比当前状态水位更新的事件；不能被旧重放倒退。
- 历史账本仍须按 eventId 保存/去重这些较旧事件。
- 不要将快照累计与事件 usage 相加。快照不是额外一笔消费。
- started 事件中的 state 也是初始快照，不能额外统计一次用量。

`delivery`：queuedEvents/queuedBytes 为待确认内存队列；droppedUnconfirmed 为因容量淘汰的记录数；lastDroppedSequence 为最后一次淘汰的来源序号；rejectedEvents 为本地 Schema/大小/观察失败的计数。所有计数仅本 epoch。

淘汰时事件可能已经到达服务端但 ACK 丢失，所以 droppedUnconfirmed **不是 confirmedLost**。未确认队列在异常退出/reload 时丢失可能来不及发缺口。序号缺口、collector 停止缺失和覆盖声明应一起交付给消费端。

活动快照心跳 10 秒、空闲 30 秒；状态变化合并最多约每秒一次。WS ping 10 秒用于连接活性，不能更新业务 lastProgressAt。服务端用 receivedAt 判断新鲜度；断线/超时只标 disconnected/stale，不能推断 crashed/quit。snapshot status=stopping 也不区分进程退出还是 reload，需结合 stopped.reason。

## 7. 交付保证

只有一个在途批次，客户端在 ACK 前保留内存副本；重连重复发相同 eventId。collector **只对已持久化事件 ACK**，重复已持久化事件也可 ACK。持久化应包含去重索引可恢复性；不能 write() 返回就宣称 fsync 完成。

客户端有界、不阻塞 Pi、不持久排队，队列满或进程退出可能丢失。shutdown 最多等 250ms。此协议不是全路径 at-least-once，更不是 exactly-once；只能对仍保留的未确认记录重发。服务端 retention 到期后如何处理很晚的重复记录，见交接文档的去重保留要求。

所有 Schema 拒绝未知字段；新事件/字段应通过新版契约演进。服务端若不支持当前版本，显式 reject，不靠静默丢弃得到 ACK。
