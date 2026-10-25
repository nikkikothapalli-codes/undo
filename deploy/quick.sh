#!/usr/bin/env bash
# Starts Pause on port 80 (no apt needed). Reuses the funded wallets + settings from /root/deadlock.
#   bash /root/pause/deploy/quick.sh
APP=/root/pause
cd "$APP" || exit 1
mkdir -p keys
if [ -d /root/deadlock/keys ]; then cp -n /root/deadlock/keys/* keys/ 2>/dev/null; echo "==> Reusing the funded demo wallets"; fi
if [ ! -f .env ] && [ -f /root/deadlock/.env ]; then cp /root/deadlock/.env .env; echo "==> Copied settings (.env)"; fi
touch .env
if ! command -v node >/dev/null; then
  curl -fsSL https://nodejs.org/dist/v22.11.0/node-v22.11.0-linux-x64.tar.xz -o /tmp/node.tar.xz && tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1
fi
command -v pm2 >/dev/null || npm install -g pm2 --no-audit --no-fund >/dev/null 2>&1
echo "==> Installing app packages"
npm install --omit=dev --no-audit --no-fund >/dev/null 2>&1 || npm install --omit=dev
pm2 stop all >/dev/null 2>&1
pm2 delete pause >/dev/null 2>&1
PORT=80 pm2 start server.js --name pause --update-env >/dev/null && pm2 save >/dev/null
sleep 4
curl -s -o /dev/null -w "==> App responds: HTTP %{http_code}\n" http://localhost/api/status
echo "✅ Pause is live at: http://$(curl -s -4 ifconfig.me)"
