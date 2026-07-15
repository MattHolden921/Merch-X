(() => {
  const keys = {
    "index.html": {
      title: "Workspace key",
      intro: "Use the workspace groups to choose the source and action that match the decision you need to make.",
      sections: [
        ["Workspace groups", [
          ["Performance", "Trading, profitability and product-performance views fed by Shopify, GA4 and saved reports."],
          ["Buying & supply", "Product, supplier, purchase-order, intake and SKU workflows."],
          ["Planning & action", "Collection, sale, email and weekly-action tools that turn signals into reviewed actions."]
        ]],
        ["Data and access", [
          ["Live vs saved", "Each tool states whether it is reading live integration data, a saved snapshot or locally entered records."],
          ["Roles", "Your assigned roles determine which tools and write actions are available; read-only access never grants an apply or send action."],
          ["Messages", "Notifications and handoffs are shared team follow-ups, not changes to Shopify or another external system by themselves."]
        ]]
      ]
    },
    "login.html": {
      title: "Sign-in key",
      intro: "Access is limited to the configured company workspace and the permissions attached to your account.",
      sections: [
        ["Access", [
          ["Company Google account", "Use an account from an allowed Workspace domain. A successful Google sign-in identifies you to Merch X."],
          ["Shared password", "Where enabled, the browser-level shared password is an outer gate before Google sign-in; it does not replace your named account."],
          ["Return page", "After sign-in you return to the page you originally requested when that destination is safe and available."]
        ]],
        ["Permissions", [
          ["Active user", "An administrator must activate your user record before protected tools become available."],
          ["Roles", "Roles control tool visibility and write actions. Contact an administrator if the page you need is not available."]
        ]]
      ]
    },
    "admin-users.html": {
      title: "User administration key",
      intro: "Activate known Google Workspace users and assign only the roles they need.",
      sections: [
        ["User state", [
          ["Active", "Allows the named Google user to access Merch X, subject to their roles."],
          ["Inactive", "Blocks application access without deleting the user record or audit identity."],
          ["Last login", "The most recent successful Merch X sign-in for that account."]
        ]],
        ["Roles and changes", [
          ["Roles", "Roles are cumulative: Admin, Buyer, Buying Director, Finance, Merchandising and Marketing each unlock their current job-specific pages and actions."],
          ["Admin", "Overrides other permission checks and grants user administration, approvals and protected Shopify writes. Assign sparingly."],
          ["New users", "Appear after attempting company Google sign-in and normally remain inactive until an Admin activates them."],
          ["Save", "Role and activation changes take effect for subsequent authorised requests; they do not rewrite historical activity."]
        ]]
      ]
    },
    "bestsellers.html": {
      title: "Bestsellers key",
      intro: "A short orientation to the report. Open Methodology for the complete column-by-column formulas and checks.",
      sections: [
        ["Sales and profit", [
          ["Demand", "Product sales including VAT, after discounts and before returns, for the loaded range."],
          ["Despatch", "Shopify total sales for the loaded range, after discounts and returns and including shipping and tax effects."],
          ["Net sales", "Product revenue after discounts and returns, excluding VAT. Forecast and GP calculations use this basis."],
          ["Discounts / refunds", "Discount-code and order-discount value is shown separately from refunds processed in the selected period; both visible card values include VAT."],
          ["GP%", "Gross profit divided by costed net sales excluding VAT, including Sales by Season rows and totals; missing cost remains visible rather than being treated as zero margin.", "GP% = gross profit ÷ costed net sales ex VAT"]
        ]],
        ["Trading measures", [
          ["ROS", "Net units sold divided by the active range length in weeks.", "weekly ROS = net units ÷ active weeks"],
          ["Sell-through", "Net units sold as a share of net units plus current stock.", "sell-through = net units ÷ (net units + stock)"],
          ["Weeks cover", "Current stock divided by weekly ROS; unavailable when ROS is zero."],
          ["Main-table buy", "Projects from the selected run rate to the chosen season-end date, less current stock and never below zero.", "forecast buy = ceil(weekly ROS × weeks to season end) − stock"]
        ]],
        ["Views and sources", [
          ["TY / LY", "This Year and Last Year comparisons use the selected saved or imported date ranges."],
          ["Forecast & Buy", "Projects two forward periods, each matching the decision-period duration. It is a planning estimate, not an order."],
          ["Cost coverage", "Shows how much sold revenue/units had known cost. Incomplete coverage should temper GP conclusions."],
          ["Full price / markdown", "Uses selling price before discount codes versus RRP; a discount code alone does not make a product markdown."],
          ["Mix Performance", "Compares the share of sales with the share of current stock by department and category."],
          ["Methodology", "The in-page Methodology view is the detailed source for every report formula, VAT basis and sanity check."]
        ]]
      ]
    },
    "pnl.html": {
      title: "P&L planner key",
      intro: "Actuals use ShopifyQL for the selected dates; scenarios are decision-support estimates and are not accounting entries.",
      sections: [
        ["Sales and profit", [
          ["Demand", "Product sales including VAT, after discounts and before returns."],
          ["Despatch", "Shopify total sales for the period. AOV uses Despatch divided by order count."],
          ["Net sales", "Total product revenue excluding VAT after discounts and returns; the net-profit percentage denominator."],
          ["Gross profit", "ShopifyQL reported gross profit for sales with product cost recorded. GP% uses the matching costed net sales excluding VAT, derived as gross profit plus COGS.", "GP% = gross profit ÷ (gross profit + COGS)"]
        ]],
        ["Costs", [
          ["Variable costs", "Non-fixed cost rules such as fulfilment, postage, pick/pack and payment fees."],
          ["Fixed cost drag", "Prorated fixed monthly costs as a share of net sales excluding VAT.", "fixed cost drag = fixed monthly costs ÷ net sales ex VAT"],
          ["Contribution before fixed", "Gross profit after marketing and variable costs, before fixed monthly overhead."],
          ["Net profit", "Gross profit after marketing, variable costs and fixed costs; Net profit % uses net sales excluding VAT."]
        ]],
        ["Scenarios", [
          ["Drivers", "Daily Despatch, AOV, marketing, ROAS, GP% and items per order reshape the selected scenario."],
          ["Marketing drives sales", "When enabled, marketing spend and return move the linked Despatch target; uplift is not added twice."],
          ["Break-even ROAS", "The minimum incremental Despatch return needed for extra marketing spend not to reduce net profit."],
          ["Temporary comparisons", "Named scenario comparisons stay only in the current page and clear when a new actual period loads."]
        ]]
      ]
    },
    "merchandising.html": { existing: true },
    "new-in-performance.html": {
      title: "New In performance key",
      intro: "A read-only launch and image-refresh view combining Shopify trading data with GA4 engagement when available.",
      sections: [
        ["Cohorts", [
          ["New launch", "Uses Shopify published date, falling back to created date only for active products without a publish timestamp."],
          ["Updated image", "The featured Shopify media image was created or updated inside the selected image window."],
          ["Draft pipeline", "A recent Shopify draft that is not yet live; live-day performance is not shown until publication."]
        ]],
        ["Metrics", [
          ["Sales", "Shopify net sales after discounts and reversals, displayed including VAT for the sales window."],
          ["GP / GP%", "Achieved gross profit uses Shopify's dated COGS. GP% divides it by the matching costed net sales excluding VAT, so uncosted sales do not overstate or understate margin."],
          ["Engagement / selected-period CVR", "Views, add-to-carts and CVR use the selected Sales start/end period. CVR is Shopify net units divided by GA4 item views and will not necessarily reconcile to GA4 purchase conversion."],
          ["Sell-through", "Selected-period net units divided by net units plus current positive stock; current stock is not a launch-date snapshot."],
          ["Image-impact CVR", "A separate before/after comparison anchored to the featured-image change date. Its dates can differ from the selected sales period, so it should not be expected to match the Engagement CVR. Sales and units are normalised per available day."]
        ]],
        ["Actions", [
          ["Push / Needs exposure", "Advisory opportunities to feature a product or increase its visibility. GA-derived exposure calls require usable GA4 data."],
          ["Image test / Content check", "Signals that imagery or product-page content may need review."],
          ["Stock watch / Sold out", "Availability risk that can limit the value of additional exposure."],
          ["Watch", "No stronger advisory action currently applies; no external change is made automatically."]
        ]]
      ]
    },
    "weekly-actions.html": {
      title: "Weekly actions key",
      intro: "A saved follow-up board generated from a selected Bestsellers period; it does not change Shopify automatically.",
      sections: [
        ["Action types", [
          ["Reorder", "At least two units sold with a positive eight-week forecast buy or no more than four weeks of cover."],
          ["Markdown risk", "Stock available with no sales, or no more than two units sold and at least 12 weeks of cover."],
          ["Feature winner", "A leading-revenue product with at least three units sold, five in stock and at least 45% GP where GP exists."],
          ["Watch", "A mixed signal such as incomplete cost, four-to-eight weeks of cover, or sales with no stock and no forecast buy."]
        ]],
        ["Workflow", [
          ["Generated period", "A saved completed Monday–Sunday Bestsellers week. Action metrics are snapshots, not continuously live."],
          ["Preview / Generate", "Preview shows the intended refresh/create result without writing; Generate creates a capped prioritised shortlist."],
          ["Forecast buy", "Uses the Weekly Actions eight-week horizon and can differ from the Bestsellers main table’s season-end buy."],
          ["Owner and due date", "Team accountability fields; changing them updates the board, not product or order data."],
          ["Status", "Tracks follow-up from open work through completion or dismissal."],
          ["Notes and events", "A dated audit trail of updates made to the action."]
        ]]
      ]
    },
    "order-form.html": {
      title: "Stock order form key",
      intro: "Build a purchase order, issue safe local SKUs and calculate buying values before saving it into the Orders workflow.",
      sections: [
        ["Pricing", [
          ["FX rate", "EUR-to-GBP rate used for the line cost.", "cost GBP = cost EUR × FX rate"],
          ["Supplier total", "Ordered quantity multiplied by unit cost in GBP; VAT is not added to the supplier amount.", "supplier total = quantity × unit cost GBP"],
          ["5× RRP", "The intended customer RRP is five times unit cost. Do not add VAT again.", "5× RRP = unit cost GBP × 5"],
          ["65% exit retail", "Retail price that leaves a 65% gross margin after removing VAT.", "65% exit retail = (unit cost GBP ÷ 0.35) × 1.2"],
          ["VAT reference", "The 20% VAT tile supports retail pricing only; it is not added to supplier total or invoice reconciliation."]
        ]],
        ["Products and SKUs", [
          ["Local SKU", "A Merch X-issued SKU reserved against existing products, orders and prior issued numbers."],
          ["Buying code", "Supplier/style code shared by related variants or colourways; it is not the same as the unique SKU."],
          ["Colour and material", "Stored as separate product attributes so downstream product and Shopify workflows keep their meaning."],
          ["Line image", "Saved with the order line and available to warehouse and product workflows."]
        ]],
        ["Saving", [
          ["Purchase order", "Saving creates the order snapshot and enriches related supplier/product records without wiping curated master data."],
          ["Credit balance", "Outstanding supplier credit shown for context; it is not automatically applied to the new order."],
          ["Next step", "Approval, payment and intake are managed from Orders after the form is saved."]
        ]]
      ]
    },
    "orders.html": {
      title: "Orders key",
      intro: "The operational workspace for approval, payment, supplier batches, intake, discrepancies and supporting documents.",
      sections: [
        ["Workflow", [
          ["Approval", "Buying Director approval is tracked independently from Finance payment and Merchandising intake."],
          ["Payment", "Tracks deposit, balance or payment progress; invoice matching uses ordered supplier cost without a VAT uplift."],
          ["Product gate", "Every line needs a SKU connected to a recognised Shopify product/state before batches and receipts can be booked."],
          ["Batch vs order Received", "A batch Received is a factual delivery state; the order reaches Received only after all batches and discrepancy review."],
          ["Composite status", "A derived order status based on the current approval, payment, intake and archive state."]
        ]],
        ["Receipt and finance", [
          ["Expected", "Quantity assigned to the selected supplier batch or remaining unbatched scope."],
          ["Accepted", "Defaults to received less damaged units.", "accepted = received − damaged"],
          ["Fill / outstanding", "Fill rate compares accepted with expected; outstanding never falls below zero.", "fill = accepted ÷ expected; outstanding = max(order units − accepted, 0)"],
          ["Variance", "Accepted quantity compared with expected quantity; shortages, damage and overages can create discrepancy records."],
          ["Credit due", "Open credit-note value linked to unresolved discrepancies and carried into the supplier balance."]
        ]],
        ["Reports and checks", [
          ["Live / New Arrivals", "Read-only Shopify check by SKU for active/live state and the exact New Arrivals collection tag."],
          ["Warehouse report", "Printable order-line image and quantity report for the selected batch scope."],
          ["Label job", "Immutable barcode-label snapshot using two Code 128 SKU labels per ordered unit plus configured spares. Choose all lines in the current scope or select only newly added colour/style lines for a follow-up job. Blocking issues stop generation; warnings require confirmation before the job is created."],
          ["Archive vs delete", "Archive preserves the record outside active work; delete is a restricted destructive action."]
        ]]
      ]
    },
    "order-reports.html": {
      title: "Order reports key",
      intro: "Read-only operational summaries assembled from saved orders, workflow, receipt, discrepancy and invoice records.",
      sections: [
        ["Report areas", [
          ["Arrivals", "Expected and received supplier batches, including due dates and intake progress."],
          ["Intake exceptions", "Shortage, damage, overage or unmatched receipt issues that need review."],
          ["Next actions", "Orders needing approval, payment, supplier or intake follow-up."],
          ["Finance", "Ordered value, invoices, payments and open supplier credits; it is an operational view, not a posted ledger."]
        ]],
        ["Measures", [
          ["Ordered", "Purchase-order quantity or value saved on the order snapshot."],
          ["Received / accepted", "Physical receipt quantity and the portion accepted after damaged/rejected units."],
          ["Variance", "Accepted compared with expected for the relevant receipt scope."],
          ["Supplier on-time", "Received batches on or before ETA divided by received batches; the current report also counts a received batch with no ETA as on-time."],
          ["Data quality", "Missing or inconsistent order data that can make another report incomplete."],
          ["Filter scope", "Supplier Performance currently responds to Supplier, while other report areas use their displayed filters and inclusive due dates."]
        ]]
      ]
    },
    "supplier-report.html": {
      title: "Supplier report key",
      intro: "A supplier-led, read-only view of orders, product lines, receipts, discrepancies and credit exposure.",
      sections: [
        ["Operational measures", [
          ["Ordered", "Quantity and supplier-cost value committed on saved purchase orders."],
          ["Expected", "Quantity due in the selected batch or unbatched scope."],
          ["Accepted", "Received units accepted after damaged/rejected quantities."],
          ["Variance", "Accepted quantity compared with expected quantity."]
        ]],
        ["Supplier performance", [
          ["On-time", "Receipt timing compared with the saved expected-arrival date where both values are available."],
          ["Discrepancy", "A shortage, damage or overage record raised from intake."],
          ["Credit due", "Signed credit-note value still outstanding on unresolved supplier discrepancies."],
          ["Product value estimates", "Product-tab cost and retail totals use current master cost/RRP multiplied by historical ordered units, not historical PO prices."],
          ["Coverage", "Metrics reflect only saved Merch X orders and receipt data; missing dates or receipts remain visible as incomplete data."]
        ]]
      ]
    },
    "products.html": {
      title: "Products & suppliers key",
      intro: "Merch X is the pre-launch product master; Shopify remains the live commerce destination after a controlled draft push.",
      sections: [
        ["Product status", [
          ["Draft", "Local product still being completed."],
          ["Ready for Shopify", "Local record marked ready and eligible for validation before draft creation."],
          ["Shopify draft", "A Shopify-linked product state. Sync status can remain Synced draft even after a linked product later becomes Live or Archived."],
          ["Live / Archived", "Live represents a launched product; Archived removes the local record from active work without deleting its history."]
        ]],
        ["Sync and readiness", [
          ["Readiness", "Requires SKU, supplier, title/style, RRP, product type, image, cost and unique local SKU."],
          ["Sync status", "Not synced, Ready, Synced draft, Conflict or Error describes the handoff/link state; it is separate from product status."],
          ["Preview", "Validates and shows the intended Shopify draft payload without creating a product."],
          ["Push draft", "Creates a Shopify DRAFT only; inventory quantity is not written by this workflow."]
        ]],
        ["Identifiers", [
          ["SKU", "Unique local sellable identifier."],
          ["Buying code", "Style-level code used to group related colourways; written to Shopify custom metadata on new draft creation."],
          ["Colour", "Product-level colour metadata; Size remains the only Shopify variant option for new drafts."],
          ["Supplier credit", "Open credit exposure derived from unresolved discrepancy credit notes."]
        ]]
      ]
    },
    "sku-register.html": {
      title: "SKU register key",
      intro: "A controlled register of locally issued SKU numbers and the products or orders that use them.",
      sections: [
        ["SKU state", [
          ["Local SKU", "A record whose saved source is local rather than Shopify-sourced; it may later become linked to Shopify."],
          ["Issued only", "Reserved by Merch X with no saved product detail attached."],
          ["Used", "Referenced by a saved product or order and therefore protected from deletion."],
          ["Unused", "Issued but not referenced by saved product or order data; eligible for safe deletion."],
          ["Next SKU", "The issuer moves forward from the saved cursor and skips every number already in use or reserved."]
        ]],
        ["Deletion", [
          ["Safe deletion", "Admin-only removal of an unused reservation after the server rechecks product and order references; the number may be issued again."],
          ["Product data", "Deleting an eligible reservation does not delete a product or order; referenced SKUs cannot be selected."],
          ["Access", "The page is limited to configured roles because SKU reuse affects future product creation."]
        ]]
      ]
    },
    "collection-planner.html": {
      title: "Collection planner key",
      intro: "Ranks the complete synced Shopify collection, previews movement, and applies only after strict safety checks.",
      sections: [
        ["Strategies", [
          ["Best Sellers", "Balances net sales, net units, gross-profit contribution, stock and margin."],
          ["New Arrivals", "Adds units per live day so recently launched products can compete fairly."],
          ["Clearance", "Prioritises high cover, weak sell-through, weak sales and sale signals."],
          ["High Margin", "Prioritises gross-profit contribution and GP% excluding VAT."],
          ["Conversion Lift / Gold Dust", "Use GA4 ecommerce purchases divided by item views with smoothing and view confidence; unavailable without GA4."],
          ["Manual Lift", "Stages recently updated featured images from the selected current position without reranking everything else."]
        ]],
        ["Eligibility and metrics", [
          ["Eligible", "Active, Online Store-published and in-stock products rank above ineligible products."],
          ["GP%", "Calculated excluding VAT from price and variant cost; the lowest known variant margin is used."],
          ["Move", "Positive means moving up the collection; negative means moving down."],
          ["Global position", "Ranking happens before search and movement filters, so filtering never changes the suggested position."],
          ["Colourway group", "Uses buying code first, then a conservative title/type fallback for legacy products."]
        ]],
        ["Apply safeguards", [
          ["Baseline", "A hash of the fully synced Shopify order; Apply stops if live order has changed."],
          ["Preflight", "Strategy Apply requires Admin access, Full Collection, cleared filters, typed APPLY, complete data and an unchanged exact product count."],
          ["Verified apply", "The server re-reads Shopify and confirms the final order before recording success."],
          ["CSV / Print", "Review outputs only; exporting does not change Shopify."]
        ]]
      ]
    },
    "sale-planner.html": {
      title: "Sale planner key",
      intro: "Plans markdown prices, checks live Shopify state and applies or removes sale state through a durable reviewed job.",
      sections: [
        ["Plan and row states", [
          ["Draft / Awaiting approval / Ready", "Editable plan, submitted snapshot awaiting Admin, or Admin-approved snapshot eligible for preflight."],
          ["Planned / Applied / Removed / Error", "Product-row state before apply, after Shopify apply, after restore, or after a failed job step."],
          ["Current", "Saved plan price used for review; live Shopify is rechecked during preflight and reconciliation."],
          ["Original", "First true RRP from the restoration ledger where available, then saved/Shopify fallbacks."]
        ]],
        ["Pricing", [
          ["RRP", "Original selling price used as the markdown anchor; the variant ledger preserves the first true RRP."],
          ["Target price", "Original price reduced by the markdown and rounded by the configured rule, currently nearest pound.", "target = original × (1 − discount %)"],
          ["Markdown investment", "Reduction from original retail across the selected stock quantity."],
          ["Target GP%", "Calculated excluding VAT from target price and cost; row GP uses the lowest variant margin.", "target GP% = ((target ÷ 1.2) − cost) ÷ (target ÷ 1.2)"],
          ["Projected GP", "Target ex-VAT retail less known cost for selected rows, or filtered rows when none selected; unknown costs are excluded."]
        ]],
        ["States and analysis", [
          ["Planned / Applied / Error", "Editable plan state, successfully applied Shopify state, or a row needing correction/retry."],
          ["Worked / Watch / Deepen / Remove", "Post-period recommendations based on comparable sell-through and GA4 CVR evidence."],
          ["Confidence", "Only medium/high-confidence outcomes from multiple comparable weeks train future markdown guidance."],
          ["Action queue", "Persistent shortlist of changed follow-ups; accepting an action does not itself update Shopify."]
        ]],
        ["Apply and remove", [
          ["Preflight", "Checks live price, product status, stock, collections, original price and stale plan state before any mutation."],
          ["Apply", "Writes target price and compare-at price, adds mapped Sale collections and sets the sale product-status metadata."],
          ["Remove", "Restores ledger RRP, clears compare-at price, removes stored Sale collections and resets sale metadata."],
          ["Durable job", "Item checkpoints allow safe resume after partial failure; reconciliation compares applied rows with Shopify."]
        ]]
      ]
    },
    "email-merchandising.html": { existing: true }
  };

  const filename = location.pathname.split("/").filter(Boolean).pop() || "index.html";
  const config = keys[filename];
  if (!config || config.existing) return;

  function make(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function buildDialog() {
    const dialog = make("dialog", "page-key-dialog");
    dialog.setAttribute("aria-labelledby", "page-key-title");
    const head = make("div", "page-key-head");
    const heading = make("div");
    const title = make("h2", "", config.title);
    title.id = "page-key-title";
    heading.append(title, make("p", "", config.intro));
    const close = make("button", "page-key-close", "×");
    close.type = "button";
    close.setAttribute("aria-label", "Close key");
    head.append(heading, close);
    const body = make("div", "page-key-body");
    const grid = make("div", "page-key-grid");
    config.sections.forEach(([sectionTitle, items]) => {
      const section = make("section", "page-key-section");
      section.append(make("h3", "", sectionTitle));
      const list = make("ul", "page-key-list");
      items.forEach(([term, description, formula]) => {
        const item = make("li");
        item.append(make("strong", "", `${term}: `), document.createTextNode(description));
        if (formula) item.append(make("code", "page-key-formula", formula));
        list.append(item);
      });
      section.append(list);
      grid.append(section);
    });
    body.append(grid);
    dialog.append(head, body);
    close.addEventListener("click", () => dialog.close());
    dialog.addEventListener("click", event => { if (event.target === dialog) dialog.close(); });
    return dialog;
  }

  const button = make("button", "btn page-key-launch", "Key");
  button.type = "button";
  button.setAttribute("aria-haspopup", "dialog");
  const head = document.querySelector(".head");
  let actions = document.querySelector("[data-page-key-actions]") || document.querySelector(".head .actions") || document.querySelector(".header-actions") || document.querySelector(".login .actions");
  if (!actions && head) {
    actions = make("div", "actions");
    const status = head.querySelector(".status-pill");
    if (status) actions.append(status);
    head.append(actions);
  }
  if (actions) actions.insertBefore(button, actions.firstChild);
  else {
    const home = document.querySelector(".home-link, .home");
    if (home) home.insertAdjacentElement("afterend", button);
    else document.body.insertAdjacentElement("afterbegin", button);
  }
  const dialog = buildDialog();
  document.body.append(dialog);
  button.addEventListener("click", () => dialog.showModal());
})();
