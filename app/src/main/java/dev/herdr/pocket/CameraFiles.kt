package dev.herdr.pocket

import android.content.ContentProvider
import android.content.ContentValues
import android.content.Context
import android.database.Cursor
import android.database.MatrixCursor
import android.net.Uri
import android.os.ParcelFileDescriptor
import android.provider.OpenableColumns
import java.io.File
import java.util.UUID

/**
 * Hands the camera app one target file for ACTION_IMAGE_CAPTURE, without a support
 * library FileProvider. Not exported: access only through the per-intent URI grant, and only to
 * files named shot-<uuid>.jpg in the app's private cache.
 */
class CameraFiles : ContentProvider() {
    override fun onCreate() = true

    private fun fileFor(uri: Uri): File {
        val name = uri.lastPathSegment ?: throw SecurityException("bad uri")
        if (uri.pathSegments.size != 1 || !NAME.matches(name)) throw SecurityException("bad uri")
        return File(folder(context!!), name)
    }

    override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor =
        ParcelFileDescriptor.open(fileFor(uri), ParcelFileDescriptor.parseMode(mode))

    override fun getType(uri: Uri) = "image/jpeg"

    override fun query(uri: Uri, projection: Array<out String>?, selection: String?, args: Array<out String>?, sort: String?): Cursor {
        val file = fileFor(uri)
        return MatrixCursor(arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE)).apply { addRow(arrayOf<Any>(file.name, file.length())) }
    }

    override fun insert(uri: Uri, values: ContentValues?): Uri? = null
    override fun delete(uri: Uri, selection: String?, args: Array<out String>?) = 0
    override fun update(uri: Uri, values: ContentValues?, selection: String?, args: Array<out String>?) = 0

    companion object {
        const val AUTHORITY = "dev.herdr.pocket.camera"
        private val NAME = Regex("shot-[0-9a-f-]{36}\\.jpg")

        private fun folder(context: Context) = File(context.cacheDir, "camera").apply { mkdirs() }

        /** A fresh empty target; older leftovers (a capture that never came back) are removed. */
        fun newShot(context: Context): Pair<File, Uri> {
            folder(context).listFiles()?.forEach { if (System.currentTimeMillis() - it.lastModified() > 3_600_000) it.delete() }
            val file = File(folder(context), "shot-${UUID.randomUUID()}.jpg")
            file.createNewFile()
            return file to Uri.parse("content://$AUTHORITY/${file.name}")
        }
    }
}
