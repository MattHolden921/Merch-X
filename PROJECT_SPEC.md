# Merch X Project Spec

Last reviewed: 2026-07-13

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
- `public/orders.html`: order workspace, approval/payment/intake workflow, supplier batches, received actuals, discrepancies/credits, supplier credit balances, invoices, notes, archive/delete, read-only order-line Shopify live/New Arrivals checks, printable warehouse image reports, and barcode label-job reports for printers and suppliers.
- `public/order-reports.html`: read-only operational reports for arrivals, intake exceptions, next actions, finance, supplier performance, buying mix, and data quality.
- `public/supplier-report.html`: supplier-led workbench for top-down review of one supplier's orders, products, receipt actuals, discrepancies, and credit exposure.
- `public/pnl.html`: finance P&L planner using live Shopify actuals, saved cost rules, manual marketing spend, and driver-based profit scenarios.
- `public/sku-register.html`: local SKU register and safe deletion of unused issued SKUs.
- `public/products.html`: product and supplier master-data workspace, local SKU enrichment, readiness review, and Shopify draft push workflow.
- `public/merchandising.html`: Shopify product merchandising view using product, order, and optional GA4 metrics.
- `public/new-in-performance.html`: launch and image-refresh performance report for recent New In products, draft pipeline rows, image-change impact comparisons, marketing actions, share links, and CSV export.
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
- Order management: `order_workflows`, `order_events`, `order_invoices`, supplier batches, batch-line receipt actuals in `order_receipt_lines`, discrepancy/credit resolution rows in `order_discrepancies`, PAH carrier defaults in `app_settings`, and immutable `order_label_jobs` report snapshots.
- Collection reorder: completed apply history in `collection_reorder_audit` and durable job state in `collection_reorder_jobs`. Audit rows retain the actor plus baseline and final order hashes.
- Reporting: `report_sources`, `report_periods`, `report_product_metrics`, `report_stock_snapshots`, `report_sync_jobs`, `report_snapshots`.
- Weekly actions: `weekly_actions`, `weekly_action_events`.
- Sale planner: `sale_plans`, `sale_plan_items`, `sale_plan_events`, the variant restoration ledger in `sale_state_ledger`, markdown outcomes/actions, durable `sale_planner_jobs` and `sale_planner_job_items`, plus Sale collection mapping stored in `app_settings.salePlannerCollections`.
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
- `COLLECTION_PLANNER_CACHE_MINUTES`, defaulting to 5 minutes for collection, Shopify order-metric, and GA4 metric reads used by the collection planner.

Used for:

- Product and variant lookups by SKU.
- Read-only order-line checks by SKU for Shopify `ACTIVE`/local Live state and the exact `Collection: New Arrivals` tag.
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
- `GET /api/suppliers/report`
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
- `POST /api/orders/receipts`
- `POST /api/orders/discrepancies`
- `POST /api/orders/archive`
- `POST /api/orders/delete`
- `POST /api/orders/events`
- `POST /api/orders/label-jobs`
- `GET /api/orders/products/live-new-arrivals`
- `GET /api/orders/pah`
- `POST /api/orders/pah-settings`

Shopify and Google:

- `GET /api/shopify-merchandising`
- `GET /api/new-in-performance`
- `GET /api/shopify-collection-planner`
- `POST /api/shopify-collection-reorder/start`
- `GET /api/shopify-collection-reorder/status`
- `GET /api/sale-planner`
- `POST /api/sale-planner/import`
- `POST /api/sale-planner/items/update`
- `POST /api/sale-planner/items/remove`
- `POST /api/sale-planner/config`
- `POST /api/sale-planner/collections/refresh`
- `POST /api/sale-planner/plans/save`
- `POST /api/sale-planner/preflight`
- `POST /api/sale-planner/reconcile`
- `POST /api/sale-planner/apply/start`
- `GET /api/sale-planner/apply/status`
- `POST /api/sale-planner/jobs/resume`
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
- Orders are saved to SQLite as JSON payloads plus indexed top-level fields. Each order line stores colour, colour code, and material as separate values; `colour` remains the primary colour field used by downstream product and Shopify workflows.
- Saving an order also updates supplier/product helper records and syncs workflow status defaults.

### Order Pricing

- The order form's five-times RRP is `unit cost GBP × 5`. The result is the intended customer-facing RRP; do not add VAT to that result again.
- The 65% exit retail remains `(unit cost GBP / 0.35) × 1.2`.
- Supplier cost, supplier total, payment amount, and invoice reconciliation use the ordered line cost (`quantity × unit cost GBP`) without a VAT uplift. Retail-pricing calculations must not change the supplier amount used for invoice matching.
- `scripts/fix-order-rrp-vat-regression.js` audits the June 2026 `× 5 × 1.2` regression. It defaults to dry-run, creates a SQLite backup before `--apply`, repairs only the exact generated 6× fingerprint in order snapshots and matching local product records, and skips Shopify-linked products for manual review.

### Product And Supplier Master Data

- Merch X is the source of truth for pre-launch product records.
- Products are still keyed by SKU, with indexed columns for supplier, product type, season, price, cost, Shopify IDs, product status, and sync status while retaining JSON `data` for flexible fields.
- Supported product statuses are `Draft`, `Ready for Shopify`, `Shopify draft`, `Live`, and `Archived`.
- Supported product sync statuses are `Not synced`, `Ready`, `Synced draft`, `Conflict`, and `Error`.
- Readiness checks block Shopify draft push when SKU, supplier, title/style, RRP, product type, image, cost, or local SKU uniqueness is missing.
- SKU lookup from the order form prefers the local product master first, then falls back to live Shopify lookup.
- Saving an order enriches supplier/product master records with last-order metadata and non-empty line details without wiping curated master-data fields. Colour, colour code, and material remain separate on the product master record.
- Supplier master records expose a derived `creditBalance` from outstanding credit-note discrepancy rows, so open supplier credits follow the supplier into supplier lists and new order creation.
- `product_sync_events` records local save/archive and Shopify preview/push/status actions with actor, result, payload summary, Shopify product ID, and errors.

### Shopify Product Draft Push

- Only products marked `Ready for Shopify` and passing readiness checks can be pushed.
- Product pushes use Shopify Admin GraphQL `productSet` with `status: DRAFT`.
- New draft pushes keep the primary order/product `colour` value in the existing Shopify product-level swatch and variant-colour metafields and also write it to the Shopify variant metafield `custom.colour`. `Size` remains the only Shopify variant option; colour must not create a separate variant dimension. The buying code is written to the product metafield `custom.buying_code`. These mappings apply only when creating new drafts; no backfill or repair is performed for products already pushed.
- Local uploaded product images are sent through Shopify staged uploads before being referenced by the product payload.
- Successful pushes store Shopify product and variant GIDs, set local status to `Shopify draft`, and set sync status to `Synced draft`.
- Failed pushes keep the product local, set sync status to `Error`, and write a sync event.
- Inventory quantity writes are intentionally out of scope for v1.

### Order Workflow

Order workflow is split into approval, payment, and intake sections. The composite order status is derived from workflow values, supplier batch state, receipt actuals, and the stored order status.

Important principles:

- Workflow updates should record events.
- In Google auth mode, workflow actors come from the signed-in user, not browser-supplied free text.
- Next-action handoff can target a role owner and an optional active user assignee.
- Handoffs create work handoff records and in-app notifications. Order handoff email is sent immediately when SMTP is configured; Weekly Action email is grouped into a per-user digest after the configured delay.
- Buyers can upload invoice documents and invoice metadata. Finance/Admin retain control of payment-facing invoice state such as sent-to-FD and paid.
- Invoice changes can update payment workflow.
- Archiving hides orders from active creation/bootstrap views but preserves history.
- Completed warehouse intake moves the order-level intake workflow to `Review after delivery`. Merchandising should complete receipt/discrepancy checks there, then move the intake status to `Received`; only `Received`, cancelled, or rejected orders can be archived. Supplier batches still use `Received` to represent the factual delivery booking.
- The Orders workspace status filter always offers `Review after delivery` so Merchandising can find orders waiting for post-delivery review, even if the current view would otherwise build status options only from loaded orders.
- Deleting an order should remove related invoice records/files and workflow data only through the server's delete logic.
- The Orders workspace can print a warehouse-facing image report for the full order, a selected delivery batch, or remaining unbatched units. The report contains product image, SKU, buying code, separate colour, colour code, material, and quantity fields only; batch reports use allocated quantities and unbatched reports use ordered quantity less all allocations.
- The Orders workspace order-line table has a read-only Shopify check for Buyer, Merchandising, and Admin users. `GET /api/orders/products/live-new-arrivals` looks up each order-line SKU in Shopify and returns a transient Y/N flag for whether the Shopify product is `ACTIVE` and has the exact tag `Collection: New Arrivals`. This check must not update local product records, order data, workflow state, or order events. When the check has been run, order-line Excel exports include the Y/N flag, live status, New Arrivals tag status, Shopify status, detail message, admin URL, and check time.

### Receipt Actuals And Supplier Discrepancies

- Supplier batches remain the expected-delivery unit for warehouse intake. Each batch can be received through a line-level actuals table showing expected, received, damaged, accepted, short, and over quantities by order line/SKU.
- The Receive actuals editor can import a warehouse receipt workbook/CSV such as the Europe Logistics pre-advice report. The browser reads the first sheet, discovers columns by header labels rather than fixed positions, requires SKU and Qty Received, optionally uses Pre-Advice ID, Qty Due, damaged, accepted, and notes columns, matches rows to the selected batch/full-order lines by normalized SKU, and treats blank Qty Received cells on SKU rows as zero received. The import fills the editable receipt table for review; users still save actuals through `POST /api/orders/receipts`.
- Receipt actuals are cumulative per batch line and stored in `order_receipt_lines`. Existing orders without line actuals retain legacy behaviour where a batch marked `Received` counts its full batch quantity as received.
- If an order has no supplier batches, Merchandising can use Receive full order; the server creates a full-order batch from remaining order-line quantities before saving actuals.
- Saving receipt actuals creates or updates open discrepancy rows in `order_discrepancies` for shortages, damage, and overages. Receipt-line notes seed new discrepancy notes, and existing open discrepancy notes are only filled from receipt notes when still blank. When a corrected receipt removes a variance, the open discrepancy is resolved with `corrected_receipt`; already resolved historical rows are preserved.
- Supported discrepancy statuses are `Open`, `Credit requested`, `Credit received`, `Replacement expected`, `Replacement received`, `Accepted variance`, `Written off`, and `Resolved`. Supported resolution types are `credit_note`, `replacement`, `accepted_variance`, `write_off`, and `corrected_receipt`.
- Supplier credit balances are calculated from discrepancies where the resolution type is `credit_note` or the status is `Credit requested`/`Credit received`. Non-terminal credit rows count as credit due; `Credit received` counts as received credit; `Written off`, `Accepted variance`, `Replacement received`, and `Resolved` remove the row from the open supplier balance while preserving audit history.
- Merchandising/Admin users can save receipt actuals and operational discrepancy resolutions. Finance/Admin users can link credit notes and mark supplier credits received or written off.
- Receipt and discrepancy changes write order events and can drive next-action prompts for unresolved receipt variances, supplier credit due, credit notes due, and replacements due. Once an order is approved, an outstanding supplier credit balance can prompt Finance to apply supplier credit to the next invoice.

### PAH Delivery Reports

- The Orders workspace exports the freight forwarder's 20-column PAH CSV contract in one click for a full order, a selected supplier batch, or remaining unbatched units.
- Product description, SKU, primary colour, and quantities come from the saved order. The fixed PAH contract does not add separate colour-code or material columns. A batch export uses only that batch's line allocations and its warehouse ETA; an unbatched export subtracts all existing allocations.
- Full-order and unbatched exports use the workflow warehouse ETA when available, then the order's required delivery date. Export is blocked when no valid ETA/date, no scoped units, a SKU, or a whole-unit quantity is missing.
- Batch pre-advice IDs append the saved batch number/title to the PO number so separate deliveries cannot overwrite one another at the warehouse. The CSV filename uses the same reference.
- Pre-advice type, warehouse supplier ID, carrier/contact details, warehouse address, country, and return flag are stored as editable JSON under the SQLite `app_settings.pahCarrier` key. Initial values match the current Europe Logistics / Rebecca Bird workflow; report generation reads the persisted setting rather than inline UI values.
- Buyer, Merchandising, and Admin roles can export PAH files and edit the shared PAH defaults. Every supplier-batch row also has a direct PAH CSV action.

### Order Reports

- Order reports combine workflow, batch, invoice, receipt, and discrepancy data into operational views for arrivals, exceptions, next actions, finance, supplier performance, buying mix, and data quality.
- The Arrivals report includes open dated order/batch portions inside the selected inclusive date range, including past dates. Its dated and missing-date scopes stay synchronized with the active report tab, and the page reloads report data when it becomes visible again so changes made in another browser tab are reflected.
- Actuals fields include ordered/expected units, received units, accepted units, damaged units, short units, over units, fill rate, variance value, open credit value, and credit received.
- The Supplier Performance tab summarizes fill rate, on-time rate, shortage/damage units, open discrepancies, supplier credit due/received, outstanding balances, and late/open batches by supplier.
- Data quality flags include received batches without line actuals, batches without line allocations, credit notes not linked to discrepancies, open discrepancies without a resolution, invoice-without-batch rows, unbatched units, missing dates, missing FX, and missing product links.

### Supplier Report

- The Supplier Report is a supplier-led reconciliation workbench. It starts from one supplier and returns order summaries, product rows, line-level receipt/batch rows, and discrepancy/credit rows from existing order, product, supplier, invoice, batch, receipt, and discrepancy data.
- `GET /api/suppliers/report` accepts `supplier`, `supplierName`, or `supplierId` plus optional `includeArchived`. It returns the supplier selector list, selected supplier summary, metrics, and table payloads for `orders`, `products`, `discrepancies`, and `receipts`.
- Product rows include supplier master products and any order-line products found on that supplier's orders, so unsynced or not-yet-mastered SKUs still appear during reconciliation.
- Supplier Report tables include footer totals for meaningful additive fields, and those totals follow the current table search/filter state.
- Discrepancy rows remain actioned through the Orders workspace. Supplier Report rows deep-link back to `orders.html?id=...` rather than duplicating receipt, discrepancy, invoice, or workflow editing.
- The page is reachable from the tool hub, the Supplier Performance report, and the Products & suppliers supplier workspace.

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
- Credit notes are first-class finance documents on `order_invoices` using `document_kind = credit_note`. Users enter credit-note amounts as positive values; summaries expose them as signed credits so they reduce net invoiced value rather than inflating supplier charges.
- Credit notes can be linked to receipt discrepancy rows. Linked credit notes move the discrepancy to credit requested or credit received depending on payment/received state.
- Invoice summaries expose gross invoices, credit-note totals, net invoiced, paid supplier invoices, supplier credit due, and outstanding payable balances.
- Supplier-level credit due is not a manually edited accounting ledger. It is derived from unresolved credit-note discrepancies and exposed as `supplierCredit` on managed order responses and `creditBalance` on supplier responses. Buyers see it when selecting a supplier for a new purchase order; Finance sees it in the order invoice panel and should apply it as a reduction on the next supplier invoice.

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
- Shopify API sync stores only completed Monday-Sunday weeks. Current-week, future-week, and otherwise incomplete ranges are shown live and not written to the saved-period cache until the week has ended.
- Shopify weeks saved before their end date, against another configured Shopify store, or with an older financial-formula version are treated as needing refresh and blocked from weekly-action generation until Shopify is synced again.
- Saved Shopify selectors expose canonical Monday-Sunday weeks only. Last 2/4/8 completed-week presets work even when one or more weeks are missing or stale: loading the range automatically starts a Shopify sync to fill and replace those weeks before displaying the combined report. Older weeks across a gap remain individually selectable.
- Bestsellers dates are validated as real calendar dates. Partial, reversed, impossible, and overlong ranges are rejected instead of silently falling back to a default period.
- ShopifyQL `FROM sales` grouped by product title and variant SKU is the primary product-sales source for Bestsellers and New In, matching P&L's dated ledger treatment of discounts and sales reversals. New In image-impact daily windows use the same ledger grouped by day. The order API remains a guarded fallback; if neither source can be read, a Bestsellers sync fails closed so an incomplete fetch cannot replace a valid saved week.
- Duplicate sync requests for the same range reuse the active job. Jobs left queued/running by a restart are marked interrupted on startup; completed result payloads are cleared after 14 days and completed/error jobs are removed after 90 days.
- Shopify product connections currently read up to 100 variants. Products beyond that limit remain visible but are flagged through report data-quality metadata because their stock/current-cost values may be incomplete.

Shopify financial semantics:

- `lib/commerce-finance.js` is the shared code source of truth for Bestsellers, New In, and P&L financial formulas. `AGENTS.md` requires commerce-report work to reuse it rather than reimplementing formulas in routes or pages.
- ShopifyQL supplies gross and net product sales excluding VAT. Bestsellers and New In convert those canonical ledger values to VAT-inclusive customer sales for every visible merchandising sales figure, including totals, ASP, sales per week/day, comparisons, and exports. Their payloads retain explicit ex-VAT fields so cached weeks from either storage convention can be combined safely and reconciled to P&L. P&L continues to expose its accounting sales bridge and profit calculations on the ex-VAT ledger basis described below.
- Each saved Shopify Bestsellers week also caches the P&L-aligned sales-bridge components and Demand/Despatch totals from ShopifyQL. Demand is sales including VAT after discounts and before returns; Despatch maps to ShopifyQL `total_sales`. For a multi-week selection, Despatch is additive and Demand is recomputed from the combined raw bridge components through the same shared formula as P&L, avoiding VAT-rate or rounding drift from summing independently calculated weekly Demand. Period pills use the corresponding selected components. The cards remain loaded-range trading totals rather than category/search-filtered product subtotals. Weeks without the current trading-metrics version are refreshed before use instead of relabelling gross or net product sales as approximations.
- GP is Shopify net sales ex VAT less Shopify cost of goods sold; GP% is GP divided by net sales ex VAT even when the adjacent merchandising sales value is displayed including VAT. ShopifyQL-backed weeks use Shopify's reported GP/COGS. The order-API fallback derives ex-VAT achieved revenue and current variant costs and identifies itself in data-quality metadata.
- Stock cost and retail values are extended from the current variants rather than multiplying all stock by a product average/minimum. Stock views expose cost coverage and calculate margin against retail excluding VAT.
- Cached Shopify periods carry the configured store key and financial-formula version. Legacy, cross-store, and old-formula periods are refreshed before use instead of being silently combined with current live data.
- Gift cards are excluded from synced products, stock totals, decision metrics, and Weekly Action candidates.

Decision and UI semantics:

- The main Bestsellers table calculates Sales/week, weekly units, cover, and forecast buy from the active loaded range, so loading two weeks produces a two-week weekly average and narrowing period pills recalculates it. Server decision metadata and Weekly Actions may still use the newest completed week for short-term prompts.
- Revenue Analysis projects two forward periods, each matching the decision period's duration; labels show that actual horizon. Forecast buy still uses the configured eight-week coverage horizon unless a page workflow explicitly supplies another season-end horizon.
- The main Bestsellers table defaults to sold, active products. Users can search, include all active stocked/sold products, paginate at 25/50/100/200 rows, or explicitly load all matching products; visible totals respect those filters. Draft, archived, and gift-card products are excluded from the main decision view.
- Slow Sellers consumes the server report's active-product dead-stock rows, so synced reports do not require a separate inventory upload to show stocked products with no sales. Large sales-drop/dead-stock result sets render 100 rows per page while totals continue to cover the full active filter.
- CSV imports use a supplied product ID/handle as the aggregation key and fall back to title only when the export does not contain a stable product identifier.

Key calculated fields include weekly units, average price, gross and net sales, known GP and cost coverage, GP percent, GP per unit, cover weeks, forecast buy, dead stock, stock value, and category/season summaries.

### Stock Snapshots

Stock snapshot rows represent Shopify variant-level inventory and pricing at a point in time. They support stock position, markdown state, and SKU/product status filters.

### Weekly Actions

Weekly actions are generated from saved canonical Monday-Sunday Shopify bestsellers periods. Only active, non-gift-card Shopify products are eligible. Candidate action types:

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
- Plans can be created, renamed, duplicated, given a review date, and archived once they have no live Applied rows. Users submit an editable plan for approval; an Admin approves a SHA-256 snapshot of its items, variant targets, and collection targets. Any later item, import, removal, or propagated mapping edit invalidates that approval. Shopify apply requires the current plan to match its approved snapshot.
- Products can be imported from Weekly Actions or Product Merchandising. Importing Weekly Action rows sets open markdown actions to `In progress` and records a weekly action event.
- Non-applied rows can be removed from the planner without changing Shopify. Applied rows must use the remove-from-sale workflow first, preserving the audit trail and stored collection targets.
- Suggested markdowns use a risk ladder of 10%, 20%, 30%, 40%, and 50%. The score considers stock, cover weeks, sell-through, weak sales, stock value, age, season, existing markdown state, and failed/deeper markdown signals.
- Sale prices round to the nearest pound by default. Existing markdowns use `compareAtPrice` as the original price and only recommend the same or a deeper markdown step.
- Multi-variant products receive the same discount percentage per variant, calculated from each variant's own original/current price. Manual target-price edits update every stored variant target so Shopify receives the visible plan price. The planner shows requested and effective variant markdowns plus target GP% using `(((retail price / 1.2) - cost price) / (retail price / 1.2))`, with the row value using the lowest variant GP%. Missing cost is visible; by default cost is required at 40%+ markdown (`SALE_PLANNER_REQUIRE_COST_AT_DISCOUNT`) and target GP cannot fall below `SALE_PLANNER_MIN_GP_PCT`, defaulting to 0%.
- Apply preflight blocks incompatible row states, missing Shopify/variant/original-price data, zero or above-RRP targets, no live stock, inactive/unpublished products, gift cards, missing root Sale collection, unapproved snapshots, and stale Shopify price state. Child collection gaps and lower-risk missing costs remain visible warnings. Apply accepts only Planned/Error rows and removal accepts only Applied rows.
- Sale collection mapping auto-detects the root `Sale` collection and child collections such as `Sale Tops`; Admin users can save overrides in `app_settings.salePlannerCollections`. Shopify collections are cached for 15 minutes by default (`SALE_PLANNER_COLLECTION_CACHE_MINUTES`), the page receives only relevant Sale candidates plus saved selections, and saving a mapping propagates it to editable rows while leaving Applied rows' removal targets unchanged.
- Applying sale state preflights the live Shopify product and blocks stale plans when planned variant prices no longer match Shopify. Successful applies update variant `price` and `compareAtPrice`, then add the product to the root Sale collection and mapped child Sale collection.
- Applying sale state also writes Shopify `custom.product_status` to `S`. Removing sale state writes it back to `N`.
- Sale state keeps a local variant-level ledger of the first true RRP, so incremental markdowns and final restore actions use the original RRP rather than a previous markdown price.
- Removing sale state restores each variant to the ledger RRP, falling back to live `compareAtPrice`, clears `compareAtPrice`, and removes the product from the stored root/child Sale collections. If no restore price exists, the current price is left unchanged and a warning is recorded.
- Sale analysis compares equal numbers of non-overlapping completed Monday-Sunday pre/post reports, including sell-through and GA CVR, and stores outcomes as `worked`, `watch`, `deepen`, or `remove` with comparable-week confidence. Only medium/high-confidence outcomes train future markdown steps, and learning requires multiple corroborating successes/failures for the same product type/season.
- Analysis refresh also creates a persistent action queue for the small number of changed recommendations from a large sale plan. Queue actions include deeper markdowns, sale removals, and low-view markdowns where poor performance may be an exposure issue rather than a price issue.
- Users can mark analysis actions as `Pending`, `Accepted`, `Ignored`, `Snoozed`, or `Applied`. Selected deepen/remove actions can create a follow-up sale plan containing only those products, so Admin users can apply the existing Shopify job workflow without re-reviewing the full original sale list.
- Apply and remove jobs preflight the complete selection before the first Shopify mutation. Jobs and item-level price/collection/metafield checkpoints are durable in SQLite; partial failures can be resumed idempotently after a server restart. Item results and plan events retain the audit trail. A read-only reconciliation action compares Applied rows with live variant prices, compare-at prices, Sale collection membership, and `custom.product_status`.
- The planner keeps the primary product review ahead of analysis, uses one searchable Sale-collection datalist, exposes filtered/selected retail and GP totals, provides mobile product cards and variant detail, and offers a downloadable CSV of the immutable preflight diff. Analysis/action areas become compact when no comparable outcome data exists.

### P&L Planner

The P&L Planner is a Finance-led profit workspace. Admin and Finance users can edit cost rules and marketing spend. Buying Director users can view actuals and run scenarios.

Key principles:

- ShopifyQL sales reports are the source for P&L actuals. Date ranges are inclusive and capped at 92 days.
- Primary P&L sales views are Despatch and Demand. Despatch maps to ShopifyQL `total_sales`. Demand is derived as product sales inc VAT, after discounts, before returns: `(gross_sales - absolute_discounts) * (1 + effective VAT rate)`. ShopifyQL `gross_sales` remains visible only as gross sales ex VAT before discounts and returns. Discounts, returns, shipping, net sales, and taxes are shown as separate sales-bridge boxes because they materially explain the movement from Demand to Despatch. Net sales remains the ex-VAT product revenue used for gross-profit and net-profit calculations. Gross profit % is shown using the merchandising/reporting convention: for an inc-VAT retail value, `((retail value / 1.2) - cost) / (retail value / 1.2)`. In the P&L planner this is equivalent to `(net sales ex VAT - COGS) / net sales ex VAT`. Net profit is the pound operating-profit value after COGS, marketing, variable costs, and fixed overheads; Net profit % is `net profit / net sales ex VAT`.
- AOV is Despatch divided by ShopifyQL order count.
- P&L actual COGS and gross profit use ShopifyQL's dated `cost_of_goods_sold` and `gross_profit` values for the selected sales range. The planner preserves those reported figures through statement construction rather than rebuilding GP from current variant costs.
- Reusable cost rules support `fixed_monthly`, `per_order`, `per_item`, `pick_pack`, `percent_revenue`, and `percent_revenue_plus_per_order` for card/payment fees that combine a Despatch percentage with a fixed per-order fee. Fixed monthly costs are prorated by overlapping days in each calendar month. Variable rules are prorated by active-date overlap before applying the selected range's Despatch, orders, or units.
- Variable costs are shown separately from product COGS and fixed monthly overheads. Total variable costs include all non-fixed cost rules, including fulfilment, postage, pick/pack, per-item costs, and card/payment fees. Variable cost per order is total variable costs divided by orders. Fixed monthly costs are separately exposed as fixed cost total, fixed cost per order, and fixed cost drag (`fixed monthly costs / net sales ex VAT`). Contribution before fixed costs is `gross profit - marketing spend - variable costs`, with contribution % using net sales ex VAT as the denominator. The scenario detail table can also show order-driven and revenue-driven portions for diagnosis.
- Pick and pack costs are calculated as first-item rate per order plus additional-item rate for units above one per order.
- Marketing spend is stored as dated channel entries such as Google, Meta, Klaviyo, TikTok, Affiliate, or Other. Manual entries remain available for adjustments. Google and Meta can also be synced from Windsor.ai: API requests are account-scoped to Kit and Kaboodal by default, exact IDs are sent through connector account parameters, raw campaign/day spend is stored in `pnl_marketing_spend_actuals`, then rolled up into daily `pnl_marketing_spend` entries marked `source = windsor`. `pnl_windsor_sync_runs` records started, success, and error attempts so page loads can auto-sync missing coverage without spamming Windsor. Entries are prorated by date overlap with the selected P&L range.
- The period control defaults to the last completed Monday-Sunday week. Changing either date switches the control to Custom, and Shopify actuals are fetched only when the user clicks Load actuals.
- Scenarios are not saved in v1. They recalculate from loaded actuals using either a manual daily Despatch target or a marketing-driven sales model. Marketing spend only creates incremental Despatch when the marketing-driven mode is enabled; otherwise it is treated as a cost change only. In marketing-driven mode the Daily Despatch slider represents the final linked daily target, so changing marketing spend/ROAS moves the daily target and the server does not add the uplift a second time. The default blended marketing return remains Shopify-calibrated (`Despatch / marketing spend` unless edited), while Windsor platform revenue splits that return across Google and Meta using configurable confidence weights. Scenario users can override Google and Meta spend and ROAS independently; channel ROAS sliders default to the channel platform ROAS from Windsor where available, falling back to the calibrated forecast return. Scenario KPI cards and driver sliders show actual values as secondary context. Users can reset drivers back to the loaded actuals, and can add named temporary scenario snapshots to an in-page comparison table; these comparison scenarios are cleared when a new actual period is loaded and are not persisted to SQLite. This means Google/Meta platform attribution can shape the forecast without adding revenue on top of Shopify actuals. Extreme channel platform scores are sanity-capped before calibration so a noisy attribution field cannot dominate the channel split. AOV delta, optional Gross profit % override, and items per order then reshape orders, units, COGS, and variable costs. Fixed costs remain fixed/prorated; variable costs recalculate from scenario sales, orders, and units. The planner also calculates the incremental break-even marketing ROAS from Gross profit %, COGS, AOV, items/order, and variable cost rules; this is the minimum Despatch return required for extra marketing spend to avoid reducing net profit. The scenario response includes an operating-leverage view that calculates the selected scenario's fixed-cost drag, contribution before fixed costs, breakeven daily Despatch, and the daily Despatch where fixed monthly overhead falls below the low-drag threshold, defaulting to 5% of net sales ex VAT. Sensitivity and leverage tables/charts show net-profit impact for daily Despatch, AOV, marketing-spend changes, and fixed-cost dilution.
- Scenario outputs are decision-support estimates, not posted accounting entries.

### Collection Reorder Planner

The collection planner fetches Shopify collections/products, ranks products according to the selected strategy, previews movement, and can apply a new order through a durable background reorder job.

Ranking logic:

- Products are ranked across the complete loaded collection before search or movement filters are applied, so typing a search never changes a product's suggested global position. The table renders at most 500 matching rows and the visual plan at most 200 cards for browser performance; CSV export and Shopify Apply continue to use the complete plan.
- Strategy signals use percentile/log caps so one extreme seller does not flatten the rest of a collection. A small current-position stability weight reduces low-value churn. Best Sellers uses net sales, net units, gross-profit contribution, stock and margin; New Arrivals also uses units per live day; Clearance uses weeks cover, sell-through, weak sales and sale tags; High Margin prioritises ex-VAT gross-profit contribution and GP%.
- Conversion Lift and Gold Dust use GA4 ecommerce purchases divided by GA4 item views, with smoothing and view-count confidence. These strategies are disabled when GA4 data is unavailable rather than silently ranking on zero metrics.
- Only active, Online Store-published, in-stock products are ranking-eligible. Draft/archived, unpublished, and out-of-stock products keep their current relative order below eligible products.
- Colourway grouping uses the Shopify product metafield `custom.buying_code` first. Because legacy products commonly lack that value, a conservative fallback removes a recognised trailing colour phrase from the title and combines the remaining title with product type. Only products in the same resolved style group and with reasonably close scores are paired; unrelated single styles are never paired merely to fill a two-product block.
- Shopify order inputs exclude cancelled, test, and voided orders and use current quantity plus prorated discounted revenue to account for returns. The sales date window is inclusive. Product GP% is calculated ex VAT per costed variant as `((price / 1.2) - cost) / (price / 1.2)` and the product uses the lowest available variant GP% so missing or mixed variant economics are not overstated.
- Missing margins are visible and receive no margin-score credit. If Shopify order metrics fail, the planner remains inspectable but marks sales-based rankings incomplete and blocks Apply until a clean sync.

Guardrails:

- Applying a reorder is Admin-only, requires explicit typed confirmation, a full exact collection sync, no product-count warning, and a SHA-256 baseline of the synced Shopify order. The job reloads Shopify immediately before mutation and rejects a stale plan when the live baseline differs.
- Manual Lift can stage products whose Shopify featured image media was recently updated, optionally constrained by current collection position, then sends explicit Shopify move inputs for the selected products only, preserving the relative order of everything else. Product-level `updatedAt` is shown for audit but is not used for image lifting.
- The default Manual Lift shortcut uses `Images 3d` and `From #9`, preserving the first two four-product visual rows before staging recently updated imagery.
- Reorder jobs and progress checkpoints are stored in `collection_reorder_jobs` and polled until complete/error. If the server restarts during a running job, the recovered job is marked interrupted and the user must sync to reconcile Shopify before applying again.
- Shopify is re-read after every completed plan; the live final order hash must match the approved target before the job is marked complete. Failed or interrupted attempts keep Apply locked until a new sync.
- Successful, verified applies are written to `collection_reorder_audit` with actor identity, strategy/scope, counts, and baseline/target order hashes.
- The user syncs collections after apply to load the verified live order as the next baseline.

### New In Performance

The New In Performance report is a read-only Marketing/Merchandising handoff view for products that are newly live, recently re-shot/re-imaged, or still in the draft pipeline.

Key principles:

- `GET /api/new-in-performance` reuses the Shopify merchandising product, order, stock, cost, and GA4 merge path, then filters into launch/image cohorts server-side.
- New launch detection uses Shopify `publishedAt` first, falling back to `createdAt` only for active products without a publish timestamp. This avoids counting products as New In simply because a draft was created weeks before it went live.
- Updated-image detection uses the Shopify featured media image `updatedAt`/`createdAt` timestamp exposed as `imageUpdatedAt`, matching the collection planner's Manual Lift image-date logic.
- Draft pipeline rows are included when a Shopify product is still `DRAFT` and was created within the selected launch window; they show no live-day performance until published.
- The page exposes separate sales, launch, and image-update date windows. It can filter by cohort, status, supplier, product type, action, and search term. Supplier comes from the Shopify product metafield `custom.supplier`; supplier filtering also updates the visible summary metrics and browser-side CSV export.
- Updated-image rows include an image-impact comparison when daily order metrics are available. The comparison splits on the featured media image date, compares the selected `impactDays` window before the image change with the available post-change window, and normalises sales, units, views, and add-to-cart metrics by days so partial recent windows remain comparable.
- GA4 daily item metrics are merged into image impact when available, so pre/post CVR can be compared; Shopify order metrics remain the sales source when GA4 is unavailable.
- Marketing actions are advisory labels derived from stock, sales velocity, GA4 views/CVR, and cohort state: Push, Needs exposure, Image test, Content check, Stock watch, Sold out, Draft pipeline, or Watch.
- CSV export is browser-side from the current filtered view and includes product URLs, image URLs, SKU, cohort, action, launch/image dates, sales, stock, GP, GA4 metrics, and pre/post image-impact fields.

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
- Should order workflow actors eventually map to real users rather than free-text names?
- Should Shopify reorder apply support dry-run exports and approvals before writing to Shopify?
