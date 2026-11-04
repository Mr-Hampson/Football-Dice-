package uk.school.classroomhub

import android.app.Activity
import android.app.AlertDialog
import android.content.ActivityNotFoundException
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.text.InputType
import android.view.Gravity
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * The only screen in the app.
 *  - Not set up yet: asks for the hub address and the pupil's setup code.
 *  - Set up: shows connection status, what is shared, and a checklist of
 *    the permissions the app needs, with buttons to switch them on.
 *  - "Technical details" shows what the app can actually detect on this
 *    tablet. This is how we test feasibility on real Fire tablets.
 *
 * Built in code rather than XML layouts to keep the project small.
 */
class MainActivity : Activity() {

    private lateinit var prefs: Prefs
    private val handler = Handler(Looper.getMainLooper())
    private val refresh = object : Runnable {
        override fun run() {
            if (prefs.isPaired) renderStatus()
            handler.postDelayed(this, 2000)
        }
    }

    private lateinit var root: LinearLayout
    private var showDetails = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        prefs = Prefs(this)
        root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(20), dp(16), dp(20), dp(24))
        }
        setContentView(ScrollView(this).apply { addView(root) })
    }

    override fun onResume() {
        super.onResume()
        if (prefs.isPaired) HubService.start(this)
        render()
        handler.post(refresh)
    }

    override fun onPause() {
        handler.removeCallbacks(refresh)
        super.onPause()
    }

    private fun render() {
        if (prefs.isPaired) renderStatus() else renderSetup()
    }

    // ---- Setup ----------------------------------------------------------------

    private fun renderSetup() {
        root.removeAllViews()
        root.addView(heading("Set up Classroom Hub"))
        root.addView(body("Your teacher will give you the hub address and a 6-letter setup code."))

        val server = EditText(this).apply {
            hint = "Hub address, e.g. https://hub.example.org"
            inputType = InputType.TYPE_TEXT_VARIATION_URI
            setText(prefs.serverUrl ?: "https://")
        }
        val code = EditText(this).apply {
            hint = "Setup code"
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_CHARACTERS
        }
        val error = body("").apply { setTextColor(Color.rgb(180, 35, 24)) }
        val button = Button(this).apply { text = "Connect" }
        button.setOnClickListener {
            val url = server.text.toString().trim().trimEnd('/')
            if (!url.startsWith("https://") && !url.startsWith("http://")) {
                error.text = "The hub address should start with https://"
                return@setOnClickListener
            }
            button.isEnabled = false
            error.text = "Connecting…"
            pair(url, code.text.toString()) { problem ->
                button.isEnabled = true
                if (problem == null) render() else error.text = problem
            }
        }
        root.addView(label("Hub address"))
        root.addView(server)
        root.addView(label("Setup code"))
        root.addView(code)
        root.addView(button)
        root.addView(error)
    }

    /** Exchanges the setup code for this tablet's own secret token. */
    private fun pair(url: String, code: String, done: (String?) -> Unit) {
        Thread {
            val problem = try {
                val client = OkHttpClient.Builder().callTimeout(20, TimeUnit.SECONDS).build()
                val body = JSONObject().put("code", code).toString()
                    .toRequestBody("application/json".toMediaType())
                client.newCall(Request.Builder().url("$url/api/device/pair").post(body).build()).execute().use { res ->
                    val json = JSONObject(res.body?.string().orEmpty().ifEmpty { "{}" })
                    if (res.isSuccessful) {
                        prefs.serverUrl = url
                        prefs.token = json.getString("token")
                        prefs.pupilName = json.optString("pupilName")
                        null
                    } else {
                        json.optString("error", "Setup failed (${res.code})")
                    }
                }
            } catch (e: Exception) {
                "Couldn't reach the hub. Check the address and Wi-Fi. (${e.javaClass.simpleName})"
            }
            runOnUiThread {
                if (problem == null) HubService.start(this)
                done(problem)
            }
        }.start()
    }

    // ---- Status ---------------------------------------------------------------

    private fun renderStatus() {
        root.removeAllViews()
        val name = prefs.pupilName ?: "pupil"
        root.addView(heading("Hi $name"))

        val lesson = HubService.lesson
        root.addView(card(
            if (HubService.connected) "● Connected to your class" else "○ ${HubService.connectionText}",
            if (HubService.connected) GREEN else GREY,
        ))
        root.addView(body(
            if (lesson?.active == true) {
                "Lesson in progress: ${lesson.className}.\nYour teacher can see which app you are using " +
                    "and the name of the website you are on (for example bbc.co.uk). " +
                    "They cannot see the pages you read, your screen, or anything you type."
            } else {
                "No lesson right now. Nothing about what you are doing is shared."
            }
        ))

        root.addView(label("Setup checklist"))
        val usage = Permissions.hasUsageAccess(this)
        root.addView(checkRow(
            usage, "App tracking (Usage access)",
            "Lets the hub see which app is open.", "Open settings",
        ) { openUsageSettings() })
        val website = Permissions.isWebsiteCheckOn(this)
        root.addView(checkRow(
            website, "Website check",
            "Settings › Accessibility › Classroom Hub website check.", "Open settings",
        ) { openSettings(Settings.ACTION_ACCESSIBILITY_SETTINGS) })

        val details = TextView(this).apply {
            text = if (showDetails) "▼ Technical details" else "▶ Technical details"
            setPadding(0, dp(20), 0, dp(6))
            setTextColor(Color.rgb(36, 89, 201))
            setOnClickListener { showDetails = !showDetails; renderStatus() }
            // Long-press: reset, for whoever manages the tablets.
            setOnLongClickListener { confirmReset(); true }
        }
        root.addView(details)
        if (showDetails) root.addView(mono(diagnostics()))
    }

    private fun diagnostics(): String {
        val site = WebsiteState.latest
        val c = HubService.lastClassification
        val age = site?.let { "${(System.currentTimeMillis() - it.at) / 1000}s ago" } ?: "-"
        return buildString {
            appendLine("Device: ${Build.MANUFACTURER} ${Build.MODEL}")
            appendLine("Android API ${Build.VERSION.SDK_INT} (${Build.VERSION.RELEASE}), build ${Build.DISPLAY}")
            appendLine("App version: ${BuildConfig.VERSION_NAME}")
            appendLine("Hub: ${prefs.serverUrl}")
            appendLine()
            appendLine("Foreground app: ${HubService.lastForeground ?: "-"}")
            appendLine("Status sent: ${c?.state ?: "-"} ${c?.detail ?: ""}")
            appendLine()
            appendLine("Website check (only during a lesson):")
            appendLine("  browser: ${site?.browserPackage ?: "-"}")
            appendLine("  domain: ${site?.domain ?: "-"} ($age)")
            appendLine("  read from: ${site?.source ?: "-"}")
            appendLine("  address-bar candidates:")
            if (WebsiteState.candidateIds.isEmpty()) appendLine("    (none yet)")
            WebsiteState.candidateIds.forEach { appendLine("    $it") }
        }
    }

    private fun confirmReset() {
        AlertDialog.Builder(this)
            .setTitle("Reset this tablet?")
            .setMessage("It will disconnect and need a new setup code.")
            .setPositiveButton("Reset") { _, _ ->
                stopService(Intent(this, HubService::class.java))
                prefs.forget()
                HubService.lesson = null
                render()
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    private fun openUsageSettings() {
        // Fire OS may hide this screen. If so, it can be granted over USB:
        //   adb shell appops set uk.school.classroomhub GET_USAGE_STATS allow
        if (!openSettings(Settings.ACTION_USAGE_ACCESS_SETTINGS)) {
            AlertDialog.Builder(this)
                .setTitle("Usage access screen not available")
                .setMessage(
                    "This tablet hides the Usage access setting. Whoever manages the tablets can switch it on " +
                        "with a USB cable:\n\nadb shell appops set $packageName GET_USAGE_STATS allow"
                )
                .setPositiveButton("OK", null)
                .show()
        }
    }

    private fun openSettings(action: String): Boolean = try {
        startActivity(Intent(action))
        true
    } catch (e: ActivityNotFoundException) {
        false
    } catch (e: SecurityException) {
        false
    }

    // ---- Tiny view helpers ----------------------------------------------------

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()

    private fun heading(text: String) = TextView(this).apply {
        this.text = text
        textSize = 24f
        setTypeface(typeface, Typeface.BOLD)
        setPadding(0, 0, 0, dp(10))
    }

    private fun label(text: String) = TextView(this).apply {
        this.text = text
        textSize = 15f
        setTypeface(typeface, Typeface.BOLD)
        setPadding(0, dp(16), 0, dp(4))
    }

    private fun body(text: String) = TextView(this).apply {
        this.text = text
        textSize = 16f
        setPadding(0, dp(4), 0, dp(4))
    }

    private fun mono(text: String) = TextView(this).apply {
        this.text = text
        textSize = 12f
        typeface = Typeface.MONOSPACE
        setTextIsSelectable(true)
    }

    private fun card(text: String, colour: Int) = TextView(this).apply {
        this.text = text
        textSize = 18f
        setTextColor(colour)
        setTypeface(typeface, Typeface.BOLD)
        setPadding(0, dp(6), 0, dp(6))
    }

    private fun checkRow(ok: Boolean, title: String, hint: String, action: String, onClick: () -> Unit): View {
        val row = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(0, dp(6), 0, dp(6))
        }
        val text = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        text.addView(TextView(this).apply {
            this.text = (if (ok) "✓ " else "✗ ") + title
            textSize = 16f
            setTextColor(if (ok) GREEN else RED)
            setTypeface(typeface, Typeface.BOLD)
        })
        if (!ok) text.addView(TextView(this).apply { this.text = hint; textSize = 13f })
        row.addView(text, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
        if (!ok) row.addView(Button(this).apply { this.text = action; setOnClickListener { onClick() } })
        return row
    }

    companion object {
        private val GREEN = Color.rgb(31, 138, 76)
        private val RED = Color.rgb(180, 35, 24)
        private val GREY = Color.rgb(93, 102, 118)
    }
}
