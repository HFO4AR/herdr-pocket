package dev.herdr.pocket

import android.content.ContentResolver
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.os.StatFs
import android.provider.DocumentsContract
import android.provider.MediaStore
import android.provider.OpenableColumns
import android.webkit.MimeTypeMap
import com.jcraft.jsch.ChannelSftp
import com.jcraft.jsch.SftpException
import org.json.JSONArray
import org.json.JSONObject
import java.io.FilterInputStream
import java.io.IOException
import java.io.InputStream
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors

/** One upload or download of the 文件 screen. Only names, sizes and counters; never file contents. */
class Transfer(val id: String, val device: String, val deviceName: String, val kind: String, @Volatile var name: String, val remote: String, @Volatile var size: Long) {
    @Volatile var state = "queued" // queued, running, done, failed, cancelled
    @Volatile var done = 0L
    @Volatile var error = ""
    @Volatile var cancelled = false
    /** Download: the finished document (MediaStore row or the picked document). Upload: the final remote path. */
    @Volatile var uri: Uri? = null
    @Volatile var savedPath = ""
    @Volatile var where = ""
    @Volatile var mime = ""
    val at = System.currentTimeMillis()
    @Volatile var ended = 0L
    fun json(): JSONObject = JSONObject().put("id", id).put("device", device).put("deviceName", deviceName).put("kind", kind)
        .put("name", name).put("remote", remote).put("size", size).put("done", done).put("state", state).put("error", error)
        .put("at", at).put("ended", ended).put("where", where).put("saved", savedPath).put("canOpen", kind == "down" && state == "done" && uri != null)
}

/** Stops a running copy: raised from inside the stream JSch or the copy loop reads. */
private class Cancelled : IOException("已取消")

/**
 * Uploads and downloads over SFTP, process-wide so they keep running while the page changes (and
 * while the activity is recreated). At most [PARALLEL] run at once; the rest wait in order. The page
 * polls [list]; nothing is pushed.
 *
 *  · Download: the remote file is read once into a document that is not visible as finished until
 *    every byte arrived: a MediaStore Downloads row with IS_PENDING (Download/Herdr Pocket), or the
 *    document the person created with 另存为. The byte count must equal the size the computer
 *    reported at the start; otherwise, on cancel or on any error, the document is deleted.
 *  · Upload: streamed to a hidden temporary name in the target folder (same file system), its size
 *    checked, then moved into place: without replacing anything (hardlink, which fails when the
 *    name exists, then the temp is removed), as 「名字 (2)」, or replacing a regular file (atomic
 *    posix-rename on OpenSSH). The temporary file is removed on failure or cancel.
 */
object Transfers {
    const val PARALLEL = 2
    private const val KEEP = 40
    private val pool = Executors.newFixedThreadPool(PARALLEL) { r -> Thread(r, "pocket-transfer").apply { isDaemon = true } }
    private val all = LinkedHashMap<String, Transfer>() // guarded by itself
    /** Phone files picked for upload: id → (uri, name, size). Only ids reach the page. */
    private val picks = ConcurrentHashMap<String, Picked>()

    fun list(): JSONObject = JSONObject().put("transfers", JSONArray().apply { synchronized(all) { all.values.forEach { put(it.json()) } } })

    private fun add(t: Transfer) = synchronized(all) {
        all[t.id] = t
        // Forget the oldest finished ones beyond KEEP; running ones always stay.
        val over = all.size - KEEP
        if (over > 0) all.values.filter { it.state != "running" && it.state != "queued" }.take(over).forEach { all.remove(it.id) }
    }
    fun get(id: String): Transfer? = synchronized(all) { all[id] }

    fun cancel(id: String): JSONObject {
        val t = get(id) ?: error("这个传输已经不在列表里了")
        t.cancelled = true
        if (t.state == "queued") { t.state = "cancelled"; t.ended = System.currentTimeMillis() }
        return t.json()
    }

    /** Clears finished rows (done, failed, cancelled) from the list; the files stay where they are. */
    fun forget(): JSONObject { synchronized(all) { all.values.filter { it.state != "running" && it.state != "queued" }.forEach { all.remove(it.id) } }; return list() }

    // ─── Phone side: picking ──────────────────────────────────────────────────────────────────────
    /** Name and size of a picked document; reading access is kept until its upload ends. */
    fun describe(resolver: ContentResolver, uri: Uri): JSONObject {
        var name: String? = null; var size = -1L
        resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { c ->
            if (c.moveToFirst()) {
                c.getColumnIndex(OpenableColumns.DISPLAY_NAME).takeIf { it >= 0 && !c.isNull(it) }?.let { name = c.getString(it) }
                c.getColumnIndex(OpenableColumns.SIZE).takeIf { it >= 0 && !c.isNull(it) }?.let { size = c.getLong(it) }
            }
        }
        val p = Picked(UUID.randomUUID().toString(), uri, SftpPath.cleanName(name ?: uri.lastPathSegment), size, resolver.getType(uri) ?: "")
        picks[p.id] = p
        while (picks.size > 200) picks.keys.firstOrNull()?.let { picks.remove(it) }
        return JSONObject().put("id", p.id).put("name", p.name).put("size", p.size)
    }
    fun drop(id: String) { picks.remove(id) }

    // ─── Upload ───────────────────────────────────────────────────────────────────────────────────
    /** [mode]: "new" (fail when the name is taken), "keep" (保留两个) or "replace" (替换 a regular file). */
    fun upload(context: Context, device: String, req: JSONObject): JSONObject {
        val pick = picks[req.getString("id")] ?: error("这个文件已失效，重新选一下")
        val mode = req.optString("mode", "new").also { require(it in setOf("new", "keep", "replace")) { "不支持的方式" } }
        val dirRaw = req.getString("dir")
        val name = SftpPath.checkName(req.optString("name").ifEmpty { pick.name })
        require(dirRaw.startsWith("/") || dirRaw.startsWith("~")) { "目标文件夹不对" }
        val link = PocketCore.linkInfo(device)
        val t = Transfer(UUID.randomUUID().toString(), link.first, link.second, "up", name, dirRaw, pick.size)
        add(t)
        val resolver = context.applicationContext.contentResolver
        pool.execute { run(t) { uploadNow(resolver, t, pick, dirRaw, mode) } }
        return t.json()
    }

    private fun uploadNow(resolver: ContentResolver, t: Transfer, pick: Picked, dirRaw: String, mode: String) {
        var temp = ""
        try {
            PocketCore.sftp(t.device) { sftp, home ->
                val dir = SftpPath.resolve(dirRaw, home)
                val d = sftp.stat(SftpPath.q(dir))
                if (!d.isDir) throw Friendly("sftp_not_dir", "目标不是文件夹了")
                temp = SftpPath.join(dir, ".herdr-pocket-" + UUID.randomUUID().toString().replace("-", "").take(16) + ".part")
                val input = resolver.openInputStream(pick.uri) ?: throw Friendly("sftp_source", "手机上的「${pick.name}」读不到了")
                val counted = input.use { raw -> Counting(raw, t).also { sftp.put(it, SftpPath.q(temp), ChannelSftp.OVERWRITE) } }.count
                if (t.cancelled) throw Cancelled()
                val written = sftp.lstat(SftpPath.q(temp)).size
                if (written != counted) throw Friendly("sftp_short", "上传不完整（电脑上 $written / 手机读出 $counted 字节），没有放进去")
                if (pick.size >= 0 && counted != pick.size) throw Friendly("sftp_short", "手机上读出的大小（$counted）和文件大小（${pick.size}）不一样，没有放进去")
                t.size = counted
                val final = place(sftp, temp, dir, t.name, mode)
                temp = ""
                t.name = SftpPath.base(final); t.savedPath = final; t.where = dir
            }
        } catch (e: Exception) {
            // On a fresh channel: a put stopped half way leaves unread replies on the old one.
            val left = temp
            if (left.isNotEmpty()) try { PocketCore.sftp(t.device) { s, _ -> if (RemoteFiles.lstatOrNull(s, left) != null) s.rm(SftpPath.q(left)) } } catch (_: Exception) { }
            throw e
        } finally { picks.remove(pick.id); release(resolver, pick.uri) }
    }

    /** Moves the finished temporary file to [name] in [dir] according to [mode]; returns the final path. */
    fun place(sftp: ChannelSftp, temp: String, dir: String, name: String, mode: String): String {
        val target = SftpPath.join(dir, name)
        when (mode) {
            "replace" -> {
                val existing = RemoteFiles.lstatOrNull(sftp, target)
                if (existing == null) { if (placeNew(sftp, temp, target)) return target; throw Friendly("sftp_exists", "「$name」刚刚出现了，没有替换") }
                if (!existing.isReg || existing.isLink) throw Friendly("sftp_exists", "同名的「$name」是文件夹或链接，不替换")
                // Keep the replaced file's permission bits (an executable script stays executable).
                try { sftp.chmod(existing.permissions and 0xfff, SftpPath.q(temp)) } catch (_: Exception) { }
                if (sftp.getExtension("posix-rename@openssh.com") != null) sftp.rename(SftpPath.q(temp), SftpPath.q(target))
                else {
                    // Plain SFTP rename refuses an existing name: remove the old file first (not atomic).
                    sftp.rm(SftpPath.q(target)); sftp.rename(SftpPath.q(temp), SftpPath.q(target))
                }
                return target
            }
            "keep" -> {
                if (placeNew(sftp, temp, target)) return target
                for (n in 2..99) { val other = SftpPath.join(dir, SftpPath.numbered(name, n)); if (placeNew(sftp, temp, other)) return other }
                throw Friendly("sftp_exists", "同名的文件太多了，没有放进去")
            }
            else -> { if (placeNew(sftp, temp, target)) return target; throw Friendly("sftp_conflict", "电脑上已经有「$name」了，没有覆盖") }
        }
    }

    /**
     * Puts [temp] at [target] only when nothing has that name. With OpenSSH's hardlink extension
     * this is one atomic "create if absent"; otherwise it is a check followed by a plain rename
     * (JSch's rename would replace an existing file through posix-rename, so the check comes first).
     */
    private fun placeNew(sftp: ChannelSftp, temp: String, target: String): Boolean {
        if (sftp.getExtension("hardlink@openssh.com") != null) {
            try { sftp.hardlink(SftpPath.q(temp), SftpPath.q(target)); try { sftp.rm(SftpPath.q(temp)) } catch (_: Exception) { }; return true }
            catch (e: SftpException) { if (RemoteFiles.lstatOrNull(sftp, target) != null) return false /* else: no hard links here (some file systems); fall through */ }
        }
        if (RemoteFiles.lstatOrNull(sftp, target) != null) return false
        sftp.rename(SftpPath.q(temp), SftpPath.q(target))
        return true
    }

    // ─── Download ─────────────────────────────────────────────────────────────────────────────────
    /** [into]: a document the person created (另存为), or null for Download/Herdr Pocket (Android 10+). */
    fun download(context: Context, device: String, req: JSONObject, into: Uri?): JSONObject {
        val path = req.getString("path")
        require(path.startsWith("/") && path.indexOf('\u0000') < 0) { "路径不对" }
        if (into == null && Build.VERSION.SDK_INT < 29) throw Friendly("sftp_old_android", "这个安卓版本请用「另存为」选位置")
        val link = PocketCore.linkInfo(device)
        val t = Transfer(UUID.randomUUID().toString(), link.first, link.second, "down", SftpPath.cleanName(SftpPath.base(path)), path, req.optLong("size", -1))
        t.mime = mimeOf(t.name)
        add(t)
        val app = context.applicationContext
        pool.execute { run(t) { downloadNow(app, t, into) } }
        return t.json()
    }

    private fun downloadNow(context: Context, t: Transfer, into: Uri?) {
        val resolver = context.contentResolver
        var target: Uri? = into
        var pending = false
        try {
            PocketCore.sftp(t.device) { sftp, _ ->
                val a = sftp.stat(SftpPath.q(t.remote))
                if (!a.isReg) throw Friendly("sftp_not_file", "只能下载普通文件")
                val expected = a.size
                t.size = expected
                if (into == null) {
                    if (Build.VERSION.SDK_INT < 29) throw Friendly("sftp_old_android", "这个安卓版本请用「另存为」选位置")
                    val free = freeBytes()
                    if (free in 0 until expected + 32_000_000L) throw Friendly("sftp_space", "手机空间不够：要 ${mb(expected)}，只剩 ${mb(free)}")
                    val values = ContentValues().apply {
                        put(MediaStore.MediaColumns.DISPLAY_NAME, t.name)
                        put(MediaStore.MediaColumns.MIME_TYPE, t.mime)
                        put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/Herdr Pocket")
                        put(MediaStore.MediaColumns.IS_PENDING, 1)
                    }
                    target = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values) ?: throw Friendly("sftp_save", "手机的「下载」文件夹写不进去")
                    pending = true
                }
                val out = (try { resolver.openOutputStream(target!!, "wt") } catch (_: Exception) { null } ?: resolver.openOutputStream(target!!, "w"))
                    ?: throw Friendly("sftp_save", "手机上的目标文件打不开")
                var count = 0L
                out.use { o ->
                    sftp.get(SftpPath.q(t.remote)).use { input ->
                        val buf = ByteArray(64 * 1024)
                        while (true) {
                            if (t.cancelled) throw Cancelled()
                            val n = input.read(buf)
                            if (n < 0) break
                            o.write(buf, 0, n); count += n; t.done = count
                            if (count > expected) throw Friendly("sftp_changed", "电脑上的文件在下载时变大了，已删掉没下完的文件")
                        }
                    }
                }
                if (count != expected) throw Friendly("sftp_short", "只收到 ${count} / ${expected} 字节，已删掉没下完的文件")
            }
            val doc = target!!
            if (pending && Build.VERSION.SDK_INT >= 29) {
                resolver.update(doc, ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) }, null, null)
                pending = false
            }
            t.uri = doc
            displayName(resolver, doc)?.let { t.name = it }
            t.where = if (into == null) "下载/Herdr Pocket" else "你选的位置"
        } catch (e: Exception) {
            target?.let { doc -> try { if (into == null) resolver.delete(doc, null, null) else DocumentsContract.deleteDocument(resolver, doc) } catch (_: Exception) { } }
            throw e
        }
    }

    /** Opens (ACTION_VIEW) or shares (ACTION_SEND) a finished download; the URI never comes from the page. */
    fun intent(id: String, share: Boolean): Intent {
        val t = get(id) ?: error("这个下载已经不在列表里了")
        val uri = t.uri ?: error("还没下载完")
        // The ClipData carries the grant to the chooser too, so its preview shows the real name.
        return if (share) Intent.createChooser(Intent(Intent.ACTION_SEND).setType(t.mime).putExtra(Intent.EXTRA_STREAM, uri).putExtra(Intent.EXTRA_TITLE, t.name)
            .apply { clipData = android.content.ClipData.newRawUri(t.name, uri) }
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION), "分享「${t.name}」")
        else Intent(Intent.ACTION_VIEW).setDataAndType(uri, t.mime).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
    }

    // ─── Shared ───────────────────────────────────────────────────────────────────────────────────
    private fun run(t: Transfer, body: () -> Unit) {
        if (t.cancelled) { t.state = "cancelled"; t.ended = System.currentTimeMillis(); return }
        t.state = "running"
        try { body(); t.state = "done" }
        catch (e: Throwable) {
            val cancelled = t.cancelled || generateSequence(e) { it.cause }.any { it is Cancelled }
            t.state = if (cancelled) "cancelled" else "failed"
            t.error = if (cancelled) "" else if (e is OutOfMemoryError) "内存不够" else RemoteFiles.friendly(e).message ?: "传输失败"
        } finally { t.ended = System.currentTimeMillis() }
    }

    /** Counts what JSch reads from the phone file, for progress and the size check; stops on cancel. */
    private class Counting(source: InputStream, private val t: Transfer) : FilterInputStream(source) {
        var count = 0L
            private set
        override fun read(): Int { if (t.cancelled) throw Cancelled(); val b = super.read(); if (b >= 0) { count++; t.done = count }; return b }
        override fun read(b: ByteArray, off: Int, len: Int): Int {
            if (t.cancelled) throw Cancelled()
            val n = super.read(b, off, len)
            if (n > 0) { count += n; t.done = count }
            return n
        }
    }

    private fun release(resolver: ContentResolver, uri: Uri) {
        try { resolver.releasePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION) } catch (_: Exception) { }
    }
    private fun displayName(resolver: ContentResolver, uri: Uri): String? = try {
        resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c -> if (c.moveToFirst() && !c.isNull(0)) c.getString(0) else null }
    } catch (_: Exception) { null }
    private fun freeBytes(): Long = try { StatFs(Environment.getExternalStorageDirectory().path).availableBytes } catch (_: Exception) { -1 }
    private fun mb(n: Long) = if (n >= 1_000_000_000) "%.1f GB".format(n / 1e9) else "${(n + 999_999) / 1_000_000} MB"
    fun mimeOf(name: String): String {
        val ext = name.substringAfterLast('.', "").lowercase()
        return MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext) ?: "application/octet-stream"
    }
}
