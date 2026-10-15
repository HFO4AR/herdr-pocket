package dev.herdr.pocket

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.os.ext.SdkExtensions
import android.provider.MediaStore
import android.provider.Settings
import android.view.View
import android.window.OnBackInvokedCallback
import android.window.OnBackInvokedDispatcher
import android.view.WindowInsetsController
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.concurrent.Executors

private const val UNATTENDED_PAUSE_MS = 60_000L
private const val PICK_GALLERY = 41
private const val PICK_CAMERA = 42
private const val PICK_FILES = 43
private const val ASK_PHOTOS = 44
private const val PICK_KEY = 45

// Keep in sync with scripts/ui_bundle.cjs (browser tests). app.js is last: it boots the UI.
private val UI_CSS = listOf("ui/vendor/xterm.css", "ui/app.css", "ui/chat.css", "ui/timeline.css", "ui/markdown.css", "ui/follow.css", "ui/answer.css", "ui/images.css", "ui/files.css", "ui/queue.css", "ui/create.css", "ui/slash.css", "ui/close.css", "ui/settings.css", "ui/keys.css", "ui/onboard.css", "ui/native.css", "ui/lists.css", "ui/help.css")
private val UI_JS = listOf("ui/markdown.js", "ui/timeline.js", "ui/images.js", "ui/files.js", "ui/answer.js", "ui/demo.js", "ui/follow.js", "ui/queue.js", "ui/create.js", "ui/slash.js", "ui/close.js", "ui/cache.js", "ui/settings.js", "ui/keys.js", "ui/onboard.js", "ui/native.js", "ui/glance.js", "ui/help.js", "ui/app.js")

/** Bundled offline UI only. No web navigation or remote resource can reach the native bridge. */
class MainActivity : Activity() {
    private lateinit var web: WebView
    // Several workers: a remote history read can take seconds (it goes through a second SSH hop),
    // and must not hold up a status poll or a key press. Pictures get their own workers so a
    // screenful of thumbnails never queues in front of the conversation.
    private val executor = Executors.newFixedThreadPool(4)
    private val pictures = Executors.newFixedThreadPool(2)
    private val core = PocketCore
    private var destroyed = false
    private var started = false
    private var pendingPane: String? = null
    // Latest Herdr session and agent states shown in the UI, handed to the watcher.
    @Volatile private var watchSession = ""
    @Volatile private var watchStates = "{}"
    private var pausedAt = 0L
    private var watched = false
    // One picker at a time: the request waiting for it, how many pictures it may add, the camera target.
    private var pickId: String? = null
    private var pickMax = 4
    private var shot: File? = null
    // Paints the strips behind the status and navigation bars (edge-to-edge, see SystemBars).
    private val bars = BarsBackground()
    // Something shared from another app, waiting for the page to be ready (see ShareIn).
    private var pendingShare: String? = null
    private var backCallback: Any? = null

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        core.init(this)
        if (core.alertsEnabled) WatchService.ensureChannels(this)
        applySecure()
        SystemBars.edgeToEdge(window)
        pendingPane = intent?.getStringExtra(WatchService.EXTRA_PANE)
        web = WebView(this)
        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = false
            allowFileAccess = false
            allowContentAccess = false
            mixedContentMode = android.webkit.WebSettings.MIXED_CONTENT_NEVER_ALLOW
            blockNetworkLoads = true
            builtInZoomControls = false
            textZoom = core.settings.getInt("textZoom", 100)
        }
        applyBars()
        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest) = true
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse =
                WebResourceResponse("text/plain", "UTF-8", "".byteInputStream())
            override fun onPageFinished(view: WebView, url: String) {
                started = true
                val reduced = Settings.Global.getFloat(contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f
                web.evaluateJavascript("document.documentElement.classList.toggle('reduce-motion', $reduced)", null)
                pendingShare?.let { pendingShare = null; deliverShare(it) }
            }
        }
        web.addJavascriptInterface(Native(), "PocketNative")
        val container = FrameLayout(this).apply {
            addView(web, FrameLayout.LayoutParams(-1, -1))
            background = bars
        }
        SystemBars.pad(container, bars)
        setContentView(container)
        registerBack()
        intent?.let { if (ShareIn.isShare(it)) receiveShare(it) }
        val html = assets.open("ui/index.html").bufferedReader().use { it.readText() }
            .replace("<html lang=\"zh-CN\">", "<html lang=\"zh-CN\" data-theme=\"${if (dark()) "dark" else "light"}\">")
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
        if (ShareIn.isShare(intent)) { receiveShare(intent); return }
        intent.getStringExtra(WatchService.EXTRA_PANE)?.let { pane ->
            if (started) web.evaluateJavascript("window.openFromNotification(${JSONObject.quote(pane)})", null) else pendingPane = pane
        }
    }

    /** Pictures are prepared off the UI thread; the page shows a waiting card meanwhile. */
    private fun receiveShare(intent: Intent) {
        setIntent(Intent(this, MainActivity::class.java))
        if (started) web.evaluateJavascript("window.pocketShare && window.pocketShare({preparing:true})", null)
        executor.execute {
            val payload = try { ShareIn.read(contentResolver, intent) } catch (e: Exception) {
                JSONObject().put("text", "").put("images", JSONArray()).put("files", JSONArray()).put("failed", 1).put("reason", e.message ?: "")
            }
            runOnUiThread { if (started) deliverShare(payload.toString()) else pendingShare = payload.toString() }
        }
    }
    private fun deliverShare(payload: String) { if (!destroyed) web.evaluateJavascript("window.pocketShare && window.pocketShare($payload)", null) }

    /** Android 13+ back (predictive back on 14+): the page decides, exactly like the legacy key. */
    private fun registerBack() {
        if (Build.VERSION.SDK_INT < 33) return
        val callback = OnBackInvokedCallback { if (started) web.evaluateJavascript("window.pocketBack()", null) else finish() }
        onBackInvokedDispatcher.registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT, callback)
        backCallback = callback
    }

    private fun notificationsAllowed(): Boolean = getSystemService(android.app.NotificationManager::class.java).areNotificationsEnabled()

    private fun js(code: String) = runOnUiThread { if (!destroyed) web.evaluateJavascript(code, null) }
    private fun reply(id: String, result: JSONObject) = js("window.nativeResult(${JSONObject.quote(id)}, ${result});")
    private fun progress(id: String, stage: String) = js("window.nativeProgress(${JSONObject.quote(id)}, ${JSONObject.quote(stage)});")
    private fun event(value: JSONObject) = js("window.nativeEvent && window.nativeEvent($value);")
    private fun success(id: String, value: JSONObject) = reply(id, JSONObject().put("ok", true).put("data", value))
    private fun failure(id: String, error: Exception) = reply(id, JSONObject().put("ok", false).put("error", error.message ?: "操作失败").apply {
        if (error is Friendly) { put("code", error.code); error.info?.let { put("info", it) } }
    })

    /** A host key seen on the last connect attempt, waiting for the user's decision in the trust sheet. Memory only. */
    private class PendingTrust(val device: String, val endpoint: Endpoint, val host: UntrustedHost)
    @Volatile private var pendingTrust: PendingTrust? = null
    /** Device whose last connect was refused for a changed key; only then may its pin be forgotten. */
    @Volatile private var changedFor: String? = null

    private fun hostInfo(endpoint: Endpoint, fingerprint: String, type: String) =
        JSONObject().put("host", endpoint.host).put("port", endpoint.port).put("fingerprint", fingerprint).put("type", type)

    private fun connect(id: String, request: JSONObject) {
        val device = core.vault.get(request.getString("id"))
        val endpoint = core.endpointOf(device)
        val password = request.optString("password").ifEmpty { device.optString("password") }
        try {
            core.connect(device, password) { stage -> progress(id, stage) }
        } catch (e: UntrustedHost) {
            // First use: nothing is pinned until the user taps 「信任并连接」 for exactly this key.
            pendingTrust = PendingTrust(device.getString("id"), endpoint, e)
            throw Friendly("hostkey_new", "第一次连这台电脑，先核对一下 SSH 指纹。", hostInfo(endpoint, e.fingerprint, e.type))
        } catch (e: HostKeyChanged) {
            changedFor = device.getString("id")
            throw Friendly("hostkey_changed", e.message ?: "", hostInfo(endpoint, e.fingerprint, e.type).put("previous", e.previous))
        } catch (e: Exception) {
            throw ConnectErrors.connect(e, endpoint, usingKey = core.usesKey(device))
        }
        if (!core.usesKey(device) && request.has("remember") && request.optString("password").isNotEmpty()) {
            core.vault.save(JSONObject(device.toString()).put("password", password).put("remember", request.getBoolean("remember")))
        }
        val remembered = core.vault.get(device.getString("id")).optString("password").isNotEmpty()
        val shown = JSONObject(core.connectedDevice.toString()).put("remember", remembered)
        progress(id, "SSH 已连接，正在检查桥接程序…")
        val result = JSONObject().put("device", shown).put("devices", core.vault.list())
        val hello = try { core.request(JSONObject().put("op", "hello")) } catch (e: Friendly) {
            // Without a usable Python nothing else can work: say so instead of offering an install.
            if (e.code == "python_missing" || e.code == "python_old") { core.disconnect(); throw e }
            null
        } catch (_: Exception) { null }
        val ready = hello?.optInt("protocol") == 1
        result.put("ready", ready)
        if (ready) result.put("host", doctor()) else result.put("upgrade", core.transport.hasOtherBridge(core.bridge))
        success(id, result)
        runOnUiThread { askNotificationPermission() }
    }

    /** Is Herdr installed and running on the computer? Read-only; null if the bridge cannot tell. */
    private fun doctor(): JSONObject? = try { core.request(JSONObject().put("op", "doctor")) } catch (_: Exception) { null }

    private fun dark(): Boolean = when (core.settings.getString("theme", "system")) {
        "dark" -> true
        "light" -> false
        else -> (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES
    }

    /** Screenshots are allowed unless the user turned on screen protection in 设置. */
    private fun applySecure() {
        if (core.settings.getBoolean("secureScreen", false)) window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        else window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
    }

    /** System bars and the WebView backdrop follow the page theme, so nothing flashes light in dark mode. */
    @Suppress("DEPRECATION")
    private fun applyBars() {
        val dark = dark()
        val bg = if (dark) Color.rgb(21, 21, 20) else Color.rgb(251, 250, 246)
        val nav = if (dark) Color.rgb(31, 30, 28) else Color.WHITE
        if (Build.VERSION.SDK_INT < 30) { window.statusBarColor = bg; window.navigationBarColor = nav }
        bars.topColor = bg; bars.bottomColor = nav; bars.invalidateSelf()
        window.setBackgroundDrawable(android.graphics.drawable.ColorDrawable(bg))
        if (::web.isInitialized) {
            web.setBackgroundColor(bg)
            if (started) web.evaluateJavascript("window.applyTheme && window.applyTheme(${if (dark) "'dark'" else "'light'"})", null)
        }
        if (Build.VERSION.SDK_INT >= 30) {
            val mask = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS or WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS
            window.insetsController?.setSystemBarsAppearance(if (dark) 0 else mask, mask)
        } else {
            var flags = window.decorView.systemUiVisibility and (View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR or View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR).inv()
            if (!dark) flags = flags or View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR or (if (Build.VERSION.SDK_INT >= 27) View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR else 0)
            window.decorView.systemUiVisibility = flags
        }
    }

    private fun prefs(): JSONObject = JSONObject()
        .put("theme", core.settings.getString("theme", "system")).put("dark", dark())
        .put("textZoom", core.settings.getInt("textZoom", 100))
        .put("secureScreen", core.settings.getBoolean("secureScreen", false))
        .put("autoUpdate", core.settings.getBoolean("autoUpdate", true))
        .put("seenUpdate", core.settings.getString("seenUpdate", ""))
        .put("alerts", core.alertsEnabled).put("notifications", notificationsAllowed())
        .put("version", Updater.currentName(this)).put("versionCode", Updater.currentCode(this))
        .put("update", core.settings.getString("updateResult", null)?.let { JSONObject(it) } ?: JSONObject.NULL)

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        applyBars()
    }

    private fun askNotificationPermission() {
        if (Build.VERSION.SDK_INT >= 33 && core.alertsEnabled && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
            && !core.settings.getBoolean("askedNotifications", false)) {
            core.settings.edit().putBoolean("askedNotifications", true).apply()
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 7)
        }
    }

    inner class Native {
        /** Fire-and-forget touch feedback ("confirm", "tick", "long"); no reply. */
        @JavascriptInterface fun haptic(kind: String) { if (kind.length <= 16) runOnUiThread { if (!destroyed) SystemBars.haptic(web, kind) } }

        @JavascriptInterface fun request(id: String, op: String, raw: String) {
            // Only cache writes carry a whole chat; everything else stays small.
            if (raw.length > (if (op == "cachePut") 1_600_000 else 70000) || id.length > 80) return
            (if (op == "image") pictures else executor).execute {
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
                        "saveDevice" -> success(id, core.vault.save(req).also { if (req.optString("auth") == "key") core.forgetSessionPassword(req.optString("id")) })
                        "deleteDevice" -> { core.vault.delete(req.getString("id")); core.cache.drop(req.getString("id")); success(id, JSONObject().put("devices", core.vault.list())) }
                        "connect" -> { runOnUiThread { applySecure() }; connect(id, req) }
                        "disconnect" -> { WatchService.stop(this@MainActivity); core.disconnect(); success(id, JSONObject()) }
                        "trustHost" -> {
                            // Pins only the key the last attempt saw, for the same device and address.
                            val pending = pendingTrust ?: error("没有等待核对的指纹，重新连接一次")
                            val device = core.vault.get(req.getString("id"))
                            check(pending.device == device.getString("id") && pending.endpoint == core.endpointOf(device)
                                && req.getString("fingerprint") == pending.host.fingerprint) { "指纹和刚才看到的不一致，重新连接再核对" }
                            pendingTrust = null
                            check(core.pins.edit().putString(core.pinId(pending.endpoint), pending.host.key).commit()) { "指纹保存失败" }
                            success(id, JSONObject())
                        }
                        "forgetHost" -> {
                            // Only after the user saw the changed-key warning for this device; the next connect asks again.
                            val device = core.vault.get(req.getString("id"))
                            check(changedFor == device.getString("id")) { "这台设备没有指纹变化，不需要重新核对" }
                            changedFor = null; pendingTrust = null
                            check(core.pins.edit().remove(core.pinId(core.endpointOf(device))).commit()) { "操作失败" }
                            success(id, JSONObject())
                        }
                        "reconnect" -> { core.retry(); success(id, JSONObject()) }
                        "install" -> {
                            try { core.transport.install(core.bridge) } catch (e: Exception) { throw ConnectErrors.install(e) }
                            success(id, core.request(JSONObject().put("op", "hello")).put("host", doctor() ?: JSONObject.NULL))
                        }
                        "protect" -> {
                            runOnUiThread { applySecure() }
                            success(id, JSONObject())
                        }
                        "settings" -> success(id, prefs())
                        "setSetting" -> {
                            val edit = core.settings.edit()
                            when (req.getString("key")) {
                                "theme" -> edit.putString("theme", req.getString("value").also { require(it in setOf("system", "light", "dark")) { "不支持的主题" } })
                                "textZoom" -> edit.putInt("textZoom", req.getInt("value").also { require(it in setOf(90, 100, 115, 130)) { "不支持的字号" } })
                                "secureScreen" -> edit.putBoolean("secureScreen", req.getBoolean("value"))
                                "autoUpdate" -> edit.putBoolean("autoUpdate", req.getBoolean("value"))
                                "seenUpdate" -> edit.putString("seenUpdate", req.getString("value").take(64))
                                else -> error("不支持的设置")
                            }
                            edit.commit()
                            runOnUiThread { applySecure(); applyBars(); web.settings.textZoom = core.settings.getInt("textZoom", 100) }
                            success(id, prefs())
                        }
                        "checkUpdate" -> {
                            val cached = core.settings.getString("updateResult", null)?.let { JSONObject(it) }
                            val fresh = cached != null && cached.optLong("current") == Updater.currentCode(this@MainActivity)
                                && System.currentTimeMillis() - cached.optLong("checkedAt") < 12 * 3600_000L
                            if (!req.optBoolean("force") && fresh) success(id, cached!!)
                            else {
                                val r = Updater.check(this@MainActivity)
                                core.settings.edit().putString("updateResult", r.toString()).apply()
                                success(id, r)
                            }
                        }
                        "downloadUpdate" -> success(id, Updater.download(this@MainActivity, req.getString("tag")) { pct -> progress(id, pct.toString()) })
                        "installUpdate" -> {
                            val intent = Updater.installIntent(this@MainActivity, req.getString("tag"))
                            val permission = intent.action == Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES
                            runOnUiThread { try { startActivity(intent) } catch (e: ActivityNotFoundException) { failure(id, IllegalStateException("系统里没有可用的安装程序")); return@runOnUiThread }
                                success(id, JSONObject().put("needPermission", permission)) }
                        }
                        "openUrl" -> {
                            val url = req.getString("url")
                            require(url == Updater.PAGE || url.startsWith(Updater.PAGE + "/")) { "只能打开项目主页" }
                            runOnUiThread { try { startActivity(Intent(Intent.ACTION_VIEW, android.net.Uri.parse(url))); success(id, JSONObject()) } catch (e: Exception) { failure(id, IllegalStateException("没有可以打开链接的应用")) } }
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
                            if (req.getBoolean("enabled")) { WatchService.ensureChannels(this@MainActivity); runOnUiThread { core.settings.edit().putBoolean("askedNotifications", false).apply(); askNotificationPermission() } }
                            success(id, JSONObject().put("alerts", core.alertsEnabled))
                        }
                        "openNotificationSettings" -> runOnUiThread {
                            val intent = Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, packageName)
                            try { startActivity(intent); success(id, JSONObject()) } catch (e: Exception) { failure(id, IllegalStateException("打不开系统通知设置")) }
                        }
                        "cacheGet" -> {
                            val device = cacheDevice(req)
                            val text = device?.let { core.cache.get(it, cacheKey(req)) }
                            val value = text?.let { try { JSONObject(it) } catch (_: Exception) { null } }
                            success(id, JSONObject().put("value", value ?: JSONObject.NULL))
                        }
                        "cachePut" -> {
                            val device = cacheDevice(req)
                            val value = req.optJSONObject("value")
                            success(id, JSONObject().put("saved", device != null && value != null && core.cache.put(device, cacheKey(req), value.toString())))
                        }
                        "cacheInfo" -> core.cache.info().let { (bytes, entries) -> success(id, JSONObject().put("bytes", bytes).put("entries", entries)) }
                        "cacheClear" -> { core.cache.clear(); success(id, JSONObject()) }
                        "pickImages" -> runOnUiThread { pick(id, req.optString("source"), req.optInt("max", 4).coerceIn(1, 4)) }
                        "dropImages" -> {
                            val ids = req.optJSONArray("ids") ?: JSONArray()
                            for (i in 0 until ids.length()) ImagePrep.drop(ids.optString(i))
                            success(id, JSONObject())
                        }
                        "uploadImage" -> {
                            val picture = ImagePrep.get(req.getString("id")) ?: error("这张图片已失效，删掉重新选一下")
                            val day = SimpleDateFormat("yyyy-MM-dd", Locale.US).apply { timeZone = TimeZone.getTimeZone("UTC") }.format(Date())
                            success(id, core.upload(picture, day))
                        }
                        "pickFiles" -> runOnUiThread { pickFiles(id, req.optInt("max", FileAttach.MAX_FILES).coerceIn(1, FileAttach.MAX_FILES)) }
                        "dropFiles" -> {
                            val ids = req.optJSONArray("ids") ?: JSONArray()
                            for (i in 0 until ids.length()) FileAttach.drop(ids.optString(i))
                            success(id, JSONObject())
                        }
                        "uploadFile" -> {
                            val file = FileAttach.get(req.getString("id")) ?: error("这个文件已失效，删掉重新选一下")
                            val day = SimpleDateFormat("yyyy-MM-dd", Locale.US).apply { timeZone = TimeZone.getTimeZone("UTC") }.format(Date())
                            success(id, core.uploadFile(file, contentResolver, day) { sent -> progress(id, sent.toString()) })
                        }
                        "image" -> {
                            // The bridge serves at most ~1.35 MB; the WebView only gets a small JPEG.
                            val query = JSONObject().put("op", "image")
                            for (k in listOf("kind", "name", "address", "record_id", "item", "block", "remote", "variant")) if (req.has(k)) query.put(k, req.get(k))
                            val data = core.request(query)
                            val bytes = android.util.Base64.decode(data.getString("data"), android.util.Base64.DEFAULT)
                            success(id, ImagePrep.shrink(bytes, if (req.optString("variant") == "full") 1600 else 360))
                        }
                        "shellOpen", "shellRead", "shellWrite", "shellResize", "shellClose" -> success(id, core.terminal(op, req))
                        // The phone's SSH key (SshIdentity). Only the public half ever reaches the page.
                        "identity" -> success(id, core.identity.info())
                        "identityCreate" -> success(id, core.identity.create(req.optBoolean("replace")))
                        "identityImport" -> runOnUiThread { pickKey(id) }
                        "identityImportConfirm" -> success(id, KeyImport.confirm(core.identity, req.optString("passphrase").takeIf { it.isNotEmpty() }))
                        "identityImportCancel" -> { KeyImport.cancel(); success(id, JSONObject()) }
                        "installKey" -> success(id, core.installKey(req.getString("id"), req.getString("line")))
                        "useKey" -> {
                            val device = core.vault.get(req.getString("id"))
                            core.vault.save(JSONObject(device.toString()).put("auth", "key").put("remember", false))
                            core.forgetSessionPassword(device.getString("id"))
                            success(id, JSONObject().put("devices", core.vault.list()))
                        }
                        "remote" -> {
                            check(req.optString("op") in setOf("sessions", "agents", "status", "read", "prompt", "key", "answer", "catalog", "history", "account", "panes", "paneRead", "paneRun", "paneText", "paneKey", "stageFile", "fileInfo", "createInfo", "create", "commands", "closeInfo", "closePane", "exitAgent", "hidden", "doctor", "glance", "hello")) { "不支持的操作" }
                            success(id, core.request(req))
                        }
                        else -> error("不支持的操作")
                    }
                } catch (e: Exception) { failure(id, e) }
                // Every request gets an answer, or the page would wait for it forever.
                catch (e: Throwable) { failure(id, IllegalStateException(if (e is OutOfMemoryError) "内存不够，内容太大了" else e.message ?: "操作失败")) }
            }
        }
    }

    /** Cache scope: the connected device, or a saved device that is still connecting. Unknown ids get nothing. */
    private fun cacheDevice(req: JSONObject): String? {
        val asked = req.optString("device")
        val connected = core.connectedDevice?.optString("id")
        if (asked.isEmpty() || asked == connected) return connected
        return try { core.vault.get(asked).getString("id") } catch (_: Exception) { null }
    }
    private fun cacheKey(req: JSONObject) = req.getString("key").also { require(it.length in 1..512) { "缓存键无效" } }

    /** System photo picker (no storage permission) or the camera app writing into [CameraFiles]. */
    private fun pick(id: String, source: String, max: Int) {
        if (pickId != null) { failure(id, IllegalStateException("正在选图片，先把上一个选完")); return }
        val intent = if (source == "camera") {
            val (file, uri) = try { CameraFiles.newShot(this) } catch (e: Exception) { failure(id, e); return }
            shot = file
            Intent(MediaStore.ACTION_IMAGE_CAPTURE).putExtra(MediaStore.EXTRA_OUTPUT, uri)
                .addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_READ_URI_PERMISSION)
                .apply { clipData = ClipData.newRawUri("", uri) }
        } else if (Build.VERSION.SDK_INT >= 33 || (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R && SdkExtensions.getExtensionVersion(Build.VERSION_CODES.R) >= 2)) {
            Intent("android.provider.action.PICK_IMAGES").setType("image/*").apply { if (max > 1) putExtra("android.provider.extra.PICK_IMAGES_MAX", max) }
        } else {
            Intent(Intent.ACTION_GET_CONTENT).setType("image/*").addCategory(Intent.CATEGORY_OPENABLE).putExtra(Intent.EXTRA_ALLOW_MULTIPLE, max > 1)
        }
        try {
            pickId = id; pickMax = max
            startActivityForResult(intent, if (source == "camera") PICK_CAMERA else PICK_GALLERY)
        } catch (e: ActivityNotFoundException) {
            pickId = null; shot?.delete(); shot = null
            failure(id, IllegalStateException(if (source == "camera") "手机上没找到相机应用" else "手机上没找到相册"))
        }
    }

    /** System document picker (Storage Access Framework): any type, several at once, no storage permission. */
    private fun pickFiles(id: String, max: Int) {
        if (pickId != null) { failure(id, IllegalStateException("正在选文件，先把上一个选完")); return }
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*")
            .putExtra(Intent.EXTRA_ALLOW_MULTIPLE, max > 1)
        try {
            pickId = id; pickMax = max
            startActivityForResult(intent, PICK_FILES)
        } catch (e: ActivityNotFoundException) {
            pickId = null
            failure(id, IllegalStateException("手机上没找到文件选择器"))
        }
    }

    /** Document picker for an existing private key; the file is read natively and never reaches the page. */
    private fun pickKey(id: String) {
        if (pickId != null) { failure(id, IllegalStateException("正在选文件，先把上一个选完")); return }
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*")
        try { pickId = id; startActivityForResult(intent, PICK_KEY) }
        catch (e: ActivityNotFoundException) { pickId = null; failure(id, IllegalStateException("手机上没找到文件选择器")) }
    }
    private fun onKeyPicked(resultCode: Int, data: Intent?) {
        val id = pickId ?: return
        pickId = null
        val uri = data?.data
        if (resultCode != RESULT_OK || uri == null) { success(id, JSONObject().put("cancelled", true)); return }
        executor.execute { try { success(id, KeyImport.read(contentResolver, uri, core.identity)) } catch (e: Exception) { failure(id, e) } }
    }

    private fun onFilesPicked(resultCode: Int, data: Intent?) {
        val id = pickId ?: return
        pickId = null
        val uris = if (resultCode != RESULT_OK) emptyList()
            else data?.clipData?.let { clip -> (0 until clip.itemCount).map { clip.getItemAt(it).uri } } ?: listOfNotNull(data?.data)
        val extra = (uris.size - pickMax).coerceAtLeast(0)
        executor.execute {
            val files = JSONArray(); var failed = 0; var reason = ""
            for (uri in uris.take(pickMax)) {
                try { files.put(FileAttach.describe(FileAttach.describe(contentResolver, uri))) }
                catch (e: Exception) { failed++; reason = e.message ?: "" }
            }
            success(id, JSONObject().put("files", files).put("failed", failed).put("reason", reason).put("extra", extra))
        }
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == PICK_FILES) { onFilesPicked(resultCode, data); return }
        if (requestCode == PICK_KEY) { onKeyPicked(resultCode, data); return }
        if (requestCode != PICK_GALLERY && requestCode != PICK_CAMERA) return
        val id = pickId ?: return
        pickId = null
        val file = shot.takeIf { requestCode == PICK_CAMERA }; shot = null
        val uris = when {
            resultCode != RESULT_OK -> emptyList()
            file != null -> if (file.length() > 0) listOf(android.net.Uri.fromFile(file)) else emptyList()
            else -> data?.clipData?.let { clip -> (0 until clip.itemCount).map { clip.getItemAt(it).uri } } ?: listOfNotNull(data?.data)
        }.take(pickMax)
        preparePictures(PickBatch(id, file), uris, ask = true)
    }

    /** Pictures of one pick: what is ready, what failed, and the camera file to remove at the end. */
    private class PickBatch(val id: String, val file: File?) { val images = JSONArray(); var failed = 0; var reason = "" }
    private var mediaRetry: Pair<PickBatch, List<android.net.Uri>>? = null
    private val mediaPermission get() = if (Build.VERSION.SDK_INT >= 33) Manifest.permission.READ_MEDIA_IMAGES else Manifest.permission.READ_EXTERNAL_STORAGE

    /**
     * The photo picker grants access to what was picked, so normally no permission is needed. Some
     * galleries (MIUI's among them) hand back a storage path or a provider that checks the photos
     * permission; only then is the standard photos permission asked for, and those pictures retried.
     */
    private fun preparePictures(batch: PickBatch, uris: List<android.net.Uri>, ask: Boolean) {
        executor.execute {
            val denied = mutableListOf<android.net.Uri>()
            for (uri in uris) {
                try { batch.images.put(ImagePrep.describe(ImagePrep.prepare(contentResolver, uri))) }
                catch (e: SecurityException) { denied += uri }
                catch (e: java.io.FileNotFoundException) { if (e.message.orEmpty().let { "EACCES" in it || "ermission" in it }) denied += uri else { batch.failed++; batch.reason = e.message ?: "" } }
                catch (e: Throwable) { batch.failed++; batch.reason = if (e is OutOfMemoryError) "图片太大了" else e.message ?: "" }
            }
            if (denied.isNotEmpty() && ask && checkSelfPermission(mediaPermission) != PackageManager.PERMISSION_GRANTED) {
                runOnUiThread { mediaRetry = batch to denied; requestPermissions(arrayOf(mediaPermission), ASK_PHOTOS) }
                return@execute
            }
            if (denied.isNotEmpty()) { batch.failed += denied.size; batch.reason = "相册没给读取权限：在系统设置里允许 Herdr Pocket 访问照片，或换用系统的照片选择器" }
            batch.file?.delete()
            success(batch.id, JSONObject().put("images", batch.images).put("failed", batch.failed).put("reason", batch.reason))
        }
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != ASK_PHOTOS) return
        val (batch, uris) = mediaRetry ?: return
        mediaRetry = null
        preparePictures(batch, uris, ask = false)
    }

    @Deprecated("Legacy back dispatch")
    override fun onBackPressed() { if (started) web.evaluateJavascript("window.pocketBack()", null) else super.onBackPressed() }
    override fun onPause() {
        if (started) web.evaluateJavascript("window.setForeground(false)", null)
        pausedAt = android.os.SystemClock.elapsedRealtime(); watched = false
        // Hand over to the watcher while the app is not visible; it only reads state.
        // With notifications blocked the watcher could not tell anyone anything: do not hold a hidden service.
        if (core.connectedDevice != null && core.alertsEnabled && watchSession.isNotEmpty() && !isChangingConfigurations && notificationsAllowed()) {
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
        if (Build.VERSION.SDK_INT >= 33) (backCallback as? OnBackInvokedCallback)?.let { onBackInvokedDispatcher.unregisterOnBackInvokedCallback(it) }
        executor.shutdownNow(); pictures.shutdownNow(); web.removeJavascriptInterface("PocketNative"); web.destroy(); super.onDestroy()
    }
}
