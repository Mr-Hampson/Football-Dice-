package uk.school.classroomhub

import android.content.Context

/** Small wrapper around the app's saved settings. */
class Prefs(context: Context) {
    private val sp = context.getSharedPreferences("hub", Context.MODE_PRIVATE)

    var serverUrl: String?
        get() = sp.getString("serverUrl", null)
        set(value) = sp.edit().putString("serverUrl", value).apply()

    var token: String?
        get() = sp.getString("token", null)
        set(value) = sp.edit().putString("token", value).apply()

    var pupilName: String?
        get() = sp.getString("pupilName", null)
        set(value) = sp.edit().putString("pupilName", value).apply()

    val isPaired: Boolean
        get() = !serverUrl.isNullOrBlank() && !token.isNullOrBlank()

    fun forget() {
        sp.edit().remove("token").remove("pupilName").apply()
    }
}
