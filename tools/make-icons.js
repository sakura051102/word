/* ===========================================================================
 *  tools/make-icons.js —— 生成 PWA 图标
 * ---------------------------------------------------------------------------
 *  为什么要自己写 PNG 编码器：
 *    manifest.json 里的 icons 必须指向真实的位图文件 ——
 *    Chrome 对 SVG 图标的支持到今天仍然不一致，安装到桌面/主屏时
 *    经常退回默认灰块。而这个项目没有 npm 依赖（连 package.json 都没有），
 *    不想为了两张图片引入 sharp / canvas 那一整套原生依赖。
 *
 *    PNG 本身很简单：签名 + IHDR + IDAT(zlib) + IEND，
 *    Node 自带 zlib，唯一要手写的只有 CRC32。总共不到 60 行。
 *
 *  运行： node tools/make-icons.js
 *  产出： icons/icon-192.png  icons/icon-512.png  icons/icon.svg
 * =========================================================================== */

const fs   = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT = path.join(__dirname, '..', 'icons');

/* ---------------------------------------------------------------- PNG 编码 */

const CRC_TABLE = (function () {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function chunk(type, data) {
  const len  = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc  = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** rgba: Buffer，长度 = w*h*4 */
function encodePNG(w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8]  = 8;   // bit depth
  ihdr[9]  = 6;   // color type: RGBA
  ihdr[10] = 0;   // deflate
  ihdr[11] = 0;   // adaptive filtering
  ihdr[12] = 0;   // no interlace

  // 每条扫描线前面加一个 filter 字节，这里一律用 0（None）
  const raw = Buffer.alloc(h * (w * 4 + 1));
  for (let y = 0; y < h; y++) {
    const o = y * (w * 4 + 1);
    raw[o] = 0;
    rgba.copy(raw, o + 1, y * w * 4, (y + 1) * w * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/* ---------------------------------------------------------------- 绘制 */

function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
function mix(a, b, t) { return a + (b - a) * t; }

/* 在 [e0,e1] 之间做平滑过渡，用来给边缘做抗锯齿，省得画出锯齿边 */
function smooth(e0, e1, x) {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}

/* 圆角矩形的有符号距离：返回值 <=0 表示在形状内部 */
function roundRectSDF(px, py, halfW, halfH, r) {
  const qx = Math.abs(px) - (halfW - r);
  const qy = Math.abs(py) - (halfH - r);
  const ax = Math.max(qx, 0), ay = Math.max(qy, 0);
  return Math.sqrt(ax * ax + ay * ay) + Math.min(Math.max(qx, qy), 0) - r;
}

/**
 * 图标造型：深紫渐变圆角方块 + 中央一颗四角星（✦），
 * 星形颜色沿对角线从青色渐变到紫色，外围带一圈辉光。
 *
 * 四角星用「指数 0.5 的超椭圆」（星形线）画：
 *   (|x|/a)^0.5 + (|y|/b)^0.5 <= 1
 * 这个式子天然给出内凹的四角星，不用手工列顶点。
 *
 * maskable 安全区：主体内容全部收在内接圆 80% 以内，
 * 这样 Android 把图标裁成圆形/水滴形时不会切掉星星。
 */
function drawIcon(size) {
  const buf = Buffer.alloc(size * size * 4);
  const c = size / 2;
  const R = size * 0.225;            // 圆角半径，约 22%
  const starA = size * 0.265;        // 星形横向半径（收在 maskable 安全区内）
  const aa = size * 0.006;           // 抗锯齿过渡带宽度

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = x + 0.5 - c;
      const py = y + 0.5 - c;

      /* --- 底板：圆角方块 --- */
      const d = roundRectSDF(px, py, c, c, R);
      const inRect = 1 - smooth(-aa, aa, d);
      if (inRect <= 0.001) { /* 完全在外，留透明 */ continue; }

      // 竖向渐变 #14102a → #0a0812，左上角再叠一团紫色辉光
      const t = clamp01((y / size) * 0.9 + 0.05);
      let r = mix(0x1a, 0x0a, t);
      let g = mix(0x14, 0x08, t);
      let b = mix(0x36, 0x14, t);

      const gx = (px + size * 0.22) / (size * 0.55);
      const gy = (py + size * 0.26) / (size * 0.55);
      const gl = Math.exp(-(gx * gx + gy * gy) * 1.5) * 0.55;
      r += 0x5a * gl * 0.55; g += 0x24 * gl * 0.55; b += 0x9a * gl * 0.85;

      /* --- 四角星 --- */
      /*
       * 用超椭圆画：(|x|/a)^p + (|y|/a)^p <= 1
       *   p=2   → 圆
       *   p=1   → 菱形
       *   p=0.5 → 星形线，四条臂细得像针 —— 试过，加上辉光后
       *           整体读成「十字光斑」而不是星星
       *   p=0.62→ 臂饱满一些，缩到 48px 图标大小时仍能认出是 ✦
       */
      const P = 0.62;
      const nx = Math.pow(Math.abs(px) / starA, P);
      const ny = Math.pow(Math.abs(py) / starA, P);
      const sd = nx + ny;                            // <=1 在星内

      // 沿对角线取色：青(#22d3ee) → 紫(#a78bfa)
      const k = clamp01((px / starA + py / starA) * 0.5 + 0.5);
      const sr = mix(0x22, 0xa7, k);
      const sg = mix(0xd3, 0x8b, k);
      const sb = mix(0xee, 0xfa, k);

      // 星体本身
      const inStar = 1 - smooth(1 - aa / starA * 2, 1 + aa / starA * 2, sd);
      /* 星外辉光。
         衰减系数要够大：星形线本来就是细长的四角星，
         光晕稍微散一点就会糊成一个十字，把底板渐变整个冲淡。
         系数 9 大约让辉光在星尖外一小段就衰减干净。 */
      const glow = Math.exp(-Math.max(0, sd - 1) * 11) * 0.55;

      const sa = clamp01(inStar + glow * (1 - inStar));
      r = mix(r, sr, sa);
      g = mix(g, sg, sa);
      b = mix(b, sb, sa);

      // 星心提亮，看起来像在发光而不是贴了个色块
      const core = Math.exp(-sd * sd * 4.2) * 0.42;
      r = mix(r, 255, core); g = mix(g, 255, core); b = mix(b, 255, core);

      const o = (y * size + x) * 4;
      buf[o]     = Math.round(clamp01(r / 255) * 255);
      buf[o + 1] = Math.round(clamp01(g / 255) * 255);
      buf[o + 2] = Math.round(clamp01(b / 255) * 255);
      buf[o + 3] = Math.round(inRect * 255);
    }
  }
  return buf;
}

/* ---------------------------------------------------------------- SVG */

/* <link rel="icon"> 用矢量：浏览器标签页上比缩放的位图清楚 */
const SVG =
'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">\n' +
'  <defs>\n' +
'    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">\n' +
'      <stop offset="0" stop-color="#1a1436"/><stop offset="1" stop-color="#0a0814"/>\n' +
'    </linearGradient>\n' +
'    <linearGradient id="st" x1="0" y1="0" x2="1" y2="1">\n' +
'      <stop offset="0" stop-color="#22d3ee"/><stop offset="1" stop-color="#a78bfa"/>\n' +
'    </linearGradient>\n' +
'    <filter id="gl" x="-60%" y="-60%" width="220%" height="220%">\n' +
'      <feGaussianBlur stdDeviation="16" result="b"/>\n' +
'      <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>\n' +
'    </filter>\n' +
'  </defs>\n' +
'  <rect width="512" height="512" rx="115" fill="url(#bg)"/>\n' +
'  <circle cx="150" cy="130" r="150" fill="#7c3aed" opacity=".30"/>\n' +
'  <path d="M256 96 C272 200 312 240 416 256 C312 272 272 312 256 416 ' +
        'C240 312 200 272 96 256 C200 240 240 200 256 96 Z" ' +
        'fill="url(#st)" filter="url(#gl)"/>\n' +
'</svg>\n';

/* ---------------------------------------------------------------- 主流程 */

fs.mkdirSync(OUT, { recursive: true });

[192, 512].forEach(function (size) {
  const file = path.join(OUT, 'icon-' + size + '.png');
  const png  = encodePNG(size, size, drawIcon(size));
  fs.writeFileSync(file, png);
  console.log('写出', file, (png.length / 1024).toFixed(1) + ' KB');
});

fs.writeFileSync(path.join(OUT, 'icon.svg'), SVG, 'utf8');
console.log('写出', path.join(OUT, 'icon.svg'));
