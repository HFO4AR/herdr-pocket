package dev.herdr.pocket

import com.jcraft.jsch.ChannelShell
import org.json.JSONObject
import java.util.Base64
import java.util.UUID

/** Bounded byte ring: absolute cursors make poll retries safe, even across UTF-8 splits. */
class TerminalBuffer(private val capacity: Int = 1_048_576) {
    private val bytes = ByteArray(capacity)
    private var end = 0L
    @Synchronized fun append(data: ByteArray, size: Int) {
        for (i in 0 until size) bytes[((end + i) % capacity).toInt()] = data[i]
        end += size
    }
    @Synchronized fun read(cursor: Long): JSONObject {
        val start = maxOf(0L, end - capacity)
        require(cursor in 0..end) { "终端读取位置无效" }
        val from = maxOf(cursor, start)
        val count = minOf(end - from, 65536L).toInt()
        val chunk = ByteArray(count) { bytes[((from + it) % capacity).toInt()] }
        return JSONObject().put("data", Base64.getEncoder().encodeToString(chunk))
            .put("next", from + count).put("lost", cursor < start)
    }
}

/** One explicitly opened interactive SSH PTY; never reconnects or resends input. */
class ShellTerminal(private val channel: ChannelShell, cols: Int, rows: Int) : AutoCloseable {
    val id: String = UUID.randomUUID().toString()
    private val buffer = TerminalBuffer()
    private val input = channel.inputStream
    private val output = channel.outputStream
    @Volatile private var ended = false
    @Volatile private var readError = ""
    private var lastSequence = 0L
    init {
        channel.setPty(true)
        channel.setPtyType("xterm-256color", cols.coerceIn(20, 400), rows.coerceIn(5, 200), 0, 0)
        try { channel.connect(10000) } catch (e: Exception) { channel.disconnect(); throw e }
        Thread({
            try {
                val chunk = ByteArray(8192)
                while (true) { val n = input.read(chunk); if (n < 0) break; buffer.append(chunk, n) }
            } catch (_: Exception) { if (!ended) readError = "终端连接中断；不会自动重连或重发输入。" }
            finally { ended = true }
        }, "pocket-shell-reader").apply { isDaemon = true; start() }
    }
    fun read(cursor: Long) = buffer.read(cursor).put("ended", ended).put("error", readError)
    fun write(sequence: Long, text: String) {
        check(!ended && channel.isConnected) { "终端已经结束" }
        require(sequence == lastSequence + 1) { "输入序号已使用或不连续；未重发输入" }
        val data = text.toByteArray(Charsets.UTF_8)
        require(data.size in 1..16000) { "单次终端输入限制为 16000 UTF-8 字节" }
        // 在写入前消耗序号；失败后不允许重放未知结果。
        lastSequence = sequence
        output.write(data); output.flush()
    }
    fun resize(cols: Int, rows: Int) { channel.setPtySize(cols.coerceIn(20, 400), rows.coerceIn(5, 200), 0, 0) }
    override fun close() { ended = true; channel.disconnect() }
}
