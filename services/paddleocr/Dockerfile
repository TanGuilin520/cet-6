FROM python:3.11-slim

ARG PADDLEOCR_UID=10001
ARG PADDLEOCR_GID=10001

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PADDLEOCR_HOST=0.0.0.0 \
    PADDLEOCR_PORT=8765 \
    PADDLEOCR_ALLOWED_ROOT=/workspace/data/exams \
    HOME=/home/paddleocr

RUN apt-get update \
    && apt-get install -y --no-install-recommends libgl1 libglib2.0-0 libgomp1 \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid "${PADDLEOCR_GID}" paddleocr \
    && useradd --uid "${PADDLEOCR_UID}" --gid "${PADDLEOCR_GID}" \
        --create-home --shell /usr/sbin/nologin paddleocr \
    && mkdir -p /workspace /home/paddleocr/.paddlex \
    && chown -R paddleocr:paddleocr /workspace /home/paddleocr/.paddlex

COPY services/paddleocr/requirements.txt /tmp/paddleocr-requirements.txt
RUN python -m pip install --no-cache-dir paddlepaddle==3.2.0 \
        --index-url https://www.paddlepaddle.org.cn/packages/stable/cpu/ \
    && python -m pip install --no-cache-dir -r /tmp/paddleocr-requirements.txt

WORKDIR /app
COPY services /app/services

EXPOSE 8765
USER paddleocr:paddleocr
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD ["python", "-c", "import json,os; from urllib.request import Request,urlopen; token=os.environ.get('PADDLEOCR_TOKEN',''); headers={'Authorization':'Bearer '+token} if token else {}; body=json.load(urlopen(Request('http://127.0.0.1:8765/healthz',headers=headers),timeout=3)); raise SystemExit(0 if body.get('status')=='ok' else 1)"]
CMD ["python", "-m", "services.paddleocr.app"]
