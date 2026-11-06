package uk.school.classroomhub

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

/**
 * Settings the hub sends when the tablet connects (server/config/device-config.json).
 * Kept on the tablet so they still apply when it's offline.
 *
 * Today this tells the website check where Silk's address bar is, so a Silk
 * update can be fixed on the hub instead of with a new app.
 */
object RemoteConfig {
    @Volatile var urlBarIds: List<String> = emptyList()
        private set
    @Volatile var urlHints: List<String> = emptyList()
        private set

    private const val PREF = "remoteConfig"

    fun load(context: Context) {
        val raw = context.getSharedPreferences("hub", Context.MODE_PRIVATE).getString(PREF, null) ?: return
        try {
            apply(JSONObject(raw))
        } catch (_: Exception) {
        }
    }

    /** Called with the hub's "config" message. */
    fun update(context: Context, json: JSONObject) {
        apply(json)
        context.getSharedPreferences("hub", Context.MODE_PRIVATE).edit().putString(PREF, json.toString()).apply()
    }

    private fun apply(json: JSONObject) {
        urlBarIds = json.optJSONArray("urlBarIds").strings()
        urlHints = json.optJSONArray("urlHints").strings()
    }

    private fun JSONArray?.strings(): List<String> {
        if (this == null) return emptyList()
        return (0 until length()).mapNotNull { optString(it).takeIf { s -> s.isNotBlank() && s.length < 200 } }.take(30)
    }
}
