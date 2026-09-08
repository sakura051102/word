/* ===========================================================================
 *  rapid.js —— 熟词速过模式（独立于主复习，只处理 L3 熟词池）
 * ---------------------------------------------------------------------------
 *  L3 有两个来源，菜单里分开过：
 *    · legacy   旧版就定级为熟词的存量词（l3Origin='legacy'）
 *    · promoted 主复习里 L2 眼熟连续答对后自动升上来的词（l3Origin='promoted'）
 *
 *  速过只有两个动作，刻意比主复习快：
 *    · 认识   = Engine.grade(good)：L3 无升级规则，只把间隔继续拉长；
 *    · 不认识 = Engine.grade(again)：自动打回 L2 眼熟，明天起回到主复习。
 *  另有「批量设为永不复习」：整屏列表、默认全选、点词取消、可全选/全不选，
 *  一次把过于简单的熟词归档（archived），从此不再出现在任何复习里，可在词书页恢复。
 * =========================================================================== */

window.Rapid = (function () {
  'use strict';

  const el = window.UI.el;
  const S  = window.Store;
  const E  = window.Engine;

  const PAGE = 200;            // 批量列表每批渲染条数

  let host = null;
  let onExit = null;
  let stage = 'menu';          // menu | run | archive | done
  let run = null;              // 进行中的速过会话
  let arch = null;             // 批量归档的临时状态

  /* -------------------------------------------------------------- 取数 */

  function l3Words(origin) {
    const cards = S.get().cards;
    const out = [];
    Object.keys(cards).forEach(function (w) {
      const c = cards[w];
      if (!c || c.archived || c.level !== 3) return;
      // 迁移兜底：没有来源标记的旧熟词按 legacy 处理
      const og = c.l3Origin || 'legacy';
      if (!origin || origin === 'all' || og === origin) out.push(w);
    });
    out.sort(function (a, b) { return window.WB.indexOf(a) - window.WB.indexOf(b); });
    return out;
  }

  /** 首页 / 菜单用：各来源与已归档数量 */
  function status() {
    const cards = S.get().cards;
    let legacy = 0, promoted = 0, archived = 0;
    Object.keys(cards).forEach(function (w) {
      const c = cards[w];
      if (!c) return;
      if (c.archived) { archived++; return; }
      if (c.level === 3) {
        if ((c.l3Origin || 'legacy') === 'promoted') promoted++;
        else legacy++;
      }
    });
    return { legacy: legacy, promoted: promoted, archived: archived,
             total: legacy + promoted };
  }

  function snapshot() {
    S.snapshotLevels(E.levelCounts(S.get().cards));
  }

  /* -------------------------------------------------------------- 菜单 */

  function viewMenu() {
    const st = status();
    const scroll = el('div', { class: 'rapid-scroll' });
    const box = el('div', { class: 'rapid-menu' }, [
      el('h2', { class: 'rapid-title', text: '熟词速过' }),
      el('p', { class: 'muted rapid-sub',
        text: '这里都是你已经掌握的熟词，不占每日复习量。看着单词快速判断：' +
              '「认识」就进一步拉长间隔，「不认识」打回眼熟、明天回到正常复习。' })
    ]);

    function startBtn(origin, label, n, cls) {
      const b = el('button', {
        class: 'action-card rapid-start ' + (n ? cls || '' : 'is-disabled'),
        type: 'button', disabled: n ? false : true
      }, [
        el('span', { class: 'action-title', text: label }),
        el('span', { class: 'action-desc',
          text: n ? (n + ' 个词，预计 ' + Math.max(1, Math.ceil(n / 60)) + ' 分钟')
                  : '暂时没有词' })
      ]);
      if (n) b.addEventListener('click', function () { startRun(origin); });
      return b;
    }

    box.appendChild(startBtn('legacy', '速过 · 原熟词', st.legacy, 'rapid-start--legacy'));
    box.appendChild(startBtn('promoted', '速过 · 新晋级（从眼熟升来）', st.promoted, 'rapid-start--promoted'));

    const clean = el('button', {
      class: 'action-card rapid-start rapid-start--archive', type: 'button'
    }, [
      el('span', { class: 'action-title', text: '批量设为「永不复习」' }),
      el('span', { class: 'action-desc',
        text: '整屏列表勾选，默认全选，把过于简单的熟词一次性清走（可恢复），当前可清理 ' +
              st.total + ' 个' })
    ]);
    clean.addEventListener('click', function () { startArchive(); });
    box.appendChild(clean);

    if (st.archived) {
      box.appendChild(el('p', { class: 'muted rapid-archived-note',
        text: '已有 ' + st.archived + ' 个词设为永不复习，可在「词书」页筛选后恢复。' }));
    }
    if (!st.total) {
      box.appendChild(el('p', { class: 'muted',
        text: '熟词池还是空的：主复习里「眼熟」的词连续答对后会自动升进来。' }));
    }

    box.appendChild(el('div', { class: 'done-actions' }, [
      el('button', { class: 'btn', type: 'button', text: '返回首页',
        onclick: function () { if (onExit) onExit(); } })
    ]));

    scroll.appendChild(box);
    return scroll;
  }

  /* -------------------------------------------------------------- 速过 */

  function startRun(origin) {
    const words = l3Words(origin);
    if (!words.length) { window.UI.toast('这个分组现在没有词', 'warn', 1600); return; }
    run = {
      origin: origin,
      words: words,
      pos: 0,
      known: 0,
      back: 0,
      showDef: false
    };
    stage = 'run';
    render();
  }

  function gradeCurrent(g, srcEl) {
    if (!run) return;
    const word = run.words[run.pos];
    const card = S.getCard(word);
    if (!card) { next(); return; }
    const res = E.grade(card, g, word);
    S.setCard(word, res.card);
    if (g === 'again') {
      run.back++;
      if (window.FX && srcEl) window.FX.flash('bad');
    } else {
      run.known++;
      S.bump('review', 1); S.bump('total', 1); S.bump('correct', 1);
      if (window.FX && srcEl) { window.FX.burst(srcEl, { kind: 'good', count: 14, power: 80 }); }
    }
    snapshot();
    S.save();

    // 打回 L2 给一条提示
    res.events.forEach(function (ev) {
      if (ev.type === 'downgrade') {
        window.UI.toast(word + ' 不牢，已打回「眼熟」，明天回主复习', 'warn', 2200);
      }
    });
    next();
  }

  function next() {
    run.pos++;
    run.showDef = false;
    if (run.pos >= run.words.length) { stage = 'done'; }
    render();
  }

  function viewRun() {
    const word = run.words[run.pos];
    const entry = window.WB.get(word);
    const card = S.getCard(word);

    const top = el('div', { class: 'review-top' }, [
      el('div', { class: 'review-progress' }, [
        el('span', { class: 'rp-count',
          text: (run.pos + 1) + ' / ' + run.words.length }),
        el('span', { class: 'rp-tag',
          text: run.origin === 'legacy' ? '原熟词' : '新晋级' })
      ]),
      el('button', { class: 'btn btn--mini', type: 'button', text: '结束',
        onclick: function () { stage = 'done'; render(); } })
    ]);

    const stageBox = el('div', { class: 'review-stage' });
    const box = el('div', { class: 'card rapid-card' });
    box.appendChild(window.DefsView.head(entry, { big: true }));

    if (run.showDef) {
      box.appendChild(window.DefsView.render(entry, { compact: true, citeLimit: 1 }));
    } else {
      box.appendChild(el('div', { class: 'card-actions' }, [
        el('button', { class: 'btn', type: 'button', text: '显示释义（可选）',
          onclick: function () { run.showDef = true; render(); } })
      ]));
    }

    const unknown = el('button', { class: 'rapid-btn rapid-btn--no', type: 'button' },
      [el('kbd', { text: '1' }), el('span', { text: '不认识 · 打回眼熟' })]);
    unknown.addEventListener('click', function () { gradeCurrent('again', unknown); });
    const known = el('button', { class: 'rapid-btn rapid-btn--yes', type: 'button' },
      [el('kbd', { text: '2' }), el('span', { text: '认识 · 拉长间隔' })]);
    known.addEventListener('click', function () { gradeCurrent('good', known); });
    box.appendChild(el('div', { class: 'rapid-grade-row' }, [unknown, known]));

    if (window.NotebookUI) box.appendChild(window.NotebookUI.bar(entry));
    box.appendChild(el('p', { class: 'keyhint', text: '键盘：1 不认识　2 / 空格 认识' }));

    stageBox.appendChild(box);

    return el('div', { class: 'rapid-run' }, [top, stageBox]);
  }

  function viewDone() {
    const scroll = el('div', { class: 'rapid-scroll' });
    const box = el('div', { class: 'triage-done' }, [
      el('h2', { text: '速过完成' }),
      el('ul', { class: 'tally tally--wide' }, [
        el('li', {}, [el('span', { text: '过词' }), el('strong', { text: String(run.known + run.back) })]),
        el('li', {}, [el('span', { text: '认识' }), el('strong', { text: String(run.known) })]),
        el('li', {}, [el('span', { text: '打回眼熟' }), el('strong', { text: String(run.back) })])
      ])
    ]);
    if (run.back) {
      box.appendChild(el('p', { class: 'muted',
        text: run.back + ' 个词被打回「眼熟」，它们会在明天的正常复习里重新出现。' }));
    }
    box.appendChild(el('div', { class: 'done-actions' }, [
      el('button', { class: 'btn btn--primary', type: 'button', text: '返回速过菜单',
        onclick: function () { stage = 'menu'; run = null; render(); } }),
      el('button', { class: 'btn', type: 'button', text: '返回首页',
        onclick: function () { if (onExit) onExit(); } })
    ]));
    run = null;
    scroll.appendChild(box);
    return scroll;
  }

  /* ------------------------------------------------------ 批量永不复习 */

  function startArchive() {
    const words = l3Words('all');
    if (!words.length) { window.UI.toast('熟词池是空的，没有可清理的词', 'warn', 1800); return; }
    arch = { scope: 'all', shown: 0, selected: {} };
    words.forEach(function (w) { arch.selected[w] = true; });  // 默认全选
    stage = 'archive';
    render();
  }

  function archWords() { return l3Words(arch.scope); }

  function viewArchive() {
    const all = archWords();
    arch.shown = Math.min(arch.shown || PAGE, all.length);
    if (!arch.shown) arch.shown = Math.min(PAGE, all.length);

    const scroll = el('div', { class: 'rapid-scroll rapid-archive-scroll' });

    /* 范围切换 */
    const seg = el('div', { class: 'stack-seg rapid-scope' });
    [
      { v: 'all', t: '全部' },
      { v: 'legacy', t: '原熟词' },
      { v: 'promoted', t: '新晋级' }
    ].forEach(function (o) {
      seg.appendChild(el('button', {
        class: 'stack-seg-btn' + (arch.scope === o.v ? ' is-active' : ''),
        type: 'button', text: o.t,
        onclick: function () {
          // 切范围时把新范围的词也默认勾选（保留其它范围已做的勾选/取消）
          l3Words(o.v).forEach(function (w) {
            if (arch.selected[w] === undefined) arch.selected[w] = true;
          });
          arch.scope = o.v; arch.shown = PAGE; render();
        }
      }));
    });

    const head = el('div', { class: 'archive-head' }, [
      el('h2', { text: '批量设为永不复习' }),
      el('p', { class: 'muted',
        text: '默认全部勾选；点某个词可取消对它的勾选。确认后选中的词将不再出现在任何复习中，可在词书页恢复。' }),
      seg
    ]);

    /* 全选 / 全不选（只作用于当前范围） */
    function setScopeAll(v) {
      all.forEach(function (w) { arch.selected[w] = v; });
      render();
    }
    const tools = el('div', { class: 'archive-tools' }, [
      el('button', { class: 'btn btn--mini', type: 'button', text: '全选本范围',
        onclick: function () { setScopeAll(true); } }),
      el('button', { class: 'btn btn--mini', type: 'button', text: '全不选本范围',
        onclick: function () { setScopeAll(false); } }),
      el('button', { class: 'btn btn--mini', type: 'button', text: '返回菜单',
        onclick: function () { stage = 'menu'; arch = null; render(); } })
    ]);
    head.appendChild(tools);
    scroll.appendChild(head);

    const list = el('div', { class: 'archive-list' });
    const visible = all.slice(0, arch.shown);
    visible.forEach(function (w) {
      const checked = !!arch.selected[w];
      const entry = window.WB.get(w);
      const row = el('button', {
        class: 'archive-row' + (checked ? ' is-checked' : ''), type: 'button'
      }, [
        el('span', { class: 'archive-check', text: checked ? '☑' : '☐' }),
        el('span', { class: 'archive-word', text: w }),
        el('span', { class: 'archive-def muted',
          text: entry ? window.WB.shortDef(entry, 30) : '' })
      ]);
      row.addEventListener('click', function () {
        arch.selected[w] = !arch.selected[w];
        row.classList.toggle('is-checked', arch.selected[w]);
        row.querySelector('.archive-check').textContent = arch.selected[w] ? '☑' : '☐';
        updateFoot();
      });
      list.appendChild(row);
    });
    scroll.appendChild(list);

    if (arch.shown < all.length) {
      scroll.appendChild(el('div', { class: 'archive-more' }, [
        el('button', { class: 'btn', type: 'button',
          text: '加载更多（已显示 ' + arch.shown + ' / ' + all.length + '）',
          onclick: function () { arch.shown += PAGE; render(); } })
      ]));
    }

    /* 固定底条 */
    const foot = el('div', { class: 'archive-foot' });
    const footInfo = el('span', { class: 'archive-foot-info' });
    const confirmBtn = el('button', { class: 'btn btn--danger', type: 'button',
      text: '设为永不复习', onclick: doArchive });
    foot.appendChild(footInfo);
    foot.appendChild(confirmBtn);
    scroll.appendChild(foot);

    function selectedInScope() { return all.filter(function (w) { return arch.selected[w]; }).length; }
    function updateFoot() {
      const n = selectedInScope();
      footInfo.textContent = '本范围已选 ' + n + ' / ' + all.length +
        '（全部范围累计已选 ' + Object.keys(arch.selected).filter(function (w) { return arch.selected[w]; }).length + '）';
      confirmBtn.disabled = (n === 0);
    }
    updateFoot();

    return scroll;
  }

  function doArchive() {
    const picked = Object.keys(arch.selected).filter(function (w) { return arch.selected[w]; });
    if (!picked.length) { window.UI.toast('还没有勾选任何词', 'warn', 1500); return; }
    window.UI.confirmDialog({
      title: '把选中的 ' + picked.length + ' 个词设为永不复习？',
      body: '它们会从所有复习与速过中移除，但单词和进度都保留，之后可在「词书」页筛选「永不复习」批量恢复。',
      okText: '设为永不复习'
    }).then(function (ok) {
      if (!ok) return;
      const cards = S.get().cards;
      picked.forEach(function (w) { if (cards[w]) E.archive(cards[w]); });
      snapshot();
      S.save();
      window.UI.toast('已将 ' + picked.length + ' 个词设为永不复习', 'good', 2400);
      stage = 'menu'; arch = null; render();
    });
  }

  /* -------------------------------------------------------------- 骨架 */

  function render() {
    if (!host) return;
    window.UI.clear(host);
    let node;
    if (stage === 'run') node = viewRun();
    else if (stage === 'archive') node = viewArchive();
    else if (stage === 'done') node = viewDone();
    else node = viewMenu();
    host.appendChild(node);
    if (window.FX && stage === 'run') {
      const c = host.querySelector('.card');
      if (c) window.FX.enter(c, { dy: 0, scale: .96, duration: 240 });
    }
  }

  function onKey(e) {
    if (!host || !host.isConnected || stage !== 'run' || !run) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
    if (e.key === '1') { e.preventDefault(); gradeCurrent('again', null); }
    else if (e.key === '2' || e.key === ' ' || e.key === 'ArrowRight') {
      e.preventDefault(); gradeCurrent('good', null);
    }
  }

  function mount(container, opts) {
    host = container;
    onExit = (opts && opts.onExit) || null;
    stage = 'menu'; run = null; arch = null;
    document.addEventListener('keydown', onKey);
    render();
  }

  function unmount() {
    document.removeEventListener('keydown', onKey);
    window.Speak.stop();
    host = null; run = null; arch = null;
  }

  return { mount: mount, unmount: unmount, status: status, l3Words: l3Words };
})();
