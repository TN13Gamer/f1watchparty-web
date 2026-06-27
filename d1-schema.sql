-- Table for live configuration fallbacks
CREATE TABLE IF NOT EXISTS live_config (
    key TEXT PRIMARY KEY,
    data TEXT NOT NULL, -- JSON string representation
    updated_at TEXT DEFAULT (datetime('now'))
);

-- Seed initial live_config row
INSERT OR IGNORE INTO live_config (key, data) VALUES ('live_config', '{}');

-- Table for FIFA poll aggregates
CREATE TABLE IF NOT EXISTS fifa_polls (
    match_id TEXT PRIMARY KEY,
    home INTEGER DEFAULT 0,
    away INTEGER DEFAULT 0,
    draw INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

-- Table for user votes
CREATE TABLE IF NOT EXISTS fifa_votes (
    match_id TEXT NOT NULL,
    voter_id TEXT NOT NULL,
    choice TEXT NOT NULL CHECK (choice IN ('home', 'away', 'draw')),
    voted_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (match_id, voter_id),
    FOREIGN KEY (match_id) REFERENCES fifa_polls(match_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_fifa_votes_match_id ON fifa_votes(match_id);

-- Table for chat messages
CREATE TABLE IF NOT EXISTS chat_messages (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    text TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    color TEXT,
    isAdmin INTEGER DEFAULT 0
);
