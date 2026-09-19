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
     STORE_TYPE_URL                Store Name -> Store Type (COCO / FOFO /
                                    AP / Karnataka / Telangana, etc.). Drives
                                    the "Store Type" slicer.

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
const STORE_TYPE_URL =
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vQOgpraKVB0D1Ey0zuWSZQJ0JH23P2c9gEnWtlTPHYHHpi5m6iyyTZg3UaucUSG3ikv7-vXiqsm4WnW/pub?gid=1866992180&single=true&output=csv";

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
  storeTypeMap: {},      // normalized STORE -> Type (COCO/FOFO/AP/...)
  availableMonths: [],   // months with data, in FY order
  loadSeq: 0,
  lastUpdated: null,
  failedSources: [],
  quarter: "Q1",
  month: "ALL",          // "ALL" = whole quarter; else a specific FY_MONTHS abbrev
  store: "All Stores",
  storeType: "All Types",
  sortKey: "totalSales",
  sortDir: "desc",
  search: "",
};

let weeklyChart = null;
let categoryChart = null;

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

// Months belonging to the currently selected quarter.
function currentQuarterMonths() {
  return (QUARTERS.find((q) => q.key === state.quarter) || QUARTERS[0]).months;
}

// Months in scope right now: all 3 quarter months when "ALL" (whole quarter)
// is selected, otherwise just the single chosen month.
function activeMonths() {
  return state.month === "ALL" ? currentQuarterMonths() : [state.month];
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
        billDays: new Set(),    // distinct calendar days this staff billed on
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
    rec.billDays.add(day);
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
      manDays: rec.billDays.size,   // days this staff actually billed
      totalDays: daysInMonth,       // calendar days in that month
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

function buildStoreTypeMap(csvText) {
  const rows = parseRows(csvText);
  if (!rows.length) return {};
  const header = Object.keys(rows[0]);
  const sc = header.find((h) => /store/i.test(h)) || header[0];
  const tc = header.find((h) => /type/i.test(h)) || header[1];
  const map = {};
  for (const row of rows) {
    const store = (row[sc] || "").trim();
    const type = (row[tc] || "").trim();
    if (!store || !type) continue;
    map[normKey(store)] = type;
  }
  return map;
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
    fetchCsv(STORE_TYPE_URL),
  ]);
  const [staffTargetR, saleR, saleLyR, storeTargetR, storeTargetLyR, categoryTargetR, storeTypeR] = results;

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

  state.storeTypeMap = storeTypeR.status === "fulfilled"
    ? buildStoreTypeMap(storeTypeR.value)
    : (failed.push("Store Type"), {});

  state.availableMonths = FY_MONTHS.filter((m) =>
    state.records.some((r) => r.month === m)
  );
  if (!state.availableMonths.length) state.availableMonths = ["Apr"];

  // Pick the quarter that contains the most recent month with data (only on
  // first load / when the current quarter has none), then default to
  // showing that whole quarter rather than a single month.
  const latestMonthWithData = state.availableMonths[state.availableMonths.length - 1];
  if (!currentQuarterMonths().some((m) => state.availableMonths.includes(m))) {
    state.quarter = QUARTERS.find((q) => q.months.includes(latestMonthWithData))?.key || "Q1";
  }
  if (state.month !== "ALL" && !state.availableMonths.includes(state.month)) {
    state.month = "ALL";
  }

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
  buildStoreTypeOptions();
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
  const monthsWithData = q.months.filter((m) => state.availableMonths.includes(m));

  if (state.month !== "ALL" && !q.months.includes(state.month)) state.month = "ALL";

  const allLabel = monthsWithData.length
    ? `Consolidate (${monthsWithData.join(", ")})`
    : "Consolidate (no data)";

  const optionsHtml = [
    `<option value="ALL" ${state.month === "ALL" ? "selected" : ""}>${allLabel}</option>`,
    ...q.months.map((m) => {
      const hasData = state.availableMonths.includes(m);
      return `<option value="${m}" ${m === state.month ? "selected" : ""}>${m}${hasData ? "" : " (no data)"}</option>`;
    }),
  ];
  sel.innerHTML = optionsHtml.join("");
}

function buildStoreTypeOptions() {
  const sel = document.getElementById("storeTypeSelect");
  const types = Array.from(new Set(Object.values(state.storeTypeMap).filter(Boolean))).sort();
  const options = ["All Types", ...types];
  if (!options.includes(state.storeType)) state.storeType = "All Types";
  sel.innerHTML = options.map((t) =>
    `<option value="${t}" ${t === state.storeType ? "selected" : ""}>${t}</option>`
  ).join("");
}

function storeTypeMatches(store) {
  if (state.storeType === "All Types") return true;
  return state.storeTypeMap[normKey(store)] === state.storeType;
}

function buildStoreOptions() {
  const sel = document.getElementById("storeSelect");
  const months = activeMonths();
  let scoped = state.records.filter((r) => months.includes(r.month));
  if (state.storeType !== "All Types") scoped = scoped.filter((r) => storeTypeMatches(r.store));
  const stores = Array.from(new Set(scoped.map((r) => r.store).filter(Boolean))).sort();
  const options = ["All Stores", ...stores];
  if (!options.includes(state.store)) state.store = "All Stores";
  sel.innerHTML = options.map((s) =>
    `<option value="${s}" ${s === state.store ? "selected" : ""}>${s}</option>`
  ).join("");
}

function filteredRecords() {
  const months = activeMonths();
  let recs = state.records.filter((r) => months.includes(r.month));
  if (state.store !== "All Stores") recs = recs.filter((r) => r.store === state.store);
  if (state.storeType !== "All Types") recs = recs.filter((r) => storeTypeMatches(r.store));
  return recs;
}

function lastYearRecords() {
  const months = activeMonths();
  let recs = state.archiveRecords.filter((r) => months.includes(r.month));
  if (state.store !== "All Stores") recs = recs.filter((r) => r.store === state.store);
  if (state.storeType !== "All Types") recs = recs.filter((r) => storeTypeMatches(r.store));
  return recs;
}

function searchedRecords(recs) {
  if (!state.search.trim()) return recs;
  const q = state.search.trim().toLowerCase();
  return recs.filter((r) => r.staff.toLowerCase().includes(q) || r.store.toLowerCase().includes(q));
}

// Merge per-month staff rows (Store+Staff+Apr, Store+Staff+May, ...) into one
// row per Store+Staff when the "whole quarter" view is active.
function mergeByStaff(recs) {
  const map = new Map();
  recs.forEach((r) => {
    const key = `${normKey(r.store)}||${normKey(r.staff)}`;
    if (!map.has(key)) {
      map.set(key, {
        store: r.store, staff: r.staff,
        grossTarget: 0, totalSales: 0, qty: 0, nob: 0,
        manDays: 0, totalDays: 0,
        categories: {}, categorySales: {},
      });
    }
    const m = map.get(key);
    m.grossTarget += r.grossTarget;
    m.totalSales += r.totalSales;
    m.qty += r.qty;
    m.nob += r.nob;
    m.manDays += r.manDays || 0;
    m.totalDays += r.totalDays || 0;
    Object.entries(r.categories || {}).forEach(([k, v]) => { m.categories[k] = (m.categories[k] || 0) + v; });
    Object.entries(r.categorySales || {}).forEach(([k, v]) => { m.categorySales[k] = (m.categorySales[k] || 0) + v; });
  });
  return Array.from(map.values()).map((m) => ({
    ...m,
    atv: m.nob > 0 ? m.totalSales / m.nob : 0,
    bs: m.nob > 0 ? m.qty / m.nob : 0,
  }));
}

function storeTargetFor(scope, monthOrAll) {
  const months = monthOrAll === "ALL" ? currentQuarterMonths() : [monthOrAll];
  if (state.store !== "All Stores") {
    return months.reduce((sum, m) => sum + (scope[`${normKey(state.store)}||${m}`] || 0), 0);
  }
  let sum = 0;
  Object.entries(scope).forEach(([k, v]) => {
    const sep = k.lastIndexOf("||");
    const storeKeyPart = k.slice(0, sep);
    const m = k.slice(sep + 2);
    if (!months.includes(m)) return;
    if (state.storeType !== "All Types" && state.storeTypeMap[storeKeyPart] !== state.storeType) return;
    sum += v;
  });
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
    { label: "Gross Target", value: `\u20b9${fmtINR(kpis.grossTarget)}`,
      lyValue: hasLY ? `LY \u20b9${fmtINR(lyKpis.grossTarget)}` : null,
      delta: hasLY ? deltaBadge(kpis.grossTarget, lyKpis.grossTarget) : null },
    { label: "Total Sales", value: `\u20b9${fmtINR(kpis.totalSales)}`,
      lyValue: hasLY ? `LY \u20b9${fmtINR(lyKpis.totalSales)}` : null,
      delta: hasLY ? deltaBadge(kpis.totalSales, lyKpis.totalSales) : null },
    { label: "Achievement", value: fmtPct(kpis.achievement),
      lyValue: hasLY ? `LY ${fmtPct(lyKpis.achievement)}` : null,
      delta: hasLY ? deltaBadge(kpis.achievement, lyKpis.achievement, true) : null },
    { label: "Qty", value: fmtNum(kpis.qty),
      lyValue: hasLY ? `LY ${fmtNum(lyKpis.qty)}` : null,
      delta: hasLY ? deltaBadge(kpis.qty, lyKpis.qty) : null },
    { label: "NOB", value: fmtNum(kpis.nob),
      lyValue: hasLY ? `LY ${fmtNum(lyKpis.nob)}` : null,
      delta: hasLY ? deltaBadge(kpis.nob, lyKpis.nob) : null },
    { label: "ATV", value: `\u20b9${fmtINR(kpis.atv)}`,
      lyValue: hasLY ? `LY \u20b9${fmtINR(lyKpis.atv)}` : null,
      delta: hasLY ? deltaBadge(kpis.atv, lyKpis.atv) : null },
    { label: "Basket Size", value: kpis.bs.toFixed(2),
      lyValue: hasLY ? `LY ${lyKpis.bs.toFixed(2)}` : null,
      delta: hasLY ? deltaBadge(kpis.bs, lyKpis.bs) : null },
  ];
  document.getElementById("kpiRow").innerHTML = cards.map((c) => `
    <div class="kpi-card accent">
      <div class="kpi-label">${c.label}</div>
      <div class="kpi-value">${c.value}</div>
      ${c.lyValue ? `
        <div class="kpi-ly">
          <span class="kpi-ly-value">${c.lyValue}</span>
          ${c.delta ? `<span class="kpi-ly-delta ${c.delta.good ? "good" : "bad"}">${c.delta.text}</span>` : ""}
        </div>` : `<div class="kpi-ly kpi-ly-empty">No LY data</div>`}
    </div>
  `).join("");
}

/* ---------------------------- charts ---------------------------- */

function calcWeekly(recs, trim = true) {
  const weeks = [0, 1, 2, 3, 4].map((i) => {
    const target = recs.reduce((s, r) => s + (r.weeks[i] ? r.weeks[i].t : 0), 0);
    const achieved = recs.reduce((s, r) => s + (r.weeks[i] ? r.weeks[i].a : 0), 0);
    return { name: `WK ${i + 1}`, target, achieved };
  });
  if (trim) {
    while (weeks.length > 1) {
      const last = weeks[weeks.length - 1];
      if (last.target === 0 && last.achieved === 0) weeks.pop(); else break;
    }
  }
  return weeks;
}

// Used instead of calcWeekly when the "whole quarter" view is active: one
// bar per month of the quarter rather than per-week buckets (weeks from
// different months aren't comparable/summable).
function calcMonthlySplit(recs) {
  const months = currentQuarterMonths();
  return months.map((m) => {
    const rows = recs.filter((r) => r.month === m);
    return {
      name: m,
      target: rows.reduce((s, r) => s + r.grossTarget, 0),
      achieved: rows.reduce((s, r) => s + r.totalSales, 0),
    };
  });
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
    const months = activeMonths();
    Object.keys(qtyTotals).forEach((cat) => {
      let t = 0;
      stores.forEach((store) => {
        let usedMonthly = false;
        months.forEach((month) => {
          const exact = state.categoryTargets[`${normKey(store)}||${cat}||${month}`];
          if (exact) { t += exact; usedMonthly = true; }
        });
        if (!usedMonthly) {
          const any = state.categoryTargets[`${normKey(store)}||${cat}||*`];
          if (any) t += any;
        }
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

const PLUM = "#12395B";
const GOLD = "#ED9729";
const MUTED_GRID = "#E1E5EC";
const PALETTE = ["#12395B", "#ED9729", "#2E6B4F", "#9B6B12", "#A23B34", "#0B2740", "#6B7280", "#7A9E8E"];

function renderWeeklyChart(cySeries, lySeries) {
  const ctx = document.getElementById("weeklyChart");
  const achCY = cySeries.map((w) => achievementOf(w.achieved, w.target));
  const hasLY = lySeries && lySeries.length && lySeries.some((w) => w.target > 0 || w.achieved > 0);
  const achLY = hasLY ? lySeries.map((w) => achievementOf(w.achieved, w.target)) : [];
  const BAR_GREY = "#9AA5B1";

  const datasets = [
    {
      type: "bar", label: "Target", data: cySeries.map((w) => w.target),
      backgroundColor: BAR_GREY, borderRadius: 4, order: 3, yAxisID: "y",
      datalabels: {
        display: true, anchor: "end", align: "top", offset: 2,
        color: PLUM, font: { family: "Inter", weight: "700", size: 10 },
        formatter: (v) => (v > 0 ? "\u20b9" + fmtINR(v) : ""),
      },
    },
    {
      type: "line", label: "Ach % (This Year)", data: achCY, borderColor: GOLD, backgroundColor: GOLD,
      borderWidth: 2.5, pointRadius: 4, pointHoverRadius: 6, pointBackgroundColor: GOLD,
      tension: 0.35, fill: false, order: 1, yAxisID: "y1",
      rawValues: cySeries.map((w) => w.achieved),
      datalabels: { display: false },
    },
  ];
  if (hasLY) {
    datasets.push({
      type: "line", label: "Ach % (Last Year)", data: achLY, borderColor: PLUM, backgroundColor: PLUM,
      borderWidth: 2, borderDash: [5, 4], pointRadius: 3, pointHoverRadius: 5, pointBackgroundColor: PLUM,
      tension: 0.35, fill: false, order: 2, yAxisID: "y1",
      rawValues: lySeries.map((w) => w.achieved),
      datalabels: { display: false },
    });
  }

  const data = { labels: cySeries.map((w) => w.name), datasets };
  if (weeklyChart) { weeklyChart.data = data; weeklyChart.update(); return; }
  weeklyChart = new Chart(ctx, {
    type: "bar",
    data,
    plugins: [ChartDataLabels],
    options: {
      responsive: true,
      layout: { padding: { top: 18, bottom: 6 } },
      plugins: {
        legend: { position: "bottom", labels: { font: { family: "Inter" }, usePointStyle: true } },
        datalabels: { display: false },
        tooltip: {
          callbacks: {
            label: (c) => {
              if (c.dataset.yAxisID === "y1") {
                const raw = c.dataset.rawValues ? c.dataset.rawValues[c.dataIndex] : null;
                return raw != null
                  ? `${c.dataset.label}: \u20b9${fmtINR(raw)} (${c.raw.toFixed(1)}%)`
                  : `${c.dataset.label}: ${c.raw.toFixed(1)}%`;
              }
              return `${c.dataset.label}: \u20b9${fmtINR(c.raw)}`;
            },
          },
        },
      },
      scales: {
        y: { position: "left", ticks: { callback: (v) => "\u20b9" + fmtINR(v) }, grid: { color: MUTED_GRID } },
        y1: { position: "right", ticks: { callback: (v) => v + "%" }, grid: { drawOnChartArea: false } },
        x: { grid: { display: false } },
      },
    },
  });
}

const centerTextPlugin = {
  id: "centerText",
  afterDraw(chart) {
    const data = chart.data.datasets[0].data;
    const total = data.reduce((s, v) => s + v, 0);
    const { ctx, chartArea } = chart;
    const cx = (chartArea.left + chartArea.right) / 2;
    const cy = (chartArea.top + chartArea.bottom) / 2;
    ctx.save();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = "700 26px Fraunces, serif";
    ctx.fillStyle = PLUM;
    ctx.fillText(fmtNum(total), cx, cy - 12);
    ctx.font = "700 11px Inter, sans-serif";
    ctx.fillStyle = "#6B7280";
    ctx.fillText("TOTAL UNITS", cx, cy + 14);
    ctx.restore();
  },
};

function renderCategoryChart(catResult) {
  const top = catResult.list.filter((c) => c.qty > 0);
  const ctx = document.getElementById("categoryChart");
  const totalQty = top.reduce((s, c) => s + c.qty, 0);
  const data = {
    labels: top.map((c) => c.category),
    datasets: [{
      label: "Qty",
      data: top.map((c) => c.qty),
      backgroundColor: top.map((_, i) => PALETTE[i % PALETTE.length]),
      borderColor: "#FFFFFF",
      borderWidth: 2,
      hoverOffset: 6,
    }],
  };
  if (categoryChart) { categoryChart.data = data; categoryChart.update(); return; }
  categoryChart = new Chart(ctx, {
    type: "doughnut",
    data,
    plugins: [ChartDataLabels, centerTextPlugin],
    options: {
      responsive: true,
      cutout: "62%",
      plugins: {
        legend: { position: "bottom", labels: { font: { family: "Inter", size: 11 }, boxWidth: 10, usePointStyle: true } },
        tooltip: {
          callbacks: {
            label: (c) => {
              const pct = totalQty > 0 ? (c.raw / totalQty) * 100 : 0;
              return ` ${c.label}: ${fmtNum(c.raw)} units (${pct.toFixed(1)}%)`;
            },
          },
        },
        datalabels: {
          display: "auto",
          color: "#FFFFFF",
          font: { family: "Inter", weight: "700", size: 10 },
          formatter: (value) => {
            const pct = totalQty > 0 ? (value / totalQty) * 100 : 0;
            return pct > 0 ? pct.toFixed(1) + "%" : "";
          },
        },
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
      <td class="num">${r.manDays || 0}/${r.totalDays || 0}</td>
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

  const isQuarterView = state.month === "ALL";
  document.getElementById("weeklyChartTitle").textContent =
    isQuarterView ? "Month-wise target vs achieved" : "Week-wise target vs achieved";
  document.getElementById("weeklyChartNote").textContent =
    isQuarterView ? "\u20b9 across the quarter, month by month" : "\u20b9 across selected scope";

  let cySeries, lySeries;
  if (isQuarterView) {
    cySeries = calcMonthlySplit(scoped);
    lySeries = calcMonthlySplit(lyRecs);
  } else {
    cySeries = calcWeekly(scoped, false);
    lySeries = calcWeekly(lyRecs, false);
    // Trim trailing weeks only where BOTH years have no data, so the two
    // trend lines stay aligned week-for-week.
    while (cySeries.length > 1 && lySeries.length === cySeries.length) {
      const a = cySeries[cySeries.length - 1], b = lySeries[lySeries.length - 1];
      if (a.target === 0 && a.achieved === 0 && b.target === 0 && b.achieved === 0) {
        cySeries.pop(); lySeries.pop();
      } else break;
    }
  }
  renderWeeklyChart(cySeries, lySeries);

  renderCategoryChart(calcCategories(scoped));

  const shown = searchedRecords(scoped);
  const matrixRows = isQuarterView ? mergeByStaff(shown) : shown;
  renderMatrix(matrixRows);

  const uniqueStaff = new Set(scoped.map((r) => `${r.store}||${r.staff}`)).size;
  document.getElementById("recordCount").textContent =
    `${uniqueStaff} staff \u00b7 ${new Set(scoped.map((r) => r.store)).size} stores`;
  document.getElementById("footerMonth").textContent = isQuarterView
    ? (QUARTERS.find((q) => q.key === state.quarter)?.label || state.quarter)
    : state.month;
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
    state.month = "ALL"; // picking a quarter shows its total first; drill into a month after
    buildMonthOptions();
    buildStoreOptions();
    render();
  });
  document.getElementById("monthSelect").addEventListener("change", (e) => {
    state.month = e.target.value;
    buildStoreOptions();
    render();
  });
  document.getElementById("storeTypeSelect").addEventListener("change", (e) => {
    state.storeType = e.target.value;
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
