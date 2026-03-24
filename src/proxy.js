'use strict';
const { execSync } = require('child_process');

let proxyUrl = null;
let initialized = false;

function init() {
  if (initialized) return;
  initialized = true;

  const envNames = ['HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy'];
  for (const name of envNames) {
    const val = process.env[name];
    if (!val) continue;
    try {
      new URL(val);
      proxyUrl = val;
      console.log(`[zed2api] proxy: ${val}`);
      return;
    } catch (_) {}
  }

  if (process.platform === 'win32') {
    try {
      const r1 = execSync(
        'reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable',
        { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] }
      );
      if (!r1.includes('0x1')) return;
      const r2 = execSync(
        'reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyServer',
        { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] }
      );
      const m = r2.match(/ProxyServer\s+REG_SZ\s+(\S+)/);
      if (m) {
        proxyUrl = `http://${m[1]}`;
        console.log(`[zed2api] proxy (system): ${proxyUrl}`);
      }
    } catch (_) {}
  }
}

function getUrl() { return proxyUrl; }

module.exports = { init, getUrl };
