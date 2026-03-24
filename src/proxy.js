'use strict';
const { execSync } = require('child_process');

let proxyHost = null;
let proxyPort = 0;
let initialized = false;

function init() {
  if (initialized) return;
  initialized = true;

  const envNames = ['HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy'];
  for (const name of envNames) {
    const val = process.env[name];
    if (!val) continue;
    try {
      const url = new URL(val);
      proxyHost = url.hostname;
      proxyPort = parseInt(url.port) || 7890;
      console.log(`[zed2api] proxy: ${proxyHost}:${proxyPort}`);
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
        const parts = m[1].split(':');
        proxyHost = parts[0];
        proxyPort = parseInt(parts[1]) || 7890;
        console.log(`[zed2api] proxy (system): ${proxyHost}:${proxyPort}`);
      }
    } catch (_) {}
  }
}

function getHost() { return proxyHost; }
function getPort() { return proxyPort; }

module.exports = { init, getHost, getPort };
