# PaddleOCR optional sidecar

This service keeps PaddleOCR and PaddlePaddle out of the CET server's Python
3.8 standard-library environment. It reads temporary PNG pages by relative path
from one shared, explicitly allowed directory and returns a small versioned JSON contract over
HTTP. It does not read PDFs, generate the final manifest, fetch URLs, or replace
the existing OCRmyPDF/Tesseract fallback.

## Compatibility decision

PaddleOCR 3.7 declares Python 3.8 or newer, but its document-parser extras need
Python 3.9 or newer, and current PaddlePaddle 3.3 Linux wheels list Python
3.9–3.13. Run this sidecar on Python 3.10 or 3.11 and install only basic OCR.
The supplied CPU image pins PaddleOCR/PaddleX 3.7 and the PaddlePaddle 3.2 engine
documented by PaddleOCR. Validate and lock a different CPU/GPU engine as one
unit before upgrading it.

Official references:

- <https://www.paddleocr.ai/main/en/version3.x/installation.html>
- <https://www.paddleocr.ai/main/en/version3.x/pipeline_usage/OCR.html>
- <https://github.com/PaddlePaddle/PaddleX/blob/release/3.7/paddlex/inference/pipelines/ocr/pipeline.py>
- <https://www.paddlepaddle.org.cn/documentation/docs/en/install/pip/linux-pip_en.html>

## Local CPU run

Create a dedicated Python 3.10/3.11 virtual environment, then install the
inference engine and sidecar dependencies:

```bash
python3.11 -m venv .venv-paddleocr
.venv-paddleocr/bin/python -m pip install paddlepaddle==3.2.0 \
  --index-url https://www.paddlepaddle.org.cn/packages/stable/cpu/
.venv-paddleocr/bin/python -m pip install -r services/paddleocr/requirements.txt
```

Start the sidecar. The token is optional on loopback but recommended whenever
the service is exposed beyond the same host:

```bash
PADDLEOCR_ALLOWED_ROOT=/absolute/path/to/cet-6/data/exams \
PADDLEOCR_ALLOWED_LANGS=en,ch \
PADDLEOCR_TOKEN=replace-with-a-long-random-value \
.venv-paddleocr/bin/python -m services.paddleocr.app
```

The main parsing pipeline automatically prefers the sidecar when these values are configured:

```bash
CET_PADDLEOCR_URL=http://127.0.0.1:8765/v1/ocr
CET_PADDLEOCR_TOKEN=replace-with-the-same-value
CET_PADDLEOCR_TIMEOUT_SECONDS=300
CET_PADDLEOCR_LANGUAGE=en
CET_PADDLEOCR_SHARED_ROOT=/absolute/path/to/cet-6/data/exams
```

For Docker, mount the host `data/exams` directory read-only at the image's
default `/workspace/data/exams`. Requests contain paths relative to that root,
so host and container absolute paths do not need to match:

```bash
docker build -f services/paddleocr/Dockerfile \
  --build-arg PADDLEOCR_UID="$(id -u)" \
  --build-arg PADDLEOCR_GID="$(id -g)" \
  -t cet-paddleocr .
docker run --rm -p 127.0.0.1:8765:8765 \
  -v /absolute/path/to/cet-6/data/exams:/workspace/data/exams:ro \
  -e PADDLEOCR_TOKEN=replace-with-a-long-random-value \
  -e PADDLEOCR_ALLOWED_LANGS=en,ch \
  -v cet-paddle-models:/home/paddleocr/.paddlex cet-paddleocr
```

The image always runs as an unprivileged user. Build its numeric UID/GID to
match the account that runs the main CET server, as above. This is important
for the current pipeline because Python-created temporary OCR directories can
have mode `0700`: a different container UID cannot traverse them even though
`data/exams` is mounted. If the CET server runs under a service account, use
that account's UID/GID instead of the interactive shell values. The entire
read-only mount, every exam directory, and each generated PNG must remain
readable/traversable by that identity. A future shared-group deployment can
instead make those temporary directories group-readable (`0750` plus matching
group ownership), but the main server must make that permission change when it
creates them.

The named `/home/paddleocr/.paddlex` volume is the unprivileged user's writable
model cache. Do not point the cache at the read-only exam mount. The repository
root `.dockerignore` restricts the build context to this sidecar and excludes
`.env`, `data/exams`, uploads, and other project data.
The image intentionally does not create `/workspace/data/exams`; the bind mount
creates it at runtime, so omitting the mount makes `allowedRootReady=false`
instead of silently reporting an empty in-image directory as ready.

`server.paddle_ocr.PaddleOCRClient` accepts the 200-DPI PNGs already needed by
OCR, validates the response, and scales pixel boxes back to each PDF page's
`width`/`height`. Paddle geometric preprocessing is explicitly disabled so the
coordinates remain aligned with the original page image. `return_word_box=True`
provides `text_word` and `text_word_boxes`; when a selected model returns only a
line box, proportional fallback boxes are marked `ocrBoxSource=estimated-line`.

The first request downloads and loads OCR models and is therefore much slower.
Persist the Paddle model cache and keep the sidecar running instead of starting
one process for every PDF page.

## Readiness contract

`GET /healthz` does not instantiate a model or download model data. It performs
a lightweight PaddleOCR package import at service startup and reports:

- `allowedLanguages`
- `allowedRootReady`
- `runtimeImportReady`
- `modelLoaded` and `loadedLanguages`

The status is `ok` only when the allowed-root mount is traversable and the
PaddleOCR runtime import succeeded; otherwise it is `not_ready`. The main
server also compares `CET_PADDLEOCR_LANGUAGE` with `allowedLanguages`. When
`PADDLEOCR_TOKEN` is set, `/healthz` and `/v1/ocr` both require the same
`Authorization: Bearer ...` header. Thus a wrong token produces HTTP 401, an
unsupported language is visible before parsing, and a missing/unreadable mount
is distinguishable from an unloaded (but otherwise ready) model.
