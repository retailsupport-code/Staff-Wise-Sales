/* =========================================================================
   Maybell Staff Performance Dashboard
   -------------------------------------------------------------------------
   Data sources (all published Google Sheets, fetched live on load / refresh):

     SALE_URL / SALE_LY_URL        Raw bill-line sale data (this FY / last FY).
                                    One row per item sold. Aggregated client-side
                                    into per (Store, Staff, Month) records.
     STORE_TARGET_URL / _LY        Store-wise monthly Gross Target. Drives the
                                    KPI row's "Gross Target" card.
     STAFF_TARGET_URL              Staff-wise monthly Gross Target. Drives the
                                    matrix's Target column and the weekly
                                    achievement split (prorated across the
                                    calendar weeks of the month).
     CATEGORY_TARGET_URL           Category x Store target (optional — if this
                                    sheet is empty or its columns can't be
                                    detected, the category chart simply drops
                                    its target bar and shows Qty only).

   Definitions (as specified):
     Sale value  = Bill Amount        (summed)
     Qty sold    = Net Qty            (summed)
     NOB         = Bill Code          (distinct count, within Store+Staff+Month)
     ATV         = Sale value / NOB
     BS          = Qty / NOB

   IMPORTANT — nothing here needs a monthly code edit anymore: months are
   discovered from the data itself (Sale + Staff Target rows), not hardcoded.
   ========================================================================= */

const SALE_URL =
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vQOgpraKVB0D1Ey0zuWSZQJ0JH23P2c9gEnWtlTPHYHHpi5m6iyyTZg3UaucUSG3ikv7-vXiqsm4WnW/pub?gid=1054702314&single=true&output=csv";
const SALE_LY_URL =
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vQOgpraKVB0D1Ey0zuWSZQJ0JH23P2c9gEnWtlTPHYHHpi5m6iyyTZg3UaucUSG3ikv7-vXiqsm4WnW/pub?gid=234205256&single=true&output=csv";
const STORE_TARGET_URL =
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vQOgpraKVB0D1Ey0zuWSZQJ0JH23P2c9gEnWtlTPHYHHpi5m6iyyTZg3UaucUSG3ikv7-vXiqsm4WnW/pub?gid=311460288&single=true&output=csv";
const STAFF_TARGET_URL =
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vQOgpraKVB0D1Ey0zuWSZQJ0JH23P2c9gEnWtlTPHYHHpi5m6iyyTZg3UaucUSG3ikv7-vXiqsm4WnW/pub?gid=187181872&single=true&output=csv";
const STORE_TARGET_LY_URL =
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vQOgpraKVB0D1Ey0zuWSZQJ0JH23P2c9gEnWtlTPHYHHpi5m6iyyTZg3UaucUSG3ikv7-vXiqsm4WnW/pub?gid=108189863&single=true&output=csv";
const CATEGORY_TARGET_URL =
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vQOgpraKVB0D1Ey0zuWSZQJ0JH23P2c9gEnWtlTPHYHHpi5m6iyyTZg3UaucUSG3ikv7-vXiqsm4WnW/pub?gid=553992983&single=true&output=csv";

const REFRESH_MS = 5 * 60 * 1000;

// Financial year runs Apr -> Mar.
const FY_MONTHS = ["Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec", "Jan", "Feb", "Mar"];
const MONTH_NUM = { Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12, Jan: 1, Feb: 2, Mar: 3 };
const DAYS_IN_MONTH = { Apr: 30, May: 31, Jun: 30, Jul: 31, Aug: 31, Sep: 30, Oct: 31, Nov: 30, Dec: 31, Jan: 31, Feb: 28, Mar: 31 };
const QUARTERS = [
  { key: "Q1", label: "Q1 (Apr\u2013Jun)", months: ["Apr", "May", "Jun"] },
  { key: "Q2", label: "Q2 (Jul\u2013Sep)", months: ["Jul", "Aug", "Sep"] },
  { key: "Q3", label: "Q3 (Oct\u2013Dec)", months: ["Oct", "Nov", "Dec"] },
  { key: "Q4", label: "Q4 (Jan\u2013Mar)", months: ["Jan", "Feb", "Mar"] },
];

let state = {
  records: [],          // this-FY, aggregated from SALE_URL, one row per Store+Staff+Month
  archiveRecords: [],    // last-FY, aggregated from SALE_LY_URL, same shape
  storeTargets: {},      // "STORE||Month" -> gross target (this FY)
  storeTargetsLY: {},    // "STORE||Month" -> gross target (last FY)
  categoryTargets: {},   // "STORE||CATEGORY||Month" -> target qty (optional)
  hasCategoryTargets: false,
  availableMonths: [],   // months with data, in FY order
  loadSeq: 0,
  lastUpdated: null,
  failedSources: [],
  quarter: "Q1",
  month: "Apr",
  store: "All Stores",
  sortKey: "totalSales",
  sortDir: "desc",
  search: "",
};

let weeklyChart = null;
let categoryChart = null;
let staffCategoryChart = null;

/* ---------------------------- helpers ---------------------------- */

function num(v) {
  if (v === null || v === undefined || v === "") return 0;
  const s = String(v).replace(/,/g, "").replace(/%/g, "").replace(/^\u20b9/, "").trim();
  if (s === "" || s.startsWith("#")) return 0;
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

function fmtINR(v) {
  return new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(Math.round(num(v)));
}
function fmtNum(v) {
  return new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(Math.round(num(v)));
}
function fmtPct(v) {
  return `${num(v).toFixed(1)}%`;
}
function titleCase(s) {
  return (s || "").trim().toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}
function normKey(s) {
  return (s || "").trim().toUpperCase();
}

function achievementOf(sales, target) {
  return target > 0 ? (sales / target) * 100 : (sales > 0 ? 100 : 0);
}

// Days making up week i (0-indexed, 5 buckets of 7 days; week 5 is whatever remains).
function weekDayRange(monthAbbrev, i) {
  const days = DAYS_IN_MONTH[monthAbbrev] || 30;
  const start = i * 7 + 1;
  const end = Math.min(start + 6, days);
  return end >= start ? end - start + 1 : 0;
}

// The date column's day/month order (D/M vs M/D) isn't guaranteed by the CSV
// export, so cross-check against the sheet's own Month column (ground truth)
// to disambiguate, rather than assuming a locale.
function extractDay(dateStr, monthAbbrev) {
  if (!dateStr) return 1;
  const s = String(dateStr).trim();
  const iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) return num(iso[3]) || 1;
  const mon3 = s.match(/^(\d{1,2})[-\s]([A-Za-z]{3})/);
  if (mon3) return num(mon3[1]) || 1;
  const slash = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
  if (slash) {
    const a = num(slash[1]), b = num(slash[2]);
    const mn = MONTH_NUM[monthAbbrev];
    if (a === mn && b !== mn) return b;
    if (b === mn && a !== mn) return a;
    return Math.min(a, b) || 1; // ambiguous — best-effort fallback
  }
  return 1;
}

/* ---------------------------- CSV fetch ---------------------------- */

async function fetchCsv(url) {
  const res = await fetch(url + (url.includes("?") ? "&" : "?") + "_=" + Date.now(), { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  if (!text.trim()) throw new Error("No data returned.");
  return text;
}

function parseRows(csvText) {
  const parsed = Papa.parse(csvText.trim(), { header: true, skipEmptyLines: true });
  return parsed.data;
}

/* ---------------------------- raw sale -> aggregated records ---------------------------- */

function buildSaleRecords(csvText, staffTargetMap) {
  const rows = parseRows(csvText);
  const map = new Map();

  for (const row of rows) {
    const store = (row["Location"] || "").trim();
    const staffRaw = (row["Salesman"] || "").trim();
    const month = (row["Month"] || "").trim();
    if (!store || !staffRaw || !FY_MONTHS.includes(month)) continue;

    const staffKey = normKey(staffRaw);
    const storeKey = normKey(store);
    const k = `${storeKey}||${staffKey}||${month}`;

    if (!map.has(k)) {
      map.set(k, {
        store, storeKey,
        staff: titleCase(staffRaw), staffKey,
        month,
        totalSales: 0, qty: 0,
        bills: new Set(),
        weeks: [0, 0, 0, 0, 0], // achieved ₹ per week bucket
        categories: {},         // category -> qty
        categorySales: {},      // category -> ₹
      });
    }
    const rec = map.get(k);

    const amt = num(row["Bill Amount"]);
    const qty = num(row["Net Qty"]);
    const billCode = (row["Bill Code"] || "").trim();
    const category = (row["Category"] || "Uncategorised").trim() || "Uncategorised";

    rec.totalSales += amt;
    rec.qty += qty;
    if (billCode) rec.bills.add(billCode);
    rec.categories[category] = (rec.categories[category] || 0) + qty;
    rec.categorySales[category] = (rec.categorySales[category] || 0) + amt;

    const day = extractDay(row["Bill Date"], month);
    const wi = Math.min(4, Math.floor((day - 1) / 7));
    rec.weeks[wi] += amt;
  }

  const out = [];
  for (const rec of map.values()) {
    const nob = rec.bills.size;
    const staffTarget = staffTargetMap[`${rec.storeKey}||${rec.staffKey}||${rec.month}`] || 0;
    const daysInMonth = DAYS_IN_MONTH[rec.month] || 30;

    const weeks = rec.weeks.map((achieved, i) => {
      const days = weekDayRange(rec.month, i);
      const target = staffTarget > 0 ? staffTarget * (days / daysInMonth) : 0;
      return { t: target, a: achieved };
    });
    while (weeks.length > 1) {
      const last = weeks[weeks.length - 1];
      if (last.t === 0 && last.a === 0) weeks.pop(); else break;
    }

    out.push({
      store: rec.store, staff: rec.staff, month: rec.month,
      grossTarget: staffTarget,
      totalSales: rec.totalSales,
      qty: rec.qty,
      nob,
      atv: nob > 0 ? rec.totalSales / nob : 0,
      bs: nob > 0 ? rec.qty / nob : 0,
      weeks,
      categories: rec.categories,
      categorySales: rec.categorySales,
    });
  }
  return out;
}

function buildStoreTargetMap(csvText, storeCol, targetCol, monthCol) {
  const rows = parseRows(csvText);
  if (!rows.length) return {};
  const header = Object.keys(rows[0]);
  const sc = header.find((h) => new RegExp(storeCol, "i").test(h)) || header[0];
  const tc = header.find((h) => new RegExp(targetCol, "i").test(h)) || header[1];
  const mc = header.find((h) => new RegExp(monthCol, "i").test(h)) || header[2];

  const map = {};
  for (const row of rows) {
    const store = (row[sc] || "").trim();
    if (!store) continue;
    const month = monthAbbrevFromCell(row[mc]);
    if (!month) continue;
    const key = `${normKey(store)}||${month}`;
    map[key] = (map[key] || 0) + num(row[tc]);
  }
  return map;
}

function buildStaffTargetMap(csvText) {
  const rows = parseRows(csvText);
  const map = {};
  for (const row of rows) {
    const store = (row["Store Names"] || row["Store Name"] || "").trim();
    const staff = (row["Staff Name"] || "").trim();
    if (!store || !staff) continue;
    const month = monthAbbrevFromCell(row["Month"]);
    if (!month) continue;
    const key = `${normKey(store)}||${normKey(staff)}||${month}`;
    map[key] = (map[key] || 0) + num(row["Gross Target"]);
  }
  return map;
}

// Target sheets' "Month" cell exports as a date; only its month number is
// trustworthy (the day/year vary by sheet export quirks), so pull the month
// name from that and ignore the rest.
// The sheet's "Month" cell is a date whose day component is actually the FY
// year suffix (e.g. 26 for FY26), not a real day-of-month — so it's always
// >12, while the true month is always 1-12. Use that to pick the right field
// regardless of whether the CSV export order is M/D/Y or D/M/Y.
function monthAbbrevFromCell(cell) {
  if (!cell) return null;
  const s = String(cell).trim();
  const iso = s.match(/^\d{4}-(\d{1,2})-(\d{1,2})/);
  if (iso) return numToAbbrev(num(iso[1]));
  const slash = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
  if (slash) {
    const a = num(slash[1]), b = num(slash[2]);
    const mn = (a >= 1 && a <= 12) ? a : (b >= 1 && b <= 12 ? b : null);
    return mn ? numToAbbrev(mn) : null;
  }
  const named = FY_MONTHS.find((m) => new RegExp(m, "i").test(s));
  if (named) return named;
  return null;
}
function numToAbbrev(n) {
  return Object.keys(MONTH_NUM).find((k) => MONTH_NUM[k] === n) || null;
}

function buildCategoryTargetMap(csvText) {
  try {
    const rows = parseRows(csvText);
    if (!rows.length) return { map: {}, ok: false };
    const header = Object.keys(rows[0]);
    const sc = header.find((h) => /store/i.test(h));
    const cc = header.find((h) => /categ/i.test(h));
    const tc = header.find((h) => /target/i.test(h));
    const mc = header.find((h) => /month/i.test(h));
    if (!sc || !cc || !tc) return { map: {}, ok: false };

    const map = {};
    for (const row of rows) {
      const store = (row[sc] || "").trim();
      const category = (row[cc] || "").trim();
      if (!store || !category) continue;
      const month = mc ? monthAbbrevFromCell(row[mc]) : null;
      const key = month ? `${normKey(store)}||${category}||${month}` : `${normKey(store)}||${category}||*`;
      map[key] = (map[key] || 0) + num(row[tc]);
    }
    return { map, ok: Object.keys(map).length > 0 };
  } catch (e) {
    return { map: {}, ok: false };
  }
}

/* ---------------------------- data loading ---------------------------- */

async function loadAll() {
  const seq = ++state.loadSeq;
  const btn = document.getElementById("refreshBtn");
  btn.disabled = true;
  setPulse("loading", "Connecting\u2026");

  const results = await Promise.allSettled([
    fetchCsv(STAFF_TARGET_URL),
    fetchCsv(SALE_URL),
    fetchCsv(SALE_LY_URL),
    fetchCsv(STORE_TARGET_URL),
    fetchCsv(STORE_TARGET_LY_URL),
    fetchCsv(CATEGORY_TARGET_URL),
  ]);
  const [staffTargetR, saleR, saleLyR, storeTargetR, storeTargetLyR, categoryTargetR] = results;

  if (seq !== state.loadSeq) return;

  const failed = [];
  const staffTargetMap = staffTargetR.status === "fulfilled" ? buildStaffTargetMap(staffTargetR.value) : (failed.push("Salesman Target"), {});
  if (saleR.status === "fulfilled") {
    state.records = buildSaleRecords(saleR.value, staffTargetMap);
  } else failed.push("2026 Sale");

  if (saleLyR.status === "fulfilled") {
    state.archiveRecords = buildSaleRecords(saleLyR.value, {});
  } else failed.push("2025 Sale");

  state.storeTargets = storeTargetR.status === "fulfilled"
    ? buildStoreTargetMap(storeTargetR.value, "store", "target", "month")
    : (failed.push("2026 Target"), {});
  state.storeTargetsLY = storeTargetLyR.status === "fulfilled"
    ? buildStoreTargetMap(storeTargetLyR.value, "store", "target", "month")
    : (failed.push("2025 Target"), {});

  if (categoryTargetR.status === "fulfilled") {
    const ct = buildCategoryTargetMap(categoryTargetR.value);
    state.categoryTargets = ct.map;
    state.hasCategoryTargets = ct.ok;
  } else {
    state.categoryTargets = {};
    state.hasCategoryTargets = false;
  }

  state.availableMonths = FY_MONTHS.filter((m) =>
    state.records.some((r) => r.month === m)
  );
  if (!state.availableMonths.length) state.availableMonths = ["Apr"];
  if (!state.availableMonths.includes(state.month)) {
    state.month = state.availableMonths[state.availableMonths.length - 1];
  }
  state.quarter = QUARTERS.find((q) => q.months.includes(state.month))?.key || "Q1";

  state.failedSources = failed;
  state.lastUpdated = new Date();

  if (failed.length === 0) {
    setPulse("live", `Live \u00b7 updated ${state.lastUpdated.toLocaleTimeString()}`);
  } else if (state.records.length) {
    setPulse("partial", `${failed.length} source(s) failed \u00b7 ${state.lastUpdated.toLocaleTimeString()}`);
  } else {
    setPulse("error", "Couldn't load data \u2014 try Refresh");
  }

  if (seq === state.loadSeq) btn.disabled = false;
  buildQuarterOptions();
  buildMonthOptions();
  buildStoreOptions();
  render();
}

function setPulse(kind, text) {
  const el = document.getElementById("pulse");
  el.className = `pulse pulse-${kind}`;
  el.querySelector(".pulse-text").textContent = text;
}

/* ---------------------------- filters / options ---------------------------- */

function buildQuarterOptions() {
  const sel = document.getElementById("quarterSelect");
  sel.innerHTML = QUARTERS.map((q) =>
    `<option value="${q.key}" ${q.key === state.quarter ? "selected" : ""}>${q.label}</option>`
  ).join("");
}

function buildMonthOptions() {
  const sel = document.getElementById("monthSelect");
  const q = QUARTERS.find((qq) => qq.key === state.quarter) || QUARTERS[0];
  const months = q.months.filter((m) => state.availableMonths.includes(m));
  const options = months.length ? months : q.months;
  if (!options.includes(state.month)) state.month = options[options.length - 1];
  sel.innerHTML = options.map((m) => {
    const hasData = state.availableMonths.includes(m);
    return `<option value="${m}" ${m === state.month ? "selected" : ""}>${m}${hasData ? "" : " (no data)"}</option>`;
  }).join("");
}

function buildStoreOptions() {
  const sel = document.getElementById("storeSelect");
  const scoped = state.records.filter((r) => r.month === state.month);
  const stores = Array.from(new Set(scoped.map((r) => r.store).filter(Boolean))).sort();
  const options = ["All Stores", ...stores];
  if (!options.includes(state.store)) state.store = "All Stores";
  sel.innerHTML = options.map((s) =>
    `<option value="${s}" ${s === state.store ? "selected" : ""}>${s}</option>`
  ).join("");
}

function filteredRecords() {
  let recs = state.records.filter((r) => r.month === state.month);
  if (state.store !== "All Stores") recs = recs.filter((r) => r.store === state.store);
  return recs;
}

function lastYearRecords() {
  let recs = state.archiveRecords.filter((r) => r.month === state.month);
  if (state.store !== "All Stores") recs = recs.filter((r) => r.store === state.store);
  return recs;
}

function searchedRecords(recs) {
  if (!state.search.trim()) return recs;
  const q = state.search.trim().toLowerCase();
  return recs.filter((r) => r.staff.toLowerCase().includes(q) || r.store.toLowerCase().includes(q));
}

function storeTargetFor(scope, month) {
  if (state.store !== "All Stores") {
    return scope[`${normKey(state.store)}||${month}`] || 0;
  }
  let sum = 0;
  Object.entries(scope).forEach(([k, v]) => { if (k.endsWith(`||${month}`)) sum += v; });
  return sum;
}

/* ---------------------------- KPI ---------------------------- */

function calcKPIs(recs, storeTargetScope, month) {
  const grossTarget = storeTargetFor(storeTargetScope, month);
  const totalSales = recs.reduce((s, r) => s + r.totalSales, 0);
  const qty = recs.reduce((s, r) => s + r.qty, 0);
  const nob = recs.reduce((s, r) => s + r.nob, 0);
  const achievement = achievementOf(totalSales, grossTarget);
  const atv = nob > 0 ? totalSales / nob : 0;
  const bs = nob > 0 ? qty / nob : 0;
  return { grossTarget, totalSales, achievement, qty, nob, atv, bs, staffCount: recs.length };
}

function deltaBadge(curr, prev, isPoints) {
  if (prev === undefined || prev === null) return null;
  if (isPoints) {
    if (curr === 0 && prev === 0) return null;
    const diff = curr - prev;
    return { text: `${diff >= 0 ? "+" : ""}${diff.toFixed(1)} pts YoY`, good: diff >= 0 };
  }
  if (!prev) return null;
  const pct = ((curr - prev) / prev) * 100;
  return { text: `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}% YoY`, good: pct >= 0 };
}

function renderKPIs(kpis, lyKpis) {
  const hasLY = lyKpis && lyKpis.staffCount > 0;
  const cards = [
    { label: "Gross Target", value: `\u20b9${fmtINR(kpis.grossTarget)}`, sub: "Store-wise target",
      lyValue: hasLY ? `LY \u20b9${fmtINR(lyKpis.grossTarget)}` : null,
      delta: hasLY ? deltaBadge(kpis.grossTarget, lyKpis.grossTarget) : null },
    { label: "Total Sales", value: `\u20b9${fmtINR(kpis.totalSales)}`, sub: "Achieved so far",
      lyValue: hasLY ? `LY \u20b9${fmtINR(lyKpis.totalSales)}` : null,
      delta: hasLY ? deltaBadge(kpis.totalSales, lyKpis.totalSales) : null },
    { label: "Achievement", value: fmtPct(kpis.achievement),
      sub: kpis.achievement >= 100 ? "Target achieved" : "Target pending",
      subClass: kpis.achievement >= 100 ? "good" : (kpis.achievement < 70 ? "bad" : ""),
      lyValue: hasLY ? `LY ${fmtPct(lyKpis.achievement)}` : null,
      delta: hasLY ? deltaBadge(kpis.achievement, lyKpis.achievement, true) : null },
    { label: "Qty", value: fmtNum(kpis.qty), sub: "Units sold",
      lyValue: hasLY ? `LY ${fmtNum(lyKpis.qty)}` : null,
      delta: hasLY ? deltaBadge(kpis.qty, lyKpis.qty) : null },
    { label: "NOB", value: fmtNum(kpis.nob), sub: "Number of bills",
      lyValue: hasLY ? `LY ${fmtNum(lyKpis.nob)}` : null,
      delta: hasLY ? deltaBadge(kpis.nob, lyKpis.nob) : null },
    { label: "ATV", value: `\u20b9${fmtINR(kpis.atv)}`, sub: "Avg. transaction value",
      lyValue: hasLY ? `LY \u20b9${fmtINR(lyKpis.atv)}` : null,
      delta: hasLY ? deltaBadge(kpis.atv, lyKpis.atv) : null },
    { label: "Basket Size", value: kpis.bs.toFixed(2), sub: "Qty / NOB",
      lyValue: hasLY ? `LY ${lyKpis.bs.toFixed(2)}` : null,
      delta: hasLY ? deltaBadge(kpis.bs, lyKpis.bs) : null },
  ];
  document.getElementById("kpiRow").innerHTML = cards.map((c) => `
    <div class="kpi-card accent">
      <div class="kpi-label">${c.label}</div>
      <div class="kpi-value">${c.value}</div>
      <div class="kpi-sub ${c.subClass || ""}">${c.sub}</div>
      ${c.lyValue ? `
        <div class="kpi-ly">
          <span class="kpi-ly-value">${c.lyValue}</span>
          ${c.delta ? `<span class="kpi-ly-delta ${c.delta.good ? "good" : "bad"}">${c.delta.text}</span>` : ""}
        </div>` : `<div class="kpi-ly kpi-ly-empty">No LY data</div>`}
    </div>
  `).join("");
}

/* ---------------------------- charts ---------------------------- */

function calcWeekly(recs) {
  const weeks = [0, 1, 2, 3, 4].map((i) => {
    const target = recs.reduce((s, r) => s + (r.weeks[i] ? r.weeks[i].t : 0), 0);
    const achieved = recs.reduce((s, r) => s + (r.weeks[i] ? r.weeks[i].a : 0), 0);
    return { name: `WK ${i + 1}`, target, achieved };
  });
  while (weeks.length > 1) {
    const last = weeks[weeks.length - 1];
    if (last.target === 0 && last.achieved === 0) weeks.pop(); else break;
  }
  return weeks;
}

function calcCategories(recs) {
  const qtyTotals = {};
  const targetTotals = {};
  let anyTarget = false;
  recs.forEach((r) => {
    Object.entries(r.categories || {}).forEach(([k, v]) => {
      qtyTotals[k] = (qtyTotals[k] || 0) + v;
    });
  });
  if (state.hasCategoryTargets) {
    const stores = state.store !== "All Stores" ? [state.store] : Array.from(new Set(recs.map((r) => r.store)));
    Object.keys(qtyTotals).forEach((cat) => {
      let t = 0;
      stores.forEach((store) => {
        const exact = state.categoryTargets[`${normKey(store)}||${cat}||${state.month}`];
        const any = state.categoryTargets[`${normKey(store)}||${cat}||*`];
        t += exact || any || 0;
      });
      if (t > 0) anyTarget = true;
      targetTotals[cat] = t;
    });
  }
  const list = Object.entries(qtyTotals)
    .map(([category, qty]) => ({ category, qty, target: targetTotals[category] || 0 }))
    .sort((a, b) => b.qty - a.qty)
    .slice(0, 13);
  return { list, anyTarget: state.hasCategoryTargets && anyTarget };
}

const PLUM = "#5B2140";
const GOLD = "#B8862E";
const MUTED_GRID = "#E8DFD4";
const PALETTE = ["#5B2140", "#B8862E", "#2E6B4F", "#9B6B12", "#A23B34", "#3D1630", "#8A7A73", "#7A9E8E"];

function renderWeeklyChart(weekly) {
  const ctx = document.getElementById("weeklyChart");
  const data = {
    labels: weekly.map((w) => w.name),
    datasets: [
      { type: "bar", label: "Target", data: weekly.map((w) => w.target), backgroundColor: MUTED_GRID, borderRadius: 4, order: 2 },
      { type: "line", label: "Achieved", data: weekly.map((w) => w.achieved), borderColor: PLUM, backgroundColor: PLUM,
        borderWidth: 2.5, pointRadius: 4, pointHoverRadius: 6, pointBackgroundColor: PLUM, tension: 0.35, fill: false, order: 1 },
    ],
  };
  if (weeklyChart) { weeklyChart.data = data; weeklyChart.update(); return; }
  weeklyChart = new Chart(ctx, {
    type: "bar",
    data,
    options: {
      responsive: true,
      plugins: {
        legend: { position: "bottom", labels: { font: { family: "Inter" }, usePointStyle: true } },
        tooltip: { callbacks: { label: (c) => `${c.dataset.label}: \u20b9${fmtINR(c.raw)}` } },
      },
      scales: {
        y: { ticks: { callback: (v) => "\u20b9" + fmtINR(v) }, grid: { color: MUTED_GRID } },
        x: { grid: { display: false } },
      },
    },
  });
}

function renderCategoryChart(catResult) {
  const top = catResult.list.filter((c) => c.qty > 0);
  const ctx = document.getElementById("categoryChart");
  const datasets = [{ type: "bar", label: "Qty", data: top.map((c) => c.qty), backgroundColor: GOLD, borderRadius: 4, order: 2 }];
  if (catResult.anyTarget) {
    datasets.push({
      type: "line", label: "Target", data: top.map((c) => c.target),
      borderColor: PLUM, backgroundColor: PLUM, borderWidth: 2, pointRadius: 3, tension: 0.3, fill: false, order: 1,
    });
  }
  const data = { labels: top.map((c) => c.category), datasets };
  if (categoryChart) { categoryChart.data = data; categoryChart.update(); return; }
  categoryChart = new Chart(ctx, {
    type: "bar",
    data,
    options: {
      indexAxis: "y",
      responsive: true,
      plugins: { legend: { display: catResult.anyTarget, position: "bottom" } },
      scales: {
        x: { grid: { color: MUTED_GRID } },
        y: { grid: { display: false } },
      },
    },
  });
}

// Top categories by sales value across the given records, "Other" bucket for the rest.
function renderStaffCategoryChart(recs) {
  const container = document.getElementById("staffCategoryChartWrap");
  const totals = {};
  recs.forEach((r) => Object.entries(r.categorySales || {}).forEach(([k, v]) => { totals[k] = (totals[k] || 0) + v; }));
  const topCats = Object.entries(totals).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k]) => k);

  const staffSorted = [...recs].sort((a, b) => b.totalSales - a.totalSales);
  const rowHeight = 26;
  const height = Math.max(220, staffSorted.length * rowHeight + 40);
  container.style.height = `${height}px`;

  const ctx = document.getElementById("staffCategoryChart");
  const datasets = topCats.map((cat, i) => ({
    label: cat,
    data: staffSorted.map((r) => (r.categorySales && r.categorySales[cat]) || 0),
    backgroundColor: PALETTE[i % PALETTE.length],
    stack: "s",
  }));
  datasets.push({
    label: "Other",
    data: staffSorted.map((r) => {
      const known = topCats.reduce((s, c) => s + ((r.categorySales && r.categorySales[c]) || 0), 0);
      return Math.max(0, r.totalSales - known);
    }),
    backgroundColor: "#D8CFC2",
    stack: "s",
  });

  const data = { labels: staffSorted.map((r) => `${r.staff} \u2022 ${r.store}`), datasets };
  if (staffCategoryChart) { staffCategoryChart.data = data; staffCategoryChart.resize(); staffCategoryChart.update(); return; }
  staffCategoryChart = new Chart(ctx, {
    type: "bar",
    data,
    options: {
      indexAxis: "y",
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { position: "bottom", labels: { boxWidth: 10, font: { size: 10, family: "Inter" } } },
        tooltip: { callbacks: { label: (c) => `${c.dataset.label}: \u20b9${fmtINR(c.raw)}` } },
      },
      scales: {
        x: { stacked: true, grid: { color: MUTED_GRID }, ticks: { callback: (v) => "\u20b9" + fmtINR(v) } },
        y: { stacked: true, grid: { display: false }, ticks: { font: { size: 10.5 } } },
      },
    },
  });
}

/* ---------------------------- matrix ---------------------------- */

function badgeClass(ach) {
  if (ach >= 100) return "good";
  if (ach >= 80) return "warn";
  return "bad";
}

function renderMatrix(recs) {
  const withAch = recs.map((r) => ({ ...r, achievement: achievementOf(r.totalSales, r.grossTarget) }));
  const sorted = withAch.sort((a, b) => {
    const dir = state.sortDir === "asc" ? 1 : -1;
    const av = a[state.sortKey], bv = b[state.sortKey];
    if (typeof av === "string") return dir * av.localeCompare(bv);
    return dir * ((av || 0) - (bv || 0));
  });

  document.getElementById("matrixBody").innerHTML = sorted.map((r) => `
    <tr>
      <td class="store-name">${r.store}</td>
      <td class="staff-name">${r.staff}</td>
      <td class="num">\u20b9${fmtINR(r.grossTarget)}</td>
      <td class="num">\u20b9${fmtINR(r.totalSales)}</td>
      <td class="num"><span class="pill ${badgeClass(r.achievement)}">${fmtPct(r.achievement)}</span></td>
      <td class="num">${fmtNum(r.qty)}</td>
      <td class="num">${fmtNum(r.nob)}</td>
      <td class="num">\u20b9${fmtINR(r.atv)}</td>
      <td class="num">${r.bs.toFixed(2)}</td>
      ${r.weeks.map((w) => `<td class="num">${w.t > 0 ? fmtPct((w.a / w.t) * 100) : "\u2014"}</td>`).join("")}
    </tr>
  `).join("");

  document.getElementById("matrixCount").textContent = `${sorted.length} staff record${sorted.length === 1 ? "" : "s"}`;
  return sorted;
}

/* ---------------------------- render orchestration ---------------------------- */

function render() {
  const scoped = filteredRecords();
  const kpis = calcKPIs(scoped, state.storeTargets, state.month);
  const lyRecs = lastYearRecords();
  const lyKpis = calcKPIs(lyRecs, state.storeTargetsLY, state.month);
  renderKPIs(kpis, lyKpis);
  renderWeeklyChart(calcWeekly(scoped));
  renderCategoryChart(calcCategories(scoped));

  const shown = searchedRecords(scoped);
  const sortedMatrix = renderMatrix(shown);
  renderStaffCategoryChart(sortedMatrix);

  document.getElementById("recordCount").textContent =
    `${scoped.length} staff \u00b7 ${new Set(scoped.map((r) => r.store)).size} stores`;
  document.getElementById("footerMonth").textContent = state.month;
  document.getElementById("footerUpdated").textContent = state.lastUpdated
    ? `\u00b7 last refreshed ${state.lastUpdated.toLocaleString()}`
    : "";
  if (state.failedSources.length) {
    document.getElementById("footerUpdated").textContent += ` \u00b7 failed: ${state.failedSources.join(", ")}`;
  }
}

/* ---------------------------- events ---------------------------- */

function wireEvents() {
  document.getElementById("quarterSelect").addEventListener("change", (e) => {
    state.quarter = e.target.value;
    buildMonthOptions();
    buildStoreOptions();
    render();
  });
  document.getElementById("monthSelect").addEventListener("change", (e) => {
    state.month = e.target.value;
    buildStoreOptions();
    render();
  });
  document.getElementById("storeSelect").addEventListener("change", (e) => {
    state.store = e.target.value;
    render();
  });
  document.getElementById("staffSearch").addEventListener("input", (e) => {
    state.search = e.target.value;
    render();
  });
  document.getElementById("refreshBtn").addEventListener("click", loadAll);

  document.querySelectorAll("#matrixTable th[data-key]").forEach((th) => {
    th.addEventListener("click", () => {
      const key = th.dataset.key;
      if (state.sortKey === key) {
        state.sortDir = state.sortDir === "asc" ? "desc" : "asc";
      } else {
        state.sortKey = key;
        state.sortDir = "desc";
      }
      render();
    });
  });
}

/* ---------------------------- boot ---------------------------- */

function boot() {
  buildQuarterOptions();
  wireEvents();
  loadAll();
  setInterval(loadAll, REFRESH_MS);
}

document.addEventListener("DOMContentLoaded", boot);
