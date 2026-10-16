package dev.herdr.pocket

import android.content.ContentResolver
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Matrix
import android.media.ExifInterface
import android.net.Uri
import android.util.Base64
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

/** A picture ready to upload: re-encoded (so no EXIF, no location) and small enough for the link. */
class Prepared(val id: String, val bytes: ByteArray, val ext: String, val thumb: ByteArray, val width: Int, val height: Int) {
    val sha256: String = sha256(bytes)
}

fun sha256(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

/**
 * Decodes, rotates upright, downscales and re-encodes pictures picked on the phone. Bytes stay in
 * native memory; the WebView only gets a small preview and an id, so nothing large crosses the
 * JavaScript bridge.
 */
object ImagePrep {
    const val MAX_EDGE = 2048
    // Uploads must also come back whole in one bridge response (base64 under its 2 MB cap).
    const val MAX_BYTES = 1_300_000
    private const val THUMB_EDGE = 720
    private const val MAX_SOURCE_PIXELS = 80_000_000L
    private const val KEEP = 12

    private val outgoing = ConcurrentHashMap<String, Prepared>()
    private val order = ArrayDeque<String>()

    fun get(id: String): Prepared? = outgoing[id]
    fun drop(id: String) { outgoing.remove(id); synchronized(order) { order.remove(id) } }

    private fun keep(p: Prepared) {
        outgoing[p.id] = p
        synchronized(order) {
            order.addLast(p.id)
            while (order.size > KEEP) outgoing.remove(order.removeFirst())
        }
    }

    fun prepare(resolver: ContentResolver, uri: Uri): Prepared {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        // A bounds-only decode always returns null; only a missing stream means the picture is unreadable.
        (resolver.openInputStream(uri) ?: error("读不到这张图片")).use { BitmapFactory.decodeStream(it, null, bounds) }
        val w = bounds.outWidth; val h = bounds.outHeight
        check(w > 0 && h > 0) { "这不是能识别的图片" }
        check(w.toLong() * h <= MAX_SOURCE_PIXELS) { "图片太大了" }
        var sample = 1
        while (maxOf(w, h) / (sample * 2) >= MAX_EDGE) sample *= 2
        val decoded = resolver.openInputStream(uri)?.use {
            BitmapFactory.decodeStream(it, null, BitmapFactory.Options().apply { inSampleSize = sample })
        } ?: error("这张图片解不开")
        val orientation = try {
            resolver.openInputStream(uri)?.use { ExifInterface(it).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL) }
        } catch (_: Exception) { null } ?: ExifInterface.ORIENTATION_NORMAL
        val upright = fit(decoded, MAX_EDGE, orientation)
        val png = bounds.outMimeType == "image/png"
        var bytes = if (png) encode(upright, Bitmap.CompressFormat.PNG, 100) else ByteArray(0)
        var ext = "png"
        if (!png || bytes.size > MAX_BYTES) {
            ext = "jpg"
            var image = opaque(upright)
            var quality = 88
            bytes = encode(image, Bitmap.CompressFormat.JPEG, quality)
            while (bytes.size > MAX_BYTES) {
                if (quality > 64) quality -= 8 else image = fit(image, (maxOf(image.width, image.height) * 0.8).toInt(), ExifInterface.ORIENTATION_NORMAL)
                bytes = encode(image, Bitmap.CompressFormat.JPEG, quality)
            }
        }
        val thumb = encode(opaque(fit(upright, THUMB_EDGE, ExifInterface.ORIENTATION_NORMAL)), Bitmap.CompressFormat.JPEG, 82)
        return Prepared(UUID.randomUUID().toString(), bytes, ext, thumb, upright.width, upright.height).also { keep(it) }
    }

    /** What the composer needs: id, preview and size. */
    fun describe(p: Prepared): JSONObject = JSONObject().put("id", p.id).put("thumb", dataUrl(p.thumb, "image/jpeg"))
        .put("width", p.width).put("height", p.height).put("bytes", p.bytes.size).put("type", p.ext)

    /** Downscales a picture served by the bridge before it reaches the WebView. */
    fun shrink(data: ByteArray, edge: Int): JSONObject {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(data, 0, data.size, bounds)
        check(bounds.outWidth > 0 && bounds.outHeight > 0) { "图片打不开" }
        var sample = 1
        while (maxOf(bounds.outWidth, bounds.outHeight) / (sample * 2) >= edge) sample *= 2
        val bitmap = BitmapFactory.decodeByteArray(data, 0, data.size, BitmapFactory.Options().apply { inSampleSize = sample }) ?: error("图片打不开")
        val small = opaque(fit(bitmap, edge, ExifInterface.ORIENTATION_NORMAL))
        return JSONObject().put("url", dataUrl(encode(small, Bitmap.CompressFormat.JPEG, 82), "image/jpeg"))
            .put("width", small.width).put("height", small.height)
    }

    private fun dataUrl(bytes: ByteArray, mime: String) = "data:$mime;base64," + Base64.encodeToString(bytes, Base64.NO_WRAP)

    private fun encode(bitmap: Bitmap, format: Bitmap.CompressFormat, quality: Int): ByteArray =
        ByteArrayOutputStream().also { bitmap.compress(format, quality, it) }.toByteArray()

    /** Scales so the long edge is at most [edge] and applies the EXIF orientation. */
    private fun fit(source: Bitmap, edge: Int, orientation: Int): Bitmap {
        val scale = minOf(1f, edge.toFloat() / maxOf(source.width, source.height))
        val m = Matrix()
        if (scale < 1f) m.postScale(scale, scale)
        when (orientation) {
            ExifInterface.ORIENTATION_ROTATE_90 -> m.postRotate(90f)
            ExifInterface.ORIENTATION_ROTATE_180 -> m.postRotate(180f)
            ExifInterface.ORIENTATION_ROTATE_270 -> m.postRotate(270f)
            ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> m.postScale(-1f, 1f)
            ExifInterface.ORIENTATION_FLIP_VERTICAL -> m.postScale(1f, -1f)
            ExifInterface.ORIENTATION_TRANSPOSE -> { m.postRotate(90f); m.postScale(-1f, 1f) }
            ExifInterface.ORIENTATION_TRANSVERSE -> { m.postRotate(270f); m.postScale(-1f, 1f) }
        }
        if (m.isIdentity) return source
        return Bitmap.createBitmap(source, 0, 0, source.width, source.height, m, true)
    }

    /** JPEG has no transparency: paint it on white instead of black. */
    private fun opaque(source: Bitmap): Bitmap {
        if (!source.hasAlpha()) return source
        val out = Bitmap.createBitmap(source.width, source.height, Bitmap.Config.ARGB_8888)
        Canvas(out).apply { drawColor(Color.WHITE); drawBitmap(source, 0f, 0f, null) }
        return out
    }
}
