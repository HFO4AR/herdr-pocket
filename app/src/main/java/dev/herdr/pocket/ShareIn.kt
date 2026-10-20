package dev.herdr.pocket

import android.app.Activity
import android.content.ClipData
import android.content.ContentResolver
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import org.json.JSONArray
import org.json.JSONObject

/**
 * Entry point for "分享到 Herdr Pocket". It runs in the sharing app's task and only forwards the
 * intent (with its read grants) to the single [MainActivity], so sharing never starts a second UI
 * with its own connection, and closing the sharing app never ends ours.
 */
class ShareActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val source = intent
        if (source != null && ShareIn.isShare(source)) {
            val forward = Intent(this, MainActivity::class.java).setAction(source.action).setType(source.type)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            source.extras?.let { forward.putExtras(it) }
            val uris = ShareIn.uris(source)
            if (uris.isNotEmpty()) {
                val clip = ClipData.newRawUri("", uris[0])
                for (u in uris.drop(1)) clip.addItem(ClipData.Item(u))
                forward.clipData = clip
                forward.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            try { startActivity(forward) } catch (_: Exception) {}
        }
        finish()
    }
}

/** Reads what another app shared: text, pictures (prepared like picked ones) and files. */
object ShareIn {
    private const val MAX_TEXT = 20_000

    fun isShare(intent: Intent) = intent.action == Intent.ACTION_SEND || intent.action == Intent.ACTION_SEND_MULTIPLE

    @Suppress("DEPRECATION")
    fun uris(intent: Intent): List<Uri> {
        val list = ArrayList<Uri>()
        if (intent.action == Intent.ACTION_SEND_MULTIPLE) {
            val many = if (Build.VERSION.SDK_INT >= 33) intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java)
                else intent.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM)
            many?.filterNotNull()?.let { list.addAll(it) }
        } else {
            val one = if (Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
                else intent.getParcelableExtra<Uri>(Intent.EXTRA_STREAM)
            one?.let { list.add(it) }
        }
        if (list.isEmpty()) intent.clipData?.let { clip -> for (i in 0 until clip.itemCount) clip.getItemAt(i).uri?.let { list.add(it) } }
        return list.filter(::allowed).distinct()
    }

    /**
     * Only content URIs from other apps. A file:// URI or one of our own providers would be read
     * with this app's permissions, which would let any app slip our private files into a message.
     */
    fun allowed(uri: Uri): Boolean = uri.scheme == ContentResolver.SCHEME_CONTENT &&
        !(uri.authority ?: "").startsWith("dev.herdr.pocket")

    fun text(intent: Intent): String {
        val subject = intent.getStringExtra(Intent.EXTRA_SUBJECT)?.trim().orEmpty()
        val parts = ArrayList<String>()
        intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString()?.trim()?.takeIf { it.isNotEmpty() }?.let { parts.add(it) }
        if (parts.isEmpty()) intent.getCharSequenceArrayListExtra(Intent.EXTRA_TEXT)?.mapNotNull { it?.toString()?.trim()?.takeIf { t -> t.isNotEmpty() } }?.let { parts.addAll(it) }
        var body = parts.joinToString("\n")
        // A shared link usually comes as subject = page title, text = URL: keep both.
        if (subject.isNotEmpty() && !body.contains(subject)) body = if (body.isEmpty()) subject else "$subject\n$body"
        return body.take(MAX_TEXT)
    }

    /** Pictures go through [ImagePrep] (upright, small, no EXIF); anything else is a file chip. */
    fun read(resolver: ContentResolver, intent: Intent): JSONObject {
        val images = JSONArray(); val files = JSONArray()
        var failed = 0; var reason = ""; var extra = 0
        for (uri in uris(intent)) {
            val mime = try { resolver.getType(uri) } catch (_: Exception) { null } ?: ""
            var done = false
            if (mime.startsWith("image/") && mime != "image/gif" && mime != "image/svg+xml") {
                try { images.put(ImagePrep.describe(ImagePrep.prepare(resolver, uri))); done = true } catch (_: Throwable) {}
            }
            if (done) continue
            if (files.length() >= FileAttach.MAX_FILES) { extra++; continue }
            try { files.put(FileAttach.describe(FileAttach.describe(resolver, uri))) }
            catch (e: Exception) { failed++; reason = e.message ?: "" }
        }
        return JSONObject().put("text", text(intent)).put("images", images).put("files", files)
            .put("failed", failed).put("reason", reason).put("extra", extra)
    }
}
