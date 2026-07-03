PRAGMA foreign_keys = ON;

CREATE TABLE tenant_auth_projection (
  org_id      TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL UNIQUE,
  suspended   INTEGER NOT NULL DEFAULT 0 CHECK (suspended IN (0, 1)),
  updated_at  TEXT NOT NULL
);

CREATE TABLE events (
  event_id    TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL,
  name        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'DRAFT',
  starts_at   TEXT,
  ends_at     TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX idx_events_tenant_created ON events (tenant_id, created_at DESC);

CREATE TABLE teams (
  team_id         TEXT PRIMARY KEY,
  event_id        TEXT NOT NULL REFERENCES events(event_id) ON DELETE CASCADE,
  tenant_id       TEXT NOT NULL,
  display_name    TEXT NOT NULL,
  login_key_hash  TEXT NOT NULL UNIQUE,
  created_at      TEXT NOT NULL
);
CREATE INDEX idx_teams_event ON teams (event_id, team_id);

CREATE TABLE challenge_checkpoints (
  event_id       TEXT NOT NULL REFERENCES events(event_id) ON DELETE CASCADE,
  problem_id     TEXT NOT NULL,
  checkpoint_id  TEXT NOT NULL,
  flag_hash      TEXT NOT NULL,
  points         INTEGER NOT NULL CHECK (points > 0),
  PRIMARY KEY (event_id, problem_id, checkpoint_id),
  UNIQUE (event_id, problem_id, flag_hash)
);

CREATE TABLE submissions (
  event_id       TEXT NOT NULL,
  team_id        TEXT NOT NULL REFERENCES teams(team_id) ON DELETE CASCADE,
  problem_id     TEXT NOT NULL,
  checkpoint_id  TEXT NOT NULL,
  awarded_points INTEGER NOT NULL CHECK (awarded_points > 0),
  submitted_at   TEXT NOT NULL,
  PRIMARY KEY (event_id, team_id, problem_id, checkpoint_id),
  FOREIGN KEY (event_id, problem_id, checkpoint_id)
    REFERENCES challenge_checkpoints(event_id, problem_id, checkpoint_id)
    ON DELETE CASCADE
);

CREATE TABLE score_summary (
  event_id            TEXT NOT NULL,
  team_id             TEXT NOT NULL REFERENCES teams(team_id) ON DELETE CASCADE,
  score               INTEGER NOT NULL DEFAULT 0,
  solved_checkpoints  INTEGER NOT NULL DEFAULT 0,
  updated_at          TEXT NOT NULL,
  PRIMARY KEY (event_id, team_id)
);
CREATE INDEX idx_score_summary_rank
  ON score_summary (event_id, score DESC, updated_at ASC, team_id ASC);

CREATE TRIGGER score_summary_after_new_team
AFTER INSERT ON teams
BEGIN
  INSERT INTO score_summary (
    event_id,
    team_id,
    score,
    solved_checkpoints,
    updated_at
  ) VALUES (
    NEW.event_id,
    NEW.team_id,
    0,
    0,
    NEW.created_at
  );
END;

CREATE TRIGGER score_after_new_submission
AFTER INSERT ON submissions
BEGIN
  INSERT INTO score_summary (
    event_id,
    team_id,
    score,
    solved_checkpoints,
    updated_at
  )
  SELECT
    NEW.event_id,
    NEW.team_id,
    NEW.awarded_points,
    1,
    NEW.submitted_at
  FROM challenge_checkpoints AS checkpoint
  WHERE checkpoint.event_id = NEW.event_id
    AND checkpoint.problem_id = NEW.problem_id
    AND checkpoint.checkpoint_id = NEW.checkpoint_id
  ON CONFLICT(event_id, team_id) DO UPDATE SET
    score = score + excluded.score,
    solved_checkpoints = solved_checkpoints + 1,
    updated_at = excluded.updated_at;
END;
