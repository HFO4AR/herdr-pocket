package dev.herdr.pocket.office

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.io.FileOutputStream
import java.io.RandomAccessFile
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

/**
 * JVM parser tests. Fixtures are real ZIP archives built with ZipOutputStream, so the same
 * OfficeZip limits, relationship resolution and pull parsing used on the phone run here. No
 * Android classes are touched: the module is pure Kotlin/JVM apart from OfficePreview's bridge.
 */
class OfficeParserTest {
    private val temp = ArrayList<File>()

    @After
    fun cleanup() {
        temp.forEach { it.delete() }
    }

    // ─── DOCX ──────────────────────────────────────────────────────────────────────────────────
    @Test
    fun docxReadsRunsTablesImagesLinksAndSkipsUnsafeContent() {
        val file = temp(zip(
            "_rels/.rels" to xml(rootRels("word/document.xml")),
            "word/_rels/document.xml.rels" to xml(docxRels()),
            "word/document.xml" to xml(DOCX_DOCUMENT),
            "word/styles.xml" to xml(DOCX_STYLES),
            "word/numbering.xml" to xml(DOCX_NUMBERING),
            "word/media/image1.png" to "fake-png-bytes".toByteArray(),
        ))
        val zip = OfficeZip.open(file)
        val assets = FakeAssets()
        val doc = DocxParser.parse(zip, assets)
        zip.close()

        assertFalse(doc.truncated)
        assertTrue(doc.blocks.size >= 6)
        val headings = doc.blocks.filterIsInstance<DocxBlock.Para>().filter { it.paragraph.heading > 0 }
        assertEquals(1, headings.size)
        assertEquals(1, headings[0].paragraph.heading)
        assertTrue("paragraph style bold reaches runs", headings[0].paragraph.runs[0].bold)

        val list = doc.blocks.filterIsInstance<DocxBlock.Para>().first { it.paragraph.marker != null }
        assertEquals("1.", list.paragraph.marker)
        assertTrue(list.paragraph.ordered)
        val styled = list.paragraph.runs.first { it.text == "粗体" }
        assertTrue(styled.bold)
        assertTrue(styled.italic)
        assertTrue(styled.underline)
        assertTrue(styled.strike)
        assertEquals("#FF0000", styled.color)
        assertEquals(14, styled.sizePt)

        val linkPara = doc.blocks.filterIsInstance<DocxBlock.Para>().first { p -> p.paragraph.runs.any { it.text == "链接" } }
        assertEquals("https://example.com/a?b=1", linkPara.paragraph.runs.first { it.text == "链接" }.link)

        val image = doc.blocks.filterIsInstance<DocxBlock.Image>().single()
        assertEquals("asset1", image.asset)
        assertEquals(100, image.widthPx)
        assertEquals(50, image.heightPx)

        val table = doc.blocks.filterIsInstance<DocxBlock.Table>().single()
        assertEquals(3, table.rows.size)
        assertEquals(1, table.rows[0].cells.size)
        assertEquals(2, table.rows[0].cells[0].span)
        val b = table.rows[1].cells.first { it.col == 0 }
        assertEquals("B", firstText(b))
        assertEquals(2, b.rowSpan)
        val continuation = table.rows[2].cells.first { it.col == 0 }
        assertTrue("vMerge continuation is covered", continuation.covered)
        assertEquals("D", firstText(table.rows[2].cells.first { it.col == 1 }))

        // Tracked changes, deleted text and equations are skipped; ordinary runs remain.
        val lastTexts = doc.blocks.filterIsInstance<DocxBlock.Para>().map { p -> p.paragraph.runs.joinToString("") { it.text } }
        assertTrue(lastTexts.any { it == "保留" })
        assertTrue(lastTexts.any { it == "正文" })
        assertFalse(lastTexts.any { it.contains("插入") || it.contains("删除") || it.contains("公式") })
    }

    // ─── XLSX ──────────────────────────────────────────────────────────────────────────────────
    @Test
    fun xlsxReadsSheetsSharedStringsStylesCachedValuesMergesAndWidths() {
        val file = temp(zip(
            "_rels/.rels" to xml(rootRels("xl/workbook.xml")),
            "xl/workbook.xml" to xml(XLSX_WORKBOOK),
            "xl/_rels/workbook.xml.rels" to xml(XLSX_WORKBOOK_RELS),
            "xl/sharedStrings.xml" to xml(XLSX_SHARED),
            "xl/styles.xml" to xml(XLSX_STYLES),
            "xl/worksheets/sheet1.xml" to xml(XLSX_SHEET1),
            "xl/worksheets/sheet2.xml" to xml(XLSX_SHEET2),
        ))
        val zip = OfficeZip.open(file)
        val book = XlsxParser.parse(zip)
        assertEquals(listOf("数据", "隐藏"), book.sheets.map { it.name })
        assertTrue(book.sheets[1].hidden)
        assertEquals("富文本", book.shared[1])
        assertEquals(3, book.styles.size)
        assertTrue(book.styles[1].bold)
        assertTrue(book.styles[1].italic)
        assertEquals("#FF0000", book.styles[1].color)
        assertEquals("#FFFF00", book.styles[1].fill)
        assertEquals("center", book.styles[1].align)
        assertTrue(book.styles[1].wrap)

        val sheet = XlsxParser.parseSheet(zip, book, 0)
        assertEquals(4, sheet.totalRows)
        assertEquals(3, sheet.cols)
        assertEquals(145, sheet.widths[0])
        assertEquals(32, sheet.rows[0].heightPx)
        assertEquals("名称", sheet.rows[0].cells[0].text)
        assertEquals("富文本", sheet.rows[0].cells[1].text)
        assertEquals("内联", sheet.rows[0].cells[2].text)

        val row2 = sheet.rows.first { it.index == 1 }
        assertEquals("42", row2.cells[0].text)
        assertEquals(1, row2.cells[0].style)
        assertTrue("date style formats the serial value", Regex("\\d{4}-\\d{2}-\\d{2}").matches(row2.cells[1].text))
        assertEquals("TRUE", row2.cells[2].text)

        val row3 = sheet.rows.first { it.index == 2 }
        assertEquals("42", row3.cells[0].text) // the formula's cached value, not evaluated
        assertEquals("#DIV/0!", row3.cells[1].text)
        val row4 = sheet.rows.first { it.index == 3 }
        assertEquals("缓存", row4.cells[0].text)

        val merge = sheet.merges.single()
        assertEquals(2, merge.r1)
        assertEquals(0, merge.c1)
        assertEquals(2, merge.r2)
        assertEquals(1, merge.c2)
        zip.close()
    }

    // ─── PPTX ──────────────────────────────────────────────────────────────────────────────────
    @Test
    fun pptxReadsSlideOrderSizeBackgroundTextImageAndPlaceholders() {
        val file = temp(zip(
            "_rels/.rels" to xml(rootRels("ppt/presentation.xml")),
            "ppt/presentation.xml" to xml(PPTX_PRESENTATION),
            "ppt/_rels/presentation.xml.rels" to xml(PPTX_PRESENTATION_RELS),
            "ppt/slides/slide1.xml" to xml(PPTX_SLIDE1),
            "ppt/slides/_rels/slide1.xml.rels" to xml(PPTX_SLIDE1_RELS),
            "ppt/slides/slide2.xml" to xml(PPTX_SLIDE2),
            "ppt/media/image1.png" to "fake-png-bytes".toByteArray(),
        ))
        val zip = OfficeZip.open(file)
        val assets = FakeAssets()
        val pres = PptxParser.parse(zip, assets)
        assertEquals(2, pres.slideCount)
        assertEquals(12_192_000L, pres.widthEmu)
        assertEquals(6_858_000L, pres.heightEmu)

        val slide = PptxParser.parseSlide(zip, pres, 0, assets)
        assertEquals("#EEF2FF", slide.background)
        assertEquals("季度报告", slide.title)
        assertEquals(4, slide.shapes.size)

        val title = slide.shapes.first { it.label == "title" }
        assertEquals(914_400L, title.x)
        assertEquals(457_200L, title.y)
        assertEquals(10_058_400L, title.w)
        assertEquals("center", title.paragraphs[0].align)
        val run = title.paragraphs[0].runs[0]
        assertEquals(40, run.sizePt)
        assertTrue(run.bold)
        assertEquals("#112233", run.color)

        val body = slide.shapes.first { it.name == "正文" }
        assertEquals("•", body.paragraphs[0].marker)
        assertTrue(body.paragraphs[0].runs[0].italic)

        val image = slide.shapes.first { it.kind == "image" }
        assertEquals("asset1", image.asset)
        assertEquals(6_000_000L, image.x)

        val chart = slide.shapes.first { it.label == "图表" }
        assertEquals("placeholder", chart.kind)
        zip.close()
    }

    // ─── Safety ────────────────────────────────────────────────────────────────────────────────
    @Test
    fun rejectsPathTraversalEntries() {
        val file = temp(zip("../evil.xml" to xml("<root/>")))
        val e = expectOffice(file) { OfficeZip.open(it) }
        assertEquals("office_zip", e.code)
    }

    @Test
    fun rejectsZipBombRatio() {
        val bomb = ByteArray(2 * 1024 * 1024) { 'A'.code.toByte() }
        val file = temp(zip("word/document.xml" to bomb))
        val e = expectOffice(file) { OfficeZip.open(it) }
        assertEquals("office_zip", e.code)
    }

    @Test
    fun rejectsTooManyEntries() {
        val entries = (0 until 2001).map { "f$it" to ByteArray(0) }
        val file = temp(zip(*entries.toTypedArray()))
        val e = expectOffice(file) { OfficeZip.open(it) }
        assertEquals("office_zip", e.code)
    }

    @Test
    fun rejectsEncryptedEntryFlag() {
        val file = temp(zip("word/document.xml" to xml("<root/>")))
        markEncrypted(file)
        val e = expectOffice(file) { OfficeZip.open(it) }
        assertEquals("office_encrypted", e.code)
    }

    @Test
    fun rejectsDoctypeAndEntityDeclarations() {
        val xxe = "<?xml version=\"1.0\"?><!DOCTYPE foo [<!ENTITY xxe SYSTEM \"file:///etc/passwd\">]><root>&xxe;</root>"
        val e = runCatching { OfficeXml.parser(xxe.toByteArray()) }.exceptionOrNull()
        assertTrue(e is OfficeException)
        assertEquals("office_xml", (e as OfficeException).code)
    }

    @Test
    fun rejectsDeeplyNestedXml() {
        val xml = "<root>" + "<a>".repeat(140) + "<t>x</t>" + "</a>".repeat(140) + "</root>"
        val sp = OfficeXml.parser(xml.toByteArray())
        var failure: OfficeException? = null
        try {
            while (true) if (sp.next() == org.xmlpull.v1.XmlPullParser.END_DOCUMENT) break
        } catch (e: OfficeException) {
            failure = e
        }
        assertNotNull(failure)
        assertEquals("office_xml", failure!!.code)
    }

    @Test
    fun probesOleRtfAndZip() {
        val ole = temp(binary(byteArrayOf(0xD0.toByte(), 0xCF.toByte(), 0x11, 0xE0.toByte(), 0xA1.toByte(), 0xB1.toByte(), 0x1A, 0xE1.toByte())))
        assertEquals(OfficeFileKind.OLE, OfficeZip.probe(ole))
        val rtf = temp("{\\rtf1 hello}".toByteArray())
        assertEquals(OfficeFileKind.RTF, OfficeZip.probe(rtf))
        val zipFile = temp(zip("a" to ByteArray(0)))
        assertEquals(OfficeFileKind.ZIP, OfficeZip.probe(zipFile))
    }

    @Test
    fun resolvesRelationshipsInsideTheArchiveOnly() {
        assertEquals("word/media/image1.png", OfficeRels.resolve("word/document.xml", "media/image1.png"))
        assertEquals("media/image1.png", OfficeRels.resolve("word/document.xml", "/media/image1.png"))
        assertEquals("word/media/a b.png", OfficeRels.resolve("word/document.xml", "media/a%20b.png"))
        assertNull(OfficeRels.resolve("word/document.xml", "../../etc/passwd"))
        assertNull(OfficeRels.resolve("word/document.xml", "..\\..\\x"))
        assertNull(OfficeRels.resolve("word/document.xml", "javascript:alert(1)"))
    }

    @Test
    fun missingDocumentPartIsADamagedDocument() {
        val file = temp(zip("_rels/.rels" to xml(rootRels("word/document.xml"))))
        val zip = OfficeZip.open(file)
        val e = runCatching { DocxParser.parse(zip, FakeAssets()) }.exceptionOrNull()
        zip.close()
        assertTrue(e is OfficeException)
        assertEquals("office_damaged", (e as OfficeException).code)
    }

    // ─── Helpers ───────────────────────────────────────────────────────────────────────────────
    private class FakeAssets : OfficeAssets {
        var count = 0
        override fun put(part: String, bytes: ByteArray, mime: String): String = "asset${++count}"
    }

    private fun firstText(cell: DocxCell): String =
        cell.blocks.filterIsInstance<DocxBlock.Para>().joinToString("") { p -> p.paragraph.runs.joinToString("") { it.text } }

    private fun expectOffice(file: File, block: (File) -> Unit): OfficeException {
        val e = runCatching { block(file) }.exceptionOrNull()
        assertTrue("expected OfficeException, got ${e?.javaClass}: ${e?.message}", e is OfficeException)
        return e as OfficeException
    }

    private fun temp(file: File): File {
        temp += file
        return file
    }

    private fun temp(bytes: ByteArray): File {
        val f = File.createTempFile("office-probe", ".bin")
        FileOutputStream(f).use { it.write(bytes) }
        return temp(f)
    }

    private fun binary(bytes: ByteArray) = bytes

    private fun zip(vararg entries: Pair<String, ByteArray>): File {
        val file = File.createTempFile("office-fixture", ".zip")
        ZipOutputStream(FileOutputStream(file)).use { z ->
            for ((name, bytes) in entries) {
                z.putNextEntry(ZipEntry(name))
                z.write(bytes)
                z.closeEntry()
            }
        }
        return file
    }

    private fun xml(text: String) = text.toByteArray(Charsets.UTF_8)

    private fun markEncrypted(file: File) {
        RandomAccessFile(file, "rw").use { raf ->
            val length = raf.length()
            val tail = ByteArray(minOf(length, 65_579L).toInt())
            raf.seek(length - tail.size)
            raf.readFully(tail)
            var eocd = -1
            for (i in tail.size - 22 downTo 0) {
                if (u32(tail, i) == 0x06054b50L) { eocd = i; break }
            }
            check(eocd >= 0)
            val cen = u32(tail, eocd + 16)
            raf.seek(cen + 8)
            val lo = raf.readUnsignedByte()
            val hi = raf.readUnsignedByte()
            val flag = lo or (hi shl 8)
            raf.seek(cen + 8)
            val patched = flag or 1
            raf.writeByte(patched and 0xff)
            raf.writeByte((patched ushr 8) and 0xff)
        }
    }

    private fun u32(b: ByteArray, at: Int): Long =
        (b[at].toLong() and 0xff) or ((b[at + 1].toLong() and 0xff) shl 8) or
            ((b[at + 2].toLong() and 0xff) shl 16) or ((b[at + 3].toLong() and 0xff) shl 24)

    private fun rootRels(target: String) = """
        <?xml version="1.0" encoding="UTF-8"?>
        <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
          <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="$target"/>
        </Relationships>
    """.trimIndent()

    private fun docxRels() = """
        <?xml version="1.0" encoding="UTF-8"?>
        <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
          <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
          <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>
          <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/>
          <Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com/a?b=1" TargetMode="External"/>
        </Relationships>
    """.trimIndent()

    companion object {
        private const val W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
        private const val R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"

        private val DOCX_DOCUMENT = """
            <?xml version="1.0" encoding="UTF-8"?>
            <w:document xmlns:w="$W" xmlns:r="$R"
              xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
              xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
              xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"
              xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math">
              <w:body>
                <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>标题</w:t></w:r></w:p>
                <w:p>
                  <w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr>
                  <w:r><w:rPr><w:b/><w:i/><w:u w:val="single"/><w:strike/><w:color w:val="FF0000"/><w:sz w:val="28"/></w:rPr><w:t>粗体</w:t></w:r>
                  <w:r><w:t>普通</w:t></w:r>
                </w:p>
                <w:p><w:hyperlink r:id="rId4"><w:r><w:rPr><w:u w:val="single"/></w:rPr><w:t>链接</w:t></w:r></w:hyperlink></w:p>
                <w:p><w:r><w:drawing><wp:inline>
                  <wp:extent cx="952500" cy="476250"/>
                  <a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">
                    <pic:pic><pic:nvPicPr><pic:cNvPr id="1" name="图1"/></pic:nvPicPr>
                      <pic:blipFill><a:blip r:embed="rId3"/></pic:blipFill></pic:pic>
                  </a:graphicData></a:graphic>
                </wp:inline></w:drawing></w:r></w:p>
                <w:tbl>
                  <w:tr><w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr><w:p><w:r><w:t>A</w:t></w:r></w:p></w:tc></w:tr>
                  <w:tr>
                    <w:tc><w:tcPr><w:vMerge w:val="restart"/></w:tcPr><w:p><w:r><w:t>B</w:t></w:r></w:p></w:tc>
                    <w:tc><w:p><w:r><w:t>C</w:t></w:r></w:p></w:tc>
                  </w:tr>
                  <w:tr>
                    <w:tc><w:tcPr><w:vMerge/></w:tcPr><w:p/></w:tc>
                    <w:tc><w:p><w:r><w:t>D</w:t></w:r></w:p></w:tc>
                  </w:tr>
                </w:tbl>
                <w:p><w:r><w:delText>删除</w:delText></w:r><w:ins><w:r><w:t>插入</w:t></w:r></w:ins><w:r><w:t>保留</w:t></w:r></w:p>
                <w:p><m:oMath><m:r><m:t>公式</m:t></m:r></m:oMath><w:r><w:t>正文</w:t></w:r></w:p>
              </w:body>
            </w:document>
        """.trimIndent()

        private val DOCX_STYLES = """
            <?xml version="1.0" encoding="UTF-8"?>
            <w:styles xmlns:w="$W">
              <w:style w:type="paragraph" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
              <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:rPr><w:b/></w:rPr></w:style>
            </w:styles>
        """.trimIndent()

        private val DOCX_NUMBERING = """
            <?xml version="1.0" encoding="UTF-8"?>
            <w:numbering xmlns:w="$W">
              <w:abstractNum w:abstractNumId="0">
                <w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl>
              </w:abstractNum>
              <w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
            </w:numbering>
        """.trimIndent()

        private val XLSX_WORKBOOK = """
            <?xml version="1.0" encoding="UTF-8"?>
            <workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
              xmlns:r="$R">
              <sheets>
                <sheet name="数据" sheetId="1" r:id="rId1"/>
                <sheet name="隐藏" sheetId="2" state="hidden" r:id="rId2"/>
              </sheets>
            </workbook>
        """.trimIndent()

        private val XLSX_WORKBOOK_RELS = """
            <?xml version="1.0" encoding="UTF-8"?>
            <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
              <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
              <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>
              <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>
              <Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
            </Relationships>
        """.trimIndent()

        private val XLSX_SHARED = """
            <?xml version="1.0" encoding="UTF-8"?>
            <sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="2" uniqueCount="2">
              <si><t>名称</t></si>
              <si><r><t>富</t></r><r><t>文本</t></r></si>
            </sst>
        """.trimIndent()

        private val XLSX_STYLES = """
            <?xml version="1.0" encoding="UTF-8"?>
            <styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
              <numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/></numFmts>
              <fonts count="2">
                <font><sz val="11"/></font>
                <font><b/><i/><color rgb="FFFF0000"/><sz val="14"/></font>
              </fonts>
              <fills count="2">
                <fill><patternFill patternType="none"/></fill>
                <fill><patternFill patternType="solid"><fgColor rgb="FFFFFF00"/></patternFill></fill>
              </fills>
              <cellXfs count="3">
                <xf numFmtId="0" fontId="0" fillId="0"/>
                <xf numFmtId="0" fontId="1" fillId="1"><alignment horizontal="center" wrapText="1"/></xf>
                <xf numFmtId="164" fontId="0" fillId="0"/>
              </cellXfs>
            </styleSheet>
        """.trimIndent()

        private val XLSX_SHEET1 = """
            <?xml version="1.0" encoding="UTF-8"?>
            <worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
              <dimension ref="A1:C4"/>
              <cols><col min="1" max="1" width="20" customWidth="1"/></cols>
              <sheetData>
                <row r="1" ht="24" customHeight="1">
                  <c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c>
                  <c r="C1" t="inlineStr"><is><t>内联</t></is></c>
                </row>
                <row r="2">
                  <c r="A2" s="1"><v>42</v></c><c r="B2" s="2"><v>45123</v></c><c r="C2" t="b"><v>1</v></c>
                </row>
                <row r="3"><c r="A3"><f>SUM(A2:A2)</f><v>42</v></c><c r="B3" t="e"><v>#DIV/0!</v></c></row>
                <row r="4"><c r="A4" t="str"><f>CONCAT</f><v>缓存</v></c></row>
              </sheetData>
              <mergeCells count="1"><mergeCell ref="A3:B3"/></mergeCells>
            </worksheet>
        """.trimIndent()

        private val XLSX_SHEET2 = """
            <?xml version="1.0" encoding="UTF-8"?>
            <worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
              <sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>第二页</t></is></c></row></sheetData>
            </worksheet>
        """.trimIndent()

        private val PPTX_PRESENTATION = """
            <?xml version="1.0" encoding="UTF-8"?>
            <p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
              xmlns:r="$R">
              <p:sldSz cx="12192000" cy="6858000"/>
              <p:sldIdLst>
                <p:sldId id="256" r:id="rId1"/>
                <p:sldId id="257" r:id="rId2"/>
              </p:sldIdLst>
            </p:presentation>
        """.trimIndent()

        private val PPTX_PRESENTATION_RELS = """
            <?xml version="1.0" encoding="UTF-8"?>
            <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
              <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>
              <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/>
            </Relationships>
        """.trimIndent()

        private val PPTX_SLIDE1 = """
            <?xml version="1.0" encoding="UTF-8"?>
            <p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
              xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="$R"
              xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart">
              <p:cSld>
                <p:bg><p:bgPr><a:solidFill><a:srgbClr val="EEF2FF"/></a:solidFill></p:bgPr></p:bg>
                <p:spTree>
                  <p:nvGrpSpPr/><p:grpSpPr/>
                  <p:sp>
                    <p:nvSpPr><p:cNvPr id="2" name="标题"/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
                    <p:spPr><a:xfrm><a:off x="914400" y="457200"/><a:ext cx="10058400" cy="1143000"/></a:xfrm></p:spPr>
                    <p:txBody><a:bodyPr/><a:p><a:pPr algn="ctr"/><a:r><a:rPr sz="4000" b="1"><a:solidFill><a:srgbClr val="112233"/></a:solidFill></a:rPr><a:t>季度报告</a:t></a:r></a:p></p:txBody>
                  </p:sp>
                  <p:sp>
                    <p:nvSpPr><p:cNvPr id="3" name="正文"/><p:nvPr/></p:nvSpPr>
                    <p:spPr><a:xfrm><a:off x="914400" y="2000000"/><a:ext cx="8000000" cy="2000000"/></a:xfrm><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></p:spPr>
                    <p:txBody><a:p><a:pPr><a:buChar char="•"/></a:pPr><a:r><a:rPr i="1"/><a:t>第一点</a:t></a:r></a:p></p:txBody>
                  </p:sp>
                  <p:pic>
                    <p:nvPicPr><p:cNvPr id="4" name="图"/><p:nvPr/></p:nvPicPr>
                    <p:blipFill><a:blip r:embed="rId3"/></p:blipFill>
                    <p:spPr><a:xfrm><a:off x="6000000" y="4000000"/><a:ext cx="3000000" cy="1500000"/></a:xfrm></p:spPr>
                  </p:pic>
                  <p:graphicFrame>
                    <p:nvGraphicFramePr><p:cNvPr id="5" name="图表"/></p:nvGraphicFramePr>
                    <p:xfrm><a:off x="1000000" y="5000000"/><a:ext cx="2000000" cy="1000000"/></p:xfrm>
                    <a:graphic><a:graphicData><c:chart r:id="rId4"/></a:graphicData></a:graphic>
                  </p:graphicFrame>
                </p:spTree>
              </p:cSld>
            </p:sld>
        """.trimIndent()

        private val PPTX_SLIDE1_RELS = """
            <?xml version="1.0" encoding="UTF-8"?>
            <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
              <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/>
              <Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart1.xml"/>
            </Relationships>
        """.trimIndent()

        private val PPTX_SLIDE2 = """
            <?xml version="1.0" encoding="UTF-8"?>
            <p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
              xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
              <p:cSld><p:spTree><p:nvGrpSpPr/><p:grpSpPr/>
                <p:sp><p:nvSpPr><p:cNvPr id="2" name="第二页"/><p:nvPr/></p:nvSpPr>
                  <p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1000000" cy="1000000"/></a:xfrm></p:spPr>
                  <p:txBody><a:p><a:r><a:t>第二张</a:t></a:r></a:p></p:txBody></p:sp>
              </p:spTree></p:cSld>
            </p:sld>
        """.trimIndent()
    }
}
