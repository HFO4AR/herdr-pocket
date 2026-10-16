package dev.herdr.pocket

import org.json.JSONArray
import org.json.JSONObject

/**
 * One jump host (跳板机) on the way to a device: the phone logs in to it, then reaches the next one
 * through it. [password] is empty for a key hop; [pinnedKey] is this hop's own pinned host key.
 */
class Hop(val endpoint: Endpoint, val password: String, val useKey: Boolean, val pinnedKey: String?)

/**
 * Logging in to hop [index] of [total] failed (index 0 is the first jump host; total - 1 is the
 * device itself). [forward]: the previous hop [via] could not open a connection to this one.
 */
class HopFailed(val index: Int, val total: Int, val endpoint: Endpoint, val usingKey: Boolean, val forward: Boolean, val via: Endpoint?, cause: Exception) :
    Exception(cause.message, cause) {
    val isJump get() = index < total - 1
}

/**
 * Device schema for multi-hop SSH. A device may carry `jumps`: up to [MAX] jump hosts in the order
 * they are passed, each `{host, port, user, auth: "password"|"key", password}`; the device's own
 * host/port/user is the last hop, where the bridge runs. Devices without `jumps` are unchanged.
 * Hop passwords live in the same encrypted vault as device passwords and never leave it through
 * the device list ([redact]).
 */
object JumpHosts {
    const val MAX = 3

    fun jumps(device: JSONObject): List<JSONObject> {
        val list = device.optJSONArray("jumps") ?: return emptyList()
        return (0 until list.length()).mapNotNull { list.optJSONObject(it) }
    }
    private fun endpoint(hop: JSONObject) = Endpoint(hop.getString("host"), hop.optInt("port", 22), hop.getString("user"))
    /** Jump hosts in order, then the device: every SSH login of a connection. */
    fun route(device: JSONObject): List<Endpoint> =
        jumps(device).map(::endpoint) + Endpoint(device.getString("host"), device.getInt("port"), device.getString("user"))

    /**
     * Pin keys for each login of [route]. The first login is reached straight from the phone and
     * keeps the plain `pin:host:port` key (a device without jump hosts is unchanged). A later login
     * is named by the whole path: "10.0.0.5:22" behind one jump host can be a different machine
     * than the same address behind another, so it never shares a pin with it.
     */
    fun pinIds(route: List<Endpoint>): List<String> = route.indices.map { i ->
        "pin:" + route.subList(0, i + 1).joinToString(">") { "${it.host}:${it.port}" }
    }
    fun pinIds(device: JSONObject) = pinIds(route(device))

    /** The jump hops of a stored device (with its stored passwords) and their pinned keys. */
    fun hops(device: JSONObject, pin: (String) -> String?): List<Hop> {
        val list = jumps(device); val ids = pinIds(device)
        return list.mapIndexed { i, hop ->
            val key = hop.optString("auth") == "key"
            Hop(endpoint(hop), if (key) "" else hop.optString("password"), key, pin(ids[i]))
        }
    }
    fun needsKey(device: JSONObject) = device.optString("auth") == "key" || jumps(device).any { it.optString("auth") == "key" }

    /** "a:22>b:2222", the path in front of the device; part of what a saved device password is tied to. */
    fun path(device: JSONObject): String = jumps(device).joinToString(">") { "${it.optString("host")}:${it.optInt("port", 22)}" }

    /**
     * Validates the jump hosts sent by the form and carries saved passwords over. A hop keeps its
     * saved password only while its address, user and everything in front of it stay the same
     * (like a device: changing where a password goes never reuses it). A password hop needs one.
     */
    fun normalize(incoming: JSONArray?, old: JSONArray?): JSONArray {
        val out = JSONArray()
        if (incoming == null || incoming.length() == 0) return out
        require(incoming.length() <= MAX) { "跳板机最多 $MAX 台" }
        val saved = HashMap<String, String>()
        var oldPath = ""
        for (i in 0 until (old?.length() ?: 0)) {
            val hop = old!!.optJSONObject(i) ?: continue
            oldPath += ">" + hop.optString("host") + ":" + hop.optInt("port", 22)
            if (hop.optString("auth") != "key") saved[oldPath + "|" + hop.optString("user")] = hop.optString("password")
        }
        var path = ""
        for (i in 0 until incoming.length()) {
            val hop = incoming.optJSONObject(i) ?: throw IllegalArgumentException("第 ${i + 1} 台跳板机的资料不对")
            val host = hop.optString("host").trim(); val user = hop.optString("user").trim(); val port = hop.optInt("port", 22)
            require(host.isNotBlank() && user.isNotBlank() && port in 1..65535 && host.length <= 253 && user.length <= 128 &&
                host.none { it.isWhitespace() || it == '/' || it == '@' } && user.none { it.isWhitespace() || it == '@' }) { "第 ${i + 1} 台跳板机：填好地址、用户名和有效端口" }
            val auth = hop.optString("auth").ifBlank { "password" }
            require(auth == "password" || auth == "key") { "不支持的登录方式" }
            path += ">$host:$port"
            val pass = if (auth == "key") "" else hop.optString("password").ifEmpty { saved[path + "|" + user].orEmpty() }
            require(pass.length <= 4096) { "密码过长" }
            require(auth == "key" || pass.isNotEmpty()) { "第 ${i + 1} 台跳板机还没填密码" }
            out.put(JSONObject().put("host", host).put("port", port).put("user", user).put("auth", auth).put("password", pass))
        }
        return out
    }

    /** What the page may see of a device: no passwords, only whether one is saved. */
    fun redact(device: JSONObject): JSONObject = JSONObject(device.toString()).apply {
        put("remember", optString("password").isNotEmpty()); remove("password")
        put("auth", optString("auth").ifBlank { "password" })
        val list = optJSONArray("jumps")
        if (list == null || list.length() == 0) remove("jumps")
        else put("jumps", JSONArray().apply {
            for (i in 0 until list.length()) put(JSONObject(list.getJSONObject(i).toString()).apply {
                put("remember", optString("password").isNotEmpty()); remove("password")
                put("auth", optString("auth").ifBlank { "password" })
            })
        })
    }

    /** Facts about hop [index] of [device]'s route for the trust/changed-key sheets. */
    fun describe(info: JSONObject, device: JSONObject, index: Int): JSONObject {
        val route = route(device)
        if (route.size == 1) return info
        info.put("hop", index + 1).put("hops", route.size).put("jump", index < route.size - 1)
        if (index > 0) info.put("via", route[index - 1].host)
        return info
    }
}
