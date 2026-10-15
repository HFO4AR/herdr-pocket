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

/** SSH is the only transport. Passwords never enter preferences or logs. */
class SshTransport : AutoCloseable {
    private var session: Session? = null
    private var home = ""
    fun connect(endpoint: Endpoint, password: String, pinnedKey: String?) {
        close()
        if (Security.getProvider("BC") == null) Security.addProvider(BouncyCastleProvider())
        var pending: UntrustedHost? = null
        val jsch = JSch()
        jsch.setHostKeyRepository(object : HostKeyRepository {
            override fun check(host: String, key: ByteArray): Int {
                val encoded = Base64.getEncoder().encodeToString(key)
                if (pinnedKey == encoded) return HostKeyRepository.OK
                if (pinnedKey != null) return HostKeyRepository.CHANGED
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
        candidate.serverAliveInterval = 15000
        candidate.timeout = 30000
        try {
            candidate.connect(15000)
            session = candidate
        } catch (e: Exception) {
            candidate.disconnect()
            throw pending ?: e
        }
        val sftp = candidate.openChannel("sftp") as ChannelSftp
        try { sftp.connect(10000); home = sftp.realpath(".") } finally { sftp.disconnect() }
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
    private var bridgePath = ""
    fun useBundled(bytes: ByteArray) { bridgePath = "$home/.herdr-pocket/${bridgeName(bytes)}" }
    private fun bridgeName(bytes: ByteArray) = "bridge-" + MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) } + ".py"
    fun request(value: JSONObject): JSONObject {
        val ssh = session ?: error("尚未连接")
        check(ssh.isConnected) { "SSH 已断开，请返回重新连接。未自动重发任何指令。" }
        val channel = ssh.openChannel("exec") as ChannelExec
        val err = ByteArrayOutputStream()
        val input = (value.put("v", 1).toString() + "\n").byteInputStream()
        channel.setCommand("python3 " + quote(bridgePath))
        channel.setInputStream(input)
        channel.setErrStream(err)
        val output = channel.inputStream
        try {
            channel.connect(10000)
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
                check(System.nanoTime() < deadline) { "等待响应超时；指令结果未知，请先刷新查看，勿重复发送。" }
                Thread.sleep(30)
            }
            check(channel.exitStatus == 0) { "服务器命令失败：" + err.toString("UTF-8").take(1500) }
            val result = JSONObject(buffer.toString("UTF-8"))
            check(result.optBoolean("ok")) { result.optString("error", "请求失败") }
            return result.getJSONObject("data")
        } finally { channel.disconnect() }
    }
    private var shell: ShellTerminal? = null
    fun terminal(op: String, req: JSONObject): JSONObject {
        val ssh = session ?: error("尚未连接")
        check(ssh.isConnected) { "SSH 已断开，请重新连接；未重发输入" }
        if (op == "shellOpen") {
            check(shell == null) { "已有 SSH 终端，请先关闭或返回原终端" }
            val opened = ShellTerminal(ssh.openChannel("shell") as ChannelShell, req.optInt("cols", 80), req.optInt("rows", 24))
            shell = opened
            return JSONObject().put("id", opened.id)
        }
        val current = shell ?: error("SSH 终端不存在")
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
    override fun close() { shell?.close(); shell = null; session?.disconnect(); session = null }
    private fun quote(value: String) = "'" + value.replace("'", "'\"'\"'") + "'"
}
