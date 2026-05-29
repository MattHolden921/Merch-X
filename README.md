# Merch X

Barebones hosted version of the merchandising prototype.

## What changed

- The original standalone report is now served from `public/index.html`.
- No build step or frontend framework is required.
- Marketing PDF extraction now runs locally in the browser with open-source PDF.js.
- Weekly commentary is generated deterministically from the report metrics, with no model/API dependency.

## Run locally

```bash
copy .env.example .env
npm start
```

Open:

```text
http://localhost:3000
```

Password protection is enabled when `APP_USERNAME` and `APP_PASSWORD` are set. Leave them unset only for local throwaway testing.

## Deploy

The simplest live options are:

- Vercel: import the repo and deploy.
- Render/Railway/Fly: run `npm start` and deploy.
- Hetzner VPS: run the Node app with `APP_USERNAME` and `APP_PASSWORD`, then put Caddy in front for HTTPS.

See `DEPLOY_HETZNER.md` for the full GitHub-to-Hetzner setup.

This is intentionally simple. The next professional step is deciding whether uploaded reports should remain browser-only or be saved centrally so the whole team sees the same reports without re-uploading files.
