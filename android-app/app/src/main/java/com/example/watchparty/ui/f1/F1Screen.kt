package com.example.watchparty.ui.f1

import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.shape.CircleShape
import coil.compose.AsyncImage
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.List
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.RectangleShape
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.animation.*
import androidx.compose.animation.core.*
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.layout.ContentScale
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.common.PlaybackException
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.hls.HlsMediaSource
import androidx.media3.ui.PlayerView
import com.airbnb.lottie.compose.*
import com.example.watchparty.R
import com.example.watchparty.data.*
import com.example.watchparty.ui.player.SmartPlayerView
import com.example.watchparty.ui.utils.bounceClick
import java.text.SimpleDateFormat
import java.util.*
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun F1Screen(
    onBackClick: () -> Unit,
    modifier: Modifier = Modifier
) {
    val context = LocalContext.current
    var liveConfig by remember { mutableStateOf<LiveConfig?>(null) }
    var selectedStreamUrl by remember { mutableStateOf("") }
    var selectedStreamTitle by remember { mutableStateOf("No Stream Selected") }
    var activeTab by remember { mutableIntStateOf(0) }
    var isLoading by remember { mutableStateOf(true) }
    // Resolved stream — null means still resolving
    var resolvedStream by remember { mutableStateOf<ResolvedStream?>(null) }
    var visible by remember { mutableStateOf(false) }
    var popupMessage by remember { mutableStateOf<android.os.Message?>(null) }

    // Load LiveConfig
    LaunchedEffect(Unit) {
        isLoading = true
        val config = ApiDataFetcher.fetchLiveConfig(context)
        liveConfig = config
        if (config != null && config.streamLinks.isNotEmpty()) {
            selectedStreamUrl = config.streamLinks[0].url
            selectedStreamTitle = config.streamLinks[0].name
        }
        isLoading = false
    }

    // Resolve stream URL whenever selectedStreamUrl changes
    LaunchedEffect(selectedStreamUrl) {
        if (selectedStreamUrl.isNotEmpty()) {
            resolvedStream = null // show loading while resolving
            resolvedStream = ApiDataFetcher.resolveStreamUrl(selectedStreamUrl)
        }
    }

    if (isLoading) {
        val composition by rememberLottieComposition(LottieCompositionSpec.RawRes(R.raw.fia))
        val progress by animateLottieCompositionAsState(
            composition = composition,
            iterations = LottieConstants.IterateForever
        )
        Box(
            modifier = Modifier
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
    } else {
        LaunchedEffect(Unit) {
            visible = true
        }
        Scaffold(
            containerColor = Color.Transparent,
            modifier = modifier
                .fillMaxSize()
                .background(Color(0xFF050505))
                .drawBehind {
                    // 1. Mesh Grid Overlay
                    val stepPx = 50.dp.toPx()
                    val lineColor = Color.White.copy(alpha = 0.015f)
                    val strokeWidth = 1.dp.toPx()

                    var x = 0f
                    while (x < size.width) {
                        drawLine(
                            color = lineColor,
                            start = Offset(x, 0f),
                            end = Offset(x, size.height),
                            strokeWidth = strokeWidth
                        )
                        x += stepPx
                    }

                    var y = 0f
                    while (y < size.height) {
                        drawLine(
                            color = lineColor,
                            start = Offset(0f, y),
                            end = Offset(size.width, y),
                            strokeWidth = strokeWidth
                        )
                        y += stepPx
                    }

                    // 2. Ambient Red Glow (Top-Left)
                    drawCircle(
                        brush = Brush.radialGradient(
                            colors = listOf(
                                Color(0xFFE60000).copy(alpha = 0.12f),
                                Color.Transparent
                            ),
                            center = Offset(-150.dp.toPx(), -200.dp.toPx()),
                            radius = 500.dp.toPx()
                        ),
                        radius = 500.dp.toPx(),
                        center = Offset(-150.dp.toPx(), -200.dp.toPx())
                    )

                    // 3. Ambient Silver/White Glow (Bottom-Right)
                    drawCircle(
                        brush = Brush.radialGradient(
                            colors = listOf(
                                Color.White.copy(alpha = 0.06f),
                                Color.Transparent
                            ),
                            center = Offset(size.width + 150.dp.toPx(), size.height + 200.dp.toPx()),
                            radius = 500.dp.toPx()
                        ),
                        radius = 500.dp.toPx(),
                        center = Offset(size.width + 150.dp.toPx(), size.height + 200.dp.toPx())
                    )
                }
        ) { paddingValues ->
            AnimatedVisibility(
                visible = visible,
                enter = slideInVertically(
                    animationSpec = spring(
                        dampingRatio = Spring.DampingRatioLowBouncy,
                        stiffness = Spring.StiffnessLow
                    )
                ) { 150 } + fadeIn(animationSpec = tween(800)),
                modifier = Modifier.fillMaxSize()
            ) {
                Column(
                    modifier = Modifier
                        .fillMaxSize()
                        .padding(paddingValues)
                ) {
                // TopAppBar inside Column to prevent WebView from ever drawing on top of it
                TopAppBar(
                    title = {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text("F1 WATCH PARTY", fontWeight = FontWeight.Bold, fontSize = 20.sp)
                            Spacer(modifier = Modifier.width(8.dp))
                            Box(
                                modifier = Modifier
                                    .size(8.dp)
                                    .clip(RoundedCornerShape(4.dp))
                                    .background(Color(0xFFE60000)) // Pulse F1 Red dot
                            )
                        }
                    },
                    navigationIcon = {
                        IconButton(onClick = onBackClick) {
                            Icon(imageVector = Icons.Default.ArrowBack, contentDescription = "Back", tint = Color.White)
                        }
                    },
                    colors = TopAppBarDefaults.topAppBarColors(
                        containerColor = Color.Transparent,
                        titleContentColor = Color.White
                    )
                )

                // Live Stream Player — smart player: ExoPlayer for HLS, WebView for iframe embeds
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(230.dp)
                        .background(Color.Black)
                ) {
                    if (selectedStreamUrl.isEmpty()) {
                        Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                            Text("No stream is currently broadcasting.", color = Color.Gray, fontSize = 14.sp)
                        }
                    } else if (resolvedStream == null) {
                        // Resolving the stream URL (calling pushembdz API)
                        Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                            CircularProgressIndicator(color = Color(0xFFE60000), modifier = Modifier.size(36.dp))
                        }
                    } else if (resolvedStream!!.playerType == PlayerType.EXOPLAYER) {
                        // Native ExoPlayer for HLS m3u8 streams — reliable, no WebView quirks
                        val streamUrl = resolvedStream!!.url
                        val referer = resolvedStream!!.referer
                        val exoPlayer = remember(streamUrl) {
                            val dataSourceFactory = DefaultHttpDataSource.Factory()
                                .setUserAgent("Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36")
                                .setDefaultRequestProperties(
                                    if (referer.isNotEmpty()) mapOf(
                                        "Referer" to referer,
                                        "Origin" to referer.trimEnd('/')
                                    ) else emptyMap()
                                )
                            val hlsSource = HlsMediaSource.Factory(dataSourceFactory)
                                .createMediaSource(MediaItem.fromUri(streamUrl))
                            ExoPlayer.Builder(context).build().apply {
                                setMediaSource(hlsSource)
                                prepare()
                                playWhenReady = true
                                addListener(object : Player.Listener {
                                    override fun onPlayerError(error: PlaybackException) {
                                        android.util.Log.e("ExoPlayer", "Playback error: ${error.message} cause=${error.cause?.message}")
                                    }
                                    override fun onPlaybackStateChanged(state: Int) {
                                        val stateName = when(state) {
                                            Player.STATE_IDLE -> "IDLE"
                                            Player.STATE_BUFFERING -> "BUFFERING"
                                            Player.STATE_READY -> "READY"
                                            Player.STATE_ENDED -> "ENDED"
                                            else -> "UNKNOWN"
                                        }
                                        android.util.Log.d("ExoPlayer", "State -> $stateName for $streamUrl")
                                    }
                                })
                            }
                        }
                        DisposableEffect(streamUrl) {
                            onDispose { exoPlayer.release() }
                        }
                        SmartPlayerView(
                            exoPlayer = exoPlayer,
                            modifier = Modifier.fillMaxSize()
                        )
                    } else {
                        // WebView iframe fallback for non-HLS embed players
                        val webUrl = resolvedStream!!.url
                        val sandboxRemovalJs = """
                            (function() {
                                function removeSandbox() {
                                    var iframes = document.getElementsByTagName('iframe');
                                    for (var i = 0; i < iframes.length; i++) {
                                        if (iframes[i].hasAttribute('sandbox')) {
                                            iframes[i].removeAttribute('sandbox');
                                            console.log('Android WebView: Removed sandbox attribute from iframe:', iframes[i].src);
                                        }
                                    }
                                }
                                
                                try {
                                    var originalSetAttr = HTMLIFrameElement.prototype.setAttribute;
                                    HTMLIFrameElement.prototype.setAttribute = function(name, val) {
                                        if (name.toLowerCase() === 'sandbox') {
                                            console.log('Android WebView: Intercepted and blocked setAttribute(sandbox)');
                                            this.removeAttribute('sandbox');
                                            return;
                                        }
                                        originalSetAttr.call(this, name, val);
                                    };
                                    
                                    Object.defineProperty(HTMLIFrameElement.prototype, 'sandbox', {
                                        get: function() {
                                            return this.getAttribute('sandbox') || '';
                                        },
                                        set: function(val) {
                                            console.log('Android WebView: Intercepted and blocked sandbox property setter');
                                            this.removeAttribute('sandbox');
                                        },
                                        configurable: true,
                                        enumerable: true
                                    });
                                } catch(e) { console.error('Android WebView: error setting up sandbox overrides', e); }

                                removeSandbox();

                                function initObserver() {
                                    if (document.documentElement) {
                                        var observer = new MutationObserver(function(mutations) {
                                            removeSandbox();
                                        });
                                        observer.observe(document.documentElement, {
                                            childList: true,
                                            subtree: true
                                        });
                                    } else {
                                        setTimeout(initObserver, 50);
                                    }
                                }
                                initObserver();
                            })();
                        """.trimIndent()

                        AndroidView(
                            factory = { ctx ->
                                WebView(ctx).apply {
                                    settings.javaScriptEnabled = true
                                    settings.domStorageEnabled = true
                                    settings.databaseEnabled = true
                                    settings.mediaPlaybackRequiresUserGesture = false
                                    settings.userAgentString = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
                                    settings.mixedContentMode = android.webkit.WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
                                    settings.useWideViewPort = true
                                    settings.loadWithOverviewMode = true
                                    settings.javaScriptCanOpenWindowsAutomatically = true
                                    settings.setSupportMultipleWindows(true)
                                    android.webkit.CookieManager.getInstance().setAcceptCookie(true)
                                    android.webkit.CookieManager.getInstance().setAcceptThirdPartyCookies(this, true)

                                    if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
                                        try {
                                            WebViewCompat.addDocumentStartJavaScript(this, sandboxRemovalJs, setOf("*"))
                                        } catch (e: Exception) {
                                            android.util.Log.e("WebView", "Error adding document start script", e)
                                        }
                                    }

                                    webViewClient = object : WebViewClient() {
                                        override fun onReceivedSslError(view: WebView?, handler: android.webkit.SslErrorHandler?, error: android.net.http.SslError?) {
                                            handler?.proceed()
                                        }
                                        override fun onPageStarted(view: WebView?, url: String?, favicon: android.graphics.Bitmap?) {
                                            super.onPageStarted(view, url, favicon)
                                            view?.evaluateJavascript(sandboxRemovalJs, null)
                                        }
                                        override fun onPageFinished(view: WebView?, url: String?) {
                                            super.onPageFinished(view, url)
                                            view?.evaluateJavascript(sandboxRemovalJs, null)
                                        }
                                        override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
                                            val url = request?.url?.toString() ?: return false
                                            if (url.startsWith("http://") || url.startsWith("https://")) {
                                                view?.loadUrl(url)
                                                return true
                                            }
                                            try {
                                                val intent = android.content.Intent.parseUri(url, android.content.Intent.URI_INTENT_SCHEME)
                                                view?.context?.startActivity(intent)
                                            } catch (e: Exception) {}
                                            return true
                                        }
                                    }

                                    webChromeClient = object : WebChromeClient() {
                                        override fun onConsoleMessage(msg: android.webkit.ConsoleMessage?): Boolean {
                                            android.util.Log.d("WebViewConsole", "${msg?.message()} -- line ${msg?.lineNumber()}")
                                            return true
                                        }
                                        override fun onCreateWindow(
                                            view: WebView?,
                                            isDialog: Boolean,
                                            isUserGesture: Boolean,
                                            resultMsg: android.os.Message?
                                        ): Boolean {
                                            popupMessage = resultMsg
                                            return true
                                        }
                                    }
                                }
                            },
                            update = { webView ->
                                if (webView.tag != webUrl) {
                                    webView.tag = webUrl
                                    webView.loadUrl(webUrl)
                                }
                            },
                            modifier = Modifier.fillMaxSize().clipToBounds()
                        )
                    }
                }

                // Selected stream details banner permanently docked above tabs
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .background(Color(0xFF141622))
                        .padding(horizontal = 16.dp, vertical = 10.dp),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Icon(
                        imageVector = Icons.Default.PlayArrow,
                        contentDescription = "Playing",
                        tint = Color(0xFFE60000),
                        modifier = Modifier.size(16.dp)
                    )
                    Spacer(modifier = Modifier.width(6.dp))
                    Text(
                        text = "Playing: $selectedStreamTitle",
                        color = Color.White,
                        fontSize = 13.sp,
                        fontWeight = FontWeight.Bold
                    )
                }

                // 1. Custom Tabs (Apple-style Segmented Control)
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 16.dp, vertical = 8.dp)
                        .clip(RoundedCornerShape(12.dp))
                        .background(Color(0x1A000000))
                        .border(width = 1.dp, color = Color.White.copy(alpha = 0.05f), shape = RoundedCornerShape(12.dp))
                        .padding(3.dp),
                    horizontalArrangement = Arrangement.spacedBy(4.dp)
                ) {
                    val tabs = listOf("Streams", "Schedule", "Standings")
                    tabs.forEachIndexed { index, label ->
                        val isSelected = activeTab == index
                        Box(
                            modifier = Modifier
                                .weight(1f)
                                .clip(RoundedCornerShape(9.dp))
                                .background(if (isSelected) Color(0xFFE60000) else Color.Transparent)
                                .bounceClick { activeTab = index }
                                .padding(vertical = 8.dp),
                            contentAlignment = Alignment.Center
                        ) {
                            Text(
                                text = label,
                                color = if (isSelected) Color.White else Color(0xFF8E8E93),
                                fontWeight = FontWeight.Bold,
                                fontSize = 13.sp
                            )
                        }
                    }
                }

                // 2. Tab contents
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .weight(1f)
                        .background(Color.Transparent)
                ) {
                    AnimatedContent(
                        targetState = activeTab,
                        transitionSpec = {
                            if (targetState > initialState) {
                                (slideInHorizontally { width -> width } + fadeIn()).togetherWith(
                                    slideOutHorizontally { width -> -width } + fadeOut()
                                )
                            } else {
                                (slideInHorizontally { width -> -width } + fadeIn()).togetherWith(
                                    slideOutHorizontally { width -> width } + fadeOut()
                                )
                            }.using(
                                SizeTransform(clip = false)
                            )
                        },
                        label = "tabTransition"
                    ) { targetTab ->
                        when (targetTab) {
                            0 -> {
                            val links = liveConfig?.streamLinks ?: emptyList()
                            if (links.isEmpty()) {
                                Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                                    Text("No streams configured in admin panel.", color = Color.Gray)
                                }
                            } else {
                                LazyColumn(
                                    modifier = Modifier
                                        .fillMaxSize()
                                        .padding(16.dp),
                                    verticalArrangement = Arrangement.spacedBy(12.dp)
                                ) {
                                    items(links) { stream ->
                                        val isSelected = selectedStreamUrl == stream.url
                                        Card(
                                            shape = RoundedCornerShape(16.dp),
                                            colors = CardDefaults.cardColors(
                                                containerColor = if (isSelected) Color(0x33E60000) else Color(0xFF161824)
                                            ),
                                            modifier = Modifier
                                                .fillMaxWidth()
                                                .bounceClick {
                                                    selectedStreamUrl = stream.url
                                                    selectedStreamTitle = stream.name
                                                }
                                                .border(
                                                    width = 1.dp,
                                                    color = if (isSelected) Color(0xFFE60000) else Color.Transparent,
                                                    shape = RoundedCornerShape(16.dp)
                                                )
                                        ) {
                                            Row(
                                                modifier = Modifier.padding(16.dp),
                                                verticalAlignment = Alignment.CenterVertically
                                            ) {
                                                Icon(
                                                    imageVector = Icons.Default.PlayArrow,
                                                    contentDescription = "Stream Icon",
                                                    tint = if (isSelected) Color(0xFFE60000) else Color.LightGray
                                                )
                                                Spacer(modifier = Modifier.width(12.dp))
                                                Column {
                                                    Text(
                                                        text = stream.name,
                                                        color = Color.White,
                                                        fontWeight = FontWeight.Bold,
                                                        fontSize = 16.sp
                                                    )
                                                    Text(
                                                        text = if (isSelected) "Active Player" else "Tap to watch stream",
                                                        color = if (isSelected) Color(0xFFE60000) else Color.Gray,
                                                        fontSize = 12.sp
                                                    )
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    1 -> {
                            // SCHEDULE TAB
                            val schedule = liveConfig?.schedule ?: emptyList()
                            if (schedule.isEmpty()) {
                                Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                                    Text("No schedule sessions configured.", color = Color.Gray)
                                }
                            } else {
                                LazyColumn(
                                    modifier = Modifier
                                        .fillMaxSize()
                                        .padding(16.dp),
                                    verticalArrangement = Arrangement.spacedBy(12.dp)
                                ) {
                                    items(schedule) { session ->
                                        val startDate = parseResilientDate(session.timer)
                                        var startMs = 0L
                                        var endMs = 0L
                                        var status = "upcoming"
                                        var displayTime = session.time
                                        var displayDate = session.date

                                        if (startDate != null) {
                                            startMs = startDate.time
                                            endMs = startMs + 2 * 60 * 60 * 1000 // 2h default
                                            if (session.endTime.contains(":")) {
                                                try {
                                                    val parts = session.endTime.split(":")
                                                    val endCal = Calendar.getInstance().apply {
                                                        time = startDate
                                                        set(Calendar.HOUR_OF_DAY, parts[0].toInt())
                                                        set(Calendar.MINUTE, parts[1].toInt())
                                                        set(Calendar.SECOND, 0)
                                                    }
                                                    var endCalculated = endCal.timeInMillis
                                                    if (endCalculated < startMs) {
                                                        endCalculated += 24 * 60 * 60 * 1000
                                                    }
                                                    endMs = endCalculated
                                                } catch (e: Exception) {
                                                    // ignore
                                                }
                                            }
                                            val now = System.currentTimeMillis()
                                            status = if (now < startMs) {
                                                "upcoming"
                                            } else if (now in startMs until endMs) {
                                                "live"
                                            } else {
                                                "ended"
                                            }

                                            // Format local time display in IST
                                            val timeFormat = SimpleDateFormat("HH:mm", Locale.getDefault()).apply {
                                                timeZone = java.util.TimeZone.getTimeZone("Asia/Kolkata")
                                            }
                                            val startStr = timeFormat.format(startDate)
                                            val endStr = timeFormat.format(Date(endMs))
                                            displayTime = "$startStr - $endStr"

                                            // Format local date display in IST
                                            val dateFormat = SimpleDateFormat("EEEE, d MMMM", Locale.getDefault()).apply {
                                                timeZone = java.util.TimeZone.getTimeZone("Asia/Kolkata")
                                            }
                                            displayDate = dateFormat.format(startDate)
                                        }

                                        Card(
                                            shape = RoundedCornerShape(16.dp),
                                            colors = CardDefaults.cardColors(containerColor = Color(0xFF161824)),
                                            modifier = Modifier.fillMaxWidth()
                                        ) {
                                            Column(
                                                modifier = Modifier.padding(16.dp)
                                            ) {
                                                Row(
                                                    modifier = Modifier.fillMaxWidth(),
                                                    horizontalArrangement = Arrangement.SpaceBetween,
                                                    verticalAlignment = Alignment.CenterVertically
                                                ) {
                                                    Text(
                                                        text = displayDate,
                                                        color = Color.Gray,
                                                        fontSize = 12.sp,
                                                        fontWeight = FontWeight.Bold
                                                    )
                                                    Box(
                                                        modifier = Modifier
                                                            .clip(RoundedCornerShape(6.dp))
                                                            .background(
                                                                when (status) {
                                                                    "live" -> Color(0xFFE60000)
                                                                    "ended" -> Color(0xFF2C2F44)
                                                                    else -> Color(0xFF1E2130)
                                                                }
                                                            )
                                                            .padding(horizontal = 8.dp, vertical = 4.dp)
                                                    ) {
                                                        Text(
                                                            text = status.uppercase(),
                                                            color = Color.White,
                                                            fontSize = 10.sp,
                                                            fontWeight = FontWeight.Bold
                                                        )
                                                    }
                                                }
                                                Spacer(modifier = Modifier.height(8.dp))
                                                Text(
                                                    text = session.name,
                                                    color = Color.White,
                                                    fontWeight = FontWeight.Bold,
                                                    fontSize = 17.sp
                                                )
                                                Spacer(modifier = Modifier.height(6.dp))
                                                Row(verticalAlignment = Alignment.CenterVertically) {
                                                    Icon(
                                                        imageVector = Icons.Default.Info,
                                                        contentDescription = "Time",
                                                        tint = if (status == "live") Color(0xFFE60000) else Color.LightGray,
                                                        modifier = Modifier.size(14.dp)
                                                    )
                                                    Spacer(modifier = Modifier.width(6.dp))
                                                    Text(
                                                        text = displayTime,
                                                        color = if (status == "live") Color(0xFFE60000) else Color.LightGray,
                                                        fontSize = 13.sp,
                                                        fontWeight = FontWeight.SemiBold
                                                    )
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                        2 -> {
                            // STANDINGS TAB (Drivers and Constructors)
                            var showDrivers by remember { mutableStateOf(true) }
                            Column(modifier = Modifier.fillMaxSize()) {
                                // Toggle buttons
                                Row(
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .padding(16.dp),
                                    horizontalArrangement = Arrangement.spacedBy(12.dp)
                                ) {
                                    Button(
                                        onClick = { showDrivers = true },
                                        colors = ButtonDefaults.buttonColors(
                                            containerColor = if (showDrivers) Color(0xFFE60000) else Color(0xFF1E2130)
                                        ),
                                        shape = RoundedCornerShape(8.dp),
                                        modifier = Modifier.weight(1f)
                                    ) {
                                        Text("Drivers", color = Color.White)
                                    }
                                    Button(
                                        onClick = { showDrivers = false },
                                        colors = ButtonDefaults.buttonColors(
                                            containerColor = if (!showDrivers) Color(0xFFE60000) else Color(0xFF1E2130)
                                        ),
                                        shape = RoundedCornerShape(8.dp),
                                        modifier = Modifier.weight(1f)
                                    ) {
                                        Text("Constructors", color = Color.White)
                                    }
                                }
                                if (showDrivers) {
                                    val drivers = liveConfig?.standings ?: emptyList()
                                    if (drivers.isEmpty()) {
                                        Box(
                                            modifier = Modifier
                                                .fillMaxWidth()
                                                .weight(1f), contentAlignment = Alignment.Center
                                        ) {
                                            Text("Standings data currently syncing...", color = Color.Gray)
                                        }
                                    } else {
                                        LazyColumn(
                                            modifier = Modifier
                                                .fillMaxWidth()
                                                .weight(1f)
                                                .padding(16.dp)
                                        ) {
                                            item {
                                                Card(
                                                    shape = RoundedCornerShape(16.dp),
                                                    colors = CardDefaults.cardColors(containerColor = Color(0x990A0C16)),
                                                    modifier = Modifier
                                                        .fillMaxWidth()
                                                        .border(
                                                            width = 1.dp,
                                                            brush = Brush.linearGradient(
                                                                colors = listOf(
                                                                    Color.White.copy(alpha = 0.08f),
                                                                    Color.White.copy(alpha = 0.02f)
                                                                )
                                                            ),
                                                            shape = RoundedCornerShape(16.dp)
                                                        )
                                                ) {
                                                    Column(modifier = Modifier.fillMaxWidth()) {
                                                        // Table Header
                                                        Row(
                                                            modifier = Modifier
                                                                .fillMaxWidth()
                                                                .background(Color(0x1AFFFFFF))
                                                                .padding(horizontal = 12.dp, vertical = 10.dp),
                                                            verticalAlignment = Alignment.CenterVertically
                                                        ) {
                                                            Text("Pos", color = Color.Gray, fontWeight = FontWeight.Bold, modifier = Modifier.weight(0.10f))
                                                            Text("Driver", color = Color.Gray, fontWeight = FontWeight.Bold, modifier = Modifier.weight(0.75f))
                                                            Text("PTS", color = Color.Gray, fontWeight = FontWeight.Bold, modifier = Modifier.weight(0.15f), textAlign = TextAlign.End)
                                                        }
                                                        
                                                        drivers.forEach { driver ->
                                                            Row(
                                                                modifier = Modifier
                                                                    .fillMaxWidth()
                                                                    .padding(vertical = 10.dp, horizontal = 12.dp),
                                                                verticalAlignment = Alignment.CenterVertically
                                                            ) {
                                                                Text(
                                                                    text = "${driver.position}",
                                                                    color = Color.White,
                                                                    fontWeight = FontWeight.Bold,
                                                                    modifier = Modifier.weight(0.10f)
                                                                )
                                                                Row(
                                                                    modifier = Modifier.weight(0.75f),
                                                                    verticalAlignment = Alignment.CenterVertically
                                                                ) {
                                                                    if (driver.image.isNotEmpty()) {
                                                                        AsyncImage(
                                                                            model = driver.image,
                                                                            contentDescription = "${driver.name} photo",
                                                                            modifier = Modifier
                                                                                .size(40.dp)
                                                                                .clip(CircleShape)
                                                                                .background(Color.DarkGray)
                                                                                .border(1.dp, Color.White.copy(alpha = 0.1f), CircleShape),
                                                                            contentScale = ContentScale.Crop
                                                                        )
                                                                        Spacer(modifier = Modifier.width(12.dp))
                                                                    }
                                                                    Column {
                                                                        Text(
                                                                            text = driver.name,
                                                                            color = Color.White,
                                                                            fontWeight = FontWeight.SemiBold,
                                                                            fontSize = 14.sp
                                                                        )
                                                                        Text(
                                                                            text = driver.team,
                                                                            color = Color.LightGray,
                                                                            fontSize = 12.sp
                                                                        )
                                                                    }
                                                                }
                                                                Text(
                                                                    text = "${driver.points}",
                                                                    color = Color.White,
                                                                    fontWeight = FontWeight.Bold,
                                                                    modifier = Modifier.weight(0.15f),
                                                                    textAlign = TextAlign.End
                                                                )
                                                            }
                                                            HorizontalDivider(color = Color(0x14FFFFFF))
                                                        }
                                                    }
                                                }
                                            }
                                        }
                                    }
                                } else {
                                    val teams = liveConfig?.constructors ?: emptyList()
                                    if (teams.isEmpty()) {
                                        Box(
                                            modifier = Modifier
                                                .fillMaxWidth()
                                                .weight(1f), contentAlignment = Alignment.Center
                                        ) {
                                            Text("Standings data currently syncing...", color = Color.Gray)
                                        }
                                    } else {
                                        LazyColumn(
                                            modifier = Modifier
                                                .fillMaxWidth()
                                                .weight(1f)
                                                .padding(16.dp)
                                        ) {
                                            item {
                                                Card(
                                                    shape = RoundedCornerShape(16.dp),
                                                    colors = CardDefaults.cardColors(containerColor = Color(0x990A0C16)),
                                                    modifier = Modifier
                                                        .fillMaxWidth()
                                                        .border(
                                                            width = 1.dp,
                                                            brush = Brush.linearGradient(
                                                                colors = listOf(
                                                                    Color.White.copy(alpha = 0.08f),
                                                                    Color.White.copy(alpha = 0.02f)
                                                                )
                                                            ),
                                                            shape = RoundedCornerShape(16.dp)
                                                        )
                                                ) {
                                                    Column(modifier = Modifier.fillMaxWidth()) {
                                                        // Table Header
                                                        Row(
                                                            modifier = Modifier
                                                                .fillMaxWidth()
                                                                .background(Color(0x1AFFFFFF))
                                                                .padding(horizontal = 12.dp, vertical = 10.dp)
                                                        ) {
                                                            Text("Pos", color = Color.Gray, fontWeight = FontWeight.Bold, modifier = Modifier.weight(0.15f))
                                                            Text("Team", color = Color.Gray, fontWeight = FontWeight.Bold, modifier = Modifier.weight(0.60f))
                                                            Text("PTS", color = Color.Gray, fontWeight = FontWeight.Bold, modifier = Modifier.weight(0.25f), textAlign = TextAlign.End)
                                                        }
                                                        
                                                        teams.forEach { team ->
                                                            Row(
                                                                modifier = Modifier
                                                                    .fillMaxWidth()
                                                                    .padding(vertical = 12.dp, horizontal = 12.dp),
                                                                verticalAlignment = Alignment.CenterVertically
                                                            ) {
                                                                Text("${team.position}", color = Color.White, modifier = Modifier.weight(0.15f))
                                                                Text(team.name, color = Color.White, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(0.60f))
                                                                Text("${team.points}", color = Color.White, fontWeight = FontWeight.Bold, modifier = Modifier.weight(0.25f), textAlign = TextAlign.End)
                                                            }
                                                            HorizontalDivider(color = Color(0x14FFFFFF))
                                                        }
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                }
            }
        }
    }
    if (popupMessage != null) {
        var boundWebView by remember { mutableStateOf<WebView?>(null) }
        DisposableEffect(popupMessage) {
            onDispose {
                try {
                    boundWebView?.destroy()
                } catch (e: Exception) {}
            }
        }
        Dialog(
            onDismissRequest = { popupMessage = null },
            properties = DialogProperties(usePlatformDefaultWidth = false)
        ) {
            Card(
                modifier = Modifier
                    .fillMaxWidth(0.95f)
                    .fillMaxHeight(0.85f)
                    .border(1.dp, Color(0x33FFFFFF), RoundedCornerShape(16.dp)),
                shape = RoundedCornerShape(16.dp),
                colors = CardDefaults.cardColors(containerColor = Color(0xFF0F111A))
            ) {
                Column(modifier = Modifier.fillMaxSize()) {
                    // Header
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .background(Color(0xFF161925))
                            .padding(12.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.SpaceBetween
                    ) {
                        Text(
                            text = "Ad Interstitial - Close to Play",
                            color = Color.White,
                            fontWeight = FontWeight.Bold,
                            fontSize = 14.sp
                        )
                        Button(
                            onClick = {
                                popupMessage = null
                            },
                            colors = ButtonDefaults.buttonColors(containerColor = Color(0xFFE60000)),
                            contentPadding = PaddingValues(horizontal = 16.dp, vertical = 8.dp),
                            shape = RoundedCornerShape(8.dp)
                        ) {
                            Text("Close Ad & Play", color = Color.White, fontWeight = FontWeight.Bold, fontSize = 12.sp)
                        }
                    }
                    
                    // Ad WebView
                    Box(modifier = Modifier.fillMaxSize()) {
                        AndroidView(
                            factory = { ctx ->
                                WebView(ctx).apply {
                                    settings.javaScriptEnabled = true
                                    settings.domStorageEnabled = true
                                    settings.databaseEnabled = true
                                    settings.userAgentString = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
                                    settings.mixedContentMode = android.webkit.WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
                                    webViewClient = object : WebViewClient() {
                                        override fun onReceivedSslError(view: WebView?, handler: android.webkit.SslErrorHandler?, error: android.net.http.SslError?) {
                                            handler?.proceed()
                                        }
                                        override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
                                            val url = request?.url?.toString() ?: return false
                                            if (url.startsWith("http://") || url.startsWith("https://")) {
                                                view?.loadUrl(url)
                                                return true
                                            }
                                            try {
                                                val intent = android.content.Intent.parseUri(url, android.content.Intent.URI_INTENT_SCHEME)
                                                view?.context?.startActivity(intent)
                                            } catch (e: Exception) {}
                                            return true
                                        }
                                    }
                                    
                                    val transport = popupMessage?.obj as? WebView.WebViewTransport
                                    if (transport != null) {
                                        transport.webView = this
                                        popupMessage?.sendToTarget()
                                    }
                                    boundWebView = this
                                }
                            },
                            modifier = Modifier.fillMaxSize()
                        )
                    }
                }
            }
        }
    }
}
}

private fun parseResilientDate(dateStr: String): Date? {
    val formats = listOf(
        "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'",
        "yyyy-MM-dd'T'HH:mm:ss'Z'",
        "yyyy-MM-dd'T'HH:mm:ss",
        "yyyy-MM-dd HH:mm:ss",
        "yyyy-MM-dd'T'HH:mm",
        "yyyy-MM-dd HH:mm"
    )
    for (format in formats) {
        try {
            val sdf = SimpleDateFormat(format, Locale.US)
            if (format.contains("'Z'")) {
                sdf.timeZone = TimeZone.getTimeZone("UTC")
            } else {
                sdf.timeZone = TimeZone.getDefault()
            }
            val date = sdf.parse(dateStr)
            if (date != null) return date
        } catch (e: Exception) {
            // continue
        }
    }
    return null
}
