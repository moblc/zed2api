#!/usr/bin/env node
'use strict';
const { run } = require('./src/server');
const auth = require('./src/auth');
const { addAccount } = require('./src/accounts');

const args = process.argv.slice(2);
const cmd = args[0];

if (cmd === 'serve' || !cmd) {
  const port = parseInt(process.env.PORT || args[1] || '3000', 10);
  run(port).catch(e => { console.error(e); process.exit(1); });
} else if (cmd === 'login') {
  const accountName = args[1] || '';
  auth.login().then(creds => {
    const name = accountName || creds.user_id;
    addAccount(name, creds.user_id, creds.access_token);
    console.log(`[login] success: ${name}`);
    process.exit(0);
  }).catch(e => { console.error(`[login] failed: ${e.message}`); process.exit(1); });
} else {
  console.error(`Unknown command: ${cmd}`);
  console.error('Usage: zed2api [serve] [port]');
  console.error('       zed2api login [账号名]');
  process.exit(1);
}
