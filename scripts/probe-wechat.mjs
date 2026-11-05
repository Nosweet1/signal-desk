#!/usr/bin/env node
/**
 * 公众号源体检：拉取 wechat2rss 的 feed，报告条目数与最新发布时间，筛掉停更号。
 * 用法: node scripts/probe-wechat.mjs <names.txt|->   （每行一个公众号名）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36';

// 直接从官方列表页解析「公众号名 -> feed id」，不需要手工维护
const LIST_URL = 'https://wechat2rss.xlab.app/list/all';
const html = await (await fetch(LIST_URL, { headers: { 'User-Agent': UA } })).text();
const map = new Map();
for (const m of html.matchAll(/<a[^>]*href="[^"]*feed\/([a-f0-9]{20,})[^"]*"[^>]*>([^<]{1,40})<\/a>/g)) {
  map.set(m[2].trim(), m[1]);
}

const arg = process.argv[2];
const names = arg && arg !== '-'
  ? fs.readFileSync(arg, 'utf8').split('\n').map(s => s.trim()).filter(Boolean)
  : [...map.keys()];

const wanted = names.filter(n => map.has(n)).map(n => ({ name: n, id: map.get(n) }));
const missing = names.filter(n => !map.has(n));

async function check({ name, id }) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20000);
  try {
    const res = await fetch(`https://wechat2rss.xlab.app/feed/${id}.xml`, {
      signal: ctl.signal,
      headers: { 'User-Agent': UA, 'Accept': 'application/rss+xml,text/xml,*/*' }
    });
    clearTimeout(timer);
    if (!res.ok) return { name, id, ok: false, detail: 'HTTP ' + res.status };
    const xml = await res.text();
    const dates = [...xml.matchAll(/<pubDate>([^<]+)<\/pubDate>/gi)].map(m => Date.parse(m[1])).filter(Number.isFinite);
    const n = (xml.match(/<item[\s>]/gi) || []).length;
    const latest = dates.length ? Math.max(...dates) : 0;
    const ageH = latest ? Math.round((Date.now() - latest) / 3600000) : -1;
    return { name, id, ok: n > 0 && ageH >= 0 && ageH < 24 * 14, detail: `${n} 条 / 最新 ${ageH}h 前`, ageH, n };
  } catch (e) {
    clearTimeout(timer);
    return { name, id, ok: false, detail: String(e.cause?.code || e.message).slice(0, 40) };
  }
}

const queue = [...wanted];
const out = [];
async function worker() {
  while (queue.length) {
    const s = queue.shift();
    const r = await check(s);
    out.push(r);
    console.log(`${r.ok ? 'FRESH' : 'STALE'}\t${r.name}\t${r.detail}\t${r.id}`);
  }
}
await Promise.all(Array.from({ length: 8 }, worker));

const fresh = out.filter(x => x.ok).sort((a, b) => a.ageH - b.ageH);
fs.writeFileSync(path.join(ROOT, 'scripts', 'wechat-report.json'), JSON.stringify({
  generatedAt: new Date().toISOString(), fresh, stale: out.filter(x => !x.ok), missing
}, null, 2) + '\n', 'utf8');
console.log(`\n可用 ${fresh.length} / 检测 ${out.length}；列表中不存在：${missing.join(' / ') || '无'}`);
