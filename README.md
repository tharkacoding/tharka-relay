# Tharka relay (the middle man)

```
Phone (APK / browser)  --HTTPS-->  Relay on Render  <--WebSocket (PC dials OUT)--  Your PC (Tharka)
```

Your PC is behind a home router, so a phone cannot reach it directly. The relay is a tiny Node server you host on Render.
The PC connects **out** to it (`wss://.../pc`), the phone talks to it over HTTPS, and the relay forwards each request to the PC
and returns the answer. The relay stores nothing and never logs message text.

> Why Render and not Vercel? Vercel serverless functions cannot hold a WebSocket open, so the PC could not stay connected.
> Render runs a normal long-lived Node process, so it can.

## Deploy on Render (step by step)

1. Push this repo to GitHub (it already is: the `relay/` folder is in it).
2. Go to <https://dashboard.render.com>, sign up / log in (GitHub login is fine).
3. **New +** -> **Blueprint** -> pick the repo -> Render reads `relay/render.yaml` (free plan, `rootDir: relay`) -> **Apply**.
   Alternative: **New +** -> **Web Service** -> pick the repo -> *Root Directory* `relay`, *Build* `npm install --omit=dev`,
   *Start* `node server.js`, *Health check path* `/health`, plan **Free**, then add env vars `PC_TOKEN` and `PHONE_TOKEN`
   (any random strings of at least 16 characters; the Blueprint generates them for you).
4. When the deploy is "Live", open the service -> **Environment**. Click the eye icon to reveal:
   * `PC_TOKEN`: paste this into Tharka on the PC (Control center -> Phone & bridges -> Relay).
   * `PHONE_TOKEN`: type this into the phone app.
5. Your relay URL is shown at the top of the service page, like `https://tharka-relay.onrender.com`.
   Check `https://<your-url>/health` shows `{"ok":true,"pc":false}` (becomes `true` once the PC is connected).

## Environment

| Variable | Meaning |
| --- | --- |
| `PC_TOKEN` | secret the PC presents (header `x-pc-token`) to connect. Min 16 chars. |
| `PHONE_TOKEN` | secret the phone presents (header `x-token` or `?t=`). Min 16 chars. |
| `PORT` | set by Render; defaults to 10000. |

The server refuses to start if either token is missing or shorter than 16 characters.

## Behaviour

* Only `GET /health` is open. Everything else needs the phone token (compared in constant time via hashes).
  After 10 wrong tokens in a minute from one IP the relay answers 429.
* One PC at a time: a new PC connection replaces the old one. Ping every 20 s keeps the link alive and detects dead peers.
* Phone request -> `{id, method, path, body}` to the PC (the phone token is stripped from the path) -> `{status, body, type}` back.
* 503 if the PC is offline, 504 if it does not answer within 25 s, 413 for bodies over 200 KB.
* The PC side only replays `GET /` and `GET|POST /api/<word>` to its local phone link; any other path gets 404.

## Free plan caveat

Render free instances sleep after about 15 minutes without traffic. The first request after that wakes the service
(roughly 30-60 seconds); the PC reconnects by itself and the phone app retries automatically.

## Security: what the phone token can do

Anyone holding `PHONE_TOKEN` (and your relay URL) can **chat with your Tharka agent and approve or deny its actions**
(running commands, site access, and so on), exactly like the phone link on your PC. Treat it like a password.
Approvals still happen through the existing phone-link screens; nothing is auto-approved.
`PC_TOKEN` only lets someone register as your PC (they could then receive and answer your phone's requests), so keep it secret too.

**If a token leaks:** change `PHONE_TOKEN` (and/or `PC_TOKEN`) in Render -> Environment and let it redeploy, then in Tharka press
**New secret token** (phone link) and update the PC token in the Relay box. Traffic is HTTPS/WSS between phone, relay and PC;
the relay sees plaintext while forwarding but keeps no copy.

## Run locally

```
cd relay && npm install
PC_TOKEN=aaaaaaaaaaaaaaaa PHONE_TOKEN=bbbbbbbbbbbbbbbb node server.js
```
