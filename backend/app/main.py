"""HTTP API for submitting OCR jobs, polling their status and downloading results."""

from __future__ import annotations

import asyncio
import logging
import re
import shutil
import unicodedata
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated, BinaryIO
from urllib.parse import quote

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, Response

from . import config, pipeline
from .jobs import Job, store

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

JOB_ID_RE = re.compile(r"^[0-9a-f]{32}$")
CHUNK = 1024 * 1024


@asynccontextmanager
async def lifespan(app: FastAPI):
    store.load()
    app.state.languages = await pipeline.available_languages()
    cleaner = asyncio.create_task(store.cleanup_loop())
    yield
    cleaner.cancel()


app = FastAPI(title="OCR Desk", lifespan=lifespan, docs_url="/api/docs", openapi_url="/api/openapi.json")


def _safe_name(name: str | None) -> str:
    name = unicodedata.normalize("NFC", Path(name or "file").name)
    name = re.sub(r"[\x00-\x1f\x7f/\\]", "_", name).strip(" .") or "file"
    return name[-150:]


def _copy_limited(src: BinaryIO, dst: Path, limit: int) -> int:
    size = 0
    with open(dst, "wb") as out:
        while chunk := src.read(CHUNK):
            size += len(chunk)
            if size > limit:
                raise HTTPException(413, f"File exceeds the {config.MAX_FILE_MB} MB limit.")
            out.write(chunk)
    return size


def _get_job(job_id: str) -> Job:
    job = store.get(job_id) if JOB_ID_RE.match(job_id) else None
    if job is None:
        raise HTTPException(404, "Job not found or expired.")
    return job


@app.get("/api/health")
async def health():
    return {"ok": True}


@app.get("/api/config")
async def get_config():
    return {
        "languages": app.state.languages,
        "default_language": config.DEFAULT_LANGUAGE,
        "modes": list(pipeline.MODES),
        "accepted_extensions": sorted(pipeline.ACCEPTED_EXT),
        "max_file_mb": config.MAX_FILE_MB,
        "max_files_per_job": config.MAX_FILES_PER_JOB,
        "job_ttl_minutes": config.JOB_TTL_MINUTES,
    }


@app.post("/api/jobs", status_code=202)
async def create_job(
    files: Annotated[list[UploadFile], File()],
    languages: Annotated[str, Form()] = "",
    mode: Annotated[str, Form()] = "auto",
    rotate: Annotated[bool, Form()] = True,
    deskew: Annotated[bool, Form()] = False,
    clean: Annotated[bool, Form()] = False,
    title: Annotated[str, Form(max_length=150)] = "",
):
    if not files:
        raise HTTPException(400, "No files uploaded.")
    if len(files) > config.MAX_FILES_PER_JOB:
        raise HTTPException(400, f"At most {config.MAX_FILES_PER_JOB} files per job.")
    if mode not in pipeline.MODES:
        raise HTTPException(400, f"Unknown mode '{mode}'.")
    langs = [lang for lang in re.split(r"[+,\s]+", languages) if lang] or [config.DEFAULT_LANGUAGE]
    unknown = [lang for lang in langs if lang not in app.state.languages]
    if unknown:
        raise HTTPException(400, f"Unsupported language(s): {', '.join(unknown)}.")

    names = [_safe_name(f.filename) for f in files]
    bad = [n for n in names if pipeline.classify(n) is None]
    if bad:
        raise HTTPException(415, f"Unsupported file type: {', '.join(bad)}.")

    job_id = uuid.uuid4().hex
    input_dir = config.JOBS_DIR / job_id / "input"
    input_dir.mkdir(parents=True)
    inputs = []
    try:
        for i, (upload, name) in enumerate(zip(files, names)):
            dest = input_dir / f"{i:03d}{Path(name).suffix.lower()}"
            size = await asyncio.to_thread(_copy_limited, upload.file, dest, config.MAX_FILE_MB * CHUNK)
            if size == 0:
                raise HTTPException(400, f"'{name}' is empty.")
            inputs.append({"name": name, "path": str(dest), "kind": pipeline.classify(name), "size": size})
    except BaseException:
        shutil.rmtree(input_dir.parent, ignore_errors=True)
        raise

    options = {
        "languages": langs,
        "mode": mode,
        "rotate": rotate,
        "deskew": deskew,
        "clean": clean,
        "title": _safe_name(title) if title.strip() else "",
    }
    job = Job(id=job_id, inputs=inputs, options=options)
    store.submit(job)
    return job.public(store.queue_position(job))


@app.get("/api/jobs/{job_id}")
async def get_job(job_id: str):
    job = _get_job(job_id)
    return job.public(store.queue_position(job))


@app.delete("/api/jobs/{job_id}", status_code=204)
async def delete_job(job_id: str):
    _get_job(job_id)
    await store.delete(job_id)
    return Response(status_code=204)


def _disposition(filename: str, inline: bool) -> str:
    fallback = unicodedata.normalize("NFKD", filename).encode("ascii", "ignore").decode() or "download"
    fallback = re.sub(r'["\\;]', "_", fallback)
    kind = "inline" if inline else "attachment"
    return f"{kind}; filename=\"{fallback}\"; filename*=UTF-8''{quote(filename)}"


@app.get("/api/jobs/{job_id}/{kind}")
async def download(job_id: str, kind: str, inline: bool = False):
    if kind not in ("pdf", "txt"):
        raise HTTPException(404)
    job = _get_job(job_id)
    if job.status != "done":
        raise HTTPException(409, "Job is not finished yet.")
    filename = job.result["output_name"] if kind == "pdf" else job.result["text_name"]
    stored = f"output.{kind}"
    media = "application/pdf" if kind == "pdf" else "text/plain; charset=utf-8"
    headers = {"Content-Disposition": _disposition(filename, inline), "Cache-Control": "private, no-store"}
    if config.USE_X_ACCEL:
        headers["X-Accel-Redirect"] = f"{config.X_ACCEL_PREFIX}/jobs/{job_id}/{stored}"
        return Response(headers=headers, media_type=media)
    return FileResponse(config.JOBS_DIR / job_id / stored, headers=headers, media_type=media)
