# RPC 宿主接入：只采集，不消费

适用于 Desk 等通过 `pi --mode rpc` 启动 Pi 的宿主。插件不依赖这些应用，不提供画像、推荐、提示词注入、backend 上传或跨会话归并。本文接口在 Pi **1.4.0** 上通过离线子进程冒烟；不表示所有更高版本都已验证。

## 1. 启动与授权是两回事

```sh
PI_WORK_INSIGHTS_DIR=/absolute/private/application/work-insights \
  pi --mode rpc -e /absolute/path/to/pi-work-insights/src/extension.ts --work-insights-rpc
```

- `--work-insights-rpc` 是宿主能力声明：宿主承诺接入下述确认与状态 UI。它不是用户同意，不能单独开启采集。
- 缺少该开关的 RPC、JSON、print 模式不会采集，即使同目录已有项目授权。无需也不得直接修改插件 settings 来模拟授权。
- 无既有授权时，加载默认关闭；用户通过 `enable` 同意项目、固定模型、配置端点、外发文本范围、额度、费用与保存目录后才开启。
- 授权持久保存在插件自己的项目目录，后续同目录/同项目且带能力开关的进程可恢复采集；不是每次启动重新弹窗。`pause` 持久暂停，`forget` 清除本机项目输出并暂停。不要宣传成「每次启动默认关闭」。
- `PI_WORK_INSIGHTS_DIR` 必须为绝对路径，使用宿主专属私有目录，不放入仓库。SDK 的 agentDir 参数不一定改变插件的默认目录，宿主应显式指定。
- 项目授权不是按宿主会话隔离的。不要把相同目录与开关加到编排工人、QA、协作或其他未经授权进程，否则同项目可能恢复采集。Pi 扩展不是同账户安全沙箱。

## 2. 命令与确认协议

这些是扩展命令，不是新的 Pi RPC 顶层命令，也不是模型工具。宿主从显式用户操作发送 `prompt`，不应让主模型决定授权，不应使用 `steer` / `follow_up`：

```json
{"id":"enable-1","type":"prompt","message":"/insights enable"}
```

`enable` 会发出 Pi 原生确认请求：

```json
{"type":"extension_ui_request","id":"dialog-id","method":"confirm","title":"开启本项目自动工作观察？","message":"由插件生成的完整告知……","timeout":60000}
```

宿主须展示完整告知，只能在用户确认后回复该请求的原始 ID：

```json
{"type":"extension_ui_response","id":"dialog-id","confirmed":true}
```

拒绝时使用 `confirmed: false`，关闭弹窗时使用 `cancelled: true`。没有响应会在60秒后拒绝；迟到的确认不授权。不要默认批准、自动响应，或发送预先编造的弹窗 ID。主任务输入、换模型、关闭/切会话以及暂停等会撤销本实例旧确认；其他实例在确认期间 pause/forget 也会阻止旧确认恢复授权。

| 命令 | 用途 |
| --- | --- |
| `/insights enable` | 绑定当前模型并请求确认；成功后延迟自动提取 |
| `/insights status` | 非破坏性查询，不取消提取或确认弹窗 |
| `/insights pause` | 取消本实例任务并持久暂停；其他实例旧结果不能发布 |
| `/insights forget` | 经60秒有界确认后清除当前项目观察及最新指针，并暂停 |
| `/insights cancel` | 仅取消本实例当前任务；不是长期关闭 |
| `/insights extract` | 立即尝试；仍遵守空闲、授权、去重、预算与模型绑定 |

Pi 的 `response.success: true` / `disposition: handled` 只代表扩展命令已处理，**不代表已开启采集**。确认取消或失败也可能收到成功的 prompt 响应；随后查询 `status` 确认授权状态。不要把控制命令作为普通聊天消息回显、保存或再次转发给模型。

## 3. 状态面

RPC 的 `/insights status` 通过 `extension_ui_request` 的 `method: "notify"` 返回 JSON **字符串** `message`，无额外响应：

```json
{
  "type": "work_insights_status",
  "version": 1,
  "projectRef": "<项目摘要>",
  "enabled": false,
  "state": "尚未开启自动观察",
  "scheduled": false,
  "active": false,
  "model": null,
  "outputDirectory": "/private/application/work-insights/projects/<项目摘要>/observations",
  "latestFile": "/private/application/work-insights/projects/<项目摘要>/latest.json",
  "latest": null
}
```

- 宿主只解析具有该 `type` 与 `version` 的 notify JSON；其他 notify 是一般通知或安全错误，不保证是 JSON。查询读取失败时返回错误通知，不伪造禁用状态。
- `enabled` 是查询时的持久授权开关，不保证模型可用或当前能采集；`model` 为固定提取模型 `{provider, id}` 或 `null`。
- `scheduled` / `active` 仅为本进程瞬时状态；active 也可能是在等确认。`state` 是展示文本，不是稳定枚举，不作为业务判断依据。不是其他进程实时状态或全局无请求保证。
- 状态查询与其他并发控制没有 request ID 级业务关联；宿主应串行化自身状态查询。失效会话的查询可能无通知，须有界超时，不推断成功。
- `latest` 为[输出契约](./01-contract.md#7-按时间命名与最新指针)中的项目最新成功观察指针，或 `null`。可能陈旧、为空，暂停后仍可存在；不能用它推断采集中/暂停/失败。
- `setStatus` 事件可展示瞬时提示，但其缺省/清空不是暂停证明。稳定查询以显式 `status` 为准，不解析自然语言状态栏判断授权。
- 路径只用于宿主本地界面，不放入遥测或提交日志。观察数据保持 `unreviewed`，用户角色仍是 `humanOrigin: "unverified"`。

## 4. RPC 与 TUI 的差异

采集仍在主任务正常 settled、session_start、切树后等待10秒；沿用每项目至少2分钟、每滚动小时6次、固定模型、取消与发布校验。只读当前活动分支的过滤后窗口。

RPC 无法读取宿主聊天输入框草稿：Pi 的 `getEditorText()` 恒为空，插件不宣称能检测 Desk 草稿。草稿尚未发送时不会进入 Pi 分支，也不会被采集，但不保证「有草稿便不发起提取」。新 prompt 到达 Pi 后会取消旧提取；服务端可能继续运行、收费。若产品要求草稿编辑即停止，需要另行定义宿主输入状态协议，不能宣称当前已实现。

宿主关闭管道/子进程时使用 Pi 的正常关闭路径，并处理意外退出、弹窗撤销、超时与错误通知。插件不会向主会话注入消息，不注册可让模型开启采集的工具，也不会消费产物。

## 5. 离线验证

在仓库根目录：

```sh
PI_SDK_DIR=/absolute/path/to/pi-coding-agent npm run test:rpc --workspace=pi-work-insights
```

测试使用临时 HOME/agentDir、合成用户消息和内存假 provider，启动真实 Pi RPC 子进程；验证命令发现、拒绝、真实60秒确认超时、迟到确认、暂停撤销、自动输出、去重、持久授权恢复、无能力开关的门禁和 forget。不读取个人会话/认证、不请求真实模型。约需75秒；不等于 Desk 已完成接入或真实提取质量通过验收。
