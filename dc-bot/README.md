# TinshiSource Discord Control Bot

This bot is separate from the web server and can be started manually with Python.

## Setup

```bash
cd dc-bot
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
```

Set environment variables:

```env
CONTROL_BOT_TOKEN=YOUR_DISCORD_BOT_TOKEN
CONTROL_BOT_OWNER_ID=1518966127546339439
CONTROL_BOT_API=http://127.0.0.1:3000
CONTROL_BOT_SECRET=YOUR_LONG_RANDOM_SECRET
LTC_ADDRESS=YOUR_LTC_ADDRESS
```

Run:

```bash
python bot.py
```

The bot provides `/trail`, `/plans`, `/manage_bots`, `/admin`, and `/control_status`.

For security, this build does not collect arbitrary users' Discord bot tokens. Use Discord's official bot installation/OAuth flow for provisioning user-owned bots.
