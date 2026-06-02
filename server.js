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
    "access-control-allow-methods": "GET, POST, OPTIONS",
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
  const apiVersion = process.env.SHOPIFY_API_VERSION || "2025-04";
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
    throw new Error(`Shopify API error: ${detail}`);
  }
  return json.data;
}

function productSeason(product) {
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

function emptyGaMetric() {
  return { views: 0, adds: 0, purchases: 0, revenue: 0 };
}

async function fetchGaMetrics(days) {
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
      dateRanges: [{ startDate: `${days}daysAgo`, endDate: "today" }],
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

async function fetchOrderMetrics(days) {
  const metrics = new Map();
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  let cursor = null;
  let hasNextPage = true;
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
    const data = await shopifyGraphql(query, { cursor, query: `created_at:>=${since}` });
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
  const limit = Math.max(12, Math.min(250, Number(url.searchParams.get("limit") || 120)));
  let orderMetrics = new Map();
  let ordersAvailable = true;
  try {
    orderMetrics = await fetchOrderMetrics(days);
  } catch {
    ordersAvailable = false;
  }
  const query = `
    query MerchProducts($limit: Int!) {
      products(first: $limit, sortKey: UPDATED_AT, reverse: true) {
        nodes {
          id
          legacyResourceId
          title
          handle
          vendor
          productType
          tags
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
      }
    }
  `;
  try {
    const data = await shopifyGraphql(query, { limit });
    let gaAvailable = false;
    let gaMessage = "";
    let products = data.products.nodes.map((product) => normalizeProduct(product, orderMetrics));
    try {
      const ga = await fetchGaMetrics(days);
      gaAvailable = ga.available;
      gaMessage = ga.message;
      products = mergeGaMetrics(products, ga.metrics);
    } catch (error) {
      gaMessage = error.message;
    }
    sendJson(res, 200, { configured: true, syncedAt: new Date().toISOString(), days, ordersAvailable, gaAvailable, gaMessage, products });
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
  const collectionId = url.searchParams.get("collectionId") || "";
  const collectionLimit = Math.max(10, Math.min(100, Number(url.searchParams.get("collectionLimit") || 60)));
  const productLimitParam = url.searchParams.get("productLimit") || "120";
  const fetchAllProducts = productLimitParam === "all";
  const productLimit = fetchAllProducts ? Infinity : Math.max(12, Math.min(250, Number(productLimitParam || 120)));
  let orderMetrics = new Map();
  let ordersAvailable = true;

  try {
    orderMetrics = await fetchOrderMetrics(days);
  } catch {
    ordersAvailable = false;
  }

  const collectionsQuery = `
    query PlannerCollections($limit: Int!) {
      collections(first: $limit, sortKey: UPDATED_AT, reverse: true) {
        nodes {
          id
          title
          handle
          sortOrder
          updatedAt
          productsCount { count }
          image { url altText }
        }
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
    const collectionData = await shopifyGraphql(collectionsQuery, { limit: collectionLimit });
    const collections = collectionData.collections.nodes.map(normalizeCollection);
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

        selectedCollection = normalizeCollection(productData.collection);
        const positionOffset = products.length;
        products.push(...productData.collection.products.nodes.map((product, index) => ({
          ...normalizeProduct(product, orderMetrics),
          currentPosition: positionOffset + index + 1
        })));
        hasNextPage = Boolean(productData.collection.products.pageInfo.hasNextPage);
        cursor = productData.collection.products.pageInfo.endCursor;
      }

      try {
        const ga = await fetchGaMetrics(days);
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
      selectedCollection,
      products
    });
  } catch (error) {
    sendJson(res, 502, { configured: true, message: error.message });
  }
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
      if (body.length > 2_000_000) {
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

function normalizeSku(sku) {
  return String(sku || "").trim().toUpperCase();
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
      products: db.products,
      orders: db.orders.slice(-20).reverse(),
      company: db.company,
      delivery: db.delivery,
      nextOrderNumber: nextOrderNumber(db),
      shopifyConfigured: Boolean(shopifyConfig().shop && shopifyConfig().clientId && shopifyConfig().clientSecret)
    });
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

      writeOrderDb(db);
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
