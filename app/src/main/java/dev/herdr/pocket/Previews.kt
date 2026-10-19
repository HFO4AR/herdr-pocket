package dev.herdr.pocket

import android.content.ContentProvider
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.database.Cursor
import android.database.MatrixCursor
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import android.graphics.Matrix
import android.graphics.pdf.PdfRenderer
import android.media.ExifInterface
import android.net.Uri
import android.os.ParcelFileDescriptor
import android.provider.OpenableColumns
import android.util.Base64
import com.jcraft.jsch.SftpProgressMonitor
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileOutputStream
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.Charset
import java.nio.charset.CodingErrorAction
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean

/**
 * 文件 → 预览: reads one remote file over the computer's own SFTP session into the app's private
 * cache (never the phone's 下载 folder) and hands the page something it can show safely:
 *
 *  · text: decoded natively (UTF-8, else GB18030), at most [TEXT_MAX] bytes from the start, or the
 *    last [TAIL_MAX] bytes in tail mode (logs). Binary content is reported, never sent.
 *  · image: decoded and re-encoded natively (JPEG/PNG, long edge ≤ [EDGE]); a small GIF goes as
 *    is so it still moves. SVG is never rasterized here: the page shows it as source text.
 *  · pdf: [PdfRenderer] draws one page at a time to a bitmap; the page never parses the PDF.
 *
 * The cache is keyed by computer + path + mtime + size (+ the byte range), so a changed file is
 * read again. Bytes are counted for the page's progress bar; a request can be cancelled by token.
 * Images and PDFs above [MEDIA_MAX] need allowLarge (the page asks first); nothing above [HARD_MAX].
 */
object Previews {
    const val TEXT_MAX = 5_000_000L
    const val TAIL_MAX = 512L * 1024
    const val MEDIA_MAX = 20_000_000L
    const val HARD_MAX = 300_000_000L
    private const val CACHE_CAP = 250_000_000L
    private const val EDGE = 2048
    private const val GIF_RAW = 6_000_000L
    private val KEY = Regex("[0-9a-f]{40}")

    private class Meta(val name: String, val mime: String, val complete: Boolean)
    private val meta = ConcurrentHashMap<String, Meta>()
    private val stops = ConcurrentHashMap<String, AtomicBoolean>()
    private val pdfLock = Any()

    fun folder(context: Context) = File(context.cacheDir, "sftp-preview").apply { mkdirs() }

    /** Marks [token] cancelled; a fetch still reading stops at its next block and keeps nothing. */
    fun cancel(token: String) {
        if (token.isEmpty() || token.length > 80) return
        stops.getOrPut(token) { AtomicBoolean() }.set(true)
        while (stops.size > 200) stops.keys.firstOrNull()?.let { stops.remove(it) }
    }

    fun clear(context: Context) { folder(context).listFiles()?.forEach { it.delete() }; meta.clear() }

    fun fetch(context: Context, device: String, req: JSONObject, progress: (Long) -> Unit): JSONObject {
        val path = req.getString("path")
        require(path.startsWith("/") && path.indexOf('\u0000') < 0) { "路径不对" }
        val kind = req.optString("kind", "text").also { require(it in setOf("text", "image", "pdf", "raw")) { "不支持的预览方式" } }
        val tail = kind == "text" && req.optBoolean("tail")
        val token = req.optString("token").take(80)
        val stop = if (token.isEmpty()) AtomicBoolean() else stops.getOrPut(token) { AtomicBoolean() }
        val name = SftpPath.cleanName(SftpPath.base(path))
        val mime = Transfers.mimeOf(name)
        val dir = folder(context)
        val deviceId = PocketCore.linkInfo(device).first
        try {
            val got = PocketCore.sftp(device) { sftp, _ ->
                val a = sftp.stat(SftpPath.q(path))
                if (!a.isReg) throw Friendly("sftp_not_file", "只能预览普通文件")
                val size = a.size
                val mtime = a.mTime.toLong() and 0xffffffffL
                if (kind != "text" && size > MEDIA_MAX && !(req.optBoolean("allowLarge") && size <= HARD_MAX))
                    throw Friendly("preview_large", if (size > HARD_MAX) "文件有 ${mb(size)}，太大了，不能预览；可以下载" else "文件有 ${mb(size)}，预览要先读到手机上",
                        JSONObject().put("size", size).put("max", if (size > HARD_MAX) 0 else HARD_MAX))
                val limit = if (kind == "text") minOf(size, if (tail) TAIL_MAX else TEXT_MAX) else size
                val skip = if (tail) size - limit else 0L
                val fullKey = key(deviceId, path, mtime, size, 0, size)
                val full = File(dir, fullKey)
                // A complete copy also serves the start of a text file.
                val useFull = full.isFile && full.length() == size && skip == 0L
                val k = if (useFull) fullKey else key(deviceId, path, mtime, size, skip, limit)
                val file = File(dir, k)
                val cached = file.isFile && file.length() == (if (useFull) size else limit)
                if (!cached) {
                    val tmp = File(dir, "$k.${UUID.randomUUID().toString().take(8)}.tmp")
                    try {
                        var count = 0L
                        var last = 0L
                        FileOutputStream(tmp).use { out ->
                            sftp.get(SftpPath.q(path), null as SftpProgressMonitor?, skip).use { input ->
                                val buf = ByteArray(64 * 1024)
                                while (count < limit) {
                                    if (stop.get()) throw Friendly("preview_cancelled", "已取消")
                                    val n = input.read(buf, 0, minOf(buf.size.toLong(), limit - count).toInt())
                                    if (n < 0) break
                                    out.write(buf, 0, n); count += n
                                    val now = System.currentTimeMillis()
                                    if (now - last >= 120) { last = now; progress(count) }
                                }
                            }
                        }
                        if (count != limit) throw Friendly("sftp_short", "只读到 $count / $limit 字节，文件可能正在变")
                        progress(count)
                        if (!tmp.renameTo(file)) { file.delete(); check(tmp.renameTo(file)) { "手机缓存写不进去" } }
                    } finally { tmp.delete() }
                } else file.setLastModified(System.currentTimeMillis())
                Fetched(k, file, size, mtime, limit, skip, cached, useFull || (skip == 0L && limit == size))
            }
            prune(dir, got.file)
            meta[got.key] = Meta(name, mime, got.complete)
            val out = JSONObject().put("key", got.key).put("name", name).put("mime", mime).put("size", got.size).put("mtime", got.mtime)
                .put("cached", got.cached).put("complete", got.complete).put("path", path)
            when (kind) {
                "text" -> text(got, tail, out)
                "image" -> image(got.file, mime, out)
                "pdf" -> out.put("page", pdfPage(got.file, 0, req.optInt("width", 1080)))
            }
            return out
        } finally { if (token.isNotEmpty()) stops.remove(token) }
    }

    private class Fetched(val key: String, val file: File, val size: Long, val mtime: Long, val limit: Long, val skip: Long, val cached: Boolean, val complete: Boolean)

    // ─── Text ─────────────────────────────────────────────────────────────────────────────────────
    private fun text(f: Fetched, tail: Boolean, out: JSONObject) {
        val bytes = ByteArray(f.limit.toInt())
        RandomAccessFile(f.file, "r").use { it.readFully(bytes) }
        out.put("shown", bytes.size.toLong()).put("truncated", f.limit < f.size).put("tail", tail).put("offset", f.skip)
        if (looksBinary(bytes)) { out.put("binary", true); return }
        var start = 0
        var end = bytes.size
        // Tail: start after the first line break (the read began mid-line).
        if (tail && f.skip > 0) { val nl = bytes.indexOfFirst { it == '\n'.code.toByte() }; if (nl in 0 until end - 1) start = nl + 1 }
        // Cut in the middle of a UTF-8 sequence at the end of a partial read.
        if (f.skip + f.limit < f.size) end = utf8Whole(bytes, end)
        val (text, enc) = decode(bytes, start, end)
        out.put("binary", false).put("text", text).put("encoding", enc)
    }

    private fun looksBinary(b: ByteArray): Boolean {
        val n = minOf(b.size, 8192)
        if (n >= 2 && ((b[0] == 0xFF.toByte() && b[1] == 0xFE.toByte()) || (b[0] == 0xFE.toByte() && b[1] == 0xFF.toByte()))) return false
        var odd = 0
        for (i in 0 until n) {
            val c = b[i].toInt() and 0xff
            if (c == 0) return true
            if (c < 32 && c != 9 && c != 10 && c != 13 && c != 12 && c != 27 && c != 8) odd++
        }
        return n > 0 && odd * 10 > n
    }

    private fun utf8Whole(b: ByteArray, end: Int): Int {
        var i = end - 1
        var back = 0
        while (i >= 0 && back < 3 && (b[i].toInt() and 0xC0) == 0x80) { i--; back++ }
        if (i < 0) return end
        val lead = b[i].toInt() and 0xff
        val need = when { lead >= 0xF0 -> 4; lead >= 0xE0 -> 3; lead >= 0xC0 -> 2; else -> 1 }
        return if (end - i < need) i else end
    }

    private fun decode(b: ByteArray, start: Int, end: Int): Pair<String, String> {
        if (end - start >= 2 && b[start] == 0xFF.toByte() && b[start + 1] == 0xFE.toByte()) return String(b, start + 2, end - start - 2, Charsets.UTF_16LE) to "UTF-16"
        if (end - start >= 2 && b[start] == 0xFE.toByte() && b[start + 1] == 0xFF.toByte()) return String(b, start + 2, end - start - 2, Charsets.UTF_16BE) to "UTF-16"
        var s = start
        if (end - s >= 3 && b[s] == 0xEF.toByte() && b[s + 1] == 0xBB.toByte() && b[s + 2] == 0xBF.toByte()) s += 3
        strict(Charsets.UTF_8, b, s, end)?.let { return it to "UTF-8" }
        try { strict(Charset.forName("GB18030"), b, s, end)?.let { return it to "GB18030" } } catch (_: Exception) { }
        return String(b, s, end - s, Charsets.UTF_8) to "UTF-8（有乱码）"
    }

    private fun strict(cs: Charset, b: ByteArray, start: Int, end: Int): String? = try {
        cs.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT)
            .decode(ByteBuffer.wrap(b, start, end - start)).toString()
    } catch (_: CharacterCodingException) { null }

    // ─── Images ───────────────────────────────────────────────────────────────────────────────────
    private fun image(file: File, mime: String, out: JSONObject) {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(file.path, bounds)
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) throw Friendly("preview_image", "这张图片手机解不开，可以下载后用其他应用打开")
        out.put("origWidth", bounds.outWidth).put("origHeight", bounds.outHeight)
        if (bounds.outMimeType == "image/gif" && file.length() <= GIF_RAW) {
            out.put("url", dataUrl(file.readBytes(), "image/gif")).put("width", bounds.outWidth).put("height", bounds.outHeight); return
        }
        var sample = 1
        while (maxOf(bounds.outWidth, bounds.outHeight) / (sample * 2) >= EDGE) sample *= 2
        val raw = BitmapFactory.decodeFile(file.path, BitmapFactory.Options().apply { inSampleSize = sample })
            ?: throw Friendly("preview_image", "这张图片手机解不开，可以下载后用其他应用打开")
        val orientation = try { ExifInterface(file.path).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL) } catch (_: Exception) { ExifInterface.ORIENTATION_NORMAL }
        val scale = minOf(1f, EDGE.toFloat() / maxOf(raw.width, raw.height))
        val m = Matrix()
        if (scale < 1f) m.postScale(scale, scale)
        when (orientation) {
            ExifInterface.ORIENTATION_ROTATE_90 -> m.postRotate(90f)
            ExifInterface.ORIENTATION_ROTATE_180 -> m.postRotate(180f)
            ExifInterface.ORIENTATION_ROTATE_270 -> m.postRotate(270f)
        }
        val bmp = if (m.isIdentity) raw else Bitmap.createBitmap(raw, 0, 0, raw.width, raw.height, m, true)
        val png = bmp.hasAlpha()
        val bytes = ByteArrayOutputStream().also { bmp.compress(if (png) Bitmap.CompressFormat.PNG else Bitmap.CompressFormat.JPEG, 88, it) }.toByteArray()
        out.put("url", dataUrl(bytes, if (png) "image/png" else "image/jpeg")).put("width", bmp.width).put("height", bmp.height)
    }

    // ─── PDF ──────────────────────────────────────────────────────────────────────────────────────
    /** One more page of a PDF already in the cache ([fetch] with kind pdf). */
    fun page(context: Context, req: JSONObject): JSONObject {
        val key = req.getString("key").also { require(KEY.matches(it)) { "预览已过期" } }
        val file = File(folder(context), key)
        if (!file.isFile) throw Friendly("preview_gone", "预览已过期，重新打开一下")
        return pdfPage(file, req.optInt("page"), req.optInt("width", 1080))
    }

    private fun pdfPage(file: File, index: Int, width: Int): JSONObject = synchronized(pdfLock) {
        try {
            ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY).use { fd ->
                val r = PdfRenderer(fd)
                try {
                    val n = r.pageCount
                    if (n <= 0) throw Friendly("preview_pdf", "这个 PDF 没有页面")
                    val i = index.coerceIn(0, n - 1)
                    val p = r.openPage(i)
                    try {
                        val w = width.coerceIn(240, 1600)
                        val h = (w.toLong() * p.height / maxOf(1, p.width)).toInt().coerceIn(1, 4 * w)
                        val bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
                        bmp.eraseColor(Color.WHITE)
                        p.render(bmp, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
                        val bytes = ByteArrayOutputStream().also { bmp.compress(Bitmap.CompressFormat.JPEG, 86, it) }.toByteArray()
                        bmp.recycle()
                        JSONObject().put("url", dataUrl(bytes, "image/jpeg")).put("width", w).put("height", h).put("index", i).put("pages", n)
                    } finally { p.close() }
                } finally { r.close() }
            }
        } catch (e: Friendly) { throw e }
        catch (e: SecurityException) { throw Friendly("preview_pdf", "这个 PDF 有密码，预览不了；可以下载后用其他应用打开") }
        catch (e: Exception) { throw Friendly("preview_pdf", "这个 PDF 打不开预览（可能已损坏）；可以下载后用其他应用打开") }
    }

    // ─── Open with / share ────────────────────────────────────────────────────────────────────────
    /** ACTION_VIEW / ACTION_SEND for a complete cached copy, through [PreviewFiles] (read-only grant). */
    fun intent(key: String, share: Boolean): Intent {
        require(KEY.matches(key)) { "预览已过期" }
        val m = meta[key] ?: throw Friendly("preview_gone", "预览已过期，重新打开一下")
        if (!m.complete) throw Friendly("preview_partial", "只读了一部分，先下载完整的文件")
        val uri = Uri.parse("content://${PreviewFiles.AUTHORITY}/$key")
        return if (share) Intent.createChooser(Intent(Intent.ACTION_SEND).setType(m.mime).putExtra(Intent.EXTRA_STREAM, uri).putExtra(Intent.EXTRA_TITLE, m.name)
            .apply { clipData = android.content.ClipData.newRawUri(m.name, uri) }
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION), "分享「${m.name}」")
        else Intent(Intent.ACTION_VIEW).setDataAndType(uri, m.mime).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
    }

    internal fun fileFor(context: Context, key: String): File? = if (KEY.matches(key)) File(folder(context), key).takeIf { it.isFile } else null
    internal fun nameOf(key: String): String = meta[key]?.name ?: key
    internal fun mimeOf(key: String): String = meta[key]?.mime ?: "application/octet-stream"

    // ─── Shared ───────────────────────────────────────────────────────────────────────────────────
    private fun key(device: String, path: String, mtime: Long, size: Long, skip: Long, limit: Long): String =
        MessageDigest.getInstance("SHA-1").digest("$device\n$path\n$mtime\n$size\n$skip\n$limit".toByteArray()).joinToString("") { "%02x".format(it) }

    /** Oldest first until the folder fits [CACHE_CAP]; [keep] (just read) stays. Stale temp files go too. */
    private fun prune(dir: File, keep: File) {
        val files = dir.listFiles()?.toMutableList() ?: return
        val now = System.currentTimeMillis()
        files.filter { it.name.endsWith(".tmp") && now - it.lastModified() > 3_600_000 }.forEach { it.delete(); files.remove(it) }
        var total = files.sumOf { it.length() }
        for (f in files.filter { !it.name.endsWith(".tmp") }.sortedBy { it.lastModified() }) {
            if (total <= CACHE_CAP) break
            if (f == keep) continue
            total -= f.length(); f.delete(); meta.remove(f.name)
        }
    }
    private fun dataUrl(bytes: ByteArray, mime: String) = "data:$mime;base64," + Base64.encodeToString(bytes, Base64.NO_WRAP)
    private fun mb(n: Long) = if (n >= 1_000_000_000) "%.1f GB".format(n / 1e9) else "${(n + 999_999) / 1_000_000} MB"
}

/** Read-only access to one cached preview copy, only through a per-intent grant (not exported). */
class PreviewFiles : ContentProvider() {
    override fun onCreate() = true
    private fun fileFor(uri: Uri): File {
        val key = uri.lastPathSegment ?: throw SecurityException("bad uri")
        if (uri.pathSegments.size != 1) throw SecurityException("bad uri")
        return Previews.fileFor(context!!, key) ?: throw SecurityException("gone")
    }
    override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor {
        if (mode != "r") throw SecurityException("read only")
        return ParcelFileDescriptor.open(fileFor(uri), ParcelFileDescriptor.MODE_READ_ONLY)
    }
    override fun getType(uri: Uri) = Previews.mimeOf(uri.lastPathSegment ?: "")
    override fun query(uri: Uri, projection: Array<out String>?, selection: String?, args: Array<out String>?, sort: String?): Cursor {
        val file = fileFor(uri)
        return MatrixCursor(arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE)).apply { addRow(arrayOf<Any>(Previews.nameOf(file.name), file.length())) }
    }
    override fun insert(uri: Uri, values: ContentValues?): Uri? = null
    override fun delete(uri: Uri, selection: String?, args: Array<out String>?) = 0
    override fun update(uri: Uri, values: ContentValues?, selection: String?, args: Array<out String>?) = 0

    companion object { const val AUTHORITY = "dev.herdr.pocket.preview" }
}
