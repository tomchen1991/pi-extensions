# PI 工作洞察：自动输出工作观察 JSON

只做一件事：**从授权的 PI 会话中提取最近工作和协作习惯线索，生成结构化 JSON。**

不负责数据如何使用：不维护长期画像、不跨会话归并、不推荐下一步、不修改主 Agent 提示词、不对接 backend / DeckZ，也不改动 `pi-next-prompt`。

## 输出什么

| 数组 | 内容 |
| --- | --- |
| `recentWork` | 工作主题、目标、背景、进展、报告来源 |
| `decisions` | 用户明确作出的选择、理由、适用范围与临时性 |
| `openLoops` | 未完成、待验证、受阻、待确认或输入中已提出的下一步 |
| `preferenceSignals` | 提示词表达、回答偏好、协作顺序、确认边界、工作方法等线索 |
| `evidence` | 必要短原话、来源条目、角色和未证实的人类来源标记 |

- [完整合成样例](./examples/observation.json)
- [合法空输出](./examples/empty-observation.json)
- [字段与语义契约](../../docs/pi-work-insights/01-contract.md)
- [输出 JSON Schema](./schema/observation.schema.json)
- [模型输出 JSON Schema](./schema/model-output.schema.json)
- [最新指针 JSON Schema](./schema/latest.schema.json)

所有输出都是 `reviewStatus: "unreviewed"`。**授权自动采集不等于用户逐条确认了模型结论。** 不知道的原因/条件等填 `null`，没有线索则返回空数组；不强行生成习惯。

## 启动与授权

在仓库根目录：

```sh
npm install
pi -e ./packages/pi-work-insights/src/extension.ts
```

在 Pi 中，先选择用于提取的模型，再执行：

```text
/insights enable
```

一次确认会展示项目、固定提取模型、配置端点、外发范围、请求额度和输出目录。开启后无需每次手动提取或逐条确认。切换主 Agent 模型不会悄悄切换提取模型；更换提取模型请重新 `enable`。

默认不开启。只验证 Pi **1.4.0** 的 TUI 模式；RPC、JSON、print 模式不采集、不请求模型。本轮没有安装到个人 Pi，也没有读取真实会话或进行真实模型质量验收。

| 命令 | 行为 |
| --- | --- |
| `/insights enable` | 授权当前项目、绑定当前模型并开启自动输出；跨会话生效 |
| `/insights status` | 查看授权、固定模型、输出目录、项目最新指针和取样时间；重载后也可查看，不取消正在进行的请求 |
| `/insights extract` | 立即尝试一次，仍遵守授权、去重和预算 |
| `/insights pause` | 取消本实例任务并持久暂停，阻止其他实例发布旧结果 |
| `/insights forget` | 经确认删除本项目观察 JSON、撤销旧请求并暂停 |
| `/insights cancel` | 仅取消当前定时/请求；后续新任务结束仍可触发自动观察 |

旧 `learn` / `predict` / `list` 等命令已移除。旧习惯/审计实验数据不会被读取、自动迁移或由新 `forget` 删除。

## 自动触发与边界

- `session_start`、正常 `agent_settled`、切换会话树后等待 **10秒**；事件处理器立即返回，不阻塞主模型运行。
- 执行前检查空闲、无排队任务、输入框无草稿。用户新输入、主任务启动、换模型、切树、压缩、关闭或重载会取消旧任务；迟到结果不能写入。
- 每项目请求间隔至少 **2分钟**，每滚动小时最多 **6次**，跨进程/重载保留额度。等待额度时保留一个可取消定时器；失败/取消也消耗请求额度。没有立即自动重试；后续事件或手动请求可以再次尝试。
- 每次最多 **4096输出 tokens**、**45秒**超时。额度是逻辑请求数上限，不是精确金额上限；服务端可能在取消后继续运行和收费。
- 只读当前活动分支，不扫描其他会话或仓库文件。只做有界 Git 根定位；非 Git 使用 cwd realpath，worktree 分开。
- 每次发送最近最多 **30条、16000字符**的可用文本；单条超过4000字符整条省略。超过窗口的旧内容不补发、不做完整历史增量回放。
- 遵守 `context_edit` 删除与替换；排除思考、system prompt、图片、自动摘要、注入消息和任意工具日志。仅允许按 toolCallId 关联的极短 bash 测试计数；文件正文、命令参数和嵌套工具内容不发送。
- 原文进入模型前和结论输出前检查常见秘密。**过滤不完备**，不能当成保密保证；本地保存不等于本地推理。
- 通过 Pi `modelRegistry` 的无工具独立请求提取，复用宿主认证。授权绑定 provider/model/配置路由指纹；配置变化需重新确认，实际服务端路由仍由 Pi/提供商控制。
- 不给主会话发送消息、不运行额外 agent、不占用输入框。usage 记入 JSON，并在状态栏显示；没有并入 Pi 主会话费用统计。

## 输出位置与语义

默认目录：

```text
<getAgentDir()>/work-insights/
└── projects/<projectRef>/
    ├── settings.json                  # 本地授权与请求额度，不是业务输出
    ├── latest.json                    # 指向本项目取样时间最新的成功观察
    └── observations/
        └── <UTC时间>_<observationId>.json
```

可用绝对路径环境变量 `PI_WORK_INSIGHTS_DIR` 更改根目录。SDK 若只通过参数改变了 agentDir，不能假定 `getAgentDir()` 会同步改变；应显式指定插件目录。不要设在公开仓库内。

每个 JSON 是**最近窗口的一次观察**，不是完整工作历史、任务权威状态或删除指令。不同窗口可能重叠、重复或矛盾；插件不解释这些数据如何被使用。

同项目/会话/有效输入窗口/提取版本/模型目的地有固定 `observationId`。已有成功文件（包括空输出）不再请求模型，也不修改其原取样时间。局部记录 ID 只在该 JSON 内有效；源条目 ID 保留以辨认原话，同一引用的重复出现不代表新的独立行为。

新文件名形如 `2026-01-01T00-00-00.000Z_<observationId>.json`，固定 UTC 毫秒格式，可按文件名排序（目录枚举本身不保证有序）。旧版纯哈希文件继续识别和去重，不自动改名。

`latest.json` 是小型指针，不是完整观察正文：包含 `schemaVersion: 1`、`projectRef`、`observationId`、`observedAt` 和 `file`。`file` 是相对于项目输出目录的安全路径，如 `observations/2026-01-01T00-00-00.000Z_<id>.json`。

- 先成功发布观察文件，再在项目锁内原子更新指针。按 `source.observedAt` 比较，不使用完成顺序或文件修改时间；较早请求晚完成也不会覆盖较新指针。同一毫秒以 observationId 字典序确定稳定顺序。
- 指针表示**项目内各会话中取样时间最新的一份成功观察**，不是当前会话的完整状态，更不是全项目汇总。有效空输出也可以成为最新。
- 文件与指针不是一个原子事务；中断可能暂留旧指针。下次成功发布或命中已有相同输入时，从保存的文件修复缺失/滞后指针，不重复调用模型。坏 JSON、非法路径或指向缺失文件的损坏指针会报错，不悄悄猜一个旧文件；应检查文件后再重试。
- `forget` 先移除指针，再清理新旧命名的观察文件。`inspect` 可直接接收真实项目的 `latest.json`，校验目标后输出正文。

`observedAt` 是取样时间，不是用户实际完成工作的时间。恢复旧会话时不把旧工作日期改写成“今天完成”。`projectRef` 是本机规范化项目路径的摘要，不是跨机器的仓库身份。JSON 不包含原会话绝对路径或凭证。

## 本地可靠性与已知限制

- 新目录0700、文件0600；原子文件替换、短事务锁、授权版本校验，防止并发暂停/清除后旧结果复活。
- 每项目最多500个文件、50 MiB，单文件128 KiB。达到上限停止提取，不静默删除历史。
- 不是审计系统或安全沙箱；不保证抵抗同账户恶意进程，不提供完整断电事务恢复。崩溃遗留 `.lock` 时，需先确认没有实例运行，再手动删除；不要抢占活锁。
- 中断写入可能遗留 `.tmp`，它不是成功 JSON。`forget` 会清理本项目输出目录中的这些临时文件。
- 请求完成但写文件前崩溃，后续可能重新付费提取；没有“恰好一次收费”保证。
- `forget` 只清除本机当前插件输出，不能收回发出的请求，不删除原 Pi 会话或其他系统已复制的数据。
- 词句匹配和角色校验不能证明语义真实。`user` 可能来自 RPC/扩展，即使当前在 TUI，输出仍标记 `humanOrigin: "unverified"`。
- 提示词限制模型不泛化项目要求、不推断人格等，但不能以自动测试替代真实质量评估。

停用所有实例后，可以删除专属输出目录完成清理；自定义目录请勿误删其他文件。卸载只需移除扩展加载配置。

## 开发和验证

```sh
npm run build --workspace=pi-work-insights
npm run schema --workspace=pi-work-insights
npm run examples --workspace=pi-work-insights
npx vitest run packages/pi-work-insights/test
PI_SDK_DIR=/absolute/path/to/pi-coding-agent npm run test:sdk --workspace=pi-work-insights
npm run inspect --workspace=pi-work-insights -- /absolute/path/to/observation.json
# 或读取项目最新指针指向的正文
npm run inspect --workspace=pi-work-insights -- /absolute/path/to/project/latest.json
```

普通测试只使用合成文本、假模型和临时目录。SDK smoke 使用实际 Pi TypeScript 加载器和 SessionManager，等待真实10秒去抖，验证自动输出、引用来源、去重和清除，不调用真实模型。

实现模块：`collector.ts` / `observation-input.ts` 采集，`contract.ts` 定义输出，`extractor.ts` 定义提取提示词和单次调用，`storage.ts` 写文件，`extension.ts` 连接事件与授权。没有新增依赖、数据库或后台服务。
