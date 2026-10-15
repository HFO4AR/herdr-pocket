package dev.herdr.pocket

import android.content.ContentResolver
import android.net.Uri
import android.provider.OpenableColumns
import org.json.JSONObject
import java.io.FilterInputStream
import java.io.InputStream
import java.security.MessageDigest
import java.text.Normalizer
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

/** A document picked with the system file picker. Its bytes are only read while uploading. */
class Picked(val id: String, val uri: Uri, val name: String, val size: Long, val mime: String)

/**
 * Files attached to a message. Only an id, the name and the size reach the WebView; the bytes are
 * streamed from the content URI straight into SFTP and hashed on the way.
 */
object FileAttach {
    const val MAX_BYTES = 25_000_000L
    const val MAX_FILES = 4
    private const val MAX_NAME_BYTES = 120
    private const val KEEP = 16

    private val picked = ConcurrentHashMap<String, Picked>()
    private val order = ArrayDeque<String>()

    fun get(id: String): Picked? = picked[id]
    fun drop(id: String) { picked.remove(id); synchronized(order) { order.remove(id) } }

    /** Reads name and size from the provider; refuses files that are too big before any upload. */
    fun describe(resolver: ContentResolver, uri: Uri): Picked {
        var name: String? = null
        var size = -1L
        resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { c ->
            if (c.moveToFirst()) {
                c.getColumnIndex(OpenableColumns.DISPLAY_NAME).takeIf { it >= 0 && !c.isNull(it) }?.let { name = c.getString(it) }
                c.getColumnIndex(OpenableColumns.SIZE).takeIf { it >= 0 && !c.isNull(it) }?.let { size = c.getLong(it) }
            }
        }
        val clean = safeName(name ?: uri.lastPathSegment)
        check(size <= MAX_BYTES) { "「$clean」超过 25 MB" }
        val p = Picked(UUID.randomUUID().toString(), uri, clean, size, resolver.getType(uri) ?: "")
        picked[p.id] = p
        synchronized(order) {
            order.addLast(p.id)
            while (order.size > KEEP) picked.remove(order.removeFirst())
        }
        return p
    }

    fun describe(p: Picked): JSONObject = JSONObject().put("id", p.id).put("name", p.name).put("size", p.size).put("mime", p.mime)

    /**
     * One visible path segment the bridge accepts: no separators, control, format (bidi, zero
     * width) or line-separator characters, no leading dot or space, at most 120 UTF-8 bytes with
     * the extension kept. Must stay within the bridge's file_name_ok.
     */
    fun safeName(raw: String?): String {
        val text = Normalizer.normalize(raw ?: "", Normalizer.Form.NFC)
        val out = StringBuilder()
        var i = 0
        while (i < text.length) {
            val cp = text.codePointAt(i); i += Character.charCount(cp)
            val type = Character.getType(cp).toByte()
            when {
                cp == '/'.code || cp == '\\'.code -> out.append('_')
                cp == '\t'.code || cp == '\n'.code || cp == '\r'.code || type == Character.LINE_SEPARATOR || type == Character.PARAGRAPH_SEPARATOR -> out.append(' ')
                type == Character.CONTROL || type == Character.FORMAT || type == Character.SURROGATE || type == Character.PRIVATE_USE -> Unit
                else -> out.appendCodePoint(cp)
            }
        }
        var name = out.toString().replace(Regex("\\s+"), " ").trimStart { it == '.' || it.isWhitespace() }.trimEnd()
        val dot = name.lastIndexOf('.')
        val ext = if (dot > 0 && name.length - dot in 2..17) name.substring(dot) else ""
        var stem = name.removeSuffix(ext).trim()
        if (stem.isEmpty()) stem = "文件"
        while ((stem + ext).toByteArray().size > MAX_NAME_BYTES && stem.isNotEmpty()) {
            stem = stem.substring(0, stem.offsetByCodePoints(stem.length, -1)).trimEnd()
        }
        name = (stem.ifEmpty { "文件" } + ext).trim()
        return name
    }

    /** Hashes, counts and limits whatever is read through it; reports progress at most every 250 ms. */
    class Hashing(source: InputStream, private val progress: (Long) -> Unit) : FilterInputStream(source) {
        val digest: MessageDigest = MessageDigest.getInstance("SHA-256")
        var count = 0L
            private set
        private var told = 0L
        override fun read(): Int {
            val b = super.read()
            if (b >= 0) { digest.update(b.toByte()); seen(1) }
            return b
        }
        override fun read(b: ByteArray, off: Int, len: Int): Int {
            val n = super.read(b, off, len)
            if (n > 0) { digest.update(b, off, n); seen(n) }
            return n
        }
        private fun seen(n: Int) {
            count += n
            check(count <= MAX_BYTES) { "文件超过 25 MB" }
            val now = System.nanoTime()
            if (now - told > 250_000_000L) { told = now; progress(count) }
        }
        fun hex() = digest.digest().joinToString("") { "%02x".format(it) }
    }
}
