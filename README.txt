TINSHI BOT CLOUD - SAFE PANEL BUILD

Features:
- Login/register with password confirmation
- No backend URL field on login
- Non-premium users see only Get Started on Dashboard; it opens Plans
- $8/month Litecoin plan with manual admin approval
- Separate Dashboard, Plans, Bot Connection, Console and Admin pages
- Per-user private bot config and private console
- Start/Stop controls only on Console page
- Backend URL comes from environment; same-origin deployment uses relative /api automatically
- Discord bot template is a benign management bot with /ping only. It does not collect Minecraft/Microsoft credentials or verification codes.

Local:
  npm install
  npm start
Open http://localhost:3000
Default admin is admin / admin123 unless changed in environment before first start.

Railway:
Set NODE_ENV=production, SESSION_SECRET, ADMIN_USERNAME, ADMIN_PASSWORD. Use the Railway public HTTPS URL as BACKEND_URL only when frontend is hosted separately. For this combined app, BACKEND_URL can remain empty.

IMPORTANT: change the default admin password and rotate any Discord token that has been exposed in chat/logs.
