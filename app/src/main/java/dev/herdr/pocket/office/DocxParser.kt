package dev.herdr.pocket.office

import org.xmlpull.v1.XmlPullParser

/**
 * WordprocessingML reader (`.docx`). Pull-based, no DOM, no POI.
 *
 * Reads paragraphs/runs (bold, italic, underline, strike, colour, size, heading, alignment,
 * numbering), tables (gridSpan/vMerge), inline images and hyperlink text. Comments, tracked changes,
 * equations, fields' instructions, embedded objects and charts are skipped rather than guessed.
 * Images are handed to [OfficeAssets]; the parsers never see a URL or the network.
 */
object DocxParser {
    const val MAX_BLOCKS = 20_000
    const val MAX_CHARS = 4_000_000
    const val MAX_PARAGRAPH_CHARS = 100_000
    const val MAX_IMAGES = 100
    const val MAX_IMAGE_BYTES = 8 * 1024 * 1024
    const val MAX_TABLE_DEPTH = 4
    const val MAX_TABLE_ROWS = 250
    const val MAX_TABLE_CELLS = 60
    private const val EMU_PER_PX = 9_525L

    fun parse(zip: OfficeZip, assets: OfficeAssets): DocxDocument {
        val main = OfficeRels.mainPart(zip, "word/document.xml")
        if (!zip.has(main)) throw OfficeException("office_damaged", "这个 Word 文档没有正文内容")
        val rels = OfficeRels.parse(zip, main)
        val styles = Styles.parse(zip, main)
        val numbering = Numbering.parse(zip, main)
        val ctx = Ctx(zip, main, rels, styles, numbering, assets)
        val sp = OfficeXml.parser(zip, main) ?: throw OfficeException("office_damaged", "这个 Word 文档没有正文内容")
        val blocks = ArrayList<DocxBlock>()
        try {
            var inBody = false
            while (true) {
                val e = sp.next()
                if (e == XmlPullParser.END_DOCUMENT) break
                if (!inBody) {
                    if (sp.isStart("body", OfficeXml.W)) {
                        inBody = true
                        blocks.addAll(blockContainer(sp, ctx, "body", 1))
                    } else if (e == XmlPullParser.START_TAG && sp.name != "document") {
                        sp.skipElement()
                    }
                    continue
                }
            }
        } catch (e: OfficeException) {
            throw e
        } catch (e: Exception) {
            throw OfficeException("office_damaged", "这个 Word 文档已损坏，读不出来", e)
        }
        if (blocks.isEmpty()) throw OfficeException("office_damaged", "这个 Word 文档没有可显示的内容")
        return DocxDocument(blocks.take(MAX_BLOCKS), ctx.truncated || blocks.size > MAX_BLOCKS, ctx.chars)
    }

    // ─── Blocks ────────────────────────────────────────────────────────────────────────────────
    private fun blockContainer(sp: OfficeXml.SafeParser, ctx: Ctx, end: String, depth: Int): List<DocxBlock> {
        val out = ArrayList<DocxBlock>()
        while (true) {
            val e = sp.next()
            if (e == XmlPullParser.END_DOCUMENT) return out
            if (e == XmlPullParser.END_TAG) {
                if (sp.name == end) return out
                continue
            }
            if (e != XmlPullParser.START_TAG) continue
            if (out.size >= MAX_BLOCKS) {
                ctx.truncated = true
                sp.skipElement()
                continue
            }
            when (sp.name) {
                "p" -> out.addAll(paragraph(sp, ctx))
                "tbl" -> {
                    if (depth < MAX_TABLE_DEPTH) out.add(TableBlock(sp, ctx, depth + 1).parse())
                    else sp.skipElement()
                }
                "sdt" -> out.addAll(sdtBlock(sp, ctx, depth))
                "customXml" -> out.addAll(blockContainer(sp, ctx, "customXml", depth))
                "ins", "del", "moveFrom", "moveTo", "altChunk", "oMath", "oMathPara" -> {
                    if (sp.name == "altChunk") throw OfficeException("office_altchunk", "这个文档引用了外部内容，手机上不能预览")
                    sp.skipElement()
                }
                else -> sp.skipElement()
            }
        }
    }

    private fun sdtBlock(sp: OfficeXml.SafeParser, ctx: Ctx, depth: Int): List<DocxBlock> {
        val out = ArrayList<DocxBlock>()
        while (true) {
            val e = sp.next()
            if (e == XmlPullParser.END_DOCUMENT) return out
            if (e == XmlPullParser.END_TAG) {
                if (sp.name == "sdt") return out
                continue
            }
            if (e != XmlPullParser.START_TAG) continue
            if (sp.name == "sdtContent") out.addAll(blockContainer(sp, ctx, "sdtContent", depth))
            else sp.skipElement()
        }
    }

    // ─── Paragraphs and runs ───────────────────────────────────────────────────────────────────
    private class RunProps {
        var bold: Boolean? = null
        var italic: Boolean? = null
        var underline: Boolean? = null
        var strike: Boolean? = null
        var color: String? = null
        var sizeHalfPt: Int? = null
        var styleId: String? = null
    }

    private class PProps {
        var styleId: String? = null
        var align: String? = null
        var numId = -1
        var ilvl = 0
        var outline = -1
        var indentTwips: Int? = null
        var beforeTwips: Int? = null
        var afterTwips: Int? = null
        var run: RunProps? = null
        var fill: String? = null
    }

    private fun paragraph(sp: OfficeXml.SafeParser, ctx: Ctx): List<DocxBlock> {
        val props = PProps()
        val runs = ArrayList<OfficeRun>()
        val images = ArrayList<DocxBlock.Image>()
        val pageBreak = booleanArrayOf(false)
        while (true) {
            val e = sp.next()
            if (e == XmlPullParser.END_DOCUMENT) break
            if (e == XmlPullParser.END_TAG) {
                if (sp.name == "p") break
                continue
            }
            if (e != XmlPullParser.START_TAG) continue
            when (sp.name) {
                "pPr" -> parsePProps(sp, props)
                else -> inlineOne(sp, ctx, ctx.paragraphBase(props), null, runs, images, pageBreak)
            }
        }
        val sawBreak = pageBreak[0]
        val style = ctx.styles.get(props.styleId)
        val heading = headingOf(props, style)
        val align = props.align ?: style?.align
        val numId = if (props.numId > 0) props.numId else style?.numId ?: -1
        val ilvl = if (props.numId > 0) props.ilvl else style?.ilvl ?: 0
        val marker = if (numId > 0) ctx.numbering.marker(numId, ilvl) else null
        val para = OfficeParagraph(
            runs = runs.map { it }, align = align, heading = heading,
            level = if (marker != null) ilvl.coerceIn(0, 8) else -1,
            marker = marker?.first, ordered = marker?.second ?: false,
            indentPt = props.indentTwips?.let { (it / 20).coerceIn(0, 720) },
            beforePt = props.beforeTwips?.let { (it / 20).coerceIn(0, 200) },
            afterPt = props.afterTwips?.let { (it / 20).coerceIn(0, 200) },
        )
        val out = ArrayList<DocxBlock>(2 + images.size)
        if (runs.isNotEmpty() || images.isEmpty()) out.add(DocxBlock.Para(para))
        out.addAll(images)
        if (sawBreak) out.add(DocxBlock.PageBreak)
        return out
    }

    /** Consumes inline content up to [end]; nested containers recurse. */
    private fun inline(
        sp: OfficeXml.SafeParser, ctx: Ctx, end: String, base: RunProps, link: String?,
        runs: MutableList<OfficeRun>, images: MutableList<DocxBlock.Image>,
        pageBreak: BooleanArray,
    ) {
        while (true) {
            val e = sp.next()
            if (e == XmlPullParser.END_DOCUMENT) return
            if (e == XmlPullParser.END_TAG) {
                if (sp.name == end) return
                continue
            }
            if (e != XmlPullParser.START_TAG) continue
            inlineOne(sp, ctx, base, link, runs, images, pageBreak)
        }
    }

    private fun inlineOne(
        sp: OfficeXml.SafeParser, ctx: Ctx, base: RunProps, link: String?,
        runs: MutableList<OfficeRun>, images: MutableList<DocxBlock.Image>,
        pageBreak: BooleanArray,
    ) {
        when (sp.name) {
            "r" -> parseRun(sp, ctx, base, link, runs, images, pageBreak)
            "hyperlink" -> {
                val target = hyperlinkTarget(sp, ctx)
                inline(sp, ctx, "hyperlink", base, target, runs, images, pageBreak)
            }
            "fldSimple", "smartTag", "customXml", "sdt", "sdtContent" ->
                inline(sp, ctx, sp.name!!, base, link, runs, images, pageBreak)
            "ins", "del", "moveFrom", "moveTo", "oMath", "oMathPara", "delText", "instrText",
            "commentReference", "commentRangeStart", "commentRangeEnd", "bookmarkStart", "bookmarkEnd",
            "proofErr", "object" -> sp.skipElement()
            else -> sp.skipElement()
        }
    }

    private fun parseRun(
        sp: OfficeXml.SafeParser, ctx: Ctx, base: RunProps, link: String?,
        runs: MutableList<OfficeRun>, images: MutableList<DocxBlock.Image>, pageBreak: BooleanArray,
    ) {
        val props = RunProps()
        val text = StringBuilder()
        while (true) {
            val e = sp.next()
            if (e == XmlPullParser.END_DOCUMENT) break
            if (e == XmlPullParser.END_TAG) {
                if (sp.name == "r") break
                continue
            }
            if (e != XmlPullParser.START_TAG) continue
            when (sp.name) {
                "rPr" -> parseRunProps(sp, props)
                "t" -> if (text.length < MAX_PARAGRAPH_CHARS) text.append(sp.readText(MAX_PARAGRAPH_CHARS - text.length))
                "tab" -> { text.append('\t'); sp.skipElement() }
                "br" -> {
                    if (sp.attr("type").equals("page", ignoreCase = true)) pageBreak[0] = true else text.append('\n')
                    sp.skipElement()
                }
                "cr" -> { text.append('\n'); sp.skipElement() }
                "noBreakHyphen" -> { text.append('-'); sp.skipElement() }
                "softHyphen" -> { text.append('­'); sp.skipElement() }
                "sym" -> {
                    val cp = sp.attr("char")?.toIntOrNull(16) ?: 0
                    if (cp in 1..0x10FFFF) text.appendCodePoint(cp)
                    sp.skipElement()
                }
                "drawing" -> parseDrawing(sp, ctx)?.let { images += it }
                "pict" -> parsePict(sp, ctx)?.let { images += it }
                "object", "delText", "instrText", "fldChar", "footnoteReference", "endnoteReference",
                "commentReference", "lastRenderedPageBreak" -> sp.skipElement()
                else -> sp.skipElement()
            }
        }
        if (text.isEmpty()) return
        val effective = ctx.effectiveRun(base, props)
        runs += OfficeRun(
            text = ctx.takeChars(text.toString()),
            bold = effective.bold ?: false,
            italic = effective.italic ?: false,
            underline = effective.underline ?: false,
            strike = effective.strike ?: false,
            color = effective.color,
            sizePt = effective.sizeHalfPt?.let { (it / 2).coerceIn(4, 200) },
            link = link,
        )
    }

    private fun parsePProps(sp: OfficeXml.SafeParser, props: PProps) {
        while (true) {
            val e = sp.next()
            if (e == XmlPullParser.END_DOCUMENT) return
            if (e == XmlPullParser.END_TAG) {
                if (sp.name == "pPr") return
                continue
            }
            if (e != XmlPullParser.START_TAG) continue
            when (sp.name) {
                "pStyle" -> { props.styleId = sp.attr("val"); sp.skipElement() }
                "jc" -> { props.align = alignOf(sp.attr("val")); sp.skipElement() }
                "outlineLvl" -> { props.outline = sp.attr("val")?.toIntOrNull() ?: -1; sp.skipElement() }
                "ind" -> {
                    props.indentTwips = sp.attr("left")?.toIntOrNull() ?: sp.attr("start")?.toIntOrNull()
                    sp.skipElement()
                }
                "spacing" -> {
                    props.beforeTwips = sp.attr("before")?.toIntOrNull()
                    props.afterTwips = sp.attr("after")?.toIntOrNull()
                    sp.skipElement()
                }
                "numPr" -> parseNumPr(sp, props)
                "shd" -> { props.fill = OfficeXml.color(sp.attr("fill")); sp.skipElement() }
                "rPr" -> { val r = RunProps(); parseRunProps(sp, r); props.run = r }
                else -> sp.skipElement()
            }
        }
    }

    private fun parseNumPr(sp: OfficeXml.SafeParser, props: PProps) {
        while (true) {
            val e = sp.next()
            if (e == XmlPullParser.END_DOCUMENT) return
            if (e == XmlPullParser.END_TAG) {
                if (sp.name == "numPr") return
                continue
            }
            if (e != XmlPullParser.START_TAG) continue
            when (sp.name) {
                "numId" -> { props.numId = sp.attr("val")?.toIntOrNull() ?: -1; sp.skipElement() }
                "ilvl" -> { props.ilvl = sp.attr("val")?.toIntOrNull()?.coerceIn(0, 8) ?: 0; sp.skipElement() }
                else -> sp.skipElement()
            }
        }
    }

    private fun parseRunProps(sp: OfficeXml.SafeParser, props: RunProps) {
        while (true) {
            val e = sp.next()
            if (e == XmlPullParser.END_DOCUMENT) return
            if (e == XmlPullParser.END_TAG) {
                if (sp.name == "rPr") return
                continue
            }
            if (e != XmlPullParser.START_TAG) continue
            when (sp.name) {
                "b" -> { props.bold = OfficeXml.onOff(sp.attr("val")); sp.skipElement() }
                "i" -> { props.italic = OfficeXml.onOff(sp.attr("val")); sp.skipElement() }
                "u" -> { props.underline = !sp.attr("val").equals("none", ignoreCase = true); sp.skipElement() }
                "strike", "dstrike" -> { props.strike = OfficeXml.onOff(sp.attr("val")); sp.skipElement() }
                "color" -> { props.color = OfficeXml.color(sp.attr("val")); sp.skipElement() }
                "sz" -> { props.sizeHalfPt = sp.attr("val")?.toIntOrNull(); sp.skipElement() }
                "rStyle" -> { props.styleId = sp.attr("val"); sp.skipElement() }
                else -> sp.skipElement()
            }
        }
    }

    private fun hyperlinkTarget(sp: OfficeXml.SafeParser, ctx: Ctx): String? {
        val id = sp.attr(OfficeXml.R, "id") ?: sp.attr("id")
        if (id == null) return null
        val rel = ctx.rels[id] ?: return null
        if (!rel.external) return null
        return safeLink(rel.target)
    }

    private fun safeLink(raw: String): String? {
        val url = raw.trim()
        if (url.length !in 3..2048) return null
        val lower = url.lowercase()
        if (!(lower.startsWith("https://") || lower.startsWith("http://") || lower.startsWith("mailto:"))) return null
        if (url.any { it.code < 32 || it.code == 127 }) return null
        return url
    }

    private fun alignOf(value: String?): String? = when (value?.lowercase()) {
        "center", "ctr" -> "center"
        "right", "end", "r" -> "right"
        "both", "distribute", "justify", "just" -> "justify"
        "left", "start", "l" -> null
        else -> null
    }

    private fun headingOf(props: PProps, style: ResolvedStyle?): Int {
        if (style != null && style.heading > 0) return style.heading.coerceIn(1, 6)
        val outline = if (props.outline >= 0) props.outline else style?.outline ?: -1
        // A document without styles.xml can still say pStyle="Heading2"/"标题 2".
        props.styleId?.let { id -> headingFrom(id, null, outline).takeIf { it > 0 }?.let { return it } }
        if (outline in 0..8) return (outline + 1).coerceIn(1, 6)
        return 0
    }

    // ─── Images ────────────────────────────────────────────────────────────────────────────────
    private fun parseDrawing(sp: OfficeXml.SafeParser, ctx: Ctx): DocxBlock.Image? {
        val startDepth = sp.depth
        var embed: String? = null
        var external = false
        var chart = false
        var cx = 0L
        var cy = 0L
        var name: String? = null
        while (true) {
            val e = sp.next()
            if (e == XmlPullParser.END_DOCUMENT) break
            if (e == XmlPullParser.END_TAG && sp.depth < startDepth) break
            if (e != XmlPullParser.START_TAG) continue
            when (sp.name) {
                "inline", "anchor", "graphic", "graphicData", "pic", "blipFill", "nvPicPr" -> Unit
                "extent" -> {
                    cx = sp.attr("cx")?.toLongOrNull() ?: 0L
                    cy = sp.attr("cy")?.toLongOrNull() ?: 0L
                    sp.skipElement()
                }
                "blip" -> {
                    val id = sp.attr(OfficeXml.R, "embed") ?: sp.attr("embed")
                    if (id != null) embed = id
                    if (sp.attr(OfficeXml.R, "link") != null || sp.attr("link") != null) external = true
                    sp.skipElement()
                }
                "cNvPr" -> { name = sp.attr("name"); sp.skipElement() }
                "chart", "relIds" -> { chart = true; sp.skipElement() }
                else -> sp.skipElement()
            }
        }
        if (chart || external || embed == null) return null
        return ctx.image(embed!!, cx, cy, name)
    }

    private fun parsePict(sp: OfficeXml.SafeParser, ctx: Ctx): DocxBlock.Image? {
        val startDepth = sp.depth
        var id: String? = null
        var style: String? = null
        var name: String? = null
        while (true) {
            val e = sp.next()
            if (e == XmlPullParser.END_DOCUMENT) break
            if (e == XmlPullParser.END_TAG && sp.depth < startDepth) break
            if (e != XmlPullParser.START_TAG) continue
            when (sp.name) {
                "shape" -> { style = sp.attr("style"); name = sp.attr("alt") }
                "imagedata" -> { id = sp.attr(OfficeXml.R, "id") ?: sp.attr("id"); sp.skipElement() }
                else -> sp.skipElement()
            }
        }
        if (id == null) return null
        var cx = 0L
        var cy = 0L
        val s = style ?: ""
        Regex("width\\s*:\\s*([0-9.]+)pt").find(s)?.groupValues?.getOrNull(1)?.toDoubleOrNull()?.let { cx = (it * 96 / 72 * EMU_PER_PX).toLong() }
        Regex("height\\s*:\\s*([0-9.]+)pt").find(s)?.groupValues?.getOrNull(1)?.toDoubleOrNull()?.let { cy = (it * 96 / 72 * EMU_PER_PX).toLong() }
        return ctx.image(id!!, cx, cy, name)
    }

    // ─── Tables ────────────────────────────────────────────────────────────────────────────────
    private class RawCell(val blocks: List<DocxBlock>, val span: Int, val merge: String?, val fill: String?)
    private class RawRow(val cells: List<RawCell>, val header: Boolean)

    private class TableBlock(
        private val sp: OfficeXml.SafeParser,
        private val ctx: Ctx,
        private val depth: Int,
    ) {
        fun parse(): DocxBlock.Table {
            val rows = ArrayList<RawRow>()
            while (true) {
                val e = sp.next()
                if (e == XmlPullParser.END_DOCUMENT) break
                if (e == XmlPullParser.END_TAG) {
                    if (sp.name == "tbl") break
                    continue
                }
                if (e != XmlPullParser.START_TAG) continue
                when (sp.name) {
                    "tr" -> {
                        if (rows.size >= MAX_TABLE_ROWS) { ctx.truncated = true; sp.skipElement() } else rows += row()
                    }
                    "sdt" -> {
                        // Content controls around rows: read the rows inside sdtContent.
                        while (true) {
                            val x = sp.next()
                            if (x == XmlPullParser.END_DOCUMENT) break
                            if (x == XmlPullParser.END_TAG && sp.name == "sdt") break
                            if (x == XmlPullParser.START_TAG && sp.name == "sdtContent") {
                                while (true) {
                                    val y = sp.next()
                                    if (y == XmlPullParser.END_DOCUMENT) break
                                    if (y == XmlPullParser.END_TAG && sp.name == "sdtContent") break
                                    if (y == XmlPullParser.START_TAG && sp.name == "tr") rows += row() else if (y == XmlPullParser.START_TAG) sp.skipElement()
                                }
                            } else if (x == XmlPullParser.START_TAG) sp.skipElement()
                        }
                    }
                    else -> sp.skipElement()
                }
            }
            return DocxBlock.Table(layout(rows))
        }

        private fun row(): RawRow {
            val cells = ArrayList<RawCell>()
            var header = false
            while (true) {
                val e = sp.next()
                if (e == XmlPullParser.END_DOCUMENT) break
                if (e == XmlPullParser.END_TAG) {
                    if (sp.name == "tr") break
                    continue
                }
                if (e != XmlPullParser.START_TAG) continue
                when (sp.name) {
                    "trPr" -> {
                        val startDepth = sp.depth
                        while (true) {
                            val x = sp.next()
                            if (x == XmlPullParser.END_DOCUMENT) break
                            if (x == XmlPullParser.END_TAG && sp.depth < startDepth) break
                            if (x == XmlPullParser.START_TAG) {
                                if (sp.name == "tblHeader") header = OfficeXml.onOff(sp.attr("val"))
                                sp.skipElement()
                            }
                        }
                    }
                    "tc" -> {
                        if (cells.size >= MAX_TABLE_CELLS) { ctx.truncated = true; sp.skipElement() } else cells += cell()
                    }
                    "sdt" -> sp.skipElement()
                    else -> sp.skipElement()
                }
            }
            return RawRow(cells, header)
        }

        private fun cell(): RawCell {
            var span = 1
            var merge: String? = null
            var fill: String? = null
            val blocks = ArrayList<DocxBlock>()
            while (true) {
                val e = sp.next()
                if (e == XmlPullParser.END_DOCUMENT) break
                if (e == XmlPullParser.END_TAG) {
                    if (sp.name == "tc") break
                    continue
                }
                if (e != XmlPullParser.START_TAG) continue
                when (sp.name) {
                    "tcPr" -> {
                        val startDepth = sp.depth
                        while (true) {
                            val x = sp.next()
                            if (x == XmlPullParser.END_DOCUMENT) break
                            if (x == XmlPullParser.END_TAG && sp.depth < startDepth) break
                            if (x != XmlPullParser.START_TAG) continue
                            when (sp.name) {
                                "gridSpan" -> span = sp.attr("val")?.toIntOrNull()?.coerceIn(1, 64) ?: 1
                                "vMerge" -> merge = sp.attr("val")?.lowercase() ?: "continue"
                                "shd" -> fill = OfficeXml.color(sp.attr("fill"))
                                else -> Unit
                            }
                            sp.skipElement()
                        }
                    }
                    "p", "tbl", "sdt", "customXml" -> {
                        if (blocks.size < MAX_BLOCKS) {
                            if (sp.name == "p") blocks.addAll(paragraph(sp, ctx))
                            else if (sp.name == "tbl") {
                                if (depth < MAX_TABLE_DEPTH) blocks.add(TableBlock(sp, ctx, depth + 1).parse()) else sp.skipElement()
                            } else if (sp.name == "sdt") blocks.addAll(sdtBlock(sp, ctx, depth))
                            else blocks.addAll(blockContainer(sp, ctx, "customXml", depth))
                        } else {
                            ctx.truncated = true
                            sp.skipElement()
                        }
                    }
                    else -> sp.skipElement()
                }
            }
            return RawCell(blocks, span.coerceIn(1, 64), merge, fill)
        }
    }

    /** Assigns grid columns and turns vMerge restart/continue chains into rowSpans. */
    private fun layout(rows: List<RawRow>): List<DocxRow> {
        class Placed(val col: Int, val raw: RawCell, var rowSpan: Int, var covered: Boolean)
        val placed = rows.map { row ->
            var col = 0
            row.cells.map { c ->
                val p = Placed(col, c, 1, c.merge == "continue")
                col += c.span
                p
            }
        }
        for (r in placed.indices) {
            for (cell in placed[r]) {
                if (cell.raw.merge != "restart") continue
                var span = 1
                for (below in r + 1 until placed.size) {
                    val next = placed[below].firstOrNull { it.col == cell.col }
                    if (next == null || next.raw.merge != "continue") break
                    next.covered = true
                    span++
                }
                cell.rowSpan = span.coerceAtMost(placed.size - r)
            }
        }
        return rows.indices.map { r ->
            val out = placed[r].map { p ->
                DocxCell(p.col, p.raw.blocks, p.raw.span, p.rowSpan, p.covered, p.raw.fill)
            }
            DocxRow(out, rows[r].header)
        }
    }

    // ─── Context / assets ──────────────────────────────────────────────────────────────────────
    private class Ctx(
        val zip: OfficeZip,
        val main: String,
        val rels: Map<String, OfficeRels.Rel>,
        val styles: Styles,
        val numbering: Numbering,
        val assets: OfficeAssets,
    ) {
        var chars = 0
        var images = 0
        var truncated = false

        fun takeChars(raw: String): String {
            if (raw.isEmpty()) return raw
            val left = MAX_CHARS - chars
            if (left <= 0) { truncated = true; return "" }
            if (raw.length <= left) { chars += raw.length; return raw }
            truncated = true
            val cut = raw.take(left)
            chars += cut.length
            return cut
        }

        fun paragraphBase(props: PProps): RunProps =
            merge(styles.get(props.styleId)?.run ?: RunProps(), props.run)

        fun effectiveRun(base: RunProps, own: RunProps): RunProps {
            var merged = merge(base, styles.get(own.styleId)?.run)
            merged = merge(merged, own)
            return merged
        }

        private fun merge(base: RunProps, over: RunProps?): RunProps {
            if (over == null) return clone(base)
            return RunProps().also {
                it.bold = over.bold ?: base.bold
                it.italic = over.italic ?: base.italic
                it.underline = over.underline ?: base.underline
                it.strike = over.strike ?: base.strike
                it.color = over.color ?: base.color
                it.sizeHalfPt = over.sizeHalfPt ?: base.sizeHalfPt
                it.styleId = over.styleId
            }
        }

        private fun clone(r: RunProps) = RunProps().also {
            it.bold = r.bold; it.italic = r.italic; it.underline = r.underline; it.strike = r.strike
            it.color = r.color; it.sizeHalfPt = r.sizeHalfPt; it.styleId = r.styleId
        }

        fun image(relId: String, cx: Long, cy: Long, name: String?): DocxBlock.Image? {
            if (images >= MAX_IMAGES) { truncated = true; return null }
            val rel = rels[relId] ?: return null
            if (rel.external) return null
            val part = OfficeRels.resolve(main, rel.target) ?: return null
            val mime = imageMime(part) ?: return null
            val bytes = try {
                zip.read(part, MAX_IMAGE_BYTES) ?: return null
            } catch (_: OfficeException) {
                truncated = true
                return null
            }
            val asset = try {
                assets.put(part, bytes, mime)
            } catch (_: Exception) {
                null
            } ?: return null
            images++
            var w = (cx / EMU_PER_PX).toInt()
            var h = (cy / EMU_PER_PX).toInt()
            if (w <= 0 && h <= 0) { w = 320; h = 240 }
            else if (w <= 0) w = (h * 4 / 3).coerceAtLeast(16)
            else if (h <= 0) h = (w * 3 / 4).coerceAtLeast(16)
            return DocxBlock.Image(asset, w.coerceIn(16, 2048), h.coerceIn(16, 2048), name?.take(120))
        }
    }

    private fun imageMime(part: String): String? = when (part.substringAfterLast('.', "").lowercase()) {
        "png" -> "image/png"
        "jpg", "jpeg" -> "image/jpeg"
        "gif" -> "image/gif"
        "webp" -> "image/webp"
        "bmp" -> "image/bmp"
        else -> null // SVG/EMF/WMF/TIFF are not shown by the WebView
    }

    // ─── Styles ────────────────────────────────────────────────────────────────────────────────
    private class ResolvedStyle(
        val id: String,
        val name: String?,
        val heading: Int,
        val outline: Int,
        val align: String?,
        val numId: Int,
        val ilvl: Int,
        val run: RunProps,
    )

    private class Styles(private val defs: Map<String, StyleDef>, private val cache: HashMap<String, ResolvedStyle>) {
        fun get(id: String?): ResolvedStyle? {
            val key = id ?: "Normal"
            cache[key]?.let { return it }
            val def = defs[key] ?: return null
            return resolve(def, HashSet(), cache)
        }

        private fun resolve(def: StyleDef, seen: MutableSet<String>, into: HashMap<String, ResolvedStyle>): ResolvedStyle {
            into[def.id]?.let { return it }
            if (!seen.add(def.id)) return ResolvedStyle(def.id, def.name, def.heading, def.outline, def.align, def.numId, def.ilvl, def.run)
            val parent = def.basedOn?.let { defs[it] }?.let { resolve(it, seen, into) }
            val run = RunProps().also {
                it.bold = def.run.bold ?: parent?.run?.bold
                it.italic = def.run.italic ?: parent?.run?.italic
                it.underline = def.run.underline ?: parent?.run?.underline
                it.strike = def.run.strike ?: parent?.run?.strike
                it.color = def.run.color ?: parent?.run?.color
                it.sizeHalfPt = def.run.sizeHalfPt ?: parent?.run?.sizeHalfPt
            }
            val outline = if (def.outline >= 0) def.outline else parent?.outline ?: -1
            val name = def.name ?: parent?.name
            val heading = headingFrom(def.id, name, outline)
            val resolved = ResolvedStyle(
                def.id, name, heading, outline,
                def.align ?: parent?.align,
                if (def.numId >= 0) def.numId else parent?.numId ?: -1,
                if (def.numId >= 0) def.ilvl else parent?.ilvl ?: 0,
                run,
            )
            into[def.id] = resolved
            return resolved
        }

        companion object {
            fun parse(zip: OfficeZip, main: String): Styles {
                val part = OfficeRels.partOfType(zip, main, "/styles") ?: "word/styles.xml"
                if (!zip.has(part)) return Styles(emptyMap(), HashMap())
                val sp = OfficeXml.parser(zip, part, 8 * 1024 * 1024) ?: return Styles(emptyMap(), HashMap())
                val defs = HashMap<String, StyleDef>()
                try {
                    while (true) {
                        val e = sp.next()
                        if (e == XmlPullParser.END_DOCUMENT) break
                        if (e != XmlPullParser.START_TAG) continue
                        if (sp.name == "styles") continue
                        if (sp.name != "style") { sp.skipElement(); continue }
                        val id = sp.attr("styleId")
                        if (id == null) { sp.skipElement(); continue }
                        val def = StyleDef(id)
                        while (true) {
                            val x = sp.next()
                            if (x == XmlPullParser.END_DOCUMENT) break
                            if (x == XmlPullParser.END_TAG && sp.name == "style") break
                            if (x != XmlPullParser.START_TAG) continue
                            when (sp.name) {
                                "name" -> { def.name = sp.attr("val"); sp.skipElement() }
                                "basedOn" -> { def.basedOn = sp.attr("val"); sp.skipElement() }
                                "pPr" -> parseStylePPr(sp, def)
                                "rPr" -> parseStyleRPr(sp, def.run)
                                else -> sp.skipElement()
                            }
                        }
                        defs[id] = def
                    }
                } catch (e: OfficeException) {
                    throw e
                } catch (e: Exception) {
                    throw OfficeException("office_xml", "Word 的样式表已损坏", e)
                }
                return Styles(defs, HashMap())
            }

            private fun parseStylePPr(sp: OfficeXml.SafeParser, def: StyleDef) {
                while (true) {
                    val e = sp.next()
                    if (e == XmlPullParser.END_DOCUMENT) return
                    if (e == XmlPullParser.END_TAG) {
                        if (sp.name == "pPr") return
                        continue
                    }
                    if (e != XmlPullParser.START_TAG) continue
                    when (sp.name) {
                        "jc" -> { def.align = alignOf(sp.attr("val")); sp.skipElement() }
                        "outlineLvl" -> { def.outline = sp.attr("val")?.toIntOrNull() ?: -1; sp.skipElement() }
                        "numPr" -> {
                            while (true) {
                                val x = sp.next()
                                if (x == XmlPullParser.END_DOCUMENT) return
                                if (x == XmlPullParser.END_TAG && sp.name == "numPr") break
                                if (x != XmlPullParser.START_TAG) continue
                                when (sp.name) {
                                    "numId" -> def.numId = sp.attr("val")?.toIntOrNull() ?: -1
                                    "ilvl" -> def.ilvl = sp.attr("val")?.toIntOrNull()?.coerceIn(0, 8) ?: 0
                                    else -> Unit
                                }
                                sp.skipElement()
                            }
                        }
                        else -> sp.skipElement()
                    }
                }
            }

            private fun parseStyleRPr(sp: OfficeXml.SafeParser, run: RunProps) {
                while (true) {
                    val e = sp.next()
                    if (e == XmlPullParser.END_DOCUMENT) return
                    if (e == XmlPullParser.END_TAG) {
                        if (sp.name == "rPr") return
                        continue
                    }
                    if (e != XmlPullParser.START_TAG) continue
                    when (sp.name) {
                        "b" -> run.bold = OfficeXml.onOff(sp.attr("val"))
                        "i" -> run.italic = OfficeXml.onOff(sp.attr("val"))
                        "u" -> run.underline = !sp.attr("val").equals("none", ignoreCase = true)
                        "strike", "dstrike" -> run.strike = OfficeXml.onOff(sp.attr("val"))
                        "color" -> run.color = OfficeXml.color(sp.attr("val"))
                        "sz" -> run.sizeHalfPt = sp.attr("val")?.toIntOrNull()
                        else -> Unit
                    }
                    sp.skipElement()
                }
            }
        }
    }

    private class StyleDef(val id: String) {
        var name: String? = null
        var basedOn: String? = null
        var heading = 0
        var outline = -1
        var align: String? = null
        var numId = -1
        var ilvl = 0
        val run = RunProps()
    }

    private fun headingFrom(id: String, name: String?, outline: Int): Int {
        val text = (name ?: "") + " " + id
        Regex("(?i)heading\\s*([1-9])").find(text)?.groupValues?.getOrNull(1)?.toIntOrNull()?.let { return it.coerceIn(1, 6) }
        Regex("标题\\s*([1-9])").find(text)?.groupValues?.getOrNull(1)?.toIntOrNull()?.let { return it.coerceIn(1, 6) }
        if (id.equals("Title", ignoreCase = true)) return 1
        if (outline in 0..8) return (outline + 1).coerceIn(1, 6)
        return 0
    }

    // ─── Numbering ─────────────────────────────────────────────────────────────────────────────
    private class NumLevel(val format: String, val text: String, val start: Int)
    private class Numbering(private val levels: Map<Int, Map<Int, NumLevel>>) {
        private val counters = HashMap<Int, IntArray>()

        /** (marker, ordered) for the next item of this list. */
        fun marker(numId: Int, ilvl: Int): Pair<String, Boolean> {
            val byLevel = levels[numId] ?: return "•" to false
            val level = ilvl.coerceIn(0, 8)
            val lv = byLevel[level] ?: byLevel[0] ?: return "•" to false
            val counts = counters.getOrPut(numId) { IntArray(9) }
            if (counts[level] < lv.start) counts[level] = lv.start else counts[level]++
            for (i in level + 1 until 9) counts[i] = 0
            val ordered = lv.format !in setOf("bullet", "none", "")
            if (!ordered) return (lv.text.ifBlank { "•" }) to false
            val pattern = lv.text.ifBlank { "%${level + 1}." }
            val marker = Regex("%([1-9])").replace(pattern) { m ->
                val k = m.groupValues[1].toInt() - 1
                val v = counts.getOrElse(k) { 0 }
                (if (v > 0) v else 1).toString()
            }
            return marker to true
        }

        companion object {
            fun parse(zip: OfficeZip, main: String): Numbering {
                val part = OfficeRels.partOfType(zip, main, "/numbering") ?: "word/numbering.xml"
                if (!zip.has(part)) return Numbering(emptyMap())
                val sp = OfficeXml.parser(zip, part, 8 * 1024 * 1024) ?: return Numbering(emptyMap())
                val abstract = HashMap<Int, HashMap<Int, NumLevel>>()
                val numToAbstract = HashMap<Int, Int>()
                try {
                    while (true) {
                        val e = sp.next()
                        if (e == XmlPullParser.END_DOCUMENT) break
                        if (e != XmlPullParser.START_TAG) continue
                        when (sp.name) {
                            "numbering" -> Unit
                            "abstractNum" -> {
                                val aid = sp.attr("abstractNumId")?.toIntOrNull() ?: -1
                                val levels = HashMap<Int, NumLevel>()
                                var currentIlvl = 0
                                while (true) {
                                    val x = sp.next()
                                    if (x == XmlPullParser.END_DOCUMENT) break
                                    if (x == XmlPullParser.END_TAG && sp.name == "abstractNum") break
                                    if (x != XmlPullParser.START_TAG) continue
                                    if (sp.name == "lvl") {
                                        currentIlvl = sp.attr("ilvl")?.toIntOrNull()?.coerceIn(0, 8) ?: 0
                                        var fmt = "decimal"
                                        var txt = ""
                                        var start = 1
                                        while (true) {
                                            val y = sp.next()
                                            if (y == XmlPullParser.END_DOCUMENT) break
                                            if (y == XmlPullParser.END_TAG && sp.name == "lvl") break
                                            if (y != XmlPullParser.START_TAG) continue
                                            when (sp.name) {
                                                "numFmt" -> fmt = sp.attr("val").orEmpty().ifBlank { "decimal" }
                                                "lvlText" -> txt = sp.attr("val").orEmpty()
                                                "start" -> start = sp.attr("val")?.toIntOrNull() ?: 1
                                                else -> Unit
                                            }
                                            sp.skipElement()
                                        }
                                        levels[currentIlvl] = NumLevel(fmt.lowercase(), txt, start)
                                    } else sp.skipElement()
                                }
                                if (aid >= 0) abstract[aid] = levels
                            }
                            "num" -> {
                                val nid = sp.attr("numId")?.toIntOrNull() ?: -1
                                var aid = -1
                                while (true) {
                                    val x = sp.next()
                                    if (x == XmlPullParser.END_DOCUMENT) break
                                    if (x == XmlPullParser.END_TAG && sp.name == "num") break
                                    if (x != XmlPullParser.START_TAG) continue
                                    if (sp.name == "abstractNumId") aid = sp.attr("val")?.toIntOrNull() ?: -1
                                    sp.skipElement()
                                }
                                if (nid >= 0 && aid >= 0) numToAbstract[nid] = aid
                            }
                            else -> sp.skipElement()
                        }
                    }
                } catch (e: OfficeException) {
                    throw e
                } catch (_: Exception) {
                    return Numbering(emptyMap())
                }
                val out = HashMap<Int, Map<Int, NumLevel>>()
                for ((numId, aid) in numToAbstract) abstract[aid]?.let { out[numId] = it }
                return Numbering(out)
            }
        }
    }
}
