# Pi Monitor 初版验证记录

环境：Linux x64、Node.js v24.19.0、实际安装的 `@earendil-works/pi-coding-agent@1.4.0`。未安装个人 Pi 插件、未启用真实采集、未启动持久服务、未请求真实模型。所有 WS 服务均为测试创建并关闭的临时回环 fixture。

## 已通过

- `npm ci`：工作区依赖安装完成。
- `npm run build --workspace=pi-monitor`、`npm run artifacts --workspace=pi-monitor`：构建及协议产物生成。
- `npm test`：全仓构建后 **13 个测试文件 / 184 项测试通过**，其中 monitor **27 项**。
- `PI_SDK_DIR=<installed SDK package root> npm run test:sdk --workspace=pi-monitor`：真实加载器、session、agent loop 与假模型；验证默认关闭、明确开启、真实主模型/工具用量一致、失败/中止、reload 身份、历史不重复计量、disable、内容排除和清理。
- Schema/样例一致性、全部事件类型合成样例、相对链接、`git diff --check` 和新文件空白检查。
- `npm pack --workspace=pi-monitor --dry-run`：manifest 包含入口及运行依赖所需本包文件；未发布或交付归档。

故障/竞争覆盖：ACK 前断线重放、未知 ACK 不删除未发送数据、错误 epoch/无效帧、HTTP/协议认证拒绝、ready/ACK 超时、队列条数/字节上限、退出 flush 上限、shutdown 与 restart 竞争、并行/嵌套工具、防止超长字符串撑大快照、观察异常不阻塞主循环。

## 开发中定位并修正的验证问题

- 首次 TypeScript 构建发现 `ws.RawData` 不保证有 `.length`，改为规范化 Buffer 后检查 byteLength。
- 加强 SDK 用量断言后曾失败：假 provider 会根据真实合成上下文重算 usage，覆盖预填 token。已核对其实现，测试改为与 SDK 最终消息逐字段对比，并核对快照累计恰好包含主模型与根工具用量；未跳过断言。
- 源码核查发现 `ctx.getContextUsage()` 会构建历史投影；已从默认采集移除，测试禁止调用历史/上下文扫描接口。

## 嵌套工具用量修复回归

- 已核实 Pi 1.4.0 在根 `tool_execution_end` 之后、`toolResult message_start` 之前才合并嵌套用量；旧测试给根执行结束事件预填聚合值，未覆盖真实时序。
- 修前：新增/调整后的 observer 回归有 6 项失败；真实 SDK 冒烟中，无自身用量的根工具最终 SDK 消息包含 8 tokens，但监控完成事件 usage=null。
- 修后：`npm run build --workspace=pi-monitor`、监控 4 个测试文件 / 32 项测试、`npm test` 全仓构建及 13 个文件 / 189 项测试均通过。
- `PI_SDK_DIR=<installed SDK package root> npm run test:sdk --workspace=pi-monitor` 通过：使用真实 `ctx.executeTool()` 两层嵌套，分别验证根工具无自身用量（合计 8 tokens）和有自身用量（合计 17 tokens），逐字段核对 SDK 聚合结果、事件和快照累计费用；子工具及 message_end 不重计。
- 缺失/零用量、未知价格及错误结果的计数有单元回归。SDK 冒烟最初新增的“未知费用为零”断言不成立：假模型使用零价格，已改为逐条根据 SDK 实际费用推导预期数量。
- 本轮依赖通过 `npm ci --include=dev --offline --ignore-scripts --no-audit --no-fund` 从缓存安装；默认省略开发依赖时曾因缺少 tsc 无法构建，补齐开发依赖后通过。未变更 manifest/lockfile，未请求真实模型或启用真实采集。

## RPC / print / JSON 子进程补充验证

环境：macOS arm64、Node.js v24.16.0、工作区安装的 Pi SDK 1.4.0。本轮使用临时 HOME/agentDir、合成 provider、临时回环 WS fixture；未安装个人 Pi、连接公网 collector 或请求真实模型。

- 新增 `PI_SDK_DIR=<SDK包根目录> npm run test:cli --workspace=pi-monitor`：真实 CLI 子进程，RPC / `--print` / JSON 三种模式均带 `--no-session`，分别验证默认关闭、`--monitor`、`PI_MONITOR_ENABLED=1`，共 9 组。
- 验证 hello/ready、Schema、认证 header、请求用量（5 tokens）、最终结算、停止事件、退出码、stdout 保持原模式格式、无会话 JSONL 留存、遥测不含合成正文/临时目录/token。RPC 额外执行真实 reload：instance 不变、epoch 更新、历史用量不重计；disable 后 reload 保持关闭。
- 新增回归最初暴露瞬时 print 任务在 Upgrade/ready 前退出：未收到 collector.started。修复在原有 250ms shutdown 预算内等待已开始的连接，不启动新重连。恢复旧等待条件后新 CLI 测试再次失败；修复后 9 组通过。普通测试补充握手前 stop 成功交付、握手失败时有界退出且不重连两项。
- 调试还发现 Pi 1.4.0 初次解析未知扩展 flag 时会将紧邻普通参数作为 flag 值，`--monitor 'prompt'` 会吞掉 prompt；测试使用 `'prompt' --monitor`，文档提示此顺序或改用环境开关，未修改宿主 SDK。
- `npm test`：全仓构建、13 个文件 / 191 项通过（monitor 34 项）。监控原有 `test:sdk` TUI 真加载器/假模型冒烟通过。CLI 九组通过，并额外重复运行确认。
- 初次构建因工作区缺少 `@types/ws` 失败；执行 `npm ci --include=dev --ignore-scripts --no-audit --no-fund` 后构建通过，未改依赖版本或 lockfile。

这是单机合成验收，不是远程 WSS/生产 collector 或 Desk/DeckZ 宿主端到端验收。离线、握手超过退出预算、强杀仍可能丢数据；不提高原有交付保证。

## 依赖审计提示

`npm audit` 报告 3 个受影响包条目（2 moderate / 1 high）：Pi SDK 及其 `minimatch`、`undici` 依赖链。已比对任务前 lockfile：SDK 1.4.0、minimatch 10.2.6、undici 8.10.2 均未改变。此次只新增 monitor 声明及 `@types/ws`，将已有 ws 明确声明为运行依赖；未混入宿主依赖升级。审计问题仍存在，应另行评估兼容升级，不能将测试通过等同于依赖安全。

## 未运行 / 未验证

- Node.js 22 实机、CPU/RSS/电量或吞吐 benchmark；性能数字仍只是设计目标。Mac 已补 CLI/TUI 合成冒烟，不代表完成性能验收。
- 真实公网 WSS、TLS/反代部署、生产中枢持久化与去重恢复、消费端订阅/游标。
- RPC/JSON/print 模式已补上述合成专项冒烟；Desk/DeckZ 宿主集成和生产端到端验收仍未运行。
- 真实模型效果、真实服务商账单一致性、其他插件未显式上报的模型调用。
- 另外三个插件的专项 SDK 冒烟；本次运行全仓普通测试，监控专项真实 SDK 冒烟只覆盖本插件。

交接入口：[服务端开发清单](./02-server-handoff.md)。生产服务端尚未实现，不能将上述验证描述为端到端上线。
