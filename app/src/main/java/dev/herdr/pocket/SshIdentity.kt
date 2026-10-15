package dev.herdr.pocket

import android.content.Context
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import com.jcraft.jsch.JSch
import com.jcraft.jsch.KeyPair
import org.bouncycastle.jce.provider.BouncyCastleProvider
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.security.KeyStore
import java.security.Security
import java.util.Arrays
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Private and public key bytes, only ever held in memory for one connect. */
class KeyMaterial(val prv: ByteArray, val pub: ByteArray) {
    fun wipe() { Arrays.fill(prv, 0) }
}

/**
 * The phone's SSH login key: one identity for the whole app, like a person's ~/.ssh/id_ed25519.
 * The same trust boundary (this phone) holds it for every computer, so one key per computer would
 * add bookkeeping without adding protection; a computer is revoked by removing the line from its
 * authorized_keys, and 「重新生成」 revokes all of them at once.
 *
 * The private key is stored only as AES-GCM ciphertext under a non-exportable Android Keystore
 * key ("pocket.identity.v1"); it is decrypted into a byte array for one SSH handshake and wiped.
 * Nothing here returns, logs or exports the private key; only the public half leaves this class.
 */
class SshIdentity(context: Context, store: String = "secure_identity") {
    private val prefs = context.getSharedPreferences(store, Context.MODE_PRIVATE)

    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(ALIAS, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
        }.generateKey()
    }
    private fun seal(plain: ByteArray): String {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key())
        cipher.updateAAD(AAD)
        return Base64.getEncoder().encodeToString(cipher.iv + cipher.doFinal(plain))
    }
    private fun open(sealed: String): ByteArray {
        val bytes = Base64.getDecoder().decode(sealed)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, bytes.copyOfRange(0, 12)))
        cipher.updateAAD(AAD)
        return cipher.doFinal(bytes, 12, bytes.size - 12)
    }

    @Synchronized fun exists() = prefs.contains("private") && prefs.contains("public")

    /** What the page may show: the public key line, its fingerprint and where it came from. Never the private key. */
    @Synchronized fun info(): JSONObject {
        if (!exists()) return JSONObject().put("exists", false)
        val blob = Base64.getDecoder().decode(prefs.getString("public", ""))
        val comment = prefs.getString("comment", "") ?: ""
        return JSONObject().put("exists", true).put("type", sshKeyType(blob)).put("fingerprint", sshFingerprint(blob))
            .put("publicKey", publicLine(blob, comment)).put("comment", comment)
            .put("created", prefs.getLong("created", 0L)).put("imported", prefs.getBoolean("imported", false))
    }

    /** A new Ed25519 key. Replacing an existing one must be asked for explicitly. */
    @Synchronized fun create(replace: Boolean = false): JSONObject {
        check(replace || !exists()) { "已经有密钥了" }
        bc()
        val pair = KeyPair.genKeyPair(JSch(), KeyPair.ED25519)
        try { store(pair, defaultComment(), imported = false) } finally { pair.dispose() }
        return info()
    }

    /**
     * Parses a private key file (OpenSSH, PEM or PKCS#8; Ed25519, ECDSA or RSA ≥ 2048 bits).
     * Returns null when it is encrypted and [passphrase] is missing or wrong. Nothing is stored.
     */
    fun parse(bytes: ByteArray, passphrase: String?): KeyPair? {
        val text = String(bytes, Charsets.UTF_8)
        require(!Regex("^\\s*(ssh-|ecdsa-|sk-)").containsMatchIn(text)) { "这是公钥（.pub），要选不带 .pub 的私钥文件" }
        require(text.contains("PRIVATE KEY") || text.contains("PuTTY-User-Key-File")) { "看起来不是 SSH 私钥文件" }
        bc()
        val pair = try { KeyPair.load(JSch(), bytes.copyOf(), null) } catch (e: Exception) { throw IllegalArgumentException("读不懂这个私钥文件（支持 OpenSSH / PEM 格式）", e) }
        if (pair.isEncrypted && (passphrase.isNullOrEmpty() || !pair.decrypt(passphrase))) { pair.dispose(); return null }
        val problem = when (pair.keyType) {
            KeyPair.ED25519, KeyPair.ECDSA -> null
            KeyPair.RSA -> if (pair.keySize < 2048) "RSA 密钥太短了（至少 2048 位）" else null
            else -> "不支持这种密钥，换 Ed25519、ECDSA 或 RSA"
        }
        if (problem != null) { pair.dispose(); throw IllegalArgumentException(problem) }
        return pair
    }
    /** Stores a parsed key in place of the current one (the caller asked the user first). */
    @Synchronized fun import(pair: KeyPair): JSONObject {
        try { store(pair, pair.publicKeyComment.orEmpty().let(::cleanComment).ifEmpty { "imported" }, imported = true) } finally { pair.dispose() }
        return info()
    }

    private fun store(pair: KeyPair, comment: String, imported: Boolean) {
        val out = ByteArrayOutputStream()
        pair.writeOpenSSHv1PrivateKey(out, null)
        val prv = out.toByteArray()
        try {
            val pub = pair.publicKeyBlob
            // Must load back and match before it replaces anything.
            val check = KeyPair.load(JSch(), prv.copyOf(), null)
            try { check(check.publicKeyBlob.contentEquals(pub)) { "密钥校验失败" } } finally { check.dispose() }
            val ok = prefs.edit().putString("private", seal(prv)).putString("public", Base64.getEncoder().encodeToString(pub))
                .putString("comment", comment).putLong("created", System.currentTimeMillis()).putBoolean("imported", imported).commit()
            check(ok) { "密钥保存失败" }
        } finally { Arrays.fill(prv, 0); out.reset() }
    }

    /** Decrypted key bytes for one handshake; [KeyMaterial.wipe] them afterwards. */
    @Synchronized fun material(): KeyMaterial {
        if (!exists()) throw Friendly("key_missing", "这台手机还没有登录密钥。到设备页「登录密钥」里生成，再把公钥装到电脑上。")
        return KeyMaterial(open(prefs.getString("private", "")!!), Base64.getDecoder().decode(prefs.getString("public", "")))
    }
    @Synchronized fun publicBlob(): ByteArray? = prefs.getString("public", null)?.let { Base64.getDecoder().decode(it) }
    @Synchronized fun publicLine(): String? = publicBlob()?.let { publicLine(it, prefs.getString("comment", "") ?: "") }

    @Synchronized fun delete() { check(prefs.edit().clear().commit()) { "删除失败" } }

    companion object {
        private const val ALIAS = "pocket.identity.v1"
        private val AAD = "herdr-pocket ssh identity v1".toByteArray()
        fun bc() { if (Security.getProvider("BC") == null) Security.addProvider(BouncyCastleProvider()) }
        /** "ssh-ed25519 AAAA… comment" as it goes into authorized_keys. */
        fun publicLine(blob: ByteArray, comment: String) =
            (sshKeyType(blob) + " " + Base64.getEncoder().encodeToString(blob) + if (comment.isEmpty()) "" else " $comment")
        /** Only characters that are safe inside a single-quoted shell word and an authorized_keys line. */
        fun cleanComment(raw: String) = raw.replace(Regex("[^A-Za-z0-9._@-]"), "-").trim('-').take(48)
        fun defaultComment() = "herdr-pocket@" + cleanComment(Build.MODEL ?: "android").ifEmpty { "android" }
    }
}

/**
 * Appends a public key line to authorized_keys text without duplicates. Returns the bytes to append
 * (with a leading newline if the file does not end with one), or null when the key is already there.
 * A line counts as present when it holds the same key type and base64 blob (comments and options differ).
 */
object AuthorizedKeys {
    fun toAppend(existing: String?, line: String): String? {
        val parts = line.trim().split(Regex("\\s+"))
        require(parts.size >= 2) { "公钥格式不对" }
        val (type, blob) = parts
        val present = existing.orEmpty().lineSequence().any { row ->
            val words = row.trim().split(Regex("\\s+"))
            !row.trimStart().startsWith("#") && words.windowed(2).any { it[0] == type && it[1] == blob }
        }
        if (present) return null
        val sep = if (existing.isNullOrEmpty() || existing.endsWith("\n")) "" else "\n"
        return sep + line.trim() + "\n"
    }
}
