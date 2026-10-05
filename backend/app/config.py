"""Runtime configuration, read once from environment variables."""

import os
from pathlib import Path


def _int(name: str, default: int) -> int:
    value = os.environ.get(name, "").strip()
    return int(value) if value else default


DATA_DIR = Path(os.environ.get("DATA_DIR", "/data"))
JOBS_DIR = DATA_DIR / "jobs"

MAX_FILE_MB = _int("MAX_FILE_MB", 100)
MAX_FILES_PER_JOB = _int("MAX_FILES_PER_JOB", 20)
MAX_PAGES_PER_JOB = _int("MAX_PAGES_PER_JOB", 1000)

# How many jobs run at once, and how many CPU workers each OCR run may use.
MAX_CONCURRENT_JOBS = _int("MAX_CONCURRENT_JOBS", 2)
OCR_JOBS = _int("OCR_JOBS", os.cpu_count() or 2)
# ocrmypdf --optimize level: 0 = fastest, 1 = safe lossless (default), 2/3 = lossy, slower.
OCR_OPTIMIZE = _int("OCR_OPTIMIZE", 1)
STEP_TIMEOUT_SECONDS = _int("STEP_TIMEOUT_SECONDS", 1800)

JOB_TTL_MINUTES = _int("JOB_TTL_MINUTES", 120)
DEFAULT_LANGUAGE = os.environ.get("DEFAULT_LANGUAGE", "eng")

# When served behind nginx, downloads are handed off with X-Accel-Redirect.
USE_X_ACCEL = os.environ.get("USE_X_ACCEL", "1") == "1"
X_ACCEL_PREFIX = "/protected"
