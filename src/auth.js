'use strict';
const crypto = require('crypto');
const http = require('http');
const { execSync } = require('child_process');

function openBrowser(url) {
  const cmd = process.platform === 'win32' ? `start "" "${url}"` :
               process.platform === 'darwin' ? `open "${url}"` :
               `xdg-open "${url}"`;
  try { execSync(cmd, { stdio: 'ignore' }); } catch (_) {}
}

function generateKeypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'pkcs1', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const pubKeyB64url = publicKey.toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  return { pubKeyB64url, privateKeyPem: privateKey };
}

function decryptOaep(privateKeyPem, ciphertext) {
  return crypto.privateDecrypt(
    { key: privateKeyPem, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    ciphertext
  );
}

/**
 * Returns { url, promise } immediately.
 * url  - the Zed OAuth URL to open in a browser
 * promise - resolves with { user_id, access_token } when callback arrives
 */
function createLoginSession() {
  const { pubKeyB64url, privateKeyPem } = generateKeypair();

  let resolveSession, rejectSession;
  const promise = new Promise((resolve, reject) => {
    resolveSession = resolve;
    rejectSession = reject;
  });

  const server = http.createServer((req, res) => {
    try {
      const urlObj = new URL(req.url, 'http://localhost');
      const uid = urlObj.searchParams.get('uid') ||
                  urlObj.searchParams.get('user_id');
      const encTok = urlObj.searchParams.get('access_token') ||
                     urlObj.searchParams.get('token') ||
                     urlObj.searchParams.get('encrypted_token');

      if (!uid || !encTok) {
        res.writeHead(400); res.end('missing params'); return;
      }

      const b64 = encTok.replace(/-/g, '+').replace(/_/g, '/');
      const padded = b64 + '='.repeat((4 - b64.length % 4) % 4);
      const ciphertext = Buffer.from(padded, 'base64');
      const plaintext = decryptOaep(privateKeyPem, ciphertext);

      res.writeHead(302, {
        Location: 'https://zed.dev/native_app_signin_succeeded',
        'Content-Length': '0', Connection: 'close',
      });
      res.end();
      server.close();
      console.log(`[login] success! user_id: ${uid}`);
      resolveSession({ user_id: uid, access_token: plaintext.toString('utf-8') });
    } catch (e) {
      res.writeHead(302, {
        Location: 'https://zed.dev/native_app_signin_succeeded',
        'Content-Length': '0', Connection: 'close',
      });
      res.end();
      server.close();
      rejectSession(e);
    }
  });

  server.on('error', rejectSession);

  const timeoutId = setTimeout(() => {
    server.close();
    rejectSession(new Error('OAuth timeout'));
  }, 300000);
  promise.finally(() => clearTimeout(timeoutId));

  // Return URL synchronously once server is listening
  return new Promise((resolveUrl, rejectUrl) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      const url = `https://zed.dev/native_app_signin?native_app_port=${port}&native_app_public_key=${pubKeyB64url}`;
      resolveUrl({ url, promise });
    });
    server.on('error', rejectUrl);
  });
}

/** Convenience: open browser and wait for completion */
async function login() {
  const { url, promise } = await createLoginSession();
  console.log(`[auth] Opening browser: ${url}`);
  openBrowser(url);
  console.log('[auth] Waiting for OAuth callback...');
  return promise;
}

module.exports = { login, createLoginSession, openBrowser, generateKeypair };
