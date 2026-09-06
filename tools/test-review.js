/* ===========================================================================
 *  tools/test-review.js —— 每日复习上限 / 积压规划断言（阶段 C）
 * ---------------------------------------------------------------------------
 *  review.js 的渲染、特效、again 当天重学强依赖 DOM，交给浏览器手测；
 *  这里用最小桩把 store + engine + review 加载进 vm，只验证【纯规划逻辑】：
 *    · effectiveReviewCap 的自动 / 固定 / 不限 / 无历史兜底
 *    · status() 对「今天到期全保留、往日积压按上限截取」的计数与首页一致性
 *
 *  运行： node tools/test-review.js（也由 run-all-tests.js / npm test 串起）
 * =========================================================================== */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');

const mem = Object.create(null);
const sandbox = {
  console: { log: function () {}, warn: function () {}, error: function () {} },
  setTimeout: function (fn) { fn(); return 0; },
  clearTimeout: function () {},
  addEventListener: function () {},
  CustomEvent: function (t, o) { return Object.assign({ type: t }, o); },
  document: { addEventListener: function () {}, visibilityState: 'visible' },
  localStorage: {
    getItem: function (k) { return (k in mem) ? mem[k] : null; },
    setItem: function (k, v) { mem[k] = String(v); },
    removeItem: function (k) { delete mem[k]; }
  }
};
sandbox.window = sandbox; sandbox.self = sandbox; sandbox.globalThis = sandbox;
vm.createContext(sandbox);

function load(rel) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, rel), 'utf8'), sandbox, { filename: rel });
}
load('js/store.js');
load('js/engine.js');

/* review IIFE 顶部会取 window.UI.el，加载前先给最小桩；WB / Triage 同理 */
sandbox.UI = { el: function () { return {}; } };
sandbox.Triage = { status: function () {
  return { complete: true, done: 0, remaining: 0, total: 0 };
} };
const vocab = [];
sandbox.WB = {
  get: function (w) { return vocab.indexOf(w) >= 0 ? { word: w } : null; },
  indexOf: function (w) { return vocab.indexOf(w); },
  shuffle: function (a) { return a; }
};
load('js/review.js');

const S = sandbox.Store, E = sandbox.Engine, R = sandbox.Review;

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}
function section(t) { console.log('\n=== ' + t + ' ==='); }

function resetState() {
  Object.keys(mem).forEach(function (k) { delete mem[k]; });
  S.load();
  vocab.length = 0;
}
/* 造一张已激活、到期日相对今天 offset 天的卡（offset<0 = 往日积压） */
function dueCard(word, level, offset) {
  const c = E.createCard(level);
  c.active = true;
  c.due = S.addDays(S.today(), offset);
  vocab.push(word);
  S.get().cards[word] = c;
  return c;
}

/* ============================================ 1. effectiveReviewCap 三态 */

section('每日复习上限：自动 / 固定 / 不限 / 无历史兜底');

(function () {
  resetState();
  const st = S.get();
  st.settings.dailyReviewCap = 0;
  check('自动且无复习历史 → 不限(null)，避免新用户被 cap=0 卡死',
        R.effectiveReviewCap(st) === null);

  // 近 14 天每天复习 10 个：日均 10，×1.5 = 15
  S.lastNDays(14).forEach(function (d) { S.bump('review', 10, d); });
  check('自动且近 14 天日均 10 → 上限 15（×1.5 向上取整）',
        R.effectiveReviewCap(st) === 15, '实际 ' + R.effectiveReviewCap(st));

  st.settings.dailyReviewCap = 7;
  check('固定 7 → 7', R.effectiveReviewCap(st) === 7);
  st.settings.dailyReviewCap = -1;
  check('-1 → 不限(null)', R.effectiveReviewCap(st) === null);
})();

/* ==================================== 2. status：积压截取 + 今天全保留 */

section('复习规划：今天到期全保留，往日积压按上限截取，欠最久优先');

(function () {
  resetState();
  const st = S.get();
  st.settings.dailyNew = 0;          // 不投新词，只看复习
  st.settings.quota = [6, 3];
  for (let i = 1; i <= 20; i++) dueCard('over' + i, 1, -i);  // 20 个积压
  dueCard('today1', 1, 0); dueCard('today2', 2, 0); dueCard('today3', 1, 0);

  st.settings.dailyReviewCap = 5;
  let r = R.status();
  check('固定上限 5：复习数 = 5 积压 + 3 今天 = 8', r.due === 8, '实际 ' + r.due);
  check('积压总数 20', r.backlog === 20, '实际 ' + r.backlog);
  check('顺延积压 15', r.deferredBacklog === 15, '实际 ' + r.deferredBacklog);
  check('按每天 5 个，约 4 天清完', r.backlogDays === 4, '实际 ' + r.backlogDays);
  check('不投新词', r.newToStudy === 0 && r.totalToday === 8,
        'new=' + r.newToStudy + ' total=' + r.totalToday);

  st.settings.dailyReviewCap = -1;
  r = R.status();
  check('不限时：20 积压 + 3 今天 = 23 全放', r.due === 23, '实际 ' + r.due);
  check('不限时无顺延', r.deferredBacklog === 0 && r.backlogDays === 1,
        'defer=' + r.deferredBacklog + ' days=' + r.backlogDays);

  // 自动但无历史 → 同样不限
  st.settings.dailyReviewCap = 0;
  r = R.status();
  check('自动且无历史 → 23 全放', r.due === 23, '实际 ' + r.due);
})();

/* ============= 自动节奏：临考停新词、复习负载高时下调新词（阶段 E） ============ */

section('effectiveLimit：临考停新词、复习负载高时少投新词');

(function () {
  resetState();
  let st = S.get();
  st.settings.autoPace = false;
  st.settings.dailyNew = 25;
  check('关闭自动节奏 → 用固定每日新词 25', R.effectiveLimit(st, 900) === 25);

  resetState(); st = S.get(); st.settings.autoPace = true;
  st.settings.examDate = S.addDays(S.today(), 5);   // 距考 5 天，落在 10 天缓冲内
  check('临考缓冲期新词清零', R.effectiveLimit(st, 900) === 0);

  resetState(); st = S.get(); st.settings.autoPace = true;
  st.settings.examDate = S.addDays(S.today(), 100); // 可学 90 天，均摊 900/90=10
  const far = R.effectiveLimit(st, 900);
  check('远期且无复习负载 → 按均摊投 10', far === 10, '实际 ' + far);

  resetState(); st = S.get(); st.settings.autoPace = true;
  st.settings.examDate = S.addDays(S.today(), 20);  // 可学 10 天，均摊 900/10=90
  for (let i = 0; i < 1000; i++) dueCard('ov' + i, 1, 0); // 1000 张今天到期 → 预测日均复习 100
  // capacity=max(40, 90*2)=180，新词=min(90, round(180-100)=80)=80
  const lim = R.effectiveLimit(st, 900);
  check('复习负载高（预测日均 100）时新词从 90 下调到 80', lim === 80, '实际 ' + lim);
})();

/* ============= 4. shouldFinish：以真实卡为口径，修「学满还冒卡」 ============ */

section('结束判定：真实卡评完立即结束，again 重学副本不再把队列拖住');

(function () {
  const f = R.shouldFinish;
  check('刚开始不结束', f(0, 47, 1, 47) === false);
  check('评了 46/47（物理队列因 again 副本变长为 48）不结束',
        f(46, 47, 47, 48) === false);
  check('最后一张真实卡评完即结束，哪怕后面还压着副本',
        f(47, 47, 47, 48) === true);
  check('无副本时正常走到物理末尾也结束', f(47, 47, 47, 47) === true);
  check('物理队列走到尽头兜底结束', f(5, 47, 47, 47) === true);
})();

section('两类配额分配：按 6:3，某类不足时余量回流给另一类');

(function () {
  const a = R.allocate(9, [6, 3], [100, 100]);
  check('名额充足时严格 6:3 = [6,3]', a[0] === 6 && a[1] === 3, JSON.stringify(a));
  const b = R.allocate(9, [6, 3], [2, 100]);
  check('L1 只有 2 个，剩余 4 个回流给 L2 = [2,7]', b[0] === 2 && b[1] === 7,
        JSON.stringify(b));
})();

section('主复习 status：L3 熟词与归档词都不计入今日队列');

(function () {
  resetState();
  const st = S.get();
  st.settings.dailyNew = 0;
  dueCard('l3a', 3, 0);     // L3 今天到期 —— 应被排除，去速过模式
  dueCard('l3b', 3, -2);
  dueCard('l1a', 1, 0);     // 只有这张算主复习到期
  const arc = dueCard('arc', 1, 0);
  E.archive(arc);           // 归档词同样排除
  const r = R.status();
  check('到期只数 L1 那张（=1），L3 与归档都不算', r.due === 1, '实际 ' + r.due);
  check('不再返回 newL3 字段', r.newL3 === undefined);
  check('未学新词也只统计 L1/L2', r.unlearned === 0, '实际 ' + r.unlearned);
})();

/* ------------------------------------------------------------- 结果 */

console.log('\n' + '='.repeat(46));
console.log('复习规划单测：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);
