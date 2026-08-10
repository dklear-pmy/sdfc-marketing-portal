"""BigQuery-backed harness state: identity registry + run log.

Tables live in `sdfc-udp-dev.customerio_state` (WRITER via dataset ACL).
Volume is tiny (a few rows per run), so plain DML with query parameters is fine.
"""

import json
import uuid
from datetime import datetime, timezone

from google.cloud import bigquery

GCP_PROJECT = "sdfc-udp-dev"
_DATASET = f"{GCP_PROJECT}.customerio_state"

_client: bigquery.Client | None = None


def client() -> bigquery.Client:
    global _client
    if _client is None:
        _client = bigquery.Client(project=GCP_PROJECT)
    return _client


def _now() -> datetime:
    return datetime.now(timezone.utc)


def mint_identity(slug: str, run_id: str) -> str:
    """Allocate the next scenario-N identity and burn it atomically enough
    for our single-operator volume (MERGE-free: max+1 insert)."""
    q = f"""
    INSERT INTO `{_DATASET}.harness_identities` (identity_num, email, slug, run_id, burned_at)
    SELECT
      COALESCE(MAX(identity_num), 0) + 1,
      FORMAT('scenario-%03d@qa.sdfc.dev', COALESCE(MAX(identity_num), 0) + 1),
      @slug, @run_id, CURRENT_TIMESTAMP()
    FROM `{_DATASET}.harness_identities`
    """
    job = client().query(
        q,
        job_config=bigquery.QueryJobConfig(
            query_parameters=[
                bigquery.ScalarQueryParameter("slug", "STRING", slug),
                bigquery.ScalarQueryParameter("run_id", "STRING", run_id),
            ]
        ),
    )
    job.result()
    rows = list(
        client().query(
            f"SELECT email FROM `{_DATASET}.harness_identities` WHERE run_id = @run_id",
            job_config=bigquery.QueryJobConfig(
                query_parameters=[bigquery.ScalarQueryParameter("run_id", "STRING", run_id)]
            ),
        ).result()
    )
    return rows[0].email


def create_run(
    slug: str,
    engagement_path: str,
    actor: str | None,
    *,
    mode: str = "synthetic",
    identity: str | None = None,
    source_key: str | None = None,
) -> str:
    """mode 'synthetic' mints a scenario-NNN identity; mode 'shadow' rows are
    created with an explicit identity (derived from the real row + run id by
    shadow.py) and carry the real event's dedup_key as source_key."""
    run_id = f"run-{_now():%Y%m%d-%H%M%S}-{uuid.uuid4().hex[:6]}"
    if identity is None:
        identity = mint_identity(slug, run_id)
    q = f"""
    INSERT INTO `{_DATASET}.harness_runs`
      (run_id, slug, identity, status, stage, engagement_path, started_by, started_at, updated_at, timeline_json, mode, source_key)
    VALUES (@run_id, @slug, @identity, 'RUNNING', 'created', @path, @actor, CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP(), '[]', @mode, @source_key)
    """
    client().query(
        q,
        job_config=bigquery.QueryJobConfig(
            query_parameters=[
                bigquery.ScalarQueryParameter("run_id", "STRING", run_id),
                bigquery.ScalarQueryParameter("slug", "STRING", slug),
                bigquery.ScalarQueryParameter("identity", "STRING", identity),
                bigquery.ScalarQueryParameter("path", "STRING", engagement_path),
                bigquery.ScalarQueryParameter("actor", "STRING", actor),
                bigquery.ScalarQueryParameter("mode", "STRING", mode),
                bigquery.ScalarQueryParameter("source_key", "STRING", source_key),
            ]
        ),
    ).result()
    return run_id


def set_run_identity(run_id: str, identity: str) -> None:
    client().query(
        f"UPDATE `{_DATASET}.harness_runs` SET identity = @identity, updated_at = CURRENT_TIMESTAMP() WHERE run_id = @run_id",
        job_config=bigquery.QueryJobConfig(
            query_parameters=[
                bigquery.ScalarQueryParameter("identity", "STRING", identity),
                bigquery.ScalarQueryParameter("run_id", "STRING", run_id),
            ]
        ),
    ).result()


def shadow_source_keys(slug: str) -> set[str]:
    """dedup_keys of real events already shadow-run for this slug — the
    replay/tick dedup so one real event never fires twice."""
    rows = client().query(
        f"SELECT DISTINCT source_key FROM `{_DATASET}.harness_runs` WHERE slug = @slug AND mode = 'shadow' AND source_key IS NOT NULL",
        job_config=bigquery.QueryJobConfig(
            query_parameters=[bigquery.ScalarQueryParameter("slug", "STRING", slug)]
        ),
    ).result()
    return {r.source_key for r in rows}


def get_run(run_id: str) -> dict | None:
    rows = list(
        client().query(
            f"SELECT * FROM `{_DATASET}.harness_runs` WHERE run_id = @run_id",
            job_config=bigquery.QueryJobConfig(
                query_parameters=[bigquery.ScalarQueryParameter("run_id", "STRING", run_id)]
            ),
        ).result()
    )
    if not rows:
        return None
    r = dict(rows[0])
    r["timeline"] = json.loads(r.pop("timeline_json") or "[]")
    for k in ("started_at", "updated_at"):
        if r.get(k):
            r[k] = r[k].isoformat()
    return r


def list_runs(q: str | None = None, status: str | None = None, limit: int = 50) -> list[dict]:
    limit = max(1, min(int(limit), 200))
    where = ["TRUE"]
    params: list[bigquery.ScalarQueryParameter] = []
    if q:
        where.append(
            "(STRPOS(LOWER(slug), LOWER(@q)) > 0"
            " OR STRPOS(LOWER(identity), LOWER(@q)) > 0"
            " OR STRPOS(LOWER(run_id), LOWER(@q)) > 0)"
        )
        params.append(bigquery.ScalarQueryParameter("q", "STRING", q))
    if status:
        where.append("status = @status")
        params.append(bigquery.ScalarQueryParameter("status", "STRING", status.upper()))
    rows = client().query(
        f"""
        SELECT run_id, slug, identity, status, stage, detail, started_at, updated_at, mode, source_key
        FROM `{_DATASET}.harness_runs`
        WHERE {' AND '.join(where)}
        ORDER BY started_at DESC
        LIMIT {limit}
        """,
        job_config=bigquery.QueryJobConfig(query_parameters=params),
    ).result()
    out = []
    for row in rows:
        r = dict(row)
        for k in ("started_at", "updated_at"):
            if r.get(k):
                r[k] = r[k].isoformat()
        out.append(r)
    return out


def running_run_ids() -> list[str]:
    rows = client().query(
        f"SELECT run_id FROM `{_DATASET}.harness_runs` WHERE status = 'RUNNING' ORDER BY started_at"
    ).result()
    return [r.run_id for r in rows]


def update_run(run_id: str, *, status: str, stage: str, timeline: list[dict], detail: str | None = None) -> None:
    q = f"""
    UPDATE `{_DATASET}.harness_runs`
    SET status = @status, stage = @stage, timeline_json = @timeline, detail = @detail, updated_at = CURRENT_TIMESTAMP()
    WHERE run_id = @run_id
    """
    client().query(
        q,
        job_config=bigquery.QueryJobConfig(
            query_parameters=[
                bigquery.ScalarQueryParameter("status", "STRING", status),
                bigquery.ScalarQueryParameter("stage", "STRING", stage),
                bigquery.ScalarQueryParameter("timeline", "STRING", json.dumps(timeline)),
                bigquery.ScalarQueryParameter("detail", "STRING", detail),
                bigquery.ScalarQueryParameter("run_id", "STRING", run_id),
            ]
        ),
    ).result()
