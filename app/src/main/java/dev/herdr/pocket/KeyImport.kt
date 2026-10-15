package dev.herdr.pocket

import android.content.ContentResolver
import android.net.Uri
import org.json.JSONObject
import java.util.Arrays

/**
 * Importing an existing private key file picked with the system file picker. The file is read by
 * the native side only (never handed to the page), held in memory until the user confirms
 * (with a passphrase if it is encrypted), then stored through [SshIdentity] and wiped.
 */
object KeyImport {
    private const val MAX_BYTES = 16 * 1024
    private var pending: ByteArray? = null // guarded by this

    /** Reads the picked file and says whether it needs a passphrase. Nothing is stored yet. */
    @Synchronized fun read(resolver: ContentResolver, uri: Uri, identity: SshIdentity): JSONObject {
        cancel()
        val bytes = resolver.openInputStream(uri)?.use { input ->
            val buf = java.io.ByteArrayOutputStream()
            val chunk = ByteArray(4096)
            while (true) {
                val n = input.read(chunk); if (n < 0) break
                buf.write(chunk, 0, n)
                require(buf.size() <= MAX_BYTES) { "这个文件太大了，不像 SSH 私钥" }
            }
            buf.toByteArray()
        } ?: error("读不到这个文件")
        val pair = try { identity.parse(bytes, null) } catch (e: Exception) { Arrays.fill(bytes, 0); throw e }
        pending = bytes
        if (pair == null) return JSONObject().put("needPassphrase", true)
        return try { describe(pair) } finally { pair.dispose() }
    }

    /** Stores the pending key in place of the current one. A wrong passphrase keeps it pending. */
    @Synchronized fun confirm(identity: SshIdentity, passphrase: String?): JSONObject {
        val bytes = pending ?: error("没有待导入的密钥，重新选一下文件")
        val pair = identity.parse(bytes, passphrase) ?: throw Friendly("passphrase", if (passphrase.isNullOrEmpty()) "这个私钥有密码保护，输入它的密码" else "私钥密码不对")
        cancel()
        return identity.import(pair)
    }

    @Synchronized fun cancel() { pending?.let { Arrays.fill(it, 0) }; pending = null }

    private fun describe(pair: com.jcraft.jsch.KeyPair): JSONObject {
        val blob = pair.publicKeyBlob
        return JSONObject().put("needPassphrase", false).put("type", sshKeyType(blob)).put("fingerprint", sshFingerprint(blob))
    }
}
