/* ===========================================================================
 *  tools/build-wordbook.js —— 生成 data/wordbook.js
 * ---------------------------------------------------------------------------
 *  输入：
 *    netem_full_list.json      2024 考研英语一大纲 5530 词 + 真题词频 + 主题分类
 *                              （骨架：决定收哪些词、词频、顺序）
 *    kaoyan_full_9602.jsonl    考研核心词详表
 *                              （富化：音标、分词性释义、例句、短语、同根词）
 *
 *  输出：data/wordbook.js
 *
 *  ⚠ 关于「常考」标注的一条硬规则
 *  ---------------------------------------------------------------------------
 *  netem 的「词频」是【单词级】的：它告诉你 row 在真题里出现过 N 次，
 *  但【不告诉你】那 N 次用的是「争吵」还是「划船」。
 *
 *  所以本脚本把词频写在【词条级】（entry.freq），
 *  绝不写进 defs[].count —— 那个字段是义项级的，
 *  用单词级数据去填它，等于把「row 出现 12 次」伪装成「争吵义常考 12 次」。
 *
 *  义项级标注需要真题原文逐句判义，目前没有语料，所以一个都不标。
 *  界面上义项旁不会出现★，只在词头显示单词级的真题词频。
 * =========================================================================== */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT  = path.join(ROOT, 'data', 'wordbook.js');

const NETEM = path.join(ROOT, 'netem_full_list.json');
const RICH  = path.join(ROOT, 'kaoyan_full_9602.jsonl');

/* ---------------------------------------------------------------- 读骨架 */

const netemRaw = JSON.parse(fs.readFileSync(NETEM, 'utf8'));
const spineKey = Object.keys(netemRaw)[0];
const spine    = netemRaw[spineKey];

console.log('骨架来源键名:', spineKey);
console.log('骨架词条数  :', spine.length);

/* ---------------------------------------------------------------- 读富化 */

const rich = Object.create(null);
let richLines = 0;
fs.readFileSync(RICH, 'utf8').split(/\r?\n/).forEach(function (line) {
  if (!line.trim()) return;
  richLines++;
  let o;
  try { o = JSON.parse(line); } catch (e) { return; }
  const hw = o.headWord;
  if (!hw) return;
  const key = String(hw).toLowerCase().trim();
  if (!rich[key]) rich[key] = o;   // 同词多条时保留第一条
});
console.log('富化行数    :', richLines, ' 可索引:', Object.keys(rich).length);

/* ---------------------------------------------------------------- 工具 */

function core(o) {
  return o && o.content && o.content.word && o.content.word.content;
}

/* 源数据里混有制表符和 "<" 之类的残留符号，统一洗掉 */
function clean(s) {
  return String(s || '')
    .replace(/[\t\r\n]+/g, ' ')
    .replace(/\s*<\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s+([；，、])/g, '$1')
    .trim();
}

function phonetic(c) {
  const us = clean(c.usphone);
  const uk = clean(c.ukphone);
  if (us && uk && us !== uk) return '美 /' + us + '/　英 /' + uk + '/';
  const one = us || uk;
  return one ? '/' + one + '/' : null;
}

/*
 * 分词性释义：[{pos:'v', tranCn:'表演；举动'}] → ['v. 表演；举动']
 *
 * 源数据的 pos 字段【有错】。例如 account 的第一条标着 pos="adj"，
 * 但释义是「叙述，说明；账目，账户」—— 明显是名词。
 *
 * 保守处理：中文形容词释义几乎都以「的」结尾（社会的、伟大的）。
 * 若标着 adj 但没有任何一段以「的」收尾，就判定这个词性标注不可信，
 * 【只去掉词性前缀、保留释义本身】—— 宁可不标，也不标错。
 * 不去猜正确词性，猜出来的东西同样没有依据。
 */
function defsFromRich(c, stat) {
  const out = [];
  (c.trans || []).forEach(function (t) {
    const zh = clean(t.tranCn);
    if (!zh) return;
    let pos = clean(t.pos);
    if (pos === 'adj') {
      const segs = zh.split(/[；;]/);
      const looksAdj = segs.some(function (s) { return /的\s*$/.test(s.trim()); });
      if (!looksAdj) { pos = ''; if (stat) stat.posDropped++; }
    }
    out.push({ text: (pos ? pos + '. ' : '') + zh });
  });
  return out;
}

/*
 * 例句筛选。
 *
 * 源数据里混着不是句子的东西，比如 row 的
 *   "(= many rows ) of shelves stacked with books"
 * 这是个搭配注解。删掉括号后剩「of shelves stacked with books」，
 * 拿去当例句既不成句也没有主语，反而干扰记忆。
 *
 * 判定：必须大写字母开头 + 以句末标点收尾 + 至少 4 个词。
 * 括号注解出现在句首的直接丢弃（删了必然剩残句）。
 */
function examples(c, limit) {
  const ss = (c.sentence && c.sentence.sentences) || [];
  const out = [];
  for (let i = 0; i < ss.length && out.length < limit; i++) {
    let en = String(ss[i].sContent || '');
    if (/^\s*\(/.test(en)) continue;                    // 括号注解开头 → 整条丢弃
    en = clean(en.replace(/\s*\(=[^)]*\)\s*/g, ' '));
    const zh = clean(String(ss[i].sCn || '').replace(/\s*\(=[^)]*\)\s*/g, ' '));
    if (!en || en.length < 12 || en.length > 130) continue;
    if (!/^[A-Z"'“]/.test(en)) continue;                // 不是大写开头 → 多半是残句
    if (!/[.!?"'”]$/.test(en)) continue;                // 没有句末标点 → 多半是残句
    if (en.split(/\s+/).length < 4) continue;
    out.push({ en: en, zh: zh });
  }
  return out;
}

/*
 * 短语筛选。
 *
 * 原始数据每词给 20 条，绝大多数是「bank account 银行账户」
 * 「row spacing 行距」这类专业名词复合词，对考研没用还挤占版面。
 *
 * 【之前的规则是错的】：我原来只留「以该词开头」的，
 * 结果把 take into account / on account of / in a row 这些
 * 最该背的固定搭配全滤掉了，反倒留下 account number 这种噪音。
 *
 * 改为：短语里【除该词以外的每个词】都必须是虚词或轻动词。
 * 这条规则精准地留下介词搭配和动词短语，排除名词复合词 ——
 * bank / spacing / death 不在表里，bank account、row spacing、
 * death row 自然被挡掉；in / on / of / take / make 在表里，
 * in a row、on account of、take into account 全部保留。
 */
const FUNCTION_WORDS = (
  'a an the of to in on at by for from with without within into onto out up down off over ' +
  'under above below across along among around after before behind beside between beyond ' +
  'during except near past since through throughout till toward towards until upon against ' +
  'about back away as so not no one ones oneself sb sth its their his her your my our ' +
  'be is are was were been being do does did done make makes made made take takes taken took ' +
  'get gets got give gives given gave put puts come comes came go goes went have has had ' +
  'keep keeps kept bring brings brought hold holds held set sets lay lays laid run runs ran ' +
  'fall falls fell reach reaches reached pay pays paid lose loses lost find finds found ' +
  'look looks looked turn turns turned call calls called and or'
).split(/\s+/).reduce(function (m, w) { m[w] = 1; return m; }, Object.create(null));

const PARTICLES = ('of to in on at by for from with into out up down off over about against as').
  split(/\s+/).reduce(function (m, w) { m[w] = 1; return m; }, Object.create(null));

/*
 * 考研阅读/写作里真正高频的固定搭配骨架。
 * 命中这些模式的短语优先级最高 —— 它们是实打实的得分点，
 * 而「row out 使划得精疲力尽」这种罕见动词短语背了没用。
 */
const COMMON_FRAMES = [
  /^in a /, /^on account of$/, /^take .* into /, /^take into /, /^in terms of$/,
  /^in the /, /^at the /, /^by the /, /^for the /, /^out of /, /^as a /,
  /^make a /, /^have a /, /^give a /, /^come to /, /^lead to /, /^due to /,
  /^in order /, /^so as /, /^rather than/, /^instead of/, /^regardless of/
];

function phrases(c, head, limit) {
  const ps = (c.phrase && c.phrase.phrases) || [];
  const h = head.toLowerCase();
  const scored = [];

  ps.forEach(function (p) {
    const en = clean(p.pContent);
    let zh = clean(p.pCn).replace(/^(v|n|adj|adv|vt|vi)\.\s*/i, '').replace(/^\[[^\]]*\]\s*/, '');
    if (!en || !zh || zh.length < 2) return;

    const low = en.toLowerCase();
    const toks = low.split(/\s+/);
    if (toks.length < 2 || toks.length > 4) return;
    if (toks.indexOf(h) < 0) return;                    // 必须真的含这个词

    // 除该词以外，其余每个词都得是虚词/轻动词，否则判为名词复合词
    const ok = toks.every(function (t) { return t === h || FUNCTION_WORDS[t]; });
    if (!ok) return;

    let score = 0;
    // 高频固定搭配骨架优先级最高
    if (COMMON_FRAMES.some(function (re) { return re.test(low); })) score += 5;
    // 该词后面直接跟小品词（account for / wink at）是常考形式
    const hi = toks.indexOf(h);
    if (hi >= 0 && hi < toks.length - 1 && PARTICLES[toks[hi + 1]]) score += 3;
    if (toks.length <= 3) score += 1;
    if (toks.some(function (t) { return PARTICLES[t]; })) score += 1;

    scored.push({ text: en, zh: zh, _s: score });
  });

  scored.sort(function (a, b) { return b._s - a._s || a.text.length - b.text.length; });
  return scored.slice(0, limit).map(function (p) { return { text: p.text, zh: p.zh }; });
}

function related(c, limit) {
  const rels = (c.relWord && c.relWord.rels) || [];
  const out = [];
  const seen = Object.create(null);
  rels.forEach(function (r) {
    (r.words || []).forEach(function (w) {
      if (out.length >= limit) return;
      const hwd = clean(w.hwd);
      if (!hwd || seen[hwd]) return;
      seen[hwd] = 1;
      // 砍掉过长的释义串，卡片上只需要认出这是个同根词
      let tran = clean(w.tran).split(/[；;]/)[0].trim();
      if (tran.length > 18) tran = tran.slice(0, 18) + '…';
      out.push(hwd + (r.pos ? ' ' + r.pos + '.' : '') + ' ' + tran);
    });
  });
  return out;
}

/* ---------------------------------------------------------------- 合并 */

const words = [];
const stat = {
  hit: 0, missRich: 0, withPhone: 0, withEx: 0, withPhrase: 0,
  withRel: 0, richDefs: 0, netemDefs: 0, noDef: 0, freqZero: 0,
  posDropped: 0
};
const missSamples = [];

spine.forEach(function (row) {
  const head = String(row['单词'] || '').trim();
  if (!head) return;

  const freq = Number(row['词频']) || 0;
  if (!freq) stat.freqZero++;

  const entry = { word: head };

  const r = rich[head.toLowerCase()];
  const c = r ? core(r) : null;

  if (c) {
    stat.hit++;
    const ph = phonetic(c);
    if (ph) { entry.phonetic = ph; stat.withPhone++; }

    const ds = defsFromRich(c, stat);
    if (ds.length) { entry.defs = ds; stat.richDefs++; }

    const ex = examples(c, 2);
    if (ex.length) { entry.examples = ex; stat.withEx++; }

    const phr = phrases(c, head, 4);
    if (phr.length) { entry.phrases = phr; stat.withPhrase++; }

    const rel = related(c, 5);
    if (rel.length) { entry.related = rel; stat.withRel++; }
  } else {
    stat.missRich++;
    if (missSamples.length < 30) missSamples.push(head);
  }

  /* 富化没给出释义时，回退到大纲表的简释 */
  if (!entry.defs || !entry.defs.length) {
    const zh = String(row['释义'] || '').trim();
    if (zh) { entry.defs = [{ text: zh }]; stat.netemDefs++; }
    else    { entry.defs = [{ text: '（缺释义）' }]; stat.noDef++; }
  }

  /* 单词级真题词频 —— 注意不写进 defs[].count，理由见文件头 */
  entry.freq = freq;
  entry.rank = Number(row['序号']) || null;

  const topic = String(row['分类'] || '').trim();
  const sub   = String(row['子分类'] || '').trim();
  if (topic) entry.topic = topic + (sub ? ' · ' + sub : '');

  const alt = row['其他拼写'];
  if (alt && String(alt).trim()) entry.alt = String(alt).trim();

  words.push(entry);
});

/* ---------------------------------------------------------------- 输出 */

const book = {
  name: '考研英语一大纲词汇 5530',
  corpus: '真题词频基于约 200 套历年试卷统计（单词级，非义项级）',
  freqNote: '词频指该单词在真题中出现的总次数，不区分义项。',
  source: '词表：2024 考研英语一大纲 5530 词；释义/音标/例句/同根词：考研核心词详表',
  demo: false,
  hasFreq: true,
  words: words
};

const header =
'/* 自动生成，请勿手改 —— 由 tools/build-wordbook.js 生成\n' +
' *\n' +
' * freq 是【单词级】真题词频，不区分义项。\n' +
' * 义项旁不打★：判断哪个义项常考需要真题原文逐句判义，\n' +
' * 目前没有语料，所以一条都不标，界面留白。\n' +
' */\n';

fs.writeFileSync(OUT, header + 'window.WORDBOOK = ' + JSON.stringify(book) + ';\n', 'utf8');

/* ---------------------------------------------------------------- 报告 */

const size = fs.statSync(OUT).size;
console.log('');
console.log('=== 合并结果 ===');
console.log('输出词条        :', words.length);
console.log('命中富化数据    :', stat.hit, '(' + (stat.hit / words.length * 100).toFixed(1) + '%)');
console.log('未命中(用简释)  :', stat.missRich);
console.log('  未命中样例    :', missSamples.slice(0, 20).join(', '));
console.log('---');
console.log('有音标          :', stat.withPhone, '(' + (stat.withPhone / words.length * 100).toFixed(1) + '%)');
console.log('有分词性释义    :', stat.richDefs, '(' + (stat.richDefs / words.length * 100).toFixed(1) + '%)');
console.log('回退到大纲简释  :', stat.netemDefs);
console.log('完全无释义      :', stat.noDef);
console.log('有例句          :', stat.withEx, '(' + (stat.withEx / words.length * 100).toFixed(1) + '%)');
console.log('有短语搭配      :', stat.withPhrase);
console.log('有同根词        :', stat.withRel);
console.log('剔除可疑词性标注:', stat.posDropped, '(源数据 pos=adj 但释义不像形容词，只去前缀、保留释义)');
console.log('---');
console.log('词频为 0 的词    :', stat.freqZero, '(大纲收录但约200套真题中未出现)');
console.log('输出文件大小    :', (size / 1024 / 1024).toFixed(2), 'MB');
console.log('输出路径        :', OUT);
