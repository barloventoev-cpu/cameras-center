#!/usr/bin/env bash
# Levanta el stack de Cameras Center: server :4000 + agent :4100 + web :5173
set -e
cd "$(dirname "$0")"
if command -v gnome-terminal >/dev/null 2>&1; then
  gnome-terminal \
    --tab --title="CC server :4000" -- bash -c 'npm run dev:server; exec bash' \
    --tab --title="CC agent :4100" -- bash -c 'npm run dev:agent; exec bash' \
    --tab --title="CC web :5173" -- bash -c 'npm run dev:web; exec bash'
  echo "Stack iniciado en pestanas de gnome-terminal."
else
  mkdir -p .logs
  npm run dev:server >.logs/server.log 2>&1 &
  npm run dev:agent >.logs/agent.log 2>&1 &
  npm run dev:web >.logs/web.log 2>&1 &
  echo "Stack en segundo plano (logs en .logs/)."
  echo "Detener: pkill -f 'tsx watch' (o kill PID)."
fi
