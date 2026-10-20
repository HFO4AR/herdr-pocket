package dev.herdr.pocket.office

import org.xmlpull.v1.XmlPullParser
import org.xmlpull.v1.XmlPullParserFactory
import java.io.ByteArrayInputStream

/**
 * Pull parsing for OOXML parts. Every part is read into memory (bounded by [OfficeZip]) and scanned
 * before the parser sees it:
 *
 *  · `<!DOCTYPE` and `<!ENTITY` are refused outright (XXE / entity expansion);
 *  · nesting is capped at [MAX_DEPTH];
 *  · text a parser consumes is capped by the callers (paragraphs, cells, slides).
 *
 * Namespaces are processed. Parsers use local names plus the namespace URI where two vocabularies
 * would otherwise collide. Android's built-in pull parser is used at runtime; the JVM tests put
 * kxml2 on the test classpath, and [XmlPullParserFactory.newInstance] finds it.
 */
object OfficeXml {
    const val MAX_DEPTH = 100
    const val MAX_ATTRIBUTE = 8_192
    const val W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
    const val R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
    const val A = "http://schemas.openxmlformats.org/drawingml/2006/main"
    const val P = "http://schemas.openxmlformats.org/presentationml/2006/main"
    const val S = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
    const val MC = "http://schemas.openxmlformats.org/markup-compatibility/2006"

    /** Parses one part; null when the part does not exist. */
    fun parser(zip: OfficeZip, name: String, max: Int = OfficeZip.MAX_ENTRY): SafeParser? {
        val bytes = zip.read(name, max) ?: return null
        return parser(bytes)
    }

    fun parser(bytes: ByteArray): SafeParser {
        rejectUnsafe(bytes)
        val parser = try {
            val factory = XmlPullParserFactory.newInstance()
            factory.isNamespaceAware = true
            factory.newPullParser().apply {
                setFeature(XmlPullParser.FEATURE_PROCESS_NAMESPACES, true)
                setInput(ByteArrayInputStream(bytes), null)
            }
        } catch (e: Exception) {
            throw OfficeException("office_xml", "文档的 XML 读不了（可能已损坏）", e)
        }
        return SafeParser(parser)
    }

    /** DOCTYPE/ENTITY are never legal in OOXML; refusing them also blocks XXE and entity bombs. */
    fun rejectUnsafe(bytes: ByteArray) {
        if (containsAscii(bytes, "<!DOCTYPE") || containsAscii(bytes, "<!ENTITY")) {
            throw OfficeException("office_xml", "文档里有不安全的外部内容声明")
        }
    }

    private fun containsAscii(bytes: ByteArray, needle: String): Boolean {
        if (bytes.size < needle.length) return false
        val first = needle[0].code
        outer@ for (i in 0..bytes.size - needle.length) {
            if ((bytes[i].toInt() and 0xff) != first) continue
            for (j in 1 until needle.length) {
                val b = bytes[i + j].toInt() and 0xff
                val c = needle[j].code
                val upper = if (c in 'a'.code..'z'.code) c - 32 else c
                if (b != c && b != upper) continue@outer
            }
            return true
        }
        return false
    }

    /** A pull parser that refuses deep nesting and offers small navigation helpers. */
    class SafeParser(val parser: XmlPullParser) {
        var depth = 0
            private set

        val event: Int get() = parser.eventType
        val name: String? get() = parser.name
        val namespace: String? get() = parser.namespace
        val text: String get() = parser.text ?: ""

        fun next(): Int {
            val e = parser.next()
            when (e) {
                XmlPullParser.START_TAG -> {
                    depth++
                    if (depth > MAX_DEPTH) throw OfficeException("office_xml", "文档的结构太深，不能安全打开")
                }
                XmlPullParser.END_TAG -> if (depth > 0) depth--
            }
            return e
        }

        fun isStart(local: String, ns: String? = null): Boolean =
            event == XmlPullParser.START_TAG && name == local && (ns == null || namespace == ns)

        fun isEnd(local: String, ns: String? = null): Boolean =
            event == XmlPullParser.END_TAG && name == local && (ns == null || namespace == ns)

        /** Attribute by local name, regardless of prefix. */
        fun attr(local: String): String? {
            for (i in 0 until parser.attributeCount) {
                if (parser.getAttributeName(i) == local) {
                    val value = parser.getAttributeValue(i)
                    if (value != null && value.length > MAX_ATTRIBUTE) throw OfficeException("office_xml", "文档里有异常长的属性值")
                    return value
                }
            }
            return null
        }

        fun attr(ns: String, local: String): String? {
            val value = parser.getAttributeValue(ns, local)
            if (value != null && value.length > MAX_ATTRIBUTE) throw OfficeException("office_xml", "文档里有异常长的属性值")
            return value
        }

        /** Consumes the current START_TAG's whole subtree (including its END_TAG). */
        fun skipElement() {
            if (event != XmlPullParser.START_TAG) return
            val target = depth - 1
            while (true) {
                val e = next()
                if (e == XmlPullParser.END_TAG && depth == target) return
                if (e == XmlPullParser.END_DOCUMENT) return
            }
        }

        /** Reads the character content of the current element (up to its END_TAG). */
        fun readText(limit: Int = 1_000_000): String {
            val sb = StringBuilder()
            while (true) {
                val e = next()
                if (e == XmlPullParser.END_TAG) return sb.toString()
                if (e == XmlPullParser.TEXT || e == XmlPullParser.CDSECT || e == XmlPullParser.ENTITY_REF) {
                    if (sb.length < limit) sb.append(text.take(limit - sb.length))
                }
                if (e == XmlPullParser.END_DOCUMENT) return sb.toString()
            }
        }
    }

    fun onOff(value: String?): Boolean = when (value?.lowercase()) {
        null, "", "1", "true", "on", "yes" -> true
        else -> false
    }

    /** DrawingML attributes are absent when inherited; only an explicit truthy value counts. */
    fun explicitOn(value: String?): Boolean = when (value?.lowercase()) {
        "1", "true", "on", "yes" -> true
        else -> false
    }

    /** `FFRRGGBB`, `RRGGBB`, `#RRGGBB` → `#RRGGBB`; anything else is ignored. */
    fun color(value: String?): String? {
        val v = value?.trim()?.removePrefix("#") ?: return null
        if (v.length != 6 && v.length != 8) return null
        if (!v.all { it in '0'..'9' || it in 'a'..'f' || it in 'A'..'F' }) return null
        return "#" + v.takeLast(6).uppercase()
    }
}
