package uk.school.classroomhub

import android.app.usage.UsageEvents
import android.app.usage.UsageStatsManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager

/**
 * Works out which app is currently in front, using Android's UsageStatsManager.
 * It reads the "moved to foreground" events since the last check and keeps
 * the most recent one. Requires the "Usage access" permission.
 */
class ForegroundAppDetector(private val context: Context) {
    private val usm = context.getSystemService(Context.USAGE_STATS_SERVICE) as UsageStatsManager
    private val pm = context.packageManager
    private val labels = HashMap<String, String>()
    private var lastPackage: String? = null
    private var lastQuery = 0L

    val homePackages: Set<String> by lazy {
        val intent = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME)
        pm.queryIntentActivities(intent, 0).map { it.activityInfo.packageName }.toSet()
    }

    fun currentPackage(): String? {
        val now = System.currentTimeMillis()
        // First run: look back 10 minutes. Afterwards: since the last check
        // (with a little overlap so no event is missed).
        val from = if (lastQuery == 0L) now - 10 * 60 * 1000 else lastQuery - 2000
        val events = usm.queryEvents(from, now)
        val event = UsageEvents.Event()
        while (events.hasNextEvent()) {
            events.getNextEvent(event)
            @Suppress("DEPRECATION") // MOVE_TO_FOREGROUND == ACTIVITY_RESUMED (API 29+)
            if (event.eventType == UsageEvents.Event.MOVE_TO_FOREGROUND) {
                lastPackage = event.packageName
            }
        }
        lastQuery = now
        return lastPackage
    }

    fun labelFor(packageName: String): String = labels.getOrPut(packageName) {
        try {
            pm.getApplicationLabel(pm.getApplicationInfo(packageName, 0)).toString()
        } catch (e: PackageManager.NameNotFoundException) {
            packageName
        }
    }
}
