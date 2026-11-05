#!/usr/bin/env node
/**
 * 信号台 · 每日报
 *
 * 从当天抓取结果里挑出真正重要的几条，给出「为什么重要 / 会有什么影响 / 后面盯什么」。
 * 有免费大模型就用模型写判断，没有就退回规则模板——**没有 Key 也能出报**。
 *
 * 可用的大模型（按优先级自动选，全部有免费额度）：
 *   1. LLM_BASE_URL + LLM_API_KEY + LLM_MODEL   任意 OpenAI 兼容接口
 *      （SiliconFlow / DeepSeek / 智谱 / Groq / OpenRouter / 通义 都行）
 *   2. GEMINI_API_KEY                           Google Gemini 免费层
 *   3. GITHUB_TOKEN                             GitHub Models，Actions 里自带，零配置
 *   4. 都没有 → 规则模板
 *
 * 用法:
 *   node scripts/daily.mjs                 生成今天的日报（可能调用模型）
 *   node scripts/daily.mjs --rules         强制用规则，不调模型
 *   node scripts/daily.mjs --reuse-latest  不调模型，用最近一期存档重写 data/daily.js
 *   node scripts/daily.mjs --date 2026-11-05
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const has = f => args.includes(f);
const argVal = f => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : ''; };

const FEED = path.join(ROOT, 'data', 'feed.js');
const DAILY_DIR = path.join(ROOT, 'data', 'daily');
const DAILY_OUT = path.join(ROOT, 'data', 'daily.js');
const PICK = 6;          // 日报正条数
const WATCH = 3;         // 「后面盯什么」条数

/* ---------------- 读数据 ---------------- */
function readFeed() {
  if (!fs.existsSync(FEED)) throw new Error('缺少 data/feed.js，先跑 node scripts/fetch.mjs');
  const raw = fs.readFileSync(FEED, 'utf8').replace(/^window\.SIGNAL_DATA\s*=\s*/, '').replace(/;\s*$/, '');
  return JSON.parse(raw);
}

function loadArchive(date) {
  const p = path.join(DAILY_DIR, `${date}.json`);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

const feed = readFeed();
const today = argVal('--date') || new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10); // 按北京时间算「今天」

/* ---------------- 候选池：跨栏目抽样，别让一个栏目占满 ---------------- */
const byId = new Map();
for (const it of [...(feed.items || []), ...(feed.allItems || [])]) if (!byId.has(it.id)) byId.set(it.id, it);
const pool = [...byId.values()].sort((a, b) => b.score - a.score);

function diversify(list, n, perCat = 2) {
  const out = [], used = new Set(), cnt = {};
  for (const it of list) {
    if (out.length >= n) break;
    if (used.has(it.id)) continue;
    if ((cnt[it.category] || 0) >= perCat) continue;
    out.push(it); used.add(it.id); cnt[it.category] = (cnt[it.category] || 0) + 1;
  }
  for (const it of list) { if (out.length >= n) break; if (!used.has(it.id)) { out.push(it); used.add(it.id); } }
  return out;
}

const candidates = diversify(pool, 10, 3);   // 给模型看的候选，控制在 10 条以内省 token
const watchPool = pool.filter(x => !candidates.some(c => c.id === x.id));

/* ---------------- 规则兜底：没有模型也能读得下去 ---------------- */
const CAT_IMPACT = {
  frontier: '技术路线与产业格局：谁先落地，谁就拿到下一轮定价权',
  survival: '公共健康与资源约束：影响的是成本曲线和监管强度',
  order: '政策与监管口径：合规边界变了，商业模型跟着变',
  economy: '资本与就业：资金流向和用工需求会先动'
};
const HORIZON = { frontier: '中期', survival: '长期', order: '短期', economy: '短期' };

function ruleWhy(it) {
  const bits = [];
  if (it.score >= 7) bits.push('本轮影响度最高的一档');
  else if (it.score >= 5.5) bits.push('影响度靠前');
  if ((it.clusterSize || 1) > 1) bits.push(`${it.clusterSize} 家媒体同时报道`);
  if (it.tags?.length) bits.push(`命中「${it.tags.slice(0, 2).join('、')}」`);
  if ((it.authority || 3) >= 5) bits.push('来源权威');
  return (bits.join('，') || '与栏目主旨直接相关') + '。';
}

function ruleImpact(it) {
  const out = [CAT_IMPACT[it.category] || '需要持续观察'];
  if (it.facts?.length) out.push(`量化信号：${it.facts.slice(0, 2).join('、')}`);
  if ((it.authority || 3) >= 5) out.push('一手来源，可信度高，可直接引用');
  return out.slice(0, 2);
}

function buildByRules() {
  const picks = diversify(candidates, PICK, 2);
  const tags = [...new Set(picks.flatMap(p => p.tags || []))].slice(0, 3);
  return {
    headline: tags.length
      ? `主线：${tags.join(' / ')}｜首条「${clip(picks[0]?.title || '', 24)}」`
      : (clip(picks[0]?.title || '', 40) || `本轮扫描 ${feed.stats?.rawItems || 0} 条`),
    items: picks.map(it => ({
      id: it.id, title: it.title, url: it.url, source: it.source, category: it.category,
      score: it.score, brief: it.brief,
      why: ruleWhy(it),
      impact: ruleImpact(it),
      horizon: HORIZON[it.category] || '中期'
    })),
    watch: watchPool.slice(0, WATCH).map(it => ({ title: it.title, source: it.source, url: it.url })),
    engine: 'rules'
  };
}

/* ---------------- 大模型：一次调用，严格 JSON ---------------- */
function pickProvider() {
  const base = process.env.LLM_BASE_URL, key = process.env.LLM_API_KEY, model = process.env.LLM_MODEL;
  if (base && key && model && !has('--rules')) {
    return {
      name: `openai:${model}`,
      call: prompt => openaiCompatible({ base, key, model, prompt })
    };
  }
  if (process.env.GEMINI_API_KEY && !has('--rules')) {
    return { name: 'gemini:' + (process.env.GEMINI_MODEL || 'gemini-2.0-flash'), call: prompt => gemini(prompt) };
  }
  if (process.env.GITHUB_TOKEN && !has('--rules')) {
    const model = process.env.DAILY_MODEL || 'openai/gpt-4o-mini';
    return { name: `github:${model}`, call: prompt => openaiCompatible({ base: 'https://models.github.ai/inference', key: process.env.GITHUB_TOKEN, model, prompt }) };
  }
  return null;
}

async function openaiCompatible({ base, key, model, prompt }) {
  const res = await fetch(base.replace(/\/$/, '') + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
    body: JSON.stringify({
      model,
      temperature: 0.3,
      max_tokens: 1600,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: prompt }
      ]
    })
  });
  if (!res.ok) throw new Error('LLM HTTP ' + res.status + ' ' + (await res.text()).slice(0, 200));
  const j = await res.json();
  return j.choices?.[0]?.message?.content || '';
}

async function gemini(prompt) {
  const model = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.3, maxOutputTokens: 1600, responseMimeType: 'application/json' }
    })
  });
  if (!res.ok) throw new Error('Gemini HTTP ' + res.status + ' ' + (await res.text()).slice(0, 200));
  const j = await res.json();
  return j.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '';
}

const SYSTEM_PROMPT = `你是情报分析师，为一位关注技术、宏观与风险的专业读者写每日要报。
规则：
1. 只能使用我给出的候选条目，禁止引入外部事实、禁止编造数字与机构名。
2. 判断要具体、可验证，不要写"意义重大""影响深远"这类空话。
3. impact 每条不超过 40 字，写清楚"谁的什么会被改变"。
4. 语气克制，不确定就说不确定，不要下结论式断言。
5. 只输出 JSON，不要 markdown 代码块，不要解释。`;

function userPrompt() {
  const lines = candidates.map((it, i) => {
    const brief = (it.brief || '').replace(/\s+/g, ' ').slice(0, 150);
    return `${i + 1}. [${it.category}] ${it.title}\n   来源：${it.source}｜影响度：${it.score}｜标签：${(it.tags || []).join('/') || '无'}\n   摘要：${brief}`;
  });
  return `今天要写的日报候选（共 ${candidates.length} 条，只能从中选，用编号引用）：

${lines.join('\n\n')}

请输出 JSON：
{
  "headline": "一句话概括今天最值得知道的事（不超过 30 字）",
  "items": [
    { "index": 1, "why": "为什么重要（不超过 40 字，必须基于上面给的标题/摘要）",
      "impact": ["会改变什么（不超过 40 字）", "次级影响（不超过 40 字）"],
      "horizon": "短期|中期|长期",
      "confidence": "high|medium|low" }
  ],
  "watch": ["接下来 1-2 周要盯的具体信号 1", "信号 2", "信号 3"]
}
要求：items 选 4-${PICK} 条，覆盖不同栏目；watch 3 条，必须是从候选里的趋势延伸出来的可观察指标，不要重复条目内容。`;
}

function extractJson(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf('{'), end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(body.slice(start, end + 1)); } catch { return null; }
}

function clip(s, n) {
  s = String(s || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function mergeLLM(parsed, engineName) {
  const base = buildByRules();
  if (!parsed || !Array.isArray(parsed.items) || !parsed.items.length) return base;

  const items = [];
  for (const raw of parsed.items) {
    const idx = Number(raw.index) - 1;
    const it = candidates[idx];
    if (!it) continue;                                   // 编号越界：丢弃，不让模型塞外部新闻
    if (items.some(x => x.id === it.id)) continue;
    const impact = Array.isArray(raw.impact) ? raw.impact.filter(Boolean).slice(0, 3).map(x => clip(x, 46)) : [];
    items.push({
      id: it.id, title: it.title, url: it.url, source: it.source, category: it.category,
      score: it.score, brief: it.brief,
      why: clip(raw.why, 60) || ruleWhy(it),
      impact: impact.length ? impact : ruleImpact(it),
      horizon: ['短期', '中期', '长期'].includes(raw.horizon) ? raw.horizon : (HORIZON[it.category] || '中期'),
      confidence: ['high', 'medium', 'low'].includes(raw.confidence) ? raw.confidence : 'medium'
    });
  }
  if (items.length < 3) return base;                     // 模型没给出足够可用条目就整篇回退

  const watch = Array.isArray(parsed.watch)
    ? parsed.watch.filter(Boolean).slice(0, WATCH).map(w => ({ text: clip(w, 60) }))
    : [];
  return {
    headline: clip(parsed.headline, 60) || base.headline,
    items,
    watch: watch.length ? watch : base.watch.map(w => ({ title: w.title, source: w.source, url: w.url })),
    engine: engineName
  };
}

/* ---------------- 输出 ---------------- */
function writeOut(brief) {
  const payload = {
    date: today,
    generatedAt: new Date().toISOString(),
    ...brief,
    stats: {
      scanned: feed.stats?.rawItems || 0,
      events: feed.stats?.clusters || 0,
      sources: `${feed.stats?.sourcesOk || 0}/${feed.stats?.sourcesTotal || 0}`,
      candidates: candidates.length
    }
  };
  fs.mkdirSync(DAILY_DIR, { recursive: true });
  fs.writeFileSync(path.join(DAILY_DIR, `${today}.json`), JSON.stringify(payload, null, 2) + '\n', 'utf8');
  fs.writeFileSync(DAILY_OUT, 'window.SIGNAL_DAILY = ' + JSON.stringify(payload, null, 2) + ';\n', 'utf8');
  // 归档索引：页面上的「往期」用它
  const files = fs.readdirSync(DAILY_DIR).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().reverse();
  const index = files.map(f => {
    const d = JSON.parse(fs.readFileSync(path.join(DAILY_DIR, f), 'utf8'));
    return { date: d.date, headline: d.headline, engine: d.engine };
  });
  fs.writeFileSync(path.join(DAILY_DIR, 'index.json'), JSON.stringify(index, null, 2) + '\n', 'utf8');
  return payload;
}

async function main() {
  if (has('--reuse-latest')) {
    const files = fs.existsSync(DAILY_DIR)
      ? fs.readdirSync(DAILY_DIR).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().reverse()
      : [];
    if (!files.length) { console.log('没有存档，改为现场生成（规则）'); const p = writeOut(buildByRules()); finish(p); return; }
    const latest = JSON.parse(fs.readFileSync(path.join(DAILY_DIR, files[0]), 'utf8'));
    fs.writeFileSync(DAILY_OUT, 'window.SIGNAL_DAILY = ' + JSON.stringify(latest, null, 2) + ';\n', 'utf8');
    console.log(`已用存档 ${latest.date} 复写 data/daily.js（未调用模型）`);
    return;
  }

  if (loadArchive(today) && !has('--force')) {
    console.log(`今天（${today}）的日报已存在，跳过生成。要重写加 --force。`);
    const archived = loadArchive(today);
    fs.writeFileSync(DAILY_OUT, 'window.SIGNAL_DAILY = ' + JSON.stringify(archived, null, 2) + ';\n', 'utf8');
    return;
  }

  const provider = pickProvider();
  let brief;
  if (provider) {
    try {
      const text = await provider.call(userPrompt());
      brief = mergeLLM(extractJson(text), provider.name);
      if (brief.engine === 'rules') console.log('模型返回不可用，已回退规则模板');
    } catch (e) {
      console.log('模型调用失败，回退规则模板：' + String(e.message).slice(0, 120));
      brief = buildByRules();
    }
  } else {
    brief = buildByRules();
  }
  finish(writeOut(brief));
}

function finish(payload) {
  console.log(`日报 ${payload.date}｜引擎 ${payload.engine}｜${payload.items.length} 条正选 / ${payload.watch.length} 条观察`);
  console.log('— ' + payload.headline);
  payload.items.forEach((it, i) => console.log(`  ${i + 1}. [${it.category}] ${it.title.slice(0, 46)}`));
  console.log('输出: data/daily.js 与 data/daily/' + payload.date + '.json');
}

await main();
