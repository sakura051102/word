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
  // 上一版主档的自动快照：每次成功写入前，把旧主档挪到这里做「落盘轮换」，
  // 万一新主档被截断 / 写坏，加载时还能回滚到完整的上一代（见 writeNow / load）。
  const BACKUP_KEY = KEY + '_backup';
  // 当前存档结构版本。老存档加载时按 MIGRATIONS 逐级迁移到该版本。
  //   v1：三类都进复习；v2：主复习只跑 L1/L2，L3 剥离为「熟词速过池」，
  //       新增单词本 notebooks、卡片归档标记 archived、L3 来源标记 l3Origin。
  const CURRENT_VERSION = 2;

  const DEFAULTS = {
    version: 2,
    settings: {
      dailyNew: 30,                   // 每日新投放上限
      quota: [6, 3],                  // L1:L2 新词投放配额（L3 不进主复习，无配额）
      triageBatch: 100,               // 普查每批词数
      autoSpeak: true,                // 出现单词/翻面时自动朗读
      accent: 'us',                   // 发音口音：us 美音 | gb 英音
      onlineVoice: true,              // 单词优先在线真人发音（联网，失败自动回退系统语音）
      reviewBeforeTriageDone: false,  // 允许普查未完成就开始复习
      quizRatio: 0.5,                 // 选择题占比
      theme: 'auto',                  // auto | light | dark
      examDate: null,                 // 考试日期 'YYYY-MM-DD'，null = 未设置
      autoPace: true,                 // 按考试日期动态算每日新词量
      // 每天最多再消化多少个【往日积压】的到期复习词（今天新到期的不受限）：
      //   0  = 自动（近 14 天日均复习量 ×1.5，无历史时不限，避免新用户被卡死）
      //  -1  = 不限制（积压多少今天全做）；正数 = 固定每天上限
      dailyReviewCap: 0
    },
    triage: { cursor: 0 },            // 普查游标（词表下标）
    cards: {},                        // word -> card
    daily: {},                        // YYYY-MM-DD -> 当日计数
    levelSnap: {},                    // YYYY-MM-DD -> [L1数, L2数, L3数]
    upgradeSnooze: {},                // word -> 该日期前不再提示升级（保留，自动升级后基本不再用）
    notebooks: {},                    // nbId -> {id,name,words:[],createdAt} 自定义单词本
    lastExportAt: null,               // 上次手动导出备份的日期（备份提醒用）
    lastExportCount: 0                // 上次导出时已建档词数（增量达 500 提醒）
  };

  let state = null;
  // 加载阶段产生、需要在界面启动后提示一次的消息（如「已从自动备份恢复」）
  let notice = null;

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

  /* 版本迁移表：MIGRATIONS[v] 负责把数据【从 v 版】原地升级到 v+1 版。
     普通新增字段交给 fillDefaults 兜底即可，这里只放需要改结构 / 重命名的硬迁移，
     保证几年前的老存档也能一级级升到 CURRENT_VERSION，而不是直接读崩。 */
  const MIGRATIONS = {
    /* v1 → v2：主复习只保留 L1/L2，L3 转为独立「熟词速过池」。
       · 配额从 [L1,L2,L3] 收成两类；移除已废弃的 skipL3Patrol；
       · 现存 L3 卡标 l3Origin='legacy'（原熟词），与之后 L2 升上来的 'promoted' 区分；
       · 初始化 archived（永不复习）标记与单词本容器。
       不删任何卡、不改到期日，保证升级后不爆量、不丢进度。 */
    1: function (d) {
      if (d.settings) {
        if (Array.isArray(d.settings.quota)) {
          d.settings.quota = [d.settings.quota[0] || 6, d.settings.quota[1] || 3];
        }
        delete d.settings.skipL3Patrol;
      }
      if (d.cards) {
        Object.keys(d.cards).forEach(function (w) {
          const c = d.cards[w];
          if (!c) return;
          if (c.level === 3 && !c.l3Origin) c.l3Origin = 'legacy';
          c.archived = !!c.archived;
        });
      }
      if (!d.notebooks || typeof d.notebooks !== 'object') d.notebooks = {};
    }
  };

  function migrate(d) {
    let v = Number(d.version) || 1;
    while (v < CURRENT_VERSION) {
      const step = MIGRATIONS[v];
      if (step) step(d);
      v += 1;
    }
    d.version = CURRENT_VERSION;
    return d;
  }

  /** 反序列化一份存档文本：parse → 迁移 → 默认值补齐 */
  function decode(raw) {
    return fillDefaults(migrate(JSON.parse(raw)), DEFAULTS);
  }

  /** 把读坏的原始文本另存为带时间戳的隔离键，留给用户/开发者排查，不直接覆盖 */
  function quarantine(raw) {
    try { localStorage.setItem(KEY + '_corrupt_' + Date.now(), raw); } catch (e) {}
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
        state = decode(raw);
      } catch (e) {
        // 主档损坏：先抢救上一版自动快照，尽量不让用户丢进度
        let backup = null;
        try { backup = localStorage.getItem(BACKUP_KEY); } catch (e2) {}

        if (backup) {
          try {
            state = decode(backup);
            quarantine(raw);
            notice = {
              type: 'recovered',
              message: '主存档读取失败，已自动恢复到上一次的备份（最近一步操作可能丢失）。' +
                       '建议尽快到「设置 → 导出备份」另存一份。'
            };
            console.warn('[store] 主档损坏，已回滚到自动备份', e);
          } catch (e3) {
            quarantine(raw);
            state = fillDefaults({}, DEFAULTS);
            notice = { type: 'corrupt',
              message: '主存档和自动备份都无法读取，已以空档启动；损坏数据已单独保留，未被覆盖。' };
            console.error('[store] 主档与备份均损坏，空档启动', e, e3);
          }
        } else {
          quarantine(raw);
          state = fillDefaults({}, DEFAULTS);
          notice = { type: 'corrupt',
            message: '存档读取失败，已以空档启动；损坏的原始数据已单独保留，未被覆盖。' };
          console.error('[store] 存档解析失败，无备份，空档启动', e);
        }
      }
    } else {
      state = fillDefaults({}, DEFAULTS);
    }
    return state;
  }

  /** 取出并清除一次性的加载提示（启动时弹一次 toast） */
  function consumeNotice() {
    const n = notice; notice = null;
    return n;
  }

  function get() {
    if (!state) load();
    return state;
  }

  /* 节流写入：连续操作时最多每 400ms 落盘一次，
     但退出/切后台时强制 flush，保证不丢进度 */
  let pending = false, timer = null, lastWrite = 0, failed = false;
  let lastSlowWarn = 0;
  const THROTTLE = 400;
  // 单次序列化超过这个毫秒数就告警（5530 卡全量 stringify 的健康度埋点），5 秒内最多一条
  const SLOW_SERIALIZE_MS = 30;

  function writeNow() {
    if (!state) return;
    pending = false;
    if (timer) { clearTimeout(timer); timer = null; }
    lastWrite = Date.now();

    let str;
    const t0 = Date.now();
    try {
      str = JSON.stringify(state);
    } catch (e) {
      if (!failed) {
        failed = true;
        console.error('[store] 序列化失败，本次未写入', e);
      }
      return;
    }
    const serializeMs = Date.now() - t0;
    if (serializeMs >= SLOW_SERIALIZE_MS && Date.now() - lastSlowWarn > 5000) {
      lastSlowWarn = Date.now();
      console.warn('[store] 本次存档序列化耗时 ' + serializeMs + 'ms、约 ' +
        Math.round(str.length / 1024) + 'KB；词量继续增大若感到卡顿，可考虑分片存储。');
    }

    try {
      /* 落盘轮换：先把【上一代完整主档】挪为备份，再写新主档。
         这样即便本次写入中途被截断 / 写坏（隐私模式清理、配额、异常退出），
         BACKUP_KEY 里仍是一份完整的上一代存档，load() 可据此回滚，而不是空档。 */
      let prev = null;
      try { prev = localStorage.getItem(KEY); } catch (e) {}
      if (prev) {
        try { localStorage.setItem(BACKUP_KEY, prev); } catch (e) {}
      }
      localStorage.setItem(KEY, str);
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

  /* ---------------------------------------------------------------- 单词本 */
  /* 单词本与等级体系正交：只做收藏，不影响任何复习调度。一个词可同时进多个本，
     关系存在本子的 words 里（而不是卡片上），删本绝不删卡片与学习进度。 */

  function nbId() {
    return 'nb_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
  }

  /** 全部单词本，按创建时间升序，返回带 count 的浅拷贝数组 */
  function listNotebooks() {
    const nbs = get().notebooks || {};
    return Object.keys(nbs).map(function (id) {
      const nb = nbs[id];
      return { id: nb.id, name: nb.name, createdAt: nb.createdAt,
               words: (nb.words || []).slice(), count: (nb.words || []).length };
    }).sort(function (a, b) { return (a.createdAt || '') < (b.createdAt || '') ? -1 : 1; });
  }

  function getNotebook(id) {
    return (get().notebooks || {})[id] || null;
  }

  /** 新建本，名字去空白；重名允许（用户可自行区分）。返回新本，空名返回 null */
  function createNotebook(name) {
    const nm = String(name == null ? '' : name).trim();
    if (!nm) return null;
    const nb = { id: nbId(), name: nm.slice(0, 40), words: [], createdAt: today() };
    get().notebooks[nb.id] = nb;
    save();
    return nb;
  }

  function renameNotebook(id, name) {
    const nb = getNotebook(id);
    if (!nb) return false;
    const nm = String(name == null ? '' : name).trim();
    if (!nm) return false;
    nb.name = nm.slice(0, 40);
    save();
    return true;
  }

  function removeNotebook(id) {
    const nbs = get().notebooks || {};
    if (!nbs[id]) return false;
    delete nbs[id];
    save();
    return true;
  }

  /** 把词加入本（去重）。返回 true=新加入，false=本来就在 */
  function addWordToNotebook(id, word) {
    const nb = getNotebook(id);
    if (!nb || !word) return false;
    if (!nb.words) nb.words = [];
    if (nb.words.indexOf(word) >= 0) return false;
    nb.words.push(word);
    save();
    return true;
  }

  function removeWordFromNotebook(id, word) {
    const nb = getNotebook(id);
    if (!nb || !nb.words) return false;
    const i = nb.words.indexOf(word);
    if (i < 0) return false;
    nb.words.splice(i, 1);
    save();
    return true;
  }

  /** 该词所在的全部单词本（供词书页展示） */
  function notebooksOfWord(word) {
    return listNotebooks().filter(function (nb) {
      return nb.words.indexOf(word) >= 0;
    });
  }

  /* ---------------------------------------------------------------- 导入导出 */

  function exportJSON() {
    flush();
    return JSON.stringify(get(), null, 2);
  }

  /** CSV 单元格转义：含逗号/引号/换行时用双引号包住，内部引号翻倍 */
  function csvCell(v) {
    const s = String(v == null ? '' : v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  /**
   * 导出每日学习记录为 CSV（一行一天，按日期升序）。
   * 带 UTF-8 BOM、CRLF 行尾，双击用 Excel 打开中文不乱码、列不串行。
   * 列：日期 / 普查分类 / 新学 / 复习 / 过词合计 / 答对 / 正确率% / 学习秒数。
   */
  function toCSV() {
    flush();
    const st = get();
    const head = ['date', 'triaged', 'newLearned', 'review', 'total',
                  'correct', 'accuracyPct', 'seconds'];
    const lines = [head.map(csvCell).join(',')];
    Object.keys(st.daily).sort().forEach(function (d) {
      const r = st.daily[d] || {};
      const acc = r.total ? Math.round((r.correct || 0) / r.total * 1000) / 10 : '';
      lines.push([
        d, r.triaged || 0, r.new || 0, r.review || 0, r.total || 0,
        r.correct || 0, acc, r.seconds || 0
      ].map(csvCell).join(','));
    });
    return '﻿' + lines.join('\r\n');
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

  /* ---------------------------------------------------------------- 备份提醒 */

  /** 成功导出一份备份后调用：记下日期与当时的建档词数，立即落盘 */
  function markExported() {
    const s = get();
    s.lastExportAt = today();
    s.lastExportCount = Object.keys(s.cards).length;
    writeNow();
    return { at: s.lastExportAt, count: s.lastExportCount };
  }

  /**
   * 是否该提醒用户导出一份备份。两条阈值（满足其一即提醒）：
   *   · 从未导出且已建档 ≥ 500 个词；
   *   · 距上次导出 ≥ 7 天，或这期间又新分类 ≥ 500 个词。
   * 返回 {level:'ok'|'warn', reason, lastExportAt, lastExportCount, count}。
   */
  const EXPORT_DAYS = 7, EXPORT_WORDS = 500;
  function backupAdvice() {
    const s = get();
    const count = Object.keys(s.cards).length;
    const last = s.lastExportAt || null;
    let level = 'ok', reason = null;

    if (!last) {
      if (count >= EXPORT_WORDS) {
        level = 'warn';
        reason = '还没有导出过备份，已分类 ' + count + ' 个词，建议导出一份存到网盘或电脑。';
      }
    } else {
      const days = daysBetween(last, today());
      const delta = count - (s.lastExportCount || 0);
      if (days >= EXPORT_DAYS) {
        level = 'warn';
        reason = '距上次导出已 ' + days + ' 天，建议更新一份备份。';
      } else if (delta >= EXPORT_WORDS) {
        level = 'warn';
        reason = '自上次导出又新分类了 ' + delta + ' 个词，建议更新一份备份。';
      }
    }
    return { level: level, reason: reason, lastExportAt: last,
             lastExportCount: s.lastExportCount || 0, count: count };
  }

  /* ---------------------------------------------------------------- 导出接口 */

  return {
    KEY: KEY, BACKUP_KEY: BACKUP_KEY, CURRENT_VERSION: CURRENT_VERSION,
    load: load, get: get, save: save, flush: flush,
    consumeNotice: consumeNotice,
    getCard: getCard, setCard: setCard, removeCard: removeCard,
    bump: bump, getDaily: getDaily, snapshotLevels: snapshotLevels,
    snoozeUpgrade: snoozeUpgrade, isUpgradeSnoozed: isUpgradeSnoozed,
    listNotebooks: listNotebooks, getNotebook: getNotebook,
    createNotebook: createNotebook, renameNotebook: renameNotebook,
    removeNotebook: removeNotebook, addWordToNotebook: addWordToNotebook,
    removeWordFromNotebook: removeWordFromNotebook, notebooksOfWord: notebooksOfWord,
    exportJSON: exportJSON, toCSV: toCSV, inspectImport: inspectImport,
    commitImport: commitImport, reset: reset,
    markExported: markExported, backupAdvice: backupAdvice,
    today: today, fmt: fmt, parse: parse, addDays: addDays,
    daysBetween: daysBetween, lastNDays: lastNDays
  };
})();
