TINSHI SOURCE — WEB + DISCORD CONTROL BOT

Railway environment variables:
CONTROL_BOT_TOKEN=your_control_bot_token
CONTROL_BOT_OWNER_ID=1518966127546339439
CONTROL_BOT_SECRET=long_random_secret
LTC_ADDRESS=your_litecoin_address
PUBLIC_BASE_URL=https://your-railway-domain
DATABASE_URL=mysql://...
SESSION_SECRET=long_random_secret

npm start starts the web panel and the Discord control bot together.
Discord commands:
/trail       24-hour trial + one bot slot
/manage_bots private bot manager
/plans       monthly/extra-slot pricing + payment UI
/admin       owner-only admin panel
/control_status owner-only health check

The web Add Bot form includes Bot Name, Discord Bot Token, Owner ID and Channel ID.
The Owner ID is stored per bot and passed to the existing template config.
