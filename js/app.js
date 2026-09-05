/* ===========================================================================
 *  app.js —— 主控：页签路由、今日页、词书页、统计页、设置页
 * =========================================================================== */

(function () {
  'use strict';

  const el = window.UI.el;
  const S  = window.Store;
  const E  = window.Engine;

  let mainEl = null;
  let navEl  = null;
  let view   = 'home';
  let mounted = null;   // 当前挂载的子模块（Triage / Review），用于 unmount

  const TABS = [
    { id: 'home',  label: '今日' },
    { id: 'book',  label: '词书' },
    { id: 'stats', label: '统计' },
    { id: 'set',   label: '设置' }
  ];

  /* ---------------------------------------------------------------- 路由 */

  function go(next) {
    if (mounted && mounted.unmount) { mounted.unmount(); mounted = null; }
    window.Charts.hideTip();
    view = next;
    renderNav();
    render();
    window.scrollTo(0, 0);
  }

  function renderNav() {
    window.UI.clear(navEl);
    const isSub = (view === 'triage' || view === 'review');
    TABS.forEach(function (t) {
      navEl.appendChild(el('button', {
        class: 'tab' + (view === t.id ? ' is-active' : ''),
        type: 'button', text: t.label,
        'aria-current': view === t.id ? 'page' : null,
        onclick: function () { go(t.id); }
      }));
    });
    navEl.classList.toggle('is-dim', isSub);
  }

  function render() {
    window.UI.clear(mainEl);

    let node = null;
    if (view === 'home')        node = pageHome();
    else if (view === 'book')   node = pageBook();
    else if (view === 'stats')  node = pageStats();
    else if (view === 'set')    node = pageSettings();

    if (node) {
      mainEl.appendChild(node);
      if (window.FX) {
        window.FX.enter(node, { dy: 12 });
        // 数据块错峰上浮，比整页一起淡入有节奏
        window.FX.stagger(node.querySelectorAll('.tile'), { step: 55, dy: 12 });
      }
      return;
    }

    if (view === 'triage') {
      const host = el('div', { class: 'sub-view' });
      mainEl.appendChild(host);
      window.Triage.mount(host, { onExit: function () { go('home'); } });
      mounted = window.Triage;
    } else if (view === 'review') {
      const host = el('div', { class: 'sub-view' });
      mainEl.appendChild(host);
      window.Review.mount(host, { onExit: function () { go('home'); } });
      mounted = window.Review;
    }
  }

  /* ================================================================ 等级 */

  /*
   * 等级与经验。
   *
   * 【不新增存档字段】—— 经验直接从已有的 st.daily 逐日累加得出：
   * 普查定级（triaged）和复习作答（total）各算一次练习。
   * 这样老存档不用迁移，导入几个月前的旧备份也能立刻算出等级，
   * 不会出现「导入后等级归零」这种让人心态崩掉的事。
   *
   * 曲线取平方根而不是线性：前期升得快，给得起正反馈；
   * 后期自然放缓，免得背到后面每天涨三级、等级数字彻底贬值。
   *   Lv2 需要 50 次，Lv5 需要 800 次，Lv11 需要 5000 次。
   */
  const EXP_PER_LEVEL = 50;

  function totalExp(daily) {
    let sum = 0;
    Object.keys(daily || {}).forEach(function (d) {
      const r = daily[d] || {};
      sum += (r.triaged || 0) + (r.total || 0);
    });
    return sum;
  }
  function levelOf(exp)   { return Math.floor(Math.sqrt(exp / EXP_PER_LEVEL)) + 1; }
  function expAtLevel(lv) { return (lv - 1) * (lv - 1) * EXP_PER_LEVEL; }

  function expBar() {
    const st  = S.get();
    const exp = totalExp(st.daily);
    const lv  = levelOf(exp);
    const base = expAtLevel(lv);
    const next = expAtLevel(lv + 1);
    const cur  = exp - base;
    const need = Math.max(1, next - base);
    const pct  = Math.min(100, cur / need * 100);

    const d = S.getDaily();
    const gain = (d.triaged || 0) + (d.total || 0);

    return el('div', { class: 'exp-bar' }, [
      el('div', { class: 'exp-badge' }, [
        el('b', { text: String(lv) }),
        el('small', { text: 'LV' })
      ]),
      el('div', { class: 'exp-body' }, [
        el('div', { class: 'exp-top' }, [
          el('strong', { text: '累计练习 ' + fmtNum(exp) + ' 次' }),
          gain ? el('span', { class: 'exp-gain', text: '今天 +' + gain }) : null,
          el('span', { class: 'exp-num', text: cur + ' / ' + need })
        ]),
        el('div', { class: 'progress' }, [
          el('div', { class: 'progress-fill', style: 'width:' + pct.toFixed(2) + '%' })
        ])
      ])
    ]);
  }

  /* ================================================================ 冲刺面板 */

  /*
   * 轮次进度。
   *
   * 间隔重复的一个词，从学到考前会被复习多次。这里把「复习次数」
   * 映射成用户能理解的「轮次」：
   *   第 1 轮 = 已学（active，进入过复习循环）
   *   第 2 轮 = 成功复习过 1 次（reps >= 1）
   *   第 3 轮 = 成功复习过 2 次（reps >= 2）
   *
   * 分母是 L1+L2（真正的待背池），不含 L3 熟词 —— 熟词不参与「过两轮」目标。
   */
  function roundProgress(cards) {
    const rounds = [0, 0, 0];
    Object.keys(cards).forEach(function (w) {
      const c = cards[w];
      if (!c || !c.active) return;
      /* 只数 L1/L2 —— L3 熟词即使被排期激活也不属于「待背池」。
         不写这个过滤，熟词会全被算进「已学」，分子直接超过 L1+L2 分母，
         进度条破 100%。用户实测踩到过：3192/2363。 */
      if (c.level !== 1 && c.level !== 2) return;
      const reps = c.reps || 0;
      rounds[0]++;
      if (reps >= 1) rounds[1]++;
      if (reps >= 2) rounds[2]++;
    });
    return rounds;
  }

  /*
   * 冲刺面板：倒计时 + 每日目标 + 轮次进度。
   * 只在设置了考试日期、且普查已建档(L1+L2>0)时显示。
   */
  function sprintPanel() {
    const st = S.get();
    const examDate = st.settings.examDate;
    if (!examDate) return null;

    const cards  = st.cards;
    const counts = E.levelCounts(cards);
    const total  = counts[0] + counts[1];     // L1 + L2
    if (total === 0) return null;

    const daysLeft  = S.daysBetween(S.today(), examDate);
    const rounds    = roundProgress(cards);
    const remaining = Math.max(0, total - rounds[0]);           // 还没学的
    const effDays   = Math.max(1, daysLeft - 10);               // 留 10 天缓冲
    const target    = Math.max(0, Math.ceil(remaining / effDays));

    const box = el('div', { class: 'sprint' });

    /* --- 头部：倒计时 + 目标 --- */
    box.appendChild(el('div', { class: 'sprint-head' }, [
      el('div', { class: 'sprint-count' }, [
        el('b', { text: daysLeft > 0 ? String(daysLeft) : '!' }),
        el('small', { text: daysLeft > 0 ? '天' : '考试' })
      ]),
      el('div', { class: 'sprint-meta' }, [
        el('div', { class: 'sprint-title', text: daysLeft > 0 ? '距考研' : '今天考试' }),
        el('div', { class: 'sprint-sub', text:
          daysLeft > 0
            ? '待背 ' + fmtNum(remaining) + ' 词 · 每日目标约 ' + fmtNum(target) + ' 词'
            : '加油' })
      ])
    ]));

    /* --- 轮次进度条 --- */
    const rows = [
      { label: '第 1 轮 · 已学',         n: rounds[0] },
      { label: '第 2 轮 · 已复习 1 次',   n: rounds[1] },
      { label: '第 3 轮 · 已复习 2 次',   n: rounds[2] }
    ];
    const body = el('div', { class: 'sprint-rounds' });
    rows.forEach(function (r) {
      const pct = total ? Math.min(100, r.n / total * 100) : 0;
      body.appendChild(el('div', { class: 'sprint-round' }, [
        el('div', { class: 'sprint-round-top' }, [
          el('span', { class: 'sprint-round-label', text: r.label }),
          el('span', { class: 'sprint-round-num', text: fmtNum(r.n) + ' / ' + fmtNum(total) })
        ]),
        el('div', { class: 'progress' }, [
          el('div', { class: 'progress-fill', style: 'width:' + pct.toFixed(1) + '%' })
        ])
      ]));
    });
    box.appendChild(body);

    return box;
  }

  /* ================================================================ 今日页 */

  function pageHome() {
    const st  = S.get();
    const tri = window.Triage.status();
    const rev = window.Review.status();
    const d   = S.getDaily();
    const box = el('div', { class: 'page' });

    /* --- 冲刺模式 vs 游戏模式 ---
       设了考试日期：首页第一块是冲刺面板（倒计时/待背/每日目标/轮次），
       不放 LV 经验条 —— 冲刺期用户要的是进度确定性，不是升级。
       「累计练习 N 次」「555 到下一级」这种次数概念会和词汇进度混淆，
       用户实测把 LV 进度误读成词数进度了。 */
    const sprint = sprintPanel();
    if (sprint) box.appendChild(sprint);
    else box.appendChild(expBar());

    /* --- 主行动区 --- */
    if (!tri.complete) {
      box.appendChild(actionCard({
        kicker: '阶段一 · 普查',
        title: tri.done === 0 ? '先把整本词表过一遍' : '继续普查',
        desc: '还有 ' + fmtNum(tri.remaining) + ' 个词没分类' +
              (tri.done ? '（已完成 ' + (tri.done / tri.total * 100).toFixed(1) + '%）' : '') + '。',
        hint: '只看单词、凭第一印象归入三类。选「熟词」时会要求你翻开释义核对一次 —— ' +
              '这道关卡决定整份档案准不准，别跳过。',
        btn: tri.done === 0 ? '开始普查' : '继续普查',
        onclick: function () { go('triage'); },
        progress: { done: tri.done, total: tri.total }
      }));

      if (st.settings.reviewBeforeTriageDone && rev.totalToday > 0) {
        box.appendChild(actionCard({
          kicker: '阶段二 · 复习',
          title: '今天有 ' + rev.totalToday + ' 个词要过',
          desc: '复习 ' + rev.due + ' 个 · 新学 ' + rev.newToStudy + ' 个',
          btn: '开始复习',
          onclick: function () { go('review'); },
          secondary: true
        }));
      }
    } else {
      if (rev.totalToday > 0) {
        box.appendChild(actionCard({
          kicker: '阶段二 · 复习',
          title: '今天有 ' + rev.totalToday + ' 个词要过',
          desc: '到期复习 ' + rev.due + ' 个 · 新学 ' + rev.newToStudy + ' 个',
          hint: rev.newL3 > 0
            ? ('另有 ' + fmtNum(rev.newL3) + ' 个熟词等待排期，进入复习页时会一次性摊到未来一段时间里陆续巡检，不占今天的量。')
            : null,
          btn: '开始复习',
          onclick: function () { go('review'); }
        }));
      } else {
        const fc = E.forecast(st.cards, 8).slice(1).filter(function (x) { return x.count > 0; });
        const quotaUsedUp = rev.unlearnedL12 > 0 && rev.budget <= 0;
        /* 配额用完 ≠ 所有词都学完了。文案必须说清「今天完成 + 还剩多少 + 节奏够不够」，
           否则「今天该做的都做完了」紧跟「还有 2338 个没学」会让用户觉得自相矛盾。 */
        box.appendChild(actionCard({
          kicker: '今天',
          title: quotaUsedUp ? '今天的新词背完了' : '今天没有要到期的复习',
          desc: quotaUsedUp
            ? ('已背 ' + rev.usedToday + ' 个新词（今日投放 ' + rev.limit + '）。' +
               '词表还剩 ' + fmtNum(rev.unlearnedL12) + ' 个没学 —— ' +
               '系统按你的考试日期每天投放 ' + rev.limit + ' 个，' +
               (sprint ? '能在考前学完并留出复习时间。' : '能赶在计划内学完。'))
            : (fc.length ? ('下一批到期在 ' + fc[0].date + '，共 ' + fc[0].count + ' 个词。')
                         : '未来一周没有到期的词。'),
          hint: quotaUsedUp
            ? '明天会有新词，加上今天学过的词的首次复习一起来。保持每天跟上，量是均衡的。'
            : null,
          btn: (quotaUsedUp || rev.unlearned > 0) ? '进去看看' : null,
          onclick: function () { go('review'); }
        }));
      }
    }

    /* --- 今日数据 --- */
    box.appendChild(window.Charts.statTiles([
      { value: String(d.triaged || 0), label: '今日分类' },
      { value: String(d.total || 0),   label: '今日过词' },
      { value: (d.total ? Math.round((d.correct || 0) / d.total * 100) + '%' : '—'), label: '今日正确率' },
      { value: String(window.Charts.streak(st.daily)), label: '连续打卡', note: '天' }
    ]));

    /* --- 三类分布速览 --- */
    const counts = E.levelCounts(st.cards);
    if (counts[0] + counts[1] + counts[2] > 0) {
      box.appendChild(window.Charts.triageProgress(tri.done, tri.total, counts));
    }

    return box;
  }

  function actionCard(o) {
    const card = el('section', { class: 'action-card' + (o.secondary ? ' action-card--sec' : '') }, [
      el('div', { class: 'kicker', text: o.kicker }),
      el('h2', { class: 'action-title', text: o.title }),
      o.desc ? el('p', { class: 'action-desc', text: o.desc }) : null
    ]);
    if (o.progress && o.progress.total) {
      const pct = o.progress.done / o.progress.total * 100;
      card.appendChild(el('div', { class: 'progress' }, [
        el('div', { class: 'progress-fill', style: 'width:' + pct.toFixed(2) + '%' })
      ]));
    }
    if (o.hint) card.appendChild(el('p', { class: 'action-hint', text: o.hint }));
    if (o.btn) {
      card.appendChild(el('button', {
        class: 'btn btn--primary btn--wide', type: 'button', text: o.btn, onclick: o.onclick
      }));
    }
    return card;
  }

  /* ================================================================ 词书页 */

  const bookState = { q: '', level: 'all', freq: 'all', page: 0, open: null };
  const PAGE_SIZE = 60;

  function pageBook() {
    const st = S.get();
    const box = el('div', { class: 'page' });

    /* --- 筛选行：统一在图表/列表上方一行，不放进卡片内部 --- */
    const bar = el('div', { class: 'filter-bar' });

    const search = el('input', {
      class: 'input', type: 'search', placeholder: '搜索单词或释义…', value: bookState.q
    });
    let timer = null;
    search.addEventListener('input', function () {
      clearTimeout(timer);
      timer = setTimeout(function () {
        bookState.q = search.value.trim();
        bookState.page = 0;
        refresh();
      }, 200);
    });
    bar.appendChild(search);

    bar.appendChild(select('类别', bookState.level, [
      { v: 'all',  t: '全部类别' },
      { v: '1',    t: 'L1 生词' },
      { v: '2',    t: 'L2 眼熟' },
      { v: '3',    t: 'L3 熟词' },
      { v: 'none', t: '未分类' },
      { v: 'due',  t: '今天到期' }
    ], function (v) { bookState.level = v; bookState.page = 0; refresh(); }));

    /* 词频是单词级的（不区分义项）。「真题未出现」的那 200 个词
       可以放心降优先级 —— 大纲收录了，但约 200 套真题一次没考过。 */
    bar.appendChild(select('真题词频', bookState.freq, [
      { v: 'all',   t: '不限词频' },
      { v: 'tested',t: '真题出现过' },
      { v: 'never', t: '真题未出现（可降优先级）' }
    ], function (v) { bookState.freq = v; bookState.page = 0; refresh(); }));

    box.appendChild(bar);

    const listHost = el('div', { class: 'book-host' });
    box.appendChild(listHost);

    function refresh() {
      window.UI.clear(listHost);
      listHost.appendChild(buildList());
    }

    function buildList() {
      const wrap = el('div');
      const all = window.WB.all();
      const q = bookState.q.toLowerCase();
      const today = S.today();

      const rows = all.filter(function (entry) {
        const card = st.cards[entry.word];
        if (bookState.level === 'none') { if (card) return false; }
        else if (bookState.level === 'due') { if (!card || !E.isDue(card, today)) return false; }
        else if (bookState.level !== 'all') { if (!card || String(card.level) !== bookState.level) return false; }

        if (bookState.freq === 'tested' && !(window.WB.freqOf(entry) > 0)) return false;
        if (bookState.freq === 'never'  && !window.WB.isNeverTested(entry)) return false;

        if (q) {
          const inWord = entry.word.toLowerCase().indexOf(q) >= 0;
          const inDef  = (entry.defs || []).some(function (dd) {
            return (dd.text || '').toLowerCase().indexOf(q) >= 0;
          });
          if (!inWord && !inDef) return false;
        }
        return true;
      });

      /* 结果计数 + 批量改类 */
      const head = el('div', { class: 'book-head' }, [
        el('span', { class: 'book-count', text: '共 ' + fmtNum(rows.length) + ' 个词' })
      ]);
      if (rows.length > 0 && rows.length <= 2000) {
        const bulk = el('div', { class: 'bulk' }, [el('span', { text: '把这 ' + rows.length + ' 个词全部改为' })]);
        [1, 2, 3].forEach(function (lv) {
          bulk.appendChild(el('button', {
            class: 'lv-pill lv-pill--' + lv, type: 'button', text: E.LEVELS[lv].name,
            onclick: function () { bulkSet(rows, lv, refresh); }
          }));
        });
        head.appendChild(bulk);
      }
      wrap.appendChild(head);

      if (!rows.length) {
        wrap.appendChild(el('p', { class: 'chart-empty', text: '没有符合条件的词。' }));
        return wrap;
      }

      const pages = Math.ceil(rows.length / PAGE_SIZE);
      if (bookState.page >= pages) bookState.page = 0;
      const slice = rows.slice(bookState.page * PAGE_SIZE, (bookState.page + 1) * PAGE_SIZE);

      const list = el('ul', { class: 'word-list' });
      slice.forEach(function (entry) { list.appendChild(wordRow(entry, refresh)); });
      wrap.appendChild(list);

      if (pages > 1) wrap.appendChild(pager(pages, refresh));
      return wrap;
    }

    refresh();
    return box;
  }

  function pager(pages, refresh) {
    const p = el('div', { class: 'pager' });
    p.appendChild(el('button', {
      class: 'btn btn--sm', type: 'button', text: '上一页',
      disabled: bookState.page === 0,
      onclick: function () { bookState.page--; refresh(); }
    }));
    p.appendChild(el('span', { class: 'pager-info',
      text: (bookState.page + 1) + ' / ' + pages }));
    p.appendChild(el('button', {
      class: 'btn btn--sm', type: 'button', text: '下一页',
      disabled: bookState.page >= pages - 1,
      onclick: function () { bookState.page++; refresh(); }
    }));
    return p;
  }

  function wordRow(entry, refresh) {
    const st = S.get();
    const card = st.cards[entry.word];
    const open = bookState.open === entry.word;

    const li = el('li', { class: 'word-row' + (open ? ' is-open' : '') });

    const main = el('button', {
      class: 'word-main', type: 'button',
      onclick: function () {
        bookState.open = open ? null : entry.word;
        refresh();
      }
    }, [
      el('span', { class: 'w-word', text: entry.word }),
      el('span', { class: 'w-def', text: window.WB.shortDef(entry, 34) }),
      window.WB.freqOf(entry) > 0
        ? el('span', { class: 'w-freq', text: window.WB.freqOf(entry) })
        : (window.WB.isNeverTested(entry)
            ? el('span', { class: 'w-freq w-freq--none', text: '0' })
            : null),
      card
        ? el('span', { class: 'lv-chip lv-chip--' + card.level, text: E.LEVELS[card.level].name })
        : el('span', { class: 'lv-chip lv-chip--none', text: '未分类' }),
      el('span', { class: 'w-due', text: card && card.active ? dueText(card) : '' })
    ]);
    li.appendChild(main);

    if (open) {
      const detail = el('div', { class: 'word-detail' });
      // 词书页是「查」而不是「背」，不赶时间，真题原句全给
      detail.appendChild(window.DefsView.render(entry, { citeLimit: 3 }));

      const tools = el('div', { class: 'row-tools' });
      const lvBox = el('div', { class: 'lv-switch' }, [
        el('span', { class: 'lv-switch-label', text: '归类为' })
      ]);
      [1, 2, 3].forEach(function (lv) {
        const active = card && card.level === lv;
        lvBox.appendChild(el('button', {
          class: 'lv-pill lv-pill--' + lv + (active ? ' is-active' : ''),
          type: 'button', text: E.LEVELS[lv].name,
          onclick: function () {
            if (card) E.manualSetLevel(card, lv);
            else st.cards[entry.word] = E.createCard(lv);
            S.save();
            S.snapshotLevels(E.levelCounts(st.cards));
            refresh();
          }
        }));
      });
      tools.appendChild(lvBox);

      if (card) {
        tools.appendChild(el('div', { class: 'card-stat' }, [
          el('span', { text: '间隔 ' + (card.interval || 0) + ' 天' }),
          el('span', { text: '连对 ' + (card.streak || 0) }),
          el('span', { text: '答错 ' + (card.lapses || 0) }),
          el('span', { text: 'ease ' + (card.ease || 0).toFixed(2) })
        ]));
        tools.appendChild(el('button', {
          class: 'btn btn--sm btn--ghost', type: 'button', text: '重置进度',
          onclick: function () {
            E.resetCard(card);
            S.save();
            window.UI.toast(entry.word + ' 的复习进度已重置（类别保留）', 'info');
            refresh();
          }
        }));
      }
      detail.appendChild(tools);
      li.appendChild(detail);
    }
    return li;
  }

  function dueText(card) {
    const n = S.daysBetween(S.today(), card.due);
    if (n < 0)  return '逾期 ' + (-n) + ' 天';
    if (n === 0) return '今天';
    if (n === 1) return '明天';
    return n + ' 天后';
  }

  function bulkSet(rows, lv, refresh) {
    window.UI.confirmDialog({
      title: '批量改类',
      body: '把当前筛选出的 <b>' + rows.length + '</b> 个词全部改为「' +
            E.LEVELS[lv].name + '」？<br><br>' +
            '<span class="muted">已有的复习进度会保留，但下次复习时间会按新类别重排。</span>',
      okText: '确认改类'
    }).then(function (ok) {
      if (!ok) return;
      const st = S.get();
      rows.forEach(function (entry) {
        const c = st.cards[entry.word];
        if (c) E.manualSetLevel(c, lv);
        else st.cards[entry.word] = E.createCard(lv);
      });
      S.save();
      S.snapshotLevels(E.levelCounts(st.cards));
      window.UI.toast('已把 ' + rows.length + ' 个词改为「' + E.LEVELS[lv].name + '」', 'good');
      refresh();
    });
  }

  function select(label, value, options, onchange) {
    const sel = el('select', { class: 'input input--sel', 'aria-label': label });
    options.forEach(function (o) {
      sel.appendChild(el('option', { value: o.v, text: o.t, selected: o.v === value }));
    });
    sel.addEventListener('change', function () { onchange(sel.value); });
    return sel;
  }

  /* ================================================================ 统计页 */

  function pageStats() {
    const st  = S.get();
    const tri = window.Triage.status();
    const counts = E.levelCounts(st.cards);
    const box = el('div', { class: 'page' });

    const activeCards = Object.keys(st.cards).filter(function (w) { return st.cards[w].active; });
    const buckets = { unstudied: 0, learning: 0, familiar: 0, mastered: 0 };
    Object.keys(st.cards).forEach(function (w) { buckets[E.masteryBucket(st.cards[w])]++; });

    box.appendChild(window.Charts.statTiles([
      { value: String(window.Charts.streak(st.daily)), label: '连续打卡', note: '天' },
      { value: fmtNum(activeCards.length), label: '已进入复习' },
      { value: fmtNum(buckets.mastered), label: '间隔已超 30 天' },
      { value: fmtNum(tri.remaining), label: '待分类' }
    ]));

    box.appendChild(window.Charts.levelTrend(st.levelSnap));
    box.appendChild(window.Charts.triageProgress(tri.done, tri.total, counts));
    box.appendChild(window.Charts.forecastChart(E.forecast(st.cards, 7)));
    box.appendChild(window.Charts.heatmap(st.daily));
    box.appendChild(window.Charts.accuracyChart(st.daily));

    return box;
  }

  /* ================================================================ 设置页 */

  function pageSettings() {
    const st = S.get();
    const s  = st.settings;
    const box = el('div', { class: 'page' });

    /* --- 学习节奏 --- */
    const g1 = group('学习节奏');

    /* 考试日期：设了它，「冲刺面板」和「自动节奏」才生效 */
    const dateInput = el('input', {
      class: 'input input--date', type: 'date', value: s.examDate || ''
    });
    dateInput.addEventListener('change', function () {
      s.examDate = dateInput.value || null;
      S.save();
      window.UI.toast(s.examDate ? '已设置考试日期' : '已取消考试日期', 'info');
    });
    g1.appendChild(field('考试日期', dateInput,
      '填考研当天。首页会出现倒计时和每日目标，帮你把剩下的词卡在考前过完。'));

    g1.appendChild(checkField('按考试日期自动调整每日新词量', s.autoPace, function (v) {
      s.autoPace = v; S.save();
    }, '开启后忽略下面的「每日新词上限」，改为按「剩余词数 ÷ 剩余天数」动态算，' +
       '考前自动留 10 天纯复习。'));

    g1.appendChild(numberField('每日新词上限', s.dailyNew, 0, 500, function (v) {
      s.dailyNew = v; S.save();
    }, '每天最多投放多少个没学过的词。到期复习的词不受这个限制。' +
       '（开启自动节奏后此项失效）'));

    g1.appendChild(quotaField(s));

    g1.appendChild(numberField('普查每批词数', s.triageBatch, 10, 500, function (v) {
      s.triageBatch = v; S.save();
    }, '普查时每过多少个词给一次小结，可以顺势休息。'));

    g1.appendChild(rangeField('选择题比例', s.quizRatio, function (v) {
      s.quizRatio = v; S.save();
    }, '0 = 全部用翻卡自评，1 = 尽量出选择题。L3 熟词的选择题比例会自动减半。'));
    box.appendChild(g1);

    /* --- 流程 --- */
    const g2 = group('流程');
    g2.appendChild(checkField('普查未完成也可以复习', s.reviewBeforeTriageDone, function (v) {
      s.reviewBeforeTriageDone = v; S.save();
    }, '默认关闭 —— 按你的设定，全部分类完再开始复习。' +
       '整本词表普查要几个小时，中途想先复习已分类的部分就打开它。'));

    g2.appendChild(checkField('翻面时自动朗读', s.autoSpeak, function (v) {
      s.autoSpeak = v; S.save();
    }, window.Speak.available() ? null : '当前浏览器不支持语音合成，这个开关不会生效。'));

    g2.appendChild(checkField('熟词不参与巡检', s.skipL3Patrol, function (v) {
      s.skipL3Patrol = v; S.save();
    }, '开启后熟词彻底不进复习、不占任何时间。' +
       '代价是「自以为会、其实不会」的熟词不会被抓出来，只在答错降级时回来。'));
    box.appendChild(g2);

    /* --- 外观 --- */
    const g3 = group('外观');
    g3.appendChild(field('主题', select('主题', s.theme, [
      { v: 'auto',  t: '跟随系统' },
      { v: 'light', t: '浅色' },
      { v: 'dark',  t: '深色' }
    ], function (v) { s.theme = v; S.save(); applyTheme(); }), null));
    box.appendChild(g3);

    /* --- 数据 --- */
    const g4 = group('数据');
    g4.appendChild(el('p', { class: 'field-note', text:
      '学习记录保存在这台电脑的浏览器里。清理浏览器数据会把它清掉，' +
      '所以重要进度请定期导出备份。备份文件也可以拷到手机或另一台电脑上接着背。' }));

    const dataRow = el('div', { class: 'btn-row' });
    dataRow.appendChild(el('button', {
      class: 'btn', type: 'button', text: '导出备份', onclick: doExport
    }));
    const fileInput = el('input', {
      type: 'file', accept: '.json,application/json', style: 'display:none'
    });
    fileInput.addEventListener('change', function () {
      const f = fileInput.files && fileInput.files[0];
      if (f) doImport(f);
      fileInput.value = '';
    });
    dataRow.appendChild(el('button', {
      class: 'btn', type: 'button', text: '导入恢复',
      onclick: function () { fileInput.click(); }
    }));
    dataRow.appendChild(fileInput);
    g4.appendChild(dataRow);

    g4.appendChild(el('div', { class: 'danger-zone' }, [
      el('p', { class: 'field-note', text: '下面这个会删掉全部分类和复习进度，无法撤销。' }),
      el('button', {
        class: 'btn btn--danger', type: 'button', text: '清空全部数据',
        onclick: doReset
      })
    ]));
    box.appendChild(g4);

    /* --- 词库信息 --- */
    const meta = window.WB.meta();
    const g5 = group('当前词库');
    g5.appendChild(el('dl', { class: 'meta-list' }, [
      el('dt', { text: '名称' }), el('dd', { text: meta.name }),
      el('dt', { text: '词条数' }), el('dd', { text: fmtNum(meta.total) })
    ]));
    if (meta.source) {
      g5.appendChild(el('p', { class: 'field-note', text: meta.source }));
    }
    if (meta.hasFreq) {
      g5.appendChild(el('p', { class: 'field-note field-note--warn', text:
        '词头显示的「真题 N 次」是单词级的：它说明这个词在约 200 套真题里出现过多少次，' +
        '【不区分】用的是哪个义项。想知道某个义项到底怎么考，看卡片上的「真题原句」。' }));
    }
    if (meta.demo) {
      g5.appendChild(el('p', { class: 'field-note field-note--warn', text:
        '这是示例词库，其中的标注是演示用的假数据，不是真实统计结果。' +
        '词条本身（拼写、音标、释义）是准确的。' }));
    }
    box.appendChild(g5);

    /* --- 真题语料 --- */
    const cm = window.WB.corpusMeta();
    const g6 = group('真题语料');
    if (cm) {
      g6.appendChild(el('dl', { class: 'meta-list' }, [
        el('dt', { text: '来源' }),   el('dd', { text: cm.name }),
        el('dt', { text: '年份' }),   el('dd', { text: cm.years }),
        el('dt', { text: '篇目' }),   el('dd', { text: cm.texts + ' 篇' }),
        el('dt', { text: '收录句' }), el('dd', { text: fmtNum(cm.sents) + ' 句' }),
        el('dt', { text: '覆盖词' }), el('dd', { text: fmtNum(cm.words) + ' 个' })
      ]));
      /* 这段必须留着。「真题原句」很容易被读成「这个义项的出处」，
         而它只是词条级的 —— 事先说清边界，比事后解释便宜得多。 */
      g6.appendChild(el('p', { class: 'field-note field-note--warn', text:
        '「真题原句」是【词条级】的：只保证这句话里有这个词，' +
        '不保证句中用的是你正在看的那个义项。' +
        '判断某一句用的是哪个义需要逐句做词义消歧，判错了比不标更误导人 —— ' +
        '所以这里只把原句原样摆出来，由你自己看。' }));
      g6.appendChild(el('p', { class: 'field-note', text:
        '高频词覆盖得最全：真题出现 200 次以上的词有 99.5% 配到了原句。' +
        '低频词配不到很正常 —— 这份语料只含历年阅读和翻译，不含完形、写作。' }));
    } else {
      g6.appendChild(el('p', { class: 'field-note', text:
        '没有加载到 data/corpus.js，卡片上不会出现「真题原句」。' +
        '需要的话在项目目录跑 node tools/build-corpus.js 生成。' }));
    }
    box.appendChild(g6);

    return box;
  }

  function group(title) {
    return el('section', { class: 'set-group' }, [el('h3', { class: 'set-title', text: title })]);
  }

  function field(label, control, note) {
    return el('div', { class: 'field' }, [
      el('label', { class: 'field-label', text: label }),
      control,
      note ? el('p', { class: 'field-note', text: note }) : null
    ]);
  }

  function numberField(label, value, min, max, onchange, note) {
    const inp = el('input', { class: 'input input--num', type: 'number',
                              min: String(min), max: String(max), value: String(value) });
    inp.addEventListener('change', function () {
      let v = parseInt(inp.value, 10);
      if (isNaN(v)) v = value;
      v = Math.max(min, Math.min(max, v));
      inp.value = String(v);
      onchange(v);
    });
    return field(label, inp, note);
  }

  function rangeField(label, value, onchange, note) {
    const out = el('span', { class: 'range-out', text: Math.round(value * 100) + '%' });
    const inp = el('input', { class: 'input input--range', type: 'range',
                              min: '0', max: '100', step: '5',
                              value: String(Math.round(value * 100)) });
    inp.addEventListener('input', function () {
      out.textContent = inp.value + '%';
    });
    inp.addEventListener('change', function () { onchange(Number(inp.value) / 100); });
    return field(label, el('div', { class: 'range-wrap' }, [inp, out]), note);
  }

  function checkField(label, checked, onchange, note) {
    const inp = el('input', { type: 'checkbox', class: 'check', checked: !!checked });
    inp.addEventListener('change', function () { onchange(inp.checked); });
    return el('div', { class: 'field field--check' }, [
      el('label', { class: 'check-label' }, [inp, el('span', { text: label })]),
      note ? el('p', { class: 'field-note', text: note }) : null
    ]);
  }

  function quotaField(s) {
    const wrap = el('div', { class: 'quota-row' });
    /* 只放 L1/L2 两个输入框 —— L3 熟词不占新词配额，
       留一个不起作用的旋钮在这里只会误导人 */
    [1, 2].forEach(function (lv) {
      const i = lv - 1;
      const inp = el('input', { class: 'input input--num input--tiny', type: 'number',
                                min: '0', max: '99', value: String(s.quota[i]) });
      inp.addEventListener('change', function () {
        let v = parseInt(inp.value, 10);
        if (isNaN(v) || v < 0) v = 0;
        inp.value = String(v);
        s.quota[i] = v;
        if (s.quota[0] + s.quota[1] === 0) {
          s.quota[0] = 6; s.quota[1] = 3;
          window.UI.toast('生词和眼熟词的配额不能都是 0，已恢复默认 6 : 3', 'warn');
          S.save();
          render();
          return;
        }
        S.save();
      });
      wrap.appendChild(el('span', { class: 'quota-item' }, [
        el('i', { class: 'swatch swatch--l' + lv }),
        el('span', { text: E.LEVELS[lv].name }),
        inp
      ]));
    });
    return field('新词投放配额（生词 : 眼熟）', wrap,
      '每日新词按这个比例分给生词和眼熟词。' +
      '熟词不占这个额度 —— 它们不进当天的学习队列，投放成本是零，' +
      '进复习页时会一次性排期、把首次巡检日摊到未来一段时间里，避免某天集中爆量。');
  }

  /* ---------------------------------------------------------------- 备份 */

  function doExport() {
    try {
      const text = S.exportJSON();
      const blob = new Blob([text], { type: 'application/json' });
      const url  = URL.createObjectURL(blob);
      const a = el('a', { href: url, download: 'vocab-backup-' + S.today() + '.json' });
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
      window.UI.toast('备份已导出', 'good');
    } catch (e) {
      console.error(e);
      window.UI.toast('导出失败：' + e.message, 'warn', 5000);
    }
  }

  function doImport(file) {
    const reader = new FileReader();
    reader.onload = function () {
      const res = S.inspectImport(String(reader.result));
      if (!res.ok) {
        window.UI.confirmDialog({
          title: '无法导入', body: res.error, okText: '知道了', cancelText: '关闭'
        });
        return;
      }
      const sm = res.summary;
      const cur = Object.keys(S.get().cards).length;
      window.UI.confirmDialog({
        title: '确认导入',
        body:
          '<p>备份文件内容：</p>' +
          '<ul class="dlg-list">' +
          '<li>已分类 <b>' + fmtNum(sm.cardCount) + '</b> 个词' +
            '（生词 ' + sm.byLevel[0] + ' · 眼熟 ' + sm.byLevel[1] + ' · 熟词 ' + sm.byLevel[2] + '）</li>' +
          '<li>记录区间：' + (sm.firstDay ? sm.firstDay + ' 至 ' + sm.lastDay : '无学习记录') + '</li>' +
          '</ul>' +
          '<p class="dlg-warn">导入会<b>完全覆盖</b>当前数据（当前已分类 ' + fmtNum(cur) + ' 个词）。' +
          '普查要花好几个小时，覆盖前先确认这是你要的那份备份。</p>',
        okText: '确认覆盖'
      }).then(function (ok) {
        if (!ok) return;
        S.commitImport(res.data);
        applyTheme();
        window.UI.toast('已从备份恢复', 'good');
        go('home');
      });
    };
    reader.onerror = function () {
      window.UI.toast('读取文件失败', 'warn');
    };
    reader.readAsText(file);
  }

  function doReset() {
    const cur = Object.keys(S.get().cards).length;
    window.UI.confirmDialog({
      title: '清空全部数据',
      body: '当前有 <b>' + fmtNum(cur) + '</b> 个词的分类和进度，清空后<b>无法恢复</b>。<br><br>' +
            '<span class="muted">建议先导出一份备份再清空。</span>',
      okText: '我确定，清空'
    }).then(function (ok) {
      if (!ok) return;
      S.reset();
      applyTheme();
      window.UI.toast('已清空', 'info');
      go('home');
    });
  }

  /* ---------------------------------------------------------------- 主题 */

  function applyTheme() {
    const t = S.get().settings.theme;
    if (t === 'auto') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', t);
  }

  function fmtNum(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }

  /* ---------------------------------------------------------------- 启动 */

  function boot() {
    mainEl = document.getElementById('main');
    navEl  = document.getElementById('nav');

    /* 词库没加载出来时给出可操作的说明，而不是白屏 */
    if (!window.WORDBOOK || !window.WORDBOOK.words || !window.WORDBOOK.words.length) {
      mainEl.appendChild(el('div', { class: 'page' }, [
        el('section', { class: 'action-card' }, [
          el('h2', { class: 'action-title', text: '词库没有加载成功' }),
          el('p', { text: '页面没能读到 data/ 目录下的词库文件。常见原因：' }),
          el('ul', { class: 'dlg-list' }, [
            el('li', { text: '整个文件夹没有完整拷贝（data 子目录缺失或改名了）' }),
            el('li', { text: '把 HTML 单独拷到了别处，脱离了 data 和 js 目录' }),
            el('li', { text: '浏览器拦截了本地文件读取 —— 换 Chrome 或 Edge 再试' })
          ]),
          el('p', { class: 'muted', text: '请确认 背单词.html 与 data、js 两个目录在同一层。' })
        ])
      ]));
      return;
    }

    window.WB.init();
    S.load();
    window.Speak.init();
    applyTheme();
    /* 特效层。init 内部会在 reduced-motion 或 WAAPI 不可用时自行空转，
       所以这里无条件调用即可，不需要判断。 */
    if (window.FX) window.FX.init();

    /* 词库带 demo 标记时常驻警示条 —— 不能让演示用的假标注被当成真数据 */
    const meta = window.WB.meta();
    if (meta.demo) {
      document.getElementById('banner').appendChild(
        el('div', { class: 'demo-banner' }, [
          el('strong', { text: '示例词库' }),
          el('span', { text:
            '当前载入的是演示数据。其中「★ 真题 N 次」的标注是假的，只为演示界面，' +
            '不要据此判断哪个义项常考。' })
        ])
      );
    }

    /* localStorage 写不进去时必须告诉用户，否则会白背一场 */
    window.addEventListener('store:writefail', function () {
      window.UI.toast('保存失败！进度可能无法留存，请检查浏览器存储设置或导出备份。', 'warn', 8000);
    });

    /* 系统主题变化时重画图表（图表颜色取自 CSS 变量） */
    if (window.matchMedia) {
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      const onChange = function () { if (S.get().settings.theme === 'auto') render(); };
      if (mq.addEventListener) mq.addEventListener('change', onChange);
      else if (mq.addListener) mq.addListener(onChange);
    }

    renderNav();
    render();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
