package dev.herdr.pocket.office

/**
 * OPC relationships (`_rels/…rels`). External relationships are reported but never followed:
 * images, styles and slide parts must resolve inside the archive. A target that climbs out of the
 * archive root is refused.
 */
object OfficeRels {
    data class Rel(val id: String, val type: String, val target: String, val external: Boolean)

    fun relsName(part: String): String {
        if (part.isEmpty()) return "_rels/.rels"
        val slash = part.lastIndexOf('/')
        val dir = if (slash < 0) "" else part.substring(0, slash)
        val base = part.substring(slash + 1)
        return (if (dir.isEmpty()) "_rels/" else "$dir/_rels/") + "$base.rels"
    }

    fun parse(zip: OfficeZip, part: String): Map<String, Rel> {
        val sp = OfficeXml.parser(zip, relsName(part), 4 * 1024 * 1024) ?: return emptyMap()
        val out = LinkedHashMap<String, Rel>()
        try {
            while (true) {
                val e = sp.next()
                if (e == org.xmlpull.v1.XmlPullParser.END_DOCUMENT) break
                if (e != org.xmlpull.v1.XmlPullParser.START_TAG) continue
                if (sp.name != "Relationship") {
                    if (sp.name == "Relationships") continue
                    sp.skipElement()
                    continue
                }
                val id = sp.attr("Id")
                val type = sp.attr("Type").orEmpty()
                val target = sp.attr("Target").orEmpty()
                val external = sp.attr("TargetMode").equals("External", ignoreCase = true)
                if (!id.isNullOrEmpty() && target.isNotEmpty() && id.length <= 128 && target.length <= 2048) {
                    out[id] = Rel(id, type, target, external)
                }
                sp.skipElement()
            }
        } catch (e: OfficeException) {
            throw e
        } catch (e: Exception) {
            throw OfficeException("office_xml", "文档的关系文件已损坏", e)
        }
        return out
    }

    /** The main document part named by `_rels/.rels`, or [fallback]. */
    fun mainPart(zip: OfficeZip, fallback: String): String {
        val rels = parse(zip, "")
        val rel = rels.values.firstOrNull { !it.external && it.type.endsWith("/officeDocument") } ?: return fallback
        val target = resolve("", rel.target) ?: return fallback
        return if (zip.has(target)) target else fallback
    }

    /** The part of [part] named by the first internal relationship whose type ends with [suffix]. */
    fun partOfType(zip: OfficeZip, part: String, suffix: String): String? {
        val rel = parse(zip, part).values.firstOrNull { !it.external && it.type.endsWith(suffix) } ?: return null
        return resolve(part, rel.target)?.takeIf { zip.has(it) }
    }

    /**
     * Resolves a relationship target relative to the part that declares it. Returns an archive
     * path without a leading slash, or null for an absolute/escaping target.
     */
    fun resolve(part: String, target: String): String? {
        if (target.isEmpty() || target.length > 2048) return null
        if (target.indexOf('\u0000') >= 0 || target.indexOf('\\') >= 0) return null
        val decoded = percentDecode(target)
        // Internal OPC targets are relative paths, never URLs or scheme-prefixed names.
        if (Regex("^[A-Za-z][A-Za-z0-9+.-]*:").containsMatchIn(decoded)) return null
        val out = ArrayList<String>()
        if (!decoded.startsWith("/")) {
            val slash = part.lastIndexOf('/')
            if (slash > 0) decodedBase(part.substring(0, slash), out)
        }
        for (seg in decoded.removePrefix("/").split('/')) {
            when (seg) {
                "", "." -> Unit
                ".." -> {
                    if (out.isEmpty()) return null
                    out.removeAt(out.lastIndex)
                }
                else -> out.add(seg)
            }
        }
        if (out.isEmpty()) return null
        return out.joinToString("/")
    }

    private fun decodedBase(part: String, out: MutableList<String>) {
        for (seg in part.split('/')) {
            when (seg) {
                "", "." -> Unit
                ".." -> if (out.isNotEmpty()) out.removeAt(out.lastIndex)
                else -> out.add(seg)
            }
        }
    }

    private fun percentDecode(value: String): String {
        if ('%' !in value) return value
        val out = StringBuilder(value.length)
        var i = 0
        while (i < value.length) {
            val c = value[i]
            if (c == '%' && i + 2 < value.length) {
                val hi = Character.digit(value[i + 1], 16)
                val lo = Character.digit(value[i + 2], 16)
                if (hi >= 0 && lo >= 0) {
                    out.append(((hi shl 4) or lo).toChar())
                    i += 3
                    continue
                }
            }
            out.append(c)
            i++
        }
        return out.toString()
    }
}
