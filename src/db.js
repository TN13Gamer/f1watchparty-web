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
}
