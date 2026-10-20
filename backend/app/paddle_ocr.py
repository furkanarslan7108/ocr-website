"""ocrmypdf plugin: recognize text with PaddleOCR's PP-OCRv6 models, run on ONNX Runtime via RapidOCR.

Loaded with `--plugin` only when a job asks for PaddleOCR; it then takes precedence over the built-in
Tesseract engine. Page orientation and deskew detection are still done by Tesseract (inherited).

Run as a script to fetch the models (done at image build time; the backend has no internet access).
"""

import os
import threading
from importlib import metadata
from pathlib import Path

from ocrmypdf import hookimpl
from ocrmypdf.builtin_plugins.tesseract_ocr import TesseractOcrEngine
from ocrmypdf.hocrtransform import BoundingBox, OcrClass, OcrElement
from PIL import Image

# "small" is ~8x faster on CPU than "medium" for a small accuracy gain.
MODEL_SIZE = os.environ.get("PADDLE_MODEL", "small")
MODEL_DIR = os.environ.get("PADDLE_MODEL_DIR", "/opt/paddle-models")

_local = threading.local()


def engine(threads: int = 0):
    """One RapidOCR instance per ocrmypdf worker (thread or process), reused across pages."""
    if getattr(_local, "engine", None) is None:
        from rapidocr import ModelType, OCRVersion, RapidOCR

        size = ModelType(MODEL_SIZE)
        _local.engine = RapidOCR(
            params={
                "Global.model_root_dir": MODEL_DIR,
                "Global.log_level": "warning",
                # Pages are already upright: ocrmypdf rotates them before OCR.
                "Global.use_cls": False,
                "Det.ocr_version": OCRVersion.PPOCRV6,
                "Det.model_type": size,
                "Rec.ocr_version": OCRVersion.PPOCRV6,
                "Rec.model_type": size,
                "EngineConfig.onnxruntime.intra_op_num_threads": threads or -1,
            }
        )
    return _local.engine


def _bbox(quad) -> BoundingBox:
    xs = [float(p[0]) for p in quad]
    ys = [float(p[1]) for p in quad]
    return BoundingBox(left=min(xs), top=min(ys), right=max(xs), bottom=max(ys))


class PaddleOcrEngine(TesseractOcrEngine):
    @staticmethod
    def version():
        return f"PP-OCRv6 {MODEL_SIZE} (RapidOCR {metadata.version('rapidocr')})"

    @staticmethod
    def creator_tag(options):
        return f"PaddleOCR {PaddleOcrEngine.version()}"

    def __str__(self):
        return f"PaddleOCR {PaddleOcrEngine.version()}"

    @staticmethod
    def supports_generate_ocr():
        return True

    @staticmethod
    def generate_ocr(input_file: Path, options, page_number: int = 0):
        with Image.open(input_file) as im:
            width, height = im.size
            dpi = im.info.get("dpi", (300, 300))[0]
        # ocrmypdf already runs one worker per page: split the cores between them.
        threads = max(1, (os.cpu_count() or 1) // max(1, options.jobs or 1))
        result = engine(threads)(str(input_file), return_word_box=True)

        page = OcrElement(
            ocr_class=OcrClass.PAGE,
            bbox=BoundingBox(left=0, top=0, right=width, bottom=height),
            dpi=float(dpi),
            page_number=page_number,
        )
        lines = []
        if result.boxes is None or not result.txts:  # blank page
            return page, ""
        for i, (text, score, quad) in enumerate(zip(result.txts, result.scores, result.boxes)):
            words = result.word_results[i] if result.word_results else ()
            words = [w for w in words if w and str(w[0]).strip()] or [(text, score, quad)]
            line = OcrElement(ocr_class=OcrClass.LINE, bbox=_bbox(quad), confidence=float(score))
            line.children = [
                OcrElement(ocr_class=OcrClass.WORD, bbox=_bbox(q), text=str(w), confidence=float(s))
                for w, s, q in words
            ]
            page.children.append(line)
            lines.append(text)
        return page, "\n".join(lines) + "\n"

    @staticmethod
    def generate_hocr(input_file, output_hocr, output_text, options):
        raise NotImplementedError("PaddleOCR needs the fpdf2 renderer.")

    @staticmethod
    def generate_pdf(input_file, output_pdf, output_text, options):
        raise NotImplementedError("PaddleOCR needs the fpdf2 renderer.")


@hookimpl
def get_ocr_engine(options):
    return PaddleOcrEngine()


if __name__ == "__main__":
    # Downloads any missing models into MODEL_DIR (models load lazily, so OCR a sample) and checks them.
    import numpy as np
    from PIL import ImageDraw

    sample = Image.new("RGB", (480, 96), "white")
    ImageDraw.Draw(sample).text((16, 20), "PaddleOCR 123", fill="black", font_size=48)
    found = engine()(np.asarray(sample)).txts
    print("Self-test:", found)
    assert found and "123" in "".join(found), "PaddleOCR self-test failed"
