package uk.school.classroomhub

/**
 * Pupils type "first name + surname initial", e.g. "Amy K".
 * Same rule as server/src/names.js, so mistakes are caught on the tablet;
 * the hub checks again and has the final say.
 */
object Names {
    const val HINT = "First name and the first letter of your surname, e.g. Amy K"

    private val NAME_RE = Regex("^[\\p{L}'’-]+( [\\p{L}'’-]+)* \\p{L}$")

    /** Returns null if the name is fine, otherwise the message to show. */
    fun problemWith(input: String): String? {
        val s = input.trim().replace(Regex("\\s+"), " ").removeSuffix(".").trim()
        return if (s.length in 3..30 && NAME_RE.matches(s)) null else HINT
    }
}
