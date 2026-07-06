# Merch X Project Spec

Last reviewed: 2026-07-03

This is the shared logic and product reference for Merch X. Keep it current when the app's workflows, calculations, data model, integrations, or page responsibilities change.

## Product Purpose

Merch X is a hosted merchandising toolkit for Kit and Kaboodal / AMG Retail workflows. It brings together sales reporting, stock/order creation, local SKU issuing, Shopify merchandising views, collection reorder planning, order workflow tracking, invoice handling, and weekly trading actions.

The app favours simple operational tools over a large framework:

- A Node.js HTTP server in `server.js`.
- Static HTML/CSS/JavaScript screens in `public/`.
- SQLite for persistent app data.
- Disk storage for uploaded invoices and product/order images.
- Shopify and GA4 integrations when credentials are configured.
- Local fallback/sample behaviour where useful, so tools remain inspectable without live credentials.

## Running And Deployment

- Local command: `npm start`.
- Default URL: `http://localhost:3000`.
- Runtime: Node 20+.
- Main database path: `DATABASE_PATH`, defaulting to `./data/merch-x.sqlite`.
- Upload storage path: `UPLOADS_DIR`, defaulting to `./data/uploads`.
- Shared password protection is enabled when `APP_USERNAME` and `APP_PASSWORD` are set. In Google auth mode, this remains the outer browser-level gate before Google sign-in.
- Google Workspace sign-in is enabled with `AUTH_MODE=google`, `GOOGLE_AUTH_CLIENT_ID`, `GOOGLE_AUTH_CLIENT_SECRET`, `GOOGLE_ALLOWED_DOMAINS`, and `APP_ADMIN_EMAILS`.
- SKU Register access is controlled by `SKU_REGISTER_ROLES`, defaulting to `Admin,Buyer`.
- Email notifications use SMTP settings when configured: `SMTP_HOST`, `SMTP_PORT`, and `SMTP_FROM`.
- Email links use `APP_BASE_URL`. Weekly Action email notifications are batched using `NOTIFICATION_DIGEST_DELAY_MINUTES`, defaulting to 10 minutes.
- Hetzner/VPS setup details live in `DEPLOY_HETZNER.md`.

## Repository Map

- `server.js`: HTTP server, auth, static serving, API routes, integrations, persistence, migrations, report calculations, workflow logic.
- `public/index.html`: tool hub.
- `public/design-system.css`: shared visual system.
- `public/bestsellers.html`: TY/LY bestsellers, revenue analysis, stock position, slow sellers, methodology, trade last week, CSV/import workflows.
- `public/order-form.html`: purchase order creation, SKU issuing/lookup, line image upload, printable PO output.
- `public/orders.html`: order workspace, approval/payment/intake workflow, invoices, notes, archive/delete, printable warehouse image reports, and barcode label-job reports for printers and suppliers.
- `public/order-reports.html`: read-only operational reports for arrivals, intake exceptions, next actions, finance, buying mix, and data quality.
- `public/pnl.html`: finance P&L planner using live Shopify actuals, saved cost rules, manual marketing spend, and driver-based profit scenarios.
- `public/sku-register.html`: local SKU register and safe deletion of unused issued SKUs.
- `public/products.html`: product and supplier master-data workspace, local SKU enrichment, readiness review, and Shopify draft push workflow.
- `public/merchandising.html`: Shopify product merchandising view using product, order, and optional GA4 metrics.
- `public/collection-planner.html`: Shopify collection reorder planning and apply-to-Shopify workflow.
- `public/sale-planner.html`: markdown and sale planning workspace for importing products, reviewing markdown prices, mapping Sale collections, applying Shopify sale state, and removing sale state.
- `public/weekly-actions.html`: action board generated from saved bestsellers periods.
- `public/email-merchandising.html`: guided six-product email campaign builder, Klaviyo draft handoff, campaign history, and performance reporting.
- `README.md`: setup and storage overview.
- `DESIGN.md`: visual/design guidance.

## Core Architecture

The server uses Node's built-in `http`, `https`, `fs`, `path`, and `crypto` modules plus `better-sqlite3`.

Request flow:

1. Load `.env` values if present.
2. Resolve server port, SQLite path, and uploads path.
3. Apply auth: shared-password gate first when credentials are configured, then Google session auth when `AUTH_MODE=google`, shared-password-only auth when `AUTH_MODE=basic`, or no auth for local throwaway mode.
4. Route integration endpoints such as Shopify, collection reorder, and Google OAuth.
5. Route other `/api/*` requests through `handleApi`.
6. Serve `/uploads/*` from the configured uploads directory.
7. Serve static files from `public/`, falling back to `index.html` when a file is missing.

The frontend is plain HTML with inline scripts. API helpers usually try same-origin first and, where useful for local testing, localhost fallbacks.

## Data Storage

SQLite is the system of record for current app data. The schema is created and lightly migrated on server startup.

Primary table groups:

- App/config/auth: `app_settings`, `users`, `auth_sessions`.
- Work management: `work_handoffs`, `notifications`.
- Buying/order form: `suppliers`, `products`, `issued_skus`, `orders`.
- Product/supplier master data: extended `suppliers` and `products` rows plus `product_sync_events`.
- Order management: `order_workflows`, `order_events`, `order_invoices`, supplier batches, PAH carrier defaults in `app_settings`, and immutable `order_label_jobs` report snapshots.
- Collection reorder: `collection_reorder_audit`.
- Reporting: `report_sources`, `report_periods`, `report_product_metrics`, `report_stock_snapshots`, `report_sync_jobs`, `report_snapshots`.
- Weekly actions: `weekly_actions`, `weekly_action_events`.
- Sale planner: `sale_plans`, `sale_plan_items`, `sale_plan_events`, plus Sale collection mapping stored in `app_settings.salePlannerCollections`.
- P&L planner: reusable `pnl_cost_rules`, dated manual/automated `pnl_marketing_spend` entries, raw `pnl_marketing_spend_actuals` rows for Windsor campaign spend, and `pnl_windsor_sync_runs` for sync coverage/cooldown tracking.
- Email merchandising: `email_campaigns`, immutable product snapshots in `email_campaign_products`, and source-specific `email_campaign_metric_snapshots`.

Legacy/prototype data:

- If `data/order-form-db.json` exists and SQLite is empty, the app imports it once.
- New changes should treat SQLite as canonical.

Uploads:

- Invoice files are stored under `uploads/invoices/...`.
- Order line images are stored under `uploads/order-images/...`.
- Product images are stored under `uploads/product-images/...`.
- Uploaded file paths stored in SQLite are relative to `UPLOADS_DIR`.
- Never expose arbitrary disk paths; all upload reads must pass through the upload path guard.

## Integrations

### Shopify

Configuration:

- `SHOPIFY_SHOP`, `SHOPIFY_STORE_DOMAIN`, or `SHOPIFY_SHOP_DOMAIN`.
- `SHOPIFY_CLIENT_ID`.
- `SHOPIFY_CLIENT_SECRET`.
- `SHOPIFY_API_VERSION`, defaulting to `2026-07`.

Used for:

- Product and variant lookups by SKU.
- Draft product creation from local product master records.
- Product merchandising sync.
- Collection planner product and collection sync.
- Collection reorder apply jobs.
- Sale planner price, compare-at price, and Sale collection apply/remove jobs.
- Bestsellers sync from Shopify orders/products.
- P&L actual sales via ShopifyQL reports.

When Shopify is not configured, tools should return a clear configured=false response and use samples or saved local data where appropriate.

### GA4

Configuration supports either OAuth refresh token or service account credentials:

- `GA4_PROPERTY_ID` or `GOOGLE_ANALYTICS_PROPERTY_ID`.
- OAuth: `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REFRESH_TOKEN`, `GOOGLE_OAUTH_REDIRECT_URI`.
- Service account: `GOOGLE_SERVICE_ACCOUNT_JSON` or `GOOGLE_APPLICATION_CREDENTIALS`.

Used for:

- Product view/add/purchase/revenue metrics merged into merchandising and collection planning reports.
- Google OAuth start/callback endpoints can write a refresh token back to `.env`.

### Windsor.ai

Configuration:

- `WINDSOR_API_KEY`.
- Optional connector overrides: `WINDSOR_GOOGLE_CONNECTOR`, `WINDSOR_META_CONNECTOR`.
- Optional field overrides: `WINDSOR_GOOGLE_FIELDS`, `WINDSOR_META_FIELDS`.
- Account allowlist: `WINDSOR_ACCOUNT_NAME_CONTAINS=kit,kaboodal` by default, with optional exact `WINDSOR_GOOGLE_ACCOUNT_IDS` and `WINDSOR_META_ACCOUNT_IDS`.
- Account selector parameters: Google defaults to `WINDSOR_GOOGLE_ACCOUNT_PARAM=account_id`; Meta defaults to `WINDSOR_META_ACCOUNT_PARAM=account`.
- Attribution fields and weights: Google defaults to `WINDSOR_GOOGLE_REVENUE_FIELDS=conversion_value` with weight `1`; Meta defaults to `WINDSOR_META_REVENUE_FIELDS=action_values_offsite_conversion_fb_pixel_purchase` with weight `0.5`. Avoid Google `all_conversions_value` unless the conversion setup has been audited, because it can include non-primary conversion value and overstate purchase revenue.
- Optional refresh controls: `WINDSOR_REFRESH_SINCE`, `WINDSOR_REFRESH_INTERVAL`.
- P&L auto-sync controls: `WINDSOR_AUTO_SYNC=true`, `WINDSOR_AUTO_SYNC_STALE_HOURS=24`, `WINDSOR_AUTO_SYNC_COOLDOWN_MINUTES=60`.

Used for:

- P&L marketing spend automation for Google Ads and Meta Ads. Windsor requests include account selector parameters where exact account IDs are configured, with name filters as a fallback; returned rows are checked against the account allowlist before storage. Rows are stored as campaign-level daily actuals, then rolled into daily P&L marketing spend entries with `source = windsor`. Windsor attribution revenue is stored when authorised, but only as a forecast weighting signal; Shopify remains the only accounting revenue source.
- When Admin or Finance users load `GET /api/pnl`, missing Windsor coverage for the selected range auto-syncs before the P&L is calculated. Successful sync coverage is reused, recent ranges can refresh after the stale-hours window, and recent started/failed attempts apply the cooldown to avoid repeated Windsor calls.
- Manual P&L marketing spend remains available for adjustments and non-automated channels.

### Klaviyo

Configuration:

- `KLAVIYO_PRIVATE_API_KEY` and pinned `KLAVIYO_API_REVISION`.
- `KLAVIYO_DEFAULT_AUDIENCE_ID` for the draft campaign's initial audience; marketing must confirm the audience in Klaviyo before sending.
- Either `KLAVIYO_BASE_TEMPLATE_ID` or `KLAVIYO_BASE_TEMPLATE_PATH`. The template must contain `{{MERCH_X_PRODUCTS}}`; optional heading and preheader markers are `{{MERCH_X_HEADING}}` and `{{MERCH_X_PREHEADER}}`.
- `KLAVIYO_CONVERSION_METRIC_ID` is optional for campaign value reporting. `STOREFRONT_URL` is used when Shopify does not return a complete online store URL.

Merch X creates templates and draft campaigns but never schedules or sends them. Klaviyo remains responsible for audience confirmation, compliance, scheduling, and sending.

## Main API Surface

Reports and actions:

- `GET /api/reports/bestsellers/periods`
- `GET /api/reports/bestsellers`
- `POST /api/reports/bestsellers/sync`
- `POST /api/reports/bestsellers/sync-job`
- `GET /api/reports/bestsellers/sync-job`
- `POST /api/reports/bestsellers/import-csv`
- `GET /api/reports/stock-snapshots`
- `GET /api/pnl`
- `GET /api/pnl/settings`
- `POST /api/pnl/cost-rules/upsert`
- `POST /api/pnl/cost-rules/delete`
- `POST /api/pnl/marketing-spend/upsert`
- `POST /api/pnl/marketing-spend/delete`
- `POST /api/pnl/marketing-spend/sync-windsor`
- `POST /api/pnl/scenario`
- `GET /api/weekly-actions`
- `POST /api/weekly-actions/generate`
- `POST /api/weekly-actions/update`
- `GET /api/auth/google/start`
- `GET /api/auth/google/callback`
- `GET /api/email-campaigns`
- `POST /api/email-campaigns/recommendations`
- `POST /api/email-campaigns/refresh-data`
- `POST /api/email-campaigns/save`
- `POST /api/email-campaigns/klaviyo-draft`
- `POST /api/email-campaigns/sync-results`
- `GET /api/auth/me`
- `POST /api/auth/logout`
- `GET /api/admin/users`
- `POST /api/admin/users/update`
- `GET /api/notifications`
- `POST /api/notifications/read`
- `GET /api/users/assignees`

Order form and local SKUs:

- `GET /api/order-form/bootstrap`
- `GET /api/order-form/local-skus`
- `DELETE /api/order-form/local-skus`
- `POST /api/order-form/next-sku`
- `GET /api/order-form/sku`
- `POST /api/order-form/image`
- `POST /api/order-form/orders`

Product and supplier master data:

- `GET /api/products`
- `POST /api/products`
- `GET /api/products/detail`
- `POST /api/products/update`
- `POST /api/products/archive`
- `GET /api/suppliers`
- `POST /api/suppliers/update`
- `POST /api/products/shopify/preview`
- `POST /api/products/shopify/push-draft`
- `POST /api/products/shopify/sync-status`

Order workspace:

- `GET /api/orders/workspace`
- `GET /api/orders/reports`
- `GET /api/orders/detail`
- `POST /api/orders/workflow`
- `POST /api/orders/invoices`
- `POST /api/orders/invoices/delete`
- `POST /api/orders/archive`
- `POST /api/orders/delete`
- `POST /api/orders/events`
- `POST /api/orders/label-jobs`
- `GET /api/orders/pah`
- `POST /api/orders/pah-settings`

Shopify and Google:

- `GET /api/shopify-merchandising`
- `GET /api/shopify-collection-planner`
- `POST /api/shopify-collection-reorder/start`
- `GET /api/shopify-collection-reorder/status`
- `GET /api/sale-planner`
- `POST /api/sale-planner/import`
- `POST /api/sale-planner/items/update`
- `POST /api/sale-planner/items/remove`
- `POST /api/sale-planner/config`
- `POST /api/sale-planner/apply/start`
- `GET /api/sale-planner/apply/status`
- `POST /api/sale-planner/remove/start`
- `GET /api/google-auth/start`
- `GET /api/google-auth/callback`

## Business Logic

### SKU Issuing

- The initial SKU is `ORDER_FORM_INITIAL_SKU`, defaulting to `15100`.
- SKUs are normalized before comparison.
- Issuing skips SKUs that are already attached to saved products, orders, or issued SKU rows.
- `issued_skus` records reserved/issued numbers.
- Unused issued SKUs can be deleted only when no saved product or order data references them.
- `app_settings.lastIssuedSku` tracks the latest issued cursor.

### Order Numbers

- New orders receive the next local order number when one is not supplied.
- Orders are saved to SQLite as JSON payloads plus indexed top-level fields.
- Saving an order also updates supplier/product helper records and syncs workflow status defaults.

### Product And Supplier Master Data

- Merch X is the source of truth for pre-launch product records.
- Products are still keyed by SKU, with indexed columns for supplier, product type, season, price, cost, Shopify IDs, product status, and sync status while retaining JSON `data` for flexible fields.
- Supported product statuses are `Draft`, `Ready for Shopify`, `Shopify draft`, `Live`, and `Archived`.
- Supported product sync statuses are `Not synced`, `Ready`, `Synced draft`, `Conflict`, and `Error`.
- Readiness checks block Shopify draft push when SKU, supplier, title/style, RRP, product type, image, cost, or local SKU uniqueness is missing.
- SKU lookup from the order form prefers the local product master first, then falls back to live Shopify lookup.
- Saving an order enriches supplier/product master records with last-order metadata and non-empty line details without wiping curated master-data fields.
- `product_sync_events` records local save/archive and Shopify preview/push/status actions with actor, result, payload summary, Shopify product ID, and errors.

### Shopify Product Draft Push

- Only products marked `Ready for Shopify` and passing readiness checks can be pushed.
- Product pushes use Shopify Admin GraphQL `productSet` with `status: DRAFT`.
- Local uploaded product images are sent through Shopify staged uploads before being referenced by the product payload.
- Successful pushes store Shopify product and variant GIDs, set local status to `Shopify draft`, and set sync status to `Synced draft`.
- Failed pushes keep the product local, set sync status to `Error`, and write a sync event.
- Inventory quantity writes are intentionally out of scope for v1.

### Order Workflow

Order workflow is split into approval, payment, and intake sections. The composite order status is derived from workflow values and the stored order status.

Important principles:

- Workflow updates should record events.
- In Google auth mode, workflow actors come from the signed-in user, not browser-supplied free text.
- Next-action handoff can target a role owner and an optional active user assignee.
- Handoffs create work handoff records and in-app notifications. Order handoff email is sent immediately when SMTP is configured; Weekly Action email is grouped into a per-user digest after the configured delay.
- Buyers can upload invoice documents and invoice metadata. Finance/Admin retain control of payment-facing invoice state such as sent-to-FD and paid.
- Invoice changes can update payment workflow.
- Archiving hides orders from active creation/bootstrap views but preserves history.
- Deleting an order should remove related invoice records/files and workflow data only through the server's delete logic.
- The Orders workspace can print a warehouse-facing image report for the full order, a selected delivery batch, or remaining unbatched units. The report contains product image, SKU, buying code, colour/material, and quantity only; batch reports use allocated quantities and unbatched reports use ordered quantity less all allocations.

### PAH Delivery Reports

- The Orders workspace exports the freight forwarder's 20-column PAH CSV contract in one click for a full order, a selected supplier batch, or remaining unbatched units.
- Product description, SKU, colour/fabric, and quantities come from the saved order. A batch export uses only that batch's line allocations and its warehouse ETA; an unbatched export subtracts all existing allocations.
- Full-order and unbatched exports use the workflow warehouse ETA when available, then the order's required delivery date. Export is blocked when no valid ETA/date, no scoped units, a SKU, or a whole-unit quantity is missing.
- Batch pre-advice IDs append the saved batch number/title to the PO number so separate deliveries cannot overwrite one another at the warehouse. The CSV filename uses the same reference.
- Pre-advice type, warehouse supplier ID, carrier/contact details, warehouse address, country, and return flag are stored as editable JSON under the SQLite `app_settings.pahCarrier` key. Initial values match the current Europe Logistics / Rebecca Bird workflow; report generation reads the persisted setting rather than inline UI values.
- Buyer, Merchandising, and Admin roles can export PAH files and edit the shared PAH defaults. Every supplier-batch row also has a direct PAH CSV action.

### Barcode Label Jobs

- Barcode label jobs can be generated for a full order, a selected supplier batch, or remaining unbatched units.
- The barcode value is exactly the normalized Merch X SKU and the printer is instructed to render it as Code 128. GTIN/EAN generation and check-digit transformation are out of scope.
- The printer workbook has one row per unique SKU and includes barcode value, fixed label size, buying code, style, category, colour, size, match key, ordered units, labels per unit, spare labels, and total labels. Barcode format, RRP, and label-template columns are intentionally omitted. Its job-instructions sheet includes supplier/scope details and the double-barcode requirement.
- Two identical labels are required for every ordered unit: one on the swing ticket and one on the outside of the product packaging. Required print quantity is `ordered units x 2 + spare labels per SKU`.
- The standard proof layout is 60 x 40 mm so it fits within a 70 x 50 mm swing-ticket area with 5 mm clearance on every side. It displays style name, buying code labelled `ART`, SKU, colour, and a generated Code 128 barcode in that order; the printable proof is laid out at physical size on A4 for 100% / Actual size printing or PDF export.
- The supplier guide is available as separate English and Italian print/PDF outputs generated from the same label-job snapshot. Both group variations beneath the style name and use only four columns: Product image, Buying code, Our SKU, and Apply to. Apply-to instructions state the colour/size quantity and require one label on the swing ticket plus one on the outer packaging. Stored style and colour values remain untranslated so they match the purchase order exactly; both guides explicitly note that colour names are shown in English. The final page embeds `public/assets/good-barcode-example.png` as the approved visual example.
- Preflight validation blocks missing SKUs, non-whole label quantities, conflicting duplicate SKU details, shared buying codes without colour, and same-code/same-colour variations without size. Missing buying code, style, colour, or image can be reported as warnings when the variation remains unambiguous.
- An optional fixed spare-label quantity is applied once per unique SKU.
- Successful generation writes an immutable JSON snapshot to `order_label_jobs`, assigns an order-level versioned job number, and records an order event. Later order or product edits do not alter an existing job.

### Invoices

- Invoices are attached to orders.
- New invoice files are written to disk and referenced by `file_path`.
- The API returns public upload URLs, not raw filesystem paths.
- Invoice totals and paid/sent-to-FD states feed payment status.

### Bestsellers Reports

Reports can come from:

- Shopify API sync.
- CSV imports.
- Saved periods/snapshots.

Report concepts:

- `report_sources` records the origin.
- `report_periods` defines date ranges and source type.
- `report_product_metrics` stores product-level sales, stock, GP, price, GA, and Shopify identifiers.
- `report_snapshots` caches assembled payloads.
- `report_sync_jobs` tracks longer Shopify syncs.

Key calculated fields include weekly units, average price, GP percent, GP per unit, cover weeks, forecast buy, dead stock, stock value, and category/season summaries.

### Stock Snapshots

Stock snapshot rows represent Shopify variant-level inventory and pricing at a point in time. They support stock position, markdown state, and SKU/product status filters.

### Weekly Actions

Weekly actions are generated from saved Shopify bestsellers periods. Candidate action types:

- `reorder`: selling with low cover or forecast buy requirement.
- `markdown`: stock-heavy or no/weak sales lines.
- `feature`: strong sellers with stock and acceptable GP where available.
- `watch`: mixed signals such as missing cost, medium cover, or sales with no stock showing.

Actions use a `dedupe_key` by type/product so unresolved existing actions are updated rather than duplicated. Statuses are `Open`, `In progress`, `Snoozed`, `Blocked`, and `Done`.
Actions keep their role owner and can also be assigned to an active user. Owner/assignee changes create handoff records and notifications.

### Sale Planner

The Sale Planner is the operational markdown workflow for Shopify sale changes.

Key principles:

- Buyer, Merchandising, and Admin users can import products, review suggested markdowns, and edit sale-plan items. Only Admin users can apply or remove live Shopify sale state.
- Products can be imported from Weekly Actions or Product Merchandising. Importing Weekly Action rows sets open markdown actions to `In progress` and records a weekly action event.
- Non-applied rows can be removed from the planner without changing Shopify. Applied rows must use the remove-from-sale workflow first, preserving the audit trail and stored collection targets.
- Suggested markdowns use a risk ladder of 10%, 20%, 30%, 40%, and 50%. The score considers stock, cover weeks, sell-through, weak sales, stock value, age, season, existing markdown state, and failed/deeper markdown signals.
- Sale prices round to the nearest pound by default. Existing markdowns use `compareAtPrice` as the original price and only recommend the same or a deeper markdown step.
- Multi-variant products receive the same discount percentage per variant, calculated from each variant's own original/current price. Manual target-price edits update every stored variant target so Shopify receives the visible plan price. The planner shows target GP% using `(((retail price / 1.2) - cost price) / (retail price / 1.2))`, with the row value using the lowest variant GP%. Warnings are shown for missing variants, missing prices, final-clearance markdowns, missing Sale collections, and target prices below cost.
- Sale collection mapping auto-detects the root `Sale` collection and child collections such as `Sale Tops`; Admin users can save overrides in `app_settings.salePlannerCollections`.
- Applying sale state preflights the live Shopify product and blocks stale plans when planned variant prices no longer match Shopify. Successful applies update variant `price` and `compareAtPrice`, then add the product to the root Sale collection and mapped child Sale collection.
- Applying sale state also writes Shopify `custom.product_status` to `S`. Removing sale state writes it back to `N`.
- Sale state keeps a local variant-level ledger of the first true RRP, so incremental markdowns and final restore actions use the original RRP rather than a previous markdown price.
- Removing sale state restores each variant to the ledger RRP, falling back to live `compareAtPrice`, clears `compareAtPrice`, and removes the product from the stored root/child Sale collections. If no restore price exists, the current price is left unchanged and a warning is recorded.
- Sale analysis compares saved pre/post markdown report data, including sell-through and GA CVR, and stores outcomes as `worked`, `watch`, `deepen`, or `remove`. Those outcomes inform future markdown step recommendations for similar product type/season combinations.
- Analysis refresh also creates a persistent action queue for the small number of changed recommendations from a large sale plan. Queue actions include deeper markdowns, sale removals, and low-view markdowns where poor performance may be an exposure issue rather than a price issue.
- Users can mark analysis actions as `Pending`, `Accepted`, `Ignored`, `Snoozed`, or `Applied`. Selected deepen/remove actions can create a follow-up sale plan containing only those products, so Admin users can apply the existing Shopify job workflow without re-reviewing the full original sale list.
- Apply and remove jobs are kept in memory while running and write item-level results plus `sale_plan_events` audit rows. If the server restarts, users should refresh the planner and verify Shopify before retrying.

### P&L Planner

The P&L Planner is a Finance-led profit workspace. Admin and Finance users can edit cost rules and marketing spend. Buying Director users can view actuals and run scenarios.

Key principles:

- ShopifyQL sales reports are the source for P&L actuals. Date ranges are inclusive and capped at 92 days.
- Primary P&L sales views are Despatch and Demand. Despatch maps to ShopifyQL `total_sales`. Demand is derived as product sales inc VAT, after discounts, before returns: `(gross_sales - absolute_discounts) * (1 + effective VAT rate)`. ShopifyQL `gross_sales` remains visible only as gross sales ex VAT before discounts and returns. Discounts, returns, shipping, net sales, and taxes are shown as separate sales-bridge boxes because they materially explain the movement from Demand to Despatch. Net sales remains the ex-VAT product revenue used for gross-profit and net-profit calculations. Gross profit % is shown using the merchandising/reporting convention: for an inc-VAT retail value, `((retail value / 1.2) - cost) / (retail value / 1.2)`. In the P&L planner this is equivalent to `(net sales ex VAT - COGS) / net sales ex VAT`. Net profit is the pound operating-profit value after COGS, marketing, variable costs, and fixed overheads; Net profit % is `net profit / net sales ex VAT`.
- AOV is Despatch divided by ShopifyQL order count.
- COGS uses current Shopify variant unit cost at fetch time. If a line item has no cost, the planner flags the affected units and revenue so profit quality is visible.
- Reusable cost rules support `fixed_monthly`, `per_order`, `per_item`, `pick_pack`, `percent_revenue`, and `percent_revenue_plus_per_order` for card/payment fees that combine a Despatch percentage with a fixed per-order fee. Fixed monthly costs are prorated by overlapping days in each calendar month. Variable rules are prorated by active-date overlap before applying the selected range's Despatch, orders, or units.
- Variable costs are shown separately from product COGS and fixed monthly overheads. Total variable costs include all non-fixed cost rules, including fulfilment, postage, pick/pack, per-item costs, and card/payment fees. Variable cost per order is total variable costs divided by orders. Fixed monthly costs are separately exposed as fixed cost total, fixed cost per order, and fixed cost drag (`fixed monthly costs / net sales ex VAT`). Contribution before fixed costs is `gross profit - marketing spend - variable costs`, with contribution % using net sales ex VAT as the denominator. The scenario detail table can also show order-driven and revenue-driven portions for diagnosis.
- Pick and pack costs are calculated as first-item rate per order plus additional-item rate for units above one per order.
- Marketing spend is stored as dated channel entries such as Google, Meta, Klaviyo, TikTok, Affiliate, or Other. Manual entries remain available for adjustments. Google and Meta can also be synced from Windsor.ai: API requests are account-scoped to Kit and Kaboodal by default, exact IDs are sent through connector account parameters, raw campaign/day spend is stored in `pnl_marketing_spend_actuals`, then rolled up into daily `pnl_marketing_spend` entries marked `source = windsor`. `pnl_windsor_sync_runs` records started, success, and error attempts so page loads can auto-sync missing coverage without spamming Windsor. Entries are prorated by date overlap with the selected P&L range.
- The period control defaults to the last completed Monday-Sunday week. Changing either date switches the control to Custom, and Shopify actuals are fetched only when the user clicks Load actuals.
- Scenarios are not saved in v1. They recalculate from loaded actuals using either a manual daily Despatch target or a marketing-driven sales model. Marketing spend only creates incremental Despatch when the marketing-driven mode is enabled; otherwise it is treated as a cost change only. In marketing-driven mode the Daily Despatch slider represents the final linked daily target, so changing marketing spend/ROAS moves the daily target and the server does not add the uplift a second time. The default blended marketing return remains Shopify-calibrated (`Despatch / marketing spend` unless edited), while Windsor platform revenue splits that return across Google and Meta using configurable confidence weights. Scenario users can override Google and Meta spend and ROAS independently; channel ROAS sliders default to the channel platform ROAS from Windsor where available, falling back to the calibrated forecast return. Scenario KPI cards and driver sliders show actual values as secondary context. Users can reset drivers back to the loaded actuals, and can add named temporary scenario snapshots to an in-page comparison table; these comparison scenarios are cleared when a new actual period is loaded and are not persisted to SQLite. This means Google/Meta platform attribution can shape the forecast without adding revenue on top of Shopify actuals. Extreme channel platform scores are sanity-capped before calibration so a noisy attribution field cannot dominate the channel split. AOV delta, optional Gross profit % override, and items per order then reshape orders, units, COGS, and variable costs. Fixed costs remain fixed/prorated; variable costs recalculate from scenario sales, orders, and units. The planner also calculates the incremental break-even marketing ROAS from Gross profit %, COGS, AOV, items/order, and variable cost rules; this is the minimum Despatch return required for extra marketing spend to avoid reducing net profit. The scenario response includes an operating-leverage view that calculates the selected scenario's fixed-cost drag, contribution before fixed costs, breakeven daily Despatch, and the daily Despatch where fixed monthly overhead falls below the low-drag threshold, defaulting to 5% of net sales ex VAT. Sensitivity and leverage tables/charts show net-profit impact for daily Despatch, AOV, marketing-spend changes, and fixed-cost dilution.
- Scenario outputs are decision-support estimates, not posted accounting entries.

### Collection Reorder Planner

The collection planner fetches Shopify collections/products, ranks products according to the selected strategy, previews movement, and can apply a new order through a background reorder job.

Guardrails:

- Applying a reorder requires explicit user confirmation.
- Manual Lift can stage products whose Shopify featured image media was recently updated, optionally constrained by current collection position, then sends explicit Shopify move inputs for the selected products only, preserving the relative order of everything else. Product-level `updatedAt` is shown for audit but is not used for image lifting.
- The default Manual Lift shortcut uses `Images 3d` and `From #9`, preserving the first two four-product visual rows before staging recently updated imagery.
- Reorder jobs are polled until complete/error.
- Successful applies are written to `collection_reorder_audit`.
- After apply, the user should sync collections again to verify live Shopify order.

### Email Merchandiser

The Email Merchandiser ranks active, published Shopify products with at least three units of stock, a product image, price, and storefront URL. Its objectives are Balanced Mix, New In, Underexposed, Never Featured, and Proven Performers. Scores combine objective relevance with stock, margin, sales, GA4 engagement, launch recency, feature history, campaign theme, and capsule cohesion.

Shopify products/orders and GA4 metrics are fetched into one shared `email_merchandising:weekly` record in `report_snapshots`. Generating or regenerating a capsule reads that snapshot without calling external APIs. Users explicitly refresh it about once per week; snapshots older than seven days remain usable but show a stale-data warning, and a failed refresh leaves the previous successful snapshot intact.

Each capsule contains exactly six products. Cohesion strongly rewards shared material/style terms, campaign-theme matches, season, compatible colours, related product types, and price proximity. More than two products of one type or colour carries a diversity penalty rather than a hard exclusion, preventing an unrelated sixth choice from being forced into the capsule. Users can pin, remove, reorder, search all eligible alternatives, and drag replacements directly into any of the six slots before saving. Saved rows snapshot the product content used in the campaign.

Products from Klaviyo-confirmed sent campaigns are excluded for 28 days and receive a diminishing score penalty until day 56. Unsent drafts do not start cooldown. Product links use the campaign code and slot/product identifiers in `utm_campaign` and `utm_content`. Results sync stores Klaviyo engagement and GA4 campaign revenue snapshots independently, so one failed integration can be retried without losing the other source.

Marketing, Merchandising, and Admin users can build campaigns, create Klaviyo drafts, and refresh results. Other active users have read-only campaign history and performance access.

## Frontend Behaviour Principles

- Pages are operational tools, not landing pages.
- Existing pages use static HTML and inline scripts; keep that approach unless there is a deliberate migration.
- Shared styling belongs in `public/design-system.css` when it applies across tools.
- Preserve same-origin API behaviour for deployed use.
- When adding large calculations, prefer server-side persistence/calculation if multiple tools need the result.
- Keep user-facing failure states clear: missing credentials, unavailable Shopify scopes, missing saved periods, invalid dates, and upload limits should produce actionable messages.

## Date And Range Rules

- API date inputs use `YYYY-MM-DD`.
- Report date ranges are inclusive.
- Server range parsing guards against invalid dates and overly broad ranges.
- Bestsellers weekly buckets use Monday-based canonical weeks.
- UI labels use UK-style dates where displayed to users.

## Security And Safety

- Use shared-password plus Google Workspace auth for hosted production access: the shared password is the outer gate, Google provides named user identity and roles. Keep shared-password-only auth as an explicit fallback with `AUTH_MODE=basic`.
- Google auth uses HttpOnly session cookies and CSRF checks for write APIs.
- Uploaded files under `/uploads/*` are protected by the same auth layer as pages and APIs.
- Do not commit `.env`, SQLite databases, uploads, or secrets.
- File upload paths must remain inside `UPLOADS_DIR`.
- Keep upload size limits in place unless storage/backups have been reconsidered.
- Be careful with endpoints that write `.env`, apply Shopify reorder changes, delete orders, delete invoices, or delete issued SKUs.
- API JSON responses should avoid exposing server filesystem paths or secrets.

## Change Rules For Future Work

Update this file when changing any of the following:

- A page's ownership or core user workflow.
- API endpoint names, request shapes, or response shapes.
- Database schema, migrations, or canonical data ownership.
- SKU/order/invoice/workflow status logic.
- Bestsellers, stock, forecast, GP, cover, or weekly action calculations.
- Shopify or GA4 credential requirements.
- Upload storage paths, file limits, or backup requirements.
- Deployment/runtime assumptions.

When the implementation and this spec disagree, treat the code as current truth, then update this spec in the same change.

## Open Product Questions

- Should uploaded report files be stored centrally so every team member sees the same report history without re-uploading?
- Should `server.js` be split into route/service modules as the app grows?
- Should bestsellers calculations move toward reusable server-side modules instead of page-level inline scripts?
- Should order workflow actors eventually map to real users rather than free-text names?
- Should Shopify reorder apply support dry-run exports and approvals before writing to Shopify?
