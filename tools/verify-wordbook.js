/* 校验 data/wordbook.js 生成结果是否符合程序预期 */
global.window = global;
require('../data/wordbook.js');
const w = window.WORDBOOK;

console.log('name    :', w.name);
console.log('hasFreq :', w.hasFreq, '| demo:', w.demo);
console.log('total   :', w.words.length);
console.log('');

function show(word) {
  const e = w.words.find(function (x) { return x.word === word; });
  if (!e) { console.log('---', word, '-> 未找到'); return; }
  console.log('---', word, '| freq:', e.freq, '| rank:', e.rank, '|', e.topic || '');
  console.log('   音标:', e.phonetic || '(无)');
  (e.defs || []).forEach(function (d) { console.log('   释义:', d.text, '| tag:', d.tag, '| count:', d.count); });
  console.log('   例句:', (e.examples || []).length,
              '| 短语:', (e.phrases || []).length,
              '| 同根:', (e.related || []).length);
  if (e.examples && e.examples[0]) console.log('      e.g.', e.examples[0].en);
  if (e.phrases && e.phrases[0]) console.log('      ph.', e.phrases[0].text, '—', e.phrases[0].zh);
}

['row', 'account', 'compromise', 'wink', 'the'].forEach(show);

/* --- 汇总 + 不变量检查 --- */
let z = 0, ph = 0, ex = 0, phr = 0, rel = 0, noDef = 0;
let senseTagged = 0, senseCounted = 0, dupWords = 0, emptyText = 0;
const seen = Object.create(null);

w.words.forEach(function (e) {
  if (e.freq === 0) z++;
  if (e.phonetic) ph++;
  if (e.examples && e.examples.length) ex++;
  if (e.phrases && e.phrases.length) phr++;
  if (e.related && e.related.length) rel++;
  if (!e.defs || !e.defs.length) noDef++;
  (e.defs || []).forEach(function (d) {
    if (d.tag) senseTagged++;
    if (d.count) senseCounted++;
    if (!d.text || !String(d.text).trim()) emptyText++;
  });
  if (seen[e.word]) dupWords++;
  seen[e.word] = 1;
});

console.log('');
console.log('=== 汇总 ===');
console.log('freq=0（真题未出现）:', z);
console.log('有音标:', ph, '| 有例句:', ex, '| 有短语:', phr, '| 有同根:', rel);
console.log('');
console.log('=== 不变量检查（应全部为 0）===');
console.log('无释义词条        :', noDef);
console.log('空释义文本        :', emptyText);
console.log('重复单词          :', dupWords);
console.log('义项带 tag        :', senseTagged,
            '  <- 必须为 0：义项级分级需要逐句词义消歧，判错比不标更误导人，所以不做');
console.log('义项带 count      :', senseCounted,
            '  <- 必须为 0：单词级词频绝不能写进义项级字段');
console.log('');
console.log('真题原句是【词条级】的，存在 data/corpus.js，由 tools/build-corpus.js 生成 ——');
console.log('它只保证「这句话里有这个词」，不声称哪个义项常考，所以不碰上面这两个字段。');
