# 仓库开发约定（供 AI 编码助手）

适用于本仓库。先阅读根目录 [README.md](./README.md)，再阅读目标插件的 README、相关源码和测试。不要根据其他仓库或旧会话猜测当前架构。

## 1. Git：所有改动必须走 PR

- **禁止直接提交或推送到 `main`。** 用户说“提交并推送”时，也只能提交和推送任务分支，然后创建 PR。
- 开始修改前检查 `git status`、当前分支及已有差异；不要覆盖、清除或夹带用户/其他任务的修改。
- 从最新 `origin/main` 新建独立分支，例如 `feat/work-observations`、`fix/launcher-readiness`、`docs/project-guidance`。若已有对应任务分支，可继续使用。
- 一个任务一个分支、一个清晰的 PR。不要把新任务混入无关 PR；有前置 PR 时，先查询其合并状态，不能仅凭本地分支名判断。
- 用户授权提交/推送后，检查暂存差异，只暂存任务涉及的文件；推送任务分支，PR 目标为 `main`。
- **未经用户明确允许，不合并 PR、不开启自动合并、不强推共享历史。** 不擅自回滚已推送的提交、删除分支或执行破坏性工作区清理。
- 完成后报告分支、提交、PR 链接及是否已合并；不要把“已开 PR”表述成“已上线/已合并”。

## 2. 项目边界

这是 npm workspaces 管理的独立 Pi 插件集合，不是 Cocoon、DeckZ 或 backend 主 Agent 的实现仓库。

| 目录 | 当前职责 |
| --- | --- |
| `packages/pi-token-usage/` | 只采集加载后主 Agent 新响应的三类 Tokens（缓存输入、非缓存输入、输出）及项目、实际模型/供应商、UTC 精确时间；不存会话维度、不做报表/看板/数据库接入或历史回填 |
| `packages/pi-work-insights/` | 自动生成最近工作、决策、未闭环事项、偏好线索和证据的 JSON；不管理画像、不预测下一句、不对接 backend |
| `packages/pi-next-prompt/` | 单次生成下一句提示词，显示灰字，由用户接受/编辑后发送 |
| `packages/pi-model-fallback/` | Codex 明确额度耗尽后的会话级 OpenAI 官方 API 同 ID 模型切换与续接；不管理认证、不改全局模型或 scoped models |
| `packages/pi-branch/` | 仅 `/branch status` 的 Git/LLM 总结及 `/branch main` 交互确认后的默认分支 fast-forward 更新；脏工作区须授权 stash，无自动启动检查、提交、推送或 PR 合并 |
| `packages/pi-codex-accounts/` | 按 Git 仓库手动选择两个用户级 ChatGPT OAuth 登录槽位；复用宿主认证、不复制默认登录、不做额度轮换或自动续发 |
| `docs/pi-work-insights/` | 工作洞察目标及输出语义契约 |

协作与监控属于 Cocoon 侧能力，不在本仓库维护。不要在这里重新加回它们的插件或协议文档；宿主如何接入工作洞察由宿主项目负责，本仓库只维护插件接口与契约，不能凭其他仓库的旧提交猜测其当前实现。

未经本次任务明确要求，不扩大这些职责、不新增跨插件集成或改动其他项目。涉及需求边界变化时，先确认需求并同步相应文档，而不是保留互相矛盾的实现说明。

## 3. Pi 接口与代码组织

- 修改 Pi 扩展行为前，阅读实际使用 SDK 的 `docs/extensions.md`、`docs/packages.md` 及相关示例/类型；会话、UI、模型调用等按需继续读对应文档。
- SDK 路径由实际安装或 `PI_SDK_DIR` 确定，不把开发者机器的绝对路径写入源码或测试。当前使用 `@earendil-works/*`，不要直接照搬其他包名或旧版本 API。
- `peerDependencies` 的 `*` 不是兼容性保证；对外只声明已验证的能力/版本，接口变化需有回归验证。
- Pi 提供的宿主包按 SDK 要求声明为 peer dependencies，不打包第二份宿主运行时；新增其他运行依赖需在对应包中明确声明。
- 每个插件保留独立 `package.json`、manifest、入口和 README；不要通过工作区外绝对路径或未声明的兄弟包源码导入建立隐式依赖。
- 只改任务必需的代码。遇到其他插件的失败先记录和定位，不借机扩大重构或混合提交。

## 4. 数据、隐私与操作授权

- 未获明确授权，不安装到个人 Pi、不改个人配置、不启用真实采集、不启动持久后台服务。
- 不读取或复制真实个人会话、认证文件、密钥或工作观察输出来制作测试。使用合成消息、假模型和临时目录。
- 普通测试与 SDK 冒烟不得请求真实模型。benchmark、付费 API、真实质量验收须单独确认，不因用户要求“跑测试”就执行。
- 区分开发操作授权与插件运行时授权：实现自动提取功能，不代表可以在开发者的真实会话中自动开启。
- 不在日志或提交中泄漏凭证、真实会话、完整模型请求/响应或个人敏感路径；排错优先使用错误码、数量、合成案例和有界诊断。
- 工作洞察产物保持未审核观察语义；不得把模型推断、助手建议、工具成功或 `role=user` 自动升级为用户确认、稳定画像或执行授权。
- 插件不是同账户进程之间的安全沙箱。不要把正则过滤、Schema 校验或本地保存宣传为完整隐私/真实性保证。

## 5. 验证与测试

在仓库根目录执行。测试入口详见 [README.md](./README.md)。

- 安装依赖使用 `npm ci`；改依赖时才同步相应 manifest 和根锁文件，避免无关升级。
- `npm test` 先构建所有包，再运行全仓 Vitest。定向测试前也要构建其依赖的 `dist/`，避免测到过期 JavaScript。
- 常用定向入口：
  - Token 采集：`npx vitest run packages/pi-token-usage/test`；离线 SDK 冒烟为 `npm run test:sdk --workspace=pi-token-usage`（仅合成消息、假模型和临时输出）
  - 工作洞察：`npx vitest run packages/pi-work-insights/test`
  - 下一句建议：`npx vitest run packages/pi-next-prompt/core.test.ts`
  - 额度切换：`npx vitest run packages/pi-model-fallback/test`；离线 SDK 冒烟为 `npm run test:sdk --workspace=pi-model-fallback`
  - 分支助手：`npx vitest run packages/pi-branch/test`；离线 SDK 冒烟为 `npm run test:sdk --workspace=pi-branch`（临时 Git/本地远端和假模型）
  - 账号选择：`npx vitest run packages/pi-codex-accounts/test`；离线 SDK 冒烟为 `npm run test:sdk --workspace=pi-codex-accounts`（仅假 OAuth，不运行真实登录）
- 涉及真实 Pi 加载、会话事件、TUI 或模型接口时，按变更范围运行对应的离线 SDK 冒烟。**根目录 `npm run test:sdk` 只覆盖额度切换插件**，不覆盖工作洞察、下一句建议、账号选择和分支助手；账号选择和分支助手使用各自包内 `test:sdk`，工作洞察使用其包内 `test:sdk` / `test:rpc` / `test:auto`，下一句建议使用 `node packages/pi-next-prompt/sdk-test.mjs`。
- 涉及异步、取消、进程启动或文件发布时，补充故障/竞争回归。等待真实就绪信号并设置明确超时；提前退出及时报错，不靠跳过断言或无界重试掩盖问题。
- 文档改动至少核对相对链接、文件路径和命令对应的脚本；不必为纯文档变更擅自启动个人 Pi 或付费模型。
- 如实区分“已通过”“失败”“未运行”“真实效果未验证”。记录失败的具体测试及现象，不未经定位就断言与修改无关；无法运行的验证明确说明原因。

## 6. 协议、生成文件与提交范围

- Token 采集 v1 契约以 `packages/pi-token-usage/src/record.ts` 和包内 README 为准；改三类计数、项目身份、完成时间/小时桶或原子发布语义须同步测试和文档，不擅自增加会话/正文采集或数据库对接。
- 工作洞察输出以 `src/contract.ts`、`src/storage.ts` 中的运行时定义和 `docs/pi-work-insights/01-contract.md` 为准；调整结构、身份、引用、时间排序或 `latest.json` 语义时同步文档和测试。
- 更新受控产物：先构建 `pi-work-insights`，再运行其 `schema`、`examples` 脚本，并检查生成结果。不要只手工改 JSON Schema/样例而漏掉源定义。
- `schema/`、`examples/` 是需要随源定义提交的协议产物，样例必须是合成数据。
- `node_modules/`、`packages/*/dist/`、临时输出和本地 `*.tgz` 不提交；不要为了方便测试把真实输出目录搬进仓库。
- 不擅自发布 npm、覆盖已交付归档或更新其他项目的 vendor/依赖。包的兼容入口和分发约定见各包 README。从本仓库移除插件不会删除其他项目已经纳入的归档或 vendor 副本。
- 提交前检查 `git diff --check`、暂存文件列表和差异；提交说明与 PR 描述应清楚说明范围、验证结果和限制。
