"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Database = require("better-sqlite3");
const { createEmailCampaignService } = require("../lib/email-campaign-service");

function database() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE email_campaigns (id TEXT PRIMARY KEY,campaign_code TEXT UNIQUE,name TEXT,objective TEXT,theme TEXT,subject TEXT,preheader TEXT,status TEXT,source_start_date TEXT,source_end_date TEXT,klaviyo_campaign_id TEXT,klaviyo_template_id TEXT,klaviyo_message_id TEXT,klaviyo_status TEXT,sent_at TEXT,created_by_user_id TEXT,created_by_name TEXT,last_error TEXT,data TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP,updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE email_campaign_products (id TEXT PRIMARY KEY,campaign_id TEXT,product_key TEXT,position INTEGER,rationale TEXT,score REAL,tracked_url TEXT,snapshot_json TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP,updated_at TEXT DEFAULT CURRENT_TIMESTAMP,UNIQUE(campaign_id,product_key),UNIQUE(campaign_id,position));
    CREATE TABLE email_campaign_metric_snapshots (id TEXT PRIMARY KEY,campaign_id TEXT,source TEXT,window_start TEXT,window_end TEXT,metrics_json TEXT,error TEXT,fetched_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE report_snapshots (id TEXT PRIMARY KEY,report_type TEXT,period_id TEXT,cache_key TEXT,payload_json TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP,updated_at TEXT DEFAULT CURRENT_TIMESTAMP,UNIQUE(report_type,cache_key));
  `);
  return db;
}

function products() {
  return Array.from({ length: 6 }, (_, index) => ({ id: `p${index + 1}`, productKey: `p${index + 1}`, status: "ACTIVE", publishedAt: "2026-06-01", stock: 10, imageUrl: `https://img.example/p${index + 1}.jpg`, imageAlt: `Product ${index + 1}`, price: 49, handle: `p${index + 1}`, title: `Product ${index + 1}`, productType: `Type ${index + 1}`, color: "Navy", season: "SS26", rationale: "test", score: 80 }));
}

function service(db, requestJson, fetchProducts = async () => ({ configured: true, products: [] })) {
  return createEmailCampaignService({ openDb: () => db, requestJson, fetchProducts, googleAccessToken: async () => "token", gaConfig: () => ({}), actorName: () => "Tester" });
}

test("weekly product cache is reused until explicitly refreshed", { concurrency: false }, async () => {
  const previousStorefront = process.env.STOREFRONT_URL;
  process.env.STOREFRONT_URL = "https://shop.example";
  const db = database();
  let fetches = 0;
  const fetchProducts = async () => ({ configured: true, ordersAvailable: true, gaAvailable: true, syncedAt: new Date().toISOString(), dateRange: { startDate: "2026-05-25", endDate: "2026-06-21" }, products: products().concat(products().map((item, index) => ({ ...item, id: `r${index}`, productKey: `r${index}`, handle: `r${index}`, title: `Replacement ${index}` }))) });
  const api = service(db, async () => ({ ok: true, json: {} }), async range => { fetches += 1; return fetchProducts(range); });
  await api.recommendations({ objective: "balanced", startDate: "2026-05-25", endDate: "2026-06-21" });
  await api.recommendations({ objective: "new_in", startDate: "2026-05-25", endDate: "2026-06-21" });
  assert.equal(fetches, 1);
  await api.refreshData({ startDate: "2026-05-25", endDate: "2026-06-21" });
  assert.equal(fetches, 2);
  assert.equal(api.cacheStatus().productCount, 12);
  db.close();
  if (previousStorefront == null) delete process.env.STOREFRONT_URL; else process.env.STOREFRONT_URL = previousStorefront;
});

test("Klaviyo draft validates configuration before making requests", { concurrency: false }, async () => {
  const previousKey = process.env.KLAVIYO_PRIVATE_API_KEY;
  const previousAudience = process.env.KLAVIYO_DEFAULT_AUDIENCE_ID;
  const previousStorefront = process.env.STOREFRONT_URL;
  delete process.env.KLAVIYO_PRIVATE_API_KEY;
  delete process.env.KLAVIYO_DEFAULT_AUDIENCE_ID;
  process.env.STOREFRONT_URL = "https://shop.example";
  const db = database();
  const api = service(db, async () => { throw new Error("should not run"); });
  const campaign = api.save({ name: "Test", products: products() }, { currentUser: { id: "u1" } });
  await assert.rejects(() => api.createDraft(campaign.id), /KLAVIYO_PRIVATE_API_KEY/);
  db.close();
  if (previousKey == null) delete process.env.KLAVIYO_PRIVATE_API_KEY; else process.env.KLAVIYO_PRIVATE_API_KEY = previousKey;
  if (previousAudience == null) delete process.env.KLAVIYO_DEFAULT_AUDIENCE_ID; else process.env.KLAVIYO_DEFAULT_AUDIENCE_ID = previousAudience;
  if (previousStorefront == null) delete process.env.STOREFRONT_URL; else process.env.STOREFRONT_URL = previousStorefront;
});

test("Klaviyo draft creation is idempotent and handles the API contract", { concurrency: false }, async () => {
  const previous = { key: process.env.KLAVIYO_PRIVATE_API_KEY, audience: process.env.KLAVIYO_DEFAULT_AUDIENCE_ID, storefront: process.env.STOREFRONT_URL };
  process.env.KLAVIYO_PRIVATE_API_KEY = "private-key";
  process.env.KLAVIYO_DEFAULT_AUDIENCE_ID = "list-1";
  process.env.STOREFRONT_URL = "https://shop.example";
  const db = database();
  const calls = [];
  const api = service(db, async (url, options) => {
    calls.push({ url, body: options.body ? JSON.parse(options.body) : null });
    if (url.endsWith("/api/templates")) return { ok: true, status: 201, json: { data: { id: "template-1" } } };
    if (url.endsWith("/api/campaigns")) return { ok: true, status: 201, json: { data: { id: "campaign-1", relationships: { "campaign-messages": { data: [{ id: "message-1" }] } } } } };
    if (url.endsWith("/api/campaign-message-assign-template")) return { ok: true, status: 200, json: { data: {} } };
    return { ok: false, status: 500, statusText: "Unexpected", json: {} };
  });
  const campaign = api.save({ name: "Test", subject: "Subject", products: products() }, { currentUser: { id: "u1" } });
  const created = await api.createDraft(campaign.id);
  assert.equal(created.klaviyoCampaignId, "campaign-1");
  assert.equal(calls.length, 3);
  assert.match(calls[0].body.data.attributes.html, /utm_campaign/);
  assert.equal((calls[0].body.data.attributes.html.match(/width="50%"/g) || []).length, 6);
  assert.equal((calls[0].body.data.attributes.html.match(/>Shop now<\/a>/g) || []).length, 6);
  assert.match(calls[0].body.data.attributes.html, /background:#000000/);
  const campaignAttributes = calls[1].body.data.attributes;
  const messageAttributes = campaignAttributes["campaign-messages"].data[0].attributes;
  assert.deepEqual(messageAttributes.definition, {
    channel: "email",
    label: "Test",
    content: { subject: "Subject", preview_text: "" }
  });
  assert.equal(messageAttributes.channel, undefined);
  assert.equal(campaignAttributes.send_strategy, undefined);
  await api.createDraft(campaign.id);
  assert.equal(calls.length, 3);
  db.close();
  if (previous.key == null) delete process.env.KLAVIYO_PRIVATE_API_KEY; else process.env.KLAVIYO_PRIVATE_API_KEY = previous.key;
  if (previous.audience == null) delete process.env.KLAVIYO_DEFAULT_AUDIENCE_ID; else process.env.KLAVIYO_DEFAULT_AUDIENCE_ID = previous.audience;
  if (previous.storefront == null) delete process.env.STOREFRONT_URL; else process.env.STOREFRONT_URL = previous.storefront;
});

test("malformed Klaviyo responses fail without marking a draft created", { concurrency: false }, async () => {
  const previous = { key: process.env.KLAVIYO_PRIVATE_API_KEY, audience: process.env.KLAVIYO_DEFAULT_AUDIENCE_ID, storefront: process.env.STOREFRONT_URL };
  process.env.KLAVIYO_PRIVATE_API_KEY = "private-key";
  process.env.KLAVIYO_DEFAULT_AUDIENCE_ID = "list-1";
  process.env.STOREFRONT_URL = "https://shop.example";
  const db = database();
  const api = service(db, async () => ({ ok: true, status: 201, json: { data: {} } }));
  const campaign = api.save({ name: "Test", products: products() }, { currentUser: { id: "u1" } });
  await assert.rejects(() => api.createDraft(campaign.id), /template ID/);
  assert.equal(api.get(campaign.id).klaviyoCampaignId, "");
  db.close();
  if (previous.key == null) delete process.env.KLAVIYO_PRIVATE_API_KEY; else process.env.KLAVIYO_PRIVATE_API_KEY = previous.key;
  if (previous.audience == null) delete process.env.KLAVIYO_DEFAULT_AUDIENCE_ID; else process.env.KLAVIYO_DEFAULT_AUDIENCE_ID = previous.audience;
  if (previous.storefront == null) delete process.env.STOREFRONT_URL; else process.env.STOREFRONT_URL = previous.storefront;
});
