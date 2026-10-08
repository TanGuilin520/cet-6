(() => {
  'use strict';

  const STORAGE_KEY = 'cet:writing-template-library:v1';
  const MAX_SOURCE = 12000;
  const MAX_SLOTS = 40;
  const MAX_VALUE = 1000;
  const MAX_TEMPLATES = 30;

  function message(error, fallback) {
    return new Error(error && error.name === 'QuotaExceededError'
      ? '浏览器存储空间不足。原有模板未被覆盖，请先导出备份或释放空间。'
      : fallback);
  }

  function validSource(source) {
    if (typeof source !== 'string') throw new Error('模板正文必须是文字。');
    if (source.length > MAX_SOURCE) throw new Error('模板正文最多 12,000 个字符。');
    if (source.includes('\0')) throw new Error('模板正文含有非法 NUL 字符，请使用 UTF-8 文本文件。');
    return source;
  }

  function parse(source, suppliedSlots = []) {
    validSource(source);
    if (!Array.isArray(suppliedSlots) || suppliedSlots.length > MAX_SLOTS) {
      throw new Error('模板最多支持 40 个填空。');
    }
    const existing = new Map();
    suppliedSlots.forEach((slot) => {
      if (!slot || typeof slot.name !== 'string' || typeof slot.value !== 'string') {
        throw new Error('填空需要名称和文字内容。');
      }
      if (slot.value.length > MAX_VALUE || slot.value.includes('\0')) {
        throw new Error('每个填空最多 1,000 个字符，且不能含有 NUL 字符。');
      }
      if (slot.type && slot.type !== 'word' && slot.type !== 'sentence') {
        throw new Error('填空类型只能是单词或句子。');
      }
      existing.set(slot.name.trim(), { value: slot.value, type: slot.type || 'sentence' });
    });
    const result = [];
    const found = new Set();
    const remaining = source.replace(/\{\{([^{}]*)\}\}/g, (_match, rawName) => {
      const name = rawName.trim();
      if (!name) throw new Error('填空名称不能为空，请使用 {{主题}} 这样的格式。');
      if (name.length > 80) throw new Error('填空名称最多 80 个字符。');
      if (/[\r\n]/.test(rawName)) throw new Error('填空名称不能换行，请在同一行使用 {{名称}}。');
      if (!found.has(name)) {
        if (result.length >= MAX_SLOTS) throw new Error('模板最多支持 40 个不同名称的填空。');
        const previous = existing.get(name);
        result.push({ name, value: previous ? previous.value : '', type: previous ? previous.type : 'sentence' });
        found.add(name);
      }
      return '';
    });
    if (remaining.includes('{{') || remaining.includes('}}')) {
      throw new Error('填空格式不完整，请使用成对的 {{名称}}，名称中不能嵌套大括号。');
    }
    return result;
  }

  function normalize(record) {
    if (!record || typeof record.id !== 'string' || !/^[A-Za-z0-9._-]{1,80}$/.test(record.id)) {
      throw new Error('模板标识无效。');
    }
    if (typeof record.name !== 'string' || !record.name.trim() || record.name.trim().length > 80 || record.name.includes('\0')) {
      throw new Error('请填写模板名称，最多 80 个字符。');
    }
    if (typeof record.source !== 'string' || !record.source.trim()) throw new Error('请先填写模板正文。');
    return {
      id: record.id,
      name: record.name.trim(),
      source: validSource(record.source),
      slots: parse(record.source, record.slots || []),
      updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : '',
    };
  }

  function list() {
    let raw;
    try { raw = localStorage.getItem(STORAGE_KEY); }
    catch (error) { throw message(error, '浏览器无法读取模板库，请检查是否禁止了本地存储。'); }
    if (!raw) return [];
    try {
      const records = JSON.parse(raw);
      if (!Array.isArray(records) || records.length > MAX_TEMPLATES) throw new Error('Invalid template library');
      const normalized = records.map(normalize);
      if (new Set(normalized.map((item) => item.id)).size !== normalized.length) throw new Error('Duplicate template ID');
      return normalized;
    } catch (_error) {
      throw new Error('已有模板库数据无法读取。为保护原有资料，已停止写入；请先备份浏览器数据。');
    }
  }

  function get(id) { return list().find((template) => template.id === id) || null; }

  function write(records) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(records)); }
    catch (error) { throw message(error, '保存失败：浏览器不允许写入本地存储。原有模板未被覆盖，请保留当前输入或导出。'); }
  }

  function save(input) {
    if (!input || typeof input !== 'object') throw new Error('请先填写模板内容。');
    const records = list();
    const previousIndex = input.id ? records.findIndex((record) => record.id === input.id) : -1;
    if (input.id && previousIndex < 0) throw new Error('此模板已被删除，请新建模板后保存。');
    if (!input.id && records.length >= MAX_TEMPLATES) throw new Error('模板库最多保存 30 份模板，请先导出并删除不再使用的模板。');
    const id = input.id || `writing-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    const template = normalize({ ...input, id, updatedAt: new Date().toISOString() });
    if (previousIndex >= 0) records[previousIndex] = template;
    else records.unshift(template);
    write(records);
    return template;
  }

  function remove(id) {
    const records = list();
    const filtered = records.filter((record) => record.id !== id);
    if (records.length === filtered.length) return false;
    write(filtered);
    return true;
  }

  function compile(template, showPlaceholders = true) {
    if (!template || typeof template.source !== 'string') throw new Error('请选择一份模板。');
    const slots = parse(template.source, template.slots || []);
    const values = new Map(slots.map((slot) => [slot.name, slot.value]));
    return template.source.replace(/\{\{([^{}]*)\}\}/g, (_match, name) => {
      const key = name.trim();
      return values.get(key) || (showPlaceholders ? `{{${key}}}` : '');
    });
  }

  window.WritingTemplates = Object.freeze({ list, get, save, remove, parse, compile });
})();
