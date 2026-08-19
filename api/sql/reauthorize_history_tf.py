#!/usr/bin/env python3
"""Re-authorize tf_campaign_would_fire_history on the datasets it reads.

RUN THIS EVERY TIME tf_campaign_would_fire_history.sql IS APPLIED.

Replacing a routine EXPIRES its authorization. The access entry stays listed
on the dataset, so `bq show` looks perfectly healthy while every call from the
portal service account fails with:

    403 Access Denied: Table sdfc-udp-dev:salesforce_silver.account:
    User does not have permission to query table ...

BigQuery clears the stale entry on its own within 24 hours; the documented
remedy for an immediate fix is to delete the entry and re-add it, which is all
this script does. Authorized VIEWS do not behave this way — only routines —
so vw_campaign_would_fire keeps working and the failure looks trigger-specific
in the UI (the "last 90 days" tab 500s while "next run" is fine).

    python3 api/sql/reauthorize_history_tf.py
"""

import json
import os
import subprocess
import sys
import tempfile

PROJECT = "sdfc-udp-dev"
# The datasets tf_campaign_would_fire_history reads. Add to this list when the
# table function grows a branch that reads a new dataset.
DATASETS = [
    "salesforce_silver",
    "ticketmaster_silver",
    "tradablebits_silver",
    "shopify_silver",
]
ROUTINE = {
    "projectId": PROJECT,
    "datasetId": "customerio_state",
    "routineId": "tf_campaign_would_fire_history",
}


def bq(*args: str) -> str:
    return subprocess.run(
        ["bq", f"--project_id={PROJECT}", *args],
        check=True, capture_output=True, text=True,
    ).stdout


def put(dataset: str, meta: dict, path: str) -> None:
    with open(path, "w") as fh:
        json.dump(meta, fh)
    bq("update", "--source", path, dataset)


def main() -> int:
    failed = []
    with tempfile.TemporaryDirectory() as tmp:
        for dataset in DATASETS:
            meta = json.loads(bq("show", "--format=prettyjson", dataset))
            path = os.path.join(tmp, f"{dataset}.json")
            others = [a for a in meta.get("access", []) if a.get("routine") != ROUTINE]

            meta["access"] = others                      # drop the stale grant
            put(dataset, meta, path)
            meta["access"] = others + [{"routine": ROUTINE}]  # re-add it fresh
            put(dataset, meta, path)

            check = json.loads(bq("show", "--format=prettyjson", dataset))
            ok = any(a.get("routine") == ROUTINE for a in check.get("access", []))
            print(f"{dataset}: re-authorized={ok}")
            if not ok:
                failed.append(dataset)

    if failed:
        print(f"FAILED: {', '.join(failed)}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
