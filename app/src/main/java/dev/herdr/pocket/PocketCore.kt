package dev.herdr.pocket

import android.Manifest
import android.content.Context
import android.content.SharedPreferences
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.Network
import com.jcraft.jsch.JSchException
import com.jcraft.jsch.JSchUnknownHostKeyException
import org.json.JSONObject

/**
 * Process-wide connection shared by the activity and the background watcher.
 *
 * Reconnects only happen before a request is written: if the session is already
 * down, or the exec channel fails to open, nothing reached the host and the
 * request may be sent after a silent reconnect. A failure after the request was
 * written stays "outcome unknown" and is never replayed.
 *
 * A channel that fails to open is treated as a dead session (typical after a mobile NAT
 * or frp tunnel silently drops the TCP connection): the session is replaced once, keyed
 * by its generation so concurrent failures do not reconnect twice and kill each other.
 * When the session is only suspect (default network changed, or the app came back after
 * a long unattended pause) it is replaced make-before-break before the next request;
 * requests still running on the old session finish there. That proactive step is skipped
 * while an interactive shell is open, since a reconnect would end it.
 */
object PocketCore {
    lateinit var vault: SecureProfiles
        private set
    lateinit var pins: SharedPreferences
        private set
    lateinit var settings: SharedPreferences
        private set
    lateinit var bridge: ByteArray
        private set
    lateinit var cache: LocalCache
        private set
    lateinit var identity: SshIdentity
        private set
    val transport = SshTransport()
    @Volatile var connectedDevice: JSONObject? = null
        private set
    // Password typed for this run when the device does not remember it. Memory only.
    @Volatile private var sessionPassword: String? = null
    @Volatile var listener: ((String, String) -> Unit)? = null
    private val lock = Any()
    // Session may be unusable although JSch still reports it connected.
    @Volatile private var suspect = false
    // Check the session with one channel round trip before the next request (see [enterForeground]).
    @Volatile private var verify = false
    // The session was closed on purpose (background time ran out): reconnect without the "断了" banner.
    @Volatile private var asleep = false
    @Volatile private var network: Network? = null
    // Background bookkeeping is process-wide: the activity can be destroyed (swiped from recents)
    // while the keep-alive service holds the session, and a new activity resumes it.
    @Volatile private var backgroundAt = 0L
    @Volatile private var backgroundUptime = 0L
    @Volatile private var backgroundKept = false
    /** SSH connections and checks since the app started; counts only, shown in 反馈问题. */
    val stats = ConnectionStats()

    fun init(context: Context) {
        if (::vault.isInitialized) return
        val app = context.applicationContext
        vault = SecureProfiles(app)
        pins = app.getSharedPreferences("connection", Context.MODE_PRIVATE)
        settings = app.getSharedPreferences("settings", Context.MODE_PRIVATE)
        cache = LocalCache(app)
        identity = SshIdentity(app)
        bridge = app.assets.open("pocket_bridge.py").use { it.readBytes() }
        watchNetwork(app)
    }

    /**
     * Wi-Fi <-> mobile switches leave the SSH socket on the old network; it either dies at once
     * (handled by the normal reconnect) or lingers until Android tears that network down. Mark the
     * session suspect so the next request moves to the new default network first.
     * Needs ACCESS_NETWORK_STATE; without it this is skipped and timeouts catch dead sessions.
     */
    private fun watchNetwork(app: Context) {
        if (app.checkSelfPermission(Manifest.permission.ACCESS_NETWORK_STATE) != PackageManager.PERMISSION_GRANTED) return
        try {
            app.getSystemService(ConnectivityManager::class.java).registerDefaultNetworkCallback(object : ConnectivityManager.NetworkCallback() {
                override fun onAvailable(available: Network) {
                    val before = network
                    network = available
                    if (before != null && before != available && connectedDevice != null) suspect = true
                }
            })
        } catch (_: Exception) { }
    }

    /** The session may be stale: replace it make-before-break before the next request. */
    fun markSuspect() { if (connectedDevice != null) suspect = true }

    /** The UI went to the background; [kept] = the keep-alive service now holds the session. */
    fun enterBackground(kept: Boolean, elapsed: Long = android.os.SystemClock.elapsedRealtime(), uptime: Long = android.os.SystemClock.uptimeMillis()) {
        backgroundAt = elapsed; backgroundUptime = uptime; backgroundKept = kept
        if (kept && connectedDevice != null) stats.keptInBackground.incrementAndGet()
    }

    /** The service stopped by itself while the app was away (time up, 停止关注, session lost). */
    fun keepEnded() { backgroundKept = false }

    /**
     * The UI is visible again. Nothing reconnects here: a session that is down is replaced by the next
     * request as usual. A session that is still up is reused as is when it was kept warm (the service
     * held it and the phone did not sleep long enough for keepalives to stop) or the pause was short.
     * Otherwise (app frozen without the service, or the CPU slept through keepalives) the next request
     * first opens one channel as a cheap check and reconnects only when that fails.
     */
    fun enterForeground(elapsed: Long = android.os.SystemClock.elapsedRealtime(), uptime: Long = android.os.SystemClock.uptimeMillis()) {
        val at = backgroundAt
        backgroundAt = 0
        if (at == 0L || connectedDevice == null || !transport.isConnected()) return
        val paused = elapsed - at
        // Time the CPU spent suspended: JSch's keepalive thread did not run during it.
        val slept = paused - (uptime - backgroundUptime)
        val warm = if (backgroundKept) slept < SLEEP_GRACE_MS else paused < UNATTENDED_MS
        if (warm) stats.reused.incrementAndGet() else verify = true
    }

    fun pinId(endpoint: Endpoint) = "pin:${endpoint.host}:${endpoint.port}"
    fun endpointOf(device: JSONObject) = Endpoint(device.getString("host"), device.getInt("port"), device.getString("user"))
    /** The device logs in with the phone's SSH key instead of a password. */
    fun usesKey(device: JSONObject) = device.optString("auth") == "key"

    /**
     * Opens the transport with the device's login method. A key is decrypted for this handshake
     * only and wiped right after; a password comes from the caller (typed or stored).
     */
    private fun open(device: JSONObject, password: String, pin: String?, progress: (String) -> Unit = {}, keepOld: Boolean = false) {
        val endpoint = endpointOf(device)
        if (!usesKey(device)) { transport.connect(endpoint, password, pin, progress, keepOld); return }
        val key = identity.material()
        try { transport.connect(endpoint, "", pin, progress, keepOld, key) } finally { key.wipe() }
    }

    /** First connection from the UI; host-key trust is decided by the caller. */
    fun connect(device: JSONObject, password: String, progress: (String) -> Unit) = synchronized(lock) {
        val endpoint = endpointOf(device)
        connectedDevice = null
        stats.connects.incrementAndGet()
        open(device, password, pins.getString(pinId(endpoint), null), progress)
        transport.useBundled(bridge)
        suspect = false; verify = false; asleep = false
        sessionPassword = if (usesKey(device)) null else password
        connectedDevice = JSONObject(device.toString()).apply { remove("password") }
    }

    /**
     * Over the current (password) session, adds the phone's public key to the connected computer's
     * ~/.ssh/authorized_keys, then tries one key login on a separate session. [line] is what the
     * page showed in the confirmation sheet; it must still be the current key.
     */
    fun installKey(deviceId: String, line: String): JSONObject {
        val device = connectedDevice ?: error("先连上这台电脑")
        check(device.getString("id") == deviceId) { "只能装到当前连着的电脑" }
        check(identity.publicLine() == line) { "密钥刚换过，重新打开再确认一次" }
        ensureConnected()
        val appended = transport.installAuthorizedKey(line)
        val endpoint = endpointOf(device)
        val pin = pins.getString(pinId(endpoint), null) ?: error("还没信任这台电脑的指纹")
        val result = JSONObject().put("appended", appended)
        val key = identity.material()
        stats.keyProbes.incrementAndGet()
        try { transport.probeKey(endpoint, pin, key); result.put("verified", true) }
        catch (e: Exception) {
            val friendly = ConnectErrors.connect(e, endpoint, usingKey = true)
            result.put("verified", false).put("code", friendly.code).put("problem", friendly.message)
        } finally { key.wipe() }
        return result
    }

    /** The connected device switched to key login: forget the password typed for this run. */
    fun forgetSessionPassword(deviceId: String) {
        if (connectedDevice?.optString("id") == deviceId) {
            sessionPassword = null
            connectedDevice = connectedDevice?.let { JSONObject(it.toString()).put("auth", "key") }
        }
    }

    fun disconnect() = synchronized(lock) {
        transport.close(); connectedDevice = null; sessionPassword = null; suspect = false; verify = false; asleep = false
    }

    /**
     * Ends the SSH session (battery) but remembers the device for this run, so coming back to the app
     * reconnects silently with the stored password or key, exactly like after a dropped connection.
     */
    fun sleep() = synchronized(lock) {
        if (connectedDevice == null) return@synchronized
        transport.close(); suspect = false; verify = false; asleep = true
        stats.slept.incrementAndGet()
    }

    val keepAliveEnabled get() = settings.getBoolean("keepAlive", true)
    /** How long the background service keeps the session: 15, 60 or 240 minutes, 0 = until stopped. */
    val keepAliveMinutes get() = settings.getInt("keepAliveMinutes", 60).takeIf { it in KEEP_MINUTES } ?: 60

    val alertsEnabled get() = settings.getBoolean("backgroundAlerts", true)

    /**
     * Silent reconnect with the pinned host key only; a changed key is refused.
     * [graceful]: the old session may still work, so keep it until the new one is up and stay
     * quiet in the UI; failure keeps the old session instead of reporting an error.
     */
    private fun reconnect(graceful: Boolean = false) {
        val device = connectedDevice ?: error("尚未连接")
        val stored = vault.get(device.getString("id"))
        val endpoint = endpointOf(stored)
        val pin = pins.getString(pinId(endpoint), null) ?: error("SSH 已断开，请回到设备页重新连接")
        // Key devices need no password: the key is decrypted from the Keystore-sealed store.
        val key = usesKey(stored)
        val password = if (key) "" else stored.optString("password").ifEmpty { sessionPassword ?: "" }
        check(key || password.isNotEmpty()) { "SSH 已断开，请回到设备页重新连接" }
        suspect = false; verify = false
        if (graceful) {
            stats.quietSwaps.incrementAndGet()
            try { open(stored, password, pin, keepOld = true); transport.useBundled(bridge) } catch (_: Exception) { }
            return
        }
        stats.reconnects.incrementAndGet()
        val quiet = asleep
        asleep = false
        if (!quiet) listener?.invoke("reconnecting", device.optString("name"))
        try {
            try {
                open(stored, password, pin)
            } catch (e: JSchException) {
                // One retry for transient network errors (e.g. mid Wi-Fi/mobile handover); never for auth.
                if (e is JSchUnknownHostKeyException || e.message.orEmpty().startsWith("Auth")) throw e
                Thread.sleep(1500)
                open(stored, password, pin)
            }
            transport.useBundled(bridge)
        } catch (e: Exception) {
            if (e is HostKeyChanged || e is UntrustedHost) {
                // Never trusted silently: the user has to look at the fingerprint on the devices page.
                listener?.invoke("hostkey_changed", "电脑的 SSH 指纹变了，已停止自动重连。到设备页重新连接时核对一下。")
                throw Friendly("hostkey_changed", "电脑的 SSH 指纹变了，已停止自动重连；到设备页重新连接时核对一下。")
            }
            val friendly = ConnectErrors.connect(e, endpoint, usingKey = key)
            listener?.invoke("reconnect_failed", friendly.message ?: "")
            throw Friendly(friendly.code, "SSH 断了，自动重连没成功（请求没有发出）：" + friendly.message)
        }
        if (!quiet) listener?.invoke("reconnected", device.optString("name"))
    }

    /** Banner 「重试」: reconnects now if the session is gone; sends nothing to Herdr. */
    fun retry() { ensureConnected() }

    private fun ensureConnected() = synchronized(lock) {
        if (connectedDevice == null) error("请先连接设备")
        if (!transport.isConnected()) reconnect()
        else if (suspect && !transport.hasShell()) reconnect(graceful = true)
        else if (verify) {
            verify = false
            // One channel open on the existing session; no new login when it answers.
            if (transport.ping(PING_TIMEOUT_MS)) stats.verified.incrementAndGet()
            else {
                stats.verifyFailed.incrementAndGet()
                // A shell would end with the old session; leave it, a dead session still fails over on use.
                if (!transport.hasShell()) reconnect(graceful = true)
            }
        }
    }

    fun request(req: JSONObject): JSONObject {
        ensureConnected()
        return try {
            transport.request(JSONObject(req.toString()))
        } catch (e: NotSent) {
            // Only the first thread to see this session fail replaces it; others reuse the new one.
            synchronized(lock) { if (transport.generation == e.generation) reconnect() }
            transport.request(JSONObject(req.toString()))
        }
    }

    /** Uploading is idempotent (content-addressed), so a broken session is replaced and it is retried once. */
    fun upload(picture: Prepared, day: String): JSONObject {
        ensureConnected()
        val started = transport.generation
        return try {
            transport.upload(picture, day)
        } catch (e: Exception) {
            val gen = (e as? NotSent)?.generation ?: started
            if (e !is NotSent && transport.isConnected()) throw e
            synchronized(lock) { if (transport.generation == gen) reconnect() }
            transport.upload(picture, day)
        }
    }

    /**
     * Uploads a picked file (retried once on a fresh session, like pictures), then lets the bridge
     * re-hash it. A copy that does not match is removed there and uploaded once more.
     */
    fun uploadFile(file: Picked, resolver: android.content.ContentResolver, day: String, progress: (Long) -> Unit): JSONObject {
        val open = {
            try { resolver.openInputStream(file.uri) } catch (_: Exception) { null } ?: error("「${file.name}」读不到了，删掉重新选一下")
        }
        val send = {
            ensureConnected()
            val started = transport.generation
            try { transport.uploadFile(open, file.name, day, progress) } catch (e: Exception) {
                val gen = (e as? NotSent)?.generation ?: started
                if (e !is NotSent && transport.isConnected()) throw e
                synchronized(lock) { if (transport.generation == gen) reconnect() }
                transport.uploadFile(open, file.name, day, progress)
            }
        }
        repeat(2) {
            val sent = send()
            val check = request(JSONObject().put("op", "fileCheck").put("name", sent.getString("name")).put("sha256", sent.getString("sha256")))
            if (check.optBoolean("match")) return sent
        }
        error("「${file.name}」上传后校验不一致")
    }

    fun terminal(op: String, req: JSONObject): JSONObject {
        ensureConnected()
        return transport.terminal(op, req)
    }

    private const val UNATTENDED_MS = 60_000L
    // Two keepalive intervals: a shorter CPU sleep cannot have let a NAT or tunnel forget the session.
    private const val SLEEP_GRACE_MS = 30_000L
    private const val PING_TIMEOUT_MS = 4_000
    val KEEP_MINUTES = setOf(15, 60, 240, 0)
}

/** In-memory counters (reset when the process ends). Never carries names or addresses. */
class ConnectionStats {
    val connects = java.util.concurrent.atomic.AtomicInteger()
    val reconnects = java.util.concurrent.atomic.AtomicInteger()
    val quietSwaps = java.util.concurrent.atomic.AtomicInteger()
    val keyProbes = java.util.concurrent.atomic.AtomicInteger()
    val reused = java.util.concurrent.atomic.AtomicInteger()
    val verified = java.util.concurrent.atomic.AtomicInteger()
    val verifyFailed = java.util.concurrent.atomic.AtomicInteger()
    val keptInBackground = java.util.concurrent.atomic.AtomicInteger()
    val slept = java.util.concurrent.atomic.AtomicInteger()
    val notificationDisconnects = java.util.concurrent.atomic.AtomicInteger()
    fun json(logins: Int): JSONObject = JSONObject()
        .put("logins", logins).put("connects", connects.get()).put("reconnects", reconnects.get())
        .put("quietSwaps", quietSwaps.get()).put("keyProbes", keyProbes.get()).put("reused", reused.get())
        .put("verified", verified.get()).put("verifyFailed", verifyFailed.get())
        .put("kept", keptInBackground.get()).put("slept", slept.get()).put("notificationDisconnects", notificationDisconnects.get())
}
