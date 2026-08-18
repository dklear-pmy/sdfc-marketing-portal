-- Parameterized HISTORY variant of vw_campaign_would_fire: the events a
-- trigger WOULD HAVE fired on in the trailing window. Two consumers, both
-- strictly read-or-shadow — the portal never fires a production webhook:
--   * the Matching Customers tab's "last N days" view (display only);
--   * the harness's real-data ("shadow") replay runs (sanitized fires at the
--     TEST twin only).
-- Differences from the live view, both deliberate:
--   * the recency window is the history_days parameter, not 24h/72h;
--   * NO dedup against cio_trigger_log — an event the hub already really
--     fired on is exactly the kind of realistic row a replay wants.
-- MIRROR MAINTENANCE: the candidate SQL below must stay in step with the
-- matching branch of vw_campaign_would_fire.sql AND the hub's triggers.py.
--
-- Branches present, and why these and not the rest: a trigger can only have
-- history if it selects on a TIMESTAMPED EVENT, so "what would have fired N
-- days ago" is reconstructable from the event's own time.
--   tb_signup_260715      — event = the TB form-entry activity (activity_ts).
--   welcome_shopify_260715 — event = the first paid Shopify order (order_at).
--   supporters/premium 260807 — event = the opportunity close date.
-- welcome_tickets_single_game is deliberately ABSENT: it selects on current
-- fan state (first purchase, zero attendance, no season plan) out of
-- fan_attributes_cio_sync, which retains no history — the live view even
-- emits NULL for its event_at. Reconstructing it would mean inventing a
-- spec for what the state WAS on a past day; affected.py explains that in
-- the UI rather than guessing here. stm_welcome_tickets_260807 is likewise
-- absent — its hub query is still the WHERE FALSE placeholder.

CREATE OR REPLACE TABLE FUNCTION
  `sdfc-udp-dev.customerio_state.tf_campaign_would_fire_history`(history_days INT64)
AS (
WITH acts AS (
  -- Partition filter tracks history_days (+1 day of slack for the UTC edge
  -- and for an activity ingested the day after it was created). Without
  -- this widening the 3-day prune of the live view would silently cap every
  -- window at 3 days while still LOOKING like it honoured the parameter.
  SELECT
    SAFE_CAST(NULLIF(CAST(activity_id AS STRING), '') AS INT64)               AS activity_id,
    SAFE_CAST(NULLIF(CAST(fan_id AS STRING), '') AS STRING)                   AS fan_id,
    SAFE_CAST(NULLIF(CAST(campaign_title AS STRING), '') AS STRING)           AS campaign_title,
    SAFE_CAST(NULLIF(CAST(creation_timestamp_iso AS STRING), '') AS TIMESTAMP) AS activity_ts,
    SAFE_CAST(NULLIF(CAST(ingestion_timestamp AS STRING), '') AS TIMESTAMP)    AS ingested_at
  FROM `sdfc-udp-dev.tradablebits_bronze.tb_activities`
  WHERE DATE(year, month, day)
        BETWEEN DATE_SUB(CURRENT_DATE('UTC'), INTERVAL history_days + 1 DAY)
            AND CURRENT_DATE('UTC')
  -- Bronze re-pulls the same activity across days; keep the newest ingest.
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
  -- MIRROR of the tb_signup_260715 branch, with the 72h recency replaced by
  -- history_days. has_season_plan comes from TODAY's attributes (the view
  -- keeps no history) — it rides the payload, it is not an entry predicate,
  -- so a stale value cannot change WHO appears here.
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
    AND a.activity_ts >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL history_days * 24 HOUR)
),
shopify_first_orders AS (
  -- First paid order per email across ALL time, then windowed below — the
  -- trigger's event is a fan's FIRST order, so the ranking must see every
  -- order, not just the window's.
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
  -- MIRROR of the welcome_shopify_260715 branch (itself DRAFT logic — the
  -- hub trigger is still WHERE FALSE), 72h replaced by history_days. The
  -- no-ticket-history predicates read today's attributes, so this answers
  -- "first-order fans in the window who are STILL merch-only", which is the
  -- honest reconstruction available.
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
    AND o.order_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL history_days * 24 HOUR)
),
membership_cand AS (
  -- MIRROR of _sf_membership_welcome_query in triggers.py: both SF
  -- membership triggers share one query implementation in the hub, so they
  -- share one CTE here; matched_trigger discriminates (record types are
  -- mutually exclusive, an opp can never match both).
  --   stm_welcome_tickets_supporters_260807 (spec 2026-08-07): SUPP marker +
  --     Ticket Sales record type + General Season Tickets group.
  --   stm_welcome_tickets_premium_260807 (spec 2026-08-09): Premium Sales
  --     record type + product 'Premium Season Membership'.
  -- Common: closed/won + close date within history_days; rep_* = Account
  -- OWNER's User record; no-email hold; per-opportunity dedup.
  SELECT
    CASE
      WHEN o.record_type_id = '012UR000001cuNBYAY'
        THEN 'stm_welcome_tickets_supporters_260807'
      WHEN o.record_type_id = '012UR000001fAEAYA2'
        THEN 'stm_welcome_tickets_premium_260807'
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
    AND o.close_date >= DATE_SUB(CURRENT_DATE('UTC'), INTERVAL history_days DAY)
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
  'tb_signup_260715' AS trigger,
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
  )) AS payload_json
FROM tb_signup_260715_cand cand

UNION ALL

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

UNION ALL

SELECT
  cand.matched_trigger,
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
WHERE cand.matched_trigger IS NOT NULL
);
