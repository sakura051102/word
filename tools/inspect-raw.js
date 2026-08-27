/* 抽查源数据，定位质量问题成因 */
const fs = require('fs');
const path = require('path');
const RICH = path.join(__dirname, '..', 'kaoyan_full_9602.jsonl');

const want = { row: 1, account: 1, compromise: 1 };
const found = {};

fs.readFileSync(RICH, 'utf8').split(/\r?\n/).forEach(function (line) {
  if (!line.trim()) return;
  let o; try { o = JSON.parse(line); } catch (e) { return; }
  const hw = String(o.headWord || '').toLowerCase();
  if (want[hw] && !found[hw]) found[hw] = o;
});

Object.keys(found).forEach(function (k) {
  const c = found[k].content.word.content;
  console.log('==========', k);
  console.log('-- trans（释义源）');
  (c.trans || []).forEach(function (t) {
    console.log('   pos=' + JSON.stringify(t.pos), 'tranCn=' + JSON.stringify(t.tranCn));
  });
  console.log('-- sentences（例句源，前3条原始值）');
  ((c.sentence && c.sentence.sentences) || []).slice(0, 3).forEach(function (s) {
    console.log('   ' + JSON.stringify(s.sContent));
  });
  console.log('-- phrases（短语源，全部原始值）');
  ((c.phrase && c.phrase.phrases) || []).forEach(function (p) {
    console.log('   ' + JSON.stringify(p.pContent) + ' => ' + JSON.stringify(p.pCn));
  });
  console.log('');
});
