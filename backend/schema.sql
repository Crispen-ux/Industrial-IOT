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
  maintenance_type TEXT DEFAULT 'corrective',
  priority TEXT DEFAULT 'normal',
  scheduled_date TIMESTAMPTZ,
  due_date TIMESTAMPTZ,
  interval_days INT,
  technician TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  failure_mode TEXT DEFAULT '',
  root_cause TEXT DEFAULT '',
  parts JSONB DEFAULT '[]',
  labour_hours NUMERIC DEFAULT 0,
  labour_cost NUMERIC DEFAULT 0,
  parts_cost NUMERIC DEFAULT 0,
  total_cost NUMERIC DEFAULT 0,
  downtime_minutes NUMERIC DEFAULT 0,
  attachments JSONB DEFAULT '[]',
  metadata JSONB DEFAULT '{}',
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

-- ============================================================
-- PHASE 1: Platform Foundation — Generic Asset Hierarchy
-- ============================================================

-- Site: top-level organizational unit (e.g. "Johannesburg Plant")
CREATE TABLE IF NOT EXISTS sites (
  id TEXT PRIMARY KEY,
  org_id TEXT REFERENCES organizations(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  code TEXT,
  address TEXT,
  timezone TEXT DEFAULT 'UTC',
  lat NUMERIC,
  lng NUMERIC,
  enabled BOOLEAN DEFAULT true,
  settings JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sites_org ON sites(org_id);

-- Area: logical grouping within a site (e.g. "Packaging Hall A")
CREATE TABLE IF NOT EXISTS areas (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  code TEXT,
  description TEXT DEFAULT '',
  color TEXT DEFAULT '#3B82F6',
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_areas_site ON areas(site_id);

-- Line: production line within an area (e.g. "Line 1 - 25kg Bags")
CREATE TABLE IF NOT EXISTS lines (
  id TEXT PRIMARY KEY,
  area_id TEXT NOT NULL REFERENCES areas(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  code TEXT,
  description TEXT DEFAULT '',
  color TEXT DEFAULT '#10B981',
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_lines_area ON lines(area_id);

-- Station: individual work station within a line (e.g. "Fill Station 3")
CREATE TABLE IF NOT EXISTS stations (
  id TEXT PRIMARY KEY,
  line_id TEXT NOT NULL REFERENCES lines(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  code TEXT,
  description TEXT DEFAULT '',
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_stations_line ON stations(line_id);

-- Asset Type: configurable definitions for different industrial device types
-- Users define their own asset types with associated metrics through the UI
CREATE TABLE IF NOT EXISTS asset_types (
  id TEXT PRIMARY KEY,
  org_id TEXT REFERENCES organizations(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  code TEXT,
  description TEXT DEFAULT '',
  icon TEXT DEFAULT 'device',
  color TEXT DEFAULT '#6366F1',
  category TEXT DEFAULT 'general',
  is_system BOOLEAN DEFAULT false,
  settings JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_asset_types_org ON asset_types(org_id);

-- Asset Type Metrics: defines what metrics each asset type can produce
-- e.g. "Weigh Scale" type has metrics: weight, temperature, vibration
CREATE TABLE IF NOT EXISTS asset_type_metrics (
  id TEXT PRIMARY KEY,
  asset_type_id TEXT NOT NULL REFERENCES asset_types(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  unit TEXT DEFAULT '',
  data_type TEXT DEFAULT 'number',
  min_value NUMERIC,
  max_value NUMERIC,
  precision INTEGER DEFAULT 2,
  category TEXT DEFAULT 'primary',
  sort_order INTEGER DEFAULT 0,
  settings JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_atm_type ON asset_type_metrics(asset_type_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_atm_type_name ON asset_type_metrics(asset_type_id, name);

-- Link existing devices table to hierarchy (add foreign keys via ALTER)
DO $$ BEGIN
  ALTER TABLE devices ADD COLUMN IF NOT EXISTS site_id TEXT REFERENCES sites(id) ON DELETE SET NULL;
  ALTER TABLE devices ADD COLUMN IF NOT EXISTS area_id TEXT REFERENCES areas(id) ON DELETE SET NULL;
  ALTER TABLE devices ADD COLUMN IF NOT EXISTS line_id TEXT REFERENCES lines(id) ON DELETE SET NULL;
  ALTER TABLE devices ADD COLUMN IF NOT EXISTS station_id TEXT REFERENCES stations(id) ON DELETE SET NULL;
  ALTER TABLE devices ADD COLUMN IF NOT EXISTS asset_type_id TEXT REFERENCES asset_types(id) ON DELETE SET NULL;
  ALTER TABLE devices ADD COLUMN IF NOT EXISTS group_id TEXT REFERENCES device_groups(id) ON DELETE SET NULL;
  ALTER TABLE devices ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'active';
  ALTER TABLE devices ADD COLUMN IF NOT EXISTS tags JSONB DEFAULT '[]';
  ALTER TABLE devices ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}';
  ALTER TABLE devices ADD COLUMN IF NOT EXISTS polling_ms INTEGER DEFAULT 500;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_devices_site ON devices(site_id);
CREATE INDEX IF NOT EXISTS idx_devices_area ON devices(area_id);
CREATE INDEX IF NOT EXISTS idx_devices_line ON devices(line_id);
CREATE INDEX IF NOT EXISTS idx_devices_asset_type ON devices(asset_type_id);

-- Generic Telemetry: replaces the hardcoded readings table
-- JSONB metrics column holds any metric name/value pairs
-- The old readings table is kept for backward compatibility
CREATE TABLE IF NOT EXISTS telemetry (
  id BIGSERIAL PRIMARY KEY,
  device_id TEXT NOT NULL,
  metrics JSONB NOT NULL DEFAULT '{}',
  connected BOOLEAN,
  quality INTEGER,
  ts TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_telemetry_device_ts ON telemetry(device_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_telemetry_metric ON telemetry USING GIN (metrics);

-- Sensors: individual measurement points on a device
-- Each sensor defines what it measures and how to map it
CREATE TABLE IF NOT EXISTS sensors (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  unit TEXT DEFAULT '',
  enabled BOOLEAN DEFAULT true,
  config JSONB DEFAULT '{}',
  min_value NUMERIC,
  max_value NUMERIC,
  warning_min NUMERIC,
  warning_max NUMERIC,
  alarm_min NUMERIC,
  alarm_max NUMERIC,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sensors_device ON sensors(device_id);

-- Pre-seed common asset types
INSERT INTO asset_types (id, name, code, description, icon, color, category, is_system) VALUES
  ('at_weighscale', 'Weigh Scale', 'WEIGH_SCALE', 'Industrial weighing scale for bag-filling, checkweighing, and bulk measurement', 'scale', '#F2B705', 'measurement', true),
  ('at_temperature', 'Temperature Sensor', 'TEMP_SENSOR', 'Temperature measurement sensor for process monitoring', 'thermometer', '#EF4444', 'measurement', true),
  ('at_flowmeter', 'Flow Meter', 'FLOW_METER', 'Flow measurement device for liquids and gases', 'droplet', '#3B82F6', 'measurement', true),
  ('at_pressure', 'Pressure Sensor', 'PRESSURE_SENSOR', 'Pressure measurement for hydraulic, pneumatic, and process applications', 'gauge', '#8B5CF6', 'measurement', true),
  ('at_vibration', 'Vibration Sensor', 'VIBRATION_SENSOR', 'Vibration monitoring for predictive maintenance of rotating equipment', 'activity', '#10B981', 'measurement', true),
  ('at_plc', 'PLC / Controller', 'PLC', 'Programmable Logic Controller for automation and process control', 'cpu', '#6366F1', 'control', true),
  ('at_motor', 'Motor / Drive', 'MOTOR', 'Electric motor or variable frequency drive', 'zap', '#F59E0B', 'actuator', true),
  ('at_valve', 'Valve', 'VALVE', 'Control valve for flow regulation', 'circle', '#EC4899', 'actuator', true),
  ('at_barcode', 'Barcode Scanner', 'BARCODE', 'Barcode or QR code scanner for traceability', 'scan', '#14B8A6', 'input', true),
  ('at_printer', 'Label Printer', 'PRINTER', 'Label or receipt printer for product identification', 'printer', '#64748B', 'output', true)
ON CONFLICT (id) DO NOTHING;

-- Pre-seed metrics for Weigh Scale asset type
INSERT INTO asset_type_metrics (id, asset_type_id, name, display_name, unit, data_type, min_value, max_value, precision, category, sort_order) VALUES
  ('atm_ws_weight', 'at_weighscale', 'weight', 'Weight', 'kg', 'number', 0, 1000, 3, 'primary', 0),
  ('atm_ws_target', 'at_weighscale', 'target', 'Target Weight', 'kg', 'number', 0, 1000, 3, 'config', 1),
  ('atm_ws_deviation', 'at_weighscale', 'deviation', 'Deviation from Target', '%', 'number', -100, 100, 2, 'computed', 2),
  ('atm_ws_temperature', 'at_weighscale', 'temperature', 'Temperature', '°C', 'number', -40, 85, 1, 'secondary', 3),
  ('atm_ws_bag_count', 'at_weighscale', 'bag_count', 'Bag Count', 'bags', 'integer', 0, 999999, 0, 'production', 4),
  ('atm_ws_vibration', 'at_weighscale', 'vibration', 'Vibration Level', 'mm/s', 'number', 0, 50, 2, 'diagnostic', 5),
  ('atm_ws_status', 'at_weighscale', 'status', 'Operational Status', '', 'string', NULL, NULL, 0, 'status', 6)
ON CONFLICT (id) DO NOTHING;

-- Pre-seed metrics for Temperature Sensor
INSERT INTO asset_type_metrics (id, asset_type_id, name, display_name, unit, data_type, min_value, max_value, precision, category, sort_order) VALUES
  ('atm_ts_temperature', 'at_temperature', 'temperature', 'Temperature', '°C', 'number', -200, 1000, 1, 'primary', 0),
  ('atm_ts_humidity', 'at_temperature', 'humidity', 'Humidity', '%', 'number', 0, 100, 1, 'secondary', 1),
  ('atm_ts_battery', 'at_temperature', 'battery', 'Battery Level', '%', 'integer', 0, 100, 0, 'diagnostic', 2)
ON CONFLICT (id) DO NOTHING;

-- Pre-seed metrics for Flow Meter
INSERT INTO asset_type_metrics (id, asset_type_id, name, display_name, unit, data_type, min_value, max_value, precision, category, sort_order) VALUES
  ('atm_fm_flow_rate', 'at_flowmeter', 'flow_rate', 'Flow Rate', 'L/min', 'number', 0, 10000, 2, 'primary', 0),
  ('atm_fm_total', 'at_flowmeter', 'total', 'Total Volume', 'L', 'number', 0, 9999999, 3, 'production', 1),
  ('atm_fm_temperature', 'at_flowmeter', 'temperature', 'Temperature', '°C', 'number', -40, 200, 1, 'secondary', 2),
  ('atm_fm_pressure', 'at_flowmeter', 'pressure', 'Pressure', 'bar', 'number', 0, 100, 2, 'secondary', 3)
ON CONFLICT (id) DO NOTHING;

-- ============================================================
-- PHASE 2: Real-Time Operations — Asset Status + Rules Engine
-- ============================================================

-- Asset Status: tracks operational state of each device
-- Updated automatically based on telemetry and rules evaluation
CREATE TABLE IF NOT EXISTS asset_status (
  device_id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'offline',
  status_text TEXT DEFAULT '',
  last_seen_at TIMESTAMPTZ,
  last_metric_values JSONB DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_asset_status_status ON asset_status(status);

-- Alert Rules: user-defined threshold rules for any metric
-- IF metric <operator> <value> THEN trigger alert with <severity>
CREATE TABLE IF NOT EXISTS alert_rules (
  id TEXT PRIMARY KEY,
  org_id TEXT REFERENCES organizations(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  enabled BOOLEAN DEFAULT true,
  device_id TEXT,
  device_ids JSONB DEFAULT '[]',
  metric TEXT NOT NULL,
  operator TEXT NOT NULL DEFAULT '>',
  threshold NUMERIC NOT NULL,
  severity TEXT NOT NULL DEFAULT 'warning',
  message_template TEXT,
  cooldown_seconds INTEGER DEFAULT 300,
  consecutive_count INTEGER DEFAULT 1,
  tags JSONB DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_triggered_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_alert_rules_metric ON alert_rules(metric);
CREATE INDEX IF NOT EXISTS idx_alert_rules_enabled ON alert_rules(enabled) WHERE enabled;
CREATE INDEX IF NOT EXISTS idx_alert_rules_device ON alert_rules(device_id);

-- Rule State: tracks rule evaluation state per device (for consecutive_count)
CREATE TABLE IF NOT EXISTS rule_state (
  rule_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  consecutive_violations INTEGER DEFAULT 0,
  last_violation_at TIMESTAMPTZ,
  last_alert_at TIMESTAMPTZ,
  PRIMARY KEY (rule_id, device_id)
);

-- ============================================================
-- PHASE 3: Manufacturing — Production Orders, Events, Quality
-- ============================================================

-- Production Orders: track production runs with targets and actuals
CREATE TABLE IF NOT EXISTS production_orders (
  id TEXT PRIMARY KEY,
  org_id TEXT REFERENCES organizations(id) ON DELETE SET NULL,
  order_number TEXT NOT NULL,
  product_id TEXT REFERENCES products(id) ON DELETE SET NULL,
  device_id TEXT,
  line_id TEXT REFERENCES lines(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'planned',
  priority INTEGER DEFAULT 0,
  planned_quantity INTEGER DEFAULT 0,
  actual_quantity INTEGER DEFAULT 0,
  good_quantity INTEGER DEFAULT 0,
  reject_quantity INTEGER DEFAULT 0,
  unit TEXT DEFAULT 'units',
  planned_start TIMESTAMPTZ,
  planned_end TIMESTAMPTZ,
  actual_start TIMESTAMPTZ,
  actual_end TIMESTAMPTZ,
  customer TEXT,
  notes TEXT DEFAULT '',
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_prod_orders_status ON production_orders(status);
CREATE INDEX IF NOT EXISTS idx_prod_orders_product ON production_orders(product_id);
CREATE INDEX IF NOT EXISTS idx_prod_orders_device ON production_orders(device_id);
CREATE INDEX IF NOT EXISTS idx_prod_orders_line ON production_orders(line_id);

-- Production Events: log events during production (downtime, changeovers, etc.)
CREATE TABLE IF NOT EXISTS production_events (
  id TEXT PRIMARY KEY,
  order_id TEXT REFERENCES production_orders(id) ON DELETE SET NULL,
  device_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  event_code TEXT,
  message TEXT DEFAULT '',
  quantity INTEGER DEFAULT 0,
  duration_seconds INTEGER DEFAULT 0,
  start_time TIMESTAMPTZ NOT NULL DEFAULT now(),
  end_time TIMESTAMPTZ,
  metadata JSONB DEFAULT '{}',
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_prod_events_order ON production_events(order_id);
CREATE INDEX IF NOT EXISTS idx_prod_events_device ON production_events(device_id);
CREATE INDEX IF NOT EXISTS idx_prod_events_type ON production_events(event_type);

-- Quality Metrics: track quality measurements per production order
CREATE TABLE IF NOT EXISTS quality_metrics (
  id TEXT PRIMARY KEY,
  order_id TEXT REFERENCES production_orders(id) ON DELETE SET NULL,
  device_id TEXT NOT NULL,
  metric_name TEXT NOT NULL,
  metric_value NUMERIC NOT NULL,
  target_value NUMERIC,
  min_value NUMERIC,
  max_value NUMERIC,
  unit TEXT DEFAULT '',
  pass BOOLEAN DEFAULT true,
  notes TEXT DEFAULT '',
  measured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_quality_order ON quality_metrics(order_id);
CREATE INDEX IF NOT EXISTS idx_quality_device ON quality_metrics(device_id);

-- Shift Templates: reusable shift definitions
CREATE TABLE IF NOT EXISTS shift_templates (
  id TEXT PRIMARY KEY,
  org_id TEXT REFERENCES organizations(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  break_minutes INTEGER DEFAULT 0,
  days_of_week INTEGER[] DEFAULT '{1,2,3,4,5}',
  color TEXT DEFAULT '#3B82F6',
  enabled BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_shift_templates_org ON shift_templates(org_id);

-- ============================================================
-- PHASE 4: Maintenance Enhancement — Schedules, MTBF, Prediction
-- ============================================================

-- Preventive Maintenance Schedules: define recurring maintenance rules
CREATE TABLE IF NOT EXISTS maintenance_schedules (
  id TEXT PRIMARY KEY,
  org_id TEXT REFERENCES organizations(id) ON DELETE SET NULL,
  device_id TEXT NOT NULL,
  name TEXT NOT NULL,
  maintenance_type TEXT NOT NULL DEFAULT 'preventive',
  interval_days INTEGER NOT NULL,
  interval_hours INTEGER,
  interval_cycles INTEGER,
  reminder_days INTEGER DEFAULT 7,
  priority TEXT DEFAULT 'normal',
  technician TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  checklist JSONB DEFAULT '[]',
  enabled BOOLEAN DEFAULT true,
  last_generated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_maint_schedules_device ON maintenance_schedules(device_id);
CREATE INDEX IF NOT EXISTS idx_maint_schedules_org ON maintenance_schedules(org_id);

-- Maintenance Failures: track failure events for MTBF calculation
CREATE TABLE IF NOT EXISTS maintenance_failures (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  failure_type TEXT NOT NULL,
  failure_mode TEXT DEFAULT '',
  severity TEXT DEFAULT 'normal',
  description TEXT DEFAULT '',
  root_cause TEXT DEFAULT '',
  resolution TEXT DEFAULT '',
  downtime_minutes INTEGER DEFAULT 0,
  cost NUMERIC DEFAULT 0,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  maintenance_id TEXT REFERENCES maintenance_records(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_maint_failures_device ON maintenance_failures(device_id);
CREATE INDEX IF NOT EXISTS idx_maint_failures_occurred ON maintenance_failures(occurred_at);

-- ============================================================
-- PHASE 5: Machine Learning Pipeline — Models, Predictions
-- ============================================================

-- ML Models: store trained model metadata and parameters
CREATE TABLE IF NOT EXISTS ml_models (
  id TEXT PRIMARY KEY,
  org_id TEXT REFERENCES organizations(id) ON DELETE SET NULL,
  device_id TEXT,
  name TEXT NOT NULL,
  model_type TEXT NOT NULL,
  metric TEXT NOT NULL,
  parameters JSONB DEFAULT '{}',
  training_data_size INTEGER DEFAULT 0,
  accuracy REAL DEFAULT 0,
  mae REAL DEFAULT 0,
  rmse REAL DEFAULT 0,
  r2 REAL DEFAULT 0,
  status TEXT DEFAULT 'trained',
  last_trained_at TIMESTAMPTZ,
  last_prediction_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ml_models_device ON ml_models(device_id);
CREATE INDEX IF NOT EXISTS idx_ml_models_type ON ml_models(model_type);
CREATE INDEX IF NOT EXISTS idx_ml_models_org ON ml_models(org_id);

-- ML Predictions: store prediction results
CREATE TABLE IF NOT EXISTS ml_predictions (
  id TEXT PRIMARY KEY,
  model_id TEXT REFERENCES ml_models(id) ON DELETE SET NULL,
  device_id TEXT NOT NULL,
  metric TEXT NOT NULL,
  predicted_value REAL,
  actual_value REAL,
  confidence REAL DEFAULT 0,
  prediction_horizon_hours INTEGER DEFAULT 1,
  error REAL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ml_predictions_model ON ml_predictions(model_id);
CREATE INDEX IF NOT EXISTS idx_ml_predictions_device ON ml_predictions(device_id);
CREATE INDEX IF NOT EXISTS idx_ml_predictions_created ON ml_predictions(created_at);

-- ============================================================
-- PHASE 6: Predictive Maintenance — Health Trends, RUL, Optimization
-- ============================================================

-- Health History: track device health scores over time
CREATE TABLE IF NOT EXISTS health_history (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  health_score REAL NOT NULL,
  reading_score REAL,
  maintenance_score REAL,
  calibration_score REAL,
  alert_score REAL,
  freshness_score REAL,
  failure_score REAL,
  telemetry_score REAL,
  status TEXT DEFAULT 'healthy',
  notes TEXT DEFAULT '',
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_health_history_device ON health_history(device_id);
CREATE INDEX IF NOT EXISTS idx_health_history_recorded ON health_history(recorded_at);

-- RUL Estimates: store remaining useful life predictions
CREATE TABLE IF NOT EXISTS rul_estimates (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  estimated_rul_days REAL NOT NULL,
  confidence REAL DEFAULT 0,
  degradation_rate REAL DEFAULT 0,
  health_score REAL,
  failure_threshold REAL DEFAULT 50,
  method TEXT DEFAULT 'health_trend',
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_rul_device ON rul_estimates(device_id);

-- Maintenance Recommendations: store optimization recommendations
CREATE TABLE IF NOT EXISTS maintenance_recommendations (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  recommendation_type TEXT NOT NULL,
  priority TEXT DEFAULT 'normal',
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  estimated_cost_savings REAL DEFAULT 0,
  estimated_downtime_savings REAL DEFAULT 0,
  action_url TEXT,
  status TEXT DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  acknowledged_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_maint_recs_device ON maintenance_recommendations(device_id);
CREATE INDEX IF NOT EXISTS idx_maint_recs_status ON maintenance_recommendations(status);

-- ============================================================
-- PHASE 7: Integrations + Enterprise — ERP/MES, Export, Webhooks
-- ============================================================

-- Integration Mappings: map platform fields to external system fields
CREATE TABLE IF NOT EXISTS integration_mappings (
  id TEXT PRIMARY KEY,
  integration_id TEXT REFERENCES integrations(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL,
  field_mapping JSONB NOT NULL DEFAULT '{}',
  transform_rules JSONB DEFAULT '{}',
  enabled BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_int_mappings_integration ON integration_mappings(integration_id);

-- Webhook Configurations: enhanced webhook settings
CREATE TABLE IF NOT EXISTS webhook_configs (
  id TEXT PRIMARY KEY,
  integration_id TEXT REFERENCES integrations(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  secret TEXT,
  events TEXT[] DEFAULT '{}',
  retry_count INTEGER DEFAULT 3,
  retry_delay_ms INTEGER DEFAULT 5000,
  timeout_ms INTEGER DEFAULT 10000,
  headers JSONB DEFAULT '{}',
  enabled BOOLEAN DEFAULT true,
  last_triggered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_webhook_configs_integration ON webhook_configs(integration_id);

-- Data Export Jobs: track async export jobs
CREATE TABLE IF NOT EXISTS data_export_jobs (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  export_type TEXT NOT NULL,
  format TEXT NOT NULL DEFAULT 'csv',
  filters JSONB DEFAULT '{}',
  status TEXT DEFAULT 'pending',
  file_url TEXT,
  file_size INTEGER DEFAULT 0,
  record_count INTEGER DEFAULT 0,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_export_jobs_user ON data_export_jobs(user_id);
CREATE INDEX IF NOT EXISTS idx_export_jobs_status ON data_export_jobs(status);

-- Data Import Jobs: track import jobs with validation
CREATE TABLE IF NOT EXISTS data_import_jobs (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  import_type TEXT NOT NULL,
  file_name TEXT,
  status TEXT DEFAULT 'pending',
  total_rows INTEGER DEFAULT 0,
  processed_rows INTEGER DEFAULT 0,
  valid_rows INTEGER DEFAULT 0,
  error_rows INTEGER DEFAULT 0,
  errors JSONB DEFAULT '[]',
  result JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_import_jobs_user ON data_import_jobs(user_id);
CREATE INDEX IF NOT EXISTS idx_import_jobs_status ON data_import_jobs(status);

-- ============================================================
-- Phase 9: Consolidated Dashboard System
-- Replaces flat `widgets` table with enhanced dashboard_views/dashboard_widgets
-- ============================================================

-- Add user_id to dashboard_views (null = shared/default view)
DO $$ BEGIN
  ALTER TABLE dashboard_views ADD COLUMN user_id TEXT;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

-- Enhance dashboard_widgets with position, scope, and config
DO $$ BEGIN
  ALTER TABLE dashboard_widgets ADD COLUMN x INTEGER DEFAULT 0;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE dashboard_widgets ADD COLUMN y INTEGER DEFAULT 0;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE dashboard_widgets ADD COLUMN w INTEGER DEFAULT 4;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE dashboard_widgets ADD COLUMN h INTEGER DEFAULT 3;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE dashboard_widgets ADD COLUMN scope_type TEXT DEFAULT 'device';
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE dashboard_widgets ADD COLUMN scope_id TEXT;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE dashboard_widgets ADD COLUMN config JSONB DEFAULT '{}';
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

-- Migrate existing flat widgets into dashboard_widgets under a "Default" view
-- (only if dashboard_widgets is empty and widgets has data)
DO $$
BEGIN
  IF (SELECT count(*) FROM dashboard_widgets) = 0 AND (SELECT count(*) FROM widgets) > 0 THEN
    -- Create a default view if none exists
    IF (SELECT count(*) FROM dashboard_views) = 0 THEN
      INSERT INTO dashboard_views (id, name, is_default, created_at)
      VALUES ('dv_default', 'Default', true, now());
    END IF;
    -- Copy each flat widget into dashboard_widgets with grid position
    INSERT INTO dashboard_widgets (id, view_id, device_id, metric, sort_order, x, y, w, h, scope_type, config, created_at)
    SELECT
      'dw_' || id,
      (SELECT id FROM dashboard_views WHERE is_default = true LIMIT 1),
      device_id,
      metric,
      ROW_NUMBER() OVER (ORDER BY id) - 1,
      ((ROW_NUMBER() OVER (ORDER BY id) - 1) % 4) * 3,
      ((ROW_NUMBER() OVER (ORDER BY id) - 1) / 4) * 3,
      3,
      3,
      'device',
      '{}',
      now()
    FROM widgets;
  END IF;
END $$;

