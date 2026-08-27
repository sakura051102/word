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

  /**
   * 渲染一个词条的释义区。
   *
   * opts:
   *   showPhrases —— 是否显示短语搭配，默认 true
   *   showExtras  —— 是否显示相关词，默认 true
   *   showExamples—— 是否显示例句（词库自带的），默认 true
   *   showCites   —— 是否显示真题原句，默认 true
   *   citeLimit   —— 最多显示几条真题原句，默认 2
   *                  （复习卡片上要克制；词书页展开时可以放开）
   */
  function render(entry, opts) {
    opts = opts || {};
    const showPhrases = opts.showPhrases !== false;
    const showExtras  = opts.showExtras  !== false;

    const root  = el('div', { class: 'defs-view' });

    /* --- 义项 --- */
    const list = el('ul', { class: 'def-list' });
    window.WB.studyDefs(entry).forEach(function (d) { list.appendChild(defRow(d)); });
    root.appendChild(list);

    /* --- 真题原句：放在词库自带例句【之前】 ---
       这是唯一一处真实考过的语料，优先级高于教材式的通用例句。 */
    if (opts.showCites !== false) {
      const cites = window.WB.citationsOf(entry.word,
                      opts.citeLimit === undefined ? 2 : opts.citeLimit);
      if (cites.length) {
        const box = el('div', { class: 'cites' }, [
          el('div', { class: 'sub-head', text: '真题原句' })
        ]);
        const ul = el('ul', { class: 'cite-list' });
        cites.forEach(function (c) {
          const li = el('li', { class: 'cite-item' });
          const row = el('p', { class: 'cite-sent' }, [el('span', { text: c.sent })]);
          if (window.Speak.available()) {
            row.appendChild(el('button', {
              class: 'speak-btn speak-btn--sm', type: 'button',
              title: '朗读', 'aria-label': '朗读真题原句',
              onclick: function (e) { e.stopPropagation(); window.Speak.say(c.sent); }
            }, [el('span', { text: '🔊', 'aria-hidden': 'true' })]));
          }
          li.appendChild(row);
          if (c.src) li.appendChild(el('span', { class: 'cite-src', text: c.src }));
          ul.appendChild(li);
        });
        box.appendChild(ul);
        root.appendChild(box);
      }
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
        ul.appendChild(el('li', { class: 'phrase' }, [
          el('code', { class: 'phrase-en', text: p.text }),
          el('span', { class: 'phrase-zh', text: p.zh || '' })
        ]));
      });
      box.appendChild(ul);
      root.appendChild(box);
    }

    /* --- 相关词（同根词）--- */
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
