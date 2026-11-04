package uk.school.classroomhub

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** Restarts the hub connection after the tablet reboots or the app updates. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (Prefs(context).isPaired) HubService.start(context)
    }
}
