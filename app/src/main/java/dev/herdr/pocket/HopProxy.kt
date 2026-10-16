package dev.herdr.pocket

import com.jcraft.jsch.ChannelDirectTCPIP
import com.jcraft.jsch.JSchException
import com.jcraft.jsch.Proxy
import com.jcraft.jsch.Session
import com.jcraft.jsch.SocketFactory
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.Socket
import java.net.SocketTimeoutException

/**
 * Carries the next hop's SSH connection inside a `direct-tcpip` channel of the previous hop's
 * session (what `ssh -J` does). Nothing listens on the phone: no local port forward, no socket.
 * The previous hop's sshd only opens a TCP connection to [host]:[port]; agent forwarding stays off.
 *
 * JSch normally relies on the socket's SO_TIMEOUT to send keepalives and to bound the handshake.
 * A channel has no socket, so reads here time out the same way after [readTimeoutMs] without data
 * (a [SocketTimeoutException], which JSch treats exactly like a socket read timeout).
 */
class HopProxy(private val via: Session, private val readTimeoutMs: Int) : Proxy {
    private val pipe = TimedPipe(readTimeoutMs)
    @Volatile private var channel: ChannelDirectTCPIP? = null
    private var output: OutputStream? = null

    /** The previous hop could not open the tunnel (target unreachable from there, or forwarding disabled). */
    class ForwardRefused(cause: Exception) : IOException("跳板机没能打开转发", cause)

    override fun connect(socketFactory: SocketFactory?, host: String, port: Int, timeout: Int) {
        if (!via.isConnected) throw ForwardRefused(JSchException("session is down"))
        val opened = via.getStreamForwarder(host, port) as ChannelDirectTCPIP
        // Data from the remote end lands in our pipe; no thread is started for the other direction.
        opened.setOutputStream(pipe.sink)
        channel = opened
        try { opened.connect(if (timeout > 0) timeout else readTimeoutMs) }
        catch (e: JSchException) { close(); throw ForwardRefused(e) }
        output = opened.outputStream
    }
    override fun getInputStream(): InputStream = pipe.source
    override fun getOutputStream(): OutputStream = output ?: throw IOException("转发通道还没打开")
    override fun getSocket(): Socket? = null
    override fun close() {
        pipe.close()
        channel?.disconnect()
    }
}

/**
 * A bounded byte pipe whose reads time out like a socket. The writer is the previous hop's session
 * thread; it waits when [limit] bytes are unread (SSH flow control keeps this small in practice) and
 * is released when either side closes, so a dead next hop never wedges the previous one.
 */
class TimedPipe(private val timeoutMs: Int, private val limit: Int = 2 shl 20) {
    private val lock = Object()
    private val chunks = ArrayDeque<ByteArray>()
    private var head = 0 // read position inside chunks.first()
    private var size = 0
    private var closed = false

    val sink: OutputStream = object : OutputStream() {
        override fun write(b: Int) = write(byteArrayOf(b.toByte()), 0, 1)
        override fun write(b: ByteArray, off: Int, len: Int) {
            if (len <= 0) return
            synchronized(lock) {
                while (!closed && size > 0 && size + len > limit) lock.wait(1000)
                if (closed) throw IOException("pipe closed")
                chunks.addLast(b.copyOfRange(off, off + len)); size += len
                lock.notifyAll()
            }
        }
        override fun close() = this@TimedPipe.close()
    }

    val source: InputStream = object : InputStream() {
        override fun read(): Int {
            val one = ByteArray(1)
            return if (read(one, 0, 1) < 0) -1 else one[0].toInt() and 255
        }
        override fun read(b: ByteArray, off: Int, len: Int): Int {
            if (len == 0) return 0
            synchronized(lock) {
                val deadline = System.nanoTime() + timeoutMs * 1_000_000L
                while (size == 0) {
                    if (closed) return -1
                    val left = (deadline - System.nanoTime()) / 1_000_000L
                    if (left <= 0) throw SocketTimeoutException("Read timed out")
                    lock.wait(left)
                }
                var copied = 0
                while (copied < len && size > 0) {
                    val first = chunks.first()
                    val n = minOf(len - copied, first.size - head)
                    System.arraycopy(first, head, b, off + copied, n)
                    copied += n; head += n; size -= n
                    if (head == first.size) { chunks.removeFirst(); head = 0 }
                }
                lock.notifyAll()
                return copied
            }
        }
        override fun available(): Int = synchronized(lock) { size }
        override fun close() = this@TimedPipe.close()
    }

    /** End of stream for the reader (after it drained what is left); a waiting writer gives up. */
    fun close() = synchronized(lock) { closed = true; lock.notifyAll() }
}
