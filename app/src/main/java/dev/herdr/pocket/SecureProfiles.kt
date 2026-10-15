package dev.herdr.pocket

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import org.json.JSONArray
import org.json.JSONObject
import java.security.KeyStore
import java.util.Base64
import java.util.UUID
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** 所有设备资料以 Android Keystore AES-GCM 加密；列表不返回保存的密码。 */
class SecureProfiles(context: Context) {
    private val prefs = context.getSharedPreferences("secure_devices", Context.MODE_PRIVATE)
    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey("pocket.devices.v1", null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder("pocket.devices.v1", KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
        }.generateKey()
    }
    @Synchronized private fun all(): JSONArray {
        val encoded = prefs.getString("vault", null) ?: return JSONArray()
        val bytes = Base64.getDecoder().decode(encoded)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, bytes.copyOfRange(0, 12)))
        return JSONArray(String(cipher.doFinal(bytes.copyOfRange(12, bytes.size)), Charsets.UTF_8))
    }
    private fun write(values: JSONArray) {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val encoded = Base64.getEncoder().encodeToString(cipher.iv + cipher.doFinal(values.toString().toByteArray(Charsets.UTF_8)))
        check(prefs.edit().putString("vault", encoded).commit()) { "设备保存失败" }
    }
    @Synchronized fun list(): JSONArray = JSONArray().apply {
        val rows = all()
        for (i in 0 until rows.length()) put(JSONObject(rows.getJSONObject(i).toString()).apply {
            put("remember", optString("password").isNotEmpty()); remove("password")
        })
    }
    @Synchronized fun get(id: String): JSONObject {
        val rows = all()
        for (i in 0 until rows.length()) if (rows.getJSONObject(i).getString("id") == id) return rows.getJSONObject(i)
        error("设备不存在")
    }
    @Synchronized fun save(value: JSONObject): JSONObject {
        val host = value.optString("host").trim(); val user = value.optString("user").trim(); val port = value.optInt("port", 22)
        require(host.isNotBlank() && user.isNotBlank() && port in 1..65535 && host.length <= 253 && user.length <= 128) { "填写主机、用户名和有效端口" }
        val rows = all(); val id = value.optString("id").ifBlank { UUID.randomUUID().toString() }
        var old: JSONObject? = null
        val next = JSONArray()
        for (i in 0 until rows.length()) {
            val item = rows.getJSONObject(i)
            if (item.getString("id") == id) old = item else next.put(item)
        }
        // Changing a destination must not silently forward the previous device's password.
        val same = old?.optString("host") == host && old?.optInt("port") == port && old?.optString("user") == user
        val pass = if (value.optBoolean("remember")) value.optString("password").ifEmpty { if (same) old?.optString("password") ?: "" else "" } else ""
        require(pass.length <= 4096) { "密码过长" }
        next.put(JSONObject().put("id", id).put("name", value.optString("name").trim().take(80).ifBlank { host })
            .put("host", host).put("port", port).put("user", user).put("password", pass))
        write(next)
        return JSONObject().put("id", id).put("devices", list())
    }
    @Synchronized fun delete(id: String) {
        val rows = all(); val next = JSONArray()
        for (i in 0 until rows.length()) if (rows.getJSONObject(i).getString("id") != id) next.put(rows.getJSONObject(i))
        write(next)
    }
}
