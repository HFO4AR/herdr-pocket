package dev.herdr.pocket

import android.content.Context
import android.net.Uri
import com.jcraft.jsch.ChannelSftp
import org.json.JSONObject
import java.io.File
import java.util.UUID

/**
 * 文件 screen (RemoteFiles / Transfers). [pure] needs nothing; [fixture] runs against an isolated SSH
 * test server (the CI fixture, or a throwaway local sshd for a manual run) and only ever touches a
 * fresh folder it creates in that account's home and removes again.
 */
object SftpTests {
    private fun check(ok: Boolean, what: () -> String) { if (!ok) throw AssertionError(what()) }
    private fun code(block: () -> Unit): String = try { block(); "none" } catch (e: Exception) { (RemoteFiles.friendly(e) as? Friendly)?.code ?: e.javaClass.simpleName }

    fun pure() {
        check(SftpPath.q("a*b?c\\d [x]") == "a\\*b\\?c\\\\d [x]") { "q" }
        check(SftpPath.resolve("~", "/home/u") == "/home/u") { "resolve ~" }
        check(SftpPath.resolve("~/src//app/./x/..", "/home/u") == "/home/u/src/app") { "resolve normalize" }
        check(SftpPath.resolve("/../..", "/home/u") == "/") { "resolve above root" }
        check(code { SftpPath.resolve("relative", "/h") } == "sftp_bad") { "relative path accepted" }
        check(code { SftpPath.resolve("/a\u0000b", "/h") } == "sftp_bad") { "NUL accepted" }
        check(SftpPath.parent("/a/b") == "/a" && SftpPath.parent("/a") == "/" && SftpPath.base("/a/b c") == "b c") { "parent/base" }
        for (bad in listOf("", " ", ".", "..", "a/b", "x\ny", " lead", "trail ", "x".repeat(256))) check(code { SftpPath.checkName(bad) } == "sftp_bad") { "name accepted: $bad" }
        check(SftpPath.checkName("a*b?c\\d [x] ✓.txt") == "a*b?c\\d [x] ✓.txt") { "name with glob characters refused" }
        check(SftpPath.cleanName("../../etc/passwd") == ".._.._etc_passwd") { "cleanName separators: ${SftpPath.cleanName("../../etc/passwd")}" }
        check(SftpPath.cleanName(".env") == ".env" && SftpPath.cleanName("..") == "文件" && SftpPath.cleanName("a‮b​.txt") == "ab.txt") { "cleanName" }
        check(SftpPath.cleanName("长".repeat(200) + ".pdf").let { it.endsWith(".pdf") && it.toByteArray().size <= 255 }) { "cleanName length" }
        check(SftpPath.numbered("report.pdf", 2) == "report (2).pdf" && SftpPath.numbered(".bashrc", 3) == ".bashrc (3)" && SftpPath.numbered("Makefile", 2) == "Makefile (2)") { "numbered" }
    }

    /** [connect] logs [SshTransport] in; [password] empty = the device logs in with the app's key (installed here). */
    fun fixture(context: Context, endpoint: Endpoint, pin: String, password: String, connect: (SshTransport) -> Unit) {
        PocketCore.init(context)
        val ssh = SshTransport()
        try {
            connect(ssh)
            if (password.isEmpty()) {
                if (!PocketCore.identity.exists()) PocketCore.identity.create()
                ssh.installAuthorizedKey(PocketCore.identity.publicLine()!!)
            }
            ssh.sftp { sftp, home -> channel(sftp, home) }
        } finally { ssh.close() }
        transfers(context, endpoint, pin, password)
    }

    private fun write(sftp: ChannelSftp, dir: String, name: String, text: String, mode: String = "new"): String {
        val temp = SftpPath.join(dir, ".t-" + UUID.randomUUID().toString().take(8))
        sftp.put(text.byteInputStream(), SftpPath.q(temp))
        return Transfers.place(sftp, temp, dir, name, mode)
    }
    private fun read(sftp: ChannelSftp, path: String) = sftp.get(SftpPath.q(path)).use { String(it.readBytes()) }
    private fun names(sftp: ChannelSftp, home: String, dir: String): Set<String> {
        val e = RemoteFiles.list(sftp, home, dir).getJSONArray("entries")
        return (0 until e.length()).map { e.getJSONObject(it).getString("name") }.toSet()
    }

    private fun channel(sftp: ChannelSftp, home: String) {
        val base = RemoteFiles.mkdir(sftp, home, "~", "pocket-sftp-" + UUID.randomUUID().toString().take(8)).getString("path")
        try {
            check(code { RemoteFiles.mkdir(sftp, home, "~", SftpPath.base(base)) } == "sftp_exists") { "mkdir over existing" }
            // Glob characters are names, never patterns: the decoy matches "a*b?c\d [x] ✓.txt" as a glob.
            val weird = "a*b?c\\d [x] ✓.txt"; val decoy = "aZbYc\\d [x] ✓.txt"
            write(sftp, base, decoy, "decoy"); write(sftp, base, weird, "one")
            check(names(sftp, home, base) == setOf(decoy, weird)) { "listing: ${names(sftp, home, base)}" }
            // No silent overwrite: "new" fails and leaves the temp for the caller; "keep" numbers it.
            val temp = SftpPath.join(base, ".t-two"); sftp.put("two".byteInputStream(), SftpPath.q(temp))
            check(code { Transfers.place(sftp, temp, base, weird, "new") } == "sftp_conflict") { "new over existing" }
            check(read(sftp, SftpPath.join(base, weird)) == "one") { "existing file changed" }
            check(Transfers.place(sftp, temp, base, weird, "keep") == SftpPath.join(base, "a*b?c\\d [x] ✓ (2).txt")) { "keep name" }
            check(RemoteFiles.lstatOrNull(sftp, temp) == null) { "temp left after keep" }
            // Replace keeps the permission bits of the replaced file.
            sftp.chmod("750".toInt(8), SftpPath.q(SftpPath.join(base, weird)))
            write(sftp, base, weird, "three", "replace")
            check(read(sftp, SftpPath.join(base, weird)) == "three" && read(sftp, SftpPath.join(base, decoy)) == "decoy") { "replace" }
            check((sftp.lstat(SftpPath.q(SftpPath.join(base, weird))).permissions and 0xfff) == "750".toInt(8)) { "permissions not kept" }
            RemoteFiles.mkdir(sftp, home, base, "sub")
            check(code { write(sftp, base, "sub", "x", "replace") } == "sftp_exists") { "replaced a folder" }
            // Rename never lands on an existing name; a pattern-looking name that does not exist is just missing.
            check(code { RemoteFiles.rename(sftp, home, SftpPath.join(base, decoy), weird) } == "sftp_exists") { "rename over existing" }
            RemoteFiles.rename(sftp, home, SftpPath.join(base, weird), "renamed.txt")
            check(code { RemoteFiles.delete(sftp, home, SftpPath.join(base, "a*"), false, "") } == "sftp_missing") { "glob delete" }
            check(read(sftp, SftpPath.join(base, decoy)) == "decoy" && read(sftp, SftpPath.join(base, "renamed.txt")) == "three") { "files gone after glob delete" }
            // Folders: empty only, unless confirmed by name; links inside are removed, not followed.
            write(sftp, SftpPath.join(base, "sub"), "f", "f")
            RemoteFiles.mkdir(sftp, home, base, "keepme"); write(sftp, SftpPath.join(base, "keepme"), "precious", "p")
            sftp.symlink(SftpPath.join(base, "keepme"), SftpPath.join(base, "sub/link"))
            val link = RemoteFiles.list(sftp, home, SftpPath.join(base, "sub")).getJSONArray("entries").let { e -> (0 until e.length()).map { e.getJSONObject(it) }.first { it.getString("name") == "link" } }
            check(link.getString("type") == "link" && link.getString("target") == "dir") { "link listing $link" }
            check(code { RemoteFiles.delete(sftp, home, SftpPath.join(base, "sub"), false, "") } == "sftp_not_empty") { "non-empty folder deleted" }
            check(code { RemoteFiles.delete(sftp, home, SftpPath.join(base, "sub"), true, "su") } == "sftp_confirm") { "wrong confirm accepted" }
            check(RemoteFiles.delete(sftp, home, SftpPath.join(base, "sub"), true, "sub").getInt("deleted") == 3) { "tree delete count" }
            check(read(sftp, SftpPath.join(base, "keepme/precious")) == "p") { "followed a link while deleting" }
            check(code { RemoteFiles.delete(sftp, home, home, true, SftpPath.base(home)) } == "IllegalStateException") { "home deletable" }
        } finally { RemoteFiles.delete(sftp, home, base, true, SftpPath.base(base)) }
        check(RemoteFiles.lstatOrNull(sftp, base) == null) { "test folder left behind" }
    }

    private fun await(id: String): Transfer {
        val until = System.currentTimeMillis() + 120_000
        while (System.currentTimeMillis() < until) {
            val t = Transfers.get(id) ?: throw AssertionError("transfer vanished")
            if (t.state != "queued" && t.state != "running") return t
            Thread.sleep(50)
        }
        throw AssertionError("transfer timed out")
    }

    private fun transfers(context: Context, endpoint: Endpoint, pin: String, password: String) {
        val pinKey = PocketCore.pinId(endpoint)
        val previousPin = PocketCore.pins.getString(pinKey, null)
        val device = JSONObject().put("name", "fixture-sftp").put("host", endpoint.host).put("port", endpoint.port).put("user", endpoint.user)
        if (password.isEmpty()) device.put("auth", "key") else device.put("password", password).put("remember", true)
        val id = PocketCore.vault.save(device).getString("id")
        val src = File(context.cacheDir, "sftp-test-up.bin"); val big = File(context.cacheDir, "sftp-test-big.bin")
        var dir = ""
        try {
            PocketCore.pins.edit().putString(pinKey, pin).commit()
            PocketCore.connect(PocketCore.vault.get(id), password) {}
            dir = PocketCore.sftp(id) { sftp, home -> RemoteFiles.mkdir(sftp, home, "~", "pocket-xfer-" + UUID.randomUUID().toString().take(8)).getString("path") }
            val bytes = ByteArray(3_000_000).also { java.util.Random(7).nextBytes(it) }
            src.writeBytes(bytes)
            fun upload(file: File, name: String, mode: String): Transfer {
                val pick = Transfers.describe(context.contentResolver, Uri.fromFile(file))
                return await(Transfers.upload(context, id, JSONObject().put("id", pick.getString("id")).put("dir", dir).put("name", name).put("mode", mode)).getString("id"))
            }
            fun parts() = PocketCore.sftp(id) { sftp, home -> names(sftp, home, dir).filter { it.endsWith(".part") } }
            val up = upload(src, "up ✓.bin", "new")
            check(up.state == "done" && up.savedPath == "$dir/up ✓.bin" && up.done == 3_000_000L) { "upload ${up.state} ${up.error}" }
            // Download through MediaStore (pending until complete), then compare every byte.
            if (android.os.Build.VERSION.SDK_INT >= 29) {
                val down = await(Transfers.download(context, id, JSONObject().put("path", "$dir/up ✓.bin").put("size", 3_000_000), null).getString("id"))
                check(down.state == "done" && down.uri != null) { "download ${down.state} ${down.error}" }
                try { check(context.contentResolver.openInputStream(down.uri!!)!!.use { it.readBytes() }.contentEquals(bytes)) { "downloaded bytes differ" } }
                finally { context.contentResolver.delete(down.uri!!, null, null) }
                val missing = await(Transfers.download(context, id, JSONObject().put("path", "$dir/nope.bin"), null).getString("id"))
                check(missing.state == "failed" && missing.uri == null) { "missing download ${missing.state}" }
            }
            val clash = upload(src, "up ✓.bin", "new")
            check(clash.state == "failed" && clash.error.contains("已经有")) { "silent overwrite: ${clash.state} ${clash.error}" }
            check(upload(src, "up ✓.bin", "keep").savedPath == "$dir/up ✓ (2).bin") { "keep both" }
            check(parts().isEmpty()) { "temporary files left: ${parts()}" }
            // Cancel mid-way: no temporary file stays, nothing appears under the name.
            big.outputStream().use { o -> val chunk = ByteArray(1_000_000); repeat(48) { o.write(chunk) } }
            val pick = Transfers.describe(context.contentResolver, Uri.fromFile(big))
            val started = Transfers.upload(context, id, JSONObject().put("id", pick.getString("id")).put("dir", dir).put("name", "big.bin").put("mode", "new")).getString("id")
            while (Transfers.get(started)!!.let { it.state == "queued" || it.done == 0L && it.state == "running" }) Thread.sleep(5)
            Transfers.cancel(started)
            val cancelled = await(started)
            check(cancelled.state == "cancelled") { "cancel: ${cancelled.state} ${cancelled.done}" }
            check(parts().isEmpty() && "big.bin" !in PocketCore.sftp(id) { sftp, home -> names(sftp, home, dir) }) { "cancel left files" }
        } finally {
            if (dir.isNotEmpty()) try { PocketCore.sftp(id) { sftp, home -> RemoteFiles.delete(sftp, home, dir, true, SftpPath.base(dir)) } } catch (_: Exception) { }
            src.delete(); big.delete()
            PocketCore.disconnect(id)
            PocketCore.vault.delete(id)
            PocketCore.pins.edit().apply { if (previousPin == null) remove(pinKey) else putString(pinKey, previousPin) }.commit()
        }
    }
}
