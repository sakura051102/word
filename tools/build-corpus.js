/* ===========================================================================
 *  tools/build-corpus.js —— 生成 data/corpus.js（真题原句索引）
 * ---------------------------------------------------------------------------
 *  输入：真题语料/考研英语一阅读文本/{年份}/{Text1-5,Trans}.md
 *        1998–2022，147 篇，约 412 KB
 *  输出：data/corpus.js
 *
 *  ⚠ 这是【词条级】索引，不是【义项级】。
 *  ---------------------------------------------------------------------------
 *  它回答的是「这个词在真题里长什么样」，不回答「这个词的哪个义项常考」。
 *  后者需要逐句判断词义（词义消歧），做错了比不做更糟 ——
 *  把 state 标成「状态常考」而真题里考的是「规定」，是在主动误导。
 *
 *  所以这里只做一件有把握的事：把真题原句原样搬过来。
 *  你看到 state 在 5 个真题句子里怎么用，自己就能判断该背哪个义 ——
 *  这比一个猜出来的标签可靠。
 *
 *  =========================================================================
 *  关于匹配方向：为什么是「还原」而不是「展开」
 *  =========================================================================
 *  直觉做法是给每个词头展开词形（state → states/stated/stating）再去搜。
 *  这个方向【会误伤】：
 *      car  + ed  → cared    但 cared 其实来自 care
 *      be   + d   → bed      bed 是另一个词
 *  展开是「一对多猜测」，没有任何东西能验证猜得对不对。
 *
 *  这里反过来做：把语料里出现的每个 token 做词形【还原】，
 *  再看还原结果是不是大纲词表里的词头。
 *      cared → 先试去 -d → care ✓（在词表里，采纳）
 *      worked → 去 -d → worke ✗ → 去 -ed → work ✓
 *  「必须落在 5530 个词头之内」这条约束把绝大多数错误挡住了，
 *  而展开方向没有这样的约束。
 *
 *  运行： node tools/build-corpus.js
 * =========================================================================== */

const fs   = require('fs');
const path = require('path');

const ROOT   = path.join(__dirname, '..');
const CORPUS = path.join(ROOT, '真题语料', '考研英语一阅读文本');
const OUT    = path.join(ROOT, 'data', 'corpus.js');

/* 每个词最多收几句。3 句足够看出用法，再多是在给手机加载量做无用功。 */
const MAX_PER_WORD = 3;

/* ---------------------------------------------------------------- 词表 */

global.window = global;
require(path.join(ROOT, 'data', 'wordbook.js'));
const BOOK = window.WORDBOOK;

/*
 * 表面形 → 规范词头 的查找表。
 *
 * 不能只用词头本身：大纲带了「其他拼写」字段（build-wordbook.js 存进 entry.alt），
 * 英美拼写差异全在里面 —— 真题原文用的是 practice，而词表词头是 practise。
 * 不挂上别名，practice 会被判成「超纲词」整条丢掉，
 * 而它在真题里出现了几十次。
 */
const LOOKUP = Object.create(null);
let aliasCount = 0;
BOOK.words.forEach(function (e) {
  const head = String(e.word).toLowerCase();
  if (!(head in LOOKUP)) LOOKUP[head] = head;
});
BOOK.words.forEach(function (e) {
  const head = String(e.word).toLowerCase();
  if (!e.alt) return;
  String(e.alt).split(/[,，;；/、\s]+/).forEach(function (a) {
    const k = a.toLowerCase().trim();
    // 别名不能覆盖已有词头（比如某词的别名恰好是另一个词的正名）
    if (k && k.length >= 2 && !(k in LOOKUP)) { LOOKUP[k] = head; aliasCount++; }
  });
});
function canon(x) { return LOOKUP[x] || null; }

console.log('词表词头数:', BOOK.words.length, '  另收别名拼写:', aliasCount);

/* ---------------------------------------------------------------- 读语料 */

function listFiles(dir) {
  const out = [];
  fs.readdirSync(dir, { withFileTypes: true }).forEach(function (d) {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) out.push.apply(out, listFiles(p));
    else if (/\.md$/i.test(d.name)) out.push(p);
  });
  return out;
}

/**
 * 抽正文。
 *
 * 文件格式是 obsidian-language-learner 插件的：
 *   ---
 *   langr-origin: 2018-英语一-Text1     ← 出处，直接拿来当来源标签
 *   ---
 *   ^^^article
 *   （正文）
 *   ^^^words
 *   （生词表，不要）
 */
function parseFile(file) {
  const raw = fs.readFileSync(file, 'utf8');

  let src = '';
  const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (fm) {
    const m = fm[1].match(/langr-origin\s*:\s*(.+)/);
    if (m) src = m[1].trim();
  }
  if (!src) {
    // 兜底：从路径推。2018/Text1.md → 2018-英语一-Text1
    const parts = file.split(/[\\/]/);
    src = parts[parts.length - 2] + '-英语一-' + parts[parts.length - 1].replace(/\.md$/i, '');
  }

  let body = raw;
  const a = body.indexOf('^^^article');
  if (a >= 0) body = body.slice(a + '^^^article'.length);
  const w = body.indexOf('^^^words');
  if (w >= 0) body = body.slice(0, w);

  body = body
    .replace(/^---[\s\S]*?---/m, ' ')
    .replace(/\(\s*\d{2}\s*\)/g, ' ')      // 翻译题的 (46)(47) 题号
    .replace(/[_*`>#]/g, ' ')              // markdown 标记
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\r/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim();

  return { src: src, body: body };
}

/* ---------------------------------------------------------------- 断句 */

/*
 * 英文断句的经典坑是缩写点：
 *   "About half of U.S. jobs are at high risk"
 * 按「句号 + 空格」切会把它切成两句，得到两条残句。
 *
 * 两道防线：
 *   1) 句号后面必须跟大写字母/引号才可能是句末
 *      —— 上面这句后面是小写 jobs，直接排除
 *   2) 句号前面那一截如果是已知缩写、单个字母、或 u.s / e.g 这种
 *      点分形式，也排除
 */
const ABBREV = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'st', 'vs', 'etc', 'inc', 'ltd', 'co',
  'corp', 'jr', 'sr', 'vol', 'fig', 'no', 'dept', 'univ', 'assn', 'est',
  'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sept', 'sep', 'oct', 'nov', 'dec'
]);

function isAbbrevEnd(seg) {
  const m = seg.match(/([A-Za-z][A-Za-z.]*)\.$/);
  if (!m) return false;
  const w = m[1].toLowerCase().replace(/\.+$/, '');
  if (ABBREV.has(w)) return true;
  if (/^[a-z]$/.test(w)) return true;                 // 首字母缩写 J. K.
  if (/^([a-z]\.)+[a-z]$/.test(w)) return true;       // u.s / e.g / i.e
  return false;
}

function splitSentences(text) {
  const out = [];
  let start = 0;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch !== '.' && ch !== '!' && ch !== '?') continue;

    // 吃掉紧跟的引号/右括号
    let j = i + 1;
    while (j < text.length && '"\')]”’'.indexOf(text[j]) >= 0) j++;
    if (j >= text.length) break;
    if (!/\s/.test(text[j])) continue;          // 3.5 / U.S.A 这类，不是句末

    let k = j;
    while (k < text.length && /\s/.test(text[k])) k++;
    if (k >= text.length) break;
    if (!/[A-Z"'“(]/.test(text[k])) continue;   // 防线 1
    if (ch === '.' && isAbbrevEnd(text.slice(start, i + 1))) continue;  // 防线 2

    const s = text.slice(start, j).trim();
    if (s) out.push(s);
    start = k;
  }
  const tail = text.slice(start).trim();
  if (tail) out.push(tail);
  return out;
}

/* ---------------------------------------------------------------- 词形还原 */

/*
 * 不规则变化表。
 *
 * 规则化的去后缀对 worked / studies 有效，但对 took / children 完全无能 ——
 * 它们跟词干长得不一样，没有后缀可去。这类词又恰恰是最高频的一批，
 * 漏掉它们等于让 take / find / think / child 这些常用词丢掉大量真题例句。
 *
 * 只收「大纲词表里真的有对应词头」的那些，冷僻的不收。
 */
const IRREGULAR = {
  /* be / have / do */
  is: 'be', am: 'be', are: 'be', was: 'be', were: 'be', been: 'be', being: 'be',
  has: 'have', had: 'have', having: 'have',
  does: 'do', did: 'do', done: 'do', doing: 'do',
  an: 'a',
  cannot: 'can', wont: 'will', cant: 'can',

  /* 常用不规则动词 */
  took: 'take', taken: 'take',
  came: 'come', become: 'become', became: 'become',
  went: 'go', gone: 'go',
  saw: 'see', seen: 'see',
  made: 'make',
  said: 'say',
  got: 'get', gotten: 'get',
  knew: 'know', known: 'know',
  thought: 'think',
  found: 'find',
  gave: 'give', given: 'give',
  told: 'tell',
  felt: 'feel',
  left: 'leave',
  kept: 'keep',
  brought: 'bring',
  bought: 'buy',
  caught: 'catch',
  taught: 'teach',
  sought: 'seek',
  fought: 'fight',
  held: 'hold',
  meant: 'mean',
  met: 'meet',
  paid: 'pay',
  put: 'put',
  ran: 'run',
  sat: 'sit',
  sent: 'send',
  spent: 'spend',
  stood: 'stand', understood: 'understand',
  won: 'win',
  wrote: 'write', written: 'write',
  spoke: 'speak', spoken: 'speak',
  broke: 'break', broken: 'break',
  chose: 'choose', chosen: 'choose',
  drove: 'drive', driven: 'drive',
  ate: 'eat', eaten: 'eat',
  fell: 'fall', fallen: 'fall',
  flew: 'fly', flown: 'fly',
  forgot: 'forget', forgotten: 'forget',
  grew: 'grow', grown: 'grow',
  heard: 'hear',
  hid: 'hide', hidden: 'hide',
  led: 'lead',
  lost: 'lose',
  lay: 'lie', lain: 'lie',
  laid: 'lay',
  read: 'read',
  rose: 'rise', risen: 'rise',
  sold: 'sell',
  showed: 'show', shown: 'show',
  shut: 'shut',
  slept: 'sleep',
  spread: 'spread',
  swam: 'swim',
  threw: 'throw', thrown: 'throw',
  woke: 'wake', woken: 'wake',
  wore: 'wear', worn: 'wear',
  built: 'build',
  burnt: 'burn',
  dealt: 'deal',
  drew: 'draw', drawn: 'draw',
  drank: 'drink', drunk: 'drink',
  began: 'begin', begun: 'begin',
  bore: 'bear', born: 'bear', borne: 'bear',
  beat: 'beat', beaten: 'beat',
  bound: 'bind',
  cost: 'cost',
  cut: 'cut',
  hit: 'hit',
  hurt: 'hurt',
  let: 'let',
  set: 'set',
  shot: 'shoot',
  sang: 'sing', sung: 'sing',
  sank: 'sink', sunk: 'sink',
  struck: 'strike',
  swept: 'sweep',
  wound: 'wind',

  /* 不规则复数 */
  children: 'child',
  men: 'man', women: 'woman',
  feet: 'foot', teeth: 'tooth',
  geese: 'goose', mice: 'mouse',
  people: 'people',
  lives: 'life', wives: 'wife', knives: 'knife', leaves: 'leaf',
  wolves: 'wolf', shelves: 'shelf', halves: 'half', selves: 'self',
  data: 'data', media: 'medium', criteria: 'criterion',
  phenomena: 'phenomenon', analyses: 'analysis', bases: 'basis',
  crises: 'crisis', theses: 'thesis', hypotheses: 'hypothesis',

  /* 比较级最高级 */
  better: 'good', best: 'good',
  worse: 'bad', worst: 'bad',
  more: 'much', most: 'much', less: 'little', least: 'little',
  further: 'far', furthest: 'far', farther: 'far', farthest: 'far'
};

/* 缩写：don’t → do，they’re → they。撇号有直角和弯角两种，都要吃掉。 */
function stripContraction(tok) {
  return tok
    .replace(/['’](s|re|ve|ll|d|m)$/, '')
    .replace(/n['’]t$/, '');
}

/**
 * 单轮去后缀。返回所有候选（不判断是否在词表里）。
 *
 * 顺序有讲究：-d 必须排在 -ed 前面。
 *   cared：-d → care ✓（正确）
 *          若先试 -ed → car ✗（错误，car 也在词表里，会被误采纳）
 *   worked：-d → worke ✗（不在词表，落空）→ -ed → work ✓
 * 也就是说「词表约束」帮我们淘汰了错误分支，前提是正确分支先被试到。
 */
function strip(tok) {
  const cands = [];
  const add = function (x) { if (x && x.length >= 2) cands.push(x); };

  if (/ies$/.test(tok))  { add(tok.slice(0, -3) + 'y'); add(tok.slice(0, -2)); }
  if (/ied$/.test(tok))  { add(tok.slice(0, -3) + 'y'); }
  if (/ier$/.test(tok))  { add(tok.slice(0, -3) + 'y'); }
  if (/iest$/.test(tok)) { add(tok.slice(0, -4) + 'y'); }
  if (/ily$/.test(tok))  { add(tok.slice(0, -3) + 'y'); }
  if (/es$/.test(tok))   { add(tok.slice(0, -2)); }
  if (/s$/.test(tok) && !/ss$/.test(tok)) { add(tok.slice(0, -1)); }
  if (/d$/.test(tok))    { add(tok.slice(0, -1)); }   // ← 必须在 -ed 之前
  if (/ed$/.test(tok))   { add(tok.slice(0, -2)); }
  if (/ing$/.test(tok))  {
    add(tok.slice(0, -3) + 'e');                      // caring → care
    add(tok.slice(0, -3));                            // working → work
  }
  // 末辅音双写：planned → plan，running → run
  if (/([bcdfglmnprstvz])\1(ed|ing|er|est)$/.test(tok)) {
    add(tok.replace(/([bcdfglmnprstvz])\1(ed|ing|er|est)$/, '$1'));
  }
  if (/ly$/.test(tok))   { add(tok.slice(0, -2)); }
  // probably → probable，simply → simple：-ly 直接砍会剩 probab / simp，都不成词
  if (/bly$/.test(tok))  { add(tok.slice(0, -3) + 'ble'); }
  if (/ally$/.test(tok)) { add(tok.slice(0, -4) + 'al'); add(tok.slice(0, -4) + 'ic'); }
  if (/er$/.test(tok))   { add(tok.slice(0, -2)); add(tok.slice(0, -1)); }
  if (/est$/.test(tok))  { add(tok.slice(0, -3)); add(tok.slice(0, -2)); }
  // 形容词后缀 -al：traditional → tradition，cultural → culture
  if (/al$/.test(tok))   { add(tok.slice(0, -2)); add(tok.slice(0, -2) + 'e'); }
  // technological → technology，historical → history
  if (/ical$/.test(tok)) { add(tok.slice(0, -4) + 'y'); add(tok.slice(0, -2)); }
  // 常见派生后缀，让 consumers → consumer → consume 这类两步链走得通
  if (/ment$/.test(tok)) { add(tok.slice(0, -4)); }
  if (/ness$/.test(tok)) { add(tok.slice(0, -4)); }
  if (/tion$/.test(tok)) { add(tok.slice(0, -3) + 'e'); add(tok.slice(0, -4) + 'e'); }
  if (/ation$/.test(tok)){ add(tok.slice(0, -5) + 'e'); add(tok.slice(0, -5)); }

  return cands;
}

/*
 * 两轮还原。
 *
 * 一轮解决不了「多重派生」：
 *   consumers → (去 -s) consumer → (去 -er) consume ✓
 *   researchers → researcher → research ✓
 * 中间那个 consumer 本身不在大纲词表里，所以单轮会落空。
 *
 * 只走两轮，不走更多：轮数越多误判越大，
 * 而三重派生（如 nationalizations）在真题里少到不值得为它冒险。
 */
function lemma(raw) {
  const tok = stripContraction(raw);
  if (!tok || tok.length < 2) return null;

  let c = canon(tok);
  if (c) return c;
  if (IRREGULAR[tok]) { c = canon(IRREGULAR[tok]); if (c) return c; }

  const first = strip(tok);
  for (let i = 0; i < first.length; i++) {
    c = canon(first[i]);
    if (c) return c;
  }
  for (let i = 0; i < first.length; i++) {
    const second = strip(first[i]);
    for (let j = 0; j < second.length; j++) {
      c = canon(second[j]);
      if (c) return c;
    }
  }
  return null;
}

/* 还原结果缓存：语料里 token 重复度很高，算一次就够 */
const lemmaCache = Object.create(null);
function lemmaOf(tok) {
  if (tok in lemmaCache) return lemmaCache[tok];
  return (lemmaCache[tok] = lemma(tok));
}

/* ---------------------------------------------------------------- 打分 */

/*
 * 一个词可能在真题里出现几十次，只留 3 句，得挑好的。
 *
 * 太短的（<8 词）看不出用法；太长的（>34 词）在手机屏上是一堵墙，
 * 而考研阅读里 40 词以上的长难句真的存在。取中间段。
 */
function scoreSentence(sent, wordPos, nTokens) {
  let s = 0;
  if (nTokens >= 8 && nTokens <= 34) s += 6;
  else if (nTokens >= 6 && nTokens <= 44) s += 2;
  else s -= 4;

  // 目标词在句首时，往往是代词回指或话题句，上下文信息少
  if (wordPos > 0) s += 2;
  if (wordPos >= 2 && wordPos <= nTokens - 3) s += 1;

  // 带分号/破折号的长句多半是嵌套结构，读起来费劲
  if (/[;—]/.test(sent)) s -= 1;
  return s;
}

/* ---------------------------------------------------------------- 主流程 */

if (!fs.existsSync(CORPUS)) {
  console.error('找不到语料目录:', CORPUS);
  console.error('先执行: cd 真题语料 && git fetch origin main:main && git checkout main');
  process.exit(1);
}

const files = listFiles(CORPUS).sort();
console.log('语料文件数:', files.length);

const srcs  = [];          // 出处列表
const sents = [];          // [srcIdx, 句子]
const hits  = Object.create(null);   // 词头 -> [{si, score, year}]

const stat = { sentences: 0, tokens: 0, matched: 0, unmatched: 0 };
const unmatchedSample = Object.create(null);

files.forEach(function (file) {
  const { src, body } = parseFile(file);
  const srcIdx = srcs.push(src) - 1;
  const year = (src.match(/^(\d{4})/) || [])[1] || '';

  splitSentences(body).forEach(function (sent) {
    // 词元切分：保留撇号（don't / company's），其余按非字母切
    const toks = sent.toLowerCase().match(/[a-z][a-z'’-]*/g) || [];
    if (toks.length < 5) return;

    stat.sentences++;
    const si = sents.push([srcIdx, sent]) - 1;

    const seenHere = Object.create(null);
    toks.forEach(function (raw, pos) {
      const tok = raw.replace(/['’]s$/, '').replace(/^-+|-+$/g, '');
      if (tok.length < 2) return;
      stat.tokens++;

      const lem = lemmaOf(tok);
      if (!lem) {
        stat.unmatched++;
        if (!unmatchedSample[tok]) unmatchedSample[tok] = 0;
        unmatchedSample[tok]++;
        return;
      }
      stat.matched++;
      if (seenHere[lem]) return;          // 同句同词只记一次
      seenHere[lem] = 1;

      if (!hits[lem]) hits[lem] = [];
      hits[lem].push({ si: si, score: scoreSentence(sent, pos, toks.length), year: year });
    });
  });
});

/* --- 每个词挑最多 MAX_PER_WORD 句，尽量分散在不同年份 --- */

const index = Object.create(null);
const usedSents = Object.create(null);

Object.keys(hits).forEach(function (w) {
  const list = hits[w].slice().sort(function (a, b) {
    return b.score - a.score || a.si - b.si;
  });

  const picked = [];
  const yearsUsed = Object.create(null);

  // 第一轮：每年最多取一句，保证年份分散
  for (let i = 0; i < list.length && picked.length < MAX_PER_WORD; i++) {
    if (yearsUsed[list[i].year]) continue;
    yearsUsed[list[i].year] = 1;
    picked.push(list[i].si);
  }
  // 第二轮：还不够就放宽
  for (let i = 0; i < list.length && picked.length < MAX_PER_WORD; i++) {
    if (picked.indexOf(list[i].si) < 0) picked.push(list[i].si);
  }

  if (picked.length) {
    index[w] = picked;
    picked.forEach(function (si) { usedSents[si] = 1; });
  }
});

/* --- 压缩：只保留真正被引用到的句子，并重新编号 --- */

/*
 * 语料里一共几千句，但被选中的是其中一部分。
 * 不做这一步会把没人引用的句子也打包进去，白白增加手机的加载量。
 */
const keep = Object.keys(usedSents).map(Number).sort(function (a, b) { return a - b; });
const remap = Object.create(null);
const outSents = keep.map(function (si, i) { remap[si] = i; return sents[si]; });

Object.keys(index).forEach(function (w) {
  index[w] = index[w].map(function (si) { return remap[si]; });
});

/* ---------------------------------------------------------------- 输出 */

const data = {
  name: '考研英语一历年阅读真题原句',
  scope: '词条级',
  note: '这些是含该单词的真题原句，不区分义项 —— 句中用的是哪个意思，请自己判断。',
  years: (function () {
    const ys = srcs.map(function (s) { return (s.match(/^(\d{4})/) || [])[1]; }).filter(Boolean);
    return ys.length ? Math.min.apply(null, ys) + '–' + Math.max.apply(null, ys) : '';
  })(),
  texts: srcs.length,
  srcs: srcs,
  sents: outSents,
  index: index
};

const header =
'/* 自动生成，请勿手改 —— 由 tools/build-corpus.js 生成\n' +
' *\n' +
' * 这是【词条级】真题原句索引：只保证「这句话里有这个词」，\n' +
' * 【不保证】句中用的是你正在看的那个义项。\n' +
' * 义项级标注需要逐句词义消歧，做错比不做更糟，所以不做。\n' +
' */\n';

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, header + 'window.CORPUS = ' + JSON.stringify(data) + ';\n', 'utf8');

/* ---------------------------------------------------------------- 报告 */

const size = fs.statSync(OUT).size;
const covered = Object.keys(index).length;
const topUnmatched = Object.keys(unmatchedSample)
  .sort(function (a, b) { return unmatchedSample[b] - unmatchedSample[a]; })
  .slice(0, 20);

console.log('');
console.log('=== 语料统计 ===');
console.log('句子总数        :', stat.sentences);
console.log('保留句子        :', outSents.length, '（只留被引用到的）');
console.log('词元总数        :', stat.tokens);
console.log('还原到词表      :', stat.matched,
            '(' + (stat.matched / stat.tokens * 100).toFixed(1) + '%)');
console.log('未能还原        :', stat.unmatched,
            '(多为人名地名和超纲词，属正常)');
console.log('  高频未还原样例:', topUnmatched.join(', '));
console.log('');
console.log('=== 覆盖 ===');
console.log('有真题原句的词  :', covered, '/', BOOK.words.length,
            '(' + (covered / BOOK.words.length * 100).toFixed(1) + '%)');

/*
 * 【总覆盖率是个有误导性的数字】
 *
 * 大纲收了 5530 个词，其中两百多个在约 200 套真题里一次都没出现过 ——
 * 25 年的阅读文本里当然也找不到它们。拿这些词去拉低分母，
 * 会让人以为索引质量不行，其实那是词表本身的性质。
 *
 * 真正该看的是分频段覆盖：高频词覆盖不全才是问题。
 */
const bands = [
  { name: '真题 ≥200 次', min: 200, max: Infinity },
  { name: '真题 50–199 ', min: 50,  max: 199 },
  { name: '真题 10–49  ', min: 10,  max: 49 },
  { name: '真题 1–9    ', min: 1,   max: 9 },
  { name: '真题 0 次   ', min: 0,   max: 0 }
];
console.log('--- 分频段 ---');
bands.forEach(function (b) {
  const ws = BOOK.words.filter(function (e) {
    const f = e.freq || 0;
    return f >= b.min && f <= b.max;
  });
  const hit = ws.filter(function (e) { return index[String(e.word).toLowerCase()]; }).length;
  const pct = ws.length ? (hit / ws.length * 100).toFixed(1) : '—';
  console.log('  ' + b.name + ' : ' + String(hit).padStart(4) + ' / ' +
              String(ws.length).padStart(4) + '  (' + pct + '%)');
});

console.log('');
console.log('输出文件大小    :', (size / 1024).toFixed(0), 'KB');
console.log('输出路径        :', OUT);
