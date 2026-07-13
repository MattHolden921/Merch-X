(function collectionRankingModule(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.CollectionRanking = api;
}(typeof globalThis !== "undefined" ? globalThis : this, function collectionRankingFactory() {
  const COLOR_PHRASES = [
    "Powder Blue", "Light Blue", "Baby Blue", "Royal Blue", "Mid Blue", "Dark Blue",
    "Mid Grey", "Light Grey", "Dark Grey", "Light Pink", "Hot Pink", "Dusky Pink",
    "Mid Denim", "Dark Denim", "Washed Denim", "Sage Green", "Bottle Green",
    "Kingfisher", "Fuchsia", "Chocolate", "Charcoal", "Natural", "Oatmeal",
    "Magenta", "Emerald", "Mustard", "Burgundy", "Terracotta", "Lavender",
    "Cobalt", "Camel", "Coral", "Ecru", "Mint", "Mocha", "Multi", "Silver",
    "Taupe", "Teal", "Stone", "Black", "Blue", "Brown", "Cocoa", "Cream",
    "Denim", "Green", "Grey", "Ivory", "Khaki", "Lime", "Navy", "Olive",
    "Orange", "Pink", "Purple", "Red", "Sage", "White", "Yellow"
  ].sort((left, right) => right.length - left.length);

  const GA_STRATEGIES = new Set(["conversionLift", "goldDust"]);

  function clamp01(value) {
    return Math.max(0, Math.min(1, Number(value) || 0));
  }

  function normalizedKey(value) {
    return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  }

  function escapeRegExp(value) {
    return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function percentile(values, ratio = 0.9) {
    const sorted = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
    if (!sorted.length) return 0;
    const index = Math.max(0, Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1));
    return sorted[index];
  }

  function robustScale(value, cap, useLog = true) {
    const numeric = Math.max(0, Number(value) || 0);
    const ceiling = Math.max(0, Number(cap) || 0);
    if (!ceiling) return 0;
    return clamp01(useLog ? Math.log1p(numeric) / Math.log1p(ceiling) : numeric / ceiling);
  }

  function ageDays(product, now = Date.now()) {
    const raw = product.publishedAt || product.createdAt || product.updatedAt;
    const time = raw ? new Date(raw).getTime() : 0;
    return Number.isFinite(time) && time > 0 ? Math.max(0, (now - time) / 86400000) : 365;
  }

  function productCvr(product) {
    const views = Math.max(0, Number(product.gaViews) || 0);
    return views > 0 ? Math.max(0, Number(product.gaPurchases) || 0) / views : 0;
  }

  function smoothedCvr(product) {
    const views = Math.max(0, Number(product.gaViews) || 0);
    const purchases = Math.max(0, Number(product.gaPurchases) || 0);
    return (purchases + 1) / (views + 40);
  }

  function sellThrough(product) {
    const units = Math.max(0, Number(product.units) || 0);
    const stock = Math.max(0, Number(product.stock) || 0);
    return units + stock > 0 ? units / (units + stock) : 0;
  }

  function weeksCover(product, days) {
    const units = Math.max(0, Number(product.units) || 0);
    const stock = Math.max(0, Number(product.stock) || 0);
    const weeklyRate = units / Math.max(1, Number(days) || 30) * 7;
    return stock / Math.max(weeklyRate, 0.25);
  }

  function grossProfitContribution(product) {
    if (product.margin == null) return 0;
    return Math.max(0, Number(product.revenue) || 0) / 1.2 * clamp01(Number(product.margin) / 100);
  }

  function styleParts(product) {
    const title = String(product.title || "").replace(/\s+/g, " ").trim();
    const buyingCode = normalizedKey(product.buyingCode);
    let style = title;
    let color = String(product.color || "").trim();

    const candidates = [...new Set([color, ...COLOR_PHRASES].filter(Boolean))]
      .sort((left, right) => right.length - left.length);
    for (const phrase of candidates) {
      const match = new RegExp(`\\s+${escapeRegExp(phrase)}$`, "i");
      if (!match.test(style)) continue;
      style = style.replace(match, "").trim();
      color = phrase;
      break;
    }

    const fallbackStyle = normalizedKey(style || title);
    const productType = normalizedKey(product.productType);
    return {
      styleName: style || title,
      styleKey: buyingCode ? `buying:${buyingCode}` : `title:${productType}:${fallbackStyle}`,
      styleSource: buyingCode ? "buying code" : "title fallback",
      colorName: color
    };
  }

  function eligibilityReason(product) {
    const status = String(product.status || "").toUpperCase();
    if (status && status !== "ACTIVE") return `Not active (${status.toLowerCase()}); kept below eligible products`;
    if (status === "ACTIVE" && !product.publishedAt) return "Not published to the online store; kept below eligible products";
    if (Number(product.stock || 0) <= 0) return "No stock; kept below eligible products";
    return "";
  }

  function createContext(products, options = {}) {
    const days = Math.max(1, Number(options.days) || 30);
    const revenues = products.map(product => Math.max(0, Number(product.revenue) || 0));
    const units = products.map(product => Math.max(0, Number(product.units) || 0));
    const stocks = products.map(product => Math.max(0, Number(product.stock) || 0));
    const views = products.map(product => Math.max(0, Number(product.gaViews) || 0));
    const covers = products.map(product => weeksCover(product, days));
    const gpContributions = products.map(grossProfitContribution);
    const velocities = products.map(product => Math.max(0, Number(product.units) || 0) / Math.max(1, Math.min(days, ageDays(product, options.now))));
    const smoothedCvrs = products.filter(product => Number(product.gaViews || 0) > 0).map(smoothedCvr);
    return {
      days,
      now: options.now || Date.now(),
      gaAvailable: options.gaAvailable !== false,
      productCount: products.length,
      revenueCap: percentile(revenues),
      unitsCap: percentile(units),
      stockCap: percentile(stocks, 0.75),
      viewsCap: percentile(views),
      coverCap: Math.max(8, Math.min(26, percentile(covers, 0.8) || 8)),
      gpContributionCap: percentile(gpContributions),
      velocityCap: percentile(velocities),
      cvrCap: percentile(smoothedCvrs) || 0.05
    };
  }

  function signals(product, context) {
    const daysLive = Math.max(1, Math.min(context.days, ageDays(product, context.now)));
    const views = Math.max(0, Number(product.gaViews) || 0);
    const rawCvr = productCvr(product);
    const cvrConfidence = clamp01(views / 50);
    const smoothed = smoothedCvr(product);
    const marginAvailable = product.margin != null && Number.isFinite(Number(product.margin));
    const currentDepth = 1 - clamp01(((Number(product.currentPosition) || 1) - 1) / Math.max(context.productCount - 1, 1));
    const tags = (product.tags || []).join(" ").toLowerCase();
    const cover = weeksCover(product, context.days);
    return {
      sales: robustScale(product.revenue, context.revenueCap),
      units: robustScale(product.units, context.unitsCap),
      stock: robustScale(product.stock, context.stockCap, false),
      views: robustScale(views, context.viewsCap),
      underExposure: views > 0 ? 1 - robustScale(views, context.viewsCap) : 0,
      cvr: clamp01(smoothed / context.cvrCap) * cvrConfidence,
      rawCvr,
      cvrConfidence,
      recency: 1 - clamp01(ageDays(product, context.now) / 90),
      velocity: robustScale((Number(product.units) || 0) / daysLive, context.velocityCap),
      margin: marginAvailable ? clamp01(Number(product.margin) / 100) : 0,
      marginAvailable,
      currentDepth,
      sellThrough: sellThrough(product),
      weeksCover: cover,
      coverRisk: clamp01(cover / context.coverCap),
      gpContribution: robustScale(grossProfitContribution(product), context.gpContributionCap),
      saleTag: /\b(sale|clearance)\b/.test(tags) ? 1 : 0
    };
  }

  function scoreForStrategy(product, context, strategy) {
    const signal = signals(product, context);
    const stability = signal.currentDepth * 5;
    switch (strategy) {
      case "newArrivals":
        return signal.recency * 40 + signal.velocity * 25 + signal.stock * 15 + signal.margin * 10 + signal.sales * 5 + stability;
      case "conversionLift":
        return signal.cvr * 45 + signal.underExposure * 20 + signal.stock * 15 + signal.margin * 10 + signal.sales * 5 + stability;
      case "clearance":
        return signal.coverRisk * 30 + (1 - signal.sellThrough) * 20 + (1 - signal.sales) * 15 + signal.saleTag * 15 + (signal.marginAvailable ? (1 - signal.margin) * 10 : 0) + signal.stock * 5 + stability;
      case "highMargin":
        return signal.gpContribution * 35 + signal.margin * 25 + signal.sales * 15 + signal.stock * 10 + (context.gaAvailable ? signal.cvr * 10 : 5) + stability;
      case "goldDust":
        return signal.cvr * 45 + signal.underExposure * 20 + signal.margin * 10 + signal.stock * 10 + signal.gpContribution * 10 + stability;
      default:
        return signal.sales * 35 + signal.units * 25 + signal.gpContribution * 15 + signal.stock * 10 + signal.margin * 10 + stability;
    }
  }

  function reasonForStrategy(product, context, strategy) {
    const signal = signals(product, context);
    const parts = [];
    if (strategy === "newArrivals") {
      parts.push(`${Math.round(signal.recency * 100)}% launch recency`);
      parts.push(`${((Number(product.units) || 0) / Math.max(1, Math.min(context.days, ageDays(product, context.now)))).toFixed(2)} units/live day`);
    } else if (strategy === "conversionLift" || strategy === "goldDust") {
      parts.push(`${(signal.rawCvr * 100).toFixed(1)}% GA purchase CVR`);
      parts.push(`${Number(product.gaViews || 0).toLocaleString("en-GB")} views`);
      if (signal.cvrConfidence < 0.5) parts.push("low confidence");
    } else if (strategy === "clearance") {
      parts.push(`${signal.weeksCover.toFixed(1)} weeks cover`);
      parts.push(`${Math.round(signal.sellThrough * 100)}% sell-through`);
      if (signal.saleTag) parts.push("sale/clearance tagged");
    } else if (strategy === "highMargin") {
      parts.push(signal.marginAvailable ? `${Math.round(Number(product.margin))}% GP` : "margin missing");
      parts.push(`£${Math.round(grossProfitContribution(product)).toLocaleString("en-GB")} recent GP contribution`);
    } else {
      parts.push(Number(product.revenue || 0) > 0 ? `£${Math.round(Number(product.revenue)).toLocaleString("en-GB")} net sales` : "no recent net sales");
      parts.push(`${Number(product.units || 0).toLocaleString("en-GB")} net units`);
    }
    if (!signal.marginAvailable && !parts.includes("margin missing")) parts.push("margin missing");
    return parts.slice(0, 3).join("; ");
  }

  function sortByScoreThenPosition(left, right) {
    return (right.score || 0) - (left.score || 0)
      || Number(left.currentPosition || 999999) - Number(right.currentPosition || 999999)
      || String(left.title || "").localeCompare(String(right.title || ""));
  }

  function groupCloseColourways(scored) {
    const groups = new Map();
    for (const product of scored) {
      const group = groups.get(product.styleKey) || [];
      group.push(product);
      groups.set(product.styleKey, group);
    }

    const used = new Set();
    const blocks = [];
    for (const product of scored) {
      if (used.has(product.id)) continue;
      const candidates = (groups.get(product.styleKey) || []).filter(item => !used.has(item.id)).sort(sortByScoreThenPosition);
      const first = candidates[0];
      const maxGap = first.styleSource === "buying code" ? 15 : 10;
      const second = candidates.slice(1).find(item => Math.abs((first.score || 0) - (item.score || 0)) <= maxGap);
      if (!second) {
        used.add(first.id);
        blocks.push({ score: first.score, items: [first] });
        continue;
      }
      used.add(first.id);
      used.add(second.id);
      const note = `paired colourway via ${first.styleSource}`;
      blocks.push({
        score: Math.max(first.score || 0, second.score || 0),
        items: [first, second].map(item => ({ ...item, reason: `${item.reason}; ${note}` }))
      });
    }
    return blocks.sort((left, right) => (right.score || 0) - (left.score || 0)).flatMap(block => block.items);
  }

  function rankProducts(products, options = {}) {
    const strategy = options.strategy || "bestSellers";
    const context = createContext(products, options);
    if (GA_STRATEGIES.has(strategy) && !context.gaAvailable) {
      return { rows: [], unavailableReason: "GA4 ecommerce data is required for this strategy.", context };
    }

    const eligible = [];
    const ineligible = [];
    for (const product of products) {
      const excludedReason = eligibilityReason(product);
      const parts = styleParts(product);
      if (excludedReason) {
        ineligible.push({ ...product, ...parts, baseScore: 0, score: 0, reason: excludedReason });
        continue;
      }
      const score = scoreForStrategy(product, context, strategy);
      eligible.push({
        ...product,
        ...parts,
        baseScore: score,
        score,
        reason: reasonForStrategy(product, context, strategy)
      });
    }
    eligible.sort(sortByScoreThenPosition);
    ineligible.sort((left, right) => Number(left.currentPosition || 999999) - Number(right.currentPosition || 999999));
    return { rows: groupCloseColourways(eligible).concat(ineligible), unavailableReason: "", context };
  }

  return {
    GA_STRATEGIES,
    ageDays,
    createContext,
    eligibilityReason,
    productCvr,
    rankProducts,
    signals,
    styleParts,
    weeksCover
  };
}));
