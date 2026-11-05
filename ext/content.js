/**
 * 信号台划词 · 内容脚本
 * 选中英文 → 单词给音标+中文释义，句子给整句翻译。
 * 全部渲染在 Shadow DOM 里，不受宿主页面样式影响。
 */
(function () {
  if (window.__sdTransLoaded) return;
  window.__sdTransLoaded = true;
  if (window.top !== window && !document.body) return;

  const HOST_ID = '__sd-trans-host__';
  let host = document.getElementById(HOST_ID);
  if (host) host.remove();

  host = document.createElement('div');
  host.id = HOST_ID;
  host.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;';
  const shadow = host.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  style.textContent = `
    .box{
      position:fixed; max-width:320px; min-width:170px;
      background:#1b2130; color:#dbe1ec; border:1px solid #33405a;
      border-radius:10px; box-shadow:0 12px 34px rgba(0,0,0,.55);
      padding:10px 12px 11px; font:13px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;
      opacity:0; transform:translateY(4px); transition:opacity .13s,transform .13s;
      pointer-events:auto; box-sizing:border-box;
    }
    .box.on{opacity:1;transform:none}
    .hd{display:flex;align-items:baseline;gap:7px;flex-wrap:wrap}
    .w{font-size:15px;font-weight:650;letter-spacing:.01em;color:#eef2f8}
    .ph{font-size:11.5px;color:#e0af68;font-weight:400}
    .tools{margin-left:auto;display:flex;gap:5px}
    .btn{
      border:1px solid #2e3a50;background:transparent;color:#8b95a9;border-radius:5px;
      font:inherit;font-size:11px;line-height:1.4;padding:0 6px;cursor:pointer;
    }
    .btn:hover{color:#7aa2f7;border-color:#7aa2f7}
    .def{margin-top:6px;color:#a8b2c4;font-size:12.5px}
    .def+.def{margin-top:3px}
    .def i{font-style:normal;color:#7aa2f7;font-size:11px;margin-right:3px}
    .src{margin-top:7px;font-size:9.5px;color:#4d5768;letter-spacing:.03em}
    .ld{color:#8b95a9;font-size:12px}
    .err{color:#f7768e;font-size:12px}
    .sent{font-size:11.5px;color:#8b95a9;max-height:84px;overflow:auto}
    .dst{margin-top:7px;font-size:13.5px;color:#e6ebf3;line-height:1.62}
  `;
  shadow.appendChild(style);

  const box = document.createElement('div');
  box.className = 'box';
  shadow.appendChild(box);
  document.documentElement.appendChild(host);

  let hideTimer = null;
  let lastQuery = '';
  let lastRect = null;

  function hide() {
    box.classList.remove('on');
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => { box.style.display = 'none'; }, 160);
  }
  function show() {
    clearTimeout(hideTimer);
    box.style.display = 'block';
    requestAnimationFrame(() => box.classList.add('on'));
  }
  function place(rect) {
    lastRect = rect;
    const pad = 10;
    const bw = box.offsetWidth || 240;
    const bh = box.offsetHeight || 120;
    let left = rect.left + rect.width / 2 - bw / 2;
    left = Math.max(pad, Math.min(left, window.innerWidth - bw - pad));
    let top = rect.bottom + 10;
    if (top + bh > window.innerHeight - pad) {
      const alt = rect.top - bh - 10;
      if (alt > pad) top = alt;
      else top = Math.max(pad, window.innerHeight - bh - pad);
    }
    box.style.left = left + 'px';
    box.style.top = top + 'px';
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function speak(text) {
    try {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'en-US'; u.rate = 0.92;
      speechSynthesis.cancel(); speechSynthesis.speak(u);
    } catch (e) {}
  }

  function renderWord(d) {
    const ph = d.ph ? `<span class="ph">/${esc(d.ph)}/</span>` : '';
    const defs = (d.defs || []).map(x => {
      const m = String(x).match(/^([a-z]+\.)\s*(.+)$/i);
      return m ? `<div class="def"><i>${esc(m[1])}</i>${esc(m[2])}</div>` : `<div class="def">${esc(x)}</div>`;
    }).join('');
    box.innerHTML = `<div class="hd"><span class="w">${esc(d.word)}</span>${ph}
        <span class="tools"><button class="btn" data-act="say">🔊</button></span></div>
      ${defs}<div class="src">${esc(d.src || '')}</div>`;
  }
  function renderSentence(d) {
    box.innerHTML = `<div class="hd"><span class="w" style="font-size:12px;font-weight:500;color:#8b95a9">原文</span>
        <span class="tools">
          <button class="btn" data-act="say">🔊</button>
          <button class="btn" data-act="copy">复制</button>
        </span></div>
      <div class="sent">${esc(d.src)}</div>
      <div class="dst">${esc(d.dst)}</div>
      <div class="src">${esc(d.provider || 'MyMemory')} 机器翻译</div>`;
  }
  function renderLoading(q) {
    box.innerHTML = `<div class="ld">查询「${esc(q.length > 28 ? q.slice(0, 28) + '…' : q)}」…</div>`;
  }
  function renderError(msg) {
    box.innerHTML = `<div class="err">${esc(msg)}</div>`;
  }

  function ask(q, rect) {
    lastQuery = q;
    renderLoading(q);
    show();
    place(rect);
    chrome.runtime.sendMessage({ type: 'sd-lookup', q }, res => {
      if (chrome.runtime.lastError || !res) {
        renderError('扩展后台未响应，请重新加载扩展');
        place(rect);
        return;
      }
      if (res.error) {
        renderError(res.error);
      } else if (res.kind === 'sentence') {
        renderSentence(res);
      } else {
        renderWord(res);
      }
      place(rect);
    });
  }

  function pickText() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return null;
    const text = String(sel).replace(/\s+/g, ' ').trim();
    if (!text) return null;
    if (!/[A-Za-z]/.test(text)) return null;
    if (text.length > 300) return null;
    // 中文占比过高则不触发，避免干扰中文阅读
    const cn = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
    if (cn > text.length * 0.2) return null;
    const range = sel.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    if (!rect || (!rect.width && !rect.height)) return null;
    return { text, rect };
  }

  document.addEventListener('mouseup', e => {
    if (e.target === host) return;
    setTimeout(() => {
      const p = pickText();
      if (!p) return;
      // 单词至少 2 个字，句子至少 2 个词
      if (p.text.length < 2) return;
      ask(p.text.replace(/^[^A-Za-z]+|[^A-Za-z.!?'’]+$/, ''), p.rect);
    }, 10);
  });

  box.addEventListener('click', e => {
    const act = e.target && e.target.getAttribute && e.target.getAttribute('data-act');
    if (act === 'say') speak(lastQuery);
    if (act === 'copy') {
      const dst = box.querySelector('.dst');
      if (dst && navigator.clipboard) navigator.clipboard.writeText(dst.textContent).then(() => {
        const b = box.querySelector('[data-act="copy"]');
        if (b) { b.textContent = '已复制'; setTimeout(() => { b.textContent = '复制'; }, 1200); }
      }).catch(() => {});
    }
  });

  document.addEventListener('mousedown', e => {
    if (e.target !== host && !host.contains(e.target)) hide();
  }, true);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') hide(); }, true);
  window.addEventListener('scroll', hide, { passive: true });
  window.addEventListener('resize', hide, { passive: true });

  chrome.runtime.onMessage.addListener(msg => {
    if (msg && msg.type === 'sd-translate-again' && msg.q) {
      ask(String(msg.q).trim(), lastRect || { left: window.innerWidth / 2 - 60, top: 80, width: 120, height: 0, bottom: 80 });
    }
  });
})();
