package dev.herdr.pocket.office

import org.xmlpull.v1.XmlPullParser

/**
 * PresentationML reader (`.pptx`). Reads the slide order and slide size from `presentation.xml`,
 * then each slide on demand: text boxes/runs with positions in EMU, pictures, shape fills,
 * backgrounds (slide, else its layout) and placeholders for charts/SmartArt/embedded objects.
 * Layout is approximate; the reading view keeps the aspect ratio and absolute positions.
 */
object PptxParser {
    const val MAX_SLIDES = 200
    const val MAX_SHAPES = 500
    const val MAX_SLIDE_CHARS = 1_000_000
    const val MAX_IMAGES = 80
    const val MAX_IMAGE_BYTES = 8 * 1024 * 1024
    private const val MAX_GROUP_DEPTH = 3
    private const val EMU_PER_PX = 9_525L

    fun parse(zip: OfficeZip, assets: OfficeAssets): PptxPresentation {
        val main = OfficeRels.mainPart(zip, "ppt/presentation.xml")
        if (!zip.has(main)) throw OfficeException("office_damaged", "这个 PowerPoint 文档没有演示内容")
        val rels = OfficeRels.parse(zip, main)
        val sp = OfficeXml.parser(zip, main) ?: throw OfficeException("office_damaged", "这个 PowerPoint 文档没有演示内容")
        var width = 12_192_000L
        var height = 6_858_000L
        val parts = ArrayList<String>()
        try {
            while (true) {
                val e = sp.next()
                if (e == XmlPullParser.END_DOCUMENT) break
                if (e != XmlPullParser.START_TAG) continue
                when (sp.name) {
                    "presentation" -> Unit
                    "sldIdLst" -> Unit
                    "sldSz" -> {
                        width = sp.attr("cx")?.toLongOrNull()?.takeIf { it > 0 } ?: width
                        height = sp.attr("cy")?.toLongOrNull()?.takeIf { it > 0 } ?: height
                        sp.skipElement()
                    }
                    "sldId" -> {
                        if (parts.size >= MAX_SLIDES) { sp.skipElement(); continue }
                        val rid = sp.attr(OfficeXml.R, "id") ?: sp.attr("id")
                        val rel = rid?.let { rels[it] }
                        val part = rel?.takeIf { !it.external }?.let { OfficeRels.resolve(main, it.target) }
                        if (part != null && zip.has(part)) parts += part
                        sp.skipElement()
                    }
                    else -> sp.skipElement()
                }
            }
        } catch (e: OfficeException) {
            throw e
        } catch (e: Exception) {
            throw OfficeException("office_damaged", "这个 PowerPoint 文档已损坏，读不出来", e)
        }
        if (parts.isEmpty()) throw OfficeException("office_damaged", "这个 PowerPoint 文档没有幻灯片")
        return PptxPresentation(parts.size, width.coerceIn(914_400L, 91_440_000L), height.coerceIn(914_400L, 91_440_000L), parts)
    }

    fun parseSlide(zip: OfficeZip, pres: PptxPresentation, index: Int, assets: OfficeAssets): PptxSlide {
        val part = pres.parts.getOrNull(index) ?: throw OfficeException("office_missing", "这张幻灯片不在文档里")
        val rels = OfficeRels.parse(zip, part)
        val ctx = SlideCtx(zip, part, rels, assets)
        val sp = OfficeXml.parser(zip, part) ?: throw OfficeException("office_damaged", "这张幻灯片读不出来")
        var bgColor: String? = null
        var bgAsset: String? = null
        val shapes = ArrayList<PptxShape>()
        try {
            while (true) {
                val e = sp.next()
                if (e == XmlPullParser.END_DOCUMENT) break
                if (e != XmlPullParser.START_TAG) continue
                when (sp.name) {
                    "sld" -> Unit
                    "cSld" -> Unit
                    "bg" -> {
                        val bg = parseBg(sp, ctx)
                        bgColor = bg.first ?: bgColor
                        bgAsset = bg.second ?: bgAsset
                    }
                    "spTree" -> shapeTree(sp, ctx, shapes, 0)
                    else -> sp.skipElement()
                }
            }
            if (bgColor == null && bgAsset == null) {
                val layoutPart = OfficeRels.partOfType(zip, part, "/slideLayout")
                if (layoutPart != null) {
                    val layoutRels = OfficeRels.parse(zip, layoutPart)
                    val layoutCtx = SlideCtx(zip, layoutPart, layoutRels, assets)
                    val lp = OfficeXml.parser(zip, layoutPart)
                    if (lp != null) {
                        while (true) {
                            val e = lp.next()
                            if (e == XmlPullParser.END_DOCUMENT) break
                            if (e != XmlPullParser.START_TAG) continue
                            if (lp.name == "bg") {
                                val bg = parseBg(lp, layoutCtx)
                                bgColor = bg.first
                                bgAsset = bg.second
                                break
                            }
                            if (lp.name != "sldLayout" && lp.name != "cSld") lp.skipElement()
                        }
                    }
                }
            }
        } catch (e: OfficeException) {
            throw e
        } catch (e: Exception) {
            throw OfficeException("office_damaged", "这张幻灯片已损坏，读不出来", e)
        }
        val title = shapes.firstOrNull { it.label == "title" || it.label == "ctrTitle" }
            ?.paragraphs?.joinToString(" ") { it.runs.joinToString("") { r -> r.text } }?.trim()?.take(120)
            ?.takeIf { it.isNotEmpty() }
            ?: shapes.firstOrNull { it.kind == "text" && it.paragraphs.any { p -> p.runs.isNotEmpty() } }
                ?.paragraphs?.firstOrNull { it.runs.isNotEmpty() }?.runs?.joinToString("") { it.text }?.trim()?.take(120)
                ?.takeIf { it.isNotEmpty() }
        return PptxSlide(index, pres.widthEmu, pres.heightEmu, bgColor, bgAsset, shapes, title, ctx.truncated)
    }

    // ─── Shapes ────────────────────────────────────────────────────────────────────────────────
    private fun shapeTree(sp: OfficeXml.SafeParser, ctx: SlideCtx, out: MutableList<PptxShape>, depth: Int) {
        while (true) {
            val e = sp.next()
            if (e == XmlPullParser.END_DOCUMENT) return
            if (e == XmlPullParser.END_TAG) {
                if (sp.name == "spTree") return
                continue
            }
            if (e != XmlPullParser.START_TAG) continue
            if (out.size >= MAX_SHAPES) {
                ctx.truncated = true
                sp.skipElement()
                continue
            }
            when (sp.name) {
                "sp" -> parseSp(sp, ctx, out)
                "pic" -> parsePic(sp, ctx, out)
                "graphicFrame" -> parseFrame(sp, ctx, out)
                "grpSp" -> if (depth < MAX_GROUP_DEPTH) parseGroup(sp, ctx, out, depth + 1) else sp.skipElement()
                "cxnSp" -> parseSp(sp, ctx, out)
                else -> sp.skipElement()
            }
        }
    }

    private fun parseSp(sp: OfficeXml.SafeParser, ctx: SlideCtx, out: MutableList<PptxShape>) {
        var name: String? = null
        var placeholder: String? = null
        var x = 0L
        var y = 0L
        var w = 0L
        var h = 0L
        var fill: String? = null
        val paragraphs = ArrayList<OfficeParagraph>()
        while (true) {
            val e = sp.next()
            if (e == XmlPullParser.END_DOCUMENT) break
            if (e == XmlPullParser.END_TAG) {
                if (sp.name == "sp") break
                continue
            }
            if (e != XmlPullParser.START_TAG) continue
            when (sp.name) {
                "nvSpPr" -> {
                    val nv = parseNamePlaceholder(sp)
                    name = nv.first ?: name
                    placeholder = nv.second ?: placeholder
                }
                "spPr" -> {
                    val tf = parseShapeProps(sp, ctx)
                    x = tf[0]; y = tf[1]; w = tf[2]; h = tf[3]
                    fill = tf.fill
                }
                "txBody" -> paragraphs.addAll(parseTextBody(sp, ctx))
                else -> sp.skipElement()
            }
        }
        val hasText = paragraphs.any { it.runs.isNotEmpty() }
        if (!hasText && placeholder == null && fill == null) return
        out += PptxShape(
            kind = "text", x = x, y = y, w = w, h = h, paragraphs = paragraphs,
            fill = fill, name = name?.take(120), label = placeholder?.take(40),
        ).let { if (placeholder != null) it.copy(kind = "placeholder") else it }
    }

    private fun parsePic(sp: OfficeXml.SafeParser, ctx: SlideCtx, out: MutableList<PptxShape>) {
        var name: String? = null
        var x = 0L
        var y = 0L
        var w = 0L
        var h = 0L
        var asset: String? = null
        while (true) {
            val e = sp.next()
            if (e == XmlPullParser.END_DOCUMENT) break
            if (e == XmlPullParser.END_TAG) {
                if (sp.name == "pic") break
                continue
            }
            if (e != XmlPullParser.START_TAG) continue
            when (sp.name) {
                "nvPicPr" -> name = parseNamePlaceholder(sp).first ?: name
                "spPr" -> {
                    val tf = parseShapeProps(sp, ctx)
                    x = tf[0]; y = tf[1]; w = tf[2]; h = tf[3]
                }
                "blipFill" -> {
                    val id = parseBlipFill(sp)
                    if (id != null) asset = ctx.image(id)
                }
                else -> sp.skipElement()
            }
        }
        out += PptxShape(
            kind = if (asset != null) "image" else "placeholder",
            x = x, y = y, w = w, h = h, asset = asset, name = name?.take(120),
            label = if (asset == null) "图片" else null,
        )
    }

    private fun parseFrame(sp: OfficeXml.SafeParser, ctx: SlideCtx, out: MutableList<PptxShape>) {
        var x = 0L
        var y = 0L
        var w = 0L
        var h = 0L
        var label: String? = null
        val paragraphs = ArrayList<OfficeParagraph>()
        while (true) {
            val e = sp.next()
            if (e == XmlPullParser.END_DOCUMENT) break
            if (e == XmlPullParser.END_TAG) {
                if (sp.name == "graphicFrame") break
                continue
            }
            if (e != XmlPullParser.START_TAG) continue
            when (sp.name) {
                "xfrm" -> {
                    val tf = parseXfrm(sp)
                    x = tf[0]; y = tf[1]; w = tf[2]; h = tf[3]
                }
                "graphic", "graphicData" -> Unit
                "tbl" -> {
                    paragraphs.addAll(parseTable(sp, ctx))
                    label = "表格"
                }
                "chart" -> { label = "图表"; sp.skipElement() }
                "relIds" -> { label = "SmartArt"; sp.skipElement() }
                "oleObj" -> { label = "嵌入对象"; sp.skipElement() }
                else -> sp.skipElement()
            }
        }
        if (label == null && paragraphs.isEmpty()) return
        out += PptxShape(
            kind = if (paragraphs.isNotEmpty() && label == "表格") "table" else "placeholder",
            x = x, y = y, w = w, h = h, paragraphs = paragraphs, label = label,
        )
    }

    private fun parseGroup(sp: OfficeXml.SafeParser, ctx: SlideCtx, out: MutableList<PptxShape>, depth: Int) {
        var ox = 0L
        var oy = 0L
        val children = ArrayList<PptxShape>()
        while (true) {
            val e = sp.next()
            if (e == XmlPullParser.END_DOCUMENT) break
            if (e == XmlPullParser.END_TAG) {
                if (sp.name == "grpSp") break
                continue
            }
            if (e != XmlPullParser.START_TAG) continue
            when (sp.name) {
                "grpSpPr" -> {
                    val tf = parseShapeProps(sp, ctx)
                    ox = tf[0]; oy = tf[1]
                }
                "sp" -> parseSp(sp, ctx, children)
                "pic" -> parsePic(sp, ctx, children)
                "graphicFrame" -> parseFrame(sp, ctx, children)
                "grpSp" -> if (depth < MAX_GROUP_DEPTH) parseGroup(sp, ctx, children, depth + 1) else sp.skipElement()
                else -> sp.skipElement()
            }
        }
        for (shape in children) {
            if (out.size >= MAX_SHAPES) { ctx.truncated = true; return }
            out += shape.copy(x = shape.x + ox, y = shape.y + oy)
        }
    }

    private class Transform(val x: Long, val y: Long, val w: Long, val h: Long, val fill: String?) {
        operator fun get(i: Int): Long = when (i) { 0 -> x; 1 -> y; 2 -> w; else -> h }
    }

    private fun parseShapeProps(sp: OfficeXml.SafeParser, ctx: SlideCtx): Transform {
        var x = 0L
        var y = 0L
        var w = 0L
        var h = 0L
        var fill: String? = null
        while (true) {
            val e = sp.next()
            if (e == XmlPullParser.END_DOCUMENT) break
            if (e == XmlPullParser.END_TAG) {
                if (sp.name == "spPr") break
                continue
            }
            if (e != XmlPullParser.START_TAG) continue
            when (sp.name) {
                "xfrm" -> {
                    val tf = parseXfrm(sp)
                    x = tf[0]; y = tf[1]; w = tf[2]; h = tf[3]
                }
                "solidFill" -> fill = parseSolidFill(sp)
                else -> sp.skipElement()
            }
        }
        return Transform(x, y, w, h, fill)
    }

    /** `off`/`ext` at any xfrm depth (frame xfrm and shape xfrm share this). */
    private fun parseXfrm(sp: OfficeXml.SafeParser): Transform {
        var x = 0L
        var y = 0L
        var w = 0L
        var h = 0L
        val startDepth = sp.depth
        while (true) {
            val e = sp.next()
            if (e == XmlPullParser.END_DOCUMENT) break
            if (e == XmlPullParser.END_TAG && sp.depth < startDepth) break
            if (e != XmlPullParser.START_TAG) continue
            when (sp.name) {
                "off" -> {
                    x = sp.attr("x")?.toLongOrNull() ?: x
                    y = sp.attr("y")?.toLongOrNull() ?: y
                    sp.skipElement()
                }
                "ext" -> {
                    w = sp.attr("cx")?.toLongOrNull() ?: w
                    h = sp.attr("cy")?.toLongOrNull() ?: h
                    sp.skipElement()
                }
                else -> sp.skipElement()
            }
        }
        return Transform(x, y, w, h, null)
    }

    private fun parseNamePlaceholder(sp: OfficeXml.SafeParser): Pair<String?, String?> {
        var name: String? = null
        var ph: String? = null
        val startDepth = sp.depth
        while (true) {
            val e = sp.next()
            if (e == XmlPullParser.END_DOCUMENT) break
            if (e == XmlPullParser.END_TAG && sp.depth < startDepth) break
            if (e != XmlPullParser.START_TAG) continue
            when (sp.name) {
                "nvPr" -> Unit
                "cNvPr" -> { name = sp.attr("name") ?: sp.attr("descr"); sp.skipElement() }
                "ph" -> { ph = sp.attr("type") ?: "body"; sp.skipElement() }
                else -> sp.skipElement()
            }
        }
        return name to ph
    }

    private fun parseSolidFill(sp: OfficeXml.SafeParser): String? {
        var color: String? = null
        val startDepth = sp.depth
        while (true) {
            val e = sp.next()
            if (e == XmlPullParser.END_DOCUMENT) break
            if (e == XmlPullParser.END_TAG && sp.depth < startDepth) break
            if (e != XmlPullParser.START_TAG) continue
            if (sp.name == "srgbClr") {
                color = OfficeXml.color(sp.attr("val")) ?: color
                sp.skipElement()
            } else sp.skipElement()
        }
        return color
    }

    private fun parseBlipFill(sp: OfficeXml.SafeParser): String? {
        var id: String? = null
        val startDepth = sp.depth
        while (true) {
            val e = sp.next()
            if (e == XmlPullParser.END_DOCUMENT) break
            if (e == XmlPullParser.END_TAG && sp.depth < startDepth) break
            if (e != XmlPullParser.START_TAG) continue
            if (sp.name == "blip") {
                id = sp.attr(OfficeXml.R, "embed") ?: sp.attr("embed") ?: id
                sp.skipElement()
            } else sp.skipElement()
        }
        return id
    }

    // ─── Background ────────────────────────────────────────────────────────────────────────────
    private fun parseBg(sp: OfficeXml.SafeParser, ctx: SlideCtx): Pair<String?, String?> {
        var color: String? = null
        var asset: String? = null
        val startDepth = sp.depth
        while (true) {
            val e = sp.next()
            if (e == XmlPullParser.END_DOCUMENT) break
            if (e == XmlPullParser.END_TAG && sp.depth < startDepth) break
            if (e != XmlPullParser.START_TAG) continue
            when (sp.name) {
                "bgPr" -> Unit
                "solidFill" -> color = parseSolidFill(sp) ?: color
                "blipFill" -> parseBlipFill(sp)?.let { asset = ctx.image(it) ?: asset }
                else -> sp.skipElement()
            }
        }
        return color to asset
    }

    // ─── Text ──────────────────────────────────────────────────────────────────────────────────
    private fun parseTextBody(sp: OfficeXml.SafeParser, ctx: SlideCtx): List<OfficeParagraph> {
        val out = ArrayList<OfficeParagraph>()
        while (true) {
            val e = sp.next()
            if (e == XmlPullParser.END_DOCUMENT) return out
            if (e == XmlPullParser.END_TAG) {
                if (sp.name == "txBody") return out
                continue
            }
            if (e != XmlPullParser.START_TAG) continue
            if (sp.name == "p") out += parseParagraph(sp, ctx) else sp.skipElement()
        }
    }

    private fun parseParagraph(sp: OfficeXml.SafeParser, ctx: SlideCtx): OfficeParagraph {
        val runs = ArrayList<OfficeRun>()
        var align: String? = null
        var level = -1
        var marker: String? = null
        var ordered = false
        while (true) {
            val e = sp.next()
            if (e == XmlPullParser.END_DOCUMENT) break
            if (e == XmlPullParser.END_TAG) {
                if (sp.name == "p") break
                continue
            }
            if (e != XmlPullParser.START_TAG) continue
            when (sp.name) {
                "pPr" -> {
                    var charBullet: String? = null
                    var autoBullet = false
                    align = when (sp.attr("algn")?.lowercase()) {
                        "ctr" -> "center"; "r" -> "right"; "just" -> "justify"; "l" -> null; else -> align
                    }
                    level = sp.attr("lvl")?.toIntOrNull()?.coerceIn(0, 8) ?: level
                    val startDepth = sp.depth
                    while (true) {
                        val x = sp.next()
                        if (x == XmlPullParser.END_DOCUMENT) break
                        if (x == XmlPullParser.END_TAG && sp.depth < startDepth) break
                        if (x != XmlPullParser.START_TAG) continue
                        when (sp.name) {
                            "algn" -> Unit
                            "lvl" -> Unit
                            "buChar" -> charBullet = sp.attr("char")?.take(4)
                            "buAutoNum" -> autoBullet = true
                            "buNone" -> { charBullet = null; autoBullet = false }
                            else -> Unit
                        }
                        sp.skipElement()
                    }
                    if (autoBullet) { marker = "1."; ordered = true }
                    else if (charBullet != null) { marker = charBullet; ordered = false }
                    else if (level >= 0) { marker = "•"; ordered = false }
                }
                "r" -> parseRun(sp, ctx, runs)
                "br" -> { runs += OfficeRun("\n"); sp.skipElement() }
                "fld" -> parseField(sp, ctx, runs)
                else -> sp.skipElement()
            }
        }
        return OfficeParagraph(runs, align, level = level, marker = marker, ordered = ordered)
    }

    private fun parseRun(sp: OfficeXml.SafeParser, ctx: SlideCtx, runs: MutableList<OfficeRun>) {
        var bold = false
        var italic = false
        var underline = false
        var strike = false
        var color: String? = null
        var sizePt: Int? = null
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
                "rPr" -> {
                    bold = OfficeXml.explicitOn(sp.attr("b"))
                    italic = OfficeXml.explicitOn(sp.attr("i"))
                    underline = sp.attr("u") != null && !sp.attr("u").equals("none", ignoreCase = true)
                    strike = sp.attr("strike") != null && !sp.attr("strike").equals("noStrike", ignoreCase = true)
                    sizePt = sp.attr("sz")?.toFloatOrNull()?.let { (it / 100).toInt().coerceIn(4, 400) }
                    color = parseRPr(sp)
                }
                "t" -> if (text.length < MAX_SLIDE_CHARS) text.append(sp.readText(MAX_SLIDE_CHARS - text.length))
                else -> sp.skipElement()
            }
        }
        if (text.isEmpty()) return
        runs += OfficeRun(ctx.take(text.toString()), bold, italic, underline, strike, color, sizePt)
    }

    private fun parseRPr(sp: OfficeXml.SafeParser): String? {
        var color: String? = null
        val startDepth = sp.depth
        while (true) {
            val e = sp.next()
            if (e == XmlPullParser.END_DOCUMENT) break
            if (e == XmlPullParser.END_TAG && sp.depth < startDepth) break
            if (e != XmlPullParser.START_TAG) continue
            if (sp.name == "solidFill") color = parseSolidFill(sp) ?: color
            else sp.skipElement()
        }
        return color
    }

    private fun parseField(sp: OfficeXml.SafeParser, ctx: SlideCtx, runs: MutableList<OfficeRun>) {
        val startDepth = sp.depth
        while (true) {
            val e = sp.next()
            if (e == XmlPullParser.END_DOCUMENT) break
            if (e == XmlPullParser.END_TAG && sp.depth < startDepth) break
            if (e != XmlPullParser.START_TAG) continue
            if (sp.name == "t") {
                val text = sp.readText(MAX_SLIDE_CHARS)
                if (text.isNotEmpty()) runs += OfficeRun(ctx.take(text))
            }
        }
    }

    private fun parseTable(sp: OfficeXml.SafeParser, ctx: SlideCtx): List<OfficeParagraph> {
        val rows = ArrayList<OfficeParagraph>()
        while (true) {
            val e = sp.next()
            if (e == XmlPullParser.END_DOCUMENT) break
            if (e == XmlPullParser.END_TAG) {
                if (sp.name == "tbl") break
                continue
            }
            if (e != XmlPullParser.START_TAG) continue
            if (sp.name != "tr") { sp.skipElement(); continue }
            val cells = ArrayList<String>()
            while (true) {
                val x = sp.next()
                if (x == XmlPullParser.END_DOCUMENT) break
                if (x == XmlPullParser.END_TAG) {
                    if (sp.name == "tr") break
                    continue
                }
                if (x != XmlPullParser.START_TAG) continue
                if (sp.name == "tc") cells += cellText(sp, ctx) else sp.skipElement()
            }
            val text = cells.filter { it.isNotEmpty() }.joinToString(" · ")
            if (text.isNotEmpty()) rows += OfficeParagraph(listOf(OfficeRun(ctx.take(text))))
        }
        return rows
    }

    private fun cellText(sp: OfficeXml.SafeParser, ctx: SlideCtx): String {
        val sb = StringBuilder()
        val startDepth = sp.depth
        while (true) {
            val e = sp.next()
            if (e == XmlPullParser.END_DOCUMENT) break
            if (e == XmlPullParser.END_TAG && sp.depth < startDepth) break
            if (e != XmlPullParser.START_TAG) continue
            if (sp.name == "t") {
                if (sb.length < 4_000) sb.append(sp.readText(4_000 - sb.length))
            }
        }
        return ctx.take(sb.toString())
    }

    // ─── Context ──────────────────────────────────────────────────────────────────────────────
    private class SlideCtx(
        val zip: OfficeZip,
        val part: String,
        val rels: Map<String, OfficeRels.Rel>,
        val assets: OfficeAssets,
    ) {
        var chars = 0
        var images = 0
        var truncated = false

        fun take(raw: String): String {
            if (raw.isEmpty()) return raw
            val left = MAX_SLIDE_CHARS - chars
            if (left <= 0) { truncated = true; return "" }
            if (raw.length <= left) { chars += raw.length; return raw }
            truncated = true
            val cut = raw.take(left)
            chars += cut.length
            return cut
        }

        fun image(relId: String): String? {
            if (images >= MAX_IMAGES) { truncated = true; return null }
            val rel = rels[relId] ?: return null
            if (rel.external) return null
            val target = OfficeRels.resolve(part, rel.target) ?: return null
            val mime = when (target.substringAfterLast('.', "").lowercase()) {
                "png" -> "image/png"
                "jpg", "jpeg" -> "image/jpeg"
                "gif" -> "image/gif"
                "webp" -> "image/webp"
                "bmp" -> "image/bmp"
                else -> return null
            }
            val bytes = try {
                zip.read(target, MAX_IMAGE_BYTES) ?: return null
            } catch (_: OfficeException) {
                truncated = true
                return null
            }
            val asset = try {
                assets.put(target, bytes, mime)
            } catch (_: Exception) {
                null
            } ?: return null
            images++
            return asset
        }
    }
}
