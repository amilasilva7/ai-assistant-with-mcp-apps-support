#!/usr/bin/env bash
# Brings up a full POC dev environment backed by a local Ollama model instead
# of Anthropic/Gemini, to sidestep their rate limits during development:
#   1. start (or reuse) an Ollama container in Docker
#   2. pull the model if it isn't already present
#   3. point .env at it — no API key needed, Ollama is unauthenticated
#   4. build the project
#   5. start the assistant
#   6. open a Cloudflare quick tunnel and wire ASSISTANT_PUBLIC_ORIGIN to it
#      (see assistant/config.ts and assistant/main.ts for why that's needed)
#
# Deliberately NOT wired into `npm run build`/`npm run assistant` — this is
# an opt-in convenience script. Docker and the model live entirely outside
# the Node project; nothing here becomes a project dependency.
#
# Usage:
#   scripts/start-with-ollama.sh              # full stack incl. tunnel
#   scripts/start-with-ollama.sh --no-tunnel  # local only (http://localhost:3002)
#   OLLAMA_MODEL=llama3.1:70b scripts/start-with-ollama.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

MODEL="${OLLAMA_MODEL:-llama3.1:8b}"
CONTAINER_NAME="${OLLAMA_CONTAINER_NAME:-ollama}"
OLLAMA_PORT="${OLLAMA_PORT:-11434}"
ASSISTANT_PORT="${ASSISTANT_PORT:-3002}"
ENV_FILE="$REPO_ROOT/.env"
NO_TUNNEL=false
[ "${1:-}" = "--no-tunnel" ] && NO_TUNNEL=true

log()  { printf '\n\033[1;34m==>\033[0m %s\n' "$1"; }
die()  { printf '\n\033[1;31mERROR:\033[0m %s\n' "$1" >&2; exit 1; }

# Overwrite the active KEY=VAL line in .env if one exists, else append a new
# one. Deliberately only ever touches a genuinely *active* (uncommented,
# unindented) assignment — matching only "^KEY=" rather than also "#KEY=" —
# because .env.example documents each provider's model with its own
# commented example line (several "# ASSISTANT_MODEL=..." lines for
# different providers); an earlier version of this matched and rewrote every
# one of those into a real assignment, leaving duplicate active lines.
# Appending instead leaves that documentation alone.
set_env() {
  local key="$1" val="$2"
  local escaped
  escaped=$(printf '%s' "$val" | sed 's/[&/\]/\\&/g')
  if grep -qE "^${key}=" "$ENV_FILE" 2>/dev/null; then
    sed -i -E "s|^${key}=.*|${key}=${escaped}|" "$ENV_FILE"
  else
    printf '%s=%s\n' "$key" "$val" >> "$ENV_FILE"
  fi
}

# Free a port by killing whatever's listening on it — Windows and POSIX.
# This project has repeatedly hit orphaned npm/node processes surviving a
# plain `kill $pid` on Windows (npm.cmd spawns a real node.exe child that
# outlives the wrapper); go straight for the PID actually bound to the port.
free_port() {
  local port="$1" pid
  if command -v netstat >/dev/null 2>&1 && command -v taskkill >/dev/null 2>&1; then
    pid=$(netstat -ano 2>/dev/null | grep ":${port} " | grep LISTENING | awk '{print $NF}' | head -1 || true)
    if [ -n "${pid:-}" ]; then
      echo "  Freeing port $port (killing PID $pid)..."
      taskkill //F //PID "$pid" >/dev/null 2>&1 || true
      sleep 1
    fi
  elif command -v lsof >/dev/null 2>&1; then
    pid=$(lsof -ti tcp:"$port" 2>/dev/null || true)
    if [ -n "${pid:-}" ]; then
      echo "  Freeing port $port (killing PID $pid)..."
      kill -9 $pid 2>/dev/null || true
      sleep 1
    fi
  fi
}

wait_for_http() {
  local url="$1" timeout="${2:-30}"
  for _ in $(seq 1 "$timeout"); do
    curl -sf "$url" >/dev/null 2>&1 && return 0
    sleep 1
  done
  return 1
}

command -v docker >/dev/null 2>&1 || die "Docker is not installed or not on PATH."
docker info >/dev/null 2>&1 || die "Docker daemon isn't running — start Docker Desktop and retry."
command -v npx >/dev/null 2>&1 || die "npx (Node.js) is not on PATH."

# --- 1. Ollama container ----------------------------------------------------
log "Starting Ollama container ('$CONTAINER_NAME')..."
if docker ps --format '{{.Names}}' | grep -qx "$CONTAINER_NAME"; then
  echo "  Already running."
elif docker ps -a --format '{{.Names}}' | grep -qx "$CONTAINER_NAME"; then
  echo "  Exists but stopped — starting it."
  docker start "$CONTAINER_NAME" >/dev/null
else
  echo "  Creating it (port $OLLAMA_PORT, persistent volume 'ollama-data')..."
  docker run -d --name "$CONTAINER_NAME" -p "$OLLAMA_PORT:11434" -v ollama-data:/root/.ollama ollama/ollama >/dev/null
fi

log "Waiting for Ollama to accept connections..."
wait_for_http "http://localhost:$OLLAMA_PORT/api/version" 60 || die "Ollama didn't come up within 60s. Check: docker logs $CONTAINER_NAME"
echo "  Up."

# --- 2. Pull the model -------------------------------------------------------
log "Ensuring model '$MODEL' is present (first pull is several GB — this can take a while)..."
if docker exec "$CONTAINER_NAME" ollama list 2>/dev/null | awk 'NR>1{print $1}' | grep -qx "$MODEL"; then
  echo "  Already present."
else
  docker exec "$CONTAINER_NAME" ollama pull "$MODEL"
fi

# --- 3. Point .env at it ------------------------------------------------
log "Updating .env..."
[ -f "$ENV_FILE" ] || cp "$REPO_ROOT/.env.example" "$ENV_FILE"
set_env "ASSISTANT_LLM_PROVIDER" "ollama"
set_env "ASSISTANT_MODEL" "$MODEL"
set_env "OLLAMA_BASE_URL" "http://localhost:$OLLAMA_PORT"
echo "  Done — no API key needed, Ollama is an unauthenticated local server."

# --- 4. Build -----------------------------------------------------------
log "Building the project..."
npm run build

# --- 5. Start the assistant ----------------------------------------------
free_port "$ASSISTANT_PORT"
log "Starting the assistant on port $ASSISTANT_PORT..."
nohup npm run assistant > /tmp/assistant-ollama.log 2>&1 &
ASSISTANT_PID=$!
wait_for_http "http://localhost:$ASSISTANT_PORT/api/config" 30 || {
  echo "--- last 30 lines of /tmp/assistant-ollama.log ---"
  tail -30 /tmp/assistant-ollama.log
  die "Assistant didn't come up within 30s."
}
echo "  Up (PID $ASSISTANT_PID)."

if [ "$NO_TUNNEL" = true ]; then
  log "Ready (no tunnel requested)."
  echo "  Local:  http://localhost:$ASSISTANT_PORT"
  echo "  Ollama: $CONTAINER_NAME (model $MODEL) on port $OLLAMA_PORT"
  echo "  Logs:   /tmp/assistant-ollama.log"
  echo "  Stop:   kill $ASSISTANT_PID   (Ollama keeps running; 'docker stop $CONTAINER_NAME' to stop that too)"
  exit 0
fi

# --- 6. Cloudflare tunnel -------------------------------------------------
log "Opening a Cloudflare tunnel..."
rm -f /tmp/cloudflared-ollama.log
nohup npx cloudflared tunnel --url "http://localhost:$ASSISTANT_PORT" > /tmp/cloudflared-ollama.log 2>&1 &
CLOUDFLARED_PID=$!

TUNNEL_URL=""
for _ in $(seq 1 30); do
  TUNNEL_URL=$(grep -oE 'https://[a-zA-Z0-9-]+\.trycloudflare\.com' /tmp/cloudflared-ollama.log 2>/dev/null | head -1 || true)
  [ -n "$TUNNEL_URL" ] && break
  sleep 1
done
[ -z "$TUNNEL_URL" ] && die "Could not detect the tunnel URL within 30s — check /tmp/cloudflared-ollama.log"
echo "  Tunnel: $TUNNEL_URL"

set_env "ASSISTANT_PUBLIC_ORIGIN" "$TUNNEL_URL"

log "Restarting the assistant so the Origin/Host guard picks up the tunnel..."
kill "$ASSISTANT_PID" 2>/dev/null || true
free_port "$ASSISTANT_PORT"
nohup npm run assistant > /tmp/assistant-ollama.log 2>&1 &
ASSISTANT_PID=$!
wait_for_http "http://localhost:$ASSISTANT_PORT/api/config" 30 || {
  echo "--- last 30 lines of /tmp/assistant-ollama.log ---"
  tail -30 /tmp/assistant-ollama.log
  die "Assistant didn't come back up within 30s after the restart."
}

log "Ready."
echo "  Local:  http://localhost:$ASSISTANT_PORT"
echo "  Public: $TUNNEL_URL"
echo "  Ollama: $CONTAINER_NAME (model $MODEL) on port $OLLAMA_PORT"
echo "  Logs:   /tmp/assistant-ollama.log , /tmp/cloudflared-ollama.log"
echo
echo "  Stop:   kill $ASSISTANT_PID $CLOUDFLARED_PID"
echo "          (Ollama keeps running for next time; 'docker stop $CONTAINER_NAME' to stop that too)"
