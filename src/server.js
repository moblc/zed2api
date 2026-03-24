'use strict';
const express = require('express');
const fs = require('fs');
const path = require('path');
const { AccountManager, addAccount } = require('./accounts');
const auth = require('./auth');
const zed = require('./zed');
const proxy = require('./proxy');
const providers = require('./providers');
const stream = require('./stream');

const MODELS_JSON = JSON.parse(fs.readFileSync(path.join(__dirname, 'models.json'), 'utf-8'));
const WEB_UI = fs.readFileSync(path.join(__dirname, '..', 'webui', 'dist', 'index.html'), 'utf-8');

let accountMgr;
let loginStatus = 'idle'; // idle | waiting | success | failed
let loginErrorMsg = '';
let loginResultName = '';

async function run(port) {
  proxy.init();
  accountMgr = new AccountManager();
  accountMgr.loadFromFile();

  console.log(`[zed2api] http://127.0.0.1:${port}`);
  console.log(`[zed2api] ${accountMgr.list.length} account(s) loaded`);
  const proxyHost = proxy.getHost();
  if (proxyHost) {
    console.log(`[zed2api] proxy: ${proxyHost}:${proxy.getPort()}`);
  } else {
    console.log('[zed2api] proxy: none (set HTTPS_PROXY to use)');
  }

  const app = express();
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') { res.sendStatus(200); return; }
    next();
  });
  app.use(express.raw({ type: '*/*', limit: '16mb' }));

  // Web UI
  app.get('/', (req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(WEB_UI);
  });

  // Stubs
  app.post('/api/event_logging/batch', (req, res) => res.json({ status: 'ok' }));
  app.all('/v1/messages/count_tokens', (req, res) => res.json({ input_tokens: 0 }));

  // Models
  app.get('/v1/models', (req, res) => {
    const data = MODELS_JSON.data.map(m => ({ id: m.id, object: 'model', owned_by: m.owned_by }));
    res.json({ object: 'list', data });
  });

  // Streaming + non-streaming completions
  app.post('/v1/chat/completions', (req, res) => handleCompletion(req, res, false));
  app.post('/v1/messages', (req, res) => handleCompletion(req, res, true));

  // Accounts
  app.get('/zed/accounts', (req, res) => {
    const accounts = accountMgr.list.map((a, i) => ({
      name: a.name, user_id: a.user_id, current: i === accountMgr.current,
    }));
    res.json({ accounts, current: accountMgr.getCurrent()?.name || '' });
  });

  app.post('/zed/accounts/switch', (req, res) => {
    let body;
    try { body = JSON.parse(req.body); } catch (_) { res.status(400).json({ error: 'invalid json' }); return; }
    const name = body.account_name || body.name;
    if (!name) { res.status(400).json({ error: 'missing account_name' }); return; }
    if (!accountMgr.switchTo(name)) { res.status(404).json({ error: 'account not found' }); return; }
    res.json({ status: 'ok', current: name });
  });

  app.delete('/zed/accounts/:name', (req, res) => {
    const name = req.params.name;
    if (!accountMgr.deleteAccount(name)) { res.status(404).json({ error: 'account not found' }); return; }
    res.json({ status: 'ok' });
  });

  // Login
  app.post('/zed/login', async (req, res) => {
    if (loginStatus === 'waiting') {
      res.status(409).json({ error: 'login already in progress' }); return;
    }
    let accountName = '';
    try { const b = JSON.parse(req.body); accountName = b.name || ''; } catch (_) { }
    loginStatus = 'waiting';
    const url = startLoginWorker(accountName);
    res.json({ url, status: 'waiting' });
  });

  app.get('/zed/login/status', (req, res) => {
    const s = loginStatus;
    if (s === 'success' || s === 'failed') loginStatus = 'idle';
    res.json({ status: s, error: s === 'failed' ? loginErrorMsg : undefined });
  });

  // Usage / billing
  app.get('/zed/billing', async (req, res) => {
    const acc = accountMgr.getCurrent();
    if (!acc) { res.status(400).json({ error: 'no account' }); return; }
    try {
      const data = await zed.fetchBillingUsage(acc);
      res.setHeader('Content-Type', 'application/json');
      res.send(data);
    } catch (e) { res.status(502).json({ error: e.message }); }
  });

  app.get('/zed/usage', async (req, res) => {
    const acc = accountMgr.getCurrent();
    if (!acc) { res.status(400).json({ error: 'no account' }); return; }
    try {
      const data = await zed.fetchBillingUsage(acc);
      res.setHeader('Content-Type', 'application/json');
      res.send(data);
    } catch (e) { res.status(502).json({ error: e.message }); }
  });
  app.listen(port, '127.0.0.1', () => {
    console.log(`[zed2api] listening on http://127.0.0.1:${port}`);
  });
}

async function handleCompletion(req, res, isAnthropic) {
  const body = req.body ? req.body.toString('utf-8') : '{}';
  const wantsStream = body.includes('"stream":true') || body.includes('"stream": true');

  console.log(`[req] ${req.method} ${req.path} stream=${wantsStream} body=${body.length}bytes`);

  if (wantsStream) {
    await stream.handleStreamProxy(res, body, isAnthropic, accountMgr);
    return;
  }

  if (accountMgr.list.length === 0) {
    res.status(400).json({ error: 'no account configured' }); return;
  }

  const tryOrder = [accountMgr.current];
  for (let i = 0; i < accountMgr.list.length; i++) {
    if (i !== accountMgr.current) tryOrder.push(i);
  }

  let lastErr;
  for (const accIdx of tryOrder) {
    const acc = accountMgr.list[accIdx];
    try {
      const result = isAnthropic
        ? await zed.proxyMessages(acc, body)
        : await zed.proxyChatCompletions(acc, body);
      if (accIdx !== accountMgr.current) {
        console.log(`[zed2api] failover: switched to '${acc.name}'`);
        accountMgr.current = accIdx;
      }
      res.setHeader('Content-Type', 'application/json');
      res.send(result);
      return;
    } catch (e) {
      lastErr = e;
      console.log(`[zed2api] account '${acc.name}' failed: ${e.message}`);
      if (e.code !== 'TOKEN_EXPIRED' && e.code !== 'UPSTREAM_ERROR') break;
    }
  }

  const status = lastErr?.code === 'TOKEN_EXPIRED' ? 401 : 502;
  res.status(status).json({ error: { message: lastErr?.message || 'upstream error', type: 'upstream_error' } });
}

function startLoginWorker(accountName) {
  auth.createLoginSession().then(({ url, promise }) => {
    auth.openBrowser(url);
    loginStatus = 'waiting';
    promise.then(creds => {
      const name = accountName || creds.user_id;
      addAccount(name, creds.user_id, creds.access_token);
      accountMgr = new AccountManager();
      accountMgr.loadFromFile();
      loginResultName = name;
      loginStatus = 'success';
      console.log(`[login] success: ${name}`);
    }).catch(e => {
      loginStatus = 'failed';
      loginErrorMsg = e.message;
      console.log(`[login] failed: ${e.message}`);
    });
  }).catch(e => {
    loginStatus = 'failed';
    loginErrorMsg = e.message;
  });
}

module.exports = { run };
