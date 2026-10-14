/* 患者用药随访 · 离线版 Service Worker
 *
 * 目标：装到 iPhone 主屏幕后，即使 Mac 关机、手机没网，也能打开应用继续录入。
 * 策略：
 *  - 应用外壳（/m 及其入口页）安装时预缓存；
 *  - 页面导航：网络优先（拿到最新版本就更新缓存），失败时回退缓存 → 再不行回退应用外壳；
 *  - 同源静态资源与 RSC 数据：网络优先 + 缓存回退（保证离线可导航）；
 *  - 绝不缓存 /api/ 与非 GET 请求（避免缓存到患者数据响应）。
 */

const VERSION = 'v8';
const SHELL_CACHE = `pfu-shell-${VERSION}`;
const RUNTIME_CACHE = `pfu-runtime-${VERSION}`;

const SHELL_URLS = [
  '/m/',
  '/m/voice/',
  '/m/patients/',
  '/m/batch/',
  '/m/patient/',
  '/m/settings/',
  '/m/import/',
  '/m/follow-up/',
  '/m/next-week/',
  '/m/long-term/',
  '/manifest.webmanifest',
  '/icons/icon-180.png',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

/**
 * 路径变体：静态导出用 trailingSlash（/m/patient/），但 Next 的硬导航回退可能请求
 * 不带尾斜杠的 /m/patient —— 两种写法都要能命中缓存，否则会回退到首页。
 */
function withVariants(u) {
  try {
    const url = new URL(String(u), self.location.origin);
    const alt = new URL(url.toString());
    alt.pathname = url.pathname.endsWith('/') ? url.pathname.slice(0, -1) || '/' : url.pathname + '/';
    const out = [url.toString()];
    if (alt.toString() !== url.toString()) out.push(alt.toString());
    return out;
  } catch {
    return [String(u)];
  }
}

async function shellMatchAny(shell, key) {
  for (const k of withVariants(key)) {
    const hit = await shell.match(k);
    if (hit) return hit;
  }
  return null;
}

/**
 * 预缓存：每个页面除了 HTML 本身，还要把它引用的构建产物（/_next/static/... 里的 JS/CSS）
 * 一起缓存。否则离线导航到该页面时 HTML 能拿到、但 JS 加载失败 → "client-side exception"。
 * 同时按"带/不带尾斜杠"两种键各存一份，避免路径写法差异导致命中失败。
 */
async function precacheShell() {
  const cache = await caches.open(SHELL_CACHE);
  const extra = new Set();

  for (const url of SHELL_URLS) {
    try {
      const res = await fetch(new Request(url, { cache: 'reload' }));
      if (!res.ok) continue;
      const forParse = res.clone();
      for (const key of withVariants(url)) {
        await cache.put(key, res.clone());
      }
      const ct = res.headers.get('content-type') || '';
      if (ct.includes('text/html')) {
        const html = await forParse.text();
        for (const m of html.matchAll(/(?:src|href)="(\/_next\/static\/[^"]+)"/g)) extra.add(m[1]);
      }
    } catch {
      /* 单个失败不影响整体安装，运行时还会再尝试 */
    }
  }

  await Promise.all(
    [...extra].map(async (a) => {
      try {
        const r = await fetch(new Request(a, { cache: 'reload' }));
        if (r.ok) await cache.put(a, r.clone());
      } catch {
        /* 忽略 */
      }
    }),
  );
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      await precacheShell();
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => !k.endsWith(VERSION)).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

function isCacheable(url) {
  if (url.origin !== self.location.origin) return false;
  if (url.pathname.startsWith('/api/')) return false; // 不缓存接口响应
  return true;
}

async function networkFirst(request, fallbackUrl) {
  const cache = await caches.open(RUNTIME_CACHE);
  try {
    const res = await fetch(request);
    if (res && res.ok) cache.put(request, res.clone());
    return res;
  } catch {
    const cached = await cache.match(request);
    if (cached) return cached;
    // 静态资源（构建产物）也可能在预缓存里（带不带 query 都试一次）
    const shell = await caches.open(SHELL_CACHE);
    const stripped = new URL(request.url);
    stripped.search = '';

    /*
     * 关键：只有"页面导航"才允许回退到 HTML。
     * Next.js 的客户端路由会先请求 RSC 数据（?_rsc=...）——如果这时我们回一个 HTML，
     * 路由会被带偏（实测：点患者会跳回首页）。所以非导航请求离线时直接失败，
     * 让 Next 走"硬导航"回退，再由下面的导航分支返回正确的缓存页面。
     */
    if (!fallbackUrl) {
      const fromShell = await shellMatchAny(shell, request.url);
      if (fromShell && !(fromShell.headers.get('content-type') || '').includes('text/html')) {
        return fromShell; // 静态资源允许从预缓存返回
      }
      return new Response('offline', { status: 503, statusText: 'Offline', headers: { 'content-type': 'text/plain' } });
    }

    const byUrl = await shellMatchAny(shell, fallbackUrl);
    if (byUrl) return byUrl;
    const byReq = await shellMatchAny(shell, stripped.toString());
    if (byReq) return byReq;
    const home = (await shell.match('/m/')) || (await shell.match('/m'));
    if (home) return home;
    return new Response('离线且没有缓存，请先联网打开一次应用。', { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  let url;
  try {
    url = new URL(req.url);
  } catch {
    return;
  }
  if (!isCacheable(url)) return;

  if (req.mode === 'navigate') {
    event.respondWith(networkFirst(req, url.pathname));
    return;
  }
  event.respondWith(networkFirst(req));
});
