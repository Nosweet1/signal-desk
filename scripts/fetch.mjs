#!/usr/bin/env node
/**
 * 信号台 Signal Desk — 数据层
 * 零第三方依赖。抓取公开 RSS/Atom → 清洗 → 合并同题 → 影响度排序 → 输出 data/feed.js
 * 用法: node scripts/fetch.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CFG = JSON.parse(fs.readFileSync(path.join(ROOT, 'sources.json'), 'utf8'));
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36';
const FETCH_TIMEOUT = 15000;
const MAX_PER_FEED = 40;
const CLUSTER_THRESHOLD = 0.34;
const CLUSTER_WINDOW_MS = 48 * 3600 * 1000;

/* ---------------- XML 清洗 ---------------- */
function decode(s = '') {
  return String(s)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"').replace(/&apos;|&#39;|&#x27;/gi, "'")
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&mdash;|&#8212;/gi, '—').replace(/&hellip;|&#8230;/gi, '…')
    .replace(/&#(\d+);/g, (_, d) => { try { return String.fromCodePoint(+d); } catch { return ' '; } })
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch { return ' '; } })
    .replace(/&amp;/gi, '&');
}
function text(block, name) {
  const re = new RegExp('<' + name + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + name + '>', 'i');
  const m = block.match(re);
  return m ? decode(m[1]).trim() : '';
}
function atomLink(block) {
  const links = [...block.matchAll(/<link\b([^>]*)\/?>/gi)];
  const pick = links.find(m => /rel\s*=\s*["']alternate["']/i.test(m[1]))
    || links.find(m => !/rel\s*=/i.test(m[1])) || links[0];
  if (!pick) return '';
  const h = pick[1].match(/href\s*=\s*["']([^"']+)["']/i);
  return h ? decode(h[1]).trim() : '';
}
function plain(s) {
  return decode(s)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

/* ---------------- 抓取与解析 ---------------- */
function parseFeed(xml, src) {
  const blocks = [...xml.matchAll(/<(item|entry)[\s>][\s\S]*?<\/\1>/gi)].slice(0, MAX_PER_FEED).map(m => m[0]);
  const out = [];
  for (const b of blocks) {
    const title = plain(text(b, 'title'));
    if (!title) continue;
    let link = text(b, 'link') || atomLink(b);
    if (link && link.startsWith('//')) link = 'https:' + link;
    if (!/^https?:\/\//i.test(link)) link = '';
    const dateStr = text(b, 'pubDate') || text(b, 'published') || text(b, 'updated')
      || text(b, 'dc:date') || text(b, 'date') || '';
    let ts = Date.parse(dateStr);
    // 没有可信发布时间的条目一律丢弃：否则停止更新的存档 feed 会被当成实时新闻顶到榜首
    if (!Number.isFinite(ts)) continue;
    const rawDesc = text(b, 'description') || text(b, 'summary') || text(b, 'content') || text(b, 'content:encoded') || '';
    const summary = plain(rawDesc).slice(0, 220);
    out.push({
      title, link, ts, summary,
      source: src.name, category: src.category, weight: src.weight, lang: src.lang
    });
  }
  return out;
}

async function fetchSource(src) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT);
  try {
    const res = await fetch(src.url, {
      signal: ctl.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': UA,
        'Accept': 'application/rss+xml,application/atom+xml,application/xml,text/xml,*/*'
      }
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const xml = await res.text();
    clearTimeout(timer);
    if (!/<\?xml|<rss[\s>]|<feed[\s>]|<rdf:RDF/i.test(xml.slice(0, 800))) {
      throw new Error('非 RSS 内容');
    }
    const items = parseFeed(xml, src);
    return { src, items, error: items.length ? '' : '0 条目（多为缺日期）' };
  } catch (e) {
    clearTimeout(timer);
    return { src, items: [], error: String(e.cause?.code || e.message || e).slice(0, 50) };
  }
}

/* ---------------- 合并同题 ---------------- */
function normTitle(t) {
  return t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}
function grams(t) {
  const n = normTitle(t);
  const compact = n.replace(/\s/g, '');
  const ascii = (compact.match(/[a-z0-9]/g) || []).length / Math.max(1, compact.length);
  const parts = ascii > 0.75
    ? n.split(/\s+/).filter(w => w.length > 1)
    : compact.split('');
  const g = new Set();
  for (let i = 0; i < parts.length - 1; i++) g.add(parts[i] + '\u0001' + parts[i + 1]);
  if (parts.length === 1) g.add(parts[0]);
  return g;
}
function similarity(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/* ---------------- 影响度评分 ---------------- */
function evaluate(cluster, now) {
  const members = cluster.members;
  const bySource = new Map();
  for (const m of members) if (!bySource.has(m.source)) bySource.set(m.source, m);
  const sourceCount = bySource.size;

  // 代表条目：优先中文，其次权重高
  const rep = [...members].sort((a, b) =>
    (b.lang === 'zh' ? 1 : 0) - (a.lang === 'zh' ? 1 : 0) || b.weight - a.weight || b.ts - a.ts
  )[0];

  // 短英文词按词边界匹配，否则 "war" 会误命中 warming、"ban" 会误命中 band
  const hasTerm = (hay, term) => {
    const t = term.toLowerCase();
    if (/^[a-z0-9]{1,4}$/.test(t)) return new RegExp('\\b' + t + '\\b', 'i').test(hay);
    return hay.includes(t);
  };
  // high / noise 只认标题；medium 才允许摘要作弱证据，
  // 否则天体物理稿里的 "nuclear" 会把纯科普顶成大事件
  const titleHay = members.map(m => m.title).join(' ').toLowerCase();
  const bodyHay = members.map(m => m.summary.slice(0, 90)).join(' ').toLowerCase();
  let keywordScore = 0;
  const tags = [];
  for (const [level, rule] of Object.entries(CFG.signals)) {
    const hitsT = rule.terms.filter(t => hasTerm(titleHay, t));
    const hitsB = level === 'medium'
      ? rule.terms.filter(t => !hitsT.includes(t) && hasTerm(bodyHay, t)) : [];
    const eff = hitsT.length + hitsB.length * 0.25;
    if (!eff) continue;
    keywordScore += level === 'noise'
      ? rule.score
      : rule.score * Math.min(1.6, 1 + (eff - 1) * 0.15);
    if (level !== 'noise') for (const h of hitsT.slice(0, 2)) if (!tags.includes(h)) tags.push(h);
  }

  const ageHours = Math.max(0, (now - rep.ts) / 3600000);
  const freshness = Math.exp(-ageHours / CFG.halfLifeHours);
  const crossBoost = Math.min(3.2, (sourceCount - 1) * 1.3);
  const langBoost = rep.lang === 'zh' ? 0.6 : 0; // 同分时中文优先
  const score = (rep.weight + keywordScore + crossBoost + langBoost) * (0.45 + 0.55 * freshness);

  return {
    id: Buffer.from(rep.title).toString('base64url').slice(0, 12),
    title: rep.title,
    url: rep.link,
    summary: rep.summary,
    category: rep.category,
    publishedAt: new Date(rep.ts).toISOString(),
    source: rep.source,
    sources: [...bySource.keys()].slice(0, 6),
    clusterSize: sourceCount,
    tags: tags.slice(0, 3),
    score: Math.round(score * 100) / 100
  };
}

/* ---------------- 主流程 ---------------- */
const now = Date.now();
const results = await Promise.all(CFG.sources.map(fetchSource));
const health = results.map(r => ({
  name: r.src.name,
  category: r.src.category,
  tier: r.src.tier,
  ok: r.items.length > 0,
  count: r.items.length,
  error: r.error
}));

let raw = results.flatMap(r => r.items);
const hardAge = CFG.maxAgeHours * 2; // 兜底：极慢更新的源最多放宽到 6 天
raw = raw.filter(x => (now - x.ts) < hardAge * 3600000 && x.ts <= now + 3600000);

// 去重（同一 URL / 同一标题）
const seen = new Set();
raw = raw.filter(x => {
  const k = x.link || x.title;
  if (seen.has(k)) return false;
  seen.add(k);
  return true;
});

// 聚类：按时间倒序，同 48 小时窗口内标题相似即视为同一事件
raw.sort((a, b) => b.ts - a.ts);
const clusters = [];
for (const it of raw) {
  const g = grams(it.title);
  let placed = false;
  for (const c of clusters) {
    if (Math.abs(c.ts - it.ts) > CLUSTER_WINDOW_MS) continue;
    if (similarity(c.grams, g) >= CLUSTER_THRESHOLD) {
      c.members.push(it); placed = true; break;
    }
  }
  if (!placed) clusters.push({ grams: g, ts: it.ts, members: [it] });
}

const scored = clusters.map(c => evaluate(c, now)).sort((a, b) => b.score - a.score);

// 选取：① 每个栏目保底 1 条 ② 按分数补齐，守分类/同源配额 ③ 仍不足则放宽
const picked = [];
const used = new Set();
const perCat = {}, perSrc = {};
const take = it => {
  picked.push(it); used.add(it.id);
  perCat[it.category] = (perCat[it.category] || 0) + 1;
  perSrc[it.source] = (perSrc[it.source] || 0) + 1;
};
for (const c of CFG.categories) {
  const best = scored.find(x => x.category === c.id && !used.has(x.id));
  if (best && picked.length < CFG.maxItems) take(best);
}
for (const it of scored) {
  if (picked.length >= CFG.maxItems) break;
  if (used.has(it.id)) continue;
  if ((perCat[it.category] || 0) >= CFG.maxPerCategory) continue;
  if ((perSrc[it.source] || 0) >= (CFG.maxPerSource || 2)) continue;
  take(it);
}
for (const it of scored) {
  if (picked.length >= CFG.maxItems) break;
  if (!used.has(it.id)) take(it);
}
picked.sort((a, b) => b.score - a.score);

const payload = {
  version: 1,
  generatedAt: new Date().toISOString(),
  name: CFG.name,
  motto: CFG.motto,
  stats: {
    sourcesTotal: CFG.sources.length,
    sourcesOk: health.filter(h => h.ok).length,
    rawItems: raw.length,
    clusters: clusters.length,
    shown: picked.length
  },
  categories: CFG.categories,
  health: health.sort((a, b) => (a.ok ? 0 : 1) - (b.ok ? 0 : 1) || a.name.localeCompare(b.name)),
  items: picked
};

const outFile = path.join(ROOT, 'data', 'feed.js');
fs.writeFileSync(outFile, 'window.SIGNAL_DATA = ' + JSON.stringify(payload, null, 2) + ';\n', 'utf8');

const ok = health.filter(h => h.ok);
console.log(`信源 ${ok.length}/${health.length} 可用 | 原始 ${raw.length} 条 | 合并为 ${clusters.length} 个事件 | 展示 ${picked.length} 条`);
console.log('失败源: ' + (health.filter(h => !h.ok).map(h => `${h.name}(${h.error})`).join(', ') || '无'));
console.log('--- TOP 5 ---');
for (const it of picked.slice(0, 5)) {
  console.log(`  [${it.category}] ${String(it.score).padStart(5)} ×${it.clusterSize} ${it.title.slice(0, 56)}`);
}
console.log('输出: ' + outFile);
