#!/usr/bin/env bash
# Cleans .env (keeps only KEY=value lines), sends Twilio's trial template text, restarts Pause.
cd /root/pause || exit 1
grep -E '^[A-Z_]+=' .env > .env.clean && mv .env.clean .env
get() { grep -E "^$1=" .env | head -1 | cut -d= -f2- | tr -d '\r'; }
SID=$(get TWILIO_SID); TOKEN=$(get TWILIO_TOKEN); FROM=$(get TWILIO_FROM); TO=$(get FAMILY_PHONE)
echo "SID=${SID:0:6}...  FROM=$FROM  TO=$TO  token length=${#TOKEN}"
echo "--- with From:"
curl -s -X POST "https://api.twilio.com/2010-04-01/Accounts/$SID/Messages.json" -u "$SID:$TOKEN" \
  --data-urlencode "To=$TO" --data-urlencode "From=$FROM" --data-urlencode "Body=sms_appointment_reminders" | head -c 400; echo
pm2 restart pause --update-env >/dev/null && echo "--- app restarted"
