FROM python:3.12-slim-trixie

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# Tesseract language packs to install (Debian package suffixes, space separated).
ARG OCR_LANGS="eng tur deu fra spa ita por nld"

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      tesseract-ocr tesseract-ocr-osd \
      $(for l in $OCR_LANGS; do printf 'tesseract-ocr-%s ' "$l"; done) \
      ghostscript unpaper pngquant \
      fonts-dejavu-core \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /srv
COPY requirements.txt .
RUN pip install -r requirements.txt

COPY app ./app

RUN useradd --create-home --uid 1000 app \
 && mkdir -p /data/jobs \
 && chown -R app:app /data
USER app

ENV DATA_DIR=/data HOME=/home/app
EXPOSE 8000
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD python -c "import urllib.request,sys; urllib.request.urlopen('http://127.0.0.1:8000/api/health', timeout=4)" || exit 1

# Single worker on purpose: job state and the processing queue live in-process.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1", "--proxy-headers", "--forwarded-allow-ips", "*"]
