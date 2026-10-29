# PI协作

普通 Pi 的本机协作插件，迁移自 cocoon 的 DeckZ PI collaboration。独立 broker 与 DeckZ broker 相互独立，不互通；同时提供共享 service 与兼容扩展入口供 DeckZ 去重接入。

## 快速开始

要求 macOS/Linux、Node.js >=22、PATH 上可用的 Pi >=1.1（`@earendil-works/pi-coding-agent` API）。

在本仓库根目录执行一次：

```sh
npm ci
npm run build
```

终端 1 保持中继运行：

```sh
node /absolute/path/to/pi-extensions/packages/pi-collaboration/cli.mjs broker
```

终端 2、3 分别进入各自项目，再加入同一组：

```sh
node /absolute/path/to/pi-extensions/packages/pi-collaboration/cli.mjs join 我的组 后端
node /absolute/path/to/pi-extensions/packages/pi-collaboration/cli.mjs join 我的组 前端
# 额外 Pi 参数置于 -- 后，例如：
node /absolute/path/to/pi-extensions/packages/pi-collaboration/cli.mjs join 我的组 审查 -- --model your-model
```

工作区安装后也可使用 `node_modules/.bin/pi-collab`。启动器会显式加载扩展，不要求全局安装。可选 `pi install /absolute/path/to/pi-extensions/packages/pi-collaboration`；单独安装不会自动加入任何组。未通过启动器加入时扩展不注册工具、不启动定时器。

在 PI 内 `/collab` 查看同组成员；让模型先使用 `pi_collaboration` 的 `list`，再用完整会话 ID `send`，用 `status` 查看回执。组名和会话名最多 40 字符，同组名字不能重复；项目显示名来自启动目录名。

退出 Pi 即离开并撤销凭证；`/new`、`/resume`、`/reload` 会更换通信 ID，但不重置本次启动发送预算。暂不支持在已运行的普通 Pi 内 `/collab join`，也不提供模型可调用的加入或续额接口。

## 行为与安全边界

- broker 仅绑定 `127.0.0.1` 随机 HTTP 端口；加入入口为 `~/.pi/collaboration/broker.sock`，父目录必须属于当前用户且权限为 `0700`。
- 每个启动器通过持有的控制连接获得独立随机 token；连接关闭即撤销。token 不写文件、不作为命令行参数，扩展加载后从环境删除，保留于进程内存以支持 reload。
- **不是同 OS 用户进程之间的安全沙箱。** 本地代码/模型 shell 可访问同用户资源；组隔离不是针对同用户恶意程序的访问控制。不要把不可信代理当作已隔离租户。
- 消息内容仅在内存中转，接收后进入接收方 Pi transcript；broker 重启会丢失队列与身份，所有成员需重新启动加入。
- 伙伴消息明确标为非用户授权；不群发、不转发、不自动重试发送错误、不互相发送无意义确认。
- 8 KiB/消息、10 条/分钟、50 条/启动；接收队列 20 条、本地等待 4 条。忙时等待，模型错误/中止后暂停，用户运行可恢复。
- queued / accepted / delivered 都不代表任务完成；delivered 仅代表写入 transcript。10 分钟无回执则 expired，表示未确认而非撤回。
- broker 停止不会杀死工作中的 Pi，但协作失效。正常 Ctrl-C 会清理 socket；强杀后若留下 socket，确认旧 broker 已退出，再人工移除它。本程序不会自动删除现有 socket 或替换运行中的 broker。
- 首版不支持 Windows、跨机器协作、后台服务自动安装或自动重启。

## 包结构

- `extension.mjs`：普通 Pi 入口；`deckz-extension.mjs`：DeckZ 兼容入口；共用 `extension-factory.mjs` 的生命周期、工具与 `/collab` 实现。
- `src/service.ts`、`src/protocol.ts`：迁移的 relay 与协议，构建到 `dist/`；保留内部 DeckZ 字段以缩小迁移差异。
- `broker.mjs`：Unix 控制连接、显式加入、连接归属与凭证撤销。
- `cli.mjs`：前台 broker 与普通 Pi 子进程启动器。
- `src/service.test.ts`：源 relay 回归测试。
- `tests/{broker,client,launcher}.test.ts`：独立加入入口、客户端信任校验、CLI 进程与信号测试。
- `tests/sdk.mjs`：真实 Pi SDK 多进程测试（faux 模型，不调用远程 API）。

## 嵌入 DeckZ / 分发契约（0.1.1）

```ts
import { PiCollaborationService } from '@zijianchen/pi-collaboration/service';
import { COLLABORATION_LIMITS } from '@zijianchen/pi-collaboration/protocol';
```

两个 subpath 均导出构建后的 ESM 与 TypeScript declarations。service 构造器和 `start/prepare/resetSendBudget/forget/dissolveGroup/snapshot/stop` 保留原契约，`onBudgetBlocked` 回调保持不变；DeckZ 直接实例化 service，不启动 standalone broker/CLI。`prepare()` 仍返回 `DECKZ_PI_COLLAB_ENDPOINT/TOKEN`。

`@zijianchen/pi-collaboration/deckz-extension` 指向 `deckz-extension.mjs`，保留 `deckz_collaboration` 工具/提示段、`deckz-peer-message`、`deckz-collaboration` 状态键、原 launch Symbol 和 DECKZ 环境变量。此入口不列入普通 Pi 自动发现 manifest。必须显式由 DeckZ 加载，不要同时启用两个入口。

Electron `extraResources` 可以完整复制已安装包，或至少将 **`deckz-extension.mjs` 和 `extension-factory.mjs` 同目录复制**。运行时由 Pi 提供 `@earendil-works/pi-ai`，无 cocoon 源码绝对路径依赖。

未发布 npm 时，从仓库根目录制作固定归档：

```sh
mkdir -p artifacts
npm pack --workspace @zijianchen/pi-collaboration --pack-destination artifacts
shasum -a 256 artifacts/zijianchen-pi-collaboration-0.1.1.tgz
```

接入项目将归档纳入自己的 `vendor/`，使用相对 `file:vendor/zijianchen-pi-collaboration-0.1.1.tgz` 依赖并锁定 lockfile（路径相对于声明依赖的 package.json）。归档含运行所需的 JS、types、扩展入口与共享工厂；安装不需要构建源码。不使用开发者目录绝对路径，不覆盖同版本已交付归档；后续变更递增版本。

DeckZ 入口完整 SDK 回归：

```sh
PI_COLLAB_TEST_MODE=deckz PI_SDK_DIR=/absolute/path/to/pi-coding-agent npm run test:sdk
```

源码来源：cocoon `packages/workstation/resources/pi-collaboration/extension.mjs`、`src/main/pi-collaboration/{service,protocol}.ts` 及对应测试。此包暂为私有自用版本，未对外发布。
