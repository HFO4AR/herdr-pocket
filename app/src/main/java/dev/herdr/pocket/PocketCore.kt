package dev.herdr.pocket

import android.content.Context
import android.content.SharedPreferences
import org.json.JSONObject

/**
 * Process-wide connection shared by the activity and the background watcher.
 *
 * Reconnects only happen before a request is written: if the session is already
 * down, or the exec channel fails to open, nothing reached the host and the
 * request may be sent after a silent reconnect. A failure after the request was
 * written stays "outcome unknown" and is never replayed.
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
    val transport = SshTransport()
    @Volatile var connectedDevice: JSONObject? = null
        private set
    // Password typed for this run when the device does not remember it. Memory only.
    @Volatile private var sessionPassword: String? = null
    @Volatile var listener: ((String, String) -> Unit)? = null
    private val lock = Any()

    fun init(context: Context) {
        if (::vault.isInitialized) return
        val app = context.applicationContext
        vault = SecureProfiles(app)
        pins = app.getSharedPreferences("connection", Context.MODE_PRIVATE)
        settings = app.getSharedPreferences("settings", Context.MODE_PRIVATE)
        bridge = app.assets.open("pocket_bridge.py").use { it.readBytes() }
    }

    fun pinId(endpoint: Endpoint) = "pin:${endpoint.host}:${endpoint.port}"
    fun endpointOf(device: JSONObject) = Endpoint(device.getString("host"), device.getInt("port"), device.getString("user"))

    /** First connection from the UI; host-key trust is decided by the caller. */
    fun connect(device: JSONObject, password: String, progress: (String) -> Unit) = synchronized(lock) {
        val endpoint = endpointOf(device)
        connectedDevice = null
        transport.connect(endpoint, password, pins.getString(pinId(endpoint), null), progress)
        transport.useBundled(bridge)
        sessionPassword = password
        connectedDevice = JSONObject(device.toString()).apply { remove("password") }
    }

    fun disconnect() = synchronized(lock) {
        transport.close(); connectedDevice = null; sessionPassword = null
    }

    val alertsEnabled get() = settings.getBoolean("backgroundAlerts", true)

    /** Silent reconnect with the pinned host key only; a changed key is refused. */
    private fun reconnect() {
        val device = connectedDevice ?: error("尚未连接")
        val stored = vault.get(device.getString("id"))
        val endpoint = endpointOf(stored)
        val pin = pins.getString(pinId(endpoint), null) ?: error("SSH 已断开，请回到设备页重新连接")
        val password = stored.optString("password").ifEmpty { sessionPassword ?: "" }
        check(password.isNotEmpty()) { "SSH 已断开，请回到设备页重新连接" }
        listener?.invoke("reconnecting", device.optString("name"))
        try {
            transport.connect(endpoint, password, pin)
            transport.useBundled(bridge)
        } catch (e: HostKeyChanged) {
            listener?.invoke("reconnect_failed", e.message ?: "")
            throw IllegalStateException("服务器主机密钥变了，已停止自动重连；请回到设备页核对后再连接")
        } catch (e: UntrustedHost) {
            throw IllegalStateException("服务器主机密钥变了，已停止自动重连；请回到设备页核对后再连接")
        } catch (e: Exception) {
            listener?.invoke("reconnect_failed", e.message ?: "")
            throw IllegalStateException("SSH 已断开，自动重连失败：" + (e.message ?: "未知原因"))
        }
        listener?.invoke("reconnected", device.optString("name"))
    }

    private fun ensureConnected() = synchronized(lock) {
        if (connectedDevice == null) error("请先连接设备")
        if (!transport.isConnected()) reconnect()
    }

    fun request(req: JSONObject): JSONObject {
        ensureConnected()
        return try {
            transport.request(JSONObject(req.toString()))
        } catch (e: NotSent) {
            synchronized(lock) { if (!transport.isConnected() || e.sessionDown) reconnect() }
            transport.request(JSONObject(req.toString()))
        }
    }

    fun terminal(op: String, req: JSONObject): JSONObject {
        ensureConnected()
        return transport.terminal(op, req)
    }
}
