/* ===========================================================================
 *  charts.js —— 手写 SVG 图表（不引任何外部库，保证完全离线可用）
 * ---------------------------------------------------------------------------
 *  配色取自 CSS 自定义属性，明暗两套在样式表里各自定义，
 *  这里只按角色取值，不写死 hex。
 *
 *  L1/L2/L3 用【单色相序数色阶】而不是三个不同色相：
 *  这三类是有序层级（生词 → 眼熟 → 熟词），不是无序分类，
 *  浅到深正好表达进度方向。
 *
 *  每张图都配一个表格视图 —— 图表不是读到数值的唯一途径。
 * =========================================================================== */

window.Charts = (function () {
  'use strict';

  const NS = 'http://www.w3.org/2000/svg';
  const el = window.UI.el;

  /* ---------------------------------------------------------------- 工具 */

  function svgEl(tag, attrs) {
    const n = document.createElementNS(NS, tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      const v = attrs[k];
      if (v === null || v === undefined || v === false) return;
      n.setAttribute(k, v);
    });
    return n;
  }

  function cssVar(name, fallback) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name);
    return (v && v.trim()) || fallback;
  }

  function palette() {
    return {
      l1:      cssVar('--series-l1', '#86b6ef'),
      l2:      cssVar('--series-l2', '#2a78d6'),
      l3:      cssVar('--series-l3', '#104281'),
      accent:  cssVar('--series-1',  '#2a78d6'),
      surface: cssVar('--surface-1', '#fcfcfb'),
      grid:    cssVar('--grid',      '#e1e0d9'),
      axis:    cssVar('--axis',      '#c3c2b7'),
      muted:   cssVar('--text-muted','#898781'),
      seq:     [
        cssVar('--seq-0', '#eceae4'),
        cssVar('--seq-1', '#cde2fb'),
        cssVar('--seq-2', '#9ec5f4'),
        cssVar('--seq-3', '#5598e7'),
        cssVar('--seq-4', '#256abf'),
        cssVar('--seq-5', '#104281')
      ]
    };
  }

  function fmtNum(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  function mmdd(d)   { return String(d).slice(5); }

  /* 带圆角顶端的柱形路径，底端贴基线（圆角只在数据端） */
  function barPath(x, y, w, h, r) {
    if (h <= 0) return '';
    r = Math.min(r, w / 2, h);
    return 'M' + x + ',' + (y + h) +
           ' L' + x + ',' + (y + r) +
           ' Q' + x + ',' + y + ' ' + (x + r) + ',' + y +
           ' L' + (x + w - r) + ',' + y +
           ' Q' + (x + w) + ',' + y + ' ' + (x + w) + ',' + (y + r) +
           ' L' + (x + w) + ',' + (y + h) + ' Z';
  }

  /* ---------------------------------------------------------------- 图表外壳 */

  /**
   * 统一的卡片外壳：标题 + 说明 + 图/表切换。
   * bodyFn(mode) 返回该模式下的内容节点。
   */
  function frame(title, note, bodyFn) {
    const body = el('div', { class: 'chart-body' });
    let mode = 'chart';

    function paint() {
      window.UI.clear(body);
      body.appendChild(bodyFn(mode));
    }

    const toggle = el('button', {
      class: 'chart-toggle', type: 'button', text: '表格',
      title: '切换图表 / 表格'
    });
    toggle.addEventListener('click', function () {
      mode = (mode === 'chart') ? 'table' : 'chart';
      toggle.textContent = (mode === 'chart') ? '表格' : '图表';
      paint();
    });

    const card = el('section', { class: 'chart-card' }, [
      el('header', { class: 'chart-head' }, [
        el('h3', { class: 'chart-title', text: title }),
        toggle
      ]),
      note ? el('p', { class: 'chart-note', text: note }) : null,
      body
    ]);
    paint();
    return card;
  }

  function table(headers, rows) {
    const t = el('table', { class: 'data-table' });
    const thead = el('thead', {}, [
      el('tr', {}, headers.map(function (h) { return el('th', { text: h }); }))
    ]);
    const tbody = el('tbody', {}, rows.map(function (r) {
      return el('tr', {}, r.map(function (c, i) {
        return el(i === 0 ? 'th' : 'td', { text: String(c) });
      }));
    }));
    t.appendChild(thead); t.appendChild(tbody);
    return el('div', { class: 'table-wrap' }, [t]);
  }

  function emptyNote(msg) {
    return el('p', { class: 'chart-empty', text: msg });
  }

  /* ---------------------------------------------------------------- 浮层提示 */

  let tipEl = null;
  function tip() {
    if (!tipEl) {
      tipEl = el('div', { class: 'chart-tip', hidden: true, role: 'status' });
      document.body.appendChild(tipEl);
    }
    return tipEl;
  }
  function showTip(html, x, y) {
    const t = tip();
    t.innerHTML = html;
    t.hidden = false;
    const r = t.getBoundingClientRect();
    let left = x + 14, top = y - r.height - 12;
    if (left + r.width > window.innerWidth - 8) left = x - r.width - 14;
    if (top < 8) top = y + 18;
    t.style.left = Math.max(8, left) + 'px';
    t.style.top  = Math.max(8, top) + 'px';
  }
  function hideTip() { if (tipEl) tipEl.hidden = true; }

  /* =======================================================================
   *  1. 三类词数量变化曲线（堆叠面积）—— 核心指标
   * ===================================================================== */

  function levelTrend(snaps) {
    const dates = Object.keys(snaps).sort();
    const note = 'L1 在缩小、L3 在增长，就是在进步。比「累计背了多少词」有意义得多。';

    return frame('三类词数量变化', note, function (mode) {
      if (dates.length < 2) {
        return mode === 'table'
          ? table(['日期', '生词', '眼熟', '熟词'],
                  dates.map(function (d) { return [d, snaps[d][0], snaps[d][1], snaps[d][2]]; }))
          : emptyNote('至少需要两天的记录才能画出趋势。继续用几天就有了。');
      }
      if (mode === 'table') {
        return table(['日期', '生词', '眼熟', '熟词', '合计'],
          dates.slice().reverse().map(function (d) {
            const v = snaps[d];
            return [d, v[0], v[1], v[2], v[0] + v[1] + v[2]];
          }));
      }
      return drawStackedArea(dates, dates.map(function (d) { return snaps[d]; }));
    });
  }

  function drawStackedArea(dates, values) {
    const P = palette();
    const W = 720, H = 260;
    const M = { t: 16, r: 16, b: 34, l: 52 };
    const iw = W - M.l - M.r, ih = H - M.t - M.b;

    const totals = values.map(function (v) { return v[0] + v[1] + v[2]; });
    const maxY = Math.max(1, Math.max.apply(null, totals));

    const svg = svgEl('svg', {
      viewBox: '0 0 ' + W + ' ' + H, class: 'chart-svg',
      role: 'img', 'aria-label': '三类词数量随时间变化的堆叠面积图'
    });

    const x = function (i) {
      return M.l + (dates.length === 1 ? iw / 2 : i / (dates.length - 1) * iw);
    };
    const y = function (v) { return M.t + ih - (v / maxY) * ih; };

    /* --- 网格：实线发丝，比表面深一档 --- */
    const ticks = niceTicks(maxY, 4);
    ticks.forEach(function (tv) {
      svg.appendChild(svgEl('line', {
        x1: M.l, x2: W - M.r, y1: y(tv), y2: y(tv),
        stroke: P.grid, 'stroke-width': 1
      }));
      svg.appendChild(svgEl('text', {
        x: M.l - 8, y: y(tv) + 4, 'text-anchor': 'end',
        class: 'axis-text', fill: P.muted
      })).textContent = fmtNum(tv);
    });

    /* --- 堆叠面积：从底到顶 L3 / L2 / L1 --- */
    const colors = [P.l1, P.l2, P.l3];
    const names  = ['生词', '眼熟', '熟词'];
    // 底部放 L3（熟词），顶部放 L1（生词）—— 生词的增减在顶部最易读
    const stackOrder = [2, 1, 0];

    const cum = values.map(function () { return 0; });
    const boundaries = [];

    stackOrder.forEach(function (si) {
      const lower = cum.slice();
      const upper = values.map(function (v, i) { return cum[i] + v[si]; });
      let d = '';
      upper.forEach(function (v, i) { d += (i ? 'L' : 'M') + x(i) + ',' + y(v); });
      for (let i = lower.length - 1; i >= 0; i--) d += 'L' + x(i) + ',' + y(lower[i]);
      d += 'Z';
      svg.appendChild(svgEl('path', { d: d, fill: colors[si], 'fill-opacity': 0.92 }));
      boundaries.push(upper.slice());
      upper.forEach(function (v, i) { cum[i] = v; });
    });

    /* --- 分隔：2px 表面色描边，而不是给色块加边框 --- */
    boundaries.slice(0, -1).forEach(function (line) {
      let d = '';
      line.forEach(function (v, i) { d += (i ? 'L' : 'M') + x(i) + ',' + y(v); });
      svg.appendChild(svgEl('path', {
        d: d, fill: 'none', stroke: P.surface, 'stroke-width': 2
      }));
    });

    /* --- 基线 --- */
    svg.appendChild(svgEl('line', {
      x1: M.l, x2: W - M.r, y1: M.t + ih, y2: M.t + ih,
      stroke: P.axis, 'stroke-width': 1
    }));

    /* --- x 轴刻度：只标首尾和中间，避免拥挤 --- */
    const labelIdx = dates.length <= 3
      ? dates.map(function (_, i) { return i; })
      : [0, Math.floor((dates.length - 1) / 2), dates.length - 1];
    labelIdx.forEach(function (i) {
      const anchor = i === 0 ? 'start' : (i === dates.length - 1 ? 'end' : 'middle');
      const t = svgEl('text', {
        x: x(i), y: H - 12, 'text-anchor': anchor, class: 'axis-text', fill: P.muted
      });
      t.textContent = mmdd(dates[i]);
      svg.appendChild(t);
    });

    /* --- 十字线 + 悬浮提示 --- */
    const cross = svgEl('line', {
      y1: M.t, y2: M.t + ih, stroke: P.axis, 'stroke-width': 1, opacity: 0
    });
    svg.appendChild(cross);

    const hit = svgEl('rect', {
      x: M.l, y: M.t, width: iw, height: ih, fill: 'transparent'
    });
    svg.appendChild(hit);

    function nearest(evt) {
      const box = svg.getBoundingClientRect();
      const px = (evt.clientX - box.left) / box.width * W;
      const ratio = (px - M.l) / iw;
      return Math.max(0, Math.min(dates.length - 1, Math.round(ratio * (dates.length - 1))));
    }
    function onMove(evt) {
      const i = nearest(evt);
      cross.setAttribute('x1', x(i));
      cross.setAttribute('x2', x(i));
      cross.setAttribute('opacity', 1);
      const v = values[i];
      showTip(
        '<div class="tip-date">' + dates[i] + '</div>' +
        row(P.l1, names[0], v[0]) + row(P.l2, names[1], v[1]) + row(P.l3, names[2], v[2]) +
        '<div class="tip-total">合计 ' + fmtNum(v[0] + v[1] + v[2]) + '</div>',
        evt.clientX, evt.clientY);
    }
    function row(c, n, val) {
      return '<div class="tip-row"><i style="background:' + c + '"></i>' +
             '<span>' + n + '</span><b>' + fmtNum(val) + '</b></div>';
    }
    hit.addEventListener('mousemove', onMove);
    hit.addEventListener('mouseleave', function () {
      cross.setAttribute('opacity', 0); hideTip();
    });

    /* --- 图例：两条以上系列必须有图例，身份不能只靠颜色 --- */
    const legend = el('ul', { class: 'legend' });
    [0, 1, 2].forEach(function (i) {
      const last = values[values.length - 1][i];
      legend.appendChild(el('li', {}, [
        el('i', { class: 'legend-dot', style: 'background:' + colors[i] }),
        el('span', { text: names[i] }),
        el('b', { text: fmtNum(last) })
      ]));
    });

    return el('div', {}, [svg, legend]);
  }

  function niceTicks(max, n) {
    const raw = max / n;
    const mag = Math.pow(10, Math.floor(Math.log10(Math.max(1, raw))));
    const step = Math.ceil(raw / mag) * mag;
    const out = [];
    for (let v = 0; v <= max + step * 0.001; v += step) out.push(Math.round(v));
    return out;
  }

  /* =======================================================================
   *  2. 普查进度 —— 不用环形图（两段的饼是反模式），用数字 + 条
   * ===================================================================== */

  function triageProgress(done, total, counts) {
    const pct = total ? (done / total * 100) : 0;
    const note = null;

    return frame('普查进度', note, function (mode) {
      if (mode === 'table') {
        return table(['项目', '数量', '占比'], [
          ['已分类', fmtNum(done), pct.toFixed(1) + '%'],
          ['未分类', fmtNum(total - done), (100 - pct).toFixed(1) + '%'],
          ['— 生词 L1', fmtNum(counts[0]), pctOf(counts[0], done)],
          ['— 眼熟 L2', fmtNum(counts[1]), pctOf(counts[1], done)],
          ['— 熟词 L3', fmtNum(counts[2]), pctOf(counts[2], done)]
        ]);
      }
      const P = palette();
      const box = el('div', { class: 'progress-block' });

      box.appendChild(el('div', { class: 'hero' }, [
        el('span', { class: 'hero-num', text: pct.toFixed(0) + '%' }),
        el('span', { class: 'hero-sub', text: fmtNum(done) + ' / ' + fmtNum(total) + ' 个词已建档' })
      ]));

      if (done > 0) {
        const bar = el('div', { class: 'stack-bar stack-bar--lg' });
        const colors = [P.l1, P.l2, P.l3];
        const names = ['生词', '眼熟', '熟词'];
        [0, 1, 2].forEach(function (i) {
          if (!counts[i]) return;
          const seg = el('div', {
            class: 'stack-seg', style: 'flex:' + counts[i] + ';background:' + colors[i],
            tabindex: '0', title: names[i] + ' ' + fmtNum(counts[i]) + ' 个（' + pctOf(counts[i], done) + '）'
          });
          seg.addEventListener('mousemove', function (e) {
            showTip('<div class="tip-row"><i style="background:' + colors[i] + '"></i><span>' +
                    names[i] + '</span><b>' + fmtNum(counts[i]) + '</b></div>' +
                    '<div class="tip-total">占已分类的 ' + pctOf(counts[i], done) + '</div>',
                    e.clientX, e.clientY);
          });
          seg.addEventListener('mouseleave', hideTip);
          bar.appendChild(seg);
        });
        box.appendChild(bar);

        const legend = el('ul', { class: 'legend' });
        [0, 1, 2].forEach(function (i) {
          legend.appendChild(el('li', {}, [
            el('i', { class: 'legend-dot', style: 'background:' + colors[i] }),
            el('span', { text: names[i] }),
            el('b', { text: fmtNum(counts[i]) })
          ]));
        });
        box.appendChild(legend);
      }
      return box;
    });
  }

  function pctOf(a, b) { return b ? (a / b * 100).toFixed(1) + '%' : '0%'; }

  /* =======================================================================
   *  3. 打卡热力图（近 12 周）
   * ===================================================================== */

  function heatmap(daily) {
    const WEEKS = 12;
    const days = window.Store.lastNDays(WEEKS * 7);
    const note = '每格一天，颜色深浅表示当天过词量。';

    return frame('最近 12 周打卡', note, function (mode) {
      const rows = days.map(function (d) {
        const v = daily[d];
        return [d, v ? (v.total || 0) : 0, v ? (v.triaged || 0) : 0];
      });
      if (mode === 'table') {
        return table(['日期', '复习过词', '普查分类'],
          rows.slice().reverse().filter(function (r) { return r[1] || r[2]; }));
      }
      return drawHeatmap(days, daily);
    });
  }

  function drawHeatmap(days, daily) {
    const P = palette();
    const CELL = 15, GAP = 3, TOP = 18, LEFT = 26;
    // 第一列要对齐到起始日所在周的星期几，所以列数按偏移后的总格数算，
    // 直接用 days.length/7 会少算一列、最后一周被画到画布外
    const firstDow = window.Store.parse(days[0]).getDay();
    const cols = Math.ceil((days.length + firstDow) / 7);
    const W = LEFT + cols * (CELL + GAP);
    const H = TOP + 7 * (CELL + GAP) + 6;

    const counts = days.map(function (d) {
      const v = daily[d];
      return v ? ((v.total || 0) + (v.triaged || 0)) : 0;
    });
    const max = Math.max.apply(null, counts.concat([1]));

    function bucket(c) {
      if (!c) return 0;
      const r = c / max;
      if (r <= 0.2) return 1;
      if (r <= 0.4) return 2;
      if (r <= 0.6) return 3;
      if (r <= 0.8) return 4;
      return 5;
    }

    const svg = svgEl('svg', {
      viewBox: '0 0 ' + W + ' ' + H, class: 'chart-svg chart-svg--heat',
      role: 'img', 'aria-label': '最近 12 周每日学习量热力图'
    });

    // 第一列对齐到所在周的星期几（firstDow 在上面已算好）

    ['一', '三', '五'].forEach(function (lbl, k) {
      const dow = [1, 3, 5][k];
      const t = svgEl('text', {
        x: LEFT - 6, y: TOP + dow * (CELL + GAP) + CELL - 3,
        'text-anchor': 'end', class: 'axis-text', fill: P.muted
      });
      t.textContent = lbl;
      svg.appendChild(t);
    });

    days.forEach(function (d, i) {
      const pos = i + firstDow;
      const col = Math.floor(pos / 7), row = pos % 7;
      const b = bucket(counts[i]);
      const rect = svgEl('rect', {
        x: LEFT + col * (CELL + GAP), y: TOP + row * (CELL + GAP),
        width: CELL, height: CELL, rx: 3,
        fill: P.seq[b]
      });
      rect.addEventListener('mousemove', function (e) {
        const v = daily[d] || {};
        showTip('<div class="tip-date">' + d + '</div>' +
                '<div class="tip-row"><span>复习过词</span><b>' + (v.total || 0) + '</b></div>' +
                '<div class="tip-row"><span>普查分类</span><b>' + (v.triaged || 0) + '</b></div>',
                e.clientX, e.clientY);
      });
      rect.addEventListener('mouseleave', hideTip);
      svg.appendChild(rect);
    });

    /* 刻度图例 —— 连续色阶必须有比例尺 */
    const scale = el('div', { class: 'heat-scale' }, [el('span', { text: '少' })]);
    [0, 1, 2, 3, 4, 5].forEach(function (b) {
      scale.appendChild(el('i', { class: 'heat-swatch', style: 'background:' + P.seq[b] }));
    });
    scale.appendChild(el('span', { text: '多' }));

    return el('div', {}, [
      el('div', { class: 'heat-wrap' }, [svg]),
      scale
    ]);
  }

  /* =======================================================================
   *  4. 未来 7 天复习量预测
   * ===================================================================== */

  function forecastChart(fc) {
    const note = '提前看到哪天会爆量，可以主动把那几天的新词量调低。';
    return frame('未来 7 天待复习', note, function (mode) {
      if (mode === 'table') {
        return table(['日期', '待复习'], fc.map(function (d, i) {
          return [d.date + (i === 0 ? '（今天）' : ''), d.count];
        }));
      }
      if (!fc.some(function (d) { return d.count > 0; })) {
        return emptyNote('未来 7 天没有到期的词。');
      }
      return drawBars(fc.map(function (d, i) {
        return { label: i === 0 ? '今天' : mmdd(d.date), value: d.count, full: d.date };
      }));
    });
  }

  function drawBars(data) {
    const P = palette();
    const W = 720, H = 220;
    const M = { t: 20, r: 16, b: 34, l: 48 };
    const iw = W - M.l - M.r, ih = H - M.t - M.b;
    const max = Math.max(1, Math.max.apply(null, data.map(function (d) { return d.value; })));

    const svg = svgEl('svg', {
      viewBox: '0 0 ' + W + ' ' + H, class: 'chart-svg',
      role: 'img', 'aria-label': '未来 7 天每日待复习词数柱状图'
    });

    const ticks = niceTicks(max, 4);
    ticks.forEach(function (tv) {
      const yy = M.t + ih - (tv / max) * ih;
      svg.appendChild(svgEl('line', {
        x1: M.l, x2: W - M.r, y1: yy, y2: yy, stroke: P.grid, 'stroke-width': 1
      }));
      const t = svgEl('text', {
        x: M.l - 8, y: yy + 4, 'text-anchor': 'end', class: 'axis-text', fill: P.muted
      });
      t.textContent = fmtNum(tv);
      svg.appendChild(t);
    });

    const slot = iw / data.length;
    const bw = Math.min(46, slot - 10);   // 相邻柱之间留出表面色间隙

    data.forEach(function (d, i) {
      const h = (d.value / max) * ih;
      const bx = M.l + i * slot + (slot - bw) / 2;
      const by = M.t + ih - h;
      if (h > 0) {
        const p = svgEl('path', { d: barPath(bx, by, bw, h, 4), fill: P.accent });
        svg.appendChild(p);
      }
      // 命中区比柱本身大，避免要精准点中
      const hit = svgEl('rect', {
        x: M.l + i * slot, y: M.t, width: slot, height: ih, fill: 'transparent'
      });
      hit.addEventListener('mousemove', function (e) {
        showTip('<div class="tip-date">' + (d.full || d.label) + '</div>' +
                '<div class="tip-row"><span>待复习</span><b>' + fmtNum(d.value) + '</b></div>',
                e.clientX, e.clientY);
      });
      hit.addEventListener('mouseleave', hideTip);
      svg.appendChild(hit);

      // 选择性直接标注：只标非零值，且柱够高时标在柱内，否则标在柱外
      if (d.value > 0) {
        const inside = h > 22;
        const t = svgEl('text', {
          x: bx + bw / 2, y: inside ? by + 15 : by - 6,
          'text-anchor': 'middle', class: 'bar-label',
          fill: inside ? P.surface : cssVar('--text-secondary', '#52514e')
        });
        t.textContent = fmtNum(d.value);
        svg.appendChild(t);
      }

      const lbl = svgEl('text', {
        x: M.l + i * slot + slot / 2, y: H - 12,
        'text-anchor': 'middle', class: 'axis-text', fill: P.muted
      });
      lbl.textContent = d.label;
      svg.appendChild(lbl);
    });

    svg.appendChild(svgEl('line', {
      x1: M.l, x2: W - M.r, y1: M.t + ih, y2: M.t + ih,
      stroke: P.axis, 'stroke-width': 1
    }));

    return svg;
  }

  /* =======================================================================
   *  5. 每日正确率（近 30 天）
   * ===================================================================== */

  function accuracyChart(daily) {
    const days = window.Store.lastNDays(30);
    const pts = days.map(function (d) {
      const v = daily[d];
      const total = v ? (v.total || 0) : 0;
      return { date: d, total: total, value: total ? Math.round((v.correct || 0) / total * 100) : null };
    });
    const withData = pts.filter(function (p) { return p.value !== null; });
    const note = '只统计有复习记录的日子。';

    return frame('每日正确率', note, function (mode) {
      if (mode === 'table') {
        return table(['日期', '过词', '正确率'],
          withData.slice().reverse().map(function (p) {
            return [p.date, p.total, p.value + '%'];
          }));
      }
      if (withData.length < 2) return emptyNote('至少需要两天的复习记录。');
      return drawLine(pts);
    });
  }

  function drawLine(pts) {
    const P = palette();
    const W = 720, H = 220;
    const M = { t: 20, r: 16, b: 34, l: 48 };
    const iw = W - M.l - M.r, ih = H - M.t - M.b;

    const svg = svgEl('svg', {
      viewBox: '0 0 ' + W + ' ' + H, class: 'chart-svg',
      role: 'img', 'aria-label': '最近 30 天每日正确率折线图'
    });

    const x = function (i) { return M.l + i / (pts.length - 1) * iw; };
    const y = function (v) { return M.t + ih - (v / 100) * ih; };

    [0, 25, 50, 75, 100].forEach(function (tv) {
      svg.appendChild(svgEl('line', {
        x1: M.l, x2: W - M.r, y1: y(tv), y2: y(tv), stroke: P.grid, 'stroke-width': 1
      }));
      const t = svgEl('text', {
        x: M.l - 8, y: y(tv) + 4, 'text-anchor': 'end', class: 'axis-text', fill: P.muted
      });
      t.textContent = tv + '%';
      svg.appendChild(t);
    });

    /* 断点处断开而不是插值 —— 没复习的日子不该被连成一条假的趋势 */
    let d = '', pen = false;
    pts.forEach(function (p, i) {
      if (p.value === null) { pen = false; return; }
      d += (pen ? 'L' : 'M') + x(i) + ',' + y(p.value);
      pen = true;
    });
    svg.appendChild(svgEl('path', {
      d: d, fill: 'none', stroke: P.accent, 'stroke-width': 2,
      'stroke-linejoin': 'round', 'stroke-linecap': 'round'
    }));

    pts.forEach(function (p, i) {
      if (p.value === null) return;
      svg.appendChild(svgEl('circle', {
        cx: x(i), cy: y(p.value), r: 4, fill: P.accent,
        stroke: P.surface, 'stroke-width': 2
      }));
    });

    const cross = svgEl('line', { y1: M.t, y2: M.t + ih, stroke: P.axis, 'stroke-width': 1, opacity: 0 });
    svg.appendChild(cross);
    const hit = svgEl('rect', { x: M.l, y: M.t, width: iw, height: ih, fill: 'transparent' });
    hit.addEventListener('mousemove', function (evt) {
      const box = svg.getBoundingClientRect();
      const px = (evt.clientX - box.left) / box.width * W;
      const i = Math.max(0, Math.min(pts.length - 1, Math.round((px - M.l) / iw * (pts.length - 1))));
      cross.setAttribute('x1', x(i)); cross.setAttribute('x2', x(i));
      cross.setAttribute('opacity', 1);
      const p = pts[i];
      showTip('<div class="tip-date">' + p.date + '</div>' +
              (p.value === null
                ? '<div class="tip-row"><span>没有复习记录</span></div>'
                : '<div class="tip-row"><span>正确率</span><b>' + p.value + '%</b></div>' +
                  '<div class="tip-row"><span>过词</span><b>' + p.total + '</b></div>'),
              evt.clientX, evt.clientY);
    });
    hit.addEventListener('mouseleave', function () { cross.setAttribute('opacity', 0); hideTip(); });
    svg.appendChild(hit);

    svg.appendChild(svgEl('line', {
      x1: M.l, x2: W - M.r, y1: M.t + ih, y2: M.t + ih, stroke: P.axis, 'stroke-width': 1
    }));

    const labelIdx = [0, Math.floor((pts.length - 1) / 2), pts.length - 1];
    labelIdx.forEach(function (i) {
      const anchor = i === 0 ? 'start' : (i === pts.length - 1 ? 'end' : 'middle');
      const t = svgEl('text', {
        x: x(i), y: H - 12, 'text-anchor': anchor, class: 'axis-text', fill: P.muted
      });
      t.textContent = mmdd(pts[i].date);
      svg.appendChild(t);
    });

    return svg;
  }

  /* =======================================================================
   *  统计小卡（连续打卡等）
   * ===================================================================== */

  function streak(daily) {
    let n = 0;
    let d = window.Store.today();
    // 今天还没学不算断，从昨天开始回溯
    const t = daily[d];
    if (!t || (!(t.total > 0) && !(t.triaged > 0))) d = window.Store.addDays(d, -1);
    for (let i = 0; i < 400; i++) {
      const v = daily[d];
      if (v && ((v.total || 0) > 0 || (v.triaged || 0) > 0)) { n++; d = window.Store.addDays(d, -1); }
      else break;
    }
    return n;
  }

  function statTiles(items) {
    return el('div', { class: 'tiles' }, items.map(function (it) {
      return el('div', { class: 'tile' }, [
        el('span', { class: 'tile-num', text: it.value }),
        el('span', { class: 'tile-label', text: it.label }),
        it.note ? el('span', { class: 'tile-note', text: it.note }) : null
      ]);
    }));
  }

  return {
    levelTrend: levelTrend,
    triageProgress: triageProgress,
    heatmap: heatmap,
    forecastChart: forecastChart,
    accuracyChart: accuracyChart,
    statTiles: statTiles,
    streak: streak,
    hideTip: hideTip
  };
})();
