/* ===========================================================================
 *  notebook.js —— 自定义单词本（与等级体系正交，只做收藏）
 * ---------------------------------------------------------------------------
 *  · 一个词可同时加入多个本；关系存在 Store.notebooks 里（本侧存 words），
 *    删本绝不删卡片、不影响任何复习进度。
 *  · bar(entry)：复习卡 / 速过卡上的「加入单词本」工具条，点开选择弹层，
 *    弹层里可直接新建本、可一次加入多本、可再点取消。
 *  · panel()：词书页的单词本管理区（建/改名/删本、展开看词、把词移出本）。
 *  纯零依赖：Store / UI / WB 缺失时调用方应已做降级，这里不再兜底业务。
 * =========================================================================== */

window.NotebookUI = (function () {
  'use strict';

  const el = window.UI.el;
  const S  = window.Store;

  let openMask = null;
  let expandedId = null;   // 管理面板当前展开的本 id

  /* ---------------------------------------------------------------- 弹层 */

  function onMaskKey(e) { if (e.key === 'Escape') closePicker(); }

  function closePicker() {
    if (openMask) {
      if (openMask.parentNode) openMask.parentNode.removeChild(openMask);
      openMask = null;
      document.removeEventListener('keydown', onMaskKey);
    }
  }

  /** 打开「加入单词本」选择弹层 */
  function openPicker(word) {
    closePicker();

    const list = el('div', { class: 'nb-list' });

    function renderList() {
      window.UI.clear(list);
      const nbs = S.listNotebooks();
      if (!nbs.length) {
        list.appendChild(el('p', { class: 'muted nb-empty',
          text: '还没有单词本，在下面输入名称新建一个吧' }));
        return;
      }
      nbs.forEach(function (nb) {
        const has = nb.words.indexOf(word) >= 0;
        const item = el('button', {
          class: 'nb-item' + (has ? ' is-in' : ''), type: 'button'
        }, [
          el('span', { class: 'nb-item-name', text: nb.name }),
          el('span', { class: 'nb-item-meta',
            text: (has ? '✓ 已在本中 · ' : '') + nb.count + ' 词' })
        ]);
        item.addEventListener('click', function () {
          if (has) {
            S.removeWordFromNotebook(nb.id, word);
            window.UI.toast('已从「' + nb.name + '」移除', 'info', 1500);
          } else {
            S.addWordToNotebook(nb.id, word);
            window.UI.toast('已加入「' + nb.name + '」', 'good', 1500);
          }
          renderList();
        });
        list.appendChild(item);
      });
    }

    const input = el('input', {
      class: 'input nb-new-input', type: 'text', maxlength: '40',
      placeholder: '新单词本名称，如：阅读高频词'
    });
    // 弹层里的输入框不能把按键冒泡到复习/速过的全局键盘监听上
    input.addEventListener('keydown', function (e) { e.stopPropagation(); });
    const createBtn = el('button', { class: 'btn', type: 'button', text: '新建并加入' });

    function create() {
      const nb = S.createNotebook(input.value);
      if (!nb) { window.UI.toast('请先输入单词本名称', 'warn', 1500); return; }
      S.addWordToNotebook(nb.id, word);
      input.value = '';
      window.UI.toast('已新建「' + nb.name + '」并加入该词', 'good', 2000);
      renderList();
    }
    createBtn.addEventListener('click', create);
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); create(); }
    });

    const sheet = el('div', { class: 'dlg nb-sheet' }, [
      el('h3', { class: 'dlg-title', text: '加入单词本 · ' + word }),
      list,
      el('div', { class: 'nb-create' }, [input, createBtn]),
      el('div', { class: 'dlg-actions' }, [
        el('button', { class: 'btn btn--primary', type: 'button',
          text: '完成', onclick: closePicker })
      ])
    ]);

    const mask = el('div', { class: 'dlg-mask' }, [sheet]);
    mask.addEventListener('click', function (e) { if (e.target === mask) closePicker(); });
    document.addEventListener('keydown', onMaskKey);
    document.body.appendChild(mask);
    openMask = mask;
    renderList();
  }

  /** 卡片上的工具条 */
  function bar(entry) {
    const word = entry.word;
    const n = S.notebooksOfWord(word).length;
    const btn = el('button', {
      class: 'nb-add-btn', type: 'button',
      text: n ? ('＋ 单词本（已在 ' + n + ' 本）') : '＋ 加入单词本',
      onclick: function () { openPicker(word); }
    });
    return el('div', { class: 'nb-bar' }, [btn]);
  }

  /* ------------------------------------------------------------ 管理面板 */

  function oneLineDef(word) {
    const entry = window.WB ? window.WB.get(word) : null;
    return entry ? window.WB.shortDef(entry, 24) : '';
  }

  /** 词书页：单词本管理区（返回 DOM，操作后局部重绘） */
  function panel() {
    const wrap = el('div', { class: 'nb-panel' });

    function rerender() {
      window.UI.clear(wrap);
      const nbs = S.listNotebooks();

      /* 新建行 */
      const input = el('input', {
        class: 'input nb-new-input', type: 'text', maxlength: '40',
        placeholder: '新建单词本，输入名称'
      });
      const addBtn = el('button', { class: 'btn btn--primary', type: 'button', text: '新建' });
      function doCreate() {
        const nb = S.createNotebook(input.value);
        if (!nb) { window.UI.toast('请先输入单词本名称', 'warn', 1500); return; }
        input.value = '';
        expandedId = nb.id;
        window.UI.toast('已新建「' + nb.name + '」', 'good', 1500);
        rerender();
      }
      addBtn.addEventListener('click', doCreate);
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); doCreate(); }
      });
      wrap.appendChild(el('div', { class: 'set-group nb-create-row' }, [
        el('div', { class: 'field' }, [
          el('label', { class: 'field-label', text: '我的单词本（' + nbs.length + '）' }),
          el('div', { class: 'nb-create' }, [input, addBtn])
        ])
      ]));

      if (!nbs.length) {
        wrap.appendChild(el('p', { class: 'muted',
          text: '还没有单词本。复习或速过时点「加入单词本」，或直接在这里新建。' }));
        return;
      }

      nbs.forEach(function (nb) {
        const open = expandedId === nb.id;
        const head = el('div', { class: 'nb-book-head' }, [
          el('button', {
            class: 'nb-book-toggle', type: 'button',
            text: (open ? '▾ ' : '▸ ') + nb.name + '（' + nb.count + '）',
            onclick: function () { expandedId = open ? null : nb.id; rerender(); }
          })
        ]);

        const renameBtn = el('button', {
          class: 'btn btn--mini', type: 'button', text: '改名',
          onclick: function () { startRename(nb.id, nb.name); }
        });
        const delBtn = el('button', {
          class: 'btn btn--mini btn--danger-ghost', type: 'button', text: '删除本',
          onclick: function () {
            window.UI.confirmDialog({
              title: '删除单词本「' + nb.name + '」？',
              body: '只会删除这个收藏夹，里面的词及其学习进度都保留，可随时重新收藏。',
              okText: '删除'
            }).then(function (ok) {
              if (!ok) return;
              S.removeNotebook(nb.id);
              if (expandedId === nb.id) expandedId = null;
              window.UI.toast('已删除单词本', 'info', 1500);
              rerender();
            });
          }
        });
        head.appendChild(renameBtn);
        head.appendChild(delBtn);

        const card = el('div', { class: 'nb-book' }, [head]);

        if (open) {
          const body = el('div', { class: 'nb-book-body' });
          if (!nb.words.length) {
            body.appendChild(el('p', { class: 'muted', text: '这个本里还没有词。' }));
          } else {
            nb.words.forEach(function (w) {
              body.appendChild(el('div', { class: 'nb-word-row' }, [
                el('span', { class: 'nb-word', text: w }),
                el('span', { class: 'nb-word-def muted', text: oneLineDef(w) }),
                el('button', {
                  class: 'btn btn--mini btn--danger-ghost', type: 'button', text: '移出',
                  onclick: function () {
                    S.removeWordFromNotebook(nb.id, w);
                    rerender();
                  }
                })
              ]));
            });
          }
          card.appendChild(body);
        }
        wrap.appendChild(card);
      });
    }

    function startRename(id, oldName) {
      const input2 = el('input', { class: 'input', type: 'text', value: oldName, maxlength: '40' });
      const ok = el('button', { class: 'btn btn--mini btn--primary', type: 'button', text: '确定' });
      const cancel = el('button', { class: 'btn btn--mini', type: 'button', text: '取消' });
      const row = el('div', { class: 'nb-rename' }, [input2, ok, cancel]);
      function commit() {
        if (S.renameNotebook(id, input2.value)) { window.UI.toast('已改名', 'good', 1200); rerender(); }
        else { window.UI.toast('名称不能为空', 'warn', 1200); }
      }
      ok.addEventListener('click', commit);
      input2.addEventListener('keydown', function (e) {
        e.stopPropagation();
        if (e.key === 'Enter') { e.preventDefault(); commit(); }
        if (e.key === 'Escape') rerender();
      });
      cancel.addEventListener('click', rerender);
      // 本卡片按 listNotebooks 的顺序排列，按下标定位后原地替换为改名行
      const books = wrap.querySelectorAll('.nb-book');
      const idx = S.listNotebooks().findIndex(function (b) { return b.id === id; });
      const node = books[idx];
      if (node) {
        window.UI.clear(node);
        node.appendChild(row);
        input2.focus(); input2.select();
      }
    }

    rerender();
    return wrap;
  }

  return { bar: bar, openPicker: openPicker, panel: panel, close: closePicker };
})();
