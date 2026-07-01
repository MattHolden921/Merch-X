"use strict";

const crypto = require("node:crypto");

const DEFAULT_CHANNELS = {
  Google: {
    channel: "Google",
    connector: "google_ads",
    label: "Google Ads",
    envPrefix: "WINDSOR_GOOGLE",
    accountParam: "account_id",
    accountFilterField: "account_name",
    accountIdFilterField: "account_id"
  },
  Meta: {
    channel: "Meta",
    connector: "facebook",
    label: "Meta Ads",
    envPrefix: "WINDSOR_META",
    accountParam: "account",
    accountFilterField: "account_name",
    accountIdFilterField: "account_id"
  }
};

const DEFAULT_ALLOWED_ACCOUNT_TOKENS = ["kit", "kaboodal"];

function text(value) {
  return String(value == null ? "" : value).trim();
}

function number(value, fallback = 0) {
  if (typeof value === "string") {
    const cleaned = value.replace(/[,£$€]/g, "").trim();
    const parsed = Number(cleaned);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function money(value) {
  return Math.round(number(value) * 100) / 100;
}

function csvList(value) {
  return text(value).split(",").map(item => item.trim()).filter(Boolean);
}

function normalizeText(value) {
  return text(value).toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim();
}

function normalizeAccountId(value) {
  return text(value).toLowerCase().replace(/^act[_-]?/, "").replace(/[^a-z0-9]+/g, "");
}

function filterGroup(conditions, joiner = "or") {
  const clean = conditions.filter(Boolean);
  if (!clean.length) return null;
  if (clean.length === 1) return clean[0];
  return clean.slice(1).reduce((group, condition) => [group, joiner, condition], clean[0]);
}

function fieldList(value) {
  return csvList(value).map(field => field.trim()).filter(Boolean);
}

function ensureFields(fields, requiredFields = []) {
  const existing = fieldList(fields || "date,campaign,spend");
  const seen = new Set(existing.map(field => field.toLowerCase()));
  for (const field of requiredFields.map(text).filter(Boolean)) {
    if (!seen.has(field.toLowerCase())) {
      existing.push(field);
      seen.add(field.toLowerCase());
    }
  }
  return existing.join(",");
}

function dateOnly(value) {
  const raw = text(value);
  const match = raw.match(/\d{4}-\d{2}-\d{2}/);
  return match ? match[0] : "";
}

function configuredChannels(env = process.env) {
  return Object.fromEntries(Object.entries(DEFAULT_CHANNELS).map(([name, defaults]) => {
    const prefix = defaults.envPrefix;
    const accountIds = csvList(env[`${prefix}_ACCOUNT_IDS`] || env.WINDSOR_ACCOUNT_IDS || "");
    const accountNames = csvList(env[`${prefix}_ACCOUNT_NAMES`] || env.WINDSOR_ACCOUNT_NAMES || "");
    const explicitNameTokens = csvList(env[`${prefix}_ACCOUNT_NAME_CONTAINS`] || env.WINDSOR_ACCOUNT_NAME_CONTAINS || "");
    const accountNameContains = explicitNameTokens.length
      ? explicitNameTokens
      : (accountIds.length || accountNames.length ? [] : DEFAULT_ALLOWED_ACCOUNT_TOKENS);
    const accountFilterField = text(env[`${prefix}_ACCOUNT_FILTER_FIELD`] || env.WINDSOR_ACCOUNT_FILTER_FIELD) || defaults.accountFilterField;
    const accountIdFilterField = text(env[`${prefix}_ACCOUNT_ID_FILTER_FIELD`] || env.WINDSOR_ACCOUNT_ID_FILTER_FIELD) || defaults.accountIdFilterField;
    const accountParam = text(env[`${prefix}_ACCOUNT_PARAM`] || env.WINDSOR_ACCOUNT_PARAM) || defaults.accountParam;
    return [name, {
      ...defaults,
      connector: text(env[`${prefix}_CONNECTOR`]) || defaults.connector,
      fields: ensureFields(text(env[`${prefix}_FIELDS`]) || "date,campaign,spend", [accountIdFilterField, accountFilterField]),
      accountParam,
      accountFilterField,
      accountIdFilterField,
      accountIds,
      accountNames,
      accountNameContains,
      enabled: text(env[`${prefix}_ENABLED`] || "true").toLowerCase() !== "false"
    }];
  }));
}

function channelConfig(name, env = process.env) {
  const channels = configuredChannels(env);
  return channels[name] || null;
}

function accountFilterForChannel(channel = {}) {
  const nameField = text(channel.accountFilterField) || "account_name";
  const nameConditions = (channel.accountNames || []).map(name => [nameField, "contains", text(name)]);
  const tokenConditions = (channel.accountNameContains || []).map(token => [nameField, "contains", text(token)]);
  return filterGroup([
    filterGroup(nameConditions, "or"),
    filterGroup(tokenConditions, "and")
  ], "or");
}

function channelHasAccountScope(channel = {}) {
  return Boolean(
    (channel.accountIds || []).length ||
    (channel.accountNames || []).length ||
    (channel.accountNameContains || []).length
  );
}

function accountScopeLabel(channel = {}) {
  if ((channel.accountIds || []).length) return `${channel.accountIds.length} account id${channel.accountIds.length === 1 ? "" : "s"}`;
  if ((channel.accountNames || []).length) return channel.accountNames.join(", ");
  if ((channel.accountNameContains || []).length) return channel.accountNameContains.join(" + ");
  return "not scoped";
}

function accountConnectorParams(channel = {}) {
  const param = text(channel.accountParam);
  const accountIds = channel.accountIds || [];
  if (!param || !accountIds.length) return {};
  return { [param]: accountIds.join(",") };
}

function buildWindsorUrl({ apiKey, connector, fields, startDate, endDate, refreshSince = "", refreshInterval = "", filter = null, connectorParams = {} }) {
  if (!text(apiKey)) throw new Error("Set WINDSOR_API_KEY before syncing marketing spend.");
  if (!text(connector)) throw new Error("Choose a Windsor connector.");
  const params = new URLSearchParams();
  params.set("api_key", text(apiKey));
  params.set("fields", text(fields) || "date,campaign,spend");
  params.set("date_from", text(startDate));
  params.set("date_to", text(endDate));
  params.set("_renderer", "json");
  if (text(refreshSince)) params.set("refresh_since", text(refreshSince));
  if (text(refreshInterval)) params.set("refresh_interval", text(refreshInterval));
  if (filter) params.set("filter", JSON.stringify(filter));
  for (const [key, value] of Object.entries(connectorParams || {})) {
    if (text(key) && text(value)) params.set(key, text(value));
  }
  return `https://connectors.windsor.ai/${encodeURIComponent(text(connector))}?${params.toString()}`;
}

function rowsFromResponse(response) {
  if (Array.isArray(response)) return response;
  if (Array.isArray(response?.data)) return response.data;
  if (Array.isArray(response?.rows)) return response.rows;
  return [];
}

function firstValue(row, keys) {
  for (const key of keys) {
    if (row?.[key] != null && text(row[key])) return row[key];
  }
  return "";
}

function spendValue(row) {
  for (const key of ["spend", "cost", "amount_spent", "ad_spend"]) {
    if (row?.[key] != null) return money(row[key]);
  }
  return 0;
}

function stableKey(parts) {
  return parts.map(part => text(part).toLowerCase()).join("|");
}

function rowId(sourceRowKey) {
  return `windsor:${crypto.createHash("sha1").update(sourceRowKey).digest("hex")}`;
}

function normalizeRows(response, options = {}) {
  const connector = text(options.connector);
  const channel = text(options.channel) || "Marketing";
  const source = text(options.source) || "windsor";
  const fallbackCurrency = text(options.currency) || "GBP";
  return rowsFromResponse(response).map((row, index) => {
    const spendDate = dateOnly(firstValue(row, ["date", "day", "date_start", "start_date"]));
    const amount = spendValue(row);
    const campaignId = text(firstValue(row, ["campaign_id", "campaignid", "campaignId"]));
    const campaignName = text(firstValue(row, ["campaign", "campaign_name", "campaignName"]));
    const accountId = text(firstValue(row, ["account_id", "accountid", "accountId", "customer_id"]));
    const accountName = text(firstValue(row, ["account_name", "account", "customer_name"]));
    const currency = text(firstValue(row, ["currency", "account_currency", "currency_code"])) || fallbackCurrency;
    const sourceRowKey = stableKey([source, connector, spendDate, accountId, accountName, campaignId, campaignName || index]);
    return {
      id: rowId(sourceRowKey),
      source,
      connector,
      channel,
      spendDate,
      amount,
      currency,
      accountId,
      accountName,
      campaignId,
      campaignName,
      sourceRowKey,
      raw: row
    };
  }).filter(row => row.spendDate && row.amount > 0);
}

function rowMatchesAllowedAccount(row, channel = {}) {
  if (!channelHasAccountScope(channel)) return true;
  const accountId = normalizeAccountId(row.accountId);
  const accountName = normalizeText(row.accountName);
  if ((channel.accountIds || []).some(id => normalizeAccountId(id) && normalizeAccountId(id) === accountId)) return true;
  if ((channel.accountNames || []).some(name => {
    const clean = normalizeText(name);
    return clean && accountName.includes(clean);
  })) return true;
  const tokens = (channel.accountNameContains || []).map(normalizeText).filter(Boolean);
  if (tokens.length && tokens.every(token => accountName.includes(token))) return true;
  return false;
}

function filterRowsByAllowedAccounts(rows = [], channel = {}) {
  const kept = [];
  const rejected = [];
  for (const row of rows) {
    if (rowMatchesAllowedAccount(row, channel)) kept.push(row);
    else rejected.push(row);
  }
  return { rows: kept, rejected };
}

function aggregateDaily(rows = []) {
  const groups = new Map();
  for (const row of rows) {
    const key = stableKey([row.source, row.connector, row.spendDate]);
    const current = groups.get(key) || {
      source: row.source,
      connector: row.connector,
      channel: row.channel,
      startDate: row.spendDate,
      endDate: row.spendDate,
      amount: 0,
      currency: row.currency || "GBP",
      rowCount: 0
    };
    current.amount += number(row.amount);
    current.rowCount += 1;
    groups.set(key, current);
  }
  return [...groups.values()].map(group => ({
    ...group,
    id: `${group.source}:${group.connector}:${group.startDate}`,
    sourceKey: `${group.source}:${group.connector}:${group.startDate}`,
    amount: money(group.amount)
  })).sort((a, b) => a.startDate.localeCompare(b.startDate) || a.channel.localeCompare(b.channel));
}

module.exports = {
  DEFAULT_CHANNELS,
  accountConnectorParams,
  accountFilterForChannel,
  accountScopeLabel,
  aggregateDaily,
  buildWindsorUrl,
  channelConfig,
  channelHasAccountScope,
  configuredChannels,
  filterRowsByAllowedAccounts,
  normalizeRows,
  rowsFromResponse
};
