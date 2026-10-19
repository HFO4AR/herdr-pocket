package dev.herdr.pocket

import com.jcraft.jsch.Channel
import com.jcraft.jsch.ChannelExec
import com.jcraft.jsch.ChannelShell
import org.json.JSONObject
import java.util.Base64
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean

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

/**
 * One explicitly opened interactive PTY on the SSH session: the phone's own shell ([ChannelShell]) or a
 * live tmux attach ([ChannelExec] running the bridge's `--tmux-attach`, see SshTransport.terminal).
 * Never reconnects or resends input.
 *
 * Output: a reader thread fills the ring. A read with `wait` that finds nothing new arms a one-shot
 * [wake]: the next bytes (or the end) call it once, so the page reads right away instead of polling.
 * Armed before the ring is looked at, so bytes landing in between still wake (at worst one extra read).
 */
class ShellTerminal(private val channel: Channel, cols: Int, rows: Int, private val wake: (String) -> Unit = {}) : AutoCloseable {
    val id: String = UUID.randomUUID().toString()
    private val buffer = TerminalBuffer()
    private val input = channel.inputStream
    private val output = channel.outputStream
    @Volatile private var ended = false
    @Volatile private var readError = ""
    private val armed = AtomicBoolean(false)
    private var lastSequence = 0L
    init {
        val c = cols.coerceIn(20, 400); val r = rows.coerceIn(5, 200)
        when (channel) {
            is ChannelShell -> { channel.setPty(true); channel.setPtyType("xterm-256color", c, r, 0, 0) }
            is ChannelExec -> { channel.setPty(true); channel.setPtyType("xterm-256color", c, r, 0, 0) }
            else -> throw IllegalArgumentException("不支持的终端通道")
        }
        try { channel.connect(10000) } catch (e: Exception) { channel.disconnect(); throw e }
        Thread({
            try {
                val chunk = ByteArray(8192)
                while (true) { val n = input.read(chunk); if (n < 0) break; buffer.append(chunk, n); poke() }
            } catch (_: Exception) { if (!ended) readError = "终端连接中断；不会自动重连或重发输入。" }
            finally { ended = true; poke() }
        }, "pocket-shell-reader").apply { isDaemon = true; start() }
    }
    private fun poke() { if (armed.compareAndSet(true, false)) try { wake(id) } catch (_: Exception) {} }
    fun read(cursor: Long, wait: Boolean = false): JSONObject {
        if (wait && !ended) armed.set(true)
        val result = buffer.read(cursor)
        val empty = result.getString("data").isEmpty()
        if (!empty) armed.set(false)
        return result.put("ended", ended).put("error", readError).put("armed", wait && empty && !ended)
    }
    fun write(sequence: Long, text: String) {
        check(!ended && channel.isConnected) { "终端已经结束" }
        require(sequence == lastSequence + 1) { "输入序号已使用或不连续；未重发输入" }
        val data = text.toByteArray(Charsets.UTF_8)
        require(data.size in 1..16000) { "单次终端输入限制为 16000 UTF-8 字节" }
        // 在写入前消耗序号；失败后不允许重放未知结果。
        lastSequence = sequence
        output.write(data); output.flush()
    }
    fun resize(cols: Int, rows: Int) {
        val c = cols.coerceIn(20, 400); val r = rows.coerceIn(5, 200)
        when (channel) { is ChannelShell -> channel.setPtySize(c, r, 0, 0); is ChannelExec -> channel.setPtySize(c, r, 0, 0) }
    }
    override fun close() { ended = true; channel.disconnect() }
}
