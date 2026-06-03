const http = require("node:http");
const https = require("node:https");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");

const port = Number(process.env.PORT || 3000);
const publicDir = path.join(__dirname, "public");
const dataDir = path.join(__dirname, "data");
const orderDbPath = path.join(dataDir, "order-form-db.json");
const sqliteDbPath = process.env.DATABASE_PATH || path.join(dataDir, "merch-x.sqlite");

function loadEnvFile() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) return;

  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const equalsAt = trimmed.indexOf("=");
    if (equalsAt === -1) continue;

    const key = trimmed.slice(0, equalsAt).trim();
    const value = trimmed.slice(equalsAt + 1).trim().replace(/^["']|["']$/g, "");
    if (key && process.env[key] == null) process.env[key] = value;
  }
}

loadEnvFile();

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

function sendJson(res, status, payload) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
    "access-control-allow-headers": "content-type, authorization"
  });
  res.end(JSON.stringify(payload));
}

function sendHtml(res, status, html) {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
}

function escapeHtml(value) {
  return String(value || "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
  }[char]));
}

function requestJson(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const body = options.body || "";
    const req = https.request(parsedUrl, {
      method: options.method || "GET",
      headers: {
        ...(options.headers || {}),
        ...(body ? { "content-length": Buffer.byteLength(body) } : {})
      }
    }, (response) => {
      let raw = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        raw += chunk;
      });
      response.on("end", () => {
        let json = {};
        try {
          json = raw ? JSON.parse(raw) : {};
        } catch {
          json = { message: raw };
        }
        resolve({ ok: response.statusCode >= 200 && response.statusCode < 300, status: response.statusCode, statusText: response.statusMessage, json });
      });
    });

    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

function shopifyConfig() {
  const rawShop = process.env.SHOPIFY_SHOP || process.env.SHOPIFY_STORE_DOMAIN || process.env.SHOPIFY_SHOP_DOMAIN || "";
  const clientId = process.env.SHOPIFY_CLIENT_ID || "";
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET || "";
  const apiVersion = process.env.SHOPIFY_API_VERSION || "2026-04";
  const shop = rawShop.replace(/^https?:\/\//, "").replace(/\/+$/, "").replace(/\.myshopify\.com$/i, "");
  const domain = `${shop}.myshopify.com`;
  return { shop, domain, clientId, clientSecret, apiVersion };
}

let shopifyToken = null;
let shopifyTokenExpiresAt = 0;
let googleToken = null;
let googleTokenExpiresAt = 0;

function base64Url(value) {
  return Buffer.from(value).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function normalizedKey(value) {
  return String(value || "").trim().toLowerCase().replace(/^gid:\/\/shopify\/(?:product|productvariant)\//, "").replace(/^\*/, "");
}

function gaConfig() {
  const propertyId = process.env.GA4_PROPERTY_ID || process.env.GOOGLE_ANALYTICS_PROPERTY_ID || "";
  const oauthClientId = process.env.GOOGLE_OAUTH_CLIENT_ID || "";
  const oauthClientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET || "";
  const oauthRefreshToken = process.env.GOOGLE_OAUTH_REFRESH_TOKEN || "";
  const inlineJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || "";
  const credentialsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS || "";
  let credentials = null;

  if (inlineJson) {
    credentials = JSON.parse(inlineJson);
  } else if (credentialsPath && fs.existsSync(credentialsPath)) {
    credentials = JSON.parse(fs.readFileSync(credentialsPath, "utf8"));
  }

  return { propertyId, oauthClientId, oauthClientSecret, oauthRefreshToken, credentials };
}

async function googleAccessToken() {
  if (googleToken && Date.now() < googleTokenExpiresAt - 60_000) return googleToken;

  const { oauthClientId, oauthClientSecret, oauthRefreshToken, credentials } = gaConfig();
  if (oauthClientId && oauthClientSecret && oauthRefreshToken) {
    const response = await requestJson("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: oauthClientId,
        client_secret: oauthClientSecret,
        refresh_token: oauthRefreshToken,
        grant_type: "refresh_token"
      }).toString()
    });

    if (!response.ok || !response.json.access_token) {
      throw new Error(response.json.error_description || response.json.error || `Google OAuth refresh failed: ${response.status}`);
    }

    googleToken = response.json.access_token;
    googleTokenExpiresAt = Date.now() + Number(response.json.expires_in || 3600) * 1000;
    return googleToken;
  }

  if (!credentials?.client_email || !credentials?.private_key) {
    throw new Error("Google Analytics OAuth refresh token or service account credentials are missing.");
  }

  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = base64Url(JSON.stringify({
    iss: credentials.client_email,
    scope: "https://www.googleapis.com/auth/analytics.readonly",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600
  }));
  const unsigned = `${header}.${claim}`;
  const signature = crypto.createSign("RSA-SHA256").update(unsigned).sign(credentials.private_key, "base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  const response = await requestJson("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${unsigned}.${signature}`
    }).toString()
  });

  if (!response.ok || !response.json.access_token) {
    throw new Error(response.json.error_description || response.json.error || `Google token request failed: ${response.status}`);
  }

  googleToken = response.json.access_token;
  googleTokenExpiresAt = Date.now() + Number(response.json.expires_in || 3600) * 1000;
  return googleToken;
}

async function shopifyAccessToken() {
  if (shopifyToken && Date.now() < shopifyTokenExpiresAt - 60_000) return shopifyToken;

  const { domain, clientId, clientSecret } = shopifyConfig();
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret
  }).toString();
  const response = await requestJson(`https://${domain}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body
  });
  const json = response.json;
  if (!response.ok || !json.access_token) {
    throw new Error(json.error_description || json.error || `Shopify token request failed: ${response.status}`);
  }

  shopifyToken = json.access_token;
  shopifyTokenExpiresAt = Date.now() + Number(json.expires_in || 86400) * 1000;
  return shopifyToken;
}

async function shopifyGraphql(query, variables) {
  const { domain, apiVersion } = shopifyConfig();
  const response = await requestJson(`https://${domain}/admin/api/${apiVersion}/graphql.json`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-shopify-access-token": await shopifyAccessToken()
    },
    body: JSON.stringify({ query, variables })
  });
  const json = response.json;
  if (!response.ok || json.errors) {
    const detail = json.errors ? JSON.stringify(json.errors) : response.statusText;
    throw new Error(`Shopify API error (${response.status} ${response.statusText}, ${domain}, ${apiVersion}): ${detail}`);
  }
  return json.data;
}

function productSeason(product) {
  const metafieldSeason = product.seasonMetafield?.value || product.metafield?.value || "";
  if (metafieldSeason) return String(metafieldSeason).trim();

  const joined = product.tags.join(" ");
  const match = joined.match(/\b(?:SS|AW)\s?\d{2,4}\b/i);
  return match ? match[0].replace(/\s+/, "").toUpperCase() : "";
}

function productColor(product) {
  const palette = ["Black","Blue","Brown","Cocoa","Cream","Denim","Fuchsia","Green","Grey","Ivory","Khaki","Lime","Navy","Olive","Orange","Pink","Powder Blue","Purple","Red","Stone","White","Yellow"];
  const haystack = `${product.title} ${product.tags.join(" ")}`.toLowerCase();
  return palette.find((color) => haystack.includes(color.toLowerCase())) || "";
}

function normalizeProduct(product, orderMetrics) {
  const variants = product.variants.nodes;
  const stock = variants.reduce((sum, variant) => sum + Number(variant.inventoryQuantity || 0), 0);
  const prices = variants.map((variant) => Number(variant.price || 0)).filter(Number.isFinite);
  const costs = variants.map((variant) => Number(variant.inventoryItem?.unitCost?.amount || 0)).filter((value) => Number.isFinite(value) && value > 0);
  const skus = variants.map((variant) => variant.sku).filter(Boolean);
  const variantIds = variants.flatMap((variant) => [variant.id, variant.legacyResourceId]).filter(Boolean);
  const price = prices.length ? Math.min(...prices) : 0;
  const cost = costs.length ? costs.reduce((sum, value) => sum + value, 0) / costs.length : null;
  const margin = price > 0 && cost > 0 ? Math.round(((price - cost) / price) * 100) : null;
  const metrics = orderMetrics.get(product.id) || { revenue: 0, units: 0 };
  const image = product.featuredImage || product.images.nodes[0] || null;
  return {
    id: product.id,
    title: product.title,
    handle: product.handle,
    vendor: product.vendor,
    productType: product.productType,
    tags: product.tags,
    createdAt: product.createdAt || "",
    publishedAt: product.publishedAt || "",
    updatedAt: product.updatedAt || "",
    legacyResourceId: product.legacyResourceId,
    skus,
    variantIds,
    season: productSeason(product),
    color: productColor(product),
    imageUrl: image?.url || "",
    imageAlt: image?.altText || product.title,
    price,
    cost,
    margin,
    stock,
    revenue: Math.round(metrics.revenue * 100) / 100,
    units: metrics.units,
    gaViews: 0,
    gaAdds: 0,
    gaPurchases: 0,
    gaRevenue: 0
  };
}

function normalizeCollection(collection) {
  return {
    id: collection.id,
    title: collection.title,
    handle: collection.handle,
    sortOrder: collection.sortOrder || "",
    updatedAt: collection.updatedAt || "",
    productsCount: Number(collection.productsCount?.count || 0),
    imageUrl: collection.image?.url || "",
    imageAlt: collection.image?.altText || collection.title
  };
}

function collectionNumericId(collectionId) {
  return String(collectionId || "").replace(/^gid:\/\/shopify\/Collection\//, "");
}

function emptyGaMetric() {
  return { views: 0, adds: 0, purchases: 0, revenue: 0 };
}

function isoDateOnly(date) {
  return date.toISOString().slice(0, 10);
}

function dateRangeFromDays(days) {
  const end = new Date();
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - Math.max(1, Number(days || 14)));
  return { startDate: isoDateOnly(start), endDate: isoDateOnly(end) };
}

function parseDateRange(url, fallbackDays = 14) {
  const requestedStart = url.searchParams.get("startDate") || "";
  const requestedEnd = url.searchParams.get("endDate") || "";
  const validDate = /^\d{4}-\d{2}-\d{2}$/;
  if (!validDate.test(requestedStart) || !validDate.test(requestedEnd)) {
    return dateRangeFromDays(fallbackDays);
  }

  const start = new Date(`${requestedStart}T00:00:00.000Z`);
  const end = new Date(`${requestedEnd}T00:00:00.000Z`);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || start > end) {
    return dateRangeFromDays(fallbackDays);
  }

  const maxEnd = new Date(start);
  maxEnd.setUTCDate(maxEnd.getUTCDate() + 365);
  if (end > maxEnd) end.setTime(maxEnd.getTime());
  return { startDate: isoDateOnly(start), endDate: isoDateOnly(end) };
}

function orderQueryForRange(range) {
  const endExclusive = new Date(`${range.endDate}T00:00:00.000Z`);
  endExclusive.setUTCDate(endExclusive.getUTCDate() + 1);
  return `created_at:>=${range.startDate}T00:00:00Z created_at:<${endExclusive.toISOString()}`;
}

async function fetchGaMetrics(range) {
  const { propertyId, oauthRefreshToken, credentials } = gaConfig();
  if (!propertyId || (!oauthRefreshToken && !credentials)) {
    return { available: false, message: "Set GA4_PROPERTY_ID and connect Google OAuth to add Analytics ecommerce metrics.", metrics: [] };
  }

  const response = await requestJson(`https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:runReport`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${await googleAccessToken()}`
    },
    body: JSON.stringify({
      dateRanges: [{ startDate: range.startDate, endDate: range.endDate }],
      dimensions: [{ name: "itemId" }, { name: "itemName" }],
      metrics: [
        { name: "itemsViewed" },
        { name: "itemsAddedToCart" },
        { name: "itemsPurchased" },
        { name: "itemRevenue" }
      ],
      limit: "10000"
    })
  });

  if (!response.ok) {
    throw new Error(response.json.error?.message || `Google Analytics API error: ${response.status}`);
  }

  const metrics = (response.json.rows || []).map((row) => ({
    itemId: row.dimensionValues?.[0]?.value || "",
    itemName: row.dimensionValues?.[1]?.value || "",
    views: Number(row.metricValues?.[0]?.value || 0),
    adds: Number(row.metricValues?.[1]?.value || 0),
    purchases: Number(row.metricValues?.[2]?.value || 0),
    revenue: Number(row.metricValues?.[3]?.value || 0)
  }));

  return { available: true, message: "", metrics };
}

function mergeGaMetrics(products, gaRows) {
  const byKey = new Map();
  gaRows.forEach((row, index) => {
    const keys = [row.itemId, row.itemName].map(normalizedKey).filter(Boolean);
    for (const key of keys) {
      const current = byKey.get(key) || [];
      current.push({ index, row });
      byKey.set(key, current);
    }
  });

  return products.map((product) => {
    const keys = [
      product.id,
      product.legacyResourceId,
      product.handle,
      product.title,
      ...(product.skus || []),
      ...(product.variantIds || [])
    ].map(normalizedKey).filter(Boolean);
    const seen = new Set();
    const metric = emptyGaMetric();
    for (const key of keys) {
      const matches = byKey.get(key) || [];
      for (const match of matches) {
        if (seen.has(match.index)) continue;
        seen.add(match.index);
        metric.views += match.row.views;
        metric.adds += match.row.adds;
        metric.purchases += match.row.purchases;
        metric.revenue += match.row.revenue;
      }
    }
    return {
      ...product,
      gaViews: metric.views,
      gaAdds: metric.adds,
      gaPurchases: metric.purchases,
      gaRevenue: Math.round(metric.revenue * 100) / 100
    };
  });
}

async function fetchOrderMetrics(range) {
  const metrics = new Map();
  let cursor = null;
  let hasNextPage = true;
  const orderQuery = orderQueryForRange(range);
  const query = `
    query MerchOrders($cursor: String, $query: String!) {
      orders(first: 100, after: $cursor, query: $query, sortKey: CREATED_AT, reverse: true) {
        nodes {
          lineItems(first: 100) {
            nodes {
              quantity
              discountedTotalSet { shopMoney { amount } }
              product { id }
            }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  `;
  while (hasNextPage) {
    const data = await shopifyGraphql(query, { cursor, query: orderQuery });
    const orders = data.orders;
    for (const order of orders.nodes) {
      for (const item of order.lineItems.nodes) {
        if (!item.product?.id) continue;
        const current = metrics.get(item.product.id) || { revenue: 0, units: 0 };
        current.revenue += Number(item.discountedTotalSet?.shopMoney?.amount || 0);
        current.units += Number(item.quantity || 0);
        metrics.set(item.product.id, current);
      }
    }
    hasNextPage = orders.pageInfo.hasNextPage;
    cursor = orders.pageInfo.endCursor;
  }
  return metrics;
}

function googleRedirectUri(req) {
  return `http://${req.headers.host}/api/google-auth/callback`;
}

function startGoogleAuth(req, res) {
  const { oauthClientId } = gaConfig();
  if (!oauthClientId) {
    sendHtml(res, 500, "<p>Set GOOGLE_OAUTH_CLIENT_ID in .env, restart Merch-X, then try again.</p>");
    return;
  }

  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.searchParams.set("client_id", oauthClientId);
  authUrl.searchParams.set("redirect_uri", googleRedirectUri(req));
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", "https://www.googleapis.com/auth/analytics.readonly");
  authUrl.searchParams.set("access_type", "offline");
  authUrl.searchParams.set("prompt", "consent");

  res.writeHead(302, { location: authUrl.toString() });
  res.end();
}

async function finishGoogleAuth(req, res) {
  const { oauthClientId, oauthClientSecret } = gaConfig();
  const url = new URL(req.url, `http://${req.headers.host}`);
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");

  if (error) {
    sendHtml(res, 400, `<p>Google returned an error: ${escapeHtml(error)}</p>`);
    return;
  }

  if (!code) {
    sendHtml(res, 400, "<p>Missing Google authorization code.</p>");
    return;
  }

  const response = await requestJson("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: oauthClientId,
      client_secret: oauthClientSecret,
      code,
      redirect_uri: googleRedirectUri(req),
      grant_type: "authorization_code"
    }).toString()
  });

  if (!response.ok) {
    sendHtml(res, 502, `<p>Google token exchange failed.</p><pre>${escapeHtml(JSON.stringify(response.json, null, 2))}</pre>`);
    return;
  }

  const refreshToken = response.json.refresh_token || "";
  if (!refreshToken) {
    sendHtml(res, 200, `
      <h1>Google OAuth Connected, But No Refresh Token Returned</h1>
      <p>Google did not return a refresh token. Open <a href="/api/google-auth/start">/api/google-auth/start</a> again and approve access with the consent prompt.</p>
      <p>If this keeps happening, remove this app from your Google Account third-party access list and try again.</p>
    `);
    return;
  }

  sendHtml(res, 200, `
    <!doctype html>
    <html lang="en">
    <head><meta charset="utf-8"><title>Google OAuth Connected</title>
    <style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;max-width:820px;margin:40px auto;padding:0 18px;line-height:1.55}code,pre{font-family:ui-monospace,SFMono-Regular,Consolas,monospace}pre{background:#f4f4f2;border:1px solid #ddd;border-radius:8px;padding:14px;white-space:pre-wrap;word-break:break-all}a{color:#164f7a}</style></head>
    <body>
      <h1>Google OAuth Connected</h1>
      <p>Add this line to your Merch-X <code>.env</code> file:</p>
      <pre>GOOGLE_OAUTH_REFRESH_TOKEN=${escapeHtml(refreshToken)}</pre>
      <p>Then restart the Merch-X local server and refresh <a href="/merchandising.html">Product merchandising</a>.</p>
    </body>
    </html>
  `);
}

async function fetchShopifyMerchandising(req, res) {
  const { shop, clientId, clientSecret } = shopifyConfig();
  if (!shop || !clientId || !clientSecret) {
    sendJson(res, 200, {
      configured: false,
      message: "Set SHOPIFY_SHOP, SHOPIFY_CLIENT_ID, and SHOPIFY_CLIENT_SECRET to sync Shopify products."
    });
    return;
  }
  const url = new URL(req.url, `http://${req.headers.host}`);
  const days = Math.max(1, Math.min(90, Number(url.searchParams.get("days") || 14)));
  const dateRange = parseDateRange(url, days);
  const limitParam = url.searchParams.get("limit") || "all";
  const fetchAllProducts = limitParam === "all";
  const productLimit = fetchAllProducts ? Infinity : Math.max(12, Math.min(250, Number(limitParam || 120)));
  let orderMetrics = new Map();
  let ordersAvailable = true;
  try {
    orderMetrics = await fetchOrderMetrics(dateRange);
  } catch {
    ordersAvailable = false;
  }
  const query = `
    query MerchProducts($limit: Int!, $cursor: String, $productQuery: String!) {
      products(first: $limit, after: $cursor, query: $productQuery, sortKey: UPDATED_AT, reverse: true) {
        nodes {
          id
          legacyResourceId
          status
          title
          handle
          vendor
          productType
          tags
          seasonMetafield: metafield(namespace: "custom", key: "season") { value }
          featuredImage { url altText }
          images(first: 1) { nodes { url altText } }
          variants(first: 100) {
            nodes {
              id
              legacyResourceId
              sku
              price
              inventoryQuantity
              inventoryItem { unitCost { amount currencyCode } }
            }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  `;
  try {
    const productQuery = "status:active,draft";
    const countData = await shopifyGraphql(`
      query MerchProductCount($productQuery: String!) {
        productsCount(query: $productQuery, limit: null) { count }
      }
    `, { productQuery });
    const totalProducts = Number(countData.productsCount?.count || 0);
    const rawProducts = [];
    let cursor = null;
    let hasNextPage = true;
    while (hasNextPage && rawProducts.length < productLimit) {
      const remaining = fetchAllProducts ? 250 : Math.min(250, productLimit - rawProducts.length);
      const data = await shopifyGraphql(query, { limit: remaining, cursor, productQuery });
      rawProducts.push(...data.products.nodes);
      hasNextPage = Boolean(data.products.pageInfo.hasNextPage);
      cursor = data.products.pageInfo.endCursor;
    }
    let gaAvailable = false;
    let gaMessage = "";
    let products = rawProducts
      .filter((product) => product.status === "ACTIVE" || product.status === "DRAFT")
      .map((product) => normalizeProduct(product, orderMetrics));
    try {
      const ga = await fetchGaMetrics(dateRange);
      gaAvailable = ga.available;
      gaMessage = ga.message;
      products = mergeGaMetrics(products, ga.metrics);
    } catch (error) {
      gaMessage = error.message;
    }
    sendJson(res, 200, { configured: true, syncedAt: new Date().toISOString(), days, dateRange, ordersAvailable, gaAvailable, gaMessage, totalProducts, products });
  } catch (error) {
    sendJson(res, 502, { configured: true, message: error.message });
  }
}

async function fetchCollectionPlanner(req, res) {
  const { shop, clientId, clientSecret } = shopifyConfig();
  if (!shop || !clientId || !clientSecret) {
    sendJson(res, 200, {
      configured: false,
      message: "Set SHOPIFY_SHOP, SHOPIFY_CLIENT_ID, and SHOPIFY_CLIENT_SECRET to sync Shopify collections."
    });
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const days = Math.max(1, Math.min(90, Number(url.searchParams.get("days") || 30)));
  const dateRange = dateRangeFromDays(days);
  const collectionId = url.searchParams.get("collectionId") || "";
  const collectionLimitParam = url.searchParams.get("collectionLimit") || "all";
  const fetchAllCollections = collectionLimitParam === "all";
  const collectionLimit = fetchAllCollections ? Infinity : Math.max(10, Math.min(250, Number(collectionLimitParam || 60)));
  const minCollectionProducts = Math.max(0, Math.min(10_000, Number(url.searchParams.get("minCollectionProducts") || 0)));
  const productLimitParam = url.searchParams.get("productLimit") || "120";
  const fetchAllProducts = productLimitParam === "all";
  const productLimit = fetchAllProducts ? Infinity : Math.max(12, Math.min(250, Number(productLimitParam || 120)));
  let orderMetrics = new Map();
  let ordersAvailable = true;

  try {
    orderMetrics = await fetchOrderMetrics(dateRange);
  } catch {
    ordersAvailable = false;
  }

  const collectionsQuery = `
    query PlannerCollections($limit: Int!, $cursor: String) {
      collections(first: $limit, after: $cursor, sortKey: UPDATED_AT, reverse: true) {
        nodes {
          id
          title
          handle
          sortOrder
          updatedAt
          productsCount { count }
          image { url altText }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  `;

  const productsQuery = `
    query PlannerCollectionProducts($id: ID!, $limit: Int!, $cursor: String) {
      collection(id: $id) {
        id
        title
        handle
        sortOrder
        updatedAt
        productsCount { count }
        image { url altText }
        products(first: $limit, after: $cursor) {
          nodes {
            id
            legacyResourceId
            title
            handle
            vendor
            productType
            tags
            seasonMetafield: metafield(namespace: "custom", key: "season") { value }
            createdAt
            publishedAt
            updatedAt
            featuredImage { url altText }
            images(first: 1) { nodes { url altText } }
            variants(first: 100) {
              nodes {
                id
                legacyResourceId
                sku
                price
                inventoryQuantity
                inventoryItem { unitCost { amount currencyCode } }
              }
            }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  `;

  try {
    const allCollections = [];
    let collectionCursor = null;
    let hasMoreCollections = true;
    while (hasMoreCollections && allCollections.length < collectionLimit) {
      const remaining = fetchAllCollections ? 250 : Math.min(250, collectionLimit - allCollections.length);
      const collectionData = await shopifyGraphql(collectionsQuery, { limit: remaining, cursor: collectionCursor });
      allCollections.push(...collectionData.collections.nodes.map(normalizeCollection));
      hasMoreCollections = Boolean(collectionData.collections.pageInfo.hasNextPage);
      collectionCursor = collectionData.collections.pageInfo.endCursor;
    }
    const totalCollections = allCollections.length;
    const filteredCollections = allCollections.filter((collection) => collection.productsCount >= minCollectionProducts);
    let collections = mergeCollectionReorderAudit(filteredCollections);
    let selectedCollection = null;
    let products = [];
    let gaAvailable = false;
    let gaMessage = "";

    const targetCollectionId = collectionId || collections[0]?.id || "";
    if (targetCollectionId) {
      let cursor = null;
      let hasNextPage = true;
      while (hasNextPage && products.length < productLimit) {
        const remaining = fetchAllProducts ? 100 : Math.min(100, productLimit - products.length);
        const productData = await shopifyGraphql(productsQuery, { id: targetCollectionId, limit: remaining, cursor });
        if (!productData.collection) {
          sendJson(res, 404, { configured: true, message: "Collection not found.", collections });
          return;
        }

        selectedCollection = mergeCollectionReorderAudit([normalizeCollection(productData.collection)])[0];
        const positionOffset = products.length;
        products.push(...productData.collection.products.nodes.map((product, index) => ({
          ...normalizeProduct(product, orderMetrics),
          currentPosition: positionOffset + index + 1
        })));
        hasNextPage = Boolean(productData.collection.products.pageInfo.hasNextPage);
        cursor = productData.collection.products.pageInfo.endCursor;
      }

      try {
        const ga = await fetchGaMetrics(dateRange);
        gaAvailable = ga.available;
        gaMessage = ga.message;
        products = mergeGaMetrics(products, ga.metrics);
      } catch (error) {
        gaMessage = error.message;
      }
    }

    sendJson(res, 200, {
      configured: true,
      syncedAt: new Date().toISOString(),
      days,
      ordersAvailable,
      gaAvailable,
      gaMessage,
      collections,
      totalCollections,
      minCollectionProducts,
      selectedCollection,
      products
    });
  } catch (error) {
    sendJson(res, 502, { configured: true, message: error.message });
  }
}

function collectionReorderAuditMap() {
  const db = openOrderSqliteDb();
  const rows = db.prepare(`
    SELECT collection_id, collection_gid, collection_title, collection_handle, applied_at, total_products, total_moves, strategy, scope
    FROM collection_reorder_audit
    ORDER BY applied_at DESC
  `).all();
  const latest = new Map();
  for (const row of rows) {
    if (latest.has(row.collection_gid)) continue;
    latest.set(row.collection_gid, {
      collectionId: row.collection_gid,
      legacyCollectionId: row.collection_id,
      collectionTitle: row.collection_title,
      collectionHandle: row.collection_handle,
      appliedAt: row.applied_at,
      totalProducts: row.total_products,
      totalMoves: row.total_moves,
      strategy: row.strategy,
      scope: row.scope
    });
  }
  return latest;
}

function mergeCollectionReorderAudit(collections) {
  const audit = collectionReorderAuditMap();
  return collections.map((collection) => ({
    ...collection,
    lastReorder: audit.get(collection.id) || null
  }));
}

function recordCollectionReorder(job) {
  const db = openOrderSqliteDb();
  const appliedAt = job.finishedAt || new Date().toISOString();
  db.prepare(`
    INSERT INTO collection_reorder_audit (
      id,
      collection_id,
      collection_gid,
      collection_title,
      collection_handle,
      applied_at,
      total_products,
      total_moves,
      strategy,
      scope,
      data
    ) VALUES (
      @id,
      @collectionId,
      @collectionGid,
      @collectionTitle,
      @collectionHandle,
      @appliedAt,
      @totalProducts,
      @totalMoves,
      @strategy,
      @scope,
      @data
    )
  `).run({
    id: job.id,
    collectionId: collectionNumericId(job.collectionId),
    collectionGid: job.collectionId,
    collectionTitle: job.collectionTitle || "",
    collectionHandle: job.collectionHandle || "",
    appliedAt,
    totalProducts: job.totalProducts || 0,
    totalMoves: job.totalMoves || 0,
    strategy: job.strategy || "",
    scope: job.scope || "",
    data: JSON.stringify(publicCollectionReorderJob(job))
  });
}

const collectionReorderJobs = new Map();

function publicCollectionReorderJob(job) {
  if (!job) return null;
  return {
    id: job.id,
    status: job.status,
    collectionId: job.collectionId,
    collectionTitle: job.collectionTitle,
    collectionHandle: job.collectionHandle,
    strategy: job.strategy,
    scope: job.scope,
    totalProducts: job.totalProducts,
    totalMoves: job.totalMoves,
    processedMoves: job.processedMoves,
    batchesCompleted: job.batchesCompleted,
    batchesSubmitted: job.batchesSubmitted,
    shopifyJobs: job.shopifyJobs,
    message: job.message,
    error: job.error,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt
  };
}

async function fetchCollectionApplyState(collectionId) {
  const query = `
    query CollectionApplyState($id: ID!, $limit: Int!, $cursor: String) {
      collection(id: $id) {
        id
        title
        handle
        sortOrder
        productsCount { count }
        products(first: $limit, after: $cursor) {
          nodes { id }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  `;
  let collection = null;
  const productIds = [];
  let cursor = null;
  let hasNextPage = true;
  while (hasNextPage) {
    const data = await shopifyGraphql(query, { id: collectionId, limit: 250, cursor });
    if (!data.collection) return null;
    collection = data.collection;
    productIds.push(...data.collection.products.nodes.map((product) => product.id));
    hasNextPage = Boolean(data.collection.products.pageInfo.hasNextPage);
    cursor = data.collection.products.pageInfo.endCursor;
  }
  return { collection: normalizeCollection(collection), productIds };
}

function uniqueIds(ids) {
  const seen = new Set();
  return (ids || []).filter((id) => {
    const value = String(id || "").trim();
    if (!value || seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

function sameIdSet(left, right) {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((id) => rightSet.has(id));
}

function nextCollectionMoveBatch(currentOrder, targetOrder, limit = 250) {
  const moves = [];
  for (let index = 0; index < targetOrder.length && moves.length < limit; index += 1) {
    const wantedId = targetOrder[index];
    if (currentOrder[index] === wantedId) continue;
    const currentIndex = currentOrder.indexOf(wantedId);
    if (currentIndex === -1) continue;
    currentOrder.splice(currentIndex, 1);
    currentOrder.splice(index, 0, wantedId);
    moves.push({ id: wantedId, newPosition: String(index) });
  }
  return moves;
}

async function submitCollectionReorderBatch(collectionId, moves) {
  const mutation = `
    mutation CollectionReorderProducts($id: ID!, $moves: [MoveInput!]!) {
      collectionReorderProducts(id: $id, moves: $moves) {
        job { id done }
        userErrors { field message }
      }
    }
  `;
  const data = await shopifyGraphql(mutation, { id: collectionId, moves });
  const payload = data.collectionReorderProducts;
  const errors = payload.userErrors || [];
  if (errors.length) {
    throw new Error(errors.map((error) => error.message).join("; "));
  }
  return payload.job || null;
}

async function pollShopifyJob(jobId) {
  if (!jobId) return;
  const query = `
    query ShopifyJob($id: ID!) {
      job(id: $id) { id done }
    }
  `;
  for (let attempt = 0; attempt < 90; attempt += 1) {
    const data = await shopifyGraphql(query, { id: jobId });
    if (data.job?.done) return;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(`Shopify reorder job did not finish in time: ${jobId}`);
}

async function runCollectionReorderJob(job) {
  try {
    job.status = "running";
    job.message = "Checking the live Shopify collection order...";
    const applyState = await fetchCollectionApplyState(job.collectionId);
    if (!applyState) throw new Error("Collection not found in Shopify.");
    if (applyState.collection.sortOrder !== "MANUAL") {
      throw new Error("Can't reorder products unless the collection sort order is MANUAL.");
    }

    const targetProductIds = uniqueIds(job.targetProductIds);
    if (targetProductIds.length !== job.targetProductIds.length) {
      throw new Error("Suggested order contains duplicate or blank product IDs.");
    }
    if (!sameIdSet(applyState.productIds, targetProductIds)) {
      throw new Error("Suggested order does not match the live collection products. Sync the full collection again before applying.");
    }

    const currentOrder = [...applyState.productIds];
    const targetOrder = [...targetProductIds];
    job.totalProducts = targetOrder.length;
    job.totalMoves = 0;
    while (true) {
      const previewOrder = [...currentOrder];
      const moves = nextCollectionMoveBatch(previewOrder, targetOrder, 250);
      if (!moves.length) break;
      job.totalMoves += moves.length;
      currentOrder.splice(0, currentOrder.length, ...previewOrder);
    }

    currentOrder.splice(0, currentOrder.length, ...applyState.productIds);
    if (!job.totalMoves) {
      job.status = "complete";
      job.message = "Shopify collection already matches the suggested order.";
      job.finishedAt = new Date().toISOString();
      return;
    }

    while (true) {
      const moves = nextCollectionMoveBatch(currentOrder, targetOrder, 250);
      if (!moves.length) break;
      job.message = `Submitting Shopify reorder batch ${job.batchesSubmitted + 1}...`;
      const shopifyJob = await submitCollectionReorderBatch(job.collectionId, moves);
      job.batchesSubmitted += 1;
      if (shopifyJob?.id) {
        job.shopifyJobs.push(shopifyJob.id);
        job.message = `Waiting for Shopify batch ${job.batchesSubmitted} to finish...`;
        await pollShopifyJob(shopifyJob.id);
      }
      job.processedMoves += moves.length;
      job.batchesCompleted += 1;
      job.message = `Applied ${job.processedMoves.toLocaleString("en-GB")} of ${job.totalMoves.toLocaleString("en-GB")} moves.`;
    }

    job.status = "complete";
    job.message = `Applied ${job.totalMoves.toLocaleString("en-GB")} product moves to Shopify.`;
    job.finishedAt = new Date().toISOString();
    recordCollectionReorder(job);
  } catch (error) {
    job.status = "error";
    job.error = error.message;
    job.message = error.message;
    job.finishedAt = new Date().toISOString();
  }
}

async function startCollectionReorder(req, res) {
  const { shop, clientId, clientSecret } = shopifyConfig();
  if (!shop || !clientId || !clientSecret) {
    sendJson(res, 200, {
      configured: false,
      message: "Set SHOPIFY_SHOP, SHOPIFY_CLIENT_ID, and SHOPIFY_CLIENT_SECRET to apply Shopify collection order."
    });
    return;
  }

  const body = await readJsonBody(req);
  const collectionId = String(body.collectionId || "").trim();
  const collectionTitle = String(body.collectionTitle || "").trim();
  const collectionHandle = String(body.collectionHandle || "").trim();
  const targetProductIds = uniqueIds(body.targetProductIds);
  const confirmText = String(body.confirmText || "").trim().toUpperCase();

  if (!collectionId || !targetProductIds.length) {
    sendJson(res, 400, { message: "Missing collection or suggested product order." });
    return;
  }
  if (confirmText !== "APPLY") {
    sendJson(res, 400, { message: "Type APPLY to confirm the Shopify reorder." });
    return;
  }

  const job = {
    id: crypto.randomUUID(),
    status: "queued",
    collectionId,
    collectionTitle,
    collectionHandle,
    targetProductIds,
    strategy: String(body.strategy || "").trim(),
    scope: String(body.scope || "").trim(),
    totalProducts: targetProductIds.length,
    totalMoves: 0,
    processedMoves: 0,
    batchesCompleted: 0,
    batchesSubmitted: 0,
    shopifyJobs: [],
    message: "Queued Shopify collection reorder.",
    error: "",
    startedAt: new Date().toISOString(),
    finishedAt: ""
  };
  collectionReorderJobs.set(job.id, job);
  runCollectionReorderJob(job);
  sendJson(res, 202, { configured: true, job: publicCollectionReorderJob(job) });
}

function getCollectionReorderJob(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const job = collectionReorderJobs.get(url.searchParams.get("id"));
  if (!job) {
    sendJson(res, 404, { message: "Reorder job not found. If the server restarted, sync the collection and check Shopify before applying again." });
    return;
  }
  sendJson(res, 200, { job: publicCollectionReorderJob(job) });
}

function timingSafeEqual(a, b) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && require("node:crypto").timingSafeEqual(left, right);
}

function isAuthorized(req) {
  const username = process.env.APP_USERNAME;
  const password = process.env.APP_PASSWORD;
  if (!username || !password) return true;

  const header = req.headers.authorization || "";
  if (!header.startsWith("Basic ")) return false;

  const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  const splitAt = decoded.indexOf(":");
  if (splitAt === -1) return false;

  const givenUser = decoded.slice(0, splitAt);
  const givenPass = decoded.slice(splitAt + 1);
  return timingSafeEqual(givenUser, username) && timingSafeEqual(givenPass, password);
}

function requireAuth(res) {
  res.writeHead(401, {
    "www-authenticate": 'Basic realm="Merch X", charset="UTF-8"',
    "content-type": "text/plain; charset=utf-8"
  });
  res.end("Authentication required");
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type, authorization"
  });
  res.end(JSON.stringify(payload));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
      if (body.length > 6_000_000) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function emptyOrderDb() {
  return {
    suppliers: [],
    products: [],
    orders: [],
    company: {
      name: "AMG Retail Ltd",
      department: "Womenswear",
      billingAddress: "7 Eggleston Court, Riverside Park, Middlesbrough, Cleveland, TS2 1RU",
      country: "United Kingdom",
      taxNumber: "TBC",
      buyerEmail: "Buying@kitandkaboodal.com"
    },
    delivery: {
      name: "Care of Kit and Kaboodal",
      site: "Torque, Normanton",
      street: "400 California Drive",
      city: "Castleford",
      postcode: "WF10 5QH",
      country: "United Kingdom"
    }
  };
}

let orderSqliteDb = null;

function parseJson(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch (error) {
    return fallback;
  }
}

function openOrderSqliteDb() {
  if (orderSqliteDb) return orderSqliteDb;
  fs.mkdirSync(path.dirname(sqliteDbPath), { recursive: true });
  orderSqliteDb = new Database(sqliteDbPath);
  orderSqliteDb.pragma("journal_mode = WAL");
  orderSqliteDb.pragma("foreign_keys = ON");
  orderSqliteDb.exec(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS suppliers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      reference TEXT,
      last_order_number TEXT,
      last_ordered_at TEXT,
      data TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sku TEXT NOT NULL UNIQUE,
      style TEXT,
      supplier_name TEXT,
      last_order_number TEXT,
      last_ordered_at TEXT,
      data TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS issued_skus (
      sku TEXT PRIMARY KEY,
      issued_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      data TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      order_number TEXT NOT NULL UNIQUE,
      supplier_name TEXT,
      order_date TEXT,
      status TEXT,
      saved_at TEXT NOT NULL,
      data TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS collection_reorder_audit (
      id TEXT PRIMARY KEY,
      collection_id TEXT NOT NULL,
      collection_gid TEXT NOT NULL,
      collection_title TEXT NOT NULL,
      collection_handle TEXT,
      applied_at TEXT NOT NULL,
      total_products INTEGER DEFAULT 0,
      total_moves INTEGER DEFAULT 0,
      strategy TEXT,
      scope TEXT,
      data TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_collection_reorder_audit_gid ON collection_reorder_audit(collection_gid);
    CREATE INDEX IF NOT EXISTS idx_collection_reorder_audit_applied ON collection_reorder_audit(applied_at);
    CREATE INDEX IF NOT EXISTS idx_issued_skus_issued_at ON issued_skus(issued_at);
  `);
  importOrderJsonIfNeeded(orderSqliteDb);
  return orderSqliteDb;
}

function importOrderJsonIfNeeded(db) {
  const hasRows =
    db.prepare("SELECT COUNT(*) AS count FROM suppliers").get().count ||
    db.prepare("SELECT COUNT(*) AS count FROM products").get().count ||
    db.prepare("SELECT COUNT(*) AS count FROM orders").get().count;
  if (hasRows || !fs.existsSync(orderDbPath)) return;

  const imported = parseJson(fs.readFileSync(orderDbPath, "utf8"), null);
  if (!imported) return;
  writeOrderDbToSqlite(db, { ...emptyOrderDb(), ...imported });
}

function writeOrderDbToSqlite(db, dbData) {
  const write = db.transaction((data) => {
    db.prepare("DELETE FROM suppliers").run();
    db.prepare("DELETE FROM products").run();
    db.prepare("DELETE FROM orders").run();

    const setSetting = db.prepare(`
      INSERT INTO app_settings (key, value, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
    `);
    setSetting.run("company", JSON.stringify(data.company || emptyOrderDb().company));
    setSetting.run("delivery", JSON.stringify(data.delivery || emptyOrderDb().delivery));

    const insertSupplier = db.prepare(`
      INSERT INTO suppliers (name, reference, last_order_number, last_ordered_at, data, updated_at)
      VALUES (@name, @reference, @lastOrderNumber, @lastOrderedAt, @data, CURRENT_TIMESTAMP)
    `);
    for (const supplier of data.suppliers || []) {
      if (!supplier?.name) continue;
      insertSupplier.run({
        name: supplier.name,
        reference: supplier.reference || "",
        lastOrderNumber: supplier.lastOrderNumber || "",
        lastOrderedAt: supplier.lastOrderedAt || "",
        data: JSON.stringify(supplier)
      });
    }

    const insertProduct = db.prepare(`
      INSERT INTO products (sku, style, supplier_name, last_order_number, last_ordered_at, data, updated_at)
      VALUES (@sku, @style, @supplierName, @lastOrderNumber, @lastOrderedAt, @data, CURRENT_TIMESTAMP)
    `);
    for (const product of data.products || []) {
      if (!product?.sku) continue;
      insertProduct.run({
        sku: product.sku,
        style: product.style || product.description || "",
        supplierName: product.supplierName || "",
        lastOrderNumber: product.lastOrderNumber || "",
        lastOrderedAt: product.lastOrderedAt || "",
        data: JSON.stringify(product)
      });
    }

    const insertOrder = db.prepare(`
      INSERT INTO orders (id, order_number, supplier_name, order_date, status, saved_at, data, updated_at)
      VALUES (@id, @orderNumber, @supplierName, @orderDate, @status, @savedAt, @data, CURRENT_TIMESTAMP)
    `);
    for (const order of data.orders || []) {
      if (!order?.id || !order?.orderNumber) continue;
      insertOrder.run({
        id: String(order.id),
        orderNumber: order.orderNumber,
        supplierName: order.supplier?.name || "",
        orderDate: order.orderDate || "",
        status: order.status || "",
        savedAt: order.savedAt || new Date().toISOString(),
        data: JSON.stringify(order)
      });
    }
  });
  write(dbData);
}

function readOrderDb() {
  const db = openOrderSqliteDb();
  const defaults = emptyOrderDb();
  const company = parseJson(db.prepare("SELECT value FROM app_settings WHERE key = ?").get("company")?.value, defaults.company);
  const delivery = parseJson(db.prepare("SELECT value FROM app_settings WHERE key = ?").get("delivery")?.value, defaults.delivery);
  return {
    suppliers: db.prepare("SELECT data FROM suppliers ORDER BY name COLLATE NOCASE").all().map(row => parseJson(row.data, null)).filter(Boolean),
    products: db.prepare("SELECT data FROM products ORDER BY updated_at").all().map(row => parseJson(row.data, null)).filter(Boolean),
    orders: db.prepare("SELECT data FROM orders ORDER BY saved_at").all().map(row => parseJson(row.data, null)).filter(Boolean),
    company,
    delivery
  };
}

function writeOrderDb(db) {
  writeOrderDbToSqlite(openOrderSqliteDb(), db);
}

function nextOrderNumber(db) {
  const year = new Date().getFullYear();
  const prefix = `PO-${year}-`;
  const max = db.orders.reduce((highest, order) => {
    const orderNumber = String(order.orderNumber || "");
    if (!orderNumber.startsWith(prefix)) return highest;
    const n = Number(orderNumber.slice(prefix.length));
    return Number.isFinite(n) ? Math.max(highest, n) : highest;
  }, 0);
  return `${prefix}${String(max + 1).padStart(4, "0")}`;
}

function parseIssuedSku(value) {
  const match = String(value || "").trim().toUpperCase().match(/^(.*?)(\d+)$/);
  if (!match) return null;
  return { prefix: match[1], number: Number(match[2]), width: match[2].length, sku: `${match[1]}${match[2]}` };
}

function incrementIssuedSku(value) {
  const parsed = parseIssuedSku(value) || { prefix: "AMG-", number: 0, width: 5 };
  return `${parsed.prefix}${String(parsed.number + 1).padStart(parsed.width, "0")}`;
}

function compareIssuedSku(a, b) {
  const parsedA = parseIssuedSku(a);
  const parsedB = parseIssuedSku(b);
  if (!parsedA) return parsedB ? -1 : 0;
  if (!parsedB) return 1;
  if (parsedA.prefix === parsedB.prefix) return parsedA.number - parsedB.number;
  return parsedA.sku.localeCompare(parsedB.sku);
}

function highestIssuedSku(dbData, storedSku = "") {
  const stored = parseIssuedSku(storedSku);
  const prefix = stored?.prefix || "AMG-";
  const candidates = [storedSku];
  for (const row of readIssuedSkuRows()) candidates.push(row.sku);
  return candidates
    .filter((sku) => parseIssuedSku(sku)?.prefix === prefix)
    .reduce((highest, sku) => compareIssuedSku(sku, highest) > 0 ? normalizeSku(sku) : highest, stored ? normalizeSku(storedSku) : "");
}

function getLastIssuedSku(dbData) {
  const db = openOrderSqliteDb();
  const storedSku = db.prepare("SELECT value FROM app_settings WHERE key = ?").get("lastIssuedSku")?.value || "";
  const sku = highestIssuedSku(dbData, storedSku);
  if (sku) reserveIssuedSku(sku, { source: "lastIssuedSku" });
  return sku;
}

function setLastIssuedSku(sku) {
  const normalized = normalizeSku(sku);
  if (!parseIssuedSku(normalized)) return;
  reserveIssuedSku(normalized, { source: "issue" });
  openOrderSqliteDb().prepare(`
    INSERT INTO app_settings (key, value, updated_at)
    VALUES ('lastIssuedSku', ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
  `).run(normalized);
}

function normalizeSku(sku) {
  return String(sku || "").trim().toUpperCase();
}

function readIssuedSkuRows() {
  return openOrderSqliteDb().prepare("SELECT sku, issued_at AS issuedAt, data FROM issued_skus ORDER BY issued_at DESC").all()
    .map(row => ({ ...row, data: parseJson(row.data, {}) }));
}

function reserveIssuedSku(sku, data = {}) {
  const normalized = normalizeSku(sku);
  if (!parseIssuedSku(normalized)) return;
  openOrderSqliteDb().prepare(`
    INSERT INTO issued_skus (sku, data, issued_at, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(sku) DO UPDATE SET
      data = COALESCE(issued_skus.data, excluded.data),
      updated_at = CURRENT_TIMESTAMP
  `).run(normalized, JSON.stringify(data || {}));
}

function isNonShopifySavedProduct(product) {
  if (!product?.sku) return false;
  return String(product.source || "").trim().toLowerCase() !== "shopify";
}

function savedLocalSkuRows(dbData) {
  const productRows = (dbData.products || [])
    .filter(isNonShopifySavedProduct)
    .map((product) => {
      const sku = normalizeSku(product.sku);
      return {
      sku: product.sku || "",
      buyingCode: product.buyingCode || product.supplierSku || "",
      style: product.style || product.description || "",
      category: product.category || "",
      colour: product.colour || product.color || "",
      size: product.size || "",
      season: product.season || "",
      supplierName: product.supplierName || "",
      repeatType: product.repeatType || "",
      quantity: Number(product.quantity || 0),
      unitCostEur: Number(product.unitCostEur || 0),
      unitCostGbp: Number(product.unitCostGbp || product.unitCost || 0),
      rrp: Number(product.rrp || 0),
      exitRetail: Number(product.exitRetail || 0),
      imageUrl: product.imageUrl || "",
      lastOrderNumber: product.lastOrderNumber || "",
      lastOrderedAt: product.lastOrderedAt || "",
      source: product.source || "saved",
      status: "Saved product",
      canDelete: false,
      data: product,
      normalizedSku: sku
    };
    });
  const savedSkuSet = new Set(productRows.map(product => product.normalizedSku));
  const issuedRows = readIssuedSkuRows()
    .filter(row => !savedSkuSet.has(normalizeSku(row.sku)))
    .map(row => ({
      sku: row.sku,
      buyingCode: "",
      style: "",
      category: "",
      colour: "",
      size: "",
      season: "",
      supplierName: "",
      repeatType: "",
      quantity: 0,
      unitCostEur: 0,
      unitCostGbp: 0,
      rrp: 0,
      exitRetail: 0,
      imageUrl: "",
      lastOrderNumber: "",
      lastOrderedAt: row.issuedAt || "",
      source: "issued",
      status: "Issued only",
      canDelete: true,
      data: { sku: row.sku, issuedAt: row.issuedAt, ...(row.data || {}) },
      normalizedSku: normalizeSku(row.sku)
    }));
  return [...productRows, ...issuedRows]
    .sort((a, b) => compareIssuedSku(b.sku, a.sku) || String(a.sku).localeCompare(String(b.sku)));
}

function skuHasAttachedData(dbData, sku) {
  const normalized = normalizeSku(sku);
  if (!normalized) return false;
  if ((dbData.products || []).some(product => normalizeSku(product.sku) === normalized)) return true;
  return (dbData.orders || []).some(order => (order.lines || []).some(line => normalizeSku(line.sku) === normalized));
}

function upsertByKey(items, key, value, patch) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return;
  const index = items.findIndex(item => String(item[key] || "").trim().toLowerCase() === normalized);
  if (index === -1) {
    items.push(patch);
  } else {
    items[index] = { ...items[index], ...patch };
  }
}

async function shopifyLookupBySku(sku) {
  const { shop, clientId, clientSecret } = shopifyConfig();
  if (!shop || !clientId || !clientSecret) return { configured: false, product: null };

  const data = await shopifyGraphql(`query ProductBySku($query: String!) {
    productVariants(first: 1, query: $query) {
      edges {
        node {
          sku
          title
          price
          inventoryQuantity
          image { url }
          product {
            title
            productType
            vendor
            featuredImage { url }
            metafield(namespace: "custom", key: "season") { value }
          }
        }
      }
    }
  }`, { query: `sku:${sku}` });

  const node = data?.productVariants?.edges?.[0]?.node;
  if (!node) return { configured: true, product: null };

  return {
    configured: true,
    product: {
      sku: node.sku || sku,
      style: node.product?.title || "",
      variant: node.title || "",
      category: node.product?.productType || "",
      supplierName: node.product?.vendor || "",
      rrp: node.price || "",
      season: node.product?.metafield?.value || "",
      imageUrl: node.image?.url || node.product?.featuredImage?.url || "",
      inventoryQuantity: node.inventoryQuantity ?? null,
      source: "shopify"
    }
  };
}

async function handleApi(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "GET" && url.pathname === "/api/order-form/bootstrap") {
    const db = readOrderDb();
    sendJson(res, 200, {
      suppliers: db.suppliers,
      products: [],
      orders: db.orders.slice(-20).reverse(),
      company: db.company,
      delivery: db.delivery,
      nextOrderNumber: nextOrderNumber(db),
      lastIssuedSku: getLastIssuedSku(db),
      shopifyConfigured: Boolean(shopifyConfig().shop && shopifyConfig().clientId && shopifyConfig().clientSecret)
    });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/order-form/local-skus") {
    const db = readOrderDb();
    const lastIssuedSku = getLastIssuedSku(db);
    const products = savedLocalSkuRows(db);
    sendJson(res, 200, {
      products,
      count: products.length,
      lastIssuedSku,
      generatedAt: new Date().toISOString()
    });
    return true;
  }

  if (req.method === "DELETE" && url.pathname === "/api/order-form/local-skus") {
    const sku = normalizeSku(url.searchParams.get("sku"));
    if (!sku) {
      sendJson(res, 400, { error: "Missing SKU" });
      return true;
    }
    const dbData = readOrderDb();
    if (skuHasAttachedData(dbData, sku)) {
      sendJson(res, 409, { error: "This SKU has saved product or order data attached, so it cannot be deleted." });
      return true;
    }
    const db = openOrderSqliteDb();
    const deleted = db.prepare("DELETE FROM issued_skus WHERE sku = ?").run(sku).changes;
    const parsed = parseIssuedSku(sku);
    if (parsed) {
      const candidates = [];
      for (const row of readIssuedSkuRows()) candidates.push(row.sku);
      const highest = candidates
        .filter(candidate => parseIssuedSku(candidate)?.prefix === parsed.prefix)
        .reduce((current, candidate) => compareIssuedSku(candidate, current) > 0 ? normalizeSku(candidate) : current, "");
      if (highest) {
        db.prepare(`
          INSERT INTO app_settings (key, value, updated_at)
          VALUES ('lastIssuedSku', ?, CURRENT_TIMESTAMP)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
        `).run(highest);
      } else {
        db.prepare("DELETE FROM app_settings WHERE key = 'lastIssuedSku'").run();
      }
    }
    sendJson(res, 200, { ok: true, deleted: Boolean(deleted), sku });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/order-form/next-sku") {
    try {
      const body = await readJsonBody(req);
      const dbData = readOrderDb();
      const storedSku = getLastIssuedSku(dbData);
      const requestedSku = normalizeSku(body.currentSku);
      const requested = parseIssuedSku(requestedSku);
      const stored = parseIssuedSku(storedSku);
      const baseline = requested && (!stored || (requested.prefix === stored.prefix && requested.number > stored.number)) ? requestedSku : storedSku;
      const nextSku = incrementIssuedSku(baseline);
      setLastIssuedSku(nextSku);
      sendJson(res, 200, { sku: nextSku, previousSku: baseline || "" });
    } catch (error) {
      sendJson(res, 400, { error: error.message || "Could not issue SKU" });
    }
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/order-form/sku") {
    const sku = normalizeSku(url.searchParams.get("sku"));
    if (!sku) {
      sendJson(res, 400, { error: "Missing SKU" });
      return true;
    }

    const db = readOrderDb();
    const savedProduct = db.products.find(product => normalizeSku(product.sku) === sku) || null;
    try {
      const shopify = await shopifyLookupBySku(sku);
      const product = shopify.product || savedProduct;
      sendJson(res, 200, {
        found: Boolean(product),
        product,
        source: shopify.product ? "shopify" : savedProduct ? "saved" : null,
        shopifyConfigured: shopify.configured,
        message: shopify.configured ? "" : "Set SHOPIFY_SHOP, SHOPIFY_CLIENT_ID, and SHOPIFY_CLIENT_SECRET to enable live Shopify lookups."
      });
    } catch (error) {
      sendJson(res, 200, {
        found: Boolean(savedProduct),
        product: savedProduct,
        source: savedProduct ? "saved" : null,
        shopifyConfigured: true,
        message: error.message
      });
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/order-form/orders") {
    try {
      const order = await readJsonBody(req);
      const db = readOrderDb();
      const savedOrder = {
        ...order,
        id: order.id || `${Date.now()}`,
        orderNumber: order.orderNumber || nextOrderNumber(db),
        savedAt: new Date().toISOString()
      };
      db.orders = db.orders.filter(item => item.id !== savedOrder.id && item.orderNumber !== savedOrder.orderNumber);
      db.orders.push(savedOrder);

      if (savedOrder.supplier?.name) {
        upsertByKey(db.suppliers, "name", savedOrder.supplier.name, {
          ...savedOrder.supplier,
          lastOrderNumber: savedOrder.orderNumber,
          lastOrderedAt: savedOrder.savedAt
        });
      }

      for (const line of savedOrder.lines || []) {
        if (!line.sku) continue;
        upsertByKey(db.products, "sku", line.sku, {
          ...line,
          supplierName: savedOrder.supplier?.name || line.supplierName || "",
          lastOrderNumber: savedOrder.orderNumber,
          lastOrderedAt: savedOrder.savedAt
        });
      }

      const lastIssuedSku = highestIssuedSku(db, getLastIssuedSku(db));
      writeOrderDb(db);
      setLastIssuedSku(lastIssuedSku);
      sendJson(res, 200, { ok: true, order: savedOrder, nextOrderNumber: nextOrderNumber(db) });
    } catch (error) {
      sendJson(res, 400, { error: error.message || "Could not save order" });
    }
    return true;
  }

  return false;
}

function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const safePath = path.normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
  const requestedPath = safePath === path.sep ? "index.html" : safePath.slice(1);
  const filePath = path.join(publicDir, requestedPath);

  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      fs.readFile(path.join(publicDir, "index.html"), (indexError, indexData) => {
        if (indexError) {
          res.writeHead(404);
          res.end("Not found");
          return;
        }
        res.writeHead(200, { "content-type": mimeTypes[".html"] });
        res.end(indexData);
      });
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { "content-type": mimeTypes[ext] || "application/octet-stream" });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS" && req.url.startsWith("/api/")) {
    res.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "content-type, authorization"
    });
    res.end();
    return;
  }

  if (!isAuthorized(req)) {
    requireAuth(res);
    return;
  }

  if (req.url.startsWith("/api/shopify-merchandising")) {
    fetchShopifyMerchandising(req, res).catch((error) => {
      sendJson(res, 500, { message: error.message });
    });
    return;
  }

  if (req.url.startsWith("/api/shopify-collection-planner")) {
    fetchCollectionPlanner(req, res).catch((error) => {
      sendJson(res, 500, { message: error.message });
    });
    return;
  }

  if (req.method === "POST" && req.url.startsWith("/api/shopify-collection-reorder/start")) {
    startCollectionReorder(req, res).catch((error) => {
      sendJson(res, 500, { message: error.message });
    });
    return;
  }

  if (req.method === "GET" && req.url.startsWith("/api/shopify-collection-reorder/status")) {
    getCollectionReorderJob(req, res);
    return;
  }

  if (req.url.startsWith("/api/google-auth/start")) {
    startGoogleAuth(req, res);
    return;
  }

  if (req.url.startsWith("/api/google-auth/callback")) {
    finishGoogleAuth(req, res).catch((error) => {
      sendHtml(res, 500, `<p>Google OAuth failed.</p><pre>${escapeHtml(error.message)}</pre>`);
    });
    return;
  }

  if (req.url.startsWith("/api/")) {
    const handled = await handleApi(req, res);
    if (!handled) sendJson(res, 404, { error: "Not found" });
    return;
  }

  serveStatic(req, res);
});

server.listen(port, () => {
  console.log(`Merch X running at http://localhost:${port}`);
});
