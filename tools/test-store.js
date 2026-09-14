/* ===========================================================================
 *  tools/test-store.js —— 存储层数据安全断言（落盘轮换 / 损坏回滚 / 迁移 / 备份提醒）
 * ---------------------------------------------------------------------------
 *  用可控的内存 localStorage 桩把 store.js 加载进 vm，主动制造「主档写坏」
 *  「备份缺失」等故障，验证不会白屏、不会静默丢档。
 *
 *  运行： node tools/test-store.js（也由 run-all-tests.js / npm test 串起）
 * =========================================================================== */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}
function section(t) { console.log('\n=== ' + t + ' ==='); }

/* 每次用全新的内存存储 + 同步 setTimeout，构建一个独立 Store 单例环境 */
function freshStore(initial) {
  const mem = Object.assign({}, initial || {});
  const sandbox = {
    // 故障路径本就会 console.warn/error，已由断言覆盖，测试输出里不再打印堆栈
    console: { log: console.log.bind(console), warn: function () {}, error: function () {} },
    // 同步执行，让节流写入在测试里立即落盘，结果确定、不用 sleep
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
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'js', 'store.js'), 'utf8'),
                  sandbox, { filename: 'store.js' });
  return { S: sandbox.Store, mem: sandbox.localStorage, raw: mem };
}

/* ====================================================== 1. 落盘轮换备份 */

section('落盘轮换：每次写入把上一代主档挪为备份');

(function () {
  const env = freshStore();
  env.S.load();
  env.S.setCard('alpha', { level: 1 });
  env.S.setCard('beta', { level: 2 });              // 同步桩下立即落盘
  const main = JSON.parse(env.mem.getItem(env.S.KEY));
  check('新主档含 alpha + beta', !!main.cards.alpha && !!main.cards.beta);
  const backup = env.mem.getItem(env.S.BACKUP_KEY);
  check('备份键存在上一版', !!backup);
  const bk = backup ? JSON.parse(backup) : {};
  check('备份只含上一代的 alpha（不含刚写的 beta）',
        !!bk.cards.alpha && !bk.cards.beta,
        'alpha=' + !!bk.cards.alpha + ' beta=' + !!bk.cards.beta);
})();

/* ====================================================== 2. 主档损坏→回滚 */

section('主档损坏：自动回滚到上一版备份并给出提示');

(function () {
  const goodBackup = JSON.stringify({
    version: 1, cards: { saved: { level: 2 } }, settings: {}, triage: { cursor: 9 }
  });
  const env = freshStore({
    kaoyan_vocab_v1: '{这是被截断写坏的主档,,,',
    kaoyan_vocab_v1_backup: goodBackup
  });
  const st = env.S.load();
  check('回滚后取回备份里的卡', !!st.cards.saved);
  const n = env.S.consumeNotice();
  check('给出 recovered 提示', n && n.type === 'recovered', JSON.stringify(n));
  const corruptKeys = Object.keys(env.raw).filter(function (k) {
    return k.indexOf('kaoyan_vocab_v1_corrupt_') === 0;
  });
  check('损坏原文被隔离到 *_corrupt_* 键（没被覆盖）', corruptKeys.length === 1,
        'corrupt keys=' + corruptKeys.length);
  check('提示只消费一次', env.S.consumeNotice() === null);
})();

/* ============================================ 3. 主档损坏且无备份→空档 */

section('主档损坏且无备份：安全空档，不抛异常');

(function () {
  const env = freshStore({ kaoyan_vocab_v1: 'not-json{{' });
  const st = env.S.load();
  check('回落到空存档', st && Object.keys(st.cards).length === 0);
  const n = env.S.consumeNotice();
  check('给出 corrupt 提示', n && n.type === 'corrupt');
})();

section('主档与备份都损坏：同样安全空档');

(function () {
  const env = freshStore({
    kaoyan_vocab_v1: 'bad1', kaoyan_vocab_v1_backup: 'bad2'
  });
  const st = env.S.load();
  check('双损坏仍能拿到空存档', st && Object.keys(st.cards).length === 0);
  const n = env.S.consumeNotice();
  check('给出 corrupt 提示', n && n.type === 'corrupt');
})();

/* ====================================================== 4. 老存档补字段 */

section('向前兼容：老存档缺字段由默认值补齐');

(function () {
  const env = freshStore({ kaoyan_vocab_v1: JSON.stringify({
    version: 1, cards: { x: { level: 1 } }   // 缺 settings/triage/daily/新字段
  }) });
  const st = env.S.load();
  check('settings 补齐', st.settings && st.settings.dailyNew === 40);
  check('新增的 lastExportAt 补齐为 null', st.lastExportAt === null);
  check('triage 补齐', st.triage && st.triage.cursor === 0);
  check('version 归一到当前版本', st.version === env.S.CURRENT_VERSION);
})();

/* ====================================================== 5. 备份提醒阈值 */

section('备份提醒：500 词 / 7 天阈值');

(function () {
  const env = freshStore();
  env.S.load();
  const st = env.S.get();
  // 从未导出且不足 500 → 不提醒
  for (let i = 0; i < 100; i++) st.cards['w' + i] = { level: 1 };
  check('未导出且 100 词：ok', env.S.backupAdvice().level === 'ok');
  // 凑到 500 → 提醒
  for (let i = 100; i < 500; i++) st.cards['w' + i] = { level: 1 };
  check('未导出且满 500 词：warn', env.S.backupAdvice().level === 'warn');
  // 刚导出 → 解除
  env.S.markExported();
  const a = env.S.backupAdvice();
  check('导出后恢复 ok', a.level === 'ok' && a.lastExportAt === env.S.today());
  // 模拟 8 天前导出 → 提醒
  st.lastExportAt = env.S.addDays(env.S.today(), -8);
  check('距上次导出 8 天：warn', env.S.backupAdvice().level === 'warn');
  // 6 天前 → 不提醒
  st.lastExportAt = env.S.addDays(env.S.today(), -6);
  check('距上次导出 6 天：ok', env.S.backupAdvice().level === 'ok');
})();

/* ====================================================== 7. 学习记录 CSV */

section('学习记录导出 CSV：BOM / CRLF / 升序 / 正确率');

(function () {
  const env = freshStore();
  env.S.load();
  const yesterday = env.S.addDays(env.S.today(), -1);
  env.S.bump('total', 4, yesterday);
  env.S.bump('correct', 3, yesterday);   // 3/4 = 75%
  env.S.bump('new', 2, yesterday);
  env.S.bump('review', 2, yesterday);
  env.S.bump('total', 5);
  env.S.bump('correct', 5);             // 5/5 = 100%

  const csv = env.S.toCSV();
  check('带 UTF-8 BOM（Excel 不乱码）', csv.charCodeAt(0) === 0xFEFF);
  const lines = csv.slice(1).split('\r\n');
  check('CRLF 分行：表头 + 两天 = 3 行', lines.length === 3, '实际 ' + lines.length);
  check('表头以 date 开头且含 accuracyPct',
        lines[0].indexOf('date') === 0 && lines[0].indexOf('accuracyPct') >= 0);
  check('按日期升序，第一行数据是昨天', lines[1].indexOf(yesterday) === 0);
  check('昨天正确率 75', lines[1].split(',')[6] === '75', lines[1]);
  check('今天正确率 100', lines[2].split(',')[6] === '100', lines[2]);
})();

/* ============================================ v1 → v2 迁移：两类化 + 熟词来源 */

section('v1 老存档迁移到 v2：配额两类、删 skipL3Patrol、现存 L3 标 legacy、初始化单词本');

(function () {
  const v1 = {
    version: 1,
    settings: { quota: [6, 3, 1], skipL3Patrol: true, dailyNew: 30 },
    triage: { cursor: 5 },
    cards: {
      oldL3: { level: 3, active: true, interval: 20, reps: 1 },
      oldL1: { level: 1, active: false }
    },
    daily: {}, levelSnap: {}, upgradeSnooze: {}
  };
  const env = freshStore({ kaoyan_vocab_v1: JSON.stringify(v1) });
  const st = env.S.load();
  check('版本升到 2', st.version === 2, '实际 ' + st.version);
  check('配额收成两类 [6,3]',
        Array.isArray(st.settings.quota) && st.settings.quota.length === 2 &&
        st.settings.quota[0] === 6 && st.settings.quota[1] === 3,
        JSON.stringify(st.settings.quota));
  check('skipL3Patrol 被移除', st.settings.skipL3Patrol === undefined);
  check('现存 L3 标为 legacy（原熟词）', st.cards.oldL3.l3Origin === 'legacy',
        String(st.cards.oldL3.l3Origin));
  check('L1 卡不被误标来源', !st.cards.oldL1.l3Origin);
  check('卡片补 archived=false', st.cards.oldL3.archived === false && st.cards.oldL1.archived === false);
  check('迁移不丢卡（L3 仍在）', st.cards.oldL3.level === 3);
  check('初始化空单词本容器', st.notebooks && typeof st.notebooks === 'object' &&
        Object.keys(st.notebooks).length === 0);
})();

/* ====================================================== 单词本 CRUD */

section('单词本：多本、一词多本、去重、改名删本');

(function () {
  const env = freshStore();
  const S = env.S; S.load();
  const nb = S.createNotebook('阅读');
  check('创建返回带 id 的本', !!(nb && nb.id));
  check('空白名称创建失败（null）', S.createNotebook('   ') === null);
  check('当前 1 本', S.listNotebooks().length === 1);
  check('首次加入返回 true', S.addWordToNotebook(nb.id, 'apple') === true);
  check('重复加入去重返回 false', S.addWordToNotebook(nb.id, 'apple') === false);
  check('本内计数为 1', S.getNotebook(nb.id).words.length === 1);

  const nb2 = S.createNotebook('写作');
  check('再建一本共 2 本', S.listNotebooks().length === 2);
  S.addWordToNotebook(nb2.id, 'apple');
  check('一个词可同时进多本', S.notebooksOfWord('apple').length === 2);
  check('从第一本移除', S.removeWordFromNotebook(nb.id, 'apple') === true);
  check('移除后该词仍留在另一本', S.notebooksOfWord('apple').length === 1);
  check('改名成功', S.renameNotebook(nb.id, '阅读高频') === true &&
        S.getNotebook(nb.id).name === '阅读高频');
  check('删除本成功', S.removeNotebook(nb.id) === true && S.listNotebooks().length === 1);
  check('向不存在的本加词失败', S.addWordToNotebook('nope', 'x') === false);
})();

/* ------------------------------------------------------------- 结果 */

console.log('\n' + '='.repeat(46));
console.log('存储单测：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);
