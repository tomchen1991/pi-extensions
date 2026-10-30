# 自用 PI 插件

独立维护的 PI 插件工作区；每个插件位于 `packages/<name>`，拥有独立 Pi manifest、入口与文档。不依赖 cocoon/Electron，不自动修改全局 PI 配置。

## 插件

- [PI 工作洞察](packages/pi-work-insights/README.md)：授权后自动输出最近工作、决策、未闭环事项、提示词/协作偏好线索与短证据引用的 JSON；不负责画像、推荐或后端使用。

- [下一句自动建议](packages/pi-next-prompt/README.md)：DeepSeek Flash 单次生成下一句提示词，输入框灰字展示，Tab 接受，输入即消失。

- [PI协作](packages/pi-collaboration/README.md)：普通 PI 会话间显式加入、同组发现、点对点消息与回执。

## 开发

Node.js >=22，macOS/Linux。

```sh
npm ci
npm test
# 可选：真实已安装的 Pi SDK，多进程 faux 模型，无 API 请求
PI_SDK_DIR=/absolute/path/to/pi-coding-agent npm run test:sdk
```

`npm run build` 构建各包。新增插件使用独立目录和 `package.json`，不要让包依赖工作区外的源码路径。当前包均 private，尚未发布 npm。
