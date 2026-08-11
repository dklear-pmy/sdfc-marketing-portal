-- vw_campaign_would_fire — who each hub trigger WOULD select right now.
-- SOURCE OF TRUTH for the deployed BQ view (was previously BQ-only).
-- MIRROR of cio_trigger_hub/triggers.py (sdfc-platform): every trigger's
-- candidate CTE here must match its hub query. DRIFT WARNING: update
-- together with triggers.py and affected.py TRIGGER_CAPS/TRIGGER_ENABLED.
-- Deploy: bq query --use_legacy_sql=false < api/sql/vw_campaign_would_fire.sql
--
-- ACL: BQ views run with the CALLER's permissions (marketing-portal-sa).
-- A branch that reads a NEW dataset 403s the portal tab until this view is
-- added as an AUTHORIZED VIEW on that dataset (bq show --format=prettyjson
-- <dataset>, append the view to `access`, bq update --source). Done
-- 2026-08-07 for salesforce_silver (supporters branch) AND shopify_silver
-- (the Aug-6 shopify branch had silently broken the tab — neither grant
-- existed), and again 2026-08-07 for ticketmaster_silver (supporters
-- event-date branch). Coverage now: tradablebits_bronze, customerio_gold,
-- customerio_state via direct SA access; tradablebits_silver,
-- salesforce_silver, shopify_silver, ticketmaster_silver via this
-- authorized view.
CREATE OR REPLACE VIEW `sdfc-udp-dev.customerio_state.vw_campaign_would_fire` AS
WITH acts AS (
  SELECT
    SAFE_CAST(NULLIF(CAST(activity_id AS STRING), '') AS INT64)               AS activity_id,
    SAFE_CAST(NULLIF(CAST(fan_id AS STRING), '') AS STRING)                   AS fan_id,
    SAFE_CAST(NULLIF(CAST(campaign_title AS STRING), '') AS STRING)           AS campaign_title,
    SAFE_CAST(NULLIF(CAST(creation_timestamp_iso AS STRING), '') AS TIMESTAMP) AS activity_ts,
    SAFE_CAST(NULLIF(CAST(ingestion_timestamp AS STRING), '') AS TIMESTAMP)    AS ingested_at
  FROM `sdfc-udp-dev.tradablebits_bronze.tb_activities`
  WHERE DATE(year, month, day)
        BETWEEN DATE_SUB(CURRENT_DATE('UTC'), INTERVAL 3 DAY) AND CURRENT_DATE('UTC')
  QUALIFY ROW_NUMBER() OVER (
    PARTITION BY activity_id ORDER BY ingested_at DESC NULLS LAST
  ) = 1
),
fans AS (
  SELECT fan_id, email, first_name, last_name, postal_code, fan_source,
         is_phone_subscribed, creation_timestamp_iso AS fan_created
  FROM `sdfc-udp-dev.tradablebits_silver.tb_fans`
  QUALIFY ROW_NUMBER() OVER (
    PARTITION BY fan_id ORDER BY last_update_timestamp_iso DESC NULLS LAST
  ) = 1
),
attrs AS (
  SELECT email, has_season_plan FROM `sdfc-udp-dev.customerio_gold.fan_attributes_cio_sync`
),
tb_signup_260715_cand AS (
  SELECT
    CAST(a.activity_id AS STRING)                          AS dedup_key,
    f.email,
    a.activity_id,
    a.campaign_title,
    CASE
      WHEN REGEXP_CONTAINS(LOWER(a.campaign_title), r'world.?cup')          THEN 'world_cup'
      WHEN a.campaign_title = 'San Diego FC / Stay Informed'                THEN 'stay_informed'
      WHEN REGEXP_CONTAINS(UPPER(a.campaign_title), r'ETW|ENTER.?TO.?WIN')  THEN 'etw'
      ELSE 'other'
    END                                                    AS signup_form_family,
    REGEXP_CONTAINS(LOWER(a.campaign_title), r'world.?cup') AS is_world_cup,
    COALESCE(
      TIMESTAMP_DIFF(a.activity_ts, f.fan_created, HOUR) BETWEEN 0 AND 24,
      FALSE)                                               AS is_new_fan_24h,
    FORMAT_TIMESTAMP('%FT%TZ', f.fan_created)              AS fan_created_at,
    FORMAT_TIMESTAMP('%FT%TZ', a.activity_ts)              AS activity_at,
    a.activity_ts                                          AS event_at,
    f.first_name,
    f.last_name,
    COALESCE(f.fan_source, '')                             AS fan_source,
    COALESCE(f.is_phone_subscribed, FALSE)                 AS phone_subscribed,
    COALESCE(t.has_season_plan, FALSE)                     AS has_season_plan,
    f.postal_code
  FROM acts a
  JOIN fans f USING (fan_id)
  LEFT JOIN attrs t ON LOWER(t.email) = LOWER(f.email)
  WHERE a.activity_id IS NOT NULL
    AND a.campaign_title IS NOT NULL
    AND f.email IS NOT NULL
    AND f.email != ''
    AND LOWER(f.email) NOT IN ('none', 'null')
    AND a.activity_ts >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 72 HOUR)
),
sg_cand AS (
  SELECT
    email AS dedup_key,
    email,
    first_name,
    last_name,
    tm_acct_id,
    ticket_seats_purchased,
    events_ticketed
  FROM `sdfc-udp-dev.customerio_gold.fan_attributes_cio_sync`
  WHERE ticket_seats_purchased > 0
    AND matches_attended_lifetime = 0
    AND has_season_plan = FALSE
),
shopify_first_orders AS (
  SELECT
    LOWER(customer_email)  AS email,
    id                     AS order_id,
    order_number,
    created_at             AS order_at
  FROM `sdfc-udp-dev.shopify_silver.orders`
  WHERE customer_email IS NOT NULL
    AND customer_email != ''
    AND LOWER(customer_email) NOT IN ('none', 'null')
    AND financial_status IN ('PAID', 'PARTIALLY_REFUNDED', 'REFUNDED')
  QUALIFY ROW_NUMBER() OVER (
    PARTITION BY LOWER(customer_email) ORDER BY created_at
  ) = 1
),
shopify_cand AS (
  SELECT
    o.email                                 AS dedup_key,
    o.email,
    o.order_id,
    o.order_number,
    FORMAT_TIMESTAMP('%FT%TZ', o.order_at)  AS first_order_at,
    o.order_at                              AS event_at,
    v.first_name,
    v.last_name,
    (v.email IS NULL)                       AS is_new_to_warehouse
  FROM shopify_first_orders o
  LEFT JOIN `sdfc-udp-dev.customerio_gold.fan_attributes_cio_sync` v
    ON LOWER(v.email) = o.email
  WHERE
    (v.email IS NULL OR (v.tb_fan_created_at IS NULL AND v.tm_acct_id IS NULL))
    AND COALESCE(v.ticket_seats_purchased, 0) = 0
    AND COALESCE(v.has_season_plan, FALSE) = FALSE
    AND o.order_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 72 HOUR)
),
membership_cand AS (
  -- MIRROR of _sf_membership_welcome_query in triggers.py: both SF
  -- membership triggers share one query implementation in the hub, so they
  -- share one CTE here; matched_trigger discriminates (record types are
  -- mutually exclusive, an opp can never match both).
  --   welcome_tickets_supporters_260807 (spec 2026-08-07): SUPP marker +
  --     Ticket Sales record type + General Season Tickets group.
  --   welcome_tickets_premium_260807 (spec 2026-08-09): Premium Sales
  --     record type + product 'Premium Season Membership' (the sheet's
  --     "Group = Premium Membership" — no such group_c exists); no name
  --     marker (auto-generated names).
  -- Common: closed/won + close date within 24h; rep_* = Account OWNER's
  -- User record; no-email hold; per-opportunity dedup.
  SELECT
    CASE
      WHEN o.record_type_id = '012UR000001cuNBYAY'
        THEN 'welcome_tickets_supporters_260807'
      WHEN o.record_type_id = '012UR000001fAEAYA2'
        THEN 'welcome_tickets_premium_260807'
    END                                                         AS matched_trigger,
    o.id                                                        AS dedup_key,
    LOWER(TRIM(NULLIF(COALESCE(NULLIF(a.person_email, 'None'),
                               NULLIF(c.email, 'None')), '')))  AS email,
    COALESCE(NULLIF(a.first_name, 'None'),
             NULLIF(c.first_name, 'None'))                      AS first_name,
    COALESCE(NULLIF(a.last_name,  'None'),
             NULLIF(c.last_name,  'None'))                      AS last_name,
    NULLIF(a.name, 'None')                                      AS account_name,
    o.account_id                                                AS account_id,
    o.id                                                        AS opportunity_id,
    NULLIF(o.name, 'None')                                      AS opportunity_name,
    NULLIF(o.stage_name, 'None')                                AS stage_name,
    o.is_closed                                                 AS is_closed,
    o.is_won                                                    AS is_won,
    o.koreps2_product_c                                         AS product,
    o.amount                                                    AS amount,
    NULLIF(o.seat_block_c, 'None')                              AS seat_block,
    o.number_of_seats_c                                         AS number_of_seats,
    o.ticket_price_c                                            AS ticket_price,
    CAST(o.close_date AS STRING)                                AS close_date,
    TIMESTAMP(o.close_date)                                     AS event_at,
    rep.name                                                    AS rep_name,
    rep.email                                                   AS rep_email,
    rep.phone                                                   AS rep_phone,
    rep.name                                                    AS account_owner,
    nm.ticketing_event_date                                     AS ticketing_event_date,
    nm.ticketing_event_name                                     AS ticketing_event_name
  FROM `sdfc-udp-dev.salesforce_silver.opportunity` o
  JOIN `sdfc-udp-dev.salesforce_silver.account` a
    ON a.id = o.account_id
  LEFT JOIN `sdfc-udp-dev.salesforce_silver.contact` c
    ON c.account_id = a.id
  LEFT JOIN (
    SELECT id, name,
           LOWER(NULLIF(NULLIF(email, 'None'), '')) AS email,
           NULLIF(NULLIF(phone, 'None'), '')        AS phone
    FROM `sdfc-udp-dev.salesforce_silver.user`
    WHERE name NOT IN ('KORE Service', 'KORE Admin',
                       'Leap Marketing', 'Vozzi Integration')
  ) rep ON rep.id = a.owner_id
  -- Next home match (mirrors the hub): real fixtures only — shells (Member
  -- Lounge/Extra Time/Hospitality/parking/plan shells with placeholder
  -- dates) and "vs TBD" contingencies excluded by long-name pattern; the
  -- un-suffixed main event code (shortest name) wins. LEFT JOIN ON TRUE so
  -- an empty off-season calendar nulls the field, not the candidates.
  LEFT JOIN (
    SELECT event_epoch AS ticketing_event_date,
           event_name_long AS ticketing_event_name
    FROM (
      SELECT
        UNIX_SECONDS(TIMESTAMP(DATETIME(event_date,
          COALESCE(SAFE.PARSE_TIME('%H:%M:%S', event_time),
                   TIME '00:00:00')),
          'America/Los_Angeles'))  AS event_epoch,
        event_name,
        event_name_long
      FROM `sdfc-udp-dev.ticketmaster_silver.dim_event_calendar`
      WHERE is_match_event = TRUE
        AND event_status = 'A'
        AND event_date >= CURRENT_DATE('America/Los_Angeles')
        AND REGEXP_CONTAINS(event_name_long, r'(?i)san diego fc vs')
        AND NOT REGEXP_CONTAINS(event_name_long,
            r'(?i)hospitality|member lounge|extra time|lanyard|parking|friendly|\btest\b|\btbd\b')
    )
    WHERE event_epoch > UNIX_SECONDS(CURRENT_TIMESTAMP())
    QUALIFY ROW_NUMBER() OVER (
      ORDER BY event_epoch, LENGTH(event_name)
    ) = 1
  ) nm ON TRUE
  WHERE o.is_closed = TRUE
    AND o.is_won = TRUE
    AND (
      (UPPER(o.name) LIKE '%SUPP%'
       AND o.record_type_id = '012UR000001cuNBYAY'
       AND o.group_c = 'General Season Tickets')
      OR
      (o.record_type_id = '012UR000001fAEAYA2'
       AND o.koreps2_product_c = 'Premium Season Membership')
    )
    AND o.close_date >= DATE_SUB(CURRENT_DATE('UTC'), INTERVAL 1 DAY)
  -- No-email accounts are held, not fired (mirrors the hub guard): a fire
  -- would burn the exactly-once key on an event Send Event can never
  -- deliver. Dedup prefers a contact row that has an email.
  QUALIFY ROW_NUMBER() OVER (
    PARTITION BY o.id
    ORDER BY COALESCE(NULLIF(a.person_email, 'None'),
                      NULLIF(c.email, 'None')) IS NOT NULL DESC,
             o.system_modstamp DESC
  ) = 1
    AND email IS NOT NULL
)


SELECT
  'tb_signup_260715'   AS trigger,
  cand.dedup_key,
  cand.email,
  cand.first_name,
  cand.last_name,
  cand.event_at,
  TO_JSON_STRING(STRUCT(
    cand.dedup_key, cand.email, cand.activity_id, cand.campaign_title,
    cand.signup_form_family, cand.is_world_cup, cand.is_new_fan_24h,
    cand.fan_created_at, cand.activity_at, cand.first_name, cand.last_name,
    cand.fan_source, cand.phone_subscribed, cand.has_season_plan,
    cand.postal_code
  ))            AS payload_json
FROM tb_signup_260715_cand cand
LEFT JOIN `sdfc-udp-dev.customerio_state.cio_trigger_log` s
  ON s.trigger = 'tb_signup_260715'
 AND s.dedup_key = cand.dedup_key
 AND s.status IN ('sent', 'suppressed', 'baseline')
WHERE s.dedup_key IS NULL

UNION ALL

SELECT
  'welcome_tickets_single_game',
  cand.dedup_key,
  cand.email,
  cand.first_name,
  cand.last_name,
  CAST(NULL AS TIMESTAMP),
  TO_JSON_STRING(STRUCT(
    cand.dedup_key, cand.email, cand.first_name, cand.last_name,
    cand.tm_acct_id, cand.ticket_seats_purchased, cand.events_ticketed
  ))
FROM sg_cand cand
LEFT JOIN `sdfc-udp-dev.customerio_state.cio_trigger_log` s
  ON s.trigger = 'welcome_tickets_single_game'
 AND s.dedup_key = cand.dedup_key
 AND s.status IN ('sent', 'suppressed', 'baseline')
WHERE s.dedup_key IS NULL

UNION ALL

-- welcome_shopify_260715: DRAFT logic (Automation Index entry criteria; still
-- WHERE FALSE / enabled=False in triggers.py — port + baseline before
-- enabling; the portal marks this trigger "not enabled yet").
SELECT
  'welcome_shopify_260715',
  cand.dedup_key,
  cand.email,
  cand.first_name,
  cand.last_name,
  cand.event_at,
  TO_JSON_STRING(STRUCT(
    cand.dedup_key, cand.email, cand.order_id, cand.order_number,
    cand.first_order_at, cand.first_name, cand.last_name,
    cand.is_new_to_warehouse
  ))
FROM shopify_cand cand
LEFT JOIN `sdfc-udp-dev.customerio_state.cio_trigger_log` s
  ON s.trigger = 'welcome_shopify_260715'
 AND s.dedup_key = cand.dedup_key
 AND s.status IN ('sent', 'suppressed', 'baseline')
WHERE s.dedup_key IS NULL

UNION ALL

-- welcome_tickets_membership: shadow placeholder; live logic still on the
-- legacy cio_welcome_trigger poller until the webhook-path cutover.
SELECT
  'welcome_tickets_membership',
  CAST(NULL AS STRING), CAST(NULL AS STRING), CAST(NULL AS STRING),
  CAST(NULL AS STRING), CAST(NULL AS TIMESTAMP), CAST(NULL AS STRING)
FROM (SELECT 1) WHERE FALSE


UNION ALL

-- welcome_tickets_supporters_260807: STM-Supporter-New-Member-Welcome-Journey-260807
-- (CIO relay pair 60/61).
SELECT
  'welcome_tickets_supporters_260807',
  cand.dedup_key,
  cand.email,
  cand.first_name,
  cand.last_name,
  cand.event_at,
  TO_JSON_STRING(STRUCT(
    cand.dedup_key, cand.email, cand.first_name, cand.last_name,
    cand.account_name, cand.account_id, cand.opportunity_id,
    cand.opportunity_name, cand.stage_name, cand.is_closed, cand.is_won,
    cand.product, cand.amount, cand.seat_block, cand.number_of_seats,
    cand.ticket_price, cand.close_date, cand.rep_name, cand.rep_email,
    cand.rep_phone, cand.account_owner, cand.ticketing_event_date,
    cand.ticketing_event_name
  ))
FROM membership_cand cand
LEFT JOIN `sdfc-udp-dev.customerio_state.cio_trigger_log` s
  ON s.trigger = 'welcome_tickets_supporters_260807'
 AND s.dedup_key = cand.dedup_key
 AND s.status IN ('sent', 'suppressed', 'baseline')
WHERE cand.matched_trigger = 'welcome_tickets_supporters_260807'
  AND s.dedup_key IS NULL

UNION ALL

-- welcome_tickets_premium_260807: STM-Premium-New-Member-Welcome-Journey-260807
-- (CIO relay pair 68/69).
SELECT
  'welcome_tickets_premium_260807',
  cand.dedup_key,
  cand.email,
  cand.first_name,
  cand.last_name,
  cand.event_at,
  TO_JSON_STRING(STRUCT(
    cand.dedup_key, cand.email, cand.first_name, cand.last_name,
    cand.account_name, cand.account_id, cand.opportunity_id,
    cand.opportunity_name, cand.stage_name, cand.is_closed, cand.is_won,
    cand.product, cand.amount, cand.seat_block, cand.number_of_seats,
    cand.ticket_price, cand.close_date, cand.rep_name, cand.rep_email,
    cand.rep_phone, cand.account_owner, cand.ticketing_event_date,
    cand.ticketing_event_name
  ))
FROM membership_cand cand
LEFT JOIN `sdfc-udp-dev.customerio_state.cio_trigger_log` s
  ON s.trigger = 'welcome_tickets_premium_260807'
 AND s.dedup_key = cand.dedup_key
 AND s.status IN ('sent', 'suppressed', 'baseline')
WHERE cand.matched_trigger = 'welcome_tickets_premium_260807'
  AND s.dedup_key IS NULL