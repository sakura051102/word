/* ===========================================================================
 *  engine.js —— 间隔重复引擎 + 三级升降级规则
 * ---------------------------------------------------------------------------
 *  设计：不写三套算法。同一个 SM-2 变体，三个类别给三套参数。
 *  类别决定「起点和节奏」，引擎负责后续调度。
 * =========================================================================== */

window.Engine = (function () {
  'use strict';

  /* ---------------------------------------------------------------- 类别参数 */

  const LEVELS = {
    1: { key: 'L1', name: '生词', hint: '完全不熟',     initial: 1,  growth: 1.6 },
    2: { key: 'L2', name: '眼熟', hint: '有印象但会忘', initial: 3,  growth: 2.0 },
    3: { key: 'L3', name: '熟词', hint: '基本不会忘',   initial: 20, growth: 2.5 }
  };

  const EASE_DEFAULT = 2.5;
  const EASE_MIN     = 1.3;
  const EASE_MAX     = 3.0;
  const MAX_INTERVAL = 180;   // 备考周期内间隔超过半年没意义，也防止词彻底消失

  /* 升级门槛 */
  const UPGRADE = {
    1: { streak: 3, interval: 7  },   // L1 → L2
    2: { streak: 3, interval: 21 }    // L2 → L3
  };

  /* 降级门槛：L2 在本级内累计答错到此数则降级 */
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
   * 返回 { card, events }，events 里可能有：
   *   { type:'downgrade', from, to, reason } —— 已自动生效，仅供界面提示
   *   { type:'upgrade-prompt', from, to }    —— 尚未生效，需用户确认
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
      card.streak   = 0;
      card.ease     = clamp(card.ease - 0.15, EASE_MIN, EASE_MAX);
      // 困难不算答错，但间隔几乎不涨
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
      if (card.level === 3) {
        events.push({ type: 'downgrade', from: 3, to: 2,
                      reason: '熟词答错，说明高估了它' });
        setLevel(card, 2);
      } else if (card.level === 2 && card.lvLapses >= L2_LAPSE_LIMIT) {
        events.push({ type: 'downgrade', from: 2, to: 1,
                      reason: '在「眼熟」阶段已答错 ' + card.lvLapses + ' 次' });
        setLevel(card, 1);
      }
      // L1 已在最低级，只重置间隔，不降级
    }

    /* ---- 升级提示：需要用户确认，此处不改 level ---- */
    if (g === 'good' || g === 'easy') {
      const rule = UPGRADE[card.level];
      const snoozed = word ? window.Store.isUpgradeSnoozed(word) : false;
      if (rule && card.streak >= rule.streak && card.interval >= rule.interval && !snoozed) {
        events.push({ type: 'upgrade-prompt', from: card.level, to: card.level + 1 });
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

  /* 用户确认升级 —— 立刻按新类别的节奏重排下次复习 */
  function applyUpgrade(card, toLevel) {
    setLevel(card, toLevel);
    // 升级后不重置进度，但间隔至少跳到新类别的初始值，免得升了级还天天见
    card.interval = clamp(Math.max(card.interval, LEVELS[toLevel].initial), 1, MAX_INTERVAL);
    card.due      = window.Store.addDays(window.Store.today(), card.interval);
    return card;
  }

  /* 手动改类别（词书页 / 复习界面的下拉） */
  function manualSetLevel(card, toLevel) {
    setLevel(card, toLevel);
    if (card.active) {
      card.interval = clamp(Math.max(1, Math.min(card.interval, LEVELS[toLevel].initial)),
                            1, MAX_INTERVAL);
      card.due = window.Store.addDays(window.Store.today(), card.interval);
    }
    return card;
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
    if (!card || !card.active || !card.due) return false;
    return window.Store.daysBetween(card.due, dateStr || window.Store.today()) >= 0;
  }

  /* 统计三类词数，返回 [L1, L2, L3] */
  function levelCounts(cards) {
    const c = [0, 0, 0];
    Object.keys(cards).forEach(function (w) {
      const lv = cards[w].level;
      if (lv >= 1 && lv <= 3) c[lv - 1]++;
    });
    return c;
  }

  /* 掌握度分档（统计页用）—— 按当前间隔长度分 */
  function masteryBucket(card) {
    if (!card || !card.active) return 'unstudied';
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
      if (!card.active || !card.due) return;
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

    isDue: isDue,
    levelCounts: levelCounts,
    masteryBucket: masteryBucket,
    forecast: forecast,
    preview: preview,
    multiplier: multiplier
  };
})();
