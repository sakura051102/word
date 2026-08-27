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
  let ready = false;

  function pick() {
    if (!synth) return null;
    const vs = synth.getVoices() || [];
    if (!vs.length) return null;
    // 优先 en-US，其次 en-GB，再次任意 en-*
    const byLang = function (prefix) {
      return vs.filter(function (v) {
        return (v.lang || '').replace('_', '-').toLowerCase().indexOf(prefix) === 0;
      });
    };
    const pools = [byLang('en-us'), byLang('en-gb'), byLang('en')];
    for (let i = 0; i < pools.length; i++) {
      if (pools[i].length) {
        // 同语言下优先本地合成（延迟低、离线可用）
        const local = pools[i].filter(function (v) { return v.localService; });
        return (local.length ? local : pools[i])[0];
      }
    }
    return null;
  }

  function init() {
    if (!synth) return;
    voice = pick();
    ready = !!voice;
    // Chrome 的 voice 列表是异步加载的，首次同步调用通常拿到空数组
    if (typeof synth.addEventListener === 'function') {
      synth.addEventListener('voiceschanged', function () {
        voice = pick();
        ready = !!voice;
      });
    } else {
      synth.onvoiceschanged = function () { voice = pick(); ready = !!voice; };
    }
  }

  function available() { return !!synth; }

  function say(text, opts) {
    if (!synth || !text) return false;
    try {
      synth.cancel();                       // 打断上一条，避免排队积压
      const u = new SpeechSynthesisUtterance(String(text));
      if (!voice) voice = pick();
      if (voice) { u.voice = voice; u.lang = voice.lang; }
      else u.lang = 'en-US';
      u.rate   = (opts && opts.rate)   || 0.92;
      u.pitch  = (opts && opts.pitch)  || 1;
      u.volume = (opts && opts.volume) || 1;
      synth.speak(u);
      return true;
    } catch (e) {
      console.warn('[speak] 朗读失败', e);
      return false;
    }
  }

  function stop() { if (synth) try { synth.cancel(); } catch (e) {} }

  return { init: init, say: say, stop: stop, available: available,
           get voice() { return voice; }, get ready() { return ready; } };
})();

/* ------------------------------------------------- 义项分级展示组件 */

window.DefsView = (function () {
  'use strict';

  const el = window.UI.el;

  const TAG_LABEL = { high: '常考', mid: '较常考' };

  /**
   * 渲染一个词条的释义区。
   *
   * opts:
   *   showRare   —— 是否默认展开生僻义（来自设置）
   *   studyOnly  —— true 时完全不渲染生僻义区块（普查核对用：
   *                 判断「我认不认识这个词」不该被生僻义干扰）
   *   showPhrases—— 是否显示短语搭配，默认 true
   *   showExtras —— 是否显示词根/相关词，默认 true
   */
  function render(entry, opts) {
    opts = opts || {};
    const showPhrases = opts.showPhrases !== false;
    const showExtras  = opts.showExtras  !== false;

    const root  = el('div', { class: 'defs-view' });
    const study = window.WB.studyDefs(entry);
    const rare  = opts.studyOnly ? [] : window.WB.rareDefs(entry);

    /* --- 主要义项 --- */
    const list = el('ul', { class: 'def-list' });
    study.forEach(function (d) { list.appendChild(defRow(d)); });
    root.appendChild(list);

    /* --- 生僻义：默认折叠 --- */
    if (rare.length) {
      const rareList = el('ul', { class: 'def-list def-list--rare' });
      rare.forEach(function (d) { rareList.appendChild(defRow(d)); });

      const expanded = !!opts.showRare;
      rareList.hidden = !expanded;

      const toggle = el('button', {
        class: 'rare-toggle', type: 'button',
        'aria-expanded': expanded ? 'true' : 'false',
        text: (expanded ? '收起' : '展开') + ' ' + rare.length + ' 个生僻义'
      });
      toggle.addEventListener('click', function () {
        const nowHidden = !rareList.hidden;
        rareList.hidden = nowHidden;
        toggle.setAttribute('aria-expanded', nowHidden ? 'false' : 'true');
        toggle.textContent = (nowHidden ? '展开' : '收起') + ' ' + rare.length + ' 个生僻义';
      });

      root.appendChild(toggle);
      root.appendChild(rareList);
    }

    /* --- 例句：词条级 entry.examples --- */
    if (opts.showExamples !== false && entry.examples && entry.examples.length) {
      const box = el('div', { class: 'examples' }, [
        el('div', { class: 'sub-head', text: '例句' })
      ]);
      const ul = el('ul', { class: 'example-list' });
      entry.examples.forEach(function (ex) {
        if (!ex || !ex.en) return;
        const li = el('li', { class: 'example' });
        const enRow = el('p', { class: 'ex-en' }, [el('span', { text: ex.en })]);
        if (window.Speak.available()) {
          enRow.appendChild(el('button', {
            class: 'speak-btn speak-btn--sm', type: 'button',
            title: '朗读例句', 'aria-label': '朗读例句',
            onclick: function (e) { e.stopPropagation(); window.Speak.say(ex.en); }
          }, [el('span', { text: '🔊', 'aria-hidden': 'true' })]));
        }
        li.appendChild(enRow);
        if (ex.zh) li.appendChild(el('p', { class: 'ex-zh', text: ex.zh }));
        ul.appendChild(li);
      });
      if (ul.childNodes.length) { box.appendChild(ul); root.appendChild(box); }
    }

    /* --- 短语搭配：作为词条附属，不单独成卡、不占复习配额 --- */
    if (showPhrases && entry.phrases && entry.phrases.length) {
      const box = el('div', { class: 'phrases' }, [
        el('div', { class: 'sub-head', text: '常用搭配' })
      ]);
      const ul = el('ul', { class: 'phrase-list' });
      entry.phrases.forEach(function (p) {
        const li = el('li', { class: 'phrase' }, [
          el('code', { class: 'phrase-en', text: p.text }),
          el('span', { class: 'phrase-zh', text: p.zh || '' })
        ]);
        const badge = citeBadge(p);
        if (badge) { li.appendChild(badge.button); li.appendChild(badge.panel); }
        ul.appendChild(li);
      });
      box.appendChild(ul);
      root.appendChild(box);
    }

    /* --- 词根 / 相关词 --- */
    if (showExtras && entry.roots) {
      root.appendChild(el('div', { class: 'roots' }, [
        el('span', { class: 'sub-head sub-head--inline', text: '构词' }),
        el('span', { text: entry.roots })
      ]));
    }
    if (showExtras && entry.related && entry.related.length) {
      root.appendChild(el('div', { class: 'related' }, [
        el('span', { class: 'sub-head sub-head--inline', text: '相关' }),
        el('span', { text: entry.related.join('　') })
      ]));
    }

    return root;
  }

  /* 单条义项 */
  function defRow(d) {
    const tag = d.tag || null;
    const li  = el('li', { class: 'def' + (tag ? ' def--' + tag : '') });

    li.appendChild(el('span', { class: 'def-text', text: d.text || '' }));

    if (tag && TAG_LABEL[tag]) {
      li.appendChild(el('span', { class: 'def-tag def-tag--' + tag, text: TAG_LABEL[tag] }));
    }

    const badge = citeBadge(d);
    if (badge) { li.appendChild(badge.button); li.appendChild(badge.panel); }

    return li;
  }

  /**
   * 真题标注徽章。
   *
   * 【重要】只有 count > 0 才渲染★。
   * 没有真题出处的义项一律不标 —— 界面留白，不猜、不推测。
   * 这样用户看到★就一定能点开看到出处，标记的可信度是满的。
   */
  function citeBadge(d) {
    const count = d.count || 0;
    if (count <= 0) return null;

    const cites = d.cites || [];
    const panel = el('div', { class: 'cite-panel', hidden: true });

    if (cites.length) {
      cites.forEach(function (c) {
        panel.appendChild(el('div', { class: 'cite' }, [
          el('span', { class: 'cite-src', text: c.src || '' }),
          el('p',    { class: 'cite-sent', text: c.sent || '' })
        ]));
      });
      if (cites.length < count) {
        panel.appendChild(el('div', { class: 'cite-more',
          text: '另有 ' + (count - cites.length) + ' 处未列出' }));
      }
    } else {
      // count > 0 但没存具体句子 —— 如实说明，不编造
      panel.appendChild(el('div', { class: 'cite-none',
        text: '统计到 ' + count + ' 处，但本词库未收录具体原句。' }));
    }

    const btn = el('button', {
      class: 'cite-btn', type: 'button', 'aria-expanded': 'false',
      title: '点击查看真题出处'
    }, [
      el('span', { class: 'cite-star', text: '★', 'aria-hidden': 'true' }),
      el('span', { text: '真题 ' + count + ' 次' })
    ]);

    btn.addEventListener('click', function () {
      const nowHidden = !panel.hidden;
      panel.hidden = nowHidden;
      btn.setAttribute('aria-expanded', nowHidden ? 'false' : 'true');
      btn.classList.toggle('is-open', !nowHidden);
    });

    return { button: btn, panel: panel };
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
   * 【刻意不用★】—— 在这套界面里★专指「义项级」真题标注：
   * 点★能看到那个义项的具体出处原句。
   * 词频是单词级的：它说明这个词出现过多少次，不说明用的是哪个义项。
   * 两者用同一个符号会让人误以为「这个义项常考」，所以样式必须区分开。
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
