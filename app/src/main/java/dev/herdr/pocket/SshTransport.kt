package dev.herdr.pocket

import com.jcraft.jsch.*
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.security.MessageDigest
import java.security.Security
import java.util.Base64
import org.bouncycastle.jce.provider.BouncyCastleProvider

data class Endpoint(val host: String, val port: Int, val user: String)
class UntrustedHost(val key: String, val fingerprint: String) : Exception("请核对服务器指纹")
class HostKeyChanged : Exception("服务器主机密钥和之前信任的不一致，已拒绝连接；请先在电脑上核对")
/**
 * The request never reached the host (no exec channel was started), so it is safe to send again.
 * [generation] identifies the SSH session it failed on, so concurrent failures trigger one reconnect.
 */
class NotSent(val generation: Long, val sessionDown: Boolean, cause: Exception) : Exception("SSH 通道没建立起来，请求还没发出去", cause)

/**
 * SSH is the only transport. Passwords never enter preferences or logs.
 *
 * Thread-safety: requests run on several threads at once. Each request pins the session it
 * started on ([acquire]/[release]); a reconnect swaps in a new session and either drops the old
 * one immediately (it is believed dead) or lets in-flight requests on it finish first.
 */
class SshTransport : AutoCloseable {
    @Volatile private var session: Session? = null
    @Volatile var generation = 0L
        private set
    @Volatile private var home = ""
    @Volatile private var bridgePath = ""
    private val inflight = HashMap<Session, Int>() // guarded by this
    private val retiring = HashSet<Session>() // guarded by this

    /**
     * Opens a new session. With [keepOld] the current session stays usable until the new one is
     * authenticated, and requests still running on it are allowed to finish (make-before-break).
     * Without it every existing session is dropped first.
     */
    fun connect(endpoint: Endpoint, password: String, pinnedKey: String?, progress: (String) -> Unit = {}, keepOld: Boolean = false) {
        if (!keepOld) close()
        if (Security.getProvider("BC") == null) Security.addProvider(BouncyCastleProvider())
        var pending: Exception? = null
        val jsch = JSch()
        jsch.setHostKeyRepository(object : HostKeyRepository {
            override fun check(host: String, key: ByteArray): Int {
                val encoded = Base64.getEncoder().encodeToString(key)
                if (pinnedKey == encoded) return HostKeyRepository.OK
                if (pinnedKey != null) { pending = HostKeyChanged(); return HostKeyRepository.CHANGED }
                val hash = Base64.getEncoder().withoutPadding().encodeToString(MessageDigest.getInstance("SHA-256").digest(key))
                pending = UntrustedHost(encoded, "SHA256:$hash")
                return HostKeyRepository.NOT_INCLUDED
            }
            override fun add(hostkey: HostKey, ui: UserInfo?) = Unit
            override fun remove(host: String?, type: String?) = Unit
            override fun remove(host: String?, type: String?, key: ByteArray?) = Unit
            override fun getKnownHostsRepositoryID() = "Herdr Pocket pinned keys"
            override fun getHostKey(): Array<HostKey> = emptyArray()
            override fun getHostKey(host: String?, type: String?): Array<HostKey> = emptyArray()
        })
        val candidate = jsch.getSession(endpoint.user, endpoint.host, endpoint.port)
        candidate.setPassword(password)
        candidate.setConfig("StrictHostKeyChecking", "yes")
        candidate.setConfig("PreferredAuthentications", "password")
        // JSch only sends a keepalive when a socket read times out, and setServerAliveInterval
        // also sets that read timeout. Setting `timeout` afterwards (as before) silently moved the
        // keepalive to 30 s; JSch's default ServerAliveCountMax of 1 then dropped the session after
        // one unanswered keepalive. Over mobile data + frp a 30 s stall is normal, so tolerate
        // 4 missed replies (~75 s); dead sessions are caught sooner when a channel fails to open.
        candidate.serverAliveInterval = KEEPALIVE_MS
        candidate.serverAliveCountMax = KEEPALIVE_MISSES
        val path = try {
            progress("正在建立 SSH 连接并验证身份…")
            candidate.connect(15000)
            progress("SSH 身份验证成功，正在读取远端目录…")
            val sftp = candidate.openChannel("sftp") as ChannelSftp
            try { sftp.connect(10000); sftp.realpath(".") } finally { sftp.disconnect() }
        } catch (e: Exception) {
            candidate.disconnect()
            throw pending ?: e
        }
        val old = synchronized(this) {
            val previous = session
            session = candidate; home = path; generation++
            previous
        }
        // An interactive shell belongs to the session it was opened on; it is never moved.
        shell?.close(); shell = null
        if (old != null) retire(old, graceful = keepOld)
    }
    fun install(bytes: ByteArray) {
        val ssh = session ?: error("尚未连接")
        val sftp = ssh.openChannel("sftp") as ChannelSftp
        try {
            sftp.connect(10000)
            val folder = "$home/.herdr-pocket"
            try { sftp.stat(folder) } catch (e: SftpException) {
                if (e.id != ChannelSftp.SSH_FX_NO_SUCH_FILE) throw e
                sftp.mkdir(folder)
            }
            sftp.chmod(448, folder)
            // Content-addressed deployment: no overwrite of another version's bridge.
            val path = "$folder/${bridgeName(bytes)}"
            val temp = "$path.${java.util.UUID.randomUUID()}.tmp"
            sftp.put(bytes.inputStream(), temp)
            sftp.chmod(384, temp)
            val actual = sftp.get(temp).use { it.readBytes() }
            check(actual.contentEquals(bytes)) { "桥接程序校验失败" }
            try {
                sftp.stat(path)
                check(sftp.get(path).use { it.readBytes() }.contentEquals(bytes)) { "已有桥接程序内容不符，拒绝执行" }
                sftp.rm(temp)
            } catch (e: SftpException) {
                if (e.id != ChannelSftp.SSH_FX_NO_SUCH_FILE) throw e
                sftp.rename(temp, path)
            }
            bridgePath = path
        } finally { sftp.disconnect() }
    }
    /**
     * Uploads a prepared picture to ~/.herdr-pocket/uploads/<day>/<sha256>.<ext> plus a small
     * <sha256>.thumb.jpg (folders 0700, files 0600). Content-addressed, so a retry after an unknown
     * outcome just finds or rewrites the same file; it is not a mutation of any agent. The bridge
     * re-checks the hash before the picture is put into a prompt.
     */
    fun upload(picture: Prepared, day: String): JSONObject {
        val (ssh, gen) = acquire()
        try {
            if (!ssh.isConnected) throw NotSent(gen, true, IllegalStateException("SSH 已断开"))
            val sftp = try { ssh.openChannel("sftp") as ChannelSftp } catch (e: JSchException) { throw NotSent(gen, !ssh.isConnected, e) }
            try {
                try { sftp.connect(10000) } catch (e: JSchException) { throw NotSent(gen, !ssh.isConnected, e) }
                var folder = home
                for (part in listOf(".herdr-pocket", "uploads", day)) {
                    folder = "$folder/$part"
                    try { sftp.lstat(folder) } catch (e: SftpException) {
                        if (e.id != ChannelSftp.SSH_FX_NO_SUCH_FILE) throw e
                        sftp.mkdir(folder)
                    }
                    check(sftp.lstat(folder).isDir) { "上传目录异常：$part 不是普通文件夹" }
                    sftp.chmod(448, folder)
                }
                val name = "${picture.sha256}.${picture.ext}"
                put(sftp, "$folder/$name", picture.bytes)
                put(sftp, "$folder/${picture.sha256}.thumb.jpg", picture.thumb)
                return JSONObject().put("name", "$day/$name").put("sha256", picture.sha256).put("bytes", picture.bytes.size)
            } finally { sftp.disconnect() }
        } finally { release(ssh) }
    }
    private fun put(sftp: ChannelSftp, path: String, bytes: ByteArray) {
        val existing = try { sftp.lstat(path) } catch (e: SftpException) { if (e.id != ChannelSftp.SSH_FX_NO_SUCH_FILE) throw e; null }
        if (existing != null && existing.isReg && existing.size == bytes.size.toLong()) return
        if (existing != null) sftp.rm(path)
        val temp = "$path.${java.util.UUID.randomUUID()}.tmp"
        sftp.put(bytes.inputStream(), temp)
        sftp.chmod(384, temp)
        check(sftp.lstat(temp).size == bytes.size.toLong()) { "图片上传不完整" }
        sftp.rename(temp, path)
    }
    /**
     * Streams a picked file to ~/.herdr-pocket/uploads/<day>/<first 16 hex of sha256>/<name>
     * (folders 0700, file 0600), hashing on the way: it is written to a hidden temporary name in the
     * day folder and moved into its folder once the hash is known. The same content and name land
     * on the same path, so a retry after an unknown outcome is harmless. No agent is touched; the
     * bridge re-hashes the file before it is named in a prompt.
     */
    fun uploadFile(open: () -> java.io.InputStream, name: String, day: String, progress: (Long) -> Unit): JSONObject {
        val (ssh, gen) = acquire()
        try {
            if (!ssh.isConnected) throw NotSent(gen, true, IllegalStateException("SSH 已断开"))
            val sftp = try { ssh.openChannel("sftp") as ChannelSftp } catch (e: JSchException) { throw NotSent(gen, !ssh.isConnected, e) }
            try {
                try { sftp.connect(10000) } catch (e: JSchException) { throw NotSent(gen, !ssh.isConnected, e) }
                val dayFolder = folder(sftp, home, listOf(".herdr-pocket", "uploads", day))
                val temp = "$dayFolder/.${java.util.UUID.randomUUID().toString().replace("-", "")}.part"
                try {
                    val hashing = open().use { raw -> FileAttach.Hashing(raw, progress).also { sftp.put(it, temp) } }
                    sftp.chmod(384, temp)
                    check(sftp.lstat(temp).size == hashing.count) { "文件上传不完整" }
                    val sha = hashing.hex()
                    val target = "${folder(sftp, dayFolder, listOf(sha.take(16)))}/$name"
                    val existing = try { sftp.lstat(target) } catch (e: SftpException) { if (e.id != ChannelSftp.SSH_FX_NO_SUCH_FILE) throw e; null }
                    if (existing != null && existing.isReg && existing.size == hashing.count) sftp.rm(temp)
                    else {
                        // A leftover broken copy of the same content and name; anything else is not ours to replace.
                        if (existing != null) { check(existing.isReg) { "上传目录里有同名的文件夹或链接" }; sftp.rm(target) }
                        sftp.rename(temp, target)
                    }
                    return JSONObject().put("name", "$day/${sha.take(16)}/$name").put("sha256", sha).put("size", hashing.count)
                } catch (e: Exception) {
                    try { sftp.rm(temp) } catch (_: Exception) {}
                    // JSch wraps errors raised while reading the source (too big, unreadable).
                    throw (e.cause as? IllegalStateException)?.takeIf { e is SftpException } ?: e
                }
            } finally { sftp.disconnect() }
        } finally { release(ssh) }
    }
    /** Creates or checks each folder below [base] as a real folder (not a link), 0700. */
    private fun folder(sftp: ChannelSftp, base: String, parts: List<String>): String {
        var path = base
        for (part in parts) {
            path = "$path/$part"
            try { sftp.lstat(path) } catch (e: SftpException) {
                if (e.id != ChannelSftp.SSH_FX_NO_SUCH_FILE) throw e
                sftp.mkdir(path)
            }
            check(sftp.lstat(path).isDir) { "上传目录异常：$part 不是普通文件夹" }
            sftp.chmod(448, path)
        }
        return path
    }
    fun useBundled(bytes: ByteArray) { bridgePath = "$home/.herdr-pocket/${bridgeName(bytes)}" }
    private fun bridgeName(bytes: ByteArray) = "bridge-" + MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) } + ".py"
    fun isConnected() = session?.isConnected == true
    /** True while an interactive shell is open; it would not survive a reconnect. */
    fun hasShell() = shell != null
    /** Instrumented tests only: drop the TCP session as a network loss would. */
    internal fun simulateDrop() { session?.disconnect() }

    private fun acquire(): Pair<Session, Long> = synchronized(this) {
        // Null only while another thread is replacing the session; nothing has been sent.
        val ssh = session ?: throw NotSent(generation, true, IllegalStateException("尚未连接"))
        inflight[ssh] = (inflight[ssh] ?: 0) + 1
        ssh to generation
    }
    private fun release(ssh: Session) {
        val drop = synchronized(this) {
            val left = (inflight[ssh] ?: 1) - 1
            if (left <= 0) inflight.remove(ssh) else inflight[ssh] = left
            left <= 0 && retiring.remove(ssh)
        }
        if (drop) ssh.disconnect()
    }
    private fun retire(ssh: Session, graceful: Boolean) {
        val now = synchronized(this) { if (graceful && (inflight[ssh] ?: 0) > 0) { retiring.add(ssh); false } else true }
        if (now) ssh.disconnect()
    }

    fun request(value: JSONObject): JSONObject {
        val (ssh, gen) = acquire()
        try { return exec(ssh, gen, value) } finally { release(ssh) }
    }

    private fun exec(ssh: Session, gen: Long, value: JSONObject): JSONObject {
        if (!ssh.isConnected) throw NotSent(gen, true, IllegalStateException("SSH 已断开"))
        val err = ByteArrayOutputStream()
        val input = (value.put("v", 1).toString() + "\n").byteInputStream()
        // JSch sends the exec request first and starts streaming stdin only once the server has
        // accepted it, so any failure in openChannel/connect means the request never left.
        val channel = try { ssh.openChannel("exec") as ChannelExec } catch (e: JSchException) { throw NotSent(gen, !ssh.isConnected, e) }
        channel.setCommand("python3 " + quote(bridgePath))
        channel.setInputStream(input)
        channel.setErrStream(err)
        val output = channel.inputStream
        try {
            try { channel.connect(OPEN_TIMEOUT_MS) } catch (e: JSchException) { throw NotSent(gen, !ssh.isConnected, e) }
            val buffer = ByteArrayOutputStream()
            val chunk = ByteArray(8192)
            val deadline = System.nanoTime() + 35_000_000_000L
            while (true) {
                while (output.available() > 0) {
                    val n = output.read(chunk)
                    if (n < 0) break
                    buffer.write(chunk, 0, n)
                    check(buffer.size() <= 2_000_000) { "服务器响应过大" }
                }
                if (channel.isClosed && output.available() == 0) break
                check(System.nanoTime() < deadline) { "等了 35 秒还没有回应；请求已经发出，结果未知。先刷新看看，别直接重发。" }
                Thread.sleep(30)
            }
            // Closed without an exit status: the connection died after the request was sent.
            check(channel.exitStatus != -1 || ssh.isConnected) { "请求发出后连接断了，结果未知。先刷新看看，别直接重发。" }
            check(channel.exitStatus == 0) { "服务器命令失败：" + err.toString("UTF-8").take(1500) }
            val result = JSONObject(buffer.toString("UTF-8"))
            check(result.optBoolean("ok")) { result.optString("error", "请求失败") }
            return result.getJSONObject("data")
        } finally { channel.disconnect() }
    }
    @Volatile private var shell: ShellTerminal? = null
    fun terminal(op: String, req: JSONObject): JSONObject {
        val ssh = session ?: error("尚未连接")
        check(ssh.isConnected) { "SSH 已断开，请重新连接；未重发输入" }
        if (op == "shellOpen") {
            check(shell == null) { "已有 SSH 终端，请先关闭或返回原终端" }
            val opened = ShellTerminal(ssh.openChannel("shell") as ChannelShell, req.optInt("cols", 80), req.optInt("rows", 24))
            shell = opened
            return JSONObject().put("id", opened.id)
        }
        val current = shell ?: error("SSH 终端已结束（连接断开后会重建连接，但不会恢复旧 shell），请重新打开")
        check(req.getString("terminalId") == current.id) { "终端已更换，拒绝旧页面输入" }
        when (op) {
            "shellRead" -> return current.read(req.getLong("cursor"))
            "shellWrite" -> current.write(req.getLong("sequence"), req.getString("text"))
            "shellResize" -> current.resize(req.getInt("cols"), req.getInt("rows"))
            "shellClose" -> { current.close(); shell = null }
            else -> error("不支持的终端操作")
        }
        return JSONObject()
    }
    override fun close() {
        shell?.close(); shell = null
        val all = synchronized(this) {
            val list = retiring.toMutableList().also { list -> session?.let { list.add(it) } }
            retiring.clear(); session = null
            list
        }
        all.forEach { it.disconnect() }
    }
    private fun quote(value: String) = "'" + value.replace("'", "'\"'\"'") + "'"

    private companion object {
        const val KEEPALIVE_MS = 15_000
        const val KEEPALIVE_MISSES = 4
        // One round trip on a healthy link; longer means the session is most likely dead.
        const val OPEN_TIMEOUT_MS = 8_000
    }
}
