/* ===========================================================================
 *  ui.js —— DOM 工具、发音、义项分级展示组件、提示条
 * =========================================================================== */

/* ------------------------------------------------------------------ DOM 工具 */

window.UI = (function () {
  'use strict';

  function el(tag, attrs, children) {
    const n = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        const v = attrs[k];
        if (v === null || v === undefined || v === false) return;
        if (k === 'class')      n.className = v;
        else if (k === 'text')  n.textContent = v;
        else if (k === 'html')  n.innerHTML = v;
        else if (k.slice(0, 2) === 'on') n.addEventListener(k.slice(2).toLowerCase(), v);
        else if (v === true)    n.setAttribute(k, '');
        else                    n.setAttribute(k, v);
      });
    }
    (children || []).forEach(function (c) {
      if (c === null || c === undefined || c === false) return;
      n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return n;
  }

  function $(sel, root)  { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function clear(node)   { while (node.firstChild) node.removeChild(node.firstChild); return node; }

  /* --------------------------------------------------------------- 提示条 */

  let toastHost = null;

  function toast(msg, kind, ms) {
    if (!toastHost) {
      toastHost = el('div', { class: 'toast-host', 'aria-live': 'polite' });
      document.body.appendChild(toastHost);
    }
    const t = el('div', { class: 'toast toast--' + (kind || 'info') }, [
      el('span', { class: 'toast-msg', text: msg })
    ]);
    toastHost.appendChild(t);
    // 强制回流后加类，触发进场动画
    void t.offsetWidth;
    t.classList.add('is-in');
    setTimeout(function () {
      t.classList.remove('is-in');
      setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 300);
    }, ms || 3200);
    return t;
  }

  /* --------------------------------------------------------- 确认对话框 */

  /** 返回 Promise<boolean>。用于导入覆盖、重置等破坏性操作。 */
  function confirmDialog(opts) {
    return new Promise(function (resolve) {
      const box = el('div', { class: 'dlg' }, [
        el('h3', { class: 'dlg-title', text: opts.title || '确认' }),
        typeof opts.body === 'string'
          ? el('div', { class: 'dlg-body', html: opts.body })
          : el('div', { class: 'dlg-body' }, [opts.body]),
        el('div', { class: 'dlg-actions' }, [
          el('button', {
            class: 'btn', text: opts.cancelText || '取消',
            onclick: function () { close(false); }
          }),
          el('button', {
            class: 'btn btn--danger', text: opts.okText || '确定',
            onclick: function () { close(true); }
          })
        ])
      ]);
      const mask = el('div', { class: 'dlg-mask' }, [box]);
      mask.addEventListener('click', function (e) { if (e.target === mask) close(false); });
      function onKey(e) { if (e.key === 'Escape') close(false); }
      document.addEventListener('keydown', onKey);
      function close(v) {
        document.removeEventListener('keydown', onKey);
        if (mask.parentNode) mask.parentNode.removeChild(mask);
        resolve(v);
      }
      document.body.appendChild(mask);
      const okBtn = box.querySelector('.btn--danger');
      if (okBtn) okBtn.focus();
    });
  }

  return { el: el, $: $, $$: $$, clear: clear, toast: toast, confirmDialog: confirmDialog };
})();

/* -------------------------------------------------------------------- 发音 */

window.Speak = (function () {
  'use strict';

  const synth = window.speechSynthesis;
  let voice = null;
  let accent = 'us';        // us | gb，可由设置页 setAccent 切换
  let queue = [];           // 待朗读文本块（长句已切分）
  let kickTimer = null;     // cancel 后延迟启动，绕开 iOS「cancel 后立即 speak 被吞」
  let guardTimer = null;    // 某些平台不触发 onend 时的兜底推进
  let curRate = 0.92;

  function normLang(v) { return (v.lang || '').replace('_', '-').toLowerCase(); }

  /* 选一个最可能真能出声的英文语音。
     不再迷信 localService：iPad/安卓上「本地语音包没下载」时，
     一个 localService 语音反而是哑的；这里按 口音→默认→自然音色 打分。 */
  function pick() {
    if (!synth) return null;
    const vs = synth.getVoices() || [];
    if (!vs.length) return null;
    const want = accent === 'gb' ? 'en-gb' : 'en-us';
    let pool = vs.filter(function (v) { return normLang(v).indexOf(want) === 0; });
    if (!pool.length) pool = vs.filter(function (v) { return normLang(v).indexOf('en') === 0; });
    // 没有任何英文语音时返回 null —— 绝不能退化绑定一个中文语音去念英文，
    // 那会变成中文腔乱读或直接静默；此时只给 utterance 设 lang=en-US 交给系统。
    if (!pool.length) return null;
    function score(v) {
      let s = 0;
      if (v.default) s += 4;
      if (/google|natural|samantha|alex|daniel|serena|online/i.test(v.name || '')) s += 2;
      // 本地语音只加很弱的分：能用但不优先于质量更好的默认/在线音
      if (v.localService) s += 1;
      return s;
    }
    return pool.slice().sort(function (a, b) { return score(b) - score(a); })[0] || null;
  }

  function refresh() { voice = pick(); }

  function init() {
    if (!synth) return;
    refresh();
    // Chrome/Edge 的 voice 列表异步加载，首次同步调用常为空，监听变化后重选
    if (typeof synth.addEventListener === 'function') {
      synth.addEventListener('voiceschanged', refresh);
    } else {
      synth.onvoiceschanged = refresh;
    }
    // iOS 必须在一次用户手势里「解锁」过语音引擎，之后自动朗读才会出声。
    // 首个点击/触摸时播一条几乎为空的 utterance 完成解锁，随后立即移除监听。
    let unlocked = false;
    function unlock() {
      if (unlocked) return;
      unlocked = true;
      try {
        const u = new SpeechSynthesisUtterance(' ');
        u.volume = 0;
        synth.speak(u);
      } catch (e) {}
    }
    ['pointerdown', 'touchend', 'click'].forEach(function (ev) {
      document.addEventListener(ev, unlock, { once: true, passive: true });
    });
  }

  function setAccent(a) { accent = (a === 'gb' ? 'gb' : 'us'); refresh(); }

  function available() { return !!synth; }
  function hasVoice() { return !!voice; }

  /* 长句切短：单词/短语整块读；超过 14 词的句子按标点切成小块队列，
     规避 iOS SpeechSynthesis 读长句中途静默/截断的问题。 */
  function splitText(text) {
    const s = String(text).trim();
    if (s.split(/\s+/).length <= 14) return [s];
    const parts = s.match(/[^.!?;。；！？]+[.!?;。；！？]?/g) || [s];
    const out = [];
    let buf = '';
    parts.forEach(function (p) {
      p = p.trim();
      if (!p) return;
      if ((buf + ' ' + p).trim().split(/\s+/).length > 14) {
        if (buf) out.push(buf.trim());
        buf = p;
      } else {
        buf = buf ? buf + ' ' + p : p;
      }
    });
    if (buf) out.push(buf.trim());
    return out;
  }

  function clearGuard() { if (guardTimer) { clearTimeout(guardTimer); guardTimer = null; } }

  function playNext() {
    if (!synth) return;
    if (!queue.length) { clearGuard(); return; }
    const text = queue.shift();
    let done = false;
    function advance() {
      if (done) return;
      done = true;
      clearGuard();
      setTimeout(playNext, 60);     // 块间小间隔，听感是连贯的一句话
    }
    let u;
    try {
      u = new SpeechSynthesisUtterance(text);
    } catch (e) { advance(); return; }
    if (!voice) refresh();
    if (voice) { u.voice = voice; u.lang = voice.lang; }
    else u.lang = accent === 'gb' ? 'en-GB' : 'en-US';
    u.rate = curRate; u.pitch = 1; u.volume = 1;
    u.onend = advance;
    u.onerror = advance;
    try {
      if (typeof synth.resume === 'function') synth.resume();
      synth.speak(u);
    } catch (e) { advance(); return; }
    // 兜底：个别平台长句既不 onend 也不 onerror，按预估时长强推下一块
    clearGuard();
    guardTimer = setTimeout(advance, Math.max(2500, text.length * 95) + 1500);
  }

  function say(text, opts) {
    if (!synth || !text) return false;
    curRate = (opts && opts.rate) || 0.92;
    try {
      if (kickTimer) { clearTimeout(kickTimer); kickTimer = null; }
      clearGuard();
      synth.cancel();                       // 清掉上一条
      queue = splitText(text);
      // 关键：cancel() 在 iOS 上是异步的，紧接着 speak() 会被一起吞掉，
      // 延迟一帧再启动队列即可稳定出声。
      kickTimer = setTimeout(playNext, 80);
      return true;
    } catch (e) {
      console.warn('[speak] 朗读失败', e);
      return false;
    }
  }

  function stop() {
    if (!synth) return;
    queue = [];
    if (kickTimer) { clearTimeout(kickTimer); kickTimer = null; }
    clearGuard();
    try { synth.cancel(); } catch (e) {}
  }

  return { init: init, say: say, stop: stop, available: available,
           hasVoice: hasVoice, setAccent: setAccent,
           get voice() { return voice; } };
})();

/* ------------------------------------------------- 义项分级展示组件 */

window.DefsView = (function () {
  'use strict';

  const el = window.UI.el;

  /**
   * 渲染一个词条的释义区（背面信息分层，渐进披露）。
   *
   * 顺序：① 中文释义 → ② 一条最短双语主例句（记忆主力）→ ③ 常用搭配
   *       → 折叠区（更多例句 / 真题长难句 / 相关词）→ 查词典外链。
   *
   * opts:
   *   compact     —— 复习/速过/选择题卡用 true：只露 1 条主例句、搭配限 3 条、
   *                  其余全部折叠，保证一屏看完；词书页详情用 false（默认，尽量展开）
   *   showPhrases —— 是否显示短语搭配，默认 true
   *   showExtras  —— 是否显示相关词，默认 true
   *   showCites   —— 是否显示真题原句，默认 true（始终折叠）
   *   citeLimit   —— 最多显示几条真题原句，默认 2
   */
  function render(entry, opts) {
    opts = opts || {};
    const compact = !!opts.compact;
    const showPhrases = opts.showPhrases !== false;
    const showExtras  = opts.showExtras  !== false;

    const root  = el('div', { class: 'defs-view' });

    /* ① 义项（中文释义） */
    const list = el('ul', { class: 'def-list' });
    window.WB.studyDefs(entry).forEach(function (d) { list.appendChild(defRow(d)); });
    root.appendChild(list);

    /* ② 主例句：挑最短的一条双语例句 —— 短、自然、带中文，最利于记忆提取 */
    const all = (entry.examples || []).filter(function (x) { return x && x.en; });
    const main = pickMainExample(all);
    const rest = all.filter(function (x) { return x !== main; });
    if (main) root.appendChild(mainExample(main));

    /* ③ 短语搭配：复习卡只留前 3 条，避免一屏过载 */
    if (showPhrases && entry.phrases && entry.phrases.length) {
      const phrases = compact ? entry.phrases.slice(0, 3) : entry.phrases;
      const box = el('div', { class: 'phrases' }, [
        el('div', { class: 'sub-head', text: '常用搭配' })
      ]);
      const ul = el('ul', { class: 'phrase-list' });
      phrases.forEach(function (p) {
        ul.appendChild(el('li', { class: 'phrase' }, [
          el('code', { class: 'phrase-en', text: p.text }),
          el('span', { class: 'phrase-zh', text: p.zh || '' })
        ]));
      });
      box.appendChild(ul);
      root.appendChild(box);
    }

    /* ④-a 更多双语例句：复习卡折叠，词书页平铺 */
    if (rest.length) {
      const ul = el('ul', { class: 'example-list' });
      rest.forEach(function (ex) { ul.appendChild(exampleRow(ex)); });
      if (compact) {
        root.appendChild(fold('更多例句 · ' + rest.length, [ul], 'dv-fold'));
      } else {
        root.appendChild(el('div', { class: 'examples' }, [
          el('div', { class: 'sub-head', text: '例句' }), ul
        ]));
      }
    }

    /* ④-b 真题原句：永远折叠。它是长难句、无译文，属精读材料而非记忆材料，
       不再顶到最前面抢注意力。 */
    if (opts.showCites !== false) {
      const cites = window.WB.citationsOf(entry.word,
                      opts.citeLimit === undefined ? 2 : opts.citeLimit);
      if (cites.length) {
        const ul = el('ul', { class: 'cite-list' });
        cites.forEach(function (c) { ul.appendChild(citeItem(c)); });
        root.appendChild(fold('真题原句 ' + cites.length + ' 条 · 长难句 · 无译文 · 选学',
                              [ul], 'dv-fold dv-fold--cite'));
      }
    }

    /* ④-c 相关词（同根词）：复习卡折叠，词书页平铺 */
    if (showExtras && entry.related && entry.related.length) {
      if (compact) {
        root.appendChild(fold('相关词', [
          el('div', { class: 'related-text', text: entry.related.join('　') })
        ], 'dv-fold'));
      } else {
        root.appendChild(el('div', { class: 'related' }, [
          el('span', { class: 'sub-head sub-head--inline', text: '相关' }),
          el('span', { text: entry.related.join('　') })
        ]));
      }
    }

    /* ⑤ 查词典外链：复习卡只在缺少双语例句时出现以补中文/真人音，词书页常驻 */
    if (!main || !compact) root.appendChild(dictLinks(entry.word));

    return root;
  }

  /* 从候选例句里挑「主例句」：优先带中文的，再取英文最短的一条 */
  function pickMainExample(exs) {
    if (!exs || !exs.length) return null;
    const withZh = exs.filter(function (x) { return x.zh; });
    const pool = withZh.length ? withZh : exs;
    return pool.slice().sort(function (a, b) {
      return (a.en || '').length - (b.en || '').length;
    })[0];
  }

  function speakBtnOf(text, label, cls) {
    if (!window.Speak.available()) return null;
    return el('button', {
      class: 'speak-btn ' + (cls || 'speak-btn--sm'), type: 'button',
      title: '朗读', 'aria-label': label,
      onclick: function (e) { e.stopPropagation(); window.Speak.say(text); }
    }, [el('span', { text: '🔊', 'aria-hidden': 'true' })]);
  }

  /* 主例句：突出展示的一条短双语例句 */
  function mainExample(ex) {
    const enRow = el('p', { class: 'ex-en main-ex-en' }, [el('span', { text: ex.en })]);
    const b = speakBtnOf(ex.en, '朗读例句', 'speak-btn--sm');
    if (b) enRow.appendChild(b);
    const kids = [enRow];
    if (ex.zh) kids.push(el('p', { class: 'ex-zh main-ex-zh', text: ex.zh }));
    return el('div', { class: 'main-example' }, kids);
  }

  function exampleRow(ex) {
    const li = el('li', { class: 'example' });
    const enRow = el('p', { class: 'ex-en' }, [el('span', { text: ex.en })]);
    const b = speakBtnOf(ex.en, '朗读例句', 'speak-btn--sm');
    if (b) enRow.appendChild(b);
    li.appendChild(enRow);
    if (ex.zh) li.appendChild(el('p', { class: 'ex-zh', text: ex.zh }));
    return li;
  }

  function citeItem(c) {
    const li = el('li', { class: 'cite-item' });
    const row = el('p', { class: 'cite-sent' }, [el('span', { text: c.sent })]);
    const b = speakBtnOf(c.sent, '朗读真题原句', 'speak-btn--sm');
    if (b) row.appendChild(b);
    li.appendChild(row);
    if (c.src) li.appendChild(el('span', { class: 'cite-src', text: c.src }));
    return li;
  }

  /* 原生 <details> 折叠区：零依赖、零状态、离线可用 */
  function fold(summaryText, children, cls) {
    const d = el('details', { class: cls || 'dv-fold' });
    d.appendChild(el('summary', { class: 'dv-fold-sum', text: summaryText }));
    const body = el('div', { class: 'dv-fold-body' });
    children.forEach(function (c) { if (c) body.appendChild(c); });
    d.appendChild(body);
    return d;
  }

  /* 外部在线词典（新窗口打开）。离线时点击无效，不影响其余功能。 */
  function dictLinks(word) {
    const w = encodeURIComponent(word);
    const sources = [
      ['剑桥', 'https://dictionary.cambridge.org/dictionary/english-chinese-simplified/' + w],
      ['有道', 'https://www.youdao.com/result?word=' + w + '&lang=en'],
      ['欧路', 'https://dict.eudic.net/dicts/en/' + w]
    ];
    const row = el('div', { class: 'dict-links' }, [
      el('span', { class: 'dict-hint', text: '查词典' })
    ]);
    sources.forEach(function (s) {
      row.appendChild(el('a', {
        class: 'dict-link', href: s[1], target: '_blank',
        rel: 'noopener noreferrer', text: s[0]
      }));
    });
    return row;
  }

  /* 单条义项 */
  function defRow(d) {
    return el('li', { class: 'def' }, [
      el('span', { class: 'def-text', text: (d && d.text) || '' })
    ]);
  }

  /** 词头：单词 + 音标 + 发音按钮 + 单词级真题词频 */
  function head(entry, opts) {
    opts = opts || {};
    const box = el('div', { class: 'word-head' + (opts.big ? ' word-head--big' : '') });
    box.appendChild(el('span', { class: 'word-text', text: entry.word }));

    if (window.Speak.available()) {
      box.appendChild(el('button', {
        class: 'speak-btn', type: 'button', title: '朗读（S）', 'aria-label': '朗读单词',
        onclick: function (e) { e.stopPropagation(); window.Speak.say(entry.word); }
      }, [el('span', { text: '🔊', 'aria-hidden': 'true' })]));
    }
    if (entry.phonetic) {
      box.appendChild(el('span', { class: 'phonetic', text: entry.phonetic }));
    }
    if (opts.freq !== false) {
      const badge = freqBadge(entry);
      if (badge) box.appendChild(badge);
    }
    return box;
  }

  /**
   * 单词级真题词频徽章。
   *
   * 这个数字是【单词级】的：它说明这个词在约 200 套真题里出现过多少次，
   * 不说明用的是哪个义项。所以它只能待在词头，
   * 绝不能挂到某条义项旁边 —— 那等于宣称「这个义项常考」，
   * 而这份数据根本不支持那个结论。
   *
   * 想知道某个义项到底怎么考的，看下面的「真题原句」区块：
   * 那里是真实的考题句子，自己判断比看一个推测出来的标签可靠。
   */
  function freqBadge(entry) {
    if (!window.WB.hasFreq()) return null;
    const f = window.WB.freqOf(entry);

    if (f > 0) {
      return el('span', {
        class: 'freq-badge', title: '该单词在约 200 套真题中共出现 ' + f + ' 次（不区分义项）'
      }, [el('span', { text: '真题 ' + f + ' 次' })]);
    }
    if (window.WB.isNeverTested(entry)) {
      return el('span', {
        class: 'freq-badge freq-badge--none',
        title: '大纲收录，但在约 200 套真题中未出现过 —— 可以放心降低优先级'
      }, [el('span', { text: '真题未出现' })]);
    }
    return null;
  }

  return { render: render, head: head, defRow: defRow, freqBadge: freqBadge };
})();
