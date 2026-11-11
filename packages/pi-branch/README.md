# Pi 分支助手（实验版）

纯 `/` 命令，按需操作 Git。没有启动检查、`/new` 拦截、常驻底栏或后台轮询；不创建任务分支、不提交、推送、查询/合并 PR。

## 使用

在仓库根目录运行：

```sh
npm run build --workspace=pi-branch
pi -e ./packages/pi-branch/src/extension.ts
```

持久安装由用户自行选择 `pi install ./packages/pi-branch`；通过 `pi list` 查看来源，`pi remove <source>` 移除。移除插件不会删除已有 stash。测试不会安装到个人 Pi。

### `/branch status`

1. fetch origin（prune、无 tags），随后读取 Git 快照，不切换或修改工作区。
2. 展示当前分支、HEAD、已暂存/未暂存/未跟踪状态；计算相对跟踪分支及 origin 默认分支的领先/落后提交数。
3. 用户确认后，向**当前所选模型**单次请求中文总结，显示本地工作、远端进度和待核实事项。不同意则仅展示 Git 事实。

Git 提供数字，LLM 仅负责解释，没有工具执行权限。没有读取会话历史，也不把 diff 或总结主动注入聊天上下文/写入会话。结果通过通知显示，RPC 宿主可接收到通知。

- origin fetch 失败会标注引用可能过期，不将其冒充最新云端状态；其他远端的跟踪引用明确标注未刷新。
- 没有跟踪分支、引用被删除、默认分支查询失败、无共同历史均标注未知/不可用。
- 默认分支从 `git ls-remote --symref origin HEAD` 读取，不依赖过期的本地 origin/HEAD，不猜测 main/master。支持其他默认分支名。
- 领先/落后按提交祖先关系计算，不判断 squash/cherry-pick 或 PR 是否已经合并。
- 每侧提交说明最多 30 条。Git 状态路径最多 12000 字符；每段证据最多 12000 字符，总证据最多 48000 字符，明确声明可能截断。单个 Git 命令超限则整个结果不用，不把部分输出当成事实。
- 未跟踪文件只读取路径；二进制不分析正文。超限 diff、失败或未包含正文的文件不视为已完整审查。当前尚不为未跟踪新文件生成内容级总结。

### `/branch main`

`main` 是命令名；实际目标是 origin 的默认分支，包括 `master` 或其他名称。

1. 检查状态，fetch origin 并解析默认分支。
2. 展示原分支、目标及是否存在修改，默认选择取消。
3. 干净工作区确认后切换；脏工作区必须明确选择 **stash 修改（含未跟踪文件），回默认分支并更新**。取消、关闭、60 秒确认超时均不 stash/切换。
4. stash 成功后立即显示对象 ID 和恢复命令，确认工作区干净再切换，仅 fast-forward 到本次 fetch 的确切提交。

本地主分支领先或分叉时停止，不 reset、merge commit 或 rebase。原任务分支不删除；不会自动 apply/pop/drop stash，不把原修改恢复到主分支。需要恢复时，先核对并切回原任务分支，再运行通知中的 `git stash apply --index <对象ID>`；成功确认后是否删除 stash 由用户决定。

**失败不是事务回滚**：若 stash 已成功而后续切换/更新失败，stash 保留；若已经切换则留在实际分支，不自动切回。请检查 `git status` 和 `git stash list`。命令超时/会话关闭时也可能已经完成部分 Git 写入。

## 安全边界与限制

- Node.js >=22、Git、macOS/Linux。类型构建验证 SDK `1.4.0`，真实加载/模型接口离线冒烟验证 `@earendil-works/pi-coding-agent@1.5.2`。peer 的 `*` 不是全版本兼容承诺。
- 仅以 Pi `ctx.cwd` 所在仓库为准，不跟踪 Bash 的临时 `cd`。只支持 origin 作为主远端；不支持未产生首次提交的仓库。无 UI 的 print/JSON 模式不执行，TUI/RPC 需要支持 Pi 的 confirm/select 协议。
- fetch 和默认分支查询使用已有 Git 身份访问远端，可能触发既有凭证助手；插件不读取认证文件。Git 自身的配置、hooks、传输程序仍按现有用户权限运行。
- LLM 确认外发范围包括分支/文件路径、提交说明和 tracked diff，可能包含密钥或私有代码，**没有完整脱敏保证**，可能产生模型费用。普通 status 命令在确认前已在内存收集 diff，但不会发送模型。模型总结失败仍保留已展示的 Git 事实。
- stash 不包含 ignored 文件；拒绝进行中的 merge/rebase/cherry-pick 等操作、冲突和含子模块的仓库；其他 worktree 占用分支等由 Git 拒绝。不要依赖 stash 充当完整备份。
- 操作前后检查分支、HEAD、状态；确认期间还比较 tracked diff 指纹和未跟踪文件元数据。大 diff 超过单命令限制时回主分支操作拒绝执行。不是跨进程事务锁：**请勿同时通过编辑器、其他 Pi 或 Git 进程修改同一仓库**。
- 插件内并发命令拒绝执行；agent 忙碌时拒绝操作。单个 Git 命令限时 30 秒、stdout/stderr 各最多 256 KiB；整体操作限时 180 秒，单次模型输出最多 1600 token。会话关闭中止在途操作。无自动重试、自动提交或自动清理。
- 插件不是安全沙箱；仓库数据和 LLM 建议均不是执行授权。真实模型质量和终端视觉效果未验证。

## 验证

根目录执行，合成消息、临时 Git 仓库/本地 bare 远端、假模型，不访问真实模型或 Git 托管平台：

```sh
npm run build --workspace=pi-branch
npx vitest run packages/pi-branch/test
PI_SDK_DIR=/absolute/path/to/pi-coding-agent npm run test:sdk --workspace=pi-branch
```

SDK 冒烟覆盖真实加载、无启动通知、模型确认取消/接受、独立无工具总结请求、回默认分支取消/接受、stash 保管与恢复。根目录 `npm run test:sdk` 不覆盖此包。
