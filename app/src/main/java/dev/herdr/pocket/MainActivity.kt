package dev.herdr.pocket

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import org.json.JSONObject
import java.util.concurrent.Executors

private const val UNATTENDED_PAUSE_MS = 60_000L

// Keep in sync with scripts/ui_bundle.cjs (browser tests). app.js is last: it boots the UI.
private val UI_CSS = listOf("ui/vendor/xterm.css", "ui/app.css", "ui/chat.css", "ui/timeline.css", "ui/markdown.css")
private val UI_JS = listOf("ui/markdown.js", "ui/timeline.js", "ui/demo.js", "ui/app.js")

/** Bundled offline UI only. No web navigation or remote resource can reach the native bridge. */
class MainActivity : Activity() {
    private lateinit var web: WebView
    // Two workers: a slow history read must not block a status poll or a key press.
    private val executor = Executors.newFixedThreadPool(2)
    private val core = PocketCore
    private var destroyed = false
    private var started = false
    private var pendingPane: String? = null
    // Latest Herdr session and agent states shown in the UI, handed to the watcher.
    @Volatile private var watchSession = ""
    @Volatile private var watchStates = "{}"
    private var pausedAt = 0L
    private var watched = false

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        core.init(this)
        window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        pendingPane = intent?.getStringExtra(WatchService.EXTRA_PANE)
        web = WebView(this)
        web.setBackgroundColor(android.graphics.Color.rgb(251, 250, 246))
        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = false
            allowFileAccess = false
            allowContentAccess = false
            mixedContentMode = android.webkit.WebSettings.MIXED_CONTENT_NEVER_ALLOW
            blockNetworkLoads = true
            builtInZoomControls = false
        }
        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest) = true
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse =
                WebResourceResponse("text/plain", "UTF-8", "".byteInputStream())
            override fun onPageFinished(view: WebView, url: String) {
                started = true
                val reduced = Settings.Global.getFloat(contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f
                web.evaluateJavascript("document.documentElement.classList.toggle('reduce-motion', $reduced)", null)
            }
        }
        web.addJavascriptInterface(Native(), "PocketNative")
        val container = FrameLayout(this).apply {
            addView(web, FrameLayout.LayoutParams(-1, -1))
            setOnApplyWindowInsetsListener { v, insets ->
                @Suppress("DEPRECATION")
                v.setPadding(insets.systemWindowInsetLeft, insets.systemWindowInsetTop, insets.systemWindowInsetRight, insets.systemWindowInsetBottom)
                insets
            }
        }
        setContentView(container)
        val html = assets.open("ui/index.html").bufferedReader().use { it.readText() }
            .replace("/*BUNDLED_CSS*/", UI_CSS.joinToString("\n") { asset(it) })
            .replace("/*TERMINAL_VENDOR*/", assets.open("ui/vendor/xterm.js").bufferedReader().use { it.readText() } + "\n" + assets.open("ui/vendor/addon-fit.js").bufferedReader().use { it.readText() })
            .replace("/*TERMINAL_APP*/", assets.open("ui/terminals.js").bufferedReader().use { it.readText() })
            .replace("/*BUNDLED_JS*/", UI_JS.joinToString("\n") { asset(it) })
        web.loadDataWithBaseURL("https://pocket.invalid/", html, "text/html", "UTF-8", null)
        core.listener = { type, detail -> event(JSONObject().put("type", type).put("detail", detail)) }
    }

    private fun asset(name: String) = assets.open(name).bufferedReader().use { it.readText() }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        intent.getStringExtra(WatchService.EXTRA_PANE)?.let { pane ->
            if (started) web.evaluateJavascript("window.openFromNotification(${JSONObject.quote(pane)})", null) else pendingPane = pane
        }
    }

    private fun js(code: String) = runOnUiThread { if (!destroyed) web.evaluateJavascript(code, null) }
    private fun reply(id: String, result: JSONObject) = js("window.nativeResult(${JSONObject.quote(id)}, ${result});")
    private fun progress(id: String, stage: String) = js("window.nativeProgress(${JSONObject.quote(id)}, ${JSONObject.quote(stage)});")
    private fun event(value: JSONObject) = js("window.nativeEvent && window.nativeEvent($value);")
    private fun success(id: String, value: JSONObject) = reply(id, JSONObject().put("ok", true).put("data", value))
    private fun failure(id: String, error: Exception) = reply(id, JSONObject().put("ok", false).put("error", error.message ?: "操作失败"))

    private fun connect(id: String, request: JSONObject, trusted: Boolean = false) {
        val device = core.vault.get(request.getString("id"))
        val endpoint = core.endpointOf(device)
        val password = request.optString("password").ifEmpty { device.optString("password") }
        try {
            core.connect(device, password) { stage -> progress(id, stage) }
            if (request.has("remember") && request.optString("password").isNotEmpty()) {
                core.vault.save(JSONObject(device.toString()).put("password", password).put("remember", request.getBoolean("remember")))
            }
            val remembered = core.vault.get(device.getString("id")).optString("password").isNotEmpty()
            val shown = JSONObject(core.connectedDevice.toString()).put("remember", remembered)
            progress(id, "SSH 已连接，正在检查桥接程序…")
            val ready = try { core.request(JSONObject().put("op", "hello")).getInt("protocol") == 1 } catch (_: Exception) { false }
            success(id, JSONObject().put("device", shown).put("ready", ready).put("devices", core.vault.list()))
            runOnUiThread { askNotificationPermission() }
        } catch (e: UntrustedHost) {
            progress(id, "等待你核对并确认 SSH 主机指纹…")
            if (trusted) { failure(id, e); return }
            runOnUiThread {
                AlertDialog.Builder(this).setTitle("核对 SSH 主机指纹")
                    .setMessage("${endpoint.host}:${endpoint.port}\n\n${e.fingerprint}\n\n与电脑上的主机密钥指纹一致后再信任。")
                    .setPositiveButton("信任并连接") { _, _ ->
                        core.pins.edit().putString(core.pinId(endpoint), e.key).apply()
                        executor.execute { try { connect(id, request, true) } catch (error: Exception) { failure(id, error) } }
                    }.setNegativeButton("取消") { _, _ -> failure(id, IllegalStateException("已取消连接")) }
                    .setOnCancelListener { failure(id, IllegalStateException("已取消连接")) }.show()
            }
        }
    }

    private fun askNotificationPermission() {
        if (Build.VERSION.SDK_INT >= 33 && core.alertsEnabled && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
            && !core.settings.getBoolean("askedNotifications", false)) {
            core.settings.edit().putBoolean("askedNotifications", true).apply()
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 7)
        }
    }

    inner class Native {
        @JavascriptInterface fun request(id: String, op: String, raw: String) {
            if (raw.length > 70000 || id.length > 80) return
            executor.execute {
                try {
                    val req = JSONObject(raw)
                    when (op) {
                        "devices" -> {
                            val pins = core.pins
                            if (!pins.getBoolean("profilesMigrated", false)) {
                                val host = pins.getString("host", "") ?: ""
                                val user = pins.getString("user", "") ?: ""
                                if (core.vault.list().length() == 0 && host.isNotBlank() && user.isNotBlank()) {
                                    core.vault.save(JSONObject().put("host", host).put("user", user).put("name", host)
                                        .put("port", pins.getString("port", "22")?.toIntOrNull() ?: 22).put("remember", false))
                                }
                                pins.edit().remove("host").remove("port").remove("user").putBoolean("profilesMigrated", true).apply()
                            }
                            success(id, JSONObject().put("devices", core.vault.list()).put("version", packageManager.getPackageInfo(packageName, 0).versionName)
                                .put("alerts", core.alertsEnabled).apply {
                                    // The activity can be recreated while the watcher kept the session.
                                    core.connectedDevice?.let { d -> put("connected", JSONObject(d.toString()).put("remember",
                                        core.vault.get(d.getString("id")).optString("password").isNotEmpty())) }
                                })
                            pendingPane?.let { pane -> pendingPane = null; js("window.openFromNotification(${JSONObject.quote(pane)})") }
                        }
                        "saveDevice" -> success(id, core.vault.save(req))
                        "deleteDevice" -> { core.vault.delete(req.getString("id")); success(id, JSONObject().put("devices", core.vault.list())) }
                        "connect" -> { runOnUiThread { window.addFlags(WindowManager.LayoutParams.FLAG_SECURE) }; connect(id, req) }
                        "disconnect" -> { WatchService.stop(this@MainActivity); core.disconnect(); success(id, JSONObject()) }
                        "install" -> {
                            core.transport.install(core.bridge)
                            success(id, core.request(JSONObject().put("op", "hello")))
                        }
                        "protect" -> {
                            runOnUiThread { window.addFlags(WindowManager.LayoutParams.FLAG_SECURE) }
                            success(id, JSONObject())
                        }
                        "demo" -> {
                            check(core.connectedDevice == null) { "先断开真实设备，再进入演示" }
                            runOnUiThread { window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE) }
                            success(id, JSONObject())
                        }
                        "watchState" -> {
                            watchSession = req.optString("session")
                            watchStates = req.optJSONObject("states")?.toString() ?: "{}"
                            success(id, JSONObject())
                        }
                        "setAlerts" -> {
                            core.settings.edit().putBoolean("backgroundAlerts", req.getBoolean("enabled")).apply()
                            if (req.getBoolean("enabled")) runOnUiThread { core.settings.edit().putBoolean("askedNotifications", false).apply(); askNotificationPermission() }
                            success(id, JSONObject().put("alerts", core.alertsEnabled))
                        }
                        "shellOpen", "shellRead", "shellWrite", "shellResize", "shellClose" -> success(id, core.terminal(op, req))
                        "remote" -> {
                            check(req.optString("op") in setOf("sessions", "agents", "status", "read", "prompt", "key", "catalog", "history", "account", "panes", "paneRead", "paneRun", "paneText", "paneKey")) { "不支持的操作" }
                            success(id, core.request(req))
                        }
                        else -> error("不支持的操作")
                    }
                } catch (e: Exception) { failure(id, e) }
            }
        }
    }

    @Deprecated("Legacy back dispatch")
    override fun onBackPressed() { if (started) web.evaluateJavascript("window.pocketBack()", null) else super.onBackPressed() }
    override fun onPause() {
        if (started) web.evaluateJavascript("window.setForeground(false)", null)
        pausedAt = android.os.SystemClock.elapsedRealtime(); watched = false
        // Hand over to the watcher while the app is not visible; it only reads state.
        if (core.connectedDevice != null && core.alertsEnabled && watchSession.isNotEmpty() && !isChangingConfigurations) {
            try { WatchService.start(this, watchSession, watchStates); watched = true } catch (_: Exception) {}
        }
        super.onPause()
    }
    override fun onResume() {
        super.onResume()
        WatchService.stop(this)
        // Without the watcher Android may freeze the app in the background, so keepalives stop and a
        // carrier NAT or the frp tunnel can drop the TCP connection without telling us. Swap in a
        // fresh session before the first refresh instead of waiting for a channel to time out.
        if (pausedAt > 0 && !watched && android.os.SystemClock.elapsedRealtime() - pausedAt > UNATTENDED_PAUSE_MS) core.markSuspect()
        pausedAt = 0
        if (started) web.evaluateJavascript("window.setForeground(true)", null)
    }
    override fun onDestroy() {
        destroyed = true
        core.listener = null
        // Leaving the app ends the connection unless the watcher is keeping it for alerts.
        if (isFinishing) { WatchService.stop(this); core.disconnect() }
        executor.shutdownNow(); web.removeJavascriptInterface("PocketNative"); web.destroy(); super.onDestroy()
    }
}
