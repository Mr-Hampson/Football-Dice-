package uk.school.classroomhub

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ClassifierTest {
    private val lesson = Lesson(
        active = true,
        title = "S2",
        name = "Amy K",
        allowedDomains = listOf("bbc.co.uk", "classroom.google.com"),
        allowedApps = listOf("com.amazon.kindle"),
    )
    private val home = setOf("com.amazon.firelauncher")

    private fun classify(fg: String?, label: String? = fg, usage: Boolean = true, website: Boolean = true, domain: String? = null) =
        Classifier.classify(
            foreground = fg,
            foregroundLabel = label,
            ownPackage = "uk.school.classroomhub",
            homePackages = home,
            usageAccess = usage,
            websiteCheck = website,
            site = domain?.let { WebsiteState.Snapshot(Classifier.SILK, it, 0L, "test") },
            lesson = lesson,
        )

    @Test fun silkOnAllowedSiteIsOnTaskAndDoesNotSendDomain() {
        val r = classify(Classifier.SILK, "Silk", domain = "www.bbc.co.uk")
        assertEquals("on", r.state)
        assertEquals("bbc.co.uk", r.matched)
        assertNull(r.domain)
    }

    @Test fun silkOnOtherSiteIsOffTask() {
        val r = classify(Classifier.SILK, "Silk", domain = "youtube.com")
        assertEquals("off", r.state)
        assertEquals("youtube.com", r.domain)
    }

    @Test fun lookalikeDomainIsNotAllowed() {
        assertEquals("off", classify(Classifier.SILK, "Silk", domain = "notbbc.co.uk").state)
    }

    @Test fun silkWithoutWebsiteCheckIsUnknown() {
        assertEquals("unknown", classify(Classifier.SILK, "Silk", website = false).state)
    }

    @Test fun silkWhenAddressUnreadableIsUnknown() {
        assertEquals("unknown", classify(Classifier.SILK, "Silk").state)
    }

    @Test fun otherAppsAreOffTaskUnlessAllowed() {
        val r = classify("com.google.android.youtube", "YouTube")
        assertEquals("off", r.state)
        assertEquals("com.google.android.youtube", r.appPackage)
        assertEquals("on", classify("com.amazon.kindle", "Kindle").state)
    }

    @Test fun homeScreenIsIdle() {
        assertEquals("idle", classify("com.amazon.firelauncher").state)
    }

    @Test fun noUsageAccessMeansUnknown() {
        assertEquals("unknown", classify(Classifier.SILK, usage = false).state)
    }

    @Test fun domainFromAddressBarText() {
        assertEquals("bbc.co.uk", Classifier.domainFromText("https://www.bbc.co.uk/bitesize"))
        assertEquals("classroom.google.com", Classifier.domainFromText("classroom.google.com/c/123"))
        assertEquals("bbc.co.uk", Classifier.domainFromText("bbc.co.uk"))
        assertNull(Classifier.domainFromText("how to draw a cat"))
        assertNull(Classifier.domainFromText("bitesize"))
        assertNull(Classifier.domainFromText(null))
    }

    @Test fun pupilNames() {
        assertNull(Names.problemWith("Amy K"))
        assertNull(Names.problemWith("  amy   k. "))
        assertNull(Names.problemWith("Mary-Jane O"))
        assertNull(Names.problemWith("Seán Ó"))
        assertEquals(Names.HINT, Names.problemWith("Amy"))
        assertEquals(Names.HINT, Names.problemWith("Amy Kerr"))
        assertEquals(Names.HINT, Names.problemWith("x1 k"))
    }
}
