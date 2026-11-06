package uk.school.classroomhub

import android.accessibilityservice.AccessibilityService
import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView

/**
 * Draws on top of every app, using the accessibility service's special
 * overlay window (no extra permission needed):
 *  - a message card from the teacher, with an OK button;
 *  - a full-screen "Eyes on your teacher" cover that blocks the tablet.
 *
 * Safety: a freeze always ends on its own when its time runs out, and
 * HubService also lifts it if the hub has been unreachable for a minute.
 * Must be used on the main thread.
 */
class ScreenOverlays(private val service: AccessibilityService) {
    private val wm = service.getSystemService(Context.WINDOW_SERVICE) as WindowManager
    private val handler = Handler(Looper.getMainLooper())
    private var messageView: View? = null
    private var freezeView: View? = null
    private var freezeEndsAt = 0L // SystemClock.elapsedRealtime()
    private var countdown: TextView? = null

    private val tick = object : Runnable {
        override fun run() {
            val left = freezeEndsAt - SystemClock.elapsedRealtime()
            if (left <= 0) {
                hideFreeze()
                return
            }
            val s = (left + 999) / 1000
            countdown?.text = "Your tablet unfreezes in ${s / 60}:${(s % 60).toString().padStart(2, '0')}"
            handler.postDelayed(this, 500)
        }
    }

    val isFrozen: Boolean get() = freezeView != null

    private fun params(blockTouches: Boolean) = WindowManager.LayoutParams(
        WindowManager.LayoutParams.MATCH_PARENT,
        WindowManager.LayoutParams.MATCH_PARENT,
        WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
        WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN or
            WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS or
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
            (if (blockTouches) 0 else WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL),
        PixelFormat.TRANSLUCENT,
    )

    private fun dp(v: Int) = (v * service.resources.displayMetrics.density).toInt()

    // ---- Message card -------------------------------------------------------

    /** Shows a teacher's message. [onSeen] runs when the pupil presses OK. */
    fun showMessage(text: String, onSeen: () -> Unit) {
        hideMessage()
        val card = LinearLayout(service).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(24), dp(20), dp(24), dp(18))
            background = GradientDrawable().apply { setColor(Color.WHITE); cornerRadius = dp(16).toFloat() }
            elevation = dp(8).toFloat()
        }
        card.addView(TextView(service).apply {
            this.text = "Message from your teacher"
            textSize = 14f
            setTextColor(BLUE)
            setTypeface(typeface, Typeface.BOLD)
        })
        card.addView(TextView(service).apply {
            this.text = text
            textSize = 24f
            setTextColor(INK)
            setTypeface(typeface, Typeface.BOLD)
            setPadding(0, dp(8), 0, dp(14))
        })
        card.addView(Button(service).apply {
            this.text = "OK"
            textSize = 18f
            setOnClickListener {
                hideMessage()
                onSeen()
            }
        }, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT))

        val root = FrameLayout(service).apply {
            setBackgroundColor(Color.argb(110, 17, 21, 29))
            addView(card, FrameLayout.LayoutParams(dp(520), FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.CENTER))
        }
        // The card waits for OK: touches around it are blocked so it isn't missed.
        root.setOnTouchListener { _, _ -> true }
        add(root, params(blockTouches = true))?.let { messageView = it }
    }

    fun hideMessage() {
        messageView?.let { remove(it) }
        messageView = null
    }

    // ---- Freeze ---------------------------------------------------------------

    /** Covers the whole screen for [remainingMs] (or until [hideFreeze]). */
    fun showFreeze(remainingMs: Long, text: String) {
        freezeEndsAt = SystemClock.elapsedRealtime() + remainingMs
        if (freezeView == null) {
            val col = LinearLayout(service).apply {
                orientation = LinearLayout.VERTICAL
                gravity = Gravity.CENTER
                setBackgroundColor(BLUE)
                setPadding(dp(40), dp(40), dp(40), dp(40))
            }
            col.addView(TextView(service).apply {
                this.text = "👀"
                textSize = 72f
                gravity = Gravity.CENTER
            })
            col.addView(TextView(service).apply {
                this.text = "Eyes on your teacher"
                textSize = 44f
                setTextColor(Color.WHITE)
                setTypeface(typeface, Typeface.BOLD)
                gravity = Gravity.CENTER
            })
            col.addView(TextView(service).apply {
                tag = "text"
                textSize = 22f
                setTextColor(Color.WHITE)
                gravity = Gravity.CENTER
                setPadding(0, dp(12), 0, 0)
            })
            countdown = TextView(service).apply {
                textSize = 16f
                setTextColor(Color.argb(210, 255, 255, 255))
                gravity = Gravity.CENTER
                setPadding(0, dp(28), 0, 0)
            }
            col.addView(countdown)
            @SuppressLint("ClickableViewAccessibility")
            col.setOnTouchListener { _, _ -> true } // the tablet can't be used while frozen
            freezeView = add(col, params(blockTouches = true))
        }
        freezeView?.findViewWithTag<TextView>("text")?.text = text
        handler.removeCallbacks(tick)
        handler.post(tick)
        // A message sent during a freeze should still be readable on top.
        messageView?.let { v -> remove(v); add(v, params(blockTouches = true)) }
    }

    fun hideFreeze() {
        handler.removeCallbacks(tick)
        freezeView?.let { remove(it) }
        freezeView = null
        countdown = null
    }

    fun hideAll() {
        hideMessage()
        hideFreeze()
    }

    private fun add(view: View, lp: WindowManager.LayoutParams): View? = try {
        wm.addView(view, lp)
        view
    } catch (e: RuntimeException) {
        null // e.g. the service is being switched off
    }

    private fun remove(view: View) {
        try {
            wm.removeView(view)
        } catch (_: RuntimeException) {
        }
    }

    companion object {
        private val BLUE = Color.rgb(36, 89, 201)
        private val INK = Color.rgb(23, 32, 51)
    }
}
