package dev.herdr.pocket.office

import java.io.Closeable
import java.io.File
import java.io.FileInputStream
import java.io.IOException
import java.io.RandomAccessFile
import java.util.zip.ZipEntry
import java.util.zip.ZipFile

/** How a file starts, before opening it as a ZIP. */
enum class OfficeFileKind { ZIP, OLE, RTF, OTHER }

/**
 * A bounded, read-only ZIP. The whole archive is checked before any parser sees it:
 *
 *  · only regular local files (the caller already copied it into the app cache);
 *  · at most [MAX_ENTRIES] entries, [MAX_ENTRY] bytes per entry and [MAX_TOTAL] bytes in total;
 *  · no compression ratio above [MAX_RATIO] (zip bombs), except tiny entries;
 *  · no absolute paths, `..` segments, backslashes, NULs or duplicate names;
 *  · no encrypted entries and no ZIP64/multi-disk archives.
 *
 * It exposes parts by their exact OPC names. Parsers only read the handful of XML/media parts they
 * need, but the limits are enforced for the whole archive so a bomb cannot hide behind an unused
 * entry.
 */
class OfficeZip private constructor(
    val file: File,
    private val zip: ZipFile,
    private val entries: Map<String, ZipEntry>,
    val totalUncompressed: Long,
) : Closeable {

    fun has(name: String): Boolean = entries.containsKey(name)

    fun entryNames(): Set<String> = entries.keys

    /** Reads one part fully, or null when it does not exist. Throws when it exceeds [max]. */
    fun read(name: String, max: Int = MAX_ENTRY): ByteArray? {
        val entry = entries[name] ?: return null
        val size = entry.size
        if (size < 0L) throw OfficeException("office_zip", "文档里有一块的大小读不出来")
        if (size > max) throw OfficeException("office_zip", "文档里有一块内容太大，不能安全打开")
        val bytes = ByteArray(size.toInt())
        try {
            zip.getInputStream(entry).use { input ->
                var at = 0
                while (at < bytes.size) {
                    val n = input.read(bytes, at, bytes.size - at)
                    if (n < 0) break
                    at += n
                }
                if (at != bytes.size) throw OfficeException("office_zip", "文档不完整或已损坏")
            }
        } catch (e: OfficeException) {
            throw e
        } catch (e: Exception) {
            throw OfficeException("office_zip", "文档里的内容解不开（可能已损坏）", e)
        }
        return bytes
    }

    /** Only for parts already below the limit; the parser reads them fully into memory anyway. */
    fun readText(name: String, max: Int = MAX_ENTRY): String? = read(name, max)?.toString(Charsets.UTF_8)

    override fun close() {
        try {
            zip.close()
        } catch (_: IOException) {
        }
    }

    companion object {
        const val MAX_ENTRIES = 2000
        const val MAX_ENTRY = 32 * 1024 * 1024
        const val MAX_TOTAL = 200L * 1024 * 1024
        const val MAX_RATIO = 200L
        const val MAX_FILE = 120L * 1024 * 1024
        private const val MIN_RATIO_SIZE = 1L * 1024 * 1024

        fun probe(file: File): OfficeFileKind {
            if (!file.isFile || file.length() == 0L) return OfficeFileKind.OTHER
            val head = ByteArray(minOf(8L, file.length()).toInt())
            try {
                FileInputStream(file).use { it.read(head) }
            } catch (_: IOException) {
                return OfficeFileKind.OTHER
            }
            if (head.size >= 8 && (head[0].toInt() and 0xff) == 0xD0 && (head[1].toInt() and 0xff) == 0xCF &&
                (head[2].toInt() and 0xff) == 0x11 && (head[3].toInt() and 0xff) == 0xE0 &&
                (head[4].toInt() and 0xff) == 0xA1 && (head[5].toInt() and 0xff) == 0xB1 &&
                (head[6].toInt() and 0xff) == 0x1A && (head[7].toInt() and 0xff) == 0xE1
            ) return OfficeFileKind.OLE
            if (head.size >= 4 && head[0] == 0x50.toByte() && head[1] == 0x4B.toByte() &&
                ((head[2] == 0x03.toByte() && head[3] == 0x04.toByte()) || (head[2] == 0x05.toByte() && head[3] == 0x06.toByte()))
            ) return OfficeFileKind.ZIP
            if (head.size >= 5 && head[0] == '{'.code.toByte() && head[1] == '\\'.code.toByte() &&
                head[2] == 'r'.code.toByte() && head[3] == 't'.code.toByte() && head[4] == 'f'.code.toByte()
            ) return OfficeFileKind.RTF
            return OfficeFileKind.OTHER
        }

        fun open(file: File): OfficeZip {
            if (!file.isFile) throw OfficeException("office_missing", "文件已经不在了")
            if (file.length() > MAX_FILE) throw OfficeException("office_too_large", "文档太大，不能在手机上打开")
            val central = scanCentralDirectory(file)
            val zip = try {
                ZipFile(file)
            } catch (e: Exception) {
                throw OfficeException("office_damaged", "这不是一个完整的 Office 文档（可能已损坏）", e)
            }
            try {
                val entries = HashMap<String, ZipEntry>(central.size * 2)
                var total = 0L
                val seen = HashSet<String>()
                for (entry in zip.entries()) {
                    val name = entry.name
                    checkName(name)
                    if (!seen.add(name)) throw OfficeException("office_zip", "文档里有重复的路径，不能安全打开")
                    if (!entry.isDirectory) {
                        if (entry.size > MAX_ENTRY) throw OfficeException("office_zip", "文档里有一块内容太大，不能安全打开")
                        total += entry.size.coerceAtLeast(0)
                        if (total > MAX_TOTAL) throw OfficeException("office_zip", "文档解开后太大，不能安全打开")
                        entries[name] = entry
                    }
                }
                if (entries.size != central.size) throw OfficeException("office_zip", "文档目录不一致，不能安全打开")
                return OfficeZip(file, zip, entries, total)
            } catch (e: Throwable) {
                try {
                    zip.close()
                } catch (_: Exception) {
                }
                throw e
            }
        }

        private class CentralEntry(val name: String, val flag: Int, val compressed: Long, val uncompressed: Long)

        private fun scanCentralDirectory(file: File): List<CentralEntry> {
            try {
                RandomAccessFile(file, "r").use { raf ->
                    val length = raf.length()
                    if (length < 22L) throw OfficeException("office_damaged", "这个文档不完整")
                    val tail = minOf(length, 65_557L + 22L).toInt()
                    val bytes = ByteArray(tail)
                    raf.seek(length - tail)
                    raf.readFully(bytes)
                    var eocd = -1
                    for (i in bytes.size - 22 downTo 0) {
                        if (u32(bytes, i) == 0x06054b50L) {
                            eocd = i
                            break
                        }
                    }
                    if (eocd < 0) throw OfficeException("office_damaged", "找不到文档目录（可能已损坏）")
                    val disk = u16(bytes, eocd + 4)
                    val cenDisk = u16(bytes, eocd + 6)
                    val countDisk = u16(bytes, eocd + 8)
                    val count = u16(bytes, eocd + 10)
                    val cenSize = u32(bytes, eocd + 12).toLong()
                    val cenOffset = u32(bytes, eocd + 16).toLong()
                    if (disk != 0 || cenDisk != 0 || countDisk != count) {
                        throw OfficeException("office_zip", "不支持分卷的 Office 文档")
                    }
                    if (count == 0xffff || cenSize == 0xffffffffL || cenOffset == 0xffffffffL) {
                        throw OfficeException("office_zip", "文档太大或太复杂，不能安全打开")
                    }
                    if (count > MAX_ENTRIES) throw OfficeException("office_zip", "文档里的文件太多，不能安全打开")
                    if (cenOffset < 0 || cenOffset >= length) throw OfficeException("office_damaged", "文档目录位置不对")
                    raf.seek(cenOffset)
                    val out = ArrayList<CentralEntry>(count)
                    var total = 0L
                    val seen = HashSet<String>()
                    repeat(count) {
                        val head = ByteArray(46)
                        raf.readFully(head)
                        if (u32(head, 0) != 0x02014b50L) throw OfficeException("office_damaged", "文档目录已损坏")
                        val flag = u16(head, 8)
                        val method = u16(head, 10)
                        val compressed = u32(head, 20).toLong()
                        val uncompressed = u32(head, 24).toLong()
                        val nameLen = u16(head, 28)
                        val extraLen = u16(head, 30)
                        val commentLen = u16(head, 32)
                        if (flag and 0x1 != 0) throw OfficeException("office_encrypted", "这个文档有密码，手机上不能预览")
                        if (uncompressed == 0xffffffffL || compressed == 0xffffffffL) {
                            throw OfficeException("office_zip", "文档太大或太复杂，不能安全打开")
                        }
                        if (method != 0 && method != 8) throw OfficeException("office_zip", "文档用了不支持的压缩方式")
                        if (nameLen <= 0 || nameLen > 1024) throw OfficeException("office_zip", "文档里有异常的文件名")
                        val nameBytes = ByteArray(nameLen)
                        raf.readFully(nameBytes)
                        val name = String(nameBytes, Charsets.UTF_8)
                        if (name.endsWith("/")) {
                            // Directory marker: not an entry parsers may read.
                            if (extraLen + commentLen > 0) raf.seek(raf.filePointer + extraLen + commentLen)
                            return@repeat
                        }
                        checkName(name)
                        if (!seen.add(name)) throw OfficeException("office_zip", "文档里有重复的路径，不能安全打开")
                        total += uncompressed
                        if (total > MAX_TOTAL) throw OfficeException("office_zip", "文档解开后太大，不能安全打开")
                        if (uncompressed > MAX_ENTRY) throw OfficeException("office_zip", "文档里有一块内容太大，不能安全打开")
                        if (uncompressed >= MIN_RATIO_SIZE && (compressed <= 0L || uncompressed / compressed > MAX_RATIO)) {
                            throw OfficeException("office_zip", "文档的压缩比异常，可能是压缩炸弹")
                        }
                        out.add(CentralEntry(name, flag, compressed, uncompressed))
                        if (extraLen + commentLen > 0) raf.seek(raf.filePointer + extraLen + commentLen)
                    }
                    return out
                }
            } catch (e: OfficeException) {
                throw e
            } catch (e: Exception) {
                throw OfficeException("office_damaged", "这个文档打不开（可能已损坏）", e)
            }
        }

        /** A ZIP entry name that cannot escape the archive or collide with a local file. */
        private fun checkName(name: String) {
            if (name.isEmpty() || name.length > 512) throw OfficeException("office_zip", "文档里有异常的文件名")
            if (name[0] == '/' || name.indexOf('\u0000') >= 0 || name.indexOf('\\') >= 0) {
                throw OfficeException("office_zip", "文档里有不安全的路径")
            }
            for (part in name.split('/')) {
                if (part == ".." || part == ".") throw OfficeException("office_zip", "文档里有不安全的路径")
            }
            if (name.length >= 2 && name[1] == ':') throw OfficeException("office_zip", "文档里有不安全的路径")
        }

        private fun u16(b: ByteArray, at: Int): Int = (b[at].toInt() and 0xff) or ((b[at + 1].toInt() and 0xff) shl 8)

        private fun u32(b: ByteArray, at: Int): Long =
            (b[at].toLong() and 0xff) or ((b[at + 1].toLong() and 0xff) shl 8) or
                ((b[at + 2].toLong() and 0xff) shl 16) or ((b[at + 3].toLong() and 0xff) shl 24)
    }
}
