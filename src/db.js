/**
 * src/db.js
 * Database utility layer wrapping Cloudflare D1 SQL operations.
 * Implements config storage, polls, voting, and chat tables.
 */

export class D1Database {
  constructor(d1) {
    this.d1 = d1;
  }

  // --- CONFIG ---
  async getConfig() {
    try {
      const row = await this.d1
        .prepare("SELECT data FROM live_config WHERE key = 'live_config'")
        .first();
      return row && row.data ? JSON.parse(row.data) : {};
    } catch (err) {
      console.error("[D1 getConfig] Error:", err.message);
      return {};
    }
  }

  async updateConfig(updateData) {
    const current = await this.getConfig();
    const merged = { ...current };

    for (const key in updateData) {
      if (updateData[key] && typeof updateData[key] === "object" && !Array.isArray(updateData[key])) {
        merged[key] = {
          ...(merged[key] || {}),
          ...updateData[key]
        };
      } else {
        merged[key] = updateData[key];
      }
    }

    await this.d1
      .prepare("INSERT OR REPLACE INTO live_config (key, data, updated_at) VALUES ('live_config', ?, datetime('now'))")
      .bind(JSON.stringify(merged))
      .run();

    return merged;
  }

  async setConfig(setData) {
    await this.d1
      .prepare("INSERT OR REPLACE INTO live_config (key, data, updated_at) VALUES ('live_config', ?, datetime('now'))")
      .bind(JSON.stringify(setData))
      .run();
  }

  // --- POLLS & VOTES ---
  async getPoll(matchId) {
    const row = await this.d1
      .prepare("SELECT home, away, draw FROM fifa_polls WHERE match_id = ?")
      .bind(matchId)
      .first();

    const home = row ? parseInt(row.home || 0, 10) : 0;
    const away = row ? parseInt(row.away || 0, 10) : 0;
    const draw = row ? parseInt(row.draw || 0, 10) : 0;

    return {
      home,
      away,
      draw,
      total: home + away + draw
    };
  }

  async castVote(matchId, voterId, choice) {
    // 1. Ensure poll entry exists
    await this.d1
      .prepare("INSERT OR IGNORE INTO fifa_polls (match_id) VALUES (?)")
      .bind(matchId)
      .run();

    // 2. Check if user already voted
    const existing = await this.d1
      .prepare("SELECT choice FROM fifa_votes WHERE match_id = ? AND voter_id = ?")
      .bind(matchId, voterId)
      .first();

    let alreadyVoted = null;
    if (existing) {
      alreadyVoted = existing.choice;
    } else {
      // 3. Record vote & update aggregate counts in a transaction batch
      const insertVote = this.d1
        .prepare("INSERT INTO fifa_votes (match_id, voter_id, choice) VALUES (?, ?, ?)")
        .bind(matchId, voterId, choice);

      const updatePoll = this.d1
        .prepare(`
          UPDATE fifa_polls 
          SET 
            home = home + (CASE WHEN ? = 'home' THEN 1 ELSE 0 END),
            away = away + (CASE WHEN ? = 'away' THEN 1 ELSE 0 END),
            draw = draw + (CASE WHEN ? = 'draw' THEN 1 ELSE 0 END),
            updated_at = datetime('now')
          WHERE match_id = ?
        `)
        .bind(choice, choice, choice, matchId);

      await this.d1.batch([insertVote, updatePoll]);
    }

    const poll = await this.getPoll(matchId);
    return {
      ...poll,
      voted: alreadyVoted || choice
    };
  }

  // --- CHAT ---
  async getChatMessages(limit = 60) {
    const { results } = await this.d1
      .prepare(`
        SELECT id, username, text, timestamp, color, isAdmin 
        FROM chat_messages 
        ORDER BY timestamp DESC 
        LIMIT ?
      `)
      .bind(limit)
      .all();

    return (results || []).map(m => ({
      id: m.id,
      username: m.username,
      text: m.text,
      timestamp: parseInt(m.timestamp, 10),
      color: m.color || "#a970ff",
      isAdmin: !!m.isAdmin
    })).reverse();
  }

  async addChatMessage(message) {
    const newMessage = {
      id: message.id || Math.random().toString(36).substring(2, 15),
      username: message.username,
      text: message.text,
      timestamp: Date.now(),
      color: message.color || "#a970ff",
      isAdmin: message.isAdmin ? 1 : 0
    };

    await this.d1
      .prepare(`
        INSERT INTO chat_messages (id, username, text, timestamp, color, isAdmin)
        VALUES (?, ?, ?, ?, ?, ?)
      `)
      .bind(
        newMessage.id,
        newMessage.username,
        newMessage.text,
        newMessage.timestamp,
        newMessage.color,
        newMessage.isAdmin
      )
      .run();

    return {
      ...newMessage,
      isAdmin: !!newMessage.isAdmin
    };
  }

  async deleteChatMessage(id) {
    await this.d1
      .prepare("DELETE FROM chat_messages WHERE id = ?")
      .bind(id)
      .run();
    return true;
  }

  async clearChatMessages() {
    await this.d1
      .prepare("DELETE FROM chat_messages")
      .run();
    return true;
  }

  // --- AUTOMATED MATCHES ---
  async getMatches(status = null) {
    try {
      let query = "SELECT * FROM matches ORDER BY kickoff ASC";
      let bindParams = [];
      if (status) {
        query = "SELECT * FROM matches WHERE status = ? ORDER BY kickoff ASC";
        bindParams = [status];
      }
      const { results } = await this.d1.prepare(query).bind(...bindParams).all();
      return results || [];
    } catch (err) {
      console.error("[D1 getMatches] Error:", err.message);
      return [];
    }
  }

  async getMatch(id) {
    try {
      return await this.d1.prepare("SELECT * FROM matches WHERE id = ?").bind(id).first();
    } catch (err) {
      console.error("[D1 getMatch] Error:", err.message);
      return null;
    }
  }

  async saveMatch(match) {
    try {
      await this.d1
        .prepare(`
          INSERT INTO matches (id, homeTeam, awayTeam, homeLogo, awayLogo, homeFlag, awayFlag, kickoff, status, score, venue, city, country, groupName, stage, competition, matchday, referee, attendance, weather, broadcasters, description, thumbnail, banner, fotmobPageUrl, detailsFetched, lastSynced)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
          ON CONFLICT(id) DO UPDATE SET
            homeTeam = excluded.homeTeam,
            awayTeam = excluded.awayTeam,
            homeLogo = excluded.homeLogo,
            awayLogo = excluded.awayLogo,
            homeFlag = excluded.homeFlag,
            awayFlag = excluded.awayFlag,
            kickoff = excluded.kickoff,
            status = excluded.status,
            score = excluded.score,
            venue = CASE WHEN excluded.venue IS NOT NULL AND excluded.venue != '' THEN excluded.venue ELSE matches.venue END,
            city = CASE WHEN excluded.city IS NOT NULL THEN excluded.city ELSE matches.city END,
            country = CASE WHEN excluded.country IS NOT NULL THEN excluded.country ELSE matches.country END,
            groupName = excluded.groupName,
            stage = excluded.stage,
            competition = excluded.competition,
            matchday = excluded.matchday,
            referee = CASE WHEN excluded.referee IS NOT NULL THEN excluded.referee ELSE matches.referee END,
            attendance = CASE WHEN excluded.attendance IS NOT NULL THEN excluded.attendance ELSE matches.attendance END,
            weather = CASE WHEN excluded.weather IS NOT NULL THEN excluded.weather ELSE matches.weather END,
            broadcasters = excluded.broadcasters,
            description = excluded.description,
            thumbnail = excluded.thumbnail,
            banner = excluded.banner,
            fotmobPageUrl = excluded.fotmobPageUrl,
            detailsFetched = excluded.detailsFetched,
            lastSynced = datetime('now')
        `)
        .bind(
          match.id,
          match.homeTeam,
          match.awayTeam,
          match.homeLogo || null,
          match.awayLogo || null,
          match.homeFlag || null,
          match.awayFlag || null,
          match.kickoff,
          match.status || 'notstarted',
          match.score || '0 - 0',
          match.venue || 'Venue to be confirmed',
          match.city || null,
          match.country || null,
          match.groupName || null,
          match.stage || null,
          match.competition || "FIFA World Cup",
          match.matchday || null,
          match.referee || null,
          match.attendance || null,
          match.weather || null,
          match.broadcasters || null,
          match.description || null,
          match.thumbnail || null,
          match.banner || null,
          match.fotmobPageUrl || null,
          match.detailsFetched ? 1 : 0
        )
        .run();
    } catch (err) {
      console.error("[D1 saveMatch] Error:", err.message);
    }
  }


  // --- AUTOMATED STREAMS ---
  async getStreams(matchId) {
    try {
      const { results } = await this.d1
        .prepare("SELECT * FROM streams WHERE matchId = ? AND working = 1 ORDER BY mirror ASC, quality DESC")
        .bind(matchId)
        .all();
      return results || [];
    } catch (err) {
      console.error("[D1 getStreams] Error:", err.message);
      return [];
    }
  }

  async saveStream(stream) {
    try {
      await this.d1
        .prepare(`
          INSERT INTO streams (matchId, provider, quality, embedUrl, mirror, lastChecked, working, status, isPrimary, priority, language)
          VALUES (?, ?, ?, ?, ?, datetime('now'), 1, 1, ?, ?, ?)
          ON CONFLICT(embedUrl) DO UPDATE SET
            quality = excluded.quality,
            mirror = excluded.mirror,
            lastChecked = excluded.lastChecked,
            working = 1,
            isPrimary = excluded.isPrimary,
            priority = excluded.priority,
            language = excluded.language
        `)
        .bind(
          stream.matchId,
          stream.provider,
          stream.quality || "720P",
          stream.embedUrl,
          stream.mirror || 0,
          stream.isPrimary || 0,
          stream.priority || 0,
          stream.language || "EN"
        )
        .run();
    } catch (err) {
      console.error("[D1 saveStream] Error:", err.message);
    }
  }


  async clearStreamsForMatch(matchId) {
    try {
      await this.d1.prepare("DELETE FROM streams WHERE matchId = ?").bind(matchId).run();
    } catch (err) {
      console.error("[D1 clearStreamsForMatch] Error:", err.message);
    }
  }

  // --- STANDINGS ---
  async getStandings() {
    try {
      const { results } = await this.d1
        .prepare("SELECT * FROM standings ORDER BY groupName ASC, points DESC, goalDifference DESC")
        .all();
      return results || [];
    } catch (err) {
      console.error("[D1 getStandings] Error:", err.message);
      return [];
    }
  }

  async saveStanding(row) {
    try {
      await this.d1
        .prepare(`
          INSERT INTO standings (team, played, wins, draws, losses, goalsFor, goalsAgainst, goalDifference, points, groupName, flag)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(team, groupName) DO UPDATE SET
            played = excluded.played,
            wins = excluded.wins,
            draws = excluded.draws,
            losses = excluded.losses,
            goalsFor = excluded.goalsFor,
            goalsAgainst = excluded.goalsAgainst,
            goalDifference = excluded.goalDifference,
            points = excluded.points,
            flag = excluded.flag
        `)
        .bind(
          row.team,
          row.played || 0,
          row.wins || 0,
          row.draws || 0,
          row.losses || 0,
          row.goalsFor || 0,
          row.goalsAgainst || 0,
          row.goalDifference || 0,
          row.points || 0,
          row.groupName,
          row.flag || ""
        )
        .run();
    } catch (err) {
      console.error("[D1 saveStanding] Error:", err.message);
    }
  }

  async cleanExpiredMatchesAndStreams() {
    try {
      const now = Date.now();
      // Remove streams of matches that finished more than 4 hours ago
      const expiredTime = now - (4 * 60 * 60 * 1000);
      await this.d1
        .prepare("DELETE FROM streams WHERE matchId IN (SELECT id FROM matches WHERE status = 'finished' AND kickoff < ?)")
        .bind(expiredTime)
        .run();
    } catch (err) {
      console.error("[D1 cleanExpired] Error:", err.message);
    }
  }

  async deleteStream(embedUrl) {
    try {

      await this.d1.prepare("DELETE FROM streams WHERE embedUrl = ?").bind(embedUrl).run();
      return true;
    } catch (err) {
      console.error("[D1 deleteStream] Error:", err.message);
      return false;
    }
  }

  async updateStreamStatus(embedUrl, status) {
    try {
      await this.d1.prepare("UPDATE streams SET status = ? WHERE embedUrl = ?").bind(status, embedUrl).run();
      return true;
    } catch (err) {
      console.error("[D1 updateStreamStatus] Error:", err.message);
      return false;
    }
  }

  async setStreamPrimary(matchId, embedUrl) {
    try {
      const reset = this.d1.prepare("UPDATE streams SET isPrimary = 0 WHERE matchId = ?").bind(matchId);
      const set = this.d1.prepare("UPDATE streams SET isPrimary = 1 WHERE embedUrl = ?").bind(embedUrl);
      await this.d1.batch([reset, set]);
      return true;
    } catch (err) {
      console.error("[D1 setStreamPrimary] Error:", err.message);
      return false;
    }
  }

  async updateMatchDetails(id, fields) {
    try {
      await this.d1
        .prepare(`
          UPDATE matches 
          SET 
            venue = ?,
            city = ?,
            country = ?,
            kickoff = ?, 
            groupName = ?, 
            stage = ?,
            referee = ?,
            attendance = ?,
            weather = ?,
            broadcasters = ?, 
            description = ?, 
            thumbnail = ?, 
            banner = ?,
            detailsFetched = 1,
            lastSynced = datetime('now')
          WHERE id = ?
        `)
        .bind(
          fields.venue || 'Venue to be confirmed',
          fields.city || null,
          fields.country || null,
          fields.kickoff,
          fields.groupName || null,
          fields.stage || null,
          fields.referee || null,
          fields.attendance || null,
          fields.weather || null,
          fields.broadcasters || null,
          fields.description || null,
          fields.thumbnail || null,
          fields.banner || null,
          id
        )
        .run();
      return true;
    } catch (err) {
      console.error("[D1 updateMatchDetails] Error:", err.message);
      return false;
    }
  }

  // Get all streams for a match including disabled ones (for admin panel)
  async getAllStreams(matchId) {
    try {
      const { results } = await this.d1
        .prepare("SELECT *, datetime(lastChecked) as lastCheckedFormatted FROM streams WHERE matchId = ? ORDER BY priority DESC, isPrimary DESC, mirror ASC")
        .bind(matchId)
        .all();
      return results || [];
    } catch (err) {
      console.error("[D1 getAllStreams] Error:", err.message);
      return [];
    }
  }

  // Admin: manually save a stream (bypasses auto-sync)
  async adminSaveStream(stream) {
    try {
      await this.d1
        .prepare(`
          INSERT INTO streams (matchId, provider, quality, embedUrl, mirror, lastChecked, working, status, isPrimary, priority, language)
          VALUES (?, ?, ?, ?, ?, datetime('now'), 1, 1, ?, ?, ?)
          ON CONFLICT(embedUrl) DO UPDATE SET
            provider = excluded.provider,
            quality = excluded.quality,
            mirror = excluded.mirror,
            lastChecked = datetime('now'),
            working = 1,
            status = 1,
            isPrimary = excluded.isPrimary,
            priority = excluded.priority,
            language = excluded.language
        `)
        .bind(
          stream.matchId,
          stream.provider || 'Custom',
          stream.quality || '720P',
          stream.embedUrl,
          stream.mirror || 0,
          stream.isPrimary || 0,
          stream.priority || 0,
          stream.language || 'EN'
        )
        .run();
      return true;
    } catch (err) {
      console.error("[D1 adminSaveStream] Error:", err.message);
      return false;
    }
  }
}

