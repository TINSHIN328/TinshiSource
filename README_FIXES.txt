TINSHISOURCE AUTH + DISCORD AUTO-START FIX

Fixed in this build:
1. Every protected HTML page now has a server-side session guard; direct page URLs redirect to / when not logged in.
2. Web registration writes the new account to MySQL and signs the user in immediately.
3. Discord /register creates or links dc_<DiscordID> in MySQL, stores the Discord ID, and returns a one-time private web login link.
4. Web bot Owner ID is derived from the authenticated account's linked Discord ID instead of trusting a user-entered Owner ID.
5. Control bot auto-start now launches dc-bot/bot.py, not the old duplicate control_bot.py.
6. A reusable .control-venv is used, and Nixpacks pre-installs dc-bot dependencies.
7. Control bot automatically retries after an unexpected exit.
8. Existing bot-template/main.py was left untouched.

Environment:
- CONTROL_BOT_TOKEN: the token for the TinshiSource control bot
- CONTROL_BOT_OWNER_ID: owner/admin Discord user ID
- CONTROL_BOT_SECRET: long random shared secret
- PUBLIC_BASE_URL: public HTTPS site URL
- DATABASE_URL: Railway MySQL public URL when running outside Railway
- AUTO_START_CONTROL_BOT=true

Important:
- Do not commit a real .env file into source control.
- Rotate credentials that were previously pasted into chats/logs.
