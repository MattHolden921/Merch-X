const http = require("node:http");
const https = require("node:https");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");

const publicDir = path.join(__dirname, "public");
const dataDir = path.join(__dirname, "data");
const orderDbPath = path.join(dataDir, "order-form-db.json");
const envFilePath = path.join(__dirname, ".env");

function loadEnvFile() {
  if (!fs.existsSync(envFilePath)) return;

  const lines = fs.readFileSync(envFilePath, "utf8").split(/\r?\n/);
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

function writeEnvFileValue(key, value) {
  const line = `${key}=${value}`;
  if (!fs.existsSync(envFilePath)) {
    fs.writeFileSync(envFilePath, `${line}\n`);
    return;
  }

  const content = fs.readFileSync(envFilePath, "utf8");
  const lines = content.split(/\r?\n/);
  let replaced = false;
  const nextLines = lines.map((currentLine) => {
    const trimmed = currentLine.trim();
    if (!trimmed || trimmed.startsWith("#")) return currentLine;
    const equalsAt = trimmed.indexOf("=");
    if (equalsAt === -1) return currentLine;
    const currentKey = trimmed.slice(0, equalsAt).trim();
    if (currentKey !== key) return currentLine;
    replaced = true;
    return line;
  });
  if (!replaced) {
    if (nextLines.length && nextLines[nextLines.length - 1] !== "") nextLines.push("");
    nextLines.push(line);
  }
  fs.writeFileSync(envFilePath, `${nextLines.join("\n").replace(/\n*$/, "")}\n`);
}

loadEnvFile();

const port = Number(process.env.PORT || 3000);
const sqliteDbPath = process.env.DATABASE_PATH || path.join(dataDir, "merch-x.sqlite");
const uploadsDir = process.env.UPLOADS_DIR || path.join(dataDir, "uploads");
const authCookieName = "mx_session";
const oauthStateCookieName = "mx_oauth_state";
const oauthNextCookieName = "mx_oauth_next";
const csrfHeaderName = "x-csrf-token";
const sessionDurationMs = 14 * 24 * 60 * 60 * 1000;
const authRoles = ["Admin", "Buyer", "Buying Director", "Finance", "Merchandising"];

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

function authMode() {
  return String(process.env.AUTH_MODE || (process.env.APP_USERNAME && process.env.APP_PASSWORD ? "basic" : "none")).trim().toLowerCase();
}

function corsHeaders() {
  if (authMode() === "google") return {};
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
    "access-control-allow-headers": `content-type, authorization, ${csrfHeaderName}`
  };
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store, no-cache, must-revalidate",
    "pragma": "no-cache",
    "expires": "0",
    ...corsHeaders()
  });
  res.end(JSON.stringify(payload));
}

function sendHtml(res, status, html) {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store, no-cache, must-revalidate",
    "pragma": "no-cache",
    "expires": "0"
  });
  res.end(html);
}

function staticHeaders(ext) {
  const headers = { "content-type": mimeTypes[ext] || "application/octet-stream" };
  if ([".html", ".js", ".css", ".json"].includes(ext)) {
    headers["cache-control"] = "no-store, no-cache, must-revalidate";
    headers.pragma = "no-cache";
    headers.expires = "0";
  }
  return headers;
}

function safeSegment(value, fallback = "file") {
  const clean = String(value || "").trim().replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "");
  return clean || fallback;
}

function extensionForMime(mimeType, fileName = "") {
  const existing = path.extname(fileName || "").toLowerCase();
  if (existing) return existing;
  if (mimeType === "application/pdf") return ".pdf";
  if (mimeType === "image/png") return ".png";
  if (mimeType === "image/webp") return ".webp";
  if (mimeType === "image/gif") return ".gif";
  if (mimeType === "image/jpeg") return ".jpg";
  return ".bin";
}

function parseDataUrl(dataUrl) {
  const match = String(dataUrl || "").match(/^data:([^;,]+)?(?:;[^,]*)?;base64,(.+)$/);
  if (!match) return null;
  return {
    mimeType: match[1] || "application/octet-stream",
    buffer: Buffer.from(match[2], "base64")
  };
}

function publicUploadUrl(relativePath) {
  return relativePath ? `/uploads/${relativePath.replace(/\\/g, "/").split("/").map(part => encodeURIComponent(part)).join("/")}` : "";
}

function absoluteUploadPath(relativePath) {
  const normalized = path.normalize(String(relativePath || ""));
  const absolute = path.resolve(uploadsDir, normalized);
  const root = path.resolve(uploadsDir);
  if (!absolute.startsWith(root + path.sep) && absolute !== root) throw new Error("Invalid upload path");
  return absolute;
}

function writeInvoiceUpload(order, invoiceId, invoice) {
  if (!invoice?.fileData) return null;
  const parsed = parseDataUrl(invoice.fileData);
  if (!parsed) return null;
  if (parsed.buffer.length > 12_000_000) throw new Error("Choose an invoice under 12 MB.");
  const orderFolder = safeSegment(order.orderNumber || order.id, "order");
  const ext = extensionForMime(invoice.mimeType || parsed.mimeType, invoice.fileName);
  const fileName = `${safeSegment(invoiceId, "invoice")}${ext}`;
  const relativePath = path.join("invoices", orderFolder, fileName);
  const absolutePath = absoluteUploadPath(relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, parsed.buffer);
  return {
    filePath: relativePath.replace(/\\/g, "/"),
    fileSize: parsed.buffer.length,
    mimeType: invoice.mimeType || parsed.mimeType || "application/octet-stream",
    fileName: invoice.fileName || fileName
  };
}

function isDataUrl(value) {
  return /^data:/i.test(String(value || ""));
}

function writeImageUpload(folderParts, image) {
  const parsed = parseDataUrl(image?.imageData || image?.imageUrl || "");
  if (!parsed) return null;
  if (!String(parsed.mimeType || "").startsWith("image/")) throw new Error("Choose an image file.");
  if (parsed.buffer.length > 4_000_000) throw new Error("Choose an image under 4 MB after compression.");
  const folder = folderParts.map(part => safeSegment(part, "item"));
  const ext = extensionForMime(image.mimeType || parsed.mimeType, image.fileName);
  const fileName = `${safeSegment(image.label, "image")}-${crypto.randomUUID()}${ext}`;
  const relativePath = path.join(...folder, fileName);
  const absolutePath = absoluteUploadPath(relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, parsed.buffer);
  return {
    imageUrl: publicUploadUrl(relativePath),
    filePath: relativePath.replace(/\\/g, "/"),
    fileSize: parsed.buffer.length,
    mimeType: image.mimeType || parsed.mimeType || "image/jpeg",
    fileName
  };
}

function writeOrderLineImageUpload(order, line, index, imageData = "") {
  return writeImageUpload(["order-images", order.orderNumber || order.id || "drafts"], {
    imageData: imageData || line.imageUrl,
    fileName: line.imageFileName || "",
    mimeType: line.imageMimeType || "",
    label: line.sku || line.buyingCode || `line-${index + 1}`
  });
}

function writeProductImageUpload(product, imageData = "") {
  return writeImageUpload(["product-images", product.sku || "product"], {
    imageData: imageData || product.imageUrl,
    fileName: product.imageFileName || "",
    mimeType: product.imageMimeType || "",
    label: product.sku || product.style || "product"
  });
}

function materializeOrderImages(order) {
  let changed = false;
  const lines = (order.lines || []).map((line, index) => {
    if (!isDataUrl(line.imageUrl)) return line;
    const stored = writeOrderLineImageUpload(order, line, index);
    if (!stored) return line;
    changed = true;
    return { ...line, imageUrl: stored.imageUrl };
  });
  return changed ? { ...order, lines } : order;
}

function removeUploadFile(relativePath) {
  if (!relativePath) return;
  try {
    const absolutePath = absoluteUploadPath(relativePath);
    if (fs.existsSync(absolutePath)) fs.unlinkSync(absolutePath);
  } catch {
    // File cleanup should not block the order workflow.
  }
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

function requestBuffer(url) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const client = parsedUrl.protocol === "https:" ? https : http;
    const req = client.request(parsedUrl, { method: "GET" }, (response) => {
      const chunks = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => {
        const buffer = Buffer.concat(chunks);
        resolve({ ok: response.statusCode >= 200 && response.statusCode < 300, status: response.statusCode, statusText: response.statusMessage, buffer });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

function requestMultipart(url, fields, file) {
  return new Promise((resolve, reject) => {
    const boundary = `----merchx-${crypto.randomUUID()}`;
    const chunks = [];
    for (const field of fields || []) {
      chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${field.name}"\r\n\r\n${field.value}\r\n`));
    }
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.fileName || "upload"}"\r\nContent-Type: ${file.mimeType || "application/octet-stream"}\r\n\r\n`));
    chunks.push(file.buffer);
    chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`));
    const body = Buffer.concat(chunks);
    const parsedUrl = new URL(url);
    const client = parsedUrl.protocol === "https:" ? https : http;
    const req = client.request(parsedUrl, {
      method: "POST",
      headers: {
        "content-type": `multipart/form-data; boundary=${boundary}`,
        "content-length": body.length
      }
    }, (response) => {
      let raw = "";
      response.setEncoding("utf8");
      response.on("data", chunk => { raw += chunk; });
      response.on("end", () => {
        resolve({ ok: response.statusCode >= 200 && response.statusCode < 300, status: response.statusCode, statusText: response.statusMessage, body: raw });
      });
    });
    req.on("error", reject);
    req.write(body);
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
  const oauthRedirectUri = process.env.GOOGLE_OAUTH_REDIRECT_URI || "";
  const inlineJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || "";
  const credentialsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS || "";
  let credentials = null;

  if (inlineJson) {
    credentials = JSON.parse(inlineJson);
  } else if (credentialsPath && fs.existsSync(credentialsPath)) {
    credentials = JSON.parse(fs.readFileSync(credentialsPath, "utf8"));
  }

  return { propertyId, oauthClientId, oauthClientSecret, oauthRefreshToken, oauthRedirectUri, credentials };
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
  const compareAtPrices = variants.map((variant) => Number(variant.compareAtPrice || 0)).filter((value) => Number.isFinite(value) && value > 0);
  const costs = variants.map((variant) => Number(variant.inventoryItem?.unitCost?.amount || 0)).filter((value) => Number.isFinite(value) && value > 0);
  const skus = variants.map((variant) => variant.sku).filter(Boolean);
  const variantIds = variants.flatMap((variant) => [variant.id, variant.legacyResourceId]).filter(Boolean);
  const price = prices.length ? Math.min(...prices) : 0;
  const compareAtPrice = compareAtPrices.length ? Math.max(...compareAtPrices) : null;
  const cost = costs.length ? costs.reduce((sum, value) => sum + value, 0) / costs.length : null;
  const margin = price > 0 && cost > 0 ? Math.round(((price - cost) / price) * 100) : null;
  const metrics = orderMetrics.get(product.id) || { revenue: 0, units: 0 };
  const image = product.featuredImage || product.images.nodes[0] || null;
  const status = product.status || "";
  const normalizedVariants = variants.map((variant) => {
    const variantPrice = Number(variant.price || 0);
    const variantCompareAt = variant.compareAtPrice == null ? null : Number(variant.compareAtPrice || 0);
    const variantCost = variant.inventoryItem?.unitCost?.amount == null ? null : Number(variant.inventoryItem.unitCost.amount || 0);
    return {
      id: variant.id || "",
      legacyResourceId: variant.legacyResourceId || "",
      sku: variant.sku || "",
      title: variant.title || "",
      selectedOptions: variant.selectedOptions || [],
      price: variantPrice,
      compareAtPrice: variantCompareAt,
      cost: variantCost,
      inventoryQuantity: Number(variant.inventoryQuantity || 0),
      isMarkedDown: Boolean(variantCompareAt && variantCompareAt > variantPrice)
    };
  });
  return {
    id: product.id,
    status,
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
    compareAtPrice,
    isMarkedDown: Boolean(compareAtPrice && compareAtPrice > price),
    cost,
    margin,
    stock,
    variants: normalizedVariants,
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
  const configured = gaConfig().oauthRedirectUri.trim();
  if (configured) return configured;
  const protocol = req.headers["x-forwarded-proto"] || "http";
  return `${protocol}://${req.headers.host}/api/google-auth/callback`;
}

function startGoogleAuth(req, res) {
  const { oauthClientId } = gaConfig();
  const url = new URL(req.url, `http://${req.headers.host}`);
  const redirectUri = googleRedirectUri(req);
  if (!oauthClientId) {
    sendHtml(res, 500, "<p>Set GOOGLE_OAUTH_CLIENT_ID in .env, restart Merch-X, then try again.</p>");
    return;
  }

  if (url.searchParams.get("go") !== "1") {
    sendHtml(res, 200, `
      <!doctype html>
      <html lang="en">
      <head><meta charset="utf-8"><title>Connect GA4</title>
      <style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;max-width:820px;margin:40px auto;padding:0 18px;line-height:1.55}code,pre{font-family:ui-monospace,SFMono-Regular,Consolas,monospace}pre{background:#f4f4f2;border:1px solid #ddd;border-radius:8px;padding:14px;white-space:pre-wrap;word-break:break-all}.btn{display:inline-flex;align-items:center;min-height:36px;padding:0 14px;background:#2563eb;color:#fff;text-decoration:none;border-radius:4px;font-weight:650;font-size:14px}a{color:#164f7a}</style></head>
      <body>
        <h1>Connect GA4</h1>
        <p>Google must allow this exact redirect URI on the OAuth client:</p>
        <pre>${escapeHtml(redirectUri)}</pre>
        <p>If you see <strong>Error 400: redirect_uri_mismatch</strong>, open the Google Cloud OAuth client for the <code>GOOGLE_OAUTH_CLIENT_ID</code> in your <code>.env</code>, add that full URI under <strong>Authorized redirect URIs</strong>, then continue.</p>
        <p>Optional: set <code>GOOGLE_OAUTH_REDIRECT_URI=${escapeHtml(redirectUri)}</code> in <code>.env</code> to keep the redirect URI fixed if you run Merch-X on another host or port.</p>
        <p><a class="btn" href="/api/google-auth/start?go=1">Continue to Google</a></p>
      </body>
      </html>
    `);
    return;
  }

  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.searchParams.set("client_id", oauthClientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
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

  process.env.GOOGLE_OAUTH_REFRESH_TOKEN = refreshToken;
  googleToken = response.json.access_token || null;
  googleTokenExpiresAt = googleToken ? Date.now() + Number(response.json.expires_in || 3600) * 1000 : 0;

  let saveError = "";
  try {
    writeEnvFileValue("GOOGLE_OAUTH_REFRESH_TOKEN", refreshToken);
  } catch (error) {
    saveError = error.message;
  }

  sendHtml(res, 200, `
    <!doctype html>
    <html lang="en">
    <head><meta charset="utf-8"><title>Google OAuth Connected</title>
    <style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;max-width:820px;margin:40px auto;padding:0 18px;line-height:1.55}code,pre{font-family:ui-monospace,SFMono-Regular,Consolas,monospace}pre{background:#f4f4f2;border:1px solid #ddd;border-radius:8px;padding:14px;white-space:pre-wrap;word-break:break-all}a{color:#164f7a}</style></head>
    <body>
      <h1>Google OAuth Connected</h1>
      ${saveError ? `
        <p>The token is active for this running server, but Merch-X could not save it to <code>.env</code>.</p>
        <p>Add this line manually before the next restart:</p>
        <pre>GOOGLE_OAUTH_REFRESH_TOKEN=${escapeHtml(refreshToken)}</pre>
        <p><strong>Save error:</strong> ${escapeHtml(saveError)}</p>
      ` : `
        <p>The refresh token has been saved to <code>.env</code> and activated for this running server.</p>
      `}
      <p>Refresh <a href="/merchandising.html">Product merchandising</a> to pull GA4 metrics.</p>
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

function reportHash(value) {
  return crypto.createHash("sha1").update(String(value || "")).digest("hex").slice(0, 16);
}

function reportDateLabel(startDate, endDate) {
  const start = new Date(`${startDate}T00:00:00.000Z`);
  const end = new Date(`${endDate}T00:00:00.000Z`);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) return `${startDate} - ${endDate}`;
  const days = Math.max((end - start) / 864e5 + 1, 1);
  if (days > 20 && start.getUTCMonth() === end.getUTCMonth() && start.getUTCFullYear() === end.getUTCFullYear()) {
    return start.toLocaleDateString("en-GB", { month: "short", year: "numeric", timeZone: "UTC" });
  }
  const sameYear = start.getUTCFullYear() === end.getUTCFullYear();
  const startText = start.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
  const endText = end.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: sameYear ? undefined : "numeric", timeZone: "UTC" });
  const suffix = sameYear ? ` ${end.getUTCFullYear()}` : "";
  return `${startText} - ${endText}${suffix}`;
}

function reportUtcDate(value) {
  return new Date(`${value}T00:00:00.000Z`);
}

function reportDaysInclusive(range) {
  const start = reportUtcDate(range.startDate);
  const end = reportUtcDate(range.endDate);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end < start) return 0;
  return Math.floor((end - start) / 864e5) + 1;
}

function mondayForDate(date) {
  const monday = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = monday.getUTCDay() || 7;
  monday.setUTCDate(monday.getUTCDate() - day + 1);
  return monday;
}

function canonicalReportWeeks(range) {
  const start = reportUtcDate(range.startDate);
  const end = reportUtcDate(range.endDate);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end < start) return [];
  const cursor = mondayForDate(start);
  const weeks = [];
  while (cursor <= end) {
    const weekStart = new Date(cursor);
    const weekEnd = new Date(cursor);
    weekEnd.setUTCDate(weekEnd.getUTCDate() + 6);
    weeks.push({ startDate: isoDateOnly(weekStart), endDate: isoDateOnly(weekEnd) });
    cursor.setUTCDate(cursor.getUTCDate() + 7);
  }
  return weeks;
}

function validReportDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));
}

function extractReportDatesFromName(fileName) {
  const text = String(fileName || "");
  const range = text.match(/(\d{4}-\d{2}-\d{2})[_\s-]+(?:to|_)?[_\s-]*(\d{4}-\d{2}-\d{2})/i);
  if (range) {
    const start = new Date(`${range[1]}T00:00:00.000Z`);
    const end = new Date(`${range[2]}T00:00:00.000Z`);
    if (Number.isFinite(start.getTime()) && Number.isFinite(end.getTime()) && start <= end) {
      return { startDate: range[1], endDate: range[2] };
    }
  }
  const single = text.match(/(\d{4}-\d{2}-\d{2})/);
  if (single) {
    const start = new Date(`${single[1]}T00:00:00.000Z`);
    if (Number.isFinite(start.getTime())) {
      const end = new Date(start);
      end.setUTCMonth(end.getUTCMonth() + 1, 0);
      return { startDate: single[1], endDate: isoDateOnly(end) };
    }
  }
  return null;
}

function parseCsvRows(text) {
  const rows = [];
  let current = "";
  let inQuotes = false;
  let fields = [];
  const pushField = () => {
    fields.push(current);
    current = "";
  };
  for (let index = 0; index < String(text || "").length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (inQuotes) {
      if (char === '"' && next === '"') {
        current += '"';
        index += 1;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        current += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      pushField();
    } else if (char === "\n" || char === "\r") {
      pushField();
      if (char === "\r" && next === "\n") index += 1;
      rows.push(fields);
      fields = [];
    } else {
      current += char;
    }
  }
  pushField();
  if (fields.some(field => String(field).trim())) rows.push(fields);
  if (!rows.length) return [];
  const headers = rows[0].map(value => String(value || "").trim());
  return rows.slice(1)
    .filter(row => row.some(value => String(value || "").trim()))
    .map(row => {
      const item = {};
      headers.forEach((header, index) => {
        item[header] = String(row[index] || "").trim();
      });
      return item;
    });
}

function csvNumber(value) {
  const clean = String(value || "").replace(/[£,\s]/g, "");
  const parsed = Number(clean);
  return Number.isFinite(parsed) ? parsed : 0;
}

function productsFromSalesCsvRows(rows) {
  const byTitle = new Map();
  for (const row of rows) {
    const title = String(row["Product title"] || row.Title || "").trim();
    if (!title || title === "Gift Card") continue;
    const current = byTitle.get(title) || {
      id: `csv:${reportHash(title)}`,
      title,
      productType: String(row["Product type"] || "").trim(),
      units: 0,
      revenue: 0,
      grossSales: 0,
      grossProfit: 0,
      stock: null,
      price: 0,
      cost: null,
      skus: []
    };
    const units = csvNumber(row["Net items sold"]);
    const netSales = csvNumber(row["Net sales"]);
    const grossSales = csvNumber(row["Gross sales"]);
    current.units += units;
    current.revenue += netSales;
    current.grossSales += grossSales || netSales;
    current.grossProfit += csvNumber(row["Gross profit"]);
    if (units > 0) current.price = current.revenue / current.units;
    byTitle.set(title, current);
  }
  return Array.from(byTitle.values());
}

function reportRangeFromRequest(url, fallbackDays = 28) {
  const requestedStart = url.searchParams.get("startDate") || "";
  const requestedEnd = url.searchParams.get("endDate") || "";
  if (validReportDate(requestedStart) && validReportDate(requestedEnd)) {
    const start = new Date(`${requestedStart}T00:00:00.000Z`);
    const end = new Date(`${requestedEnd}T00:00:00.000Z`);
    if (Number.isFinite(start.getTime()) && Number.isFinite(end.getTime()) && start <= end) {
      const maxEnd = new Date(start);
      maxEnd.setUTCDate(maxEnd.getUTCDate() + 366);
      if (end > maxEnd) throw new Error("Choose a report range of 366 days or less.");
      return { startDate: requestedStart, endDate: requestedEnd };
    }
  }
  return dateRangeFromDays(fallbackDays);
}

function publicReportPeriod(row) {
  if (!row) return null;
  const summary = parseJson(row.summary_json, {});
  return {
    id: row.id,
    reportType: row.report_type,
    periodGrain: row.period_grain,
    startDate: row.start_date,
    endDate: row.end_date,
    label: row.label,
    sourceType: row.source_type,
    sourceId: row.source_id,
    yearBucket: row.year_bucket || "",
    status: row.status,
    lockedAt: row.locked_at || "",
    syncedAt: row.synced_at,
    updatedAt: row.updated_at,
    summary
  };
}

function readBestsellersPeriods() {
  const db = openOrderSqliteDb();
  return db.prepare(`
    SELECT *
    FROM report_periods
    WHERE report_type = 'bestsellers'
    ORDER BY start_date DESC, end_date DESC
    LIMIT 120
  `).all().map(publicReportPeriod);
}

function publicStockSnapshot(row) {
  return {
    id: row.id,
    periodId: row.period_id,
    sourceId: row.source_id || "",
    snapshotAt: row.snapshot_at,
    shopifyProductId: row.shopify_product_id || "",
    legacyResourceId: row.legacy_resource_id || "",
    productStatus: row.product_status || "",
    productTitle: row.product_title || "",
    productHandle: row.product_handle || "",
    productType: row.product_type || "",
    vendor: row.vendor || "",
    season: row.season || "",
    shopifyVariantId: row.shopify_variant_id || "",
    variantLegacyResourceId: row.variant_legacy_resource_id || "",
    sku: row.sku || "",
    variantTitle: row.variant_title || "",
    selectedOptions: parseJson(row.selected_options_json, []),
    inventoryQuantity: Number(row.inventory_quantity || 0),
    price: row.price == null ? null : Number(row.price || 0),
    compareAtPrice: row.compare_at_price == null ? null : Number(row.compare_at_price || 0),
    cost: row.cost == null ? null : Number(row.cost || 0),
    isMarkedDown: Boolean(row.is_marked_down),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function readStockSnapshots(url) {
  const db = openOrderSqliteDb();
  const where = [];
  const params = {};
  const sku = String(url.searchParams.get("sku") || "").trim();
  const productStatus = String(url.searchParams.get("status") || "").trim().toUpperCase();
  const startDate = String(url.searchParams.get("startDate") || "").trim();
  const endDate = String(url.searchParams.get("endDate") || "").trim();
  const markedDown = String(url.searchParams.get("markedDown") || "").trim();
  if (sku) {
    where.push("sku = @sku");
    params.sku = sku;
  }
  if (productStatus) {
    where.push("product_status = @productStatus");
    params.productStatus = productStatus;
  }
  if (validReportDate(startDate)) {
    where.push("date(snapshot_at) >= date(@startDate)");
    params.startDate = startDate;
  }
  if (validReportDate(endDate)) {
    where.push("date(snapshot_at) <= date(@endDate)");
    params.endDate = endDate;
  }
  if (markedDown === "1" || markedDown.toLowerCase() === "true") {
    where.push("is_marked_down = 1");
  }
  const limit = Math.max(1, Math.min(1000, Number(url.searchParams.get("limit") || 250)));
  params.limit = limit;
  const rows = db.prepare(`
    SELECT *
    FROM report_stock_snapshots
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY snapshot_at DESC, product_title COLLATE NOCASE, variant_title COLLATE NOCASE
    LIMIT @limit
  `).all(params);
  return rows.map(publicStockSnapshot);
}

function publicReportSyncJob(row) {
  if (!row) return null;
  return {
    id: row.id,
    reportType: row.report_type,
    status: row.status,
    requestedStartDate: row.requested_start_date || "",
    requestedEndDate: row.requested_end_date || "",
    currentStartDate: row.current_start_date || "",
    currentEndDate: row.current_end_date || "",
    totalSteps: Number(row.total_steps || 0),
    completedSteps: Number(row.completed_steps || 0),
    message: row.message || "",
    error: row.error || "",
    result: parseJson(row.result_json, null),
    createdAt: row.created_at,
    startedAt: row.started_at || "",
    completedAt: row.completed_at || "",
    updatedAt: row.updated_at
  };
}

function readReportSyncJob(jobId) {
  const db = openOrderSqliteDb();
  const row = db.prepare("SELECT * FROM report_sync_jobs WHERE id = ?").get(String(jobId || ""));
  return publicReportSyncJob(row);
}

function createReportSyncJob(range) {
  const db = openOrderSqliteDb();
  const days = reportDaysInclusive(range);
  const weeks = days >= 7 ? canonicalReportWeeks(range) : [];
  const job = {
    id: crypto.randomUUID(),
    reportType: "bestsellers",
    status: "queued",
    requestedStartDate: range.startDate,
    requestedEndDate: range.endDate,
    totalSteps: days < 7 ? 1 : weeks.length,
    completedSteps: 0,
    message: days < 7
      ? "Queued live ad hoc Shopify report. Ranges under 7 days are not stored."
      : `Queued ${weeks.length} Monday-Sunday week${weeks.length === 1 ? "" : "s"} for Shopify sync.`
  };
  db.prepare(`
    INSERT INTO report_sync_jobs (
      id, report_type, status, requested_start_date, requested_end_date,
      total_steps, completed_steps, message, created_at, updated_at
    )
    VALUES (
      @id, @reportType, @status, @requestedStartDate, @requestedEndDate,
      @totalSteps, @completedSteps, @message, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    )
  `).run(job);
  return readReportSyncJob(job.id);
}

function updateReportSyncJob(jobId, patch) {
  const db = openOrderSqliteDb();
  const current = db.prepare("SELECT * FROM report_sync_jobs WHERE id = ?").get(String(jobId || ""));
  if (!current) return null;
  const next = {
    status: patch.status ?? current.status,
    currentStartDate: patch.currentStartDate ?? current.current_start_date ?? "",
    currentEndDate: patch.currentEndDate ?? current.current_end_date ?? "",
    totalSteps: patch.totalSteps ?? current.total_steps ?? 0,
    completedSteps: patch.completedSteps ?? current.completed_steps ?? 0,
    message: patch.message ?? current.message ?? "",
    error: patch.error ?? current.error ?? "",
    resultJson: patch.result == null ? current.result_json || "" : JSON.stringify(patch.result),
    startedAt: patch.startedAt ?? current.started_at ?? "",
    completedAt: patch.completedAt ?? current.completed_at ?? ""
  };
  db.prepare(`
    UPDATE report_sync_jobs
    SET status = @status,
        current_start_date = @currentStartDate,
        current_end_date = @currentEndDate,
        total_steps = @totalSteps,
        completed_steps = @completedSteps,
        message = @message,
        error = @error,
        result_json = @resultJson,
        started_at = NULLIF(@startedAt, ''),
        completed_at = NULLIF(@completedAt, ''),
        updated_at = CURRENT_TIMESTAMP
    WHERE id = @id
  `).run({ id: jobId, ...next });
  return readReportSyncJob(jobId);
}

function bestsellersPeriodRow(startDate, endDate, sourceType = "shopify_api") {
  const db = openOrderSqliteDb();
  return db.prepare(`
    SELECT *
    FROM report_periods
    WHERE report_type = 'bestsellers'
      AND source_type = ?
      AND start_date = ?
      AND end_date = ?
  `).get(sourceType, startDate, endDate);
}

function bestsellersPeriodRowsForRanges(ranges, sourceType = "shopify_api") {
  return ranges.map(range => bestsellersPeriodRow(range.startDate, range.endDate, sourceType)).filter(Boolean);
}

function bestsellersPeriodRowsInRange(range, sourceType = "csv_import", yearBucket = "") {
  const db = openOrderSqliteDb();
  const params = {
    sourceType,
    startDate: range.startDate,
    endDate: range.endDate,
    yearBucket: String(yearBucket || "").trim().toUpperCase()
  };
  return db.prepare(`
    SELECT *
    FROM report_periods
    WHERE report_type = 'bestsellers'
      AND source_type = @sourceType
      AND date(start_date) >= date(@startDate)
      AND date(end_date) <= date(@endDate)
      AND (@yearBucket = '' OR upper(year_bucket) = @yearBucket)
    ORDER BY start_date ASC, end_date ASC
  `).all(params);
}

function buildBestsellersPayload(periodRow) {
  if (!periodRow) return null;
  return buildBestsellersPayloadFromPeriods([periodRow]);
}

function buildBestsellersPayloadFromPeriods(periodRows, requestedRange = null) {
  if (!periodRows.length) return null;
  const db = openOrderSqliteDb();
  const publicPeriods = periodRows.map(publicReportPeriod);
  const productsByKey = new Map();
  for (const periodRow of periodRows) {
    const period = publicReportPeriod(periodRow);
    const start = reportUtcDate(period.startDate);
    const end = reportUtcDate(period.endDate);
    const days = Number.isFinite(start.getTime()) && Number.isFinite(end.getTime()) ? Math.max((end - start) / 864e5 + 1, 1) : 7;
    const weeks = Math.max(days / 7, 1);
    const rows = db.prepare(`
    SELECT *
    FROM report_product_metrics
    WHERE period_id = ?
    ORDER BY net_sales DESC, units DESC, title COLLATE NOCASE
  `).all(periodRow.id);
    for (const row of rows) {
      const data = parseJson(row.data, {});
      const key = row.product_key || row.shopify_product_id || row.title;
      const existing = productsByKey.get(key) || {
        name: row.title,
        title: row.title,
        productKey: row.product_key,
        id: row.shopify_product_id || row.product_key,
        legacyResourceId: row.legacy_resource_id || "",
        sku: row.sku || "",
        skus: data.skus || (row.sku ? [row.sku] : []),
        status: row.product_status || data.status || "",
        cat: row.product_type || "",
        productType: row.product_type || "",
        vendor: row.vendor || "",
        season: row.season || "",
        img: row.image_url || "",
        imageUrl: row.image_url || "",
        units: 0,
        rev: 0,
        gp: 0,
        gross: 0,
        gaViews: 0,
        gaAdds: 0,
        gaPurchases: 0,
        gaRevenue: 0,
        periods: {}
      };
      const units = Number(row.units || 0);
      const rev = Number(row.net_sales || 0);
      const gross = Number(row.gross_sales || rev);
      const gp = row.gross_profit == null ? 0 : Number(row.gross_profit || 0);
      existing.units += units;
      existing.rev += rev;
      existing.gp += gp;
      existing.gross += gross;
      existing.gaViews += Number(row.ga_views || 0);
      existing.gaAdds += Number(row.ga_adds || 0);
      existing.gaPurchases += Number(row.ga_purchases || 0);
      existing.gaRevenue += Number(row.ga_revenue || 0);
      existing.periods[period.label] = { units, rev, gross, gp };
      existing.stock = row.stock == null ? existing.stock ?? null : Number(row.stock || 0);
      existing.cost = row.cost == null ? existing.cost ?? null : Number(row.cost || 0);
      existing.avgCost = existing.cost;
      existing.rrp = row.retail_price == null ? existing.rrp ?? null : Number(row.retail_price || 0);
      existing.compareAtPrice = row.compare_at_price == null ? existing.compareAtPrice ?? null : Number(row.compare_at_price || 0);
      existing.isMarkedDown = Boolean(existing.compareAtPrice && existing.rrp && existing.compareAtPrice > existing.rrp);
      productsByKey.set(key, existing);
    }
  }
  const products = Array.from(productsByKey.values()).map((product) => {
    const weeks = Math.max(publicPeriods.reduce((total, period) => total + reportDaysInclusive(period) / 7, 0), 1);
    const avgP = product.units > 0 ? product.rev / product.units : Number(product.rrp || 0);
    const gpPct = product.rev > 0 ? product.gp / product.rev * 100 : 0;
    const gpUnit = product.units > 0 ? product.gp / product.units : 0;
    const wklyU = product.units / weeks;
    const avgRevPerWeek = product.rev / weeks;
    const coverWks = product.stock != null && wklyU > 0 ? product.stock / wklyU : null;
    const forecastBuy = product.stock != null && wklyU > 0 ? Math.max(0, Math.ceil(wklyU * 8) - product.stock) : null;
    return {
      ...product,
      avgP,
      gAsp: product.units > 0 ? product.gross / product.units : avgP,
      gpPct,
      gpUnit,
      wklyU,
      avgRevPerWeek,
      coverWks,
      forecastBuy
    };
  });
  const chronologicalPeriods = [...publicPeriods].sort((a, b) => a.startDate.localeCompare(b.startDate));
  const newestPeriodsFirst = [...publicPeriods].sort((a, b) => b.startDate.localeCompare(a.startDate));
  const latestPeriod = newestPeriodsFirst[0] || publicPeriods[0];
  const minDate = requestedRange?.startDate || chronologicalPeriods[0]?.startDate || "";
  const maxDate = requestedRange?.endDate || chronologicalPeriods[chronologicalPeriods.length - 1]?.endDate || "";
  const reportWeeks = Math.max(publicPeriods.reduce((total, period) => total + reportDaysInclusive(period) / 7, 0), 1);
  const deadStock = products
    .filter(product => Number(product.stock || 0) > 0 && Number(product.units || 0) <= 0)
    .map(product => ({
      name: product.name,
      stock: product.stock,
      season: product.season,
      img: product.img,
      price: product.rrp || 0,
      sku: product.sku || ""
    }))
    .sort((a, b) => Number(b.stock || 0) - Number(a.stock || 0));
  return {
    configured: true,
    generatedAt: new Date().toISOString(),
    period: latestPeriod,
    periods: newestPeriodsFirst,
    storedPeriodGrain: "week",
    report: {
      products: products.sort((a, b) => Number(b.rev || 0) - Number(a.rev || 0)),
      minDate,
      maxDate,
      weeks: reportWeeks,
      showPeriods: publicPeriods.length > 1,
      allPeriodLabels: chronologicalPeriods.map(period => period.label),
      orderedPeriodLabels: newestPeriodsFirst.map(period => period.label),
      rosLabel: latestPeriod?.label || "latest period",
      totRev: products.reduce((sum, product) => sum + Number(product.rev || 0), 0),
      totUnits: products.reduce((sum, product) => sum + Number(product.units || 0), 0),
      totGP: products.reduce((sum, product) => sum + Number(product.gp || 0), 0),
      invTotalStock: products.reduce((sum, product) => sum + Number(product.stock || 0), 0),
      deadStock
    }
  };
}

function writeBestsellersSnapshot(periodId, payload) {
  const db = openOrderSqliteDb();
  const period = payload.period;
  const cacheKey = `${period.sourceType}:${period.startDate}:${period.endDate}`;
  db.prepare(`
    INSERT INTO report_snapshots (id, report_type, period_id, cache_key, payload_json, created_at, updated_at)
    VALUES (@id, 'bestsellers', @periodId, @cacheKey, @payload, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(report_type, cache_key) DO UPDATE SET
      period_id = excluded.period_id,
      payload_json = excluded.payload_json,
      updated_at = CURRENT_TIMESTAMP
  `).run({
    id: `snapshot:bestsellers:${reportHash(cacheKey)}`,
    periodId,
    cacheKey,
    payload: JSON.stringify(payload)
  });
}

function buildTransientBestsellersPayload(range, products, meta = {}) {
  const label = reportDateLabel(range.startDate, range.endDate);
  const weeks = Math.max(reportDaysInclusive(range) / 7, 1 / 7);
  const reportProducts = products.map((product) => {
    const units = Number(product.units || 0);
    const rev = Number(product.revenue || 0);
    const gross = Number(product.grossSales || product.revenue || 0);
    const cost = product.cost == null ? null : Number(product.cost || 0);
    const gp = product.grossProfit != null ? Number(product.grossProfit || 0) : cost != null ? rev - (cost * units) : 0;
    const avgP = units > 0 ? rev / units : Number(product.price || 0);
    const wklyU = units / weeks;
    const stock = product.stock == null ? null : Number(product.stock || 0);
    return {
      name: product.title,
      title: product.title,
      productKey: product.id || product.title,
      id: product.id || product.title,
      legacyResourceId: product.legacyResourceId || "",
      sku: (product.skus || [])[0] || "",
      skus: product.skus || [],
      status: product.status || "",
      cat: product.productType || "",
      productType: product.productType || "",
      vendor: product.vendor || "",
      season: product.season || "",
      img: product.imageUrl || "",
      imageUrl: product.imageUrl || "",
      units,
      rev,
      gp,
      gross,
      avgP,
      gAsp: units > 0 ? gross / units : avgP,
      gpPct: rev > 0 ? gp / rev * 100 : 0,
      gpUnit: units > 0 ? gp / units : 0,
      stock,
      cost,
      avgCost: cost,
      rrp: product.price == null ? null : Number(product.price || 0),
      compareAtPrice: product.compareAtPrice == null ? null : Number(product.compareAtPrice || 0),
      isMarkedDown: Boolean(product.compareAtPrice && product.compareAtPrice > product.price),
      wklyU,
      avgRevPerWeek: rev / weeks,
      coverWks: stock != null && wklyU > 0 ? stock / wklyU : null,
      forecastBuy: stock != null && wklyU > 0 ? Math.max(0, Math.ceil(wklyU * 8) - stock) : null,
      gaViews: Number(product.gaViews || 0),
      gaAdds: Number(product.gaAdds || 0),
      gaPurchases: Number(product.gaPurchases || 0),
      gaRevenue: Number(product.gaRevenue || 0),
      periods: { [label]: { units, rev, gross, gp } }
    };
  });
  const deadStock = reportProducts
    .filter(product => Number(product.stock || 0) > 0 && Number(product.units || 0) <= 0)
    .map(product => ({ name: product.name, stock: product.stock, season: product.season, img: product.img, price: product.rrp || 0, sku: product.sku || "" }))
    .sort((a, b) => Number(b.stock || 0) - Number(a.stock || 0));
  return {
    configured: true,
    stored: false,
    generatedAt: new Date().toISOString(),
    period: {
      id: `transient:bestsellers:${reportHash(`${range.startDate}:${range.endDate}`)}`,
      reportType: "bestsellers",
      periodGrain: "ad_hoc",
      startDate: range.startDate,
      endDate: range.endDate,
      label,
      sourceType: "shopify_api",
      yearBucket: "TY",
      status: "transient",
      syncedAt: new Date().toISOString(),
      summary: {
        productCount: reportProducts.length,
        totalUnits: reportProducts.reduce((sum, product) => sum + Number(product.units || 0), 0),
        totalRevenue: reportProducts.reduce((sum, product) => sum + Number(product.rev || 0), 0),
        totalStock: reportProducts.reduce((sum, product) => sum + Number(product.stock || 0), 0),
        grossProfitSource: meta.grossProfitSource || "estimated_current_cost"
      }
    },
    storedPeriodGrain: "ad_hoc",
    report: {
      products: reportProducts.sort((a, b) => Number(b.rev || 0) - Number(a.rev || 0)),
      minDate: range.startDate,
      maxDate: range.endDate,
      weeks,
      showPeriods: false,
      allPeriodLabels: [label],
      orderedPeriodLabels: [label],
      rosLabel: label,
      totRev: reportProducts.reduce((sum, product) => sum + Number(product.rev || 0), 0),
      totUnits: reportProducts.reduce((sum, product) => sum + Number(product.units || 0), 0),
      totGP: reportProducts.reduce((sum, product) => sum + Number(product.gp || 0), 0),
      invTotalStock: reportProducts.reduce((sum, product) => sum + Number(product.stock || 0), 0),
      deadStock
    }
  };
}

function persistBestsellersProducts(range, source, products, meta = {}) {
  const db = openOrderSqliteDb();
  const label = reportDateLabel(range.startDate, range.endDate);
  const sourceType = source.sourceType || "shopify_api";
  const sourceKey = source.sourceKey || `${sourceType}:${range.startDate}:${range.endDate}`;
  const sourceId = source.id || `source:bestsellers:${reportHash(sourceKey)}`;
  const periodId = `period:bestsellers:${reportHash(`${sourceType}:${range.startDate}:${range.endDate}`)}`;
  const now = new Date().toISOString();
  const periodSummary = {
    productCount: products.length,
    totalUnits: products.reduce((sum, product) => sum + Number(product.units || 0), 0),
    totalRevenue: products.reduce((sum, product) => sum + Number(product.revenue || 0), 0),
    totalStock: products.reduce((sum, product) => sum + Number(product.stock || 0), 0),
    grossProfitSource: meta.grossProfitSource || "estimated_current_cost"
  };
  const write = db.transaction(() => {
    db.prepare(`
      INSERT INTO report_sources (
        id, report_type, source_type, source_key, file_name, file_path, checksum,
        start_date, end_date, label, status, metadata, created_at, updated_at
      )
      VALUES (
        @id, 'bestsellers', @sourceType, @sourceKey, @fileName, @filePath, @checksum,
        @startDate, @endDate, @label, 'ready', @metadata, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      )
      ON CONFLICT(id) DO UPDATE SET
        source_key = excluded.source_key,
        checksum = excluded.checksum,
        start_date = excluded.start_date,
        end_date = excluded.end_date,
        label = excluded.label,
        status = excluded.status,
        metadata = excluded.metadata,
        updated_at = CURRENT_TIMESTAMP
    `).run({
      id: sourceId,
      sourceType,
      sourceKey,
      fileName: source.fileName || "",
      filePath: source.filePath || "",
      checksum: source.checksum || reportHash(JSON.stringify({ sourceKey, count: products.length, syncedAt: now })),
      startDate: range.startDate,
      endDate: range.endDate,
      label,
      metadata: JSON.stringify(meta)
    });
    db.prepare(`
      INSERT INTO report_periods (
        id, report_type, period_grain, start_date, end_date, label, source_type,
        source_id, year_bucket, status, synced_at, summary_json, created_at, updated_at
      )
      VALUES (
        @id, 'bestsellers', @periodGrain, @startDate, @endDate, @label, @sourceType,
        @sourceId, @yearBucket, 'ready', @syncedAt, @summary, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      )
      ON CONFLICT(report_type, source_type, start_date, end_date) DO UPDATE SET
        label = excluded.label,
        source_id = excluded.source_id,
        year_bucket = excluded.year_bucket,
        status = excluded.status,
        synced_at = excluded.synced_at,
        summary_json = excluded.summary_json,
        updated_at = CURRENT_TIMESTAMP
    `).run({
      id: periodId,
      periodGrain: meta.periodGrain || "custom",
      startDate: range.startDate,
      endDate: range.endDate,
      label,
      sourceType,
      sourceId,
      yearBucket: source.yearBucket || "",
      syncedAt: now,
      summary: JSON.stringify(periodSummary)
    });
    db.prepare("DELETE FROM report_product_metrics WHERE period_id = ?").run(periodId);
    db.prepare("DELETE FROM report_stock_snapshots WHERE period_id = ?").run(periodId);
    const insertProduct = db.prepare(`
      INSERT INTO report_product_metrics (
        id, period_id, product_key, shopify_product_id, legacy_resource_id, sku, title,
        product_status, product_type, vendor, season, image_url, units, net_sales, gross_sales,
        gross_profit, stock, cost, retail_price, compare_at_price, ga_views, ga_adds, ga_purchases,
        ga_revenue, data, updated_at
      )
      VALUES (
        @id, @periodId, @productKey, @shopifyProductId, @legacyResourceId, @sku, @title,
        @productStatus, @productType, @vendor, @season, @imageUrl, @units, @netSales, @grossSales,
        @grossProfit, @stock, @cost, @retailPrice, @compareAtPrice, @gaViews, @gaAdds, @gaPurchases,
        @gaRevenue, @data, CURRENT_TIMESTAMP
      )
    `);
    const insertStock = db.prepare(`
      INSERT INTO report_stock_snapshots (
        id, period_id, source_id, snapshot_at, shopify_product_id, legacy_resource_id,
        product_status, product_title, product_handle, product_type, vendor, season,
        shopify_variant_id, variant_legacy_resource_id, sku, variant_title,
        option1_name, option1_value, option2_name, option2_value, option3_name, option3_value,
        selected_options_json, inventory_quantity, price, compare_at_price, cost,
        is_marked_down, data, created_at, updated_at
      )
      VALUES (
        @id, @periodId, @sourceId, @snapshotAt, @shopifyProductId, @legacyResourceId,
        @productStatus, @productTitle, @productHandle, @productType, @vendor, @season,
        @shopifyVariantId, @variantLegacyResourceId, @sku, @variantTitle,
        @option1Name, @option1Value, @option2Name, @option2Value, @option3Name, @option3Value,
        @selectedOptionsJson, @inventoryQuantity, @price, @compareAtPrice, @cost,
        @isMarkedDown, @data, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      )
    `);
    for (const product of products) {
      const productKey = String(product.id || product.legacyResourceId || product.handle || product.title || crypto.randomUUID());
      const units = Number(product.units || 0);
      const netSales = Number(product.revenue || 0);
      const cost = product.cost == null ? null : Number(product.cost || 0);
      const grossProfit = product.grossProfit != null ? Number(product.grossProfit || 0) : cost != null ? netSales - (cost * units) : null;
      insertProduct.run({
        id: `metric:bestsellers:${reportHash(`${periodId}:${productKey}`)}`,
        periodId,
        productKey,
        shopifyProductId: product.id || "",
        legacyResourceId: product.legacyResourceId || "",
        sku: (product.skus || [])[0] || "",
        title: product.title || "",
        productStatus: product.status || "",
        productType: product.productType || "",
        vendor: product.vendor || "",
        season: product.season || "",
        imageUrl: product.imageUrl || "",
        units,
        netSales,
        grossSales: Number(product.grossSales || product.revenue || 0),
        grossProfit,
        stock: product.stock == null ? null : Number(product.stock || 0),
        cost,
        retailPrice: product.price == null ? null : Number(product.price || 0),
        compareAtPrice: product.compareAtPrice == null ? null : Number(product.compareAtPrice || 0),
        gaViews: Number(product.gaViews || 0),
        gaAdds: Number(product.gaAdds || 0),
        gaPurchases: Number(product.gaPurchases || 0),
        gaRevenue: Number(product.gaRevenue || 0),
        data: JSON.stringify(product)
      });
      for (const variant of product.variants || []) {
        const options = Array.isArray(variant.selectedOptions) ? variant.selectedOptions : [];
        const optionAt = (index) => options[index] || {};
        const variantKey = variant.id || variant.legacyResourceId || variant.sku || `${productKey}:${variant.title || "variant"}`;
        insertStock.run({
          id: `stock:bestsellers:${reportHash(`${periodId}:${variantKey}`)}`,
          periodId,
          sourceId,
          snapshotAt: now,
          shopifyProductId: product.id || "",
          legacyResourceId: product.legacyResourceId || "",
          productStatus: product.status || "",
          productTitle: product.title || "",
          productHandle: product.handle || "",
          productType: product.productType || "",
          vendor: product.vendor || "",
          season: product.season || "",
          shopifyVariantId: variant.id || "",
          variantLegacyResourceId: variant.legacyResourceId || "",
          sku: variant.sku || "",
          variantTitle: variant.title || "",
          option1Name: optionAt(0).name || "",
          option1Value: optionAt(0).value || "",
          option2Name: optionAt(1).name || "",
          option2Value: optionAt(1).value || "",
          option3Name: optionAt(2).name || "",
          option3Value: optionAt(2).value || "",
          selectedOptionsJson: JSON.stringify(options),
          inventoryQuantity: Number(variant.inventoryQuantity || 0),
          price: variant.price == null ? null : Number(variant.price || 0),
          compareAtPrice: variant.compareAtPrice == null ? null : Number(variant.compareAtPrice || 0),
          cost: variant.cost == null ? null : Number(variant.cost || 0),
          isMarkedDown: variant.isMarkedDown ? 1 : 0,
          data: JSON.stringify(variant)
        });
      }
    }
  });
  write();
  const periodRow = bestsellersPeriodRow(range.startDate, range.endDate, sourceType);
  const payload = buildBestsellersPayload(periodRow);
  writeBestsellersSnapshot(periodId, payload);
  return payload;
}

async function fetchShopifyBestsellersProducts(range) {
  const { shop, clientId, clientSecret } = shopifyConfig();
  if (!shop || !clientId || !clientSecret) {
    return {
      configured: false,
      message: "Set SHOPIFY_SHOP, SHOPIFY_CLIENT_ID, and SHOPIFY_CLIENT_SECRET to sync Shopify bestsellers.",
      products: []
    };
  }
  let orderMetrics = new Map();
  let ordersAvailable = true;
  try {
    orderMetrics = await fetchOrderMetrics(range);
  } catch {
    ordersAvailable = false;
  }
  const productQuery = "status:active,draft";
  const query = `
    query BestsellersProducts($limit: Int!, $cursor: String, $productQuery: String!) {
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
          createdAt
          publishedAt
          updatedAt
          seasonMetafield: metafield(namespace: "custom", key: "season") { value }
          featuredImage { url altText }
          images(first: 1) { nodes { url altText } }
          variants(first: 100) {
            nodes {
              id
              legacyResourceId
              sku
              title
              price
              compareAtPrice
              inventoryQuantity
              selectedOptions { name value }
              inventoryItem { unitCost { amount currencyCode } }
            }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  `;
  const rawProducts = [];
  let cursor = null;
  let hasNextPage = true;
  while (hasNextPage) {
    const data = await shopifyGraphql(query, { limit: 250, cursor, productQuery });
    rawProducts.push(...data.products.nodes);
    hasNextPage = Boolean(data.products.pageInfo.hasNextPage);
    cursor = data.products.pageInfo.endCursor;
  }
  let gaAvailable = false;
  let gaMessage = "";
  let products = rawProducts
    .map(product => normalizeProduct(product, orderMetrics));
  try {
    const ga = await fetchGaMetrics(range);
    gaAvailable = ga.available;
    gaMessage = ga.message;
    products = mergeGaMetrics(products, ga.metrics);
  } catch (error) {
    gaMessage = error.message;
  }
  return { configured: true, products, ordersAvailable, gaAvailable, gaMessage };
}

async function syncBestsellersReport(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const body = req.method === "POST" ? await readJsonBody(req) : {};
  const range = body.startDate && body.endDate
    ? reportRangeFromRequest(new URL(`http://local/?startDate=${encodeURIComponent(body.startDate)}&endDate=${encodeURIComponent(body.endDate)}`))
    : reportRangeFromRequest(url, 28);
  const payload = await runBestsellersSync(range);
  sendJson(res, 200, payload);
}

async function runBestsellersSync(range, onProgress = null) {
  if (reportDaysInclusive(range) < 7) {
    if (onProgress) onProgress({ status: "running", completedSteps: 0, totalSteps: 1, message: "Fetching live ad hoc Shopify report...", currentStartDate: range.startDate, currentEndDate: range.endDate });
    const fetched = await fetchShopifyBestsellersProducts(range);
    if (!fetched.configured) {
      return fetched;
    }
    const payload = buildTransientBestsellersPayload(range, fetched.products, {
      grossProfitSource: "estimated_current_cost"
    });
    return {
      ...payload,
      synced: true,
      stored: false,
      message: "Ad hoc ranges under 7 days are shown live and not stored.",
      ordersAvailable: fetched.ordersAvailable,
      gaAvailable: fetched.gaAvailable,
      gaMessage: fetched.gaMessage,
      periods: readBestsellersPeriods()
    };
  }
  const weeks = canonicalReportWeeks(range);
  const syncedRows = [];
  let lastFetched = { ordersAvailable: true, gaAvailable: false, gaMessage: "" };
  for (let index = 0; index < weeks.length; index += 1) {
    const week = weeks[index];
    if (onProgress) onProgress({
      status: "running",
      totalSteps: weeks.length,
      completedSteps: index,
      currentStartDate: week.startDate,
      currentEndDate: week.endDate,
      message: `Fetching Shopify week ${index + 1} of ${weeks.length}: ${reportDateLabel(week.startDate, week.endDate)}`
    });
    const fetched = await fetchShopifyBestsellersProducts(week);
    if (!fetched.configured) {
      return fetched;
    }
    lastFetched = fetched;
    if (onProgress) onProgress({
      status: "running",
      totalSteps: weeks.length,
      completedSteps: index,
      currentStartDate: week.startDate,
      currentEndDate: week.endDate,
      message: `Saving Shopify week ${index + 1} of ${weeks.length}: ${reportDateLabel(week.startDate, week.endDate)}`
    });
    persistBestsellersProducts(week, {
      sourceType: "shopify_api",
      sourceKey: `shopify_api:${week.startDate}:${week.endDate}`,
      yearBucket: "TY"
    }, fetched.products, {
      periodGrain: "week",
      ordersAvailable: fetched.ordersAvailable,
      gaAvailable: fetched.gaAvailable,
      gaMessage: fetched.gaMessage,
      grossProfitSource: "estimated_current_cost"
    });
    const row = bestsellersPeriodRow(week.startDate, week.endDate, "shopify_api");
    if (row) syncedRows.push(row);
    if (onProgress) onProgress({
      status: "running",
      totalSteps: weeks.length,
      completedSteps: index + 1,
      currentStartDate: week.startDate,
      currentEndDate: week.endDate,
      message: `Stored Shopify week ${index + 1} of ${weeks.length}: ${reportDateLabel(week.startDate, week.endDate)}`
    });
  }
  const periodRows = bestsellersPeriodRowsForRanges(weeks, "shopify_api");
  const payload = buildBestsellersPayloadFromPeriods(periodRows, {
    startDate: weeks[0]?.startDate || range.startDate,
    endDate: weeks[weeks.length - 1]?.endDate || range.endDate
  });
  return {
    ...payload,
    synced: true,
    stored: true,
    storedPeriodGrain: "week",
    storedWeeks: weeks,
    requestedRange: range,
    message: `Stored ${weeks.length} Monday-Sunday week${weeks.length === 1 ? "" : "s"}.`,
    ordersAvailable: lastFetched.ordersAvailable,
    gaAvailable: lastFetched.gaAvailable,
    gaMessage: lastFetched.gaMessage,
    periods: readBestsellersPeriods()
  };
}

function startBestsellersSyncJob(range) {
  const job = createReportSyncJob(range);
  setTimeout(async () => {
    const startedAt = new Date().toISOString();
    updateReportSyncJob(job.id, { status: "running", startedAt, message: "Starting Shopify sync..." });
    try {
      const result = await runBestsellersSync(range, (progress) => {
        updateReportSyncJob(job.id, progress);
      });
      const completedAt = new Date().toISOString();
      if (result?.configured === false) {
        updateReportSyncJob(job.id, {
          status: "error",
          completedAt,
          error: result.message || "Shopify is not configured.",
          message: result.message || "Shopify is not configured.",
          result
        });
        return;
      }
      updateReportSyncJob(job.id, {
        status: "complete",
        completedSteps: Number(job.totalSteps || 0),
        completedAt,
        message: result.message || "Bestsellers sync complete.",
        result
      });
    } catch (error) {
      updateReportSyncJob(job.id, {
        status: "error",
        completedAt: new Date().toISOString(),
        error: error.message || "Bestsellers sync failed.",
        message: error.message || "Bestsellers sync failed."
      });
    }
  }, 0);
  return job;
}

async function importBestsellersCsv(req, res) {
  const body = await readJsonBody(req);
  const files = Array.isArray(body.files) ? body.files : [];
  const yearBucket = String(body.yearBucket || "LY").trim().toUpperCase();
  if (!files.length) {
    sendJson(res, 400, { error: "Choose at least one CSV file to import." });
    return;
  }
  const imported = [];
  for (const file of files.slice(0, 24)) {
    const fileName = safeSegment(file.fileName || file.name || "bestsellers.csv", "bestsellers.csv");
    const text = String(file.text || file.content || "");
    if (!text.trim()) continue;
    const range = file.startDate && file.endDate
      ? { startDate: String(file.startDate), endDate: String(file.endDate) }
      : extractReportDatesFromName(file.fileName || file.name || "");
    if (!range || !validReportDate(range.startDate) || !validReportDate(range.endDate)) {
      throw new Error(`Could not infer dates for ${file.fileName || file.name || "CSV"}. Add YYYY-MM-DD dates to the filename.`);
    }
    const checksum = crypto.createHash("sha256").update(text).digest("hex");
    const folder = path.join("report-sources", "bestsellers", yearBucket.toLowerCase());
    const storedName = `${range.startDate}_${range.endDate}_${reportHash(checksum)}_${fileName.replace(/\.csv$/i, "")}.csv`;
    const relativePath = path.join(folder, storedName);
    const absolutePath = absoluteUploadPath(relativePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, text);
    const rows = parseCsvRows(text);
    const products = productsFromSalesCsvRows(rows);
    const payload = persistBestsellersProducts(range, {
      sourceType: "csv_import",
      sourceKey: `csv_import:${checksum}`,
      fileName,
      filePath: relativePath.replace(/\\/g, "/"),
      checksum,
      yearBucket
    }, products, {
      periodGrain: "custom",
      importedRows: rows.length,
      grossProfitSource: "csv_gross_profit"
    });
    imported.push(payload.period);
  }
  sendJson(res, 200, {
    ok: true,
    imported,
    periods: readBestsellersPeriods()
  });
}

function getBestsellersReport(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  let range;
  try {
    range = reportRangeFromRequest(url, 28);
  } catch (error) {
    sendJson(res, 400, { error: error.message });
    return;
  }
  const sourceType = url.searchParams.get("sourceType") || "shopify_api";
  const yearBucket = url.searchParams.get("yearBucket") || "";
  const periodRow = bestsellersPeriodRow(range.startDate, range.endDate, sourceType);
  if (!periodRow && sourceType === "shopify_api" && reportDaysInclusive(range) >= 7) {
    const weeks = canonicalReportWeeks(range);
    const periodRows = bestsellersPeriodRowsForRanges(weeks, sourceType);
    if (periodRows.length === weeks.length) {
      sendJson(res, 200, buildBestsellersPayloadFromPeriods(periodRows, {
        startDate: weeks[0]?.startDate || range.startDate,
        endDate: weeks[weeks.length - 1]?.endDate || range.endDate
      }));
      return;
    }
    const foundKeys = new Set(periodRows.map(row => `${row.start_date}:${row.end_date}`));
    const missingWeeks = weeks
      .filter(week => !foundKeys.has(`${week.startDate}:${week.endDate}`))
      .map(week => ({
        startDate: week.startDate,
        endDate: week.endDate,
        label: reportDateLabel(week.startDate, week.endDate)
      }));
    if (missingWeeks.length) {
      sendJson(res, 404, {
        error: `Missing cached week${missingWeeks.length === 1 ? "" : "s"}: ${missingWeeks.map(week => week.label).join(", ")}. Sync Shopify to fill the gaps.`,
        startDate: range.startDate,
        endDate: range.endDate,
        sourceType,
        missingWeeks
      });
      return;
    }
  }
  if (!periodRow && sourceType !== "shopify_api") {
    const periodRows = bestsellersPeriodRowsInRange(range, sourceType, yearBucket);
    if (periodRows.length) {
      sendJson(res, 200, buildBestsellersPayloadFromPeriods(periodRows, range));
      return;
    }
  }
  if (!periodRow) {
    sendJson(res, 404, {
      error: "No cached bestsellers report exists for that period yet.",
      startDate: range.startDate,
      endDate: range.endDate,
      sourceType,
      yearBucket
    });
    return;
  }
  sendJson(res, 200, buildBestsellersPayload(periodRow));
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

function splitEnvList(value) {
  return String(value || "").split(/[,\s]+/).map(item => item.trim()).filter(Boolean);
}

function adminEmailSet() {
  return new Set(splitEnvList(process.env.APP_ADMIN_EMAILS).map(email => email.toLowerCase()));
}

function allowedGoogleDomains() {
  const configured = splitEnvList(process.env.GOOGLE_ALLOWED_DOMAINS).map(domain => domain.toLowerCase().replace(/^@/, ""));
  if (configured.length) return configured;
  return [...adminEmailSet()].map(email => email.split("@")[1]).filter(Boolean);
}

function parseCookies(req) {
  const cookies = {};
  for (const part of String(req.headers.cookie || "").split(";")) {
    const equalsAt = part.indexOf("=");
    if (equalsAt === -1) continue;
    const key = part.slice(0, equalsAt).trim();
    const value = part.slice(equalsAt + 1).trim();
    if (key) cookies[key] = decodeURIComponent(value);
  }
  return cookies;
}

function isSecureRequest(req) {
  return req.socket.encrypted || String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim() === "https";
}

function appendHeader(res, name, value) {
  const current = res.getHeader(name);
  if (!current) {
    res.setHeader(name, value);
  } else if (Array.isArray(current)) {
    res.setHeader(name, [...current, value]);
  } else {
    res.setHeader(name, [current, value]);
  }
}

function setCookie(req, res, name, value, options = {}) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax"
  ];
  if (options.maxAge != null) parts.push(`Max-Age=${Math.max(0, Number(options.maxAge || 0))}`);
  if (options.expires) parts.push(`Expires=${options.expires.toUTCString()}`);
  if (isSecureRequest(req)) parts.push("Secure");
  appendHeader(res, "Set-Cookie", parts.join("; "));
}

function clearCookie(req, res, name) {
  setCookie(req, res, name, "", { maxAge: 0, expires: new Date(0) });
}

function sessionHash(token) {
  return crypto.createHmac("sha256", process.env.SESSION_SECRET || "merch-x-dev-session-secret").update(String(token || "")).digest("hex");
}

function publicUser(row) {
  if (!row) return null;
  const roles = parseJson(row.roles_json, []);
  return {
    id: row.id,
    email: row.email || "",
    displayName: row.display_name || row.email || "",
    roles: Array.isArray(roles) ? roles.filter(role => authRoles.includes(role)) : [],
    isAdmin: Boolean(row.is_admin),
    isActive: Boolean(row.is_active),
    lastLoginAt: row.last_login_at || "",
    createdAt: row.created_at || ""
  };
}

function systemUser() {
  return {
    id: "system",
    email: "",
    displayName: "Team",
    roles: ["Admin"],
    isAdmin: true,
    isActive: true,
    csrfToken: ""
  };
}

function actorName(req) {
  return req.currentUser?.displayName || req.currentUser?.email || "Team";
}

function actorData(req) {
  return req.currentUser?.id && req.currentUser.id !== "system"
    ? { actorUserId: req.currentUser.id, actorEmail: req.currentUser.email || "" }
    : {};
}

function userHasRole(user, roles) {
  if (!user?.isActive) return false;
  if (user.isAdmin || (user.roles || []).includes("Admin")) return true;
  return roles.some(role => (user.roles || []).includes(role));
}

function requireRoles(req, res, roles, message = "You do not have permission to do that.") {
  if (authMode() !== "google") return true;
  if (userHasRole(req.currentUser, roles)) return true;
  sendJson(res, 403, { error: message });
  return false;
}

function rolesFromEnv(key, fallback) {
  const configured = splitEnvList(process.env[key]).filter(role => authRoles.includes(role));
  return configured.length ? configured : fallback;
}

function skuRegisterRoles() {
  return rolesFromEnv("SKU_REGISTER_ROLES", ["Admin", "Buyer"]);
}

function readSessionUser(req) {
  const token = parseCookies(req)[authCookieName];
  if (!token) return null;
  const db = openOrderSqliteDb();
  const row = db.prepare(`
    SELECT s.csrf_token, s.expires_at, u.*
    FROM auth_sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ?
  `).get(sessionHash(token));
  if (!row || !row.is_active || new Date(row.expires_at).getTime() <= Date.now()) return null;
  db.prepare("UPDATE auth_sessions SET last_seen_at = CURRENT_TIMESTAMP WHERE token_hash = ?").run(sessionHash(token));
  return { ...publicUser(row), csrfToken: row.csrf_token || "" };
}

function createSession(req, res, userId) {
  const token = crypto.randomBytes(32).toString("base64url");
  const csrfToken = crypto.randomBytes(24).toString("base64url");
  const expiresAt = new Date(Date.now() + sessionDurationMs).toISOString();
  openOrderSqliteDb().prepare(`
    INSERT INTO auth_sessions (id, user_id, token_hash, csrf_token, expires_at, created_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run(crypto.randomUUID(), userId, sessionHash(token), csrfToken, expiresAt);
  setCookie(req, res, authCookieName, token, { maxAge: Math.floor(sessionDurationMs / 1000), expires: new Date(Date.now() + sessionDurationMs) });
}

function destroySession(req, res) {
  const token = parseCookies(req)[authCookieName];
  if (token) openOrderSqliteDb().prepare("DELETE FROM auth_sessions WHERE token_hash = ?").run(sessionHash(token));
  clearCookie(req, res, authCookieName);
}

function sendRedirect(res, location) {
  res.writeHead(302, { location });
  res.end();
}

function isPublicAuthPath(req) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  return url.pathname === "/login.html"
    || url.pathname === "/design-system.css"
    || url.pathname === "/auth.js"
    || url.pathname === "/favicon.ico"
    || url.pathname === "/api/auth/me"
    || url.pathname === "/api/auth/google/start"
    || url.pathname === "/api/auth/google/callback";
}

function hasBasicCredentials() {
  const username = process.env.APP_USERNAME;
  const password = process.env.APP_PASSWORD;
  return Boolean(username && password);
}

function isBasicAuthorized(req) {
  if (!hasBasicCredentials()) return true;
  const username = process.env.APP_USERNAME;
  const password = process.env.APP_PASSWORD;
  const header = req.headers.authorization || "";
  if (!header.startsWith("Basic ")) return false;

  const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  const splitAt = decoded.indexOf(":");
  if (splitAt === -1) return false;

  const givenUser = decoded.slice(0, splitAt);
  const givenPass = decoded.slice(splitAt + 1);
  return timingSafeEqual(givenUser, username) && timingSafeEqual(givenPass, password);
}

function isAuthorized(req) {
  const mode = authMode();
  if ((mode === "google" || mode === "basic") && hasBasicCredentials() && !isBasicAuthorized(req)) {
    req.authFailure = "basic";
    return false;
  }

  if (mode === "google") {
    if (isPublicAuthPath(req)) return true;
    const user = readSessionUser(req);
    if (!user) {
      req.authFailure = "google";
      return false;
    }
    req.currentUser = user;
    return true;
  }

  if (mode === "basic" || mode === "none") {
    req.currentUser = systemUser();
    return true;
  }

  req.currentUser = systemUser();
  return true;
}

function requireAuth(req, res) {
  if (req.authFailure === "basic") {
    res.writeHead(401, {
      "www-authenticate": 'Basic realm="Merch X", charset="UTF-8"',
      "content-type": "text/plain; charset=utf-8"
    });
    res.end("Authentication required");
    return;
  }
  if (authMode() === "google") {
    if (req.url.startsWith("/api/") || req.url.startsWith("/uploads/")) {
      sendJson(res, 401, { error: "Authentication required", loginUrl: "/login.html" });
      return;
    }
    sendRedirect(res, `/login.html?next=${encodeURIComponent(req.url || "/")}`);
    return;
  }
  res.writeHead(401, {
    "www-authenticate": 'Basic realm="Merch X", charset="UTF-8"',
    "content-type": "text/plain; charset=utf-8"
  });
  res.end("Authentication required");
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store, no-cache, must-revalidate",
    "pragma": "no-cache",
    "expires": "0",
    ...corsHeaders()
  });
  res.end(JSON.stringify(payload));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
      if (body.length > 18_000_000) {
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

function verifyCsrf(req, res) {
  if (authMode() !== "google") return true;
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return true;
  if (req.url.startsWith("/api/auth/google/")) return true;
  const sent = String(req.headers[csrfHeaderName] || "");
  const expected = String(req.currentUser?.csrfToken || "");
  if (sent && expected && timingSafeEqual(sent, expected)) return true;
  sendJson(res, 403, { error: "Security check failed. Refresh the page and try again." });
  return false;
}

function googleAuthConfig(req) {
  const protocol = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim() || (req.socket.encrypted ? "https" : "http");
  return {
    clientId: process.env.GOOGLE_AUTH_CLIENT_ID || "",
    clientSecret: process.env.GOOGLE_AUTH_CLIENT_SECRET || "",
    redirectUri: process.env.GOOGLE_AUTH_REDIRECT_URI || `${protocol}://${req.headers.host}/api/auth/google/callback`
  };
}

function startGoogleAppAuth(req, res) {
  const { clientId, redirectUri } = googleAuthConfig(req);
  if (!clientId) {
    sendHtml(res, 500, "<p>Google sign-in is not configured. Set GOOGLE_AUTH_CLIENT_ID and GOOGLE_AUTH_CLIENT_SECRET.</p>");
    return;
  }
  const url = new URL(req.url, `http://${req.headers.host}`);
  const state = crypto.randomBytes(24).toString("base64url");
  const next = String(url.searchParams.get("next") || "/");
  setCookie(req, res, oauthStateCookieName, state, { maxAge: 600 });
  setCookie(req, res, oauthNextCookieName, next.startsWith("/") ? next : "/", { maxAge: 600 });
  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", "openid email profile");
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("nonce", crypto.randomBytes(16).toString("base64url"));
  const domains = allowedGoogleDomains();
  if (domains.length === 1) authUrl.searchParams.set("hd", domains[0]);
  sendRedirect(res, authUrl.toString());
}

function base64UrlJson(value) {
  return JSON.parse(Buffer.from(String(value || ""), "base64url").toString("utf8"));
}

let googleJwksCache = { expiresAt: 0, keys: [] };

async function googleJwks() {
  if (Date.now() < googleJwksCache.expiresAt && googleJwksCache.keys.length) return googleJwksCache.keys;
  const response = await requestJson("https://www.googleapis.com/oauth2/v3/certs");
  const maxAgeMatch = String(response.headers?.["cache-control"] || "").match(/max-age=(\d+)/i);
  googleJwksCache = {
    keys: response.json.keys || [],
    expiresAt: Date.now() + Number(maxAgeMatch?.[1] || 3600) * 1000
  };
  return googleJwksCache.keys;
}

async function verifyGoogleIdToken(idToken, expectedAudience) {
  const parts = String(idToken || "").split(".");
  if (parts.length !== 3) throw new Error("Invalid Google ID token.");
  const header = base64UrlJson(parts[0]);
  const payload = base64UrlJson(parts[1]);
  const key = (await googleJwks()).find(item => item.kid === header.kid);
  if (!key) throw new Error("Google signing key was not found.");
  const verifier = crypto.createVerify("RSA-SHA256");
  verifier.update(`${parts[0]}.${parts[1]}`);
  verifier.end();
  const ok = verifier.verify(crypto.createPublicKey({ key, format: "jwk" }), Buffer.from(parts[2], "base64url"));
  if (!ok) throw new Error("Google ID token signature could not be verified.");
  if (!["accounts.google.com", "https://accounts.google.com"].includes(payload.iss)) throw new Error("Invalid Google token issuer.");
  if (payload.aud !== expectedAudience) throw new Error("Invalid Google token audience.");
  if (Number(payload.exp || 0) * 1000 <= Date.now()) throw new Error("Google token has expired.");
  if (!payload.email || payload.email_verified !== true) throw new Error("Google account email is not verified.");
  const domain = String(payload.hd || payload.email.split("@")[1] || "").toLowerCase();
  const allowed = allowedGoogleDomains();
  if (!allowed.length) throw new Error("No Google Workspace domain is configured for Merch X.");
  if (!allowed.includes(domain)) throw new Error("That Google account is not allowed for Merch X.");
  return payload;
}

function upsertGoogleUser(profile) {
  const db = openOrderSqliteDb();
  const email = String(profile.email || "").toLowerCase();
  const existing = db.prepare("SELECT * FROM users WHERE google_sub = ? OR email = ?").get(String(profile.sub || ""), email);
  const adminEmails = adminEmailSet();
  const isEnvAdmin = adminEmails.has(email);
  const roles = isEnvAdmin ? ["Admin"] : parseJson(existing?.roles_json, []);
  const active = isEnvAdmin ? 1 : existing ? Number(existing.is_active || 0) : 0;
  const isAdmin = isEnvAdmin ? 1 : Number(existing?.is_admin || 0);
  const id = existing?.id || crypto.randomUUID();
  db.prepare(`
    INSERT INTO users (id, google_sub, email, display_name, roles_json, is_active, is_admin, created_at, updated_at, last_login_at)
    VALUES (@id, @googleSub, @email, @displayName, @rolesJson, @isActive, @isAdmin, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET
      google_sub = excluded.google_sub,
      email = excluded.email,
      display_name = excluded.display_name,
      roles_json = excluded.roles_json,
      is_active = excluded.is_active,
      is_admin = excluded.is_admin,
      updated_at = CURRENT_TIMESTAMP,
      last_login_at = CURRENT_TIMESTAMP
  `).run({
    id,
    googleSub: String(profile.sub || ""),
    email,
    displayName: String(profile.name || email).trim(),
    rolesJson: JSON.stringify(Array.isArray(roles) ? roles.filter(role => authRoles.includes(role)) : []),
    isActive: active,
    isAdmin
  });
  return db.prepare("SELECT * FROM users WHERE id = ?").get(id);
}

async function finishGoogleAppAuth(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const expectedState = parseCookies(req)[oauthStateCookieName] || "";
  const returnedState = String(url.searchParams.get("state") || "");
  clearCookie(req, res, oauthStateCookieName);
  const next = parseCookies(req)[oauthNextCookieName] || "/";
  clearCookie(req, res, oauthNextCookieName);
  if (!expectedState || !returnedState || !timingSafeEqual(expectedState, returnedState)) {
    sendHtml(res, 401, "<p>Google sign-in failed the security check. Please try again.</p>");
    return;
  }
  const code = String(url.searchParams.get("code") || "");
  if (!code) {
    sendHtml(res, 400, "<p>Google did not return an authorization code.</p>");
    return;
  }
  const { clientId, clientSecret, redirectUri } = googleAuthConfig(req);
  const tokenResponse = await requestJson("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code"
    }).toString()
  });
  if (!tokenResponse.ok || !tokenResponse.json.id_token) {
    throw new Error(tokenResponse.json.error_description || tokenResponse.json.error || "Google token exchange failed.");
  }
  const profile = await verifyGoogleIdToken(tokenResponse.json.id_token, clientId);
  const user = upsertGoogleUser(profile);
  if (!user.is_active) {
    sendHtml(res, 403, `
      <main style="font-family:system-ui,sans-serif;max-width:560px;margin:48px auto;line-height:1.6">
        <h1>Access pending</h1>
        <p>Your Google account is valid, but a Merch X admin needs to activate <strong>${escapeHtml(user.email)}</strong> before you can use the app.</p>
        <p><a href="/login.html">Back to sign in</a></p>
      </main>
    `);
    return;
  }
  createSession(req, res, user.id);
  sendRedirect(res, next.startsWith("/") ? next : "/");
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
  orderSqliteDb.pragma("busy_timeout = 5000");
  orderSqliteDb.exec(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      google_sub TEXT UNIQUE,
      email TEXT NOT NULL UNIQUE,
      display_name TEXT,
      roles_json TEXT NOT NULL DEFAULT '[]',
      is_active INTEGER NOT NULL DEFAULT 0,
      is_admin INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_login_at TEXT
    );

    CREATE TABLE IF NOT EXISTS auth_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      csrf_token TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS work_handoffs (
      id TEXT PRIMARY KEY,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      from_role TEXT,
      to_role TEXT,
      from_user_id TEXT,
      to_user_id TEXT,
      message TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      created_by_user_id TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      completed_by_user_id TEXT,
      completed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      entity_type TEXT,
      entity_id TEXT,
      title TEXT NOT NULL,
      body TEXT,
      url TEXT,
      is_read INTEGER NOT NULL DEFAULT 0,
      email_status TEXT NOT NULL DEFAULT 'not_configured',
      email_error TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      read_at TEXT,
      emailed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS suppliers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      reference TEXT,
      status TEXT DEFAULT 'Active',
      country TEXT,
      lead_time_days REAL DEFAULT 0,
      moq REAL DEFAULT 0,
      currency TEXT,
      incoterms TEXT,
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
      supplier_sku TEXT,
      product_type TEXT,
      season TEXT,
      colour TEXT,
      size TEXT,
      unit_cost_gbp REAL DEFAULT 0,
      rrp REAL DEFAULT 0,
      compare_at_price REAL DEFAULT 0,
      barcode TEXT,
      product_status TEXT DEFAULT 'Draft',
      shopify_product_gid TEXT,
      shopify_variant_gid TEXT,
      shopify_status TEXT,
      sync_status TEXT DEFAULT 'Not synced',
      last_synced_at TEXT,
      last_order_number TEXT,
      last_ordered_at TEXT,
      data TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS product_sync_events (
      id TEXT PRIMARY KEY,
      product_id INTEGER,
      sku TEXT,
      action TEXT NOT NULL,
      actor_name TEXT,
      shopify_product_gid TEXT,
      payload_summary TEXT,
      result TEXT NOT NULL,
      error TEXT,
      data TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
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
      archived_at TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS order_workflows (
      order_id TEXT PRIMARY KEY,
      approval_status TEXT NOT NULL DEFAULT 'Not requested',
      approval_by TEXT,
      approval_decided_at TEXT,
      approval_notes TEXT,
      payment_status TEXT NOT NULL DEFAULT 'Not due',
      payment_type TEXT,
      payment_amount REAL DEFAULT 0,
      payment_due_date TEXT,
      payment_paid_date TEXT,
      payment_reference TEXT,
      payment_notes TEXT,
      intake_status TEXT NOT NULL DEFAULT 'Not confirmed',
      intake_eta_date TEXT,
      intake_confirmed_date TEXT,
      intake_actual_date TEXT,
      intake_reference TEXT,
      intake_notes TEXT,
      pah_uploaded INTEGER NOT NULL DEFAULT 0,
      next_action_owner TEXT,
      next_action_user_id TEXT,
      next_action TEXT,
      data TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS order_events (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      actor_name TEXT,
      message TEXT NOT NULL,
      data TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS order_invoices (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL,
      batch_id TEXT,
      invoice_type TEXT,
      invoice_number TEXT,
      invoice_date TEXT,
      due_date TEXT,
      amount REAL DEFAULT 0,
      currency TEXT,
      is_received INTEGER DEFAULT 0,
      sent_to_fd INTEGER DEFAULT 0,
      status TEXT,
      file_name TEXT,
      mime_type TEXT,
      file_path TEXT,
      file_size INTEGER DEFAULT 0,
      file_data TEXT,
      notes TEXT,
      uploaded_by TEXT,
      uploaded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS order_batches (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL,
      batch_number TEXT,
      title TEXT,
      style_count REAL DEFAULT 0,
      units REAL DEFAULT 0,
      value REAL DEFAULT 0,
      currency TEXT,
      payment_status TEXT,
      intake_status TEXT,
      eta_date TEXT,
      shipped_date TEXT,
      received_date TEXT,
      tracking_reference TEXT,
      style_notes TEXT,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS order_batch_lines (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL,
      batch_id TEXT NOT NULL,
      line_index INTEGER NOT NULL,
      sku TEXT,
      buying_code TEXT,
      style TEXT,
      quantity REAL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
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

    CREATE TABLE IF NOT EXISTS report_sources (
      id TEXT PRIMARY KEY,
      report_type TEXT NOT NULL,
      source_type TEXT NOT NULL,
      source_key TEXT,
      file_name TEXT,
      file_path TEXT,
      checksum TEXT,
      start_date TEXT,
      end_date TEXT,
      label TEXT,
      status TEXT NOT NULL DEFAULT 'ready',
      metadata TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS report_periods (
      id TEXT PRIMARY KEY,
      report_type TEXT NOT NULL,
      period_grain TEXT NOT NULL DEFAULT 'custom',
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      label TEXT NOT NULL,
      source_type TEXT NOT NULL,
      source_id TEXT,
      year_bucket TEXT,
      status TEXT NOT NULL DEFAULT 'ready',
      locked_at TEXT,
      synced_at TEXT NOT NULL,
      summary_json TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS report_product_metrics (
      id TEXT PRIMARY KEY,
      period_id TEXT NOT NULL,
      product_key TEXT NOT NULL,
      shopify_product_id TEXT,
      legacy_resource_id TEXT,
      sku TEXT,
      title TEXT NOT NULL,
      product_status TEXT,
      product_type TEXT,
      vendor TEXT,
      season TEXT,
      image_url TEXT,
      units REAL DEFAULT 0,
      net_sales REAL DEFAULT 0,
      gross_sales REAL DEFAULT 0,
      gross_profit REAL,
      stock REAL,
      cost REAL,
      retail_price REAL,
      compare_at_price REAL,
      ga_views REAL DEFAULT 0,
      ga_adds REAL DEFAULT 0,
      ga_purchases REAL DEFAULT 0,
      ga_revenue REAL DEFAULT 0,
      data TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS report_stock_snapshots (
      id TEXT PRIMARY KEY,
      period_id TEXT NOT NULL,
      source_id TEXT,
      snapshot_at TEXT NOT NULL,
      shopify_product_id TEXT,
      legacy_resource_id TEXT,
      product_status TEXT,
      product_title TEXT NOT NULL,
      product_handle TEXT,
      product_type TEXT,
      vendor TEXT,
      season TEXT,
      shopify_variant_id TEXT,
      variant_legacy_resource_id TEXT,
      sku TEXT,
      variant_title TEXT,
      option1_name TEXT,
      option1_value TEXT,
      option2_name TEXT,
      option2_value TEXT,
      option3_name TEXT,
      option3_value TEXT,
      selected_options_json TEXT,
      inventory_quantity REAL DEFAULT 0,
      price REAL,
      compare_at_price REAL,
      cost REAL,
      is_marked_down INTEGER DEFAULT 0,
      data TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS report_sync_jobs (
      id TEXT PRIMARY KEY,
      report_type TEXT NOT NULL,
      status TEXT NOT NULL,
      requested_start_date TEXT,
      requested_end_date TEXT,
      current_start_date TEXT,
      current_end_date TEXT,
      total_steps INTEGER DEFAULT 0,
      completed_steps INTEGER DEFAULT 0,
      message TEXT,
      error TEXT,
      result_json TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      started_at TEXT,
      completed_at TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS report_snapshots (
      id TEXT PRIMARY KEY,
      report_type TEXT NOT NULL,
      period_id TEXT,
      cache_key TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS weekly_actions (
      id TEXT PRIMARY KEY,
      dedupe_key TEXT NOT NULL,
      action_type TEXT NOT NULL,
      title TEXT NOT NULL,
      product_key TEXT,
      product_title TEXT NOT NULL,
      sku TEXT,
      season TEXT,
      category TEXT,
      owner TEXT NOT NULL,
      assignee_user_id TEXT,
      status TEXT NOT NULL DEFAULT 'Open',
      priority TEXT NOT NULL DEFAULT 'Medium',
      due_date TEXT,
      source_type TEXT NOT NULL DEFAULT 'bestsellers',
      source_period_id TEXT,
      source_start_date TEXT,
      source_end_date TEXT,
      source_label TEXT,
      rationale TEXT,
      metrics_json TEXT,
      data TEXT,
      generated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      completed_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS weekly_action_events (
      id TEXT PRIMARY KEY,
      action_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      actor_name TEXT,
      message TEXT NOT NULL,
      data TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_collection_reorder_audit_gid ON collection_reorder_audit(collection_gid);
    CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
    CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions(user_id, expires_at);
    CREATE INDEX IF NOT EXISTS idx_work_handoffs_entity ON work_handoffs(entity_type, entity_id, status);
    CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, is_read, created_at);
    CREATE INDEX IF NOT EXISTS idx_collection_reorder_audit_applied ON collection_reorder_audit(applied_at);
    CREATE INDEX IF NOT EXISTS idx_issued_skus_issued_at ON issued_skus(issued_at);
    CREATE INDEX IF NOT EXISTS idx_order_events_order_created ON order_events(order_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_order_invoices_order ON order_invoices(order_id, updated_at);
    CREATE INDEX IF NOT EXISTS idx_order_batches_order ON order_batches(order_id, updated_at);
    CREATE INDEX IF NOT EXISTS idx_order_batch_lines_order ON order_batch_lines(order_id, batch_id, line_index);
    CREATE INDEX IF NOT EXISTS idx_report_sources_lookup ON report_sources(report_type, source_type, start_date, end_date);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_report_periods_unique ON report_periods(report_type, source_type, start_date, end_date);
    CREATE INDEX IF NOT EXISTS idx_report_periods_dates ON report_periods(report_type, start_date, end_date);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_report_product_metrics_unique ON report_product_metrics(period_id, product_key);
    CREATE INDEX IF NOT EXISTS idx_report_product_metrics_title ON report_product_metrics(title);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_report_stock_snapshots_unique ON report_stock_snapshots(period_id, shopify_variant_id, sku);
    CREATE INDEX IF NOT EXISTS idx_report_stock_snapshots_sku ON report_stock_snapshots(sku, snapshot_at);
    CREATE INDEX IF NOT EXISTS idx_report_stock_snapshots_status ON report_stock_snapshots(product_status, snapshot_at);
    CREATE INDEX IF NOT EXISTS idx_report_sync_jobs_status ON report_sync_jobs(report_type, status, created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_report_snapshots_cache ON report_snapshots(report_type, cache_key);
    CREATE INDEX IF NOT EXISTS idx_weekly_actions_status ON weekly_actions(status, owner, priority, due_date);
    CREATE INDEX IF NOT EXISTS idx_weekly_actions_dedupe ON weekly_actions(dedupe_key, status, updated_at);
    CREATE INDEX IF NOT EXISTS idx_weekly_actions_source ON weekly_actions(source_period_id, action_type);
    CREATE INDEX IF NOT EXISTS idx_weekly_action_events_action ON weekly_action_events(action_id, created_at);
  `);
  const orderColumns = orderSqliteDb.prepare("PRAGMA table_info(orders)").all().map(column => column.name);
  if (!orderColumns.includes("archived_at")) {
    orderSqliteDb.prepare("ALTER TABLE orders ADD COLUMN archived_at TEXT").run();
  }
  const invoiceColumns = orderSqliteDb.prepare("PRAGMA table_info(order_invoices)").all().map(column => column.name);
  if (!invoiceColumns.includes("batch_id")) {
    orderSqliteDb.prepare("ALTER TABLE order_invoices ADD COLUMN batch_id TEXT").run();
  }
  if (!invoiceColumns.includes("file_path")) {
    orderSqliteDb.prepare("ALTER TABLE order_invoices ADD COLUMN file_path TEXT").run();
  }
  if (!invoiceColumns.includes("file_size")) {
    orderSqliteDb.prepare("ALTER TABLE order_invoices ADD COLUMN file_size INTEGER DEFAULT 0").run();
  }
  const workflowColumns = orderSqliteDb.prepare("PRAGMA table_info(order_workflows)").all().map(column => column.name);
  if (!workflowColumns.includes("next_action_user_id")) {
    orderSqliteDb.prepare("ALTER TABLE order_workflows ADD COLUMN next_action_user_id TEXT").run();
  }
  if (!workflowColumns.includes("pah_uploaded")) {
    orderSqliteDb.prepare("ALTER TABLE order_workflows ADD COLUMN pah_uploaded INTEGER NOT NULL DEFAULT 0").run();
  }
  const weeklyColumns = orderSqliteDb.prepare("PRAGMA table_info(weekly_actions)").all().map(column => column.name);
  if (weeklyColumns.length && !weeklyColumns.includes("assignee_user_id")) {
    orderSqliteDb.prepare("ALTER TABLE weekly_actions ADD COLUMN assignee_user_id TEXT").run();
  }
  const metricColumns = orderSqliteDb.prepare("PRAGMA table_info(report_product_metrics)").all().map(column => column.name);
  if (!metricColumns.includes("product_status")) {
    orderSqliteDb.prepare("ALTER TABLE report_product_metrics ADD COLUMN product_status TEXT").run();
  }
  if (!metricColumns.includes("compare_at_price")) {
    orderSqliteDb.prepare("ALTER TABLE report_product_metrics ADD COLUMN compare_at_price REAL").run();
  }
  const supplierColumns = orderSqliteDb.prepare("PRAGMA table_info(suppliers)").all().map(column => column.name);
  for (const [name, definition] of [
    ["status", "TEXT DEFAULT 'Active'"],
    ["country", "TEXT"],
    ["lead_time_days", "REAL DEFAULT 0"],
    ["moq", "REAL DEFAULT 0"],
    ["currency", "TEXT"],
    ["incoterms", "TEXT"]
  ]) {
    if (!supplierColumns.includes(name)) orderSqliteDb.prepare(`ALTER TABLE suppliers ADD COLUMN ${name} ${definition}`).run();
  }
  const productColumns = orderSqliteDb.prepare("PRAGMA table_info(products)").all().map(column => column.name);
  for (const [name, definition] of [
    ["supplier_sku", "TEXT"],
    ["product_type", "TEXT"],
    ["season", "TEXT"],
    ["colour", "TEXT"],
    ["size", "TEXT"],
    ["unit_cost_gbp", "REAL DEFAULT 0"],
    ["rrp", "REAL DEFAULT 0"],
    ["compare_at_price", "REAL DEFAULT 0"],
    ["barcode", "TEXT"],
    ["product_status", "TEXT DEFAULT 'Draft'"],
    ["shopify_product_gid", "TEXT"],
    ["shopify_variant_gid", "TEXT"],
    ["shopify_status", "TEXT"],
    ["sync_status", "TEXT DEFAULT 'Not synced'"],
    ["last_synced_at", "TEXT"]
  ]) {
    if (!productColumns.includes(name)) orderSqliteDb.prepare(`ALTER TABLE products ADD COLUMN ${name} ${definition}`).run();
  }
  orderSqliteDb.prepare(`
    CREATE TABLE IF NOT EXISTS product_sync_events (
      id TEXT PRIMARY KEY,
      product_id INTEGER,
      sku TEXT,
      action TEXT NOT NULL,
      actor_name TEXT,
      shopify_product_gid TEXT,
      payload_summary TEXT,
      result TEXT NOT NULL,
      error TEXT,
      data TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `).run();
  orderSqliteDb.prepare("CREATE INDEX IF NOT EXISTS idx_products_supplier ON products(supplier_name, product_status, sync_status)").run();
  orderSqliteDb.prepare("CREATE INDEX IF NOT EXISTS idx_products_shopify ON products(shopify_product_gid, shopify_variant_gid)").run();
  orderSqliteDb.prepare("CREATE INDEX IF NOT EXISTS idx_product_sync_events_product ON product_sync_events(product_id, created_at)").run();
  orderSqliteDb.prepare("CREATE INDEX IF NOT EXISTS idx_suppliers_status ON suppliers(status, name)").run();
  migrateInvoiceFilesToDisk(orderSqliteDb);
  importOrderJsonIfNeeded(orderSqliteDb);
  migrateOrderImagesToDisk(orderSqliteDb);
  syncAllBatchPaymentStatusesFromInvoices();
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

function migrateInvoiceFilesToDisk(db) {
  const rows = db.prepare(`
    SELECT inv.id, inv.order_id, inv.file_name, inv.mime_type, inv.file_data, inv.file_path, ord.data AS order_data
    FROM order_invoices inv
    LEFT JOIN orders ord ON ord.id = inv.order_id
    WHERE inv.file_data IS NOT NULL AND inv.file_data != ''
  `).all();
  if (!rows.length) return;
  const update = db.prepare(`
    UPDATE order_invoices
    SET file_name = @fileName,
        mime_type = @mimeType,
        file_path = @filePath,
        file_size = @fileSize,
        file_data = '',
        updated_at = CURRENT_TIMESTAMP
    WHERE id = @id
  `);
  for (const row of rows) {
    if (row.file_path) {
      update.run({
        id: row.id,
        fileName: row.file_name || "",
        mimeType: row.mime_type || "",
        filePath: row.file_path,
        fileSize: 0
      });
      continue;
    }
    const order = parseJson(row.order_data, { id: row.order_id, orderNumber: row.order_id });
    const stored = writeInvoiceUpload(order, row.id, {
      fileData: row.file_data,
      fileName: row.file_name,
      mimeType: row.mime_type
    });
    if (!stored) continue;
    update.run({
      id: row.id,
      fileName: stored.fileName,
      mimeType: stored.mimeType,
      filePath: stored.filePath,
      fileSize: stored.fileSize
    });
  }
}

function migrateOrderImagesToDisk(db) {
  const orderRows = db.prepare("SELECT id, data FROM orders WHERE data LIKE '%data:image/%'").all();
  const updateOrder = db.prepare("UPDATE orders SET data = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?");
  for (const row of orderRows) {
    const order = parseJson(row.data, null);
    if (!order) continue;
    const migrated = materializeOrderImages(order);
    if (migrated !== order) updateOrder.run(JSON.stringify(migrated), row.id);
  }

  const productRows = db.prepare("SELECT sku, data FROM products WHERE data LIKE '%data:image/%'").all();
  const updateProduct = db.prepare(`
    UPDATE products
    SET data = @data,
        style = @style,
        supplier_name = @supplierName,
        updated_at = CURRENT_TIMESTAMP
    WHERE sku = @sku
  `);
  for (const row of productRows) {
    const product = parseJson(row.data, null);
    if (!product || !isDataUrl(product.imageUrl)) continue;
    const stored = writeProductImageUpload(product);
    if (!stored) continue;
    const migrated = { ...product, imageUrl: stored.imageUrl };
    updateProduct.run({
      sku: row.sku,
      data: JSON.stringify(migrated),
      style: migrated.style || migrated.description || "",
      supplierName: migrated.supplierName || ""
    });
  }
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
      INSERT INTO orders (id, order_number, supplier_name, order_date, status, saved_at, data, archived_at, updated_at)
      VALUES (@id, @orderNumber, @supplierName, @orderDate, @status, @savedAt, @data, @archivedAt, CURRENT_TIMESTAMP)
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
        data: JSON.stringify(order),
        archivedAt: order.archivedAt || ""
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
    orders: db.prepare("SELECT data, archived_at AS archivedAt FROM orders ORDER BY saved_at").all().map(row => {
      const order = parseJson(row.data, null);
      return order ? { ...order, archivedAt: order.archivedAt || row.archivedAt || "" } : null;
    }).filter(Boolean),
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
  const parsed = parseIssuedSku(value) || { prefix: "", number: 0, width: 5 };
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

function initialIssuedSku() {
  const configured = normalizeSku(process.env.ORDER_FORM_INITIAL_SKU || "15100");
  return parseIssuedSku(configured) ? configured : "15100";
}

function knownSkuSet(dbData = {}) {
  const known = new Set();
  const add = (sku) => {
    const normalized = normalizeSku(sku);
    if (normalized) known.add(normalized);
  };

  for (const row of readIssuedSkuRows()) add(row.sku);
  for (const product of dbData.products || []) add(product.sku);
  for (const order of dbData.orders || []) {
    for (const line of order.lines || []) add(line.sku);
  }

  return known;
}

function sequentialIssuedSkuCursor(dbData = {}) {
  const start = initialIssuedSku();
  const parsedStart = parseIssuedSku(start);
  if (!parsedStart) return "";

  const known = knownSkuSet(dbData);
  let cursor = start;
  for (let attempts = 0; attempts < 100000; attempts += 1) {
    const next = incrementIssuedSku(cursor);
    const parsedNext = parseIssuedSku(next);
    if (!parsedNext || parsedNext.prefix !== parsedStart.prefix || !known.has(normalizeSku(next))) break;
    cursor = next;
  }
  return cursor;
}

function nextAvailableIssuedSku(dbData = {}, baselineSku = "") {
  const baseline = parseIssuedSku(baselineSku) ? normalizeSku(baselineSku) : initialIssuedSku();
  const baselinePrefix = parseIssuedSku(baseline)?.prefix || "";
  const known = knownSkuSet(dbData);
  let candidate = incrementIssuedSku(baseline);

  for (let attempts = 0; attempts < 100000; attempts += 1) {
    const parsedCandidate = parseIssuedSku(candidate);
    if (!parsedCandidate || parsedCandidate.prefix !== baselinePrefix) {
      throw new Error("Could not issue the next SKU in the configured sequence.");
    }
    if (!known.has(normalizeSku(candidate))) return candidate;
    candidate = incrementIssuedSku(candidate);
  }

  throw new Error("Could not find an unused SKU in the configured sequence.");
}

function getLastIssuedSku(dbData) {
  return sequentialIssuedSkuCursor(dbData);
}

function writeLastIssuedSkuSetting(sku) {
  const normalized = normalizeSku(sku);
  if (!parseIssuedSku(normalized)) return "";
  openOrderSqliteDb().prepare(`
    INSERT INTO app_settings (key, value, updated_at)
    VALUES ('lastIssuedSku', ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
  `).run(normalized);
  return normalized;
}

function setLastIssuedSku(sku) {
  const normalized = writeLastIssuedSkuSetting(sku);
  if (!normalized) return;
  reserveIssuedSku(normalized, { source: "issue" });
}

function normalizeSku(sku) {
  return String(sku || "").trim().replace(/^'+/, "").toUpperCase();
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
  if (String(product.status || "").trim().toLowerCase() === "archived") return false;
  return String(product.source || "").trim().toLowerCase() !== "shopify";
}

function orderLineSkuSet(order) {
  return new Set((order?.lines || []).map(line => normalizeSku(line.sku)).filter(Boolean));
}

function orderContainsSku(order, sku) {
  const normalized = normalizeSku(sku);
  return Boolean(normalized && orderLineSkuSet(order).has(normalized));
}

function orderDbContainsSku(dbData, sku) {
  const normalized = normalizeSku(sku);
  return Boolean(normalized && (dbData.orders || []).some(order => orderContainsSku(order, normalized)));
}

function productHasShopifyIdentity(product) {
  return Boolean(
    product?.shopifyProductGid
    || product?.shopifyVariantGid
    || String(product?.syncStatus || "").trim().toLowerCase() === "synced draft"
    || ["shopify draft", "live"].includes(String(product?.status || "").trim().toLowerCase())
  );
}

function productHasStaleOrderReference(dbData, product) {
  const sku = normalizeSku(product?.sku);
  const lastOrderNumber = String(product?.lastOrderNumber || "").trim();
  if (!sku || !lastOrderNumber || productHasShopifyIdentity(product)) return false;
  if (orderDbContainsSku(dbData, sku)) return false;
  return (dbData.orders || []).some(order => String(order.orderNumber || "").trim() === lastOrderNumber);
}

function savedLocalSkuRows(dbData) {
  const productRows = (dbData.products || [])
    .filter(isNonShopifySavedProduct)
    .filter(product => !productHasStaleOrderReference(dbData, product))
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
      canDelete: !skuHasAttachedData(dbData, row.sku),
      data: { sku: row.sku, issuedAt: row.issuedAt, ...(row.data || {}) },
      normalizedSku: normalizeSku(row.sku)
    }));
  return [...productRows, ...issuedRows]
    .sort((a, b) => compareIssuedSku(b.sku, a.sku) || String(a.sku).localeCompare(String(b.sku)));
}

function skuHasAttachedData(dbData, sku) {
  const normalized = normalizeSku(sku);
  if (!normalized) return false;
  if ((dbData.products || []).some(product => normalizeSku(product.sku) === normalized && isNonShopifySavedProduct(product) && !productHasStaleOrderReference(dbData, product))) return true;
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

const workflowFields = {
  approvalStatus: "approval_status",
  approvalBy: "approval_by",
  approvalDecidedAt: "approval_decided_at",
  approvalNotes: "approval_notes",
  paymentStatus: "payment_status",
  paymentType: "payment_type",
  paymentAmount: "payment_amount",
  paymentDueDate: "payment_due_date",
  paymentPaidDate: "payment_paid_date",
  paymentReference: "payment_reference",
  paymentNotes: "payment_notes",
  intakeStatus: "intake_status",
  intakeEtaDate: "intake_eta_date",
  intakeConfirmedDate: "intake_confirmed_date",
  intakeActualDate: "intake_actual_date",
  intakeReference: "intake_reference",
  intakeNotes: "intake_notes",
  pahUploaded: "pah_uploaded",
  nextActionOwner: "next_action_owner",
  nextActionUserId: "next_action_user_id",
  nextAction: "next_action"
};

function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

function normalizeWorkflowValue(key, value) {
  if (key === "paymentAmount") return Number(value || 0);
  if (key === "pahUploaded") return value === true || value === 1 || value === "1" || value === "true" ? 1 : 0;
  if (key === "nextActionUserId") return normalizeAssignableUserId(value);
  return value == null ? "" : String(value).trim();
}

function workflowBindParams(orderId, workflow) {
  const params = { orderId: String(orderId) };
  for (const key of Object.keys(workflowFields)) {
    params[key] = normalizeWorkflowValue(key, workflow?.[key]);
  }
  params.data = JSON.stringify(workflow?.data || {});
  return params;
}

function workflowPatchForOrderStatus(status, currentWorkflow = {}) {
  const normalized = String(status || "").trim().toLowerCase();
  if (normalized === "pending approval" || normalized === "submitted") {
    return { approvalStatus: "Pending director approval", nextActionOwner: "Buying Director", nextAction: "Review order for approval" };
  }
  if (normalized === "approved") {
    return {
      approvalStatus: "Approved",
      approvalDecidedAt: currentWorkflow.approvalDecidedAt || todayIsoDate(),
      paymentStatus: ["Paid", "Part paid", "Ready to pay", "Overdue"].includes(currentWorkflow.paymentStatus) ? currentWorkflow.paymentStatus : "Awaiting invoice",
      nextActionOwner: "Buyer",
      nextAction: "Awaiting supplier invoice"
    };
  }
  if (normalized === "changes requested") {
    return { approvalStatus: "Changes requested", nextActionOwner: "Buyer", nextAction: "Update order and resubmit" };
  }
  if (normalized === "rejected") {
    return { approvalStatus: "Rejected", nextActionOwner: "Buyer", nextAction: "Review rejected order" };
  }
  if (normalized === "payment pending") {
    return { paymentStatus: "Ready to pay", nextActionOwner: "FD / Finance", nextAction: "Arrange supplier payment" };
  }
  if (normalized === "paid") {
    return { paymentStatus: "Paid", paymentPaidDate: currentWorkflow.paymentPaidDate || todayIsoDate(), nextActionOwner: "Merchandising", nextAction: "Track intake date" };
  }
  if (normalized === "in production") {
    return { intakeStatus: "In production", nextActionOwner: "Merchandising", nextAction: "Track supplier production and ETA" };
  }
  if (normalized === "shipped") {
    return { intakeStatus: "Shipped", nextActionOwner: "Merchandising", nextAction: "Track shipment to warehouse" };
  }
  if (normalized === "part shipped") {
    return { intakeStatus: "Part shipped", nextActionOwner: "Merchandising", nextAction: "Track remaining supplier shipments" };
  }
  if (normalized === "received") {
    return { intakeStatus: "Received", intakeActualDate: currentWorkflow.intakeActualDate || todayIsoDate(), nextActionOwner: "Merchandising", nextAction: "Close intake checks" };
  }
  if (normalized === "draft") {
    return { approvalStatus: "Not requested", paymentStatus: "Not due", nextActionOwner: "Buyer", nextAction: "Prepare or submit order" };
  }
  return {};
}

function orderStatusForWorkflowPatch(section, workflow) {
  if (section === "approval") {
    if (workflow.approvalStatus === "Pending director approval") return "Pending approval";
    if (workflow.approvalStatus === "Approved") return "Approved";
    if (workflow.approvalStatus === "Changes requested") return "Changes requested";
    if (workflow.approvalStatus === "Rejected") return "Rejected";
    if (workflow.approvalStatus === "Not requested") return "Draft";
  }
  if (section === "payment") {
    if (["Ready to pay", "Part paid", "Overdue"].includes(workflow.paymentStatus)) return "Payment pending";
    if (workflow.paymentStatus === "Paid") return "Paid";
  }
  if (section === "intake") {
    if (["In production", "Part shipped", "Shipped", "Part received", "Received"].includes(workflow.intakeStatus)) return workflow.intakeStatus;
  }
  return "";
}

function orderStatusFromWorkflow(workflow) {
  if (!workflow) return "";
  if (workflow.intakeStatus === "Received") return "Received";
  if (workflow.intakeStatus === "Part received") return "Part received";
  if (workflow.intakeStatus === "Shipped") return "Shipped";
  if (workflow.intakeStatus === "Part shipped") return "Part shipped";
  if (workflow.intakeStatus === "In production") return "In production";
  if (workflow.paymentStatus === "Paid") return "Paid";
  if (["Ready to pay", "Part paid", "Overdue"].includes(workflow.paymentStatus)) return "Payment pending";
  if (workflow.approvalStatus === "Approved") return "Approved";
  if (workflow.approvalStatus === "Pending director approval") return "Pending approval";
  if (workflow.approvalStatus === "Changes requested") return "Changes requested";
  if (workflow.approvalStatus === "Rejected") return "Rejected";
  if (workflow.approvalStatus === "Not requested") return "Draft";
  return "";
}

function nextActionForWorkflow(order, workflow) {
  const approvalStatus = workflow?.approvalStatus || "Not requested";
  const paymentStatus = workflow?.paymentStatus || "Not due";
  const intakeStatus = workflow?.intakeStatus || "Not confirmed";
  if (String(order?.status || "").toLowerCase() === "cancelled") return { nextActionOwner: "Buyer", nextAction: "Review cancelled order" };
  if (approvalStatus === "Pending director approval") return { nextActionOwner: "Buying Director", nextAction: "Review order for approval" };
  if (approvalStatus === "Changes requested") return { nextActionOwner: "Buyer", nextAction: "Update order and resubmit" };
  if (approvalStatus === "Rejected") return { nextActionOwner: "Buyer", nextAction: "Review rejected order" };
  if (approvalStatus !== "Approved") return { nextActionOwner: "Buyer", nextAction: "Prepare or submit order" };
  if (paymentStatus === "Awaiting invoice") return { nextActionOwner: "Buyer", nextAction: "Awaiting supplier invoice" };
  if (paymentStatus === "Ready to pay") return { nextActionOwner: "FD / Finance", nextAction: "Pay supplier invoice" };
  if (paymentStatus === "Part paid") return { nextActionOwner: "Buyer", nextAction: "Awaiting next supplier invoice" };
  if (paymentStatus === "Overdue") return { nextActionOwner: "FD / Finance", nextAction: "Resolve overdue supplier payment" };
  if (paymentStatus !== "Paid") return { nextActionOwner: "Buyer", nextAction: "Confirm invoice and payment plan" };
  if (intakeStatus === "Not confirmed" && !orderProductCompletion(order).complete) {
    return { nextActionOwner: "Buyer", nextAction: productCompletionNextAction };
  }
  if (intakeStatus === "Received") return { nextActionOwner: "Merchandising", nextAction: "Archive completed order" };
  if (intakeStatus === "Part received") return { nextActionOwner: "Merchandising", nextAction: "Chase remaining intake" };
  if (intakeStatus === "Shipped") return { nextActionOwner: "Merchandising", nextAction: "Track shipment to warehouse" };
  if (intakeStatus === "Part shipped") return { nextActionOwner: "Merchandising", nextAction: "Track remaining supplier shipments" };
  if (intakeStatus === "Delayed") return { nextActionOwner: "Merchandising", nextAction: "Resolve delayed intake" };
  if (intakeStatus === "In production") return { nextActionOwner: "Merchandising", nextAction: "Track supplier production and ETA" };
  if (intakeStatus === "Confirmed") return { nextActionOwner: "Merchandising", nextAction: "Track confirmed intake date" };
  return { nextActionOwner: "Merchandising", nextAction: "Track intake date" };
}

function defaultWorkflowForOrder(order) {
  const status = String(order?.status || "").toLowerCase();
  const isApproved = status === "approved";
  const isPending = status.includes("approval") || status === "submitted";
  const paymentType = order?.terms?.payment || order?.supplier?.paymentType || "";
  const paymentAmount = Number(order?.totals?.grand || order?.totals?.subtotal || 0);
  const requiredDate = order?.delivery?.requiredDate || "";
  return {
    approvalStatus: isApproved ? "Approved" : isPending ? "Pending director approval" : "Not requested",
    approvalBy: "",
    approvalDecidedAt: isApproved ? order?.savedAt?.slice(0, 10) || "" : "",
    approvalNotes: "",
    paymentStatus: isApproved ? "Awaiting invoice" : "Not due",
    paymentType,
    paymentAmount,
    paymentDueDate: "",
    paymentPaidDate: "",
    paymentReference: "",
    paymentNotes: "",
    intakeStatus: requiredDate ? "Not confirmed" : "Not confirmed",
    intakeEtaDate: requiredDate,
    intakeConfirmedDate: "",
    intakeActualDate: "",
    intakeReference: "",
    intakeNotes: "",
    pahUploaded: false,
    nextActionOwner: isPending ? "Buying Director" : isApproved ? "Buyer" : "Buyer",
    nextActionUserId: "",
    nextAction: isPending ? "Review order for approval" : isApproved ? "Awaiting supplier invoice" : "Prepare or submit order",
    data: {},
    updatedAt: order?.savedAt || new Date().toISOString()
  };
}

function workflowFromRow(row, order) {
  const defaults = defaultWorkflowForOrder(order);
  if (!row) return defaults;
  return {
    ...defaults,
    approvalStatus: row.approval_status || defaults.approvalStatus,
    approvalBy: row.approval_by || "",
    approvalDecidedAt: row.approval_decided_at || "",
    approvalNotes: row.approval_notes || "",
    paymentStatus: row.payment_status || defaults.paymentStatus,
    paymentType: row.payment_type || defaults.paymentType,
    paymentAmount: Number(row.payment_amount || defaults.paymentAmount || 0),
    paymentDueDate: row.payment_due_date || "",
    paymentPaidDate: row.payment_paid_date || "",
    paymentReference: row.payment_reference || "",
    paymentNotes: row.payment_notes || "",
    intakeStatus: row.intake_status || defaults.intakeStatus,
    intakeEtaDate: row.intake_eta_date || defaults.intakeEtaDate,
    intakeConfirmedDate: row.intake_confirmed_date || "",
    intakeActualDate: row.intake_actual_date || "",
    intakeReference: row.intake_reference || "",
    intakeNotes: row.intake_notes || "",
    pahUploaded: Boolean(row.pah_uploaded),
    nextActionOwner: row.next_action_owner || defaults.nextActionOwner,
    nextActionUserId: row.next_action_user_id || "",
    nextAction: row.next_action || defaults.nextAction,
    data: parseJson(row.data, {}),
    updatedAt: row.updated_at || defaults.updatedAt
  };
}

function readOrderWorkflowMap() {
  const rows = openOrderSqliteDb().prepare("SELECT * FROM order_workflows").all();
  return new Map(rows.map(row => [String(row.order_id), row]));
}

function readOrderEvents(orderId, limit = 40) {
  return openOrderSqliteDb().prepare(`
    SELECT id, order_id AS orderId, event_type AS eventType, actor_name AS actorName, message, data, created_at AS createdAt
    FROM order_events
    WHERE order_id = ?
    ORDER BY created_at DESC
    LIMIT ?
  `).all(String(orderId), limit).map(row => ({ ...row, data: parseJson(row.data, {}) }));
}

function orderCompositeStatus(order, workflow, productCompletion = null) {
  if (order?.archivedAt) return "Archived";
  if (String(order?.status || "").toLowerCase() === "cancelled") return "Cancelled";
  if (workflow.intakeStatus === "Received") return "Received";
  if (workflow.intakeStatus === "Part received") return "Part received";
  if (workflow.intakeStatus === "Shipped") return "Shipped";
  if (workflow.intakeStatus === "Part shipped") return "Part shipped";
  if (workflow.paymentStatus === "Paid" && !(productCompletion || orderProductCompletion(order)).complete) return "Product sync";
  if (workflow.paymentStatus === "Paid") return "Payment complete";
  if (workflow.paymentStatus === "Ready to pay" || workflow.paymentStatus === "Part paid" || workflow.paymentStatus === "Overdue") return "Payment";
  if (workflow.approvalStatus === "Approved") return "Approved";
  if (workflow.approvalStatus === "Pending director approval") return "Awaiting approval";
  if (workflow.approvalStatus === "Changes requested") return "Changes requested";
  return order?.status || "Draft";
}

function catalogProductMap() {
  return new Map(readCatalogProducts({ includeArchived: true }).map(product => [normalizeSku(product.sku), product]));
}

function productIsShopifyComplete(product = {}) {
  const status = String(product.status || product.productStatus || "").trim().toLowerCase();
  const syncStatus = String(product.syncStatus || "").trim().toLowerCase();
  const shopifyStatus = String(product.shopifyStatus || "").trim().toUpperCase();
  return Boolean(
    product.shopifyProductGid
    || product.shopifyVariantGid
    || ["synced", "synced draft"].includes(syncStatus)
    || status === "shopify draft"
    || status === "live"
    || shopifyStatus === "DRAFT"
    || shopifyStatus === "ACTIVE"
  );
}

function productCompletionSource(product = {}) {
  if (product.shopifyProductGid || product.shopifyVariantGid) return "Shopify linked";
  if (product.syncStatus === "Synced draft") return "Synced draft";
  if (product.status === "Live") return "Live";
  if (product.status === "Shopify draft") return "Shopify draft";
  if (product.shopifyStatus) return product.shopifyStatus;
  if (product.syncStatus) return product.syncStatus;
  return product.status || "Not synced";
}

function orderProductCompletion(order, productMap = null) {
  const lookup = productMap || catalogProductMap();
  const lines = order?.lines || [];
  const lineStatuses = lines.map((line, index) => {
    const sku = normalizeSku(line?.sku);
    const masterProduct = sku ? lookup.get(sku) : null;
    const product = { ...(line || {}), ...(masterProduct || {}) };
    const complete = Boolean(sku) && productIsShopifyComplete(product);
    return {
      lineIndex: index,
      sku,
      buyingCode: line?.buyingCode || line?.supplierSku || "",
      style: line?.style || line?.description || "",
      complete,
      status: complete ? "Complete" : sku ? "Needs Shopify" : "Missing SKU",
      source: productCompletionSource(product),
      shopifyProductGid: product.shopifyProductGid || "",
      shopifyVariantGid: product.shopifyVariantGid || "",
      syncStatus: product.syncStatus || "",
      productStatus: product.status || product.productStatus || "",
      lastSyncedAt: product.lastSyncedAt || ""
    };
  });
  const completedLines = lineStatuses.filter(line => line.complete).length;
  const blockedLines = lineStatuses.filter(line => !line.complete);
  return {
    complete: lines.length > 0 && blockedLines.length === 0,
    totalLines: lines.length,
    completedLines,
    blockedLines: blockedLines.length,
    summary: lines.length
      ? `${completedLines}/${lines.length} products complete`
      : "No products on order",
    lines: lineStatuses
  };
}

function productCompletionBlockMessage(order, completion = orderProductCompletion(order)) {
  const blocked = (completion.lines || []).filter(line => !line.complete);
  const sample = blocked.slice(0, 4).map(line => line.sku || line.buyingCode || line.style || `Line ${line.lineIndex + 1}`).join(", ");
  const suffix = blocked.length > 4 ? ` and ${blocked.length - 4} more` : "";
  return `Complete or sync every product to Shopify before booking warehouse intake. Blocked: ${sample || "order products"}${suffix}.`;
}

function assertOrderProductsCompleteForWarehouse(order) {
  const completion = orderProductCompletion(order);
  if (!completion.complete) throw new Error(productCompletionBlockMessage(order, completion));
  return completion;
}

const productCompletionNextAction = "Complete Shopify product sync before warehouse booking";

function workflowWithProductCompletionGate(order, workflow, completion) {
  const productCompletion = completion || orderProductCompletion(order);
  if (workflow.approvalStatus !== "Approved" || workflow.paymentStatus !== "Paid" || workflow.intakeStatus !== "Not confirmed") {
    return workflow;
  }
  if (!productCompletion.complete) {
    return {
      ...workflow,
      nextActionOwner: "Buyer",
      nextActionUserId: workflow.nextAction === productCompletionNextAction ? workflow.nextActionUserId : "",
      nextAction: productCompletionNextAction
    };
  }
  if (workflow.nextAction === productCompletionNextAction) {
    const next = nextActionForWorkflow(order, workflow);
    return { ...workflow, ...next, nextActionUserId: "" };
  }
  return workflow;
}

function publicManagedOrder(order, workflowRow, productMap = null) {
  const baseWorkflow = workflowFromRow(workflowRow, order);
  const lines = order.lines || [];
  const units = lines.reduce((total, line) => total + Number(line.quantity || 0), 0);
  const categories = [...new Set(lines.map(line => line.category).filter(Boolean))];
  const fxRate = Number(order.fxRate || order.totals?.fxRate || 0);
  const total = Number(order.totals?.grand || 0);
  const productCompletion = orderProductCompletion(order, productMap);
  const workflow = workflowWithProductCompletionGate(order, baseWorkflow, productCompletion);
  return {
    id: String(order.id || ""),
    orderNumber: order.orderNumber || "",
    orderDate: order.orderDate || "",
    savedAt: order.savedAt || "",
    supplierName: order.supplier?.name || "",
    supplierReference: order.supplier?.reference || "",
    buyerName: order.company?.department || "",
    buyerEmail: order.company?.buyerEmail || "",
    status: order.status || "Draft",
    archivedAt: order.archivedAt || "",
    compositeStatus: orderCompositeStatus(order, workflow, productCompletion),
    season: order.season || "",
    total,
    totalGbp: total,
    totalEur: fxRate ? total / fxRate : 0,
    subtotal: Number(order.totals?.subtotal || 0),
    fxRate,
    currency: order.terms?.currency || "GBP",
    paymentTerms: order.terms?.payment || "",
    requiredDate: order.delivery?.requiredDate || "",
    shippingMethod: order.delivery?.shippingMethod || "",
    incoterms: order.terms?.incoterms || "",
    lineCount: lines.length,
    units,
    categories,
    productCompletion,
    invoices: invoiceSummary(order),
    batchSummary: batchSummary(order),
    canDelete: canDeleteOrder(order),
    canArchive: canArchiveOrder(order),
    workflow,
    order
  };
}

function canDeleteOrder(order) {
  const status = String(order?.status || "Draft").trim().toLowerCase();
  const lines = order?.lines || [];
  return !order?.archivedAt && (!lines.length || ["draft", "changes requested", "rejected", "cancelled"].includes(status));
}

function canArchiveOrder(order) {
  const status = String(order?.status || "").trim().toLowerCase();
  return !order?.archivedAt && ["received", "paid", "cancelled", "rejected"].includes(status);
}

function orderWorkflowMetrics(orders) {
  const today = todayIsoDate();
  return {
    totalOrders: orders.length,
    awaitingApproval: orders.filter(order => order.workflow.approvalStatus === "Pending director approval").length,
    readyToPay: orders.filter(order => ["Ready to pay", "Overdue"].includes(order.workflow.paymentStatus) || (order.workflow.paymentStatus === "Part paid" && order.workflow.nextActionOwner === "FD / Finance")).length,
    intakeRisk: orders.filter(order => order.workflow.intakeStatus === "Delayed" || (order.workflow.intakeEtaDate && order.workflow.intakeEtaDate < today && order.workflow.intakeStatus !== "Received")).length,
    productBlocked: orders.filter(order => !order.productCompletion?.complete).length
  };
}

function parseReportWindowDays(value) {
  const days = Number(value || 30);
  if (!Number.isFinite(days)) return 30;
  return Math.min(365, Math.max(1, Math.round(days)));
}

function addDaysIso(dateIso, days) {
  const date = new Date(`${dateIso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + Number(days || 0));
  return date.toISOString().slice(0, 10);
}

function isoDateOrBlank(value) {
  const text = String(value || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : "";
}

function dateInRange(dateIso, fromIso, toIso) {
  return Boolean(dateIso && dateIso >= fromIso && dateIso <= toIso);
}

function reportGroupKey(value) {
  const text = String(value || "").trim();
  return text || "Unassigned";
}

function incrementReportGroup(groups, key, patch = {}) {
  const id = reportGroupKey(key);
  if (!groups.has(id)) groups.set(id, { label: id, orders: 0, units: 0, valueGbp: 0, outstandingGbp: 0 });
  const group = groups.get(id);
  group.orders += Number(patch.orders || 0);
  group.units += Number(patch.units || 0);
  group.valueGbp += Number(patch.valueGbp || 0);
  group.outstandingGbp += Number(patch.outstandingGbp || 0);
  return group;
}

function sortedReportGroups(groups, metric = "valueGbp") {
  return [...groups.values()].sort((a, b) => Number(b[metric] || 0) - Number(a[metric] || 0) || String(a.label).localeCompare(String(b.label)));
}

function reportLineCategories(lines) {
  return [...new Set((lines || []).map(line => String(line.category || "").trim()).filter(Boolean))];
}

function reportLineValueGbp(line) {
  const quantity = Number(line?.quantity || 0);
  return Number(line?.lineCost || (quantity * Number(line?.unitCostGbp || line?.unitCost || 0)) || 0);
}

function reportLineRetailValueGbp(line) {
  const quantity = Number(line?.quantity || 0);
  return Number(line?.lineRrp || (quantity * Number(line?.rrp || 0)) || 0);
}

function isoWeekForDate(dateIso) {
  if (!isoDateOrBlank(dateIso)) return { weekNumber: null, weekYear: null, weekLabel: "" };
  const date = new Date(`${dateIso}T00:00:00Z`);
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const weekYear = date.getUTCFullYear();
  const yearStart = new Date(Date.UTC(weekYear, 0, 1));
  const weekNumber = Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
  return { weekNumber, weekYear, weekLabel: `${weekYear}-W${String(weekNumber).padStart(2, "0")}` };
}

function reportOrderLineStats(order) {
  const lines = order?.lines || [];
  const categoryMap = new Map();
  const styleMap = new Map();
  let unbatchedUnits = 0;
  let costValueGbp = 0;
  let retailValueGbp = 0;
  lines.forEach((line, index) => {
    const quantity = Number(line.quantity || 0);
    const category = reportGroupKey(line.category || "Uncategorised");
    if (!categoryMap.has(category)) categoryMap.set(category, { label: category, units: 0, valueGbp: 0 });
    const group = categoryMap.get(category);
    group.units += quantity;
    group.valueGbp += reportLineValueGbp(line);
    unbatchedUnits += quantity;
    costValueGbp += reportLineValueGbp(line);
    retailValueGbp += reportLineRetailValueGbp(line);
    const style = String(line.style || line.buyingCode || line.supplierSku || line.sku || `Line ${index + 1}`).trim();
    if (style) styleMap.set(style.toLowerCase(), style);
  });
  return {
    categories: [...categoryMap.values()].sort((a, b) => Number(b.valueGbp || 0) - Number(a.valueGbp || 0)),
    unbatchedUnits,
    units: unbatchedUnits,
    styles: [...styleMap.values()],
    styleCount: styleMap.size,
    costValueGbp,
    retailValueGbp
  };
}

function reportStatsForLineQuantities(order, quantityByLine) {
  const styles = new Map();
  let units = 0;
  let costValueGbp = 0;
  let retailValueGbp = 0;
  (order?.lines || []).forEach((line, index) => {
    const quantity = Math.max(0, Number(quantityByLine.get(index) || 0));
    if (!quantity) return;
    const orderedQuantity = Number(line.quantity || 0);
    const unitCost = orderedQuantity > 0 ? reportLineValueGbp(line) / orderedQuantity : Number(line.unitCostGbp || line.unitCost || 0);
    const unitRetail = orderedQuantity > 0 ? reportLineRetailValueGbp(line) / orderedQuantity : Number(line.rrp || 0);
    const style = String(line.style || line.buyingCode || line.supplierSku || line.sku || `Line ${index + 1}`).trim();
    if (style) styles.set(style.toLowerCase(), style);
    units += quantity;
    costValueGbp += unitCost * quantity;
    retailValueGbp += unitRetail * quantity;
  });
  return { styles: [...styles.values()], styleCount: styles.size, units, costValueGbp, retailValueGbp };
}

function reportStatsForAllocations(order, allocations) {
  const quantities = new Map();
  for (const allocation of allocations || []) {
    const lineIndex = Number(allocation.lineIndex);
    if (!Number.isInteger(lineIndex)) continue;
    quantities.set(lineIndex, Number(quantities.get(lineIndex) || 0) + Number(allocation.quantity || 0));
  }
  return reportStatsForLineQuantities(order, quantities);
}

function combineReportStats(...parts) {
  const styles = new Map();
  const total = { styles: [], styleCount: 0, units: 0, costValueGbp: 0, retailValueGbp: 0 };
  for (const part of parts) {
    for (const style of part?.styles || []) styles.set(String(style).toLowerCase(), style);
    total.units += Number(part?.units || 0);
    total.costValueGbp += Number(part?.costValueGbp || 0);
    total.retailValueGbp += Number(part?.retailValueGbp || 0);
  }
  total.styles = [...styles.values()];
  total.styleCount = styles.size;
  return total;
}

function reportBatchStats(order, batch, allocations, orderStats) {
  if ((allocations || []).length) return reportStatsForAllocations(order, allocations);
  const units = Math.max(0, Number(batch.units || 0));
  const costValueGbp = Math.max(0, Number(batch.value || 0));
  const retailRatio = Number(orderStats.costValueGbp || 0) > 0 ? Number(orderStats.retailValueGbp || 0) / Number(orderStats.costValueGbp) : 0;
  const styleCount = Math.max(0, Number(batch.styleCount || 0));
  return {
    styles: Array.from({ length: styleCount }, (_, index) => `${order.id}:batch:${batch.id}:style:${index + 1}`),
    styleCount,
    units,
    costValueGbp,
    retailValueGbp: costValueGbp * retailRatio
  };
}

function reportPortionRow(row, stats, patch = {}) {
  return {
    ...row,
    ...stats,
    totalGbp: Number(stats.costValueGbp || 0),
    ...patch,
    ...isoWeekForDate(patch.arrivalDate || "")
  };
}

function orderReportPortions(row, order, batches, batchLines) {
  const allocationsByBatch = new Map();
  const allocatedByLine = new Map();
  for (const allocation of batchLines || []) {
    const batchId = String(allocation.batchId || "");
    if (!allocationsByBatch.has(batchId)) allocationsByBatch.set(batchId, []);
    allocationsByBatch.get(batchId).push(allocation);
    const lineIndex = Number(allocation.lineIndex);
    allocatedByLine.set(lineIndex, Number(allocatedByLine.get(lineIndex) || 0) + Number(allocation.quantity || 0));
  }
  const orderStats = reportOrderLineStats(order);
  if (!(batches || []).length) {
    if (row.workflow?.intakeStatus === "Received") return { dated: [], undated: null };
    if (row.arrivalDate) {
      return {
        dated: [reportPortionRow(row, orderStats, {
          reportRowType: "order",
          portionLabel: "Order ETA",
          arrivalDate: row.arrivalDate,
          arrivalSource: row.arrivalSource
        })],
        undated: null
      };
    }
    return {
      dated: [],
      undated: reportPortionRow(row, orderStats, {
        reportRowType: "undated",
        portionLabel: "No batch / no ETA",
        arrivalDate: "",
        arrivalSource: "Missing date"
      })
    };
  }
  const dated = [];
  const undatedParts = [];
  const committedParts = [];
  for (const batch of batches || []) {
    const allocations = allocationsByBatch.get(String(batch.id)) || [];
    const stats = reportBatchStats(order, batch, allocations, orderStats);
    if (batch.etaDate || batch.intakeStatus === "Received") committedParts.push(stats);
    if (batch.intakeStatus === "Received") continue;
    if (batch.etaDate) {
      dated.push(reportPortionRow(row, stats, {
        reportRowType: "batch",
        batchId: batch.id,
        batchNumber: batch.batchNumber,
        portionLabel: batch.batchNumber || batch.title || "Batch",
        arrivalDate: batch.etaDate,
        arrivalSource: "Batch ETA"
      }));
    } else if (stats.units || stats.costValueGbp) {
      undatedParts.push(stats);
    }
  }
  const remainingByLine = new Map();
  (order?.lines || []).forEach((line, index) => {
    remainingByLine.set(index, Math.max(0, Number(line.quantity || 0) - Number(allocatedByLine.get(index) || 0)));
  });
  const remaining = reportStatsForLineQuantities(order, remainingByLine);
  if (remaining.units || remaining.costValueGbp) undatedParts.push(remaining);
  const committed = combineReportStats(...committedParts);
  const undatedCandidate = combineReportStats(...undatedParts);
  const undatedUnits = Math.max(0, Number(orderStats.units || 0) - Number(committed.units || 0));
  const undatedStats = {
    ...undatedCandidate,
    styles: undatedCandidate.styles.length ? undatedCandidate.styles : orderStats.styles,
    styleCount: undatedCandidate.styles.length ? undatedCandidate.styleCount : orderStats.styleCount,
    units: undatedUnits,
    costValueGbp: Math.max(0, Number(orderStats.costValueGbp || 0) - Number(committed.costValueGbp || 0)),
    retailValueGbp: Math.max(0, Number(orderStats.retailValueGbp || 0) - Number(committed.retailValueGbp || 0))
  };
  const undated = undatedStats.units || undatedStats.costValueGbp
    ? reportPortionRow(row, undatedStats, { reportRowType: "undated", portionLabel: "Unbatched / no ETA", arrivalDate: "", arrivalSource: "Missing date" })
    : null;
  return { dated, undated };
}

function batchLineQuantityMap(batchLines) {
  const map = new Map();
  for (const line of batchLines || []) {
    const key = String(line.batchId || "");
    map.set(key, Number(map.get(key) || 0) + Number(line.quantity || 0));
  }
  return map;
}

function arrivalSignalForOrder(order, workflow) {
  const batchDate = isoDateOrBlank(order?.nextBatchEta);
  if (batchDate) return { date: batchDate, source: "Batch ETA" };
  const workflowDate = isoDateOrBlank(workflow?.intakeEtaDate);
  if (workflowDate) return { date: workflowDate, source: "Workflow ETA" };
  const requiredDate = isoDateOrBlank(order?.requiredDate);
  if (requiredDate) return { date: requiredDate, source: "Order requested date" };
  return { date: "", source: "Missing date" };
}

function orderReportSummaryRow(managedOrder, workflow, batches, batchLines, invoices) {
  const order = managedOrder.order || {};
  const batchLinesByBatch = batchLineQuantityMap(batchLines);
  const lineStats = reportOrderLineStats(order);
  const batchDates = batches.map(batch => isoDateOrBlank(batch.etaDate)).filter(Boolean).sort();
  const nextBatchEta = batchDates[0] || "";
  const arrivalSignal = arrivalSignalForOrder({ ...managedOrder, nextBatchEta }, workflow);
  const arrivalWeek = isoWeekForDate(arrivalSignal.date);
  const invoiceRows = invoices || [];
  const openInvoiceCount = invoiceRows.filter(invoice => invoice.status !== "Paid").length;
  const invoiceWithoutBatch = invoiceRows.filter(invoice => !invoice.batchId).length;
  const batchesWithoutLines = batches.filter(batch => !Number(batchLinesByBatch.get(batch.id) || 0)).length;
  const batchedUnits = [...batchLinesByBatch.values()].reduce((total, quantity) => total + Number(quantity || 0), 0);
  const unbatchedUnits = Math.max(0, Number(managedOrder.units || 0) - batchedUnits);
  return {
    id: managedOrder.id,
    orderNumber: managedOrder.orderNumber,
    orderDate: managedOrder.orderDate,
    supplierName: managedOrder.supplierName,
    supplierReference: managedOrder.supplierReference,
    buyerName: managedOrder.buyerName,
    buyerEmail: managedOrder.buyerEmail,
    season: managedOrder.season,
    status: managedOrder.status,
    compositeStatus: managedOrder.compositeStatus,
    archivedAt: managedOrder.archivedAt,
    currency: managedOrder.currency,
    categories: reportLineCategories(order.lines),
    totalGbp: Number(managedOrder.totalGbp || managedOrder.total || 0),
    totalEur: Number(managedOrder.totalEur || 0),
    units: Number(managedOrder.units || 0),
    lineCount: Number(managedOrder.lineCount || 0),
    styles: lineStats.styles,
    styleCount: lineStats.styleCount,
    costValueGbp: lineStats.costValueGbp || Number(managedOrder.subtotal || managedOrder.totalGbp || 0),
    retailValueGbp: lineStats.retailValueGbp,
    requiredDate: managedOrder.requiredDate,
    arrivalDate: arrivalSignal.date,
    arrivalSource: arrivalSignal.source,
    ...arrivalWeek,
    workflow: {
      approvalStatus: workflow.approvalStatus,
      paymentStatus: workflow.paymentStatus,
      paymentDueDate: workflow.paymentDueDate,
      pahUploaded: Boolean(workflow.pahUploaded),
      intakeStatus: workflow.intakeStatus,
      intakeEtaDate: workflow.intakeEtaDate,
      nextActionOwner: workflow.nextActionOwner,
      nextAction: workflow.nextAction
    },
    productCompletion: managedOrder.productCompletion,
    invoices: {
      ...managedOrder.invoices,
      openInvoiceCount,
      invoiceWithoutBatch
    },
    batches: {
      ...managedOrder.batchSummary,
      batchedUnits,
      unbatchedUnits,
      batchesWithoutLines,
      nextBatchEta
    },
    categoryBreakdown: lineStats.categories,
    openUrl: `orders.html?id=${encodeURIComponent(managedOrder.id)}`
  };
}

function buildOrderReports(params = {}) {
  const today = todayIsoDate();
  const windowDays = parseReportWindowDays(params.windowDays);
  let dateFrom = isoDateOrBlank(params.dateFrom) || today;
  let dateTo = isoDateOrBlank(params.dateTo) || addDaysIso(dateFrom, windowDays);
  if (dateFrom > dateTo) [dateFrom, dateTo] = [dateTo, dateFrom];
  const windowEnd = dateTo;
  const includeArchived = params.includeArchived === true || params.includeArchived === "true" || params.includeArchived === "1";
  const db = readOrderDb();
  const workflows = readOrderWorkflowMap();
  const products = catalogProductMap();
  const supplierGroups = new Map();
  const seasonGroups = new Map();
  const categoryGroups = new Map();
  const buyerGroups = new Map();
  const currencyGroups = new Map();
  const ownerGroups = new Map();
  const paymentGroups = new Map();
  const intakeGroups = new Map();
  const arrivals = [];
  const withoutDates = [];
  const exceptions = [];
  const nextActions = [];
  const financeRows = [];
  const dataQuality = [];
  const orders = [];

  for (const savedOrder of db.orders) {
    const workflowRow = workflows.get(String(savedOrder.id));
    const syncedOrder = syncOrderStatusFromWorkflowRow(savedOrder, workflowRow);
    const managedOrder = publicManagedOrder(syncedOrder, workflowRow, products);
    if (!includeArchived && managedOrder.archivedAt) continue;
    const workflow = managedOrder.workflow || workflowFromRow(workflowRow, syncedOrder);
    const batches = readOrderBatches(managedOrder.id);
    const batchLines = readOrderBatchLines(managedOrder.id);
    const invoices = readOrderInvoices(managedOrder.id, false);
    const row = orderReportSummaryRow(managedOrder, workflow, batches, batchLines, invoices);
    const portions = orderReportPortions(row, managedOrder.order, batches, batchLines);
    orders.push(row);

    incrementReportGroup(supplierGroups, row.supplierName || "No supplier", { orders: 1, units: row.units, valueGbp: row.totalGbp, outstandingGbp: row.invoices.outstanding });
    incrementReportGroup(seasonGroups, row.season || "No season", { orders: 1, units: row.units, valueGbp: row.totalGbp, outstandingGbp: row.invoices.outstanding });
    incrementReportGroup(buyerGroups, row.buyerName || row.buyerEmail || "No buyer", { orders: 1, units: row.units, valueGbp: row.totalGbp, outstandingGbp: row.invoices.outstanding });
    incrementReportGroup(currencyGroups, row.currency || "No currency", { orders: 1, units: row.units, valueGbp: row.totalGbp, outstandingGbp: row.invoices.outstanding });
    incrementReportGroup(ownerGroups, workflow.nextActionOwner || "Unassigned", { orders: 1, units: row.units, valueGbp: row.totalGbp, outstandingGbp: row.invoices.outstanding });
    incrementReportGroup(paymentGroups, workflow.paymentStatus || "No payment status", { orders: 1, units: row.units, valueGbp: row.totalGbp, outstandingGbp: row.invoices.outstanding });
    incrementReportGroup(intakeGroups, workflow.intakeStatus || "No intake status", { orders: 1, units: row.units, valueGbp: row.totalGbp, outstandingGbp: row.invoices.outstanding });
    for (const category of row.categoryBreakdown) {
      incrementReportGroup(categoryGroups, category.label, { orders: 1, units: category.units, valueGbp: category.valueGbp, outstandingGbp: 0 });
    }

    arrivals.push(...portions.dated.filter(portion => dateInRange(portion.arrivalDate, dateFrom, dateTo)));
    if (portions.undated) withoutDates.push(portions.undated);

    const exceptionReasons = [];
    if (workflow.intakeStatus === "Delayed") exceptionReasons.push("Delayed intake");
    if (row.arrivalDate && row.arrivalDate < today && workflow.intakeStatus !== "Received") exceptionReasons.push("Overdue ETA");
    if (["Shipped", "Part shipped"].includes(workflow.intakeStatus) && !row.arrivalDate) exceptionReasons.push("Shipped with no ETA");
    if (workflow.intakeStatus === "In production" && !row.arrivalDate) exceptionReasons.push("In production with no ETA");
    if (row.batches.outstandingUnits > 0 && workflow.intakeStatus === "Received") exceptionReasons.push("Received status with outstanding units");
    if (exceptionReasons.length) exceptions.push({ ...row, reason: exceptionReasons.join(", ") });

    const actionReason = [];
    if (workflow.approvalStatus === "Pending director approval") actionReason.push("Approval waiting");
    if (["Ready to pay", "Overdue"].includes(workflow.paymentStatus)) actionReason.push("Finance waiting");
    if (workflow.paymentStatus === "Part paid") actionReason.push("Part paid");
    if (["Confirmed", "In production", "Part shipped", "Shipped", "Delayed", "Part received"].includes(workflow.intakeStatus)) actionReason.push("Intake follow-up");
    if (!row.productCompletion?.complete) actionReason.push("Product completion block");
    if (!workflow.nextActionOwner) actionReason.push("Unassigned next action");
    nextActions.push({ ...row, reason: actionReason.join(", ") || "Next action" });

    if (row.invoices.count || row.totalGbp || row.invoices.outstanding || ["Ready to pay", "Part paid", "Overdue"].includes(workflow.paymentStatus)) {
      financeRows.push(row);
    }

    const qualityReasons = [];
    if (!row.arrivalDate && workflow.intakeStatus !== "Received") qualityReasons.push("Missing ETA");
    if (!row.supplierReference) qualityReasons.push("Missing supplier reference");
    if (String(row.currency || "").toUpperCase() === "EUR" && !Number(savedOrder.fxRate || savedOrder.totals?.fxRate || 0)) qualityReasons.push("Missing FX rate");
    if (!row.productCompletion?.complete) qualityReasons.push("Missing product links");
    if (row.batches.count > 0 && row.batches.unbatchedUnits > 0) qualityReasons.push("Unbatched units");
    if (row.batches.count > 0 && row.invoices.invoiceWithoutBatch > 0) qualityReasons.push("Invoice without batch");
    if (row.batches.batchesWithoutLines > 0) qualityReasons.push("Batch without line allocations");
    if (qualityReasons.length) dataQuality.push({ ...row, reason: qualityReasons.join(", ") });
  }

  orders.sort((a, b) => String(a.arrivalDate || "9999-99-99").localeCompare(String(b.arrivalDate || "9999-99-99")) || String(a.orderNumber).localeCompare(String(b.orderNumber)));
  arrivals.sort((a, b) => String(a.arrivalDate).localeCompare(String(b.arrivalDate)) || String(a.orderNumber).localeCompare(String(b.orderNumber)));
  withoutDates.sort((a, b) => String(a.supplierName).localeCompare(String(b.supplierName)) || String(a.orderNumber).localeCompare(String(b.orderNumber)));
  exceptions.sort((a, b) => String(a.arrivalDate || "9999-99-99").localeCompare(String(b.arrivalDate || "9999-99-99")) || String(a.orderNumber).localeCompare(String(b.orderNumber)));
  nextActions.sort((a, b) => String(a.workflow.nextActionOwner || "").localeCompare(String(b.workflow.nextActionOwner || "")) || String(a.orderNumber).localeCompare(String(b.orderNumber)));
  financeRows.sort((a, b) => Number(b.invoices.outstanding || 0) - Number(a.invoices.outstanding || 0) || Number(b.totalGbp || 0) - Number(a.totalGbp || 0));
  dataQuality.sort((a, b) => String(a.reason).localeCompare(String(b.reason)) || String(a.orderNumber).localeCompare(String(b.orderNumber)));

  const metrics = orders.reduce((total, order) => {
    total.orders += 1;
    total.units += Number(order.units || 0);
    total.orderValueGbp += Number(order.totalGbp || 0);
    total.invoicedGbp += Number(order.invoices.totalDue || 0);
    total.paidGbp += Number(order.invoices.totalPaid || 0);
    total.outstandingGbp += Number(order.invoices.outstanding || 0);
    total.exceptionOrders = exceptions.length;
    total.nextActionOrders = nextActions.length;
    total.dataQualityOrders = dataQuality.length;
    return total;
  }, { orders: 0, units: 0, arrivalUnits: 0, orderValueGbp: 0, invoicedGbp: 0, paidGbp: 0, outstandingGbp: 0, exceptionOrders: 0, nextActionOrders: 0, dataQualityOrders: 0 });
  metrics.arrivalUnits = arrivals.reduce((sum, portion) => sum + Number(portion.units || 0), 0);

  return {
    generatedAt: new Date().toISOString(),
    today,
    dateFrom,
    dateTo,
    windowDays,
    windowEnd,
    includeArchived,
    metrics,
    filters: {
      suppliers: [...new Set(orders.map(order => order.supplierName).filter(Boolean))].sort(),
      seasons: [...new Set(orders.map(order => order.season).filter(Boolean))].sort().reverse(),
      categories: [...new Set(orders.flatMap(order => order.categories || []).filter(Boolean))].sort(),
      intakeStatuses: [...new Set(orders.map(order => order.workflow.intakeStatus).filter(Boolean))].sort(),
      paymentStatuses: [...new Set(orders.map(order => order.workflow.paymentStatus).filter(Boolean))].sort(),
      owners: [...new Set(orders.map(order => order.workflow.nextActionOwner).filter(Boolean))].sort()
    },
    reports: {
      arrivals,
      withoutDates,
      exceptions,
      nextActions,
      finance: financeRows,
      dataQuality,
      buyingMix: {
        suppliers: sortedReportGroups(supplierGroups),
        seasons: sortedReportGroups(seasonGroups),
        categories: sortedReportGroups(categoryGroups),
        buyers: sortedReportGroups(buyerGroups),
        currencies: sortedReportGroups(currencyGroups),
        topOrders: [...orders].sort((a, b) => Number(b.totalGbp || 0) - Number(a.totalGbp || 0)).slice(0, 30)
      },
      grouped: {
        owners: sortedReportGroups(ownerGroups, "orders"),
        paymentStatuses: sortedReportGroups(paymentGroups, "orders"),
        intakeStatuses: sortedReportGroups(intakeGroups, "orders")
      },
      orders
    }
  };
}

function writeOrderWorkflow(order, patch, actorName = "", section = "workflow") {
  const db = openOrderSqliteDb();
  const currentRow = db.prepare("SELECT * FROM order_workflows WHERE order_id = ?").get(String(order.id));
  const current = workflowFromRow(currentRow, order);
  const clean = {};
  for (const key of Object.keys(workflowFields)) {
    if (Object.prototype.hasOwnProperty.call(patch || {}, key)) clean[key] = normalizeWorkflowValue(key, patch[key]);
  }
  if (section === "intake" && !orderProductCompletion(order).complete) {
    const bookingKeys = ["intakeEtaDate", "intakeConfirmedDate", "intakeActualDate", "intakeReference"];
    const hasBookingDateOrReference = bookingKeys.some(key => Object.prototype.hasOwnProperty.call(clean, key) && clean[key]);
    const hasBookedStatus = Object.prototype.hasOwnProperty.call(clean, "intakeStatus")
      && clean.intakeStatus
      && clean.intakeStatus !== "Not confirmed";
    if (hasBookingDateOrReference || hasBookedStatus) {
      throw new Error(productCompletionBlockMessage(order));
    }
  }
  if (section === "approval"
    && clean.approvalStatus === "Approved"
    && !Object.prototype.hasOwnProperty.call(clean, "paymentStatus")
    && !["Paid", "Part paid", "Ready to pay", "Overdue"].includes(current.paymentStatus)) {
    clean.paymentStatus = "Awaiting invoice";
    clean.paymentPaidDate = "";
  }
  let next = { ...current, ...clean };
  const shouldDeriveNextAction = section !== "next action"
    && !Object.prototype.hasOwnProperty.call(clean, "nextActionOwner")
    && !Object.prototype.hasOwnProperty.call(clean, "nextAction");
  if (shouldDeriveNextAction) {
    const actionPatch = nextActionForWorkflow(order, next);
    next = { ...next, ...actionPatch };
    clean.nextActionOwner = actionPatch.nextActionOwner;
    clean.nextAction = actionPatch.nextAction;
  }
  if (Object.prototype.hasOwnProperty.call(clean, "nextActionOwner")
    && clean.nextActionOwner !== current.nextActionOwner
    && !Object.prototype.hasOwnProperty.call(clean, "nextActionUserId")) {
    clean.nextActionUserId = "";
    next.nextActionUserId = "";
  }
  db.prepare(`
    INSERT INTO order_workflows (
      order_id, approval_status, approval_by, approval_decided_at, approval_notes,
      payment_status, payment_type, payment_amount, payment_due_date, payment_paid_date, payment_reference, payment_notes,
      intake_status, intake_eta_date, intake_confirmed_date, intake_actual_date, intake_reference, intake_notes,
      pah_uploaded,
      next_action_owner, next_action_user_id, next_action, data, updated_at
    ) VALUES (
      @orderId, @approvalStatus, @approvalBy, @approvalDecidedAt, @approvalNotes,
      @paymentStatus, @paymentType, @paymentAmount, @paymentDueDate, @paymentPaidDate, @paymentReference, @paymentNotes,
      @intakeStatus, @intakeEtaDate, @intakeConfirmedDate, @intakeActualDate, @intakeReference, @intakeNotes,
      @pahUploaded,
      @nextActionOwner, @nextActionUserId, @nextAction, @data, CURRENT_TIMESTAMP
    )
    ON CONFLICT(order_id) DO UPDATE SET
      approval_status = excluded.approval_status,
      approval_by = excluded.approval_by,
      approval_decided_at = excluded.approval_decided_at,
      approval_notes = excluded.approval_notes,
      payment_status = excluded.payment_status,
      payment_type = excluded.payment_type,
      payment_amount = excluded.payment_amount,
      payment_due_date = excluded.payment_due_date,
      payment_paid_date = excluded.payment_paid_date,
      payment_reference = excluded.payment_reference,
      payment_notes = excluded.payment_notes,
      intake_status = excluded.intake_status,
      intake_eta_date = excluded.intake_eta_date,
      intake_confirmed_date = excluded.intake_confirmed_date,
      intake_actual_date = excluded.intake_actual_date,
      intake_reference = excluded.intake_reference,
      intake_notes = excluded.intake_notes,
      pah_uploaded = excluded.pah_uploaded,
      next_action_owner = excluded.next_action_owner,
      next_action_user_id = excluded.next_action_user_id,
      next_action = excluded.next_action,
      data = excluded.data,
      updated_at = CURRENT_TIMESTAMP
  `).run(workflowBindParams(order.id, next));
  recordOrderEvent(order.id, section, actorName, `${section.replace(/^\w/, char => char.toUpperCase())} updated`, clean);
  return workflowFromRow(db.prepare("SELECT * FROM order_workflows WHERE order_id = ?").get(String(order.id)), order);
}

function recordOrderEvent(orderId, eventType, actorName, message, data = {}) {
  openOrderSqliteDb().prepare(`
    INSERT INTO order_events (id, order_id, event_type, actor_name, message, data, created_at)
    VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `).run(crypto.randomUUID(), String(orderId), eventType || "note", actorName || "", message || "Updated", JSON.stringify(data || {}));
}

function updateStoredOrderStatus(orderId, status) {
  if (!status) return null;
  const db = openOrderSqliteDb();
  const row = db.prepare("SELECT data FROM orders WHERE id = ?").get(String(orderId));
  const order = parseJson(row?.data, null);
  if (!order) return null;
  order.status = status;
  db.prepare(`
    UPDATE orders
    SET status = ?, data = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(status, JSON.stringify(order), String(orderId));
  return order;
}

function setOrderArchived(orderId, archived, actorName = "") {
  const db = openOrderSqliteDb();
  const row = db.prepare("SELECT data FROM orders WHERE id = ?").get(String(orderId));
  const order = parseJson(row?.data, null);
  if (!order) throw new Error("Order not found");
  const archivedAt = archived ? new Date().toISOString() : "";
  order.archivedAt = archivedAt;
  db.prepare(`
    UPDATE orders
    SET data = ?, archived_at = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(JSON.stringify(order), archivedAt, String(orderId));
  recordOrderEvent(orderId, "archive", actorName, archived ? "Order archived" : "Order restored", { archivedAt });
  return order;
}

function deleteStoredOrder(orderId, actorName = "") {
  const dbData = readOrderDb();
  const order = dbData.orders.find(item => String(item.id) === String(orderId));
  if (!order) throw new Error("Order not found");
  if (!canDeleteOrder(order)) throw new Error("Only draft, rejected, cancelled, or empty orders can be deleted.");
  const db = openOrderSqliteDb();
  const invoiceFiles = db.prepare("SELECT file_path FROM order_invoices WHERE order_id = ?").all(String(orderId));
  const remove = db.transaction(() => {
    db.prepare("DELETE FROM order_invoices WHERE order_id = ?").run(String(orderId));
    db.prepare("DELETE FROM order_batch_lines WHERE order_id = ?").run(String(orderId));
    db.prepare("DELETE FROM order_batches WHERE order_id = ?").run(String(orderId));
    db.prepare("DELETE FROM order_events WHERE order_id = ?").run(String(orderId));
    db.prepare("DELETE FROM order_workflows WHERE order_id = ?").run(String(orderId));
    db.prepare("DELETE FROM orders WHERE id = ?").run(String(orderId));
  });
  remove();
  for (const row of invoiceFiles) removeUploadFile(row.file_path || "");
  return { id: String(orderId), orderNumber: order.orderNumber || "" };
}

function syncOrderStatusFromWorkflowRow(order, workflowRow) {
  if (!workflowRow) return order;
  const workflow = workflowFromRow(workflowRow, order);
  const status = orderStatusFromWorkflow(workflow);
  if (!status || status === order.status) return order;
  return updateStoredOrderStatus(order.id, status) || { ...order, status };
}

function syncWorkflowFromOrderStatus(savedOrder) {
  const db = openOrderSqliteDb();
  const row = db.prepare("SELECT * FROM order_workflows WHERE order_id = ?").get(String(savedOrder.id));
  const current = workflowFromRow(row, savedOrder);
  const patch = workflowPatchForOrderStatus(savedOrder.status, current);
  const changes = Object.entries(patch).filter(([key, value]) => value !== "" && current[key] !== value);
  if (!changes.length) return current;
  return writeOrderWorkflow(savedOrder, patch, "Order form", "status");
}

function batchFromRow(row) {
  return {
    id: row.id,
    orderId: row.order_id,
    batchNumber: row.batch_number || "",
    title: row.title || "",
    styleCount: Number(row.style_count || 0),
    units: Number(row.units || 0),
    value: Number(row.value || 0),
    currency: row.currency || "GBP",
    paymentStatus: row.payment_status || "Awaiting invoice",
    intakeStatus: row.intake_status || "Not confirmed",
    etaDate: row.eta_date || "",
    shippedDate: row.shipped_date || "",
    receivedDate: row.received_date || "",
    trackingReference: row.tracking_reference || "",
    styleNotes: row.style_notes || "",
    notes: row.notes || "",
    createdAt: row.created_at || "",
    updatedAt: row.updated_at || ""
  };
}

function readOrderBatches(orderId) {
  return openOrderSqliteDb().prepare(`
    SELECT *
    FROM order_batches
    WHERE order_id = ?
    ORDER BY created_at, updated_at
  `).all(String(orderId)).map(batchFromRow);
}

function batchLineFromRow(row) {
  return {
    id: row.id,
    orderId: row.order_id,
    batchId: row.batch_id,
    lineIndex: Number(row.line_index || 0),
    sku: row.sku || "",
    buyingCode: row.buying_code || "",
    style: row.style || "",
    quantity: Number(row.quantity || 0),
    createdAt: row.created_at || "",
    updatedAt: row.updated_at || ""
  };
}

function readOrderBatchLines(orderId) {
  return openOrderSqliteDb().prepare(`
    SELECT *
    FROM order_batch_lines
    WHERE order_id = ?
    ORDER BY batch_id, line_index
  `).all(String(orderId)).map(batchLineFromRow);
}

function lineIdentity(line, index) {
  return {
    lineIndex: Number(index || 0),
    sku: String(line?.sku || "").trim(),
    buyingCode: String(line?.buyingCode || line?.supplierSku || "").trim(),
    style: String(line?.style || line?.description || "").trim()
  };
}

function allocatedQuantityByLine(orderId, excludingBatchId = "") {
  const rows = openOrderSqliteDb().prepare(`
    SELECT line_index AS lineIndex, SUM(quantity) AS quantity
    FROM order_batch_lines
    WHERE order_id = ? AND batch_id <> ?
    GROUP BY line_index
  `).all(String(orderId), String(excludingBatchId || ""));
  return new Map(rows.map(row => [Number(row.lineIndex || 0), Number(row.quantity || 0)]));
}

function normalizeBatchLineAllocations(order, allocations, batchId = "") {
  const lines = order?.lines || [];
  const allocatedElsewhere = allocatedQuantityByLine(order?.id, batchId);
  return (allocations || []).map(allocation => {
    const lineIndex = Number(allocation.lineIndex);
    if (!Number.isInteger(lineIndex) || lineIndex < 0 || lineIndex >= lines.length) return null;
    const line = lines[lineIndex] || {};
    const orderedQuantity = Number(line.quantity || 0);
    const availableQuantity = Math.max(0, orderedQuantity - Number(allocatedElsewhere.get(lineIndex) || 0));
    const quantity = Math.max(0, Math.min(Number(allocation.quantity || 0), availableQuantity));
    if (!quantity) return null;
    return {
      ...lineIdentity(line, lineIndex),
      quantity,
      line
    };
  }).filter(Boolean);
}

function batchTotalsFromAllocations(order, allocations) {
  const styleKeys = new Set();
  let units = 0;
  let value = 0;
  for (const allocation of allocations) {
    const line = allocation.line || {};
    const quantity = Number(allocation.quantity || 0);
    const orderedQuantity = Number(line.quantity || 0);
    const key = String(allocation.style || allocation.sku || allocation.buyingCode || allocation.lineIndex || "").trim().toLowerCase();
    if (key) styleKeys.add(key);
    units += quantity;
    if (orderedQuantity > 0) value += (Number(line.lineCost || 0) / orderedQuantity) * quantity;
  }
  return { styleCount: styleKeys.size, units, value };
}

function replaceBatchLineAllocations(order, batchId, allocations) {
  const db = openOrderSqliteDb();
  const clean = normalizeBatchLineAllocations(order, allocations, batchId);
  const insert = db.prepare(`
    INSERT INTO order_batch_lines (
      id, order_id, batch_id, line_index, sku, buying_code, style, quantity, created_at, updated_at
    ) VALUES (
      @id, @orderId, @batchId, @lineIndex, @sku, @buyingCode, @style, @quantity, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    )
  `);
  const replace = db.transaction(() => {
    db.prepare("DELETE FROM order_batch_lines WHERE order_id = ? AND batch_id = ?").run(String(order.id), String(batchId));
    for (const allocation of clean) {
      insert.run({
        id: crypto.randomUUID(),
        orderId: String(order.id),
        batchId: String(batchId),
        lineIndex: allocation.lineIndex,
        sku: allocation.sku,
        buyingCode: allocation.buyingCode,
        style: allocation.style,
        quantity: allocation.quantity
      });
    }
  });
  replace();
  return clean;
}

function batchSummary(orderOrId) {
  const order = resolveOrderForInvoiceSummary(orderOrId);
  const orderId = String(order?.id || orderOrId || "");
  const batches = readOrderBatches(orderId);
  const orderUnits = (order?.lines || []).reduce((total, line) => total + Number(line.quantity || 0), 0);
  const expectedUnits = batches.reduce((total, batch) => total + Number(batch.units || 0), 0);
  const expectedStyles = batches.reduce((total, batch) => total + Number(batch.styleCount || 0), 0);
  const receivedUnits = batches
    .filter(batch => batch.intakeStatus === "Received")
    .reduce((total, batch) => total + Number(batch.units || 0), 0);
  const shippedUnits = batches
    .filter(batch => ["Shipped", "Received"].includes(batch.intakeStatus))
    .reduce((total, batch) => total + Number(batch.units || 0), 0);
  const openBatches = batches.filter(batch => batch.intakeStatus !== "Received").length;
  const received = batches.filter(batch => batch.intakeStatus === "Received").length;
  const shipped = batches.filter(batch => batch.intakeStatus === "Shipped").length;
  const delayed = batches.filter(batch => batch.intakeStatus === "Delayed").length;
  const inProduction = batches.filter(batch => batch.intakeStatus === "In production").length;
  const confirmed = batches.filter(batch => batch.intakeStatus === "Confirmed").length;
  return {
    count: batches.length,
    expectedUnits,
    expectedStyles,
    orderUnits,
    receivedUnits,
    shippedUnits,
    outstandingUnits: Math.max(0, (orderUnits || expectedUnits) - receivedUnits),
    openBatches,
    received,
    shipped,
    delayed,
    inProduction,
    confirmed
  };
}

function invoiceFromRow(row, includeFile = true) {
  const filePath = row.file_path || "";
  return {
    id: row.id,
    orderId: row.order_id,
    batchId: row.batch_id || "",
    invoiceType: row.invoice_type || "",
    invoiceNumber: row.invoice_number || "",
    invoiceDate: row.invoice_date || "",
    dueDate: row.due_date || "",
    amount: Number(row.amount || 0),
    currency: row.currency || "GBP",
    isReceived: Boolean(row.is_received),
    sentToFd: Boolean(row.sent_to_fd),
    status: row.status || "Awaiting FD",
    fileName: row.file_name || "",
    mimeType: row.mime_type || "",
    filePath,
    fileUrl: publicUploadUrl(filePath),
    fileSize: Number(row.file_size || 0),
    fileData: "",
    notes: row.notes || "",
    uploadedBy: row.uploaded_by || "",
    uploadedAt: row.uploaded_at || "",
    updatedAt: row.updated_at || ""
  };
}

function readOrderInvoices(orderId, includeFiles = true) {
  return openOrderSqliteDb().prepare(`
    SELECT *
    FROM order_invoices
    WHERE order_id = ?
    ORDER BY uploaded_at DESC, updated_at DESC
  `).all(String(orderId)).map(row => invoiceFromRow(row, includeFiles));
}

function orderTotalGbp(order) {
  return Number(order?.totals?.grand || 0);
}

function orderFxRate(order) {
  return Number(order?.fxRate || order?.totals?.fxRate || 0);
}

function amountToGbp(amount, currency, order) {
  const value = Number(amount || 0);
  const code = String(currency || "GBP").toUpperCase();
  const rate = orderFxRate(order);
  if (code === "EUR" && rate) return value * rate;
  return value;
}

function amountToEur(amount, currency, order) {
  const value = Number(amount || 0);
  const code = String(currency || "GBP").toUpperCase();
  const rate = orderFxRate(order);
  if (code === "EUR") return value;
  return rate ? value / rate : 0;
}

function resolveOrderForInvoiceSummary(orderOrId) {
  if (orderOrId && typeof orderOrId === "object") return orderOrId;
  const orderId = String(orderOrId || "");
  if (!orderId) return null;
  return readOrderDb().orders.find(order => String(order.id) === orderId) || null;
}

function invoiceSummary(orderOrId) {
  const order = resolveOrderForInvoiceSummary(orderOrId);
  const orderId = String(order?.id || orderOrId || "");
  const invoices = readOrderInvoices(orderId, false);
  const unpaidActionable = invoices.filter(invoice => invoice.status !== "Paid" && (invoice.sentToFd || invoice.isReceived));
  const totalDue = invoices.reduce((total, invoice) => total + amountToGbp(invoice.amount, invoice.currency, order), 0);
  const totalDueEur = invoices.reduce((total, invoice) => total + amountToEur(invoice.amount, invoice.currency, order), 0);
  const totalPaid = invoices
    .filter(invoice => invoice.status === "Paid")
    .reduce((total, invoice) => total + amountToGbp(invoice.amount, invoice.currency, order), 0);
  const totalPaidEur = invoices
    .filter(invoice => invoice.status === "Paid")
    .reduce((total, invoice) => total + amountToEur(invoice.amount, invoice.currency, order), 0);
  const orderTotal = orderTotalGbp(order);
  const orderTotalEur = amountToEur(orderTotal, "GBP", order);
  const outstanding = Math.max(0, (orderTotal || totalDue) - totalPaid);
  const outstandingEur = Math.max(0, (orderTotalEur || totalDueEur) - totalPaidEur);
  return {
    count: invoices.length,
    sentToFd: invoices.filter(invoice => invoice.sentToFd).length,
    received: invoices.filter(invoice => invoice.isReceived).length,
    paid: invoices.filter(invoice => invoice.status === "Paid").length,
    unpaidActionable: unpaidActionable.length,
    orderTotal,
    orderTotalEur,
    totalDue,
    totalDueEur,
    totalPaid,
    totalPaidEur,
    outstanding,
    outstandingEur
  };
}

function invoiceSummaryIsFullyPaid(totals) {
  const orderTotal = Number(totals?.orderTotal || 0);
  return Number(totals?.totalPaid || 0) >= Math.max(0, orderTotal - 0.01) && orderTotal > 0;
}

function paymentStatusForBatchInvoices(invoices) {
  if (!invoices.length) return "Awaiting invoice";
  if (invoices.some(invoice => invoice.status === "Query")) return "Query";
  const paid = invoices.filter(invoice => invoice.status === "Paid").length;
  const actionable = invoices.filter(invoice => invoice.status !== "Paid" && (invoice.sentToFd || invoice.isReceived)).length;
  if (paid === invoices.length) return "Paid";
  if (paid > 0 && actionable > 0) return "Part paid";
  if (actionable > 0) return "Ready to pay";
  if (paid > 0) return "Paid";
  return "Awaiting invoice";
}

function syncBatchPaymentStatusesFromInvoices(orderId) {
  const db = openOrderSqliteDb();
  const batches = readOrderBatches(orderId);
  if (!batches.length) return;
  const invoices = readOrderInvoices(orderId, false);
  const update = db.prepare(`
    UPDATE order_batches
    SET payment_status = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND order_id = ?
  `);
  for (const batch of batches) {
    const status = paymentStatusForBatchInvoices(invoices.filter(invoice => invoice.batchId === batch.id));
    if (status !== batch.paymentStatus) update.run(status, batch.id, String(orderId));
  }
}

function syncAllBatchPaymentStatusesFromInvoices() {
  const db = openOrderSqliteDb();
  const rows = db.prepare("SELECT DISTINCT order_id AS orderId FROM order_batches").all();
  for (const row of rows) syncBatchPaymentStatusesFromInvoices(row.orderId);
}

function saveOrderInvoice(order, body, options = {}) {
  const db = openOrderSqliteDb();
  const canManagePayment = options.canManagePayment !== false;
  const rawInvoice = body.invoice || {};
  const id = String(rawInvoice.id || crypto.randomUUID());
  const existing = db.prepare("SELECT * FROM order_invoices WHERE id = ? AND order_id = ?").get(id, String(order.id));
  const existingInvoice = existing ? invoiceFromRow(existing) : {};
  const invoice = canManagePayment
    ? rawInvoice
    : {
        ...rawInvoice,
        sentToFd: existingInvoice.sentToFd || false,
        status: existingInvoice.status || "Awaiting FD"
      };
  const uploadedFile = writeInvoiceUpload(order, id, invoice);
  const filePath = uploadedFile?.filePath || existingInvoice.filePath || "";
  const fileSize = uploadedFile?.fileSize || existingInvoice.fileSize || 0;
  const fileName = uploadedFile?.fileName || invoice.fileName || existingInvoice.fileName || "";
  const mimeType = uploadedFile?.mimeType || invoice.mimeType || existingInvoice.mimeType || "";
  db.prepare(`
    INSERT INTO order_invoices (
      id, order_id, batch_id, invoice_type, invoice_number, invoice_date, due_date, amount, currency,
      is_received, sent_to_fd, status, file_name, mime_type, file_path, file_size, file_data, notes, uploaded_by, uploaded_at, updated_at
    ) VALUES (
      @id, @orderId, @batchId, @invoiceType, @invoiceNumber, @invoiceDate, @dueDate, @amount, @currency,
      @isReceived, @sentToFd, @status, @fileName, @mimeType, @filePath, @fileSize, '', @notes, @uploadedBy, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    )
    ON CONFLICT(id) DO UPDATE SET
      batch_id = excluded.batch_id,
      invoice_type = excluded.invoice_type,
      invoice_number = excluded.invoice_number,
      invoice_date = excluded.invoice_date,
      due_date = excluded.due_date,
      amount = excluded.amount,
      currency = excluded.currency,
      is_received = excluded.is_received,
      sent_to_fd = excluded.sent_to_fd,
      status = excluded.status,
      file_name = excluded.file_name,
      mime_type = excluded.mime_type,
      file_path = excluded.file_path,
      file_size = excluded.file_size,
      file_data = '',
      notes = excluded.notes,
      uploaded_by = excluded.uploaded_by,
      updated_at = CURRENT_TIMESTAMP
  `).run({
    id,
    orderId: String(order.id),
    batchId: String(invoice.batchId || "").trim(),
    invoiceType: String(invoice.invoiceType || "").trim(),
    invoiceNumber: String(invoice.invoiceNumber || "").trim(),
    invoiceDate: String(invoice.invoiceDate || "").trim(),
    dueDate: String(invoice.dueDate || "").trim(),
    amount: Number(invoice.amount || 0),
    currency: String(invoice.currency || order.terms?.currency || "GBP").trim(),
    isReceived: invoice.isReceived ? 1 : 0,
    sentToFd: canManagePayment && invoice.sentToFd ? 1 : existingInvoice.sentToFd ? 1 : 0,
    status: canManagePayment
      ? String(invoice.status || (invoice.sentToFd ? "Sent to FD" : "Awaiting FD")).trim()
      : String(existingInvoice.status || "Awaiting FD").trim(),
    fileName,
    mimeType,
    filePath,
    fileSize,
    notes: String(invoice.notes || "").trim(),
    uploadedBy: String(body.actorName || invoice.uploadedBy || "").trim()
  });
  if (uploadedFile?.filePath && existingInvoice.filePath && uploadedFile.filePath !== existingInvoice.filePath) {
    removeUploadFile(existingInvoice.filePath);
  }

  const action = canManagePayment && invoice.sentToFd ? "Invoice uploaded and sent to FD" : "Invoice uploaded";
  recordOrderEvent(order.id, "invoice", body.actorName || "", action, { invoiceId: id, invoiceNumber: invoice.invoiceNumber || "", fileName });
  syncBatchPaymentStatusesFromInvoices(order.id);
  syncPaymentWorkflowFromInvoices(order, body.actorName || "", { invoiceUploaded: true });
  syncBatchWorkflow(order, body.actorName || "");

  return readOrderInvoices(order.id);
}

function syncPaymentWorkflowFromInvoices(order, actorName = "", options = {}) {
  const invoices = readOrderInvoices(order.id, false);
  const current = workflowFromRow(openOrderSqliteDb().prepare("SELECT * FROM order_workflows WHERE order_id = ?").get(String(order.id)), order);
  if (!invoices.length) {
    if (["Paid", "Part paid", "Ready to pay", "Overdue"].includes(current.paymentStatus)) {
      writeOrderWorkflow(order, {
        paymentStatus: "Awaiting invoice",
        paymentAmount: Number(order.totals?.grand || 0),
        paymentPaidDate: "",
        nextActionOwner: "Buyer",
        nextAction: "Awaiting supplier invoice"
      }, actorName, "invoice");
      if (order.status === "Paid" || order.status === "Payment pending") updateStoredOrderStatus(order.id, "Approved");
    }
    return;
  }

  const totals = invoiceSummary(order);
  const allPaid = invoiceSummaryIsFullyPaid(totals);
  const somePaid = totals.totalPaid > 0;
  const hasUnpaidActionableInvoice = totals.unpaidActionable > 0;
  const anySent = totals.sentToFd > 0;
  const anyReceived = totals.received > 0;
  if (allPaid) {
    writeOrderWorkflow(order, {
      paymentStatus: "Paid",
      paymentAmount: totals.orderTotal || totals.totalDue,
      paymentPaidDate: todayIsoDate(),
      nextActionOwner: "Merchandising",
      nextAction: "Track intake date"
    }, actorName, "invoice");
    updateStoredOrderStatus(order.id, "Paid");
  } else if (somePaid && hasUnpaidActionableInvoice) {
    writeOrderWorkflow(order, {
      paymentStatus: "Part paid",
      paymentAmount: totals.orderTotal || totals.totalDue,
      paymentPaidDate: todayIsoDate(),
      nextActionOwner: "FD / Finance",
      nextAction: "Pay current supplier invoice"
    }, actorName, "invoice");
    updateStoredOrderStatus(order.id, "Payment pending");
  } else if (somePaid) {
    const summary = batchSummary(order);
    const activeIntake = summary.shipped > 0 || summary.received > 0 || summary.delayed > 0 || summary.inProduction > 0 || summary.confirmed > 0;
    writeOrderWorkflow(order, {
      paymentStatus: "Part paid",
      paymentAmount: totals.orderTotal || totals.totalDue,
      paymentPaidDate: todayIsoDate(),
      nextActionOwner: activeIntake ? "Merchandising" : "Buyer",
      nextAction: activeIntake ? "Track open supplier batches" : "Awaiting next supplier invoice"
    }, actorName, "invoice");
    updateStoredOrderStatus(order.id, "Payment pending");
  } else if (anyReceived || anySent || options.invoiceUploaded) {
    writeOrderWorkflow(order, {
      paymentStatus: "Ready to pay",
      paymentAmount: totals.orderTotal || totals.totalDue,
      nextActionOwner: "FD / Finance",
      nextAction: anySent ? "Pay supplier invoice" : "Review supplier invoice for payment"
    }, actorName, "invoice");
    updateStoredOrderStatus(order.id, "Payment pending");
  } else if (["Paid", "Part paid", "Ready to pay", "Overdue"].includes(current.paymentStatus)) {
    writeOrderWorkflow(order, {
      paymentStatus: "Awaiting invoice",
      paymentAmount: totals.orderTotal || totals.totalDue,
      paymentPaidDate: "",
      nextActionOwner: "Buyer",
      nextAction: "Send invoice to FD"
    }, actorName, "invoice");
    updateStoredOrderStatus(order.id, "Approved");
  }
}

function intakePatchForBatchSummary(summary, current) {
  if (!summary.count) return {};
  if (summary.received === summary.count) {
    return { intakeStatus: "Received", intakeActualDate: current.intakeActualDate || todayIsoDate() };
  }
  if (summary.received > 0) return { intakeStatus: "Part received" };
  if (summary.delayed > 0) return { intakeStatus: "Delayed" };
  if (summary.shipped > 0) return { intakeStatus: summary.shipped === summary.count ? "Shipped" : "Part shipped" };
  if (summary.inProduction > 0) return { intakeStatus: "In production" };
  if (summary.confirmed > 0) return { intakeStatus: "Confirmed" };
  return { intakeStatus: "Not confirmed" };
}

function syncBatchWorkflow(order, actorName = "") {
  const db = openOrderSqliteDb();
  const current = workflowFromRow(db.prepare("SELECT * FROM order_workflows WHERE order_id = ?").get(String(order.id)), order);
  const summary = batchSummary(order);
  const intakePatch = intakePatchForBatchSummary(summary, current);
  if (!Object.keys(intakePatch).length) return current;

  const invoiceTotals = invoiceSummary(order);
  const hasPaymentAction = invoiceTotals.unpaidActionable > 0 || ["Ready to pay", "Overdue"].includes(current.paymentStatus);
  const patch = { ...intakePatch };
  if (!hasPaymentAction) {
    if (["Received", "Part received", "Shipped", "Part shipped", "Delayed", "In production", "Confirmed"].includes(patch.intakeStatus)) {
      patch.nextActionOwner = "Merchandising";
      patch.nextAction = patch.intakeStatus === "Received"
        ? "Archive completed order"
        : patch.intakeStatus === "Part received"
          ? "Chase remaining intake"
          : patch.intakeStatus === "Shipped"
            ? "Track shipment to warehouse"
            : patch.intakeStatus === "Part shipped"
              ? "Track remaining supplier shipments"
              : patch.intakeStatus === "Delayed"
                ? "Resolve delayed intake"
                : "Track supplier production and ETA";
    } else if (current.paymentStatus === "Part paid") {
      patch.nextActionOwner = "Buyer";
      patch.nextAction = "Awaiting next supplier invoice";
    }
  }
  const workflow = writeOrderWorkflow(order, patch, actorName, "batch");
  const status = orderStatusFromWorkflow(workflow);
  if (status) updateStoredOrderStatus(order.id, status);
  return workflow;
}

function saveOrderBatch(order, body) {
  assertOrderProductsCompleteForWarehouse(order);
  const db = openOrderSqliteDb();
  const batch = body.batch || {};
  const id = String(batch.id || crypto.randomUUID());
  const existing = db.prepare("SELECT * FROM order_batches WHERE id = ? AND order_id = ?").get(id, String(order.id));
  const existingBatch = existing ? batchFromRow(existing) : {};
  const hasLineAllocations = Array.isArray(batch.lineAllocations);
  const cleanAllocations = hasLineAllocations ? normalizeBatchLineAllocations(order, batch.lineAllocations, id) : [];
  const allocationTotals = hasLineAllocations ? batchTotalsFromAllocations(order, cleanAllocations) : null;
  db.prepare(`
    INSERT INTO order_batches (
      id, order_id, batch_number, title, style_count, units, value, currency,
      payment_status, intake_status, eta_date, shipped_date, received_date, tracking_reference,
      style_notes, notes, created_at, updated_at
    ) VALUES (
      @id, @orderId, @batchNumber, @title, @styleCount, @units, @value, @currency,
      @paymentStatus, @intakeStatus, @etaDate, @shippedDate, @receivedDate, @trackingReference,
      @styleNotes, @notes, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    )
    ON CONFLICT(id) DO UPDATE SET
      batch_number = excluded.batch_number,
      title = excluded.title,
      style_count = excluded.style_count,
      units = excluded.units,
      value = excluded.value,
      currency = excluded.currency,
      payment_status = excluded.payment_status,
      intake_status = excluded.intake_status,
      eta_date = excluded.eta_date,
      shipped_date = excluded.shipped_date,
      received_date = excluded.received_date,
      tracking_reference = excluded.tracking_reference,
      style_notes = excluded.style_notes,
      notes = excluded.notes,
      updated_at = CURRENT_TIMESTAMP
  `).run({
    id,
    orderId: String(order.id),
    batchNumber: String(batch.batchNumber || existingBatch.batchNumber || "").trim(),
    title: String(batch.title || "").trim(),
    styleCount: allocationTotals ? allocationTotals.styleCount : Number(batch.styleCount || 0),
    units: allocationTotals ? allocationTotals.units : Number(batch.units || 0),
    value: allocationTotals ? allocationTotals.value : Number(batch.value || 0),
    currency: String(batch.currency || order.terms?.currency || "GBP").trim(),
    paymentStatus: String(batch.paymentStatus || "Awaiting invoice").trim(),
    intakeStatus: String(batch.intakeStatus || "Not confirmed").trim(),
    etaDate: String(batch.etaDate || "").trim(),
    shippedDate: String(batch.shippedDate || "").trim(),
    receivedDate: String(batch.receivedDate || "").trim(),
    trackingReference: String(batch.trackingReference || "").trim(),
    styleNotes: String(batch.styleNotes || "").trim(),
    notes: String(batch.notes || "").trim()
  });
  if (hasLineAllocations) replaceBatchLineAllocations(order, id, cleanAllocations);
  recordOrderEvent(order.id, "batch", body.actorName || "", existing ? "Batch updated" : "Batch created", { batchId: id, batchNumber: batch.batchNumber || "", lineAllocations: cleanAllocations.length });
  syncBatchWorkflow(order, body.actorName || "");
  return readOrderBatches(order.id);
}

function deleteOrderBatch(order, body) {
  const batchId = String(body.batchId || "");
  if (!batchId) throw new Error("Missing batch");
  const db = openOrderSqliteDb();
  const batch = db.prepare("SELECT * FROM order_batches WHERE id = ? AND order_id = ?").get(batchId, String(order.id));
  if (!batch) throw new Error("Batch not found");
  db.prepare("UPDATE order_invoices SET batch_id = '' WHERE order_id = ? AND batch_id = ?").run(String(order.id), batchId);
  db.prepare("DELETE FROM order_batch_lines WHERE order_id = ? AND batch_id = ?").run(String(order.id), batchId);
  db.prepare("DELETE FROM order_batches WHERE id = ? AND order_id = ?").run(batchId, String(order.id));
  recordOrderEvent(order.id, "batch", body.actorName || "", "Batch deleted", { batchId, batchNumber: batch.batch_number || "" });
  syncBatchPaymentStatusesFromInvoices(order.id);
  syncBatchWorkflow(order, body.actorName || "");
  syncPaymentWorkflowFromInvoices(order, body.actorName || "");
  return readOrderBatches(order.id);
}

function deleteOrderInvoice(order, body) {
  const invoiceId = String(body.invoiceId || "");
  if (!invoiceId) throw new Error("Missing invoice");
  const db = openOrderSqliteDb();
  const invoice = db.prepare("SELECT * FROM order_invoices WHERE id = ? AND order_id = ?").get(invoiceId, String(order.id));
  if (!invoice) throw new Error("Invoice not found");
  db.prepare("DELETE FROM order_invoices WHERE id = ? AND order_id = ?").run(invoiceId, String(order.id));
  removeUploadFile(invoice.file_path || "");
  recordOrderEvent(order.id, "invoice", body.actorName || "", "Invoice deleted", { invoiceId, invoiceNumber: invoice.invoice_number || "", fileName: invoice.file_name || "" });
  syncBatchPaymentStatusesFromInvoices(order.id);
  syncPaymentWorkflowFromInvoices(order, body.actorName || "");
  return readOrderInvoices(order.id);
}

const weeklyActionStatuses = ["Open", "In progress", "Snoozed", "Blocked", "Done"];
const weeklyActionOwners = ["Buyer", "Merchandising"];
const weeklyActionPriorities = ["High", "Medium", "Low"];

function addDaysIso(dateValue, days) {
  const base = dateValue ? new Date(`${dateValue}T00:00:00.000Z`) : new Date();
  if (!Number.isFinite(base.getTime())) return "";
  base.setUTCDate(base.getUTCDate() + Number(days || 0));
  return isoDateOnly(base);
}

function normalizeWeeklyActionStatus(value) {
  const found = weeklyActionStatuses.find(status => status.toLowerCase() === String(value || "").trim().toLowerCase());
  return found || "Open";
}

function normalizeWeeklyActionOwner(value, fallback = "Merchandising") {
  const found = weeklyActionOwners.find(owner => owner.toLowerCase() === String(value || "").trim().toLowerCase());
  return found || fallback;
}

function normalizeWeeklyActionPriority(value, fallback = "Medium") {
  const found = weeklyActionPriorities.find(priority => priority.toLowerCase() === String(value || "").trim().toLowerCase());
  return found || fallback;
}

function weeklyActionTypeLabel(type) {
  return ({
    reorder: "Reorder risk",
    markdown: "Markdown risk",
    feature: "Feature winner",
    watch: "Watch item"
  })[type] || type || "Action";
}

function weeklyActionFromRow(row, events = null) {
  if (!row) return null;
  return {
    id: row.id,
    dedupeKey: row.dedupe_key,
    actionType: row.action_type,
    actionTypeLabel: weeklyActionTypeLabel(row.action_type),
    title: row.title,
    productKey: row.product_key || "",
    productTitle: row.product_title || "",
    sku: row.sku || "",
    season: row.season || "",
    category: row.category || "",
    owner: row.owner || "Merchandising",
    assigneeUserId: row.assignee_user_id || "",
    status: row.status || "Open",
    priority: row.priority || "Medium",
    dueDate: row.due_date || "",
    sourceType: row.source_type || "bestsellers",
    sourcePeriodId: row.source_period_id || "",
    sourceStartDate: row.source_start_date || "",
    sourceEndDate: row.source_end_date || "",
    sourceLabel: row.source_label || "",
    rationale: row.rationale || "",
    metrics: parseJson(row.metrics_json, {}),
    data: parseJson(row.data, {}),
    generatedAt: row.generated_at || "",
    completedAt: row.completed_at || "",
    createdAt: row.created_at || "",
    updatedAt: row.updated_at || "",
    events: events || undefined
  };
}

function readWeeklyActionEvents(actionId, limit = 60) {
  return openOrderSqliteDb().prepare(`
    SELECT id, action_id AS actionId, event_type AS eventType, actor_name AS actorName, message, data, created_at AS createdAt
    FROM weekly_action_events
    WHERE action_id = ?
    ORDER BY created_at DESC
    LIMIT ?
  `).all(String(actionId), limit).map(row => ({ ...row, data: parseJson(row.data, {}) }));
}

function recordWeeklyActionEvent(actionId, eventType, actorName, message, data = {}) {
  openOrderSqliteDb().prepare(`
    INSERT INTO weekly_action_events (id, action_id, event_type, actor_name, message, data, created_at)
    VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `).run(crypto.randomUUID(), String(actionId), eventType || "update", actorName || "", message || "Updated", JSON.stringify(data || {}));
}

function roleForOwner(owner) {
  return ({
    "Buyer": "Buyer",
    "Buying Director": "Buying Director",
    "FD / Finance": "Finance",
    "Finance": "Finance",
    "Merchandising": "Merchandising"
  })[String(owner || "").trim()] || "";
}

function publicAssignableUsers() {
  return openOrderSqliteDb().prepare(`
    SELECT *
    FROM users
    WHERE is_active = 1
    ORDER BY display_name COLLATE NOCASE, email COLLATE NOCASE
  `).all().map(publicUser).filter(Boolean);
}

function normalizeAssignableUserId(value) {
  const id = String(value || "").trim();
  if (!id) return "";
  const row = openOrderSqliteDb().prepare("SELECT id FROM users WHERE id = ? AND is_active = 1").get(id);
  return row ? id : "";
}

function userById(userId) {
  if (!userId) return null;
  return publicUser(openOrderSqliteDb().prepare("SELECT * FROM users WHERE id = ?").get(String(userId)));
}

function resolveNotificationUserIds(userId, role) {
  const explicit = normalizeAssignableUserId(userId);
  if (explicit) return [explicit];
  const appRole = roleForOwner(role);
  if (!appRole) return [];
  const users = publicAssignableUsers();
  const matches = users.filter(user => (user.roles || []).includes(appRole)).map(user => user.id);
  if (matches.length) return matches;
  return users.filter(user => user.isAdmin || (user.roles || []).includes("Admin")).map(user => user.id);
}

function smtpConfigured() {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_FROM);
}

function notificationDigestDelayMinutes() {
  const minutes = Number(process.env.NOTIFICATION_DIGEST_DELAY_MINUTES || 10);
  return Number.isFinite(minutes) && minutes >= 0 ? minutes : 10;
}

function appBaseUrl() {
  return String(process.env.APP_BASE_URL || process.env.PUBLIC_APP_URL || `http://localhost:${port}`).replace(/\/+$/, "");
}

function absoluteAppUrl(value) {
  const raw = String(value || "/");
  if (/^https?:\/\//i.test(raw)) return raw;
  return `${appBaseUrl()}${raw.startsWith("/") ? raw : `/${raw}`}`;
}

function smtpRead(socket, label = "SMTP response") {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`${label} timed out`));
    }, 30_000);
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", onError);
    };
    const onData = (chunk) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split(/\r?\n/).filter(Boolean);
      const last = lines[lines.length - 1] || "";
      if (/^\d{3}\s/.test(last)) {
        cleanup();
        resolve(buffer);
      }
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    socket.on("data", onData);
    socket.on("error", onError);
  });
}

async function smtpCommand(socket, command, expected = /^[23]/) {
  if (command) socket.write(`${command}\r\n`);
  const response = await smtpRead(socket, command ? `SMTP ${String(command).split(/\s+/)[0]}` : "SMTP greeting");
  if (!expected.test(response)) throw new Error(response.trim().split(/\r?\n/).slice(-1)[0] || "SMTP command failed");
  return response;
}

function smtpConnect(host, port) {
  const net = require("node:net");
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, host);
    const timer = setTimeout(() => {
      cleanup();
      socket.destroy();
      reject(new Error("SMTP connection timed out"));
    }, 30_000);
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("connect", onConnect);
      socket.off("error", onError);
    };
    const onConnect = () => {
      cleanup();
      resolve(socket);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    socket.once("connect", onConnect);
    socket.once("error", onError);
  });
}

function smtpStartTls(socket, host) {
  const tls = require("node:tls");
  return new Promise((resolve, reject) => {
    const secure = tls.connect({ socket, servername: host });
    const timer = setTimeout(() => {
      cleanup();
      secure.destroy();
      reject(new Error("SMTP TLS handshake timed out"));
    }, 30_000);
    const cleanup = () => {
      clearTimeout(timer);
      secure.off("secureConnect", onSecureConnect);
      secure.off("error", onError);
    };
    const onSecureConnect = () => {
      cleanup();
      resolve(secure);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    secure.once("secureConnect", onSecureConnect);
    secure.once("error", onError);
  });
}

function dotStuff(value) {
  return String(value || "")
    .replace(/\r?\n/g, "\r\n")
    .split("\r\n")
    .map(line => line.startsWith(".") ? `.${line}` : line)
    .join("\r\n");
}

function htmlShell(title, bodyHtml, actionUrl = "") {
  const safeTitle = escapeHtml(title || "Merch X");
  const safeActionUrl = actionUrl ? escapeHtml(actionUrl) : "";
  return `<!doctype html>
<html>
<body style="margin:0;padding:0;background:#eef2f6;font-family:Arial,sans-serif;color:#172033">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#eef2f6;padding:24px 0">
    <tr>
      <td align="center">
        <table role="presentation" width="620" cellspacing="0" cellpadding="0" style="max-width:620px;width:100%;background:#ffffff;border:1px solid #d6dee9;border-radius:6px;overflow:hidden">
          <tr><td style="padding:16px 20px;border-bottom:1px solid #d6dee9;background:#f6f8fb"><strong style="font-size:16px;color:#172033">Merch X</strong></td></tr>
          <tr><td style="padding:22px 20px">
            <h1 style="font-size:20px;line-height:1.3;margin:0 0 12px;color:#172033">${safeTitle}</h1>
            <div style="font-size:14px;line-height:1.6;color:#5f6f86">${bodyHtml}</div>
            ${safeActionUrl ? `<p style="margin:20px 0 0"><a href="${safeActionUrl}" style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;padding:10px 14px;border-radius:4px;font-weight:bold">Open in Merch X</a></p>` : ""}
          </td></tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function simpleEmailHtml(title, bodyText, actionUrl = "") {
  const lines = String(bodyText || "").split(/\r?\n/).filter(Boolean).map(line => `<p style="margin:0 0 10px">${escapeHtml(line)}</p>`).join("");
  return htmlShell(title, lines || "<p style=\"margin:0\">You have a Merch X update.</p>", actionUrl);
}

async function sendSmtpEmail(to, subject, bodyText, htmlBody = "") {
  const host = process.env.SMTP_HOST || "";
  const port = Number(process.env.SMTP_PORT || 587);
  const from = process.env.SMTP_FROM || "";
  if (!host || !from || !to) throw new Error("SMTP is not configured.");
  let socket = await smtpConnect(host, port);
  await smtpCommand(socket, "");
  let ehlo = await smtpCommand(socket, `EHLO ${process.env.SMTP_HELO || "merch-x.local"}`);
  if (/STARTTLS/i.test(ehlo)) {
    await smtpCommand(socket, "STARTTLS");
    socket = await smtpStartTls(socket, host);
    ehlo = await smtpCommand(socket, `EHLO ${process.env.SMTP_HELO || "merch-x.local"}`);
  }
  if (process.env.SMTP_USERNAME && process.env.SMTP_PASSWORD) {
    const auth = Buffer.from(`\0${process.env.SMTP_USERNAME}\0${process.env.SMTP_PASSWORD}`).toString("base64");
    await smtpCommand(socket, `AUTH PLAIN ${auth}`);
  }
  const escapeAddress = (value) => String(value || "").replace(/[<>\r\n]/g, "");
  const cleanSubject = String(subject || "Merch X notification").replace(/[\r\n]+/g, " ").slice(0, 160);
  const boundary = `merch-x-${crypto.randomBytes(12).toString("hex")}`;
  const safeBody = dotStuff(bodyText);
  const safeHtml = dotStuff(htmlBody || simpleEmailHtml(cleanSubject, bodyText));
  const headers = [
    `From: Merch X <${escapeAddress(from)}>`,
    `To: ${escapeAddress(to)}`,
    `Subject: ${cleanSubject}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`
  ].join("\r\n");
  const message = [
    headers,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    safeBody,
    `--${boundary}`,
    "Content-Type: text/html; charset=utf-8",
    "",
    safeHtml,
    `--${boundary}--`,
    "."
  ].join("\r\n");
  await smtpCommand(socket, `MAIL FROM:<${escapeAddress(from)}>`);
  await smtpCommand(socket, `RCPT TO:<${escapeAddress(to)}>`);
  await smtpCommand(socket, "DATA", /^3/);
  await smtpCommand(socket, message);
  socket.write("QUIT\r\n");
}

async function notifyUser(userId, notification) {
  if (!userId) return null;
  const user = userById(userId);
  if (!user?.isActive) return null;
  const db = openOrderSqliteDb();
  const id = crypto.randomUUID();
  const emailMode = notification.emailMode || (notification.entityType === "weekly_action" ? "digest" : "immediate");
  const initialEmailStatus = smtpConfigured()
    ? emailMode === "digest" ? "digest_pending" : "pending"
    : "not_configured";
  db.prepare(`
    INSERT INTO notifications (
      id, user_id, entity_type, entity_id, title, body, url, is_read,
      email_status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, CURRENT_TIMESTAMP)
  `).run(
    id,
    userId,
    notification.entityType || "",
    notification.entityId || "",
    notification.title || "Merch X notification",
    notification.body || "",
    notification.url || "",
    initialEmailStatus
  );
  if (smtpConfigured() && emailMode !== "digest") {
    try {
      const actionUrl = absoluteAppUrl(notification.url || "/");
      const text = `${notification.body || ""}\n\nOpen in Merch X: ${actionUrl}`;
      await sendSmtpEmail(
        user.email,
        notification.title,
        text,
        simpleEmailHtml(notification.title, notification.body || "", actionUrl)
      );
      db.prepare("UPDATE notifications SET email_status = 'sent', emailed_at = CURRENT_TIMESTAMP WHERE id = ?").run(id);
    } catch (error) {
      db.prepare("UPDATE notifications SET email_status = 'failed', email_error = ? WHERE id = ?").run(String(error.message || error).slice(0, 500), id);
    }
  }
  return id;
}

function digestEmailText(rows) {
  const lines = [`You have ${rows.length} Weekly Action update${rows.length === 1 ? "" : "s"} in Merch X.`, ""];
  for (const row of rows) {
    lines.push(`- ${row.title}`);
    if (row.body) lines.push(`  ${row.body}`);
    lines.push(`  ${absoluteAppUrl(row.url || "/weekly-actions.html")}`);
    lines.push("");
  }
  return lines.join("\n").trim();
}

function digestEmailHtml(rows) {
  const list = rows.map(row => {
    const url = absoluteAppUrl(row.url || "/weekly-actions.html");
    return `<tr>
      <td style="padding:10px 0;border-bottom:1px solid #d6dee9">
        <p style="margin:0 0 4px;color:#172033;font-weight:bold">${escapeHtml(row.title)}</p>
        ${row.body ? `<p style="margin:0 0 8px;color:#5f6f86">${escapeHtml(row.body)}</p>` : ""}
        <a href="${escapeHtml(url)}" style="color:#2563eb;text-decoration:none;font-weight:bold">Open action</a>
      </td>
    </tr>`;
  }).join("");
  return htmlShell(
    `${rows.length} Weekly Action update${rows.length === 1 ? "" : "s"}`,
    `<p style="margin:0 0 12px">Here are the Weekly Action updates grouped from the last few minutes.</p><table role="presentation" width="100%" cellspacing="0" cellpadding="0">${list}</table>`,
    absoluteAppUrl("/weekly-actions.html")
  );
}

async function flushWeeklyActionEmailDigests() {
  if (!smtpConfigured()) return;
  const db = openOrderSqliteDb();
  const delay = notificationDigestDelayMinutes();
  const rows = db.prepare(`
    SELECT n.id, n.user_id AS userId, n.title, n.body, n.url, n.created_at AS createdAt,
           u.email, u.display_name AS displayName
    FROM notifications n
    JOIN users u ON u.id = n.user_id
    WHERE n.email_status = 'digest_pending'
      AND n.entity_type = 'weekly_action'
      AND datetime(n.created_at) <= datetime('now', ?)
      AND u.is_active = 1
    ORDER BY n.user_id, n.created_at ASC
    LIMIT 500
  `).all(`-${delay} minutes`);
  const byUser = new Map();
  for (const row of rows) {
    if (!byUser.has(row.userId)) byUser.set(row.userId, []);
    byUser.get(row.userId).push(row);
  }
  for (const group of byUser.values()) {
    const ids = group.map(row => row.id);
    const placeholders = ids.map(() => "?").join(",");
    try {
      await sendSmtpEmail(
        group[0].email,
        `Merch X: ${group.length} Weekly Action update${group.length === 1 ? "" : "s"}`,
        digestEmailText(group),
        digestEmailHtml(group)
      );
      db.prepare(`UPDATE notifications SET email_status = 'sent', emailed_at = CURRENT_TIMESTAMP WHERE id IN (${placeholders})`).run(...ids);
    } catch (error) {
      db.prepare(`UPDATE notifications SET email_status = 'failed', email_error = ? WHERE id IN (${placeholders})`).run(String(error.message || error).slice(0, 500), ...ids);
    }
  }
}

function startNotificationDigestTimer() {
  if (!smtpConfigured()) return;
  setInterval(() => {
    flushWeeklyActionEmailDigests().catch(error => {
      console.error("Weekly action digest failed:", error.message || error);
    });
  }, 60_000).unref();
  setTimeout(() => {
    flushWeeklyActionEmailDigests().catch(error => {
      console.error("Weekly action digest failed:", error.message || error);
    });
  }, 5_000).unref();
}

async function notifyMentionedUsers(req, message, entity) {
  const text = String(message || "");
  const emails = [...new Set((text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || []).map(email => email.toLowerCase()))];
  if (!emails.length) return;
  const db = openOrderSqliteDb();
  for (const email of emails) {
    const row = db.prepare("SELECT id FROM users WHERE lower(email) = ? AND is_active = 1").get(email);
    if (!row) continue;
    await notifyUser(row.id, {
      entityType: entity.entityType,
      entityId: entity.entityId,
      title: entity.title || "You were mentioned in Merch X",
      body: `${actorName(req)} mentioned you: ${text}`,
      url: entity.url || "/"
    });
  }
}

async function recordWorkHandoff(req, handoff) {
  const toUserIds = resolveNotificationUserIds(handoff.toUserId, handoff.toRole);
  const db = openOrderSqliteDb();
  const id = crypto.randomUUID();
  db.prepare(`
    INSERT INTO work_handoffs (
      id, entity_type, entity_id, from_role, to_role, from_user_id, to_user_id,
      message, status, created_by_user_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, CURRENT_TIMESTAMP)
  `).run(
    id,
    handoff.entityType,
    handoff.entityId,
    handoff.fromRole || "",
    handoff.toRole || "",
    handoff.fromUserId || "",
    toUserIds[0] || "",
    handoff.message || "",
    req.currentUser?.id && req.currentUser.id !== "system" ? req.currentUser.id : ""
  );
  for (const toUserId of toUserIds) {
    await notifyUser(toUserId, {
      entityType: handoff.entityType,
      entityId: handoff.entityId,
      title: handoff.title || "Merch X handoff",
      body: handoff.message || "",
      url: handoff.url || "/"
    });
  }
  return id;
}

async function notifyOrderHandoffIfChanged(req, order, updatedOrder, previousWorkflow, workflow, options = {}) {
  if (!previousWorkflow || !workflow) return;
  const ownerChanged = previousWorkflow.nextActionOwner !== workflow.nextActionOwner;
  const assigneeChanged = previousWorkflow.nextActionUserId !== workflow.nextActionUserId;
  const roleActionChanged = options.notifyRoleActionChange
    && !workflow.nextActionUserId
    && previousWorkflow.nextAction !== workflow.nextAction
    && Boolean(roleForOwner(workflow.nextActionOwner));
  if (!ownerChanged && !assigneeChanged && !roleActionChanged) return;
  const assignedUser = userById(workflow.nextActionUserId);
  const message = assignedUser
    ? `Handoff to ${assignedUser.displayName} (${workflow.nextActionOwner || "No role"})`
    : `Handoff to ${workflow.nextActionOwner || "No owner"}`;
  recordOrderEvent(order.id, "handoff", actorName(req), message, {
    fromRole: previousWorkflow.nextActionOwner || "",
    toRole: workflow.nextActionOwner || "",
    fromUserId: previousWorkflow.nextActionUserId || "",
    toUserId: workflow.nextActionUserId || "",
    ...actorData(req)
  });
  await recordWorkHandoff(req, {
    entityType: "order",
    entityId: String(order.id),
    fromRole: previousWorkflow.nextActionOwner || "",
    toRole: workflow.nextActionOwner || "",
    fromUserId: previousWorkflow.nextActionUserId || "",
    toUserId: workflow.nextActionUserId || "",
    title: `Order ${updatedOrder.orderNumber || order.orderNumber || ""} handed off`,
    message: `${actorName(req)} assigned ${updatedOrder.orderNumber || "an order"}: ${workflow.nextAction || "Next action"}`,
    url: `/orders.html?id=${encodeURIComponent(String(order.id))}`
  });
}

async function notifyOrderCreatedForApproval(req, order, workflow) {
  if (workflow?.approvalStatus !== "Pending director approval" || workflow?.nextActionOwner !== "Buying Director") return;
  recordOrderEvent(order.id, "handoff", actorName(req), "Handoff to Buying Director", {
    fromRole: "",
    toRole: "Buying Director",
    fromUserId: "",
    toUserId: "",
    ...actorData(req)
  });
  await recordWorkHandoff(req, {
    entityType: "order",
    entityId: String(order.id),
    fromRole: "",
    toRole: "Buying Director",
    fromUserId: "",
    toUserId: "",
    title: `Order ${order.orderNumber || ""} awaiting sign off`,
    message: `${actorName(req)} created ${order.orderNumber || "an order"} for sign off: ${workflow.nextAction || "Review order for approval"}`,
    url: `/orders.html?id=${encodeURIComponent(String(order.id))}`
  });
}

function resolveOrderBuyerNotificationUserIds(order) {
  const buyerEmail = String(order?.company?.buyerEmail || "").trim().toLowerCase();
  if (buyerEmail) {
    const row = openOrderSqliteDb().prepare("SELECT id FROM users WHERE lower(email) = ? AND is_active = 1").get(buyerEmail);
    if (row?.id) return [row.id];
  }
  return resolveNotificationUserIds("", "Buyer");
}

async function notifyOrderBuyerInvoicePaid(req, order) {
  const userIds = resolveOrderBuyerNotificationUserIds(order);
  if (!userIds.length) return;
  recordOrderEvent(order.id, "invoice", actorName(req), "Buyer notified invoice paid", actorData(req));
  for (const userId of userIds) {
    await notifyUser(userId, {
      entityType: "order",
      entityId: String(order.id),
      title: `Order ${order.orderNumber || ""} invoice paid`,
      body: `${actorName(req)} marked ${order.orderNumber || "an order"} as paid.`,
      url: `/orders.html?id=${encodeURIComponent(String(order.id))}`
    });
  }
}

function userPermissions(user) {
  if (!user?.isActive) return [];
  if (userHasRole(user, ["Admin"])) return ["all"];
  const permissions = new Set(["view"]);
  if (userHasRole(user, ["Buyer"])) {
    permissions.add("orders:create");
    permissions.add("orders:buyer");
    permissions.add("skus:issue");
    permissions.add("weekly:update");
  }
  if (userHasRole(user, ["Buying Director"])) permissions.add("orders:approve");
  if (userHasRole(user, ["Finance"])) {
    permissions.add("orders:payment");
    permissions.add("orders:invoice");
  }
  if (userHasRole(user, ["Merchandising"])) {
    permissions.add("orders:intake");
    permissions.add("orders:archive");
    permissions.add("weekly:update");
  }
  return [...permissions];
}

function rolesForOrderSection(section) {
  return ({
    approval: ["Buying Director", "Admin"],
    payment: ["Finance", "Admin"],
    invoice: ["Finance", "Admin"],
    intake: ["Merchandising", "Admin"],
    "next action": ["Buyer", "Buying Director", "Finance", "Merchandising", "Admin"],
    workflow: ["Buyer", "Buying Director", "Finance", "Merchandising", "Admin"]
  })[String(section || "workflow").trim().toLowerCase()] || ["Admin"];
}

function adminUserRows() {
  return openOrderSqliteDb().prepare(`
    SELECT *
    FROM users
    ORDER BY is_active DESC, display_name COLLATE NOCASE, email COLLATE NOCASE
  `).all().map(publicUser).filter(Boolean);
}

async function handleAuthApi(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (req.method === "GET" && url.pathname === "/api/auth/google/start") {
    startGoogleAppAuth(req, res);
    return true;
  }
  if (req.method === "GET" && url.pathname === "/api/auth/google/callback") {
    await finishGoogleAppAuth(req, res);
    return true;
  }
  if (req.method === "GET" && url.pathname === "/api/auth/me") {
    const user = authMode() === "google" ? readSessionUser(req) : systemUser();
    sendJson(res, 200, {
      authMode: authMode(),
      user,
      permissions: userPermissions(user),
      roles: authRoles,
      csrfToken: user?.csrfToken || ""
    });
    return true;
  }
  if (req.method === "POST" && url.pathname === "/api/auth/logout") {
    destroySession(req, res);
    sendJson(res, 200, { ok: true });
    return true;
  }
  return false;
}

async function handleAdminApi(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (!requireRoles(req, res, ["Admin"])) return true;
  if (req.method === "GET" && url.pathname === "/api/admin/users") {
    sendJson(res, 200, { users: adminUserRows(), roles: authRoles });
    return true;
  }
  if (req.method === "POST" && url.pathname === "/api/admin/users/update") {
    const body = await readJsonBody(req);
    const userId = String(body.userId || "").trim();
    const patch = body.patch || {};
    const row = openOrderSqliteDb().prepare("SELECT * FROM users WHERE id = ?").get(userId);
    if (!row) {
      sendJson(res, 404, { error: "User not found." });
      return true;
    }
    const roles = Array.isArray(patch.roles) ? patch.roles.filter(role => authRoles.includes(role)) : parseJson(row.roles_json, []);
    const active = Object.prototype.hasOwnProperty.call(patch, "isActive") ? (patch.isActive ? 1 : 0) : Number(row.is_active || 0);
    const admin = roles.includes("Admin") || patch.isAdmin ? 1 : 0;
    openOrderSqliteDb().prepare(`
      UPDATE users
      SET roles_json = ?, is_active = ?, is_admin = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(JSON.stringify(roles), active, admin, userId);
    sendJson(res, 200, { ok: true, users: adminUserRows(), roles: authRoles });
    return true;
  }
  return false;
}

async function handleNotificationApi(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (req.method === "GET" && url.pathname === "/api/notifications") {
    if (!req.currentUser?.id || req.currentUser.id === "system") {
      sendJson(res, 200, { notifications: [], unreadCount: 0 });
      return true;
    }
    const rows = openOrderSqliteDb().prepare(`
      SELECT id, entity_type AS entityType, entity_id AS entityId, title, body, url,
             is_read AS isRead, email_status AS emailStatus, created_at AS createdAt, read_at AS readAt
      FROM notifications
      WHERE user_id = ?
      ORDER BY is_read ASC, created_at DESC
      LIMIT 60
    `).all(req.currentUser.id).map(row => ({ ...row, isRead: Boolean(row.isRead) }));
    sendJson(res, 200, { notifications: rows, unreadCount: rows.filter(row => !row.isRead).length });
    return true;
  }
  if (req.method === "POST" && url.pathname === "/api/notifications/read") {
    const body = await readJsonBody(req);
    const id = String(body.id || "").trim();
    const db = openOrderSqliteDb();
    if (body.all) {
      db.prepare("UPDATE notifications SET is_read = 1, read_at = CURRENT_TIMESTAMP WHERE user_id = ?").run(req.currentUser.id || "");
    } else if (id) {
      db.prepare("UPDATE notifications SET is_read = 1, read_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?").run(id, req.currentUser.id || "");
    }
    sendJson(res, 200, { ok: true });
    return true;
  }
  if (req.method === "GET" && url.pathname === "/api/users/assignees") {
    sendJson(res, 200, { users: publicAssignableUsers() });
    return true;
  }
  return false;
}

function latestBestsellersPeriodRow() {
  return openOrderSqliteDb().prepare(`
    SELECT *
    FROM report_periods
    WHERE report_type = 'bestsellers'
      AND source_type = 'shopify_api'
      AND status = 'ready'
    ORDER BY start_date DESC, end_date DESC
    LIMIT 1
  `).get();
}

function weeklyActionsPeriodFromRequest(body = {}) {
  const sourceType = String(body.sourceType || "shopify_api").trim() || "shopify_api";
  if (body.periodId) {
    const row = openOrderSqliteDb().prepare(`
      SELECT *
      FROM report_periods
      WHERE id = ?
        AND report_type = 'bestsellers'
    `).get(String(body.periodId));
    if (!row) throw new Error("Saved bestsellers period not found.");
    return row;
  }
  if (validReportDate(body.startDate) && validReportDate(body.endDate)) {
    const row = bestsellersPeriodRow(body.startDate, body.endDate, sourceType);
    if (!row) throw new Error("No saved bestsellers report exists for that period.");
    return row;
  }
  const latest = latestBestsellersPeriodRow();
  if (!latest) throw new Error("No saved Shopify bestsellers reports exist yet. Sync Shopify from the Bestsellers report first.");
  return latest;
}

function stockValue(product) {
  return Math.max(0, Number(product.stock || 0)) * Math.max(0, Number(product.rrp || product.avgP || 0));
}

function productMetricSnapshot(product) {
  return {
    revenue: Number(product.rev || 0),
    units: Number(product.units || 0),
    stock: product.stock == null ? null : Number(product.stock || 0),
    coverWks: product.coverWks == null ? null : Number(product.coverWks || 0),
    forecastBuy: product.forecastBuy == null ? null : Number(product.forecastBuy || 0),
    gpPct: Number(product.gpPct || 0),
    grossProfit: Number(product.gp || 0),
    avgPrice: Number(product.avgP || product.rrp || 0),
    price: product.rrp == null ? null : Number(product.rrp || 0),
    compareAtPrice: product.compareAtPrice == null ? null : Number(product.compareAtPrice || 0),
    isMarkedDown: Boolean(product.isMarkedDown || (product.compareAtPrice && product.rrp && Number(product.compareAtPrice) > Number(product.rrp))),
    stockValue: stockValue(product),
    gaViews: Number(product.gaViews || 0),
    gaAdds: Number(product.gaAdds || 0)
  };
}

function weeklyCandidate(type, product, period, priority, rationale, title) {
  const productKey = String(product.productKey || product.id || product.legacyResourceId || product.sku || product.name || product.title || "");
  const metrics = productMetricSnapshot(product);
  return {
    dedupeKey: `${type}:${productKey || reportHash(product.name || product.title)}`,
    actionType: type,
    title,
    productKey,
    productTitle: product.name || product.title || "",
    sku: product.sku || (product.skus || [])[0] || "",
    season: product.season || "",
    category: product.cat || product.productType || "",
    owner: type === "reorder" ? "Buyer" : "Merchandising",
    assigneeUserId: "",
    status: "Open",
    priority,
    dueDate: addDaysIso("", 7),
    sourcePeriodId: period.id,
    sourceStartDate: period.startDate,
    sourceEndDate: period.endDate,
    sourceLabel: period.label,
    rationale,
    metrics,
    data: {
      sourceUrl: `bestsellers.html?startDate=${encodeURIComponent(period.startDate)}&endDate=${encodeURIComponent(period.endDate)}`,
      imageUrl: product.img || product.imageUrl || "",
      productStatus: product.status || "",
      isMarkedDown: metrics.isMarkedDown,
      price: metrics.price,
      compareAtPrice: metrics.compareAtPrice,
      generatedRule: type
    }
  };
}

function generateWeeklyActionCandidates(payload) {
  const period = payload.period || payload.report?.period;
  const report = payload.report || {};
  const products = (report.products || []).filter(product => product && (product.name || product.title));
  const byRevenue = [...products].sort((a, b) => Number(b.rev || 0) - Number(a.rev || 0));
  const topRevenueSet = new Set(byRevenue.slice(0, Math.max(8, Math.ceil(byRevenue.length * 0.08))).map(product => product.productKey || product.id || product.name));
  const reorderCandidates = [];
  const markdownCandidates = [];
  const featureCandidates = [];
  const watchCandidates = [];

  for (const product of products) {
    const units = Number(product.units || 0);
    const stock = product.stock == null ? null : Number(product.stock || 0);
    const coverWks = product.coverWks == null ? null : Number(product.coverWks || 0);
    const forecastBuy = product.forecastBuy == null ? null : Number(product.forecastBuy || 0);
    if (units >= 2 && (forecastBuy > 0 || (coverWks != null && coverWks <= 4))) {
      const priority = coverWks != null && coverWks <= 2 || forecastBuy >= 20 ? "High" : "Medium";
      reorderCandidates.push(weeklyCandidate(
        "reorder",
        product,
        period,
        priority,
        `Sold ${Math.round(units).toLocaleString("en-GB")} units with ${stock == null ? "unknown" : Math.round(stock).toLocaleString("en-GB")} in stock${coverWks == null ? "" : `, ${coverWks.toFixed(1)} weeks cover`}. Forecast buy is ${Math.round(forecastBuy || 0).toLocaleString("en-GB")}.`,
        `Review reorder for ${product.name || product.title}`
      ));
    }
  }

  const markdownPool = products.filter(product => {
    const units = Number(product.units || 0);
    const stock = Number(product.stock || 0);
    const coverWks = product.coverWks == null ? null : Number(product.coverWks || 0);
    return stock > 0 && (units === 0 || (coverWks != null && coverWks >= 12 && units <= 2));
  }).sort((a, b) => stockValue(b) - stockValue(a));
  const highMarkdownCut = markdownPool.length ? Math.max(stockValue(markdownPool[Math.min(markdownPool.length - 1, 9)]), 1000) : 1000;
  for (const product of markdownPool.slice(0, 40)) {
    const units = Number(product.units || 0);
    const stock = Number(product.stock || 0);
    const value = stockValue(product);
    const coverText = product.coverWks == null ? "" : `, ${Number(product.coverWks || 0).toFixed(1)} weeks cover`;
    const markedDown = Boolean(product.isMarkedDown || (product.compareAtPrice && product.rrp && Number(product.compareAtPrice) > Number(product.rrp)));
    const markdownState = markedDown ? " Already marked down." : " Not currently marked down.";
    markdownCandidates.push(weeklyCandidate(
      "markdown",
      product,
      period,
      value >= highMarkdownCut || stock >= 30 ? "High" : "Medium",
      units === 0
        ? `Has ${Math.round(stock).toLocaleString("en-GB")} units in stock and no sales in the saved report period.${markdownState}`
        : `Weak demand: ${Math.round(units).toLocaleString("en-GB")} units sold with ${Math.round(stock).toLocaleString("en-GB")} units in stock${coverText}.${markdownState}`,
      markedDown ? `Review existing markdown for ${product.name || product.title}` : `Review markdown or launch action for ${product.name || product.title}`
    ));
  }

  for (const product of byRevenue.slice(0, 30)) {
    const units = Number(product.units || 0);
    const stock = Number(product.stock || 0);
    const gpPct = Number(product.gpPct || 0);
    const hasGp = Number(product.gp || 0) !== 0 || product.cost != null;
    const key = product.productKey || product.id || product.name;
    if (!topRevenueSet.has(key) || units < 3 || stock < 5 || (hasGp && gpPct < 45)) continue;
    featureCandidates.push(weeklyCandidate(
      "feature",
      product,
      period,
      stock >= units * 2 ? "High" : "Medium",
      `Top seller with ${Math.round(units).toLocaleString("en-GB")} units sold, ${Math.round(stock).toLocaleString("en-GB")} units in stock${hasGp ? `, and ${Math.round(gpPct)}% GP` : ""}.`,
      `Feature ${product.name || product.title}`
    ));
  }

  const watchProducts = products.filter(product => {
    const units = Number(product.units || 0);
    const stock = Number(product.stock || 0);
    const coverWks = product.coverWks == null ? null : Number(product.coverWks || 0);
    const missingCost = product.cost == null && units >= 2;
    const mediumCover = units >= 2 && coverWks != null && coverWks > 4 && coverWks <= 8;
    const inconsistent = units > 0 && stock <= 0 && Number(product.forecastBuy || 0) <= 0;
    return stock >= 0 && (missingCost || mediumCover || inconsistent);
  }).sort((a, b) => Number(b.rev || 0) - Number(a.rev || 0));
  for (const product of watchProducts.slice(0, 30)) {
    const reasons = [];
    if (product.cost == null && Number(product.units || 0) >= 2) reasons.push("missing cost");
    if (product.coverWks != null && Number(product.coverWks) > 4 && Number(product.coverWks) <= 8) reasons.push(`${Number(product.coverWks).toFixed(1)} weeks cover`);
    if (Number(product.units || 0) > 0 && Number(product.stock || 0) <= 0) reasons.push("sales recorded but no stock showing");
    watchCandidates.push(weeklyCandidate(
      "watch",
      product,
      period,
      "Low",
      `Needs review: ${reasons.join(", ") || "mixed trading signal"}.`,
      `Watch ${product.name || product.title}`
    ));
  }

  const seen = new Set();
  const orderedCandidates = [
    ...reorderCandidates
      .sort((a, b) => (a.priority === "High" ? -1 : 1) - (b.priority === "High" ? -1 : 1) || Number(b.metrics.forecastBuy || 0) - Number(a.metrics.forecastBuy || 0))
      .slice(0, 40),
    ...markdownCandidates
      .sort((a, b) => (a.priority === "High" ? -1 : 1) - (b.priority === "High" ? -1 : 1) || Number(b.metrics.stockValue || 0) - Number(a.metrics.stockValue || 0))
      .slice(0, 35),
    ...featureCandidates
      .sort((a, b) => Number(b.metrics.revenue || 0) - Number(a.metrics.revenue || 0))
      .slice(0, 25),
    ...watchCandidates
      .sort((a, b) => Number(b.metrics.revenue || 0) - Number(a.metrics.revenue || 0))
      .slice(0, 20)
  ];
  return orderedCandidates.filter(candidate => {
    if (seen.has(candidate.dedupeKey)) return false;
    seen.add(candidate.dedupeKey);
    return true;
  });
}

function upsertWeeklyActions(candidates, actorName = "") {
  const db = openOrderSqliteDb();
  let created = 0;
  let updated = 0;
  const unresolved = ["Open", "In progress", "Snoozed", "Blocked"];
  const insert = db.prepare(`
    INSERT INTO weekly_actions (
      id, dedupe_key, action_type, title, product_key, product_title, sku, season, category,
      owner, assignee_user_id, status, priority, due_date, source_type, source_period_id, source_start_date,
      source_end_date, source_label, rationale, metrics_json, data, generated_at, created_at, updated_at
    ) VALUES (
      @id, @dedupeKey, @actionType, @title, @productKey, @productTitle, @sku, @season, @category,
      @owner, @assigneeUserId, @status, @priority, @dueDate, 'bestsellers', @sourcePeriodId, @sourceStartDate,
      @sourceEndDate, @sourceLabel, @rationale, @metricsJson, @data, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    )
  `);
  const update = db.prepare(`
    UPDATE weekly_actions
    SET title = @title,
        product_key = @productKey,
        product_title = @productTitle,
        sku = @sku,
        season = @season,
        category = @category,
        assignee_user_id = @assigneeUserId,
        source_period_id = @sourcePeriodId,
        source_start_date = @sourceStartDate,
        source_end_date = @sourceEndDate,
        source_label = @sourceLabel,
        rationale = @rationale,
        metrics_json = @metricsJson,
        data = @data,
        generated_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = @id
  `);

  const write = db.transaction(() => {
    for (const candidate of candidates) {
      const existing = db.prepare(`
        SELECT *
        FROM weekly_actions
        WHERE dedupe_key = ?
          AND status IN (${unresolved.map(() => "?").join(",")})
        ORDER BY updated_at DESC
        LIMIT 1
      `).get(candidate.dedupeKey, ...unresolved);
      const payload = {
        ...candidate,
        id: existing?.id || crypto.randomUUID(),
        metricsJson: JSON.stringify(candidate.metrics || {}),
        data: JSON.stringify(candidate.data || {})
      };
      if (existing) {
        update.run(payload);
        updated += 1;
      } else {
        insert.run(payload);
        created += 1;
        recordWeeklyActionEvent(payload.id, "generated", actorName, "Action generated from saved bestsellers report", {
          actionType: candidate.actionType,
          sourceLabel: candidate.sourceLabel
        });
      }
    }
  });
  write();
  return { created, updated, total: candidates.length };
}

function previewWeeklyActions(candidates) {
  const db = openOrderSqliteDb();
  const unresolved = ["Open", "In progress", "Snoozed", "Blocked"];
  let created = 0;
  let updated = 0;
  let snoozed = 0;
  let doneMatches = 0;
  const existingStatement = db.prepare(`
    SELECT status
    FROM weekly_actions
    WHERE dedupe_key = ?
    ORDER BY updated_at DESC
  `);
  for (const candidate of candidates) {
    const rows = existingStatement.all(candidate.dedupeKey);
    const unresolvedMatch = rows.find(row => unresolved.includes(row.status));
    if (unresolvedMatch) {
      updated += 1;
      if (unresolvedMatch.status === "Snoozed") snoozed += 1;
    } else {
      created += 1;
      if (rows.some(row => row.status === "Done")) doneMatches += 1;
    }
  }
  return { created, updated, snoozed, recurringDone: doneMatches, total: candidates.length };
}

function weeklyActionsMetrics(actions) {
  const today = todayIsoDate();
  const weekAgo = addDaysIso(today, -7);
  return {
    total: actions.length,
    open: actions.filter(action => action.status !== "Done").length,
    highPriority: actions.filter(action => action.status !== "Done" && action.priority === "High").length,
    dueSoon: actions.filter(action => action.status !== "Done" && action.dueDate && action.dueDate <= addDaysIso(today, 3)).length,
    completedThisWeek: actions.filter(action => action.status === "Done" && action.completedAt && action.completedAt.slice(0, 10) >= weekAgo).length
  };
}

function readWeeklyActions(url) {
  const db = openOrderSqliteDb();
  const params = {
    status: String(url.searchParams.get("status") || "").trim(),
    owner: String(url.searchParams.get("owner") || "").trim(),
    priority: String(url.searchParams.get("priority") || "").trim(),
    type: String(url.searchParams.get("type") || "").trim(),
    season: String(url.searchParams.get("season") || "").trim(),
    search: String(url.searchParams.get("search") || "").trim().toLowerCase()
  };
  const rows = db.prepare(`
    SELECT *
    FROM weekly_actions
    ORDER BY
      CASE status WHEN 'Open' THEN 0 WHEN 'In progress' THEN 1 WHEN 'Blocked' THEN 2 WHEN 'Snoozed' THEN 3 ELSE 4 END,
      CASE priority WHEN 'High' THEN 0 WHEN 'Medium' THEN 1 ELSE 2 END,
      date(COALESCE(NULLIF(due_date, ''), '9999-12-31')) ASC,
      updated_at DESC
  `).all();
  let actions = rows.map(row => weeklyActionFromRow(row));
  actions = actions.filter(action => {
    const haystack = [action.title, action.productTitle, action.sku, action.season, action.category, action.rationale].join(" ").toLowerCase();
    return (!params.status || action.status === params.status)
      && (!params.owner || action.owner === params.owner)
      && (!params.priority || action.priority === params.priority)
      && (!params.type || action.actionType === params.type)
      && (!params.season || action.season === params.season)
      && (!params.search || haystack.includes(params.search));
  });
  const selectedId = String(url.searchParams.get("id") || actions[0]?.id || "");
  const selected = selectedId
    ? weeklyActionFromRow(db.prepare("SELECT * FROM weekly_actions WHERE id = ?").get(selectedId), readWeeklyActionEvents(selectedId))
    : null;
  return {
    actions,
    selected,
    metrics: weeklyActionsMetrics(rows.map(row => weeklyActionFromRow(row))),
    filters: {
      statuses: weeklyActionStatuses,
      owners: weeklyActionOwners,
      priorities: weeklyActionPriorities,
      types: ["reorder", "markdown", "feature", "watch"],
      seasons: [...new Set(rows.map(row => row.season).filter(Boolean))].sort().reverse()
    },
    users: publicAssignableUsers(),
    periods: readBestsellersPeriods().filter(period => period.sourceType === "shopify_api")
  };
}

function handleWeeklyActionsList(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  sendJson(res, 200, { ...readWeeklyActions(url), generatedAt: new Date().toISOString() });
}

async function handleWeeklyActionsGenerate(req, res) {
  const body = await readJsonBody(req);
  const periodRow = weeklyActionsPeriodFromRequest(body);
  const payload = buildBestsellersPayload(periodRow);
  if (!payload?.report) throw new Error("Could not build a bestsellers report for that period.");
  const candidates = generateWeeklyActionCandidates(payload);
  if (body.previewOnly) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    sendJson(res, 200, {
      ok: true,
      preview: true,
      result: previewWeeklyActions(candidates),
      period: publicReportPeriod(periodRow),
      ...readWeeklyActions(url)
    });
    return;
  }
  const result = upsertWeeklyActions(candidates, actorName(req));
  const url = new URL(req.url, `http://${req.headers.host}`);
  sendJson(res, 200, {
    ok: true,
    result,
    period: publicReportPeriod(periodRow),
    ...readWeeklyActions(url)
  });
}

async function handleWeeklyActionsUpdate(req, res) {
  const body = await readJsonBody(req);
  const actionId = String(body.actionId || "").trim();
  if (!actionId) throw new Error("Missing action id.");
  const db = openOrderSqliteDb();
  const row = db.prepare("SELECT * FROM weekly_actions WHERE id = ?").get(actionId);
  if (!row) throw new Error("Action not found.");
  const patch = body.patch || {};
  const current = weeklyActionFromRow(row);
  const next = {
    status: Object.prototype.hasOwnProperty.call(patch, "status") ? normalizeWeeklyActionStatus(patch.status) : current.status,
    owner: Object.prototype.hasOwnProperty.call(patch, "owner") ? normalizeWeeklyActionOwner(patch.owner, current.owner) : current.owner,
    assigneeUserId: Object.prototype.hasOwnProperty.call(patch, "assigneeUserId") ? normalizeAssignableUserId(patch.assigneeUserId) : current.assigneeUserId,
    priority: Object.prototype.hasOwnProperty.call(patch, "priority") ? normalizeWeeklyActionPriority(patch.priority, current.priority) : current.priority,
    dueDate: Object.prototype.hasOwnProperty.call(patch, "dueDate") ? String(patch.dueDate || "").trim() : current.dueDate
  };
  const completedAt = next.status === "Done" && current.status !== "Done"
    ? new Date().toISOString()
    : next.status !== "Done" ? "" : current.completedAt;
  db.prepare(`
    UPDATE weekly_actions
    SET status = @status,
        owner = @owner,
        assignee_user_id = @assigneeUserId,
        priority = @priority,
        due_date = @dueDate,
        completed_at = @completedAt,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = @id
  `).run({ id: actionId, ...next, completedAt });

  const changes = {};
  for (const key of ["status", "owner", "assigneeUserId", "priority", "dueDate"]) {
    if (next[key] !== current[key]) changes[key] = { from: current[key], to: next[key] };
  }
  if (Object.keys(changes).length) {
    recordWeeklyActionEvent(actionId, "update", actorName(req), "Action updated", { ...changes, ...actorData(req) });
  }
  const note = String(body.note || "").trim();
  if (note) {
    recordWeeklyActionEvent(actionId, "note", actorName(req), note, actorData(req));
    await notifyMentionedUsers(req, note, {
      entityType: "weekly_action",
      entityId: actionId,
      title: "You were mentioned on a weekly action",
      url: `/weekly-actions.html?id=${encodeURIComponent(actionId)}`
    });
  }
  if (changes.status && next.assigneeUserId && (next.status === "Blocked" || current.status === "Blocked")) {
    await notifyUser(next.assigneeUserId, {
      entityType: "weekly_action",
      entityId: actionId,
      title: `Weekly action ${next.status === "Blocked" ? "blocked" : "unblocked"}`,
      body: `${actorName(req)} changed ${current.title || "a weekly action"} from ${current.status} to ${next.status}.`,
      url: `/weekly-actions.html?id=${encodeURIComponent(actionId)}`
    });
  }
  if (changes.owner || changes.assigneeUserId) {
    const assignedUser = userById(next.assigneeUserId);
    const message = assignedUser
      ? `Handoff to ${assignedUser.displayName} (${next.owner || "No role"})`
      : `Handoff to ${next.owner || "No owner"}`;
    recordWeeklyActionEvent(actionId, "handoff", actorName(req), message, {
      fromRole: current.owner || "",
      toRole: next.owner || "",
      fromUserId: current.assigneeUserId || "",
      toUserId: next.assigneeUserId || "",
      ...actorData(req)
    });
    await recordWorkHandoff(req, {
      entityType: "weekly_action",
      entityId: actionId,
      fromRole: current.owner || "",
      toRole: next.owner || "",
      fromUserId: current.assigneeUserId || "",
      toUserId: next.assigneeUserId || "",
      title: `Weekly action handed off`,
      message: `${actorName(req)} assigned ${current.title || "a weekly action"}.`,
      url: `/weekly-actions.html?id=${encodeURIComponent(actionId)}`
    });
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  url.searchParams.set("id", actionId);
  sendJson(res, 200, { ok: true, ...readWeeklyActions(url) });
}

function friendlyShopifyLookupMessage(error) {
  const message = String(error?.message || error || "");
  if (/EACCES|EPERM|ENETUNREACH|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND/i.test(message)) {
    return "Shopify lookup is unavailable from this local session. Saved SKU data will still be used if it exists, or you can enter the product details manually.";
  }
  return message || "Shopify lookup is unavailable. Saved SKU data will still be used if it exists.";
}

function existingByNormalized(items, key, value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return null;
  return items.find(item => String(item[key] || "").trim().toLowerCase() === normalized) || null;
}

function mergeNonEmpty(existing = {}, patch = {}, always = {}) {
  const merged = { ...(existing || {}) };
  for (const [key, value] of Object.entries(patch || {})) {
    if (value == null) continue;
    if (typeof value === "string" && !value.trim()) continue;
    if (Array.isArray(value) && !value.length) continue;
    merged[key] = value;
  }
  return { ...merged, ...(always || {}) };
}

function archiveRemovedOrderLineProducts(sqlite, previousOrder, storedOrder) {
  if (!previousOrder?.lines?.length || !storedOrder?.orderNumber) return [];
  const currentSkus = orderLineSkuSet(storedOrder);
  const removedSkus = [...orderLineSkuSet(previousOrder)].filter(sku => !currentSkus.has(sku));
  if (!removedSkus.length) return [];

  const orders = sqlite.prepare("SELECT data FROM orders").all()
    .map(row => parseJson(row.data, null))
    .filter(Boolean);
  const archiveProduct = sqlite.prepare(`
    UPDATE products
    SET product_status = 'Archived',
        data = @data,
        updated_at = CURRENT_TIMESTAMP
    WHERE sku = @sku
  `);
  const archived = [];
  for (const sku of removedSkus) {
    if (orders.some(order => orderContainsSku(order, sku))) continue;
    const row = sqlite.prepare("SELECT * FROM products WHERE sku = ?").get(sku);
    const product = productFromRow(row);
    if (!product || productHasShopifyIdentity(product)) continue;
    const productOrderNumber = String(product.lastOrderNumber || "").trim();
    if (productOrderNumber && productOrderNumber !== String(storedOrder.orderNumber || "").trim()) continue;
    if (String(product.status || "").trim().toLowerCase() === "archived") continue;

    const updated = {
      ...product,
      status: "Archived",
      source: product.source || "order",
      archivedReason: "Removed from latest saved order version"
    };
    archiveProduct.run({ sku, data: JSON.stringify(updated) });
    archived.push(sku);
  }
  return archived;
}

function migrateOrderRelations(sqlite, fromId, toId) {
  const from = String(fromId || "");
  const to = String(toId || "");
  if (!from || !to || from === to) return;
  const hasSourceWorkflow = sqlite.prepare("SELECT COUNT(*) AS count FROM order_workflows WHERE order_id = ?").get(from).count > 0;
  if (hasSourceWorkflow) sqlite.prepare("DELETE FROM order_workflows WHERE order_id = ?").run(to);
  sqlite.prepare("UPDATE order_workflows SET order_id = ? WHERE order_id = ?").run(to, from);
  sqlite.prepare("UPDATE order_events SET order_id = ? WHERE order_id = ?").run(to, from);
  sqlite.prepare("UPDATE order_invoices SET order_id = ? WHERE order_id = ?").run(to, from);
  sqlite.prepare("UPDATE order_batches SET order_id = ? WHERE order_id = ?").run(to, from);
  sqlite.prepare("UPDATE order_batch_lines SET order_id = ? WHERE order_id = ?").run(to, from);
  sqlite.prepare("UPDATE work_handoffs SET entity_id = ? WHERE entity_type = 'order' AND entity_id = ?").run(to, from);
  sqlite.prepare("UPDATE notifications SET entity_id = ? WHERE entity_type = 'order' AND entity_id = ?").run(to, from);
}

function saveOrderFormOrder(dbData, savedOrder) {
  const sqlite = openOrderSqliteDb();
  const storedOrder = materializeOrderImages(savedOrder);
  const existingOrder = sqlite.prepare("SELECT id, data FROM orders WHERE order_number = ?").get(String(storedOrder.orderNumber || ""));
  const previousOrder = parseJson(existingOrder?.data, null);
  const incomingOrderId = String(storedOrder.id);
  const canonicalOrderId = String(existingOrder?.id || incomingOrderId);
  storedOrder.id = canonicalOrderId;
  const supplierPatch = storedOrder.supplier?.name ? mergeNonEmpty(
    existingByNormalized(dbData.suppliers || [], "name", storedOrder.supplier.name) || {},
    storedOrder.supplier,
    {
      name: storedOrder.supplier.name,
      lastOrderNumber: storedOrder.orderNumber,
      lastOrderedAt: storedOrder.savedAt
    }
  ) : null;
  const productPatches = (storedOrder.lines || [])
    .filter(line => line.sku)
    .map(line => mergeNonEmpty(
      existingByNormalized(dbData.products || [], "sku", line.sku) || {},
      {
        ...line,
        supplierName: storedOrder.supplier?.name || line.supplierName || ""
      },
      {
        sku: normalizeSku(line.sku),
        lastOrderNumber: storedOrder.orderNumber,
        lastOrderedAt: storedOrder.savedAt
      }
    ));

  const write = sqlite.transaction(() => {
    migrateOrderRelations(sqlite, incomingOrderId, canonicalOrderId);
    sqlite.prepare("DELETE FROM orders WHERE id = ? OR order_number = ?").run(canonicalOrderId, storedOrder.orderNumber);
    sqlite.prepare(`
      INSERT INTO orders (id, order_number, supplier_name, order_date, status, saved_at, data, archived_at, updated_at)
      VALUES (@id, @orderNumber, @supplierName, @orderDate, @status, @savedAt, @data, @archivedAt, CURRENT_TIMESTAMP)
    `).run({
      id: String(storedOrder.id),
      orderNumber: storedOrder.orderNumber,
      supplierName: storedOrder.supplier?.name || "",
      orderDate: storedOrder.orderDate || "",
      status: storedOrder.status || "",
      savedAt: storedOrder.savedAt,
      data: JSON.stringify(storedOrder),
      archivedAt: storedOrder.archivedAt || ""
    });

    if (supplierPatch?.name) {
      sqlite.prepare(`
        INSERT INTO suppliers (name, reference, status, country, lead_time_days, moq, currency, incoterms, last_order_number, last_ordered_at, data, updated_at)
        VALUES (@name, @reference, @status, @country, @leadTimeDays, @moq, @currency, @incoterms, @lastOrderNumber, @lastOrderedAt, @data, CURRENT_TIMESTAMP)
        ON CONFLICT(name) DO UPDATE SET
          reference = excluded.reference,
          status = COALESCE(NULLIF(suppliers.status, ''), excluded.status),
          country = COALESCE(NULLIF(suppliers.country, ''), excluded.country),
          lead_time_days = COALESCE(NULLIF(suppliers.lead_time_days, 0), excluded.lead_time_days),
          moq = COALESCE(NULLIF(suppliers.moq, 0), excluded.moq),
          currency = COALESCE(NULLIF(suppliers.currency, ''), excluded.currency),
          incoterms = COALESCE(NULLIF(suppliers.incoterms, ''), excluded.incoterms),
          last_order_number = excluded.last_order_number,
          last_ordered_at = excluded.last_ordered_at,
          data = excluded.data,
          updated_at = CURRENT_TIMESTAMP
      `).run({
        name: supplierPatch.name,
        reference: supplierPatch.reference || "",
        status: supplierPatch.status || "Active",
        country: supplierPatch.country || supplierPatch.bankCountry || "",
        leadTimeDays: Number(supplierPatch.leadTimeDays || 0),
        moq: Number(supplierPatch.moq || 0),
        currency: supplierPatch.currency || storedOrder.terms?.currency || "",
        incoterms: supplierPatch.incoterms || storedOrder.terms?.incoterms || "",
        lastOrderNumber: supplierPatch.lastOrderNumber || "",
        lastOrderedAt: supplierPatch.lastOrderedAt || "",
        data: JSON.stringify(supplierPatch)
      });
    }

    const upsertProduct = sqlite.prepare(`
      INSERT INTO products (
        sku, style, supplier_name, supplier_sku, product_type, season, colour, size,
        unit_cost_gbp, rrp, compare_at_price, barcode, product_status, shopify_product_gid,
        shopify_variant_gid, shopify_status, sync_status, last_synced_at, last_order_number,
        last_ordered_at, data, updated_at
      )
      VALUES (
        @sku, @style, @supplierName, @supplierSku, @productType, @season, @colour, @size,
        @unitCostGbp, @rrp, @compareAtPrice, @barcode, @productStatus, @shopifyProductGid,
        @shopifyVariantGid, @shopifyStatus, @syncStatus, @lastSyncedAt, @lastOrderNumber,
        @lastOrderedAt, @data, CURRENT_TIMESTAMP
      )
      ON CONFLICT(sku) DO UPDATE SET
        style = excluded.style,
        supplier_name = excluded.supplier_name,
        supplier_sku = COALESCE(NULLIF(products.supplier_sku, ''), excluded.supplier_sku),
        product_type = COALESCE(NULLIF(products.product_type, ''), excluded.product_type),
        season = COALESCE(NULLIF(products.season, ''), excluded.season),
        colour = COALESCE(NULLIF(products.colour, ''), excluded.colour),
        size = COALESCE(NULLIF(products.size, ''), excluded.size),
        unit_cost_gbp = COALESCE(NULLIF(products.unit_cost_gbp, 0), excluded.unit_cost_gbp),
        rrp = COALESCE(NULLIF(products.rrp, 0), excluded.rrp),
        compare_at_price = COALESCE(NULLIF(products.compare_at_price, 0), excluded.compare_at_price),
        barcode = COALESCE(NULLIF(products.barcode, ''), excluded.barcode),
        product_status = COALESCE(NULLIF(products.product_status, ''), excluded.product_status),
        shopify_product_gid = COALESCE(NULLIF(products.shopify_product_gid, ''), excluded.shopify_product_gid),
        shopify_variant_gid = COALESCE(NULLIF(products.shopify_variant_gid, ''), excluded.shopify_variant_gid),
        shopify_status = COALESCE(NULLIF(products.shopify_status, ''), excluded.shopify_status),
        sync_status = COALESCE(NULLIF(products.sync_status, ''), excluded.sync_status),
        last_synced_at = COALESCE(NULLIF(products.last_synced_at, ''), excluded.last_synced_at),
        last_order_number = excluded.last_order_number,
        last_ordered_at = excluded.last_ordered_at,
        data = excluded.data,
        updated_at = CURRENT_TIMESTAMP
    `);
    for (const product of productPatches) {
      const normalized = normalizeProductInput(product, existingByNormalized(dbData.products || [], "sku", product.sku) || {});
      upsertProduct.run({
        ...indexedProductParams(normalized),
        productStatus: normalized.status || "Draft"
      });
    }
    archiveRemovedOrderLineProducts(sqlite, previousOrder, storedOrder);
  });
  write();
  return storedOrder;
}

async function shopifyLookupBySku(sku) {
  const { shop, clientId, clientSecret } = shopifyConfig();
  if (!shop || !clientId || !clientSecret) return { configured: false, product: null };

  const data = await shopifyGraphql(`query ProductBySku($query: String!) {
    productVariants(first: 1, query: $query) {
      edges {
        node {
          id
          sku
          title
          price
          inventoryQuantity
          image { url }
          product {
            id
            title
            status
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
  const shopifyStatus = node.product?.status || "";

  return {
    configured: true,
    product: {
      sku: node.sku || sku,
      style: node.product?.title || "",
      variant: node.title || "",
      category: node.product?.productType || "",
      productType: node.product?.productType || "",
      supplierName: node.product?.vendor || "",
      rrp: node.price || "",
      season: node.product?.metafield?.value || "",
      imageUrl: node.image?.url || node.product?.featuredImage?.url || "",
      inventoryQuantity: node.inventoryQuantity ?? null,
      shopifyProductGid: node.product?.id || "",
      shopifyVariantGid: node.id || "",
      shopifyStatus,
      status: localProductStatusFromShopifyStatus(shopifyStatus),
      syncStatus: "Synced draft",
      lastSyncedAt: new Date().toISOString(),
      source: "shopify"
    }
  };
}

async function shopifyVariantBySku(sku) {
  const normalized = normalizeSku(sku);
  if (!normalized) return null;
  const data = await shopifyGraphql(`query ProductVariantBySku($query: String!) {
    productVariants(first: 1, query: $query) {
      edges {
        node {
          id
          sku
          product {
            id
            title
            status
            handle
          }
        }
      }
    }
  }`, { query: `sku:${normalized}` });
  return data?.productVariants?.edges?.[0]?.node || null;
}

function shopifyPushError(message, code = "shopify_push_error", details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}

const productStatuses = new Set(["Draft", "Ready for Shopify", "Shopify draft", "Live", "Archived"]);
const productSyncStatuses = new Set(["Not synced", "Ready", "Synced draft", "Conflict", "Error"]);

function localProductStatusFromShopifyStatus(status) {
  const normalized = cleanText(status).toUpperCase();
  if (normalized === "ACTIVE") return "Live";
  if (normalized === "DRAFT") return "Shopify draft";
  if (normalized === "ARCHIVED") return "Archived";
  return "Shopify draft";
}

function syncedProductStateFromShopifyStatus(status) {
  const normalized = cleanText(status).toUpperCase();
  return {
    shopifyStatus: normalized || cleanText(status),
    status: localProductStatusFromShopifyStatus(normalized),
    syncStatus: ["ACTIVE", "DRAFT", "ARCHIVED"].includes(normalized) ? "Synced draft" : "Conflict"
  };
}

function cleanText(value) {
  return String(value == null ? "" : value).trim();
}

function numberOrZero(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function csvList(value) {
  if (Array.isArray(value)) return value.map(cleanText).filter(Boolean);
  return String(value || "").split(",").map(cleanText).filter(Boolean);
}

function cleanShopifyExportValue(value) {
  return cleanText(value).replace(/^'/, "");
}

function firstNonEmpty(source, keys) {
  for (const key of keys) {
    const value = cleanShopifyExportValue(source?.[key]);
    if (value !== "") return value;
  }
  return "";
}

function buyingCodeFromTags(tags) {
  const match = String(tags || "").match(/Buying Code\s*:\s*([^,]+)/i);
  return match ? cleanText(match[1]) : "";
}

function normalizedMetafieldInput(field) {
  if (!field) return null;
  const namespace = cleanText(field.namespace).replace(/[^a-zA-Z0-9_-]/g, "_");
  const key = cleanText(field.key).replace(/[^a-zA-Z0-9_-]/g, "_");
  const value = cleanText(field.value);
  if (!namespace || !key) return null;
  const metafield = { namespace, key, value };
  if (field.type) metafield.type = cleanText(field.type);
  return metafield;
}

function metafieldsFromShopifyExportRow(row = {}) {
  const metafields = [];
  for (const [header, value] of Object.entries(row || {})) {
    const cleanValue = cleanShopifyExportValue(value);
    const match = String(header || "").match(/\(product\.metafields\.([^.()]+)\.([^)]+)\)$/);
    if (!match) continue;
    const namespace = match[1];
    const key = match[2];
    metafields.push({ namespace, key, value: cleanValue });
  }
  return metafields;
}

function mergeMetafields(...groups) {
  const byKey = new Map();
  for (const group of groups) {
    for (const field of group || []) {
      const normalized = normalizedMetafieldInput(field);
      if (!normalized) continue;
      byKey.set(`${normalized.namespace}.${normalized.key}`, normalized);
    }
  }
  return [...byKey.values()];
}

function publicShopifyAdminUrl(productOrVariantGid = "") {
  const { domain } = shopifyConfig();
  const id = String(productOrVariantGid || "").match(/\/(\d+)$/)?.[1] || "";
  return domain && id ? `https://${domain}/admin/products/${id}` : "";
}

function productImageUploadPath(imageUrl = "") {
  const raw = String(imageUrl || "");
  const match = raw.match(/^\/uploads\/(.+)$/);
  if (!match) return "";
  return decodeURIComponent(match[1]);
}

function materializeProductImage(product) {
  if (!isDataUrl(product.imageUrl)) return product;
  const stored = writeProductImageUpload(product);
  return stored ? { ...product, imageUrl: stored.imageUrl } : product;
}

function supplierFromRow(row) {
  if (!row) return null;
  const data = parseJson(row.data, {});
  return {
    id: row.id,
    name: data.name || row.name || "",
    reference: data.reference || row.reference || "",
    status: data.status || row.status || "Active",
    contact: data.contact || "",
    email: data.email || "",
    phone: data.phone || "",
    city: data.city || "",
    country: data.country || row.country || "",
    website: data.website || "",
    paymentType: data.paymentType || "",
    bankAccountName: data.bankAccountName || "",
    bankName: data.bankName || "",
    bankCountry: data.bankCountry || "",
    iban: data.iban || "",
    swift: data.swift || "",
    sortCode: data.sortCode || "",
    accountNumber: data.accountNumber || "",
    paymentNotes: data.paymentNotes || "",
    leadTimeDays: numberOrZero(data.leadTimeDays ?? row.lead_time_days),
    moq: numberOrZero(data.moq ?? row.moq),
    currency: data.currency || row.currency || "",
    incoterms: data.incoterms || row.incoterms || "",
    complianceNotes: data.complianceNotes || "",
    notes: data.notes || "",
    lastOrderNumber: data.lastOrderNumber || row.last_order_number || "",
    lastOrderedAt: data.lastOrderedAt || row.last_ordered_at || "",
    updatedAt: row.updated_at || "",
    data
  };
}

function productFromRow(row) {
  if (!row) return null;
  const data = parseJson(row.data, {});
  const product = {
    id: row.id,
    sku: data.sku || row.sku || "",
    style: data.style || data.title || data.description || row.style || "",
    title: data.title || data.style || data.description || row.style || "",
    supplierName: data.supplierName || row.supplier_name || "",
    buyingCode: data.buyingCode || data.supplierSku || row.supplier_sku || "",
    supplierSku: data.supplierSku || data.buyingCode || row.supplier_sku || "",
    category: data.category || "",
    department: data.department || data.category || "",
    productCategory: data.productCategory || "",
    productType: data.productType || data.category || row.product_type || "",
    season: data.season || row.season || "",
    colour: data.colour || data.color || row.colour || "",
    color: data.color || data.colour || row.colour || "",
    size: data.size || row.size || "",
    optionName: data.optionName || "Size",
    optionValue: data.optionValue || data.size || "One Size Fits UK 8 to 18",
    unitCostGbp: numberOrZero(data.unitCostGbp ?? data.unitCost ?? row.unit_cost_gbp),
    unitCostEur: numberOrZero(data.unitCostEur),
    rrp: numberOrZero(data.rrp ?? row.rrp),
    compareAtPrice: numberOrZero(data.compareAtPrice ?? row.compare_at_price),
    barcode: data.barcode || row.barcode || "",
    tags: csvList(data.tags),
    collections: csvList(data.collections),
    description: data.description || "",
    imageUrl: data.imageUrl || "",
    imageFileName: data.imageFileName || "",
    imageMimeType: data.imageMimeType || "",
    status: data.status || row.product_status || "Draft",
    shopifyProductGid: data.shopifyProductGid || row.shopify_product_gid || "",
    shopifyVariantGid: data.shopifyVariantGid || row.shopify_variant_gid || "",
    shopifyStatus: data.shopifyStatus || row.shopify_status || "",
    syncStatus: data.syncStatus || row.sync_status || "Not synced",
    lastSyncedAt: data.lastSyncedAt || row.last_synced_at || "",
    productStatusCode: data.productStatusCode || "N",
    detailsAndFit: data.detailsAndFit || "",
    fabricCare: data.fabricCare || "",
    googleProductCategory: data.googleProductCategory || "",
    seoTitle: data.seoTitle || "",
    seoDescription: data.seoDescription || "",
    extraMetafields: Array.isArray(data.extraMetafields) ? data.extraMetafields : [],
    notes: data.notes || "",
    source: data.source || "saved",
    lastOrderNumber: data.lastOrderNumber || row.last_order_number || "",
    lastOrderedAt: data.lastOrderedAt || row.last_ordered_at || "",
    updatedAt: row.updated_at || "",
    data
  };
  if (!productStatuses.has(product.status)) product.status = "Draft";
  if (!productSyncStatuses.has(product.syncStatus)) product.syncStatus = product.status === "Ready for Shopify" ? "Ready" : "Not synced";
  return product;
}

function indexedProductParams(product) {
  return {
    sku: normalizeSku(product.sku),
    style: product.style || product.title || "",
    supplierName: product.supplierName || "",
    supplierSku: product.supplierSku || product.buyingCode || "",
    productType: product.productType || product.category || "",
    season: product.season || "",
    colour: product.colour || product.color || "",
    size: product.size || "",
    unitCostGbp: numberOrZero(product.unitCostGbp),
    rrp: numberOrZero(product.rrp),
    compareAtPrice: numberOrZero(product.compareAtPrice),
    barcode: product.barcode || "",
    productStatus: product.status || "Draft",
    shopifyProductGid: product.shopifyProductGid || "",
    shopifyVariantGid: product.shopifyVariantGid || "",
    shopifyStatus: product.shopifyStatus || "",
    syncStatus: product.syncStatus || "Not synced",
    lastSyncedAt: product.lastSyncedAt || "",
    lastOrderNumber: product.lastOrderNumber || "",
    lastOrderedAt: product.lastOrderedAt || "",
    data: JSON.stringify(product)
  };
}

function productReadiness(product, options = {}) {
  const dbData = options.dbData || readOrderDb();
  const sku = normalizeSku(product.sku);
  const blocking = [];
  const warnings = [];
  if (!sku) blocking.push("Missing SKU");
  if (!cleanText(product.supplierName)) blocking.push("Missing supplier");
  if (!cleanText(product.title || product.style)) blocking.push("Missing title/style");
  if (!numberOrZero(product.rrp)) blocking.push("Missing RRP");
  if (!cleanText(product.productType || product.category)) blocking.push("Missing product type");
  if (!cleanText(product.imageUrl)) blocking.push("Missing image");
  if (!numberOrZero(product.unitCostGbp)) blocking.push("Missing GBP cost");

  if (sku) {
    const sameSkuProducts = openOrderSqliteDb().prepare("SELECT id FROM products WHERE sku = ? AND id != ?").all(sku, Number(product.id || 0));
    if (sameSkuProducts.length) blocking.push("Duplicate local product SKU");
    const orderRefs = (dbData.orders || []).filter(order => (order.lines || []).some(line => normalizeSku(line.sku) === sku && String(order.orderNumber || "") !== String(product.lastOrderNumber || "")));
    if (orderRefs.length && !sameSkuProducts.length) warnings.push(`SKU appears on ${orderRefs.length} saved order${orderRefs.length === 1 ? "" : "s"}`);
  }

  return {
    ready: blocking.length === 0,
    blocking,
    warnings
  };
}

function readCatalogProducts({ includeArchived = false } = {}) {
  const sqlite = openOrderSqliteDb();
  const rows = sqlite.prepare("SELECT * FROM products ORDER BY updated_at DESC").all();
  const dbData = readOrderDb();
  return rows
    .map(row => {
      const product = productFromRow(row);
      const readiness = productReadiness(product, { dbData });
      return {
        ...product,
        readiness,
        shopifyAdminUrl: publicShopifyAdminUrl(product.shopifyProductGid)
      };
    })
    .filter(product => includeArchived || product.status !== "Archived");
}

function findCatalogProduct(identifier) {
  const id = cleanText(identifier);
  if (!id) return null;
  const sqlite = openOrderSqliteDb();
  const row = /^\d+$/.test(id)
    ? sqlite.prepare("SELECT * FROM products WHERE id = ?").get(Number(id)) || sqlite.prepare("SELECT * FROM products WHERE sku = ?").get(normalizeSku(id))
    : sqlite.prepare("SELECT * FROM products WHERE sku = ?").get(normalizeSku(id));
  return productFromRow(row);
}

function syncStatusForProduct(product) {
  if (product.syncStatus === "Error" || product.syncStatus === "Conflict") return product.syncStatus;
  if (product.shopifyProductGid) return "Synced draft";
  if (product.status === "Ready for Shopify") return "Ready";
  return product.syncStatus || "Not synced";
}

function normalizeProductInput(input = {}, existing = {}) {
  const merged = { ...(existing || {}), ...(input || {}) };
  const sku = normalizeSku(merged.sku || firstNonEmpty(merged, ["Variant SKU"]) || existing.sku);
  if (!sku) throw new Error("Product SKU is required.");
  let status = productStatuses.has(merged.status) ? merged.status : existing.status || "Draft";
  const linkedShopifyProductGid = cleanText(merged.shopifyProductGid || existing.shopifyProductGid);
  if (linkedShopifyProductGid && !productStatuses.has(merged.status)) {
    status = localProductStatusFromShopifyStatus(merged.shopifyStatus || existing.shopifyStatus);
  }
  if (linkedShopifyProductGid && status === "Ready for Shopify") {
    status = existing.status === "Live" ? "Live" : localProductStatusFromShopifyStatus(merged.shopifyStatus || existing.shopifyStatus);
  }
  const rawTags = merged.tags || firstNonEmpty(merged, ["Tags"]);
  const rawColour = merged.colour || merged.color || firstNonEmpty(merged, [
    "Variant Colour (product.metafields.custom.variant_colour)",
    "Product Group Swatch (product.metafields.custom.product_group_swatch)"
  ]);
  const rawDepartment = merged.department || merged.category || firstNonEmpty(merged, ["Department (product.metafields.custom.department)"]);
  const product = materializeProductImage({
    ...merged,
    id: existing.id || merged.id || "",
    sku,
    title: cleanText(merged.title || merged.style || firstNonEmpty(merged, ["Title"]) || merged.description),
    style: cleanText(merged.style || merged.title || firstNonEmpty(merged, ["Title"]) || merged.description),
    supplierName: cleanText(merged.supplierName || firstNonEmpty(merged, ["Vendor"])),
    supplierSku: cleanText(merged.supplierSku || merged.buyingCode || buyingCodeFromTags(rawTags)),
    buyingCode: cleanText(merged.buyingCode || merged.supplierSku || buyingCodeFromTags(rawTags)),
    productType: cleanText(merged.productType || firstNonEmpty(merged, ["Type"]) || merged.category),
    category: cleanText(merged.category),
    department: cleanText(rawDepartment),
    productCategory: firstNonEmpty(merged, ["Product Category"]) || merged.productCategory || "",
    season: cleanText(merged.season || firstNonEmpty(merged, ["Season (product.metafields.custom.season)"])),
    colour: cleanText(rawColour),
    color: cleanText(rawColour),
    size: cleanText(merged.size || firstNonEmpty(merged, ["Option1 Value"])),
    optionName: "Size",
    optionValue: cleanText(merged.optionValue || merged.size || firstNonEmpty(merged, ["Option1 Value"]) || "One Size Fits UK 8 to 18"),
    unitCostGbp: numberOrZero(merged.unitCostGbp ?? merged.unitCost ?? firstNonEmpty(merged, ["Cost per item"])),
    unitCostEur: numberOrZero(merged.unitCostEur),
    rrp: numberOrZero(merged.rrp ?? firstNonEmpty(merged, ["Variant Price"])),
    compareAtPrice: numberOrZero(merged.compareAtPrice ?? firstNonEmpty(merged, ["Variant Compare At Price"])),
    barcode: cleanShopifyExportValue(merged.barcode || firstNonEmpty(merged, ["Variant Barcode"])),
    tags: csvList(rawTags),
    collections: csvList(merged.collections),
    description: cleanText(merged.description || firstNonEmpty(merged, ["Body (HTML)"])),
    imageUrl: cleanText(merged.imageUrl || firstNonEmpty(merged, ["Image Src"])),
    imageFileName: cleanText(merged.imageFileName),
    imageMimeType: cleanText(merged.imageMimeType),
    status,
    shopifyProductGid: linkedShopifyProductGid,
    shopifyVariantGid: cleanText(merged.shopifyVariantGid || existing.shopifyVariantGid),
    shopifyStatus: cleanText(merged.shopifyStatus || existing.shopifyStatus),
    syncStatus: productSyncStatuses.has(merged.syncStatus) ? merged.syncStatus : status === "Ready for Shopify" ? "Ready" : existing.syncStatus || "Not synced",
    lastSyncedAt: cleanText(merged.lastSyncedAt),
    productStatusCode: cleanText(merged.productStatusCode || firstNonEmpty(merged, ["Product Status (product.metafields.custom.product_status)"]) || "N"),
    detailsAndFit: cleanText(merged.detailsAndFit || firstNonEmpty(merged, ["Details and Fit (product.metafields.custom.details_and_fit)"])),
    fabricCare: cleanText(merged.fabricCare || firstNonEmpty(merged, ["Fabric & Care (product.metafields.custom.fabric_care)"])),
    googleProductCategory: cleanShopifyExportValue(merged.googleProductCategory || merged["Google Shopping / Google Product Category"]),
    seoTitle: cleanText(merged.seoTitle || merged["SEO Title"]),
    seoDescription: cleanText(merged.seoDescription || merged["SEO Description"]),
    extraMetafields: mergeMetafields(merged.extraMetafields || [], metafieldsFromShopifyExportRow(merged)),
    notes: cleanText(merged.notes),
    source: cleanText(merged.source || existing.source || "saved"),
    lastOrderNumber: cleanText(merged.lastOrderNumber),
    lastOrderedAt: cleanText(merged.lastOrderedAt)
  });
  product.syncStatus = syncStatusForProduct(product);
  return product;
}

function upsertCatalogProduct(input, req = null) {
  const sqlite = openOrderSqliteDb();
  const existing = input.id ? findCatalogProduct(input.id) : findCatalogProduct(input.sku);
  const product = normalizeProductInput(input, existing || {});
  const duplicate = sqlite.prepare("SELECT id FROM products WHERE sku = ? AND id != ?").get(product.sku, Number(existing?.id || product.id || 0));
  if (duplicate) throw new Error(`SKU ${product.sku} already exists on another product.`);
  const params = indexedProductParams(product);
  if (existing?.id) {
    sqlite.prepare(`
      UPDATE products
      SET sku = @sku,
          style = @style,
          supplier_name = @supplierName,
          supplier_sku = @supplierSku,
          product_type = @productType,
          season = @season,
          colour = @colour,
          size = @size,
          unit_cost_gbp = @unitCostGbp,
          rrp = @rrp,
          compare_at_price = @compareAtPrice,
          barcode = @barcode,
          product_status = @productStatus,
          shopify_product_gid = @shopifyProductGid,
          shopify_variant_gid = @shopifyVariantGid,
          shopify_status = @shopifyStatus,
          sync_status = @syncStatus,
          last_synced_at = @lastSyncedAt,
          last_order_number = @lastOrderNumber,
          last_ordered_at = @lastOrderedAt,
          data = @data,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = @id
    `).run({ ...params, id: existing.id });
    return findCatalogProduct(existing.id);
  }
  sqlite.prepare(`
    INSERT INTO products (
      sku, style, supplier_name, supplier_sku, product_type, season, colour, size,
      unit_cost_gbp, rrp, compare_at_price, barcode, product_status,
      shopify_product_gid, shopify_variant_gid, shopify_status, sync_status, last_synced_at,
      last_order_number, last_ordered_at, data, updated_at
    )
    VALUES (
      @sku, @style, @supplierName, @supplierSku, @productType, @season, @colour, @size,
      @unitCostGbp, @rrp, @compareAtPrice, @barcode, @productStatus,
      @shopifyProductGid, @shopifyVariantGid, @shopifyStatus, @syncStatus, @lastSyncedAt,
      @lastOrderNumber, @lastOrderedAt, @data, CURRENT_TIMESTAMP
    )
  `).run(params);
  const created = findCatalogProduct(product.sku);
  if (req) recordProductSyncEvent(created, "local_save", req, { result: "ok", payload: { sku: created.sku, status: created.status } });
  return created;
}

function normalizeSupplierInput(input = {}, existing = {}) {
  const supplier = { ...(existing || {}), ...(input || {}) };
  supplier.name = cleanText(supplier.name);
  if (!supplier.name) throw new Error("Supplier name is required.");
  supplier.reference = cleanText(supplier.reference);
  supplier.status = supplier.status === "Inactive" ? "Inactive" : supplier.status === "Watch" ? "Watch" : "Active";
  supplier.country = cleanText(supplier.country);
  supplier.leadTimeDays = numberOrZero(supplier.leadTimeDays);
  supplier.moq = numberOrZero(supplier.moq);
  supplier.currency = cleanText(supplier.currency);
  supplier.incoterms = cleanText(supplier.incoterms);
  return supplier;
}

function upsertCatalogSupplier(input) {
  const sqlite = openOrderSqliteDb();
  const current = input.id
    ? supplierFromRow(sqlite.prepare("SELECT * FROM suppliers WHERE id = ?").get(Number(input.id)))
    : supplierFromRow(sqlite.prepare("SELECT * FROM suppliers WHERE name = ?").get(cleanText(input.name)));
  const supplier = normalizeSupplierInput(input, current || {});
  const duplicate = sqlite.prepare("SELECT id FROM suppliers WHERE name = ? AND id != ?").get(supplier.name, Number(current?.id || supplier.id || 0));
  if (duplicate) throw new Error(`Supplier ${supplier.name} already exists.`);
  const params = {
    name: supplier.name,
    reference: supplier.reference || "",
    status: supplier.status || "Active",
    country: supplier.country || "",
    leadTimeDays: supplier.leadTimeDays || 0,
    moq: supplier.moq || 0,
    currency: supplier.currency || "",
    incoterms: supplier.incoterms || "",
    lastOrderNumber: supplier.lastOrderNumber || "",
    lastOrderedAt: supplier.lastOrderedAt || "",
    data: JSON.stringify(supplier)
  };
  if (current?.id) {
    sqlite.prepare(`
      UPDATE suppliers
      SET name = @name,
          reference = @reference,
          status = @status,
          country = @country,
          lead_time_days = @leadTimeDays,
          moq = @moq,
          currency = @currency,
          incoterms = @incoterms,
          last_order_number = @lastOrderNumber,
          last_ordered_at = @lastOrderedAt,
          data = @data,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = @id
    `).run({ ...params, id: current.id });
  } else {
    sqlite.prepare(`
      INSERT INTO suppliers (name, reference, status, country, lead_time_days, moq, currency, incoterms, last_order_number, last_ordered_at, data, updated_at)
      VALUES (@name, @reference, @status, @country, @leadTimeDays, @moq, @currency, @incoterms, @lastOrderNumber, @lastOrderedAt, @data, CURRENT_TIMESTAMP)
    `).run(params);
  }
  return supplierFromRow(sqlite.prepare("SELECT * FROM suppliers WHERE name = ?").get(supplier.name));
}

function supplierHistory(name) {
  const normalized = cleanText(name).toLowerCase();
  const dbData = readOrderDb();
  const products = readCatalogProducts({ includeArchived: true }).filter(product => cleanText(product.supplierName).toLowerCase() === normalized);
  const orders = (dbData.orders || [])
    .filter(order => cleanText(order.supplier?.name || order.supplierName).toLowerCase() === normalized)
    .slice(-12)
    .reverse()
    .map(order => ({
      id: order.id,
      orderNumber: order.orderNumber,
      orderDate: order.orderDate,
      status: order.status,
      units: (order.lines || []).reduce((sum, line) => sum + Number(line.quantity || 0), 0)
    }));
  return { productCount: products.length, products: products.slice(0, 12), orders };
}

function readCatalogSuppliers() {
  const sqlite = openOrderSqliteDb();
  return sqlite.prepare("SELECT * FROM suppliers ORDER BY name COLLATE NOCASE").all()
    .map(row => {
      const supplier = supplierFromRow(row);
      return { ...supplier, history: supplierHistory(supplier.name) };
    });
}

function recordProductSyncEvent(product, action, req, details = {}) {
  const sqlite = openOrderSqliteDb();
  sqlite.prepare(`
    INSERT INTO product_sync_events (id, product_id, sku, action, actor_name, shopify_product_gid, payload_summary, result, error, data, created_at)
    VALUES (@id, @productId, @sku, @action, @actorName, @shopifyProductGid, @payloadSummary, @result, @error, @data, CURRENT_TIMESTAMP)
  `).run({
    id: crypto.randomUUID(),
    productId: Number(product?.id || 0) || null,
    sku: product?.sku || "",
    action,
    actorName: req ? actorName(req) : "Team",
    shopifyProductGid: details.shopifyProductGid || product?.shopifyProductGid || "",
    payloadSummary: details.payload ? JSON.stringify(details.payload).slice(0, 4000) : "",
    result: details.result || "ok",
    error: details.error || "",
    data: JSON.stringify(details.data || {})
  });
}

function readProductSyncEvents(productId) {
  return openOrderSqliteDb().prepare(`
    SELECT id, product_id AS productId, sku, action, actor_name AS actorName, shopify_product_gid AS shopifyProductGid,
           payload_summary AS payloadSummary, result, error, data, created_at AS createdAt
    FROM product_sync_events
    WHERE product_id = ?
    ORDER BY created_at DESC
    LIMIT 80
  `).all(Number(productId)).map(row => ({ ...row, data: parseJson(row.data, {}) }));
}

function successfulShopifySyncEvent(product) {
  const sku = normalizeSku(product?.sku);
  const productId = Number(product?.id || 0);
  if (!sku && !productId) return null;
  return openOrderSqliteDb().prepare(`
    SELECT id, product_id AS productId, sku, action, shopify_product_gid AS shopifyProductGid, data, created_at AS createdAt
    FROM product_sync_events
    WHERE result = 'ok'
      AND shopify_product_gid IS NOT NULL
      AND shopify_product_gid != ''
      AND (product_id = @productId OR sku = @sku)
    ORDER BY created_at DESC
    LIMIT 1
  `).get({ productId: productId || -1, sku }) || null;
}

function productShopifyPayload(product, fileInput = null) {
  const optionName = "Size";
  const optionValue = cleanText(product.optionValue || product.size || "One Size Fits UK 8 to 18") || "One Size Fits UK 8 to 18";
  const colour = cleanText(product.colour || product.color);
  const department = cleanText(product.department || product.category || product.productType);
  const supplier = cleanText(product.supplierName);
  const baseMetafields = [
    department ? { namespace: "custom", key: "department", type: "single_line_text_field", value: department } : null,
    product.detailsAndFit ? { namespace: "custom", key: "details_and_fit", type: "multi_line_text_field", value: product.detailsAndFit } : null,
    product.fabricCare ? { namespace: "custom", key: "fabric_care", type: "multi_line_text_field", value: product.fabricCare } : null,
    colour ? { namespace: "custom", key: "product_group_swatch", type: "single_line_text_field", value: colour } : null,
    colour ? { namespace: "custom", key: "product_group_type", type: "single_line_text_field", value: "Colour" } : null,
    colour ? { namespace: "custom", key: "variant_colour", type: "single_line_text_field", value: colour } : null,
    product.productStatusCode ? { namespace: "custom", key: "product_status", type: "single_line_text_field", value: product.productStatusCode } : null,
    product.season ? { namespace: "custom", key: "season", type: "single_line_text_field", value: product.season } : null,
    supplier ? { namespace: "custom", key: "supplier", type: "single_line_text_field", value: supplier } : null,
    product.supplierSku ? { namespace: "custom", key: "supplier_sku", type: "single_line_text_field", value: product.supplierSku } : null
  ].filter(Boolean);
  const metafields = mergeMetafields(product.extraMetafields || [], baseMetafields);
  const variant = {
    optionValues: [{ optionName, name: optionValue }],
    price: String(numberOrZero(product.rrp).toFixed(2)),
    sku: product.sku,
    inventoryItem: {
      sku: product.sku,
      tracked: true,
      cost: String(numberOrZero(product.unitCostGbp).toFixed(2))
    }
  };
  if (numberOrZero(product.compareAtPrice)) variant.compareAtPrice = String(numberOrZero(product.compareAtPrice).toFixed(2));
  if (product.barcode) variant.barcode = product.barcode;

  const input = {
    title: product.title || product.style,
    status: "DRAFT",
    productType: product.productType || product.category || undefined,
    descriptionHtml: product.description ? escapeHtml(product.description).replace(/\r?\n/g, "<br>") : undefined,
    seo: product.seoTitle || product.seoDescription ? { title: product.seoTitle || undefined, description: product.seoDescription || undefined } : undefined,
    tags: [...new Set([...(product.tags || []), product.season].filter(Boolean))],
    productOptions: [{ name: optionName, position: 1, values: [{ name: optionValue }] }],
    variants: [variant],
    metafields
  };
  if (fileInput) input.files = [fileInput];
  Object.keys(input).forEach(key => input[key] === undefined && delete input[key]);
  return input;
}

function localImageFile(imageUrl) {
  const relativePath = productImageUploadPath(imageUrl);
  if (!relativePath) return null;
  const absolutePath = absoluteUploadPath(relativePath);
  if (!fs.existsSync(absolutePath)) return null;
  const buffer = fs.readFileSync(absolutePath);
  const ext = path.extname(absolutePath).toLowerCase();
  return {
    buffer,
    fileName: path.basename(absolutePath),
    mimeType: mimeTypes[ext] || "image/jpeg"
  };
}

function shopifyRemoteImageFileInput(product) {
  const imageUrl = String(product.imageUrl || "");
  if (!/^https?:\/\//i.test(imageUrl)) return null;
  let ext = "";
  try {
    ext = path.extname(new URL(imageUrl).pathname || "").toLowerCase();
  } catch {
    ext = "";
  }
  const input = {
    originalSource: imageUrl,
    alt: product.title || product.style || product.sku,
    contentType: "IMAGE"
  };
  if ([".jpg", ".jpeg", ".png", ".gif", ".webp"].includes(ext)) {
    input.filename = `${safeSegment(product.sku || "product-image", "product-image")}${ext}`;
  }
  return input;
}

async function stagedShopifyImageFile(product) {
  const local = localImageFile(product.imageUrl);
  if (!local) {
    return shopifyRemoteImageFileInput(product);
  }
  const staged = await shopifyGraphql(`mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
    stagedUploadsCreate(input: $input) {
      stagedTargets {
        url
        resourceUrl
        parameters { name value }
      }
      userErrors { field message }
    }
  }`, {
    input: [{
      filename: local.fileName,
      mimeType: local.mimeType,
      httpMethod: "POST",
      resource: "PRODUCT_IMAGE"
    }]
  });
  const errors = staged?.stagedUploadsCreate?.userErrors || [];
  if (errors.length) throw new Error(errors.map(error => error.message).join("; "));
  const target = staged?.stagedUploadsCreate?.stagedTargets?.[0];
  if (!target?.url || !target?.resourceUrl) throw new Error("Shopify did not return an upload target.");
  const upload = await requestMultipart(target.url, target.parameters || [], local);
  if (!upload.ok) throw new Error(`Shopify image upload failed: ${upload.status} ${upload.statusText}`);
  return {
    originalSource: target.resourceUrl,
    alt: product.title || product.style || product.sku,
    filename: local.fileName,
    contentType: "IMAGE"
  };
}

async function pushProductDraftToShopify(product, req) {
  const readiness = productReadiness(product);
  if (product.shopifyProductGid || product.status === "Shopify draft" || product.status === "Live" || product.syncStatus === "Synced draft") {
    throw shopifyPushError("This product is already linked to Shopify. Refresh status instead of pushing again, so Shopify edits are not overwritten.", "already_synced");
  }
  const successfulSync = successfulShopifySyncEvent(product);
  if (successfulSync?.shopifyProductGid) {
    const restored = upsertCatalogProduct({
      ...product,
      shopifyProductGid: successfulSync.shopifyProductGid,
      status: "Shopify draft",
      syncStatus: "Synced draft",
      lastSyncedAt: product.lastSyncedAt || successfulSync.createdAt || new Date().toISOString()
    });
    throw shopifyPushError("This product was already pushed to Shopify. I restored the local Shopify link; refresh status instead of pushing again.", "already_synced", { product: restored });
  }
  if (product.status !== "Ready for Shopify" && product.syncStatus !== "Error") throw new Error("Only products marked Ready for Shopify can be pushed.");
  if (!readiness.ready) throw new Error(`Product is not ready: ${readiness.blocking.join(", ")}`);
  const { shop, clientId, clientSecret } = shopifyConfig();
  if (!shop || !clientId || !clientSecret) return { configured: false, message: "Set SHOPIFY_SHOP, SHOPIFY_CLIENT_ID, and SHOPIFY_CLIENT_SECRET to push Shopify drafts." };

  const existingVariant = await shopifyVariantBySku(product.sku);
  if (existingVariant?.product?.id && normalizeSku(existingVariant.sku) === normalizeSku(product.sku)) {
    const duplicate = upsertCatalogProduct({
      ...product,
      shopifyProductGid: "",
      shopifyVariantGid: "",
      syncStatus: "Conflict",
      shopifyStatus: existingVariant.product.status || ""
    });
    recordProductSyncEvent(duplicate, "shopify_duplicate_sku", req, {
      result: "conflict",
      shopifyProductGid: existingVariant.product.id,
      error: `SKU ${product.sku} already exists in Shopify on ${existingVariant.product.title || existingVariant.product.id}.`,
      data: { existingVariant }
    });
    throw shopifyPushError(`SKU ${product.sku} already exists in Shopify on ${existingVariant.product.title || "another product"}. Refresh status or choose a different SKU before pushing.`, "duplicate_sku", { existingVariant });
  }

  const fileInput = await stagedShopifyImageFile(product);
  const input = productShopifyPayload(product, fileInput);
  const response = await shopifyGraphql(`mutation createProductDraft($productSet: ProductSetInput!, $synchronous: Boolean!) {
    productSet(input: $productSet, synchronous: $synchronous) {
      product {
        id
        title
        status
        variants(first: 5) {
          nodes { id sku }
        }
      }
      userErrors { field message code }
    }
  }`, { productSet: input, synchronous: true });
  const payload = response?.productSet || {};
  if ((payload.userErrors || []).length) throw new Error(payload.userErrors.map(error => error.message).join("; "));
  const shopifyProduct = payload.product;
  if (!shopifyProduct?.id) throw new Error("Shopify did not return a product ID.");
  const variant = (shopifyProduct.variants?.nodes || []).find(item => normalizeSku(item.sku) === normalizeSku(product.sku)) || shopifyProduct.variants?.nodes?.[0] || {};
  const updated = upsertCatalogProduct({
    ...product,
    status: "Shopify draft",
    shopifyProductGid: shopifyProduct.id,
    shopifyVariantGid: variant.id || "",
    shopifyStatus: shopifyProduct.status || "DRAFT",
    syncStatus: "Synced draft",
    lastSyncedAt: new Date().toISOString()
  });
  recordProductSyncEvent(updated, "shopify_push_draft", req, {
    result: "ok",
    shopifyProductGid: shopifyProduct.id,
    payload: { sku: product.sku, title: input.title, status: "DRAFT" },
    data: { shopifyProduct, input }
  });
  return { configured: true, product: updated, shopifyProduct };
}

async function refreshProductShopifyStatus(product, req) {
  const { shop, clientId, clientSecret } = shopifyConfig();
  if (!shop || !clientId || !clientSecret) return { configured: false, message: "Set Shopify credentials to refresh product sync status." };
  const successfulSync = successfulShopifySyncEvent(product);
  if (!product.shopifyProductGid && successfulSync?.shopifyProductGid) {
    product = {
      ...product,
      shopifyProductGid: successfulSync.shopifyProductGid
    };
  }
  let node = null;
  let variant = {};
  let data = null;
  if (product.shopifyProductGid) {
    data = await shopifyGraphql(`query ProductSyncStatusById($id: ID!) {
      product(id: $id) {
        id
        title
        status
        variants(first: 20) {
          nodes { id sku }
        }
      }
    }`, { id: product.shopifyProductGid });
    node = data?.product || null;
    variant = (node?.variants?.nodes || []).find(item => normalizeSku(item.sku) === normalizeSku(product.sku)) || node?.variants?.nodes?.[0] || {};
  } else {
    const variantNode = await shopifyVariantBySku(product.sku);
    data = { productVariant: variantNode };
    node = variantNode?.product || null;
    variant = variantNode || {};
    if (node?.id && normalizeSku(variant.sku) === normalizeSku(product.sku)) {
      const shopifyState = syncedProductStateFromShopifyStatus(node.status);
      const updated = upsertCatalogProduct({
        ...product,
        shopifyProductGid: node.id,
        shopifyVariantGid: variant.id || product.shopifyVariantGid || "",
        shopifyStatus: shopifyState.shopifyStatus,
        syncStatus: shopifyState.syncStatus,
        status: shopifyState.status,
        lastSyncedAt: new Date().toISOString()
      });
      recordProductSyncEvent(updated, "shopify_sync_status", req, {
        result: "ok",
        shopifyProductGid: node.id,
        payload: { sku: product.sku, matchedExisting: true },
        data
      });
      return { configured: true, product: updated, found: true, linkedExisting: true };
    }
  }
  if (!node) {
    const updated = upsertCatalogProduct({ ...product, syncStatus: "Conflict", shopifyStatus: "" });
    recordProductSyncEvent(updated, "shopify_sync_status", req, { result: "conflict", error: "No matching Shopify product found." });
    return { configured: true, product: updated, found: false };
  }
  const shopifyState = syncedProductStateFromShopifyStatus(node.status);
  const updated = upsertCatalogProduct({
    ...product,
    shopifyProductGid: node.id,
    shopifyVariantGid: variant.id || product.shopifyVariantGid || "",
    shopifyStatus: shopifyState.shopifyStatus,
    syncStatus: shopifyState.syncStatus,
    status: shopifyState.status,
    lastSyncedAt: new Date().toISOString()
  });
  recordProductSyncEvent(updated, "shopify_sync_status", req, { result: "ok", shopifyProductGid: node.id, data });
  return { configured: true, product: updated, found: true };
}

async function reconcileOrderProductsFromShopify(order, req) {
  const before = orderProductCompletion(order);
  const results = [];
  const seen = new Set();
  for (const line of before.lines || []) {
    const sku = normalizeSku(line.sku);
    if (!sku || seen.has(sku)) continue;
    seen.add(sku);
    if (line.complete) {
      results.push({ sku, ok: true, skipped: true, message: "Already linked locally." });
      continue;
    }
    const product = findCatalogProduct(sku) || {
      sku,
      title: line.style || line.buyingCode || sku,
      style: line.style || "",
      buyingCode: line.buyingCode || "",
      supplierName: order.supplier?.name || "",
      lastOrderNumber: order.orderNumber || "",
      lastOrderedAt: order.savedAt || order.orderDate || ""
    };
    try {
      const result = await refreshProductShopifyStatus(product, req);
      if (result.configured === false) {
        results.push({ sku, ok: false, configured: false, message: result.message || "Shopify credentials are not configured." });
        continue;
      }
      results.push({
        sku,
        ok: Boolean(result.product && productIsShopifyComplete(result.product)),
        found: Boolean(result.found),
        linkedExisting: Boolean(result.linkedExisting),
        status: result.product?.status || "",
        syncStatus: result.product?.syncStatus || "",
        shopifyStatus: result.product?.shopifyStatus || ""
      });
    } catch (error) {
      results.push({ sku, ok: false, error: error.message || "Could not check Shopify." });
    }
  }
  const afterOrder = readOrderDb().orders.find(item => String(item.id) === String(order.id)) || order;
  const after = orderProductCompletion(afterOrder);
  recordOrderEvent(order.id, "product_sync", actorName(req), after.complete ? "Shopify product check completed" : "Shopify product check found outstanding SKUs", {
    before,
    after,
    results
  });
  return { order: afterOrder, before, after, results };
}

async function handleApi(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "GET" && url.pathname === "/api/products") {
    const products = readCatalogProducts({ includeArchived: url.searchParams.get("includeArchived") === "1" });
    sendJson(res, 200, {
      products,
      count: products.length,
      suppliers: readCatalogSuppliers().map(supplier => ({ id: supplier.id, name: supplier.name, status: supplier.status })),
      lastIssuedSku: getLastIssuedSku(readOrderDb()),
      shopifyConfigured: Boolean(shopifyConfig().shop && shopifyConfig().clientId && shopifyConfig().clientSecret),
      generatedAt: new Date().toISOString()
    });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/products") {
    if (!requireRoles(req, res, ["Buyer", "Admin"])) return true;
    try {
      const body = await readJsonBody(req);
      const product = upsertCatalogProduct(body.product || body, req);
      reserveIssuedSku(product.sku, { source: "product-master" });
      const publicProduct = readCatalogProducts({ includeArchived: true }).find(item => String(item.id) === String(product.id)) || product;
      sendJson(res, 200, { ok: true, product: publicProduct });
    } catch (error) {
      sendJson(res, 400, { error: error.message || "Could not save product." });
    }
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/products/detail") {
    const product = findCatalogProduct(url.searchParams.get("id") || url.searchParams.get("sku"));
    if (!product) {
      sendJson(res, 404, { error: "Product not found." });
      return true;
    }
    const full = readCatalogProducts({ includeArchived: true }).find(item => String(item.id) === String(product.id)) || product;
    sendJson(res, 200, {
      product: full,
      events: readProductSyncEvents(product.id),
      suppliers: readCatalogSuppliers().map(supplier => ({ id: supplier.id, name: supplier.name, status: supplier.status })),
      generatedAt: new Date().toISOString()
    });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/products/update") {
    if (!requireRoles(req, res, ["Buyer", "Admin"])) return true;
    try {
      const body = await readJsonBody(req);
      const product = upsertCatalogProduct(body.product || body, req);
      reserveIssuedSku(product.sku, { source: "product-master" });
      const publicProduct = readCatalogProducts({ includeArchived: true }).find(item => String(item.id) === String(product.id)) || product;
      sendJson(res, 200, { ok: true, product: publicProduct, events: readProductSyncEvents(product.id) });
    } catch (error) {
      sendJson(res, 400, { error: error.message || "Could not update product." });
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/products/archive") {
    if (!requireRoles(req, res, ["Buyer", "Admin"])) return true;
    try {
      const body = await readJsonBody(req);
      const product = findCatalogProduct(body.id || body.sku);
      if (!product) throw new Error("Product not found.");
      const archived = upsertCatalogProduct({ ...product, status: "Archived" }, req);
      recordProductSyncEvent(archived, "archive", req, { result: "ok", payload: { sku: archived.sku } });
      sendJson(res, 200, { ok: true, product: archived });
    } catch (error) {
      sendJson(res, 400, { error: error.message || "Could not archive product." });
    }
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/suppliers") {
    sendJson(res, 200, {
      suppliers: readCatalogSuppliers(),
      count: readCatalogSuppliers().length,
      generatedAt: new Date().toISOString()
    });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/suppliers/update") {
    if (!requireRoles(req, res, ["Buyer", "Admin"])) return true;
    try {
      const body = await readJsonBody(req);
      const supplier = upsertCatalogSupplier(body.supplier || body);
      sendJson(res, 200, { ok: true, supplier });
    } catch (error) {
      sendJson(res, 400, { error: error.message || "Could not save supplier." });
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/products/shopify/preview") {
    if (!requireRoles(req, res, ["Buyer", "Admin"])) return true;
    try {
      const body = await readJsonBody(req);
      const ids = new Set((body.ids || []).map(String));
      if (!ids.size) throw new Error("Choose at least one product to preview.");
      const products = readCatalogProducts({ includeArchived: true }).filter(product => !ids.size || ids.has(String(product.id)) || ids.has(product.sku));
      const previews = products.map(product => ({
        product,
        readiness: product.readiness,
        exportMetadata: {
          productCategory: product.productCategory || "",
          googleProductCategory: product.googleProductCategory || ""
        },
        payload: productShopifyPayload(product, shopifyRemoteImageFileInput(product))
      }));
      sendJson(res, 200, {
        ok: true,
        configured: Boolean(shopifyConfig().shop && shopifyConfig().clientId && shopifyConfig().clientSecret),
        previews
      });
    } catch (error) {
      sendJson(res, 400, { error: error.message || "Could not preview Shopify payload." });
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/products/shopify/push-draft") {
    if (!requireRoles(req, res, ["Admin", "Buyer"], "Only Admin or Buyer users can push Shopify drafts.")) return true;
    try {
      const body = await readJsonBody(req);
      const ids = new Set((body.ids || []).map(String));
      if (!ids.size) throw new Error("Choose at least one product to push.");
      const products = readCatalogProducts({ includeArchived: true }).filter(product => ids.has(String(product.id)) || ids.has(product.sku));
      const results = [];
      for (const product of products) {
        try {
          const result = await pushProductDraftToShopify(product, req);
          results.push({ id: product.id, sku: product.sku, ok: Boolean(result.product), ...result });
        } catch (error) {
          if (error.code === "already_synced") {
            const blockedProduct = error.product || product;
            recordProductSyncEvent(blockedProduct, "shopify_push_blocked", req, { result: "blocked", error: error.message || "", payload: { sku: product.sku } });
            results.push({ id: product.id, sku: product.sku, ok: false, blocked: true, product: blockedProduct, error: error.message || "Product is already synced." });
            continue;
          }
          if (error.code === "duplicate_sku") {
            results.push({ id: product.id, sku: product.sku, ok: false, conflict: true, error: error.message || "Duplicate Shopify SKU." });
            continue;
          }
          if (product.syncStatus === "Error") {
            try {
              const reconciled = await refreshProductShopifyStatus(product, req);
              if (reconciled.found && reconciled.product?.shopifyProductGid) {
                recordProductSyncEvent(reconciled.product, "shopify_push_reconciled", req, {
                  result: "ok",
                  error: error.message || "",
                  payload: { sku: product.sku }
                });
                results.push({ id: product.id, sku: product.sku, ok: true, reconciled: true, product: reconciled.product, previousError: error.message || "" });
                continue;
              }
            } catch {
              // Keep the original push error; reconciliation is best-effort.
            }
          }
          const failed = upsertCatalogProduct({ ...product, syncStatus: "Error" });
          recordProductSyncEvent(failed, "shopify_push_draft", req, { result: "error", error: error.message || "Shopify push failed.", payload: { sku: product.sku } });
          results.push({ id: product.id, sku: product.sku, ok: false, error: error.message || "Shopify push failed." });
        }
      }
      sendJson(res, 200, {
        ok: results.some(result => result.ok),
        configured: Boolean(shopifyConfig().shop && shopifyConfig().clientId && shopifyConfig().clientSecret),
        results,
        products: readCatalogProducts({ includeArchived: true })
      });
    } catch (error) {
      sendJson(res, 400, { error: error.message || "Could not push Shopify drafts." });
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/products/shopify/sync-status") {
    if (!requireRoles(req, res, ["Buyer", "Admin", "Merchandising"])) return true;
    try {
      const body = await readJsonBody(req);
      const ids = new Set((body.ids || []).map(String));
      if (!ids.size) throw new Error("Choose at least one product to refresh.");
      const products = readCatalogProducts({ includeArchived: true }).filter(product => ids.has(String(product.id)) || ids.has(product.sku));
      const results = [];
      for (const product of products) {
        try {
          const result = await refreshProductShopifyStatus(product, req);
          results.push({ id: product.id, sku: product.sku, ok: true, ...result });
        } catch (error) {
          const failed = upsertCatalogProduct({ ...product, syncStatus: "Error" });
          recordProductSyncEvent(failed, "shopify_sync_status", req, { result: "error", error: error.message || "Could not refresh Shopify status." });
          results.push({ id: product.id, sku: product.sku, ok: false, error: error.message || "Could not refresh Shopify status." });
        }
      }
      sendJson(res, 200, { ok: true, results, products: readCatalogProducts({ includeArchived: true }) });
    } catch (error) {
      sendJson(res, 400, { error: error.message || "Could not refresh Shopify status." });
    }
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/reports/bestsellers/periods") {
    sendJson(res, 200, {
      periods: readBestsellersPeriods(),
      generatedAt: new Date().toISOString()
    });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/reports/bestsellers") {
    getBestsellersReport(req, res);
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/reports/bestsellers/sync") {
    if (!requireRoles(req, res, ["Merchandising", "Admin"])) return true;
    try {
      await syncBestsellersReport(req, res);
    } catch (error) {
      sendJson(res, 500, { error: error.message || "Could not sync bestsellers report" });
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/reports/bestsellers/sync-job") {
    if (!requireRoles(req, res, ["Merchandising", "Admin"])) return true;
    try {
      const body = await readJsonBody(req);
      const range = body.startDate && body.endDate
        ? reportRangeFromRequest(new URL(`http://local/?startDate=${encodeURIComponent(body.startDate)}&endDate=${encodeURIComponent(body.endDate)}`))
        : reportRangeFromRequest(url, 28);
      const job = startBestsellersSyncJob(range);
      sendJson(res, 202, { job });
    } catch (error) {
      sendJson(res, 400, { error: error.message || "Could not start bestsellers sync job" });
    }
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/reports/bestsellers/sync-job") {
    const job = readReportSyncJob(url.searchParams.get("id"));
    if (!job) {
      sendJson(res, 404, { error: "Sync job not found." });
      return true;
    }
    sendJson(res, 200, { job });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/reports/bestsellers/import-csv") {
    if (!requireRoles(req, res, ["Merchandising", "Admin"])) return true;
    try {
      await importBestsellersCsv(req, res);
    } catch (error) {
      sendJson(res, 400, { error: error.message || "Could not import CSV files" });
    }
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/reports/stock-snapshots") {
    sendJson(res, 200, {
      snapshots: readStockSnapshots(url),
      generatedAt: new Date().toISOString()
    });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/weekly-actions") {
    handleWeeklyActionsList(req, res);
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/weekly-actions/generate") {
    if (!requireRoles(req, res, ["Buyer", "Merchandising", "Admin"])) return true;
    try {
      await handleWeeklyActionsGenerate(req, res);
    } catch (error) {
      sendJson(res, 400, { error: error.message || "Could not generate weekly actions" });
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/weekly-actions/update") {
    if (!requireRoles(req, res, ["Buyer", "Merchandising", "Admin"])) return true;
    try {
      await handleWeeklyActionsUpdate(req, res);
    } catch (error) {
      sendJson(res, 400, { error: error.message || "Could not update weekly action" });
    }
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/order-form/bootstrap") {
    const db = readOrderDb();
    const workflows = readOrderWorkflowMap();
    const orders = db.orders.map(order => syncOrderStatusFromWorkflowRow(order, workflows.get(String(order.id))));
    const activeOrders = orders.filter(order => !order.archivedAt);
    sendJson(res, 200, {
      suppliers: db.suppliers,
      products: [],
      orders: activeOrders.slice(-20).reverse(),
      company: db.company,
      delivery: db.delivery,
      nextOrderNumber: nextOrderNumber({ ...db, orders }),
      lastIssuedSku: getLastIssuedSku(db),
      shopifyConfigured: Boolean(shopifyConfig().shop && shopifyConfig().clientId && shopifyConfig().clientSecret)
    });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/order-form/local-skus") {
    if (!requireRoles(req, res, skuRegisterRoles(), "You do not have access to the SKU register.")) return true;
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
    if (!requireRoles(req, res, ["Admin"])) return true;
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
    writeLastIssuedSkuSetting(getLastIssuedSku(readOrderDb()));
    sendJson(res, 200, { ok: true, deleted: Boolean(deleted), sku });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/order-form/next-sku") {
    if (!requireRoles(req, res, ["Buyer", "Admin"])) return true;
    try {
      await readJsonBody(req);
      const dbData = readOrderDb();
      const baseline = getLastIssuedSku(dbData);
      const nextSku = nextAvailableIssuedSku(dbData, baseline);
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
    const masterProductCandidate = findCatalogProduct(sku);
    const masterProduct = productHasStaleOrderReference(db, masterProductCandidate) ? null : masterProductCandidate;
    const savedProduct = masterProduct || db.products.find(product => normalizeSku(product.sku) === sku && !productHasStaleOrderReference(db, product)) || null;
    if (masterProduct) {
      sendJson(res, 200, {
        found: true,
        product: masterProduct,
        source: "master",
        shopifyConfigured: Boolean(shopifyConfig().shop && shopifyConfig().clientId && shopifyConfig().clientSecret),
        message: ""
      });
      return true;
    }
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
        message: friendlyShopifyLookupMessage(error)
      });
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/order-form/image") {
    if (!requireRoles(req, res, ["Buyer", "Admin"])) return true;
    try {
      const body = await readJsonBody(req);
      const stored = writeImageUpload(["order-images", body.orderNumber || "drafts"], {
        imageData: body.imageData,
        fileName: body.fileName || "",
        mimeType: body.mimeType || "",
        label: body.sku || body.buyingCode || body.lineId || "line"
      });
      if (!stored) throw new Error("Could not read that image upload.");
      sendJson(res, 200, { ok: true, ...stored });
    } catch (error) {
      sendJson(res, 400, { error: error.message || "Could not upload image" });
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/order-form/orders") {
    if (!requireRoles(req, res, ["Buyer", "Admin"])) return true;
    try {
      const order = await readJsonBody(req);
      const db = readOrderDb();
      const incomingId = String(order.id || "");
      const incomingOrderNumber = String(order.orderNumber || "");
      const isNewOrder = !db.orders.some(item =>
        (incomingId && String(item.id) === incomingId)
        || (incomingOrderNumber && String(item.orderNumber || "") === incomingOrderNumber)
      );
      let savedOrder = {
        ...order,
        id: order.id || `${Date.now()}`,
        orderNumber: order.orderNumber || nextOrderNumber(db),
        savedAt: new Date().toISOString()
      };
      savedOrder = saveOrderFormOrder(db, savedOrder);
      const workflow = syncWorkflowFromOrderStatus(savedOrder);
      if (isNewOrder) await notifyOrderCreatedForApproval(req, savedOrder, workflow);
      const refreshed = readOrderDb();
      writeLastIssuedSkuSetting(getLastIssuedSku(refreshed));
      sendJson(res, 200, { ok: true, order: savedOrder, nextOrderNumber: nextOrderNumber(refreshed) });
    } catch (error) {
      sendJson(res, 400, { error: error.message || "Could not save order" });
    }
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/orders/workspace") {
    const db = readOrderDb();
    const workflows = readOrderWorkflowMap();
    const products = catalogProductMap();
    const orders = db.orders
      .map(order => {
        const workflow = workflows.get(String(order.id));
        return publicManagedOrder(syncOrderStatusFromWorkflowRow(order, workflow), workflow, products);
      })
      .sort((a, b) => String(b.orderDate || b.savedAt).localeCompare(String(a.orderDate || a.savedAt)));
    sendJson(res, 200, {
      orders,
      metrics: orderWorkflowMetrics(orders),
      authMode: authMode(),
      currentUser: req.currentUser || null,
      users: publicAssignableUsers(),
      googleWorkspaceReady: true,
      generatedAt: new Date().toISOString()
    });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/orders/reports") {
    try {
      sendJson(res, 200, buildOrderReports({
        windowDays: url.searchParams.get("windowDays"),
        dateFrom: url.searchParams.get("dateFrom"),
        dateTo: url.searchParams.get("dateTo"),
        includeArchived: url.searchParams.get("includeArchived")
      }));
    } catch (error) {
      sendJson(res, 500, { error: error.message || "Could not build order reports" });
    }
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/orders/detail") {
    const orderId = String(url.searchParams.get("id") || "");
    const db = readOrderDb();
    const order = db.orders.find(item => String(item.id) === orderId);
    if (!order) {
      sendJson(res, 404, { error: "Order not found" });
      return true;
    }
    const workflow = readOrderWorkflowMap().get(orderId);
    const syncedOrder = syncOrderStatusFromWorkflowRow(order, workflow);
    sendJson(res, 200, {
      order: publicManagedOrder(syncedOrder, workflow),
      events: readOrderEvents(orderId),
      invoices: readOrderInvoices(orderId),
      batches: readOrderBatches(orderId),
      batchLines: readOrderBatchLines(orderId),
      users: publicAssignableUsers()
    });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/orders/products/shopify-status") {
    if (!requireRoles(req, res, ["Buyer", "Merchandising", "Admin"], "Only Buyer, Merchandising, or Admin users can check order products against Shopify.")) return true;
    try {
      const body = await readJsonBody(req);
      const orderId = String(body.orderId || "");
      const db = readOrderDb();
      const order = db.orders.find(item => String(item.id) === orderId);
      if (!order) {
        sendJson(res, 404, { error: "Order not found" });
        return true;
      }
      const result = await reconcileOrderProductsFromShopify(order, req);
      const workflow = readOrderWorkflowMap().get(orderId);
      sendJson(res, 200, {
        ok: result.after.complete,
        order: publicManagedOrder(result.order, workflow),
        results: result.results,
        before: result.before,
        after: result.after,
        events: readOrderEvents(orderId),
        invoices: readOrderInvoices(orderId),
        batches: readOrderBatches(orderId),
        batchLines: readOrderBatchLines(orderId)
      });
    } catch (error) {
      sendJson(res, 400, { error: error.message || "Could not check order products against Shopify" });
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/orders/workflow") {
    try {
      const body = await readJsonBody(req);
      const section = body.section || "workflow";
      if (!requireRoles(req, res, rolesForOrderSection(section))) return true;
      const orderId = String(body.orderId || "");
      const db = readOrderDb();
      const order = db.orders.find(item => String(item.id) === orderId);
      if (!order) {
        sendJson(res, 404, { error: "Order not found" });
        return true;
      }
      const previousWorkflow = workflowFromRow(readOrderWorkflowMap().get(orderId), order);
      const workflow = writeOrderWorkflow(order, body.patch || {}, actorName(req), section);
      const status = orderStatusForWorkflowPatch(section || "", workflow);
      const updatedOrder = status ? updateStoredOrderStatus(order.id, status) || order : order;
      await notifyOrderHandoffIfChanged(req, order, updatedOrder, previousWorkflow, workflow);
      const publicOrder = publicManagedOrder(updatedOrder, null);
      publicOrder.workflow = workflowWithProductCompletionGate(updatedOrder, workflow, publicOrder.productCompletion);
      publicOrder.compositeStatus = orderCompositeStatus(updatedOrder, publicOrder.workflow, publicOrder.productCompletion);
      sendJson(res, 200, {
        ok: true,
        order: publicOrder,
        workflow: publicOrder.workflow,
        events: readOrderEvents(orderId),
        invoices: readOrderInvoices(orderId),
        batches: readOrderBatches(orderId),
        batchLines: readOrderBatchLines(orderId)
      });
    } catch (error) {
      sendJson(res, 400, { error: error.message || "Could not update order workflow" });
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/orders/invoices") {
    if (!requireRoles(req, res, ["Buyer", "Finance", "Admin"])) return true;
    try {
      const body = await readJsonBody(req);
      body.actorName = actorName(req);
      const orderId = String(body.orderId || "");
      const db = readOrderDb();
      const order = db.orders.find(item => String(item.id) === orderId);
      if (!order) {
        sendJson(res, 404, { error: "Order not found" });
        return true;
      }
      const previousWorkflow = workflowFromRow(readOrderWorkflowMap().get(orderId), order);
      const wasFullyPaid = invoiceSummaryIsFullyPaid(invoiceSummary(order));
      const invoices = saveOrderInvoice(order, body, { canManagePayment: userHasRole(req.currentUser, ["Finance", "Admin"]) });
      const refreshedOrder = readOrderDb().orders.find(item => String(item.id) === orderId) || order;
      const workflow = readOrderWorkflowMap().get(orderId);
      await notifyOrderHandoffIfChanged(req, order, refreshedOrder, previousWorkflow, workflowFromRow(workflow, refreshedOrder), { notifyRoleActionChange: true });
      if (!wasFullyPaid && invoiceSummaryIsFullyPaid(invoiceSummary(refreshedOrder))) {
        await notifyOrderBuyerInvoicePaid(req, refreshedOrder);
      }
      sendJson(res, 200, {
        ok: true,
        order: publicManagedOrder(refreshedOrder, workflow),
        invoices,
        batches: readOrderBatches(orderId),
        batchLines: readOrderBatchLines(orderId),
        events: readOrderEvents(orderId)
      });
    } catch (error) {
      sendJson(res, 400, { error: error.message || "Could not save invoice" });
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/orders/invoices/delete") {
    if (!requireRoles(req, res, ["Finance", "Admin"])) return true;
    try {
      const body = await readJsonBody(req);
      body.actorName = actorName(req);
      const orderId = String(body.orderId || "");
      const db = readOrderDb();
      const order = db.orders.find(item => String(item.id) === orderId);
      if (!order) {
        sendJson(res, 404, { error: "Order not found" });
        return true;
      }
      const previousWorkflow = workflowFromRow(readOrderWorkflowMap().get(orderId), order);
      const invoices = deleteOrderInvoice(order, body);
      const refreshedOrder = readOrderDb().orders.find(item => String(item.id) === orderId) || order;
      const workflow = readOrderWorkflowMap().get(orderId);
      await notifyOrderHandoffIfChanged(req, order, refreshedOrder, previousWorkflow, workflowFromRow(workflow, refreshedOrder), { notifyRoleActionChange: true });
      sendJson(res, 200, {
        ok: true,
        order: publicManagedOrder(refreshedOrder, workflow),
        invoices,
        batches: readOrderBatches(orderId),
        batchLines: readOrderBatchLines(orderId),
        events: readOrderEvents(orderId)
      });
    } catch (error) {
      sendJson(res, 400, { error: error.message || "Could not delete invoice" });
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/orders/batches") {
    if (!requireRoles(req, res, ["Buyer", "Finance", "Merchandising", "Admin"])) return true;
    try {
      const body = await readJsonBody(req);
      body.actorName = actorName(req);
      const orderId = String(body.orderId || "");
      const db = readOrderDb();
      const order = db.orders.find(item => String(item.id) === orderId);
      if (!order) {
        sendJson(res, 404, { error: "Order not found" });
        return true;
      }
      const previousWorkflow = workflowFromRow(readOrderWorkflowMap().get(orderId), order);
      const batches = saveOrderBatch(order, body);
      const refreshedOrder = readOrderDb().orders.find(item => String(item.id) === orderId) || order;
      const workflow = readOrderWorkflowMap().get(orderId);
      await notifyOrderHandoffIfChanged(req, order, refreshedOrder, previousWorkflow, workflowFromRow(workflow, refreshedOrder), { notifyRoleActionChange: true });
      sendJson(res, 200, {
        ok: true,
        order: publicManagedOrder(refreshedOrder, workflow),
        batches,
        invoices: readOrderInvoices(orderId),
        batchLines: readOrderBatchLines(orderId),
        events: readOrderEvents(orderId)
      });
    } catch (error) {
      sendJson(res, 400, { error: error.message || "Could not save batch" });
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/orders/batches/delete") {
    if (!requireRoles(req, res, ["Buyer", "Merchandising", "Admin"])) return true;
    try {
      const body = await readJsonBody(req);
      body.actorName = actorName(req);
      const orderId = String(body.orderId || "");
      const db = readOrderDb();
      const order = db.orders.find(item => String(item.id) === orderId);
      if (!order) {
        sendJson(res, 404, { error: "Order not found" });
        return true;
      }
      const previousWorkflow = workflowFromRow(readOrderWorkflowMap().get(orderId), order);
      const batches = deleteOrderBatch(order, body);
      const refreshedOrder = readOrderDb().orders.find(item => String(item.id) === orderId) || order;
      const workflow = readOrderWorkflowMap().get(orderId);
      await notifyOrderHandoffIfChanged(req, order, refreshedOrder, previousWorkflow, workflowFromRow(workflow, refreshedOrder), { notifyRoleActionChange: true });
      sendJson(res, 200, {
        ok: true,
        order: publicManagedOrder(refreshedOrder, workflow),
        batches,
        invoices: readOrderInvoices(orderId),
        batchLines: readOrderBatchLines(orderId),
        events: readOrderEvents(orderId)
      });
    } catch (error) {
      sendJson(res, 400, { error: error.message || "Could not delete batch" });
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/orders/archive") {
    if (!requireRoles(req, res, ["Merchandising", "Admin"])) return true;
    try {
      const body = await readJsonBody(req);
      const orderId = String(body.orderId || "");
      const order = setOrderArchived(orderId, Boolean(body.archived), actorName(req));
      const workflow = readOrderWorkflowMap().get(orderId);
      sendJson(res, 200, {
        ok: true,
        order: publicManagedOrder(order, workflow),
        events: readOrderEvents(orderId),
        invoices: readOrderInvoices(orderId),
        batches: readOrderBatches(orderId),
        batchLines: readOrderBatchLines(orderId)
      });
    } catch (error) {
      sendJson(res, 400, { error: error.message || "Could not archive order" });
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/orders/delete") {
    if (!requireRoles(req, res, ["Admin"])) return true;
    try {
      const body = await readJsonBody(req);
      const deleted = deleteStoredOrder(body.orderId, actorName(req));
      sendJson(res, 200, { ok: true, deleted });
    } catch (error) {
      sendJson(res, 400, { error: error.message || "Could not delete order" });
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/orders/events") {
    try {
      const body = await readJsonBody(req);
      const orderId = String(body.orderId || "");
      const message = String(body.message || "").trim();
      if (!orderId || !message) {
        sendJson(res, 400, { error: "Choose an order and add a note." });
        return true;
      }
      const db = readOrderDb();
      const order = db.orders.find(item => String(item.id) === orderId);
      if (!order) {
        sendJson(res, 404, { error: "Order not found" });
        return true;
      }
      recordOrderEvent(orderId, "note", actorName(req), message, actorData(req));
      await notifyMentionedUsers(req, message, {
        entityType: "order",
        entityId: orderId,
        title: "You were mentioned on an order",
        url: `/orders.html?id=${encodeURIComponent(orderId)}`
      });
      sendJson(res, 200, { ok: true, events: readOrderEvents(orderId) });
    } catch (error) {
      sendJson(res, 400, { error: error.message || "Could not add note" });
    }
    return true;
  }

  return false;
}

function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname.startsWith("/uploads/")) {
    const relativePath = decodeURIComponent(url.pathname.replace(/^\/uploads\/+/, ""));
    let filePath;
    try {
      filePath = absoluteUploadPath(relativePath);
    } catch {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }
    fs.readFile(filePath, (error, data) => {
      if (error) {
        res.writeHead(404);
        res.end("Not found");
        return;
      }
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, {
        "content-type": mimeTypes[ext] || "application/octet-stream",
        "cache-control": "private, max-age=3600"
      });
      res.end(data);
    });
    return;
  }

  const safePath = path.normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
  const requestedPath = safePath === path.sep ? "index.html" : safePath.slice(1);
  const filePath = path.join(publicDir, requestedPath);

  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  const sendStaticData = (targetPath, data) => {
    const ext = path.extname(targetPath).toLowerCase();
    if (ext === ".html" && path.basename(targetPath).toLowerCase() !== "login.html") {
      const html = data.toString("utf8");
      const injected = html.includes("/auth.js")
        ? html
        : html.replace("</head>", `<script src="/auth.js"></script>\n</head>`);
      res.writeHead(200, staticHeaders(ext));
      res.end(injected);
      return;
    }
    res.writeHead(200, staticHeaders(ext));
    res.end(data);
  };

  fs.readFile(filePath, (error, data) => {
    if (error) {
      fs.readFile(path.join(publicDir, "index.html"), (indexError, indexData) => {
        if (indexError) {
          res.writeHead(404);
          res.end("Not found");
          return;
        }
        sendStaticData(path.join(publicDir, "index.html"), indexData);
      });
      return;
    }

    sendStaticData(filePath, data);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS" && req.url.startsWith("/api/")) {
    res.writeHead(204, {
      ...corsHeaders()
    });
    res.end();
    return;
  }

  if (!isAuthorized(req)) {
    requireAuth(req, res);
    return;
  }

  if (!verifyCsrf(req, res)) return;

  if (req.url.startsWith("/api/auth/")) {
    const handled = await handleAuthApi(req, res);
    if (handled) return;
  }

  if (req.url.startsWith("/api/admin/")) {
    const handled = await handleAdminApi(req, res);
    if (handled) return;
  }

  if (req.url.startsWith("/api/notifications") || req.url.startsWith("/api/users/assignees")) {
    const handled = await handleNotificationApi(req, res);
    if (handled) return;
  }

  const requestPath = new URL(req.url, `http://${req.headers.host}`).pathname;
  if (requestPath === "/sku-register.html" && !requireRoles(req, res, skuRegisterRoles(), "You do not have access to the SKU register.")) return;

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
    if (!requireRoles(req, res, ["Admin"], "Only an admin can apply Shopify collection reorders.")) return;
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
  startNotificationDigestTimer();
});
