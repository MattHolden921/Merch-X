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

For local throwaway testing you can leave auth unset. Shared-password fallback is enabled with:

```text
AUTH_MODE=basic
APP_USERNAME=merch
APP_PASSWORD=change-this-long-password
```

For hosted production, use the shared password as the outer browser gate, then Google Workspace sign-in for named users and roles:

```text
AUTH_MODE=google
APP_USERNAME=merch
APP_PASSWORD=change-this-long-password
GOOGLE_AUTH_CLIENT_ID=...
GOOGLE_AUTH_CLIENT_SECRET=...
GOOGLE_AUTH_REDIRECT_URI=https://your-domain/api/auth/google/callback
GOOGLE_ALLOWED_DOMAINS=your-domain.com
APP_ADMIN_EMAILS=admin@your-domain.com
SKU_REGISTER_ROLES=Admin,Buyer
```

With both `AUTH_MODE=google` and `APP_USERNAME` / `APP_PASSWORD` set, users see the original browser username/password prompt first, then the Google sign-in screen. The first admin must be listed in `APP_ADMIN_EMAILS`. Other same-domain Google users are created as pending until an admin activates them on the Users page.

The SKU Register is restricted separately with `SKU_REGISTER_ROLES`. Leave it as `Admin,Buyer`, or change it to another comma-separated role list such as `Admin,Merchandising`.

Email links use `APP_BASE_URL`, and Weekly Action emails are batched before sending:

```text
APP_BASE_URL=https://your-domain
NOTIFICATION_DIGEST_DELAY_MINUTES=10
```

Order handoff emails are sent immediately. Weekly Action handoffs, owner changes, and blocked/unblocked updates are grouped into one email per user after the digest delay.

## Email merchandising and Klaviyo

The Email Merchandiser uses the existing Shopify and GA4 connections. To create Klaviyo drafts, configure `KLAVIYO_PRIVATE_API_KEY`, `KLAVIYO_DEFAULT_AUDIENCE_ID`, and `STOREFRONT_URL`. Optionally set `KLAVIYO_BASE_TEMPLATE_ID` or `KLAVIYO_BASE_TEMPLATE_PATH`; custom templates must include `{{MERCH_X_PRODUCTS}}`. Merch X creates drafts only and never schedules or sends campaigns.

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
