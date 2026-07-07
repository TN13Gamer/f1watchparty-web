-- Table for live configuration fallbacks
CREATE TABLE IF NOT EXISTS live_config (
    key TEXT PRIMARY KEY,
    data TEXT NOT NULL, -- JSON string representation
    updated_at TEXT DEFAULT (datetime('now'))
);

-- Seed initial live_config row
INSERT OR IGNORE INTO live_config (key, data) VALUES ('live_config', '{}');

