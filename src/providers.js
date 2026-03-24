'use strict';

function normalizeModelName(name) {
  if (!name) return 'claude-sonnet-4-6';
  // Anthropic
  if (name.startsWith('claude-sonnet-4-6')) return 'claude-sonnet-4-6';
  if (name.startsWith('claude-sonnet-4-5')) return 'claude-sonnet-4-5';
  if (name.startsWith('claude-haiku-4-5')) return 'claude-haiku-4-5';
  // OpenAI
  if (name.startsWith('gpt-5.4')) return 'gpt-5.4';
  if (name.startsWith('gpt-5.3-codex')) return 'gpt-5.3-codex';
  if (name.startsWith('gpt-5.2-codex')) return 'gpt-5.2-codex';
  if (name.startsWith('gpt-5.2')) return 'gpt-5.2';
  if (name.startsWith('gpt-5-mini')) return 'gpt-5-mini';
  if (name.startsWith('gpt-5-nano')) return 'gpt-5-nano';
  // Google
  if (name.startsWith('gemini-3.1-pro-preview')) return 'gemini-3.1-pro-preview';
  if (name.startsWith('gemini-3-pro-preview')) return 'gemini-3-pro-preview';
  if (name.startsWith('gemini-3-flash')) return 'gemini-3-flash';
  // xAI
  if (name.startsWith('grok-4-fast-reasoning')) return 'grok-4-fast-reasoning';
  if (name.startsWith('grok-4-fast-non-reasoning')) return 'grok-4-fast-non-reasoning';
  if (name.startsWith('grok-code-fast-1')) return 'grok-code-fast-1';
  if (name.startsWith('grok-4')) return 'grok-4';
  return name;
}

function getProvider(model) {
  if (model.startsWith('claude')) return 'anthropic';
  if (model.startsWith('gpt-')) return 'open_ai';
  if (model.startsWith('gemini')) return 'google';
  if (model.startsWith('grok')) return 'x_ai';
  return 'anthropic';
}

function fakeUuid() {
  return 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx'.replace(/x/g, () =>
    Math.floor(Math.random() * 16).toString(16));
}

function extractSystemText(parsed) {
  const sys = parsed.system;
  if (!sys) return null;
  if (typeof sys === 'string') return sys;
  if (Array.isArray(sys)) {
    return sys.filter(b => b && b.type === 'text' && b.text)
      .map(b => b.text).join('\n\n') || null;
  }
  return null;
}

// Convert OpenAI tool role message -> Anthropic tool_result
function convertToolMessage(msg) {
  return {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: msg.tool_call_id, content: msg.content }],
  };
}

// Convert OpenAI assistant message with tool_calls -> Anthropic tool_use
function convertAssistantWithTools(msg) {
  const content = [];
  if (msg.content && msg.content.length > 0) {
    content.push({ type: 'text', text: msg.content });
  }
  if (Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls) {
      let input = {};
      try { input = JSON.parse(tc.function.arguments); } catch (_) { }
      content.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input });
    }
  }
  return { role: 'assistant', content };
}

function convertOpenAIMessage(msg) {
  if (msg.role === 'tool') return convertToolMessage(msg);
  if (msg.role === 'assistant' && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
    return convertAssistantWithTools(msg);
  }
  const content = typeof msg.content === 'string'
    ? [{ type: 'text', text: msg.content }]
    : (msg.content || []);
  return { role: msg.role, content };
}

function buildAnthropicRequest(parsed, model, isAnthropic) {
  const req = { model, stream: true };
  req.max_tokens = parsed.max_tokens || 8192;
  if (parsed.temperature !== undefined) req.temperature = parsed.temperature;
  if (parsed.thinking) req.thinking = parsed.thinking;

  if (isAnthropic) {
    const sysText = extractSystemText(parsed);
    if (sysText) req.system = sysText;
    if (parsed.tools) req.tools = parsed.tools;
    if (parsed.tool_choice) req.tool_choice = parsed.tool_choice;
    req.messages = parsed.messages || [];
  } else {
    // OpenAI -> Anthropic conversion
    const messages = parsed.messages || [];
    const sysMsg = messages.find(m => m.role === 'system');
    if (sysMsg) req.system = typeof sysMsg.content === 'string' ? sysMsg.content : sysMsg.content.map(c => c.text || '').join('');
    req.messages = messages.filter(m => m.role !== 'system').map(convertOpenAIMessage);
    // Convert OpenAI tools to Anthropic format
    if (Array.isArray(parsed.tools)) {
      req.tools = parsed.tools.map(t => ({
        name: t.function.name,
        description: t.function.description,
        input_schema: t.function.parameters || {},
      }));
    }
  }
  return req;
}

function buildOpenAIRequest(parsed, model, isAnthropic) {
  // Zed uses the OpenAI Responses API format: input[] with typed content
  const input = [];

  if (isAnthropic) {
    const sysText = extractSystemText(parsed);
    if (sysText) {
      input.push({ type: 'message', role: 'system', content: [{ type: 'input_text', text: sysText }] });
    }
  }

  for (const msg of (parsed.messages || [])) {
    const role = msg.role;
    if (role === 'system') {
      const text = typeof msg.content === 'string' ? msg.content
        : Array.isArray(msg.content) ? msg.content.map(c => c.text || '').join('') : '';
      input.push({ type: 'message', role: 'system', content: [{ type: 'input_text', text }] });
      continue;
    }
    const contentType = role === 'assistant' ? 'output_text' : 'input_text';
    let contentArr;
    if (typeof msg.content === 'string') {
      contentArr = [{ type: contentType, text: msg.content }];
    } else if (Array.isArray(msg.content)) {
      contentArr = msg.content
        .filter(c => c && c.text)
        .map(c => ({ type: contentType, text: c.text }));
    } else {
      contentArr = [];
    }
    input.push({ type: 'message', role, content: contentArr });
  }

  const req = { model, stream: true, input };
  if (parsed.temperature !== undefined) req.temperature = parsed.temperature;
  else req.temperature = 1.0;
  return req;
}

function buildGoogleRequest(parsed, model, isAnthropic) {
  const req = { model, stream: true };
  const messages = parsed.messages || [];
  req.contents = messages
    .filter(m => m.role !== 'system')
    .map(msg => {
      const role = msg.role === 'assistant' ? 'model' : msg.role;
      let parts;
      if (typeof msg.content === 'string') {
        parts = [{ text: msg.content }];
      } else if (Array.isArray(msg.content)) {
        parts = msg.content.filter(c => c.text).map(c => ({ text: c.text }));
      } else {
        parts = [];
      }
      return { parts, role };
    });
  return req;
}

function buildXAIRequest(parsed, model, isAnthropic) {
  const messages = [];
  if (isAnthropic) {
    const sysText = extractSystemText(parsed);
    if (sysText) messages.push({ role: 'system', content: sysText });
  }
  const src = parsed.messages || [];
  for (const msg of src) {
    if (msg.role === 'system') { messages.push(msg); continue; }
    const content = typeof msg.content === 'string' ? msg.content :
      Array.isArray(msg.content) ? msg.content.map(c => c.text || '').join('') : '';
    messages.push({ role: msg.role, content });
  }
  return { model, stream: true, temperature: parsed.temperature ?? 1.0, messages };
}

function buildZedPayload(body, isAnthropic) {
  const parsed = JSON.parse(body);
  const model = normalizeModelName(parsed.model);
  const provider = getProvider(model);

  let providerRequest;
  if (provider === 'anthropic') {
    providerRequest = buildAnthropicRequest(parsed, model, isAnthropic);
  } else if (provider === 'open_ai') {
    providerRequest = buildOpenAIRequest(parsed, model, isAnthropic);
  } else if (provider === 'google') {
    providerRequest = buildGoogleRequest(parsed, model, isAnthropic);
  } else {
    providerRequest = buildXAIRequest(parsed, model, isAnthropic);
  }

  return JSON.stringify({
    thread_id: fakeUuid(),
    prompt_id: fakeUuid(),
    intent: 'user_prompt',
    provider,
    model,
    provider_request: providerRequest,
  });
}

// ── Non-streaming response conversion ──

function extractContentFromStream(responseText) {
  let text = '';
  let thinking = null;
  const toolCalls = [];
  let currentToolId = null;
  let currentToolName = null;
  let toolInputBuf = '';
  let toolCount = 0;

  for (const line of responseText.split('\n')) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch (_) { continue; }

    // Handle event wrapper
    if (obj.event && typeof obj.event === 'object') obj = obj.event;

    const type = obj.type;
    if (!type) {
      // OpenAI delta format
      if (obj.choices) {
        const delta = obj.choices[0]?.delta;
        if (delta?.content) text += delta.content;
      }
      // Google format
      if (obj.candidates) {
        const parts = obj.candidates[0]?.content?.parts;
        if (Array.isArray(parts)) for (const p of parts) if (p.text) text += p.text;
      }
      continue;
    }

    if (type === 'response.output_text.delta') {
      if (typeof obj.delta === 'string') text += obj.delta;
      continue;
    }
    if (type === 'content_block_start') {
      const cb = obj.content_block;
      if (cb?.type === 'tool_use') {
        currentToolId = cb.id;
        currentToolName = cb.name;
        toolInputBuf = '';
      }
      continue;
    }
    if (type === 'content_block_delta') {
      const dt = obj.delta?.type;
      if (dt === 'text_delta') text += obj.delta.text || '';
      else if (dt === 'thinking_delta') thinking = (thinking || '') + (obj.delta.thinking || '');
      else if (dt === 'input_json_delta') toolInputBuf += obj.delta.partial_json || '';
      continue;
    }
    if (type === 'content_block_stop') {
      if (currentToolId && currentToolName) {
        let input = {};
        try { input = JSON.parse(toolInputBuf); } catch (_) { }
        toolCalls.push({ id: currentToolId, name: currentToolName, input });
        toolCount++;
        currentToolId = null;
        currentToolName = null;
        toolInputBuf = '';
      }
      continue;
    }
  }

  return { text, thinking, toolCalls: toolCount > 0 ? toolCalls : null };
}

function convertToOpenAI(responseText) {
  const { text, thinking, toolCalls } = extractContentFromStream(responseText);
  const result = {
    id: 'chatcmpl-zed',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: 'zed',
    choices: [{
      index: 0,
      message: { role: 'assistant', content: text },
      finish_reason: toolCalls ? 'tool_calls' : 'stop',
    }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
  if (toolCalls) {
    result.choices[0].message.tool_calls = toolCalls.map(tc => ({
      id: tc.id,
      type: 'function',
      function: { name: tc.name, arguments: JSON.stringify(tc.input) },
    }));
  }
  return JSON.stringify(result);
}

function convertToAnthropic(responseText) {
  const { text, thinking, toolCalls } = extractContentFromStream(responseText);
  const content = [];
  if (thinking) content.push({ type: 'thinking', thinking });
  if (toolCalls) {
    for (const tc of toolCalls) content.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input });
  }
  if (!toolCalls) content.push({ type: 'text', text });
  if (content.length === 0) content.push({ type: 'text', text: '' });
  const stop_reason = toolCalls ? 'tool_use' : 'end_turn';
  return JSON.stringify({
    id: 'msg_zed',
    type: 'message',
    role: 'assistant',
    content,
    model: 'zed',
    stop_reason,
    usage: { input_tokens: 0, output_tokens: 0 },
  });
}

module.exports = { buildZedPayload, convertToOpenAI, convertToAnthropic, normalizeModelName, getProvider };
