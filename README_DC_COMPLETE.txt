TinshiSource Discord Control Bot

Start web: npm start
Start Discord controller manually:
  cd dc-bot
  python3 -m venv .venv
  source .venv/bin/activate
  pip install -r requirements.txt
  export CONTROL_BOT_TOKEN=...
  export CONTROL_BOT_OWNER_ID=1518966127546339439
  export CONTROL_BOT_SECRET=...
  export CONTROL_BOT_API=http://127.0.0.1:3000
  python bot.py

Commands: /trail, /manage_bots, /plans, /dashboard, /admin, /control_status

Security: bot credentials are environment variables only. This build does not collect another user's Discord bot token through Discord modals.
