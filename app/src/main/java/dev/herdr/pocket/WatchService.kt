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
 * - alerts: polls Herdr state (read-only "status") to notify when an agent finishes, needs
 *   confirmation or asks a question, up to [MAX_RUNTIME_MS]. Keep only never posts alerts.
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
 * app shows 子 Agent 运行中) and 做完了 comes once they have finished. Background work that will
 * wake the agent again (the bridge's `bg.hold`: Claude's background shells and its monitors with a
 * timeout) holds it the same way (后台运行中); Codex terminals and persistent monitors never do.
 *
 * Codex questions: request_user_input_async ends Codex's turn, so Herdr reports idle while it
 * waits for an answer. When a Codex agent stops, the same `glance` (with "ask") says whether such a
 * question is still unanswered; it then becomes "ask" and posts 在问你 on the 等你确认 channel, once
 * per question. Questions the app already showed or the person put aside (暂不回答) come in the
 * seed and never notify. The alert goes away when the agent moves on. Decisions: [WatchRules].
 *
 * Several computers: every connected computer is kept, and each one the app showed agents for is
 * watched on its own (own session, seed and failure count; five failures in a row stop alerts for that
 * computer only). The ongoing notification says "已连接 N 台设备"; alerts name their computer; 断开
 * ends all connections.
 *
 * Battery: one status request per computer and poll, every 20 s while an agent works and every 60 s when all
 * wait or rest; at most one glance per poll, and only right after an agent stopped.
 */
class WatchService : Service() {
    private lateinit var thread: HandlerThread
    private lateinit var handler: Handler
    /**
     * One computer's agents (several can be connected; each is watched on its own, with its own
     * session, seed and failure count). Keys inside are "pane/identity" as in the app.
     */
    private class Watch(val id: String) {
        var session = ""
        var failures = 0
        val last = HashMap<String, String>()
        // Each agent's record as the app knows it (provider, thread, record_id, cwd or remote): what to ask about sub-agents.
        val kidItems = HashMap<String, JSONObject>()
        // When each agent was seen starting to work (only changes seen by this watcher; the seed is unknown).
        val workingSince = HashMap<String, Long>()
        // Codex questions: the unanswered one per agent, the transcript stamp it was read at (so an
        // unchanged transcript is answered with a stat only), re-checks left after a stop, the call ids
        // that must not notify (already posted, or already shown in the app) and the ones put aside.
        val asks = HashMap<String, WatchRules.Ask>()
        val askStamps = HashMap<String, String>()
        val askRetry = HashMap<String, Int>()
        val notifiedAsks = HashSet<String>()
        val asideAsks = HashSet<String>()
        val name: String get() = PocketCore.link(id)?.name.orEmpty()
        // Notification keys are per computer: two computers can have agents with the same key.
        fun key(k: String) = "$id|$k"
    }
    // Watched computers, in connection order.
    private val watches = LinkedHashMap<String, Watch>()
    // Agent notifications currently posted by this run: key → line for the group summary.
    private val posted = LinkedHashMap<String, Posted>()
    private var startedAt = 0L
    private var ongoingText = ""
    // Keep part: on/off and when it ends (elapsedRealtime, 0 = 一直保持). Alerts end at alertsUntil.
    private var keep = false
    private var keepUntil = 0L
    private var alertsUntil = 0L

    private class Posted(val title: String, val text: String, val kind: WatchRules.Alert) {
        val urgent get() = kind == WatchRules.Alert.BLOCKED || kind == WatchRules.Alert.ASK
    }

    private val alerting get() = watches.values.any { it.session.isNotEmpty() }
    private val several get() = PocketCore.links().size > 1

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        PocketCore.init(this)
        thread = HandlerThread("pocket-watch").apply { start() }
        handler = Handler(thread.looper)
        ensureChannels(this)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_DISCONNECT) {
            // 断开 on the notification: end every session for real; the app shows the devices page.
            PocketCore.stats.notificationDisconnects.incrementAndGet()
            if (PocketCore.hasLinks) { PocketCore.disconnect(); PocketCore.announce("disconnected") }
            end(); return START_NOT_STICKY
        }
        if (!PocketCore.hasLinks) { end(); return START_NOT_STICKY }
        if (intent?.action == ACTION_STOP) {
            // 停止关注: alerts end; the connections stay while the keep part runs.
            if (!keep || !alerting) { end(); return START_NOT_STICKY }
            watches.values.forEach { it.session = "" }; handler.removeCallbacksAndMessages(null)
            manager().notify(ONGOING_ID, ongoing(emptyList())); handler.postDelayed(::poll, KEEP_TICK_MS)
            return START_NOT_STICKY
        }
        keep = intent?.getBooleanExtra(EXTRA_KEEP, false) == true
        val minutes = intent?.getIntExtra(EXTRA_KEEP_MINUTES, 60) ?: 60
        val now = SystemClock.elapsedRealtime()
        keepUntil = if (keep && minutes > 0) now + minutes * 60_000L else 0L
        alertsUntil = now + MAX_RUNTIME_MS
        // {device id: {session, states, kids, asks}}: what the app showed last for each computer.
        val seeds = try { JSONObject(intent?.getStringExtra(EXTRA_WATCH) ?: "{}") } catch (_: Exception) { JSONObject() }
        watches.clear()
        for (link in PocketCore.links()) {
            val w = Watch(link.id)
            seeds.optJSONObject(link.id)?.let { seed ->
                w.session = seed.optString("session")
                seed(w, seed.optJSONObject("states"))
                seedAsks(w, seed.optJSONObject("asks"))
                seed.optJSONObject("kids")?.let { o -> o.keys().forEach { k -> o.optJSONObject(k)?.let { w.kidItems[k] = it } } }
            }
            watches[link.id] = w
        }
        if (!keep && !alerting) { end(); return START_NOT_STICKY }
        running = true
        val ongoing = ongoing(watches.values.flatMap { it.last.values })
        lastOngoing = ongoingText
        if (Build.VERSION.SDK_INT >= 34) startForeground(ONGOING_ID, ongoing, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        else startForeground(ONGOING_ID, ongoing)
        startedAt = System.currentTimeMillis()
        handler.removeCallbacksAndMessages(null)
        handler.postDelayed(::poll, if (alerting) POLL_MS else KEEP_TICK_MS)
        return START_NOT_STICKY
    }

    /**
     * Ends what has run out. Returns false when nothing is left and the service stopped. Handler
     * delays do not advance while the CPU sleeps, so this runs late after deep sleep; the deadlines
     * use elapsedRealtime, which does count sleep.
     */
    private fun stillNeeded(): Boolean {
        val now = SystemClock.elapsedRealtime()
        if (alerting && now > alertsUntil) watches.values.forEach { it.session = "" }
        val keeping = keep && (keepUntil == 0L || now < keepUntil)
        if (alerting || keeping) return true
        // Time is up: close the sessions cleanly instead of holding them open for nobody.
        PocketCore.sleep()
        end()
        return false
    }

    // The UI hands over the states it already showed, so only later changes notify.
    private fun seed(w: Watch, o: JSONObject?) {
        w.last.clear(); w.workingSince.clear()
        try { o?.keys()?.forEach { w.last[it] = o.getString(it) } } catch (_: Exception) {}
    }

    /** Questions the app already knows: {key: {call_id, aside}}. Shown ones count as waiting, none notify. */
    private fun seedAsks(w: Watch, o: JSONObject?) {
        w.asks.clear(); w.askStamps.clear(); w.askRetry.clear(); w.notifiedAsks.clear(); w.asideAsks.clear()
        try {
            o?.keys()?.forEach { k ->
                val v = o.optJSONObject(k) ?: return@forEach
                val id = v.optString("call_id").ifEmpty { return@forEach }
                w.notifiedAsks.add(id)
                if (v.optBoolean("aside")) { w.asideAsks.add(id); return@forEach }
                if (w.last[k] in WatchRules.STOPPED) { w.asks[k] = WatchRules.Ask(id, "", 0); w.last[k] = "ask" }
            }
        } catch (_: Exception) {}
    }

    /** "已连接 2 台设备" with several computers, otherwise the computer's name. */
    private fun devicesLine(): String? {
        val links = PocketCore.links()
        return if (links.size > 1) "已连接 ${links.size} 台设备" else links.firstOrNull()?.name?.ifEmpty { null }
    }

    /** Calm and informative: how many agents, what they are doing, on which computer(s). */
    private fun ongoing(states: List<String>): Notification {
        if (!alerting) return keeping()
        val working = states.count { it == "working" || it == "kids" }
        val text = WatchRules.counts(states.count { it == "blocked" }, states.count { it == "ask" }, working, "在执行")
            .ifEmpty { "都空着，有动静会提醒你" }
        val title = if (states.isEmpty()) "正在关注 Agent" else "正在关注 ${states.size} 个 Agent"
        ongoingText = "$title\n$text\n${devicesLine()}"
        return Notification.Builder(this, CHANNEL_BACKGROUND)
            .setSmallIcon(R.drawable.ic_notification)
            .setColor(ACCENT)
            .setContentTitle(title)
            .setContentText(text)
            .setSubText(devicesLine())
            .setContentIntent(open(null, null))
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setShowWhen(false)
            .setCategory(Notification.CATEGORY_SERVICE)
            .addAction(Notification.Action.Builder(null, "停止关注",
                PendingIntent.getService(this, 1, Intent(this, WatchService::class.java).setAction(ACTION_STOP), PendingIntent.FLAG_IMMUTABLE)).build())
            .apply { if (keep) addAction(disconnectAction()) }
            .build()
    }

    /** Keep only: a quiet line saying which computer(s) stay connected and for how long (countdown). */
    private fun keeping(): Notification {
        val links = PocketCore.links()
        val name = links.singleOrNull()?.name.orEmpty()
        val title = if (links.size > 1) "已连接 ${links.size} 台设备" else if (name.isEmpty()) "保持和电脑的连接" else "保持和 $name 的连接"
        val text = if (keepUntil == 0L) "回来直接接着用，不用了点「断开」" else "回来直接接着用，到时间自动断开"
        ongoingText = "$title\n$text"
        val b = Notification.Builder(this, CHANNEL_BACKGROUND)
            .setSmallIcon(R.drawable.ic_notification)
            .setColor(ACCENT)
            .setContentTitle(title)
            .setContentText(text)
            .setContentIntent(open(null, null))
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setCategory(Notification.CATEGORY_SERVICE)
            .addAction(disconnectAction())
        if (links.size > 1) b.setSubText(links.joinToString("、") { it.name }.take(60))
        if (keepUntil > 0L) {
            val left = keepUntil - SystemClock.elapsedRealtime()
            b.setShowWhen(true).setWhen(System.currentTimeMillis() + left).setUsesChronometer(true).setChronometerCountDown(true)
        } else b.setShowWhen(false)
        return b.build()
    }

    /** 断开 ends every connection (several computers: all of them). */
    private fun disconnectAction() = Notification.Action.Builder(null, if (several) "全部断开" else "断开",
        PendingIntent.getService(this, 3, Intent(this, WatchService::class.java).setAction(ACTION_DISCONNECT), PendingIntent.FLAG_IMMUTABLE)).build()

    private fun poll() {
        if (!PocketCore.hasLinks) { end(); return }
        val wasAlerting = alerting
        if (!stillNeeded()) return
        // Computers disconnected meanwhile (from the app before it went away) are not watched.
        val linked = PocketCore.links().map { it.id }.toSet()
        watches.keys.retainAll(linked)
        if (!alerting) {
            // Alerts just ran out: the notification switches to the keep line.
            if (wasAlerting) manager().notify(ONGOING_ID, ongoing(emptyList()))
            // Keep only. Every session dropped (network gone, keepalives unanswered): nothing to keep.
            // No background login; the app reconnects once the person opens it.
            if (PocketCore.links().none { it.transport.isConnected() }) { end(); return }
            handler.postDelayed(::poll, KEEP_TICK_MS); return
        }
        var next = Long.MAX_VALUE
        for (w in watches.values.toList()) if (w.session.isNotEmpty()) next = minOf(next, pollOne(w))
        ongoing(watches.values.flatMap { it.last.values }).let { n -> if (ongoingText != lastOngoing) { lastOngoing = ongoingText; manager().notify(ONGOING_ID, n) } }
        if (!alerting) {
            // Every watched computer failed repeatedly; keep the others' connections only if asked to.
            if (!keep) { end(); return }
            next = KEEP_TICK_MS
        }
        handler.postDelayed(::poll, if (next == Long.MAX_VALUE) KEEP_TICK_MS else next)
    }
    private var lastOngoing = ""

    /** One read-only status poll of one computer. Returns the delay until its next poll. */
    private fun pollOne(w: Watch): Long {
        try {
            val agents = PocketCore.request(w.id, JSONObject().put("op", "status").put("session", w.session)).getJSONArray("agents")
            w.failures = 0
            val seen = HashMap<String, String>()
            val listed = LinkedHashMap<String, JSONObject>()
            for (i in 0 until agents.length()) {
                val a = agents.getJSONObject(i)
                listed[a.optString("pane_id") + "/" + a.optString("identity")] = a
            }
            val last = w.last; val asks = w.asks; val askRetry = w.askRetry
            // Agents that look finished after working (or after waiting on sub-agents): their
            // sub-agents and, for Codex, an unanswered question. One glance for all of them.
            val kidKeys = listed.filter { (k, a) -> a.optString("agent_status") in STOPPED && last[k] in BUSY && w.kidItems.containsKey(k) }.keys
            val askKeys = listed.filter { (k, a) -> w.kidItems.containsKey(k) &&
                WatchRules.wantsAsk(a.optString("agent_status"), last[k], w.kidItems[k]?.optString("provider"), askRetry[k] ?: 0) }.keys
            val look = look(w, kidKeys, askKeys)
            for ((key, a) in listed) {
                val status = a.optString("agent_status")
                val was = last[key]
                if (status !in STOPPED) { asks.remove(key); w.askStamps.remove(key); askRetry.remove(key) }
                else if (key in askKeys) {
                    // Absent = the check failed; null = checked, nothing waits; "same" keeps what we had.
                    if (key in look.asks) {
                        val found = look.asks[key]
                        if (found == null) asks.remove(key) else if (found !== SAME) asks[key] = found
                    }
                    val left = WatchRules.retriesAfter(was in BUSY, askRetry[key] ?: 0, asks.containsKey(key))
                    if (left > 0) askRetry[key] = left else askRetry.remove(key)
                }
                val ask = asks[key]
                val now = WatchRules.effective(status, ask, ask != null && ask.callId in w.asideAsks, look.kids[key], key in look.kids, was)
                seen[key] = now
                last[key] = now
                val step = WatchRules.step(was, now, ask?.callId, w.notifiedAsks)
                if (was == null || was == now) continue
                // A parent woken by its sub-agents keeps the start of the whole job.
                if (now == "working") { if (was == "kids") w.workingSince.putIfAbsent(key, System.currentTimeMillis()) else w.workingSince[key] = System.currentTimeMillis() }
                // Answered or handled on the computer: the "waiting" alert is stale now.
                if (step.withdraw && posted[w.key(key)]?.urgent == true) cancel(w.key(key))
                val title = displayTitle(a)
                when (step.alert) {
                    WatchRules.Alert.BLOCKED -> notify(w, key, title, blockedText(w, a), a.optString("pane_id"), WatchRules.Alert.BLOCKED)
                    WatchRules.Alert.ASK -> {
                        w.notifiedAsks.add(ask!!.callId)
                        notify(w, key, title, WatchRules.askText(ask.text, ask.count), a.optString("pane_id"), WatchRules.Alert.ASK)
                    }
                    WatchRules.Alert.DONE -> {
                        val took = w.workingSince.remove(key)?.let { " · 用时 " + duration(System.currentTimeMillis() - it) }.orEmpty()
                        notify(w, key, title, "做完了$took", a.optString("pane_id"), WatchRules.Alert.DONE)
                    }
                    WatchRules.Alert.NONE -> {}
                }
            }
            last.keys.retainAll(seen.keys)
            listOf(asks, w.askStamps, askRetry).forEach { it.keys.retainAll(seen.keys) }
            return WatchRules.interval(seen.values, askRetry.isNotEmpty())
        } catch (_: Exception) {
            // PocketCore already reconnected once if the session was dead; repeated failures mean the
            // computer or tunnel is unreachable. Say so instead of silently losing alerts; the other
            // computers are still watched.
            if (++w.failures >= 5) {
                val name = w.name
                notify(w, "watch-stopped", "后台关注停了", "连不上" + (if (name.isEmpty()) "电脑" else " $name") + "，已停止提醒；回到 App 会重新连接", "", WatchRules.Alert.DONE, grouped = false)
                w.session = ""; w.last.clear()
            }
            return WatchRules.POLL_MS
        }
    }

    /** What one glance said: running sub-agents per key asked (null = unknown) and, per key asked
     *  about a question, the question, null for none or [SAME] for an unchanged transcript.
     *  A key missing from [asks] could not be checked. */
    private class Look(val kids: Map<String, Int?>, val asks: Map<String, WatchRules.Ask?>)

    /** At most one read-only `glance` per computer and poll (no preview is read; a question costs a stat when nothing changed). */
    private fun look(w: Watch, kidKeys: Set<String>, askKeys: Set<String>): Look {
        val kids = HashMap<String, Int?>()
        kidKeys.forEach { kids[it] = null }
        val found = HashMap<String, WatchRules.Ask?>()
        if (kidKeys.isEmpty() && askKeys.isEmpty()) return Look(kids, found)
        try {
            val items = org.json.JSONArray()
            (kidKeys + askKeys).forEach { k ->
                w.kidItems[k]?.let {
                    val item = JSONObject(it.toString()).put("key", k).put("kids", k in kidKeys).put("bg", k in kidKeys).put("preview", false)
                    if (k in askKeys) { item.put("ask", true); w.askStamps[k]?.let { s -> item.put("ask_stamp", s) } }
                    items.put(item)
                }
            }
            val previews = PocketCore.request(w.id, JSONObject().put("op", "glance").put("items", items)).optJSONObject("previews") ?: return Look(kids, found)
            for (k in kidKeys) {
                val p = previews.optJSONObject(k) ?: continue
                val report = p.optJSONObject("kids") ?: continue
                // Background work that will wake the agent again (Claude's shells, timed monitors)
                // holds it like a sub-agent; an older bridge sends no "bg".
                val hold = p.optJSONObject("bg")?.optInt("hold") ?: 0
                if (report.has("running")) kids[k] = report.optInt("running") + hold
            }
            for (k in askKeys) {
                val p = previews.optJSONObject(k) ?: continue
                val stamp = p.optString("ask_stamp")
                if (stamp.isEmpty()) continue
                if (p.optBoolean("ask_same")) { found[k] = SAME; continue }
                w.askStamps[k] = stamp
                found[k] = p.optJSONObject("ask")?.let { q ->
                    val text = q.optString("text")
                    WatchRules.Ask(q.optString("call_id").ifEmpty { "text:$text" }, text, q.optInt("count"))
                }
            }
        } catch (_: Exception) {}
        return Look(kids, found)
    }

    /** "在等你确认：<question>" when a read-only look at the screen finds one; otherwise generic. */
    private fun blockedText(w: Watch, a: JSONObject): String {
        val question = try {
            PocketCore.request(w.id, JSONObject().put("op", "read").put("session", w.session)
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

    // Display names of agent kinds Herdr detects, as in the app (app.js AGENT_KINDS); others: the kind, capitalized.
    private fun agentName(kind: String): String = KIND_NAMES[kind]
        ?: if (kind.isEmpty()) "Agent" else kind.replaceFirstChar { it.uppercaseChar() }

    // Same naming as the app: Herdr's agent title first, skipping generic "<dir>: ch" titles.
    private fun displayTitle(a: JSONObject): String {
        val kind = a.optString("agent")
        val name = agentName(kind)
        val generic = Regex("^[^:]{1,60}:\\s*(ch|claude|codex|bash|zsh|sh|ssh" + (if (kind.isEmpty()) "" else "|" + Regex.escape(kind)) + ")$", RegexOption.IGNORE_CASE)
        for (raw in listOf(a.optString("title"), a.optString("terminal_title_stripped"), a.optString("terminal_title"))) {
            val clean = raw.replace(Regex("^[\\s✳✻✽✶⠀-⣿·•*]+"), "").replace(Regex("\\s*\\|\\s*[^|]+$"), "").trim()
            if (clean.isNotEmpty() && !generic.matches(clean) && !clean.equals(name, true)) return "$name · ${clean.take(40)}"
        }
        val project = a.optString("foreground_cwd").ifEmpty { a.optString("cwd") }.trimEnd('/').substringAfterLast('/')
        return if (project.isEmpty()) name else "$name · $project"
    }

    private fun manager() = getSystemService(NotificationManager::class.java)

    /**
     * One notification per agent (a newer state replaces the older one), grouped under a summary.
     * Tap = open that chat on that computer. With several computers connected the computer's name
     * shows next to the app name.
     */
    private fun notify(w: Watch, agentKey: String, title: String, text: String, pane: String, kind: WatchRules.Alert, grouped: Boolean = true) {
        val manager = manager()
        val key = w.key(agentKey)
        // Alerts belong to the alerts part only; keeping the connection never makes a sound.
        if (w.session.isEmpty() || !manager.areNotificationsEnabled()) return
        val urgent = kind == WatchRules.Alert.BLOCKED || kind == WatchRules.Alert.ASK
        val b = Notification.Builder(this, if (urgent) CHANNEL_ALERT else CHANNEL_DONE)
            .setSmallIcon(R.drawable.ic_notification)
            .setColor(ACCENT)
            .setContentTitle(title)
            .setContentText(text)
            .setStyle(Notification.BigTextStyle().bigText(text))
            .setContentIntent(open(pane.ifEmpty { null }, w.id))
            .setAutoCancel(true)
            .setShowWhen(true)
            .apply { if (several) setSubText(w.name.ifEmpty { null }) }
            .setCategory(if (urgent) Notification.CATEGORY_REMINDER else Notification.CATEGORY_STATUS)
        if (grouped) b.setGroup(GROUP)
        val device = if (several) w.name else ""
        // The question itself stays off the lock screen: there it reads only "在问你" / "在等你确认".
        if (kind == WatchRules.Alert.ASK || kind == WatchRules.Alert.BLOCKED) {
            b.setVisibility(Notification.VISIBILITY_PRIVATE).setPublicVersion(Notification.Builder(this, CHANNEL_ALERT)
                .setSmallIcon(R.drawable.ic_notification).setColor(ACCENT).setContentTitle(title)
                .apply { if (device.isNotEmpty()) setSubText(device) }
                .setContentText(if (kind == WatchRules.Alert.ASK) "在问你" else "在等你确认").build())
        }
        manager.notify(key.hashCode(), b.build())
        if (!grouped) return
        posted.remove(key); posted[key] = Posted(if (device.isEmpty()) title else "$title（$device）", text, kind)
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
        val asking = posted.values.count { it.kind == WatchRules.Alert.ASK }
        val style = Notification.InboxStyle()
        posted.values.toList().takeLast(6).asReversed().forEach { style.addLine("${it.title}：${it.text}") }
        val head = WatchRules.counts(waiting - asking, asking, posted.size - waiting, "做完了")
        style.setSummaryText(devicesLine())
        manager.notify(SUMMARY_ID, Notification.Builder(this, if (waiting > 0) CHANNEL_ALERT else CHANNEL_DONE)
            .setSmallIcon(R.drawable.ic_notification)
            .setColor(ACCENT)
            .setContentTitle(head)
            .setContentText(posted.values.last().title)
            .setStyle(style)
            .setGroup(GROUP).setGroupSummary(true)
            .setGroupAlertBehavior(Notification.GROUP_ALERT_CHILDREN)
            .setContentIntent(open(null, null))
            .setAutoCancel(true)
            .build())
    }

    private fun open(pane: String?, device: String?): PendingIntent {
        val intent = Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        if (pane != null) { intent.putExtra(EXTRA_PANE, pane); if (device != null) intent.putExtra(EXTRA_DEVICE, device) }
        // Request codes differ per computer and pane, so one alert's intent never overwrites another's.
        val code = if (pane == null) 0 else "$device|$pane".hashCode()
        return PendingIntent.getActivity(this, code, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
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
        /** {device id: {session, states, kids, asks}}: one entry per computer to alert about. */
        const val EXTRA_WATCH = "watch"
        /** [Look.asks]: the transcript did not change since the last check, so neither did the question. */
        private val SAME = WatchRules.Ask("", "", 0)
        private val KIND_NAMES = mapOf("claude" to "Claude", "codex" to "Codex", "opencode" to "OpenCode", "gemini" to "Gemini",
            "cursor" to "Cursor", "devin" to "Devin", "agy" to "Antigravity", "cline" to "Cline", "copilot" to "Copilot",
            "kimi" to "Kimi", "kiro" to "Kiro", "droid" to "Droid", "amp" to "Amp", "grok" to "Grok", "hermes" to "Hermes",
            "kilo" to "Kilo", "qodercli" to "Qoder", "qwen" to "Qwen", "maki" to "Maki", "pi" to "Pi", "mastracode" to "Mastra Code")
        private val STOPPED = WatchRules.STOPPED
        private val BUSY = WatchRules.BUSY
        const val EXTRA_PANE = "pane"
        const val EXTRA_DEVICE = "device"
        private const val CHANNEL_BACKGROUND = "background"
        private const val CHANNEL_ALERT = "alert"
        private const val CHANNEL_DONE = "done"
        private const val ONGOING_ID = 1
        private const val SUMMARY_ID = 2
        private const val GROUP = "dev.herdr.pocket.AGENTS"
        private const val ACCENT = 0xFFF57B4A.toInt()
        private const val POLL_MS = WatchRules.POLL_MS
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
        /**
         * [watch]: per computer the Herdr session and what the app showed ({} = no alerts);
         * [keep] = hold every connection for [keepMinutes] (0 = until stopped).
         */
        fun start(context: Context, watch: String, keep: Boolean = false, keepMinutes: Int = 60) {
            val intent = Intent(context, WatchService::class.java).putExtra(EXTRA_WATCH, watch)
                .putExtra(EXTRA_KEEP, keep).putExtra(EXTRA_KEEP_MINUTES, keepMinutes)
            context.startForegroundService(intent)
        }
        fun stop(context: Context) { context.stopService(Intent(context, WatchService::class.java)) }
        /**
         * Back in the app: the "waiting for you" alerts (等你确认 / 在问你) are withdrawn, since the app
         * now shows who waits and an answer given there could not reach a stopped watcher. 做完了
         * stays until tapped or swiped. A question still open counts as known on the next background
         * run (seed), so it does not notify again.
         */
        fun clearWaiting(context: Context) {
            val manager = context.getSystemService(NotificationManager::class.java) ?: return
            try {
                val active = manager.activeNotifications
                val waiting = active.filter { it.notification.channelId == CHANNEL_ALERT && it.id != SUMMARY_ID }
                waiting.forEach { manager.cancel(it.id) }
                // Its "N 个等你确认" line is stale now; the 做完了 ones still show on their own.
                if (waiting.isNotEmpty()) manager.cancel(SUMMARY_ID)
            } catch (_: Exception) {}
        }
    }
}
