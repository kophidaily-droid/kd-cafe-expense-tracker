function showToast(message, type = 'success') {
  const toast = document.createElement('div');
  toast.className = 'toast-msg' + (type === 'error' ? ' error' : '');
  toast.textContent = message;
  document.getElementById('toast').appendChild(toast);
  setTimeout(() => {
    toast.classList.add('fade-out');
    setTimeout(() => toast.remove(), 400);
  }, 2500);
}

let categories = [];

async function loadCategories() {
  categories = await fetch('/api/categories').then(r => r.json());
  const groups = {};
  categories.forEach(c => (groups[c.group_name] = groups[c.group_name] || []).push(c));

  const catSelect = document.getElementById('category-select');
  const filterCat = document.getElementById('filter-category');
  catSelect.innerHTML = '';
  filterCat.innerHTML = '<option value="">All</option>';

  for (const [group, cats] of Object.entries(groups)) {
    const og1 = document.createElement('optgroup');
    og1.label = group;
    const og2 = og1.cloneNode();
    cats.forEach(c => {
      const o1 = new Option(c.name, c.id);
      const o2 = new Option(c.name, c.id);
      og1.appendChild(o1);
      og2.appendChild(o2);
    });
    catSelect.appendChild(og1);
    filterCat.appendChild(og2);
  }

  renderCategoryTable();
}

function renderCategoryTable() {
  const tbody = document.querySelector('#category-table tbody');
  tbody.innerHTML = '';
  for (const c of categories) {
    const tr = document.createElement('tr');
    tr.dataset.id = c.id;
    tr.innerHTML = `
      <td>
        <select class="cat-group">
          ${['Supplies & Ingredients', 'Utilities', 'Salary', 'Other OpEx', 'Miscellaneous']
            .map(g => `<option value="${g}" ${c.group_name === g ? 'selected' : ''}>${g}</option>`)
            .join('')}
        </select>
      </td>
      <td><input type="text" class="cat-name" value="${c.name}" /></td>
      <td>
        <button class="save-cat-btn">Save</button>
        <button class="del-btn del-cat-btn">Delete</button>
      </td>
    `;
    tbody.appendChild(tr);
  }

  tbody.querySelectorAll('.save-cat-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const tr = btn.closest('tr');
      const id = tr.dataset.id;
      const name = tr.querySelector('.cat-name').value.trim();
      const group_name = tr.querySelector('.cat-group').value;
      const res = await fetch('/api/categories/' + id, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, group_name }),
      });
      const data = await res.json();
      if (!res.ok) return showToast(data.error || 'Failed to update category', 'error');
      showToast('Category updated!');
      loadCategories();
      loadExpenses();
    });
  });

  tbody.querySelectorAll('.del-cat-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const tr = btn.closest('tr');
      const id = tr.dataset.id;
      if (!confirm('Delete this category?')) return;
      const res = await fetch('/api/categories/' + id, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) return showToast(data.error || 'Failed to delete category', 'error');
      showToast('Category deleted!');
      loadCategories();
    });
  });
}

document.getElementById('add-category-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const fd = new FormData(form);
  const res = await fetch('/api/categories', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: fd.get('name').trim(), group_name: fd.get('group_name') }),
  });
  const data = await res.json();
  if (!res.ok) return showToast(data.error || 'Failed to add category', 'error');
  showToast('Category added!');
  form.reset();
  loadCategories();
});

function fmtMoney(n) {
  return '₱' + Number(n).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function monthLabel(ym) {
  const [y, m] = ym.split('-');
  return new Date(y, m - 1).toLocaleString('en-US', { month: 'short', year: 'numeric' });
}

async function loadExpenses() {
  const month = document.getElementById('filter-month').value;
  const category_id = document.getElementById('filter-category').value;
  const params = new URLSearchParams();
  if (month) params.set('month', month);
  if (category_id) params.set('category_id', category_id);

  const expenses = await fetch('/api/expenses?' + params).then(r => r.json());
  const tbody = document.querySelector('#expense-table tbody');
  tbody.innerHTML = '';

  const monthSet = new Set();
  expenses.forEach(e => monthSet.add(e.date.slice(0, 7)));

  for (const e of expenses) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${e.date}</td>
      <td>${e.category_name}</td>
      <td>${e.description || ''}</td>
      <td>${fmtMoney(e.amount)}</td>
      <td>${e.receipt_filename ? `<a class="receipt-link" href="/uploads/${e.receipt_filename}" target="_blank">View</a>` : '-'}</td>
      <td><button class="del-btn" data-id="${e.id}">Delete</button></td>
    `;
    tbody.appendChild(tr);
  }

  tbody.querySelectorAll('.del-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Delete this expense?')) return;
      const res = await fetch('/api/expenses/' + btn.dataset.id, { method: 'DELETE' });
      if (!res.ok) return showToast('Failed to delete expense', 'error');
      showToast('Expense deleted!');
      loadExpenses();
      loadSummary();
    });
  });

  // populate month filter (preserve selection)
  if (!month) {
    const filterMonth = document.getElementById('filter-month');
    const current = filterMonth.value;
    const all = await fetch('/api/expenses').then(r => r.json());
    const months = [...new Set(all.map(e => e.date.slice(0, 7)))].sort().reverse();
    filterMonth.innerHTML = '<option value="">All</option>' +
      months.map(m => `<option value="${m}">${monthLabel(m)}</option>`).join('');
    filterMonth.value = current;
  }
}

let summaryData = { byMonth: [], byCategory: [] };

async function loadSummary() {
  summaryData = await fetch('/api/summary').then(r => r.json());
  renderSummary();
}

function renderSummary() {
  const { byMonth, byCategory } = summaryData;

  const monthSort = document.getElementById('sort-month').value;
  const sortedMonths = [...byMonth].sort((a, b) =>
    monthSort === 'date-asc' ? a.month.localeCompare(b.month) : b.month.localeCompare(a.month)
  );
  const mTbody = document.querySelector('#summary-month tbody');
  mTbody.innerHTML = sortedMonths.map(r => `<tr><td>${monthLabel(r.month)}</td><td>${fmtMoney(r.total)}</td></tr>`).join('');

  const catSort = document.getElementById('sort-category').value;
  const sortedCats = [...byCategory].sort((a, b) => {
    switch (catSort) {
      case 'alpha-asc': return a.category_name.localeCompare(b.category_name);
      case 'alpha-desc': return b.category_name.localeCompare(a.category_name);
      case 'amount-asc': return a.total - b.total;
      case 'amount-desc': default: return b.total - a.total;
    }
  });
  const cTbody = document.querySelector('#summary-category tbody');
  cTbody.innerHTML = sortedCats.map(r => `<tr><td>${r.category_name}</td><td>${fmtMoney(r.total)}</td></tr>`).join('');
}

document.getElementById('expense-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const fd = new FormData(form);
  const res = await fetch('/api/expenses', { method: 'POST', body: fd });
  if (res.ok) {
    showToast('Successfully added!');
    form.reset();
    loadExpenses();
    loadSummary();
  } else {
    showToast('Failed to add expense', 'error');
  }
});

document.getElementById('export-drive-btn').addEventListener('click', () => {
  const month  = document.getElementById('filter-month').value;
  const status = document.getElementById('export-status');
  if (!month) {
    status.textContent = 'Select a month first to export its receipts.';
    return;
  }
  status.textContent = 'Preparing zip download…';
  window.location.href = '/api/export-month?month=' + month;
  setTimeout(() => { status.textContent = ''; }, 3000);
});

document.getElementById('sort-month').addEventListener('change', renderSummary);
document.getElementById('sort-category').addEventListener('change', renderSummary);

document.getElementById('filter-month').addEventListener('change', loadExpenses);
document.getElementById('filter-category').addEventListener('change', loadExpenses);

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.page').forEach(p => p.hidden = true);
    btn.classList.add('active');
    document.querySelector(`.page[data-page="${btn.dataset.page}"]`).hidden = false;
  });
});

(async function init() {
  await loadCategories();
  await loadExpenses();
  await loadSummary();
})();
