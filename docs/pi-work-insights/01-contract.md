# 工作观察 JSON：字段与语义契约 v0.1

本文件定义插件**输出什么**，不定义数据如何导入、检索或使用。

运行时定义：[`src/contract.ts`](../../packages/pi-work-insights/src/contract.ts)。机器可读结构：[`observation.schema.json`](../../packages/pi-work-insights/schema/observation.schema.json)。完整示例：[`observation.json`](../../packages/pi-work-insights/examples/observation.json)。

## 1. 封装与来源（程序填写）

| 字段 | 含义 |
| --- | --- |
| `schemaVersion` | 当前固定为字符串 `"0.1"` |
| `observationId` | 当前项目、会话、有效输入摘要、提取版本和模型目的地的固定 SHA-256 标识 |
| `reviewStatus` | 固定 `unreviewed`；项目授权不是对模型产物的逐条认可 |
| `source.producer` | 固定 `pi-work-insights` |
| `source.projectRef` | 本机 Git 根目录或非 Git cwd realpath 的摘要；不是全局仓库 ID |
| `source.sessionRef` | 项目、Pi session ID 和宿主会话文件位置的组合摘要；允许内存会话 |
| `source.branchRef` | 本次采集的活动叶节点 ID，不能视为永久分支 ID |
| `source.observedAt` | 取样时间，ISO UTC；不是工作发生/完成日期 |
| `source.inputDigest` | 本次实际提供给模型的有序 entryId/actor/text 摘要 |
| `source.entryRefs` | 本次输入的原始条目 ID，最多30个 |
| `source.coverage` | `complete` / `partial`：是否省略了可观察的分支内容；不代表了解了完整项目 |
| `source.omissionReasons` | 省略原因，不附带被省略原文 |
| `extraction` | provider、model、extractorVersion、destinationRef、inputTokens、outputTokens |

`destinationRef` 是模型和配置路由指纹，不包含明文凭证。`inputTokens` / `outputTokens` 来自宿主 usage，不是费用或主会话总用量。

五个内容数组全部必填，允许为空。一次最多12条内容记录、16条证据。各记录 `id` 在本次 JSON 内唯一，跨 JSON 没有相同业务实体的含义。`evidenceIds` 必须指向本次存在的证据，不能引用外部文件或旧输出。

## 2. recentWork：最近工作

| 字段 | 含义 |
| --- | --- |
| `id` | 局部 ID，例如 `work-1` |
| `topic` | 一句话说明在做什么，最多120字符 |
| `goal` | 想达成的目的；未知 `null` |
| `context` | 业务背景或必要上下文；未知 `null` |
| `progress` | 当前进展；未知 `null`。不要输出修改文件流水账 |
| `status` | `planned` / `in_progress` / `blocked` / `reported_done` / `unknown` |
| `verification` | `user_reported` / `assistant_reported` / `tool_observed` / `unknown` |
| `evidenceIds` | 1–5个证据引用 |

`verification` 表示报告依据，不是验证等级或成功保证。`assistant_reported` 仅说明助手声称如此；`tool_observed` 只能说明提供的工具片段，不能证明业务验收。没有 `verified` 或“用户已确认完成”这个自动生成状态。

例：助手说“接口修改完成”，用户说“手机端尚未验收”，可记录 `in_progress` 和受限的进展说明，不能写成整个需求已完成。

## 3. decisions：明确决定

| 字段 | 含义 |
| --- | --- |
| `id` | 局部 ID |
| `workRef` | 本次 `recentWork.id`，无法关联为 `null` |
| `choice` | 用户明确选择了什么，保留限制条件 |
| `reason` | 明确表达的原因；未提供为 `null`，不能替用户编动机 |
| `scope` | `task` / `project` |
| `temporary` | `true` / `false` / `null`；未知不能假设永久 |
| `evidenceIds` | 必须包含 user-role 证据 |

助手建议“引入 Redis”，用户尚未回答，不是决定。用户说“暂时不用 Redis，先用 SQLite”，可以记录临时的项目选择，但不能推断“用户永远不喜欢 Redis”。

这里的“用户”是会话角色，不保证独立人类来源；须结合 `evidence.humanOrigin` 看待。

## 4. openLoops：未闭环事项

| 字段 | 含义 |
| --- | --- |
| `id` | 局部 ID |
| `workRef` | 本次 `recentWork.id` 或 `null` |
| `description` | 未完成或需要继续关注的事项 |
| `kind` | `unfinished` / `pending_validation` / `blocked` / `waiting_for_user` / `next_step` |
| `origin` | `user_explicit` / `assistant_proposed` / `inferred` |
| `evidenceIds` | 1–5个证据引用 |

只记录对话中已存在的事项，不生成新的任务建议，不猜负责人、截止日期或授权。

`user_explicit` 必须有用户原话；助手提出的后续工作标为 `assistant_proposed`，不能升级为用户计划；模型推断明确标为 `inferred`。

## 5. preferenceSignals：偏好线索

| 字段 | 含义 |
| --- | --- |
| `id` | 局部 ID |
| `category` | `prompting` / `collaboration` / `workflow` |
| `aspect` | 下表中的偏好维度 |
| `condition` | 适用条件；未知 `null`，不能擅自写“始终” |
| `preference` | 观察到的具体偏好，不输出性格标签 |
| `scope` | `task` / `project` / `user_candidate` |
| `basis` | `explicit_statement` / `observed_pattern` |
| `evidenceIds` | 证据引用；明确表达至少1条用户消息，行为模式至少2条不同用户消息 |

| aspect | 观察什么 |
| --- | --- |
| `input_style` | 提问和组织提示词的方式，例如分步补充、先目标后细节 |
| `response_detail` | 回答的简洁/详细程度 |
| `response_format` | 表格、示例、结论优先等输出形式 |
| `execution_order` | 先讨论、先计划、先原型，还是直接实施 |
| `change_scope` | 最小修改、不顺手重构等范围偏好 |
| `confirmation_boundary` | 哪些动作希望先确认；不能直接当作执行授权 |
| `verification_style` | 用户要求的测试/检查方式 |
| `tooling` | 对工具或技术使用方式的偏好，保留项目和临时条件 |
| `other` | 上述分类无法表达，但有明确证据的协作偏好 |

这是 **signals**，不是最终画像：

- `explicit_statement`：用户明确说“以后简短汇报结果”。
- `observed_pattern`：当前窗口中有多条可观察的用户行为；两条来自同一 entry 的引用不算重复行为。
- `user_candidate` 只表示可能超出本任务的个人候选，不代表全局、稳定、已确认。
- 不把一次短提问推断成永久简洁偏好；不把接受插件建议当成新的独立习惯证明。
- 不跨会话累计频率、不计算习惯强度、不推断人格、情绪、能力或敏感个人属性。

## 6. evidence：必要短引用

| 字段 | 含义 |
| --- | --- |
| `id` | 局部证据 ID，例如 `e1` |
| `entryRef` | 本次实际输入中的原始条目 ID |
| `quote` | 最多300字符的连续原话，不是改写的摘要 |
| `role` | `user` / `assistant` / `tool`，由采集器填写 |
| `humanOrigin` | user-role 为 `unverified`，其他为 `not_applicable` |

模型只填写 `id` / `entryRef` / `quote`，不能自行填写角色或证明人类身份。程序检查 quote 是过滤后输入的真实子串，拒绝虚构条目、错引、重复 ID、无引用记录、无用途证据和越界 workRef。

不输出完整聊天、工具命令参数、文件转储、思考或图片。工具证据只保留受限测试计数，不是独立业务验收证明。

## 7. 按时间命名与最新指针

观察正文结构和 `observationId` 算法不变。新文件名为 `<UTC时间>_<observationId>.json`，例如 `2026-01-01T00-00-00.000Z_<id>.json`。UTC 时间来自 `source.observedAt`，规范化到毫秒；不是请求结束时间或文件 mtime。纯哈希旧文件仍可读取、去重和清除。

项目目录新增 `latest.json`，结构由 [`latest.schema.json`](../../packages/pi-work-insights/schema/latest.schema.json) 定义：

| 字段 | 含义 |
| --- | --- |
| `schemaVersion` | 指针格式版本，当前数字 `1`，独立于观察正文版本 |
| `projectRef` | 所属项目 |
| `observationId` | 目标观察的固定 ID |
| `observedAt` | 目标观察的取样时间 |
| `file` | 相对项目目录的目标路径，仅允许 `observations/<合规文件名>.json` |

观察成功写入后，在同一个项目写锁内按取样时间选择最新文件并原子替换指针。较早请求晚完成、重复提取旧窗口、修改旧文件的 mtime 都不能把它提升成最新。同一毫秒以 observationId 字典序决定稳定顺序。有效空输出不被跳过。

这是**项目内最新取样的一份成功观察**，不是当前分支或整个项目的完整汇总。指针不复制正文，不改变观察来源或结论。读取时应验证指针与目标的项目、ID、时间及文件名一致；损坏时不静默回退旧文件。

两个文件的发布不是单一原子事务；中断可留下已保存观察和缺失/滞后的指针。后续成功发布或命中已有输入会扫描文件名（旧格式读取其时间）修复，不必重新请求模型。清除项目输出时先删除指针，再删除观察文件。

## 8. 不是审计证明，也不是增量数据库

- JSON Schema 校验形状；`validateObservation()` 额外校验 ID、交叉引用和角色约束；`buildObservation()` 还检查引用是否匹配本次实际输入。
- 这些检查不能证明自然语言解释正确，也不能证明 user-role 来自人类。
- 每个文件是有界最近窗口的观察；窗口可能重叠、出现重复原话、遗留旧说法或互相矛盾。
- 空数组表示本次没提取到对应内容，不表示删除了旧事实。窗口里没出现某项，也不表示该项已结束。
- 相同有效输入的成功文件不重新提取；记录内容不会因为主 Agent 新说一句“完成”就自动获得更高真实性。
- 本协议不规定任何画像、记忆、推荐、检索、归并或后端存储策略。
