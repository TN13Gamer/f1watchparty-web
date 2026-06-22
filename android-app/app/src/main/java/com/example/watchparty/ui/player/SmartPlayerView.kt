package com.example.watchparty.ui.player

import android.app.Activity
import android.content.pm.ActivityInfo
import android.view.WindowManager
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Fullscreen
import androidx.compose.material.icons.filled.FullscreenExit
import androidx.compose.material.icons.filled.Pause
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.VolumeOff
import androidx.compose.material.icons.filled.VolumeUp
import androidx.compose.material3.Icon
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.compose.ui.window.DialogWindowProvider
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.PlayerView
import kotlinx.coroutines.delay

/**
 * Smart video player with tap-to-reveal controls:
 *  - Play / Pause (centre)
 *  - Mute / Unmute (bottom-right)
 *  - Fullscreen / Exit (bottom-right) — opens a Dialog that covers the ENTIRE screen,
 *    hides system bars, and rotates to landscape.
 */
@Composable
fun SmartPlayerView(
    exoPlayer: ExoPlayer,
    modifier: Modifier = Modifier
) {
    val context = LocalContext.current
    var showControls by remember { mutableStateOf(false) }
    var isPlaying  by remember { mutableStateOf(exoPlayer.isPlaying) }
    var isMuted    by remember { mutableStateOf(exoPlayer.volume == 0f) }
    var isFullscreen by remember { mutableStateOf(false) }

    // Keep isPlaying in sync
    DisposableEffect(exoPlayer) {
        val listener = object : Player.Listener {
            override fun onIsPlayingChanged(playing: Boolean) { isPlaying = playing }
        }
        exoPlayer.addListener(listener)
        onDispose { exoPlayer.removeListener(listener) }
    }

    // Auto-hide after 3 s
    LaunchedEffect(showControls) {
        if (showControls) { delay(3000); showControls = false }
    }

    // ── Normal (non-fullscreen) player ───────────────────────────────────────
    Box(modifier = modifier.clipToBounds()) {
        AndroidView(
            factory = { ctx ->
                PlayerView(ctx).apply { useController = false; player = exoPlayer }
            },
            modifier = Modifier.fillMaxSize()
        )
        // Tap layer
        Box(
            modifier = Modifier
                .fillMaxSize()
                .clickable(indication = null, interactionSource = remember { MutableInteractionSource() }) {
                    showControls = !showControls
                }
        )
        // Controls
        AnimatedVisibility(
            visible = (showControls || !isPlaying) && !isFullscreen,
            enter = fadeIn(tween(200)), exit = fadeOut(tween(300)),
            modifier = Modifier.fillMaxSize()
        ) {
            PlayerOverlay(
                isPlaying = isPlaying, isMuted = isMuted, isFullscreen = false,
                onPlayPause = { if (exoPlayer.isPlaying) exoPlayer.pause() else exoPlayer.play(); showControls = true },
                onMute      = { isMuted = !isMuted; exoPlayer.volume = if (isMuted) 0f else 1f; showControls = true },
                onFullscreen = { isFullscreen = true; showControls = false }
            )
        }
    }

    // ── Fullscreen Dialog — covers TopAppBar, tabs, and system bars ──────────
    if (isFullscreen) {
        Dialog(
            onDismissRequest = {
                isFullscreen = false
                (context as? Activity)?.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
            },
            properties = DialogProperties(
                usePlatformDefaultWidth  = false,
                decorFitsSystemWindows   = false,
                dismissOnBackPress       = true,
                dismissOnClickOutside    = false
            )
        ) {
            // Get the Dialog's own Window so we can hide system bars inside it
            val dialogWindow = (LocalView.current.parent as? DialogWindowProvider)?.window

            var showFsControls by remember { mutableStateOf(false) }
            LaunchedEffect(showFsControls) {
                if (showFsControls) { delay(3000); showFsControls = false }
            }

            // Set dialog window to truly fullscreen + hide system bars
            SideEffect {
                dialogWindow?.apply {
                    setLayout(WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.MATCH_PARENT)
                    WindowCompat.setDecorFitsSystemWindows(this, false)
                    val ctrl = WindowInsetsControllerCompat(this, decorView)
                    ctrl.hide(WindowInsetsCompat.Type.systemBars())
                    ctrl.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
                }
            }

            // Rotate to landscape once
            LaunchedEffect(Unit) {
                (context as? Activity)?.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
            }

            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .background(Color.Black)
            ) {
                // Player fills the dialog
                AndroidView(
                    factory = { ctx ->
                        PlayerView(ctx).apply { useController = false; player = exoPlayer }
                    },
                    modifier = Modifier.fillMaxSize()
                )

                // Tap layer
                Box(
                    modifier = Modifier
                        .fillMaxSize()
                        .clickable(indication = null, interactionSource = remember { MutableInteractionSource() }) {
                            showFsControls = !showFsControls
                        }
                )

                // Controls overlay
                AnimatedVisibility(
                    visible = showFsControls || !isPlaying,
                    enter = fadeIn(tween(200)), exit = fadeOut(tween(300)),
                    modifier = Modifier.fillMaxSize()
                ) {
                    PlayerOverlay(
                        isPlaying = isPlaying, isMuted = isMuted, isFullscreen = true,
                        onPlayPause = { if (exoPlayer.isPlaying) exoPlayer.pause() else exoPlayer.play(); showFsControls = true },
                        onMute      = { isMuted = !isMuted; exoPlayer.volume = if (isMuted) 0f else 1f; showFsControls = true },
                        onFullscreen = {
                            isFullscreen = false
                            (context as? Activity)?.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
                        }
                    )
                }
            }
        }
    }
}

// ── Shared controls overlay ──────────────────────────────────────────────────
@Composable
private fun PlayerOverlay(
    isPlaying: Boolean,
    isMuted: Boolean,
    isFullscreen: Boolean,
    onPlayPause: () -> Unit,
    onMute: () -> Unit,
    onFullscreen: () -> Unit
) {
    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(Color.Black.copy(alpha = 0.35f))
    ) {
        // Play / Pause — centre
        CircleIconButton(
            icon = if (isPlaying) Icons.Filled.Pause else Icons.Filled.PlayArrow,
            size = 64,
            iconSize = 36,
            onClick = onPlayPause,
            modifier = Modifier.align(Alignment.Center)
        )

        // Bottom-right row
        Row(
            modifier = Modifier
                .align(Alignment.BottomEnd)
                .padding(end = 12.dp, bottom = 12.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            CircleIconButton(
                icon = if (isMuted) Icons.Filled.VolumeOff else Icons.Filled.VolumeUp,
                size = 40,
                iconSize = 22,
                onClick = onMute
            )
            CircleIconButton(
                icon = if (isFullscreen) Icons.Filled.FullscreenExit else Icons.Filled.Fullscreen,
                size = 40,
                iconSize = 22,
                onClick = onFullscreen
            )
        }
    }
}

@Composable
private fun CircleIconButton(
    icon: ImageVector,
    size: Int,
    iconSize: Int,
    onClick: () -> Unit,
    modifier: Modifier = Modifier
) {
    Box(
        modifier = modifier
            .size(size.dp)
            .background(Color.Black.copy(alpha = 0.65f), CircleShape)
            .clickable(indication = null, interactionSource = remember { MutableInteractionSource() }) { onClick() },
        contentAlignment = Alignment.Center
    ) {
        Icon(imageVector = icon, contentDescription = null, tint = Color.White, modifier = Modifier.size(iconSize.dp))
    }
}
