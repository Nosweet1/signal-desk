#!/usr/bin/env node
/**
 * 把微信公众号接进信号台。
 *
 * 公众号没有官方 RSS，这里走 wechat2rss 公共实例（免费覆盖 300+ 号，更新周期约 24 小时）：
 * 输入公众号名 → 在官方列表里匹配 → 校验有更新 → 自动写进 sources.json。
 *
 * 用法:
 *   node scripts/add-wechat.mjs 机器之心
 *   node scripts/add-wechat.mjs 机器之心 frontier
 *   node scripts/add-wechat.mjs --search 芯片      # 只搜不写
 *   node scripts/add-wechat.mjs --list             # 看已接入的公众号
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CFG_PATH = path.join(ROOT, 'sources.json');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36';
const LIST_URL = 'https://wechat2rss.xlab.app/list/all';
const FEED = id => `https://wechat2rss.xlab.app/feed/${id}.xml`;

const cfg = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
const args = process.argv.slice(2);

if (args.includes('--list')) {
  const mine = cfg.sources.filter(s => s.type === 'wechat');
  console.log(`已接入 ${mine.length} 个公众号：`);
  mine.forEach(s => console.log(`  ${s.name.replace(/^公众号 /, '').padEnd(16, ' ')} ${s.category.padEnd(9, ' ')} ${s.url}`));
  process.exit(0);
}

const searchOnly = args.includes('--search');
const positional = args.filter(a => !a.startsWith('--'));
const query = positional[0];
const category = positional[1] || 'frontier';
if (!query) {
  console.error('用法: node scripts/add-wechat.mjs <公众号名> [frontier|survival|order|economy]');
  process.exit(1);
}
if (!cfg.categories.some(c => c.id === category)) {
  console.error(`栏目 ${category} 不存在，可选: ${cfg.categories.map(c => c.id).join(' / ')}`);
  process.exit(1);
}

async function loadList() {
  const res = await fetch(LIST_URL, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error('列表页 HTTP ' + res.status);
  const html = await res.text();
  const out = [];
  for (const m of html.matchAll(/<a[^>]*href="[^"]*feed\/([a-f0-9]{20,})[^"]*"[^>]*>([^<]{1,40})<\/a>/g)) {
    out.push({ name: m[2].trim(), id: m[1] });
  }
  return out;
}

const list = await loadList();
const hits = list.filter(x => x.name.includes(query) || query.includes(x.name));

if (!hits.length) {
  console.log(`列表里没有匹配「${query}」的公众号（共 ${list.length} 个可选）。`);
  console.log('可以换关键词，或用 --search 看看相近的名字。');
  process.exit(0);
}
if (searchOnly) {
  hits.forEach(x => console.log(`  ${x.name}  ${FEED(x.id)}`));
  process.exit(0);
}

const target = hits[0];
if (hits.length > 1) console.log(`匹配到 ${hits.length} 个，取第一个：${target.name}`);

// 校验能不能抓、有没有在更新
const ctl = new AbortController();
const timer = setTimeout(() => ctl.abort(), 20000);
const res = await fetch(FEED(target.id), { signal: ctl.signal, headers: { 'User-Agent': UA } });
clearTimeout(timer);
if (!res.ok) {
  console.error(`拉取失败：HTTP ${res.status}（这个号可能已从公共列表下架）`);
  process.exit(1);
}
const xml = await res.text();
const dates = [...xml.matchAll(/<pubDate>([^<]+)<\/pubDate>/gi)].map(m => Date.parse(m[1])).filter(Number.isFinite);
const n = (xml.match(/<item[\s>]/gi) || []).length;
const ageH = dates.length ? Math.round((Date.now() - Math.max(...dates)) / 3600000) : -1;
if (n === 0 || ageH < 0) {
  console.error('这个 feed 没有可用条目，放弃接入。');
  process.exit(1);
}
if (ageH > 24 * 30) console.log(`注意：最新一条是 ${Math.round(ageH / 24)} 天前，可能是停更号。`);

const name = '公众号 ' + target.name;
cfg.sources = cfg.sources.filter(s => s.name !== name);
cfg.sources.push({
  name, url: FEED(target.id), category, weight: 2.6, lang: 'zh',
  tier: 'core', authority: 3, cap: 6, type: 'wechat', via: 'wechat2rss'
});
fs.writeFileSync(CFG_PATH, JSON.stringify(cfg, null, 2) + '\n', 'utf8');

console.log(`已接入 ${name}`);
console.log(`  栏目 ${category} · ${n} 条 · 最新 ${ageH} 小时前`);
console.log('  下一步: node scripts/fetch.mjs');
