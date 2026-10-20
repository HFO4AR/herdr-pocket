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
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.sqrt

/**
 * 文件 → 预览: reads one remote file over the computer's own SFTP session into the app's private
 * cache (never the phone's 下载 folder) and hands the page something it can show safely:
 *
 *  · text: decoded natively (UTF-8, else GB18030), at most [TEXT_MAX] bytes from the start, or the
 *    last [TAIL_MAX] bytes in tail mode (logs). Binary content is reported, never sent.
 *  · image: a complete browser-decodable original is served as-is through [PreviewServer]; anything
 *    else is decoded with EXIF-aware orientation, downsampled to a clear 4096 px long edge (and a
 *    per-device pixel cap), and written as a derived asset. GIFs stay animated when passed through.
 *  · pdf: [PdfRenderer] draws one page at a time to a high-resolution JPEG. Pages are derived files
 *    keyed by source + page + width + renderer version and served through [PreviewServer].
 *
 * Source copies and derived files live in separate folders with separate caps. Bytes are counted for
 * the page's progress bar; a request can be cancelled by token. Images and PDFs above [MEDIA_MAX]
 * need allowLarge (the page asks first); nothing above [HARD_MAX].
 */
object Previews {
    const val TEXT_MAX = 5_000_000L
    const val TAIL_MAX = 512L * 1024
    const val MEDIA_MAX = 20_000_000L
    const val HARD_MAX = 300_000_000L
    const val IMAGE_MAX_EDGE = 4096
    const val PDF_MAX_WIDTH = 4096
    internal const val IMAGE_MAX_PIXELS = 12_000_000L
    internal const val PDF_MAX_PIXELS = 10_000_000L
    private const val CACHE_CAP = 250_000_000L
    private const val DERIVED_CAP = 120_000_000L
    private const val PASS_BYTES = 36_000_000L
    private const val PASS_PIXELS = 14_000_000L
    private const val LOW_MEMORY = 192L * 1024 * 1024
    private const val DERIVED_VERSION = 2
    private const val PDF_RENDERER_VERSION = 2
    private val KEY = Regex("[0-9a-f]{40}")
    private val BROWSER_IMAGE = setOf("image/jpeg", "image/png", "image/webp", "image/gif", "image/bmp", "image/avif")

    internal enum class AssetKind { SOURCE, IMAGE, PAGE, OFFICE }
    internal class Asset(val file: File, val mime: String, val name: String)
    private class Meta(val name: String, val mime: String, val complete: Boolean)
    private class Derived(val kind: AssetKind, val file: File, val mime: String, val name: String,
                          val width: Int = 0, val height: Int = 0, val pages: Int = 0)

    private val meta = ConcurrentHashMap<String, Meta>()
    private val derived = ConcurrentHashMap<String, Derived>()
    private val stops = ConcurrentHashMap<String, AtomicBoolean>()
    private val pdfLock = Any()

    fun folder(context: Context) = File(context.cacheDir, "sftp-preview").apply { mkdirs() }
    private fun derivedFolder(context: Context) = File(context.cacheDir, "sftp-preview-derived").apply { mkdirs() }
    private fun derivedDir(context: Context, kind: AssetKind): File =
        File(derivedFolder(context), when (kind) {
            AssetKind.IMAGE -> "images"; AssetKind.PAGE -> "pages"; AssetKind.OFFICE -> "office"; AssetKind.SOURCE -> "images"
        }).apply { mkdirs() }

    /** Marks [token] cancelled; a fetch still reading stops at its next block and keeps nothing. */
    fun cancel(token: String) {
        if (token.isEmpty() || token.length > 80) return
        stops.getOrPut(token) { AtomicBoolean() }.set(true)
        while (stops.size > 200) stops.keys.firstOrNull()?.let { stops.remove(it) }
    }

    fun clear(context: Context) {
        deleteTree(folder(context)); deleteTree(derivedFolder(context)); meta.clear(); derived.clear()
    }

    fun fetch(context: Context, device: String, req: JSONObject, progress: (Long) -> Unit): JSONObject {
        val got = acquire(context, device, req, progress)
        val kind = req.optString("kind", "text")
        val out = JSONObject().put("key", got.key).put("name", got.name).put("mime", got.mime).put("size", got.size).put("mtime", got.mtime)
            .put("cached", got.cached).put("complete", got.complete).put("path", got.path)
        when (kind) {
            "text" -> text(got, kind == "text" && req.optBoolean("tail"), out)
            "image" -> image(context, got, out)
            "pdf" -> out.put("page", pdfPage(context, got.key, got.file, 0, req.optInt("width", 1080)))
        }
        return out
    }

    internal class Fetched(val key: String, val file: File, val size: Long, val mtime: Long, val limit: Long, val skip: Long,
                           val cached: Boolean, val complete: Boolean, val name: String, val mime: String, val path: String)

    /**
     * The reusable SFTP/stat/cache/progress/cancel half of [fetch]. Later media/Office phases can
     * call this without going through the text/image/PDF formatting.
     */
    internal fun acquire(context: Context, device: String, req: JSONObject, progress: (Long) -> Unit): Fetched {
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
                Fetched(k, file, size, mtime, limit, skip, cached, useFull || (skip == 0L && limit == size), name, mime, path)
            }
            pruneSource(dir, got.file)
            meta[got.key] = Meta(name, mime, got.complete)
            return got
        } finally { if (token.isNotEmpty()) stops.remove(token) }
    }

    /** Look up an asset by capability token. No caller-supplied path ever reaches the filesystem. */
    internal fun assetFor(context: Context, token: String, kind: AssetKind?): Asset? {
        if (!KEY.matches(token)) return null
        if (kind == null) {
            derived[token]?.takeIf { it.kind == AssetKind.IMAGE }?.let {
                if (it.file.isFile) return Asset(it.file, it.mime, it.name)
            }
            val m = meta[token] ?: return null
            if (!m.complete) return null
            val file = File(folder(context), token)
            return if (file.isFile) Asset(file, m.mime, m.name) else null
        }
        val d = derived[token] ?: return null
        if (d.kind != kind || !d.file.isFile) return null
        return Asset(d.file, d.mime, d.name)
    }

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
    private fun image(context: Context, f: Fetched, out: JSONObject) {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(f.file.path, bounds)
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) throw Friendly("preview_image", "这张图片手机解不开，可以下载后用其他应用打开")
        val encoded = bounds.outMimeType ?: f.mime
        val w = bounds.outWidth
        val h = bounds.outHeight
        val orientation = try {
            ExifInterface(f.file.path).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)
        } catch (_: Exception) { ExifInterface.ORIENTATION_NORMAL }
        val swapped = orientation in ExifInterface.ORIENTATION_TRANSPOSE..ExifInterface.ORIENTATION_ROTATE_270
        val visualW = if (swapped) h else w
        val visualH = if (swapped) w else h
        out.put("origWidth", w).put("origHeight", h)
        val passPixels = if (lowMemory()) 8_000_000L else PASS_PIXELS
        if (encoded in BROWSER_IMAGE && f.complete && f.file.length() <= PASS_BYTES && w.toLong() * h <= passPixels) {
            // The browser decodes the original (and its EXIF orientation, animated GIF frames) itself.
            meta[f.key] = Meta(f.name, encoded, true)
            out.put("url", PreviewServer.assetUrl(f.key)).put("width", visualW).put("height", visualH).put("mime", encoded)
            return
        }
        val maxEdge = if (lowMemory()) 3072 else IMAGE_MAX_EDGE
        val maxPixels = if (lowMemory()) 6_000_000L else IMAGE_MAX_PIXELS
        val targetScale = min(1.0, min(maxEdge.toDouble() / maxOf(visualW, visualH), sqrt(maxPixels.toDouble() / (visualW.toLong() * visualH))))
        val targetW = maxOf(1, (visualW * targetScale).roundToInt())
        val targetH = maxOf(1, (visualH * targetScale).roundToInt())
        // Do not allocate the original 100 MP ARGB buffer just to scale it down.
        var sample = 1
        val decodeCap = if (lowMemory()) 12_000_000L else 24_000_000L
        while ((w.toLong() / sample) * (h.toLong() / sample) > decodeCap && sample < 64) sample *= 2
        val raw = try {
            BitmapFactory.decodeFile(f.file.path, BitmapFactory.Options().apply { inSampleSize = sample })
        } catch (_: OutOfMemoryError) {
            throw Friendly("preview_image", "这张图片太大，手机内存不够；可以下载后用其他应用打开")
        } ?: throw Friendly("preview_image", "这张图片手机解不开，可以下载后用其他应用打开")
        var upright: Bitmap? = null
        var scaled: Bitmap? = null
        try {
            upright = orient(raw, orientation)
            val sourceW = upright.width
            val sourceH = upright.height
            val sx = min(1.0, targetW.toDouble() / sourceW)
            val sy = min(1.0, targetH.toDouble() / sourceH)
            val s = min(sx, sy)
            scaled = if (s >= 0.999) upright else Bitmap.createScaledBitmap(upright, maxOf(1, (sourceW * s).roundToInt()), maxOf(1, (sourceH * s).roundToInt()), true)
            val png = scaled.hasAlpha()
            val mime = if (png) "image/png" else "image/jpeg"
            val bytes = ByteArrayOutputStream().also { scaled.compress(if (png) Bitmap.CompressFormat.PNG else Bitmap.CompressFormat.JPEG, 92, it) }.toByteArray()
            val token = keyFor("image-v$DERIVED_VERSION\n${f.key}\n${scaled.width}x${scaled.height}\n$mime")
            val file = File(derivedDir(context, AssetKind.IMAGE), token)
            if (!file.isFile || file.length() != bytes.size.toLong()) writeAtomic(file, bytes)
            derived[token] = Derived(AssetKind.IMAGE, file, mime, f.name, scaled.width, scaled.height)
            pruneDerived(context, file)
            out.put("url", PreviewServer.assetUrl(token)).put("width", scaled.width).put("height", scaled.height).put("mime", mime).put("derived", true)
            if (encoded == "image/gif") out.put("note", "动图较大，这里显示第一帧。")
        } catch (_: OutOfMemoryError) {
            throw Friendly("preview_image", "这张图片太大，手机内存不够；可以下载后用其他应用打开")
        } finally {
            if (scaled != null && scaled !== upright) scaled.recycle()
            if (upright != null && upright !== raw) upright.recycle()
            raw.recycle()
        }
    }

    /** EXIF 1–8, including the four mirroring orientations. */
    private fun orient(raw: Bitmap, orientation: Int): Bitmap {
        if (orientation == ExifInterface.ORIENTATION_NORMAL || orientation == ExifInterface.ORIENTATION_UNDEFINED) return raw
        val m = Matrix()
        when (orientation) {
            ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> m.postScale(-1f, 1f)
            ExifInterface.ORIENTATION_ROTATE_180 -> m.postRotate(180f)
            ExifInterface.ORIENTATION_FLIP_VERTICAL -> { m.postRotate(180f); m.postScale(-1f, 1f) }
            ExifInterface.ORIENTATION_TRANSPOSE -> { m.postRotate(90f); m.postScale(-1f, 1f) }
            ExifInterface.ORIENTATION_ROTATE_90 -> m.postRotate(90f)
            ExifInterface.ORIENTATION_TRANSVERSE -> { m.postRotate(-90f); m.postScale(-1f, 1f) }
            ExifInterface.ORIENTATION_ROTATE_270 -> m.postRotate(-90f)
            else -> return raw
        }
        return try {
            Bitmap.createBitmap(raw, 0, 0, raw.width, raw.height, m, true)
        } catch (_: OutOfMemoryError) {
            throw Friendly("preview_image", "这张图片太大，手机内存不够；可以下载后用其他应用打开")
        }
    }

    // ─── PDF ──────────────────────────────────────────────────────────────────────────────────────
    /** One more page of a PDF already in the cache ([fetch] with kind pdf). */
    fun page(context: Context, req: JSONObject): JSONObject {
        val key = req.getString("key").also { require(KEY.matches(it)) { "预览已过期" } }
        val m = meta[key] ?: throw Friendly("preview_gone", "预览已过期，重新打开一下")
        if (!m.complete || m.mime != "application/pdf") throw Friendly("preview_gone", "预览已过期，重新打开一下")
        val file = File(folder(context), key)
        if (!file.isFile) throw Friendly("preview_gone", "预览已过期，重新打开一下")
        return pdfPage(context, key, file, req.optInt("page"), req.optInt("width", 1080))
    }

    private fun pdfPage(context: Context, sourceKey: String, file: File, index: Int, width: Int): JSONObject = synchronized(pdfLock) {
        try {
            ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY).use { fd ->
                val r = PdfRenderer(fd)
                try {
                    val n = r.pageCount
                    if (n <= 0) throw Friendly("preview_pdf", "这个 PDF 没有页面")
                    val i = index.coerceIn(0, n - 1)
                    val box = r.openPage(i).use { p -> p.width to p.height }
                    var w = pdfWidth(width, box.first, box.second, pdfPixelCap())
                    var oom = false
                    while (true) {
                        val h = (w.toLong() * box.second / maxOf(1, box.first)).toInt().coerceIn(1, 4 * w)
                        val token = keyFor("pdf-v$PDF_RENDERER_VERSION\n$sourceKey\n$i\n$w")
                        val target = File(derivedDir(context, AssetKind.PAGE), token)
                        val existing = derived[token]
                        if (!oom && existing != null && existing.file.isFile && existing.width == w && existing.height == h) {
                            return@synchronized pageJson(token, w, h, i, n)
                        }
                        try {
                            val page = r.openPage(i)
                            val bmp = try {
                                Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888).also { it.eraseColor(Color.WHITE) }
                            } catch (e: OutOfMemoryError) { page.close(); throw e }
                            val bytes: ByteArray
                            try {
                                page.render(bmp, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
                                bytes = ByteArrayOutputStream().also { bmp.compress(Bitmap.CompressFormat.JPEG, 92, it) }.toByteArray()
                            } finally { bmp.recycle(); page.close() }
                            writeAtomic(target, bytes)
                            derived[token] = Derived(AssetKind.PAGE, target, "image/jpeg", "${nameOf(sourceKey)}-${i + 1}.jpg", w, h, n)
                            pruneDerived(context, target)
                            return@synchronized pageJson(token, w, h, i, n).also { if (oom) it.put("note", "内存不足，已用较低分辨率渲染。") }
                        } catch (_: OutOfMemoryError) {
                            if (oom || w <= 240) throw Friendly("preview_pdf", "这页 PDF 太大，手机内存不够；可以下载后用其他应用打开")
                            oom = true
                            w = maxOf(240, w / 2)
                        }
                    }
                    throw Friendly("preview_pdf", "这页 PDF 渲染不了；可以下载后用其他应用打开")
                } finally { r.close() }
            }
        } catch (e: Friendly) { throw e }
        catch (e: SecurityException) { throw Friendly("preview_pdf", "这个 PDF 有密码，预览不了；可以下载后用其他应用打开") }
        catch (e: Exception) { throw Friendly("preview_pdf", "这个 PDF 打不开预览（可能已损坏）；可以下载后用其他应用打开") }
    }

    private fun pdfWidth(requested: Int, pageW: Int, pageH: Int, cap: Long): Int {
        val wanted = requested.coerceIn(240, PDF_MAX_WIDTH)
        val byPixels = sqrt(cap.toDouble() * pageW / maxOf(1, pageH)).toInt()
        // Keep the 240 px floor and the total-pixel cap at the same time; an extreme page shape is
        // better refused than allocated past the cap.
        if (byPixels < 240) throw Friendly("preview_pdf", "这页 PDF 比例太极端，预览不了；可以下载后用其他应用打开")
        return min(wanted, byPixels)
    }

    private fun pageJson(token: String, w: Int, h: Int, i: Int, n: Int): JSONObject =
        JSONObject().put("url", PreviewServer.pageUrl(token)).put("width", w).put("height", h).put("index", i).put("pages", n)

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
    internal fun nameOf(key: String): String = meta[key]?.name ?: derived[key]?.name ?: key
    internal fun mimeOf(key: String): String = meta[key]?.mime ?: derived[key]?.mime ?: "application/octet-stream"

    // ─── Test hooks (same module instrumentation tests; production paths are unchanged) ───────────
    internal fun registerForTest(key: String, name: String, mime: String, complete: Boolean = true) {
        if (KEY.matches(key)) meta[key] = Meta(name, mime, complete)
    }
    internal fun forgetForTest(token: String) { meta.remove(token); derived.remove(token) }

    // ─── Shared ───────────────────────────────────────────────────────────────────────────────────
    private fun key(device: String, path: String, mtime: Long, size: Long, skip: Long, limit: Long): String =
        keyFor("$device\n$path\n$mtime\n$size\n$skip\n$limit")
    private fun keyFor(text: String): String =
        MessageDigest.getInstance("SHA-1").digest(text.toByteArray()).joinToString("") { "%02x".format(it) }

    /** Oldest first until the folder fits [CACHE_CAP]; [keep] (just read) stays. Stale temp files go too. */
    private fun pruneSource(dir: File, keep: File) {
        val files = dir.listFiles()?.filter { it.isFile }?.toMutableList() ?: return
        val now = System.currentTimeMillis()
        files.filter { it.name.endsWith(".tmp") && now - it.lastModified() > 3_600_000 }.forEach { it.delete(); files.remove(it) }
        var total = files.sumOf { it.length() }
        for (f in files.filter { !it.name.endsWith(".tmp") }.sortedBy { it.lastModified() }) {
            if (total <= CACHE_CAP) break
            if (f == keep) continue
            total -= f.length(); f.delete(); meta.remove(f.name)
        }
    }

    private fun pruneDerived(context: Context, keep: File) {
        val dir = derivedFolder(context)
        val files = dir.walkTopDown().filter { it.isFile }.toMutableList()
        val now = System.currentTimeMillis()
        files.filter { it.name.endsWith(".tmp") && now - it.lastModified() > 3_600_000 }.forEach { it.delete(); files.remove(it) }
        var total = files.sumOf { it.length() }
        for (f in files.sortedBy { it.lastModified() }) {
            if (total <= DERIVED_CAP) break
            if (f == keep) continue
            total -= f.length(); f.delete()
            derived.values.removeIf { it.file == f }
        }
        derived.values.removeIf { !it.file.isFile }
    }

    private fun writeAtomic(file: File, bytes: ByteArray) {
        val tmp = File(file.parentFile, file.name + "." + UUID.randomUUID().toString().take(8) + ".tmp")
        try {
            FileOutputStream(tmp).use { it.write(bytes) }
            if (!tmp.renameTo(file)) { file.delete(); check(tmp.renameTo(file)) { "手机缓存写不进去" } }
        } finally { tmp.delete() }
    }

    private fun deleteTree(file: File) {
        file.listFiles()?.forEach { if (it.isDirectory) deleteTree(it) else it.delete() }
        file.delete()
    }

    private fun lowMemory() = Runtime.getRuntime().maxMemory() < LOW_MEMORY
    private fun pdfPixelCap() = if (lowMemory()) 6_000_000L else PDF_MAX_PIXELS
    private fun mb(n: Long) = if (n >= 1_000_000_000) "%.1f GB".format(n / 1e9) else "${(n + 999_999) / 1_000_000} MB"
}

/** Read-only access to one cached preview copy, only through a per-intent grant (not exported). */
class PreviewFiles : ContentProvider() {
    override fun onCreate() = true
    private fun keyOf(uri: Uri): String {
        if (uri.pathSegments.size != 1) throw SecurityException("bad uri")
        return uri.lastPathSegment ?: throw SecurityException("bad uri")
    }
    private fun fileFor(context: Context, key: String): File? = Previews.fileFor(context, key) ?: MediaPreview.fileFor(context, key)
    private fun fileFor(uri: Uri): File = fileFor(context!!, keyOf(uri)) ?: throw SecurityException("gone")
    private fun displayName(context: Context, key: String): String =
        if (Previews.fileFor(context, key) != null) Previews.nameOf(key) else MediaPreview.nameOf(context, key)
    override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor {
        if (mode != "r") throw SecurityException("read only")
        return ParcelFileDescriptor.open(fileFor(uri), ParcelFileDescriptor.MODE_READ_ONLY)
    }
    override fun getType(uri: Uri): String {
        val key = keyOf(uri)
        return if (Previews.fileFor(context!!, key) != null) Previews.mimeOf(key) else MediaPreview.mimeOf(context!!, key)
    }
    override fun query(uri: Uri, projection: Array<out String>?, selection: String?, args: Array<out String>?, sort: String?): Cursor {
        val file = fileFor(uri)
        return MatrixCursor(arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE)).apply {
            addRow(arrayOf<Any>(displayName(context!!, keyOf(uri)), file.length()))
        }
    }
    override fun insert(uri: Uri, values: ContentValues?): Uri? = null
    override fun delete(uri: Uri, selection: String?, args: Array<out String>?) = 0
    override fun update(uri: Uri, values: ContentValues?, selection: String?, args: Array<out String>?) = 0

    companion object { const val AUTHORITY = "dev.herdr.pocket.preview" }
}
