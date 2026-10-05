"""Conversion + OCR pipeline: any supported input -> PDF -> searchable PDF -> sectioned PDF."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import shutil
import signal
import time
import uuid
from collections.abc import Callable
from pathlib import Path

import img2pdf
import pymupdf
from PIL import Image, ImageOps, ImageSequence
from pillow_heif import register_heif_opener

from . import config, sections

register_heif_opener()
log = logging.getLogger(__name__)

PDF_EXT = {".pdf"}
IMAGE_EXT = {".jpg", ".jpeg", ".png", ".tif", ".tiff", ".bmp", ".gif", ".webp", ".heic", ".heif", ".jp2"}
DOCUMENT_EXT = {".doc", ".docx", ".odt", ".rtf", ".txt", ".md"}
PLAIN_TEXT_EXT = {".txt", ".md"}
ACCEPTED_EXT = PDF_EXT | IMAGE_EXT | DOCUMENT_EXT

MODES = {
    "auto": "--skip-text",  # OCR only pages that have no text yet (fastest)
    "redo": "--redo-ocr",  # replace an existing OCR layer, keep real text
    "force": "--force-ocr",  # rasterize and OCR every page
}

PLUGIN_PATH = Path(__file__).with_name("ocr_progress.py")

ProgressFn = Callable[[float, str], None]


class PipelineError(Exception):
    """An error whose message is safe to show to the user."""


def classify(filename: str) -> str | None:
    ext = Path(filename).suffix.lower()
    if ext in PDF_EXT:
        return "pdf"
    if ext in IMAGE_EXT:
        return "image"
    if ext in DOCUMENT_EXT:
        return "document"
    return None


async def available_languages() -> list[str]:
    try:
        proc = await asyncio.create_subprocess_exec(
            "tesseract", "--list-langs", stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
        )
        out, _ = await proc.communicate()
    except FileNotFoundError:
        return [config.DEFAULT_LANGUAGE]
    langs = [ln.strip() for ln in out.decode().splitlines()[1:]]
    return sorted(lang for lang in langs if lang and lang not in {"osd", "equ"})


async def _run(
    args: list[str],
    *,
    env: dict[str, str] | None = None,
    on_line: Callable[[str], None] | None = None,
) -> tuple[int, str]:
    """Run a command, streaming output lines to on_line. Kills the whole process group on timeout/cancel."""
    proc = await asyncio.create_subprocess_exec(
        *args,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        env=env,
        start_new_session=True,
    )
    err_tail = bytearray()

    async def read_stdout():
        async for raw in proc.stdout:
            if on_line:
                on_line(raw.decode(errors="replace"))

    async def read_stderr():
        async for raw in proc.stderr:
            # ocrmypdf routes plugin output to stderr, so progress events arrive here too.
            if on_line and raw.startswith(b"{"):
                on_line(raw.decode(errors="replace"))
                continue
            err_tail.extend(raw)
            del err_tail[:-16384]

    try:
        await asyncio.wait_for(
            asyncio.gather(read_stdout(), read_stderr(), proc.wait()), config.STEP_TIMEOUT_SECONDS
        )
    except (asyncio.TimeoutError, asyncio.CancelledError) as exc:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        await proc.wait()
        if isinstance(exc, asyncio.TimeoutError):
            raise PipelineError(f"Processing timed out after {config.STEP_TIMEOUT_SECONDS}s.") from None
        raise
    return proc.returncode, err_tail.decode(errors="replace")


# ---------------------------------------------------------------- conversion


def _layout_dpi(im: Image.Image) -> float:
    """Use embedded DPI when it yields a sane page size, else assume the image spans ~A4."""
    long_px = max(im.size)
    dpi = im.info.get("dpi")
    if dpi:
        try:
            d = float(dpi[0])
            if d > 0 and 2.0 <= long_px / d <= 20.0:
                return d
        except (TypeError, ValueError):
            pass
    return min(600.0, max(72.0, long_px / 11.0))


def _flatten(frame: Image.Image) -> Image.Image:
    if frame.mode in ("1", "L", "RGB"):
        return frame
    if frame.mode in ("RGBA", "LA", "PA", "P") or "transparency" in frame.info:
        rgba = frame.convert("RGBA")
        bg = Image.new("RGB", rgba.size, "white")
        bg.paste(rgba, mask=rgba.getchannel("A"))
        return bg
    if frame.mode.startswith("I") or frame.mode == "F":
        # 16/32-bit grayscale (common in scanner TIFFs): stretch the used range to 8 bits.
        f = frame.convert("F")
        lo, hi = f.getextrema()
        scale = 255.0 / (hi - lo) if hi > lo else 1.0
        return f.point(lambda v: (v - lo) * scale).convert("L")
    return frame.convert("RGB")


def image_to_pdf(src: Path, dst: Path, work: Path) -> None:
    try:
        im = Image.open(src)
    except Exception:
        raise PipelineError("The image could not be read; the file may be corrupt or an unsupported variant.") from None
    with im:
        layout = img2pdf.get_fixed_dpi_layout_fun((_layout_dpi(im),) * 2)
        n_frames = getattr(im, "n_frames", 1)
        orientation = im.getexif().get(0x0112, 1)
        if im.format == "JPEG" and n_frames == 1 and orientation == 1 and im.mode in ("L", "RGB", "CMYK"):
            # Fast path: embed the original JPEG bytes without re-encoding.
            dst.write_bytes(img2pdf.convert(src.read_bytes(), layout_fun=layout))
            return
        pages: list[str] = []
        for i, frame in enumerate(ImageSequence.Iterator(im)):
            frame = _flatten(ImageOps.exif_transpose(frame) if i == 0 else frame.copy())
            if im.format in ("JPEG", "HEIF", "WEBP") and frame.mode != "1":
                out = work / f"{src.stem}.f{i}.jpg"
                frame.save(out, "JPEG", quality=92)
            else:
                out = work / f"{src.stem}.f{i}.png"
                frame.save(out, "PNG", compress_level=1)
            pages.append(str(out))
        dst.write_bytes(img2pdf.convert(pages, layout_fun=layout))


async def document_to_pdf(src: Path, dst: Path, work: Path) -> None:
    profile = work / f"lo-{uuid.uuid4().hex}"
    outdir = work / f"lo-out-{uuid.uuid4().hex}"
    args = [
        "soffice", "--headless", "--norestore", "--nolockcheck", "--nologo", "--nodefault",
        f"-env:UserInstallation={profile.as_uri()}",
    ]
    if src.suffix.lower() in PLAIN_TEXT_EXT:
        args.append("--infilter=Text (encoded):UTF8")
    args += ["--convert-to", "pdf", "--outdir", str(outdir), str(src)]
    try:
        rc, err = await _run(args, env={**os.environ, "HOME": str(work)})
        produced = outdir / f"{src.stem}.pdf"
        if rc != 0 or not produced.exists():
            log.warning("LibreOffice failed (rc=%s): %s", rc, err[-2000:])
            raise PipelineError("The document could not be converted; it may be corrupt or password protected.")
        produced.replace(dst)
    finally:
        shutil.rmtree(profile, ignore_errors=True)
        shutil.rmtree(outdir, ignore_errors=True)


def prepare_pdf(src: Path, dst: Path) -> int:
    """Validate a PDF input, decrypt owner-password-only files, and return its page count."""
    try:
        doc = pymupdf.open(src)
    except Exception:
        raise PipelineError("The PDF could not be opened; it may be corrupt.") from None
    with doc:
        if doc.needs_pass:
            raise PipelineError("The PDF is password protected. Remove the password and try again.")
        if doc.page_count == 0:
            raise PipelineError("The PDF has no pages.")
        if doc.is_encrypted or doc.metadata.get("encryption"):
            doc.save(dst, garbage=1, encryption=pymupdf.PDF_ENCRYPT_NONE)
        else:
            shutil.copyfile(src, dst)
        return doc.page_count


async def to_pdf(item: dict, work: Path, index: int) -> tuple[Path, int]:
    src = Path(item["path"])
    staged = work / f"{index:03d}.src.pdf"
    if item["kind"] == "image":
        await asyncio.to_thread(image_to_pdf, src, staged, work)
    elif item["kind"] == "document":
        await document_to_pdf(src, staged, work)
    else:
        staged = src
    dst = work / f"{index:03d}.in.pdf"
    pages = await asyncio.to_thread(prepare_pdf, staged, dst)
    return dst, pages


# ---------------------------------------------------------------- OCR

_OCR_EXIT_MESSAGES = {
    2: "Invalid OCR options.",
    6: "The file already contains text. Choose the 'Redo' or 'Force' OCR mode.",
    8: "The PDF is encrypted and cannot be processed.",
}


async def ocr_pdf(src: Path, dst: Path, options: dict, work: Path, on_progress: Callable[[str, int, int], None]) -> None:
    mode = options["mode"]
    args = [
        "ocrmypdf",
        "--plugin", str(PLUGIN_PATH),
        "--language", "+".join(options["languages"]),
        "--jobs", str(config.OCR_JOBS),
        "--output-type", "pdf",
        "--optimize", str(config.OCR_OPTIMIZE),
        # Linearizing is wasted work: the PDF is rewritten when bookmarks are added.
        "--fast-web-view", "999999",
        MODES[mode],
    ]
    if options["rotate"]:
        args.append("--rotate-pages")
    if options["deskew"] and mode != "redo":
        args.append("--deskew")
    if options["clean"]:
        args.append("--clean")
    args += [str(src), str(dst)]

    def on_line(line: str) -> None:
        try:
            msg = json.loads(line)
        except ValueError:
            return
        if isinstance(msg, dict) and "desc" in msg:
            on_progress(str(msg["desc"] or ""), int(msg.get("n") or 0), int(msg.get("total") or 0))

    env = {**os.environ, "TMPDIR": str(work)}
    rc, err = await _run(args, env=env, on_line=on_line)
    # 10 = PDF/A conversion failed but a valid PDF was still written.
    if rc == 0 or (rc == 10 and dst.exists()):
        return
    log.warning("ocrmypdf failed (rc=%s): %s", rc, err[-4000:])
    raise PipelineError(_OCR_EXIT_MESSAGES.get(rc, f"OCR failed (code {rc})."))


# ---------------------------------------------------------------- job driver


async def process(job, report: ProgressFn) -> dict:
    started = time.monotonic()
    job_dir = config.JOBS_DIR / job.id
    work = job_dir / "work"
    work.mkdir(parents=True, exist_ok=True)
    inputs = job.inputs
    n = len(inputs)
    share = 0.94 / n
    total_pages = 0
    parts: list[tuple[str, Path]] = []

    for i, item in enumerate(inputs):
        base = i * share
        label = item["name"] if n == 1 else f"{item['name']} ({i + 1}/{n})"
        report(base, f"Preparing {label}")
        pdf, pages = await to_pdf(item, work, i)
        total_pages += pages
        if total_pages > config.MAX_PAGES_PER_JOB:
            raise PipelineError(f"Too many pages (limit is {config.MAX_PAGES_PER_JOB} per job).")

        def on_ocr(desc: str, done: int, total: int, base=base, label=label) -> None:
            frac = done / total if total else 0.0
            if desc.lower().startswith("scan"):
                report(base + share * (0.10 + 0.05 * frac), f"Analyzing pages · {label}")
            elif desc.upper().startswith("OCR"):
                report(base + share * (0.15 + 0.75 * frac), f"OCR page {min(done + 1, total)}/{total} · {label}")
            else:
                report(base + share * 0.92, f"{desc or 'Finishing'} · {label}")

        report(base + share * 0.10, f"Starting OCR · {label}")
        out = work / f"{i:03d}.ocr.pdf"
        await ocr_pdf(pdf, out, job.options, work, on_ocr)
        parts.append((item["name"], out))

    report(0.95, "Building sections")
    title = job.options.get("title") or (Path(inputs[0]["name"]).stem if n == 1 else "Combined document")
    result = await asyncio.to_thread(
        sections.finalize, parts, job_dir / "output.pdf", job_dir / "output.txt", title
    )
    shutil.rmtree(work, ignore_errors=True)
    shutil.rmtree(job_dir / "input", ignore_errors=True)

    stem = Path(inputs[0]["name"]).stem if n == 1 else (job.options.get("title") or "combined")
    result.update(
        output_name=f"{stem}_ocr.pdf",
        text_name=f"{stem}_ocr.txt",
        duration=round(time.monotonic() - started, 2),
        files=n,
    )
    return result
