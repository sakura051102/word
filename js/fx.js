/* ===========================================================================
 *  fx.js —— 视觉反馈层（粒子 / 连击 / 转场 / 背景）
 * ---------------------------------------------------------------------------
 *  设计约束，三条，都是硬的：
 *
 *  1. 【纯装饰，不可影响主流程】
 *     背单词的核心是那份进度档案。特效再花哨也只是糖，
 *     所以每个对外接口都包在 try/catch 里 —— FX 整个挂掉，
 *     背单词也必须照常能用，最多是「没有烟花」。
 *
 *  2. 【旁路渲染，不进状态机】
 *     review.js 有自己的 render() 全量重绘。如果把动画状态塞进 sess，
 *     每次重绘都得回答「这个动画播到哪了」，复杂度会失控。
 *     这里改成：特效画在独立的 fixed 图层上，只接收
 *     「在这个坐标放个烟花」这种一次性指令，调用方发完就忘。
 *
 *  3. 【手机优先】
 *     粒子数按屏幕面积算；背景 canvas 限 30fps；
 *     页面切后台立刻停 rAF —— 否则锁屏后还在烧电池。
 *     prefers-reduced-motion 命中时整个模块空转。
 * =========================================================================== */

window.FX = (function () {
  'use strict';

  /* ---------------------------------------------------------------- 环境探测 */

  const reduced = (function () {
    try {
      return window.matchMedia &&
             window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch (e) { return false; }
  })();

  /* Web Animations API 不可用就整体降级（老 Safari / 部分国产内核） */
  const canAnimate = typeof Element !== 'undefined' &&
                     typeof Element.prototype.animate === 'function';

  const OFF = reduced || !canAnimate;

  /** 把不可靠的装饰逻辑统一包起来。坏了只在控制台留一句，不弹给用户。 */
  function guard(fn) {
    return function () {
      if (OFF) return;
      try { return fn.apply(null, arguments); }
      catch (e) { if (window.console) console.debug('[fx]', e); }
    };
  }

  /* ---------------------------------------------------------------- 图层 */

  let layer = null;

  function getLayer() {
    if (layer && layer.isConnected) return layer;
    layer = document.createElement('div');
    layer.className = 'fx-layer';
    layer.setAttribute('aria-hidden', 'true');
    document.body.appendChild(layer);
    return layer;
  }

  /** 取元素中心的视口坐标。元素已被移除时返回 null，调用方直接放弃。 */
  function centerOf(target) {
    if (!target || !target.getBoundingClientRect) return null;
    const r = target.getBoundingClientRect();
    if (!r.width && !r.height) return null;
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, rect: r };
  }

  /* ---------------------------------------------------------------- 调色 */

  const PALETTE = {
    good:    ['#4ade80', '#22d3ee', '#a5f3fc'],
    great:   ['#22d3ee', '#a78bfa', '#f472b6', '#a5f3fc'],
    bad:     ['#fb7185', '#f472b6'],
    neutral: ['#a78bfa', '#22d3ee'],
    gold:    ['#fbbf24', '#fde68a', '#f472b6']
  };

  function pick(arr) { return arr[(Math.random() * arr.length) | 0]; }

  /* ---------------------------------------------------------------- 粒子爆发 */

  /* 屏幕小就少放点 —— 手机上 24 个粒子已经很热闹，
     再多只是掉帧，看不出更好看。 */
  function scaleCount(n) {
    const w = window.innerWidth || 800;
    if (w < 480) return Math.max(4, Math.round(n * 0.55));
    if (w < 760) return Math.max(5, Math.round(n * 0.75));
    return n;
  }

  /**
   * 从 target 中心爆出一圈粒子。
   * @param target  DOM 元素（按钮、卡片…）
   * @param opts    {kind, count, power, spread}
   *                kind   见 PALETTE
   *                power  飞出距离（px），默认 90
   *                spread 角度范围（弧度），默认全圆
   */
  const burst = guard(function (target, opts) {
    const c = centerOf(target);
    if (!c) return;
    const o = opts || {};
    const colors = PALETTE[o.kind] || PALETTE.neutral;
    const count  = scaleCount(o.count || 18);
    const power  = o.power || 90;
    const base   = o.angle === undefined ? -Math.PI / 2 : o.angle;
    const spread = o.spread === undefined ? Math.PI * 2 : o.spread;
    const host   = getLayer();

    for (let i = 0; i < count; i++) {
      const p = document.createElement('i');
      p.className = 'fx-dot';

      const size = 4 + Math.random() * 5;
      const col  = pick(colors);
      p.style.cssText =
        'left:' + c.x + 'px;top:' + c.y + 'px;' +
        'width:' + size.toFixed(1) + 'px;height:' + size.toFixed(1) + 'px;' +
        'background:' + col + ';box-shadow:0 0 ' + (size * 2).toFixed(0) + 'px ' + col + ';';
      host.appendChild(p);

      // 角度在扇形内均匀铺开再加抖动，避免全随机时的结块
      const a  = base + (spread * (i / count - 0.5)) + (Math.random() - 0.5) * 0.4;
      const d  = power * (0.45 + Math.random() * 0.75);
      const dx = Math.cos(a) * d;
      // 末端加一点重力下坠，比纯直线自然
      const dy = Math.sin(a) * d + 26 + Math.random() * 30;
      const dur = 520 + Math.random() * 420;

      const anim = p.animate([
        { transform: 'translate(-50%,-50%) translate(0,0) scale(1)',   opacity: 1 },
        { transform: 'translate(-50%,-50%) translate(' + dx.toFixed(1) + 'px,' +
                      dy.toFixed(1) + 'px) scale(0.2)',                opacity: 0 }
      ], { duration: dur, easing: 'cubic-bezier(.15,.75,.35,1)', fill: 'forwards' });

      anim.onfinish = anim.oncancel = function () {
        if (p.parentNode) p.parentNode.removeChild(p);
      };
    }
  });

  /* ---------------------------------------------------------------- 冲击环 */

  const ring = guard(function (target, kind) {
    const c = centerOf(target);
    if (!c) return;
    const col = pick(PALETTE[kind] || PALETTE.neutral);
    const r = document.createElement('i');
    r.className = 'fx-ring';
    r.style.cssText = 'left:' + c.x + 'px;top:' + c.y + 'px;border-color:' + col + ';';
    getLayer().appendChild(r);

    const size = Math.max(c.rect.width, c.rect.height, 60);
    const anim = r.animate([
      { width: '10px', height: '10px', opacity: .85, borderWidth: '3px' },
      { width: (size * 2.2) + 'px', height: (size * 2.2) + 'px', opacity: 0, borderWidth: '1px' }
    ], { duration: 560, easing: 'cubic-bezier(.2,.8,.3,1)', fill: 'forwards' });
    anim.onfinish = anim.oncancel = function () {
      if (r.parentNode) r.parentNode.removeChild(r);
    };
  });

  /* ---------------------------------------------------------------- 浮字 */

  /** 在 target 上方飘一行字，用于 "+1" "连击" "降级" 这类瞬时反馈 */
  const popText = guard(function (target, text, kind) {
    const c = centerOf(target);
    if (!c) return;
    const n = document.createElement('span');
    n.className = 'fx-pop fx-pop--' + (kind || 'neutral');
    n.textContent = text;
    n.style.cssText = 'left:' + c.x + 'px;top:' + (c.rect.top - 6) + 'px;';
    getLayer().appendChild(n);

    const anim = n.animate([
      { transform: 'translate(-50%,0) scale(.7)',      opacity: 0 },
      { transform: 'translate(-50%,-14px) scale(1.1)', opacity: 1, offset: .25 },
      { transform: 'translate(-50%,-46px) scale(1)',   opacity: 0 }
    ], { duration: 1000, easing: 'cubic-bezier(.2,.9,.3,1)', fill: 'forwards' });
    anim.onfinish = anim.oncancel = function () {
      if (n.parentNode) n.parentNode.removeChild(n);
    };
  });

  /* ---------------------------------------------------------------- 连击 */

  /*
   * 连击数字放在屏幕正中偏上，压在卡片上层。
   * 只在 n >= 3 时调用（阈值由调用方决定，这里不做业务判断）——
   * 每答对一个就弹一次会非常吵。
   */
  const combo = guard(function (n) {
    const host = getLayer();
    const box = document.createElement('div');
    box.className = 'fx-combo';
    // 连击越高越烫：青 → 紫 → 粉 → 金
    const tier = n >= 20 ? 'gold' : n >= 12 ? 'pink' : n >= 6 ? 'violet' : 'cyan';
    box.classList.add('fx-combo--' + tier);
    box.innerHTML = '<b>' + n + '</b><small>COMBO</small>';
    host.appendChild(box);

    const anim = box.animate([
      { transform: 'translate(-50%,-50%) scale(.4) rotate(-8deg)', opacity: 0 },
      { transform: 'translate(-50%,-50%) scale(1.18) rotate(2deg)', opacity: 1, offset: .22 },
      { transform: 'translate(-50%,-50%) scale(1) rotate(0deg)',   opacity: 1, offset: .5 },
      { transform: 'translate(-50%,-90%) scale(.86) rotate(0deg)', opacity: 0 }
    ], { duration: 1150, easing: 'cubic-bezier(.2,.9,.3,1)', fill: 'forwards' });
    anim.onfinish = anim.oncancel = function () {
      if (box.parentNode) box.parentNode.removeChild(box);
    };
  });

  /* ---------------------------------------------------------------- 全屏闪光 */

  /* 屏幕四边内发光。答对/答错的即时反馈 —— 比改按钮颜色更快被余光捕捉到。 */
  const flash = guard(function (kind) {
    const host = getLayer();
    const f = document.createElement('div');
    f.className = 'fx-flash fx-flash--' + (kind || 'good');
    host.appendChild(f);
    const anim = f.animate(
      [{ opacity: 0 }, { opacity: 1, offset: .12 }, { opacity: 0 }],
      { duration: 620, easing: 'ease-out', fill: 'forwards' }
    );
    anim.onfinish = anim.oncancel = function () {
      if (f.parentNode) f.parentNode.removeChild(f);
    };
  });

  /* ---------------------------------------------------------------- 抖动 */

  const shake = guard(function (target) {
    if (!target || !target.animate) return;
    target.animate([
      { transform: 'translateX(0)' },
      { transform: 'translateX(-7px)' },
      { transform: 'translateX(6px)' },
      { transform: 'translateX(-4px)' },
      { transform: 'translateX(3px)' },
      { transform: 'translateX(0)' }
    ], { duration: 340, easing: 'ease-out' });
  });

  /* ---------------------------------------------------------------- 入场 */

  /*
   * 页面/卡片入场。用 WAAPI 而不是加 CSS 类：
   * app.js 的 render() 每次都重建 DOM，加类会因为元素还没上屏而丢掉过渡。
   */
  const enter = guard(function (target, opts) {
    if (!target || !target.animate) return;
    const o = opts || {};
    const dy = o.dy === undefined ? 14 : o.dy;
    target.animate([
      { opacity: 0, transform: 'translateY(' + dy + 'px) scale(' + (o.scale || .99) + ')' },
      { opacity: 1, transform: 'translateY(0) scale(1)' }
    ], {
      duration: o.duration || 300,
      delay: o.delay || 0,
      easing: 'cubic-bezier(.2,.8,.3,1)',
      fill: 'backwards'
    });
  });

  /** 列表/网格错峰入场。cap 限制参与动画的元素数，长列表只动前几个。 */
  const stagger = guard(function (nodes, opts) {
    const o = opts || {};
    const step = o.step || 45;
    const cap  = o.cap === undefined ? 10 : o.cap;
    Array.prototype.slice.call(nodes, 0, cap).forEach(function (n, i) {
      enter(n, { delay: i * step, dy: o.dy, duration: o.duration });
    });
  });

  /*
   * 卡片翻面：Y 轴 3D 翻转，转到一半时由调用方替换内容。
   *
   * 【这个函数刻意不走 guard】
   * guard 在 reduced-motion 或抛异常时会直接 return —— 但 swap 不是装饰，
   * 它是真正把卡片翻到背面的业务回调。吞掉它，界面就永久卡在正面了。
   * 所以这里自己兜底：无论走哪条分支，swap 都恰好执行一次。
   */
  function flip(target, swap) {
    let fired = false;
    function fire() {
      if (fired) return;
      fired = true;
      if (swap) swap();
    }

    if (OFF || !target || typeof target.animate !== 'function') { fire(); return; }

    try {
      const a = target.animate([
        { transform: 'perspective(1200px) rotateY(0deg)',   offset: 0 },
        { transform: 'perspective(1200px) rotateY(-88deg)', offset: .48 },
        { transform: 'perspective(1200px) rotateY(0deg)',   offset: 1 }
      ], { duration: 420, easing: 'cubic-bezier(.4,.05,.35,1)' });

      const t = setTimeout(fire, 200);
      a.oncancel = function () { clearTimeout(t); fire(); };
    } catch (e) {
      if (window.console) console.debug('[fx] flip', e);
      fire();
    }
  }

  /* ---------------------------------------------------------------- 背景 */

  /*
   * 背景漂浮粒子。
   *
   * 这是全程常驻的东西，所以性能预算卡得比别处紧：
   *   · 数量按屏幕面积算，手机上只有二三十个
   *   · 限 30fps（背景飘动没人看得出 60 和 30 的差别，但耗电差一倍）
   *   · 页面不可见立刻 cancelAnimationFrame —— 锁屏后不能还在跑
   *   · devicePixelRatio 上限 2，高清屏不做 3x 渲染
   */
  let bg = null;

  function initBg() {
    if (OFF || bg) return;
    const cv = document.getElementById('fx-bg');
    if (!cv || !cv.getContext) return;
    const ctx = cv.getContext('2d');
    if (!ctx) return;

    bg = { cv: cv, ctx: ctx, dots: [], raf: 0, last: 0, w: 0, h: 0, dpr: 1 };

    function resize() {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = window.innerWidth, h = window.innerHeight;
      bg.dpr = dpr; bg.w = w; bg.h = h;
      cv.width  = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      // 每 26000 px² 一个粒子，夹在 18~70 之间
      const want = Math.max(18, Math.min(70, Math.round(w * h / 26000)));
      const d = bg.dots;
      while (d.length > want) d.pop();
      while (d.length < want) d.push(spawn(w, h));
    }

    function spawn(w, h) {
      return {
        x: Math.random() * w,
        y: Math.random() * h,
        r: 0.6 + Math.random() * 1.8,
        vx: (Math.random() - 0.5) * 0.10,
        vy: -(0.06 + Math.random() * 0.22),      // 整体缓慢上浮
        a: 0.16 + Math.random() * 0.4,
        hue: Math.random() < 0.5 ? '34,211,238' : '167,139,250',
        ph: Math.random() * Math.PI * 2,          // 闪烁相位
        sp: 0.6 + Math.random() * 1.4             // 闪烁速度
      };
    }

    const FRAME = 1000 / 30;

    function tick(ts) {
      bg.raf = requestAnimationFrame(tick);
      if (ts - bg.last < FRAME) return;
      const dt = Math.min(3, (ts - bg.last) / FRAME);
      bg.last = ts;

      ctx.clearRect(0, 0, bg.w, bg.h);
      for (let i = 0; i < bg.dots.length; i++) {
        const p = bg.dots[i];
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.ph += 0.02 * p.sp * dt;

        // 飘出上边界就从下方重新进场，左右环绕
        if (p.y < -8) { p.y = bg.h + 8; p.x = Math.random() * bg.w; }
        if (p.x < -8) p.x = bg.w + 8;
        else if (p.x > bg.w + 8) p.x = -8;

        const a = p.a * (0.55 + 0.45 * Math.sin(p.ph));
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(' + p.hue + ',' + a.toFixed(3) + ')';
        ctx.fill();
      }
    }

    function start() {
      if (bg.raf) return;
      bg.last = 0;
      bg.raf = requestAnimationFrame(function (ts) { bg.last = ts; tick(ts); });
    }
    function stop() {
      if (!bg.raf) return;
      cancelAnimationFrame(bg.raf);
      bg.raf = 0;
    }

    let rt = null;
    window.addEventListener('resize', function () {
      clearTimeout(rt);
      rt = setTimeout(resize, 160);
    });
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') stop(); else start();
    });

    resize();
    start();
  }

  /* ---------------------------------------------------------------- 启动 */

  function init() {
    if (OFF) {
      // 关掉背景 canvas 的占位，免得它在 reduced-motion 下白占一层
      const cv = document.getElementById('fx-bg');
      if (cv) cv.style.display = 'none';
      return;
    }
    getLayer();
    initBg();
  }

  return {
    off: OFF,
    init: init,
    burst: burst, ring: ring, popText: popText, combo: combo,
    flash: flash, shake: shake,
    enter: enter, stagger: stagger, flip: flip
  };
})();
