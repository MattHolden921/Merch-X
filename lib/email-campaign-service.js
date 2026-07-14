"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const { eligibility, productKey, recommendProducts, trackedProductUrl } = require("./email-merchandising");

function safe(value, fallback = "campaign") { return String(value || "").trim().replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase() || fallback; }
function html(value) { return String(value || "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char])); }
function json(value, fallback = {}) { try { return value ? JSON.parse(value) : fallback; } catch { return fallback; } }
function isoDate(value = new Date()) { return new Date(value).toISOString().slice(0, 10); }

function createEmailCampaignService(deps) {
  const { openDb, requestJson, fetchProducts, googleAccessToken, gaConfig, actorName } = deps;
  const merchandisingCacheKey = "email_merchandising:weekly";
  function config() {
    return {
      privateApiKey: String(process.env.KLAVIYO_PRIVATE_API_KEY || "").trim(),
      apiRevision: String(process.env.KLAVIYO_API_REVISION || "2026-04-15").trim(),
      baseTemplateId: String(process.env.KLAVIYO_BASE_TEMPLATE_ID || "").trim(),
      baseTemplatePath: String(process.env.KLAVIYO_BASE_TEMPLATE_PATH || "").trim(),
      defaultAudienceId: String(process.env.KLAVIYO_DEFAULT_AUDIENCE_ID || "").trim(),
      storefrontUrl: String(process.env.STOREFRONT_URL || "").trim().replace(/\/$/, ""),
      conversionMetricId: String(process.env.KLAVIYO_CONVERSION_METRIC_ID || "").trim()
    };
  }
  function history() {
    const rows = openDb().prepare(`SELECT ecp.product_key productKey, MAX(ec.sent_at) lastFeaturedAt FROM email_campaign_products ecp JOIN email_campaigns ec ON ec.id=ecp.campaign_id WHERE ec.sent_at IS NOT NULL GROUP BY ecp.product_key`).all();
    return Object.fromEntries(rows.map(row => [String(row.productKey), row.lastFeaturedAt]));
  }
  function cacheRow() {
    return openDb().prepare("SELECT * FROM report_snapshots WHERE report_type='email_merchandising' AND cache_key=?").get(merchandisingCacheKey) || null;
  }
  function cacheStatus() {
    const row = cacheRow();
    if (!row) return { available: false, stale: true, refreshedAt: "", ageDays: null, dateRange: null, productCount: 0 };
    const payload = json(row.payload_json, {});
    const refreshedAt = row.updated_at || row.created_at || payload.syncedAt || "";
    const timestamp = refreshedAt ? new Date(`${refreshedAt.replace(" ", "T")}Z`).getTime() : NaN;
    const ageDays = Number.isFinite(timestamp) ? Math.max(0, Math.floor((Date.now() - timestamp) / 864e5)) : null;
    return { available: true, stale: ageDays == null || ageDays >= 7, refreshedAt, ageDays, dateRange: payload.dateRange || null, productCount: Number((payload.products || []).length) };
  }
  async function refreshData(options = {}) {
    const data = await fetchProducts({ startDate: options.startDate, endDate: options.endDate });
    if (!data.configured) throw new Error(data.message || "Shopify is not configured.");
    openDb().prepare(`INSERT INTO report_snapshots (id,report_type,period_id,cache_key,payload_json,created_at,updated_at) VALUES (?,'email_merchandising',NULL,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP) ON CONFLICT(report_type,cache_key) DO UPDATE SET payload_json=excluded.payload_json,updated_at=CURRENT_TIMESTAMP`).run(`snapshot:${merchandisingCacheKey}`, merchandisingCacheKey, JSON.stringify(data));
    return { data, cache: cacheStatus() };
  }
  async function recommendations(options) {
    let row = cacheRow();
    if (!row) await refreshData(options);
    row = cacheRow();
    const data = json(row?.payload_json, {});
    if (!data.configured) throw new Error(data.message || "No cached Shopify product data is available.");
    const storefrontUrl = config().storefrontUrl;
    const products = (data.products || []).map(item => ({ ...item, onlineStoreUrl: item.onlineStoreUrl || (storefrontUrl && item.handle ? `${storefrontUrl}/products/${encodeURIComponent(item.handle)}` : "") }));
    const result = recommendProducts(products, history(), options);
    const cache = cacheStatus();
    if (cache.stale) result.warnings.unshift("Product data is more than a week old. Refresh it before finalising this week's campaign.");
    return { ...result, integrations: { shopify: true, orders: Boolean(data.ordersAvailable), ga4: Boolean(data.gaAvailable), gaMessage: data.gaMessage || "" }, syncedAt: data.syncedAt, cache };
  }
  function campaignCode(name) { return `mx-${isoDate().replace(/-/g, "")}-${safe(name).slice(0, 42)}-${crypto.randomBytes(2).toString("hex")}`; }
  function publicCampaign(row) {
    if (!row) return null;
    const db = openDb();
    const productRows = db.prepare("SELECT * FROM email_campaign_products WHERE campaign_id=? ORDER BY position").all(row.id);
    const metricRows = db.prepare("SELECT * FROM email_campaign_metric_snapshots WHERE campaign_id=? ORDER BY fetched_at DESC").all(row.id);
    const latest = {};
    for (const item of metricRows) if (!latest[item.source]) latest[item.source] = { ...json(item.metrics_json), error: item.error || "", fetchedAt: item.fetched_at };
    const klaviyo = latest.klaviyo || {}; const ga4 = latest.ga4 || {};
    const delivered = Number(klaviyo.delivered || klaviyo.recipients || 0); const clicks = Number(klaviyo.clicks || klaviyo.uniqueClicks || 0); const revenue = Number(ga4.revenue || klaviyo.revenue || klaviyo.conversionValue || 0);
    return { id: row.id, campaignCode: row.campaign_code, name: row.name, objective: row.objective, theme: row.theme || "", subject: row.subject || "", preheader: row.preheader || "", status: row.status, sourceStartDate: row.source_start_date || "", sourceEndDate: row.source_end_date || "", klaviyoCampaignId: row.klaviyo_campaign_id || "", klaviyoTemplateId: row.klaviyo_template_id || "", klaviyoStatus: row.klaviyo_status || "", sentAt: row.sent_at || "", createdByName: row.created_by_name || "", lastError: row.last_error || "", createdAt: row.created_at, updatedAt: row.updated_at, products: productRows.map(item => ({ ...json(item.snapshot_json), rowId: item.id, productKey: item.product_key, position: Number(item.position), rationale: item.rationale || "", score: Number(item.score || 0), trackedUrl: item.tracked_url || "" })), metrics: { sources: latest, delivered, clicks, clickRate: delivered ? clicks / delivered : 0, revenue, revenuePerRecipient: delivered ? revenue / delivered : 0 } };
  }
  function list() { return openDb().prepare("SELECT * FROM email_campaigns ORDER BY created_at DESC").all().map(publicCampaign); }
  function get(id) { return publicCampaign(openDb().prepare("SELECT * FROM email_campaigns WHERE id=?").get(String(id || ""))); }
  function save(body, req) {
    const products = Array.isArray(body.products) ? body.products.slice(0, 6) : [];
    if (!String(body.name || "").trim()) throw new Error("Add a campaign name.");
    if (products.length !== 6) throw new Error("Choose exactly six products before saving the campaign.");
    if (new Set(products.map(productKey)).size !== 6) throw new Error("Each campaign slot must contain a different product.");
    const unavailable = products.find(item => !eligibility(item).eligible);
    if (unavailable) throw new Error(`${unavailable.title || "A selected product"} is no longer eligible: ${eligibility(unavailable).reasons.join(", ")}.`);
    const db = openDb(); const existing = body.id ? db.prepare("SELECT * FROM email_campaigns WHERE id=?").get(String(body.id)) : null;
    if (existing?.klaviyo_campaign_id) throw new Error("This campaign already has a Klaviyo draft. Create a new campaign to change its products.");
    const id = existing?.id || crypto.randomUUID(); const code = existing?.campaign_code || campaignCode(body.name); const cfg = config();
    db.transaction(() => {
      db.prepare(`INSERT INTO email_campaigns (id,campaign_code,name,objective,theme,subject,preheader,status,source_start_date,source_end_date,created_by_user_id,created_by_name,data,created_at,updated_at) VALUES (@id,@code,@name,@objective,@theme,@subject,@preheader,'draft',@start,@end,@userId,@userName,@data,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP) ON CONFLICT(id) DO UPDATE SET name=excluded.name,objective=excluded.objective,theme=excluded.theme,subject=excluded.subject,preheader=excluded.preheader,source_start_date=excluded.source_start_date,source_end_date=excluded.source_end_date,data=excluded.data,updated_at=CURRENT_TIMESTAMP`).run({ id, code, name: String(body.name).trim().slice(0, 160), objective: String(body.objective || "balanced"), theme: String(body.theme || "").trim().slice(0, 120), subject: String(body.subject || "").trim().slice(0, 180), preheader: String(body.preheader || "").trim().slice(0, 240), start: String(body.sourceStartDate || ""), end: String(body.sourceEndDate || ""), userId: req.currentUser?.id || "system", userName: actorName(req), data: JSON.stringify({ warnings: body.warnings || [] }) });
      db.prepare("DELETE FROM email_campaign_products WHERE campaign_id=?").run(id);
      const insert = db.prepare("INSERT INTO email_campaign_products (id,campaign_id,product_key,position,rationale,score,tracked_url,snapshot_json) VALUES (?,?,?,?,?,?,?,?)");
      products.forEach((item, index) => { const position = index + 1; const key = String(item.productKey || productKey(item)); const url = trackedProductUrl(item, code, position, cfg.storefrontUrl); if (!url) throw new Error(`${item.title || "A selected product"} has no usable storefront URL.`); insert.run(crypto.randomUUID(), id, key, position, String(item.rationale || ""), Number(item.score || 0), url, JSON.stringify({ id: item.id || key, title: item.title || "", handle: item.handle || "", onlineStoreUrl: item.onlineStoreUrl || "", imageUrl: item.imageUrl || "", imageAlt: item.imageAlt || item.title || "", price: Number(item.price || 0), stock: Number(item.stock || 0), margin: item.margin == null ? null : Number(item.margin), productType: item.productType || "", color: item.color || "", season: item.season || "", rationale: item.rationale || "", objective: body.objective || "balanced" })); });
    })();
    return get(id);
  }
  function headers() { const cfg = config(); return { accept: "application/vnd.api+json", "content-type": "application/vnd.api+json", authorization: `Klaviyo-API-Key ${cfg.privateApiKey}`, revision: cfg.apiRevision }; }
  async function klaviyo(pathname, options = {}) {
    const response = await requestJson(`https://a.klaviyo.com${pathname}`, { ...options, headers: { ...headers(), ...(options.headers || {}) } });
    if (!response.ok) throw new Error(`Klaviyo API error (${response.status}): ${response.json?.errors?.[0]?.detail || response.json?.message || response.statusText}`);
    return response.json;
  }
  function defaultTemplate() { return `<!doctype html><html><body style="margin:0;background:#f4f4f2;font-family:Arial,sans-serif"><div style="display:none;max-height:0;overflow:hidden">{{MERCH_X_PREHEADER}}</div><table role="presentation" width="100%"><tr><td align="center"><table role="presentation" width="640" style="max-width:100%;background:#fff"><tr><td style="padding:32px"><h1 style="font-size:26px;margin:0 0 22px">{{MERCH_X_HEADING}}</h1>{{MERCH_X_PRODUCTS}}</td></tr></table></td></tr></table></body></html>`; }
  function productGrid(campaign) {
    const rows = [];
    for (let index = 0; index < campaign.products.length; index += 2) {
      const cells = campaign.products.slice(index, index + 2).map(item => `
        <td width="50%" valign="top" align="center" style="width:50%;padding:0 14px 30px">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;border-collapse:collapse">
            <tr>
              <td align="center">
                <a href="${html(item.trackedUrl)}" style="color:#111111;text-decoration:none">
                  <img src="${html(item.imageUrl)}" alt="${html(item.imageAlt || item.title)}" width="270" style="display:block;width:100%;max-width:270px;height:auto;border:0">
                </a>
              </td>
            </tr>
            <tr>
              <td height="42" valign="top" align="center" style="height:42px;padding:9px 4px 0;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:16px;color:#111111">
                <a href="${html(item.trackedUrl)}" style="color:#111111;text-decoration:none">${html(item.title)}</a>
              </td>
            </tr>
            <tr>
              <td height="27" valign="top" align="center" style="height:27px;padding:0 4px;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:19px;color:#111111">&pound;${Number(item.price || 0).toFixed(2)}</td>
            </tr>
            <tr>
              <td align="center" style="padding-top:5px">
                <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="border-collapse:collapse">
                  <tr>
                    <td align="center" bgcolor="#000000" style="background:#000000">
                      <a href="${html(item.trackedUrl)}" style="display:inline-block;padding:10px 15px;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:16px;font-weight:bold;color:#ffffff;text-decoration:none">Shop now</a>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
          </table>
        </td>`).join("");
      rows.push(`<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;border-collapse:collapse;background:#ffffff"><tr>${cells}</tr></table>`);
    }
    return rows.join("");
  }
  async function createDraft(id) {
    const campaign = get(id); if (!campaign) throw new Error("Campaign not found."); const cfg = config();
    if (!cfg.privateApiKey) throw new Error("Set KLAVIYO_PRIVATE_API_KEY before creating a draft.");
    if (!cfg.defaultAudienceId) throw new Error("Set KLAVIYO_DEFAULT_AUDIENCE_ID before creating a draft.");
    if (campaign.klaviyoCampaignId) return campaign;
    let source = defaultTemplate();
    if (cfg.baseTemplatePath) source = fs.readFileSync(cfg.baseTemplatePath, "utf8");
    else if (cfg.baseTemplateId) source = (await klaviyo(`/api/templates/${encodeURIComponent(cfg.baseTemplateId)}`)).data?.attributes?.html || "";
    if (!source.includes("{{MERCH_X_PRODUCTS}}")) throw new Error("The base template must contain {{MERCH_X_PRODUCTS}}.");
    const emailHtml = source.replaceAll("{{MERCH_X_PRODUCTS}}", productGrid(campaign)).replaceAll("{{MERCH_X_PREHEADER}}", html(campaign.preheader || "Six products selected for you")).replaceAll("{{MERCH_X_HEADING}}", html(campaign.subject || campaign.name));
    const template = await klaviyo("/api/templates", { method: "POST", body: JSON.stringify({ data: { type: "template", attributes: { name: `${campaign.name} · ${campaign.campaignCode}`, editor_type: "CODE", html: emailHtml } } }) });
    const templateId = template.data?.id; if (!templateId) throw new Error("Klaviyo did not return a template ID.");
    const created = await klaviyo("/api/campaigns", { method: "POST", body: JSON.stringify({ data: { type: "campaign", attributes: { name: `${campaign.name} · ${campaign.campaignCode}`, audiences: { included: [cfg.defaultAudienceId], excluded: [] }, "campaign-messages": { data: [{ type: "campaign-message", attributes: { definition: { channel: "email", label: campaign.name, content: { subject: campaign.subject || campaign.name, preview_text: campaign.preheader || "" } } } }] } } } }) });
    const campaignId = created.data?.id; const messageId = created.data?.relationships?.["campaign-messages"]?.data?.[0]?.id || created.included?.find(item => item.type === "campaign-message")?.id || "";
    if (!campaignId) throw new Error("Klaviyo did not return a campaign ID.");
    if (messageId) await klaviyo("/api/campaign-message-assign-template", { method: "POST", body: JSON.stringify({ data: { type: "campaign-message", id: messageId, relationships: { template: { data: { type: "template", id: templateId } } } } }) });
    openDb().prepare("UPDATE email_campaigns SET status='klaviyo_draft',klaviyo_campaign_id=?,klaviyo_template_id=?,klaviyo_message_id=?,klaviyo_status='Draft',last_error=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(campaignId, templateId, messageId, id);
    return get(id);
  }
  function flatten(value, result = {}) { if (!value || typeof value !== "object") return result; for (const [key, item] of Object.entries(value)) { if (typeof item === "number" && result[key] == null) result[key] = item; else if (item && typeof item === "object") flatten(item, result); } return result; }
  async function syncKlaviyo(campaign) {
    if (!campaign.klaviyoCampaignId) throw new Error("Create the Klaviyo draft first.");
    const detail = await klaviyo(`/api/campaigns/${encodeURIComponent(campaign.klaviyoCampaignId)}`); const attributes = detail.data?.attributes || {}; const status = String(attributes.status || attributes.send_status || "Draft"); const sentAt = attributes.send_time || attributes.sent_at || ""; let metrics = flatten(attributes.statistics || attributes.results || {}); const cfg = config();
    try { const report = await klaviyo("/api/campaign-values-reports", { method: "POST", body: JSON.stringify({ data: { type: "campaign-values-report", attributes: { statistics: ["recipients", "delivered", "opens", "open_rate", "clicks", "click_rate", "conversions", "conversion_value"], timeframe: { key: "last_365_days" }, ...(cfg.conversionMetricId ? { conversion_metric_id: cfg.conversionMetricId } : {}), filter: `equals(campaign_id,\"${campaign.klaviyoCampaignId}\")` } } }) }); metrics = { ...metrics, ...flatten(report.data || report) }; } catch (error) { metrics.reportWarning = error.message; }
    const db = openDb(); db.prepare("INSERT INTO email_campaign_metric_snapshots (id,campaign_id,source,metrics_json,fetched_at) VALUES (?,?,'klaviyo',?,CURRENT_TIMESTAMP)").run(crypto.randomUUID(), campaign.id, JSON.stringify(metrics)); db.prepare("UPDATE email_campaigns SET klaviyo_status=?,status=CASE WHEN ?<>'' THEN 'sent' ELSE status END,sent_at=COALESCE(sent_at,NULLIF(?,'')),updated_at=CURRENT_TIMESTAMP WHERE id=?").run(status, sentAt, sentAt, campaign.id);
  }
  async function syncGa(campaign) {
    const ga = gaConfig(); if (!ga.propertyId || (!ga.oauthRefreshToken && !ga.credentials)) throw new Error("GA4 is not configured.");
    const startDate = campaign.sentAt ? campaign.sentAt.slice(0, 10) : campaign.sourceStartDate || isoDate(Date.now() - 28 * 864e5); const limit = new Date(`${startDate}T00:00:00Z`); limit.setUTCDate(limit.getUTCDate() + 27); const endDate = isoDate(limit > new Date() ? new Date() : limit);
    const response = await requestJson(`https://analyticsdata.googleapis.com/v1beta/properties/${ga.propertyId}:runReport`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${await googleAccessToken()}` }, body: JSON.stringify({ dateRanges: [{ startDate, endDate }], dimensions: [{ name: "sessionCampaignName" }, { name: "sessionManualAdContent" }], metrics: [{ name: "sessions" }, { name: "ecommercePurchases" }, { name: "purchaseRevenue" }], dimensionFilter: { filter: { fieldName: "sessionCampaignName", stringFilter: { matchType: "EXACT", value: campaign.campaignCode, caseSensitive: false } } }, limit: "1000" }) });
    if (!response.ok) throw new Error(response.json.error?.message || `GA4 API error (${response.status}).`);
    let sessions = 0, purchases = 0, revenue = 0; const products = {}; for (const row of response.json.rows || []) { const content = row.dimensionValues?.[1]?.value || ""; const values = row.metricValues || []; const item = { sessions: Number(values[0]?.value || 0), purchases: Number(values[1]?.value || 0), revenue: Number(values[2]?.value || 0) }; sessions += item.sessions; purchases += item.purchases; revenue += item.revenue; if (content) products[content] = item; }
    const metrics = { sessions, purchases, revenue: Math.round(revenue * 100) / 100, products }; openDb().prepare("INSERT INTO email_campaign_metric_snapshots (id,campaign_id,source,window_start,window_end,metrics_json,fetched_at) VALUES (?,?,'ga4',?,?,?,CURRENT_TIMESTAMP)").run(crypto.randomUUID(), campaign.id, startDate, endDate, JSON.stringify(metrics));
  }
  async function sync(id) { let campaign = get(id); if (!campaign) throw new Error("Campaign not found."); const errors = []; try { await syncKlaviyo(campaign); } catch (error) { errors.push(`Klaviyo: ${error.message}`); } campaign = get(id); try { await syncGa(campaign); } catch (error) { errors.push(`GA4: ${error.message}`); } openDb().prepare("UPDATE email_campaigns SET last_error=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(errors.join(" · ") || null, id); return get(id); }
  return { cacheStatus, config, createDraft, get, list, recommendations, refreshData, save, sync };
}

module.exports = { createEmailCampaignService };
