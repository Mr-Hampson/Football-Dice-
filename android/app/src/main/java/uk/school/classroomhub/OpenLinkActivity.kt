package uk.school.classroomhub

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.os.Bundle

/**
 * Opened when the pupil taps a "your teacher sent a link" notification.
 * Tells the hub the link was opened, then opens it in Silk (or any browser).
 *
 * Note: Android does not let apps open things on screen by themselves from
 * the background, which is why the pupil has to tap the notification.
 */
class OpenLinkActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val id = intent.getStringExtra(EXTRA_LINK_ID)
        val url = intent.getStringExtra(EXTRA_URL)
        if (id != null) HubService.reportLinkOpened(this, id)
        if (url != null && (url.startsWith("https://") || url.startsWith("http://"))) {
            val view = Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            try {
                startActivity(Intent(view).setPackage(Classifier.SILK))
            } catch (e: ActivityNotFoundException) {
                try {
                    startActivity(view)
                } catch (_: ActivityNotFoundException) {
                }
            }
        }
        finish()
    }

    companion object {
        const val EXTRA_LINK_ID = "linkId"
        const val EXTRA_URL = "url"
    }
}
