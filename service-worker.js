/* =============================================================
   경희대MTA태권도 — 서비스 워커 (홈 화면 앱/PWA)
   -------------------------------------------------------------
   전략 요약
   · HTML(화면 문서)  : network-first  → 새로 배포한 화면이 바로 보이게
     (인터넷이 없거나 느릴 때만 캐시로 대신함)
   · 아이콘·manifest 등 정적 파일 : cache-first + 뒤에서 조용히 갱신
   · 다른 사이트(CDN: xlsx, face-api 등)는 손대지 않고 브라우저에 맡김
   이 앱에서 가장 위험한 사고는 "옛 index.html이 캐시에 남아 업데이트가
   안 보이는 것"이라, 화면 문서만은 항상 네트워크를 먼저 확인합니다.
   배포할 때마다 아래 VERSION 값을 올리면 옛 캐시가 정리됩니다.
   ============================================================= */

var VERSION = 'v17-2026-11-23';
var CACHE_NAME = 'mta-taekwondo-' + VERSION;
var HTML_TIMEOUT_MS = 6000;

/* 앱 셸(오프라인에서도 열리도록 미리 받아두는 파일) — 모두 상대 경로 */
var APP_SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-192.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png'
];

/* ---------- 설치: 앱 셸 미리 받기 ---------- */
self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
      // 하나가 실패해도 설치 자체는 끝나도록 개별 처리
      return Promise.all(APP_SHELL.map(function (url) {
        return cache.add(new Request(url, { cache: 'reload' })).catch(function () { return null; });
      }));
    }).then(function () {
      // 새 서비스 워커를 곧바로 대기 해제 → 다음 접속을 기다리지 않음
      return self.skipWaiting();
    })
  );
});

/* ---------- 활성화: 옛 버전 캐시 정리 ---------- */
self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (key) {
        if (key !== CACHE_NAME && key.indexOf('mta-taekwondo-') === 0) {
          return caches.delete(key);
        }
        return null;
      }));
    }).then(function () {
      return self.clients.claim();
    })
  );
});

/* 화면 주소에서 물음표 뒤(?v=1 등)를 뗀 열쇠 — 같은 화면을 여러 벌 캐시하지 않도록 */
function htmlKey(u) {
  try {
    var p = new URL(u);
    return p.origin + p.pathname;
  } catch (e) {
    return u;
  }
}

/* ---------- 화면 문서: network-first ---------- */
function networkFirst(request) {
  /* 화면 이동 요청은 new Request(요청, 옵션)로 다시 만들 수 없어서 URL로 새로 부릅니다.
     cache:'no-store' → GitHub Pages의 짧은 HTTP 캐시(약 10분)에 가로막히지 않고 늘 새 화면을 확인 */
  var url = request.url;
  var key = htmlKey(url);
  var network = fetch(url, { cache: 'no-store', credentials: 'same-origin', redirect: 'follow' }).then(function (res) {
    if (res && res.ok) {
      var copy = res.clone();
      caches.open(CACHE_NAME).then(function (cache) { cache.put(key, copy); }).catch(function () {});
    }
    return res;
  });

  var timeout = new Promise(function (resolve) {
    setTimeout(function () { resolve(null); }, HTML_TIMEOUT_MS);
  });

  return Promise.race([network.catch(function () { return null; }), timeout]).then(function (res) {
    if (res && res.ok) { return res; }
    return caches.match(url).then(function (hit) {
      if (hit) { return hit; }
      return caches.match(key);
    }).then(function (hit) {
      if (hit) { return hit; }
      return caches.match('./index.html').then(function (shell) {
        if (shell) { return shell; }
        return network.then(function (late) {
          if (late) { return late; }
          return new Response(
            '<!doctype html><meta charset="utf-8"><title>오프라인</title>' +
            '<body style="font-family:sans-serif;padding:28px;text-align:center;color:#0d1b3e">' +
            '<h2>인터넷 연결을 확인해 주세요</h2>' +
            '<p>한 번 접속했던 화면은 오프라인에서도 열립니다.<br>연결 후 다시 열어 주세요.</p></body>',
            { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
          );
        });
      });
    });
  });
}

/* ---------- 정적 파일: cache-first (+ 백그라운드 갱신) ---------- */
function cacheFirst(request) {
  return caches.match(request).then(function (hit) {
    var network = fetch(request).then(function (res) {
      if (res && res.ok && res.type === 'basic') {
        var copy = res.clone();
        caches.open(CACHE_NAME).then(function (cache) { cache.put(request, copy); }).catch(function () {});
      }
      return res;
    }).catch(function () { return null; });

    if (hit) {
      network.catch(function () {});   // 뒤에서 조용히 최신본으로 바꿔둠
      return hit;
    }
    return network.then(function (res) {
      if (res) { return res; }
      return new Response('', { status: 504, statusText: 'offline' });
    });
  });
}

/* ---------- 요청 가로채기 ---------- */
self.addEventListener('fetch', function (event) {
  var request = event.request;
  if (request.method !== 'GET') { return; }

  var url;
  try { url = new URL(request.url); } catch (e) { return; }
  if (url.origin !== self.location.origin) { return; }   // CDN·외부 API는 그대로 통과
  if (url.protocol !== 'http:' && url.protocol !== 'https:') { return; }

  var accept = request.headers.get('accept') || '';
  var isHtml = request.mode === 'navigate' || accept.indexOf('text/html') !== -1;

  event.respondWith(isHtml ? networkFirst(request) : cacheFirst(request));
});

/* ---------- 페이지에서 즉시 반영을 요청할 때 ---------- */
self.addEventListener('message', function (event) {
  var data = event.data || {};
  if (data.type === 'SKIP_WAITING') { self.skipWaiting(); }
  if (data.type === 'GET_VERSION' && event.source) {
    event.source.postMessage({ type: 'VERSION', version: VERSION });
  }
});
