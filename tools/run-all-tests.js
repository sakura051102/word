/* ===========================================================================
 *  tools/run-all-tests.js —— 一键测试编排器（npm test 入口，零第三方依赖）
 * ---------------------------------------------------------------------------
 *  顺序执行：
 *    1) node --check 逐文件语法检查（js/、tools/、data/、sw.js）
 *    2) smoke-test.js            主流程冒烟（正常动效）
 *    3) smoke-test.js --reduced  主流程冒烟（系统开启「减少动态效果」）
 *    4) verify-wordbook.js       词库不变量
 *    5) test-engine.js           间隔重复引擎边界断言
 *
 *  任一步骤失败立即以非零码退出，便于 CI / 提交前自查。
 *  运行： node tools/run-all-tests.js   或   npm test
 * =========================================================================== */

const fs   = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const NODE = process.execPath;

const results = [];

function walkJs(dir, out) {
  fs.readdirSync(dir, { withFileTypes: true }).forEach(function (e) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) return;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walkJs(full, out);
    else if (e.isFile() && e.name.endsWith('.js')) out.push(full);
  });
  return out;
}

function heading(t) {
  console.log('\n' + '■'.repeat(3) + ' ' + t + ' ' + '■'.repeat(3));
}

/* 1) 语法检查 —— 文件逐个 check，收集所有失败而不是第一个就停 ---------------- */

heading('1/5 语法检查 node --check（全部 .js）');
const files = [];
['js', 'tools', 'data'].forEach(function (d) {
  const p = path.join(ROOT, d);
  if (fs.existsSync(p)) walkJs(p, files);
});
['sw.js'].forEach(function (f) {
  const p = path.join(ROOT, f);
  if (fs.existsSync(p)) files.push(p);
});

let syntaxFail = 0;
files.forEach(function (f) {
  const r = spawnSync(NODE, ['--check', f], { encoding: 'utf8' });
  if (r.status !== 0) {
    syntaxFail++;
    console.log('  ✗ ' + path.relative(ROOT, f));
    console.log((r.stderr || r.stdout || '').split('\n').map(function (l) { return '      ' + l; }).join('\n'));
  }
});
console.log('  共检查 ' + files.length + ' 个文件，失败 ' + syntaxFail + ' 个');
results.push({ name: '语法检查', ok: syntaxFail === 0 });

/* 2~5) 子测试，直接继承标准输出，失败时保留完整日志 ------------------------- */

function runStep(label, args) {
  heading(label);
  const r = spawnSync(NODE, args, { cwd: ROOT, stdio: 'inherit' });
  const ok = r.status === 0;
  results.push({ name: label, ok: ok });
  return ok;
}

runStep('2/5 主流程冒烟 smoke-test', ['tools/smoke-test.js']);
runStep('3/5 主流程冒烟 smoke-test --reduced', ['tools/smoke-test.js', '--reduced']);
runStep('4/5 词库不变量 verify-wordbook', ['tools/verify-wordbook.js']);
runStep('5/5 引擎边界断言 test-engine', ['tools/test-engine.js']);

/* 汇总 -------------------------------------------------------------------- */

console.log('\n' + '='.repeat(50));
let allOk = true;
results.forEach(function (r) {
  console.log((r.ok ? '  ✓ ' : '  ✗ ') + r.name);
  if (!r.ok) allOk = false;
});
console.log('='.repeat(50));
console.log(allOk ? '全部测试通过' : '存在失败步骤，请查看上方日志');
process.exit(allOk ? 0 : 1);
