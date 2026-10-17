package dev.herdr.pocket

import com.jcraft.jsch.ChannelSftp
import com.jcraft.jsch.JSchException
import com.jcraft.jsch.SftpATTRS
import com.jcraft.jsch.SftpException
import org.json.JSONArray
import org.json.JSONObject
import java.text.Normalizer

/**
 * Remote paths for the 文件 screen (SFTP over the device's existing SSH session).
 *
 * Nothing here goes through a shell: every path is one SFTP request argument. JSch itself, however,
 * treats `\`, `*` and `?` specially in most calls (ls, stat, lstat, get, put, rm, rmdir, rename,
 * hardlink, chmod unquote backslashes and expand wildcards in the last component), while mkdir and
 * realpath send the bytes as given. [q] is applied exactly where JSch globs, so a file called
 * `a*b?` is that file and never a pattern that could match (and delete or overwrite) others.
 */
object SftpPath {
    const val MAX_PATH_BYTES = 4096
    const val MAX_NAME_BYTES = 255

    /** Escapes a path for JSch's glob-aware calls. Not for mkdir/realpath. */
    fun q(path: String): String = buildString(path.length + 4) {
        for (c in path) { if (c == '\\' || c == '*' || c == '?') append('\\'); append(c) }
    }

    /**
     * An absolute, lexically normalized path: "", "~" and "~/…" start at [home]; "//" collapses,
     * "." and ".." are resolved on the text. NUL and over-long paths are refused.
     */
    fun resolve(raw: String, home: String): String {
        require(raw.indexOf('\u0000') < 0) { "路径里有不允许的字符" }
        val text = when {
            raw.isEmpty() || raw == "~" -> home
            raw.startsWith("~/") -> home + raw.substring(1)
            else -> raw
        }
        require(text.startsWith("/")) { "路径要从 / 或 ~ 开始" }
        val parts = ArrayList<String>()
        for (part in text.split('/')) when (part) {
            "", "." -> Unit
            ".." -> if (parts.isNotEmpty()) parts.removeAt(parts.lastIndex)
            else -> parts.add(part)
        }
        val path = "/" + parts.joinToString("/")
        require(path.toByteArray().size <= MAX_PATH_BYTES) { "路径太长了" }
        return path
    }

    fun join(dir: String, name: String) = if (dir == "/") "/$name" else "$dir/$name"
    fun parent(path: String): String { val i = path.lastIndexOf('/'); return if (i <= 0) "/" else path.substring(0, i) }
    fun base(path: String): String = path.substring(path.lastIndexOf('/') + 1)

    /** A name typed by the person (新建文件夹 / 重命名): one path component, as typed. */
    fun checkName(raw: String): String {
        val name = Normalizer.normalize(raw, Normalizer.Form.NFC)
        require(name.isNotBlank()) { "名字不能为空" }
        require(name != "." && name != "..") { "不能用 . 或 .. 当名字" }
        require('/' !in name) { "名字里不能有 /" }
        require(name.none { it.code < 32 || it.code == 127 }) { "名字里不能有控制字符" }
        require(name.toByteArray().size <= MAX_NAME_BYTES) { "名字太长了（最多 255 字节）" }
        require(name.trim() == name) { "名字开头或结尾不能是空格" }
        return name
    }

    /**
     * A phone file's display name made into one safe component: NFC, `/` becomes `_`, control,
     * format (bidi, zero width), line-separator and private-use characters dropped, at most 255
     * UTF-8 bytes keeping the extension. Leading dots are kept (uploading `.env` stays `.env`).
     */
    fun cleanName(raw: String?): String {
        val text = Normalizer.normalize(raw ?: "", Normalizer.Form.NFC)
        val out = StringBuilder()
        var i = 0
        while (i < text.length) {
            val cp = text.codePointAt(i); i += Character.charCount(cp)
            val type = Character.getType(cp).toByte()
            when {
                cp == '/'.code -> out.append('_')
                cp == '\t'.code || cp == '\n'.code || cp == '\r'.code || type == Character.LINE_SEPARATOR || type == Character.PARAGRAPH_SEPARATOR -> out.append(' ')
                type == Character.CONTROL || type == Character.FORMAT || type == Character.SURROGATE || type == Character.PRIVATE_USE -> Unit
                else -> out.appendCodePoint(cp)
            }
        }
        var name = out.toString().trim()
        if (name.isEmpty() || name == "." || name == "..") name = "文件"
        val dot = name.lastIndexOf('.')
        val ext = if (dot > 0 && name.length - dot in 2..17) name.substring(dot) else ""
        var stem = name.removeSuffix(ext)
        while ((stem + ext).toByteArray().size > MAX_NAME_BYTES && stem.isNotEmpty()) stem = stem.substring(0, stem.offsetByCodePoints(stem.length, -1))
        return (stem.trimEnd().ifEmpty { "文件" } + ext)
    }

    /** 保留两个: "report.pdf" → "report (2).pdf"; a dotfile or a name without extension gets the suffix at the end. */
    fun numbered(name: String, n: Int): String {
        val dot = name.lastIndexOf('.')
        val ext = if (dot > 0 && name.length - dot in 2..17) name.substring(dot) else ""
        var stem = name.removeSuffix(ext)
        val tail = " ($n)"
        while ((stem + tail + ext).toByteArray().size > MAX_NAME_BYTES && stem.isNotEmpty()) stem = stem.substring(0, stem.offsetByCodePoints(stem.length, -1))
        return stem + tail + ext
    }
}

/**
 * Browsing and small changes on the computer for the 文件 screen: list, new folder, rename, delete.
 * Every call is one SFTP channel on the device's own SSH session ([PocketCore.sftp]), so it has
 * exactly the SSH user's permissions and nothing else; no shell, no bridge.
 */
object RemoteFiles {
    const val MAX_ENTRIES = 3000
    private const val MAX_LINK_STATS = 300
    /** 全部删除 walks at most this many items; a bigger tree is refused before anything is deleted. */
    const val MAX_TREE = 10000
    private val q = SftpPath::q

    fun op(op: String, device: String?, req: JSONObject): JSONObject = try {
        PocketCore.sftp(device) { sftp, home ->
            when (op) {
                "sftpList" -> list(sftp, home, req.optString("path"))
                "sftpMkdir" -> mkdir(sftp, home, req.getString("dir"), req.getString("name"))
                "sftpRename" -> rename(sftp, home, req.getString("path"), req.getString("name"))
                "sftpDelete" -> delete(sftp, home, req.getString("path"), req.optBoolean("recursive"), req.optString("confirm"))
                else -> error("不支持的操作")
            }
        }
    } catch (e: Exception) { throw friendly(e) }

    fun lstatOrNull(sftp: ChannelSftp, path: String): SftpATTRS? =
        try { sftp.lstat(q(path)) } catch (e: SftpException) { if (e.id != ChannelSftp.SSH_FX_NO_SUCH_FILE) throw e; null }

    fun list(sftp: ChannelSftp, home: String, raw: String): JSONObject {
        val asked = SftpPath.resolve(raw, home)
        val path = try { sftp.realpath(asked) } catch (e: SftpException) {
            if (e.id == ChannelSftp.SSH_FX_NO_SUCH_FILE) throw Friendly("sftp_missing", "这个文件夹不在了：$asked"); throw e }
        val st = sftp.stat(q(path))
        if (!st.isDir) throw Friendly("sftp_not_dir", "这不是文件夹：$path")
        val entries = JSONArray()
        val links = ArrayList<Pair<JSONObject, String>>()
        var truncated = false
        sftp.ls(q(path)) { e ->
            val name = e.filename
            if (name == "." || name == "..") return@ls ChannelSftp.LsEntrySelector.CONTINUE
            if (entries.length() >= MAX_ENTRIES) { truncated = true; return@ls ChannelSftp.LsEntrySelector.BREAK }
            val a = e.attrs
            val row = JSONObject().put("name", name).put("type", kind(a)).put("size", a.size).put("mtime", a.mTime.toLong() and 0xffffffffL)
                .put("perm", a.permissionsString)
            if (a.isLink) links.add(row to SftpPath.join(path, name))
            entries.put(row)
            ChannelSftp.LsEntrySelector.CONTINUE
        }
        // Where a link leads decides whether it opens like a folder; a broken link stays a link.
        for ((row, full) in links.take(MAX_LINK_STATS)) {
            try { val t = sftp.stat(q(full)); row.put("target", kind(t)); if (!t.isDir) row.put("size", t.size) } catch (_: SftpException) { row.put("target", "broken") }
        }
        return JSONObject().put("path", path).put("home", home).put("parent", if (path == "/") JSONObject.NULL else SftpPath.parent(path))
            .put("entries", entries).put("truncated", truncated).put("downloads", android.os.Build.VERSION.SDK_INT >= 29)
    }

    private fun kind(a: SftpATTRS) = when { a.isLink -> "link"; a.isDir -> "dir"; a.isReg -> "file"; else -> "other" }

    fun mkdir(sftp: ChannelSftp, home: String, dirRaw: String, nameRaw: String): JSONObject {
        val dir = SftpPath.resolve(dirRaw, home)
        val name = try { SftpPath.checkName(nameRaw) } catch (e: IllegalArgumentException) { throw Friendly("sftp_name", e.message ?: "名字不行") }
        val path = SftpPath.join(dir, name)
        if (lstatOrNull(sftp, path) != null) throw Friendly("sftp_exists", "这里已经有叫「$name」的了")
        sftp.mkdir(path) // mkdir takes the bytes as they are (no glob), see SftpPath
        return JSONObject().put("path", path).put("name", name)
    }

    /** Renames inside the same folder; never onto an existing name (JSch's rename would replace it). */
    fun rename(sftp: ChannelSftp, home: String, pathRaw: String, nameRaw: String): JSONObject {
        val from = SftpPath.resolve(pathRaw, home)
        check(from != "/") { "不能改根目录" }
        val name = try { SftpPath.checkName(nameRaw) } catch (e: IllegalArgumentException) { throw Friendly("sftp_name", e.message ?: "名字不行") }
        val to = SftpPath.join(SftpPath.parent(from), name)
        if (to == from) return JSONObject().put("path", to).put("name", name)
        lstatOrNull(sftp, from) ?: throw Friendly("sftp_missing", "「${SftpPath.base(from)}」已经不在了")
        if (lstatOrNull(sftp, to) != null) throw Friendly("sftp_exists", "这里已经有叫「$name」的了，没改名")
        sftp.rename(q(from), q(to))
        return JSONObject().put("path", to).put("name", name)
    }

    /**
     * A file or link is removed (a link itself, never what it points to); a folder only when empty,
     * unless [recursive] with [confirm] equal to its name: then the whole tree is walked first
     * without following links (at most [MAX_TREE] items, else nothing is deleted) and removed
     * deepest first. The first failure stops and says how many were already deleted.
     */
    fun delete(sftp: ChannelSftp, home: String, raw: String, recursive: Boolean, confirm: String): JSONObject {
        val path = SftpPath.resolve(raw, home)
        check(path != "/" && path != home) { "不能删根目录或主目录" }
        val name = SftpPath.base(path)
        val a = lstatOrNull(sftp, path) ?: throw Friendly("sftp_missing", "「$name」已经不在了")
        if (!a.isDir || a.isLink) { sftp.rm(q(path)); return JSONObject().put("deleted", 1) }
        if (!recursive) {
            var empty = true
            sftp.ls(q(path)) { e -> if (e.filename == "." || e.filename == "..") ChannelSftp.LsEntrySelector.CONTINUE else { empty = false; ChannelSftp.LsEntrySelector.BREAK } }
            if (!empty) throw Friendly("sftp_not_empty", "「$name」里面还有东西")
            sftp.rmdir(q(path)); return JSONObject().put("deleted", 1)
        }
        if (confirm != name) throw Friendly("sftp_confirm", "要输入文件夹名「$name」确认才会全部删除")
        val order = ArrayList<Pair<String, Boolean>>() // deepest first: (path, isDir)
        walk(sftp, path, order)
        var done = 0
        for ((p, dir) in order) {
            try { if (dir) sftp.rmdir(q(p)) else sftp.rm(q(p)); done++ }
            catch (e: SftpException) { throw Friendly("sftp_partial", "删到一半停了：已删 $done 个，「${SftpPath.base(p)}」删不掉（${reason(e)}），剩下的还在") }
        }
        return JSONObject().put("deleted", done)
    }

    private fun walk(sftp: ChannelSftp, dir: String, out: MutableList<Pair<String, Boolean>>) {
        val children = ArrayList<Pair<String, SftpATTRS>>()
        sftp.ls(q(dir)) { e ->
            if (e.filename != "." && e.filename != "..") children.add(SftpPath.join(dir, e.filename) to e.attrs)
            if (children.size + out.size > MAX_TREE) ChannelSftp.LsEntrySelector.BREAK else ChannelSftp.LsEntrySelector.CONTINUE
        }
        if (children.size + out.size > MAX_TREE) throw Friendly("sftp_too_many", "里面超过 ${MAX_TREE} 个文件，太多了，一个都没删；请在电脑上删")
        for ((p, a) in children) {
            if (a.isDir && !a.isLink) walk(sftp, p, out) else out.add(p to false)
            if (out.size > MAX_TREE) throw Friendly("sftp_too_many", "里面超过 ${MAX_TREE} 个文件，太多了，一个都没删；请在电脑上删")
        }
        out.add(dir to true)
    }

    private fun reason(e: SftpException) = when (e.id) {
        ChannelSftp.SSH_FX_PERMISSION_DENIED -> "没有权限"
        ChannelSftp.SSH_FX_NO_SUCH_FILE -> "已经不在了"
        else -> "电脑拒绝了"
    }

    /** Readable errors; never includes file contents. */
    fun friendly(e: Throwable): Exception {
        if (e is Friendly) return e
        if (e is SftpException) return when (e.id) {
            ChannelSftp.SSH_FX_NO_SUCH_FILE -> Friendly("sftp_missing", "找不到这个文件或文件夹（可能刚被删了或改了名）", cause = e)
            ChannelSftp.SSH_FX_PERMISSION_DENIED -> Friendly("sftp_denied", "没有权限：这个 SSH 用户不能动它", cause = e)
            ChannelSftp.SSH_FX_OP_UNSUPPORTED -> Friendly("sftp_unsupported", "电脑的 SFTP 不支持这个操作", cause = e)
            ChannelSftp.SSH_FX_NO_CONNECTION, ChannelSftp.SSH_FX_CONNECTION_LOST -> Friendly("sftp_link", "SSH 连接断了，没做完", cause = e)
            else -> (e.cause as? IllegalStateException)?.let { Friendly("sftp_failed", it.message ?: "操作失败", cause = e) }
                ?: Friendly("sftp_failed", "电脑拒绝了这个操作" + (e.message?.takeIf { it.isNotBlank() && it.length < 120 }?.let { "（$it）" } ?: ""), cause = e)
        }
        if (e is JSchException) return Friendly("sftp_link", "SSH 连接出问题了，没做完：" + (e.message ?: ""), cause = e)
        if (e is IllegalArgumentException) return Friendly("sftp_bad", e.message ?: "参数不对", cause = e)
        return e as? Exception ?: IllegalStateException(e.message ?: "操作失败")
    }
}
