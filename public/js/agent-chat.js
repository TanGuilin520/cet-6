(() => {
  'use strict';
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  let runtimePromise;
  function conversationId(value) {
    if (typeof value === 'string' && UUID.test(value)) return value.toLowerCase();
    if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
    const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  function normalizeConversations(value) {
    return Object.fromEntries(Object.entries(value && typeof value === 'object' && !Array.isArray(value) ? value : {})
      .filter(([key, id]) => /^(?:general|selection|question:(?:q[1-9][0-9]{0,2}|(?:writing|translation)-[1-9][0-9]{0,2}))$/.test(key) && typeof id === 'string' && UUID.test(id)).slice(-302));
  }
  function runtime() {
    if (!runtimePromise) runtimePromise = (async () => {
      const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 6500);
      try {
        const response = await fetch('/api/exams/capabilities', { headers: { Accept: 'application/json' }, signal: controller.signal });
        if (!response.ok) return null;
        const data = await response.json();
        return data && typeof data.agent === 'object' ? { ...data.agent, retrieval: data.retrieval } : {};
      } catch (_error) { return null; }
      finally { clearTimeout(timer); }
    })();
    return runtimePromise;
  }
  function runtimeLabel(agent, scope) {
    if (!agent) return '运行状态无法确认；本地服务或状态接口暂不可用。';
    if (scope !== 'question') return '当前模式：主服务直连 DeepSeek（不经过 LangGraph；是否成功调用以本次回复为准）。';
    if (agent.configured !== true) return 'LangGraph 未启用；当前题目由主服务处理，模型是否可用以本次回复为准。';
    if (agent.reachable !== true) return 'LangGraph 已配置但不可连接；本次请求可能使用主服务回退。';
    if (agent.ready !== true) return 'LangGraph 可连接但尚未就绪；本次请求可能使用主服务回退。';
    const semantic = agent.retrieval?.semanticReady === true
      ? '本地语义服务已就绪'
      : '基础词项检索（语义服务未启用）';
    return `LangGraph 已就绪${agent.memory === true ? ' · 当前题目支持会话记忆' : ''} · ${semantic}；实际执行工具见回复记录。`;
  }
  function progressLabel(data) {
    if (!data || typeof data !== 'object') return '';
    const node = typeof data.node === 'string' ? data.node.slice(0, 80) : '';
    const tool = typeof data.tool === 'string' ? data.tool.slice(0, 80) : '';
    const label = typeof data.label === 'string' ? data.label.replace(/[\r\n]/g, ' ').slice(0, 160) : '';
    return [label || (node ? `执行节点：${node}` : ''), tool ? `工具：${tool}` : '', typeof data.status === 'string' ? data.status.slice(0, 40) : ''].filter(Boolean).join(' · ');
  }
  async function jsonResponse(response, scope) {
    const data = await response.json().catch(() => null);
    if (!response.ok) throw Object.assign(new Error('AI 请求未完成'), { httpStatus: response.status, serverDetail: typeof data?.error === 'string' ? data.error.slice(0, 200) : '', revisionChanged: response.status === 409 && scope === 'question' });
    return data;
  }
  async function request({ url, body, signal, onProgress, onDelta }) {
    const capabilities = await runtime();
    if (signal?.aborted) throw new DOMException('Request aborted', 'AbortError');
    const encoded = typeof body === 'string' ? body : JSON.stringify(body);
    const scope = typeof body === 'object' ? body.scope : (() => { try { return JSON.parse(body).scope; } catch (_error) { return ''; } })();
    const options = { method: 'POST', signal, headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: encoded };
    // Legacy deployments without the advertised stream contract use one JSON
    // request. Never repeat a model request after a stream has begun.
    if (capabilities?.streaming !== true) return jsonResponse(await fetch(url, options), scope);
    const response = await fetch(`${url}/stream`, { ...options, headers: { ...options.headers, Accept: 'text/event-stream' } });
    if (response.status === 404 || response.status === 405) return jsonResponse(await fetch(url, options), scope);
    if (!response.ok) return jsonResponse(response, scope);
    if (!/^text\/event-stream(?:;|$)/i.test(response.headers.get('Content-Type') || '') || !response.body) throw Object.assign(new Error('AI 流式响应格式无效'), { fallbackReason: 'invalid_response' });
    const reader = response.body.getReader(); const decoder = new TextDecoder();
    let buffer = ''; let received = 0; let deltaChars = 0;
    try {
      while (true) {
        if (signal?.aborted) throw new DOMException('Request aborted', 'AbortError');
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > 1024 * 1024) throw new Error('AI 回复数据过长，请缩短问题后重试。');
        buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, '\n');
        if (buffer.length > 256 * 1024) throw new Error('AI 回复事件过长。');
        let boundary;
        while ((boundary = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
          let event = 'message'; const lines = [];
          frame.split('\n').forEach((line) => { if (line.startsWith('event:')) event = line.slice(6).trim(); else if (line.startsWith('data:')) lines.push(line.slice(5).trimStart()); });
          if (!lines.length) continue;
          let data;
          try { data = JSON.parse(lines.join('\n')); } catch (_error) { throw Object.assign(new Error('AI 回复事件格式异常'), { fallbackReason: 'invalid_response' }); }
          if (event === 'progress') onProgress?.(data);
          else if (event === 'reply_delta') {
            if (typeof data?.text !== 'string' || data.text.includes('\0')) throw new Error('AI 增量回复格式异常。');
            deltaChars += data.text.length;
            if (deltaChars > 16000) throw new Error('AI 增量回复过长。');
            onDelta?.(data.text);
          } else if (event === 'result') {
            if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('AI 结果格式异常。');
            return data;
          } else if (event === 'error') {
            const status = Number.isInteger(data?.status) ? data.status : Number.isInteger(data?.code) ? data.code : null;
            throw Object.assign(new Error('AI 流式请求未完成'), { serverDetail: typeof data?.message === 'string' ? data.message.slice(0, 200) : '', fallbackReason: typeof data?.code === 'string' ? data.code : null, httpStatus: status, revisionChanged: status === 409 && scope === 'question' });
          }
        }
      }
      // Even after deltas, a terminal result is mandatory before committing
      // anything to final conversation history.
      throw Object.assign(new Error('AI 连接已结束但未返回完整结果，当前输入保留。'), { fallbackReason: 'agent_transport_error' });
    } finally { await reader.cancel().catch(() => {}); }
  }
  async function clearConversation({ url, conversationId: id, scope, questionId }) {
    const capabilities = await runtime();
    if (scope !== 'question' || capabilities?.memory !== true) return false;
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch(`${url}/conversations/clear`, { method: 'POST', signal: controller.signal, headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ conversationId: conversationId(id), scope, questionId }) });
      await jsonResponse(response, scope);
      return true;
    } finally { clearTimeout(timer); }
  }
  function normalizeExecution(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const integer = (number, max) => Number.isInteger(number) && number >= 0 && number <= max ? number : null;
    return { mode: ['dynamic_tools', 'deterministic'].includes(value.mode) ? value.mode : '', rounds: integer(value.rounds, 100), toolCalls: integer(value.toolCalls, 100), stopReason: typeof value.stopReason === 'string' ? value.stopReason.slice(0, 100) : '' };
  }
  window.AgentChat = Object.freeze({ conversationId, normalizeConversations, runtime, runtimeLabel, progressLabel, request, clearConversation, normalizeExecution });
})();
