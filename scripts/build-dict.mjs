#!/usr/bin/env node
/**
 * 信号台 — 本地词库构建
 *
 * 从 data/feed.js 里挑出英文条目，抽出所有单词，按词频排序后批量查有道词典，
 * 生成 data/dict.js（window.SIGNAL_DICT），让页面划词零请求、离线也能查。
 *
 * 用法: node scripts/build-dict.mjs [词数上限]
 * 环境: DICT_LIMIT=800  并发 DICT_CONC=5
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIMIT = Number(process.argv[2] || process.env.DICT_LIMIT || 800);
const CONC = Number(process.env.DICT_CONC || 5);
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36';

/* 高频虚词不查，纯浪费额度 */
const STOP = new Set(`the a an and or but if then than that this these those there here
of in on at to for from by with without about into onto over under between among during
is are was were be been being am do does did done have has had having will would shall should
can could may might must not no nor so as it its it's they them their theirs we us our you your he she his her
i me my mine who whom whose which what when where why how all any both each few more most other some such
only own same too very just also even still yet thus hence however therefore because while whereas
said says say told according new news report reports reported update updates latest today
one two three four five six seven eight nine ten first second third last next
inc ltd corp co llc plc group company
com www http https html amp nbsp quot apos rsquo lsquo ldquo rdquo mdash ndash
`.split(/\s+/).filter(Boolean));

const code = fs.readFileSync(path.join(ROOT, 'data', 'feed.js'), 'utf8');
const sandbox = { window: {} };
vm.runInNewContext(code, sandbox);
const D = sandbox.window.SIGNAL_DATA;
if (!D) { console.error('data/feed.js 里没有 SIGNAL_DATA'); process.exit(1); }

const pool = [...(D.items || []), ...(D.allItems || [])];
const seen = new Set();
const freq = new Map();

for (const it of pool) {
  if (!it || seen.has(it.id)) continue;
  seen.add(it.id);
  const chunks = [it.title, it.brief].filter(Boolean);
  for (const s of chunks) {
    const str = String(s);
    if (/[\u4e00-\u9fa5]/.test(str)) continue;       // 中文段落跳过
    for (const m of str.matchAll(/[A-Za-z][A-Za-z'’-]{2,}/g)) {
      const w = m[0].toLowerCase().replace(/['’]s$/, '').replace(/[-–]$/, '');
      if (w.length < 3 || w.length > 24) continue;
      if (STOP.has(w)) continue;
      freq.set(w, (freq.get(w) || 0) + 1);
    }
  }
}

/* 词频优先，其次长词（信息量更大），截断到上限 */
const words = [...freq.entries()]
  .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
  .slice(0, LIMIT)
  .map(x => x[0]);

console.log(`候选词 ${freq.size} 个，取前 ${words.length} 个查词`);

async function queryWord(w) {
  const url = 'https://dict.youdao.com/jsonapi?q=' + encodeURIComponent(w);
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 9000);
  try {
    const r = await fetch(url, { signal: ac.signal, headers: { 'user-agent': UA } });
    if (!r.ok) return null;
    const j = await r.json();
    const ec = j && j.ec && j.ec.word && j.ec.word[0];
    if (!ec) return null;
    const ph = String(ec.usphone || ec.ukphone || '').trim();
    const defs = [];
    for (const tr of (ec.trs || [])) {
      for (const one of (tr.tr || [])) {
        const arr = (one.l && one.l.i) || [];
        for (const line of arr) {
          const s = String(line).trim();
          if (s && defs.length < 4 && !defs.includes(s)) defs.push(s);
        }
      }
    }
    if (!defs.length && j.web_trans) {
      const wt = j.web_trans['web-translation'];
      if (wt && wt[0] && wt[0].trans && wt[0].trans[0]) {
        const s = String(wt[0].trans[0].summary && wt[0].trans[0].summary.line || wt[0].trans[0].value || '').replace(/<[^>]+>/g, '').trim();
        if (s) defs.push(s);
      }
    }
    if (!defs.length) return null;
    return { ph, defs };
  } catch { return null; } finally { clearTimeout(t); }
}

const dict = {};
let done = 0, hit = 0;
const queue = [...words];

async function worker() {
  while (queue.length) {
    const w = queue.shift();
    const r = await queryWord(w);
    done++;
    if (r) { dict[w] = { ph: r.ph, defs: r.defs, src: '有道词典' }; hit++; }
    if (done % 50 === 0) console.log(`  已查 ${done}/${words.length}，命中 ${hit}`);
    await new Promise(r2 => setTimeout(r2, 90));
  }
}
await Promise.all(Array.from({ length: CONC }, worker));

const payload = {
  version: 1,
  generatedAt: new Date().toISOString(),
  count: Object.keys(dict).length,
  words: dict
};
fs.writeFileSync(path.join(ROOT, 'data', 'dict.js'),
  'window.SIGNAL_DICT = ' + JSON.stringify(payload.words) + ';\n', 'utf8');

console.log(`词库完成：${Object.keys(dict).length}/${words.length} 个词有中文释义 → data/dict.js`);
