# Pi Token 用量采集

只采集加载后新发生的主 Agent 响应用量，落盘为独立的版本化 JSON 事件，供后续看板或每日 ETL 使用。**不做报表、聚合、数据库连接、定时任务或会话管理**，不依赖外部统计工具。

## 开启与范围

加载本插件即启用本地采集，适用于 TUI、RPC、print/JSON 模式。不发起模型调用、不上传数据；开发测试不会安装到个人 Pi。

```sh
# 在仓库根目录，仅本次启动加载（用户自行执行）
pi -e ./packages/pi-token-usage/src/extension.ts

# 可选持久安装（会修改个人 Pi 包配置）
pi install ./packages/pi-token-usage
```

默认输出：`<Pi agentDir>/token-usage/`，通过宿主 `getAgentDir()` 获取，遵循宿主 agentDir 配置。可用环境变量覆盖，必须是绝对路径：

```sh
PI_TOKEN_USAGE_DIR=/absolute/path/to/token-usage pi -e ./packages/pi-token-usage/src/extension.ts
```

卸载使用 `pi remove <source>`（以 `pi list` 为准），重启或重载后停止采集；已落盘数据不会自动删除。没有后台服务或自动清理。

## v1 事件契约

每个新 `message_end` 的 assistant 响应产生一条记录。工具调用前的 assistant 响应也计入；失败、取消时如 SDK 提供用量，同样记录并标注 outcome。跳过 pending/deferred 中间响应、用户消息及工具结果。

输出布局：`events/YYYY-MM-DD/HH/<id>.json`，日期与小时均为 **UTC**。记录完成后不再修改，消费者递归读取 `events/**/*.json` 即可。

合成示例：

```json
{
  "schemaVersion": 1,
  "id": "cdde87e5-1e3b-4a21-a186-b08d91febd80",
  "source": "assistant_message_end",
  "completedAt": "2026-06-01T12:34:56.789Z",
  "hourStart": "2026-06-01T12:00:00.000Z",
  "project": {
    "id": "32d71e3be5751f2db3d099dd63c7ea4f20b263b6754e9930d002a9b2b0750416",
    "name": "example-project",
    "path": "/synthetic/example-project"
  },
  "provider": "synthetic-provider",
  "model": "synthetic-model",
  "outcome": "stop",
  "tokens": {
    "cachedInput": 700,
    "uncachedInput": 130,
    "output": 20
  }
}
```

- `id`：采集事件 UUID。未来 PostgreSQL 可用它作主键并 `ON CONFLICT DO NOTHING`；不是会话 ID，也不是供应商请求 ID。
- `completedAt`：本插件收到响应完成事件时的 UTC 毫秒时间，**不是请求开始时间**。跨小时请求全部归入完成小时；不估算每个 Token 的产生时间。
- `hourStart`：完成时间向下取整到 UTC 小时，便于直接按小时聚合。需要当地时区时由消费者转换，避免 DST 重复小时歧义。
- `project.id`：规范化绝对项目路径的 SHA-256（完整 64 位十六进制）。`path` 是 Git 根目录；不在 Git 仓库内或 Git 查询失败时使用规范化 cwd。子目录和符号链接归到同一根目录。项目解析在首次响应时执行，按 cwd 缓存；Git 查询超时 3 秒。
- 同名不同路径项目分开；Git worktree、不同 clone、移动后的目录也分开。不查询远端 URL，不试图跨机器关联项目。若运行中 Git 根目录发生变化，应重载插件刷新缓存。
- `provider` / `model`：取自实际响应，不取当前 UI 选中的模型，因此切换或 fallback 后不会错误归因到原模型。
- `outcome`：SDK 的 stopReason（例如 stop、toolUse、length、error、aborted）。不保存错误正文。

### 必须互斥的三类 Tokens

| 字段 | Pi SDK Usage 映射 | 含义 |
| --- | --- | --- |
| `cachedInput` | `cacheRead` | 命中缓存的输入 |
| `uncachedInput` | `input + cacheWrite` | 未命中输入，含首次写入缓存的部分 |
| `output` | `output` | SDK 记录的输出（含其计入输出的 reasoning） |

Pi 已将缓存输入从 `input` 中分离，**不能再次从 `input` 扣除 cacheRead**。缓存写入不等于缓存命中，所以合入非缓存输入；三类之和对应 SDK 四类计数之和。不保留单独的 cacheWrite 子项，因此 v1 不支持还原缓存写入加价或精确重算费用；目前不存费用。

计数必须是非负安全整数；缺失、非法值和相加溢出拒绝落盘并告警，不擅自补零或推算。SDK 某些供应商会把“未返回用量”初始化为 0；本插件无法区分这种默认零和真实零，零记录不能作为零消耗的保证。

## 发布、并发与消费约定

- 每条记录独立文件，避免多进程竞争改写同一个小时汇总或 JSONL 尾部损坏。
- 在同目录创建 `0600` 临时文件，完整写入、fsync 并关闭后，以 hard link 原子发布 `.json`，禁止覆盖已有文件；新建目录使用 `0700`。
- 需要支持同文件系统 hard link 的本地文件系统；不保证网络文件系统语义，不提供不安全的覆盖写回退。既有目录权限不会被修改。
- 消费者只读 `.json`，忽略隐藏 `.tmp`。进程中断可能残留临时文件，不会自动删除历史文件。没有声称掉电后目录项持久化或端到端 exactly-once。
- 响应完成事件的写入被 await，正常退出不依赖定时 flush。主流程不因采集失败而中断，但会显示有界告警；无 UI 时写 stderr，不污染 JSON stdout。失败事件无自动持久队列重试，可能缺记录。
- 只观察实时事件，不扫描真实会话、不回填历史。resume/fork/reload 不重记旧消息；同一插件实例对同一个消息对象重复投递只写一次。不保证宿主跨实例重新投递的去重。
- 导入端以 `id` 幂等，不以时间、模型和计数去重（两个真实响应可能完全相同）。历史文件不可变，但当前小时仍可出现新文件；每日任务须回扫迟到窗口或维护已导入 ID，不能只按目录“处理一次”。

## 数据边界与限制

保存项目名称和本机绝对路径、时间、模型、供应商、三类计数和结果状态。**不保存会话 ID、提示词、回答、工具参数、认证信息、供应商响应 ID 或原始错误**。路径本身也可能敏感，导出前自行检查。插件权限等同于 Pi 用户，不是安全沙箱。

采集覆盖主 Agent 的 assistant message_end，**不是整台机器／账号的完整账单**：压缩、树摘要、缓存预热、其他插件直接调用模型、子进程、工具内部模型调用不保证经过该事件。工具汇总用量通常缺少实际模型／供应商维度，本版不把它错误归到当前模型。未经加载或进程崩溃前未收到的用量无法恢复。

## 开发验证

在仓库根目录运行：

```sh
npm ci
npm run build --workspace=pi-token-usage
npx vitest run packages/pi-token-usage/test

# 指向已安装 SDK 包根目录；真实加载器 + 假模型 + 临时输出，不访问个人会话
PI_SDK_DIR=/absolute/path/to/pi-coding-agent npm run test:sdk --workspace=pi-token-usage
```

已通过 `@earendil-works/pi-coding-agent@1.4.0` 和 `1.5.2` 的离线 SDK 冒烟（类型构建使用 1.4.0）。peerDependencies 的 `*` 不表示全版本兼容。没有引入新的运行时依赖。
