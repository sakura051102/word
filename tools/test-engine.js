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
  let upAt = -1, upEv = null;
  for (let i = 1; i <= 5; i++) {
    const r = E.grade(c, 'good', 'l1word');
    seq.push(c.interval);
    const ev = r.events.filter(function (e) { return e.type === 'upgrade'; })[0];
    if (ev) { upAt = i; upEv = ev; }
  }
  // L1 initial=1、growth=1.5：1 → 2 →（第 3 次 interval=3 达标）升 L2 跳到 5，
  // 之后按 L2 growth=2.2：5 → 11 → 24
  check('L1 序列 1,2 后升 L2 跳到 5，再按 L2 11,24', eq(seq, [1, 2, 5, 11, 24]), '实际 ' + seq.join(','));
  // 升级门槛 streak>=3 且 interval>=3：第 3 次 interval=3 即达标，提早升入 L2
  check('第 3 次（interval=3）自动 L1→L2',
        upAt === 3 && upEv && upEv.from === 1 && upEv.to === 2, '实际第 ' + upAt + ' 次');
  check('自动升级立即生效、无需确认弹窗', c.level === 2, '实际 level=' + c.level);
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
  c.interval = 170;                 // 170 × 1.5 = 255，应被钳到 180
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

section('L3 熟词：答错一次立即降到 L2（速过「不认识」走这条）');

(function () {
  const c = E.createCard(3);
  const r = E.grade(c, 'again');
  check('L3 again 后 level=2', c.level === 2, '实际 ' + c.level);
  check('  带一条 downgrade(3→2) 事件',
        r.events[0] && r.events[0].type === 'downgrade' && r.events[0].to === 2);
})();

/* ============================================================ 4b. L2→L3 自动升级 */

section('L2 眼熟：连对达标自动升入熟词速过池并标 promoted');

(function () {
  const c = E.createCard(2);
  const seq = [];
  let upAt = -1, upEv = null;
  for (let i = 1; i <= 3; i++) {
    const r = E.grade(c, 'good', 'l2word');
    seq.push(c.interval);
    const ev = r.events.filter(function (e) { return e.type === 'upgrade'; })[0];
    if (ev) { upAt = i; upEv = ev; }
  }
  // L2 initial=5、growth=2.2：5 → 11 → 24；第 3 次 streak=3 且 interval=24>=21 升 L3
  check('L2 序列 5,11,24', eq(seq, [5, 11, 24]), '实际 ' + seq.join(','));
  check('第 3 次自动 L2→L3', upAt === 3 && upEv && upEv.to === 3, '实际第 ' + upAt + ' 次');
  check('升入 L3 后标记 l3Origin=promoted', c.l3Origin === 'promoted', '实际 ' + c.l3Origin);
})();

section('L1 与 L2 频率差：同期眼熟间隔远大于生词（出现频率明显更低）');

(function () {
  const a = E.createCard(1), l1 = [];
  for (let i = 0; i < 3; i++) { E.grade(a, 'good'); l1.push(a.interval); }
  const b = E.createCard(2), l2 = [];
  for (let i = 0; i < 3; i++) { E.grade(b, 'good'); l2.push(b.interval); }
  // 新节奏：L1 升级前隔天见（1,2 天），第 3 次即升入 L2、间隔跳到 5 天
  check('L1 隔天见两次后第 3 次升 L2、跳到 5 天', eq(l1, [1, 2, 5]) && a.level === 2,
        '实际 ' + l1.join(',') + ' level=' + a.level);
  check('L2 三次后间隔 24 天，远疏于 L1 密集期', l2[2] >= l1[1] * 10,
        'L1 密集期末=' + l1[1] + ' L2=' + l2[2]);
})();

/* ============================================================ 4c. 永不复习 */

section('永不复习：archive 后被一切调度排除，可恢复');

(function () {
  const today = S.today();
  const c = E.createCard(1); E.activate(c, 0);
  const cards = { x: c };
  check('未归档时到期', E.isDue(c, today));
  E.archive(c);
  check('archived=true 且记归档日', c.archived === true && !!c.archivedAt);
  check('归档后 isDue=false', !E.isDue(c, today));
  check('levelCounts 排除归档（全 0）', eq(E.levelCounts(cards), [0, 0, 0]),
        JSON.stringify(E.levelCounts(cards)));
  check('archivedCount=1', E.archivedCount(cards) === 1);
  check('masteryBucket 归类为 archived', E.masteryBucket(c) === 'archived');
  E.unarchive(c);
  check('恢复后重新到期', E.isDue(c, today) && !c.archived);
})();

section('速过评分：L3「认识」只拉长不升级');

(function () {
  const c = E.createCard(3);
  c.active = true; c.reps = 1; c.interval = 20;
  const before = c.interval;
  const r = E.grade(c, 'good');
  check('L3 good 后仍是 L3（无第 4 级可升）', c.level === 3);
  check('间隔被拉长', c.interval > before, before + ' → ' + c.interval);
  check('不产生升级事件', !r.events.some(function (e) { return e.type === 'upgrade'; }));
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

/* ============================================================ 5b. hard 连对 */

section('hard：勉强答对不清零连对、也不增加');

(function () {
  const c = E.createCard(1);
  E.grade(c, 'good'); E.grade(c, 'good');   // streak = 2, reps = 2
  const repsBefore = c.reps, easeBefore = c.ease;
  E.grade(c, 'hard');
  check('hard 后 streak 保持 2（不清零、不 +1）', c.streak === 2, '实际 ' + c.streak);
  check('hard 不增加 reps', c.reps === repsBefore, '实际 ' + c.reps);
  check('hard 小幅压低 ease', c.ease < easeBefore, 'ease ' + c.ease);

  const a = E.createCard(1); E.grade(a, 'again');
  check('对照：again 仍清零 streak', a.streak === 0);
  const g = E.createCard(1); E.grade(g, 'good');
  check('对照：good 使 streak +1', g.streak === 1);
})();

/* ============================================================ 6. 倍数公式 */

section('multiplier：默认 ease 时倍数恰等于类别 growth');

(function () {
  check('L1 ×1.5', Math.abs(E.multiplier(1, 2.5) - 1.5) < 1e-9);
  check('L2 ×2.2', Math.abs(E.multiplier(2, 2.5) - 2.2) < 1e-9);
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

/* ==================================================== 10. 薄弱词本 */

section('薄弱词本：lapses≥2 或近 30 天掉级，最近掉级优先排序');

(function () {
  const today = S.today();
  const cards = {};
  const a = E.createCard(1); a.lapses = 2; delete a.lastDowngradeAt; cards.aaa = a;
  const b = E.createCard(2); b.lapses = 0; b.lastDowngradeAt = today;       cards.bbb = b;
  const c = E.createCard(3); c.lapses = 0; c.lastDowngradeAt = S.addDays(today, -40); cards.ccc = c;
  const d = E.createCard(1); d.lapses = 1; cards.ddd = d;
  const weak = E.weakWords(cards, 30).map(function (x) { return x.word; });
  check('命中 lapses2 的 aaa 与今天掉级的 bbb',
        weak.length === 2 && weak.indexOf('aaa') >= 0 && weak.indexOf('bbb') >= 0);
  check('排除 40 天前掉级（超出窗口）的 ccc', weak.indexOf('ccc') < 0);
  check('排除仅 lapses=1 的 ddd', weak.indexOf('ddd') < 0);
  check('最近掉级的 bbb 排在最前', weak[0] === 'bbb');
})();

section('L3 答 again 降级时写入 lastDowngradeAt=今天');

(function () {
  const c = E.createCard(3);
  E.activate(c);
  E.grade(c, 'again', 'x');
  check('降到 L2 且记录降级日', c.level === 2 && c.lastDowngradeAt === S.today());
})();

/* ------------------------------------------------------------- 结果 */

console.log('\n' + '='.repeat(46));
console.log('引擎单测：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);
