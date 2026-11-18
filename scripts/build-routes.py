#!/usr/bin/env python3
# نقل معالجات api/ إلى lib/routes/ مع تصحيح مسارات require —
# ليصبح api/ ملفًا واحدًا (catch-all) بدل 14 دالة (حد خطة Hobby على Vercel)
import os, re

ROOT = '/home/z/my-project/work/MERGER76'
API = os.path.join(ROOT, 'api')
OUT = os.path.join(ROOT, 'lib', 'routes')
os.makedirs(OUT, exist_ok=True)

# api path -> flat name in lib/routes
MAPPING = {
    'mcp.js': 'mcp.js',
    'health.js': 'health.js',
    'models.js': 'models.js',
    'balance.js': 'balance.js',
    'generate.js': 'generate.js',
    'merge.js': 'merge.js',
    'keys.js': 'keys.js',
    'tasks.js': 'tasks.js',
    'keys/[id].js': 'keys-id.js',
    'tasks/[id].js': 'tasks-id.js',
    'gf/[id].js': 'gf-id.js',
    'flow/status.js': 'flow-status.js',
    'flow/bridge.js': 'flow-bridge.js',
    'flow/file/[id].js': 'flow-file-id.js',
}

def convert(src):
    s = open(src, encoding='utf-8').read()
    # كل الوحدات تُكتب في lib/routes/ (مستوى واحد داخل lib) — أي عمق للـ lib يصبح '../'
    # مثال: من api/flow/file/[id].js كانت '../../../lib/db' ومن api/x.js كانت '../lib/db'
    # وفي lib/routes/*.js تصبح كلها '../db'
    s = re.sub(r"'\.\.(?:/\.\.)*/lib/", "'../", s)
    # health.js يقرأ package.json — أصبح أعمق مستوى واحد
    s = s.replace("require('../package.json')", "require('../../package.json')")
    return s

count = 0
for rel, flat in MAPPING.items():
    src = os.path.join(API, rel)
    dst = os.path.join(OUT, flat)
    open(dst, 'w', encoding='utf-8').write(convert(src))
    count += 1
print(f'✅ wrote {count} route modules to lib/routes/')
for f in sorted(os.listdir(OUT)):
    print('  ', f, os.path.getsize(os.path.join(OUT, f)), 'bytes')
