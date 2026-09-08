/* ===========================================================================
 *  sw.js —— Service Worker：离线缓存
 * ---------------------------------------------------------------------------
 *  目标只有一个：装到手机主屏后，断网也能背单词。
 *
 *  缓存策略分两类，因为这个项目里资源的性质差得很远：
 *
 *  【代码类】(html / js/*.js / manifest / icons) —— network-first
 *      在线时永远先问网络、直接给最新版；只有断网才退回缓存。
 *      这样每次 push 完代码，设备下次打开就是新的，不用等、不用改版本号。
 *      代价是失去「秒开」——但本项目代码总共几百 KB，在线重验的开销很小。
 *
 *  【词库】(data/*.js，2.2MB) —— 纯缓存优先，不做后台重验
 *      它是这里唯一的大文件，而且只有重新跑 build-wordbook.js 才会变。
 *      每次打开都后台重下 2.2MB 是在烧用户的流量。
 *      词库真的换了，就把下面的 VERSION 加一，让整个缓存重建。
 *
 *  ⚠ 换了 data/wordbook.js 之后，记得把 VERSION 改掉，否则用户拿到的
 *    还是旧词库。改代码则不需要，network-first 会自动拉到最新。
 * =========================================================================== */

const VERSION = 'v4';
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
  'data/corpus.js',
  'js/store.js',
  'js/engine.js',
  'js/wordbook.js',
  'js/fx.js',
  'js/ui.js',
  'js/charts.js',
  'js/notebook.js',
  'js/triage.js',
  'js/review.js',
  'js/rapid.js',
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

    // 新 SW 激活并接管后，通知所有已打开的页面：代码已更新，可刷新到最新版。
    // 不发这条的话，已经开着的标签要等下次手动重开才会用上新缓存 ——
    // 正是「push 完第一次打开还是旧的，过一会儿才新」的来源之一。
    const wins = await self.clients.matchAll({ type: 'window' });
    wins.forEach(function (c) {
      try { c.postMessage({ type: 'SW_UPDATED', version: VERSION }); } catch (e) {}
    });
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

    /*
     * 代码类：network-first。
     * cache: 'no-cache' 让这次 fetch 跳过浏览器自己的 HTTP 缓存，强制去
     * 服务器做一次条件重验（改了返回 200 新文件，没改返回 304 省流量）。
     * 不用 no-cache 的话，GitHub Pages 给 html 发的 max-age=600 会让浏览器
     * 在 10 分钟内继续拿旧页面——正是「提交后平板迟迟不更新」的元凶之一。
     */
    try {
      const fresh = await fetch(req, { cache: 'no-cache' });
      // 只缓存正常的同源响应；opaque / 4xx / 5xx 不要进缓存，
      // 否则会把一个 404 页面固化下来，之后怎么刷新都是错的
      if (fresh && fresh.ok && fresh.type === 'basic') {
        cache.put(req, fresh.clone()).catch(function () {});
      }
      return fresh;
    } catch (err) {
      /* 断网：退回缓存 */
      if (cached) return cached;

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
    }
  })());
});
