/* =============================================================
   경희대MTA태권도 — Firebase 테스트 버전 서비스 워커
   -------------------------------------------------------------
   · 운영 버전(루트 service-worker.js)과 완전히 별개입니다.
     캐시 이름도 다르고(접두사 mta-tkd-fb-test-), 범위(scope)도 test-firebase/ 안입니다.
   · HTML 은 network-first → 새로 올린 테스트 화면이 바로 보입니다.
   · 동기화 엔진(firebase-sync.js)도 캐시에 넣어 오프라인에서도 화면이 열립니다.
   · 이 테스트 버전을 지워도 운영 버전(mta-taekwondo-attendance/)에는 아무 영향이 없습니다.
   ============================================================= */

var VERSION = 'v7-firebase-test';
/* 같은 VERSION 안에서 파일 내용만 고칠 때 올리는 빌드 표시 — 기기에 남은 옛 캐시를 새로 받게 한다 */
var BUILD = 'b1';
var CACHE_NAME = 'mta-tkd-fb-test-' + VERSION + '-' + BUILD;
var HTML_TIMEOUT_MS = 6000;

var APP_SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './firebase-sync.js',
  './firebase-sync-ui.js',
  './firebase-sync.css',
  './pwa-install.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-192.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
      return Promise.all(APP_SHELL.map(function (url) {
        return cache.add(new Request(url, { cache: 'reload' })).catch(function () { return null; });
      }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (key) {
        if (key !== CACHE_NAME && key.indexOf('mta-tkd-fb-test-') === 0) {
          return caches.delete(key);
        }
        return null;
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

function htmlKey(u) {
  try { var p = new URL(u); return p.origin + p.pathname; } catch (e) { return u; }
}

function networkFirst(request) {
  var url = request.url;
  var key = htmlKey(url);
  var network = fetch(url, { cache: 'no-store', credentials: 'same-origin', redirect: 'follow' }).then(function (res) {
    if (res && res.ok) {
      var copy = res.clone();
      caches.open(CACHE_NAME).then(function (cache) { cache.put(key, copy); }).catch(function () {});
    }
    return res;
  });
  var timeout = new Promise(function (resolve) { setTimeout(function () { resolve(null); }, HTML_TIMEOUT_MS); });
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
            '<p>한 번 접속했던 테스트 화면은 오프라인에서도 열립니다.<br>연결 후 다시 열어 주세요.</p></body>',
            { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
          );
        });
      });
    });
  });
}

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
      network.catch(function () {});
      return hit;
    }
    return network.then(function (res) { return res || new Response('', { status: 504, statusText: 'offline' }); });
  });
}

self.addEventListener('fetch', function (event) {
  var request = event.request;
  if (request.method !== 'GET') { return; }
  var url;
  try { url = new URL(request.url); } catch (e) { return; }
  if (url.origin !== self.location.origin) { return; }   /* Firebase·CDN 은 그대로 통과 */
  if (url.protocol !== 'http:' && url.protocol !== 'https:') { return; }
  var accept = request.headers.get('accept') || '';
  var isHtml = request.mode === 'navigate' || accept.indexOf('text/html') !== -1;
  event.respondWith(isHtml ? networkFirst(request) : cacheFirst(request));
});

self.addEventListener('message', function (event) {
  var data = event.data || {};
  if (data.type === 'SKIP_WAITING') { self.skipWaiting(); }
  if (data.type === 'GET_VERSION' && event.source) {
    event.source.postMessage({ type: 'VERSION', version: VERSION });
  }
});
