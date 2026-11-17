# DSH Channel Bridge

<img src="../icon.svg" alt="DSH Channel Bridge 标志" width="64" height="64">

把微信、Telegram、Discord、飞书等 19 个消息渠道接到 **DeepSeek Harness（DSH）**。在 DSH 左侧栏的 **消息渠道** 页面配置账号、授权发送者和查看连接状态。消息进入独立的 DSH 会话，回复回到原聊天或线程。

[逐渠道配置与验证状态](../docs/channels.md) · [插件详细说明](../README.md) · [贡献指南](../CONTRIBUTING.md) · [English](#english)

## 功能

- **统一管理渠道。** 连接、暂停和断开均从 DSH 操作。微信使用 iLink 扫码和配对码，升级时可沿用已有微信登录、批准关系和会话。
- **使用 DSH Agent。** 所有渠道共用 DSH 的模型、会话和工具授权。工具默认关闭，可在渠道详情逐项启用，每次调用通过 DSH 原生审批。
- **回复到原会话。** 可按平台启用附件、流式回复、进度和按钮。绑定到当前会话的 DSH 定时任务也可以回送结果。

## 安装

需要 DeepSeek Harness（已验证 `0.2.2-rc.3`）、Node.js 24 和 pnpm `11.28.5`。

如果从 PR 或预览分支安装，请在运行 `pnpm install` 前检出对应分支。

```sh
git clone https://github.com/Motifi/dsh-channel-bridge.git
cd dsh-channel-bridge
pnpm install --frozen-lockfile --ignore-scripts
```

1. 在 DSH 中打开 **插件 → 添加插件**，选择刚克隆的项目目录并启用。
2. 在 DSH 模型设置中选好默认模型，然后打开左侧栏的 **消息渠道**。
3. 选择一个渠道。微信扫码登录后，从微信向机器人发一条消息获取配对码，再回到 DSH 批准发送者。其他渠道填写平台配置和允许的发送者 ID，再点击连接或登录。
4. 从该渠道发送一条测试消息。需要使用 Agent 工具时，在渠道详情勾选工具，再从对应的 **打开 DSH 会话** 入口处理审批。

微信、Telegram 轮询和 WebSocket 可直接使用。其余渠道与 Telegram webhook 或平台代理模式需要 Python 3.11+ 的独立环境。使用 `transport/install.py` 安装适配器，并在 DSH 插件配置中将 `nanobotPython` 指向该环境的解释器。 [Python 安装与平台配置](../docs/channels.md#安装和使用)

## 已接入的渠道

微信、企业微信、钉钉、飞书、QQ、NapCat、Telegram、Discord、Slack、Mattermost、Matrix、Signal、WhatsApp、WhatsApp Agent、Microsoft Teams、Linear、MoChat、Email 和 WebSocket。

已在 macOS DSH 桌面端用真实微信账号验证私聊文本收发。WebSocket 已在 DSH 宿主中通过本地模拟模型验证流式回复、工具审批和定时结果回送。微信媒体及其他外部平台仍有待账号验证的项目。附件、线程、群聊和富消息的支持范围见逐渠道表。 [渠道进度表](../docs/channels.md#渠道进度和配置)

## 开发与安全

```sh
pnpm run check
pnpm test
python3 -m unittest discover -s transport -p 'test_*.py'
```

渠道凭据通过 DSH 凭据服务保存。提交问题或日志前，请移除令牌、配对码和聊天记录。 [安全说明](../SECURITY.md) · [MIT 许可证](../LICENSE)

渠道适配参考 nanobot 的源码注册表并固定 Python 传输版本。 [上游参考版本](https://github.com/HKUDS/nanobot/commit/e76717445058f4670ac9299cc89f91504da2f5f2)

## English

DSH Channel Bridge connects 19 messaging channels to DeepSeek Harness. Add this repository through the DSH Plugin Manager, then open **Message Channels** in the sidebar to configure an account and authorize senders. Conversations use DSH models and isolated sessions. The owner enables specific tools per channel and approves each call in DSH. Attachments, streaming, and interactive replies depend on the platform. [Setup and verification by channel](../docs/channels.md)
