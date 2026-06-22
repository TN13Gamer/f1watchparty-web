package com.example.watchparty.ui.splash

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.layout.ContentScale
import com.airbnb.lottie.compose.*
import com.example.watchparty.R
import kotlinx.coroutines.delay

@Composable
fun SplashScreen(
    onAnimationFinished: () -> Unit,
    modifier: Modifier = Modifier
) {
    var hasNavigated by remember { mutableStateOf(false) }

    fun safeNavigate() {
        if (!hasNavigated) {
            hasNavigated = true
            onAnimationFinished()
        }
    }

    val composition by rememberLottieComposition(LottieCompositionSpec.RawRes(R.raw.fia))
    val progress by animateLottieCompositionAsState(
        composition = composition,
        iterations = 1
    )

    // Navigate to main screen when animation completes
    LaunchedEffect(progress) {
        if (progress == 1.0f) {
            safeNavigate()
        }
    }

    // Safety timeout: if composition is null or slow, force navigate after 3.5 seconds
    LaunchedEffect(Unit) {
        delay(3500)
        safeNavigate()
    }

    Box(
        modifier = modifier
            .fillMaxSize()
            .background(Color.Black),
        contentAlignment = Alignment.Center
    ) {
        LottieAnimation(
            composition = composition,
            progress = { progress },
            contentScale = ContentScale.Fit,
            modifier = Modifier.fillMaxSize(0.85f)
        )
    }
}
