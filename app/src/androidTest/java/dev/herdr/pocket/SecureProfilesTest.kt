package dev.herdr.pocket

import android.app.Instrumentation
import android.app.Activity
import android.os.Bundle
import org.json.JSONObject

class SecureProfilesTest : Instrumentation() {
    override fun onCreate(arguments: Bundle?) { super.onCreate(arguments); start() }
    override fun onStart() {
        try {
            testPasswordSurvivesReloadWithoutPlaintextOrCrossHostReuse()
            testUncheckingRememberErasesPassword()
            finish(Activity.RESULT_OK, Bundle().apply { putString("stream", "vault-tests: PASS (2 tests)") })
        } catch (e: Throwable) {
            finish(Activity.RESULT_CANCELED, Bundle().apply { putString("stream", "vault-tests: FAIL " + e.javaClass.simpleName + ": " + e.message) })
        }
    }
    private fun assertEquals(expected: String, actual: String) { check(expected == actual) { "Value mismatch" } }
    private fun assertFalse(value: Boolean) { check(!value) { "Unexpected plaintext value" } }
    private fun fail(message: String): Nothing = throw AssertionError(message)
    fun testPasswordSurvivesReloadWithoutPlaintextOrCrossHostReuse() {
        val context = targetContext
        val vault = SecureProfiles(context)
        val id = vault.save(JSONObject().put("host", "fixture.invalid").put("port", 22).put("user", "fixture")
            .put("password", "fixture-secret-627").put("remember", true)).getString("id")
        try {
            assertEquals("fixture-secret-627", SecureProfiles(context).get(id).getString("password"))
            assertFalse(vault.list().toString().contains("fixture-secret-627"))
            val encrypted = context.getSharedPreferences("secure_devices", 0).getString("vault", "")!!
            assertFalse(encrypted.contains("fixture-secret-627"))
            assertFalse(encrypted.contains("fixture.invalid"))
            vault.save(JSONObject().put("id", id).put("host", "different.invalid").put("user", "fixture").put("remember", true))
            assertEquals("", vault.get(id).getString("password"))
        } finally { vault.delete(id) }
        try { vault.get(id); fail("Deleted device still exists") } catch (_: IllegalStateException) { }
    }
    fun testUncheckingRememberErasesPassword() {
        val vault = SecureProfiles(targetContext)
        val value = JSONObject().put("host", "fixture.invalid").put("user", "fixture").put("password", "secret").put("remember", true)
        val id = vault.save(value).getString("id")
        try {
            value.put("id", id).put("remember", false)
            vault.save(value)
            assertEquals("", SecureProfiles(targetContext).get(id).getString("password"))
        } finally { vault.delete(id) }
    }
}
