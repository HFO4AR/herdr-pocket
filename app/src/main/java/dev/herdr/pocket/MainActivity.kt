package dev.herdr.pocket

import android.annotation.SuppressLint
import android.app.Activity
import android.app.AlertDialog
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

/** Bundled offline UI only. No web navigation or remote resource can reach the native bridge. */
class MainActivity : Activity() {
    private lateinit var web: WebView
    private val executor = Executors.newSingleThreadExecutor()
    private val transport = SshTransport()
    private val vault by lazy { SecureProfiles(this) }
    private val pins by lazy { getSharedPreferences("connection", MODE_PRIVATE) }
    private val bridge by lazy { assets.open("pocket_bridge.py").use { it.readBytes() } }
    private var connectedDevice: JSONObject? = null
    private var destroyed = false
    private var started = false
    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
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
                v.setPadding(insets.systemWindowInsetLeft, insets.systemWindowInsetTop, insets.systemWindowInsetRight, insets.systemWindowInsetBottom)
                insets
            }
        }
        setContentView(container)
        val html = assets.open("ui/index.html").bufferedReader().use { it.readText() }
            .replace("/*BUNDLED_CSS*/", assets.open("ui/vendor/xterm.css").bufferedReader().use { it.readText() } + assets.open("ui/app.css").bufferedReader().use { it.readText() })
            .replace("/*TERMINAL_VENDOR*/", assets.open("ui/vendor/xterm.js").bufferedReader().use { it.readText() } + "\n" + assets.open("ui/vendor/addon-fit.js").bufferedReader().use { it.readText() })
            .replace("/*TERMINAL_APP*/", assets.open("ui/terminals.js").bufferedReader().use { it.readText() })
            .replace("/*BUNDLED_JS*/", assets.open("ui/app.js").bufferedReader().use { it.readText() })
        web.loadDataWithBaseURL("https://pocket.invalid/", html, "text/html", "UTF-8", null)
    }
    private fun reply(id: String, result: JSONObject) {
        runOnUiThread { if (!destroyed) web.evaluateJavascript("window.nativeResult(${JSONObject.quote(id)}, ${result});", null) }
    }
    private fun progress(id: String, stage: String) {
        runOnUiThread { if (!destroyed) web.evaluateJavascript("window.nativeProgress(${JSONObject.quote(id)}, ${JSONObject.quote(stage)});", null) }
    }
    private fun success(id: String, value: JSONObject) = reply(id, JSONObject().put("ok", true).put("data", value))
    private fun failure(id: String, error: Exception) = reply(id, JSONObject().put("ok", false).put("error", error.message ?: "操作失败"))
    private fun connect(id: String, request: JSONObject, trusted: Boolean = false) {
        val device = vault.get(request.getString("id"))
        val endpoint = Endpoint(device.getString("host"), device.getInt("port"), device.getString("user"))
        val pinId = "pin:${endpoint.host}:${endpoint.port}"
        val password = request.optString("password").ifEmpty { device.optString("password") }
        try {
            transport.connect(endpoint, password, pins.getString(pinId, null)) { stage -> progress(id, stage) }
            transport.useBundled(bridge)
            if (request.has("remember") && request.optString("password").isNotEmpty()) {
                vault.save(JSONObject(device.toString()).put("password", password).put("remember", request.getBoolean("remember")))
            }
            device.put("remember", vault.get(device.getString("id")).optString("password").isNotEmpty())
            connectedDevice = JSONObject(device.toString()).apply { remove("password") }
            progress(id, "SSH 已连接，正在检查桥接程序…")
            val ready = try { transport.request(JSONObject().put("op", "hello")).getInt("protocol") == 1 } catch (_: Exception) { false }
            success(id, JSONObject().put("device", connectedDevice).put("ready", ready).put("devices", vault.list()))
        } catch (e: UntrustedHost) {
            progress(id, "等待你核对并确认 SSH 主机指纹…")
            if (trusted) { failure(id, e); return }
            runOnUiThread {
                AlertDialog.Builder(this).setTitle("核对 SSH 主机指纹")
                    .setMessage("${endpoint.host}:${endpoint.port}\n\n${e.fingerprint}\n\n与电脑上的主机密钥指纹一致后再信任。")
                    .setPositiveButton("信任并连接") { _, _ ->
                        pins.edit().putString(pinId, e.key).apply()
                        executor.execute { try { connect(id, request, true) } catch (error: Exception) { failure(id, error) } }
                    }.setNegativeButton("取消") { _, _ -> failure(id, IllegalStateException("已取消连接")) }
                    .setOnCancelListener { failure(id, IllegalStateException("已取消连接")) }.show()
            }
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
                            if (!pins.getBoolean("profilesMigrated", false)) {
                                val host = pins.getString("host", "") ?: ""
                                val user = pins.getString("user", "") ?: ""
                                if (vault.list().length() == 0 && host.isNotBlank() && user.isNotBlank()) {
                                    vault.save(JSONObject().put("host", host).put("user", user).put("name", host)
                                        .put("port", pins.getString("port", "22")?.toIntOrNull() ?: 22).put("remember", false))
                                }
                                pins.edit().remove("host").remove("port").remove("user").putBoolean("profilesMigrated", true).apply()
                            }
                            success(id, JSONObject().put("devices", vault.list()).put("version", packageManager.getPackageInfo(packageName, 0).versionName))
                        }
                        "saveDevice" -> success(id, vault.save(req))
                        "deleteDevice" -> { vault.delete(req.getString("id")); success(id, JSONObject().put("devices", vault.list())) }
                        "connect" -> { runOnUiThread { window.addFlags(WindowManager.LayoutParams.FLAG_SECURE) }; connectedDevice = null; connect(id, req) }
                        "disconnect" -> { transport.close(); connectedDevice = null; success(id, JSONObject()) }
                        "install" -> {
                            transport.install(bridge)
                            success(id, transport.request(JSONObject().put("op", "hello")))
                        }
                        "protect" -> {
                            runOnUiThread { window.addFlags(WindowManager.LayoutParams.FLAG_SECURE) }
                            success(id, JSONObject())
                        }
                        "demo" -> {
                            check(connectedDevice == null) { "先断开真实设备，再进入演示" }
                            runOnUiThread { window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE) }
                            success(id, JSONObject())
                        }
                        "shellOpen", "shellRead", "shellWrite", "shellResize", "shellClose" -> {
                            check(connectedDevice != null) { "请先连接设备" }
                            success(id, transport.terminal(op, req))
                        }
                        "remote" -> {
                            check(connectedDevice != null) { "请先连接设备" }
                            check(req.optString("op") in setOf("sessions", "agents", "read", "prompt", "key", "catalog", "history", "account", "panes", "paneRead", "paneRun", "paneText", "paneKey")) { "不支持的操作" }
                            success(id, transport.request(req))
                        }
                        else -> error("不支持的操作")
                    }
                } catch (e: Exception) { failure(id, e) }
            }
        }
    }
    @Deprecated("Legacy back dispatch")
    override fun onBackPressed() { if (started) web.evaluateJavascript("window.pocketBack()", null) else super.onBackPressed() }
    override fun onPause() { if (started) web.evaluateJavascript("window.setForeground(false)", null); super.onPause() }
    override fun onResume() { super.onResume(); if (started) web.evaluateJavascript("window.setForeground(true)", null) }
    override fun onDestroy() { destroyed = true; transport.close(); executor.shutdownNow(); web.removeJavascriptInterface("PocketNative"); web.destroy(); super.onDestroy() }
}
