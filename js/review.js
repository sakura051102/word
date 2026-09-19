/* ===========================================================================
 *  review.js —— 主复习：每日队列 + 翻卡/选择题（v2，只跑 L1/L2）
 * ---------------------------------------------------------------------------
 *  队列 = 到期复习词（含往日积压，仅 L1/L2） + 按 L1:L2 配额投放的新词，两类交错。
 *  L3 熟词不进这里 —— 它们在独立的「熟词速过」模式（rapid.js）里处理。
 *
 *  结束口径（修「学满还一直冒卡」）：以【真实卡】为准。初始队列长度即 realTotal，
 *  每评分一张非重学卡 realDone+1；realDone 达 realTotal 立即结束，没轮到的
 *  again 当天重学副本直接丢弃（原卡已正式排到明天，不丢学习）。
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

  /* 把 budget 个名额按 quota 比例分给各类（主复习只有 L1/L2 两类），
     受各类可用量 avail 限制，余量按配额从高到低轮流补足，不浪费名额。 */
  function allocate(budget, quota, avail) {
    const n  = avail.length;
    const q  = avail.map(function (_, i) { return Math.max(0, (quota[i] || 0)); });
    const qs = q.reduce(function (a, b) { return a + b; }, 0) || 1;
    const out = avail.map(function () { return 0; });
    let remaining = budget;

    for (let i = 0; i < n; i++) {
      const want = Math.min(avail[i], Math.floor(budget * q[i] / qs));
      out[i] = want;
      remaining -= want;
    }
    const order = Array.from({ length: n }, function (_, i) { return i; })
                       .sort(function (a, b) { return q[b] - q[a]; });
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

  /*
   * 当天新词上限。
   *
   * 两种来源：
   *   1. 手动 dailyNew（默认）
   *   2. 自动节奏 —— 设了考试日期且开启 autoPace 时，按
   *      「剩余未学 L1+L2 ÷ 剩余有效天数」动态算，保证考前把 2400 个都投完。
   *      留 10 天考前缓冲：那几天只复习不学新词。
   *
   * buildQueue 和 status 都走这里，保证「首页显示的新词数」和
   * 「实际投放的新词数」永远一致，不会出现两个数字打架。
   */
  const EXAM_BUFFER_DAYS = 10;    // 考前这么多天起停止投新词，纯滚动复习
  const DAILY_CAPACITY_MIN = 40;  // 每天计划过词总量下限（新词+复习），约半小时学习量

  /*
   * autoPace 均摊用的「考前还要新学多少词」。
   * 关键：不能只数「已普查建档、尚未激活的 L1/L2 卡」—— 普查没做完时这个池子很小，
   * 均摊到剩余天数每天只剩几个新词（用户实测每天只投 10 个），且永远学不完。
   * 这里把【还没普查的词】按已普查部分中 L1/L2 的占比外推计入，让目标覆盖整本词表。
   * 实际投放仍只取已建档的待学卡（未普查词没法定级），所以普查没做完时首页会提示去普查。
   */
  function paceRemaining(st) {
    let fresh = 0, classified = 0, l12 = 0;
    Object.keys(st.cards).forEach(function (w) {
      const c = st.cards[w];
      if (!c || !window.WB.get(w) || c.archived) return;
      classified++;
      if (c.level === 1 || c.level === 2) {
        l12++;
        if (!c.active) fresh++;
      }
    });
    const total = window.WB.size();
    const unclassified = Math.max(0, total - classified);
    const ratio = classified ? l12 / classified : 0.9;
    return fresh + Math.round(unclassified * ratio);
  }

  function effectiveLimit(st, remainingL12) {
    let base;
    if (st.settings.autoPace && st.settings.examDate) {
      const daysLeft = S.daysBetween(S.today(), st.settings.examDate);
      if (daysLeft <= EXAM_BUFFER_DAYS) {
        // 临考缓冲期：新词清零，把时间全部让给到期复习，不再开新坑
        base = 0;
      } else if (daysLeft > 0) {
        const studyDays = daysLeft - EXAM_BUFFER_DAYS;
        // 不考虑复习时，剩余新词均摊到每个可学日的量
        const even = Math.ceil(remainingL12 / Math.max(1, studyDays));
        // 近期（至多 30 天）预测的日均到期复习量 —— 复习高峰要少排新词
        const horizon = Math.min(studyDays, 30);
        const fc = E.forecast(st.cards, horizon);
        let reviewSum = 0;
        fc.forEach(function (d) { reviewSum += d.count; });
        const avgReview = reviewSum / Math.max(1, horizon);
        // 每日总预算 = 均摊新词的两倍（给复习留出等量时间），下限 40；
        // 新词额度 = 预算 − 预计复习，且不超过均摊量（不提前透支），复习越重新词越少
        const capacity = Math.max(DAILY_CAPACITY_MIN, even * 2);
        base = Math.min(even, Math.round(capacity - avgReview));
        // 离缓冲期还远时别让复习把新词彻底压没，保证每天至少推进一点，否则学不完
        if (base <= 0 && remainingL12 > 0 && studyDays > 3) base = Math.min(even, 3);
        base = Math.max(0, base);
        // 手动「每日新词上限」是【保底】：自动节奏只会在考前需要赶进度时往上加，
        // 绝不会因为复习多就把新词压到用户设定值以下 —— 否则用户调 40 仍只投 10 个。
        // 但整本词表都学完（剩余 0）时不再硬投，保底只在「还有词要学」时生效。
        if (remainingL12 > 0) base = Math.max(base, Math.max(0, st.settings.dailyNew | 0));
      } else {
        base = Math.max(0, st.settings.dailyNew | 0);
      }
    } else {
      base = Math.max(0, st.settings.dailyNew | 0);
    }
    /* 「今天再多放 N 个」是当天一次性加量：记在 daily[今天].extraNew，
       不常驻改 dailyNew —— 否则 autoPace 会被手动加量顶掉，明天节奏就乱了。 */
    const extra = S.getDaily().extraNew || 0;
    return base + extra;
  }

  /*
   * 每天最多再消化多少个【往日积压】的复习词。
   * 今天新到期的词是节奏内产物，不在此限；这里只拦「之前攒下、一次性全压到今天」
   * 的逾期词，免得断了几天之后一打开要还几百个、直接劝退。
   *   正数 = 固定上限；-1 = 不限；0 = 自动（近 14 天日均复习量 ×1.5）。
   * 自动模式下若近两周完全没有复习记录（刚开始背）返回 null = 不限，
   * 否则 cap 会算成 0、反而一个积压都不放，把新用户彻底卡死。
   */
  function effectiveReviewCap(st) {
    const v = st.settings.dailyReviewCap;
    if (v === undefined || v === null) return null;
    if (v < 0) return null;
    if (v > 0) return Math.floor(v);
    let sum = 0;
    S.lastNDays(14).forEach(function (d) {
      const rec = st.daily[d];
      if (rec && rec.review) sum += rec.review;
    });
    if (sum === 0) return null;
    return Math.max(10, Math.ceil(sum / 14 * 1.5));
  }

  /*
   * 复习负载规划（纯读取，不改任何卡片）：把到期词拆成「今天新到期」和「往日积压」，
   * 积压按到期日从早到晚（欠最久的先还）排序，再按每日上限截取。
   * buildQueue（真正建队列）和 status（首页计数）都走这里，保证两处数字一致，
   * 不会出现首页说 200、进去只有 60 的打架情况。
   */
  function reviewPlan(st) {
    const today = S.today();
    const dueToday = [];
    const overdue = [];
    Object.keys(st.cards).forEach(function (w) {
      const c = st.cards[w];
      if (!c.active || c.archived || c.level === 3 || !window.WB.get(w)) return;
      if (!E.isDue(c, today)) return;
      if (c.due === today) dueToday.push(w);
      else overdue.push({ word: w, due: c.due });
    });
    overdue.sort(function (a, b) { return a.due < b.due ? -1 : a.due > b.due ? 1 : 0; });

    const cap = effectiveReviewCap(st);
    const picked = (cap === null) ? overdue.slice() : overdue.slice(0, cap);
    const perDay = cap === null ? Math.max(1, overdue.length) : Math.max(1, cap);
    const backlogDays = overdue.length === 0 ? 0
      : Math.max(1, Math.ceil(overdue.length / perDay));
    return {
      dueTodayWords: dueToday,
      pickedOverdue: picked,
      reviewDue: dueToday.length + picked.length,
      backlog: overdue.length,
      deferredBacklog: overdue.length - picked.length,
      cap: cap,
      backlogDays: backlogDays
    };
  }

  function buildQueue() {
    const st    = S.get();
    const cards = st.cards;

    /* 默认「普查全部做完才开始复习」。入口按钮已经按这个规则隐藏，
       这里再挡一道，免得从别的路径绕进来直接开背。 */
    if (!st.settings.reviewBeforeTriageDone && !window.Triage.status().complete) {
      return { queue: [], dueCount: 0, newCount: 0 };
    }

    // 主复习只投放 L1/L2 新词；L3 在速过模式、archived 永不复习，都不进队列
    const freshByLevel = [[], []];

    Object.keys(cards).forEach(function (w) {
      const c = cards[w];
      // 词库换过之后可能有卡片对应不上词条 —— 跳过但不删卡片，
      // 万一将来换回去或补全词库，进度还在
      if (!window.WB.get(w)) return;
      if (c.archived) return;
      if (!c.active && (c.level === 1 || c.level === 2)) {
        freshByLevel[c.level - 1].push(w);
      }
    });

    /* 到期复习词走统一规划：今天新到期的全放，往日积压按每日上限取「欠最久」的，
       其余顺延到之后几天，避免断更后一打开就要一次还几百个。 */
    const plan = reviewPlan(st);
    const dueItems = [];
    plan.pickedOverdue.forEach(function (p) {
      dueItems.push({ word: p.word, card: cards[p.word], entry: window.WB.get(p.word), isNew: false });
    });
    plan.dueTodayWords.forEach(function (w) {
      dueItems.push({ word: w, card: cards[w], entry: window.WB.get(w), isNew: false });
    });

    /* 新投放预算：今日上限减去今天已投放。
       均摊基数用整本词表剩余（含未普查外推），实际能投多少仍受 freshByLevel 待学卡限制。 */
    const limit  = effectiveLimit(st, paceRemaining(st));
    const used   = S.getDaily().new || 0;
    const budget = Math.max(0, limit - used);

    freshByLevel.forEach(function (a) {
      a.sort(function (x, y) { return window.WB.indexOf(x) - window.WB.indexOf(y); });
    });

    /* 新词配额只在 L1/L2 之间分配 */
    const alloc = allocate(budget, st.settings.quota,
                           [freshByLevel[0].length, freshByLevel[1].length]);

    const newItems = [];
    for (let lv = 1; lv <= 2; lv++) {
      freshByLevel[lv - 1].slice(0, alloc[lv - 1]).forEach(function (w) {
        newItems.push({ word: w, card: cards[w], entry: window.WB.get(w), isNew: true });
      });
    }

    return { queue: interleave(dueItems.concat(newItems)),
             dueCount: dueItems.length,
             newCount: newItems.length,
             limit: limit,
             usedToday: used,
             budget: budget,
             unlearnedL12: freshByLevel[0].length + freshByLevel[1].length,
             backlog: plan.backlog,
             deferredBacklog: plan.deferredBacklog,
             backlogDays: plan.backlogDays,
             reviewCap: plan.cap };
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
    return r < ratio ? 'quiz-en2zh' : 'flip';   // L2 眼熟：看词选义
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
          correct: o.correct,
          // 保留干扰项对应的词条：答错时把「你选的这个其实是哪个词 / 什么意思」
          // 一并展示，顺手多记一个词
          word: o.entry.word,
          other: mode === 'quiz-en2zh' ? o.entry.word : window.WB.shortDef(o.entry, 40)
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
      totalItems: built.queue.length,   // 初始真实卡数，做进度分母；again 重学副本不把它撑大
      realDone: 0,                      // 已评分的真实卡数（重学副本不计），达 totalItems 即结束
      dueCount: built.dueCount,
      newCount: built.newCount,
      limit: built.limit,
      usedToday: built.usedToday,
      budget: built.budget,
      unlearnedL12: built.unlearnedL12,
      backlog: built.backlog,
      deferredBacklog: built.deferredBacklog,
      backlogDays: built.backlogDays,
      reviewCap: built.reviewCap,
      stage: 'front',        // front | back | answered | finished
      quiz: null,
      mode: null,
      startedAt: Date.now(),
      stats: { done: 0, correct: 0, wrong: 0, downgrades: 0, upgrades: 0,
               combo: 0, maxCombo: 0 }
    };
  }

  /* 临时把今日新词上限往上抬，用于「今天还想多背点」的情况。
     走 daily[今天].extraNew 而不是常驻改 dailyNew：
     dailyNew 是每天的保底量，一次性加量只该影响今天，明天自动恢复计划量。 */
  function raiseLimit(n) {
    S.bump('extraNew', n);
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

  /* 纯判定（供单测）：真实卡评完即结束 —— 哪怕物理队列后面还压着没轮到的
     again 重学副本也直接结束并丢弃；pos 走到物理尽头是兜底结束。 */
  function shouldFinish(realDone, realTotal, nextPos, queueLen) {
    if (realTotal > 0 && realDone >= realTotal) return true;
    return nextPos >= queueLen;
  }

  function advance() {
    sess.pos++;
    // 刚被「丢进熟词速过池」(L3) 或归档的词，其当天重学副本若还压在队列里就直接跳过，
    // 不能让已经移出主复习的词又冒出来
    while (sess.pos < sess.queue.length) {
      const c = sess.queue[sess.pos] && sess.queue[sess.pos].card;
      if (c && (c.level === 3 || c.archived)) sess.pos++;
      else break;
    }
    if (shouldFinish(sess.realDone, sess.totalItems, sess.pos, sess.queue.length)) {
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

  /* again 的词当天隔几张再见一次：插入间隔区间，以及每词当天最多重学次数
     （重学再忘也不无限插，保证队列必然收敛、不会死循环）。 */
  const RELEARN_GAP_MIN = 6, RELEARN_GAP_MAX = 8, RELEARN_MAX = 1;

  function doGrade(g, srcEl, silent) {
    const it = currentItem();
    if (!it) return;
    const isRelearn = !!it.relearn;

    /* silent 用于选择题：对错反馈在作答那一刻就放过了（quizFx），
       结算时再放一次会变成重复的双响炮。连击数字仍然照常弹。 */
    if (!silent) gradeFx(g, srcEl);   // ← 必须在 render() 之前，理由见上

    const wasNew = !it.card.active;
    const res = E.grade(it.card, g, it.word);

    /* 当天重学项只用于再强化一次，不重复记每日计数和本次小结，否则过词数、
       正确率会被同一张卡刷虚高。 */
    if (!isRelearn) {
      S.bump(wasNew ? 'new' : 'review', 1);
      S.bump('total', 1);
      if (g !== 'again') { S.bump('correct', 1); sess.stats.correct++; }
      else sess.stats.wrong++;
      sess.stats.done++;
      sess.realDone++;   // 只有真实卡推进完成度；重学副本不推进
    }
    /* 连击是临场状态，重学照常参与：再忘就断、捡回来就连上。 */
    if (g !== 'again') {
      sess.stats.combo++;
      if (sess.stats.combo > sess.stats.maxCombo) sess.stats.maxCombo = sess.stats.combo;
    } else {
      sess.stats.combo = 0;    // 断连
    }
    S.save();
    snapshot();
    comboFx();

    res.events.forEach(function (ev) {
      if (ev.type === 'downgrade') {
        sess.stats.downgrades++;
        window.UI.toast(
          it.word + '：' + E.LEVELS[ev.from].name + ' → ' + E.LEVELS[ev.to].name +
          '（' + ev.reason + '）', 'warn', 4200);
      } else if (ev.type === 'upgrade') {
        // 自动升级已在引擎内生效，这里只给一条轻提示，不打断流程
        sess.stats.upgrades++;
        window.UI.toast(
          it.word + '：' + E.LEVELS[ev.from].name + ' → ' + E.LEVELS[ev.to].name +
          (ev.to === 3 ? '（已移入熟词速过池）' : ''), 'good', 3200);
      }
    });

    /* 「忘记」：引擎已把它的正式下次复习排到明天，这里再让它【当天】隔 6~8 张
       露一次面强化记忆。重学项是浅拷贝（card 仍是同一张），带 relearn 标记、
       不再重复计数；超过 RELEARN_MAX 就不再插，队列一定走得完。 */
    if (g === 'again' && (it.relearnCount || 0) < RELEARN_MAX) {
      const gap = RELEARN_GAP_MIN +
        Math.floor(Math.random() * (RELEARN_GAP_MAX - RELEARN_GAP_MIN + 1));
      const at = Math.min(sess.queue.length, sess.pos + 1 + gap);
      sess.queue.splice(at, 0, Object.assign({}, it, {
        relearn: true, relearnCount: (it.relearnCount || 0) + 1
      }));
    }

    advance();
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
    // 分母=初始真实卡数，分子=已评真实卡：重学副本既不撑大分母也不推进分子，
    // 因此进度严格 1→total，最后一张真实卡评完立即结束，不会出现「47/47 还冒卡」。
    const total = sess.totalItems || sess.queue.length;
    const shown = Math.min(sess.realDone + 1, total);
    const pct = total ? (sess.realDone / total * 100) : 0;
    const it = currentItem();
    return el('div', { class: 'review-top' }, [
      el('div', { class: 'progress' }, [
        el('div', { class: 'progress-fill', style: 'width:' + pct.toFixed(2) + '%' })
      ]),
      el('div', { class: 'review-meta' }, [
        el('span', { text: shown + ' / ' + total }),
        it ? el('span', { class: 'lv-chip lv-chip--' + it.card.level,
                          text: E.LEVELS[it.card.level].name }) : null,
        it && it.isNew ? el('span', { class: 'new-chip', text: '新词' }) : null,
        it && it.relearn ? el('span', { class: 'new-chip', text: '重学' }) : null,
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
      // 正面出现即朗读单词：先听发音、看拼写，再在心里回忆（翻面时会再读一遍强化）
      if (S.get().settings.autoSpeak) {
        setTimeout(function () { window.Speak.say(it.entry.word); }, 0);
      }
    } else {
      box.appendChild(window.DefsView.render(it.entry, { compact: true, citeLimit: 2 }));
      box.appendChild(gradeButtons(it));
      box.appendChild(notebookBar(it));
      box.appendChild(levelSwitch(it));
    }
    return box;
  }

  /* 「加入单词本」工具条（单词本模块未加载时不显示，保证可降级） */
  function notebookBar(it) {
    return window.NotebookUI ? window.NotebookUI.bar(it.entry) : null;
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

  /*
   * 手动把「漏网熟词」直接送入熟词速过池（L3），并从本次主复习队列移除、
   * 前进到下一张。用于：普查时本该归熟词却被分进 L1/L2 的词，复习时就地清走。
   * manualSetLevel(3) 会按「原熟词 legacy」归类、按 L3 节奏重排，之后只在速过模式出现。
   */
  function sendToRapid(it) {
    if (!it) return;
    const wasRelearn = !!it.relearn;
    E.manualSetLevel(it.card, 3);
    S.save(); snapshot();
    if (!wasRelearn) { sess.realDone++; sess.stats.done++; }
    window.UI.toast(it.word + ' 已移入「熟词速过池」，不再出现在主复习', 'info', 2400);
    window.Speak.stop();
    advance();
  }

  /* 手动改类别 */
  function levelSwitch(it) {
    const wrap = el('div', { class: 'lv-switch' }, [
      el('span', { class: 'lv-switch-label', text: '这个词归类为' })
    ]);
    // L1/L2 间手动纠正归类
    [1, 2].forEach(function (lv) {
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
    // 漏网熟词：直接丢进熟词速过池（L3），并立刻从本次复习跳过
    wrap.appendChild(el('button', {
      class: 'lv-pill lv-pill--rapid', type: 'button',
      title: '这个词其实早就会：移出主复习，放进熟词速过池',
      onclick: function () { sendToRapid(it); }
    }, [el('span', { text: '丢进熟词速过池 ↓' })]));
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
      const optKids = [
        el('kbd', { text: String(i + 1) }),
        el('span', { class: 'opt-text', text: o.text })
      ];
      // 答错时，在被错选的那一项里直接点明「它其实是什么」，顺手多记一个词
      if (answered && !o.correct && i === q.chosen) {
        optKids.push(el('span', {
          class: 'opt-extra',
          text: q.mode === 'quiz-en2zh'
            ? '（这个意思其实是「' + o.word + '」）'
            : '（它其实意为：' + o.other + '）'
        }));
      }
      opts.appendChild(el('button', {
        class: cls, type: 'button', disabled: answered,
        onclick: function () { answerQuiz(i); }
      }, optKids));
    });
    box.appendChild(opts);
    if (sess.stage === 'answered') {
      const wrongOpt = q.options[q.chosen];
      const right = wrongOpt && wrongOpt.correct;
      box.appendChild(el('div', {
        class: 'quiz-verdict ' + (right ? 'is-right' : 'is-wrong'),
        text: right ? '答对了' : '答错了 —— 这个词已重新排进高频复习'
      }));
      // 答错时单独给一行「混淆词」对照 + 朗读（外层选项已 disabled，喇叭放这里才可点）
      if (!right && wrongOpt) {
        const confuseKids = [el('span', { class: 'quiz-confuse-text', text:
          q.mode === 'quiz-en2zh'
            ? '你选的意思其实是另一个词「' + wrongOpt.word + '」，顺带记一下它 →'
            : '你选的「' + wrongOpt.word + '」其实意为：' + wrongOpt.other + ' →'
        })];
        if (window.Speak.available()) {
          confuseKids.push(el('button', {
            class: 'speak-btn speak-btn--sm', type: 'button',
            title: '朗读这个被混淆的词', 'aria-label': '朗读被混淆的词',
            onclick: function (e) { e.stopPropagation(); window.Speak.say(wrongOpt.word); }
          }, [el('span', { text: '🔊', 'aria-hidden': 'true' })]));
        }
        box.appendChild(el('div', { class: 'quiz-confuse' }, confuseKids));
      }
      box.appendChild(window.DefsView.render(it.entry, { compact: true, citeLimit: 2 }));
      box.appendChild(el('div', { class: 'card-actions' }, [
        el('button', {
          class: 'btn btn--primary btn--wide', type: 'button',
          onclick: continueAfterQuiz
        }, [el('span', { text: '继续' }), el('kbd', { text: 'Space' })])
      ]));
      box.appendChild(notebookBar(it));
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

    /* 被每日复习上限顺延的往日积压，明确告诉用户还欠多少、几天能清完 */
    if (sess && sess.deferredBacklog > 0) {
      const per = sess.reviewCap === null ? sess.backlog : sess.reviewCap;
      muted.push('另有 ' + fmtNum(sess.deferredBacklog) + ' 个往日积压顺延到之后几天，' +
        '按当前每天约 ' + per + ' 个的节奏，约 ' + sess.backlogDays + ' 天清完' +
        '（设置里可调「每日复习上限」）。');
    }

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
    if (sess.stage === 'finished') return;

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
    // 主复习只有 L1/L2 两类新词；L3 在速过模式、archived 永不复习，都不计入
    const freshAvail = [0, 0];

    Object.keys(cards).forEach(function (w) {
      const c = cards[w];
      if (!window.WB.get(w)) return;
      if (c.archived) return;
      if (!c.active && (c.level === 1 || c.level === 2)) freshAvail[c.level - 1]++;
    });

    /* 到期复习数与 buildQueue 走同一个规划函数：今天新到期全算、往日积压按上限算，
       首页显示多少，点进去就真有多少，不会两个数字打架。 */
    const plan   = reviewPlan(st);
    const due    = plan.reviewDue;
    // 均摊目标按整本词表剩余算（含未普查外推）；实际投放 alloc 仍受 freshAvail 待学卡上限约束
    const limit  = effectiveLimit(st, paceRemaining(st));
    const used   = S.getDaily().new || 0;
    const budget = Math.max(0, limit - used);
    const alloc  = allocate(budget, st.settings.quota, [freshAvail[0], freshAvail[1]]);

    return {
      due: due,
      newL1: alloc[0], newL2: alloc[1],
      newToStudy: alloc[0] + alloc[1],
      totalToday: due + alloc[0] + alloc[1],
      unlearned: freshAvail[0] + freshAvail[1],
      unlearnedL12: freshAvail[0] + freshAvail[1],
      limit: limit, usedToday: used, budget: budget,
      backlog: plan.backlog, deferredBacklog: plan.deferredBacklog,
      backlogDays: plan.backlogDays, reviewCap: plan.cap
    };
  }

  return {
    mount: mount, unmount: unmount, status: status, allocate: allocate,
    shouldFinish: shouldFinish,
    effectiveReviewCap: effectiveReviewCap, effectiveLimit: effectiveLimit
  };
})();
