/* ---------- Storage layer ---------- */
const STORE_KEY = 'fintrack_data_v1';

const DEFAULT_DATA = {
  transactions: [], // {id, type: 'expense'|'income', amount, category, method, date: 'YYYY-MM-DD', note, createdAt, updatedAt}
  categories: {
    expense: ['Food', 'Transport', 'Bills', 'Shopping', 'Health', 'Entertainment', 'Other'],
    income: ['Salary', 'Freelance', 'Gift', 'Other'],
  },
  methods: ['Cash', 'Debit Card', 'Credit Card', 'SPayLater', 'LazPayLater', 'TikTokPayLater'],
  accounts: [
    { name: 'Cash', kind: 'asset', initialBalance: 0 },
    { name: 'Debit Card', kind: 'asset', initialBalance: 0 },
    { name: 'Credit Card', kind: 'liability', initialBalance: 0, creditLimit: 0 },
    { name: 'SPayLater', kind: 'liability', initialBalance: 0, creditLimit: 0 },
    { name: 'LazPayLater', kind: 'liability', initialBalance: 0, creditLimit: 0 },
    { name: 'TikTokPayLater', kind: 'liability', initialBalance: 0, creditLimit: 0 },
  ],
  bills: [], // {id, name, amount, dueDate: 'YYYY-MM-DD', recurring: 'none'|'weekly'|'monthly'|'yearly', status: 'pending'|'paid', note, createdAt}
  billNames: ['Electricity', 'Water', 'Internet', 'Rent', 'Credit Card'],
  geminiKey: '',
  budgets: { overall: null, categories: {} }, // monthly budgets; categories: {catName: number}
};

function loadData() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return structuredClone(DEFAULT_DATA);
    const parsed = JSON.parse(raw);
    const methods = parsed.methods || DEFAULT_DATA.methods;
    let accounts = parsed.accounts;
    if (!accounts) {
      // migrate: derive accounts from old flat method list
      accounts = methods.map((m) => {
        const def = DEFAULT_DATA.accounts.find((a) => a.name === m);
        return def ? { ...def } : { name: m, kind: 'asset', initialBalance: 0 };
      });
    }
    return {
      transactions: parsed.transactions || [],
      categories: {
        expense: parsed.categories?.expense || DEFAULT_DATA.categories.expense,
        income: parsed.categories?.income || DEFAULT_DATA.categories.income,
      },
      methods,
      accounts,
      bills: parsed.bills || [],
      billNames: parsed.billNames || DEFAULT_DATA.billNames,
      geminiKey: parsed.geminiKey || parsed.openaiKey || '',
      budgets: parsed.budgets || { overall: null, categories: {} },
    };
  } catch (e) {
    console.error('Failed to load data', e);
    return structuredClone(DEFAULT_DATA);
  }
}

function saveData() {
  localStorage.setItem(STORE_KEY, JSON.stringify(state));
}

let state = loadData();

/* ---------- Utilities ---------- */
function uid() {
  return 'txn_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function todayStr() {
  const d = new Date();
  return d.toISOString().slice(0, 10);
}

function fmtMoney(n) {
  const sign = n < 0 ? '-' : '';
  return sign + Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/* ---------- Amount field: accepts plain numbers or simple math expressions (e.g. 50+30+20) ---------- */
function evalAmount(raw) {
  const str = (raw || '').trim();
  if (!str) return NaN;
  if (/^\d+(\.\d+)?$/.test(str)) return parseFloat(str);
  if (!/^[0-9+\-*/(). ]+$/.test(str)) return NaN;
  try {
    const result = Function('"use strict"; return (' + str + ')')();
    return typeof result === 'number' && isFinite(result) ? result : NaN;
  } catch {
    return NaN;
  }
}

function initAmountCalculator(inputId, previewId) {
  const input = document.getElementById(inputId);
  const preview = document.getElementById(previewId);
  input.addEventListener('input', () => {
    const raw = input.value;
    if (/[+\-*/]/.test(raw)) {
      const result = evalAmount(raw);
      preview.textContent = isFinite(result) ? `= ${fmtMoney(result)}` : '';
    } else {
      preview.textContent = '';
    }
  });
}

function wireCalcRow(rowId, inputId, previewId) {
  document.querySelectorAll(`#${rowId} button[data-op]`).forEach((btn) => {
    btn.addEventListener('click', () => {
      const input = document.getElementById(inputId);
      input.value += btn.dataset.op;
      input.dispatchEvent(new Event('input'));
      input.focus();
    });
  });
  document.getElementById('calc-eval')?.addEventListener('click', () => {
    const input = document.getElementById(inputId);
    const result = evalAmount(input.value);
    if (isFinite(result)) {
      input.value = Math.round(result * 100) / 100;
      document.getElementById(previewId).textContent = '';
    }
    input.focus();
  });
  document.getElementById('calc-clear')?.addEventListener('click', () => {
    const input = document.getElementById(inputId);
    input.value = '';
    document.getElementById(previewId).textContent = '';
    input.focus();
  });
}

initAmountCalculator('txn-amount', 'txn-amount-preview');
wireCalcRow('calc-row', 'txn-amount', 'txn-amount-preview');

function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => t.classList.remove('show'), 2200);
}

function parseDate(str) {
  // 'YYYY-MM-DD' -> local Date at midnight
  const [y, m, d] = str.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function isoWeekInfo(date) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const day = (d.getDay() + 6) % 7; // Mon=0
  d.setDate(d.getDate() - day + 3);
  const firstThursday = new Date(d.getFullYear(), 0, 4);
  const diff = d - firstThursday;
  const week = 1 + Math.round(diff / (7 * 24 * 3600 * 1000));
  return { year: d.getFullYear(), week };
}

/* ---------- Period navigation ---------- */
let currentPeriodType = 'month'; // day | week | month | year
let currentAnchor = new Date(); // date representing current period

function periodRange(type, anchor) {
  const a = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate());
  if (type === 'day') {
    return { start: a, end: a };
  }
  if (type === 'week') {
    const day = (a.getDay() + 6) % 7;
    const start = new Date(a); start.setDate(a.getDate() - day);
    const end = new Date(start); end.setDate(start.getDate() + 6);
    return { start, end };
  }
  if (type === 'month') {
    const start = new Date(a.getFullYear(), a.getMonth(), 1);
    const end = new Date(a.getFullYear(), a.getMonth() + 1, 0);
    return { start, end };
  }
  // year
  const start = new Date(a.getFullYear(), 0, 1);
  const end = new Date(a.getFullYear(), 11, 31);
  return { start, end };
}

function periodLabel(type, anchor) {
  const { start, end } = periodRange(type, anchor);
  const opts = { month: 'short', day: 'numeric' };
  if (type === 'day') return start.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  if (type === 'week') return `${start.toLocaleDateString(undefined, opts)} – ${end.toLocaleDateString(undefined, opts)}, ${end.getFullYear()}`;
  if (type === 'month') return start.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  return String(start.getFullYear());
}

function shiftAnchor(type, anchor, dir) {
  const d = new Date(anchor);
  if (type === 'day') d.setDate(d.getDate() + dir);
  else if (type === 'week') d.setDate(d.getDate() + dir * 7);
  else if (type === 'month') d.setMonth(d.getMonth() + dir);
  else d.setFullYear(d.getFullYear() + dir);
  return d;
}

function inRange(dateStr, start, end) {
  const d = parseDate(dateStr);
  return d >= start && d <= end;
}

/* ---------- Rendering: Home view ---------- */
const CHART_COLORS = ['#22d3ee', '#34d399', '#f87171', '#fbbf24', '#a78bfa', '#f472b6', '#60a5fa', '#4ade80', '#fb923c', '#c084fc'];
let selectedCategoryFilter = null;

function renderHome() {
  document.getElementById('period-label').textContent = periodLabel(currentPeriodType, currentAnchor);
  const { start, end } = periodRange(currentPeriodType, currentAnchor);
  const txns = state.transactions.filter((t) => inRange(t.date, start, end));

  let income = 0, expense = 0;
  const byCat = {};
  for (const t of txns) {
    if (t.type === 'transfer') continue;
    if (t.type === 'income') income += t.amount;
    else {
      expense += t.amount;
      byCat[t.category] = (byCat[t.category] || 0) + t.amount;
    }
  }
  document.getElementById('sum-income').textContent = fmtMoney(income);
  document.getElementById('sum-expense').textContent = fmtMoney(expense);
  const net = income - expense;
  const netEl = document.getElementById('sum-net');
  netEl.textContent = fmtMoney(net);
  netEl.className = 'value ' + (net >= 0 ? 'income' : 'expense');

  if (selectedCategoryFilter && !byCat[selectedCategoryFilter]) selectedCategoryFilter = null;

  renderChart(byCat, expense);
  renderIncomeExpenseChart(income, expense);
  renderTrendChart();
  renderBudgetCard(byCat, expense);

  const filteredTxns = selectedCategoryFilter
    ? txns.filter((t) => t.type === 'expense' && t.category === selectedCategoryFilter)
    : txns;
  document.getElementById('txn-list-title').textContent = selectedCategoryFilter ? `Transactions — ${selectedCategoryFilter}` : 'Transactions';
  document.getElementById('txn-filter-clear').style.display = selectedCategoryFilter ? 'block' : 'none';
  renderTxnList(filteredTxns, 'txn-list', 'txn-empty');
}

function budgetBarColor(ratio) {
  if (ratio >= 1) return 'var(--expense)';
  if (ratio >= 0.8) return '#fbbf24';
  return 'var(--income)';
}

function budgetGaugeSvg(ratio) {
  const size = 72, r = 30, strokeWidth = 10;
  const cx = size / 2, cy = size / 2;
  const circumference = 2 * Math.PI * r;
  const dash = Math.min(ratio, 1) * circumference;
  const color = budgetBarColor(ratio);
  const pct = Math.round(ratio * 100);
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" style="flex-shrink:0">
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="var(--panel-soft)" stroke-width="${strokeWidth}"></circle>
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${color}" stroke-width="${strokeWidth}"
      stroke-dasharray="${dash} ${circumference - dash}" stroke-linecap="round"
      transform="rotate(-90 ${cx} ${cy})"></circle>
    <text x="${cx}" y="${cy + 4}" text-anchor="middle" font-size="15" font-weight="800" fill="var(--text)">${pct}%</text>
  </svg>`;
}

const BUDGET_PERIOD_TITLE = { day: 'Daily budget (prorated)', week: 'Weekly budget (prorated)', month: 'Monthly budget', year: 'Yearly budget (×12)' };

function prorateBudget(monthlyAmount, periodType, anchor) {
  if (monthlyAmount == null) return null;
  const daysInMonth = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0).getDate();
  if (periodType === 'day') return monthlyAmount / daysInMonth;
  if (periodType === 'week') return (monthlyAmount / daysInMonth) * 7;
  if (periodType === 'year') return monthlyAmount * 12;
  return monthlyAmount;
}

function renderBudgetCard(byCat, totalExpense) {
  const card = document.getElementById('budget-card');
  const content = document.getElementById('budget-content');
  const { overall, categories } = state.budgets;
  const hasAny = overall != null || Object.keys(categories).length > 0;

  if (!hasAny) {
    card.style.display = 'none';
    return;
  }
  card.style.display = 'block';
  document.getElementById('budget-card-title').textContent = BUDGET_PERIOD_TITLE[currentPeriodType];

  const overallTarget = prorateBudget(overall, currentPeriodType, currentAnchor);

  let html = '';
  if (overallTarget != null) {
    const ratio = overallTarget > 0 ? totalExpense / overallTarget : 0;
    const pct = Math.round(ratio * 100);
    const remaining = overallTarget - totalExpense;
    html += `<div class="gauge-wrap">
      ${budgetGaugeSvg(ratio)}
      <div class="gauge-info">
        <div class="amounts">${fmtMoney(totalExpense)} <span style="color:var(--muted);font-weight:500">/ ${fmtMoney(overallTarget)} (${pct}%)</span></div>
        <div class="sub">${remaining >= 0 ? fmtMoney(remaining) + ' left' : fmtMoney(-remaining) + ' over'}</div>
      </div>
    </div>`;
    if (Object.keys(categories).length) html += `<h3 class="section-title" style="margin:14px 0 8px">By category</h3>`;
  }
  for (const [cat, limit] of Object.entries(categories)) {
    if (!limit) continue;
    const target = prorateBudget(limit, currentPeriodType, currentAnchor);
    const spent = byCat[cat] || 0;
    const ratio = target > 0 ? spent / target : 0;
    const pct = Math.round(ratio * 100);
    html += `<div class="budget-row">
      <div class="budget-row-head"><span class="name">${escapeHtml(cat)}</span><span class="amounts">${fmtMoney(spent)} / ${fmtMoney(target)} (${pct}%)</span></div>
      <div class="budget-bar-track"><div class="budget-bar-fill" style="width:${Math.min(ratio, 1) * 100}%;background:${budgetBarColor(ratio)}"></div></div>
    </div>`;
  }
  content.innerHTML = html || '<p style="font-size:13px;color:var(--muted)">No budgets set.</p>';
}

let chartType = localStorage.getItem('fintrack_chart_type') || 'bar';

function svgEl(tag, attrs) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

function selectCategory(cat) {
  selectedCategoryFilter = selectedCategoryFilter === cat ? null : cat;
  renderHome();
}

document.getElementById('txn-filter-clear').addEventListener('click', () => {
  selectedCategoryFilter = null;
  renderHome();
});

function renderChart(byCat, total) {
  const svg = document.getElementById('chart-svg');
  const legend = document.getElementById('chart-legend');
  svg.innerHTML = '';
  legend.innerHTML = '';
  const entries = Object.entries(byCat).sort((a, b) => b[1] - a[1]).slice(0, 8);

  if (!entries.length || total <= 0) {
    svg.setAttribute('viewBox', '0 0 320 160');
    const t = svgEl('text', { x: 160, y: 80, 'text-anchor': 'middle', fill: '#94a3b8', 'font-size': 12 });
    t.textContent = 'No expense data';
    svg.appendChild(t);
    return;
  }

  if (chartType === 'donut') renderDonutChart(svg, entries, total);
  else renderBarChart(svg, entries, total);

  entries.forEach(([cat, val], i) => {
    const li = document.createElement('div');
    const isSelected = selectedCategoryFilter === cat;
    const pct = Math.round((val / total) * 100);
    li.className = 'legend-item' + (isSelected ? ' selected' : '') + (selectedCategoryFilter && !isSelected ? ' dim' : '');
    li.innerHTML = `<span class="legend-swatch" style="background:${CHART_COLORS[i % CHART_COLORS.length]}"></span>${escapeHtml(cat)} (${fmtMoney(val)} · ${pct}%)`;
    li.addEventListener('click', () => selectCategory(cat));
    legend.appendChild(li);
  });
}

function renderBarChart(svg, entries, total) {
  svg.setAttribute('viewBox', '0 0 320 160');
  const maxVal = Math.max(...entries.map((e) => e[1]));
  const barW = 320 / entries.length;
  entries.forEach(([cat, val], i) => {
    const h = (val / maxVal) * 120;
    const isSelected = selectedCategoryFilter === cat;
    const rect = svgEl('rect', {
      x: i * barW + barW * 0.15, y: 150 - h, width: barW * 0.7, height: h,
      rx: 3, fill: CHART_COLORS[i % CHART_COLORS.length],
    });
    rect.classList.add('chart-seg');
    if (selectedCategoryFilter && !isSelected) rect.classList.add('dim');
    if (isSelected) rect.setAttribute('stroke', '#fff');
    if (isSelected) rect.setAttribute('stroke-width', '2');
    rect.addEventListener('click', () => selectCategory(cat));
    svg.appendChild(rect);

    const pct = Math.round((val / total) * 100);
    const pctText = svgEl('text', {
      x: i * barW + barW / 2, y: 150 - h - 6, 'text-anchor': 'middle',
      fill: 'var(--muted)', 'font-size': 10, 'font-weight': 700,
    });
    pctText.textContent = `${pct}%`;
    if (selectedCategoryFilter && !isSelected) pctText.setAttribute('opacity', '0.4');
    svg.appendChild(pctText);
  });
}

function renderDonutChart(svg, entries, total) {
  svg.setAttribute('viewBox', '0 0 200 200');
  const cx = 100, cy = 100, r = 72;
  const circumference = 2 * Math.PI * r;

  svg.appendChild(svgEl('circle', { cx, cy, r, fill: 'none', stroke: 'var(--panel-soft)', 'stroke-width': 26 }));

  let offset = 0;
  entries.forEach(([cat, val], i) => {
    const frac = val / total;
    const dash = frac * circumference;
    const isSelected = selectedCategoryFilter === cat;
    const circle = svgEl('circle', {
      cx, cy, r, fill: 'none',
      stroke: CHART_COLORS[i % CHART_COLORS.length],
      'stroke-width': isSelected ? 30 : 26,
      'stroke-dasharray': `${dash} ${circumference - dash}`,
      'stroke-dashoffset': -offset,
      transform: `rotate(-90 ${cx} ${cy})`,
      'stroke-linecap': entries.length > 1 ? 'butt' : 'round',
    });
    circle.classList.add('chart-seg');
    if (selectedCategoryFilter && !isSelected) circle.classList.add('dim');
    circle.addEventListener('click', () => selectCategory(cat));
    svg.appendChild(circle);
    offset += dash;
  });

  const selectedEntry = entries.find(([cat]) => cat === selectedCategoryFilter);
  const valueText = svgEl('text', { x: cx, y: cy - 4, 'text-anchor': 'middle', class: 'donut-center-value' });
  valueText.textContent = fmtMoney(selectedEntry ? selectedEntry[1] : total);
  svg.appendChild(valueText);
  const labelText = svgEl('text', { x: cx, y: cy + 14, 'text-anchor': 'middle', class: 'donut-center-label' });
  labelText.textContent = selectedEntry ? selectedEntry[0].toUpperCase() : 'TOTAL SPENT';
  svg.appendChild(labelText);
}

function renderIncomeExpenseChart(income, expense) {
  const svg = document.getElementById('ie-chart-svg');
  svg.innerHTML = '';
  svg.setAttribute('viewBox', '0 0 320 160');
  const maxVal = Math.max(income, expense, 1);
  const barW = 90;
  const bars = [
    { label: 'Income', val: income, x: 70, color: 'var(--income)' },
    { label: 'Expense', val: expense, x: 190, color: 'var(--expense)' },
  ];
  if (income <= 0 && expense <= 0) {
    const t = svgEl('text', { x: 160, y: 80, 'text-anchor': 'middle', fill: '#94a3b8', 'font-size': 12 });
    t.textContent = 'No data yet';
    svg.appendChild(t);
    return;
  }
  bars.forEach((b) => {
    const h = (b.val / maxVal) * 100;
    svg.appendChild(svgEl('rect', { x: b.x, y: 122 - h, width: barW, height: h, rx: 6, fill: b.color }));
    const valText = svgEl('text', { x: b.x + barW / 2, y: 122 - h - 8, 'text-anchor': 'middle', fill: 'var(--text)', 'font-size': 13, 'font-weight': 700 });
    valText.textContent = fmtMoney(b.val);
    svg.appendChild(valText);
    const labelText = svgEl('text', { x: b.x + barW / 2, y: 140, 'text-anchor': 'middle', fill: 'var(--muted)', 'font-size': 11, 'font-weight': 600 });
    labelText.textContent = b.label;
    svg.appendChild(labelText);
  });
}

function trendBuckets() {
  const buckets = [];
  if (currentPeriodType === 'year') {
    for (let m = 0; m < 12; m++) {
      const start = new Date(currentAnchor.getFullYear(), m, 1);
      const end = new Date(currentAnchor.getFullYear(), m + 1, 0);
      buckets.push({ label: start.toLocaleDateString(undefined, { month: 'short' }), start, end });
    }
  } else {
    const { start, end } = periodRange(currentPeriodType === 'day' ? 'week' : currentPeriodType, currentAnchor);
    const cur = new Date(start);
    while (cur <= end) {
      buckets.push({ label: String(cur.getDate()), start: new Date(cur), end: new Date(cur) });
      cur.setDate(cur.getDate() + 1);
    }
  }
  for (const b of buckets) {
    const inBucket = state.transactions.filter((t) => inRange(t.date, b.start, b.end));
    b.expense = inBucket.filter((t) => t.type === 'expense').reduce((s, t) => s + t.amount, 0);
    b.income = inBucket.filter((t) => t.type === 'income').reduce((s, t) => s + t.amount, 0);
  }
  return buckets;
}

function linePoints(buckets, key, maxVal, padX, padTop, chartW, chartH) {
  const stepX = buckets.length > 1 ? chartW / (buckets.length - 1) : 0;
  return buckets.map((b, i) => ({
    x: padX + i * stepX,
    y: padTop + chartH - (b[key] / maxVal) * chartH,
    b,
  }));
}

function renderTrendChart() {
  const svg = document.getElementById('trend-chart-svg');
  const legend = document.getElementById('trend-legend');
  svg.innerHTML = '';
  legend.innerHTML = '';
  svg.setAttribute('viewBox', '0 0 320 140');
  const buckets = trendBuckets();
  const maxVal = Math.max(...buckets.map((b) => Math.max(b.expense, b.income)), 1);
  if (!buckets.some((b) => b.expense > 0 || b.income > 0)) {
    const t = svgEl('text', { x: 160, y: 70, 'text-anchor': 'middle', fill: '#94a3b8', 'font-size': 12 });
    t.textContent = 'No data yet';
    svg.appendChild(t);
    return;
  }

  const padX = 8, padTop = 12, padBottom = 22, chartW = 320 - padX * 2, chartH = 140 - padTop - padBottom;
  const expensePoints = linePoints(buckets, 'expense', maxVal, padX, padTop, chartW, chartH);
  const incomePoints = linePoints(buckets, 'income', maxVal, padX, padTop, chartW, chartH);

  const defs = svgEl('defs', {});
  defs.innerHTML = `<linearGradient id="trendFillExpense" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0%" stop-color="#fb7185" stop-opacity="0.28"/>
    <stop offset="100%" stop-color="#fb7185" stop-opacity="0"/>
  </linearGradient>`;
  svg.appendChild(defs);

  const drawLine = (points, color, fillGradient) => {
    const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ');
    if (fillGradient) {
      const areaPath = `${linePath} L ${points[points.length - 1].x} ${padTop + chartH} L ${points[0].x} ${padTop + chartH} Z`;
      svg.appendChild(svgEl('path', { d: areaPath, fill: `url(#${fillGradient})`, stroke: 'none' }));
    }
    svg.appendChild(svgEl('path', { d: linePath, fill: 'none', stroke: color, 'stroke-width': 2.2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
    points.forEach((p) => {
      if (p.b.expense > 0 || p.b.income > 0) svg.appendChild(svgEl('circle', { cx: p.x, cy: p.y, r: 2.4, fill: color }));
    });
  };

  drawLine(expensePoints, '#fb7185', 'trendFillExpense');
  drawLine(incomePoints, '#34d399', null);

  const labelEvery = Math.ceil(buckets.length / 6);
  expensePoints.forEach((p, i) => {
    if (i % labelEvery !== 0 && i !== expensePoints.length - 1) return;
    const t = svgEl('text', { x: p.x, y: 136, 'text-anchor': 'middle', fill: 'var(--muted)', 'font-size': 9 });
    t.textContent = p.b.label;
    svg.appendChild(t);
  });

  legend.innerHTML = `
    <div class="legend-item" style="cursor:default"><span class="legend-swatch" style="background:#34d399"></span>Income</div>
    <div class="legend-item" style="cursor:default"><span class="legend-swatch" style="background:#fb7185"></span>Expense</div>
  `;
}

document.querySelectorAll('#chart-type-toggle button').forEach((btn) => {
  btn.classList.toggle('active', btn.dataset.chartType === chartType);
  btn.addEventListener('click', () => {
    chartType = btn.dataset.chartType;
    localStorage.setItem('fintrack_chart_type', chartType);
    document.querySelectorAll('#chart-type-toggle button').forEach((b) => b.classList.toggle('active', b === btn));
    renderHome();
  });
});

function txnRowHtml(t) {
  const d = parseDate(t.date);
  const dateStr = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  if (t.type === 'transfer') {
    return `<li class="txn-item" data-id="${t.id}">
      <div class="txn-main">
        <div class="txn-cat">Transfer: ${escapeHtml(t.method)} → ${escapeHtml(t.toAccount)}</div>
        <div class="txn-meta">${dateStr}${t.note ? ' · ' + escapeHtml(t.note) : ''}</div>
      </div>
      <div class="txn-amt">${fmtMoney(t.amount)}</div>
    </li>`;
  }
  const sign = t.type === 'income' ? '+' : '-';
  return `<li class="txn-item" data-id="${t.id}">
    <div class="txn-main">
      <div class="txn-cat">${escapeHtml(t.category)}</div>
      <div class="txn-meta">${dateStr} · ${escapeHtml(t.method)}${t.note ? ' · ' + escapeHtml(t.note) : ''}</div>
    </div>
    <div class="txn-amt ${t.type}">${sign}${fmtMoney(t.amount)}</div>
  </li>`;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderTxnList(txns, listId, emptyId) {
  const list = document.getElementById(listId);
  const empty = document.getElementById(emptyId);
  const sorted = [...txns].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : (b.createdAt || 0) - (a.createdAt || 0)));
  list.innerHTML = sorted.map(txnRowHtml).join('');
  empty.style.display = sorted.length ? 'none' : 'block';
  list.querySelectorAll('.txn-item').forEach((el) => {
    el.addEventListener('click', () => openTxnModal(el.dataset.id));
  });
}

/* ---------- Navigation ---------- */
let activeTabView = 'home';
let previousTabView = 'home';

function switchView(view, direction) {
  if (view !== activeTabView && activeTabView !== 'settings') previousTabView = activeTabView;
  activeTabView = view;
  document.querySelectorAll('.view').forEach((v) => v.classList.remove('active', 'anim-fade', 'anim-left', 'anim-right'));
  const el = document.getElementById('view-' + view);
  el.classList.add('active');
  el.classList.add(direction === 'left' ? 'anim-left' : direction === 'right' ? 'anim-right' : 'anim-fade');
  document.querySelectorAll('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  if (view === 'home') renderHome();
  if (view === 'audit') renderAudit();
  if (view === 'settings') renderSettings();
  if (view === 'accounts') renderAccounts();
  if (view === 'bills') renderBills();
}

document.querySelectorAll('.nav-btn').forEach((b) => b.addEventListener('click', () => switchView(b.dataset.view)));

/* ---------- Hamburger menu (single tap straight to Settings) ---------- */
document.getElementById('hamburger-btn').addEventListener('click', () => switchView('settings'));

/* ---------- Swipe navigation: left = next tab, right = previous tab (Settings only from Home) ---------- */
const SWIPE_NAV_ORDER = ['home', 'accounts', 'bills', 'audit', 'export'];
let swipeStartX = 0, swipeStartY = 0, swipeStartTime = 0;

document.addEventListener('touchstart', (e) => {
  const t = e.touches[0];
  swipeStartX = t.clientX;
  swipeStartY = t.clientY;
  swipeStartTime = Date.now();
}, { passive: true });

document.addEventListener('touchend', (e) => {
  if (document.querySelector('.modal-overlay.active')) return;
  const t = e.changedTouches[0];
  const dx = t.clientX - swipeStartX;
  const dy = t.clientY - swipeStartY;
  const dt = Date.now() - swipeStartTime;
  if (dt > 600) return;
  if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.5) return;

  if (dx < 0) {
    // swiped left -> move forward (or back out of Settings)
    if (activeTabView === 'settings') {
      switchView(previousTabView, 'right');
    } else {
      const idx = SWIPE_NAV_ORDER.indexOf(activeTabView);
      if (idx >= 0 && idx < SWIPE_NAV_ORDER.length - 1) switchView(SWIPE_NAV_ORDER[idx + 1], 'right');
    }
  } else {
    // swiped right -> move to the previous tab, or open Settings only from Home
    if (activeTabView === 'home') {
      switchView('settings', 'left');
    } else if (activeTabView !== 'settings') {
      const idx = SWIPE_NAV_ORDER.indexOf(activeTabView);
      if (idx > 0) switchView(SWIPE_NAV_ORDER[idx - 1], 'left');
    }
  }
}, { passive: true });

document.querySelectorAll('.period-tabs button').forEach((b) => {
  b.addEventListener('click', () => {
    currentPeriodType = b.dataset.period;
    document.querySelectorAll('.period-tabs button').forEach((x) => x.classList.toggle('active', x === b));
    renderHome();
  });
});
document.getElementById('period-prev').addEventListener('click', () => {
  currentAnchor = shiftAnchor(currentPeriodType, currentAnchor, -1);
  renderHome();
});
document.getElementById('period-next').addEventListener('click', () => {
  currentAnchor = shiftAnchor(currentPeriodType, currentAnchor, 1);
  renderHome();
});

/* ---------- Period picker: quick jump to any month/year/date ---------- */
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
let pickerYear = currentAnchor.getFullYear();

function openPeriodPicker() {
  pickerYear = currentAnchor.getFullYear();
  renderPeriodPicker();
  document.getElementById('period-picker-overlay').classList.add('active');
}

function renderPeriodPicker() {
  const content = document.getElementById('period-picker-content');
  const title = document.getElementById('period-picker-title');

  if (currentPeriodType === 'month') {
    title.textContent = 'Jump to month';
    const curYear = currentAnchor.getFullYear(), curMonth = currentAnchor.getMonth();
    content.innerHTML = `
      <div class="picker-year-nav">
        <button id="picker-year-prev">‹</button>
        <span class="picker-year-label">${pickerYear}</span>
        <button id="picker-year-next">›</button>
      </div>
      <div class="picker-month-grid">
        ${MONTH_NAMES.map((m, i) => `<button data-month="${i}" class="${pickerYear === curYear && i === curMonth ? 'current' : ''}">${m}</button>`).join('')}
      </div>`;
    document.getElementById('picker-year-prev').addEventListener('click', () => { pickerYear--; renderPeriodPicker(); });
    document.getElementById('picker-year-next').addEventListener('click', () => { pickerYear++; renderPeriodPicker(); });
    content.querySelectorAll('[data-month]').forEach((btn) => {
      btn.addEventListener('click', () => {
        currentAnchor = new Date(pickerYear, parseInt(btn.dataset.month, 10), 1);
        document.getElementById('period-picker-overlay').classList.remove('active');
        renderHome();
      });
    });
  } else if (currentPeriodType === 'year') {
    title.textContent = 'Jump to year';
    const curYear = currentAnchor.getFullYear();
    const startYear = pickerYear - 5;
    const years = Array.from({ length: 12 }, (_, i) => startYear + i);
    content.innerHTML = `
      <div class="picker-year-nav">
        <button id="picker-year-prev">‹</button>
        <span class="picker-year-label">${startYear} – ${startYear + 11}</span>
        <button id="picker-year-next">›</button>
      </div>
      <div class="picker-year-grid">
        ${years.map((y) => `<button data-year="${y}" class="${y === curYear ? 'current' : ''}">${y}</button>`).join('')}
      </div>`;
    document.getElementById('picker-year-prev').addEventListener('click', () => { pickerYear -= 12; renderPeriodPicker(); });
    document.getElementById('picker-year-next').addEventListener('click', () => { pickerYear += 12; renderPeriodPicker(); });
    content.querySelectorAll('[data-year]').forEach((btn) => {
      btn.addEventListener('click', () => {
        currentAnchor = new Date(parseInt(btn.dataset.year, 10), 0, 1);
        document.getElementById('period-picker-overlay').classList.remove('active');
        renderHome();
      });
    });
  } else {
    title.textContent = currentPeriodType === 'week' ? 'Jump to week containing date' : 'Jump to date';
    const iso = currentAnchor.toISOString().slice(0, 10);
    content.innerHTML = `
      <label>Date</label>
      <input type="date" id="picker-date-input" value="${iso}">
      <button class="btn btn-primary" id="picker-date-go" style="width:100%;margin-top:14px">Go</button>`;
    document.getElementById('picker-date-go').addEventListener('click', () => {
      const val = document.getElementById('picker-date-input').value;
      if (!val) return;
      currentAnchor = parseDate(val);
      document.getElementById('period-picker-overlay').classList.remove('active');
      renderHome();
    });
  }
}

document.getElementById('period-label').addEventListener('click', openPeriodPicker);
document.getElementById('period-picker-cancel').addEventListener('click', () => {
  document.getElementById('period-picker-overlay').classList.remove('active');
});
document.getElementById('period-picker-overlay').addEventListener('click', (e) => {
  if (e.target.id === 'period-picker-overlay') document.getElementById('period-picker-overlay').classList.remove('active');
});

/* ---------- Transaction modal ---------- */
let editingId = null;
let modalType = 'expense';

function populateCategorySelect() {
  const sel = document.getElementById('txn-category');
  sel.innerHTML = state.categories[modalType].map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
}
function populateMethodSelect() {
  const sel = document.getElementById('txn-method');
  sel.innerHTML = state.accounts.map((a) => `<option value="${escapeHtml(a.name)}">${escapeHtml(a.name)}</option>`).join('');
}

function populateTransferSelects() {
  const opts = state.accounts.map((a) => `<option value="${escapeHtml(a.name)}">${escapeHtml(a.name)}</option>`).join('');
  document.getElementById('transfer-from').innerHTML = opts;
  document.getElementById('transfer-to').innerHTML = opts;
}

function setModalType(type) {
  modalType = type;
  document.getElementById('type-expense').classList.toggle('active', type === 'expense');
  document.getElementById('type-income').classList.toggle('active', type === 'income');
  document.getElementById('type-transfer').classList.toggle('active', type === 'transfer');
  const isTransfer = type === 'transfer';
  document.getElementById('category-wrap').style.display = isTransfer ? 'none' : 'block';
  document.getElementById('account-wrap').style.display = isTransfer ? 'none' : 'block';
  document.getElementById('transfer-wrap').style.display = isTransfer ? 'block' : 'none';
  if (isTransfer) populateTransferSelects();
  else populateCategorySelect();
  document.getElementById('installment-wrap').style.display = type === 'expense' && !editingId ? 'block' : 'none';
  if (type !== 'expense' || editingId) {
    document.getElementById('txn-installment').checked = false;
    document.getElementById('installment-fields').style.display = 'none';
  }
}

function installmentMonths() {
  const sel = document.getElementById('installment-months').value;
  if (sel === 'custom') return parseInt(document.getElementById('installment-months-custom').value, 10) || 0;
  return parseInt(sel, 10);
}

function updateInstallmentPreview() {
  const amount = evalAmount(document.getElementById('txn-amount').value) || 0;
  const months = installmentMonths();
  const interest = parseFloat(document.getElementById('installment-interest').value) || 0;
  const preview = document.getElementById('installment-preview');
  if (!amount || !months) { preview.textContent = ''; return; }
  const total = amount + amount * (interest / 100);
  const perMonth = total / months;
  preview.textContent = `${months} months of ${fmtMoney(perMonth)}${interest ? ` (total with interest: ${fmtMoney(total)})` : ''}`;
}

document.getElementById('txn-installment').addEventListener('change', (e) => {
  document.getElementById('installment-fields').style.display = e.target.checked ? 'block' : 'none';
  updateInstallmentPreview();
});
document.getElementById('installment-months').addEventListener('change', (e) => {
  document.getElementById('installment-months-custom').style.display = e.target.value === 'custom' ? 'block' : 'none';
  updateInstallmentPreview();
});
['txn-amount', 'installment-months-custom', 'installment-interest'].forEach((id) => {
  document.getElementById(id).addEventListener('input', updateInstallmentPreview);
});

document.getElementById('type-expense').addEventListener('click', () => setModalType('expense'));
document.getElementById('type-income').addEventListener('click', () => setModalType('income'));
document.getElementById('type-transfer').addEventListener('click', () => setModalType('transfer'));

function openTxnModal(id) {
  editingId = id || null;
  const overlay = document.getElementById('txn-modal-overlay');
  const delBtn = document.getElementById('txn-delete');
  populateMethodSelect();

  if (id) {
    const t = state.transactions.find((x) => x.id === id);
    document.getElementById('txn-modal-title').textContent = 'Edit transaction';
    setModalType(t.type);
    document.getElementById('txn-amount').value = t.amount;
    document.getElementById('txn-amount-preview').textContent = '';
    if (t.type === 'transfer') {
      document.getElementById('transfer-from').value = t.method;
      document.getElementById('transfer-to').value = t.toAccount;
    } else {
      populateCategorySelect();
      document.getElementById('txn-category').value = t.category;
      document.getElementById('txn-method').value = t.method;
    }
    document.getElementById('txn-date').value = t.date;
    document.getElementById('txn-note').value = t.note || '';
    delBtn.style.display = 'block';
  } else {
    document.getElementById('txn-modal-title').textContent = 'Add transaction';
    setModalType('expense');
    document.getElementById('txn-amount').value = '';
    document.getElementById('txn-amount-preview').textContent = '';
    document.getElementById('txn-date').value = todayStr();
    document.getElementById('txn-note').value = '';
    document.getElementById('txn-installment').checked = false;
    document.getElementById('installment-fields').style.display = 'none';
    document.getElementById('installment-months').value = '3';
    document.getElementById('installment-months-custom').value = '';
    document.getElementById('installment-months-custom').style.display = 'none';
    document.getElementById('installment-interest').value = '';
    document.getElementById('installment-preview').textContent = '';
    delBtn.style.display = 'none';
  }
  overlay.classList.add('active');
}

function closeTxnModal() {
  document.getElementById('txn-modal-overlay').classList.remove('active');
  editingId = null;
}

document.getElementById('fab-add').addEventListener('click', () => openTxnModal(null));
document.getElementById('txn-cancel').addEventListener('click', closeTxnModal);
document.getElementById('txn-modal-overlay').addEventListener('click', (e) => {
  if (e.target.id === 'txn-modal-overlay') closeTxnModal();
});

document.getElementById('txn-save').addEventListener('click', () => {
  const amount = Math.round(evalAmount(document.getElementById('txn-amount').value) * 100) / 100;
  if (!amount || amount <= 0) { toast('Enter a valid amount'); return; }
  const date = document.getElementById('txn-date').value || todayStr();
  const note = document.getElementById('txn-note').value.trim();
  const now = Date.now();

  if (modalType === 'transfer') {
    const from = document.getElementById('transfer-from').value;
    const to = document.getElementById('transfer-to').value;
    if (!from || !to || from === to) { toast('Pick two different accounts'); return; }
    if (editingId) {
      const t = state.transactions.find((x) => x.id === editingId);
      Object.assign(t, { type: 'transfer', amount, category: 'Transfer', method: from, toAccount: to, date, note, updatedAt: now });
      toast('Transfer updated');
    } else {
      state.transactions.push({ id: uid(), type: 'transfer', amount, category: 'Transfer', method: from, toAccount: to, date, note, createdAt: now, updatedAt: now });
      toast('Transfer recorded');
    }
    saveData();
    closeTxnModal();
    renderHome();
    return;
  }

  const category = document.getElementById('txn-category').value;
  const method = document.getElementById('txn-method').value;

  if (editingId) {
    const t = state.transactions.find((x) => x.id === editingId);
    Object.assign(t, { type: modalType, amount, category, method, date, note, updatedAt: now, toAccount: undefined });
    toast('Transaction updated');
  } else if (modalType === 'expense' && document.getElementById('txn-installment').checked) {
    const months = installmentMonths();
    if (!months || months < 2) { toast('Enter a valid number of months'); return; }
    const interest = parseFloat(document.getElementById('installment-interest').value) || 0;
    const total = amount + amount * (interest / 100);
    const perMonth = Math.round((total / months) * 100) / 100;
    const installmentId = uid();
    const startDate = parseDate(date);
    for (let i = 0; i < months; i++) {
      const d = new Date(startDate);
      d.setMonth(d.getMonth() + i);
      const isLast = i === months - 1;
      const roundedSoFar = perMonth * i;
      const thisAmount = isLast ? Math.round((total - roundedSoFar) * 100) / 100 : perMonth;
      state.transactions.push({
        id: uid(), type: 'expense', amount: thisAmount, category, method,
        date: d.toISOString().slice(0, 10),
        note: `${note ? note + ' ' : ''}(installment ${i + 1}/${months})`.trim(),
        installmentId, installmentIndex: i + 1, installmentTotal: months,
        createdAt: now, updatedAt: now,
      });
    }
    toast(`Added ${months}-month installment plan`);
  } else {
    state.transactions.push({ id: uid(), type: modalType, amount, category, method, date, note, createdAt: now, updatedAt: now });
    toast('Transaction added');
  }
  saveData();
  closeTxnModal();
  renderHome();
});

document.getElementById('txn-delete').addEventListener('click', () => {
  if (!editingId) return;
  state.transactions = state.transactions.filter((x) => x.id !== editingId);
  saveData();
  toast('Transaction deleted');
  closeTxnModal();
  renderHome();
});

/* ---------- Audit view ---------- */
function populateAuditFilters() {
  const methodSel = document.getElementById('audit-method-filter');
  const catSel = document.getElementById('audit-cat-filter');
  methodSel.innerHTML = '<option value="">All</option>' + state.accounts.map((a) => `<option value="${escapeHtml(a.name)}">${escapeHtml(a.name)}</option>`).join('');
  const allCats = [...new Set([...state.categories.expense, ...state.categories.income])];
  catSel.innerHTML = '<option value="">All</option>' + allCats.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
}

function renderAudit() {
  populateAuditFilters();
  applyAuditFilters();
}

function applyAuditFilters() {
  const q = document.getElementById('audit-search').value.trim().toLowerCase();
  const method = document.getElementById('audit-method-filter').value;
  const cat = document.getElementById('audit-cat-filter').value;
  const from = document.getElementById('audit-from').value;
  const to = document.getElementById('audit-to').value;

  let results = state.transactions.filter((t) => {
    if (q && !(t.category.toLowerCase().includes(q) || (t.note || '').toLowerCase().includes(q))) return false;
    if (method && t.method !== method && t.toAccount !== method) return false;
    if (cat && t.category !== cat) return false;
    if (from && t.date < from) return false;
    if (to && t.date > to) return false;
    return true;
  });

  document.getElementById('audit-count').textContent = results.length;
  renderTxnList(results, 'audit-list', 'audit-empty');
}

['audit-search', 'audit-method-filter', 'audit-cat-filter', 'audit-from', 'audit-to'].forEach((id) => {
  document.getElementById(id).addEventListener('input', applyAuditFilters);
});

/* ---------- Settings view ---------- */
function renderSettings() {
  renderChipList('cat-expense-list', state.categories.expense, (val) => removeCategory('expense', val));
  renderChipList('cat-income-list', state.categories.income, (val) => removeCategory('income', val));
  document.getElementById('gemini-key').value = state.geminiKey || '';
  renderBudgetSettings();
  renderChipList('bill-name-list', state.billNames, removeBillName);
}

function removeBillName(val) {
  const inUse = state.bills.some((b) => b.name === val);
  if (inUse && !confirm(`"${val}" is used by existing bills. Remove it from the list anyway? Existing bills keep this name.`)) return;
  state.billNames = state.billNames.filter((n) => n !== val);
  saveData();
  renderSettings();
}

document.getElementById('add-bill-name').addEventListener('click', () => {
  const input = document.getElementById('new-bill-name');
  const val = input.value.trim();
  if (val && !state.billNames.includes(val)) {
    state.billNames.push(val);
    saveData();
    input.value = '';
    renderSettings();
  }
});

function renderBudgetSettings() {
  document.getElementById('budget-overall').value = state.budgets.overall != null ? state.budgets.overall : '';
  const container = document.getElementById('budget-category-fields');
  container.innerHTML = state.categories.expense.map((c) => `
    <div class="budget-cat-field">
      <span>${escapeHtml(c)}</span>
      <input type="number" inputmode="decimal" step="0.01" data-cat="${escapeHtml(c)}" value="${state.budgets.categories[c] != null ? state.budgets.categories[c] : ''}" placeholder="0.00">
    </div>
  `).join('');
}

document.getElementById('btn-save-budgets').addEventListener('click', () => {
  const overallVal = document.getElementById('budget-overall').value;
  state.budgets.overall = overallVal === '' ? null : parseFloat(overallVal);
  const cats = {};
  document.querySelectorAll('#budget-category-fields input').forEach((inp) => {
    if (inp.value !== '') cats[inp.dataset.cat] = parseFloat(inp.value);
  });
  state.budgets.categories = cats;
  saveData();
  toast('Budgets saved');
  renderHome();
});

function renderChipList(elId, items, onRemove) {
  const el = document.getElementById(elId);
  el.innerHTML = items.map((it) => `<span class="chip">${escapeHtml(it)}<span class="del" data-val="${escapeHtml(it)}">✕</span></span>`).join('');
  el.querySelectorAll('.del').forEach((d) => d.addEventListener('click', () => onRemove(d.dataset.val)));
}

function removeCategory(type, val) {
  const inUse = state.transactions.some((t) => t.type === type && t.category === val);
  if (inUse && !confirm(`"${val}" is used by existing transactions. Remove it from the category list anyway? Past transactions keep this category.`)) return;
  state.categories[type] = state.categories[type].filter((c) => c !== val);
  saveData();
  renderSettings();
}

document.getElementById('add-cat-expense').addEventListener('click', () => {
  const input = document.getElementById('new-cat-expense');
  const val = input.value.trim();
  if (val && !state.categories.expense.includes(val)) {
    state.categories.expense.push(val);
    saveData();
    input.value = '';
    renderSettings();
  }
});
document.getElementById('add-cat-income').addEventListener('click', () => {
  const input = document.getElementById('new-cat-income');
  const val = input.value.trim();
  if (val && !state.categories.income.includes(val)) {
    state.categories.income.push(val);
    saveData();
    input.value = '';
    renderSettings();
  }
});
document.getElementById('btn-save-key').addEventListener('click', () => {
  state.geminiKey = document.getElementById('gemini-key').value.trim();
  saveData();
  toast('API key saved');
});

document.getElementById('btn-clear-all').addEventListener('click', () => {
  if (confirm('This will permanently erase all transactions, categories, and settings on this device. Continue?')) {
    if (confirm('Are you absolutely sure? This cannot be undone.')) {
      state = structuredClone(DEFAULT_DATA);
      saveData();
      toast('All data erased');
      switchView('home');
    }
  }
});

/* ---------- CSV export ---------- */
function csvEscape(v) {
  const s = String(v ?? '');
  if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function exportCsv() {
  const header = ['Date', 'Type', 'Amount', 'Category', 'Account', 'Transfer To', 'Note'];
  const rows = [...state.transactions]
    .sort((a, b) => (a.date < b.date ? -1 : 1))
    .map((t) => [t.date, t.type, t.amount, t.category, t.method, t.toAccount || '', t.note || '']);
  const csv = [header, ...rows].map((r) => r.map(csvEscape).join(',')).join('\r\n');
  downloadFile('﻿' + csv, `finance-tracker-export-${todayStr()}.csv`, 'text/csv;charset=utf-8;');
  toast('CSV exported');
}

function downloadFile(content, filename, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

document.getElementById('btn-export-csv').addEventListener('click', exportCsv);

/* ---------- JSON backup / restore ---------- */
document.getElementById('btn-backup-json').addEventListener('click', () => {
  downloadFile(JSON.stringify(state, null, 2), `finance-tracker-backup-${todayStr()}.json`, 'application/json');
  toast('Backup downloaded');
});

document.getElementById('restore-file').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = JSON.parse(reader.result);
      if (!parsed.transactions) throw new Error('Invalid backup file');
      if (confirm('Restoring will replace all current data on this device. Continue?')) {
        state = {
          transactions: parsed.transactions || [],
          categories: parsed.categories || DEFAULT_DATA.categories,
          methods: parsed.methods || DEFAULT_DATA.methods,
          accounts: parsed.accounts || DEFAULT_DATA.accounts,
          bills: parsed.bills || [],
          billNames: parsed.billNames || DEFAULT_DATA.billNames,
          geminiKey: parsed.geminiKey || parsed.openaiKey || '',
          budgets: parsed.budgets || { overall: null, categories: {} },
        };
        saveData();
        toast('Backup restored');
        switchView('home');
      }
    } catch (err) {
      alert('Could not read this backup file: ' + err.message);
    }
  };
  reader.readAsText(file);
  e.target.value = '';
});

/* ---------- CSV import with column mapping ---------- */
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(field); field = '';
        if (row.length > 1 || row[0] !== '') rows.push(row);
        row = [];
      } else field += c;
    }
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

let importRows = null; // {headers, data}

const IMPORT_FIELDS = [
  { key: 'date', label: 'Date', required: true },
  { key: 'amount', label: 'Amount', required: true },
  { key: 'type', label: 'Type (income/expense) — optional, inferred from sign if omitted', required: false },
  { key: 'category', label: 'Category', required: false },
  { key: 'method', label: 'Payment method', required: false },
  { key: 'note', label: 'Note', required: false },
];

document.getElementById('import-file').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    const rows = parseCsv(reader.result).filter((r) => r.some((c) => c.trim() !== ''));
    if (rows.length < 2) { alert('This file has no data rows.'); return; }
    const headers = rows[0];
    const data = rows.slice(1);
    importRows = { headers, data };
    openImportModal(headers, data);
  };
  reader.readAsText(file);
  e.target.value = '';
});

function openImportModal(headers, data) {
  const container = document.getElementById('import-mapping-fields');
  container.innerHTML = IMPORT_FIELDS.map((f) => {
    const guessIdx = headers.findIndex((h) => h.toLowerCase().includes(f.key));
    const options = ['<option value="">-- none --</option>']
      .concat(headers.map((h, i) => `<option value="${i}" ${i === guessIdx ? 'selected' : ''}>${escapeHtml(h)}</option>`));
    return `<label>${f.label}${f.required ? ' *' : ''}</label><select data-field="${f.key}">${options.join('')}</select>`;
  }).join('');
  document.getElementById('import-preview-note').textContent = `${data.length} rows detected. Fields marked * are required.`;
  document.getElementById('import-modal-overlay').classList.add('active');
}

document.getElementById('import-cancel').addEventListener('click', () => {
  document.getElementById('import-modal-overlay').classList.remove('active');
  importRows = null;
});

document.getElementById('import-confirm').addEventListener('click', () => {
  if (!importRows) return;
  const mapping = {};
  document.querySelectorAll('#import-mapping-fields select').forEach((sel) => {
    mapping[sel.dataset.field] = sel.value === '' ? null : parseInt(sel.value, 10);
  });
  if (mapping.date == null || mapping.amount == null) {
    alert('Date and Amount are required.');
    return;
  }

  let added = 0, skipped = 0;
  const now = Date.now();
  for (const row of importRows.data) {
    const rawDate = row[mapping.date]?.trim();
    const rawAmount = row[mapping.amount]?.trim();
    const date = normalizeDate(rawDate);
    const amountNum = parseFloat((rawAmount || '').replace(/[^0-9.\-]/g, ''));
    if (!date || isNaN(amountNum)) { skipped++; continue; }

    let type = mapping.type != null ? (row[mapping.type] || '').trim().toLowerCase() : '';
    if (type.startsWith('inc')) type = 'income';
    else if (type.startsWith('exp')) type = 'expense';
    else type = amountNum < 0 ? 'expense' : 'income';

    const category = mapping.category != null ? (row[mapping.category]?.trim() || 'Uncategorized') : 'Uncategorized';
    const method = mapping.method != null ? (row[mapping.method]?.trim() || 'Unknown') : 'Unknown';
    const note = mapping.note != null ? (row[mapping.note]?.trim() || '') : '';

    if (type === 'expense' && !state.categories.expense.includes(category)) state.categories.expense.push(category);
    if (type === 'income' && !state.categories.income.includes(category)) state.categories.income.push(category);
    if (!state.accounts.some((a) => a.name === method)) state.accounts.push({ name: method, kind: 'asset', initialBalance: 0 });

    state.transactions.push({
      id: uid(), type, amount: Math.abs(amountNum), category, method, date, note, createdAt: now, updatedAt: now,
    });
    added++;
  }
  saveData();
  document.getElementById('import-modal-overlay').classList.remove('active');
  importRows = null;
  toast(`Imported ${added} transactions${skipped ? `, skipped ${skipped}` : ''}`);
  switchView('home');
});

function normalizeDate(str) {
  if (!str) return null;
  // Already ISO
  if (/^\d{4}-\d{2}-\d{2}/.test(str)) return str.slice(0, 10);
  // M/D/YYYY or D/M/YYYY or with dashes
  const m = str.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (m) {
    let [, a, b, y] = m;
    if (y.length === 2) y = '20' + y;
    // Assume M/D/YYYY (US Excel default); if first part > 12, swap
    let month = parseInt(a, 10), day = parseInt(b, 10);
    if (month > 12) { [month, day] = [day, month]; }
    return `${y}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }
  const d = new Date(str);
  if (!isNaN(d)) return d.toISOString().slice(0, 10);
  return null;
}

/* ---------- Accounts / net worth ---------- */
function accrueInterestForAccount(acc) {
  if (!acc.interestRate) return false;
  const today = todayStr();
  const last = acc.lastInterestDate || today;
  if (last >= today) return false;
  const days = Math.round((parseDate(today) - parseDate(last)) / 86400000);
  if (days <= 0) { acc.lastInterestDate = today; return false; }

  const principal = accountBalance(acc);
  const dailyRate = acc.interestRate / 100 / 365;
  const interestAmt = Math.round((principal * (Math.pow(1 + dailyRate, days) - 1)) * 100) / 100;
  acc.lastInterestDate = today;
  if (interestAmt === 0) return false;

  const isLiability = acc.kind === 'liability';
  const catList = isLiability ? state.categories.expense : state.categories.income;
  if (!catList.includes('Interest')) catList.push('Interest');

  state.transactions.push({
    id: uid(),
    type: isLiability ? 'expense' : 'income',
    amount: Math.abs(interestAmt),
    category: 'Interest',
    method: acc.name,
    date: today,
    note: `Auto-accrued interest (${days} day${days > 1 ? 's' : ''} @ ${acc.interestRate}% APY)`,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  return true;
}

function accrueAllInterest() {
  let changed = false;
  for (const acc of state.accounts) {
    if (accrueInterestForAccount(acc)) changed = true;
  }
  if (changed) saveData();
}

function accountBalance(account) {
  let bal = account.initialBalance || 0;
  const today = todayStr();
  for (const t of state.transactions) {
    if (t.date > today) continue; // future-dated transactions (e.g. upcoming installments) don't count toward the CURRENT balance yet
    if (t.type === 'transfer') {
      const isLiability = account.kind === 'liability';
      if (t.method === account.name) bal += isLiability ? t.amount : -t.amount; // money leaving this account
      if (t.toAccount === account.name) bal += isLiability ? -t.amount : t.amount; // money arriving
      continue;
    }
    if (t.method !== account.name) continue;
    if (account.kind === 'liability') {
      bal += t.type === 'expense' ? t.amount : -t.amount;
    } else {
      bal += t.type === 'income' ? t.amount : -t.amount;
    }
  }
  return bal;
}

function renderAccounts() {
  let assets = 0, liabilities = 0;
  const list = document.getElementById('account-list');
  const empty = document.getElementById('account-empty');

  const withBalances = state.accounts.map((a) => ({ account: a, bal: accountBalance(a) }));
  withBalances.sort((x, y) => y.bal - x.bal);

  const rows = withBalances.map(({ account: a, bal }) => {
    if (a.kind === 'asset') assets += bal;
    else liabilities += bal;
    const metaParts = [a.kind === 'liability' ? 'Liability' : 'Asset'];
    if (a.kind === 'liability' && a.creditLimit) metaParts.push(`Limit ${fmtMoney(a.creditLimit)} · Available ${fmtMoney(a.creditLimit - bal)}`);
    if (a.interestRate) metaParts.push(`${a.interestRate}% APY`);
    return `<li class="txn-item" data-name="${escapeHtml(a.name)}">
      <div class="txn-main">
        <div class="txn-cat">${escapeHtml(a.name)}</div>
        <div class="txn-meta">${metaParts.join(' · ')}</div>
      </div>
      <div class="txn-amt ${a.kind === 'liability' ? 'expense' : 'income'}">${fmtMoney(bal)}</div>
    </li>`;
  });

  list.innerHTML = rows.join('');
  empty.style.display = rows.length ? 'none' : 'block';
  list.querySelectorAll('.txn-item').forEach((el) => {
    el.addEventListener('click', () => openAccountModal(el.dataset.name));
  });

  document.getElementById('nw-assets').textContent = fmtMoney(assets);
  document.getElementById('nw-liabilities').textContent = fmtMoney(liabilities);
  const net = assets - liabilities;
  const netEl = document.getElementById('nw-total');
  netEl.textContent = fmtMoney(net);
  netEl.className = net >= 0 ? 'income' : 'expense';
}

let editingAccountName = null;

function openAccountModal(name) {
  editingAccountName = name || null;
  const delBtn = document.getElementById('account-delete');
  const nameInput = document.getElementById('account-name');
  const kindSel = document.getElementById('account-kind');
  const balInput = document.getElementById('account-balance');
  const limitInput = document.getElementById('account-limit');
  const interestInput = document.getElementById('account-interest-rate');

  if (name) {
    const a = state.accounts.find((x) => x.name === name);
    document.getElementById('account-modal-title').textContent = 'Edit account';
    nameInput.value = a.name;
    kindSel.value = a.kind;
    balInput.value = a.initialBalance;
    limitInput.value = a.creditLimit || '';
    interestInput.value = a.interestRate || '';
    delBtn.style.display = 'block';
  } else {
    document.getElementById('account-modal-title').textContent = 'Add account';
    nameInput.value = '';
    kindSel.value = 'asset';
    balInput.value = '';
    limitInput.value = '';
    interestInput.value = '';
    delBtn.style.display = 'none';
  }
  updateAccountKindUI();
  document.getElementById('account-modal-overlay').classList.add('active');
}

function updateAccountKindUI() {
  const kind = document.getElementById('account-kind').value;
  document.getElementById('account-limit-wrap').style.display = kind === 'liability' ? 'block' : 'none';
  document.getElementById('account-balance-label').textContent = kind === 'liability' ? 'Current balance owed' : 'Opening balance';
}
document.getElementById('account-kind').addEventListener('change', updateAccountKindUI);

document.getElementById('btn-add-account').addEventListener('click', () => openAccountModal(null));
document.getElementById('account-cancel').addEventListener('click', () => {
  document.getElementById('account-modal-overlay').classList.remove('active');
  editingAccountName = null;
});
document.getElementById('account-modal-overlay').addEventListener('click', (e) => {
  if (e.target.id === 'account-modal-overlay') document.getElementById('account-modal-overlay').classList.remove('active');
});

document.getElementById('account-save').addEventListener('click', () => {
  const name = document.getElementById('account-name').value.trim();
  if (!name) { toast('Enter an account name'); return; }
  const kind = document.getElementById('account-kind').value;
  const initialBalance = parseFloat(document.getElementById('account-balance').value) || 0;
  const creditLimit = kind === 'liability' ? (parseFloat(document.getElementById('account-limit').value) || 0) : undefined;
  const interestRateRaw = document.getElementById('account-interest-rate').value;
  const interestRate = interestRateRaw !== '' ? parseFloat(interestRateRaw) : undefined;

  if (editingAccountName) {
    const a = state.accounts.find((x) => x.name === editingAccountName);
    if (name !== editingAccountName && state.accounts.some((x) => x.name === name)) { toast('An account with that name already exists'); return; }
    if (name !== editingAccountName) {
      state.transactions.forEach((t) => { if (t.method === editingAccountName) t.method = name; });
    }
    const hadRate = !!a.interestRate;
    Object.assign(a, { name, kind, initialBalance, creditLimit, interestRate });
    if (interestRate && !hadRate) a.lastInterestDate = todayStr();
    if (!interestRate) delete a.lastInterestDate;
  } else {
    if (state.accounts.some((x) => x.name === name)) { toast('An account with that name already exists'); return; }
    const newAccount = { name, kind, initialBalance, creditLimit, interestRate };
    if (interestRate) newAccount.lastInterestDate = todayStr();
    state.accounts.push(newAccount);
  }
  saveData();
  document.getElementById('account-modal-overlay').classList.remove('active');
  editingAccountName = null;
  renderAccounts();
});

document.getElementById('account-delete').addEventListener('click', () => {
  if (!editingAccountName) return;
  const inUse = state.transactions.some((t) => t.method === editingAccountName);
  if (inUse && !confirm(`"${editingAccountName}" is used by existing transactions. Delete it anyway? Past transactions keep this account name.`)) return;
  state.accounts = state.accounts.filter((a) => a.name !== editingAccountName);
  saveData();
  document.getElementById('account-modal-overlay').classList.remove('active');
  editingAccountName = null;
  renderAccounts();
});

/* ---------- Bills ---------- */
function nextDueDate(dateStr, recurring) {
  const d = parseDate(dateStr);
  if (recurring === 'weekly') d.setDate(d.getDate() + 7);
  else if (recurring === 'monthly') d.setMonth(d.getMonth() + 1);
  else if (recurring === 'yearly') d.setFullYear(d.getFullYear() + 1);
  return d.toISOString().slice(0, 10);
}

let currentBillTab = 'due';

function billBucket(b, today) {
  if (b.status === 'paid') return 'paid';
  const dueSoonCutoff = shiftAnchor('day', parseDate(today), 7).toISOString().slice(0, 10);
  if (b.dueDate <= dueSoonCutoff) return 'due'; // overdue + due within 7 days
  return 'pending';
}

const BILLS_TITLE = { due: 'Due & overdue', pending: 'Upcoming (not due yet)', paid: 'Paid' };
const BILLS_EMPTY = { due: 'Nothing due soon.', pending: 'No upcoming bills further out.', paid: 'No paid bills yet.' };

document.querySelectorAll('#bills-tabs button').forEach((btn) => {
  btn.addEventListener('click', () => {
    currentBillTab = btn.dataset.billTab;
    document.querySelectorAll('#bills-tabs button').forEach((b) => b.classList.toggle('active', b === btn));
    renderBills();
  });
});

function updateBillTabBadges() {
  const today = todayStr();
  const counts = { due: 0, pending: 0, paid: 0 };
  for (const b of state.bills) counts[billBucket(b, today)]++;
  document.getElementById('badge-due').textContent = counts.due || '';
  document.getElementById('badge-pending').textContent = counts.pending || '';
  document.getElementById('badge-paid').textContent = counts.paid || '';
  document.getElementById('badge-due').classList.toggle('warn', counts.due > 0);
}

function renderBills() {
  const list = document.getElementById('bills-list');
  const empty = document.getElementById('bills-empty');
  const today = todayStr();
  updateBillTabBadges();
  document.getElementById('bills-list-title').textContent = BILLS_TITLE[currentBillTab];
  empty.textContent = BILLS_EMPTY[currentBillTab];

  const filtered = state.bills.filter((b) => billBucket(b, today) === currentBillTab);
  const sorted = filtered.sort((a, b) => (a.dueDate < b.dueDate ? -1 : 1));

  list.innerHTML = sorted.map((b) => {
    const overdue = b.status === 'pending' && b.dueDate < today;
    const dueSoon = b.status === 'pending' && !overdue && b.dueDate <= shiftAnchor('day', parseDate(today), 7).toISOString().slice(0, 10);
    const statusColor = b.status === 'paid' ? 'var(--income)' : overdue ? 'var(--expense)' : dueSoon ? '#fbbf24' : 'var(--muted)';
    const statusLabel = b.status === 'paid' ? 'Paid' : overdue ? 'Overdue' : dueSoon ? 'Due soon' : 'Pending';
    return `<li class="txn-item" data-id="${b.id}">
      <div class="txn-main">
        <div class="txn-cat">${escapeHtml(b.name)}</div>
        <div class="txn-meta">Due ${parseDate(b.dueDate).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}${b.recurring !== 'none' ? ` · repeats ${b.recurring}` : ''} · <span style="color:${statusColor}">${statusLabel}</span></div>
      </div>
      <div class="txn-amt expense">${fmtMoney(b.amount)}</div>
    </li>`;
  }).join('');
  empty.style.display = sorted.length ? 'none' : 'block';
  list.querySelectorAll('.txn-item').forEach((el) => {
    el.addEventListener('click', () => openBillModal(el.dataset.id));
  });
}

let editingBillId = null;

function populateBillNameSelect(selected) {
  const sel = document.getElementById('bill-name');
  const names = [...state.billNames];
  if (selected && !names.includes(selected)) names.push(selected);
  sel.innerHTML = names.map((n) => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join('')
    + `<option value="__new__">➕ Add new bill name…</option>`;
  if (selected) sel.value = selected;
}

document.getElementById('bill-name').addEventListener('change', (e) => {
  if (e.target.value !== '__new__') return;
  const name = prompt('New bill name (e.g. Internet):');
  const trimmed = (name || '').trim();
  if (!trimmed) { populateBillNameSelect(); return; }
  if (!state.billNames.includes(trimmed)) {
    state.billNames.push(trimmed);
    saveData();
  }
  populateBillNameSelect(trimmed);
});

function populateBillCategorySelect() {
  const sel = document.getElementById('bill-category');
  sel.innerHTML = state.categories.expense.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
}
function populateBillAccountSelect() {
  const sel = document.getElementById('bill-pay-account');
  sel.innerHTML = state.accounts.map((a) => `<option value="${escapeHtml(a.name)}">${escapeHtml(a.name)}</option>`).join('');
}

function openBillModal(id) {
  editingBillId = id || null;
  const delBtn = document.getElementById('bill-delete');
  const payWrap = document.getElementById('bill-pay-wrap');
  document.getElementById('bill-mark-paid').disabled = false;
  populateBillCategorySelect();
  populateBillAccountSelect();

  if (id) {
    const b = state.bills.find((x) => x.id === id);
    document.getElementById('bill-modal-title').textContent = 'Edit bill';
    populateBillNameSelect(b.name);
    document.getElementById('bill-amount').value = b.amount;
    document.getElementById('bill-due').value = b.dueDate;
    document.getElementById('bill-recurring').value = b.recurring;
    document.getElementById('bill-note').value = b.note || '';
    if (b.category && [...document.getElementById('bill-category').options].some((o) => o.value === b.category)) {
      document.getElementById('bill-category').value = b.category;
    }
    if (b.account && [...document.getElementById('bill-pay-account').options].some((o) => o.value === b.account)) {
      document.getElementById('bill-pay-account').value = b.account;
    }
    delBtn.style.display = 'block';
    payWrap.style.display = b.status === 'pending' ? 'block' : 'none';
  } else {
    document.getElementById('bill-modal-title').textContent = 'Add bill';
    populateBillNameSelect();
    document.getElementById('bill-amount').value = '';
    document.getElementById('bill-due').value = todayStr();
    document.getElementById('bill-recurring').value = 'none';
    document.getElementById('bill-note').value = '';
    delBtn.style.display = 'none';
    payWrap.style.display = 'none';
  }
  document.getElementById('bill-modal-overlay').classList.add('active');
}

document.getElementById('btn-add-bill').addEventListener('click', () => openBillModal(null));
document.getElementById('bill-cancel').addEventListener('click', () => {
  document.getElementById('bill-modal-overlay').classList.remove('active');
  editingBillId = null;
});
document.getElementById('bill-modal-overlay').addEventListener('click', (e) => {
  if (e.target.id === 'bill-modal-overlay') document.getElementById('bill-modal-overlay').classList.remove('active');
});

document.getElementById('bill-save').addEventListener('click', () => {
  const name = document.getElementById('bill-name').value.trim();
  const amount = parseFloat(document.getElementById('bill-amount').value);
  const dueDate = document.getElementById('bill-due').value;
  const recurring = document.getElementById('bill-recurring').value;
  const note = document.getElementById('bill-note').value.trim();
  const category = document.getElementById('bill-category').value;
  if (!name || !amount || amount <= 0 || !dueDate) { toast('Fill in name, amount, and due date'); return; }

  if (editingBillId) {
    const b = state.bills.find((x) => x.id === editingBillId);
    Object.assign(b, { name, amount, dueDate, recurring, note, category });
    toast('Bill updated');
  } else {
    state.bills.push({ id: uid(), name, amount, dueDate, recurring, note, category, status: 'pending', createdAt: Date.now() });
    toast('Bill added');
  }
  saveData();
  document.getElementById('bill-modal-overlay').classList.remove('active');
  editingBillId = null;
  renderBills();
});

document.getElementById('bill-delete').addEventListener('click', () => {
  if (!editingBillId) return;
  state.bills = state.bills.filter((x) => x.id !== editingBillId);
  saveData();
  document.getElementById('bill-modal-overlay').classList.remove('active');
  editingBillId = null;
  toast('Bill deleted');
  renderBills();
});

document.getElementById('bill-mark-paid').addEventListener('click', (e) => {
  if (!editingBillId) return;
  const btn = e.currentTarget;
  if (btn.disabled) return; // guard against double-tap / double-fire creating duplicate transactions
  const b = state.bills.find((x) => x.id === editingBillId);
  if (!b || b.status === 'paid') return;
  btn.disabled = true;
  const account = document.getElementById('bill-pay-account').value;
  const category = document.getElementById('bill-category').value;
  const amount = parseFloat(document.getElementById('bill-amount').value) || b.amount;
  const dueDate = document.getElementById('bill-due').value || b.dueDate;
  if (!account) { toast('Pick an account to pay from'); btn.disabled = false; return; }

  const now = Date.now();
  const paidDate = todayStr();
  state.transactions.push({
    id: uid(), type: 'expense', amount, category, method: account,
    date: paidDate, note: `Bill payment: ${b.name}${b.note ? ' - ' + b.note : ''}`,
    createdAt: now, updatedAt: now,
  });

  b.status = 'paid';
  b.amount = amount;
  b.category = category;
  b.account = account;
  b.dueDate = dueDate;
  b.paidDate = paidDate;

  if (b.recurring !== 'none') {
    const nextDate = nextDueDate(dueDate, b.recurring);
    state.bills.push({
      id: uid(), name: b.name, amount: b.amount, category: b.category, account: b.account,
      dueDate: nextDate, recurring: b.recurring, note: b.note, status: 'pending', createdAt: now,
    });
  }

  saveData();
  document.getElementById('bill-modal-overlay').classList.remove('active');
  editingBillId = null;
  toast('Bill marked as paid and recorded as a transaction');
  renderBills();
});

/* ---------- AI chart insights (optional, online-only) ---------- */
document.getElementById('btn-ai-insight').addEventListener('click', async () => {
  const box = document.getElementById('ai-insight-box');
  if (!state.geminiKey) {
    box.style.display = 'block';
    box.textContent = 'Add your Gemini API key in Settings to enable this feature.';
    return;
  }
  if (!navigator.onLine) {
    box.style.display = 'block';
    box.textContent = 'You appear to be offline. AI insights need an internet connection.';
    return;
  }
  const { start, end } = periodRange(currentPeriodType, currentAnchor);
  const txns = state.transactions.filter((t) => inRange(t.date, start, end));
  let income = 0, expense = 0;
  const byCat = {};
  for (const t of txns) {
    if (t.type === 'income') income += t.amount;
    else { expense += t.amount; byCat[t.category] = (byCat[t.category] || 0) + t.amount; }
  }
  const summary = {
    period: periodLabel(currentPeriodType, currentAnchor),
    income: Math.round(income * 100) / 100,
    expense: Math.round(expense * 100) / 100,
    byCategory: Object.fromEntries(Object.entries(byCat).map(([k, v]) => [k, Math.round(v * 100) / 100])),
  };

  box.style.display = 'block';
  box.textContent = 'Thinking…';

  try {
    const model = 'gemini-2.0-flash';
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(state.geminiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: {
            parts: [{ text: 'You are a concise personal finance assistant. Given aggregated spending totals for a period, give a 2-4 sentence plain-language insight: notable patterns, biggest category, and one practical suggestion. No markdown.' }],
          },
          contents: [{ parts: [{ text: JSON.stringify(summary) }] }],
          generationConfig: { maxOutputTokens: 200 },
        }),
      }
    );
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`API error ${res.status}: ${errText.slice(0, 200)}`);
    }
    const data = await res.json();
    box.textContent = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || 'No insight returned.';
  } catch (err) {
    box.textContent = 'Could not get an insight: ' + err.message;
  }
});

/* ---------- Service worker registration (with auto-update) ---------- */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').then((reg) => {
      reg.addEventListener('updatefound', () => {
        const newWorker = reg.installing;
        newWorker?.addEventListener('statechange', () => {
          if (newWorker.state === 'activated') {
            toast('Updated to the latest version');
          }
        });
      });
      // Check for a newer service worker every time the app is opened.
      reg.update().catch(() => {});
    }).catch((e) => console.error('SW registration failed', e));

    let refreshedOnce = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (refreshedOnce) return;
      refreshedOnce = true;
      location.reload();
    });
  });
}

/* ---------- Init ---------- */
document.getElementById('txn-date').value = todayStr();
accrueAllInterest();
renderHome();
