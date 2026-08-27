/* ===========================================================================
 *  wordbook.js —— 词库访问层
 * ---------------------------------------------------------------------------
 *  统一处理词条的字段缺失、义项筛选、干扰项抽取。
 *  上层（普查/复习/词书页）只调这里的方法，不直接碰 window.WORDBOOK。
 * =========================================================================== */

window.WB = (function () {
  'use strict';

  let book  = null;
  let index = {};        // word -> 下标
  let words = [];
  let byTopic = {};      // 主题分类 -> [下标]

  function init() {
    book = window.WORDBOOK || { name: '(未加载)', words: [] };
    words = book.words || [];
    index = {};
    byTopic = {};
    words.forEach(function (w, i) {
      index[w.word] = i;
      const t = w.topic;
      if (t) {
        if (!byTopic[t]) byTopic[t] = [];
        byTopic[t].push(i);
      }
    });
    return book;
  }

  function meta() {
    if (!book) init();
    return {
      name:      book.name || '未命名词库',
      corpus:    book.corpus || '',
      freqNote:  book.freqNote || '',
      source:    book.source || '',
      demo:      !!book.demo,
      hasFreq:   !!book.hasFreq,
      total:     words.length
    };
  }

  function all()         { if (!book) init(); return words; }
  function size()        { return all().length; }
  function at(i)         { return all()[i] || null; }
  function get(word)     { const i = index[word]; return i === undefined ? null : words[i]; }
  function indexOf(word) { const i = index[word]; return i === undefined ? -1 : i; }
  function hasFreq()     { return meta().hasFreq; }

  /* ------------------------------------------------------------ 义项筛选 */

  /**
   * 用于「学习」的义项 —— 复习正面、选择题答案与干扰项都用这个。
   *
   * 规则：排除 tag === 'rare' 的义项。
   * 但如果一个词【全部】义项都是 rare（或压根没有 tag），
   * 则退回全部义项 —— 否则这些词会没有答案文本可用，直接从复习里消失。
   *
   * 换句话说，「生僻义不作为答案」是相对该词自身的其他义项而言，不是绝对排除。
   */
  function studyDefs(entry) {
    const defs = (entry && entry.defs) || [];
    const useful = defs.filter(function (d) { return d.tag !== 'rare'; });
    return useful.length ? useful : defs;
  }

  /** 生僻义（默认折叠的那部分）。没有分级标注的词返回空数组 */
  function rareDefs(entry) {
    const defs = (entry && entry.defs) || [];
    const useful = defs.filter(function (d) { return d.tag !== 'rare'; });
    return useful.length ? defs.filter(function (d) { return d.tag === 'rare'; }) : [];
  }

  /** 选择题选项用的短释义文本 */
  function shortDef(entry, maxLen) {
    const d = studyDefs(entry)[0];
    if (!d) return '（无释义）';
    const t = d.text || '';
    const lim = maxLen || 28;
    return t.length > lim ? t.slice(0, lim) + '…' : t;
  }

  /* ------------------------------------------------------------ 真题依据 */

  /**
   * 单词级真题词频。
   *
   * 【重要】这个数字是单词级的：它说明该词在真题里出现过多少次，
   * 【不说明】用的是哪个义项。所以它只能显示在词头，
   * 绝不能挂到某个义项旁边冒充「这个义项常考」。
   */
  function freqOf(entry) {
    return (entry && Number(entry.freq)) || 0;
  }

  /** 大纲收录但真题中从未出现过的词 —— 可以放心降优先级 */
  function isNeverTested(entry) {
    return hasFreq() && entry && entry.freq === 0;
  }

  /** 义项级真题标注（★）—— 需要真题语料逐句判义才能生成，目前一律为无 */
  function hasCitations(entry) {
    if (!entry) return false;
    const inDefs = (entry.defs || []).some(function (d) { return (d.count || 0) > 0; });
    const inPhr  = (entry.phrases || []).some(function (p) { return (p.count || 0) > 0; });
    return inDefs || inPhr;
  }

  function citationCount(entry) {
    if (!entry) return 0;
    let n = 0;
    (entry.defs || []).forEach(function (d) { n += d.count || 0; });
    (entry.phrases || []).forEach(function (p) { n += p.count || 0; });
    return n;
  }

  /* ------------------------------------------------------------ 干扰项抽取 */

  /**
   * 为选择题抽 n 个干扰项。
   *
   * 优先级：
   *   1) 同一主题分类内的词 —— 「政治法律」里的词互相混淆，比随便找个词当干扰项
   *      有训练价值得多。这是词库带的 18 类分类给的便利。
   *   2) 词表相邻位置 —— 本词库按真题词频降序排列，相邻即难度相近，
   *      不会拿一个超高频词去干扰一个冷僻词（那种选项一眼就能排除）。
   *   3) 全表随机兜底。
   */
  function distractors(entry, n, filterFn) {
    const total = size();
    const self  = indexOf(entry.word);
    const picked = [];
    const used = {};
    if (self >= 0) used[self] = true;

    const selfDef = shortDef(entry);

    function tryPush(i) {
      if (picked.length >= n) return;
      if (i < 0 || i >= total || used[i]) return;
      const cand = words[i];
      if (!cand || !cand.word) return;
      if (filterFn && !filterFn(cand)) return;
      // 释义与正确答案相同的不能当干扰项，否则「正确答案」有歧义
      if (shortDef(cand) === selfDef) return;
      used[i] = true;
      picked.push(cand);
    }

    // 1) 同主题
    if (entry.topic && byTopic[entry.topic] && byTopic[entry.topic].length > 1) {
      const pool = byTopic[entry.topic].slice();
      shuffle(pool);
      for (let k = 0; k < pool.length && picked.length < n; k++) tryPush(pool[k]);
    }

    // 2) 词表相邻（= 词频相近 = 难度相近）
    if (picked.length < n && self >= 0) {
      const WINDOW = 60;
      const offsets = [];
      for (let d = 1; d <= WINDOW; d++) { offsets.push(d); offsets.push(-d); }
      shuffle(offsets);
      for (let k = 0; k < offsets.length && picked.length < n; k++) tryPush(self + offsets[k]);
    }

    // 3) 全表随机兜底
    let guard = 0;
    while (picked.length < n && guard++ < total * 2 + 50) {
      tryPush(Math.floor(Math.random() * total));
    }
    return picked;
  }

  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }

  /** 所有主题分类（词书页筛选用），按词条数降序 */
  function topics() {
    if (!book) init();
    return Object.keys(byTopic).sort(function (a, b) {
      return byTopic[b].length - byTopic[a].length;
    });
  }

  return {
    init: init, meta: meta, topics: topics,
    all: all, size: size, at: at, get: get, indexOf: indexOf,
    studyDefs: studyDefs, rareDefs: rareDefs, shortDef: shortDef,
    hasFreq: hasFreq, freqOf: freqOf, isNeverTested: isNeverTested,
    hasCitations: hasCitations, citationCount: citationCount,
    distractors: distractors, shuffle: shuffle
  };
})();
