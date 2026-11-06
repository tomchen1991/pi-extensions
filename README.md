# 自用 PI 插件

独立维护的 Pi 插件工作区，使用 npm workspaces。每个插件拥有独立 manifest、入口和说明；当前均为私有包，尚未发布 npm。不依赖 Cocoon/Electron，也不会因运行仓库测试而自动安装到个人 Pi。

本仓库保留可独立使用的公共插件：工作洞察、下一句建议和模型额度切换。协作和监控不在本仓库维护，属于 Cocoon 侧能力；本仓库不提供 Cocoon/Electron 宿主实现。

AI 编码助手开始工作前请阅读 [AGENTS.md](./AGENTS.md)。所有改动通过独立分支和 PR 合并，禁止直接推送 `main`。

## 插件与边界

| 插件 | 职责 | 开启方式与成本 |
| --- | --- | --- |
| [PI 工作洞察](./packages/pi-work-insights/README.md) | 输出最近工作、决策、未闭环事项、提示词/协作偏好线索与短引用的 JSON；不负责画像、推荐或 backend 使用 | 普通 Pi 默认关闭，须 `/insights enable` 并确认；宿主可选用 `--work-insights-auto` 自动采集、无确认弹窗，可能产生模型费用 |
| [下一句自动建议](./packages/pi-next-prompt/README.md) | 单次生成下一句提示词，输入框灰字展示，Tab 接受，不自动发送 | 加载后在正常回复结束时使用 `deepseek/deepseek-flash`，每次建议额外调用一次模型 |
| [模型额度切换](./packages/pi-model-fallback/README.md) | Codex 明确额度耗尽后，会话级切换到 OpenAI 官方 API 同 ID 模型并续接；无需加入 scoped models，信息不足时不自动切换 | 加载即启用，触发后按 API 计费；使用已有 OpenAI 配置 |

插件权限等同于运行 Pi 的操作系统用户，不是安全沙箱。真实试用前请阅读各包的数据范围、模型外发、安装及清理说明；“本地保存”不等于“本地推理”。

## 环境与准备

- macOS / Linux，Node.js **>=22**，npm。
- 实际使用插件需要安装 Pi CLI；支持的 SDK/API 范围以各插件 README 为准。工作洞察当前验证版本为 `@earendil-works/pi-coding-agent@1.4.0`；额度切换当前验证版本为 `@earendil-works/pi-coding-agent@1.4.0` 和 `1.5.0`（类型构建使用 1.4.0），不能把 peer dependency 的 `*` 当作全版本兼容保证。
- 下列命令均在仓库根目录运行，除非明确说明其他目录。

```sh
npm ci
npm run build
```

`npm ci` 安装工作区依赖；`npm run build` 构建/检查各包。二者不等于 `pi install`，不会修改个人 Pi 配置，也不会授权工作洞察采集。

## 试用与安装

### 仅本次 Pi 启动加载

按需选择一个入口，不必全部加载：

```sh
# 工作洞察：进入 Pi 后用 /insights enable 明确授权，再开始自动提取
pi -e ./packages/pi-work-insights/src/extension.ts

# 下一句建议：需配置 DeepSeek；加载后生成建议会调用模型
pi -e ./packages/pi-next-prompt/extension.mjs

# 额度切换：加载即可能在 Codex 额度耗尽后按 OpenAI API 计费
pi -e ./packages/pi-model-fallback/src/extension.ts
```

### 持久安装（用户按需执行）

例如：

```sh
pi install ./packages/pi-work-insights
pi install ./packages/pi-next-prompt
pi install ./packages/pi-model-fallback
pi list
```

`pi install` 会修改个人 Pi 的包配置；不要把它当成测试准备步骤。移除时使用 `pi remove <source>`，其中 source 以 `pi list` 显示的配置为准。安装、重载和清除数据的细节见各插件 README；移除包不等于删除它已生成的数据。

工作洞察默认输出到 `<Pi agentDir>/work-insights/projects/<projectRef>/`，包含时间命名的 `observations/` 和 `latest.json` 指针；可通过 `/insights status` 查看实际位置。不要把真实输出放进本仓库，参考[输出契约](./docs/pi-work-insights/01-contract.md)。宿主如需无确认弹窗的自动采集，见[宿主接入契约](./docs/pi-work-insights/02-rpc-integration.md)；宿主实现不属于本仓库。

## 仓库结构

```text
packages/
  pi-work-insights/    # 自动工作观察 JSON 生产者；含源码、Schema、合成样例及测试
  pi-next-prompt/      # 下一句灰字建议，JavaScript 扩展
  pi-model-fallback/   # Codex 额度耗尽 → 官方 API 同模型；会话级切换及离线测试
docs/pi-work-insights/ # 工作洞察目标和输出契约
artifacts/             # 本地打包产物目录；*.tgz 默认忽略
```

各包的 `dist/` 是构建产物，不入库。工作洞察的 `schema/` 和 `examples/` 是受版本控制的协议产物，只包含合成数据，按脚本生成。

## 测试

### 全仓构建和普通测试

```sh
npm test
```

该命令先构建所有包，再运行 Vitest。普通测试使用合成数据、临时目录和假模型，不调用远程模型。

定向排查时先确保需要的 `dist/` 已构建：

```sh
npm run build
npx vitest run packages/pi-work-insights/test
npx vitest run packages/pi-next-prompt/core.test.ts
npx vitest run packages/pi-model-fallback/test
```

### 真实 SDK 冒烟（模拟模型，无付费模型请求）

`PI_SDK_DIR` 必须指向实际安装的 `@earendil-works/pi-coding-agent` **包根目录**，其中包含 `dist/`，不是 `pi` 可执行文件路径。

```sh
export PI_SDK_DIR=/absolute/path/to/pi-coding-agent

# 根目录 test:sdk 只运行额度切换插件，不是全仓 SDK 测试
npm run test:sdk

# 下一句建议的加载器和编辑器冒烟
node packages/pi-next-prompt/sdk-test.mjs

# 额度切换：真实 SDK + 假模型，无真实 API 调用
npm run test:sdk --workspace=pi-model-fallback

# 工作洞察的 TUI 加载、自动提取、最新指针与去重冒烟；含真实10秒去抖等待
npm run test:sdk --workspace=pi-work-insights

# 工作洞察的真实 RPC 子进程/确认协议；假 provider，约75秒（含60秒超时）
npm run test:rpc --workspace=pi-work-insights

# 宿主自动模式 TUI/RPC 冒烟：零确认弹窗，假 provider
npm run test:auto --workspace=pi-work-insights
```

SDK 冒烟不等于真实模型效果验收。真实试用、benchmark 或模型质量评估须另行明确授权，不能混入默认测试流程。

### 更新工作洞察协议产物

```sh
npm run build --workspace=pi-work-insights
npm run schema --workspace=pi-work-insights
npm run examples --workspace=pi-work-insights
npx vitest run packages/pi-work-insights/test
```

运行时定义、生成 Schema、合成样例和字段文档应同步更新；产物一致性由测试检查。

## 分支与 PR 流程

1. 检查 `git status`，保留已有修改；从最新 `origin/main` 新建 `feat/...`、`fix/...` 或 `docs/...` 分支。
2. 一个任务一个分支，只提交与任务相关的文件，不顺手修复或重构其他插件。
3. 运行相关验证，在 PR 里说明改动、测试命令/结果和未验证内容。仅文档变更也要检查链接、路径和命令。
4. 提交并推送**任务分支**，创建以 `main` 为目标的 PR；“提交并推送”不意味着允许直接推送 `main`。
5. 等用户审阅并明确允许合并；不得自行合并、开启自动合并或强推共享历史。任务有前置 PR 时，先确认它已经合并。

本仓库暂未配置 GitHub Actions，不能把“没有 CI 失败”当成测试已通过。具体开发约束见 [AGENTS.md](./AGENTS.md)，功能与数据细节以各包文档为准。
