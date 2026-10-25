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
const DIWALI_TARGET_URL =
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vQOgpraKVB0D1Ey0zuWSZQJ0JH23P2c9gEnWtlTPHYHHpi5m6iyyTZg3UaucUSG3ikv7-vXiqsm4WnW/pub?gid=2112610469&single=true&output=csv";
const DIWALI_SALE_LY_URL =
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vQOgpraKVB0D1Ey0zuWSZQJ0JH23P2c9gEnWtlTPHYHHpi5m6iyyTZg3UaucUSG3ikv7-vXiqsm4WnW/pub?gid=931553449&single=true&output=csv";
const DIWALI_SALE_URL =
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vQOgpraKVB0D1Ey0zuWSZQJ0JH23P2c9gEnWtlTPHYHHpi5m6iyyTZg3UaucUSG3ikv7-vXiqsm4WnW/pub?gid=1588303177&single=true&output=csv";
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
  Diwali: [7, 14, 21, 28],   // Diwali days are numbered 1.. from the first Diwali bill date
};
// "Diwali" is a special pseudo-month: its own sale sheets (2026 Diwali / 2025 Diwali)
// and Diwali Target sheet, shown like any other month when ticked in the Month filter.
const DIWALI = "Diwali";
DAYS_IN_MONTH[DIWALI] = 31;
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
  cyDates: null,         // current-year date range {from:{y,m,d}, to:{y,m,d}}, m = 0..11. null = month mode
  lyDates: null,         // last-year range set explicitly by the user. null = follows cyDates minus 1 year
  prevMonths: [],        // month selection to restore when the date range is reset
  cyView: null,          // {y, m}: month the calendars open on (latest month with sales)
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
function selectedMonthsBase() {
  if (state.months.length) return state.months;
  return [state.availableMonths[state.availableMonths.length - 1] || FY_MONTHS[0]];
}

// Human label for a set of selected months: collapses an exact quarter or
// the full year down to its short name, otherwise lists the months.
function monthsLabel(months) {
  if (!months || !months.length) return "None";
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
  let dateMonth = null, day = 1, year = null;
  const fixYear = (v) => { const n = Number(v); return !n ? null : (n < 100 ? 2000 + n : n); };

  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) { year = fixYear(m[1]); dateMonth = numToAbbrev(Number(m[2])); day = Number(m[3]) || 1; }
  else if ((m = s.match(/^(\d{1,2})[\s\-\/]([A-Za-z]{3})[A-Za-z]*[\s\-\/,]*(\d{2,4})?/))) {
    dateMonth = monthAbbrevFromText(m[2]); day = Number(m[1]) || 1; year = fixYear(m[3]);
  }
  else if ((m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/))) {
    year = fixYear(m[3]);
    const a = Number(m[1]), b = Number(m[2]);
    let d = order === "MDY" ? b : a, mo = order === "MDY" ? a : b;
    if (colMonth) {                     // let the Month column settle any ambiguity
      const mn = MONTH_NUM[colMonth];
      if (a === mn && b !== mn) { mo = a; d = b; }
      else if (b === mn && a !== mn) { mo = b; d = a; }
    }
    dateMonth = numToAbbrev(mo); day = d || 1;
  }
  return { month: colMonth || dateMonth, day: Math.min(Math.max(day, 1), 31), year };
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
// ---- Date ranges ---------------------------------------------------------
// Two real calendar ranges: current year (CY) and last year (LY). A range is
// {from:{y,m,d}, to:{y,m,d}} with m = 0..11. While a CY range is set the Month
// filter is cleared ("None") and the dates alone decide the data. The LY range
// follows the CY dates minus one year until the user sets it explicitly.
const CAL_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function daysIn(y, m) { return new Date(y, m + 1, 0).getDate(); }
function cmpYMD(a, b) { return (a.y - b.y) || (a.m - b.m) || (a.d - b.d); }
function shiftYMD(p, years) { const y = p.y + years; return { y, m: p.m, d: Math.min(p.d, daysIn(y, p.m)) }; }
function shiftRange(r, years) { return { from: shiftYMD(r.from, years), to: shiftYMD(r.to, years) }; }
function fmtYMD(p) { return `${p.d} ${CAL_ABBR[p.m]} ${p.y}`; }
function dateMode() { return !!state.cyDates; }
function lyIsAuto() { return !!state.cyDates && !state.lyDates; }
function rangeFor(which) {
  if (!state.cyDates) return null;
  if (which === "cy") return state.cyDates;
  return state.lyDates || shiftRange(state.cyDates, -1);
}
function selectionLabel(which) {
  const r = rangeFor(which);
  return r ? `${fmtYMD(r.from)} – ${fmtYMD(r.to)}` : "";
}

// One segment per calendar month a range touches: {y, month, from, to, dim}.
function expandRange(r) {
  const segs = [];
  let y = r.from.y, m = r.from.m;
  while ((y < r.to.y || (y === r.to.y && m <= r.to.m)) && segs.length < 24) {
    const dim = daysIn(y, m);
    segs.push({
      y, month: CAL_ABBR[m], dim,
      from: (y === r.from.y && m === r.from.m) ? r.from.d : 1,
      to: (y === r.to.y && m === r.to.m) ? r.to.d : dim,
    });
    m++; if (m > 11) { m = 0; y++; }
  }
  return segs;
}

// What is in scope for a year: the date range's months (date mode) or the
// whole months ticked in the Month filter (month mode, y = null).
function segmentsFor(which) {
  const r = rangeFor(which);
  if (r) return expandRange(r);
  return selectedMonthsBase().map((m) => ({ y: null, month: m, from: 1, to: 31 }));
}
function activeMonthsFor(which) {
  return Array.from(new Set(segmentsFor(which).map((sg) => sg.month)));
}
function activeMonths() { return activeMonthsFor("cy"); }

function segDays(sg) {
  return Math.max(0, Math.min(sg.to, sg.dim || DAYS_IN_MONTH[sg.month] || 30) - Math.max(sg.from, 1) + 1);
}
// Share of the month's target that a segment covers (1 for a whole month).
function segFrac(sg) {
  const dim = sg.dim || DAYS_IN_MONTH[sg.month] || 30;
  if (sg.from <= 1 && sg.to >= dim) return 1;
  return dayFrac(sg.month, { from: sg.from, to: sg.to });
}
function weekFrac(month, i, r) {
  const [s, e] = weekBounds(month)[i];
  const len = e - s + 1;
  if (len <= 0) return 0;
  const lo = Math.max(s, r.from), hi = Math.min(e, r.to);
  return Math.max(0, hi - lo + 1) / len;
}
function isFullRange(r) { return r.from <= 1 && r.to >= 31; }
function dayFrac(month, r) {
  if (isFullRange(r)) return 1;
  return WEEK_TARGET_SPLIT.reduce((s, w, i) => s + w * weekFrac(month, i, r), 0);
}

function defaultMonthSelection() {
  const latest = state.availableMonths[state.availableMonths.length - 1];
  const q = QUARTERS.find((qq) => qq.key !== "FY" && qq.months.includes(latest));
  return q ? q.months.slice() : [latest];
}
// Latest {y, m} that has sales, for the calendars to open on.
function latestDataMonth(dayRecs) {
  let best = null;
  dayRecs.forEach((d) => {
    if (d.year == null) return;
    const mi = CAL_ABBR.indexOf(d.month);
    if (mi < 0) return;
    const v = d.year * 12 + mi;
    if (best === null || v > best) best = v;
  });
  if (best === null) { const n = new Date(); return { y: n.getFullYear(), m: n.getMonth() }; }
  return { y: Math.floor(best / 12), m: best % 12 };
}

// A calendar click. Seeds a range from the picked date if none exists yet
// (the other edge goes to that month's boundary), keeps From <= To, clears the
// Month filter, and leaves LY following CY unless LY itself was picked.
function pickDate(which, edge, p) {
  let r = rangeFor(which);
  if (!r) {
    r = edge === "from"
      ? { from: p, to: { y: p.y, m: p.m, d: daysIn(p.y, p.m) } }
      : { from: { y: p.y, m: p.m, d: 1 }, to: p };
  } else {
    r = { from: r.from, to: r.to };
    r[edge] = p;
    if (cmpYMD(r.from, r.to) > 0) {
      if (edge === "from") r.to = { y: p.y, m: p.m, d: daysIn(p.y, p.m) };
      else r.from = { y: p.y, m: p.m, d: 1 };
    }
  }
  if (!state.cyDates && state.months.length) state.prevMonths = state.months.slice();
  state.months = [];
  if (which === "cy") state.cyDates = r;
  else { state.lyDates = r; if (!state.cyDates) state.cyDates = shiftRange(r, 1); }
}
// CY reset leaves date mode and restores the month selection; LY reset makes
// LY follow the CY dates again.
function resetDates(which) {
  if (which === "ly") { state.lyDates = null; return; }
  state.cyDates = null; state.lyDates = null;
  if (!state.months.length) state.months = state.prevMonths.length ? state.prevMonths.slice() : defaultMonthSelection();
}
function leaveDateMode() { state.cyDates = null; state.lyDates = null; }

function syncDatePickers() {
  [["day", "cy"]].forEach(([prefix, which]) => {
    const r = rangeFor(which);
    const auto = which === "ly" && lyIsAuto();
    [["From", "from"], ["To", "to"]].forEach(([Id, edge]) => {
      const lab = document.getElementById(prefix + Id + "Label");
      const btn = document.getElementById(prefix + Id + "Btn");
      if (!lab || !btn) return;
      lab.textContent = r ? fmtYMD(r[edge]) : (edge === "from" ? "From" : "To");
      btn.classList.toggle("auto", !!auto);
      btn.title = auto ? "Same dates last year — pick a date to set your own" : "";
    });
  });
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

// Header-name tolerance for the Diwali sale sheets: map common alternative
// column names onto the ones the dashboard uses.
const COL_ALIASES = {
  "Location": /^(location|store( names?)?|outlet|branch|shop)$/i,
  "Salesman": /^(salesman|sales ?man|staff( names?)?|employee|sales person|salesperson)$/i,
  "Bill Date": /^(bill ?date|date|invoice date|sale date)$/i,
  "Bill Code": /^(bill ?(code|no|number)|invoice( no| number)?)$/i,
  "Bill Amount": /^(bill ?amount|amount|net amount|sale( value| amount)?|value)$/i,
  "Net Qty": /^(net ?qty|qty|quantity)$/i,
};
function canonRows(rows) {
  if (!rows.length) return rows;
  const header = Object.keys(rows[0]);
  const map = {};
  Object.entries(COL_ALIASES).forEach(([canon, re]) => {
    if (header.includes(canon)) return;
    const h = header.find((x) => re.test(x.trim()));
    if (h) map[h] = canon;
  });
  if (!Object.keys(map).length) return rows;
  return rows.map((r) => { const o = { ...r }; Object.entries(map).forEach(([h, c]) => { o[c] = r[h]; }); return o; });
}

function buildDayRecords(csvText, forceMonth) {
  let rows = parseRows(csvText);
  if (forceMonth) rows = canonRows(rows);
  const order = detectDateOrder(rows);
  const map = new Map();

  // Special sheets (Diwali) span two calendar months: number the days from the
  // first bill date (1, 2, 3 ...) so they fit the day-based logic.
  let dayBase = null;
  if (forceMonth) {
    const ds = [];
    for (const row of rows) {
      const r = resolveMonthDay(row, order);
      if (r.month) ds.push(Date.UTC(r.year || 2000, (MONTH_NUM[r.month] || 1) - 1, r.day) / 86400000);
    }
    if (ds.length) dayBase = Math.min(...ds);
  }

  for (const row of rows) {
    const store = (row["Location"] || "").trim();
    const staffRaw = (row["Salesman"] || "").trim();
    if (!store || !staffRaw) continue;
    let { month, day, year } = resolveMonthDay(row, order);
    if (!month) continue;
    if (forceMonth) {
      const n = Date.UTC(year || 2000, (MONTH_NUM[month] || 1) - 1, day) / 86400000;
      day = Math.min(Math.max(Math.round(n - dayBase) + 1, 1), 31);
      month = forceMonth;
    }

    const staffKey = normKey(staffRaw);
    const storeKey = normKey(store);
    const k = `${storeKey}||${staffKey}||${month}||${day}||${year || ""}`;
    if (!map.has(k)) {
      map.set(k, {
        store, storeKey, staff: titleCase(staffRaw), staffKey, month, day, year: year || null,
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

// Day records -> one record per Store+Staff+Month, keeping only the days that
// fall inside the given segments (see segmentsFor).
function rollup(dayRecs, staffTargetMap, segs) {
  const byMonth = new Map();
  segs.forEach((sg) => {
    if (!byMonth.has(sg.month)) byMonth.set(sg.month, []);
    byMonth.get(sg.month).push(sg);
  });
  const map = new Map();
  for (const d of dayRecs) {
    const cand = byMonth.get(d.month);
    if (!cand) continue;
    const seg = cand.find((sg) => d.day >= sg.from && d.day <= sg.to && (sg.y == null || d.year == null || d.year === sg.y));
    if (!seg) continue;
    const k = `${d.storeKey}||${d.staffKey}||${d.month}`;
    if (!map.has(k)) {
      map.set(k, {
        store: d.store, storeKey: d.storeKey, staff: d.staff, staffKey: d.staffKey, month: d.month, seg,
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
      t: fullTarget > 0 ? fullTarget * (WEEK_TARGET_SPLIT[i] || 0) * weekFrac(rec.month, i, rec.seg) : 0,
      a: achieved,
    }));
    while (weeks.length > 1) {
      const last = weeks[weeks.length - 1];
      if (last.t === 0 && last.a === 0) weeks.pop(); else break;
    }
    out.push({
      store: rec.store, staff: rec.staff, month: rec.month,
      grossTarget: fullTarget * segFrac(rec.seg),
      totalSales: rec.totalSales,
      qty: rec.qty,
      nob: rec.nob,
      atv: rec.nob > 0 ? rec.totalSales / rec.nob : 0,
      bs: rec.nob > 0 ? rec.qty / rec.nob : 0,
      manDays: rec.days.size,
      totalDays: segDays(rec.seg),
      weeks,
      categories: rec.categories,
      categorySales: rec.categorySales,
    });
  }
  return out;
}

function rebuildRecords() {
  state.records = rollup(state.dayRecords, state.staffTargetMap, segmentsFor("cy"));
  state.archiveRecords = rollup(state.archiveDayRecords, {}, segmentsFor("ly"));
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

// Diwali Target sheet: one lump target per store (optionally per staff and/or
// per category). Columns are found by header name; the Month column, if any,
// is ignored because everything belongs to the "Diwali" pseudo-month.
function buildDiwaliTargets(csvText) {
  const out = { store: {}, staff: {}, category: {} };
  const rows = parseRows(csvText);
  if (!rows.length) return out;
  const header = Object.keys(rows[0]);
  const sc = header.find((h) => /^(store( names?)?|location)$/i.test(h.trim())) || header.find((h) => /store|location/i.test(h) && !/type/i.test(h));
  const tc = header.find((h) => /target/i.test(h) && !/ach/i.test(h)) || header.find((h) => /target/i.test(h));
  const fc = header.find((h) => /staff|salesman|employee/i.test(h));
  const cc = header.find((h) => /categ/i.test(h));
  if (!sc || !tc) return out;
  for (const row of rows) {
    const store = (row[sc] || "").trim();
    if (!store) continue;
    const v = num(row[tc]);
    const sk = normKey(store);
    const staff = fc ? (row[fc] || "").trim() : "";
    const cat = cc ? (row[cc] || "").trim() : "";
    if (cat) {
      const ck = normKey(cat);
      out.category[`${sk}||${ck}||${DIWALI}`] = (out.category[`${sk}||${ck}||${DIWALI}`] || 0) + v;
      out.category.__labels = out.category.__labels || {};
      out.category.__labels[ck] = out.category.__labels[ck] || cat;
      continue;   // a category row is not a store total
    }
    out.store[`${sk}||${DIWALI}`] = (out.store[`${sk}||${DIWALI}`] || 0) + v;
    if (staff) out.staff[`${sk}||${normKey(staff)}||${DIWALI}`] = (out.staff[`${sk}||${normKey(staff)}||${DIWALI}`] || 0) + v;
  }
  return out;
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
    fetchCsv(DIWALI_SALE_URL),
    fetchCsv(DIWALI_SALE_LY_URL),
    fetchCsv(DIWALI_TARGET_URL),
  ]);
  const [staffTargetR, saleR, saleLyR, storeTargetR, storeTargetLyR, categoryTargetR, storeTypeR, diwaliR, diwaliLyR, diwaliTargetR] = results;

  if (seq !== state.loadSeq) return;

  const failed = [];
  state.staffTargetMap = staffTargetR.status === "fulfilled" ? buildStaffTargetMap(staffTargetR.value) : (failed.push("Salesman Target"), {});
  if (saleR.status === "fulfilled") {
    state.dayRecords = buildDayRecords(saleR.value);
  } else failed.push("2026 Sale");

  if (saleLyR.status === "fulfilled") {
    state.archiveDayRecords = buildDayRecords(saleLyR.value);
  } else failed.push("2025 Sale");
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

  // Diwali pseudo-month: its own sale sheets and target sheet, merged in under month "Diwali".
  state.hasDiwali = false;
  try {
    state.dayRecords = state.dayRecords.filter((r) => r.month !== DIWALI);
    state.archiveDayRecords = state.archiveDayRecords.filter((r) => r.month !== DIWALI);
    if (diwaliR.status === "fulfilled") state.dayRecords = state.dayRecords.concat(buildDayRecords(diwaliR.value, DIWALI));
    if (diwaliLyR.status === "fulfilled") state.archiveDayRecords = state.archiveDayRecords.concat(buildDayRecords(diwaliLyR.value, DIWALI));
    if (diwaliTargetR.status === "fulfilled") {
      const dt = buildDiwaliTargets(diwaliTargetR.value);
      Object.assign(state.storeTargets, dt.store);
      Object.assign(state.staffTargetMap, dt.staff);
      if (Object.keys(dt.category).length > 1) {
        state.categoryTargets = Object.assign({}, state.categoryTargets, dt.category, {
          __labels: Object.assign({}, state.categoryTargets.__labels || {}, dt.category.__labels || {}),
        });
        state.hasCategoryTargets = true;
      }
    }
  } catch (e) { console.warn("Diwali sheets:", e); }
  state.hasDiwali = state.dayRecords.some((r) => r.month === DIWALI);
  state.diwaliDiag = [["2026 Diwali", diwaliR], ["2025 Diwali", diwaliLyR], ["Diwali Target", diwaliTargetR]]
    .filter(([, r]) => r.status !== "fulfilled").map(([n]) => n).join(", ");
  if (!state.diwaliDiag && !state.hasDiwali) state.diwaliDiag = "2026 Diwali loaded but has no usable rows";

  state.availableMonths = FY_MONTHS.filter((m) =>
    state.dayRecords.some((r) => r.month === m)
  );
  if (!state.availableMonths.length) state.availableMonths = ["Apr"];

  // Pick the quarter that contains the most recent month with data, and
  // default the Month multi-select to those 3 months — but only on first
  // load (state.months starts empty); once the user has a selection we
  // leave it alone across auto-refreshes.
  if (!state.months.length && !dateMode()) state.months = defaultMonthSelection();
  state.cyView = latestDataMonth(state.dayRecords);
  rebuildRecords();

  state.failedSources = failed;
  state.lastUpdated = new Date();

  if (state.records.length) {
    // A source or two failing (e.g. the optional Category Target sheet)
    // doesn't block the dashboard, so it's still shown as simply "Live" \u2014
    // no alarming "N source(s) failed" text for the viewer.
    setPulse("live", `Live \u00b7 updated ${state.lastUpdated.toLocaleTimeString()}`);
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

  optionsEl.insertAdjacentHTML("beforeend", `
    <label class="ms-option ms-diwali${state.hasDiwali ? "" : " no-data"}">
      <input type="checkbox" value="${DIWALI}" ${state.months.includes(DIWALI) ? "checked" : ""} />
      ${DIWALI}${state.hasDiwali ? "" : " *"}
    </label>`);
  const lg = document.querySelector("#monthMultiPanel .ms-legend");
  if (lg) lg.textContent = "* no data yet" + (!state.hasDiwali && state.diwaliDiag ? " \u2014 could not load: " + state.diwaliDiag : "");
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
  let scoped = state.records;
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
  const months = activeMonthsFor("cy");
  let recs = state.records.filter((r) => months.includes(r.month));
  if (state.stores.length) recs = recs.filter((r) => storeSelectionMatches(r.store));
  if (state.storeType !== "All Types") recs = recs.filter((r) => storeTypeMatches(r.store));
  return recs;
}

function lastYearRecords() {
  const months = activeMonthsFor("ly");
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

// Store-level target over the given segments (or plain month names, meaning
// whole months), prorated for partial months unless prorate = false.
function storeTargetFor(scope, segsOrMonths, prorate = true) {
  const segs = segsOrMonths.map((x) => (typeof x === "string" ? { month: x, from: 1, to: 31 } : x));
  const f = (sg) => (prorate ? segFrac(sg) : 1);
  if (state.stores.length) {
    let sum = 0;
    state.stores.forEach((storeName) => {
      segs.forEach((sg) => { sum += (scope[`${normKey(storeName)}||${sg.month}`] || 0) * f(sg); });
    });
    return sum;
  }
  let sum = 0;
  Object.entries(scope).forEach(([k, v]) => {
    const sep = k.lastIndexOf("||");
    const storeKeyPart = k.slice(0, sep);
    const m = k.slice(sep + 2);
    if (!storeTypeKeyMatches(storeKeyPart)) return;
    segs.forEach((sg) => { if (sg.month === m) sum += v * f(sg); });
  });
  return sum;
}

/* ---------------------------- KPI ---------------------------- */

function calcKPIs(recs, storeTargetScope, segs) {
  const grossTarget = storeTargetFor(storeTargetScope, segs);
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
  const segs = segmentsFor("cy");
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
    target += storeTargetForStore(state.storeTargets, cyByStore.get(k).name, segs);
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
  const days = segmentsFor("cy").reduce((s, sg) => {
    if (sg.month === DIWALI) {   // Diwali has no fixed length: count the days actually traded
      return s + state.dayRecords.reduce((m, r) => (r.month === DIWALI && r.day > m ? r.day : m), 0);
    }
    return s + segDays(sg);
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
function calcWeeklyFromStoreTarget(recs, segs, targetMap = state.storeTargetsLY) {
  return [0, 1, 2, 3, 4].map((i) => {
    let target = 0;
    segs.forEach((sg) => {
      const total = storeTargetFor(targetMap, [sg.month], false);
      if (total > 0) target += total * (WEEK_TARGET_SPLIT[i] || 0) * weekFrac(sg.month, i, sg);
    });
    const achieved = recs.reduce((s, r) => s + (r.weeks[i] ? r.weeks[i].a : 0), 0);
    return { name: `WK ${i + 1}`, target, achieved };
  });
}

// Used instead of calcWeekly when more than one month is in scope: one bar
// per month rather than per-week buckets (weeks from different months aren't
// comparable/summable).
function calcMonthlySplit(recs, months) {
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
function calcMonthlySplitFromStoreTarget(recs, segs) {
  const months = Array.from(new Set(segs.map((sg) => sg.month)));
  return months.map((m) => {
    const rows = recs.filter((r) => r.month === m);
    return {
      name: m,
      target: storeTargetFor(state.storeTargetsLY, segs.filter((sg) => sg.month === m)),
      achieved: rows.reduce((s, r) => s + r.totalSales, 0),
    };
  });
}

// Category table: Target comes from the Category Target sheet, Ach is the
// actual (units or rupees, matching what that sheet measures). Targets are
// summed over the stores/months in scope and prorated for a partial date range.
function calcCategories(recs, lyRecs) {
  const unit = state.categoryUnit;
  const achSource = unit === "value" ? "categorySales" : "categories";
  const labels = (state.categoryTargets && state.categoryTargets.__labels) || {};
  const rows = new Map();   // normalized category -> { category, target, ach, saleValue, lyQty }
  const row = (label) => {
    const k = normKey(label);
    if (!rows.has(k)) rows.set(k, { category: labels[k] || label, target: 0, ach: 0, saleValue: 0, lyQty: 0 });
    return rows.get(k);
  };

  recs.forEach((r) => {
    Object.entries(r[achSource] || {}).forEach(([cat, v]) => { row(cat).ach += v; });
    // Sale value (₹) alongside Qty, regardless of which unit the Ach column is in.
    Object.entries(r.categorySales || {}).forEach(([cat, v]) => { row(cat).saleValue += v; });
  });

  (lyRecs || []).forEach((r) => {
    Object.entries(r.categories || {}).forEach(([cat, v]) => { row(cat).lyQty += v; });
  });

  let anyTarget = false;
  if (state.hasCategoryTargets) {
    const segs = segmentsFor("cy");
    const storeKeys = state.stores.length
      ? state.stores.map(normKey)
      : Array.from(new Set(recs.map((r) => normKey(r.store))));
    const cats = Object.keys(labels);
    storeKeys.forEach((sk) => {
      cats.forEach((ck) => {
        let t = 0, usedMonthly = false;
        segs.forEach((sg) => {
          const exact = state.categoryTargets[`${sk}||${ck}||${sg.month}`];
          if (exact) { t += exact * segFrac(sg); usedMonthly = true; }
        });
        if (!usedMonthly) {
          const any = state.categoryTargets[`${sk}||${ck}||*`];
          if (any) t += any * (segs.length ? segs.reduce((s, sg) => s + segFrac(sg), 0) / segs.length : 1);
        }
        if (t > 0) { row(labels[ck]).target += t; anyTarget = true; }
      });
    });
  }

  const list = Array.from(rows.values())
    .filter((c) => c.target > 0 || c.ach > 0 || c.saleValue > 0 || c.lyQty > 0)
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
        color: PLUM, font: { family: "Cambria, Georgia, serif", weight: "700", size: 10 },
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
        legend: { position: "bottom", labels: { font: { family: "Cambria, Georgia, serif" }, usePointStyle: true } },
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
    (cat.unit === "value" ? "\u20b9 value" : "units") + (dateMode() ? ` \u00b7 ${selectionLabel("cy")} \u00b7 LY ${selectionLabel("ly")}` : "");

  body.innerHTML = cat.list.map((c) => {
    const pct = achievementOf(c.ach, c.target);
    return `
      <tr>
        <td class="store-name">${c.category}</td>
        <td class="num">${c.target > 0 ? f(c.target) : "\u2014"}</td>
        <td class="num">${f(c.ach)}</td>
        <td class="num">${c.target > 0 ? `<span class="pill ${badgeClass(pct)}">${fmtPct(pct)}</span>` : "\u2014"}</td>
        <td class="num">\u20b9${fmtINR(c.saleValue)}</td>
        <td class="num">${c.lyQty > 0 ? fmtNum(c.lyQty) : "\u2014"}</td>
      </tr>`;
  }).join("") || `<tr><td colspan="6" class="num" style="text-align:center;color:var(--muted)">No data in this selection</td></tr>`;

  const tT = cat.list.reduce((s, c) => s + c.target, 0);
  const tA = cat.list.reduce((s, c) => s + c.ach, 0);
  const tSV = cat.list.reduce((s, c) => s + c.saleValue, 0);
  const tLY = cat.list.reduce((s, c) => s + c.lyQty, 0);
  foot.innerHTML = cat.list.length ? `
    <tr class="row-total">
      <td>Total</td>
      <td class="num">${tT > 0 ? f(tT) : "\u2014"}</td>
      <td class="num">${f(tA)}</td>
      <td class="num">${tT > 0 ? fmtPct(achievementOf(tA, tT)) : "\u2014"}</td>
      <td class="num">\u20b9${fmtINR(tSV)}</td>
      <td class="num">${tLY > 0 ? fmtNum(tLY) : "\u2014"}</td>
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
function storeTargetForStore(scope, storeName, segs) {
  const k = normKey(storeName);
  return segs.reduce((sum, sg) => sum + (scope[`${k}||${sg.month}`] || 0) * segFrac(sg), 0);
}

function renderStoreMatrix(recs, lyRecs) {
  const segs = segmentsFor("cy");
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
    const grossTarget = storeTargetForStore(state.storeTargets, m.store, segs);
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
  const cySegs = segmentsFor("cy"), lySegs = segmentsFor("ly");
  const cyMonths = activeMonthsFor("cy");
  const kpis = calcKPIs(scoped, state.storeTargets, cySegs);
  const lyRecs = lastYearRecords();
  const lyKpis = calcKPIs(lyRecs, state.storeTargetsLY, lySegs);
  const l2l = calcL2L(scoped, lyRecs);
  renderKPIs(kpis, lyKpis, l2l);
  renderStoreMatrix(scoped, lyRecs);

  const isMultiMonthView = cyMonths.length > 1;
  document.getElementById("weeklyChartTitle").textContent =
    isMultiMonthView ? "Month-wise target vs achieved" : "Week-wise target vs achieved";
  document.getElementById("weeklyChartNote").textContent =
    dateMode() ? `${selectionLabel("cy")} vs LY ${selectionLabel("ly")}${cySegs.some((sg) => segFrac(sg) < 1) ? " \u00b7 target prorated" : ""}` : "";

  let cySeries, lySeries;
  if (isMultiMonthView) {
    cySeries = calcMonthlySplit(scoped, cyMonths);
    lySeries = calcMonthlySplitFromStoreTarget(lyRecs, lySegs);
    // Pair CY and LY month by month (by position); when the months differ
    // (e.g. Sep vs Aug) the axis label shows both.
    lySeries = cyMonths.map((_, i) => lySeries[i] || { name: "", target: 0, achieved: 0 });
    cySeries = cySeries.map((w, i) => ({
      ...w, name: lySeries[i].name && lySeries[i].name !== w.name ? `${w.name} (LY ${lySeries[i].name})` : w.name,
    }));
  } else {
    cySeries = calcWeekly(scoped, false);
    // FALLBACK: weekly CY target normally comes from the Staff Target sheet.
    // If that sheet has no rows for this month (or names don't match), every
    // week's target is 0 and the Target bars vanish. In that case prorate the
    // store-level target (the same number the "Gross Target" KPI card uses).
    if (cySeries.every((w) => w.target === 0)) {
      cySeries = calcWeeklyFromStoreTarget(scoped, cySegs, state.storeTargets);
    }
    lySeries = calcWeeklyFromStoreTarget(lyRecs, lySegs);
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

  renderCategoryTable(calcCategories(scoped, lyRecs));

  const shown = searchedRecords(scoped);
  const matrixRows = isMultiMonthView ? mergeByStaff(shown) : shown;
  renderMatrix(matrixRows);

  const uniqueStaff = new Set(scoped.map((r) => `${r.store}||${r.staff}`)).size;
  document.getElementById("recordCount").textContent =
    `${uniqueStaff} staff \u00b7 ${new Set(scoped.map((r) => r.store)).size} stores`;
  document.getElementById("footerMonth").textContent =
    dateMode() ? `${selectionLabel("cy")} \u00b7 LY ${selectionLabel("ly")}` : monthsLabel(state.months);
  document.getElementById("footerUpdated").textContent = state.lastUpdated
    ? `\u00b7 last refreshed ${state.lastUpdated.toLocaleString()}`
    : "";
  if (state.lyDiag) {
    document.getElementById("footerUpdated").textContent += ` \u00b7 ${state.lyDiag}`;
  }
  syncDatePickers();
}

/* ---------------------------- calendar day-picker ---------------------------- */

const CAL_WEEKDAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];

function calGridDays(year, month) {
  const first = new Date(year, month, 1);
  const startOffset = (first.getDay() + 6) % 7; // Monday-first
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells = [];
  for (let i = 0; i < startOffset; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);
  return cells;
}

function calYearOptions(selected) {
  const cur = new Date().getFullYear();
  let out = "";
  for (let y = cur - 4; y <= cur + 4; y++) out += `<option value="${y}" ${y === selected ? "selected" : ""}>${y}</option>`;
  return out;
}

// Renders a month-navigable calendar into panelEl. calState = {year, month}
// is mutated as the user navigates. `selected` is the edge this calendar sets
// ({y,m,d} or null), `range` the whole chosen range (shaded), and a click on a
// day calls onPick({y, m, d}).
function renderCalPanel(panelEl, calState, selected, range, onPick) {
  const cells = calGridDays(calState.year, calState.month);
  const today = new Date();
  const ymd = (d) => ({ y: calState.year, m: calState.month, d });
  const isSel = (d) => selected && cmpYMD(ymd(d), selected) === 0;
  const isIn = (d) => range && cmpYMD(ymd(d), range.from) >= 0 && cmpYMD(ymd(d), range.to) <= 0;
  const isToday = (d) => calState.year === today.getFullYear() && calState.month === today.getMonth() && d === today.getDate();

  panelEl.innerHTML = `
    <div class="cal-head">
      <button type="button" class="cal-nav" data-nav="-1" aria-label="Previous month">&lt;</button>
      <select class="cal-month-sel" aria-label="Month"></select>
      <select class="cal-year-sel" aria-label="Year"></select>
      <button type="button" class="cal-nav" data-nav="1" aria-label="Next month">&gt;</button>
    </div>
    <div class="cal-grid cal-weekdays">${CAL_WEEKDAYS.map((w) => `<span>${w}</span>`).join("")}</div>
    <div class="cal-grid cal-days">${cells.map((d) => d
      ? `<button type="button" class="cal-day${isIn(d) ? " in-range" : ""}${isSel(d) ? " selected" : ""}${isToday(d) ? " today" : ""}" data-day="${d}">${d}</button>`
      : `<span class="cal-day cal-blank"></span>`
    ).join("")}</div>
    <div class="cal-foot">Today: ${today.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</div>
  `;

  const monthSel = panelEl.querySelector(".cal-month-sel");
  monthSel.innerHTML = CAL_ABBR.map((m, i) => `<option value="${i}" ${i === calState.month ? "selected" : ""}>${m}</option>`).join("");
  const yearSel = panelEl.querySelector(".cal-year-sel");
  yearSel.innerHTML = calYearOptions(calState.year);

  const redraw = () => renderCalPanel(panelEl, calState, selected, range, onPick);
  panelEl.querySelectorAll(".cal-day[data-day]").forEach((btn) => {
    btn.addEventListener("click", () => onPick(ymd(Number(btn.dataset.day))));
  });
  monthSel.addEventListener("change", (e) => { calState.month = Number(e.target.value); redraw(); });
  yearSel.addEventListener("change", (e) => { calState.year = Number(e.target.value); redraw(); });
  panelEl.querySelectorAll(".cal-nav").forEach((btn) => {
    btn.addEventListener("click", () => {
      calState.month += Number(btn.dataset.nav);
      if (calState.month < 0) { calState.month = 11; calState.year--; }
      if (calState.month > 11) { calState.month = 0; calState.year++; }
      redraw();
    });
  });
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
    rebuildRecords();
    buildStoreOptions();
    render();
  };

  document.getElementById("monthMultiOptions").addEventListener("change", (e) => {
    const cb = e.target;
    if (cb.tagName !== "INPUT") return;
    const m = cb.value;
    leaveDateMode();          // picking a month leaves date mode (the Month filter and dates are exclusive)
    if (cb.checked && m === DIWALI) {
      state.months = [DIWALI];                       // Diwali stands alone, like a month of its own
    } else if (cb.checked) {
      state.months = state.months.filter((x) => x !== DIWALI);
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
    leaveDateMode();
    if (q) state.months = q.months.slice();
    monthsChanged();
  });

  document.getElementById("monthMultiClear").addEventListener("click", () => {
    const latest = state.availableMonths[state.availableMonths.length - 1] || FY_MONTHS[0];
    leaveDateMode();
    state.months = [latest];
    monthsChanged();
  });
  document.getElementById("monthMultiAll").addEventListener("click", () => {
    leaveDateMode();
    state.months = FY_MONTHS.slice();
    monthsChanged();
  });

  // Date-range pickers: CY and LY, each a From/To pair of calendars. Picking
  // any date clears the Month filter ("None") so the dates alone decide the
  // data; LY follows CY minus one year until its own dates are picked.
  const datePickers = [];
  const closeDatePanels = () => datePickers.forEach((pk) => pk.close());
  const refreshAfterDates = () => {
    buildMonthMultiSelect();
    rebuildRecords();
    buildStoreOptions();
    render();
  };

  function wireDatePicker(which, prefix) {
    const el = (id) => document.getElementById(prefix + id);
    const edges = {
      from: { btn: el("FromBtn"), panel: el("FromPanel"), cal: { year: 0, month: 0 } },
      to: { btn: el("ToBtn"), panel: el("ToPanel"), cal: { year: 0, month: 0 } },
    };
    const close = () => Object.values(edges).forEach((e) => {
      e.panel.hidden = true; e.btn.setAttribute("aria-expanded", "false");
    });
    // Open on the picked date if there is one, otherwise on the latest month
    // with sales (LY: the same month a year earlier).
    const viewFor = (edge) => {
      const r = rangeFor(which);
      if (r) return { y: r[edge].y, m: r[edge].m };
      const base = state.cyView || { y: new Date().getFullYear(), m: new Date().getMonth() };
      return which === "cy" ? base : { y: base.y - 1, m: base.m };
    };
    const open = (edge) => {
      const e = edges[edge];
      const v = viewFor(edge);
      e.cal.year = v.y; e.cal.month = v.m;
      const r = rangeFor(which);
      renderCalPanel(e.panel, e.cal, r ? r[edge] : null, r, (p) => {
        pickDate(which, edge, p);
        close();
        refreshAfterDates();
      });
      e.panel.hidden = false; e.btn.setAttribute("aria-expanded", "true");
    };
    ["from", "to"].forEach((edge) => {
      const e = edges[edge];
      e.btn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const willOpen = e.panel.hidden;
        closeDatePanels();
        if (willOpen) open(edge);
      });
      // Clicks inside a calendar must not reach the document-level "click
      // outside" handler: month/year navigation re-renders the panel, which
      // detaches the clicked element and would otherwise look like an outside click.
      e.panel.addEventListener("click", (ev) => ev.stopPropagation());
    });
    el("Reset").addEventListener("click", () => {
      closeDatePanels();
      resetDates(which);
      refreshAfterDates();
    });
    datePickers.push({ close });
  }

  wireDatePicker("cy", "day");
  document.addEventListener("click", closeDatePanels);

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
