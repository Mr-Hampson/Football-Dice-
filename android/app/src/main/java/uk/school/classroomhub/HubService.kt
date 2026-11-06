package uk.school.classroomhub

import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.ConnectivityManager
import android.net.Network
import android.net.Uri
import android.os.BatteryManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * Keeps a connection open to the hub while the tablet is on.
 *  - Runs as a "foreground service", which Android requires for long-running
 *    background work. It shows a permanent notification - this also tells
 *    the pupil, honestly, when their activity is being shared.
 *  - Every few seconds during a lesson it works out on/off task and reports
 *    it. Outside a lesson it only says "connected".
 *  - Reconnects automatically after Wi-Fi drops, sleep or reboot.
 *
 * All state is touched on the main thread; OkHttp callbacks are posted to it.
 */
class HubService : Service() {

    private val handler = Handler(Looper.getMainLooper())
    private val client = OkHttpClient.Builder()
        .pingInterval(20, TimeUnit.SECONDS)
        .connectTimeout(15, TimeUnit.SECONDS)
        .build()
    private lateinit var prefs: Prefs
    private lateinit var detector: ForegroundAppDetector
    private var socket: WebSocket? = null
    private var retryDelayMs = INITIAL_RETRY_MS
    private var lastReport: String? = null
    private var lastReportAt = 0L
    private var networkCallback: ConnectivityManager.NetworkCallback? = null

    private val tick = object : Runnable {
        override fun run() {
            sendStatus(force = false)
            handler.postDelayed(this, STATUS_INTERVAL_MS)
        }
    }

    private val reconnectRunnable = Runnable { connect() }

    /** The freeze the hub asked for, so it can be re-shown if the overlay restarts. */
    private var currentFreeze: Pair<Long, String>? = null // (ends at elapsedRealtime, text)

    // Safety: if the hub has been unreachable for a minute, lift any freeze.
    private val thawWhenOffline = Runnable {
        currentFreeze = null
        WebsiteCheckService.instance?.overlays?.hideFreeze()
    }

    private val updateCheck = object : Runnable {
        override fun run() {
            checkForUpdate()
            handler.postDelayed(this, UPDATE_CHECK_MS)
        }
    }

    private val screenReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            if (intent.action == Intent.ACTION_SCREEN_ON && socket == null) reconnectNow()
            sendStatus(force = true)
        }
    }

    override fun onCreate() {
        super.onCreate()
        prefs = Prefs(this)
        RemoteConfig.load(this)
        detector = ForegroundAppDetector(this)
        startForeground(NOTIFICATION_ID, buildStatusNotification())
        registerReceiver(screenReceiver, IntentFilter().apply {
            addAction(Intent.ACTION_SCREEN_ON)
            addAction(Intent.ACTION_SCREEN_OFF)
        })
        if (Build.VERSION.SDK_INT >= 24) {
            val cb = object : ConnectivityManager.NetworkCallback() {
                override fun onAvailable(network: Network) {
                    handler.post { if (socket == null) reconnectNow() }
                }
            }
            getSystemService(ConnectivityManager::class.java).registerDefaultNetworkCallback(cb)
            networkCallback = cb
        }
        handler.post(tick)
        handler.postDelayed(updateCheck, 30_000)
        running = this
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // Must be called after every startForegroundService(), even if running.
        startForeground(NOTIFICATION_ID, buildStatusNotification())
        if (!prefs.isSetUp) {
            stopSelf()
            return START_NOT_STICKY
        }
        when (intent?.action) {
            ACTION_LINK_OPENED -> intent.getStringExtra(EXTRA_LINK_ID)?.let { linkAck(it, "opened") }
            ACTION_RECONNECT -> reconnectNow()
            ACTION_JOIN -> sendJoin("join", intent.getStringExtra(EXTRA_CODE), intent.getStringExtra(EXTRA_NAME))
            ACTION_RENAME -> sendJoin("rename", null, intent.getStringExtra(EXTRA_NAME))
            ACTION_MESSAGE_SEEN -> intent.getStringExtra(EXTRA_MESSAGE_ID)?.let { messageAck(it, "seen") }
            ACTION_HELP -> requestHelp(intent.getBooleanExtra(EXTRA_ON, true))
        }
        if (socket == null) connect()
        return START_STICKY
    }

    override fun onDestroy() {
        if (running === this) running = null
        WebsiteCheckService.instance?.overlays?.hideAll()
        handler.removeCallbacksAndMessages(null)
        unregisterReceiver(screenReceiver)
        if (Build.VERSION.SDK_INT >= 24) {
            networkCallback?.let { getSystemService(ConnectivityManager::class.java).unregisterNetworkCallback(it) }
        }
        socket?.close(1000, "Service stopped")
        socket = null
        connectionText = "Stopped"
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    // ---- Connection ---------------------------------------------------------

    private fun connect() {
        handler.removeCallbacks(reconnectRunnable)
        val base = prefs.serverUrl?.trimEnd('/') ?: return
        val token = prefs.token ?: return
        val wsUrl = base.replaceFirst(Regex("^http", RegexOption.IGNORE_CASE), "ws") + "/ws/device"
        val request = try {
            Request.Builder().url(wsUrl).header("Authorization", "Bearer $token").build()
        } catch (e: IllegalArgumentException) {
            connectionText = "Hub address is not valid"
            updateNotification()
            return
        }
        connectionText = "Connecting…"
        updateNotification()
        socket = client.newWebSocket(request, Listener())
    }

    private fun reconnectNow() {
        retryDelayMs = INITIAL_RETRY_MS
        socket?.cancel()
        socket = null
        connect()
    }

    private fun scheduleReconnect() {
        handler.removeCallbacks(reconnectRunnable)
        handler.postDelayed(reconnectRunnable, retryDelayMs)
        retryDelayMs = (retryDelayMs * 2).coerceAtMost(MAX_RETRY_MS)
    }

    private inner class Listener : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
            handler.post {
                if (socket !== webSocket) return@post
                retryDelayMs = INITIAL_RETRY_MS
                handler.removeCallbacks(thawWhenOffline)
                connected = true
                connectionText = "Connected"
                updateNotification()
                sendStatus(force = true)
            }
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            handler.post { if (socket === webSocket) handleMessage(text) }
        }

        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            webSocket.close(1000, null)
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            handler.post { onDisconnected(webSocket, code, null) }
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            handler.post { onDisconnected(webSocket, null, response?.code) }
        }
    }

    private fun onDisconnected(webSocket: WebSocket, closeCode: Int?, httpCode: Int?) {
        if (socket !== webSocket) return
        socket = null
        connected = false
        if (currentFreeze != null) {
            handler.removeCallbacks(thawWhenOffline)
            handler.postDelayed(thawWhenOffline, OFFLINE_THAW_MS)
        }
        if (closeCode == 4001 || httpCode == 401) {
            // The tablet was removed on the dashboard (or set up again elsewhere).
            prefs.forget()
            lesson = null
            connectionText = "This tablet is no longer set up. Ask whoever manages the tablets to set it up again."
            updateNotification()
            stopSelf()
            return
        }
        connectionText = "Not connected – retrying"
        updateNotification()
        scheduleReconnect()
    }

    private fun handleMessage(text: String) {
        val msg = try { JSONObject(text) } catch (e: Exception) { return }
        when (msg.optString("type")) {
            "welcome" -> prefs.tabletNumber = msg.optString("tabletNumber")
            "lesson" -> {
                val wasAsked = lesson?.nameRequested == true
                val next = Lesson(
                    active = msg.optBoolean("active"),
                    title = msg.optString("title"),
                    name = msg.optString("name"),
                    nameRequested = msg.optBoolean("nameRequested"),
                    helpRequested = msg.optBoolean("helpRequested"),
                    allowedDomains = msg.optJSONArray("allowedDomains").toStringList(),
                    allowedApps = msg.optJSONArray("allowedApps").toStringList(),
                )
                lesson = next
                if (next.active) joinError = null
                if (!next.active) WebsiteState.latest = null
                applyFreeze(if (next.active) msg.optJSONObject("freeze") else null)
                if (!next.active) WebsiteCheckService.instance?.overlays?.hideMessage()
                if (next.nameRequested && !wasAsked) showNamePrompt()
                updateNotification()
                sendStatus(force = true)
            }
            "joinError" -> joinError = msg.optString("error")
            "config" -> RemoteConfig.update(this, msg)
            "link" -> {
                val id = msg.optString("id")
                val url = msg.optString("url")
                if (id.isNotEmpty() && (url.startsWith("https://") || url.startsWith("http://"))) {
                    linkAck(id, "delivered")
                    openLink(id, url)
                }
            }
            "message" -> {
                val id = msg.optString("id")
                val text = msg.optString("text")
                if (id.isNotEmpty() && text.isNotEmpty()) {
                    messageAck(id, "delivered")
                    showMessage(id, text)
                }
            }
        }
    }

    private fun send(json: JSONObject): Boolean = socket?.send(json.toString()) ?: false

    /** The pupil typed the join code and/or their name on the main screen. */
    private fun sendJoin(type: String, code: String?, name: String?) {
        val json = JSONObject().put("type", type).put("name", name.orEmpty())
        if (code != null) json.put("code", code)
        joinError = if (send(json)) null else "Not connected to the hub yet. Check the Wi-Fi and try again."
    }

    private fun linkAck(id: String, stage: String) {
        send(JSONObject().put("type", "linkAck").put("id", id).put("stage", stage))
    }

    /** "I need help" (or cancel it), from the app or the notification. */
    private fun requestHelp(on: Boolean) {
        if (lesson?.active != true) return
        if (!send(JSONObject().put("type", "help").put("on", on))) {
            joinError = "Not connected to the hub. Put your hand up instead."
        }
    }

    private fun messageAck(id: String, stage: String) {
        send(JSONObject().put("type", "messageAck").put("id", id).put("stage", stage))
    }

    // ---- Links, messages and freezing ---------------------------------------

    /**
     * Opens a teacher's link straight away in Silk. Android allows this because
     * the website check is an accessibility service. If it can't (website check
     * off, or the screen is frozen), the pupil gets a notification to tap.
     */
    private fun openLink(id: String, url: String) {
        val service = WebsiteCheckService.instance
        if (service == null || currentFreeze != null) {
            showLinkNotification(id, url)
            return
        }
        val view = Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        val launchedAt = System.currentTimeMillis()
        try {
            service.startActivity(Intent(view).setPackage(Classifier.SILK))
        } catch (e: Exception) {
            try {
                service.startActivity(view)
            } catch (_: Exception) {
                showLinkNotification(id, url)
                return
            }
        }
        // Android can silently refuse to open it; check Silk actually came up.
        handler.postDelayed({
            if (WebsiteCheckService.lastBrowserEventAt >= launchedAt) linkAck(id, "opened")
            else showLinkNotification(id, url)
        }, 3000)
    }

    private fun showMessage(id: String, text: String) {
        val overlays = WebsiteCheckService.instance?.overlays
        if (overlays != null) {
            overlays.showMessage(text) { messageAck(id, "seen") }
        } else {
            showMessageNotification(id, text) // website check is off: next best thing
        }
    }

    private fun applyFreeze(freeze: JSONObject?) {
        if (freeze == null) {
            currentFreeze = null
            WebsiteCheckService.instance?.overlays?.hideFreeze()
            return
        }
        val remaining = freeze.optLong("remainingMs").coerceIn(0, MAX_FREEZE_MS)
        currentFreeze = (SystemClock.elapsedRealtime() + remaining) to freeze.optString("text")
        reapplyOverlays()
    }

    /** Re-shows a freeze, e.g. after the website check restarts. */
    fun reapplyOverlays() {
        val (endsAt, text) = currentFreeze ?: return
        val left = endsAt - SystemClock.elapsedRealtime()
        if (left <= 0) {
            currentFreeze = null
            return
        }
        WebsiteCheckService.instance?.overlays?.showFreeze(left, text)
    }

    // ---- Updates -----------------------------------------------------------------

    private fun checkForUpdate() {
        val hub = prefs.serverUrl ?: return
        Updater.check(hub) {
            handler.post {
                // Never interrupt a lesson with an update prompt.
                if (Updater.updateAvailable && lesson?.active != true) showUpdateNotification()
            }
        }
    }

    // ---- Status reports -----------------------------------------------------

    private fun sendStatus(force: Boolean) {
        if (socket == null) return
        val power = getSystemService(Context.POWER_SERVICE) as PowerManager
        val screenOn = power.isInteractive
        val usage = Permissions.hasUsageAccess(this)
        val website = Permissions.isWebsiteCheckOn(this)

        val json = JSONObject()
            .put("type", "status")
            .put("screenOn", screenOn)
            .put("perms", JSONObject().put("usage", usage).put("website", website))
            .put("battery", batteryPercent())
            .put("appVersion", BuildConfig.VERSION_NAME)
            .put("appVersionCode", BuildConfig.VERSION_CODE)

        val current = lesson
        if (current == null || !current.active) {
            // Outside lessons: no app or website information at all.
            json.put("state", "paused")
        } else if (!screenOn) {
            json.put("state", "idle")
        } else {
            val fg = if (usage) detector.currentPackage() else null
            lastForeground = fg
            val result = Classifier.classify(
                foreground = fg,
                foregroundLabel = fg?.let { detector.labelFor(it) },
                ownPackage = packageName,
                homePackages = detector.homePackages,
                usageAccess = usage,
                websiteCheck = website,
                site = WebsiteState.latest,
                lesson = current,
            )
            json.put("state", result.state)
            result.appLabel?.let { json.put("appLabel", it) }
            result.appPackage?.let { json.put("appPackage", it) }
            result.domain?.let { json.put("domain", it) }
            result.matched?.let { json.put("matched", it) }
            result.detail?.let { json.put("detail", it) }
            lastClassification = result
        }

        // Only send when something changed, or every 15 s as a heartbeat.
        val withoutBattery = JSONObject(json.toString()).apply { remove("battery") }.toString()
        val now = System.currentTimeMillis()
        if (force || withoutBattery != lastReport || now - lastReportAt > HEARTBEAT_MS) {
            if (send(json)) {
                lastReport = withoutBattery
                lastReportAt = now
            }
        }
    }

    private fun batteryPercent(): Int {
        val bm = getSystemService(Context.BATTERY_SERVICE) as BatteryManager
        return bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)
    }

    // ---- Notifications ------------------------------------------------------

    @Suppress("DEPRECATION") // PRIORITY_LOW only matters before Android 8
    private fun buildStatusNotification(): Notification {
        val current = lesson
        val tablet = prefs.tabletNumber?.let { "Tablet $it" } ?: "Classroom Hub"
        val text = when {
            !connected -> connectionText
            current?.active == true ->
                "${current.name} · ${current.title}. Your teacher can see which app and website you are using."
            else -> "$tablet · Not in a lesson. Open Classroom Hub to join. Nothing is shared outside lessons."
        }
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java), pendingIntentFlags()
        )
        val builder = notificationBuilder(App.CHANNEL_STATUS, Notification.PRIORITY_LOW)
            .setSmallIcon(R.drawable.ic_notify)
            .setContentTitle(if (current?.active == true) "Classroom Hub – in a lesson" else tablet)
            .setContentText(text)
            .setStyle(Notification.BigTextStyle().bigText(text))
            .setContentIntent(open)
            .setOngoing(true)
        // "I need help" straight from the notification, without leaving Silk.
        if (connected && current?.active == true) {
            val on = !current.helpRequested
            val help = Intent(this, HubService::class.java).setAction(ACTION_HELP).putExtra(EXTRA_ON, on)
            val pi = if (Build.VERSION.SDK_INT >= 26) {
                PendingIntent.getForegroundService(this, 4, help, pendingIntentFlags())
            } else {
                PendingIntent.getService(this, 4, help, pendingIntentFlags())
            }
            @Suppress("DEPRECATION")
            builder.addAction(Notification.Action.Builder(R.drawable.ic_notify, if (on) "✋ I need help" else "Cancel help request", pi).build())
        }
        return builder.build()
    }

    @Suppress("DEPRECATION") // priority and the no-channel builder are for pre-Android 8 tablets
    private fun notificationBuilder(channel: String, priority: Int): Notification.Builder =
        if (Build.VERSION.SDK_INT >= 26) {
            Notification.Builder(this, channel)
        } else {
            Notification.Builder(this).setPriority(priority)
        }

    private fun notify(id: Int, notification: Notification) {
        try {
            (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).notify(id, notification)
        } catch (e: SecurityException) {
            // Notifications blocked; the service keeps working.
        }
    }

    private fun updateNotification() = notify(NOTIFICATION_ID, buildStatusNotification())

    private fun showLinkNotification(id: String, url: String) {
        val open = Intent(this, OpenLinkActivity::class.java)
            .putExtra(OpenLinkActivity.EXTRA_LINK_ID, id)
            .putExtra(OpenLinkActivity.EXTRA_URL, url)
        val pi = PendingIntent.getActivity(this, id.hashCode(), open, pendingIntentFlags())
        val host = Uri.parse(url).host ?: url
        @Suppress("DEPRECATION")
        val notification = notificationBuilder(App.CHANNEL_LINKS, Notification.PRIORITY_HIGH)
            .setSmallIcon(R.drawable.ic_notify)
            .setContentTitle("Your teacher sent you a link")
            .setContentText("Tap to open $host")
            .setContentIntent(pi)
            .setAutoCancel(true)
            .setDefaults(Notification.DEFAULT_ALL)
            .build()
        notify(id.hashCode(), notification)
    }

    private fun showNamePrompt() {
        val pi = PendingIntent.getActivity(this, 2, Intent(this, MainActivity::class.java), pendingIntentFlags())
        @Suppress("DEPRECATION")
        val notification = notificationBuilder(App.CHANNEL_LINKS, Notification.PRIORITY_HIGH)
            .setSmallIcon(R.drawable.ic_notify)
            .setContentTitle("Your teacher asked you to retype your name")
            .setContentText("Tap to enter your first name and surname initial")
            .setContentIntent(pi)
            .setAutoCancel(true)
            .setDefaults(Notification.DEFAULT_ALL)
            .build()
        notify(NAME_PROMPT_ID, notification)
    }

    private fun showMessageNotification(id: String, text: String) {
        val open = Intent(this, MainActivity::class.java).putExtra(EXTRA_MESSAGE_ID, id)
        val pi = PendingIntent.getActivity(this, id.hashCode(), open, pendingIntentFlags())
        @Suppress("DEPRECATION")
        val notification = notificationBuilder(App.CHANNEL_LINKS, Notification.PRIORITY_HIGH)
            .setSmallIcon(R.drawable.ic_notify)
            .setContentTitle("Message from your teacher")
            .setContentText(text)
            .setStyle(Notification.BigTextStyle().bigText(text))
            .setContentIntent(pi)
            .setAutoCancel(true)
            .setDefaults(Notification.DEFAULT_ALL)
            .build()
        notify(id.hashCode(), notification)
    }

    @Suppress("DEPRECATION") // PRIORITY_LOW only matters before Android 8
    private fun showUpdateNotification() {
        val pi = PendingIntent.getActivity(this, 3, Intent(this, MainActivity::class.java), pendingIntentFlags())
        val notification = notificationBuilder(App.CHANNEL_STATUS, Notification.PRIORITY_LOW)
            .setSmallIcon(R.drawable.ic_notify)
            .setContentTitle("Classroom Hub update available")
            .setContentText("Tap to open the app, then press Install update.")
            .setContentIntent(pi)
            .setAutoCancel(true)
            .build()
        notify(UPDATE_ID, notification)
    }

    private fun pendingIntentFlags(): Int =
        PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= 23) PendingIntent.FLAG_IMMUTABLE else 0)

    companion object {
        const val ACTION_LINK_OPENED = "uk.school.classroomhub.LINK_OPENED"
        const val ACTION_RECONNECT = "uk.school.classroomhub.RECONNECT"
        const val EXTRA_LINK_ID = "linkId"
        const val ACTION_HELP = "uk.school.classroomhub.HELP"
        const val EXTRA_ON = "on"
        const val ACTION_MESSAGE_SEEN = "uk.school.classroomhub.MESSAGE_SEEN"
        const val EXTRA_MESSAGE_ID = "messageId"
        private const val UPDATE_ID = 3
        private const val UPDATE_CHECK_MS = 6 * 60 * 60 * 1000L
        private const val OFFLINE_THAW_MS = 60_000L
        private const val MAX_FREEZE_MS = 10 * 60 * 1000L
        const val ACTION_JOIN = "uk.school.classroomhub.JOIN"
        const val ACTION_RENAME = "uk.school.classroomhub.RENAME"
        const val EXTRA_CODE = "code"
        const val EXTRA_NAME = "name"
        private const val NOTIFICATION_ID = 1
        private const val NAME_PROMPT_ID = 2
        private const val STATUS_INTERVAL_MS = 5_000L
        private const val HEARTBEAT_MS = 15_000L
        private const val INITIAL_RETRY_MS = 2_000L
        private const val MAX_RETRY_MS = 30_000L

        // Read by the main screen and the website check (main thread).
        @Volatile var lesson: Lesson? = null
        @Volatile var connected = false
        @Volatile var connectionText = "Not started"
        @Volatile var lastForeground: String? = null
        @Volatile var lastClassification: Classification? = null
        /** Why the last join or rename was refused, shown on the main screen. */
        @Volatile var joinError: String? = null

        /** The running service, so the website check can reach it (main thread). */
        @Volatile var running: HubService? = null

        /** Called when the website check starts: re-show a freeze in progress. */
        fun onWebsiteCheckReady() {
            running?.reapplyOverlays()
        }

        fun help(context: Context, on: Boolean) {
            start(context, Intent(context, HubService::class.java).setAction(ACTION_HELP).putExtra(EXTRA_ON, on))
        }

        fun messageSeen(context: Context, messageId: String) {
            start(context, Intent(context, HubService::class.java).setAction(ACTION_MESSAGE_SEEN).putExtra(EXTRA_MESSAGE_ID, messageId))
        }

        fun start(context: Context, action: String? = null) {
            val intent = Intent(context, HubService::class.java).setAction(action)
            if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(intent) else context.startService(intent)
        }

        fun join(context: Context, code: String, name: String) {
            start(context, Intent(context, HubService::class.java).setAction(ACTION_JOIN)
                .putExtra(EXTRA_CODE, code).putExtra(EXTRA_NAME, name))
        }

        fun rename(context: Context, name: String) {
            start(context, Intent(context, HubService::class.java).setAction(ACTION_RENAME).putExtra(EXTRA_NAME, name))
        }

        private fun start(context: Context, intent: Intent) {
            if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(intent) else context.startService(intent)
        }

        fun reportLinkOpened(context: Context, linkId: String) {
            val intent = Intent(context, HubService::class.java)
                .setAction(ACTION_LINK_OPENED)
                .putExtra(EXTRA_LINK_ID, linkId)
            if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(intent) else context.startService(intent)
        }
    }
}

private fun JSONArray?.toStringList(): List<String> {
    if (this == null) return emptyList()
    return (0 until length()).mapNotNull { optString(it).takeIf { s -> s.isNotEmpty() } }
}
