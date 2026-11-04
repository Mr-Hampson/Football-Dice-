package uk.school.classroomhub

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import android.os.Build

class App : Application() {
    override fun onCreate() {
        super.onCreate()
        if (Build.VERSION.SDK_INT >= 26) {
            val nm = getSystemService(NotificationManager::class.java)
            nm.createNotificationChannel(
                NotificationChannel(CHANNEL_STATUS, "Connection status", NotificationManager.IMPORTANCE_LOW)
            )
            nm.createNotificationChannel(
                NotificationChannel(CHANNEL_LINKS, "Links from your teacher", NotificationManager.IMPORTANCE_HIGH)
            )
        }
        if (Prefs(this).isSetUp) HubService.start(this)
    }

    companion object {
        const val CHANNEL_STATUS = "status"
        const val CHANNEL_LINKS = "links"
    }
}
