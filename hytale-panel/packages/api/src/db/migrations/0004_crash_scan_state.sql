CREATE TABLE IF NOT EXISTS crash_scan_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  cursor_since TIMESTAMPTZ,
  last_scanned_at TIMESTAMPTZ,
  last_line_count INTEGER NOT NULL DEFAULT 0 CHECK (last_line_count >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
