#!/usr/bin/env bash
#
# Cameras Center - arranque automático con systemd (usuario)
#
#   ./autostart.sh on       instala las unidades, las habilita y las arranca
#   ./autostart.sh off      las para y las desinstala
#   ./autostart.sh status   estado de las unidades + health de cada servicio
#   ./autostart.sh logs     sigue los logs en vivo (Ctrl+C para salir)
#   ./autostart.sh --help   esta ayuda
#
# Requiere linger del usuario (`loginctl enable-linger`) para que arranquen al
# encender la PC, antes de que nadie inicie sesión. `on` lo activa solo si
# polkit lo permite; si no, te avisa con el comando exacto a ejecutar.
#
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"
export PATH="$HOME/.local/bin:$PATH"

USER_NAME="${USER:-$(id -un)}"
UNITS=(cameras-server cameras-agent cameras-web)
declare -A DESC=(
  [cameras-server]="API server (:4000)"
  [cameras-agent]="agent de cámaras (:4100)"
  [cameras-web]="UI web (:5173)"
)
declare -A NPM_W=(
  [cameras-server]="@cameras/server"
  [cameras-agent]="@cameras/agent"
  [cameras-web]="@cameras/web"
)
UNIT_DIR="$HOME/.config/systemd/user"

ok()   { printf '  \033[32mOK \033[0m %s\n' "$1"; }
warn() { printf '  \033[33mAVI\033[0m %s\n' "$1"; }
fail() { printf '  \033[31mERR\033[0m %s\n' "$1"; }

ACTION="${1:-status}"

# ---------------------------------------------------------------------------
write_units() {
  mkdir -p "$UNIT_DIR"
  local u
  for u in "${UNITS[@]}"; do
    cat > "$UNIT_DIR/$u.service" <<EOF
[Unit]
Description=Cameras Center - ${DESC[$u]}
Documentation=file://$ROOT/README.md
# el agent necesita red para hablar con el server y con las cámaras
After=network.target

[Service]
Type=simple
WorkingDirectory=$ROOT
Environment=PATH=$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=$HOME/.local/bin/npm run dev -w ${NPM_W[$u]}
Restart=always
RestartSec=5
# si un proceso hijeo se cuela, que muera con el grupo
KillMode=control-group
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
EOF
  done
  systemctl --user daemon-reload
}

remove_units() {
  local u
  for u in "${UNITS[@]}"; do rm -f "$UNIT_DIR/$u.service"; done
  systemctl --user daemon-reload 2>/dev/null
}

ensure_linger() {
  if loginctl show-user "$USER_NAME" 2>/dev/null | grep -q "Linger=yes"; then
    ok "linger activo: arrancan al encender la PC, sin iniciar sesión"
    return 0
  fi
  if loginctl enable-linger "$USER_NAME" 2>/dev/null; then
    ok "linger activado (loginctl enable-linger $USER_NAME)"
    return 0
  fi
  warn "no se pudo activar el linger sin contraseña."
  warn "ejecuta a mano:  sudo loginctl enable-linger $USER_NAME"
  warn "sin eso, las unidades sólo arrancan cuando inicies sesión."
  return 0
}

# ---------------------------------------------------------------------------
case "$ACTION" in
  -h|--help|help)
    sed -n '2,13p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
    exit 0
    ;;

  on|enable)
    echo "▶ Activando el arranque automático"
    [ -f .env ] || { fail "falta .env (ejecuta ./start.sh --check para crearlo)"; exit 1; }
    [ -d node_modules ] || { fail "falta node_modules (npm install)"; exit 1; }

    # nada de duplicar puertos: primero paramos lo que haya
    [ -x ./stop.sh ] && ./stop.sh >/dev/null 2>&1

    ensure_linger
    echo
    write_units
    for u in "${UNITS[@]}"; do
      if systemctl --user enable --now "$u" 2>/dev/null; then
        ok "$u → ${DESC[$u]}"
      else
        fail "$u no se pudo habilitar"
        systemctl --user status "$u" --no-pager -l | sed 's/^/      /'
        exit 1
      fi
    done

    echo
    echo "▶ Esperando a que respondan (hasta 45 s)"
    for _ in $(seq 1 45); do
      s=$(curl -s -o /dev/null -w '%{http_code}' -m 2 http://localhost:4000/api/health 2>/dev/null)
      a=$(curl -s -o /dev/null -w '%{http_code}' -m 2 http://localhost:4100/api/health 2>/dev/null)
      w=$(curl -s -o /dev/null -w '%{http_code}' -m 2 http://localhost:5173/ 2>/dev/null)
      [ "$s" = 200 ] && [ "$a" = 200 ] && [ "$w" = 200 ] && break
      sleep 1
    done
    echo
    if [ "$s" = 200 ] && [ "$a" = 200 ] && [ "$w" = 200 ]; then
      ok "server:200 · agent:200 · web:200"
      echo
      echo "✓ Listo: Cameras Center arranca sola al encender la PC y se relanza si cae."
      echo "  estado:  ./autostart.sh status"
      echo "  logs:    ./autostart.sh logs"
      echo "  parar:   ./stop.sh        (desactiva el autoarranque: ./autostart.sh off)"
      exit 0
    else
      fail "server:$s agent:$a web:$w — mira ./autostart.sh logs"
      exit 1
    fi
    ;;

  off|disable)
    echo "▶ Desactivando el arranque automático"
    for u in "${UNITS[@]}"; do
      if systemctl --user is-enabled --quiet "$u" 2>/dev/null || [ -f "$UNIT_DIR/$u.service" ]; then
        systemctl --user disable --now "$u" 2>/dev/null
        ok "$u deshabilitada y parada"
      else
        printf '  \033[90m—\033[0m %s no estaba activa\n' "$u"
      fi
    done
    remove_units
    echo
    echo "✓ Arranque automático retirado. Los servicios NO arrancarán al encender la PC."
    echo "  (Si quieres parar ahora mismo lo que esté corriendo: ./stop.sh)"
    ;;

  status)
    echo "▶ Arranque automático y servicios"
    if [ -f "$UNIT_DIR/cameras-server.service" ]; then
      ok "unidades instaladas en $UNIT_DIR"
    else
      warn "sin unidades: el autoarranque está desactivado (./autostart.sh on)"
    fi
    if loginctl show-user "$USER_NAME" 2>/dev/null | grep -q "Linger=yes"; then
      ok "linger=yes"
    else
      warn "linger=no: sólo arrancarán al iniciar sesión (sudo loginctl enable-linger $USER_NAME)"
    fi
    echo
    printf '  %-16s %-12s %-11s %s\n' "UNIDAD" "HABILITADA" "ESTADO" "PUERTO"
    for u in "${UNITS[@]}"; do
      en="no"; act="detenida"
      systemctl --user is-enabled --quiet "$u" 2>/dev/null && en="sí"
      systemctl --user is-active --quiet "$u" 2>/dev/null && act="activa"
      port=$(grep -o '[0-9]\{4\}' <<< "${DESC[$u]}" | head -1)
      code=$(curl -s -o /dev/null -w '%{http_code}' -m 2 "http://localhost:$port/" 2>/dev/null)
      [ "$u" = "cameras-server" ] && code=$(curl -s -o /dev/null -w '%{http_code}' -m 2 http://localhost:4000/api/health 2>/dev/null)
      [ "$u" = "cameras-agent" ] && code=$(curl -s -o /dev/null -w '%{http_code}' -m 2 http://localhost:4100/api/health 2>/dev/null)
      printf '  %-16s %-12s %-11s %s\n' "$u" "$en" "$act" "$code"
    done
    ;;

  logs|log)
    exec journalctl --user -f -n 50 -u cameras-server -u cameras-agent -u cameras-web
    ;;

  *)
    echo "opción desconocida: $ACTION (on|off|status|logs)" >&2
    exit 1
    ;;
esac
