"""Turn OCR'd PDFs into a sectioned PDF: detect headings, write bookmarks, merge parts, extract text.

Strategy, in order of trust:
  1. Keep bookmarks the source already has (e.g. a PDF's own outline).
  2. Detect headings from the text layer: lines noticeably larger than body text, or
     numbered lines ("2.1 Methods", "Chapter 3", "IV. Results"), minus running headers/footers.
  3. Fall back to one bookmark per page for multi-page documents.
When several files are combined, each file becomes a top-level section.
"""

from __future__ import annotations

import re
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path

import pymupdf

NUMBERED_RE = re.compile(r"^(\d{1,2}(?:\.\d{1,2}){0,4})[.)]?\s+\S")
KEYWORD_RE = re.compile(
    r"^(chapter|section|part|appendix|annex|bölüm|kısım|ek|kapitel|abschnitt|chapitre|capítulo|capitolo)"
    r"\s+([0-9]+|[IVXLC]+|[A-Z])\b",
    re.IGNORECASE,
)
ROMAN_RE = re.compile(r"^[IVXLC]{1,6}[.)]\s+\S")

SIZE_RATIO = 1.18  # a line this much larger than body text is a heading candidate
SAME_SIZE = 0.92  # sizes within this ratio belong to the same heading level
MAX_TITLE = 120


@dataclass
class Line:
    page: int
    text: str
    size: float
    bold: bool
    y0: float
    y1: float
    block_lines: int
    row_cells: int  # lines of the same block sharing this line's row (>1 in tables)


@dataclass
class Heading:
    page: int
    text: str
    size: float
    y1: float
    depth: int  # numbering depth, 0 if unnumbered
    level: int = 0


def _iter_lines(doc: pymupdf.Document):
    for pno, page in enumerate(doc):
        # No clipping: on rotated pages the OCR layer can fall outside the clip and be dropped.
        data = page.get_text("dict", flags=0, clip=pymupdf.INFINITE_RECT())
        for block in data["blocks"]:
            if block.get("type") != 0:
                continue
            lines = [ln for ln in block["lines"] if any(s["text"].strip() for s in ln["spans"])]
            for line in lines:
                spans = [s for s in line["spans"] if s["text"].strip()]
                mid = (line["bbox"][1] + line["bbox"][3]) / 2
                row_cells = sum(other["bbox"][1] < mid < other["bbox"][3] for other in lines)
                text = " ".join("".join(s["text"] for s in spans).split())
                weight = sum(len(s["text"].strip()) for s in spans) or 1
                size = sum(s["size"] * len(s["text"].strip()) for s in spans) / weight
                bold = all((s["flags"] & 16) or "bold" in s["font"].lower() for s in spans)
                yield Line(pno, text, size, bold, line["bbox"][1], line["bbox"][3], len(lines), row_cells)


def _body_size(lines: list[Line]) -> float:
    """Character-weighted median font size, i.e. the size of ordinary body text."""
    weighted = sorted((ln.size, len(ln.text)) for ln in lines)
    half = sum(w for _, w in weighted) / 2
    acc = 0
    for size, w in weighted:
        acc += w
        if acc >= half:
            return size
    return weighted[-1][0]


def _norm(text: str) -> str:
    return re.sub(r"\d+", "#", text.lower()).strip()


def _repeated(lines: list[Line], pages: int) -> set[str]:
    """Text that recurs on many pages (running headers/footers, page numbers)."""
    if pages < 3:
        return set()
    seen: dict[str, set[int]] = defaultdict(set)
    for ln in lines:
        seen[_norm(ln.text)].add(ln.page)
    return {t for t, p in seen.items() if len(p) >= max(3, 0.4 * pages)}


def _plausible(text: str) -> bool:
    words = text.split()
    if not 2 <= len(text) <= 150 or len(words) > 16:
        return False
    letters = sum(c.isalpha() for c in text)
    if letters < 2 or letters < 0.5 * len(text.replace(" ", "")):
        return False
    if text.endswith((",", ";")) or (text.endswith(".") and len(words) > 6):
        return False
    return True


def _numbering_depth(text: str) -> int:
    if m := NUMBERED_RE.match(text):
        return m.group(1).count(".") + 1
    if KEYWORD_RE.match(text) or ROMAN_RE.match(text):
        return 1
    return 0


def _candidates(lines: list[Line], body: float, skip: set[str], allow_bold: bool) -> list[Heading]:
    out: list[Heading] = []
    for ln in lines:
        # Cells of a table row ("Name  Price  Page  MM Page") are column labels, not headings.
        if not _plausible(ln.text) or _norm(ln.text) in skip or ln.row_cells >= 3:
            continue
        ratio = ln.size / body
        depth = _numbering_depth(ln.text)
        words = len(ln.text.split())
        standalone = ln.block_lines <= 2
        large = ratio >= SIZE_RATIO and words <= 14
        is_heading = (
            # Headings rarely start lowercase; skewed scans can inflate body-line sizes.
            (large and not ln.text[0].islower())
            or (
                depth
                and ratio >= 0.97
                and standalone
                and words <= 10
                and (ln.bold or ratio >= 1.06 or depth >= 2 or KEYWORD_RE.match(ln.text))
            )
            or (allow_bold and ln.bold and ratio >= 0.97 and ln.block_lines == 1 and 1 <= words <= 8)
        )
        if not (is_heading or large):
            continue
        prev = out[-1] if out else None
        # Join headings that wrap onto further lines. Tight leading makes the line boxes
        # overlap, and a wrapped line may start lowercase ("Items that Won't / be priced").
        if (
            prev
            and prev.page == ln.page
            and not depth
            and not prev.text.endswith(":")  # a label, not a wrapped title ("Website:" / "example.com")
            and min(prev.size, ln.size) / max(prev.size, ln.size) >= SAME_SIZE
            and -0.5 * ln.size <= ln.y0 - prev.y1 < 0.8 * ln.size
            and len(prev.text) + len(ln.text) < MAX_TITLE
        ):
            prev.text = f"{prev.text} {ln.text}"
            prev.y1 = ln.y1
            continue
        if not is_heading:
            continue
        out.append(Heading(ln.page, ln.text, ln.size, ln.y1, depth))
    return out


def _assign_levels(heads: list[Heading], body: float) -> None:
    clusters: list[float] = []  # smallest size seen in each cluster, largest cluster first
    for size in sorted({h.size for h in heads if h.size / body >= SIZE_RATIO}, reverse=True):
        if clusters and size >= clusters[-1] * SAME_SIZE:
            clusters[-1] = size
        else:
            clusters.append(size)
    for h in heads:
        if h.depth:
            h.level = h.depth
        else:
            rank = next((i for i, c in enumerate(clusters) if h.size >= c * SAME_SIZE), len(clusters))
            h.level = rank + 1


def normalize_toc(toc: list[list]) -> list[list]:
    """Renumber levels densely and clamp jumps so the outline is a valid tree."""
    used = sorted({lvl for lvl, _, _ in toc})
    rank = {lvl: i + 1 for i, lvl in enumerate(used)}
    out, prev = [], 0
    for lvl, title, page in toc:
        lvl = min(rank[lvl], prev + 1)
        out.append([lvl, title[:MAX_TITLE], page])
        prev = lvl
    return out


def detect_outline(doc: pymupdf.Document) -> tuple[list[list], str]:
    """Return (toc, source) where toc entries are [level, title, 1-based page]."""
    existing = [[lvl, t.strip(), p] for lvl, t, p in doc.get_toc(simple=True) if p >= 1 and t.strip()]
    if existing:
        return normalize_toc(existing), "existing"

    lines = list(_iter_lines(doc))
    if not lines:
        return [], "none"
    body = _body_size(lines)
    skip = _repeated(lines, doc.page_count)
    heads = _candidates(lines, body, skip, allow_bold=False)
    if len(heads) < 2:
        heads = _candidates(lines, body, skip, allow_bold=True)
    if not heads:
        return [], "none"

    # Too many "headings" means the threshold is catching body text; tighten it.
    limit = max(40, doc.page_count * 6)
    ratio = SIZE_RATIO
    while len(heads) > limit and ratio < 3:
        ratio += 0.15
        heads = [h for h in heads if h.size / body >= ratio or (h.depth and h.depth <= 2)]
    heads = heads[:limit]

    _assign_levels(heads, body)
    return normalize_toc([[h.level, h.text, h.page + 1] for h in heads]), "detected"


def _page_toc(pages: int) -> list[list]:
    return [[1, f"Page {i}", i] for i in range(1, pages + 1)]


def finalize(parts: list[tuple[str, Path]], out_pdf: Path, out_txt: Path, title: str) -> dict:
    if len(parts) == 1:
        doc = pymupdf.open(parts[0][1])
        toc, source = detect_outline(doc)
        if not toc and doc.page_count > 1:
            toc, source = _page_toc(doc.page_count), "pages"
    else:
        doc = pymupdf.open()
        toc, source = [], "files"
        for name, path in parts:
            with pymupdf.open(path) as src:
                start = doc.page_count
                sub, sub_source = detect_outline(src)
                doc.insert_pdf(src)
            toc.append([1, Path(name).stem, start + 1])
            toc += [[lvl + 1, t, p + start] for lvl, t, p in sub]
            if sub_source in ("existing", "detected"):
                source = "files+headings"

    with doc:
        toc = normalize_toc(toc) if toc else []
        doc.set_toc(toc)
        doc.set_metadata({"title": title, "creator": "OCR Desk", "producer": "OCRmyPDF + PyMuPDF"})

        chars = 0
        with open(out_txt, "w", encoding="utf-8") as fh:
            for i, page in enumerate(doc, 1):
                text = page.get_text("text", flags=pymupdf.TEXT_PRESERVE_WHITESPACE, clip=pymupdf.INFINITE_RECT())
                chars += len(text.strip())
                fh.write(f"===== Page {i} =====\n{text.strip()}\n\n")

        pages = doc.page_count
        doc.save(out_pdf, garbage=1, deflate=True)

    return {
        "pages": pages,
        "sections": [{"level": lvl, "title": t, "page": p} for lvl, t, p in toc[:1000]],
        "section_count": len(toc),
        "section_source": source,
        "text_chars": chars,
        "size_bytes": out_pdf.stat().st_size,
    }
