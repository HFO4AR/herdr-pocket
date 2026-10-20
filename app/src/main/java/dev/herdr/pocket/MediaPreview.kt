package dev.herdr.pocket

import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.os.StatFs
import android.util.Base64
import com.jcraft.jsch.SftpProgressMonitor
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean

/**
 * 文件 → 视频/音频: caches one complete remote file over the computer's own SFTP session into a
 * separate private folder (`cacheDir/media-preview`), then hands the page a small, local description.
 *
 * · Only a complete copy is ever handed out: the file is read into a temporary name, its byte count is
 *   checked against the size SFTP reported, and only then renamed into place.
 * · The cache has its own quota ([CACHE_CAP], 1 GB), separate from [Previews]. Least-recently-used
 *   complete files are evicted unless pinned; a file being played is pinned by [PlayerActivity], so a
 *   prune or 清除缓存 never pulls it out from under the player.
 * · Metadata and embedded artwork come from [MediaMetadataRetriever] on the phone. The poster is a
 *   small JPEG (≤ [POSTER_EDGE] px) kept next to the media file; the page receives it as a `data:`
 *   URL, which keeps this path independent of the (concurrent) preview resource channel. When the
 *   preview server lands, this can switch to `https://pocket.invalid/preview/<posterKey>` without
 *   changing anything else.
 * · A JSON sidecar next to each file keeps the original name/MIME/metadata across process death; if
 *   that is lost too, the file name keeps the original extension so MIME still resolves.
 * · v1 downloads the whole file first (no streaming, no background audio, no PiP, no subtitles).
 */
object MediaPreview {
    /** Media above this asks first (mobile data, phone storage); mirrors FX_MEDIA_MAX in sftp.js. */
    const val CONFIRM_MAX = 20_000_000L
    /** Hard ceiling for one cached media file (and the whole cache quota). */
    const val HARD_MAX = 1_000_000_000L
    const val CACHE_CAP = 1_000_000_000L
    private const val SPACE_MARGIN = 32_000_000L
    private const val POSTER_EDGE = 512
    private const val POSTER_QUALITY = 80
    private val KEY = Regex("[0-9a-f]{40}")
    private val AUDIO_EXT = setOf("mp3", "m4a", "aac", "wav", "flac", "ogg", "oga", "opus", "wma", "amr", "mid", "midi", "aiff", "aif", "ape", "mka")

    private class Fetched(val key: String, val file: File, val size: Long, val mtime: Long, val name: String, val mime: String, val cached: Boolean, val path: String, val device: String)
    private val stops = ConcurrentHashMap<String, AtomicBoolean>()
    private val pinned = ConcurrentHashMap.newKeySet<String>()

    fun folder(context: Context) = File(context.cacheDir, "media-preview").apply { mkdirs() }

    /** Marks [token] cancelled; a fetch still reading stops at its next block and keeps nothing. */
    fun cancel(token: String) {
        if (token.isEmpty() || token.length > 80) return
        stops.getOrPut(token) { AtomicBoolean() }.set(true)
        while (stops.size > 200) stops.keys.firstOrNull()?.let { stops.remove(it) }
    }

    /** Removes unpinned media, sidecars and posters. A file being played stays until it is released. */
    fun clear(context: Context) {
        folder(context).listFiles()?.forEach { f ->
            val owner = ownerKey(f.name)
            if (owner == null || !isPinned(owner)) f.delete()
        }
    }

    /** A file being played: prune/clear leave it (and its sidecar/poster) alone. */
    fun pin(key: String) { if (KEY.matches(key)) pinned.add(key) }
    fun unpin(key: String) { pinned.remove(key) }
    fun isPinned(key: String): Boolean = pinned.contains(key)

    fun fileFor(context: Context, key: String): File? = if (KEY.matches(key)) keyFile(folder(context), key) else null

    fun posterFor(context: Context, key: String): File? = if (KEY.matches(key)) posterFile(folder(context), key).takeIf { it.isFile } else null

    /** Cached description from the sidecar; falls back to the file extension when the sidecar is gone. */
    fun meta(context: Context, key: String): JSONObject? {
        readSidecar(context, key)?.let { return it }
        val file = fileFor(context, key) ?: return null
        val name = fileName(file, key)
        val mime = Transfers.mimeOf(name)
        return JSONObject().put("name", name).put("mime", mime).put("size", file.length())
    }

    fun nameOf(context: Context, key: String): String = meta(context, key)?.optString("name")?.takeIf { it.isNotBlank() } ?: key

    fun mimeOf(context: Context, key: String): String =
        meta(context, key)?.optString("mime")?.takeIf { it.isNotBlank() && it != "application/octet-stream" } ?: "application/octet-stream"

    /**
     * Reads the whole file into the media cache and returns its description. Progress is reported
     * as real byte counts through the request's normal progress channel.
     */
    fun open(context: Context, device: String, req: JSONObject, progress: (Long) -> Unit): JSONObject {
        val path = req.getString("path")
        require(path.startsWith("/") && path.indexOf('\u0000') < 0) { "路径不对" }
        val token = req.optString("token").take(80)
        val stop = if (token.isEmpty()) AtomicBoolean() else stops.getOrPut(token) { AtomicBoolean() }
        val name = SftpPath.cleanName(SftpPath.base(path))
        val mime = Transfers.mimeOf(name)
        val dir = folder(context)
        val deviceId = PocketCore.linkInfo(device).first
        try {
            val got = PocketCore.sftp(device) { sftp, _ ->
                val a = sftp.stat(SftpPath.q(path))
                if (!a.isReg) throw Friendly("sftp_not_file", "只能缓存普通文件")
                val size = a.size
                val mtime = a.mTime.toLong() and 0xffffffffL
                val k = key(deviceId, path, mtime, size)
                val existing = keyFile(dir, k)
                val cached = existing != null && existing.length() == size
                // A complete cache hit needs no size confirmation and no second download.
                if (!cached && size > HARD_MAX)
                    throw Friendly("media_large", "文件有 ${mb(size)}，超过 1 GB 的播放上限；可以下载后用其他应用打开",
                        JSONObject().put("size", size).put("max", HARD_MAX).put("hard", true))
                if (!cached && size > CONFIRM_MAX && !req.optBoolean("allowLarge"))
                    throw Friendly("media_large", "文件有 ${mb(size)}，要先把整份缓存到手机才能播放",
                        JSONObject().put("size", size).put("max", CONFIRM_MAX))
                val file = if (cached) existing!! else File(dir, fileNameFor(k, name))
                if (!cached) {
                    // Make room under the quota first, then check the phone's free space for this copy alone.
                    prune(context, null)
                    val free = freeBytes(context)
                    if (free in 0 until size + SPACE_MARGIN)
                        throw Friendly("media_space", "手机空间不够：要缓存 ${mb(size)}，App 缓存区只剩 ${mb(free)}。可以先清理手机空间或清除缓存。")
                    val tmp = File(dir, "$k.${UUID.randomUUID().toString().take(8)}.tmp")
                    try {
                        var count = 0L
                        var last = 0L
                        FileOutputStream(tmp).use { out ->
                            sftp.get(SftpPath.q(path), null as SftpProgressMonitor?, 0).use { input ->
                                val buf = ByteArray(64 * 1024)
                                while (count < size) {
                                    if (stop.get()) throw Friendly("preview_cancelled", "已取消")
                                    val n = input.read(buf, 0, minOf(buf.size.toLong(), size - count).toInt())
                                    if (n < 0) break
                                    out.write(buf, 0, n); count += n
                                    val now = System.currentTimeMillis()
                                    if (now - last >= 120) { last = now; progress(count) }
                                }
                            }
                        }
                        if (count != size) throw Friendly("sftp_short", "只读到 $count / $size 字节，文件可能正在变")
                        progress(count)
                        if (!tmp.renameTo(file)) { file.delete(); check(tmp.renameTo(file)) { "手机缓存写不进去" } }
                    } finally { tmp.delete() }
                } else file.setLastModified(System.currentTimeMillis())
                Fetched(k, file, size, mtime, name, mime, cached, path, deviceId)
            }
            prune(context, got.file)
            // A cache hit reuses the sidecar: metadata/artwork extraction can be slow on a large video.
            val cachedSide = readSidecar(context, got.key)
            val media = cachedSide?.optJSONObject("media") ?: analyze(got.file, got.name)
            if (cachedSide == null) {
                val side = JSONObject().put("name", got.name).put("mime", got.mime).put("size", got.size).put("mtime", got.mtime)
                    .put("path", got.path).put("device", got.device).put("media", media)
                writeSidecar(context, got.key, side)
            }
            // A poster is optional: no artwork, an unsupported container or a retriever failure is fine.
            val hasPoster = posterFor(context, got.key) != null ||
                try { writePoster(context, got.key, got.file, media.optString("kind", "video")) } catch (_: Throwable) { false }
            val out = JSONObject().put("key", got.key).put("name", got.name).put("mime", got.mime).put("size", got.size).put("mtime", got.mtime)
                .put("cached", got.cached).put("complete", true).put("path", got.path).put("media", media)
            if (hasPoster) posterData(context, got.key)?.let { out.put("poster", it) }
            return out
        } finally { if (token.isNotEmpty()) stops.remove(token) }
    }

    /**
     * Duration, dimensions, rotation and tags. Missing values are simply absent: a WAV has no video
     * size, an MP3 may have no artist, and a broken container must not fail the cache operation.
     */
    fun analyze(file: File, name: String): JSONObject {
        val kind = kindOf(name, Transfers.mimeOf(name))
        val out = JSONObject().put("kind", kind)
        val retriever = MediaMetadataRetriever()
        try {
            retriever.setDataSource(file.path)
            fun number(key: Int): Int? = retriever.extractMetadata(key)?.trim()?.toIntOrNull()
            fun text(key: Int, max: Int): String? = retriever.extractMetadata(key)?.trim()?.takeIf { it.isNotEmpty() }?.take(max)
            number(MediaMetadataRetriever.METADATA_KEY_DURATION)?.takeIf { it >= 0 }?.let { out.put("durationMs", it.toLong()) }
            number(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH)?.takeIf { it > 0 }?.let { out.put("width", it) }
            number(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT)?.takeIf { it > 0 }?.let { out.put("height", it) }
            number(MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION)?.let { out.put("rotation", ((it % 360) + 360) % 360) }
            text(MediaMetadataRetriever.METADATA_KEY_TITLE, 300)?.let { out.put("title", it) }
            text(MediaMetadataRetriever.METADATA_KEY_ARTIST, 300)?.let { out.put("artist", it) }
            text(MediaMetadataRetriever.METADATA_KEY_ALBUM, 300)?.let { out.put("album", it) }
            text(MediaMetadataRetriever.METADATA_KEY_MIMETYPE, 100)?.let { out.put("container", it) }
        } catch (_: Exception) {
            // Metadata is presentation only. Playback may still work (some containers have no tags).
        } finally { try { retriever.release() } catch (_: Exception) { } }
        return out
    }

    /** External ACTION_VIEW / ACTION_SEND for a complete cached file, through [PreviewFiles]. */
    fun intent(context: Context, key: String, share: Boolean): Intent {
        require(KEY.matches(key)) { "预览已过期" }
        if (fileFor(context, key) == null) throw Friendly("preview_gone", "预览已过期，重新打开一下")
        val name = nameOf(context, key)
        val mime = mimeOf(context, key).let { if (it == "application/octet-stream") Transfers.mimeOf(name) else it }
        val uri = Uri.parse("content://${PreviewFiles.AUTHORITY}/$key")
        return if (share) Intent.createChooser(Intent(Intent.ACTION_SEND).setType(mime).putExtra(Intent.EXTRA_STREAM, uri).putExtra(Intent.EXTRA_TITLE, name)
            .apply { clipData = android.content.ClipData.newRawUri(name, uri) }
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION), "分享「$name」")
        else Intent(Intent.ACTION_VIEW).setDataAndType(uri, mime).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
    }

    fun playerIntent(context: Context, key: String): Intent {
        require(KEY.matches(key)) { "预览已过期" }
        if (fileFor(context, key) == null) throw Friendly("preview_gone", "缓存已过期，重新打开一下")
        return Intent(context, PlayerActivity::class.java).putExtra(PlayerActivity.EXTRA_KEY, key)
    }

    fun kindOf(name: String, mime: String): String =
        if (name.substringAfterLast('.', "").lowercase() in AUDIO_EXT || mime.startsWith("audio/")) "audio" else "video"

    // ─── Cache layout: <key>[.<ext>] is the file, <key>.json its sidecar, poster-<key>.jpg the art ───
    private fun keyFile(dir: File, key: String): File? {
        File(dir, key).takeIf { it.isFile }?.let { return it }
        return dir.listFiles()?.firstOrNull { f -> f.isFile && f.name.startsWith("$key.") && mediaKeyOf(f.name) != null }
    }

    private fun fileNameFor(key: String, name: String): String {
        val ext = name.substringAfterLast('.', "").lowercase().filter { it.isLetterOrDigit() }.take(12)
        return if (ext.isEmpty()) key else "$key.$ext"
    }

    /** The original base name is gone with the sidecar; keep the extension at least for the MIME type. */
    private fun fileName(file: File, key: String): String = if (file.name == key) key else SftpPath.cleanName(file.name)

    private fun sidecarFile(dir: File, key: String) = File(dir, "$key.json")
    private fun posterFile(dir: File, key: String) = File(dir, "poster-$key.jpg")

    private fun readSidecar(context: Context, key: String): JSONObject? = try {
        val f = sidecarFile(folder(context), key)
        if (f.isFile) JSONObject(f.readText()) else null
    } catch (_: Exception) { null }

    private fun writeSidecar(context: Context, key: String, meta: JSONObject) {
        val dir = folder(context)
        val tmp = File(dir, "$key.json.tmp")
        try {
            tmp.writeText(meta.toString())
            val target = sidecarFile(dir, key)
            if (!tmp.renameTo(target)) { target.delete(); check(tmp.renameTo(target)) { "手机缓存写不进去" } }
        } finally { tmp.delete() }
    }

    private fun writePoster(context: Context, key: String, file: File, kind: String): Boolean {
        val retriever = MediaMetadataRetriever()
        var source: Bitmap? = null
        try {
            retriever.setDataSource(file.path)
            val embedded = try { retriever.embeddedPicture } catch (_: Exception) { null }
            if (embedded != null) {
                val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                BitmapFactory.decodeByteArray(embedded, 0, embedded.size, bounds)
                var sample = 1
                while (maxOf(bounds.outWidth, bounds.outHeight) / (sample * 2) >= POSTER_EDGE) sample *= 2
                source = BitmapFactory.decodeByteArray(embedded, 0, embedded.size, BitmapFactory.Options().apply { inSampleSize = sample })
            } else if (kind == "video") {
                source = retriever.getFrameAtTime(0, MediaMetadataRetriever.OPTION_CLOSEST_SYNC)
            }
        } catch (_: Exception) { } finally { try { retriever.release() } catch (_: Exception) { } }
        val src = source ?: return false
        try { return posterFromBitmap(context, key, src) } finally { src.recycle() }
    }

    /** Writes a ≤ [POSTER_EDGE] JPEG poster for [key]; the caller keeps ownership of [bitmap]. */
    fun posterFromBitmap(context: Context, key: String, bitmap: Bitmap): Boolean {
        require(KEY.matches(key)) { "预览已过期" }
        val dir = folder(context)
        var scaled: Bitmap? = null
        try {
            val scale = minOf(1f, POSTER_EDGE.toFloat() / maxOf(1, maxOf(bitmap.width, bitmap.height)))
            val out = if (scale < 1f)
                Bitmap.createScaledBitmap(bitmap, (bitmap.width * scale).toInt().coerceAtLeast(1), (bitmap.height * scale).toInt().coerceAtLeast(1), true).also { scaled = it }
            else bitmap
            val tmp = File(dir, "poster-$key.tmp")
            try {
                FileOutputStream(tmp).use { out.compress(Bitmap.CompressFormat.JPEG, POSTER_QUALITY, it) }
                val target = posterFile(dir, key)
                if (!tmp.renameTo(target)) { target.delete(); check(tmp.renameTo(target)) { "封面写不进去" } }
            } finally { tmp.delete() }
            return posterFile(dir, key).isFile && posterFile(dir, key).length() > 0
        } finally { scaled?.recycle() }
    }

    private fun posterData(context: Context, key: String): String? = try {
        val f = posterFor(context, key) ?: return null
        "data:image/jpeg;base64," + Base64.encodeToString(f.readBytes(), Base64.NO_WRAP)
    } catch (_: Exception) { null }

    // ─── Shared ───────────────────────────────────────────────────────────────────────────────────
    private fun key(device: String, path: String, mtime: Long, size: Long): String =
        MessageDigest.getInstance("SHA-1").digest("$device\n$path\n$mtime\n$size".toByteArray()).joinToString("") { "%02x".format(it) }

    /** The 40-hex key of a media file, including `<key>.<ext>`; sidecars/posters are not media files. */
    private fun mediaKeyOf(name: String): String? {
        if (KEY.matches(name)) return name
        if (name.length > 41 && name[40] == '.' && !name.endsWith(".json")) {
            val head = name.take(40)
            if (KEY.matches(head)) return head
        }
        return null
    }

    private fun ownerKey(name: String): String? = when {
        name.startsWith("poster-") && name.endsWith(".jpg") -> name.removePrefix("poster-").removeSuffix(".jpg").takeIf { KEY.matches(it) }
        name.endsWith(".json") -> name.removeSuffix(".json").takeIf { KEY.matches(it) }
        else -> mediaKeyOf(name)
    }

    /** Oldest first until the folder fits [cap]; [keep] (just read) and pinned files always stay. */
    private fun prune(context: Context, keep: File?, cap: Long = CACHE_CAP) {
        val dir = folder(context)
        val files = dir.listFiles()?.toMutableList() ?: return
        val now = System.currentTimeMillis()
        files.filter { it.name.endsWith(".tmp") && now - it.lastModified() > 3_600_000 }.forEach { it.delete(); files.remove(it) }
        // Drop orphan sidecars/posters whose media file is already gone.
        for (f in files.toList()) {
            if (mediaKeyOf(f.name) != null) continue
            val owner = ownerKey(f.name) ?: continue
            if (keyFile(dir, owner) == null) { f.delete(); files.remove(f) }
        }
        var total = files.sumOf { it.length() }
        for (f in files.filter { mediaKeyOf(it.name) != null }.sortedBy { it.lastModified() }) {
            if (total <= cap) break
            val k = mediaKeyOf(f.name) ?: continue
            if ((keep != null && f.absolutePath == keep.absolutePath) || isPinned(k)) continue
            total -= f.length(); f.delete()
            sidecarFile(dir, k).takeIf { it.isFile }?.let { total -= it.length(); it.delete() }
            posterFile(dir, k).takeIf { it.isFile }?.let { total -= it.length(); it.delete() }
        }
    }

    /** Test hook: run the real LRU eviction with a small quota. Pinned files are never evicted. */
    fun pruneForTest(context: Context, cap: Long) = prune(context, null, cap)

    private fun freeBytes(context: Context): Long = try { StatFs(context.cacheDir.path).availableBytes } catch (_: Exception) { -1 }
    private fun mb(n: Long) = if (n >= 1_000_000_000) "%.1f GB".format(n / 1e9) else "${(n + 999_999) / 1_000_000} MB"
}
