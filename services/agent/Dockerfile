FROM python:3.11-slim

ARG AGENT_UID=10001
ARG AGENT_GID=10001

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    CET_AGENT_HOST=0.0.0.0 \
    CET_AGENT_PORT=8770 \
    CET_AGENT_CHECKPOINT_PATH=/data/agent-checkpoints.sqlite3 \
    HOME=/home/cet-agent

RUN groupadd --gid "${AGENT_GID}" cet-agent \
    && useradd --uid "${AGENT_UID}" --gid "${AGENT_GID}" \
        --create-home --shell /usr/sbin/nologin cet-agent \
    && mkdir -p /app /data \
    && chown -R cet-agent:cet-agent /app /data /home/cet-agent

WORKDIR /app
COPY requirements.txt /app/requirements.txt
RUN python -m pip install --no-cache-dir -r /app/requirements.txt
COPY app.py /app/app.py

EXPOSE 8770
USER cet-agent:cet-agent
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD ["python", "-c", "import json,os; from urllib.request import Request,urlopen; token=os.environ.get('CET_AGENT_TOKEN',''); headers={'Authorization':'Bearer '+token} if token else {}; body=json.load(urlopen(Request('http://127.0.0.1:8770/healthz',headers=headers),timeout=3)); raise SystemExit(0 if body.get('ready') else 1)"]
CMD ["python", "/app/app.py"]
