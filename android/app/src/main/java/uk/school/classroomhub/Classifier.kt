package uk.school.classroomhub

/** The lesson this tablet has joined, as sent by the hub. */
data class Lesson(
    val active: Boolean,
    val title: String = "",
    /** The name the pupil typed when joining, e.g. "Amy K". */
    val name: String = "",
    /** The teacher has asked the pupil to type their name again. */
    val nameRequested: Boolean = false,
    /** The pupil has pressed "I need help" and the teacher hasn't cleared it. */
    val helpRequested: Boolean = false,
    val allowedDomains: List<String> = emptyList(),
    val allowedApps: List<String> = emptyList(),
)

/** What we tell the teacher. Only off-task reports include the site or app. */
data class Classification(
    val state: String, // "on", "off", "idle", "unknown"
    val appLabel: String? = null,
    val appPackage: String? = null,
    val domain: String? = null,
    val matched: String? = null,
    val detail: String? = null,
)

/**
 * Decides "on task" / "off task" ON THE TABLET, so on-task browsing never
 * leaves the device. Keep in step with the simulator in
 * server/tools/simulate-tablets.js and domains.js on the server.
 */
object Classifier {
    const val SILK = "com.amazon.cloud9"
    val BROWSERS = setOf(SILK, "com.android.chrome")

    fun classify(
        foreground: String?,
        foregroundLabel: String?,
        ownPackage: String,
        homePackages: Set<String>,
        usageAccess: Boolean,
        websiteCheck: Boolean,
        site: WebsiteState.Snapshot?,
        lesson: Lesson,
    ): Classification {
        if (!usageAccess) return Classification("unknown", detail = "App tracking permission is off")
        if (foreground == null) return Classification("unknown", detail = "Waiting for app activity")
        if (foreground == ownPackage) return Classification("on", appLabel = "Classroom Hub")
        if (foreground in homePackages) return Classification("idle", appLabel = "Home screen")
        if (foreground in lesson.allowedApps) return Classification("on", appLabel = foregroundLabel)

        if (foreground in BROWSERS) {
            if (!websiteCheck) {
                return Classification("unknown", appLabel = foregroundLabel, detail = "$foregroundLabel – website check is off")
            }
            val domain = site?.takeIf { it.browserPackage == foreground }?.domain
                ?: return Classification("unknown", appLabel = foregroundLabel, detail = "$foregroundLabel – couldn't read the website")
            val matched = matchDomain(domain, lesson.allowedDomains)
            return if (matched != null) {
                Classification("on", appLabel = foregroundLabel, matched = matched)
            } else {
                Classification("off", appLabel = foregroundLabel, domain = domain)
            }
        }
        return Classification("off", appLabel = foregroundLabel, appPackage = foreground)
    }

    /** "www.bbc.co.uk" matches allowed "bbc.co.uk"; "notbbc.co.uk" does not. */
    fun matchDomain(host: String, allowed: List<String>): String? {
        val h = host.lowercase().removePrefix("www.")
        return allowed.firstOrNull { h == it || h.endsWith(".$it") }
    }

    private val DOMAIN_RE = Regex("^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]{2,63}$")

    /**
     * Turns address-bar text into a bare domain, or null if it doesn't look
     * like a web address (e.g. a search the pupil is still typing).
     */
    fun domainFromText(text: CharSequence?): String? {
        val t = text?.toString()?.trim()?.lowercase() ?: return null
        if (t.isEmpty() || t.any { it.isWhitespace() }) return null
        val host = t.replace(Regex("^[a-z][a-z0-9+.-]*://"), "")
            .split('/', '?', '#')[0]
            .replace(Regex(":\\d+$"), "")
            .removePrefix("www.")
        return if (DOMAIN_RE.matches(host)) host else null
    }
}
