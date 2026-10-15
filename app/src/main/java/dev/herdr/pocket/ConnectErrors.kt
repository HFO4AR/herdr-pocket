package dev.herdr.pocket

import com.jcraft.jsch.ChannelSftp
import com.jcraft.jsch.SftpException
import org.json.JSONObject
import java.net.ConnectException
import java.net.NoRouteToHostException
import java.net.SocketException
import java.net.SocketTimeoutException
import java.net.UnknownHostException

/**
 * An error the UI can explain. [code] tells the page which next step to offer (re-enter the
 * password, edit the device, install Python …); [message] is short, casual Chinese for people.
 */
class Friendly(val code: String, message: String, val info: JSONObject? = null, cause: Throwable? = null) : IllegalStateException(message, cause)

/** Maps raw JSch / socket / remote-command failures to [Friendly] errors. Pure, so it is unit-testable. */
object ConnectErrors {
    /** Failures while opening the SSH session (before any request was sent). */
    fun connect(e: Throwable, endpoint: Endpoint): Friendly {
        if (e is Friendly) return e
        val where = "${endpoint.host}:${endpoint.port}"
        val chain = generateSequence(e) { it.cause }.take(8).toList()
        val text = chain.joinToString(" | ") { "${it.javaClass.simpleName}: ${it.message.orEmpty()}" }
        fun has(vararg needles: String) = needles.any { text.contains(it, ignoreCase = true) }
        return when {
            chain.any { it.message.orEmpty().startsWith("Auth ") || it.message == "Auth fail" || it.message == "Auth cancel" } -> {
                // JSch 2.x: "Auth fail for methods 'publickey'" means the server never offered passwords.
                val methods = Regex("for methods '([^']*)'").find(text)?.groupValues?.get(1)
                if (methods != null && !methods.contains("password") && !methods.contains("keyboard-interactive"))
                    Friendly("auth_method", "这台电脑没开密码登录（只允许密钥）。在电脑的 sshd 配置里打开 PasswordAuthentication 后再试。", cause = e)
                else Friendly("auth", "密码不对，或者 ${endpoint.user} 这个用户名不存在。", cause = e)
            }
            chain.any { it is UnknownHostException } || has("UnknownHostException", "Unable to resolve host", "No address associated") ->
                Friendly("dns", "找不到「${endpoint.host}」。看看地址有没有拼错，或者手机现在有没有网。", cause = e)
            has("Connection refused", "ECONNREFUSED") ->
                // frps closes a remote port while its frpc is offline, so a refused non-22 port is often the tunnel.
                Friendly("refused", "$where 拒绝连接。" + if (endpoint.port == 22) "电脑上的 SSH 服务开着吗？" else "端口对不对？用 frp 的话，看看电脑上的 frpc 在不在线。", cause = e)
            chain.any { it is SocketTimeoutException } || has("timeout: socket is not established", "timed out", "ETIMEDOUT") ->
                Friendly("timeout", "连 $where 超时了。" + reachHint(endpoint.host), cause = e)
            chain.any { it is NoRouteToHostException } || has("Network is unreachable", "No route to host", "ENETUNREACH", "EHOSTUNREACH") ->
                Friendly("unreachable", "手机到不了 ${endpoint.host}。" + reachHint(endpoint.host), cause = e)
            // frps (and similar relays) accept TCP even when the computer side is offline, then hang up.
            has("End of IO Stream Read", "connection is closed by foreign host", "invalid server's version string", "Connection reset", "Broken pipe") ->
                Friendly("tunnel", "连上了 $where，但那头没有 SSH 回应。用 frp 的话，多半是电脑上的 SSH 没开，或者 frpc 转发的本地端口不对；也可能端口填成了别的服务。", cause = e)
            has("Algorithm negotiation fail") ->
                Friendly("algorithm", "SSH 握手失败：电脑的 sshd 和 App 没有共同支持的加密方式。", cause = e)
            chain.any { it is ConnectException || it is SocketException } ->
                Friendly("network", "网络出错了：${chain.last().message ?: "连接中断"}。" + reachHint(endpoint.host), cause = e)
            else -> Friendly("ssh", "SSH 没连上：${e.message ?: e.javaClass.simpleName}", cause = e)
        }
    }

    /** A one-line hint about how this kind of address is usually reached. */
    fun reachHint(host: String): String {
        val octets = host.split('.').mapNotNull { it.toIntOrNull() }.takeIf { it.size == 4 && host.count { c -> c == '.' } == 3 }
        return when {
            host.endsWith(".ts.net") || (octets != null && octets[0] == 100 && octets[1] in 64..127) ->
                "手机和电脑的 Tailscale 都要在线。"
            octets != null && (octets[0] == 10 || (octets[0] == 192 && octets[1] == 168) || (octets[0] == 172 && octets[1] in 16..31)) ->
                "这是局域网地址，手机要连在同一个 Wi-Fi 上。"
            host.endsWith(".local") || host.endsWith(".lan") -> "这是局域网名字，手机要连在同一个 Wi-Fi 上。"
            else -> "检查地址和端口，或者看看电脑是不是睡着了。"
        }
    }

    /** The bridge command exited with [status]; [stderr] is what the shell printed. */
    fun command(status: Int, stderr: String): Exception {
        val err = stderr.trim()
        return when {
            status == 127 || (Regex("python3?: (command )?not found", RegexOption.IGNORE_CASE).containsMatchIn(err) && !err.contains("can't open file")) ->
                Friendly("python_missing", "电脑上没找到 python3。先装 Python 3.9 或更新的版本，再点重试。")
            err.contains("SyntaxError") || err.contains("needs Python 3.9") ->
                Friendly("python_old", "电脑上的 Python 太旧了，要 3.9 或更新的版本。")
            err.contains("can't open file") || (err.contains("No such file or directory") && err.contains(".herdr-pocket")) ->
                Friendly("bridge_missing", "电脑上还没装这个版本的桥接程序。")
            else -> IllegalStateException("服务器命令失败：" + err.take(1500))
        }
    }

    /** Uploading the bridge failed. */
    fun install(e: Throwable): Friendly {
        if (e is Friendly) return e
        val reason = when ((e as? SftpException)?.id) {
            ChannelSftp.SSH_FX_PERMISSION_DENIED -> "~/.herdr-pocket 没有写权限"
            ChannelSftp.SSH_FX_FAILURE -> "写文件失败，电脑磁盘可能满了"
            ChannelSftp.SSH_FX_OP_UNSUPPORTED, null -> e.message ?: e.javaClass.simpleName
            else -> e.message ?: "SFTP 错误 ${e.id}"
        }
        val sftpOff = e.message.orEmpty().contains("subsystem", ignoreCase = true)
        return Friendly("install_failed", if (sftpOff) "桥接程序装不上：电脑的 sshd 没开 SFTP。" else "桥接程序装不上：$reason。", cause = e)
    }
}
