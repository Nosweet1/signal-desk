#!/usr/bin/env node
/**
 * 信号台 Signal Desk — 数据层
 * 零第三方依赖。抓取公开 RSS/Atom → 清洗 → 抽取式要点 → 合并同题 → 影响度排序 → 输出 data/feed.js
 * 用法: node scripts/fetch.mjs
 *
 * v2 变化：
 *  - 每条信号生成 brief（抽取式要点，中文优先、跨源融合）与 facts（关键数字），不再硬截 description
 *  - 输出 digest 速览与 allItems 全集，页面不必跳原文就能读完
 *  - authority（信源权威级别）参与评分；歧义词需领域语境才计分，无信号消息自然沉底
 *  - 信源扩到 80+ 后改成分批并发，并为高产量 feed 设置 cap 配额
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CFG = JSON.parse(fs.readFileSync(path.join(ROOT, 'sources.json'), 'utf8'));
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36';
const FETCH_TIMEOUT = 15000;
const MAX_PER_FEED = 40;
const FETCH_BATCH = 12;
const CLUSTER_THRESHOLD = 0.34;
const CLUSTER_WINDOW_MS = 48 * 3600 * 1000;
const BRIEF_MAX = 190;
const ALL_ITEMS_LIMIT = CFG.allItemsLimit || 60;

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
  const blocks = [...xml.matchAll(/<(item|entry)[\s>][\s\S]*?<\/\1>/gi)].slice(0, src.cap || MAX_PER_FEED).map(m => m[0]);
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
    const description = plain(rawDesc).slice(0, 1200);
    out.push({
      title, link, ts, description,
      summary: description.slice(0, 220),
      source: src.name, category: src.category, weight: src.weight, lang: src.lang,
      authority: src.authority || 3, tier: src.tier || 'core'
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

/* ---------------- 抽取式要点 ---------------- */
const BOILER = /^(read more|continue reading|sign up|subscribe|advertisement|follow us|share this|originally published|this article|the post|点击|阅读原文|查看全文|订阅|来源|图片|版权|转载|免责声明|扫码|编辑|责编|©)/i;
const ACTION = /(宣布|发布|批准|通过|证实|发现|首次|将|计划|预计|警告|下调|上调|禁止|生效|签署|达成|报告|研究|显示|表明|导致|要求|承诺|投入|突破|announced|found|first|will|said|report|study|warns|approved|banned|plans|expects|revealed|launched)/i;
const NUMUNIT = /\d[\d,.]*\s*(?:%|％|个百分点|基点|bp|倍|亿|万|万亿|吨|摄氏度|℃|度|GW|MW|TW|km|kg|公斤|美元|欧元|元|人民币|人|年|月|日|国|家)/g;
// 歧义词：只有同时出现领域语境时才算信号，避免「消费持续升温」被当成气候变暖
const TERM_GUARD = {
  '升温': /(气候|气温|全球|变暖|海平面|冰川|温室|排放|℃|度|warming|climate|emissions|sea level)/i
};

function sentences(s) {
  return String(s || '')
    .replace(/\s+/g, ' ')
    .split(/(?<=[。！？!?；;])/)
    // 去掉「中新网长春11月5日电 (记者 郭佳)」这类电头套话，保留后面的正文
    .map(x => x.trim().replace(/^[\p{L}\p{N}]{2,12}\d{1,2}月\d{1,2}日电\s*(\([^)]{0,40}\))?\s*/u, ''))
    .filter(x => x.length >= 12 && x.length <= 260 && !BOILER.test(x));
}
function softCut(s, max) {
  s = String(s).trim();
  if (s.length <= max) return s;
  const head = s.slice(0, max);
  const cut = Math.max(head.lastIndexOf('，'), head.lastIndexOf('、'), head.lastIndexOf(';'), head.lastIndexOf(','), head.lastIndexOf(' '));
  return (cut > max * 0.6 ? head.slice(0, cut) : head) + '…';
}
function charGrams(s) {
  const t = String(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  const g = new Set();
  for (let i = 0; i < t.length - 1; i++) g.add(t.slice(i, i + 2));
  return g;
}
function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let n = 0;
  for (const x of a) if (b.has(x)) n++;
  return n / (a.size + b.size - n);
}
function sentenceScore(s, titleWords) {
  let sc = 0;
  const nums = (s.match(/\d/g) || []).length;
  sc += Math.min(2.4, nums * 0.3);
  if (/\d[\d,.]*\s*(?:%|％|个百分点|倍|亿|万)/.test(s)) sc += 1.4;
  if (ACTION.test(s)) sc += 1.2;
  if (/(据|根据|表示|称|消息|人士|机构|组织|委员会|部|署|局|院)/.test(s)) sc += 0.35;
  if (/\d{1,2}月\d{1,2}日电/.test(s.slice(0, 24))) sc -= 1.5;  // 电头未清理干净时再降一档
  let overlap = 0;
  for (const w of titleWords) if (s.includes(w)) overlap++;
  sc -= Math.min(2, overlap * 0.22);   // 避免选中完全复述标题的句子
  if (s.length < 30) sc -= 0.8;
  if (s.length > 170) sc -= 0.5;
  return sc;
}
function makeBrief(members, rep) {
  // 中文描述优先；其次权威级别高、权重高的成员
  const ordered = [...members].sort((a, b) =>
    (b.lang === 'zh' ? 1 : 0) - (a.lang === 'zh' ? 1 : 0)
    || (b.authority || 3) - (a.authority || 3)
    || b.weight - a.weight || b.ts - a.ts);
  const pool = [];
  const seenText = new Set();
  for (const m of ordered) {
    for (const s of sentences(m.description)) {
      if (seenText.has(s)) continue;
      seenText.add(s);
      pool.push({ text: s, lang: m.lang, source: m.source, order: pool.length });
    }
  }
  // 兜底一：句子级抽取全被过滤时，直接取描述正文
  if (!pool.length) {
    for (const m of ordered) {
      const d = String(m.description || '').trim();
      if (d.length >= 12) {
        pool.push({ text: softCut(d, BRIEF_MAX), lang: m.lang, source: m.source, order: 0 });
        break;
      }
    }
  }
  const titleWords = (rep.title.match(/[\p{L}\p{N}]{2,}/gu) || []).slice(0, 12);
  for (const p of pool) p.score = sentenceScore(p.text, titleWords) + (p.lang === 'zh' ? 0.6 : 0);
  pool.sort((a, b) => b.score - a.score);

  const chosen = [];
  const grams = [];
  let len = 0;
  for (const p of pool) {
    if (chosen.length >= 2 || len >= BRIEF_MAX) break;
    if (len + p.text.length > BRIEF_MAX + 40) continue;
    const g = charGrams(p.text);
    if (grams.some(x => jaccard(x, g) > 0.7)) continue;
    chosen.push(p); grams.push(g); len += p.text.length;
  }
  // 兜底二：确实没有任何描述时，用跨源信息给一条可读说明，而不是留白
  if (!chosen.length) {
    const n = new Set(members.map(m => m.source)).size;
    return {
      brief: n > 1
        ? `该事件由 ${n} 家媒体同时报道，各源未提供摘要，点标题看原文。`
        : '该信源未提供摘要，点标题看原文。',
      lang: 'zh', fallback: true
    };
  }
  chosen.sort((a, b) => a.order - b.order);   // 按原文顺序输出，别按打分顺序
  let out = '';
  for (const p of chosen) {
    const cand = out ? out + ' ' + p.text : p.text;
    if (cand.length > BRIEF_MAX) { if (!out) out = softCut(p.text, BRIEF_MAX); break; }
    out = cand;
  }
  return { brief: out, lang: chosen[0].lang, fallback: false };
}
function extractFacts(members, limit = 3) {
  const found = new Map();
  for (const m of members) {
    for (const hit of (m.description || '').slice(0, 500).matchAll(NUMUNIT)) {
      const k = hit[0].replace(/\s/g, '');
      if (k.length > 24) continue;
      found.set(k, (found.get(k) || 0) + 1);
    }
  }
  return [...found.entries()]
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .slice(0, limit).map(x => x[0]);
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

  // 代表条目：优先中文，其次权威级别 / 权重
  const rep = [...members].sort((a, b) =>
    (b.lang === 'zh' ? 1 : 0) - (a.lang === 'zh' ? 1 : 0)
    || (b.authority || 3) - (a.authority || 3)
    || b.weight - a.weight || b.ts - a.ts
  )[0];

  // 短英文词按词边界匹配，否则 "war" 会误命中 warming、"ban" 会误命中 band
  const hasTerm = (hay, term) => {
    const t = term.toLowerCase();
    if (/^[a-z0-9]{1,4}$/.test(t)) return new RegExp('\\b' + t + '\\b', 'i').test(hay);
    return hay.includes(t);
  };
  const guarded = (t, hay) => hasTerm(hay, t) && (!TERM_GUARD[t] || TERM_GUARD[t].test(hay));
  // high / noise 只认标题；medium 才允许摘要作弱证据
  const titleHay = members.map(m => m.title).join(' ').toLowerCase();
  const bodyHay = members.map(m => m.description.slice(0, 90)).join(' ').toLowerCase();
  let keywordScore = 0;
  const tags = [];
  for (const [level, rule] of Object.entries(CFG.signals)) {
    const hitsT = rule.terms.filter(t => guarded(t, titleHay));
    const hitsB = level === 'medium'
      ? rule.terms.filter(t => !hitsT.includes(t) && guarded(t, bodyHay)) : [];
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
  const langBoost = rep.lang === 'zh' ? 0.6 : 0;
  const authorityBoost = Math.max(0, (rep.authority || 3) - 3) * (CFG.authorityBoost || 0.7);
  const noSignalPenalty = keywordScore <= 0 ? -0.8 : 0;  // 与栏目主旨无关的消息自然沉底
  const score = (rep.weight + authorityBoost + keywordScore + crossBoost + langBoost + noSignalPenalty)
    * (0.45 + 0.55 * freshness);

  const brief = makeBrief(members, rep);
  return {
    id: Buffer.from(rep.title).toString('base64url').slice(0, 12),
    title: rep.title,
    url: rep.link,
    summary: brief.brief,
    brief: brief.brief,
    briefLang: brief.lang,
    briefFallback: brief.fallback,
    facts: extractFacts(members),
    category: rep.category,
    publishedAt: new Date(rep.ts).toISOString(),
    source: rep.source,
    sources: [...bySource.keys()].slice(0, 6),
    clusterSize: sourceCount,
    authority: rep.authority || 3,
    tags: tags.slice(0, 3),
    score: Math.round(score * 100) / 100
  };
}

/* ---------------- 主流程 ---------------- */
const now = Date.now();
// 分批并发：80+ 源同时请求容易触发对方限流或本地连接耗尽
const results = [];
for (let i = 0; i < CFG.sources.length; i += FETCH_BATCH) {
  results.push(...await Promise.all(CFG.sources.slice(i, i + FETCH_BATCH).map(fetchSource)));
}
const health = results.map(r => ({
  name: r.src.name,
  category: r.src.category,
  tier: r.src.tier || 'core',
  authority: r.src.authority || 3,
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

// 速览：一眼看完本轮最重要的几条，不必逐张卡片读
const tagCount = new Map();
for (const it of picked) for (const t of it.tags) tagCount.set(t, (tagCount.get(t) || 0) + 1);
const topTag = [...tagCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '';
const crossCount = picked.filter(x => x.clusterSize > 1).length;
const digest = {
  summaryLine: `扫描 ${raw.length} 条 · 合并 ${clusters.length} 个事件`
    + (crossCount ? ` · ${crossCount} 条被多家同时报道` : '')
    + (topTag ? ` · 「${topTag}」最集中` : ''),
  points: picked.slice(0, CFG.digestCount || 5).map(x => ({
    id: x.id, title: x.title, brief: x.brief, briefLang: x.briefLang,
    category: x.category, source: x.source, url: x.url, clusterSize: x.clusterSize
  }))
};

const payload = {
  version: 2,
  generatedAt: new Date().toISOString(),
  name: CFG.name,
  motto: CFG.motto,
  stats: {
    sourcesTotal: CFG.sources.length,
    sourcesOk: health.filter(h => h.ok).length,
    authorityTotal: health.filter(h => h.authority >= 5).length,
    authorityOk: health.filter(h => h.ok && h.authority >= 5).length,
    rawItems: raw.length,
    clusters: clusters.length,
    shown: picked.length,
    allItems: Math.min(ALL_ITEMS_LIMIT, scored.length)
  },
  categories: CFG.categories,
  health: health.sort((a, b) => (a.ok ? 0 : 1) - (b.ok ? 0 : 1) || a.name.localeCompare(b.name)),
  digest,
  items: picked,
  allItems: scored.slice(0, ALL_ITEMS_LIMIT),
  view: { maxItems: CFG.maxItems, maxPerCategory: CFG.maxPerCategory, maxPerSource: CFG.maxPerSource }
};

const outFile = path.join(ROOT, 'data', 'feed.js');
fs.writeFileSync(outFile, 'window.SIGNAL_DATA = ' + JSON.stringify(payload, null, 2) + ';\n', 'utf8');

const ok = health.filter(h => h.ok);
const briefEmpty = payload.allItems.filter(x => !x.brief).length;
console.log(`信源 ${ok.length}/${health.length} 可用（权威级 ${payload.stats.authorityOk}/${payload.stats.authorityTotal}） | 原始 ${raw.length} 条 | 合并为 ${clusters.length} 个事件 | 展示 ${picked.length} 条 / 全集 ${payload.allItems.length} 条 | 空摘要 ${briefEmpty}`);
console.log('失败源: ' + (health.filter(h => !h.ok).map(h => `${h.name}(${h.error})`).join(', ') || '无'));
console.log('--- TOP 5 ---');
for (const it of picked.slice(0, 5)) {
  console.log(`  [${it.category}] ${String(it.score).padStart(5)} ×${it.clusterSize} ${it.title.slice(0, 56)}`);
  console.log(`      ${it.brief.slice(0, 90)}`);
}
console.log('输出: ' + outFile);
