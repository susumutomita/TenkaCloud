-- Issue #2294: uptime-kind score contributions fed from the AWS event
-- runtime into the control store. Flag scoring is materialized into score_summary by the
-- submissions trigger; uptime scores land here and the leaderboard sums the two, so Battle
-- (uptime) and evergreen Challenge (flag) scoring coexist without either overwriting the other.
CREATE TABLE runtime_score (
  event_id   TEXT NOT NULL,
  team_id    TEXT NOT NULL,
  points     INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (event_id, team_id)
);
