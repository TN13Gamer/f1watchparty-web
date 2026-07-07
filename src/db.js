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
}

