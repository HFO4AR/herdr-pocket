package dev.herdr.pocket

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.io.File
import java.security.KeyStore
import java.security.MessageDigest
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * 会话列表、历史目录和最近对话的本机缓存：打开应用时先显示上次内容，再后台刷新。
 * 按设备分目录，文件名是哈希，内容用独立的 Android Keystore 密钥 AES-GCM 加密；
 * 放在 noBackupFilesDir，不进备份。缓存只用于显示，任何读失败都按“没有缓存”处理。
 */
class LocalCache(context: Context) {
    private val root = File(context.noBackupFilesDir, "cache-v1")

    private fun hex(text: String) = MessageDigest.getInstance("SHA-256").digest(text.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
    private fun folder(device: String) = File(root, hex("device\n$device"))
    private fun file(device: String, key: String) = File(folder(device), hex(device + "\n" + key))

    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(ALIAS, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
        }.generateKey()
    }

    @Synchronized fun get(device: String, key: String): String? {
        val target = file(device, key)
        if (!target.isFile) return null
        return try {
            val bytes = target.readBytes()
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, bytes.copyOfRange(0, 12)))
            val text = String(cipher.doFinal(bytes.copyOfRange(12, bytes.size)), Charsets.UTF_8)
            target.setLastModified(System.currentTimeMillis())
            text
        } catch (_: Exception) {
            // 密钥被系统清掉或文件损坏：丢掉这一条，下次重新写。
            target.delete(); null
        }
    }

    /** 超过单条上限或加密失败时不写，返回 false；不会抛给界面。 */
    @Synchronized fun put(device: String, key: String, value: String): Boolean {
        val plain = value.toByteArray(Charsets.UTF_8)
        if (plain.size > MAX_ENTRY) return false
        return try {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.ENCRYPT_MODE, key())
            val dir = folder(device).apply { mkdirs() }
            val target = file(device, key)
            val tmp = File(dir, target.name + ".tmp")
            tmp.writeBytes(cipher.iv + cipher.doFinal(plain))
            if (!tmp.renameTo(target)) { tmp.delete(); return false }
            evict(); true
        } catch (_: Exception) { false }
    }

    private fun entries() = root.listFiles()?.flatMap { it.listFiles()?.toList() ?: emptyList() }?.filter { it.isFile && !it.name.endsWith(".tmp") } ?: emptyList()

    /** 总量超过上限时，从最久没用过的开始删。 */
    private fun evict() {
        val files = entries().sortedBy { it.lastModified() }
        var total = files.sumOf { it.length() }
        for (f in files) { if (total <= MAX_TOTAL) break; total -= f.length(); f.delete() }
    }

    @Synchronized fun info(): Pair<Long, Int> = entries().let { list -> list.sumOf { it.length() } to list.size }
    @Synchronized fun drop(device: String) { folder(device).deleteRecursively() }
    @Synchronized fun clear() { root.deleteRecursively() }

    companion object {
        private const val ALIAS = "pocket.cache.v1"
        const val MAX_ENTRY = 1_500_000
        private const val MAX_TOTAL = 32L * 1024 * 1024
    }
}
