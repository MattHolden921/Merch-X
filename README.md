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

## P&L marketing spend sync

The P&L planner can sync Google Ads and Meta Ads spend from Windsor.ai. Configure:

```text
WINDSOR_API_KEY=...
WINDSOR_ACCOUNT_NAME_CONTAINS=kit,kaboodal
```

Optional overrides are available if your Windsor connector names or fields differ:

```text
WINDSOR_GOOGLE_CONNECTOR=google_ads
WINDSOR_META_CONNECTOR=facebook
WINDSOR_GOOGLE_FIELDS=date,campaign,spend,account_id,account_name
WINDSOR_META_FIELDS=date,campaign,spend,account_id,account_name
WINDSOR_GOOGLE_ACCOUNT_IDS=
WINDSOR_META_ACCOUNT_IDS=
WINDSOR_GOOGLE_ACCOUNT_PARAM=account_id
WINDSOR_META_ACCOUNT_PARAM=account
WINDSOR_GOOGLE_REVENUE_FIELDS=conversion_value
WINDSOR_META_REVENUE_FIELDS=action_values_offsite_conversion_fb_pixel_purchase
WINDSOR_GOOGLE_REVENUE_WEIGHT=1
WINDSOR_META_REVENUE_WEIGHT=0.5
WINDSOR_AUTO_SYNC=true
WINDSOR_AUTO_SYNC_STALE_HOURS=24
WINDSOR_AUTO_SYNC_COOLDOWN_MINUTES=60
```

Windsor sync is account-scoped by default to account names containing both `kit` and `kaboodal`; returned rows are checked again before storage. Use exact `*_ACCOUNT_IDS` values once the Windsor account IDs are known. Google uses Windsor's `account_id` connector parameter; Meta uses `account`.

Attribution revenue from Windsor is used only as a scenario weighting signal. Shopify remains the accounting source for actual revenue. The forecast scales Google/Meta platform revenue back to the selected blended marketing return so platform attribution cannot double-count Shopify sales. Google defaults to `conversion_value`; avoid `all_conversions_value` unless the Google Ads conversion setup has been checked, because it can include non-primary conversion values and massively overstate purchase revenue. `WINDSOR_META_REVENUE_WEIGHT=0.5` dampens Meta's platform attribution by default; adjust these weights as confidence improves. Extreme channel platform scores are sanity-capped before calibration so one noisy field cannot dominate the forecast.

When Finance/Admin users load P&L actuals, Windsor auto-syncs missing Google/Meta spend for the selected period. It records sync attempts, skips periods already covered by a successful sync, refreshes recent ranges only after `WINDSOR_AUTO_SYNC_STALE_HOURS`, and backs off for `WINDSOR_AUTO_SYNC_COOLDOWN_MINUTES` after a recent attempt.

Manual marketing spend entries remain available for adjustments and non-automated channels.

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
