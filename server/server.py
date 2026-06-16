import http.server
import socketserver
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

ROOT   = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PUBLIC = os.path.join(ROOT, 'public')

# DATA_DIR is overridden by env var on Render (persistent disk at /var/data)
DATA_DIR = os.environ.get('DATA_DIR', os.path.join(ROOT, 'data'))
UPLOADS  = os.path.join(DATA_DIR, 'uploads')
DB_PATH  = os.path.join(DATA_DIR, 'expenses.db')

MONTH_NAMES = ['January','February','March','April','May','June',
               'July','August','September','October','November','December']

os.makedirs(UPLOADS, exist_ok=True)
os.makedirs(DATA_DIR, exist_ok=True)

db_lock = threading.Lock()
db = sqlite3.connect(DB_PATH, check_same_thread=False)
db.execute("""
CREATE TABLE IF NOT EXISTS categories (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  group_name TEXT NOT NULL,
  name       TEXT NOT NULL UNIQUE
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
for group, name in SEED:
    db.execute("INSERT OR IGNORE INTO categories (group_name, name) VALUES (?, ?)", (group, name))
db.commit()

SAFE = re.compile(r'[^A-Za-z0-9._-]')


def rows_to_dicts(cur, rows):
    cols = [d[0] for d in cur.description]
    return [{c: r[i] for i, c in enumerate(cols)} for r in rows]


def query(sql, params=()):
    cur = db.execute(sql, params)
    return rows_to_dicts(cur, cur.fetchall())


def write_db(fn):
    with db_lock:
        return fn()


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=PUBLIC, **kwargs)

    def log_message(self, fmt, *args):
        pass  # silence request logs

    def _json(self, data, status=200):
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_file(self, body, content_type, filename=None):
        self.send_response(200)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(body)))
        if filename:
            self.send_header('Content-Disposition', f'attachment; filename="{filename}"')
        self.end_headers()
        self.wfile.write(body)

    # ── GET ────────────────────────────────────────────────────────────────
    def do_GET(self):
        parsed = urlparse(self.path)
        qs     = parse_qs(parsed.query)
        path   = parsed.path

        # Serve uploaded files from DATA_DIR/uploads
        if path.startswith('/uploads/'):
            fname = os.path.basename(path)
            fpath = os.path.join(UPLOADS, fname)
            if not os.path.isfile(fpath):
                return self._json({'error': 'not found'}, 404)
            ctype = mimetypes.guess_type(fpath)[0] or 'application/octet-stream'
            with open(fpath, 'rb') as f:
                return self._send_file(f.read(), ctype)

        if path == '/api/categories':
            return self._json(query("SELECT * FROM categories ORDER BY group_name, name"))

        if path == '/api/expenses':
            sql    = """SELECT e.*, c.name as category_name, c.group_name
                        FROM expenses e JOIN categories c ON c.id = e.category_id WHERE 1=1"""
            params = []
            if 'month' in qs:
                sql += " AND strftime('%Y-%m', e.date) = ?"; params.append(qs['month'][0])
            if 'category_id' in qs:
                sql += " AND e.category_id = ?";            params.append(qs['category_id'][0])
            sql += " ORDER BY e.date DESC, e.id DESC"
            return self._json(query(sql, params))

        if path == '/api/summary':
            return self._json({
                'byMonth':    query("SELECT strftime('%Y-%m', date) as month, SUM(amount) as total FROM expenses GROUP BY month ORDER BY month DESC"),
                'byCategory': query("SELECT c.name as category_name, c.group_name, SUM(e.amount) as total FROM expenses e JOIN categories c ON c.id=e.category_id GROUP BY c.id ORDER BY total DESC"),
            })

        # ZIP export: GET /api/export-month?month=YYYY-MM
        if path == '/api/export-month':
            month = qs.get('month', [None])[0]
            if not month:
                return self._json({'error': 'month is required'}, 400)
            rows = query("""SELECT e.*, c.name as category_name FROM expenses e
                            JOIN categories c ON c.id=e.category_id
                            WHERE strftime('%Y-%m', e.date)=? AND e.receipt_filename IS NOT NULL
                            ORDER BY c.name, e.date""", (month,))
            yr, mo    = month.split('-')
            folder    = f"{MONTH_NAMES[int(mo)-1]} {yr}"
            buf       = io.BytesIO()
            counters  = {}
            with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as zf:
                for row in rows:
                    src = os.path.join(UPLOADS, row['receipt_filename'])
                    if not os.path.isfile(src):
                        continue
                    cat = SAFE.sub('_', row['category_name'])
                    counters[cat] = counters.get(cat, 0) + 1
                    ext      = os.path.splitext(row['receipt_filename'])[1]
                    arcname  = f"{folder}/{cat}_{counters[cat]}{ext}"
                    zf.write(src, arcname=arcname)
            zip_name = f"{folder.replace(' ', '_')}_receipts.zip"
            return self._send_file(buf.getvalue(), 'application/zip', zip_name)

        return super().do_GET()  # static files

    # ── POST ───────────────────────────────────────────────────────────────
    def do_POST(self):
        path = self.path

        if path == '/api/categories':
            length = int(self.headers.get('Content-Length', 0))
            body   = json.loads(self.rfile.read(length) or b'{}')
            name, group = body.get('name'), body.get('group_name')
            if not name or not group:
                return self._json({'error': 'name and group_name are required'}, 400)
            try:
                def _ins():
                    cur = db.execute("INSERT INTO categories (group_name, name) VALUES (?, ?)", (group, name))
                    db.commit()
                    return cur.lastrowid
                return self._json({'id': write_db(_ins)})
            except sqlite3.IntegrityError:
                return self._json({'error': 'A category with that name already exists'}, 400)

        if path == '/api/expenses':
            ctype = self.headers.get('Content-Type', '')
            form  = cgi.FieldStorage(fp=self.rfile, headers=self.headers,
                                      environ={'REQUEST_METHOD': 'POST', 'CONTENT_TYPE': ctype})
            date        = form.getvalue('date')
            category_id = form.getvalue('category_id')
            description = form.getvalue('description', '')
            amount      = form.getvalue('amount')
            if not date or not category_id or not amount:
                return self._json({'error': 'date, category_id, and amount are required'}, 400)

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
                db.commit()
                return cur.lastrowid
            return self._json({'id': write_db(_ins)})

        self._json({'error': 'not found'}, 404)

    # ── PUT ────────────────────────────────────────────────────────────────
    def do_PUT(self):
        m = re.match(r'^/api/categories/(\d+)$', self.path)
        if m:
            cat_id = m.group(1)
            length = int(self.headers.get('Content-Length', 0))
            body   = json.loads(self.rfile.read(length) or b'{}')
            name, group = body.get('name'), body.get('group_name')
            if not name or not group:
                return self._json({'error': 'name and group_name are required'}, 400)
            try:
                def _upd():
                    db.execute("UPDATE categories SET name=?, group_name=? WHERE id=?", (name, group, cat_id))
                    db.commit()
                write_db(_upd)
                return self._json({'ok': True})
            except sqlite3.IntegrityError:
                return self._json({'error': 'A category with that name already exists'}, 400)
        self._json({'error': 'not found'}, 404)

    # ── DELETE ─────────────────────────────────────────────────────────────
    def do_DELETE(self):
        m = re.match(r'^/api/expenses/(\d+)$', self.path)
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
            return self._json({'ok': True})

        m = re.match(r'^/api/categories/(\d+)$', self.path)
        if m:
            cat_id = m.group(1)
            count  = query("SELECT COUNT(*) as c FROM expenses WHERE category_id=?", (cat_id,))[0]['c']
            if count:
                return self._json({'error': f'Cannot delete: {count} expense(s) use this category.'}, 400)
            def _del():
                db.execute("DELETE FROM categories WHERE id=?", (cat_id,)); db.commit()
            write_db(_del)
            return self._json({'ok': True})

        self._json({'error': 'not found'}, 404)


PORT = int(os.environ.get('PORT', 4321))

if __name__ == '__main__':
    socketserver.ThreadingTCPServer.allow_reuse_address = True
    with socketserver.ThreadingTCPServer(('', PORT), Handler) as httpd:
        print(f"KD Cafe Expense Tracker → http://localhost:{PORT}")
        httpd.serve_forever()
