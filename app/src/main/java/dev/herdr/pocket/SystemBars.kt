package dev.herdr.pocket

import android.graphics.Canvas
import android.graphics.ColorFilter
import android.graphics.Paint
import android.graphics.PixelFormat
import android.graphics.drawable.Drawable
import android.os.Build
import android.view.HapticFeedbackConstants
import android.view.View
import android.view.Window
import android.view.WindowInsets

/**
 * Edge-to-edge on every Android version (targetSdk 35 enforces it on Android 15): the page is laid
 * out between the bars and the keyboard, and the strips behind the status bar and the navigation
 * bar are painted by [BarsBackground] in the page's colours, because Android 15 ignores
 * statusBarColor / navigationBarColor.
 */
object SystemBars {
    /** Draw behind the bars ourselves. Android 8–10 keep the classic coloured bars. */
    @Suppress("DEPRECATION")
    fun edgeToEdge(window: Window) {
        if (Build.VERSION.SDK_INT < 30) return
        window.setDecorFitsSystemWindows(false)
        window.statusBarColor = android.graphics.Color.TRANSPARENT
        window.navigationBarColor = android.graphics.Color.TRANSPARENT
        // Our own strip under 3-button navigation already contrasts; no grey scrim on top of it.
        window.isNavigationBarContrastEnforced = false
        window.isStatusBarContrastEnforced = false
    }

    /**
     * Pads [container] for the bars, a display cutout and the keyboard, and consumes the insets so
     * the WebView does not pad again through env(safe-area-inset-*).
     */
    fun pad(container: View, background: BarsBackground) {
        container.setOnApplyWindowInsetsListener { v, insets ->
            if (Build.VERSION.SDK_INT >= 30) {
                val bars = insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout())
                val ime = insets.getInsets(WindowInsets.Type.ime())
                v.setPadding(bars.left, bars.top, bars.right, maxOf(bars.bottom, ime.bottom))
                background.top = bars.top
                background.invalidateSelf()
                WindowInsets.CONSUMED
            } else {
                @Suppress("DEPRECATION")
                v.setPadding(insets.systemWindowInsetLeft, insets.systemWindowInsetTop, insets.systemWindowInsetRight, insets.systemWindowInsetBottom)
                background.top = insets.systemWindowInsetTop
                background.invalidateSelf()
                @Suppress("DEPRECATION")
                insets.consumeSystemWindowInsets()
            }
        }
    }

    /**
     * Light feedback for a few moments (send, an answer, a long-press menu). performHapticFeedback
     * follows the system "touch feedback" setting; we never force it.
     */
    fun haptic(view: View, kind: String) {
        val constant = when (kind) {
            "confirm" -> if (Build.VERSION.SDK_INT >= 30) HapticFeedbackConstants.CONFIRM else HapticFeedbackConstants.VIRTUAL_KEY
            "long" -> HapticFeedbackConstants.LONG_PRESS
            "tick" -> HapticFeedbackConstants.CLOCK_TICK
            else -> return
        }
        view.performHapticFeedback(constant)
    }
}

/** Status-bar strip on top in [topColor], everything else (navigation bar, sides) in [bottomColor]. */
class BarsBackground : Drawable() {
    var top = 0
    var topColor = 0
    var bottomColor = 0
    private val paint = Paint()

    override fun draw(canvas: Canvas) {
        val b = bounds
        paint.color = bottomColor; canvas.drawRect(b, paint)
        if (top > 0) { paint.color = topColor; canvas.drawRect(b.left.toFloat(), b.top.toFloat(), b.right.toFloat(), (b.top + top).toFloat(), paint) }
    }
    override fun setAlpha(alpha: Int) {}
    override fun setColorFilter(colorFilter: ColorFilter?) {}
    @Deprecated("Deprecated in Java") override fun getOpacity() = PixelFormat.OPAQUE
}
