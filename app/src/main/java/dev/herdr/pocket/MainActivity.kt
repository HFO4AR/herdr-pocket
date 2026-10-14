package dev.herdr.pocket

import android.app.Activity
import android.app.AlertDialog
import android.content.ClipboardManager
import android.content.ClipData
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.text.TextWatcher
import android.text.Editable
import android.content.res.Configuration
import android.text.InputType
import android.view.View
import android.widget.*
import org.json.JSONObject
import java.util.UUID
import java.util.concurrent.Executors

class MainActivity : Activity() {
    private val bg = Color.rgb(12, 15, 22)
    private val card = Color.rgb(24, 29, 40)
    private val ink = Color.rgb(237, 240, 248)
    private val muted = Color.rgb(156, 168, 189)
    private val mint = Color.rgb(162, 183, 255)
    private val executor = Executors.newSingleThreadExecutor()
    private val transport = SshTransport()
    private val prefs by lazy { getSharedPreferences("connection", MODE_PRIVATE) }
    private val bridge by lazy { assets.open("pocket_bridge.py").use { it.readBytes() } }
    private lateinit var page: LinearLayout
    private lateinit var status: TextView
    private var busy = false
    private var selectedSession = ""
    private var demo = false
    private var generation = 0
    private var activeAgent: JSONObject? = null
    private lateinit var root: LinearLayout
    private lateinit var contentScroll: ScrollView
    private var screen = "connect"
    private var cachedSessions = listOf<String>()
    private var cachedAgents = listOf<JSONObject>()
    private val drafts = mutableMapOf<String, String>()
    private val handler = Handler(Looper.getMainLooper())
    private var refreshOutput: (() -> Unit)? = null
    private var foreground = false
    private var autoRefresh = true
    private val polling = object : Runnable {
        override fun run() {
            if (foreground && autoRefresh && !busy && screen == "agent") refreshOutput?.invoke()
            if (foreground) handler.postDelayed(this, 3000)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.setFlags(android.view.WindowManager.LayoutParams.FLAG_SECURE, android.view.WindowManager.LayoutParams.FLAG_SECURE)
        connectionPage()
    }
    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()
    private fun shape(color: Int) = GradientDrawable().apply { setColor(color); cornerRadius = dp(12).toFloat() }
    private fun base(kicker: String, title: String, subtitle: String) {
        generation++
        refreshOutput = null
        root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setBackgroundColor(bg) }
        root.setOnApplyWindowInsetsListener { v, insets ->
            v.setPadding(0, insets.systemWindowInsetTop, 0, insets.systemWindowInsetBottom); insets
        }
        val bar = LinearLayout(this).apply {
            gravity = Gravity.CENTER_VERTICAL; setPadding(dp(12), dp(4), dp(20), dp(4))
        }
        if (screen != "connect") bar.addView(Button(this).apply {
            text = "‹"; textSize = 30f; setTextColor(ink); background = shape(bg)
            contentDescription = "返回上一级"; setPadding(0, 0, 0, 0)
            setOnClickListener { navigateBack() }
        }, LinearLayout.LayoutParams(dp(48), dp(48)))
        bar.addView(TextView(this).apply {
            text = "herdr / pocket"; textSize = 18f; setTextColor(ink); typeface = Typeface.create("sans-serif-medium", 0)
            setPadding(dp(8), 0, 0, 0)
        }, LinearLayout.LayoutParams(0, dp(48), 1f))
        root.addView(bar)
        page = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL; setPadding(dp(20), dp(12), dp(20), dp(20))
        }
        contentScroll = ScrollView(this).apply { isFillViewport = true; addView(page) }
        root.addView(contentScroll, LinearLayout.LayoutParams(-1, 0, 1f))
        setContentView(root)
        label(kicker, 11, mint).letterSpacing = .12f
        label(title, if (screen == "agent") 23 else 28, ink).apply {
            typeface = Typeface.create("sans-serif-medium", 0); setPadding(0, dp(8), 0, dp(8))
        }
        label(subtitle, 13, muted)
        status = TextView(this).apply {
            textSize = 12f; setTextColor(muted); setPadding(dp(20), dp(6), dp(20), dp(6))
            accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE
        }
        root.addView(status)
    }
    private fun label(text: String, size: Int = 16, color: Int = ink): TextView {
        return TextView(this).apply {
            this.text = text; textSize = size.toFloat(); setTextColor(color)
            setPadding(0, dp(6), 0, dp(6)); page.addView(this)
        }
    }
    private fun input(hintText: String, initial: String = "", secret: Boolean = false): EditText {
        return EditText(this).apply {
            hint = hintText; setText(initial); textSize = 16f; setTextColor(ink); setHintTextColor(muted)
            background = shape(card); setPadding(dp(16), dp(12), dp(16), dp(12))
            isSingleLine = true
            inputType = if (secret) InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD else InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
            layoutParams = LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(10) }
            page.addView(this)
        }
    }
    private fun button(text: String, primary: Boolean = false, action: () -> Unit): Button {
        return Button(this).apply {
            this.text = text; isAllCaps = false; setTextColor(if (primary) bg else ink)
            background = shape(if (primary) mint else card)
            minHeight = dp(48)
            setPadding(dp(16), dp(12), dp(16), dp(12))
            layoutParams = LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(12) }
            setOnClickListener { if (!busy) action() }
            page.addView(this)
        }
    }
    private fun connectionPage() {
        screen = "connect"; demo = false; activeAgent = null
        window.setFlags(android.view.WindowManager.LayoutParams.FLAG_SECURE, android.view.WindowManager.LayoutParams.FLAG_SECURE)
        base("YOUR WORK, WITH YOU", "把工作，带在身边。", "连接电脑，继续原来的 Agent 会话。")
        label("连接你的电脑", 18)
        label("主机地址", 12, muted)
        val host = input("服务器域名或 IP", prefs.getString("host", "") ?: "")
        label("SSH 端口", 12, muted)
        val port = input("端口", prefs.getString("port", "22") ?: "22").apply { inputType = InputType.TYPE_CLASS_NUMBER }
        label("用户名", 12, muted)
        val user = input("SSH 用户名", prefs.getString("user", "") ?: "")
        label("登录密码", 12, muted)
        val password = input("密码 · 仅本次连接使用", secret = true)
        label("支持局域网、Sakura Frp 等原生 TCP 入口。", 12)
        button("连接电脑", true) {
            val number = port.text.toString().toIntOrNull()
            if (host.text.isBlank() || user.text.isBlank() || number == null || number !in 1..65535) {
                status.text = "填写主机、用户名和有效端口。"; return@button
            }
            val endpoint = Endpoint(host.text.toString().trim(), number, user.text.toString().trim())
            val pass = password.text.toString()
            prefs.edit().putString("host", endpoint.host).putString("port", number.toString()).putString("user", endpoint.user).apply()
            connect(endpoint, pass)
        }
        button("先看看界面 · 演示模式") { demo = true; window.clearFlags(android.view.WindowManager.LayoutParams.FLAG_SECURE); sessionsPage(listOf("demo")) }
        label("开源 · 无账户 · 无广告\n密码不落盘；首次连接核对主机指纹。v0.2.0", 12, muted)
    }
    private fun connect(endpoint: Endpoint, password: String) {
        val pinId = "pin:${endpoint.host}:${endpoint.port}"
        work("正在建立 SSH 连接…", {
            transport.connect(endpoint, password, prefs.getString(pinId, null))
            transport.useBundled(bridge)
        }, {
            screen = "setup"
            base("SSH CONNECTED", "连接已建立", "检查配套桥接程序后即可打开会话。")
            button("安装 / 校验桥接程序", true) { installBridge() }
            button("读取会话") { loadSessions() }
            button("断开连接") { transport.close(); connectionPage() }
            work("检查桥接程序…", { transport.request(JSONObject().put("op", "hello")) }, {
                loadSessions()
            }, { status.text = "需要安装或更新桥接程序。点击上方安装即可。" })
        }, { error ->
            if (error is UntrustedHost) {
                AlertDialog.Builder(this).setTitle("核对服务器指纹")
                    .setMessage("${endpoint.host}:${endpoint.port}\n\n${error.fingerprint}\n\n与服务器公开主机密钥指纹核对后信任。后续密钥变化将拒绝连接。")
                    .setPositiveButton("信任并连接") { _, _ -> prefs.edit().putString(pinId, error.key).apply(); connect(endpoint, password) }
                    .setNegativeButton("取消", null).show()
            } else showError(error)
        })
    }
    private fun installBridge() {
        AlertDialog.Builder(this).setTitle("安装配套桥接程序")
            .setMessage("将 App 自带的开源 Python 程序安装到当前 SSH 用户的 ~/.herdr-pocket。无需 sudo，不重启 Herdr。需要 Python 3.9+。")
            .setPositiveButton("安装并进入") { _, _ ->
                work("正在安装并校验…", { transport.install(bridge); transport.request(JSONObject().put("op", "hello")) }, { loadSessions() })
            }.setNegativeButton("取消", null).show()
    }
    private fun loadSessions() = work("读取会话…", { transport.request(JSONObject().put("op", "sessions")) }, { data ->
        val arr = data.getJSONArray("sessions")
        val names = (0 until arr.length()).map { arr.getJSONObject(it) }.filter { it.optBoolean("running") }.map { it.getString("name") }
        sessionsPage(names)
    })
    private fun sessionsPage(names: List<String>) {
        screen = "sessions"; cachedSessions = names
        base(if (demo) "DEMO · 不连接服务器" else "LIVE / SESSIONS", "会话", "选择电脑上正在运行的 Herdr 会话。")
        if (names.isEmpty()) label("没有运行中的会话。在电脑上启动 Herdr 后刷新。")
        names.forEach { name -> button("$name  →") { selectedSession = name; loadAgents() } }
        if (!demo) button("刷新") { loadSessions() }
        button("断开 / 返回") { transport.close(); connectionPage() }
    }
    private fun loadAgents() {
        if (demo) {
            agentsPage(listOf(JSONObject("""{"pane_id":"demo:1","agent":"codex","agent_status":"idle","workspace_id":"work","terminal_title":"移动端界面设计","identity":"demo"}"""), JSONObject("""{"pane_id":"demo:2","agent":"claude","agent_status":"working","workspace_id":"work","terminal_title":"检查 API 测试","identity":"demo"}""")))
            return
        }
        work("读取 Agent…", { transport.request(JSONObject().put("op", "agents").put("session", selectedSession)) }, { data ->
            val arr = data.getJSONArray("agents"); agentsPage((0 until arr.length()).map { arr.getJSONObject(it) })
        })
    }
    private fun agentsPage(agents: List<JSONObject>) {
        screen = "agents"; activeAgent = null; cachedAgents = agents
        base(if (demo) "DEMO WORKSPACE" else "WORKSPACE / $selectedSession", "你的 Agent", "${agents.size} 个会话 · ${agents.count { it.optString("agent_status") == "working" }} 个运行中")
        val search = input("搜索会话或 Agent")
        val list = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; page.addView(this) }
        fun render(query: String) {
            list.removeAllViews()
            val matches = agents.filter { it.toString().contains(query, ignoreCase = true) }
                .sortedBy { if (it.optString("agent_status") == "blocked") 0 else 1 }
            if (matches.isEmpty()) list.addView(TextView(this).apply {
                text = if (agents.isEmpty()) "还没有识别到 Agent，启动后刷新列表。" else "没有匹配的会话"; setTextColor(muted); setPadding(0, dp(28), 0, dp(28))
            })
            matches.forEach { agent ->
                val name = agent.optString("terminal_title_stripped", agent.optString("terminal_title", agent.optString("agent")))
                val state = when (agent.optString("agent_status")) { "working" -> "运行中"; "blocked" -> "等待处理"; "idle", "done" -> "可对话"; else -> "状态未知" }
                val tile = LinearLayout(this).apply {
                    orientation = LinearLayout.VERTICAL; background = shape(card); setPadding(dp(18), dp(16), dp(18), dp(16))
                    isClickable = true; isFocusable = true
                    val attr = android.util.TypedValue(); theme.resolveAttribute(android.R.attr.selectableItemBackground, attr, true)
                    foreground = getDrawable(attr.resourceId)
                    setOnClickListener { if (!busy) agentPage(agent) }
                }
                fun line(value: String, size: Float, color: Int) = TextView(this).apply {
                    text = value; textSize = size; setTextColor(color); setPadding(0, dp(4), 0, dp(4)); tile.addView(this)
                }
                line("${agent.optString("agent").uppercase()}    /    $state", 11f, mint)
                line(name, 18f, ink).typeface = Typeface.create("sans-serif-medium", 0)
                line("${agent.optString("workspace_id")}   ·   打开会话  →", 12f, muted)
                list.addView(tile, LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(12) })
            }
        }
        render("")
        search.addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) = Unit
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) { render(s.toString()) }
            override fun afterTextChanged(s: Editable?) = Unit
        })
        button("刷新列表") { loadAgents() }
        button("切换 Herdr 会话") { sessionsPage(cachedSessions) }
        status.text = if (demo) "离线演示 · 不连接服务器" else "SSH 已连接 · $selectedSession"
    }
    private fun requestFor(op: String, agent: JSONObject) = JSONObject().put("op", op).put("session", selectedSession)
        .put("target", agent.getString("pane_id")).put("identity", agent.getString("identity"))
    private fun agentPage(agent: JSONObject) {
        screen = "agent"; activeAgent = agent
        val draftKey = "$selectedSession/${agent.getString("pane_id")}/${agent.getString("identity")}"
        base(if (demo) "DEMO / ${agent.optString("agent").uppercase()}" else "${agent.optString("agent").uppercase()} / $selectedSession",
            agent.optString("terminal_title_stripped", agent.optString("terminal_title", agent.optString("agent"))),
            "最近终端输出 · 前台每 3 秒更新")
        val output = label("正在读取…", 14).apply {
            typeface = Typeface.MONOSPACE; setTextIsSelectable(true); background = shape(card)
            setLineSpacing(dp(4).toFloat(), 1f); setPadding(dp(16), dp(16), dp(16), dp(16))
        }
        val footer = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL; setPadding(dp(16), dp(4), dp(16), dp(8)); setBackgroundColor(card)
        }
        root.addView(footer)
        val controls = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; footer.addView(this) }
        fun control(text: String, action: () -> Unit): Button = Button(this).apply {
            this.text = text; textSize = 12f; isAllCaps = false; setTextColor(mint); background = shape(card)
            setPadding(0, 0, 0, 0); minWidth = 0
            controls.addView(this, LinearLayout.LayoutParams(0, dp(48), 1f))
            setOnClickListener { if (!busy) action() }
        }
        fun refresh() {
            if (demo) {
                output.text = "› 帮我检查移动端布局\n\n已完成连接页和 Agent 列表。\n\n• 会话搜索与状态提示\n• 固定输入栏，支持多行消息\n• 返回列表时保留草稿\n\n接下来验证手机上的交互体验。\n\n这是演示内容，不是真实会话。"
                status.text = "离线演示 · 不发送指令"; return
            }
            work("正在同步输出…", { transport.request(requestFor("read", agent)) }, { result ->
                val text = findText(result) ?: result.toString(2)
                if (output.text.toString() != text) {
                    val nearBottom = contentScroll.getChildAt(0).height - contentScroll.height - contentScroll.scrollY < dp(100)
                    output.text = text
                    if (nearBottom) contentScroll.post { contentScroll.fullScroll(View.FOCUS_DOWN) }
                }
                status.text = "已同步 " + java.text.DateFormat.getTimeInstance().format(java.util.Date())
            }, { error -> autoRefresh = false; status.text = "同步暂停：${error.message} · 可点击刷新重试" })
        }
        control("刷新输出") { refresh() }
        val toggle = control(if (autoRefresh) "暂停更新" else "自动更新") { }
        toggle.setOnClickListener { autoRefresh = !autoRefresh; toggle.text = if (autoRefresh) "暂停更新" else "自动更新" }
        control("终端按键") {
            val labels = arrayOf("↑ 上", "↓ 下", "Enter 确认", "Esc 返回", "Ctrl+C 中断")
            val keys = arrayOf("up", "down", "enter", "esc", "ctrl+c")
            AlertDialog.Builder(this).setTitle("终端操作").setItems(labels) { _, index -> sendKey(agent, keys[index]) }.setNegativeButton("取消", null).show()
        }
        val composeRow = LinearLayout(this).apply { gravity = Gravity.BOTTOM; footer.addView(this) }
        val composer = EditText(this).apply {
            hint = "继续这段对话…"; contentDescription = "消息输入框"; setTextColor(ink); setHintTextColor(muted)
            textSize = 15f; background = shape(bg); setPadding(dp(12), dp(12), dp(12), dp(12))
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
            maxLines = 4; minLines = 1; setText(drafts[draftKey] ?: "")
        }
        composeRow.addView(composer, LinearLayout.LayoutParams(0, -2, 1f))
        composer.addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) = Unit
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) { drafts[draftKey] = s.toString() }
            override fun afterTextChanged(s: Editable?) = Unit
        })
        composeRow.addView(Button(this).apply {
            text = "发送"; isAllCaps = false; setTextColor(bg); background = shape(mint); setPadding(0, 0, 0, 0)
            setOnClickListener {
                if (busy || composer.text.isBlank()) return@setOnClickListener
                if (demo) { status.text = "演示模式：没有发送，草稿已保留"; return@setOnClickListener }
                val sent = composer.text.toString()
                work("正在发送…", { transport.request(requestFor("prompt", agent).put("text", sent).put("id", UUID.randomUUID().toString())) }, {
                    if (composer.text.toString() == sent) composer.setText("")
                    status.text = "已发送 · 等待 Agent 响应"
                })
            }
        }, LinearLayout.LayoutParams(dp(64), dp(48)).apply { leftMargin = dp(8) })
        refreshOutput = { refresh() }
        refresh()
    }
    private fun sendKey(agent: JSONObject, key: String) {
        if (demo) { status.text = "演示模式：没有发送按键"; return }
        AlertDialog.Builder(this).setTitle("发送 $key？")
            .setMessage("目标：${agent.optString("agent")} / ${agent.optString("pane_id")}\n请先刷新并阅读终端；Enter 可能批准当前操作。")
            .setPositiveButton("发送") { _, _ ->
                work("正在发送按键…", { transport.request(requestFor("key", agent).put("key", key).put("id", UUID.randomUUID().toString())) }, { status.text = "按键已发送，请刷新输出确认。" })
            }.setNegativeButton("取消", null).show()
    }
    private fun findText(data: JSONObject): String? {
        for (key in listOf("text", "content", "output")) if (data.opt(key) is String) return data.getString(key)
        for (key in data.keys()) if (data.opt(key) is JSONObject) findText(data.getJSONObject(key))?.let { return it }
        return null
    }
    private fun showError(error: Exception) {
        status.text = "失败：${error.message ?: error.javaClass.simpleName}"
        AlertDialog.Builder(this).setTitle("操作未确认成功")
            .setMessage(status.text.toString() + "\n\n没有自动重发。若是发送超时，请先刷新输出确认。")
            .setPositiveButton("知道了", null).setNeutralButton("复制错误") { _, _ ->
                (getSystemService(CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(ClipData.newPlainText("error", status.text))
            }.show()
    }
    private fun <T> work(message: String, block: () -> T, success: (T) -> Unit, failure: (Exception) -> Unit = { showError(it) }) {
        if (busy) return
        busy = true; status.text = message
        val epoch = generation
        executor.execute {
            try { val value = block(); runOnUiThread { busy = false; if (!isDestroyed && generation == epoch) success(value) } }
            catch (e: Exception) { runOnUiThread { busy = false; if (!isDestroyed && generation == epoch) failure(e) } }
        }
    }
    @Deprecated("Legacy Activity navigation")
    override fun onBackPressed() { navigateBack() }
    private fun navigateBack() {
        if (busy) { status.text = "正在处理，请稍候…"; return }
        when (screen) {
            "agent" -> agentsPage(cachedAgents)
            "agents" -> sessionsPage(cachedSessions)
            "sessions", "setup" -> {
                if (demo) connectionPage() else AlertDialog.Builder(this).setTitle("断开电脑连接？")
                    .setPositiveButton("断开") { _, _ -> transport.close(); drafts.clear(); connectionPage() }
                    .setNegativeButton("继续使用", null).show()
            }
            else -> super.onBackPressed()
        }
    }
    override fun onResume() { super.onResume(); foreground = true; handler.removeCallbacks(polling); handler.postDelayed(polling, 3000) }
    override fun onPause() { foreground = false; handler.removeCallbacks(polling); super.onPause() }
    override fun onConfigurationChanged(newConfig: Configuration) { super.onConfigurationChanged(newConfig) }
    override fun onDestroy() { handler.removeCallbacksAndMessages(null); transport.close(); executor.shutdownNow(); super.onDestroy() }
}
