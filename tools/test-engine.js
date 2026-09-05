/* ===========================================================================
 *  tools/test-engine.js —— 间隔重复引擎纯算法边界断言（无浏览器、无 DOM 渲染）
 * ---------------------------------------------------------------------------
 *  为什么单独有这一份：
 *    smoke-test.js 走的是「点按钮 → 看界面变没变」的主流程，验证接线；
 *    调度算法里那些【边界不变量】（间隔封顶、ease 下限、降级门槛、升级门槛）
 *    藏在一连串评分之后，靠界面点一遍既慢又容易漏。
 *    这里把 store.js + engine.js 加载进一个最小 vm，直接对函数做断言。
 *
 *  与阶段 C 的关系：
 *    本文件只断言【现在就成立、改造后也必须继续成立】的不变量；
 *    阶段 C 调整 hard / again 行为时，再往这里补对应新断言。
 *
 *  运行： node tools/test-engine.js        （也由 run-all-tests.js / npm test 串起）
 * =========================================================================== */

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

const ROOT = path.join(__dirname, '..');

/* ------------------------------------------------------- 最小运行环境桩 */

const mem = Object.create(null);
const sandbox = {
  console: console,
  setTimeout: setTimeout, clearTimeout: clearTimeout,
  // store.js 退出前强制落盘用得到，测试里空转即可
  addEventListener: function () {},
  CustomEvent: function (t, o) { return Object.assign({ type: t }, o); },
  document: { addEventListener: function () {}, visibilityState: 'visible' },
  localStorage: {
    getItem: function (k) { return (k in mem) ? mem[k] : null; },
    setItem: function (k, v) { mem[k] = String(v); },
    removeItem: function (k) { delete mem[k]; }
  }
};
sandbox.window = sandbox;
sandbox.self   = sandbox;
sandbox.globalThis = sandbox;

vm.createContext(sandbox);
function load(rel) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, rel), 'utf8'), sandbox, { filename: rel });
}
load('js/store.js');
load('js/engine.js');

const E = sandbox.Engine;
const S = sandbox.Store;

/* ----------------------------------------------------------- 断言工具 */

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}
function eq(actual, expected) {
  return JSON.stringify(actual) === JSON.stringify(expected);
}
function section(t) { console.log('\n=== ' + t + ' ==='); }

/* ============================================================ 1. L1 增长 */

section('L1 生词：连续「认识」的间隔序列');

(function () {
  const c = E.createCard(1);
  const seq = [];
  let promptAt = -1;
  for (let i = 1; i <= 5; i++) {
    const r = E.grade(c, 'good', 'l1word');
    seq.push(c.interval);
    if (r.events.some(function (e) { return e.type === 'upgrade-prompt'; })) promptAt = i;
  }
  // initial=1，之后每步 ×1.6 四舍五入：1 → 2 → 3 → 5 → 8
  check('间隔序列为 1,2,3,5,8', eq(seq, [1, 2, 3, 5, 8]), '实际 ' + seq.join(','));
  // 升级门槛 streak>=3 且 interval>=7：第 5 步 interval=8 才满足
  check('第 5 次（interval=8）才弹 L1→L2 升级', promptAt === 5, '实际第 ' + promptAt + ' 次');
})();

/* ============================================================ 2. ease 下限 */

section('ease 系数：反复答错也不跌破下限 1.3');

(function () {
  const c = E.createCard(1);
  for (let i = 0; i < 10; i++) E.grade(c, 'again');
  check('连续 10 次 again 后 ease = 1.3（被钳住）', c.ease === 1.3, '实际 ' + c.ease);
  check('  且每次 again 都把间隔打回 1 天', c.interval === 1, '实际 ' + c.interval);
  check('  reps 归零', c.reps === 0);
})();

/* ============================================================ 3. 间隔封顶 */

section('间隔上限：MAX_INTERVAL = 180 天');

(function () {
  const c = E.createCard(1);
  c.reps = 1;
  c.interval = 170;                 // 170 × 1.6 = 272，应被钳到 180
  E.grade(c, 'good');
  check('170 天再「认识」后被钳到 180', c.interval === 180, '实际 ' + c.interval);

  const c2 = E.createCard(3);
  c2.reps = 1; c2.interval = 170;   // L3 ×2.5 涨得更猛，同样不许超过 180
  E.grade(c2, 'easy');
  check('L3 + easy 暴涨也不超过 180', c2.interval === E.MAX_INTERVAL, '实际 ' + c2.interval);
})();

/* ============================================================ 4. L2 降级 */

section('L2 眼熟：本级累计两次答错降级到 L1');

(function () {
  const c = E.createCard(2);
  const r1 = E.grade(c, 'again');
  check('第一次 again：仍在 L2', c.level === 2 && r1.events.length === 0,
        'level=' + c.level + ' events=' + r1.events.length);
  const r2 = E.grade(c, 'again');
  check('第二次 again：自动降级 L1', c.level === 1, '实际 level=' + c.level);
  check('  降级事件 from=2 to=1',
        r2.events.length === 1 && r2.events[0].type === 'downgrade' &&
        r2.events[0].from === 2 && r2.events[0].to === 1);
  check('  换级后本级答错计数清零', c.lvLapses === 0, '实际 ' + c.lvLapses);
})();

section('L3 熟词：答错一次立即降到 L2');

(function () {
  const c = E.createCard(3);
  const r = E.grade(c, 'again');
  check('L3 again 后 level=2', c.level === 2, '实际 ' + c.level);
  check('  带一条 downgrade(3→2) 事件',
        r.events[0] && r.events[0].type === 'downgrade' && r.events[0].to === 2);
})();

/* ============================================================ 5. good/easy 对比 */

section('同一状态下 easy 推得不比 good 近');

(function () {
  const base = E.createCard(2);
  base.reps = 2; base.interval = 6;
  const p = E.preview(base);
  check('preview 给出四档天数', ['again', 'hard', 'good', 'easy'].every(function (k) {
    return typeof p[k] === 'number';
  }), JSON.stringify(p));
  check('again(1) ≤ hard ≤ good ≤ easy(封顶)',
        p.again <= p.hard && p.hard <= p.good && p.good <= p.easy,
        JSON.stringify(p));
})();

/* ============================================================ 6. 倍数公式 */

section('multiplier：默认 ease 时倍数恰等于类别 growth');

(function () {
  check('L1 ×1.6', Math.abs(E.multiplier(1, 2.5) - 1.6) < 1e-9);
  check('L2 ×2.0', Math.abs(E.multiplier(2, 2.5) - 2.0) < 1e-9);
  check('L3 ×2.5', Math.abs(E.multiplier(3, 2.5) - 2.5) < 1e-9);
  check('ease 掉到下限时倍数仍 > 1（间隔不倒退）', E.multiplier(1, 1.3) > 1);
})();

/* ============================================================ 7. forecast 积压 */

section('forecast：逾期积压全部计入今天这一格');

(function () {
  const today = S.today();
  function mkDue(offset) {
    const c = E.createCard(1);
    c.active = true;
    c.due = S.addDays(today, offset);
    return c;
  }
  const cards = {
    overdue1: mkDue(-5),       // 逾期 5 天
    overdue2: mkDue(-1),       // 逾期 1 天
    todayD:  mkDue(0),         // 今天到期
    d3:       mkDue(3)         // 3 天后
  };
  const fc = E.forecast(cards, 7);
  check('今天这一格 = 2 个逾期 + 1 个今天 = 3', fc[0].count === 3, '实际 ' + fc[0].count);
  check('第 4 格（3 天后）= 1', fc[3].count === 1, '实际 ' + fc[3].count);
})();

/* ============================================================ 8. resetCard 保留 */

section('resetCard：打回未学但保留类别与建档日');

(function () {
  const c = E.createCard(2);
  c.reps = 5; c.lapses = 3; c.interval = 12; c.active = true;
  const triagedAt = c.triagedAt;
  E.resetCard(c);
  check('类别仍是 L2', c.level === 2);
  check('建档日期保留', c.triagedAt === triagedAt);
  check('学习进度归零（reps=0 / active=false / interval=0）',
        c.reps === 0 && c.active === false && c.interval === 0);
})();

/* ============================================================ 9. isDue */

section('isDue：未激活 / 无到期日不算到期');

(function () {
  const c = E.createCard(1);
  check('未激活卡不到期', E.isDue(c) === false);
  E.activate(c);
  check('L1 activate 后今天就到期', E.isDue(c) === true);
  check('空对象安全返回 false', E.isDue(null) === false);
})();

/* ------------------------------------------------------------- 结果 */

console.log('\n' + '='.repeat(46));
console.log('引擎单测：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);
