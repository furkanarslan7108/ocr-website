"""In-process job store and bounded worker queue, with on-disk metadata and TTL cleanup."""

from __future__ import annotations

import asyncio
import json
import logging
import shutil
import time
from dataclasses import asdict, dataclass, field

from . import config, pipeline

log = logging.getLogger(__name__)

TERMINAL = {"done", "error"}


@dataclass
class Job:
    id: str
    inputs: list[dict]
    options: dict
    status: str = "queued"  # queued | processing | done | error
    stage: str = "Queued"
    progress: float = 0.0
    error: str | None = None
    result: dict | None = None
    created: float = field(default_factory=time.time)
    finished: float | None = None

    def public(self, queue_position: int | None = None) -> dict:
        return {
            "id": self.id,
            "status": self.status,
            "stage": self.stage,
            "progress": round(self.progress, 4),
            "error": self.error,
            "result": self.result,
            "files": [{"name": i["name"], "size": i["size"]} for i in self.inputs],
            "options": self.options,
            "created": self.created,
            "finished": self.finished,
            "queue_position": queue_position,
        }


class JobStore:
    def __init__(self) -> None:
        self.jobs: dict[str, Job] = {}
        self.tasks: dict[str, asyncio.Task] = {}
        self.slots = asyncio.Semaphore(config.MAX_CONCURRENT_JOBS)

    # -- persistence

    def _save(self, job: Job) -> None:
        path = config.JOBS_DIR / job.id / "job.json"
        if path.parent.exists():
            path.write_text(json.dumps(asdict(job)))

    def load(self) -> None:
        """Restore finished jobs after a restart; anything mid-flight is discarded."""
        config.JOBS_DIR.mkdir(parents=True, exist_ok=True)
        for job_dir in config.JOBS_DIR.iterdir():
            try:
                job = Job(**json.loads((job_dir / "job.json").read_text()))
                if job.status == "done" and (job_dir / "output.pdf").exists():
                    self.jobs[job.id] = job
                    continue
            except (OSError, ValueError, TypeError):
                pass
            shutil.rmtree(job_dir, ignore_errors=True)

    # -- lifecycle

    def get(self, job_id: str) -> Job | None:
        return self.jobs.get(job_id)

    def queue_position(self, job: Job) -> int | None:
        if job.status != "queued":
            return None
        return sum(1 for j in self.jobs.values() if j.status == "queued" and j.created < job.created) + 1

    def submit(self, job: Job) -> None:
        self.jobs[job.id] = job
        self._save(job)
        task = asyncio.create_task(self._run(job))
        self.tasks[job.id] = task
        task.add_done_callback(lambda _: self.tasks.pop(job.id, None))

    async def _run(self, job: Job) -> None:
        def report(progress: float, stage: str) -> None:
            job.progress = max(job.progress, min(progress, 0.99))
            job.stage = stage

        try:
            async with self.slots:
                job.status, job.stage = "processing", "Starting"
                job.result = await pipeline.process(job, report)
                job.status, job.stage, job.progress = "done", "Done", 1.0
        except asyncio.CancelledError:
            raise
        except pipeline.PipelineError as exc:
            job.status, job.error = "error", str(exc)
        except Exception:
            log.exception("Job %s failed", job.id)
            job.status, job.error = "error", "Unexpected error while processing this file."
        finally:
            job.finished = time.time()
            if job.status == "error":
                job.stage = "Failed"
                shutil.rmtree(config.JOBS_DIR / job.id / "work", ignore_errors=True)
            self._save(job)

    async def delete(self, job_id: str) -> bool:
        job = self.jobs.pop(job_id, None)
        if job is None:
            return False
        task = self.tasks.get(job_id)
        if task:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        await asyncio.to_thread(shutil.rmtree, config.JOBS_DIR / job_id, True)
        return True

    async def cleanup_loop(self) -> None:
        ttl = config.JOB_TTL_MINUTES * 60
        while True:
            now = time.time()
            expired = [j.id for j in self.jobs.values() if j.status in TERMINAL and now - (j.finished or now) > ttl]
            for job_id in expired:
                await self.delete(job_id)
            # Orphaned directories (e.g. upload aborted mid-way).
            for job_dir in config.JOBS_DIR.iterdir():
                if job_dir.name not in self.jobs and now - job_dir.stat().st_mtime > ttl:
                    await asyncio.to_thread(shutil.rmtree, job_dir, True)
            await asyncio.sleep(300)


store = JobStore()
