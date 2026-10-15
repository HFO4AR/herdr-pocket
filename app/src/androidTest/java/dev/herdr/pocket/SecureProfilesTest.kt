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
            testImagePrep()
            testConnectErrors()
            testShareIn()
            if (fixturePin.isNotEmpty()) { testSshPty(); testSilentReconnect() }
            finish(Activity.RESULT_OK, Bundle().apply { putString("stream", "vault-tests: PASS (2 tests)\nterminal-buffer: PASS\nimage-prep: PASS\nconnect-errors: PASS\nshare-in: PASS\n" + if (fixturePin.isNotEmpty()) "ssh-pty: PASS\nssh-reconnect: PASS" else "ssh-pty: SKIPPED") })
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
    /** Picked pictures (file:// here, content:// from the picker) decode, shrink and re-encode. */
    private fun testImagePrep() {
        for ((name, format) in listOf("pick.png" to android.graphics.Bitmap.CompressFormat.PNG, "pick.jpg" to android.graphics.Bitmap.CompressFormat.JPEG)) {
            val file = java.io.File(targetContext.cacheDir, name)
            val bitmap = android.graphics.Bitmap.createBitmap(3000, 1800, android.graphics.Bitmap.Config.ARGB_8888).apply { eraseColor(android.graphics.Color.rgb(200, 120, 80)) }
            file.outputStream().use { bitmap.compress(format, 90, it) }
            try {
                val p = ImagePrep.prepare(targetContext.contentResolver, android.net.Uri.fromFile(file))
                check(p.width == 2048 && p.height in 1228..1229) { "image-prep size ${p.width}x${p.height}" }
                check(p.bytes.isNotEmpty() && p.bytes.size <= ImagePrep.MAX_BYTES && p.thumb.isNotEmpty()) { "image-prep bytes" }
                ImagePrep.drop(p.id)
            } finally { file.delete() }
        }
        val missing = java.io.File(targetContext.cacheDir, "missing.png")
        try { ImagePrep.prepare(targetContext.contentResolver, android.net.Uri.fromFile(missing)); fail("missing picture accepted") } catch (_: java.io.FileNotFoundException) { } catch (_: IllegalStateException) { }
    }
    /** Raw JSch / socket / shell failures become short Chinese errors with a stable code. */
    private fun testConnectErrors() {
        val lan = Endpoint("192.168.1.20", 22, "yuki")
        fun code(e: Throwable, at: Endpoint = lan) = ConnectErrors.connect(e, at).code
        fun jsch(message: String, cause: Throwable? = null) = com.jcraft.jsch.JSchException(message, cause)
        check(code(jsch("Auth fail for methods 'publickey,password'")) == "auth") { "auth" }
        check(code(jsch("Auth fail for methods 'publickey'")) == "auth_method") { "auth_method" }
        check(code(jsch("java.net.UnknownHostException: nope.invalid", java.net.UnknownHostException("nope.invalid"))) == "dns") { "dns" }
        check(code(jsch("java.net.ConnectException: Connection refused", java.net.ConnectException("Connection refused"))) == "refused") { "refused" }
        val timeout = ConnectErrors.connect(jsch("timeout: socket is not established"), lan)
        check(timeout.code == "timeout" && timeout.message!!.contains("Wi-Fi")) { "timeout lan hint" }
        check(ConnectErrors.connect(jsch("timeout: socket is not established"), Endpoint("100.101.1.2", 22, "y")).message!!.contains("Tailscale")) { "tailscale hint" }
        check(code(jsch("Session.connect: java.io.IOException: End of IO Stream Read")) == "tunnel") { "tunnel" }
        check(code(jsch("x", java.net.NoRouteToHostException("No route to host"))) == "unreachable") { "unreachable" }
        check((ConnectErrors.command(127, "bash: line 1: python3: command not found") as Friendly).code == "python_missing") { "python" }
        check((ConnectErrors.command(2, "python3: can't open file '/home/y/.herdr-pocket/bridge-ab.py': [Errno 2] No such file or directory") as Friendly).code == "bridge_missing") { "bridge" }
        check((ConnectErrors.command(1, "Herdr Pocket needs Python 3.9 or newer; this is 3.8.10") as Friendly).code == "python_old") { "python_old" }
        check(ConnectErrors.command(1, "Traceback: boom") !is Friendly) { "generic" }
        check(sshKeyType(java.util.Base64.getDecoder().decode("AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl")) == "ssh-ed25519") { "key type" }
    }
    /** Shared text keeps a link's title; only other apps' content URIs are read (never file:// or ours). */
    private fun testShareIn() {
        val send = android.content.Intent(android.content.Intent.ACTION_SEND).setType("text/plain")
            .putExtra(android.content.Intent.EXTRA_SUBJECT, "Issue 42").putExtra(android.content.Intent.EXTRA_TEXT, "https://example.com/42")
        check(ShareIn.isShare(send))
        check(ShareIn.text(send) == "Issue 42\nhttps://example.com/42") { "Subject not kept" }
        check(ShareIn.text(send.putExtra(android.content.Intent.EXTRA_SUBJECT, "https://example.com/42")) == "https://example.com/42") { "Subject repeated" }
        check(ShareIn.allowed(android.net.Uri.parse("content://com.example.files/doc/1")))
        check(!ShareIn.allowed(android.net.Uri.parse("file:///data/data/dev.herdr.pocket/shared_prefs/secure_devices.xml"))) { "file:// accepted" }
        check(!ShareIn.allowed(android.net.Uri.parse("content://dev.herdr.pocket.camera/shot.jpg"))) { "Own provider accepted" }
        val many = android.content.Intent(android.content.Intent.ACTION_SEND_MULTIPLE).setType("*/*")
            .putParcelableArrayListExtra(android.content.Intent.EXTRA_STREAM, arrayListOf(android.net.Uri.parse("content://a/1"), android.net.Uri.parse("file:///sdcard/x"), android.net.Uri.parse("content://a/1")))
        check(ShareIn.uris(many) == listOf(android.net.Uri.parse("content://a/1"))) { "Unexpected share URIs" }
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
        val events = java.util.Collections.synchronizedList(mutableListOf<String>())
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
            // A suspect session (network switch, long unattended pause) is replaced quietly first.
            val before = PocketCore.transport.generation
            PocketCore.markSuspect()
            check(PocketCore.request(JSONObject().put("op", "hello")).getInt("protocol") == 1)
            check(PocketCore.transport.generation == before + 1) { "Suspect session kept" }
            check(events.size == 2) { "Quiet reconnect was announced $events" }
            // Concurrent requests after a drop share one reconnect instead of killing each other's session.
            events.clear()
            PocketCore.transport.simulateDrop()
            val failures = java.util.Collections.synchronizedList(mutableListOf<Throwable>())
            val workers = (1..3).map { Thread { try { PocketCore.request(JSONObject().put("op", "hello")) } catch (e: Throwable) { failures.add(e) } } }
            workers.forEach { it.start() }; workers.forEach { it.join(30_000) }
            check(failures.isEmpty()) { "Concurrent request failed: ${failures.firstOrNull()?.message}" }
            check(events == listOf("reconnecting", "reconnected")) { "Unexpected events $events" }
            // A changed host key must stop automatic reconnects.
            PocketCore.pins.edit().putString(pinKey, "AAAAC3NzaC1lZDI1NTE5AAAAIChangedChangedChangedChangedChangedChange").commit()
            PocketCore.transport.simulateDrop()
            var refused = false
            try { PocketCore.request(JSONObject().put("op", "hello")) } catch (e: Friendly) { refused = e.code == "hostkey_changed" }
            check(refused) { "Reconnected despite a changed host key" }
        } finally {
            PocketCore.disconnect(); PocketCore.listener = null
            PocketCore.vault.delete(id)
            PocketCore.pins.edit().apply { if (previousPin == null) remove(pinKey) else putString(pinKey, previousPin) }.commit()
        }
    }
}
