-- Emergency kill switch for cio-trigger-hub triggers — portal-writable,
-- OFF-ONLY by design: the hub consults this table as "AND NOT killed", so a
-- row can stop a trigger but can never turn one on (enabling stays a code
-- change in triggers.py). The special trigger_key 'all' stops every send.
--
-- The hub reads this at the start of every run and FAILS CLOSED: if the
-- table can't be read, nothing fires that run — a late welcome email is
-- cheap, a runaway send is not.
--
-- One row per key, MERGE-upserted by the portal (POST /api/triggers/{key}/
-- kill). Operators can kill; only admins can lift. updated_by/updated_at
-- are the audit trail.
CREATE TABLE IF NOT EXISTS `sdfc-udp-dev.customerio_state.trigger_kill_switch` (
  trigger_key STRING NOT NULL,  -- hub trigger key, or 'all' for every trigger
  killed BOOL NOT NULL,
  reason STRING,
  updated_by STRING,
  updated_at TIMESTAMP
);
