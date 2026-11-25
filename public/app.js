(() => {
  "use strict";

  const state = {
    rawPayload: null,
    version: 0,
    syncedAt: null,
    syncDurationMs: 0,
    pollIntervalSeconds: 15,
    status: "syncing",
    error: null,
    activeTab: "overall",
    selectedMonth: "ALL",
    searchQuery: "",
    overallMatrixMetric: "amount", // "amount" | "qty"
    payrollMatrixMetric: "net",    // "net" | "in" | "out"
    expandedWorkers: new Set(),
    parsed: null,
    pollTimer: null
  };

  // ==================== PARSING & NORMALIZATION ====================

  const SHEETS_EPOCH_MS = Date.UTC(1899, 11, 30);

  function parseSheetDate(val) {
    if (val === null || val === undefined || val === "") return null;
    if (typeof val === "number" && Number.isFinite(val) && val > 20000 && val < 100000) {
      const ms = SHEETS_EPOCH_MS + Math.round(val * 86400000);
      const d = new Date(ms);
      const yyyy = d.getUTCFullYear();
      const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
      const dd = String(d.getUTCDate()).padStart(2, "0");
      return { iso: `${yyyy}-${mm}-${dd}`, month: `${yyyy}-${mm}` };
    }
    const str = String(val).trim();
    // YYYY-MM-DD or YYYY/MM/DD
    const isoMatch = str.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
    if (isoMatch) {
      const yyyy = isoMatch[1];
      const mm = isoMatch[2].padStart(2, "0");
      const dd = isoMatch[3].padStart(2, "0");
      return { iso: `${yyyy}-${mm}-${dd}`, month: `${yyyy}-${mm}` };
    }
    // DD/MM/YYYY or DD-MM-YYYY
    const dmyMatch = str.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})/);
    if (dmyMatch) {
      const dd = dmyMatch[1].padStart(2, "0");
      const mm = dmyMatch[2].padStart(2, "0");
      const yyyy = dmyMatch[3];
      return { iso: `${yyyy}-${mm}-${dd}`, month: `${yyyy}-${mm}` };
    }
    const parsed = new Date(str);
    if (!Number.isNaN(parsed.getTime())) {
      const yyyy = parsed.getFullYear();
      const mm = String(parsed.getMonth() + 1).padStart(2, "0");
      const dd = String(parsed.getDate()).padStart(2, "0");
      return { iso: `${yyyy}-${mm}-${dd}`, month: `${yyyy}-${mm}` };
    }
    return null;
  }

  function parseNumber(val) {
    if (typeof val === "number" && Number.isFinite(val)) return val;
    if (val === null || val === undefined) return 0;
    const cleaned = String(val).replace(/[^0-9.-]/g, "");
    const num = parseFloat(cleaned);
    return Number.isFinite(num) ? num : 0;
  }

  function normalizeCashFlow(val) {
    const s = String(val || "").trim().toLowerCase();
    if (s === "in" || s === "positive" || s === "+") return "In";
    if (s === "out" || s === "negative" || s === "-") return "Out";
    return "";
  }

  function cashFlowSign(flow) {
    if (flow === "In") return 1;
    if (flow === "Out") return -1;
    return 0;
  }

  function parseRateSheet(rows) {
    const list = [];
    const byKey = new Map();
    if (!Array.isArray(rows) || rows.length <= 1) return { list, byKey };

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i] || [];
      const name = String(row[0] ?? "").trim();
      const unit = String(row[1] ?? "").trim();
      const rawPrice = row[2];
      const flow = normalizeCashFlow(row[3]);

      // Ignore empty/stray rows like "." that have no unit/price/cashflow
      if (!name || name === "." || (!unit && (rawPrice === undefined || rawPrice === "") && !flow)) {
        continue;
      }

      const unitPrice = parseNumber(rawPrice);
      const key = name.toLowerCase();
      const item = {
        key,
        name,
        unit: unit || "-",
        unitPrice,
        cashFlow: flow || "In",
        sign: cashFlowSign(flow || "In")
      };
      list.push(item);
      byKey.set(key, item);
    }
    return { list, byKey };
  }

  function countUppercase(str) {
    let count = 0;
    for (let i = 0; i < str.length; i++) {
      const ch = str[i];
      if (ch >= "A" && ch <= "Z") count++;
    }
    return count;
  }

  function buildWorkerCanonicalMap(rawEntries) {
    const variantsByKey = new Map();
    for (const row of rawEntries) {
      const raw = String(row[6] ?? "").trim().replace(/\s+/g, " ");
      const key = (raw || "unknown").toLowerCase();
      if (!variantsByKey.has(key)) variantsByKey.set(key, new Set());
      if (raw) variantsByKey.get(key).add(raw);
    }

    const canonical = new Map();
    for (const [key, variantsSet] of variantsByKey.entries()) {
      const variants = Array.from(variantsSet);
      let display;
      if (key === "sns agro") {
        display = "SNS Agro";
      } else if (key === "unknown" || variants.length === 0) {
        display = "Unknown";
      } else {
        // Pick the best-capitalized variant (e.g. "Ali Bin Ahmad" over "Ali bin ahmad")
        display = variants.slice().sort((a, b) => {
          const diff = countUppercase(b) - countUppercase(a);
          if (diff !== 0) return diff;
          return a.localeCompare(b);
        })[0];
      }
      canonical.set(key, {
        key,
        display,
        variants,
        isCompany: key === "sns agro",
        isUnassigned: key === "unknown"
      });
    }
    return canonical;
  }

  function parseAllData(payload) {
    const sheets = payload.sheets || {};
    const jobTypeRates = parseRateSheet(sheets.jobTypes);
    const upahRates = parseRateSheet(sheets.upah);

    const rawRows = Array.isArray(sheets.completedEntries) ? sheets.completedEntries.slice(1) : [];
    const workerCanonical = buildWorkerCanonicalMap(rawRows);

    const entries = [];
    const monthsSet = new Set();

    for (let i = 0; i < rawRows.length; i++) {
      const r = rawRows[i] || [];
      const jobTypeRaw = String(r[3] ?? "").trim();
      const qty = parseNumber(r[4]);
      const dateInfo = parseSheetDate(r[2]) || parseSheetDate(r[1]);
      if (!jobTypeRaw && qty === 0 && !dateInfo) continue;

      const month = dateInfo ? dateInfo.month : "Unknown";
      const jobDate = dateInfo ? dateInfo.iso : "-";
      if (month !== "Unknown") monthsSet.add(month);

      const jobTypeKey = jobTypeRaw.toLowerCase();
      const workerRaw = String(r[6] ?? "").trim().replace(/\s+/g, " ");
      const workerKey = (workerRaw || "unknown").toLowerCase();
      const workerInfo = workerCanonical.get(workerKey) || {
        key: workerKey,
        display: workerRaw || "Unknown",
        variants: workerRaw ? [workerRaw] : [],
        isCompany: workerKey === "sns agro",
        isUnassigned: workerKey === "unknown"
      };

      const overallRate = jobTypeRates.byKey.get(jobTypeKey) || null;
      const upahRate = upahRates.byKey.get(jobTypeKey) || null;

      const overallUnitPrice = overallRate ? overallRate.unitPrice : 0;
      const overallFlow = overallRate ? overallRate.cashFlow : "";
      const overallSign = overallRate ? overallRate.sign : 0;
      const overallAmount = overallSign * qty * overallUnitPrice;

      const upahUnitPrice = upahRate ? upahRate.unitPrice : 0;
      const upahFlow = upahRate ? upahRate.cashFlow : "";
      const upahSign = upahRate ? upahRate.sign : 0;
      const upahAmount = upahSign * qty * upahUnitPrice;

      entries.push({
        rowNumber: i + 2,
        bankAccount: String(r[0] ?? "").trim(),
        entryDateTime: r[1],
        jobDate,
        month,
        jobType: overallRate ? overallRate.name : (upahRate ? upahRate.name : jobTypeRaw),
        jobTypeKey,
        quantity: qty,
        unit: String(r[5] ?? "").trim() || (overallRate ? overallRate.unit : (upahRate ? upahRate.unit : "-")),
        workerKey: workerInfo.key,
        workerName: workerInfo.display,
        workerRaw: workerRaw || "Unknown",
        isCompany: workerInfo.isCompany,
        isUnassigned: workerInfo.isUnassigned,
        remark: String(r[7] ?? "").trim(),

        // Summary #1 (Job Type)
        overallRate,
        overallUnitPrice,
        overallFlow,
        overallSignedAmount: overallAmount,
        overallUnmapped: !overallRate,

        // Summary #2 (Upah)
        upahRate,
        upahUnitPrice,
        upahFlow,
        upahSignedAmount: upahAmount,
        upahUnmapped: !upahRate
      });
    }

    // Sort entries newest date first
    entries.sort((a, b) => b.jobDate.localeCompare(a.jobDate) || b.rowNumber - a.rowNumber);

    const monthsAsc = Array.from(monthsSet).sort((a, b) => a.localeCompare(b));
    const monthsDesc = monthsAsc.slice().reverse();

    return {
      jobTypeRates,
      upahRates,
      workerCanonical,
      entries,
      monthsAsc,
      monthsDesc
    };
  }

  // ==================== FORMATTING HELPERS ====================

  const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  function formatMonthLabel(ym) {
    if (!ym || ym === "ALL") return "All Months";
    const m = ym.match(/^(\d{4})-(\d{2})$/);
    if (!m) return ym;
    const idx = parseInt(m[2], 10) - 1;
    return `${MONTH_NAMES[idx] || m[2]} ${m[1]}`;
  }

  function formatRM(value, showPlus = false) {
    const n = Number(value) || 0;
    const absStr = Math.abs(n).toLocaleString("en-MY", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
    if (n < -0.004) return `-RM ${absStr}`;
    if (n > 0.004 && showPlus) return `+RM ${absStr}`;
    return `RM ${absStr}`;
  }

  function formatQty(value, unit) {
    const n = Number(value) || 0;
    const u = String(unit || "").toLowerCase();
    if (u === "ton") {
      return n.toLocaleString("en-MY", { minimumFractionDigits: 3, maximumFractionDigits: 3 });
    }
    if (u === "cash") {
      return n.toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }
    if (Math.abs(n - Math.round(n)) < 0.0001) {
      return Math.round(n).toLocaleString("en-MY");
    }
    return n.toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 3 });
  }

  function valClass(n) {
    if (n > 0.004) return "val-pos";
    if (n < -0.004) return "val-neg";
    return "val-zero";
  }

  function escapeHtml(str) {
    return String(str ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function flowBadge(flow) {
    if (flow === "In") return `<span class="badge badge-in">In (+)</span>`;
    if (flow === "Out") return `<span class="badge badge-out">Out (&minus;)</span>`;
    return `<span class="badge badge-warn">Unmapped</span>`;
  }

  function downloadCsv(filename, rows) {
    const csv = rows.map(row =>
      row.map(cell => {
        const s = String(cell ?? "");
        if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
        return s;
      }).join(",")
    ).join("\r\n");

    const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function showToast(message) {
    const container = document.getElementById("toast-container");
    const el = document.createElement("div");
    el.className = "toast";
    el.textContent = message;
    container.appendChild(el);
    setTimeout(() => {
      el.style.opacity = "0";
      el.style.transition = "opacity 0.25s ease";
      setTimeout(() => el.remove(), 260);
    }, 4200);
  }

  // ==================== FILTERING ====================

  function getFilteredEntries(ignoreMonth = false) {
    if (!state.parsed) return [];
    const q = state.searchQuery.trim().toLowerCase();
    return state.parsed.entries.filter(e => {
      if (!ignoreMonth && state.selectedMonth !== "ALL" && e.month !== state.selectedMonth) {
        return false;
      }
      if (q) {
        const hay = `${e.jobType} ${e.workerName} ${e.workerRaw} ${e.remark} ${e.jobDate} ${e.unit}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }

  // ==================== SUMMARY #1: MONTHLY OVERALL REPORT ====================

  function computeOverallSummary() {
    const { jobTypeRates, monthsAsc } = state.parsed;
    const filtered = getFilteredEntries(false);
    const allSearchFiltered = getFilteredEntries(true);

    // Start with ALL job types from Job Type.gsheet in original order
    const rowsMap = new Map();
    for (const jt of jobTypeRates.list) {
      rowsMap.set(jt.key, {
        key: jt.key,
        name: jt.name,
        unit: jt.unit,
        unitPrice: jt.unitPrice,
        cashFlow: jt.cashFlow,
        sign: jt.sign,
        unmapped: false,
        count: 0,
        qty: 0,
        signedAmount: 0,
        entries: [],
        byMonthAmount: Object.fromEntries(monthsAsc.map(m => [m, 0])),
        byMonthQty: Object.fromEntries(monthsAsc.map(m => [m, 0])),
        allMonthsAmount: 0,
        allMonthsQty: 0
      });
    }

    // Include any unmapped job type present in entries so nothing is ever lost
    for (const e of allSearchFiltered) {
      if (!rowsMap.has(e.jobTypeKey)) {
        rowsMap.set(e.jobTypeKey, {
          key: e.jobTypeKey,
          name: e.jobType || "(Blank Job Type)",
          unit: e.unit || "-",
          unitPrice: 0,
          cashFlow: "",
          sign: 0,
          unmapped: true,
          count: 0,
          qty: 0,
          signedAmount: 0,
          entries: [],
          byMonthAmount: Object.fromEntries(monthsAsc.map(m => [m, 0])),
          byMonthQty: Object.fromEntries(monthsAsc.map(m => [m, 0])),
          allMonthsAmount: 0,
          allMonthsQty: 0
        });
      }
      const row = rowsMap.get(e.jobTypeKey);
      if (e.month in row.byMonthAmount) {
        row.byMonthAmount[e.month] += e.overallSignedAmount;
        row.byMonthQty[e.month] += e.quantity;
      }
      row.allMonthsAmount += e.overallSignedAmount;
      row.allMonthsQty += e.quantity;
    }

    let totalIn = 0;
    let totalOut = 0; // stored as negative
    let countIn = 0;
    let countOut = 0;
    let totalTons = 0;
    let totalBags = 0;

    for (const e of filtered) {
      const row = rowsMap.get(e.jobTypeKey);
      if (!row) continue;
      row.count += 1;
      row.qty += e.quantity;
      row.signedAmount += e.overallSignedAmount;
      row.entries.push(e);

      if (e.overallFlow === "In") {
        totalIn += e.overallSignedAmount;
        countIn++;
      } else if (e.overallFlow === "Out") {
        totalOut += e.overallSignedAmount;
        countOut++;
      }
      if (e.unit.toLowerCase() === "ton") totalTons += e.quantity;
      if (e.unit.toLowerCase() === "bag") totalBags += e.quantity;
    }

    const rows = Array.from(rowsMap.values());
    const netTotal = totalIn + totalOut;

    // Monthly totals for chart & matrix footer
    const monthlyTotals = {};
    for (const m of monthsAsc) {
      monthlyTotals[m] = { in: 0, out: 0, net: 0 };
    }
    for (const e of allSearchFiltered) {
      if (!monthlyTotals[e.month]) continue;
      if (e.overallFlow === "In") monthlyTotals[e.month].in += e.overallSignedAmount;
      else if (e.overallFlow === "Out") monthlyTotals[e.month].out += e.overallSignedAmount;
      monthlyTotals[e.month].net += e.overallSignedAmount;
    }

    return {
      rows,
      totalIn,
      totalOut,
      netTotal,
      countIn,
      countOut,
      totalEntries: filtered.length,
      totalTons,
      totalBags,
      monthlyTotals
    };
  }

  function renderOverall() {
    const data = computeOverallSummary();
    const { monthsAsc } = state.parsed;
    const periodLabel = formatMonthLabel(state.selectedMonth);

    document.getElementById("overall-period-label").textContent = periodLabel;
    document.getElementById("overall-table-period").textContent = periodLabel;
    document.getElementById("overall-chart-period").textContent = periodLabel;

    // KPI Cards
    const netClass = data.netTotal >= -0.004 ? "kpi-net-pos" : "kpi-net-neg";
    document.getElementById("overall-kpis").innerHTML = `
      <div class="kpi-card kpi-in">
        <div class="kpi-label">Total Cash Flow In (+)</div>
        <div class="kpi-value val-pos">${formatRM(data.totalIn, true)}</div>
        <div class="kpi-sub">${data.countIn} inflow ${data.countIn === 1 ? "entry" : "entries"}</div>
      </div>
      <div class="kpi-card kpi-out">
        <div class="kpi-label">Total Cash Flow Out (&minus;)</div>
        <div class="kpi-value val-neg">${formatRM(data.totalOut)}</div>
        <div class="kpi-sub">${data.countOut} outflow ${data.countOut === 1 ? "entry" : "entries"}</div>
      </div>
      <div class="kpi-card ${netClass}">
        <div class="kpi-label">Net Overall Cash Flow</div>
        <div class="kpi-value ${valClass(data.netTotal)}">${formatRM(data.netTotal, true)}</div>
        <div class="kpi-sub">In (+) + Out (&minus;) for ${escapeHtml(periodLabel)}</div>
      </div>
      <div class="kpi-card kpi-brand">
        <div class="kpi-label">Field Volume &amp; Activity</div>
        <div class="kpi-value">${data.totalEntries} <span style="font-size:14px;font-weight:600;color:var(--text-muted)">entries</span></div>
        <div class="kpi-sub">${formatQty(data.totalTons, "Ton")} Ton &bull; ${formatQty(data.totalBags, "Bag")} Bag</div>
      </div>
    `;

    // Breakdown Table
    const tbody = document.getElementById("overall-breakdown-body");
    tbody.innerHTML = data.rows.map(r => {
      const denom = r.cashFlow === "In" ? data.totalIn : (r.cashFlow === "Out" ? Math.abs(data.totalOut) : 0);
      const pct = denom > 0 ? (Math.abs(r.signedAmount) / denom) * 100 : 0;
      const zeroClass = r.count === 0 ? "is-zero" : "";
      return `
        <tr class="clickable ${zeroClass}" data-overall-job="${escapeHtml(r.key)}">
          <td>
            <strong>${escapeHtml(r.name)}</strong>
            ${r.unmapped ? ` <span class="badge badge-warn">Not in Job Type sheet</span>` : ""}
          </td>
          <td>${escapeHtml(r.unit)}</td>
          <td class="num">${formatRM(r.unitPrice)}</td>
          <td>${flowBadge(r.cashFlow)}</td>
          <td class="num">${r.count}</td>
          <td class="num">${formatQty(r.qty, r.unit)}</td>
          <td class="num ${valClass(r.signedAmount)}">${formatRM(r.signedAmount, true)}</td>
          <td class="num">${pct.toFixed(1)}%</td>
        </tr>
      `;
    }).join("");

    tbody.querySelectorAll("tr[data-overall-job]").forEach(tr => {
      tr.addEventListener("click", () => {
        const key = tr.getAttribute("data-overall-job");
        const row = data.rows.find(x => x.key === key);
        if (row) openJobTypeDrawer(row, periodLabel);
      });
    });

    document.getElementById("overall-breakdown-foot").innerHTML = `
      <tr>
        <td colspan="4">Total Cash Flow In (+)</td>
        <td class="num">${data.countIn}</td>
        <td class="num">&mdash;</td>
        <td class="num val-pos">${formatRM(data.totalIn, true)}</td>
        <td class="num">100.0%</td>
      </tr>
      <tr>
        <td colspan="4">Total Cash Flow Out (&minus;)</td>
        <td class="num">${data.countOut}</td>
        <td class="num">&mdash;</td>
        <td class="num val-neg">${formatRM(data.totalOut)}</td>
        <td class="num">100.0%</td>
      </tr>
      <tr class="total-net">
        <td colspan="4">Net Overall Cash Flow (${escapeHtml(periodLabel)})</td>
        <td class="num">${data.totalEntries}</td>
        <td class="num">&mdash;</td>
        <td class="num ${valClass(data.netTotal)}">${formatRM(data.netTotal, true)}</td>
        <td class="num">&mdash;</td>
      </tr>
    `;

    // Charts
    renderMonthlyBarChart(
      document.getElementById("overall-monthly-chart"),
      monthsAsc,
      data.monthlyTotals,
      "Inflow (+)",
      "Outflow (−)"
    );
    renderHorizontalContributionChart(
      document.getElementById("overall-jobtype-chart"),
      data.rows.map(r => ({ label: r.name, value: r.signedAmount }))
    );

    // Monthly Matrix Table
    const metric = state.overallMatrixMetric;
    const matrixEl = document.getElementById("overall-matrix-table");
    const monthHeaders = monthsAsc.map(m => {
      const sel = state.selectedMonth === m ? "is-selected" : "";
      return `<th class="num month-col-head ${sel}" data-pick-month="${escapeHtml(m)}" title="Click to filter by ${formatMonthLabel(m)}">${formatMonthLabel(m)}</th>`;
    }).join("");

    let bodyHtml = data.rows.map(r => {
      const cells = monthsAsc.map(m => {
        if (metric === "qty") {
          const q = r.byMonthQty[m] || 0;
          return `<td class="num ${q === 0 ? "val-zero" : ""}">${q === 0 ? "—" : formatQty(q, r.unit)}</td>`;
        }
        const amt = r.byMonthAmount[m] || 0;
        return `<td class="num ${valClass(amt)}">${Math.abs(amt) < 0.004 ? "—" : formatRM(amt, true)}</td>`;
      }).join("");

      const totalCell = metric === "qty"
        ? `<td class="num grand-total-col">${formatQty(r.allMonthsQty, r.unit)} <span style="font-size:11px;color:var(--text-muted)">${escapeHtml(r.unit)}</span></td>`
        : `<td class="num grand-total-col ${valClass(r.allMonthsAmount)}">${formatRM(r.allMonthsAmount, true)}</td>`;

      return `
        <tr>
          <td><strong>${escapeHtml(r.name)}</strong></td>
          <td>${flowBadge(r.cashFlow)}</td>
          <td class="num" style="color:var(--text-muted)">${formatRM(r.unitPrice)} / ${escapeHtml(r.unit)}</td>
          ${cells}
          ${totalCell}
        </tr>
      `;
    }).join("");

    let footHtml = "";
    if (metric === "amount") {
      const grandIn = monthsAsc.reduce((s, m) => s + data.monthlyTotals[m].in, 0);
      const grandOut = monthsAsc.reduce((s, m) => s + data.monthlyTotals[m].out, 0);
      const grandNet = grandIn + grandOut;

      footHtml = `
        <tfoot>
          <tr>
            <td colspan="3">Monthly Inflow (+)</td>
            ${monthsAsc.map(m => `<td class="num val-pos">${formatRM(data.monthlyTotals[m].in, true)}</td>`).join("")}
            <td class="num grand-total-col val-pos">${formatRM(grandIn, true)}</td>
          </tr>
          <tr>
            <td colspan="3">Monthly Outflow (&minus;)</td>
            ${monthsAsc.map(m => `<td class="num val-neg">${formatRM(data.monthlyTotals[m].out)}</td>`).join("")}
            <td class="num grand-total-col val-neg">${formatRM(grandOut)}</td>
          </tr>
          <tr class="total-net">
            <td colspan="3">Monthly Net Cash Flow</td>
            ${monthsAsc.map(m => `<td class="num ${valClass(data.monthlyTotals[m].net)}">${formatRM(data.monthlyTotals[m].net, true)}</td>`).join("")}
            <td class="num grand-total-col ${valClass(grandNet)}">${formatRM(grandNet, true)}</td>
          </tr>
        </tfoot>
      `;
    }

    matrixEl.innerHTML = `
      <thead>
        <tr>
          <th>Job Type</th>
          <th>Flow</th>
          <th class="num">Rate</th>
          ${monthHeaders}
          <th class="num grand-total-col">Grand Total</th>
        </tr>
      </thead>
      <tbody>${bodyHtml}</tbody>
      ${footHtml}
    `;

    matrixEl.querySelectorAll("th[data-pick-month]").forEach(th => {
      th.addEventListener("click", () => {
        const m = th.getAttribute("data-pick-month");
        setSelectedMonth(state.selectedMonth === m ? "ALL" : m);
      });
    });

    // Save export hooks
    state._lastOverallData = data;
  }

  // ==================== SUMMARY #2: MONTHLY PAYROLL REPORT ====================

  function computePayrollSummary() {
    const { monthsAsc, workerCanonical } = state.parsed;
    const filtered = getFilteredEntries(false);
    const allSearchFiltered = getFilteredEntries(true);

    const workersMap = new Map();
    const companyEntriesFiltered = [];
    const companyEntriesAll = [];

    function ensureWorker(e) {
      if (!workersMap.has(e.workerKey)) {
        const info = workerCanonical.get(e.workerKey);
        workersMap.set(e.workerKey, {
          key: e.workerKey,
          name: e.workerName,
          variants: info ? info.variants : [e.workerRaw],
          isUnassigned: e.isUnassigned,
          count: 0,
          inAmount: 0,
          outAmount: 0, // negative
          netAmount: 0,
          entries: [],
          byJobType: new Map(),
          byMonth: Object.fromEntries(monthsAsc.map(m => [m, { in: 0, out: 0, net: 0 }])),
          allMonthsIn: 0,
          allMonthsOut: 0,
          allMonthsNet: 0
        });
      }
      return workersMap.get(e.workerKey);
    }

    // All-months aggregation for matrix
    for (const e of allSearchFiltered) {
      if (e.isCompany) {
        companyEntriesAll.push(e);
        continue;
      }
      const w = ensureWorker(e);
      if (e.month in w.byMonth) {
        if (e.upahFlow === "In") w.byMonth[e.month].in += e.upahSignedAmount;
        else if (e.upahFlow === "Out") w.byMonth[e.month].out += e.upahSignedAmount;
        w.byMonth[e.month].net += e.upahSignedAmount;
      }
      if (e.upahFlow === "In") w.allMonthsIn += e.upahSignedAmount;
      else if (e.upahFlow === "Out") w.allMonthsOut += e.upahSignedAmount;
      w.allMonthsNet += e.upahSignedAmount;
    }

    // Selected-month aggregation
    let totalIn = 0;
    let totalOut = 0;
    let totalEntries = 0;

    for (const e of filtered) {
      if (e.isCompany) {
        companyEntriesFiltered.push(e);
        continue;
      }
      const w = ensureWorker(e);
      w.count += 1;
      w.entries.push(e);
      if (e.upahFlow === "In") {
        w.inAmount += e.upahSignedAmount;
        totalIn += e.upahSignedAmount;
      } else if (e.upahFlow === "Out") {
        w.outAmount += e.upahSignedAmount;
        totalOut += e.upahSignedAmount;
      }
      w.netAmount += e.upahSignedAmount;
      totalEntries++;

      if (!w.byJobType.has(e.jobTypeKey)) {
        w.byJobType.set(e.jobTypeKey, {
          jobType: e.jobType,
          unit: e.unit,
          unitPrice: e.upahUnitPrice,
          cashFlow: e.upahFlow,
          count: 0,
          qty: 0,
          signedAmount: 0
        });
      }
      const jb = w.byJobType.get(e.jobTypeKey);
      jb.count += 1;
      jb.qty += e.quantity;
      jb.signedAmount += e.upahSignedAmount;
    }

    // Sort workers: regular workers by netAmount desc (active first), Unknown at bottom
    const workers = Array.from(workersMap.values()).sort((a, b) => {
      if (a.isUnassigned !== b.isUnassigned) return a.isUnassigned ? 1 : -1;
      if ((b.count > 0) !== (a.count > 0)) return b.count > 0 ? 1 : -1;
      return b.netAmount - a.netAmount || a.name.localeCompare(b.name);
    });

    const activeWorkers = workers.filter(w => w.count > 0 && !w.isUnassigned).length;
    const totalNet = totalIn + totalOut;

    const monthlyTotals = {};
    for (const m of monthsAsc) {
      monthlyTotals[m] = { in: 0, out: 0, net: 0 };
    }
    for (const w of workers) {
      for (const m of monthsAsc) {
        monthlyTotals[m].in += w.byMonth[m].in;
        monthlyTotals[m].out += w.byMonth[m].out;
        monthlyTotals[m].net += w.byMonth[m].net;
      }
    }

    const companyTotalFiltered = companyEntriesFiltered.reduce((s, e) => s + e.upahSignedAmount, 0);

    return {
      workers,
      activeWorkers,
      totalEntries,
      totalIn,
      totalOut,
      totalNet,
      monthlyTotals,
      companyEntriesFiltered,
      companyEntriesAll,
      companyTotalFiltered
    };
  }

  function renderPayroll() {
    const data = computePayrollSummary();
    const { monthsAsc } = state.parsed;
    const periodLabel = formatMonthLabel(state.selectedMonth);

    document.getElementById("payroll-period-label").textContent = periodLabel;
    document.getElementById("payroll-table-period").textContent = periodLabel;
    document.getElementById("payroll-chart-period").textContent = periodLabel;

    // KPI Cards
    const netClass = data.totalNet >= -0.004 ? "kpi-net-pos" : "kpi-net-neg";
    document.getElementById("payroll-kpis").innerHTML = `
      <div class="kpi-card kpi-in">
        <div class="kpi-label">Worker Earnings / In (+)</div>
        <div class="kpi-value val-pos">${formatRM(data.totalIn, true)}</div>
        <div class="kpi-sub">Based on Upah.gsheet rates</div>
      </div>
      <div class="kpi-card kpi-out">
        <div class="kpi-label">Advances &amp; Deductions / Out (&minus;)</div>
        <div class="kpi-value val-neg">${formatRM(data.totalOut)}</div>
        <div class="kpi-sub">Cash Advances &amp; Salary Out</div>
      </div>
      <div class="kpi-card ${netClass}">
        <div class="kpi-label">Net Payroll Payable</div>
        <div class="kpi-value ${valClass(data.totalNet)}">${formatRM(data.totalNet, true)}</div>
        <div class="kpi-sub">Workers only (${escapeHtml(periodLabel)})</div>
      </div>
      <div class="kpi-card kpi-brand">
        <div class="kpi-label">Active Workers</div>
        <div class="kpi-value">${data.activeWorkers} <span style="font-size:14px;font-weight:600;color:var(--text-muted)">workers</span></div>
        <div class="kpi-sub">${data.totalEntries} entries &bull; SNS Agro (${formatRM(data.companyTotalFiltered)}) excl.</div>
      </div>
    `;

    // Workers Table
    const tbody = document.getElementById("payroll-workers-body");
    const displayWorkers = data.workers.filter(w => state.selectedMonth === "ALL" ? true : w.count > 0);

    if (displayWorkers.length === 0) {
      tbody.innerHTML = `<tr><td colspan="7" class="empty-state">No worker payroll entries found for ${escapeHtml(periodLabel)}.</td></tr>`;
    } else {
      let html = "";
      for (const w of displayWorkers) {
        const isExpanded = state.expandedWorkers.has(w.key);
        const jobs = Array.from(w.byJobType.values());
        const chipsHtml = jobs.map(j => {
          const cls = j.cashFlow === "Out" ? "chip-out" : "chip-in";
          return `<span class="job-chip ${cls}">${escapeHtml(j.jobType)}: ${formatQty(j.qty, j.unit)} ${escapeHtml(j.unit)}</span>`;
        }).join("");

        const mergedHint = w.variants.length > 1
          ? `<span class="merged-hint" title="Merged case variations: ${escapeHtml(w.variants.join(" / "))}">Merged ${w.variants.length} name variants</span>`
          : "";

        html += `
          <tr class="clickable ${isExpanded ? "is-expanded" : ""}" data-worker-key="${escapeHtml(w.key)}">
            <td><span class="expand-caret">&#9656;</span></td>
            <td>
              <strong>${escapeHtml(w.name)}</strong>
              ${w.isUnassigned ? ` <span class="badge badge-warn">Unassigned</span>` : ""}
              ${mergedHint}
            </td>
            <td class="num">${w.count}</td>
            <td><div class="job-chips">${chipsHtml || '<span class="val-zero">—</span>'}</div></td>
            <td class="num ${valClass(w.inAmount)}">${formatRM(w.inAmount, true)}</td>
            <td class="num ${valClass(w.outAmount)}">${formatRM(w.outAmount)}</td>
            <td class="num ${valClass(w.netAmount)}">${formatRM(w.netAmount, true)}</td>
          </tr>
        `;

        if (isExpanded) {
          const detailRows = jobs.map(j => `
            <tr>
              <td><strong>${escapeHtml(j.jobType)}</strong></td>
              <td>${escapeHtml(j.unit)}</td>
              <td class="num">${formatRM(j.unitPrice)}</td>
              <td>${flowBadge(j.cashFlow)}</td>
              <td class="num">${j.count}</td>
              <td class="num">${formatQty(j.qty, j.unit)}</td>
              <td class="num ${valClass(j.signedAmount)}">${formatRM(j.signedAmount, true)}</td>
            </tr>
          `).join("");

          html += `
            <tr class="worker-detail-row">
              <td colspan="7">
                <div class="worker-detail-panel">
                  <div class="worker-detail-bar">
                    <h4>${escapeHtml(w.name)} &mdash; Job Breakdown (${escapeHtml(periodLabel)})</h4>
                    <div style="display:flex;gap:8px;">
                      <button class="btn btn-outline btn-sm" type="button" data-open-worker-drawer="${escapeHtml(w.key)}">View All ${w.count} Entries</button>
                      <button class="btn btn-outline btn-sm" type="button" data-print-payslip="${escapeHtml(w.key)}">Print Payslip</button>
                    </div>
                  </div>
                  <table class="mini-table">
                    <thead>
                      <tr>
                        <th>Job Type</th>
                        <th>Unit</th>
                        <th class="num">Upah Rate</th>
                        <th>Cash Flow</th>
                        <th class="num">Entries</th>
                        <th class="num">Total Qty</th>
                        <th class="num">Signed Amount (RM)</th>
                      </tr>
                    </thead>
                    <tbody>${detailRows}</tbody>
                  </table>
                </div>
              </td>
            </tr>
          `;
        }
      }
      tbody.innerHTML = html;

      tbody.querySelectorAll("tr[data-worker-key]").forEach(tr => {
        tr.addEventListener("click", () => {
          const key = tr.getAttribute("data-worker-key");
          if (state.expandedWorkers.has(key)) state.expandedWorkers.delete(key);
          else state.expandedWorkers.add(key);
          renderPayroll();
        });
      });

      tbody.querySelectorAll("button[data-open-worker-drawer]").forEach(btn => {
        btn.addEventListener("click", (ev) => {
          ev.stopPropagation();
          const key = btn.getAttribute("data-open-worker-drawer");
          const worker = data.workers.find(x => x.key === key);
          if (worker) openWorkerDrawer(worker, periodLabel);
        });
      });

      tbody.querySelectorAll("button[data-print-payslip]").forEach(btn => {
        btn.addEventListener("click", (ev) => {
          ev.stopPropagation();
          const key = btn.getAttribute("data-print-payslip");
          const worker = data.workers.find(x => x.key === key);
          if (worker) printWorkerPayslip(worker, periodLabel);
        });
      });
    }

    document.getElementById("payroll-workers-foot").innerHTML = `
      <tr class="total-net">
        <td></td>
        <td>Total Worker Payroll (${escapeHtml(periodLabel)})</td>
        <td class="num">${data.totalEntries}</td>
        <td>${data.activeWorkers} active workers</td>
        <td class="num val-pos">${formatRM(data.totalIn, true)}</td>
        <td class="num val-neg">${formatRM(data.totalOut)}</td>
        <td class="num ${valClass(data.totalNet)}">${formatRM(data.totalNet, true)}</td>
      </tr>
    `;

    // Charts
    renderHorizontalContributionChart(
      document.getElementById("payroll-worker-chart"),
      displayWorkers.map(w => ({ label: w.name, value: w.netAmount }))
    );
    renderMonthlyBarChart(
      document.getElementById("payroll-monthly-chart"),
      monthsAsc,
      data.monthlyTotals,
      "Earnings (+)",
      "Deductions (−)"
    );

    // Monthly Payroll Matrix (Workers x Months)
    const metric = state.payrollMatrixMetric;
    const matrixEl = document.getElementById("payroll-matrix-table");
    const monthHeaders = monthsAsc.map(m => {
      const sel = state.selectedMonth === m ? "is-selected" : "";
      return `<th class="num month-col-head ${sel}" data-pick-month="${escapeHtml(m)}" title="Click to filter by ${formatMonthLabel(m)}">${formatMonthLabel(m)}</th>`;
    }).join("");

    const matrixRowsHtml = data.workers.map(w => {
      const cells = monthsAsc.map(m => {
        const val = w.byMonth[m][metric] || 0;
        return `<td class="num ${valClass(val)}">${Math.abs(val) < 0.004 ? "—" : formatRM(val, true)}</td>`;
      }).join("");
      const grand = metric === "in" ? w.allMonthsIn : (metric === "out" ? w.allMonthsOut : w.allMonthsNet);
      return `
        <tr>
          <td>
            <strong>${escapeHtml(w.name)}</strong>
            ${w.isUnassigned ? ` <span class="badge badge-warn">Unassigned</span>` : ""}
          </td>
          ${cells}
          <td class="num grand-total-col ${valClass(grand)}">${formatRM(grand, true)}</td>
        </tr>
      `;
    }).join("");

    const grandAll = monthsAsc.reduce((s, m) => s + data.monthlyTotals[m][metric], 0);
    const metricLabel = metric === "in" ? "Total Earnings (+)" : (metric === "out" ? "Total Deductions (−)" : "Total Net Payroll");

    matrixEl.innerHTML = `
      <thead>
        <tr>
          <th>Worker Name</th>
          ${monthHeaders}
          <th class="num grand-total-col">Grand Total</th>
        </tr>
      </thead>
      <tbody>${matrixRowsHtml || `<tr><td colspan="${monthsAsc.length + 2}" class="empty-state">No worker data</td></tr>`}</tbody>
      <tfoot>
        <tr class="total-net">
          <td>${metricLabel}</td>
          ${monthsAsc.map(m => {
            const v = data.monthlyTotals[m][metric];
            return `<td class="num ${valClass(v)}">${formatRM(v, true)}</td>`;
          }).join("")}
          <td class="num grand-total-col ${valClass(grandAll)}">${formatRM(grandAll, true)}</td>
        </tr>
      </tfoot>
    `;

    matrixEl.querySelectorAll("th[data-pick-month]").forEach(th => {
      th.addEventListener("click", () => {
        const m = th.getAttribute("data-pick-month");
        setSelectedMonth(state.selectedMonth === m ? "ALL" : m);
      });
    });

    // Company / Non-Worker (SNS Agro) Separate Card
    const companyBadge = document.getElementById("company-total-badge");
    companyBadge.className = `company-total-badge ${valClass(data.companyTotalFiltered)}`;
    companyBadge.textContent = `${formatRM(data.companyTotalFiltered, true)} (${data.companyEntriesFiltered.length} entries)`;

    const companyBody = document.getElementById("company-table-body");
    if (data.companyEntriesFiltered.length === 0) {
      companyBody.innerHTML = `<tr><td colspan="8" class="empty-state">No SNS Agro company entries in ${escapeHtml(periodLabel)}.</td></tr>`;
    } else {
      companyBody.innerHTML = data.companyEntriesFiltered.map(e => `
        <tr>
          <td>${escapeHtml(e.jobDate)}</td>
          <td>${formatMonthLabel(e.month)}</td>
          <td><strong>${escapeHtml(e.jobType)}</strong></td>
          <td class="num">${formatQty(e.quantity, e.unit)}</td>
          <td>${escapeHtml(e.unit)}</td>
          <td>${flowBadge(e.upahFlow)}</td>
          <td class="num ${valClass(e.upahSignedAmount)}">${formatRM(e.upahSignedAmount, true)}</td>
          <td>${escapeHtml(e.remark || "—")}</td>
        </tr>
      `).join("");
    }

    state._lastPayrollData = data;
  }

  // ==================== TAB 3: LIVE DATA & RATE CARDS ====================

  function renderDataTab() {
    const { jobTypeRates, upahRates } = state.parsed;
    const filtered = getFilteredEntries(false);

    document.getElementById("entries-count-badge").textContent = String(state.parsed.entries.length);
    document.getElementById("raw-table-count").textContent = `${filtered.length} of ${state.parsed.entries.length} entries`;

    document.getElementById("rate-jobtype-body").innerHTML = jobTypeRates.list.map(r => `
      <tr>
        <td><strong>${escapeHtml(r.name)}</strong></td>
        <td>${escapeHtml(r.unit)}</td>
        <td class="num">${formatRM(r.unitPrice)}</td>
        <td>${flowBadge(r.cashFlow)}</td>
      </tr>
    `).join("");

    document.getElementById("rate-upah-body").innerHTML = upahRates.list.map(r => `
      <tr>
        <td><strong>${escapeHtml(r.name)}</strong></td>
        <td>${escapeHtml(r.unit)}</td>
        <td class="num">${formatRM(r.unitPrice)}</td>
        <td>${flowBadge(r.cashFlow)}</td>
      </tr>
    `).join("");

    document.getElementById("raw-entries-body").innerHTML = filtered.map(e => `
      <tr>
        <td>${escapeHtml(e.jobDate)}</td>
        <td>${formatMonthLabel(e.month)}</td>
        <td><strong>${escapeHtml(e.jobType)}</strong></td>
        <td>
          ${escapeHtml(e.workerName)}
          ${e.isCompany ? ` <span class="badge badge-neutral">Company</span>` : ""}
          ${e.isUnassigned ? ` <span class="badge badge-warn">Unassigned</span>` : ""}
        </td>
        <td class="num">${formatQty(e.quantity, e.unit)}</td>
        <td>${escapeHtml(e.unit)}</td>
        <td class="num ${valClass(e.overallSignedAmount)}">${formatRM(e.overallSignedAmount, true)}</td>
        <td class="num ${valClass(e.upahSignedAmount)}">${formatRM(e.upahSignedAmount, true)}</td>
        <td>${escapeHtml(e.remark || "—")}</td>
      </tr>
    `).join("") || `<tr><td colspan="9" class="empty-state">No matching entries.</td></tr>`;
  }

  // ==================== SVG CHARTS ====================

  function renderMonthlyBarChart(container, months, totalsByMonth, inLabel, outLabel) {
    if (!months.length) {
      container.innerHTML = `<div class="empty-state">No monthly data available yet.</div>`;
      return;
    }

    const width = 560;
    const height = 210;
    const pad = { top: 18, right: 16, bottom: 34, left: 68 };
    const plotW = width - pad.left - pad.right;
    const plotH = height - pad.top - pad.bottom;

    let maxVal = 100;
    for (const m of months) {
      const t = totalsByMonth[m];
      maxVal = Math.max(maxVal, t.in, Math.abs(t.out), Math.abs(t.net));
    }
    maxVal = Math.ceil(maxVal * 1.15);

    const groupW = plotW / months.length;
    const barW = Math.min(34, Math.max(12, groupW * 0.28));

    const yFor = v => pad.top + plotH - (v / maxVal) * plotH;

    let gridLines = "";
    for (let i = 0; i <= 4; i++) {
      const v = (maxVal / 4) * i;
      const y = yFor(v);
      gridLines += `
        <line x1="${pad.left}" y1="${y}" x2="${width - pad.right}" y2="${y}" stroke="#e7ece2" stroke-width="1"/>
        <text x="${pad.left - 8}" y="${y + 4}" text-anchor="end" font-size="10.5" fill="#6b7c71">${Math.round(v).toLocaleString()}</text>
      `;
    }

    let bars = "";
    months.forEach((m, idx) => {
      const t = totalsByMonth[m];
      const cx = pad.left + idx * groupW + groupW / 2;
      const inH = (t.in / maxVal) * plotH;
      const outH = (Math.abs(t.out) / maxVal) * plotH;
      const inY = pad.top + plotH - inH;
      const outY = pad.top + plotH - outH;

      bars += `
        <g>
          <rect x="${cx - barW - 2}" y="${inY}" width="${barW}" height="${Math.max(0, inH)}" rx="4" fill="#15803d">
            <title>${formatMonthLabel(m)} ${inLabel}: ${formatRM(t.in, true)}</title>
          </rect>
          <rect x="${cx + 2}" y="${outY}" width="${barW}" height="${Math.max(0, outH)}" rx="4" fill="#dc2626">
            <title>${formatMonthLabel(m)} ${outLabel}: ${formatRM(t.out)}</title>
          </rect>
          <text x="${cx}" y="${height - 12}" text-anchor="middle" font-size="11.5" font-weight="600" fill="#33443a">${formatMonthLabel(m)}</text>
        </g>
      `;
    });

    container.innerHTML = `
      <div class="chart-legend">
        <span><span class="legend-dot" style="background:#15803d"></span>${inLabel}</span>
        <span><span class="legend-dot" style="background:#dc2626"></span>${outLabel} (magnitude)</span>
      </div>
      <svg viewBox="0 0 ${width} ${height}" style="width:100%;height:auto;display:block;">
        ${gridLines}
        ${bars}
      </svg>
    `;
  }

  function renderHorizontalContributionChart(container, items) {
    const active = items.filter(i => Math.abs(i.value) >= 0.005);
    if (!active.length) {
      container.innerHTML = `<div class="empty-state">No non-zero values for this period.</div>`;
      return;
    }

    const sorted = active.slice().sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
    const maxAbs = Math.max(...sorted.map(i => Math.abs(i.value)), 1);

    container.innerHTML = `
      <div class="hbar-list">
        ${sorted.map(item => {
          const pct = Math.max(2, (Math.abs(item.value) / maxAbs) * 100);
          const cls = item.value >= 0 ? "fill-in" : "fill-out";
          return `
            <div class="hbar-item">
              <div class="hbar-name" title="${escapeHtml(item.label)}">${escapeHtml(item.label)}</div>
              <div class="hbar-track"><div class="hbar-fill ${cls}" style="width:${pct.toFixed(1)}%"></div></div>
              <div class="num ${valClass(item.value)}">${formatRM(item.value, true)}</div>
            </div>
          `;
        }).join("")}
      </div>
    `;
  }

  // ==================== DRILL-DOWN DRAWER & PAYSLIP ====================

  function openJobTypeDrawer(row, periodLabel) {
    const drawer = document.getElementById("drawer");
    const backdrop = document.getElementById("drawer-backdrop");
    document.getElementById("drawer-eyebrow").textContent = "Summary #1 • Job Type Drill-Down";
    document.getElementById("drawer-title").textContent = row.name;
    document.getElementById("drawer-sub").textContent = `${periodLabel} • Rate: ${formatRM(row.unitPrice)} / ${row.unit} • Cash Flow: ${row.cashFlow || "Unmapped"}`;
    document.getElementById("drawer-print-btn").classList.add("hidden");

    document.getElementById("drawer-kpis").innerHTML = `
      <div class="drawer-kpi">
        <div class="drawer-kpi-label">Entries</div>
        <div class="drawer-kpi-val">${row.count}</div>
      </div>
      <div class="drawer-kpi">
        <div class="drawer-kpi-label">Total Qty (${escapeHtml(row.unit)})</div>
        <div class="drawer-kpi-val">${formatQty(row.qty, row.unit)}</div>
      </div>
      <div class="drawer-kpi">
        <div class="drawer-kpi-label">Signed Amount</div>
        <div class="drawer-kpi-val ${valClass(row.signedAmount)}">${formatRM(row.signedAmount, true)}</div>
      </div>
    `;

    document.getElementById("drawer-body").innerHTML = row.entries.length === 0
      ? `<div class="empty-state">No entries recorded for <strong>${escapeHtml(row.name)}</strong> in ${escapeHtml(periodLabel)}.</div>`
      : `
        <table class="data-table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Worker / Entity</th>
              <th class="num">Qty</th>
              <th class="num">Signed Amount</th>
              <th>Remark</th>
            </tr>
          </thead>
          <tbody>
            ${row.entries.map(e => `
              <tr>
                <td>${escapeHtml(e.jobDate)}</td>
                <td>${escapeHtml(e.workerName)}</td>
                <td class="num">${formatQty(e.quantity, e.unit)} ${escapeHtml(e.unit)}</td>
                <td class="num ${valClass(e.overallSignedAmount)}">${formatRM(e.overallSignedAmount, true)}</td>
                <td>${escapeHtml(e.remark || "—")}</td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      `;

    drawer.classList.remove("hidden");
    backdrop.classList.remove("hidden");
  }

  function openWorkerDrawer(worker, periodLabel) {
    const drawer = document.getElementById("drawer");
    const backdrop = document.getElementById("drawer-backdrop");
    document.getElementById("drawer-eyebrow").textContent = "Summary #2 • Worker Payroll Ledger";
    document.getElementById("drawer-title").textContent = worker.name;
    document.getElementById("drawer-sub").textContent = `${periodLabel} • ${worker.count} entries • Calculated using Upah.gsheet rates`;

    const printBtn = document.getElementById("drawer-print-btn");
    printBtn.classList.remove("hidden");
    printBtn.onclick = () => printWorkerPayslip(worker, periodLabel);

    document.getElementById("drawer-kpis").innerHTML = `
      <div class="drawer-kpi">
        <div class="drawer-kpi-label">Earnings / In (+)</div>
        <div class="drawer-kpi-val val-pos">${formatRM(worker.inAmount, true)}</div>
      </div>
      <div class="drawer-kpi">
        <div class="drawer-kpi-label">Deductions / Out (&minus;)</div>
        <div class="drawer-kpi-val val-neg">${formatRM(worker.outAmount)}</div>
      </div>
      <div class="drawer-kpi">
        <div class="drawer-kpi-label">Net Payable</div>
        <div class="drawer-kpi-val ${valClass(worker.netAmount)}">${formatRM(worker.netAmount, true)}</div>
      </div>
    `;

    document.getElementById("drawer-body").innerHTML = `
      <table class="data-table">
        <thead>
          <tr>
            <th>Date</th>
            <th>Job Type</th>
            <th class="num">Qty</th>
            <th class="num">Upah Rate</th>
            <th>Flow</th>
            <th class="num">Signed Amount</th>
            <th>Remark</th>
          </tr>
        </thead>
        <tbody>
          ${worker.entries.map(e => `
            <tr>
              <td>${escapeHtml(e.jobDate)}</td>
              <td><strong>${escapeHtml(e.jobType)}</strong></td>
              <td class="num">${formatQty(e.quantity, e.unit)} ${escapeHtml(e.unit)}</td>
              <td class="num">${formatRM(e.upahUnitPrice)}</td>
              <td>${flowBadge(e.upahFlow)}</td>
              <td class="num ${valClass(e.upahSignedAmount)}">${formatRM(e.upahSignedAmount, true)}</td>
              <td>${escapeHtml(e.remark || "—")}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    `;

    drawer.classList.remove("hidden");
    backdrop.classList.remove("hidden");
  }

  function closeDrawer() {
    document.getElementById("drawer").classList.add("hidden");
    document.getElementById("drawer-backdrop").classList.add("hidden");
  }

  function printWorkerPayslip(worker, periodLabel) {
    const jobs = Array.from(worker.byJobType.values());
    const win = window.open("", "_blank", "width=820,height=900");
    if (!win) {
      showToast("Pop-up blocked — allow pop-ups to print payslip.");
      return;
    }
    win.document.write(`
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8" />
        <title>Payslip - ${escapeHtml(worker.name)} (${escapeHtml(periodLabel)})</title>
        <style>
          body { font-family: "Segoe UI", Arial, sans-serif; color: #16221b; padding: 28px; max-width: 760px; margin: 0 auto; }
          .head { display: flex; justify-content: space-between; border-bottom: 2px solid #14532d; padding-bottom: 12px; margin-bottom: 18px; }
          h1 { margin: 0; font-size: 20px; color: #14532d; }
          .meta { font-size: 13px; color: #55665c; margin-top: 4px; }
          .summary { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-bottom: 20px; }
          .box { border: 1px solid #d5ddd0; border-radius: 8px; padding: 12px; }
          .box-label { font-size: 11px; text-transform: uppercase; color: #55665c; font-weight: 700; }
          .box-val { font-size: 18px; font-weight: 800; margin-top: 4px; }
          .pos { color: #0d7a47; } .neg { color: #c22b3e; }
          table { width: 100%; border-collapse: collapse; margin-bottom: 20px; font-size: 13px; }
          th, td { border-bottom: 1px solid #e2e7dd; padding: 8px 10px; text-align: left; }
          th { background: #f4f7f1; font-size: 11px; text-transform: uppercase; }
          .num { text-align: right; font-variant-numeric: tabular-nums; }
          h2 { font-size: 14px; margin: 18px 0 8px; color: #14532d; text-transform: uppercase; letter-spacing: 0.04em; }
          @media print { button { display: none; } }
        </style>
      </head>
      <body>
        <div class="head">
          <div>
            <h1>SNS Agro Enterprise &mdash; Worker Payslip</h1>
            <div class="meta">Worker: <strong>${escapeHtml(worker.name)}</strong> &bull; Period: <strong>${escapeHtml(periodLabel)}</strong></div>
          </div>
          <div style="text-align:right;font-size:12px;color:#55665c;">
            Generated: ${new Date().toLocaleString()}<br/>
            <button onclick="window.print()" style="margin-top:6px;padding:5px 12px;cursor:pointer;">Print</button>
          </div>
        </div>
        <div class="summary">
          <div class="box"><div class="box-label">Earnings / In (+)</div><div class="box-val pos">${formatRM(worker.inAmount, true)}</div></div>
          <div class="box"><div class="box-label">Deductions / Out (&minus;)</div><div class="box-val neg">${formatRM(worker.outAmount)}</div></div>
          <div class="box"><div class="box-label">Net Payable</div><div class="box-val ${worker.netAmount >= 0 ? "pos" : "neg"}">${formatRM(worker.netAmount, true)}</div></div>
        </div>
        <h2>Summary by Job Type (Upah Rates)</h2>
        <table>
          <thead><tr><th>Job Type</th><th>Unit</th><th class="num">Rate</th><th>Flow</th><th class="num">Qty</th><th class="num">Amount (RM)</th></tr></thead>
          <tbody>
            ${jobs.map(j => `
              <tr>
                <td>${escapeHtml(j.jobType)}</td>
                <td>${escapeHtml(j.unit)}</td>
                <td class="num">${formatRM(j.unitPrice)}</td>
                <td>${escapeHtml(j.cashFlow)}</td>
                <td class="num">${formatQty(j.qty, j.unit)}</td>
                <td class="num ${j.signedAmount >= 0 ? "pos" : "neg"}">${formatRM(j.signedAmount, true)}</td>
              </tr>
            `).join("")}
          </tbody>
        </table>
        <h2>Itemized Entries (${worker.entries.length})</h2>
        <table>
          <thead><tr><th>Date</th><th>Job Type</th><th class="num">Qty</th><th class="num">Rate</th><th>Flow</th><th class="num">Amount</th><th>Remark</th></tr></thead>
          <tbody>
            ${worker.entries.map(e => `
              <tr>
                <td>${escapeHtml(e.jobDate)}</td>
                <td>${escapeHtml(e.jobType)}</td>
                <td class="num">${formatQty(e.quantity, e.unit)} ${escapeHtml(e.unit)}</td>
                <td class="num">${formatRM(e.upahUnitPrice)}</td>
                <td>${escapeHtml(e.upahFlow)}</td>
                <td class="num ${e.upahSignedAmount >= 0 ? "pos" : "neg"}">${formatRM(e.upahSignedAmount, true)}</td>
                <td>${escapeHtml(e.remark || "—")}</td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </body>
      </html>
    `);
    win.document.close();
  }

  // ==================== UI CHROME & SYNC ====================

  function renderMonthPills() {
    const container = document.getElementById("month-pills");
    const { monthsDesc, entries } = state.parsed;
    const countByMonth = {};
    for (const e of entries) {
      countByMonth[e.month] = (countByMonth[e.month] || 0) + 1;
    }

    const pills = [
      { value: "ALL", label: "All Months", count: entries.length },
      ...monthsDesc.map(m => ({ value: m, label: formatMonthLabel(m), count: countByMonth[m] || 0 }))
    ];

    container.innerHTML = pills.map(p => `
      <button type="button" class="month-pill ${state.selectedMonth === p.value ? "is-active" : ""}" data-month="${escapeHtml(p.value)}">
        ${escapeHtml(p.label)}<span class="pill-count">(${p.count})</span>
      </button>
    `).join("");

    container.querySelectorAll("button[data-month]").forEach(btn => {
      btn.addEventListener("click", () => setSelectedMonth(btn.getAttribute("data-month")));
    });
  }

  function renderSheetLinks() {
    const meta = state.rawPayload && state.rawPayload.meta;
    if (!meta) return;
    const links = [
      { label: "Completed Jom Entry ↗", id: meta.completedEntriesId },
      { label: "Job Type ↗", id: meta.jobTypesId },
      { label: "Upah ↗", id: meta.upahId }
    ];
    document.getElementById("sheet-links").innerHTML = links.map(l =>
      `<a class="sheet-link" href="https://docs.google.com/spreadsheets/d/${encodeURIComponent(l.id)}/edit" target="_blank" rel="noopener">${l.label}</a>`
    ).join("");
  }

  function updateSyncIndicator() {
    const pill = document.getElementById("live-pill");
    const label = document.getElementById("live-label");
    const meta = document.getElementById("live-meta");
    const banner = document.getElementById("error-banner");

    pill.classList.remove("is-syncing", "is-paused", "is-error");

    if (state.status === "error") {
      pill.classList.add("is-error");
      label.textContent = "Sync Error";
      meta.textContent = "";
    } else if (state.status === "syncing") {
      pill.classList.add("is-syncing");
      label.textContent = "Syncing…";
    } else if (state.pollIntervalSeconds === 0) {
      pill.classList.add("is-paused");
      label.textContent = "Paused";
    } else {
      label.textContent = "LIVE";
    }

    if (state.syncedAt) {
      const dt = new Date(state.syncedAt);
      const timeStr = Number.isNaN(dt.getTime()) ? state.syncedAt : dt.toLocaleTimeString();
      meta.textContent = `• ${timeStr} (${state.syncDurationMs}ms) • v${state.version}`;
    }

    if (state.error) {
      banner.textContent = `Google Sheets sync warning: ${state.error} (showing last cached snapshot)`;
      banner.classList.remove("hidden");
    } else {
      banner.classList.add("hidden");
    }
  }

  function renderAll() {
    if (!state.parsed) return;
    renderMonthPills();
    renderSheetLinks();
    renderOverall();
    renderPayroll();
    renderDataTab();
    updateSyncIndicator();
  }

  function setSelectedMonth(month) {
    state.selectedMonth = month;
    renderAll();
  }

  function setActiveTab(tab) {
    state.activeTab = tab;
    document.querySelectorAll(".tab[data-tab]").forEach(btn => {
      const active = btn.getAttribute("data-tab") === tab;
      btn.classList.toggle("is-active", active);
      btn.setAttribute("aria-selected", active ? "true" : "false");
    });
    document.querySelectorAll(".tab-panel").forEach(p => p.classList.remove("is-active"));
    const target = document.getElementById(`view-${tab}`);
    if (target) target.classList.add("is-active");
  }

  function applyPayload(data, isManualRefresh = false) {
    // Handle degraded wrapper if server returned cached fallback
    const envelope = data.cached ? { ...data.cached, status: data.status, error: data.error } : data;
    const prevVersion = state.version;

    state.rawPayload = envelope;
    state.version = envelope.version || 0;
    state.syncedAt = envelope.syncedAt || null;
    state.syncDurationMs = envelope.syncDurationMs || 0;
    state.status = envelope.status === "error" ? "error" : "ok";
    state.error = envelope.error || null;

    if (typeof envelope.pollIntervalSeconds === "number") {
      state.pollIntervalSeconds = envelope.pollIntervalSeconds;
      const sel = document.getElementById("poll-select");
      if (sel && sel.value !== String(state.pollIntervalSeconds)) {
        sel.value = String(state.pollIntervalSeconds);
      }
    }

    state.parsed = parseAllData(envelope);

    // If selectedMonth no longer exists, fall back to ALL
    if (state.selectedMonth !== "ALL" && !state.parsed.monthsAsc.includes(state.selectedMonth)) {
      state.selectedMonth = "ALL";
    }

    renderAll();

    if (prevVersion > 0 && state.version > prevVersion) {
      showToast(`Live update detected from Google Sheets (v${state.version}) — reports refreshed!`);
    } else if (isManualRefresh) {
      showToast("Synced with Google Sheets — up to date.");
    }
  }

  async function fetchLiveSnapshot() {
    try {
      const res = await fetch("/api/data", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      applyPayload(data, false);
    } catch (err) {
      state.status = "error";
      state.error = err.message || String(err);
      updateSyncIndicator();
    }
  }

  async function triggerManualRefresh() {
    const btn = document.getElementById("btn-refresh");
    btn.disabled = true;
    state.status = "syncing";
    updateSyncIndicator();
    try {
      const res = await fetch("/api/refresh", { method: "POST", cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      applyPayload(data, true);
    } catch (err) {
      state.status = "error";
      state.error = err.message || String(err);
      updateSyncIndicator();
    } finally {
      btn.disabled = false;
    }
  }

  function scheduleClientPolling() {
    if (state.pollTimer) clearInterval(state.pollTimer);
    // Poll backend cache every 4 seconds so UI reflects background sheet updates immediately
    state.pollTimer = setInterval(() => {
      if (document.visibilityState === "visible") {
        fetchLiveSnapshot();
      }
    }, 4000);
  }

  // ==================== EXPORT HANDLERS ====================

  function bindExports() {
    document.getElementById("btn-export-overall").addEventListener("click", () => {
      const data = state._lastOverallData;
      if (!data) return;
      const period = state.selectedMonth;
      const rows = [
        ["Job Type", "Unit", "Unit Price (RM)", "Cash Flow", "Entries", "Total Qty", "Signed Amount (RM)"],
        ...data.rows.map(r => [r.name, r.unit, r.unitPrice.toFixed(2), r.cashFlow, r.count, r.qty, r.signedAmount.toFixed(2)]),
        ["Total Cash Flow In (+)", "", "", "In", data.countIn, "", data.totalIn.toFixed(2)],
        ["Total Cash Flow Out (-)", "", "", "Out", data.countOut, "", data.totalOut.toFixed(2)],
        ["Net Overall Cash Flow", "", "", "Net", data.totalEntries, "", data.netTotal.toFixed(2)]
      ];
      downloadCsv(`SNS-Agro-Overall-Report-${period}.csv`, rows);
    });

    document.getElementById("btn-export-overall-matrix").addEventListener("click", () => {
      const data = state._lastOverallData;
      if (!data || !state.parsed) return;
      const months = state.parsed.monthsAsc;
      const metric = state.overallMatrixMetric;
      const rows = [
        ["Job Type", "Cash Flow", "Unit", "Unit Price (RM)", ...months, "Grand Total"],
        ...data.rows.map(r => [
          r.name,
          r.cashFlow,
          r.unit,
          r.unitPrice.toFixed(2),
          ...months.map(m => metric === "qty" ? r.byMonthQty[m] : r.byMonthAmount[m].toFixed(2)),
          metric === "qty" ? r.allMonthsQty : r.allMonthsAmount.toFixed(2)
        ])
      ];
      downloadCsv(`SNS-Agro-Overall-Matrix-${metric}.csv`, rows);
    });

    document.getElementById("btn-export-payroll").addEventListener("click", () => {
      const data = state._lastPayrollData;
      if (!data) return;
      const period = state.selectedMonth;
      const workers = data.workers.filter(w => period === "ALL" ? true : w.count > 0);
      const rows = [
        ["Worker Name", "Entries", "Earnings / In (+RM)", "Deductions / Out (-RM)", "Net Payable (RM)"],
        ...workers.map(w => [w.name, w.count, w.inAmount.toFixed(2), w.outAmount.toFixed(2), w.netAmount.toFixed(2)]),
        ["TOTAL WORKER PAYROLL", data.totalEntries, data.totalIn.toFixed(2), data.totalOut.toFixed(2), data.totalNet.toFixed(2)],
        ["SNS Agro (Excluded Company Expenses)", data.companyEntriesFiltered.length, "", "", data.companyTotalFiltered.toFixed(2)]
      ];
      downloadCsv(`SNS-Agro-Payroll-Report-${period}.csv`, rows);
    });

    document.getElementById("btn-export-payroll-matrix").addEventListener("click", () => {
      const data = state._lastPayrollData;
      if (!data || !state.parsed) return;
      const months = state.parsed.monthsAsc;
      const metric = state.payrollMatrixMetric;
      const rows = [
        ["Worker Name", ...months, "Grand Total"],
        ...data.workers.map(w => {
          const grand = metric === "in" ? w.allMonthsIn : (metric === "out" ? w.allMonthsOut : w.allMonthsNet);
          return [w.name, ...months.map(m => w.byMonth[m][metric].toFixed(2)), grand.toFixed(2)];
        })
      ];
      downloadCsv(`SNS-Agro-Payroll-Matrix-${metric}.csv`, rows);
    });

    document.getElementById("btn-export-raw").addEventListener("click", () => {
      const filtered = getFilteredEntries(false);
      const rows = [
        ["Job Date", "Month", "Job Type", "Job Done By", "Qty", "Unit", "Overall (RM)", "Payroll Upah (RM)", "Remark"],
        ...filtered.map(e => [
          e.jobDate, e.month, e.jobType, e.workerName, e.quantity, e.unit,
          e.overallSignedAmount.toFixed(2), e.upahSignedAmount.toFixed(2), e.remark
        ])
      ];
      downloadCsv(`SNS-Agro-Entries-${state.selectedMonth}.csv`, rows);
    });
  }

  // ==================== INIT ====================

  function init() {
    document.querySelectorAll(".tab[data-tab]").forEach(btn => {
      btn.addEventListener("click", () => setActiveTab(btn.getAttribute("data-tab")));
    });

    document.getElementById("btn-refresh").addEventListener("click", triggerManualRefresh);
    document.getElementById("btn-print").addEventListener("click", () => window.print());

    document.getElementById("poll-select").addEventListener("change", async (ev) => {
      const sec = parseInt(ev.target.value, 10);
      state.pollIntervalSeconds = sec;
      updateSyncIndicator();
      try {
        await fetch(`/api/config?pollIntervalSeconds=${sec}`, { method: "POST" });
        showToast(sec === 0 ? "Auto-sync paused." : `Auto-sync set to every ${sec}s.`);
      } catch (e) {
        showToast("Could not update auto-sync interval.");
      }
    });

    document.getElementById("global-search").addEventListener("input", (ev) => {
      state.searchQuery = ev.target.value;
      renderAll();
    });

    document.getElementById("overall-matrix-toggle").addEventListener("click", (ev) => {
      const btn = ev.target.closest("button[data-metric]");
      if (!btn) return;
      state.overallMatrixMetric = btn.getAttribute("data-metric");
      document.querySelectorAll("#overall-matrix-toggle .seg-btn").forEach(b => b.classList.toggle("is-active", b === btn));
      renderOverall();
    });

    document.getElementById("payroll-matrix-toggle").addEventListener("click", (ev) => {
      const btn = ev.target.closest("button[data-metric]");
      if (!btn) return;
      state.payrollMatrixMetric = btn.getAttribute("data-metric");
      document.querySelectorAll("#payroll-matrix-toggle .seg-btn").forEach(b => b.classList.toggle("is-active", b === btn));
      renderPayroll();
    });

    document.getElementById("drawer-close").addEventListener("click", closeDrawer);
    document.getElementById("drawer-backdrop").addEventListener("click", closeDrawer);
    document.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") closeDrawer();
    });

    bindExports();
    fetchLiveSnapshot();
    scheduleClientPolling();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
