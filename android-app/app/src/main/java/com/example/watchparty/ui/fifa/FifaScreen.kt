package com.example.watchparty.ui.fifa

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
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.RectangleShape
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.animation.*
import androidx.compose.animation.core.*
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
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import java.text.SimpleDateFormat
import java.util.Date
import java.util.TimeZone
import java.util.Locale
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun FifaScreen(
    onBackClick: () -> Unit,
    modifier: Modifier = Modifier
) {
    val context = LocalContext.current
    var liveConfig by remember { mutableStateOf<LiveConfig?>(null) }
    var fixtures by remember { mutableStateOf<List<FifaFixture>>(emptyList()) }
    var standings by remember { mutableStateOf<List<FifaStandingGroup>>(emptyList()) }
    var selectedStreamUrl by remember { mutableStateOf("") }
    var selectedStreamTitle by remember { mutableStateOf("No Stream Selected") }
    var activeTab by remember { mutableIntStateOf(0) }
    var showUpcomingFixtures by remember { mutableStateOf(true) }
    var isLoading by remember { mutableStateOf(true) }
    // Resolved stream — null means still resolving
    var resolvedStream by remember { mutableStateOf<ResolvedStream?>(null) }
    var currentTimeMs by remember { mutableStateOf(System.currentTimeMillis()) }
    var visible by remember { mutableStateOf(false) }
    var popupMessage by remember { mutableStateOf<android.os.Message?>(null) }

    LaunchedEffect(Unit) {
        while (true) {
            currentTimeMs = System.currentTimeMillis()
            kotlinx.coroutines.delay(1000L)
        }
    }

    // Load data
    LaunchedEffect(Unit) {
        isLoading = true
        val configDeferred = async(Dispatchers.IO) { ApiDataFetcher.fetchLiveConfig(context) }
        val fixturesDeferred = async(Dispatchers.IO) { ApiDataFetcher.fetchFifaFixtures(context) }
        val standingsDeferred = async(Dispatchers.IO) { ApiDataFetcher.fetchFifaStandings(context) }

        val config = configDeferred.await()
        liveConfig = config
        if (config != null && config.fifaStreamLinks.isNotEmpty()) {
            selectedStreamUrl = config.fifaStreamLinks[0].url
            selectedStreamTitle = config.fifaStreamLinks[0].name
        }
        fixtures = fixturesDeferred.await()
        standings = standingsDeferred.await()
        isLoading = false
    }

    // Resolve stream URL whenever selectedStreamUrl changes
    LaunchedEffect(selectedStreamUrl) {
        if (selectedStreamUrl.isNotEmpty()) {
            resolvedStream = null
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
                .background(Color(0xFF050508))
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

                    // 2. Ambient FIFA Purple Glow (Top-Right)
                    drawCircle(
                        brush = Brush.radialGradient(
                            colors = listOf(
                                Color(0xFF8000FF).copy(alpha = 0.1f),
                                Color.Transparent
                            ),
                            center = Offset(size.width + 100.dp.toPx(), 200.dp.toPx()),
                            radius = 450.dp.toPx()
                        ),
                        radius = 450.dp.toPx(),
                        center = Offset(size.width + 100.dp.toPx(), 200.dp.toPx())
                    )

                    // 3. Ambient Blue/Purple Glow (Bottom-Left)
                    drawCircle(
                        brush = Brush.radialGradient(
                            colors = listOf(
                                Color(0xFF1D70B8).copy(alpha = 0.12f),
                                Color.Transparent
                            ),
                            center = Offset(-100.dp.toPx(), size.height - 200.dp.toPx()),
                            radius = 500.dp.toPx()
                        ),
                        radius = 500.dp.toPx(),
                        center = Offset(-100.dp.toPx(), size.height - 200.dp.toPx())
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
                            Text(
                                text = "WatchFIFA",
                                fontSize = 20.sp,
                                fontWeight = FontWeight.Black,
                                color = Color.White
                            )
                            Text(
                                text = ".Live",
                                fontSize = 20.sp,
                                fontWeight = FontWeight.Black,
                                color = Color(0xFF8000FF)
                            )
                            Spacer(modifier = Modifier.width(8.dp))
                            Box(
                                modifier = Modifier
                                    .size(6.dp)
                                    .clip(CircleShape)
                                    .background(Color(0xFF8000FF))
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
                            Text("No match stream selected.", color = Color.Gray, fontSize = 14.sp)
                        }
                    } else if (resolvedStream == null) {
                        Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                            CircularProgressIndicator(color = Color(0xFF8000FF), modifier = Modifier.size(36.dp))
                        }
                    } else if (resolvedStream!!.playerType == PlayerType.EXOPLAYER) {
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
                                        android.util.Log.e("ExoPlayer", "FIFA Playback error: ${error.message} cause=${error.cause?.message}")
                                    }
                                    override fun onPlaybackStateChanged(state: Int) {
                                        val stateName = when(state) {
                                            Player.STATE_IDLE -> "IDLE"
                                            Player.STATE_BUFFERING -> "BUFFERING"
                                            Player.STATE_READY -> "READY"
                                            Player.STATE_ENDED -> "ENDED"
                                            else -> "UNKNOWN"
                                        }
                                        android.util.Log.d("ExoPlayer", "FIFA State -> $stateName for $streamUrl")
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
                        .background(Color(0x9911131F))
                        .border(width = 1.dp, color = Color(0x14FFFFFF), shape = RectangleShape)
                        .padding(horizontal = 16.dp, vertical = 12.dp),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Icon(
                        imageVector = Icons.Default.PlayArrow,
                        contentDescription = "Playing",
                        tint = Color(0xFF8000FF),
                        modifier = Modifier.size(16.dp)
                    )
                    Spacer(modifier = Modifier.width(8.dp))
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
                    val tabs = listOf("Streams", "Fixtures", "Table")
                    tabs.forEachIndexed { index, label ->
                        val isSelected = activeTab == index
                        Box(
                            modifier = Modifier
                                .weight(1f)
                                .clip(RoundedCornerShape(9.dp))
                                .background(if (isSelected) Color(0xFF8000FF) else Color.Transparent)
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
                                val links = liveConfig?.fifaStreamLinks ?: emptyList()
                                if (links.isEmpty()) {
                                    Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                                        Text("No FIFA streams configured.", color = Color.Gray)
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
                                                    containerColor = if (isSelected) Color(0x1F8000FF) else Color(0x990A0C16)
                                                ),
                                                modifier = Modifier
                                                    .fillMaxWidth()
                                                    .bounceClick {
                                                        selectedStreamUrl = stream.url
                                                        selectedStreamTitle = stream.name
                                                    }
                                                    .border(
                                                        width = 1.dp,
                                                        color = if (isSelected) Color(0xFF8000FF) else Color(0x14FFFFFF),
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
                                                        tint = if (isSelected) Color(0xFF8000FF) else Color.LightGray
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
                                                            color = if (isSelected) Color(0xFF8000FF) else Color.Gray,
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
                                // FIXTURES TAB
                                if (fixtures.isEmpty()) {
                                    Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                                        Text("No upcoming matches scheduled.", color = Color.Gray)
                                    }
                                } else {
                                    val upcoming = fixtures.filter { it.status.lowercase() == "live" || it.status.lowercase() == "notstarted" }
                                    val finished = fixtures.filter { it.status.lowercase() != "live" && it.status.lowercase() != "notstarted" }

                                    Column(modifier = Modifier.fillMaxSize()) {
                                        Row(
                                            modifier = Modifier
                                                .fillMaxWidth()
                                                .padding(horizontal = 16.dp, vertical = 12.dp)
                                                .clip(RoundedCornerShape(12.dp))
                                                .background(Color(0x990A0C16))
                                                .border(width = 1.dp, color = Color(0x14FFFFFF), shape = RoundedCornerShape(12.dp))
                                                .padding(3.dp),
                                            horizontalArrangement = Arrangement.spacedBy(4.dp)
                                        ) {
                                            Box(
                                                modifier = Modifier
                                                    .weight(1f)
                                                    .clip(RoundedCornerShape(9.dp))
                                                    .background(if (showUpcomingFixtures) Color(0xFF8000FF) else Color.Transparent)
                                                    .clickable { showUpcomingFixtures = true }
                                                    .padding(vertical = 8.dp),
                                                contentAlignment = Alignment.Center
                                            ) {
                                                Text(
                                                    text = "Upcoming",
                                                    color = if (showUpcomingFixtures) Color.White else Color(0xFF8E8E93),
                                                    fontWeight = FontWeight.Bold,
                                                    fontSize = 13.sp
                                                )
                                            }
                                            Box(
                                                modifier = Modifier
                                                    .weight(1f)
                                                    .clip(RoundedCornerShape(9.dp))
                                                    .background(if (!showUpcomingFixtures) Color(0xFF8000FF) else Color.Transparent)
                                                    .clickable { showUpcomingFixtures = false }
                                                    .padding(vertical = 8.dp),
                                                contentAlignment = Alignment.Center
                                            ) {
                                                Text(
                                                    text = "Finished",
                                                    color = if (!showUpcomingFixtures) Color.White else Color(0xFF8E8E93),
                                                    fontWeight = FontWeight.Bold,
                                                    fontSize = 13.sp
                                                )
                                            }
                                        }

                                        AnimatedContent(
                                            targetState = showUpcomingFixtures,
                                            transitionSpec = {
                                                if (!targetState) {
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
                                            label = "fixturesListTransition",
                                            modifier = Modifier.weight(1f)
                                        ) { upcomingSelected ->
                                            if (upcomingSelected) {
                                                if (upcoming.isEmpty()) {
                                                    Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                                                        Text("No upcoming matches scheduled.", color = Color.Gray)
                                                    }
                                                } else {
                                                    LazyColumn(
                                                        modifier = Modifier
                                                            .fillMaxSize()
                                                            .padding(horizontal = 16.dp),
                                                        verticalArrangement = Arrangement.spacedBy(12.dp)
                                                    ) {
                                                        items(upcoming, key = { it.matchId }) { fixture ->
                                                            val isLive = fixture.status.equals("live", ignoreCase = true)
                                                            val infiniteTransition = rememberInfiniteTransition(label = "livePulse")
                                                            val pulseAlpha by infiniteTransition.animateFloat(
                                                                initialValue = 0.4f,
                                                                targetValue = 1f,
                                                                animationSpec = infiniteRepeatable(
                                                                    animation = tween(800, easing = LinearEasing),
                                                                    repeatMode = RepeatMode.Reverse
                                                                ),
                                                                label = "liveAlpha"
                                                            )

                                                            Card(
                                                                shape = RoundedCornerShape(16.dp),
                                                                colors = CardDefaults.cardColors(containerColor = Color(0x990A0C16)),
                                                                modifier = Modifier
                                                                    .fillMaxWidth()
                                                                    .animateItem()
                                                                    .border(
                                                                        width = 1.dp,
                                                                        brush = Brush.linearGradient(
                                                                            colors = listOf(
                                                                                if (isLive) Color(0xFF8000FF).copy(alpha = pulseAlpha) else Color.White.copy(alpha = 0.05f),
                                                                                Color.White.copy(alpha = 0.02f)
                                                                            )
                                                                        ),
                                                                        shape = RoundedCornerShape(16.dp)
                                                                    )
                                                            ) {
                                                                Column(
                                                                    modifier = Modifier.padding(16.dp),
                                                                    horizontalAlignment = Alignment.CenterHorizontally
                                                                ) {
                                                                    Row(
                                                                        modifier = Modifier.fillMaxWidth(),
                                                                        horizontalArrangement = Arrangement.SpaceBetween,
                                                                        verticalAlignment = Alignment.CenterVertically
                                                                    ) {
                                                                        Text(
                                                                            text = formatUtcToIst(fixture.kickoffTs, "EEEE, d MMMM"),
                                                                            color = Color.Gray,
                                                                            fontSize = 11.sp,
                                                                            fontWeight = FontWeight.Bold
                                                                        )
                                                                        val isNotStarted = fixture.status.equals("notstarted", ignoreCase = true)
                                                                        Box(
                                                                            modifier = Modifier
                                                                                .clip(RoundedCornerShape(6.dp))
                                                                                .background(
                                                                                    if (isLive) Color(0xFFE60000).copy(alpha = pulseAlpha)
                                                                                    else if (isNotStarted && fixture.kickoffTs > currentTimeMs) Color(0x268000FF)
                                                                                    else Color(0x1AFFFFFF)
                                                                                )
                                                                                .padding(horizontal = 8.dp, vertical = 4.dp)
                                                                        ) {
                                                                            Text(
                                                                                text = if (isNotStarted && fixture.kickoffTs > currentTimeMs) {
                                                                                    formatCountdown(fixture.kickoffTs, currentTimeMs)
                                                                                } else {
                                                                                    fixture.status.uppercase()
                                                                                },
                                                                                color = if (isLive) Color.White 
                                                                                        else if (isNotStarted && fixture.kickoffTs > currentTimeMs) Color(0xFF8000FF) 
                                                                                        else Color.LightGray,
                                                                                fontSize = 10.sp,
                                                                                fontWeight = FontWeight.Bold
                                                                            )
                                                                        }
                                                                    }

                                                                    Spacer(modifier = Modifier.height(12.dp))

                                                                    val homeFlagEmoji = getFlagEmoji(fixture.homeFlag)
                                                                    val awayFlagEmoji = getFlagEmoji(fixture.awayFlag)

                                                                    Row(
                                                                        modifier = Modifier.fillMaxWidth(),
                                                                        verticalAlignment = Alignment.CenterVertically,
                                                                        horizontalArrangement = Arrangement.Center
                                                                    ) {
                                                                        // Home Team (Name + Flag)
                                                                        Row(
                                                                            modifier = Modifier.weight(1f),
                                                                            verticalAlignment = Alignment.CenterVertically,
                                                                            horizontalArrangement = Arrangement.End
                                                                        ) {
                                                                            Text(
                                                                                text = fixture.homeTeam,
                                                                                color = Color.White,
                                                                                fontWeight = FontWeight.Bold,
                                                                                fontSize = 14.sp,
                                                                                textAlign = TextAlign.End,
                                                                                modifier = Modifier.weight(1f)
                                                                            )
                                                                            if (homeFlagEmoji.isNotEmpty()) {
                                                                                Spacer(modifier = Modifier.width(6.dp))
                                                                                Text(text = homeFlagEmoji, fontSize = 18.sp)
                                                                            }
                                                                        }

                                                                        // Score Capsule
                                                                        Box(
                                                                            modifier = Modifier
                                                                                .padding(horizontal = 12.dp)
                                                                                .clip(RoundedCornerShape(8.dp))
                                                                                .background(Color.Black.copy(alpha = 0.4f))
                                                                                .border(width = 1.dp, color = Color.White.copy(alpha = 0.05f), shape = RoundedCornerShape(8.dp))
                                                                                .padding(horizontal = 12.dp, vertical = 6.dp)
                                                                        ) {
                                                                            Text(
                                                                                text = if (isLive) "${fixture.homeScore} - ${fixture.awayScore}" else "VS",
                                                                                color = if (isLive) Color(0xFF8000FF) else Color.Gray,
                                                                                fontWeight = FontWeight.Black,
                                                                                fontSize = 15.sp,
                                                                                textAlign = TextAlign.Center
                                                                            )
                                                                        }

                                                                        // Away Team (Flag + Name)
                                                                        Row(
                                                                            modifier = Modifier.weight(1f),
                                                                            verticalAlignment = Alignment.CenterVertically,
                                                                            horizontalArrangement = Arrangement.Start
                                                                        ) {
                                                                            if (awayFlagEmoji.isNotEmpty()) {
                                                                                Text(text = awayFlagEmoji, fontSize = 18.sp)
                                                                                Spacer(modifier = Modifier.width(6.dp))
                                                                            }
                                                                            Text(
                                                                                text = fixture.awayTeam,
                                                                                color = Color.White,
                                                                                fontWeight = FontWeight.Bold,
                                                                                fontSize = 14.sp,
                                                                                textAlign = TextAlign.Start,
                                                                                modifier = Modifier.weight(1f)
                                                                            )
                                                                        }
                                                                    }

                                                                    Spacer(modifier = Modifier.height(12.dp))
                                                                    Text(
                                                                        text = "Kickoff: " + formatUtcToIst(fixture.kickoffTs, "d MMM HH:mm 'IST'"),
                                                                        color = Color.Gray,
                                                                        fontSize = 11.sp
                                                                    )
                                                                }
                                                            }
                                                        }
                                                        item {
                                                            Spacer(modifier = Modifier.height(16.dp))
                                                        }
                                                    }
                                                }
                                            } else {
                                                if (finished.isEmpty()) {
                                                    Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                                                        Text("No finished matches found.", color = Color.Gray)
                                                    }
                                                } else {
                                                    LazyColumn(
                                                        modifier = Modifier
                                                            .fillMaxSize()
                                                            .padding(horizontal = 16.dp),
                                                        verticalArrangement = Arrangement.spacedBy(12.dp)
                                                    ) {
                                                        items(finished, key = { it.matchId }) { fixture ->
                                                            Card(
                                                                shape = RoundedCornerShape(16.dp),
                                                                colors = CardDefaults.cardColors(containerColor = Color(0x990A0C16)),
                                                                modifier = Modifier
                                                                    .fillMaxWidth()
                                                                    .animateItem()
                                                                    .border(
                                                                        width = 1.dp,
                                                                        color = Color.White.copy(alpha = 0.05f),
                                                                        shape = RoundedCornerShape(16.dp)
                                                                    )
                                                            ) {
                                                                Column(
                                                                    modifier = Modifier.padding(16.dp),
                                                                    horizontalAlignment = Alignment.CenterHorizontally
                                                                ) {
                                                                    Row(
                                                                        modifier = Modifier.fillMaxWidth(),
                                                                        horizontalArrangement = Arrangement.SpaceBetween,
                                                                        verticalAlignment = Alignment.CenterVertically
                                                                    ) {
                                                                        Text(
                                                                            text = formatUtcToIst(fixture.kickoffTs, "EEEE, d MMMM"),
                                                                            color = Color.Gray,
                                                                            fontSize = 11.sp,
                                                                            fontWeight = FontWeight.Bold
                                                                        )
                                                                        Box(
                                                                            modifier = Modifier
                                                                                .clip(RoundedCornerShape(4.dp))
                                                                                .background(Color(0x1AFFFFFF))
                                                                                .padding(horizontal = 6.dp, vertical = 2.dp)
                                                                        ) {
                                                                            Text(
                                                                                text = "FINISHED",
                                                                                color = Color.LightGray,
                                                                                fontSize = 9.sp,
                                                                                fontWeight = FontWeight.Bold
                                                                            )
                                                                        }
                                                                    }

                                                                    Spacer(modifier = Modifier.height(12.dp))

                                                                    val homeFlagEmoji = getFlagEmoji(fixture.homeFlag)
                                                                    val awayFlagEmoji = getFlagEmoji(fixture.awayFlag)

                                                                    Row(
                                                                        modifier = Modifier.fillMaxWidth(),
                                                                        verticalAlignment = Alignment.CenterVertically,
                                                                        horizontalArrangement = Arrangement.Center
                                                                    ) {
                                                                        // Home Team (Name + Flag)
                                                                        Row(
                                                                            modifier = Modifier.weight(1f),
                                                                            verticalAlignment = Alignment.CenterVertically,
                                                                            horizontalArrangement = Arrangement.End
                                                                        ) {
                                                                            Text(
                                                                                text = fixture.homeTeam,
                                                                                color = Color.LightGray,
                                                                                fontWeight = FontWeight.Bold,
                                                                                fontSize = 14.sp,
                                                                                textAlign = TextAlign.End,
                                                                                modifier = Modifier.weight(1f)
                                                                            )
                                                                            if (homeFlagEmoji.isNotEmpty()) {
                                                                                Spacer(modifier = Modifier.width(6.dp))
                                                                                Text(text = homeFlagEmoji, fontSize = 18.sp)
                                                                            }
                                                                        }

                                                                        // Score Capsule
                                                                        Box(
                                                                            modifier = Modifier
                                                                                .padding(horizontal = 12.dp)
                                                                                .clip(RoundedCornerShape(8.dp))
                                                                                .background(Color.Black.copy(alpha = 0.4f))
                                                                                .border(width = 1.dp, color = Color.White.copy(alpha = 0.05f), shape = RoundedCornerShape(8.dp))
                                                                                .padding(horizontal = 12.dp, vertical = 6.dp)
                                                                        ) {
                                                                            Text(
                                                                                text = "${fixture.homeScore} - ${fixture.awayScore}",
                                                                                color = Color.LightGray,
                                                                                fontWeight = FontWeight.Black,
                                                                                fontSize = 15.sp,
                                                                                textAlign = TextAlign.Center
                                                                            )
                                                                        }

                                                                        // Away Team (Flag + Name)
                                                                        Row(
                                                                            modifier = Modifier.weight(1f),
                                                                            verticalAlignment = Alignment.CenterVertically,
                                                                            horizontalArrangement = Arrangement.Start
                                                                        ) {
                                                                            if (awayFlagEmoji.isNotEmpty()) {
                                                                                Text(text = awayFlagEmoji, fontSize = 18.sp)
                                                                                Spacer(modifier = Modifier.width(6.dp))
                                                                            }
                                                                            Text(
                                                                                text = fixture.awayTeam,
                                                                                color = Color.LightGray,
                                                                                fontWeight = FontWeight.Bold,
                                                                                fontSize = 14.sp,
                                                                                textAlign = TextAlign.Start,
                                                                                modifier = Modifier.weight(1f)
                                                                            )
                                                                        }
                                                                    }

                                                                    Spacer(modifier = Modifier.height(12.dp))
                                                                    Text(
                                                                        text = "Stadium: ${fixture.matchId}",
                                                                        color = Color.DarkGray,
                                                                        fontSize = 10.sp
                                                                    )
                                                                }
                                                            }
                                                        }
                                                        item {
                                                            Spacer(modifier = Modifier.height(16.dp))
                                                        }
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                            2 -> {
                                // STANDINGS TAB
                                if (standings.isEmpty()) {
                                    Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                                        Text("Table standings currently unavailable.", color = Color.Gray)
                                    }
                                } else {
                                    LazyColumn(
                                        modifier = Modifier
                                            .fillMaxSize()
                                            .padding(16.dp),
                                        verticalArrangement = Arrangement.spacedBy(20.dp)
                                    ) {
                                        items(standings) { group ->
                                            Column(modifier = Modifier.fillMaxWidth()) {
                                                // Group title banner
                                                Text(
                                                    text = group.name.replace("Group", "Table", ignoreCase = true).uppercase(),
                                                    color = Color(0xFF8000FF),
                                                    fontWeight = FontWeight.Black,
                                                    fontSize = 16.sp,
                                                    modifier = Modifier.padding(bottom = 8.dp)
                                                )
                                                
                                                // Group Table
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
                                                            Text("Pos", color = Color.Gray, fontWeight = FontWeight.Bold, modifier = Modifier.weight(0.12f))
                                                            Text("Team", color = Color.Gray, fontWeight = FontWeight.Bold, modifier = Modifier.weight(0.50f))
                                                            Text("PL", color = Color.Gray, fontWeight = FontWeight.Bold, modifier = Modifier.weight(0.12f), textAlign = TextAlign.Center)
                                                            Text("GD", color = Color.Gray, fontWeight = FontWeight.Bold, modifier = Modifier.weight(0.12f), textAlign = TextAlign.Center)
                                                            Text("PTS", color = Color.Gray, fontWeight = FontWeight.Bold, modifier = Modifier.weight(0.14f), textAlign = TextAlign.End)
                                                        }
                                                        group.teams.forEach { team ->
                                                            val isQualifying = team.position <= 2
                                                            val flagEmoji = getFlagEmoji(team.flag)
                                                            Row(
                                                                modifier = Modifier
                                                                    .fillMaxWidth()
                                                                    .padding(horizontal = 12.dp, vertical = 12.dp),
                                                                verticalAlignment = Alignment.CenterVertically
                                                            ) {
                                                                Text(
                                                                    text = "${team.position}",
                                                                    color = if (isQualifying) Color(0xFF8000FF) else Color.White,
                                                                    fontWeight = if (isQualifying) FontWeight.Bold else FontWeight.Normal,
                                                                    modifier = Modifier.weight(0.12f)
                                                                )
                                                                Row(
                                                                    modifier = Modifier.weight(0.50f),
                                                                    verticalAlignment = Alignment.CenterVertically
                                                                ) {
                                                                    if (flagEmoji.isNotEmpty()) {
                                                                        Text(text = flagEmoji, fontSize = 16.sp)
                                                                        Spacer(modifier = Modifier.width(6.dp))
                                                                    }
                                                                    Text(
                                                                        text = team.name,
                                                                        color = Color.White,
                                                                        fontWeight = FontWeight.SemiBold,
                                                                        fontSize = 14.sp
                                                                    )
                                                                }
                                                                Text("${team.played}", color = Color.LightGray, modifier = Modifier.weight(0.12f), textAlign = TextAlign.Center)
                                                                Text(
                                                                    text = if (team.gd > 0) "+${team.gd}" else "${team.gd}",
                                                                    color = Color.LightGray,
                                                                    modifier = Modifier.weight(0.12f),
                                                                    textAlign = TextAlign.Center
                                                                )
                                                                Text("${team.points}", color = Color.White, fontWeight = FontWeight.Bold, modifier = Modifier.weight(0.14f), textAlign = TextAlign.End)
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

// Helper to convert flag URL/code to flag emoji
private fun getFlagEmoji(flagInput: String): String {
    if (flagInput.isEmpty()) return ""
    var code = flagInput
    if (flagInput.contains("/")) {
        code = flagInput.substringAfterLast("/").substringBefore(".")
    }
    if (code.isEmpty()) return ""
    return countryCodeToEmoji(code)
}

// Converts a 2-letter country code (like "br") into the flag emoji unicode
private fun countryCodeToEmoji(code: String): String {
    val cleanCode = code.lowercase().trim()
    if (cleanCode == "gb-sct") return "🏴\uDB40\uDC67\uDB40\uDC62\uDB40\uDC73\uDB40\uDC63\uDB40\uDC74\uDB40\uDC7F"
    if (cleanCode == "gb-eng") return "🏴\uDB40\uDC67\uDB40\uDC62\uDB40\uDC65\uDB40\uDC6E\uDB40\uDC67\uDB40\uDC7F"
    if (cleanCode == "gb-wls") return "🏴\uDB40\uDC67\uDB40\uDC62\uDB40\uDC77\uDB40\uDC6C\uDB40\uDC73\uDB40\uDC7F"
    if (cleanCode.length != 2) return ""
    val firstChar = cleanCode[0].code - 'a'.code
    val secondChar = cleanCode[1].code - 'a'.code
    val firstCodePoint = 0x1F1E6 + firstChar
    val secondCodePoint = 0x1F1E6 + secondChar
    return String(Character.toChars(firstCodePoint)) + String(Character.toChars(secondCodePoint))
}

// Helper to format countdown timer for future kickoff
private fun formatCountdown(kickoffTs: Long, currentMs: Long): String {
    val diff = kickoffTs - currentMs
    if (diff <= 0) return "STARTING SOON"
    val seconds = (diff / 1000) % 60
    val minutes = (diff / (1000 * 60)) % 60
    val hours = (diff / (1000 * 60 * 60)) % 24
    val days = diff / (1000 * 60 * 60 * 24)
    return buildString {
        if (days > 0) append("${days}d ")
        if (hours > 0 || days > 0) append(String.format("%02dh ", hours))
        append(String.format("%02dm %02ds", minutes, seconds))
    }
}

private fun formatUtcToIst(timestampMs: Long, pattern: String): String {
    if (timestampMs <= 0L) return ""
    val sdf = SimpleDateFormat(pattern, Locale.US)
    sdf.timeZone = TimeZone.getTimeZone("Asia/Kolkata")
    return sdf.format(Date(timestampMs))
}

