'use strict';
const https = require('https');
const http = require('http');
const { HttpsProxyAgent } = require('https-proxy-agent');
const providers = require('./providers');
const zed = require('./zed');
const proxy = require('./proxy');

const ZED_VERSION = '0.222.4+stable.147.b385025df963c9e8c3f74cc4dadb1c4b29b3c6f0';

function getAgent() {
  const host = proxy.getHost();
  if (!host) return undefined;
  return new HttpsProxyAgent(`http://${host}:${proxy.getPort()}`);
}

// handleStreamProxy with account failover
async function handleStreamProxy(res, body, isAnthropic, accountMgr) {
  if (accountMgr.list.length === 0) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'no account configured' }));
    return;
  }

  const total = accountMgr.list.length;
  const tryOrder = [accountMgr.current];
  for (let i = 0; i < total; i++) {
    if (i !== accountMgr.current) tryOrder.push(i);
  }

  for (const accIdx of tryOrder) {
    const acc = accountMgr.list[accIdx];
    const ok = await doStreamProxy(res, acc, body, isAnthropic);
    if (ok) {
      if (accIdx !== accountMgr.current) {
        console.log(`[zed2api] stream failover: switched to '${acc.name}'`);
        accountMgr.current = accIdx;
      }
      return;
    }
    console.log(`[zed2api] stream: account '${acc.name}' failed, trying next...`);
  }

  if (!res.headersSent) {
    res.writeHead(502, { 'Content-Type': 'application/json' });
  }
  res.end(JSON.stringify({ error: { message: 'All accounts failed', type: 'upstream_error' } }));
}

async function doStreamProxy(res, acc, body, isAnthropic) {
  let jwt;
  try {
    jwt = await zed.getToken(acc);
  } catch (e) {
    console.log(`[stream] getToken failed: ${e.message}`);
    return false;
  }

  const payload = providers.buildZedPayload(body, isAnthropic);
  const model = (() => { try { return JSON.parse(body).model || 'claude-sonnet-4-5'; } catch(_) { return 'claude-sonnet-4-5'; } })();
  const agent = getAgent();

  return new Promise((resolve) => {
    const urlObj = new URL('https://cloud.zed.dev/completions');
    const payloadBuf = Buffer.from(payload);
    const opts = {
      hostname: urlObj.hostname,
      port: 443,
      path: urlObj.pathname,
      method: 'POST',
      headers: {
        authorization: `Bearer ${jwt}`,
        'content-type': 'application/json',
        'content-length': payloadBuf.length,
        'x-zed-version': ZED_VERSION,
      },
      agent,
    };

    const req = https.request(opts, (upstream) => {
      if (upstream.statusCode === 401 || upstream.statusCode === 403) {
        acc.jwt_token = null;
        upstream.resume();
        resolve(false);
        return;
      }
      if (upstream.statusCode !== 200) {
        console.log(`[stream] upstream HTTP ${upstream.statusCode}`);
        upstream.resume();
        resolve(false);
        return;
      }

      // Send SSE headers
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': '*',
      });

      // Send Anthropic message_start
      res.write(`event: message_start\ndata: ${JSON.stringify({
        type: 'message_start',
        message: { id: 'msg_zed', type: 'message', role: 'assistant', model, content: [], stop_reason: null, usage: { input_tokens: 0, output_tokens: 0 } },
      })}\n\n`);

      let lineBuf = '';
      let blockIndex = 0;
      let hasToolUse = false;
      let toolBlocks = [];
      let currentToolId = null;
      let currentToolName = null;
      let toolInputBuf = '';
      let gotAnyData = false;

      upstream.setEncoding('utf-8');
      upstream.on('data', (chunk) => {
        lineBuf += chunk;
        let nl;
        while ((nl = lineBuf.indexOf('\n')) !== -1) {
          const line = lineBuf.slice(0, nl).replace(/\r$/, '');
          lineBuf = lineBuf.slice(nl + 1);
          if (!line) continue;
          if (!line.startsWith('{')) continue;

          let obj;
          try { obj = JSON.parse(line); } catch(_) { continue; }

          // Unwrap event wrapper if present
          if (obj.event && typeof obj.event === 'object') obj = obj.event;

          gotAnyData = true;
          convertAndSendSSE(res, obj, model, { blockIndex, hasToolUse, toolBlocks, currentToolId, currentToolName, toolInputBuf }, (state, event) => {
            blockIndex = state.blockIndex;
            hasToolUse = state.hasToolUse;
            toolBlocks = state.toolBlocks;
            currentToolId = state.currentToolId;
            currentToolName = state.currentToolName;
            toolInputBuf = state.toolInputBuf;
            if (event) res.write(event);
          });
        }
      });

      upstream.on('end', () => {
        // Finalize any open tool block
        if (currentToolId && currentToolName) {
          let input = {};
          try { input = JSON.parse(toolInputBuf); } catch(_) {}
          const tb = { type: 'tool_use', id: currentToolId, name: currentToolName, input };
          toolBlocks.push(tb);
          hasToolUse = true;
        }

        if (blockIndex > 0) {
          res.write('event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n');
        }

        const stopReason = hasToolUse ? 'tool_use' : 'end_turn';
        res.write(`event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 0 } })}\n\n`);
        res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n');
        res.end();
        resolve(true);
      });

      upstream.on('error', () => { resolve(false); });
    });

    req.on('error', (e) => {
      console.log(`[stream] request error: ${e.message}`);
      resolve(false);
    });

    req.write(payloadBuf);
    req.end();
  });
}

function emitTextDelta(res, text, blockIndex) {
  let out = '';
  if (blockIndex === 0) {
    out += 'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n';
  }
  out += `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })}\n\n`;
  return out;
}

function convertAndSendSSE(res, obj, model, state, emit) {
  const type = obj.type;

  // Anthropic SSE passthrough with state tracking
  if (type === 'message_start') {
    // already sent our own, skip
    return;
  }
  if (type === 'content_block_start') {
    const cb = obj.content_block;
    if (cb && cb.type === 'tool_use') {
      state.currentToolId = cb.id;
      state.currentToolName = cb.name;
      state.toolInputBuf = '';
      state.hasToolUse = true;
    }
    return;
  }
  if (type === 'content_block_delta') {
    const dt = obj.delta && obj.delta.type;
    if (dt === 'text_delta') {
      const text = obj.delta.text || '';
      if (text) {
        const ev = emitTextDelta(res, text, state.blockIndex);
        state.blockIndex = 1;
        emit(state, ev);
      }
    } else if (dt === 'thinking_delta') {
      // skip thinking in stream
    } else if (dt === 'input_json_delta') {
      state.toolInputBuf += obj.delta.partial_json || '';
    }
    return;
  }
  if (type === 'content_block_stop') {
    if (state.currentToolId && state.currentToolName) {
      let input = {};
      try { input = JSON.parse(state.toolInputBuf); } catch(_) {}
      state.toolBlocks.push({ id: state.currentToolId, name: state.currentToolName, input });
      state.currentToolId = null;
      state.currentToolName = null;
      state.toolInputBuf = '';
    }
    return;
  }

  // OpenAI delta format
  if (obj.choices) {
    const delta = obj.choices[0] && obj.choices[0].delta;
    if (delta && delta.content) {
      const ev = emitTextDelta(res, delta.content, state.blockIndex);
      state.blockIndex = 1;
      emit(state, ev);
    }
    return;
  }

  // Google Gemini format
  if (obj.candidates) {
    const parts = obj.candidates[0] && obj.candidates[0].content && obj.candidates[0].content.parts;
    if (Array.isArray(parts)) {
      for (const part of parts) {
        if (part.text) {
          const ev = emitTextDelta(res, part.text, state.blockIndex);
          state.blockIndex = 1;
          emit(state, ev);
        }
      }
    }
    return;
  }

  // OpenAI responses API format
  if (type === 'response.output_text.delta' && typeof obj.delta === 'string') {
    const ev = emitTextDelta(res, obj.delta, state.blockIndex);
    state.blockIndex = 1;
    emit(state, ev);
  }
}

module.exports = { handleStreamProxy };
