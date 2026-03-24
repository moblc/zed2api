'use strict';
const https = require('https');
const http = require('http');
const { HttpsProxyAgent } = require('https-proxy-agent');
const providers = require('./providers');
const proxy = require('./proxy');

const SYSTEM_ID = '6b87ab66-af2c-49c7-b986-ef4c27c9e1fb';
const ZED_VERSION = '0.222.4+stable.147.b385025df963c9e8c3f74cc4dadb1c4b29b3c6f0';

function getAgent() {
  const host = proxy.getHost();
  if (!host) return undefined;
  return new HttpsProxyAgent(`http://${host}:${proxy.getPort()}`);
}

function parseJwtExp(jwt) {
  try {
    const payload = jwt.split('.')[1];
    const decoded = Buffer.from(payload, 'base64url').toString('utf-8');
    return JSON.parse(decoded).exp || 0;
  } catch (_) { return 0; }
}

async function fetchNewToken(acc) {
  const authHeader = `${acc.user_id} ${acc.credential_json}`;
  const body = '';
  const agent = getAgent();

  const data = await request('POST', 'https://cloud.zed.dev/client/llm_tokens', body, {
    authorization: authHeader,
    'content-type': 'application/json',
    'x-zed-system-id': SYSTEM_ID,
  }, agent);

  const parsed = JSON.parse(data);
  if (!parsed.token) throw new Error('No token in response');
  acc.jwt_exp = parseJwtExp(parsed.token);
  acc.jwt_token = parsed.token;
  console.log(`[zed] token refreshed for uid ${acc.user_id}`);
  return parsed.token;
}

async function getToken(acc) {
  if (acc.jwt_token && Date.now() / 1000 < acc.jwt_exp - 60) {
    return acc.jwt_token;
  }
  acc.jwt_token = null;
  return fetchNewToken(acc);
}

function request(method, url, body, headers, agent) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const isHttps = urlObj.protocol === 'https:';
    const lib = isHttps ? https : http;
    const opts = {
      hostname: urlObj.hostname,
      port: urlObj.port || (isHttps ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method,
      headers: { ...headers },
      agent,
    };
    if (body) {
      const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
      opts.headers['content-length'] = buf.length;
    }
    const req = lib.request(opts, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const data = Buffer.concat(chunks).toString('utf-8');
        if (res.statusCode === 401 || res.statusCode === 403) {
          reject(Object.assign(new Error('TokenExpired'), { code: 'TOKEN_EXPIRED' }));
        } else if (res.statusCode !== 200) {
          reject(Object.assign(new Error(`HTTP ${res.statusCode}: ${data.slice(0,200)}`), { code: 'UPSTREAM_ERROR' }));
        } else {
          resolve(data);
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(Buffer.isBuffer(body) ? body : Buffer.from(body));
    req.end();
  });
}

async function sendToZed(jwt, payload) {
  const agent = getAgent();
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const data = await request('POST', 'https://cloud.zed.dev/completions', payload, {
        authorization: `Bearer ${jwt}`,
        'content-type': 'application/json',
        'x-zed-version': ZED_VERSION,
      }, agent);
      return data;
    } catch (e) {
      lastErr = e;
      if (e.code === 'TOKEN_EXPIRED') throw e;
      if (attempt < 2) await sleep(1000 * Math.pow(2, attempt));
    }
  }
  throw lastErr;
}

async function proxyChatCompletions(acc, body) {
  try {
    return await proxyChatCompletionsInner(acc, body);
  } catch (e) {
    if (e.code === 'TOKEN_EXPIRED') {
      acc.jwt_token = null;
      return proxyChatCompletionsInner(acc, body);
    }
    throw e;
  }
}

async function proxyChatCompletionsInner(acc, body) {
  const jwt = await getToken(acc);
  const payload = providers.buildZedPayload(body, false);
  const response = await sendToZed(jwt, payload);
  return providers.convertToOpenAI(response);
}

async function proxyMessages(acc, body) {
  try {
    return await proxyMessagesInner(acc, body);
  } catch (e) {
    if (e.code === 'TOKEN_EXPIRED') {
      acc.jwt_token = null;
      return proxyMessagesInner(acc, body);
    }
    throw e;
  }
}

async function proxyMessagesInner(acc, body) {
  const jwt = await getToken(acc);
  const payload = providers.buildZedPayload(body, true);
  const response = await sendToZed(jwt, payload);
  return providers.convertToAnthropic(response);
}

async function fetchModels(acc) {
  const jwt = await getToken(acc);
  const agent = getAgent();
  return request('GET', 'https://cloud.zed.dev/models', null, {
    authorization: `Bearer ${jwt}`,
    'x-zed-version': ZED_VERSION,
  }, agent);
}

async function fetchBillingUsage(acc) {
  const authHeader = `${acc.user_id} ${acc.credential_json}`;
  const agent = getAgent();
  return request('GET', 'https://cloud.zed.dev/client/users/me', null, {
    authorization: authHeader,
    accept: 'application/json',
    'content-type': 'application/json',
  }, agent);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { getToken, proxyChatCompletions, proxyMessages, fetchModels, fetchBillingUsage, sendToZed, ZED_VERSION };
