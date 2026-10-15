package dev.herdr.pocket

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.IBinder
import org.json.JSONObject

/**
 * While the app is in the background, keeps the SSH session alive and polls
 * Herdr state (read-only "status") to notify when an agent finishes or needs
 * confirmation. It never sends input. Stops on return to the app, on
 * disconnect, after repeated failures or after [MAX_RUNTIME_MS].
 */
class WatchService : Service() {
    private lateinit var thread: HandlerThread
    private lateinit var handler: Handler
    private val last = HashMap<String, String>()
    private var startedAt = 0L
    private var failures = 0
    private var session = ""

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        PocketCore.init(this)
        thread = HandlerThread("pocket-watch").apply { start() }
        handler = Handler(thread.looper)
        channels()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val device = PocketCore.connectedDevice
        if (device == null || intent?.action == ACTION_STOP) { stopSelf(); return START_NOT_STICKY }
        session = intent?.getStringExtra(EXTRA_SESSION).orEmpty()
        intent?.getStringExtra(EXTRA_STATES)?.let { seed(it) }
        val ongoing = Notification.Builder(this, CHANNEL_WATCH)
            .setSmallIcon(R.drawable.ic_launcher)
            .setContentTitle("正在关注 " + device.optString("name"))
            .setContentText("Agent 完成或等你确认时会提醒你")
            .setContentIntent(open(null))
            .setOngoing(true)
            .addAction(Notification.Action.Builder(null, "停止关注",
                PendingIntent.getService(this, 1, Intent(this, WatchService::class.java).setAction(ACTION_STOP), PendingIntent.FLAG_IMMUTABLE)).build())
            .build()
        if (Build.VERSION.SDK_INT >= 34) startForeground(ONGOING_ID, ongoing, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        else startForeground(ONGOING_ID, ongoing)
        startedAt = System.currentTimeMillis(); failures = 0
        handler.removeCallbacksAndMessages(null)
        handler.postDelayed(::poll, POLL_MS)
        return START_NOT_STICKY
    }

    // The UI hands over the states it already showed, so only later changes notify.
    private fun seed(raw: String) {
        last.clear()
        try { val o = JSONObject(raw); o.keys().forEach { last[it] = o.getString(it) } } catch (_: Exception) {}
    }

    private fun poll() {
        if (PocketCore.connectedDevice == null || System.currentTimeMillis() - startedAt > MAX_RUNTIME_MS || session.isEmpty()) { stopSelf(); return }
        try {
            val agents = PocketCore.request(JSONObject().put("op", "status").put("session", session)).getJSONArray("agents")
            failures = 0
            for (i in 0 until agents.length()) {
                val a = agents.getJSONObject(i)
                val key = a.optString("pane_id") + "/" + a.optString("identity")
                val now = a.optString("agent_status")
                val was = last.put(key, now)
                if (was == null || was == now) continue
                val title = displayTitle(a)
                when {
                    now == "blocked" -> notify(key, "$title 在等你确认", "打开处理确认提示", a.optString("pane_id"), true)
                    was == "working" && (now == "idle" || now == "done") -> notify(key, "$title 完成了", "点开查看回复", a.optString("pane_id"), false)
                }
            }
        } catch (_: Exception) {
            if (++failures >= 5) { stopSelf(); return }
        }
        handler.postDelayed(::poll, POLL_MS)
    }

    private fun displayTitle(a: JSONObject): String {
        val raw = a.optString("terminal_title_stripped").ifEmpty { a.optString("terminal_title") }.ifEmpty { a.optString("title") }
        val clean = raw.replace(Regex("^[✳⠀-⣿·•*]+\\s*"), "").replace(Regex("\\s*\\|\\s*[^|]+$"), "").trim()
        val name = if (a.optString("agent") == "claude") "Claude" else if (a.optString("agent") == "codex") "Codex" else "Agent"
        return if (clean.isEmpty() || clean.endsWith(": ch")) name else "$name · ${clean.take(40)}"
    }

    private fun notify(key: String, title: String, text: String, pane: String, urgent: Boolean) {
        val manager = getSystemService(NotificationManager::class.java)
        val n = Notification.Builder(this, if (urgent) CHANNEL_ALERT else CHANNEL_DONE)
            .setSmallIcon(R.drawable.ic_launcher)
            .setContentTitle(title)
            .setContentText(text)
            .setContentIntent(open(pane))
            .setAutoCancel(true)
            .setCategory(if (urgent) Notification.CATEGORY_REMINDER else Notification.CATEGORY_STATUS)
            .build()
        manager.notify(key.hashCode(), n)
    }

    private fun open(pane: String?): PendingIntent {
        val intent = Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        if (pane != null) intent.putExtra(EXTRA_PANE, pane)
        return PendingIntent.getActivity(this, pane?.hashCode() ?: 0, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }

    private fun channels() {
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(NotificationChannel(CHANNEL_WATCH, "后台连接", NotificationManager.IMPORTANCE_MIN).apply { setShowBadge(false) })
        manager.createNotificationChannel(NotificationChannel(CHANNEL_ALERT, "等你确认", NotificationManager.IMPORTANCE_HIGH))
        manager.createNotificationChannel(NotificationChannel(CHANNEL_DONE, "Agent 完成", NotificationManager.IMPORTANCE_DEFAULT))
    }

    override fun onDestroy() {
        handler.removeCallbacksAndMessages(null)
        thread.quitSafely()
        super.onDestroy()
    }

    companion object {
        const val ACTION_STOP = "dev.herdr.pocket.STOP_WATCH"
        const val EXTRA_SESSION = "session"
        const val EXTRA_STATES = "states"
        const val EXTRA_PANE = "pane"
        private const val CHANNEL_WATCH = "watch"
        private const val CHANNEL_ALERT = "alert"
        private const val CHANNEL_DONE = "done"
        private const val ONGOING_ID = 1
        private const val POLL_MS = 20_000L
        private const val MAX_RUNTIME_MS = 8 * 60 * 60 * 1000L

        fun start(context: Context, session: String, states: String) {
            val intent = Intent(context, WatchService::class.java).putExtra(EXTRA_SESSION, session).putExtra(EXTRA_STATES, states)
            context.startForegroundService(intent)
        }
        fun stop(context: Context) { context.stopService(Intent(context, WatchService::class.java)) }
    }
}
