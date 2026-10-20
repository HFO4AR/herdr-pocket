package dev.herdr.pocket

import android.content.Context
import android.net.Uri
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import java.io.ByteArrayInputStream
import java.io.File
import java.io.FileInputStream
import java.io.IOException
import java.io.InputStream
import java.util.Locale

/**
 * The one local resource route the WebView may load: https://pocket.invalid/preview/…
 *
 * Everything is served from files that [Previews] has already written into the app's private cache
 * and registered, never from a path supplied by the page. The URL is a capability: a 40-hex token
 * that is useless until a completed preview or a rendered derived file exists for it. Only passive
 * image/PDF MIME types are served, with nosniff and no caching; HTML, SVG and scripts are refused.
 *
 * shouldInterceptRequest runs on a WebView worker thread. This object never touches views or the
 * Activity; it opens a bounded FileInputStream and lets WebView consume it.
 */
object PreviewServer {
    const val ORIGIN = "https://pocket.invalid"
    private val TOKEN = Regex("[0-9a-f]{40}")
    private val ASSET_PATH = Regex("^/preview/([0-9a-f]{40})$")
    private val PAGE_PATH = Regex("^/preview/page/([0-9a-f]{40})$")
    private val OFFICE_PATH = Regex("^/preview/office/([0-9a-f]{40})$")
    /** MIME types the page may receive. No text/html, image/svg+xml or script types, ever. */
    private val MIME = setOf(
        "image/jpeg", "image/png", "image/webp", "image/gif", "image/bmp", "image/avif",
        "application/pdf"
    )

    fun assetUrl(token: String) = "$ORIGIN/preview/$token"
    fun pageUrl(token: String) = "$ORIGIN/preview/page/$token"
    fun officeUrl(token: String) = "$ORIGIN/preview/office/$token"

    fun isPreviewUrl(uri: Uri): Boolean = uri.scheme == "https" && uri.host == "pocket.invalid" &&
        (uri.encodedPath ?: "").startsWith("/preview/")

    /**
     * Answers one WebView resource request. GET and HEAD only; one byte range at a time. A missing
     * token, an evicted file, an unregistered key or a disallowed MIME type is 404 (it reveals
     * nothing about the cache), a wrong origin is 403, and any other method is 405.
     */
    fun handle(context: Context, request: WebResourceRequest): WebResourceResponse {
        if (!isPreviewUrl(request.url)) return error(403, "Forbidden")
        val method = request.method.uppercase(Locale.ROOT)
        if (method != "GET" && method != "HEAD") return error(405, "Method Not Allowed", mapOf("Allow" to "GET, HEAD"))
        val path = request.url.encodedPath ?: return error(404, "Not Found")
        val (token, kind) = when {
            ASSET_PATH.matches(path) -> ASSET_PATH.matchEntire(path)!!.groupValues[1] to null
            PAGE_PATH.matches(path) -> PAGE_PATH.matchEntire(path)!!.groupValues[1] to Previews.AssetKind.PAGE
            OFFICE_PATH.matches(path) -> OFFICE_PATH.matchEntire(path)!!.groupValues[1] to Previews.AssetKind.OFFICE
            else -> return error(404, "Not Found")
        }
        if (!TOKEN.matches(token)) return error(404, "Not Found")
        val asset = Previews.assetFor(context, token, kind) ?: return error(404, "Not Found")
        if (asset.mime !in MIME) return error(404, "Not Found")
        val file = asset.file
        if (!file.isFile) return error(404, "Not Found")
        val size = file.length()
        val rangeHeader = request.requestHeaders.entries.firstOrNull { it.key.equals("Range", true) }?.value
        val range = if (rangeHeader.isNullOrBlank()) null else parseRange(rangeHeader, size)
        if (rangeHeader != null && range == null) return error(416, "Range Not Satisfiable", mapOf(
            "Content-Range" to "bytes */$size", "Accept-Ranges" to "bytes"
        ), body = false)
        val start = range?.start ?: 0L
        val end = range?.end ?: (size - 1)
        val length = if (size == 0L) 0L else end - start + 1
        val headers = (baseHeaders(asset.mime, length) + mapOf("Accept-Ranges" to "bytes")).toMutableMap()
        if (range != null) headers["Content-Range"] = "bytes $start-$end/$size"
        val status = if (range == null) 200 else 206
        val phrase = if (status == 200) "OK" else "Partial Content"
        if (method == "HEAD") return WebResourceResponse(asset.mime, null, status, phrase, headers, ByteArrayInputStream(ByteArray(0)))
        val data = try { bounded(file, start, length) } catch (_: IOException) { return error(404, "Not Found") }
        return WebResourceResponse(asset.mime, null, status, phrase, headers, data)
    }

    private fun baseHeaders(mime: String, length: Long): MutableMap<String, String> = mutableMapOf(
        "Content-Type" to mime,
        "Content-Length" to length.toString(),
        "Cache-Control" to "no-store",
        "X-Content-Type-Options" to "nosniff",
        "Content-Disposition" to "inline"
    )

    private fun error(code: Int, reason: String, extra: Map<String, String> = emptyMap(), body: Boolean = true): WebResourceResponse {
        val bytes = if (body) reason.toByteArray() else ByteArray(0)
        return WebResourceResponse("text/plain", "UTF-8", code, reason, (baseHeaders("text/plain", bytes.size.toLong()) + extra).toMutableMap(),
            ByteArrayInputStream(bytes))
    }

    private class Span(val start: Long, val end: Long)

    /** null = malformed or unsatisfiable (416). Multiple ranges are deliberately not supported. */
    private fun parseRange(header: String, size: Long): Span? {
        val raw = header.trim()
        if (!raw.startsWith("bytes=", ignoreCase = true) || raw.contains(',')) return null
        val value = raw.substring(6).trim()
        val m = Regex("^(\\d*)-(\\d*)$").matchEntire(value) ?: return null
        val a = m.groupValues[1]
        val b = m.groupValues[2]
        if (a.isEmpty() && b.isEmpty()) return null
        if (size <= 0L) return null
        if (a.isEmpty()) {
            val suffix = b.toLongOrNull() ?: return null
            if (suffix <= 0L) return null
            return Span(maxOf(0L, size - suffix), size - 1)
        }
        val start = a.toLongOrNull() ?: return null
        if (start >= size) return null
        val end = if (b.isEmpty()) size - 1 else (b.toLongOrNull() ?: return null)
        if (end < start) return null
        return Span(start, minOf(end, size - 1))
    }

    /** Open at [start], expose exactly [length] bytes and never read (or allocate) the whole file. */
    private fun bounded(file: File, start: Long, length: Long): InputStream {
        val input = FileInputStream(file)
        try {
            var left = start
            while (left > 0) {
                val n = input.skip(left)
                if (n > 0) left -= n else if (input.read() < 0) throw IOException("short file") else left--
            }
            return Limited(input, length)
        } catch (e: Throwable) {
            input.close(); throw e
        }
    }

    private class Limited(private val input: FileInputStream, private var left: Long) : InputStream() {
        override fun read(): Int {
            if (left <= 0) return -1
            val b = input.read()
            if (b >= 0) left--
            return b
        }
        override fun read(b: ByteArray, off: Int, len: Int): Int {
            if (left <= 0) return -1
            val n = input.read(b, off, minOf(len.toLong(), left).toInt())
            if (n > 0) left -= n
            return n
        }
        override fun close() = input.close()
    }
}
