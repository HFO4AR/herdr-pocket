package dev.herdr.pocket

import android.app.Activity
import android.app.Instrumentation
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.Paint
import android.graphics.pdf.PdfDocument
import android.net.Uri
import android.view.View
import android.view.ViewGroup
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Phase 1 native preview checks, no SSH required:
 *  · PreviewServer: origin/method/token authorization, MIME allowlist, exact bytes and byte ranges.
 *  · PDF: a real PdfDocument rendered at a high width, bounded pixels, served as a page JPEG URL.
 */
object PreviewTests {
    private fun check(ok: Boolean, what: () -> String) { if (!ok) throw AssertionError(what()) }

    fun server(context: Context): String {
        val key = "a".repeat(40)
        val bytes = ByteArray(64) { it.toByte() }
        val noise = "b".repeat(40)
        fun request(path: String, method: String = "GET", range: String? = null) =
            Request(Uri.parse("https://pocket.invalid$path"), method, range?.let { mapOf("Range" to it) } ?: emptyMap())
        try {
            Previews.clear(context)
            File(Previews.folder(context), key).writeBytes(bytes)
            Previews.registerForTest(key, "picture.png", "image/png")
            val full = PreviewServer.handle(context, request("/preview/$key"))
            check(full.statusCode == 200 && full.mimeType == "image/png") { "full ${full.statusCode} ${full.mimeType}" }
            check(read(full).contentEquals(bytes)) { "full body differs" }
            check(header(full, "Content-Length") == "64" && header(full, "Accept-Ranges") == "bytes") { "full length/range ${full.responseHeaders}" }
            check(header(full, "Cache-Control") == "no-store" && header(full, "X-Content-Type-Options") == "nosniff" &&
                header(full, "Content-Disposition") == "inline") { "security headers ${full.responseHeaders}" }
            check(header(full, "Content-Range") == null) { "200 must not carry Content-Range" }

            val head = PreviewServer.handle(context, request("/preview/$key", "HEAD"))
            check(head.statusCode == 200 && read(head).isEmpty() && header(head, "Content-Length") == "64") { "HEAD ${head.statusCode} ${header(head, "Content-Length")}" }

            val range = PreviewServer.handle(context, request("/preview/$key", range = "bytes=10-19"))
            check(range.statusCode == 206 && read(range).contentEquals(bytes.copyOfRange(10, 20))) { "range body" }
            check(header(range, "Content-Range") == "bytes 10-19/64" && header(range, "Content-Length") == "10") { "range headers ${range.responseHeaders}" }
            check(read(PreviewServer.handle(context, request("/preview/$key", range = "bytes=60-"))).contentEquals(bytes.copyOfRange(60, 64))) { "open range" }
            check(read(PreviewServer.handle(context, request("/preview/$key", range = "bytes=-5"))).contentEquals(bytes.copyOfRange(59, 64))) { "suffix range" }
            check(header(PreviewServer.handle(context, request("/preview/$key", range = "bytes=50-999")), "Content-Range") == "bytes 50-63/64") { "clamped range" }
            val bad = PreviewServer.handle(context, request("/preview/$key", range = "bytes=64-"))
            check(bad.statusCode == 416 && header(bad, "Content-Range") == "bytes */64") { "unsatisfiable ${bad.statusCode}" }
            check(PreviewServer.handle(context, request("/preview/$key", range = "bytes=0-1,4-5")).statusCode == 416) { "multi range accepted" }
            val headRange = PreviewServer.handle(context, request("/preview/$key", "HEAD", "bytes=2-5"))
            check(headRange.statusCode == 206 && read(headRange).isEmpty() && header(headRange, "Content-Length") == "4") { "HEAD range" }

            val post = PreviewServer.handle(context, request("/preview/$key", "POST"))
            check(post.statusCode == 405 && header(post, "Allow") == "GET, HEAD") { "POST ${post.statusCode}" }
            check(PreviewServer.handle(context, Request(Uri.parse("https://example.invalid/preview/$key"))).statusCode == 403) { "wrong host" }
            check(PreviewServer.handle(context, Request(Uri.parse("http://pocket.invalid/preview/$key"))).statusCode == 403) { "http accepted" }
            check(PreviewServer.handle(context, request("/preview/${"9".repeat(39)}")).statusCode == 404) { "short token" }
            check(PreviewServer.handle(context, request("/preview/${"9".repeat(40)}")).statusCode == 404) { "unknown token" }
            check(PreviewServer.handle(context, request("/preview/page/$key")).statusCode == 404) { "source served as page" }

            // Existing cache file is not enough: metadata must authorize every request.
            File(Previews.folder(context), noise).writeBytes(bytes)
            check(PreviewServer.handle(context, request("/preview/$noise")).statusCode == 404) { "unregistered file served" }
            Previews.registerForTest(noise, "evil.html", "text/html")
            check(PreviewServer.handle(context, request("/preview/$noise")).statusCode == 404) { "text/html served" }
            Previews.registerForTest(noise, "evil.svg", "image/svg+xml")
            check(PreviewServer.handle(context, request("/preview/$noise")).statusCode == 404) { "SVG served" }
            Previews.registerForTest(noise, "ok.png", "image/png", complete = false)
            check(PreviewServer.handle(context, request("/preview/$noise")).statusCode == 404) { "incomplete source served" }
        } finally {
            Previews.clear(context)
        }
        return "PASS"
    }

    fun pdf(context: Context): String {
        val key = "d".repeat(40)
        val file = File(Previews.folder(context), key)
        try {
            Previews.clear(context)
            val doc = PdfDocument()
            val page = doc.startPage(PdfDocument.PageInfo.Builder(600, 800, 1).create())
            page.canvas.drawColor(Color.WHITE)
            page.canvas.drawText("Herdr Pocket PDF", 40f, 80f, Paint().apply { color = Color.BLACK; textSize = 24f })
            doc.finishPage(page)
            FileOutputStream(file).use { doc.writeTo(it) }
            doc.close()
            Previews.registerForTest(key, "report.pdf", "application/pdf", true)
            val pageJson = Previews.page(context, JSONObject().put("key", key).put("page", 0).put("width", 99999))
            val url = pageJson.getString("url")
            check(url.startsWith(PreviewServer.pageUrl("")) && Regex("/preview/page/[0-9a-f]{40}$").containsMatchIn(url)) { "PDF page URL: $url" }
            val width = pageJson.getInt("width")
            val height = pageJson.getInt("height")
            check(width in 1601..Previews.PDF_MAX_WIDTH) { "PDF width $width" }
            check(width.toLong() * height <= Previews.PDF_MAX_PIXELS) { "PDF pixels ${width}x$height exceed cap" }
            check(pageJson.getInt("index") == 0 && pageJson.getInt("pages") == 1) { "PDF page metadata: $pageJson" }
            val r = PreviewServer.handle(context, Request(Uri.parse(url)))
            check(r.statusCode == 200 && r.mimeType == "image/jpeg") { "page response ${r.statusCode} ${r.mimeType}" }
            val jpeg = read(r)
            check(jpeg.size > 1000 && jpeg[0] == 0xFF.toByte() && jpeg[1] == 0xD8.toByte()) { "not a JPEG: ${jpeg.size}" }
            check(header(r, "Content-Type") == "image/jpeg" && header(r, "X-Content-Type-Options") == "nosniff") { "page headers ${r.responseHeaders}" }
            val again = Previews.page(context, JSONObject().put("key", key).put("page", 0).put("width", 99999))
            check(again.getString("url") == url) { "derived page URL is not stable" }
        } finally {
            Previews.clear(context)
        }
        return "PASS"
    }

    /**
     * The Phase 1 integration gate, in the real WebView: blockNetworkLoads=true must still deliver a
     * pocket.invalid/preview subresource through shouldInterceptRequest, and the CSP must accept it.
     * Returns SKIPPED only when a WebView cannot be created at all in this instrumentation process;
     * a WebView that loads but shows no image is a real failure.
     */
    fun webView(context: Context, instrumentation: Instrumentation): String {
        val key = "e".repeat(40)
        var activity: Activity? = null
        try {
            Previews.clear(context)
            val bitmap = Bitmap.createBitmap(48, 32, Bitmap.Config.ARGB_8888).apply { eraseColor(Color.rgb(40, 120, 90)) }
            FileOutputStream(File(Previews.folder(context), key)).use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
            bitmap.recycle()
            Previews.registerForTest(key, "probe.png", "image/png")
            activity = try {
                instrumentation.startActivitySync(Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            } catch (_: Throwable) { return "SKIPPED (MainActivity unavailable)" }
            var web: WebView? = null
            instrumentation.runOnMainSync { web = findWeb(activity!!.window.decorView) }
            val view = web ?: return "SKIPPED (WebView unavailable)"
            // The real app page: default-src 'none', img-src https://pocket.invalid, blockNetworkLoads=true.
            var ready = false
            for (i in 0 until 80) {
                if (evaluate(instrumentation, view, "document.readyState") == "complete") { ready = true; break }
                Thread.sleep(100)
            }
            check(ready) { "app page did not finish loading" }
            val js = "window.__probeCsp=[];" +
                "document.addEventListener('securitypolicyviolation',function(e){window.__probeCsp.push(e.violatedDirective)});" +
                "window.__probeW=0;window.__probeErr='';" +
                "var im=new Image();im.onload=function(){window.__probeW=im.naturalWidth};" +
                "im.onerror=function(){window.__probeErr='load'};im.src='${PreviewServer.assetUrl(key)}';1"
            check(evaluate(instrumentation, view, js)?.toIntOrNull() == 1) { "probe script did not run" }
            for (i in 0 until 80) {
                val n = evaluate(instrumentation, view, "window.__probeW||0")?.toIntOrNull() ?: 0
                if (n > 0) {
                    val csp = evaluate(instrumentation, view, "window.__probeCsp.length||0")?.toIntOrNull() ?: 0
                    check(csp == 0) { "CSP violations: $csp" }
                    return "PASS"
                }
                Thread.sleep(100)
            }
            throw AssertionError("blockNetworkLoads WebView did not show the preview image (" +
                "err=${evaluate(instrumentation, view, "window.__probeErr||''")})")
        } finally {
            try { instrumentation.runOnMainSync { activity?.finish() } } catch (_: Throwable) { }
            Previews.clear(context)
        }
    }

    private fun findWeb(view: View): WebView? {
        if (view is WebView) return view
        if (view is ViewGroup) for (i in 0 until view.childCount) findWeb(view.getChildAt(i))?.let { return it }
        return null
    }

    private fun evaluate(instrumentation: Instrumentation, view: WebView, js: String): String? {
        val latch = CountDownLatch(1)
        var out: String? = null
        instrumentation.runOnMainSync { view.evaluateJavascript(js) { value -> out = value; latch.countDown() } }
        latch.await(3, TimeUnit.SECONDS)
        return out?.trim('"')
    }

    private fun header(r: WebResourceResponse, name: String): String? =
        r.responseHeaders?.entries?.firstOrNull { it.key.equals(name, true) }?.value
    private fun read(r: WebResourceResponse): ByteArray = r.data?.use { it.readBytes() } ?: ByteArray(0)

    private class Request(private val uri: Uri, private val verb: String = "GET",
                          private val headers: Map<String, String> = emptyMap()) : WebResourceRequest {
        override fun getUrl(): Uri = uri
        override fun isForMainFrame(): Boolean = true
        override fun isRedirect(): Boolean = false
        override fun hasGesture(): Boolean = false
        override fun getMethod(): String = verb
        override fun getRequestHeaders(): MutableMap<String, String> = headers.toMutableMap()
    }
}
