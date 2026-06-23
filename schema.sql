-- Table to store global live configuration (replaces Firestore app_data/live_config)
CREATE TABLE IF NOT EXISTS live_config (
    key TEXT PRIMARY KEY,
    data JSONB NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Seed initial live_config row if not present
INSERT INTO live_config (key, data)
VALUES ('live_config', '{}'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- Table to store FIFA poll aggregates
CREATE TABLE IF NOT EXISTS fifa_polls (
    match_id TEXT PRIMARY KEY,
    home INTEGER DEFAULT 0,
    away INTEGER DEFAULT 0,
    draw INTEGER DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Table to store user votes (ensures strict single-vote check)
CREATE TABLE IF NOT EXISTS fifa_votes (
    match_id TEXT REFERENCES fifa_polls(match_id) ON DELETE CASCADE,
    voter_id TEXT NOT NULL,
    choice TEXT NOT NULL CHECK (choice IN ('home', 'away', 'draw')),
    voted_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    PRIMARY KEY (match_id, voter_id)
);

CREATE INDEX IF NOT EXISTS idx_fifa_votes_match_id ON fifa_votes(match_id);
