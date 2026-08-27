/* ===========================================================================
 *  review.js —— 每日队列 + 三种练习模式
 * ---------------------------------------------------------------------------
 *  队列 = 到期复习词（含往日积压） + 按 L1:L2:L3 配额投放的新词，三类交错。
 *
 *  L3 熟词不进当天的学习队列：普查阶段的强制核对已经验证过一次，
 *  它们直接排到 20 天后巡检。配额对 L3 的意义只是把到期日摊开，
 *  否则 20 天后会集中爆量。
 * =========================================================================== */

window.Review = (function () {
  'use strict';

  const el = window.UI.el;
  const S  = window.Store;
  const E  = window.Engine;

  let host = null;
  let onExit = null;
  let sess = null;

  /* ---------------------------------------------------------------- 配额分配 */

  /* 把 budget 个名额按 quota 比例分给三类，受各类可用量 avail 限制，
     余量按配额从高到低轮流补足，不浪费名额。 */
  function allocate(budget, quota, avail) {
    const q  = quota.map(function (x) { return Math.max(0, x || 0); });
    const qs = q.reduce(function (a, b) { return a + b; }, 0) || 1;
    const out = [0, 0, 0];
    let remaining = budget;

    for (let i = 0; i < 3; i++) {
      const want = Math.min(avail[i], Math.floor(budget * q[i] / qs));
      out[i] = want;
      remaining -= want;
    }
    const order = [0, 1, 2].sort(function (a, b) { return q[b] - q[a]; });
    let guard = 0;
    while (remaining > 0 && guard++ < budget + 10) {
      let placed = false;
      for (let k = 0; k < order.length && remaining > 0; k++) {
        const i = order[k];
        if (out[i] < avail[i]) { out[i]++; remaining--; placed = true; }
      }
      if (!placed) break;
    }
    return out;
  }

  /* ---------------------------------------------------------------- 建队列 */

  function buildQueue() {
    const st    = S.get();
    const cards = st.cards;
    const today = S.today();

    /* 默认「普查全部做完才开始复习」。入口按钮已经按这个规则隐藏，
       这里再挡一道，免得从别的路径绕进来直接开背。 */
    if (!st.settings.reviewBeforeTriageDone && !window.Triage.status().complete) {
      return { queue: [], dueCount: 0, newCount: 0, l3Scheduled: 0 };
    }

    const dueItems = [];
    const freshByLevel = [[], [], []];

    Object.keys(cards).forEach(function (w) {
      const c = cards[w];
      const entry = window.WB.get(w);
      // 词库换过之后可能有卡片对应不上词条 —— 跳过但不删卡片，
      // 万一将来换回去或补全词库，进度还在
      if (!entry) return;
      if (c.active) {
        if (E.isDue(c, today)) {
          dueItems.push({ word: w, card: c, entry: entry, isNew: false });
        }
      } else if (c.level >= 1 && c.level <= 3) {
        freshByLevel[c.level - 1].push(w);
      }
    });

    /* 新投放预算：今日上限减去今天已投放的 */
    const limit  = Math.max(0, st.settings.dailyNew | 0);
    const used   = S.getDaily().new || 0;
    const budget = Math.max(0, limit - used);

    freshByLevel.forEach(function (a) {
      a.sort(function (x, y) { return window.WB.indexOf(x) - window.WB.indexOf(y); });
    });

    /*
     * L3 熟词不占每日新词配额。
     *
     * 它们不进当天的学习队列（普查已强制核对过一次），投放成本是零，
     * 拿新词配额去限它们的速反而有害：按 6:3:1、每天 30 个新词算，
     * 熟词每天只能排 3 个 —— 两千个熟词要 666 天才排完队，考研都考完了。
     *
     * 根子在于配额是按「卡片数」分的，但成本完全不同：
     * 确认一个熟词两秒，啃一个生词十几秒，用同一把尺子量它们是错的。
     *
     * 改为一次性全部排期，把首次巡检日均摊到未来一段时间里。
     * 窗口按数量自适应（约每天 20 个，下限 20 天、上限 120 天）：
     * 两千个熟词摊到 100 天 = 每天 20 个巡检，两三分钟的事。
     */
    const l3Words = freshByLevel[2];
    let l3Scheduled = 0;
    if (l3Words.length) {
      const n   = l3Words.length;
      const win = Math.min(120, Math.max(E.LEVELS[3].initial, Math.ceil(n / 20)));
      l3Words.forEach(function (w, i) {
        E.activate(cards[w], 1 + Math.floor(i * win / n));
      });
      l3Scheduled = n;
      S.save();
    }

    /* 配额只在 L1/L2 之间分配：L3 可用量传 0，余量自动回流给 L1/L2，不浪费名额 */
    const alloc = allocate(budget, st.settings.quota,
                           [freshByLevel[0].length, freshByLevel[1].length, 0]);

    const newItems = [];
    for (let lv = 1; lv <= 2; lv++) {
      freshByLevel[lv - 1].slice(0, alloc[lv - 1]).forEach(function (w) {
        newItems.push({ word: w, card: cards[w], entry: window.WB.get(w), isNew: true });
      });
    }

    return { queue: interleave(dueItems.concat(newItems)),
             dueCount: dueItems.length,
             newCount: newItems.length,
             l3Scheduled: l3Scheduled,
             limit: limit,
             usedToday: used,
             budget: budget,
             unlearnedL12: freshByLevel[0].length + freshByLevel[1].length };
  }

  /* 三类交错：每次从剩余最多的那一类取一个，自然错开，
     避免连着几十个同类词的疲劳感 */
  function interleave(items) {
    const byLevel = [[], [], []];
    items.forEach(function (it) {
      const lv = Math.min(3, Math.max(1, it.card.level || 1));
      byLevel[lv - 1].push(it);
    });
    byLevel.forEach(function (a) { window.WB.shuffle(a); });

    const out = [];
    const idx = [0, 0, 0];
    const total = items.length;
    while (out.length < total) {
      let best = -1, rem = 0;
      for (let i = 0; i < 3; i++) {
        const r = byLevel[i].length - idx[i];
        if (r > rem) { rem = r; best = i; }
      }
      if (best < 0) break;
      out.push(byLevel[best][idx[best]++]);
    }
    return out;
  }

  /* ---------------------------------------------------------------- 练法选择 */

  function pickMode(card) {
    const ratio = S.get().settings.quizRatio;
    const r = Math.random();
    if (card.level === 1) return r < ratio ? 'quiz-zh2en' : 'flip';
    if (card.level === 2) return r < ratio ? 'quiz-en2zh' : 'flip';
    // L3 以翻卡巡检为主，选择题减半
    return r < ratio * 0.5 ? 'quiz-en2zh' : 'flip';
  }

  /* 出选择题。答案与干扰项都只用「常考义」——
     生僻义永不作为答案或干扰项，否则等于拿用不上的东西考人。 */
  function makeQuiz(item, mode) {
    const entry = item.entry;
    const ds = window.WB.distractors(entry, 3, function (cand) {
      return window.WB.studyDefs(cand).length > 0;
    });
    if (ds.length < 2) return null;   // 词库太小，退回翻卡

    const options = ds.map(function (d) {
      return { entry: d, correct: false };
    });
    options.push({ entry: entry, correct: true });
    window.WB.shuffle(options);

    return {
      mode: mode,
      prompt: mode === 'quiz-en2zh' ? entry.word : window.WB.shortDef(entry, 40),
      options: options.map(function (o) {
        return {
          text: mode === 'quiz-en2zh' ? window.WB.shortDef(o.entry, 40) : o.entry.word,
          correct: o.correct
        };
      }),
      chosen: -1
    };
  }

  /* ---------------------------------------------------------------- 会话 */

  function newSession() {
    const built = buildQueue();
    return {
      queue: built.queue,
      pos: 0,
      dueCount: built.dueCount,
      newCount: built.newCount,
      l3Scheduled: built.l3Scheduled,
      limit: built.limit,
      usedToday: built.usedToday,
      budget: built.budget,
      unlearnedL12: built.unlearnedL12,
      stage: 'front',        // front | back | answered | upgrade | finished
      quiz: null,
      mode: null,
      pendingUpgrade: null,
      startedAt: Date.now(),
      stats: { done: 0, correct: 0, wrong: 0, downgrades: 0, upgrades: 0,
               combo: 0, maxCombo: 0 }
    };
  }

  /* 临时把今日新词上限往上抬，用于「今天还想多背点」的情况 */
  function raiseLimit(n) {
    const s = S.get().settings;
    s.dailyNew = Math.min(500, (s.dailyNew | 0) + n);
    S.save();
    sess = newSession();
    prepare();
    render();
  }

  function currentItem() {
    return sess.queue[sess.pos] || null;
  }

  function prepare() {
    const it = currentItem();
    if (!it) { sess.stage = 'finished'; return; }
    let mode = pickMode(it.card);
    let quiz = null;
    if (mode !== 'flip') {
      quiz = makeQuiz(it, mode);
      if (!quiz) mode = 'flip';
    }
    sess.mode  = mode;
    sess.quiz  = quiz;
    sess.stage = 'front';
  }

  function advance() {
    sess.pos++;
    sess.pendingUpgrade = null;
    if (sess.pos >= sess.queue.length) {
      sess.stage = 'finished';
      flushTime();
    } else {
      prepare();
    }
    render();
  }

  function flushTime() {
    const secs = Math.round((Date.now() - sess.startedAt) / 1000);
    if (secs > 0 && secs < 6 * 3600) S.bump('seconds', secs);
    sess.startedAt = Date.now();
  }

  function snapshot() {
    S.snapshotLevels(E.levelCounts(S.get().cards));
  }

  /* ---------------------------------------------------------------- 评分 */

  /*
   * 评分特效。
   *
   * 【调用时机很关键】必须在 doGrade 走到 render() 之前调用 ——
   * 特效要读 srcEl 的屏幕坐标来定位烟花，而 render() 会把整个
   * host 清空重建，那之后 srcEl 已经脱离文档，getBoundingClientRect
   * 返回全 0，粒子会全部堆在屏幕左上角。
   */
  function gradeFx(g, srcEl) {
    const FX = window.FX;
    if (!FX || FX.off) return;
    const target = srcEl || host;

    if (g === 'again') {
      FX.flash('bad');
      FX.shake(host && host.querySelector('.card'));
      FX.popText(target, '再来', 'bad');
      return;
    }
    const easy = (g === 'easy');
    FX.burst(target, {
      kind: easy ? 'great' : 'good',
      count: easy ? 26 : 16,
      power: easy ? 125 : 88
    });
    FX.ring(target, easy ? 'great' : 'good');
    FX.popText(target, easy ? '秒了' : '+1', easy ? 'gold' : 'good');
  }

  /* 连击提示。3 连起步 —— 每答对一次就弹会非常吵，
     而低于 3 连也谈不上「连击」。每 10 连额外给一次全屏金光。 */
  function comboFx() {
    const FX = window.FX;
    if (!FX || FX.off) return;
    const n = sess.stats.combo;
    if (n < 3) return;
    FX.combo(n);
    if (n % 10 === 0) FX.flash('gold');
  }

  function doGrade(g, srcEl, silent) {
    const it = currentItem();
    if (!it) return;

    /* silent 用于选择题：对错反馈在作答那一刻就放过了（quizFx），
       结算时再放一次会变成重复的双响炮。连击数字仍然照常弹。 */
    if (!silent) gradeFx(g, srcEl);   // ← 必须在 render() 之前，理由见上

    const wasNew = !it.card.active;
    const res = E.grade(it.card, g, it.word);

    S.bump(wasNew ? 'new' : 'review', 1);
    S.bump('total', 1);
    if (g !== 'again') {
      S.bump('correct', 1);
      sess.stats.correct++;
      sess.stats.combo++;
      if (sess.stats.combo > sess.stats.maxCombo) sess.stats.maxCombo = sess.stats.combo;
    } else {
      sess.stats.wrong++;
      sess.stats.combo = 0;    // 断连
    }
    sess.stats.done++;
    S.save();
    snapshot();
    comboFx();

    let hasUpgrade = false;
    res.events.forEach(function (ev) {
      if (ev.type === 'downgrade') {
        sess.stats.downgrades++;
        window.UI.toast(
          it.word + '：' + E.LEVELS[ev.from].name + ' → ' + E.LEVELS[ev.to].name +
          '（' + ev.reason + '）', 'warn', 4200);
      } else if (ev.type === 'upgrade-prompt') {
        hasUpgrade = true;
        sess.pendingUpgrade = { word: it.word, card: it.card, from: ev.from, to: ev.to };
      }
    });

    if (hasUpgrade) { sess.stage = 'upgrade'; render(); }
    else advance();
  }

  /* ---------------------------------------------------------------- 渲染 */

  /*
   * 入场动画只在【换词】时播。
   *
   * render() 被调用的时机远不止换词：翻面、改类别、答题反馈都会全量重绘。
   * 如果每次重绘都播一遍入场，界面会一直在闪。所以记住上次播过的队列下标，
   * 只有下标真的变了才播。
   */
  let lastEnterPos = -1;

  function render() {
    if (!host) return;
    window.UI.clear(host);

    if (sess.stage === 'finished') {
      const v = viewFinished();
      host.appendChild(v);
      if (window.FX) window.FX.enter(v, { dy: 20 });
      return;
    }
    if (!sess.queue.length) {
      const v = viewNothing();
      host.appendChild(v);
      if (window.FX) window.FX.enter(v, { dy: 20 });
      return;
    }

    host.appendChild(topBar());

    const stage = el('div', { class: 'review-stage' });
    host.appendChild(stage);

    if (sess.stage === 'upgrade') {
      const v = viewUpgrade();
      stage.appendChild(v);
      if (window.FX) window.FX.enter(v, { dy: 0, scale: .92, duration: 340 });
      return;
    }

    const it = currentItem();
    if (!it) { sess.stage = 'finished'; render(); return; }

    const node = (sess.mode === 'flip') ? viewFlip(it) : viewQuiz(it);
    stage.appendChild(node);

    if (window.FX && sess.pos !== lastEnterPos) {
      lastEnterPos = sess.pos;
      window.FX.enter(node, { dy: 18 });
    }
  }

  function topBar() {
    const total = sess.queue.length;
    const pct = total ? (sess.pos / total * 100) : 0;
    const it = currentItem();
    return el('div', { class: 'review-top' }, [
      el('div', { class: 'progress' }, [
        el('div', { class: 'progress-fill', style: 'width:' + pct.toFixed(2) + '%' })
      ]),
      el('div', { class: 'review-meta' }, [
        el('span', { text: (sess.pos + 1) + ' / ' + total }),
        it ? el('span', { class: 'lv-chip lv-chip--' + it.card.level,
                          text: E.LEVELS[it.card.level].name }) : null,
        it && it.isNew ? el('span', { class: 'new-chip', text: '新词' }) : null,
        /* 连击常驻显示，和弹出的大数字互补：弹出的一闪而过，这里能随时瞄一眼 */
        sess.stats.combo >= 3
          ? el('span', { class: 'combo-chip', title: '连续答对 ' + sess.stats.combo + ' 个' }, [
              el('span', { class: 'combo-flame', text: '🔥' }),
              el('span', { text: String(sess.stats.combo) })
            ])
          : null,
        el('button', { class: 'btn btn--ghost btn--sm', type: 'button', text: '结束本次',
                       onclick: function () { flushTime(); sess.stage = 'finished'; render(); } })
      ])
    ]);
  }

  /* --- 翻卡自评 --- */
  function viewFlip(it) {
    const box = el('div', { class: 'card' });
    box.appendChild(window.DefsView.head(it.entry, { big: true }));

    if (sess.stage === 'front') {
      box.appendChild(el('p', { class: 'card-hint', text: '先自己回想一下意思' }));
      box.appendChild(el('div', { class: 'card-actions' }, [
        el('button', {
          class: 'btn btn--primary btn--wide', type: 'button',
          onclick: reveal
        }, [el('span', { text: '显示释义' }), el('kbd', { text: 'Space' })])
      ]));
    } else {
      box.appendChild(window.DefsView.render(it.entry, {
        showRare: S.get().settings.showRareDefs
      }));
      box.appendChild(gradeButtons(it));
      box.appendChild(levelSwitch(it));
    }
    return box;
  }

  /*
   * 翻面。
   *
   * FX.flip 保证 swap 回调恰好执行一次（reduced-motion / 动画不可用 / 抛异常
   * 都会立刻同步执行），所以这里不需要再写一遍降级分支 —— 见 fx.js 里
   * 「这个函数刻意不走 guard」那段注释。
   */
  function reveal() {
    const it = currentItem();
    const card = host && host.querySelector('.card');

    const swap = function () { sess.stage = 'back'; render(); };
    if (window.FX && window.FX.flip) window.FX.flip(card, swap);
    else swap();

    if (S.get().settings.autoSpeak && it) window.Speak.say(it.entry.word);
  }

  function gradeButtons(it) {
    const prev = E.preview(it.card);
    const defs = [
      { g: 'again', label: '忘记', cls: 'g-again' },
      { g: 'hard',  label: '困难', cls: 'g-hard'  },
      { g: 'good',  label: '认识', cls: 'g-good'  },
      { g: 'easy',  label: '简单', cls: 'g-easy'  }
    ];
    const row = el('div', { class: 'grade-row' });
    defs.forEach(function (d, i) {
      /* 先建节点再挂监听：特效需要按钮本身当坐标锚点，
         用 el() 的 onclick 简写拿不到这个引用 */
      const btn = el('button', { class: 'grade-btn ' + d.cls, type: 'button' }, [
        el('kbd', { text: String(i + 1) }),
        el('span', { class: 'grade-label', text: d.label }),
        el('small', { class: 'grade-next', text: fmtDays(prev[d.g]) })
      ]);
      btn.addEventListener('click', function () { doGrade(d.g, btn); });
      row.appendChild(btn);
    });
    return row;
  }

  function fmtDays(d) {
    if (d < 1) return '今天';
    if (d === 1) return '明天';
    if (d < 30) return d + ' 天后';
    const m = (d / 30);
    return (m % 1 === 0 ? m : m.toFixed(1)) + ' 个月后';
  }

  /* 手动改类别 */
  function levelSwitch(it) {
    const wrap = el('div', { class: 'lv-switch' }, [
      el('span', { class: 'lv-switch-label', text: '这个词归类为' })
    ]);
    [1, 2, 3].forEach(function (lv) {
      const active = it.card.level === lv;
      wrap.appendChild(el('button', {
        class: 'lv-pill lv-pill--' + lv + (active ? ' is-active' : ''),
        type: 'button', 'aria-pressed': active ? 'true' : 'false',
        onclick: function () {
          if (it.card.level === lv) return;
          E.manualSetLevel(it.card, lv);
          S.save(); snapshot();
          window.UI.toast(it.word + ' 已改为「' + E.LEVELS[lv].name + '」', 'info', 2200);
          render();
        }
      }, [el('span', { text: E.LEVELS[lv].name })]));
    });
    return wrap;
  }

  /* --- 选择题 --- */
  function viewQuiz(it) {
    const q = sess.quiz;
    const box = el('div', { class: 'card card--quiz' });

    box.appendChild(el('div', { class: 'quiz-kind',
      text: q.mode === 'quiz-en2zh' ? '看词选义' : '看义选词' }));

    if (q.mode === 'quiz-en2zh') {
      box.appendChild(window.DefsView.head(it.entry, { big: true }));
    } else {
      box.appendChild(el('div', { class: 'quiz-prompt-zh', text: q.prompt }));
    }

    const opts = el('div', { class: 'quiz-options' });
    q.options.forEach(function (o, i) {
      const answered = sess.stage === 'answered';
      let cls = 'quiz-opt';
      if (answered) {
        if (o.correct) cls += ' is-correct';
        else if (i === q.chosen) cls += ' is-wrong';
        else cls += ' is-dim';
      }
      opts.appendChild(el('button', {
        class: cls, type: 'button', disabled: answered,
        onclick: function () { answerQuiz(i); }
      }, [
        el('kbd', { text: String(i + 1) }),
        el('span', { class: 'opt-text', text: o.text })
      ]));
    });
    box.appendChild(opts);
    if (sess.stage === 'answered') {
      const right = q.options[q.chosen] && q.options[q.chosen].correct;
      box.appendChild(el('div', {
        class: 'quiz-verdict ' + (right ? 'is-right' : 'is-wrong'),
        text: right ? '答对了' : '答错了 —— 这个词已重新排进高频复习'
      }));
      box.appendChild(window.DefsView.render(it.entry, {
        showRare: S.get().settings.showRareDefs
      }));
      box.appendChild(el('div', { class: 'card-actions' }, [
        el('button', {
          class: 'btn btn--primary btn--wide', type: 'button',
          onclick: continueAfterQuiz
        }, [el('span', { text: '继续' }), el('kbd', { text: 'Space' })])
      ]));
      box.appendChild(levelSwitch(it));
    } else {
      box.appendChild(el('p', { class: 'keyhint', text: '按 1–4 选择' }));
    }
    return box;
  }

  /* 作答瞬间的对错反馈。选择题的对错在点下去那一刻就确定了，
     没必要等到「继续」结算才给反馈 —— 那样迟了一整个交互。 */
  function quizFx(right, btn) {
    const FX = window.FX;
    if (!FX || FX.off) return;
    const target = btn || host;
    if (right) {
      FX.burst(target, { kind: 'good', count: 18, power: 95 });
      FX.ring(target, 'good');
      FX.flash('good');
    } else {
      FX.flash('bad');
      FX.shake(host && host.querySelector('.card'));
    }
  }

  function answerQuiz(i) {
    if (sess.stage === 'answered') return;
    const q = sess.quiz;
    q.chosen = i;

    /* 同样要抢在 render() 之前取坐标。键盘作答时没有事件对象，
       就按下标从当前 DOM 里把那个选项按钮找回来当锚点。 */
    const btn = host ? host.querySelectorAll('.quiz-opt')[i] : null;
    quizFx(!!(q.options[i] && q.options[i].correct), btn);

    sess.stage = 'answered';
    const it = currentItem();
    if (S.get().settings.autoSpeak && it) window.Speak.say(it.entry.word);
    render();
  }

  /* 选择题的评分在「继续」时结算：答对 = 认识，答错 = 忘记。
     silent=true —— 对错的烟花在 answerQuiz 里已经放过了。 */
  function continueAfterQuiz() {
    const q = sess.quiz;
    const right = q.options[q.chosen] && q.options[q.chosen].correct;
    doGrade(right ? 'good' : 'again', null, true);
  }

  /* --- 升级确认 --- */
  function viewUpgrade() {
    const p = sess.pendingUpgrade;
    return el('div', { class: 'card card--upgrade' }, [
      el('h3', { text: '要给它升一级吗？' }),
      el('p', { class: 'upgrade-word', text: p.word }),
      el('p', { class: 'muted', text:
        '连续答对 ' + p.card.streak + ' 次，下次复习已排到 ' + p.card.interval +
        ' 天后。升为「' + E.LEVELS[p.to].name + '」后出现频率会明显降低。' }),
      el('div', { class: 'card-actions' }, [
        el('button', {
          class: 'btn btn--primary', type: 'button',
          text: '升为' + E.LEVELS[p.to].name,
          onclick: function (ev) {
            E.applyUpgrade(p.card, p.to);
            sess.stats.upgrades++;
            S.save(); snapshot();
            /* 升级是整个复习流程里最值得庆祝的一步 —— 从生词爬到熟词，
               给它最大的一发。同样要抢在 advance() 重绘之前取坐标。 */
            if (window.FX && !window.FX.off) {
              window.FX.burst(ev.currentTarget, { kind: 'gold', count: 34, power: 150 });
              window.FX.ring(ev.currentTarget, 'gold');
              window.FX.flash('gold');
              window.FX.popText(ev.currentTarget, 'LEVEL UP', 'gold');
            }
            window.UI.toast(p.word + ' 已升为「' + E.LEVELS[p.to].name + '」', 'good', 2600);
            advance();
          }
        }),
        el('button', {
          class: 'btn', type: 'button', text: '暂不，再练练',
          onclick: function () {
            S.snoozeUpgrade(p.word, 14);
            advance();
          }
        })
      ]),
      el('p', { class: 'keyhint', text: '选「暂不」后 14 天内不再问这个词' })
    ]);
  }

  /* 说清「为什么现在没词了」—— 是普查没做完、配额用完，还是真的都不到期。
     含糊的一句「今天没有要复习的词」会让人以为程序坏了。 */
  function statusExplain() {
    const st  = S.get();
    const tri = window.Triage.status();

    if (!tri.complete && !st.settings.reviewBeforeTriageDone) {
      return {
        kind: 'triage',
        title: '先把普查做完',
        lines: ['还有 ' + fmtNum(tri.remaining) + ' 个词没分类。按你的设定，普查全部完成后才开始复习。'],
        muted: ['想边分边背的话，去设置里打开「普查未完成也可复习」。']
      };
    }

    const lines = [], muted = [];
    const fc = E.forecast(st.cards, 8).slice(1).filter(function (d) { return d.count > 0; });
    const quotaUsedUp = sess.unlearnedL12 > 0 && sess.budget <= 0;

    if (quotaUsedUp) {
      lines.push('今天的新词配额已经用完：已投放 ' + sess.usedToday + ' / 上限 ' + sess.limit + ' 个。');
      lines.push('还有 ' + fmtNum(sess.unlearnedL12) + ' 个生词和眼熟词没进入复习循环。');
    } else if (sess.unlearnedL12 > 0) {
      lines.push('还有 ' + fmtNum(sess.unlearnedL12) + ' 个词没学，但今天该学的已经放完了。');
    } else {
      lines.push('所有词都已进入复习循环，等它们到期就行。');
    }

    if (fc.length) muted.push('下一批到期：' + fc[0].date + '，共 ' + fc[0].count + ' 个词。');
    else           muted.push('未来一周没有到期的词。');

    return { kind: quotaUsedUp ? 'quota' : 'clear', title: '今天该做的都做完了', lines: lines, muted: muted };
  }

  function fmtNum(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }

  /* --- 今日无事 --- */
  function viewNothing() {
    const ex  = statusExplain();
    const box = el('div', { class: 'empty-state' });

    box.appendChild(el('h2', { text: ex.title }));
    ex.lines.forEach(function (t) { box.appendChild(el('p', { text: t })); });
    ex.muted.forEach(function (t) { box.appendChild(el('p', { class: 'muted', text: t })); });

    const acts = el('div', { class: 'done-actions' });
    if (ex.kind === 'quota') {
      acts.appendChild(el('button', {
        class: 'btn btn--primary', type: 'button', text: '今天再多放 20 个新词',
        onclick: function () { raiseLimit(20); }
      }));
    }
    if (ex.kind === 'triage') {
      acts.appendChild(el('button', {
        class: 'btn btn--primary', type: 'button', text: '去继续普查',
        onclick: function () { if (onExit) onExit(); }
      }));
    }
    acts.appendChild(el('button', {
      class: 'btn', type: 'button', text: '返回首页',
      onclick: function () { if (onExit) onExit(); }
    }));
    box.appendChild(acts);
    return box;
  }

  /* --- 本次小结 --- */
  function viewFinished() {
    const s = sess.stats;
    const acc = s.done ? Math.round(s.correct / s.done * 100) : 0;
    const box = el('div', { class: 'triage-done' }, [
      el('h2', { text: s.done ? '本次完成' : '本次没有记录' })
    ]);

    if (s.done) {
      box.appendChild(el('ul', { class: 'tally tally--wide' }, [
        el('li', {}, [el('span', { text: '过词' }), el('strong', { text: String(s.done) })]),
        el('li', {}, [el('span', { text: '正确率' }), el('strong', { text: acc + '%' })]),
        el('li', {}, [el('span', { text: '最高连击' }), el('strong', { text: String(s.maxCombo) })]),
        el('li', {}, [el('span', { text: '答错' }), el('strong', { text: String(s.wrong) })]),
        el('li', {}, [el('span', { text: '降级' }), el('strong', { text: String(s.downgrades) })]),
        el('li', {}, [el('span', { text: '升级' }), el('strong', { text: String(s.upgrades) })])
      ]));
      if (s.downgrades) {
        box.appendChild(el('p', { class: 'muted', text:
          '有 ' + s.downgrades + ' 个词被降级 —— 这些正是你以为记住了、其实没记住的词，值得多看两眼。' }));
      }
    }
    if (sess.l3Scheduled) {
      box.appendChild(el('p', { class: 'muted', text:
        '另有 ' + fmtNum(sess.l3Scheduled) + ' 个熟词已排期，会在未来一段时间里陆续来做巡检，不占今天的量。' }));
    }

    /* 队列为什么是这个长度、接下来还能不能背 —— 直接写清楚 */
    const ex = statusExplain();
    if (ex.kind !== 'triage') {
      ex.lines.forEach(function (t) { box.appendChild(el('p', { class: 'muted', text: t })); });
    }

    const acts = el('div', { class: 'done-actions' });
    if (ex.kind === 'quota') {
      acts.appendChild(el('button', {
        class: 'btn btn--primary', type: 'button', text: '今天再多放 20 个新词',
        onclick: function () { raiseLimit(20); }
      }));
    } else {
      acts.appendChild(el('button', {
        class: 'btn btn--primary', type: 'button', text: '再来一轮',
        onclick: function () { sess = newSession(); prepare(); render(); }
      }));
    }
    acts.appendChild(el('button', {
      class: 'btn', type: 'button', text: '返回首页',
      onclick: function () { if (onExit) onExit(); }
    }));
    box.appendChild(acts);
    return box;
  }

  /* ---------------------------------------------------------------- 键盘 */

  function onKey(e) {
    if (!host || !host.isConnected || !sess) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;

    if (e.key === 's' || e.key === 'S') {
      const it = currentItem();
      if (it) { e.preventDefault(); window.Speak.say(it.entry.word); }
      return;
    }
    if (sess.stage === 'finished' || sess.stage === 'upgrade') return;

    if (sess.mode === 'flip') {
      if (sess.stage === 'front') {
        if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); reveal(); }
      } else if (sess.stage === 'back') {
        const i = ['1', '2', '3', '4'].indexOf(e.key);
        if (i >= 0) {
          e.preventDefault();
          // 用键盘评分时也让烟花从对应按钮上冒出来，位置和鼠标点击一致
          const btn = host ? host.querySelectorAll('.grade-btn')[i] : null;
          doGrade(E.GRADES[i], btn);
        }
      }
    } else {
      if (sess.stage === 'answered') {
        if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); continueAfterQuiz(); }
      } else {
        const i = ['1', '2', '3', '4'].indexOf(e.key);
        if (i >= 0 && sess.quiz && i < sess.quiz.options.length) {
          e.preventDefault();
          answerQuiz(i);
        }
      }
    }
  }

  /* ---------------------------------------------------------------- 生命周期 */

  function mount(container, opts) {
    host   = container;
    onExit = (opts && opts.onExit) || null;
    sess   = newSession();
    lastEnterPos = -1;      // 重新进入复习页时让第一张卡也播入场
    prepare();
    document.addEventListener('keydown', onKey);
    render();
  }

  function unmount() {
    document.removeEventListener('keydown', onKey);
    window.Speak.stop();
    if (sess) flushTime();
    host = null;
    sess = null;
  }

  /* 首页用：今天还有多少要做 */
  function status() {
    const st    = S.get();
    const cards = st.cards;
    const today = S.today();
    let due = 0, freshAvail = [0, 0, 0];

    Object.keys(cards).forEach(function (w) {
      const c = cards[w];
      if (!window.WB.get(w)) return;
      if (c.active) { if (E.isDue(c, today)) due++; }
      else if (c.level >= 1 && c.level <= 3) freshAvail[c.level - 1]++;
    });

    const limit  = Math.max(0, st.settings.dailyNew | 0);
    const used   = S.getDaily().new || 0;
    const budget = Math.max(0, limit - used);
    /* 配额只分给 L1/L2 —— L3 不占新词额度，进复习页时会一次性排期 */
    const alloc  = allocate(budget, st.settings.quota, [freshAvail[0], freshAvail[1], 0]);

    return {
      due: due,
      newL1: alloc[0], newL2: alloc[1], newL3: freshAvail[2],
      newToStudy: alloc[0] + alloc[1],
      totalToday: due + alloc[0] + alloc[1],
      unlearned: freshAvail[0] + freshAvail[1] + freshAvail[2],
      unlearnedL12: freshAvail[0] + freshAvail[1],
      limit: limit, usedToday: used, budget: budget
    };
  }

  return { mount: mount, unmount: unmount, status: status, allocate: allocate };
})();
