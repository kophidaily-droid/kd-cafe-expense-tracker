import sqlite3
import json
import os
import cgi
import re
import io
import zipfile
import mimetypes
import time
import random
import threading
from urllib.parse import urlparse, parse_qs

# ── Paths ──────────────────────────────────────────────────────────────────────
ROOT     = os.path.dirname(os.path.abspath(__file__))
PUBLIC   = os.path.join(ROOT, 'public')
DATA_DIR = os.environ.get('DATA_DIR', os.path.join(ROOT, 'data'))
UPLOADS  = os.path.join(DATA_DIR, 'uploads')
DB_PATH  = os.path.join(DATA_DIR, 'expenses.db')

MONTH_NAMES = ['January','February','March','April','May','June',
               'July','August','September','October','November','December']

os.makedirs(UPLOADS,  exist_ok=True)
os.makedirs(DATA_DIR, exist_ok=True)

# ── Database ───────────────────────────────────────────────────────────────────
db_lock = threading.Lock()
db = sqlite3.connect(DB_PATH, check_same_thread=False)
db.execute("""
CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_name TEXT NOT NULL,
  name TEXT NOT NULL UNIQUE
)""")
db.execute("""
CREATE TABLE IF NOT EXISTS expenses (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  date             TEXT NOT NULL,
  category_id      INTEGER NOT NULL REFERENCES categories(id),
  description      TEXT,
  amount           REAL NOT NULL,
  receipt_filename TEXT,
  created_at       TEXT DEFAULT (datetime('now'))
)""")

SEED = [
    ('Supplies & Ingredients', 'Cakes'),
    ('Supplies & Ingredients', 'Coffee Beans'),
    ('Supplies & Ingredients', 'Cups & Lids'),
    ('Supplies & Ingredients', 'Dumbo Eggs'),
    ('Supplies & Ingredients', 'Ice'),
    ('Supplies & Ingredients', 'JPS Meat Supplier'),
    ('Supplies & Ingredients', 'Restaurant Depot'),
    ('Supplies & Ingredients', 'Supplier-IJMCI'),
    ('Supplies & Ingredients', 'Supplier-IZEAL'),
    ('Supplies & Ingredients', 'Supplier-MasterWrap'),
    ('Supplies & Ingredients', 'Tatuts Donuts'),
    ('Supplies & Ingredients', 'Veggies/Fruits'),
    ('Supplies & Ingredients', 'Water- Stream Breeze'),
    ('Utilities', 'Maynilad'),
    ('Utilities', 'Meralco'),
    ('Utilities', 'PLDT'),
    ('Salary', 'Staff Salary'),
    ('Other OpEx', 'Accounting'),
    ('Other OpEx', 'Marketing'),
    ('Other OpEx', 'Permits'),
    ('Other OpEx', 'Tax'),
    ('Miscellaneous', 'Deliveries'),
    ('Miscellaneous', 'Others'),
]
for _g, _n in SEED:
    db.execute("INSERT OR IGNORE INTO categories (group_name, name) VALUES (?, ?)", (_g, _n))
db.commit()

SAFE = re.compile(r'[^A-Za-z0-9._-]')

# ── DB helpers ─────────────────────────────────────────────────────────────────
def query(sql, params=()):
    cur = db.execute(sql, params)
    cols = [d[0] for d in cur.description]
    return [{c: r[i] for i, c in enumerate(cols)} for r in cur.fetchall()]

def write_db(fn):
    with db_lock:
        return fn()

# ── WSGI responses ─────────────────────────────────────────────────────────────
def json_resp(data, status=200):
    body = json.dumps(data).encode()
    return str(status), [('Content-Type','application/json'),('Content-Length',str(len(body)))], [body]

def file_resp(body, content_type, filename=None):
    headers = [('Content-Type', content_type), ('Content-Length', str(len(body)))]
    if filename:
        headers.append(('Content-Disposition', f'attachment; filename="{filename}"'))
    return '200', headers, [body]

STATUS_CODES = {200:'200 OK', 400:'400 Bad Request', 404:'404 Not Found'}

# ── Static file helper ─────────────────────────────────────────────────────────
def serve_static(path):
    full = os.path.join(PUBLIC, path.lstrip('/'))
    if not os.path.isfile(full):
        return None
    ctype = mimetypes.guess_type(full)[0] or 'application/octet-stream'
    with open(full, 'rb') as f:
        body = f.read()
    return file_resp(body, ctype)

# ── Route handlers ─────────────────────────────────────────────────────────────
def handle_get(path, qs, environ):

    # uploaded receipts
    if path.startswith('/uploads/'):
        fname = os.path.basename(path)
        fpath = os.path.join(UPLOADS, fname)
        if not os.path.isfile(fpath):
            return json_resp({'error': 'not found'}, 404)
        ctype = mimetypes.guess_type(fpath)[0] or 'application/octet-stream'
        with open(fpath, 'rb') as f:
            return file_resp(f.read(), ctype)

    if path == '/api/categories':
        return json_resp(query("SELECT * FROM categories ORDER BY group_name, name"))

    if path == '/api/expenses':
        sql    = """SELECT e.*, c.name as category_name, c.group_name
                    FROM expenses e JOIN categories c ON c.id=e.category_id WHERE 1=1"""
        params = []
        if 'month' in qs:
            sql += " AND strftime('%Y-%m', e.date)=?"; params.append(qs['month'][0])
        if 'category_id' in qs:
            sql += " AND e.category_id=?";             params.append(qs['category_id'][0])
        sql += " ORDER BY e.date DESC, e.id DESC"
        return json_resp(query(sql, params))

    if path == '/api/summary':
        return json_resp({
            'byMonth':    query("SELECT strftime('%Y-%m',date) as month, SUM(amount) as total FROM expenses GROUP BY month ORDER BY month DESC"),
            'byCategory': query("SELECT c.name as category_name, c.group_name, SUM(e.amount) as total FROM expenses e JOIN categories c ON c.id=e.category_id GROUP BY c.id ORDER BY total DESC"),
        })

    if path == '/api/export-month':
        month = qs.get('month', [None])[0]
        if not month:
            return json_resp({'error': 'month is required'}, 400)
        rows = query("""SELECT e.*, c.name as category_name FROM expenses e
                        JOIN categories c ON c.id=e.category_id
                        WHERE strftime('%Y-%m',e.date)=? AND e.receipt_filename IS NOT NULL
                        ORDER BY c.name, e.date""", (month,))
        yr, mo   = month.split('-')
        folder   = f"{MONTH_NAMES[int(mo)-1]} {yr}"
        buf      = io.BytesIO()
        counters = {}
        with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as zf:
            for row in rows:
                src = os.path.join(UPLOADS, row['receipt_filename'])
                if not os.path.isfile(src):
                    continue
                cat = SAFE.sub('_', row['category_name'])
                counters[cat] = counters.get(cat, 0) + 1
                ext = os.path.splitext(row['receipt_filename'])[1]
                zf.write(src, arcname=f"{folder}/{cat}_{counters[cat]}{ext}")
        zip_name = f"{folder.replace(' ','_')}_receipts.zip"
        return file_resp(buf.getvalue(), 'application/zip', zip_name)

    # static files (index.html, style.css, app.js)
    if path == '/':
        path = '/index.html'
    result = serve_static(path)
    if result:
        return result
    return json_resp({'error': 'not found'}, 404)


def handle_post(path, environ):
    if path == '/api/categories':
        length = int(environ.get('CONTENT_LENGTH', 0) or 0)
        body   = json.loads(environ['wsgi.input'].read(length) or b'{}')
        name, group = body.get('name'), body.get('group_name')
        if not name or not group:
            return json_resp({'error': 'name and group_name are required'}, 400)
        try:
            def _ins():
                cur = db.execute("INSERT INTO categories (group_name,name) VALUES (?,?)", (group, name))
                db.commit(); return cur.lastrowid
            return json_resp({'id': write_db(_ins)})
        except sqlite3.IntegrityError:
            return json_resp({'error': 'A category with that name already exists'}, 400)

    if path == '/api/expenses':
        ctype = environ.get('CONTENT_TYPE', '')
        form  = cgi.FieldStorage(fp=environ['wsgi.input'], environ=environ)
        date        = form.getvalue('date')
        category_id = form.getvalue('category_id')
        description = form.getvalue('description', '')
        amount      = form.getvalue('amount')
        if not date or not category_id or not amount:
            return json_resp({'error': 'date, category_id, and amount are required'}, 400)

        receipt_filename = None
        if 'receipt' in form and form['receipt'].filename:
            fi  = form['receipt']
            ext = SAFE.sub('', os.path.splitext(fi.filename)[1])
            receipt_filename = f"{int(time.time()*1000)}-{random.randint(0,10**9)}{ext}"
            with open(os.path.join(UPLOADS, receipt_filename), 'wb') as f:
                f.write(fi.file.read())

        def _ins():
            cur = db.execute(
                "INSERT INTO expenses (date,category_id,description,amount,receipt_filename) VALUES (?,?,?,?,?)",
                (date, category_id, description, float(amount), receipt_filename))
            db.commit(); return cur.lastrowid
        return json_resp({'id': write_db(_ins)})

    return json_resp({'error': 'not found'}, 404)


def handle_put(path, environ):
    m = re.match(r'^/api/categories/(\d+)$', path)
    if m:
        cat_id = m.group(1)
        length = int(environ.get('CONTENT_LENGTH', 0) or 0)
        body   = json.loads(environ['wsgi.input'].read(length) or b'{}')
        name, group = body.get('name'), body.get('group_name')
        if not name or not group:
            return json_resp({'error': 'name and group_name are required'}, 400)
        try:
            def _upd():
                db.execute("UPDATE categories SET name=?,group_name=? WHERE id=?", (name, group, cat_id))
                db.commit()
            write_db(_upd)
            return json_resp({'ok': True})
        except sqlite3.IntegrityError:
            return json_resp({'error': 'A category with that name already exists'}, 400)
    return json_resp({'error': 'not found'}, 404)


def handle_delete(path):
    m = re.match(r'^/api/expenses/(\d+)$', path)
    if m:
        exp_id = m.group(1)
        rows   = query("SELECT * FROM expenses WHERE id=?", (exp_id,))
        if rows and rows[0]['receipt_filename']:
            fpath = os.path.join(UPLOADS, rows[0]['receipt_filename'])
            if os.path.isfile(fpath):
                os.remove(fpath)
        def _del():
            db.execute("DELETE FROM expenses WHERE id=?", (exp_id,)); db.commit()
        write_db(_del)
        return json_resp({'ok': True})

    m = re.match(r'^/api/categories/(\d+)$', path)
    if m:
        cat_id = m.group(1)
        count  = query("SELECT COUNT(*) as c FROM expenses WHERE category_id=?", (cat_id,))[0]['c']
        if count:
            return json_resp({'error': f'Cannot delete: {count} expense(s) use this category.'}, 400)
        def _del():
            db.execute("DELETE FROM categories WHERE id=?", (cat_id,)); db.commit()
        write_db(_del)
        return json_resp({'ok': True})

    return json_resp({'error': 'not found'}, 404)


# ── WSGI entry point ───────────────────────────────────────────────────────────
def application(environ, start_response):
    parsed = urlparse(environ.get('PATH_INFO', '/'))
    qs     = parse_qs(environ.get('QUERY_STRING', ''))
    path   = parsed.path
    method = environ['REQUEST_METHOD'].upper()

    if   method == 'GET':    status, headers, body = handle_get(path, qs, environ)
    elif method == 'POST':   status, headers, body = handle_post(path, environ)
    elif method == 'PUT':    status, headers, body = handle_put(path, environ)
    elif method == 'DELETE': status, headers, body = handle_delete(path)
    else:
        status, headers, body = json_resp({'error': 'method not allowed'}, 404)

    start_response(STATUS_CODES.get(int(status.split()[0]), status), headers)
    return body
