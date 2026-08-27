/* ===========================================================================
 *  triage.js —— 普查（阶段一）
 * ---------------------------------------------------------------------------
 *  把整本词表过一遍，每个词归入 L1 生词 / L2 眼熟 / L3 熟词。
 *
 *  关键设计：点「熟词」时【强制核对】—— 翻开释义确认真的知道才归档。
 *  只看单词就点「基本不会忘」太容易把「眼熟」当成「会」，
 *  而整个复习计划都建立在这份档案之上，档案不准后面全歪。
 *  核对时只给释义，例句/搭配/真题原句一概不显示 ——
 *  这一步要重复五千多次，每多一行都会被放大五千倍。
 * =========================================================================== */

window.Triage = (function () {
  'use strict';

  const el = window.UI.el;
  const S  = window.Store;

  let host = null;
  let onExit = null;
  let sess = null;

  /* ---------------------------------------------------------------- 会话状态 */

  function newSession() {
    return {
      mode: 'card',        // card | verify | batchdone | alldone
      pendingLevel: null,  // verify 阶段暂存的待确认级别
      sessionCount: 0,     // 本次会话已分类数
      batchCount: 0,       // 本批已分类数
      batchTally: [0, 0, 0],
      history: []          // {index, word, prevCard} —— 支持回退
    };
  }

  /* ------------------------------------------------------------ 游标与取词 */

  /** 从 from 开始找第一个还没定级的词的下标；找不到返回 -1 */
  function findNext(from) {
    const cards = S.get().cards;
    const n = window.WB.size();
    for (let i = Math.max(0, from); i < n; i++) {
      const w = window.WB.at(i);
      if (w && !cards[w.word]) return i;
    }
    return -1;
  }

  function current() {
    const st = S.get();
    let i = findNext(st.triage.cursor);
    if (i < 0) {
      // 游标之后没有了，从头再扫一遍（可能用户在词书页重置过某些词）
      i = findNext(0);
    }
    if (i < 0) return null;
    if (st.triage.cursor !== i) { st.triage.cursor = i; S.save(); }
    return { index: i, entry: window.WB.at(i) };
  }

  function triagedCount() {
    return Object.keys(S.get().cards).length;
  }

  /* ---------------------------------------------------------------- 分类动作 */

  /*
   * 定级特效。
   *
   * 普查是整个流程里最枯燥的一段 —— 要连着过 5530 个词，
   * 中间没有对错、没有分数，只有重复的三选一。所以这里的即时反馈
   * 比复习页更重要：它是唯一能让「我又推进了一个」被感知到的东西。
   *
   * 颜色跟着 L1/L2/L3 的序数色阶走，和按钮左边那道竖线是同一套语义。
   * 同样必须在 render() 之前调用，否则按钮已经被重绘换掉了。
   */
  function classifyFx(level, srcEl) {
    const FX = window.FX;
    if (!FX || FX.off || !srcEl) return;
    const kind = level === 3 ? 'great' : level === 2 ? 'neutral' : 'good';
    FX.burst(srcEl, { kind: kind, count: 12 + level * 3, power: 70 + level * 14 });
    FX.ring(srcEl, kind);
  }

  function classify(level, srcEl) {
    const cur = current();
    if (!cur) return;

    // L3 必须先过核对这一关
    if (level === 3 && sess.mode === 'card') {
      sess.pendingLevel = 3;
      sess.mode = 'verify';
      render();
      return;
    }
    classifyFx(level, srcEl);
    commit(cur, level);
  }

  function commit(cur, level) {
    const st = S.get();
    const word = cur.entry.word;

    sess.history.push({
      index: cur.index,
      word: word,
      prevCard: st.cards[word] ? JSON.parse(JSON.stringify(st.cards[word])) : null
    });
    if (sess.history.length > 200) sess.history.shift();

    st.cards[word] = window.Engine.createCard(level);
    st.triage.cursor = cur.index + 1;
    S.bump('triaged', 1);          // 内含 save()

    sess.sessionCount++;
    sess.batchCount++;
    sess.batchTally[level - 1]++;
    sess.pendingLevel = null;

    snapshot();

    const batchSize = st.settings.triageBatch || 100;
    if (findNext(st.triage.cursor) < 0 && findNext(0) < 0) {
      sess.mode = 'alldone';
    } else if (sess.batchCount >= batchSize) {
      sess.mode = 'batchdone';
    } else {
      sess.mode = 'card';
    }

    /* 每 50 个给一次里程碑。
       普查要连着过几千个词，中间必须有节奏点 ——
       批次小结默认 100 个才来一次，中途太长了没有任何推进感。
       放在 render() 之前：此时上一次渲染的进度条还在文档里，能当坐标锚点。 */
    if (sess.sessionCount > 0 && sess.sessionCount % 50 === 0 &&
        window.FX && !window.FX.off) {
      const bar = host && host.querySelector('.triage-top');
      if (bar) window.FX.popText(bar, '本次已过 ' + sess.sessionCount + ' 个', 'gold');
      window.FX.flash('gold');
    }

    render();
  }

  function undo() {
    if (!sess.history.length) {
      window.UI.toast('已经是本次会话的第一个词了', 'info');
      return;
    }
    const h = sess.history.pop();
    const st = S.get();

    if (h.prevCard) st.cards[h.word] = h.prevCard;
    else delete st.cards[h.word];

    st.triage.cursor = h.index;

    // 回退时同步扣减计数，保证统计与实际一致
    const d = S.getDaily();
    if (d.triaged > 0) d.triaged -= 1;

    if (sess.sessionCount > 0) sess.sessionCount--;
    if (sess.batchCount > 0)   sess.batchCount--;

    sess.mode = 'card';
    sess.pendingLevel = null;
    S.save();
    snapshot();
    render();
    window.UI.toast('已回退：' + h.word, 'info', 1800);
  }

  function snapshot() {
    S.snapshotLevels(window.Engine.levelCounts(S.get().cards));
  }

  /* ---------------------------------------------------------------- 渲染 */

  function render() {
    if (!host) return;
    window.UI.clear(host);

    const st    = S.get();
    const total = window.WB.size();
    const done  = triagedCount();

    host.appendChild(progressBar(done, total));

    const stage = el('div', { class: 'triage-stage' });
    host.appendChild(stage);

    if (sess.mode === 'alldone')       stage.appendChild(viewAllDone());
    else if (sess.mode === 'batchdone')stage.appendChild(viewBatchDone());
    else {
      const cur = current();
      if (!cur) { stage.appendChild(viewAllDone()); }
      else if (sess.mode === 'verify') stage.appendChild(viewVerify(cur));
      else {
        const node = viewCard(cur);
        stage.appendChild(node);
        // 只有分类卡会一个接一个地换词，值得每次都播入场；
        // 核对页是同一个词翻开释义，再播一次反而突兀
        if (window.FX) window.FX.enter(node, { dy: 16 });
      }
    }

    if (sess.mode === 'card' || sess.mode === 'verify') {
      host.appendChild(footer());
    }
  }

  function progressBar(done, total) {
    const pct = total ? (done / total * 100) : 0;
    return el('div', { class: 'triage-top' }, [
      el('div', { class: 'progress', role: 'progressbar',
                  'aria-valuenow': String(done), 'aria-valuemin': '0',
                  'aria-valuemax': String(total) }, [
        el('div', { class: 'progress-fill', style: 'width:' + pct.toFixed(2) + '%' })
      ]),
      el('div', { class: 'progress-text' }, [
        el('strong', { text: fmtNum(done) }),
        el('span', { text: ' / ' + fmtNum(total) + ' 已分类' }),
        el('span', { class: 'dot-sep', text: '·' }),
        el('span', { text: '本次 ' + sess.sessionCount + ' 个' })
      ])
    ]);
  }

  /* --- 分类卡：只显示单词，不显示释义 --- */
  function viewCard(cur) {
    const entry = cur.entry;
    const box = el('div', { class: 'triage-card' });

    box.appendChild(window.DefsView.head(entry, { big: true }));
    box.appendChild(el('p', { class: 'triage-hint',
      text: '凭第一印象判断，不要犹豫。判断错了后面复习会自动纠正。' }));

    const actions = el('div', { class: 'triage-actions' });
    [
      { lv: 1, name: '生词', hint: '完全不熟' },
      { lv: 2, name: '眼熟', hint: '有印象但会忘' },
      { lv: 3, name: '熟词', hint: '基本不会忘' }
    ].forEach(function (o) {
      /* 先建节点再挂监听：特效要用按钮本身当坐标锚点，
         el() 的 onclick 简写拿不到这个引用 */
      const btn = el('button', { class: 'lv-btn lv-btn--' + o.lv, type: 'button' }, [
        el('kbd', { text: String(o.lv) }),
        el('span', { class: 'lv-name', text: o.name }),
        el('small', { class: 'lv-hint', text: o.hint })
      ]);
      btn.addEventListener('click', function () { classify(o.lv, btn); });
      actions.appendChild(btn);
    });
    box.appendChild(actions);

    if (window.Speak.available()) {
      box.appendChild(el('p', { class: 'keyhint',
        text: '快捷键：1 / 2 / 3 分类　S 朗读　← 回退' }));
    } else {
      box.appendChild(el('p', { class: 'keyhint', text: '快捷键：1 / 2 / 3 分类　← 回退' }));
    }
    return box;
  }

  /* --- 熟词核对：翻开释义，确认真的知道 --- */
  function viewVerify(cur) {
    const entry = cur.entry;
    const box = el('div', { class: 'triage-card triage-card--verify' });

    box.appendChild(window.DefsView.head(entry, { big: true }));
    box.appendChild(el('div', { class: 'verify-banner',
      text: '你选了「熟词」。核对一下 —— 下面这些意思，刚才真的想起来了吗？' }));

    // 普查要过 5530 个词，这一步必须快 ——
    // 只给释义，例句/搭配/相关词/真题原句全部关掉。
    // 判断「我认不认识这个词」不需要那些，多一行都是在拖慢节奏。
    box.appendChild(window.DefsView.render(entry, {
      showExtras: false, showExamples: false, showPhrases: false, showCites: false
    }));

    const acts = el('div', { class: 'verify-actions' });

    /* 「确认，我知道」走的是 commit() 而不是 classify()，
       所以定级特效得在这里单独放一次 —— 否则整个普查里最该有成就感的
       一步（确认一个熟词）反而是唯一没有反馈的。 */
    const okBtn = el('button', { class: 'btn btn--primary', type: 'button' },
      [el('span', { text: '确认，我知道' }), el('kbd', { text: 'Enter' })]);
    okBtn.addEventListener('click', function () {
      classifyFx(3, okBtn);
      commit(cur, 3);
    });
    acts.appendChild(okBtn);

    const downBtn = el('button', { class: 'btn', type: 'button' },
      [el('span', { text: '其实不太确定 → 归为眼熟' }), el('kbd', { text: 'Esc' })]);
    downBtn.addEventListener('click', function () {
      classifyFx(2, downBtn);
      commit(cur, 2);
    });
    acts.appendChild(downBtn);

    box.appendChild(acts);
    return box;
  }

  /* --- 批次小结 --- */
  function viewBatchDone() {
    const t = sess.batchTally;
    const sum = t[0] + t[1] + t[2] || 1;
    const box = el('div', { class: 'triage-done' }, [
      el('h2', { text: '这一批完成了' }),
      el('p', { class: 'muted', text: '本批 ' + (t[0] + t[1] + t[2]) + ' 个词的分布：' })
    ]);

    const bar = el('div', { class: 'stack-bar' });
    [1, 2, 3].forEach(function (lv) {
      const n = t[lv - 1];
      if (!n) return;
      bar.appendChild(el('div', {
        class: 'stack-seg stack-seg--l' + lv,
        style: 'flex:' + n,
        title: window.Engine.LEVELS[lv].name + ' ' + n + ' 个'
      }));
    });
    box.appendChild(bar);

    const legend = el('ul', { class: 'tally' });
    [1, 2, 3].forEach(function (lv) {
      legend.appendChild(el('li', {}, [
        el('i', { class: 'swatch swatch--l' + lv }),
        el('span', { text: window.Engine.LEVELS[lv].name }),
        el('strong', { text: String(t[lv - 1]) }),
        el('small', { text: (t[lv - 1] / sum * 100).toFixed(0) + '%' })
      ]));
    });
    box.appendChild(legend);

    box.appendChild(el('div', { class: 'done-actions' }, [
      el('button', {
        class: 'btn btn--primary', type: 'button', text: '继续下一批',
        onclick: function () {
          sess.batchCount = 0;
          sess.batchTally = [0, 0, 0];
          sess.mode = 'card';
          render();
        }
      }),
      el('button', {
        class: 'btn', type: 'button', text: '先歇会儿，回首页',
        onclick: function () { if (onExit) onExit(); }
      })
    ]));
    return box;
  }

  /* --- 全部完成 --- */
  function viewAllDone() {
    const counts = window.Engine.levelCounts(S.get().cards);
    const total = counts[0] + counts[1] + counts[2];
    const box = el('div', { class: 'triage-done' }, [
      el('h2', { text: '普查完成' }),
      el('p', { text: '全部 ' + fmtNum(total) + ' 个词已建档。现在可以开始复习了 ——' }),
      el('p', { class: 'muted',
        text: 'L1 和 L2 会拿到大部分时间，L3 只做低频巡检。复习中答错的词会自动降级。' })
    ]);

    const legend = el('ul', { class: 'tally' });
    [1, 2, 3].forEach(function (lv) {
      legend.appendChild(el('li', {}, [
        el('i', { class: 'swatch swatch--l' + lv }),
        el('span', { text: window.Engine.LEVELS[lv].name }),
        el('strong', { text: fmtNum(counts[lv - 1]) })
      ]));
    });
    box.appendChild(legend);

    box.appendChild(el('div', { class: 'done-actions' }, [
      el('button', {
        class: 'btn btn--primary', type: 'button', text: '回首页开始复习',
        onclick: function () { if (onExit) onExit(); }
      })
    ]));
    return box;
  }

  function footer() {
    return el('div', { class: 'triage-foot' }, [
      el('button', {
        class: 'btn btn--ghost', type: 'button', text: '← 回退上一个',
        disabled: sess.history.length === 0,
        onclick: undo
      }),
      el('button', {
        class: 'btn btn--ghost', type: 'button', text: '暂停并返回',
        onclick: function () { if (onExit) onExit(); }
      })
    ]);
  }

  function fmtNum(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }

  /* ---------------------------------------------------------------- 键盘 */

  function onKey(e) {
    if (!host || !host.isConnected) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;

    if (sess.mode === 'verify') {
      const cur = current();
      if (!cur) return;
      // 键盘确认时也让粒子从对应按钮冒出来，和鼠标点击表现一致
      const btns = host ? host.querySelectorAll('.verify-actions .btn') : null;
      if (e.key === 'Enter') {
        e.preventDefault();
        classifyFx(3, btns && btns[0]);
        commit(cur, 3);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        classifyFx(2, btns && btns[1]);
        commit(cur, 2);
      } else if (e.key === 's' || e.key === 'S') {
        e.preventDefault(); window.Speak.say(cur.entry.word);
      }
      return;
    }

    if (sess.mode !== 'card') return;

    if (e.key === '1' || e.key === '2' || e.key === '3') {
      e.preventDefault();
      const lv = Number(e.key);
      // 键盘定级时也让粒子从对应按钮冒出来，位置和鼠标点击一致
      const btn = host ? host.querySelectorAll('.lv-btn')[lv - 1] : null;
      classify(lv, btn);
    } else if (e.key === 's' || e.key === 'S') {
      const cur = current();
      if (cur) { e.preventDefault(); window.Speak.say(cur.entry.word); }
    } else if (e.key === 'ArrowLeft' || e.key === 'Backspace') {
      e.preventDefault();
      undo();
    }
  }

  /* ---------------------------------------------------------------- 生命周期 */

  function mount(container, opts) {
    host   = container;
    onExit = (opts && opts.onExit) || null;
    sess   = newSession();
    document.addEventListener('keydown', onKey);
    render();
  }

  function unmount() {
    document.removeEventListener('keydown', onKey);
    window.Speak.stop();
    host = null;
    sess = null;
  }

  /** 供首页显示进度用 */
  function status() {
    const total = window.WB.size();
    const done  = triagedCount();
    return { total: total, done: done, remaining: total - done, complete: done >= total && total > 0 };
  }

  return { mount: mount, unmount: unmount, status: status };
})();
