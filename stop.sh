#!/usr/bin/env bash
#
# Cameras Center - detiene los servicios
#
#   ./stop.sh          para todo lo que esté corriendo (systemd o en primer plano)
#   ./stop.sh --help   esta ayuda
#
# El arranque automático no se toca: para eso está `./autostart.sh off`.
#
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"
export PATH="$HOME/.local/bin:$PATH"

for arg in "$@"; do
  case "$arg" in
    -h|--help) sed -n '2,9p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "opción desconocida: $arg (prueba --help)" >&2; exit 1 ;;
  esac
done

UNITS=(cameras-server cameras-agent cameras-web)
PORTS=(4000 4100 5173)
DONE=0

echo "▶ Deteniendo Cameras Center"

# --- 1) unidades systemd de usuario (arranque automático) -------------------
for u in "${UNITS[@]}"; do
  if systemctl --user is-active --quiet "$u" 2>/dev/null; then
    printf '  parando %s (systemd)... ' "$u"
    if systemctl --user stop "$u" 2>/dev/null; then echo "hecho"; DONE=1; else echo "FALLO"; fi
  fi
done

# --- 2) procesos en primer plano (./start.sh, npm run dev, vite, tsx) --------
# Sólo toca procesos cuyo cwd esté dentro del repositorio Y cuyo comando sea
# node/npm/... : así nunca mata tu shell ni nada de otro proyecto.
pids=()
for pd in /proc/[0-9]*; do
  pid="${pd#/proc/}"
  [ "$pid" = "$$" ] && continue
  [ "$pid" = "$PPID" ] && continue
  cwd="$(readlink "$pd/cwd" 2>/dev/null)" || continue
  case "$cwd" in "$ROOT"|"$ROOT"/*) ;; *) continue ;; esac
  cmd="$(tr '\0' ' ' < "$pd/cmdline" 2>/dev/null)"
  case "$cmd" in
    *node*|*npm*|*npx*|*vite*|*tsx*|*concurrently*|*esbuild*) pids+=("$pid") ;;
  esac
done

if [ "${#pids[@]}" -gt 0 ]; then
  echo "  parando ${#pids[@]} proceso(s) en primer plano"
  kill -TERM "${pids[@]}" 2>/dev/null
  DONE=1
  # espera hasta 10 s a que se vayan solos
  for _ in $(seq 1 20); do
    alive=0
    for p in "${pids[@]}"; do kill -0 "$p" 2>/dev/null && alive=1; done
    [ "$alive" -eq 0 ] && break
    sleep 0.5
  done
  # los que sigan, a martillazos
  for p in "${pids[@]}"; do
    if kill -0 "$p" 2>/dev/null; then
      echo "  forzando el cierre del PID $p"
      kill -KILL "$p" 2>/dev/null
    fi
  done
fi

# --- 3) comprobación final ---------------------------------------------------
sleep 1
BUSY=()
for port in "${PORTS[@]}"; do
  if command -v ss >/dev/null 2>&1 && ss -ltnH 2>/dev/null | awk '{print $4}' | grep -q ":${port}\$"; then
    BUSY+=("$port")
  fi
done

echo
if [ "${#BUSY[@]}" -gt 0 ]; then
  echo "✗ Sigue ocupado: ${BUSY[*]}" >&2
  exit 1
elif [ "$DONE" -eq 1 ]; then
  echo "✓ Servicios detenidos (puertos 4000/4100/5173 libres)"
else
  echo "✓ Nada que parar: no había servicios corriendo"
fi
