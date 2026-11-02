package dev.herdr.pocket.office

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

/** What a slide takes from its layout, master and theme, and how shapes land on it. Generated fixtures only. */
class PptxParserTest {
    private val rel = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
    private val ns = """xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="$rel" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:dgm="http://schemas.openxmlformats.org/drawingml/2006/diagram" xmlns:dsp="http://schemas.microsoft.com/office/drawing/2008/diagram""""
    private val head = """<?xml version="1.0" encoding="UTF-8"?>"""

    private fun rels(vararg r: Triple<String, String, String>) = head + """<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">""" +
        r.joinToString("") { """<Relationship Id="${it.first}" Type="$rel/${it.second}" Target="${it.third}"/>""" } + "</Relationships>"

    private fun xfrm(x: Long, y: Long, w: Long, h: Long) = """<a:xfrm><a:off x="$x" y="$y"/><a:ext cx="$w" cy="$h"/></a:xfrm>"""
    private fun sp(name: String, pr: String = "", text: String = "", ph: String = "", extra: String = "") =
        """<p:sp><p:nvSpPr><p:cNvPr id="9" name="$name"$extra/><p:cNvSpPr/><p:nvPr>$ph</p:nvPr></p:nvSpPr><p:spPr>$pr</p:spPr>$text</p:sp>"""
    private fun tx(body: String, bodyPr: String = "<a:bodyPr/>") = "<p:txBody>$bodyPr<a:lstStyle/>$body</p:txBody>"
    private fun para(text: String, pPr: String = "", rPr: String = "") = "<a:p>$pPr<a:r><a:rPr$rPr/><a:t>$text</a:t></a:r></a:p>"
    private fun tree(body: String) = """<p:cSld><p:spTree><p:nvGrpSpPr/><p:grpSpPr/>$body</p:spTree></p:cSld>"""

    private val theme = head + """<a:theme $ns name="t"><a:themeElements><a:clrScheme name="c">""" +
        listOf("dk1" to "111111", "lt1" to "FFFFFF", "dk2" to "222222", "lt2" to "EEEEEE", "accent1" to "FF0000", "accent2" to "00FF00", "accent3" to "0000FF", "accent4" to "444444", "accent5" to "555555", "accent6" to "666666", "hlink" to "777777", "folHlink" to "888888")
            .joinToString("") { """<a:${it.first}><a:srgbClr val="${it.second}"/></a:${it.first}>""" } +
        """</a:clrScheme><a:fmtScheme name="f"><a:fillStyleLst>""" + """<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>""".repeat(3) +
        """</a:fillStyleLst><a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst>""" +
        """<a:bgFillStyleLst>""" + """<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>""".repeat(3) + """</a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>"""

    private val master = head + """<p:sldMaster $ns><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg2"/></p:bgRef></p:bg><p:spTree><p:nvGrpSpPr/><p:grpSpPr/>""" +
        sp("母版标题", xfrm(1, 1, 1, 1), tx(para("占位")), """<p:ph type="title"/>""") +
        sp("母版正文", xfrm(2, 2, 2, 2), tx(para("占位"), """<a:bodyPr lIns="7" anchor="b"/>"""), """<p:ph type="body" idx="1"/>""") +
        sp("母版图", xfrm(5, 5, 5, 5) + """<a:solidFill><a:schemeClr val="accent1"/></a:solidFill>""") +
        """</p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>""" +
        """<p:txStyles><p:titleStyle><a:lvl1pPr algn="ctr"><a:defRPr sz="4400"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill></a:defRPr></a:lvl1pPr></p:titleStyle>""" +
        """<p:bodyStyle><a:lvl1pPr marL="342900" indent="-342900"><a:buChar char="•"/><a:defRPr sz="2800"/></a:lvl1pPr><a:lvl2pPr marL="685800" indent="-228600"><a:buChar char="–"/><a:defRPr sz="2400"/></a:lvl2pPr></p:bodyStyle><p:otherStyle/></p:txStyles></p:sldMaster>"""

    private val layout = head + """<p:sldLayout $ns><p:cSld><p:spTree><p:nvGrpSpPr/><p:grpSpPr/>""" +
        sp("版式标题", xfrm(100, 200, 300, 400), "", """<p:ph type="title"/>""") +
        sp("版式正文", xfrm(500, 600, 700, 800), "", """<p:ph type="body" idx="1"/>""") +
        sp("版式图", xfrm(6, 6, 6, 6) + """<a:ln w="9525"><a:solidFill><a:srgbClr val="ABCDEF"/></a:solidFill></a:ln>""") +
        """</p:spTree></p:cSld></p:sldLayout>"""

    private fun deck(slide: String, slideAttrs: String = "", slideRels: List<Triple<String, String, String>> = emptyList(), vararg parts: Pair<String, String>): Pair<OfficeZip, PptxPresentation> {
        val files = linkedMapOf(
            "_rels/.rels" to rels(Triple("rId1", "officeDocument", "ppt/presentation.xml")),
            "ppt/presentation.xml" to head + """<p:presentation $ns><p:sldSz cx="12192000" cy="6858000"/><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst></p:presentation>""",
            "ppt/_rels/presentation.xml.rels" to rels(Triple("rId1", "slide", "slides/slide1.xml")),
            "ppt/slides/slide1.xml" to head + """<p:sld $ns$slideAttrs>${tree(slide)}</p:sld>""",
            "ppt/slides/_rels/slide1.xml.rels" to rels(Triple("rId1", "slideLayout", "../slideLayouts/slideLayout1.xml"), *slideRels.toTypedArray()),
            "ppt/slideLayouts/slideLayout1.xml" to layout,
            "ppt/slideLayouts/_rels/slideLayout1.xml.rels" to rels(Triple("rId1", "slideMaster", "../slideMasters/slideMaster1.xml")),
            "ppt/slideMasters/slideMaster1.xml" to master,
            "ppt/slideMasters/_rels/slideMaster1.xml.rels" to rels(Triple("rId1", "theme", "../theme/theme1.xml")),
            "ppt/theme/theme1.xml" to theme,
        )
        files.putAll(parts)
        val file = File.createTempFile("deck", ".pptx").also { it.deleteOnExit() }
        ZipOutputStream(file.outputStream()).use { z -> for ((k, v) in files) { z.putNextEntry(ZipEntry(k)); z.write(v.toByteArray()); z.closeEntry() } }
        val zip = OfficeZip.open(file)
        return zip to PptxParser.parse(zip, assets)
    }

    private val assets = OfficeAssets { part, _, _ -> "asset:" + part.substringAfterLast('/') }
    private fun parse(slide: String, attrs: String = "", rels: List<Triple<String, String, String>> = emptyList(), vararg parts: Pair<String, String>): PptxSlide {
        val (zip, pres) = deck(slide, attrs, rels, *parts)
        return PptxParser.parseSlide(zip, pres, 0, assets).also { zip.close() }
    }

    @Test
    fun placeholdersTakePositionAndTextFromLayoutAndMaster() {
        val s = parse(
            sp("标题", "", tx(para("标题")), """<p:ph type="title"/>""") +
                sp("正文", "", tx(para("一级") + para("二级", """<a:pPr lvl="1"/>""") + para("改过", "", """ sz="1000" b="1"""")), """<p:ph type="body" idx="1"/>""") +
                sp("没填的日期", "", tx("<a:p/>"), """<p:ph type="dt" idx="10"/>"""),
        )
        assertEquals(listOf("母版图", "版式图", "标题", "正文"), s.shapes.map { it.name })
        val title = s.shapes[2]
        assertEquals(listOf(100L, 200L, 300L, 400L), listOf(title.x, title.y, title.w, title.h))
        assertEquals("center", title.paragraphs[0].align)
        assertEquals(44f, title.paragraphs[0].runs[0].exactPt)
        assertEquals("#111111", title.paragraphs[0].runs[0].color)
        assertEquals("标题", s.title)
        val body = s.shapes[3]
        assertEquals(listOf(500L, 600L), listOf(body.x, body.y))
        assertEquals("bottom", body.body?.anchor)
        assertEquals(7L, body.body?.ins?.get(0))
        assertEquals("•", body.paragraphs[0].marker)
        assertEquals(28f, body.paragraphs[0].runs[0].exactPt)
        assertEquals(27f, body.paragraphs[0].slide?.marginPt)
        assertEquals(-27f, body.paragraphs[0].slide?.indentPt)
        assertEquals("–", body.paragraphs[1].marker)
        assertEquals(24f, body.paragraphs[1].runs[0].exactPt)
        assertEquals(10f, body.paragraphs[2].runs[0].exactPt)
        assertTrue(body.paragraphs[2].runs[0].bold)
        // The master's background, through its colour map and the theme.
        assertEquals("#EEEEEE", s.background)
    }

    @Test
    fun artworkCanBeHiddenAndPlaceholderPromptsNeverShow() {
        assertEquals(listOf("自己的"), parse(sp("自己的", xfrm(0, 0, 1, 1) + """<a:solidFill><a:srgbClr val="000000"/></a:solidFill>"""), """ showMasterSp="0"""").shapes.map { it.name })
    }

    @Test
    fun aConnectorDoesNotSwallowTheShapesAfterIt() {
        val s = parse(
            """<p:cxnSp><p:nvCxnSpPr><p:cNvPr id="3" name="连线"/><p:cNvCxnSpPr/><p:nvPr/></p:nvCxnSpPr><p:spPr>""" + xfrm(10, 20, 30, 0) +
                """<a:prstGeom prst="straightConnector1"/><a:ln w="12700"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:prstDash val="dash"/><a:headEnd type="oval"/><a:tailEnd type="triangle" w="lg" len="sm"/></a:ln></p:spPr></p:cxnSp>""" +
                sp("后面的", xfrm(1, 2, 3, 4) + """<a:prstGeom prst="ellipse"/><a:solidFill><a:schemeClr val="accent1"><a:lumMod val="50000"/></a:schemeClr></a:solidFill>"""),
            """ showMasterSp="0"""",
        )
        assertEquals(listOf("连线", "后面的"), s.shapes.map { it.name })
        val line = s.shapes[0].line!!
        assertEquals("#111111", line.color)
        assertEquals(12700L, line.widthEmu)
        assertEquals("dash", line.dash)
        assertEquals("oval", line.head?.type)
        assertEquals(listOf("triangle", "lg", "sm"), line.tail?.let { listOf(it.type, it.w, it.len) })
        assertEquals("straightConnector1", s.shapes[0].geom)
        assertEquals("ellipse", s.shapes[1].geom)
        assertTrue("half as light: " + s.shapes[1].fill, s.shapes[1].fill == "#7F0000" || s.shapes[1].fill == "#800000")
    }

    @Test
    fun aShapesStyleGivesFillLineAndTextColour() {
        val style = """<p:style><a:lnRef idx="2"><a:schemeClr val="accent2"/></a:lnRef><a:fillRef idx="1"><a:schemeClr val="accent1"/></a:fillRef><a:effectRef idx="0"/><a:fontRef idx="minor"><a:schemeClr val="lt1"/></a:fontRef></p:style>"""
        val s = parse("""<p:sp><p:nvSpPr><p:cNvPr id="3" name="带样式"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr>""" + xfrm(1, 2, 3, 4) + """</p:spPr>$style""" + tx(para("字")) + "</p:sp>" +
            sp("没填充", xfrm(1, 2, 3, 4) + "<a:noFill/>" + """<a:ln><a:noFill/></a:ln>"""), """ showMasterSp="0"""")
        assertEquals(1, s.shapes.size)
        assertEquals("#FF0000", s.shapes[0].fill)
        assertEquals("#00FF00", s.shapes[0].line?.color)
        assertEquals(12700L, s.shapes[0].line?.widthEmu)
        assertEquals("#FFFFFF", s.shapes[0].paragraphs[0].runs[0].color)
    }

    @Test
    fun groupsMapTheirChildSpaceOntoTheSlide() {
        val child = sp("子", xfrm(100, 100, 200, 200) + """<a:solidFill><a:srgbClr val="000000"/></a:solidFill>""")
        fun group(rot: String, body: String) = """<p:grpSp><p:nvGrpSpPr/><p:grpSpPr><a:xfrm$rot><a:off x="1000" y="1000"/><a:ext cx="2000" cy="2000"/><a:chOff x="0" y="0"/><a:chExt cx="1000" cy="1000"/></a:xfrm></p:grpSpPr>$body</p:grpSp>"""
        val plain = parse(group("", child), """ showMasterSp="0"""").shapes.single()
        assertEquals(listOf(1200L, 1200L, 400L, 400L), listOf(plain.x, plain.y, plain.w, plain.h))
        val nested = parse(group("", group("", child)), """ showMasterSp="0"""").shapes.single()
        assertEquals(listOf(3400L, 3400L, 800L, 800L), listOf(nested.x, nested.y, nested.w, nested.h))
        // A quarter turn of the group turns the child and carries it round the group's centre.
        val turned = parse(group(""" rot="5400000"""", child), """ showMasterSp="0"""").shapes.single()
        assertEquals(90f, turned.rot)
        assertEquals(listOf(2400L, 1200L), listOf(turned.x, turned.y))
    }

    @Test
    fun customPathsBecomeDrawableCommands() {
        val cust = """<a:custGeom><a:pathLst><a:path w="100" h="100"><a:moveTo><a:pt x="0" y="50"/></a:moveTo><a:lnTo><a:pt x="10" y="50"/></a:lnTo><a:arcTo wR="40" hR="40" stAng="10800000" swAng="10800000"/><a:close/></a:path><a:path w="100" h="100" fill="none" stroke="0"/></a:pathLst></a:custGeom>"""
        val s = parse(sp("自定义", xfrm(0, 0, 100, 100) + cust + """<a:solidFill><a:srgbClr val="000000"/></a:solidFill>"""), """ showMasterSp="0"""")
        val path = s.shapes.single().paths.single()
        assertEquals(100L, path.w)
        assertTrue(path.d, path.d.startsWith("M0 50L10 50C"))
        assertTrue(path.d, path.d.endsWith("90 50Z"))
    }

    @Test
    fun textFitNumberingAndSlideNumbers() {
        val num = """<a:pPr><a:buAutoNum type="romanUcPeriod"/></a:pPr>"""
        val s = parse(
            sp("字", xfrm(0, 0, 1, 1), tx(
                para("甲", num, """ sz="2000"""") + para("乙", num, """ sz="2000"""") + para("丙", """<a:pPr><a:buNone/></a:pPr>""", """ sz="2000"""") + para("丁", num, """ sz="2000"""") +
                    """<a:p><a:fld id="{1}" type="slidenum"><a:t>99</a:t></a:fld></a:p>""",
                """<a:bodyPr wrap="none" vert="eaVert"><a:normAutofit fontScale="50000"/></a:bodyPr>""",
            )),
            """ showMasterSp="0"""",
        )
        val ps = s.shapes.single().paragraphs
        assertEquals(listOf("I.", "II.", null, "I.", null), ps.map { it.marker })
        assertEquals(10f, ps[0].runs[0].exactPt)
        assertEquals("1", ps[4].runs[0].text)
        assertFalse(s.shapes.single().body!!.wrap)
        assertEquals("eaVert", s.shapes.single().body!!.vert)
    }

    @Test
    fun hiddenShapesAndNewerFeaturesWithFallbacks() {
        val s = parse(
            sp("藏起来", xfrm(0, 0, 1, 1) + """<a:solidFill><a:srgbClr val="000000"/></a:solidFill>""", extra = """ hidden="1"""") +
                """<mc:AlternateContent><mc:Choice Requires="p14">""" + sp("新版", xfrm(0, 0, 1, 1) + """<a:solidFill><a:srgbClr val="000000"/></a:solidFill>""") +
                "</mc:Choice><mc:Fallback>" + sp("兜底", xfrm(0, 0, 1, 1) + """<a:solidFill><a:srgbClr val="000000"/></a:solidFill>""") + "</mc:Fallback></mc:AlternateContent>",
            """ showMasterSp="0"""",
        )
        assertEquals(listOf("兜底"), s.shapes.map { it.name })
    }

    @Test
    fun tablesKeepTheirGridStylesAndMerges() {
        fun tc(text: String, attrs: String = "", pr: String = "") = """<a:tc$attrs><a:txBody><a:bodyPr/><a:lstStyle/>${para(text)}</a:txBody><a:tcPr marL="5" anchor="ctr">$pr</a:tcPr></a:tc>"""
        val table = """<a:tbl><a:tblPr firstRow="1" bandRow="1"><a:tableStyleId>{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}</a:tableStyleId></a:tblPr><a:tblGrid><a:gridCol w="100"/><a:gridCol w="200"/></a:tblGrid>""" +
            """<a:tr h="50">${tc("表头", """ gridSpan="2"""")}${tc("", """ hMerge="1"""")}</a:tr>""" +
            """<a:tr h="60">${tc("甲", pr = """<a:lnT w="19050"><a:solidFill><a:srgbClr val="123456"/></a:solidFill></a:lnT><a:solidFill><a:srgbClr val="ABCDEF"/></a:solidFill>""")}${tc("乙")}</a:tr></a:tbl>"""
        val s = parse("""<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="3" name="表"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="1" y="2"/><a:ext cx="300" cy="110"/></p:xfrm><a:graphic><a:graphicData>$table</a:graphicData></a:graphic></p:graphicFrame>""", """ showMasterSp="0"""")
        val t = s.shapes.single().table!!
        assertEquals("table", s.shapes.single().kind)
        assertEquals(listOf(100L, 200L), t.cols)
        assertEquals(listOf(50L, 60L), t.rows.map { it.h })
        val header = t.rows[0].cells[0]
        assertEquals(2, header.span)
        assertTrue(t.rows[0].cells[1].covered)
        assertEquals("#FF0000", header.fill)
        assertEquals("#FFFFFF", header.paragraphs[0].runs[0].color)
        assertTrue(header.paragraphs[0].runs[0].bold)
        val own = t.rows[1].cells[0]
        assertEquals("#ABCDEF", own.fill)
        assertEquals("#123456", own.borders["T"]?.color)
        assertEquals(19050L, own.borders["T"]?.widthEmu)
        assertEquals("center", own.body.anchor)
        assertEquals(5L, own.body.ins[0])
        assertTrue("banded from the style: " + t.rows[1].cells[1].fill, t.rows[1].cells[1].fill!!.startsWith("#FF"))
    }

    private fun frame(data: String) = """<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="3" name="框"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="1000" y="2000"/><a:ext cx="300" cy="400"/></p:xfrm><a:graphic><a:graphicData>$data</a:graphicData></a:graphic></p:graphicFrame>"""

    @Test
    fun chartsAreDrawnFromTheirCachedNumbers() {
        val chart = head + """<c:chartSpace $ns><c:chart><c:title><c:tx><c:rich><a:p><a:r><a:rPr sz="1600"/><a:t>季度销量</a:t></a:r></a:p></c:rich></c:tx></c:title><c:plotArea><c:barChart><c:barDir val="bar"/><c:grouping val="clustered"/><c:varyColors val="0"/>""" +
            """<c:ser><c:idx val="0"/><c:tx><c:strRef><c:strCache><c:pt idx="0"><c:v>GF</c:v></c:pt></c:strCache></c:strRef></c:tx><c:spPr><a:solidFill><a:srgbClr val="D98A00"/></a:solidFill></c:spPr>""" +
            """<c:dLbls><c:numFmt formatCode="0.00" sourceLinked="0"/><c:showVal val="1"/></c:dLbls><c:dPt><c:idx val="1"/><c:spPr><a:solidFill><a:srgbClr val="1F78C8"/></a:solidFill></c:spPr></c:dPt>""" +
            """<c:cat><c:multiLvlStrRef><c:multiLvlStrCache><c:lvl><c:pt idx="0"><c:v>甲</c:v></c:pt><c:pt idx="1"><c:v>乙</c:v></c:pt></c:lvl></c:multiLvlStrCache></c:multiLvlStrRef></c:cat>""" +
            """<c:val><c:numRef><c:numCache><c:pt idx="0"><c:v>1.07</c:v></c:pt><c:pt idx="1"><c:v>2.03</c:v></c:pt></c:numCache></c:numRef></c:val></c:ser><c:gapWidth val="60"/></c:barChart>""" +
            """<c:catAx><c:scaling><c:orientation val="maxMin"/></c:scaling><c:delete val="0"/></c:catAx><c:valAx><c:delete val="1"/></c:valAx></c:plotArea></c:chart></c:chartSpace>"""
        val s = parse(frame("""<c:chart r:id="rId5"/>"""), """ showMasterSp="0"""", listOf(Triple("rId5", "chart", "../charts/chart1.xml")), "ppt/charts/chart1.xml" to chart)
        val shape = s.shapes.single()
        assertEquals("chart", shape.kind)
        val c = shape.chart!!
        assertEquals("bar", c.kind)
        assertTrue(c.horizontal)
        assertEquals("季度销量", c.title)
        assertEquals(16f, c.titlePt)
        assertEquals(listOf("甲", "乙"), c.cats)
        assertEquals(listOf(1.07, 2.03), c.series[0].values)
        assertEquals("#D98A00", c.series[0].color)
        assertEquals("#1F78C8", c.series[0].points["1"])
        assertTrue(c.series[0].showVal)
        assertEquals("0.00", c.series[0].format)
        assertTrue(c.reverse)
        assertTrue(c.noValAxis)
        assertEquals(60, c.gap)
    }

    @Test
    fun smartArtUsesTheDrawingSavedBesideIt() {
        val data = head + """<dgm:dataModel $ns><dgm:extLst><a:ext><dsp:dataModelExt relId="rId6"/></a:ext></dgm:extLst></dgm:dataModel>"""
        val drawing = head + """<dsp:drawing $ns><dsp:spTree><dsp:nvGrpSpPr/><dsp:grpSpPr/><dsp:sp><dsp:nvSpPr><dsp:cNvPr id="0" name="块"/><dsp:cNvSpPr/></dsp:nvSpPr><dsp:spPr>""" + xfrm(10, 20, 30, 40) +
            """<a:prstGeom prst="roundRect"/><a:solidFill><a:schemeClr val="accent3"/></a:solidFill></dsp:spPr><dsp:txBody><a:bodyPr/><a:p><a:r><a:t>步骤</a:t></a:r></a:p></dsp:txBody></dsp:sp></dsp:spTree></dsp:drawing>"""
        val s = parse(frame("""<dgm:relIds r:dm="rId5"/>"""), """ showMasterSp="0"""",
            listOf(Triple("rId5", "diagramData", "../diagrams/data1.xml"), Triple("rId6", "diagramDrawing", "../diagrams/drawing1.xml")),
            "ppt/diagrams/data1.xml" to data, "ppt/diagrams/drawing1.xml" to drawing)
        val shape = s.shapes.single()
        assertEquals("块", shape.name)
        assertEquals(listOf(1010L, 2020L, 30L, 40L), listOf(shape.x, shape.y, shape.w, shape.h))
        assertEquals("#0000FF", shape.fill)
        assertEquals("步骤", shape.paragraphs[0].runs[0].text)
        // Without its saved drawing it stays a labelled box.
        val bare = parse(frame("""<dgm:relIds r:dm="rId9"/>"""), """ showMasterSp="0"""").shapes.single()
        assertEquals("placeholder" to "SmartArt", bare.kind to bare.label)
    }

    @Test
    fun picturesKeepTheirCropAndAFillCanBeAPicture() {
        val pic = """<p:pic><p:nvPicPr><p:cNvPr id="3" name="图"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId5"/><a:srcRect l="10000" r="20000"/></p:blipFill><p:spPr>""" + xfrm(1, 2, 3, 4) + """</p:spPr></p:pic>"""
        val fill = sp("图填充", xfrm(0, 0, 1, 1) + """<a:blipFill><a:blip r:embed="rId5"/></a:blipFill>""")
        val s = parse(pic + fill, """ showMasterSp="0"""", listOf(Triple("rId5", "image", "../media/a.png")), "ppt/media/a.png" to "x")
        assertEquals(listOf(.1f, 0f, .2f, 0f), s.shapes[0].crop)
        assertEquals("asset:a.png", s.shapes[0].asset)
        assertEquals("image", s.shapes[1].kind)
        assertEquals("asset:a.png", s.shapes[1].asset)
        // The page's JSON carries what it draws.
        val json = PptxJson.slide(s)
        assertNotNull(json["shapes"])
        @Suppress("UNCHECKED_CAST") val first = (json["shapes"] as List<Map<String, Any?>>)[0]
        assertEquals(s.shapes[0].crop, first["crop"])
    }
}
