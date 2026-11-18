# DSH Channel Bridge

DSH Channel Bridge 将消息渠道接入 **DeepSeek Harness**。在左侧栏的 **消息渠道** 中管理连接。微信沿用现有的 iLink 登录、批准关系和会话历史。Telegram 轮询与 WebSocket 由插件直接连接，其余渠道使用固定版本的 nanobot 平台传输。渠道会话统一使用 DSH 的标准模式，工具权限由 DSH 管理。

[渠道进度表和逐渠道使用说明](./docs/channels.md)列出了源码实际注册的全部 19 个渠道、平台设置、支持范围和验证状态。

## 安装与开发

需要 Node.js 24、pnpm 11.28.5，以及兼容的 DeepSeek Harness（已核对 0.2.2-rc.3）。在项目目录执行：

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm run check
pnpm test
```

然后在 DSH 的 **插件 → 添加插件** 中选择这个项目目录。安装本地目录之前先安装开发目录的依赖；DSH 的本地链接本身不替源目录安装依赖。项目提供 [GitHub Actions 测试配置](./.github/workflows/test.yml)，以后推送 GitHub 时可自动执行相同的语法和回归测试。

**复制或修改项目文件不会自动切换已安装插件的来源。** 更换现有实例的安装目录时，使用 DSH Plugin Manager 操作；不要手工覆盖 profile 配置或改动凭据文件，也不要为同一个微信机器人同时开启两个收件实例。

更新已链接的本地插件后，重启 DSH 以重新读取 bundle。如果模式菜单仍显示旧版的「微信安全聊天」或「渠道安全聊天」，先在插件管理器里确认安装来源，再停用并重新启用该 bundle。原有微信凭据和批准关系由 DSH 保留。

DSH 在首轮开始后锁定会话模式。升级后，在原渠道继续发消息时，旧模式会话会提示发送 `/new`，以标准模式开始新会话。旧会话历史仍可在 DSH 中查看。

从 `@local/dsh-weixin-bridge` 迁移时，在插件管理器停用旧包并启用本插件。打开「消息渠道 → 微信」，确认现有的连接和批准关系后，即可卸载旧包。微信凭据和会话历史保存在 DSH profile 中。

## 微信 iLink

1. 安装并启用此 bundle，刷新现有 DSH 页面，然后打开 **消息渠道 → 微信**。
2. 点击 **显示登录二维码**，使用目标微信账号扫码并确认。如微信要求数字验证码，在同一面板输入。
3. 从微信的机器人会话发送任意文本。机器人会发回 **8 位数字配对码**，有效期 10 分钟。
4. 在 DSH 面板中对照请求的用户 ID，输入微信收到的配对码，确认发送者身份，点击 **批准发送者**。
5. **重新从微信发送一条文本**，开始对话。批准前的消息只用于配对，不会交给模型，也不会在批准后自动重放。

配对码最多允许 5 次错误尝试，之后需从微信发送新消息获取新码。每位获批用户使用独立的会话和发送上下文。撤销后如需重新申请，该用户须从微信重新发消息并由 DSH 所有者再次批准。

首次使用前，请在 DSH 模型设置中选择可用的默认模型。新微信会话使用该默认模型；已有会话恢复时保持自己的模型选择。

## 所有渠道的工具与权限

- 微信和其他渠道使用 DSH 标准模式，工具执行遵循 DSH 的原生沙箱与审批设置。需要批准的调用会显示在对应 DSH 会话中。
- 新会话分配各自的私有工作目录，恢复已有标准模式会话时沿用原工作目录。渠道消息触发的回合可通过 `channel_send` 向当前已批准的聊天发送文本和私有工作目录里的附件。
- 微信内容以普通用户消息接入，不能批准用户、开始扫码、恢复连接、修改权限或把自己提升为系统指令。
- 扫码、验证码、批准、撤销与恢复操作只接受 DSH 本人已登录浏览器。HTTP 管理接口复用 DSH 的 Host/Origin/身份校验，并要求 JSON 和专用请求头；不是公开的微信回调。
- token 与每用户 `context_token` 保存在 DSH 凭据服务中，不写普通插件配置，不返回给面板或模型。二维码只在已认证的管理面板显示，不进入管理工具结果。DSH 的凭据存储由安装版本提供，**本插件不额外承诺静态加密**；请保护本机 profile 和备份。
- 默认转发对应渠道回合的最终答复。可在渠道详情的 **回复选项** 中按平台启用流式文字、处理进度或工具名称提示。微信保持推理内容私有。
- 如果在该微信会话中从 DSH 手动发送或编辑了额外输入，该会话会被标记为污染，停止微信转发；下一条微信输入使用新的隔离会话，以免混入桌面端私人输入。可复制会话 ID 到 DSH 查阅历史；不要把它当作与桌面私人聊天共用的会话。

## 微信暂停、断开与恢复

- **暂停接收**：停止轮询与该桥接的当前处理，保留凭据、批准关系和历史。恢复连接只能在面板中由本人操作。
- **断开连接**：停止工作，删除本插件的微信凭据、批准关系、游标和待处理记录，保留 DSH 会话历史。再次使用需重新扫码和配对。
- 退出 DSH、关闭插件或电脑休眠会中断收发。已经启用的连接在 DSH 再次运行并加载插件时会尝试恢复；如果此前手动暂停，则保持暂停。
- 每个微信用户的会话 ID 持久保存。恢复时校验预设和工作目录，不会复用不属于此桥接的会话。

## 微信投递与资源限制

- 微信需要 `bot_token` 身份凭据和对应用户的 `context_token`；知道用户 ID 不代表可以任意发消息。
- 上下文超过 60 秒时，发送前尝试通过 `getconfig` 刷新。平台仍可能拒绝，不能保证后台主动推送可达。
- 本插件默认每个上下文最多预留 8 次发送，**这是本地保护值，不是微信官方公布的限额**。
- 长回答分段发送，最多 4 段，每段不超过 1800 个 Unicode 码点。超出部分提示到 DSH 查看完整回答。
- `context_token` 受限的回答暂存，收到新微信上下文后再尝试，已确认成功的分段不会重发。
- 网络超时或进程退出可能使一次发送的结果无法确认。这种记录标记为“结果未确认”，**不盲目自动重发**，避免重复通知；请到 DSH 查看历史。不能承诺跨网络的 exactly-once 投递。
- 每条输入最多 12000 个 Unicode 字符；每位用户每分钟最多接纳 10 条，待处理输入最多 20 条。待发队列有上界，并为已经开始生成的回答预留位置；满时停止启动新模型请求。
- 消息去重保存最近 1000 个输入标识。正常增量游标在已接纳输入持久化后才推进。会话最终结果经过 DSH 的持久化 flush 后才进入待发队列。
- 单次模型回复默认限时 180 秒。恢复已入模但中断的轮次不会盲目重新执行，会提示重新发送。

## 微信平台范围

已批准的私聊发送者可上传图片、语音、文件或视频，单条消息附件合计最多 1 MiB。支持平台提供的语音文字，图片理解取决于所选 DSH 模型。可以发送文本、图片、语音、视频和文件，出站附件单次合计最多 1 MiB。通过 `channel_send` 或绑定到当前会话的 DSH 自动化发送时，iLink 仍要求有效的发送上下文。账号开通、扫码和会话范围由微信 iLink 决定，群聊和群发暂不可用。

## 插件配置

Bundle patch 安装 Host 插件。省略 `workspaceDir` 时优先沿用已批准微信会话的历史工作目录，否则以 DSH 默认工作目录创建 `weixin-workspace` 作为旧会话兼容路径。新会话使用 `channel-private-workspaces/<会话 ID>`。仓库忽略同名运行目录，凭据与会话历史继续由 DSH profile 管理。

| 字段 | 默认/当前值 | 含义 |
| --- | --- | --- |
| `workspaceDir` | 已批准微信会话的工作目录，或 `<DSH 默认工作目录>/weixin-workspace` | 自定义时须为现有绝对目录；省略时优先沿用已批准会话的目录 |
| `pollTimeoutMs` | 35000 | 长轮询等待毫秒数，允许服务端在受限范围内建议调整 |
| `contextBudget` | 8 | 本地每上下文发送保护值，可调 1–8 |
| `responseTimeoutMs` | 180000 | 每条回复的模型处理期限，可调 30000–300000 |
| `nanobotPython` | `python3` | 运行固定版本传输组件的解释器。建议填写专用虚拟环境解释器的绝对路径 |

通过 DSH 插件配置编辑；不要直接把 token 填入配置。普通字段修改会使插件重载；在有消息处理中时应先暂停，避免中断回复。

Agent 管理工具 `weixin_bridge` 只支持 `status`、`pause`、`disconnect`。它与面板使用同一 Host 操作实现，但不会返回二维码、验证码、token 或配对码，也不能授权或恢复连接。

## 开发与验证

目标接口已核对 DSH **0.2.2-rc.3**，Node **24**。包无安装/构建脚本；浏览器文件已是 DSH 模块工厂格式。通过 DSH Plugin Manager 安装本地目录，不要在用户 profile 中手动运行包管理器或覆盖配置。

使用**本地目录链接安装**时，请保留整个已安装源目录及其中的运行依赖，不要在插件启用时移动或删除。锁文件固定开发依赖版本；迁移到其他机器时先安装依赖（禁用生命周期脚本），再通过 DSH Plugin Manager 安装目录。

准备同步 GitHub 前，阅读 [贡献说明](./CONTRIBUTING.md) 和 [安全说明](./SECURITY.md)。仅提交源码、测试、锁文件、文档和 CI 配置；不要提交微信凭据、配对码、登录二维码、聊天记录、运行日志或 DSH profile。当前包标记为 `private: true`，用于防止误发布 npm，不影响将源码提交 GitHub。

```sh
# 在插件源目录，使用当前 DSH 的 Electron Node 运行纯测试。
ELECTRON_RUN_AS_NODE=1 "$DSH_NODE_EXECUTABLE" --test test/*.test.js
```

自动测试使用模拟平台和 DSH 服务，覆盖会话隔离、连接生命周期、队列持久化和页面卸载。真实账号的收发验证状态见[渠道进度表](./docs/channels.md)。

实现分层：

- [Host 入口](./index.js)：配置、凭据服务、持久化域、受认证管理 API、Agent 管理工具。
- [iLink 客户端](./lib/ilink.js)：HTTP 协议、域名/重定向防护、取消/超时、文本解析与分段。
- [桥接运行时](./lib/bridge.js)：扫码、配对、收件/待发队列和连接生命周期。
- [DSH Agent 适配器](./lib/agent-backend.js) 与 [投影](./lib/projection.js)：持久输入、恢复和最终轮次关联。
- [通用渠道运行时](./lib/channel-bridge.js) 和[传输子进程](./transport/nanobot_worker.py)负责启停、去重、回复和凭据交接。
- [消息渠道页面](./client.js)通过 DSH 左侧栏和主内容区扩展点显示配置、登录、审批和状态。

原有微信协议参考 [nanobot 的微信渠道实现](https://github.com/HKUDS/nanobot/blob/e76717445058f4670ac9299cc89f91504da2f5f2/nanobot/channels/weixin/runtime.py)，并按其注明的 `@tencent-weixin/openclaw-weixin` v2.4.6 协议字段实现。未引入或运行 nanobot 的 Agent 进程。

---

## English summary

DSH Channel Bridge adds a **Message Channels** page to DeepSeek Harness. The WeChat adapter retains its existing iLink account, approvals and DSH history. Use **Message Channels → WeChat** to sign in and approve your account. Platform credentials and retained login state use DSH's credential service. Each channel conversation uses DSH's Standard mode and native tool permissions. See the [channel matrix](./docs/channels.md) for the 19 upstream channels, configuration and verification status.
