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

-- Table for automated Matches from FotMob
DROP TABLE IF EXISTS matches;
CREATE TABLE matches (
    id TEXT PRIMARY KEY,
    homeTeam TEXT NOT NULL,
    awayTeam TEXT NOT NULL,
    homeLogo TEXT,
    awayLogo TEXT,
    homeFlag TEXT,
    awayFlag TEXT,
    kickoff INTEGER NOT NULL, -- Timestamp
    status TEXT DEFAULT 'notstarted', -- 'notstarted', 'live', 'finished'
    score TEXT DEFAULT '0 - 0',
    venue TEXT DEFAULT 'Venue to be confirmed',
    city TEXT,
    country TEXT,
    groupName TEXT,
    stage TEXT,
    competition TEXT DEFAULT 'FIFA World Cup',
    matchday TEXT,
    referee TEXT,
    attendance INTEGER,
    weather TEXT,
    broadcasters TEXT,
    description TEXT,
    thumbnail TEXT,
    banner TEXT,
    fotmobPageUrl TEXT,
    detailsFetched INTEGER DEFAULT 0,
    lastSynced TEXT DEFAULT (datetime('now'))
);

-- Table for automated Streams from streamed.pk
DROP TABLE IF EXISTS streams;
CREATE TABLE streams (
    matchId TEXT NOT NULL,
    provider TEXT NOT NULL,
    quality TEXT DEFAULT '720P',
    embedUrl TEXT NOT NULL PRIMARY KEY,
    mirror INTEGER DEFAULT 0,
    lastChecked TEXT DEFAULT (datetime('now')),
    working INTEGER DEFAULT 1,
    status INTEGER DEFAULT 1, -- 1 = active, 0 = disabled
    isPrimary INTEGER DEFAULT 0,
    priority INTEGER DEFAULT 0,
    language TEXT DEFAULT 'EN',
    FOREIGN KEY (matchId) REFERENCES matches(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_streams_matchId ON streams(matchId);

-- Table for automated Standings from FotMob
DROP TABLE IF EXISTS standings;
CREATE TABLE standings (
    team TEXT NOT NULL,
    played INTEGER DEFAULT 0,
    wins INTEGER DEFAULT 0,
    draws INTEGER DEFAULT 0,
    losses INTEGER DEFAULT 0,
    goalsFor INTEGER DEFAULT 0,
    goalsAgainst INTEGER DEFAULT 0,
    goalDifference INTEGER DEFAULT 0,
    points INTEGER DEFAULT 0,
    groupName TEXT NOT NULL,
    flag TEXT,
    PRIMARY KEY (team, groupName)
);

-- Table for Team Data (automatically stored metadata)
DROP TABLE IF EXISTS teams;
CREATE TABLE teams (
    country TEXT PRIMARY KEY,
    flag TEXT,
    fifaCode TEXT,
    groupName TEXT,
    coach TEXT,
    logo TEXT
);

