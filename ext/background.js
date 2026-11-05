/**
 * 信号台划词 · 背景服务
 * 负责跨域请求（有道词典 / MyMemory / dictionaryapi），并做本地缓存。
 */
const CACHE_PREFIX = 'sd:';
const CACHE_TTL = 1000 * 3600 * 24 * 30; // 30 天

async function cacheGet(key) {
  const k = CACHE_PREFIX + key;
  const o = await chrome.storage.local.get(k);
  const v = o[k];
  if (!v) return null;
  if (Date.now() - v.t > CACHE_TTL) { chrome.storage.local.remove(k); return null; }
  return v.d;
}
async function cacheSet(key, data) {
  const k = CACHE_PREFIX + key;
  await chrome.storage.local.set({ [k]: { t: Date.now(), d: data } });
}

async function youdao(word) {
  const url = 'https://dict.youdao.com/jsonapi?q=' + encodeURIComponent(word);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 9000);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    if (!r.ok) return null;
    const j = await r.json();
    const ec = j && j.ec && j.ec.word && j.ec.word[0];
    if (!ec) return null;
    const ph = String(ec.usphone || ec.ukphone || '').trim();
    const defs = [];
    for (const tr of (ec.trs || [])) {
      for (const one of (tr.tr || [])) {
        for (const line of ((one.l && one.l.i) || [])) {
          const s = String(line).trim();
          if (s && defs.length < 4 && defs.indexOf(s) < 0) defs.push(s);
        }
      }
    }
    if (!defs.length) return null;
    return { kind: 'word', word, ph, defs, src: '有道词典' };
  } catch { return null; } finally { clearTimeout(timer); }
}

async function dictDev(word) {
  try {
    const r = await fetch('https://api.dictionaryapi.dev/api/v2/entries/en/' + encodeURIComponent(word));
    if (!r.ok) return null;
    const j = await r.json();
    if (!j || !j[0]) return null;
    const ph = String(j[0].phonetic || (j[0].phonetics && j[0].phonetics[0] && j[0].phonetics[0].text) || '').replace(/\//g, '').trim();
    const defs = [];
    for (const m of (j[0].meanings || [])) {
      if (m.partOfSpeech && m.definitions && m.definitions[0]) {
        defs.push(m.partOfSpeech + '. ' + m.definitions[0].definition);
      }
      if (defs.length >= 3) break;
    }
    if (!defs.length) return null;
    return { kind: 'word', word, ph, defs, src: 'dictionaryapi.dev（英文释义）' };
  } catch { return null; }
}

async function translate(text) {
  const url = 'https://api.mymemory.translated.net/get?q='
    + encodeURIComponent(text.slice(0, 480)) + '&langpair=en|zh-CN';
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    const j = await r.json();
    const out = String((j.responseData && j.responseData.translatedText) || '').trim();
    if (!out || /MYMEMORY WARNING|QUERY LENGTH LIMIT|INVALID/i.test(out)) return null;
    if (out.toLowerCase() === text.toLowerCase()) return null;
    return { kind: 'sentence', src: text, dst: out, provider: 'MyMemory' };
  } catch { return null; }
}

function isWord(s) {
  return /^[A-Za-z][A-Za-z'’.-]*$/.test(s) && s.length <= 32;
}

async function handle(q) {
  const text = String(q || '').replace(/\s+/g, ' ').trim();
  if (!text) return { error: '空' };

  if (isWord(text)) {
    const key = 'w:' + text.toLowerCase();
    const hit = await cacheGet(key);
    if (hit) return hit;

    let data = await youdao(text);
    if (!data) data = await dictDev(text);
    if (!data) {
      const t = await translate(text);
      if (t) data = { kind: 'word', word: text, ph: '', defs: [t.dst], src: 'MyMemory 机器翻译' };
    }
    if (!data) return { error: '未查到「' + text + '」' };
    await cacheSet(key, data);
    return data;
  }

  const key = 's:' + text.slice(0, 120);
  const hit = await cacheGet(key);
  if (hit) return hit;
  const t = await translate(text);
  if (!t) return { error: '翻译失败，稍后再试' };
  await cacheSet(key, t);
  return t;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'sd-lookup') {
    handle(msg.q).then(sendResponse).catch(e => sendResponse({ error: String(e && e.message || e) }));
    return true; // 异步响应
  }
  return false;
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'sd-translate-selection',
    title: '信号台：翻译“%s”',
    contexts: ['selection']
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'sd-translate-selection' && tab && tab.id) {
    chrome.tabs.sendMessage(tab.id, { type: 'sd-translate-again', q: info.selectionText }).catch(() => {});
  }
});
