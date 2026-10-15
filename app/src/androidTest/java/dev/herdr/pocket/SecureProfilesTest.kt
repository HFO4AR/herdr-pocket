package dev.herdr.pocket

import android.app.Instrumentation
import android.app.Activity
import android.os.Bundle
import org.json.JSONObject

class SecureProfilesTest : Instrumentation() {
    private var fixturePin = ""
    override fun onCreate(arguments: Bundle?) { fixturePin = arguments?.getString("fixturePin") ?: ""; super.onCreate(arguments); start() }
    override fun onStart() {
        try {
            testPasswordSurvivesReloadWithoutPlaintextOrCrossHostReuse()
            testUncheckingRememberErasesPassword()
            testTerminalBuffer()
            if (fixturePin.isNotEmpty()) { testSshPty(); testSilentReconnect() }
            finish(Activity.RESULT_OK, Bundle().apply { putString("stream", "vault-tests: PASS (2 tests)\nterminal-buffer: PASS\n" + if (fixturePin.isNotEmpty()) "ssh-pty: PASS\nssh-reconnect: PASS" else "ssh-pty: SKIPPED") })
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
    private fun testTerminalBuffer() {
        val buffer = TerminalBuffer(8)
        buffer.append("abcdef".toByteArray(), 6)
        val first = buffer.read(0)
        check(first.getLong("next") == 6L && !first.getBoolean("lost"))
        check(first.toString() == buffer.read(0).toString())
        buffer.append("ghijkl".toByteArray(), 6)
        val lost = buffer.read(0)
        check(lost.getBoolean("lost"))
        check(String(java.util.Base64.getDecoder().decode(lost.getString("data"))) == "efghijkl")
        check(buffer.read(12).getString("data") == "")
    }
    private fun testSshPty() {
        val ssh = SshTransport()
        try {
            ssh.connect(Endpoint("10.0.2.2", 22222, "pocket-fixture"), "pocket-fixture-password", fixturePin)
            ssh.install(targetContext.assets.open("pocket_bridge.py").use { it.readBytes() })
            val catalog = ssh.request(JSONObject().put("op", "catalog"))
            val record = catalog.getJSONArray("records").getJSONObject(0)
            val history = ssh.request(JSONObject().put("op", "history").put("record_id", record.getString("id")))
            check(history.getJSONArray("messages").length() == 2) { "SSH history fixture missing messages" }
            val id = ssh.terminal("shellOpen", JSONObject().put("cols", 80).put("rows", 24)).getString("id")
            var cursor = 0L
            fun args() = JSONObject().put("terminalId", id)
            fun awaitText(expected: String): String {
                val bytes = java.io.ByteArrayOutputStream()
                val deadline = System.nanoTime() + 10_000_000_000L
                while (System.nanoTime() < deadline) {
                    val r = ssh.terminal("shellRead", args().put("cursor", cursor))
                    cursor = r.getLong("next")
                    bytes.write(java.util.Base64.getDecoder().decode(r.getString("data")))
                    val text = bytes.toString("UTF-8")
                    if (text.contains(expected)) return text
                    Thread.sleep(50)
                }
                error("SSH fixture output timed out")
            }
            ssh.terminal("shellWrite", args().put("sequence", 1).put("text", "stty -echo; printf 'READY'; printf '%s\\n' '-PTY'\r"))
            awaitText("READY-PTY")
            ssh.terminal("shellWrite", args().put("sequence", 2).put("text", "cd /tmp; printf '位置:'; pwd\r"))
            awaitText("位置:/tmp")
            ssh.terminal("shellResize", args().put("cols", 91).put("rows", 31))
            ssh.terminal("shellWrite", args().put("sequence", 3).put("text", "stty size\r"))
            awaitText("31 91")
            var rejected = false
            try { ssh.terminal("shellWrite", args().put("sequence", 3).put("text", "echo duplicated\r")) } catch (_: IllegalArgumentException) { rejected = true }
            check(rejected) { "Duplicate input accepted" }
            rejected = false
            try { ssh.terminal("shellWrite", JSONObject().put("terminalId", "stale").put("sequence", 4).put("text", "echo wrong\r")) } catch (_: IllegalStateException) { rejected = true }
            check(rejected) { "Wrong terminal accepted" }
            ssh.terminal("shellWrite", args().put("sequence", 4).put("text", "sleep 30\r"))
            Thread.sleep(200)
            ssh.terminal("shellWrite", args().put("sequence", 5).put("text", "\u0003"))
            Thread.sleep(200)
            ssh.terminal("shellWrite", args().put("sequence", 6).put("text", "printf 'INTERRUPTED'; printf '%s\\n' '-OK'\r"))
            awaitText("INTERRUPTED-OK")
            ssh.terminal("shellClose", args())
        } finally { ssh.close() }
    }

    private fun testSilentReconnect() {
        PocketCore.init(targetContext)
        val events = mutableListOf<String>()
        PocketCore.listener = { type, _ -> events.add(type) }
        val endpoint = Endpoint("10.0.2.2", 22222, "pocket-fixture")
        val pinKey = PocketCore.pinId(endpoint)
        val previousPin = PocketCore.pins.getString(pinKey, null)
        val id = PocketCore.vault.save(JSONObject().put("name", "fixture").put("host", endpoint.host).put("port", endpoint.port)
            .put("user", endpoint.user).put("password", "pocket-fixture-password").put("remember", true)).getString("id")
        try {
            PocketCore.pins.edit().putString(pinKey, fixturePin).commit()
            PocketCore.connect(PocketCore.vault.get(id), "pocket-fixture-password") {}
            PocketCore.transport.install(PocketCore.bridge)
            check(PocketCore.request(JSONObject().put("op", "hello")).getInt("protocol") == 1)
            // A dropped session is restored before anything is written.
            PocketCore.transport.simulateDrop()
            check(!PocketCore.transport.isConnected())
            check(PocketCore.request(JSONObject().put("op", "hello")).getInt("protocol") == 1) { "No reconnect" }
            check(events == listOf("reconnecting", "reconnected")) { "Unexpected events $events" }
            // A changed host key must stop automatic reconnects.
            PocketCore.pins.edit().putString(pinKey, "AAAAC3NzaC1lZDI1NTE5AAAAIChangedChangedChangedChangedChangedChange").commit()
            PocketCore.transport.simulateDrop()
            var refused = false
            try { PocketCore.request(JSONObject().put("op", "hello")) } catch (e: IllegalStateException) { refused = e.message?.contains("主机密钥") == true }
            check(refused) { "Reconnected despite a changed host key" }
        } finally {
            PocketCore.disconnect(); PocketCore.listener = null
            PocketCore.vault.delete(id)
            PocketCore.pins.edit().apply { if (previousPin == null) remove(pinKey) else putString(pinKey, previousPin) }.commit()
        }
    }
}
