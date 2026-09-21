/* ===========================================================================
 *  app.js —— 主控：页签路由、今日页、词书页、统计页、设置页
 * =========================================================================== */

(function () {
  'use strict';

  const el = window.UI.el;
  const S  = window.Store;
  const E  = window.Engine;

  // 应用版本号：每次发布改一下，设置页可见，用来判断平板/手机是不是已经更新到新版
  const APP_VERSION = '2026.09.21';

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
    const isSub = (view === 'triage' || view === 'review' || view === 'rapid');
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
    // 在 body 上标记当前视图，供 CSS 按页切换布局（学习视图一屏化 / 信息页宽屏多列）。
    // 这里是唯一的切页出口（go() 与首次启动都经过这里），打一处标即可覆盖全部页面。
    document.body.setAttribute('data-view', view);

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
    } else if (view === 'rapid') {
      const host = el('div', { class: 'sub-view' });
      mainEl.appendChild(host);
      window.Rapid.mount(host, { onExit: function () { go('home'); } });
      mounted = window.Rapid;
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
   * 两条进度都以「整本词表总数」为分母（分子恒 ≤ 分母，进度条不可能破 100%）。
   * 关键：普查建档只是给词分类，不等于学过 —— 不能把「已建档」当成「已覆盖」，
   * 否则普查一做完第一条就假满格、待背显示 0，但其实还有大量生词没开始学。
   *   覆盖 covered = 真正进入过学习的词：已激活(active)的 L1/L2 + 全部 L3 熟词
   *              （熟词普查时就判定会了，算覆盖）+ 已归档(archived)的词；
   *   脱生词 settled = 当前不在 L1 生词档：L2 眼熟 + L3 熟词 + 已归档。
   * 第一条未满 = 还有词没正式学；两条之差 = 还在 L1 生词档、需隔天密集复习的硬骨头。
   */
  function roundProgress(cards) {
    let covered = 0, settled = 0;
    Object.keys(cards).forEach(function (w) {
      const c = cards[w];
      if (!c || !window.WB.get(w)) return;
      if (c.archived) { covered++; settled++; return; }
      if (c.level === 3) { covered++; settled++; return; }  // 熟词：本来就会
      if (c.level === 2) settled++;                        // 眼熟：已脱离生词档
      if (c.active) covered++;                             // L1/L2 只有真正学过才算覆盖
    });
    return [covered, settled];
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
    const total  = window.WB.size();        // 整本词表，两条进度的统一分母
    const rounds = roundProgress(cards);
    if (rounds[0] === 0) return null;       // 还没学过任何词、也没有熟词时不显示冲刺面板

    const daysLeft  = S.daysBetween(S.today(), examDate);
    const remaining = Math.max(0, total - rounds[0]);           // 还没正式学过（含未普查）
    /* 每日目标直接取复习引擎今天【实际计划投放】的新词上限（自动节奏 + 保底后的结果），
       与下方复习卡的「新学 N 个」同源 —— 不会再出现「目标 0 却新学 100」的自相矛盾。 */
    let target = 0;
    try { target = window.Review.status().limit || 0; } catch (e) { target = 0; }

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
            ? '待背 ' + fmtNum(remaining) + ' 词 · 每日新学约 ' + fmtNum(target) + ' 词'
            : '加油' })
      ])
    ]));

    /* --- 进度（分母都是整本词表）---
       「覆盖」= 真正学过的词（已激活的 L1/L2）+ 本来就会的 L3 熟词；只普查建档、
       还没开始学的生词不算，推满 = 整本词表都过完，这是主进度。
       「脱离生词」= 当前在 L2 眼熟 / L3 熟词档的词。
       两条之差就是还卡在 L1 生词档、需要最密集复习的硬骨头。 */
    const rows = [
      { label: '已学一遍 · 覆盖',      n: rounds[0], strong: true },
      { label: '已脱离生词 · 眼熟+熟词', n: rounds[1] }
    ];
    const body = el('div', { class: 'sprint-rounds' });
    rows.forEach(function (r) {
      const pct = total ? Math.min(100, r.n / total * 100) : 0;
      body.appendChild(el('div', { class: 'sprint-round' + (r.strong ? ' sprint-round--main' : '') }, [
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

    box.appendChild(el('p', { class: 'sprint-note', text:
      '两条进度之差 = 还停在「生词」档、需要隔天密集复习的词。生词连对 3 次会升入眼熟，' +
      '眼熟再连对升入熟词速过池 —— 第二条涨上去，才是真正记牢了。' }));

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
        hint: '只看单词、凭第一印象在「生词 / 眼熟」中二选一。太简单的词先归眼熟，' +
              '之后连续答对会自动升入熟词速过池，不用在这里纠结。',
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
          secondary: true, urgent: true
        }));
      }
    } else {
      if (rev.totalToday > 0) {
        let revHint = null;
        if (rev.deferredBacklog > 0) {
          const per = rev.reviewCap === null ? rev.backlog : rev.reviewCap;
          const msg = '往日还有 ' + fmtNum(rev.deferredBacklog) + ' 个积压已顺延，' +
            '按每天约 ' + per + ' 个的节奏，约 ' + rev.backlogDays + ' 天清完（设置里可调每日复习上限）。';
          revHint = revHint ? revHint + ' ' + msg : msg;
        }
        box.appendChild(actionCard({
          kicker: '阶段二 · 复习',
          title: '今天有 ' + rev.totalToday + ' 个词要过',
          desc: '到期复习 ' + rev.due + ' 个 · 新学 ' + rev.newToStudy + ' 个',
          hint: revHint,
          btn: '开始复习',
          onclick: function () { go('review'); },
          urgent: true
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

    /* --- 熟词速过（独立模式，只处理 L3 熟词池，不占每日复习量） --- */
    const rapid = window.Rapid.status();
    box.appendChild(actionCard({
      kicker: '熟词速过',
      title: rapid.total ? ('速过熟词 · ' + rapid.total + ' 个待过') : '熟词速过池',
      desc: rapid.total
        ? ('原熟词 ' + rapid.legacy + ' · 新晋级 ' + rapid.promoted +
           (rapid.archived ? ' · 已设永不复习 ' + rapid.archived : ''))
        : '「眼熟」的词连续答对后会自动升进这里，可快速过，也能整屏勾选设为永不复习。',
      hint: rapid.total
        ? '认识就拉长间隔、不认识打回眼熟；也可以批量把过于简单的熟词设为永不复习。'
        : null,
      btn: '进入速过',
      onclick: function () { go('rapid'); },
      secondary: true
    }));

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
    const card = el('section', {
      class: 'action-card' + (o.secondary ? ' action-card--sec' : '') +
             (o.urgent ? ' action-card--urgent' : '')
    }, [
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
      { v: '3',    t: 'L3 熟词（速过池）' },
      { v: 'archived', t: '永不复习' },
      { v: 'none', t: '未分类' },
      { v: 'due',  t: '今天到期' },
      { v: 'weak', t: '薄弱词（错≥2 或近30天掉级）' }
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

      // 薄弱词筛选只算一次，构造成 Set 供每行 O(1) 判断
      const weakSet = bookState.level === 'weak'
        ? new Set(E.weakWords(st.cards, 30).map(function (x) { return x.word; }))
        : null;

      const rows = all.filter(function (entry) {
        const card = st.cards[entry.word];
        const lvl = bookState.level;
        if (lvl === 'none') { if (card) return false; }
        else if (lvl === 'archived') { if (!card || !card.archived) return false; }
        else if (lvl === 'due') { if (!card || !E.isDue(card, today)) return false; }
        else if (lvl === 'weak') { if (!weakSet.has(entry.word)) return false; }
        else if (lvl === 'all') { if (card && card.archived) return false; }
        else { if (!card || card.archived || String(card.level) !== lvl) return false; }

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
        if (bookState.level === 'archived') {
          const bulk = el('div', { class: 'bulk' }, [el('span', { text: '对这 ' + rows.length + ' 个词' })]);
          bulk.appendChild(el('button', {
            class: 'btn btn--sm', type: 'button', text: '取消永不复习',
            onclick: function () { bulkUnarchive(rows, refresh); }
          }));
          head.appendChild(bulk);
        } else {
          const bulk = el('div', { class: 'bulk' }, [el('span', { text: '把这 ' + rows.length + ' 个词全部改为' })]);
          [1, 2, 3].forEach(function (lv) {
            bulk.appendChild(el('button', {
              class: 'lv-pill lv-pill--' + lv, type: 'button', text: E.LEVELS[lv].name,
              onclick: function () { bulkSet(rows, lv, refresh); }
            }));
          });
          bulk.appendChild(el('button', {
            class: 'btn btn--sm btn--ghost', type: 'button', text: '永不复习',
            onclick: function () { bulkArchive(rows, refresh); }
          }));
          head.appendChild(bulk);
        }
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

    /* 单词本管理（建/改名/删本、查看与移出收藏） */
    if (window.NotebookUI) {
      box.appendChild(el('div', { class: 'chart-card nb-manage' }, [
        el('h3', { class: 'chart-head', text: '单词本管理' }),
        window.NotebookUI.panel()
      ]));
    }
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
      (card && card.archived)
        ? el('span', { class: 'lv-chip lv-chip--archived', text: '永不复习' })
        : card
          ? el('span', { class: 'lv-chip lv-chip--' + card.level, text: E.LEVELS[card.level].name +
              (card.level === 3 ? '·' + ((card.l3Origin || 'legacy') === 'promoted' ? '晋级' : '原熟') : '') })
          : el('span', { class: 'lv-chip lv-chip--none', text: '未分类' }),
      el('span', { class: 'w-due', text: (card && card.active && !card.archived) ? dueText(card) : '' })
    ]);
    li.appendChild(main);

    if (open) {
      const detail = el('div', { class: 'word-detail' });
      // 词书页是「查」而不是「背」，不赶时间，真题原句全给
      detail.appendChild(window.DefsView.render(entry, { compact: false, citeLimit: 3 }));

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

      const tools2 = el('div', { class: 'row-tools' });
      if (window.NotebookUI) {
        tools2.appendChild(el('button', {
          class: 'btn btn--sm', type: 'button', text: '加入单词本…',
          onclick: function () { window.NotebookUI.openPicker(entry.word); }
        }));
      }
      if (card) {
        if (card.archived) {
          tools2.appendChild(el('button', {
            class: 'btn btn--sm', type: 'button', text: '取消永不复习',
            onclick: function () {
              E.unarchive(card);
              S.save(); S.snapshotLevels(E.levelCounts(S.get().cards));
              window.UI.toast(entry.word + ' 已恢复，会重新参与复习', 'good');
              refresh();
            }
          }));
        } else {
          tools2.appendChild(el('button', {
            class: 'btn btn--sm btn--ghost', type: 'button', text: '设为永不复习',
            onclick: function () {
              E.archive(card);
              S.save(); S.snapshotLevels(E.levelCounts(S.get().cards));
              window.UI.toast(entry.word + ' 已设为永不复习', 'info');
              refresh();
            }
          }));
        }
      }
      detail.appendChild(tools2);

      const inNbs = S.notebooksOfWord(entry.word);
      if (inNbs.length) {
        detail.appendChild(el('p', { class: 'muted word-nbs',
          text: '所在单词本：' + inNbs.map(function (n) { return n.name; }).join('、') }));
      }
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

  function bulkArchive(rows, refresh) {
    window.UI.confirmDialog({
      title: '批量设为永不复习',
      body: '把当前筛选出的 <b>' + rows.length + '</b> 个词设为永不复习？<br><br>' +
            '<span class="muted">它们会从所有复习与速过中移除，单词和进度保留，可在此筛选「永不复习」恢复。</span>',
      okText: '设为永不复习'
    }).then(function (ok) {
      if (!ok) return;
      const st = S.get();
      let n = 0;
      rows.forEach(function (entry) {
        const c = st.cards[entry.word];
        if (c && !c.archived) { E.archive(c); n++; }
      });
      S.save();
      S.snapshotLevels(E.levelCounts(st.cards));
      window.UI.toast('已将 ' + n + ' 个词设为永不复习', 'good');
      refresh();
    });
  }

  function bulkUnarchive(rows, refresh) {
    const st = S.get();
    let n = 0;
    rows.forEach(function (entry) {
      const c = st.cards[entry.word];
      if (c && c.archived) { E.unarchive(c); n++; }
    });
    S.save();
    S.snapshotLevels(E.levelCounts(st.cards));
    window.UI.toast('已恢复 ' + n + ' 个词，它们会重新参与复习', 'good');
    refresh();
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

    // 薄弱词本：只在确实有薄弱词时出现，最多列 Top20，可切表格
    const weak = E.weakWords(st.cards, 30).slice(0, 20);
    if (weak.length) box.appendChild(window.Charts.weakTop(weak));

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
    }, '开启后按「整本词表剩余 ÷ 剩余天数」动态算每日新词，考前自动留 10 天纯复习。' +
       '注意：动态量只会在赶进度时比下面的保底更多，绝不会更少 —— 复习再多也不会把新词压没。'));

    g1.appendChild(numberField('每日新词保底量', s.dailyNew, 0, 500, function (v) {
      s.dailyNew = v; S.save();
    }, '每天至少投放多少个没学过的词。到期复习的词不受这个限制。' +
       '自动节奏开启时它是【保底】：想多背就把它调大（如 40、50），新词不会再被压到每天十几个。'));

    g1.appendChild(numberField('每日复习上限', s.dailyReviewCap, -1, 1000, function (v) {
      s.dailyReviewCap = v; S.save();
    }, '只限制每天再消化多少个【往日积压】，今天新到期的词不受限，断更几天也不用一次还几百个。' +
       '0 = 自动（按近两周复习量的 1.5 倍动态定，没历史时不限）；-1 = 不限制；正数 = 每天固定上限。'));

    g1.appendChild(quotaField(s));

    g1.appendChild(numberField('普查每批词数', s.triageBatch, 10, 500, function (v) {
      s.triageBatch = v; S.save();
    }, '普查时每过多少个词给一次小结，可以顺势休息。'));

    g1.appendChild(rangeField('选择题比例', s.quizRatio, function (v) {
      s.quizRatio = v; S.save();
    }, '0 = 全部用翻卡自评，1 = 尽量出选择题。只作用于生词/眼熟两类的主复习。'));
    box.appendChild(g1);

    /* --- 流程 --- */
    const g2 = group('流程');
    g2.appendChild(checkField('普查未完成也可以复习', s.reviewBeforeTriageDone, function (v) {
      s.reviewBeforeTriageDone = v; S.save();
    }, '默认关闭 —— 按你的设定，全部分类完再开始复习。' +
       '整本词表普查要几个小时，中途想先复习已分类的部分就打开它。'));

    g2.appendChild(checkField('出现单词时自动朗读', s.autoSpeak, function (v) {
      s.autoSpeak = v; S.save();
    }, window.Speak.available() ? null : '当前浏览器不支持语音合成，这个开关不会生效。'));

    g2.appendChild(field('发音口音', select('发音口音', s.accent || 'us', [
      { v: 'us', t: '美音（en-US）' },
      { v: 'gb', t: '英音（en-GB）' }
    ], function (v) {
      s.accent = v; S.save();
      window.Speak.setAccent(v);
      window.Speak.say('pronunciation');
    }), window.Speak.available() ? null : '当前浏览器不支持语音合成。'));

    g2.appendChild(checkField('单词用在线真人发音（推荐）', s.onlineVoice !== false, function (v) {
      s.onlineVoice = v; S.save();
    }, '开启后点单词喇叭优先播放词典真人录音（需联网，国内可直连，最清晰）；'
       + '关闭或断网时自动改用浏览器系统语音。整条例句朗读始终用系统语音。'));
    box.appendChild(g2);

    /* --- 复习提醒 --- */
    const gR = group('复习提醒');
    gR.appendChild(el('p', { class: 'field-note', text:
      '到点若今天还有单词没复习，就弹一条系统通知（需要网页或「添加到主屏幕」的应用开着/挂在后台）。' +
      '想在网页完全关闭时也能被提醒，用最下面的「每日日历提醒」，导入系统日历后由平板/手机系统定点通知。' }));

    gR.appendChild(checkField('开启每日复习提醒', s.remindEnabled === true, function (v) {
      s.remindEnabled = v;
      if (v) s.remindLastDate = null;
      S.save();
      if (v && window.Remind) {
        window.Remind.request(function (perm) {
          if (perm === 'granted') { window.Remind.tick(); window.UI.toast('已开启，每天 ' + S.get().settings.remindTime + ' 提醒', 'good'); }
          else if (perm === 'unsupported') window.UI.toast('当前环境不支持系统通知（本地双击打开时如此），请用日历提醒', 'warn', 5000);
          else window.UI.toast('通知权限未允许，请到浏览器/系统设置里允许通知', 'warn', 5000);
          render();
        });
      }
    }));

    const timeInput = el('input', { class: 'input', type: 'time', value: s.remindTime || '20:00' });
    timeInput.addEventListener('change', function () {
      s.remindTime = timeInput.value || '20:00';
      s.remindLastDate = null; S.save();
      if (window.Remind) window.Remind.tick();
    });
    gR.appendChild(field('每日提醒时间', timeInput,
      '只在这个时间之后、且今天还有单词没复习时弹，每天最多一条。'));

    const remindRow = el('div', { class: 'btn-row' }, [
      el('button', { class: 'btn', type: 'button', text: '发一条测试通知', onclick: function () {
        if (!window.Remind) return;
        window.Remind.test(function (p) {
          window.UI.toast(p === 'granted' ? '已发送，请看系统通知中心'
            : (p === 'unsupported' ? '当前环境不支持系统通知' : '没拿到通知权限：' + p), 'info', 4500);
        });
      }})
    ]);
    gR.appendChild(remindRow);

    if (window.Remind) {
      const pm = { granted: '已允许', denied: '已被拒绝（需到系统设置改）', default: '还没决定', unsupported: '当前环境不支持' };
      gR.appendChild(el('p', { class: 'field-note',
        text: '系统通知权限：' + (pm[window.Remind.permission()] || window.Remind.permission()) }));
    }

    gR.appendChild(el('div', { class: 'btn-row' }, [
      el('button', { class: 'btn', type: 'button', text: '下载每日日历提醒（关网页也能响）', onclick: function () {
        if (!window.Remind) return;
        window.Remind.downloadCalendar(S.get().settings.remindTime || '20:00');
        window.UI.toast('已下载 .ics：在平板上点开、导入「日历」即可每天定点提醒', 'good', 5500);
      }})
    ]));
    box.appendChild(gR);

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

    /* 上次导出时间 + 备份到期轻提醒（每 7 天或每多分类 500 个词提醒一次）。
       程序每次写入还会在本地留一份上一版自动快照，但那只防写坏、不防手动清数据。 */
    const advice = S.backupAdvice();
    g4.appendChild(el('p', {
      class: 'field-note' + (advice.level === 'warn' ? ' field-note--warn' : ''),
      text: advice.lastExportAt
        ? '上次导出备份：' + advice.lastExportAt + '（' + fmtNum(advice.lastExportCount) +
          ' 个词）。' + (advice.reason || '备份状态良好。')
        : (advice.reason || '还没有导出过备份。')
    }));

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
    dataRow.appendChild(el('button', {
      class: 'btn btn--ghost', type: 'button', text: '导出学习记录 CSV',
      title: '把每天的新学/复习/正确率导出成表格，Excel 可直接打开，不影响备份',
      onclick: doExportCSV
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

    /* --- 更新与关于：让用户能一眼判断平板是不是新版，并能一键自救旧缓存 --- */
    const gU = group('更新与关于');
    gU.appendChild(el('dl', { class: 'meta-list' }, [
      el('dt', { text: '当前版本' }), el('dd', { text: APP_VERSION })
    ]));
    gU.appendChild(el('p', { class: 'field-note', text:
      '默认每次打开、每次从后台切回都会自动检查最新版。若手机/平板看起来仍是旧版，' +
      '点下面按钮清掉这台设备的离线缓存并强制刷新到最新（不会动你的学习记录）。' }));
    gU.appendChild(el('div', { class: 'btn-row' }, [
      el('button', { class: 'btn', type: 'button', text: '检查并更新到最新版', onclick: forceUpdate })
    ]));
    box.appendChild(gU);

    return box;
  }

  /* 一键强制更新：让 SW 立即接管新版本 + 删掉本应用的离线缓存 + 硬刷新。
     这是「平板怎么刷都是旧版」时的用户侧兜底，不依赖自动更新时序。 */
  async function forceUpdate() {
    window.UI.toast('正在清理本机缓存并检查更新…', 'info');
    try {
      if ('serviceWorker' in navigator) {
        try {
          const regs = await navigator.serviceWorker.getRegistrations();
          for (const r of regs) {
            try {
              await r.update();
              if (r.waiting) r.waiting.postMessage({ type: 'SKIP_WAITING' });
            } catch (e) {}
          }
        } catch (e) {}
      }
      if (window.caches) {
        try {
          const keys = await window.caches.keys();
          await Promise.all(keys.filter(function (k) {
            return k.indexOf('kaoyan-vocab-') === 0;
          }).map(function (k) { return window.caches.delete(k); }));
        } catch (e) {}
      }
    } finally {
      setTimeout(function () {
        try { sessionStorage.removeItem('kv_sw_reloaded'); } catch (e) {}
        location.reload();
      }, 600);
    }
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
    /* 主复习只有 L1/L2，配额也只放这两个；L3 熟词在独立的速过模式里处理 */
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
      '每日新词按这个比例分给生词和眼熟。熟词不在主复习里 —— ' +
      '眼熟词连续答对后会自动升入「熟词速过池」，在首页的熟词速过模式里单独快速过，' +
      '或整屏勾选设为永不复习。');
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
      // 记下本次导出时间/词数，供设置页状态行与到期提醒使用，并重绘当前页刷新状态
      S.markExported();
      window.UI.toast('备份已导出', 'good');
      render();
    } catch (e) {
      console.error(e);
      window.UI.toast('导出失败：' + e.message, 'warn', 5000);
    }
  }

  /* 导出每日学习记录 CSV（只含统计、不含完整卡片，故不更新备份时间戳） */
  function doExportCSV() {
    try {
      const text = S.toCSV();
      const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
      const url  = URL.createObjectURL(blob);
      const a = el('a', { href: url, download: 'study-log-' + S.today() + '.csv' });
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
      window.UI.toast('学习记录 CSV 已导出', 'good');
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
    window.Speak.setAccent(S.get().settings.accent || 'us');
    if (window.Remind) window.Remind.start();
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

    /* 主档损坏并从自动备份回滚时，明确告知一次（不静默兜底，也不直接丢成空档） */
    const loadNotice = S.consumeNotice();
    if (loadNotice) window.UI.toast(loadNotice.message, 'warn', 9000);

    renderNav();
    render();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
