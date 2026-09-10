-- Applied automatically on backend startup (see migrate() in db.js's caller,
-- backend/server.js). Safe to run repeatedly — everything is IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  target_weight NUMERIC NOT NULL,
  min_weight NUMERIC NOT NULL,
  max_weight NUMERIC NOT NULL,
  unit TEXT DEFAULT 'kg',
  tolerance_type TEXT DEFAULT 'absolute',
  tolerance_value NUMERIC,
  status TEXT DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  ip TEXT NOT NULL,
  protocol TEXT NOT NULL,
  target NUMERIC NOT NULL DEFAULT 25,
  unit TEXT NOT NULL DEFAULT 'kg',
  cost_per_unit NUMERIC NOT NULL DEFAULT 0,
  product_id TEXT REFERENCES products(id) ON DELETE SET NULL,
  connection_config JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS widgets (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  metric TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS gateway_keys (
  id TEXT PRIMARY KEY,
  key TEXT UNIQUE NOT NULL,
  label TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS maintenance_records (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  work_order_number TEXT,
  status TEXT NOT NULL DEFAULT 'SCHEDULED',
  scheduled_date TIMESTAMPTZ,
  due_date TIMESTAMPTZ,
  interval_days INT,
  technician TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  parts JSONB DEFAULT '[]',
  labour_hours NUMERIC DEFAULT 0,
  labour_cost NUMERIC DEFAULT 0,
  downtime_minutes NUMERIC DEFAULT 0,
  attachments JSONB DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS calibration_records (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  calibration_date TIMESTAMPTZ,
  next_calibration_date TIMESTAMPTZ,
  certificate_number TEXT DEFAULT '',
  certificate_file_url TEXT DEFAULT '',
  technician TEXT DEFAULT '',
  calibration_company TEXT DEFAULT '',
  reference_weight NUMERIC,
  actual_weight NUMERIC,
  error NUMERIC,
  error_percent NUMERIC,
  pass_fail TEXT,
  notes TEXT DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  protocol TEXT NOT NULL,
  port INT,
  register_map JSONB DEFAULT '{}',
  unit TEXT DEFAULT 'kg',
  polling_ms INT DEFAULT 500,
  built_in BOOLEAN DEFAULT false
);

CREATE TABLE IF NOT EXISTS alert_history (
  id TEXT PRIMARY KEY,
  device_id TEXT,
  device_name TEXT,
  type TEXT,
  message TEXT,
  severity TEXT,
  since TIMESTAMPTZ,
  active BOOLEAN,
  resolved_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_alert_history_active ON alert_history(active) WHERE active;

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  ts TIMESTAMPTZ NOT NULL DEFAULT now(),
  username TEXT,
  role TEXT,
  action TEXT,
  details JSONB
);
CREATE INDEX IF NOT EXISTS idx_audit_log_ts ON audit_log(ts DESC);

-- Durable reading history, separate from the in-memory ring buffer that
-- powers the live sparkline widget (see store.js). This is what makes
-- date-range reports possible instead of "since last reset" only.
CREATE TABLE IF NOT EXISTS readings (
  id BIGSERIAL PRIMARY KEY,
  device_id TEXT NOT NULL,
  weight NUMERIC,
  phase TEXT,
  bag_count INT,
  connected BOOLEAN,
  ts TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_readings_device_ts ON readings(device_id, ts DESC);

DO $$ BEGIN
  ALTER TABLE readings ADD COLUMN batch_id TEXT;
  ALTER TABLE readings ADD COLUMN lot_number TEXT;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

-- Cumulative give-away/loss counters per device. One row per device;
-- resetDeviceStats() zeroes it out and bumps `since` rather than deleting it.
CREATE TABLE IF NOT EXISTS device_stats (
  device_id TEXT PRIMARY KEY,
  total_bags INT DEFAULT 0,
  total_over_kg NUMERIC DEFAULT 0,
  total_under_kg NUMERIC DEFAULT 0,
  total_cost NUMERIC DEFAULT 0,
  count_under INT DEFAULT 0,
  count_pass INT DEFAULT 0,
  count_over INT DEFAULT 0,
  since TIMESTAMPTZ DEFAULT now()
);

-- Singleton config rows (one row each), keyed so they're trivial to read/write.
CREATE TABLE IF NOT EXISTS kv_config (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL
);

-- ---------- Multi-site sync (local instance <-> cloud instance) ----------
-- This is the SAME schema on both a "local" instance (on-site, source of
-- truth for its own site) and a "cloud" instance (aggregation point for
-- remote visibility). Nothing here is exclusive to one role — which role a
-- given deployment plays is a runtime config choice (SYNC_ROLE env var),
-- not a schema difference.

-- Outbox pattern: every mutation to a syncable entity (on a "local" instance)
-- appends a row here instead of a separate durable queue file — the local
-- Postgres database itself IS the buffer, which is simpler and more robust
-- than the gateway's file-based queue.js approach, and comes for free once
-- you already have a real database. A failed sync push just means these
-- rows stay unsynced and get retried next interval.
CREATE TABLE IF NOT EXISTS sync_outbox (
  id BIGSERIAL PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  operation TEXT NOT NULL, -- 'upsert' | 'delete'
  payload JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  synced_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_sync_outbox_unsynced ON sync_outbox(id) WHERE synced_at IS NULL;

-- Cloud-side only in practice (a "local" instance has no reason to issue
-- these), but lives in the shared schema like everything else. Each key
-- represents one entire site syncing up, not a single gateway — broader
-- scope than a gateway key, so it's a deliberately separate credential type.
CREATE TABLE IF NOT EXISTS sync_keys (
  id TEXT PRIMARY KEY,
  key TEXT UNIQUE NOT NULL,
  site_id TEXT NOT NULL,
  site_label TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS downtime_logs (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  device_name TEXT,
  started_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ,
  reason_code TEXT,
  reason_note TEXT,
  reported_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_downtime_logs_device ON downtime_logs(device_id);

CREATE TABLE IF NOT EXISTS user_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  ip TEXT,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_user_sessions_user ON user_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_user_sessions_token ON user_sessions(token_hash);

-- 2FA columns (added via ALTER to avoid breaking existing tables)
DO $$ BEGIN
  ALTER TABLE users ADD COLUMN IF NOT EXISTS two_factor_secret TEXT;
  ALTER TABLE users ADD COLUMN IF NOT EXISTS two_factor_enabled BOOLEAN DEFAULT false;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS scheduled_reports (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  report_type TEXT NOT NULL,
  format TEXT NOT NULL DEFAULT 'pdf',
  recipients TEXT NOT NULL,
  schedule_cron TEXT NOT NULL,
  enabled BOOLEAN DEFAULT true,
  last_sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS dashboard_views (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  is_default BOOLEAN DEFAULT false,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS dashboard_widgets (
  id TEXT PRIMARY KEY,
  view_id TEXT NOT NULL REFERENCES dashboard_views(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  metric TEXT NOT NULL,
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_dashboard_widgets_view ON dashboard_widgets(view_id);

CREATE TABLE IF NOT EXISTS device_groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  parent_id TEXT REFERENCES device_groups(id) ON DELETE SET NULL,
  color TEXT DEFAULT '#3B82F6',
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  plan TEXT DEFAULT 'free',
  max_devices INTEGER DEFAULT 10,
  max_users INTEGER DEFAULT 5,
  settings JSONB,
  enabled BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$ BEGIN
  ALTER TABLE users ADD COLUMN IF NOT EXISTS org_id TEXT REFERENCES organizations(id);
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE devices ADD COLUMN IF NOT EXISTS org_id TEXT REFERENCES organizations(id);
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE devices ADD COLUMN IF NOT EXISTS connection_type TEXT DEFAULT 'tcp';
  ALTER TABLE devices ADD COLUMN IF NOT EXISTS serial_port TEXT;
  ALTER TABLE devices ADD COLUMN IF NOT EXISTS serial_baud INTEGER DEFAULT 9600;
  ALTER TABLE devices ADD COLUMN IF NOT EXISTS serial_data_bits INTEGER DEFAULT 8;
  ALTER TABLE devices ADD COLUMN IF NOT EXISTS serial_stop_bits INTEGER DEFAULT 1;
  ALTER TABLE devices ADD COLUMN IF NOT EXISTS serial_parity TEXT DEFAULT 'none';
  ALTER TABLE devices ADD COLUMN IF NOT EXISTS modbus_unit_id INTEGER DEFAULT 1;
  ALTER TABLE devices ADD COLUMN IF NOT EXISTS reg_config JSONB;
  ALTER TABLE devices ADD COLUMN IF NOT EXISTS opcua_nodes JSONB;
  ALTER TABLE devices ADD COLUMN IF NOT EXISTS opcua_namespace INTEGER DEFAULT 2;
  ALTER TABLE devices ADD COLUMN IF NOT EXISTS mqtt_broker TEXT;
  ALTER TABLE devices ADD COLUMN IF NOT EXISTS mqtt_topic TEXT;
  ALTER TABLE devices ADD COLUMN IF NOT EXISTS mqtt_username TEXT;
  ALTER TABLE devices ADD COLUMN IF NOT EXISTS mqtt_password TEXT;
  ALTER TABLE devices ADD COLUMN IF NOT EXISTS mqtt_client_id TEXT;
  ALTER TABLE devices ADD COLUMN IF NOT EXISTS mqtt_qos INTEGER DEFAULT 0;
  ALTER TABLE devices ADD COLUMN IF NOT EXISTS mqtt_weight_field TEXT DEFAULT 'weight';
  ALTER TABLE devices ADD COLUMN IF NOT EXISTS mqtt_phase_field TEXT DEFAULT 'phase';
  ALTER TABLE devices ADD COLUMN IF NOT EXISTS mqtt_bag_count_field TEXT DEFAULT 'bagCount';
  ALTER TABLE devices ADD COLUMN IF NOT EXISTS mqtt_tls BOOLEAN DEFAULT false;
  ALTER TABLE devices ADD COLUMN IF NOT EXISTS enip_weight_tag TEXT DEFAULT 'Weight';
  ALTER TABLE devices ADD COLUMN IF NOT EXISTS enip_status_tag TEXT DEFAULT 'Status';
  ALTER TABLE devices ADD COLUMN IF NOT EXISTS enip_bag_count_tag TEXT DEFAULT 'BagCount';
  ALTER TABLE devices ADD COLUMN IF NOT EXISTS s7_rack INTEGER DEFAULT 0;
  ALTER TABLE devices ADD COLUMN IF NOT EXISTS s7_slot INTEGER DEFAULT 1;
  ALTER TABLE devices ADD COLUMN IF NOT EXISTS s7_db_number INTEGER DEFAULT 1;
  ALTER TABLE devices ADD COLUMN IF NOT EXISTS s7_weight_start INTEGER DEFAULT 0;
  ALTER TABLE devices ADD COLUMN IF NOT EXISTS s7_status_start INTEGER DEFAULT 4;
  ALTER TABLE devices ADD COLUMN IF NOT EXISTS s7_bag_count_start INTEGER DEFAULT 6;
  ALTER TABLE devices ADD COLUMN IF NOT EXISTS snmp_weight_oid TEXT;
  ALTER TABLE devices ADD COLUMN IF NOT EXISTS snmp_status_oid TEXT;
  ALTER TABLE devices ADD COLUMN IF NOT EXISTS snmp_community TEXT DEFAULT 'public';
  ALTER TABLE devices ADD COLUMN IF NOT EXISTS snmp_version TEXT DEFAULT '2c';
  ALTER TABLE devices ADD COLUMN IF NOT EXISTS rest_url TEXT;
  ALTER TABLE devices ADD COLUMN IF NOT EXISTS rest_method TEXT DEFAULT 'GET';
  ALTER TABLE devices ADD COLUMN IF NOT EXISTS rest_headers JSONB;
  ALTER TABLE devices ADD COLUMN IF NOT EXISTS rest_weight_field TEXT DEFAULT 'weight';
  ALTER TABLE devices ADD COLUMN IF NOT EXISTS rest_auth_type TEXT DEFAULT 'none';
  ALTER TABLE devices ADD COLUMN IF NOT EXISTS rest_auth_token TEXT;
  ALTER TABLE devices ADD COLUMN IF NOT EXISTS tcp_port INTEGER;
  ALTER TABLE devices ADD COLUMN IF NOT EXISTS tcp_delimiter TEXT DEFAULT '\r\n';
  ALTER TABLE devices ADD COLUMN IF NOT EXISTS tcp_parse_regex TEXT;
  ALTER TABLE devices ADD COLUMN IF NOT EXISTS serial_parse_regex TEXT;
  ALTER TABLE devices ADD COLUMN IF NOT EXISTS scale_factor NUMERIC DEFAULT 1;
  ALTER TABLE devices ADD COLUMN IF NOT EXISTS weight_format TEXT DEFAULT 'float32';
  ALTER TABLE devices ADD COLUMN IF NOT EXISTS byte_order TEXT DEFAULT 'littleEndian';
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;


ALTER TABLE alert_history ADD COLUMN IF NOT EXISTS acknowledged_by TEXT;
ALTER TABLE alert_history ADD COLUMN IF NOT EXISTS acknowledged_at TIMESTAMPTZ;
ALTER TABLE alert_history ADD COLUMN IF NOT EXISTS snoozed_until TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS production_schedules (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  product_id TEXT,
  shift_name TEXT NOT NULL,
  shift_date DATE NOT NULL,
  planned_bags INTEGER DEFAULT 0,
  actual_bags INTEGER DEFAULT 0,
  planned_start TIMESTAMPTZ,
  planned_end TIMESTAMPTZ,
  actual_start TIMESTAMPTZ,
  actual_end TIMESTAMPTZ,
  status TEXT DEFAULT 'planned',
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_prod_sched_device ON production_schedules(device_id);
CREATE INDEX IF NOT EXISTS idx_prod_sched_date ON production_schedules(shift_date);

DO $$ BEGIN
  ALTER TABLE devices ADD COLUMN IF NOT EXISTS firmware_version TEXT DEFAULT '1.0.0';
  ALTER TABLE devices ADD COLUMN IF NOT EXISTS firmware_url TEXT;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS firmware_updates (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  from_version TEXT,
  to_version TEXT NOT NULL,
  status TEXT DEFAULT 'pending',
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS gdpr_consent_log (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT,
  ip TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_gdpr_consent_user ON gdpr_consent_log(user_id);

CREATE TABLE IF NOT EXISTS sso_providers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'oidc',
  issuer_url TEXT,
  client_id TEXT,
  client_secret TEXT,
  redirect_url TEXT,
  enabled BOOLEAN DEFAULT true,
  default_role TEXT DEFAULT 'viewer',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS device_permissions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  permission TEXT NOT NULL DEFAULT 'read',
  granted_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, device_id)
);
CREATE INDEX IF NOT EXISTS idx_devperm_user ON device_permissions(user_id);
CREATE INDEX IF NOT EXISTS idx_devperm_device ON device_permissions(device_id);

CREATE TABLE IF NOT EXISTS batches (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  customer TEXT,
  product_id TEXT,
  device_id TEXT,
  status TEXT DEFAULT 'active',
  started_at TIMESTAMPTZ DEFAULT now(),
  completed_at TIMESTAMPTZ,
  total_bags INTEGER DEFAULT 0,
  target_bags INTEGER,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_batches_status ON batches(status);
CREATE INDEX IF NOT EXISTS idx_batches_device ON batches(device_id);

CREATE TABLE IF NOT EXISTS ai_insights (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  insight_type TEXT NOT NULL,
  severity TEXT DEFAULT 'info',
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  confidence REAL DEFAULT 0.5,
  data JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  acknowledged BOOLEAN DEFAULT false
);
CREATE INDEX IF NOT EXISTS idx_ai_insights_device ON ai_insights(device_id);
CREATE INDEX IF NOT EXISTS idx_ai_insights_type ON ai_insights(insight_type);
CREATE INDEX IF NOT EXISTS idx_ai_insights_created ON ai_insights(created_at DESC);

CREATE TABLE IF NOT EXISTS report_templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  config JSONB NOT NULL,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS integrations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  config JSONB NOT NULL,
  enabled BOOLEAN DEFAULT true,
  last_sync_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS integration_logs (
  id TEXT PRIMARY KEY,
  integration_id TEXT NOT NULL,
  direction TEXT NOT NULL DEFAULT 'outgoing',
  status TEXT NOT NULL,
  request JSONB,
  response JSONB,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_int_logs_integration ON integration_logs(integration_id);
CREATE INDEX IF NOT EXISTS idx_int_logs_created ON integration_logs(created_at DESC);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_push_sub_user ON push_subscriptions(user_id);

CREATE TABLE IF NOT EXISTS api_usage (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  method TEXT NOT NULL,
  status_code INTEGER,
  ip TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_api_usage_user ON api_usage(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_api_usage_created ON api_usage(created_at DESC);

CREATE TABLE IF NOT EXISTS rate_limits (
  user_id TEXT PRIMARY KEY,
  requests_count INTEGER DEFAULT 0,
  window_start TIMESTAMPTZ DEFAULT now()
);

