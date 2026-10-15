# Herdr Pocket

An independent, open-source Android companion for [Herdr](https://herdr.dev).
Built from scratch in Kotlin, with a small auditable Python bridge carried inside the APK.
Not affiliated with Herdr or other similarly named mobile apps.

**Status: v0.4.0 experimental.** Android SSH companion with a bundled offline chat UI and read-only Codex / Claude transcript adapters.

[Download signed APK](https://github.com/HFO4AR/herdr-pocket/releases) · [Build checks](https://github.com/HFO4AR/herdr-pocket/actions)

<img src="docs/screenshots/agent.png" width="260" alt="Offline demo chat timeline" /> <img src="docs/screenshots/commands.png" width="260" alt="Offline demo command and output card" />

<img src="docs/screenshots/ssh-terminal.png" width="260" alt="Offline SSH terminal demo" /> <img src="docs/screenshots/herdr-terminal.png" width="260" alt="Offline Herdr ordinary pane demo" />

Screenshots use offline fixtures, never real conversations or credentials.

视觉采用 Host App 默认亮色 / coral 设计规则：暖白底、珊瑚橙选中态、黑色主按钮，10 / 14 / 20 px 圆角与相同字体顺序。移动端保留至少 44 px 主要触控目标和聊天布局；当前不包含 Host 的深色主题选择器。

## 这版新增

- **SSH 交互终端**：在「终端」打开独立 PTY shell；彩色输出、Tab、方向键、Ctrl+C、Ctrl+D、直接键盘及中文命令输入。返回列表保留 shell；断开设备或关闭 shell 才结束。手机端保留有界输出，后台超过缓存会明确提示丢失更早输出，不会重放输入。
- **Herdr 普通分屏**：「终端」列出所选会话所有工作区的非 Agent 分屏，读取近期输出，向同一终端发送文本、回车或快捷键。每次校验终端身份，分屏换进程成为 Agent 后拒绝继续用旧目标输入。这里显示 400 行近期快照，非桌面完整终端画面的像素镜像。
- **历史缺失修复**：除 Herdr 会话 ID 外，支持明确的原生 resume ID / transcript 路径 / 打开的历史文件；同 ID 多副本不会再导致关联失败。缺少确证时直接显示项目候选，点选后可只读浏览或人工确认关联，避免空白页面。超过 2 MB 的内部记录尾部会自动跳过，跨分页边界不再漏消息；失败保留原因和重试入口。
- **ch-cli 远端历史**：沿当前已建立的 SSH 路由，只读对应远端用户的历史目录；专用路由工作目录中唯一的会话自动关联，多个会话提供选择。不会读取服务商登录资料、安装远端程序或重启正在运行的 Agent。
- **连接时记住密码**：实际输入登录密码的弹窗新增默认勾选的保存选项；仅认证成功后加密保存。认证失败可以重新输入，不必删除设备。「我的」显示版本与密码保存状态。

## 这版能做什么

- **设备与密码保存**：多台设备的名称、主机、端口和 SSH 用户名；勾选记住密码后，使用 Android Keystore 的 AES-GCM 密钥加密，重启应用仍可使用。编辑时不回显密码，取消记住或删除设备会移除保存的密码；改变目的主机或用户名不会沿用旧密码。
- **聊天界面**：用户消息、Agent 回复分开显示，支持基本 Markdown、代码块和固定输入栏。草稿按在线会话隔离，切换或旋转时保留在内存中。
- **历史浏览**：读取当前 SSH 用户 `~/.codex/sessions` 和 `~/.claude/projects` 下的 JSONL，搜索项目/标题/会话 ID，分页加载更早消息。即使 Agent 已退出，也可以只读浏览保留下来的文件。
- **命令与结果**：工具调用和结果按 call ID 关联，独立「命令」视图及可展开卡片，显示具体命令、输出和记录中已有的退出状态。
- **子 Agent**：根据实际父子元数据列出并进入独立子会话，支持返回父会话；不会把对子记录的操作发给父终端。
- **在线会话**：通过 Herdr CLI 发送消息和经确认的按键。通过可核实的 Herdr / 原生进程 / ch-cli 路由信息自动关联历史；缺少唯一标识时可选择候选只读查看，或人工确认对应关系后在本次连接内关联；也保留实时「终端」视图。
- **我的连接**：SSH 用户、设备地址、端口、主机名和连接状态。不会读取服务商 auth/config 登录资料、邮箱或套餐。
- **适配与动效**：小屏/横屏/宽屏布局，底部输入区随键盘调整，页面与弹层过渡、消息入场、按压反馈；尊重系统减少动画设置。

## 连接

1. 电脑安装 Herdr、Python **3.9+**，开启 SSH/SFTP，并以同一用户运行 Herdr。
2. 安装 APK（Android **8.0+**），在「设备」添加连接；想下次直接连接时勾选「记住密码」。
3. 首次连接核对 SSH 主机指纹。已有主机密钥变化时拒绝连接，不自动接受替换。
4. 按 App 提示安装/更新桥接程序。程序写入 `~/.herdr-pocket/bridge-<sha256>.py`，回读校验；无需 sudo，不重启 Herdr，也不开放额外端口。
5. 「会话」继续在线 Agent；「历史」浏览持久记录；「我的」查看 SSH 连接信息。

Sakura Frp 使用 **TCP 隧道，目标指向运行 Herdr 的电脑 SSH 端口**。树莓派可作为 frpc 客户端；App 填公网域名和分配的端口。不要把实际地址、密码或隧道凭据提交到 Git。

也可在电脑以 SSH 用户执行 `python3 scripts/install_bridge.py`，安装与当前源码严格匹配的桥接版本。

## 隐私与边界

- SSH 是唯一网络传输。SSH 终端使用同一已验证连接上的独立 shell 通道。界面 HTML/CSS/JS 内置于 APK，不加载网站、CDN 或远程脚本；禁用 WebView 网络资源、外部导航、文件和内容 URL。
- 保存的设备资料和密码全部加密存于 App 私有存储，密钥留在 Android Keystore。Android 备份关闭。没有分析统计或广告。
- 历史正文按需读取，不复制到电脑索引缓存；私有缓存只保存标题和会话元数据。手机历史和草稿仅在内存中。
- 不读取 Codex/Claude 登录凭据，不显示隐藏推理或系统/开发者消息；内部 guardian 记录不作为用户会话列出。
- 历史与子 Agent 浏览是**只读**。不存在明确在线窗格绑定时不提供发送，不擅自恢复或创建 Agent。
- 本地记录可能已删除、截断或随上游格式变化；当前是有界分页读取，每个消息/工具块最多 16 KB，并标记截断，不承诺找回未持久化的内容。图片只显示附件提示。
- 原会话 ID 不可用时不按目录/标题猜测发送目标；人工关联会列出目标窗格和历史 ID，必须在 App 中明确确认。换 Agent 时重新验证身份；发送超时保留草稿，不自动重发。
- 前台对话定时刷新，不提供后台推送或断线自动重连；进程死亡仍会断开 SSH，内存草稿会丢失。保存的设备与密码不受影响。

## 构建与验证

JDK 17、Android SDK 35、Build Tools 35.0.0。

```sh
./gradlew assembleDebug assembleDebugAndroidTest lintDebug
python3 -m unittest discover -s tests -v
npm ci --ignore-scripts
CHROME_BIN=/path/to/google-chrome npm test
```

APK：`app/build/outputs/apk/debug/app-debug.apk`。浏览器测试只使用离线原生接口替身，Android Instrumentation 单独验证真实 Keystore 加密存储；模拟器执行 `scripts/smoke_ui.py` 验证应用重启后的设备保存和完整聊天交互。

## 自动发布

推送 `main` 后自动运行桥接测试、聊天浏览器检查、Android 构建/lint、Keystore 测试和 API 35 模拟器交互检查。全部通过才发布带固定签名的 `preview-N` APK 与 SHA-256 文件。`v*` 标签发布对应版本，带 `-` 的版本标为预发布。PR 不获得签名 Secret 或发布权限。

从 `preview-7` 开始使用同一独立签名，可覆盖升级。仅最早的 `v0.1.0-alpha.1` 调试签名版本需要卸载一次再安装。

维护者配置仓库 Actions Secrets：`ANDROID_KEYSTORE_BASE64`（JKS，alias 为 `pocket`）和 `ANDROID_KEYSTORE_PASSWORD`。私钥不要入库，需安全备份。CI 仅在 runner 临时目录解码签名文件，签名后删除。versionCode 使用 workflow run number + 100，迁移工作流时保持递增。

协议与验证记录见 [PROTOCOL](docs/PROTOCOL.md)、[SECURITY](SECURITY.md) 和 [VALIDATION](docs/VALIDATION.md)。

## License

MIT. Dependencies retain their licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
