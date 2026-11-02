package dev.herdr.pocket.office

/** A parsed slide as plain maps and lists for the page (office.js); [OfficePreview] wraps them in JSON. */
object PptxJson {
    fun slide(s: PptxSlide): Map<String, Any?> = LinkedHashMap<String, Any?>().apply {
        put("index", s.index); put("w", s.widthEmu); put("h", s.heightEmu); put("bg", s.background ?: "#FFFFFF")
        put("shapes", s.shapes.map { shape(it) })
        s.bgAsset?.let { put("bgAsset", it) }
        s.bgGrad?.let { put("bgGrad", grad(it)) }
        s.title?.let { put("title", it) }
        if (s.truncated) put("truncated", true)
    }

    private fun shape(s: PptxShape) = LinkedHashMap<String, Any?>().apply {
        put("k", s.kind); put("x", s.x); put("y", s.y); put("w", s.w); put("h", s.h)
        s.fill?.let { put("fill", it) }
        if (s.fillAlpha < 1f) put("fa", s.fillAlpha)
        s.grad?.let { put("grad", grad(it)) }
        s.name?.let { put("name", it) }
        s.label?.let { put("label", it) }
        s.asset?.let { put("asset", it) }
        s.line?.let { put("line", line(it)) }
        if (s.rot != 0f) put("rot", s.rot)
        if (s.flipH) put("flipH", true)
        if (s.flipV) put("flipV", true)
        s.geom?.let { put("geom", it) }
        if (s.adj.isNotEmpty()) put("adj", s.adj)
        if (s.paths.isNotEmpty()) put("paths", s.paths.map { p ->
            LinkedHashMap<String, Any?>().apply {
                put("w", p.w); put("h", p.h); put("d", p.d)
                if (!p.fill) put("noFill", true)
                if (!p.stroke) put("noStroke", true)
            }
        })
        s.crop?.let { put("crop", it) }
        s.body?.let { put("body", body(it)) }
        if (s.paragraphs.isNotEmpty()) put("ps", s.paragraphs.map { paragraph(it) })
        s.chart?.let { c ->
            put("chart", LinkedHashMap<String, Any?>().apply {
                put("kind", c.kind); put("horizontal", c.horizontal); put("cats", c.cats); put("ink", c.ink); put("gap", c.gap)
                put("titlePt", c.titlePt); put("legendPt", c.legendPt); put("catPt", c.catPt); put("valPt", c.valPt)
                c.stack?.let { put("stack", it) }; c.title?.let { put("title", it) }; c.legend?.let { put("legend", it) }
                c.min?.let { put("min", it) }; c.max?.let { put("max", it) }; c.hole?.let { put("hole", it) }
                if (c.reverse) put("reverse", true)
                if (c.noCatAxis) put("noCatAxis", true)
                if (c.noValAxis) put("noValAxis", true)
                if (c.grid) put("grid", true)
                put("series", c.series.map { x ->
                    LinkedHashMap<String, Any?>().apply {
                        put("name", x.name); put("color", x.color); put("values", x.values)
                        x.xs?.let { put("xs", it) }
                        if (x.points.isNotEmpty()) put("points", x.points)
                        if (x.showVal) put("showVal", true)
                        if (x.showPct) put("showPct", true)
                        if (x.showCat) put("showCat", true)
                        x.format?.let { put("fmt", it) }
                        x.labelPt?.let { put("labelPt", it) }
                    }
                })
            })
        }
        s.table?.let { t ->
            put("table", mapOf("cols" to t.cols, "rows" to t.rows.map { r ->
                mapOf("h" to r.h, "cells" to r.cells.map { c ->
                    LinkedHashMap<String, Any?>().apply {
                        put("ps", c.paragraphs.map { paragraph(it) }); put("body", body(c.body))
                        c.fill?.let { put("fill", it) }
                        if (c.fillAlpha < 1f) put("fa", c.fillAlpha)
                        if (c.span > 1) put("span", c.span)
                        if (c.rowSpan > 1) put("rowSpan", c.rowSpan)
                        if (c.covered) put("covered", true)
                        if (c.borders.isNotEmpty()) put("borders", c.borders.mapValues { line(it.value) })
                    }
                })
            }))
        }
    }

    private fun grad(g: PptxGrad) = mapOf("ang" to g.angle, "stops" to g.stops.map { listOf(it.at, it.color, it.alpha) })

    private fun line(l: PptxLine) = LinkedHashMap<String, Any?>().apply {
        put("c", l.color); put("w", l.widthEmu)
        if (l.alpha < 1f) put("a", l.alpha)
        l.dash?.let { put("dash", it) }
        l.head?.let { put("head", listOf(it.type, it.w, it.len)) }
        l.tail?.let { put("tail", listOf(it.type, it.w, it.len)) }
    }

    private fun body(b: PptxBody) = LinkedHashMap<String, Any?>().apply {
        put("ins", b.ins)
        b.anchor?.let { put("anchor", it) }
        if (!b.wrap) put("nowrap", true)
        b.vert?.let { put("vert", it) }
        if (b.center) put("center", true)
    }

    private fun paragraph(p: OfficeParagraph) = LinkedHashMap<String, Any?>().apply {
        put("runs", p.runs.map { r ->
            LinkedHashMap<String, Any?>().apply {
                put("t", r.text)
                if (r.bold) put("b", true)
                if (r.italic) put("i", true)
                if (r.underline) put("u", true)
                if (r.strike) put("s", true)
                r.color?.let { put("color", it) }
                (r.exactPt ?: r.sizePt?.toFloat())?.let { put("sz", it) }
                r.baseline?.let { put("bl", it) }
            }
        })
        p.align?.let { put("al", it) }
        p.marker?.let { put("marker", it) }
        p.slide?.let { s ->
            put("pp", LinkedHashMap<String, Any?>().apply {
                if (s.marginPt != 0f) put("mar", s.marginPt)
                if (s.indentPt != 0f) put("ind", s.indentPt)
                s.lineScale?.let { put("ln", it) }
                s.linePt?.let { put("lnPt", it) }
                if (s.beforePt != 0f) put("bef", s.beforePt)
                if (s.afterPt != 0f) put("aft", s.afterPt)
                put("pt", s.fontPt)
                s.color?.let { put("color", it) }
                s.markerColor?.let { put("mc", it) }
                s.markerScale?.let { put("ms", it) }
            })
        }
    }
}
