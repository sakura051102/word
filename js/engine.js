/* ===========================================================================
 *  engine.js —— 间隔重复引擎 + 升降级规则（v2）
 * ---------------------------------------------------------------------------
 *  主复习只跑 L1 生词 / L2 眼熟两类，同一个 SM-2 变体、两套参数，
 *  刻意把 L1 与 L2 的频率差拉大到 5~8 倍，让「升降级」在体感上明显：
 *    · L1 生词：起点 1 天、增长 1.5（爬得慢、反复见）
 *    · L2 眼熟：起点 5 天、增长 2.2（快速拉疏）
 *  L3 熟词不进主复习，是独立「熟词速过池」：只由 L2 连对达标自动升入，
 *  或来自旧版存量（l3Origin='legacy'）；在速过模式里「认识」继续拉长、
 *  「不认识」自动打回 L2。archived=true 的词永不复习，被一切调度排除。
 * =========================================================================== */

window.Engine = (function () {
  'use strict';

  /* ---------------------------------------------------------------- 类别参数 */

  const LEVELS = {
    1: { key: 'L1', name: '生词', hint: '完全不熟',     initial: 1,  growth: 1.5 },
    2: { key: 'L2', name: '眼熟', hint: '有印象但会忘', initial: 5,  growth: 2.2 },
    3: { key: 'L3', name: '熟词', hint: '速过池，基本不会忘', initial: 20, growth: 2.5 }
  };

  const EASE_DEFAULT = 2.5;
  const EASE_MIN     = 1.3;
  const EASE_MAX     = 3.0;
  const MAX_INTERVAL = 180;   // 备考周期内间隔超过半年没意义，也防止词彻底消失

  /* 自动升级门槛（连对 streak 次、且间隔已被拉到 interval 天以上才升） */
  const UPGRADE = {
    1: { streak: 3, interval: 5  },   // L1 → L2（生词稳定几次后降为眼熟）
    2: { streak: 3, interval: 21 }    // L2 → L3（眼熟长期稳定后升入熟词速过池）
  };

  /* 降级门槛：L2 在本级内累计答错到此数则打回 L1 */
  const L2_LAPSE_LIMIT = 2;

  /* ------------------------------------------------------------ 间隔增长系数 */

  /*
   * 有效倍数 = 1 + (growth - 1) * (ease / 2.5)
   *
   * 为什么不直接用 interval * ease * growth：
   * ease 默认 2.5，再乘 growth 会得到 4 倍以上的暴涨。
   * 这个式子保证 ease 为默认值时倍数恰好等于表中的 growth
   * （L1 x1.6 / L2 x2.0 / L3 x2.5），ease 掉到下限 1.3 时
   * 倍数平滑收缩但恒大于 1，间隔不会因为 ease 低而倒退。
   */
  function multiplier(level, ease) {
    const g = LEVELS[level].growth;
    return 1 + (g - 1) * (ease / EASE_DEFAULT);
  }

  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

  /* ---------------------------------------------------------------- 卡片构造 */

  /* 普查定级后创建卡片。此时尚未进入复习循环（active = false） */
  function createCard(level) {
    return {
      level:     level,
      ease:      EASE_DEFAULT,
      interval:  0,
      reps:      0,
      lapses:    0,    // 总答错次数（跨类别累计，仅用于统计）
      lvLapses:  0,    // 当前类别内答错次数（降级判定用，换级清零）
      streak:    0,    // 连续答对次数
      due:       null,
      active:    false,
      triagedAt: window.Store.today()
    };
  }

  /*
   * 首次投放进复习循环。
   *
   * L1/L2 —— 今天就要学：普查时用户只是看一眼说「眼熟」，没有真正验证过。
   * L3    —— 排到未来某天巡检：普查阶段的强制核对已经翻开释义验证过一次，
   *          那次核对本身就等价于一次成功复习，所以 reps 记为 1。
   *
   * dueOffset 只对 L3 有意义：调用方用它把成百上千个熟词的首次巡检日
   * 摊开到未来一段时间里，避免同一天集中爆量。
   * interval 仍然保持 L3 的节奏（20 天），所以首检通过后间隔照常按 L3 增长。
   */
  function activate(card, dueOffset) {
    const today = window.Store.today();
    if (card.level === 3) {
      const off = (dueOffset === undefined || dueOffset === null)
        ? LEVELS[3].initial : Math.max(1, Math.round(dueOffset));
      card.interval = LEVELS[3].initial;
      card.reps     = 1;
      card.due      = window.Store.addDays(today, off);
    } else {
      card.interval = 0;
      card.reps     = 0;
      card.due      = today;
    }
    card.active = true;
    return card;
  }

  /* ---------------------------------------------------------------- 评分核心 */

  const GRADES = ['again', 'hard', 'good', 'easy'];
  const GRADE_LABEL = { again: '忘记', hard: '困难', good: '认识', easy: '简单' };

  /*
   * 对一张卡片评分。word 用于判断该词的升级提示是否在免打扰期内，可省略。
   *
   * 返回 { card, events }，events 里可能有（均已自动生效，仅供界面轻提示）：
   *   { type:'downgrade', from, to, reason }
   *   { type:'upgrade', from, to }
   *
   * 注意：本函数直接修改传入的 card 对象。
   */
  function grade(card, g, word) {
    if (GRADES.indexOf(g) < 0) throw new Error('未知评分: ' + g);

    const today  = window.Store.today();
    const events = [];

    if (g === 'again') {
      card.reps      = 0;
      card.streak    = 0;
      card.interval  = 1;
      card.ease      = clamp(card.ease - 0.20, EASE_MIN, EASE_MAX);
      card.lapses   += 1;
      card.lvLapses += 1;

    } else if (g === 'hard') {
      // 「困难」= 勉强想起来：不算答错，所以【不清零连对】；但也不算一次干净的答对，
      // 因此 streak 不 +1、reps 不 +1，只小幅压低 ease、间隔几乎不涨。
      // （旧实现这里把 streak 清零，会让一次犹豫就打断升级连对，过于苛刻。）
      card.ease     = clamp(card.ease - 0.15, EASE_MIN, EASE_MAX);
      card.interval = clamp(Math.round(Math.max(1, card.interval) * 1.2), 1, MAX_INTERVAL);

    } else {
      // good / easy
      if (card.reps === 0) {
        // 本级的第一次成功 —— 用该类别的初始间隔
        card.interval = LEVELS[card.level].initial;
      } else {
        card.interval = Math.round(card.interval * multiplier(card.level, card.ease));
      }
      if (g === 'easy') {
        card.interval = Math.round(card.interval * 1.3);
        card.ease     = clamp(card.ease + 0.15, EASE_MIN, EASE_MAX);
      }
      card.interval = clamp(card.interval, 1, MAX_INTERVAL);
      card.reps    += 1;
      card.streak  += 1;
    }

    card.due    = window.Store.addDays(today, card.interval);
    card.active = true;

    /* ---- 自动降级：立即生效，只给界面一条提示 ---- */
    if (g === 'again') {
      let downTo = 0, reason = '';
      if (card.level === 3) {
        downTo = 2; reason = '熟词答错，说明高估了它';
      } else if (card.level === 2 && card.lvLapses >= L2_LAPSE_LIMIT) {
        // reason 必须在 setLevel 清掉 lvLapses 之前取
        downTo = 1; reason = '在「眼熟」阶段已答错 ' + card.lvLapses + ' 次';
      }
      if (downTo) {
        const from = card.level;
        setLevel(card, downTo);
        card.lastDowngradeAt = today;   // 记最近降级日，供薄弱词本筛「近 30 天掉过级」
        events.push({ type: 'downgrade', from: from, to: downTo, reason: reason });
      }
      // L1 已在最低级，只重置间隔，不降级
    }

    /* ---- 自动升级：达标立即换级、按新级节奏重排，无需用户确认 ---- */
    if (g === 'good' || g === 'easy') {
      const rule = UPGRADE[card.level];
      if (rule && card.streak >= rule.streak && card.interval >= rule.interval) {
        const from = card.level, to = card.level + 1;
        setLevel(card, to);
        // 升级后不丢已积累的间隔，但至少跳到新级起点，免得升了级还天天见
        card.interval = clamp(Math.max(card.interval, LEVELS[to].initial), 1, MAX_INTERVAL);
        card.due      = window.Store.addDays(today, card.interval);
        if (to === 3) card.l3Origin = 'promoted';   // L2 升上来的熟词=新晋级
        events.push({ type: 'upgrade', from: from, to: to });
      }
    }

    return { card: card, events: events };
  }

  /* 切换类别：清空本级答错计数和连对 */
  function setLevel(card, level) {
    if (card.level === level) return card;
    card.level    = level;
    card.lvLapses = 0;
    card.streak   = 0;
    return card;
  }

  /* 手动/兼容入口：按新类别的节奏重排下次复习（正常升级已在 grade 内自动完成） */
  function applyUpgrade(card, toLevel) {
    setLevel(card, toLevel);
    card.interval = clamp(Math.max(card.interval, LEVELS[toLevel].initial), 1, MAX_INTERVAL);
    card.due      = window.Store.addDays(window.Store.today(), card.interval);
    if (toLevel === 3) card.l3Origin = 'promoted';
    return card;
  }

  /* 手动改类别（词书页 / 复习界面）。手动丢进熟词池按「原熟词」归类。 */
  function manualSetLevel(card, toLevel) {
    setLevel(card, toLevel);
    if (toLevel === 3 && !card.l3Origin) card.l3Origin = 'legacy';
    if (card.active) {
      card.interval = clamp(Math.max(1, Math.min(card.interval, LEVELS[toLevel].initial)),
                            1, MAX_INTERVAL);
      card.due = window.Store.addDays(window.Store.today(), card.interval);
    }
    return card;
  }

  /* ---------------------------------------------------------------- 永不复习 */
  /* 归档：从一切复习/速过/预测/统计中移除，但保留卡片与进度，可随时恢复。 */
  function archive(card) {
    if (!card) return card;
    card.archived = true;
    card.archivedAt = window.Store.today();
    return card;
  }

  function unarchive(card) {
    if (!card) return card;
    card.archived = false;
    delete card.archivedAt;
    return card;
  }

  function isArchived(card) { return !!(card && card.archived); }

  /* 统计已归档（永不复习）词数 */
  function archivedCount(cards) {
    let n = 0;
    Object.keys(cards).forEach(function (w) { if (cards[w] && cards[w].archived) n++; });
    return n;
  }

  /* 把一个词打回未学状态，但保留它的类别和建档日期（词书页的「重置」） */
  function resetCard(card) {
    const lv = card.level;
    const t  = card.triagedAt;
    const fresh = createCard(lv);
    fresh.triagedAt = t;
    Object.keys(card).forEach(function (k) { delete card[k]; });
    Object.keys(fresh).forEach(function (k) { card[k] = fresh[k]; });
    return card;
  }

  /* ---------------------------------------------------------------- 查询工具 */

  function isDue(card, dateStr) {
    if (!card || card.archived || !card.active || !card.due) return false;
    return window.Store.daysBetween(card.due, dateStr || window.Store.today()) >= 0;
  }

  /* 统计三类词数，返回 [L1, L2, L3]；永不复习的词不计入任何类别 */
  function levelCounts(cards) {
    const c = [0, 0, 0];
    Object.keys(cards).forEach(function (w) {
      const card = cards[w];
      if (!card || card.archived) return;
      const lv = card.level;
      if (lv >= 1 && lv <= 3) c[lv - 1]++;
    });
    return c;
  }

  /*
   * 薄弱词本：命中任一条件即算薄弱 ——
   *   · 累计答错 lapses ≥ 2（总是记不牢）；
   *   · 近 recentDays 天内被自动降级过（刚掉级，最该马上补）。
   * 返回 [{word, card}]，排序：最近掉级优先 → 答错次数多 → 当前间隔短。
   */
  function weakWords(cards, recentDays) {
    const today = window.Store.today();
    const win = recentDays || 30;
    const out = [];
    Object.keys(cards).forEach(function (w) {
      const c = cards[w];
      if (!c || c.archived) return;
      const recentDown = c.lastDowngradeAt &&
        window.Store.daysBetween(c.lastDowngradeAt, today) <= win;
      if ((c.lapses || 0) >= 2 || recentDown) out.push({ word: w, card: c });
    });
    out.sort(function (a, b) {
      const da = a.card.lastDowngradeAt || '', db = b.card.lastDowngradeAt || '';
      if (da !== db) return da < db ? 1 : -1;          // 字符串日期，越晚越大、越靠前
      if ((b.card.lapses || 0) !== (a.card.lapses || 0)) {
        return (b.card.lapses || 0) - (a.card.lapses || 0);
      }
      return (a.card.interval || 0) - (b.card.interval || 0);
    });
    return out;
  }

  /* 掌握度分档（统计页用）—— 按当前间隔长度分 */
  function masteryBucket(card) {
    if (!card) return 'unstudied';
    if (card.archived) return 'archived';
    if (!card.active) return 'unstudied';
    if (card.interval < 7)  return 'learning';
    if (card.interval < 30) return 'familiar';
    return 'mastered';
  }

  /* 未来 n 天每天的到期词数预测；已过期的积压全部计入第 0 天 */
  function forecast(cards, n) {
    const today = window.Store.today();
    const out = [];
    for (let i = 0; i < n; i++) out.push({ date: window.Store.addDays(today, i), count: 0 });
    const index = {};
    out.forEach(function (o, i) { index[o.date] = i; });

    Object.keys(cards).forEach(function (w) {
      const card = cards[w];
      if (!card || card.archived || !card.active || !card.due) return;
      if (index[card.due] !== undefined) {
        out[index[card.due]].count++;
      } else if (window.Store.daysBetween(card.due, today) > 0) {
        out[0].count++;
      }
    });
    return out;
  }

  /* 预览四个评分各自会把下次复习推到多少天后（复习界面按钮上显示） */
  function preview(card) {
    const out = {};
    GRADES.forEach(function (g) {
      const copy = JSON.parse(JSON.stringify(card));
      grade(copy, g);
      out[g] = copy.interval;
    });
    return out;
  }

  /* ---------------------------------------------------------------- 导出接口 */

  return {
    LEVELS: LEVELS,
    GRADES: GRADES,
    GRADE_LABEL: GRADE_LABEL,
    EASE_DEFAULT: EASE_DEFAULT,
    MAX_INTERVAL: MAX_INTERVAL,
    UPGRADE: UPGRADE,
    L2_LAPSE_LIMIT: L2_LAPSE_LIMIT,

    createCard: createCard,
    activate: activate,
    grade: grade,
    applyUpgrade: applyUpgrade,
    manualSetLevel: manualSetLevel,
    resetCard: resetCard,
    archive: archive, unarchive: unarchive,
    isArchived: isArchived, archivedCount: archivedCount,

    isDue: isDue,
    levelCounts: levelCounts,
    weakWords: weakWords,
    masteryBucket: masteryBucket,
    forecast: forecast,
    preview: preview,
    multiplier: multiplier
  };
})();
