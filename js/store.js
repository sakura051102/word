/* ===========================================================================
 *  store.js —— 存储层
 * ---------------------------------------------------------------------------
 *  职责：
 *    · localStorage 读写（带节流 + 退出前强制落盘）
 *    · 默认值补齐（向前兼容：将来加字段不会让老存档报错）
 *    · 日期工具（一律本地时区 YYYY-MM-DD，避免 UTC 跨日误差）
 *
 *  设计要点：卡片以【单词拼写】为键，不用数字 ID。
 *  这样将来替换/升级词库（补义项标注、补短语）时，
 *  已有的分类和复习进度全部保留 —— 普查要花好几个小时，不能重做。
 * =========================================================================== */

window.Store = (function () {
  'use strict';

  const KEY = 'kaoyan_vocab_v1';

  const DEFAULTS = {
    version: 1,
    settings: {
      dailyNew: 30,                   // 每日新投放上限
      quota: [6, 3, 1],               // L1:L2:L3 投放配额
      triageBatch: 100,               // 普查每批词数
      autoSpeak: true,                // 翻面自动朗读
      reviewBeforeTriageDone: false,  // 允许普查未完成就开始复习
      quizRatio: 0.5,                 // 选择题占比
      theme: 'auto'                   // auto | light | dark
    },
    triage: { cursor: 0 },            // 普查游标（词表下标）
    cards: {},                        // word -> card
    daily: {},                        // YYYY-MM-DD -> 当日计数
    levelSnap: {},                    // YYYY-MM-DD -> [L1数, L2数, L3数]
    upgradeSnooze: {}                 // word -> 该日期前不再提示升级
  };

  let state = null;

  /* ---------------------------------------------------------------- 日期工具 */

  function fmt(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + dd;
  }

  function today() {
    return fmt(new Date());
  }

  /** 解析 YYYY-MM-DD 为本地时区的 Date（不要用 new Date(str)，那会当成 UTC） */
  function parse(dateStr) {
    const p = String(dateStr).split('-').map(Number);
    return new Date(p[0], p[1] - 1, p[2]);
  }

  function addDays(dateStr, n) {
    const d = parse(dateStr);
    d.setDate(d.getDate() + Math.round(n));
    return fmt(d);
  }

  /** b - a，单位天（正数表示 b 晚于 a） */
  function daysBetween(a, b) {
    const MS = 86400000;
    // 用 UTC 毫秒差消除夏令时影响；两端都是本地零点，差值必为整天
    const da = parse(a), db = parse(b);
    return Math.round(
      (Date.UTC(db.getFullYear(), db.getMonth(), db.getDate()) -
       Date.UTC(da.getFullYear(), da.getMonth(), da.getDate())) / MS
    );
  }

  /** 生成从 endDate 往前数 n 天的日期数组（升序，含 endDate） */
  function lastNDays(n, endDate) {
    const end = endDate || today();
    const out = [];
    for (let i = n - 1; i >= 0; i--) out.push(addDays(end, -i));
    return out;
  }

  /* ---------------------------------------------------------------- 加载/保存 */

  /** 递归补齐默认字段；已有值优先，不覆盖用户数据 */
  function fillDefaults(target, defaults) {
    Object.keys(defaults).forEach(function (k) {
      const dv = defaults[k];
      if (target[k] === undefined || target[k] === null) {
        target[k] = (dv && typeof dv === 'object' && !Array.isArray(dv))
          ? fillDefaults({}, dv)
          : (Array.isArray(dv) ? dv.slice() : dv);
      } else if (dv && typeof dv === 'object' && !Array.isArray(dv) &&
                 typeof target[k] === 'object' && !Array.isArray(target[k])) {
        fillDefaults(target[k], dv);
      }
    });
    return target;
  }

  function load() {
    let raw = null;
    try {
      raw = localStorage.getItem(KEY);
    } catch (e) {
      // 隐私模式或磁盘配额问题 —— 退化为纯内存运行，界面另行告警
      console.warn('[store] localStorage 不可读，本次以内存模式运行', e);
    }
    if (raw) {
      try {
        state = fillDefaults(JSON.parse(raw), DEFAULTS);
      } catch (e) {
        console.error('[store] 存档解析失败，已保留原始数据并以空档启动', e);
        try { localStorage.setItem(KEY + '_corrupt_' + Date.now(), raw); } catch (e2) {}
        state = fillDefaults({}, DEFAULTS);
      }
    } else {
      state = fillDefaults({}, DEFAULTS);
    }
    return state;
  }

  function get() {
    if (!state) load();
    return state;
  }

  /* 节流写入：连续操作时最多每 400ms 落盘一次，
     但退出/切后台时强制 flush，保证不丢进度 */
  let pending = false, timer = null, lastWrite = 0, failed = false;
  const THROTTLE = 400;

  function writeNow() {
    if (!state) return;
    pending = false;
    if (timer) { clearTimeout(timer); timer = null; }
    lastWrite = Date.now();
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
      failed = false;
    } catch (e) {
      if (!failed) {
        failed = true;
        console.error('[store] 写入失败（可能超出配额）', e);
        window.dispatchEvent(new CustomEvent('store:writefail', { detail: e }));
      }
    }
  }

  function save() {
    const since = Date.now() - lastWrite;
    if (since >= THROTTLE) {
      writeNow();
    } else if (!pending) {
      pending = true;
      timer = setTimeout(writeNow, THROTTLE - since);
    }
  }

  function flush() {
    if (pending || timer) writeNow();
  }

  // 关页面 / 切后台时强制落盘。pagehide 比 beforeunload 在移动端更可靠
  window.addEventListener('pagehide', flush);
  window.addEventListener('beforeunload', flush);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') flush();
  });

  /* ---------------------------------------------------------------- 卡片存取 */

  function getCard(word) {
    return get().cards[word] || null;
  }

  function setCard(word, card) {
    get().cards[word] = card;
    save();
  }

  function removeCard(word) {
    delete get().cards[word];
    save();
  }

  /* ---------------------------------------------------------------- 每日计数 */

  /** 累加当日某项计数，如 bump('triaged', 1) */
  function bump(field, n, dateStr) {
    const d = dateStr || today();
    const daily = get().daily;
    if (!daily[d]) daily[d] = { triaged: 0, new: 0, review: 0, correct: 0, total: 0, seconds: 0 };
    daily[d][field] = (daily[d][field] || 0) + (n === undefined ? 1 : n);
    save();
    return daily[d];
  }

  function getDaily(dateStr) {
    return get().daily[dateStr || today()] ||
           { triaged: 0, new: 0, review: 0, correct: 0, total: 0, seconds: 0 };
  }

  /** 记录当日三类词数快照（用于趋势曲线）。同日重复调用直接覆盖。 */
  function snapshotLevels(counts, dateStr) {
    get().levelSnap[dateStr || today()] = counts.slice(0, 3);
    save();
  }

  /* ---------------------------------------------------------------- 升级免打扰 */

  function snoozeUpgrade(word, days) {
    get().upgradeSnooze[word] = addDays(today(), days || 14);
    save();
  }

  function isUpgradeSnoozed(word) {
    const until = get().upgradeSnooze[word];
    return !!until && daysBetween(today(), until) > 0;
  }

  /* ---------------------------------------------------------------- 导入导出 */

  function exportJSON() {
    flush();
    return JSON.stringify(get(), null, 2);
  }

  /** 校验并导入。返回 {ok, summary|error}，不直接写入 —— 由调用方确认后再 commit */
  function inspectImport(text) {
    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      return { ok: false, error: '文件不是合法的 JSON，可能已损坏或选错了文件。' };
    }
    if (!data || typeof data !== 'object' || !data.cards || typeof data.cards !== 'object') {
      return { ok: false, error: '这不像本程序导出的备份文件（缺少 cards 字段）。' };
    }
    const words = Object.keys(data.cards);
    const byLevel = [0, 0, 0];
    words.forEach(function (w) {
      const lv = data.cards[w] && data.cards[w].level;
      if (lv >= 1 && lv <= 3) byLevel[lv - 1]++;
    });
    const dates = Object.keys(data.daily || {}).sort();
    return {
      ok: true,
      data: data,
      summary: {
        cardCount: words.length,
        byLevel: byLevel,
        cursor: (data.triage && data.triage.cursor) || 0,
        firstDay: dates[0] || null,
        lastDay: dates[dates.length - 1] || null
      }
    };
  }

  function commitImport(data) {
    state = fillDefaults(data, DEFAULTS);
    writeNow();
    return state;
  }

  function reset() {
    state = fillDefaults({}, DEFAULTS);
    writeNow();
    return state;
  }

  /* ---------------------------------------------------------------- 导出接口 */

  return {
    KEY: KEY,
    load: load, get: get, save: save, flush: flush,
    getCard: getCard, setCard: setCard, removeCard: removeCard,
    bump: bump, getDaily: getDaily, snapshotLevels: snapshotLevels,
    snoozeUpgrade: snoozeUpgrade, isUpgradeSnoozed: isUpgradeSnoozed,
    exportJSON: exportJSON, inspectImport: inspectImport,
    commitImport: commitImport, reset: reset,
    today: today, fmt: fmt, parse: parse, addDays: addDays,
    daysBetween: daysBetween, lastNDays: lastNDays
  };
})();
