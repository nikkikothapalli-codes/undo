#!/usr/bin/env bash
cd /root/pause && npm install --omit=dev --no-audit --no-fund >/dev/null 2>&1; pm2 restart pause --update-env && echo "✅ updated"
