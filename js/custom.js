/* ===========================================================================
 *  custom.js —— 用户对词条的自定义内容
 * ---------------------------------------------------------------------------
 *  允许在词库自带内容之外，按单词保存：
 *    · defs    自己补充的释义（可多条，可删）
 *    · hide    被自己删掉（隐藏）的【自带释义】文本，可随时恢复
 *    · phrases 自己补充的词组 / 固定搭配 {text, zh}
 *    · note    自由笔记（一段文本，记辨析、易混、记忆法都行）
 *
 *  数据存在主档 state.custom[word]，随备份一起导出 / 导入；老存档没有这个
 *  字段时由 Store.fillDefaults 自动补成 {}，不需要写迁移。
 * =========================================================================== */

window.Custom = (function () {
  'use strict';

  function state() {
    const st = window.Store.get();
    if (!st.custom || typeof st.custom !== 'object') st.custom = {};
    return st;
  }

  function blank() { return { defs: [], hide: [], phrases: [], note: '' }; }

  /** 取某词的自定义对象（补齐缺字段）；create=false 时只读、不写空对象 */
  function get(word, create) {
    const st = state();
    let c = st.custom[word];
    if (!c) {
      if (!create) return null;
      c = blank(); st.custom[word] = c;
    }
    if (!Array.isArray(c.defs)) c.defs = [];
    if (!Array.isArray(c.hide)) c.hide = [];
    if (!Array.isArray(c.phrases)) c.phrases = [];
    if (typeof c.note !== 'string') c.note = '';
    return c;
  }

  function isEmpty(word) {
    const c = get(word, false);
    if (!c) return true;
    return !c.defs.length && !c.hide.length && !c.phrases.length && !c.note.trim();
  }

  /** 该自带释义是否被用户隐藏 */
  function isHidden(word, text) {
    const c = get(word, false);
    return !!(c && c.hide.indexOf(text) >= 0);
  }

  function addDef(word, text) {
    text = String(text == null ? '' : text).trim();
    if (!text) return false;
    const c = get(word, true);
    if (c.defs.indexOf(text) >= 0) return false;
    c.defs.push(text); window.Store.save(); return true;
  }
  function removeDef(word, idx) {
    const c = get(word, false); if (!c) return;
    c.defs.splice(idx, 1); window.Store.save();
  }

  function hideDef(word, text) {
    const c = get(word, true);
    if (c.hide.indexOf(text) < 0) { c.hide.push(text); window.Store.save(); }
  }
  function unhideDef(word, text) {
    const c = get(word, false); if (!c) return;
    const i = c.hide.indexOf(text);
    if (i >= 0) { c.hide.splice(i, 1); window.Store.save(); }
  }

  function addPhrase(word, en, zh) {
    en = String(en == null ? '' : en).trim();
    if (!en) return false;
    zh = String(zh == null ? '' : zh).trim();
    const c = get(word, true);
    if (c.phrases.some(function (p) { return p.text === en; })) return false;
    c.phrases.push({ text: en, zh: zh }); window.Store.save(); return true;
  }
  function removePhrase(word, idx) {
    const c = get(word, false); if (!c) return;
    c.phrases.splice(idx, 1); window.Store.save();
  }

  function setNote(word, text) {
    const c = get(word, true);
    c.note = String(text == null ? '' : text); window.Store.save();
  }

  return {
    get: get, isEmpty: isEmpty, isHidden: isHidden,
    addDef: addDef, removeDef: removeDef,
    hideDef: hideDef, unhideDef: unhideDef,
    addPhrase: addPhrase, removePhrase: removePhrase,
    setNote: setNote
  };
})();
