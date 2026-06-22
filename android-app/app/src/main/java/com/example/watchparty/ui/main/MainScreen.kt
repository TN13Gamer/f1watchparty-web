package com.example.watchparty.ui.main

import androidx.compose.animation.*
import androidx.compose.animation.core.*
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowForward
import androidx.compose.material.icons.filled.DirectionsCar
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.SportsSoccer
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.RectangleShape
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.navigation3.runtime.NavKey
import com.example.watchparty.F1
import com.example.watchparty.Fifa
import com.example.watchparty.R
import com.example.watchparty.ui.utils.bounceClick
import androidx.compose.ui.platform.LocalContext
import com.example.watchparty.data.ApiDataFetcher
import java.text.SimpleDateFormat
import java.util.Date
import java.util.TimeZone
import java.util.Locale

@Composable
fun MainScreen(
  onItemClick: (NavKey) -> Unit,
  modifier: Modifier = Modifier,
) {
  val context = LocalContext.current
  var visible by remember { mutableStateOf(false) }
  var isF1Live by remember { mutableStateOf(false) }
  var isFifaLive by remember { mutableStateOf(false) }
  var nextF1TimeStr by remember { mutableStateOf("") }
  var nextFifaTimeStr by remember { mutableStateOf("") }

  // Trigger entrance animations when view becomes active
  LaunchedEffect(Unit) {
    visible = true
    val config = ApiDataFetcher.fetchLiveConfig(context)
    if (config != null) {
      isF1Live = config.isLiveRaceActive && config.streamLinks.isNotEmpty()
      isFifaLive = config.isFifaLive && config.fifaStreamLinks.isNotEmpty()

      // Find next F1 upcoming schedule session
      val upcomingF1 = config.schedule.mapNotNull { session ->
        val parsed = parseResilientDate(session.timer)
        if (parsed != null && parsed.time > System.currentTimeMillis()) {
          session to parsed
        } else null
      }.minByOrNull { it.second.time }

      if (upcomingF1 != null) {
        nextF1TimeStr = formatUtcToIst(upcomingF1.second.time, "d MMM HH:mm 'IST'")
      } else {
        // Fallback to the main Race session from the fixture
        val raceSession = config.schedule.firstOrNull { it.name.lowercase() == "race" }
        val raceDate = raceSession?.let { parseResilientDate(it.timer) }
        if (raceDate != null) {
          nextF1TimeStr = formatUtcToIst(raceDate.time, "d MMM HH:mm 'IST'")
        } else if (config.nextRace.date.isNotEmpty()) {
          nextF1TimeStr = config.nextRace.date
        }
      }
    }

    try {
      // Find next FIFA upcoming match from fixtures API
      val fixtures = ApiDataFetcher.fetchFifaFixtures(context)
      val upcomingFifa = fixtures.filter { 
        it.status.lowercase() == "notstarted"
      }.minByOrNull { it.kickoffTs }

      if (upcomingFifa != null) {
        nextFifaTimeStr = formatUtcToIst(upcomingFifa.kickoffTs, "d MMM HH:mm 'IST'")
      } else {
        // Fallback to the first match in the fixtures list that is not finished
        val nextMatch = fixtures.firstOrNull { it.status.lowercase() != "finished" }
        if (nextMatch != null) {
          nextFifaTimeStr = formatUtcToIst(nextMatch.kickoffTs, "d MMM HH:mm 'IST'")
        }
      }
    } catch (e: Exception) {
      // ignore
    }
  }

  Box(
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

        // 3. Ambient Purple Glow (Bottom-Right)
        drawCircle(
          brush = Brush.radialGradient(
            colors = listOf(
              Color(0xFF8000FF).copy(alpha = 0.08f),
              Color.Transparent
            ),
            center = Offset(size.width + 150.dp.toPx(), size.height + 200.dp.toPx()),
            radius = 500.dp.toPx()
          ),
          radius = 500.dp.toPx(),
          center = Offset(size.width + 150.dp.toPx(), size.height + 200.dp.toPx())
        )
      }
  ) {
    // Scrollable Main Content
    Column(
      modifier = Modifier
        .fillMaxSize()
        .verticalScroll(rememberScrollState())
        .padding(horizontal = 24.dp, vertical = 32.dp),
      horizontalAlignment = Alignment.CenterHorizontally
    ) {
      Spacer(modifier = Modifier.height(20.dp))

      // 1. Header with Slide-Down & Fade-In Animation
      AnimatedVisibility(
        visible = visible,
        enter = slideInVertically(
          animationSpec = spring(
            dampingRatio = Spring.DampingRatioLowBouncy,
            stiffness = Spring.StiffnessLow
          )
        ) { -100 } + fadeIn(animationSpec = tween(600))
      ) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
          Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.Center,
            modifier = Modifier.fillMaxWidth()
          ) {
            Icon(
              imageVector = Icons.Filled.PlayArrow,
              contentDescription = "Logo Icon",
              tint = Color(0xFFE60000), // F1 Red
              modifier = Modifier.size(32.dp)
            )
            Spacer(modifier = Modifier.width(8.dp))
            Text(
              text = "WATCHF1",
              fontSize = 32.sp,
              fontWeight = FontWeight.Black,
              color = Color.White,
              letterSpacing = 1.sp
            )
            Text(
              text = ".LIVE",
              fontSize = 32.sp,
              fontWeight = FontWeight.Black,
              color = Color(0xFFE60000),
              letterSpacing = 1.sp
            )
          }

          Text(
            text = "Select your arena. Connect with fans. Enjoy high-performance streaming in real-time.",
            fontSize = 14.sp,
            color = Color(0xFF8E8E93),
            textAlign = TextAlign.Center,
            modifier = Modifier
              .padding(top = 12.dp, bottom = 32.dp)
              .fillMaxWidth()
          )
        }
      }

      // 2. F1 Watch Party Card with Slide-Up, Fade-In & Spring Bounce
      AnimatedVisibility(
        visible = visible,
        enter = slideInVertically(
          animationSpec = spring(
            dampingRatio = Spring.DampingRatioLowBouncy,
            stiffness = Spring.StiffnessLow
          )
        ) { 150 } + fadeIn(animationSpec = tween(800, delayMillis = 100))
      ) {
        SportCard(
          title = "Formula 1",
          description = "Live timing, Grand Prix race streams, schedule countdowns, and championship standings.",
          iconResId = R.drawable.f1_logo,
          isCircleIcon = false,
          isLive = isF1Live,
          upcomingTime = nextF1TimeStr,
          buttonText = "Enter Arena",
          buttonBgColor = Color(0xFFE60000),
          buttonTextColor = Color.White,
          glowColor = Color(0xFFE60000),
          onClick = { onItemClick(F1) },
          modifier = Modifier.padding(bottom = 28.dp)
        )
      }

      // 3. FIFA Football Card with Slide-Up, Fade-In & Spring Bounce
      AnimatedVisibility(
        visible = visible,
        enter = slideInVertically(
          animationSpec = spring(
            dampingRatio = Spring.DampingRatioLowBouncy,
            stiffness = Spring.StiffnessLow
          )
        ) { 150 } + fadeIn(animationSpec = tween(800, delayMillis = 250))
      ) {
        SportCard(
          title = "FIFA 2026",
          description = "Live soccer streams, match details, match schedules, and real-time custom fan chat.",
          iconResId = R.drawable.fifa_logo,
          isCircleIcon = true,
          isLive = isFifaLive,
          upcomingTime = nextFifaTimeStr,
          buttonText = "Enter Arena",
          buttonBgColor = Color(0xFF8000FF),
          buttonTextColor = Color.White,
          glowColor = Color(0xFF8000FF),
          onClick = { onItemClick(Fifa) },
          modifier = Modifier.padding(bottom = 32.dp)
        )
      }

      // 4. Disclaimer Footer
      Text(
        text = "This app does not create, host, or share any video content. All video streams are from external websites that are freely available online.",
        fontSize = 11.sp,
        color = Color.White.copy(alpha = 0.3f),
        textAlign = TextAlign.Center,
        lineHeight = 16.sp,
        modifier = Modifier
          .padding(top = 16.dp, bottom = 24.dp)
          .widthIn(max = 280.dp)
      )
    }
  }
}

@Composable
fun SportCard(
  title: String,
  description: String,
  iconResId: Int,
  isCircleIcon: Boolean,
  buttonText: String,
  buttonBgColor: Color,
  buttonTextColor: Color,
  glowColor: Color,
  onClick: () -> Unit,
  modifier: Modifier = Modifier,
  isLive: Boolean = false,
  upcomingTime: String = ""
) {
  Card(
    shape = RoundedCornerShape(28.dp),
    colors = CardDefaults.cardColors(containerColor = Color(0x990A0A0A)),
    modifier = modifier
      .fillMaxWidth()
      .bounceClick(onClick)
      .border(
        width = 1.dp,
        brush = Brush.linearGradient(
          colors = listOf(
            glowColor.copy(alpha = 0.4f),
            Color.White.copy(alpha = 0.05f)
          )
        ),
        shape = RoundedCornerShape(28.dp)
      )
      .drawBehind {
        // Draw top-right radial spotlight with accent color at 8% opacity
        drawCircle(
          brush = Brush.radialGradient(
            colors = listOf(
              glowColor.copy(alpha = 0.08f),
              Color.Transparent
            ),
            center = Offset(size.width * 0.9f, size.height * 0.1f),
            radius = size.width * 0.6f
          ),
          radius = size.width * 0.6f,
          center = Offset(size.width * 0.9f, size.height * 0.1f)
        )
      }
  ) {
    Column(
      modifier = Modifier
        .fillMaxWidth()
        .padding(horizontal = 28.dp, vertical = 28.dp),
      horizontalAlignment = Alignment.Start
    ) {
      Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.Top
      ) {
        // Icon Box
        Box(
          modifier = Modifier
            .size(72.dp)
            .clip(if (isCircleIcon) CircleShape else RoundedCornerShape(16.dp))
            .background(Color.Transparent)
            .border(
              width = 1.dp,
              color = Color.White.copy(alpha = 0.08f),
              shape = if (isCircleIcon) CircleShape else RoundedCornerShape(16.dp)
            ),
          contentAlignment = Alignment.Center
        ) {
          Image(
            painter = painterResource(id = iconResId),
            contentDescription = "$title Logo",
            modifier = Modifier.fillMaxSize(),
            contentScale = ContentScale.Crop
          )
        }

        // Live badge
        if (isLive) {
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
          Box(
            modifier = Modifier
              .clip(RoundedCornerShape(8.dp))
              .background(Color(0xFFE60000).copy(alpha = pulseAlpha))
              .padding(horizontal = 10.dp, vertical = 5.dp)
          ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
              Box(
                modifier = Modifier
                  .size(6.dp)
                  .clip(CircleShape)
                  .background(Color.White)
              )
              Spacer(modifier = Modifier.width(6.dp))
              Text(
                text = "LIVE NOW",
                color = Color.White,
                fontWeight = FontWeight.Bold,
                fontSize = 10.sp,
                letterSpacing = 0.5.sp
              )
            }
          }
        } else {
          val displayUpcomingText = if (upcomingTime.isNotEmpty()) {
            "UPCOMING: $upcomingTime"
          } else {
            "UPCOMING"
          }
          Box(
            modifier = Modifier
              .clip(RoundedCornerShape(8.dp))
              .background(glowColor.copy(alpha = 0.15f))
              .border(1.dp, glowColor.copy(alpha = 0.3f), RoundedCornerShape(8.dp))
              .padding(horizontal = 10.dp, vertical = 5.dp)
          ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
              Box(
                modifier = Modifier
                  .size(6.dp)
                  .clip(CircleShape)
                  .background(glowColor)
              )
              Spacer(modifier = Modifier.width(6.dp))
              Text(
                text = displayUpcomingText,
                color = Color.White,
                fontWeight = FontWeight.Bold,
                fontSize = 10.sp,
                letterSpacing = 0.5.sp
              )
            }
          }
        }
      }

      Spacer(modifier = Modifier.height(20.dp))

      // Title
      Text(
        text = title,
        fontSize = 22.sp,
        fontWeight = FontWeight.ExtraBold,
        color = Color.White,
        letterSpacing = 0.5.sp,
        textAlign = TextAlign.Start
      )

      Spacer(modifier = Modifier.height(8.dp))

      // Description
      Text(
        text = description,
        fontSize = 14.sp,
        color = Color(0xFF8E8E93),
        lineHeight = 20.sp,
        textAlign = TextAlign.Start,
        modifier = Modifier.fillMaxWidth(0.9f)
      )

      Spacer(modifier = Modifier.height(24.dp))

      // Action Button (Bottom-Right)
      Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.End
      ) {
        Box(
          modifier = Modifier
            .clip(RoundedCornerShape(20.dp))
            .background(buttonBgColor)
            .padding(horizontal = 20.dp, vertical = 10.dp),
          contentAlignment = Alignment.Center
        ) {
          Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.Center
          ) {
            Text(
              text = buttonText.uppercase(),
              color = buttonTextColor,
              fontWeight = FontWeight.Bold,
              fontSize = 13.sp,
              letterSpacing = 0.5.sp
            )
            Spacer(modifier = Modifier.width(6.dp))
            Icon(
              imageVector = Icons.AutoMirrored.Filled.ArrowForward,
              contentDescription = null,
              tint = buttonTextColor,
              modifier = Modifier.size(14.dp)
            )
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

private fun formatUtcToIst(timestampMs: Long, pattern: String): String {
    val sdf = SimpleDateFormat(pattern, Locale.US)
    sdf.timeZone = TimeZone.getTimeZone("Asia/Kolkata")
    return sdf.format(Date(timestampMs))
}
