# Roam stream relay (Cloudflare Worker)

Streams Google Drive files for Roam without using your web host's bandwidth. Optional: without it, Roam streams Drive files through its own server.

## Set up (free Cloudflare account, no domain needed)

1. Make a secret and keep it: `openssl rand -base64 32`
2. From this folder: `npx wrangler login`, then `npx wrangler deploy`. It prints an address like `https://roam-stream.<you>.workers.dev`.
3. Give the Worker the secret: `npx wrangler secret put STREAM_SECRET` (paste the value from step 1).
4. In Roam's environment (Vercel, and `.env.local`) set `STREAM_SECRET` to the same value and `STREAM_WORKER_URL` to the Worker's address (no trailing slash). Redeploy Roam.

New Drive playback then goes through the Worker. Free-plan limits: 100,000 requests a day and 10 ms of CPU per request; there is no charge for bandwidth. Past the daily cap the Worker refuses requests until the next day.
