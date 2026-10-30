# 宿主采集接入：DeckZ TUI / Desk RPC，只采集、不消费

插件不依赖 Cocoon，不提供画像、推荐、提示词注入、backend 上传或跨会话归并。本文接口在 Pi **1.4.0** 上通过离线冒烟；不表示所有更高版本都已验证，也不表示宿主已完成接入。

## 1. Cocoon：宿主自动模式（当前产品契约）

**DeckZ 的用户 Pi 和 Desk 的用户聊天 Pi 自动采集，不要求用户执行 enable，不弹开启或清除确认。协作会话、长线任务工人和 QA 不在接入范围内。** 插件无法判断进程用途，宿主须在正确的启动点选择加载范围。

DeckZ TUI：

```sh
PI_WORK_INSIGHTS_DIR=/absolute/private/deckz/work-insights \
  pi -e /absolute/path/to/pi-work-insights/src/extension.ts --work-insights-auto
```

Desk RPC：

```sh
PI_WORK_INSIGHTS_DIR=/absolute/private/desk/work-insights \
  pi --mode rpc -e /absolute/path/to/pi-work-insights/src/extension.ts --work-insights-auto
```

- `--work-insights-auto` 是**宿主授权的自动采集策略**，不是原来的 RPC UI 能力标记。传入即允许插件在初次空闲时绑定当前模型、保存启用状态并自动采集，可能产生模型费用。不依赖确认弹窗，也不需要 `--work-insights-rpc`。
- 模型不可用时不请求、不随便选择其他模型。绑定后沿用固定提取模型，切主模型不悄悄重绑；模型配置/端点变化仍停止提取，需显式 `/insights enable` 重新绑定（自动模式不弹确认）。
- 每项目至少2分钟、每滚动小时最多6次，每次最多4096输出 tokens，45秒超时；失败/取消也占额度、可能收费。宿主应以非阻塞说明展示外发范围、费用与控制入口，而不是把旧弹窗自动点同意。
- `PI_WORK_INSIGHTS_DIR` 必须为绝对路径，使用宿主专属私有目录，不放入仓库。SDK 的 agentDir 参数不一定改变插件默认目录，宿主应显式指定。
- 只初始化**从未配置过的项目**。已暂停、已清除或已有旧配置的项目不会被启动标志覆盖；`pause` / `forget` 持久停用，重启、重载或其他实例的自动初始化都不能复活。恢复须用户显式操作 `/insights enable`，但无确认弹窗。
- 授权按输出目录内的项目保存，不按会话隔离。多个用户 Pi 可复用同项目开关与预算；不要把该输出目录和加载配置扩到协作、编排工人、QA 或其他未纳入范围的进程。普通 TUI 若加载插件并使用相同目录，也可能复用持久授权。
- 自动模式下 `/insights forget` 是立即清除并暂停，不再二次确认；宿主只能从用户的明确清除操作发送，不能因界面关闭或模型建议触发。
- 不修改 Pi 的个人 settings，不安装到个人 Pi，不扫描其他会话。JSON / print 模式即使带自动标志也不采集。扩展不是同账户进程之间的安全沙箱。

## 2. 命令协议与控制入口

这些是扩展命令，不是新的 Pi RPC 顶层命令，也不是模型工具。RPC 宿主通过 `prompt` 发送，不能使用 `steer` / `follow_up`：

```json
{"id":"status-1","type":"prompt","message":"/insights status"}
```

自动模式无需为启动发送任何命令；保留下列用户控制入口：

| 命令 | 自动模式行为 |
| --- | --- |
| `/insights enable` | 显式恢复或重绑当前模型，不弹确认；成功后延迟提取 |
| `/insights status` | 非破坏性查询，不取消正在进行的提取 |
| `/insights pause` | 取消本实例任务并持久暂停；其他实例旧结果不能发布 |
| `/insights forget` | 立即清除当前项目观察及最新指针，并持久暂停；不弹确认 |
| `/insights cancel` | 仅取消本实例当前任务；不是长期关闭 |
| `/insights extract` | 立即尝试；仍遵守空闲、启用状态、去重、预算与模型绑定 |

Pi 的 `response.success: true` / `disposition: handled` 只代表扩展命令已处理，**不代表采集已开启或操作成功**。失败也可能收到成功的 prompt 响应；宿主应消费错误 notify 并查询 `status`。不要把控制命令作为普通聊天消息回显、保存或再次转发给模型。不得让主模型调用工具来恢复、清除或更换采集策略。

## 3. 状态面

RPC 的 `/insights status` 通过 `extension_ui_request` 的 `method: "notify"` 返回 JSON **字符串** `message`，无额外响应：

```json
{
  "type": "work_insights_status",
  "version": 1,
  "projectRef": "<项目摘要>",
  "enabled": false,
  "activation": "host_auto",
  "state": "尚未开启自动观察",
  "scheduled": true,
  "active": false,
  "model": null,
  "outputDirectory": "/private/application/work-insights/projects/<项目摘要>/observations",
  "latestFile": "/private/application/work-insights/projects/<项目摘要>/latest.json",
  "latest": null
}
```

- `activation` 为当前进程的策略：`host_auto` / `interactive`；是 version 1 的新增字段，旧客户端应容忍未知字段。不是运行中证明，也不是观察产物审核状态。
- `enabled` 是查询时的持久开关，不保证模型可用或能立刻采集；首次10秒空闲初始化前可为 false。`model` 为固定提取模型 `{provider, id}` 或 `null`。
- 宿主只解析具有该 `type` 与 `version` 的 notify JSON；其他 notify 是一般通知或安全错误，不保证是 JSON。查询读取失败时返回错误通知，不伪造禁用状态。
- `scheduled` / `active` 仅为本进程瞬时状态；在普通确认模式 active 也可能是在等确认。`state` 是展示文本，不是稳定枚举，不作为业务判断依据。不是其他进程实时状态或全局无请求保证。
- 状态查询与其他并发控制没有 request ID 级业务关联；宿主应串行化自身状态查询。失效会话的查询可能无通知，须有界超时，不推断成功。
- `latest` 为[输出契约](./01-contract.md#7-按时间命名与最新指针)中的项目最新成功观察指针，或 `null`。可能陈旧、为空，暂停后仍可存在；不能用它推断采集中/暂停/失败。
- `setStatus` 可展示瞬时提示，但其缺省/清空不是暂停证明。稳定查询以显式 `status` 为准，不解析自然语言状态栏判断启用状态。
- 路径只用于宿主本地界面，不放入遥测或提交日志。观察数据保持 `unreviewed`，用户角色仍是 `humanOrigin: "unverified"`。

## 4. 普通 Pi / 原有显式确认模式不变

不带 `--work-insights-auto` 的普通 TUI，无既有项目授权时仍默认关闭，执行 `/insights enable` 才请求用户确认；`forget` 仍须确认。JSON / print 不采集。

普通 RPC 宿主若选择原有的显式确认模式，则启动参数为 `--mode rpc -e <扩展入口> --work-insights-rpc`，而不是 `--work-insights-auto`。`--work-insights-rpc` 仅声明已接好确认/状态 UI，本身不授权采集。RPC 两个标志都没有时，即使有持久授权也不采集。

普通确认模式中，enable / forget 发出原生 `extension_ui_request`：

```json
{"type":"extension_ui_request","id":"dialog-id","method":"confirm","title":"开启本项目自动工作观察？","message":"由插件生成的完整告知……","timeout":60000}
```

宿主完整展示告知，用户确认后回复原 ID：

```json
{"type":"extension_ui_response","id":"dialog-id","confirmed":true}
```

拒绝使用 `confirmed: false`，关闭使用 `cancelled: true`；60秒未响应则拒绝，迟到确认无效。此模式不能默认批准、自动响应、编造弹窗 ID 或直接写插件 settings。主任务输入、换模型、关闭/切会话、暂停或其他实例在确认期间 pause/forget 会阻止旧确认恢复授权。**Cocoon 当前使用第1节的无弹窗自动策略，不是自动回答这里的旧确认。**

两种策略都保留项目持久状态与固定模型；增加自动标志不会覆盖此前已暂停的项目。旧版交付包没有自动标志，不能通过自动回确认或写 settings 把它伪装成新契约。

## 5. RPC 与 TUI 的差异

采集在主任务正常 settled、session_start、切树后等待10秒，空闲、无排队任务时运行。只读当前活动分支的过滤后窗口：最近最多30条、16000字符的用户/助手文本及极少量测试计数，不含其他会话、仓库文件、思考或完整工具日志。自动模式也不取消过滤、预算、去重与迟到结果的发布校验。

RPC 无法读取宿主输入框草稿：Pi 的 `getEditorText()` 恒为空。未发送草稿不进入 Pi 分支，不会被采集，但不保证「有草稿便不发起提取」。新 prompt 到达 Pi 后会取消旧提取；服务端可能继续运行、收费。若要求草稿编辑即停止，需要另行定义宿主输入状态协议。

关闭管道/子进程时使用 Pi 正常关闭路径，并处理意外退出、超时与错误通知。插件不会向主会话注入消息，不注册让模型开启采集的工具，也不消费产物。

## 6. 离线验证

在仓库根目录，`PI_SDK_DIR` 指向实际安装的包根目录：

```sh
# DeckZ TUI 加载器 + Desk 真实 RPC 子进程，验证自动开启且全程零确认弹窗
PI_SDK_DIR=/absolute/path/to/pi-coding-agent npm run test:auto --workspace=pi-work-insights

# 普通显式确认模式回归（含真实60秒超时）
PI_SDK_DIR=/absolute/path/to/pi-coding-agent npm run test:rpc --workspace=pi-work-insights
PI_SDK_DIR=/absolute/path/to/pi-coding-agent npm run test:sdk --workspace=pi-work-insights
```

自动模式冒烟使用临时目录、合成用户消息和假 provider，验证首次自动输出、零弹窗、去重、暂停/清除后的重启不复活、显式无弹窗恢复及普通 RPC 门禁。普通确认模式另验证拒绝、超时、迟到确认和撤销。测试不读取个人会话/认证、不请求真实模型，不等于宿主端到端接入或真实提取质量已验收。
