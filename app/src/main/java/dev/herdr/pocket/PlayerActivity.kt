package dev.herdr.pocket

import android.app.Activity
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ActivityInfo
import android.content.res.Configuration
import android.graphics.Color
import android.graphics.SurfaceTexture
import android.graphics.drawable.GradientDrawable
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.MediaPlayer
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.Surface
import android.view.TextureView
import android.view.View
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.SeekBar
import android.widget.TextView
import android.widget.Toast
import org.json.JSONObject
import java.io.File

/**
 * 视频/音频 in-app player for one complete [MediaPreview] cache file.
 *
 * Native on purpose: the WebView never gets a `<video>`/`<audio>` element, `media-src`, or a media
 * URL, and no streaming/Range behaviour is assumed. MediaPlayer reads the private cache file that
 * the page already downloaded with real progress; [MediaPreview.pin] keeps that file alive while the
 * player is open. v1: no background audio, no PiP, no subtitles.
 */
class PlayerActivity : Activity() {
    companion object {
        const val EXTRA_KEY = "key"
        private const val SEEK_MAX = 1000
    }

    private lateinit var root: FrameLayout
    private lateinit var stage: FrameLayout
    private lateinit var texture: TextureView
    private lateinit var poster: ImageView
    private lateinit var topBar: LinearLayout
    private lateinit var controls: LinearLayout
    private lateinit var centerPlay: TextView
    private lateinit var playBtn: TextView
    private lateinit var muteBtn: TextView
    private lateinit var rotateBtn: TextView
    private lateinit var fullBtn: TextView
    private lateinit var title: TextView
    private lateinit var elapsed: TextView
    private lateinit var total: TextView
    private lateinit var seek: SeekBar
    private lateinit var fallback: LinearLayout
    private lateinit var fallbackText: TextView

    private lateinit var key: String
    private lateinit var file: File
    private lateinit var name: String
    private var isVideo = true

    private var player: MediaPlayer? = null
    private var surface: Surface? = null
    private var prepared = false
    private var playing = false
    private var dragging = false
    private var durationMs = 0L
    private var pendingSeek = 0L
    private var pendingPlay = true
    private var muted = false
    private var immersive = true
    private var landscapeButton = false
    private var pausedForFocus = false
    private var noisy: BroadcastReceiver? = null
    private var focusRequest: AudioFocusRequest? = null
    private val handler = Handler(Looper.getMainLooper())

    private val attributes: AudioAttributes by lazy {
        AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA)
            .setContentType(if (isVideo) AudioAttributes.CONTENT_TYPE_MOVIE else AudioAttributes.CONTENT_TYPE_MUSIC).build()
    }

    private val focusListener = AudioManager.OnAudioFocusChangeListener { change ->
        runOnUiThread {
            when (change) {
                AudioManager.AUDIOFOCUS_LOSS -> { pausedForFocus = false; pause() }
                AudioManager.AUDIOFOCUS_LOSS_TRANSIENT -> { pausedForFocus = playing; pause() }
                AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK -> player?.setVolume(if (muted) 0f else 0.2f, if (muted) 0f else 0.2f)
                AudioManager.AUDIOFOCUS_GAIN -> {
                    player?.setVolume(if (muted) 0f else 1f, if (muted) 0f else 1f)
                    if (pausedForFocus) { pausedForFocus = false; startPlayback() }
                }
            }
        }
    }

    private val ticker = object : Runnable {
        override fun run() {
            val mp = player
            if (mp != null && prepared && !dragging) {
                val at = try { mp.currentPosition.toLong() } catch (_: Exception) { 0L }
                paintPosition(at)
            }
            handler.postDelayed(this, 400)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val k = intent.getStringExtra(EXTRA_KEY)
        val f = if (k != null) MediaPreview.fileFor(this, k) else null
        if (k == null || f == null) { toast("缓存已过期，重新打开文件预览"); finish(); return }
        key = k; file = f
        val meta = MediaPreview.meta(this, k) ?: JSONObject()
        val media = meta.optJSONObject("media") ?: JSONObject()
        name = meta.optString("name").takeIf { it.isNotBlank() } ?: MediaPreview.nameOf(this, k)
        isVideo = media.optString("kind", MediaPreview.kindOf(name, meta.optString("mime"))) != "audio"
        MediaPreview.pin(k)
        applyWindow()
        buildUi(meta)
        showPoster()
        if (isVideo) {
            texture.surfaceTextureListener = object : TextureView.SurfaceTextureListener {
                override fun onSurfaceTextureAvailable(st: SurfaceTexture, width: Int, height: Int) { openPlayer(st) }
                override fun onSurfaceTextureSizeChanged(st: SurfaceTexture, width: Int, height: Int) { }
                override fun onSurfaceTextureDestroyed(st: SurfaceTexture): Boolean {
                    pendingSeek = try { player?.currentPosition?.toLong() ?: 0L } catch (_: Exception) { 0L }
                    pendingPlay = playing
                    releasePlayer(); return true
                }
                override fun onSurfaceTextureUpdated(st: SurfaceTexture) { }
            }
            if (texture.isAvailable) openPlayer(texture.surfaceTexture)
        } else {
            texture.visibility = View.GONE
            poster.visibility = View.VISIBLE
            openPlayer(null)
        }
        handler.post(ticker)
    }

    private fun applyWindow() {
        window.setBackgroundDrawable(android.graphics.drawable.ColorDrawable(Color.BLACK))
        window.statusBarColor = Color.BLACK
        window.navigationBarColor = Color.BLACK
        if (Build.VERSION.SDK_INT >= 30) {
            window.insetsController?.setSystemBarsAppearance(0,
                WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS or WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS)
        } else {
            @Suppress("DEPRECATION")
            window.decorView.systemUiVisibility = 0
        }
        applyImmersive()
    }

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()

    private fun pill(bg: Int, radius: Int = 18): GradientDrawable = GradientDrawable().apply {
        shape = GradientDrawable.RECTANGLE; cornerRadius = dp(radius).toFloat(); setColor(bg)
    }

    private fun textButton(label: String, description: String, bg: Int = 0x66000000): TextView = TextView(this).apply {
        text = label
        textSize = 14f
        gravity = Gravity.CENTER
        setTextColor(Color.WHITE)
        setPadding(dp(14), dp(9), dp(14), dp(9))
        background = pill(bg)
        isClickable = true
        isFocusable = true
        contentDescription = description
    }

    private fun buildUi(meta: JSONObject) {
        root = FrameLayout(this).apply { setBackgroundColor(Color.BLACK) }
        setContentView(root)
        stage = FrameLayout(this)
        root.addView(stage, FrameLayout.LayoutParams(-1, -1))
        texture = TextureView(this)
        stage.addView(texture, FrameLayout.LayoutParams(-1, -1))
        poster = ImageView(this).apply { scaleType = ImageView.ScaleType.FIT_CENTER; visibility = View.GONE }
        stage.addView(poster, FrameLayout.LayoutParams(-1, -1))

        centerPlay = TextView(this).apply {
            text = "▶"; textSize = 30f; gravity = Gravity.CENTER; setTextColor(Color.WHITE)
            setPadding(dp(18), dp(10), dp(18), dp(10)); background = pill(0x77000000, 40)
            contentDescription = "播放"
            setOnClickListener { toggle() }
        }
        stage.addView(centerPlay, FrameLayout.LayoutParams(dp(72), dp(72), Gravity.CENTER))

        topBar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(8), dp(8), dp(12), dp(8)); background = pill(0x55000000, 0)
        }
        val back = TextView(this).apply {
            text = "‹"; textSize = 30f; gravity = Gravity.CENTER; setTextColor(Color.WHITE)
            setPadding(dp(12), 0, dp(12), dp(4)); contentDescription = "返回"
            setOnClickListener { finish() }
        }
        topBar.addView(back, LinearLayout.LayoutParams(dp(48), dp(48)))
        title = TextView(this).apply {
            text = name; textSize = 15f; setTextColor(Color.WHITE); maxLines = 1; ellipsize = android.text.TextUtils.TruncateAt.END
        }
        topBar.addView(title, LinearLayout.LayoutParams(0, -2, 1f))
        root.addView(topBar, FrameLayout.LayoutParams(-1, -2, Gravity.TOP))

        controls = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL; setPadding(dp(14), dp(8), dp(14), dp(18)); background = pill(0x88000000.toInt(), 0)
        }
        val seekRow = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
        elapsed = TextView(this).apply { text = "0:00"; textSize = 12f; setTextColor(Color.WHITE); setPadding(0, 0, dp(8), 0) }
        total = TextView(this).apply { text = "0:00"; textSize = 12f; setTextColor(Color.WHITE); setPadding(dp(8), 0, 0, 0) }
        seek = SeekBar(this).apply {
            max = SEEK_MAX
            progressTintList = android.content.res.ColorStateList.valueOf(Color.WHITE)
            thumbTintList = android.content.res.ColorStateList.valueOf(Color.WHITE)
        }
        seekRow.addView(elapsed, LinearLayout.LayoutParams(-2, -2))
        seekRow.addView(seek, LinearLayout.LayoutParams(0, -2, 1f))
        seekRow.addView(total, LinearLayout.LayoutParams(-2, -2))
        controls.addView(seekRow, LinearLayout.LayoutParams(-1, -2))
        val buttons = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER }
        playBtn = textButton("暂停", "播放或暂停")
        muteBtn = textButton("静音", "静音或取消静音")
        rotateBtn = textButton("旋转", "旋转屏幕")
        fullBtn = textButton("退出全屏", "全屏或退出全屏")
        for (b in listOf(playBtn, muteBtn, rotateBtn, fullBtn)) {
            val lp = LinearLayout.LayoutParams(-2, -2).apply { marginEnd = dp(6) }
            buttons.addView(b, lp)
        }
        controls.addView(buttons, LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(4) })
        root.addView(controls, FrameLayout.LayoutParams(-1, -2, Gravity.BOTTOM))
        stage.setOnClickListener { toggleControls() }

        fallback = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL; gravity = Gravity.CENTER; visibility = View.GONE
            setPadding(dp(28), dp(28), dp(28), dp(28)); background = pill(0x99000000.toInt(), 0)
        }
        fallbackText = TextView(this).apply {
            textSize = 15f; setTextColor(Color.WHITE); gravity = Gravity.CENTER
            setPadding(0, 0, 0, dp(16))
        }
        fallback.addView(fallbackText, LinearLayout.LayoutParams(-1, -2))
        fallback.addView(textButton("用其他应用打开", "用其他应用打开").apply {
            setOnClickListener { external(false) }
        }, LinearLayout.LayoutParams(-2, -2).apply { gravity = Gravity.CENTER_HORIZONTAL; topMargin = dp(4) })
        fallback.addView(textButton("分享", "分享").apply {
            setOnClickListener { external(true) }
        }, LinearLayout.LayoutParams(-2, -2).apply { gravity = Gravity.CENTER_HORIZONTAL; topMargin = dp(4) })
        fallback.addView(textButton("返回", "返回文件预览").apply {
            setOnClickListener { finish() }
        }, LinearLayout.LayoutParams(-2, -2).apply { gravity = Gravity.CENTER_HORIZONTAL; topMargin = dp(4) })
        root.addView(fallback, FrameLayout.LayoutParams(-1, -2, Gravity.CENTER))

        playBtn.setOnClickListener { toggle() }
        muteBtn.setOnClickListener { toggleMute() }
        rotateBtn.setOnClickListener { toggleRotation() }
        fullBtn.setOnClickListener {
            immersive = !immersive; applyImmersive()
            fullBtn.text = if (immersive) "退出全屏" else "全屏"
            fullBtn.contentDescription = fullBtn.text
        }

        seek.setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
            override fun onProgressChanged(bar: SeekBar, progress: Int, fromUser: Boolean) {
                if (fromUser && durationMs > 0) elapsed.text = time(progress * durationMs / SEEK_MAX)
            }
            override fun onStartTrackingTouch(bar: SeekBar) { dragging = true }
            override fun onStopTrackingTouch(bar: SeekBar) {
                dragging = false
                if (durationMs > 0) player?.seekTo((bar.progress.toLong() * durationMs / SEEK_MAX).toInt())
            }
        })

        val media = meta.optJSONObject("media") ?: JSONObject()
        val subtitle = listOfNotNull(media.optString("artist").takeIf { it.isNotBlank() }, media.optString("album").takeIf { it.isNotBlank() })
        if (subtitle.isNotEmpty()) title.text = "$name · ${subtitle.joinToString(" · ")}"
        val d = media.optLong("durationMs", 0L)
        if (d > 0) { durationMs = d; total.text = time(d) }
    }

    private fun showPoster() {
        val f = MediaPreview.posterFor(this, key) ?: return
        try { poster.setImageBitmap(android.graphics.BitmapFactory.decodeFile(f.path)) } catch (_: Throwable) { }
        poster.visibility = View.VISIBLE
    }

    private fun toggleControls() {
        if (fallback.visibility == View.VISIBLE) return
        val show = controls.visibility != View.VISIBLE
        controls.visibility = if (show) View.VISIBLE else View.GONE
        topBar.visibility = if (show) View.VISIBLE else View.GONE
        centerPlay.visibility = if (show && prepared) View.VISIBLE else View.GONE
    }

    private fun openPlayer(surfaceTexture: SurfaceTexture?) {
        releasePlayer()
        val resume = pendingSeek
        val autoPlay = pendingPlay
        val mp = MediaPlayer()
        player = mp
        try {
            mp.setAudioAttributes(attributes)
            mp.setDataSource(file.path)
            if (surfaceTexture != null) {
                surface = Surface(surfaceTexture)
                mp.setSurface(surface)
            }
            mp.setOnPreparedListener { it ->
                prepared = true
                durationMs = try { it.duration.toLong().coerceAtLeast(0L) } catch (_: Exception) { 0L }
                total.text = time(durationMs)
                seek.progress = 0
                if (resume > 0 && durationMs > 0) it.seekTo(resume.toInt())
                it.setVolume(if (muted) 0f else 1f, if (muted) 0f else 1f)
                if (autoPlay) {
                    requestFocus()
                    it.start()
                    playing = true
                    keepScreenOn(true)
                }
                paintPlayState()
                centerPlay.visibility = if (controls.visibility == View.VISIBLE) View.VISIBLE else View.GONE
                // Video artwork is only a placeholder until the first frame; audio keeps its poster.
                if (isVideo && MediaPreview.posterFor(this, key) != null) poster.visibility = View.GONE
            }
            mp.setOnCompletionListener {
                playing = false
                pendingSeek = 0
                pendingPlay = false
                paintPlayState()
                keepScreenOn(false)
                seek.progress = SEEK_MAX
                elapsed.text = time(durationMs)
            }
            mp.setOnErrorListener { _, _, _ ->
                showFallback("这个文件的编码手机播放不了，或者文件已经损坏。可以用其他应用打开或分享；也可以回到文件页下载到手机再试。")
                true
            }
            mp.prepareAsync()
        } catch (e: Exception) {
            showFallback("这个文件手机播放不了（${e.message ?: "格式不支持"}）。可以用其他应用打开或分享。")
        }
    }

    private fun releasePlayer() {
        prepared = false
        playing = false
        val mp = player
        player = null
        if (mp != null) {
            try { mp.setOnPreparedListener(null); mp.setOnCompletionListener(null); mp.setOnErrorListener(null) } catch (_: Exception) { }
            try { if (mp.isPlaying) mp.stop() } catch (_: Exception) { }
            try { mp.setSurface(null) } catch (_: Exception) { }
            try { mp.reset() } catch (_: Exception) { }
            try { mp.release() } catch (_: Exception) { }
        }
        surface?.release(); surface = null
        keepScreenOn(false)
    }

    private fun startPlayback() {
        val mp = player ?: return
        if (!prepared) return
        requestFocus()
        try { mp.start() } catch (_: Exception) { showFallback("这个文件手机播放不了。可以用其他应用打开或分享。"); return }
        playing = true
        pendingPlay = true
        paintPlayState()
        keepScreenOn(true)
    }

    private fun pause() {
        val mp = player ?: return
        if (prepared && mp.isPlaying) try { mp.pause() } catch (_: Exception) { }
        playing = false
        pendingPlay = false
        paintPlayState()
        keepScreenOn(false)
    }

    private fun toggle() {
        if (!prepared) return
        if (playing) pause() else startPlayback()
    }

    private fun paintPlayState() {
        val label = if (playing) "暂停" else "播放"
        playBtn.text = label
        centerPlay.text = if (playing) "❚❚" else "▶"
        centerPlay.contentDescription = label
        if (prepared) centerPlay.visibility = if (controls.visibility == View.VISIBLE) View.VISIBLE else View.GONE
    }

    private fun paintPosition(ms: Long) {
        elapsed.text = time(ms)
        if (durationMs > 0) seek.progress = (ms.coerceIn(0, durationMs) * SEEK_MAX / durationMs).toInt()
    }

    private fun toggleMute() {
        muted = !muted
        player?.setVolume(if (muted) 0f else 1f, if (muted) 0f else 1f)
        muteBtn.text = if (muted) "取消静音" else "静音"
        muteBtn.contentDescription = muteBtn.text
    }

    private fun toggleRotation() {
        // Based on what is on screen now, so a manual rotation does not flip the button's meaning.
        val nowLandscape = resources.configuration.orientation == Configuration.ORIENTATION_LANDSCAPE
        landscapeButton = !nowLandscape
        requestedOrientation = if (landscapeButton) ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE else ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
        rotateBtn.text = if (landscapeButton) "竖屏" else "旋转"
        rotateBtn.contentDescription = if (landscapeButton) "恢复竖屏" else "旋转屏幕"
    }

    private fun keepScreenOn(on: Boolean) {
        if (on) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    }

    private fun requestFocus() {
        val am = getSystemService(AudioManager::class.java) ?: return
        if (focusRequest == null) {
            focusRequest = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
                .setAudioAttributes(attributes)
                .setOnAudioFocusChangeListener(focusListener, handler)
                .build()
        }
        am.requestAudioFocus(focusRequest!!)
    }

    private fun abandonFocus() {
        val am = getSystemService(AudioManager::class.java) ?: return
        focusRequest?.let { try { am.abandonAudioFocusRequest(it) } catch (_: Exception) { } }
        focusRequest = null
    }

    private fun applyImmersive() {
        if (Build.VERSION.SDK_INT >= 30) {
            val c = window.insetsController ?: return
            if (immersive) {
                c.systemBarsBehavior = WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
                c.hide(WindowInsets.Type.systemBars())
            } else c.show(WindowInsets.Type.systemBars())
        } else {
            @Suppress("DEPRECATION")
            window.decorView.systemUiVisibility = if (immersive)
                (View.SYSTEM_UI_FLAG_FULLSCREEN or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY or
                    View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION or View.SYSTEM_UI_FLAG_LAYOUT_STABLE)
            else 0
        }
    }

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        // configChanges keeps this activity alive; the surface and player keep running.
        if (::rotateBtn.isInitialized) {
            val nowLandscape = newConfig.orientation == Configuration.ORIENTATION_LANDSCAPE
            landscapeButton = nowLandscape
            rotateBtn.text = if (nowLandscape) "竖屏" else "旋转"
        }
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) applyImmersive()
    }

    override fun onResume() {
        super.onResume()
        if (noisy == null) {
            val receiver = object : BroadcastReceiver() {
                override fun onReceive(context: Context?, intent: Intent?) {
                    if (intent?.action == AudioManager.ACTION_AUDIO_BECOMING_NOISY) pause()
                }
            }
            val filter = IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY)
            try {
                if (Build.VERSION.SDK_INT >= 33) registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED)
                else @Suppress("DEPRECATION") registerReceiver(receiver, filter)
                noisy = receiver
            } catch (_: Exception) { }
        }
    }

    override fun onPause() {
        pause()
        noisy?.let { try { unregisterReceiver(it) } catch (_: Exception) { } }
        noisy = null
        super.onPause()
    }

    override fun onDestroy() {
        handler.removeCallbacksAndMessages(null)
        releasePlayer()
        abandonFocus()
        if (::key.isInitialized) MediaPreview.unpin(key)
        super.onDestroy()
    }

    private fun showFallback(message: String) {
        releasePlayer()
        fallbackText.text = message
        fallback.visibility = View.VISIBLE
        controls.visibility = View.GONE
        topBar.visibility = View.VISIBLE
        centerPlay.visibility = View.GONE
    }

    private fun external(share: Boolean) {
        try { startActivity(MediaPreview.intent(this, key, share)) }
        catch (e: Exception) { toast(if (share) "手机上没有能分享的应用" else "手机上没有能打开这种文件的应用") }
    }

    private fun toast(message: String) { Toast.makeText(this, message, Toast.LENGTH_LONG).show() }

    private fun time(ms: Long): String {
        val s = (ms / 1000).coerceAtLeast(0)
        return if (s >= 3600) "%d:%02d:%02d".format(s / 3600, (s % 3600) / 60, s % 60)
        else "%d:%02d".format(s / 60, s % 60)
    }
}
