/* ===========================================================================
 *  sw.js —— Service Worker：离线缓存
 * ---------------------------------------------------------------------------
 *  目标只有一个：装到手机主屏后，断网也能背单词。
 *
 *  缓存策略分两类，因为这个项目里资源的性质差得很远：
 *
 *  【代码类】(html / js/*.js / manifest / icons) —— stale-while-revalidate
 *      先给缓存里的旧版本（秒开），同时后台悄悄拉新版存回去，
 *      下次打开就是新的。改了代码不用记得改版本号，这一点很重要 ——
 *      靠人手动 bump 版本的方案，迟早会忘。
 *
 *  【词库】(data/*.js，2.2MB) —— 纯缓存优先，不做后台重验
 *      它是这里唯一的大文件，而且只有重新跑 build-wordbook.js 才会变。
 *      每次打开都后台重下 2.2MB 是在烧用户的流量。
 *      词库真的换了，就把下面的 VERSION 加一，让整个缓存重建。
 *
 *  ⚠ 换了 data/wordbook.js 之后，记得把 VERSION 改掉，否则用户拿到的
 *    还是旧词库。改代码则不需要，SWR 会自动更新。
 * =========================================================================== */

const VERSION = 'v1';
const CACHE   = 'kaoyan-vocab-' + VERSION;

/* 首次安装时预缓存的清单。
   注意 './' 和 'index.html' 都列：前者是 Pages 的目录默认页，
   后者是它实际对应的文件，两个 URL 在缓存里是两条独立的键。 */
const ASSETS = [
  './',
  'index.html',
  '背单词.html',
  'manifest.json',
  'data/sample.js',
  'data/wordbook.js',
  'js/store.js',
  'js/engine.js',
  'js/wordbook.js',
  'js/fx.js',
  'js/ui.js',
  'js/charts.js',
  'js/triage.js',
  'js/review.js',
  'js/app.js',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png'
];

/* 词库不走后台重验 —— 见文件头说明 */
function isBulkData(url) {
  return /\/data\/[^/]+\.js$/.test(url.pathname);
}

/* ---------------------------------------------------------------- 安装 */

self.addEventListener('install', function (e) {
  e.waitUntil((async function () {
    const cache = await caches.open(CACHE);

    /*
     * 【不用 cache.addAll】
     * addAll 是全有全无的：清单里任何一个 404，整个 install 就失败，
     * 结果是「一个文件缺失 → 整个离线功能不可用」。
     * 这里逐个 add，失败的记一笔继续走 —— 比如 data/wordbook.js
     * 还没生成时，程序本来就会回退到 data/sample.js，不该因此装不上。
     */
    const failed = [];
    await Promise.all(ASSETS.map(function (u) {
      return cache.add(new Request(u, { cache: 'reload' })).catch(function () {
        failed.push(u);
      });
    }));
    if (failed.length) console.warn('[sw] 这些资源没缓存上，离线时不可用：', failed);

    await self.skipWaiting();
  })());
});

/* ---------------------------------------------------------------- 激活 */

self.addEventListener('activate', function (e) {
  e.waitUntil((async function () {
    const names = await caches.keys();
    await Promise.all(names.map(function (n) {
      // 只删自己的旧版本，别人的缓存不碰
      if (n !== CACHE && n.indexOf('kaoyan-vocab-') === 0) return caches.delete(n);
      return null;
    }));
    await self.clients.claim();
  })());
});

/* ---------------------------------------------------------------- 请求 */

self.addEventListener('fetch', function (e) {
  const req = e.request;

  // 只管自己域下的 GET。跨域请求（比如将来接了 CDN）一律放行
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  e.respondWith((async function () {
    const cache  = await caches.open(CACHE);
    const cached = await cache.match(req, { ignoreSearch: true });

    /* 词库：命中就直接给，不做后台重验 */
    if (cached && isBulkData(url)) return cached;

    /* 其余资源：stale-while-revalidate */
    const network = fetch(req).then(function (res) {
      // 只缓存正常的同源响应；opaque / 4xx / 5xx 不要进缓存，
      // 否则会把一个 404 页面固化下来，之后怎么刷新都是错的
      if (res && res.ok && res.type === 'basic') {
        cache.put(req, res.clone()).catch(function () {});
      }
      return res;
    }).catch(function () { return null; });

    if (cached) {
      e.waitUntil(network);      // 后台更新，不阻塞这次响应
      return cached;
    }

    const res = await network;
    if (res) return res;

    /*
     * 彻底断网且没缓存。如果是页面跳转，退回缓存里的主页面，
     * 至少让用户看到应用而不是浏览器的恐龙页。
     */
    if (req.mode === 'navigate') {
      const fallback = await cache.match('背单词.html') || await cache.match('index.html');
      if (fallback) return fallback;
    }
    return new Response('离线，且该资源未缓存。', {
      status: 504,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    });
  })());
});
