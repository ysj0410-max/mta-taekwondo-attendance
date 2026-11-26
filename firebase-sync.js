/* =============================================================================
   경희대MTA태권도 — 🔥 Firebase Firestore 실시간 동기화 엔진 (v30 정식)
   =============================================================================
   · 이 파일은 정식 앱(index.html)이 불러 씁니다.
     운영 버전(index.html v28)은 이 파일을 읽지 않으며, 이 파일이 운영 데이터에
     영향을 주는 경로는 전혀 없습니다.
   · 저장 구조 (v43 — 관리자 계정 단일 구조 · 모든 기기가 같은 관리자 계정으로 연결)
       dojangs/{dojangId}/students/{studentId}          원생 1명 = 문서 1개 (개인정보 포함 · 관리자 전용)
       dojangs/{dojangId}/attendanceEvents/{eventId}     출결 1건 = 문서 1개
                                                         eventId = {날짜}_{원생ID}_{in|out}
                                                         칸: date·studentId·kind·time·eventId·source·manual·deviceId
                                                             (+ _ver·_updatedAt·_updatedBy·_fieldMeta)
                                                         ※ firestore.rules 의 eventFields() 와 정확히 같은 목록이어야 한다
       dojangs/{dojangId}/tuition/{YYYY-MM}_{studentId}  원생·월 원비 1건 = 문서 1개
       dojangs/{dojangId}/counsel|shuttle|coupons/{id}   기록 1건 = 문서 1개
       dojangs/{dojangId}/meta/{설정문서}                설정·단가표·문구·로그·계정
       dojangs/{dojangId}/meta/usage                     기기별 무료 한도 추정 사용량 합산(관리자 전용 · 5분 간격)
       dojangs/{dojangId}/roles/{uid}                    권한(관리자) — 'admin' 이 아니면 서버로 아무것도 보내지 않는다
     · 기기 로컬 전용(절대 업로드하지 않음) — tdk.fbLastSync.v1(컬렉션별 마지막 동기화 시각) 포함
       그리고 이 엔진의 상태 키(tdk.fb*.v1)
   · 문서마다 `_ver`(문서 버전) · `_updatedAt` · `_updatedBy`(기기 ID) ·
     `_fieldMeta`(필드별 버전/수정시각/수정기기)를 붙여,
     PC·태블릿·폰이 같은 관원의 서로 다른 칸을 동시에 고쳐도 두 변경이 모두 살아남습니다.
   · 무료(Spark) 한도: 읽기 5만/일, 쓰기 2만/일, 삭제 2만/일 — 80% 경고, 100%에서
     자동 유료 전환 없이 동기화만 멈추고 로컬 큐에 보관합니다.
   ============================================================================= */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(root); }
  else { root.TDKFirebaseSync = factory(root); }
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this), function (root) {
  'use strict';

  var VERSION = '1.9.0';   /* v55 — 출결 툼스톤 격리 · 필드 비우기 전파 · 복원 그림자 재조정 · 합산 한도 차단 · flush 재진입 · 분할 업로드 소량화 */

  /* ---------- 무료(Spark) 한도 ---------- */
  var SPARK = {
    reads: 50000,     /* 문서 읽기 / 일 */
    writes: 20000,    /* 문서 쓰기 / 일 */
    deletes: 20000,   /* 문서 삭제 / 일 */
    warnRatio: 0.8,   /* 80% 경고 */
    maxBatch: 500     /* Firestore 배치 1회 최대 쓰기 수 */
  };

  var REFRESH_MS = 150;        /* 원격 변경을 모아서 한 번에 화면에 반영 */
  /* v50 — 원격 변경이 계속 이어질 때 화면 다시 그리기를 기다리는 최대 시간(ms).
     로그인 직후처럼 수백 건이 여러 번에 나뉘어 들어와도 이 시간마다 한 번씩만 그린다. */
  var REFRESH_MAX_MS = 1200;
  /* v50 — 한 번에 들어온 스냅샷을 몇 건씩 끊어 반영할지 (그 사이 화면·터치가 살아 있게) */
  var SNAPSHOT_CHUNK = 120;
  /* v50 — 읽기 사용량을 몇 건씩 모아서 저장할지 (문서마다 localStorage 쓰기를 하지 않게) */
  var READ_FLUSH_EVERY = 40;
  var DUPLICATE_WINDOW_MS = 6000;  /* 같은 출결 이벤트 중복 차단 창(보조 안전장치) */
  /* v51 — 대량 삭제(툼스톤) 방지 안전장치
     · 한 컬렉션 그림자 문서의 20% 이상을 한 번에 삭제 표시하려 하면 그 컬렉션의 삭제를 막는다.
     · 그림자가 10건 미만인 작은 컬렉션에는 적용하지 않는다(정상적인 소규모 정리가 막히지 않게).
     · 원생 1~2명 정리·중복 정리처럼 작은 삭제는 그대로 지나간다. */
  var BULK_DELETE_RATIO = 0.2;
  var BULK_DELETE_MIN_DOCS = 10;
  /* v52 — 시각 없는 수동·CSV 출석(출석부 칸 눌러 표시 · 월별 출결 CSV 가져오기)을 서버에 남기기 위한
     자리표시 시각.
       · firestore.rules 의 validEvent() 가 time 을 필수(5자 · 00:00~23:59)로 요구하므로
         "시각 없음"을 규칙 밖 값으로는 표현할 수 없다 → 규칙 안에서만 00:00 을 쓴다.
         (kind: 'manual' 이나 time: '' 같은 새 값은 라이브 규칙에서 permission-denied 다)
       · manual === true 이고 time === '00:00' 이면 "출석만 있고 시각은 모름"으로 읽는다.
         앱에는 등원 시각이 아니라 「수동」으로 나오고, 월간 출석부에는 ● 만 찍힌다.
       · 진짜 00:00 등원과 헷갈릴 일은 없다(도장은 자정에 열지 않는다). 시각이 있는 기록은
         언제나 실제 시각을 그대로 쓴다. */
  var NO_TIME = '00:00';
  /* v52 — 과거 수동·CSV 출결(약 11,800건)의 최초 업로드 안전장치
       · 한 번에 EVENT_UPLOAD.chunk 건까지만 큐에 넣고, 보낸 뒤 다음 차례에 이어서 넣는다
       · 전체 기기 합산 쓰기가 (하루 한도 - reserveWrites) 에 닿으면 오늘은 멈춘다
         → 정상 출결·원생·원비 쓰기가 무료 한도에 밀리지 않는다(자동 유료 전환 없음)
       · 오늘 날짜의 수동 출결은 이 큐를 거치지 않고 곧바로 올라간다(capture)
       · 시작 직후 delayMs 는 다른 기기가 이미 올려 둔 기록을 받아 보고(델타·meta/usage) 중복 업로드를 피하는 시간이다 */
  var EVENT_UPLOAD = {
    /* v55 — 한 번에 큐에 넣는 양을 1,500 → 240 으로 줄였다.
       도장 PC 에서 "대기 900여 건"이 쌓이며 화면이 버벅이던 원인은, 1,500건을 한꺼번에
       아웃박스에 넣으면서 (a) 큐 전체를 localStorage 에 다시 쓰고 (b) 상태 표시·flush 가
       1,500건짜리 목록을 매번 훑은 것이다. 이제 한 번에 한 배치(500)보다 적은 240건만 넣고,
       큐가 비어 있을 때 다음 묶음을 넣는다. 전체 건수는 그대로 다 올라간다(느긋하게 나눠서). */
    chunk: 240,
    /* 큐에 이만큼(전송 대기)이 남아 있으면 다음 묶음을 넣지 않고 기다린다 — 큐가 불어나지 않게 */
    maxQueued: 480,
    reserveWrites: 4000,
    delayMs: 45000,
    intervalMs: 90000,   /* 큐가 아직 남아 있을 때 다음 묶음까지 기다리는 시간 */
    stepMs: 20000,       /* v55 — 앞 묶음을 다 보냈으면(큐 비었음) 더 빨리 다음 묶음 (화면은 계속 가볍게) */
    retryMs: 600000
  };
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

  /* v49 — 시간 제한 장치. 끝나지 않는 네트워크·모듈 내려받기가 화면을 영원히 잡아두지 않게
     제한 시간이 지나면 reject 한다(이미 늦게 끝난 작업의 결과는 버린다). */
  function withinTime(promise, ms, makeError) {
    var limit = Number(ms) > 0 ? Number(ms) : 8000;
    return new Promise(function (resolve, reject) {
      var settled = false;
      var timer = null;
      function done(fn, value) {
        if (settled) { return; }
        settled = true;
        if (timer) { try { clearTimeout(timer); } catch (e) {} timer = null; }
        fn(value);
      }
      try {
        timer = setTimeout(function () {
          done(reject, (typeof makeError === 'function')
            ? makeError()
            : { code: 'timeout', message: limit + 'ms 안에 응답이 없습니다' });
        }, limit);
      } catch (e) { timer = null; }
      Promise.resolve(promise).then(function (v) { done(resolve, v); }, function (err) { done(reject, err); });
    });
  }

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
  /* v53 — 문서의 `_updatedAt`(isoOf 형식: 기기 지역 시각 + 'Z')을 ms 로 읽는다.
     new Date()/Date.parse() 는 이 값을 UTC 로 해석해 시차만큼 어긋난다(한국이면 9시간).
     앱은 같은 눈금(기기의 지역 시각)으로 비교하므로 여기서도 그 눈금으로 맞춘다. */
  function docTimeMs(iso) {
    var s = String(iso == null ? '' : iso);
    var m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z?$/.exec(s);
    if (!m) { return 0; }
    var t = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], +(m[7] || 0)).getTime();
    return isFinite(t) ? t : 0;
  }
  /* v53 — 새 기기가 처음 받을 원비의 시작 월(지난 달) — 'YYYY-MM'
     (원비 문서 ID 가 `YYYY-MM_원생ID` 라 documentId 범위로 최근 몇 달만 읽을 수 있다) */
  function tuitionRecentFrom(nowMs) {
    var d = new Date(nowMs == null ? Date.now() : nowMs);
    d.setDate(1);
    d.setMonth(d.getMonth() - 1);
    return d.getFullYear() + '-' + p2(d.getMonth() + 1);
  }
  /* v53 — 지연 묶음(상담·차량·쿠폰·전체 원비)을 열고 첫 스냅샷을 기다리는 한도 */
  var LAZY_READY_TIMEOUT_MS = 9000;
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
    /* v53 — 하루 150~300건씩 나가던 부수 쓰기/읽기를 줄인다.
       1분 → 5분, 임계값 20건. 한도에 닿았을 때(blocked)·날짜가 바뀌었을 때는
       임계값과 무관하게 바로 올리므로 다른 기기가 한도 초과를 늦게 아는 일은 없다. */
    minReads: 20,          /* 이만큼 쌓였을 때만 서버에 올린다 (쓰기 한도 보호) */
    minWrites: 20,
    minDeletes: 20,
    intervalMs: 300000,    /* 두 번 올리는 사이 최소 간격 — 5분 */
    /* v55 — 이 기기 계량기뿐 아니라 기기 합산(meta/usage)이 한도에 가까워지면 동기화를 멈춘다.
       95% 에서 멈추고 capture(로컬 저장)는 계속하므로 기록은 잃지 않는다. 5% 는 여유분이다
       (규칙 get()·0건 쿼리처럼 계량기에 안 잡히는 과금이 있어 실제 사용량이 더 클 수 있다). */
    blockTotalPct: 0.95,
    warnTotalPct: 0.9,
    tickMs: 60000,         /* 간격이 차면 스스로 한 번 확인하는 주기 */
    debounceMs: 3000,      /* 사용량이 늘어난 직후 몰아서 한 번 */
    logDeferMs: 2500       /* (참고) 문자 로그 묶음 저장 간격 — 문자 로그 절감 항목에서 쓴다 */
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

  /* 이번에 서버로 올릴지 판단 — 5분 간격 · 최소 변화량(20건) · 차단 상태 변화
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
    /* 한도 초과(blocked)는 드물고 중요하므로 5분 간격을 기다리지 않고 바로 알린다 */
    if (!!l.blocked !== !!lastSent.blocked) { return { push: true, reason: 'blocked' }; }
    if (String(l.date || '') !== String(lastSent.date || '')) { changed = 'new-day'; }
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
    /* v48 — 첫 화면 로그인의 흔한 실패는 짧고 알아보기 쉽게 */
    if (/api-key-not-valid|invalid-api-key/i.test(e.code + ' ' + e.message)) {
      return '이 기기에 저장된 firebaseConfig 가 올바르지 않습니다(API 키·프로젝트 ID 확인)';
    }
    if (/auth\/invalid-credential|auth\/wrong-password|auth\/user-not-found|invalid_login_credentials/i.test(e.code + ' ' + e.message)) {
      return '이메일 또는 비밀번호가 맞지 않습니다';
    }
    if (/auth\/invalid-email/i.test(e.code + ' ' + e.message)) { return '이메일 형식을 확인해 주세요'; }
    if (/auth\/too-many-requests/i.test(e.code + ' ' + e.message)) {
      return '로그인 시도가 너무 많습니다 — 잠시 뒤 다시 시도해 주세요';
    }
    if (/auth\/user-disabled/i.test(e.code + ' ' + e.message)) { return '이 계정은 사용 중지되었습니다'; }
    return (e.code ? ('[' + e.code + '] ') : '') + (e.message || '오류');
  }
  function isQuotaError(err) {
    var e = normalizeError(err);
    return e.code === 'resource-exhausted' || /resource[- ]exhausted|quota|daily limit/i.test(e.message);
  }
  /* v55 — 다시 보내도 결과가 같은 오류(규칙 거부·형식 오류 등).
     이것 하나가 배치에 섞이면 firestore 배치가 원자적이라 같은 배치의 정상 기록까지
     전부 실패했다. 이런 오류만 골라 반씩 나눠(bisect) 문제 항목만 격리한다.
     네트워크·한도 오류는 잠시 뒤 다시 보내면 되므로 격리하지 않는다. */
  function isPermanentError(err) {
    var e = normalizeError(err);
    if (isQuotaError(err)) { return false; }
    var code = String(e.code || '').toLowerCase();
    if (code === 'permission-denied' || code === 'invalid-argument' || code === 'failed-precondition' ||
        code === 'out-of-range' || code === 'unimplemented' || code === 'data-loss') {
      return true;
    }
    return /permission|invalid argument|invalid-argument/i.test(e.message);
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
     · v44 — 얼굴인식 데이터(tdk.faces.v1 · tdk.adminFace.v1)는 앱에서 사라졌다.
       예전 기기에 남아 있어도 올리지 않고, 앱이 시작할 때 localStorage 에서 지운다.
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
    { name: 'muted', key: 'tdk.muted.v1', label: '효과음 끔', icon: '🔇', kind: 'value', meta: 'muted', desc: 'meta/muted' }
    /* v43 — kioskStudents·kioskConfig(태블릿용 사본)는 더 만들지도 구독하지도 않는다.
       모든 기기가 관리자 계정으로 students 원본을 그대로 받는다 */
  ];

  /* 엔진이 스스로 저장하는 기기 로컬 키 (동기화 대상 아님) */
  var LOCAL_KEYS = {
    'tdk.fbConfig.v1': 1, 'tdk.fbDevice.v1': 1, 'tdk.fbUsage.v1': 1,
    'tdk.fbOutbox.v1': 1, 'tdk.fbShadow.v1': 1, 'tdk.fbMock.v1': 1,
    'tdk.fbState.v1': 1,
    /* v51 — 드라이브 "이 기기 마지막 수정" 시각을 동기화되는 설정에서 떼어낸 기기 키 */
    'tdk.driveLocalAt.v1': 1
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
  /* v55 — 출결 시각을 라이브 규칙(validEvent)이 받는 모양으로 맞춘다.
       · 규칙: time 은 5자 `([01][0-9]|2[0-3]):[0-5][0-9]`
       · 예전 CSV·수동 기록에는 `9:30` 같은 4자 시각이 섞여 있다 → 만들기(create)가 거부되고
         그 한 건이 같은 배치의 정상 출결까지 막았다(배치는 원자적).
       · 해석할 수 없는 값은 '' 을 돌려주고, 부르는 쪽이 "시각 없음(00:00 + manual)"으로 처리한다 */
  function normEventTime(raw) {
    var s = String(raw == null ? '' : raw).trim();
    var m = /^(\d{1,2}):(\d{2})/.exec(s);
    if (!m) { return ''; }
    var h = num(m[1]), mi = num(m[2]);
    if (!(h >= 0 && h <= 23) || !(mi >= 0 && mi <= 59)) { return ''; }
    return (h < 10 ? '0' : '') + h + ':' + (mi < 10 ? '0' : '') + mi;
  }
  /* v55 — 출결 문서 ID 의 날짜가 규칙이 받는 모양(YYYY-MM-DD)인가 */
  function isEventDateKey(v) {
    return /^\d{4}-\d{2}-\d{2}$/.test(String(v == null ? '' : v));
  }
  /* v52 — 시각 없는 수동·CSV 출석을 나타내는 출결 문서인가
     (규칙이 time 을 필수로 요구해 자리표시 00:00 을 쓰므로 manual 로 구분한다) */
  function isDayOnlyEvent(body) {
    if (!body || typeof body !== 'object') { return false; }
    if (body.manual !== true) { return false; }
    return String(body.time || '').slice(0, 5) === NO_TIME;
  }

  /* ---------- v51 — 원비 문서 ID 해석 `YYYY-MM_{원생ID}` ----------
     예전에는 마지막 '_' 로 잘라(`firebase-sync.js` applyRemoteDoc) `2026-11_stu_xxx` 를
     월 `2026-11_stu` · 원생 `xxx` 로 나눴다. 앱(loadTuition)은 `^\d{4}-\d{2}$` 가 아닌 월 키를
     버리므로 원비가 다른 기기·화면에 절대 나타나지 않았고, 그 상태에서 원비를 한 번 고치면
     서버 원비가 대량 삭제 표시되는 위험까지 있었다.
     · 월은 항상 앞 7자(`YYYY-MM`) — 8번째 글자가 '_' 인지 함께 확인한다
     · 형태가 다르면 null 을 돌려주고 쓰지 않는다(잘못된 키를 새로 만들지 않는다) */
  var TUITION_MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
  var TUITION_DOC_RE = /^(\d{4}-(0[1-9]|1[0-2]))_(.+)$/;
  function isTuitionMonthKey(v) { return TUITION_MONTH_RE.test(String(v == null ? '' : v)); }
  function parseTuitionDocId(docId) {
    var m = TUITION_DOC_RE.exec(String(docId == null ? '' : docId));
    if (!m) { return null; }
    var sid = String(m[3]).replace(/^\s+|\s+$/g, '');
    if (!sid) { return null; }
    return { month: m[1], studentId: sid };
  }
  /* 기기에 잘못된 월 키가 하나라도 있는지 — 대부분의 기기는 없으므로 빠르게 건너뛴다 */
  function tuitionNeedsRepair(value) {
    if (!isPlain(value)) { return false; }
    var keys = Object.keys(value);
    for (var i = 0; i < keys.length; i++) {
      if (!isTuitionMonthKey(keys[i])) { return true; }
    }
    return false;
  }
  /* 예전 버그가 남긴 잘못된 월 키(`2026-11_stu` + 원생 `mwp7…`)를 제자리로 돌린다.
         { '2026-11_stu': { 'mwp7…': 기록 } }  →  { '2026-11': { 'stu_mwp7…': 기록 } }
     · 제대로 된 월 키에 이미 있는 기록이 이긴다(정상 경로 우선)
     · 해석할 수 없는 키는 버린다 */
  function normalizeTuitionMap(value) {
    var months = isPlain(value) ? value : {};
    var out = {};
    var repaired = [];
    var changed = false;
    Object.keys(months).forEach(function (mk) {
      var month = months[mk];
      if (!isPlain(month)) { changed = true; return; }
      if (isTuitionMonthKey(mk)) {
        if (!out[mk]) { out[mk] = {}; }
        Object.keys(month).forEach(function (sid) {
          if (isPlain(month[sid])) { out[mk][sid] = month[sid]; }
        });
        return;
      }
      changed = true;
      var m = /^(\d{4}-(0[1-9]|1[0-2]))_(.+)$/.exec(mk);
      if (m) { repaired.push({ month: m[1], prefix: String(m[3]) + '_', recs: month }); }
    });
    repaired.forEach(function (r) {
      if (!out[r.month]) { out[r.month] = {}; }
      Object.keys(r.recs).forEach(function (sid) {
        if (!isPlain(r.recs[sid])) { return; }
        var id = r.prefix + sid;
        if (!hasOwn(out[r.month], id)) { out[r.month][id] = r.recs[sid]; }
      });
    });
    return { months: out, changed: changed };
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
        /* v55 — 규칙이 날짜 YYYY-MM-DD(10자)를 요구한다. 형태가 다른 날짜 키는 문서를 만들지 않는다
           (만들면 permission-denied 로 배치 전체가 막힌다). */
        if (!isEventDateKey(date)) { return; }
        Object.keys(day).forEach(function (sid) {
          var e = day[sid];
          if (!isPlain(e)) { return; }
          if (!sid) { return; }
          /* v55 — 시각은 규칙 모양(HH:MM)으로 맞춘다. `9:30` → `09:30`, 해석 불가는 '' */
          var inT = normEventTime(att ? e.inTime : e.in);
          var outT = normEventTime(att ? e.outTime : e.out);
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
          /* v52 — 시각 없는 수동·CSV 출석도 문서 하나로 남긴다 (예전에는 문서를 만들지 않아
             과거 월별 출석부가 서버에 없었다). 규칙이 time 을 필수로 요구하므로
             자리표시 시각(NO_TIME=00:00) + manual: true 로 "출석만 있고 시각은 모름"을 나타낸다.
             · ctx.skipDayOnly  → 아예 만들지 않는다(그림자 씨앗: 어차피 올리지 않는 기록)
             · ctx.skipOldDayOnly → 오늘 이전 기록은 "있음"만 알리는 표시(body:null)로 넣는다
               (capture 가 11,800건을 매번 해시하지 않게 하면서, 툼스톤 오판은 막는다) */
          if (manual && !inT && !outT) {
            if (ctx && ctx.skipDayOnly) { return; }
            var dayId = eventIdOf(date, sid, 'in');
            var dayPath = collPath('attendanceEvents') + '/' + dayId;
            if (ctx && ctx.skipOldDayOnly && date < String(ctx.today || '')) {
              docs.push({ id: dayId, path: dayPath, body: null });
              return;
            }
            docs.push({
              id: dayId,
              path: dayPath,
              body: {
                date: date, studentId: sid, kind: 'in', time: NO_TIME,
                eventId: dayId, source: src, manual: true, deviceId: did
              }
            });
          }
        });
      });
      return docs;
    }

    if (entry.kind === 'tuition') {
      /* v51 — 잘못된 월 키(`2026-11_stu` 같은 것)는 올바른 자리로 돌려서 문서를 만든다.
         그대로 두면 정상 문서가 "사라진 것"으로 보여 대량 툼스톤이 만들어질 수 있다. */
      var months = tuitionNeedsRepair(value) ? normalizeTuitionMap(value).months : (isPlain(value) ? value : {});
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
      docs.push({ id: entry.meta, path: base + '/meta/' + safeId(entry.meta), body: body });
      return docs;
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
        /* v52 — body:null 은 "있음"만 알리는 표시 — 실제 문서가 있으면 그것이 이긴다 */
        if (!prev.body || !d.body) {
          if (!prev.body && d.body) { map[d.path] = d; }
          return;
        }
        /* v52 — 같은 날짜·원생의 "시각 있음" 기록이 "시각 없음(자리표시)" 보다 낫다 */
        if (isDayOnlyEvent(prev.body) && !isDayOnlyEvent(d.body)) { map[d.path] = d; return; }
        if (isDayOnlyEvent(d.body) && !isDayOnlyEvent(prev.body)) { return; }
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
        if (s.level >= 2) { return true; }
        /* v55 — 이 기기 계량기뿐 아니라 전체 기기 합산(meta/usage)도 본다.
           PC 60% + 폰 60% = 실제 120%인데 양쪽 다 계속 보내던 구멍을 막는다(95%에서 멈춤). */
        if (num(s.totalMaxPct) >= USAGE_SYNC.blockTotalPct) { return true; }
        return false;
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

    /* v55 — 여러 건을 한 번에 넣는다(capture·분할 업로더). 예전에는 건마다 persist()
       (큐 전체 JSON 직렬화 + localStorage 쓰기)를 해서 1,500건이면 O(n²) 로 멈췄다. */
    function enqueueMany(ops) {
      var made = [];
      var list = Array.isArray(ops) ? ops : [];
      if (!list.length) { return made; }
      var drop = {};
      list.forEach(function (op) {
        if (op && op.path) { drop[String(op.path)] = 1; }
      });
      if (Object.keys(drop).length) {
        /* 같은 문서에 대한 이전 대기 항목은 마지막 것만 남긴다 (무료 쓰기·큐 크기 절약) */
        state.items = state.items.filter(function (it) {
          return !(it.state === 'pending' && drop[it.path]);
        });
      }
      list.forEach(function (op) {
        if (!op) { return; }
        var path = String(op.path || '');
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
        made.push(item);
      });
      persist();
      return made;
    }

    return {
      list: function () { return clone(state.items) || []; },
      /* v55 — 화면(대기 목록)은 마지막 몇 건만 보여 준다. list() 는 900건이면 그 전체를
         깊은 복사하느라 화면이 멈췄다. recent(n) 은 뒤에서 n건만 얕게 돌려준다. */
      recent: function (n) {
        var out = [];
        var want = Math.max(0, num(n) || 40);
        for (var i = state.items.length - 1; i >= 0 && out.length < want; i--) {
          var it = state.items[i];
          if (!it || it.state === 'sent') { continue; }
          out.push({ id: it.id, path: it.path, state: it.state, at: it.at, attempts: it.attempts, error: it.error });
        }
        return out;
      },
      /* dead = 서버가 영구 거부한 항목(격리). 다시 시도하지 않고, 대기 건수에도 세지 않는다 */
      pending: function () {
        return state.items.filter(function (it) { return it.state !== 'sent' && it.state !== 'dead'; });
      },
      count: function () {
        var n = 0;
        state.items.forEach(function (it) { if (it.state !== 'sent' && it.state !== 'dead') { n++; } });
        return n;
      },
      deadCount: function () {
        var n = 0;
        state.items.forEach(function (it) { if (it.state === 'dead') { n++; } });
        return n;
      },
      dead: function (limit) {
        var out = [];
        var want = Math.max(0, num(limit) || 20);
        state.items.forEach(function (it) {
          if (out.length >= want) { return; }
          if (it.state !== 'dead') { return; }
          out.push({ id: it.id, path: it.path, at: it.at, attempts: it.attempts, error: it.error });
        });
        return out;
      },
      summary: function () {
        var s = { pending: 0, failed: 0, unacked: 0, sent: 0, dead: 0, oldestAt: '' };
        state.items.forEach(function (it) {
          if (it.state === 'sent') { s.sent++; return; }
          if (it.state === 'dead') { s.dead++; return; }
          if (it.state === 'failed') { s.failed++; }
          else if (it.state === 'sent-unacked') { s.unacked++; }
          else { s.pending++; }
          if (!s.oldestAt || it.at < s.oldestAt) { s.oldestAt = it.at; }
        });
        return s;
      },
      enqueue: function (op) { return enqueueMany([op])[0]; },
      enqueueMany: function (ops) { return enqueueMany(ops); },
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
          if (it.state === 'failed' || it.state === 'dead') { it.state = 'pending'; it.error = ''; }
        });
        persist();
      },
      /* v55 — 영구 거부(dead)로 격리된 항목만 다시 보낸다(사용자가 원인을 고친 뒤) */
      retryDead: function () {
        var n = 0;
        state.items.forEach(function (it) {
          if (it.state !== 'dead') { return; }
          it.state = 'pending'; it.error = ''; it.attempts = 0; n++;
        });
        if (n) { persist(); }
        return n;
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
      /* 사용량이 늘었으면 잠시 뒤 한 번만 합산 문서에 올려 본다(5분 간격·최소 변화량은 pushUsageNow 가 판단) */
      scheduleUsagePush();
    };
    /* v50 — 읽기 사용량은 모아서 한 번에 기록한다.
       문서 1건마다 localStorage 를 다시 쓰면(JSON.stringify + setItem) 687건 스냅샷에서
       그것만으로 수백 ms~수 초가 걸린다. 모아 두었다가 READ_FLUSH_EVERY 건마다 / 묶음이 끝날 때 기록. */
    var pendingReads = 0;
    function noteReads(n) {
      pendingReads += Math.max(0, num(n) || 0);
      if (pendingReads >= READ_FLUSH_EVERY) { flushReads(); }
    }
    function flushReads() {
      if (!pendingReads) { return 0; }
      var n = pendingReads;
      pendingReads = 0;
      try { usage.record('reads', n); } catch (e) {}
      return n;
    }
    var deviceId = opts.deviceId || 'dev_local';
    var dojangId = safeId(opts.dojangId || 'mta-tkd');
    /* 서버(dojangs/{도장}/roles/{uid})에서 확인한 역할
         null = 아직 확인 전 · '' = 로그인은 됐는데 roles 문서가 없거나 관리자가 아님 · 'admin'
       v43 — 태블릿 역할은 없어졌다. 모든 기기가 같은 관리자 계정으로 연결되고,
              서버 roles 가 'admin' 일 때만 동기화한다. */
    var verifiedRole = (opts.verifiedRole === 'admin') ? 'admin' : null;
    /* 시작할 때 서버 roles 를 자동으로 확인할지 (테스트에서 순서를 직접 잡을 때만 false) */
    var verifyOnStart = opts.verifyOnStart !== false;
    var adapter = opts.adapter || null;

    /* ---------- 기기별 사용량 합산 (dojangs/{도장}/meta/usage) ----------
       · 관리자로 확인된 기기에서만 읽고 쓴다. 태블릿은 규칙상 meta 를 읽을 수 없으므로
         meta/usage 구독·쓰기를 아예 시도하지 않는다(오류도 내지 않는다).
       · 이 문서의 쓰기·수신은 계량기(tdk.fbUsage.v1)에 넣지 않는다 —
         합산 문서 자체가 사용량을 늘려 다시 쓰는 되먹임 고리를 막기 위해서다.
       · 올리기는 최소 5분 간격 + 읽기·쓰기·삭제 각 20건 이상 변화일 때만(차단 상태 변화는 바로).
       · v55 — 이 기기 계기판이 아니라 기기 합산이 95%를 넘으면 flush 를 멈춘다(다른 기기 몫까지 고려). */
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
      /* v55 — 기기 합산이 한도에 가까워 동기화를 멈춘 상태인지(화면 문구용) */
      s.totalBlockPct = USAGE_SYNC.blockTotalPct;
      s.totalBlock = v.maxPct >= USAGE_SYNC.blockTotalPct && !s.blocked;
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
      var body = { date: entry.date, devices: devices };
      /* v52 — 과거 출결 업로드를 마쳤다면 그 건수를 함께 적는다 → 다른 기기가 같은 기록을
         또 올리지 않는다(건수 비교라 중간 달이 빠지는 잘못된 생략이 없다) */
      if (eventPump.marker) { body.events = clone(eventPump.marker) || eventPump.marker; }
      return body;
    }

    /* 한 번 올려 본다. force 를 주면 간격·변화량 판단을 건너뛴다(진단용).
       어떤 실패든 조용히 넘긴다 — 화면 경고·동기화 상태·전송 큐를 건드리지 않는다. */
    function pushUsageNow(force) {
      var reason = usageSyncReason();
      if (reason) { return Promise.resolve({ ok: false, pushed: false, reason: reason, skipped: true }); }
      if (usageSync.busy) { return Promise.resolve({ ok: false, pushed: false, reason: 'busy' }); }
      /* v55 — 한도에 막힌 상태에서는 합산 문서 쓰기도 하지 않는다(5분마다 실패를 반복하던 것).
         단 "막혔다"는 사실은 한 번은 알려야 다른 기기가 같이 멈춘다 — 이미 막힘을 올렸으면 건너뛴다. */
      try {
        if (usage.blocked() && usageSync.last && usageSync.last.blocked) {
          return Promise.resolve({ ok: false, pushed: false, reason: 'quota', skipped: true });
        }
      } catch (e) {}
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
    var shadowCount = 0;          /* 그림자 항목 수 — trimShadow 가 매번 Object.keys 를 만들지 않게 */
    var shadowSinceTrim = 0;      /* 마지막 정리 뒤 새로 늘어난 항목 수 */
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
    /* v55 — 받아 두지 않은 범위라 보류한 삭제를 묶음을 연 뒤 한 번 더 시도할 때의 중복 방지 */
    var captureRetryQueued = {};
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
    /* v53 — 문자 로그(meta/logs) 묶음 저장
       ------------------------------------------------------------------
       출석 1건이면 문자 로그 문서가 queued → sent(또는 error) 로 2~3번 바뀌고,
       지금까지는 그때마다 최근 200건 배열 전체를 meta/logs 에 다시 썼다(하루 출석 100명이면
       쓰기 200~300건이 이것만으로 나간다). 로그는 "보기용 기록"이라 조금 늦게 올라가도
       되므로, 마지막 변경에서 2.5초 모았다가 한 번만 쓴다.
         · 문자 발송·재전송·화면 로그 표시는 그대로 (로컬 배열은 즉시 바뀐다)
         · 묶음을 기다리는 사이 다른 저장(출석 등)이 먼저 나가면 flush 가 함께 실어 보낸다
         · 앱을 닫으면(stop) 남은 묶음을 즉시 반영한다 */
    var deferredEntries = null;      /* { [이름]: true } — 곧 올릴 항목 */
    var deferredTimer = null;
    var deferredCaptured = 0;        /* 진단용: 묶어서 처리한 횟수 */
    var flushTimer = null, reloadTimer = null, reloadPending = false, reloadFirstAt = 0;
    var lastEventAt = {};
    var lastError = '';
    var lastErrorKind = '';
    /* v51 — 드라이브 복원 중 업로드 차단 플래그 (applyBackup 이 켜고 끈다) */
    var suppressCapture = false;
    var suppressedKeys = {};
    var restoreAt = '';
    /* v51 — 해석하지 못한 원비 문서 ID(잘못된 형태) 진단용 · 대량 삭제 차단 상태 */
    var skippedTuitionIds = 0;
    var lastSkippedTuitionId = '';
    var bulkDeleteBlocked = null;
    /* v55 — 사용자가 명시적으로 확인한 "대량 삭제 1회 허용" 통로와, 받아 두지 않은 범위라
       보류한 삭제 목록. 둘 다 진단·화면 표시용으로 남긴다. */
    var bulkApproval = null;      /* { at, collections:{이름:1}|null, once:true, src } */
    var deleteHeld = null;        /* { at, key, count, collections:['tuition'], message } */
    /* v55 — 받지 않은 범위라 보류한 삭제의 "의도"를 경로별로 기억한다.
       묶음을 열어 받아 오면 그 문서가 로컬에 다시 들어오므로(서버 값), 의도를 따로 남겨 두었다가
       그때 다시 지운다. 이게 없으면 사용자는 "지웠는데 다시 나타났다"를 겪는다. */
    var pendingDeletes = {};      /* path → { at, key, coll } */
    var restoreReconciled = null; /* 복원 직후 그림자 재조정 결과(진단용) */
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

    /* ---------- 유효 권한 (서버 roles 기준 · 관리자 단일) ----------
       v43 — 태블릿 역할은 없다. 모든 기기가 같은 관리자 계정으로 로그인하고,
          실제 Firebase 모드(requireServerRole)에서는 로그인한 uid 의 roles/{uid} 가
          'admin' 일 때만 관리자로 동작한다. 문서가 없거나 다른 역할이면 'none' 으로
          잠가 서버로 아무것도 보내지 않는다(firestore.rules 가 서버에서 한 번 더 막는다). */
    function requireServerRole() {
      return opts.requireServerRole === true || !!(adapter && adapter.mode === 'firestore');
    }
    function effectiveRole() {
      if (verifiedRole === 'admin') { return 'admin'; }
      /* 서버 역할을 확인하지 못했다 → 실제 Firebase 에서는 아무 권한도 주지 않는다 */
      if (requireServerRole()) { return 'none'; }
      /* 모의(연습) 모드: 서버 계정이 없으니 관리자로 연습한다 */
      return 'admin';
    }
    function isEffectiveAdmin() { return effectiveRole() === 'admin'; }
    function pathColl(path) {
      var seg = String(path || '').split('/');
      return seg.length >= 4 ? seg[2] : '';
    }
    /* 실패 항목 비우기 — 「서버 규칙 거부 등으로 실패한 항목」만 지운다.
       · state 가 'failed' 인 항목만 지운다
       · state 가 'pending' 인 항목(아직 보내지 않은 기록)은 절대 건드리지 않는다
       · 실패가 하나도 남지 않으면 경고등을 꺼 배지가 🟢 로 돌아온다 */
    function clearFailed() {
      var removed = outbox.dropWhere(function (it) { return it.state === 'failed'; });
      var sum = outbox.summary();
      if (!sum.failed) { lastError = ''; lastErrorKind = ''; }
      emit('queue-cleared', { removed: removed, failed: sum.failed, queued: outbox.count(), role: effectiveRole() });
      return { ok: true, removed: removed, failed: sum.failed, queued: outbox.count(), role: effectiveRole() };
    }

    /* 서버 roles/{uid} 확인 결과 반영 — 'admin' 만 관리자, 그 밖은 잠금('') */
    function applyVerifiedRole(v) {
      var next = (v === 'admin') ? 'admin' : '';
      var before = effectiveRole();
      verifiedRole = next;
      var after = effectiveRole();
      if (after !== before) {
        if (adapter && typeof adapter.setRole === 'function') { try { adapter.setRole(after); } catch (e) {} }
        resubscribe();
        emit('role', { role: after, verified: verifiedRole });
        /* 잠겨 있는 동안(역할 미확인)에 기기에서 고친 내용을 역할이 풀리는 순간 한 번 훑는다 */
        if (after === 'admin') { rescanLocal(); scheduleUsagePush(1500); }
      }
      return after;
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

    /* 로그인한 계정의 roles/{uid} 문서를 서버에서 직접 읽어 유효 권한을 잠근다
       ----------------------------------------------------------------
       v53 — 부팅 때 엔진(start → verifyOnStart)과 첫 화면 로그인 관문(firebase-sync-ui 의
       verifyAdminNow)이 같은 roles/{uid} 를 두 번 읽던 것을 한 번으로 합쳤다.
         · 읽는 중이면 그 약속을 같이 쓴다 (같은 순간 두 곳이 불러도 getDoc 1회)
         · 방금 admin 으로 확인된 결과는 10분 동안 다시 읽지 않는다
         · verifyRole(true) 로 강제 재확인할 수 있다 */
    var ROLE_CHECK_TTL_MS = 10 * 60 * 1000;
    var roleCheckState = { uid: '', at: 0, promise: null, result: null, reads: 0 };
    function currentAuthUid() {
      try {
        var cu = (adapter && typeof adapter.currentUser === 'function') ? adapter.currentUser() : null;
        return cu && cu.uid ? String(cu.uid) : '';
      } catch (e) { return ''; }
    }
    function verifyRole(force) {
      var uid = currentAuthUid();
      var st = roleCheckState;
      if (!force) {
        if (st.promise && st.uid === uid) { return st.promise; }          /* 진행 중 — 같은 읽기를 함께 씀 */
        var age = now() - num(st.at);
        if (uid && st.uid === uid && st.result && st.result.verified === 'admin' &&
            age >= 0 && age < ROLE_CHECK_TTL_MS) {
          /* 방금 확인한 관리자 — 서버를 다시 읽지 않는다 */
          var cached = clone(st.result);
          cached.reused = true;
          return Promise.resolve(cached);
        }
      }
      var p = verifyRoleOnce();
      roleCheckState = { uid: uid, at: 0, promise: p, result: null, reads: num(st.reads) };
      p.then(function (r) {
        if (roleCheckState.promise !== p) { return; }
        roleCheckState.promise = null;
        roleCheckState.at = now();
        roleCheckState.result = (r && r.verified === 'admin') ? clone(r) : null;
        roleCheckState.uid = String((r && r.uid) || uid || '');
      }, function () {
        if (roleCheckState.promise === p) { roleCheckState.promise = null; }
      });
      return p;
    }
    function verifyRoleOnce() {
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
      roleCheckState.reads = num(roleCheckState.reads) + 1;
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
    /* ---------- v51 — 드라이브 복원 중 업로드 차단 · 복원 뒤 서버와 다시 맞추기 ----------
       drive(applyBackup) 복원은 로컬 키를 통째로 다시 쓴다. 그 쓰기를 그대로 올리면
       복원본이 `_ver+1` 로 서버·다른 기기를 덮어썼다(역류).
       · setSuppressCapture(true)  → 복원 중: 로컬 쓰기를 올리지 않고 키 이름만 모아 둔다
       · setSuppressCapture(false, { since }) → 복원 끝: 올리지 않은 대신 델타 기준을
         복원본의 시각(백업 exportedAt)으로 당겨, 서버에서 그 뒤 바뀐 문서만 다시 받아
         서버 쪽 최신 값과 필드 단위로 안전하게 맞춘다(로컬 떠밀기 없음). */
    function rewindDelta(sinceIsoRaw) {
      var t = Date.parse(String(sinceIsoRaw || ''));
      if (isNaN(t) || t <= 0) { return null; }
      if (lastSyncTimer) { try { clearTimeout(lastSyncTimer); } catch (e) {} lastSyncTimer = null; }
      var disk = readLastSync(storage);
      var next = {};
      Object.keys(disk).forEach(function (k) { next[k] = Math.min(num(disk[k]), t); });
      lastSyncMark = next;
      writeLastSync(storage, next);      /* 구독기는 이 값을 읽어 델타를 만든다 */
      return next;
    }
    function setSuppressCapture(on, options) {
      var o = options || {};
      if (on) {
        suppressCapture = true;
        restoreAt = isoOf(now());
        return { ok: true, suppressed: true, at: restoreAt };
      }
      var was = suppressCapture;
      suppressCapture = false;
      var keys = Object.keys(suppressedKeys);
      suppressedKeys = {};
      if (!was) { return { ok: true, suppressed: false, keys: [] }; }
      /* v55 — 복원 직후 그림자를 복원본에 맞게 다시 심는다.
         예전에는 로컬(LS)만 덮어쓰고 그림자는 그대로라, 어느 한 칸만 고쳐도 그 키의 모든 문서가
         "바뀐 것"으로 보여 옛 백업 값이 서버로 밀려 올라갔다(백업 뒤 다른 기기가 고친 값이 되돌아감).
         이제 복원본과 같은 내용은 그림자 해시가 맞아 아예 보내지 않고, 복원본에 없는 문서는
         그림자에서도 빼서 서버에서 지우지 않는다. */
      var rec = null;
      try { rec = reconcileShadow(keys); } catch (e) { rec = { error: errorText(e) }; }
      var since = String(o.since || restoreAt || '');
      var rewound = rewindDelta(since);
      if (rewound) { resubscribe(); }
      emit('restore-done', { at: isoOf(now()), since: since, keys: keys, rewound: !!rewound, shadow: rec });
      return { ok: true, suppressed: false, keys: keys, since: since, rewound: rewound, shadow: rec };
    }

    /* 복원한 키들의 그림자를 복원본 내용으로 새로 심는다(버전은 이전 그림자 값 유지 —
       나중에 고친 칸이 서버의 더 새 값을 이기려면 버전이 낮아지면 안 된다). */
    function reconcileShadow(names) {
      var base = basePath();
      var out = { keys: [], entries: 0, dropped: 0, ghosts: 0, at: isoOf(now()) };
      (names || []).forEach(function (n) {
        var e = entryByName(n);
        if (!e || e.kind === 'local') { return; }
        var prefix = (e.kind === 'object' || e.kind === 'value')
          ? (base + '/meta/' + safeId(e.meta))
          : (base + '/' + e.coll);
        var prevVers = {};
        Object.keys(shadow).forEach(function (p) {
          if (!(p === prefix || p.indexOf(prefix + '/') === 0)) { return; }
          var old = shadow[p];
          if (old && !old.d) { prevVers[p] = num(old.v); }
          if (old && old.d) { out.ghosts++; }      /* 서버가 지운 기록을 복원본이 되살린 경우 */
          delete shadow[p];
          out.dropped++;
        });
        function seed(p, body, hash) {
          putShadowEntry(p, {
            v: num(prevVers[p]), m: {}, u: '', by: '', d: false,
            h: hash, b: e.kind === 'events' ? null : mergeMetaBody(body, {}),
            t: body && body.time, r: 1
          });
          out.entries++;
        }
        if (e.kind === 'events') {
          var map = unionEventDocs(readValue('attendance'), readValue('records'), base, { deviceId: deviceId });
          Object.keys(map).forEach(function (p) {
            var b = map[p].body;
            if (!b) { return; }                    /* "있음" 표시는 그림자를 만들지 않는다 */
            seed(p, b, eventHash(b));
          });
        } else {
          docsForEntry(e, readValue(e.name), base, { deviceId: deviceId }).forEach(function (d) {
            if (!d.body) { return; }
            seed(d.path, d.body, contentHash(d.body));
          });
        }
        out.keys.push(n);
      });
      saveShadow();
      restoreReconciled = out;
      return out;
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
      /* v50 — saveShadow() 는 문서 1건마다 불린다. 그때마다 Object.keys(그림자 6,000여 개)를
         새로 만들면 그것만으로 수백 ms~수 초가 걸려 휴대폰 화면이 멈춘다.
         그래서 항목 수를 세어 두고, 400건 새로 늘었거나 한도를 넘겼을 때만 정리한다. */
      if (shadowCount <= SHADOW_MAX_ENTRIES && shadowSinceTrim < 400) { return; }
      shadowSinceTrim = 0;
      var keys = Object.keys(shadow);
      shadowCount = keys.length;
      if (keys.length <= SHADOW_MAX_ENTRIES) { return; }
      /* 너무 커지면 오래된 출결 문서부터 정리 (원격은 그대로 남아 있음) */
      keys.sort(function (a, b) {
        return String((shadow[a] && shadow[a].u) || '').localeCompare(String((shadow[b] && shadow[b].u) || ''));
      }).slice(0, keys.length - SHADOW_MAX_ENTRIES).forEach(function (k) { delete shadow[k]; });
      shadowCount = SHADOW_MAX_ENTRIES;
    }

    /* 그림자에 문서 상태를 적는다 — 새 항목이면 항목 수를 센다(trimShadow 를 가볍게) */
    function putShadowEntry(path, entry) {
      if (!shadow[path]) { shadowCount++; shadowSinceTrim++; }
      /* v55 — 서버에 있다고 확인된 표시(s=1)와 "복원본이라 칸별로만 보낸다" 표시(r=1)는
         항목을 새로 쓸 때 지정하지 않으면 이어 받는다 (지우려면 0 을 넣는다) */
      var prev = shadow[path];
      if (prev && isPlain(prev) && isPlain(entry)) {
        if (entry.s === undefined && prev.s) { entry.s = prev.s; }
        if (entry.r === undefined && prev.r) { entry.r = prev.r; }
      }
      shadow[path] = entry;
      return entry;
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
      shadowCount += taken;
      shadowSinceTrim += taken;
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
      flushReads();
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
      /* 관리자로 확인된 기기만 올린다 — 역할 미확인(로그인 전·roles 문서 없음·비관리자)이면
         출결까지 포함해 아무것도 보내지 않는다 */
      if (effectiveRole() !== 'admin') {
        emit('blocked-local', { key: entry.name, reason: 'role-unverified' });
        return;
      }
      var value = null;
      if (rawValue != null) { try { value = JSON.parse(rawValue); } catch (e) { value = null; } }
      prevValues[entry.name] = value;
      /* v51 — 드라이브 복원 중(applyBackup)에는 로컬 전량 쓰기를 서버로 올리지 않는다.
         올리면 복원본이 `_ver+1` 로 서버·다른 기기를 덮어썼다(역류). */
      if (suppressCapture) {
        suppressedKeys[entry.name] = 1;
        return;
      }
      if (!shadowLoaded) {
        /* 그림자를 읽어 오기 전이면 잠시 모아 두었다가 읽은 뒤 차례로 처리한다 */
        queuedCaptures[entry.name] = 1;
        return;
      }
      /* v53 — 문자 로그는 마지막 변경에서 2.5초 모아 한 번만 올린다 */
      if (scheduleDeferredCapture(entry)) { return; }
      capture(entry);
      scheduleFlush();
    }

    function liveDocsOf(entry, base) {
      if (entry.kind === 'events') {
        /* v52 — 오늘 이전의 시각 없는 수동·CSV 기록은 "있음"만 표시(body:null)로 받아
           매 체크인마다 11,800건을 해시하지 않는다(툼스톤 오판도 막는다). */
        var ctx = { deviceId: deviceId, skipOldDayOnly: true, today: dayOf(now()) };
        var map = unionEventDocs(readValue('attendance'), readValue('records'), base, ctx);
        return Object.keys(map).map(function (p) { return map[p]; });
      }
      return docsForEntry(entry, prevValues[entry.name], base, { deviceId: deviceId });
    }

    /* ---------- v53 — 문자 로그 묶음 저장 ----------
       로그(또는 deferMs 가 정해진 항목)는 곧바로 capture 하지 않고 잠깐 모아 둔다.
       테스트·진단에서는 engine.flushDeferred() 로 바로 반영할 수 있다. */
    function deferMsOf(entry) {
      if (!entry) { return 0; }
      if (entry.deferMs > 0) { return num(entry.deferMs); }
      return entry.name === 'logs' ? USAGE_SYNC.logDeferMs : 0;
    }
    function scheduleDeferredCapture(entry) {
      var ms = deferMsOf(entry);
      if (!(ms > 0)) { return false; }
      if (!deferredEntries) { deferredEntries = {}; }
      deferredEntries[entry.name] = 1;
      if (deferredTimer) { return true; }
      deferredTimer = setTimeout(function () {
        deferredTimer = null;
        flushDeferred();
        scheduleFlush();
      }, ms);
      if (deferredTimer && typeof deferredTimer.unref === 'function') { try { deferredTimer.unref(); } catch (e) {} }
      return true;
    }
    /* 모아 둔 항목을 지금 capture 한다(한 번만). flush() 가 먼저 불러 같은 배치에 실어 보낸다. */
    function flushDeferred() {
      if (deferredTimer) { try { clearTimeout(deferredTimer); } catch (e) {} deferredTimer = null; }
      var names = deferredEntries ? Object.keys(deferredEntries) : [];
      deferredEntries = null;
      for (var i = 0; i < names.length; i++) {
        var e = entryByName(names[i]);
        if (!e) { continue; }
        prevValues[names[i]] = readValue(names[i]);
        try { capture(e); deferredCaptured++; } catch (err) { lastError = errorText(err); }
      }
      return names.length;
    }
    function deferredState() {
      return { pending: deferredEntries ? Object.keys(deferredEntries) : [], ms: USAGE_SYNC.logDeferMs, captured: deferredCaptured };
    }

    /* ---------- v53 — 지연 구독(상담·차량·쿠폰·전체 원비) ----------
       화면이 그 탭/기능을 열 때 ensureLoaded(['counsel']) 로 부른다.
       전체가 필요한 순간(수납 리포트·1년 조회·드라이브 백업)에는 lazyPending() 이 비었는지 보고
       다 받은 뒤에 진행하면 된다. */
    var lazyMissed = {};      /* 열기를 시도했지만 첫 스냅샷을 못 받은 묶음 */
    function adapterCoverage() {
      if (!adapter || typeof adapter.coverage !== 'function') { return null; }
      try { return adapter.coverage(); } catch (e) { return null; }
    }
    function ensureLoaded(names) {
      var list = Array.isArray(names) ? names.slice() : [names];
      list = list.filter(function (n) { return !!n; });
      if (!adapter || typeof adapter.openGroup !== 'function') {
        return Promise.resolve({ ok: true, skipped: true, reason: 'no-lazy', loaded: list, results: [] });
      }
      if (effectiveRole() !== 'admin') {
        return Promise.resolve({ ok: false, skipped: true, reason: 'role-unverified', loaded: [], results: [] });
      }
      var ps = list.map(function (n) {
        var call;
        try { call = adapter.openGroup(n); } catch (e) { call = Promise.reject(e); }
        return Promise.resolve(call).then(function (r) {
          if (r && r.loaded) { delete lazyMissed[n]; } else { lazyMissed[n] = 1; }
          emit('lazy-group', { group: n, loaded: !!(r && r.loaded), partial: !!(r && r.partial), result: r || null });
          return r || { ok: false, group: n };
        }, function (err) {
          lazyMissed[n] = 1;
          return { ok: false, group: n, error: errorText(err) };
        });
      });
      return Promise.all(ps).then(function (results) {
        var allOk = true;
        results.forEach(function (r) { if (!r || !r.loaded) { allOk = false; } });
        return { ok: allOk, partial: !allOk, loaded: list, results: results };
      });
    }
    /* 아직 받지 않은 묶음 — 비어 있으면 “전체 데이터가 갖춰졌다” */
    function lazyPending() {
      var cov = adapterCoverage();
      var out = [];
      if (!cov || !cov.lazy) { return out; }
      ['counsel', 'shuttle', 'coupons'].forEach(function (n) { if (!cov[n]) { out.push(n); } });
      if (cov.tuition !== 'full') { out.push('tuition'); }
      return out;
    }
    function lazyState() {
      var cov = adapterCoverage();
      return {
        coverage: cov,
        pending: lazyPending(),
        missed: Object.keys(lazyMissed),
        timeoutMs: LAZY_READY_TIMEOUT_MS
      };
    }
    /* 이 문서의 삭제 표시(툼스톤)를 보내도 되는가 — 받아 둔 범위인지 */
    function deletablePath(p, cov) {
      if (!cov || !cov.lazy) { return true; }
      var seg = String(p || '').split('/');
      var coll = seg.length >= 4 ? seg[2] : '';
      if (coll === 'tuition') {
        if (cov.tuition === 'full') { return true; }
        var mk = String(seg[3] || '').slice(0, 7);
        return mk >= tuitionRecentFrom(now());
      }
      if (coll === 'counsel' || coll === 'shuttle' || coll === 'coupons') { return !!cov[coll]; }
      return true;
    }

    /* v55 — 문서에서 빠진 필드( 진짜 지우기 )를 빈 값으로 바꿔 적는다.
       merge:true 쓰기만으로는 "필드가 없어졌다"는 사실이 서버에 전달되지 않아 다음 수신에서
       옛 값이 되살아났다("번호를 지웠는데 다시 생겨요"). 앱은 이제 지우기 대신 '' 을 쓰지만
       (index.html), 예전 버전·다른 코드 경로가 필드를 지운 경우도 여기서 빈 값으로 바꾼다.
       · 문자열·숫자·참·거짓 → '' (앱이 쓰는 "비어 있음" 규칙과 같다)
       · 객체·배열 → null   (빈 문자열로 바꾸면 모양이 깨진다) */
    function applyClearedFields(prevBody, body) {
      var pf = flatten(prevBody || {});
      var nf = flatten(body || {});
      var cleared = [];
      Object.keys(pf).forEach(function (f) {
        if (hasOwn(nf, f)) { return; }
        var v = pf[f];
        nf[f] = (v != null && typeof v === 'object') ? null : '';
        cleared.push(f);
      });
      if (!cleared.length) { return { body: body, cleared: cleared }; }
      return { body: unflatten(nf), cleared: cleared };
    }

    /* v55 — 출결 삭제 표시(툼스톤). 라이브 규칙 validEvent() 의 필수칸(date·studentId·kind·time)을
       채워 둔다. 문서가 서버에 있으면 update 라 모양 검사를 하지 않고, 혹시 없어서 create 가 되면
       규칙의 hasOnly(eventFields()) 가 `_deleted` 를 막는다(규칙을 못 바꾸므로). 그래서 서버에
       있다고 확인된 문서(s=1)에만 이 본문을 쓰고, 확인되지 않은 문서는 삭제(del)로 보낸다. */
    function eventTombstoneBody(path, sh, ver, at) {
      var m = parseEventId(String(path || '').split('/').pop());
      if (!m || !isEventDateKey(m.date) || !m.studentId || String(m.studentId).length > 120) { return null; }
      var t = normEventTime(sh && sh.t !== undefined ? sh.t : '');
      return {
        date: m.date,
        studentId: m.studentId,
        kind: m.kind,
        time: t || NO_TIME,
        eventId: eventIdOf(m.date, m.studentId, m.kind),
        manual: !t,
        _deleted: true,
        _ver: ver,
        _updatedAt: at,
        _updatedBy: deviceId
      };
    }

    /* 대량 삭제 1회 허용 — 사용자가 화면에서 확인한 경우에만 통로가 열린다 */
    function approvalCovers(collName) {
      if (!bulkApproval) { return false; }
      if (!bulkApproval.collections) { return true; }
      return !!bulkApproval.collections[String(collName || '')];
    }

    function capture(entry, retryOpts) {
      var afterLoad = !!(retryOpts && retryOpts.afterLoad);
      /* v51 — 복원 중이면 아무것도 올리지 않는다 */
      if (suppressCapture) {
        if (entry && entry.name) { suppressedKeys[entry.name] = 1; }
        return;
      }
      if (!entry) { return; }
      /* 역할 미확인 기기는 아무것도 올리지 않는다 (그림자를 앞지르지도 않는다) */
      if (effectiveRole() !== 'admin') {
        emit('blocked-local', { key: entry.name, reason: 'role-unverified' });
        return;
      }
      var base = basePath();
      var changes = [];
      var live = {};
      var sources = [entry];

      sources.forEach(function (src) {
        liveDocsOf(src, base).forEach(function (d) { live[d.path] = { doc: d, entry: src }; });
      });

      Object.keys(live).forEach(function (p) {
        var d = live[p].doc;
        if (!d || !d.body) { return; }        /* v52 — "있음" 표시(과거 수동 기록)는 보내지 않는다 */
        var src = live[p].entry;
        var body = clone(d.body) || {};
        var sh = shadow[p];
        /* v55 — 필드가 사라진 경우 빈 값으로 채워 "지움"이 서버까지 전달되게 한다.
           출결은 규칙(eventFields)이 칸을 제한하므로 건드리지 않는다. */
        if (src.kind !== 'events') {
          var fixed = applyClearedFields(sh && sh.b ? sh.b : {}, body);
          if (fixed.cleared.length) { body = fixed.body; }
        }
        var h = bodyHash(src.kind, body);
        if (sh && !sh.d && sh.h === h) { return; }           /* 내용이 그대로 → 보내지 않음 */
        /* v52 — 과거(오늘 이전) 날짜의 "시각 없는 수동·CSV 출석"은 처음 올릴 때
           분할 업로더(pumpEventBacklog)가 맡는다. 여기서 한꺼번에 밀어 넣으면
           무료 한도(하루 쓰기 2만)를 한 번에 태우고, 그날 정상 출결 쓰기가 막힌다.
             · 오늘 날짜의 수동 출결은 그대로 곧바로 보낸다
             · 이미 올린 기록(그림자 v>=1)의 수정·삭제도 그대로 보낸다 */
        if (src.kind === 'events' && isDayOnlyEvent(body) && !(sh && !sh.d && num(sh.v) > 0)) {
          if (String(body.date || '') < dayOf(now())) { return; }
        }
        if (src.kind === 'events') {
          var dup = duplicateEvent(p, body);
          if (dup) { return; }
        }
        var prevBody = sh && sh.b ? sh.b : {};
        var meta = stampFields(prevBody, sh ? sh.m : {}, body, { at: isoOf(now()), by: deviceId });
        var ver = (sh ? num(sh.v) : 0) + 1;
        var docBody2 = valueFields(body);
        /* v55 — 드라이브 복원 직후에는 그림자가 복원본으로 새로 심겨 있다(r=1).
           그 상태에서 한 칸만 고치면 그 문서 전체(옛 백업 값)를 덮어쓰지 않고, 바뀐 칸만 보낸다.
           (백업 뒤 다른 기기에서 고친 전화번호가 옛 값으로 되돌아가던 문제) */
        if (sh && sh.r === 1 && num(sh.v) > 0 && src.kind !== 'events') {
          var pf0 = flatten(prevBody), nf0 = flatten(body), only = {};
          Object.keys(nf0).forEach(function (f) {
            if (!hasOwn(pf0, f) || stableStringify(pf0[f]) !== stableStringify(nf0[f])) { only[f] = nf0[f]; }
          });
          if (Object.keys(only).length) { docBody2 = unflatten(only); }
        }
        var doc = docBody2;
        doc._ver = ver;
        doc._updatedAt = isoOf(now());
        doc._updatedBy = deviceId;
        doc._fieldMeta = meta;
        putShadowEntry(p, {
          v: ver, m: meta, u: doc._updatedAt, by: deviceId, h: h, d: false, r: sh && sh.r === 1 ? 1 : undefined,
          b: src.kind === 'events' ? null : mergeMetaBody(body, meta),
          t: body.time
        });
        changes.push({ path: p, body: doc, entry: src.name });
      });

      /* 사라진 문서 → 삭제 표시(툼스톤) */
      var prefixOf = function (e) {
        if (e.kind === 'object' || e.kind === 'value') { return base + '/meta/' + safeId(e.meta); }
        return base + '/' + e.coll;
      };
      var prefixes = sources.map(prefixOf);
      var prefixKind = {};
      sources.forEach(function (e) { prefixKind[prefixOf(e)] = e.kind; });
      /* 한 경로가 어느 컬렉션(또는 meta 문서) 아래인지 — 가장 긴 접두사 */
      var prefixFor = function (p) {
        var hit = '';
        for (var i = 0; i < prefixes.length; i++) {
          if (p === prefixes[i] || p.indexOf(prefixes[i] + '/') === 0) {
            if (!hit || prefixes[i].length > hit.length) { hit = prefixes[i]; }
          }
        }
        return hit;
      };
      var underAny = function (p) { return !!prefixFor(p); };
      /* ---------- v51 대량 삭제 방지 ----------
         그림자가 10건 이상인 컬렉션에서 한 번에 20% 이상을 삭제 표시하려 하면 그 컬렉션의
         삭제만 막는다(값 변경은 그대로 보낸다). 원비 ID 해석 버그·빈 명단 같은 사고가
         서버의 원비·원생을 통째로 지우는 것을 막는 마지막 안전장치다.
         v55 — 사용자가 화면에서 "1회 허용"을 확인했으면 그 컬렉션은 이번 한 번 통과한다. */
      var totals = {}, doomed = {};
      Object.keys(shadow).forEach(function (p) {
        var pr = prefixFor(p);
        if (!pr) { return; }
        var sh0 = shadow[p];
        if (!sh0 || sh0.d) { return; }
        totals[pr] = (totals[pr] || 0) + 1;
        if (!live[p]) { doomed[pr] = (doomed[pr] || 0) + 1; }
      });
      var blockedAt = {};
      var approvedColls = [];
      Object.keys(doomed).forEach(function (pr) {
        var total = totals[pr] || 0;
        var want = doomed[pr] || 0;
        if (!(total >= BULK_DELETE_MIN_DOCS && want >= Math.ceil(total * BULK_DELETE_RATIO))) { return; }
        var collName = String(pr).replace(base + '/', '');
        if (approvalCovers(collName)) { approvedColls.push(collName); return; }
        blockedAt[pr] = { total: total, deletes: want };
      });
      var heldPaths = 0;
      var heldDetail = [];
      if (Object.keys(blockedAt).length) {
        Object.keys(blockedAt).forEach(function (pr) {
          heldPaths += blockedAt[pr].deletes;
          heldDetail.push({
            collection: pr.replace(base + '/', ''),
            deletes: blockedAt[pr].deletes,
            total: blockedAt[pr].total,
            ratio: Math.round((blockedAt[pr].deletes / blockedAt[pr].total) * 1000) / 1000
          });
        });
      }
      /* v53 — 지연 구독한 컬렉션은 "받아 둔 범위" 안에서만 삭제 표시한다.
         상담·차량·쿠폰을 아직 안 받았거나 원비는 최근 몇 달만 받은 상태에서,
         그림자에 없던 문서를 지우면 서버만 사라질 수 있기 때문이다.
         v55 — 조용히 버리지 않는다: 그 묶음을 열어(ensureLoaded) 받아 둔 뒤 한 번 더 시도하고,
         그래도 안 되면 화면에 "이 기기에서는 지울 수 없습니다"로 알린다. */
      var covNow = adapterCoverage();
      var needLoad = {};
      var heldOutOfRange = [];
      /* 삭제 후보 = 그림자에 있는데 지금 로컬 값에 없는 문서 + 예전에 보류했던 삭제의 경로 */
      var tombPaths = [];
      Object.keys(shadow).forEach(function (p) {
        if (!underAny(p)) { return; }
        if (live[p]) { return; }
        tombPaths.push(p);
      });
      Object.keys(pendingDeletes).forEach(function (p) {
        if (!underAny(p)) { return; }
        var pd = shadow[p];
        if (!pd || pd.d) { delete pendingDeletes[p]; return; }
        if (tombPaths.indexOf(p) === -1) { tombPaths.push(p); }
      });
      tombPaths.forEach(function (p) {
        var sh2 = shadow[p];
        if (!sh2 || sh2.d) { return; }
        if (blockedAt[prefixFor(p)]) { return; }      /* v51 — 대량 삭제는 보류한다 */
        if (!deletablePath(p, covNow)) {
          /* 아직 받지 않은 범위 — 받은 뒤에 지운다(의도를 기억해 둔다) */
          var seg = String(p).split('/');
          var coll2 = seg.length >= 4 ? seg[2] : '';
          if (coll2 === 'tuition') { needLoad.tuition = 1; }
          else if (coll2 === 'counsel' || coll2 === 'shuttle' || coll2 === 'coupons') { needLoad[coll2] = 1; }
          pendingDeletes[p] = { at: isoOf(now()), key: entry.name, coll: coll2 };
          heldOutOfRange.push(p);
          return;
        }
        /* 묶음을 열어 받아 와서 로컬에 다시 들어온 문서라도, 사용자가 지운 것이면 지운다 */
        if (live[p] && pendingDeletes[p]) {
          try { applyRemoteDoc(p, entry, { deleted: true, body: {} }); } catch (e) { lastError = errorText(e); }
        }
        delete pendingDeletes[p];
        var ver2 = num(sh2.v) + 1;
        var at2 = isoOf(now());
        var kind2 = prefixKind[prefixFor(p)] || '';
        putShadowEntry(p, { v: ver2, m: {}, u: at2, by: deviceId, h: '', d: true, b: null, t: undefined });
        if (kind2 === 'events') {
          /* v55 — 출결 툼스톤은 규칙의 create 검사(hasOnly(eventFields))를 통과하지 못한다.
             서버에 있다고 확인된 문서(s=1)만 툼스톤(update)으로, 확인되지 않은 문서는 삭제(del)로 보낸다.
             (오프라인·한도 초과 중에 찍은 출결을 그 자리에서 지우면 서버에 문서가 없어
              툼스톤 생성이 영구 거부 → 배치 전체가 막히던 원인) */
          if (num(sh2.s) === 1) {
            var tbody = eventTombstoneBody(p, sh2, ver2, at2);
            if (tbody) { changes.push({ path: p, body: tbody }); }
            else { changes.push({ path: p, del: true, body: null }); }
          } else {
            changes.push({ path: p, del: true, body: null });
          }
        } else {
          changes.push({
            path: p,
            body: { _deleted: true, _ver: ver2, _updatedAt: at2, _updatedBy: deviceId }
          });
        }
      });
      if (approvedColls.length) {
        /* 1회 허용은 한 번만 쓴다 — 다음 대량 삭제는 다시 확인을 받는다 */
        bulkApproval = null;
        emit('bulk-delete-approved', { at: isoOf(now()), key: entry.name, collections: approvedColls });
      }
      if (Object.keys(blockedAt).length) {
        /* 경고 상태를 남긴다 — 화면(상태 문구)과 진단(engine.bulkDeleteState())에서 보인다 */
        bulkDeleteBlocked = {
          at: isoOf(now()), key: entry.name, held: heldPaths, collections: heldDetail,
          message: '한 번에 너무 많은 기록을 삭제하려 해 막았습니다 — ' +
            heldDetail.map(function (d) { return d.collection + ' ' + d.deletes + '/' + d.total + '건'; }).join(', ')
        };
        emit('bulk-delete-blocked', bulkDeleteBlocked);
      }
      if (heldOutOfRange.length && !afterLoad && typeof ensureLoaded === 'function') {
        /* 받아 두지 않은 범위 — 그 묶음을 지금 열고, 첫 스냅샷이 오면 이 키를 한 번 더 처리한다 */
        var names = Object.keys(needLoad);
        if (names.length) {
          captureRetryQueued[entry.name] = 1;
          ensureLoaded(names).then(function (res) {
            captureRetryQueued[entry.name] = 0;
            var any = !res || res.ok !== false;
            if (!any) { return; }
            try { capture(entry, { afterLoad: true }); scheduleFlush(); } catch (e) { lastError = errorText(e); }
          }, function () { captureRetryQueued[entry.name] = 0; });
        }
        deleteHeld = {
          at: isoOf(now()), key: entry.name, count: heldOutOfRange.length,
          collections: Object.keys(needLoad),
          paths: heldOutOfRange.slice(0, 20),
          message: '아직 받지 않은 ' + Object.keys(needLoad).join('·') + ' 기록 ' + heldOutOfRange.length +
            '건은 지금 서버에서 확인하는 중입니다 — 잠시 뒤 다시 지워 주세요.'
        };
        emit('delete-held', deleteHeld);
      } else if (!heldOutOfRange.length && !Object.keys(pendingDeletes).length) {
        /* 보류하던 삭제가 모두 처리됐다 — 안내를 내린다 */
        if (deleteHeld) { deleteHeld = null; emit('delete-held', null); }
      }
      if (heldOutOfRange.length && afterLoad) {
        deleteHeld = {
          at: isoOf(now()), key: entry.name, count: heldOutOfRange.length,
          collections: Object.keys(needLoad),
          paths: heldOutOfRange.slice(0, 20),
          message: '이 기기에서는 지울 수 없는 기록 ' + heldOutOfRange.length +
            '건이 있습니다(아직 받지 않은 범위) — 「🔄 전체 다시 불러오기」 뒤에 다시 지워 주세요.'
        };
        emit('delete-held', deleteHeld);
      }

      if (changes.length) {
        saveShadow();
        /* v55 — 큐에 한 번에 넣는다(건마다 저장하지 않는다) */
        outbox.enqueueMany(changes.map(function (c) {
          return c.del === true ? { path: c.path, del: true } : { path: c.path, body: c.body };
        }));
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

    /* =========================================================================
       v52 — 과거 수동·CSV 출결 분할 업로드
       -------------------------------------------------------------------------
       문제: v51 까지 docsForEntry 가 inTime/outTime 이 있을 때만 문서를 만들어
             과거 수동·CSV 출석(2026-11-26 기준 11,792건)이 서버에 하나도 없었다.
       이제 문서를 만들지만, 11,800건을 한 번에 올리면 Spark 하루 쓰기 한도(20,000)의
       59%를 한 번에 태우고 그날 정상 출결·원생·원비 쓰기가 막힌다. 그래서
         · 그림자에 없거나(아직 안 올림) 내용이 바뀐 "시각 없는" 기록을 최근 날짜부터
         · 한 번에 chunk(1,500)건씩 큐에 넣고, 보낸 뒤 intervalMs 뒤에 다음 묶음
         · 하루 남은 쓰기가 reserveWrites 아래로 내려가면 오늘은 멈춘다(다음 초기화 뒤 재개)
         · 상대 기기가 이미 올려 둔 것이면 표본 몇 건만 읽어 보고 건너뛴다(쓰기 0)
       ※ 서버 규칙은 그대로 둔다 — 문서 모양은 기존 허용 칸/형식 안에서만 만든다.
       ========================================================================= */
    var eventPump = {
      timer: null, running: false, marker: null,
      lastAt: '', result: '', reason: '',
      uploaded: 0, total: 0, remaining: 0, done: false,
      queue: null            /* v55 — 한 번 만든 대기 목록(240건씩 꺼내 쓴다) */
    };

    function eventBacklogState() {
      var total = num(eventPump.total), remaining = num(eventPump.remaining);
      return {
        at: eventPump.lastAt,
        total: total,
        remaining: remaining,
        doneCount: Math.max(0, total - remaining),
        uploaded: num(eventPump.uploaded),
        done: !!eventPump.done,
        result: eventPump.result || '',
        reason: eventPump.reason || '',
        shared: sharedBacklogCount(),
        marker: eventPump.marker ? clone(eventPump.marker) : null,
        chunk: EVENT_UPLOAD.chunk,
        maxQueued: EVENT_UPLOAD.maxQueued,
        reserveWrites: EVENT_UPLOAD.reserveWrites,
        pending: outbox.count(),
        running: !!eventPump.running
      };
    }

    /* 시각 없는 수동·CSV 출석 문서 중 아직 서버에 없는 것 — 최근 날짜부터 */
    function dayOnlyEventBacklog(base) {
      var map = unionEventDocs(readValue('attendance'), readValue('records'), base, { deviceId: deviceId });
      var cands = [];
      var total = 0;
      Object.keys(map).forEach(function (p) {
        var body = map[p].body || {};
        if (!isDayOnlyEvent(body)) { return; }
        var date = String(body.date || '');
        if (!date) { return; }
        total++;
        var sh = shadow[p];
        /* 그림자에 같은 내용이 있으면 이미 올렸거나( v>=1 ) 서버에 있음을 확인한 기록 */
        if (sh && !sh.d && sh.h === eventHash(body)) { return; }
        cands.push({ path: p, body: body, date: date, studentId: String(body.studentId || '') });
      });
      cands.sort(function (a, b) {
        if (a.date !== b.date) { return a.date < b.date ? 1 : -1; }
        return a.studentId < b.studentId ? -1 : (a.studentId > b.studentId ? 1 : 0);
      });
      return { cands: cands, total: total };
    }

    /* 지금 더 써도 되는 문서 수 — 전체 기기 합산 쓰기와 남겨 둘 몫을 뺀다 */
    function eventUploadRoom() {
      var snap = usage.snapshot();
      var limit = num(snap.limits && snap.limits.writes) || SPARK.writes;
      /* v53 — 이 기기 쓰기(항상 정확) + 다른 기기가 올린 쓰기(meta/usage, 5분까지 늦을 수 있음).
         합산 문서 간격을 5분으로 늘렸으니 로컬 증가분을 반드시 더해야 한도에 닿기 전에 멈춘다. */
      var used = num(snap.writes);
      var others = 0;
      try {
        var totals = usageTotals(usageSync.remote, rawUsageSnapshot().date, deviceId);
        others = num(totals && totals.others && totals.others.writes);
      } catch (e) { others = 0; }
      if (!(used > 0)) { used = num(snap.total && snap.total.writes); }
      used += others;
      var pending = 0;
      try { outbox.pending().forEach(function (it) { if (it.del !== true) { pending++; } }); } catch (e) { pending = 0; }
      var room = limit - used - pending - EVENT_UPLOAD.reserveWrites;
      return room > 0 ? room : 0;
    }

    /* 상대 기기가 이미 다 올렸는지 — meta/usage 에 적힌 "과거 출결 업로드 완료 건수"로 판단한다
       (표본 몇 건이 아니라 건수로 보므로, 중간 달이 빠지는 식의 잘못된 생략이 없다) */
    function sharedBacklogCount() {
      var ev = usageSync.remote && usageSync.remote.events;
      var n = num(ev && ev.count);
      if (!(n > 0)) { return 0; }
      return String(ev.by || '') === String(deviceId) ? 0 : n;   /* 내가 올린 몫은 빼고 본다 */
    }

    function scheduleEventPump(delayMs) {
      if (opts.autoflush === false) { return null; }      /* 테스트·수동 모드에서는 직접 부른다 */
      if (eventPump.timer) { try { clearTimeout(eventPump.timer); } catch (e) {} eventPump.timer = null; }
      var d = num(delayMs);
      if (!(d > 0)) { return null; }
      eventPump.timer = setTimeout(function () {
        eventPump.timer = null;
        pumpEventBacklog().then(function () {}, function () {});
      }, d);
      return eventPump.timer;
    }

    function pumpEventBacklog() {
      if (eventPump.running) { return Promise.resolve({ ok: false, reason: 'busy', state: eventBacklogState() }); }
      var blocked = !adapter ? 'no-adapter'
        : (!isEffectiveAdmin() ? 'role-unverified'
        : (suppressCapture ? 'restoring'
        : (!online() ? 'offline'
        : (usage.blocked() ? 'quota' : ''))));
      if (blocked) {
        eventPump.reason = blocked;
        return Promise.resolve({ ok: false, reason: blocked, state: eventBacklogState() });
      }
      var base = basePath();
      /* v55 — 스캔 결과(11,800건)를 매번 다시 만들지 않는다. 한 번 만들어 두고 240건씩 꺼내 쓴다.
         (예전에는 90초마다 전체 출결을 다시 훑어 PC 가 버벅였다) */
      var scan = null;
      if (eventPump.queue && eventPump.queue.length) {
        scan = { cands: eventPump.queue, total: eventPump.total || eventPump.queue.length, cached: true };
      } else {
        try { scan = dayOnlyEventBacklog(base); }
        catch (e) {
          eventPump.reason = 'scan';
          return Promise.resolve({ ok: false, reason: 'scan', error: errorText(e), state: eventBacklogState() });
        }
        eventPump.queue = scan.cands.slice();
      }
      eventPump.total = scan.total;
      eventPump.remaining = scan.cands.length;
      eventPump.reason = '';
      if (!scan.cands.length) {
        eventPump.done = true; eventPump.uploaded = 0;
        eventPump.result = 'done'; eventPump.lastAt = isoOf(now());
        eventPump.queue = null;
        emit('event-backlog', eventBacklogState());
        return Promise.resolve({ ok: true, uploaded: 0, remaining: 0, done: true, total: scan.total, state: eventBacklogState() });
      }
      eventPump.running = true;
      /* 다른 기기가 이미 더 많이(또는 같은 만큼) 올려 둔 상태면 다시 올리지 않는다 */
      var shared = sharedBacklogCount();
      if (shared >= scan.total && scan.total > 0) {
        eventPump.done = true; eventPump.remaining = 0; eventPump.uploaded = 0;
        eventPump.result = 'already'; eventPump.reason = 'already'; eventPump.lastAt = isoOf(now());
        eventPump.running = false;
        eventPump.queue = null;
        emit('event-backlog', eventBacklogState());
        return Promise.resolve({ ok: true, already: true, uploaded: 0, remaining: 0, total: scan.total, shared: shared, state: eventBacklogState() });
      }
      return Promise.resolve(true).then(function () {
        /* v55 — 큐가 이미 차 있으면 다음 묶음을 넣지 않는다(대기 900건 → 화면 버벅임 방지) */
        var queued = 0;
        try { queued = outbox.pending().length; } catch (e) { queued = 0; }
        if (queued >= EVENT_UPLOAD.maxQueued) {
          eventPump.uploaded = 0; eventPump.reason = 'queue';
          eventPump.result = 'queue'; eventPump.lastAt = isoOf(now());
          emit('event-backlog', eventBacklogState());
          return { ok: true, uploaded: 0, remaining: scan.cands.length, blocked: 'queue', total: scan.total, state: eventBacklogState() };
        }
        var room = eventUploadRoom();
        var quotaLeft = Math.max(0, EVENT_UPLOAD.maxQueued - queued);
        var take = scan.cands.slice(0, Math.max(0, Math.min(EVENT_UPLOAD.chunk, room, quotaLeft)));
        if (!take.length) {
          eventPump.uploaded = 0; eventPump.reason = 'reserve';
          eventPump.result = 'reserve'; eventPump.lastAt = isoOf(now());
          emit('event-backlog', eventBacklogState());
          return { ok: true, uploaded: 0, remaining: scan.cands.length, blocked: 'reserve', total: scan.total, state: eventBacklogState() };
        }
        var at2 = isoOf(now());
        var ops = [];
        take.forEach(function (c) {
          var sh = shadow[c.path];
          var prevBody = sh && sh.b ? sh.b : {};
          var meta = stampFields(prevBody, sh ? sh.m : {}, c.body, { at: at2, by: deviceId });
          var ver = (sh ? num(sh.v) : 0) + 1;
          var doc = valueFields(c.body);
          doc._ver = ver;
          doc._updatedAt = at2;
          doc._updatedBy = deviceId;
          doc._fieldMeta = meta;
          putShadowEntry(c.path, { v: ver, m: meta, u: at2, by: deviceId, h: eventHash(c.body), d: false, b: null, t: c.body.time });
          ops.push({ path: c.path, body: doc });
        });
        /* v55 — 240건을 한 번에 넣는다(건마다 큐 저장 → O(n²) 로 멈추던 것) */
        outbox.enqueueMany(ops);
        saveShadow();
        /* 이미 꺼낸 것은 대기 목록에서 뺀다 */
        var donePaths = {};
        take.forEach(function (c) { donePaths[c.path] = 1; });
        eventPump.queue = scan.cands.filter(function (c) { return !donePaths[c.path]; });
        eventPump.uploaded = take.length;
        eventPump.remaining = eventPump.queue.length;
        eventPump.done = eventPump.remaining === 0;
        eventPump.result = 'uploaded';
        eventPump.lastAt = at2;
        emit('captured', { key: 'attendance', count: take.length, backlog: true });
        emit('event-backlog', eventBacklogState());
        scheduleFlush();
        return { ok: true, uploaded: take.length, remaining: eventPump.remaining, total: scan.total, state: eventBacklogState() };
      }).then(function (res) {
        eventPump.running = false;
        if (res && res.remaining > 0) {
          var wait = res.blocked ? EVENT_UPLOAD.retryMs
            : (outbox.count() === 0 ? EVENT_UPLOAD.stepMs : EVENT_UPLOAD.intervalMs);
          scheduleEventPump(wait);
        }
        return res;
      }, function (err) {
        eventPump.running = false;
        eventPump.reason = 'error';
        eventPump.result = 'error';
        return { ok: false, reason: 'error', error: errorText(err), state: eventBacklogState() };
      });
    }

    /* ---------- 원격 변경 반영 ---------- */
    /* 여러 문서가 한꺼번에 오면 localStorage 반영은 바로, 화면 갱신은 한 번만 */
    function scheduleReload() {
      reloadPending = true;
      var t = now();
      if (!reloadFirstAt) { reloadFirstAt = t; }
      var wait = num(opts.refreshMs) || REFRESH_MS;
      var maxWait = num(opts.refreshMaxMs) || REFRESH_MAX_MS;
      /* v50 — 변경이 계속 들어오는 동안에는 조용해질 때까지 미루고(디바운스),
         그래도 maxWait 를 넘기면 다음 작업에서 한 번 그린다(화면이 너무 오래 낡지 않게).
         묶음 처리(remoteDepth) 도중에 바로 그리면 아직 저장 안 된 값을 읽으므로 항상 타이머로 미룬다. */
      if (t - reloadFirstAt >= maxWait) { wait = 0; }
      if (reloadTimer) { clearTimeout(reloadTimer); reloadTimer = null; }
      reloadTimer = setTimeout(function () {
        reloadTimer = null;
        reloadFirstAt = 0;
        if (!reloadPending) { return; }
        reloadPending = false;
        reloadApp();
        emit('applied', {});
      }, wait);
    }
    function flushReload() {
      if (reloadTimer) { clearTimeout(reloadTimer); reloadTimer = null; }
      reloadFirstAt = 0;
      flushReads();
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
      var remoteEntry = entryByPath(path);
      if (!remoteEntry) { return; }
      /* 캐시에서 온 스냅샷(fromCache)은 서버 읽기가 아니다 — 계량기에 넣지 않는다.
         실제 서버에서 읽은 문서만 무료 한도(읽기 5만/일)를 쓴다. */
      var fromCache = !!(meta && meta.fromCache === true);
      if (!fromCache) { noteReads(1); }
      var remoteDoc = {};
      if (isPlain(data)) {
        Object.keys(data).forEach(function (k) { remoteDoc[k] = data[k]; });
      } else {
        remoteDoc._deleted = true;
        remoteDoc._ver = num(meta && meta.ver) + 1;
      }
      var localSh = shadow[path];
      /* v50 — 서버가 준 문서가 그림자와 같은 버전·같은 기기에서 온 그대로면 병합·직렬화를 하지 않고 넘어간다.
         로그인 직후 687명 명단이 한꺼번에 도착할 때 이 비교가 없으면 문서마다 JSON 정렬·병합을 하느라
         휴대폰 화면이 수십 초 굳는다. (같은 _ver·같은 _updatedBy 면 내용도 같다) */
      if (localSh && !localSh.d && isPlain(data) && data._deleted !== true) {
        var fastBy = String(data._updatedBy || '');
        if (fastBy && fastBy === String(localSh.by || '') && num(data._ver) === num(localSh.v)) {
          /* 내용까지 한 번 더 맞춰 본다 — 콘솔에서 직접 고친 문서처럼
             버전·기기는 그대로인데 내용만 다른 경우도 놓치지 않게(문서 1건당 해시 1회) */
          if (!localSh.h || bodyHash(remoteEntry.kind, docBody(data)) === localSh.h) {
            lastSyncAt = isoOf(now());
            if (!fromCache) {
              var fastColl = pathColl(path);
              if (fastColl) { markSynced(fastColl); }
            }
            return;
          }
        }
      }
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
      var entry = remoteEntry;
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
      var needRemote = merged.deleted ? !remoteDoc._deleted : stableStringify(mergedBody) !== stableStringify(remoteBody);

      if (needLocal) {
        applyRemoteDoc(path, entry, merged);
        scheduleReload();
        emit('remote', { path: path, key: entry.name });
      }
      if (needRemote) {
        /* 역할 미확인 기기는 서버로 되돌려 보내지 않는다 — 큐에 쌓아 두면 영원히 실패로 남는다 */
        if (!isEffectiveAdmin()) {
          emit('blocked-local', { key: entry.name, reason: 'role-unverified' });
          updateShadowFromMerged(path, merged, kind, null, remoteDoc);
        } else {
          /* 내 쪽이 더 최신인 필드가 있어 합친 결과를 되돌려 보낸다 → 양쪽이 같은 값으로 수렴 */
          var body = bodyWithMeta(mergedBody, merged.meta);
          body._ver = num(merged.ver) + 1;
          body._updatedAt = isoOf(now());
          body._updatedBy = deviceId;
          if (merged.deleted) { body = { _deleted: true, _ver: body._ver, _updatedAt: body._updatedAt, _updatedBy: deviceId }; }
          updateShadowFromMerged(path, merged, kind, body, remoteDoc);
          outbox.enqueue({ path: path, body: body });
          scheduleFlush();
        }
      } else {
        updateShadowFromMerged(path, merged, kind, null, remoteDoc);
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

    function updateShadowFromMerged(path, merged, kind, sentBody, remoteDoc) {
      var body = merged.deleted ? {} : (merged.body || {});
      /* v50 — 서버가 준 문서를 그대로 받아들인 경우에는 서버의 버전·작성 기기를 그대로 적는다.
         (그래야 같은 문서가 다시 와도 [같은 버전·같은 기기]로 알아보고 merge·직렬화 없이 넘어간다) */
      var rv = remoteDoc ? num(remoteDoc._ver) : null;
      var by = (sentBody && sentBody._updatedBy) ||
        (remoteDoc && remoteDoc._updatedBy) || merged.updatedBy || deviceId;
      var prev = shadow[path];
      var onServer = !!(remoteDoc && !merged.deleted);
      putShadowEntry(path, {
        v: sentBody ? (num(merged.ver) + 1) : (rv != null && rv > 0 ? Math.max(rv, num(merged.ver)) : num(merged.ver)),
        m: merged.meta || {},
        u: (sentBody && sentBody._updatedAt) || (remoteDoc && remoteDoc._updatedAt) || merged.updatedAt || isoOf(now()),
        by: by,
        d: merged.deleted === true,
        h: bodyHash(kind, body),
        /* v55 — 서버 문서를 받았으면 "이 문서는 서버에 있다"(s=1)로 기억한다. 출결 삭제를
           툼스톤(update)으로 보낼지 삭제(del)로 보낼지 이 표시로 정한다.
           서버와 같은 내용이 되었으니 복원본 칸별 쓰기 표시(r)는 끝낸다. */
        s: onServer ? 1 : (merged.deleted ? 0 : undefined),
        r: onServer ? 0 : undefined,
        b: merged.deleted ? null : (kind === 'events' ? null : mergeMetaBody(body, merged.meta)),
        t: merged.deleted ? undefined : body.time
      });
      if (prev && prev.s && !onServer && prev.d) { /* 삭제 수신 → 서버에 없다 */ }
      saveShadow();
    }

    /* 원격에서 온 문서를 실제 localStorage 값에 반영 (로컬 쓰기로 잡히지 않게 applying 사용) */
    function applyRemoteDoc(path, entry, merged) {
      var base = basePath();
      var deleted = merged.deleted === true;
      var body = merged.body || {};
      var seg = String(path).split('/');
      var docKey = seg[seg.length - 1];

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
        /* v52 — 자리표시 시각(00:00)+manual 은 "출석만 있고 시각은 모름"이다.
           그대로 inTime 에 넣으면 화면에 00:00 이 찍히므로 시각은 비우고 manual 만 남긴다. */
        var dayOnly = !deleted && isDayOnlyEvent(body);
        var time = (deleted || dayOnly) ? '' : String(body.time || '').slice(0, 5);
        if (m.kind === 'in') { if (time) { e.inTime = time; } else { delete e.inTime; } }
        else { if (time) { e.outTime = time; } else { delete e.outTime; } }
        if (deleted) {
          /* v52 — 삭제 수신은 기록 자체를 없얀다. 예전에는 manual 이라 남아
             "지우고 싶은 기록"이 상대 기기에서 살아 있었다. 남은 시각이 있으면
             (등원만 지우고 하원은 남기는 경우) 그대로 둔다. */
          if (!e.inTime && !e.outTime) { delete e.manual; delete e.src; }
        } else if (body.manual) { e.manual = true; }
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
        if (deleted) { if (!r.in && !r.out) { delete r.manual; } }
        else if (body.manual) { r.manual = true; }
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
        /* v51 — 예전에 잘못 쌓인 월 키(`2026-11_stu`)를 먼저 제자리로 돌려 둔다 */
        if (tuitionNeedsRepair(tui)) {
          tui = normalizeTuitionMap(tui).months;
          writeValue('tuition', tui);
        }
        /* v51 — 월은 항상 앞 7자(YYYY-MM), 원생은 8번째 '_' 뒤 전부.
           예전의 "마지막 '_' 기준" 분해는 `2026-11_stu_xxx` 를 월 `2026-11_stu` 로 만들어
           원비가 화면·다른 기기에 반영되지 않았다. */
        var tid = parseTuitionDocId(docKey);
        if (!tid) {
          skippedTuitionIds++;
          lastSkippedTuitionId = String(docKey);
          return;
        }
        var mk = tid.month, sid = tid.studentId;
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
      if (typeof hook !== 'function' && root.__tdk && root.__tdk.sync) {
        /* v46 — 원격 변경은 화면에 보이는 부분만 다시 그린다 (없으면 예전 전체 렌더) */
        if (typeof root.__tdk.sync.refresh === 'function') { hook = root.__tdk.sync.refresh; }
        else if (typeof root.__tdk.sync.reload === 'function') { hook = root.__tdk.sync.reload; }
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
    function scheduleFlush(delayMs) {
      if (opts.autoflush === false) { return; }
      if (flushTimer) { return; }
      flushTimer = setTimeout(function () {
        flushTimer = null;
        flush().then(function () {}, function () {});
      }, num(delayMs) > 0 ? num(delayMs) : (opts.flushMs || 700));
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

    /* v55 — 서버 저장이 확인된 문서를 그림자에 표시한다(출결 삭제를 툼스톤으로 보낼지 판단). */
    function markShadowConfirmed(list) {
      var changed = 0;
      (list || []).forEach(function (it) {
        if (!it || !it.path) { return; }
        if (it.del === true) { return; }
        if (it.body && it.body._deleted === true) { return; }
        var sh = shadow[it.path];
        if (!sh || sh.d) { return; }
        if (sh.s === 1) { return; }
        sh.s = 1;
        changed++;
      });
      if (changed) { saveShadow(); }
      return changed;
    }

    /* v55 — flush 재진입 가드.
       재시도 타이머(30초)와 capture 가 같은 순간에 flush 를 부르면, ACK 를 기다리는 동안
       같은 항목을 또 commit 해 같은 기록을 여러 번 쓰는(과금) 일이 있었다.
       이제 진행 중이면 같은 약속을 돌려주고, 그 사이 새로 쌓인 항목은 끝난 뒤 한 번 더 보낸다. */
    var flushInFlight = null;
    var flushAgain = false;

    function flush() {
      if (flushInFlight) { flushAgain = true; return flushInFlight; }
      var p = Promise.resolve().then(function () { return doFlush(); }).then(function (r) {
        flushInFlight = null;
        var again = flushAgain;
        flushAgain = false;
        if (again && outbox.count() > 0) { scheduleFlush(300); }
        return r;
      }, function (err) {
        flushInFlight = null;
        flushAgain = false;
        throw err;
      });
      flushInFlight = p;
      return p;
    }

    function doFlush() {
      if (!adapter) { return { ok: false, reason: 'no-adapter', queued: outbox.count() }; }
      /* 서버 roles 로 역할이 확인되지 않은 상태(로그인 전·roles 문서 없음)에서는 서버로 아무것도 보내지 않는다 */
      if (effectiveRole() === 'none') {
        emit('role-blocked', { role: 'none', verified: verifiedRole, queued: outbox.count() });
        return { ok: false, reason: 'role-unverified', queued: outbox.count() };
      }
      if (!online()) {
        lastErrorKind = 'offline';
        emit('status', { state: 'offline', queued: outbox.count() });
        return { ok: false, reason: 'offline', queued: outbox.count() };
      }
      if (usage.blocked()) {
        var snap = usage.snapshot();
        emit('quota-blocked', snap);
        return { ok: false, reason: 'quota', blocked: true, queued: outbox.count(), usage: snap };
      }
      /* v53 — 모아 둔 문자 로그가 있으면 먼저 반영해 이번 배치에 함께 보낸다 */
      if (deferredEntries) { try { flushDeferred(); } catch (e) { lastError = errorText(e); } }
      var items = outbox.pending();
      if (!items.length) { return { ok: true, sent: 0 }; }

      var batches = [];
      for (var i = 0; i < items.length; i += SPARK.maxBatch) { batches.push(items.slice(i, i + SPARK.maxBatch)); }

      /* 한 묶음을 보낸다. 영구 거부(permission-denied 등)면 반씩 나눠(bisect) 문제 문서만 찾아낸다.
         예전에는 그 한 건 때문에 같은 배치의 정상 기록까지 전부 failed 가 되고,
         30초마다 같은 실패를 되풀이하며 그 뒤 기록까지 영원히 막혔다. */
      function commit(list) {
        var writes = 0, deletes = 0;
        list.forEach(function (it) { if (it.del === true) { deletes++; } else { writes++; } });
        return adapter.writeBatch(list.map(opOf)).then(function () {
          if (writes) { usage.record('writes', writes); }
          if (deletes) { usage.record('deletes', deletes); }
          return { ok: list, dead: [], transient: null, quota: false };
        }, function (err) {
          if (isQuotaError(err)) { return { ok: [], dead: [], transient: err, quota: true }; }
          if (!isPermanentError(err)) { return { ok: [], dead: [], transient: err, quota: false }; }
          if (list.length === 1) { return { ok: [], dead: list, transient: null, quota: false }; }
          var half = Math.ceil(list.length / 2);
          return commit(list.slice(0, half)).then(function (a) {
            if (a.transient) { return a; }
            return commit(list.slice(half)).then(function (b) {
              return { ok: a.ok.concat(b.ok), dead: a.dead.concat(b.dead), transient: b.transient, quota: b.quota };
            });
          });
        });
      }

      var okItems = [], deadItems = [], failedItems = [];
      var fatalError = null, quotaError = null;

      function runBatches(bi) {
        if (bi >= batches.length) { return Promise.resolve(); }
        return commit(batches[bi]).then(function (res) {
          okItems = okItems.concat(res.ok);
          deadItems = deadItems.concat(res.dead);
          if (res.transient) {
            var doneIds = {};
            res.ok.concat(res.dead).forEach(function (it) { doneIds[it.id] = 1; });
            for (var j = bi; j < batches.length; j++) {
              batches[j].forEach(function (it) { if (!doneIds[it.id]) { failedItems.push(it); } });
            }
            fatalError = res.transient;
            if (res.quota) { quotaError = res.transient; }
            return;
          }
          return runBatches(bi + 1);
        });
      }

      /* 출결 툼스톤이 규칙(create 검사)에 막혔을 때의 마지막 구제책 —
         문서가 서버에 없으면 그냥 지우면 된다(삭제는 관리자면 언제나 허용, 없는 문서 삭제도 성공). */
      function rescueDeadTombstones(list) {
        var ok = [], dead = [];
        var chain = Promise.resolve();
        (list || []).forEach(function (it) {
          chain = chain.then(function () {
            var isEventTomb = !!(it.body && it.body._deleted === true) && String(it.path || '').indexOf('/attendanceEvents/') !== -1;
            if (!isEventTomb) { dead.push(it); return; }
            return Promise.resolve(adapter.writeBatch([{ path: it.path, del: true }])).then(function () {
              usage.record('deletes', 1);
              ok.push(it);
            }, function () { dead.push(it); });
          });
        });
        return chain.then(function () { return { ok: ok, dead: dead }; });
      }

      function finishFailure(finalOk) {
        if (finalOk.length) {
          /* 일부는 성공했으나 ACK 전에 오류 — 성공분은 서버 확인을 기다린다 */
          outbox.mark(finalOk.map(function (it) { return it.id; }), 'sent-unacked', fatalError);
          lastError = errorText(fatalError);
          emit('ack-failed', { error: lastError, queued: outbox.count() });
          return { ok: false, reason: 'ack', error: lastError, queued: outbox.count() };
        }
        if (quotaError) {
          usage.blockByError(quotaError);
          emit('quota-blocked', usage.snapshot());
        } else if (failedItems.length) {
          outbox.mark(failedItems.map(function (it) { return it.id; }), 'failed', fatalError);
        }
        var ne = normalizeError(fatalError);
        var isOff = ne.code === 'unavailable' || /offline|network|failed to fetch|ERR_NETWORK/i.test(ne.message);
        lastError = errorText(fatalError);
        lastErrorKind = quotaError ? 'quota' : (isOff ? 'offline' : 'error');
        emit('flush-failed', { error: lastError, queued: outbox.count(), kind: lastErrorKind });
        return { ok: false, reason: lastErrorKind === 'quota' ? 'quota' : (isOff ? 'offline' : 'error'), error: lastError, queued: outbox.count() };
      }

      return runBatches(0).then(function () {
        if (!deadItems.length) { return { ok: okItems, dead: deadItems }; }
        return rescueDeadTombstones(deadItems).then(function (r) {
          return { ok: okItems.concat(r.ok), dead: r.dead };
        });
      }).then(function (res) {
        var finalOk = res.ok, finalDead = res.dead;
        if (finalDead.length) {
          outbox.mark(finalDead.map(function (it) { return it.id; }), 'dead', { code: 'permission-denied', message: '서버가 받아 주지 않습니다(규칙 확인 필요)' });
          emit('dead-letters', {
            count: outbox.deadCount(),
            paths: finalDead.slice(0, 20).map(function (it) { return it.path; }),
            at: isoOf(now())
          });
        }
        if (fatalError) { return finishFailure(finalOk); }
        if (!finalOk.length) {
          if (finalDead.length) { return { ok: true, sent: 0, dead: finalDead.length, queued: outbox.count() }; }
          return { ok: true, sent: 0 };
        }
        /* setDoc/writeBatch 성공만으로는 부족 — 서버 저장 확인(ACK)까지 기다린 뒤 큐에서 지운다 */
        var ack = (adapter && typeof adapter.acknowledge === 'function') ? adapter.acknowledge() : true;
        return Promise.resolve(ack).then(function () {
          outbox.remove(finalOk.map(function (it) { return it.id; }));
          markShadowConfirmed(finalOk);
          lastSyncAt = isoOf(now());
          lastError = '';
          lastErrorKind = '';
          /* v52 — 과거 출결 묶음을 다 보냈으면 "서버에 N건 있음"을 meta/usage 에 남긴다 */
          if (eventPump.done && eventPump.total > 0 &&
              (!eventPump.marker || num(eventPump.marker.count) !== num(eventPump.total))) {
            eventPump.marker = { at: lastSyncAt, count: num(eventPump.total), by: String(deviceId) };
            scheduleUsagePush(1500);
          }
          emit('synced', { sent: finalOk.length, at: lastSyncAt });
          return { ok: true, sent: finalOk.length, dead: finalDead.length, queued: outbox.count() };
        }, function (err) {
          outbox.mark(finalOk.map(function (it) { return it.id; }), 'sent-unacked', err);
          lastError = errorText(err);
          emit('ack-failed', { error: lastError, queued: outbox.count() });
          return { ok: false, reason: 'ack', error: lastError, queued: outbox.count() };
        });
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
      var s = { state: 'local', text: '⚪ 미연결(로컬 모드)', queued: outbox.count(), lastSyncAt: lastSyncAt, lastError: lastError, mode: adapter ? adapter.mode : 'local', role: effectiveRole(), verifiedRole: verifiedRole };
      if (usage.blocked()) {
        var q = null;
        try { q = usage.snapshot(); } catch (e) { q = null; }
        s.state = 'blocked';
        s.text = (q && q.totalBlock) ? '🔴 전체 기기 사용량이 한도에 가까움 · 동기화 멈춤' : '🔴 한도 초과 · 동기화 멈춤';
        return s;
      }
      if (!adapter) { return s; }
      if (effectiveRole() === 'none') {
        s.state = 'role';
        s.text = (verifiedRole === '') ? '🔑 관리자 계정 아님 · 로그인 필요' : '🔑 관리자 확인 중';
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
      var plan = { keys: [], docs: [], total: 0, batches: 0, synced: 0, localOnly: 0, derived: 0, keyCount: 0, derivedKeys: 0, deferred: 0 };
      var all = [];
      var seenKeys = {};
      var today = dayOf(now());
      registry.forEach(function (e) {
        var row = {
          name: e.name, key: e.key, label: e.label, icon: e.icon, kind: e.kind, desc: e.desc,
          count: 0, localOnly: e.kind === 'local', derived: !!e.derivedFrom, coll: e.coll || '', meta: e.meta || ''
        };
        if (!seenKeys[e.key]) { seenKeys[e.key] = 1; plan.keyCount++; }
        if (e.kind !== 'local') {
          var docs = docsForEntry(e, readValue(e.name), base, { deviceId: deviceId }).filter(function (d) {
            /* v52 — 과거 수동·CSV 출결은 수동 이전 대신 자동 분할 업로드가 맡는다(한도 보호) */
            if (!isDayOnlyEvent(d.body) || !(String(d.body.date || '') < today)) { return true; }
            plan.deferred++;
            return false;
          });
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
        if (isDayOnlyEvent(prev.doc.body) && !isDayOnlyEvent(item.doc.body)) { byPath[item.doc.path] = item; return; }
        if (isDayOnlyEvent(item.doc.body) && !isDayOnlyEvent(prev.doc.body)) { return; }
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
      var today = dayOf(now());
      var out = [];
      registry.forEach(function (e) {
        if (e.kind === 'local') { return; }
        docsForEntry(e, readValue(e.name), base, { deviceId: deviceId }).forEach(function (d) {
          /* v52 — 과거 수동·CSV 출결은 수동 이전에서 건너뛴다(자동 분할 업로드가 올린다) */
          if (isDayOnlyEvent(d.body) && String(d.body.date || '') < today) { return; }
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
      /* 중복 경로 정리 — 시각 있는 기록이 시각 없는 자리표시보다 우선 */
      var map = {};
      out.forEach(function (it) {
        var prev = map[it.path];
        if (!prev || (isDayOnlyEvent(prev.body) && !isDayOnlyEvent(it.body))) { map[it.path] = it; }
      });
      return Object.keys(map).map(function (p) { return map[p]; });
    }

    /* ---------- v53 — 「이전(마이그레이션)」 사전 확인 ----------
       서버에 이미 자료가 있는데도 로컬 데이터를 한 번 더 올리면
       (이전은 문서마다 읽어 보므로 2,234건이면 읽기 2,234 + 쓰기 2,234)
       무료 한도를 한 번에 태운다. 먼저 서버에 자료가 있는지 몇 건만 읽어 보고 알려 준다. */
    function migrationGuard() {
      var base = basePath();
      var probePaths = [base + '/meta/settings', base + '/meta/feeTable', base + '/meta/logs'];
      if (!adapter || typeof adapter.getDocs !== 'function') {
        return Promise.resolve({ ok: false, checked: false, hasServerData: false, reason: 'no-adapter', paths: probePaths });
      }
      if (effectiveRole() !== 'admin') {
        return Promise.resolve({ ok: false, checked: false, hasServerData: false, reason: 'role-unverified', paths: probePaths });
      }
      var call;
      try { call = adapter.getDocs(probePaths); } catch (err) { call = Promise.reject(err); }
      return Promise.resolve(call).then(function (list) {
        usage.record('reads', probePaths.length);
        var hits = [];
        (list || []).forEach(function (r) {
          if (r && r.exists) { hits.push(String(r.path || '').replace(base + '/', '')); }
        });
        return {
          ok: true, checked: true, hasServerData: hits.length > 0, hits: hits,
          readPaths: probePaths.length, paths: probePaths, at: isoOf(now())
        };
      }, function (err) {
        return { ok: false, checked: false, hasServerData: false, error: errorText(err), paths: probePaths };
      });
    }

    function runMigration(opts2) {
      opts2 = opts2 || {};
      /* 이전은 관리자로 확인된 기기에서만 */
      if (!isEffectiveAdmin()) {
        return Promise.resolve({
          ok: false,
          reason: 'role-unverified',
          message: '서버 roles 문서로 관리자 역할이 확인되지 않았습니다 — 관리자 계정으로 로그인한 뒤 다시 시도해 주세요.'
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
    /* v51 — 예전 버그가 남긴 잘못된 원비 월 키(`2026-11_stu` + 원생 `mwp7…`)를
       올바른 자리(`2026-11` + `stu_mwp7…`)로 옮겨 적는다.
       이걸 먼저 하지 않으면 앱이 그 기록을 못 보는 상태에서 원비를 한 번 저장할 때
       서버의 정상 문서가 "사라진 것"으로 보여 삭제 표시될 수 있다.
       writeValue 는 스스로를 업로드로 잡지 않는다(applying). */
    function healTuitionKeys() {
      var cur = readValue('tuition');
      var fixed = normalizeTuitionMap(cur);
      if (!fixed.changed) { return false; }
      var ok = writeValue('tuition', fixed.months);
      prevValues['tuition'] = fixed.months;
      if (ok) { emit('tuition-keys-healed', { keys: Object.keys(fixed.months) }); }
      return !!ok;
    }
    /* 지금 기기에 있는 데이터를 "이미 아는 상태"로 그림자에 올린다.
       → 아무것도 바꾸지 않았는데 처음 열었다는 이유로 전부 다시 보내는 일이 없다. */
    function seedShadow() {
      var base = basePath();
      registry.forEach(function (e) {
        if (e.kind === 'local') { return; }
        if (e.kind === 'events') {
          /* v52 — 시각 없는 수동·CSV 출석은 "이미 아는 상태"로 채우지도, 해시하지도 않는다.
             서버에 아직 없을 수 있으므로(예전 버전은 문서를 만들지 않았다) 분할 업로더가
             한도에 여유가 있을 때 차례로 올린다. 올린 뒤에는 그림자에 진짜 항목이 생겨
             (v>=1) 다시 올리지 않는다. */
          var map = unionEventDocs(readValue('attendance'), readValue('records'), base, { skipDayOnly: true });
          Object.keys(map).forEach(function (p) {
            if (shadow[p]) { return; }
            var b = map[p].body;
            if (!b || isDayOnlyEvent(b)) { return; }
            putShadowEntry(p, { v: 0, m: {}, u: '', by: '', d: false, h: eventHash(b), b: null, t: b.time });
          });
          return;
        }
        docsForEntry(e, readValue(e.name), base, { deviceId: deviceId }).forEach(function (d) {
          if (shadow[d.path]) { return; }
          var body = d.body;
          putShadowEntry(d.path, { v: 0, m: {}, u: '', by: '', d: false, h: contentHash(body), b: mergeMetaBody(body, {}), t: body.time });
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
      /* v51 — 원비 월 키를 먼저 바로잡고 그림자를 채운다 */
      try { healTuitionKeys(); } catch (e) { lastError = errorText(e); }
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
      /* v52 — 과거 수동·CSV 출결 분할 업로드 시작 (다른 기기가 이미 올려 둔 기록을 받아 본 뒤) */
      scheduleEventPump(EVENT_UPLOAD.delayMs);
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
      emit('status', status());
      return api;
    }

    function stop() {
      started = false;
      /* v53 — 닫기 전에 모아 둔 문자 로그를 반영해 둔다(다음 실행에서 빠지지 않게) */
      try { if (deferredEntries) { flushDeferred(); } } catch (e) {}
      flushReads();
      stopUsageSync();
      saveLastSync();
      if (unsub) { try { unsub(); } catch (e) {} unsub = null; }
      if (retryTimer) { clearInterval(retryTimer); retryTimer = null; }
      if (root.removeEventListener) {
        try { root.removeEventListener('online', onOnline); root.removeEventListener('offline', onOffline); } catch (e) {}
      }
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      if (reloadTimer) { clearTimeout(reloadTimer); reloadTimer = null; }
      if (eventPump.timer) { try { clearTimeout(eventPump.timer); } catch (e) {} eventPump.timer = null; }
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
      /* 「🗑️ 실패 비우기」 — failed 항목만 지운다 */
      clearFailed: clearFailed,
      role: function () { return effectiveRole(); },
      effectiveRole: effectiveRole,
      verifiedRole: function () { return verifiedRole; },
      setVerifiedRole: applyVerifiedRole,
      verifyRole: verifyRole,
      /* v53 — roles/{uid} 확인 횟수·마지막 결과 (부팅 1회 공유 확인용 진단) */
      roleCheck: function () {
        return {
          reads: num(roleCheckState.reads),
          uid: roleCheckState.uid,
          verified: roleCheckState.result ? String(roleCheckState.result.verified || '') : '',
          at: roleCheckState.at ? isoOf(roleCheckState.at) : '',
          pending: !!roleCheckState.promise,
          ttlMs: ROLE_CHECK_TTL_MS
        };
      },
      /* v53 — 문자 로그 묶음 저장 */
      flushDeferred: flushDeferred,
      deferredState: deferredState,
      /* v53 — 지연 구독 */
      ensureLoaded: ensureLoaded,
      lazyPending: lazyPending,
      lazyState: lazyState,
      /* v53 — 「이전」 사전 확인 */
      migrationGuard: migrationGuard,
      rescanLocal: rescanLocal,
      device: function () { return deviceId; },
      setDojang: function (d) { dojangId = safeId(d || 'mta-tkd'); },
      attachAdapter: attachAdapter,
      adapter: function () { return adapter; },
      subscribe: function (fn) { listeners.push(fn); return function () { listeners = listeners.filter(function (x) { return x !== fn; }); }; },
      flush: flush,
      handleWrite: handleWrite,
      /* v52 — 과거 수동·CSV 출결 분할 업로드 상태·수동 실행(진단·테스트) */
      eventBacklog: eventBacklogState,
      pumpEventBacklog: pumpEventBacklog,
      eventUploadRoom: eventUploadRoom,
      scheduleEventPump: scheduleEventPump,
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
      flushReads: flushReads,
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
      /* v51 — 드라이브 복원 중에는 로컬 전량 쓰기를 올리지 않는다(역류 차단) */
      setSuppressCapture: setSuppressCapture,
      restoring: function () {
        return {
          suppressed: suppressCapture, at: restoreAt, keys: Object.keys(suppressedKeys),
          reconciled: restoreReconciled ? clone(restoreReconciled) : null
        };
      },
      /* v51 — 대량 삭제 차단 상태 (화면·진단용) */
      bulkDeleteState: function () { return clone(bulkDeleteBlocked); },
      /* v55 — 사용자가 화면에서 확인한 "대량 삭제 1회 허용".
           opts.collections 를 주면 그 컬렉션만, 없으면 다음 대량 삭제 한 번만 통과한다. */
      allowBulkDeleteOnce: function (opts) {
        var o = isPlain(opts) ? opts : {};
        var cols = null;
        if (Array.isArray(o.collections) && o.collections.length) {
          cols = {};
          o.collections.forEach(function (c) { cols[String(c)] = 1; });
        }
        bulkApproval = { at: isoOf(now()), collections: cols, once: true, src: String(o.src || 'ui') };
        emit('bulk-delete-allow-once', { at: bulkApproval.at, collections: cols ? Object.keys(cols) : 'all' });
        return { ok: true, at: bulkApproval.at, collections: cols ? Object.keys(cols) : 'all' };
      },
      bulkDeleteApproval: function () { return clone(bulkApproval); },
      clearBulkDeleteApproval: function () { bulkApproval = null; return true; },
      /* v55 — 받아 두지 않은 범위라 보류한 삭제 (화면 안내용) */
      deleteHeldState: function () {
        var n = Object.keys(pendingDeletes).length;
        var h = clone(deleteHeld) || {};
        h.pending = n;
        if (n > 0) {
          h.count = n;
          h.paths = Object.keys(pendingDeletes).slice(0, 20);
          h.message = h.message || ('아직 받지 않은 범위의 삭제 ' + n + '건은 묶음을 받은 뒤 다시 지웁니다.');
        }
        return (n > 0 || deleteHeld) ? h : null;
      },
      /* v55 — 서버가 영구 거부해 격리한 항목 (화면·진단용) */
      deadLetters: function (limit) { return outbox.dead(limit); },
      retryDeadLetters: function () { var n = outbox.retryDead(); if (n) { scheduleFlush(); } return n; },
      /* v51 — 원비 문서 ID 해석 결과 (진단용) */
      tuitionState: function () {
        return { skipped: skippedTuitionIds, lastSkippedId: lastSkippedTuitionId };
      },
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
      setRole: function (r) { return r === 'admin' ? 'admin' : 'none'; },
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
    /* 역할을 확인하기 전에는 아무것도 구독하지 않는다('none') —
       roles/{uid} 가 admin 으로 확인되는 순간 엔진이 resubscribe() 로 구독을 연다.
       (v43: 태블릿 구독은 없어졌다 — 모든 기기가 관리자 계정 하나를 쓴다) */
    var role = (opts.role === 'admin') ? 'admin' : 'none';
    var unsubs = [];
    /* =========================================================================
       v53 — 지연(묶음) 구독
       -------------------------------------------------------------------------
       새 기기에서 앱을 열면 지금까지 상담·차량·쿠폰·과거 원비까지 한꺼번에 읽었다.
       첫 화면에 필요한 것은 원생·최근 출결·최근 원비·설정(meta)뿐이므로,
         · core   : students · meta · attendanceEvents · tuition(최근 몇 달)
         · counsel / shuttle / coupons : 그 탭을 열 때
         · tuition: 「원비 관리」·수납 리포트·1년 조회·백업처럼 전체가 필요할 때
       로 나눠 연다. 한 번 연 묶음은 다시 구독해도 그대로 다시 연다.
         · 기존 기기(이미 자료가 있거나 델타 기준 시각이 있는 기기)는 예전처럼
           tuition 델타 구독을 쓴다 — 다른 기기의 지난달 수정도 놓치지 않는다
         · 새 기기만 최근 몇 달(documentId 범위)으로 시작한다
         · 규칙(firestore.rules)은 그대로 — 같은 컬렉션을 조건만 달리 읽는다
       ========================================================================= */
    var lazyEnabled = opts.lazy !== false;
    var openedGroups = {};        /* 이 세션에서 사용자가 연 지연 묶음 */
    var groupState = {};          /* 묶음별 구독 상태(현재 subscribe 호출 기준) */
    var coverageState = { tuition: 'full' };   /* tuition: 'full' | 'recent' */
    var openGroupApi = null;      /* 현재 subscribe 가 만든 openGroup — 엔진이 부른다 */
    var groupWaiters = {};        /* 구독이 열리기 전에 온 openGroup 요청 */
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

    /* v49 — 연결 전체(CDN 모듈 내려받기 → Firestore 초기화 → 로그인 세션 복원)에 시간 제한.
       모바일 네트워크에서 firebase-*.js 요청이 멈추거나 initializeFirestore 가 끝나지 않아도
       첫 화면이 「로그인 상태를 확인하는 중…」에 갇히지 않게 한다.
       connect() 가 동기적으로 예외를 던져도 reject 로 바꿔 화면이 원인을 안내하고 빠져나간다. */
    var connectTimeoutMs = Number(opts.connectTimeoutMs) > 0 ? Number(opts.connectTimeoutMs) : 8000;
    function connectBounded() {
      return withinTime(Promise.resolve().then(function () { return connect(); }), connectTimeoutMs, function () {
        return {
          code: 'connect-timeout',
          message: 'Firebase 연결이 ' + Math.round(connectTimeoutMs / 1000) + '초 안에 끝나지 않았습니다 — 모바일 인터넷·방화벽을 확인해 주세요'
        };
      });
    }

    var api = {
      mode: 'firestore',
      label: 'Firebase Firestore',
      connect: connectBounded,
      /* 서버 roles 로 확인된 유효 권한을 반영한다 (관리자 구독은 'admin' 일 때만) */
      setRole: function (r) { role = (r === 'admin') ? 'admin' : 'none'; return role; },
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
      /* v53 — 지연 묶음 열기. 엔진(ensureLoaded)이 부르고, 화면은 그 탭을 열 때 부른다. */
      openGroup: function (name) {
        var key = String(name == null ? '' : name);
        if (role !== 'admin') {
          /* 로그인 확인 전 — 이때는 아무것도 읽지 않는다(로그인 뒤 탭을 다시 열면 열린다) */
          return Promise.resolve({ ok: false, group: key, loaded: false, reason: 'role-unverified' });
        }
        if (typeof openGroupApi === 'function') { return openGroupApi(key); }
        /* 아직 구독 전 — 요청만 기억해 두고, 구독이 열릴 때 함께 연다 */
        openedGroups[key] = true;
        if (!groupWaiters[key]) { groupWaiters[key] = []; }
        return new Promise(function (resolve) {
          groupWaiters[key].push(resolve);
          setTimeout(function () {
            var list = groupWaiters[key] || [];
            groupWaiters[key] = [];
            list.forEach(function (fn) { try { fn({ ok: false, group: key, loaded: false, reason: 'not-connected' }); } catch (e) {} });
          }, LAZY_READY_TIMEOUT_MS);
        });
      },
      /* 지금 어떤 묶음이 열려 있는지 (진단·테스트) */
      coverage: function () {
        var groups = {};
        Object.keys(groupState).forEach(function (k) {
          groups[k] = { started: !!groupState[k].started, done: !!groupState[k].done, subs: (groupState[k].unsubs || []).length };
        });
        return {
          lazy: !!lazyEnabled,
          tuition: coverageState.tuition,
          core: groups.core ? groups.core.done : false,
          counsel: !!(groups.counsel && groups.counsel.done),
          shuttle: !!(groups.shuttle && groups.shuttle.done),
          coupons: !!(groups.coupons && groups.coupons.done),
          tuitionFull: coverageState.tuition === 'full',
          groups: groups
        };
      },
      subscribe: function (fn) {
        var fs = mods.firestore;
        var basePath = opts.basePath || ('dojangs/' + (cfg.dojangId || 'mta-tkd'));
        var since = new Date(Date.now() - 7 * 24 * 3600 * 1000);
        var sinceIso = since.toISOString().slice(0, 10);
        /* roles/{uid} 가 admin 으로 확인되기 전에는 아무 컬렉션도 구독하지 않는다
           → 로그인 전·비관리자 계정으로는 읽기 자체를 쓰지 않는다 */
        if (role !== 'admin') { return function () {}; }
        /* 출결은 첫 전체 구독에서 최근 7일만 — 오래된 기록까지 매번 읽지 않아 무료 한도를 아낀다 */
        var eventSpec = { path: basePath + '/attendanceEvents', coll: 'attendanceEvents', group: 'core', where: { field: 'date', op: '>=', value: sinceIso } };
        var store = lastSyncStore(opts.lastSyncStorage);
        var lastMap = opts.fullSync === true ? {} : readLastSync(store);
        var nowMs = Date.now();
        var log = (opts.snapshotLog && typeof opts.snapshotLog.push === 'function') ? opts.snapshotLog : null;
        var base = basePath;
        groupState = {};
        /* 이 기기에 그 컬렉션 자료가 없으면(새 기기·초기화) 델타를 쓰지 않는다 */
        function deltaAllowed(coll) {
          if (typeof opts.hasLocalData === 'function') {
            try { return opts.hasLocalData(coll) !== false; } catch (e) { return true; }
          }
          if (opts.hasLocalData === false) { return true; }
          return localDataHas(store, coll);
        }
        /* v53 — 델타 기준 시각은 기기 시계(Date.now)가 아니라 서버 문서의 `_updatedAt` 최댓값.
           기기 시계가 앞서 있으면 그 뒤에 다른 기기가 쓴 변경이 델타에서 영영 빠질 수 있었다(7-5).
           문서 시각이 없는 스냅샷(0건)으로는 기준을 올리지 않는다. */
        function noteSync(coll, atIso) {
          if (!coll) { return; }
          var t = docTimeMs(atIso);
          if (!(t > 0)) { return; }
          var m = readLastSync(store);
          if (num(m[coll]) >= t) { return; }
          m[coll] = t;
          writeLastSync(store, m);
        }

        function newGroup(name) {
          return { name: name, specs: {}, unsubs: [], started: false, done: false, waiters: [], timer: null };
        }
        function groupOf(name) {
          if (!groupState[name]) { groupState[name] = newGroup(name); }
          return groupState[name];
        }
        function finishGroup(name, payload) {
          var g = groupState[name];
          if (!g || g.done) { return; }
          g.done = true;
          if (g.timer) { try { clearTimeout(g.timer); } catch (e) {} g.timer = null; }
          var list = g.waiters || [];
          g.waiters = [];
          list.forEach(function (wait) {
            try {
              wait({ ok: true, group: name, loaded: payload.loaded !== false,
                     ready: true, partial: !!payload.partial, specs: Object.keys(g.specs).length });
            } catch (e) {}
          });
        }
        function waitGroup(name) {
          var g = groupOf(name);
          if (g.done) { return Promise.resolve({ ok: true, group: name, loaded: true, ready: true }); }
          return new Promise(function (resolve) {
            g.waiters.push(resolve);
            if (g.timer) { return; }
            /* 한도 초과·오프라인으로 스냅샷이 끝내 오지 않아도 화면이 멈추지 않게 */
            g.timer = setTimeout(function () {
              g.timer = null;
              if (g.done) { return; }
              finishGroup(name, { loaded: false, partial: true });
            }, LAZY_READY_TIMEOUT_MS);
          });
        }
        /* 스펙 하나를 실제로 구독한다 (같은 묶음 안에서 이미 연 스펙은 건너뛴다) */
        function openSpec(spec) {
          var gname = spec.group || 'core';
          var g = groupOf(gname);
          var key = String(spec.coll) + '|' + String(spec.mode || 'all');
          if (g.specs[key]) { return false; }
          g.specs[key] = 1;
          var coll = fs.collection(db, spec.path);
          var q = coll;
          var sinceVal = '';
          var whereField = '';
          if (spec.range && spec.range.from && typeof fs.documentId === 'function') {
            /* 새 기기 — 원비는 최근 몇 달(documentId 가 YYYY-MM_원생ID)만 먼저 */
            q = fs.query(coll, fs.where(fs.documentId(), '>=', spec.range.from));
            whereField = 'documentId';
          } else if (spec.delta !== false && deltaAllowed(spec.coll)) {
            sinceVal = deltaSinceIso(lastMap[spec.coll], nowMs);
          }
          if (!whereField) {
            if (sinceVal) {
              /* 단일 필드 where → 자동 인덱스. 확장 필드가 아니라 _updatedAt 이라 규칙 수정도 불필요 */
              q = fs.query(coll, fs.where('_updatedAt', '>', sinceVal));
              whereField = '_updatedAt';
            } else if (spec.where) {
              q = fs.query(coll, fs.where(spec.where.field, spec.where.op, spec.where.value));
              whereField = spec.where.field;
            }
          }
          if (log) { log.push({ coll: spec.coll, path: spec.path, group: gname, mode: spec.mode || 'all', since: sinceVal, where: whereField }); }
          var un = fs.onSnapshot(q, { includeMetadataChanges: false }, function (snap) {
            /* 캐시에서 온 스냅샷은 서버 읽기가 아니다 — 계량기에 넣지 않고 마지막 시각도 안 새긴다 */
            var fromCache = !!(snap && snap.metadata && snap.metadata.fromCache === true);
            var meta = { ver: 0, fromCache: fromCache, coll: spec.coll };
            /* v50 — 한 스냅샷에 수백 건이 들어 있어도(로그인 직후 첫 전체 스냅샷) 한 번에 처리하지 않고
               SNAPSHOT_CHUNK 건씩 끊어 반영한다. 그 사이 브라우저가 화면을 그리고 터치를 받는다. */
            var changes = [];
            try {
              snap.docChanges().forEach(function (ch) {
                if (ch.type === 'removed') { changes.push({ path: ch.doc.ref.path, data: null }); }
                else { changes.push({ path: ch.doc.ref.path, data: ch.doc.data() }); }
              });
            } catch (e) { changes = []; }
            /* v53 — 이번 스냅샷 문서들의 `_updatedAt` 최댓값 = 다음 델타의 기준 */
            var maxAt = '';
            changes.forEach(function (c) {
              var u = (c && c.data) ? c.data._updatedAt : '';
              if (u && String(u) > maxAt) { maxAt = String(u); }
            });
            var applied = 0;
            function runChunk() {
              var end = Math.min(changes.length, applied + SNAPSHOT_CHUNK);
              if (typeof batchHooks.begin === 'function') { try { batchHooks.begin(); } catch (e) {} }
              try {
                for (; applied < end; applied++) {
                  try { fn(changes[applied].path, changes[applied].data, meta); } catch (e) {}
                }
              } finally {
                if (typeof batchHooks.end === 'function') { try { batchHooks.end(); } catch (e) {} }
              }
              if (applied < changes.length) {
                try { root.setTimeout(runChunk, 0); } catch (e) { runChunk(); }
                return;
              }
              if (!fromCache) { noteSync(spec.coll, maxAt); }
              finishGroup(gname, { loaded: true });
            }
            runChunk();
          }, function (err) {
            if (typeof opts.onError === 'function') { opts.onError(err); }
          });
          g.unsubs.push({ coll: spec.coll, fn: un });
          unsubs.push(un);
          return true;
        }
        /* 묶음 안의 한 컬렉션 구독을 닫는다 (원비 최근 몇 달 → 전체로 바꿀 때) */
        function closeSpecsOf(groupName, coll) {
          var g = groupState[groupName];
          if (!g) { return 0; }
          var closed = 0;
          g.unsubs = (g.unsubs || []).filter(function (it) {
            if (it && it.coll === coll) {
              try { if (typeof it.fn === 'function') { it.fn(); } } catch (e) {}
              closed++;
              return false;
            }
            return true;
          });
          Object.keys(g.specs).forEach(function (k) { if (String(k).split('|')[0] === coll) { delete g.specs[k]; } });
          return closed;
        }
        function startGroup(name) {
          var g = groupOf(name);
          if (g.started) { return; }
          g.started = true;
          if (name === 'tuition') {
            /* 최근 몇 달만 보던 구독을 닫고 전체 원비로 바꾼다 */
            if (coverageState.tuition !== 'full') { closeSpecsOf('core', 'tuition'); }
            coverageState.tuition = 'full';
            openSpec({ path: base + '/tuition', coll: 'tuition', group: 'tuition', mode: 'full' });
          } else {
            (LAZY_SPECS[name] || []).forEach(openSpec);
          }
          if (!Object.keys(g.specs).length) { finishGroup(name, { loaded: true }); }
        }
        /* ---------- 열 묶음 정의 (core 는 지금, 나머지는 필요할 때) ---------- */
        var tuitionHasLocal = deltaAllowed('tuition') || !!deltaSinceIso(lastMap.tuition, nowMs);
        coverageState.tuition = (lazyEnabled && !tuitionHasLocal) ? 'recent' : 'full';
        var coreSpecs = [
          { path: base + '/students', coll: 'students', group: 'core', mode: 'all' },
          /* meta 는 문서가 몇 개 안 되니 전체 구독 그대로(델타 대상 아님) */
          { path: base + '/meta', coll: 'meta', group: 'core', delta: false, mode: 'all' },
          { path: base + '/tuition', coll: 'tuition', group: 'core',
            mode: coverageState.tuition,
            range: coverageState.tuition === 'recent' ? { from: tuitionRecentFrom(Date.now()) } : null },
          eventSpec
        ];
        var LAZY_SPECS = {
          counsel: [{ path: base + '/counsel', coll: 'counsel', group: 'counsel', mode: 'all' }],
          shuttle: [{ path: base + '/shuttle', coll: 'shuttle', group: 'shuttle', mode: 'all' }],
          coupons: [{ path: base + '/coupons', coll: 'coupons', group: 'coupons', mode: 'all' }]
        };
        coreSpecs.forEach(openSpec);
        finishGroup('core', { loaded: true });      /* core 는 기다리지 않는다 */
        openGroupApi = function (name) {
          name = String(name == null ? '' : name);
          if (name === 'all') {
            var list = ['counsel', 'shuttle', 'coupons', 'tuition'];
            return Promise.all(list.map(function (n) { return openGroupApi(n); })).then(function (rs) {
              return {
                ok: true, group: 'all',
                loaded: rs.every(function (r) { return !!(r && r.loaded); }),
                results: rs
              };
            });
          }
          if (name === 'core') { return Promise.resolve({ ok: true, group: 'core', loaded: true }); }
          if (!LAZY_SPECS[name] && name !== 'tuition') {
            return Promise.resolve({ ok: false, group: name, reason: 'unknown-group' });
          }
          openedGroups[name] = true;
          if (name === 'tuition' && coverageState.tuition === 'full' && !groupState.tuition) {
            return Promise.resolve({ ok: true, group: 'tuition', loaded: true, already: true });
          }
          var waited = waitGroup(name);
          startGroup(name);
          return waited;
        };
        /* 구독이 열리기 전에 와 있던 요청을 처리한다 */
        Object.keys(groupWaiters).forEach(function (k) {
          var list = groupWaiters[k] || [];
          groupWaiters[k] = [];
          openGroupApi(k).then(function (r) {
            list.forEach(function (wait) { try { wait(r); } catch (e) {} });
          }, function (e) {
            list.forEach(function (wait) { try { wait({ ok: false, group: k, loaded: false, error: errorText(e) }); } catch (e2) {} });
          });
        });
        /* 다시 구독할 때 이미 열었던 지연 묶음은 그대로 다시 연다 */
        Object.keys(openedGroups).forEach(function (k) {
          if (openedGroups[k] && k !== 'all') { try { openGroupApi(k); } catch (e) {} }
        });
        return function () {
          Object.keys(groupState).forEach(function (k) {
            (groupState[k].unsubs || []).forEach(function (it) {
              try { if (it && typeof it.fn === 'function') { it.fn(); } } catch (e) {}
            });
          });
          groupState = {};
          openGroupApi = null;
          unsubs.forEach(function (u) { try { u(); } catch (e) {} });
          unsubs = [];
        };
      },
      /* 엔진이 넣는 묶음 처리 훅 — 문서 여러 건을 한 번에 저장하게 */
      setBatchHooks: function (beginFn, endFn) {
        batchHooks.begin = (typeof beginFn === 'function') ? beginFn : null;
        batchHooks.end = (typeof endFn === 'function') ? endFn : null;
      },
      test: function () {
        if (!db) { return Promise.resolve({ ok: false, message: '아직 연결되지 않았습니다' }); }
        /* 관리자 계정이 읽을 수 있는 문서 1건으로 연결을 확인한다 — 로그인 전이면 규칙이 거부한다 */
        var probe = opts.basePath || ('dojangs/' + (cfg.dojangId || 'mta-tkd'));
        probe += '/meta/settings';
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
    return connectBounded();
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
    LOCAL_KEYS: LOCAL_KEYS,
    buildRegistry: buildRegistry,
    createEngine: createEngine,
    createUsage: createUsage,
    DELTA: DELTA,
    SNAPSHOT_CHUNK: SNAPSHOT_CHUNK,
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
    withinTime: withinTime,
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
    parseTuitionDocId: parseTuitionDocId,
    normalizeTuitionMap: normalizeTuitionMap,
    tuitionNeedsRepair: tuitionNeedsRepair,
    isTuitionMonthKey: isTuitionMonthKey,
    BULK_DELETE_RATIO: BULK_DELETE_RATIO,
    BULK_DELETE_MIN_DOCS: BULK_DELETE_MIN_DOCS,
    NO_TIME: NO_TIME,
    EVENT_UPLOAD: EVENT_UPLOAD,
    isDayOnlyEvent: isDayOnlyEvent,
    docBody: docBody,
    unionEventDocs: unionEventDocs,
    unionArrays: unionArrays,
    eventIdOf: eventIdOf,
    parseEventId: parseEventId,
    safeId: safeId,
    isoOf: isoOf,
    dayOf: dayOf,
    /* v53 — 문서 시각(isoOf 형식) → ms · 최근 원비 시작 월 · 지연 묶음 준비 한도 */
    docTimeMs: docTimeMs,
    tuitionRecentFrom: tuitionRecentFrom,
    LAZY_READY_TIMEOUT_MS: LAZY_READY_TIMEOUT_MS,
    sparkDayOf: sparkDayOf,
    errorText: errorText,
    isQuotaError: isQuotaError
  };
});
