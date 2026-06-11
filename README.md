# Merch X

Barebones hosted version of the merchandising prototype.

For the living product/logic reference, see `PROJECT_SPEC.md`.

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

## Database

Order forms, suppliers, saved product details, invoice metadata, and workflow status are stored in SQLite. Uploaded invoice files and order/product images are stored on disk and referenced from SQLite.

Local default:

```text
./data/merch-x.sqlite
```

On a VPS, keep the database outside the repo and set:

```text
DATABASE_PATH=/var/lib/merch-x/merch-x.sqlite
UPLOADS_DIR=/var/lib/merch-x/uploads
```

The app creates the SQLite schema on startup. If `data/order-form-db.json` exists and the SQLite database is empty, the app imports the prototype JSON data once.

Order form SKU issuing starts from `ORDER_FORM_INITIAL_SKU` (`15100` by default) and skips any SKU already saved locally when the sequence reaches it.

Local uploaded files default to:

```text
./data/uploads
```

On Hetzner, `/var/lib/merch-x/uploads` can be local VPS disk at first, then later a mounted Hetzner Volume without changing the app configuration.

For Hetzner/VPS backups, use SQLite's backup command rather than copying a live database file:

```bash
sqlite3 /var/lib/merch-x/merch-x.sqlite ".backup '/var/backups/merch-x/merch-x-$(date +%F).sqlite'"
```

Also back up the uploads directory, which contains invoices and order/product images:

```bash
rsync -a /var/lib/merch-x/uploads/ /var/backups/merch-x/uploads/
```

## Deploy

The simplest live options are:

- Vercel: import the repo and deploy.
- Render/Railway/Fly: run `npm start` and deploy.
- Hetzner VPS: run the Node app with `APP_USERNAME` and `APP_PASSWORD`, then put Caddy in front for HTTPS.

See `DEPLOY_HETZNER.md` for the full GitHub-to-Hetzner setup.

This is intentionally simple. The next professional step is deciding whether uploaded reports should remain browser-only or be saved centrally so the whole team sees the same reports without re-uploading files.
