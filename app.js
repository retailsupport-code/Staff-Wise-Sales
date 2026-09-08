/* =========================================================================
   Maybell Staff Performance Dashboard
   -------------------------------------------------------------------------
   Data has two sources:
     1. ARCHIVE_DATA (data.min.js) — every closed month, baked in at build
        time from the workbook. This never changes at runtime.
     2. LIVE data — fetched live, every load and every 5 minutes, from the
        published Google Sheet CSV below. This is whichever month is
        currently open for edits/corrections in the sheet.

   IMPORTANT — when the business moves on to a new month in the Google
   Sheet, update LIVE_MONTH_LABEL below to match (e.g. "Oct 26"). That's
   the one line that needs a monthly touch; everything else keeps working.
   ========================================================================= */

const LIVE_CSV_URL = "https://docs.google.com/spreadsheets/d/e/2PACX-1vRbAKbgaXoj-ImKU3td8BIuvi1fM1nXXSXdoD8nTaUQeAISb-xMGb0wp1R1rUcHmzIQFf3XlSb_9yK8/pub?output=csv";
const LIVE_MONTH_LABEL = "Sep 26";
const REFRESH_MS = 5 * 60 * 1000;

const CATEGORY_ORDER = [
  "KURTHA","NIGHTY","SKIRT SET","SKD","ANARKALI","KURTHA PANT",
  "KIDS","YOUNG MOTHER","BOTTOM WEAR","DUPATTA","WL SKD","WL KURTA","OTHERS"
];

let state = {
  records: [],          // archive + live, merged
  liveOk: false,
  liveError: "",
  lastUpdated: null,
  month: LIVE_MONTH_LABEL,
  store: "All Stores",
  sortKey: "totalSales",
  sortDir: "desc",
  search: "",
};

let weeklyChart = null;
let categoryChart = null;

/* ---------------------------- helpers ---------------------------- */

function num(v) {
  if (v === null || v === undefined || v === "") return 0;
  const s = String(v).replace(/,/g, "").replace(/%/g, "").trim();
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

function achievementOf(r) {
  return r.grossTarget > 0 ? (r.totalSales / r.grossTarget) * 100 : (r.totalSales > 0 ? 100 : 0);
}

/* ---------------------------- CSV -> records ---------------------------- */

function parseLiveCsv(csvText) {
  const parsed = Papa.parse(csvText.trim(), { skipEmptyLines: false });
  const rows = parsed.data;
  if (rows.length < 3) throw new Error("Sheet looks empty.");

  const header = rows[1]; // row0 = spacer/week-group labels, row1 = real headers
  const dataRows = rows.slice(2);

  const qtyIdx = header.indexOf("Qty");
  if (qtyIdx === -1) throw new Error("Couldn't find a 'Qty' column in the sheet.");
  const nobIdx = qtyIdx + 1, atvIdx = qtyIdx + 2, bsIdx = qtyIdx + 3;
  const catStart = qtyIdx + 4;
  const weekSpan = qtyIdx - 5;
  const numWeeks = Math.max(0, Math.floor(weekSpan / 3));

  const catCols = [];
  for (let i = catStart; i < header.length; i++) {
    if (header[i] && header[i].trim()) catCols.push([i, header[i].trim()]);
  }

  const records = [];
  for (const row of dataRows) {
    if (!row || row.length <= bsIdx) continue;
    const store = (row[0] || "").trim();
    const staff = (row[1] || "").trim();
    if (!staff || !store) continue;
    const su = store.toUpperCase();
    if (su.startsWith("TOTA") || su.includes("GRAND")) continue;

    const weeks = [];
    for (let wi = 0; wi < 5; wi++) {
      if (wi < numWeeks) {
        const ti = 5 + wi * 3, ai = ti + 1;
        weeks.push({ t: num(row[ti]), a: num(row[ai]) });
      } else {
        weeks.push({ t: 0, a: 0 });
      }
    }

    const categories = {};
    for (const [idx, name] of catCols) categories[name] = num(row[idx]);

    records.push({
      month: LIVE_MONTH_LABEL,
      store, staff,
      grossTarget: num(row[2]),
      totalSales: num(row[3]),
      weeks,
      qty: num(row[qtyIdx]),
      nob: num(row[nobIdx]),
      atv: num(row[atvIdx]),
      bs: num(row[bsIdx]),
      categories,
    });
  }
  return records;
}

/* ---------------------------- data loading ---------------------------- */

async function loadLive() {
  setPulse("loading", "Connecting…");
  try {
    const res = await fetch(LIVE_CSV_URL + "&_=" + Date.now(), { cache: "no-store" });
    if (!res.ok) throw new Error(`Sheet request failed (HTTP ${res.status}).`);
    const text = await res.text();
    if (!text.trim()) throw new Error("Sheet returned no data.");
    const liveRecords = parseLiveCsv(text);
    if (!liveRecords.length) throw new Error("Sheet parsed but no staff rows were found.");

    const archiveMinusLive = (window.ARCHIVE_DATA.records || []).filter(r => r.month !== LIVE_MONTH_LABEL);
    state.records = archiveMinusLive.concat(liveRecords);
    state.liveOk = true;
    state.liveError = "";
    state.lastUpdated = new Date();
    hideError();
    setPulse("live", `Live · updated ${state.lastUpdated.toLocaleTimeString()}`);
  } catch (err) {
    state.liveOk = false;
    state.liveError = err.message || "Unable to load the live sheet.";
    // fall back to whatever archive has for the live month label (may be stale/absent)
    if (!state.records.length) state.records = (window.ARCHIVE_DATA.records || []).slice();
    setPulse("archive", "Showing archive data — live sheet unavailable");
    showError(state.liveError);
  }
  buildMonthOptions();
  buildStoreOptions();
  render();
}

function setPulse(kind, text) {
  const el = document.getElementById("pulse");
  el.className = `pulse pulse-${kind}`;
  el.querySelector(".pulse-text").textContent = text;
}

function showError(msg) {
  document.getElementById("errorBox").hidden = false;
  document.getElementById("errorMsg").textContent = msg;
}
function hideError() {
  document.getElementById("errorBox").hidden = true;
}

/* ---------------------------- filters / options ---------------------------- */

function allMonths() {
  const set = new Set((window.ARCHIVE_DATA.months || []).filter(m => m !== LIVE_MONTH_LABEL));
  set.add(LIVE_MONTH_LABEL);
  // Keep archive's chronological order, with the live month pinned last.
  const ordered = (window.ARCHIVE_DATA.months || []).filter(m => m !== LIVE_MONTH_LABEL);
  ordered.push(LIVE_MONTH_LABEL);
  return ordered;
}

function buildMonthOptions() {
  const sel = document.getElementById("monthSelect");
  const months = allMonths();
  sel.innerHTML = months.map(m =>
    `<option value="${m}" ${m === state.month ? "selected" : ""}>${m}${m === LIVE_MONTH_LABEL ? " (Live)" : ""}</option>`
  ).join("");
}

function buildStoreOptions() {
  const sel = document.getElementById("storeSelect");
  const scoped = state.records.filter(r => r.month === state.month);
  const stores = Array.from(new Set(scoped.map(r => r.store).filter(Boolean))).sort();
  const options = ["All Stores", ...stores];
  if (!options.includes(state.store)) state.store = "All Stores";
  sel.innerHTML = options.map(s =>
    `<option value="${s}" ${s === state.store ? "selected" : ""}>${s}</option>`
  ).join("");
}

function filteredRecords() {
  let recs = state.records.filter(r => r.month === state.month);
  if (state.store !== "All Stores") recs = recs.filter(r => r.store === state.store);
  return recs;
}

function searchedRecords(recs) {
  if (!state.search.trim()) return recs;
  const q = state.search.trim().toLowerCase();
  return recs.filter(r => r.staff.toLowerCase().includes(q) || r.store.toLowerCase().includes(q));
}

/* ---------------------------- KPI ---------------------------- */

function calcKPIs(recs) {
  const grossTarget = recs.reduce((s, r) => s + r.grossTarget, 0);
  const totalSales = recs.reduce((s, r) => s + r.totalSales, 0);
  const qty = recs.reduce((s, r) => s + r.qty, 0);
  const nob = recs.reduce((s, r) => s + r.nob, 0);
  const achievement = grossTarget > 0 ? (totalSales / grossTarget) * 100 : 0;
  const atv = nob > 0 ? totalSales / nob : 0;
  const bs = nob > 0 ? qty / nob : 0;
  return { grossTarget, totalSales, achievement, qty, nob, atv, bs, staffCount: recs.length };
}

function renderKPIs(kpis) {
  const cards = [
    { label: "Gross Target", value: `₹${fmtINR(kpis.grossTarget)}`, sub: "Sum of staff targets" },
    { label: "Total Sales", value: `₹${fmtINR(kpis.totalSales)}`, sub: "Achieved so far" },
    { label: "Achievement", value: fmtPct(kpis.achievement),
      sub: kpis.achievement >= 100 ? "Target achieved" : "Target pending",
      subClass: kpis.achievement >= 100 ? "good" : (kpis.achievement < 70 ? "bad" : "") },
    { label: "Qty", value: fmtNum(kpis.qty), sub: "Units sold" },
    { label: "NOB", value: fmtNum(kpis.nob), sub: "Number of bills" },
    { label: "ATV", value: `₹${fmtINR(kpis.atv)}`, sub: "Avg. transaction value" },
    { label: "Basket Size", value: kpis.bs.toFixed(2), sub: "Qty / NOB" },
  ];
  document.getElementById("kpiRow").innerHTML = cards.map(c => `
    <div class="kpi-card accent">
      <div class="kpi-label">${c.label}</div>
      <div class="kpi-value">${c.value}</div>
      <div class="kpi-sub ${c.subClass || ""}">${c.sub}</div>
    </div>
  `).join("");
}

/* ---------------------------- charts ---------------------------- */

function calcWeekly(recs) {
  const weeks = [0, 1, 2, 3, 4].map(i => {
    const target = recs.reduce((s, r) => s + (r.weeks[i] ? r.weeks[i].t : 0), 0);
    const achieved = recs.reduce((s, r) => s + (r.weeks[i] ? r.weeks[i].a : 0), 0);
    return { name: `WK ${i + 1}`, target, achieved };
  });
  // Drop trailing weeks with no target and no achievement at all (short months).
  while (weeks.length > 1) {
    const last = weeks[weeks.length - 1];
    if (last.target === 0 && last.achieved === 0) weeks.pop(); else break;
  }
  return weeks;
}

function calcCategories(recs) {
  const totals = {};
  CATEGORY_ORDER.forEach(c => totals[c] = 0);
  recs.forEach(r => {
    Object.entries(r.categories || {}).forEach(([k, v]) => {
      totals[k] = (totals[k] || 0) + v;
    });
  });
  return Object.entries(totals)
    .map(([category, qty]) => ({ category, qty }))
    .sort((a, b) => b.qty - a.qty);
}

const PLUM = "#5B2140";
const GOLD = "#B8862E";
const MUTED_GRID = "#E8DFD4";

function renderWeeklyChart(weekly) {
  const ctx = document.getElementById("weeklyChart");
  const data = {
    labels: weekly.map(w => w.name),
    datasets: [
      { label: "Target", data: weekly.map(w => w.target), backgroundColor: MUTED_GRID, borderRadius: 4 },
      { label: "Achieved", data: weekly.map(w => w.achieved), backgroundColor: PLUM, borderRadius: 4 },
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
        tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ₹${fmtINR(c.raw)}` } },
      },
      scales: {
        y: { ticks: { callback: (v) => "₹" + fmtINR(v) }, grid: { color: MUTED_GRID } },
        x: { grid: { display: false } },
      },
    },
  });
}

function renderCategoryChart(categories) {
  const top = categories.filter(c => c.qty > 0).slice(0, 13);
  const ctx = document.getElementById("categoryChart");
  const data = {
    labels: top.map(c => c.category),
    datasets: [{ label: "Qty", data: top.map(c => c.qty), backgroundColor: GOLD, borderRadius: 4 }],
  };
  if (categoryChart) { categoryChart.data = data; categoryChart.update(); return; }
  categoryChart = new Chart(ctx, {
    type: "bar",
    data,
    options: {
      indexAxis: "y",
      responsive: true,
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { color: MUTED_GRID } },
        y: { grid: { display: false } },
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
  const withAch = recs.map(r => ({ ...r, achievement: achievementOf(r) }));
  const sorted = withAch.sort((a, b) => {
    const dir = state.sortDir === "asc" ? 1 : -1;
    const av = a[state.sortKey], bv = b[state.sortKey];
    if (typeof av === "string") return dir * av.localeCompare(bv);
    return dir * ((av || 0) - (bv || 0));
  });

  document.getElementById("matrixBody").innerHTML = sorted.map(r => `
    <tr>
      <td class="store-name">${r.store}</td>
      <td class="staff-name">${r.staff}</td>
      <td class="num">₹${fmtINR(r.grossTarget)}</td>
      <td class="num">₹${fmtINR(r.totalSales)}</td>
      <td class="num"><span class="pill ${badgeClass(r.achievement)}">${fmtPct(r.achievement)}</span></td>
      <td class="num">${fmtNum(r.qty)}</td>
      <td class="num">${fmtNum(r.nob)}</td>
      <td class="num">₹${fmtINR(r.atv)}</td>
      <td class="num">${r.bs.toFixed(2)}</td>
      ${r.weeks.map(w => `<td class="num">${w.t > 0 ? fmtPct((w.a / w.t) * 100) : "—"}</td>`).join("")}
    </tr>
  `).join("");

  document.getElementById("matrixCount").textContent = `${sorted.length} staff record${sorted.length === 1 ? "" : "s"}`;
}

/* ---------------------------- render orchestration ---------------------------- */

function render() {
  const scoped = filteredRecords();
  const kpis = calcKPIs(scoped);
  renderKPIs(kpis);
  renderWeeklyChart(calcWeekly(scoped));
  renderCategoryChart(calcCategories(scoped));
  renderMatrix(searchedRecords(scoped));

  document.getElementById("recordCount").textContent =
    `${scoped.length} staff · ${new Set(scoped.map(r => r.store)).size} stores`;
  document.getElementById("footerMonth").textContent = state.month;
  document.getElementById("footerUpdated").textContent = state.lastUpdated
    ? `· last refreshed ${state.lastUpdated.toLocaleString()}`
    : "";
}

/* ---------------------------- events ---------------------------- */

function wireEvents() {
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
  document.getElementById("refreshBtn").addEventListener("click", loadLive);
  document.getElementById("retryBtn").addEventListener("click", loadLive);

  document.querySelectorAll("#matrixTable th[data-key]").forEach(th => {
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
  state.records = (window.ARCHIVE_DATA.records || []).slice();
  buildMonthOptions();
  buildStoreOptions();
  wireEvents();
  render();
  loadLive();
  setInterval(() => {
    if (state.month === LIVE_MONTH_LABEL) loadLive();
  }, REFRESH_MS);
}

document.addEventListener("DOMContentLoaded", boot);
