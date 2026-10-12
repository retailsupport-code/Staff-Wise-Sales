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
// Weekly Target bar split: fixed % of the month's total target per week
// bucket (WK1..WK5), rather than proportional to calendar day count.
const WEEK_TARGET_SPLIT = [0.22, 0.24, 0.26, 0.25, 0.03];

// Week buckets used for the weekly Ach / trend line: the LAST day of WK1..WK4.
// WK5 runs from (WK4 end + 1) to month end.
//   WK1 = 1-6, WK2 = 7-13, WK3 = 14-20, WK4 = 21-27, WK5 = 28-month end
// If a month needs different cut-offs, add an override here, e.g.
//   Oct: [5, 12, 19, 26]
const WEEK_END_DEFAULT = [6, 13, 20, 27];
const WEEK_END_BY_MONTH = {
  // Sep: [6, 13, 20, 27],
};
function weekIndexForDay(day, month) {
  const ends = WEEK_END_BY_MONTH[month] || WEEK_END_DEFAULT;
  for (let i = 0; i < ends.length; i++) if (day <= ends[i]) return i;
  return 4;
}
const QUARTERS = [
  { key: "Q1", label: "Q1 (Apr\u2013Jun)", months: ["Apr", "May", "Jun"] },
  { key: "Q2", label: "Q2 (Jul\u2013Sep)", months: ["Jul", "Aug", "Sep"] },
  { key: "Q3", label: "Q3 (Oct\u2013Dec)", months: ["Oct", "Nov", "Dec"] },
  { key: "Q4", label: "Q4 (Jan\u2013Mar)", months: ["Jan", "Feb", "Mar"] },
  { key: "FY", label: "Full Year (Apr\u2013Mar)", months: FY_MONTHS },
];

let state = {
  dayRecords: [],        // this-FY, one row per Store+Staff+Month+Day (raw rollup of SALE_URL)
  archiveDayRecords: [], // last-FY, same shape (SALE_LY_URL)
  staffTargetMap: {},    // "STORE||STAFF||Month" -> gross target
  dayFrom: 1,            // date-range slider: first day of month included
  dayTo: 31,             // date-range slider: last day of month included
  categoryUnit: "qty",   // "qty" or "value" - what the Category Target sheet measures
  categoryHeaders: [],   // headers seen in the Category Target sheet (for diagnostics)
  lyDiag: "",
  records: [],          // this-FY, rolled up from dayRecords within the day range: Store+Staff+Month
  archiveRecords: [],    // last-FY, same shape
  storeTargets: {},      // "STORE||Month" -> gross target (this FY)
  storeTargetsLY: {},    // "STORE||Month" -> gross target (last FY)
  categoryTargets: {},   // "STORE||CATEGORY||Month" -> target qty (optional)
  hasCategoryTargets: false,
  storeTypeMap: {},      // normalized STORE -> Type (COCO/FOFO/AP/...)
  availableMonths: [],   // months with data, in FY order
  loadSeq: 0,
  lastUpdated: null,
  failedSources: [],
  months: [],            // selected FY_MONTHS abbrevs (multi-select); [] until first load sets a default
  stores: [],            // selected store names (multi-select); [] = All Stores
  storeOptions: [],      // full list of valid store names for the current month/type scope
  storeType: "All Types",
  sortKey: "totalSales",
  sortDir: "desc",
  search: "",
};

let weeklyChart = null;

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

// Same store, different spelling between years ("SHANTHI COLONY" vs "SHANTHICOLONY").
function matchKey(s) {
  return normKey(s).replace(/[^A-Z0-9]/g, "");
}

function achievementOf(sales, target) {
  return target > 0 ? (sales / target) * 100 : (sales > 0 ? 100 : 0);
}

// Months in scope right now: whatever the Month multi-select has checked.
// Always non-empty in practice — the UI won't let the last checked month
// be unchecked, and boot() seeds a default before the first render.
function activeMonths() {
  if (state.months.length) return state.months;
  return [state.availableMonths[state.availableMonths.length - 1] || FY_MONTHS[0]];
}

// Human label for a set of selected months: collapses an exact quarter or
// the full year down to its short name, otherwise lists the months.
function monthsLabel(months) {
  if (!months || !months.length) return "No months";
  if (months.length === 1) return months[0];
  if (months.length === FY_MONTHS.length) return "Full Year (Apr\u2013Mar)";
  const q = QUARTERS.find((qq) => qq.key !== "FY" && qq.months.length === months.length && qq.months.every((m) => months.includes(m)));
  if (q) return q.label;
  return months.join(", ");
}

// "Sep", "September", "SEP-26" -> "Sep" (FY month abbrev), else null.
function monthAbbrevFromText(v) {
  const t = String(v || "").trim().toLowerCase();
  if (t.length < 3) return null;
  return FY_MONTHS.find((m) => t.slice(0, 3) === m.toLowerCase()) || null;
}

// Bill Date can export day-first (01-04-2025) or month-first (4/1/2025)
// depending on the sheet locale. Scan the file once: a first part > 12 can
// only be a day, a second part > 12 can only be a day. Default day-first.
function detectDateOrder(rows) {
  let dayFirst = 0, monthFirst = 0;
  const lim = Math.min(rows.length, 5000);
  for (let i = 0; i < lim; i++) {
    const m = String(rows[i]["Bill Date"] || "").trim().match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.]\d{2,4}/);
    if (!m) continue;
    const a = Number(m[1]), b = Number(m[2]);
    if (a > 12 && b <= 12) dayFirst++;
    else if (b > 12 && a <= 12) monthFirst++;
  }
  return monthFirst > dayFirst ? "MDY" : "DMY";
}

// -> { month: "Sep"|null, day: 1..31 }.  Uses the sheet's Month column when
// it is valid (ground truth), otherwise derives the month from Bill Date, so
// a sale sheet WITHOUT a Month column (e.g. the 2025 export) still works.
function resolveMonthDay(row, order) {
  const s = String(row["Bill Date"] || "").trim();
  const colMonth = monthAbbrevFromText(row["Month"]);
  let dateMonth = null, day = 1;

  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) { dateMonth = numToAbbrev(Number(m[2])); day = Number(m[3]) || 1; }
  else if ((m = s.match(/^(\d{1,2})[\s\-\/]([A-Za-z]{3})/))) { dateMonth = monthAbbrevFromText(m[2]); day = Number(m[1]) || 1; }
  else if ((m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.]\d{2,4}/))) {
    const a = Number(m[1]), b = Number(m[2]);
    let d = order === "MDY" ? b : a, mo = order === "MDY" ? a : b;
    if (colMonth) {                     // let the Month column settle any ambiguity
      const mn = MONTH_NUM[colMonth];
      if (a === mn && b !== mn) { mo = a; d = b; }
      else if (b === mn && a !== mn) { mo = b; d = a; }
    }
    dateMonth = numToAbbrev(mo); day = d || 1;
  }
  return { month: colMonth || dateMonth, day: Math.min(Math.max(day, 1), 31) };
}

// Date-range stepper maths. Targets are monthly, so when only part of the
// month is selected they are prorated using the SAME fixed weekly split the
// Target bars already use (WEEK_TARGET_SPLIT), weighted by how much of each
// week bucket falls inside the chosen days.
function weekBounds(month) {
  const ends = WEEK_END_BY_MONTH[month] || WEEK_END_DEFAULT;
  const dim = DAYS_IN_MONTH[month] || 30;
  const starts = [1, ...ends.map((e) => e + 1)];
  const stops = [...ends, dim];
  return starts.map((s, i) => [s, stops[i]]);
}
function weekFrac(month, i) {
  const [s, e] = weekBounds(month)[i];
  const len = e - s + 1;
  if (len <= 0) return 0;
  const lo = Math.max(s, state.dayFrom), hi = Math.min(e, state.dayTo);
  return Math.max(0, hi - lo + 1) / len;
}
function isFullRange() { return state.dayFrom <= 1 && state.dayTo >= 31; }
function dayFrac(month) {
  if (isFullRange()) return 1;
  return WEEK_TARGET_SPLIT.reduce((s, w, i) => s + w * weekFrac(month, i), 0);
}
function rangeLabel() {
  return isFullRange() ? "" : `days ${state.dayFrom}\u2013${state.dayTo}`;
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

function buildDayRecords(csvText) {
  const rows = parseRows(csvText);
  const order = detectDateOrder(rows);
  const map = new Map();

  for (const row of rows) {
    const store = (row["Location"] || "").trim();
    const staffRaw = (row["Salesman"] || "").trim();
    if (!store || !staffRaw) continue;
    const { month, day } = resolveMonthDay(row, order);
    if (!month) continue;

    const staffKey = normKey(staffRaw);
    const storeKey = normKey(store);
    const k = `${storeKey}||${staffKey}||${month}||${day}`;
    if (!map.has(k)) {
      map.set(k, {
        store, storeKey, staff: titleCase(staffRaw), staffKey, month, day,
        totalSales: 0, qty: 0, bills: new Set(), categories: {}, categorySales: {},
      });
    }
    const rec = map.get(k);
    const amt = num(row["Bill Amount"]);
    const qty = num(row["Net Qty"]);
    const billCode = (row["Bill Code"] || "").trim();
    const category = (row["Item"] || row["Category"] || "Uncategorised").trim() || "Uncategorised";

    rec.totalSales += amt;
    rec.qty += qty;
    if (billCode) rec.bills.add(billCode);
    rec.categories[category] = (rec.categories[category] || 0) + qty;
    rec.categorySales[category] = (rec.categorySales[category] || 0) + amt;
  }

  return Array.from(map.values()).map((r) => ({ ...r, nob: r.bills.size, bills: null }));
}

// Day records -> one record per Store+Staff+Month, honouring the date range.
function rollup(dayRecs, staffTargetMap) {
  const map = new Map();
  for (const d of dayRecs) {
    if (d.day < state.dayFrom || d.day > state.dayTo) continue;
    const k = `${d.storeKey}||${d.staffKey}||${d.month}`;
    if (!map.has(k)) {
      map.set(k, {
        store: d.store, storeKey: d.storeKey, staff: d.staff, staffKey: d.staffKey, month: d.month,
        totalSales: 0, qty: 0, nob: 0, days: new Set(), weeks: [0, 0, 0, 0, 0],
        categories: {}, categorySales: {},
      });
    }
    const rec = map.get(k);
    rec.totalSales += d.totalSales;
    rec.qty += d.qty;
    rec.nob += d.nob;          // a bill belongs to one date, so summing per-day counts stays distinct
    rec.days.add(d.day);
    rec.weeks[weekIndexForDay(d.day, d.month)] += d.totalSales;
    Object.entries(d.categories).forEach(([c, v]) => { rec.categories[c] = (rec.categories[c] || 0) + v; });
    Object.entries(d.categorySales).forEach(([c, v]) => { rec.categorySales[c] = (rec.categorySales[c] || 0) + v; });
  }

  const out = [];
  for (const rec of map.values()) {
    const fullTarget = staffTargetMap[`${rec.storeKey}||${rec.staffKey}||${rec.month}`] || 0;
    const weeks = rec.weeks.map((achieved, i) => ({
      t: fullTarget > 0 ? fullTarget * (WEEK_TARGET_SPLIT[i] || 0) * weekFrac(rec.month, i) : 0,
      a: achieved,
    }));
    while (weeks.length > 1) {
      const last = weeks[weeks.length - 1];
      if (last.t === 0 && last.a === 0) weeks.pop(); else break;
    }
    out.push({
      store: rec.store, staff: rec.staff, month: rec.month,
      grossTarget: fullTarget * dayFrac(rec.month),
      totalSales: rec.totalSales,
      qty: rec.qty,
      nob: rec.nob,
      atv: rec.nob > 0 ? rec.totalSales / rec.nob : 0,
      bs: rec.nob > 0 ? rec.qty / rec.nob : 0,
      manDays: rec.days.size,
      totalDays: DAYS_IN_MONTH[rec.month] || 30,
      weeks,
      categories: rec.categories,
      categorySales: rec.categorySales,
    });
  }
  return out;
}

function rebuildRecords() {
  state.records = rollup(state.dayRecords, state.staffTargetMap);
  state.archiveRecords = rollup(state.archiveDayRecords, {});
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
    if (!rows.length) return { map: {}, ok: false, headers: [], unit: "qty" };
    const header = Object.keys(rows[0]);
    // Prefer "Store Name"/"Store"/"Location" over e.g. "Store Type".
    const sc = header.find((h) => /^(store( names?)?|location)$/i.test(h.trim()))
      || header.find((h) => /store|location/i.test(h) && !/type/i.test(h));
    const cc = header.find((h) => /categ/i.test(h));
    const tc = header.find((h) => /target/i.test(h) && !/ach/i.test(h)) || header.find((h) => /target/i.test(h));
    const mc = header.find((h) => /month/i.test(h));
    if (!sc || !cc || !tc) return { map: {}, ok: false, headers: header, unit: "qty" };

    // Quantity target by default; treat as rupees only if the header says so.
    const unit = /value|amount|sale|revenue|\u20b9|rs\b/i.test(tc) && !/qty|quantity|unit|pcs/i.test(tc) ? "value" : "qty";

    const map = {};
    const labels = {};
    for (const row of rows) {
      const store = (row[sc] || "").trim();
      const category = (row[cc] || "").trim();
      if (!store || !category) continue;
      const month = mc ? monthAbbrevFromCell(row[mc]) : null;
      const ck = normKey(category);
      labels[ck] = labels[ck] || category;
      const key = month ? `${normKey(store)}||${ck}||${month}` : `${normKey(store)}||${ck}||*`;
      map[key] = (map[key] || 0) + num(row[tc]);
    }
    map.__labels = labels;
    return { map, ok: Object.keys(map).length > 1, headers: header, unit };
  } catch (e) {
    return { map: {}, ok: false, headers: [], unit: "qty" };
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
  state.staffTargetMap = staffTargetR.status === "fulfilled" ? buildStaffTargetMap(staffTargetR.value) : (failed.push("Salesman Target"), {});
  if (saleR.status === "fulfilled") {
    state.dayRecords = buildDayRecords(saleR.value);
  } else failed.push("2026 Sale");

  if (saleLyR.status === "fulfilled") {
    state.archiveDayRecords = buildDayRecords(saleLyR.value);
  } else failed.push("2025 Sale");
  rebuildRecords();
  state.lyDiag = state.archiveDayRecords.length
    ? ""
    : (saleLyR.status === "fulfilled"
        ? "2025 SALE loaded but 0 usable rows (check Location / Salesman / Bill Date columns)"
        : "");

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
    state.categoryUnit = ct.unit;
    state.categoryHeaders = ct.headers;
  } else {
    state.categoryTargets = {};
    state.hasCategoryTargets = false;
    state.categoryHeaders = [];
    failed.push("Category Target");
  }

  state.storeTypeMap = storeTypeR.status === "fulfilled"
    ? buildStoreTypeMap(storeTypeR.value)
    : (failed.push("Store Type"), {});

  state.availableMonths = FY_MONTHS.filter((m) =>
    state.dayRecords.some((r) => r.month === m)
  );
  if (!state.availableMonths.length) state.availableMonths = ["Apr"];

  // Pick the quarter that contains the most recent month with data, and
  // default the Month multi-select to those 3 months — but only on first
  // load (state.months starts empty); once the user has a selection we
  // leave it alone across auto-refreshes.
  const latestMonthWithData = state.availableMonths[state.availableMonths.length - 1];
  if (!state.months.length) {
    const q = QUARTERS.find((qq) => qq.key !== "FY" && qq.months.includes(latestMonthWithData));
    state.months = q ? q.months.slice() : [latestMonthWithData];
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
  buildMonthMultiSelect();
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

function buildMonthMultiSelect() {
  // Preset chips: Q1–Q4 + Full Year, highlighted when the current
  // selection matches one exactly.
  const presetsEl = document.getElementById("monthMultiPresets");
  presetsEl.innerHTML = QUARTERS.map((q) => {
    const active = q.months.length === state.months.length && q.months.every((m) => state.months.includes(m));
    return `<button type="button" class="ms-preset-chip${active ? " active" : ""}" data-preset="${q.key}">${q.key === "FY" ? "Full Year" : q.key}</button>`;
  }).join("");

  // One checkbox per FY month, in financial-year order.
  const optionsEl = document.getElementById("monthMultiOptions");
  optionsEl.innerHTML = FY_MONTHS.map((m) => {
    const hasData = state.availableMonths.includes(m);
    const checked = state.months.includes(m);
    return `
      <label class="ms-option${hasData ? "" : " no-data"}">
        <input type="checkbox" value="${m}" ${checked ? "checked" : ""} />
        ${m}${hasData ? "" : " *"}
      </label>
    `;
  }).join("");

  document.getElementById("monthMultiLabel").textContent = monthsLabel(state.months);
}

function buildStoreTypeOptions() {
  const sel = document.getElementById("storeTypeSelect");
  const types = Array.from(new Set(Object.values(state.storeTypeMap).filter(Boolean))).sort();
  const options = ["All Types"];
  if (types.includes("COCO") || types.includes("FOFO")) options.push("TN");
  options.push(...types);
  if (!options.includes(state.storeType)) state.storeType = "All Types";
  sel.innerHTML = options.map((t) =>
    `<option value="${t}" ${t === state.storeType ? "selected" : ""}>${t === "TN" ? "TN (COCO + FOFO)" : t}</option>`
  ).join("");
}

// "TN" is a synthetic combined type (COCO + FOFO stores); every other value
// matches the store-type sheet directly.
function storeTypeKeyMatches(normalizedStoreKey) {
  if (state.storeType === "All Types") return true;
  const t = state.storeTypeMap[normalizedStoreKey];
  if (state.storeType === "TN") return t === "COCO" || t === "FOFO";
  return t === state.storeType;
}

function storeTypeMatches(store) {
  return storeTypeKeyMatches(normKey(store));
}

function buildStoreOptions() {
  const months = activeMonths();
  let scoped = state.dayRecords.filter((r) => months.includes(r.month));
  if (state.storeType !== "All Types") scoped = scoped.filter((r) => storeTypeMatches(r.store));
  const stores = Array.from(new Set(scoped.map((r) => r.store).filter(Boolean))).sort();
  state.storeOptions = stores;
  // Drop any previously-checked stores that are no longer valid in this scope.
  state.stores = state.stores.filter((s) => stores.includes(s));
  buildStoreMultiSelect();
}

function storesLabel(selected, all) {
  if (!selected.length || (all.length && selected.length === all.length)) return "All Stores";
  if (selected.length === 1) return selected[0];
  return `${selected.length} stores selected`;
}

function buildStoreMultiSelect() {
  const optionsEl = document.getElementById("storeMultiOptions");
  optionsEl.innerHTML = state.storeOptions.map((s) => {
    const checked = state.stores.includes(s);
    return `
      <label class="ms-option">
        <input type="checkbox" value="${s}" ${checked ? "checked" : ""} />
        ${s}
      </label>
    `;
  }).join("");
  document.getElementById("storeMultiLabel").textContent = storesLabel(state.stores, state.storeOptions);
}

function storeSelectionMatches(storeName) {
  return state.stores.length === 0 || state.stores.includes(storeName);
}

function filteredRecords() {
  const months = activeMonths();
  let recs = state.records.filter((r) => months.includes(r.month));
  if (state.stores.length) recs = recs.filter((r) => storeSelectionMatches(r.store));
  if (state.storeType !== "All Types") recs = recs.filter((r) => storeTypeMatches(r.store));
  return recs;
}

function lastYearRecords() {
  const months = activeMonths();
  let recs = state.archiveRecords.filter((r) => months.includes(r.month));
  if (state.stores.length) recs = recs.filter((r) => storeSelectionMatches(r.store));
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

function storeTargetFor(scope, months, prorate = true) {
  const f = (m) => (prorate ? dayFrac(m) : 1);
  if (state.stores.length) {
    let sum = 0;
    state.stores.forEach((storeName) => {
      months.forEach((m) => { sum += (scope[`${normKey(storeName)}||${m}`] || 0) * f(m); });
    });
    return sum;
  }
  let sum = 0;
  Object.entries(scope).forEach(([k, v]) => {
    const sep = k.lastIndexOf("||");
    const storeKeyPart = k.slice(0, sep);
    const m = k.slice(sep + 2);
    if (!months.includes(m)) return;
    if (!storeTypeKeyMatches(storeKeyPart)) return;
    sum += v * f(m);
  });
  return sum;
}

/* ---------------------------- KPI ---------------------------- */

function calcKPIs(recs, storeTargetScope, months) {
  const grossTarget = storeTargetFor(storeTargetScope, months);
  const totalSales = recs.reduce((s, r) => s + r.totalSales, 0);
  const qty = recs.reduce((s, r) => s + r.qty, 0);
  const nob = recs.reduce((s, r) => s + r.nob, 0);
  const achievement = achievementOf(totalSales, grossTarget);
  const atv = nob > 0 ? totalSales / nob : 0;
  const bs = nob > 0 ? qty / nob : 0;
  return { grossTarget, totalSales, achievement, qty, nob, atv, bs, staffCount: recs.length };
}

// "Like-for-like" stores: ones with sale records in BOTH the current scope
// and the same scope last year (data-driven proxy for "was trading in both
// periods", since there's no explicit store-open-date field).
function calcL2L(scoped, lyRecs) {
  const months = activeMonths();
  const cyByStore = new Map();
  scoped.forEach((r) => {
    const k = matchKey(r.store);
    if (!cyByStore.has(k)) cyByStore.set(k, { name: r.store, sales: 0 });
    cyByStore.get(k).sales += r.totalSales;
  });
  const lyByStore = new Map();
  lyRecs.forEach((r) => {
    const k = matchKey(r.store);
    if (!lyByStore.has(k)) lyByStore.set(k, { name: r.store, sales: 0 });
    lyByStore.get(k).sales += r.totalSales;
  });

  const l2lKeys = Array.from(cyByStore.keys()).filter((k) => lyByStore.has(k));

  let target = 0, achieved = 0, lyAchieved = 0;
  l2lKeys.forEach((k) => {
    achieved += cyByStore.get(k).sales;
    lyAchieved += lyByStore.get(k).sales;
    target += storeTargetForStore(state.storeTargets, cyByStore.get(k).name, months);
  });

  const achievement = achievementOf(achieved, target);
  const growth = lyAchieved > 0 ? ((achieved - lyAchieved) / lyAchieved) * 100 : (achieved > 0 ? 100 : 0);
  return { target, achieved, lyAchieved, achievement, storeCount: l2lKeys.length, growth, hasLY: l2lKeys.length > 0 };
}

// MTD card: always the real current calendar month (not whatever
// quarter/month the slicers happen to be on), so it stays a fixed
// "where are we right now" reference point.
function currentRealMonthAbbrev() {
  const abbr = new Date().toLocaleString("en-US", { month: "short" });
  return FY_MONTHS.includes(abbr) ? abbr : FY_MONTHS[0];
}

function calcMTD() {
  const real = currentRealMonthAbbrev();
  let month = real;
  let fallback = false;
  if (!state.dayRecords.some((r) => r.month === month) && state.availableMonths.length) {
    month = state.availableMonths[state.availableMonths.length - 1];
    fallback = true;   // no bills yet for the real current month: show the latest month we have
  }
  const today = new Date().getDate();
  const lastDay = fallback ? 31 : today;
  let recs = state.dayRecords.filter((r) => r.month === month && r.day <= lastDay);
  if (state.stores.length) recs = recs.filter((r) => storeSelectionMatches(r.store));
  if (state.storeType !== "All Types") recs = recs.filter((r) => storeTypeMatches(r.store));
  const grossTarget = storeTargetFor(state.storeTargets, [month], false);
  const totalSales = recs.reduce((s, r) => s + r.totalSales, 0);
  const achievement = achievementOf(totalSales, grossTarget);
  return { month, grossTarget, totalSales, achievement, fallback, lastDay };
}

// Sales Per Day: total sales across the active scope divided by the
// calendar days spanned by the currently selected month(s).
function calcSPD(kpis) {
  const months = activeMonths();
  const days = months.reduce((s, m) => {
    const dim = DAYS_IN_MONTH[m] || 30;
    return s + Math.max(0, Math.min(state.dayTo, dim) - Math.max(state.dayFrom, 1) + 1);
  }, 0);
  const spd = days > 0 ? kpis.totalSales / days : 0;
  return { spd, days };
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

function renderKPIs(kpis, lyKpis, l2l) {
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
  const cardHtml = (c) => `
    <div class="kpi-card accent">
      <div class="kpi-label">${c.label}</div>
      <div class="kpi-value">${c.value}</div>
      ${c.lyValue ? `
        <div class="kpi-ly">
          <span class="kpi-ly-value">${c.lyValue}</span>
          ${c.delta ? `<span class="kpi-ly-delta ${c.delta.good ? "good" : "bad"}">${c.delta.text}</span>` : ""}
        </div>` : `<div class="kpi-ly kpi-ly-empty">No LY data</div>`}
    </div>
  `;
  const headCardsHtml = cards.slice(0, 5).map(cardHtml).join("");
  const tailCardsHtml = cards.slice(5).map(cardHtml).join("");

  const mtd = calcMTD();
  const mtdCardHtml = `
    <div class="kpi-card accent">
      <div class="kpi-label">MTD</div>
      <div class="kpi-value">\u20b9${fmtINR(mtd.totalSales)}</div>
      <div class="kpi-sub ${mtd.achievement >= 100 ? "good" : "bad"}">${fmtPct(mtd.achievement)} of \u20b9${fmtINR(mtd.grossTarget)} target (${mtd.month}${mtd.fallback ? " \u00b7 latest data" : " 1\u2013" + mtd.lastDay})</div>
    </div>
  `;

  const l2lCardHtml = `
    <div class="kpi-card accent">
      <div class="kpi-label">L2L Stores Achieved</div>
      <div class="kpi-value">\u20b9${fmtINR(l2l.achieved)}</div>
      <div class="kpi-ly">
        <span class="kpi-ly-value">${l2l.storeCount} store${l2l.storeCount === 1 ? "" : "s"}</span>
        ${l2l.hasLY
          ? `<span class="kpi-ly-delta ${l2l.growth >= 0 ? "good" : "bad"}">${l2l.growth >= 0 ? "+" : ""}${l2l.growth.toFixed(1)}% growth</span>`
          : `<span class="kpi-ly-value">\u2014</span>`}
      </div>
    </div>
  `;

  const spd = calcSPD(kpis);
  const spdCardHtml = `
    <div class="kpi-card accent">
      <div class="kpi-label">SPD (Sales/Day)</div>
      <div class="kpi-value">\u20b9${fmtINR(spd.spd)}</div>
      <div class="kpi-sub">across ${spd.days} day${spd.days === 1 ? "" : "s"}</div>
    </div>
  `;

  document.getElementById("kpiRow").innerHTML = headCardsHtml + l2lCardHtml + mtdCardHtml + spdCardHtml + tailCardsHtml;
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

// Last year's sale sheet has no per-staff target column, so per-staff weekly
// target (r.weeks[i].t) is always 0 for archive records. For the LY trend
// line, prorate the store-level LY target across the month/week instead —
// the same store-level number already used correctly by the KPI cards.
function calcWeeklyFromStoreTarget(recs, monthAbbrev, targetMap = state.storeTargetsLY) {
  const totalTarget = storeTargetFor(targetMap, [monthAbbrev], false);
  return [0, 1, 2, 3, 4].map((i) => {
    const target = totalTarget > 0 ? totalTarget * (WEEK_TARGET_SPLIT[i] || 0) * weekFrac(monthAbbrev, i) : 0;
    const achieved = recs.reduce((s, r) => s + (r.weeks[i] ? r.weeks[i].a : 0), 0);
    return { name: `WK ${i + 1}`, target, achieved };
  });
}

// Used instead of calcWeekly when the "whole quarter" view is active: one
// bar per month of the quarter rather than per-week buckets (weeks from
// different months aren't comparable/summable).
function calcMonthlySplit(recs) {
  const months = state.months;
  return months.map((m) => {
    const rows = recs.filter((r) => r.month === m);
    return {
      name: m,
      target: rows.reduce((s, r) => s + r.grossTarget, 0),
      achieved: rows.reduce((s, r) => s + r.totalSales, 0),
    };
  });
}

// LY equivalent of calcMonthlySplit, using the store-level LY target
// (see calcWeeklyFromStoreTarget above for why).
function calcMonthlySplitFromStoreTarget(recs) {
  const months = state.months;
  return months.map((m) => {
    const rows = recs.filter((r) => r.month === m);
    return {
      name: m,
      target: storeTargetFor(state.storeTargetsLY, [m]),
      achieved: rows.reduce((s, r) => s + r.totalSales, 0),
    };
  });
}

// Category table: Target comes from the Category Target sheet, Ach is the
// actual (units or rupees, matching what that sheet measures). Targets are
// summed over the stores/months in scope and prorated for a partial date range.
function calcCategories(recs) {
  const unit = state.categoryUnit;
  const achSource = unit === "value" ? "categorySales" : "categories";
  const labels = (state.categoryTargets && state.categoryTargets.__labels) || {};
  const rows = new Map();   // normalized category -> { category, target, ach }
  const row = (label) => {
    const k = normKey(label);
    if (!rows.has(k)) rows.set(k, { category: labels[k] || label, target: 0, ach: 0 });
    return rows.get(k);
  };

  recs.forEach((r) => {
    Object.entries(r[achSource] || {}).forEach(([cat, v]) => { row(cat).ach += v; });
  });

  let anyTarget = false;
  if (state.hasCategoryTargets) {
    const months = activeMonths();
    const storeKeys = state.stores.length
      ? state.stores.map(normKey)
      : Array.from(new Set(recs.map((r) => normKey(r.store))));
    const cats = Object.keys(labels);
    storeKeys.forEach((sk) => {
      cats.forEach((ck) => {
        let t = 0, usedMonthly = false;
        months.forEach((m) => {
          const exact = state.categoryTargets[`${sk}||${ck}||${m}`];
          if (exact) { t += exact * dayFrac(m); usedMonthly = true; }
        });
        if (!usedMonthly) {
          const any = state.categoryTargets[`${sk}||${ck}||*`];
          if (any) t += any * (months.length ? months.reduce((s, m) => s + dayFrac(m), 0) / months.length : 1);
        }
        if (t > 0) { row(labels[ck]).target += t; anyTarget = true; }
      });
    });
  }

  const list = Array.from(rows.values())
    .filter((c) => c.target > 0 || c.ach > 0)
    .sort((a, b) => (anyTarget ? (b.target - a.target) || (b.ach - a.ach) : b.ach - a.ach));
  return { list, unit, anyTarget };
}

const PLUM = "#12395B";
const GOLD = "#ED9729";
const MUTED_GRID = "#E1E5EC";
const PALETTE = ["#12395B", "#ED9729", "#2E6B4F", "#9B6B12", "#A23B34", "#0B2740", "#6B7280", "#7A9E8E"];

function renderWeeklyChart(cySeries, lySeries) {
  const ctx = document.getElementById("weeklyChart");
  const hasLY = lySeries && lySeries.length && lySeries.some((w) => w.target > 0 || w.achieved > 0);
  const BAR_GREY = "#9AA5B1";

  const totalTargetAllPoints = cySeries.reduce((s, w) => s + w.target, 0);

  const datasets = [
    {
      type: "bar", label: "Target", data: cySeries.map((w) => w.target),
      achievedValues: cySeries.map((w) => w.achieved),
      backgroundColor: BAR_GREY, borderRadius: 4, order: 3, yAxisID: "y",
      datalabels: {
        display: true, anchor: "end", align: "top", offset: 2,
        color: PLUM, font: { family: "Inter", weight: "700", size: 10 },
        formatter: (v, ctx) => {
          if (v <= 0) return "";
          const ach = ctx.dataset.achievedValues ? ctx.dataset.achievedValues[ctx.dataIndex] : 0;
          return fmtPct(achievementOf(ach, v));
        },
      },
    },
    {
      type: "line", label: "Contri. (CY)", data: cySeries.map((w) => w.achieved),
      borderColor: GOLD, backgroundColor: GOLD,
      borderWidth: 2.5, pointRadius: 4, pointHoverRadius: 6, pointBackgroundColor: GOLD,
      tension: 0.35, fill: false, order: 1, yAxisID: "y",
      targets: cySeries.map((w) => w.target),
      totalTargetForContribution: totalTargetAllPoints,
      datalabels: { display: false },
    },
  ];
  if (hasLY) {
    datasets.push({
      type: "line", label: "Contri. (LY)", data: lySeries.map((w) => w.achieved),
      borderColor: PLUM, backgroundColor: PLUM,
      borderWidth: 2, borderDash: [5, 4], pointRadius: 3, pointHoverRadius: 5, pointBackgroundColor: PLUM,
      tension: 0.35, fill: false, order: 2, yAxisID: "y",
      targets: lySeries.map((w) => w.target),
      totalTargetForContribution: totalTargetAllPoints,
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
              if (c.dataset.type === "bar") return `${c.dataset.label}: \u20b9${fmtINR(c.raw)}`;
              // Both trend lines: contribution of this point's achieved
              // value against the total target for the whole chart, not
              // its own bucket's achievement (that's shown on the bar).
              const totalTarget = c.dataset.totalTargetForContribution || 0;
              const pct = achievementOf(c.raw, totalTarget);
              return `${c.dataset.label}: \u20b9${fmtINR(c.raw)} (${pct.toFixed(1)}%)`;
            },
          },
        },
      },
      scales: {
        y: { position: "left", ticks: { callback: (v) => "\u20b9" + fmtINR(v) }, grid: { color: MUTED_GRID } },
        x: { grid: { display: false } },
      },
    },
  });
}

function renderCategoryTable(cat) {
  const body = document.getElementById("categoryBody");
  const foot = document.getElementById("categoryFoot");
  const warn = document.getElementById("categoryWarn");
  const sym = cat.unit === "value" ? "\u20b9" : "";
  const f = (v) => sym + fmtINR(v);

  document.getElementById("categoryNote").textContent =
    (cat.unit === "value" ? "\u20b9 value" : "units") + (rangeLabel() ? ` \u00b7 ${rangeLabel()} (target prorated)` : "");

  body.innerHTML = cat.list.map((c) => {
    const pct = achievementOf(c.ach, c.target);
    return `
      <tr>
        <td class="store-name">${c.category}</td>
        <td class="num">${c.target > 0 ? f(c.target) : "\u2014"}</td>
        <td class="num">${f(c.ach)}</td>
        <td class="num">${c.target > 0 ? `<span class="pill ${badgeClass(pct)}">${fmtPct(pct)}</span>` : "\u2014"}</td>
      </tr>`;
  }).join("") || `<tr><td colspan="4" class="num" style="text-align:center;color:var(--muted)">No data in this selection</td></tr>`;

  const tT = cat.list.reduce((s, c) => s + c.target, 0);
  const tA = cat.list.reduce((s, c) => s + c.ach, 0);
  foot.innerHTML = cat.list.length ? `
    <tr class="row-total">
      <td>Total</td>
      <td class="num">${tT > 0 ? f(tT) : "\u2014"}</td>
      <td class="num">${f(tA)}</td>
      <td class="num">${tT > 0 ? fmtPct(achievementOf(tA, tT)) : "\u2014"}</td>
    </tr>` : "";

  if (!state.hasCategoryTargets) {
    warn.hidden = false;
    warn.textContent = state.categoryHeaders.length
      ? `Category Target sheet loaded but its columns weren't recognised (needs Store, Category, Target; Month optional). Headers found: ${state.categoryHeaders.join(", ")}`
      : "Category Target sheet could not be loaded, so only achieved figures are shown.";
  } else if (!cat.anyTarget) {
    warn.hidden = false;
    warn.textContent = "No category targets match the stores/months selected (check store names and month in the Category Target sheet).";
  } else {
    warn.hidden = true;
  }
}

/* ---------------------------- matrix ---------------------------- */

function badgeClass(ach) {
  if (ach >= 100) return "good";
  if (ach >= 80) return "warn";
  return "bad";
}

function growthBadgeClass(growth) {
  return growth >= 0 ? "good" : "bad";
}

function storeTypeOf(store) {
  return state.storeTypeMap[normKey(store)] || "";
}
// 0 = COCO, 1 = FOFO, 2 = everything else (other states).
function storeTypeRank(store) {
  const t = storeTypeOf(store).toUpperCase();
  return t === "COCO" ? 0 : (t === "FOFO" ? 1 : 2);
}

function renderMatrix(recs) {
  const withAch = recs.map((r) => ({ ...r, achievement: achievementOf(r.totalSales, r.grossTarget) }));
  const sorted = withAch.sort((a, b) => {
    const rk = storeTypeRank(a.store) - storeTypeRank(b.store);
    if (rk !== 0) return rk;
    if (storeTypeRank(a.store) === 2) {            // keep other states together by type name
      const tn = storeTypeOf(a.store).localeCompare(storeTypeOf(b.store));
      if (tn !== 0) return tn;
    }
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

// Target for one specific store (regardless of the global Store filter),
// across the given months — used by the store-wise matrix.
function storeTargetForStore(scope, storeName, months) {
  const k = normKey(storeName);
  return months.reduce((sum, m) => sum + (scope[`${k}||${m}`] || 0) * dayFrac(m), 0);
}

function renderStoreMatrix(recs, lyRecs) {
  const months = activeMonths();
  const map = new Map();
  recs.forEach((r) => {
    const k = normKey(r.store);
    if (!map.has(k)) map.set(k, { store: r.store, totalSales: 0, qty: 0, nob: 0 });
    const m = map.get(k);
    m.totalSales += r.totalSales;
    m.qty += r.qty;
    m.nob += r.nob;
  });

  const lyByStore = new Map();
  (lyRecs || []).forEach((r) => {
    const k = matchKey(r.store);
    lyByStore.set(k, (lyByStore.get(k) || 0) + r.totalSales);
  });

  const rows = Array.from(map.entries()).map(([k, m]) => {
    const grossTarget = storeTargetForStore(state.storeTargets, m.store, months);
    const achievement = achievementOf(m.totalSales, grossTarget);
    const atv = m.nob > 0 ? m.totalSales / m.nob : 0;
    const bs = m.nob > 0 ? m.qty / m.nob : 0;
    const mk = matchKey(m.store);
    const lySales = lyByStore.get(mk) || 0;
    const growth = lySales > 0 ? ((m.totalSales - lySales) / lySales) * 100 : (m.totalSales > 0 ? 100 : 0);
    return { ...m, grossTarget, achievement, atv, bs, lySales, growth, hasLY: lyByStore.has(mk) };
  }).sort((a, b) => b.totalSales - a.totalSales);

  document.getElementById("storeMatrixBody").innerHTML = rows.map((r) => `
    <tr>
      <td class="store-name">${r.store}</td>
      <td class="num">\u20b9${fmtINR(r.grossTarget)}</td>
      <td class="num">\u20b9${fmtINR(r.totalSales)}</td>
      <td class="num"><span class="pill ${badgeClass(r.achievement)}">${fmtPct(r.achievement)}</span></td>
      <td class="num">${r.hasLY ? "\u20b9" + fmtINR(r.lySales) : "\u2014"}</td>
      <td class="num">${r.hasLY ? `<span class="pill ${growthBadgeClass(r.growth)}">${r.growth >= 0 ? "+" : ""}${r.growth.toFixed(1)}%</span>` : "\u2014"}</td>
      <td class="num">${fmtNum(r.qty)}</td>
      <td class="num">${fmtNum(r.nob)}</td>
      <td class="num">\u20b9${fmtINR(r.atv)}</td>
      <td class="num">${r.bs.toFixed(2)}</td>
    </tr>
  `).join("");
  document.getElementById("storeMatrixCount").textContent = `${rows.length} store${rows.length === 1 ? "" : "s"}`;
}

/* ---------------------------- render orchestration ---------------------------- */

function render() {
  const scoped = filteredRecords();
  const months = activeMonths();
  const kpis = calcKPIs(scoped, state.storeTargets, months);
  const lyRecs = lastYearRecords();
  const lyKpis = calcKPIs(lyRecs, state.storeTargetsLY, months);
  const l2l = calcL2L(scoped, lyRecs);
  renderKPIs(kpis, lyKpis, l2l);
  renderStoreMatrix(scoped, lyRecs);

  const isMultiMonthView = state.months.length > 1;
  document.getElementById("weeklyChartTitle").textContent =
    isMultiMonthView ? "Month-wise target vs achieved" : "Week-wise target vs achieved";
  document.getElementById("weeklyChartNote").textContent =
    rangeLabel() ? `${rangeLabel()} \u00b7 target prorated` : "";

  let cySeries, lySeries;
  if (isMultiMonthView) {
    cySeries = calcMonthlySplit(scoped);
    lySeries = calcMonthlySplitFromStoreTarget(lyRecs);
  } else {
    cySeries = calcWeekly(scoped, false);
    // FALLBACK: weekly CY target normally comes from the Staff Target sheet.
    // If that sheet has no rows for this month (or names don't match), every
    // week's target is 0 and the Target bars vanish. In that case prorate the
    // store-level target (the same number the "Gross Target" KPI card uses).
    if (cySeries.every((w) => w.target === 0)) {
      cySeries = calcWeeklyFromStoreTarget(scoped, months[0], state.storeTargets);
    }
    lySeries = calcWeeklyFromStoreTarget(lyRecs, months[0]);
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

  renderCategoryTable(calcCategories(scoped));

  const shown = searchedRecords(scoped);
  const matrixRows = isMultiMonthView ? mergeByStaff(shown) : shown;
  renderMatrix(matrixRows);

  const uniqueStaff = new Set(scoped.map((r) => `${r.store}||${r.staff}`)).size;
  document.getElementById("recordCount").textContent =
    `${uniqueStaff} staff \u00b7 ${new Set(scoped.map((r) => r.store)).size} stores`;
  document.getElementById("footerMonth").textContent =
    monthsLabel(state.months) + (rangeLabel() ? ` (${rangeLabel()})` : "");
  document.getElementById("footerUpdated").textContent = state.lastUpdated
    ? `\u00b7 last refreshed ${state.lastUpdated.toLocaleString()}`
    : "";
  if (state.failedSources.length) {
    document.getElementById("footerUpdated").textContent += ` \u00b7 failed: ${state.failedSources.join(", ")}`;
  }
  if (state.lyDiag) {
    document.getElementById("footerUpdated").textContent += ` \u00b7 ${state.lyDiag}`;
  }
}

/* ---------------------------- events ---------------------------- */

function wireEvents() {
  const msBtn = document.getElementById("monthMultiBtn");
  const msPanel = document.getElementById("monthMultiPanel");

  const openPanel = () => { msPanel.hidden = false; msBtn.setAttribute("aria-expanded", "true"); };
  const closePanel = () => { msPanel.hidden = true; msBtn.setAttribute("aria-expanded", "false"); };

  msBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (msPanel.hidden) openPanel(); else closePanel();
  });
  document.addEventListener("click", (e) => {
    if (!msPanel.hidden && !msPanel.contains(e.target) && e.target !== msBtn) closePanel();
  });

  const monthsChanged = () => {
    buildMonthMultiSelect();
    buildStoreOptions();
    render();
  };

  document.getElementById("monthMultiOptions").addEventListener("change", (e) => {
    const cb = e.target;
    if (cb.tagName !== "INPUT") return;
    const m = cb.value;
    if (cb.checked) {
      if (!state.months.includes(m)) state.months = [...state.months, m].sort((a, b) => FY_MONTHS.indexOf(a) - FY_MONTHS.indexOf(b));
    } else {
      // Never allow the last checked month to be unchecked — keep at
      // least one month in scope at all times.
      if (state.months.length <= 1) { cb.checked = true; return; }
      state.months = state.months.filter((x) => x !== m);
    }
    monthsChanged();
  });

  document.getElementById("monthMultiPresets").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-preset]");
    if (!btn) return;
    const q = QUARTERS.find((qq) => qq.key === btn.dataset.preset);
    if (q) state.months = q.months.slice();
    monthsChanged();
  });

  document.getElementById("monthMultiClear").addEventListener("click", () => {
    const latest = state.availableMonths[state.availableMonths.length - 1] || FY_MONTHS[0];
    state.months = [latest];
    monthsChanged();
  });
  document.getElementById("monthMultiAll").addEventListener("click", () => {
    state.months = FY_MONTHS.slice();
    monthsChanged();
  });

  // Date-range drag slider: two overlaid <input type="range"> thumbs sharing
  // one track. "input" fires continuously while dragging — used only to
  // update the visual fill/label so it tracks the thumb in real time.
  // "change" fires once on release — that's when we actually re-aggregate
  // and re-render, so a fast drag doesn't recompute on every pixel.
  const fromRange = document.getElementById("dayFromRange");
  const toRange = document.getElementById("dayToRange");
  const fillEl = document.getElementById("dayRangeFill");
  const labelEl = document.getElementById("dayRangeLabel");
  const RANGE_MIN = 1, RANGE_MAX = 31;

  const updateSliderVisual = () => {
    const from = Number(fromRange.value), to = Number(toRange.value);
    const pctFrom = ((from - RANGE_MIN) / (RANGE_MAX - RANGE_MIN)) * 100;
    const pctTo = ((to - RANGE_MIN) / (RANGE_MAX - RANGE_MIN)) * 100;
    fillEl.style.left = pctFrom + "%";
    fillEl.style.width = Math.max(0, pctTo - pctFrom) + "%";
    labelEl.textContent = (from === RANGE_MIN && to === RANGE_MAX) ? "1–31" : `${from}–${to}`;
  };
  const applyDayRange = () => {
    rebuildRecords();
    buildStoreOptions();
    render();
  };

  fromRange.addEventListener("input", () => {
    let from = Number(fromRange.value);
    const to = Number(toRange.value);
    if (from > to) { from = to; fromRange.value = from; }
    state.dayFrom = from;
    updateSliderVisual();
  });
  toRange.addEventListener("input", () => {
    const from = Number(fromRange.value);
    let to = Number(toRange.value);
    if (to < from) { to = from; toRange.value = to; }
    state.dayTo = to;
    updateSliderVisual();
  });
  fromRange.addEventListener("change", applyDayRange);
  toRange.addEventListener("change", applyDayRange);

  document.getElementById("dayReset").addEventListener("click", () => {
    state.dayFrom = RANGE_MIN; state.dayTo = RANGE_MAX;
    fromRange.value = RANGE_MIN; toRange.value = RANGE_MAX;
    updateSliderVisual();
    applyDayRange();
  });

  updateSliderVisual();

  document.getElementById("storeTypeSelect").addEventListener("change", (e) => {
    state.storeType = e.target.value;
    buildStoreOptions();
    render();
  });

  const storeMsBtn = document.getElementById("storeMultiBtn");
  const storeMsPanel = document.getElementById("storeMultiPanel");
  const openStorePanel = () => { storeMsPanel.hidden = false; storeMsBtn.setAttribute("aria-expanded", "true"); };
  const closeStorePanel = () => { storeMsPanel.hidden = true; storeMsBtn.setAttribute("aria-expanded", "false"); };
  storeMsBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (storeMsPanel.hidden) openStorePanel(); else closeStorePanel();
  });
  document.addEventListener("click", (e) => {
    if (!storeMsPanel.hidden && !storeMsPanel.contains(e.target) && e.target !== storeMsBtn) closeStorePanel();
  });
  document.getElementById("storeMultiOptions").addEventListener("change", (e) => {
    const cb = e.target;
    if (cb.tagName !== "INPUT") return;
    const s = cb.value;
    if (cb.checked) {
      if (!state.stores.includes(s)) state.stores = [...state.stores, s];
    } else {
      state.stores = state.stores.filter((x) => x !== s);
    }
    buildStoreMultiSelect();
    render();
  });
  document.getElementById("storeMultiClear").addEventListener("click", () => {
    state.stores = [];
    buildStoreMultiSelect();
    render();
  });
  document.getElementById("storeMultiAll").addEventListener("click", () => {
    state.stores = state.storeOptions.slice();
    buildStoreMultiSelect();
    render();
  });

  document.getElementById("staffSearch").addEventListener("input", (e) => {
    state.search = e.target.value;
    render();
  });
  document.getElementById("refreshBtn").addEventListener("click", loadAll);

  document.getElementById("storeMatrixToggle").addEventListener("click", (e) => {
    const panel = document.querySelector(".store-matrix-panel");
    const collapsed = panel.classList.toggle("collapsed");
    e.target.textContent = collapsed ? "Show" : "Hide";
  });

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
  wireEvents();
  loadAll();
  setInterval(loadAll, REFRESH_MS);
}

document.addEventListener("DOMContentLoaded", boot);
