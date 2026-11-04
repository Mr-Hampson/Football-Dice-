package uk.school.classroomhub

import android.content.Context

/**
 * The app's saved settings. Only the tablet's own identity is saved:
 * pupil names are never stored on the tablet.
 */
class Prefs(context: Context) {
    private val sp = context.getSharedPreferences("hub", Context.MODE_PRIVATE)

    var serverUrl: String?
        get() = sp.getString("serverUrl", null)
        set(value) = sp.edit().putString("serverUrl", value).apply()

    var token: String?
        get() = sp.getString("token", null)
        set(value) = sp.edit().putString("token", value).apply()

    /** The number on the tablet's sticker, e.g. "7". */
    var tabletNumber: String?
        get() = sp.getString("tabletNumber", null)
        set(value) = sp.edit().putString("tabletNumber", value).apply()

    val isSetUp: Boolean
        get() = !serverUrl.isNullOrBlank() && !token.isNullOrBlank()

    fun forget() {
        sp.edit().remove("token").apply()
    }
}
