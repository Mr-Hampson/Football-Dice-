package uk.school.classroomhub

import android.accessibilityservice.AccessibilityService
import android.os.Handler
import android.os.Looper
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo

/** The latest website seen in a browser. Kept in memory only. */
object WebsiteState {
    data class Snapshot(
        val browserPackage: String,
        val domain: String?,
        val at: Long,
        /** Which screen element the domain came from (for testing on new tablets). */
        val source: String?,
    )

    @Volatile var latest: Snapshot? = null

    /** Element IDs seen in the browser that might be the address bar (diagnostics only). */
    @Volatile var candidateIds: List<String> = emptyList()
}

/**
 * Accessibility service that reads the address bar of Silk (or Chrome).
 *
 * IMPORTANT - this is the experimental part of the prototype:
 *  - Amazon does not document Silk's screen layout. We try known IDs first,
 *    then search for anything that looks like an address bar. The app's
 *    "Technical details" screen shows what was found, so we can learn the
 *    right ID on your tablets and add it to KNOWN_URL_BAR_IDS.
 *  - A Silk update could change the layout and break this.
 *  - The manifest limits this service to browser apps only, and only a
 *    domain name (never the full address or page text) is kept.
 *  - Outside lessons the service ignores everything.
 */
class WebsiteCheckService : AccessibilityService() {

    private val handler = Handler(Looper.getMainLooper())
    private var pendingPackage: String? = null
    private val readRunnable = Runnable { pendingPackage?.let { readAddressBar(it) } }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        val pkg = event?.packageName?.toString() ?: return
        if (pkg !in Classifier.BROWSERS) return
        if (HubService.lesson?.active != true) return // nothing is read outside lessons
        // Pages fire many events while loading; wait for a quiet moment.
        pendingPackage = pkg
        handler.removeCallbacks(readRunnable)
        handler.postDelayed(readRunnable, 700)
    }

    override fun onInterrupt() {}

    private fun readAddressBar(pkg: String) {
        val root = rootInActiveWindow ?: return
        if (root.packageName?.toString() != pkg) return

        // 1. Known address-bar IDs.
        for (id in KNOWN_URL_BAR_IDS) {
            if (!id.startsWith("$pkg:")) continue
            for (node in root.findAccessibilityNodeInfosByViewId(id)) {
                val domain = Classifier.domainFromText(node.text)
                if (domain != null) {
                    WebsiteState.latest = WebsiteState.Snapshot(pkg, domain, System.currentTimeMillis(), id)
                    return
                }
            }
        }

        // 2. Search the screen for something that looks like an address bar.
        val candidates = ArrayList<String>()
        var found: Pair<String, String>? = null
        val queue = ArrayDeque<AccessibilityNodeInfo>()
        queue.add(root)
        var visited = 0
        while (queue.isNotEmpty() && visited < MAX_NODES) {
            val node = queue.removeFirst()
            visited++
            val id = node.viewIdResourceName
            val looksLikeUrlBar = (id != null && URL_HINTS.any { id.contains(it, ignoreCase = true) }) ||
                node.className?.toString() == "android.widget.EditText"
            if (looksLikeUrlBar) {
                val label = id ?: "EditText(no id)"
                if (label !in candidates) candidates.add(label)
                if (found == null) {
                    val domain = Classifier.domainFromText(node.text)
                    if (domain != null) found = domain to label
                }
            }
            for (i in 0 until node.childCount) node.getChild(i)?.let { queue.add(it) }
        }
        WebsiteState.candidateIds = candidates.take(10)
        WebsiteState.latest = WebsiteState.Snapshot(pkg, found?.first, System.currentTimeMillis(), found?.second)
    }

    companion object {
        /**
         * Chrome's address bar is "url_bar". Silk is built on Chromium so it
         * MAY use the same name - unverified until tested on a Fire tablet.
         */
        val KNOWN_URL_BAR_IDS = listOf(
            "com.amazon.cloud9:id/url_bar",
            "com.android.chrome:id/url_bar",
        )
        private val URL_HINTS = listOf("url", "omnibox", "address", "location")
        private const val MAX_NODES = 400
    }
}
