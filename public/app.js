/* ── Firebase REST helpers ──────────────────────────────────────────────── */
const DB  = () => FIREBASE_DB_URL;
const get    = url => fetch(url + '.json').then(r => r.json());
const post   = (url, data) => fetch(url + '.json', { method: 'POST',   body: JSON.stringify(data) }).then(r => r.json());
const put    = (url, data) => fetch(url + '.json', { method: 'PUT',    body: JSON.stringify(data) }).then(r => r.json());
const patch  = (url, data) => fetch(url + '.json', { method: 'PATCH',  body: JSON.stringify(data) }).then(r => r.json());
const del    = url          => fetch(url + '.json', { method: 'DELETE' }).then(r => r.json());

/* ── Convert receipt to base64 data URL (stored in DB, no Storage needed) ── */
async function uploadFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });
}

/* ── Toast ──────────────────────────────────────────────────────────────── */
function showToast(message, type = 'success') {
  const t = document.createElement('div');
  t.className = 'toast-msg' + (type === 'error' ? ' error' : '');
  t.textContent = message;
  document.getElementById('toast').appendChild(t);
  setTimeout(() => { t.classList.add('fade-out'); setTimeout(() => t.remove(), 400); }, 2500);
}

/* ── Formatters ─────────────────────────────────────────────────────────── */
function fmtMoney(n) {
  return '₱' + Number(n).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function monthLabel(ym) {
  const [y, m] = ym.split('-');
  return new Date(y, m - 1).toLocaleString('en-US', { month: 'short', year: 'numeric' });
}

/* ── Category helpers ───────────────────────────────────────────────────── */
const GROUPS = ['Supplies & Ingredients', 'Utilities', 'Salary', 'Other OpEx', 'Miscellaneous'];

const SEED_CATEGORIES = [
  { group: 'Supplies & Ingredients', name: 'Cakes' },
  { group: 'Supplies & Ingredients', name: 'Coffee Beans' },
  { group: 'Supplies & Ingredients', name: 'Cups & Lids' },
  { group: 'Supplies & Ingredients', name: 'Dumbo Eggs' },
  { group: 'Supplies & Ingredients', name: 'Ice' },
  { group: 'Supplies & Ingredients', name: 'JPS Meat Supplier' },
  { group: 'Supplies & Ingredients', name: 'Restaurant Depot' },
  { group: 'Supplies & Ingredients', name: 'Supplier-IJMCI' },
  { group: 'Supplies & Ingredients', name: 'Supplier-IZEAL' },
  { group: 'Supplies & Ingredients', name: 'Supplier-MasterWrap' },
  { group: 'Supplies & Ingredients', name: 'Tatuts Donuts' },
  { group: 'Supplies & Ingredients', name: 'Veggies/Fruits' },
  { group: 'Supplies & Ingredients', name: 'Water- Stream Breeze' },
  { group: 'Utilities', name: 'Maynilad' },
  { group: 'Utilities', name: 'Meralco' },
  { group: 'Utilities', name: 'PLDT' },
  { group: 'Salary', name: 'Staff Salary' },
  { group: 'Other OpEx', name: 'Accounting' },
  { group: 'Other OpEx', name: 'Marketing' },
  { group: 'Other OpEx', name: 'Permits' },
  { group: 'Other OpEx', name: 'Tax' },
  { group: 'Miscellaneous', name: 'Deliveries' },
  { group: 'Miscellaneous', name: 'Others' },
];

let categories = {}; // { firebaseKey: { group, name } }
let expenses   = {}; // { firebaseKey: { date, category_id, description, amount, receipt_url, created_at } }

/* ── Load & seed categories ─────────────────────────────────────────────── */
async function loadCategories() {
  const data = await get(DB() + '/categories');
  categories = data || {};

  // Seed if empty
  if (Object.keys(categories).length === 0) {
    for (const c of SEED_CATEGORIES) {
      const res = await post(DB() + '/categories', c);
      categories[res.name] = c;
    }
  }

  renderCategorySelects();
  renderCategoryTable();
}

function sortedCategories() {
  return Object.entries(categories)
    .map(([id, c]) => ({ id, ...c }))
    .sort((a, b) => a.group.localeCompare(b.group) || a.name.localeCompare(b.name));
}

function renderCategorySelects() {
  const cats = sortedCategories();
  const groups = {};
  cats.forEach(c => (groups[c.group] = groups[c.group] || []).push(c));

  ['category-select', 'filter-category'].forEach((elId, i) => {
    const el = document.getElementById(elId);
    el.innerHTML = i === 1 ? '<option value="">All</option>' : '';
    for (const [group, items] of Object.entries(groups)) {
      const og = document.createElement('optgroup');
      og.label = group;
      items.forEach(c => og.appendChild(new Option(c.name, c.id)));
      el.appendChild(og);
    }
  });
}

function renderCategoryTable() {
  const tbody = document.querySelector('#category-table tbody');
  tbody.innerHTML = '';
  for (const c of sortedCategories()) {
    const tr = document.createElement('tr');
    tr.dataset.id = c.id;
    tr.innerHTML = `
      <td>
        <select class="cat-group">
          ${GROUPS.map(g => `<option value="${g}" ${c.group === g ? 'selected' : ''}>${g}</option>`).join('')}
        </select>
      </td>
      <td><input type="text" class="cat-name" value="${c.name}" /></td>
      <td>
        <button class="save-cat-btn">Save</button>
        <button class="del-btn del-cat-btn">Delete</button>
      </td>`;
    tbody.appendChild(tr);
  }

  tbody.querySelectorAll('.save-cat-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const tr    = btn.closest('tr');
      const id    = tr.dataset.id;
      const name  = tr.querySelector('.cat-name').value.trim();
      const group = tr.querySelector('.cat-group').value;
      await put(DB() + '/categories/' + id, { group, name });
      categories[id] = { group, name };
      showToast('Category updated!');
      renderCategorySelects();
      renderCategoryTable();
      renderExpenseTable();
    });
  });

  tbody.querySelectorAll('.del-cat-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.closest('tr').dataset.id;
      const inUse = Object.values(expenses).some(e => e.category_id === id);
      if (inUse) return showToast('Cannot delete: expenses use this category.', 'error');
      if (!confirm('Delete this category?')) return;
      await del(DB() + '/categories/' + id);
      delete categories[id];
      showToast('Category deleted!');
      renderCategorySelects();
      renderCategoryTable();
    });
  });
}

/* ── Add category form ──────────────────────────────────────────────────── */
document.getElementById('add-category-form').addEventListener('submit', async e => {
  e.preventDefault();
  const fd   = new FormData(e.target);
  const name = fd.get('name').trim();
  const group = fd.get('group_name');
  const exists = Object.values(categories).some(c => c.name.toLowerCase() === name.toLowerCase());
  if (exists) return showToast('A category with that name already exists.', 'error');
  const res = await post(DB() + '/categories', { group, name });
  categories[res.name] = { group, name };
  showToast('Category added!');
  e.target.reset();
  renderCategorySelects();
  renderCategoryTable();
});

/* ── Load expenses ──────────────────────────────────────────────────────── */
async function loadExpenses() {
  const data = await get(DB() + '/expenses');
  expenses = data || {};
  renderExpenseTable();
  renderSummary();
  populateMonthFilter();
}

function filteredExpenses() {
  const month      = document.getElementById('filter-month').value;
  const categoryId = document.getElementById('filter-category').value;
  return Object.entries(expenses)
    .map(([id, e]) => ({ id, ...e }))
    .filter(e => (!month || e.date?.slice(0, 7) === month) && (!categoryId || e.category_id === categoryId))
    .sort((a, b) => b.date?.localeCompare(a.date) || b.created_at?.localeCompare(a.created_at));
}

function renderExpenseTable() {
  const tbody = document.querySelector('#expense-table tbody');
  tbody.innerHTML = '';
  for (const e of filteredExpenses()) {
    const cat = categories[e.category_id];
    const tr  = document.createElement('tr');
    tr.innerHTML = `
      <td>${e.date || ''}</td>
      <td>${cat ? cat.name : '—'}</td>
      <td>${e.description || ''}</td>
      <td>${fmtMoney(e.amount || 0)}</td>
      <td>${e.receipt_url ? `<a class="receipt-link" href="${e.receipt_url}" target="_blank">View</a>` : '—'}</td>
      <td><button class="del-btn" data-id="${e.id}">Delete</button></td>`;
    tbody.appendChild(tr);
  }

  tbody.querySelectorAll('.del-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Delete this expense?')) return;
      await del(DB() + '/expenses/' + btn.dataset.id);
      delete expenses[btn.dataset.id];
      showToast('Expense deleted!');
      renderExpenseTable();
      renderSummary();
      populateMonthFilter();
    });
  });
}

function populateMonthFilter() {
  const sel     = document.getElementById('filter-month');
  const current = sel.value;
  const months  = [...new Set(Object.values(expenses).map(e => e.date?.slice(0, 7)).filter(Boolean))].sort().reverse();
  sel.innerHTML = '<option value="">All</option>' + months.map(m => `<option value="${m}">${monthLabel(m)}</option>`).join('');
  sel.value = current;
}

/* ── Add expense form ───────────────────────────────────────────────────── */
document.getElementById('expense-form').addEventListener('submit', async e => {
  e.preventDefault();
  const fd          = new FormData(e.target);
  const file        = fd.get('receipt');
  const submitBtn   = e.target.querySelector('button[type="submit"]');
  submitBtn.disabled = true;
  submitBtn.textContent = 'Saving…';

  try {
    let receipt_url = null;
    if (file && file.size > 0) receipt_url = await uploadFile(file);

    const expense = {
      date:        fd.get('date'),
      category_id: fd.get('category_id'),
      description: fd.get('description') || '',
      amount:      parseFloat(fd.get('amount')),
      receipt_url,
      created_at:  new Date().toISOString(),
    };

    const res = await post(DB() + '/expenses', expense);
    expenses[res.name] = expense;
    showToast('Successfully added!');
    e.target.reset();
    renderExpenseTable();
    renderSummary();
    populateMonthFilter();
  } catch (err) {
    showToast(err.message || 'Failed to add expense', 'error');
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Add Expense';
  }
});

/* ── Summary ────────────────────────────────────────────────────────────── */
let summaryCache = { byMonth: [], byCategory: [] };
let pieChart = null;

const PIE_COLORS = [
  '#ff8c42','#2ec4b6','#ffd166','#ff5d8f','#7b61ff',
  '#4caf50','#ef476f','#118ab2','#06d6a0','#f4a261',
  '#e76f51','#264653','#a8dadc','#457b9d','#e63946'
];

function populateSummaryMonthFilter() {
  const sel = document.getElementById('summary-month-filter');
  const current = sel.value;
  const months = [...new Set(Object.values(expenses).map(e => e.date?.slice(0, 7)).filter(Boolean))].sort().reverse();
  sel.innerHTML = '<option value="">All Months</option>' + months.map(m => `<option value="${m}">${monthLabel(m)}</option>`).join('');
  sel.value = months.includes(current) ? current : '';
}

function renderSummary() {
  populateSummaryMonthFilter();
  applySummarySort();
}

function applySummarySort() {
  const filterMonth = document.getElementById('summary-month-filter').value;
  const allExp = Object.values(expenses).filter(e => !filterMonth || e.date?.slice(0, 7) === filterMonth);

  // total
  const total = allExp.reduce((s, e) => s + (e.amount || 0), 0);
  document.getElementById('summary-total').textContent = fmtMoney(total);

  // by month
  const monthMap = {};
  allExp.forEach(e => {
    const m = e.date?.slice(0, 7);
    if (m) monthMap[m] = (monthMap[m] || 0) + (e.amount || 0);
  });
  summaryCache.byMonth = Object.entries(monthMap).map(([month, total]) => ({ month, total }));

  // by category
  const catMap = {};
  allExp.forEach(e => {
    const cat = categories[e.category_id];
    if (!cat) return;
    if (!catMap[e.category_id]) catMap[e.category_id] = { category_name: cat.name, group_name: cat.group, total: 0 };
    catMap[e.category_id].total += e.amount || 0;
  });
  summaryCache.byCategory = Object.values(catMap);

  const monthSort = document.getElementById('sort-month').value;
  const sortedMonths = [...summaryCache.byMonth].sort((a, b) =>
    monthSort === 'date-asc' ? a.month.localeCompare(b.month) : b.month.localeCompare(a.month));
  document.querySelector('#summary-month tbody').innerHTML =
    sortedMonths.map(r => `<tr><td>${monthLabel(r.month)}</td><td>${fmtMoney(r.total)}</td></tr>`).join('');

  const catSort = document.getElementById('sort-category').value;
  const sortedCats = [...summaryCache.byCategory].sort((a, b) => {
    if (catSort === 'alpha-asc')  return a.category_name.localeCompare(b.category_name);
    if (catSort === 'alpha-desc') return b.category_name.localeCompare(a.category_name);
    if (catSort === 'amount-asc') return a.total - b.total;
    return b.total - a.total;
  });
  document.querySelector('#summary-category tbody').innerHTML =
    sortedCats.map(r => `<tr><td>${r.category_name}</td><td>${fmtMoney(r.total)}</td></tr>`).join('');

  // pie chart
  const pieData = [...summaryCache.byCategory].sort((a, b) => b.total - a.total);
  if (pieChart) pieChart.destroy();
  if (pieData.length > 0) {
    pieChart = new Chart(document.getElementById('category-pie'), {
      type: 'pie',
      data: {
        labels: pieData.map(r => r.category_name),
        datasets: [{ data: pieData.map(r => r.total), backgroundColor: PIE_COLORS.slice(0, pieData.length), borderWidth: 2 }]
      },
      options: {
        plugins: {
          legend: { position: 'right', labels: { font: { size: 12 }, padding: 14 } },
          tooltip: { callbacks: { label: ctx => ` ${ctx.label}: ${fmtMoney(ctx.raw)} (${((ctx.raw/total)*100).toFixed(1)}%)` } }
        }
      }
    });
  }
}

document.getElementById('summary-month-filter').addEventListener('change', applySummarySort);

/* ── Export receipts as zip (using JSZip from CDN) ──────────────────────── */
document.getElementById('export-btn').addEventListener('click', async () => {
  const month  = document.getElementById('filter-month').value;
  const status = document.getElementById('export-status');
  if (!month) { status.textContent = 'Select a month first to export receipts.'; return; }

  const yr = month.split('-')[0];
  const mo = parseInt(month.split('-')[1]);
  const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const folderName = `${monthNames[mo - 1]} ${yr}`;

  const rows = Object.values(expenses).filter(e => e.date?.slice(0, 7) === month && e.receipt_url);
  if (!rows.length) { status.textContent = `No receipts found for ${folderName}.`; return; }

  status.textContent = `Preparing ${rows.length} file(s)…`;

  // Load JSZip from CDN on demand
  if (!window.JSZip) {
    await new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
      s.onload = resolve; s.onerror = reject;
      document.head.appendChild(s);
    });
  }

  const zip      = new JSZip();
  const counters = {};
  for (const e of rows) {
    try {
      const cat = categories[e.category_id]?.name || 'Unknown';
      const key = cat.replace(/[^A-Za-z0-9]/g, '_');
      counters[key] = (counters[key] || 0) + 1;
      const ext  = e.receipt_url.split('?')[0].split('.').pop();
      const name = `${folderName}/${key}_${counters[key]}.${ext}`;
      const blob = await fetch(e.receipt_url).then(r => r.blob());
      zip.file(name, blob);
    } catch (_) {}
  }

  const content = await zip.generateAsync({ type: 'blob' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(content);
  a.download = `${folderName.replace(' ', '_')}_receipts.zip`;
  a.click();
  status.textContent = `Downloaded ${Object.values(counters).reduce((a,b)=>a+b,0)} file(s) as ${a.download}.`;
});

/* ── Export Excel ───────────────────────────────────────────────────────── */
document.getElementById('export-excel-btn').addEventListener('click', async () => {
  const month  = document.getElementById('filter-month').value;
  const status = document.getElementById('export-status');
  const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];

  // Load SheetJS on demand
  if (!window.XLSX) {
    await new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
      s.onload = resolve; s.onerror = reject;
      document.head.appendChild(s);
    });
  }

  const wb = XLSX.utils.book_new();

  const buildSheet = (monthKey) => {
    const rows = Object.values(expenses)
      .filter(e => e.date?.slice(0, 7) === monthKey)
      .sort((a, b) => a.date.localeCompare(b.date));

    const data = [['Date', 'Group', 'Category', 'Description', 'Amount (₱)']];
    rows.forEach(e => {
      const cat = categories[e.category_id];
      data.push([e.date, cat?.group || '', cat?.name || '—', e.description || '', e.amount || 0]);
    });
    // Total row
    data.push(['', '', '', 'TOTAL', rows.reduce((s, e) => s + (e.amount || 0), 0)]);

    const ws = XLSX.utils.aoa_to_sheet(data);
    ws['!cols'] = [{ wch: 12 }, { wch: 22 }, { wch: 24 }, { wch: 30 }, { wch: 14 }];
    return ws;
  };

  if (month) {
    // Single month
    const [yr, mo] = month.split('-');
    const label = `${MONTH_NAMES[parseInt(mo) - 1]} ${yr}`;
    XLSX.utils.book_append_sheet(wb, buildSheet(month), label);
    XLSX.writeFile(wb, `KD_Cafe_Expenses_${label.replace(' ', '_')}.xlsx`);
    status.textContent = `Downloaded Excel for ${label}.`;
  } else {
    // All months — one sheet each
    const months = [...new Set(Object.values(expenses).map(e => e.date?.slice(0, 7)).filter(Boolean))].sort();
    if (!months.length) { status.textContent = 'No expenses to export.'; return; }
    months.forEach(m => {
      const [yr, mo] = m.split('-');
      const label = `${MONTH_NAMES[parseInt(mo) - 1]} ${yr}`;
      XLSX.utils.book_append_sheet(wb, buildSheet(m), label);
    });
    XLSX.writeFile(wb, 'KD_Cafe_Expenses_All.xlsx');
    status.textContent = `Downloaded Excel with ${months.length} month(s).`;
  }
});

/* ── Tabs ───────────────────────────────────────────────────────────────── */
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.page').forEach(p => p.hidden = true);
    btn.classList.add('active');
    document.querySelector(`.page[data-page="${btn.dataset.page}"]`).hidden = false;
  });
});

document.getElementById('sort-month').addEventListener('change', applySummarySort);
document.getElementById('sort-category').addEventListener('change', applySummarySort);
document.getElementById('filter-month').addEventListener('change', renderExpenseTable);
document.getElementById('filter-category').addEventListener('change', renderExpenseTable);

/* ── Init ───────────────────────────────────────────────────────────────── */
(async () => {
  await loadCategories();
  await loadExpenses();
})();
