from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

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
