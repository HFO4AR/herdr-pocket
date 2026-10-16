package dev.herdr.pocket

/**
 * The background watcher's decisions, free of Android and I/O so they can be tested directly
 * (SecureProfilesTest.testWatchRules). WatchService does the polling and posting.
 *
 * States are Herdr's agent_status plus two the watcher derives:
 * - "kids": idle/done while sub-agents still run (the parent is not really finished);
 * - "ask": idle/done Codex whose request_user_input_async question is still unanswered. That
 *   call ends Codex's turn, so Herdr says idle, but the agent is waiting for the person.
 */
object WatchRules {
    val STOPPED = setOf("idle", "done")
    val BUSY = setOf("working", "kids")
    /** Polls after a stop without a question found, in case the transcript lagged behind Herdr. */
    const val ASK_RETRIES = 1
    const val POLL_MS = 20_000L
    const val IDLE_POLL_MS = 60_000L

    class Ask(val callId: String, val text: String, val count: Int)

    enum class Alert { NONE, BLOCKED, ASK, DONE }

    /** What a state change means: an alert to post (replacing this agent's last one) and whether a
     *  "waiting for you" alert from before is stale now. */
    class Step(val alert: Alert, val withdraw: Boolean)

    /** The tracked state. A pending question (not put aside in the app) wins over running sub-agents:
     *  the agent needs the person either way. [kidsChecked] = sub-agents were asked about this poll;
     *  an unknown answer (null) keeps an agent already held for them held. */
    fun effective(status: String, ask: Ask?, aside: Boolean, running: Int?, kidsChecked: Boolean, was: String?): String {
        if (status !in STOPPED) return status
        if (ask != null && !aside) return "ask"
        if ((running ?: 0) > 0 || (kidsChecked && running == null && was == "kids")) return "kids"
        return status
    }

    /** First sight and no change say nothing. A question notifies once per call id ([notified]
     *  holds those already posted or already shown in the app). */
    fun step(was: String?, now: String, askId: String?, notified: Set<String>): Step {
        if (was == null || was == now) return Step(Alert.NONE, false)
        val withdraw = was == "blocked" || was == "ask"
        val alert = when {
            now == "blocked" -> Alert.BLOCKED
            now == "ask" -> if (askId != null && askId !in notified) Alert.ASK else Alert.NONE
            was in BUSY && now in STOPPED -> Alert.DONE
            else -> Alert.NONE
        }
        return Step(alert, withdraw)
    }

    /** Ask about a Codex question only when it can have appeared: right after the agent stopped
     *  (or while it is held for sub-agents), plus [ASK_RETRIES] polls after that. Never periodically. */
    fun wantsAsk(status: String, was: String?, provider: String?, retriesLeft: Int): Boolean =
        provider == "codex" && status in STOPPED && (was in BUSY || retriesLeft > 0)

    /** Re-checks left after a check: a found question needs none; a stop starts [ASK_RETRIES]. */
    fun retriesAfter(justStopped: Boolean, left: Int, found: Boolean): Int =
        if (found) 0 else if (justStopped) ASK_RETRIES else (left - 1).coerceAtLeast(0)

    /** Quick while something works (a finish should be noticed soon) or a re-check is due; slow
     *  when every agent waits or rests, since only the person (or a running agent) changes that. */
    fun interval(states: Collection<String>, recheck: Boolean): Long =
        if (recheck || states.any { it in BUSY }) POLL_MS else IDLE_POLL_MS

    /** "在问你：<first line>" (and how many questions), short enough for a notification line. */
    fun askText(text: String, count: Int): String {
        val line = text.lineSequence().map { it.trim() }.firstOrNull { it.isNotEmpty() }.orEmpty()
        val more = if (count > 1) "（共 $count 个问题）" else ""
        if (line.isEmpty()) return "在问你，等你回答$more"
        return "在问你：" + (if (line.length > 80) line.take(79) + "…" else line) + more
    }

    /** Summary / ongoing counts, e.g. "1 个等你确认 · 1 个在问你 · 2 个做完了". */
    fun counts(blocked: Int, asking: Int, other: Int, otherLabel: String): String = listOfNotNull(
        if (blocked > 0) "$blocked 个等你确认" else null,
        if (asking > 0) "$asking 个在问你" else null,
        if (other > 0) "$other 个$otherLabel" else null,
    ).joinToString(" · ")
}
