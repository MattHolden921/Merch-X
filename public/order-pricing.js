(function exposeOrderPricing(root, factory) {
  const pricing = factory();
  if (typeof module === "object" && module.exports) module.exports = pricing;
  else root.MerchXOrderPricing = pricing;
}(typeof globalThis !== "undefined" ? globalThis : this, function createOrderPricing() {
  const VAT_RATE = 0.2;
  const RRP_MULTIPLIER = 5;

  function calculateRrpGbp(unitCostGbp) {
    return Number(unitCostGbp || 0) * RRP_MULTIPLIER;
  }

  function calculateVatInflatedRegressionRrpGbp(unitCostGbp) {
    return calculateRrpGbp(unitCostGbp) * (1 + VAT_RATE);
  }

  return {
    VAT_RATE,
    RRP_MULTIPLIER,
    calculateRrpGbp,
    calculateVatInflatedRegressionRrpGbp
  };
}));
