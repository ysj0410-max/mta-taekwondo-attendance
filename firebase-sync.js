/* =============================================================================
   경희대MTA태권도 — 🔥 Firebase Firestore 실시간 동기화 엔진 (v30 정식)
   =============================================================================
   · 이 파일은 정식 앱(index.html)이 불러 씁니다.
     운영 버전(index.html v28)은 이 파일을 읽지 않으며, 이 파일이 운영 데이터에
     영향을 주는 경로는 전혀 없습니다.
   · 저장 구조
       dojangs/{dojangId}/students/{studentId}          원생 1명 = 문서 1개 (개인정보 포함 · 관리자 전용)
       dojangs/{dojangId}/kioskStudents/{studentId}     출석 화면용 최소 정보 사본 (개인정보 없음 · 태블릿 읽기)
       dojangs/{dojangId}/attendanceEvents/{eventId}     출결 1건 = 문서 1개
                                                         eventId = {날짜}_{원생ID}_{in|out}
                                                         칸: date·studentId·kind·time·eventId·source·manual·deviceId
                                                             (+ _ver·_updatedAt·_updatedBy·_fieldMeta)
                                                         ※ firestore.rules 의 eventFields() 와 정확히 같은 목록이어야 한다
       dojangs/{dojangId}/tuition/{YYYY-MM}_{studentId}  원생·월 원비 1건 = 문서 1개
       dojangs/{dojangId}/counsel|shuttle|coupons/{id}   기록 1건 = 문서 1개
       dojangs/{dojangId}/meta/{설정문서}                설정·단가표·문구·로그·계정
       dojangs/{dojangId}/meta/usage                     기기별 무료 한도 추정 사용량 합산(관리자 전용 · 60초 간격)
       dojangs/{dojangId}/roles/{uid}                    권한(관리자/출석 태블릿)
     · 기기 로컬 전용(절대 업로드하지 않음) — tdk.fbLastSync.v1(컬렉션별 마지막 동기화 시각) 포함
       tdk.faces.v1(원생 얼굴 128차원), tdk.adminFace.v1(관리자 얼굴),
       그리고 이 엔진의 상태 키(tdk.fb*.v1)
   · 문서마다 `_ver`(문서 버전) · `_updatedAt` · `_updatedBy`(기기 ID) ·
     `_fieldMeta`(필드별 버전/수정시각/수정기기)를 붙여,
     PC와 태블릿이 같은 관원의 서로 다른 칸을 동시에 고쳐도 두 변경이 모두 살아남습니다.
   · 무료(Spark) 한도: 읽기 5만/일, 쓰기 2만/일, 삭제 2만/일 — 80% 경고, 100%에서
     자동 유료 전환 없이 동기화만 멈추고 로컬 큐에 보관합니다.
   ============================================================================= */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(root); }
  else { root.TDKFirebaseSync = factory(root); }
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this), function (root) {
  'use strict';

  var VERSION = '1.4.0';

  /* ---------- 무료(Spark) 한도 ---------- */
  var SPARK = {
    reads: 50000,     /* 문서 읽기 / 일 */
    writes: 20000,    /* 문서 쓰기 / 일 */
    deletes: 20000,   /* 문서 삭제 / 일 */
    warnRatio: 0.8,   /* 80% 경고 */
    maxBatch: 500     /* Firestore 배치 1회 최대 쓰기 수 */
  };

  var REFRESH_MS = 150;        /* 원격 변경을 모아서 한 번에 화면에 반영 */
  var DUPLICATE_WINDOW_MS = 6000;  /* 같은 출결 이벤트 중복 차단 창(보조 안전장치) */
  var QUOTA_MESSAGE = '무료 한도를 모두 사용해 동기화를 잠시 멈췄습니다. 지금 찍은 기록은 이 기기에 임시 보관 중이며, 한도가 풀리면(태평양 시간 자정) 자동으로 다시 보냅니다. 그동안 Google Drive 백업을 받아 두시길 권합니다.';

  /* =========================================================================
     1. 작은 도구들
     ========================================================================= */
  function hasOwn(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }
  function isPlain(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v) &&
      (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
  }
  function clone(v) { try { return JSON.parse(JSON.stringify(v)); } catch (e) { return null; } }

  /* 키 순서에 흔들리지 않는 문자열 — 내용 비교·해시에 쓴다 */
  function stableStringify(v) {
    if (v === null || v === undefined) { return 'null'; }
    var t = typeof v;
    if (t === 'number') { return isFinite(v) ? String(v) : 'null'; }
    if (t === 'string') { return JSON.stringify(v); }
    if (t === 'boolean') { return v ? 'true' : 'false'; }
    if (t !== 'object') { return JSON.stringify(String(v)); }
    if (Array.isArray(v)) {
      var parts = [];
      for (var i = 0; i < v.length; i++) { parts.push(stableStringify(v[i])); }
      return '[' + parts.join(',') + ']';
    }
    var keys = Object.keys(v).sort();
    var out = [];
    for (var j = 0; j < keys.length; j++) {
      if (v[keys[j]] === undefined) { continue; }
      out.push(JSON.stringify(keys[j]) + ':' + stableStringify(v[keys[j]]));
    }
    return '{' + out.join(',') + '}';
  }
  function hashStr(s) {
    var h = 0x811c9dc5;
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return ('0000000' + h.toString(36)).slice(-8);
  }
  function contentHash(obj) { return hashStr(stableStringify(obj || {})); }

  /* 출결 문서의 "내용이 같은가" 판단용 해시 — 기기마다 달라지는 칸(deviceId)과
     수신할 때마다 바뀌는 칸(at)을 뺀다. 이걸 넣으면 다른 기기가 만든 출결을 받은 뒤
     모든 출결을 다시 update 로 보내려 하게 되고(=태블릿은 규칙상 update 불가),
     쓸데없는 쓰기로 무료 한도를 쓰게 된다. */
  function eventHash(body) {
    var b = body || {};
    return contentHash({
      date: b.date, studentId: b.studentId, kind: b.kind, time: b.time,
      manual: !!b.manual, source: String(b.source || b.src || '')
    });
  }
  function bodyHash(kind, body) {
    return kind === 'events' ? eventHash(body) : contentHash(body);
  }

  function p2(n) { return (n < 10 ? '0' : '') + n; }
  function isoOf(ms) {
    var d = new Date(ms == null ? Date.now() : ms);
    return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + 'T' +
      p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds()) + '.' +
      ('00' + d.getMilliseconds()).slice(-3) + 'Z';
  }
  function dayOf(ms) { return isoOf(ms).slice(0, 10); }
  /* Spark 무료 한도는 "미국 태평양 시간 자정"에 초기화된다 — 서머타임이 없을 때 한국 17:00,
     서머타임 기간(3~11월)에는 한국 16:00 이다.
     그 기준 날짜를 'pt:YYYY-MM-DD' 로 돌려준다.
       · 날짜 계산은 태평양 시간대(America/Los_Angeles, 서머타임 자동 반영)
       · 앞에 'pt:' 를 붙이는 이유 — 예전 버전이 UTC 날짜('2026-11-24')로 저장해 둔
         계량기(tdk.fbUsage.v1)와 값이 겹치지 않아, 새 버전을 여는 즉시 잠긴 계량기가 0 으로 다시 센다. */
  var sparkFmt = null;    /* 태평양 날짜 형식기 — 한 번만 만들어 재사용 */
  function sparkDayOf(ms) {
    var at = (ms == null ? Date.now() : ms);
    var ymd = null;
    try {
      if (typeof Intl !== 'undefined' && Intl.DateTimeFormat) {
        /* 형식기(Formatter)는 만들 때가 비싸다 — 문서 수천 건을 한꺼번에 받을 때
           여기서 시간을 잡아먹지 않도록 한 번만 만들어 둔다 */
        if (!sparkFmt) {
          sparkFmt = new Intl.DateTimeFormat('en-CA', {
            timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit'
          });
        }
        var parts = sparkFmt.formatToParts(new Date(at));
        var got = {};
        for (var i = 0; i < parts.length; i++) { got[parts[i].type] = parts[i].value; }
        if (got.year && got.month && got.day) { ymd = got.year + '-' + got.month + '-' + got.day; }
      }
    } catch (e) { ymd = null; sparkFmt = null; }
    if (!ymd) {
      /* 시간대를 못 쓰는 환경 — 서머타임을 무시하고 UTC-8 로 계산한다 */
      var d = new Date(at - 8 * 3600 * 1000);
      ymd = d.getUTCFullYear() + '-' + p2(d.getUTCMonth() + 1) + '-' + p2(d.getUTCDate());
    }
    return 'pt:' + ymd;
  }

  /* =========================================================================
     기기별 사용량 합산 문서 (dojangs/{도장}/meta/usage)
     ----------------------------------------------------------------------------
     관리자 PC·폰·태블릿이 각자 센 무료 한도 추정치를 한 문서에 모아 서로 더해 본다.
       { date: 'pt:YYYY-MM-DD',
         devices: { [deviceId]: { date, label, reads, writes, deletes, blocked, updatedAt } } }
     · 문서 하나뿐이라 규칙(firestore.rules)을 고치지 않아도 관리자 계정으로 바로 쓴다
       (meta 는 이미 isAdmin 읽기·쓰기 허용 — 태블릿에는 permission-denied 이며 조용히 건너뛴다)
     · 날짜가 바뀌면(태평양 자정 = 한국 오후 4~5시) 지난 날짜 기기 항목은 합산에서 뺀다
     · 이 문서의 쓰기·수신은 계량기(tdk.fbUsage.v1)에 넣지 않는다 —
       계량기에 넣으면 "합산 문서를 쓰느라 사용량이 올라 다시 쓰는" 되먹임 고리가 생긴다.
     ========================================================================= */
  var USAGE_SYNC = {
    doc: 'usage',
    minReads: 20,          /* 이만큼 쌓였을 때만 서버에 올린다 (쓰기 한도 보호) */
    minWrites: 5,
    minDeletes: 5,
    intervalMs: 60000,     /* 두 번 올리는 사이 최소 간격 */
    tickMs: 30000,         /* 간격이 차면 스스로 한 번 확인하는 주기 */
    debounceMs: 3000       /* 사용량이 늘어난 직후 몰아서 한 번 */
  };

  /* 문서에 담긴 기기 항목 중 "오늘" 것만 골라낸다 (지난 날짜·모양이 깨진 항목은 버린다) */
  function usageDeviceEntries(doc, today) {
    var out = [];
    if (!isPlain(doc) || !isPlain(doc.devices)) { return out; }
    var docDate = String(doc.date == null ? '' : doc.date);
    var day = String(today == null ? '' : today);
    Object.keys(doc.devices).forEach(function (id) {
      var e = doc.devices[id];
      if (!isPlain(e)) { return; }
      var eDate = String(e.date == null ? docDate : e.date);
      if (!day || eDate !== day) { return; }
      out.push({
        deviceId: String(id),
        label: String(e.label == null ? id : e.label),
        date: eDate,
        reads: Math.max(0, num(e.reads)),
        writes: Math.max(0, num(e.writes)),
        deletes: Math.max(0, num(e.deletes)),
        blocked: !!e.blocked,
        updatedAt: String(e.updatedAt == null ? '' : e.updatedAt)
      });
    });
    return out;
  }

  /* meta/usage 문서 → 기기별 항목 · 합계 (같은 날짜만)
       mine      내 deviceId 항목(서버에 올라간 사본, 없으면 null)
       others    내 기기를 뺀 나머지 기기 합계
       totals    문서에 있는 전체 합계 */
  function usageTotals(doc, today, myDeviceId) {
    var day = String(today == null ? sparkDayOf(Date.now()) : today);
    var me = String(myDeviceId == null ? '' : myDeviceId);
    var rows = usageDeviceEntries(doc, day);
    var totals = { reads: 0, writes: 0, deletes: 0 };
    var others = { reads: 0, writes: 0, deletes: 0 };
    var mine = null;
    var othersCount = 0;
    rows.forEach(function (r) {
      totals.reads += r.reads; totals.writes += r.writes; totals.deletes += r.deletes;
      if (r.deviceId === me) { mine = r; return; }
      others.reads += r.reads; others.writes += r.writes; others.deletes += r.deletes;
      othersCount++;
    });
    return {
      date: day,
      devices: rows,
      count: rows.length,
      othersCount: othersCount,
      totals: totals,
      others: others,
      mine: mine
    };
  }

  /* 이번에 서버로 올릴지 판단 — 60초 간격 · 최소 변화량 · 차단 상태 변화
       local     { date, reads, writes, deletes, blocked }
       lastSent  마지막으로 올린 값(없으면 null)
       atMs      지금 시각, lastAtMs 마지막으로 올린 시각 */
  function usagePushDecision(local, lastSent, atMs, lastAtMs) {
    var l = isPlain(local) ? local : {};
    var at = num(atMs == null ? Date.now() : atMs);
    var lastAt = num(lastAtMs);
    var throttled = lastAt > 0 && (at - lastAt) < USAGE_SYNC.intervalMs;
    if (!isPlain(lastSent)) { return { push: !throttled, reason: throttled ? 'throttle' : 'first' }; }
    var changed = '';
    if (String(l.date || '') !== String(lastSent.date || '')) { changed = 'new-day'; }
    else if (!!l.blocked !== !!lastSent.blocked) { changed = 'blocked'; }
    else {
      var dr = num(l.reads) - num(lastSent.reads);
      var dw = num(l.writes) - num(lastSent.writes);
      var dd = num(l.deletes) - num(lastSent.deletes);
      /* 계량기를 0 으로 되돌린 경우는 "줄어든 변화"도 그대로 알린다 */
      if (dr < 0 || dw < 0 || dd < 0) { changed = 'reset'; }
      else if (dr >= USAGE_SYNC.minReads || dw >= USAGE_SYNC.minWrites || dd >= USAGE_SYNC.minDeletes) { changed = 'delta'; }
    }
    if (!changed) { return { push: false, reason: 'small' }; }
    if (throttled) { return { push: false, reason: 'throttle', pending: changed }; }
    return { push: true, reason: changed };
  }

  /* Firestore 문서 ID로 쓸 수 없는 문자 정리 ( '/' '.' '#' '$' '[' ']' 등 ) */
  function safeId(v) {
    var s = String(v == null ? '' : v)
      .replace(/[\/\\#\$\[\]\*\?\.\s]+/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_+|_+$/g, '');
    if (!s) { s = '_'; }
    return s.slice(0, 300);
  }

  /* 중첩 객체를 "a.b.c" 점 표기 필드로 펼친다 (배열은 통째로 한 필드) */
  function flatten(obj, depth) {
    var out = {};
    (function walk(cur, prefix, d) {
      if (!isPlain(cur)) { if (prefix) { out[prefix] = cur; } return; }
      var keys = Object.keys(cur);
      for (var i = 0; i < keys.length; i++) {
        var k = keys[i];
        var v = cur[k];
        if (k.charAt(0) === '_') { continue; }          /* 메타 필드는 제외 */
        var path = prefix ? (prefix + '.' + k) : k;
        if (isPlain(v) && d < 5 && Object.keys(v).length) { walk(v, path, d + 1); }
        else { out[path] = v; }
      }
    })(obj || {}, '', 0);
    return out;
  }
  function unflatten(flat) {
    var out = {};
    Object.keys(flat || {}).forEach(function (path) {
      var segs = path.split('.');
      var cur = out;
      for (var i = 0; i < segs.length - 1; i++) {
        if (!isPlain(cur[segs[i]])) { cur[segs[i]] = {}; }
        cur = cur[segs[i]];
      }
      cur[segs[segs.length - 1]] = flat[path];
    });
    return out;
  }

  function normalizeError(err) {
    if (!err) { return { message: '알 수 없는 오류' }; }
    return {
      code: String(err.code || ''),
      message: String(err.message || err.detail || err || ''),
      name: String(err.name || '')
    };
  }
  function errorText(err) {
    var e = normalizeError(err);
    if (e.code === 'permission-denied' || /permission/i.test(e.message)) {
      return '권한이 없습니다 — firestore.rules 와 roles 문서를 확인해 주세요';
    }
    if (isQuotaError(err)) { return '무료 한도를 다 썼습니다'; }
    if (e.code === 'unavailable' || /offline|network|Failed to fetch/i.test(e.message)) {
      return '인터넷 연결이 없습니다 — 연결되면 자동으로 다시 보냅니다';
    }
    if (e.code === 'unauthenticated') { return '로그인이 필요합니다'; }
    return (e.code ? ('[' + e.code + '] ') : '') + (e.message || '오류');
  }
  function isQuotaError(err) {
    var e = normalizeError(err);
    return e.code === 'resource-exhausted' || /resource[- ]exhausted|quota|daily limit/i.test(e.message);
  }

  /* ---------- 브라우저 저장공간(localStorage)이 가득 찼을 때 ----------
     QuotaExceededError 는 Firestore 무료 한도(resource-exhausted)와 전혀 다른 오류다.
     저장에 실패해도 앱·동기화가 멈추지 않도록 여기서 조용히 걸러 낸다. */
  function isStorageQuotaError(err) {
    if (!err) { return false; }
    var name = String(err.name || '');
    var code = Number(err.code);
    var msg = String(err.message || err || '');
    return name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
      code === 22 || code === 1014 || /quota|exceeded the quota/i.test(msg);
  }

  /* localStorage 쓰기를 한 곳으로 모은다 — 실패해도 예외를 밖으로 던지지 않는다.
     opts.onError(err, key) 로 엔진이 화면·상태에 알린다. */
  function setItemSafe(storage, key, value, opts) {
    try {
      storage.setItem(key, value);
      return true;
    } catch (err) {
      if (opts && typeof opts.onError === 'function') {
        try { opts.onError(err, key); } catch (e) {}
      }
      try {
        console.warn('[TDK 동기화] ' + key + ' 저장 실패 — 이번 값은 기기에 남기지 못했습니다 (' +
          String((err && (err.name || err.message)) || err) + ')');
      } catch (e) {}
      return false;
    }
  }

  /* =========================================================================
     1-2. 그림자(tdk.fbShadow.v1) 보관소 — IndexedDB (localStorage 5MB 한도 밖)
     -------------------------------------------------------------------------
     · 그림자는 앱 데이터와 거의 같은 크기라 localStorage 에 함께 두면 한도가 터진다.
     · 인메모리 객체가 정본이고, IndexedDB(tdk_fb_cache)는 앱을 다시 열었을 때
       되살리는 사본이다.
     · IndexedDB 가 없는 환경(Node·QuickJS 테스트)에서는 인메모리만으로 똑같이 동작한다.
     ========================================================================= */
  var SHADOW_LS_KEY = 'tdk.fbShadow.v1';
  var IDB_NAME = 'tdk_fb_cache';
  var IDB_STORE = 'kv';
  var IDB_SHADOW_ITEM = 'shadow';
  var SHADOW_PERSIST_MS = 300;        /* 연속 저장을 한 번으로 모으는 시간 */
  var SHADOW_OPEN_TIMEOUT_MS = 4000;  /* IndexedDB 가 응답하지 않으면 그림자 없이 계속 */
  var SHADOW_MAX_ENTRIES = 30000;     /* 오래된 출결 그림자 정리 기준 */

  function idbFactory() {
    try { return root.indexedDB || root.webkitIndexedDB || root.mozIndexedDB || null; } catch (e) { return null; }
  }
  function idbSupported() { return !!idbFactory(); }

  /* ---------- 엔진 없이(로컬 모드 부팅) 옛 그림자만 옮기는 길 ----------
     연결을 하지 않은 기기에서도 localStorage 5MB 한도를 비울 수 있어야 한다.
     엔진과 달리 한 번만 쓰고 끝나므로 상태를 따로 둔다. */
  var rawIdb = { db: null, promise: null, disabled: false };

  function rawOpenDb() {
    if (rawIdb.db) { return Promise.resolve(rawIdb.db); }
    if (rawIdb.promise) { return rawIdb.promise; }
    var f = idbFactory();
    if (!f) { return Promise.reject(new Error('indexedDB 없음')); }
    rawIdb.promise = new Promise(function (resolve, reject) {
      var settled = false;
      function fail(err) {
        if (settled) { return; }
        settled = true;
        rawIdb.promise = null;
        rawIdb.disabled = true;
        reject(err || new Error('indexedDB 열기 실패'));
      }
      var req;
      try { req = f.open(IDB_NAME, 1); } catch (e) { fail(e); return; }
      req.onupgradeneeded = function () {
        try {
          var db = req.result;
          if (db && db.objectStoreNames && !db.objectStoreNames.contains(IDB_STORE)) { db.createObjectStore(IDB_STORE); }
        } catch (e) {}
      };
      req.onsuccess = function () {
        if (settled) { return; }
        settled = true;
        rawIdb.db = req.result;
        resolve(req.result);
      };
      req.onerror = function () { fail(req.error); };
      req.onblocked = function () { fail(new Error('indexedDB 차단됨')); };
      try { setTimeout(function () { fail(new Error('indexedDB 응답 없음')); }, SHADOW_OPEN_TIMEOUT_MS); } catch (e) {}
    });
    return rawIdb.promise;
  }

  function rawReadShadow() {
    if (rawIdb.disabled || !idbSupported()) { return Promise.resolve(null); }
    return rawOpenDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var req;
        try {
          var tx = db.transaction(IDB_STORE, 'readonly');
          req = tx.objectStore(IDB_STORE).get(IDB_SHADOW_ITEM);
        } catch (e) { reject(e); return; }
        req.onsuccess = function () {
          var v = req.result;
          if (typeof v === 'string' || isPlain(v)) { resolve(v); return; }
          resolve(null);
        };
        req.onerror = function () { reject(req.error); };
      });
    });
  }

  function rawWriteShadow(json) {
    if (rawIdb.disabled || !idbSupported()) { return Promise.resolve(false); }
    return rawOpenDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var settled = false;
        function finish(ok, err) {
          if (settled) { return; }
          settled = true;
          if (ok) { resolve(true); } else { reject(err); }
        }
        try {
          var tx = db.transaction(IDB_STORE, 'readwrite');
          var req = tx.objectStore(IDB_STORE).put(json, IDB_SHADOW_ITEM);
          req.onsuccess = function () { finish(true); };
          req.onerror = function () { finish(false, req.error); };
        } catch (e) { finish(false, e); }
      });
    });
  }

  /* 옛 localStorage 그림자를 IndexedDB 로 옮기고 localStorage 를 비운다 (엔진 없이 호출 가능) */
  function migrateShadowCache(storage) {
    var st = storage || root.localStorage;
    if (!st) { return Promise.resolve({ ok: false, reason: 'no-storage' }); }
    var raw = null;
    try { raw = st.getItem(SHADOW_LS_KEY); } catch (e) { raw = null; }
    if (raw == null) { return Promise.resolve({ ok: true, migrated: false }); }
    var legacy = null;
    try { legacy = JSON.parse(raw); } catch (e) { legacy = null; }
    if (!isPlain(legacy)) { legacy = {}; }
    function finish(saved) {
      var removed = false;
      try { st.removeItem(SHADOW_LS_KEY); removed = true; } catch (e) { removed = false; }
      return {
        ok: true, migrated: true, entries: Object.keys(legacy).length,
        saved: saved === true, removed: removed, bytesFreed: String(raw).length
      };
    }
    if (!idbSupported()) { return Promise.resolve(finish(false)); }
    return rawReadShadow().then(function (existing) {
      var merged = {};
      function add(o) {
        if (!isPlain(o)) { return; }
        Object.keys(o).forEach(function (k) {
          var b = o[k];
          if (!isPlain(b)) { return; }
          var a = merged[k];
          if (!a || num(b.v) > num(a.v)) { merged[k] = b; }
        });
      }
      add(legacy);
      if (typeof existing === 'string') { try { add(JSON.parse(existing)); } catch (e) {} }
      else { add(existing); }
      return rawWriteShadow(JSON.stringify(merged)).then(function () { return finish(true); }, function () { return finish(false); });
    }, function () { return finish(false); });
  }

  /* =========================================================================
     2. 필드 단위 병합 (Field-level merge)
     -------------------------------------------------------------------------
     문서마다 필드별 _fieldMeta = { "필드": { v:버전, at:수정시각, by:기기 } } 를 둔다.
     두 기기의 문서를 합칠 때 필드마다 (v → at → by) 순으로 새 것을 고르므로,
     PC가 note 를, 태블릿이 belt 를 동시에 고쳐도 두 변경이 모두 남는다.
     _fieldMeta 가 없는 옛 문서(다른 앱·수동 입력)는 문서 단위(ver·시각·기기)로 비교한다.
     ========================================================================= */
  function metaOf(doc) {
    var m = doc && doc._fieldMeta;
    return isPlain(m) ? m : null;
  }
  /* 문서에서 값 필드만 (메타 필드 _로 시작하는 것은 제외, _value 는 값) */
  /* 문서에 담을 값 필드 — _value 는 값이므로 남긴다 */
  function valueFields(obj) {
    var out = {};
    Object.keys(obj || {}).forEach(function (k) {
      if (k === '_value' || k.charAt(0) !== '_') { out[k] = obj[k]; }
    });
    return out;
  }
  function docBody(doc) {
    var out = {};
    if (!isPlain(doc)) { return out; }
    if (hasOwn(doc, '_value')) { return { _value: doc._value }; }
    Object.keys(doc).forEach(function (k) { if (k.charAt(0) !== '_') { out[k] = doc[k]; } });
    return out;
  }
  function cmpMeta(a, b) {
    if (!a && !b) { return 0; }
    if (!a) { return -1; }
    if (!b) { return 1; }
    var av = num(a.v), bv = num(b.v);
    if (av !== bv) { return av > bv ? 1 : -1; }
    var aa = String(a.at || ''), ba = String(b.at || '');
    if (aa !== ba) { return aa > ba ? 1 : -1; }
    var ab = String(a.by || ''), bb = String(b.by || '');
    if (ab !== bb) { return ab > bb ? 1 : -1; }
    return 0;
  }
  /* 문서 단위 비교 — 완전 동률이면 내용으로 결정해 양쪽이 같은 결론을 내게 한다 */
  function docCmp(a, b) {
    var av = num(a && a._ver), bv = num(b && b._ver);
    if (av !== bv) { return av > bv ? 1 : -1; }
    var aa = String((a && a._updatedAt) || ''), ba = String((b && b._updatedAt) || '');
    if (aa !== ba) { return aa > ba ? 1 : -1; }
    var ab = String((a && a._updatedBy) || ''), bb = String((b && b._updatedBy) || '');
    if (ab !== bb) { return ab > bb ? 1 : -1; }
    var as = stableStringify(a || {}), bs = stableStringify(b || {});
    if (as !== bs) { return as > bs ? 1 : -1; }
    return 0;
  }

  /* 로컬 값이 바뀌었을 때 필드별 버전을 올린다 (바뀌지 않은 필드는 이전 메타 유지) */
  function stampFields(prevBody, prevMeta, nextBody, ctx) {
    var pf = flatten(prevBody || {}), nf = flatten(nextBody || {});
    var meta = {};
    Object.keys(nf).forEach(function (f) {
      var same = hasOwn(pf, f) && stableStringify(pf[f]) === stableStringify(nf[f]);
      if (same) {
        /* 값이 그대로면 이전 메타를 그대로 둔다 (없던 필드는 메타도 만들지 않음) */
        if (prevMeta && prevMeta[f]) { meta[f] = prevMeta[f]; }
        return;
      }
      meta[f] = {
        v: ((prevMeta && prevMeta[f] && num(prevMeta[f].v)) || 0) + 1,
        at: ctx.at,
        by: ctx.by
      };
    });
    return meta;
  }

  /* 배열(로그·문구·쿠폰종류)은 id 기준 합집합 — 양쪽에서 추가한 항목이 모두 남는다 */
  function unionArrays(localArr, remoteArr, preferRemoteOrder) {
    var out = [], seen = {};
    function idOf(item, i) {
      if (isPlain(item) && item.id != null) { return 'id:' + String(item.id); }
      return 'raw:' + stableStringify(item);
    }
    var first = preferRemoteOrder ? remoteArr : localArr;
    var second = preferRemoteOrder ? localArr : remoteArr;
    (Array.isArray(first) ? first : []).forEach(function (item, i) {
      var k = idOf(item, i);
      if (seen[k]) { return; }
      seen[k] = 1;
      out.push(item);
    });
    (Array.isArray(second) ? second : []).forEach(function (item, i) {
      var k = idOf(item, i);
      if (seen[k]) { return; }
      seen[k] = 1;
      out.push(item);
    });
    return out;
  }

  /* 로컬 문서(또는 없음)와 원격 문서를 필드 단위로 합친다 */
  function mergeDocs(localDoc, remoteDoc, opts) {
    opts = opts || {};
    var l = localDoc || {};
    var r = remoteDoc || {};
    var lBody = docBody(l);
    var rBody = docBody(r);
    var lMeta = metaOf(l), rMeta = metaOf(r);

    var result = { body: {}, meta: {}, ver: Math.max(num(l._ver), num(r._ver)), deleted: false, conflict: false };

    /* --- 1) 삭제(툼스톤) --- */
    var lDel = l._deleted === true, rDel = r._deleted === true;
    if (lDel || rDel) {
      var c = docCmp(l, r);
      var winner = c < 0 ? 'r' : (c > 0 ? 'l' : (rDel ? 'r' : 'l'));
      if (winner === 'r' && rDel) {
        result.deleted = true;
        result.ver = Math.max(num(l._ver), num(r._ver));
        return result;
      }
      if (winner === 'l' && lDel) {
        result.deleted = true;
        result.ver = Math.max(num(l._ver), num(r._ver));
        return result;
      }
      /* 진 쪽(삭제)은 무시하고 살아 있는 쪽 내용으로 이어 간다 */
    }

    /* --- 2) 단일 값(_value) 문서 — 효과음 끔·로그·문구·쿠폰종류 --- */
    if (hasOwn(lBody, '_value') || hasOwn(rBody, '_value')) {
      var lv0 = hasOwn(lBody, '_value') ? lBody._value : undefined;
      var rv0 = hasOwn(rBody, '_value') ? rBody._value : undefined;
      if (opts.arrayUnion && Array.isArray(lv0) && Array.isArray(rv0)) {
        var union = unionArrays(lv0, rv0, true);
        result.body = { _value: union };
        result.meta = { _value: cmpMeta(lMeta && lMeta._value, rMeta && rMeta._value) >= 0
          ? (lMeta && lMeta._value) : (rMeta && rMeta._value) };
        result.conflict = stableStringify(lv0) !== stableStringify(union);
        return result;
      }
      var pickV;
      if (!lMeta || !rMeta) {
        pickV = docCmp(l, r) >= 0 ? 'l' : 'r';
      } else {
        var c3 = cmpMeta(lMeta._value, rMeta._value);
        if (c3 > 0) { pickV = 'l'; }
        else if (c3 < 0) { pickV = 'r'; }
        else { pickV = stableStringify(lv0) > stableStringify(rv0) ? 'l' : 'r'; }
      }
      result.body = { _value: pickV === 'l' ? lv0 : rv0 };
      if (pickV === 'l' && lMeta && lMeta._value) { result.meta = { _value: lMeta._value }; }
      else if (pickV === 'r' && rMeta && rMeta._value) { result.meta = { _value: rMeta._value }; }
      result.conflict = hasOwn(lBody, '_value') && hasOwn(rBody, '_value') &&
        stableStringify(lv0) !== stableStringify(rv0);
      return result;
    }

    /* --- 3) 필드 단위 병합 --- */
    var lf = flatten(lBody), rf = flatten(rBody);
    var fields = {};
    Object.keys(lf).forEach(function (f) { fields[f] = 1; });
    Object.keys(rf).forEach(function (f) { fields[f] = 1; });
    Object.keys(fields).sort().forEach(function (f) {
      var inL = hasOwn(lf, f), inR = hasOwn(rf, f);
      var pick;
      if (inL && !inR) { pick = 'l'; }
      else if (!inL && inR) { pick = 'r'; }
      else if (stableStringify(lf[f]) === stableStringify(rf[f])) { pick = 'l'; }
      else if (!lMeta || !rMeta) {
        /* 옛 문서(필드 메타 없음) → 문서 단위 비교 */
        pick = docCmp(l, r) >= 0 ? 'l' : 'r';
      } else {
        var c2 = cmpMeta(lMeta[f], rMeta[f]);
        if (c2 > 0) { pick = 'l'; }
        else if (c2 < 0) { pick = 'r'; }
        else {
          /* 메타까지 같으면 내용으로 결정 — 양쪽이 같은 결론(수렴) */
          pick = stableStringify(lf[f]) > stableStringify(rf[f]) ? 'l' : 'r';
        }
      }
      if (pick === 'l') {
        result.body[f] = lf[f];
        if (lMeta && lMeta[f]) { result.meta[f] = lMeta[f]; }
      } else {
        result.body[f] = rf[f];
        if (rMeta && rMeta[f]) { result.meta[f] = rMeta[f]; }
      }
      if (inL && inR && stableStringify(lf[f]) !== stableStringify(rf[f])) {
        /* 양쪽이 서로 다르게 고친 필드가 있으면 conflict 로 표시 (양쪽 필드는 그대로 살아남는다) */
        var lv = lMeta && lMeta[f] ? num(lMeta[f].v) : num(l._ver);
        var rv = rMeta && rMeta[f] ? num(rMeta[f].v) : num(r._ver);
        if (lv === rv) { result.conflict = true; }
      }
    });
    result.body = unflatten(result.body);
    return result;
  }

  /* =========================================================================
     3. 저장 키 분류 (기존 localStorage 17개 키 전수)
     -------------------------------------------------------------------------
     · faces/adminFace → 기기 로컬 전용 (업로드 금지)
     · 나머지 전부 → Firestore 문서로 이전
     · 앱의 실제 LS 객체(__tdk.LS)에 새 키가 생기면 자동으로 meta/{키} 문서로 포함된다
     ========================================================================= */
  var KEY_TABLE = [
    { name: 'students', key: 'tdk.students.v1', label: '원생 명단', icon: '👥', kind: 'docs', coll: 'students', desc: '원생 1명 = 문서 1개' },
    { name: 'attendance', key: 'tdk.attendance.v1', label: '출결 기록', icon: '🕒', kind: 'events', coll: 'attendanceEvents', desc: '출결 1건 = 문서 1개 (eventId)' },
    { name: 'records', key: 'tdk.records.v1', label: '출결 기록(구버전)', icon: '🗂', kind: 'events', coll: 'attendanceEvents', desc: '같은 출결 문서로 합쳐 저장' },
    { name: 'tuition', key: 'tdk.tuition.v1', label: '원비 내역', icon: '💰', kind: 'tuition', coll: 'tuition', desc: '원생·월 1건 = 문서 1개' },
    { name: 'counsel', key: 'tdk.counsel.v1', label: '상담 기록', icon: '💬', kind: 'docs', coll: 'counsel', desc: '상담 1건 = 문서 1개' },
    { name: 'shuttle', key: 'tdk.shuttle.v1', label: '차량 운행', icon: '🚐', kind: 'docs', coll: 'shuttle', desc: '운행 1건 = 문서 1개' },
    { name: 'coupons', key: 'tdk.coupons.v1', label: '쿠폰 지급 현황', icon: '🎟', kind: 'docs', coll: 'coupons', desc: '쿠폰 1건 = 문서 1개' },
    { name: 'settings', key: 'tdk.settings.v1', label: '도장 설정', icon: '⚙️', kind: 'object', meta: 'settings', desc: 'meta/settings · 필드 단위 병합' },
    { name: 'feeTable', key: 'tdk.feeTable.v1', label: '수업 단가표', icon: '🏷', kind: 'object', meta: 'feeTable', desc: 'meta/feeTable · 필드 단위 병합' },
    { name: 'admin', key: 'tdk.admin.v1', label: '관리자 계정(해시)', icon: '🔐', kind: 'object', meta: 'admin', desc: 'meta/admin · 관리자만 읽기' },
    { name: 'smsTemplates', key: 'tdk.smsTemplates.v1', label: '단체문자 문구', icon: '📝', kind: 'value', meta: 'smsTemplates', union: true, desc: 'meta/smsTemplates · 항목 합집합' },
    { name: 'couponTypes', key: 'tdk.couponTypes.v1', label: '쿠폰 종류', icon: '🧾', kind: 'value', meta: 'couponTypes', union: true, desc: 'meta/couponTypes · 항목 합집합' },
    { name: 'logs', key: 'tdk.logs.v1', label: '문자 발송 로그(최근 200)', icon: '📨', kind: 'value', meta: 'logs', union: true, desc: 'meta/logs · 항목 합집합' },
    { name: 'muted', key: 'tdk.muted.v1', label: '효과음 끔', icon: '🔇', kind: 'value', meta: 'muted', desc: 'meta/muted' },
    { name: 'faces', key: 'tdk.faces.v1', label: '원생 얼굴 특징값', icon: '🙂', kind: 'local', desc: '기기 로컬 전용 · 업로드 안 함' },
    { name: 'adminFace', key: 'tdk.adminFace.v1', label: '관리자 얼굴 특징값', icon: '🙂', kind: 'local', desc: '기기 로컬 전용 · 업로드 안 함' },
    /* ↓ 자동으로 만들어지는 파생 문서 — 키는 위 항목과 같은 것을 읽는다(저장 키가 늘어나는 것은 아님) */
    { name: 'kioskStudents', key: 'tdk.students.v1', label: '출석 화면용 최소 정보', icon: '📱', kind: 'kiosk', coll: 'kioskStudents', derivedFrom: 'students', desc: 'students 에서 개인정보를 뺀 사본 · 태블릿이 읽는 곳' },
    { name: 'kioskConfig', key: 'tdk.settings.v1', label: '출석 화면 최소 설정', icon: '🎛', kind: 'object', meta: 'kioskConfig', derivedFrom: 'settings', transform: 'kioskConfig', desc: 'meta/kioskConfig · 태블릿이 읽는 최소 설정' }
  ];

  /* =========================================================================
     3-1. kioskStudents — 태블릿에 보여 줄 최소 정보만 남긴 사본
     -------------------------------------------------------------------------
     · 담는 칸: id · name · division · course · belt · status (+ 엔진 메타 _ver 등)
     · 절대 담지 않는 칸: phone · motherPhone · fatherPhone · smsTargets · motherName ·
       fatherName · address · birthDate · tconId · note · tuitionDay ·
       siblingDiscount · firstRegDate · monthlyFee · attendCount 등
       (firestore.rules 의 noPrivateFields() 가 서버에서도 한 번 더 막는다)
     ========================================================================= */
  var KIOSK_FIELDS = ['id', 'name', 'division', 'course', 'belt', 'status'];
  /* 절대 태블릿 사본(kioskStudents)에 넣지 않는 칸
     · 모·부 전화번호·성함·발송 대상, 주소까지 모두 개인정보로 본다 */
  var PRIVATE_STUDENT_FIELDS = ['phone', 'birthDate', 'tconId', 'note', 'tuitionDay', 'siblingDiscount', 'firstRegDate',
    'motherPhone', 'fatherPhone', 'smsTargets', 'motherName', 'fatherName', 'address'];

  function kioskStudentBody(s) {
    if (!isPlain(s)) { return null; }
    var id = String(s.id == null ? '' : s.id).trim();
    var name = String(s.name == null ? '' : s.name).trim();
    if (!id && !name) { return null; }
    return {
      id: id || name,
      name: name,
      division: String(s.division == null ? '' : s.division),
      course: String(s.course == null ? '' : s.course),
      belt: String(s.belt == null ? '' : s.belt),
      status: (s.status === 'paused') ? 'paused' : 'active'
    };
  }
  function kioskDocsOf(list, base) {
    var out = [];
    (Array.isArray(list) ? list : []).forEach(function (s) {
      var body = kioskStudentBody(s);
      if (!body) { return; }
      var id = safeId(body.id);
      out.push({ id: id, path: base + '/kioskStudents/' + id, body: body });
    });
    return out;
  }
  /* 태블릿이 읽는 최소 설정 — 도장 이름과 "문자는 관리자 PC가 보낸다" 정도만 */
  function kioskConfigBody(settings) {
    var s = isPlain(settings) ? settings : {};
    return {
      dojoName: String(s.dojoName == null ? '' : s.dojoName),
      kioskEnabled: true,
      smsByAdmin: true
    };
  }
  /* =========================================================================
     3-2. 🧹 태블릿 개인정보 비우기(얼굴 유지) — 대상 칸과 남길 칸
     -------------------------------------------------------------------------
     · 원생 객체에서 남기는 칸: id · name · division · course · belt · status
       (+ 동기화 메타 _ver 등 _ 로 시작하는 칸)
     · 이 기기에서 비우는 저장 키: 원비·상담·차량·쿠폰·문자로그·단가표·
       문자문구·효과음·관리자 얼굴 — 태블릿 화면에 필요 없는 것들
     · 절대 건드리지 않는 키: tdk.faces.v1(원생 얼굴) · tdk.fbConfig.v1 ·
       tdk.fbDevice.v1 · tdk.fbState.v1 · tdk.fbOutbox.v1 · tdk.fbShadow.v1 · tdk.fbUsage.v1
     ========================================================================= */
  var SCRUB_KEEP_FIELDS = ['id', 'name', 'division', 'course', 'belt', 'status'];
  var SCRUB_CLEAR_NAMES = ['tuition', 'counsel', 'shuttle', 'coupons', 'couponTypes', 'logs', 'feeTable', 'smsTemplates', 'muted', 'adminFace'];
  var SCRUB_EMPTY = {
    tuition: {}, counsel: [], shuttle: [], coupons: [], couponTypes: [], logs: [],
    feeTable: {}, smsTemplates: [], muted: false, adminFace: []
  };
  /* 얼굴 특징값 보관함은 객체({id:{…}}) 또는 배열([{…}]) 둘 다 쓴다 */
  function countFaces(value) {
    if (Array.isArray(value)) {
      return value.filter(function (f) { return !!f && typeof f === 'object'; }).length;
    }
    if (!isPlain(value)) { return 0; }
    return Object.keys(value).filter(function (k) {
      var f = value[k];
      return !!f && typeof f === 'object';
    }).length;
  }

  /* 이 도장 데이터에 개인정보가 들어 있는 원생이 몇 명인지 (태블릿 안내용)
     · 빈 칸('')·기본값(false·0)은 개인정보로 세지 않는다 — 앱은 원생을 불러올 때
       phone·note 를 '' 로, siblingDiscount 를 false 로, tuitionDay 를 0 으로 채워 두기 때문이다. */
  function hasPrivateValue(v) {
    if (v === undefined || v === null) { return false; }
    if (typeof v === 'boolean') { return v; }
    if (typeof v === 'number') { return isFinite(v) && v !== 0; }
    if (typeof v === 'object') {
      /* 문자 발송 대상(smsTargets)은 {mother, father} 두 칸뿐인 선택값이다.
         기본값(모만 받음)은 개인정보로 세지 않고, 부까지 받거나 모를 끈 경우만 센다. */
      var keys = Object.keys(v);
      if (keys.length === 2 && keys.indexOf('mother') !== -1 && keys.indexOf('father') !== -1) {
        return v.mother !== true || v.father === true;
      }
      return keys.some(function (k) { return hasPrivateValue(v[k]); });
    }
    var s = String(v).trim();
    return s !== '' && s !== '0' && s !== 'false' && s !== 'null' && s !== 'undefined';
  }
  function countPrivateStudents(list) {
    var n = 0;
    (Array.isArray(list) ? list : []).forEach(function (s) {
      if (!isPlain(s)) { return; }
      for (var i = 0; i < PRIVATE_STUDENT_FIELDS.length; i++) {
        if (hasPrivateValue(s[PRIVATE_STUDENT_FIELDS[i]])) { n++; return; }
      }
    });
    return n;
  }

  /* 엔진이 스스로 저장하는 기기 로컬 키 (동기화 대상 아님) */
  var LOCAL_KEYS = {
    'tdk.fbConfig.v1': 1, 'tdk.fbDevice.v1': 1, 'tdk.fbUsage.v1': 1,
    'tdk.fbOutbox.v1': 1, 'tdk.fbShadow.v1': 1, 'tdk.fbMock.v1': 1,
    'tdk.fbState.v1': 1
  };

  function buildRegistry(extraKeys) {
    var out = KEY_TABLE.map(function (e) { return clone(e); });
    var known = {};
    out.forEach(function (e) { known[e.key] = 1; });
    /* 앱의 실제 LS 객체에 있는데 표에 없는 키도 빠뜨리지 않고 포함한다 */
    if (isPlain(extraKeys)) {
      Object.keys(extraKeys).forEach(function (name) {
        var key = String(extraKeys[name]);
        if (known[key]) { return; }
        known[key] = 1;
        out.push({
          name: name, key: key, label: name, icon: '📦', kind: 'object',
          meta: safeId(name), desc: 'meta/' + safeId(name) + ' (자동 포함)', auto: true
        });
      });
    }
    return out;
  }

  /* =========================================================================
     4. 로컬 값 → Firestore 문서
     ========================================================================= */
  function eventIdOf(date, studentId, kind) {
    return safeId(date) + '_' + safeId(studentId) + '_' + (kind === 'out' ? 'out' : 'in');
  }
  function parseEventId(id) {
    var s = String(id || '');
    var m = /^(.+?)_(.+)_(in|out)$/.exec(s);
    if (!m) { return null; }
    return { date: m[1], studentId: m[2], kind: m[3] };
  }

  function docsForEntry(entry, value, base, ctx) {
    var docs = [];
    /* 기기 ID — 출결 문서의 deviceId 칸(규칙의 허용 목록 안)으로 들어간다 */
    var did = String((ctx && ctx.deviceId) || '');
    if (!entry || entry.kind === 'local') { return docs; }
    var collPath = function (coll) { return base + '/' + coll; };

    if (entry.kind === 'docs') {
      var list = Array.isArray(value) ? value : [];
      list.forEach(function (item, i) {
        if (!isPlain(item)) { return; }
        var id = item.id != null && String(item.id) ? String(item.id) : ('auto_' + hashStr(stableStringify(item)) + '_' + i);
        docs.push({ id: id, path: collPath(entry.coll) + '/' + safeId(id), body: item });
      });
      return docs;
    }

    if (entry.kind === 'events') {
      var att = (entry.name === 'attendance') ? value : null;
      var rec = (entry.name === 'records') ? value : null;
      var days = isPlain(value) ? value : {};
      Object.keys(days).forEach(function (date) {
        var day = days[date];
        if (!isPlain(day)) { return; }
        Object.keys(day).forEach(function (sid) {
          var e = day[sid];
          if (!isPlain(e)) { return; }
          var inT = att ? String(e.inTime || '').slice(0, 5) : String(e.in || '').slice(0, 5);
          var outT = att ? String(e.outTime || '').slice(0, 5) : String(e.out || '').slice(0, 5);
          var manual = !!e.manual;
          var src = String(e.src || (att ? '' : 'legacy'));
          /* 문서에 넣는 칸은 firestore.rules 의 eventFields() 와 정확히 같아야 한다
             (date · studentId · kind · time · eventId · source · manual · deviceId) */
          if (inT) {
            var inId = eventIdOf(date, sid, 'in');
            docs.push({
              id: inId,
              path: collPath('attendanceEvents') + '/' + inId,
              body: {
                date: date, studentId: sid, kind: 'in', time: inT,
                eventId: inId, source: src, manual: manual, deviceId: did
              }
            });
          }
          if (outT) {
            var outId = eventIdOf(date, sid, 'out');
            docs.push({
              id: outId,
              path: collPath('attendanceEvents') + '/' + outId,
              body: {
                date: date, studentId: sid, kind: 'out', time: outT,
                eventId: outId, source: src, manual: manual, deviceId: did
              }
            });
          }
        });
      });
      return docs;
    }

    if (entry.kind === 'tuition') {
      var months = isPlain(value) ? value : {};
      Object.keys(months).forEach(function (mk) {
        var month = months[mk];
        if (!isPlain(month)) { return; }
        Object.keys(month).forEach(function (sid) {
          var rec2 = month[sid];
          if (!isPlain(rec2)) { return; }
          var id2 = safeId(mk) + '_' + safeId(sid);
          docs.push({ id: id2, path: collPath('tuition') + '/' + id2, body: rec2 });
        });
      });
      return docs;
    }

    if (entry.kind === 'object') {
      var body = isPlain(value) ? value : {};
      if (entry.transform === 'kioskConfig') {
        /* 설정 원본이 없는 기기에서는 만들지 않는다(빈 문서 방지) */
        if (!isPlain(value)) { return docs; }
        body = kioskConfigBody(value);
      }
      docs.push({ id: entry.meta, path: base + '/meta/' + safeId(entry.meta), body: body });
      return docs;
    }

    /* 출석 화면용 최소 정보 사본 — 원생 1명 = kioskStudents 문서 1개 */
    if (entry.kind === 'kiosk') {
      return kioskDocsOf(value, base);
    }

    if (entry.kind === 'value') {
      docs.push({ id: entry.meta, path: base + '/meta/' + safeId(entry.meta), body: { _value: value === undefined ? null : value } });
      return docs;
    }
    return docs;
  }

  /* 출결은 attendance·records 두 키가 같은 문서를 만든다 → 항상 합쳐서 본다 */
  function unionEventDocs(attValue, recValue, base, ctx) {
    var map = {};
    var entries = [
      { name: 'attendance', kind: 'events' },
      { name: 'records', kind: 'events' }
    ];
    entries.forEach(function (e) {
      var v = e.name === 'attendance' ? attValue : recValue;
      docsForEntry({ name: e.name, kind: 'events' }, v, base, ctx).forEach(function (d) {
        var prev = map[d.path];
        if (!prev) { map[d.path] = d; return; }
        /* attendance 쪽 정보가 더 자세하다 → 시간이 있으면 그것을 쓴다 */
        if (!prev.body.time && d.body.time) { map[d.path] = d; }
        else if (prev.body.time === d.body.time && d.body.manual) { prev.body.manual = true; }
      });
    });
    return map;
  }

  /* =========================================================================
     5. 사용량 계량기 (Spark 무료 한도)
     ========================================================================= */
  function createUsage(storage, opts) {
    opts = opts || {};
    var key = opts.key || 'tdk.fbUsage.v1';
    var now = opts.now || function () { return Date.now(); };
    var limits = {
      reads: num(opts.limits && opts.limits.reads) || SPARK.reads,
      writes: num(opts.limits && opts.limits.writes) || SPARK.writes,
      deletes: num(opts.limits && opts.limits.deletes) || SPARK.deletes
    };
    var state = read();
    function read() {
      var raw = null;
      try { raw = storage.getItem(key); } catch (e) { raw = null; }
      var s = null;
      try { s = raw ? JSON.parse(raw) : null; } catch (e) { s = null; }
      var today = sparkDayOf(now());
      if (!isPlain(s) || s.date !== today) {
        /* 날짜가 바뀌었으면 카운터·차단을 비우고, 지난 날 합계는 history 로 옮겨 남긴다 */
        var hist = (isPlain(s) && isPlain(s.history)) ? s.history : {};
        if (isPlain(s) && s.date && (num(s.reads) || num(s.writes) || num(s.deletes))) {
          hist[String(s.date)] = { reads: num(s.reads), writes: num(s.writes), deletes: num(s.deletes) };
        }
        s = { date: today, reads: 0, writes: 0, deletes: 0, blocked: null, history: hist };
      }
      if (!isPlain(s.history)) { s.history = {}; }
      /* 날짜가 바뀌면 이전 날 합계를 남겨 두어 추세를 볼 수 있게 */
      var keys = Object.keys(s.history);
      if (keys.length > 7) {
        keys.sort();
        while (keys.length > 7) { delete s.history[keys.shift()]; }
      }
      return s;
    }
    function resetIfNeeded() {
      var today = sparkDayOf(now());
      if (state.date !== today) {
        state.history[state.date] = { reads: num(state.reads), writes: num(state.writes), deletes: num(state.deletes) };
        state = { date: today, reads: 0, writes: 0, deletes: 0, blocked: null, history: state.history };
        persist();
        return true;
      }
      return false;
    }
    /* 사용량은 "있으면 좋은" 기록 — 저장에 실패해도 동기화를 멈추지 않는다 */
    function persist() { setItemSafe(storage, key, JSON.stringify(state), opts); }

    return {
      record: function (kind, n) {
        resetIfNeeded();
        var add = Math.max(0, num(n == null ? 1 : n));
        if (kind === 'reads') { state.reads += add; }
        else if (kind === 'writes') { state.writes += add; }
        else if (kind === 'deletes') { state.deletes += add; }
        else { return; }
        persist();
      },
      snapshot: function () {
        resetIfNeeded();
        var pct = {
          reads: state.reads / limits.reads,
          writes: state.writes / limits.writes,
          deletes: state.deletes / limits.deletes
        };
        var max = Math.max(pct.reads, pct.writes, pct.deletes);
        var level = state.blocked ? 2 : (max >= 1 ? 2 : (max >= SPARK.warnRatio ? 1 : 0));
        return {
          date: state.date,
          reads: state.reads, writes: state.writes, deletes: state.deletes,
          limits: { reads: limits.reads, writes: limits.writes, deletes: limits.deletes },
          pct: pct, level: level, maxPct: max,
          blocked: state.blocked || null,
          history: clone(state.history) || {}
        };
      },
      blocked: function () {
        resetIfNeeded();
        if (state.blocked) { return true; }
        var s = this.snapshot();
        return s.level >= 2;
      },
      blockByError: function (err) {
        resetIfNeeded();
        state.blocked = { at: isoOf(now()), reason: 'resource-exhausted', text: errorText(err || { code: 'resource-exhausted' }) };
        persist();
      },
      clearBlock: function () { state.blocked = null; persist(); },
      reset: function () {
        state = { date: sparkDayOf(now()), reads: 0, writes: 0, deletes: 0, blocked: null, history: state.history };
        persist();
      },
      limits: limits
    };
  }

  /* =========================================================================
     5-2. 델타(증분) 동기화 — 컬렉션별 마지막 동기화 시각 (tdk.fbLastSync.v1)
     ----------------------------------------------------------------------------
     이미 한 번 전체를 받아 둔 기기는 새로고침 때 `_updatedAt > (마지막 - 2분)` 만
     구독한다 → 새로고침마다 2,500건을 다시 읽던 것이 0~5건으로 줄어든다.
       · 값: { students: 1732435200000, tuition: … } — 컬렉션 이름 → epoch ms(숫자)
       · 단일 필드 where('_updatedAt', '>', …) 는 Firestore 자동 단일 인덱스를 쓰므로
         복합 인덱스도 firestore.rules 수정도 필요 없다.
       · 삭제는 `_deleted: true` 툼스톤(_updatedAt 포함)으로 올라오니 델타로도 받는다.
       · meta 는 문서가 몇 개 안 되므로 전체 구독 그대로 둔다.
       · 키가 없거나(첫 실행) 이 기기에 자료가 비어 있으면(새 기기·초기화) 전체 구독.
       · 캐시에서 온 스냅샷(metadata.fromCache)은 "서버에서 읽었다"가 아니므로
         계량기에 넣지도, 마지막 시각을 갱신하지도 않는다.
     ========================================================================= */
  var LASTSYNC_KEY = 'tdk.fbLastSync.v1';
  var DELTA = {
    safetyMs: 120000,                    /* 기기·서버 시각 차이 여유 2분 */
    maxAgeMs: 45 * 24 * 3600 * 1000      /* 너무 오래된 시각은 믿지 않고 전체 구독 */
  };

  function lastSyncStore(storage) {
    if (storage && typeof storage.getItem === 'function') { return storage; }
    try { return root.localStorage || null; } catch (e) { return null; }
  }
  function readLastSync(storage) {
    var s = lastSyncStore(storage);
    if (!s) { return {}; }
    try {
      var raw = s.getItem(LASTSYNC_KEY);
      var o = raw ? JSON.parse(raw) : null;
      if (!isPlain(o)) { return {}; }
      var out = {};
      Object.keys(o).forEach(function (k) {
        var n = num(o[k]);
        if (n > 0) { out[k] = n; }
      });
      return out;
    } catch (e) { return {}; }
  }
  function writeLastSync(storage, map) {
    var s = lastSyncStore(storage);
    if (!s || typeof s.setItem !== 'function') { return false; }
    try { s.setItem(LASTSYNC_KEY, JSON.stringify(map || {})); return true; } catch (e) { return false; }
  }
  /* 컬렉션의 델타 기준 시각 → where('_updatedAt','>',값) 문자열 (전체 구독이면 '') */
  function deltaSinceIso(sinceMs, nowMs) {
    var at = num(sinceMs);
    if (!(at > 0)) { return ''; }
    var now = num(nowMs == null ? Date.now() : nowMs);
    if (now - at > DELTA.maxAgeMs) { return ''; }
    return isoOf(at - DELTA.safetyMs);
  }
  /* 이 기기에 그 컬렉션의 자료가 이미 있는가 — 없으면(새 기기·초기화) 전체 구독 */
  function localDataHas(storage, coll) {
    var s = lastSyncStore(storage);
    if (!s || !coll) { return false; }
    var keys = [];
    KEY_TABLE.forEach(function (e) {
      if (e.coll === coll && keys.indexOf(e.key) === -1) { keys.push(e.key); }
    });
    for (var i = 0; i < keys.length; i++) {
      try {
        var raw = s.getItem(keys[i]);
        if (!raw) { continue; }
        var v = JSON.parse(raw);
        if (Array.isArray(v) ? v.length > 0 : (isPlain(v) ? Object.keys(v).length > 0 : !!v)) { return true; }
      } catch (err) { /* 깨진 값은 없는 것으로 본다 */ }
    }
    return false;
  }

  /* =========================================================================
     6. 전송 큐 (Outbox) — 서버 저장 확인(ACK) 전에는 절대 지우지 않는다
     ========================================================================= */
  function createOutbox(storage, opts) {
    opts = opts || {};
    var key = opts.key || 'tdk.fbOutbox.v1';
    var now = opts.now || function () { return Date.now(); };
    var seq = 0;
    var state = read();
    function read() {
      var raw = null;
      try { raw = storage.getItem(key); } catch (e) { raw = null; }
      var s = null;
      try { s = raw ? JSON.parse(raw) : null; } catch (e) { s = null; }
      if (!isPlain(s) || !Array.isArray(s.items)) { s = { items: [] }; }
      return s;
    }
    /* 큐는 메모리에 항상 살아 있고, 저장만 실패해도 계속 쓸 수 있다 */
    function persist() { setItemSafe(storage, key, JSON.stringify(state), opts); }

    return {
      list: function () { return clone(state.items) || []; },
      pending: function () {
        return state.items.filter(function (it) { return it.state !== 'sent'; });
      },
      count: function () {
        var n = 0;
        state.items.forEach(function (it) { if (it.state !== 'sent') { n++; } });
        return n;
      },
      summary: function () {
        var s = { pending: 0, failed: 0, unacked: 0, sent: 0, oldestAt: '' };
        state.items.forEach(function (it) {
          if (it.state === 'sent') { s.sent++; return; }
          if (it.state === 'failed') { s.failed++; }
          else if (it.state === 'sent-unacked') { s.unacked++; }
          else { s.pending++; }
          if (!s.oldestAt || it.at < s.oldestAt) { s.oldestAt = it.at; }
        });
        return s;
      },
      enqueue: function (op) {
        /* 같은 문서에 대한 대기 항목은 마지막 것만 남긴다 (무료 쓰기 절약) */
        var path = String(op.path || '');
        state.items = state.items.filter(function (it) {
          return !(it.path === path && it.state === 'pending');
        });
        var item = {
          id: 'op_' + now().toString(36) + '_' + (seq++).toString(36) + Math.random().toString(36).slice(2, 6),
          path: path,
          body: op.body === undefined ? null : op.body,
          del: op.del === true,
          at: isoOf(now()),
          state: 'pending',
          attempts: 0,
          error: ''
        };
        state.items.push(item);
        persist();
        return item;
      },
      remove: function (ids) {
        var set = {};
        (ids || []).forEach(function (id) { set[id] = 1; });
        if (!Object.keys(set).length) { return; }
        state.items = state.items.filter(function (it) { return !set[it.id]; });
        persist();
      },
      mark: function (ids, nextState, err) {
        var set = {};
        (ids || []).forEach(function (id) { set[id] = 1; });
        state.items.forEach(function (it) {
          if (!set[it.id]) { return; }
          it.state = nextState;
          it.attempts = num(it.attempts) + 1;
          it.error = err ? errorText(err) : '';
          it.triedAt = isoOf(now());
        });
        persist();
      },
      retryAll: function () {
        state.items.forEach(function (it) {
          if (it.state === 'failed') { it.state = 'pending'; it.error = ''; }
        });
        persist();
      },
      /* 조건에 맞는 항목만 지운다.
         · dropWhere('failed') 처럼 상태 이름을 주면 그 상태만
         · 함수를 주면 그 함수가 true 인 항목만 (경로까지 따질 때)
         돌려주는 값은 지운 개수. */
      dropWhere: function (pred) {
        var fn = (typeof pred === 'function')
          ? pred
          : function (it) { return it.state === pred; };
        var before = state.items.length;
        state.items = state.items.filter(function (it) { return !fn(it); });
        var removed = before - state.items.length;
        if (removed) { persist(); }
        return removed;
      },
      clear: function () { state = { items: [] }; persist(); }
    };
  }

  /* =========================================================================
     7. 동기화 엔진
     ========================================================================= */
  function createEngine(opts) {
    opts = opts || {};
    var storage = opts.storage || root.localStorage;
    if (!storage) { throw new Error('storage 가 필요합니다'); }
    var now = opts.now || function () { return Date.now(); };
    var registry = buildRegistry(opts.keys);
    /* 저장 공간이 가득 차도 화면·상태로만 알리고 기능은 계속한다 */
    var usage = createUsage(storage, { now: now, limits: opts.limits, onError: noteStorageError });
    var outbox = createOutbox(storage, { now: now, onError: noteStorageError });
    /* 사용량이 경고(80%)·차단(100%) 단계로 넘어가면 화면에 바로 알린다 */
    var rawUsageRecord = usage.record;
    var rawUsageSnapshot = usage.snapshot;
    usage.record = function (kind, n) {
      var before = 0;
      try { before = usage.snapshot().level; } catch (e) { before = 0; }
      rawUsageRecord(kind, n);
      var after = 0;
      try { after = usage.snapshot().level; } catch (e) { after = 0; }
      if (after !== before) { emit('usage', usage.snapshot()); }
      /* 사용량이 늘었으면 잠시 뒤 한 번만 합산 문서에 올려 본다(60초 간격·최소 변화량은 pushUsageNow 가 판단) */
      scheduleUsagePush();
    };
    var deviceId = opts.deviceId || 'dev_local';
    var dojangId = safeId(opts.dojangId || 'mta-tkd');
    /* 화면(드롭다운)에서 고른 역할 — 이 값만으로는 권한을 주지 않는다 */
    var deviceRole = opts.role === 'tablet' ? 'tablet' : 'admin';
    /* 서버(dojangs/{도장}/roles/{uid})에서 확인한 역할
         null = 아직 확인 전 · '' = 로그인은 됐는데 roles 문서가 없음 · 'admin' | 'tablet' */
    var verifiedRole = (opts.verifiedRole === 'admin' || opts.verifiedRole === 'tablet') ? opts.verifiedRole : null;
    /* 시작할 때 서버 roles 를 자동으로 확인할지 (테스트에서 순서를 직접 잡을 때만 false) */
    var verifyOnStart = opts.verifyOnStart !== false;
    var adapter = opts.adapter || null;

    /* ---------- 기기별 사용량 합산 (dojangs/{도장}/meta/usage) ----------
       · 관리자로 확인된 기기에서만 읽고 쓴다. 태블릿은 규칙상 meta 를 읽을 수 없으므로
         meta/usage 구독·쓰기를 아예 시도하지 않는다(오류도 내지 않는다).
       · 이 문서의 쓰기·수신은 계량기(tdk.fbUsage.v1)에 넣지 않는다 —
         합산 문서 자체가 사용량을 늘려 다시 쓰는 되먹임 고리를 막기 위해서다.
       · 올리기는 최소 60초 간격 + 읽기 20/쓰기·삭제 5 이상 변화일 때만. */
    var usageSync = {
      remote: null,        /* 서버에서 받은 마지막 meta/usage 문서 */
      last: null,          /* 마지막으로 올린 내 값 */
      lastAt: 0,           /* 마지막으로 올린 시각(ms) */
      lastPushAt: '',
      busy: false,
      timer: null,
      tick: null,
      pushes: 0,
      skipped: 0,
      lastError: ''
    };
    var deviceLabel = String(opts.deviceLabel || deviceId);
    function usageMetaPath() { return basePath() + '/meta/usage'; }
    function usageSyncReason() {
      if (!adapter) { return 'no-adapter'; }
      if (effectiveRole() === 'tablet') { return 'tablet-role'; }
      if (!isEffectiveAdmin()) { return 'role-unverified'; }
      return '';
    }
    function usageSyncAllowed() { return usageSyncReason() === ''; }

    function myUsageEntry(at) {
      var s = rawUsageSnapshot();
      return {
        date: s.date, label: deviceLabel,
        reads: s.reads, writes: s.writes, deletes: s.deletes,
        blocked: !!s.blocked, updatedAt: isoOf(at == null ? now() : at)
      };
    }

    /* 지금 화면에 보일 "전체 기기 합산" — 내 기기의 살아 있는 값 + 서버에서 받은 다른 기기들의 오늘 값 */
    function usageTotalView(snap) {
      var s = snap || rawUsageSnapshot();
      var t = usageTotals(usageSync.remote, s.date, deviceId);
      var mine = { reads: s.reads, writes: s.writes, deletes: s.deletes, blocked: !!s.blocked };
      var totals = {
        reads: mine.reads + t.others.reads,
        writes: mine.writes + t.others.writes,
        deletes: mine.deletes + t.others.deletes
      };
      var limits = s.limits || { reads: SPARK.reads, writes: SPARK.writes, deletes: SPARK.deletes };
      var pct = {
        reads: totals.reads / (limits.reads || SPARK.reads),
        writes: totals.writes / (limits.writes || SPARK.writes),
        deletes: totals.deletes / (limits.deletes || SPARK.deletes)
      };
      var devices = [];
      t.devices.forEach(function (r) {
        if (r.deviceId === String(deviceId)) { return; }
        devices.push(r);
      });
      devices.push({
        deviceId: String(deviceId), label: deviceLabel, date: s.date,
        reads: mine.reads, writes: mine.writes, deletes: mine.deletes,
        blocked: !!mine.blocked, updatedAt: usageSync.lastPushAt, mine: true
      });
      return {
        date: s.date,
        mine: mine,
        others: t.others,
        otherDevices: t.othersCount,
        totals: totals,
        limits: { reads: limits.reads, writes: limits.writes, deletes: limits.deletes },
        pct: pct,
        maxPct: Math.max(pct.reads, pct.writes, pct.deletes),
        deviceCount: t.othersCount + 1,
        devices: devices
      };
    }

    /* usage.snapshot() 에 합산값을 함께 담아 준다 (기존 필드는 그대로 둔다) */
    usage.snapshot = function () {
      var s = rawUsageSnapshot();
      var v = usageTotalView(s);
      s.mine = v.mine;
      s.others = v.others;
      s.otherDevices = v.otherDevices;
      s.total = v.totals;
      s.totalPct = v.pct;
      s.totalMaxPct = v.maxPct;
      s.deviceCount = v.deviceCount;
      s.devices = v.devices;
      s.syncAllowed = usageSyncAllowed();
      s.syncReason = usageSyncReason();
      s.syncAt = usageSync.lastPushAt;
      s.syncCount = usageSync.pushes;
      return s;
    };

    /* meta/usage 에 쓸 문서 — 오늘의 다른 기기 항목은 그대로 두고 내 항목만 새 값으로 바꾼다 */
    function usageBodyToWrite(entry) {
      var devices = {};
      usageDeviceEntries(usageSync.remote, entry.date).forEach(function (r) {
        if (r.deviceId === String(deviceId)) { return; }
        devices[r.deviceId] = {
          date: r.date, label: r.label, reads: r.reads, writes: r.writes,
          deletes: r.deletes, blocked: r.blocked, updatedAt: r.updatedAt
        };
      });
      devices[safeId(deviceId)] = clone(entry) || entry;
      return { date: entry.date, devices: devices };
    }

    /* 한 번 올려 본다. force 를 주면 간격·변화량 판단을 건너뛴다(진단용).
       어떤 실패든 조용히 넘긴다 — 화면 경고·동기화 상태·전송 큐를 건드리지 않는다. */
    function pushUsageNow(force) {
      var reason = usageSyncReason();
      if (reason) { return Promise.resolve({ ok: false, pushed: false, reason: reason, skipped: true }); }
      if (usageSync.busy) { return Promise.resolve({ ok: false, pushed: false, reason: 'busy' }); }
      var at = now();
      var local = myUsageEntry(at);
      var d = (force === true) ? { push: true, reason: 'force' } : usagePushDecision(local, usageSync.last, at, usageSync.lastAt);
      if (!d.push) { usageSync.skipped++; return Promise.resolve({ ok: true, pushed: false, reason: d.reason }); }
      var body = usageBodyToWrite(local);
      usageSync.busy = true;
      var p;
      try { p = adapter.writeBatch([{ path: usageMetaPath(), body: body, merge: true }]); }
      catch (e) { p = Promise.reject(e); }
      return Promise.resolve(p).then(function () {
        usageSync.busy = false;
        usageSync.last = local;
        usageSync.lastAt = at;
        usageSync.lastPushAt = isoOf(at);
        usageSync.pushes++;
        usageSync.lastError = '';
        emit('usage-sync', { pushed: true, at: usageSync.lastPushAt, count: usageSync.pushes, deviceId: String(deviceId) });
        return { ok: true, pushed: true, reason: d.reason, at: usageSync.lastPushAt };
      }, function (err) {
        usageSync.busy = false;
        /* 태블릿·규칙 거부·오프라인 — 모두 조용히 건너뛴다 */
        usageSync.lastError = errorText(err);
        return { ok: false, pushed: false, reason: 'write-failed', error: usageSync.lastError, silent: true };
      });
    }

    function scheduleUsagePush(delayMs) {
      /* 테스트·수동 모드(autoflush:false)에서는 타이머를 걸지 않는다 — pushUsageNow() 로만 */
      if (opts.autoflush === false || !usageSyncAllowed()) { return; }
      if (usageSync.timer) { return; }
      usageSync.timer = setTimeout(function () {
        usageSync.timer = null;
        pushUsageNow().then(function () {}, function () {});
      }, Math.max(0, num(delayMs) || USAGE_SYNC.debounceMs));
    }

    function stopUsageSync() {
      if (usageSync.timer) { try { clearTimeout(usageSync.timer); } catch (e) {} usageSync.timer = null; }
      if (usageSync.tick) { try { clearInterval(usageSync.tick); } catch (e) {} usageSync.tick = null; }
    }

    /* 다른 기기가 올린 meta/usage 를 받았을 때 — 합산 표시만 새로 하고 되쓰지 않는다 */
    function onRemoteUsage(data) {
      usageSync.remote = isPlain(data) ? (clone(data) || null) : null;
      emit('usage', usage.snapshot());
    }

    /* ---------- 그림자(shadow) 상태 ----------
       정본은 인메모리 shadow · 사본은 IndexedDB. localStorage 는 부팅 때 옛 값을 옮기고 비운다. */
    var shadow = {};
    var shadowLoaded = false;
    var shadowSaveTimer = null;
    var shadowDirty = false;
    var shadowWriting = false;
    var shadowWritePromise = null;
    var shadowWriteFails = 0;
    var idbDb = null;
    var idbOpenPromise = null;
    var idbDisabled = false;
    var queuedCaptures = {};
    var shadowReadyResolve = null;
    var shadowReadyPromise = new Promise(function (resolve) { shadowReadyResolve = resolve; });

    /* localStorage 저장 실패 상태 (화면 표시·진단용) */
    var storageFull = false;
    var storageFailed = 0;
    var storageLastKey = '';
    var storageLastError = '';
    var storageLastAt = '';
    var notingStorageError = false;
    function noteStorageError(err, key) {
      storageFailed++;
      if (notingStorageError) { return; }
      notingStorageError = true;
      try {
        storageLastKey = String(key || '');
        storageLastError = isStorageQuotaError(err)
          ? '이 기기의 브라우저 저장 공간이 가득 찼습니다'
          : ('저장소에 쓰지 못했습니다 (' + String((err && (err.name || err.message)) || err) + ')');
        storageLastAt = isoOf(now());
        if (!isStorageQuotaError(err)) { return; }
        var wasFull = storageFull;
        storageFull = true;
        if (!wasFull) { emit('storage-full', { key: storageLastKey, message: storageLastError }); }
      } finally {
        notingStorageError = false;
      }
    }

    var prevValues = {};
    var listeners = [];
    var applying = false;
    var started = false;
    var flushTimer = null, reloadTimer = null, reloadPending = false;
    var lastEventAt = {};
    var lastError = '';
    var lastErrorKind = '';
    var lastSyncAt = '';
    var lastSyncMark = null;      /* 컬렉션별 마지막 동기화 시각(tdk.fbLastSync.v1) — 인메모리 사본 */
    var lastSyncTimer = null;
    var fullSyncAt = '';          /* 마지막 「전체 다시 불러오기」 시각 */
    var unsub = null;
    var originals = null;
    var hookTarget = null;

    function basePath() { return 'dojangs/' + dojangId; }

    /* ---------- 델타 구독용 "마지막 동기화 시각" ----------
       · 서버에서 실제로 받은 문서마다 그 컬렉션의 시각을 갱신한다(0.6초 모아 저장).
       · 새로고침하면 이 시각 이후로 바뀐 문서만 구독한다 → 읽기 2,500건 → 0~5건.
       · 「🔄 전체 다시 불러오기」(forceFullSync)는 이 기록을 지워 전체 구독으로 되돌린다. */
    function lastSyncMap() {
      if (!lastSyncMark) { lastSyncMark = readLastSync(storage); }
      return lastSyncMark;
    }
    function saveLastSync() {
      if (lastSyncTimer) { try { clearTimeout(lastSyncTimer); } catch (e) {} lastSyncTimer = null; }
      if (!lastSyncMark) { return false; }
      /* 어댑터가 따로 적어 둔 항목(변경 0건인 컬렉션 등)을 지우지 않도록 디스크 값과 합친다 */
      var disk = readLastSync(storage);
      var merged = {};
      Object.keys(disk).forEach(function (k) { merged[k] = disk[k]; });
      Object.keys(lastSyncMark).forEach(function (k) {
        if (!merged[k] || lastSyncMark[k] > merged[k]) { merged[k] = lastSyncMark[k]; }
      });
      lastSyncMark = merged;
      return writeLastSync(storage, merged);
    }
    function markSynced(coll) {
      if (!coll) { return; }
      var m = lastSyncMap();
      m[coll] = now();
      if (lastSyncTimer) { return; }
      lastSyncTimer = setTimeout(function () { lastSyncTimer = null; saveLastSync(); }, 600);
    }

    /* ---------- 유효 권한 (서버 roles 기준) ----------
       ⚠️ 화면에서 「관리자 PC」를 골라도 그것만으로 관리자 권한이 생기지 않는다.
          실제 Firebase 모드(requireServerRole)에서는 로그인한 uid 의 roles/{uid} 가
          'admin' 일 때만, 그리고 화면 역할이 'admin' 일 때만 관리자로 동작한다.
          (둘 중 하나라도 tablet/미확인이면 더 제한적인 쪽으로 잠긴다) */
    function requireServerRole() {
      return opts.requireServerRole === true || !!(adapter && adapter.mode === 'firestore');
    }
    function effectiveRole() {
      var serverKnown = (verifiedRole === 'admin' || verifiedRole === 'tablet');
      if (serverKnown) {
        return (verifiedRole === 'tablet' || deviceRole === 'tablet') ? 'tablet' : 'admin';
      }
      /* 서버 역할을 확인하지 못했다 → 실제 Firebase 에서는 아무 권한도 주지 않는다 */
      if (requireServerRole()) { return 'none'; }
      /* 모의(연습) 모드: 서버가 없으니 화면에서 고른 역할로 연습한다 */
      return deviceRole;
    }
    function isEffectiveAdmin() { return effectiveRole() === 'admin'; }
    function isEffectiveTablet() { return effectiveRole() === 'tablet'; }

    /* ---------- 태블릿이 올릴 수 있는 곳은 출결(attendanceEvents) 하나뿐 ----------
       firestore.rules 상 태블릿 계정은 attendanceEvents 만 새로 만들 수 있고,
       students · kioskStudents · tuition · counsel · shuttle · coupons · meta 는
       permission-denied 다. 보내 봐야 실패할 항목은 처음부터 큐에 넣지 않는다
       (예전에 쌓여 「대기 N건 · 실패 N」으로 남아 있는 것도 아래에서 정리한다). */
    var TABLET_WRITE_COLL = 'attendanceEvents';
    function pathColl(path) {
      var seg = String(path || '').split('/');
      return seg.length >= 4 ? seg[2] : '';
    }
    function isTabletBlockedPath(path) {
      return effectiveRole() === 'tablet' && pathColl(path) !== TABLET_WRITE_COLL;
    }
    /* 실패 항목 비우기 — 「서버 규칙 거부 등으로 실패한 항목」만 지운다.
       · scope 를 주지 않으면(또는 'blocked') 태블릿이 보낼 수 없는 경로의 failed 만 지운다
         (출결은 나중에 성공할 수 있으므로 남긴다 — 자동 정리용)
       · scope 'all' 이면 화면의 「🗑️ 실패 비우기」 버튼이 부른 것으로, failed 전부를 지운다
       · state 가 'pending' 인 항목(아직 보내지 않은 출결)은 절대 건드리지 않는다 */
    function clearFailed(scope) {
      var eventsOnly = scope !== 'all';
      var removed = outbox.dropWhere(function (it) {
        if (it.state !== 'failed') { return false; }
        if (eventsOnly && pathColl(it.path) === TABLET_WRITE_COLL) { return false; }
        return true;
      });
      var sum = outbox.summary();
      /* 실패가 하나도 남지 않았으면 그 실패 때문에 켜져 있던 경고등도 끈다 → 배지가 🟢 로 돌아온다 */
      if (!sum.failed) { lastError = ''; lastErrorKind = ''; }
      emit('queue-cleared', { removed: removed, failed: sum.failed, queued: outbox.count(), role: effectiveRole() });
      return { ok: true, removed: removed, failed: sum.failed, queued: outbox.count(), role: effectiveRole() };
    }

    /* 화면 역할 변경 — 그래도 유효 권한은 서버 roles 기준 그대로다 */
    function setDeviceRole(r) {
      var next = r === 'tablet' ? 'tablet' : 'admin';
      var before = effectiveRole();
      deviceRole = next;
      var after = effectiveRole();
      if (after !== before) {
        if (adapter && typeof adapter.setRole === 'function') { try { adapter.setRole(after); } catch (e) {} }
        resubscribe();
        emit('role', { role: after, deviceRole: deviceRole, verified: verifiedRole });
        if (after === 'admin') { scheduleUsagePush(1500); }
        if (after === 'tablet') { try { clearFailed(); } catch (e) {} }
      }
      return after;
    }

    /* 서버 roles/{uid} 확인 결과 반영 */
    function applyVerifiedRole(v) {
      var next = (v === 'admin' || v === 'tablet') ? v : '';
      var before = effectiveRole();
      verifiedRole = next;
      var after = effectiveRole();
      if (after !== before) {
        if (adapter && typeof adapter.setRole === 'function') { try { adapter.setRole(after); } catch (e) {} }
        resubscribe();
        emit('role', { role: after, deviceRole: deviceRole, verified: verifiedRole });
        /* 잠겨 있는 동안(역할 미확인)에 기기에서 고친 내용을 역할이 풀리는 순간 한 번 훑는다 */
        if (after === 'admin') { rescanLocal(); scheduleUsagePush(1500); }
        /* 태블릿으로 확인되는 순간, 보낼 수 없는 경로의 실패 항목을 한 번 정리한다 */
        if (after === 'tablet') { try { clearFailed(); } catch (e) {} }
      }
      return after;
    }

    /* ---------- 🧹 태블릿 개인정보 비우기 (등록된 얼굴은 그대로) ----------
       태블릿 화면에 필요한 것은 이름·부서·수업·띠·상태뿐이다.
       · 「출석 태블릿」으로 확인된 기기에서만 실행한다 — 관리자 PC 의 원본을 지우지 않게.
       · tdk.faces.v1(원생 얼굴 특징값)과 Firebase 연결 설정은 절대 건드리지 않는다.
       · 서버(Firestore)에는 아무것도 쓰거나 지우지 않는다 — 이 기기 저장소만 비운다.
         writeValue 를 써서 로컬 변경 감지·전송 큐를 타지 않게 한다(태블릿은 어차피 올릴 수 없다). */
    function scrubTabletPII() {
      var role = effectiveRole();
      if (role !== 'tablet') {
        /* 관리자 PC·역할 미확인 기기에서는 실행하지 않는다 */
        return { ok: false, reason: role === 'admin' ? 'admin-role' : 'role-unverified', role: role };
      }
      var faces = readValue('faces');
      var faceCount = countFaces(faces);
      var students = readValue('students');
      var list = Array.isArray(students) ? students : [];
      var scrubbed = 0;
      var next = list.map(function (s) {
        if (!isPlain(s)) { return s; }
        var had = Object.keys(s).some(function (k) {
          return k.charAt(0) !== '_' && SCRUB_KEEP_FIELDS.indexOf(k) === -1;
        });
        if (had) { scrubbed++; }
        var out = {};
        /* 동기화 메타(_ver·_updatedAt·_fieldMeta …)는 그대로 두고 나머지는 허용 목록만 남긴다 */
        Object.keys(s).forEach(function (k) { if (k.charAt(0) === '_') { out[k] = s[k]; } });
        SCRUB_KEEP_FIELDS.forEach(function (f) { if (hasOwn(s, f)) { out[f] = s[f]; } });
        return out;
      });
      writeValue('students', next);
      var cleared = [];
      SCRUB_CLEAR_NAMES.forEach(function (name) {
        var e = entryByName(name);
        if (!e) { return; }
        writeValue(name, clone(SCRUB_EMPTY[name]));
        cleared.push(e.key);
      });
      /* 개인정보를 비운 김에, 규칙이 거부해 쌓인 「보낼 수 없는」 실패 항목도 함께 정리한다 */
      var queue = { removed: 0, failed: 0, queued: outbox.count() };
      try { queue = clearFailed(); } catch (e) {}
      /* 지운 뒤 남은 얼굴은 100% 그대로 — 한 번 더 세어 돌려준다 */
      var facesAfter = countFaces(readValue('faces'));
      return {
        ok: true,
        role: role,
        students: scrubbed,
        studentsLeft: next.length,
        faces: facesAfter,
        facesBefore: faceCount,
        cleared: cleared,
        failedCleared: queue.removed,
        failedLeft: queue.failed,
        kept: ['tdk.faces.v1', 'tdk.fbConfig.v1', 'tdk.fbDevice.v1', 'tdk.fbState.v1', 'tdk.fbOutbox.v1', 'tdk.fbShadow.v1', 'tdk.fbUsage.v1']
      };
    }

    /* 역할이 풀린 뒤: 지금 기기의 값을 다시 훑어 서버와 다른 문서만 큐에 올린다 */
    function rescanLocal() {
      registry.forEach(function (e) {
        if (e.kind === 'local') { return; }
        try {
          prevValues[e.name] = readValue(e.name);
          capture(e);
        } catch (err) { lastError = errorText(err); }
      });
      if (outbox.count()) { scheduleFlush(); }
    }

    /* 로그인한 계정의 roles/{uid} 문서를 서버에서 직접 읽어 유효 권한을 잠근다 */
    function verifyRole() {
      if (!adapter || typeof adapter.getDoc !== 'function') {
        return Promise.resolve({ role: effectiveRole(), verified: verifiedRole, reason: 'no-adapter' });
      }
      var cu = null;
      try { cu = (typeof adapter.currentUser === 'function') ? adapter.currentUser() : null; } catch (e) { cu = null; }
      if (!cu || !cu.uid) {
        var r0 = applyVerifiedRole('');
        return Promise.resolve({ role: r0, verified: '', reason: 'no-sign-in' });
      }
      var path = basePath() + '/roles/' + String(cu.uid);
      return adapter.getDoc(path).then(function (res) {
        var v = (res && res.exists && res.data) ? String(res.data.role || '') : '';
        var role = applyVerifiedRole(v);
        return { role: role, verified: v, uid: cu.uid, email: cu.email || '', path: path };
      }, function (err) {
        var role = applyVerifiedRole('');
        return { role: role, verified: '', uid: cu.uid, error: errorText(err), path: path };
      });
    }

    function resubscribe() {
      if (!started || !adapter || typeof adapter.subscribe !== 'function') { return; }
      if (unsub) { try { unsub(); } catch (e) {} } unsub = null;
      attachBatchHooks(adapter);
      unsub = adapter.subscribe(function (path, data, meta) {
        try { onRemote(path, data, meta); } catch (e) { lastError = errorText(e); }
      });
    }

    /* ---------- 🔄 전체 다시 불러오기 (수동 · 기기 간 누락이 의심될 때 1회) ----------
       델타 기준 시각(tdk.fbLastSync.v1)을 지우고 구독을 다시 열면,
       다음 구독은 where 조건 없이 전체를 받아 온다. */
    function forceFullSync() {
      if (lastSyncTimer) { try { clearTimeout(lastSyncTimer); } catch (e) {} lastSyncTimer = null; }
      lastSyncMark = {};
      writeLastSync(storage, {});      /* 디스크까지 지운다(합치지 않는다) — 다음 구독은 전체 */
      fullSyncAt = isoOf(now());
      resubscribe();
      emit('full-sync', { at: fullSyncAt, queued: outbox.count(), role: effectiveRole() });
      return { ok: !!adapter, at: fullSyncAt, queued: outbox.count(), role: effectiveRole() };
    }
    function entryByName(n) {
      for (var i = 0; i < registry.length; i++) { if (registry[i].name === n) { return registry[i]; } }
      return null;
    }
    function entryByKey(k) {
      for (var i = 0; i < registry.length; i++) { if (registry[i].key === k) { return registry[i]; } }
      return null;
    }
    function entryByPath(p) {
      /* 경로를 보고 어느 키에 속하는지 — 컬렉션 이름 기준 */
      var seg = String(p).split('/');
      if (seg.length < 4) { return null; }
      var coll = seg[2];
      for (var i = 0; i < registry.length; i++) {
        var e = registry[i];
        if (e.kind === 'local') { continue; }
        if (e.kind === 'object' || e.kind === 'value') {
          if (coll === 'meta' && seg[3] === safeId(e.meta)) { return e; }
        } else if (e.coll === coll) { return e; }
      }
      return null;
    }

    /* ---------- shadow(문서별 마지막으로 아는 상태) ----------
       · 저장: 인메모리에 즉시, IndexedDB(tdk_fb_cache)에 비동기(300ms 모음)
       · localStorage 에는 절대 쓰지 않는다 — 5MB 한도를 잡아먹던 장본인이다  */
    function trimShadow() {
      var keys = Object.keys(shadow);
      if (keys.length <= SHADOW_MAX_ENTRIES) { return; }
      /* 너무 커지면 오래된 출결 문서부터 정리 (원격은 그대로 남아 있음) */
      keys.sort(function (a, b) {
        return String((shadow[a] && shadow[a].u) || '').localeCompare(String((shadow[b] && shadow[b].u) || ''));
      }).slice(0, keys.length - SHADOW_MAX_ENTRIES).forEach(function (k) { delete shadow[k]; });
    }

    /* 버전(_ver)이 높은 쪽을 남긴다 — 인메모리에 이미 seedShadow 가 채운 값(v0)이 있을 수 있다 */
    function mergeShadowInto(target, extra) {
      if (!isPlain(extra)) { return 0; }
      var taken = 0;
      Object.keys(extra).forEach(function (p) {
        var e = extra[p];
        if (!isPlain(e)) { return; }
        var cur = target[p];
        if (!cur) { target[p] = e; taken++; return; }
        if (num(e.v) > num(cur.v)) { target[p] = e; taken++; }
      });
      return taken;
    }

    function readLegacyShadow() {
      var raw = null;
      try { raw = storage.getItem(SHADOW_LS_KEY); } catch (e) { raw = null; }
      if (raw == null) { return null; }
      var s = null;
      try { s = JSON.parse(raw); } catch (e) { s = null; }
      return isPlain(s) ? s : {};
    }

    function openShadowDb() {
      if (idbDb) { return Promise.resolve(idbDb); }
      if (idbOpenPromise) { return idbOpenPromise; }
      var f = idbFactory();
      if (!f) { return Promise.reject(new Error('indexedDB 없음')); }
      idbOpenPromise = new Promise(function (resolve, reject) {
        var settled = false;
        function fail(err) {
          if (settled) { return; }
          settled = true;
          idbOpenPromise = null;
          idbDisabled = true;
          reject(err || new Error('indexedDB 열기 실패'));
        }
        function ok(db) {
          if (settled) { return; }
          settled = true;
          idbDb = db;
          resolve(db);
        }
        var req;
        try { req = f.open(IDB_NAME, 1); } catch (e) { fail(e); return; }
        req.onupgradeneeded = function () {
          try {
            var db = req.result;
            if (db && db.objectStoreNames && !db.objectStoreNames.contains(IDB_STORE)) { db.createObjectStore(IDB_STORE); }
          } catch (e) {}
        };
        req.onsuccess = function () { ok(req.result); };
        req.onerror = function () { fail(req.error); };
        req.onblocked = function () { fail(new Error('indexedDB 차단됨')); };
        /* 사생활 보호 모드처럼 응답이 없는 경우 — 그림자 없이(인메모리로) 계속 간다 */
        try { setTimeout(function () { fail(new Error('indexedDB 응답 없음')); }, SHADOW_OPEN_TIMEOUT_MS); } catch (e) {}
      });
      return idbOpenPromise;
    }

    function idbReadShadow() {
      if (idbDisabled || !idbSupported()) { return Promise.resolve(null); }
      return openShadowDb().then(function (db) {
        return new Promise(function (resolve, reject) {
          var req;
          try {
            var tx = db.transaction(IDB_STORE, 'readonly');
            req = tx.objectStore(IDB_STORE).get(IDB_SHADOW_ITEM);
          } catch (e) { reject(e); return; }
          req.onsuccess = function () {
            var v = req.result;
            if (typeof v === 'string' || isPlain(v)) { resolve(v); return; }
            resolve(null);
          };
          req.onerror = function () { reject(req.error); };
        });
      });
    }

    function idbWriteShadow(json) {
      if (idbDisabled || !idbSupported()) { return Promise.resolve(false); }
      return openShadowDb().then(function (db) {
        return new Promise(function (resolve, reject) {
          var settled = false;
          function finish(ok, err) {
            if (settled) { return; }
            settled = true;
            if (ok) { resolve(true); } else { reject(err); }
          }
          try {
            var tx = db.transaction(IDB_STORE, 'readwrite');
            var req = tx.objectStore(IDB_STORE).put(json, IDB_SHADOW_ITEM);
            req.onsuccess = function () { finish(true); };
            req.onerror = function () { finish(false, req.error); };
            tx.oncomplete = function () { finish(true); };
            tx.onerror = function () { finish(false, tx.error); };
            tx.onabort = function () { finish(false, tx.error); };
          } catch (e) { finish(false, e); }
        });
      });
    }

    /* 지금 그림자를 IndexedDB 에 바로 쓴다 (모아 둔 예약은 취소) */
    function flushShadowPersist() {
      if (shadowSaveTimer) { try { clearTimeout(shadowSaveTimer); } catch (e) {} shadowSaveTimer = null; }
      if (!shadowDirty) { return Promise.resolve(false); }
      if (idbDisabled || !idbSupported()) {
        /* IndexedDB 가 없으면 인메모리만으로 동작한다 (Node·QuickJS 테스트) */
        shadowDirty = false;
        return Promise.resolve(false);
      }
      /* 저장 중이면 그 저장이 끝난 뒤에 다시 시도한다 */
      if (shadowWriting) {
        return Promise.resolve(shadowWritePromise).then(function () { return flushShadowPersist(); });
      }
      var json = null;
      try { json = JSON.stringify(shadow); } catch (e) { json = null; }
      shadowDirty = false;
      if (json == null) { return Promise.resolve(false); }
      shadowWriting = true;
      var p = idbWriteShadow(json).then(function () {
        shadowWriting = false;
        shadowWriteFails = 0;
        if (shadowDirty) { return flushShadowPersist(); }   /* 쓰는 사이 또 바뀌었으면 이어서 */
        return true;
      }, function (err) {
        shadowWriting = false;
        shadowDirty = true;               /* 다음 저장 때 다시 시도 */
        shadowWriteFails++;
        if (shadowWriteFails >= 3) { idbDisabled = true; }
        try {
          console.warn('[TDK 동기화] 그림자를 IndexedDB 에 저장하지 못했습니다 — 이번 실행은 메모리로 계속합니다 (' +
            String((err && (err.name || err.message)) || err) + ')');
        } catch (e) {}
        return false;
      });
      shadowWritePromise = p;
      return p;
    }

    function scheduleShadowPersist() {
      shadowDirty = true;
      if (!idbSupported() || idbDisabled) { return; }
      if (shadowSaveTimer) { return; }
      try {
        shadowSaveTimer = setTimeout(function () { shadowSaveTimer = null; flushShadowPersist(); }, SHADOW_PERSIST_MS);
      } catch (e) { shadowSaveTimer = null; }
    }

    function saveShadow() {
      trimShadow();
      scheduleShadowPersist();
    }

    /* 부팅: 옛 localStorage 그림자 + IndexedDB 그림자를 메모리로 합치고 localStorage 를 비운다 */
    function finishShadowHydration(storedRaw, legacyCount) {
      if (shadowLoaded) { return; }
      var stored = null;
      if (typeof storedRaw === 'string') { try { stored = JSON.parse(storedRaw); } catch (e) { stored = null; } }
      else if (isPlain(storedRaw)) { stored = storedRaw; }
      var storedCount = mergeShadowInto(shadow, stored);
      var hadLegacy = false;
      try { hadLegacy = storage.getItem(SHADOW_LS_KEY) != null; } catch (e) { hadLegacy = false; }
      if (hadLegacy) {
        /* 옮긴 뒤 즉시 지운다 — localStorage 5MB 한도를 바로 비운다 */
        try { rawRemove(SHADOW_LS_KEY); } catch (e) { try { storage.removeItem(SHADOW_LS_KEY); } catch (e2) {} }
        shadowDirty = true;
        flushShadowPersist();
      }
      shadowLoaded = true;
      runQueuedCaptures();
      if (hadLegacy) {
        emit('shadow-migrated', {
          entries: Object.keys(shadow).length, legacy: legacyCount, cache: storedCount,
          backend: (idbSupported() && !idbDisabled) ? 'indexeddb' : 'memory'
        });
      }
      if (shadowReadyResolve) {
        shadowReadyResolve({
          loaded: true, entries: Object.keys(shadow).length,
          backend: (idbSupported() && !idbDisabled) ? 'indexeddb' : 'memory',
          fromLocalStorage: hadLegacy, fromCache: storedCount
        });
        shadowReadyResolve = null;
      }
    }

    function hydrateShadow() {
      var legacy = readLegacyShadow();
      var legacyCount = mergeShadowInto(shadow, legacy);
      if (!idbSupported() || idbDisabled) {
        /* IndexedDB 없는 환경: 옛 localStorage 값만 옮기고 바로 준비 완료 */
        finishShadowHydration(null, legacyCount);
        return shadowReadyPromise;
      }
      idbReadShadow().then(function (v) {
        finishShadowHydration(v, legacyCount);
      }, function () {
        finishShadowHydration(null, legacyCount);
      });
      return shadowReadyPromise;
    }

    /* 그림자를 읽기 전에 들어온 변경은 잠시 모아 두었다가 읽은 뒤 차례로 처리한다
       (빈 그림자로 v1 을 만들어 서버의 높은 버전을 덮어쓰는 일을 막는다) */
    function runQueuedCaptures() {
      var names = Object.keys(queuedCaptures);
      queuedCaptures = {};
      names.forEach(function (n) {
        var e = entryByName(n);
        if (!e) { return; }
        try { capture(e); } catch (err) { lastError = errorText(err); }
      });
      if (names.length && outbox.count()) { scheduleFlush(); }
    }
    function shadowDoc(path) {
      var s = shadow[path];
      if (!s) { return null; }
      var doc = {
        _ver: num(s.v), _updatedAt: s.u || '', _updatedBy: s.by || '',
        _fieldMeta: s.m || null, _deleted: !!s.d
      };
      if (s.b) {
        var body = clone(s.b) || {};
        Object.keys(body).forEach(function (k) { if (k.charAt(0) === '_') { delete body[k]; } });
        for (var k2 in body) { if (hasOwn(body, k2)) { doc[k2] = body[k2]; } }
      } else if (s.t !== undefined) {
        doc.time = s.t;
      }
      return doc;
    }
    /* ---------- 저장소 감시 ---------- */
    function attach(storageObj) {
      if (!storageObj) { return false; }
      if (typeof storageObj.setItem !== 'function') { return false; }
      var proto = null;
      try {
        if (root.Storage && root.Storage.prototype && Object.getPrototypeOf(storageObj) === root.Storage.prototype) {
          proto = root.Storage.prototype;
          hookTarget = 'prototype';
        }
      } catch (e) { proto = null; }
      if (proto) {
        if (proto.__tdkfbHooked) { originals = proto.__tdkfbOrig; return true; }
        originals = { set: proto.setItem, remove: proto.removeItem, clear: proto.clear };
        proto.setItem = function (k, v) {
          var r = originals.set.apply(this, arguments);
          try { handleWrite(String(k), String(v)); } catch (e) {}
          return r;
        };
        proto.removeItem = function (k) {
          var r = originals.remove.apply(this, arguments);
          try { handleWrite(String(k), null); } catch (e) {}
          return r;
        };
        proto.clear = function () {
          var r = originals.clear.apply(this, arguments);
          try { emit('cleared', {}); } catch (e) {}
          return r;
        };
        proto.__tdkfbHooked = true;
        proto.__tdkfbOrig = originals;
        return true;
      }
      /* 일반 객체(테스트용 메모리 저장소)는 객체 자체를 감싼다 */
      if (storageObj.__tdkfbHooked) { originals = storageObj.__tdkfbOrig; return true; }
      var origSet = storageObj.setItem;
      var origRemove = storageObj.removeItem;
      originals = { set: origSet, remove: origRemove, clear: storageObj.clear };
      storageObj.setItem = function (k, v) {
        var r = origSet.apply(storageObj, arguments);
        try { handleWrite(String(k), String(v)); } catch (e) {}
        return r;
      };
      storageObj.removeItem = function (k) {
        var r = origRemove.apply(storageObj, arguments);
        try { handleWrite(String(k), null); } catch (e) {}
        return r;
      };
      storageObj.__tdkfbHooked = true;
      storageObj.__tdkfbOrig = originals;
      return true;
    }
    function rawSet(k, v) {
      /* 저장 실패(한도 초과)는 던지지 않고 false 로 알린다 — 앱·동기화를 멈추지 않는다 */
      try {
        if (originals && originals.set) { originals.set.call(storage, k, v); return true; }
        storage.setItem(k, v);
        return true;
      } catch (err) {
        noteStorageError(err, k);
        return false;
      }
    }
    function rawRemove(k) {
      if (originals && originals.remove) { originals.remove.call(storage, k); return; }
      storage.removeItem(k);
    }

    /* ---------- 값 읽기/쓰기 ----------
       ⚡ 한꺼번에 들어오는 원격 문서(2,500건)를 처리할 때는 문서 1건마다
          JSON.parse + JSON.stringify + localStorage.setItem 을 하면 PC가 심하게 버벅인다.
          beginRemoteBatch() ~ endRemoteBatch() 사이에는 값은 메모리(remoteMem)에서 읽고
          수정하고, dirty 로 표시만 해 두었다가 마지막에 키당 딱 1번만 setItem 한다.
          → 읽기·직렬화·저장 모두 키당 1~2회로 줄고, 화면도 한 번만 다시 그린다. */
    var remoteDepth = 0;
    var remoteMem = {};
    var remoteDirty = {};
    var batchRemoteCount = 0;    /* 묶음 동안 화면에 알릴 원격 변경 건수 */

    function beginRemoteBatch() { remoteDepth++; return remoteDepth; }
    /* 모아 둔 키를 지금 한 번에 저장한다 — 테스트·동기 확인용으로 직접 불러도 된다 */
    function flushLocalWrites() {
      var names = Object.keys(remoteDirty);
      if (!names.length) { if (remoteDepth <= 0) { remoteMem = {}; } return 0; }
      remoteDirty = {};
      var was = applying;
      applying = true;
      var wrote = 0;
      try {
        names.forEach(function (name) {
          var e = entryByName(name);
          if (!e) { return; }
          var raw = 'null';
          try { raw = JSON.stringify(hasOwn(remoteMem, name) ? remoteMem[name] : null); } catch (err) { return; }
          try { if (rawSet(e.key, raw)) { wrote++; } } catch (err) {}
        });
      } finally { applying = was; }
      if (remoteDepth <= 0) { remoteMem = {}; }
      return wrote;
    }

    function endRemoteBatch() {
      if (remoteDepth > 0) { remoteDepth--; }
      if (remoteDepth > 0) { return 0; }
      var wrote = flushLocalWrites();
      /* 묶음 동안 모아 둔 화면 알림은 마지막에 딱 1번 — 2,500번 다시 그리지 않는다 */
      if (batchRemoteCount) {
        var n = batchRemoteCount;
        batchRemoteCount = 0;
        emit('remote', { batch: true, count: n });
      }
      return wrote;
    }

    function readValue(name) {
      var e = entryByName(name);
      if (!e) { return null; }
      if (remoteDepth > 0 && hasOwn(remoteMem, name)) { return remoteMem[name]; }
      var raw = null;
      try { raw = storage.getItem(e.key); } catch (err) { raw = null; }
      var value = null;
      if (raw != null) {
        try { value = JSON.parse(raw); } catch (err) { value = null; }
      }
      if (remoteDepth > 0) { remoteMem[name] = value; }
      return value;
    }
    function writeValue(name, value) {
      var e = entryByName(name);
      if (!e) { return false; }
      if (remoteDepth > 0) {
        /* 묶음 처리 중 — 메모리에만 두고 나중에 한 번에 저장 */
        remoteMem[name] = value;
        remoteDirty[name] = true;
        prevValues[name] = value;
        return true;
      }
      var was = applying;
      applying = true;
      var ok = false;
      try { ok = rawSet(e.key, JSON.stringify(value)); } catch (err) { ok = false; }
      applying = was;
      prevValues[name] = value;
      return ok;
    }

    /* ---------- 로컬 변경 감지 ---------- */
    function handleWrite(key, rawValue) {
      if (applying) { return; }
      if (LOCAL_KEYS[key]) { return; }
      var entry = entryByKey(key);
      if (!entry || entry.kind === 'local') { return; }
      /* 관리자로 확인된 기기만 원생·원비·상담·설정을 올린다.
         태블릿(또는 서버 역할 미확인)은 출결 이벤트만 올린다. */
      var er = effectiveRole();
      if (er !== 'admin' && entry.kind !== 'events') {
        emit('blocked-local', { key: entry.name, reason: er === 'tablet' ? 'tablet-role' : 'role-unverified' });
        return;
      }
      var value = null;
      if (rawValue != null) { try { value = JSON.parse(rawValue); } catch (e) { value = null; } }
      prevValues[entry.name] = value;
      if (!shadowLoaded) {
        /* 그림자를 읽어 오기 전이면 잠시 모아 두었다가 읽은 뒤 차례로 처리한다 */
        queuedCaptures[entry.name] = 1;
        return;
      }
      capture(entry);
      scheduleFlush();
    }

    /* 이 키에서 자동으로 따라 만들어지는 문서(파생 사본)의 목록 */
    function derivedEntriesOf(name) {
      return registry.filter(function (e) { return e.derivedFrom === name; });
    }
    function liveDocsOf(entry, base) {
      if (entry.kind === 'events') {
        var map = unionEventDocs(readValue('attendance'), readValue('records'), base, { deviceId: deviceId });
        return Object.keys(map).map(function (p) { return map[p]; });
      }
      /* 파생 항목은 원본 키를 그대로 쓴다 — 방금 저장된 값이 있으면 그것으로 만든다 */
      var value;
      if (entry.derivedFrom) {
        value = (prevValues[entry.derivedFrom] !== undefined) ? prevValues[entry.derivedFrom] : readValue(entry.name);
      } else {
        value = prevValues[entry.name];
      }
      return docsForEntry(entry, value, base, { deviceId: deviceId });
    }

    function capture(entry) {
      /* 태블릿은 출결(attendanceEvents)만 올린다 — 그 밖의 원생·원비·상담·차량·설정은
         규칙이 거부하므로 큐에 넣지도, 그림자를 앞지르지도 않는다 */
      if (effectiveRole() === 'tablet' && entry.kind !== 'events') {
        emit('blocked-local', { key: entry.name, reason: 'tablet-role' });
        return;
      }
      var base = basePath();
      var changes = [];
      var live = {};
      /* 원본(students/settings) + 파생 사본(kioskStudents/kioskConfig)을 함께 만든다 */
      var sources = [entry].concat(derivedEntriesOf(entry.name));

      sources.forEach(function (src) {
        liveDocsOf(src, base).forEach(function (d) { live[d.path] = { doc: d, entry: src }; });
      });

      Object.keys(live).forEach(function (p) {
        var d = live[p].doc;
        var src = live[p].entry;
        var body = clone(d.body) || {};
        var h = bodyHash(src.kind, body);
        var sh = shadow[p];
        if (sh && !sh.d && sh.h === h) { return; }          /* 내용이 그대로 → 보내지 않음 */
        if (src.kind === 'events') {
          var dup = duplicateEvent(p, body);
          if (dup) { return; }
        }
        var prevBody = sh && sh.b ? sh.b : {};
        var meta = stampFields(prevBody, sh ? sh.m : {}, body, { at: isoOf(now()), by: deviceId });
        var ver = (sh ? num(sh.v) : 0) + 1;
        var doc = valueFields(body);
        doc._ver = ver;
        doc._updatedAt = isoOf(now());
        doc._updatedBy = deviceId;
        doc._fieldMeta = meta;
        shadow[p] = {
          v: ver, m: meta, u: doc._updatedAt, by: deviceId, h: h, d: false,
          b: src.kind === 'events' ? null : mergeMetaBody(body, meta),
          t: body.time
        };
        changes.push({ path: p, body: doc, entry: src.name });
      });

      /* 사라진 문서 → 삭제 표시(툼스톤) */
      var prefixOf = function (e) {
        if (e.kind === 'object' || e.kind === 'value') { return base + '/meta/' + safeId(e.meta); }
        return base + '/' + e.coll;
      };
      var prefixes = sources.map(prefixOf);
      var underAny = function (p) {
        for (var i = 0; i < prefixes.length; i++) {
          if (p === prefixes[i] || p.indexOf(prefixes[i] + '/') === 0) { return true; }
        }
        return false;
      };
      Object.keys(shadow).forEach(function (p) {
        if (!underAny(p)) { return; }
        if (live[p]) { return; }
        var sh2 = shadow[p];
        if (!sh2 || sh2.d) { return; }
        var ver2 = num(sh2.v) + 1;
        var at2 = isoOf(now());
        shadow[p] = { v: ver2, m: {}, u: at2, by: deviceId, h: '', d: true, b: null, t: undefined };
        changes.push({
          path: p,
          body: { _deleted: true, _ver: ver2, _updatedAt: at2, _updatedBy: deviceId }
        });
      });

      if (changes.length) {
        saveShadow();
        changes.forEach(function (c) {
          /* 보낼 수 없는 경로는 큐에 넣지 않는다 (태블릿 = 출결만) */
          if (isTabletBlockedPath(c.path)) {
            emit('blocked-local', { key: entry.name, reason: 'tablet-role' });
            return;
          }
          outbox.enqueue({ path: c.path, body: c.body });
        });
        emit('captured', { key: entry.name, count: changes.length });
      }
    }

    /* 같은 출결을 아주 짧은 사이에 두 번 찍었을 때의 보조 차단 */
    function duplicateEvent(path, body) {
      var m = parseEventId(path.split('/').pop());
      if (!m) { return false; }
      var k = m.date + '|' + m.studentId + '|' + m.kind;
      var last = lastEventAt[k];
      lastEventAt[k] = now();
      if (!last) { return false; }
      if (now() - last < DUPLICATE_WINDOW_MS) {
        var sh = shadow[path];
        if (sh && !sh.d && String(sh.t || '') === String(body.time || '')) { return true; }
      }
      return false;
    }

    /* ---------- 원격 변경 반영 ---------- */
    /* 여러 문서가 한꺼번에 오면 localStorage 반영은 바로, 화면 갱신은 한 번만 */
    function scheduleReload() {
      reloadPending = true;
      if (reloadTimer) { return; }
      reloadTimer = setTimeout(function () {
        reloadTimer = null;
        if (!reloadPending) { return; }
        reloadPending = false;
        reloadApp();
        emit('applied', {});
      }, opts.refreshMs || REFRESH_MS);
    }
    function flushReload() {
      if (reloadTimer) { clearTimeout(reloadTimer); reloadTimer = null; }
      if (!reloadPending) { return false; }
      reloadPending = false;
      reloadApp();
      emit('applied', {});
      return true;
    }

    /* 원격 문서 수신 */
    function onRemote(path, data, meta) {
      /* 기기별 사용량 합산 문서 — 화면 합산에만 쓰고, 이 수신 때문에 되쓰지 않는다(무한 쓰기 방지) */
      if (path === usageMetaPath()) { onRemoteUsage(data); return; }
      if (!entryByPath(path)) { return; }
      /* 캐시에서 온 스냅샷(fromCache)은 서버 읽기가 아니다 — 계량기에 넣지 않는다.
         실제 서버에서 읽은 문서만 무료 한도(읽기 5만/일)를 쓴다. */
      var fromCache = !!(meta && meta.fromCache === true);
      if (!fromCache) { usage.record('reads', 1); }
      var remoteDoc = {};
      if (isPlain(data)) {
        Object.keys(data).forEach(function (k) { remoteDoc[k] = data[k]; });
      } else {
        remoteDoc._deleted = true;
        remoteDoc._ver = num(meta && meta.ver) + 1;
      }
      var localSh = shadow[path];
      var localDoc = null;
      if (localSh) {
        localDoc = {
          _ver: num(localSh.v), _updatedAt: localSh.u || '', _updatedBy: localSh.by || '',
          _fieldMeta: localSh.m || null, _deleted: !!localSh.d
        };
        if (localSh.b) {
          var lb = valueFields(localSh.b);
          Object.keys(lb).forEach(function (k) { localDoc[k] = lb[k]; });
        } else if (localSh.t !== undefined) {
          localDoc.time = localSh.t;
        }
      }
      var entry = entryByPath(path);
      var merged = mergeDocs(localDoc, remoteDoc, { arrayUnion: !!entry.union });
      var kind = entry.kind;
      var mergedBody = merged.deleted ? {} : (merged.body || {});
      var remoteBody = remoteDoc._deleted ? {} : docBody(remoteDoc);

      var localBody = {};
      if (localDoc && !localDoc._deleted) { localBody = docBody(localDoc); }

      var needLocal;
      if (merged.deleted) { needLocal = !(localSh && localSh.d); }
      else if (kind === 'events') { needLocal = eventHash(mergedBody) !== String((localSh && localSh.h) || ''); }
      else { needLocal = stableStringify(mergedBody) !== stableStringify(localBody); }
      /* kioskStudents/kioskConfig 사본은 태블릿 화면용이다 — 관리자 PC는 원본을 그대로 쓴다 */
      if (kind === 'kiosk' && !isEffectiveTablet()) { needLocal = false; }
      var needRemote = merged.deleted ? !remoteDoc._deleted : stableStringify(mergedBody) !== stableStringify(remoteBody);

      if (needLocal) {
        applyRemoteDoc(path, entry, merged);
        scheduleReload();
        emit('remote', { path: path, key: entry.name });
      }
      if (needRemote) {
        /* 태블릿은 출결 외 경로를 보낼 수 없다 — 큐에 쌓아 두면 영원히 실패로 남는다 */
        if (isTabletBlockedPath(path)) {
          emit('blocked-local', { key: entry.name, reason: 'tablet-role' });
          updateShadowFromMerged(path, merged, kind, null);
        } else {
          /* 내 쪽이 더 최신인 필드가 있어 합친 결과를 되돌려 보낸다 → 양쪽이 같은 값으로 수렴 */
          var body = bodyWithMeta(mergedBody, merged.meta);
          body._ver = num(merged.ver) + 1;
          body._updatedAt = isoOf(now());
          body._updatedBy = deviceId;
          if (merged.deleted) { body = { _deleted: true, _ver: body._ver, _updatedAt: body._updatedAt, _updatedBy: deviceId }; }
          updateShadowFromMerged(path, merged, kind, body);
          outbox.enqueue({ path: path, body: body });
          scheduleFlush();
        }
      } else {
        updateShadowFromMerged(path, merged, kind, null);
      }
      /* 다른 기기가 찍은 출결이 도착하면 알린다 — 관리자 PC가 보호자 문자를 대신 보내는 데 쓴다 */
      if (kind === 'events' && !merged.deleted) {
        var by = String(remoteDoc._updatedBy || '');
        if (by && by !== deviceId) {
          emit('remote-event', {
            path: path,
            date: String(mergedBody.date || ''),
            studentId: String(mergedBody.studentId || ''),
            eventKind: String(mergedBody.kind || ''),
            time: String(mergedBody.time || ''),
            by: by,
            updatedAt: String(remoteDoc._updatedAt || '')
          });
        }
      }
      lastSyncAt = isoOf(now());
      /* 서버에서 실제로 받은 문서 → 그 컬렉션의 델타 기준 시각을 지금으로 */
      if (!fromCache) {
        var entryColl = pathColl(path);
        if (entryColl) { markSynced(entryColl); }
      }
    }

    function bodyWithMeta(body, meta) {
      return mergeMetaBody(valueFields(body), meta || {});
    }
    function mergeMetaBody(body, meta) {
      var out = clone(body) || {};
      out._fieldMeta = clone(meta || {});
      return out;
    }

    function updateShadowFromMerged(path, merged, kind, sentBody) {
      var body = merged.deleted ? {} : (merged.body || {});
      var flat = flatten(sentBody || body);
      shadow[path] = {
        v: num(merged.ver) + (sentBody ? 1 : 0),
        m: merged.meta || {},
        u: (sentBody && sentBody._updatedAt) || merged.updatedAt || isoOf(now()),
        by: (sentBody && sentBody._updatedBy) || merged.updatedBy || deviceId,
        d: merged.deleted === true,
        h: bodyHash(kind, body),
        b: merged.deleted ? null : (kind === 'events' ? null : mergeMetaBody(body, merged.meta)),
        t: merged.deleted ? undefined : body.time
      };
      saveShadow();
    }

    /* 원격에서 온 문서를 실제 localStorage 값에 반영 (로컬 쓰기로 잡히지 않게 applying 사용) */
    function applyRemoteDoc(path, entry, merged) {
      var base = basePath();
      var deleted = merged.deleted === true;
      var body = merged.body || {};
      var seg = String(path).split('/');
      var docKey = seg[seg.length - 1];

      /* kioskStudents 사본 — 태블릿 화면이 읽는 최소 정보만 이 기기의 원생 명단에 반영한다 */
      if (entry.kind === 'kiosk') {
        if (!isEffectiveTablet()) { return; }          /* 관리자 PC 는 원본 students 를 그대로 쓴다 */
        var list = readValue('students');
        if (!Array.isArray(list)) { list = []; }
        var at = -1;
        for (var q = 0; q < list.length; q++) {
          if (list[q] && safeId(list[q].id) === docKey) { at = q; break; }
        }
        if (deleted) {
          if (at >= 0) { list.splice(at, 1); writeValue('students', list); }
          return;
        }
        var min = kioskStudentBody(body) || {};
        var nextItem = {};
        if (at >= 0) { nextItem = clone(list[at]) || {}; }   /* 원래 있던 칸은 지우지 않는다 */
        KIOSK_FIELDS.forEach(function (f) { if (hasOwn(min, f)) { nextItem[f] = min[f]; } });
        if (at >= 0) { list[at] = nextItem; } else { list.push(nextItem); }
        writeValue('students', list);
        return;
      }

      if (entry.kind === 'docs') {
        var arr = readValue(entry.name);
        if (!Array.isArray(arr)) { arr = []; }
        var idx = -1;
        for (var i = 0; i < arr.length; i++) {
          if (arr[i] && safeId(arr[i].id) === docKey) { idx = i; break; }
        }
        if (deleted) {
          if (idx >= 0) { arr.splice(idx, 1); writeValue(entry.name, arr); }
        } else {
          var item = clone(body) || {};
          if (idx >= 0) { arr[idx] = item; } else { arr.push(item); }
          writeValue(entry.name, arr);
        }
        return;
      }

      if (entry.kind === 'events') {
        var m = parseEventId(docKey);
        if (!m) { return; }
        var att = readValue('attendance');
        if (!isPlain(att)) { att = {}; }
        var rec = readValue('records');
        if (!isPlain(rec)) { rec = {}; }
        var day = isPlain(att[m.date]) ? att[m.date] : {};
        var e = isPlain(day[m.studentId]) ? day[m.studentId] : {};
        var time = deleted ? '' : String(body.time || '').slice(0, 5);
        if (m.kind === 'in') { if (time) { e.inTime = time; } else { delete e.inTime; } }
        else { if (time) { e.outTime = time; } else { delete e.outTime; } }
        if (!deleted && body.manual) { e.manual = true; }
        var srcVal = body.source || body.src;          /* source = v3 칸, src = v2 문서 호환 */
        if (srcVal) { e.src = String(srcVal); }
        e.updatedAt = isoOf(now());
        if (e.inTime || e.outTime || e.manual) {
          day[m.studentId] = e;
          att[m.date] = day;
        } else {
          delete day[m.studentId];
          if (Object.keys(day).length) { att[m.date] = day; } else { delete att[m.date]; }
        }
        /* 구버전 records 키도 같은 내용으로 맞춘다 */
        var rd = isPlain(rec[m.date]) ? rec[m.date] : {};
        var r = isPlain(rd[m.studentId]) ? rd[m.studentId] : { in: null, out: null };
        if (m.kind === 'in') { r.in = time || null; } else { r.out = time || null; }
        if (!deleted && body.manual) { r.manual = true; }
        if (r.in || r.out || r.manual) {
          rd[m.studentId] = r;
          rec[m.date] = rd;
        } else {
          delete rd[m.studentId];
          if (Object.keys(rd).length) { rec[m.date] = rd; } else { delete rec[m.date]; }
        }
        writeValue('attendance', att);
        writeValue('records', rec);
        return;
      }

      if (entry.kind === 'tuition') {
        var tui = readValue('tuition');
        if (!isPlain(tui)) { tui = {}; }
        var us = docKey.lastIndexOf('_');
        if (us <= 0) { return; }
        var mk = docKey.slice(0, us), sid = docKey.slice(us + 1);
        var month = isPlain(tui[mk]) ? tui[mk] : {};
        if (deleted) {
          delete month[sid];
          if (Object.keys(month).length) { tui[mk] = month; } else { delete tui[mk]; }
        } else {
          month[sid] = clone(body) || {};
          tui[mk] = month;
        }
        writeValue('tuition', tui);
        return;
      }

      if (entry.kind === 'object') {
        var cur = readValue(entry.name);
        var next = deleted ? {} : (clone(body) || {});
        if (!deleted && isPlain(cur) && isPlain(body)) {
          /* 병합 결과에 없는 필드는 기존 값 유지 */
          Object.keys(cur).forEach(function (k) { if (k.charAt(0) !== '_' && !hasOwn(next, k)) { next[k] = cur[k]; } });
        }
        writeValue(entry.name, next);
        return;
      }

      if (entry.kind === 'value') {
        var v = deleted ? null : (hasOwn(body, '_value') ? body._value : body);
        if (entry.union && Array.isArray(v)) {
          var curArr = readValue(entry.name);
          if (Array.isArray(curArr)) { v = unionArrays(curArr, v, true); }
          if (entry.name === 'logs') {
            v = v.slice().sort(function (a, b) {
              return String((b && b.at) || '').localeCompare(String((a && a.at) || ''));
            }).slice(0, 200);
          }
        }
        writeValue(entry.name, v);
        return;
      }
    }

    /* ---------- 앱 화면 갱신 ---------- */
    function reloadApp() {
      var hook = opts.reload;
      if (typeof hook !== 'function' && root.__tdk && root.__tdk.sync && typeof root.__tdk.sync.reload === 'function') {
        hook = root.__tdk.sync.reload;
      }
      if (typeof hook === 'function') {
        try { hook(); } catch (e) { lastError = errorText(e); }
      }
      try {
        if (typeof root.dispatchEvent === 'function' && typeof root.CustomEvent === 'function') {
          root.dispatchEvent(new root.CustomEvent('tdkfb:changed'));
        }
      } catch (e) {}
    }

    /* ---------- 전송 ---------- */
    function scheduleFlush() {
      if (opts.autoflush === false) { return; }
      if (flushTimer) { return; }
      flushTimer = setTimeout(function () {
        flushTimer = null;
        flush().then(function () {}, function () {});
      }, opts.flushMs || 700);
    }

    function online() {
      try {
        if (root.navigator && root.navigator.onLine === false) { return false; }
      } catch (e) {}
      return true;
    }

    /* 삭제도 "삭제 표시 문서(_deleted)"로 남긴다 — 오프라인이던 기기도 삭제 사실을 받아야 하므로 */
    function opOf(item) {
      if (item.del === true) { return { path: item.path, del: true }; }
      return { path: item.path, body: item.body, merge: true };
    }

    function flush() {
      if (!adapter) { return Promise.resolve({ ok: false, reason: 'no-adapter', queued: outbox.count() }); }
      /* 서버 roles 로 역할이 확인되지 않은 상태(로그인 전·roles 문서 없음)에서는 서버로 아무것도 보내지 않는다 */
      if (effectiveRole() === 'none') {
        emit('role-blocked', { role: 'none', deviceRole: deviceRole, verified: verifiedRole, queued: outbox.count() });
        return Promise.resolve({ ok: false, reason: 'role-unverified', queued: outbox.count() });
      }
      if (!online()) {
        lastErrorKind = 'offline';
        emit('status', { state: 'offline', queued: outbox.count() });
        return Promise.resolve({ ok: false, reason: 'offline', queued: outbox.count() });
      }
      if (usage.blocked()) {
        var snap = usage.snapshot();
        emit('quota-blocked', snap);
        return Promise.resolve({ ok: false, reason: 'quota', blocked: true, queued: outbox.count(), usage: snap });
      }
      var items = outbox.pending();
      if (!items.length) { return Promise.resolve({ ok: true, sent: 0 }); }

      var batches = [];
      for (var i = 0; i < items.length; i += SPARK.maxBatch) { batches.push(items.slice(i, i + SPARK.maxBatch)); }
      var sentTotal = 0;
      var failedErr = null;

      function runBatch(bi) {
        if (bi >= batches.length) { return Promise.resolve(); }
        var batch = batches[bi];
        var writes = 0, deletes = 0;
        batch.forEach(function (it) {
          if (it.del === true) { deletes++; } else { writes++; }
        });
        return adapter.writeBatch(batch.map(opOf)).then(function () {
          usage.record('writes', writes);
          usage.record('deletes', deletes);
          sentTotal += batch.length;
          return runBatch(bi + 1);
        });
      }

      return runBatch(0).then(function () {
        /* setDoc/writeBatch 성공만으로는 부족 — 서버 저장 확인(ACK)까지 기다린 뒤 큐에서 지운다 */
        var ack = (adapter && typeof adapter.acknowledge === 'function') ? adapter.acknowledge() : true;
        return Promise.resolve(ack).then(function () {
          outbox.remove(items.map(function (it) { return it.id; }));
          lastSyncAt = isoOf(now());
          lastError = '';
          lastErrorKind = '';
          emit('synced', { sent: sentTotal, at: lastSyncAt });
          return { ok: true, sent: sentTotal, queued: outbox.count() };
        }, function (err) {
          outbox.mark(items.map(function (it) { return it.id; }), 'sent-unacked', err);
          lastError = errorText(err);
          emit('ack-failed', { error: lastError, queued: outbox.count() });
          return { ok: false, reason: 'ack', error: lastError, queued: outbox.count() };
        });
      }, function (err) {
        failedErr = err;
        var ids = [];
        batches.slice(Math.floor(sentTotal / SPARK.maxBatch)).forEach(function (b) {
          b.forEach(function (it) { ids.push(it.id); });
        });
        if (isQuotaError(err)) {
          usage.blockByError(err);
          emit('quota-blocked', usage.snapshot());
        } else {
          outbox.mark(ids, 'failed', err);
        }
        var ne = normalizeError(err);
        var isOff = ne.code === 'unavailable' || /offline|network|failed to fetch|ERR_NETWORK/i.test(ne.message);
        lastError = errorText(err);
        lastErrorKind = isQuotaError(err) ? 'quota' : (isOff ? 'offline' : 'error');
        emit('flush-failed', { error: lastError, queued: outbox.count(), kind: lastErrorKind });
        return { ok: false, reason: lastErrorKind === 'quota' ? 'quota' : (isOff ? 'offline' : 'error'), error: lastError, queued: outbox.count() };
      });
    }

    /* ---------- 구독 ---------- */
    /* 어댑터가 스냅샷 하나를 처리할 때 문서 여러 건을 묶어 저장하게 한다 */
    function attachBatchHooks(ad) {
      if (!ad || typeof ad.setBatchHooks !== 'function') { return; }
      try { ad.setBatchHooks(beginRemoteBatch, endRemoteBatch); } catch (e) {}
    }

    function attachAdapter(nextAdapter) {
      if (unsub) { try { unsub(); } catch (e) {} unsub = null; }
      adapter = nextAdapter || null;
      if (!adapter) { return; }
      attachBatchHooks(adapter);
      if (typeof adapter.setRole === 'function') { try { adapter.setRole(effectiveRole()); } catch (e) {} }
      if (typeof adapter.subscribe === 'function') {
        unsub = adapter.subscribe(function (path, data, meta) {
          try { onRemote(path, data, meta); } catch (e) { lastError = errorText(e); }
        });
      }
      try { verifyRole(); } catch (e) {}
      emit('status', status());
    }

    /* ---------- 상태 ---------- */
    function status() {
      var s = { state: 'local', text: '⚪ 미연결(로컬 모드)', queued: outbox.count(), lastSyncAt: lastSyncAt, lastError: lastError, mode: adapter ? adapter.mode : 'local', role: effectiveRole(), deviceRole: deviceRole, verifiedRole: verifiedRole };
      if (usage.blocked()) { s.state = 'blocked'; s.text = '🔴 한도 초과 · 동기화 멈춤'; return s; }
      if (!adapter) { return s; }
      if (effectiveRole() === 'none') {
        s.state = 'role';
        s.text = (verifiedRole === '') ? '🔑 역할 미확인 · 로그인 필요' : '🔑 역할 확인 중';
        return s;
      }
      if (!online() || lastErrorKind === 'offline' || outbox.summary().failed > 0) { s.state = 'offline'; s.text = '🟡 오프라인 대기'; return s; }
      if (lastError) { s.state = 'error'; s.text = '🟠 연결 문제'; return s; }
      s.state = 'online';
      s.text = '🟢 실시간 연결됨';
      return s;
    }

    function emit(type, payload) {
      /* 묶음 처리 중의 원격 알림은 모아 두었다가 마지막에 1번만 — 화면 다시 그리기를 줄인다 */
      if (remoteDepth > 0 && type === 'remote') { batchRemoteCount++; return; }
      var st = null;
      try { st = status(); } catch (e) { st = null; }
      (listeners || []).forEach(function (fn) { try { fn(type, payload, st); } catch (e) {} });
      if (typeof opts.onEvent === 'function') {
        try { opts.onEvent(type, payload, st); } catch (e) {}
      }
    }

    /* ---------- 이전(마이그레이션) ---------- */
    function migrationPlan() {
      var base = basePath();
      var plan = { keys: [], docs: [], total: 0, batches: 0, synced: 0, localOnly: 0, derived: 0, keyCount: 0, derivedKeys: 0 };
      var all = [];
      var seenKeys = {};
      registry.forEach(function (e) {
        var row = {
          name: e.name, key: e.key, label: e.label, icon: e.icon, kind: e.kind, desc: e.desc,
          count: 0, localOnly: e.kind === 'local', derived: !!e.derivedFrom, coll: e.coll || '', meta: e.meta || ''
        };
        if (!seenKeys[e.key]) { seenKeys[e.key] = 1; plan.keyCount++; }
        if (e.kind !== 'local') {
          var docs = docsForEntry(e, readValue(e.name), base, { deviceId: deviceId });
          row.count = docs.length;
          docs.forEach(function (d) { all.push({ entry: e, doc: d }); });
        } else {
          plan.localOnly++;
        }
        plan.keys.push(row);
      });
      /* 같은 경로 중복 제거 (attendance·records) */
      var byPath = {};
      all.forEach(function (item) {
        var prev = byPath[item.doc.path];
        if (!prev) { byPath[item.doc.path] = item; return; }
        if (!prev.doc.body.time && item.doc.body.time) { byPath[item.doc.path] = item; }
      });
      plan.docs = Object.keys(byPath).map(function (p) { return byPath[p]; });
      plan.total = plan.docs.length;
      plan.synced = plan.total;
      plan.batches = Math.ceil(plan.total / SPARK.maxBatch);
      /* 키별 실제 업로드 건수 재계산 (파생 사본은 따로 센다) */
      var perKey = {};
      plan.docs.forEach(function (it) { perKey[it.entry.name] = (perKey[it.entry.name] || 0) + 1; });
      plan.keys.forEach(function (row) {
        row.count = perKey[row.name] || 0;
        if (row.derived) { plan.derived += row.count; plan.derivedKeys++; }
      });
      return plan;
    }

    function buildMigrationDocs() {
      var base = basePath();
      var out = [];
      registry.forEach(function (e) {
        if (e.kind === 'local') { return; }
        docsForEntry(e, readValue(e.name), base, { deviceId: deviceId }).forEach(function (d) {
          var body = clone(d.body) || {};
          var sh = shadow[d.path];
          var prevBody = sh && sh.b ? sh.b : {};
          var meta = stampFields(prevBody, sh ? sh.m : {}, body, { at: isoOf(now()), by: deviceId });
          var doc = valueFields(body);
          doc._ver = (sh ? num(sh.v) : 0) + 1;
          doc._updatedAt = isoOf(now());
          doc._updatedBy = deviceId;
          doc._fieldMeta = meta;
          out.push({ path: d.path, body: doc, entry: e });
        });
      });
      /* 중복 경로 정리 */
      var map = {};
      out.forEach(function (it) { map[it.path] = it; });
      return Object.keys(map).map(function (p) { return map[p]; });
    }

    function runMigration(opts2) {
      opts2 = opts2 || {};
      /* 이전은 관리자로 확인된 기기에서만 — 태블릿은 원생 개인정보를 올릴 수도, 읽을 수도 없다 */
      if (!isEffectiveAdmin()) {
        return Promise.resolve({
          ok: false,
          reason: (effectiveRole() === 'tablet') ? 'tablet-role' : 'role-unverified',
          message: (effectiveRole() === 'tablet')
            ? '출석 태블릿 역할에서는 이전하지 않습니다 — 관리자 PC에서 해 주세요.'
            : '서버 roles 문서로 관리자 역할이 확인되지 않았습니다 — 관리자 계정으로 로그인한 뒤 다시 시도해 주세요.'
        });
      }
      if (!adapter) { return Promise.resolve({ ok: false, reason: 'no-adapter' }); }
      if (usage.blocked()) { return Promise.resolve({ ok: false, reason: 'quota', message: QUOTA_MESSAGE }); }
      var docs = buildMigrationDocs();
      if (!docs.length) { return Promise.resolve({ ok: true, written: 0, skipped: 0, total: 0, batches: 0, byKey: {} }); }
      var overwrite = opts2.overwrite === true;   /* 기본: 이미 있는 문서는 건드리지 않는다 */
      var byKey = {};
      var stats = { ok: true, written: 0, skipped: 0, total: docs.length, batches: 0, byKey: byKey, errors: [] };
      var batches = [];
      for (var i = 0; i < docs.length; i += SPARK.maxBatch) { batches.push(docs.slice(i, i + SPARK.maxBatch)); }
      stats.batches = batches.length;
      var existing = {};

      function readExisting(bi) {
        if (bi >= batches.length) { return Promise.resolve(); }
        var paths = batches[bi].map(function (d) { return d.path; });
        if (typeof adapter.getDocs !== 'function') { return Promise.resolve(); }
        return adapter.getDocs(paths).then(function (res) {
          usage.record('reads', paths.length);
          (res || []).forEach(function (docResult) {
            if (docResult && docResult.path && docResult.exists) { existing[docResult.path] = docResult.data; }
          });
          return readExisting(bi + 1);
        }, function () { return Promise.resolve(); });
      }
      function writeBatches(bi) {
        if (bi >= batches.length) { return Promise.resolve(); }
        var batch = batches[bi];
        var ops = [];
        var names = [];
        batch.forEach(function (d) {
          var prev = existing[d.path];
          if (prev && (!overwrite || docCmp(prev, d.body) > 0)) {
            /* 이미 Firestore 에 있는 문서는 건드리지 않는다(서버가 더 최신이면 더욱) */
            stats.skipped++;
            return;
          }
          ops.push({ path: d.path, body: d.body, merge: true });
          names.push(d.entry.name);
        });
        if (!ops.length) { return writeBatches(bi + 1); }
        return adapter.writeBatch(ops).then(function () {
          usage.record('writes', ops.length);
          stats.written += ops.length;
          names.forEach(function (n) { stats.byKey[n] = (stats.byKey[n] || 0) + 1; });
          return writeBatches(bi + 1);
        }, function (err) {
          stats.ok = false;
          stats.errors.push(errorText(err));
          return { ok: false };
        });
      }

      return readExisting(0).then(function () { return writeBatches(0); }).then(function () {
        var ack = (adapter && typeof adapter.acknowledge === 'function') ? adapter.acknowledge() : true;
        return Promise.resolve(ack).then(function () {
          emit('migrated', stats);
          return stats;
        }, function (err) {
          return { ok: false, reason: 'ack', error: errorText(err) };
        });
      });
    }

    /* ---------- 시작/정지 ---------- */
    /* 지금 기기에 있는 데이터를 "이미 아는 상태"로 그림자에 올린다.
       → 아무것도 바꾸지 않았는데 처음 열었다는 이유로 전부 다시 보내는 일이 없다. */
    function seedShadow() {
      var base = basePath();
      registry.forEach(function (e) {
        if (e.kind === 'local') { return; }
        if (e.kind === 'events') {
          var map = unionEventDocs(readValue('attendance'), readValue('records'), base);
          Object.keys(map).forEach(function (p) {
            if (shadow[p]) { return; }
            var b = map[p].body;
            shadow[p] = { v: 0, m: {}, u: '', by: '', d: false, h: eventHash(b), b: null, t: b.time };
          });
          return;
        }
        docsForEntry(e, readValue(e.name), base, { deviceId: deviceId }).forEach(function (d) {
          if (shadow[d.path]) { return; }
          var body = d.body;
          shadow[d.path] = { v: 0, m: {}, u: '', by: '', d: false, h: contentHash(body), b: mergeMetaBody(body, {}), t: body.time };
        });
      });
      saveShadow();
    }

    var retryTimer = null;
    function startRetryLoop() {
      if (opts.autoflush === false || retryTimer) { return; }
      retryTimer = setInterval(function () {
        if (!adapter || usage.blocked() || !outbox.count()) { return; }
        if (!online()) { return; }
        flush().then(function () {}, function () {});
      }, opts.retryMs || 30000);
    }
    function onOnline() {
      lastErrorKind = '';
      emit('status', status());
      if (outbox.count()) { scheduleFlush(); }
    }
    function onOffline() {
      lastErrorKind = 'offline';
      emit('status', status());
    }

    function start() {
      if (started) { return api; }
      started = true;
      registry.forEach(function (e) {
        if (e.kind === 'local') { return; }
        prevValues[e.name] = readValue(e.name);
      });
      seedShadow();
      attach(storage);
      if (root.addEventListener) {
        try {
          root.addEventListener('online', onOnline);
          root.addEventListener('offline', onOffline);
        } catch (e) {}
      }
      startRetryLoop();
      attachBatchHooks(adapter);
      if (adapter && typeof adapter.subscribe === 'function') {
        unsub = adapter.subscribe(function (path, data, meta) {
          try { onRemote(path, data, meta); } catch (e) { lastError = errorText(e); }
        });
      }
      if (adapter && verifyOnStart) { try { verifyRole(); } catch (e) {} }
      /* 관리자로 확인되면 기기별 사용량 합산 문서(meta/usage)도 주기적으로 올린다 */
      if (opts.autoflush !== false) {
        scheduleUsagePush(1500);
        if (!usageSync.tick) {
          usageSync.tick = setInterval(function () {
            if (!usageSyncAllowed()) { return; }
            pushUsageNow().then(function () {}, function () {});
          }, USAGE_SYNC.tickMs);
        }
      }
      /* 태블릿 역할인데 예전에 쌓인 「보낼 수 없는」 실패 항목이 있으면 한 번 정리한다 */
      if (isEffectiveTablet()) { try { clearFailed(); } catch (e) {} }
      /* 태블릿 역할인데 이 기기에 아직 개인정보가 남아 있으면 한 번 알린다 */
      if (isEffectiveTablet()) {
        var privateCount = countPrivateStudents(readValue('students'));
        if (privateCount > 0) { emit('tablet-private-data', { count: privateCount }); }
      }
      emit('status', status());
      return api;
    }

    function stop() {
      started = false;
      stopUsageSync();
      saveLastSync();
      if (unsub) { try { unsub(); } catch (e) {} unsub = null; }
      if (retryTimer) { clearInterval(retryTimer); retryTimer = null; }
      if (root.removeEventListener) {
        try { root.removeEventListener('online', onOnline); root.removeEventListener('offline', onOffline); } catch (e) {}
      }
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      if (reloadTimer) { clearTimeout(reloadTimer); reloadTimer = null; }
      /* 마지막 그림자 상태를 IndexedDB 에 남기고, 남은 타이머가 나중에 덮어쓰지 않게 정리 */
      if (shadowSaveTimer) { try { clearTimeout(shadowSaveTimer); } catch (e) {} shadowSaveTimer = null; }
      if (shadowDirty) { flushShadowPersist(); }
    }

    /* ---------- 테스트/UI용 ---------- */
    var api = {
      VERSION: VERSION,
      start: start,
      stop: stop,
      status: status,
      usage: usage,
      /* 기기별 사용량 합산 — 지금 상태(마지막으로 받은 문서·올린 횟수) */
      usageSync: function () {
        return {
          allowed: usageSyncAllowed(),
          reason: usageSyncReason(),
          path: usageMetaPath(),
          pushes: usageSync.pushes,
          skipped: usageSync.skipped,
          lastPushAt: usageSync.lastPushAt,
          lastError: usageSync.lastError,
          remoteDate: usageSync.remote ? String(usageSync.remote.date || '') : '',
          remoteDevices: usageTotals(usageSync.remote, rawUsageSnapshot().date, deviceId).devices.length
        };
      },
      pushUsageNow: pushUsageNow,
      outbox: outbox,
      registry: function () { return registry.map(function (e) { return clone(e); }); },
      basePath: basePath,
      setDevice: function (d) { deviceId = String(d || deviceId); },
      /* 화면에서 고른 값은 "어떤 계정으로 로그인할지" 안내용 — 유효 권한은 서버 roles 로 잠기므로
         이 값만으로는 관리자 권한이 생기지 않는다 */
      setRole: function (r) { return setDeviceRole(r); },
      setDeviceRole: setDeviceRole,
      scrubTabletPII: scrubTabletPII,
      /* 「🗑️ 실패 비우기」 — failed 항목만 지운다 (인자 없으면 태블릿이 보낼 수 없는 경로만) */
      clearFailed: clearFailed,
      countPrivateStudents: function () { return countPrivateStudents(readValue('students')); },
      role: function () { return effectiveRole(); },
      effectiveRole: effectiveRole,
      deviceRole: function () { return deviceRole; },
      verifiedRole: function () { return verifiedRole; },
      setVerifiedRole: applyVerifiedRole,
      verifyRole: verifyRole,
      rescanLocal: rescanLocal,
      device: function () { return deviceId; },
      setDojang: function (d) { dojangId = safeId(d || 'mta-tkd'); },
      attachAdapter: attachAdapter,
      adapter: function () { return adapter; },
      subscribe: function (fn) { listeners.push(fn); return function () { listeners = listeners.filter(function (x) { return x !== fn; }); }; },
      flush: flush,
      handleWrite: handleWrite,
      captureKey: function (name) {
        var e = entryByName(name);
        if (!e) { return 0; }
        prevValues[name] = readValue(name);
        capture(e);
        return outbox.count();
      },
      /* 원격 문서를 묶어서 반영 — 그 사이 읽기·수정은 메모리에서, 저장은 키당 1회.
         (어댑터가 setBatchHooks 로 자동으로 감싸지만, 테스트·진단에서 직접 쓸 수도 있다) */
      beginRemoteBatch: beginRemoteBatch,
      endRemoteBatch: endRemoteBatch,
      flushLocalWrites: flushLocalWrites,
      simulateRemoteBatch: function (list) {
        var arr = Array.isArray(list) ? list : [];
        beginRemoteBatch();
        try {
          arr.forEach(function (it) { try { onRemote(it.path, it.data, it.meta || null); } catch (e) { lastError = errorText(e); } });
        } finally { endRemoteBatch(); }
        return arr.length;
      },
      /* 🔄 전체 다시 불러오기 — 델타 기준 시각을 지우고 전체 구독으로 되돌린다 */
      forceFullSync: forceFullSync,
      /* 델타 구독 상태 (화면·진단용) */
      syncInfo: function () {
        var map = readLastSync(storage);
        var colls = {};
        Object.keys(map).forEach(function (k) { colls[k] = { at: map[k], iso: isoOf(map[k]) }; });
        return {
          delta: Object.keys(map).length > 0,
          collections: colls,
          key: LASTSYNC_KEY,
          safetyMs: DELTA.safetyMs,
          lastSyncAt: lastSyncAt,
          fullSyncAt: fullSyncAt
        };
      },
      migrationPlan: migrationPlan,
      runMigration: runMigration,
      migrationDocs: buildMigrationDocs,
      docsFor: function (name) {
        var e = entryByName(name);
        if (!e) { return []; }
        return docsForEntry(e, readValue(name), basePath(), { deviceId: deviceId });
      },
      shadow: function (path) {
        if (path) { return clone(shadow[path]) || null; }
        return clone(shadow) || {};
      },
      /* 그림자가 준비될 때까지 기다리는 약속 — 테스트·진단용 */
      shadowReady: function () { return shadowReadyPromise; },
      shadowInfo: function () {
        return {
          backend: (idbSupported() && !idbDisabled) ? 'indexeddb' : 'memory',
          loaded: shadowLoaded, entities: Object.keys(shadow).length,
          dirty: shadowDirty, writing: shadowWriting, disabled: idbDisabled,
          fails: shadowWriteFails, db: IDB_NAME, store: IDB_STORE, item: IDB_SHADOW_ITEM
        };
      },
      /* 그림자를 IndexedDB 에 즉시 쓴다 (테스트·진단용) */
      saveShadowNow: function () {
        shadowDirty = true;
        return flushShadowPersist();
      },
      storageState: function () {
        return { full: storageFull, failed: storageFailed, lastKey: storageLastKey, lastError: storageLastError, at: storageLastAt };
      },
      resetShadow: function () { shadow = {}; saveShadow(); },
      seedShadow: function () { seedShadow(); return Object.keys(shadow).length; },
      setValue: function (name, value) { return writeValue(name, value); },
      applyRemoteNow: flushReload,
      simulateRemote: function (path, data) { onRemote(path, data, null); },
      mergeDocs: mergeDocs,
      errors: function () { return { lastError: lastError, lastSyncAt: lastSyncAt }; }
    };
    /* 옛 localStorage 그림자를 IndexedDB·인메모리로 옮기고 localStorage 를 비운다 */
    hydrateShadow();
    return api;
  }

  /* =========================================================================
     8. 모의 Firestore (체험·검증용) — 같은 브라우저의 두 탭이 실제로 동기화된다
     ========================================================================= */
  function createMockServer(opts) {
    opts = opts || {};
    var storage = opts.storage || null;
    var persistKey = opts.persistKey || 'tdk.fbMock.v1';
    var channelName = opts.channel || 'tdkfb-mock';
    var docs = {};
    var listeners = [];
    var bc = null;
    var failNext = null;
    var offline = false;

    if (storage) {
      try {
        var raw = storage.getItem(persistKey);
        if (raw) { docs = JSON.parse(raw) || {}; } else { docs = {}; }
      } catch (e) { docs = {}; }
      if (!isPlain(docs)) { docs = {}; }
    }
    if (opts.channel !== false && typeof root.BroadcastChannel === 'function') {
      try { bc = new root.BroadcastChannel(channelName); } catch (e) { bc = null; }
    }
    function persist() {
      if (!storage) { return; }
      try { storage.setItem(persistKey, JSON.stringify(docs)); } catch (e) {}
    }
    function deliver(paths) {
      paths.forEach(function (p) {
        var data = docs[p] ? clone(docs[p]) : null;
        listeners.forEach(function (fn) { try { fn(p, data, { ver: data ? num(data._ver) : 0 }); } catch (e) {} });
      });
    }
    function apply(ops) {
      var paths = [];
      ops.forEach(function (op) {
        if (!op || !op.path) { return; }
        if (op.del) { delete docs[op.path]; }
        else if (isPlain(op.body)) {
          var cur = isPlain(docs[op.path]) ? docs[op.path] : {};
          var next = op.merge === false ? {} : clone(cur) || {};
          Object.keys(op.body).forEach(function (k) { next[k] = op.body[k]; });
          docs[op.path] = next;
        }
        paths.push(op.path);
      });
      persist();
      if (bc) { try { bc.postMessage({ ops: ops }); } catch (e) {} }
      deliver(paths);
      return paths;
    }
    if (bc) {
      bc.onmessage = function (ev) {
        var data = ev && ev.data;
        if (!data || data.echo) { return; }
        var paths = [];
        (data.ops || []).forEach(function (op) {
          if (!op || !op.path) { return; }
          if (op.del) { delete docs[op.path]; }
          else if (isPlain(op.body)) {
            var cur = isPlain(docs[op.path]) ? docs[op.path] : {};
            var next = op.merge === false ? {} : clone(cur) || {};
            Object.keys(op.body).forEach(function (k) { next[k] = op.body[k]; });
            docs[op.path] = next;
          }
          paths.push(op.path);
        });
        persist();
        deliver(paths);
      };
    }

    return {
      mode: 'mock',
      get: function (path) { return isPlain(docs[path]) ? clone(docs[path]) : null; },
      all: function () { return clone(docs) || {}; },
      keys: function () { return Object.keys(docs); },
      write: function (ops) {
        if (offline) { return Promise.reject({ code: 'unavailable', message: 'offline' }); }
        if (failNext) { var err = failNext; failNext = null; return Promise.reject(err); }
        apply(ops);
        return Promise.resolve({ ok: true });
      },
      subscribe: function (fn) { listeners.push(fn); return function () { listeners = listeners.filter(function (x) { return x !== fn; }); }; },
      setOffline: function (v) { offline = !!v; },
      failNextWith: function (err) { failNext = err || { code: 'unavailable', message: 'mock fail' }; },
      clear: function () { docs = {}; persist(); },
      stats: function () { return { docs: Object.keys(docs).length }; },
      close: function () { if (bc) { try { bc.close(); } catch (e) {} bc = null; } }
    };
  }

  function createMockAdapter(server, opts) {
    opts = opts || {};
    var ackFails = false;
    var current = null;      /* 모의 로그인 계정 — 실제 Firebase 와 같은 순서(uid → roles 조회)를 연습할 수 있게 */
    return {
      mode: 'mock',
      label: opts.label || '모의 Firestore',
      setRole: function (r) { return r === 'admin' ? 'admin' : 'tablet'; },
      signInEmail: function (email, pw) {
        current = { uid: 'mock_' + hashStr(String(email || '')), email: String(email || ''), anonymous: false };
        return Promise.resolve({ uid: current.uid, email: current.email });
      },
      currentUser: function () { return current ? { uid: current.uid, email: current.email, anonymous: false } : null; },
      uid: function () { return current ? current.uid : ''; },
      signOut: function () { current = null; return Promise.resolve(true); },
      writeBatch: function (ops) { return server.write(ops); },
      getDoc: function (path) {
        return Promise.resolve({ path: path, exists: !!server.get(path), data: server.get(path) });
      },
      getDocs: function (paths) {
        return Promise.resolve(paths.map(function (p) {
          return { path: p, exists: !!server.get(p), data: server.get(p) };
        }));
      },
      acknowledge: function () {
        if (ackFails) { return Promise.reject({ code: 'unavailable', message: 'ack 실패(모의)' }); }
        return Promise.resolve(true);
      },
      setAckFails: function (v) { ackFails = !!v; },
      subscribe: function (fn) {
        /* 문서 단위 구독 → 엔진이 문서별로 병합한다 */
        return server.subscribe(function (path, data) { fn(path, data, { ver: data ? num(data._ver) : 0 }); });
      },
      test: function () {
        return server.write([]).then(function () { return { ok: true, message: '모의 Firestore 연결됨' }; });
      }
    };
  }

  /* =========================================================================
     9. 실제 Firebase(Firestore) 어댑터 — firebaseConfig 는 코드에 넣지 않는다
     ========================================================================= */
  function loadFirebaseModules(version) {
    var v = version || '11.0.2';
    var base = 'https://www.gstatic.com/firebasejs/' + v + '/';
    return Promise.all([
      import(base + 'firebase-app.js'),
      import(base + 'firebase-firestore.js'),
      import(base + 'firebase-auth.js')
    ]).then(function (mods) {
      return { app: mods[0], firestore: mods[1], auth: mods[2], version: v };
    });
  }

  function createFirestoreAdapter(cfg, opts) {
    opts = opts || {};
    var mods = null, app = null, db = null, auth = null;
    var sdkVersion = (cfg && cfg.sdkVersion) || '11.0.2';
    /* 테스트에서 가짜 모듈을 넣을 수 있는 자리 — 실제 동작은 loadFirebaseModules 그대로 */
    var loadModules = (typeof opts.loadModules === 'function') ? opts.loadModules : loadFirebaseModules;
    /* 연결 테스트가 오프라인·권한 지연으로 무한 대기하지 않게 하는 시간(기본 8초) */
    var testTimeoutMs = Number(opts.testTimeoutMs) > 0 ? Number(opts.testTimeoutMs) : 8000;
    /* 앱을 껐다 켰을 때 저장된 로그인 세션(IndexedDB)이 복원되기를 기다리는 시간(기본 4초).
       복원은 비동기라서, 기다리지 않으면 connect() 직후 auth.currentUser 가 아직 null 이다. */
    var authReadyTimeoutMs = Number(opts.authReadyTimeoutMs) > 0 ? Number(opts.authReadyTimeoutMs) : 4000;
    /* 저장된 로그인 세션이(이미 있거나 복원되어) 확인됐는지 — 화면 표시용 */
    var authRestored = false;
    /* 역할을 확인하기 전에는 가장 제한적인 쪽(태블릿 구독)으로 시작한다 */
    var role = opts.role === 'admin' ? 'admin' : 'tablet';
    var unsubs = [];
    /* 엔진이 넣어 주는 묶음 훅 — 한 스냅샷에 여러 문서가 올 때
       메모리에서 모아 수정하고 저장은 키당 1회만 하게 한다 */
    var batchHooks = { begin: null, end: null };

    function connect() {
      return loadModules(sdkVersion).then(function (m) {
        mods = m;
        var fs = m.firestore;
        var appName = 'tdk-fb-' + (cfg.dojangId || 'mta');
        /* 같은 탭에서 「설정 저장 · 연결」을 다시 눌러도 앱을 새로 만들지 않는다
           (duplicate-app 으로 연결이 실패하던 문제 방지) */
        var existing = (typeof m.app.getApps === 'function' ? m.app.getApps() : []).filter(function (a) {
          return a && a.name === appName;
        })[0];
        app = existing || m.app.initializeApp({
          apiKey: cfg.apiKey, authDomain: cfg.authDomain, projectId: cfg.projectId,
          storageBucket: cfg.storageBucket, messagingSenderId: cfg.messagingSenderId, appId: cfg.appId
        }, appName);
        /* 오프라인 임시 저장 + 여러 탭 동시 사용.
           이미 이 앱의 Firestore 가 초기화돼 있으면 initializeFirestore 가
           "already been called with different options" 로 실패하므로 기존 인스턴스를 쓴다. */
        try {
          db = fs.initializeFirestore(app, {
            localCache: fs.persistentLocalCache({ tabManager: fs.persistentMultipleTabManager() })
          });
        } catch (e) {
          db = fs.getFirestore(app);
        }
        auth = m.auth.getAuth(app);
        /* 앱을 다시 켜면 SDK 가 저장된 로그인 세션을 비동기로 복원한다.
           여기서 기다리지 않으면 바로 뒤의 roles/{uid} 확인이 currentUser=null 을 읽어
           로그인이 남아 있어도 「⚪ 로컬 · 역할 미확인」으로 굳는다. */
        return waitAuthRestore().then(function () { return api; });
      });
    }

    /* 저장된 로그인 세션 복원을 기다린다 — 없거나 알림이 오지 않으면 지금 상태로 진행한다 */
    function waitAuthRestore() {
      if (!auth) { return Promise.resolve(false); }
      if (auth.currentUser) { authRestored = true; return Promise.resolve(true); }
      return new Promise(function (resolve) {
        var settled = false;
        var timer = null;
        function finish(ok) {
          if (settled) { return; }
          settled = true;
          if (timer) { try { clearTimeout(timer); } catch (e) {} timer = null; }
          authRestored = !!ok;
          resolve(!!ok);
        }
        /* 복원 알림이 끝내 오지 않는 환경(사생활 보호 모드·모의 객체)에서도 앱 시작을 4초 넘게 잡아두지 않는다 */
        try { timer = setTimeout(function () { finish(!!(auth && auth.currentUser)); }, authReadyTimeoutMs); } catch (e) { timer = null; }
        var modsAuth = (mods && mods.auth) || {};
        if (typeof auth.authStateReady === 'function') {
          try {
            auth.authStateReady().then(function () { finish(!!auth.currentUser); },
              function () { finish(!!auth.currentUser); });
            return;
          } catch (e) { /* 아래 폴백으로 */ }
        }
        if (typeof modsAuth.onAuthStateChanged === 'function') {
          var un = null;
          try {
            un = modsAuth.onAuthStateChanged(auth, function () {
              try { if (un) { un(); } } catch (e) {}
              un = null;
              finish(!!auth.currentUser);
            });
            return;
          } catch (e) { /* 폴백 없음 — 위 타이머가 정리한다 */ }
        }
        /* 세션 복원을 알려 주는 통로가 없는 모의 객체 — 지금 상태로 진행 */
        finish(!!auth.currentUser);
      });
    }

    /* 앱을 껐다 켜도 로그인이 남아 있게 영속성(localStorage/IndexedDB)을 보장한다.
       실패해도 로그인 자체는 막지 않는다(세션만 남지 않을 뿐이다). */
    function ensurePersistence() {
      var modsAuth = (mods && mods.auth) || {};
      if (!auth || typeof modsAuth.setPersistence !== 'function') { return Promise.resolve(false); }
      var kind = null;
      try {
        if (modsAuth.browserLocalPersistence) { kind = modsAuth.browserLocalPersistence; }
        else if (modsAuth.indexedDBLocalPersistence) { kind = modsAuth.indexedDBLocalPersistence; }
      } catch (e) { kind = null; }
      if (!kind) { return Promise.resolve(false); }
      try {
        return Promise.resolve(modsAuth.setPersistence(auth, kind)).then(function () { return true; }, function () { return false; });
      } catch (e) { return Promise.resolve(false); }
    }

    var api = {
      mode: 'firestore',
      label: 'Firebase Firestore',
      connect: connect,
      /* 서버 roles 로 확인된 유효 권한을 반영한다 (관리자 구독은 'admin' 일 때만) */
      setRole: function (r) { role = r === 'admin' ? 'admin' : 'tablet'; return role; },
      getRole: function () { return role; },
      raw: function () { return { mods: mods, app: app, db: db, auth: auth }; },
      /* Firebase v11 은 모듈 함수에 auth 인스턴스를 넘기는 방식이다.
         auth.signInWithEmailAndPassword(...) 처럼 v8 메서드로 부르면
         "... is not a function" 으로 실패한다. */
      signInEmail: function (email, pw) {
        if (!mods || !mods.auth || typeof mods.auth.signInWithEmailAndPassword !== 'function') {
          return Promise.reject(new Error('Firebase Auth 모듈이 준비되지 않았습니다 — 연결을 다시 눌러 주세요'));
        }
        /* 로그인 전에 영속성을 먼저 잡아 둔다 — 앱을 껐다 켜도 세션이 남는다 */
        return ensurePersistence().then(function () {
          return mods.auth.signInWithEmailAndPassword(auth, email, pw);
        }).then(function (cred) {
          authRestored = true;
          return { uid: cred.user.uid, email: cred.user.email || '' };
        });
      },
      signInAnonymously: function () {
        if (!mods || !mods.auth || typeof mods.auth.signInAnonymously !== 'function') {
          return Promise.reject(new Error('Firebase Auth 모듈이 준비되지 않았습니다 — 연결을 다시 눌러 주세요'));
        }
        return ensurePersistence().then(function () {
          return mods.auth.signInAnonymously(auth);
        }).then(function (cred) {
          authRestored = true;
          return { uid: cred.user.uid };
        });
      },
      signOut: function () {
        if (!mods || !mods.auth || typeof mods.auth.signOut !== 'function') {
          return Promise.reject(new Error('Firebase Auth 모듈이 준비되지 않았습니다 — 연결을 다시 눌러 주세요'));
        }
        return mods.auth.signOut(auth);
      },
      currentUser: function () { return auth && auth.currentUser ? { uid: auth.currentUser.uid, email: auth.currentUser.email || '', anonymous: !!auth.currentUser.isAnonymous } : null; },
      uid: function () { return auth && auth.currentUser ? auth.currentUser.uid : ''; },
      /* connect() 가 세션 복원을 기다렸는지 — 화면·테스트 확인용 */
      authRestored: function () { return authRestored; },
      /* 세션이 뒤늦게 복원되거나 로그아웃될 때 화면이 따라갈 수 있게 알린다.
         반환값은 구독 해제 함수(지원하지 않는 환경이면 아무것도 하지 않는 함수) */
      onAuthChange: function (cb) {
        var modsAuth = (mods && mods.auth) || {};
        if (typeof cb !== 'function' || !auth || typeof modsAuth.onAuthStateChanged !== 'function') {
          return function () {};
        }
        var un = null;
        try {
          un = modsAuth.onAuthStateChanged(auth, function (user) {
            try {
              cb(user ? { uid: user.uid, email: user.email || '', anonymous: !!user.isAnonymous } : null);
            } catch (e) {}
          });
        } catch (e) { return function () {}; }
        return function () { try { if (un) { un(); } } catch (e) {} };
      },
      writeBatch: function (ops) {
        var fs = mods.firestore;
        var batch = fs.writeBatch(db);
        ops.forEach(function (op) {
          if (op.del) { batch.delete(fs.doc(db, op.path)); }
          else { batch.set(fs.doc(db, op.path), op.body || {}, { merge: op.merge !== false }); }
        });
        return batch.commit();
      },
      getDoc: function (path) {
        var fs = mods.firestore;
        return fs.getDoc(fs.doc(db, path)).then(function (snap) {
          return { path: path, exists: snap.exists(), data: snap.exists() ? snap.data() : null };
        });
      },
      getDocs: function (paths) {
        var fs = mods.firestore;
        return Promise.all(paths.map(function (p) {
          return fs.getDoc(fs.doc(db, p)).then(function (snap) {
            return { path: p, exists: snap.exists(), data: snap.exists() ? snap.data() : null };
          });
        }));
      },
      /* 서버 저장 확인 — 큐에서 지우기 전에 이것이 성공해야 한다 */
      acknowledge: function () {
        var fs = mods.firestore;
        return typeof fs.waitForPendingWrites === 'function' ? fs.waitForPendingWrites(db) : Promise.resolve(true);
      },
      subscribe: function (fn) {
        var fs = mods.firestore;
        var basePath = opts.basePath || ('dojangs/' + (cfg.dojangId || 'mta-tkd'));
        var since = new Date(Date.now() - 7 * 24 * 3600 * 1000);
        var sinceIso = since.toISOString().slice(0, 10);
        /* 출결은 첫 전체 구독에서 최근 7일만 — 오래된 기록까지 매번 읽지 않아 무료 한도를 아낀다 */
        var eventSpec = { path: basePath + '/attendanceEvents', coll: 'attendanceEvents', where: { field: 'date', op: '>=', value: sinceIso } };
        /* 태블릿은 원생 개인정보(students)·원비·상담·설정을 아예 구독하지 않는다.
           이 역할이 읽을 수 있는 것은 kioskStudents(최소 정보)와 attendanceEvents 둘뿐이다. */
        var specs = (role === 'admin')
          ? [
            { path: basePath + '/students', coll: 'students' },
            { path: basePath + '/counsel', coll: 'counsel' },
            { path: basePath + '/shuttle', coll: 'shuttle' },
            { path: basePath + '/coupons', coll: 'coupons' },
            /* meta 는 문서가 몇 개 안 되니 전체 구독 그대로(델타 대상 아님) */
            { path: basePath + '/meta', coll: 'meta', delta: false },
            { path: basePath + '/tuition', coll: 'tuition' },
            eventSpec
          ]
          : [
            { path: basePath + '/kioskStudents', coll: 'kioskStudents' },
            eventSpec
          ];
        var store = lastSyncStore(opts.lastSyncStorage);
        var lastMap = opts.fullSync === true ? {} : readLastSync(store);
        var nowMs = Date.now();
        var log = (opts.snapshotLog && typeof opts.snapshotLog.push === 'function') ? opts.snapshotLog : null;
        /* 이 기기에 그 컬렉션 자료가 없으면(새 기기·초기화) 델타를 쓰지 않는다 */
        function deltaAllowed(coll) {
          if (typeof opts.hasLocalData === 'function') {
            try { return opts.hasLocalData(coll) !== false; } catch (e) { return true; }
          }
          if (opts.hasLocalData === false) { return true; }
          return localDataHas(store, coll);
        }
        function noteSync(coll) {
          if (!coll) { return; }
          var m = readLastSync(store);
          m[coll] = Date.now();
          writeLastSync(store, m);
        }
        specs.forEach(function (spec) {
          var coll = fs.collection(db, spec.path);
          var q = coll;
          var sinceVal = '';
          if (spec.delta !== false) {
            if (deltaAllowed(spec.coll)) { sinceVal = deltaSinceIso(lastMap[spec.coll], nowMs); }
          }
          if (sinceVal) {
            /* 단일 필드 where → 자동 인덱스. 확장 필드가 아니라 _updatedAt 이라 규칙 수정도 불필요 */
            q = fs.query(coll, fs.where('_updatedAt', '>', sinceVal));
          } else if (spec.where) {
            q = fs.query(coll, fs.where(spec.where.field, spec.where.op, spec.where.value));
          }
          if (log) { log.push({ coll: spec.coll, path: spec.path, since: sinceVal, where: sinceVal ? '_updatedAt' : (spec.where ? spec.where.field : '') }); }
          var un = fs.onSnapshot(q, { includeMetadataChanges: false }, function (snap) {
            /* 캐시에서 온 스냅샷은 서버 읽기가 아니다 — 계량기에 넣지 않고 마지막 시각도 안 새긴다 */
            var fromCache = !!(snap && snap.metadata && snap.metadata.fromCache === true);
            var meta = { ver: 0, fromCache: fromCache, coll: spec.coll };
            if (typeof batchHooks.begin === 'function') { try { batchHooks.begin(); } catch (e) {} }
            try {
              snap.docChanges().forEach(function (ch) {
                if (ch.type === 'removed') { fn(ch.doc.ref.path, null, meta); }
                else { fn(ch.doc.ref.path, ch.doc.data(), meta); }
              });
            } finally {
              if (typeof batchHooks.end === 'function') { try { batchHooks.end(); } catch (e) {} }
            }
            if (!fromCache) { noteSync(spec.coll); }
          }, function (err) {
            if (typeof opts.onError === 'function') { opts.onError(err); }
          });
          unsubs.push(un);
        });
        return function () { unsubs.forEach(function (u) { try { u(); } catch (e) {} }); unsubs = []; };
      },
      /* 엔진이 넣는 묶음 처리 훅 — 문서 여러 건을 한 번에 저장하게 */
      setBatchHooks: function (beginFn, endFn) {
        batchHooks.begin = (typeof beginFn === 'function') ? beginFn : null;
        batchHooks.end = (typeof endFn === 'function') ? endFn : null;
      },
      test: function () {
        if (!db) { return Promise.resolve({ ok: false, message: '아직 연결되지 않았습니다' }); }
        /* 규칙상 읽기가 막혀 있어도 "연결 자체"는 확인된다 — 이 역할이 읽어도 되는 문서 1건 */
        var probe = opts.basePath || ('dojangs/' + (cfg.dojangId || 'mta-tkd'));
        probe += (role === 'admin') ? '/meta/settings' : '/meta/kioskConfig';
        var docCall;
        try {
          docCall = api.getDoc(probe);
        } catch (err) {
          return Promise.resolve({ ok: false, message: errorText(err) });
        }
        var sec = Math.max(1, Math.round(testTimeoutMs / 1000));
        var timer = null;
        var timeout = new Promise(function (resolve) {
          timer = setTimeout(function () {
            resolve({ ok: false, timeout: true, message: '⏱ ' + sec + '초 안에 응답이 없습니다 — 오프라인·네트워크 또는 Firestore 규칙(권한)을 확인해 주세요' });
          }, testTimeoutMs);
        });
        var probeRead = docCall.then(
          function (r) { return { ok: true, message: r.exists ? '연결됨 · 설정 문서 있음' : '연결됨 · 아직 데이터 없음' }; },
          function (err) { return { ok: false, message: errorText(err) + ' (' + probe + ')' }; });
        return Promise.race([probeRead, timeout]).then(function (r) {
          if (timer) { clearTimeout(timer); timer = null; }
          return r;
        });
      },
      disconnect: function () { unsubs.forEach(function (u) { try { u(); } catch (e) {} }); unsubs = []; }
    };
    return connect();
  }

  /* =========================================================================
     10. 설정값 검증
     ========================================================================= */
  function validateConfig(input) {
    var cfg = isPlain(input) ? input : {};
    var errors = [];
    if (!String(cfg.apiKey || '').trim()) { errors.push('apiKey 가 없습니다'); }
    if (!String(cfg.projectId || '').trim()) { errors.push('projectId 가 없습니다'); }
    if (!String(cfg.appId || '').trim()) { errors.push('appId 가 없습니다'); }
    var projectId = String(cfg.projectId || '');
    if (projectId && !/^[a-z0-9][a-z0-9-]{2,40}$/.test(projectId)) { errors.push('projectId 형식이 올바르지 않습니다'); }
    var dojangId = safeId(cfg.dojangId || '');
    return {
      ok: errors.length === 0,
      errors: errors,
      config: errors.length === 0 ? {
        apiKey: String(cfg.apiKey).trim(),
        authDomain: String(cfg.authDomain || (projectId + '.firebaseapp.com')).trim(),
        projectId: projectId,
        storageBucket: String(cfg.storageBucket || (projectId + '.appspot.com')).trim(),
        messagingSenderId: String(cfg.messagingSenderId || '').trim(),
        appId: String(cfg.appId).trim(),
        dojangId: dojangId || 'mta-tkd',
        sdkVersion: String(cfg.sdkVersion || '11.0.2')
      } : null
    };
  }

  function createMemoryStorage(seed) {
    var map = {};
    if (isPlain(seed)) { Object.keys(seed).forEach(function (k) { map[k] = String(seed[k]); }); }
    return {
      getItem: function (k) { return hasOwn(map, k) ? map[k] : null; },
      setItem: function (k, v) { map[k] = String(v); },
      removeItem: function (k) { delete map[k]; },
      clear: function () { map = {}; },
      key: function (i) { return Object.keys(map)[i] || null; },
      get length() { return Object.keys(map).length; },
      _dump: function () { return clone(map); }
    };
  }

  return {
    VERSION: VERSION,
    SPARK: SPARK,
    QUOTA_MESSAGE: QUOTA_MESSAGE,
    KEY_TABLE: KEY_TABLE,
    KIOSK_FIELDS: KIOSK_FIELDS,
    PRIVATE_STUDENT_FIELDS: PRIVATE_STUDENT_FIELDS,
    kioskStudentBody: kioskStudentBody,
    kioskDocsOf: kioskDocsOf,
    kioskConfigBody: kioskConfigBody,
    countPrivateStudents: countPrivateStudents,
    countFaces: countFaces,
    SCRUB_KEEP_FIELDS: SCRUB_KEEP_FIELDS,
    SCRUB_CLEAR_NAMES: SCRUB_CLEAR_NAMES,
    LOCAL_KEYS: LOCAL_KEYS,
    buildRegistry: buildRegistry,
    createEngine: createEngine,
    createUsage: createUsage,
    DELTA: DELTA,
    LASTSYNC_KEY: LASTSYNC_KEY,
    readLastSync: readLastSync,
    writeLastSync: writeLastSync,
    deltaSinceIso: deltaSinceIso,
    localDataHas: localDataHas,
    USAGE_SYNC: USAGE_SYNC,
    usageTotals: usageTotals,
    usageDeviceEntries: usageDeviceEntries,
    usagePushDecision: usagePushDecision,
    createOutbox: createOutbox,
    createMockServer: createMockServer,
    createMockAdapter: createMockAdapter,
    createFirestoreAdapter: createFirestoreAdapter,
    loadFirebaseModules: loadFirebaseModules,
    createMemoryStorage: createMemoryStorage,
    migrateShadowCache: migrateShadowCache,
    validateConfig: validateConfig,
    mergeDocs: mergeDocs,
    stampFields: stampFields,
    flatten: flatten,
    unflatten: unflatten,
    stableStringify: stableStringify,
    contentHash: contentHash,
    eventHash: eventHash,
    bodyHash: bodyHash,
    docsForEntry: docsForEntry,
    docBody: docBody,
    unionEventDocs: unionEventDocs,
    unionArrays: unionArrays,
    eventIdOf: eventIdOf,
    parseEventId: parseEventId,
    safeId: safeId,
    isoOf: isoOf,
    dayOf: dayOf,
    sparkDayOf: sparkDayOf,
    errorText: errorText,
    isQuotaError: isQuotaError
  };
});
