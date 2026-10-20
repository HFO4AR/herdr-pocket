package dev.herdr.pocket

import android.app.Instrumentation
import android.app.Activity
import android.os.Bundle
import org.json.JSONObject

class SecureProfilesTest : Instrumentation() {
    private var fixturePin = ""
    // Optional manual run of the 文件 (SFTP) checks against a throwaway local sshd that only allows key login:
    // -e sftpPort <port> -e sftpUser <user> -e sftpPin <host key base64> -e sftpKey <private key, base64> -e sftpPub <public key, base64>.
    private var sftpArgs: Bundle? = null
    override fun onCreate(arguments: Bundle?) { fixturePin = arguments?.getString("fixturePin") ?: ""; sftpArgs = arguments?.takeIf { it.getString("sftpKey") != null }; super.onCreate(arguments); start() }
    override fun onStart() {
        try {
            testPasswordSurvivesReloadWithoutPlaintextOrCrossHostReuse()
            testUncheckingRememberErasesPassword()
            testTerminalBuffer()
            testImagePrep()
            val mediaStore = testImagePrepMediaStore()
            testConnectErrors()
            testShareIn()
            testIdentity()
            testWatchRules()
            testJumpVault()
            testResumeSet()
            OfficeTests.pure(targetContext)
            SftpTests.pure()
            if (fixturePin.isNotEmpty()) { testSshPty(); testSilentReconnect(); testKeepAlive(); testKeyLogin(); testSeveralLinks(); testJumpChain(); testSftp() }
            val sftpLocal = sftpArgs?.let { testSftpLocal(it); "\nsftp-local: PASS" } ?: ""
            finish(Activity.RESULT_OK, Bundle().apply { putString("stream", "vault-tests: PASS (2 tests)\nterminal-buffer: PASS\nimage-prep: PASS\nimage-prep-mediastore: $mediaStore\nconnect-errors: PASS\nshare-in: PASS\nssh-identity: PASS\nwatch-rules: PASS\njump-vault: PASS\nresume-set: PASS\noffice-parser: PASS\nsftp-paths: PASS\n" + (if (fixturePin.isNotEmpty()) "ssh-pty: PASS\nssh-reconnect: PASS\nssh-keep: PASS\nssh-key-login: PASS\nssh-jump: PASS\nsftp: PASS" else "ssh-pty: SKIPPED") + sftpLocal) })
        } catch (e: Throwable) {
            finish(Activity.RESULT_CANCELED, Bundle().apply { putString("stream", "vault-tests: FAIL " + e.javaClass.simpleName + ": " + e.message) })
        }
    }
    /** 文件 over the CI fixture (password login), after testKeyLogin. */
    private fun testSftp() {
        val endpoint = Endpoint("10.0.2.2", 22222, "pocket-fixture")
        SftpTests.fixture(targetContext, endpoint, fixturePin, "pocket-fixture-password") { it.connect(endpoint, "pocket-fixture-password", fixturePin) }
    }
    private fun testSftpLocal(args: Bundle) {
        val endpoint = Endpoint("10.0.2.2", args.getString("sftpPort")!!.toInt(), args.getString("sftpUser")!!)
        val pin = args.getString("sftpPin")!!
        val decode = { k: String -> java.util.Base64.getDecoder().decode(args.getString(k)!!) }
        SftpTests.fixture(targetContext, endpoint, pin, "") { ssh -> val key = KeyMaterial(decode("sftpKey"), decode("sftpPub")); try { ssh.connect(endpoint, "", pin, identity = key) } finally { key.wipe() } }
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
    /**
     * The real picker and "share from Gallery" hand over a MediaStore content:// URI, and camera JPEGs
     * carry an EXIF rotation. Insert such a picture into MediaStore, then prepare it directly and
     * through the share path: it comes out upright, downscaled and re-encoded without EXIF.
     */
    private fun testImagePrepMediaStore(): String {
        if (android.os.Build.VERSION.SDK_INT < 29) return "SKIPPED (API < 29)"
        val resolver = targetContext.contentResolver
        val tmp = java.io.File(targetContext.cacheDir, "exif.jpg")
        android.graphics.Bitmap.createBitmap(3000, 1800, android.graphics.Bitmap.Config.ARGB_8888).apply { eraseColor(android.graphics.Color.rgb(80, 120, 200)) }
            .let { b -> tmp.outputStream().use { b.compress(android.graphics.Bitmap.CompressFormat.JPEG, 90, it) } }
        android.media.ExifInterface(tmp.absolutePath).apply {
            setAttribute(android.media.ExifInterface.TAG_ORIENTATION, android.media.ExifInterface.ORIENTATION_ROTATE_90.toString()); saveAttributes()
        }
        val values = android.content.ContentValues().apply {
            put(android.provider.MediaStore.MediaColumns.DISPLAY_NAME, "pocket-test-${System.nanoTime()}.jpg")
            put(android.provider.MediaStore.MediaColumns.MIME_TYPE, "image/jpeg")
            put(android.provider.MediaStore.MediaColumns.RELATIVE_PATH, android.os.Environment.DIRECTORY_PICTURES + "/HerdrPocketTest")
            put(android.provider.MediaStore.MediaColumns.IS_PENDING, 1)
        }
        val collection = android.provider.MediaStore.Images.Media.getContentUri(android.provider.MediaStore.VOLUME_EXTERNAL_PRIMARY)
        val uri = resolver.insert(collection, values) ?: fail("MediaStore insert refused")
        try {
            (resolver.openOutputStream(uri) ?: fail("MediaStore output missing")).use { out -> tmp.inputStream().use { it.copyTo(out) } }
            resolver.update(uri, android.content.ContentValues().apply { put(android.provider.MediaStore.MediaColumns.IS_PENDING, 0) }, null, null)
            check(uri.scheme == "content" && uri.authority == "media") { "Not a MediaStore URI: $uri" }
            check(resolver.getType(uri) == "image/jpeg") { "MediaStore type ${resolver.getType(uri)}" }
            val p = ImagePrep.prepare(resolver, uri)
            // 3000×1800 stored sideways with ROTATE_90: upright portrait, long edge 2048.
            check(p.height == 2048 && p.width in 1228..1229) { "MediaStore image-prep size ${p.width}x${p.height} (EXIF rotation not applied?)" }
            check(p.ext == "jpg" && p.bytes.isNotEmpty() && p.bytes.size <= ImagePrep.MAX_BYTES && p.thumb.isNotEmpty()) { "MediaStore image-prep bytes" }
            val exif = android.media.ExifInterface(java.io.ByteArrayInputStream(p.bytes))
            check(exif.getAttributeInt(android.media.ExifInterface.TAG_ORIENTATION, android.media.ExifInterface.ORIENTATION_NORMAL) in
                setOf(android.media.ExifInterface.ORIENTATION_NORMAL, android.media.ExifInterface.ORIENTATION_UNDEFINED)) { "Prepared picture kept an EXIF rotation" }
            ImagePrep.drop(p.id)
            // Same picture shared from a gallery app: ShareIn reads it as one prepared image plus the caption.
            val send = android.content.Intent(android.content.Intent.ACTION_SEND).setType("image/jpeg")
                .putExtra(android.content.Intent.EXTRA_STREAM, uri).putExtra(android.content.Intent.EXTRA_TEXT, "看这张图")
            val shared = ShareIn.read(resolver, send)
            val images = shared.getJSONArray("images")
            check(images.length() == 1 && shared.getInt("failed") == 0 && shared.getString("text") == "看这张图") { "Shared MediaStore picture: $shared".take(300) }
            val first = images.getJSONObject(0)
            check(first.getInt("width") in 1228..1229 && first.getInt("height") == 2048 && first.getString("thumb").startsWith("data:image/jpeg;base64,")) { "Shared picture size" }
            ImagePrep.drop(first.getString("id"))
        } finally { resolver.delete(uri, null, null); tmp.delete() }
        return "PASS"
    }
    /** Raw JSch / socket / shell failures become short Chinese errors with a stable code. */
    /** Background alerts: Codex questions (在问你), sub-agents and pacing — the watcher's pure rules. */
    private fun testWatchRules() {
        val r = WatchRules
        val ask = WatchRules.Ask("call_1", "先修哪个？\n细节", 1)
        check(r.effective("idle", ask, false, null, false, "working") == "ask") { "idle + question = ask" }
        check(r.effective("done", ask, true, null, false, "working") == "done") { "put aside: not waiting" }
        check(r.effective("working", ask, false, null, false, "ask") == "working") { "moved on" }
        check(r.effective("idle", ask, false, 2, true, "working") == "ask") { "question wins over sub-agents" }
        check(r.effective("idle", null, false, 2, true, "working") == "kids") { "sub-agents run" }
        check(r.effective("idle", null, false, null, true, "kids") == "kids") { "unknown keeps the hold" }
        check(r.effective("idle", null, false, null, false, "kids") == "idle") { "not asked: Herdr's state" }
        val none = emptySet<String>()
        fun alert(was: String?, now: String, id: String? = null, seen: Set<String> = none) = r.step(was, now, id, seen).alert
        check(alert("working", "ask", "call_1") == WatchRules.Alert.ASK) { "ask notifies" }
        check(alert("kids", "ask", "call_1") == WatchRules.Alert.ASK) { "ask after sub-agents" }
        check(alert("idle", "ask", "call_1") == WatchRules.Alert.ASK) { "late transcript: re-check finds it" }
        check(alert("working", "ask", "call_1", setOf("call_1")) == WatchRules.Alert.NONE) { "once per question" }
        check(alert(null, "ask", "call_1") == WatchRules.Alert.NONE) { "first sight is silent" }
        check(alert("ask", "ask", "call_1") == WatchRules.Alert.NONE) { "no change" }
        check(r.step("ask", "working", null, none).let { it.withdraw && it.alert == WatchRules.Alert.NONE }) { "answered: withdraw" }
        check(r.step("blocked", "idle", null, none).let { it.withdraw && it.alert == WatchRules.Alert.NONE }) { "approved: withdraw" }
        check(!r.step("working", "idle", null, none).withdraw) { "done withdraws nothing" }
        check(alert("working", "blocked") == WatchRules.Alert.BLOCKED) { "blocked" }
        // A parent whose sub-agents run: 做完了 exactly once, after the last one finished.
        var was: String? = "working"
        val alerts = ArrayList<WatchRules.Alert>()
        for (running in listOf(2, 1, 1, null, 0, 0)) {
            val now = r.effective("idle", null, false, running, was in WatchRules.BUSY, was)
            r.step(was, now, null, none).alert.takeIf { it != WatchRules.Alert.NONE }?.let { alerts.add(it) }
            was = now
        }
        check(alerts == listOf(WatchRules.Alert.DONE)) { "kids: one 做完了, got $alerts" }
        // Questions are looked for only after a stop (plus one re-check), and only for Codex.
        check(r.wantsAsk("idle", "working", "codex", 0) && r.wantsAsk("done", "kids", "codex", 0)) { "after a stop" }
        check(!r.wantsAsk("idle", "working", "claude", 0)) { "Claude asks by blocking" }
        check(!r.wantsAsk("idle", "idle", "codex", 0) && r.wantsAsk("idle", "idle", "codex", 1)) { "re-check only when due" }
        check(!r.wantsAsk("working", "working", "codex", 1)) { "busy: no" }
        check(r.retriesAfter(true, 0, false) == WatchRules.ASK_RETRIES && r.retriesAfter(false, 1, false) == 0 && r.retriesAfter(true, 0, true) == 0) { "retries" }
        check(r.interval(listOf("idle", "blocked", "ask"), false) == WatchRules.IDLE_POLL_MS) { "all waiting: slow" }
        check(r.interval(listOf("idle", "kids"), false) == WatchRules.POLL_MS && r.interval(listOf("idle"), true) == WatchRules.POLL_MS) { "busy or re-check: quick" }
        check(r.askText(ask.text, 1) == "在问你：先修哪个？") { r.askText(ask.text, 1) }
        check(r.askText("选哪个？", 3) == "在问你：选哪个？（共 3 个问题）") { "count" }
        check(r.askText("", 1) == "在问你，等你回答") { "empty" }
        check(r.askText("长".repeat(200), 1).length == "在问你：".length + 80) { "clipped" }
        check(r.counts(1, 2, 3, "做完了") == "1 个等你确认 · 2 个在问你 · 3 个做完了" && r.counts(0, 0, 0, "x") == "") { "counts" }
    }
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
        check(ConnectErrors.connect(jsch("Auth fail for methods 'publickey'"), lan, usingKey = true).code == "key_rejected") { "key_rejected" }
        check(ConnectErrors.connect(jsch("Auth fail for methods 'publickey,password'"), lan, usingKey = true).code == "key_rejected") { "key_rejected 2" }
        check(ConnectErrors.connect(jsch("Auth fail for methods 'password'"), lan, usingKey = true).code == "key_method") { "key_method" }
        check(sshKeyType(java.util.Base64.getDecoder().decode("AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl")) == "ssh-ed25519") { "key type" }
        // Multi-hop: a jump host's failure is named and flagged (the page then never asks for the device password).
        val jump = Endpoint("jump.invalid", 22, "j"); val inner = Endpoint("10.9.0.5", 2222, "y")
        val jumpAuth = ConnectErrors.connect(HopFailed(0, 2, jump, false, false, null, jsch("Auth fail for methods 'publickey,password'")), lan)
        check(jumpAuth.code == "auth" && jumpAuth.info!!.getBoolean("jump") && jumpAuth.info!!.getInt("hop") == 1 && jumpAuth.message!!.startsWith("第 1 跳（跳板机 jump.invalid）")) { "jump auth ${jumpAuth.message}" }
        val targetAuth = ConnectErrors.connect(HopFailed(1, 2, inner, false, false, jump, jsch("Auth fail for methods 'publickey,password'")), lan)
        check(targetAuth.code == "auth" && !targetAuth.info!!.getBoolean("jump") && !targetAuth.message!!.contains("跳板机")) { "target auth" }
        val forward = ConnectErrors.connect(HopFailed(1, 2, inner, false, true, jump, jsch("x", HopProxy.ForwardRefused(jsch("channel is not opened.")))), lan)
        check(forward.code == "jump_forward" && forward.message!!.contains("jump.invalid") && forward.message!!.contains("10.9.0.5:2222")) { "forward" }
        val behind = ConnectErrors.connect(HopFailed(1, 2, inner, false, false, jump, jsch("timeout", java.net.SocketTimeoutException("Read timed out"))), lan)
        check(behind.code == "timeout" && !behind.message!!.contains("Wi-Fi") && behind.message!!.contains("经 jump.invalid")) { "behind timeout ${behind.message}" }
    }

    /**
     * Jump hosts in the vault: hop passwords are encrypted with the device, never listed, carried over
     * only while the hop and the path in front of it are unchanged; at most three; a changed path also
     * drops the device's own saved password. Fixture names only.
     */
    /** 启动时自动重连: ids only, explicit disconnect removes, and what a quiet reconnect would still need. */
    private fun testResumeSet() {
        val prefs = targetContext.getSharedPreferences("resume-test", 0)
        prefs.edit().clear().commit()
        try {
            val set = ResumeSet(prefs)
            set.add("a", shown = true); set.add("b", shown = true); set.add("c", shown = false)
            check(set.ids() == listOf("a", "b", "c") && set.active() == "b") { "add order / active" }
            set.add("a", shown = false)
            check(set.ids() == listOf("b", "c", "a") && set.active() == "b") { "re-add keeps active" }
            set.activate("c"); check(set.active() == "c") { "activate" }
            set.activate("zz"); check(set.active() == "c") { "unknown id is not activated" }
            // Survives a new instance (process death).
            check(ResumeSet(prefs).ids() == listOf("b", "c", "a")) { "persisted" }
            set.remove("c", next = "a"); check(set.ids() == listOf("b", "a") && set.active() == "a") { "remove active hands over" }
            set.remove("b"); check(set.ids() == listOf("a") && set.active() == "a") { "remove other keeps active" }
            set.clear(); check(set.ids().isEmpty() && set.active() == "") { "clear" }
            prefs.edit().putString("ids", "not json").commit(); check(ResumeSet(prefs).ids().isEmpty()) { "damaged list is ignored" }
            // Only ids are stored: no names, hosts or secrets.
            set.add("dev-1", shown = true)
            check(prefs.all.values.joinToString().let { "dev-1" in it && "invalid" !in it }) { "ids only" }
            val pins = mapOf("pin:home.invalid:22" to "k1", "pin:jump.invalid:22" to "k2", "pin:jump.invalid:22>inner.invalid:22" to "k3")
            val direct = JSONObject().put("host", "home.invalid").put("port", 22).put("user", "u")
            check(ResumeSet.need(JSONObject(direct.toString()).put("auth", "password").put("password", "s"), pins::get) == "") { "saved password" }
            check(ResumeSet.need(JSONObject(direct.toString()).put("auth", "password").put("password", ""), pins::get) == "password") { "typed password" }
            check(ResumeSet.need(JSONObject(direct.toString()).put("auth", "key"), pins::get) == "") { "key" }
            check(ResumeSet.need(JSONObject(direct.toString()).put("host", "new.invalid").put("auth", "key"), pins::get) == "trust") { "unpinned" }
            val hop = JSONObject().put("host", "jump.invalid").put("port", 22).put("user", "j").put("auth", "password").put("password", "")
            val behind = JSONObject().put("host", "inner.invalid").put("port", 22).put("user", "u").put("auth", "key").put("jumps", org.json.JSONArray().put(hop))
            check(ResumeSet.need(behind, pins::get) == "password") { "jump host without saved password" }
            hop.put("password", "j-secret"); behind.put("jumps", org.json.JSONArray().put(hop))
            check(ResumeSet.need(behind, pins::get) == "") { "jump host with saved password" }
            check(ResumeSet.need(behind) { if (it.contains(">")) null else pins[it] } == "trust") { "inner pin missing" }
        } finally { prefs.edit().clear().commit() }
    }

    private fun testJumpVault() {
        val vault = SecureProfiles(targetContext)
        fun hop(host: String, user: String, password: String = "", auth: String = "password") =
            JSONObject().put("host", host).put("port", 22).put("user", user).put("auth", auth).put("password", password)
        val id = vault.save(JSONObject().put("host", "inner.invalid").put("user", "fixture").put("password", "device-secret-1").put("remember", true)
            .put("jumps", org.json.JSONArray().put(hop("jump1.invalid", "j1", "jump-secret-1")).put(hop("jump2.invalid", "j2", auth = "key")))).getString("id")
        try {
            val stored = vault.get(id)
            check(stored.getJSONArray("jumps").getJSONObject(0).getString("password") == "jump-secret-1") { "hop password not stored" }
            val listed = vault.list().toString()
            check(!listed.contains("jump-secret-1") && !listed.contains("device-secret-1") && listed.contains("jump2.invalid")) { "hop password listed" }
            val encrypted = targetContext.getSharedPreferences("secure_devices", 0).getString("vault", "")!!
            check(!encrypted.contains("jump-secret-1") && !encrypted.contains("jump1.invalid")) { "hop stored in plaintext" }
            check(JumpHosts.pinIds(stored) == listOf("pin:jump1.invalid:22", "pin:jump1.invalid:22>jump2.invalid:22", "pin:jump1.invalid:22>jump2.invalid:22>inner.invalid:22")) { "pin ids" }
            check(JumpHosts.redact(stored).getJSONArray("jumps").getJSONObject(0).getBoolean("remember")) { "redact remember" }
            // Same hops, no passwords typed: everything kept.
            vault.save(JSONObject().put("id", id).put("host", "inner.invalid").put("user", "fixture").put("remember", true)
                .put("jumps", org.json.JSONArray().put(hop("jump1.invalid", "j1")).put(hop("jump2.invalid", "j2", auth = "key"))))
            check(vault.get(id).getString("password") == "device-secret-1") { "device password lost" }
            check(vault.get(id).getJSONArray("jumps").getJSONObject(0).getString("password") == "jump-secret-1") { "hop password lost" }
            // A password hop without a password (new user) is refused; nothing changes.
            try { vault.save(JSONObject().put("id", id).put("host", "inner.invalid").put("user", "fixture").put("jumps", org.json.JSONArray().put(hop("jump1.invalid", "other")))); fail("hop without password accepted") } catch (_: IllegalArgumentException) { }
            try { vault.save(JSONObject().put("id", id).put("host", "inner.invalid").put("user", "fixture").put("jumps", org.json.JSONArray().apply { repeat(4) { put(hop("j$it.invalid", "j", auth = "key")) } })); fail("4 jumps accepted") } catch (_: IllegalArgumentException) { }
            // A different path in front of the device: the device password is not reused.
            vault.save(JSONObject().put("id", id).put("host", "inner.invalid").put("user", "fixture").put("remember", true)
                .put("jumps", org.json.JSONArray().put(hop("jump2.invalid", "j2", auth = "key"))))
            check(vault.get(id).getString("password") == "") { "device password reused behind another jump host" }
            // Removing every jump host: a plain device again, no jumps key left.
            vault.save(JSONObject().put("id", id).put("host", "inner.invalid").put("user", "fixture"))
            check(!vault.get(id).has("jumps") && !vault.list().toString().contains("jumps")) { "jumps left behind" }
        } finally { vault.delete(id) }
    }

    /**
     * A real two- and three-hop chain on the CI fixture: the phone reaches 10.0.2.2:22222 and, through
     * it, the same sshd again as 127.0.0.1:22222 (that is what the jump host sees). Covers the bridge
     * over the chain, per-hop pins, silent reconnect of the whole chain, and errors naming the hop.
     */
    private fun testJumpChain() {
        PocketCore.init(targetContext)
        val outside = Endpoint("10.0.2.2", 22222, "pocket-fixture"); val inside = Endpoint("127.0.0.1", 22222, "pocket-fixture")
        fun hop(e: Endpoint, password: String = "pocket-fixture-password", pin: String? = fixturePin) = Hop(e, password, false, pin)
        val ssh = SshTransport()
        try {
            ssh.connect(inside, "pocket-fixture-password", fixturePin, jumps = listOf(hop(outside)))
            ssh.install(targetContext.assets.open("pocket_bridge.py").use { it.readBytes() })
            check(ssh.request(JSONObject().put("op", "hello")).getInt("protocol") == 1) { "bridge over 2 hops" }
            ssh.connect(inside, "pocket-fixture-password", fixturePin, jumps = listOf(hop(outside), hop(inside)))
            ssh.useBundled(targetContext.assets.open("pocket_bridge.py").use { it.readBytes() })
            check(ssh.request(JSONObject().put("op", "hello")).getInt("protocol") == 1) { "bridge over 3 hops" }
            check(ssh.ping(4000)) { "ping over 3 hops" }
            fun failure(block: () -> Unit): Throwable { try { block(); error("connected unexpectedly") } catch (e: IllegalStateException) { if (e.message == "connected unexpectedly") throw e; return e } catch (e: Exception) { return e } }
            val wrongJump = failure { SshTransport().connect(inside, "pocket-fixture-password", fixturePin, jumps = listOf(hop(outside, "wrong"))) }
            val wj = ConnectErrors.connect(wrongJump, inside)
            check(wj.code == "auth" && wj.info!!.getBoolean("jump")) { "jump auth: ${wj.code} ${wj.message}" }
            val closed = ConnectErrors.connect(failure { SshTransport().connect(Endpoint("127.0.0.1", 1, "x"), "x", fixturePin, jumps = listOf(hop(outside))) }, inside)
            check(closed.code == "jump_forward") { "forward: ${closed.code} ${closed.message}" }
            val newJump = failure { SshTransport().connect(inside, "pocket-fixture-password", fixturePin, jumps = listOf(hop(outside, pin = null))) }
            check(newJump is UntrustedHost && newJump.hop == 0) { "jump trust: $newJump" }
            val changed = failure { SshTransport().connect(inside, "pocket-fixture-password", "AAAAC3NzaC1lZDI1NTE5AAAAIChangedChangedChangedChangedChangedChange", jumps = listOf(hop(outside))) }
            check(changed is HostKeyChanged && changed.hop == 1) { "target changed: $changed" }
        } finally { ssh.close() }
        // Through PocketCore with a saved device: pins per path, and a dropped chain comes back silently.
        val device = JSONObject().put("name", "fixture-jump").put("host", inside.host).put("port", inside.port).put("user", inside.user)
            .put("password", "pocket-fixture-password").put("remember", true)
            .put("jumps", org.json.JSONArray().put(JSONObject().put("host", outside.host).put("port", outside.port).put("user", outside.user).put("password", "pocket-fixture-password")))
        val id = PocketCore.vault.save(device).getString("id")
        val pinIds = JumpHosts.pinIds(PocketCore.vault.get(id))
        val previous = pinIds.associateWith { PocketCore.pins.getString(it, null) }
        try {
            pinIds.forEach { PocketCore.pins.edit().putString(it, fixturePin).commit() }
            PocketCore.connect(PocketCore.vault.get(id), "pocket-fixture-password") {}
            check(!PocketCore.connectedDevice.toString().contains("pocket-fixture-password")) { "hop password in connectedDevice" }
            PocketCore.transport.install(PocketCore.bridge)
            check(PocketCore.request(JSONObject().put("op", "hello")).getInt("protocol") == 1)
            PocketCore.transport.simulateDrop()
            check(PocketCore.request(JSONObject().put("op", "hello")).getInt("protocol") == 1) { "chain not rebuilt" }
        } finally {
            PocketCore.disconnect()
            PocketCore.vault.delete(id)
            PocketCore.pins.edit().apply { previous.forEach { (k, v) -> if (v == null) remove(k) else putString(k, v) } }.commit()
        }
    }
    /**
     * The phone's SSH key: generated Ed25519, stored only as Keystore AES-GCM ciphertext, reloads,
     * decrypts for a handshake and wipes; import handles passphrases; authorized_keys appends once.
     * Uses its own store so a real key on the device is never touched.
     */
    private fun testIdentity() {
        val store = "test_identity"
        val id = SshIdentity(targetContext, store)
        id.delete()
        try {
            check(!id.info().getBoolean("exists")) { "identity not empty" }
            val info = id.create()
            val line = info.getString("publicKey")
            check(info.getString("type") == "ssh-ed25519" && line.startsWith("ssh-ed25519 AAAA")) { "identity type" }
            check(info.getString("fingerprint").startsWith("SHA256:")) { "identity fingerprint" }
            check(!info.toString().contains("PRIVATE")) { "private key in info" }
            try { id.create(); fail("second create replaced the key") } catch (_: IllegalStateException) { }
            // Stored only as ciphertext.
            val raw = targetContext.getSharedPreferences(store, 0).getString("private", "")!!
            check(raw.isNotEmpty() && !String(java.util.Base64.getDecoder().decode(raw), Charsets.ISO_8859_1).contains("OPENSSH")) { "plaintext private key" }
            // A fresh instance decrypts the same key; the bytes are an OpenSSH key whose public half matches.
            val again = SshIdentity(targetContext, store)
            check(again.publicLine() == line) { "identity reload" }
            val key = again.material()
            check(String(key.prv, Charsets.US_ASCII).startsWith("-----BEGIN OPENSSH PRIVATE KEY-----")) { "key format" }
            SshIdentity.bc()
            val pair = com.jcraft.jsch.KeyPair.load(com.jcraft.jsch.JSch(), key.prv.copyOf(), null)
            check(pair.publicKeyBlob.contentEquals(key.pub)) { "key pair mismatch" }
            pair.dispose()
            key.wipe()
            check(key.prv.all { it == 0.toByte() }) { "key not wiped" }
            // Replacing makes a different key.
            check(id.create(replace = true).getString("publicKey") != line) { "replace kept the key" }
            // Import: public key files are refused; a passphrase-protected key needs the right passphrase.
            try { id.parse(line.toByteArray(), null); fail("public key accepted as private") } catch (_: IllegalArgumentException) { }
            val other = com.jcraft.jsch.KeyPair.genKeyPair(com.jcraft.jsch.JSch(), com.jcraft.jsch.KeyPair.ED25519)
            val file = java.io.ByteArrayOutputStream().also { other.writeOpenSSHv1PrivateKey(it, "pass-627".toByteArray()) }.toByteArray()
            val otherBlob = other.publicKeyBlob; other.dispose()
            check(id.parse(file, null) == null) { "encrypted key opened without passphrase" }
            check(id.parse(file, "wrong") == null) { "wrong passphrase accepted" }
            val imported = id.import(id.parse(file, "pass-627")!!)
            check(imported.getBoolean("imported") && imported.getString("fingerprint") == sshFingerprint(otherBlob)) { "import" }
            check(!targetContext.getSharedPreferences(store, 0).all.values.any { it.toString().contains("pass-627") }) { "passphrase stored" }
        } finally { id.delete() }
        check(!SshIdentity(targetContext, store).exists()) { "identity delete" }
        // authorized_keys: appended once, newline kept, comments/options ignored for matching.
        val l = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl herdr-pocket@test"
        check(AuthorizedKeys.toAppend(null, l) == l + "\n") { "ak new" }
        check(AuthorizedKeys.toAppend("ssh-rsa AAAAB x", l) == "\n" + l + "\n") { "ak newline" }
        check(AuthorizedKeys.toAppend("from=\"10.0.0.1\" " + l.replace("herdr-pocket@test", "other") + "\n", l) == null) { "ak duplicate" }
        check(AuthorizedKeys.toAppend("# " + l + "\n", l) != null) { "ak comment counted" }
        // Device auth: a key device keeps no password, and the list says how it logs in.
        val vault = SecureProfiles(targetContext)
        val dev = vault.save(JSONObject().put("host", "fixture.invalid").put("user", "fixture").put("password", "pw-key").put("remember", true).put("auth", "key")).getString("id")
        try {
            check(vault.get(dev).getString("password") == "" && vault.get(dev).getString("auth") == "key") { "key device kept a password" }
            check(vault.list().toString().contains("\"auth\":\"key\"")) { "auth not listed" }
            try { vault.save(JSONObject().put("id", dev).put("host", "fixture.invalid").put("user", "fixture").put("auth", "telnet")); fail("bad auth accepted") } catch (_: IllegalArgumentException) { }
        } finally { vault.delete(dev) }
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

    /**
     * Over a password session the public key is added to the fixture's ~/.ssh/authorized_keys (once),
     * the key then logs in on its own, a silent reconnect needs no password, and a foreign key is refused.
     */
    private fun testKeyLogin() {
        val endpoint = Endpoint("10.0.2.2", 22222, "pocket-fixture")
        PocketCore.init(targetContext)
        if (!PocketCore.identity.exists()) PocketCore.identity.create()
        val line = PocketCore.identity.publicLine()!!
        val ssh = SshTransport()
        try {
            ssh.connect(endpoint, "pocket-fixture-password", fixturePin)
            ssh.installAuthorizedKey(line)
            check(!ssh.installAuthorizedKey(line)) { "authorized_keys line added twice" }
            val key = PocketCore.identity.material()
            try { ssh.probeKey(endpoint, fixturePin, key) } finally { key.wipe() }
        } finally { ssh.close() }
        // A key the computer does not know is refused with a clear code.
        val stranger = SshIdentity(targetContext, "test_identity")
        stranger.create(replace = true)
        try {
            val key = stranger.material()
            var code = ""
            try { SshTransport().probeKey(endpoint, fixturePin, key) } catch (e: Exception) { code = ConnectErrors.connect(e, endpoint, usingKey = true).code } finally { key.wipe() }
            check(code == "key_rejected") { "Unknown key not refused: $code" }
        } finally { stranger.delete() }
        // Key device: connects without a password and reconnects silently after a drop.
        val pinKey = PocketCore.pinId(endpoint)
        val previousPin = PocketCore.pins.getString(pinKey, null)
        val events = java.util.Collections.synchronizedList(mutableListOf<String>())
        PocketCore.listener = { type, _ -> events.add(type) }
        val id = PocketCore.vault.save(JSONObject().put("name", "fixture-key").put("host", endpoint.host).put("port", endpoint.port)
            .put("user", endpoint.user).put("auth", "key")).getString("id")
        try {
            PocketCore.pins.edit().putString(pinKey, fixturePin).commit()
            PocketCore.connect(PocketCore.vault.get(id), "") {}
            PocketCore.transport.install(PocketCore.bridge)
            check(PocketCore.request(JSONObject().put("op", "hello")).getInt("protocol") == 1)
            PocketCore.transport.simulateDrop()
            check(PocketCore.request(JSONObject().put("op", "hello")).getInt("protocol") == 1) { "No key reconnect" }
            check(events == listOf("reconnecting", "reconnected")) { "Unexpected events $events" }
        } finally {
            PocketCore.disconnect(); PocketCore.listener = null
            PocketCore.vault.delete(id)
            PocketCore.pins.edit().apply { if (previousPin == null) remove(pinKey) else putString(pinKey, previousPin) }.commit()
        }
    }

    /**
     * Coming back from the background reuses the session: no new SSH login while it was kept warm, one
     * channel check (still no login) after the CPU slept or the app was left unattended, and a quiet
     * reconnect only after the background time ran out and the session was closed on purpose.
     */
    private fun testKeepAlive() {
        PocketCore.init(targetContext)
        val events = java.util.Collections.synchronizedList(mutableListOf<String>())
        PocketCore.listener = { type, _ -> events.add(type) }
        val endpoint = Endpoint("10.0.2.2", 22222, "pocket-fixture")
        val pinKey = PocketCore.pinId(endpoint)
        val previousPin = PocketCore.pins.getString(pinKey, null)
        val id = PocketCore.vault.save(JSONObject().put("name", "fixture-keep").put("host", endpoint.host).put("port", endpoint.port)
            .put("user", endpoint.user).put("password", "pocket-fixture-password").put("remember", true)).getString("id")
        val hello = { check(PocketCore.request(JSONObject().put("op", "hello")).getInt("protocol") == 1) }
        val stats = PocketCore.stats
        try {
            PocketCore.pins.edit().putString(pinKey, fixturePin).commit()
            PocketCore.connect(PocketCore.vault.get(id), "pocket-fixture-password") {}
            PocketCore.transport.install(PocketCore.bridge)
            hello()
            val logins = PocketCore.transport.logins.get()
            val generation = PocketCore.transport.generation
            // Kept by the service for an hour, phone awake: reused as is.
            val reused = stats.reused.get()
            PocketCore.enterBackground(kept = true, elapsed = 10_000_000, uptime = 5_000_000)
            PocketCore.enterForeground(elapsed = 13_600_000, uptime = 8_600_000)
            hello()
            check(stats.reused.get() == reused + 1) { "Kept session not reused" }
            // Kept, but the CPU slept 10 minutes (keepalives paused): one channel check, no login.
            val verified = stats.verified.get()
            PocketCore.enterBackground(kept = true, elapsed = 20_000_000, uptime = 9_000_000)
            PocketCore.enterForeground(elapsed = 20_900_000, uptime = 9_300_000)
            hello()
            check(stats.verified.get() == verified + 1) { "Slept session not checked" }
            // Not kept (alerts and keep off), 2 minutes away: checked the same way.
            PocketCore.enterBackground(kept = false, elapsed = 30_000_000, uptime = 10_000_000)
            PocketCore.enterForeground(elapsed = 30_120_000, uptime = 10_120_000)
            hello()
            check(stats.verified.get() == verified + 2) { "Unattended session not checked" }
            check(PocketCore.transport.logins.get() == logins && PocketCore.transport.generation == generation) { "Reconnected although the session was alive" }
            check(events.isEmpty()) { "Unexpected events $events" }
            // Background time ran out: closed on purpose, the next request reconnects without the banner.
            PocketCore.sleep()
            check(!PocketCore.transport.isConnected())
            hello()
            check(PocketCore.transport.logins.get() == logins + 1) { "Expected one login after sleep" }
            check(events.isEmpty()) { "Wake-up reconnect was announced $events" }
        } finally {
            PocketCore.disconnect(); PocketCore.listener = null
            PocketCore.vault.delete(id)
            PocketCore.pins.edit().apply { if (previousPin == null) remove(pinKey) else putString(pinKey, previousPin) }.commit()
        }
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

    /**
     * Two saved devices (both pointing at the fixture) connected at the same time: connecting the second
     * keeps the first, requests are routed per device, a drop on one reconnects only that one, and
     * disconnecting one leaves the other working.
     */
    private fun testSeveralLinks() {
        PocketCore.init(targetContext)
        val events = java.util.Collections.synchronizedList(mutableListOf<String>())
        PocketCore.linkListener = { type, _, device -> events.add("$type@$device") }
        val endpoint = Endpoint("10.0.2.2", 22222, "pocket-fixture")
        val pinKey = PocketCore.pinId(endpoint)
        val previousPin = PocketCore.pins.getString(pinKey, null)
        val save = { name: String -> PocketCore.vault.save(JSONObject().put("name", name).put("host", endpoint.host).put("port", endpoint.port)
            .put("user", endpoint.user).put("password", "pocket-fixture-password").put("remember", true)).getString("id") }
        val a = save("fixture-a"); val b = save("fixture-b")
        val hello = { id: String? -> check(PocketCore.request(id, JSONObject().put("op", "hello")).getInt("protocol") == 1) }
        try {
            PocketCore.pins.edit().putString(pinKey, fixturePin).commit()
            PocketCore.connect(PocketCore.vault.get(a), "pocket-fixture-password") {}
            PocketCore.install(a); hello(a)
            PocketCore.connect(PocketCore.vault.get(b), "pocket-fixture-password") {}
            check(PocketCore.links().map { it.id } == listOf(a, b)) { "Connecting B dropped A" }
            check(PocketCore.connectedDevice?.getString("id") == b) { "The new device is not active" }
            hello(a); hello(b); hello(null)
            val ta = PocketCore.link(a)!!.transport; val tb = PocketCore.link(b)!!.transport
            check(ta !== tb && ta.isConnected() && tb.isConnected())
            // A drop on A reconnects A only, and only A's events say so.
            val genB = tb.generation
            ta.simulateDrop(); hello(a)
            check(tb.generation == genB) { "B reconnected for A's drop" }
            check(events == listOf("reconnecting@$a", "reconnected@$a")) { "Unexpected events $events" }
            // Switching the active device never logs in again.
            val logins = PocketCore.totalLogins()
            PocketCore.activate(a); hello(null); PocketCore.activate(b); hello(null)
            check(PocketCore.totalLogins() == logins) { "Switching logged in again" }
            // Disconnecting B leaves A connected and active.
            PocketCore.disconnect(b)
            check(!tb.isConnected() && ta.isConnected())
            check(PocketCore.connectedDevice?.getString("id") == a)
            hello(a)
            var refused = false
            try { hello(b) } catch (_: IllegalStateException) { refused = true }
            check(refused) { "A disconnected device still answered" }
        } finally {
            PocketCore.disconnect(); PocketCore.linkListener = null
            PocketCore.vault.delete(a); PocketCore.vault.delete(b)
            PocketCore.pins.edit().apply { if (previousPin == null) remove(pinKey) else putString(pinKey, previousPin) }.commit()
        }
    }
}
