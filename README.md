# Avatar Twitch OAuth

## Setup

1. Copy `.env.example` to `.env` and fill credentials:
   - `TWITCH_CLIENT_ID`
   - `TWITCH_CLIENT_SECRET`
   - optional: `TWITCH_SCOPES` (default `chat:read`)
2. Install deps:
   ```bash
   npm install
   ```
3. Provide infrastructure services:
   - Redis 6+ for distributed event bus and donation polling locks (`REDIS_URL`)
4. Run:
   ```bash
   npm run start
   ```
5. Open `http://localhost:3000` and click "Вход".

Tokens and user are saved into `data.sqlite` for later chat access.
