# PI Codex Accounts

独立 Pi 插件：为每个 Git 仓库手动选择两个 ChatGPT 订阅账号槽位之一（`personal` / `work`），用于 Codex。**不是浏览器 ChatGPT 登录切换器，也不保证使用方式符合 OpenAI 条款。**

## 边界与合规

- 仅用于你本人有权使用的账号，复用 **Pi SDK 的 OpenAI OAuth 登录流程**、请求实现及令牌刷新；不收集密码，不提取浏览器 Cookie，不模拟登录或自行实现认证协议。复用该流程不代表本插件获得 OpenAI 认可。
- 不自动检测额度、不轮换账号、不自动续发失败请求、不合并订阅额度、不共享或转售凭证。Pi 本身的普通请求重试策略仍独立生效，重试不会切换账号。
- 多账号、订阅访问及第三方客户端的许可范围，应自行核对当前 [OpenAI 使用条款](https://openai.com/policies/terms-of-use/)、[使用政策](https://openai.com/policies/usage-policies/) 和 [Codex 官方文档](https://developers.openai.com/codex/auth/)；不确定时向 OpenAI 确认。**手动切换也不应被用来规避服务限制。** 本仓库没有进行法律审查或取得官方合规确认。
- 插件不验证两个槽位是否为不同账号，也不验证订阅权益。浏览器可能复用已登录账号；授权时请检查账号，必要时使用不同浏览器配置文件。状态栏显示的是槽位别名，不是经过验证的邮箱或身份。

## 配置与隔离

仓库根目录的 `.pi/codex-accounts.json`（使用宿主的 `CONFIG_DIR_NAME`，重品牌发行版可能不是 `.pi`）：

```json
{
  "version": 1,
  "account": "work"
}
```

`account` 只能是 `personal`、`work` 或 `null`（关闭）。不接受凭证、任意账号名、URL 等额外字段。配置有误时不静默回退到其他账号。

- 从仓库任意子目录启动都使用 `git rev-parse --show-toplevel` 返回的 checkout 根目录；不同 worktree 独立配置。不自动修改 `.gitignore`，建议自行忽略 `.pi/codex-accounts.json`，避免提交个人账号选择。
- 只有信任当前项目后才读取或写入仓库配置。不信任项目或不在 Git 仓库时，不接管原始 Codex 请求。
- 账号凭证由 **当前 Pi 宿主的用户级认证存储**管理，分别使用 `codex-account-personal` 和 `codex-account-work` 键；默认在 `<Pi agentDir>/auth.json`，不在仓库中、不写入会话、不新建插件凭证库。不同仓库共用这两个登录槽位；对同一槽位重新登录或退出会影响使用它的其他会话。
- 每个会话将仓库选择固定在内存中。切换会记住仓库选择，但不强制修改其他已运行会话；它们需要 `/codex-account reload` 或重启才应用磁盘中的新选择。并发写配置采用完整文件原子替换，最后成功发布者决定下次加载的选择，不提供跨会话事务或实时同步。
- Codex 请求使用独立 provider **`codex-accounts/<原模型 ID>`**。保持模型 ID、上下文和推理级别（受模型能力限制），不修改全局默认模型、scoped models 或原始 `openai-codex` 登录。账号切换不是模型版本升级。
- 当前模型是其他 provider（例如 Anthropic 或 OpenAI API）时，只保存仓库选择，不擅自切换模型；之后可用 `/model` 选择 `codex-accounts` 模型。
- 仓库选择生效时，直接选择原始 `openai-codex` provider 的模型请求会被阻止，避免用错账号；先 `/codex-account off` 才能恢复原始登录。若启动时找不到相同模型 ID，会报告错误并阻止原始 Codex 的模型发送，不猜测其他模型。
- 没有仓库配置时不会自动接管；若恢复的旧会话已选择 `codex-accounts`，缺少配置时会要求明确选择账号，不悄悄改用原始登录。

宿主负责 OAuth 到期刷新与持久化，刷新在用户级凭证文件锁下串行执行。请求取消可提前结束等待，但已经开始的令牌轮换可能继续并保存，以免丢失有效 refresh token。切换账号不重放已完成工具，也不重发用户提示词；**之后的请求会将当前对话上下文发送给新账号**。

原始 Codex provider 的认证机制不变；被阻止的原始模型请求在阻止前仍可能触发宿主对原始 OAuth 的刷新。这不等于向模型发送请求。插件不是同用户进程间的安全沙箱，不能阻止其他扩展、宿主配置或同用户程序访问凭证。用户级文件不等于加密保险库；配置校验、路径检查、原子写入也不是完整隐私或安全保证。

## 使用

在仓库根目录临时加载（不会安装或修改个人 Pi 配置）：

```sh
pi -e ./packages/pi-codex-accounts/src/extension.ts
```

在 Pi 中依次登录两个槽位：

```text
/login codex-account-personal
/login codex-account-work
```

这会运行宿主提供的 OpenAI OAuth 流程并修改用户级认证存储。**不要把登录命令放入普通测试。** 不需要先退出或复制原始 `openai-codex` 登录。

```text
/codex-account                  # 菜单选择 personal / work / off
/codex-account use personal     # 当前会话切换，并记住仓库选择
/codex-account use work
/codex-account status           # 槽位登录元数据、当前 provider；不解析令牌
/codex-account reload           # 明确加载磁盘中的选择，包括 off / 已移除的配置
/codex-account off              # 记住 account:null；恢复原始 Codex 登录（须已配置）
```

只允许空闲时切换；请求中不会中断、排队切换或自动重试。关闭时如果无法选择原始登录，保留此前选择并报错。菜单取消、未登录、未信任或写入失败不会发布新配置。状态栏 `ChatGPT: work` 表示仓库槽位；带 `(inactive)` 时当前模型并非仓库 provider。

若自行选择持久安装：

```sh
pi install ./packages/pi-codex-accounts
```

该操作会修改个人 Pi 配置，仓库开发和普通测试不会执行它。也可以按 Pi 的项目级安装流程只在目标仓库加载。

### 退出与清理

- `/codex-account off` 仅关闭仓库选择，不注销两个登录槽位。
- 在宿主中使用 `/logout` 选择 `codex-account-personal` / `codex-account-work` 注销相应槽位；这影响共享该槽位的所有仓库。正在进行的模型请求不会被跨进程撤回。
- 用 `pi remove <pi list 显示的 source>` 卸载。卸载前建议对使用该 provider 的会话执行 `/codex-account off`；否则恢复旧会话需要重新加载插件或手动 `/model`。
- 卸载不会自动删除账号凭证、仓库选择或会话历史；按需单独注销和删除仓库配置。不要通过删除整个用户级 `auth.json` 来清理本插件。

本插件不依赖、也不修改其他插件。仓库原有 `pi-model-fallback` 只匹配 `openai-codex`，**不会为 `codex-accounts` 自动切换到付费 API**。

## 验证

已验证宿主 `@earendil-works/pi-coding-agent@1.4.0` / `1.5.0`，类型构建使用 1.4.0。peer dependency `*` 不代表全版本兼容保证。需 Node.js >=22 和 Git。

在仓库根目录运行：

```sh
npm ci
npm run build --workspace=pi-codex-accounts
npx vitest run packages/pi-codex-accounts/test
PI_SDK_DIR=/absolute/path/to/pi-coding-agent npm run test:sdk --workspace=pi-codex-accounts
```

离线 SDK 冒烟加载真实扩展入口，使用临时 Git 仓库、临时认证存储、假 OAuth 和假模型，并禁止 fetch。验证宿主登录持久化、跨运行时刷新锁、仓库隔离、相同模型 ID、推理级别、scoped models 不变、上下文/工具保留、会话恢复，以及额度错误和注销时不自动换号。普通测试还覆盖配置、原子写入、菜单竞争、取消、信任与错误路径。不会读取个人认证或真实会话，也不调用远程模型。

**真实浏览器 OAuth、两个真实订阅及服务端实际行为尚未验证**，需要另行授权手动验收。离线通过不等于线上效果或合规性得到保证。根目录 `npm run test:sdk` 仍只覆盖 `pi-model-fallback`。
