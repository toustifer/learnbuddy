# coding: utf-8
"""Prepare reversible PM2 configs; does not switch the live service."""
import copy
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import subprocess

release = Path(__file__).resolve().parent.parent
plugin = Path('/home/jiajun/learnbuddy/plugins/dsh-plugin-learnbuddy')
dsh_ui = Path('/home/jiajun/learnbuddy-releases/learnbuddy-db2c774/plugins/dsh-plugin-learnbuddy/web/dsh-ui')
backup = release / 'server-backup'
backup.mkdir(mode=0o700)
manifest = json.loads((release / 'RELEASE.json').read_text())
for name, digest in manifest['files'].items():
    assert hashlib.sha256((release / name).read_bytes()).hexdigest() == digest, name
processes = json.loads(subprocess.check_output(['pm2', 'jlist']))
gateway = next(p for p in processes if p['name'] == 'learnbuddy-gateway')['pm2_env']
assert gateway['pm_exec_path'] == '/usr/bin/bash'
assert gateway['status'] == 'online'
args = gateway['args']
assert isinstance(args, list)
source = str(plugin / 'server.js')
assert sum(arg.count(source) for arg in args) == 1, 'Unexpected gateway launcher'
assert all((dsh_ui / name).is_file() for name in ['client.cjs', 'dist/client.js'])
env = dict(gateway.get('env', {}))
env.update({k: v for k, v in gateway.items() if re.fullmatch(r'[A-Z][A-Z0-9_]*', k) and isinstance(v, (str, int, float))})
def private_json(path, value):
    with open(path, 'x', encoding='utf8') as handle:
        os.chmod(path, 0o600)
        json.dump(value, handle, indent=2)
private_json(backup / 'processes.json', processes)
for name in ['client.cjs', 'dist/client.js']:
    target = backup / ('dsh-' + name.replace('/', '-'))
    target.write_bytes((dsh_ui / name).read_bytes())
database = Path(str(env.get('LEARNBUDDY_DB_PATH', plugin / 'data/learnbuddy.db')))
assert database.is_file()
with sqlite3.connect(f'file:{database}?mode=ro', uri=True) as src:
    with sqlite3.connect(backup / 'learnbuddy.db') as dst:
        src.backup(dst)
original = {'name': 'learnbuddy-gateway', 'script': gateway['pm_exec_path'],
            'cwd': gateway['pm_cwd'], 'args': args, 'interpreter': gateway.get('exec_interpreter', 'none'),
            'exec_mode': 'fork', 'env': env, 'kill_timeout': gateway.get('kill_timeout', 1600)}
original['env']['LEARNBUDDY_WEB_DIST'] = str(env.get('LEARNBUDDY_WEB_DIST') or plugin / 'web/dist')
current = copy.deepcopy(original)
current['args'] = [arg.replace(source, str(release / 'deploy/serve-existing-gateway.mjs')) for arg in args]
current['kill_timeout'] = 6000
current['env'].update({'LEARNBUDDY_BASE_GATEWAY': source,
                       'LEARNBUDDY_WEB_DIST': str(release / 'plugins/dsh-plugin-learnbuddy/web/dist'),
                       'LEARNBUDDY_BIND_HOST': '0.0.0.0', 'PORT': str(env.get('PORT') or 3088)})
check = copy.deepcopy(current)
check['name'] = 'learnbuddy-release-check'
check['env'].update({'LEARNBUDDY_BIND_HOST': '127.0.0.1', 'PORT': '3092'})
private_json(release / 'gateway-before.config.json', {'apps': [original]})
private_json(release / 'gateway-current.config.json', {'apps': [current]})
private_json(release / 'gateway-check.config.json', {'apps': [check]})
private_json(backup / 'baseline.json', {
    'gatewaySource': source, 'gatewaySha256': hashlib.sha256(Path(source).read_bytes()).hexdigest(),
    'dshUi': str(dsh_ui), 'database': str(database),
    'processes': [{'name': p['name'], 'pid': p['pid'], 'restarts': p['pm2_env']['restart_time']} for p in processes],
})
print(json.dumps({'verifiedFiles': len(manifest['files']), 'release': str(release),
                  'databaseRetained': str(database), 'backupReady': True,
                  'shadowBind': '127.0.0.1:3092', 'liveChanged': False}))
