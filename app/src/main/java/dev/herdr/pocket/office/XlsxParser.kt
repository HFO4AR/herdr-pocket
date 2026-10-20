package dev.herdr.pocket.office

import org.xmlpull.v1.XmlPullParser
import java.math.BigDecimal
import java.math.RoundingMode
import java.time.LocalDate
import java.time.LocalTime

/**
 * SpreadsheetML reader (`.xlsx`). Reads the workbook's sheet list and relationships, cached
 * shared strings, cell styles, cell types and cached values, merged cells, column widths and row
 * heights. Formulas are never evaluated: the cached `<v>` result is shown exactly as Excel saved it.
 *
 * Large sheets are bounded ([MAX_ROWS], [MAX_CELLS]); [OfficePreview] serves them in row chunks so
 * the page can virtualise. Images/drawings are out of scope for the reading view.
 */
object XlsxParser {
    const val MAX_ROWS = 20_000
    const val MAX_CELLS = 200_000
    const val MAX_COLS = 512
    const val MAX_SHEETS = 100
    const val MAX_SHARED = 200_000
    const val MAX_SHARED_CHARS = 8_000_000
    const val MAX_CELL_CHARS = 32_767
    const val MAX_MERGES = 5_000
    const val MAX_SHEET_CHARS = 4_000_000
    private const val DEFAULT_WIDTH = 84

    fun parse(zip: OfficeZip): XlsxWorkbook {
        val main = OfficeRels.mainPart(zip, "xl/workbook.xml")
        if (!zip.has(main)) throw OfficeException("office_damaged", "这个 Excel 文档没有工作簿内容")
        val rels = OfficeRels.parse(zip, main)
        val stylesPart = OfficeRels.partOfType(zip, main, "/styles") ?: "xl/styles.xml"
        val sharedPart = OfficeRels.partOfType(zip, main, "/sharedStrings") ?: "xl/sharedStrings.xml"
        val styles = parseStyles(zip, stylesPart)
        val shared = parseShared(zip, sharedPart)
        val sheets = ArrayList<XlsxSheetMeta>()
        val parts = ArrayList<String>()
        val sp = OfficeXml.parser(zip, main) ?: throw OfficeException("office_damaged", "这个 Excel 文档没有工作簿内容")
        try {
            while (true) {
                val e = sp.next()
                if (e == XmlPullParser.END_DOCUMENT) break
                if (e != XmlPullParser.START_TAG) continue
                if (sp.name == "workbook" || sp.name == "sheets") continue
                if (sp.name != "sheet") { sp.skipElement(); continue }
                val name = sp.attr("name")?.take(80) ?: "Sheet${sheets.size + 1}"
                val hidden = sp.attr("state").equals("hidden", ignoreCase = true) ||
                    sp.attr("state").equals("veryHidden", ignoreCase = true)
                val rid = sp.attr(OfficeXml.R, "id") ?: sp.attr("id")
                val rel = rid?.let { rels[it] }
                val part = rel?.takeIf { !it.external }?.let { OfficeRels.resolve(main, it.target) }
                sp.skipElement()
                if (part == null || !zip.has(part)) continue
                if (sheets.size >= MAX_SHEETS) break
                sheets += XlsxSheetMeta(sheets.size, name, hidden)
                parts += part
            }
        } catch (e: OfficeException) {
            throw e
        } catch (e: Exception) {
            throw OfficeException("office_damaged", "这个 Excel 文档的工作簿已损坏", e)
        }
        if (sheets.isEmpty()) throw OfficeException("office_damaged", "这个 Excel 文档没有工作表")
        return XlsxWorkbook(sheets, styles, shared, parts)
    }

    fun parseSheet(zip: OfficeZip, book: XlsxWorkbook, index: Int): XlsxSheetData {
        val part = book.parts.getOrNull(index) ?: throw OfficeException("office_missing", "这个工作表不在文档里")
        val name = book.sheets.getOrNull(index)?.name ?: "Sheet${index + 1}"
        val sp = OfficeXml.parser(zip, part) ?: throw OfficeException("office_damaged", "这个工作表读不出来")
        val rows = ArrayList<XlsxRow>()
        val widths = IntArray(MAX_COLS) { DEFAULT_WIDTH }
        val merges = ArrayList<XlsxMerge>()
        var stats = SheetStats()
        try {
            while (true) {
                val e = sp.next()
                if (e == XmlPullParser.END_DOCUMENT) break
                if (e != XmlPullParser.START_TAG) continue
                when (sp.name) {
                    "worksheet" -> Unit
                    "sheetData" -> stats = parseSheetData(sp, book, rows)
                    "cols" -> parseCols(sp, widths)
                    "mergeCells" -> parseMerges(sp, merges)
                    else -> sp.skipElement()
                }
            }
        } catch (e: OfficeException) {
            throw e
        } catch (e: Exception) {
            throw OfficeException("office_damaged", "这个工作表已损坏，读不出来", e)
        }

        var maxRow = stats.lastRow
        var maxCol = stats.lastCol
        for (m in merges) {
            if (m.r2 > maxRow) maxRow = m.r2
            if (m.c2 > maxCol) maxCol = m.c2
        }
        if (maxRow >= MAX_ROWS - 1) stats.truncated = true
        val cols = (maxCol + 1).coerceIn(1, MAX_COLS)
        val totalRows = (maxRow + 1).coerceIn(1, MAX_ROWS)
        val outWidths = (0 until cols).map { widths[it] }
        return XlsxSheetData(index, name, rows, totalRows, cols, outWidths, merges, stats.truncated)
    }

    private class SheetStats {
        var lastRow = -1
        var lastCol = -1
        var cells = 0
        var chars = 0
        var truncated = false
    }

    private fun parseSheetData(sp: OfficeXml.SafeParser, book: XlsxWorkbook, rows: MutableList<XlsxRow>): SheetStats {
        val stats = SheetStats()
        var runningRow = -1
        while (true) {
            val e = sp.next()
            if (e == XmlPullParser.END_DOCUMENT) return stats
            if (e == XmlPullParser.END_TAG) {
                if (sp.name == "sheetData") return stats
                continue
            }
            if (e != XmlPullParser.START_TAG || sp.name != "row") {
                if (e == XmlPullParser.START_TAG) sp.skipElement()
                continue
            }
            val explicit = sp.attr("r")?.toIntOrNull()
            val rowIndex = if (explicit != null) (explicit - 1).coerceAtLeast(0) else runningRow + 1
            runningRow = rowIndex
            val height = sp.attr("ht")?.toDoubleOrNull()?.let { (it * 4 / 3).toInt().coerceIn(12, 200) }
            val hidden = sp.attr("hidden")?.let { OfficeXml.onOff(it) } ?: false
            if (rows.size >= MAX_ROWS || rowIndex >= MAX_ROWS || stats.cells >= MAX_CELLS) {
                stats.truncated = true
                sp.skipElement()
                continue
            }
            val cells = ArrayList<XlsxCell>()
            var runningCol = -1
            while (true) {
                val x = sp.next()
                if (x == XmlPullParser.END_DOCUMENT) break
                if (x == XmlPullParser.END_TAG) {
                    if (sp.name == "row") break
                    continue
                }
                if (x != XmlPullParser.START_TAG) continue
                if (sp.name != "c") { sp.skipElement(); continue }
                if (stats.cells >= MAX_CELLS) {
                    stats.truncated = true
                    sp.skipElement()
                    continue
                }
                val ref = sp.attr("r")
                val col = ref?.let { columnOf(it) } ?: (runningCol + 1)
                runningCol = col
                val type = sp.attr("t")?.lowercase() ?: "n"
                val styleIndex = sp.attr("s")?.toIntOrNull()?.coerceIn(0, book.styles.lastIndex.coerceAtLeast(0)) ?: 0
                val (raw, inline) = readCell(sp)
                stats.cells++
                if (rowIndex > stats.lastRow) stats.lastRow = rowIndex
                if (col > stats.lastCol) stats.lastCol = col
                val full = cellText(type, raw, inline, book.styles.getOrNull(styleIndex), book.shared)
                val left = (MAX_SHEET_CHARS - stats.chars).coerceAtLeast(0)
                val text = if (full.length <= left) full else { stats.truncated = true; full.take(left) }
                stats.chars += text.length
                if (text.isNotEmpty() || styleIndex > 0) {
                    cells += XlsxCell(col, text.take(MAX_CELL_CHARS), type, styleIndex)
                }
            }
            rows += XlsxRow(rowIndex, height, hidden, cells.sortedBy { it.col })
        }
    }

    private fun readCell(sp: OfficeXml.SafeParser): Pair<String?, String?> {
        var raw: String? = null
        val inline = StringBuilder()
        while (true) {
            val e = sp.next()
            if (e == XmlPullParser.END_DOCUMENT) break
            if (e == XmlPullParser.END_TAG) {
                if (sp.name == "c") break
                continue
            }
            if (e != XmlPullParser.START_TAG) continue
            when (sp.name) {
                "v" -> raw = sp.readText(MAX_CELL_CHARS)
                "is" -> inline.append(readInlineString(sp))
                else -> sp.skipElement()
            }
        }
        return raw to inline.toString().ifEmpty { null }
    }

    private fun readInlineString(sp: OfficeXml.SafeParser): String {
        val sb = StringBuilder()
        while (true) {
            val e = sp.next()
            if (e == XmlPullParser.END_DOCUMENT) return sb.toString()
            if (e == XmlPullParser.END_TAG) {
                if (sp.name == "is") return sb.toString()
                continue
            }
            if (e != XmlPullParser.START_TAG) continue
            when (sp.name) {
                "t" -> if (sb.length < MAX_CELL_CHARS) sb.append(sp.readText(MAX_CELL_CHARS - sb.length))
                else -> sp.skipElement()
            }
        }
    }

    /** `"AB12"` → 27 (0-based column). */
    private fun columnOf(ref: String): Int {
        var col = 0
        var any = false
        for (c in ref) {
            when {
                c in 'A'..'Z' -> { col = col * 26 + (c - 'A' + 1); any = true }
                c in 'a'..'z' -> { col = col * 26 + (c - 'a' + 1); any = true }
                else -> if (any) break
            }
            if (col > MAX_COLS * 4) return MAX_COLS - 1
        }
        return (col - 1).coerceIn(0, MAX_COLS - 1)
    }

    private fun cellText(type: String, raw: String?, inline: String?, style: XlsxStyle?, shared: List<String>): String {
        val value = raw?.trim()
        return when (type) {
            "s" -> value?.toIntOrNull()?.let { shared.getOrNull(it) } ?: ""
            "inlinestr" -> inline ?: ""
            "str" -> raw ?: inline ?: ""
            "b" -> if (value == "1" || value.equals("true", true)) "TRUE" else "FALSE"
            "e" -> raw ?: ""
            "d" -> raw?.replace('T', ' ') ?: ""
            else -> {
                if (value.isNullOrEmpty()) return ""
                val bd = try { BigDecimal(value) } catch (_: Exception) { return raw ?: "" }
                if (style?.date == true) dateText(bd, style.format) else numberText(bd, value, style?.format)
            }
        }
    }

    private fun numberText(bd: BigDecimal, raw: String, format: String?): String {
        if (raw.length > 40) return raw
        val fmt = format?.lowercase()
        if (fmt != null && fmt.contains('@')) return raw
        var value = bd
        var suffix = ""
        if (fmt != null && fmt.contains('%')) {
            value = bd.multiply(BigDecimal(100))
            suffix = "%"
        }
        val plain = value.stripTrailingZeros().toPlainString().let { if (it == "-0") "0" else it }
        if (fmt == null || fmt == "general") return (if (plain.length > 24) raw else plain) + suffix
        if (fmt.contains('e')) return raw
        val dp = decimalPlaces(fmt)
        var text = if (dp >= 0) value.setScale(dp, RoundingMode.HALF_UP).toPlainString() else plain
        if (fmt.contains("#,##") || fmt.contains("0,000")) text = group(text)
        if (text.length > 64) text = raw
        return text + suffix
    }

    private fun decimalPlaces(fmt: String): Int {
        val first = fmt.substringBefore(';')
        val dot = first.indexOf('.')
        if (dot < 0) return if (first.contains('0')) 0 else -1
        var n = 0
        for (i in dot + 1 until first.length) {
            val c = first[i]
            if (c == '0' || c == '#') n++ else break
        }
        return if (first.substring(0, dot).contains('0') || first.substring(0, dot).contains('#')) n else -1
    }

    private fun group(text: String): String {
        val neg = text.startsWith('-')
        val body = if (neg) text.substring(1) else text
        val dot = body.indexOf('.')
        val int = if (dot < 0) body else body.substring(0, dot)
        val rest = if (dot < 0) "" else body.substring(dot)
        if (int.length <= 3) return text
        val out = StringBuilder()
        for ((i, c) in int.withIndex()) {
            if (i > 0 && (int.length - i) % 3 == 0) out.append(',')
            out.append(c)
        }
        return (if (neg) "-" else "") + out + rest
    }

    private fun dateText(bd: BigDecimal, format: String?): String {
        val days = bd.setScale(0, RoundingMode.FLOOR).toLong()
        val frac = bd.subtract(BigDecimal(days))
        val date = try {
            LocalDate.of(1899, 12, 30).plusDays(days)
        } catch (_: Exception) {
            return bd.toPlainString()
        }
        val letters = format?.let { formatLetters(it) }?.lowercase().orEmpty()
        val withDate = letters.any { it == 'y' || it == 'm' || it == 'd' }
        val withTime = frac.signum() != 0 || letters.any { it == 'h' || it == 's' }
        if (!withTime) return date.toString()
        val seconds = try {
            frac.multiply(BigDecimal(86400)).setScale(0, RoundingMode.HALF_UP).toInt().coerceIn(0, 86_399)
        } catch (_: Exception) {
            0
        }
        val time = LocalTime.ofSecondOfDay(seconds.toLong())
        val text = if (letters.contains('s')) time.toString() else time.toString().take(5)
        return if (withDate) "${date} $text" else text
    }

    /** Letters outside quotes, bracket colour/locale sections and escapes. */
    private fun formatLetters(fmt: String): String {
        val out = StringBuilder()
        var quote = false
        var i = 0
        while (i < fmt.length) {
            val c = fmt[i]
            when {
                quote -> { if (c == '"') quote = false }
                c == '"' -> quote = true
                c == '\\' || c == '_' || c == '*' -> i++
                c == '[' -> { while (i < fmt.length && fmt[i] != ']') i++ }
                else -> out.append(c)
            }
            i++
        }
        return out.toString()
    }

    private fun parseCols(sp: OfficeXml.SafeParser, widths: IntArray): Boolean {
        var any = false
        while (true) {
            val e = sp.next()
            if (e == XmlPullParser.END_DOCUMENT) return any
            if (e == XmlPullParser.END_TAG) {
                if (sp.name == "cols") return any
                continue
            }
            if (e != XmlPullParser.START_TAG) continue
            if (sp.name != "col") { sp.skipElement(); continue }
            val min = (sp.attr("min")?.toIntOrNull() ?: 1).coerceIn(1, MAX_COLS)
            val max = (sp.attr("max")?.toIntOrNull() ?: min).coerceIn(min, MAX_COLS)
            val width = sp.attr("width")?.toDoubleOrNull()
            val px = if (width != null && width > 0) (width * 7 + 5).toInt().coerceIn(20, 400) else DEFAULT_WIDTH
            for (i in min - 1..max - 1) widths[i] = px
            any = true
            sp.skipElement()
        }
    }

    private fun parseMerges(sp: OfficeXml.SafeParser, merges: MutableList<XlsxMerge>) {
        while (true) {
            val e = sp.next()
            if (e == XmlPullParser.END_DOCUMENT) return
            if (e == XmlPullParser.END_TAG) {
                if (sp.name == "mergeCells") return
                continue
            }
            if (e != XmlPullParser.START_TAG) continue
            if (sp.name != "mergeCell") { sp.skipElement(); continue }
            if (merges.size < MAX_MERGES) parseRef(sp.attr("ref"))?.let { merges += it }
            sp.skipElement()
        }
    }

    private fun parseRef(ref: String?): XlsxMerge? {
        if (ref.isNullOrBlank()) return null
        val parts = ref.split(':')
        if (parts.size !in 1..2) return null
        val a = cellRef(parts[0]) ?: return null
        val b = cellRef(parts.last()) ?: return null
        val r1 = minOf(a.first, b.first)
        val c1 = minOf(a.second, b.second)
        val r2 = maxOf(a.first, b.first)
        val c2 = maxOf(a.second, b.second)
        if (r2 >= MAX_ROWS || c2 >= MAX_COLS) return null
        return XlsxMerge(r1, c1, r2, c2)
    }

    private fun cellRef(ref: String): Pair<Int, Int>? {
        var col = 0
        var i = 0
        while (i < ref.length && (ref[i] in 'A'..'Z' || ref[i] in 'a'..'z')) {
            col = col * 26 + (ref[i].uppercaseChar() - 'A' + 1)
            i++
        }
        if (i == 0) return null
        val row = ref.substring(i).toIntOrNull() ?: return null
        return (row - 1).coerceAtLeast(0) to (col - 1).coerceAtLeast(0)
    }

    // ─── Shared strings and styles ────────────────────────────────────────────────────────────
    private fun parseShared(zip: OfficeZip, part: String): List<String> {
        if (!zip.has(part)) return emptyList()
        val sp = OfficeXml.parser(zip, part, 32 * 1024 * 1024) ?: return emptyList()
        val out = ArrayList<String>()
        var chars = 0
        try {
            while (true) {
                val e = sp.next()
                if (e == XmlPullParser.END_DOCUMENT) break
                if (e != XmlPullParser.START_TAG) continue
                if (sp.name == "sst") continue
                if (sp.name != "si") { sp.skipElement(); continue }
                if (out.size >= MAX_SHARED || chars >= MAX_SHARED_CHARS) { sp.skipElement(); continue }
                val sb = StringBuilder()
                var phonetic = false
                while (true) {
                    val x = sp.next()
                    if (x == XmlPullParser.END_DOCUMENT) break
                    if (x == XmlPullParser.END_TAG) {
                        if (sp.name == "si") break
                        if (sp.name == "rPh") phonetic = false
                        continue
                    }
                    if (x != XmlPullParser.START_TAG) continue
                    when (sp.name) {
                        "r", "rPr" -> Unit
                        "rPh" -> { phonetic = true; sp.skipElement(); phonetic = false }
                        "t" -> if (!phonetic && sb.length < MAX_CELL_CHARS) sb.append(sp.readText(MAX_CELL_CHARS - sb.length))
                        else -> sp.skipElement()
                    }
                }
                val text = sb.toString()
                out += text
                chars += text.length
            }
        } catch (e: OfficeException) {
            throw e
        } catch (e: Exception) {
            throw OfficeException("office_xml", "Excel 的共享字符串已损坏", e)
        }
        return out
    }

    private class FontDef {
        var bold = false
        var italic = false
        var underline = false
        var strike = false
        var color: String? = null
        var sizePt: Int? = null
    }

    private class XfDef {
        var numFmtId = 0
        var fontId = 0
        var fillId = 0
        var align: String? = null
        var valign: String? = null
        var wrap = false
    }

    private fun parseStyles(zip: OfficeZip, part: String): List<XlsxStyle> {
        if (!zip.has(part)) return listOf(XlsxStyle())
        val sp = OfficeXml.parser(zip, part, 16 * 1024 * 1024) ?: return listOf(XlsxStyle())
        val numFmts = HashMap<Int, String>()
        val fonts = ArrayList<FontDef>()
        val fills = ArrayList<String?>()
        val xfs = ArrayList<XfDef>()
        try {
            while (true) {
                val e = sp.next()
                if (e == XmlPullParser.END_DOCUMENT) break
                if (e != XmlPullParser.START_TAG) continue
                when (sp.name) {
                    "styleSheet" -> Unit
                    "numFmts" -> parseNumFmts(sp, numFmts)
                    "fonts" -> parseFonts(sp, fonts)
                    "fills" -> parseFills(sp, fills)
                    "cellXfs" -> parseXfs(sp, xfs)
                    else -> sp.skipElement()
                }
            }
        } catch (e: OfficeException) {
            throw e
        } catch (e: Exception) {
            throw OfficeException("office_xml", "Excel 的样式表已损坏", e)
        }
        if (xfs.isEmpty()) return listOf(XlsxStyle())
        return xfs.map { xf ->
            val font = fonts.getOrNull(xf.fontId)
            val fmt = numFmts[xf.numFmtId] ?: builtinFormat(xf.numFmtId)
            XlsxStyle(
                bold = font?.bold == true, italic = font?.italic == true,
                underline = font?.underline == true, strike = font?.strike == true,
                color = font?.color, fill = fills.getOrNull(xf.fillId),
                align = xf.align, valign = xf.valign, wrap = xf.wrap,
                format = fmt, date = isDateFormat(xf.numFmtId, fmt), sizePt = font?.sizePt,
            )
        }
    }

    private fun parseNumFmts(sp: OfficeXml.SafeParser, out: MutableMap<Int, String>) {
        while (true) {
            val e = sp.next()
            if (e == XmlPullParser.END_DOCUMENT) return
            if (e == XmlPullParser.END_TAG) {
                if (sp.name == "numFmts") return
                continue
            }
            if (e != XmlPullParser.START_TAG) continue
            if (sp.name == "numFmt") {
                val id = sp.attr("numFmtId")?.toIntOrNull()
                val code = sp.attr("formatCode")
                if (id != null && code != null && code.length <= 200) out[id] = code
            }
            sp.skipElement()
        }
    }

    private fun parseFonts(sp: OfficeXml.SafeParser, out: MutableList<FontDef>) {
        while (true) {
            val e = sp.next()
            if (e == XmlPullParser.END_DOCUMENT) return
            if (e == XmlPullParser.END_TAG) {
                if (sp.name == "fonts") return
                continue
            }
            if (e != XmlPullParser.START_TAG) continue
            if (sp.name != "font") { sp.skipElement(); continue }
            val font = FontDef()
            while (true) {
                val x = sp.next()
                if (x == XmlPullParser.END_DOCUMENT) break
                if (x == XmlPullParser.END_TAG) {
                    if (sp.name == "font") break
                    continue
                }
                if (x != XmlPullParser.START_TAG) continue
                when (sp.name) {
                    "b" -> font.bold = OfficeXml.onOff(sp.attr("val"))
                    "i" -> font.italic = OfficeXml.onOff(sp.attr("val"))
                    "u" -> font.underline = !sp.attr("val").equals("none", ignoreCase = true)
                    "strike" -> font.strike = OfficeXml.onOff(sp.attr("val"))
                    "color" -> font.color = OfficeXml.color(sp.attr("rgb"))
                    "sz" -> font.sizePt = sp.attr("val")?.toDoubleOrNull()?.toInt()?.coerceIn(4, 200)
                    else -> Unit
                }
                sp.skipElement()
            }
            out += font
        }
    }

    private fun parseFills(sp: OfficeXml.SafeParser, out: MutableList<String?>) {
        while (true) {
            val e = sp.next()
            if (e == XmlPullParser.END_DOCUMENT) return
            if (e == XmlPullParser.END_TAG) {
                if (sp.name == "fills") return
                continue
            }
            if (e != XmlPullParser.START_TAG) continue
            if (sp.name != "fill") { sp.skipElement(); continue }
            var color: String? = null
            while (true) {
                val x = sp.next()
                if (x == XmlPullParser.END_DOCUMENT) break
                if (x == XmlPullParser.END_TAG) {
                    if (sp.name == "fill") break
                    continue
                }
                if (x != XmlPullParser.START_TAG) continue
                if (sp.name == "patternFill") {
                    val type = sp.attr("patternType")
                    if (type != null && type != "none") {
                        while (true) {
                            val y = sp.next()
                            if (y == XmlPullParser.END_DOCUMENT) break
                            if (y == XmlPullParser.END_TAG && sp.name == "patternFill") break
                            if (y != XmlPullParser.START_TAG) continue
                            if (sp.name == "fgColor") color = OfficeXml.color(sp.attr("rgb")) ?: color
                            else if (sp.name == "bgColor" && color == null) color = OfficeXml.color(sp.attr("rgb"))
                            sp.skipElement()
                        }
                    } else sp.skipElement()
                } else sp.skipElement()
            }
            out += color
        }
    }

    private fun parseXfs(sp: OfficeXml.SafeParser, out: MutableList<XfDef>) {
        while (true) {
            val e = sp.next()
            if (e == XmlPullParser.END_DOCUMENT) return
            if (e == XmlPullParser.END_TAG) {
                if (sp.name == "cellXfs") return
                continue
            }
            if (e != XmlPullParser.START_TAG) continue
            if (sp.name != "xf") { sp.skipElement(); continue }
            val xf = XfDef()
            xf.numFmtId = sp.attr("numFmtId")?.toIntOrNull() ?: 0
            xf.fontId = sp.attr("fontId")?.toIntOrNull() ?: 0
            xf.fillId = sp.attr("fillId")?.toIntOrNull() ?: 0
            while (true) {
                val x = sp.next()
                if (x == XmlPullParser.END_DOCUMENT) break
                if (x == XmlPullParser.END_TAG) {
                    if (sp.name == "xf") break
                    continue
                }
                if (x != XmlPullParser.START_TAG) continue
                if (sp.name == "alignment") {
                    xf.align = when (sp.attr("horizontal")?.lowercase()) {
                        "center" -> "center"; "right" -> "right"; "justify" -> "justify"; "left" -> "left"; else -> null
                    }
                    xf.valign = when (sp.attr("vertical")?.lowercase()) {
                        "center" -> "center"; "top" -> "top"; "bottom" -> "bottom"; else -> null
                    }
                    xf.wrap = OfficeXml.onOff(sp.attr("wrapText"))
                }
                sp.skipElement()
            }
            out += xf
        }
    }

    private fun builtinFormat(id: Int): String? = when (id) {
        0 -> "General"
        1 -> "0"
        2 -> "0.00"
        3 -> "#,##0"
        4 -> "#,##0.00"
        9 -> "0%"
        10 -> "0.00%"
        11 -> "0.00E+00"
        14 -> "mm-dd-yy"
        15 -> "d-mmm-yy"
        16 -> "d-mmm"
        17 -> "mmm-yy"
        18 -> "h:mm AM/PM"
        19 -> "h:mm:ss AM/PM"
        20 -> "h:mm"
        21 -> "h:mm:ss"
        22 -> "m/d/yy h:mm"
        37, 38, 39, 40 -> "#,##0"
        45 -> "mm:ss"
        46 -> "[h]:mm:ss"
        47 -> "mmss.0"
        48 -> "##0.0E+0"
        49 -> "@"
        else -> null
    }

    private fun isDateFormat(id: Int, fmt: String?): Boolean {
        if (id in 14..22 || id in 27..36 || id in 45..47 || id in 50..58) return true
        if (fmt == null) return false
        val letters = formatLetters(fmt).lowercase()
        if (letters.contains("general")) return false
        return letters.any { it == 'y' || it == 'm' || it == 'd' || it == 'h' || it == 's' }
    }
}
