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
import android.os.SystemClock
import org.json.JSONObject

/**
 * While the app is in the background (or swiped away from recents), keeps the SSH session alive so
 * coming back needs no new login. Two parts, each optional:
 * - keep: holds the process at foreground-service priority so Android does not freeze it and JSch's
 *   keepalives keep flowing, for the time chosen in 设置 → 后台保持连接 (15 分钟 / 1 小时 / 4 小时 /
 *   一直保持). When it runs out the session is closed cleanly (battery) and the app reconnects on return.
 * - alerts: polls Herdr state (read-only "status") to notify when an agent finishes or needs
 *   confirmation, up to [MAX_RUNTIME_MS].
 * It never sends input. Stops on return to the app, on disconnect, when the session is gone (keep
 * only: the app reconnects on return instead of logging in again in the background) and after
 * repeated failures. With notifications blocked the keep part still runs; Android then hides the
 * ongoing notification (it stays listed in the system's active-apps list). If the system or an OEM
 * battery manager kills the process anyway, the session ends with it and the app connects again
 * when opened.
 *
 * No wake lock: in deep sleep JSch's keepalive thread pauses; on return the app checks the session
 * with one channel open before trusting it (see PocketCore.enterForeground).
 *
 * Sub-agents: Herdr reports only the parent pane, which reads idle/done while its sub-agents
 * still run. Before calling a stop "做完了" the watcher asks the bridge's read-only `glance`
 * (sub-agents only) for that agent's record; while any runs the agent is held as "kids" (the
 * app shows 子 Agent 运行中) and 做完了 comes once they have finished.
 */
class WatchService : Service() {
    private lateinit var thread: HandlerThread
    private lateinit var handler: Handler
    private val last = HashMap<String, String>()
    // Each agent's record as the app knows it (provider, thread, record_id, cwd or remote): what to ask about sub-agents.
    private val kidItems = HashMap<String, JSONObject>()
    // When each agent was seen starting to work (only changes seen by this watcher; the seed is unknown).
    private val workingSince = HashMap<String, Long>()
    // Agent notifications currently posted by this run: key → line for the group summary.
    private val posted = LinkedHashMap<String, Posted>()
    private var startedAt = 0L
    private var failures = 0
    private var session = ""
    private var deviceName = ""
    private var ongoingText = ""
    // Keep part: on/off and when it ends (elapsedRealtime, 0 = 一直保持). Alerts end at alertsUntil.
    private var keep = false
    private var keepUntil = 0L
    private var alertsUntil = 0L

    private class Posted(val title: String, val text: String, val urgent: Boolean)

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        PocketCore.init(this)
        thread = HandlerThread("pocket-watch").apply { start() }
        handler = Handler(thread.looper)
        ensureChannels(this)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val device = PocketCore.connectedDevice
        if (intent?.action == ACTION_DISCONNECT) {
            // 断开 on the notification: end the session for real; the app shows the devices page.
            PocketCore.stats.notificationDisconnects.incrementAndGet()
            if (device != null) { PocketCore.disconnect(); PocketCore.listener?.invoke("disconnected", "") }
            end(); return START_NOT_STICKY
        }
        if (device == null) { end(); return START_NOT_STICKY }
        if (intent?.action == ACTION_STOP) {
            // 停止关注: alerts end; the connection stays while the keep part runs.
            if (!keep || session.isEmpty()) { end(); return START_NOT_STICKY }
            session = ""; handler.removeCallbacksAndMessages(null)
            manager().notify(ONGOING_ID, ongoing(emptyList())); handler.postDelayed(::poll, KEEP_TICK_MS)
            return START_NOT_STICKY
        }
        session = intent?.getStringExtra(EXTRA_SESSION).orEmpty()
        keep = intent?.getBooleanExtra(EXTRA_KEEP, false) == true
        val minutes = intent?.getIntExtra(EXTRA_KEEP_MINUTES, 60) ?: 60
        val now = SystemClock.elapsedRealtime()
        keepUntil = if (keep && minutes > 0) now + minutes * 60_000L else 0L
        alertsUntil = now + MAX_RUNTIME_MS
        if (!keep && session.isEmpty()) { end(); return START_NOT_STICKY }
        deviceName = device.optString("name")
        intent?.getStringExtra(EXTRA_STATES)?.let { seed(it) }
        kidItems.clear()
        intent?.getStringExtra(EXTRA_KIDS)?.let { raw ->
            try { val o = JSONObject(raw); o.keys().forEach { k -> o.optJSONObject(k)?.let { kidItems[k] = it } } } catch (_: Exception) {}
        }
        running = true
        val ongoing = ongoing(last.values.toList())
        lastOngoing = ongoingText
        if (Build.VERSION.SDK_INT >= 34) startForeground(ONGOING_ID, ongoing, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        else startForeground(ONGOING_ID, ongoing)
        startedAt = System.currentTimeMillis(); failures = 0
        handler.removeCallbacksAndMessages(null)
        handler.postDelayed(::poll, if (session.isEmpty()) KEEP_TICK_MS else POLL_MS)
        return START_NOT_STICKY
    }

    /**
     * Ends what has run out. Returns false when nothing is left and the service stopped. Handler
     * delays do not advance while the CPU sleeps, so this runs late after deep sleep; the deadlines
     * use elapsedRealtime, which does count sleep.
     */
    private fun stillNeeded(): Boolean {
        val now = SystemClock.elapsedRealtime()
        if (session.isNotEmpty() && now > alertsUntil) session = ""
        val keeping = keep && (keepUntil == 0L || now < keepUntil)
        if (session.isNotEmpty() || keeping) return true
        // Time is up: close the session cleanly instead of holding it open for nobody.
        PocketCore.sleep()
        end()
        return false
    }

    // The UI hands over the states it already showed, so only later changes notify.
    private fun seed(raw: String) {
        last.clear(); workingSince.clear()
        try { val o = JSONObject(raw); o.keys().forEach { last[it] = o.getString(it) } } catch (_: Exception) {}
    }

    /** Calm and informative: how many agents, what they are doing, on which computer. */
    private fun ongoing(states: List<String>): Notification {
        if (session.isEmpty()) return keeping()
        val working = states.count { it == "working" || it == "kids" }
        val blocked = states.count { it == "blocked" }
        val text = listOfNotNull(
            if (blocked > 0) "$blocked 个等你确认" else null,
            if (working > 0) "$working 个在执行" else null,
        ).joinToString(" · ").ifEmpty { "都空着，有动静会提醒你" }
        val title = if (states.isEmpty()) "正在关注 Agent" else "正在关注 ${states.size} 个 Agent"
        ongoingText = "$title\n$text"
        return Notification.Builder(this, CHANNEL_BACKGROUND)
            .setSmallIcon(R.drawable.ic_notification)
            .setColor(ACCENT)
            .setContentTitle(title)
            .setContentText(text)
            .setSubText(deviceName.ifEmpty { null })
            .setContentIntent(open(null))
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setShowWhen(false)
            .setCategory(Notification.CATEGORY_SERVICE)
            .addAction(Notification.Action.Builder(null, "停止关注",
                PendingIntent.getService(this, 1, Intent(this, WatchService::class.java).setAction(ACTION_STOP), PendingIntent.FLAG_IMMUTABLE)).build())
            .apply { if (keep) addAction(disconnectAction()) }
            .build()
    }

    /** Keep only: a quiet line saying which computer stays connected and for how long (countdown). */
    private fun keeping(): Notification {
        val title = if (deviceName.isEmpty()) "保持和电脑的连接" else "保持和 $deviceName 的连接"
        val text = if (keepUntil == 0L) "回来直接接着用，不用了点「断开」" else "回来直接接着用，到时间自动断开"
        ongoingText = "$title\n$text"
        val b = Notification.Builder(this, CHANNEL_BACKGROUND)
            .setSmallIcon(R.drawable.ic_notification)
            .setColor(ACCENT)
            .setContentTitle(title)
            .setContentText(text)
            .setContentIntent(open(null))
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setCategory(Notification.CATEGORY_SERVICE)
            .addAction(disconnectAction())
        if (keepUntil > 0L) {
            val left = keepUntil - SystemClock.elapsedRealtime()
            b.setShowWhen(true).setWhen(System.currentTimeMillis() + left).setUsesChronometer(true).setChronometerCountDown(true)
        } else b.setShowWhen(false)
        return b.build()
    }

    private fun disconnectAction() = Notification.Action.Builder(null, "断开",
        PendingIntent.getService(this, 3, Intent(this, WatchService::class.java).setAction(ACTION_DISCONNECT), PendingIntent.FLAG_IMMUTABLE)).build()

    private fun poll() {
        if (PocketCore.connectedDevice == null) { end(); return }
        val alerting = session.isNotEmpty()
        if (!stillNeeded()) return
        if (session.isEmpty()) {
            // Alerts just ran out: the notification switches to the keep line.
            if (alerting) manager().notify(ONGOING_ID, ongoing(emptyList()))
            // Keep only. The session dropped (network gone, keepalives unanswered): nothing to keep.
            // No background login; the app reconnects once the person opens it.
            if (!PocketCore.transport.isConnected()) { end(); return }
            handler.postDelayed(::poll, KEEP_TICK_MS); return
        }
        try {
            val agents = PocketCore.request(JSONObject().put("op", "status").put("session", session)).getJSONArray("agents")
            failures = 0
            val seen = HashMap<String, String>()
            val listed = LinkedHashMap<String, JSONObject>()
            for (i in 0 until agents.length()) {
                val a = agents.getJSONObject(i)
                listed[a.optString("pane_id") + "/" + a.optString("identity")] = a
            }
            // Agents that look finished after working (or after waiting on sub-agents): ask once, batched.
            val kids = kidsRunning(listed.filter { (k, a) -> a.optString("agent_status") in STOPPED && last[k] in BUSY && kidItems.containsKey(k) }.keys)
            for ((key, a) in listed) {
                val status = a.optString("agent_status")
                val running = if (key in kids) kids[key] else null
                // Unknown (the check failed): an agent already held for sub-agents stays held.
                val now = if (status in STOPPED && ((running ?: 0) > 0 || (key in kids && running == null && last[key] == "kids"))) "kids" else status
                seen[key] = now
                val was = last.put(key, now)
                if (was == null || was == now) continue
                // A parent woken by its sub-agents keeps the start of the whole job.
                if (now == "working") { if (was == "kids") workingSince.putIfAbsent(key, System.currentTimeMillis()) else workingSince[key] = System.currentTimeMillis() }
                // Answered or handled on the computer: the "waiting" alert is stale now.
                if (was == "blocked" && posted[key]?.urgent == true) cancel(key)
                val title = displayTitle(a)
                when {
                    now == "blocked" -> notify(key, title, blockedText(a), a.optString("pane_id"), true)
                    (was == "working" || was == "kids") && (now == "idle" || now == "done") -> {
                        val took = workingSince.remove(key)?.let { " · 用时 " + duration(System.currentTimeMillis() - it) }.orEmpty()
                        notify(key, title, "做完了$took", a.optString("pane_id"), false)
                    }
                }
            }
            last.keys.retainAll(seen.keys)
            ongoing(seen.values.toList()).let { n -> if (ongoingText != lastOngoing) { lastOngoing = ongoingText; manager().notify(ONGOING_ID, n) } }
        } catch (_: Exception) {
            // PocketCore already reconnected once if the session was dead; repeated failures mean the
            // computer or tunnel is unreachable. Say so instead of silently losing alerts.
            if (++failures >= 5) {
                notify("watch-stopped", "后台关注停了", "连不上电脑，已停止提醒；回到 App 会重新连接", "", false, grouped = false)
                // Nothing to keep either: the computer is unreachable.
                end(); return
            }
        }
        handler.postDelayed(::poll, POLL_MS)
    }
    private var lastOngoing = ""

    /** key → running sub-agents (null when unknown) via the read-only `glance` op; no preview is read. */
    private fun kidsRunning(keys: Set<String>): Map<String, Int?> {
        if (keys.isEmpty()) return emptyMap()
        val out = HashMap<String, Int?>()
        keys.forEach { out[it] = null }
        try {
            val items = org.json.JSONArray()
            keys.forEach { k -> kidItems[k]?.let { items.put(JSONObject(it.toString()).put("key", k).put("kids", true).put("preview", false)) } }
            val previews = PocketCore.request(JSONObject().put("op", "glance").put("items", items)).optJSONObject("previews") ?: return out
            for (k in keys) {
                val report = previews.optJSONObject(k)?.optJSONObject("kids") ?: continue
                if (report.has("running")) out[k] = report.optInt("running")
            }
        } catch (_: Exception) {}
        return out
    }

    /** "在等你确认：<question>" when a read-only look at the screen finds one; otherwise generic. */
    private fun blockedText(a: JSONObject): String {
        val question = try {
            PocketCore.request(JSONObject().put("op", "read").put("session", session)
                .put("target", a.optString("pane_id")).put("identity", a.optString("identity")))
                .optJSONObject("menu")?.optString("question").orEmpty()
        } catch (_: Exception) { "" }
        val line = question.lineSequence().map { it.trim() }.firstOrNull { it.isNotEmpty() }.orEmpty()
        return if (line.isEmpty()) "在等你确认" else "在等你确认：" + (if (line.length > 80) line.take(79) + "…" else line)
    }

    // Same as the app: "3:12" under an hour, then "1 小时 5 分".
    private fun duration(ms: Long): String {
        val s = (ms / 1000).coerceAtLeast(0)
        if (s < 3600) return "${s / 60}:${"%02d".format(s % 60)}"
        val h = s / 3600
        return if (h < 24) "$h 小时 ${s % 3600 / 60} 分" else "${h / 24} 天"
    }

    // Same naming as the app: Herdr's agent title first, skipping generic "<dir>: ch" titles.
    private fun displayTitle(a: JSONObject): String {
        val name = if (a.optString("agent") == "claude") "Claude" else if (a.optString("agent") == "codex") "Codex" else "Agent"
        val generic = Regex("^[^:]{1,60}:\\s*(ch|claude|codex|bash|zsh|sh|ssh)$", RegexOption.IGNORE_CASE)
        for (raw in listOf(a.optString("title"), a.optString("terminal_title_stripped"), a.optString("terminal_title"))) {
            val clean = raw.replace(Regex("^[\\s✳✻✽✶⠀-⣿·•*]+"), "").replace(Regex("\\s*\\|\\s*[^|]+$"), "").trim()
            if (clean.isNotEmpty() && !generic.matches(clean) && !clean.equals(name, true)) return "$name · ${clean.take(40)}"
        }
        val project = a.optString("foreground_cwd").ifEmpty { a.optString("cwd") }.trimEnd('/').substringAfterLast('/')
        return if (project.isEmpty()) name else "$name · $project"
    }

    private fun manager() = getSystemService(NotificationManager::class.java)

    /** One notification per agent (a newer state replaces the older one), grouped under a summary. Tap = open that chat. */
    private fun notify(key: String, title: String, text: String, pane: String, urgent: Boolean, grouped: Boolean = true) {
        val manager = manager()
        if (!manager.areNotificationsEnabled()) return
        val b = Notification.Builder(this, if (urgent) CHANNEL_ALERT else CHANNEL_DONE)
            .setSmallIcon(R.drawable.ic_notification)
            .setColor(ACCENT)
            .setContentTitle(title)
            .setContentText(text)
            .setStyle(Notification.BigTextStyle().bigText(text))
            .setContentIntent(open(pane.ifEmpty { null }))
            .setAutoCancel(true)
            .setShowWhen(true)
            .setCategory(if (urgent) Notification.CATEGORY_REMINDER else Notification.CATEGORY_STATUS)
        if (grouped) b.setGroup(GROUP)
        manager.notify(key.hashCode(), b.build())
        if (!grouped) return
        posted.remove(key); posted[key] = Posted(title, text, urgent)
        summary(key)
    }

    private fun cancel(key: String) {
        manager().cancel(key.hashCode()); posted.remove(key); summary()
    }

    /** "2 个 Agent 有新消息" with one line each; alerts come from the children, never twice. */
    private fun summary(fresh: String? = null) {
        val manager = manager()
        // Drop the ones the user already swiped away or tapped.
        val showing = manager.activeNotifications.map { it.id }.toSet()
        posted.keys.retainAll { it == fresh || it.hashCode() in showing }
        if (posted.size < 2) { manager.cancel(SUMMARY_ID); return }
        val waiting = posted.values.count { it.urgent }
        val style = Notification.InboxStyle()
        posted.values.toList().takeLast(6).asReversed().forEach { style.addLine("${it.title}：${it.text}") }
        val head = listOfNotNull(if (waiting > 0) "$waiting 个等你确认" else null,
            (posted.size - waiting).takeIf { it > 0 }?.let { "$it 个做完了" }).joinToString(" · ")
        style.setSummaryText(deviceName.ifEmpty { null })
        manager.notify(SUMMARY_ID, Notification.Builder(this, if (waiting > 0) CHANNEL_ALERT else CHANNEL_DONE)
            .setSmallIcon(R.drawable.ic_notification)
            .setColor(ACCENT)
            .setContentTitle(head)
            .setContentText(posted.values.last().title)
            .setStyle(style)
            .setGroup(GROUP).setGroupSummary(true)
            .setGroupAlertBehavior(Notification.GROUP_ALERT_CHILDREN)
            .setContentIntent(open(null))
            .setAutoCancel(true)
            .build())
    }

    private fun open(pane: String?): PendingIntent {
        val intent = Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        if (pane != null) intent.putExtra(EXTRA_PANE, pane)
        return PendingIntent.getActivity(this, pane?.hashCode() ?: 0, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }

    /** Stops on its own: from now on nothing keeps the session warm, so the app checks it on return. */
    private fun end() { PocketCore.keepEnded(); stopSelf() }

    override fun onDestroy() {
        running = false
        handler.removeCallbacksAndMessages(null)
        thread.quitSafely()
        super.onDestroy()
    }

    companion object {
        const val ACTION_STOP = "dev.herdr.pocket.STOP_WATCH"
        const val ACTION_DISCONNECT = "dev.herdr.pocket.DISCONNECT"
        const val EXTRA_KEEP = "keep"
        const val EXTRA_KEEP_MINUTES = "keepMinutes"
        /** True while the service runs (it holds the session for the app). */
        @Volatile var running = false
            private set
        const val EXTRA_SESSION = "session"
        const val EXTRA_STATES = "states"
        const val EXTRA_KIDS = "kids"
        private val STOPPED = setOf("idle", "done")
        private val BUSY = setOf("working", "kids")
        const val EXTRA_PANE = "pane"
        private const val CHANNEL_BACKGROUND = "background"
        private const val CHANNEL_ALERT = "alert"
        private const val CHANNEL_DONE = "done"
        private const val ONGOING_ID = 1
        private const val SUMMARY_ID = 2
        private const val GROUP = "dev.herdr.pocket.AGENTS"
        private const val ACCENT = 0xFFF57B4A.toInt()
        private const val POLL_MS = 20_000L
        private const val KEEP_TICK_MS = 60_000L
        private const val MAX_RUNTIME_MS = 8 * 60 * 60 * 1000L

        /**
         * The three alert channels. Created as soon as alerts are on (app start, 设置 → 后台提醒), not
         * only when the watcher first runs, so they can be tuned in the system settings right away.
         * Idempotent: Android keeps the user's changes to an existing channel.
         */
        fun ensureChannels(context: Context) {
            val manager = context.getSystemService(NotificationManager::class.java) ?: return
            // The first watcher channel was IMPORTANCE_MIN; importance can't be raised in place, so it is replaced.
            manager.deleteNotificationChannel("watch")
            manager.createNotificationChannel(NotificationChannel(CHANNEL_ALERT, "等你确认", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "Agent 停下来等你批准或回答时"
            })
            manager.createNotificationChannel(NotificationChannel(CHANNEL_DONE, "做完了", NotificationManager.IMPORTANCE_DEFAULT).apply {
                description = "Agent 做完一轮、等你下一句时"
            })
            manager.createNotificationChannel(NotificationChannel(CHANNEL_BACKGROUND, "后台连接", NotificationManager.IMPORTANCE_LOW).apply {
                description = "切到后台时保持连接的常驻通知，不响不振"
                setShowBadge(false)
            })
        }
        /** [session] empty = no alerts; [keep] = hold the connection for [keepMinutes] (0 = until stopped). */
        fun start(context: Context, session: String, states: String, kids: String = "{}", keep: Boolean = false, keepMinutes: Int = 60) {
            val intent = Intent(context, WatchService::class.java).putExtra(EXTRA_SESSION, session).putExtra(EXTRA_STATES, states).putExtra(EXTRA_KIDS, kids)
                .putExtra(EXTRA_KEEP, keep).putExtra(EXTRA_KEEP_MINUTES, keepMinutes)
            context.startForegroundService(intent)
        }
        fun stop(context: Context) { context.stopService(Intent(context, WatchService::class.java)) }
    }
}
