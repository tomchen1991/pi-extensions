# 给服务端 Agent：Pi Monitor WS 采集中枢交接

## 任务边界

本仓库已经实现 **Pi 侧 producer**，位于 [`packages/pi-monitor/`](../../packages/pi-monitor/README.md)。请在独立服务端项目实现 WS collector，不在本仓库添加生产服务，不修改/复用 `pi-collaboration` 的 broker，不依赖 DeckZ 专用字段。

collector 是有短期记忆的数据接收与交付服务，不是 Agent 控制平面。第一版只支持 `source.kind=pi`、单节点；不做工作摘要、远程 shell、模型调用、任务调度、告警规则或看板。未来来源使用独立 Schema/命名空间，不能以“通用”为由接受任意无界 JSON。

开发操作不代表允许连接真实设备、启用采集、读取个人会话/凭证、部署公网服务或安装 launchd；这些操作须另行授权。

## 先读与不可改动的契约

1. [协议及全部语义](./01-protocol.md)。
2. [client frame JSON Schema](../../packages/pi-monitor/schema/client-frame.schema.json)、[server frame JSON Schema](../../packages/pi-monitor/schema/server-frame.schema.json)、[event JSON Schema](../../packages/pi-monitor/schema/event.schema.json)。
3. [连接样例](../../packages/pi-monitor/examples/connection.jsonl)、[事件样例](../../packages/pi-monitor/examples/events.jsonl)。均为合成数据。
4. [`transport.ts`](../../packages/pi-monitor/src/transport.ts)、[`observer.ts`](../../packages/pi-monitor/src/observer.ts) 和 [`transport.test.ts`](../../packages/pi-monitor/test/transport.test.ts)。测试服务器只是协议替身，**不是可靠服务端参考实现**。

服务端可以将固定版本 Schema/合成样例复制到自己的协议目录并记录来源版本/内容 hash，也可后续协商独立协议包。不得用开发者机器绝对路径或直接依赖另一仓库未声明的 TS 源码。

版本为 wire v1、event envelope/data v1，producer 包版本为 0.1.0。当前控制帧严格拒绝额外字段；如果实现想改 ACK、握手或字段，先同步协议与两侧回归，不单边“兼容性扩展”。

## 建议实现分层

```text
WS ingress -> authorization/schema/quotas -> per-source sequencing
                                         -> durable event store + dedup
                                         -> current-state store
                                         -> consumer snapshot/replay/subscription
```

网络层可使用 Node 的 `ws` 或其他语言实现。生产者只要求标准 WS/WSS，不要求 Node。日志可用分段 JSONL，但存储引擎由服务端项目决定；单个 JSONL 文件并不自动提供去重、原子游标、fsync 或崩溃恢复。

### A. 安全接入

- 默认回环监听；远程入口显式启用 TLS，反代需支持 Upgrade、合理 idle timeout 和 frame 限制。
- Upgrade 中验证 bearer credential，映射到设备及 `pi.*` 写权限。无凭证 401、无权限 403。
- hello 与后续外层 source/epoch、每条事件内部 source/epoch 均需一致。限制连接数量、每设备速率、批次与 frame 大小。
- 禁用 WS 压缩；frame 最大 64 KiB；batch 最多 32 条。验证字段长度、非负有限数值、日期、枚举和 eventId/sequence 一致性。
- 凭证不能放 URL、响应或日志；拒绝消息仅使用规定 code。默认拒绝带浏览器 Origin 的 producer 连接；不要给写入凭证开放任意浏览器来源。
- 消费端认证独立；不得让一个设备凭证读取其他设备数据或向 Pi 下发执行命令。
- 本机单用户部署也要认证，不能把 localhost 或 deviceId 当作信任凭证。

### B. 连接与实时状态

- hello 后 5 秒内返回 ready；不支持版本显式 reject。
- 同一 `(authorized device, instance, epoch)` 的重复连接需要 fencing：串行化接收和持久化，明确关闭旧连接，防止旧连接污染新状态。
- 收到 snapshot 后更新当前状态；保存 throughSequence 水位，不能被随后较老的重放事件倒退。
- collector receivedAt 单独记录；跨设备不能只用客户端时间判断新鲜度。
- WS ping 必须正常 pong。业务心跳为 snapshot，空闲 30 秒、活跃 10 秒；定期检测 stale，留出抖动余量。
- 区分 producer 状态和连接状态；断线只表示 disconnected/stale。缺少 stopped 不能推断 crashed；reload/new/resume/fork/disabled/replaced 都不是进程退出。
- 重启后的旧快照标记待重新确认，不能凭磁盘里 active 就显示在线。
- `lastProgressAt` 仅事件边界变化，不因心跳延长。模型长时间生成期间可能无新进展事件；不要仅凭这一点断言卡死。

### C. 留档、确认与去重

- 保存用量、结果、错误、模型/会话周期、活动/工具阶段等离散事件；心跳不逐条归档。
- JSONL 按容量/时间分段；批量持久化后 ACK（客户端 ACK deadline 10 秒），不能只入内存就回 ACK。
- 去重信息与事件必须能一起恢复：建议事件存储本身为事实源，提交日志/索引有一致性方案。崩溃在“数据写入、去重更新、ACK 发出”任意位置都不能造成双重消费。
- 同 eventId 同内容重复接收，不重计，仍可 ACK；同 key 内容不同拒绝，不能覆盖已有事件。
- 序号可能跳跃，不要求客户端补不存在的记录；不能 ACK 从未持久化的 ID，也不能把 snapshot.throughSequence 当作 ACK 水位。
- ACK 最多 32 个明确 eventId，携带正确 epoch。部分 ACK 可以，但客户端按原批次的 10 秒 timeout 等剩余 ID。
- 断线后仍保留的未确认数据会重放；producer **没有磁盘 spool**。不要向用户承诺全链路不丢或 exactly-once。
- 传递 delivery 缺口，区分 droppedUnconfirmed 与 confirmedLost。异常退出时缺口可能都来不及上报。

**留档过期与去重必须分开考虑：**客户端某个 epoch 可长期存活，离线期间可能保留很旧的未确认事件。删除 7 天前的日志后，不能把同 ID 的重发当成新消费。服务端须保留足够的去重 tombstone，或显式拒绝已退休 epoch（v1 可用 invalid_frame，客户端会停止，需重新 enable 开新周期），不能谎称未持久化事件已经 ACK。epoch 退休策略及相应恢复操作须在服务端文档公开。

建议默认短期 retention 为 7 天、总容量 1 GiB，任一先到则清理最旧分段；这只是待服务端确认的初始策略，不是本 producer 已实现的配置。还应有每设备配额、磁盘保留空间、落盘失败处理；磁盘满不能继续发 durable ACK。

### D. 面向消费端的数据交付

消费端协议由你设计，**不要直接复用 producer bearer 权限或擅自给 producer 控制帧添加字段**。建议提供：

1. 当前实例快照查询。
2. 从服务端持久化 cursor 读取历史。
3. 当前快照 + 对应 cursor + 后续实时订阅的一致性接口。
4. `cursor_expired` / `resync_required` 等显式缺口响应。

快照生成和订阅起点必须有明确线性化点，避免连接时漏掉一段事件。每个慢消费者有独立有界缓冲；可要求游标恢复，不能让一个消费者堵住所有 producer。事件记录返回 eventId、来源序号、occurredAt、receivedAt 及服务端 cursor；前端不必解析 Pi 自然语言。

消费端长期归档、统计与展示自己负责。快照本周期累计与事件用量不相加；跨 epoch 累计不能误认为原会话累计归零或重复历史。

## 推荐开发顺序

1. 固定 Schema，完成授权 hello/ready、snapshot、events/ack；先用合成客户端。
2. 实现持久化、去重、崩溃恢复，明确 ACK durability 边界。
3. 加入重连、fencing、配额、retention 与缺口处理。
4. 再实现消费端查询/回放/订阅接口，不开发看板。
5. 使用真实 producer 的假模型会话联调，最后再单独申请真实设备和远程 TLS 验收。

## 必须通过的验收场景

- [ ] 缺失/无效凭证、跨设备冒充、错误 kind/type、错误版本、二进制、额外字段、超大 frame 被拒绝。
- [ ] 合法 hello -> ready -> snapshot -> events -> durable ACK。
- [ ] ACK 丢失后重连重发；同 ID 只入账一次，仍回 ACK。
- [ ] 同 ID 不同内容拒绝；旧连接不能修改新连接的状态。
- [ ] 进程崩溃分别发生于落盘前、fsync 后 ACK 前、去重索引恢复时；已 ACK 事件可恢复。
- [ ] 旧事件重放不覆盖较新的 snapshot；snapshot 累计不重复加到账本。
- [ ] 缺口/队列淘汰、客户端关闭前未 flush、磁盘满都不被当作成功交付。
- [ ] reload/new/resume/fork 与 quit 区分；失联、Mac 睡眠不判定崩溃；新 epoch 不重算历史。
- [ ] 模型错误、取消、长度截断、工具失败、压缩失败/取消保持各自结构；unknown 不猜测。
- [ ] reasoning 不重复计 token，零价格不当作确认免费；工具嵌套只按根级计量。
- [ ] 多设备同时上报、慢消费端、大量小事件有明确资源上限。
- [ ] retention 后旧 cursor 显式过期；很晚的 producer 重放不变成新消费。
- [ ] 日志/磁盘不出现 bearer、prompt、原始错误全文或工具内容。
- [ ] 服务重启后旧快照待重新确认；WS 断开与 Pi 退出区别可被消费端读取。

## 当前已验证与尚未验证

producer 已有运行时 Schema、生成 JSON Schema/合成样例、离线 WS 协议/故障回归和真实 Pi SDK 假模型冒烟入口。具体命令见[插件 README](../../packages/pi-monitor/README.md)。测试 fixture 的 ACK 不表示已经实现可靠服务端。

尚未交付/验收：生产 collector、持久化/恢复、消费端接口、真实公网 WSS/证书/反代、Mac 性能和电量、真实模型效果。不要将“Pi 侧完成”表述为端到端上线。
