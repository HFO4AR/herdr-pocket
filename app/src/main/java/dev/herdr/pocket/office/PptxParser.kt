package dev.herdr.pocket.office

import org.xmlpull.v1.XmlPullParser
import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.ceil
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToLong
import kotlin.math.sin
import kotlin.math.tan

/**
 * PresentationML reader (`.pptx`). Parts are read into small trees (bounded by [MAX_NODES]), because
 * almost everything on a slide is inherited: a placeholder's position, size and text style come from
 * its layout and master, colours from the theme through the master's colour map, line and fill from
 * the shape's style. Master and layout artwork is drawn under the slide's own shapes.
 *
 * Output is geometry the page can draw exactly: positions in EMU, preset names or custom paths,
 * resolved colours, and text with its final size and spacing. Nothing is ever executed or fetched;
 * only images inside the archive are read. Charts are drawn from their cached numbers; SmartArt uses the
 * drawing PowerPoint saved beside it, and an embedded object its preview picture.
 */
object PptxParser {
    const val MAX_SLIDES = 200
    const val MAX_SHAPES = 1500
    const val MAX_SLIDE_CHARS = 1_000_000
    const val MAX_IMAGES = 80
    const val MAX_IMAGE_BYTES = 8 * 1024 * 1024
    private const val MAX_GROUP_DEPTH = 8
    private const val MAX_NODES = 1_000_000
    private const val MAX_PATH_OPS = 40_000
    private val TEXT_TAGS = setOf("t", "tableStyleId", "v", "formatCode")
    private const val THEME_FALLBACK = "000000,FFFFFF,1F497D,EEECE1,4F81BD,C0504D,9BBB59,8064A2,4BACC6,F79646,0000FF,800080"

    // ─── Trees ─────────────────────────────────────────────────────────────────────────────────
    internal class XNode(@JvmField val name: String) {
        @JvmField var attrs: HashMap<String, String>? = null
        @JvmField var list: ArrayList<XNode>? = null
        @JvmField var text: StringBuilder? = null
        val kids: List<XNode> get() = list ?: emptyList()
        fun attr(n: String): String? = attrs?.get(n)
        fun kid(n: String): XNode? = list?.firstOrNull { it.name == n }
        fun all(n: String): List<XNode> = list?.filter { it.name == n } ?: emptyList()
        fun at(vararg names: String): XNode? { var n: XNode? = this; for (s in names) n = n?.kid(s); return n }
        fun long(n: String): Long? = attr(n)?.toLongOrNull()
        fun on(n: String): Boolean? = attr(n)?.let { it == "1" || it.equals("true", true) || it.equals("on", true) }
    }

    private fun tree(zip: OfficeZip, part: String): XNode? {
        val sp = OfficeXml.parser(zip, part) ?: return null
        val stack = ArrayList<XNode>()
        var root: XNode? = null
        var nodes = 0
        try {
            while (true) {
                when (sp.next()) {
                    XmlPullParser.END_DOCUMENT -> return root
                    XmlPullParser.START_TAG -> {
                        if (++nodes > MAX_NODES) throw OfficeException("office_damaged", "这张幻灯片的内容太多，不能安全打开")
                        val n = XNode(sp.name ?: "")
                        val p = sp.parser
                        for (i in 0 until p.attributeCount) {
                            val v = p.getAttributeValue(i) ?: continue
                            if (v.length > OfficeXml.MAX_ATTRIBUTE) throw OfficeException("office_xml", "文档里有异常长的属性值")
                            val local = p.getAttributeName(i)
                            val map = n.attrs ?: HashMap<String, String>(4).also { n.attrs = it }
                            if (p.getAttributeNamespace(i) == OfficeXml.R) map["r:$local"] = v
                            if (local !in map) map[local] = v
                        }
                        val parent = stack.lastOrNull()
                        if (parent == null) root = n else (parent.list ?: ArrayList<XNode>(4).also { parent.list = it }).add(n)
                        stack.add(n)
                    }
                    XmlPullParser.END_TAG -> if (stack.isNotEmpty()) stack.removeAt(stack.lastIndex)
                    XmlPullParser.TEXT, XmlPullParser.CDSECT, XmlPullParser.ENTITY_REF -> {
                        val top = stack.lastOrNull()
                        if (top != null && top.name in TEXT_TAGS) {
                            val sb = top.text ?: StringBuilder().also { top.text = it }
                            if (sb.length < MAX_SLIDE_CHARS) sb.append(sp.text.take(MAX_SLIDE_CHARS - sb.length))
                        }
                    }
                }
            }
        } catch (e: OfficeException) {
            throw e
        } catch (e: Exception) {
            throw OfficeException("office_damaged", "这张幻灯片已损坏，读不出来", e)
        }
    }

    // ─── Presentation ──────────────────────────────────────────────────────────────────────────
    fun parse(zip: OfficeZip, assets: OfficeAssets): PptxPresentation {
        val main = OfficeRels.mainPart(zip, "ppt/presentation.xml")
        if (!zip.has(main)) throw OfficeException("office_damaged", "这个 PowerPoint 文档没有演示内容")
        val rels = OfficeRels.parse(zip, main)
        val root = tree(zip, main) ?: throw OfficeException("office_damaged", "这个 PowerPoint 文档没有演示内容")
        val size = root.kid("sldSz")
        val width = size?.long("cx")?.takeIf { it > 0 } ?: 12_192_000L
        val height = size?.long("cy")?.takeIf { it > 0 } ?: 6_858_000L
        val parts = ArrayList<String>()
        for (id in root.kid("sldIdLst")?.all("sldId") ?: emptyList()) {
            if (parts.size >= MAX_SLIDES) break
            val rel = rels[id.attr("r:id") ?: id.attr("id") ?: continue] ?: continue
            val part = if (rel.external) null else OfficeRels.resolve(main, rel.target)
            if (part != null && zip.has(part)) parts += part
        }
        if (parts.isEmpty()) throw OfficeException("office_damaged", "这个 PowerPoint 文档没有幻灯片")
        return PptxPresentation(parts.size, width.coerceIn(914_400L, 91_440_000L), height.coerceIn(914_400L, 91_440_000L), parts)
            .also { it.defaultText = root.kid("defaultTextStyle") }
    }

    // ─── Parts around a slide ──────────────────────────────────────────────────────────────────
    private class Holder(val part: String, val root: XNode, val rels: Map<String, OfficeRels.Rel>) {
        val spTree: XNode? get() = root.at("cSld", "spTree") ?: root.kid("spTree")
        val bg: XNode? get() = root.at("cSld", "bg")
        val placeholders: List<XNode> by lazy {
            spTree?.kids?.filter { (it.name == "sp" || it.name == "pic") && phOf(it) != null } ?: emptyList()
        }
        fun clrOverride(): XNode? = root.at("clrMapOvr", "overrideClrMapping")
    }

    private class Theme(val colors: Map<String, Int>, val fills: List<XNode>, val lines: List<XNode>, val bgFills: List<XNode>)

    private fun holder(zip: OfficeZip, pres: PptxPresentation, part: String): Holder? {
        (pres.cache[part] as? Holder)?.let { return it }
        val root = tree(zip, part) ?: return null
        return Holder(part, root, OfficeRels.parse(zip, part)).also { pres.cache[part] = it }
    }

    private fun theme(zip: OfficeZip, pres: PptxPresentation, masterPart: String?): Theme {
        val part = masterPart?.let { OfficeRels.partOfType(zip, it, "/theme") }
        val key = "theme:" + (part ?: "")
        (pres.cache[key] as? Theme)?.let { return it }
        val colors = HashMap<String, Int>()
        val names = listOf("dk1", "lt1", "dk2", "lt2", "accent1", "accent2", "accent3", "accent4", "accent5", "accent6", "hlink", "folHlink")
        THEME_FALLBACK.split(',').forEachIndexed { i, v -> colors[names[i]] = v.toInt(16) }
        val root = part?.let { tree(zip, it) }
        val elements = root?.kid("themeElements")
        for (node in elements?.kid("clrScheme")?.kids ?: emptyList()) {
            val c = node.kids.firstOrNull() ?: continue
            val hex = c.attr("val").takeIf { c.name == "srgbClr" } ?: c.attr("lastClr") ?: continue
            hex.toIntOrNull(16)?.let { colors[node.name] = it }
        }
        val fmt = elements?.kid("fmtScheme")
        return Theme(colors, fmt?.kid("fillStyleLst")?.kids ?: emptyList(), fmt?.kid("lnStyleLst")?.kids ?: emptyList(), fmt?.kid("bgFillStyleLst")?.kids ?: emptyList())
            .also { pres.cache[key] = it }
    }

    private fun phOf(node: XNode): XNode? =
        (node.kid("nvSpPr") ?: node.kid("nvPicPr") ?: node.kid("nvCxnSpPr"))?.at("nvPr", "ph")

    // ─── One slide ─────────────────────────────────────────────────────────────────────────────
    private class Env(val zip: OfficeZip, val pres: PptxPresentation, val assets: OfficeAssets, val index: Int, val theme: Theme,
                      val clrMap: Map<String, String>, val master: Holder?, val layout: Holder?) {
        var chars = 0
        var images = 0
        var truncated = false
        val out = ArrayList<PptxShape>()

        fun take(raw: String): String {
            if (raw.isEmpty()) return raw
            val left = MAX_SLIDE_CHARS - chars
            if (left <= 0) { truncated = true; return "" }
            if (raw.length <= left) { chars += raw.length; return raw }
            truncated = true
            return raw.take(left).also { chars += it.length }
        }

        fun image(h: Holder, relId: String?): String? {
            val rel = h.rels[relId ?: return null] ?: return null
            if (rel.external) return null
            if (images >= MAX_IMAGES) { truncated = true; return null }
            val target = OfficeRels.resolve(h.part, rel.target) ?: return null
            val mime = when (target.substringAfterLast('.', "").lowercase()) {
                "png" -> "image/png"
                "jpg", "jpeg" -> "image/jpeg"
                "gif" -> "image/gif"
                "webp" -> "image/webp"
                "bmp" -> "image/bmp"
                else -> return null
            }
            val bytes = try { zip.read(target, MAX_IMAGE_BYTES) ?: return null } catch (_: OfficeException) { truncated = true; return null }
            val asset = try { assets.put(target, bytes, mime) } catch (_: Exception) { null } ?: return null
            images++
            return asset
        }
    }

    fun parseSlide(zip: OfficeZip, pres: PptxPresentation, index: Int, assets: OfficeAssets): PptxSlide {
        val part = pres.parts.getOrNull(index) ?: throw OfficeException("office_missing", "这张幻灯片不在文档里")
        val root = tree(zip, part) ?: throw OfficeException("office_damaged", "这张幻灯片读不出来")
        val slide = Holder(part, root, OfficeRels.parse(zip, part))
        val layout = OfficeRels.partOfType(zip, part, "/slideLayout")?.let { holder(zip, pres, it) }
        val master = layout?.let { OfficeRels.partOfType(zip, it.part, "/slideMaster") }?.let { holder(zip, pres, it) }
        val theme = theme(zip, pres, master?.part)
        val base = master?.root?.kid("clrMap")?.attrs ?: emptyMap<String, String>()
        val over = slide.clrOverride()?.attrs ?: layout?.clrOverride()?.attrs ?: emptyMap<String, String>()
        val env = Env(zip, pres, assets, index, theme, base + over, master, layout)
        try {
            // Artwork first, then the slide; placeholders of a layout or master are never drawn.
            val showLayout = root.on("showMasterSp") != false
            val showMaster = showLayout && layout?.root?.on("showMasterSp") != false
            if (showMaster && master != null) master.spTree?.let { walk(env, it.kids, master, null, 0, true, null) }
            if (showLayout && layout != null) layout.spTree?.let { walk(env, it.kids, layout, null, 0, true, null) }
            slide.spTree?.let { walk(env, it.kids, slide, null, 0, false, null) }
        } catch (e: OfficeException) {
            throw e
        } catch (e: Exception) {
            throw OfficeException("office_damaged", "这张幻灯片已损坏，读不出来", e)
        }
        var bgColor: String? = null; var bgAsset: String? = null; var bgGrad: PptxGrad? = null
        for (h in listOfNotNull(slide, layout, master)) {
            val paint = h.bg?.let { backgroundPaint(env, it, h) } ?: continue
            when (paint) {
                is Solid -> bgColor = paint.c.hex
                is Gradient -> bgGrad = paint.grad(); is Picture -> bgAsset = paint.asset
                else -> Unit
            }
            break
        }
        val own = env.out
        val title = own.firstOrNull { it.label == "title" || it.label == "ctrTitle" }
            ?.paragraphs?.joinToString(" ") { it.runs.joinToString("") { r -> r.text } }?.trim()?.take(120)?.takeIf { it.isNotEmpty() }
            ?: own.firstOrNull { it.paragraphs.any { p -> p.runs.isNotEmpty() } }
                ?.paragraphs?.firstOrNull { it.runs.isNotEmpty() }?.runs?.joinToString("") { it.text }?.trim()?.take(120)?.takeIf { it.isNotEmpty() }
        return PptxSlide(index, pres.widthEmu, pres.heightEmu, bgColor, bgAsset, own, title, env.truncated, bgGrad)
    }

    // ─── Colours ───────────────────────────────────────────────────────────────────────────────
    private class Clr(val rgb: Int, val a: Float = 1f) {
        val hex: String get() = "#%06X".format(rgb and 0xFFFFFF)
    }

    private val PRESET = mapOf("black" to 0x000000, "white" to 0xFFFFFF, "red" to 0xFF0000, "green" to 0x008000, "blue" to 0x0000FF,
        "yellow" to 0xFFFF00, "gray" to 0x808080, "grey" to 0x808080, "orange" to 0xFFA500, "purple" to 0x800080, "navy" to 0x000080)

    private fun pct(s: String?): Float? {
        val v = s?.trim() ?: return null
        return if (v.endsWith("%")) v.dropLast(1).toFloatOrNull()?.div(100f) else v.toFloatOrNull()?.div(100_000f)
    }

    private fun color(env: Env, node: XNode, ph: Clr?): Clr? {
        var rgb: Int
        var alpha = 1f
        when (node.name) {
            "srgbClr" -> rgb = node.attr("val")?.toIntOrNull(16) ?: return null
            "sysClr" -> rgb = (node.attr("lastClr") ?: if (node.attr("val") == "window") "FFFFFF" else "000000").toIntOrNull(16) ?: return null
            "prstClr" -> rgb = PRESET[node.attr("val")?.lowercase()] ?: return null
            "scrgbClr" -> {
                val f = { k: String -> (pct(node.attr(k)) ?: 0f).coerceIn(0f, 1f) }
                rgb = ((f("r") * 255).toInt() shl 16) or ((f("g") * 255).toInt() shl 8) or (f("b") * 255).toInt()
            }
            "hslClr" -> rgb = fromHsl((node.long("hue") ?: 0L) / 21_600_000f, pct(node.attr("sat")) ?: 0f, pct(node.attr("lum")) ?: 0f)
            "schemeClr" -> {
                val name = node.attr("val") ?: return null
                if (name == "phClr") { rgb = ph?.rgb ?: 0; alpha = ph?.a ?: 1f }
                else rgb = env.theme.colors[env.clrMap[name] ?: DEFAULT_MAP[name] ?: name] ?: return null
            }
            else -> return null
        }
        for (m in node.kids) {
            val v = pct(m.attr("val"))
            when (m.name) {
                "alpha" -> alpha = v ?: alpha
                "alphaMod" -> alpha *= v ?: 1f
                "lumMod", "lumOff", "satMod", "satOff" -> {
                    val hsl = toHsl(rgb)
                    when (m.name) {
                        "lumMod" -> hsl[2] *= v ?: 1f
                        "lumOff" -> hsl[2] += v ?: 0f
                        "satMod" -> hsl[1] *= v ?: 1f
                        "satOff" -> hsl[1] += v ?: 0f
                    }
                    rgb = fromHsl(hsl[0], hsl[1].coerceIn(0f, 1f), hsl[2].coerceIn(0f, 1f))
                }
                "tint" -> rgb = mix(rgb, 0xFFFFFF, v ?: 1f)
                "shade" -> rgb = mix(rgb, 0x000000, v ?: 1f)
            }
        }
        return Clr(rgb, alpha.coerceIn(0f, 1f))
    }

    private val COLOR_TAGS = setOf("srgbClr", "schemeClr", "sysClr", "prstClr", "hslClr", "scrgbClr")
    private val DEFAULT_MAP = mapOf("bg1" to "lt1", "tx1" to "dk1", "bg2" to "lt2", "tx2" to "dk2")
    private fun colorIn(env: Env, parent: XNode?, ph: Clr? = null): Clr? = parent?.kids?.firstOrNull { it.name in COLOR_TAGS }?.let { color(env, it, ph) }

    private fun mix(c: Int, to: Int, keep: Float): Int {
        fun ch(s: Int) = (((c shr s) and 255) * keep + ((to shr s) and 255) * (1 - keep)).toInt().coerceIn(0, 255)
        return (ch(16) shl 16) or (ch(8) shl 8) or ch(0)
    }

    private fun toHsl(c: Int): FloatArray {
        val r = ((c shr 16) and 255) / 255f; val g = ((c shr 8) and 255) / 255f; val b = (c and 255) / 255f
        val mx = max(r, max(g, b)); val mn = min(r, min(g, b)); val l = (mx + mn) / 2; val d = mx - mn
        if (d == 0f) return floatArrayOf(0f, 0f, l)
        val s = if (l > .5f) d / (2 - mx - mn) else d / (mx + mn)
        val h = when (mx) { r -> (g - b) / d + (if (g < b) 6 else 0); g -> (b - r) / d + 2; else -> (r - g) / d + 4 } / 6
        return floatArrayOf(h, s, l)
    }

    private fun fromHsl(h: Float, s: Float, l: Float): Int {
        if (s == 0f) { val v = (l * 255).toInt().coerceIn(0, 255); return (v shl 16) or (v shl 8) or v }
        val q = if (l < .5f) l * (1 + s) else l + s - l * s; val p = 2 * l - q
        fun ch(t0: Float): Int {
            var t = t0; if (t < 0) t += 1; if (t > 1) t -= 1
            val v = when { t < 1f / 6 -> p + (q - p) * 6 * t; t < .5f -> q; t < 2f / 3 -> p + (q - p) * (2f / 3 - t) * 6; else -> p }
            return (v * 255).toInt().coerceIn(0, 255)
        }
        return (ch(h + 1f / 3) shl 16) or (ch(h) shl 8) or ch(h - 1f / 3)
    }

    // ─── Fills ─────────────────────────────────────────────────────────────────────────────────
    private sealed class Paint
    private object NoPaint : Paint()
    private object GroupPaint : Paint()
    private class Solid(val c: Clr) : Paint()
    private class Picture(val asset: String) : Paint()
    private class Gradient(val angle: Float, val stops: List<Pair<Float, Clr>>) : Paint() {
        fun grad() = PptxGrad(angle, stops.map { PptxStop(it.first, it.second.hex, it.second.a) })
    }

    private val PAINT_TAGS = setOf("noFill", "solidFill", "gradFill", "blipFill", "pattFill", "grpFill")

    private fun paintNode(env: Env, node: XNode, h: Holder, ph: Clr?): Paint? = when (node.name) {
        "noFill" -> NoPaint
        "grpFill" -> GroupPaint
        "solidFill" -> colorIn(env, node, ph)?.let { Solid(it) }
        "pattFill" -> (colorIn(env, node.kid("fgClr"), ph) ?: colorIn(env, node.kid("bgClr"), ph))?.let { Solid(it) }
        "gradFill" -> {
            val stops = node.kid("gsLst")?.all("gs")?.mapNotNull { gs -> colorIn(env, gs, ph)?.let { (pct(gs.attr("pos")) ?: 0f) to it } }?.sortedBy { it.first } ?: emptyList()
            val angle = node.kid("lin")?.long("ang")?.let { it / 60000f } ?: 90f
            if (stops.isEmpty()) null else Gradient(angle, stops)
        }
        "blipFill" -> env.image(h, node.kid("blip")?.attr("r:embed"))?.let { Picture(it) }
        else -> null
    }

    private fun paintIn(env: Env, parent: XNode?, h: Holder, ph: Clr? = null): Paint? =
        parent?.kids?.firstOrNull { it.name in PAINT_TAGS }?.let { paintNode(env, it, h, ph) }

    /** `fillRef`: 0 none, 1.. the theme's fills tinted with the reference's own colour. */
    private fun styleFill(env: Env, ref: XNode?, h: Holder): Paint? {
        val idx = ref?.long("idx")?.toInt() ?: return null
        if (idx <= 0) return NoPaint
        val c = colorIn(env, ref)
        val node = env.theme.fills.getOrNull(idx - 1) ?: return c?.let { Solid(it) }
        // A theme picture fill is not worth a lookup in a part this shape does not belong to.
        return (if (node.name == "blipFill") null else paintNode(env, node, Holder("", node, emptyMap()), c)) ?: c?.let { Solid(it) }
    }

    private fun backgroundPaint(env: Env, bg: XNode, h: Holder): Paint? {
        bg.kid("bgPr")?.let { return paintIn(env, it, h) }
        val ref = bg.kid("bgRef") ?: return null
        val c = colorIn(env, ref)
        val idx = ref.long("idx")?.toInt() ?: 0
        val node = if (idx >= 1001) env.theme.bgFills.getOrNull(idx - 1001) else null
        return node?.takeIf { it.name != "blipFill" }?.let { paintNode(env, it, h, c) } ?: c?.let { Solid(it) }
    }

    // ─── Lines ─────────────────────────────────────────────────────────────────────────────────
    private class Ln(val c: Clr?, val w: Long?, val none: Boolean, val dash: String?, val head: PptxEnd?, val tail: PptxEnd?) {
        fun over(o: Ln?): Ln = if (o == null) this else
            Ln(o.c ?: c, o.w ?: w, if (o.none || o.c != null) o.none else none, o.dash ?: dash, o.head ?: head, o.tail ?: tail)
    }

    private fun lineOf(env: Env, ln: XNode?, ph: Clr? = null): Ln? {
        if (ln == null) return null
        val none = ln.kid("noFill") != null
        val c = colorIn(env, ln.kid("solidFill"), ph) ?: colorIn(env, ln.kid("gradFill")?.kid("gsLst")?.kid("gs"), ph)
        fun end(n: XNode?) = n?.attr("type")?.takeIf { it != "none" }?.let { PptxEnd(it, n.attr("w") ?: "med", n.attr("len") ?: "med") }
        return Ln(c, ln.long("w"), none, ln.kid("prstDash")?.attr("val")?.takeIf { it != "solid" }, end(ln.kid("headEnd")), end(ln.kid("tailEnd")))
    }

    private fun styleLine(env: Env, ref: XNode?): Ln? {
        val idx = ref?.long("idx")?.toInt() ?: return null
        if (idx <= 0) return Ln(null, null, true, null, null, null)
        val c = colorIn(env, ref)
        val theme = env.theme.lines.getOrNull(idx - 1)
        return Ln(c ?: lineOf(env, theme, c)?.c, theme?.long("w") ?: (6350L * idx), false, theme?.kid("prstDash")?.attr("val")?.takeIf { it != "solid" }, null, null)
    }

    private fun lineModel(l: Ln?): PptxLine? {
        if (l == null || l.none) return null
        val c = l.c ?: return null
        return PptxLine(c.hex, c.a, l.w ?: 9525L, l.dash, l.head, l.tail)
    }

    // ─── Tree walk ─────────────────────────────────────────────────────────────────────────────
    private class Box(var x: Double, var y: Double, var w: Double, var h: Double, var rot: Double, var flipH: Boolean, var flipV: Boolean)

    private fun boxOf(xfrm: XNode?): Box {
        val off = xfrm?.kid("off"); val ext = xfrm?.kid("ext")
        return Box((off?.long("x") ?: 0L).toDouble(), (off?.long("y") ?: 0L).toDouble(), (ext?.long("cx") ?: 0L).toDouble(), (ext?.long("cy") ?: 0L).toDouble(),
            (xfrm?.long("rot") ?: 0L) / 60000.0, xfrm?.on("flipH") == true, xfrm?.on("flipV") == true)
    }

    /** A group's mapping of its child space onto the slide (or onto its parent group). */
    private class GroupXf(xfrm: XNode?, val parent: GroupXf?) {
        private val box = boxOf(xfrm)
        private val chX = (xfrm?.kid("chOff")?.long("x") ?: 0L).toDouble()
        private val chY = (xfrm?.kid("chOff")?.long("y") ?: 0L).toDouble()
        private val chW = (xfrm?.kid("chExt")?.long("cx") ?: 0L).toDouble()
        private val chH = (xfrm?.kid("chExt")?.long("cy") ?: 0L).toDouble()

        fun apply(b: Box) {
            val sx = if (chW > 0) box.w / chW else 1.0
            val sy = if (chH > 0) box.h / chH else 1.0
            b.x = box.x + (b.x - chX) * sx; b.y = box.y + (b.y - chY) * sy; b.w *= sx; b.h *= sy
            var cx = b.x + b.w / 2; var cy = b.y + b.h / 2
            val gx = box.x + box.w / 2; val gy = box.y + box.h / 2
            if (box.flipH) { cx = 2 * gx - cx; b.flipH = !b.flipH; b.rot = -b.rot }
            if (box.flipV) { cy = 2 * gy - cy; b.flipV = !b.flipV; b.rot = -b.rot }
            if (box.rot != 0.0) {
                val a = Math.toRadians(box.rot); val dx = cx - gx; val dy = cy - gy
                cx = gx + dx * cos(a) - dy * sin(a); cy = gy + dx * sin(a) + dy * cos(a)
                b.rot += box.rot
            }
            b.x = cx - b.w / 2; b.y = cy - b.h / 2
            parent?.apply(b)
        }
    }

    private fun walk(env: Env, nodes: List<XNode>, h: Holder, group: GroupXf?, depth: Int, artworkOnly: Boolean, groupFill: Paint?) {
        for (n in nodes) {
            if (env.out.size >= MAX_SHAPES) { env.truncated = true; return }
            when (n.name) {
                "sp", "cxnSp" -> if (!(artworkOnly && phOf(n) != null)) shape(env, n, h, group, groupFill)
                "pic" -> if (!(artworkOnly && phOf(n) != null)) picture(env, n, h, group)
                "graphicFrame" -> frame(env, n, h, group)
                "grpSp" -> if (depth < MAX_GROUP_DEPTH) {
                    val pr = n.kid("grpSpPr")
                    val fill = paintIn(env, pr, h)?.takeIf { it !is GroupPaint } ?: groupFill
                    walk(env, n.kids, h, GroupXf(pr?.kid("xfrm"), group), depth + 1, artworkOnly, fill)
                } else env.truncated = true
                // Newer features come with a plain fallback, which is what can be drawn here.
                "AlternateContent" -> (n.kid("Fallback") ?: n.kid("Choice"))?.let { walk(env, it.kids, h, group, depth + 1, artworkOnly, groupFill) }
            }
        }
    }

    private fun place(b: Box, group: GroupXf?): Box { group?.apply(b); return b }

    /** The layout and master shapes a placeholder takes after: nearest first. */
    private fun chain(env: Env, ph: XNode?, h: Holder): List<XNode> {
        if (ph == null) return emptyList()
        val type = ph.attr("type") ?: "body"
        val idx = ph.attr("idx")
        val out = ArrayList<XNode>(2)
        fun typeOf(n: XNode) = phOf(n)?.attr("type") ?: "body"
        val title = type == "title" || type == "ctrTitle"
        fun same(n: XNode) = typeOf(n) == type || (title && (typeOf(n) == "title" || typeOf(n) == "ctrTitle"))
        val isSlide = h !== env.layout && h !== env.master
        if (isSlide) env.layout?.placeholders?.let { list ->
            (idx?.let { want -> list.firstOrNull { phOf(it)?.attr("idx") == want } } ?: list.firstOrNull { same(it) })?.let { out += it }
        }
        if (h !== env.master) env.master?.placeholders?.let { list ->
            val own = out.firstOrNull()?.let { typeOf(it) } ?: type
            val want = when (own) { "ctrTitle" -> "title"; "dt", "ftr", "sldNum", "title", "hdr" -> own; else -> "body" }
            list.firstOrNull { typeOf(it) == want }?.let { out += it }
        }
        return out
    }

    private fun name(c: XNode?): String? = c?.attr("name")?.take(120)?.takeIf { it.isNotEmpty() }

    private fun shape(env: Env, n: XNode, h: Holder, group: GroupXf?, groupFill: Paint?) {
        val nv = n.kid("nvSpPr") ?: n.kid("nvCxnSpPr")
        val cNv = nv?.kid("cNvPr")
        if (cNv?.on("hidden") == true) return
        val ph = phOf(n)
        val above = chain(env, ph, h)
        val pr = n.kid("spPr")
        val style = n.kid("style") ?: above.firstNotNullOfOrNull { it.kid("style") }
        val box = place(boxOf(pr?.kid("xfrm") ?: above.firstNotNullOfOrNull { it.kid("spPr")?.kid("xfrm") }), group)
        val geomNode = (listOf(pr) + above.map { it.kid("spPr") }).firstNotNullOfOrNull { it?.kid("prstGeom") ?: it?.kid("custGeom") }

        var paint: Paint? = paintIn(env, pr, h)
        if (paint == null) for (a in above) { paint = paintIn(env, a.kid("spPr"), h); if (paint != null) break }
        if (paint == null) paint = styleFill(env, style?.kid("fillRef"), h)
        if (paint is GroupPaint) paint = groupFill

        var line = styleLine(env, style?.kid("lnRef"))
        for (a in above.reversed()) line = (line ?: EMPTY_LINE).over(lineOf(env, a.kid("spPr")?.kid("ln")))
        lineOf(env, pr?.kid("ln"))?.let { line = (line ?: EMPTY_LINE).over(it) }

        val tx = n.kid("txBody")
        val fontColor = colorIn(env, style?.kid("fontRef"))
        val body = bodyOf(env, tx?.kid("bodyPr"), above.mapNotNull { it.kid("txBody")?.kid("bodyPr") }, n.kid("txXfrm"), box)
        val paragraphs = if (tx != null) paragraphs(env, tx, ph, above, h, fontColor, autofit(tx.kid("bodyPr"))) else emptyList()
        val hasText = paragraphs.any { it.runs.isNotEmpty() }

        val solid = paint as? Solid; val grad = paint as? Gradient; val pic = paint as? Picture
        val lineM = lineModel(line)
        // An empty placeholder is only a prompt in the editor; nothing shows in a slide show.
        if (!hasText && solid == null && grad == null && pic == null && lineM == null) return
        env.out += PptxShape(
            kind = if (pic != null) "image" else "text", x = box.x.roundToLong(), y = box.y.roundToLong(), w = box.w.roundToLong(), h = box.h.roundToLong(),
            paragraphs = if (hasText) paragraphs else emptyList(), asset = pic?.asset, fill = solid?.c?.hex, fillAlpha = solid?.c?.a ?: 1f,
            grad = grad?.grad(), name = name(cNv), label = ph?.let { it.attr("type") ?: "body" }, line = lineM, rot = box.rot.toFloat(), flipH = box.flipH, flipV = box.flipV,
            geom = geomNode?.takeIf { it.name == "prstGeom" }?.attr("prst")?.take(40),
            adj = geomNode?.takeIf { it.name == "prstGeom" }?.let { adjOf(it) } ?: emptyMap(),
            paths = geomNode?.takeIf { it.name == "custGeom" }?.let { pathsOf(it) } ?: emptyList(), body = body,
        )
    }
    private val EMPTY_LINE = Ln(null, null, false, null, null, null)

    private fun picture(env: Env, n: XNode, h: Holder, group: GroupXf?) {
        val cNv = n.at("nvPicPr", "cNvPr")
        if (cNv?.on("hidden") == true) return
        val above = chain(env, phOf(n), h)
        val pr = n.kid("spPr")
        val box = place(boxOf(pr?.kid("xfrm") ?: above.firstNotNullOfOrNull { it.kid("spPr")?.kid("xfrm") }), group)
        val fill = n.kid("blipFill")
        val asset = env.image(h, fill?.kid("blip")?.attr("r:embed"))
        val src = fill?.kid("srcRect")
        val crop = src?.let { s -> listOf("l", "t", "r", "b").map { (pct(s.attr(it)) ?: 0f).coerceIn(0f, .95f) }.takeIf { c -> c.any { it != 0f } && c[0] + c[2] < .98f && c[1] + c[3] < .98f } }
        env.out += PptxShape(
            kind = if (asset != null) "image" else "placeholder", x = box.x.roundToLong(), y = box.y.roundToLong(), w = box.w.roundToLong(), h = box.h.roundToLong(),
            asset = asset, name = name(cNv), label = if (asset == null) "图片" else null, line = lineModel(lineOf(env, pr?.kid("ln"))),
            rot = box.rot.toFloat(), flipH = box.flipH, flipV = box.flipV, geom = pr?.kid("prstGeom")?.attr("prst")?.take(40), adj = pr?.kid("prstGeom")?.let { adjOf(it) } ?: emptyMap(), crop = crop,
        )
    }

    private fun frame(env: Env, n: XNode, h: Holder, group: GroupXf?) {
        val cNv = n.at("nvGraphicFramePr", "cNvPr")
        if (cNv?.on("hidden") == true) return
        val xfrm = n.kid("xfrm")
        var data = n.at("graphic", "graphicData")
        val inner = data?.kid("AlternateContent")
        if (inner != null) data = inner.kid("Fallback") ?: inner.kid("Choice")
        val box = place(boxOf(xfrm), group)
        fun placeholder(label: String) { env.out += PptxShape(kind = "placeholder", x = box.x.roundToLong(), y = box.y.roundToLong(), w = box.w.roundToLong(), h = box.h.roundToLong(), name = name(cNv), label = label, rot = box.rot.toFloat()) }
        val tbl = data?.kid("tbl")
        if (tbl != null) {
            val model = tableOf(env, tbl, h)
            env.out += PptxShape(kind = "table", x = box.x.roundToLong(), y = box.y.roundToLong(), w = box.w.roundToLong(), h = box.h.roundToLong(), name = name(cNv), label = "表格", table = model, rot = box.rot.toFloat())
            return
        }
        val pic = data?.kid("oleObj")?.let { it.kid("pic") ?: it.at("objectPr")?.kid("pic") } ?: data?.kid("pic")
        if (pic != null) {
            val before = env.out.size
            picture(env, pic, h, group)
            // Its own xfrm is the object's size at creation; the frame says where it is now.
            if (env.out.size > before && xfrm != null) env.out[before] = env.out[before].copy(x = box.x.roundToLong(), y = box.y.roundToLong(), w = box.w.roundToLong(), h = box.h.roundToLong())
            return
        }
        val rel = data?.kid("relIds")
        if (rel != null) {
            if (!diagram(env, rel, h, xfrm, group)) placeholder("SmartArt")
            return
        }
        when {
            data?.kid("chart") != null -> {
                val chart = chartOf(env, data.kid("chart")!!, h)
                if (chart == null) placeholder("图表")
                else env.out += PptxShape(kind = "chart", x = box.x.roundToLong(), y = box.y.roundToLong(), w = box.w.roundToLong(), h = box.h.roundToLong(), name = name(cNv), label = "图表", chart = chart, rot = box.rot.toFloat())
            }
            data?.kid("oleObj") != null -> placeholder("嵌入对象")
            data != null -> placeholder("嵌入对象")
        }
    }

    /** SmartArt: PowerPoint saves the laid-out shapes beside the data; they are ordinary shapes in the frame's space. */
    private fun diagram(env: Env, relIds: XNode, h: Holder, xfrm: XNode?, group: GroupXf?): Boolean {
        val dataPart = h.rels[relIds.attr("r:dm") ?: return false]?.takeIf { !it.external }?.let { OfficeRels.resolve(h.part, it.target) } ?: return false
        val data = tree(env.zip, dataPart) ?: return false
        val ext = data.at("extLst", "ext", "dataModelExt")
        val drawingPart = h.rels[ext?.attr("relId") ?: return false]?.takeIf { !it.external }?.let { OfficeRels.resolve(h.part, it.target) } ?: return false
        val root = tree(env.zip, drawingPart) ?: return false
        val holder = Holder(drawingPart, root, OfficeRels.parse(env.zip, drawingPart))
        val nodes = holder.spTree?.kids ?: return false
        walk(env, nodes, holder, FrameXf(boxOf(xfrm), group), 1, false, null)
        return true
    }

    private fun FrameXf(frame: Box, group: GroupXf?): GroupXf {
        val x = XNode("xfrm")
        fun node(name: String, vararg kv: Pair<String, Long>) = XNode(name).also { n -> n.attrs = HashMap(kv.associate { it.first to it.second.toString() }) }
        x.list = arrayListOf(
            node("off", "x" to frame.x.toLong(), "y" to frame.y.toLong()),
            node("ext", "cx" to frame.w.toLong(), "cy" to frame.h.toLong()),
            node("chOff", "x" to 0L, "y" to 0L),
            node("chExt", "cx" to frame.w.toLong(), "cy" to frame.h.toLong()),
        )
        return GroupXf(x, group)
    }

    // ─── Charts ────────────────────────────────────────────────────────────────────────────────
    private val CHART_KINDS = mapOf("barChart" to "bar", "bar3DChart" to "bar", "lineChart" to "line", "line3DChart" to "line", "areaChart" to "area", "area3DChart" to "area",
        "pieChart" to "pie", "pie3DChart" to "pie", "ofPieChart" to "pie", "doughnutChart" to "doughnut", "scatterChart" to "scatter", "radarChart" to "line")

    /** A chart's own cached numbers (the embedded workbook is never opened). Null when it cannot be drawn: it stays a labelled box. */
    private fun chartOf(env: Env, ref: XNode, h: Holder): PptxChart? {
        val part = h.rels[ref.attr("r:id") ?: return null]?.takeIf { !it.external }?.let { OfficeRels.resolve(h.part, it.target) } ?: return null
        val root = tree(env.zip, part) ?: return null
        val chart = root.kid("chart") ?: return null
        val plot = chart.kid("plotArea") ?: return null
        val group = plot.kids.firstOrNull { it.name in CHART_KINDS } ?: return null
        val kind = CHART_KINDS[group.name] ?: return null
        fun cached(n: XNode?): Map<Int, String> {
            val cache = n?.kids?.firstOrNull { it.name.endsWith("Ref") || it.name.endsWith("Lit") }?.let { r -> r.kids.firstOrNull { it.name.endsWith("Cache") } ?: r } ?: n?.kid("strLit") ?: n?.kid("numLit") ?: return emptyMap()
            val level = cache.kid("lvl") ?: cache
            val out = LinkedHashMap<Int, String>()
            for (pt in level.all("pt")) { val i = pt.long("idx")?.toInt() ?: continue; if (i in 0..2000) out[i] = env.take(pt.kid("v")?.text?.toString().orEmpty()) }
            return out
        }
        fun text(n: XNode?): String? = n?.kid("rich")?.all("p")?.joinToString("\n") { p -> p.all("r").joinToString("") { it.kid("t")?.text?.toString().orEmpty() } }?.trim()?.takeIf { it.isNotEmpty() } ?: cached(n).values.firstOrNull()
        fun sizeOf(n: XNode?): Float? {
            val p = n?.kid("txPr")?.kid("p") ?: n?.at("tx", "rich")?.kid("p")
            return (p?.at("pPr", "defRPr") ?: p?.at("r", "rPr"))?.attr("sz")?.toFloatOrNull()?.div(100f)
        }
        val base = sizeOf(root) ?: 10f
        fun accent(i: Int) = env.theme.colors["accent${i % 6 + 1}"]?.let { Clr(it).hex }
        val vary = group.kid("varyColors")?.attr("val") != "0" && kind in setOf("pie", "doughnut")
        val series = ArrayList<PptxSeries>()
        var cats: Map<Int, String> = emptyMap()
        for ((i, ser) in group.all("ser").take(64).withIndex()) {
            val valueNode = ser.kid("val") ?: ser.kid("yVal")
            val raw = cached(valueNode)
            val xs = cached(ser.kid("xVal"))
            if (cats.isEmpty()) cats = cached(ser.kid("cat"))
            val pr = ser.kid("spPr")
            val color = (colorIn(env, pr?.kid("solidFill")) ?: colorIn(env, pr?.kid("ln")?.kid("solidFill")))?.hex ?: accent(ser.kid("idx")?.attr("val")?.toIntOrNull() ?: i)
            val count = (raw.keys.maxOrNull() ?: -1) + 1
            val points = HashMap<String, String>()
            if (vary) for (k in 0 until count) accent(k)?.let { points[k.toString()] = it }
            for (pt in ser.all("dPt")) { val k = pt.kid("idx")?.attr("val") ?: continue; colorIn(env, pt.kid("spPr")?.kid("solidFill"))?.let { points[k] = it.hex } }
            val labels = ser.kid("dLbls") ?: group.kid("dLbls")
            fun show(k: String) = labels?.kid(k)?.attr("val") == "1"
            val format = labels?.kid("numFmt")?.attr("formatCode") ?: valueNode?.at("numRef", "numCache", "formatCode")?.text?.toString()
            series += PptxSeries(text(ser.kid("tx")) ?: cached(ser.kid("tx")).values.firstOrNull() ?: "", color, (0 until count).map { raw[it]?.toDoubleOrNull() }, (0 until count).map { xs[it]?.toDoubleOrNull() }.takeIf { xs.isNotEmpty() },
                points, show("showVal"), show("showPercent"), show("showCatName"), format?.take(32), sizeOf(labels))
        }
        if (series.isEmpty() || series.all { s -> s.values.all { it == null } }) return null
        val catAx = plot.kid("catAx") ?: plot.kid("dateAx") ?: plot.all("valAx").takeIf { kind == "scatter" }?.firstOrNull()
        val valAx = if (kind == "scatter") plot.all("valAx").getOrNull(1) else plot.kid("valAx")
        val auto = chart.kid("autoTitleDeleted")?.attr("val") == "1"
        val title = chart.kid("title")?.let { text(it.kid("tx")) ?: series.singleOrNull()?.name?.takeIf { _ -> it.kid("tx") == null } } ?: series.singleOrNull()?.name?.takeIf { !auto && kind in setOf("pie", "doughnut") }
        val count = max((cats.keys.maxOrNull() ?: -1) + 1, series.maxOf { it.values.size })
        return PptxChart(kind, group.kid("barDir")?.attr("val") == "bar", group.kid("grouping")?.attr("val")?.takeIf { it == "stacked" || it == "percentStacked" }, title, sizeOf(chart.kid("title")) ?: (base * 1.4f),
            (0 until count).map { cats[it] ?: "" }, series, chart.kid("legend")?.kid("legendPos")?.attr("val") ?: "r".takeIf { chart.kid("legend") != null }, sizeOf(chart.kid("legend")) ?: base,
            catAx?.at("scaling", "orientation")?.attr("val") == "maxMin", catAx?.kid("delete")?.attr("val") == "1", valAx?.kid("delete")?.attr("val") == "1",
            valAx?.kid("majorGridlines") != null, sizeOf(catAx) ?: base, sizeOf(valAx) ?: base, group.kid("gapWidth")?.attr("val")?.toIntOrNull() ?: 150,
            valAx?.at("scaling", "min")?.attr("val")?.toDoubleOrNull(), valAx?.at("scaling", "max")?.attr("val")?.toDoubleOrNull(), group.kid("holeSize")?.attr("val")?.toIntOrNull(),
            colorOr(env, "tx1")?.hex ?: "#000000")
    }

    // ─── Geometry ──────────────────────────────────────────────────────────────────────────────
    private fun adjOf(prst: XNode): Map<String, Long> {
        val out = HashMap<String, Long>()
        for (gd in prst.kid("avLst")?.all("gd") ?: emptyList()) {
            val n = gd.attr("name") ?: continue
            val v = gd.attr("fmla")?.trim()?.removePrefix("val ")?.trim()?.toLongOrNull() ?: continue
            out[n.take(16)] = v
        }
        return out
    }

    private fun pathsOf(cust: XNode): List<PptxPath> {
        val guides = HashMap<String, Double>()
        fun num(s: String?): Double = s?.toDoubleOrNull() ?: guides[s] ?: 0.0
        for (gd in (cust.kid("avLst")?.all("gd") ?: emptyList()) + (cust.kid("gdLst")?.all("gd") ?: emptyList())) {
            val p = gd.attr("fmla")?.trim()?.split(Regex("\\s+")) ?: continue
            val v = when (p.getOrNull(0)) {
                "val" -> num(p.getOrNull(1))
                "*/" -> num(p.getOrNull(1)) * num(p.getOrNull(2)) / num(p.getOrNull(3)).let { if (it == 0.0) 1.0 else it }
                "+-" -> num(p.getOrNull(1)) + num(p.getOrNull(2)) - num(p.getOrNull(3))
                else -> continue
            }
            gd.attr("name")?.let { guides[it] = v }
        }
        val out = ArrayList<PptxPath>()
        var ops = 0
        for (path in cust.kid("pathLst")?.all("path") ?: emptyList()) {
            val d = StringBuilder()
            var cx = 0.0; var cy = 0.0
            fun add(s: String) { d.append(s) }
            fun n(v: Double) = v.roundToLong().toString()
            for (op in path.kids) {
                if (++ops > MAX_PATH_OPS) break
                val pts = op.all("pt")
                when (op.name) {
                    "moveTo" -> pts.firstOrNull()?.let { cx = num(it.attr("x")); cy = num(it.attr("y")); add("M${n(cx)} ${n(cy)}") }
                    "lnTo" -> pts.firstOrNull()?.let { cx = num(it.attr("x")); cy = num(it.attr("y")); add("L${n(cx)} ${n(cy)}") }
                    "cubicBezTo" -> if (pts.size >= 3) {
                        add("C" + pts.take(3).joinToString(" ") { n(num(it.attr("x"))) + " " + n(num(it.attr("y"))) })
                        cx = num(pts[2].attr("x")); cy = num(pts[2].attr("y"))
                    }
                    "quadBezTo" -> if (pts.size >= 2) {
                        add("Q" + pts.take(2).joinToString(" ") { n(num(it.attr("x"))) + " " + n(num(it.attr("y"))) })
                        cx = num(pts[1].attr("x")); cy = num(pts[1].attr("y"))
                    }
                    "arcTo" -> {
                        val end = arc(d, cx, cy, num(op.attr("wR")), num(op.attr("hR")), num(op.attr("stAng")), num(op.attr("swAng")))
                        cx = end.first; cy = end.second
                    }
                    "close" -> add("Z")
                }
            }
            if (d.isNotEmpty()) out += PptxPath(path.long("w") ?: 0L, path.long("h") ?: 0L, path.attr("fill") != "none", path.on("stroke") != false, d.toString())
        }
        return out
    }

    /** DrawingML's arcTo as cubic curves, so the page can scale a path on each axis. Angles are 60000ths of a degree. */
    private fun arc(d: StringBuilder, x0: Double, y0: Double, wR: Double, hR: Double, stAng: Double, swAng: Double): Pair<Double, Double> {
        if (wR <= 0 || hR <= 0 || swAng == 0.0) return x0 to y0
        fun param(a: Double): Double { val r = Math.toRadians(a / 60000); return atan2(wR * sin(r), hR * cos(r)) }
        val st = param(stAng); var sw = param(stAng + swAng) - st
        val deg = swAng / 60000
        // The parameter wraps; keep the sweep's direction and rough size.
        while (deg > 0 && sw < 0) sw += 2 * Math.PI
        while (deg < 0 && sw > 0) sw -= 2 * Math.PI
        if (abs(deg) >= 360) sw = if (deg > 0) 2 * Math.PI else -2 * Math.PI
        val cx = x0 - wR * cos(st); val cy = y0 - hR * sin(st)
        val parts = max(1, ceil(abs(sw) / (Math.PI / 2)).toInt())
        val step = sw / parts
        val k = 4.0 / 3 * tan(step / 4)
        var a = st; var ex = x0; var ey = y0
        repeat(parts) {
            val b = a + step
            val c1x = cx + wR * (cos(a) - k * sin(a)); val c1y = cy + hR * (sin(a) + k * cos(a))
            ex = cx + wR * cos(b); ey = cy + hR * sin(b)
            val c2x = ex + wR * k * sin(b); val c2y = ey - hR * k * cos(b)
            d.append("C${c1x.roundToLong()} ${c1y.roundToLong()} ${c2x.roundToLong()} ${c2y.roundToLong()} ${ex.roundToLong()} ${ey.roundToLong()}")
            a = b
        }
        return ex to ey
    }

    // ─── Text ──────────────────────────────────────────────────────────────────────────────────
    private class Bu(val kind: String, val text: String = "", val type: String = "", val start: Int = 1)

    private data class Lvl(
        val sz: Float? = null, val b: Boolean? = null, val i: Boolean? = null, val u: Boolean? = null, val s: Boolean? = null, val c: Clr? = null, val base: Int? = null,
        val al: String? = null, val marL: Long? = null, val ind: Long? = null, val lnPct: Float? = null, val lnPt: Float? = null,
        val befPct: Float? = null, val befPt: Float? = null, val aftPct: Float? = null, val aftPt: Float? = null, val bu: Bu? = null, val buC: Clr? = null, val buSz: Float? = null,
    ) {
        operator fun plus(o: Lvl) = Lvl(o.sz ?: sz, o.b ?: b, o.i ?: i, o.u ?: u, o.s ?: s, o.c ?: c, o.base ?: base, o.al ?: al, o.marL ?: marL, o.ind ?: ind,
            o.lnPct ?: if (o.lnPt != null) null else lnPct, o.lnPt ?: if (o.lnPct != null) null else lnPt,
            o.befPct ?: if (o.befPt != null) null else befPct, o.befPt ?: if (o.befPct != null) null else befPt,
            o.aftPct ?: if (o.aftPt != null) null else aftPct, o.aftPt ?: if (o.aftPct != null) null else aftPt, o.bu ?: bu, o.buC ?: buC, o.buSz ?: buSz)
    }

    private fun runProps(env: Env, n: XNode?): Lvl {
        if (n == null) return Lvl()
        val u = n.attr("u"); val strike = n.attr("strike")
        return Lvl(sz = n.attr("sz")?.toFloatOrNull()?.let { it / 100 }?.takeIf { it > 0 }, b = n.on("b"), i = n.on("i"),
            u = u?.let { !it.equals("none", true) }, s = strike?.let { !it.equals("noStrike", true) }, c = colorIn(env, n.kid("solidFill")),
            base = n.attr("baseline")?.toIntOrNull()?.let { it / 1000 })
    }

    // Symbol fonts put their bullets on ordinary letters.
    private val WINGDINGS = mapOf("§" to "▪", "ü" to "✓", "Ø" to "➢", "l" to "●", "n" to "■", "q" to "❑", "v" to "❖", "o" to "□", "p" to "•", "w" to "⬥")

    private fun paraProps(env: Env, n: XNode?): Lvl {
        if (n == null) return Lvl()
        val al = when (n.attr("algn")?.lowercase()) { "ctr" -> "center"; "r" -> "right"; "just", "justlow", "dist", "thaidist" -> "justify"; "l" -> "left"; else -> null }
        fun spc(name: String): Pair<Float?, Float?> {
            val s = n.kid(name) ?: return null to null
            return pct(s.kid("spcPct")?.attr("val")) to s.kid("spcPts")?.attr("val")?.toFloatOrNull()?.div(100f)
        }
        val ln = spc("lnSpc"); val bef = spc("spcBef"); val aft = spc("spcAft")
        val font = n.kid("buFont")?.attr("typeface").orEmpty()
        val bu = when {
            n.kid("buNone") != null -> Bu("none")
            n.kid("buChar") != null -> n.kid("buChar")?.attr("char")?.take(4)?.let { Bu("char", if (font.startsWith("Wingdings", true)) WINGDINGS[it] ?: "•" else it) }
            n.kid("buAutoNum") != null -> n.kid("buAutoNum")?.let { Bu("auto", type = it.attr("type") ?: "arabicPeriod", start = it.attr("startAt")?.toIntOrNull() ?: 1) }
            else -> null
        }
        return Lvl(al = al, marL = n.long("marL"), ind = n.long("indent"), lnPct = ln.first, lnPt = ln.second, befPct = bef.first, befPt = bef.second, aftPct = aft.first, aftPt = aft.second,
            bu = bu, buC = colorIn(env, n.kid("buClr")), buSz = pct(n.kid("buSzPct")?.attr("val"))) + runProps(env, n.kid("defRPr"))
    }

    /** lvl1pPr…lvl9pPr of a list style. */
    private fun levels(env: Env, list: XNode?): Array<Lvl?> {
        val out = arrayOfNulls<Lvl>(9)
        if (list == null) return out
        val all = list.kid("defPPr")?.let { paraProps(env, it) }
        for (i in 0..8) {
            val own = list.kid("lvl${i + 1}pPr")?.let { paraProps(env, it) }
            out[i] = when { own != null && all != null -> all + own; own != null -> own; else -> all }
        }
        return out
    }

    private fun autofit(bodyPr: XNode?): Pair<Float, Float> {
        val fit = bodyPr?.kid("normAutofit") ?: return 1f to 0f
        return (pct(fit.attr("fontScale")) ?: 1f) to (pct(fit.attr("lnSpcReduction")) ?: 0f)
    }

    private fun bodyOf(env: Env, own: XNode?, above: List<XNode>, txXfrm: XNode?, box: Box): PptxBody {
        fun str(k: String) = own?.attr(k) ?: above.firstNotNullOfOrNull { it.attr(k) }
        fun ins(k: String, d: Long) = str(k)?.toLongOrNull() ?: d
        var l = ins("lIns", 91_440L); var t = ins("tIns", 45_720L); var r = ins("rIns", 91_440L); var b = ins("bIns", 45_720L)
        // SmartArt says where its text goes: inside the shape, as insets.
        if (txXfrm != null && box.rot == 0.0) {
            val tx = boxOf(txXfrm)
            l += max(0.0, tx.x - box.x).toLong(); t += max(0.0, tx.y - box.y).toLong()
            r += max(0.0, box.x + box.w - tx.x - tx.w).toLong(); b += max(0.0, box.y + box.h - tx.y - tx.h).toLong()
        }
        val anchor = when (str("anchor")) { "ctr" -> "center"; "b" -> "bottom"; else -> null }
        return PptxBody(anchor, listOf(l, t, r, b), str("wrap") != "none", str("vert")?.takeIf { it != "horz" }, str("anchorCtr") == "1")
    }

    private fun marker(bu: Bu, n: Int): String {
        fun alpha(v: Int): String { var x = v; val s = StringBuilder(); while (x > 0) { x--; s.insert(0, 'a' + x % 26); x /= 26 }; return s.toString() }
        fun roman(v: Int): String { var x = v; val s = StringBuilder(); for ((a, t) in listOf(1000 to "m", 900 to "cm", 500 to "d", 400 to "cd", 100 to "c", 90 to "xc", 50 to "l", 40 to "xl", 10 to "x", 9 to "ix", 5 to "v", 4 to "iv", 1 to "i")) while (x >= a) { s.append(t); x -= a }; return s.toString() }
        val t = bu.type
        val core = when {
            t.startsWith("alphaLc") -> alpha(n)
            t.startsWith("alphaUc") -> alpha(n).uppercase()
            t.startsWith("romanLc") -> roman(n)
            t.startsWith("romanUc") -> roman(n).uppercase()
            else -> n.toString()
        }
        return when {
            t.endsWith("ParenBoth") -> "($core)"
            t.endsWith("ParenR") -> "$core)"
            t.endsWith("Plain") -> core
            else -> "$core."
        }
    }

    private fun paragraphs(env: Env, tx: XNode, ph: XNode?, above: List<XNode>, h: Holder, fontColor: Clr?, fit: Pair<Float, Float>, base: Lvl? = null): List<OfficeParagraph> {
        // Weakest first: the deck's defaults, the master's text style, the master's and layout's own, the shape's.
        val type = ph?.attr("type") ?: "body"
        val txStyles = env.master?.root?.kid("txStyles")
        val masterStyle = if (ph == null) null else when (type) {
            "title", "ctrTitle" -> txStyles?.kid("titleStyle")
            "dt", "ftr", "sldNum", "hdr" -> txStyles?.kid("otherStyle")
            else -> txStyles?.kid("bodyStyle")
        }
        val chain = ArrayList<Array<Lvl?>>()
        chain += levels(env, env.pres.defaultText)
        chain += levels(env, masterStyle)
        for (a in above.reversed()) chain += levels(env, a.kid("txBody")?.kid("lstStyle"))
        chain += levels(env, tx.kid("lstStyle"))
        val out = ArrayList<OfficeParagraph>()
        val counters = IntArray(9)
        for (p in tx.all("p")) {
            val pPr = p.kid("pPr")
            val lvl = pPr?.attr("lvl")?.toIntOrNull()?.coerceIn(0, 8) ?: 0
            var st = base ?: Lvl()
            if (fontColor != null && st.c == null) st = st.copy(c = fontColor)
            for (c in chain) c[lvl]?.let { st += it }
            st += paraProps(env, pPr)
            val runs = ArrayList<OfficeRun>()
            fun addRun(rPr: XNode?, text: String) {
                val r = st + runProps(env, rPr)
                val pt = (r.sz ?: 18f) * fit.first
                runs += OfficeRun(env.take(text), r.b == true, r.i == true, r.u == true, r.s == true, (r.c ?: colorOr(env, "tx1"))?.hex, pt.toInt().coerceIn(1, 400), exactPt = pt, baseline = r.base?.takeIf { it != 0 })
            }
            for (k in p.kids) {
                when (k.name) {
                    "r" -> k.kid("t")?.text?.toString()?.takeIf { it.isNotEmpty() }?.let { addRun(k.kid("rPr"), it) }
                    "br" -> addRun(k.kid("rPr"), "\n")
                    "fld" -> {
                        val text = if (k.attr("type") == "slidenum") (env.index + 1).toString() else k.kid("t")?.text?.toString()
                        if (!text.isNullOrEmpty()) addRun(k.kid("rPr"), text)
                    }
                }
            }
            val first = st + runProps(env, p.kid("r")?.kid("rPr") ?: p.kid("endParaRPr"))
            val fontPt = (first.sz ?: 18f) * fit.first
            fun spacing(pc: Float?, pts: Float?) = pts ?: (pc?.let { it * fontPt * 1.2f }) ?: 0f
            val bu = st.bu
            var mark: String? = null
            if (runs.isNotEmpty() && bu != null) {
                when (bu.kind) {
                    "char" -> mark = bu.text
                    "auto" -> { if (counters[lvl] == 0) counters[lvl] = bu.start else counters[lvl]++; mark = marker(bu, counters[lvl]) }
                }
            }
            // Numbering restarts after anything else at this level, and for deeper levels below it.
            if (bu?.kind != "auto") counters[lvl] = 0
            for (d in lvl + 1..8) counters[d] = 0
            out += OfficeParagraph(runs, st.al?.takeIf { it != "left" }, level = lvl, marker = mark, ordered = bu?.kind == "auto",
                slide = PptxParaStyle(
                    marginPt = (st.marL ?: 0L) / 12700f, indentPt = (st.ind ?: 0L) / 12700f,
                    lineScale = st.lnPct?.let { max(.2f, it - fit.second) }, linePt = st.lnPt,
                    beforePt = spacing(st.befPct, st.befPt), afterPt = spacing(st.aftPct, st.aftPt), fontPt = fontPt,
                    color = first.c?.hex, markerColor = st.buC?.hex, markerScale = st.buSz,
                ))
        }
        return out
    }

    private fun colorOr(env: Env, scheme: String): Clr? =
        env.theme.colors[env.clrMap[scheme] ?: DEFAULT_MAP[scheme] ?: scheme]?.let { Clr(it) }

    // ─── Tables ────────────────────────────────────────────────────────────────────────────────
    private class CellStyle(val fill: Paint?, val text: Clr?, val bold: Boolean?, val borders: Map<String, Ln>)

    private fun cellStyle(env: Env, n: XNode?, h: Holder): CellStyle? {
        if (n == null) return null
        val tc = n.kid("tcStyle")
        val tx = n.kid("tcTxStyle")
        val fillNode = tc?.kid("fill")
        val borders = HashMap<String, Ln>()
        for (b in tc?.kid("tcBdr")?.kids ?: emptyList()) {
            val l = lineOf(env, b.kid("ln")) ?: styleLine(env, b.kid("lnRef")) ?: continue
            borders[b.name] = l
        }
        return CellStyle(paintIn(env, fillNode, h) ?: styleFill(env, tc?.kid("fillRef"), h), colorIn(env, tx?.takeIf { it.kids.any { k -> k.name in COLOR_TAGS } }) ?: colorIn(env, tx?.kid("fontRef")),
            tx?.attr("b")?.let { it == "on" }, borders)
    }

    /** The table styles Office ships with are only written to the file once edited: the common ones, by id. */
    private val MEDIUM2 = mapOf("{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}" to "accent1", "{21E4AEA4-8DFA-4A89-87EB-49C32662AFE0}" to "accent2",
        "{F5AB1C69-6EDB-4FF4-983F-18BD219EF322}" to "accent3", "{00A15C55-8517-42AA-B614-E9B94910E393}" to "accent4",
        "{7DF18680-E054-41AD-8BC1-D1AEF772440D}" to "accent5", "{93296810-A885-4BE3-A3E7-6D5BEEA58F35}" to "accent6", "{073A0DAA-6AF3-43AB-8588-CEC1D06C72B9}" to "dk1")

    private fun tableOf(env: Env, tbl: XNode, h: Holder): PptxTable {
        val tblPr = tbl.kid("tblPr")
        val idText = tblPr?.kid("tableStyleId")?.text?.toString()?.trim()?.takeIf { it.isNotEmpty() }
        val styles = if (env.zip.has("ppt/tableStyles.xml")) tree(env.zip, "ppt/tableStyles.xml") else null
        val named = idText?.let { id -> styles?.all("tblStyle")?.firstOrNull { it.attr("styleId") == id } }
        fun section(s: String) = cellStyle(env, named?.kid(s), h)
        val whole = section("wholeTbl"); val band1 = section("band1H"); val band2 = section("band2H")
        val firstRowS = section("firstRow"); val lastRowS = section("lastRow"); val firstColS = section("firstCol"); val lastColS = section("lastCol")
        val builtin = if (named == null) MEDIUM2[idText]?.let { env.theme.colors[it] } else null
        val firstRow = tblPr?.on("firstRow") == true; val lastRow = tblPr?.on("lastRow") == true
        val firstCol = tblPr?.on("firstCol") == true; val lastCol = tblPr?.on("lastCol") == true; val banded = tblPr?.on("bandRow") == true
        val cols = tbl.kid("tblGrid")?.all("gridCol")?.map { it.long("w") ?: 0L } ?: emptyList()
        val rowNodes = tbl.all("tr")
        val rows = ArrayList<PptxRow>()
        rowNodes.forEachIndexed { r, tr ->
            val cells = ArrayList<PptxCell>()
            tr.all("tc").forEachIndexed { c, tc ->
                val tcPr = tc.kid("tcPr")
                val isFirst = firstRow && r == 0; val isLast = lastRow && r == rowNodes.lastIndex
                val bandIndex = r - (if (firstRow) 1 else 0)
                val layers = ArrayList<CellStyle>()
                whole?.let { layers += it }
                if (banded && !isFirst && !isLast) (if (bandIndex % 2 == 0) band1 else band2)?.let { layers += it }
                if (firstCol && c == 0) firstColS?.let { layers += it }
                if (lastCol && c == tr.all("tc").lastIndex) lastColS?.let { layers += it }
                if (isLast) lastRowS?.let { layers += it }
                if (isFirst) firstRowS?.let { layers += it }
                var fill: Paint? = null; var text: Clr? = null; var bold: Boolean? = null
                val borders = HashMap<String, Ln>()
                fun side(name: String, value: Ln?) { if (value != null) borders[name] = value }
                for (l in layers) {
                    l.fill?.let { fill = it }; l.text?.let { text = it }; l.bold?.let { bold = it }
                    side("L", l.borders[if (c == 0) "left" else "insideV"] ?: l.borders["left"].takeIf { c == 0 })
                    side("R", l.borders[if (c == tr.all("tc").lastIndex) "right" else "insideV"])
                    side("T", l.borders[if (r == 0) "top" else "insideH"])
                    side("B", l.borders[if (r == rowNodes.lastIndex) "bottom" else "insideH"])
                }
                if (builtin != null) {
                    val white = Ln(Clr(0xFFFFFF), 12700L, false, null, null, null)
                    for (s in listOf("L", "R", "T", "B")) borders[s] = white
                    fill = Solid(Clr(if (isFirst) builtin else mix(builtin, 0xFFFFFF, if (banded && bandIndex % 2 == 0) .4f else .2f)))
                    if (isFirst) { text = Clr(0xFFFFFF); bold = true }
                }
                paintIn(env, tcPr, h)?.let { fill = it }
                for ((tag, s) in listOf("lnL" to "L", "lnR" to "R", "lnT" to "T", "lnB" to "B")) {
                    lineOf(env, tcPr?.kid(tag))?.let { own -> borders[s] = (borders[s] ?: EMPTY_LINE).over(own) }
                }
                val body = PptxBody(when (tcPr?.attr("anchor")) { "ctr" -> "center"; "b" -> "bottom"; else -> null },
                    listOf(tcPr?.long("marL") ?: 91_440L, tcPr?.long("marT") ?: 45_720L, tcPr?.long("marR") ?: 91_440L, tcPr?.long("marB") ?: 45_720L), true)
                val tx = tc.kid("txBody")
                val paras = if (tx != null) paragraphs(env, tx, null, emptyList(), h, null, 1f to 0f, Lvl(c = text, b = bold)) else emptyList()
                val solid = fill as? Solid
                cells += PptxCell(paras, body, solid?.c?.hex, solid?.c?.a ?: 1f, tc.long("gridSpan")?.toInt()?.coerceIn(1, 1000) ?: 1, tc.long("rowSpan")?.toInt()?.coerceIn(1, 1000) ?: 1,
                    tc.on("hMerge") == true || tc.on("vMerge") == true, borders.mapNotNull { (k, v) -> lineModel(v)?.let { k to it } }.toMap())
            }
            rows += PptxRow(tr.long("h") ?: 0L, cells)
        }
        return PptxTable(cols, rows)
    }
}
