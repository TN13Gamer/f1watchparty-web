package com.example.watchparty.data

import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

object ApiDataFetcher {
    private const val TAG = "ApiDataFetcher"
    private const val FIRESTORE_URL = "https://firestore.googleapis.com/v1/projects/f1-stream-live/databases/(default)/documents/app_data/live_config"
    private const val FIFA_FIXTURES_URL = "https://f1watchparty-web-seven.vercel.app/api/fifa/fixtures"
    private const val FIFA_STANDINGS_URL = "https://f1watchparty-web-seven.vercel.app/api/fifa/standings"

    private fun makeRequest(urlStr: String): String? {
        var connection: HttpURLConnection? = null
        return try {
            val url = URL(urlStr)
            connection = url.openConnection() as HttpURLConnection
            connection.requestMethod = "GET"
            connection.connectTimeout = 2000
            connection.readTimeout = 3000
            connection.setRequestProperty("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
            connection.setRequestProperty("Accept", "application/json")
            
            if (connection.responseCode == 200) {
                connection.inputStream.bufferedReader().use { it.readText() }
            } else {
                Log.e(TAG, "Error requesting $urlStr: ${connection.responseCode}")
                null
            }
        } catch (e: Exception) {
            Log.e(TAG, "Exception requesting $urlStr", e)
            null
        } finally {
            connection?.disconnect()
        }
    }

    private fun optIntField(fieldObj: JSONObject?, default: Int): Int {
        if (fieldObj == null) return default
        val strVal = fieldObj.optString("stringValue")
        if (strVal.isNotEmpty()) return strVal.toIntOrNull() ?: default
        val intVal = fieldObj.optString("integerValue")
        if (intVal.isNotEmpty()) return intVal.toIntOrNull() ?: default
        val doubleVal = fieldObj.optString("doubleValue")
        if (doubleVal.isNotEmpty()) return doubleVal.toDoubleOrNull()?.toInt() ?: default
        return default
    }

    private fun optStringField(fieldObj: JSONObject?, default: String): String {
        if (fieldObj == null) return default
        val strVal = fieldObj.optString("stringValue")
        if (strVal.isNotEmpty()) return strVal
        val intVal = fieldObj.optString("integerValue")
        if (intVal.isNotEmpty()) return intVal
        return default
    }

    private fun loadLiveConfigFallback(context: android.content.Context): LiveConfig {
        try {
            val jsonStr = context.assets.open("fallback_live_config.json").bufferedReader().use { it.readText() }
            return parseFirestoreJson(JSONObject(jsonStr))
        } catch (e: Exception) {
            Log.e(TAG, "Error loading LiveConfig fallback", e)
        }
        return LiveConfig(
            twitchChannel = "watchf1olive",
            streamLinks = listOf(
                StreamLink("F1 Live Stream 1", "https://player.twitch.tv/?channel=watchf1olive&parent=watchf1.live"),
                StreamLink("F1 Live Stream 2", "https://player.twitch.tv/?channel=watchf1olive&parent=watchf1.live")
            ),
            nextRace = NextRace("", "", "", "", ""),
            standings = emptyList(),
            constructors = emptyList(),
            fifaTwitchChannel = "watchf1olive",
            fifaStreamLinks = listOf(
                StreamLink("FIFA Stream 1", "https://player.twitch.tv/?channel=watchf1olive&parent=watchf1.live")
            ),
            customTimer = CustomTimer(false, "", ""),
            schedule = emptyList(),
            isLiveRaceActive = false,
            isFifaLive = false
        )
    }

    suspend fun fetchLiveConfig(context: android.content.Context? = null): LiveConfig? = withContext(Dispatchers.IO) {
        val response = makeRequest(FIRESTORE_URL)
        if (response == null) {
            if (context != null) {
                return@withContext loadLiveConfigFallback(context)
            }
            return@withContext null
        }
        try {
            return@withContext parseFirestoreJson(JSONObject(response))
        } catch (e: Exception) {
            Log.e(TAG, "Error parsing live config", e)
            if (context != null) {
                return@withContext loadLiveConfigFallback(context)
            }
        }
        return@withContext null
    }

    private fun loadFifaFixturesFallback(context: android.content.Context): List<FifaFixture> {
        val list = mutableListOf<FifaFixture>()
        try {
            // Load teams for flag and code lookup
            val teamsJsonStr = context.assets.open("fallback_teams.json").bufferedReader().use { it.readText() }
            val teamsObj = JSONObject(teamsJsonStr)
            val teamsArray = teamsObj.optJSONArray("teams") ?: JSONArray()
            val teamsById = mutableMapOf<String, JSONObject>()
            val teamsByName = mutableMapOf<String, JSONObject>()
            for (i in 0 until teamsArray.length()) {
                val t = teamsArray.getJSONObject(i)
                val idStr = t.optString("id", "")
                if (idStr.isNotEmpty()) {
                    teamsById[idStr] = t
                }
                val nameEn = t.optString("name_en", "").lowercase()
                if (nameEn.isNotEmpty()) {
                    teamsByName[nameEn] = t
                }
            }

            // Load games
            val gamesJsonStr = context.assets.open("fallback_games.json").bufferedReader().use { it.readText() }
            val gamesObj = JSONObject(gamesJsonStr)
            val gamesArray = gamesObj.optJSONArray("games") ?: JSONArray()

            for (i in 0 until gamesArray.length()) {
                val g = gamesArray.getJSONObject(i)
                val homeId = g.optString("home_team_id", "")
                val awayId = g.optString("away_team_id", "")
                val homeName = g.optString("home_team_name_en", g.optString("home_team_label", "TBD"))
                val awayName = g.optString("away_team_name_en", g.optString("away_team_label", "TBD"))

                // Flags
                val homeTeamObj = teamsById[homeId] ?: teamsByName[homeName.lowercase()]
                val awayTeamObj = teamsById[awayId] ?: teamsByName[awayName.lowercase()]
                val homeFlag = homeTeamObj?.optString("flag", "") ?: ""
                val awayFlag = awayTeamObj?.optString("flag", "") ?: ""

                val homeScoreVal = try { g.optString("home_score", "0").toInt() } catch(e: Exception) { g.optInt("home_score", 0) }
                val awayScoreVal = try { g.optString("away_score", "0").toInt() } catch(e: Exception) { g.optInt("away_score", 0) }

                val rawStatus = g.optString("time_elapsed", "").lowercase().trim()
                val finishedVal = g.optString("finished", "").uppercase().trim() == "TRUE" || rawStatus == "finished" || rawStatus == "ft"
                val status = if (rawStatus == "live" || rawStatus == "ht") "live" else if (finishedVal) "finished" else "notstarted"

                val rawDate = g.optString("local_date", "")
                val formattedDate = formatRawFifaDate(rawDate)

                list.add(
                    FifaFixture(
                        matchId = g.optString("id", ""),
                        homeTeam = homeName,
                        awayTeam = awayName,
                        homeFlag = homeFlag,
                        awayFlag = awayFlag,
                        status = status,
                        homeScore = homeScoreVal,
                        awayScore = awayScoreVal,
                        date = formattedDate,
                        kickoff = formattedDate,
                        kickoffTs = parseFifaDateToMs(rawDate, g.optString("stadium_id", "4"))
                    )
                )
            }
        } catch (e: Exception) {
            Log.e(TAG, "Error loading FIFA fixtures fallback", e)
        }
        return list
    }

    private fun parseFifaDateToMs(rawDate: String, stadiumId: String): Long {
        return try {
            val parts = rawDate.trim().split("\\s+".toRegex())
            if (parts.size < 2) return 0L
            val dateParts = parts[0].split("/").map { it.toInt() }
            val timeParts = parts[1].split(":").map { it.toInt() }
            if (dateParts.size < 3 || timeParts.size < 2) return 0L
            val month = dateParts[0] - 1
            val day = dateParts[1]
            val year = dateParts[2]
            val hour = timeParts[0]
            val minute = timeParts[1]
            
            val offsets = mapOf(
                "1" to -6, "2" to -6, "3" to -6, "4" to -5, "5" to -5, "6" to -5,
                "7" to -4, "8" to -4, "9" to -4, "10" to -4, "11" to -4, "12" to -4,
                "13" to -7, "14" to -7, "15" to -7, "16" to -7
            )
            val offset = offsets[stadiumId] ?: -4
            val cal = java.util.Calendar.getInstance(java.util.TimeZone.getTimeZone("UTC")).apply {
                clear()
                set(java.util.Calendar.YEAR, year)
                set(java.util.Calendar.MONTH, month)
                set(java.util.Calendar.DAY_OF_MONTH, day)
                set(java.util.Calendar.HOUR_OF_DAY, hour - offset)
                set(java.util.Calendar.MINUTE, minute)
            }
            cal.timeInMillis
        } catch (e: Exception) {
            0L
        }
    }

    private fun formatRawFifaDate(rawDate: String): String {
        return try {
            val parts = rawDate.trim().split(" ")
            val dateParts = parts[0].split("/")
            val timeStr = if (parts.size > 1) parts[1] else ""
            val day = dateParts[1].toInt()
            val month = dateParts[0].toInt()
            val months = arrayOf("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")
            val monthStr = months[month - 1]
            if (timeStr.isNotEmpty()) "$day $monthStr $timeStr" else "$day $monthStr"
        } catch (e: Exception) {
            rawDate
        }
    }

    private fun loadFifaStandingsFallback(context: android.content.Context): List<FifaStandingGroup> {
        val list = mutableListOf<FifaStandingGroup>()
        try {
            // Load teams map
            val teamsJsonStr = context.assets.open("fallback_teams.json").bufferedReader().use { it.readText() }
            val teamsObj = JSONObject(teamsJsonStr)
            val teamsArray = teamsObj.optJSONArray("teams") ?: JSONArray()
            val teamsById = mutableMapOf<String, JSONObject>()
            for (i in 0 until teamsArray.length()) {
                val t = teamsArray.getJSONObject(i)
                val idStr = t.optString("id", "")
                if (idStr.isNotEmpty()) {
                    teamsById[idStr] = t
                }
            }

            // Load groups
            val groupsJsonStr = context.assets.open("fallback_groups.json").bufferedReader().use { it.readText() }
            val groupsObj = JSONObject(groupsJsonStr)
            val groupsArray = groupsObj.optJSONArray("groups") ?: JSONArray()

            for (i in 0 until groupsArray.length()) {
                val g = groupsArray.getJSONObject(i)
                val groupLetter = g.optString("name", "")
                val groupName = "Group $groupLetter"
                val teamsArrayJson = g.optJSONArray("teams") ?: JSONArray()
                val teams = mutableListOf<FifaTeamStanding>()
                
                for (j in 0 until teamsArrayJson.length()) {
                    val t = teamsArrayJson.getJSONObject(j)
                    val teamId = t.optString("team_id", "")
                    val teamInfo = teamsById[teamId]
                    val teamName = teamInfo?.optString("name_en", "Team $teamId") ?: "Team $teamId"
                    val teamFlag = teamInfo?.optString("flag", "") ?: ""
                    
                    teams.add(
                        FifaTeamStanding(
                            position = j + 1,
                            name = teamName,
                            flag = teamFlag,
                            played = t.optInt("mp", 0),
                            points = t.optInt("pts", 0),
                            gd = t.optInt("gd", 0)
                        )
                    )
                }
                list.add(FifaStandingGroup(groupName, teams))
            }
        } catch (e: Exception) {
            Log.e(TAG, "Error loading FIFA standings fallback", e)
        }
        return list
    }

    suspend fun fetchFifaFixtures(context: android.content.Context? = null): List<FifaFixture> = withContext(Dispatchers.IO) {
        val list = mutableListOf<FifaFixture>()
        val response = makeRequest(FIFA_FIXTURES_URL)
        if (response == null) {
            if (context != null) {
                return@withContext loadFifaFixturesFallback(context)
            }
            return@withContext list
        }
        try {
            val array = JSONArray(response)
            for (i in 0 until array.length()) {
                val obj = array.getJSONObject(i)
                val homeScoreVal = try {
                    obj.optString("homeScore", "0").toInt()
                } catch (e: Exception) {
                    obj.optInt("homeScore", 0)
                }
                val awayScoreVal = try {
                    obj.optString("awayScore", "0").toInt()
                } catch (e: Exception) {
                    obj.optInt("awayScore", 0)
                }
                list.add(
                    FifaFixture(
                        matchId = if (obj.has("id")) obj.optString("id", "") else obj.optString("matchId", ""),
                        homeTeam = obj.optString("homeTeam", ""),
                        awayTeam = obj.optString("awayTeam", ""),
                        homeFlag = obj.optString("homeFlag", ""),
                        awayFlag = obj.optString("awayFlag", ""),
                        status = obj.optString("status", ""),
                        homeScore = homeScoreVal,
                        awayScore = awayScoreVal,
                        date = obj.optString("localDate", ""),
                        kickoff = obj.optString("localDate", ""),
                        kickoffTs = obj.optLong("kickoffTs", 0L)
                    )
                )
            }
        } catch (e: Exception) {
            Log.e(TAG, "Exception parsing fifa fixtures", e)
            if (context != null) {
                return@withContext loadFifaFixturesFallback(context)
            }
        }
        return@withContext list
    }

    suspend fun fetchFifaStandings(context: android.content.Context? = null): List<FifaStandingGroup> = withContext(Dispatchers.IO) {
        val list = mutableListOf<FifaStandingGroup>()
        val response = makeRequest(FIFA_STANDINGS_URL)
        if (response == null) {
            if (context != null) {
                return@withContext loadFifaStandingsFallback(context)
            }
            return@withContext list
        }
        try {
            val array = JSONArray(response)
            for (i in 0 until array.length()) {
                val groupObj = array.getJSONObject(i)
                val groupName = if (groupObj.has("name")) groupObj.optString("name", "") else groupObj.optString("group", "")
                val teamsArray = groupObj.optJSONArray("teams") ?: JSONArray()
                val teams = mutableListOf<FifaTeamStanding>()
                for (j in 0 until teamsArray.length()) {
                    val teamObj = teamsArray.getJSONObject(j)
                    teams.add(
                        FifaTeamStanding(
                            position = j + 1,
                            name = teamObj.optString("name", ""),
                            flag = teamObj.optString("flag", ""),
                            played = teamObj.optInt("mp", 0),
                            points = teamObj.optInt("pts", 0),
                            gd = teamObj.optInt("gd", 0)
                        )
                    )
                }
                list.add(FifaStandingGroup(groupName, teams))
            }
        } catch (e: Exception) {
            Log.e(TAG, "Exception parsing fifa standings", e)
            if (context != null) {
                return@withContext loadFifaStandingsFallback(context)
            }
        }
        return@withContext list
    }


    /**
     * Resolves a stream URL to a playable form for the Android app.
     *
     * For pushembdz.store embed URLs, we call the pushembdz API directly to get
     * the real HLS (.m3u8) URL — bypassing the browser-only JWPlayer + P2P embed
     * that cannot work inside Android WebView (Service Workers are disabled).
     */
    suspend fun resolveStreamUrl(embedUrl: String): ResolvedStream = withContext(Dispatchers.IO) {
        val pushEmbdzRegex = Regex("pushembdz\\.store/embed/([\\w\\-]+)")
        val match = pushEmbdzRegex.find(embedUrl)
        if (match != null) {
            val slug = match.groupValues[1]
            Log.d(TAG, "resolveStreamUrl: detected pushembdz slug=$slug")
            try {
                val apiUrl = "https://api.pushembdz.store/v1/stream/$slug"
                val response = makeStreamRequest(apiUrl)
                Log.d(TAG, "resolveStreamUrl: API response=$response")
                if (response != null) {
                    val json = JSONObject(response)
                    if (json.optBoolean("success", false)) {
                        val stream = json.optJSONObject("stream")
                        val link = stream?.optString("link", "") ?: ""
                        val method = stream?.optString("method", "") ?: ""
                        Log.d(TAG, "resolveStreamUrl: link=$link method=$method")
                        if (link.isNotEmpty()) {
                            if (link.contains(".m3u8") || method == "hls" || method == "player" || method == "jwp" || method == "jwp2p") {
                                return@withContext ResolvedStream(
                                    url = link,
                                    playerType = PlayerType.EXOPLAYER,
                                    referer = "https://pushembdz.store/"
                                )
                            }
                            return@withContext ResolvedStream(link, PlayerType.WEBVIEW)
                        }
                    } else {
                        Log.e(TAG, "resolveStreamUrl: API returned success=false: $response")
                    }
                } else {
                    Log.e(TAG, "resolveStreamUrl: API request returned null (timeout or network error)")
                }
            } catch (e: Exception) {
                Log.e(TAG, "resolveStreamUrl: Exception for slug=$slug", e)
            }
        }
        Log.d(TAG, "resolveStreamUrl: falling back to WebView for $embedUrl")
        return@withContext ResolvedStream(embedUrl, PlayerType.WEBVIEW)
    }

    /** Dedicated HTTP request for stream resolution — uses longer timeouts than makeRequest(). */
    private fun makeStreamRequest(urlStr: String): String? {
        var connection: java.net.HttpURLConnection? = null
        return try {
            val url = java.net.URL(urlStr)
            connection = url.openConnection() as java.net.HttpURLConnection
            connection.requestMethod = "GET"
            connection.connectTimeout = 8000
            connection.readTimeout = 10000
            connection.setRequestProperty("User-Agent", "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36")
            connection.setRequestProperty("Accept", "application/json")
            connection.setRequestProperty("Origin", "https://pushembdz.store")
            connection.setRequestProperty("Referer", "https://pushembdz.store/")
            val code = connection.responseCode
            Log.d(TAG, "makeStreamRequest: $urlStr -> HTTP $code")
            if (code == 200) {
                connection.inputStream.bufferedReader().use { it.readText() }
            } else {
                Log.e(TAG, "makeStreamRequest: HTTP $code for $urlStr")
                null
            }
        } catch (e: Exception) {
            Log.e(TAG, "makeStreamRequest: Exception for $urlStr", e)
            null
        } finally {
            connection?.disconnect()
        }
    }



    private fun parseFirestoreJson(json: JSONObject): LiveConfig {
        val fields = json.optJSONObject("fields") ?: JSONObject()

        // 1. twitchChannel
        val twitchChannel = optStringField(fields.optJSONObject("twitchChannel"), "watchf1olive")

        // 2. streamLinks
        val streamLinksList = mutableListOf<StreamLink>()
        val streamLinksObj = fields.optJSONObject("streamLinks")?.optJSONObject("arrayValue")
        val streamLinksArray = streamLinksObj?.optJSONArray("values")
        if (streamLinksArray != null) {
            for (i in 0 until streamLinksArray.length()) {
                val valObj = streamLinksArray.getJSONObject(i).optJSONObject("mapValue")?.optJSONObject("fields")
                if (valObj != null) {
                    val name = optStringField(valObj.optJSONObject("name"), "")
                    val url = optStringField(valObj.optJSONObject("url"), "")
                    if (name.isNotEmpty() && url.isNotEmpty()) {
                        streamLinksList.add(StreamLink(name, url))
                    }
                }
            }
        }

        // 3. nextRace
        val nextRaceObj = fields.optJSONObject("nextRace")?.optJSONObject("mapValue")?.optJSONObject("fields")
        val nextRace = if (nextRaceObj != null) {
            NextRace(
                name = optStringField(nextRaceObj.optJSONObject("name"), ""),
                circuit = optStringField(nextRaceObj.optJSONObject("circuit"), ""),
                location = optStringField(nextRaceObj.optJSONObject("location"), ""),
                date = optStringField(nextRaceObj.optJSONObject("date"), ""),
                dateObj = optStringField(nextRaceObj.optJSONObject("dateObj"), "")
            )
        } else {
            NextRace("", "", "", "", "")
        }

        // 4. standings
        val standingsList = mutableListOf<DriverStanding>()
        val standingsObj = fields.optJSONObject("standings")?.optJSONObject("arrayValue")
        val standingsArray = standingsObj?.optJSONArray("values")
        if (standingsArray != null) {
            for (i in 0 until standingsArray.length()) {
                val valObj = standingsArray.getJSONObject(i).optJSONObject("mapValue")?.optJSONObject("fields")
                if (valObj != null) {
                    standingsList.add(
                        DriverStanding(
                            position = i + 1,
                            name = optStringField(valObj.optJSONObject("name"), ""),
                            team = optStringField(valObj.optJSONObject("team"), ""),
                            points = optIntField(valObj.optJSONObject("points"), 0),
                            image = optStringField(valObj.optJSONObject("image"), "")
                        )
                    )
                }
            }
        }

        // 5. constructors
        val constructorsList = mutableListOf<ConstructorStanding>()
        val constructorsObj = fields.optJSONObject("constructors")?.optJSONObject("arrayValue")
        val constructorsArray = constructorsObj?.optJSONArray("values")
        if (constructorsArray != null) {
            for (i in 0 until constructorsArray.length()) {
                val valObj = constructorsArray.getJSONObject(i).optJSONObject("mapValue")?.optJSONObject("fields")
                if (valObj != null) {
                    constructorsList.add(
                        ConstructorStanding(
                            position = i + 1,
                            name = optStringField(valObj.optJSONObject("name"), ""),
                            points = optIntField(valObj.optJSONObject("points"), 0)
                        )
                    )
                }
            }
        }

        // 6. FIFA Config parsing (nested map)
        val fifaObj = fields.optJSONObject("fifa")?.optJSONObject("mapValue")?.optJSONObject("fields")
        val fifaTwitchChannel = if (fifaObj != null) {
            optStringField(fifaObj.optJSONObject("twitchChannel"), "watchf1olive")
        } else {
            "watchf1olive"
        }

        val fifaStreamLinksList = mutableListOf<StreamLink>()
        if (fifaObj != null) {
            val fifaStreamLinksObj = fifaObj.optJSONObject("streamLinks")?.optJSONObject("arrayValue")
            val fifaStreamLinksArray = fifaStreamLinksObj?.optJSONArray("values")
            if (fifaStreamLinksArray != null) {
                for (i in 0 until fifaStreamLinksArray.length()) {
                    val valObj = fifaStreamLinksArray.getJSONObject(i).optJSONObject("mapValue")?.optJSONObject("fields")
                    if (valObj != null) {
                        val name = optStringField(valObj.optJSONObject("name"), "")
                        val url = optStringField(valObj.optJSONObject("url"), "")
                        if (name.isNotEmpty() && url.isNotEmpty()) {
                            fifaStreamLinksList.add(StreamLink(name, url))
                        }
                    }
                }
            }
        }

        // 7. customTimer
        val customTimerObj = fields.optJSONObject("customTimer")?.optJSONObject("mapValue")?.optJSONObject("fields")
        val customTimer = if (customTimerObj != null) {
            val enabledVal = customTimerObj.optJSONObject("enabled")?.optBoolean("booleanValue", false) ?: false
            CustomTimer(
                enabled = enabledVal,
                label = optStringField(customTimerObj.optJSONObject("label"), ""),
                target = optStringField(customTimerObj.optJSONObject("target"), "")
            )
        } else {
            CustomTimer(false, "", "")
        }

        // 8. schedule
        val scheduleList = mutableListOf<ScheduleSession>()
        val scheduleObj = fields.optJSONObject("schedule")?.optJSONObject("arrayValue")
        val scheduleArray = scheduleObj?.optJSONArray("values")
        if (scheduleArray != null) {
            for (i in 0 until scheduleArray.length()) {
                val valObj = scheduleArray.getJSONObject(i).optJSONObject("mapValue")?.optJSONObject("fields")
                if (valObj != null) {
                    scheduleList.add(
                        ScheduleSession(
                            timer = optStringField(valObj.optJSONObject("timer"), ""),
                            date = optStringField(valObj.optJSONObject("date"), ""),
                            name = optStringField(valObj.optJSONObject("name"), ""),
                            endTime = optStringField(valObj.optJSONObject("endTime"), ""),
                            time = optStringField(valObj.optJSONObject("time"), ""),
                            day = optStringField(valObj.optJSONObject("day"), "")
                        )
                    )
                }
            }
        }

        // 9. live statuses
        val isLiveRaceActive = fields.optJSONObject("isLiveRaceActive")?.optBoolean("booleanValue", false) ?: false
        val fifaRaceDataObj = fifaObj?.optJSONObject("raceData")?.optJSONObject("mapValue")?.optJSONObject("fields")
        val isFifaLive = fifaRaceDataObj?.optJSONObject("isLive")?.optBoolean("booleanValue", false) ?: false

        return LiveConfig(
            twitchChannel = twitchChannel,
            streamLinks = streamLinksList,
            nextRace = nextRace,
            standings = standingsList,
            constructors = constructorsList,
            fifaTwitchChannel = fifaTwitchChannel,
            fifaStreamLinks = fifaStreamLinksList,
            customTimer = customTimer,
            schedule = scheduleList,
            isLiveRaceActive = isLiveRaceActive,
            isFifaLive = isFifaLive
        )
    }
}

// Data classes for layout representation
data class StreamLink(val name: String, val url: String)
data class NextRace(val name: String, val circuit: String, val location: String, val date: String, val dateObj: String)
data class DriverStanding(val position: Int, val name: String, val team: String, val points: Int, val image: String)
data class ConstructorStanding(val position: Int, val name: String, val points: Int)
data class CustomTimer(val enabled: Boolean, val label: String, val target: String)
data class ScheduleSession(val timer: String, val date: String, val name: String, val endTime: String, val time: String, val day: String)

data class FifaFixture(
    val matchId: String,
    val homeTeam: String,
    val awayTeam: String,
    val homeFlag: String,
    val awayFlag: String,
    val status: String,
    val homeScore: Int,
    val awayScore: Int,
    val date: String,
    val kickoff: String,
    val kickoffTs: Long
)

data class FifaTeamStanding(
    val position: Int,
    val name: String,
    val flag: String,
    val played: Int,
    val points: Int,
    val gd: Int
)

data class FifaStandingGroup(
    val name: String,
    val teams: List<FifaTeamStanding>
)

data class LiveConfig(
    val twitchChannel: String,
    val streamLinks: List<StreamLink>,
    val nextRace: NextRace,
    val standings: List<DriverStanding>,
    val constructors: List<ConstructorStanding>,
    val fifaTwitchChannel: String,
    val fifaStreamLinks: List<StreamLink>,
    val customTimer: CustomTimer,
    val schedule: List<ScheduleSession>,
    val isLiveRaceActive: Boolean,
    val isFifaLive: Boolean
)

enum class PlayerType { EXOPLAYER, WEBVIEW }

data class ResolvedStream(val url: String, val playerType: PlayerType, val referer: String = "")

