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
 * One SSH connection to one computer, with its own reconnect state. Several can be open at the same
 * time (see [PocketCore]); nothing is shared between them except the pinned host keys, which are
 * keyed by host and port, and the phone's SSH identity.
 */
class Link(device: JSONObject) {
    val id: String = device.getString("id")
    // Profile without passwords, its own and its jump hosts' (they never leave the vault / [sessionPassword]).
    @Volatile var device: JSONObject = JumpHosts.redact(device)
    val transport = SshTransport()
    // Password typed for this run when the device does not remember it. Memory only.
    @Volatile var sessionPassword: String? = null
    val lock = Any()
    // Session may be unusable although JSch still reports it connected.
    @Volatile var suspect = false
    // Check the session with one channel round trip before the next request (see [PocketCore.enterForeground]).
    @Volatile var verify = false
    // The session was closed on purpose (background time ran out): reconnect without the "断了" banner.
    @Volatile var asleep = false
    val name: String get() = device.optString("name")
}

/**
 * Process-wide connections shared by the activity and the background watcher: one [Link] per
 * connected computer (at most [MAX_LINKS]). Connecting another computer leaves the others connected.
 * Requests name the computer they are for; requests without one go to the [active] computer, the one
 * the UI shows. Each link reconnects on its own, with exactly the same rules:
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
    // Connected computers in connection order; guarded by [linksLock].
    private val links = LinkedHashMap<String, Link>()
    private val linksLock = Any()
    @Volatile private var activeId: String? = null
    // Stands in for "no connection" so callers of [transport] never see null.
    private val idle = SshTransport()
    // Logins of links that were closed, so 反馈问题 keeps counting them.
    private val retiredLogins = java.util.concurrent.atomic.AtomicInteger()
    /** Events for the UI: (type, detail). Kept for callers that do not care which computer. */
    @Volatile var listener: ((String, String) -> Unit)? = null
    /** Events for the UI with the computer they are about: (type, detail, device id). */
    @Volatile var linkListener: ((String, String, String) -> Unit)? = null
    @Volatile private var network: Network? = null
    // Background bookkeeping is process-wide: the activity can be destroyed (swiped from recents)
    // while the keep-alive service holds the sessions, and a new activity resumes them.
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

    /** All connected computers, in the order they were connected. */
    fun links(): List<Link> = synchronized(linksLock) { links.values.toList() }
    fun link(id: String?): Link? = if (id.isNullOrEmpty()) null else synchronized(linksLock) { links[id] }
    private fun activeLink(): Link? = synchronized(linksLock) { activeId?.let { links[it] } }
    val hasLinks get() = synchronized(linksLock) { links.isNotEmpty() }
    /** The computer the UI shows (requests without a device go here). */
    val connectedDevice: JSONObject? get() = activeLink()?.device
    /** The active computer's transport; an unconnected stand-in when there is none. */
    val transport: SshTransport get() = activeLink()?.transport ?: idle
    fun totalLogins() = retiredLogins.get() + links().sumOf { it.transport.logins.get() }

    /** The UI switched to a computer that is already connected. Nothing reconnects. */
    fun activate(id: String) = synchronized(linksLock) {
        check(links.containsKey(id)) { "这台电脑没连着，先连接" }
        activeId = id
    }

    /** The link for a request: the named computer, or the active one when none is named. */
    private fun linkFor(id: String?): Link {
        if (id.isNullOrEmpty()) return activeLink() ?: error("请先连接设备")
        return link(id) ?: error("这台电脑已经断开了，回到设备页重新连接")
    }

    /** An event about every connection (e.g. 断开 on the notification). */
    fun announce(type: String) {
        listener?.invoke(type, "")
        linkListener?.invoke(type, "", "")
    }

    private fun emit(type: String, detail: String, link: Link) {
        listener?.invoke(type, detail)
        linkListener?.invoke(type, detail, link.id)
    }

    /**
     * Wi-Fi <-> mobile switches leave the SSH socket on the old network; it either dies at once
     * (handled by the normal reconnect) or lingers until Android tears that network down. Mark the
     * sessions suspect so the next request moves to the new default network first.
     * Needs ACCESS_NETWORK_STATE; without it this is skipped and timeouts catch dead sessions.
     */
    private fun watchNetwork(app: Context) {
        if (app.checkSelfPermission(Manifest.permission.ACCESS_NETWORK_STATE) != PackageManager.PERMISSION_GRANTED) return
        try {
            app.getSystemService(ConnectivityManager::class.java).registerDefaultNetworkCallback(object : ConnectivityManager.NetworkCallback() {
                override fun onAvailable(available: Network) {
                    val before = network
                    network = available
                    if (before != null && before != available) links().forEach { it.suspect = true }
                }
            })
        } catch (_: Exception) { }
    }

    /** The sessions may be stale: replace them make-before-break before their next request. */
    fun markSuspect() { links().forEach { it.suspect = true } }

    /** The UI went to the background; [kept] = the keep-alive service now holds the sessions. */
    fun enterBackground(kept: Boolean, elapsed: Long = android.os.SystemClock.elapsedRealtime(), uptime: Long = android.os.SystemClock.uptimeMillis()) {
        backgroundAt = elapsed; backgroundUptime = uptime; backgroundKept = kept
        if (kept && hasLinks) stats.keptInBackground.incrementAndGet()
    }

    /** The service stopped by itself while the app was away (time up, 停止关注, session lost). */
    fun keepEnded() { backgroundKept = false }

    /**
     * The UI is visible again. Nothing reconnects here: a session that is down is replaced by the next
     * request as usual. A session that is still up is reused as is when it was kept warm (the service
     * held it and the phone did not sleep long enough for keepalives to stop) or the pause was short.
     * Otherwise (app frozen without the service, or the CPU slept through keepalives) the next request
     * first opens one channel as a cheap check and reconnects only when that fails. Every computer the
     * same way.
     */
    fun enterForeground(elapsed: Long = android.os.SystemClock.elapsedRealtime(), uptime: Long = android.os.SystemClock.uptimeMillis()) {
        val at = backgroundAt
        backgroundAt = 0
        if (at == 0L) return
        val paused = elapsed - at
        // Time the CPU spent suspended: JSch's keepalive thread did not run during it.
        val slept = paused - (uptime - backgroundUptime)
        val warm = if (backgroundKept) slept < SLEEP_GRACE_MS else paused < UNATTENDED_MS
        for (link in links()) {
            if (!link.transport.isConnected()) continue
            if (warm) stats.reused.incrementAndGet() else link.verify = true
        }
    }

    fun pinId(endpoint: Endpoint) = "pin:${endpoint.host}:${endpoint.port}"
    /** The device's own pinned key; behind jump hosts it is keyed by the whole path (see JumpHosts.pinIds). */
    fun devicePin(device: JSONObject): String? = pins.getString(JumpHosts.pinIds(device).last(), null)
    fun endpointOf(device: JSONObject) = Endpoint(device.getString("host"), device.getInt("port"), device.getString("user"))
    /** The device logs in with the phone's SSH key instead of a password. */
    fun usesKey(device: JSONObject) = device.optString("auth") == "key"

    /**
     * Opens [transport] with the device's login method. A key is decrypted for this handshake
     * only and wiped right after; a password comes from the caller (typed or stored).
     */
    private fun open(transport: SshTransport, device: JSONObject, password: String, pin: String?, progress: (String) -> Unit = {}, keepOld: Boolean = false) {
        val endpoint = endpointOf(device)
        // Jump hosts (跳板机) first, each with its own login and pinned key; [device] is the stored copy.
        val jumps = JumpHosts.hops(device) { pins.getString(it, null) }
        if (!JumpHosts.needsKey(device)) { transport.connect(endpoint, password, pin, progress, keepOld, jumps = jumps); return }
        val key = identity.material()
        try { transport.connect(endpoint, if (usesKey(device)) "" else password, pin, progress, keepOld, key, jumps, usesKey(device)) } finally { key.wipe() }
    }

    /**
     * First connection from the UI; host-key trust is decided by the caller. Other connected computers
     * stay connected; connecting one that is already connected replaces only its own session. The new
     * computer becomes the active one.
     */
    fun connect(device: JSONObject, password: String, progress: (String) -> Unit) {
        val id = device.getString("id")
        synchronized(linksLock) {
            if (!links.containsKey(id) && links.size >= MAX_LINKS)
                throw Friendly("too_many", "最多同时连 $MAX_LINKS 台电脑，先断开一台再连这台")
        }
        stats.connects.incrementAndGet()
        val link = Link(device)
        try {
            open(link.transport, device, password, devicePin(device), progress)
        } catch (e: Exception) { link.transport.close(); throw e }
        link.transport.useBundled(bridge)
        link.sessionPassword = if (usesKey(device)) null else password
        var full = false
        val old = synchronized(linksLock) {
            // Another connect may have filled the last slot meanwhile.
            if (!links.containsKey(id) && links.size >= MAX_LINKS) { full = true; null }
            else { val previous = links.remove(id); links[id] = link; activeId = id; previous }
        }
        if (full) { link.transport.close(); throw Friendly("too_many", "最多同时连 $MAX_LINKS 台电脑，先断开一台再连这台") }
        old?.let { synchronized(it.lock) { retire(it) } }
    }

    private fun retire(link: Link) {
        retiredLogins.addAndGet(link.transport.logins.get())
        link.transport.close(); link.sessionPassword = null
    }

    /**
     * Over the device's current (password) session, adds the phone's public key to that computer's
     * ~/.ssh/authorized_keys, then tries one key login on a separate session. [line] is what the
     * page showed in the confirmation sheet; it must still be the current key.
     */
    fun installKey(deviceId: String, line: String): JSONObject {
        val link = link(deviceId) ?: error("先连上这台电脑")
        check(identity.publicLine() == line) { "密钥刚换过，重新打开再确认一次" }
        ensureConnected(link)
        val appended = link.transport.installAuthorizedKey(line)
        val endpoint = endpointOf(link.device)
        val stored = vault.get(deviceId)
        val pin = devicePin(stored) ?: error("还没信任这台电脑的指纹")
        val result = JSONObject().put("appended", appended)
        val key = identity.material()
        stats.keyProbes.incrementAndGet()
        try { link.transport.probeKey(endpoint, pin, key, JumpHosts.hops(stored) { pins.getString(it, null) }); result.put("verified", true) }
        catch (e: Exception) {
            val friendly = ConnectErrors.connect(e, endpoint, usingKey = true)
            result.put("verified", false).put("code", friendly.code).put("problem", friendly.message)
        } finally { key.wipe() }
        return result
    }

    /** The device switched to key login: forget the password typed for this run. */
    fun forgetSessionPassword(deviceId: String) {
        val link = link(deviceId) ?: return
        link.sessionPassword = null
        link.device = JSONObject(link.device.toString()).put("auth", "key")
    }

    /** Disconnects every computer. */
    fun disconnect() {
        val all = synchronized(linksLock) { links.values.toList().also { links.clear(); activeId = null } }
        all.forEach { synchronized(it.lock) { retire(it) } }
    }

    /**
     * Disconnects one computer; the others stay connected. If it was the active one, the most
     * recently connected remaining computer becomes active.
     */
    fun disconnect(deviceId: String) {
        val gone = synchronized(linksLock) {
            val removed = links.remove(deviceId)
            if (activeId == deviceId) activeId = links.keys.lastOrNull()
            removed
        } ?: return
        synchronized(gone.lock) { retire(gone) }
    }

    /**
     * Ends the SSH sessions (battery) but remembers the computers for this run, so coming back to the
     * app reconnects silently with the stored password or key, exactly like after a dropped connection.
     */
    fun sleep() {
        for (link in links()) synchronized(link.lock) {
            if (link(link.id) !== link) return@synchronized
            link.transport.close(); link.suspect = false; link.verify = false; link.asleep = true
            stats.slept.incrementAndGet()
        }
    }

    val keepAliveEnabled get() = settings.getBoolean("keepAlive", true)
    /** How long the background service keeps the sessions: 15, 60 or 240 minutes, 0 = until stopped. */
    val keepAliveMinutes get() = settings.getInt("keepAliveMinutes", 60).takeIf { it in KEEP_MINUTES } ?: 60

    val alertsEnabled get() = settings.getBoolean("backgroundAlerts", true)

    /**
     * Silent reconnect of one computer with its pinned host key only; a changed key is refused.
     * [graceful]: the old session may still work, so keep it until the new one is up and stay
     * quiet in the UI; failure keeps the old session instead of reporting an error.
     * Called with [Link.lock] held.
     */
    private fun reconnect(link: Link, graceful: Boolean = false) {
        if (link(link.id) !== link) error("这台电脑已经断开了，回到设备页重新连接")
        val stored = vault.get(link.id)
        val endpoint = endpointOf(stored)
        val pin = devicePin(stored) ?: error("SSH 已断开，请回到设备页重新连接")
        // Key devices need no password: the key is decrypted from the Keystore-sealed store.
        val key = usesKey(stored)
        val password = if (key) "" else stored.optString("password").ifEmpty { link.sessionPassword ?: "" }
        check(key || password.isNotEmpty()) { "SSH 已断开，请回到设备页重新连接" }
        link.suspect = false; link.verify = false
        if (graceful) {
            stats.quietSwaps.incrementAndGet()
            try { open(link.transport, stored, password, pin, keepOld = true); link.transport.useBundled(bridge) } catch (_: Exception) { }
            return
        }
        stats.reconnects.incrementAndGet()
        val quiet = link.asleep
        link.asleep = false
        if (!quiet) emit("reconnecting", link.name, link)
        try {
            try {
                open(link.transport, stored, password, pin)
            } catch (e: Exception) {
                // One retry for transient network errors (e.g. mid Wi-Fi/mobile handover); never for auth.
                // Behind jump hosts the JSch error is wrapped in HopFailed (which hop failed).
                val cause = (e as? HopFailed)?.cause ?: e
                if (cause !is JSchException || cause is JSchUnknownHostKeyException || cause.message.orEmpty().startsWith("Auth")) throw e
                Thread.sleep(1500)
                open(link.transport, stored, password, pin)
            }
            link.transport.useBundled(bridge)
        } catch (e: Exception) {
            if (e is HostKeyChanged || e is UntrustedHost) {
                // Never trusted silently: the user has to look at the fingerprint on the devices page.
                val jump = e is HostKeyChanged && e.hop < JumpHosts.pinIds(stored).lastIndex
                emit("hostkey_changed", (if (jump) "跳板机" else "电脑") + "的 SSH 指纹变了，已停止自动重连。到设备页重新连接时核对一下。", link)
                throw Friendly("hostkey_changed", "电脑的 SSH 指纹变了，已停止自动重连；到设备页重新连接时核对一下。")
            }
            val friendly = ConnectErrors.connect(e, endpoint, usingKey = key)
            emit("reconnect_failed", friendly.message ?: "", link)
            throw Friendly(friendly.code, "SSH 断了，自动重连没成功（请求没有发出）：" + friendly.message)
        }
        if (!quiet) emit("reconnected", link.name, link)
    }

    /** Banner 「重试」: reconnects now if the session is gone; sends nothing to Herdr. */
    fun retry(deviceId: String? = null) { ensureConnected(linkFor(deviceId)) }

    private fun ensureConnected(link: Link) = synchronized(link.lock) {
        if (link(link.id) !== link) error("这台电脑已经断开了，回到设备页重新连接")
        val transport = link.transport
        if (!transport.isConnected()) reconnect(link)
        else if (link.suspect && !transport.hasShell()) reconnect(link, graceful = true)
        else if (link.verify) {
            link.verify = false
            // One channel open on the existing session; no new login when it answers.
            if (transport.ping(PING_TIMEOUT_MS)) stats.verified.incrementAndGet()
            else {
                stats.verifyFailed.incrementAndGet()
                // A shell would end with the old session; leave it, a dead session still fails over on use.
                if (!transport.hasShell()) reconnect(link, graceful = true)
            }
        }
    }

    /** A bridge request to the active computer. */
    fun request(req: JSONObject): JSONObject = request(null, req)

    /** A bridge request to [deviceId] (the active computer when null or empty). */
    fun request(deviceId: String?, req: JSONObject): JSONObject {
        val link = linkFor(deviceId)
        ensureConnected(link)
        val transport = link.transport
        return try {
            transport.request(JSONObject(req.toString()))
        } catch (e: NotSent) {
            // Only the first thread to see this session fail replaces it; others reuse the new one.
            synchronized(link.lock) { if (transport.generation == e.generation) reconnect(link) }
            transport.request(JSONObject(req.toString()))
        }
    }

    /** Uploading is idempotent (content-addressed), so a broken session is replaced and it is retried once. */
    fun upload(deviceId: String?, picture: Prepared, day: String): JSONObject {
        val link = linkFor(deviceId)
        ensureConnected(link)
        val transport = link.transport
        val started = transport.generation
        return try {
            transport.upload(picture, day)
        } catch (e: Exception) {
            val gen = (e as? NotSent)?.generation ?: started
            if (e !is NotSent && transport.isConnected()) throw e
            synchronized(link.lock) { if (transport.generation == gen) reconnect(link) }
            transport.upload(picture, day)
        }
    }

    /**
     * Uploads a picked file (retried once on a fresh session, like pictures), then lets the bridge
     * re-hash it. A copy that does not match is removed there and uploaded once more.
     */
    fun uploadFile(deviceId: String?, file: Picked, resolver: android.content.ContentResolver, day: String, progress: (Long) -> Unit): JSONObject {
        val link = linkFor(deviceId)
        val open = {
            try { resolver.openInputStream(file.uri) } catch (_: Exception) { null } ?: error("「${file.name}」读不到了，删掉重新选一下")
        }
        val send = {
            ensureConnected(link)
            val transport = link.transport
            val started = transport.generation
            try { transport.uploadFile(open, file.name, day, progress) } catch (e: Exception) {
                val gen = (e as? NotSent)?.generation ?: started
                if (e !is NotSent && transport.isConnected()) throw e
                synchronized(link.lock) { if (transport.generation == gen) reconnect(link) }
                transport.uploadFile(open, file.name, day, progress)
            }
        }
        repeat(2) {
            val sent = send()
            val check = request(link.id, JSONObject().put("op", "fileCheck").put("name", sent.getString("name")).put("sha256", sent.getString("sha256")))
            if (check.optBoolean("match")) return sent
        }
        error("「${file.name}」上传后校验不一致")
    }

    fun terminal(deviceId: String?, op: String, req: JSONObject): JSONObject {
        val link = linkFor(deviceId)
        ensureConnected(link)
        return link.transport.terminal(op, req)
    }

    /** The bundled bridge on [deviceId]'s computer (install / update). */
    fun install(deviceId: String?) { val link = linkFor(deviceId); ensureConnected(link); link.transport.install(bridge) }
    fun hasOtherBridge(deviceId: String?): Boolean = linkFor(deviceId).transport.hasOtherBridge(bridge)

    private const val UNATTENDED_MS = 60_000L
    // Two keepalive intervals: a shorter CPU sleep cannot have let a NAT or tunnel forget the session.
    private const val SLEEP_GRACE_MS = 30_000L
    private const val PING_TIMEOUT_MS = 4_000
    val KEEP_MINUTES = setOf(15, 60, 240, 0)
    /** Computers connected at the same time. Each holds an SSH session and keepalives. */
    const val MAX_LINKS = 4
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
