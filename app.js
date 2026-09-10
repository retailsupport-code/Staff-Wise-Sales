/* =========================================================================
   Maybell Staff Performance Dashboard
   -------------------------------------------------------------------------
   Data sources:
     1. MONTH_SOURCES — one published Google Sheet CSV per FY month
        (Apr 26 .. Sep 26). All six are fetched live, every load and every
        REFRESH_MS, and merged into state.records. This is the only source
        for what's shown in the dashboard.
     2. window.ARCHIVE_DATA (data.min.js) — the old workbook export. It is
        NOT shown directly anymore; it is only used to look up the SAME
        calendar month a year earlier (e.g. current "Apr 26" -> "Apr 25")
        so the KPI cards can show a last-year comparison.

   IMPORTANT — when the business moves on to a new FY month, add a row to
   MONTH_SOURCES below with its label and published-CSV URL. That's the
   one edit that needs a monthly touch; everything else keeps working.
   ========================================================================= */

const MONTH_SOURCES = [
  { label: "Apr 26", url: "https://docs.google.com/spreadsheets/d/e/2PACX-1vRbAKbgaXoj-ImKU3td8BIuvi1fM1nXXSXdoD8nTaUQeAISb-xMGb0wp1R1rUcHmzIQFf3XlSb_9yK8/pub?gid=306025487&single=true&output=csv" },
  { label: "May 26", url: "https://docs.google.com/spreadsheets/d/e/2PACX-1vRbAKbgaXoj-ImKU3td8BIuvi1fM1nXXSXdoD8nTaUQeAISb-xMGb0wp1R1rUcHmzIQFf3XlSb_9yK8/pub?gid=1865493093&single=true&output=csv" },
  { label: "Jun 26", url: "https://docs.google.com/spreadsheets/d/e/2PACX-1vRbAKbgaXoj-ImKU3td8BIuvi1fM1nXXSXdoD8nTaUQeAISb-xMGb0wp1R1rUcHmzIQFf3XlSb_9yK8/pub?gid=811796791&single=true&output=csv" },
  { label: "Jul 26", url: "https://docs.google.com/spreadsheets/d/e/2PACX-1vRbAKbgaXoj-ImKU3td8BIuvi1fM1nXXSXdoD8nTaUQeAISb-xMGb0wp1R1rUcHmzIQFf3XlSb_9yK8/pub?gid=795183335&single=true&output=csv" },
  { label: "Aug 26", url: "https://docs.google.com/spreadsheets/d/e/2PACX-1vRbAKbgaXoj-ImKU3td8BIuvi1fM1nXXSXdoD8nTaUQeAISb-xMGb0wp1R1rUcHmzIQFf3XlSb_9yK8/pub?gid=1962699760&single=true&output=csv" },
  { label: "Sep 26", url: "https://docs.google.com/spreadsheets/d/e/2PACX-1vRbAKbgaXoj-ImKU3td8BIuvi1fM1nXXSXdoD8nTaUQeAISb-xMGb0wp1R1rUcHmzIQFf3XlSb_9yK8/pub?gid=209340477&single=true&output=csv" },
];

const DEFAULT_MONTH = MONTH_SOURCES[MONTH_SOURCES.length - 1].label; // latest FY month
const REFRESH_MS = 5 * 60 * 1000;

const CATEGORY_ORDER = [
  "KURTHA","NIGHTY","SKIRT SET","SKD","ANARKALI","KURTHA PANT",
  "KIDS","YOUNG MOTHER","BOTTOM WEAR","DUPATTA","WL SKD","WL KURTA","OTHERS"
];

let state = {
  records: [],          // current FY, merged from MONTH_SOURCES only
  archiveRecords: [],   // window.ARCHIVE_DATA — used only for last-year lookups
  loadedMonths: 0,
  failedMonths: [],
  lastUpdated: null,
  loadSeq: 0,            // guards against a slow, stale request overwriting a newer one
  month: DEFAULT_MONTH,
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

function parseMonthCsv(csvText, monthLabel) {
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
    const stu = staff.toUpperCase();
    // Skip subtotal / grand-total rows wherever the "Total" marker lands —
    // some sheets put it in the Store cell, others in the Staff cell
    // (e.g. Store: "EXPRESS AVENUE", Staff: "Total").
    if (su.startsWith("TOTA") || su.includes("GRAND") || su.includes("TOTAL")) continue;
    if (stu.startsWith("TOTA") || stu.includes("GRAND") || stu.includes("TOTAL")) continue;

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
      month: monthLabel,
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

async function loadAll() {
  const seq = ++state.loadSeq;
  const btn = document.getElementById("refreshBtn");
  btn.disabled = true;
  setPulse("loading", "Connecting…");

  const results = await Promise.allSettled(
    MONTH_SOURCES.map(async (src) => {
      const res = await fetch(src.url + "&_=" + Date.now(), { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      if (!text.trim()) throw new Error("No data returned.");
      const recs = parseMonthCsv(text, src.label);
      return { label: src.label, recs };
    })
  );

  if (seq !== state.loadSeq) return; // a newer request already landed — drop this one

  const merged = [];
  const failed = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") {
      merged.push(...r.value.recs);
    } else {
      failed.push(MONTH_SOURCES[i].label);
    }
  });

  if (merged.length) state.records = merged;
  state.loadedMonths = MONTH_SOURCES.length - failed.length;
  state.failedMonths = failed;
  state.lastUpdated = new Date();

  if (failed.length === 0) {
    setPulse("live", `Live · updated ${state.lastUpdated.toLocaleTimeString()}`);
  } else if (merged.length) {
    setPulse("partial", `${state.loadedMonths}/${MONTH_SOURCES.length} months loaded · ${state.lastUpdated.toLocaleTimeString()}`);
  } else {
    setPulse("error", "Couldn't load any month — try Refresh");
  }

  if (seq === state.loadSeq) btn.disabled = false;
  buildStoreOptions();
  render();
}

function setPulse(kind, text) {
  const el = document.getElementById("pulse");
  el.className = `pulse pulse-${kind}`;
  el.querySelector(".pulse-text").textContent = text;
}

/* ---------------------------- filters / options ---------------------------- */

function buildMonthOptions() {
  const sel = document.getElementById("monthSelect");
  sel.innerHTML = MONTH_SOURCES.map(({ label }) =>
    `<option value="${label}" ${label === state.month ? "selected" : ""}>${label}</option>`
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

// Same-calendar-month, one financial year earlier — "Apr 26" -> "Apr 25".
function lastYearLabel(label) {
  const parts = label.split(" ");
  if (parts.length !== 2) return null;
  const [mon, yy] = parts;
  const y = parseInt(yy, 10);
  if (!Number.isFinite(y)) return null;
  return `${mon} ${String(y - 1).padStart(2, "0")}`;
}

function lastYearRecords() {
  const ly = lastYearLabel(state.month);
  if (!ly) return [];
  let recs = state.archiveRecords.filter(r => r.month === ly);
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

// % change for absolute metrics; percentage-point change for the Achievement card.
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
    { label: "Gross Target", value: `₹${fmtINR(kpis.grossTarget)}`, sub: "Sum of staff targets",
      lyValue: hasLY ? `LY ₹${fmtINR(lyKpis.grossTarget)}` : null,
      delta: hasLY ? deltaBadge(kpis.grossTarget, lyKpis.grossTarget) : null },
    { label: "Total Sales", value: `₹${fmtINR(kpis.totalSales)}`, sub: "Achieved so far",
      lyValue: hasLY ? `LY ₹${fmtINR(lyKpis.totalSales)}` : null,
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
    { label: "ATV", value: `₹${fmtINR(kpis.atv)}`, sub: "Avg. transaction value",
      lyValue: hasLY ? `LY ₹${fmtINR(lyKpis.atv)}` : null,
      delta: hasLY ? deltaBadge(kpis.atv, lyKpis.atv) : null },
    { label: "Basket Size", value: kpis.bs.toFixed(2), sub: "Qty / NOB",
      lyValue: hasLY ? `LY ${lyKpis.bs.toFixed(2)}` : null,
      delta: hasLY ? deltaBadge(kpis.bs, lyKpis.bs) : null },
  ];
  document.getElementById("kpiRow").innerHTML = cards.map(c => `
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
      {
        type: "bar",
        label: "Target",
        data: weekly.map(w => w.target),
        backgroundColor: MUTED_GRID,
        borderRadius: 4,
        order: 2,
      },
      {
        type: "line",
        label: "Achieved",
        data: weekly.map(w => w.achieved),
        borderColor: PLUM,
        backgroundColor: PLUM,
        borderWidth: 2.5,
        pointRadius: 4,
        pointHoverRadius: 6,
        pointBackgroundColor: PLUM,
        tension: 0.35,
        fill: false,
        order: 1,
      },
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
  const lyKpis = calcKPIs(lastYearRecords());
  renderKPIs(kpis, lyKpis);
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
  document.getElementById("refreshBtn").addEventListener("click", loadAll);

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
  state.archiveRecords = (window.ARCHIVE_DATA && window.ARCHIVE_DATA.records) || [];
  buildMonthOptions();
  wireEvents();
  loadAll();
  setInterval(loadAll, REFRESH_MS);
}

document.addEventListener("DOMContentLoaded", boot);
