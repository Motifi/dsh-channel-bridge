# 消息渠道

## 上游基准

插件对照 nanobot `main` 的 [`e76717445058f4670ac9299cc89f91504da2f5f2`](https://github.com/HKUDS/nanobot/commit/e76717445058f4670ac9299cc89f91504da2f5f2)。[registry.py](https://github.com/HKUDS/nanobot/blob/e76717445058f4670ac9299cc89f91504da2f5f2/nanobot/channels/registry.py) 枚举 `nanobot.channels` 中的包，[plugin.py](https://github.com/HKUDS/nanobot/blob/e76717445058f4670ac9299cc89f91504da2f5f2/nanobot/channels/plugin.py) 通过各包的 `manifest.py` 读取运行时和配置声明。实际运行 `discover_plugins()` 获得下表的 19 个渠道。字段清单在 [transport/channels.json](../transport/channels.json)。核对 [b77e959](https://github.com/HKUDS/nanobot/compare/e76717445058f4670ac9299cc89f91504da2f5f2...b77e9592af912bc3f15d1f48dd6bcb364fafe7cf) 时，差异未涉及渠道实现。

## 安装和使用

1. 用 DSH 插件管理器加载此项目。宿主扩展 API 以 DSH `0.2.2-rc.3` 为基准。
2. 在左侧栏打开 **消息渠道**。微信在这里继续使用原来的扫码与批准流程。
3. 选择其他渠道，在配置表单填写平台参数和凭据，并单独保存允许的发送者 ID。至少批准一个精确的平台 ID 后才能连接。替换配置会建立新的会话隔离范围，凭据不会回显。需要改密钥时，应提交一份完整配置。
4. 选择 **连接**。Linear 和 WhatsApp 的首次授权使用 **登录**，分别打开 OAuth 链接和扫码。**暂停**保留渠道配置与批准名单，**断开**删除该连接的凭据。私聊与群聊发送者即使有同样的显示名，仍按平台 ID 隔离。
5. 首次部署时，用测试账号发一条消息，确认 DSH 生成的回复回到原会话或线程，再按需增加发送者。
6. 在渠道详情的 **回复选项** 中，按平台能力设置流式文字、进度或工具名称提示。
7. 出现等待批准的调用时，在该渠道详情打开对应的 **DSH 会话**，用原生审批卡选择是否允许本次操作。微信的入口在已批准发送者下方，其他渠道在 **渠道会话** 中。

微信、Telegram 轮询和 WebSocket 可直接使用 DSH 插件。其余渠道需要 Python 3.11+ 的独立虚拟环境。Telegram 使用 webhook 或平台代理时也需要该环境。以下命令从项目根目录运行，安装脚本位于 [transport/install.py](../transport/install.py)。

```sh
python3.12 -m venv "$HOME/.local/share/dsh-channel-transport"
"$HOME/.local/share/dsh-channel-transport/bin/python" transport/install.py
```

Windows 可用 `py -3.12 -m venv <目录>`，然后使用 `<目录>\Scripts\python.exe transport/install.py`。将同一个虚拟环境解释器路径写入 DSH 插件配置的 `nanobotPython`，再重载插件。Matrix E2EE 及 WhatsApp 的本机依赖以操作系统和 SDK 可用性为准。WhatsApp 的媒体识别在 macOS/Linux 上需要 libmagic。Signal 使用已经绑定账号的 signal-cli HTTP daemon。

可重复指定 `--channel` 只安装所需的渠道 SDK，例如 `transport/install.py --channel napcat --channel slack`。Linux、macOS 和 Windows 上的 SDK 安装结果取决于该平台是否有兼容版本。

运行时按启用状态连接渠道，复用上游平台 SDK。DSH 原生 Agent 执行模型请求和工具，渠道配置和登录状态由 DSH 凭据服务保存。Python 子进程使用私有临时目录。文件按 DSH 支持的附件格式接入，单次入站或出站附件合计最多 1 MiB。语音使用平台已有的转写或交给 DSH 作为音频附件。平台回调必须匹配已授权发送者、连接实例、房间及线程的已有 DSH 会话。

已进入 DSH 持久化队列的消息可以跨宿主重启恢复。平台侧的重投、游标与活跃连接上下文取决于各 SDK。比如 WeCom 的原消息回复依赖接收进程持有的请求上下文。Linear 在进入 DSH 队列前经由临时 webhook 队列，平台重投行为需在正式环境验证。

## Agent 与回复能力

| 能力 | 当前实现与验证范围 |
| --- | --- |
| DSH 原生工具 | 微信和其他渠道共用 DSH 标准模式，由 DSH 会话权限控制工具范围与审批。每个渠道会话使用独立的工作目录。 |
| 会话命令 | 可用 `/help`、`/new`、`/stop`、`/status`、`/model`、`/model 服务商/模型`、`/skill`、`/compact`。模型切换与压缩使用 DSH 能力，并限定在当前渠道会话。 |
| 流式与进度 | Discord、飞书、Matrix、Mattermost、Telegram、WebSocket 和微信可按平台方式开启流式文本。Linear 和 WebSocket 可开启推理转发。邮件保持最终回复。微信可选分段文本、进度及工具名称，语音文字沿用平台转写。 |
| 发送消息、文件和选项 | 渠道消息触发的回合可通过 `channel_send` 发送文字、工作区附件和文字选项到当前已批准的聊天。按钮由 Telegram、Slack、Linear 或 WebSocket 等对应适配器呈现，支持范围以平台接口为准。Teams、MoChat 的适配器不上传本地出站文件。 |
| DSH 自动化 | 将 DSH 定时任务绑定到已建立的渠道会话，完成结果可以入队发回已授权的原会话。撤销、断开或切换会话身份后，先前目标失效。已用隔离 DSH 宿主和 WebSocket 运行一次原生 `schedule_create` 完整联调，冷启动恢复、去重与撤销另有回归测试。 |
| 尚有差异 | nanobot 的 Dream/Heartbeat 工作流、CLI Trigger、进程重启和远程配对管理没有同名移植。音频渠道转交原始文件或平台已有文字，尚无自动语音识别。完整 WebSocket WebUI 控制协议有差异。真实账号验证见下表。 |

## 渠道进度和配置

| nanobot ID | 连接配置与平台行为 | 当前验证 |
| --- | --- | --- |
| `dingtalk` | 钉钉机器人 Stream 模式。填写 Client ID 与 Client Secret，允许名单使用 staff ID。按平台限制开启私聊或群聊。 | 运行时加载与收发契约测试，待账号验证 |
| `discord` | 在 Developer Portal 创建 bot，填 Bot Token。启用对应 Gateway Intents 和频道权限，按需填写允许的频道。使用用户数字 ID。可配置群聊提及与引用。 | 运行时加载与收发契约测试，待账号验证 |
| `email` | 填写 IMAP、SMTP 主机及应用密码，确认接入授权，批准发件人地址。保留上游 DKIM/SPF 校验，按需声明附件类型，回复带原邮件引用。 | 运行时加载与收发契约测试，待账号验证 |
| `feishu` | 用飞书或 Lark 应用的 App ID 和 App Secret，按地区选择 domain，启用相应权限与长连接事件订阅。批准用户 open ID，可开启话题隔离。多个应用账号在高级 JSON 里提供 `instances` 数组，每个实例填写独立的 `id`、`appId`、`appSecret` 等参数。实例可用自己的 `allowFrom` 缩小全局发送者名单。 | 运行时加载与收发契约测试，待账号验证 |
| `linear` | 在 Linear 创建 OAuth 应用，填 Client ID、Client Secret、签名密钥和外部 HTTPS 地址。公开对应 webhook 与 OAuth 回调路由，在设置中点登录完成工作区授权。批准工作区用户 ID。回复写入相应的 agent session。 | 加载与本地凭据封装测试，待账号验证 |
| `matrix` | 填 homeserver、Matrix 用户 ID 与密码，或 Access Token 和 Device ID。批准完整 MXID，房间权限和线程按上游运行时工作。可选择启用 E2EE。 | 运行时加载与收发契约测试，待账号验证 |
| `mattermost` | 填 Server URL 与 Bot Access Token，给 bot 频道权限，批准 Mattermost 用户 ID。支持私聊、提及和线程回复。 | 运行时加载与收发契约测试，待账号验证 |
| `mochat` | 填平台 Base URL、Claw Token、Agent 用户 ID，按需添加 sessions 和 panels。批准平台作者 ID。接收 Socket.IO 消息，支持上游 HTTP 轮询。 | 运行时加载与收发契约测试，待账号验证 |
| `msteams` | 注册 Microsoft Bot，填 App ID、App Password 和 Tenant ID。用 HTTPS 转发回调到本地监听的 `/api/messages`，保留入站 JWT 校验。批准 activity 发送者 ID。按上游限制接收私聊并回复到原活动。平台出站适配器以文字投递为主。 | 运行时加载与收发契约测试，待账号验证 |
| `napcat` | 用已登录的 NapCat OneBot v11 正向 WebSocket URL 和 Access Token，批准 QQ 数字 ID。群聊可设提及策略，支持图片入站。 | 本地 OneBot WebSocket 模拟服务的连接、筛选、收发和停止测试，待账号验证 |
| `qq` | 在 QQ 开放平台填 App ID 和 App Secret，按平台要求发布或注册测试范围。批准 C2C 或群消息中对应的 open ID。支持上游 C2C 和群聊 @ 机器人。 | 运行时加载与收发契约测试，待账号验证 |
| `signal` | 填绑定的 E.164 手机号及 signal-cli daemon 地址，使用 SSE 接收。按需启用 DM/群聊，不同群可另设允许名单。批准事件报告的发送者 ID，附件依赖 daemon 共享目录。 | 运行时加载与收发契约测试，待账号验证 |
| `slack` | 启用 Socket Mode，填写 `xapp-` App Token 和 `xoxb-` Bot Token，给应用必要事件订阅与发消息权限。批准 Slack 用户 ID。支持私聊、频道和线程。 | 运行时加载与收发契约测试，待账号验证 |
| `telegram` | 用 BotFather Bot Token，批准用户数字 ID。默认走 Bot API 轮询，可选被提及才回复，处理 forum 话题与原消息引用。可使用流式草稿、消息编辑、内联命令和媒体上传。需要 webhook 时设置公网 HTTPS URL 和 Secret Token。 | 原生适配器的模拟 Bot API 测试，待账号验证 |
| `websocket` | 在 `clientTokens` JSON 字段为每个允许的 client ID 设置不同的 24–256 位 URL 安全字母、数字或 `._-` 字符。使用 DSH 的 `/channels/websocket?client_id=<ID>` 并提供 Bearer Token。浏览器可用 `token` 查询参数。远程连接使用 `wss://`。 | 已在 DSH 0.2.2-rc.3 用本地模拟模型验证鉴权、往返收发、启停、重启后复用会话及重复消息去重 |
| `wecom` | 使用企业微信智能机器人长连接，填写 Bot ID 与 Secret，允许名单包含平台用户 ID。群聊按上游策略同时批准群 ID。 | 运行时加载与收发契约测试，待账号验证 |
| `weixin` | 继续使用原插件的微信 iLink 扫码、所有者批准和私聊流程。现有登录、批准与会话保留。支持多个批准用户独立收发，支持文本及图片、语音、视频、文件。可显示输入状态，并可启用微信的分段回复和工具名称提示。 | 已在 DSH 0.2.2-rc.3 macOS 桌面端用现有微信账号验证私聊文本双向收发、原会话复用及暂停恢复。新版附件、并行授权和输入状态通过模拟协议测试，待真实账号验证。 |
| `whatsapp` | 配置群聊策略并批准联系人 ID。点击登录，用 WhatsApp 已连接设备扫描 QR，设备凭据进入 DSH 凭据服务。按上游支持处理授权私聊、群聊与媒体。 | 加载与本地凭据封装测试，待账号验证 |
| `whatsapp_agent` | 使用 Meta WhatsApp Agent Platform 分配的 Token，批准平台 `wa_id`，使用上游 poll/ack 流程和可选媒体下载。 | 运行时加载与收发契约测试，待账号验证 |

支持显式代理的 Python 渠道可开启 `useProxy` 并配置 `proxyUrl`。同一 bot 身份应只运行一个接收进程。Teams、Linear 与 Telegram webhook 需要确保平台可访问回调地址，回调监听端口应由反向代理提供 HTTPS。

WebSocket 连上后会收到 `event: "ready"` 及本连接的 `chat_id`。发送文本，或发送 `{"type":"message","content":"你好","chat_id":"…","turn_id":"消息唯一编号"}`。断线重连后用同一 `turn_id` 重投可去重。该端点也接受 `media: [{ "name": "note.txt", "mime": "text/plain", "data": "<base64>" }]` 形式的内联附件，最多 8 项，合计不超过 1 MiB。

标准库测试用 `python3 -m unittest discover -s transport -p 'test_*.py'` 运行。安装全部 SDK 后，可用 `DSH_TRANSPORT_SMOKE=1` 增加 17 个上游运行时的加载及路由契约验证。再设置 `DSH_TRANSPORT_LOOPBACK=1` 可运行 NapCat 本地协议测试。

渠道图标随插件加载。Discord、Linear、Matrix、Mattermost、QQ、Signal、Telegram、微信和 WhatsApp 的图形取自 [Simple Icons 16.37.0](https://github.com/simple-icons/simple-icons/tree/16.37.0)，图标库采用 CC0-1.0，品牌标识属于各自权利人。其余图标为本插件绘制。 [Simple Icons 品牌标识说明](https://github.com/simple-icons/simple-icons/blob/16.37.0/DISCLAIMER.md)
