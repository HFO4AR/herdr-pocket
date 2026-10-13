package dev.herdr.pocket

import android.app.Activity
import android.app.AlertDialog
import android.content.ClipboardManager
import android.content.ClipData
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.text.InputType
import android.view.View
import android.widget.*
import org.json.JSONObject
import java.util.UUID
import java.util.concurrent.Executors

class MainActivity : Activity() {
    private val bg = Color.rgb(16, 23, 25)
    private val card = Color.rgb(28, 38, 41)
    private val ink = Color.rgb(234, 244, 241)
    private val muted = Color.rgb(150, 174, 171)
    private val mint = Color.rgb(140, 233, 193)
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

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.setFlags(android.view.WindowManager.LayoutParams.FLAG_SECURE, android.view.WindowManager.LayoutParams.FLAG_SECURE)
        connectionPage()
    }
    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()
    private fun shape(color: Int) = GradientDrawable().apply { setColor(color); cornerRadius = dp(16).toFloat() }
    private fun base(kicker: String, title: String, subtitle: String) {
        generation++
        page = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL; setPadding(dp(22), dp(20), dp(22), dp(28)); setBackgroundColor(bg)
        }
        val scroll = ScrollView(this).apply { isFillViewport = true; addView(page) }
        scroll.setOnApplyWindowInsetsListener { v, insets ->
            v.setPadding(0, insets.systemWindowInsetTop, 0, insets.systemWindowInsetBottom); insets
        }
        setContentView(scroll)
        label(kicker, 12, mint)
        label(title, 30, ink).setPadding(0, dp(12), 0, dp(8))
        label(subtitle, 14, muted)
        status = label("", 13, mint)
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
            layoutParams = LinearLayout.LayoutParams(-1, dp(52)).apply { topMargin = dp(12) }
            setOnClickListener { if (!busy) action() }
            page.addView(this)
        }
    }
    private fun connectionPage() {
        demo = false; activeAgent = null
        window.setFlags(android.view.WindowManager.LayoutParams.FLAG_SECURE, android.view.WindowManager.LayoutParams.FLAG_SECURE)
        base("HERDR POCKET  /  01", "随时，接着聊。", "你的电脑继续工作。手机接入原来的会话。")
        label("SSH 连接", 18)
        val host = input("服务器域名或 IP", prefs.getString("host", "") ?: "")
        val port = input("端口", prefs.getString("port", "22") ?: "22").apply { inputType = InputType.TYPE_CLASS_NUMBER }
        val user = input("SSH 用户名", prefs.getString("user", "") ?: "")
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
        label("开源 · 无账户 · 无广告\n密码不落盘；首次连接核对主机指纹。v0.1.0", 12, muted)
    }
    private fun connect(endpoint: Endpoint, password: String) {
        val pinId = "pin:${endpoint.host}:${endpoint.port}"
        work("正在建立 SSH 连接…", {
            transport.connect(endpoint, password, prefs.getString(pinId, null))
            transport.useBundled(bridge)
        }, {
            base("CONNECTED", "电脑已连接", "首次使用先安装配套桥接程序。已安装可以直接进入。")
            button("安装 / 校验桥接程序", true) {
                AlertDialog.Builder(this).setTitle("安装到当前 SSH 用户")
                    .setMessage("将随 App 提供的开源 Python 桥接程序写入 ~/.herdr-pocket。无需 sudo，不开放端口，不重启 Herdr。服务器需要 Python 3.9+。")
                    .setPositiveButton("安装") { _, _ -> work("正在上传并校验…", { transport.install(bridge); transport.request(JSONObject().put("op", "hello")) }, { status.text = "桥接程序已就绪"; loadSessions() }) }
                    .setNegativeButton("取消", null).show()
            }
            button("读取会话") { loadSessions() }
            button("断开") { transport.close(); connectionPage() }
        }, { error ->
            if (error is UntrustedHost) {
                AlertDialog.Builder(this).setTitle("核对服务器指纹")
                    .setMessage("${endpoint.host}:${endpoint.port}\n\n${error.fingerprint}\n\n与服务器公开主机密钥指纹核对后信任。后续密钥变化将拒绝连接。")
                    .setPositiveButton("信任并连接") { _, _ -> prefs.edit().putString(pinId, error.key).apply(); connect(endpoint, password) }
                    .setNegativeButton("取消", null).show()
            } else showError(error)
        })
    }
    private fun loadSessions() = work("读取会话…", { transport.request(JSONObject().put("op", "sessions")) }, { data ->
        val arr = data.getJSONArray("sessions")
        val names = (0 until arr.length()).map { arr.getJSONObject(it) }.filter { it.optBoolean("running") }.map { it.getString("name") }
        sessionsPage(names)
    })
    private fun sessionsPage(names: List<String>) {
        base(if (demo) "DEMO · 不连接服务器" else "LIVE / SESSIONS", "会话", "选择电脑上正在运行的 Herdr 会话。")
        if (names.isEmpty()) label("没有运行中的会话。在电脑上启动 Herdr 后刷新。")
        names.forEach { name -> button("$name  →", true) { selectedSession = name; loadAgents() } }
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
        activeAgent = null
        base(if (demo) "DEMO · 示例数据" else "LIVE / $selectedSession", "你的 Agent", "${agents.size} 个会话中的 Agent · 点击查看输出")
        if (agents.isEmpty()) label("当前没有识别到的 Agent。")
        agents.sortedBy { if (it.optString("agent_status") == "blocked") 0 else 1 }.forEach { agent ->
            val name = agent.optString("terminal_title_stripped", agent.optString("terminal_title", agent.optString("agent")))
            val state = agent.optString("agent_status")
            button("${agent.optString("agent")} · $state\n$name") { agentPage(agent) }
        }
        button("刷新列表", true) { loadAgents() }
        button("返回会话") { if (demo) sessionsPage(listOf("demo")) else loadSessions() }
    }
    private fun requestFor(op: String, agent: JSONObject) = JSONObject().put("op", op).put("session", selectedSession)
        .put("target", agent.getString("pane_id")).put("identity", agent.getString("identity"))
    private fun agentPage(agent: JSONObject) {
        activeAgent = agent
        base(if (demo) "DEMO · 不发送指令" else "${agent.optString("workspace_id")} / ${agent.optString("pane_id")}", agent.optString("agent"), "最近终端输出 · 手动刷新 · 不代表完整聊天历史")
        val output = label("正在读取…", 13).apply {
            typeface = Typeface.MONOSPACE; setTextIsSelectable(true); background = shape(card)
            setPadding(dp(14), dp(14), dp(14), dp(14)); minHeight = dp(180)
        }
        val composer = input("给这个 Agent 发消息").apply { isSingleLine = false; maxLines = 6; minLines = 2 }
        fun refresh() {
            if (demo) { output.text = "› 帮我检查移动端布局\n\n已完成连接页和 Agent 列表。\n接下来验证手机上的交互体验。\n\n这是演示内容，不是真实会话。"; return }
            work("读取输出…", { transport.request(requestFor("read", agent)) }, { result ->
                output.text = findText(result) ?: result.toString(2)
                status.text = "输出已更新 · ${java.text.DateFormat.getTimeInstance().format(java.util.Date())}"
            })
        }
        button("发送", true) {
            if (composer.text.isBlank()) return@button
            if (demo) { status.text = "演示模式：没有发送"; return@button }
            val req = requestFor("prompt", agent).put("text", composer.text.toString()).put("id", UUID.randomUUID().toString())
            work("正在发送…", { transport.request(req) }, {
                composer.setText(""); status.text = "指令已发送；Agent 尚未确认任务完成。"
            })
        }
        button("刷新输出") { refresh() }
        val keys = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; page.addView(this) }
        listOf("↑" to "up", "↓" to "down", "Enter" to "enter", "Esc" to "esc").forEach { (label, key) ->
            keys.addView(Button(this).apply {
                text = label; isAllCaps = false; layoutParams = LinearLayout.LayoutParams(0, dp(54), 1f)
                setOnClickListener { if (!busy) sendKey(agent, key) }
            })
        }
        button("中断当前运行 · Ctrl+C") { sendKey(agent, "ctrl+c") }
        button("返回 Agent 列表") { loadAgents() }
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
    override fun onBackPressed() { if (!busy) { transport.close(); connectionPage() } }
    override fun onDestroy() { transport.close(); executor.shutdownNow(); super.onDestroy() }
}
