package dev.herdr.pocket

import android.content.SharedPreferences
import org.json.JSONArray
import org.json.JSONObject

/**
 * 启动时自动重连: which computers were connected when the app went away, and which one was on
 * screen. Only device ids are kept (app-private preferences, no addresses, names or secrets).
 *
 * A successful connect adds a computer; an explicit 断开 / 全部断开 (in the app or on the
 * notification) and deleting a device remove it. Process death, swiping the app away, the OS
 * ending the keep-alive or an app update leave the list as it was, so the next launch reconnects.
 */
class ResumeSet(private val prefs: SharedPreferences) {
    @Synchronized fun ids(): List<String> {
        val raw = prefs.getString(IDS, null) ?: return emptyList()
        return try { JSONArray(raw).let { a -> (0 until a.length()).map { a.getString(it) }.filter(::valid) } } catch (_: Exception) { emptyList() }
    }
    /** The computer on screen when the app went away (empty when none). */
    @Synchronized fun active(): String = prefs.getString(ACTIVE, "")?.takeIf { it in ids() }.orEmpty()
    @Synchronized fun contains(id: String) = id in ids()

    /** Connected: kept in connection order; [shown] = it is now the one on screen. */
    @Synchronized fun add(id: String, shown: Boolean) {
        if (!valid(id)) return
        val list = ids().filter { it != id }.plus(id).takeLast(MAX)
        write(list, if (shown) id else prefs.getString(ACTIVE, "").orEmpty())
    }
    /** The screen switched to a computer that is already connected. */
    @Synchronized fun activate(id: String?) { if (id != null && id in ids()) write(ids(), id) }
    /** Explicit 断开 or deleted: not reconnected next time. [next] = the one on screen now, if any. */
    @Synchronized fun remove(id: String, next: String? = null) {
        val list = ids().filter { it != id }
        val active = prefs.getString(ACTIVE, "").orEmpty()
        write(list, if (active == id || active !in list) next?.takeIf { it in list }.orEmpty() else active)
    }
    /** 全部断开. */
    @Synchronized fun clear() { check(prefs.edit().remove(IDS).remove(ACTIVE).commit()) { "保存失败" } }

    private fun write(list: List<String>, active: String) {
        prefs.edit().putString(IDS, JSONArray(list).toString()).putString(ACTIVE, active.takeIf { it in list }.orEmpty()).apply()
    }

    companion object {
        const val FILE = "resume"
        private const val IDS = "ids"
        private const val ACTIVE = "active"
        // More than PocketCore.MAX_LINKS on purpose: a stale id is filtered against the vault anyway.
        private const val MAX = 8
        private fun valid(id: String) = id.length in 1..80

        /**
         * What a quiet reconnect at launch would still need from the user, from the stored device
         * (with its secrets, never sent to the page) and the pinned keys:
         * "" = nothing (saved password or key login, every jump host too, every host key pinned),
         * "password" = a password has to be typed, "trust" = a host key was never confirmed.
         */
        fun need(stored: JSONObject, pin: (String) -> String?): String {
            if (JumpHosts.pinIds(stored).any { pin(it).isNullOrEmpty() }) return "trust"
            val typed = { item: JSONObject -> item.optString("auth") != "key" && item.optString("password").isEmpty() }
            if (typed(stored) || JumpHosts.jumps(stored).any(typed)) return "password"
            return ""
        }
    }
}

/** The page's view of the list: enabled, online, the active id and each id with what it needs. */
fun ResumeSet.info(enabled: Boolean, online: Boolean, stored: (String) -> JSONObject?, pin: (String) -> String?): JSONObject {
    val list = JSONArray()
    for (id in ids()) { val d = stored(id) ?: continue; list.put(JSONObject().put("id", id).put("need", ResumeSet.need(d, pin))) }
    return JSONObject().put("enabled", enabled).put("online", online).put("active", active()).put("ids", list)
}
