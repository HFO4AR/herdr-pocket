package dev.herdr.pocket.office

/**
 * Reading-level Office models. Everything here is plain Kotlin/JVM: no Android, no JSON. The
 * parsers fill these and [OfficePreview] turns them into bounded JSON chunks for the page.
 *
 * Fidelity is deliberately approximate: text runs, tables, images, multiple sheets and slides are
 * complete, while columns/anchors/themes are best effort. Nothing is ever executed or fetched.
 */
class OfficeException(val code: String, message: String, cause: Throwable? = null) : Exception(message, cause)

enum class OfficeKind { DOCX, XLSX, PPTX }

/** One formatted run of text (Word run, Excel rich string, PowerPoint run). */
data class OfficeRun(
    val text: String,
    val bold: Boolean = false,
    val italic: Boolean = false,
    val underline: Boolean = false,
    val strike: Boolean = false,
    val color: String? = null,
    val sizePt: Int? = null,
    /** External http(s)/mailto target, display-only (the UI never navigates). */
    val link: String? = null,
)

data class OfficeParagraph(
    val runs: List<OfficeRun> = emptyList(),
    val align: String? = null,
    /** 1..6 for Word headings, 0 otherwise. */
    val heading: Int = 0,
    /** 0-based list level, -1 when not a list item. */
    val level: Int = -1,
    val marker: String? = null,
    val ordered: Boolean = false,
    val indentPt: Int? = null,
    val beforePt: Int? = null,
    val afterPt: Int? = null,
)

sealed class DocxBlock {
    data class Para(val paragraph: OfficeParagraph) : DocxBlock()
    data class Table(val rows: List<DocxRow>) : DocxBlock()
    data class Image(val asset: String, val widthPx: Int, val heightPx: Int, val name: String?) : DocxBlock()
    object PageBreak : DocxBlock()
}

data class DocxCell(
    /** 0-based grid column this cell starts at (spans included). */
    val col: Int,
    val blocks: List<DocxBlock>,
    val span: Int = 1,
    val rowSpan: Int = 1,
    /** A vertical-merge continuation consumed by the cell above: the UI must not render it. */
    val covered: Boolean = false,
    val fill: String? = null,
)

data class DocxRow(val cells: List<DocxCell>, val header: Boolean = false)

data class DocxDocument(val blocks: List<DocxBlock>, val truncated: Boolean, val chars: Int)

// ─── Excel ──────────────────────────────────────────────────────────────────────────────────────
data class XlsxStyle(
    val bold: Boolean = false,
    val italic: Boolean = false,
    val underline: Boolean = false,
    val strike: Boolean = false,
    val color: String? = null,
    val fill: String? = null,
    val align: String? = null,
    val valign: String? = null,
    val wrap: Boolean = false,
    val format: String? = null,
    val date: Boolean = false,
    val sizePt: Int? = null,
)

data class XlsxCell(val col: Int, val text: String, val type: String, val style: Int)
data class XlsxRow(val index: Int, val heightPx: Int?, val hidden: Boolean, val cells: List<XlsxCell>)
data class XlsxSheetMeta(val index: Int, val name: String, val hidden: Boolean)
data class XlsxMerge(val r1: Int, val c1: Int, val r2: Int, val c2: Int)

data class XlsxSheetData(
    val index: Int,
    val name: String,
    val rows: List<XlsxRow>,
    val totalRows: Int,
    val cols: Int,
    val widths: List<Int>,
    val merges: List<XlsxMerge>,
    val truncated: Boolean,
)

data class XlsxWorkbook(
    val sheets: List<XlsxSheetMeta>,
    val styles: List<XlsxStyle>,
    val shared: List<String>,
    internal val parts: List<String>,
)

// ─── PowerPoint ─────────────────────────────────────────────────────────────────────────────────
data class PptxPresentation(
    val slideCount: Int,
    val widthEmu: Long,
    val heightEmu: Long,
    internal val parts: List<String>,
)

/** [kind] is one of text, image, placeholder, table. Positions/sizes are EMU. */
data class PptxShape(
    val kind: String,
    val x: Long,
    val y: Long,
    val w: Long,
    val h: Long,
    val paragraphs: List<OfficeParagraph> = emptyList(),
    val asset: String? = null,
    val fill: String? = null,
    val name: String? = null,
    /** Placeholder/unsupported label such as 图表, SmartArt, 嵌入对象. */
    val label: String? = null,
)

data class PptxSlide(
    val index: Int,
    val widthEmu: Long,
    val heightEmu: Long,
    val background: String? = null,
    val bgAsset: String? = null,
    val shapes: List<PptxShape> = emptyList(),
    val title: String? = null,
    val truncated: Boolean = false,
)

/**
 * Receives extracted image bytes and returns an opaque asset key the page can display through the
 * preview asset URL, or null when this image cannot be shown (SVG/EMF, too large, storage full).
 * The JVM tests use an in-memory implementation; [OfficePreview] writes into the preview cache.
 */
fun interface OfficeAssets {
    fun put(part: String, bytes: ByteArray, mime: String): String?
}
