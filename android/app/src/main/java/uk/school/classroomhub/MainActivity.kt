package uk.school.classroomhub

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
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
import android.view.inputmethod.EditorInfo
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
 * The only screen in the app. It has four modes:
 *  - SETUP:  done once per tablet. Hub address, setup code, tablet number.
 *  - JOIN:   no lesson. The pupil types the join code and their name.
 *  - RENAME: the teacher asked the pupil to type their name again.
 *  - LESSON: shows what is shared, plus the permission checklist.
 * "Technical details" (all modes after setup) shows what the app can
 * actually detect on this tablet, for the feasibility test.
 *
 * The screen is only rebuilt when the mode changes, so a refresh never wipes
 * what a pupil is typing. Status text is updated in place every second.
 */
class MainActivity : Activity() {

    private enum class Mode { SETUP, JOIN, RENAME, LESSON }

    private lateinit var prefs: Prefs
    private val handler = Handler(Looper.getMainLooper())
    private val refresh = object : Runnable {
        override fun run() {
            render()
            handler.postDelayed(this, 1000)
        }
    }

    private lateinit var root: LinearLayout
    private var mode: Mode? = null
    private var showDetails = false

    // Views updated in place on every refresh.
    private var connectionView: TextView? = null
    private var infoView: TextView? = null
    private var errorView: TextView? = null
    private var checklist: LinearLayout? = null
    private var detailsView: TextView? = null
    private var updateBox: LinearLayout? = null
    private var lastUpdateKey = ""
    private var lastChecklistKey = ""

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        prefs = Prefs(this)
        root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(20), dp(16), dp(20), dp(24))
        }
        setContentView(ScrollView(this).apply { addView(root) })
        handleMessageTap(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleMessageTap(intent)
    }

    /** Opened from a "message from your teacher" notification: mark it seen. */
    private fun handleMessageTap(intent: Intent?) {
        val id = intent?.getStringExtra(HubService.EXTRA_MESSAGE_ID) ?: return
        intent.removeExtra(HubService.EXTRA_MESSAGE_ID)
        HubService.messageSeen(this, id)
    }

    override fun onResume() {
        super.onResume()
        if (prefs.isSetUp) HubService.start(this)
        mode = null // rebuild once on return, e.g. after changing a setting
        handler.post(refresh)
    }

    override fun onPause() {
        handler.removeCallbacks(refresh)
        super.onPause()
    }

    private fun currentMode(): Mode {
        val lesson = HubService.lesson
        return when {
            !prefs.isSetUp -> Mode.SETUP
            lesson?.active != true -> Mode.JOIN
            lesson.nameRequested -> Mode.RENAME
            else -> Mode.LESSON
        }
    }

    private fun render() {
        val next = currentMode()
        if (next != mode) {
            mode = next
            root.removeAllViews()
            connectionView = null; infoView = null; errorView = null; checklist = null; detailsView = null; updateBox = null
            lastChecklistKey = ""
            lastUpdateKey = ""
            when (next) {
                Mode.SETUP -> buildSetup()
                Mode.JOIN -> buildJoin()
                Mode.RENAME -> buildRename()
                Mode.LESSON -> buildLesson()
            }
            if (next != Mode.SETUP) buildFooter()
        }
        updateDynamic()
    }

    // ---- SETUP (once per tablet) -------------------------------------------------

    private fun buildSetup() {
        root.addView(heading("Set up this tablet"))
        root.addView(body("This is done once, by whoever manages the tablets. You need the hub address, " +
            "a setup code from the hub's Tablets page, and the number on this tablet's sticker."))

        val server = input("Hub address, e.g. https://hub.example.org", InputType.TYPE_TEXT_VARIATION_URI)
            .apply { setText(prefs.serverUrl ?: "https://") }
        val code = input("Setup code", InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_CHARACTERS)
        val number = input("Tablet number, e.g. 7", InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_CHARACTERS)
            .apply { setText(prefs.tabletNumber.orEmpty()) }
        val error = errorText()
        val button = Button(this).apply { text = "Set up" }
        button.setOnClickListener {
            val url = server.text.toString().trim().trimEnd('/')
            if (!url.startsWith("https://") && !url.startsWith("http://")) {
                error.text = "The hub address should start with https://"
                return@setOnClickListener
            }
            button.isEnabled = false
            error.text = "Connecting…"
            enrol(url, code.text.toString(), number.text.toString()) { problem ->
                button.isEnabled = true
                if (problem == null) render() else error.text = problem
            }
        }
        root.addView(label("Hub address")); root.addView(server)
        root.addView(label("Setup code")); root.addView(code)
        root.addView(label("Tablet number")); root.addView(number)
        root.addView(button)
        root.addView(error)
    }

    /** Registers this tablet with the hub and stores its secret token. */
    private fun enrol(url: String, code: String, number: String, done: (String?) -> Unit) {
        Thread {
            val problem = try {
                val client = OkHttpClient.Builder().callTimeout(20, TimeUnit.SECONDS).build()
                val body = JSONObject().put("code", code).put("number", number).toString()
                    .toRequestBody("application/json".toMediaType())
                client.newCall(Request.Builder().url("$url/api/device/enrol").post(body).build()).execute().use { res ->
                    val json = JSONObject(res.body?.string().orEmpty().ifEmpty { "{}" })
                    if (res.isSuccessful) {
                        prefs.serverUrl = url
                        prefs.token = json.getString("token")
                        prefs.tabletNumber = json.optString("number")
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

    // ---- JOIN (start of every lesson) ----------------------------------------------

    private fun buildJoin() {
        root.addView(heading("Join your lesson"))
        root.addView(subtle("Tablet ${prefs.tabletNumber ?: "?"}"))
        connectionView = statusLine().also { root.addView(it) }

        val code = input("Join code from the board", InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_CHARACTERS)
            .apply { textSize = 24f }
        val name = nameInput()
        val button = Button(this).apply { text = "Join" }
        button.setOnClickListener {
            val nameText = name.text.toString()
            val problem = Names.problemWith(nameText)
            if (problem != null) {
                errorView?.text = problem
            } else {
                errorView?.text = "Joining…"
                HubService.joinError = null
                HubService.join(this, code.text.toString(), nameText)
            }
        }
        name.setOnEditorActionListener { _, actionId, _ ->
            if (actionId == EditorInfo.IME_ACTION_DONE) { button.performClick(); true } else false
        }
        root.addView(label("Join code")); root.addView(code)
        root.addView(label("Your name")); root.addView(name)
        root.addView(subtle(Names.HINT))
        root.addView(button)
        errorView = errorText().also { root.addView(it) }
        root.addView(body("Nothing about what you do on this tablet is shared until you join a lesson."))
    }

    // ---- RENAME (teacher asked) -----------------------------------------------------

    private fun buildRename() {
        root.addView(heading("Please retype your name"))
        root.addView(body("Your teacher asked you to enter your name again."))
        val name = nameInput()
        val button = Button(this).apply { text = "Save name" }
        button.setOnClickListener {
            val problem = Names.problemWith(name.text.toString())
            if (problem != null) {
                errorView?.text = problem
            } else {
                errorView?.text = "Saving…"
                HubService.joinError = null
                HubService.rename(this, name.text.toString())
            }
        }
        root.addView(label("Your name")); root.addView(name)
        root.addView(subtle(Names.HINT))
        root.addView(button)
        errorView = errorText().also { root.addView(it) }
    }

    // ---- LESSON ---------------------------------------------------------------------

    private fun buildLesson() {
        val lesson = HubService.lesson ?: return
        root.addView(heading("Hi ${lesson.name}"))
        root.addView(subtle("Tablet ${prefs.tabletNumber ?: "?"} · ${lesson.title}"))
        connectionView = statusLine().also { root.addView(it) }
        infoView = body("Your teacher can see which app you are using and the name of the website you are on " +
            "(for example bbc.co.uk). They cannot see the pages you read, your screen, or anything you type. " +
            "This stops when the lesson ends.").also { root.addView(it) }
    }

    // ---- Footer: checklist + technical details --------------------------------------

    private fun buildFooter() {
        updateBox = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }.also { root.addView(it) }
        root.addView(label("Tablet setup checklist"))
        checklist = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }.also { root.addView(it) }
        root.addView(TextView(this).apply {
            text = if (showDetails) "▼ Technical details" else "▶ Technical details"
            setPadding(0, dp(20), 0, dp(6))
            setTextColor(BLUE)
            setOnClickListener { showDetails = !showDetails; mode = null; render() }
            // Long-press: reset the tablet (for whoever manages the tablets).
            setOnLongClickListener { confirmReset(); true }
        })
        if (showDetails) detailsView = mono("").also { root.addView(it) }
    }

    private fun updateDynamic() {
        connectionView?.let {
            it.text = if (HubService.connected) "● Connected to the hub" else "○ ${HubService.connectionText}"
            it.setTextColor(if (HubService.connected) GREEN else GREY)
        }
        HubService.joinError?.let { errorView?.text = it }

        val usage = Permissions.hasUsageAccess(this)
        val website = Permissions.isWebsiteCheckOn(this)
        val key = "$usage/$website"
        checklist?.let { list ->
            if (key != lastChecklistKey) {
                lastChecklistKey = key
                list.removeAllViews()
                list.addView(checkRow(usage, "App tracking (Usage access)",
                    "Lets the hub see which app is open.", "Open settings") { openUsageSettings() })
                list.addView(checkRow(website, "Website check",
                    "Settings › Accessibility › Classroom Hub website check.", "Open settings") {
                    openSettings(Settings.ACTION_ACCESSIBILITY_SETTINGS)
                })
            }
        }
        detailsView?.text = diagnostics()
        updateUpdateBox()
    }

    /** "Update available" card, shown outside lessons only. */
    private fun updateUpdateBox() {
        val box = updateBox ?: return
        val inLesson = HubService.lesson?.active == true
        val show = !inLesson && (Updater.updateAvailable || Updater.status != null)
        val key = "$show/${Updater.updateAvailable}/${Updater.status}/${Updater.busy}"
        if (key == lastUpdateKey) return
        lastUpdateKey = key
        box.removeAllViews()
        if (!show) return
        box.addView(label(if (Updater.updateAvailable) "Update available (version 0.1.${Updater.latestVersion})" else "App update"))
        Updater.status?.let { box.addView(body(it)) }
        if (Updater.updateAvailable && !Updater.busy) {
            box.addView(Button(this).apply {
                text = "Install update"
                setOnClickListener { prefs.serverUrl?.let { Updater.install(this@MainActivity, it) }; lastUpdateKey = "" }
            })
        }
    }

    private fun diagnostics(): String {
        val site = WebsiteState.latest
        val c = HubService.lastClassification
        val age = site?.let { "${(System.currentTimeMillis() - it.at) / 1000}s ago" } ?: "-"
        return buildString {
            appendLine("Tablet number: ${prefs.tabletNumber}")
            appendLine("Device: ${Build.MANUFACTURER} ${Build.MODEL}")
            appendLine("Android API ${Build.VERSION.SDK_INT} (${Build.VERSION.RELEASE}), build ${Build.DISPLAY}")
            appendLine("App version: ${BuildConfig.VERSION_NAME} (newest on hub: ${Updater.latestVersion.takeIf { it > 0 } ?: "not checked"})")
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
            appendLine()
            appendLine("Other apps that can ask for Usage access:")
            usageAccessApps.forEach { appendLine("  $it") }
        }
    }

    /**
     * Apps on this tablet that request the "Usage access" permission, and
     * whether each is part of the system software. Helps answer "what else
     * on this tablet can see app usage?" for the DPIA. Worked out once.
     */
    private val usageAccessApps: List<String> by lazy {
        @Suppress("DEPRECATION")
        val packages = packageManager.getInstalledPackages(PackageManager.GET_PERMISSIONS)
        packages
            .filter { it.packageName != packageName }
            .filter { it.requestedPermissions?.contains(Manifest.permission.PACKAGE_USAGE_STATS) == true }
            .map { info ->
                val label = info.applicationInfo?.let { packageManager.getApplicationLabel(it).toString() } ?: "?"
                val system = (info.applicationInfo?.flags ?: 0) and ApplicationInfo.FLAG_SYSTEM != 0
                "$label (${info.packageName}, ${if (system) "system app" else "installed app"})"
            }
            .sorted()
            .ifEmpty { listOf("(none)") }
    }

    private fun confirmReset() {
        AlertDialog.Builder(this)
            .setTitle("Reset this tablet?")
            .setMessage("It will disconnect from the hub and need setting up again.")
            .setPositiveButton("Reset") { _, _ ->
                stopService(Intent(this, HubService::class.java))
                prefs.forget()
                HubService.lesson = null
                mode = null
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

    // ---- Tiny view helpers ------------------------------------------------------------

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()

    private fun heading(text: String) = TextView(this).apply {
        this.text = text
        textSize = 24f
        setTypeface(typeface, Typeface.BOLD)
        setPadding(0, 0, 0, dp(4))
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

    private fun subtle(text: String) = TextView(this).apply {
        this.text = text
        textSize = 14f
        setTextColor(GREY)
    }

    private fun mono(text: String) = TextView(this).apply {
        this.text = text
        textSize = 12f
        typeface = Typeface.MONOSPACE
        setTextIsSelectable(true)
    }

    private fun statusLine() = TextView(this).apply {
        textSize = 18f
        setTypeface(typeface, Typeface.BOLD)
        setPadding(0, dp(10), 0, dp(6))
    }

    private fun errorText() = body("").apply { setTextColor(RED) }

    private fun input(hintText: String, type: Int) = EditText(this).apply {
        hint = hintText
        inputType = type
        setSingleLine()
    }

    private fun nameInput() = input("e.g. Amy K", InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_WORDS or
        InputType.TYPE_TEXT_VARIATION_PERSON_NAME).apply {
        textSize = 22f
        imeOptions = EditorInfo.IME_ACTION_DONE
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
        private val BLUE = Color.rgb(36, 89, 201)
    }
}
