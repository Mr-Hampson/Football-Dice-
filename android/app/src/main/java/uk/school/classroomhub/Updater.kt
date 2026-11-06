package uk.school.classroomhub

import android.app.Activity
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.net.Uri
import android.os.Build
import android.provider.Settings
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.io.File
import java.util.concurrent.TimeUnit

/**
 * Keeps the app up to date without hunting for download links.
 *  - Asks the hub which version is newest (`/api/app-version`).
 *  - When the pupil or a teacher taps Install, downloads the new version and
 *    hands it to Android, which asks once to confirm. Settings are kept
 *    because every build is signed with the same school key.
 *
 * Android 11 does not allow apps to update themselves silently, so one tap
 * on each tablet is always needed.
 */
object Updater {
    /** Newest version the hub knows about, or 0 if not checked yet. */
    @Volatile var latestVersion = 0
    @Volatile var status: String? = null
    @Volatile var busy = false

    val updateAvailable: Boolean get() = latestVersion > BuildConfig.VERSION_CODE

    private val client = OkHttpClient.Builder().callTimeout(120, TimeUnit.SECONDS).build()

    /** Asks the hub for the newest version. Runs on a background thread. */
    fun check(hubUrl: String, done: () -> Unit) {
        Thread {
            try {
                client.newCall(Request.Builder().url("${hubUrl.trimEnd('/')}/api/app-version").build()).execute().use { res ->
                    if (res.isSuccessful) latestVersion = JSONObject(res.body?.string().orEmpty()).optInt("versionCode")
                }
            } catch (_: Exception) {
            }
            done()
        }.start()
    }

    /** Downloads and installs the newest version. Call from a visible screen. */
    fun install(activity: Activity, hubUrl: String) {
        if (busy) return
        if (Build.VERSION.SDK_INT >= 26 && !activity.packageManager.canRequestPackageInstalls()) {
            status = "First allow Classroom Hub to install updates, then press Install again."
            activity.startActivity(
                Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${activity.packageName}"))
            )
            return
        }
        busy = true
        status = "Downloading the update…"
        val context = activity.applicationContext
        Thread {
            try {
                val file = File(context.cacheDir, "update.apk")
                client.newCall(Request.Builder().url("${hubUrl.trimEnd('/')}/app").build()).execute().use { res ->
                    if (!res.isSuccessful) throw IllegalStateException("download failed (${res.code})")
                    file.outputStream().use { out -> res.body!!.byteStream().copyTo(out) }
                }
                status = "Installing…"
                val installer = context.packageManager.packageInstaller
                val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL)
                params.setAppPackageName(context.packageName)
                val sessionId = installer.createSession(params)
                installer.openSession(sessionId).use { session ->
                    session.openWrite("classroom-hub", 0, file.length()).use { out ->
                        file.inputStream().use { it.copyTo(out) }
                        session.fsync(out)
                    }
                    // Must stay mutable: Android adds the result to it. (Mutable is the
                    // default for apps targeting Android 11, like this one.)
                    val flags = PendingIntent.FLAG_UPDATE_CURRENT
                    val result = PendingIntent.getBroadcast(context, sessionId, Intent(context, InstallResultReceiver::class.java), flags)
                    session.commit(result.intentSender)
                }
            } catch (e: Exception) {
                status = "Update didn't work: ${e.message ?: e.javaClass.simpleName}. Try again, or install from the link."
                busy = false
            }
        }.start()
    }
}

/** Android reports back here: ask the user to confirm, or show the result. */
class InstallResultReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        when (intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)) {
            PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                @Suppress("DEPRECATION")
                val confirm = intent.getParcelableExtra<Intent>(Intent.EXTRA_INTENT) ?: return
                context.startActivity(confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                Updater.status = "Tap Install to finish updating."
            }
            PackageInstaller.STATUS_SUCCESS -> {
                Updater.status = "Updated."
                Updater.busy = false
            }
            else -> {
                Updater.status = "Update didn't install: ${intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE) ?: "unknown reason"}"
                Updater.busy = false
            }
        }
    }
}
