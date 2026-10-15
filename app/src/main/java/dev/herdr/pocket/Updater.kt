package dev.herdr.pocket

import android.content.ContentProvider
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.database.Cursor
import android.database.MatrixCursor
import android.net.Uri
import android.os.Build
import android.os.ParcelFileDescriptor
import android.provider.OpenableColumns
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

/**
 * Update check against the project's GitHub releases. This is the only traffic the app sends
 * anywhere besides the user's own SSH host, and it carries no device or account data.
 *
 * A downloaded APK is installed only after: the SHA-256 published with the release matches, the
 * package name is ours, its version is newer, and it is signed by the same certificate as the
 * installed app. Android re-checks the signature on install; the system installer still asks.
 */
object Updater {
    private const val REPO = "HFO4AR/herdr-pocket"
    private const val API = "https://api.github.com/repos/$REPO/releases?per_page=20"
    private const val DOWNLOAD_PREFIX = "https://github.com/$REPO/releases/download/"
    const val PAGE = "https://github.com/$REPO"
    private const val APK = "herdr-pocket.apk"
    private const val MAX_APK = 150L * 1024 * 1024
    private val TAG = Regex("[A-Za-z0-9._-]{1,64}")

    fun currentCode(context: Context): Long = codeOf(context.packageManager.getPackageInfo(context.packageName, 0))
    fun currentName(context: Context): String = context.packageManager.getPackageInfo(context.packageName, 0).versionName ?: ""

    @Suppress("DEPRECATION")
    private fun codeOf(info: PackageInfo) = if (Build.VERSION.SDK_INT >= 28) info.longVersionCode else info.versionCode.toLong()

    /** CI builds use run number + 100: preview-N is N+100; tagged releases state it in the notes. */
    private fun releaseCode(release: JSONObject): Long? {
        Regex("^preview-(\\d+)$").find(release.optString("tag_name"))?.let { return it.groupValues[1].toLong() + 100 }
        return Regex("versionCode[:=]\\s*(\\d+)").find(release.optString("body"))?.groupValues?.get(1)?.toLongOrNull()
    }

    private fun open(url: String): HttpURLConnection {
        val c = URL(url).openConnection() as HttpURLConnection
        require(c.url.protocol == "https") { "只允许 HTTPS" }
        c.connectTimeout = 15_000; c.readTimeout = 30_000
        c.instanceFollowRedirects = true
        c.setRequestProperty("User-Agent", "HerdrPocket-Updater")
        c.setRequestProperty("Accept", "application/vnd.github+json")
        return c
    }

    private fun get(url: String, limit: Int = 2_000_000): String {
        val c = open(url)
        try {
            val code = c.responseCode
            if (code == 403 || code == 429) error("GitHub 暂时限制了查询次数，稍后再试")
            if (code != 200) error("GitHub 返回 $code")
            val bytes = c.inputStream.use { input -> input.readNBytesCompat(limit + 1) }
            check(bytes.size <= limit) { "返回内容太大" }
            return String(bytes, Charsets.UTF_8)
        } finally { c.disconnect() }
    }

    private fun java.io.InputStream.readNBytesCompat(n: Int): ByteArray {
        val out = java.io.ByteArrayOutputStream(); val buf = ByteArray(16384); var total = 0
        while (total < n) { val r = read(buf, 0, minOf(buf.size, n - total)); if (r < 0) break; out.write(buf, 0, r); total += r }
        return out.toByteArray()
    }

    private fun releases(): List<JSONObject> {
        val list = JSONArray(get(API))
        return (0 until list.length()).map { list.getJSONObject(it) }.filter { r ->
            !r.optBoolean("draft") && TAG.matches(r.optString("tag_name")) && releaseCode(r) != null && apkAsset(r) != null
        }
    }

    private fun apkAsset(release: JSONObject): JSONObject? {
        val assets = release.optJSONArray("assets") ?: return null
        for (i in 0 until assets.length()) {
            val a = assets.getJSONObject(i)
            if (a.optString("name") == APK && a.optString("browser_download_url").startsWith(DOWNLOAD_PREFIX)) return a
        }
        return null
    }

    /** Newest release by version code; [available] when it is newer than this install. */
    fun check(context: Context): JSONObject {
        val current = currentCode(context)
        val newest = releases().maxByOrNull { releaseCode(it)!! }
        val result = JSONObject().put("checkedAt", System.currentTimeMillis()).put("current", current)
        if (newest == null) return result.put("available", false)
        val code = releaseCode(newest)!!
        val asset = apkAsset(newest)!!
        cleanup(context, newest.getString("tag_name"))
        return result.put("available", code > current).put("latest", JSONObject()
            .put("tag", newest.getString("tag_name")).put("name", newest.optString("name")).put("code", code)
            .put("prerelease", newest.optBoolean("prerelease")).put("published", newest.optString("published_at"))
            .put("size", asset.optLong("size")).put("page", newest.optString("html_url").takeIf { it.startsWith("$PAGE/") } ?: "$PAGE/releases"))
    }

    private fun folder(context: Context) = File(context.cacheDir, "updates").apply { mkdirs() }
    fun fileFor(context: Context, tag: String): File { require(TAG.matches(tag)) { "版本号不对" }; return File(folder(context), "herdr-pocket-$tag.apk") }

    /** Keep only the newest download; older files are dead weight after an update. */
    private fun cleanup(context: Context, keep: String) {
        folder(context).listFiles()?.forEach { if (it.name != "herdr-pocket-$keep.apk") it.delete() }
    }

    private fun sha256(file: File): String {
        val md = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input -> val buf = ByteArray(65536); while (true) { val n = input.read(buf); if (n < 0) break; md.update(buf, 0, n) } }
        return md.digest().joinToString("") { "%02x".format(it) }
    }

    /** Downloads and verifies [tag]'s APK. Progress is reported in whole percent. */
    fun download(context: Context, tag: String, progress: (Int) -> Unit): JSONObject {
        val release = releases().firstOrNull { it.getString("tag_name") == tag } ?: error("没找到这个版本，重新检查一下更新")
        val asset = apkAsset(release)!!
        val target = fileFor(context, tag)
        val expected = asset.optString("digest").removePrefix("sha256:").lowercase().takeIf { Regex("[0-9a-f]{64}").matches(it) }
            ?: run {
                val assets = release.getJSONArray("assets")
                val sums = (0 until assets.length()).map { assets.getJSONObject(it) }.firstOrNull { it.optString("name") == "$APK.sha256" }
                    ?.optString("browser_download_url")?.takeIf { it.startsWith(DOWNLOAD_PREFIX) } ?: error("这个版本没有发布校验值，不安装")
                get(sums, 4096).trim().split(Regex("\\s+")).first().lowercase()
            }
        if (target.exists() && sha256(target) == expected) { verify(context, target); return JSONObject().put("tag", tag).put("ready", true) }
        cleanup(context, tag)
        val part = File(target.path + ".part"); part.delete()
        val c = open(asset.getString("browser_download_url"))
        c.setRequestProperty("Accept", "application/octet-stream")
        try {
            check(c.responseCode == 200) { "下载失败：HTTP ${c.responseCode}" }
            val total = c.contentLengthLong.takeIf { it > 0 } ?: asset.optLong("size")
            check(total in 1..MAX_APK) { "安装包大小不对" }
            var done = 0L; var last = -1
            c.inputStream.use { input -> part.outputStream().use { out ->
                val buf = ByteArray(65536)
                while (true) {
                    if (Thread.currentThread().isInterrupted) error("下载已取消")
                    val n = input.read(buf); if (n < 0) break
                    done += n; check(done <= MAX_APK) { "安装包太大" }
                    out.write(buf, 0, n)
                    val pct = (done * 100 / total).toInt().coerceIn(0, 100)
                    if (pct != last) { last = pct; progress(pct) }
                }
            } }
        } finally { c.disconnect() }
        if (sha256(part) != expected) { part.delete(); error("下载的文件校验不通过，已删除") }
        try { verify(context, part) } catch (e: Exception) { part.delete(); throw e }
        check(part.renameTo(target)) { "保存安装包失败" }
        return JSONObject().put("tag", tag).put("ready", true)
    }

    @Suppress("DEPRECATION")
    private fun signers(info: PackageInfo): Set<String> =
        (if (Build.VERSION.SDK_INT >= 28) info.signingInfo?.let { if (it.hasMultipleSigners()) it.apkContentsSigners else it.signingCertificateHistory } else info.signatures)
            ?.map { MessageDigest.getInstance("SHA-256").digest(it.toByteArray()).joinToString("") { b -> "%02x".format(b) } }?.toSet() ?: emptySet()

    @Suppress("DEPRECATION")
    private fun verify(context: Context, apk: File) {
        val pm = context.packageManager
        val flags = if (Build.VERSION.SDK_INT >= 28) PackageManager.GET_SIGNING_CERTIFICATES else PackageManager.GET_SIGNATURES
        val archive = pm.getPackageArchiveInfo(apk.path, flags) ?: error("安装包无法解析")
        check(archive.packageName == context.packageName) { "安装包不是 Herdr Pocket" }
        check(codeOf(archive) > currentCode(context)) { "这个安装包不比当前版本新" }
        val installed = signers(pm.getPackageInfo(context.packageName, flags))
        val incoming = signers(archive)
        // signingCertificateHistory of the installed app includes older certificates after a rotation.
        check(incoming.isNotEmpty() && incoming.any { it in installed }) { "安装包签名和当前应用不一致（本机装的可能是自己编译的调试版），不安装" }
    }

    /** System installer for a verified download, or the "install unknown apps" switch first. */
    fun installIntent(context: Context, tag: String): Intent {
        val file = fileFor(context, tag)
        check(file.exists()) { "安装包不在了，重新下载一下" }
        verify(context, file)
        if (Build.VERSION.SDK_INT >= 26 && !context.packageManager.canRequestPackageInstalls())
            return Intent(android.provider.Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${context.packageName}"))
        return Intent(Intent.ACTION_VIEW).setDataAndType(Uri.parse("content://${UpdateFiles.AUTHORITY}/${file.name}"), "application/vnd.android.package-archive")
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    }
}

/** Serves a verified update APK to the system installer through a one-off URI grant. */
class UpdateFiles : ContentProvider() {
    override fun onCreate() = true
    private fun fileFor(uri: Uri): File {
        val name = uri.lastPathSegment ?: throw SecurityException("bad uri")
        if (uri.pathSegments.size != 1 || !NAME.matches(name)) throw SecurityException("bad uri")
        return File(File(context!!.cacheDir, "updates"), name)
    }
    override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor {
        if (mode != "r") throw SecurityException("read only")
        return ParcelFileDescriptor.open(fileFor(uri), ParcelFileDescriptor.MODE_READ_ONLY)
    }
    override fun getType(uri: Uri) = "application/vnd.android.package-archive"
    override fun query(uri: Uri, projection: Array<out String>?, selection: String?, args: Array<out String>?, sort: String?): Cursor {
        val file = fileFor(uri)
        return MatrixCursor(arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE)).apply { addRow(arrayOf<Any>(file.name, file.length())) }
    }
    override fun insert(uri: Uri, values: ContentValues?): Uri? = null
    override fun delete(uri: Uri, selection: String?, args: Array<out String>?) = 0
    override fun update(uri: Uri, values: ContentValues?, selection: String?, args: Array<out String>?) = 0

    companion object {
        const val AUTHORITY = "dev.herdr.pocket.update"
        private val NAME = Regex("herdr-pocket-[A-Za-z0-9._-]{1,64}\\.apk")
    }
}
