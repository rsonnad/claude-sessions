CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  project TEXT,
  model TEXT,
  started_at TEXT,
  ended_at TEXT DEFAULT (datetime('now')),
  duration_mins INTEGER,
  summary TEXT,
  transcript TEXT,
  token_count INTEGER,
  cost_usd REAL,
  tags TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project);
CREATE INDEX IF NOT EXISTS idx_sessions_ended ON sessions(ended_at);
CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions(started_at);
