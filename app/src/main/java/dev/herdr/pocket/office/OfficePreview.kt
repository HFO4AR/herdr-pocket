package dev.herdr.pocket.office

import android.content.Context
import dev.herdr.pocket.Friendly
import dev.herdr.pocket.Previews
import dev.herdr.pocket.RemoteFiles
import dev.herdr.pocket.SftpPath
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.security.SecureRandom

/**
 * Native side of the Office reading view. One request acquires the complete file through the
 * existing SFTP preview cache ([OfficeSource], backed by `Previews.fetch(kind="raw")`), then parses
 * it into bounded in-memory models:
 *
 *  · `sftpOfficeOpen`  → session id + metadata + the first chunk/sheet/slide
 *  · `sftpOfficeChunk` → the next DOCX blocks
 *  · `sftpOfficeSheet` → one XLSX row window (virtual scrolling)
 *  · `sftpOfficeSlide` → one PPTX slide
 *  · `sftpOfficeClose` / `sftpOfficeCancel`
 *
 * At most [MAX_SESSIONS] sessions are kept (least recently used closes first). Responses are
 * org.json structures of text and numbers only — never XML, HTML or a URL chosen by the document.
 * Images become 40-hex derived cache keys, displayed through the Phase 1 preview-asset channel.
 *
 * Acquisition is behind [OfficeSource] on purpose: the Phase 1 `Previews.acquire` refactor can
 * replace [PreviewOfficeSource] without touching the parsers or this session layer.
 */
object OfficePreview {
    const val MAX_SESSIONS = 4
    const val MAX_FILE = 80L * 1024 * 1024
    const val DOCX_CHUNK = 80
    const val XLSX_CHUNK = 200
    private const val MAX_SLIDES_CACHED = 3
    private const val MAX_SHEETS_CACHED = 2
    private val ID = Regex("[0-9a-f]{16}")
    private val MODERN = setOf("docx", "xlsx", "pptx")
    private val LEGACY = setOf(
        "doc", "xls", "ppt", "docm", "xlsm", "pptm", "dot", "dotx", "dotm", "xlt", "xltx", "xltm",
        "pot", "potx", "potm", "pps", "ppsx", "ppsm", "odt", "ods", "odp", "rtf", "wps", "et", "dps",
    )

    /** The acquired, complete local copy. */
    data class Acquired(val key: String, val file: File, val name: String, val mime: String, val size: Long, val mtime: Long)

    interface OfficeSource {
        fun acquire(context: Context, device: String, path: String, token: String, allowLarge: Boolean, progress: (Long) -> Unit): Acquired
        fun cancel(token: String) {}
    }

    /** The production source: the existing SFTP preview cache, full-file `raw` read. */
    object PreviewOfficeSource : OfficeSource {
        override fun acquire(context: Context, device: String, path: String, token: String, allowLarge: Boolean, progress: (Long) -> Unit): Acquired {
            val req = JSONObject().put("path", path).put("kind", "raw").put("allowLarge", allowLarge).put("token", token)
            val r = Previews.fetch(context, device, req, progress)
            val key = r.getString("key")
            val file = Previews.fileFor(context, key) ?: throw Friendly("preview_gone", "预览缓存不见了，重新打开一下")
            if (!r.optBoolean("complete")) throw Friendly("preview_partial", "文件没有完整读到手机上，先下载完整的文件")
            return Acquired(key, file, r.optString("name"), r.optString("mime"), r.optLong("size"), r.optLong("mtime"))
        }

        override fun cancel(token: String) = Previews.cancel(token)
    }

    internal var source: OfficeSource = PreviewOfficeSource

    private class Session(
        val id: String,
        val kind: OfficeKind,
        val name: String,
        val key: String,
        val size: Long,
        val mtime: Long,
        val zip: OfficeZip,
        val docx: DocxDocument?,
        val book: XlsxWorkbook?,
        val ppt: PptxPresentation?,
        val assets: OfficeAssets,
    ) {
        val lock = Any()
        val sheets = LinkedHashMap<Int, XlsxSheetData>()
        val slides = LinkedHashMap<Int, PptxSlide>()

        fun sheet(index: Int): XlsxSheetData {
            sheets[index]?.let {
                sheets.remove(index)
                sheets[index] = it
                return it
            }
            val data = XlsxParser.parseSheet(zip, book ?: throw OfficeException("office_damaged", "这个工作簿读不出来"), index)
            if (sheets.size >= MAX_SHEETS_CACHED) sheets.remove(sheets.keys.first())
            sheets[index] = data
            return data
        }

        fun slide(index: Int): PptxSlide {
            slides[index]?.let {
                slides.remove(index)
                slides[index] = it
                return it
            }
            val data = PptxParser.parseSlide(zip, ppt ?: throw OfficeException("office_damaged", "这个演示文稿读不出来"), index, assets)
            if (slides.size >= MAX_SLIDES_CACHED) slides.remove(slides.keys.first())
            slides[index] = data
            return data
        }

        fun close() {
            synchronized(lock) {
                try {
                    zip.close()
                } catch (_: Exception) {
                }
            }
        }
    }

    private val sessions = LinkedHashMap<String, Session>()
    private val random = SecureRandom()

    /**
     * Acquires and parses [path] on [device]. [progress] receives real byte counts from the read.
     * Throws [Friendly] with a readable reason for legacy/encrypted/corrupt/oversized documents.
     */
    fun open(context: Context, device: String, req: JSONObject, progress: (Long) -> Unit): JSONObject {
        val path = req.getString("path")
        require(path.startsWith("/") && path.indexOf('\u0000') < 0) { "路径不对" }
        val name = SftpPath.cleanName(SftpPath.base(path))
        val ext = name.substringAfterLast('.', "").lowercase()
        if (ext in LEGACY) throw Friendly("office_legacy", "这是旧版 Office、宏文档或 OpenDocument，手机上不能预览；可以下载后用其他应用打开")
        if (ext !in MODERN) throw Friendly("office_unsupported", "这个文件不是 Word/Excel/PPT 的 .docx/.xlsx/.pptx 格式")
        val token = req.optString("token").take(80)
        val acquired = try {
            source.acquire(context, device, path, token, req.optBoolean("allowLarge"), progress)
        } catch (e: Exception) {
            throw if (e is Friendly) e else RemoteFiles.friendly(e)
        }
        if (acquired.size > MAX_FILE) {
            throw Friendly("office_too_large", "文档有 ${mb(acquired.size)}，超过手机预览的 ${mb(MAX_FILE)} 上限；可以下载后用其他应用打开")
        }
        var zip: OfficeZip? = null
        try {
            when (OfficeZip.probe(acquired.file)) {
                OfficeFileKind.OLE -> throw Friendly("office_legacy", "这个文档是旧版 Office 格式，或者加了密码；手机上不能预览，可以下载后用其他应用打开")
                OfficeFileKind.RTF -> throw Friendly("office_legacy", "这是 RTF 文档，手机上不能预览；可以下载后用其他应用打开")
                OfficeFileKind.ZIP -> Unit
                OfficeFileKind.OTHER -> throw Friendly("office_damaged", "这个文件不是完整的 Office 文档（可能已损坏）")
            }
            zip = try {
                OfficeZip.open(acquired.file)
            } catch (e: OfficeException) {
                throw Friendly(e.code, e.message ?: "这个文档打不开")
            }
            zip.readText("mimetype", 256)?.takeIf { it.startsWith("application/vnd.oasis.opendocument") }?.let {
                throw Friendly("office_unsupported", "这是 OpenDocument 文件，手机上不能预览；可以下载后用其他应用打开")
            }
            val assets = CachedAssets(context.applicationContext)
            val docx = if (ext == "docx") DocxParser.parse(zip, assets) else null
            val book = if (ext == "xlsx") XlsxParser.parse(zip) else null
            val ppt = if (ext == "pptx") PptxParser.parse(zip, assets) else null
            val kind = when (ext) {
                "docx" -> OfficeKind.DOCX
                "xlsx" -> OfficeKind.XLSX
                else -> OfficeKind.PPTX
            }
            val session = Session(id(), kind, name, acquired.key, acquired.size, acquired.mtime, zip, docx, book, ppt, assets)
            synchronized(sessions) {
                while (sessions.size >= MAX_SESSIONS) {
                    val oldest = sessions.entries.first()
                    sessions.remove(oldest.key)
                    oldest.value.close()
                }
                sessions[session.id] = session
            }
            try {
                return openJson(session, acquired)
            } catch (e: Throwable) {
                synchronized(sessions) { sessions.remove(session.id) }
                session.close()
                throw e
            }
        } catch (e: Friendly) {
            zip?.close()
            throw e
        } catch (e: OfficeException) {
            zip?.close()
            throw Friendly(e.code, e.message ?: "这个文档打不开")
        } catch (e: OutOfMemoryError) {
            zip?.close()
            throw Friendly("office_memory", "这个文档太大了，手机内存不够；可以下载后用其他应用打开")
        } catch (e: Exception) {
            zip?.close()
            throw Friendly("office_damaged", "这个文档已损坏，读不出来；可以下载后用其他应用打开")
        }
    }

    private inline fun <T> guarded(block: () -> T): T = try {
        block()
    } catch (e: Friendly) {
        throw e
    } catch (e: OfficeException) {
        throw Friendly(e.code, e.message ?: "这个文档打不开")
    } catch (e: OutOfMemoryError) {
        throw Friendly("office_memory", "这个文档太大了，手机内存不够；可以下载后用其他应用打开")
    } catch (e: Exception) {
        throw Friendly("office_damaged", "这个文档已损坏，读不出来；可以下载后用其他应用打开")
    }

    /** Next DOCX block chunk. */
    fun chunk(sessionId: String, from: Int, count: Int): JSONObject = guarded {
        val s = session(sessionId).takeIf { it.kind == OfficeKind.DOCX } ?: throw Friendly("office_gone", "这个预览已经关了")
        val doc = s.docx ?: throw Friendly("office_gone", "这个预览已经关了")
        synchronized(s.lock) {
            val total = doc.blocks.size
            val start = from.coerceIn(0, total)
            val limit = count.coerceIn(1, 200).coerceAtMost(total - start)
            val arr = JSONArray()
            var bytes = 0
            var next = start
            while (next < start + limit) {
                val block = blockJson(doc.blocks[next])
                val size = block.toString().length
                if (bytes + size > 360_000 && arr.length() > 0) break
                arr.put(block)
                bytes += size
                next++
            }
            return JSONObject().put("session", s.id).put("from", start).put("next", next)
                .put("total", total).put("done", next >= total).put("truncated", doc.truncated)
                .put("blocks", arr)
        }
    }

    /** XLSX row window; the whole sheet is parsed once (bounded) and cached per session. */
    fun sheet(sessionId: String, index: Int, start: Int, count: Int): JSONObject = guarded {
        val s = session(sessionId).takeIf { it.kind == OfficeKind.XLSX } ?: throw Friendly("office_gone", "这个预览已经关了")
        synchronized(s.lock) {
            val data = s.sheet(index.coerceIn(0, (s.book?.sheets?.size ?: 1) - 1))
            return sheetJson(s, data, start, count)
        }
    }

    /** One PPTX slide (cached per session). */
    fun slide(sessionId: String, index: Int): JSONObject = guarded {
        val s = session(sessionId).takeIf { it.kind == OfficeKind.PPTX } ?: throw Friendly("office_gone", "这个预览已经关了")
        synchronized(s.lock) {
            val i = index.coerceIn(0, (s.ppt?.slideCount ?: 1) - 1)
            return slideJson(s.slide(i))
        }
    }

    fun close(sessionId: String): JSONObject {
        if (!ID.matches(sessionId)) return JSONObject()
        synchronized(sessions) { sessions.remove(sessionId)?.close() }
        return JSONObject()
    }

    fun cancel(token: String) {
        if (token.isEmpty() || token.length > 80) return
        source.cancel(token)
    }

    /** Activity teardown: every open ZipFile is closed. */
    fun clear() {
        synchronized(sessions) {
            sessions.values.forEach { it.close() }
            sessions.clear()
        }
    }

    // ─── Session plumbing ──────────────────────────────────────────────────────────────────────
    private fun session(id: String): Session {
        require(ID.matches(id)) { "预览已过期" }
        synchronized(sessions) {
            val s = sessions.remove(id) ?: throw Friendly("office_gone", "预览已过期，重新打开一下")
            sessions[id] = s
            return s
        }
    }

    private fun id(): String {
        val bytes = ByteArray(8)
        random.nextBytes(bytes)
        return bytes.joinToString("") { "%02x".format(it) }
    }

    private fun openJson(s: Session, acquired: Acquired): JSONObject {
        val out = JSONObject()
            .put("session", s.id)
            .put("kind", s.kind.name.lowercase())
            .put("name", s.name)
            .put("mime", mimeOf(s.kind))
            .put("size", s.size)
            .put("mtime", s.mtime)
            .put("key", s.key)
        when (s.kind) {
            OfficeKind.DOCX -> {
                val doc = s.docx ?: throw OfficeException("office_damaged", "这个 Word 文档读不出来")
                val chunk = chunk(s.id, 0, DOCX_CHUNK)
                out.put("chars", doc.chars).put("truncated", doc.truncated)
                copyChunk(out, chunk)
            }
            OfficeKind.XLSX -> {
                val book = s.book ?: throw OfficeException("office_damaged", "这个 Excel 文档读不出来")
                val sheets = JSONArray()
                book.sheets.forEach { sheets.put(JSONObject().put("index", it.index).put("name", it.name).put("hidden", it.hidden)) }
                val styles = JSONArray(); book.styles.forEach { styles.put(styleJson(it)) }
                out.put("sheets", sheets).put("styles", styles)
                synchronized(s.lock) {
                    out.put("sheet", sheetJson(s, s.sheet(book.sheets.firstOrNull { !it.hidden }?.index ?: 0), 0, XLSX_CHUNK))
                }
            }
            OfficeKind.PPTX -> {
                val ppt = s.ppt ?: throw OfficeException("office_damaged", "这个 PowerPoint 文档读不出来")
                out.put("slides", ppt.slideCount).put("width", ppt.widthEmu).put("height", ppt.heightEmu)
                synchronized(s.lock) { out.put("slide", slideJson(s.slide(0))) }
            }
        }
        return out
    }

    private fun copyChunk(out: JSONObject, chunk: JSONObject) {
        for (key in listOf("from", "next", "total", "done", "truncated", "blocks")) {
            if (chunk.has(key)) out.put(key, chunk.get(key))
        }
    }

    private fun sheetJson(s: Session, data: XlsxSheetData, startIn: Int, countIn: Int): JSONObject {
        val start = startIn.coerceIn(0, maxOf(0, data.totalRows - 1))
        val count = countIn.coerceIn(1, 400)
        val end = (start + count).coerceAtMost(data.totalRows)
        val rows = JSONArray()
        for (row in data.rows) {
            if (row.index < start || row.index >= end) continue
            val cells = JSONArray()
            for (cell in row.cells) {
                val c = JSONObject().put("c", cell.col).put("v", cell.text).put("t", cell.type)
                if (cell.style > 0) c.put("s", cell.style)
                cells.put(c)
            }
            val r = JSONObject().put("i", row.index).put("cells", cells)
            row.heightPx?.let { r.put("h", it) }
            if (row.hidden) r.put("hidden", true)
            rows.put(r)
        }
        val merges = JSONArray()
        for (m in data.merges) {
            if (m.r2 < start || m.r1 >= end) continue
            merges.put(JSONObject().put("r1", m.r1).put("c1", m.c1).put("r2", m.r2).put("c2", m.c2))
        }
        return JSONObject()
            .put("session", s.id).put("sheet", data.index).put("name", data.name)
            .put("start", start).put("count", end - start).put("totalRows", data.totalRows).put("cols", data.cols)
            .put("widths", JSONArray(data.widths)).put("merges", merges).put("rows", rows)
            .put("truncated", data.truncated)
    }

    // ─── JSON shapes (text and numbers only) ──────────────────────────────────────────────────
    private fun blockJson(block: DocxBlock): JSONObject = when (block) {
        is DocxBlock.Para -> JSONObject().put("t", "p").put("p", paragraphJson(block.paragraph))
        is DocxBlock.Image -> JSONObject().put("t", "img").put("asset", block.asset).put("w", block.widthPx).put("h", block.heightPx)
            .apply { block.name?.let { put("name", it) } }
        is DocxBlock.Table -> {
            val rows = JSONArray()
            for (row in block.rows) {
                val cells = JSONArray()
                for (cell in row.cells) {
                    val c = JSONObject().put("c", cell.col)
                    if (cell.span > 1) c.put("cs", cell.span)
                    if (cell.rowSpan > 1) c.put("rs", cell.rowSpan)
                    if (cell.covered) c.put("cover", true)
                    cell.fill?.let { c.put("fill", it) }
                    val blocks = JSONArray(); cell.blocks.forEach { blocks.put(blockJson(it)) }
                    c.put("blocks", blocks)
                    cells.put(c)
                }
                rows.put(JSONObject().put("cells", cells).put("h", row.header))
            }
            JSONObject().put("t", "table").put("rows", rows)
        }
        DocxBlock.PageBreak -> JSONObject().put("t", "br")
    }

    private fun paragraphJson(p: OfficeParagraph): JSONObject {
        val runs = JSONArray(); p.runs.forEach { runs.put(runJson(it)) }
        val o = JSONObject().put("runs", runs)
        p.align?.let { o.put("al", it) }
        if (p.heading > 0) o.put("h", p.heading)
        if (p.level >= 0) o.put("lvl", p.level)
        p.marker?.let { o.put("marker", it) }
        if (p.ordered) o.put("ord", true)
        p.indentPt?.let { o.put("ind", it) }
        p.beforePt?.let { o.put("before", it) }
        p.afterPt?.let { o.put("after", it) }
        return o
    }

    private fun runJson(r: OfficeRun): JSONObject {
        val o = JSONObject().put("t", r.text)
        if (r.bold) o.put("b", true)
        if (r.italic) o.put("i", true)
        if (r.underline) o.put("u", true)
        if (r.strike) o.put("s", true)
        r.color?.let { o.put("color", it) }
        r.sizePt?.let { o.put("sz", it) }
        r.link?.let { o.put("link", it) }
        return o
    }

    private fun styleJson(s: XlsxStyle): JSONObject {
        val o = JSONObject()
        if (s.bold) o.put("b", true)
        if (s.italic) o.put("i", true)
        if (s.underline) o.put("u", true)
        if (s.strike) o.put("s", true)
        s.color?.let { o.put("color", it) }
        s.fill?.let { o.put("fill", it) }
        s.align?.let { o.put("al", it) }
        s.valign?.let { o.put("val", it) }
        if (s.wrap) o.put("wrap", true)
        s.format?.let { o.put("format", it) }
        if (s.date) o.put("date", true)
        s.sizePt?.let { o.put("sz", it) }
        return o
    }

    private fun slideJson(slide: PptxSlide): JSONObject {
        val shapes = JSONArray()
        for (shape in slide.shapes) {
            val o = JSONObject().put("k", shape.kind).put("x", shape.x).put("y", shape.y).put("w", shape.w).put("h", shape.h)
            shape.fill?.let { o.put("fill", it) }
            shape.name?.let { o.put("name", it) }
            shape.label?.let { o.put("label", it) }
            shape.asset?.let { o.put("asset", it) }
            if (shape.paragraphs.isNotEmpty()) {
                val ps = JSONArray(); shape.paragraphs.forEach { ps.put(paragraphJson(it)) }
                o.put("ps", ps)
            }
            shapes.put(o)
        }
        return JSONObject().put("index", slide.index).put("w", slide.widthEmu).put("h", slide.heightEmu)
            .put("bg", slide.background ?: "#FFFFFF").put("shapes", shapes)
            .apply {
                slide.bgAsset?.let { put("bgAsset", it) }
                slide.title?.let { put("title", it) }
                if (slide.truncated) put("truncated", true)
            }
    }

    private fun mimeOf(kind: OfficeKind): String = when (kind) {
        OfficeKind.DOCX -> "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        OfficeKind.XLSX -> "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        OfficeKind.PPTX -> "application/vnd.openxmlformats-officedocument.presentationml.presentation"
    }

    private fun mb(n: Long): String = if (n >= 1_000_000_000) "%.1f GB".format(n / 1e9) else "${(n + 999_999) / 1_000_000} MB"

    /** Writes extracted images as derived preview assets; the Phase 1 PreviewServer serves them. */
    private class CachedAssets(private val context: Context) : OfficeAssets {
        override fun put(part: String, bytes: ByteArray, mime: String): String? {
            if (bytes.isEmpty() || bytes.size > Previews.DERIVED_MAX) return null
            if (mime !in Previews.DERIVED_MIME) return null
            return try {
                Previews.putDerived(context, bytes, mime, part.substringAfterLast('/').take(120))
            } catch (_: Exception) {
                null
            }
        }
    }
}
