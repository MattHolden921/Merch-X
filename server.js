const http = require("node:http");
const https = require("node:https");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");
const { createEmailCampaignService } = require("./lib/email-campaign-service");
const { buildLabelJobSnapshot, normalizeDoubleBarcodeSnapshot } = require("./lib/label-jobs");
const orderActuals = require("./lib/order-actuals");
const { DEFAULT_PAH_SETTINGS, buildPahReport, safeSettings: safePahSettings } = require("./lib/pah-report");
const pnl = require("./lib/pnl");
const salePlanner = require("./lib/sale-planner");
const windsorMarketing = require("./lib/windsor-marketing");

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
const authRoles = ["Admin", "Buyer", "Buying Director", "Finance", "Merchandising", "Marketing"];
const invoiceBalanceToleranceGbp = Math.max(0, Number(process.env.ORDER_INVOICE_TOLERANCE_GBP || 10));

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

function sendCsv(res, filename, content) {
  res.writeHead(200, {
    "content-type": "text/csv; charset=utf-8",
    "content-disposition": `attachment; filename="${String(filename || "PAH.csv").replace(/["\r\n]/g, "")}"`,
    "cache-control": "no-store, no-cache, must-revalidate",
    ...corsHeaders()
  });
  res.end(content);
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
  const rawShop = String(process.env.SHOPIFY_SHOP || process.env.SHOPIFY_STORE_DOMAIN || process.env.SHOPIFY_SHOP_DOMAIN || "").trim();
  const clientId = String(process.env.SHOPIFY_CLIENT_ID || "").trim();
  const clientSecret = String(process.env.SHOPIFY_CLIENT_SECRET || "").trim();
  const apiVersion = process.env.SHOPIFY_API_VERSION || "2026-07";
  const shop = rawShop.replace(/^https?:\/\//, "").replace(/\/+$/, "").replace(/\.myshopify\.com$/i, "");
  const domain = `${shop}.myshopify.com`;
  return { shop, domain, clientId, clientSecret, apiVersion };
}

function windsorConfig() {
  const boolEnv = (name, fallback) => {
    const raw = String(process.env[name] ?? "").trim().toLowerCase();
    if (!raw) return fallback;
    return !["0", "false", "no", "off"].includes(raw);
  };
  const numberEnv = (name, fallback) => {
    const parsed = Number(process.env[name]);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
  };
  return {
    apiKey: String(process.env.WINDSOR_API_KEY || "").trim(),
    refreshSince: String(process.env.WINDSOR_REFRESH_SINCE || "3d").trim(),
    refreshInterval: String(process.env.WINDSOR_REFRESH_INTERVAL || "6h").trim(),
    autoSync: boolEnv("WINDSOR_AUTO_SYNC", true),
    autoSyncStaleHours: numberEnv("WINDSOR_AUTO_SYNC_STALE_HOURS", 24),
    autoSyncCooldownMinutes: numberEnv("WINDSOR_AUTO_SYNC_COOLDOWN_MINUTES", 60),
    channels: windsorMarketing.configuredChannels(process.env)
  };
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
    const errors = Array.isArray(json.errors) ? json.errors : [];
    const missingShopifyQl = errors.some(error =>
      error?.extensions?.code === "undefinedField" &&
      error?.extensions?.fieldName === "shopifyqlQuery"
    );
    const detail = json.errors ? JSON.stringify(json.errors) : response.statusText;
    const hint = missingShopifyQl
      ? " ShopifyQL reports need a newer Shopify Admin API schema; set SHOPIFY_API_VERSION=2026-07 on the server and restart."
      : "";
    throw new Error(`Shopify API error (${response.status} ${response.statusText}, ${domain}, ${apiVersion}):${hint} ${detail}`);
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

function latestIsoDate(values) {
  let latest = "";
  let latestTime = 0;
  for (const value of values) {
    const time = value ? new Date(value).getTime() : 0;
    if (Number.isFinite(time) && time > latestTime) {
      latestTime = time;
      latest = value;
    }
  }
  return latest;
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
  const featuredMediaImage = product.featuredMedia?.image ? {
    url: product.featuredMedia.image.url,
    altText: product.featuredMedia.image.altText,
    id: product.featuredMedia.id,
    createdAt: product.featuredMedia.createdAt || "",
    updatedAt: product.featuredMedia.updatedAt || ""
  } : null;
  const image = featuredMediaImage || product.featuredImage || product.images.nodes[0] || null;
  const imageUpdatedAt = latestIsoDate([
    featuredMediaImage?.updatedAt,
    featuredMediaImage?.createdAt
  ]);
  const status = product.status || "";
  const productStatusCode = String(product.productStatusMetafield?.value || product.productStatus?.value || "").trim();
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
    productStatusCode,
    title: product.title,
    handle: product.handle,
    onlineStoreUrl: product.onlineStoreUrl || "",
    vendor: product.vendor,
    productType: product.productType,
    tags: product.tags,
    createdAt: product.createdAt || "",
    publishedAt: product.publishedAt || "",
    updatedAt: product.updatedAt || "",
    imageUpdatedAt,
    imageMediaId: featuredMediaImage?.id || "",
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

async function fetchGaDailyMetrics(range) {
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
      dimensions: [{ name: "date" }, { name: "itemId" }, { name: "itemName" }],
      metrics: [
        { name: "itemsViewed" },
        { name: "itemsAddedToCart" },
        { name: "itemsPurchased" },
        { name: "itemRevenue" }
      ],
      limit: "100000"
    })
  });

  if (!response.ok) {
    throw new Error(response.json.error?.message || `Google Analytics API error: ${response.status}`);
  }

  const metrics = (response.json.rows || []).map((row) => {
    const rawDate = row.dimensionValues?.[0]?.value || "";
    const date = /^\d{8}$/.test(rawDate) ? `${rawDate.slice(0, 4)}-${rawDate.slice(4, 6)}-${rawDate.slice(6, 8)}` : "";
    return {
      date,
      itemId: row.dimensionValues?.[1]?.value || "",
      itemName: row.dimensionValues?.[2]?.value || "",
      views: Number(row.metricValues?.[0]?.value || 0),
      adds: Number(row.metricValues?.[1]?.value || 0),
      purchases: Number(row.metricValues?.[2]?.value || 0),
      revenue: Number(row.metricValues?.[3]?.value || 0)
    };
  }).filter(row => row.date);

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

function mapGaDailyMetrics(products, gaRows) {
  const byKey = new Map();
  gaRows.forEach((row, index) => {
    const keys = [row.itemId, row.itemName].map(normalizedKey).filter(Boolean);
    for (const key of keys) {
      const current = byKey.get(key) || [];
      current.push({ index, row });
      byKey.set(key, current);
    }
  });

  const result = new Map();
  for (const product of products || []) {
    const keys = [
      product.id,
      product.legacyResourceId,
      product.handle,
      product.title,
      ...(product.skus || []),
      ...(product.variantIds || [])
    ].map(normalizedKey).filter(Boolean);
    const seen = new Set();
    const byDate = new Map();
    for (const key of keys) {
      const matches = byKey.get(key) || [];
      for (const match of matches) {
        if (seen.has(match.index)) continue;
        seen.add(match.index);
        const metric = byDate.get(match.row.date) || { views: 0, adds: 0, purchases: 0, gaRevenue: 0 };
        metric.views += match.row.views;
        metric.adds += match.row.adds;
        metric.purchases += match.row.purchases;
        metric.gaRevenue += match.row.revenue;
        byDate.set(match.row.date, metric);
      }
    }
    if (byDate.size) result.set(product.id, byDate);
  }
  return result;
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

async function fetchOrderDailyMetrics(range) {
  const metrics = new Map();
  let cursor = null;
  let hasNextPage = true;
  const orderQuery = orderQueryForRange(range);
  const query = `
    query MerchDailyOrders($cursor: String, $query: String!) {
      orders(first: 100, after: $cursor, query: $query, sortKey: CREATED_AT, reverse: true) {
        nodes {
          createdAt
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
      const day = dateOnlyFromIso(order.createdAt);
      if (!day) continue;
      for (const item of order.lineItems.nodes) {
        if (!item.product?.id) continue;
        const byDate = metrics.get(item.product.id) || new Map();
        const current = byDate.get(day) || { revenue: 0, units: 0 };
        current.revenue += Number(item.discountedTotalSet?.shopMoney?.amount || 0);
        current.units += Number(item.quantity || 0);
        byDate.set(day, current);
        metrics.set(item.product.id, byDate);
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
  const updatedSinceDate = dateOnlyFromIso(url.searchParams.get("updatedSince") || "");
  const updatedSinceTime = updatedSinceDate ? new Date(`${updatedSinceDate}T00:00:00.000Z`).getTime() : 0;
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
          onlineStoreUrl
          createdAt
          publishedAt
          updatedAt
          vendor
          productType
          tags
          seasonMetafield: metafield(namespace: "custom", key: "season") { value }
          productStatusMetafield: metafield(namespace: "custom", key: "product_status") { value }
          featuredMedia {
            ... on MediaImage {
              id
              createdAt
              updatedAt
              image { url altText }
            }
          }
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
      const pageProducts = data.products.nodes || [];
      if (updatedSinceTime) {
        let reachedCutoff = false;
        for (const product of pageProducts) {
          const updatedTime = product.updatedAt ? new Date(product.updatedAt).getTime() : 0;
          if (Number.isFinite(updatedTime) && updatedTime >= updatedSinceTime) {
            rawProducts.push(product);
          } else {
            reachedCutoff = true;
          }
        }
        if (reachedCutoff) {
          hasNextPage = false;
          break;
        }
      } else {
        rawProducts.push(...pageProducts);
      }
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

function completedBestsellersStorageWeeks(range, now = new Date()) {
  const today = isoDateOnly(now);
  return canonicalReportWeeks(range).filter(week => week.endDate < today);
}

function hasIncompleteBestsellersStorageWeek(range, now = new Date()) {
  const today = isoDateOnly(now);
  return canonicalReportWeeks(range).some(week => week.endDate >= today);
}

function bestsellersPeriodNeedsRefresh(row) {
  if (!row || row.report_type !== "bestsellers" || row.source_type !== "shopify_api") return false;
  if (!validReportDate(row.start_date) || !validReportDate(row.end_date)) return false;
  const syncedAt = new Date(row.synced_at || row.updated_at || row.created_at || "");
  if (!Number.isFinite(syncedAt.getTime())) return false;
  const completeAfter = reportUtcDate(row.end_date);
  completeAfter.setUTCDate(completeAfter.getUTCDate() + 1);
  return syncedAt < completeAfter;
}

function refreshNeededBestsellersResponse(res, rows) {
  const staleWeeks = rows.map(row => ({
    startDate: row.start_date,
    endDate: row.end_date,
    label: reportDateLabel(row.start_date, row.end_date),
    syncedAt: row.synced_at || ""
  }));
  const labelText = staleWeeks.map(week => week.label).join(", ");
  const plural = staleWeeks.length !== 1;
  sendJson(res, 409, {
    error: `Cached bestsellers week${plural ? "s" : ""} ${labelText} ${plural ? "were" : "was"} saved before the week finished. Sync Shopify to refresh.`,
    code: "BESTSELLERS_CACHE_NEEDS_REFRESH",
    staleWeeks
  });
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
  const needsRefresh = bestsellersPeriodNeedsRefresh(row);
  if (needsRefresh) summary.needsRefresh = true;
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
    needsRefresh,
    cacheStatus: needsRefresh ? "needs_refresh" : "ready",
    summary
  };
}

function readBestsellersPeriods(options = {}) {
  const db = openOrderSqliteDb();
  const periods = db.prepare(`
    SELECT *
    FROM report_periods
    WHERE report_type = 'bestsellers'
    ORDER BY start_date DESC, end_date DESC
    LIMIT 120
  `).all().map(publicReportPeriod);
  return options.includeRefreshNeeded ? periods : periods.filter(period => !period.needsRefresh);
}

function readBestsellersPeriodListing() {
  const allPeriods = readBestsellersPeriods({ includeRefreshNeeded: true });
  return {
    periods: allPeriods.filter(period => !period.needsRefresh),
    refreshNeededPeriods: allPeriods.filter(period => period.needsRefresh)
  };
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
  const weeks = days >= 7 ? completedBestsellersStorageWeeks(range) : [];
  const liveOnly = days < 7 || hasIncompleteBestsellersStorageWeek(range);
  const job = {
    id: crypto.randomUUID(),
    reportType: "bestsellers",
    status: "queued",
    requestedStartDate: range.startDate,
    requestedEndDate: range.endDate,
    totalSteps: liveOnly ? 1 : weeks.length,
    completedSteps: 0,
    message: liveOnly
      ? "Queued live Shopify report. Current or future weeks are not stored until complete."
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
        productStatus: product.productStatusCode || product.status || "",
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
          productStatus: product.productStatusCode || product.status || "",
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
          productStatusMetafield: metafield(namespace: "custom", key: "product_status") { value }
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
  const days = reportDaysInclusive(range);
  const liveOnly = days < 7 || hasIncompleteBestsellersStorageWeek(range);
  if (liveOnly) {
    if (onProgress) onProgress({ status: "running", completedSteps: 0, totalSteps: 1, message: "Fetching live Shopify report without caching incomplete weeks...", currentStartDate: range.startDate, currentEndDate: range.endDate });
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
      message: days < 7
        ? "Ad hoc ranges under 7 days are shown live and not stored."
        : "Current or future weeks are shown live and not stored until the week is complete.",
      ordersAvailable: fetched.ordersAvailable,
      gaAvailable: fetched.gaAvailable,
      gaMessage: fetched.gaMessage,
      ...readBestsellersPeriodListing()
    };
  }
  const weeks = completedBestsellersStorageWeeks(range);
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
    ...readBestsellersPeriodListing()
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
    ...readBestsellersPeriodListing()
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
  if (periodRow && bestsellersPeriodNeedsRefresh(periodRow)) {
    refreshNeededBestsellersResponse(res, [periodRow]);
    return;
  }
  if (!periodRow && sourceType === "shopify_api" && reportDaysInclusive(range) >= 7) {
    const weeks = canonicalReportWeeks(range);
    const periodRows = bestsellersPeriodRowsForRanges(weeks, sourceType);
    const staleRows = periodRows.filter(bestsellersPeriodNeedsRefresh);
    if (staleRows.length) {
      refreshNeededBestsellersResponse(res, staleRows);
      return;
    }
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
            productStatusMetafield: metafield(namespace: "custom", key: "product_status") { value }
            createdAt
            publishedAt
            updatedAt
            featuredMedia {
              ... on MediaImage {
                id
                createdAt
                updatedAt
                image { url altText }
              }
            }
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

function normalizeCollectionMoves(moves) {
  if (!Array.isArray(moves)) return [];
  return moves.map((move, index) => {
    const id = String(move?.id || "").trim();
    const position = Number(move?.newPosition);
    if (!id || !Number.isInteger(position) || position < 0) {
      throw new Error(`Invalid collection move at row ${index + 1}.`);
    }
    return { id, newPosition: String(position) };
  });
}

function applyCollectionMove(order, productId, newPosition) {
  const currentIndex = order.indexOf(productId);
  if (currentIndex === -1) return false;
  const targetIndex = Math.max(0, Math.min(order.length - 1, Number(newPosition)));
  if (currentIndex === targetIndex) return false;
  order.splice(currentIndex, 1);
  order.splice(targetIndex, 0, productId);
  return true;
}

function nextCollectionMoveBatch(currentOrder, targetOrder, limit = 250) {
  const moves = [];
  for (let index = 0; index < targetOrder.length && moves.length < limit; index += 1) {
    const wantedId = targetOrder[index];
    if (currentOrder[index] === wantedId) continue;
    const currentIndex = currentOrder.indexOf(wantedId);
    if (currentIndex === -1) continue;
    applyCollectionMove(currentOrder, wantedId, index);
    moves.push({ id: wantedId, newPosition: String(index) });
  }
  return moves;
}

async function submitCollectionMoveBatches(job, moves) {
  for (let index = 0; index < moves.length; index += 250) {
    const batch = moves.slice(index, index + 250);
    if (!batch.length) continue;
    job.message = `Submitting Shopify reorder batch ${job.batchesSubmitted + 1}...`;
    const shopifyJob = await submitCollectionReorderBatch(job.collectionId, batch);
    job.batchesSubmitted += 1;
    if (shopifyJob?.id) {
      job.shopifyJobs.push(shopifyJob.id);
      job.message = `Waiting for Shopify batch ${job.batchesSubmitted} to finish...`;
      await pollShopifyJob(shopifyJob.id);
    }
    job.processedMoves += batch.length;
    job.batchesCompleted += 1;
    job.message = `Applied ${job.processedMoves.toLocaleString("en-GB")} of ${job.totalMoves.toLocaleString("en-GB")} moves.`;
  }
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

    if (job.requestedMoves?.length) {
      const productSet = new Set(applyState.productIds);
      const seenMoveIds = new Set();
      const currentOrder = [...applyState.productIds];
      const moves = [];
      for (const move of job.requestedMoves) {
        if (!productSet.has(move.id)) {
          throw new Error("A product in the move list is no longer in this Shopify collection. Sync the collection again before applying.");
        }
        if (seenMoveIds.has(move.id)) {
          throw new Error("Move list contains the same product more than once.");
        }
        seenMoveIds.add(move.id);
        const position = Number(move.newPosition);
        if (!Number.isInteger(position) || position < 0 || position >= currentOrder.length) {
          throw new Error("Move list contains a target position outside the live collection.");
        }
        if (applyCollectionMove(currentOrder, move.id, position)) {
          moves.push(move);
        }
      }

      job.totalProducts = applyState.productIds.length;
      job.totalMoves = moves.length;
      if (!moves.length) {
        job.status = "complete";
        job.message = "Shopify collection already matches the requested product moves.";
        job.finishedAt = new Date().toISOString();
        return;
      }

      await submitCollectionMoveBatches(job, moves);
      job.status = "complete";
      job.message = `Applied ${job.totalMoves.toLocaleString("en-GB")} product moves to Shopify.`;
      job.finishedAt = new Date().toISOString();
      recordCollectionReorder(job);
      return;
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
      await submitCollectionMoveBatches(job, moves);
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
  let requestedMoves = [];
  try {
    requestedMoves = normalizeCollectionMoves(body.moves);
  } catch (error) {
    sendJson(res, 400, { message: error.message });
    return;
  }
  const targetProductIds = uniqueIds(body.targetProductIds);
  const confirmText = String(body.confirmText || "").trim().toUpperCase();

  if (!collectionId || (!targetProductIds.length && !requestedMoves.length)) {
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
    requestedMoves,
    strategy: String(body.strategy || "").trim(),
    scope: String(body.scope || "").trim(),
    totalProducts: targetProductIds.length || requestedMoves.length,
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
      document_kind TEXT NOT NULL DEFAULT 'invoice',
      linked_discrepancy_id TEXT,
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

    CREATE TABLE IF NOT EXISTS order_receipt_lines (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL,
      batch_id TEXT NOT NULL,
      line_index INTEGER NOT NULL,
      sku TEXT,
      buying_code TEXT,
      style TEXT,
      expected_quantity REAL DEFAULT 0,
      received_quantity REAL DEFAULT 0,
      damaged_quantity REAL DEFAULT 0,
      accepted_quantity REAL DEFAULT 0,
      short_quantity REAL DEFAULT 0,
      over_quantity REAL DEFAULT 0,
      received_date TEXT,
      notes TEXT,
      actor_name TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(order_id, batch_id, line_index)
    );

    CREATE TABLE IF NOT EXISTS order_discrepancies (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL,
      batch_id TEXT,
      line_index INTEGER,
      receipt_line_id TEXT,
      source_key TEXT,
      discrepancy_type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'Open',
      resolution_type TEXT,
      sku TEXT,
      buying_code TEXT,
      style TEXT,
      quantity REAL DEFAULT 0,
      value_gbp REAL DEFAULT 0,
      currency TEXT,
      linked_invoice_id TEXT,
      notes TEXT,
      actor_name TEXT,
      resolved_at TEXT,
      data TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS order_label_jobs (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL,
      job_number TEXT NOT NULL UNIQUE,
      version INTEGER NOT NULL,
      scope_type TEXT NOT NULL,
      batch_id TEXT,
      status TEXT NOT NULL DEFAULT 'Draft',
      barcode_format TEXT NOT NULL DEFAULT 'Code 128',
      data TEXT NOT NULL,
      created_by TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_order_label_jobs_order ON order_label_jobs(order_id, version DESC);

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

    CREATE TABLE IF NOT EXISTS sale_plans (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'Draft',
      source_type TEXT,
      source_label TEXT,
      created_by TEXT,
      data TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      applied_at TEXT,
      removed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS sale_plan_items (
      id TEXT PRIMARY KEY,
      plan_id TEXT NOT NULL,
      product_key TEXT NOT NULL,
      shopify_product_id TEXT,
      legacy_resource_id TEXT,
      title TEXT NOT NULL,
      handle TEXT,
      sku TEXT,
      product_type TEXT,
      season TEXT,
      image_url TEXT,
      current_price REAL DEFAULT 0,
      original_price REAL DEFAULT 0,
      compare_at_price REAL DEFAULT 0,
      target_price REAL DEFAULT 0,
      discount_percent REAL DEFAULT 0,
      stock REAL DEFAULT 0,
      units REAL DEFAULT 0,
      revenue REAL DEFAULT 0,
      cover_weeks REAL,
      risk_score REAL DEFAULT 0,
      root_sale_collection_id TEXT,
      child_sale_collection_id TEXT,
      status TEXT NOT NULL DEFAULT 'Planned',
      warnings_json TEXT,
      variants_json TEXT,
      metrics_json TEXT,
      data TEXT,
      source_type TEXT,
      source_id TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      applied_at TEXT,
      removed_at TEXT,
      last_error TEXT
    );

    CREATE TABLE IF NOT EXISTS sale_plan_events (
      id TEXT PRIMARY KEY,
      plan_id TEXT,
      item_id TEXT,
      event_type TEXT NOT NULL,
      actor_name TEXT,
      message TEXT NOT NULL,
      data TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS sale_state_ledger (
      id TEXT PRIMARY KEY,
      shopify_product_id TEXT NOT NULL,
      variant_id TEXT NOT NULL,
      sku TEXT,
      product_key TEXT,
      product_title TEXT,
      product_type TEXT,
      season TEXT,
      original_price REAL NOT NULL DEFAULT 0,
      first_sale_price REAL DEFAULT 0,
      current_sale_price REAL DEFAULT 0,
      discount_percent REAL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'Active',
      first_plan_id TEXT,
      first_item_id TEXT,
      last_plan_id TEXT,
      last_item_id TEXT,
      applied_at TEXT,
      removed_at TEXT,
      data TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS sale_markdown_outcomes (
      id TEXT PRIMARY KEY,
      plan_id TEXT,
      item_id TEXT,
      shopify_product_id TEXT,
      product_key TEXT,
      title TEXT,
      product_type TEXT,
      season TEXT,
      discount_percent REAL DEFAULT 0,
      outcome TEXT NOT NULL,
      reason TEXT,
      applied_at TEXT,
      analysis_start_date TEXT,
      analysis_end_date TEXT,
      days_observed REAL DEFAULT 0,
      pre_units REAL DEFAULT 0,
      post_units REAL DEFAULT 0,
      pre_stock REAL DEFAULT 0,
      post_stock REAL DEFAULT 0,
      pre_ga_views REAL DEFAULT 0,
      post_ga_views REAL DEFAULT 0,
      pre_ga_purchases REAL DEFAULT 0,
      post_ga_purchases REAL DEFAULT 0,
      sell_through_lift REAL DEFAULT 0,
      cvr_lift REAL DEFAULT 0,
      stock_reduction REAL DEFAULT 0,
      data TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS sale_analysis_actions (
      id TEXT PRIMARY KEY,
      plan_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      outcome_id TEXT,
      action_type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'Pending',
      priority TEXT NOT NULL DEFAULT 'Medium',
      title TEXT,
      sku TEXT,
      product_type TEXT,
      season TEXT,
      current_price REAL DEFAULT 0,
      original_price REAL DEFAULT 0,
      current_discount_percent REAL DEFAULT 0,
      recommended_discount_percent REAL DEFAULT 0,
      recommended_target_price REAL DEFAULT 0,
      post_stock REAL DEFAULT 0,
      days_observed REAL DEFAULT 0,
      post_ga_views REAL DEFAULT 0,
      views_per_week REAL DEFAULT 0,
      sell_through_lift REAL DEFAULT 0,
      cvr_lift REAL DEFAULT 0,
      reason TEXT,
      source_signature TEXT,
      changed INTEGER NOT NULL DEFAULT 1,
      data TEXT,
      follow_up_plan_id TEXT,
      decided_by TEXT,
      decided_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS pnl_cost_rules (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'Other',
      cost_type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'Active',
      effective_start TEXT,
      effective_end TEXT,
      amount REAL DEFAULT 0,
      rate REAL DEFAULT 0,
      first_item_rate REAL DEFAULT 0,
      additional_item_rate REAL DEFAULT 0,
      notes TEXT,
      data TEXT,
      created_by TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS pnl_marketing_spend (
      id TEXT PRIMARY KEY,
      channel TEXT NOT NULL,
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      amount REAL DEFAULT 0,
      source TEXT NOT NULL DEFAULT 'manual',
      source_key TEXT,
      notes TEXT,
      data TEXT,
      created_by TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS pnl_marketing_spend_actuals (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      connector TEXT NOT NULL,
      channel TEXT NOT NULL,
      spend_date TEXT NOT NULL,
      amount REAL DEFAULT 0,
      attributed_revenue REAL DEFAULT 0,
      attributed_roas REAL DEFAULT 0,
      currency TEXT,
      account_id TEXT,
      account_name TEXT,
      campaign_id TEXT,
      campaign_name TEXT,
      source_row_key TEXT NOT NULL UNIQUE,
      raw_json TEXT,
      synced_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS pnl_windsor_sync_runs (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL DEFAULT 'windsor',
      connector TEXT NOT NULL,
      channel TEXT NOT NULL,
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'manual',
      status TEXT NOT NULL,
      row_count INTEGER DEFAULT 0,
      day_count INTEGER DEFAULT 0,
      amount REAL DEFAULT 0,
      error TEXT,
      created_by TEXT,
      synced_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS email_campaigns (
      id TEXT PRIMARY KEY,
      campaign_code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      objective TEXT NOT NULL DEFAULT 'balanced',
      theme TEXT,
      subject TEXT,
      preheader TEXT,
      status TEXT NOT NULL DEFAULT 'draft',
      source_start_date TEXT,
      source_end_date TEXT,
      klaviyo_campaign_id TEXT,
      klaviyo_template_id TEXT,
      klaviyo_message_id TEXT,
      klaviyo_status TEXT,
      sent_at TEXT,
      created_by_user_id TEXT,
      created_by_name TEXT,
      last_error TEXT,
      data TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS email_campaign_products (
      id TEXT PRIMARY KEY,
      campaign_id TEXT NOT NULL,
      product_key TEXT NOT NULL,
      position INTEGER NOT NULL,
      rationale TEXT,
      score REAL DEFAULT 0,
      tracked_url TEXT,
      snapshot_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(campaign_id, product_key),
      UNIQUE(campaign_id, position)
    );

    CREATE TABLE IF NOT EXISTS email_campaign_metric_snapshots (
      id TEXT PRIMARY KEY,
      campaign_id TEXT NOT NULL,
      source TEXT NOT NULL,
      window_start TEXT,
      window_end TEXT,
      metrics_json TEXT NOT NULL,
      error TEXT,
      fetched_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
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
    CREATE INDEX IF NOT EXISTS idx_order_receipt_lines_order ON order_receipt_lines(order_id, batch_id, line_index);
    CREATE INDEX IF NOT EXISTS idx_order_discrepancies_order ON order_discrepancies(order_id, status, updated_at);
    CREATE INDEX IF NOT EXISTS idx_order_discrepancies_source ON order_discrepancies(source_key, status);
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
    CREATE INDEX IF NOT EXISTS idx_sale_plans_status ON sale_plans(status, updated_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_sale_plan_items_unique ON sale_plan_items(plan_id, product_key);
    CREATE INDEX IF NOT EXISTS idx_sale_plan_items_status ON sale_plan_items(plan_id, status, updated_at);
    CREATE INDEX IF NOT EXISTS idx_sale_plan_items_product ON sale_plan_items(shopify_product_id, sku);
    CREATE INDEX IF NOT EXISTS idx_sale_plan_events_plan ON sale_plan_events(plan_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_sale_plan_events_item ON sale_plan_events(item_id, created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_sale_state_ledger_variant ON sale_state_ledger(shopify_product_id, variant_id);
    CREATE INDEX IF NOT EXISTS idx_sale_state_ledger_product ON sale_state_ledger(shopify_product_id, status, updated_at);
    CREATE INDEX IF NOT EXISTS idx_sale_outcomes_plan ON sale_markdown_outcomes(plan_id, updated_at);
    CREATE INDEX IF NOT EXISTS idx_sale_outcomes_item ON sale_markdown_outcomes(item_id, discount_percent);
    CREATE INDEX IF NOT EXISTS idx_sale_outcomes_learning ON sale_markdown_outcomes(product_type, season, discount_percent, outcome);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_sale_actions_unique ON sale_analysis_actions(plan_id, item_id, action_type);
    CREATE INDEX IF NOT EXISTS idx_sale_actions_plan_status ON sale_analysis_actions(plan_id, status, changed, updated_at);
    CREATE INDEX IF NOT EXISTS idx_sale_actions_type ON sale_analysis_actions(action_type, status, priority);
    CREATE INDEX IF NOT EXISTS idx_pnl_cost_rules_status ON pnl_cost_rules(status, category, updated_at);
    CREATE INDEX IF NOT EXISTS idx_pnl_marketing_spend_dates ON pnl_marketing_spend(start_date, end_date, channel);
    CREATE INDEX IF NOT EXISTS idx_pnl_marketing_actuals_dates ON pnl_marketing_spend_actuals(source, connector, spend_date);
    CREATE INDEX IF NOT EXISTS idx_pnl_windsor_sync_runs_lookup ON pnl_windsor_sync_runs(connector, status, start_date, end_date, synced_at);
    CREATE INDEX IF NOT EXISTS idx_email_campaigns_status ON email_campaigns(status, sent_at, created_at);
    CREATE INDEX IF NOT EXISTS idx_email_campaign_products_campaign ON email_campaign_products(campaign_id, position);
    CREATE INDEX IF NOT EXISTS idx_email_campaign_products_key ON email_campaign_products(product_key, campaign_id);
    CREATE INDEX IF NOT EXISTS idx_email_campaign_metrics_campaign ON email_campaign_metric_snapshots(campaign_id, fetched_at);
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
  if (!invoiceColumns.includes("document_kind")) {
    orderSqliteDb.prepare("ALTER TABLE order_invoices ADD COLUMN document_kind TEXT NOT NULL DEFAULT 'invoice'").run();
  }
  if (!invoiceColumns.includes("linked_discrepancy_id")) {
    orderSqliteDb.prepare("ALTER TABLE order_invoices ADD COLUMN linked_discrepancy_id TEXT").run();
  }
  orderSqliteDb.prepare(`
    UPDATE order_invoices
    SET document_kind = 'credit_note'
    WHERE LOWER(COALESCE(invoice_type, '')) = 'credit note'
  `).run();
  const pnlMarketingColumns = orderSqliteDb.prepare("PRAGMA table_info(pnl_marketing_spend)").all().map(column => column.name);
  if (!pnlMarketingColumns.includes("source")) {
    orderSqliteDb.prepare("ALTER TABLE pnl_marketing_spend ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'").run();
  }
  if (!pnlMarketingColumns.includes("source_key")) {
    orderSqliteDb.prepare("ALTER TABLE pnl_marketing_spend ADD COLUMN source_key TEXT").run();
  }
  orderSqliteDb.prepare("CREATE INDEX IF NOT EXISTS idx_pnl_marketing_spend_source ON pnl_marketing_spend(source, source_key, start_date)").run();
  const pnlMarketingActualColumns = orderSqliteDb.prepare("PRAGMA table_info(pnl_marketing_spend_actuals)").all().map(column => column.name);
  if (!pnlMarketingActualColumns.includes("attributed_revenue")) {
    orderSqliteDb.prepare("ALTER TABLE pnl_marketing_spend_actuals ADD COLUMN attributed_revenue REAL DEFAULT 0").run();
  }
  if (!pnlMarketingActualColumns.includes("attributed_roas")) {
    orderSqliteDb.prepare("ALTER TABLE pnl_marketing_spend_actuals ADD COLUMN attributed_roas REAL DEFAULT 0").run();
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
  orderSqliteDb.prepare(`
    INSERT OR IGNORE INTO app_settings (key, value, updated_at)
    VALUES ('pahCarrier', ?, CURRENT_TIMESTAMP)
  `).run(JSON.stringify(DEFAULT_PAH_SETTINGS));
  orderSqliteDb.prepare(`
    INSERT OR IGNORE INTO app_settings (key, value, updated_at)
    VALUES ('salePlannerCollections', ?, CURRENT_TIMESTAMP)
  `).run(JSON.stringify({ rootSaleCollectionId: "", childCollectionByType: {} }));
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

function readPahSettings() {
  const row = openOrderSqliteDb().prepare("SELECT value FROM app_settings WHERE key = 'pahCarrier'").get();
  return safePahSettings(parseJson(row?.value, DEFAULT_PAH_SETTINGS));
}

function writePahSettings(input) {
  const settings = safePahSettings(input);
  openOrderSqliteDb().prepare(`
    INSERT INTO app_settings (key, value, updated_at)
    VALUES ('pahCarrier', ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
  `).run(JSON.stringify(settings));
  return settings;
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

let skuIssueQueue = Promise.resolve();

async function issueNextAvailableSku() {
  const dbData = readOrderDb();
  let baseline = getLastIssuedSku(dbData);
  const skippedShopifySkus = [];
  const { shop, clientId, clientSecret } = shopifyConfig();
  const shopifyConfigured = Boolean(shop && clientId && clientSecret);

  for (let attempts = 0; attempts < 100000; attempts += 1) {
    const candidate = nextAvailableIssuedSku(readOrderDb(), baseline);
    if (shopifyConfigured) {
      const existingVariant = await shopifyVariantBySku(candidate);
      if (existingVariant?.product?.id && normalizeSku(existingVariant.sku) === normalizeSku(candidate)) {
        reserveIssuedSku(candidate, {
          source: "shopify-existing",
          shopifyProductGid: existingVariant.product.id,
          shopifyVariantGid: existingVariant.id || ""
        });
        writeLastIssuedSkuSetting(candidate);
        skippedShopifySkus.push(candidate);
        baseline = candidate;
        continue;
      }
    }

    setLastIssuedSku(candidate);
    return {
      sku: candidate,
      previousSku: baseline || "",
      shopifyVerified: shopifyConfigured,
      skippedShopifySkus
    };
  }

  throw new Error("Could not find an unused SKU in the configured sequence.");
}

function queueNextAvailableSku() {
  const issuance = skuIssueQueue.then(() => issueNextAvailableSku());
  skuIssueQueue = issuance.catch(() => undefined);
  return issuance;
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

const deliveryReviewStatus = "Review after delivery";
const deliveredOrderIntakeStatuses = new Set([deliveryReviewStatus, "Received"]);

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

function workflowDataForOrder(orderId) {
  const row = openOrderSqliteDb().prepare("SELECT data FROM order_workflows WHERE order_id = ?").get(String(orderId || ""));
  return parseJson(row?.data, {});
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
  if (normalized === deliveryReviewStatus.toLowerCase()) {
    return { intakeStatus: deliveryReviewStatus, intakeActualDate: currentWorkflow.intakeActualDate || todayIsoDate(), nextActionOwner: "Merchandising", nextAction: "Review delivery before archive" };
  }
  if (normalized === "received") {
    return { intakeStatus: "Received", intakeActualDate: currentWorkflow.intakeActualDate || todayIsoDate(), nextActionOwner: "Merchandising", nextAction: "Archive completed order" };
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
    if (["In production", "Part shipped", "Shipped", "Part received", deliveryReviewStatus, "Received"].includes(workflow.intakeStatus)) return workflow.intakeStatus;
  }
  return "";
}

function orderStatusFromWorkflow(workflow) {
  if (!workflow) return "";
  if (workflow.intakeStatus === deliveryReviewStatus) return deliveryReviewStatus;
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

function nextActionForWorkflow(order, workflow, supplierCredits = null) {
  const approvalStatus = workflow?.approvalStatus || "Not requested";
  const paymentStatus = workflow?.paymentStatus || "Not due";
  const intakeStatus = workflow?.intakeStatus || "Not confirmed";
  if (String(order?.status || "").toLowerCase() === "cancelled") return { nextActionOwner: "Buyer", nextAction: "Review cancelled order" };
  if (approvalStatus === "Pending director approval") return { nextActionOwner: "Buying Director", nextAction: "Review order for approval" };
  if (approvalStatus === "Changes requested") return { nextActionOwner: "Buyer", nextAction: "Update order and resubmit" };
  if (approvalStatus === "Rejected") return { nextActionOwner: "Buyer", nextAction: "Review rejected order" };
  if (approvalStatus !== "Approved") return { nextActionOwner: "Buyer", nextAction: "Prepare or submit order" };
  const supplierCreditDue = Number(supplierCreditSummary(order?.supplier?.name || order?.supplierName, supplierCredits).creditDueGbp || 0);
  if (paymentStatus === "Awaiting invoice") return supplierCreditDue > 0
    ? { nextActionOwner: "FD / Finance", nextAction: "Apply supplier credit to next invoice" }
    : { nextActionOwner: "Buyer", nextAction: "Awaiting supplier invoice" };
  if (paymentStatus === "Ready to pay") return supplierCreditDue > 0
    ? { nextActionOwner: "FD / Finance", nextAction: "Apply supplier credit to next invoice" }
    : { nextActionOwner: "FD / Finance", nextAction: "Pay supplier invoice" };
  if (paymentStatus === "Part paid") return supplierCreditDue > 0
    ? { nextActionOwner: "FD / Finance", nextAction: "Apply supplier credit to next invoice" }
    : { nextActionOwner: "Buyer", nextAction: "Awaiting next supplier invoice" };
  if (paymentStatus === "Overdue") return supplierCreditDue > 0
    ? { nextActionOwner: "FD / Finance", nextAction: "Apply supplier credit to next invoice" }
    : { nextActionOwner: "FD / Finance", nextAction: "Resolve overdue supplier payment" };
  if (paymentStatus !== "Paid") return { nextActionOwner: "Buyer", nextAction: "Confirm invoice and payment plan" };
  if (intakeStatus === "Not confirmed" && !orderProductCompletion(order).complete) {
    return { nextActionOwner: "Buyer", nextAction: productCompletionNextAction };
  }
  if (intakeStatus === deliveryReviewStatus) return { nextActionOwner: "Merchandising", nextAction: "Review delivery before archive" };
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
  const paymentAmount = orderTotalGbp(order);
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
  if (workflow.intakeStatus === deliveryReviewStatus) return deliveryReviewStatus;
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

function workflowWithProductCompletionGate(order, workflow, completion, supplierCredits = null) {
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
    const next = nextActionForWorkflow(order, workflow, supplierCredits);
    return { ...workflow, ...next, nextActionUserId: "" };
  }
  return workflow;
}

function workflowWithInvoicePaymentState(order, workflow, totals) {
  if (!totals?.count || !invoiceSummaryIsFullyPaid(totals) || workflow.paymentStatus === "Paid") return workflow;
  const next = nextActionForWorkflow(order, { ...workflow, paymentStatus: "Paid" });
  return {
    ...workflow,
    paymentStatus: "Paid",
    paymentAmount: totals.orderTotal || totals.totalDue,
    nextActionOwner: next.nextActionOwner,
    nextAction: next.nextAction
  };
}

function publicManagedOrder(order, workflowRow, productMap = null, supplierCredits = null) {
  const baseWorkflow = workflowFromRow(workflowRow, order);
  const lines = order.lines || [];
  const units = lines.reduce((total, line) => total + Number(line.quantity || 0), 0);
  const categories = [...new Set(lines.map(line => line.category).filter(Boolean))];
  const fxRate = Number(order.fxRate || order.totals?.fxRate || 0);
  const total = orderTotalGbp(order);
  const productCompletion = orderProductCompletion(order, productMap);
  const invoices = invoiceSummary(order);
  const paymentWorkflow = workflowWithInvoicePaymentState(order, baseWorkflow, invoices);
  const workflow = workflowWithProductCompletionGate(order, paymentWorkflow, productCompletion, supplierCredits);
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
    invoices,
    supplierCredit: supplierCreditSummary(order.supplier?.name || order.supplierName, supplierCredits),
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
  return !order?.archivedAt && ["received", "cancelled", "rejected"].includes(status);
}

function orderWorkflowMetrics(orders) {
  const today = todayIsoDate();
  return {
    totalOrders: orders.length,
    awaitingApproval: orders.filter(order => order.workflow.approvalStatus === "Pending director approval").length,
    readyToPay: orders.filter(order => ["Ready to pay", "Overdue"].includes(order.workflow.paymentStatus) || (order.workflow.paymentStatus === "Part paid" && order.workflow.nextActionOwner === "FD / Finance")).length,
    intakeRisk: orders.filter(order => order.workflow.intakeStatus === "Delayed" || (order.workflow.intakeEtaDate && order.workflow.intakeEtaDate < today && !deliveredOrderIntakeStatuses.has(order.workflow.intakeStatus))).length,
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
    if (deliveredOrderIntakeStatuses.has(row.workflow?.intakeStatus)) return { dated: [], undated: null };
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

function orderReportSummaryRow(managedOrder, workflow, batches, batchLines, invoices, receiptLines = [], discrepancies = []) {
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
  const batchSummaryData = managedOrder.batchSummary || {};
  const actuals = {
    expectedQuantity: Number(batchSummaryData.expectedUnits || managedOrder.units || 0),
    receivedQuantity: Number(batchSummaryData.receivedUnits || 0),
    acceptedQuantity: Number(batchSummaryData.acceptedUnits || 0),
    damagedQuantity: Number(batchSummaryData.damagedUnits || 0),
    shortQuantity: Number(batchSummaryData.shortUnits || 0),
    overQuantity: Number(batchSummaryData.overUnits || 0),
    fillRate: Number(batchSummaryData.fillRate || 0),
    receiptLineCount: receiptLines.length
  };
  const discrepancySummary = orderActuals.summarizeDiscrepancies(discrepancies);
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
      ...batchSummaryData,
      batchedUnits,
      unbatchedUnits,
      batchesWithoutLines,
      nextBatchEta
    },
    actuals,
    discrepancies: discrepancySummary,
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
  const supplierCredits = supplierCreditSummaries();
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
    const managedOrder = publicManagedOrder(syncedOrder, workflowRow, products, supplierCredits);
    if (!includeArchived && managedOrder.archivedAt) continue;
    const workflow = managedOrder.workflow || workflowFromRow(workflowRow, syncedOrder);
    const batches = readOrderBatches(managedOrder.id);
    const batchLines = readOrderBatchLines(managedOrder.id);
    const invoices = readOrderInvoices(managedOrder.id, false);
    const receiptLines = readOrderReceiptLines(managedOrder.id);
    const discrepancies = readOrderDiscrepancies(managedOrder.id);
    const row = orderReportSummaryRow(managedOrder, workflow, batches, batchLines, invoices, receiptLines, discrepancies);
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
    if (row.arrivalDate && row.arrivalDate < today && !deliveredOrderIntakeStatuses.has(workflow.intakeStatus)) exceptionReasons.push("Overdue ETA");
    if (["Shipped", "Part shipped"].includes(workflow.intakeStatus) && !row.arrivalDate) exceptionReasons.push("Shipped with no ETA");
    if (workflow.intakeStatus === "In production" && !row.arrivalDate) exceptionReasons.push("In production with no ETA");
    if (row.batches.outstandingUnits > 0 && deliveredOrderIntakeStatuses.has(workflow.intakeStatus)) exceptionReasons.push("Delivered status with outstanding units");
    if (row.discrepancies.openCount > 0) exceptionReasons.push("Open receipt discrepancy");
    if (exceptionReasons.length) exceptions.push({ ...row, reason: exceptionReasons.join(", ") });

    const actionReason = [];
    if (workflow.approvalStatus === "Pending director approval") actionReason.push("Approval waiting");
    if (["Ready to pay", "Overdue"].includes(workflow.paymentStatus)) actionReason.push("Finance waiting");
    if (workflow.paymentStatus === "Part paid") actionReason.push("Part paid");
    if (["Confirmed", "In production", "Part shipped", "Shipped", "Delayed", "Part received", deliveryReviewStatus].includes(workflow.intakeStatus)) actionReason.push("Intake follow-up");
    if (row.discrepancies.openCount > 0) actionReason.push("Receipt discrepancy");
    if (row.discrepancies.creditDueGbp > 0) actionReason.push("Credit note due");
    if (!row.productCompletion?.complete) actionReason.push("Product completion block");
    if (!workflow.nextActionOwner) actionReason.push("Unassigned next action");
    nextActions.push({ ...row, reason: actionReason.join(", ") || "Next action" });

    if (row.invoices.count || row.totalGbp || row.invoices.outstanding || ["Ready to pay", "Part paid", "Overdue"].includes(workflow.paymentStatus)) {
      financeRows.push(row);
    }

    const qualityReasons = [];
    if (!row.arrivalDate && !deliveredOrderIntakeStatuses.has(workflow.intakeStatus)) qualityReasons.push("Missing ETA");
    if (!row.supplierReference) qualityReasons.push("Missing supplier reference");
    if (String(row.currency || "").toUpperCase() === "EUR" && !Number(savedOrder.fxRate || savedOrder.totals?.fxRate || 0)) qualityReasons.push("Missing FX rate");
    if (!row.productCompletion?.complete) qualityReasons.push("Missing product links");
    if (row.batches.count > 0 && row.batches.unbatchedUnits > 0) qualityReasons.push("Unbatched units");
    if (row.batches.count > 0 && row.invoices.invoiceWithoutBatch > 0) qualityReasons.push("Invoice without batch");
    if (row.batches.batchesWithoutLines > 0) qualityReasons.push("Batch without line allocations");
    const receiptBatchIds = new Set(receiptLines.map(line => line.batchId));
    if (batches.some(batch => batch.intakeStatus === "Received" && !receiptBatchIds.has(batch.id))) qualityReasons.push("Received batch without actuals");
    if (invoices.some(invoice => invoice.documentKind === "credit_note" && !invoice.linkedDiscrepancyId)) qualityReasons.push("Credit note without discrepancy");
    if (discrepancies.some(item => !terminalDiscrepancyStatuses.has(item.status) && !item.resolutionType)) qualityReasons.push("Open discrepancy without resolution");
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
    total.outstandingInvoicedGbp += Number(order.invoices.outstandingInvoiced || 0);
    total.uninvoicedBalanceGbp += Number(order.invoices.uninvoicedBalance || 0);
    total.outstandingGbp += Number(order.invoices.outstanding || 0);
    total.acceptedUnits += Number(order.actuals.acceptedQuantity || 0);
    total.shortUnits += Number(order.actuals.shortQuantity || 0);
    total.damagedUnits += Number(order.actuals.damagedQuantity || 0);
    total.openDiscrepancies += Number(order.discrepancies.openCount || 0);
    total.openCreditValueGbp += Number(order.discrepancies.creditDueGbp || 0);
    total.creditReceivedGbp += Number(order.discrepancies.creditReceivedGbp || 0);
    total.exceptionOrders = exceptions.length;
    total.nextActionOrders = nextActions.length;
    total.dataQualityOrders = dataQuality.length;
    return total;
  }, { orders: 0, units: 0, arrivalUnits: 0, orderValueGbp: 0, invoicedGbp: 0, paidGbp: 0, outstandingInvoicedGbp: 0, uninvoicedBalanceGbp: 0, outstandingGbp: 0, acceptedUnits: 0, shortUnits: 0, damagedUnits: 0, openDiscrepancies: 0, openCreditValueGbp: 0, creditReceivedGbp: 0, exceptionOrders: 0, nextActionOrders: 0, dataQualityOrders: 0 });
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
      supplierPerformance: orderActuals.summarizeSupplierPerformance(orders),
      grouped: {
        owners: sortedReportGroups(ownerGroups, "orders"),
        paymentStatuses: sortedReportGroups(paymentGroups, "orders"),
        intakeStatuses: sortedReportGroups(intakeGroups, "orders")
      },
      orders
    }
  };
}

function supplierReportKey(value) {
  return cleanText(value).toLowerCase();
}

function supplierReportNameForOrder(order = {}) {
  return cleanText(order.supplier?.name || order.supplierName) || "No supplier";
}

function supplierReportBatchLabel(batch = {}) {
  return [batch.batchNumber, batch.title].map(cleanText).filter(Boolean).join(" / ") || "Full order";
}

function summarizeSupplierReportReceiptLines(lines = []) {
  return (lines || []).reduce((sum, line) => {
    sum.expectedQuantity += Number(line.expectedQuantity || 0);
    sum.receivedQuantity += Number(line.receivedQuantity || 0);
    sum.damagedQuantity += Number(line.damagedQuantity || 0);
    sum.acceptedQuantity += Number(line.acceptedQuantity || 0);
    sum.shortQuantity += Number(line.shortQuantity || 0);
    sum.overQuantity += Number(line.overQuantity || 0);
    if (line.notes) sum.notes.push(line.notes);
    if (line.receivedDate && (!sum.receivedDate || line.receivedDate > sum.receivedDate)) sum.receivedDate = line.receivedDate;
    if (line.updatedAt && (!sum.updatedAt || line.updatedAt > sum.updatedAt)) sum.updatedAt = line.updatedAt;
    return sum;
  }, {
    expectedQuantity: 0,
    receivedQuantity: 0,
    damagedQuantity: 0,
    acceptedQuantity: 0,
    shortQuantity: 0,
    overQuantity: 0,
    receivedDate: "",
    updatedAt: "",
    notes: []
  });
}

function emptySupplierReportMetrics() {
  return {
    orders: 0,
    openOrders: 0,
    products: 0,
    units: 0,
    orderValueGbp: 0,
    outstandingGbp: 0,
    orderedUnits: 0,
    receivedUnits: 0,
    acceptedUnits: 0,
    damagedUnits: 0,
    shortUnits: 0,
    overUnits: 0,
    fillRate: 0,
    batches: 0,
    openBatches: 0,
    lateBatches: 0,
    unbatchedUnits: 0,
    receiptRows: 0,
    openDiscrepancies: 0,
    openCreditValueGbp: 0,
    creditReceivedGbp: 0
  };
}

function buildSupplierReport(params = {}) {
  const includeArchived = params.includeArchived === true || params.includeArchived === "true" || params.includeArchived === "1";
  const dbData = readOrderDb();
  const workflows = readOrderWorkflowMap();
  const productLookup = catalogProductMap();
  const supplierCredits = supplierCreditSummaries();
  const catalogProducts = readCatalogProducts({ includeArchived: true });
  const catalogSuppliers = readCatalogSuppliers();
  const supplierMap = new Map();

  const ensureSupplier = (name, patch = {}) => {
    const supplierName = cleanText(name) || "No supplier";
    const key = supplierReportKey(supplierName);
    if (!supplierMap.has(key)) {
      supplierMap.set(key, {
        key,
        id: "",
        name: supplierName,
        reference: "",
        status: "",
        country: "",
        currency: "",
        contact: "",
        email: "",
        phone: "",
        productCount: 0,
        orderCount: 0,
        units: 0,
        lastOrderDate: "",
        creditDueGbp: 0,
        ...patch
      });
    } else {
      supplierMap.set(key, { ...supplierMap.get(key), ...patch, key, name: supplierName });
    }
    return supplierMap.get(key);
  };

  for (const supplier of catalogSuppliers) {
    const summary = supplier.creditBalance || emptySupplierCreditSummary(supplier.name);
    ensureSupplier(supplier.name, {
      id: supplier.id,
      reference: supplier.reference || "",
      status: supplier.status || "",
      country: supplier.country || "",
      currency: supplier.currency || "",
      contact: supplier.contact || "",
      email: supplier.email || "",
      phone: supplier.phone || "",
      creditDueGbp: Number(summary.creditDueGbp || 0)
    });
  }

  for (const product of catalogProducts) {
    if (!includeArchived && product.status === "Archived") continue;
    const supplier = ensureSupplier(product.supplierName);
    supplier.productCount += 1;
  }

  for (const order of dbData.orders || []) {
    if (!includeArchived && order.archivedAt) continue;
    const supplier = ensureSupplier(supplierReportNameForOrder(order));
    const units = (order.lines || []).reduce((sum, line) => sum + Number(line.quantity || 0), 0);
    supplier.orderCount += 1;
    supplier.units += units;
    const orderDate = order.orderDate || order.savedAt || "";
    if (orderDate && (!supplier.lastOrderDate || orderDate > supplier.lastOrderDate)) supplier.lastOrderDate = orderDate;
  }

  const supplierId = cleanText(params.supplierId);
  const requestedName = cleanText(params.supplierName || params.supplier || params.name);
  const supplierOptions = [...supplierMap.values()].sort((a, b) => String(a.name).localeCompare(String(b.name), "en-GB", { sensitivity: "base" }));
  let selectedKey = requestedName ? supplierReportKey(requestedName) : "";
  if (supplierId) {
    const match = supplierOptions.find(supplier => String(supplier.id) === supplierId);
    selectedKey = match?.key || selectedKey;
  }
  if (!selectedKey && supplierOptions.length) selectedKey = supplierOptions[0].key;
  if (requestedName && !supplierMap.has(selectedKey)) ensureSupplier(requestedName);

  const selectedOption = supplierMap.get(selectedKey) || null;
  const selectedSupplierFull = selectedOption
    ? catalogSuppliers.find(supplier => supplierReportKey(supplier.name) === selectedKey)
    : null;
  const selectedSupplier = selectedOption ? {
    id: selectedSupplierFull?.id || selectedOption.id || "",
    name: selectedSupplierFull?.name || selectedOption.name,
    reference: selectedSupplierFull?.reference || selectedOption.reference || "",
    status: selectedSupplierFull?.status || selectedOption.status || "",
    contact: selectedSupplierFull?.contact || selectedOption.contact || "",
    email: selectedSupplierFull?.email || selectedOption.email || "",
    phone: selectedSupplierFull?.phone || selectedOption.phone || "",
    city: selectedSupplierFull?.city || "",
    country: selectedSupplierFull?.country || selectedOption.country || "",
    currency: selectedSupplierFull?.currency || selectedOption.currency || "",
    incoterms: selectedSupplierFull?.incoterms || "",
    leadTimeDays: Number(selectedSupplierFull?.leadTimeDays || 0),
    moq: Number(selectedSupplierFull?.moq || 0),
    creditBalance: supplierCreditSummary(selectedSupplierFull?.name || selectedOption.name, supplierCredits)
  } : null;

  const orders = [];
  const productsByKey = new Map();
  const discrepancies = [];
  const receiptRows = [];
  const orderRowsById = new Map();

  const upsertProductRow = (key, patch = {}, orderRef = null) => {
    const id = key || patch.sku || patch.buyingCode || patch.title || patch.style || crypto.randomUUID();
    const current = productsByKey.get(id) || {
      id: patch.id || "",
      rowKey: id,
      sku: patch.sku || "",
      buyingCode: patch.buyingCode || patch.supplierSku || "",
      title: patch.title || patch.style || "",
      style: patch.style || patch.title || "",
      productType: patch.productType || patch.category || "",
      season: patch.season || "",
      colour: patch.colour || patch.color || "",
      size: patch.size || patch.optionValue || "",
      unitCostGbp: Number(patch.unitCostGbp || patch.unitCost || 0),
      rrp: Number(patch.rrp || 0),
      imageUrl: patch.imageUrl || "",
      status: patch.status || "Order line",
      syncStatus: patch.syncStatus || "",
      readiness: patch.readiness || null,
      lastOrderNumber: patch.lastOrderNumber || "",
      lastOrderedAt: patch.lastOrderedAt || "",
      orderedUnits: 0,
      orderCount: 0,
      openOrderCount: 0,
      lastOrderDate: "",
      orderRefs: []
    };
    const merged = { ...current };
    for (const [field, value] of Object.entries(patch)) {
      if (value !== undefined && value !== null && value !== "" && (merged[field] === "" || merged[field] === null || merged[field] === undefined)) {
        merged[field] = value;
      }
    }
    if (orderRef) {
      merged.orderedUnits += Number(orderRef.quantity || 0);
      if (!merged.orderRefs.some(ref => String(ref.orderId) === String(orderRef.orderId))) {
        merged.orderRefs.push(orderRef);
        merged.orderCount += 1;
        if (!deliveredOrderIntakeStatuses.has(orderRef.intakeStatus)) merged.openOrderCount += 1;
      }
      if (orderRef.orderDate && (!merged.lastOrderDate || orderRef.orderDate > merged.lastOrderDate)) merged.lastOrderDate = orderRef.orderDate;
      merged.lastOrderNumber = merged.lastOrderNumber || orderRef.orderNumber || "";
      merged.lastOrderedAt = merged.lastOrderedAt || orderRef.orderDate || "";
    }
    productsByKey.set(id, merged);
  };

  for (const product of catalogProducts) {
    if (!selectedKey || supplierReportKey(product.supplierName) !== selectedKey) continue;
    if (!includeArchived && product.status === "Archived") continue;
    const key = normalizeSku(product.sku) || `product:${product.id}`;
    upsertProductRow(key, product);
  }

  for (const savedOrder of dbData.orders || []) {
    if (!includeArchived && savedOrder.archivedAt) continue;
    if (!selectedKey || supplierReportKey(supplierReportNameForOrder(savedOrder)) !== selectedKey) continue;

    const workflowRow = workflows.get(String(savedOrder.id));
    const syncedOrder = syncOrderStatusFromWorkflowRow(savedOrder, workflowRow);
    const managedOrder = publicManagedOrder(syncedOrder, workflowRow, productLookup, supplierCredits);
    const workflow = managedOrder.workflow || workflowFromRow(workflowRow, syncedOrder);
    const batches = readOrderBatches(managedOrder.id);
    const batchLines = readOrderBatchLines(managedOrder.id);
    const invoices = readOrderInvoices(managedOrder.id, false);
    const receiptLines = readOrderReceiptLines(managedOrder.id);
    const orderDiscrepancies = readOrderDiscrepancies(managedOrder.id);
    const reportRow = orderReportSummaryRow(managedOrder, workflow, batches, batchLines, invoices, receiptLines, orderDiscrepancies);
    orders.push(reportRow);
    orderRowsById.set(String(reportRow.id), reportRow);

    for (const [lineIndex, line] of (syncedOrder.lines || []).entries()) {
      const sku = normalizeSku(line.sku);
      const master = sku ? productLookup.get(sku) : null;
      const key = sku || `order-line:${syncedOrder.id}:${lineIndex}`;
      upsertProductRow(key, { ...(master || {}), ...line, sku: sku || line.sku || "" }, {
        orderId: reportRow.id,
        orderNumber: reportRow.orderNumber,
        orderDate: reportRow.orderDate || reportRow.savedAt || "",
        intakeStatus: reportRow.workflow?.intakeStatus || "",
        quantity: Number(line.quantity || 0),
        openUrl: reportRow.openUrl
      });
    }

    const batchMap = new Map(batches.map(batch => [String(batch.id), batch]));
    const invoiceMap = new Map(invoices.map(invoice => [String(invoice.id), invoice]));
    const receiptMap = new Map();
    for (const receipt of receiptLines) {
      const key = `${receipt.batchId}:${receipt.lineIndex}`;
      if (!receiptMap.has(key)) receiptMap.set(key, []);
      receiptMap.get(key).push(receipt);
    }
    const usedReceiptKeys = new Set();

    for (const item of orderDiscrepancies) {
      const invoice = invoiceMap.get(String(item.linkedInvoiceId)) || {};
      const batch = batchMap.get(String(item.batchId)) || {};
      discrepancies.push({
        ...item,
        orderNumber: reportRow.orderNumber,
        supplierName: reportRow.supplierName,
        batchLabel: item.batchId ? supplierReportBatchLabel(batch) : "Full order",
        linkedInvoiceNumber: invoice.invoiceNumber || "",
        isOpen: !terminalDiscrepancyStatuses.has(item.status),
        openUrl: reportRow.openUrl
      });
    }

    for (const batch of batches) {
      const lines = batchLines.filter(line => String(line.batchId) === String(batch.id));
      if (!lines.length) {
        receiptRows.push({
          orderId: reportRow.id,
          orderNumber: reportRow.orderNumber,
          supplierName: reportRow.supplierName,
          batchId: batch.id,
          batchLabel: supplierReportBatchLabel(batch),
          batchStatus: batch.intakeStatus,
          etaDate: batch.etaDate,
          shippedDate: batch.shippedDate,
          receivedDate: batch.receivedDate,
          lineIndex: null,
          sku: "",
          buyingCode: "",
          style: "",
          expectedQuantity: Number(batch.units || 0),
          allocatedQuantity: Number(batch.units || 0),
          receivedQuantity: batch.intakeStatus === "Received" ? Number(batch.units || 0) : 0,
          damagedQuantity: 0,
          acceptedQuantity: batch.intakeStatus === "Received" ? Number(batch.units || 0) : 0,
          shortQuantity: 0,
          overQuantity: 0,
          notes: batch.notes || "",
          openUrl: reportRow.openUrl
        });
        continue;
      }
      for (const line of lines) {
        const key = `${line.batchId}:${line.lineIndex}`;
        const receipts = receiptMap.get(key) || [];
        const totals = summarizeSupplierReportReceiptLines(receipts);
        usedReceiptKeys.add(key);
        receiptRows.push({
          orderId: reportRow.id,
          orderNumber: reportRow.orderNumber,
          supplierName: reportRow.supplierName,
          batchId: batch.id,
          batchLabel: supplierReportBatchLabel(batch),
          batchStatus: batch.intakeStatus,
          etaDate: batch.etaDate,
          shippedDate: batch.shippedDate,
          receivedDate: totals.receivedDate || batch.receivedDate || "",
          lineIndex: line.lineIndex,
          sku: line.sku || "",
          buyingCode: line.buyingCode || "",
          style: line.style || "",
          expectedQuantity: Number(totals.expectedQuantity || line.quantity || 0),
          allocatedQuantity: Number(line.quantity || 0),
          receivedQuantity: Number(totals.receivedQuantity || 0),
          damagedQuantity: Number(totals.damagedQuantity || 0),
          acceptedQuantity: Number(totals.acceptedQuantity || 0),
          shortQuantity: Number(totals.shortQuantity || 0),
          overQuantity: Number(totals.overQuantity || 0),
          notes: [...new Set(totals.notes.filter(Boolean))].join("; "),
          updatedAt: totals.updatedAt,
          openUrl: reportRow.openUrl
        });
      }
    }

    for (const [key, receipts] of receiptMap.entries()) {
      if (usedReceiptKeys.has(key)) continue;
      const receipt = receipts[0] || {};
      const totals = summarizeSupplierReportReceiptLines(receipts);
      const batch = batchMap.get(String(receipt.batchId)) || {};
      receiptRows.push({
        orderId: reportRow.id,
        orderNumber: reportRow.orderNumber,
        supplierName: reportRow.supplierName,
        batchId: receipt.batchId || "",
        batchLabel: receipt.batchId ? supplierReportBatchLabel(batch) : "Full order",
        batchStatus: batch.intakeStatus || "",
        etaDate: batch.etaDate || "",
        shippedDate: batch.shippedDate || "",
        receivedDate: totals.receivedDate || receipt.receivedDate || "",
        lineIndex: receipt.lineIndex,
        sku: receipt.sku || "",
        buyingCode: receipt.buyingCode || "",
        style: receipt.style || "",
        expectedQuantity: Number(totals.expectedQuantity || 0),
        allocatedQuantity: 0,
        receivedQuantity: Number(totals.receivedQuantity || 0),
        damagedQuantity: Number(totals.damagedQuantity || 0),
        acceptedQuantity: Number(totals.acceptedQuantity || 0),
        shortQuantity: Number(totals.shortQuantity || 0),
        overQuantity: Number(totals.overQuantity || 0),
        notes: [...new Set(totals.notes.filter(Boolean))].join("; "),
        updatedAt: totals.updatedAt,
        openUrl: reportRow.openUrl
      });
    }
  }

  orders.sort((a, b) => String(b.orderDate || b.savedAt || "").localeCompare(String(a.orderDate || a.savedAt || "")) || String(a.orderNumber).localeCompare(String(b.orderNumber)));
  discrepancies.sort((a, b) => Number(b.isOpen) - Number(a.isOpen) || String(b.updatedAt || b.createdAt || "").localeCompare(String(a.updatedAt || a.createdAt || "")));
  receiptRows.sort((a, b) => String(a.etaDate || "9999-99-99").localeCompare(String(b.etaDate || "9999-99-99")) || String(a.orderNumber).localeCompare(String(b.orderNumber)) || String(a.batchLabel).localeCompare(String(b.batchLabel)));

  const products = [...productsByKey.values()].sort((a, b) => Number(b.orderedUnits || 0) - Number(a.orderedUnits || 0) || String(a.sku || a.buyingCode || a.title).localeCompare(String(b.sku || b.buyingCode || b.title)));
  const performance = orderActuals.summarizeSupplierPerformance(orders)[0] || {};
  const metrics = {
    ...emptySupplierReportMetrics(),
    orders: orders.length,
    openOrders: orders.filter(order => !deliveredOrderIntakeStatuses.has(order.workflow?.intakeStatus)).length,
    products: products.length,
    units: orders.reduce((sum, order) => sum + Number(order.units || 0), 0),
    orderValueGbp: orders.reduce((sum, order) => sum + Number(order.totalGbp || 0), 0),
    outstandingGbp: orders.reduce((sum, order) => sum + Number(order.invoices?.outstanding || 0), 0),
    orderedUnits: Number(performance.orderedUnits || 0),
    receivedUnits: Number(performance.receivedUnits || 0),
    acceptedUnits: Number(performance.acceptedUnits || 0),
    damagedUnits: Number(performance.damagedUnits || 0),
    shortUnits: Number(performance.shortUnits || 0),
    overUnits: Number(performance.overUnits || 0),
    fillRate: Number(performance.fillRate || 0),
    batches: orders.reduce((sum, order) => sum + Number(order.batches?.count || 0), 0),
    openBatches: Number(performance.openBatches || 0),
    lateBatches: Number(performance.lateBatches || 0),
    unbatchedUnits: orders.reduce((sum, order) => sum + Number(order.batches?.unbatchedUnits || 0), 0),
    receiptRows: receiptRows.length,
    openDiscrepancies: discrepancies.filter(item => item.isOpen).length,
    openCreditValueGbp: Number(performance.openCreditValueGbp || 0),
    creditReceivedGbp: Number(performance.creditReceivedGbp || 0)
  };

  return {
    generatedAt: new Date().toISOString(),
    includeArchived,
    selectedSupplier,
    suppliers: [...supplierMap.values()].sort((a, b) => String(a.name).localeCompare(String(b.name), "en-GB", { sensitivity: "base" })),
    metrics,
    reports: {
      orders,
      products,
      discrepancies,
      receipts: receiptRows
    },
    linkedOrderIds: [...orderRowsById.keys()]
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
  if (patch && typeof patch.data === "object" && patch.data) {
    clean.data = { ...(current.data || {}), ...patch.data };
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
  if (archived && !canArchiveOrder(order)) throw new Error("Move the order to Received after delivery review before archiving.");
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
    db.prepare("DELETE FROM order_discrepancies WHERE order_id = ?").run(String(orderId));
    db.prepare("DELETE FROM order_receipt_lines WHERE order_id = ?").run(String(orderId));
    db.prepare("DELETE FROM order_batch_lines WHERE order_id = ?").run(String(orderId));
    db.prepare("DELETE FROM order_batches WHERE order_id = ?").run(String(orderId));
    db.prepare("DELETE FROM order_label_jobs WHERE order_id = ?").run(String(orderId));
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

const discrepancyStatuses = ["Open", "Credit requested", "Credit received", "Replacement expected", "Replacement received", "Accepted variance", "Written off", "Resolved"];
const discrepancyResolutionTypes = ["", "credit_note", "replacement", "accepted_variance", "write_off", "corrected_receipt"];
const terminalDiscrepancyStatuses = new Set(["Credit received", "Replacement received", "Accepted variance", "Written off", "Resolved"]);

function receiptLineFromRow(row) {
  return {
    id: row.id,
    orderId: row.order_id,
    batchId: row.batch_id,
    lineIndex: Number(row.line_index || 0),
    sku: row.sku || "",
    buyingCode: row.buying_code || "",
    style: row.style || "",
    expectedQuantity: Number(row.expected_quantity || 0),
    receivedQuantity: Number(row.received_quantity || 0),
    damagedQuantity: Number(row.damaged_quantity || 0),
    acceptedQuantity: Number(row.accepted_quantity || 0),
    shortQuantity: Number(row.short_quantity || 0),
    overQuantity: Number(row.over_quantity || 0),
    receivedDate: row.received_date || "",
    notes: row.notes || "",
    actorName: row.actor_name || "",
    createdAt: row.created_at || "",
    updatedAt: row.updated_at || ""
  };
}

function readOrderReceiptLines(orderId) {
  return openOrderSqliteDb().prepare(`
    SELECT *
    FROM order_receipt_lines
    WHERE order_id = ?
    ORDER BY batch_id, line_index
  `).all(String(orderId)).map(receiptLineFromRow);
}

function discrepancyFromRow(row) {
  return {
    id: row.id,
    orderId: row.order_id,
    batchId: row.batch_id || "",
    lineIndex: Number(row.line_index || 0),
    receiptLineId: row.receipt_line_id || "",
    sourceKey: row.source_key || "",
    discrepancyType: row.discrepancy_type || "shortage",
    status: row.status || "Open",
    resolutionType: row.resolution_type || "",
    sku: row.sku || "",
    buyingCode: row.buying_code || "",
    style: row.style || "",
    quantity: Number(row.quantity || 0),
    valueGbp: Number(row.value_gbp || 0),
    currency: row.currency || "GBP",
    linkedInvoiceId: row.linked_invoice_id || "",
    notes: row.notes || "",
    actorName: row.actor_name || "",
    resolvedAt: row.resolved_at || "",
    data: parseJson(row.data, {}),
    createdAt: row.created_at || "",
    updatedAt: row.updated_at || ""
  };
}

function readOrderDiscrepancies(orderId) {
  return openOrderSqliteDb().prepare(`
    SELECT *
    FROM order_discrepancies
    WHERE order_id = ?
    ORDER BY
      CASE WHEN status IN ('Credit received', 'Replacement received', 'Accepted variance', 'Written off', 'Resolved') THEN 1 ELSE 0 END,
      updated_at DESC,
      created_at DESC
  `).all(String(orderId)).map(discrepancyFromRow);
}

function emptySupplierCreditSummary(name = "") {
  return {
    supplierName: cleanText(name) || "No supplier",
    creditDueGbp: 0,
    creditReceivedGbp: 0,
    openCreditCount: 0,
    receivedCreditCount: 0,
    items: []
  };
}

function supplierCreditSummaries() {
  const dbData = readOrderDb();
  const ordersById = new Map((dbData.orders || []).map(order => [String(order.id), order]));
  const rows = openOrderSqliteDb().prepare(`
    SELECT *
    FROM order_discrepancies
    ORDER BY updated_at DESC, created_at DESC
  `).all().map(row => {
    const discrepancy = discrepancyFromRow(row);
    const order = ordersById.get(String(discrepancy.orderId)) || {};
    return {
      ...discrepancy,
      supplierName: cleanText(order.supplier?.name || order.supplierName),
      orderNumber: cleanText(order.orderNumber)
    };
  });
  return new Map(orderActuals.summarizeSupplierCredits(rows).map(summary => [cleanText(summary.supplierName).toLowerCase(), summary]));
}

function supplierCreditSummary(name = "", summaries = null) {
  const supplierName = cleanText(name);
  if (!supplierName) return emptySupplierCreditSummary("");
  const summaryMap = summaries || supplierCreditSummaries();
  return summaryMap.get(supplierName.toLowerCase()) || emptySupplierCreditSummary(supplierName);
}

function labelJobFromRow(row) {
  if (!row) return null;
  const snapshot = normalizeDoubleBarcodeSnapshot(parseJson(row.data, {}));
  return {
    ...snapshot,
    id: row.id,
    orderId: row.order_id,
    jobNumber: row.job_number,
    version: Number(row.version || 0),
    scopeType: row.scope_type || "order",
    batchId: row.batch_id || "",
    status: row.status || "Draft",
    barcodeFormat: row.barcode_format || "Code 128",
    createdBy: row.created_by || "",
    createdAt: row.created_at || ""
  };
}

function readOrderLabelJobs(orderId) {
  return openOrderSqliteDb().prepare(`
    SELECT *
    FROM order_label_jobs
    WHERE order_id = ?
    ORDER BY version DESC, created_at DESC
  `).all(String(orderId)).map(labelJobFromRow);
}

function createOrderLabelJob(order, input = {}, createdBy = "") {
  const scopeType = ["order", "batch", "unbatched"].includes(input.scopeType) ? input.scopeType : "order";
  const batchId = scopeType === "batch" ? cleanText(input.batchId) : "";
  const batches = readOrderBatches(order.id);
  if (scopeType === "batch" && !batches.some(batch => String(batch.id) === batchId)) {
    const error = new Error("The selected supplier batch no longer exists.");
    error.validation = { valid: false, errors: [error.message], warnings: [] };
    throw error;
  }
  const snapshot = buildLabelJobSnapshot({
    order,
    batches,
    batchLines: readOrderBatchLines(order.id),
    scopeType,
    batchId,
    sparePerSku: input.sparePerSku,
    labelTemplate: input.labelTemplate,
    placementInstructions: input.placementInstructions
  });
  if (!snapshot.valid) {
    const error = new Error("Resolve the label-job validation errors before generating reports.");
    error.validation = snapshot;
    throw error;
  }
  if (input.preview) return { ...snapshot, preview: true };
  const db = openOrderSqliteDb();
  const version = Number(db.prepare("SELECT MAX(version) AS version FROM order_label_jobs WHERE order_id = ?").get(String(order.id))?.version || 0) + 1;
  const id = crypto.randomUUID();
  const safeOrderNumber = cleanText(order.orderNumber || "ORDER").replace(/[^A-Z0-9-]+/gi, "-").replace(/^-+|-+$/g, "") || "ORDER";
  const jobNumber = `LABEL-${safeOrderNumber}-V${String(version).padStart(2, "0")}`;
  const generatedAt = new Date().toISOString();
  const supplier = order.supplier || {};
  const job = {
    ...snapshot,
    id,
    orderId: String(order.id),
    orderNumber: cleanText(order.orderNumber),
    supplierName: cleanText(supplier.name || order.supplierName),
    supplierContact: cleanText(supplier.contact),
    supplierEmail: cleanText(supplier.email),
    supplierCity: cleanText(supplier.city),
    supplierCountry: cleanText(supplier.country),
    jobNumber,
    version,
    status: "Draft",
    generatedAt,
    generatedBy: cleanText(createdBy)
  };
  db.prepare(`
    INSERT INTO order_label_jobs (
      id, order_id, job_number, version, scope_type, batch_id, status,
      barcode_format, data, created_by, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'Draft', 'Code 128', ?, ?, ?)
  `).run(id, String(order.id), jobNumber, version, scopeType, batchId, JSON.stringify(job), cleanText(createdBy), generatedAt);
  recordOrderEvent(order.id, "label_job", createdBy, `Label job ${jobNumber} generated`, {
    jobNumber,
    scope: snapshot.scopeLabel,
    skus: snapshot.totals.skus,
    labelsRequired: snapshot.totals.labelsRequired
  });
  return labelJobFromRow(db.prepare("SELECT * FROM order_label_jobs WHERE id = ?").get(id));
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
  const receiptLines = readOrderReceiptLines(orderId);
  const receiptByBatch = new Map();
  for (const receipt of receiptLines) {
    const key = String(receipt.batchId || "");
    if (!receiptByBatch.has(key)) receiptByBatch.set(key, []);
    receiptByBatch.get(key).push(receipt);
  }
  const orderUnits = (order?.lines || []).reduce((total, line) => total + Number(line.quantity || 0), 0);
  const expectedUnits = batches.reduce((total, batch) => total + Number(batch.units || 0), 0);
  const expectedStyles = batches.reduce((total, batch) => total + Number(batch.styleCount || 0), 0);
  let receivedUnits = 0;
  let acceptedUnits = 0;
  let damagedUnits = 0;
  let shortUnits = 0;
  let overUnits = 0;
  let onTime = 0;
  let late = 0;
  let batchesWithActuals = 0;
  for (const batch of batches) {
    const receipts = receiptByBatch.get(String(batch.id)) || [];
    if (receipts.length) {
      const totals = orderActuals.receiptTotals(receipts);
      batchesWithActuals += 1;
      receivedUnits += totals.receivedQuantity;
      acceptedUnits += totals.acceptedQuantity;
      damagedUnits += totals.damagedQuantity;
      shortUnits += totals.shortQuantity;
      overUnits += totals.overQuantity;
    } else if (batch.intakeStatus === "Received") {
      receivedUnits += Number(batch.units || 0);
      acceptedUnits += Number(batch.units || 0);
    }
    if (batch.intakeStatus === "Received" && batch.receivedDate) {
      if (batch.etaDate && batch.receivedDate > batch.etaDate) late += 1;
      else onTime += 1;
    }
  }
  const shippedUnits = batches
    .filter(batch => ["Shipped", "Part received", "Received"].includes(batch.intakeStatus))
    .reduce((total, batch) => total + Number(batch.units || 0), 0);
  const openBatches = batches.filter(batch => batch.intakeStatus !== "Received").length;
  const received = batches.filter(batch => batch.intakeStatus === "Received").length;
  const partReceived = batches.filter(batch => batch.intakeStatus === "Part received").length;
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
    acceptedUnits,
    damagedUnits,
    shortUnits,
    overUnits,
    shippedUnits,
    outstandingUnits: Math.max(0, (orderUnits || expectedUnits) - acceptedUnits),
    fillRate: (expectedUnits || orderUnits) > 0 ? acceptedUnits / (expectedUnits || orderUnits) : 0,
    batchesWithActuals,
    openBatches,
    received,
    partReceived,
    shipped,
    delayed,
    inProduction,
    confirmed,
    onTime,
    late
  };
}

function invoiceFromRow(row, includeFile = true) {
  const filePath = row.file_path || "";
  const documentKind = orderActuals.normalizeDocumentKind({ document_kind: row.document_kind, invoice_type: row.invoice_type });
  const amount = Number(row.amount || 0);
  return {
    id: row.id,
    orderId: row.order_id,
    batchId: row.batch_id || "",
    linkedDiscrepancyId: row.linked_discrepancy_id || "",
    documentKind,
    invoiceType: row.invoice_type || "",
    invoiceNumber: row.invoice_number || "",
    invoiceDate: row.invoice_date || "",
    dueDate: row.due_date || "",
    amount,
    signedAmount: orderActuals.signedInvoiceAmount({ amount, documentKind }),
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
  const lines = order?.lines || order?.order?.lines || [];
  const lineTotal = lines.reduce((total, line) => total + reportLineValueGbp(line), 0);
  return Number(lineTotal || order?.totals?.subtotal || order?.subtotal || order?.totalGbp || order?.totals?.grand || 0);
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

function balanceAfterTolerance(value, tolerance) {
  const amount = Math.max(0, Number(value || 0));
  return amount <= Number(tolerance || 0) ? 0 : amount;
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
  const regularInvoices = invoices.filter(invoice => invoice.documentKind !== "credit_note");
  const creditNotes = invoices.filter(invoice => invoice.documentKind === "credit_note");
  const unpaidActionable = regularInvoices.filter(invoice => invoice.status !== "Paid" && (invoice.sentToFd || invoice.isReceived));
  const grossInvoiceDue = regularInvoices.reduce((total, invoice) => total + amountToGbp(invoice.amount, invoice.currency, order), 0);
  const grossInvoiceDueEur = regularInvoices.reduce((total, invoice) => total + amountToEur(invoice.amount, invoice.currency, order), 0);
  const creditNoteTotal = creditNotes.reduce((total, invoice) => total + amountToGbp(invoice.amount, invoice.currency, order), 0);
  const creditNoteTotalEur = creditNotes.reduce((total, invoice) => total + amountToEur(invoice.amount, invoice.currency, order), 0);
  const creditReceived = creditNotes
    .filter(invoice => invoice.status === "Paid" || invoice.status === "Credit received")
    .reduce((total, invoice) => total + amountToGbp(invoice.amount, invoice.currency, order), 0);
  const creditReceivedEur = creditNotes
    .filter(invoice => invoice.status === "Paid" || invoice.status === "Credit received")
    .reduce((total, invoice) => total + amountToEur(invoice.amount, invoice.currency, order), 0);
  const totalDue = grossInvoiceDue - creditNoteTotal;
  const totalDueEur = grossInvoiceDueEur - creditNoteTotalEur;
  const totalPaid = regularInvoices
    .filter(invoice => invoice.status === "Paid")
    .reduce((total, invoice) => total + amountToGbp(invoice.amount, invoice.currency, order), 0);
  const totalPaidEur = regularInvoices
    .filter(invoice => invoice.status === "Paid")
    .reduce((total, invoice) => total + amountToEur(invoice.amount, invoice.currency, order), 0);
  const orderTotal = orderTotalGbp(order);
  const orderTotalEur = amountToEur(orderTotal, "GBP", order);
  const toleranceGbp = invoiceBalanceToleranceGbp;
  const toleranceEur = amountToEur(toleranceGbp, "GBP", order);
  const workflowData = workflowDataForOrder(orderId);
  const varianceIgnored = Boolean(workflowData.invoiceVarianceIgnored);
  const outstandingInvoiced = Math.max(0, totalDue - totalPaid);
  const outstandingInvoicedEur = Math.max(0, totalDueEur - totalPaidEur);
  const uninvoicedBalance = varianceIgnored ? 0 : balanceAfterTolerance(Math.max(0, orderTotal - totalDue), toleranceGbp);
  const uninvoicedBalanceEur = varianceIgnored ? 0 : balanceAfterTolerance(Math.max(0, orderTotalEur - totalDueEur), toleranceEur);
  const outstanding = outstandingInvoiced + uninvoicedBalance;
  const outstandingEur = outstandingInvoicedEur + uninvoicedBalanceEur;
  const invoiceVariance = totalDue - orderTotal;
  const invoiceVarianceEur = totalDueEur - orderTotalEur;
  const supplierCreditDue = Math.max(0, creditNoteTotal - creditReceived);
  const supplierCreditDueEur = Math.max(0, creditNoteTotalEur - creditReceivedEur);
  return {
    count: invoices.length,
    invoiceCount: regularInvoices.length,
    creditNoteCount: creditNotes.length,
    sentToFd: invoices.filter(invoice => invoice.sentToFd).length,
    received: invoices.filter(invoice => invoice.isReceived).length,
    paid: regularInvoices.filter(invoice => invoice.status === "Paid").length,
    creditReceivedCount: creditNotes.filter(invoice => invoice.status === "Paid" || invoice.status === "Credit received").length,
    unpaidActionable: unpaidActionable.length,
    orderTotal,
    orderTotalEur,
    grossInvoiceDue,
    grossInvoiceDueEur,
    creditNoteTotal,
    creditNoteTotalEur,
    creditReceived,
    creditReceivedEur,
    supplierCreditDue,
    supplierCreditDueEur,
    netInvoiced: totalDue,
    netInvoicedEur: totalDueEur,
    totalDue,
    totalDueEur,
    totalPaid,
    totalPaidEur,
    outstandingInvoiced,
    outstandingInvoicedEur,
    uninvoicedBalance,
    uninvoicedBalanceEur,
    outstanding,
    outstandingEur,
    invoiceVariance,
    invoiceVarianceEur,
    balanceToleranceGbp: toleranceGbp,
    balanceToleranceEur: toleranceEur,
    withinTolerance: Math.abs(invoiceVariance) <= toleranceGbp,
    varianceIgnored,
    varianceIgnoredAt: workflowData.invoiceVarianceIgnoredAt || "",
    varianceIgnoredBy: workflowData.invoiceVarianceIgnoredBy || ""
  };
}

function invoiceSummaryIsFullyPaid(totals) {
  const orderTotal = Number(totals?.orderTotal || 0);
  return orderTotal > 0 && Number(totals?.totalPaid || 0) > 0 && Number(totals?.outstanding || 0) <= 0;
}

function paymentStatusForBatchInvoices(invoices) {
  if (!invoices.length) return "Awaiting invoice";
  if (invoices.some(invoice => invoice.status === "Query")) return "Query";
  const paymentInvoices = invoices.filter(invoice => invoice.documentKind !== "credit_note");
  if (!paymentInvoices.length) return "Awaiting invoice";
  const paid = paymentInvoices.filter(invoice => invoice.status === "Paid").length;
  const actionable = paymentInvoices.filter(invoice => invoice.status !== "Paid" && (invoice.sentToFd || invoice.isReceived)).length;
  if (paid === paymentInvoices.length) return "Paid";
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
  const documentKind = orderActuals.normalizeDocumentKind(invoice);
  const linkedDiscrepancyId = String(invoice.linkedDiscrepancyId || existingInvoice.linkedDiscrepancyId || "").trim();
  db.prepare(`
    INSERT INTO order_invoices (
      id, order_id, batch_id, linked_discrepancy_id, document_kind, invoice_type, invoice_number, invoice_date, due_date, amount, currency,
      is_received, sent_to_fd, status, file_name, mime_type, file_path, file_size, file_data, notes, uploaded_by, uploaded_at, updated_at
    ) VALUES (
      @id, @orderId, @batchId, @linkedDiscrepancyId, @documentKind, @invoiceType, @invoiceNumber, @invoiceDate, @dueDate, @amount, @currency,
      @isReceived, @sentToFd, @status, @fileName, @mimeType, @filePath, @fileSize, '', @notes, @uploadedBy, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    )
    ON CONFLICT(id) DO UPDATE SET
      batch_id = excluded.batch_id,
      linked_discrepancy_id = excluded.linked_discrepancy_id,
      document_kind = excluded.document_kind,
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
    linkedDiscrepancyId,
    documentKind,
    invoiceType: String(invoice.invoiceType || (documentKind === "credit_note" ? "Credit note" : "")).trim(),
    invoiceNumber: String(invoice.invoiceNumber || "").trim(),
    invoiceDate: String(invoice.invoiceDate || "").trim(),
    dueDate: String(invoice.dueDate || "").trim(),
    amount: Math.abs(Number(invoice.amount || 0)),
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

  if (documentKind === "credit_note" && linkedDiscrepancyId) {
    const status = String(invoice.status || "").trim() === "Paid" ? "Credit received" : "Credit requested";
    db.prepare(`
      UPDATE order_discrepancies
      SET linked_invoice_id = ?, status = ?, resolution_type = 'credit_note',
          resolved_at = CASE WHEN ? = 'Credit received' THEN COALESCE(resolved_at, ?) ELSE resolved_at END,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND order_id = ?
    `).run(id, status, status, todayIsoDate(), linkedDiscrepancyId, String(order.id));
  }

  const action = documentKind === "credit_note"
    ? "Credit note uploaded"
    : canManagePayment && invoice.sentToFd ? "Invoice uploaded and sent to FD" : "Invoice uploaded";
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
        paymentAmount: orderTotalGbp(order),
        paymentPaidDate: "",
        nextActionOwner: "Buyer",
        nextAction: "Awaiting supplier invoice"
      }, actorName, "invoice");
      if (order.status === "Paid" || order.status === "Payment pending") updateStoredOrderStatus(order.id, "Approved");
    }
    return;
  }

  const totals = invoiceSummary(order);
  const paymentInvoices = invoices.filter(invoice => invoice.documentKind !== "credit_note");
  if (!paymentInvoices.length) {
    if (totals.supplierCreditDue > 0) {
      writeOrderWorkflow(order, {
        paymentStatus: current.paymentStatus === "Paid" ? "Paid" : "Awaiting invoice",
        paymentAmount: totals.orderTotal || 0,
        nextActionOwner: "FD / Finance",
        nextAction: "Track supplier credit note"
      }, actorName, "invoice");
    }
    return;
  }
  const allPaid = invoiceSummaryIsFullyPaid(totals);
  const somePaid = totals.totalPaid > 0;
  const hasUnpaidActionableInvoice = totals.unpaidActionable > 0;
  const anySent = paymentInvoices.some(invoice => invoice.sentToFd);
  const anyReceived = paymentInvoices.some(invoice => invoice.isReceived);
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
    return {
      intakeStatus: current.intakeStatus === "Received" ? "Received" : deliveryReviewStatus,
      intakeActualDate: current.intakeActualDate || todayIsoDate()
    };
  }
  if (summary.received > 0 || summary.partReceived > 0) return { intakeStatus: "Part received" };
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
    if ([deliveryReviewStatus, "Received", "Part received", "Shipped", "Part shipped", "Delayed", "In production", "Confirmed"].includes(patch.intakeStatus)) {
      patch.nextActionOwner = "Merchandising";
      patch.nextAction = patch.intakeStatus === deliveryReviewStatus
        ? "Review delivery before archive"
        : patch.intakeStatus === "Received"
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
  db.prepare("UPDATE order_invoices SET linked_discrepancy_id = '' WHERE order_id = ? AND linked_discrepancy_id IN (SELECT id FROM order_discrepancies WHERE order_id = ? AND batch_id = ?)").run(String(order.id), String(order.id), batchId);
  db.prepare("DELETE FROM order_discrepancies WHERE order_id = ? AND batch_id = ?").run(String(order.id), batchId);
  db.prepare("DELETE FROM order_receipt_lines WHERE order_id = ? AND batch_id = ?").run(String(order.id), batchId);
  db.prepare("DELETE FROM order_batch_lines WHERE order_id = ? AND batch_id = ?").run(String(order.id), batchId);
  db.prepare("DELETE FROM order_batches WHERE id = ? AND order_id = ?").run(batchId, String(order.id));
  recordOrderEvent(order.id, "batch", body.actorName || "", "Batch deleted", { batchId, batchNumber: batch.batch_number || "" });
  syncBatchPaymentStatusesFromInvoices(order.id);
  syncBatchWorkflow(order, body.actorName || "");
  syncPaymentWorkflowFromInvoices(order, body.actorName || "");
  return readOrderBatches(order.id);
}

function ensureFullOrderBatchForReceipt(order, actorName = "") {
  const existing = readOrderBatches(order.id);
  if (existing.length) throw new Error("Choose a supplier batch to receive.");
  const allocations = (order.lines || [])
    .map((line, lineIndex) => ({ lineIndex, quantity: Number(line.quantity || 0) }))
    .filter(allocation => allocation.quantity > 0);
  if (!allocations.length) throw new Error("This order has no lines to receive.");
  const cleanAllocations = normalizeBatchLineAllocations(order, allocations, "");
  const totals = batchTotalsFromAllocations(order, cleanAllocations);
  const id = crypto.randomUUID();
  const db = openOrderSqliteDb();
  db.prepare(`
    INSERT INTO order_batches (
      id, order_id, batch_number, title, style_count, units, value, currency,
      payment_status, intake_status, eta_date, shipped_date, received_date, tracking_reference,
      style_notes, notes, created_at, updated_at
    ) VALUES (?, ?, 'Full order', 'Full order receipt', ?, ?, ?, ?, 'Awaiting invoice', 'Not confirmed', ?, '', '', '', 'Auto-created for receiving', '', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run(id, String(order.id), totals.styleCount, totals.units, totals.value, order.terms?.currency || "GBP", order.delivery?.requiredDate || "");
  replaceBatchLineAllocations(order, id, cleanAllocations);
  recordOrderEvent(order.id, "batch", actorName, "Full-order batch created for receiving", { batchId: id, lineAllocations: cleanAllocations.length });
  return batchFromRow(db.prepare("SELECT * FROM order_batches WHERE id = ?").get(id));
}

function sourceKeyForDiscrepancy(orderId, batchId, lineIndex, type) {
  return [String(orderId || ""), String(batchId || ""), Number(lineIndex || 0), String(type || "")].join(":");
}

function syncDiscrepanciesFromReceipts(order, batch, receiptLines, actorName = "") {
  const db = openOrderSqliteDb();
  const drafts = orderActuals.discrepancyDraftsForReceipt({ order, batch, receiptLines });
  const draftKeys = new Set(drafts.map(draft => draft.sourceKey));
  const allKeys = new Set();
  for (const receipt of receiptLines || []) {
    for (const type of ["shortage", "damage", "overage"]) {
      allKeys.add(sourceKeyForDiscrepancy(order.id, batch.id, receipt.lineIndex, type));
    }
  }
  const activeByKey = new Map();
  for (const key of allKeys) {
    const row = db.prepare(`
      SELECT *
      FROM order_discrepancies
      WHERE order_id = ? AND source_key = ?
        AND status NOT IN ('Credit received', 'Replacement received', 'Accepted variance', 'Written off', 'Resolved')
      ORDER BY updated_at DESC
      LIMIT 1
    `).get(String(order.id), key);
    if (row) activeByKey.set(key, discrepancyFromRow(row));
  }
  const insert = db.prepare(`
    INSERT INTO order_discrepancies (
      id, order_id, batch_id, line_index, receipt_line_id, source_key, discrepancy_type,
      status, resolution_type, sku, buying_code, style, quantity, value_gbp, currency,
      linked_invoice_id, notes, actor_name, resolved_at, data, created_at, updated_at
    ) VALUES (
      @id, @orderId, @batchId, @lineIndex, @receiptLineId, @sourceKey, @discrepancyType,
      'Open', '', @sku, @buyingCode, @style, @quantity, @valueGbp, @currency,
      '', @notes, @actorName, '', '{}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    )
  `);
  const update = db.prepare(`
    UPDATE order_discrepancies
    SET receipt_line_id = @receiptLineId,
        sku = @sku,
        buying_code = @buyingCode,
        style = @style,
        quantity = @quantity,
        value_gbp = @valueGbp,
        currency = @currency,
        notes = CASE WHEN COALESCE(notes, '') = '' THEN @notes ELSE notes END,
        actor_name = @actorName,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = @id
  `);
  for (const draft of drafts) {
    const existing = activeByKey.get(draft.sourceKey);
    const params = { ...draft, id: existing?.id || crypto.randomUUID(), actorName };
    if (existing) update.run(params);
    else insert.run(params);
  }
  for (const [key, discrepancy] of activeByKey) {
    if (draftKeys.has(key)) continue;
    db.prepare(`
      UPDATE order_discrepancies
      SET status = 'Resolved',
          resolution_type = 'corrected_receipt',
          resolved_at = COALESCE(NULLIF(resolved_at, ''), ?),
          actor_name = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(todayIsoDate(), actorName, discrepancy.id);
  }
}

function syncBatchIntakeFromReceipts(order, batchId, receivedDate, actorName = "") {
  const db = openOrderSqliteDb();
  const batch = readOrderBatches(order.id).find(item => item.id === batchId);
  if (!batch) return;
  const allocations = readOrderBatchLines(order.id).filter(line => line.batchId === batchId);
  const receipts = readOrderReceiptLines(order.id).filter(line => line.batchId === batchId);
  const totals = orderActuals.receiptTotals(receipts);
  const countedLines = new Set(receipts.map(line => Number(line.lineIndex)));
  const allLinesCounted = allocations.length > 0 && allocations.every(line => countedLines.has(Number(line.lineIndex)));
  const hasAnyActual = totals.receivedQuantity > 0 || totals.shortQuantity > 0 || totals.damagedQuantity > 0 || totals.overQuantity > 0 || totals.acceptedQuantity > 0;
  if (!hasAnyActual) return;
  const status = allLinesCounted ? "Received" : "Part received";
  db.prepare(`
    UPDATE order_batches
    SET intake_status = ?,
        received_date = CASE WHEN ? != '' THEN ? ELSE received_date END,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND order_id = ?
  `).run(status, receivedDate || "", receivedDate || "", batchId, String(order.id));
  syncBatchWorkflow(order, actorName);
}

function saveOrderReceipts(order, body) {
  assertOrderProductsCompleteForWarehouse(order);
  const db = openOrderSqliteDb();
  let batchId = String(body.batchId || "").trim();
  if (!batchId) {
    const batch = ensureFullOrderBatchForReceipt(order, body.actorName || "");
    batchId = batch.id;
  }
  const batch = readOrderBatches(order.id).find(item => item.id === batchId);
  if (!batch) throw new Error("Batch not found");
  const allocations = readOrderBatchLines(order.id).filter(line => line.batchId === batchId);
  if (!allocations.length) throw new Error("Add line allocations to this batch before receiving actuals.");
  const lines = order.lines || [];
  const receivedDate = String(body.receivedDate || todayIsoDate()).trim();
  const inputs = new Map((body.lines || []).map(line => [Number(line.lineIndex), line]));
  const existing = new Map(readOrderReceiptLines(order.id).filter(line => line.batchId === batchId).map(line => [Number(line.lineIndex), line]));
  const upsert = db.prepare(`
    INSERT INTO order_receipt_lines (
      id, order_id, batch_id, line_index, sku, buying_code, style,
      expected_quantity, received_quantity, damaged_quantity, accepted_quantity, short_quantity, over_quantity,
      received_date, notes, actor_name, created_at, updated_at
    ) VALUES (
      @id, @orderId, @batchId, @lineIndex, @sku, @buyingCode, @style,
      @expectedQuantity, @receivedQuantity, @damagedQuantity, @acceptedQuantity, @shortQuantity, @overQuantity,
      @receivedDate, @notes, @actorName, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    )
    ON CONFLICT(order_id, batch_id, line_index) DO UPDATE SET
      sku = excluded.sku,
      buying_code = excluded.buying_code,
      style = excluded.style,
      expected_quantity = excluded.expected_quantity,
      received_quantity = excluded.received_quantity,
      damaged_quantity = excluded.damaged_quantity,
      accepted_quantity = excluded.accepted_quantity,
      short_quantity = excluded.short_quantity,
      over_quantity = excluded.over_quantity,
      received_date = excluded.received_date,
      notes = excluded.notes,
      actor_name = excluded.actor_name,
      updated_at = CURRENT_TIMESTAMP
  `);
  const saved = [];
  for (const allocation of allocations) {
    const lineIndex = Number(allocation.lineIndex || 0);
    const input = inputs.get(lineIndex) || existing.get(lineIndex) || {};
    const orderLine = lines[lineIndex] || {};
    const calculated = orderActuals.calculateReceiptLine({
      expectedQuantity: allocation.quantity,
      receivedQuantity: input.receivedQuantity ?? input.received ?? 0,
      damagedQuantity: input.damagedQuantity ?? input.damaged ?? 0,
      acceptedQuantity: input.acceptedQuantity
    });
    const row = {
      id: existing.get(lineIndex)?.id || crypto.randomUUID(),
      orderId: String(order.id),
      batchId,
      lineIndex,
      sku: String(allocation.sku || orderLine.sku || "").trim(),
      buyingCode: String(allocation.buyingCode || orderLine.buyingCode || orderLine.supplierSku || "").trim(),
      style: String(allocation.style || orderLine.style || orderLine.description || "").trim(),
      ...calculated,
      receivedDate,
      notes: String(input.notes || "").trim(),
      actorName: String(body.actorName || "").trim()
    };
    upsert.run(row);
    saved.push(row);
  }
  const receiptLines = readOrderReceiptLines(order.id).filter(line => line.batchId === batchId);
  syncDiscrepanciesFromReceipts(order, batch, receiptLines, body.actorName || "");
  syncBatchIntakeFromReceipts(order, batchId, receivedDate, body.actorName || "");
  const totals = orderActuals.receiptTotals(receiptLines);
  recordOrderEvent(order.id, "receipt", body.actorName || "", "Receipt actuals saved", {
    batchId,
    receivedDate,
    expectedUnits: totals.expectedQuantity,
    receivedUnits: totals.receivedQuantity,
    acceptedUnits: totals.acceptedQuantity,
    shortUnits: totals.shortQuantity,
    damagedUnits: totals.damagedQuantity
  });
  return { batchId, receiptLines: readOrderReceiptLines(order.id), discrepancies: readOrderDiscrepancies(order.id) };
}

function updateOrderDiscrepancy(order, body, req) {
  const db = openOrderSqliteDb();
  const id = String(body.discrepancyId || body.id || "").trim();
  if (!id) throw new Error("Missing discrepancy");
  const existing = db.prepare("SELECT * FROM order_discrepancies WHERE id = ? AND order_id = ?").get(id, String(order.id));
  if (!existing) throw new Error("Discrepancy not found");
  const patch = body.patch || body.discrepancy || {};
  const canFinance = userHasRole(req.currentUser, ["Finance", "Admin"]);
  const status = String(patch.status || existing.status || "Open").trim();
  if (!discrepancyStatuses.includes(status)) throw new Error("Choose a valid discrepancy status.");
  if (["Credit received", "Written off"].includes(status) && !canFinance) {
    throw new Error("Only Finance or Admin users can mark supplier credits received or written off.");
  }
  const resolutionType = String(patch.resolutionType ?? patch.resolution_type ?? existing.resolution_type ?? "").trim();
  if (!discrepancyResolutionTypes.includes(resolutionType)) throw new Error("Choose a valid discrepancy resolution.");
  const linkedInvoiceId = String(patch.linkedInvoiceId || patch.linked_invoice_id || existing.linked_invoice_id || "").trim();
  if (linkedInvoiceId !== String(existing.linked_invoice_id || "").trim() && !canFinance) {
    throw new Error("Only Finance or Admin users can link credit notes to discrepancies.");
  }
  if (linkedInvoiceId) {
    const invoice = db.prepare("SELECT id FROM order_invoices WHERE id = ? AND order_id = ?").get(linkedInvoiceId, String(order.id));
    if (!invoice) throw new Error("Linked credit note not found on this order.");
  }
  const resolvedAt = terminalDiscrepancyStatuses.has(status)
    ? String(patch.resolvedAt || existing.resolved_at || todayIsoDate()).trim()
    : "";
  db.prepare(`
    UPDATE order_discrepancies
    SET status = ?,
        resolution_type = ?,
        linked_invoice_id = ?,
        notes = ?,
        actor_name = ?,
        resolved_at = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND order_id = ?
  `).run(
    status,
    resolutionType,
    linkedInvoiceId,
    String(patch.notes ?? existing.notes ?? "").trim(),
    actorName(req),
    resolvedAt,
    id,
    String(order.id)
  );
  recordOrderEvent(order.id, "discrepancy", actorName(req), `Discrepancy ${status.toLowerCase()}`, { discrepancyId: id, status, resolutionType, linkedInvoiceId });
  return readOrderDiscrepancies(order.id);
}

function deleteOrderInvoice(order, body) {
  const invoiceId = String(body.invoiceId || "");
  if (!invoiceId) throw new Error("Missing invoice");
  const db = openOrderSqliteDb();
  const invoice = db.prepare("SELECT * FROM order_invoices WHERE id = ? AND order_id = ?").get(invoiceId, String(order.id));
  if (!invoice) throw new Error("Invoice not found");
  db.prepare("DELETE FROM order_invoices WHERE id = ? AND order_id = ?").run(invoiceId, String(order.id));
  if (invoice.linked_discrepancy_id) {
    db.prepare(`
      UPDATE order_discrepancies
      SET linked_invoice_id = '',
          status = CASE WHEN status = 'Credit received' THEN 'Credit requested' ELSE status END,
          resolved_at = CASE WHEN status = 'Credit received' THEN '' ELSE resolved_at END,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND order_id = ?
    `).run(invoice.linked_discrepancy_id, String(order.id));
  }
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
    permissions.add("pnl:write");
  }
  if (userHasRole(user, ["Finance", "Buying Director"])) permissions.add("pnl:view");
  if (userHasRole(user, ["Merchandising"])) {
    permissions.add("orders:intake");
    permissions.add("orders:archive");
    permissions.add("weekly:update");
  }
  if (userHasRole(user, ["Marketing", "Merchandising"])) permissions.add("email-campaigns:write");
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
  const rows = openOrderSqliteDb().prepare(`
    SELECT *
    FROM report_periods
    WHERE report_type = 'bestsellers'
      AND source_type = 'shopify_api'
      AND status = 'ready'
    ORDER BY start_date DESC, end_date DESC
    LIMIT 20
  `).all();
  return rows.find(row => !bestsellersPeriodNeedsRefresh(row));
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
    if (bestsellersPeriodNeedsRefresh(row)) throw new Error("That saved bestsellers period needs a Shopify refresh because it was cached before the week finished.");
    return row;
  }
  if (validReportDate(body.startDate) && validReportDate(body.endDate)) {
    const row = bestsellersPeriodRow(body.startDate, body.endDate, sourceType);
    if (!row) throw new Error("No saved bestsellers report exists for that period.");
    if (bestsellersPeriodNeedsRefresh(row)) throw new Error("That saved bestsellers period needs a Shopify refresh because it was cached before the week finished.");
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
      productStatus: product.productStatusCode || product.status || "",
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

function readAppSettingJson(key, fallback) {
  const row = openOrderSqliteDb().prepare("SELECT value FROM app_settings WHERE key = ?").get(String(key));
  return parseJson(row?.value, fallback);
}

function writeAppSettingJson(key, value) {
  openOrderSqliteDb().prepare(`
    INSERT INTO app_settings (key, value, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
  `).run(String(key), JSON.stringify(value || {}));
  return value || {};
}

function readSalePlannerConfig() {
  const value = readAppSettingJson("salePlannerCollections", {});
  return {
    rootSaleCollectionId: String(value.rootSaleCollectionId || ""),
    childCollectionByType: value.childCollectionByType && typeof value.childCollectionByType === "object" ? value.childCollectionByType : {}
  };
}

function writeSalePlannerConfig(input = {}) {
  const current = readSalePlannerConfig();
  const mapping = input.childCollectionByType && typeof input.childCollectionByType === "object" ? input.childCollectionByType : current.childCollectionByType;
  const cleanMapping = {};
  for (const [key, value] of Object.entries(mapping || {})) {
    const productType = String(key || "").trim();
    const collectionId = String(value || "").trim();
    if (productType && collectionId) cleanMapping[productType] = collectionId;
  }
  return writeAppSettingJson("salePlannerCollections", {
    rootSaleCollectionId: String((input.rootSaleCollectionId ?? current.rootSaleCollectionId) || "").trim(),
    childCollectionByType: cleanMapping
  });
}

function salePlanFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name || "",
    status: row.status || "Draft",
    sourceType: row.source_type || "",
    sourceLabel: row.source_label || "",
    createdBy: row.created_by || "",
    data: parseJson(row.data, {}),
    createdAt: row.created_at || "",
    updatedAt: row.updated_at || "",
    appliedAt: row.applied_at || "",
    removedAt: row.removed_at || ""
  };
}

function salePlanItemFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    planId: row.plan_id,
    productKey: row.product_key || "",
    shopifyProductId: row.shopify_product_id || "",
    legacyResourceId: row.legacy_resource_id || "",
    title: row.title || "",
    handle: row.handle || "",
    sku: row.sku || "",
    productType: row.product_type || "",
    season: row.season || "",
    imageUrl: row.image_url || "",
    currentPrice: row.current_price == null ? 0 : Number(row.current_price || 0),
    originalPrice: row.original_price == null ? 0 : Number(row.original_price || 0),
    compareAtPrice: row.compare_at_price == null ? 0 : Number(row.compare_at_price || 0),
    targetPrice: row.target_price == null ? 0 : Number(row.target_price || 0),
    discountPercent: row.discount_percent == null ? 0 : Number(row.discount_percent || 0),
    stock: row.stock == null ? 0 : Number(row.stock || 0),
    units: row.units == null ? 0 : Number(row.units || 0),
    revenue: row.revenue == null ? 0 : Number(row.revenue || 0),
    coverWks: row.cover_weeks == null ? null : Number(row.cover_weeks || 0),
    riskScore: row.risk_score == null ? 0 : Number(row.risk_score || 0),
    rootSaleCollectionId: row.root_sale_collection_id || "",
    childSaleCollectionId: row.child_sale_collection_id || "",
    status: row.status || "Planned",
    warnings: parseJson(row.warnings_json, []),
    variants: parseJson(row.variants_json, []),
    metrics: parseJson(row.metrics_json, {}),
    data: parseJson(row.data, {}),
    sourceType: row.source_type || "",
    sourceId: row.source_id || "",
    createdAt: row.created_at || "",
    updatedAt: row.updated_at || "",
    appliedAt: row.applied_at || "",
    removedAt: row.removed_at || "",
    lastError: row.last_error || ""
  };
}

function salePlanEventFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    planId: row.plan_id || "",
    itemId: row.item_id || "",
    eventType: row.event_type || "",
    actorName: row.actor_name || "",
    message: row.message || "",
    data: parseJson(row.data, {}),
    createdAt: row.created_at || ""
  };
}

function recordSalePlanEvent(planId, itemId, eventType, actor, message, data = {}) {
  openOrderSqliteDb().prepare(`
    INSERT INTO sale_plan_events (id, plan_id, item_id, event_type, actor_name, message, data, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `).run(crypto.randomUUID(), planId || "", itemId || "", eventType || "update", actor || "", message || "Updated", JSON.stringify(data || {}));
}

function salePlannerMetrics(items) {
  return {
    total: items.length,
    planned: items.filter(item => item.status === "Planned").length,
    applied: items.filter(item => item.status === "Applied").length,
    removed: items.filter(item => item.status === "Removed").length,
    errors: items.filter(item => item.status === "Error").length,
    finalClearance: items.filter(item => Number(item.discountPercent || 0) >= 50).length,
    stockUnits: items.reduce((sum, item) => sum + Number(item.stock || 0), 0),
    stockValue: Math.round(items.reduce((sum, item) => sum + Number(item.stock || 0) * Number(item.originalPrice || item.currentPrice || 0), 0) * 100) / 100
  };
}

function ensureSalePlan(body = {}, req = {}) {
  const db = openOrderSqliteDb();
  const requestedId = String(body.planId || "").trim();
  if (requestedId) {
    const existing = db.prepare("SELECT * FROM sale_plans WHERE id = ?").get(requestedId);
    if (existing) return salePlanFromRow(existing);
  }
  const active = db.prepare(`
    SELECT *
    FROM sale_plans
    WHERE status IN ('Draft', 'Ready')
    ORDER BY updated_at DESC
    LIMIT 1
  `).get();
  if (active && !body.createNew) return salePlanFromRow(active);

  const id = crypto.randomUUID();
  const today = todayIsoDate();
  const name = String(body.name || `Sale plan ${today}`).trim();
  db.prepare(`
    INSERT INTO sale_plans (id, name, status, source_type, source_label, created_by, data, created_at, updated_at)
    VALUES (?, ?, 'Draft', ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).run(id, name, body.sourceType || "", body.sourceLabel || "", actorName(req), JSON.stringify({ roundingRule: "nearest-pound" }));
  recordSalePlanEvent(id, "", "created", actorName(req), "Sale plan created", actorData(req));
  return salePlanFromRow(db.prepare("SELECT * FROM sale_plans WHERE id = ?").get(id));
}

async function fetchShopifyCollectionsForSalePlanner() {
  const { shop, clientId, clientSecret } = shopifyConfig();
  if (!shop || !clientId || !clientSecret) {
    return { configured: false, message: "Set Shopify credentials to map sale collections.", collections: [] };
  }
  const query = `
    query SalePlannerCollections($limit: Int!, $cursor: String) {
      collections(first: $limit, after: $cursor, sortKey: TITLE) {
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
  const collections = [];
  let cursor = null;
  let hasNextPage = true;
  while (hasNextPage) {
    const data = await shopifyGraphql(query, { limit: 250, cursor });
    collections.push(...(data.collections?.nodes || []).map(normalizeCollection));
    hasNextPage = Boolean(data.collections?.pageInfo?.hasNextPage);
    cursor = data.collections?.pageInfo?.endCursor || null;
  }
  return { configured: true, collections };
}

async function fetchShopifyProductSaleState(productId) {
  const id = String(productId || "").trim();
  if (!id) return null;
  const data = await shopifyGraphql(`
    query SalePlannerProduct($id: ID!) {
      product(id: $id) {
        id
        legacyResourceId
        status
        title
        handle
        onlineStoreUrl
        vendor
        productType
        tags
        createdAt
        publishedAt
        updatedAt
        seasonMetafield: metafield(namespace: "custom", key: "season") { value }
        productStatusMetafield: metafield(namespace: "custom", key: "product_status") { value }
        featuredImage { url altText }
        images(first: 1) { nodes { url altText } }
        collections(first: 100) { nodes { id title handle } }
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
    }
  `, { id });
  if (!data.product) return null;
  const normalized = normalizeProduct(data.product, new Map());
  normalized.collections = data.product.collections?.nodes || [];
  return normalized;
}

function saleImportProductFromWeeklyAction(action) {
  const metrics = action.metrics || {};
  const data = action.data || {};
  return {
    id: action.productKey,
    title: action.productTitle,
    sku: action.sku,
    productType: action.category,
    category: action.category,
    season: action.season,
    imageUrl: data.imageUrl || "",
    price: metrics.price,
    compareAtPrice: metrics.compareAtPrice,
    stock: metrics.stock,
    units: metrics.units,
    revenue: metrics.revenue,
    coverWks: metrics.coverWks,
    forecastBuy: metrics.forecastBuy,
    sourceType: "weekly_action",
    sourceId: action.id,
    sourceLabel: action.sourceLabel,
    sourceUrl: data.sourceUrl || `/weekly-actions.html?id=${encodeURIComponent(action.id)}`
  };
}

function salePlannerProductFromInput(input = {}) {
  const metrics = input.metrics || {};
  return {
    id: input.id || input.shopifyProductId || input.productKey || "",
    legacyResourceId: input.legacyResourceId || "",
    title: input.title || input.productTitle || "",
    handle: input.handle || "",
    sku: input.sku || (input.skus || [])[0] || "",
    productType: input.productType || input.category || "",
    category: input.category || input.productType || "",
    season: input.season || "",
    imageUrl: input.imageUrl || input.img || "",
    imageAlt: input.imageAlt || input.title || "",
    price: input.price ?? input.rrp ?? metrics.price,
    compareAtPrice: input.compareAtPrice ?? metrics.compareAtPrice,
    cost: input.cost ?? metrics.cost,
    stock: input.stock ?? metrics.stock,
    units: input.units ?? metrics.units,
    revenue: input.revenue ?? input.rev ?? metrics.revenue,
    coverWks: input.coverWks ?? metrics.coverWks,
    createdAt: input.createdAt || "",
    publishedAt: input.publishedAt || "",
    updatedAt: input.updatedAt || "",
    variants: input.variants || [],
    sourceType: input.sourceType || "manual",
    sourceId: input.sourceId || "",
    sourceLabel: input.sourceLabel || "",
    sourceUrl: input.sourceUrl || ""
  };
}

function mergeLiveSaleProduct(base, live) {
  if (!live) return base;
  return {
    ...base,
    ...live,
    stock: base.stock ?? live.stock,
    units: base.units ?? live.units,
    revenue: base.revenue ?? live.revenue,
    coverWks: base.coverWks ?? live.coverWks,
    sourceType: base.sourceType || "manual",
    sourceId: base.sourceId || "",
    sourceLabel: base.sourceLabel || "",
    sourceUrl: base.sourceUrl || ""
  };
}

function saleItemTargetGpPct(variants = []) {
  const values = variants
    .map(variant => Number(variant.targetGpPct))
    .filter(value => Number.isFinite(value));
  if (!values.length) return null;
  return Math.round(Math.min(...values) * 10) / 10;
}

function saleItemVariantWithTarget(variant, targetPrice, discountPercent) {
  const cost = variant.cost == null || variant.cost === "" ? null : Number(variant.cost);
  const targetGpPct = salePlanner.gpPercentFromRetail(targetPrice, cost);
  const warnings = (variant.warnings || []).filter(warning => !/below variant cost/i.test(String(warning)));
  if (targetGpPct != null && targetGpPct < 0) warnings.push("Target sale price is below variant cost.");
  return {
    ...variant,
    cost: Number.isFinite(cost) ? salePlanner.money(cost) : null,
    targetPrice,
    discountPercent,
    targetGpPct,
    warnings
  };
}

function saleItemVariantsForManualTarget(variants = [], targetPrice, discountPercent) {
  return variants.map(variant => saleItemVariantWithTarget(variant, targetPrice, discountPercent));
}

function saleItemVariantsWithGp(variants = []) {
  return variants.map(variant => saleItemVariantWithTarget(variant, variant.targetPrice, variant.discountPercent));
}

async function hydrateSaleItemVariantCosts(item, variants = []) {
  if (!item.shopifyProductId || !variants.some(variant => variant.cost == null || variant.cost === "")) return variants;
  try {
    const live = await fetchShopifyProductSaleState(item.shopifyProductId);
    const liveById = variantsById(live?.variants || []);
    return variants.map(variant => {
      const liveVariant = liveById.get(String(variant.id || ""));
      if ((variant.cost == null || variant.cost === "") && liveVariant?.cost != null) {
        return { ...variant, cost: salePlanner.money(liveVariant.cost) };
      }
      return variant;
    });
  } catch (_error) {
    return variants;
  }
}

function saleLedgerRowFromDb(row) {
  if (!row) return null;
  return {
    id: row.id,
    shopifyProductId: row.shopify_product_id || "",
    variantId: row.variant_id || "",
    sku: row.sku || "",
    productKey: row.product_key || "",
    productTitle: row.product_title || "",
    productType: row.product_type || "",
    season: row.season || "",
    originalPrice: row.original_price == null ? 0 : Number(row.original_price || 0),
    firstSalePrice: row.first_sale_price == null ? 0 : Number(row.first_sale_price || 0),
    currentSalePrice: row.current_sale_price == null ? 0 : Number(row.current_sale_price || 0),
    discountPercent: row.discount_percent == null ? 0 : Number(row.discount_percent || 0),
    status: row.status || "Active",
    firstPlanId: row.first_plan_id || "",
    firstItemId: row.first_item_id || "",
    lastPlanId: row.last_plan_id || "",
    lastItemId: row.last_item_id || "",
    appliedAt: row.applied_at || "",
    removedAt: row.removed_at || "",
    data: parseJson(row.data, {}),
    createdAt: row.created_at || "",
    updatedAt: row.updated_at || ""
  };
}

function readSaleLedgerRowsForProduct(productId) {
  const id = String(productId || "").trim();
  if (!id) return [];
  return openOrderSqliteDb().prepare(`
    SELECT *
    FROM sale_state_ledger
    WHERE shopify_product_id = ?
    ORDER BY updated_at DESC
  `).all(id).map(saleLedgerRowFromDb).filter(Boolean);
}

function saleLedgerLookup(rows = []) {
  const byVariant = new Map();
  const bySku = new Map();
  for (const row of rows || []) {
    if (row.variantId) byVariant.set(String(row.variantId), row);
    if (row.sku) bySku.set(String(row.sku).toLowerCase(), row);
  }
  return { byVariant, bySku };
}

function ledgerRowForVariant(lookup, variant = {}) {
  return lookup.byVariant.get(String(variant.id || "")) || lookup.bySku.get(String(variant.sku || "").toLowerCase()) || null;
}

function saleOriginalPriceFromSources(planned = {}, live = {}, ledger = null, item = {}) {
  const liveCompare = Number(live.compareAtPrice || 0);
  const livePrice = Number(live.price || live.currentPrice || 0);
  const candidates = [
    ledger?.originalPrice,
    planned.saleOriginalPrice,
    planned.originalRrp,
    planned.rrpOriginal,
    planned.originalPrice,
    liveCompare > livePrice ? liveCompare : 0,
    item.originalPrice,
    livePrice,
    planned.currentPrice,
    planned.price
  ];
  const original = candidates.map(Number).find(value => Number.isFinite(value) && value > 0);
  return salePlanner.money(original || 0);
}

function applySaleLedgerToProduct(product = {}) {
  if (!String(product.id || "").startsWith("gid://shopify/Product/")) return product;
  const ledgerRows = readSaleLedgerRowsForProduct(product.id);
  if (!ledgerRows.length) return product;
  const lookup = saleLedgerLookup(ledgerRows);
  const variants = (product.variants || []).map(variant => {
    const ledger = ledgerRowForVariant(lookup, variant);
    if (!ledger?.originalPrice) return variant;
    return {
      ...variant,
      saleOriginalPrice: ledger.originalPrice,
      originalRrp: ledger.originalPrice,
      originalPrice: ledger.originalPrice,
      compareAtPrice: ledger.originalPrice
    };
  });
  const originals = variants.map(variant => Number(variant.saleOriginalPrice || variant.originalPrice || 0)).filter(value => value > 0);
  const original = originals.length ? Math.max(...originals) : Number(product.compareAtPrice || product.price || 0);
  return {
    ...product,
    variants,
    saleOriginalPrice: original,
    originalRrp: original,
    originalPrice: original,
    compareAtPrice: original > Number(product.price || 0) ? original : product.compareAtPrice
  };
}

function readMarkdownLearningOutcomes(limit = 250) {
  return openOrderSqliteDb().prepare(`
    SELECT product_type AS productType,
           season,
           discount_percent AS discountPercent,
           outcome
    FROM sale_markdown_outcomes
    WHERE outcome IN ('worked', 'remove', 'deepen', 'failed')
    ORDER BY updated_at DESC
    LIMIT ?
  `).all(limit).map(row => ({
    productType: row.productType || "",
    season: row.season || "",
    discountPercent: Number(row.discountPercent || 0),
    outcome: row.outcome || ""
  }));
}

function salePlanItemParams(plan, product, collections, config, options = {}) {
  product = applySaleLedgerToProduct(product);
  const recommendation = salePlanner.recommendMarkdown(product, {
    now: new Date(),
    roundingRule: "nearest-pound",
    markdownOutcomes: options.markdownOutcomes || readMarkdownLearningOutcomes()
  });
  const variants = salePlanner.variantSaleTargets(product, recommendation.discountPercent, { roundingRule: "nearest-pound" });
  const membership = salePlanner.collectionMembershipForProduct(product, collections, {
    ...config.childCollectionByType,
    [product.productType || product.category || ""]: config.childCollectionByType[product.productType || product.category || ""]
  });
  const rootSaleCollectionId = config.rootSaleCollectionId || membership.rootSale?.id || "";
  const childSaleCollectionId = config.childCollectionByType[product.productType || product.category || ""] || membership.childSale?.id || "";
  const warnings = [
    ...recommendation.warnings,
    ...variants.flatMap(variant => variant.warnings || []),
    ...membership.missing,
    product.productStatusCode && !["N", "S"].includes(String(product.productStatusCode).trim().toUpperCase()) ? `Unexpected Product Status metafield: ${product.productStatusCode}.` : ""
  ].filter(Boolean);
  const productKey = salePlanner.productKey(product);
  const firstVariant = variants[0] || {};
  return {
    id: options.id || crypto.randomUUID(),
    planId: plan.id,
    productKey,
    shopifyProductId: String(product.id || "").startsWith("gid://shopify/Product/") ? product.id : "",
    legacyResourceId: product.legacyResourceId || "",
    title: product.title || product.productTitle || productKey,
    handle: product.handle || "",
    sku: product.sku || firstVariant.sku || "",
    productType: product.productType || product.category || "",
    season: product.season || "",
    imageUrl: product.imageUrl || "",
    currentPrice: recommendation.currentPrice,
    originalPrice: recommendation.originalPrice,
    compareAtPrice: recommendation.existingMarkdownPercent ? recommendation.originalPrice : Number(product.compareAtPrice || 0),
    targetPrice: recommendation.targetPrice,
    discountPercent: recommendation.discountPercent,
    stock: Number(product.stock || 0),
    units: Number(product.units || 0),
    revenue: Number(product.revenue || product.rev || 0),
    coverWks: product.coverWks == null ? null : Number(product.coverWks || 0),
    riskScore: recommendation.riskScore,
    rootSaleCollectionId,
    childSaleCollectionId,
    status: options.status || "Planned",
    warningsJson: JSON.stringify([...new Set(warnings)]),
    variantsJson: JSON.stringify(variants),
    metricsJson: JSON.stringify({
      stockValue: recommendation.stockValue,
      rationale: recommendation.rationale,
      existingMarkdownPercent: recommendation.existingMarkdownPercent,
      targetGpPct: saleItemTargetGpPct(variants),
      forecastBuy: product.forecastBuy == null ? null : Number(product.forecastBuy || 0)
    }),
    data: JSON.stringify({
      sourceUrl: product.sourceUrl || "",
      sourceLabel: product.sourceLabel || "",
      childCollectionSource: membership.childSource || "",
      imageAlt: product.imageAlt || product.title || ""
    }),
    sourceType: product.sourceType || "manual",
    sourceId: product.sourceId || "",
    lastError: ""
  };
}

function upsertSalePlanItem(params, actor = "") {
  const db = openOrderSqliteDb();
  const existing = db.prepare("SELECT * FROM sale_plan_items WHERE plan_id = ? AND product_key = ?").get(params.planId, params.productKey);
  const id = existing?.id || params.id || crypto.randomUUID();
  const payload = { ...params, id };
  if (existing) {
    db.prepare(`
      UPDATE sale_plan_items
      SET shopify_product_id = @shopifyProductId,
          legacy_resource_id = @legacyResourceId,
          title = @title,
          handle = @handle,
          sku = @sku,
          product_type = @productType,
          season = @season,
          image_url = @imageUrl,
          current_price = @currentPrice,
          original_price = @originalPrice,
          compare_at_price = @compareAtPrice,
          target_price = @targetPrice,
          discount_percent = @discountPercent,
          stock = @stock,
          units = @units,
          revenue = @revenue,
          cover_weeks = @coverWks,
          risk_score = @riskScore,
          root_sale_collection_id = @rootSaleCollectionId,
          child_sale_collection_id = @childSaleCollectionId,
          status = CASE WHEN status IN ('Applied', 'Removed') THEN status ELSE @status END,
          warnings_json = @warningsJson,
          variants_json = @variantsJson,
          metrics_json = @metricsJson,
          data = @data,
          source_type = @sourceType,
          source_id = @sourceId,
          last_error = @lastError,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = @id
    `).run(payload);
    recordSalePlanEvent(params.planId, id, "updated", actor, "Sale plan item refreshed", { title: params.title });
  } else {
    db.prepare(`
      INSERT INTO sale_plan_items (
        id, plan_id, product_key, shopify_product_id, legacy_resource_id, title, handle, sku,
        product_type, season, image_url, current_price, original_price, compare_at_price,
        target_price, discount_percent, stock, units, revenue, cover_weeks, risk_score,
        root_sale_collection_id, child_sale_collection_id, status, warnings_json, variants_json,
        metrics_json, data, source_type, source_id, created_at, updated_at, last_error
      ) VALUES (
        @id, @planId, @productKey, @shopifyProductId, @legacyResourceId, @title, @handle, @sku,
        @productType, @season, @imageUrl, @currentPrice, @originalPrice, @compareAtPrice,
        @targetPrice, @discountPercent, @stock, @units, @revenue, @coverWks, @riskScore,
        @rootSaleCollectionId, @childSaleCollectionId, @status, @warningsJson, @variantsJson,
        @metricsJson, @data, @sourceType, @sourceId, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, @lastError
      )
    `).run(payload);
    recordSalePlanEvent(params.planId, id, "imported", actor, "Product added to sale plan", { title: params.title });
  }
  db.prepare("UPDATE sale_plans SET updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(params.planId);
  return salePlanItemFromRow(db.prepare("SELECT * FROM sale_plan_items WHERE id = ?").get(id));
}

async function handleSalePlannerImport(req, res) {
  const body = await readJsonBody(req);
  const plan = ensureSalePlan(body, req);
  const config = readSalePlannerConfig();
  let collections = [];
  let collectionsWarning = "";
  try {
    const collectionResult = await fetchShopifyCollectionsForSalePlanner();
    collections = collectionResult.collections || [];
    if (!collectionResult.configured) collectionsWarning = collectionResult.message || "";
  } catch (error) {
    collectionsWarning = error.message || "Could not sync Shopify collections.";
  }
  const products = [];
  const weeklyActionIds = (body.weeklyActionIds || body.actionIds || []).map(String).filter(Boolean);
  if (weeklyActionIds.length) {
    const db = openOrderSqliteDb();
    const placeholders = weeklyActionIds.map(() => "?").join(",");
    const rows = db.prepare(`SELECT * FROM weekly_actions WHERE id IN (${placeholders})`).all(...weeklyActionIds);
    for (const row of rows) {
      const action = weeklyActionFromRow(row);
      products.push(saleImportProductFromWeeklyAction(action));
      if (action.actionType === "markdown" && ["Open", "In progress"].includes(action.status)) {
        db.prepare("UPDATE weekly_actions SET status = 'In progress', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'Open'").run(action.id);
        recordWeeklyActionEvent(action.id, "sale_planner", actorName(req), "Sent to sale planner", { planId: plan.id, ...actorData(req) });
      }
    }
  }
  for (const product of body.products || []) products.push(salePlannerProductFromInput(product));
  if (!products.length) throw new Error("Choose at least one product to add to the sale planner.");

  const imported = [];
  for (const sourceProduct of products) {
    let product = sourceProduct;
    if (String(sourceProduct.id || "").startsWith("gid://shopify/Product/")) {
      try {
        product = mergeLiveSaleProduct(sourceProduct, await fetchShopifyProductSaleState(sourceProduct.id));
      } catch (error) {
        product = { ...sourceProduct, data: { ...(sourceProduct.data || {}), liveSyncError: error.message } };
      }
    }
    const params = salePlanItemParams(plan, product, collections, config);
    if (collectionsWarning) {
      params.warningsJson = JSON.stringify([...new Set([...parseJson(params.warningsJson, []), collectionsWarning])]);
    }
    imported.push(upsertSalePlanItem(params, actorName(req)));
  }
  sendJson(res, 200, { ok: true, imported, ...(await readSalePlannerResponse(req, plan.id)) });
}

function readSalePlannerItems(planId) {
  if (!planId) return [];
  return openOrderSqliteDb().prepare(`
    SELECT *
    FROM sale_plan_items
    WHERE plan_id = ?
    ORDER BY
      CASE status WHEN 'Error' THEN 0 WHEN 'Planned' THEN 1 WHEN 'Applied' THEN 2 WHEN 'Removed' THEN 3 ELSE 4 END,
      risk_score DESC,
      stock * original_price DESC,
      updated_at DESC
  `).all(planId).map(salePlanItemFromRow);
}

function readSalePlannerEvents(planId, limit = 100) {
  if (!planId) return [];
  return openOrderSqliteDb().prepare(`
    SELECT *
    FROM sale_plan_events
    WHERE plan_id = ?
    ORDER BY created_at DESC
    LIMIT ?
  `).all(planId, limit).map(salePlanEventFromRow).filter(Boolean);
}

function dateDiffInclusive(startDate, endDate) {
  const start = reportUtcDate(startDate);
  const end = reportUtcDate(endDate);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end < start) return 0;
  return Math.floor((end - start) / 864e5) + 1;
}

function metricRowsForSaleItem(item, appliedDate) {
  const matches = [];
  const params = { appliedDate };
  if (item.shopifyProductId) {
    matches.push("m.shopify_product_id = @shopifyProductId");
    params.shopifyProductId = item.shopifyProductId;
  }
  if (item.productKey) {
    matches.push("m.product_key = @productKey");
    params.productKey = item.productKey;
  }
  if (item.sku) {
    matches.push("m.sku = @sku");
    params.sku = item.sku;
  }
  if (!matches.length && item.title) {
    matches.push("m.title = @title");
    params.title = item.title;
  }
  if (!matches.length) return [];
  return openOrderSqliteDb().prepare(`
    SELECT m.*, p.start_date, p.end_date
    FROM report_product_metrics m
    JOIN report_periods p ON p.id = m.period_id
    WHERE p.report_type = 'bestsellers'
      AND p.status = 'ready'
      AND (${matches.join(" OR ")})
      AND date(p.end_date) >= date(@appliedDate, '-35 day')
      AND date(p.start_date) <= date(@appliedDate, '+35 day')
    ORDER BY p.start_date ASC, p.end_date ASC
  `).all(params);
}

function aggregateSaleMetricRows(rows = [], fallbackStock = 0) {
  const latest = rows[rows.length - 1] || {};
  return {
    units: rows.reduce((sum, row) => sum + Number(row.units || 0), 0),
    revenue: rows.reduce((sum, row) => sum + Number(row.net_sales || 0), 0),
    stock: latest.stock == null ? Number(fallbackStock || 0) : Number(latest.stock || 0),
    gaViews: rows.reduce((sum, row) => sum + Number(row.ga_views || 0), 0),
    gaPurchases: rows.reduce((sum, row) => sum + Number(row.ga_purchases || 0), 0),
    startDate: rows[0]?.start_date || "",
    endDate: latest.end_date || ""
  };
}

function analyseSalePlanItem(item, now = new Date()) {
  const appliedDate = String(item.appliedAt || item.data?.appliedAt || "").slice(0, 10);
  if (!appliedDate) return null;
  const rows = metricRowsForSaleItem(item, appliedDate);
  const preRows = rows.filter(row => row.end_date < appliedDate).slice(-4);
  const postRows = rows.filter(row => row.start_date >= appliedDate).slice(0, 4);
  const pre = aggregateSaleMetricRows(preRows, item.stock);
  const post = aggregateSaleMetricRows(postRows, item.stock);
  const latestEndDate = post.endDate || now.toISOString().slice(0, 10);
  const daysObserved = postRows.length ? Math.min(28, Math.max(dateDiffInclusive(appliedDate, latestEndDate), 0)) : 0;
  const outcome = salePlanner.markdownOutcome({
    preUnits: pre.units,
    preStock: pre.stock,
    preGaViews: pre.gaViews,
    preGaPurchases: pre.gaPurchases,
    postUnits: post.units,
    postStock: post.stock,
    postGaViews: post.gaViews,
    postGaPurchases: post.gaPurchases,
    daysObserved,
    startStock: Number(item.stock || 0) + Number(pre.units || 0)
  });
  if (!postRows.length) {
    outcome.outcome = "watch";
    outcome.reason = "No post-markdown report data yet.";
    outcome.early = true;
  }
  return {
    ...outcome,
    planId: item.planId,
    itemId: item.id,
    shopifyProductId: item.shopifyProductId,
    productKey: item.productKey,
    title: item.title,
    productType: item.productType,
    season: item.season,
    discountPercent: item.discountPercent,
    appliedAt: item.appliedAt,
    analysisStartDate: pre.startDate || appliedDate,
    analysisEndDate: post.endDate || latestEndDate,
    pre,
    post,
    data: {
      sku: item.sku,
      imageUrl: item.imageUrl,
      originalPrice: item.originalPrice,
      currentPrice: item.currentPrice,
      targetPrice: item.targetPrice
    }
  };
}

function writeSaleMarkdownOutcomes(planId, outcomes = []) {
  const db = openOrderSqliteDb();
  const insert = db.prepare(`
    INSERT INTO sale_markdown_outcomes (
      id, plan_id, item_id, shopify_product_id, product_key, title, product_type, season,
      discount_percent, outcome, reason, applied_at, analysis_start_date, analysis_end_date,
      days_observed, pre_units, post_units, pre_stock, post_stock, pre_ga_views, post_ga_views,
      pre_ga_purchases, post_ga_purchases, sell_through_lift, cvr_lift, stock_reduction,
      data, created_at, updated_at
    ) VALUES (
      @id, @planId, @itemId, @shopifyProductId, @productKey, @title, @productType, @season,
      @discountPercent, @outcome, @reason, @appliedAt, @analysisStartDate, @analysisEndDate,
      @daysObserved, @preUnits, @postUnits, @preStock, @postStock, @preGaViews, @postGaViews,
      @preGaPurchases, @postGaPurchases, @sellThroughLift, @cvrLift, @stockReduction,
      @data, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    )
  `);
  const write = db.transaction(() => {
    db.prepare("DELETE FROM sale_markdown_outcomes WHERE plan_id = ?").run(planId);
    for (const outcome of outcomes) {
      insert.run({
        id: crypto.randomUUID(),
        planId,
        itemId: outcome.itemId,
        shopifyProductId: outcome.shopifyProductId || "",
        productKey: outcome.productKey || "",
        title: outcome.title || "",
        productType: outcome.productType || "",
        season: outcome.season || "",
        discountPercent: Number(outcome.discountPercent || 0),
        outcome: outcome.outcome,
        reason: outcome.reason || "",
        appliedAt: outcome.appliedAt || "",
        analysisStartDate: outcome.analysisStartDate || "",
        analysisEndDate: outcome.analysisEndDate || "",
        daysObserved: Number(outcome.daysObserved || 0),
        preUnits: Number(outcome.pre.units || 0),
        postUnits: Number(outcome.post.units || 0),
        preStock: Number(outcome.pre.stock || 0),
        postStock: Number(outcome.post.stock || 0),
        preGaViews: Number(outcome.pre.gaViews || 0),
        postGaViews: Number(outcome.post.gaViews || 0),
        preGaPurchases: Number(outcome.pre.gaPurchases || 0),
        postGaPurchases: Number(outcome.post.gaPurchases || 0),
        sellThroughLift: Number(outcome.sellThroughLift || 0),
        cvrLift: Number(outcome.cvrLift || 0),
        stockReduction: Number(outcome.stockReduction || 0),
        data: JSON.stringify(outcome.data || {})
      });
    }
  });
  write();
}

function saleOutcomeFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    planId: row.plan_id || "",
    itemId: row.item_id || "",
    shopifyProductId: row.shopify_product_id || "",
    productKey: row.product_key || "",
    title: row.title || "",
    productType: row.product_type || "",
    season: row.season || "",
    discountPercent: Number(row.discount_percent || 0),
    outcome: row.outcome || "watch",
    reason: row.reason || "",
    appliedAt: row.applied_at || "",
    analysisStartDate: row.analysis_start_date || "",
    analysisEndDate: row.analysis_end_date || "",
    daysObserved: Number(row.days_observed || 0),
    preUnits: Number(row.pre_units || 0),
    postUnits: Number(row.post_units || 0),
    preStock: Number(row.pre_stock || 0),
    postStock: Number(row.post_stock || 0),
    preGaViews: Number(row.pre_ga_views || 0),
    postGaViews: Number(row.post_ga_views || 0),
    preGaPurchases: Number(row.pre_ga_purchases || 0),
    postGaPurchases: Number(row.post_ga_purchases || 0),
    sellThroughLift: Number(row.sell_through_lift || 0),
    cvrLift: Number(row.cvr_lift || 0),
    stockReduction: Number(row.stock_reduction || 0),
    data: parseJson(row.data, {}),
    createdAt: row.created_at || "",
    updatedAt: row.updated_at || ""
  };
}

function saleAnalysisSummary(outcomes = [], items = []) {
  const summary = {
    analysed: outcomes.length,
    appliedItems: items.filter(item => item.appliedAt || item.status === "Applied" || item.status === "Removed").length,
    worked: outcomes.filter(row => row.outcome === "worked").length,
    watch: outcomes.filter(row => row.outcome === "watch").length,
    deepen: outcomes.filter(row => row.outcome === "deepen").length,
    remove: outcomes.filter(row => row.outcome === "remove").length,
    early: outcomes.filter(row => Number(row.daysObserved || 0) < 14).length,
    avgSellThroughLift: 0,
    avgCvrLift: 0
  };
  if (outcomes.length) {
    summary.avgSellThroughLift = Math.round((outcomes.reduce((sum, row) => sum + Number(row.sellThroughLift || 0), 0) / outcomes.length) * 1000) / 1000;
    summary.avgCvrLift = Math.round((outcomes.reduce((sum, row) => sum + Number(row.cvrLift || 0), 0) / outcomes.length) * 1000) / 1000;
  }
  return summary;
}

function compactSaleOutcome(row) {
  return {
    itemId: row.itemId,
    title: row.title,
    sku: row.data?.sku || "",
    imageUrl: row.data?.imageUrl || "",
    productType: row.productType,
    season: row.season,
    discountPercent: row.discountPercent,
    outcome: row.outcome,
    reason: row.reason,
    daysObserved: row.daysObserved,
    postStock: row.postStock,
    sellThroughLift: row.sellThroughLift,
    cvrLift: row.cvrLift,
    updatedAt: row.updatedAt
  };
}

function actionSignature(action) {
  return [
    action.actionType,
    Number(action.currentDiscountPercent || 0),
    Number(action.recommendedDiscountPercent || 0),
    Number(action.currentPrice || 0),
    Number(action.recommendedTargetPrice || 0),
    Number(action.postStock || 0),
    Number(action.daysObserved || 0),
    Number(action.postGaViews || 0),
    Number(action.sellThroughLift || 0),
    Number(action.cvrLift || 0)
  ].join("|");
}

function saleAnalysisActionFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    planId: row.plan_id || "",
    itemId: row.item_id || "",
    outcomeId: row.outcome_id || "",
    actionType: row.action_type || "",
    status: row.status || "Pending",
    priority: row.priority || "Medium",
    title: row.title || "",
    sku: row.sku || "",
    productType: row.product_type || "",
    season: row.season || "",
    currentPrice: Number(row.current_price || 0),
    originalPrice: Number(row.original_price || 0),
    currentDiscountPercent: Number(row.current_discount_percent || 0),
    recommendedDiscountPercent: Number(row.recommended_discount_percent || 0),
    recommendedTargetPrice: Number(row.recommended_target_price || 0),
    postStock: Number(row.post_stock || 0),
    daysObserved: Number(row.days_observed || 0),
    postGaViews: Number(row.post_ga_views || 0),
    viewsPerWeek: Number(row.views_per_week || 0),
    sellThroughLift: Number(row.sell_through_lift || 0),
    cvrLift: Number(row.cvr_lift || 0),
    reason: row.reason || "",
    sourceSignature: row.source_signature || "",
    changed: Boolean(row.changed),
    data: parseJson(row.data, {}),
    followUpPlanId: row.follow_up_plan_id || "",
    decidedBy: row.decided_by || "",
    decidedAt: row.decided_at || "",
    createdAt: row.created_at || "",
    updatedAt: row.updated_at || ""
  };
}

function buildSaleAnalysisActions(planId, outcomes = [], items = []) {
  const itemById = new Map((items || []).map(item => [item.id, item]));
  return (outcomes || []).map(outcome => {
    const item = itemById.get(outcome.itemId) || {};
    const recommendation = salePlanner.markdownActionRecommendation(outcome, item, {
      roundingRule: "nearest-pound",
      minViewsPerWeek: 25,
      minDays: 7
    });
    if (!recommendation) return null;
    const lowViews = recommendation.data?.lowViews || {};
    const action = {
      id: crypto.randomUUID(),
      planId,
      itemId: outcome.itemId,
      outcomeId: outcome.id || "",
      actionType: recommendation.actionType,
      status: "Pending",
      priority: recommendation.priority || "Medium",
      title: item.title || outcome.title || "",
      sku: item.sku || outcome.data?.sku || "",
      productType: item.productType || outcome.productType || "",
      season: item.season || outcome.season || "",
      currentPrice: recommendation.currentPrice,
      originalPrice: recommendation.originalPrice,
      currentDiscountPercent: recommendation.currentDiscountPercent,
      recommendedDiscountPercent: recommendation.recommendedDiscountPercent,
      recommendedTargetPrice: recommendation.recommendedTargetPrice,
      postStock: Number(outcome.postStock || 0),
      daysObserved: Number(outcome.daysObserved || 0),
      postGaViews: Number(outcome.postGaViews || 0),
      viewsPerWeek: Number(lowViews.viewsPerWeek || 0),
      sellThroughLift: Number(outcome.sellThroughLift || 0),
      cvrLift: Number(outcome.cvrLift || 0),
      reason: recommendation.reason,
      data: {
        ...(recommendation.data || {}),
        outcome: outcome.outcome,
        sourcePlanId: planId,
        sourceItemId: outcome.itemId,
        sourceProductKey: outcome.productKey || item.productKey || "",
        sourceShopifyProductId: outcome.shopifyProductId || item.shopifyProductId || ""
      }
    };
    action.sourceSignature = actionSignature(action);
    return action;
  }).filter(Boolean);
}

function writeSaleAnalysisActions(planId, actions = []) {
  const db = openOrderSqliteDb();
  const currentRows = db.prepare("SELECT * FROM sale_analysis_actions WHERE plan_id = ?").all(planId).map(saleAnalysisActionFromRow);
  const currentByKey = new Map(currentRows.map(action => [`${action.itemId}:${action.actionType}`, action]));
  const nextKeys = new Set(actions.map(action => `${action.itemId}:${action.actionType}`));
  const insert = db.prepare(`
    INSERT INTO sale_analysis_actions (
      id, plan_id, item_id, outcome_id, action_type, status, priority, title, sku, product_type, season,
      current_price, original_price, current_discount_percent, recommended_discount_percent, recommended_target_price,
      post_stock, days_observed, post_ga_views, views_per_week, sell_through_lift, cvr_lift,
      reason, source_signature, changed, data, created_at, updated_at
    ) VALUES (
      @id, @planId, @itemId, @outcomeId, @actionType, @status, @priority, @title, @sku, @productType, @season,
      @currentPrice, @originalPrice, @currentDiscountPercent, @recommendedDiscountPercent, @recommendedTargetPrice,
      @postStock, @daysObserved, @postGaViews, @viewsPerWeek, @sellThroughLift, @cvrLift,
      @reason, @sourceSignature, @changed, @data, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    )
  `);
  const update = db.prepare(`
    UPDATE sale_analysis_actions
    SET outcome_id = @outcomeId,
        status = @status,
        priority = @priority,
        title = @title,
        sku = @sku,
        product_type = @productType,
        season = @season,
        current_price = @currentPrice,
        original_price = @originalPrice,
        current_discount_percent = @currentDiscountPercent,
        recommended_discount_percent = @recommendedDiscountPercent,
        recommended_target_price = @recommendedTargetPrice,
        post_stock = @postStock,
        days_observed = @daysObserved,
        post_ga_views = @postGaViews,
        views_per_week = @viewsPerWeek,
        sell_through_lift = @sellThroughLift,
        cvr_lift = @cvrLift,
        reason = @reason,
        source_signature = @sourceSignature,
        changed = @changed,
        data = @data,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = @id
  `);
  const write = db.transaction(() => {
    for (const action of actions) {
      const existing = currentByKey.get(`${action.itemId}:${action.actionType}`);
      const changed = !existing || existing.sourceSignature !== action.sourceSignature;
      const status = changed ? "Pending" : existing.status;
      const payload = {
        ...action,
        id: existing?.id || action.id,
        status,
        changed: changed ? 1 : 0,
        data: JSON.stringify(action.data || {})
      };
      if (existing) update.run(payload);
      else insert.run(payload);
    }
    const stale = currentRows.filter(action => !nextKeys.has(`${action.itemId}:${action.actionType}`) && action.status === "Pending");
    for (const action of stale) {
      db.prepare(`
        UPDATE sale_analysis_actions
        SET status = 'Snoozed',
            changed = 0,
            decided_by = 'System',
            decided_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(action.id);
    }
  });
  write();
}

function readSaleAnalysisActions(planId) {
  if (!planId) return [];
  return openOrderSqliteDb().prepare(`
    SELECT *
    FROM sale_analysis_actions
    WHERE plan_id = ?
    ORDER BY
      CASE status WHEN 'Pending' THEN 0 WHEN 'Accepted' THEN 1 WHEN 'Snoozed' THEN 2 WHEN 'Ignored' THEN 3 WHEN 'Applied' THEN 4 ELSE 5 END,
      changed DESC,
      CASE priority WHEN 'High' THEN 0 WHEN 'Medium' THEN 1 ELSE 2 END,
      updated_at DESC,
      title COLLATE NOCASE
  `).all(planId).map(saleAnalysisActionFromRow).filter(Boolean);
}

function saleActionSummary(actions = []) {
  return {
    total: actions.length,
    pending: actions.filter(action => action.status === "Pending").length,
    changed: actions.filter(action => action.changed && action.status === "Pending").length,
    deepen: actions.filter(action => action.actionType === "deepen" && action.status === "Pending").length,
    remove: actions.filter(action => action.actionType === "remove" && action.status === "Pending").length,
    lowViews: actions.filter(action => action.actionType === "low_views" && action.status === "Pending").length,
    snoozed: actions.filter(action => action.status === "Snoozed").length,
    ignored: actions.filter(action => action.status === "Ignored").length,
    accepted: actions.filter(action => action.status === "Accepted").length
  };
}

function compactSaleAction(action) {
  return {
    id: action.id,
    itemId: action.itemId,
    actionType: action.actionType,
    status: action.status,
    priority: action.priority,
    changed: action.changed,
    title: action.title,
    sku: action.sku,
    productType: action.productType,
    season: action.season,
    currentPrice: action.currentPrice,
    originalPrice: action.originalPrice,
    currentDiscountPercent: action.currentDiscountPercent,
    recommendedDiscountPercent: action.recommendedDiscountPercent,
    recommendedTargetPrice: action.recommendedTargetPrice,
    postStock: action.postStock,
    daysObserved: action.daysObserved,
    postGaViews: action.postGaViews,
    viewsPerWeek: action.viewsPerWeek,
    sellThroughLift: action.sellThroughLift,
    cvrLift: action.cvrLift,
    reason: action.reason,
    followUpPlanId: action.followUpPlanId,
    updatedAt: action.updatedAt
  };
}

function readSalePlannerAnalysis(planId, items = []) {
  if (!planId) return { summary: saleAnalysisSummary([], items), actionSummary: saleActionSummary([]), exceptions: { worked: [], watch: [], deepen: [], remove: [] }, outcomes: [], actions: [], refreshedAt: "" };
  const outcomes = openOrderSqliteDb().prepare(`
    SELECT *
    FROM sale_markdown_outcomes
    WHERE plan_id = ?
    ORDER BY updated_at DESC, title COLLATE NOCASE
  `).all(planId).map(saleOutcomeFromRow).filter(Boolean);
  const exceptions = {};
  for (const key of ["worked", "watch", "deepen", "remove"]) {
    exceptions[key] = outcomes
      .filter(row => row.outcome === key)
      .sort((a, b) => Number(b.postStock || 0) - Number(a.postStock || 0))
      .slice(0, 8)
      .map(compactSaleOutcome);
  }
  const actions = readSaleAnalysisActions(planId);
  return {
    summary: saleAnalysisSummary(outcomes, items),
    actionSummary: saleActionSummary(actions),
    exceptions,
    outcomes: outcomes.slice(0, 80).map(compactSaleOutcome),
    actions: actions.slice(0, 1000).map(compactSaleAction),
    refreshedAt: outcomes[0]?.updatedAt || ""
  };
}

function refreshSalePlannerAnalysis(plan, items = []) {
  const outcomes = items
    .filter(item => item.appliedAt || item.status === "Applied" || item.status === "Removed")
    .map(item => analyseSalePlanItem(item))
    .filter(Boolean);
  writeSaleMarkdownOutcomes(plan.id, outcomes);
  const storedOutcomes = openOrderSqliteDb().prepare("SELECT * FROM sale_markdown_outcomes WHERE plan_id = ?").all(plan.id).map(saleOutcomeFromRow).filter(Boolean);
  writeSaleAnalysisActions(plan.id, buildSaleAnalysisActions(plan.id, storedOutcomes, items));
  return readSalePlannerAnalysis(plan.id, items);
}

async function readSalePlannerResponse(req, selectedPlanId = "") {
  const db = openOrderSqliteDb();
  const plans = db.prepare("SELECT * FROM sale_plans ORDER BY updated_at DESC LIMIT 25").all().map(salePlanFromRow);
  const selectedId = selectedPlanId || plans[0]?.id || "";
  const plan = selectedId ? salePlanFromRow(db.prepare("SELECT * FROM sale_plans WHERE id = ?").get(selectedId)) : null;
  const items = plan ? readSalePlannerItems(plan.id) : [];
  let collectionResult = { configured: Boolean(shopifyConfig().shop && shopifyConfig().clientId && shopifyConfig().clientSecret), collections: [] };
  try {
    collectionResult = await fetchShopifyCollectionsForSalePlanner();
  } catch (error) {
    collectionResult = { configured: true, message: error.message, collections: [] };
  }
  const config = readSalePlannerConfig();
  return {
    plans,
    plan,
    items,
    events: plan ? readSalePlannerEvents(plan.id) : [],
    metrics: salePlannerMetrics(items),
    analysis: plan ? readSalePlannerAnalysis(plan.id, items) : readSalePlannerAnalysis("", []),
    collectionConfig: config,
    collections: collectionResult.collections || [],
    shopifyConfigured: collectionResult.configured,
    shopifyMessage: collectionResult.message || "",
    canApply: userHasRole(req.currentUser, ["Admin"]),
    generatedAt: new Date().toISOString()
  };
}

async function handleSalePlannerGet(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  sendJson(res, 200, await readSalePlannerResponse(req, url.searchParams.get("planId") || ""));
}

async function handleSalePlannerConfig(req, res) {
  const body = await readJsonBody(req);
  const config = writeSalePlannerConfig(body.config || body);
  sendJson(res, 200, { ok: true, config, ...(await readSalePlannerResponse(req, body.planId || "")) });
}

async function handleSalePlannerAnalysisRefresh(req, res) {
  const body = await readJsonBody(req);
  const planId = String(body.planId || "").trim();
  if (!planId) throw new Error("Missing sale plan.");
  const db = openOrderSqliteDb();
  const plan = salePlanFromRow(db.prepare("SELECT * FROM sale_plans WHERE id = ?").get(planId));
  if (!plan) throw new Error("Sale plan not found.");
  const items = readSalePlannerItems(planId);
  const analysis = refreshSalePlannerAnalysis(plan, items);
  recordSalePlanEvent(planId, "", "analysis_refresh", actorName(req), "Sale markdown analysis refreshed", {
    summary: analysis.summary,
    ...actorData(req)
  });
  sendJson(res, 200, { ok: true, analysis, ...(await readSalePlannerResponse(req, planId)) });
}

async function handleSalePlannerActionsUpdate(req, res) {
  const body = await readJsonBody(req);
  const ids = (body.actionIds || (body.actionId ? [body.actionId] : [])).map(String).filter(Boolean);
  if (!ids.length) throw new Error("Choose at least one analysis action.");
  const status = String(body.status || "").trim();
  const allowed = new Set(["Pending", "Accepted", "Ignored", "Snoozed", "Applied"]);
  if (!allowed.has(status)) throw new Error("Choose a valid action status.");
  const db = openOrderSqliteDb();
  const placeholders = ids.map(() => "?").join(",");
  const rows = db.prepare(`SELECT * FROM sale_analysis_actions WHERE id IN (${placeholders})`).all(...ids).map(saleAnalysisActionFromRow);
  if (!rows.length) throw new Error("Analysis actions were not found.");
  db.prepare(`
    UPDATE sale_analysis_actions
    SET status = ?,
        changed = CASE WHEN ? = 'Pending' THEN changed ELSE 0 END,
        decided_by = ?,
        decided_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
    WHERE id IN (${placeholders})
  `).run(status, status, actorName(req), ...ids);
  const planId = rows[0].planId;
  recordSalePlanEvent(planId, "", "analysis_actions", actorName(req), `${rows.length} analysis action${rows.length === 1 ? "" : "s"} marked ${status}`, {
    actionIds: rows.map(row => row.id),
    status,
    ...actorData(req)
  });
  sendJson(res, 200, { ok: true, updated: rows.map(row => row.id), ...(await readSalePlannerResponse(req, planId)) });
}

function createSalePlanRecord(input = {}, req = {}) {
  const id = crypto.randomUUID();
  const db = openOrderSqliteDb();
  db.prepare(`
    INSERT INTO sale_plans (id, name, status, source_type, source_label, created_by, data, created_at, updated_at, applied_at, removed_at)
    VALUES (@id, @name, @status, @sourceType, @sourceLabel, @createdBy, @data, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, @appliedAt, @removedAt)
  `).run({
    id,
    name: input.name || `Sale plan ${todayIsoDate()}`,
    status: input.status || "Draft",
    sourceType: input.sourceType || "sale_analysis",
    sourceLabel: input.sourceLabel || "Sale analysis",
    createdBy: actorName(req),
    data: JSON.stringify(input.data || { roundingRule: "nearest-pound" }),
    appliedAt: input.appliedAt || "",
    removedAt: input.removedAt || ""
  });
  recordSalePlanEvent(id, "", "created", actorName(req), "Sale plan created from analysis actions", actorData(req));
  return salePlanFromRow(db.prepare("SELECT * FROM sale_plans WHERE id = ?").get(id));
}

function actionVariantTargets(item, action) {
  const discount = Number(action.recommendedDiscountPercent || item.discountPercent || 0);
  return (item.variants || []).map(variant => {
    const original = Number(variant.saleOriginalPrice || variant.originalRrp || variant.originalPrice || item.originalPrice || 0);
    const targetPrice = action.actionType === "remove"
      ? original
      : salePlanner.targetPriceForDiscount(original, discount, "nearest-pound");
    return saleItemVariantWithTarget({
      ...variant,
      saleOriginalPrice: original,
      originalRrp: original,
      originalPrice: original,
      compareAtPrice: action.actionType === "remove" ? null : original,
      currentPrice: variant.currentPrice || item.currentPrice
    }, targetPrice, discount);
  });
}

function insertSaleItemFromAction(plan, sourceItem, action) {
  const variants = actionVariantTargets(sourceItem, action);
  const targetPrice = minPositive(variants.map(variant => variant.targetPrice), action.recommendedTargetPrice || sourceItem.targetPrice);
  const originalPrice = maxPositive(variants.map(variant => variant.saleOriginalPrice || variant.originalPrice), sourceItem.originalPrice);
  const status = action.actionType === "remove" ? "Applied" : "Planned";
  const warnings = [...new Set([
    ...(sourceItem.warnings || []),
    `Created from analysis action: ${action.reason}`
  ])];
  const metrics = {
    ...(sourceItem.metrics || {}),
    targetGpPct: saleItemTargetGpPct(variants),
    sourceActionId: action.id,
    analysisReason: action.reason
  };
  const data = {
    ...(sourceItem.data || {}),
    sourcePlanId: sourceItem.planId,
    sourceItemId: sourceItem.id,
    sourceActionId: action.id,
    analysisActionType: action.actionType
  };
  const params = {
    id: crypto.randomUUID(),
    planId: plan.id,
    productKey: sourceItem.productKey,
    shopifyProductId: sourceItem.shopifyProductId,
    legacyResourceId: sourceItem.legacyResourceId,
    title: sourceItem.title,
    handle: sourceItem.handle,
    sku: sourceItem.sku,
    productType: sourceItem.productType,
    season: sourceItem.season,
    imageUrl: sourceItem.imageUrl,
    currentPrice: sourceItem.currentPrice,
    originalPrice,
    compareAtPrice: action.actionType === "remove" ? sourceItem.compareAtPrice : originalPrice,
    targetPrice,
    discountPercent: action.actionType === "remove" ? sourceItem.discountPercent : action.recommendedDiscountPercent,
    stock: sourceItem.stock,
    units: sourceItem.units,
    revenue: sourceItem.revenue,
    coverWks: sourceItem.coverWks,
    riskScore: sourceItem.riskScore,
    rootSaleCollectionId: sourceItem.rootSaleCollectionId,
    childSaleCollectionId: sourceItem.childSaleCollectionId,
    status,
    warningsJson: JSON.stringify(warnings),
    variantsJson: JSON.stringify(variants),
    metricsJson: JSON.stringify(metrics),
    data: JSON.stringify(data),
    sourceType: "sale_analysis",
    sourceId: action.id,
    lastError: ""
  };
  return upsertSalePlanItem(params, "Sale analysis");
}

async function handleSalePlannerActionsCreatePlan(req, res) {
  const body = await readJsonBody(req);
  const sourcePlanId = String(body.planId || "").trim();
  const actionType = String(body.actionType || body.mode || "").trim();
  const ids = (body.actionIds || []).map(String).filter(Boolean);
  if (!sourcePlanId) throw new Error("Missing source sale plan.");
  if (!["deepen", "remove"].includes(actionType)) throw new Error("Choose deepen or remove actions.");
  if (!ids.length) throw new Error("Choose at least one analysis action.");
  const db = openOrderSqliteDb();
  const sourcePlan = salePlanFromRow(db.prepare("SELECT * FROM sale_plans WHERE id = ?").get(sourcePlanId));
  if (!sourcePlan) throw new Error("Source sale plan not found.");
  const placeholders = ids.map(() => "?").join(",");
  const actions = db.prepare(`
    SELECT *
    FROM sale_analysis_actions
    WHERE id IN (${placeholders})
      AND plan_id = ?
      AND action_type = ?
      AND status IN ('Pending', 'Accepted')
  `).all(...ids, sourcePlanId, actionType).map(saleAnalysisActionFromRow);
  if (!actions.length) throw new Error(`No ${actionType} actions are ready to plan.`);
  const sourceItems = new Map(readSalePlannerItems(sourcePlanId).map(item => [item.id, item]));
  const namePrefix = actionType === "remove" ? "Sale removals" : "Deeper markdowns";
  const plan = createSalePlanRecord({
    name: `${namePrefix} from ${sourcePlan.name} - ${todayIsoDate()}`,
    status: actionType === "remove" ? "Applied" : "Ready",
    sourceType: "sale_analysis",
    sourceLabel: sourcePlan.name,
    data: { roundingRule: "nearest-pound", sourcePlanId, actionType },
    appliedAt: actionType === "remove" ? new Date().toISOString() : ""
  }, req);
  const inserted = [];
  for (const action of actions) {
    const sourceItem = sourceItems.get(action.itemId);
    if (!sourceItem) continue;
    inserted.push(insertSaleItemFromAction(plan, sourceItem, action));
  }
  if (!inserted.length) throw new Error("No source sale items were available for those actions.");
  db.prepare(`
    UPDATE sale_analysis_actions
    SET status = 'Accepted',
        changed = 0,
        follow_up_plan_id = ?,
        decided_by = ?,
        decided_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
    WHERE id IN (${placeholders})
  `).run(plan.id, actorName(req), ...actions.map(action => action.id));
  recordSalePlanEvent(sourcePlanId, "", "analysis_follow_up", actorName(req), `${inserted.length} action${inserted.length === 1 ? "" : "s"} moved into ${plan.name}`, {
    followUpPlanId: plan.id,
    actionType,
    actionIds: actions.map(action => action.id),
    ...actorData(req)
  });
  sendJson(res, 200, { ok: true, plan, inserted, ...(await readSalePlannerResponse(req, plan.id)) });
}

function recomputeSaleItemVariants(item, discountPercent) {
  const ledgerLookup = saleLedgerLookup(readSaleLedgerRowsForProduct(item.shopifyProductId));
  const product = {
    price: item.currentPrice || item.originalPrice,
    compareAtPrice: item.compareAtPrice || item.originalPrice,
    variants: (item.variants || []).map(variant => ({
      ...variant,
      saleOriginalPrice: ledgerRowForVariant(ledgerLookup, variant)?.originalPrice || variant.saleOriginalPrice || variant.originalPrice || item.originalPrice,
      price: variant.currentPrice || variant.originalPrice || item.currentPrice,
      compareAtPrice: ledgerRowForVariant(ledgerLookup, variant)?.originalPrice || variant.compareAtPrice || variant.originalPrice || item.originalPrice
    }))
  };
  return salePlanner.variantSaleTargets(product, discountPercent, { roundingRule: "nearest-pound" });
}

async function handleSalePlannerItemsUpdate(req, res) {
  const body = await readJsonBody(req);
  const ids = (body.itemIds || (body.itemId ? [body.itemId] : [])).map(String).filter(Boolean);
  if (!ids.length) throw new Error("Choose at least one sale plan item.");
  const patch = body.patch || {};
  const db = openOrderSqliteDb();
  const updated = [];
  for (const id of ids) {
    const current = salePlanItemFromRow(db.prepare("SELECT * FROM sale_plan_items WHERE id = ?").get(id));
    if (!current) continue;
    let discountPercent = Object.prototype.hasOwnProperty.call(patch, "discountPercent") ? Math.max(0, Math.min(90, Number(patch.discountPercent || 0))) : current.discountPercent;
    let variants = current.variants || [];
    let targetPrice = current.targetPrice;
    if (Object.prototype.hasOwnProperty.call(patch, "discountPercent")) {
      variants = recomputeSaleItemVariants(current, discountPercent);
      targetPrice = variants.reduce((min, variant) => Math.min(min, Number(variant.targetPrice || Infinity)), Infinity);
      if (!Number.isFinite(targetPrice)) targetPrice = current.targetPrice;
    }
    if (Object.prototype.hasOwnProperty.call(patch, "discountPercent") || Object.prototype.hasOwnProperty.call(patch, "targetPrice")) {
      variants = await hydrateSaleItemVariantCosts(current, variants);
      variants = saleItemVariantsWithGp(variants);
    }
    if (Object.prototype.hasOwnProperty.call(patch, "targetPrice")) {
      targetPrice = Math.max(0, Number(patch.targetPrice || 0));
      if (current.originalPrice > 0 && targetPrice > 0) discountPercent = Math.round(((current.originalPrice - targetPrice) / current.originalPrice) * 100);
      variants = saleItemVariantsForManualTarget(variants, targetPrice, discountPercent);
    }
    const metrics = { ...(current.metrics || {}), targetGpPct: saleItemTargetGpPct(variants) };
    const warnings = new Set((current.warnings || []).filter(warning => !/below variant cost/i.test(String(warning))));
    for (const variant of variants) for (const warning of variant.warnings || []) warnings.add(warning);
    const nextStatus = Object.prototype.hasOwnProperty.call(patch, "status") ? String(patch.status || current.status).trim() : current.status;
    db.prepare(`
      UPDATE sale_plan_items
      SET target_price = @targetPrice,
          discount_percent = @discountPercent,
          root_sale_collection_id = @rootSaleCollectionId,
          child_sale_collection_id = @childSaleCollectionId,
          status = @status,
          warnings_json = @warningsJson,
          variants_json = @variantsJson,
          metrics_json = @metricsJson,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = @id
    `).run({
      id,
      targetPrice,
      discountPercent,
      rootSaleCollectionId: Object.prototype.hasOwnProperty.call(patch, "rootSaleCollectionId") ? String(patch.rootSaleCollectionId || "") : current.rootSaleCollectionId,
      childSaleCollectionId: Object.prototype.hasOwnProperty.call(patch, "childSaleCollectionId") ? String(patch.childSaleCollectionId || "") : current.childSaleCollectionId,
      status: ["Planned", "Applied", "Removed", "Error"].includes(nextStatus) ? nextStatus : current.status,
      warningsJson: JSON.stringify([...warnings]),
      variantsJson: JSON.stringify(variants),
      metricsJson: JSON.stringify(metrics)
    });
    recordSalePlanEvent(current.planId, id, "update", actorName(req), body.note || "Sale plan item updated", { patch, ...actorData(req) });
    updated.push(salePlanItemFromRow(db.prepare("SELECT * FROM sale_plan_items WHERE id = ?").get(id)));
  }
  const planId = updated[0]?.planId || body.planId || "";
  sendJson(res, 200, { ok: true, updated, ...(await readSalePlannerResponse(req, planId)) });
}

async function handleSalePlannerItemsRemove(req, res) {
  const body = await readJsonBody(req);
  const ids = (body.itemIds || (body.itemId ? [body.itemId] : [])).map(String).filter(Boolean);
  if (!ids.length) throw new Error("Choose at least one sale plan item to remove.");
  const db = openOrderSqliteDb();
  const rows = ids.map(id => salePlanItemFromRow(db.prepare("SELECT * FROM sale_plan_items WHERE id = ?").get(id))).filter(Boolean);
  if (!rows.length) throw new Error("Sale plan items were not found.");
  const applied = rows.filter(item => item.status === "Applied");
  if (applied.length) {
    throw new Error("Applied sale items must be removed from sale before they can be removed from the planner.");
  }
  const planId = rows[0].planId;
  const placeholders = rows.map(() => "?").join(",");
  for (const item of rows) {
    recordSalePlanEvent(item.planId, item.id, "removed_from_plan", actorName(req), "Product removed from sale planner", {
      title: item.title,
      status: item.status,
      ...actorData(req)
    });
  }
  db.prepare(`DELETE FROM sale_plan_items WHERE id IN (${placeholders})`).run(...rows.map(item => item.id));
  db.prepare("UPDATE sale_plans SET updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(planId);
  sendJson(res, 200, { ok: true, removed: rows.map(item => item.id), ...(await readSalePlannerResponse(req, planId)) });
}

const salePlannerJobs = new Map();

function publicSalePlannerJob(job) {
  if (!job) return null;
  return {
    id: job.id,
    mode: job.mode,
    status: job.status,
    planId: job.planId,
    totalItems: job.totalItems,
    processedItems: job.processedItems,
    okItems: job.okItems,
    errorItems: job.errorItems,
    message: job.message,
    error: job.error,
    results: job.results,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt
  };
}

function priceClose(left, right) {
  return Math.abs(Number(left || 0) - Number(right || 0)) <= 0.01;
}

function variantsById(variants = []) {
  const map = new Map();
  for (const variant of variants || []) if (variant.id) map.set(String(variant.id), variant);
  return map;
}

function salePlanHasStaleManualTarget(item) {
  const variants = item.variants || [];
  if (!(Number(item.targetPrice || 0) > 0) || !variants.length) return false;
  const rowDiscount = Math.round(Number(item.discountPercent || 0));
  const variantTargetsMatchRow = variants.every(variant => priceClose(variant.targetPrice, item.targetPrice));
  const variantDiscountsMatchRow = variants.every(variant => Math.round(Number(variant.discountPercent || 0)) === rowDiscount);
  return !variantTargetsMatchRow && !variantDiscountsMatchRow;
}

function salePlanVariantsForApply(item) {
  if (salePlanHasStaleManualTarget(item)) {
    return saleItemVariantsForManualTarget(item.variants || [], item.targetPrice, item.discountPercent);
  }
  return item.variants || [];
}

function persistSaleItemVariantPlan(item, variants) {
  const metrics = { ...(item.metrics || {}), targetGpPct: saleItemTargetGpPct(variants) };
  const warnings = new Set((item.warnings || []).filter(warning => !/below variant cost/i.test(String(warning))));
  for (const variant of variants) for (const warning of variant.warnings || []) warnings.add(warning);
  openOrderSqliteDb().prepare(`
    UPDATE sale_plan_items
    SET variants_json = @variantsJson,
        metrics_json = @metricsJson,
        warnings_json = @warningsJson,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = @id
  `).run({
    id: item.id,
    variantsJson: JSON.stringify(variants),
    metricsJson: JSON.stringify(metrics),
    warningsJson: JSON.stringify([...warnings])
  });
}

function validateLiveVariantState(item, liveProduct) {
  if (!liveProduct) return ["Product was not found in Shopify."];
  const errors = [];
  const liveById = variantsById(liveProduct.variants || []);
  const ledgerLookup = saleLedgerLookup(readSaleLedgerRowsForProduct(item.shopifyProductId));
  for (const planned of item.variants || []) {
    const live = liveById.get(String(planned.id || ""));
    if (!live) {
      errors.push(`Variant ${planned.sku || planned.id} was not found in Shopify.`);
      continue;
    }
    const alreadyOnSale = Number(live.compareAtPrice || 0) > Number(live.price || 0);
    if (!priceClose(live.price, planned.currentPrice) && !(item.status === "Applied" && alreadyOnSale)) {
      errors.push(`Variant ${planned.sku || planned.id} price changed from ${planned.currentPrice} to ${live.price}.`);
    }
    const ledger = ledgerRowForVariant(ledgerLookup, planned);
    const plannedCompare = Number(ledger?.originalPrice || 0) || (Number(planned.currentPrice || 0) < Number(planned.originalPrice || 0) ? Number(planned.originalPrice || 0) : Number(item.compareAtPrice || 0));
    if (!ledger && plannedCompare > 0 && live.compareAtPrice != null && !priceClose(live.compareAtPrice, plannedCompare)) {
      errors.push(`Variant ${planned.sku || planned.id} compare-at price changed.`);
    }
  }
  return errors;
}

async function submitProductVariantPriceUpdate(productId, variants, allowPartialUpdates = false) {
  const data = await shopifyGraphql(`
    mutation SalePlannerVariantUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!, $allowPartialUpdates: Boolean) {
      productVariantsBulkUpdate(productId: $productId, variants: $variants, allowPartialUpdates: $allowPartialUpdates) {
        product { id title }
        productVariants { id price compareAtPrice }
        userErrors { field message }
      }
    }
  `, { productId, variants, allowPartialUpdates });
  const payload = data.productVariantsBulkUpdate || {};
  const errors = payload.userErrors || [];
  if (errors.length) throw new Error(errors.map(error => error.message).join("; "));
  return payload;
}

async function submitCollectionAddProducts(collectionId, productIds) {
  if (!collectionId || !productIds.length) return null;
  const data = await shopifyGraphql(`
    mutation SalePlannerCollectionAdd($id: ID!, $productIds: [ID!]!) {
      collectionAddProducts(id: $id, productIds: $productIds) {
        collection { id title }
        userErrors { field message }
      }
    }
  `, { id: collectionId, productIds });
  const payload = data.collectionAddProducts || {};
  const errors = payload.userErrors || [];
  if (errors.length) throw new Error(errors.map(error => error.message).join("; "));
  return payload.collection || null;
}

async function submitCollectionRemoveProducts(collectionId, productIds) {
  if (!collectionId || !productIds.length) return null;
  const data = await shopifyGraphql(`
    mutation SalePlannerCollectionRemove($id: ID!, $productIds: [ID!]!) {
      collectionRemoveProducts(id: $id, productIds: $productIds) {
        job { id done }
        userErrors { field message }
      }
    }
  `, { id: collectionId, productIds });
  const payload = data.collectionRemoveProducts || {};
  const errors = payload.userErrors || [];
  if (errors.length) throw new Error(errors.map(error => error.message).join("; "));
  if (payload.job?.id) await pollShopifyJob(payload.job.id);
  return payload.job || null;
}

async function submitProductStatusMetafield(productId, value) {
  if (!productId) return null;
  const data = await shopifyGraphql(`
    mutation SalePlannerProductStatus($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields { id namespace key value }
        userErrors { field message }
      }
    }
  `, {
    metafields: [{
      ownerId: productId,
      namespace: "custom",
      key: "product_status",
      type: "single_line_text_field",
      value
    }]
  });
  const payload = data.metafieldsSet || {};
  const errors = payload.userErrors || [];
  if (errors.length) throw new Error(errors.map(error => error.message).join("; "));
  return payload.metafields?.[0] || null;
}

function validateLiveProductStatus(liveProduct) {
  const status = String(liveProduct?.productStatusCode || "").trim().toUpperCase();
  if (status && !["N", "S"].includes(status)) return [`Product Status metafield is ${status}; expected N or S.`];
  return [];
}

function prepareSaleVariantsWithLedger(item, liveProduct, plannedVariants) {
  const liveById = variantsById(liveProduct?.variants || []);
  const lookup = saleLedgerLookup(readSaleLedgerRowsForProduct(item.shopifyProductId));
  return (plannedVariants || []).map(planned => {
    const live = liveById.get(String(planned.id || "")) || {};
    const ledger = ledgerRowForVariant(lookup, planned);
    const originalPrice = saleOriginalPriceFromSources(planned, live, ledger, item);
    const discountPercent = Number(planned.discountPercent || item.discountPercent || 0);
    const oldAlgorithmTarget = salePlanner.targetPriceForDiscount(planned.originalPrice || item.originalPrice, discountPercent, "nearest-pound");
    const rebasedTarget = salePlanner.targetPriceForDiscount(originalPrice, discountPercent, "nearest-pound");
    const targetPrice = !priceClose(originalPrice, planned.originalPrice) && priceClose(planned.targetPrice, oldAlgorithmTarget)
      ? rebasedTarget
      : Number(planned.targetPrice || item.targetPrice || rebasedTarget);
    return {
      ...planned,
      saleOriginalPrice: originalPrice,
      originalRrp: originalPrice,
      originalPrice,
      compareAtPrice: originalPrice,
      currentPrice: Number(live.price || planned.currentPrice || item.currentPrice || 0),
      targetPrice: salePlanner.money(targetPrice),
      discountPercent,
      targetGpPct: salePlanner.gpPercentFromRetail(targetPrice, planned.cost)
    };
  });
}

function persistSaleLedgerApply(item, variants) {
  const db = openOrderSqliteDb();
  const insert = db.prepare(`
    INSERT INTO sale_state_ledger (
      id, shopify_product_id, variant_id, sku, product_key, product_title, product_type, season,
      original_price, first_sale_price, current_sale_price, discount_percent, status,
      first_plan_id, first_item_id, last_plan_id, last_item_id, applied_at, removed_at, data,
      created_at, updated_at
    ) VALUES (
      @id, @shopifyProductId, @variantId, @sku, @productKey, @productTitle, @productType, @season,
      @originalPrice, @firstSalePrice, @currentSalePrice, @discountPercent, 'Active',
      @planId, @itemId, @planId, @itemId, CURRENT_TIMESTAMP, NULL, @data,
      CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    )
    ON CONFLICT(shopify_product_id, variant_id) DO UPDATE SET
      sku = excluded.sku,
      product_key = excluded.product_key,
      product_title = excluded.product_title,
      product_type = excluded.product_type,
      season = excluded.season,
      original_price = CASE
        WHEN sale_state_ledger.original_price > 0 THEN sale_state_ledger.original_price
        ELSE excluded.original_price
      END,
      first_sale_price = CASE
        WHEN sale_state_ledger.first_sale_price > 0 THEN sale_state_ledger.first_sale_price
        ELSE excluded.first_sale_price
      END,
      current_sale_price = excluded.current_sale_price,
      discount_percent = excluded.discount_percent,
      status = 'Active',
      last_plan_id = excluded.last_plan_id,
      last_item_id = excluded.last_item_id,
      applied_at = CURRENT_TIMESTAMP,
      removed_at = NULL,
      data = excluded.data,
      updated_at = CURRENT_TIMESTAMP
  `);
  for (const variant of variants || []) {
    if (!variant.id) continue;
    insert.run({
      id: crypto.randomUUID(),
      shopifyProductId: item.shopifyProductId,
      variantId: variant.id,
      sku: variant.sku || item.sku || "",
      productKey: item.productKey || "",
      productTitle: item.title || "",
      productType: item.productType || "",
      season: item.season || "",
      originalPrice: Number(variant.saleOriginalPrice || variant.originalPrice || item.originalPrice || 0),
      firstSalePrice: Number(variant.targetPrice || item.targetPrice || 0),
      currentSalePrice: Number(variant.targetPrice || item.targetPrice || 0),
      discountPercent: Number(variant.discountPercent || item.discountPercent || 0),
      planId: item.planId,
      itemId: item.id,
      data: JSON.stringify({ source: "sale_planner_apply" })
    });
  }
}

function markSaleLedgerRemoved(item, variantIds = []) {
  const db = openOrderSqliteDb();
  if (!item.shopifyProductId) return;
  if (variantIds.length) {
    const placeholders = variantIds.map(() => "?").join(",");
    db.prepare(`
      UPDATE sale_state_ledger
      SET status = 'Removed',
          current_sale_price = 0,
          last_plan_id = ?,
          last_item_id = ?,
          removed_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      WHERE shopify_product_id = ?
        AND variant_id IN (${placeholders})
    `).run(item.planId, item.id, item.shopifyProductId, ...variantIds);
    return;
  }
  db.prepare(`
    UPDATE sale_state_ledger
    SET status = 'Removed',
        current_sale_price = 0,
        last_plan_id = ?,
        last_item_id = ?,
        removed_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
    WHERE shopify_product_id = ?
  `).run(item.planId, item.id, item.shopifyProductId);
}

function minPositive(values = [], fallback = 0) {
  const positives = values.map(Number).filter(value => Number.isFinite(value) && value > 0);
  return positives.length ? Math.min(...positives) : fallback;
}

function maxPositive(values = [], fallback = 0) {
  const positives = values.map(Number).filter(value => Number.isFinite(value) && value > 0);
  return positives.length ? Math.max(...positives) : fallback;
}

function persistSaleItemAppliedPricing(item, variants = []) {
  const currentPrice = minPositive(variants.map(variant => variant.targetPrice), item.targetPrice);
  const originalPrice = maxPositive(variants.map(variant => variant.saleOriginalPrice || variant.originalPrice), item.originalPrice);
  openOrderSqliteDb().prepare(`
    UPDATE sale_plan_items
    SET current_price = @currentPrice,
        original_price = @originalPrice,
        compare_at_price = @originalPrice,
        target_price = @currentPrice,
        variants_json = @variantsJson,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = @id
  `).run({
    id: item.id,
    currentPrice,
    originalPrice,
    variantsJson: JSON.stringify(variants)
  });
}

function persistSaleItemRemovedPricing(item, targets = []) {
  const restoredPrice = minPositive(targets.map(target => target.restoredPrice), item.originalPrice || item.currentPrice);
  openOrderSqliteDb().prepare(`
    UPDATE sale_plan_items
    SET current_price = @restoredPrice,
        compare_at_price = 0,
        target_price = @restoredPrice,
        variants_json = @variantsJson,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = @id
  `).run({
    id: item.id,
    restoredPrice,
    variantsJson: JSON.stringify((targets || []).map(target => ({
      id: target.id,
      sku: target.sku,
      title: target.title,
      currentPrice: target.restoredPrice,
      originalPrice: target.restoredPrice,
      targetPrice: target.restoredPrice,
      compareAtPrice: null,
      warnings: target.warnings || []
    })))
  });
}

function saleRemoveTargetsWithLedger(item, liveProduct) {
  const lookup = saleLedgerLookup(readSaleLedgerRowsForProduct(item.shopifyProductId));
  const product = {
    ...liveProduct,
    variants: (liveProduct?.variants || []).map(variant => {
      const ledger = ledgerRowForVariant(lookup, variant);
      return ledger?.originalPrice ? {
        ...variant,
        saleOriginalPrice: ledger.originalPrice,
        originalRrp: ledger.originalPrice,
        originalPrice: ledger.originalPrice
      } : variant;
    })
  };
  return salePlanner.removeSaleTargets(product);
}

function markSaleItemResult(item, status, result = {}) {
  const db = openOrderSqliteDb();
  db.prepare(`
    UPDATE sale_plan_items
    SET status = @status,
        last_error = @lastError,
        updated_at = CURRENT_TIMESTAMP,
        applied_at = CASE WHEN @status = 'Applied' THEN CURRENT_TIMESTAMP ELSE applied_at END,
        removed_at = CASE WHEN @status = 'Removed' THEN CURRENT_TIMESTAMP ELSE removed_at END
    WHERE id = @id
  `).run({ id: item.id, status, lastError: result.error || "" });
  recordSalePlanEvent(item.planId, item.id, status.toLowerCase(), result.actor || "", result.message || `Sale item ${status.toLowerCase()}`, result.data || {});
}

async function applySalePlanItem(job, item) {
  if (!item.shopifyProductId) throw new Error("Shopify product ID is missing.");
  let plannedVariants = salePlanVariantsForApply(item);
  if (!plannedVariants.length) throw new Error("Variant price targets are missing.");
  if (salePlanHasStaleManualTarget(item)) {
    persistSaleItemVariantPlan(item, plannedVariants);
    item = { ...item, variants: plannedVariants, metrics: { ...(item.metrics || {}), targetGpPct: saleItemTargetGpPct(plannedVariants) } };
  }
  const live = await fetchShopifyProductSaleState(item.shopifyProductId);
  const staleErrors = [...validateLiveVariantState(item, live), ...validateLiveProductStatus(live)];
  if (staleErrors.length) throw new Error(`Plan is stale: ${staleErrors.join(" ")}`);
  plannedVariants = prepareSaleVariantsWithLedger(item, live, plannedVariants);
  persistSaleItemVariantPlan(item, plannedVariants);
  const variantInputs = plannedVariants.map(variant => ({
    id: variant.id,
    price: String(Number(variant.targetPrice || 0).toFixed(2)),
    compareAtPrice: String(Number(variant.saleOriginalPrice || variant.originalPrice || item.originalPrice || 0).toFixed(2))
  }));
  await submitProductVariantPriceUpdate(item.shopifyProductId, variantInputs, false);
  persistSaleLedgerApply(item, plannedVariants);
  persistSaleItemAppliedPricing(item, plannedVariants);
  const collectionIds = [...new Set([item.rootSaleCollectionId, item.childSaleCollectionId].filter(Boolean))];
  for (const collectionId of collectionIds) {
    await submitCollectionAddProducts(collectionId, [item.shopifyProductId]);
  }
  await submitProductStatusMetafield(item.shopifyProductId, "S");
  markSaleItemResult(item, "Applied", {
    actor: job.actor,
    message: "Sale prices applied to Shopify",
    data: { collections: collectionIds, variants: variantInputs.map(variant => variant.id), productStatus: "S" }
  });
}

async function removeSalePlanItem(job, item) {
  if (!item.shopifyProductId) throw new Error("Shopify product ID is missing.");
  const live = await fetchShopifyProductSaleState(item.shopifyProductId);
  if (!live) throw new Error("Product was not found in Shopify.");
  const statusErrors = validateLiveProductStatus(live);
  if (statusErrors.length) throw new Error(`Plan is stale: ${statusErrors.join(" ")}`);
  const targets = saleRemoveTargetsWithLedger(item, live);
  const variantInputs = targets.map(target => ({
    id: target.id,
    price: String(Number(target.restoredPrice || 0).toFixed(2)),
    compareAtPrice: null
  }));
  await submitProductVariantPriceUpdate(item.shopifyProductId, variantInputs, false);
  const collectionIds = [...new Set([item.rootSaleCollectionId, item.childSaleCollectionId].filter(Boolean))];
  for (const collectionId of collectionIds) {
    await submitCollectionRemoveProducts(collectionId, [item.shopifyProductId]);
  }
  await submitProductStatusMetafield(item.shopifyProductId, "N");
  markSaleLedgerRemoved(item, variantInputs.map(variant => variant.id).filter(Boolean));
  persistSaleItemRemovedPricing(item, targets);
  markSaleItemResult(item, "Removed", {
    actor: job.actor,
    message: "Product removed from sale",
    data: { collections: collectionIds, variants: variantInputs.map(variant => variant.id), productStatus: "N", warnings: targets.flatMap(target => target.warnings || []) }
  });
}

async function runSalePlannerJob(job) {
  try {
    job.status = "running";
    const items = readSalePlannerItems(job.planId).filter(item => job.itemIds.includes(item.id));
    job.totalItems = items.length;
    openOrderSqliteDb().prepare("UPDATE sale_plans SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(job.mode === "remove" ? "Removing" : "Applying", job.planId);
    for (const item of items) {
      job.message = `${job.mode === "remove" ? "Removing" : "Applying"} ${item.title}...`;
      try {
        if (job.mode === "remove") await removeSalePlanItem(job, item);
        else await applySalePlanItem(job, item);
        job.okItems += 1;
        job.results.push({ itemId: item.id, title: item.title, ok: true });
      } catch (error) {
        job.errorItems += 1;
        const message = error.message || "Shopify sale update failed.";
        markSaleItemResult(item, "Error", { actor: job.actor, error: message, message, data: { mode: job.mode } });
        job.results.push({ itemId: item.id, title: item.title, ok: false, error: message });
      }
      job.processedItems += 1;
    }
    const finalStatus = job.errorItems ? "error" : "complete";
    job.status = finalStatus;
    job.message = job.errorItems
      ? `${job.okItems} item${job.okItems === 1 ? "" : "s"} completed, ${job.errorItems} failed.`
      : `${job.okItems} item${job.okItems === 1 ? "" : "s"} ${job.mode === "remove" ? "removed from sale" : "applied to sale"}.`;
    job.finishedAt = new Date().toISOString();
    const remaining = readSalePlannerItems(job.planId);
    const planStatus = job.mode === "remove"
      ? remaining.some(item => item.status !== "Removed") ? "Applied" : "Removed"
      : remaining.some(item => item.status === "Planned") ? "Ready" : "Applied";
    openOrderSqliteDb().prepare(`
      UPDATE sale_plans
      SET status = @status,
          updated_at = CURRENT_TIMESTAMP,
          applied_at = CASE WHEN @mode = 'apply' AND @errorItems = 0 THEN CURRENT_TIMESTAMP ELSE applied_at END,
          removed_at = CASE WHEN @mode = 'remove' AND @errorItems = 0 THEN CURRENT_TIMESTAMP ELSE removed_at END
      WHERE id = @planId
    `).run({ status: planStatus, mode: job.mode, errorItems: job.errorItems, planId: job.planId });
    recordSalePlanEvent(job.planId, "", job.mode === "remove" ? "remove_job" : "apply_job", job.actor, job.message, { job: publicSalePlannerJob(job) });
  } catch (error) {
    job.status = "error";
    job.error = error.message;
    job.message = error.message;
    job.finishedAt = new Date().toISOString();
  }
}

async function startSalePlannerJob(req, res, mode = "apply") {
  const body = await readJsonBody(req);
  const planId = String(body.planId || "").trim();
  if (!planId) throw new Error("Missing sale plan.");
  const db = openOrderSqliteDb();
  const plan = salePlanFromRow(db.prepare("SELECT * FROM sale_plans WHERE id = ?").get(planId));
  if (!plan) throw new Error("Sale plan not found.");
  const requested = (body.itemIds || []).map(String).filter(Boolean);
  const items = readSalePlannerItems(planId).filter(item => requested.length ? requested.includes(item.id) : mode === "remove" ? item.status === "Applied" : item.status === "Planned");
  if (!items.length) throw new Error(mode === "remove" ? "Choose applied sale items to remove." : "Choose planned sale items to apply.");
  const confirmText = String(body.confirmText || "").trim().toUpperCase();
  const hasFinal = items.some(item => Number(item.discountPercent || 0) >= 50);
  const expected = mode === "remove" ? "REMOVE" : hasFinal ? "FINAL SALE" : "APPLY";
  if (confirmText !== expected) {
    sendJson(res, 400, { message: `Type ${expected} to confirm this Shopify sale ${mode === "remove" ? "removal" : "apply"}.` });
    return;
  }
  const job = {
    id: crypto.randomUUID(),
    mode,
    status: "queued",
    planId,
    itemIds: items.map(item => item.id),
    totalItems: items.length,
    processedItems: 0,
    okItems: 0,
    errorItems: 0,
    results: [],
    actor: actorName(req),
    message: mode === "remove" ? "Queued sale removal." : "Queued Shopify sale apply.",
    error: "",
    startedAt: new Date().toISOString(),
    finishedAt: ""
  };
  salePlannerJobs.set(job.id, job);
  runSalePlannerJob(job);
  sendJson(res, 202, { ok: true, job: publicSalePlannerJob(job) });
}

function getSalePlannerJob(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const job = salePlannerJobs.get(url.searchParams.get("id"));
  if (!job) {
    sendJson(res, 404, { message: "Sale planner job not found. If the server restarted, refresh the planner and verify Shopify before retrying." });
    return;
  }
  sendJson(res, 200, { job: publicSalePlannerJob(job) });
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
  sqlite.prepare("UPDATE order_receipt_lines SET order_id = ? WHERE order_id = ?").run(to, from);
  sqlite.prepare("UPDATE order_discrepancies SET order_id = ? WHERE order_id = ?").run(to, from);
  sqlite.prepare("UPDATE work_handoffs SET entity_id = ? WHERE entity_type = 'order' AND entity_id = ?").run(to, from);
  sqlite.prepare("UPDATE notifications SET entity_id = ? WHERE entity_type = 'order' AND entity_id = ?").run(to, from);
}

function migrateReissuedOrderLineSkus(sqlite, storedOrder) {
  const migrations = new Map();
  for (const line of storedOrder.lines || []) {
    const fromSku = normalizeSku(line.reissuedFromSku);
    const toSku = normalizeSku(line.sku);
    if (!fromSku || !toSku || fromSku === toSku) {
      delete line.reissuedFromSku;
      continue;
    }
    if (migrations.has(fromSku) && migrations.get(fromSku) !== toSku) {
      throw new Error(`SKU ${fromSku} cannot be reissued to two different SKUs in one order.`);
    }
    migrations.set(fromSku, toSku);
  }
  if (!migrations.size) return [];

  const orderRows = sqlite.prepare("SELECT id, data FROM orders").all();
  const updateOrder = sqlite.prepare("UPDATE orders SET data = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?");
  const updateProduct = sqlite.prepare(`
    UPDATE products
    SET sku = @toSku,
        shopify_product_gid = '',
        shopify_variant_gid = '',
        shopify_status = '',
        sync_status = @syncStatus,
        data = @data,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = @id
  `);

  for (const [fromSku, toSku] of migrations) {
    const oldRow = sqlite.prepare("SELECT * FROM products WHERE sku = ?").get(fromSku);
    const oldProduct = productFromRow(oldRow);
    if (oldProduct && productHasShopifyIdentity(oldProduct)) {
      throw new Error(`SKU ${fromSku} is already linked to Shopify and cannot be reissued locally.`);
    }
    const duplicate = sqlite.prepare("SELECT id FROM products WHERE sku = ?").get(toSku);
    if (duplicate && Number(duplicate.id) !== Number(oldRow?.id || 0)) {
      throw new Error(`Replacement SKU ${toSku} already belongs to another local product.`);
    }

    if (oldRow) {
      const skuHistory = [...new Set([...(oldProduct.skuHistory || []), fromSku])];
      const updatedProduct = {
        ...oldProduct,
        sku: toSku,
        skuHistory,
        shopifyProductGid: "",
        shopifyVariantGid: "",
        shopifyStatus: "",
        syncStatus: oldProduct.status === "Ready for Shopify" ? "Ready" : "Not synced"
      };
      updateProduct.run({
        id: oldRow.id,
        toSku,
        syncStatus: updatedProduct.syncStatus,
        data: JSON.stringify(updatedProduct)
      });
    }

    for (const orderRow of orderRows) {
      const order = parseJson(orderRow.data, null);
      if (!order?.lines?.some(line => normalizeSku(line.sku) === fromSku)) continue;
      order.lines = order.lines.map(line => normalizeSku(line.sku) === fromSku
        ? { ...line, sku: toSku, reissuedFromSku: undefined }
        : line);
      updateOrder.run(JSON.stringify(order), orderRow.id);
    }
    sqlite.prepare("UPDATE order_batch_lines SET sku = ? WHERE sku = ?").run(toSku, fromSku);
    sqlite.prepare("UPDATE order_receipt_lines SET sku = ? WHERE sku = ?").run(toSku, fromSku);
    sqlite.prepare("UPDATE order_discrepancies SET sku = ? WHERE sku = ?").run(toSku, fromSku);
    sqlite.prepare(`
      INSERT INTO issued_skus (sku, data, issued_at, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT(sku) DO UPDATE SET data = excluded.data, updated_at = CURRENT_TIMESTAMP
    `).run(toSku, JSON.stringify({ source: "reissue", previousSku: fromSku }));
  }

  for (const line of storedOrder.lines || []) delete line.reissuedFromSku;
  return [...migrations].map(([fromSku, toSku]) => ({ fromSku, toSku }));
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
    .map(line => {
      const previousProduct = existingByNormalized(dbData.products || [], "sku", line.reissuedFromSku);
      const existingProduct = existingByNormalized(dbData.products || [], "sku", line.sku) || previousProduct || {};
      const skuHistory = previousProduct
        ? [...new Set([...(previousProduct.skuHistory || []), normalizeSku(line.reissuedFromSku)])]
        : existingProduct.skuHistory;
      return mergeNonEmpty(
      existingProduct,
      {
        ...line,
        skuHistory,
        supplierName: storedOrder.supplier?.name || line.supplierName || ""
      },
      {
        sku: normalizeSku(line.sku),
        lastOrderNumber: storedOrder.orderNumber,
        lastOrderedAt: storedOrder.savedAt
      }
    );
    });

  const write = sqlite.transaction(() => {
    migrateReissuedOrderLineSkus(sqlite, storedOrder);
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
    skuHistory: Array.isArray(data.skuHistory) ? data.skuHistory.map(normalizeSku).filter(Boolean) : [],
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
    optionValue: cleanText(merged.size || merged.optionValue || firstNonEmpty(merged, ["Option1 Value"]) || "One Size Fits UK 8 to 18"),
    unitCostGbp: numberOrZero(merged.unitCostGbp ?? merged.unitCost ?? firstNonEmpty(merged, ["Cost per item"])),
    unitCostEur: numberOrZero(merged.unitCostEur),
    rrp: numberOrZero(merged.rrp ?? firstNonEmpty(merged, ["Variant Price"])),
    compareAtPrice: numberOrZero(merged.compareAtPrice ?? firstNonEmpty(merged, ["Variant Compare At Price"])),
    barcode: cleanShopifyExportValue(merged.barcode || firstNonEmpty(merged, ["Variant Barcode"]) || sku),
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
    skuHistory: [...new Set((merged.skuHistory || existing.skuHistory || []).map(normalizeSku).filter(Boolean))],
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

function deleteCatalogProduct(identifier) {
  const product = findCatalogProduct(identifier);
  if (!product) throw new Error("Product not found.");
  const sqlite = openOrderSqliteDb();
  const sku = normalizeSku(product.sku);
  const orderReferences = readOrderDb().orders.filter(order => orderContainsSku(order, sku));
  const batchReferenceCount = sqlite.prepare("SELECT COUNT(*) AS count FROM order_batch_lines WHERE sku = ?").get(sku).count;
  const receiptReferenceCount = sqlite.prepare("SELECT COUNT(*) AS count FROM order_receipt_lines WHERE sku = ?").get(sku).count;
  const discrepancyReferenceCount = sqlite.prepare("SELECT COUNT(*) AS count FROM order_discrepancies WHERE sku = ?").get(sku).count;
  if (orderReferences.length || batchReferenceCount || receiptReferenceCount || discrepancyReferenceCount) {
    const orderNumbers = orderReferences.slice(0, 4).map(order => order.orderNumber).filter(Boolean);
    const suffix = orderReferences.length > orderNumbers.length ? ", …" : "";
    const detail = orderNumbers.length ? ` Order${orderNumbers.length === 1 ? "" : "s"}: ${orderNumbers.join(", ")}${suffix}.` : "";
    const error = new Error(`SKU ${sku} is still referenced by an order, supplier batch, receipt, or discrepancy and cannot be deleted.${detail}`);
    error.code = "product_referenced";
    throw error;
  }

  const remove = sqlite.transaction(() => {
    sqlite.prepare("DELETE FROM product_sync_events WHERE product_id = ?").run(product.id);
    return sqlite.prepare("DELETE FROM products WHERE id = ?").run(product.id).changes;
  });
  if (!remove()) throw new Error("Product could not be deleted.");
  return {
    id: product.id,
    sku,
    title: product.title || product.style || "",
    shopifyLinked: productHasShopifyIdentity(product)
  };
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
  const creditSummaries = supplierCreditSummaries();
  return sqlite.prepare("SELECT * FROM suppliers ORDER BY name COLLATE NOCASE").all()
    .map(row => {
      const supplier = supplierFromRow(row);
      return { ...supplier, history: supplierHistory(supplier.name), creditBalance: supplierCreditSummary(supplier.name, creditSummaries) };
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
  const optionValue = cleanText(product.size || product.optionValue || "One Size Fits UK 8 to 18") || "One Size Fits UK 8 to 18";
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

function captureShopifyMerchandising(range, options = {}) {
  return new Promise((resolve, reject) => {
    let statusCode = 200;
    const limit = options.limit || "all";
    const updatedSince = options.updatedSince ? `&updatedSince=${encodeURIComponent(options.updatedSince)}` : "";
    const req = { url: `/api/shopify-merchandising?startDate=${encodeURIComponent(range.startDate)}&endDate=${encodeURIComponent(range.endDate)}&limit=${encodeURIComponent(limit)}${updatedSince}`, headers: { host: "localhost" } };
    const res = {
      writeHead(status) { statusCode = status; },
      end(body) {
        const payload = parseJson(body, {});
        if (statusCode >= 400) reject(new Error(payload.message || payload.error || "Could not load Shopify products."));
        else resolve(payload);
      }
    };
    fetchShopifyMerchandising(req, res).catch(reject);
  });
}

function parseNamedDateRange(url, startParam, endParam, fallbackDays = 30) {
  const requestedStart = url.searchParams.get(startParam) || "";
  const requestedEnd = url.searchParams.get(endParam) || "";
  if (validReportDate(requestedStart) && validReportDate(requestedEnd)) {
    const start = new Date(`${requestedStart}T00:00:00.000Z`);
    const end = new Date(`${requestedEnd}T00:00:00.000Z`);
    if (Number.isFinite(start.getTime()) && Number.isFinite(end.getTime()) && start <= end) {
      const maxEnd = new Date(start);
      maxEnd.setUTCDate(maxEnd.getUTCDate() + 366);
      if (end > maxEnd) end.setTime(maxEnd.getTime());
      return { startDate: isoDateOnly(start), endDate: isoDateOnly(end) };
    }
  }
  return dateRangeFromDays(fallbackDays);
}

function dateOnlyFromIso(value) {
  const raw = String(value || "").trim();
  if (validReportDate(raw)) return raw;
  const date = raw ? new Date(raw) : null;
  return date && Number.isFinite(date.getTime()) ? isoDateOnly(date) : "";
}

function dateInRange(dateValue, range) {
  const day = dateOnlyFromIso(dateValue);
  return Boolean(day && day >= range.startDate && day <= range.endDate);
}

function daysBetweenDateOnly(startValue, endValue) {
  const startDate = dateOnlyFromIso(startValue);
  const endDate = dateOnlyFromIso(endValue);
  if (!startDate || !endDate) return 0;
  const start = new Date(`${startDate}T00:00:00.000Z`);
  const end = new Date(`${endDate}T00:00:00.000Z`);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end < start) return 0;
  return Math.floor((end - start) / 864e5);
}

function activeDaysInPerformance(liveAt, range) {
  const liveDate = dateOnlyFromIso(liveAt);
  if (!liveDate || liveDate > range.endDate) return 0;
  const startDate = liveDate > range.startDate ? liveDate : range.startDate;
  return daysBetweenDateOnly(startDate, range.endDate) + 1;
}

function addDaysDateOnly(dateValue, days) {
  const day = dateOnlyFromIso(dateValue);
  if (!day) return "";
  const date = new Date(`${day}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime())) return "";
  date.setUTCDate(date.getUTCDate() + Number(days || 0));
  return isoDateOnly(date);
}

function minDateOnly(...values) {
  return values.map(dateOnlyFromIso).filter(Boolean).sort()[0] || "";
}

function maxDateOnly(...values) {
  return values.map(dateOnlyFromIso).filter(Boolean).sort().pop() || "";
}

function roundMetric(value, places = 2) {
  const factor = 10 ** places;
  return Math.round(Number(value || 0) * factor) / factor;
}

function summarizeDailyProductMetrics(orderDailyMetrics, gaDailyMetrics, productId, range) {
  const days = reportDaysInclusive(range);
  const orderByDate = orderDailyMetrics?.get(productId) || new Map();
  const gaByDate = gaDailyMetrics?.get(productId) || new Map();
  const summary = {
    range,
    days,
    revenue: 0,
    units: 0,
    revenuePerDay: 0,
    unitsPerDay: 0,
    views: 0,
    adds: 0,
    purchases: 0,
    gaRevenue: 0,
    viewsPerDay: 0,
    addsPerDay: 0,
    cvr: 0
  };
  if (!days) return summary;
  const cursor = new Date(`${range.startDate}T00:00:00.000Z`);
  const end = new Date(`${range.endDate}T00:00:00.000Z`);
  while (cursor <= end) {
    const day = isoDateOnly(cursor);
    const orderMetric = orderByDate.get(day) || {};
    const gaMetric = gaByDate.get(day) || {};
    summary.revenue += Number(orderMetric.revenue || 0);
    summary.units += Number(orderMetric.units || 0);
    summary.views += Number(gaMetric.views || 0);
    summary.adds += Number(gaMetric.adds || 0);
    summary.purchases += Number(gaMetric.purchases || 0);
    summary.gaRevenue += Number(gaMetric.gaRevenue || 0);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  summary.revenue = roundMetric(summary.revenue, 2);
  summary.revenuePerDay = roundMetric(summary.revenue / days, 2);
  summary.unitsPerDay = roundMetric(summary.units / days, 2);
  summary.viewsPerDay = roundMetric(summary.views / days, 2);
  summary.addsPerDay = roundMetric(summary.adds / days, 2);
  summary.gaRevenue = roundMetric(summary.gaRevenue, 2);
  summary.cvr = summary.views > 0 ? roundMetric(summary.units / summary.views, 4) : 0;
  return summary;
}

function imageImpactForProduct(product, imageDate, options) {
  const impactDays = Math.max(1, Number(options.impactDays || 14));
  const afterStart = dateOnlyFromIso(imageDate);
  const afterHardEnd = addDaysDateOnly(afterStart, impactDays - 1);
  const afterEnd = minDateOnly(afterHardEnd, options.performanceRange.endDate);
  const beforeEnd = addDaysDateOnly(afterStart, -1);
  const beforeStart = addDaysDateOnly(afterStart, -impactDays);
  if (!afterStart || !afterEnd || afterEnd < afterStart || beforeEnd < beforeStart) {
    return { available: false, windowDays: impactDays };
  }
  const beforeRange = { startDate: beforeStart, endDate: beforeEnd };
  const afterRange = { startDate: afterStart, endDate: afterEnd };
  const before = summarizeDailyProductMetrics(options.orderDailyMetrics, options.gaDailyMetrics, product.id, beforeRange);
  const after = summarizeDailyProductMetrics(options.orderDailyMetrics, options.gaDailyMetrics, product.id, afterRange);
  const revenuePerDayDelta = roundMetric(after.revenuePerDay - before.revenuePerDay, 2);
  const unitsPerDayDelta = roundMetric(after.unitsPerDay - before.unitsPerDay, 2);
  const viewsPerDayDelta = roundMetric(after.viewsPerDay - before.viewsPerDay, 2);
  const cvrDelta = roundMetric(after.cvr - before.cvr, 4);
  const revenuePerDayLift = before.revenuePerDay ? roundMetric(revenuePerDayDelta / before.revenuePerDay, 4) : (after.revenuePerDay > 0 ? 1 : 0);
  const unitsPerDayLift = before.unitsPerDay ? roundMetric(unitsPerDayDelta / before.unitsPerDay, 4) : (after.unitsPerDay > 0 ? 1 : 0);
  return {
    available: true,
    windowDays: impactDays,
    beforeRange,
    afterRange,
    before,
    after,
    delta: {
      revenuePerDay: revenuePerDayDelta,
      revenuePerDayLift,
      unitsPerDay: unitsPerDayDelta,
      unitsPerDayLift,
      viewsPerDay: viewsPerDayDelta,
      cvr: cvrDelta
    },
    direction: revenuePerDayDelta > 0 || unitsPerDayDelta > 0 ? "up" : revenuePerDayDelta < 0 || unitsPerDayDelta < 0 ? "down" : "flat"
  };
}

function newInMarketingAction(row) {
  if (row.status === "DRAFT") return "Draft pipeline";
  if (Number(row.stock || 0) <= 0 && Number(row.units || 0) > 0) return "Sold out";
  if (Number(row.units || 0) > 0 && Number(row.stock || 0) <= Math.max(3, Number(row.units || 0) * 0.5)) return "Stock watch";
  if (Number(row.gaViews || 0) <= 5 && Number(row.stock || 0) > 0) return "Needs exposure";
  if (Number(row.gaViews || 0) >= 50 && Number(row.cvr || 0) < 0.03 && Number(row.units || 0) <= 1) return "Content check";
  if (Number(row.unitsPerLiveDay || 0) >= 1 || Number(row.revenuePerLiveDay || 0) >= 75) return "Push";
  if (row.cohorts.includes("Updated image") && Number(row.gaViews || 0) > 0) return "Image test";
  return "Watch";
}

function buildNewInPerformance(products, options) {
  const performanceRange = options.performanceRange;
  const launchRange = options.launchRange;
  const imageRange = options.imageRange;
  const includeDrafts = options.includeDrafts !== false;
  const rows = [];

  for (const product of products || []) {
    const status = product.status || "";
    const liveAt = product.publishedAt || (status === "ACTIVE" ? product.createdAt : "");
    const createdDate = dateOnlyFromIso(product.createdAt);
    const liveDate = dateOnlyFromIso(liveAt);
    const imageDate = dateOnlyFromIso(product.imageUpdatedAt);
    const isNewLaunch = status === "ACTIVE" && dateInRange(liveAt, launchRange);
    const isImageRefresh = dateInRange(product.imageUpdatedAt, imageRange);
    const isDraftPipeline = includeDrafts && status === "DRAFT" && dateInRange(product.createdAt, launchRange);
    if (!isNewLaunch && !isImageRefresh && !isDraftPipeline) continue;

    const cohorts = [];
    if (isNewLaunch) cohorts.push("New launch");
    if (isImageRefresh) cohorts.push("Updated image");
    if (isDraftPipeline) cohorts.push("Draft pipeline");
    const activeDays = activeDaysInPerformance(liveAt, performanceRange);
    const revenue = Number(product.revenue || 0);
    const units = Number(product.units || 0);
    const gaViews = Number(product.gaViews || 0);
    const stock = Number(product.stock || 0);
    const cvr = gaViews > 0 ? units / gaViews : 0;
    const sellThroughBase = units + Math.max(0, stock);
    const row = {
      id: product.id || "",
      title: product.title || "",
      handle: product.handle || "",
      onlineStoreUrl: product.onlineStoreUrl || "",
      status,
      productStatusCode: product.productStatusCode || "",
      vendor: product.vendor || "",
      productType: product.productType || "",
      season: product.season || "",
      color: product.color || "",
      tags: product.tags || [],
      skus: product.skus || [],
      variants: product.variants || [],
      imageUrl: product.imageUrl || "",
      imageAlt: product.imageAlt || product.title || "",
      imageUpdatedAt: product.imageUpdatedAt || "",
      imageUpdatedDate: imageDate,
      imageMediaId: product.imageMediaId || "",
      createdAt: product.createdAt || "",
      createdDate,
      publishedAt: product.publishedAt || "",
      liveAt,
      liveDate,
      launchBasis: product.publishedAt ? "publishedAt" : status === "ACTIVE" && product.createdAt ? "createdAt fallback" : "",
      draftLeadDays: createdDate && liveDate ? daysBetweenDateOnly(createdDate, liveDate) : 0,
      imageAgeDays: imageDate ? daysBetweenDateOnly(imageDate, performanceRange.endDate) : null,
      activeDays,
      cohorts,
      cohort: cohorts.join(" + "),
      price: Number(product.price || 0),
      compareAtPrice: product.compareAtPrice,
      cost: product.cost,
      margin: product.margin,
      stock,
      revenue: Math.round(revenue * 100) / 100,
      units,
      revenuePerLiveDay: activeDays ? Math.round((revenue / activeDays) * 100) / 100 : 0,
      unitsPerLiveDay: activeDays ? Math.round((units / activeDays) * 100) / 100 : 0,
      gaViews,
      gaAdds: Number(product.gaAdds || 0),
      gaPurchases: Number(product.gaPurchases || 0),
      gaRevenue: Number(product.gaRevenue || 0),
      cvr: Math.round(cvr * 10000) / 10000,
      sellThrough: sellThroughBase > 0 ? Math.round((units / sellThroughBase) * 10000) / 10000 : 0,
      isNewLaunch,
      isImageRefresh,
      isDraftPipeline,
      imageImpact: null
    };
    if (isImageRefresh && imageDate && options.orderDailyMetrics) {
      row.imageImpact = imageImpactForProduct(product, imageDate, options);
    }
    row.action = newInMarketingAction(row);
    rows.push(row);
  }

  const summary = rows.reduce((acc, row) => {
    acc.products += 1;
    if (row.isNewLaunch) acc.newLaunches += 1;
    if (row.isImageRefresh) acc.imageUpdates += 1;
    if (row.isDraftPipeline) acc.draftPipeline += 1;
    if (row.action === "Push") acc.pushCandidates += 1;
    if (row.action === "Needs exposure") acc.exposureCandidates += 1;
    acc.revenue += Number(row.revenue || 0);
    acc.units += Number(row.units || 0);
    acc.views += Number(row.gaViews || 0);
    acc.adds += Number(row.gaAdds || 0);
    acc.stock += Number(row.stock || 0);
    return acc;
  }, { products: 0, newLaunches: 0, imageUpdates: 0, draftPipeline: 0, pushCandidates: 0, exposureCandidates: 0, revenue: 0, units: 0, views: 0, adds: 0, stock: 0 });
  summary.revenue = Math.round(summary.revenue * 100) / 100;
  summary.cvr = summary.views > 0 ? Math.round((summary.units / summary.views) * 10000) / 10000 : 0;
  return { rows, summary };
}

async function fetchNewInPerformance(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const performanceDays = Math.max(1, Math.min(90, Number(url.searchParams.get("days") || 14)));
  const launchDays = Math.max(1, Math.min(180, Number(url.searchParams.get("launchDays") || 30)));
  const imageDays = Math.max(1, Math.min(180, Number(url.searchParams.get("imageDays") || 30)));
  const performanceRange = parseDateRange(url, performanceDays);
  const launchRange = parseNamedDateRange(url, "launchStartDate", "launchEndDate", launchDays);
  const imageRange = parseNamedDateRange(url, "imageStartDate", "imageEndDate", imageDays);
  const includeDrafts = url.searchParams.get("includeDrafts") !== "0";
  const limit = url.searchParams.get("limit") || "all";
  const impactDays = Math.max(1, Math.min(60, Number(url.searchParams.get("impactDays") || 14)));
  const updatedSince = launchRange.startDate < imageRange.startDate ? launchRange.startDate : imageRange.startDate;
  try {
    const snapshot = await captureShopifyMerchandising(performanceRange, { limit, updatedSince });
    if (!snapshot.configured) {
      sendJson(res, 200, snapshot);
      return;
    }
    const impactStartDate = addDaysDateOnly(imageRange.startDate, -impactDays);
    const impactRange = impactStartDate && impactStartDate <= performanceRange.endDate ? { startDate: impactStartDate, endDate: performanceRange.endDate } : null;
    const hasImageUpdates = (snapshot.products || []).some(product => dateInRange(product.imageUpdatedAt, imageRange));
    let orderDailyMetrics = null;
    let gaDailyMetrics = null;
    let imageImpactAvailable = false;
    let imageImpactGaAvailable = false;
    let imageImpactMessage = "";
    if (impactRange && hasImageUpdates) {
      try {
        orderDailyMetrics = await fetchOrderDailyMetrics(impactRange);
        imageImpactAvailable = true;
      } catch (error) {
        imageImpactMessage = error.message || "Could not load daily order metrics for image impact.";
      }
      try {
        const dailyGa = await fetchGaDailyMetrics(impactRange);
        imageImpactGaAvailable = dailyGa.available;
        gaDailyMetrics = mapGaDailyMetrics(snapshot.products || [], dailyGa.metrics || []);
      } catch (error) {
        if (!imageImpactMessage) imageImpactMessage = error.message || "Could not load daily GA4 metrics for image impact.";
      }
    }
    const report = buildNewInPerformance(snapshot.products || [], {
      performanceRange,
      launchRange,
      imageRange,
      includeDrafts,
      impactDays,
      orderDailyMetrics,
      gaDailyMetrics
    });
    sendJson(res, 200, {
      configured: true,
      syncedAt: snapshot.syncedAt || new Date().toISOString(),
      performanceRange,
      launchRange,
      imageRange,
      imageImpactRange: impactRange,
      impactDays,
      imageImpactAvailable,
      imageImpactGaAvailable,
      imageImpactMessage,
      includeDrafts,
      ordersAvailable: Boolean(snapshot.ordersAvailable),
      gaAvailable: Boolean(snapshot.gaAvailable),
      gaMessage: snapshot.gaMessage || "",
      totalProducts: Number(snapshot.totalProducts || (snapshot.products || []).length),
      products: report.rows,
      summary: report.summary
    });
  } catch (error) {
    sendJson(res, 502, { configured: true, message: error.message || "Could not load New In performance." });
  }
}

const emailCampaignService = createEmailCampaignService({
  openDb: openOrderSqliteDb,
  requestJson,
  fetchProducts: captureShopifyMerchandising,
  googleAccessToken,
  gaConfig,
  actorName
});

const pnlViewRoles = ["Admin", "Finance", "Buying Director"];
const pnlWriteRoles = ["Admin", "Finance"];

function pnlDefaultRange() {
  const end = new Date();
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 29);
  return { startDate: isoDateOnly(start), endDate: isoDateOnly(end) };
}

function pnlRangeFromRequest(url, fallback = pnlDefaultRange()) {
  const startDate = String(url.searchParams.get("startDate") || fallback.startDate || "").trim();
  const endDate = String(url.searchParams.get("endDate") || fallback.endDate || "").trim();
  return pnl.validateRange({ startDate, endDate }, { maxDays: 92 });
}

function cleanPnlDate(value) {
  const raw = String(value || "").trim();
  return validReportDate(raw) ? raw : "";
}

function pnlCostRuleFromRow(row) {
  if (!row) return null;
  return {
    ...pnl.publicRule({
      id: row.id,
      name: row.name,
      category: row.category,
      costType: row.cost_type,
      status: row.status,
      effectiveStart: row.effective_start || "",
      effectiveEnd: row.effective_end || "",
      amount: row.amount,
      rate: row.rate,
      firstItemRate: row.first_item_rate,
      additionalItemRate: row.additional_item_rate,
      notes: row.notes || "",
      data: parseJson(row.data, {})
    }),
    createdBy: row.created_by || "",
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function pnlMarketingSpendFromRow(row) {
  if (!row) return null;
  const source = row.source || "manual";
  const data = parseJson(row.data, {});
  return {
    ...pnl.publicMarketingEntry({
      id: row.id,
      channel: row.channel,
      startDate: row.start_date,
      endDate: row.end_date,
      amount: row.amount,
      notes: row.notes || "",
      data
    }),
    source,
    sourceKey: row.source_key || "",
    automated: source !== "manual" || Boolean(data.automated),
    createdBy: row.created_by || "",
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function readPnlCostRules() {
  return openOrderSqliteDb().prepare(`
    SELECT *
    FROM pnl_cost_rules
    ORDER BY
      CASE status WHEN 'Active' THEN 0 ELSE 1 END,
      category COLLATE NOCASE,
      name COLLATE NOCASE
  `).all().map(pnlCostRuleFromRow);
}

function readPnlMarketingSpend(options = {}) {
  const where = options.manualOnly ? "WHERE COALESCE(source, 'manual') = 'manual'" : "";
  return openOrderSqliteDb().prepare(`
    SELECT *
    FROM pnl_marketing_spend
    ${where}
    ORDER BY date(start_date) DESC, channel COLLATE NOCASE, updated_at DESC
  `).all().map(pnlMarketingSpendFromRow);
}

function readPnlAutomatedMarketingSpendSummary() {
  return openOrderSqliteDb().prepare(`
    SELECT
      source,
      channel,
      MIN(start_date) AS start_date,
      MAX(end_date) AS end_date,
      SUM(amount) AS amount,
      COUNT(*) AS day_count,
      MAX(updated_at) AS updated_at
    FROM pnl_marketing_spend
    WHERE COALESCE(source, 'manual') <> 'manual'
    GROUP BY source, channel
    ORDER BY channel COLLATE NOCASE
  `).all().map(row => ({
    id: `auto:${row.source}:${row.channel}`,
    source: row.source || "automated",
    channel: row.channel,
    startDate: row.start_date || "",
    endDate: row.end_date || "",
    amount: Math.round(Number(row.amount || 0) * 100) / 100,
    dayCount: Number(row.day_count || 0),
    updatedAt: row.updated_at || "",
    automated: true
  }));
}

function pnlWindsorStatus() {
  const cfg = windsorConfig();
  const rows = openOrderSqliteDb().prepare(`
    SELECT connector, channel, MIN(spend_date) start_date, MAX(spend_date) end_date, COUNT(*) row_count, MAX(synced_at) synced_at
    FROM pnl_marketing_spend_actuals
    WHERE source = 'windsor'
    GROUP BY connector, channel
    ORDER BY channel COLLATE NOCASE
  `).all();
  return {
    configured: Boolean(cfg.apiKey),
    autoSync: {
      enabled: cfg.autoSync,
      staleHours: cfg.autoSyncStaleHours,
      cooldownMinutes: cfg.autoSyncCooldownMinutes
    },
    channels: Object.values(cfg.channels).filter(channel => channel.enabled).map(channel => ({
      channel: channel.channel,
      connector: channel.connector,
      label: channel.label,
      accountScope: windsorMarketing.accountScopeLabel(channel)
    })),
    lastSyncedAt: rows.reduce((latest, row) => row.synced_at > latest ? row.synced_at : latest, ""),
    summaries: rows.map(row => ({
      connector: row.connector,
      channel: row.channel,
      startDate: row.start_date || "",
      endDate: row.end_date || "",
      rowCount: Number(row.row_count || 0),
      syncedAt: row.synced_at || ""
    }))
  };
}

function upsertPnlCostRule(input, req) {
  const body = input?.rule || input || {};
  const rule = pnl.publicRule(body);
  if (!rule.name) throw new Error("Add a cost rule name.");
  if (!pnl.COST_TYPES.has(rule.costType)) throw new Error("Choose a valid cost rule type.");
  const status = ["Active", "Inactive"].includes(rule.status) ? rule.status : "Active";
  const id = rule.id || crypto.randomUUID();
  const effectiveStart = cleanPnlDate(rule.effectiveStart);
  const effectiveEnd = cleanPnlDate(rule.effectiveEnd);
  if (effectiveStart && effectiveEnd && effectiveStart > effectiveEnd) throw new Error("Cost rule effective start must be before the end date.");
  const payload = {
    id,
    name: rule.name.slice(0, 120),
    category: (rule.category || "Other").slice(0, 80),
    costType: rule.costType,
    status,
    effectiveStart,
    effectiveEnd,
    amount: Math.max(0, Number(rule.amount || 0)),
    rate: Math.max(0, Number(rule.rate || 0)),
    firstItemRate: Math.max(0, Number(rule.firstItemRate || 0)),
    additionalItemRate: Math.max(0, Number(rule.additionalItemRate || 0)),
    notes: String(rule.notes || "").slice(0, 600),
    data: JSON.stringify(rule.data || {}),
    createdBy: actorName(req)
  };
  openOrderSqliteDb().prepare(`
    INSERT INTO pnl_cost_rules (
      id, name, category, cost_type, status, effective_start, effective_end,
      amount, rate, first_item_rate, additional_item_rate, notes, data, created_by,
      created_at, updated_at
    )
    VALUES (
      @id, @name, @category, @costType, @status, NULLIF(@effectiveStart, ''), NULLIF(@effectiveEnd, ''),
      @amount, @rate, @firstItemRate, @additionalItemRate, @notes, @data, @createdBy,
      CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    )
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      category = excluded.category,
      cost_type = excluded.cost_type,
      status = excluded.status,
      effective_start = excluded.effective_start,
      effective_end = excluded.effective_end,
      amount = excluded.amount,
      rate = excluded.rate,
      first_item_rate = excluded.first_item_rate,
      additional_item_rate = excluded.additional_item_rate,
      notes = excluded.notes,
      data = excluded.data,
      updated_at = CURRENT_TIMESTAMP
  `).run(payload);
  return pnlCostRuleFromRow(openOrderSqliteDb().prepare("SELECT * FROM pnl_cost_rules WHERE id = ?").get(id));
}

function deletePnlCostRule(id) {
  const clean = String(id || "").trim();
  if (!clean) throw new Error("Missing cost rule id.");
  return Boolean(openOrderSqliteDb().prepare("DELETE FROM pnl_cost_rules WHERE id = ?").run(clean).changes);
}

function upsertPnlMarketingSpend(input, req) {
  const body = input?.entry || input || {};
  const id = String(body.id || "").trim() || crypto.randomUUID();
  const channel = String(body.channel || "").trim().slice(0, 80);
  const startDate = cleanPnlDate(body.startDate || body.date);
  const endDate = cleanPnlDate(body.endDate || body.date || body.startDate);
  if (!channel) throw new Error("Choose a marketing channel.");
  if (!startDate || !endDate || startDate > endDate) throw new Error("Choose a valid marketing spend date range.");
  const payload = {
    id,
    channel,
    startDate,
    endDate,
    amount: Math.max(0, Number(body.amount || 0)),
    source: "manual",
    sourceKey: "",
    notes: String(body.notes || "").slice(0, 600),
    data: JSON.stringify(body.data && typeof body.data === "object" ? body.data : {}),
    createdBy: actorName(req)
  };
  openOrderSqliteDb().prepare(`
    INSERT INTO pnl_marketing_spend (
      id, channel, start_date, end_date, amount, source, source_key, notes, data, created_by, created_at, updated_at
    )
    VALUES (
      @id, @channel, @startDate, @endDate, @amount, @source, NULLIF(@sourceKey, ''), @notes, @data, @createdBy, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    )
    ON CONFLICT(id) DO UPDATE SET
      channel = excluded.channel,
      start_date = excluded.start_date,
      end_date = excluded.end_date,
      amount = excluded.amount,
      source = excluded.source,
      source_key = excluded.source_key,
      notes = excluded.notes,
      data = excluded.data,
      updated_at = CURRENT_TIMESTAMP
  `).run(payload);
  return pnlMarketingSpendFromRow(openOrderSqliteDb().prepare("SELECT * FROM pnl_marketing_spend WHERE id = ?").get(id));
}

function deletePnlMarketingSpend(id) {
  const clean = String(id || "").trim();
  if (!clean) throw new Error("Missing marketing spend id.");
  return Boolean(openOrderSqliteDb().prepare("DELETE FROM pnl_marketing_spend WHERE id = ?").run(clean).changes);
}

function timestampToDate(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const date = new Date(raw.includes("T") ? raw : `${raw.replace(" ", "T")}Z`);
  return Number.isFinite(date.getTime()) ? date : null;
}

function durationMs(value, fallbackMs) {
  const raw = String(value || "").trim().toLowerCase();
  const match = raw.match(/^(\d+(?:\.\d+)?)\s*(d|day|days|h|hr|hour|hours|m|min|minute|minutes)$/);
  if (!match) return fallbackMs;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount < 0) return fallbackMs;
  const unit = match[2];
  if (unit.startsWith("d")) return amount * 864e5;
  if (unit.startsWith("h")) return amount * 36e5;
  return amount * 6e4;
}

function pnlWindsorRangeTouchesRefreshWindow(range, cfg, now = new Date()) {
  const lookback = durationMs(cfg.refreshSince || "3d", 3 * 864e5);
  if (lookback <= 0) return false;
  const windowStart = new Date(now.getTime() - lookback);
  return range.endDate >= isoDateOnly(windowStart);
}

function datesInRange(startDate, endDate) {
  const dates = [];
  const start = new Date(`${startDate}T00:00:00.000Z`);
  const end = new Date(`${endDate}T00:00:00.000Z`);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || start > end) return dates;
  for (const cursor = new Date(start.getTime()); cursor <= end; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    dates.push(isoDateOnly(cursor));
  }
  return dates;
}

function pnlWindsorSuccessCoverage(range, connector) {
  const requiredDates = datesInRange(range.startDate, range.endDate);
  const covered = new Map(requiredDates.map(date => [date, ""]));
  const rows = openOrderSqliteDb().prepare(`
    SELECT start_date, end_date, synced_at
    FROM pnl_windsor_sync_runs
    WHERE source = 'windsor'
      AND connector = ?
      AND status = 'success'
      AND date(start_date) <= date(?)
      AND date(end_date) >= date(?)
    ORDER BY datetime(synced_at) DESC
  `).all(connector, range.endDate, range.startDate);

  for (const row of rows) {
    const startDate = row.start_date > range.startDate ? row.start_date : range.startDate;
    const endDate = row.end_date < range.endDate ? row.end_date : range.endDate;
    for (const date of datesInRange(startDate, endDate)) {
      if (covered.has(date)) covered.set(date, row.synced_at || "");
    }
  }

  const missingDates = [...covered.entries()].filter(([, syncedAt]) => !syncedAt).map(([date]) => date);
  const syncedDates = [...covered.values()].filter(Boolean).sort();
  return {
    covered: requiredDates.length > 0 && missingDates.length === 0,
    synced_at: syncedDates[0] || "",
    latest_synced_at: syncedDates[syncedDates.length - 1] || "",
    missingDates
  };
}

function pnlWindsorRecentAttempt(range, connector, cutoffDate) {
  const cutoff = cutoffDate.toISOString().slice(0, 19).replace("T", " ");
  return openOrderSqliteDb().prepare(`
    SELECT mode, status, error, synced_at
    FROM pnl_windsor_sync_runs AS run
    WHERE run.source = 'windsor'
      AND run.connector = ?
      AND run.status IN ('started', 'error')
      AND date(run.start_date) <= date(?)
      AND date(run.end_date) >= date(?)
      AND datetime(run.synced_at) >= datetime(?)
      AND NOT EXISTS (
        SELECT 1
        FROM pnl_windsor_sync_runs AS terminal
        WHERE terminal.source = 'windsor'
          AND terminal.connector = run.connector
          AND terminal.id <> run.id
          AND terminal.status IN ('success', 'error')
          AND date(terminal.start_date) <= date(?)
          AND date(terminal.end_date) >= date(?)
          AND datetime(terminal.synced_at) >= datetime(run.synced_at)
      )
    ORDER BY datetime(synced_at) DESC
    LIMIT 1
  `).get(connector, range.endDate, range.startDate, cutoff, range.endDate, range.startDate);
}

function recordWindsorSyncRun(range, result, mode, status, req, error = "") {
  const daily = Array.isArray(result?.daily) ? result.daily : [];
  const rows = Array.isArray(result?.rows) ? result.rows : [];
  const amount = daily.reduce((sum, entry) => sum + Number(entry.amount || 0), 0);
  openOrderSqliteDb().prepare(`
    INSERT INTO pnl_windsor_sync_runs (
      id, source, connector, channel, start_date, end_date, mode, status,
      row_count, day_count, amount, error, created_by, synced_at
    )
    VALUES (
      @id, 'windsor', @connector, @channel, @startDate, @endDate, @mode, @status,
      @rowCount, @dayCount, @amount, @error, @createdBy, CURRENT_TIMESTAMP
    )
  `).run({
    id: crypto.randomUUID(),
    connector: result.connector,
    channel: result.channel,
    startDate: range.startDate,
    endDate: range.endDate,
    mode,
    status,
    rowCount: rows.length,
    dayCount: daily.length,
    amount: Math.round(amount * 100) / 100,
    error: String(error || "").slice(0, 800),
    createdBy: actorName(req)
  });
}

function pnlWindsorChannelsFromInput(channelsInput) {
  const cfg = windsorConfig();
  const requested = Array.isArray(channelsInput) && channelsInput.length
    ? channelsInput.map(value => String(value || "").trim()).filter(Boolean)
    : ["Google", "Meta"];
  const seen = new Set();
  return requested.map(name => {
    const channel = cfg.channels[name] || Object.values(cfg.channels).find(item => item.channel.toLowerCase() === name.toLowerCase());
    return channel && channel.enabled ? channel : null;
  }).filter(channel => {
    if (!channel || seen.has(channel.channel)) return false;
    seen.add(channel.channel);
    return true;
  });
}

async function fetchWindsorMarketingChannel(range, channel, cfg) {
  if (!windsorMarketing.channelHasAccountScope(channel)) {
    throw new Error(`Set an account allowlist before syncing Windsor ${channel.label || channel.channel}.`);
  }
  const fetchJson = async (includeRevenue) => {
    const accountFilter = windsorMarketing.accountFilterForChannel(channel);
    const url = windsorMarketing.buildWindsorUrl({
      apiKey: cfg.apiKey,
      connector: channel.connector,
      fields: windsorMarketing.channelFields(channel, { includeRevenue }),
      startDate: range.startDate,
      endDate: range.endDate,
      refreshSince: cfg.refreshSince,
      refreshInterval: cfg.refreshInterval,
      filter: accountFilter,
      connectorParams: windsorMarketing.accountConnectorParams(channel)
    });
    const response = await requestJson(url, { headers: { "user-agent": "Merch-X/1.0 Windsor marketing sync" } });
    if (!response.ok || response.json?.error || response.json?.errors) {
      const error = response.json?.error?.message || response.json?.error || response.json?.message || JSON.stringify(response.json?.errors || response.json || {});
      const err = new Error(`Windsor ${channel.label || channel.channel} sync failed (${response.status} ${response.statusText}): ${error}`);
      err.windsorError = error;
      throw err;
    }
    return response.json;
  };

  let json;
  let attributionError = "";
  try {
    json = await fetchJson((channel.revenueFields || []).length > 0);
  } catch (error) {
    if (!(channel.revenueFields || []).length) throw error;
    attributionError = error.windsorError || error.message || "Attribution revenue fields unavailable.";
    json = await fetchJson(false);
  }
  const rawRows = windsorMarketing.normalizeRows(json, {
    source: "windsor",
    connector: channel.connector,
    channel: channel.channel,
    currency: process.env.WINDSOR_SPEND_CURRENCY || "GBP",
    revenueFields: channel.revenueFields || [],
    revenueWeight: channel.revenueWeight
  });
  const scoped = windsorMarketing.filterRowsByAllowedAccounts(rawRows, channel);
  if (rawRows.length && !scoped.rows.length) {
    throw new Error(`Windsor ${channel.label || channel.channel} returned ${rawRows.length} row(s), but none matched the allowed ${windsorMarketing.accountScopeLabel(channel)} account scope.`);
  }
  return {
    channel: channel.channel,
    connector: channel.connector,
    label: channel.label,
    accountScope: windsorMarketing.accountScopeLabel(channel),
    rawRowCount: rawRows.length,
    rejectedRowCount: scoped.rejected.length,
    attributionError,
    rows: scoped.rows,
    daily: windsorMarketing.aggregateDaily(scoped.rows)
  };
}

function replaceWindsorMarketingSpend(range, results, req) {
  const db = openOrderSqliteDb();
  const actor = actorName(req);
  const insertActual = db.prepare(`
    INSERT INTO pnl_marketing_spend_actuals (
      id, source, connector, channel, spend_date, amount, attributed_revenue, attributed_roas, currency, account_id, account_name,
      campaign_id, campaign_name, source_row_key, raw_json, synced_at
    )
    VALUES (
      @id, @source, @connector, @channel, @spendDate, @amount, @attributedRevenue, @attributedRoas, @currency, @accountId, @accountName,
      @campaignId, @campaignName, @sourceRowKey, @rawJson, CURRENT_TIMESTAMP
    )
    ON CONFLICT(source_row_key) DO UPDATE SET
      amount = excluded.amount,
      attributed_revenue = excluded.attributed_revenue,
      attributed_roas = excluded.attributed_roas,
      currency = excluded.currency,
      account_id = excluded.account_id,
      account_name = excluded.account_name,
      campaign_id = excluded.campaign_id,
      campaign_name = excluded.campaign_name,
      raw_json = excluded.raw_json,
      synced_at = CURRENT_TIMESTAMP
  `);
  const insertSpend = db.prepare(`
    INSERT INTO pnl_marketing_spend (
      id, channel, start_date, end_date, amount, source, source_key, notes, data, created_by, created_at, updated_at
    )
    VALUES (
      @id, @channel, @startDate, @endDate, @amount, 'windsor', @sourceKey, @notes, @data, @createdBy, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    )
    ON CONFLICT(id) DO UPDATE SET
      channel = excluded.channel,
      start_date = excluded.start_date,
      end_date = excluded.end_date,
      amount = excluded.amount,
      source = excluded.source,
      source_key = excluded.source_key,
      notes = excluded.notes,
      data = excluded.data,
      updated_at = CURRENT_TIMESTAMP
  `);
  db.transaction(() => {
    for (const result of results) {
      db.prepare(`
        DELETE FROM pnl_marketing_spend_actuals
        WHERE source = 'windsor'
          AND connector = ?
          AND date(spend_date) BETWEEN date(?) AND date(?)
      `).run(result.connector, range.startDate, range.endDate);
      db.prepare(`
        DELETE FROM pnl_marketing_spend
        WHERE source = 'windsor'
          AND source_key LIKE ?
          AND date(start_date) BETWEEN date(?) AND date(?)
      `).run(`windsor:${result.connector}:%`, range.startDate, range.endDate);
      for (const row of result.rows) {
        insertActual.run({
          ...row,
          attributedRoas: Number(row.amount || 0) > 0 ? Math.round((Number(row.attributedRevenue || 0) / Number(row.amount || 0)) * 100) / 100 : 0,
          rawJson: JSON.stringify(row.raw || {})
        });
      }
      for (const entry of result.daily) {
        insertSpend.run({
          id: entry.id,
          channel: entry.channel,
          startDate: entry.startDate,
          endDate: entry.endDate,
          amount: entry.amount,
          sourceKey: entry.sourceKey,
          notes: `Synced from Windsor ${result.label || result.channel}`,
          data: JSON.stringify({
            automated: true,
            source: "windsor",
            connector: result.connector,
            currency: entry.currency,
            rowCount: entry.rowCount,
            accountScope: result.accountScope,
            attributedRevenue: entry.attributedRevenue,
            attributedRoas: entry.attributedRoas,
            attributionWeight: entry.attributionWeight,
            attributionError: result.attributionError || ""
          }),
          createdBy: actor
        });
      }
    }
  })();
}

async function syncPnlWindsorMarketingSpend(input, req) {
  const cfg = windsorConfig();
  if (!cfg.apiKey) throw new Error("Set WINDSOR_API_KEY before syncing Windsor marketing spend.");
  const mode = input?.mode === "auto" ? "auto" : "manual";
  const range = pnl.validateRange({
    startDate: input?.startDate,
    endDate: input?.endDate
  }, { maxDays: 92 });
  const channels = pnlWindsorChannelsFromInput(input?.channels);
  if (!channels.length) throw new Error("Choose at least one enabled Windsor marketing channel.");
  const results = [];
  for (const channel of channels) {
    const runBase = { connector: channel.connector, channel: channel.channel, rows: [], daily: [] };
    recordWindsorSyncRun(range, runBase, mode, "started", req);
    try {
      results.push(await fetchWindsorMarketingChannel(range, channel, cfg));
    } catch (error) {
      recordWindsorSyncRun(range, runBase, mode, "error", req, error.message || "Windsor sync failed.");
      throw error;
    }
  }
  replaceWindsorMarketingSpend(range, results, req);
  for (const result of results) {
    recordWindsorSyncRun(range, result, mode, "success", req);
  }
  return {
    ok: true,
    range,
    source: "windsor",
    mode,
    channels: results.map(result => ({
      channel: result.channel,
      connector: result.connector,
      accountScope: result.accountScope,
      rawRowCount: result.rawRowCount,
      rowCount: result.rows.length,
      rejectedRowCount: result.rejectedRowCount,
      attributionError: result.attributionError,
      dayCount: result.daily.length,
      attributedRevenue: Math.round(result.daily.reduce((sum, entry) => sum + Number(entry.attributedRevenue || 0), 0) * 100) / 100,
      amount: Math.round(result.daily.reduce((sum, entry) => sum + Number(entry.amount || 0), 0) * 100) / 100
    })),
    syncedAt: new Date().toISOString()
  };
}

function planPnlWindsorAutoSync(range, req) {
  const cfg = windsorConfig();
  const base = {
    status: "skipped",
    mode: "auto",
    enabled: cfg.autoSync,
    reason: "",
    channels: [],
    toSync: []
  };
  if (!cfg.apiKey) return { ...base, reason: "not_configured" };
  if (!cfg.autoSync) return { ...base, reason: "disabled" };
  if (!userHasRole(req.currentUser, pnlWriteRoles)) return { ...base, reason: "no_write_access" };

  const channels = pnlWindsorChannelsFromInput(["Google", "Meta"]);
  if (!channels.length) return { ...base, reason: "no_enabled_channels" };

  const now = new Date();
  const cooldownStart = new Date(now.getTime() - cfg.autoSyncCooldownMinutes * 6e4);
  const staleMs = cfg.autoSyncStaleHours * 36e5;
  const touchesRefreshWindow = pnlWindsorRangeTouchesRefreshWindow(range, cfg, now);
  const details = [];
  const toSync = [];

  for (const channel of channels) {
    const coverage = pnlWindsorSuccessCoverage(range, channel.connector);
    const coveredAt = coverage.latest_synced_at || coverage.synced_at || "";
    const coveredDate = timestampToDate(coveredAt);
    const oldestCoveredDate = timestampToDate(coverage.synced_at);
    const covered = Boolean(coverage.covered && coveredDate);
    const stale = Boolean(covered && touchesRefreshWindow && staleMs > 0 && oldestCoveredDate && now.getTime() - oldestCoveredDate.getTime() > staleMs);
    const neededReason = !covered ? "missing" : stale ? "stale" : "";
    const recent = neededReason ? pnlWindsorRecentAttempt(range, channel.connector, cooldownStart) : null;
    const cooldown = Boolean(recent);
    const detail = {
      channel: channel.channel,
      connector: channel.connector,
      accountScope: windsorMarketing.accountScopeLabel(channel),
      covered,
      coveredAt,
      missingDates: covered ? [] : coverage.missingDates || [],
      reason: neededReason || "covered",
      cooldown,
      recentStatus: recent?.status || "",
      recentAt: recent?.synced_at || ""
    };
    if (neededReason && !cooldown) {
      toSync.push(channel);
      detail.action = "sync";
    } else {
      detail.action = "skip";
    }
    details.push(detail);
  }

  const reason = toSync.length
    ? "needed"
    : details.some(item => item.cooldown)
      ? "cooldown"
      : "covered";
  return {
    ...base,
    status: toSync.length ? "needed" : "skipped",
    reason,
    staleHours: cfg.autoSyncStaleHours,
    cooldownMinutes: cfg.autoSyncCooldownMinutes,
    channels: details,
    toSync
  };
}

async function maybeAutoSyncPnlWindsor(range, req) {
  const plan = planPnlWindsorAutoSync(range, req);
  if (!plan.toSync?.length) {
    const { toSync, ...publicPlan } = plan;
    return publicPlan;
  }
  try {
    const result = await syncPnlWindsorMarketingSpend({
      startDate: range.startDate,
      endDate: range.endDate,
      channels: plan.toSync.map(channel => channel.channel),
      mode: "auto"
    }, req);
    return {
      status: "synced",
      mode: "auto",
      reason: plan.reason,
      staleHours: plan.staleHours,
      cooldownMinutes: plan.cooldownMinutes,
      channels: result.channels,
      syncedAt: result.syncedAt
    };
  } catch (error) {
    return {
      status: "error",
      mode: "auto",
      reason: "sync_failed",
      error: error.message || "Could not auto-sync Windsor marketing spend.",
      staleHours: plan.staleHours,
      cooldownMinutes: plan.cooldownMinutes,
      channels: plan.channels
    };
  }
}

function moneySetAmount(value) {
  return Number(value?.shopMoney?.amount || value?.presentmentMoney?.amount || 0);
}

function moneySetListAmount(values = []) {
  return values.reduce((sum, value) => sum + moneySetAmount(value?.priceSet || value), 0);
}

function shopifyQueryForRange(range, field = "created_at") {
  const endExclusive = new Date(`${range.endDate}T00:00:00.000Z`);
  endExclusive.setUTCDate(endExclusive.getUTCDate() + 1);
  return `${field}:>=${range.startDate}T00:00:00Z ${field}:<${endExclusive.toISOString()} status:any`;
}

function pnlOrderIsExcluded(order = {}) {
  const status = String(order.displayFinancialStatus || "").toUpperCase();
  return Boolean(order.test || order.cancelledAt || ["AUTHORIZED", "EXPIRED", "PARTIALLY_PAID", "PENDING", "VOIDED"].includes(status));
}

function pnlOrderPricesIncludeTax(order = {}, subtotal, shipping, tax, total) {
  if (tax <= 0 || total <= 0) return false;
  return subtotal + shipping + tax > total + 0.05;
}

function normalizePnlLineItem(line = {}, options = {}) {
  const quantity = Math.max(0, Number(line.quantity || 0));
  const revenue = moneySetAmount(line.discountedTotalSet);
  const grossRevenue = moneySetAmount(line.originalTotalSet) || revenue;
  const tax = moneySetListAmount(line.taxLines || []);
  const revenueExTax = options.taxIncluded ? Math.max(0, revenue - tax) : revenue;
  const grossTax = options.taxIncluded && revenue > 0 ? tax * (grossRevenue / revenue) : tax;
  const grossRevenueExTax = options.taxIncluded ? Math.max(revenueExTax, grossRevenue - grossTax) : grossRevenue;
  const cost = line.variant?.inventoryItem?.unitCost?.amount == null ? null : Number(line.variant.inventoryItem.unitCost.amount || 0);
  const hasCost = Number.isFinite(cost) && cost >= 0;
  return {
    quantity,
    revenue: revenueExTax,
    grossRevenue: grossRevenueExTax,
    cogs: hasCost ? quantity * cost : 0,
    missingCostUnits: hasCost ? 0 : quantity,
    missingCostRevenue: hasCost ? 0 : revenueExTax,
    sku: line.variant?.sku || ""
  };
}

function normalizePnlRefundLineItem(line = {}) {
  const quantity = Math.max(0, Number(line.quantity || 0));
  const revenue = moneySetAmount(line.subtotalSet);
  const tax = moneySetAmount(line.totalTaxSet);
  const cost = line.lineItem?.variant?.inventoryItem?.unitCost?.amount == null ? null : Number(line.lineItem.variant.inventoryItem.unitCost.amount || 0);
  const hasCost = Number.isFinite(cost) && cost >= 0;
  return {
    quantity,
    revenue,
    tax,
    cogs: hasCost ? quantity * cost : 0
  };
}

function refundIsInsideRange(refund = {}, range) {
  if (!refund.createdAt) return false;
  const date = isoDateOnly(new Date(refund.createdAt));
  return date >= range.startDate && date <= range.endDate;
}

function pnlActualsFromOrders(range, orders, refundOrders = [], warnings = []) {
  const actuals = {
    range,
    netRevenue: 0,
    grossRevenue: 0,
    despatchRevenue: 0,
    shippingRevenue: 0,
    tax: 0,
    discounts: 0,
    returns: 0,
    returnFees: 0,
    orders: 0,
    units: 0,
    cogs: 0,
    missingCostUnits: 0,
    missingCostRevenue: 0
  };
  for (const order of orders) {
    if (pnlOrderIsExcluded(order)) continue;
    const subtotal = moneySetAmount(order.subtotalPriceSet) || moneySetAmount(order.currentSubtotalPriceSet);
    const shipping = moneySetAmount(order.totalShippingPriceSet) || moneySetAmount(order.currentShippingPriceSet);
    const tax = moneySetAmount(order.totalTaxSet) || moneySetAmount(order.currentTotalTaxSet);
    const total = moneySetAmount(order.totalPriceSet) || moneySetAmount(order.currentTotalPriceSet);
    const taxIncluded = pnlOrderPricesIncludeTax(order, subtotal, shipping, tax, total);
    const shippingTax = moneySetListAmount((order.shippingLines?.nodes || []).flatMap(line => line.taxLines || []));
    const shippingRevenue = taxIncluded ? Math.max(0, shipping - shippingTax) : shipping;
    const lines = (order.lineItems?.nodes || []).map(line => normalizePnlLineItem(line, { taxIncluded }));
    const lineRevenue = lines.reduce((sum, line) => sum + line.revenue, 0);
    const lineGrossRevenue = lines.reduce((sum, line) => sum + line.grossRevenue, 0);
    const lineUnits = lines.reduce((sum, line) => sum + line.quantity, 0);
    const orderDiscounts = moneySetAmount(order.totalDiscountsSet) || moneySetAmount(order.currentTotalDiscountsSet);
    const taxRate = taxIncluded && lineRevenue > 0 ? tax / lineRevenue : 0;
    const discounts = orderDiscounts > 0 ? orderDiscounts / (1 + taxRate) : Math.max(0, lineGrossRevenue - lineRevenue);
    const grossRevenue = Math.max(lineGrossRevenue, lineRevenue + discounts);
    const cogs = lines.reduce((sum, line) => sum + line.cogs, 0);
    const missingCostUnits = lines.reduce((sum, line) => sum + line.missingCostUnits, 0);
    const missingCostRevenue = lines.reduce((sum, line) => sum + line.missingCostRevenue, 0);
    actuals.netRevenue += lineRevenue;
    actuals.grossRevenue += grossRevenue || lineRevenue;
    actuals.tax += tax;
    actuals.discounts += discounts;
    actuals.shippingRevenue += shippingRevenue;
    actuals.orders += 1;
    actuals.units += lineUnits;
    actuals.cogs += cogs;
    actuals.missingCostUnits += missingCostUnits;
    actuals.missingCostRevenue += missingCostRevenue;
    if (order.lineItems?.pageInfo?.hasNextPage) warnings.push(`${order.name || order.id} has more than 100 line items; only the first 100 were included.`);
  }
  for (const order of refundOrders) {
    if (pnlOrderIsExcluded(order)) continue;
    for (const refund of order.refunds || []) {
      if (!refundIsInsideRange(refund, range)) continue;
      const refundLines = (refund.refundLineItems?.nodes || []).map(normalizePnlRefundLineItem);
      const returnRevenue = refundLines.reduce((sum, line) => sum + line.revenue, 0);
      const returnTax = refundLines.reduce((sum, line) => sum + line.tax, 0);
      const returnUnits = refundLines.reduce((sum, line) => sum + line.quantity, 0);
      const returnCogs = refundLines.reduce((sum, line) => sum + line.cogs, 0);
      actuals.netRevenue -= returnRevenue;
      actuals.returns += returnRevenue;
      actuals.tax -= returnTax;
      actuals.units -= returnUnits;
      actuals.cogs -= returnCogs;
    }
  }
  actuals.netRevenue = Math.max(0, actuals.netRevenue);
  actuals.tax = Math.max(0, actuals.tax);
  actuals.units = Math.max(0, actuals.units);
  actuals.cogs = Math.max(0, actuals.cogs);
  actuals.despatchRevenue = actuals.netRevenue + actuals.shippingRevenue + actuals.tax + actuals.returnFees;
  return {
    ...actuals,
    netRevenue: pnl.money(actuals.netRevenue),
    grossRevenue: pnl.money(actuals.grossRevenue),
    despatchRevenue: pnl.money(actuals.despatchRevenue),
    shippingRevenue: pnl.money(actuals.shippingRevenue),
    tax: pnl.money(actuals.tax),
    discounts: pnl.money(actuals.discounts),
    returns: pnl.money(actuals.returns),
    returnFees: pnl.money(actuals.returnFees),
    units: Math.round(actuals.units * 100) / 100,
    cogs: pnl.money(actuals.cogs),
    missingCostUnits: Math.round(actuals.missingCostUnits * 100) / 100,
    missingCostRevenue: pnl.money(actuals.missingCostRevenue),
    orderCount: actuals.orders,
    warnings
  };
}

async function fetchShopifyOrderPnlActuals(range) {
  const { shop, clientId, clientSecret } = shopifyConfig();
  if (!shop || !clientId || !clientSecret) {
    return {
      configured: false,
      message: "Set SHOPIFY_SHOP, SHOPIFY_CLIENT_ID, and SHOPIFY_CLIENT_SECRET to load live P&L actuals.",
      actuals: { range, netRevenue: 0, orders: 0, units: 0, cogs: 0 }
    };
  }
  const query = `
    query PnlOrders($cursor: String, $query: String!) {
      orders(first: 100, after: $cursor, query: $query, sortKey: CREATED_AT, reverse: true) {
        nodes {
          id
          name
          createdAt
          processedAt
          cancelledAt
          test
          displayFinancialStatus
          subtotalPriceSet { shopMoney { amount currencyCode } }
          currentSubtotalPriceSet { shopMoney { amount currencyCode } }
          currentTotalPriceSet { shopMoney { amount currencyCode } }
          totalPriceSet { shopMoney { amount currencyCode } }
          currentTotalDiscountsSet { shopMoney { amount currencyCode } }
          totalDiscountsSet { shopMoney { amount currencyCode } }
          currentShippingPriceSet { shopMoney { amount currencyCode } }
          totalShippingPriceSet { shopMoney { amount currencyCode } }
          currentTotalTaxSet { shopMoney { amount currencyCode } }
          totalTaxSet { shopMoney { amount currencyCode } }
          shippingLines(first: 20) {
            nodes {
              taxLines { priceSet { shopMoney { amount currencyCode } } }
            }
          }
          lineItems(first: 100) {
            nodes {
              quantity
              originalTotalSet { shopMoney { amount currencyCode } }
              discountedTotalSet { shopMoney { amount currencyCode } }
              taxLines { priceSet { shopMoney { amount currencyCode } } }
              variant {
                id
                sku
                inventoryItem { unitCost { amount currencyCode } }
              }
            }
            pageInfo { hasNextPage }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  `;
  const orders = [];
  let cursor = null;
  let hasNextPage = true;
  while (hasNextPage) {
    const data = await shopifyGraphql(query, { cursor, query: shopifyQueryForRange(range, "processed_at") });
    const connection = data.orders;
    orders.push(...(connection.nodes || []));
    hasNextPage = Boolean(connection.pageInfo?.hasNextPage);
    cursor = connection.pageInfo?.endCursor || null;
  }
  const refundQuery = `
    query PnlRefunds($cursor: String, $query: String!) {
      orders(first: 100, after: $cursor, query: $query, sortKey: UPDATED_AT, reverse: true) {
        nodes {
          id
          name
          cancelledAt
          test
          displayFinancialStatus
          refunds {
            id
            createdAt
            refundLineItems(first: 100) {
              nodes {
                quantity
                subtotalSet { shopMoney { amount currencyCode } }
                totalTaxSet { shopMoney { amount currencyCode } }
                lineItem {
                  variant {
                    inventoryItem { unitCost { amount currencyCode } }
                  }
                }
              }
              pageInfo { hasNextPage }
            }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  `;
  const refundOrders = [];
  cursor = null;
  hasNextPage = true;
  while (hasNextPage) {
    const data = await shopifyGraphql(refundQuery, { cursor, query: shopifyQueryForRange(range, "updated_at") });
    const connection = data.orders;
    refundOrders.push(...(connection.nodes || []));
    hasNextPage = Boolean(connection.pageInfo?.hasNextPage);
    cursor = connection.pageInfo?.endCursor || null;
  }
  return {
    configured: true,
    actuals: pnlActualsFromOrders(range, orders, refundOrders),
    orderSample: orders.slice(0, 5).map(order => ({ id: order.id, name: order.name, createdAt: order.createdAt, processedAt: order.processedAt })),
    fetchedAt: new Date().toISOString()
  };
}

async function fetchShopifyPnlActuals(range) {
  const { shop, clientId, clientSecret } = shopifyConfig();
  if (!shop || !clientId || !clientSecret) {
    return {
      configured: false,
      message: "Set SHOPIFY_SHOP, SHOPIFY_CLIENT_ID, and SHOPIFY_CLIENT_SECRET to load live P&L actuals.",
      actuals: { range, netRevenue: 0, orders: 0, units: 0, cogs: 0 }
    };
  }
  const query = `
    query PnlShopifyQl($query: String!) {
      shopifyqlQuery(query: $query) {
        parseErrors
        tableData {
          columns { name displayName dataType }
          rows
        }
      }
    }
  `;
  const reportQuery = `
    FROM sales
    SHOW total_sales, gross_sales, net_sales, discounts, taxes, returns,
      shipping_charges, return_fees, orders, average_order_value,
      gross_profit, cost_of_goods_sold, quantity_ordered, quantity_returned
    SINCE ${range.startDate}
    UNTIL ${range.endDate}
  `.replace(/\s+/g, " ").trim();
  const data = await shopifyGraphql(query, { query: reportQuery });
  const response = data.shopifyqlQuery || {};
  const parseErrors = response.parseErrors || [];
  if (parseErrors.length) throw new Error(`ShopifyQL P&L report query failed: ${parseErrors.join("; ")}`);
  const rows = Array.isArray(response.tableData?.rows) ? response.tableData.rows : [];
  const reportRow = rows[0] || {};
  return {
    configured: true,
    actuals: pnl.shopifyQlSalesActualsFromRow(reportRow, range),
    sourceType: "shopifyql_sales",
    columns: response.tableData?.columns || [],
    rowCount: rows.length,
    reportQuery,
    fetchedAt: new Date().toISOString()
  };
}

function pnlSettingsPayload(req) {
  const windsor = pnlWindsorStatus();
  return {
    costRules: readPnlCostRules(),
    marketingSpend: readPnlMarketingSpend({ manualOnly: true }),
    automatedMarketingSpend: readPnlAutomatedMarketingSpendSummary(),
    integrations: {
      windsorConfigured: windsor.configured
    },
    windsor,
    canWrite: userHasRole(req.currentUser, pnlWriteRoles),
    generatedAt: new Date().toISOString()
  };
}

async function handlePnlGet(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const range = pnlRangeFromRequest(url);
  let settings = pnlSettingsPayload(req);
  const fetched = await fetchShopifyPnlActuals(range);
  if (!fetched.configured) {
    sendJson(res, 200, {
      configured: false,
      message: fetched.message,
      range,
      settings,
      canWrite: settings.canWrite,
      generatedAt: new Date().toISOString()
    });
    return;
  }
  const skipWindsorAutoSync = ["0", "false", "no"].includes(String(url.searchParams.get("autoSyncWindsor") ?? "").trim().toLowerCase());
  const windsorSync = skipWindsorAutoSync
    ? { status: "skipped", mode: "auto", reason: "request_disabled", enabled: false, channels: [] }
    : await maybeAutoSyncPnlWindsor(range, req);
  settings = pnlSettingsPayload(req);
  const statement = pnl.buildPnl(fetched.actuals, settings.costRules, readPnlMarketingSpend());
  sendJson(res, 200, {
    configured: true,
    range,
    statement,
    settings,
    windsorSync,
    source: {
      type: fetched.sourceType || "shopify_orders",
      fetchedAt: fetched.fetchedAt,
      orderCount: fetched.actuals.orderCount || fetched.actuals.orders || 0,
      rowCount: fetched.rowCount || 0,
      columns: fetched.columns || [],
      orderSample: fetched.orderSample || []
    },
    canWrite: settings.canWrite,
    generatedAt: new Date().toISOString()
  });
}

async function handlePnlScenario(req, res) {
  const body = await readJsonBody(req);
  const actuals = body.actuals || body.statement || body.actual;
  if (!actuals?.range) throw new Error("Load P&L actuals before running a scenario.");
  const costRules = Array.isArray(body.costRules) ? body.costRules : readPnlCostRules();
  const marketingSpend = Array.isArray(body.marketingSpend) ? body.marketingSpend : readPnlMarketingSpend();
  const result = pnl.buildScenario(actuals, costRules, marketingSpend, body.drivers || {});
  sendJson(res, 200, {
    ...result,
    sensitivity: pnl.sensitivityTables(actuals, costRules, marketingSpend, body.drivers || {}),
    generatedAt: new Date().toISOString()
  });
}

async function handleApi(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "GET" && url.pathname === "/api/pnl") {
    if (!requireRoles(req, res, pnlViewRoles)) return true;
    try {
      await handlePnlGet(req, res);
    } catch (error) {
      sendJson(res, 400, { error: error.message || "Could not load P&L actuals." });
    }
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/pnl/settings") {
    if (!requireRoles(req, res, pnlViewRoles)) return true;
    sendJson(res, 200, pnlSettingsPayload(req));
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/pnl/cost-rules/upsert") {
    if (!requireRoles(req, res, pnlWriteRoles, "Only Finance or Admin users can update P&L cost rules.")) return true;
    try {
      const body = await readJsonBody(req);
      const rule = upsertPnlCostRule(body, req);
      sendJson(res, 200, { ok: true, rule, settings: pnlSettingsPayload(req) });
    } catch (error) {
      sendJson(res, 400, { error: error.message || "Could not save cost rule." });
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/pnl/cost-rules/delete") {
    if (!requireRoles(req, res, pnlWriteRoles, "Only Finance or Admin users can delete P&L cost rules.")) return true;
    try {
      const body = await readJsonBody(req);
      const deleted = deletePnlCostRule(body.id);
      sendJson(res, 200, { ok: true, deleted, settings: pnlSettingsPayload(req) });
    } catch (error) {
      sendJson(res, 400, { error: error.message || "Could not delete cost rule." });
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/pnl/marketing-spend/upsert") {
    if (!requireRoles(req, res, pnlWriteRoles, "Only Finance or Admin users can update P&L marketing spend.")) return true;
    try {
      const body = await readJsonBody(req);
      const entry = upsertPnlMarketingSpend(body, req);
      sendJson(res, 200, { ok: true, entry, settings: pnlSettingsPayload(req) });
    } catch (error) {
      sendJson(res, 400, { error: error.message || "Could not save marketing spend." });
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/pnl/marketing-spend/delete") {
    if (!requireRoles(req, res, pnlWriteRoles, "Only Finance or Admin users can delete P&L marketing spend.")) return true;
    try {
      const body = await readJsonBody(req);
      const deleted = deletePnlMarketingSpend(body.id);
      sendJson(res, 200, { ok: true, deleted, settings: pnlSettingsPayload(req) });
    } catch (error) {
      sendJson(res, 400, { error: error.message || "Could not delete marketing spend." });
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/pnl/marketing-spend/sync-windsor") {
    if (!requireRoles(req, res, pnlWriteRoles, "Only Finance or Admin users can sync Windsor marketing spend.")) return true;
    try {
      const body = await readJsonBody(req);
      const result = await syncPnlWindsorMarketingSpend(body, req);
      sendJson(res, 200, { ...result, settings: pnlSettingsPayload(req) });
    } catch (error) {
      sendJson(res, 400, { error: error.message || "Could not sync Windsor marketing spend." });
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/pnl/scenario") {
    if (!requireRoles(req, res, pnlViewRoles)) return true;
    try {
      await handlePnlScenario(req, res);
    } catch (error) {
      sendJson(res, 400, { error: error.message || "Could not run P&L scenario." });
    }
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/email-campaigns") {
    const cfg = emailCampaignService.config();
    sendJson(res, 200, { campaigns: emailCampaignService.list(), cache: emailCampaignService.cacheStatus(), canWrite: userHasRole(req.currentUser, ["Marketing", "Merchandising", "Admin"]), integrations: { klaviyoConfigured: Boolean(cfg.privateApiKey && cfg.defaultAudienceId), ga4Configured: Boolean(gaConfig().propertyId), shopifyConfigured: Boolean(shopifyConfig().shop && shopifyConfig().clientId && shopifyConfig().clientSecret) } });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/email-campaigns/refresh-data") {
    if (!requireRoles(req, res, ["Marketing", "Merchandising", "Admin"])) return true;
    try {
      const body = await readJsonBody(req);
      const result = await emailCampaignService.refreshData(body);
      sendJson(res, 200, { ok: true, cache: result.cache, integrations: { orders: Boolean(result.data.ordersAvailable), ga4: Boolean(result.data.gaAvailable), gaMessage: result.data.gaMessage || "" } });
    } catch (error) {
      sendJson(res, 400, { error: error.message || "Could not refresh product data." });
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/email-campaigns/recommendations") {
    if (!requireRoles(req, res, ["Marketing", "Merchandising", "Admin"])) return true;
    try {
      const body = await readJsonBody(req);
      const result = await emailCampaignService.recommendations(body);
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 400, { error: error.message || "Could not generate recommendations." });
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/email-campaigns/save") {
    if (!requireRoles(req, res, ["Marketing", "Merchandising", "Admin"])) return true;
    try {
      const body = await readJsonBody(req);
      sendJson(res, 200, { ok: true, campaign: emailCampaignService.save(body, req) });
    } catch (error) {
      sendJson(res, 400, { error: error.message || "Could not save campaign." });
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/email-campaigns/klaviyo-draft") {
    if (!requireRoles(req, res, ["Marketing", "Merchandising", "Admin"])) return true;
    try {
      const body = await readJsonBody(req);
      sendJson(res, 200, { ok: true, campaign: await emailCampaignService.createDraft(body.id) });
    } catch (error) {
      sendJson(res, 400, { error: error.message || "Could not create Klaviyo draft." });
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/email-campaigns/sync-results") {
    if (!requireRoles(req, res, ["Marketing", "Merchandising", "Admin"])) return true;
    try {
      const body = await readJsonBody(req);
      sendJson(res, 200, { ok: true, campaign: await emailCampaignService.sync(body.id) });
    } catch (error) {
      sendJson(res, 400, { error: error.message || "Could not sync campaign results." });
    }
    return true;
  }

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

  if (req.method === "POST" && url.pathname === "/api/products/delete") {
    if (!requireRoles(req, res, ["Admin"], "Only Admin users can permanently delete products.")) return true;
    try {
      const body = await readJsonBody(req);
      const deleted = deleteCatalogProduct(body.id || body.sku);
      sendJson(res, 200, {
        ok: true,
        deleted,
        message: deleted.shopifyLinked
          ? `Deleted local product ${deleted.sku}. The Shopify product was not changed.`
          : `Deleted local product ${deleted.sku}.`
      });
    } catch (error) {
      sendJson(res, error.code === "product_referenced" ? 409 : 400, { error: error.message || "Could not delete product." });
    }
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/suppliers") {
    const suppliers = readCatalogSuppliers();
    sendJson(res, 200, {
      suppliers,
      count: suppliers.length,
      generatedAt: new Date().toISOString()
    });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/suppliers/report") {
    try {
      sendJson(res, 200, buildSupplierReport({
        supplier: url.searchParams.get("supplier"),
        supplierName: url.searchParams.get("supplierName"),
        supplierId: url.searchParams.get("supplierId"),
        includeArchived: url.searchParams.get("includeArchived")
      }));
    } catch (error) {
      sendJson(res, 500, { error: error.message || "Could not build supplier report." });
    }
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
      ...readBestsellersPeriodListing(),
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

  if (req.method === "GET" && url.pathname === "/api/sale-planner") {
    if (!requireRoles(req, res, ["Buyer", "Merchandising", "Admin"])) return true;
    try {
      await handleSalePlannerGet(req, res);
    } catch (error) {
      sendJson(res, 500, { error: error.message || "Could not load sale planner" });
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/sale-planner/import") {
    if (!requireRoles(req, res, ["Buyer", "Merchandising", "Admin"])) return true;
    try {
      await handleSalePlannerImport(req, res);
    } catch (error) {
      sendJson(res, 400, { error: error.message || "Could not import sale planner products" });
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/sale-planner/items/update") {
    if (!requireRoles(req, res, ["Buyer", "Merchandising", "Admin"])) return true;
    try {
      await handleSalePlannerItemsUpdate(req, res);
    } catch (error) {
      sendJson(res, 400, { error: error.message || "Could not update sale plan item" });
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/sale-planner/items/remove") {
    if (!requireRoles(req, res, ["Buyer", "Merchandising", "Admin"])) return true;
    try {
      await handleSalePlannerItemsRemove(req, res);
    } catch (error) {
      sendJson(res, 400, { error: error.message || "Could not remove sale plan item" });
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/sale-planner/config") {
    if (!requireRoles(req, res, ["Admin"], "Only Admin users can update sale collection mapping.")) return true;
    try {
      await handleSalePlannerConfig(req, res);
    } catch (error) {
      sendJson(res, 400, { error: error.message || "Could not save sale planner collection mapping" });
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/sale-planner/analysis/refresh") {
    if (!requireRoles(req, res, ["Buyer", "Merchandising", "Admin"])) return true;
    try {
      await handleSalePlannerAnalysisRefresh(req, res);
    } catch (error) {
      sendJson(res, 400, { error: error.message || "Could not refresh sale planner analysis" });
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/sale-planner/analysis/actions/update") {
    if (!requireRoles(req, res, ["Buyer", "Merchandising", "Admin"])) return true;
    try {
      await handleSalePlannerActionsUpdate(req, res);
    } catch (error) {
      sendJson(res, 400, { error: error.message || "Could not update sale analysis actions" });
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/sale-planner/analysis/actions/create-plan") {
    if (!requireRoles(req, res, ["Buyer", "Merchandising", "Admin"])) return true;
    try {
      await handleSalePlannerActionsCreatePlan(req, res);
    } catch (error) {
      sendJson(res, 400, { error: error.message || "Could not create sale analysis follow-up plan" });
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/sale-planner/apply/start") {
    if (!requireRoles(req, res, ["Admin"], "Only Admin users can apply Shopify sale changes.")) return true;
    try {
      await startSalePlannerJob(req, res, "apply");
    } catch (error) {
      sendJson(res, 400, { error: error.message || "Could not apply sale plan" });
    }
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/sale-planner/apply/status") {
    if (!requireRoles(req, res, ["Admin"], "Only Admin users can view Shopify sale apply jobs.")) return true;
    getSalePlannerJob(req, res);
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/sale-planner/remove/start") {
    if (!requireRoles(req, res, ["Admin"], "Only Admin users can remove Shopify sale changes.")) return true;
    try {
      await startSalePlannerJob(req, res, "remove");
    } catch (error) {
      sendJson(res, 400, { error: error.message || "Could not remove sale items" });
    }
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
      suppliers: readCatalogSuppliers(),
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
      const issued = await queueNextAvailableSku();
      sendJson(res, 200, issued);
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
    const supplierCredits = supplierCreditSummaries();
    const orders = db.orders
      .map(order => {
        const workflow = workflows.get(String(order.id));
        return publicManagedOrder(syncOrderStatusFromWorkflowRow(order, workflow), workflow, products, supplierCredits);
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
    const supplierCredits = supplierCreditSummaries();
    sendJson(res, 200, {
      order: publicManagedOrder(syncedOrder, workflow, null, supplierCredits),
      events: readOrderEvents(orderId),
      invoices: readOrderInvoices(orderId),
      batches: readOrderBatches(orderId),
      batchLines: readOrderBatchLines(orderId),
      receiptLines: readOrderReceiptLines(orderId),
      discrepancies: readOrderDiscrepancies(orderId),
      labelJobs: readOrderLabelJobs(orderId),
      pahSettings: readPahSettings(),
      users: publicAssignableUsers()
    });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/orders/pah-settings") {
    if (!requireRoles(req, res, ["Buyer", "Merchandising", "Admin"], "Only Buyer, Merchandising, or Admin users can update PAH carrier settings.")) return true;
    try {
      const body = await readJsonBody(req);
      const settings = writePahSettings(body.settings || body);
      sendJson(res, 200, { ok: true, settings });
    } catch (error) {
      sendJson(res, 400, { error: error.message || "Could not save PAH carrier settings" });
    }
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/orders/pah") {
    if (!requireRoles(req, res, ["Buyer", "Merchandising", "Admin"], "Only Buyer, Merchandising, or Admin users can export PAH reports.")) return true;
    const orderId = String(url.searchParams.get("orderId") || "");
    const order = readOrderDb().orders.find(item => String(item.id) === orderId);
    if (!order) {
      sendJson(res, 404, { error: "Order not found" });
      return true;
    }
    const workflowRow = readOrderWorkflowMap().get(orderId);
    const report = buildPahReport({
      order: { ...order, workflow: workflowFromRow(workflowRow, order) },
      batches: readOrderBatches(orderId),
      batchLines: readOrderBatchLines(orderId),
      scopeType: url.searchParams.get("scopeType") || "order",
      batchId: url.searchParams.get("batchId") || "",
      settings: readPahSettings()
    });
    if (!report.valid) {
      sendJson(res, 400, { error: report.errors[0] || "Could not build PAH report", errors: report.errors });
      return true;
    }
    sendCsv(res, report.filename, report.content);
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/orders/label-jobs") {
    if (!requireRoles(req, res, ["Buyer", "Merchandising", "Admin"], "Only Buyer, Merchandising, or Admin users can generate label jobs.")) return true;
    try {
      const body = await readJsonBody(req);
      const orderId = String(body.orderId || "");
      const db = readOrderDb();
      const order = db.orders.find(item => String(item.id) === orderId);
      if (!order) {
        sendJson(res, 404, { error: "Order not found" });
        return true;
      }
      const job = createOrderLabelJob(order, body, actorName(req));
      sendJson(res, 200, {
        ok: true,
        job,
        labelJobs: readOrderLabelJobs(orderId),
        events: readOrderEvents(orderId)
      });
    } catch (error) {
      sendJson(res, 400, {
        error: error.message || "Could not generate label job",
        validation: error.validation || null
      });
    }
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
        batchLines: readOrderBatchLines(orderId),
        receiptLines: readOrderReceiptLines(orderId),
        discrepancies: readOrderDiscrepancies(orderId)
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
      const workflowRow = readOrderWorkflowMap().get(orderId);
      const publicOrder = publicManagedOrder(updatedOrder, workflowRow);
      sendJson(res, 200, {
        ok: true,
        order: publicOrder,
        workflow: publicOrder.workflow,
        events: readOrderEvents(orderId),
        invoices: readOrderInvoices(orderId),
        batches: readOrderBatches(orderId),
        batchLines: readOrderBatchLines(orderId),
        receiptLines: readOrderReceiptLines(orderId),
        discrepancies: readOrderDiscrepancies(orderId)
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
        receiptLines: readOrderReceiptLines(orderId),
        discrepancies: readOrderDiscrepancies(orderId),
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
        receiptLines: readOrderReceiptLines(orderId),
        discrepancies: readOrderDiscrepancies(orderId),
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
        receiptLines: readOrderReceiptLines(orderId),
        discrepancies: readOrderDiscrepancies(orderId),
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
        receiptLines: readOrderReceiptLines(orderId),
        discrepancies: readOrderDiscrepancies(orderId),
        events: readOrderEvents(orderId)
      });
    } catch (error) {
      sendJson(res, 400, { error: error.message || "Could not delete batch" });
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/orders/receipts") {
    if (!requireRoles(req, res, ["Merchandising", "Admin"], "Only Merchandising or Admin users can save receipt actuals.")) return true;
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
      const result = saveOrderReceipts(order, body);
      const refreshedOrder = readOrderDb().orders.find(item => String(item.id) === orderId) || order;
      const workflow = readOrderWorkflowMap().get(orderId);
      await notifyOrderHandoffIfChanged(req, order, refreshedOrder, previousWorkflow, workflowFromRow(workflow, refreshedOrder), { notifyRoleActionChange: true });
      sendJson(res, 200, {
        ok: true,
        order: publicManagedOrder(refreshedOrder, workflow),
        batchId: result.batchId,
        batches: readOrderBatches(orderId),
        invoices: readOrderInvoices(orderId),
        batchLines: readOrderBatchLines(orderId),
        receiptLines: result.receiptLines,
        discrepancies: result.discrepancies,
        events: readOrderEvents(orderId)
      });
    } catch (error) {
      sendJson(res, 400, { error: error.message || "Could not save receipt actuals" });
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/orders/discrepancies") {
    if (!requireRoles(req, res, ["Merchandising", "Finance", "Admin"], "Only Merchandising, Finance, or Admin users can update discrepancies.")) return true;
    try {
      const body = await readJsonBody(req);
      const orderId = String(body.orderId || "");
      const db = readOrderDb();
      const order = db.orders.find(item => String(item.id) === orderId);
      if (!order) {
        sendJson(res, 404, { error: "Order not found" });
        return true;
      }
      const discrepancies = updateOrderDiscrepancy(order, body, req);
      const workflow = readOrderWorkflowMap().get(orderId);
      sendJson(res, 200, {
        ok: true,
        order: publicManagedOrder(order, workflow),
        invoices: readOrderInvoices(orderId),
        batches: readOrderBatches(orderId),
        batchLines: readOrderBatchLines(orderId),
        receiptLines: readOrderReceiptLines(orderId),
        discrepancies,
        events: readOrderEvents(orderId)
      });
    } catch (error) {
      sendJson(res, 400, { error: error.message || "Could not update discrepancy" });
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
        batchLines: readOrderBatchLines(orderId),
        receiptLines: readOrderReceiptLines(orderId),
        discrepancies: readOrderDiscrepancies(orderId)
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
  if (requestPath === "/pnl.html" && !requireRoles(req, res, pnlViewRoles, "You do not have access to the P&L planner.")) return;

  if (req.url.startsWith("/api/new-in-performance")) {
    fetchNewInPerformance(req, res).catch((error) => {
      sendJson(res, 500, { message: error.message });
    });
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
