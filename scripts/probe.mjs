#!/usr/bin/env node
/**
 * 信号台 — 信源可用性探测
 * 批量验证候选 RSS：ok=可用 / cloud=本机网络不可达，交 GitHub Actions 境外机器 / dead=明显死链，剔除
 * 用法: node scripts/probe.mjs [候选清单.json]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36';
const TIMEOUT = 12000;
const CONCURRENCY = 10;

const current = JSON.parse(fs.readFileSync(path.join(ROOT, 'sources.json'), 'utf8'));
const extraPath = process.argv[2] || path.join(ROOT, 'scripts', 'source-candidates.json');
const extra = JSON.parse(fs.readFileSync(extraPath, 'utf8'));
const all = [...current.sources.map(s => ({ ...s, existing: true })), ...extra.map(s => ({ ...s, existing: false }))];

async function probe(s) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT);
  try {
    const res = await fetch(s.url, {
      signal: ctl.signal,
      redirect: 'follow',
      headers: { 'User-Agent': UA, 'Accept': 'application/rss+xml,application/atom+xml,application/xml,text/xml,*/*' }
    });
    clearTimeout(timer);
    if (!res.ok) return { ...s, verdict: res.status >= 500 ? 'cloud' : 'dead', detail: 'HTTP ' + res.status };
    const xml = (await res.text()).slice(0, 400000);
    const isFeed = /<\?xml|<rss[\s>]|<feed[\s>]|<rdf:RDF/i.test(xml.slice(0, 1200));
    if (!isFeed) return { ...s, verdict: 'dead', detail: '非 RSS 内容' };
    const n = (xml.match(/<(item|entry)[\s>]/gi) || []).length;
    const hasDate = /<(pubDate|published|updated|dc:date|date)[\s>]/i.test(xml);
    if (!n) return { ...s, verdict: 'dead', detail: '0 条目' };
    return { ...s, verdict: 'ok', detail: n + ' 条目' + (hasDate ? '' : ' / 无日期(会被丢弃)'), entries: n, hasDate };
  } catch (e) {
    clearTimeout(timer);
    const code = String(e.cause?.code || e.message || e);
    return { ...s, verdict: 'cloud', detail: code.slice(0, 60) };
  }
}

const results = [];
for (let i = 0; i < all.length; i += CONCURRENCY) {
  const batch = await Promise.all(all.slice(i, i + CONCURRENCY).map(probe));
  results.push(...batch);
  process.stderr.write(`  ${Math.min(i + CONCURRENCY, all.length)}/${all.length}\n`);
}

const order = { ok: 0, cloud: 1, dead: 2 };
results.sort((a, b) => order[a.verdict] - order[b.verdict] || a.name.localeCompare(b.name));
const report = {
  probedAt: new Date().toISOString(),
  total: results.length,
  counts: {
    ok: results.filter(r => r.verdict === 'ok').length,
    cloud: results.filter(r => r.verdict === 'cloud').length,
    dead: results.filter(r => r.verdict === 'dead').length
  },
  results
};
fs.writeFileSync(path.join(ROOT, 'scripts', 'probe-report.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
console.log(`总计 ${report.total} | 可用 ${report.counts.ok} | 交云端 ${report.counts.cloud} | 死链 ${report.counts.dead}`);
for (const v of ['ok', 'cloud', 'dead']) {
  console.log(`\n=== ${v.toUpperCase()} (${report.counts[v]}) ===`);
  for (const r of results.filter(x => x.verdict === v)) {
    console.log(`  ${r.existing ? '[旧]' : '[新]'} ${r.name.padEnd(24)} ${r.detail}`);
  }
}
console.log('\n报告: scripts/probe-report.json');
