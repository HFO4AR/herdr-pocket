package dev.herdr.pocket

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test
import java.io.File
import java.nio.file.Files

/** Waiting pictures live on disk: any number stay available until sent or removed. */
class ImagePrepStoreTest {
    @Test
    fun anyNumberOfPicturesStayAvailableUntilDropped() {
        val dir = Files.createTempDirectory("pictures").toFile()
        val stale = File(dir, "left-behind").apply { writeText("old") }
        ImagePrep.init(dir)
        assertFalse("a page that is gone left it", stale.exists())
        val all = (1..40).map { n -> ImagePrep.store(ByteArray(1000) { n.toByte() }, "jpg", byteArrayOf(n.toByte()), n, n) to n }
        for ((p, n) in all) {
            val back = assertNotNull(ImagePrep.get(p.id)).let { ImagePrep.get(p.id)!! }
            assertArrayEquals(ByteArray(1000) { n.toByte() }, back.bytes)
            assertArrayEquals(byteArrayOf(n.toByte()), back.thumb)
            assertEquals(1000, back.size)
            assertEquals(sha256(ByteArray(1000) { n.toByte() }), back.sha256)
        }
        assertEquals(80, dir.listFiles()!!.size)
        val first = all.first().first
        ImagePrep.drop(first.id)
        assertNull(ImagePrep.get(first.id))
        assertEquals("nothing left on disk for it", 78, dir.listFiles()!!.size)
        dir.deleteRecursively()
    }
}
