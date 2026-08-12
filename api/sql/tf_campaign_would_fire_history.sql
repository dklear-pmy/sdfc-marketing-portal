-- Parameterized HISTORY variant of vw_campaign_would_fire: the events a
-- trigger WOULD HAVE fired on in the trailing window. Two consumers, both
-- strictly read-or-shadow — the portal never fires a production webhook:
--   * the Matching Customers tab's "last N days" view (display only);
--   * the harness's real-data ("shadow") replay runs (sanitized fires at the
--     TEST twin only).
-- Differences from the live view, both deliberate:
--   * the recency window is the history_days parameter, not 24h;
--   * NO dedup against cio_trigger_log — an event the hub already really
--     fired on is exactly the kind of realistic row a replay wants.
-- MIRROR MAINTENANCE: the candidate SQL below must stay in step with the
-- matching branch of vw_campaign_would_fire.sql AND the hub's triggers.py.
-- Branches present: the shared SF membership CTE — supporters_260807 +
-- premium_260807, discriminated by record type exactly like the live view.
-- (tb_signup / single-game are attribute-state or high-volume event triggers;
-- add them only with a real spec for what "history" means there.)

CREATE OR REPLACE TABLE FUNCTION
  `sdfc-udp-dev.customerio_state.tf_campaign_would_fire_history`(history_days INT64)
AS (
WITH membership_cand AS (
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
  cand.matched_trigger AS trigger,
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
  )) AS payload_json
FROM membership_cand cand
WHERE cand.matched_trigger IS NOT NULL
);
