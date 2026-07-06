"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  accountConnectorParams,
  accountFilterForChannel,
  aggregateDaily,
  buildWindsorUrl,
  channelFields,
  configuredChannels,
  filterRowsByAllowedAccounts,
  normalizeRows
} = require("../lib/windsor-marketing");

test("builds Windsor connector URLs for a dated spend query", () => {
  const url = new URL(buildWindsorUrl({
    apiKey: "abc123",
    connector: "google_ads",
    fields: "date,campaign,spend",
    startDate: "2026-06-01",
    endDate: "2026-06-07",
    refreshSince: "3d",
    refreshInterval: "1h",
    filter: [["account_name", "contains", "kit"], "and", ["account_name", "contains", "kaboodal"]],
    connectorParams: { account_id: "1234567890" }
  }));

  assert.equal(url.origin, "https://connectors.windsor.ai");
  assert.equal(url.pathname, "/google_ads");
  assert.equal(url.searchParams.get("api_key"), "abc123");
  assert.equal(url.searchParams.get("fields"), "date,campaign,spend");
  assert.equal(url.searchParams.get("date_from"), "2026-06-01");
  assert.equal(url.searchParams.get("date_to"), "2026-06-07");
  assert.equal(url.searchParams.get("refresh_interval"), "1h");
  assert.deepEqual(JSON.parse(url.searchParams.get("filter")), [["account_name", "contains", "kit"], "and", ["account_name", "contains", "kaboodal"]]);
  assert.equal(url.searchParams.get("account_id"), "1234567890");
});

test("normalizes Windsor Google and Meta rows into auditable spend rows", () => {
  const rows = normalizeRows({
    data: [
      { date: "2026-06-01", campaign: "Brand Search", spend: "123.45" },
      { date: "2026-06-01", campaign_name: "Shopping", amount_spent: "76.55", currency: "GBP" },
      { date: "not-a-date", campaign: "Ignored", spend: "5" },
      { date: "2026-06-02", campaign: "Zero", spend: "0" }
    ]
  }, { connector: "google_ads", channel: "Google" });

  assert.equal(rows.length, 2);
  assert.equal(rows[0].source, "windsor");
  assert.equal(rows[0].connector, "google_ads");
  assert.equal(rows[0].channel, "Google");
  assert.equal(rows[0].spendDate, "2026-06-01");
  assert.equal(rows[0].amount, 123.45);
  assert.equal(rows[1].campaignName, "Shopping");
  assert.equal(rows[1].amount, 76.55);
  assert.ok(rows[0].sourceRowKey.includes("brand search"));
});

test("aggregates Windsor campaign rows into daily P&L marketing entries", () => {
  const rows = normalizeRows([
    { date: "2026-06-01", campaign: "A", spend: 100 },
    { date: "2026-06-01", campaign: "B", spend: 50 },
    { date: "2026-06-02", campaign: "A", spend: 25 }
  ], { connector: "facebook", channel: "Meta" });

  const daily = aggregateDaily(rows);

  assert.deepEqual(daily.map(entry => entry.startDate), ["2026-06-01", "2026-06-02"]);
  assert.equal(daily[0].id, "windsor:facebook:2026-06-01");
  assert.equal(daily[0].sourceKey, "windsor:facebook:2026-06-01");
  assert.equal(daily[0].amount, 150);
  assert.equal(daily[0].rowCount, 2);
  assert.equal(daily[1].amount, 25);
});

test("allows Windsor connector and field overrides from environment", () => {
  const channels = configuredChannels({
    WINDSOR_GOOGLE_CONNECTOR: "google_search_ads",
    WINDSOR_GOOGLE_FIELDS: "date,campaign,spend,account_id",
    WINDSOR_META_ENABLED: "false"
  });

  assert.equal(channels.Google.connector, "google_search_ads");
  assert.equal(channels.Google.fields, "date,campaign,spend,account_id,account_name");
  assert.equal(channels.Google.accountParam, "account_id");
  assert.equal(channels.Meta.accountParam, "account");
  assert.equal(channelFields(channels.Google), "date,campaign,spend,account_id,account_name,conversion_value");
  assert.equal(channels.Meta.enabled, false);
});

test("normalizes and aggregates Windsor attributed revenue", () => {
  const rows = normalizeRows([
    { date: "2026-06-01", campaign: "Brand", spend: 100, all_conversions_value: 500 },
    { date: "2026-06-01", campaign: "Shopping", spend: 50, all_conversions_value: 250 }
  ], { connector: "google_ads", channel: "Google", revenueFields: ["all_conversions_value"], revenueWeight: 1.2 });
  const daily = aggregateDaily(rows);

  assert.equal(rows[0].attributedRevenue, 500);
  assert.equal(rows[0].attributionWeight, 1.2);
  assert.equal(daily[0].amount, 150);
  assert.equal(daily[0].attributedRevenue, 750);
  assert.equal(daily[0].attributedRoas, 5);
});

test("scopes Windsor rows to Kit and Kaboodal accounts", () => {
  const channels = configuredChannels({});
  const filter = accountFilterForChannel(channels.Google);
  assert.deepEqual(filter, [["account_name", "contains", "kit"], "and", ["account_name", "contains", "kaboodal"]]);

  const rows = normalizeRows([
    { date: "2026-06-01", account_name: "Kit & Kaboodal", campaign: "Brand", spend: 100 },
    { date: "2026-06-01", account_name: "Other Brand", campaign: "Brand", spend: 200 },
    { date: "2026-06-01", campaign: "Missing account", spend: 300 }
  ], { connector: "google_ads", channel: "Google" });

  const scoped = filterRowsByAllowedAccounts(rows, channels.Google);
  assert.equal(scoped.rows.length, 1);
  assert.equal(scoped.rows[0].amount, 100);
  assert.equal(scoped.rejected.length, 2);
});

test("uses exact Windsor account ids without the default name fallback", () => {
  const channels = configuredChannels({
    WINDSOR_GOOGLE_ACCOUNT_IDS: "123,456"
  });
  assert.equal(accountFilterForChannel(channels.Google), null);
  assert.deepEqual(accountConnectorParams(channels.Google), { account_id: "123,456" });

  const rows = normalizeRows([
    { date: "2026-06-01", account_id: "act_123", account_name: "Kit & Kaboodal", campaign: "Brand", spend: 100 },
    { date: "2026-06-01", account_id: "999", account_name: "Kit & Kaboodal", campaign: "Other", spend: 200 }
  ], { connector: "google_ads", channel: "Google" });

  const scoped = filterRowsByAllowedAccounts(rows, channels.Google);
  assert.equal(scoped.rows.length, 1);
  assert.equal(scoped.rows[0].accountId, "act_123");
});

test("uses Meta account connector parameter", () => {
  const channels = configuredChannels({
    WINDSOR_META_ACCOUNT_IDS: "2187569"
  });
  assert.deepEqual(accountConnectorParams(channels.Meta), { account: "2187569" });
});
