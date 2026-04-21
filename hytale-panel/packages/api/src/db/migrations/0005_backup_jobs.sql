CREATE TABLE IF NOT EXISTS backup_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type VARCHAR(20) NOT NULL CHECK (type IN ('create', 'restore')),
  status VARCHAR(20) NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'interrupted')),
  request_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  result_payload JSONB,
  error TEXT,
  requested_by UUID REFERENCES users(id) ON DELETE SET NULL,
  worker_id VARCHAR(100),
  lease_expires_at TIMESTAMPTZ,
  last_heartbeat_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_backup_jobs_status_created_at
  ON backup_jobs(status, created_at);

CREATE INDEX IF NOT EXISTS idx_backup_jobs_requested_by_created_at
  ON backup_jobs(requested_by, created_at);
