-- Follow-up integrity hardening for the runtime score feed (#2294).
--
-- Keep 0002 immutable for databases that already recorded it as applied. SQLite cannot add a
-- composite foreign key or CHECK constraint in place, so rebuild the small materialized table.
CREATE UNIQUE INDEX idx_teams_event_team_unique ON teams (event_id, team_id);

CREATE TABLE runtime_score_with_integrity (
  event_id   TEXT NOT NULL,
  team_id    TEXT NOT NULL,
  points     INTEGER NOT NULL DEFAULT 0 CHECK (points BETWEEN -2147483648 AND 2147483647),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (event_id, team_id),
  FOREIGN KEY (event_id, team_id)
    REFERENCES teams(event_id, team_id)
    ON DELETE CASCADE
);

INSERT INTO runtime_score_with_integrity (event_id, team_id, points, updated_at)
SELECT event_id, team_id, points, updated_at
  FROM runtime_score;

DROP TABLE runtime_score;
ALTER TABLE runtime_score_with_integrity RENAME TO runtime_score;
