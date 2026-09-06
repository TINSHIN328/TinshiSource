# TINSHI BOT PANEL — Railway Backend

This project is ready to run as the backend + UI on Railway. The browser UI calls the same Railway origin (`/api/*`), so no hard-coded localhost backend is used.

## Railway setup

1. Create a Railway project and deploy this folder from GitHub or upload the repository.
2. Add a Railway Volume and mount it at `/data`. This is important because user records, per-user bot configs and runtime files must survive redeploys.
3. Add variables:
   - `NODE_ENV=production`
   - `TRUST_PROXY=1`
   - `DATA_DIR=/data`
   - `SESSION_SECRET=` a long random secret
4. Railway provides `PORT` automatically; do not hard-code it.
5. After deploy, test:
   `https://YOUR-RAILWAY-DOMAIN/api/health`
6. If Google login is enabled, set:
   - `GOOGLE_CLIENT_ID`
   - `GOOGLE_CLIENT_SECRET`
   - `GOOGLE_REDIRECT_URI=https://YOUR-RAILWAY-DOMAIN/auth/google/callback`

## Important isolation behavior

- Each username has its own directory under `DATA_DIR/runtime/<username>/bot`.
- A new account starts with an empty token, Owner ID and Channel ID.
- `/api/config` never returns the bot token to the browser.
- Normal users cannot call `/api/admin/users`.
- Console/SSE streams are scoped to the logged-in session.

## If UI and backend are on separate domains

Set `FRONTEND_ORIGIN` to the exact frontend origin and use a reverse proxy/HTTPS. The UI currently uses relative `/api/*` URLs, so the simplest and recommended deployment is to serve the UI from this same Railway service.
