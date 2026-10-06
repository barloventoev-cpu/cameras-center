#!/usr/bin/env bash
#
# Cameras Center - lanzador de servicios
#
#   ./start.sh              arranca server (:4000) + agent (:4100) + web (:5173)
#   ./start.sh --install    antes de arrancar, ejecuta `npm install`
#   ./start.sh --check      sólo comprueba requisitos y puertos, no arranca nada
#   ./start.sh --help       esta ayuda
#
# Ctrl+C detiene los tres servicios.
#   ./stop.sh               los detiene desde fuera (también si van por systemd)
#   ./autostart.sh on|off   arranque automático al encender la PC
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

# Node y FFmpeg instalados en el usuario (~/.local/bin), por si el PATH no los ve
export PATH="$HOME/.local/bin:$PATH"

DO_INSTALL=0
CHECK_ONLY=0
for arg in "$@"; do
  case "$arg" in
    -i|--install) DO_INSTALL=1 ;;
    -c|--check)   CHECK_ONLY=1 ;;
    -h|--help)    sed -n '2,13p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "opción desconocida: $arg (prueba --help)" >&2; exit 1 ;;
  esac
done

ok()   { printf '  \033[32mOK \033[0m %s\n' "$1"; }
warn() { printf '  \033[33mAVI\033[0m %s\n' "$1"; }
fail() { printf '  \033[31mERR\033[0m %s\n' "$1"; ERRORS=$((ERRORS + 1)); }
ERRORS=0

echo "▶ Comprobando requisitos"

# --- Node >= 20 (requerido por el monorepo) ---------------------------------
if command -v node >/dev/null 2>&1; then
  NODE_V="$(node -v)"
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
  if [ "$NODE_MAJOR" -ge 20 ]; then
    ok "node $NODE_V"
  else
    fail "node $NODE_V es antiguo; hace falta >= 20"
  fi
else
  fail "node no está en el PATH (¿instalado en ~/.local/bin? mira el README)"
fi

if command -v npm >/dev/null 2>&1; then
  ok "npm $(npm -v)"
else
  fail "npm no está en el PATH"
fi

# --- FFmpeg: sólo lo necesita el agent --------------------------------------
if command -v ffmpeg >/dev/null 2>&1; then
  ok "ffmpeg $(ffmpeg -version 2>/dev/null | head -1 | awk '{print $3}')"
else
  warn "ffmpeg no está en el PATH: el agent no podrá leer cámaras (el server y la web sí funcionan)"
fi

# --- .env -------------------------------------------------------------------
if [ ! -f .env ]; then
  if [ -f .env.example ]; then
    cp .env.example .env
    if command -v openssl >/dev/null 2>&1; then
      sed -i \
        -e "s|^JWT_SECRET=.*|JWT_SECRET=$(openssl rand -hex 32)|" \
        -e "s|^CAMERA_ENC_KEY=.*|CAMERA_ENC_KEY=$(openssl rand -hex 32)|" \
        -e "s|^AGENT_TOKEN=.*|AGENT_TOKEN=$(openssl rand -hex 16)|" \
        -e "s|^TEST_PASSWORD=.*|TEST_PASSWORD=$(openssl rand -hex 8)|" \
        .env
    fi
    warn ".env no existía: creado desde .env.example con secretos generados"
  else
    fail "falta .env y no hay .env.example para copiarlo"
  fi
else
  ok ".env"
fi

# --- dependencias -----------------------------------------------------------
if [ -d node_modules ]; then
  ok "node_modules ($(ls node_modules | wc -l | tr -d ' ') paquetes)"
else
  warn "falta node_modules: ejecuta 'npm install' (o relanza con --install)"
  if [ "$CHECK_ONLY" -eq 0 ]; then
    DO_INSTALL=1
  fi
fi

# --- puertos ----------------------------------------------------------------
for entry in "4000 server" "4100 agent" "5173 web"; do
  port="${entry%% *}"
  name="${entry##* }"
  if command -v ss >/dev/null 2>&1 && ss -ltnH 2>/dev/null | awk '{print $4}' | grep -q ":${port}\$"; then
    fail "el puerto $port ($name) ya está ocupado (¿otra instancia? prueba ./stop.sh)"
  else
    ok "puerto $port libre ($name)"
  fi
done

echo
if [ "$ERRORS" -gt 0 ]; then
  echo "✗ $ERRORS comprobación(es) fallida(s); no se arranca nada." >&2
  exit 1
fi

if [ "$CHECK_ONLY" -eq 1 ]; then
  echo "✓ Todo listo. Arranca con: ./start.sh"
  exit 0
fi

if [ "$DO_INSTALL" -eq 1 ]; then
  echo "▶ npm install"
  npm install --no-audit --no-fund
  echo
fi

cat <<'URLS'

  Servicios:
    web    http://localhost:5173
    API    http://localhost:4000/api/health
    docs   http://localhost:4000/api/docs
    agent  http://localhost:4100/api/health

  Pulsa Ctrl+C para parar los tres.

URLS

# concurrently -k (del script "dev") levanta server + agent + web y los mata a
# todos si uno falla.
exec npm run dev
