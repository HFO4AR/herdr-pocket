package dev.herdr.pocket

import android.content.Context
import dev.herdr.pocket.office.DocxBlock
import dev.herdr.pocket.office.DocxParser
import dev.herdr.pocket.office.OfficeAssets
import dev.herdr.pocket.office.OfficeZip
import dev.herdr.pocket.office.PptxParser
import dev.herdr.pocket.office.XlsxParser
import org.xmlpull.v1.XmlPullParserFactory
import java.io.File
import java.io.FileOutputStream
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

/**
 * Deterministic on-device parser smoke. Builds tiny OOXML fixtures in the app cache with
 * ZipOutputStream and runs the same parsers the preview uses with Android's own pull parser
 * (the JVM tests use kxml2). Called by SecureProfilesTest; no network, no SSH, no UI.
 */
object OfficeTests {
    fun pure(context: Context) {
        // The Android pull parser must be discoverable the same way OfficeXml uses it.
        check(XmlPullParserFactory.newInstance().newPullParser() != null)

        val assets = object : OfficeAssets {
            override fun put(part: String, bytes: ByteArray, mime: String): String = "fixture"
        }
        val dir = File(context.cacheDir, "office-smoke").apply { mkdirs() }
        try {
            val docx = zip(dir, "smoke.docx", arrayOf(
                "_rels/.rels" to rels("word/document.xml"),
                "word/document.xml" to docxBody(),
            ))
            OfficeZip.open(docx).use { zip ->
                val doc = DocxParser.parse(zip, assets)
                val text = doc.blocks.filterIsInstance<DocxBlock.Para>().joinToString("") { p ->
                    p.paragraph.runs.joinToString("") { it.text }
                }
                check("Office fixture" in text) { "DOCX text missing" }
                check(doc.blocks.any { it is DocxBlock.Table }) { "DOCX table missing" }
            }

            val xlsx = zip(dir, "smoke.xlsx", arrayOf(
                "_rels/.rels" to rels("xl/workbook.xml"),
                "xl/workbook.xml" to workbook(),
                "xl/_rels/workbook.xml.rels" to workbookRels(),
                "xl/worksheets/sheet1.xml" to worksheet(),
            ))
            OfficeZip.open(xlsx).use { zip ->
                val book = XlsxParser.parse(zip)
                val sheet = XlsxParser.parseSheet(zip, book, 0)
                check(book.sheets.single().name == "Sheet1") { "XLSX sheet missing" }
                check(sheet.rows.firstOrNull()?.cells?.firstOrNull()?.text == "42") { "XLSX cell missing" }
            }

            val pptx = zip(dir, "smoke.pptx", arrayOf(
                "_rels/.rels" to rels("ppt/presentation.xml"),
                "ppt/presentation.xml" to presentation(),
                "ppt/_rels/presentation.xml.rels" to presentationRels(),
                "ppt/slides/slide1.xml" to slide(),
            ))
            OfficeZip.open(pptx).use { zip ->
                val pres = PptxParser.parse(zip, assets)
                val slide = PptxParser.parseSlide(zip, pres, 0, assets)
                check(slide.shapes.any { s -> s.paragraphs.any { p -> p.runs.any { it.text == "Slide fixture" } } }) {
                    "PPTX text missing"
                }
            }
        } finally {
            dir.deleteRecursively()
        }
    }

    private fun zip(dir: File, name: String, entries: Array<Pair<String, ByteArray>>): File {
        val file = File(dir, name)
        ZipOutputStream(FileOutputStream(file)).use { z ->
            for ((path, bytes) in entries) {
                z.putNextEntry(ZipEntry(path))
                z.write(bytes)
                z.closeEntry()
            }
        }
        return file
    }

    private fun bytes(text: String) = text.toByteArray(Charsets.UTF_8)

    private fun rels(target: String) = bytes(
        """<?xml version="1.0" encoding="UTF-8"?>
        <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
          <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="$target"/>
        </Relationships>""",
    )

    private fun docxBody() = bytes(
        """<?xml version="1.0" encoding="UTF-8"?>
        <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
          <w:p><w:r><w:t>Office fixture</w:t></w:r></w:p>
          <w:tbl><w:tr><w:tc><w:p><w:r><w:t>Cell</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
        </w:body></w:document>""",
    )

    private fun workbook() = bytes(
        """<?xml version="1.0" encoding="UTF-8"?>
        <workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
         xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
          <sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets>
        </workbook>""",
    )

    private fun workbookRels() = bytes(
        """<?xml version="1.0" encoding="UTF-8"?>
        <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
          <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
        </Relationships>""",
    )

    private fun worksheet() = bytes(
        """<?xml version="1.0" encoding="UTF-8"?>
        <worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
          <sheetData><row r="1"><c r="A1"><v>42</v></c></row></sheetData>
        </worksheet>""",
    )

    private fun presentation() = bytes(
        """<?xml version="1.0" encoding="UTF-8"?>
        <p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
         xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
          <p:sldSz cx="12192000" cy="6858000"/>
          <p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst>
        </p:presentation>""",
    )

    private fun presentationRels() = bytes(
        """<?xml version="1.0" encoding="UTF-8"?>
        <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
          <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>
        </Relationships>""",
    )

    private fun slide() = bytes(
        """<?xml version="1.0" encoding="UTF-8"?>
        <p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
         xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
          <p:cSld><p:spTree><p:nvGrpSpPr/><p:grpSpPr/>
            <p:sp><p:nvSpPr><p:cNvPr id="2" name="text"/><p:nvPr/></p:nvSpPr>
              <p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1000000" cy="1000000"/></a:xfrm></p:spPr>
              <p:txBody><a:p><a:r><a:rPr sz="3200"/><a:t>Slide fixture</a:t></a:r></a:p></p:txBody></p:sp>
          </p:spTree></p:cSld>
        </p:sld>""",
    )
}
