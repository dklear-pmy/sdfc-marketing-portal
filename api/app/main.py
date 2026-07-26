from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from . import bqstate, runner
from .auth import Principal, require_role
from .config import CORS_ORIGINS
from .validator import validate_slug

app = FastAPI(title="SDFC Marketing Ops API", docs_url=None, redoc_url=None)

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_methods=["*"],
    allow_headers=["Authorization", "Content-Type"],
)


@app.get("/api/health")
def health() -> dict:
    return {"status": "ok"}


@app.get("/api/harness/validate/{slug}")
def harness_validate(slug: str, principal: Principal = require_role("viewer")) -> dict:
    if len(slug) > 120:
        raise HTTPException(status_code=400, detail="Slug too long")
    return validate_slug(slug)


@app.post("/api/harness/run/{slug}")
def harness_start_run(slug: str, principal: Principal = require_role("operator")) -> dict:
    try:
        return runner.start_run(slug, actor=principal.email)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.get("/api/harness/runs")
def harness_list_runs(principal: Principal = require_role("viewer")) -> dict:
    return {"runs": bqstate.list_runs()}


@app.get("/api/harness/runs/{run_id}")
def harness_get_run(run_id: str, principal: Principal = require_role("viewer")) -> dict:
    run = bqstate.get_run(run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="Unknown run")
    return run


@app.post("/api/harness/runs/{run_id}/advance")
def harness_advance_run(run_id: str, principal: Principal = require_role("operator")) -> dict:
    try:
        return runner.advance_run(run_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="Unknown run")
