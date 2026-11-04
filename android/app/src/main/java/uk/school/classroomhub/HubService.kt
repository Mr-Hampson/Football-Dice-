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

    private val screenReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            if (intent.action == Intent.ACTION_SCREEN_ON && socket == null) reconnectNow()
            sendStatus(force = true)
        }
    }

    override fun onCreate() {
        super.onCreate()
        prefs = Prefs(this)
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
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // Must be called after every startForegroundService(), even if running.
        startForeground(NOTIFICATION_ID, buildStatusNotification())
        if (!prefs.isPaired) {
            stopSelf()
            return START_NOT_STICKY
        }
        when (intent?.action) {
            ACTION_LINK_OPENED -> intent.getStringExtra(EXTRA_LINK_ID)?.let { linkAck(it, "opened") }
            ACTION_RECONNECT -> reconnectNow()
        }
        if (socket == null) connect()
        return START_STICKY
    }

    override fun onDestroy() {
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
        if (closeCode == 4001 || httpCode == 401) {
            // The teacher unpaired this tablet (or it was paired to someone else).
            prefs.forget()
            lesson = null
            connectionText = "This tablet is no longer set up. Ask your teacher for a new code."
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
            "welcome" -> prefs.pupilName = msg.optString("pupilName")
            "lesson" -> {
                lesson = Lesson(
                    active = msg.optBoolean("active"),
                    className = msg.optString("className"),
                    allowedDomains = msg.optJSONArray("allowedDomains").toStringList(),
                    allowedApps = msg.optJSONArray("allowedApps").toStringList(),
                )
                if (lesson?.active != true) WebsiteState.latest = null
                updateNotification()
                sendStatus(force = true)
            }
            "link" -> {
                val id = msg.optString("id")
                val url = msg.optString("url")
                if (id.isNotEmpty() && (url.startsWith("https://") || url.startsWith("http://"))) {
                    showLinkNotification(id, url)
                    linkAck(id, "delivered")
                }
            }
        }
    }

    private fun send(json: JSONObject): Boolean = socket?.send(json.toString()) ?: false

    private fun linkAck(id: String, stage: String) {
        send(JSONObject().put("type", "linkAck").put("id", id).put("stage", stage))
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
        val text = when {
            !connected -> connectionText
            current?.active == true ->
                "Lesson in progress (${current.className}). Your teacher can see which app and website you are using."
            else -> "Connected. Nothing is shared outside lessons."
        }
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java), pendingIntentFlags()
        )
        return notificationBuilder(App.CHANNEL_STATUS, Notification.PRIORITY_LOW)
            .setSmallIcon(R.drawable.ic_notify)
            .setContentTitle(if (current?.active == true) "Classroom Hub – lesson" else "Classroom Hub")
            .setContentText(text)
            .setStyle(Notification.BigTextStyle().bigText(text))
            .setContentIntent(open)
            .setOngoing(true)
            .build()
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

    private fun pendingIntentFlags(): Int =
        PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= 23) PendingIntent.FLAG_IMMUTABLE else 0)

    companion object {
        const val ACTION_LINK_OPENED = "uk.school.classroomhub.LINK_OPENED"
        const val ACTION_RECONNECT = "uk.school.classroomhub.RECONNECT"
        const val EXTRA_LINK_ID = "linkId"
        private const val NOTIFICATION_ID = 1
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

        fun start(context: Context, action: String? = null) {
            val intent = Intent(context, HubService::class.java).setAction(action)
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
