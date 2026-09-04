/* ===========================================================================
 *  tools/smoke-test.js —— 无浏览器冒烟测试
 * ---------------------------------------------------------------------------
 *  为什么要写这个：
 *    改完样式和特效之后，最怕的不是「不好看」，是「点下去没反应」。
 *    这个项目没有构建、没有测试框架，语法检查（node --check）只能保证
 *    文件能被解析，保证不了「按 1 键能不能给单词定级」。
 *
 *    所以这里搭一个够用的 DOM 桩，把 8 个 js 真的加载起来跑一遍主流程：
 *      普查定级 → 熟词核对 → 回退 → 复习翻卡 → 评分 → 选择题 → 连击
 *    只要哪一步抛异常或状态没变，这里就会红。
 *
 *  这【不是】视觉测试 —— 界面好不好看只能拿眼睛看。
 *  它验证的是「特效接线没有把交互打断」。
 *
 *  运行： node tools/smoke-test.js
 *        node tools/smoke-test.js --reduced   ← 模拟系统开了「减少动态效果」
 *
 *  --reduced 那一趟尤其重要：此时 FX 整个空转，翻卡必须【同步】完成。
 *  fx.js 的 flip() 之所以不走 guard()，就是为了保证这条路径不卡死
 *  —— 有这个开关，那条约束才是被测过的，而不只是注释里的一句承诺。
 * =========================================================================== */

const REDUCED = process.argv.indexOf('--reduced') >= 0;

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

const ROOT = path.join(__dirname, '..');

/* ================================================================ DOM 桩 */

let nodeSeq = 0;

function makeNode(tag) {
  const n = {
    tagName: String(tag || 'div').toUpperCase(),
    _id: ++nodeSeq,
    childNodes: [],
    parentNode: null,
    attrs: Object.create(null),
    style: makeStyle(),
    classList: null,
    _cls: '',
    _text: '',
    _html: '',
    _listeners: Object.create(null),
    disabled: false,
    files: null,
    value: ''
  };

  n.classList = {
    add:    function () { [].forEach.call(arguments, function (c) { if (!n._has(c)) n._cls = (n._cls + ' ' + c).trim(); }); },
    remove: function () { [].forEach.call(arguments, function (c) {
              n._cls = n._cls.split(/\s+/).filter(function (x) { return x && x !== c; }).join(' '); }); },
    toggle: function (c, on) { if (on) n.classList.add(c); else n.classList.remove(c); },
    contains: function (c) { return n._has(c); }
  };
  n._has = function (c) { return n._cls.split(/\s+/).indexOf(c) >= 0; };

  Object.defineProperty(n, 'className', {
    get: function () { return n._cls; },
    set: function (v) { n._cls = String(v || ''); }
  });
  Object.defineProperty(n, 'textContent', {
    get: function () {
      if (n.childNodes.length) {
        return n.childNodes.map(function (c) { return c.textContent || ''; }).join('');
      }
      return n._text;
    },
    set: function (v) { n._text = String(v == null ? '' : v); n.childNodes.length = 0; }
  });
  Object.defineProperty(n, 'innerHTML', {
    get: function () { return n._html; },
    set: function (v) { n._html = String(v || ''); n.childNodes.length = 0; }
  });
  Object.defineProperty(n, 'firstChild', { get: function () { return n.childNodes[0] || null; } });
  Object.defineProperty(n, 'isConnected', {
    /* 一路向上走到根，再看根是不是文档树的顶端。
       注意根是 documentElement 而不是 body —— body 的 parentNode 是
       documentElement，循环会一直走到它才停。写成只比对 doc.body
       会让这个属性恒为 false，进而把所有 onKey 守卫全部挡掉。 */
    get: function () {
      let p = n;
      while (p.parentNode) p = p.parentNode;
      return p === doc.documentElement || p === doc;
    }
  });
  Object.defineProperty(n, 'offsetWidth', { get: function () { return 100; } });

  n.appendChild = function (c) {
    if (!c) return c;
    if (c.parentNode) c.parentNode.removeChild(c);
    c.parentNode = n; n.childNodes.push(c); return c;
  };
  n.removeChild = function (c) {
    const i = n.childNodes.indexOf(c);
    if (i >= 0) { n.childNodes.splice(i, 1); c.parentNode = null; }
    return c;
  };
  n.setAttribute = function (k, v) {
    n.attrs[k] = String(v);
    if (k === 'class') n._cls = String(v);
    /* 真实 DOM 里 disabled/value 这类属性会同步到同名 IDL 属性上，
       ui.js 的 el() 正是靠 setAttribute 来禁用按钮的。
       桩不镜像的话，「作答后选项应该点不动」这条断言会假阴性。 */
    if (k === 'disabled') n.disabled = true;
    if (k === 'value') n.value = String(v);
  };
  n.removeAttribute = function (k) {
    delete n.attrs[k];
    if (k === 'disabled') n.disabled = false;
  };
  n.getAttribute = function (k) { return k in n.attrs ? n.attrs[k] : null; };
  n.addEventListener = function (t, fn) { (n._listeners[t] = n._listeners[t] || []).push(fn); };
  n.removeEventListener = function (t, fn) {
    const a = n._listeners[t]; if (!a) return;
    const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1);
  };
  n.dispatch = function (t, ev) {
    (n._listeners[t] || []).slice().forEach(function (fn) {
      fn.call(n, Object.assign({ type: t, target: n, currentTarget: n,
                                 preventDefault: function () {} }, ev || {}));
    });
  };
  n.click = function () {
    if (n.disabled) throw new Error('点了一个 disabled 的按钮：' + n.textContent);
    n.dispatch('click');
  };
  n.getBoundingClientRect = function () { return { left: 10, top: 10, width: 80, height: 30 }; };
  n.animate = function () {
    // 桩：立刻「播完」，返回一个带 onfinish/oncancel 挂钩的壳
    return { onfinish: null, oncancel: null, cancel: function () {} };
  };
  n.focus = function () {};

  /* --- 选择器：只支持这个项目实际用到的几种简单形式 --- */
  n.querySelectorAll = function (sel) { return queryAll(n, sel); };
  n.querySelector = function (sel) { return queryAll(n, sel)[0] || null; };

  return n;
}

function makeStyle() {
  const s = { cssText: '', setProperty: function (k, v) { s[k] = v; } };
  return s;
}

/* 支持 ".a"、".a .b"、"#id"、"tag" 以及逗号分隔 —— 够这个项目用 */
function matches(node, part) {
  if (part[0] === '.') return node._has(part.slice(1));
  if (part[0] === '#') return node.attrs.id === part.slice(1);
  return node.tagName === part.toUpperCase();
}

function queryAll(root, sel) {
  const out = [];
  String(sel).split(',').forEach(function (one) {
    const parts = one.trim().split(/\s+/);
    walk(root, 0);
    function walk(node, depth) {
      node.childNodes.forEach(function (c) {
        const hit = matches(c, parts[depth]);
        if (hit && depth === parts.length - 1) { if (out.indexOf(c) < 0) out.push(c); }
        else if (hit) walk(c, depth + 1);
        walk(c, depth);   // 后代任意层级
      });
    }
  });
  return out;
}

/* ---------------------------------------------------------------- document */

const doc = {
  readyState: 'complete',
  visibilityState: 'visible',
  documentElement: makeNode('html'),
  body: makeNode('body'),
  _byId: Object.create(null),
  _listeners: Object.create(null),
  createElement: makeNode,
  /* charts.js 画 SVG 用的是 createElementNS。命名空间在这里不重要 ——
     测试只关心节点结构和事件，不关心它渲染出来长什么样。 */
  createElementNS: function (ns, tag) { return makeNode(tag); },
  createTextNode: function (t) { const n = makeNode('#text'); n._text = String(t); return n; },
  getElementById: function (id) { return doc._byId[id] || null; },
  querySelector: function (s) { return queryAll(doc.body, s)[0] || null; },
  querySelectorAll: function (s) { return queryAll(doc.body, s); },
  addEventListener: function (t, fn) { (doc._listeners[t] = doc._listeners[t] || []).push(fn); },
  removeEventListener: function (t, fn) {
    const a = doc._listeners[t]; if (!a) return;
    const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1);
  },
  dispatch: function (t, ev) {
    (doc._listeners[t] || []).slice().forEach(function (fn) {
      fn(Object.assign({ type: t, target: doc.body, preventDefault: function () {} }, ev || {}));
    });
  }
};
doc.documentElement.appendChild(doc.body);

/* HTML 里的三个挂载点 */
['banner', 'nav', 'main'].forEach(function (id) {
  const n = makeNode('div');
  n.attrs.id = id;
  doc.body.appendChild(n);
  doc._byId[id] = n;
});

/* ---------------------------------------------------------------- window */

const store = Object.create(null);
const win = {
  document: doc,
  location: { protocol: 'file:', href: 'file:///test' },
  navigator: { userAgent: 'node-smoke', language: 'zh-CN' },
  innerWidth: 1280, innerHeight: 800, devicePixelRatio: 1,
  localStorage: {
    getItem: function (k) { return k in store ? store[k] : null; },
    setItem: function (k, v) { store[k] = String(v); },
    removeItem: function (k) { delete store[k]; }
  },
  matchMedia: function (q) {
    // 只有 reduced-motion 这一条查询会影响被测行为，其余一律返回不匹配
    const hit = REDUCED && /prefers-reduced-motion/.test(String(q));
    return { matches: hit, media: String(q),
             addEventListener: function () {}, addListener: function () {} };
  },
  getComputedStyle: function () { return { getPropertyValue: function () { return ''; } }; },
  requestAnimationFrame: function () { return 0; },
  cancelAnimationFrame: function () {},
  addEventListener: function () {},
  removeEventListener: function () {},
  dispatchEvent: function () { return true; },
  scrollTo: function () {},
  setTimeout: setTimeout, clearTimeout: clearTimeout,
  setInterval: setInterval, clearInterval: clearInterval,
  CustomEvent: function (t, o) { return Object.assign({ type: t }, o); },
  console: { log: function () {}, warn: function () {}, error: function () {}, debug: function () {} },
  // 语音合成：不存在，Speak 会自行降级
  speechSynthesis: undefined,
  Element: { prototype: { animate: function () {} } }
};
win.window = win;
win.self = win;
win.globalThis = win;

/* ================================================================ 加载 */

const ctx = vm.createContext(win);

function load(rel) {
  const code = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  try {
    vm.runInContext(code, ctx, { filename: rel });
  } catch (e) {
    console.error('加载失败:', rel);
    throw e;
  }
}

[
  'data/sample.js', 'data/wordbook.js', 'data/corpus.js',
  'js/store.js', 'js/engine.js', 'js/wordbook.js', 'js/fx.js',
  'js/ui.js', 'js/charts.js', 'js/triage.js', 'js/review.js', 'js/app.js'
].forEach(load);

/* app.js 在 readyState==='complete' 时会立刻 boot() */

/* ================================================================ 断言 */

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}
function section(t) { console.log('\n=== ' + t + ' ==='); }

const main = doc._byId.main;
const nav  = doc._byId.nav;
const S    = win.Store;

function byText(root, cls, text) {
  return queryAll(root, '.' + cls).filter(function (n) {
    return n.textContent.indexOf(text) >= 0;
  })[0] || null;
}

/* ---------------------------------------------------------------- 启动 */

section('启动' + (REDUCED ? '（减少动态效果模式）' : ''));
check('词库已载入 5530 条', win.WB.size() === 5530, '实际 ' + win.WB.size());
check('导航渲染出 4 个页签', queryAll(nav, '.tab').length === 4);
check('首页渲染出内容', queryAll(main, '.page').length === 1);
check('首页有 EXP 等级条', queryAll(main, '.exp-bar').length === 1);
check(REDUCED ? 'FX 按预期整体空转' : 'FX 已初始化且未因环境降级',
      win.FX && win.FX.off === REDUCED, 'FX.off=' + (win.FX && win.FX.off));

/* ---------------------------------------------------------------- 普查 */

section('普查：定级 / 核对 / 回退');

const startBtn = queryAll(main, '.action-card .btn')[0];
check('首页有「开始普查」按钮', !!startBtn);
startBtn.click();

check('进入普查页', queryAll(main, '.triage-card').length === 1);
const firstWord = queryAll(main, '.word-text')[0].textContent;
check('显示了第一个词 (' + firstWord + ')', !!firstWord);

// 点「生词」
const lvBtns = queryAll(main, '.lv-btn');
check('有三个定级按钮', lvBtns.length === 3);
lvBtns[0].click();
check('L1 定级后已建卡', !!S.getCard(firstWord));
check('  卡片 level = 1', S.getCard(firstWord).level === 1);
check('换到了下一个词', queryAll(main, '.word-text')[0].textContent !== firstWord);

// 键盘定级
const w2 = queryAll(main, '.word-text')[0].textContent;
doc.dispatch('keydown', { key: '2' });
check('键盘「2」定级为 L2', S.getCard(w2) && S.getCard(w2).level === 2);

// L3 要先过核对关
const w3 = queryAll(main, '.word-text')[0].textContent;
doc.dispatch('keydown', { key: '3' });
check('选 L3 先进入核对页', queryAll(main, '.verify-banner').length === 1);
check('  核对页尚未建卡（关卡生效）', !S.getCard(w3));
doc.dispatch('keydown', { key: 'Enter' });
check('确认后建卡为 L3', S.getCard(w3) && S.getCard(w3).level === 3);

// 核对页选「其实不确定」→ 归 L2
const w4 = queryAll(main, '.word-text')[0].textContent;
queryAll(main, '.lv-btn')[2].click();
const downBtn = queryAll(main, '.verify-actions .btn')[1];
check('核对页有「归为眼熟」按钮', !!downBtn);
downBtn.click();
check('降档后 level = 2', S.getCard(w4) && S.getCard(w4).level === 2);

// 回退
const before = queryAll(main, '.word-text')[0].textContent;
doc.dispatch('keydown', { key: 'ArrowLeft' });
check('回退后卡片被撤销', !S.getCard(w4));
check('  回退到了刚才那个词', queryAll(main, '.word-text')[0].textContent === w4,
      '现在是 ' + queryAll(main, '.word-text')[0].textContent + '，回退前是 ' + before);

/* ---------------------------------------------------------------- 复习 */

/*
 * 从这里开始要 async。
 *
 * 翻卡不是同步的：reveal() 走 FX.flip，而 flip 会等到 3D 翻转播到一半
 * （200ms）才替换内容 —— 那正是「卡片转过去」的视觉时机。
 * 所以点完「显示释义」必须真的等一会儿，评分按钮才会出现。
 * 这是被测行为本身的性质，不是测试的将就。
 */
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
const FLIP_WAIT = 320;   // 略大于 fx.js 里的 200ms 换面时机

/** 点「显示释义」并等翻面完成。动效关掉时是同步的，等一下也无妨。 */
async function reveal() {
  const b = queryAll(main, '.card-actions .btn')[0];
  if (b) b.click();
  if (!REDUCED) await sleep(FLIP_WAIT);
  return b;
}

async function main_() {

section('复习：翻卡 / 评分 / 选择题 / 连击');

/* 造一批已定级但没开始学的卡，并放开「普查未做完不能复习」的限制 */
S.get().settings.reviewBeforeTriageDone = true;
S.get().settings.quizRatio = 0;               // 先全部走翻卡，方便断言
for (let i = 0; i < 40; i++) {
  const e = win.WB.at(i);
  if (e) S.get().cards[e.word] = win.Engine.createCard((i % 2) + 1);
}
S.save();

// 回首页再进复习
queryAll(nav, '.tab')[0].click();
const revBtn = queryAll(main, '.action-card .btn').filter(function (b) {
  return b.textContent.indexOf('复习') >= 0;
})[0];
check('首页出现「开始复习」入口', !!revBtn);
revBtn.click();

check('进入复习页', queryAll(main, '.card').length === 1);
check('顶部有进度条', queryAll(main, '.review-top .progress').length === 1);

// 翻面
const revealBtn = queryAll(main, '.card-actions .btn')[0];
check('正面有「显示释义」按钮', !!revealBtn);
revealBtn.click();

if (REDUCED) {
  /* 这条是 fx.js「flip 不走 guard」那个设计的验收点。
     动效被关掉时，翻面必须【当场】完成 —— 如果 swap 回调被
     guard 的 catch/early-return 吞掉，这里会是 0，
     用户看到的就是「点了显示释义没反应」。 */
  check('动效关闭时翻面同步完成，不依赖定时器',
        queryAll(main, '.grade-btn').length === 4,
        '实际 ' + queryAll(main, '.grade-btn').length);
} else {
  check('翻面动画播到一半前，评分按钮还没出现', queryAll(main, '.grade-btn').length === 0);
  await sleep(FLIP_WAIT);
  check('翻面完成后出现 4 个评分按钮', queryAll(main, '.grade-btn').length === 4,
        '实际 ' + queryAll(main, '.grade-btn').length);
}

// 评分 → 连击应当累加
queryAll(main, '.grade-btn')[2].click();          // 「认识」
let daily = S.getDaily();
check('评分后当日计数 total=1', daily.total === 1, 'total=' + daily.total);
check('  正确数 correct=1', daily.correct === 1);

// 再连对两个，凑到 3 连
for (let i = 0; i < 2; i++) {
  await reveal();
  const gb = queryAll(main, '.grade-btn')[2];
  if (gb) gb.click();
}
const chip = queryAll(main, '.combo-chip')[0];
check('3 连后顶栏出现连击标记', !!chip, chip ? chip.textContent : '没找到 .combo-chip');

// 答错 → 连击清零
await reveal();
doc.dispatch('keydown', { key: '1' });            // 「忘记」
check('答错后连击标记消失', queryAll(main, '.combo-chip').length === 0);
check('  错误计入 daily', S.getDaily().total >= 4, 'total=' + S.getDaily().total);

// 选择题分支
S.get().settings.quizRatio = 1;
S.save();
queryAll(nav, '.tab')[0].click();
const revBtn2 = queryAll(main, '.action-card .btn').filter(function (b) {
  return b.textContent.indexOf('复习') >= 0;
})[0];
if (revBtn2) revBtn2.click();
const opts = queryAll(main, '.quiz-opt');
check('出现选择题选项', opts.length >= 3, '实际 ' + opts.length);
if (opts.length) {
  opts[0].click();
  check('作答后出现判定文字', queryAll(main, '.quiz-verdict').length === 1);
  check('  选项已禁用，防止改答案', queryAll(main, '.quiz-opt')[0].disabled === true);
  const cont = queryAll(main, '.card-actions .btn')[0];
  check('有「继续」按钮', !!cont);
  if (cont) {
    const t0 = S.getDaily().total;
    cont.click();
    check('  继续后完成结算', S.getDaily().total === t0 + 1,
          t0 + ' → ' + S.getDaily().total);
  }
}

/* ---------------------------------------------------------------- 其他页 */

section('词书 / 统计 / 设置');

queryAll(nav, '.tab')[1].click();
check('词书页渲染出词条列表', queryAll(main, '.word-row').length > 0,
      '实际 ' + queryAll(main, '.word-row').length + ' 行');
const row = queryAll(main, '.word-main')[0];
row.click();
check('点开词条展开详情', queryAll(main, '.word-detail').length === 1);

queryAll(nav, '.tab')[2].click();
check('统计页渲染出图表卡', queryAll(main, '.chart-card').length > 0);

queryAll(nav, '.tab')[3].click();
check('设置页渲染出设置组', queryAll(main, '.set-group').length > 0);
check('  含主题选择', queryAll(main, '.input--sel').length > 0);

/* ---------------------------------------------------------------- 存档 */

section('存档');
const json = S.exportJSON();
const insp = S.inspectImport(json);
check('导出的备份能被自己导入校验', insp.ok === true, insp.error);
check('  备份里的卡片数对得上', insp.summary.cardCount === Object.keys(S.get().cards).length);

/* ---------------------------------------------------------------- 真题原句 */

section('真题原句（词条级索引）');

const cm = win.WB.corpusMeta();
check('语料已加载', !!cm, '没读到 window.CORPUS');

if (cm) {
  check('  覆盖 3000 个以上词条', cm.words > 3000, '实际 ' + cm.words);
  check('  年份区间完整', /^\d{4}–\d{4}$/.test(cm.years), cm.years);

  /*
   * 【最重要的一条】索引不能张冠李戴：A 词的句子不能挂到 B 词名下。
   *
   * 判据故意【不复用】build-corpus.js 的还原器 —— 那样等于自己证明自己。
   * 这里用一个独立的字面判据：句中要有一个 token 和词头共享足够长的前缀。
   *
   * 但前缀比对有三类【原理上抓不到】的合法情况，必须先归一化或让过：
   *   1. 英美拼写   organise / organizing，practise / practice
   *      → 把 z、c 都归一成 s 再比
   *   2. 词干变形   rise / rising（丢 e），vary / varied（y→i）
   *      → 比对前先砍掉词尾的 e、把词尾 y 换成 i
   *   3. 不规则动词 write / wrote，fight / fought
   *      → 词干整个变了，任何前缀规则都无能为力，只能算进残差
   *
   * 所以这里断言的是【残差率】而不是零。阈值 3% 的意义：
   * 不规则动词在大纲里占比很小，正常残差是 1% 上下；
   * 一旦还原器真的坏掉（比如两步剥离失控），残差会直接飙到两位数。
   * 每条残差都打印出来，可以逐条肉眼确认。
   */
  function norm(x) {
    return x.toLowerCase()
            .replace(/[zc]/g, 's')      // organize/practice → organise/practise
            .replace(/e$/, '')          // rise → ris，好和 rising 对上
            .replace(/y$/, 'i');        // vary → vari，好和 varied/varies 对上
  }

  const C = win.CORPUS;
  const keys = Object.keys(C.index);
  let checked = 0, bad = 0;
  const badSample = [];

  for (let i = 0; i < keys.length && checked < 400; i += Math.ceil(keys.length / 400)) {
    const w = keys[i];
    if (w.length < 4) continue;            // 太短的词前缀判据没有区分度
    const nw = norm(w);
    C.index[w].forEach(function (si) {
      const s = C.sents[si];
      if (!s) return;
      checked++;
      const toks = String(s[1]).match(/[A-Za-z]+/g) || [];
      const hit = toks.some(function (t) {
        const nt = norm(t);
        const n = Math.max(3, Math.min(nt.length, nw.length) - 1);
        return nt.slice(0, n) === nw.slice(0, n);
      });
      if (!hit) { bad++; if (badSample.length < 6) badSample.push(w); }
    });
  }
  const rate = checked ? (bad / checked * 100) : 0;
  check('  抽查 ' + checked + ' 条原句，字面残差 ' + rate.toFixed(1) + '% （<3% 视为正常）',
        rate < 3,
        bad + ' 条对不上，样例：' + badSample.join(', '));

  // 具体词的人工基准：这两个词正是「词条级原句能替代义项级标注」的例证
  const acc = win.WB.citationsOf('account', 3);
  check('  account 有真题原句', acc.length > 0);
  if (acc.length) {
    check('    原句带出处标记', /\d{4}/.test(acc[0].src), acc[0].src);
  }
  check('  wink（真题 0 次）没有原句', win.WB.citationsOf('wink', 3).length === 0);
  check('  citeLimit 生效', win.WB.citationsOf('account', 1).length === 1);
}

/* --- 死代码是否真的清干净了 --- */
section('旧的义项级标注已移除');
check('WB.rareDefs 已删除', typeof win.WB.rareDefs === 'undefined');
check('WB.hasCitations 已删除', typeof win.WB.hasCitations === 'undefined');
check('WB.citationCount 已删除', typeof win.WB.citationCount === 'undefined');
check('设置里不再有 showRareDefs', !('showRareDefs' in S.get().settings));

queryAll(nav, '.tab')[3].click();
const labels = queryAll(main, '.check-label').map(function (n) { return n.textContent; });
check('设置页不再有「默认展开生僻义」这个假开关',
      labels.every(function (t) { return t.indexOf('生僻义') < 0; }), labels.join(' / '));
check('设置页出现「真题语料」信息组',
      queryAll(main, '.set-title').some(function (n) { return n.textContent.indexOf('真题语料') >= 0; }));

/* ---------------------------------------------------------------- 冲刺面板 */

section('冲刺面板 + 自动节奏 + 跳过巡检');

/* 造一个干净、可预测的存档：reset 后手工铺卡片。
   30 个 L1（已学 active、reps=0），20 个 L2（active、reps=1），
   10 个 L3（未 active，模拟普查完但还没排期的熟词）。 */
S.reset();
const st2 = S.get();
const defWords = win.WB.all();

function mkCard(lv, reps, active) {
  const c = win.Engine.createCard(lv);
  c.active = active;
  c.reps = reps;
  if (active) {
    c.interval = lv === 1 ? 1 : 3;
    c.due = S.today();
  }
  return c;
}
for (let i = 0; i < 30; i++) st2.cards[defWords[i].word] = mkCard(1, 0, true);
for (let i = 30; i < 50; i++) st2.cards[defWords[i].word] = mkCard(2, 1, true);
for (let i = 50; i < 60; i++) st2.cards[defWords[i].word] = mkCard(3, 0, false);
st2.settings.examDate = S.addDays(S.today(), 100);
st2.settings.autoPace = true;
st2.settings.skipL3Patrol = true;
st2.settings.reviewBeforeTriageDone = true;   // 让首页显示「开始复习」入口
S.save();

/* 回首页看冲刺面板 */
queryAll(nav, '.tab')[0].click();
check('首页出现冲刺面板', queryAll(main, '.sprint').length === 1);
const sTitle = queryAll(main, '.sprint-title')[0];
check('  倒计时显示「距考研」', !!sTitle && sTitle.textContent.indexOf('距考研') >= 0,
      sTitle ? sTitle.textContent : '没找到 .sprint-title');

/* 轮次进度：50 个 active，其中 20 个 reps>=1 → 第1轮 50，第2轮 20，第3轮 0 */
const rNums = queryAll(main, '.sprint-round-num').map(function (n) { return n.textContent; });
check('  轮次数字正确（50 已学 / 20 复习1次 / 0 复习2次）',
      rNums[0] === '50 / 50' && rNums[1] === '20 / 50' && rNums[2] === '0 / 50',
      rNums.join(' | '));

/* 每日目标：50 个未学？不对 —— 全部已学，remaining=0，目标应为 0 */
const sSub = queryAll(main, '.sprint-sub')[0];
check('  全部已学时每日目标为 0', !!sSub && sSub.textContent.indexOf('0 词') >= 0,
      sSub ? sSub.textContent : '没找到 .sprint-sub');

/* skipL3Patrol：进入复习，L3 词不应被 activate */
const l3word = defWords[55].word;
const wasInactive = st2.cards[l3word].active === false;
queryAll(main, '.action-card .btn').filter(function (b) {
  return b.textContent.indexOf('复习') >= 0;
})[0].click();
check('  skipL3Patrol 时 L3 词保持未激活', wasInactive && st2.cards[l3word].active === false,
      'L3 词被意外激活了');

/* 自动节奏：effectiveLimit 应随剩余词数动态变化，这里 0 个未学 → 上限 0 */
check('  自动节奏下无未学词时新词上限为 0', win.Review.status().budget === 0,
      'budget=' + win.Review.status().budget);

/* 恢复默认设置，避免污染后续（本测试是最后一段，其实无所谓，但保持干净） */
st2.settings.examDate = null;
st2.settings.autoPace = true;
st2.settings.skipL3Patrol = false;
S.save();

/* ---------------------------------------------------------------- 结果 */

console.log('\n' + '='.repeat(46));
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);

}  /* end main_ */

main_().catch(function (e) {
  console.error('\n测试自身出错：');
  console.error(e);
  process.exit(2);
});
