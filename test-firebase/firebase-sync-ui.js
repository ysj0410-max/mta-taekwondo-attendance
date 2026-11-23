/* =============================================================================
   경희대MTA태권도 — 🔥 Firebase 실시간 동기화 설정 패널 (테스트 버전 전용)
   -----------------------------------------------------------------------------
   · 「🔐 관리자 계정」 탭 안에 「🔥 Firebase 실시간 동기화」 패널을 살립니다.
   · firebaseConfig 는 코드에 넣지 않고, 이 화면에서 붙여넣어 기기(localStorage)에
     저장합니다. (tdk.fbConfig.v1 — 다른 기기로 자동 전송되지 않습니다)
   · 모의 모드(🧪)에서는 실제 Firebase 없이 전 기능을 그대로 연습할 수 있습니다.
     같은 브라우저에서 탭을 두 개 열면 PC·태블릿처럼 서로 동기화됩니다.
   ============================================================================= */
(function () {
  'use strict';

  var FB = window.TDKFirebaseSync;
  if (!FB) { return; }

  var CFG_KEY = 'tdk.fbConfig.v1';
  var DEV_KEY = 'tdk.fbDevice.v1';
  var RELAY_KEY = 'tdk.fbSmsRelay.v1';     /* 태블릿 출석을 관리자 PC가 대신 문자로 보낸 표시 */
  var RELAY_WINDOW_MS = 60 * 60 * 1000;    /* 한 시간 안에 도착한 출석만 대신 보낸다 */
  var DEFAULT_DOJANG = 'mta-tkd';

  var S = {
    engine: null,
    server: null,
    adapter: null,
    cfg: { mode: 'off', dojangId: DEFAULT_DOJANG, role: 'admin', config: null },
    plan: null,
    queueOpen: false,
    auth: null,
    busy: false,
    connecting: null,
    msg: '',
    msgKind: '',
    timer: null
  };

  function $(id) { return document.getElementById(id); }
  function val(id) { var e = $(id); return e ? String(e.value == null ? '' : e.value) : ''; }
  function setText(id, text) { var e = $(id); if (e) { e.textContent = text; } }
  function setHtml(id, html) { var e = $(id); if (e) { e.innerHTML = html; } }
  function show(id, on) { var e = $(id); if (e) { e.style.display = on ? '' : 'none'; } }

  /* 예외가 나도 화면에 반드시 남긴다 — 로그인·연결이 조용히 멈추지 않게 */
  function showError(prefix, err) {
    S.msg = prefix + FB.errorText(err);
    S.msgKind = 'warn';
    try { renderAll(); } catch (e) {}
  }

  function readJSON(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      if (!raw) { return fallback; }
      var v = JSON.parse(raw);
      return v == null ? fallback : v;
    } catch (e) { return fallback; }
  }
  function writeJSON(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) {}
  }
  function deviceId() {
    var id = readJSON(DEV_KEY, '');
    if (typeof id === 'string' && id) { return id; }
    id = 'dev-' + Math.random().toString(36).slice(2, 8);
    writeJSON(DEV_KEY, id);
    return id;
  }
  function nowText(iso) {
    if (!iso) { return '-'; }
    var d = new Date(iso);
    if (isNaN(d.getTime())) { return iso; }
    return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2) +
      ' ' + ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2) + ':' + ('0' + d.getSeconds()).slice(-2);
  }
  function numText(n) { return String(n == null ? 0 : n).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  function baseName(path) {
    var p = String(path || '').split('/');
    var last = p[p.length - 1] || '';
    var coll = p.length > 2 ? p[p.length - 2] : '';
    return coll + '/' + last;
  }

  /* ---------- 설정 저장/읽기 ---------- */
  function loadConfig() {
    var raw = readJSON(CFG_KEY, null);
    if (!raw || typeof raw !== 'object') {
      return { mode: 'off', dojangId: DEFAULT_DOJANG, role: 'admin', config: null };
    }
    return {
      mode: raw.mode === 'mock' || raw.mode === 'firestore' ? raw.mode : 'off',
      dojangId: FB.safeId(raw.dojangId || DEFAULT_DOJANG),
      role: raw.role === 'tablet' ? 'tablet' : 'admin',
      config: raw.config && typeof raw.config === 'object' ? raw.config : null,
      lastSyncAt: raw.lastSyncAt || ''
    };
  }
  function saveConfig(next) {
    S.cfg = Object.assign({}, S.cfg, next || {});
    writeJSON(CFG_KEY, S.cfg);
  }

  /* ---------- 엔진 준비 ---------- */
  function stopEngine() {
    if (S.engine) { try { S.engine.stop(); } catch (e) {} S.engine = null; }
    if (S.adapter && typeof S.adapter.disconnect === 'function') { try { S.adapter.disconnect(); } catch (e) {} }
    if (S.server && typeof S.server.close === 'function') { try { S.server.close(); } catch (e) {} }
    S.adapter = null;
    S.server = null;
  }

  function appKeys() {
    try {
      if (window.__tdk && window.__tdk.LS) { return window.__tdk.LS; }
    } catch (e) {}
    return null;
  }

  function makeEngine(adapter) {
    var keys = appKeys();
    var engine = FB.createEngine({
      storage: localStorage,
      keys: keys || undefined,
      adapter: adapter,
      deviceId: deviceId(),
      dojangId: S.cfg.dojangId,
      role: S.cfg.role,
      /* 실제 Firebase 모드에서는 화면 선택값이 아니라 서버 roles/{uid} 로 권한을 잠근다 */
      requireServerRole: S.cfg.mode === 'firestore',
      reload: function () {
        try {
          if (window.__tdk && window.__tdk.sync && typeof window.__tdk.sync.reload === 'function') {
            window.__tdk.sync.reload();
          }
        } catch (e) {}
      },
      onEvent: function (type, payload) {
        if (type === 'quota-blocked') { showWarn(true); }
        if (type === 'synced') { saveConfig({ lastSyncAt: payload && payload.at }); }
        if (type === 'remote-event') { relaySms(payload); }
        if (type === 'tablet-private-data' && payload && payload.count) {
          S.msg = '⚠️ 이 태블릿에 원생 개인정보가 ' + payload.count + '명분 남아 있습니다. 태블릿에는 이름·띠만 있으면 되니, 개인정보를 지우려면 「💾 도장 데이터 전체 백업」을 받아 두고 이 브라우저의 사이트 데이터를 지운 뒤 다시 연결하세요.';
          S.msgKind = 'warn';
        }
        if (type === 'blocked-local') {
          S.msg = (payload && payload.reason === 'role-unverified')
            ? '🔒 서버에서 이 계정의 역할(roles 문서)을 확인하기 전에는 원생·원비·설정을 올리지 않습니다 — 역할에 맞는 계정으로 로그인해 주세요.'
            : '이 기기는 「출석 태블릿」 역할이라 원생·원비·설정을 Firestore로 올리지 않습니다(출결만 올립니다).';
          S.msgKind = 'warn';
        }
        if (type === 'role') {
          S.msg = roleLockText();
          S.msgKind = (payload && payload.role === 'none') ? 'warn' : 'ok';
        }
        if (type === 'role-blocked') {
          S.msg = '🔒 ' + roleLockText();
          S.msgKind = 'warn';
        }
        if (type === 'usage' && payload && payload.level >= 1) {
          S.msg = payload.level >= 2
            ? '🔴 무료 한도를 모두 사용했습니다 — 동기화를 잠시 멈추고 기기에 보관합니다.'
            : '🟡 무료 한도의 80%를 넘었습니다 — 남은 양을 확인해 주세요.';
          S.msgKind = 'warn';
        }
        renderAll();
      }
    });
    engine.start();
    S.engine = engine;
    return engine;
  }

  function connectMock() {
    stopEngine();
    S.server = FB.createMockServer({ storage: localStorage, channel: true });
    S.adapter = FB.createMockAdapter(S.server, { label: '모의 Firestore' });
    makeEngine(S.adapter);
    saveConfig({ mode: 'mock' });
    S.msg = '🧪 모의 Firestore 로 켰습니다 · 같은 브라우저에서 이 주소를 탭으로 하나 더 열면 PC↔태블릿처럼 동기화됩니다. (연습 모드는 로그인 없이 화면에서 고른 역할로 동작합니다)';
    S.msgKind = 'ok';
    renderAll();
  }

  function connectFirestore() {
    /* 연결 중에 「설정 저장·연결」을 또 눌러도 같은 연결을 기다린다 (앱 중복 생성 방지) */
    if (S.connecting) { return S.connecting; }
    var v = FB.validateConfig(S.cfg.config || {});
    if (!v.ok) {
      S.msg = '⚠️ 설정을 확인해 주세요: ' + v.errors.join(' / ');
      S.msgKind = 'warn';
      renderAll();
      return Promise.resolve(false);
    }
    stopEngine();
    S.msg = '🔥 Firebase 에 연결하는 중…';
    S.msgKind = '';
    renderAll();
    var connecting;
    try {
      connecting = FB.createFirestoreAdapter(Object.assign({ dojangId: S.cfg.dojangId }, v.config), {
        basePath: 'dojangs/' + S.cfg.dojangId,
        /* 역할을 서버에서 확인하기 전에는 어댑터도 태블릿(최소) 구독으로 시작한다 */
        onError: function (err) {
          S.msg = '⚠️ 실시간 구독 오류: ' + FB.errorText(err);
          S.msgKind = 'warn';
          renderAll();
        }
      });
    } catch (err) {
      showError('⚠️ 연결하지 못했습니다: ', err);
      return Promise.resolve(false);
    }
    var result = connecting.then(function (adapter) {
      try {
        S.adapter = adapter;
        var engine = makeEngine(adapter);
        saveConfig({ mode: 'firestore', config: v.config });
        S.msg = '🔥 Firebase 에 연결했습니다. 이제 역할에 맞는 계정으로 로그인하면 서버 roles 기준으로 권한이 정해집니다.';
        S.msgKind = 'ok';
        /* 이전에 로그인한 세션이 남아 있으면 바로 역할을 확인해 연결 상태를 갱신한다 */
        var cu = null;
        try { cu = (typeof adapter.currentUser === 'function') ? adapter.currentUser() : null; } catch (e) { cu = null; }
        if (cu && cu.uid) {
          S.auth = { uid: cu.uid, email: cu.email || '', role: '', expect: S.cfg.role };
          S.msg = '🔎 이전에 로그인한 계정(' + (cu.email || cu.uid) + ')의 역할을 서버에서 확인하는 중…';
          S.msgKind = '';
        }
        renderAll();
        var verifying;
        try { verifying = engine.verifyRole(); } catch (err) { verifying = Promise.reject(err); }
        return Promise.resolve(verifying).then(function (r) {
          try {
            if (r && r.uid) {
              S.auth = { uid: r.uid, email: r.email || '', role: r.verified || '', expect: S.cfg.role };
            }
            if (r && r.verified === 'admin') {
              S.msg = '✅ 관리자 계정(' + (r.email || r.uid) + ')으로 확인되었습니다 — 데이터 이전을 진행할 수 있습니다.';
              S.msgKind = 'ok';
            } else if (r && r.verified === 'tablet') {
              S.msg = '✅ 출석 태블릿 계정으로 확인되었습니다 — 출결만 올립니다. (화면의 「이 기기 역할」을 관리자로 바꿔도 관리자 권한은 생기지 않습니다)';
              S.msgKind = 'ok';
            } else {
              S.msg = '🔒 역할 확인 전입니다 — 아래 「' + roleLabel(S.cfg.role) + ' 계정」으로 로그인해 주세요. (로그인 전에는 서버로 아무것도 보내지 않습니다)';
              S.msgKind = 'warn';
            }
            renderAll();
          } catch (err) {
            showError('⚠️ 연결 상태를 화면에 표시하지 못했습니다: ', err);
          }
          return true;
        }, function (err) {
          showError('⚠️ 역할 확인에 실패했습니다: ', err);
          return true;
        });
      } catch (err) {
        showError('⚠️ 연결하지 못했습니다: ', err);
        return false;
      }
    }, function (err) {
      S.adapter = null;
      S.msg = '⚠️ 연결하지 못했습니다: ' + FB.errorText(err) + ' — 인터넷과 firebaseConfig 를 확인해 주세요.';
      S.msgKind = 'warn';
      renderAll();
      return false;
    });
    S.connecting = result;
    result.then(function () { if (S.connecting === result) { S.connecting = null; } },
      function () { if (S.connecting === result) { S.connecting = null; } });
    return result;
  }

  function disconnect() {
    stopEngine();
    saveConfig({ mode: 'off' });
    S.msg = '동기화를 껐습니다. 이 기기는 지금까지처럼 혼자 저장합니다(로컬 모드).';
    S.msgKind = '';
    renderAll();
  }

  /* ---------- 태블릿 출석 → 관리자 PC 문자 대행 ----------
     태블릿에는 보호자 전화번호가 없다(개인정보 분리). 그래서 켜져 있는 관리자 PC가
     다른 기기가 찍은 출석을 받아 그 원생의 보호자에게 문자를 보낸다.
     · 오늘 것 + 한 시간 안에 도착한 것만 (며칠 지난 기록을 몰아 보내지 않는다)
     · 같은 출석(date_studentId_in|out)은 한 번만 (발송표시를 기기에 남긴다) */
  function relayLog() {
    var v = readJSON(RELAY_KEY, {});
    return (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
  }
  function saveRelayLog(log) {
    var keys = Object.keys(log);
    if (keys.length > 800) {
      keys.sort(function (a, b) {
        return String((log[a] && log[a].at) || '').localeCompare(String((log[b] && log[b].at) || ''));
      }).slice(0, keys.length - 800).forEach(function (k) { delete log[k]; });
    }
    writeJSON(RELAY_KEY, log);
  }
  function relaySms(ev) {
    /* 관리자 권한이 서버 roles 로 확인된 기기만 대신 문자를 보낸다 */
    if (!ev || engineRole() !== 'admin') { return; }
    if (!ev.studentId || !ev.time || !ev.date) { return; }
    var today = new Date();
    var todayKey = today.getFullYear() + '-' + ('0' + (today.getMonth() + 1)).slice(-2) + '-' + ('0' + today.getDate()).slice(-2);
    if (ev.date !== todayKey) { return; }
    var at = Date.parse(String(ev.updatedAt || ''));
    if (!isFinite(at) || (Date.now() - at) > RELAY_WINDOW_MS) { return; }
    var key = ev.date + '_' + ev.studentId + '_' + (ev.eventKind === 'out' ? 'out' : 'in');
    var log = relayLog();
    if (log[key]) { return; }
    var hook = (window.__tdk && window.__tdk.kiosk && window.__tdk.kiosk.notifyAttendance);
    if (typeof hook !== 'function') { return; }
    var r = null;
    try { r = hook(ev.date, ev.studentId, ev.eventKind, ev.time); } catch (e) { r = null; }
    if (r && r.sent) {
      log[key] = { at: new Date().toISOString(), by: String(ev.by || ''), kind: ev.eventKind, name: String(r.name || '') };
      saveRelayLog(log);
      S.msg = '📨 다른 기기에서 온 출석을 받아 ' + (r.name || '원생') + ' 보호자에게 문자를 보냈습니다.';
      S.msgKind = 'ok';
    }
  }

  /* ---------- 상태 표시 ---------- */
  function chipFor(state) {
    if (state === 'online') { return 'ok'; }
    if (state === 'blocked') { return 'off'; }
    if (state === 'offline' || state === 'error') { return 'wait'; }
    return 'wait';
  }

  function renderStatus() {
    var st = S.engine ? S.engine.status() : { state: 'local', text: '⚪ 미연결(로컬 모드)', queued: 0 };
    var chip = $('fb-state');
    if (chip) {
      chip.textContent = st.text + (st.queued ? (' · 대기 ' + st.queued + '건') : '');
      chip.className = 'chip ' + chipFor(st.state);
    }
    var pill = $('fb-pill-state');
    if (pill) {
      var narrow = (typeof window.innerWidth === 'number' && window.innerWidth <= 760);
      var pillText = st.text;
      if (narrow) {
        /* 폰 화면에서는 버튼을 가리지 않도록 짧게 */
        pillText = st.state === 'online' ? '🟢 연결'
          : st.state === 'offline' ? ('🟡 대기' + (st.queued ? ' ' + st.queued : ''))
          : st.state === 'blocked' ? '🔴 한도'
          : st.state === 'error' ? '🟠 연결문제' : '⚪ 로컬';
      } else if (st.queued) {
        pillText = st.text + ' · 대기 ' + st.queued + '건';
      }
      pill.textContent = pillText;
      pill.className = 'fb-pill-state ' + st.state;
    }
    var tag = $('fb-pill-tag');
    if (tag && typeof window.innerWidth === 'number') {
      tag.textContent = window.innerWidth <= 760 ? '🧪 테스트 v5' : '🧪 Firebase 테스트 v5';
    }
    setText('fb-usage-note', S.engine
      ? (S.engine.usage.snapshot().date + ' 기준 · 이 기기에서 센 추정치 (PC·태블릿 합산 아님)')
      : '동기화를 켜면 표시됩니다');
    var lastSync = (S.engine && S.engine.errors().lastSyncAt) || S.cfg.lastSyncAt || '';
    setText('fb-sync-note', '마지막 동기화: ' + (lastSync ? nowText(lastSync) : '아직 없음') +
      (S.engine ? ' · 기기 ID ' + deviceId() : ''));
    showWarn(st.state === 'blocked');
  }

  function showWarn(on) {
    var el = $('fb-warn');
    if (!el) { return; }
    if (!on) { el.style.display = 'none'; return; }
    el.style.display = '';
    el.innerHTML = '🔴 <b>무료 한도를 모두 사용해 동기화를 잠시 멈췄습니다.</b><br>' +
      '지금 찍은 기록은 <b>이 기기 로컬에 임시 보관</b> 중이며, 한도가 풀리면(태평양 시간 자정) 자동으로 다시 보냅니다. ' +
      '유료 결제로 자동 전환되지 않습니다.<br>' +
      '그동안 <b>Google Drive 백업</b>(「💾 도장 데이터 전체 백업」 또는 「☁️ 드라이브 자동 백업」)을 받아 두시길 권합니다.';
  }

  function renderUsage() {
    var snap = S.engine ? S.engine.usage.snapshot() : {
      reads: 0, writes: 0, deletes: 0,
      limits: { reads: FB.SPARK.reads, writes: FB.SPARK.writes, deletes: FB.SPARK.deletes },
      pct: { reads: 0, writes: 0, deletes: 0 }, level: 0
    };
    [['reads', 'read', '읽기'], ['writes', 'write', '쓰기'], ['deletes', 'del', '삭제']].forEach(function (row) {
      var k = row[0], barId = 'fb-bar-' + row[1], txtId = 'fb-use-' + row[1];
      var pct = Math.min(1, snap.pct[k] || 0);
      var bar = $(barId);
      if (bar) {
        bar.style.width = Math.round(pct * 100) + '%';
        bar.className = pct >= 1 ? 'danger' : (pct >= FB.SPARK.warnRatio ? 'warn' : '');
      }
      setText(txtId, numText(snap[k]) + ' / ' + numText(snap.limits[k]) + '  (' + Math.floor((snap.pct[k] || 0) * 100) + '%)');
    });
    var note = $('fb-usage-note');
    if (note && snap.level >= 2) { note.textContent = '한도 초과 — 동기화를 멈추고 기기에 보관 중 (전체 사용량은 콘솔에서 확인)'; }
    else if (note && snap.level >= 1) { note.textContent = '이 기기 기준 80%를 넘었습니다 — 콘솔에서 전체 사용량을 확인하세요'; }
    var link = $('fb-console-link');
    if (link) {
      var pid = (S.cfg.config && S.cfg.config.projectId) || '';
      link.href = pid
        ? ('https://console.firebase.google.com/project/' + encodeURIComponent(pid) + '/firestore/usage')
        : 'https://console.firebase.google.com/';
      link.textContent = pid
        ? ('Firebase 콘솔 · ' + pid + ' Firestore 사용량 열기')
        : 'Firebase 콘솔 열기 (프로젝트를 고르면 Firestore → 사용량)';
    }
  }

  function renderQueue() {
    var out = S.engine ? S.engine.outbox : null;
    var sum = out ? out.summary() : { pending: 0, failed: 0, unacked: 0, sent: 0, oldestAt: '' };
    var chip = $('fb-queue-chip');
    if (chip) {
      var total = sum.pending + sum.failed + sum.unacked;
      chip.textContent = total ? ('대기 ' + total + '건' + (sum.failed ? ' · 실패 ' + sum.failed : '') + (sum.unacked ? ' · 확인대기 ' + sum.unacked : '')) : '대기 없음';
      chip.className = 'chip ' + (total ? (sum.failed ? 'off' : 'wait') : 'ok');
    }
    if (!S.queueOpen || !out) { return; }
    var items = out.list().filter(function (it) { return it.state !== 'sent'; }).slice(-40).reverse();
    if (!items.length) { setHtml('fb-queue-list', '<div class="tiny-note" style="padding:8px 0">대기 중인 기록이 없습니다.</div>'); return; }
    var stateText = { pending: '전송 대기', failed: '전송 실패', 'sent-unacked': '서버 확인 대기', sending: '보내는 중' };
    var html = items.map(function (it) {
      var cls = it.state === 'failed' ? 'off' : 'wait';
      return '<div class="fb-queue-row"><span class="chip ' + cls + '">' + (stateText[it.state] || it.state) + '</span>' +
        '<span class="fb-q-path">' + baseName(it.path) + '</span>' +
        '<span class="fb-q-time">' + nowText(it.at) + (it.attempts ? ' · ' + it.attempts + '회' : '') + '</span>' +
        (it.error ? '<span class="fb-q-err">' + it.error + '</span>' : '') + '</div>';
    }).join('');
    var old = sum.oldestAt ? ('가장 오래된 대기: ' + nowText(sum.oldestAt)) : '';
    setHtml('fb-queue-list', (old ? '<div class="tiny-note" style="padding:4px 0 8px">' + old + '</div>' : '') + html);
  }

  function keyCountText(byKey) {
    if (!byKey || !Object.keys(byKey).length) { return '없음'; }
    var label = {};
    (S.plan ? S.plan.keys : []).forEach(function (k) { label[k.name] = k.label; });
    return Object.keys(byKey).sort().map(function (name) {
      return (label[name] || name) + ' ' + numText(byKey[name]) + '건';
    }).join(' · ');
  }

  function renderMigration() {
    var wrap = $('fb-mig-wrap');
    if (!S.plan) { if (wrap) { wrap.style.display = 'none'; } return; }
    if (wrap) { wrap.style.display = ''; }
    var rows = S.plan.keys.map(function (k) {
      var isLocal = k.localOnly;
      var tag = k.derived ? ' <span class="chip wait" style="font-size:9.5px">자동 생성</span>' : '';
      return '<tr><td>' + k.icon + ' <b>' + k.label + '</b>' + tag + '<br><span class="tiny-note">' + k.key + '</span></td>' +
        '<td class="tiny-note">' + (isLocal ? '🚫 기기 로컬 전용 (보내지 않음)' : k.desc) + '</td>' +
        '<td class="num"><b>' + (isLocal ? '—' : numText(k.count)) + '</b>' + (isLocal ? '' : '건') + '</td></tr>';
    }).join('');
    setHtml('fb-mig-table', rows);
    setText('fb-mig-note', '모두 ' + numText(S.plan.total) + '건 · Firestore 배치 ' + S.plan.batches + '회' +
      ' · 저장 키 ' + (S.plan.keyCount || 0) + '개' +
      (S.plan.derivedKeys ? ' + 자동 생성 사본 ' + S.plan.derivedKeys + '종 ' + numText(S.plan.derived) + '건' : '') +
      (S.plan.localOnly ? ' · 로컬 전용 ' + S.plan.localOnly + '개 키 제외' : ''));
    var run = $('fb-mig-run');
    if (run) { run.disabled = !(S.engine && S.engine.adapter && S.plan.total >= 0) || engineRole() !== 'admin' || S.busy; }
  }

  function roleLabel(r) {
    return r === 'admin' ? '관리자 PC' : (r === 'tablet' ? '출석 태블릿' : String(r || '역할 없음'));
  }

  /* ---------- 유효 권한은 서버 roles 기준 ----------
     화면에서 고른 역할(S.cfg.role)은 "어떤 계정으로 로그인할지"를 고르는 값일 뿐이고,
     실제로 무엇을 할 수 있는지는 엔진이 서버 roles/{uid} 로 잠근 effectiveRole() 이 정한다. */
  function engineRole() {
    return (S.engine && typeof S.engine.effectiveRole === 'function') ? S.engine.effectiveRole() : null;
  }
  function verifiedRole() {
    return (S.engine && typeof S.engine.verifiedRole === 'function') ? S.engine.verifiedRole() : null;
  }
  function roleLockText() {
    var er = engineRole();
    if (er === 'none') {
      return '역할 확인 전이라 동기화를 잠갔습니다 — ' + roleLabel(S.cfg.role) +
        ' 계정으로 로그인하면 서버 roles 기준으로 동기화가 시작됩니다. (로그인 전에는 서버로 아무것도 보내지 않습니다)';
    }
    if (er === 'tablet' && S.cfg.role !== 'tablet') {
      return '서버 roles 문서의 역할이 「출석 태블릿」이므로 이 기기는 태블릿 권한으로만 동작합니다 — 화면에서 「관리자 PC」를 고르거나 저장해도 관리자 권한(원생 개인정보·원비·이전)은 생기지 않습니다.';
    }
    if (er === 'tablet') {
      return '서버 역할 「출석 태블릿」으로 동작합니다 — 출결만 올리고, 원생 개인정보·원비·설정은 올리지도 읽지도 않습니다.';
    }
    return '서버 역할 「관리자 PC」로 동작합니다.';
  }

  function renderAuth() {
    var a = S.auth;
    var dev = S.cfg.role;
    var el = $('fb-auth');
    if (el) {
      el.textContent = a
        ? ('✅ 로그인: ' + (a.email || a.uid) + ' · ' + roleLabel(a.role || a.expect))
        : '로그인 안 됨';
      el.className = 'tiny-note';
    }
    var cardA = $('fb-login-card-admin');
    var cardT = $('fb-login-card-tablet');
    if (cardA) { cardA.className = 'fb-login-card' + (dev === 'admin' ? ' active' : ''); }
    if (cardT) { cardT.className = 'fb-login-card' + (dev === 'tablet' ? ' active' : ''); }
    var hint = $('fb-role-hint');
    if (hint) {
      hint.innerHTML = '이 기기의 역할은 <b>' + roleLabel(dev) + '</b> 입니다 — 아래 <b>' +
        (dev === 'tablet' ? '출석 태블릿 계정' : '관리자 PC 계정') + '</b>으로 로그인하세요.' +
        (dev === 'tablet' ? ' 태블릿에는 이름·띠·출결만 내려옵니다.' : '');
    }
    var note = $('fb-role-state');
    if (!note) { return; }
    if (!S.adapter || S.adapter.mode !== 'firestore') {
      note.textContent = '실제 Firebase 모드에서만 로그인합니다. (모의 모드는 로그인 없이 시험)';
      return;
    }
    if (!a) {
      note.textContent = '역할에 맞는 계정으로 로그인하세요 — 관리자 PC 계정과 출석 태블릿 계정은 서로 다른 계정이어야 합니다.';
      return;
    }
    if (!a.role) {
      note.textContent = '⚠️ 이 계정에는 roles 문서가 없습니다 — dojangs/' + S.cfg.dojangId + '/roles/' + a.uid +
        ' 에 role: "' + (a.expect || dev) + '" 을 만들어 주세요. (만들기 전까지는 역할 미확인 상태라 동기화를 하지 않습니다)'; return;
    }
    if (a.role !== dev) {
      note.textContent = '⚠️ 이 계정의 역할은 「' + roleLabel(a.role) + '」인데 이 기기는 「' + roleLabel(dev) + '」입니다. ' +
        '위 「이 기기 역할」을 맞추거나 ' + roleLabel(dev) + ' 계정으로 다시 로그인하세요. ' +
        (dev === 'tablet' && a.role === 'admin'
          ? '관리자 계정으로 로그인했지만 이 기기는 더 제한적인 「출석 태블릿」 권한으로 잠깁니다 — 태블릿 전용 계정을 꼭 쓰세요.'
          : '지금은 더 제한적인 「' + (engineRole() === 'admin' ? '관리자 PC' : '출석 태블릿') + '」 권한으로만 동작합니다.');
      return;
    }
    note.textContent = a.role === 'admin'
      ? '✅ 관리자 PC 계정입니다 — 서버 roles 기준으로 관리자 권한이 확인되어 모든 데이터를 읽고 쓸 수 있습니다.'
      : '✅ 출석 태블릿 계정입니다 — 출석 화면 최소 정보(kioskStudents)와 출결만 읽고, 출결 새로 만들기만 할 수 있습니다.';
  }

  function renderAll() {
    var modeSel = $('fb-mode');
    if (modeSel) { modeSel.value = S.cfg.mode; }
    var roleSel = $('fb-role');
    if (roleSel) { roleSel.value = S.cfg.role; }
    var dj = $('fb-dojang');
    if (dj && !dj.value) { dj.value = S.cfg.dojangId; }
    var emailA = $('fb-admin-email');
    if (emailA && !emailA.value && S.cfg.adminEmail) { emailA.value = S.cfg.adminEmail; }
    var emailT = $('fb-tablet-email');
    if (emailT && !emailT.value && S.cfg.tabletEmail) { emailT.value = S.cfg.tabletEmail; }
    var cfgArea = $('fb-config');
    if (cfgArea && !cfgArea.value && S.cfg.config) {
      cfgArea.value = FB.stableStringify(S.cfg.config).replace(/,"/g, ',\n  "').replace(/^\{/, '{\n  ').replace(/\}$/, '\n}');
    }
    setText('fb-msg', S.msg || '설정을 저장하고 연결하면 실시간 동기화가 시작됩니다.');
    var msgEl = $('fb-msg');
    if (msgEl) {
      msgEl.className = 'tiny-note';
      msgEl.style.color = S.msgKind === 'warn' ? '#c0392b' : (S.msgKind === 'ok' ? '#0b7a55' : '');
    }
    renderStatus();
    renderUsage();
    renderQueue();
    renderMigration();
    renderAuth();
  }

  /* ---------- 동작 ---------- */
  function readForm() {
    var raw = val('fb-config').trim();
    var parsed = null;
    if (raw) {
      try { parsed = JSON.parse(raw); } catch (e) { parsed = null; }
      if (!parsed) {
        /* 흔한 실수: const firebase_config = { ... }; 통째로 붙여넣은 경우 */
        var m = raw.match(/\{[\s\S]*\}/);
        if (m) { try { parsed = JSON.parse(m[0]); } catch (e2) { parsed = null; } }
      }
    }
    return {
      dojangId: FB.safeId(val('fb-dojang') || DEFAULT_DOJANG),
      role: val('fb-role') === 'tablet' ? 'tablet' : 'admin',
      mode: val('fb-mode'),
      config: parsed
    };
  }

  function onSave() {
    var f = readForm();
    var cfg = f.config || S.cfg.config;
    if (f.mode === 'firestore') {
      var v = FB.validateConfig(cfg || {});
      if (!v.ok) {
        S.msg = '⚠️ firebaseConfig 를 붙여넣어 주세요: ' + v.errors.join(' / ');
        S.msgKind = 'warn';
        renderAll();
        return;
      }
      cfg = v.config;
    }
    saveConfig({ dojangId: f.dojangId, role: f.role, mode: f.mode === 'firestore' || f.mode === 'mock' ? f.mode : 'off', config: cfg });
    S.msg = '설정을 이 기기에 저장했습니다.';
    S.msgKind = 'ok';
    if (S.cfg.mode === 'mock') { connectMock(); return; }
    if (S.cfg.mode === 'firestore') { connectFirestore(); return; }
    disconnect();
  }

  function onTest() {
    if (!S.engine || !S.adapter) {
      S.msg = '먼저 「설정 저장」으로 연결해 주세요.';
      S.msgKind = 'warn';
      renderAll();
      return;
    }
    if (!S.adapter.test) {
      S.msg = '연결 테스트를 지원하지 않는 모드입니다.';
      S.msgKind = 'warn';
      renderAll();
      return;
    }
    S.msg = '연결 확인 중…';
    renderAll();
    var call;
    try {
      call = S.adapter.test();
    } catch (err) {
      showError('⚠️ 연결 실패: ', err);
      return;
    }
    Promise.resolve(call).then(function (r) {
      S.msg = (r && r.ok ? '✅ ' : '⚠️ ') + ((r && r.message) || '응답이 없습니다 — 다시 시도해 주세요.');
      S.msgKind = r && r.ok ? 'ok' : 'warn';
      renderAll();
    }, function (err) {
      showError('⚠️ 연결 실패: ', err);
    });
  }

  /* 역할별 로그인 — 관리자 PC 계정과 출석 태블릿 계정을 따로 받는다 */
  function loginAs(expect) {
    if (!S.adapter || S.adapter.mode !== 'firestore' || !S.adapter.signInEmail) {
      S.msg = '실제 Firebase 모드에서만 로그인할 수 있습니다. (모의 모드는 로그인 없이 시험)';
      S.msgKind = 'warn';
      renderAll();
      return;
    }
    var emailId = expect === 'tablet' ? 'fb-tablet-email' : 'fb-admin-email';
    var pwId = expect === 'tablet' ? 'fb-tablet-pw' : 'fb-admin-pw';
    var email = val(emailId).trim();
    var pw = val(pwId);
    if (!email || !pw) {
      S.msg = '「' + roleLabel(expect) + '」 계정의 이메일과 비밀번호를 입력해 주세요.';
      S.msgKind = 'warn';
      renderAll();
      return;
    }
    S.msg = roleLabel(expect) + ' 계정으로 로그인 중…';
    renderAll();
    var signing;
    try {
      signing = S.adapter.signInEmail(email, pw);
    } catch (err) {
      showError('⚠️ 로그인 실패: ', err);
      return;
    }
    Promise.resolve(signing).then(function (u) {
      if (!u || !u.uid) {
        S.msg = '⚠️ 로그인 응답에 사용자 정보가 없습니다 — 다시 시도해 주세요.';
        S.msgKind = 'warn';
        renderAll();
        return;
      }
      var pwEl = $(pwId);
      if (pwEl) { pwEl.value = ''; }
      S.auth = { uid: u.uid, email: u.email, role: '', expect: expect };
      if (expect === 'tablet') { saveConfig({ tabletEmail: email }); } else { saveConfig({ adminEmail: email }); }
      var roleCall;
      try {
        roleCall = S.adapter.getDoc('dojangs/' + S.cfg.dojangId + '/roles/' + u.uid);
      } catch (err) {
        if (S.engine && typeof S.engine.setVerifiedRole === 'function') {
          try { S.engine.setVerifiedRole(''); } catch (e) {}
        }
        showError('⚠️ 로그인은 됐지만 역할을 확인하지 못했습니다: ', err);
        return;
      }
      return Promise.resolve(roleCall).then(function (r) {
        S.auth.role = r && r.exists && r.data ? String(r.data.role || '') : '';
        /* 서버 roles 로 유효 권한을 잠근다 — 화면 드롭다운과 달라도 서버 기준 */
        if (S.engine && typeof S.engine.setVerifiedRole === 'function') {
          try { S.engine.setVerifiedRole(S.auth.role); } catch (e) {}
        }
        if (!S.auth.role) {
          S.msg = '⚠️ 로그인은 됐지만 roles 문서가 없습니다 — dojangs/' + S.cfg.dojangId + '/roles/' + u.uid +
            ' 문서에 role: "' + expect + '" 을 만들어 주세요. (만들기 전까지는 동기화를 하지 않습니다)';
          S.msgKind = 'warn';
        } else if (S.auth.role !== expect) {
          S.msg = '⚠️ 이 계정의 역할은 「' + roleLabel(S.auth.role) + '」입니다 — 「' + roleLabel(expect) + '」 계정으로 로그인해 주세요. ' +
            '권한은 서버 역할 기준으로 잠겨 있으니, 이 계정으로는 「' + roleLabel(S.auth.role) + '」 권한까지만 동작합니다.';
          S.msgKind = 'warn';
        } else if (S.auth.role !== S.cfg.role) {
          S.msg = '✅ ' + roleLabel(expect) + ' 계정으로 로그인했습니다. 다만 이 기기의 역할 설정은 「' + roleLabel(S.cfg.role) +
            '」입니다 — 서버 역할 기준으로 더 제한적인 「' + roleLabel(S.auth.role) + '」 권한으로 동작합니다. ' +
            '위 「이 기기 역할」을 「' + roleLabel(expect) + '」로 맞춰 주세요.';
          S.msgKind = 'warn';
        } else {
          S.msg = '✅ ' + roleLabel(expect) + ' 계정으로 로그인했습니다. (서버 roles 기준으로 권한이 확인되었습니다)';
          S.msgKind = 'ok';
        }
        renderAll();
      }, function (err) {
        if (S.engine && typeof S.engine.setVerifiedRole === 'function') {
          try { S.engine.setVerifiedRole(''); } catch (e) {}
        }
        showError('⚠️ 로그인은 됐지만 역할을 확인하지 못했습니다: ', err);
      });
    }, function (err) {
      S.msg = '⚠️ 로그인 실패: ' + FB.errorText(err) +
        ' (Firebase Authentication 에서 이메일/비밀번호 로그인을 켜고 「' + roleLabel(expect) + '」 계정을 만들어 주세요)';
      S.msgKind = 'warn';
      renderAll();
    });
  }

  function logoutAs(expect) {
    if (!S.auth || (S.auth.expect && S.auth.expect !== expect)) {
      if (!S.auth) {
        S.msg = '로그인된 계정이 없습니다.';
        renderAll();
        return;
      }
    }
    if (S.adapter && typeof S.adapter.signOut === 'function') {
      try { Promise.resolve(S.adapter.signOut()).then(function () {}, function () {}); } catch (e) {}
    }
    S.auth = null;
    /* 로그아웃하면 역할 확인도 지운다 — 다시 잠금(역할 미확인) 상태로 */
    if (S.engine && typeof S.engine.setVerifiedRole === 'function') { try { S.engine.setVerifiedRole(''); } catch (e) {} }
    S.msg = '로그아웃했습니다.';
    renderAll();
  }

  function onPreview() {
    if (!S.engine) {
      S.msg = '먼저 동기화를 켜 주세요.';
      S.msgKind = 'warn';
      renderAll();
      return;
    }
    S.plan = S.engine.migrationPlan();
    setHtml('fb-mig-result', '이전 대상: ' + S.plan.keys.filter(function (k) { return !k.localOnly && k.count; })
      .map(function (k) { return k.label + ' ' + numText(k.count) + '건'; }).join(' · '));
    S.msg = '현재 기기의 데이터 ' + numText(S.plan.total) + '건을 확인했습니다. 아래 표를 보고 「이전 실행」을 눌러 주세요.';
    S.msgKind = 'ok';
    renderAll();
  }

  function onMigrate() {
    if (!S.engine || !S.plan) { return; }
    if (engineRole() !== 'admin') {
      S.msg = (engineRole() === 'tablet')
        ? '출석 태블릿 권한으로는 이전하지 않습니다 — 관리자 PC에서 해 주세요.'
        : '🔒 서버 roles 문서로 관리자 역할이 확인되지 않았습니다 — 「👨‍💼 관리자 PC 계정」으로 로그인한 뒤 다시 시도해 주세요.';
      S.msgKind = 'warn';
      renderAll();
      return;
    }
    var msg = '현재 이 기기의 데이터 ' + numText(S.plan.total) + '건을 Firestore로 보냅니다.\n\n' +
      '· 이미 Firestore에 있는 문서는 건드리지 않습니다(덮어쓰기 없음).\n' +
      '· 얼굴 특징값 2종은 이 기기에만 남습니다.\n' +
      '· 약 ' + Math.max(1, Math.ceil(S.plan.total / 400)) + '초 걸립니다.\n\n진행할까요?';
    if (typeof window.confirm === 'function' && !window.confirm(msg)) { return; }
    S.busy = true;
    S.msg = '📤 이전 중…';
    renderAll();
    S.engine.runMigration().then(function (r) {
      S.busy = false;
      if (r.ok) {
        S.msg = '✅ 이전 완료 — 새로 저장 ' + numText(r.written) + '건 · 건너뜀 ' + numText(r.skipped) + '건 · 배치 ' + r.batches + '회';
        S.msgKind = 'ok';
        setHtml('fb-mig-result', '방금 저장한 키별 건수: ' + keyCountText(r.byKey));
      } else {
        S.msg = '⚠️ 이전을 끝내지 못했습니다: ' + (r.error || r.reason || '') + ' — 다시 누르면 이어서 진행합니다.';
        S.msgKind = 'warn';
      }
      S.plan = S.engine.migrationPlan();
      renderAll();
    }, function (err) {
      S.busy = false;
      S.msg = '⚠️ 이전 실패: ' + FB.errorText(err);
      S.msgKind = 'warn';
      renderAll();
    });
  }

  function onFlush() {
    if (!S.engine) { return; }
    S.msg = '보내는 중…';
    renderAll();
    S.engine.flush().then(function (r) {
      if (r.ok) {
        S.msg = r.sent ? ('✅ ' + numText(r.sent) + '건을 보냈습니다.') : '보낼 기록이 없습니다.';
        S.msgKind = 'ok';
      } else if (r.reason === 'quota') {
        S.msg = '🔴 무료 한도 초과 — 기기에 보관 중입니다. 한도가 풀리면 자동으로 다시 보냅니다.';
        S.msgKind = 'warn';
      } else if (r.reason === 'offline') {
        S.msg = '🟡 인터넷이 없습니다 — 연결되면 자동으로 다시 보냅니다.';
        S.msgKind = 'warn';
      } else if (r.reason === 'no-adapter') {
        S.msg = '먼저 Firebase(또는 모의 모드)에 연결해 주세요.';
        S.msgKind = 'warn';
      } else {
        S.msg = '⚠️ 전송 실패: ' + (r.error || '');
        S.msgKind = 'warn';
      }
      renderAll();
    }, function (err) {
      S.msg = '⚠️ 전송 실패: ' + FB.errorText(err);
      renderAll();
    });
  }

  function onRetry() {
    if (!S.engine) { return; }
    S.engine.outbox.retryAll();
    onFlush();
  }

  function onUsageReset() {
    if (!S.engine) { return; }
    if (typeof window.confirm === 'function' && !window.confirm('오늘 사용량 카운터를 0으로 되돌립니다.\n실제 Firebase 사용량은 그대로이니 안내용으로만 쓰세요. 계속할까요?')) { return; }
    S.engine.usage.reset();
    S.msg = '사용량 카운터를 0으로 되돌렸습니다.';
    S.msgKind = 'ok';
    renderAll();
  }

  function guideUrl() {
    var host = location.hostname || '';
    var parts = String(location.pathname || '').split('/').filter(function (x) { return !!x; });
    if (/(^|\.)github\.io$/.test(host) && parts.length >= 1) {
      /* GitHub Pages 에 올라간 경우 — 브라우저에서 예쁘게 보이는 저장소 문서로 연다 */
      return 'https://github.com/' + host.split('.')[0] + '/' + parts[0] + '/blob/main/' +
        parts.slice(1).join('/') + (parts.length > 1 ? '/' : '') + 'SETUP_GUIDE.md';
    }
    return location.href.replace(/index\.html.*$/, '') + 'SETUP_GUIDE.md';
  }

  function onGuide() {
    var url = guideUrl();
    if (typeof window.open === 'function') { window.open(url, '_blank'); }
    S.msg = '설정 안내서를 새 창으로 열었습니다: ' + url;
    S.msgKind = '';
    renderAll();
  }

  /* ---------- 🧪 모의 권한 테스트 — 가짜 원생 3명 (관리자 PC ↔ 출석 태블릿) ----------
     실제 Firebase에 연결하기 전에도 두 역할이 보는 정보의 차이를 이 화면에서 바로 확인한다.
     · 가짜 원생은 이 파일 안에서만 만들고, 기기 저장소(tdk.students.v1)에는 절대 쓰지 않는다
       (같은 주소의 실제 원생 명단을 건드리지 않기 위해서).
     · 태블릿 쪽 카드는 엔진이 실제로 만들어 보내는 FB.kioskStudentBody() 결과를 그대로 쓴다
       (firestore.rules 의 kioskFields() 와 같은 칸만 남는다).
     · 태블릿 허용 경로는 규칙 isTablet 의 허용 목록과 같다:
         kioskStudents(읽기) · attendanceEvents(읽기 + 새로 만들기) · meta/kioskConfig(읽기)
       나머지 경로의 실제 거부는 서버 규칙이 하고, tests/test_rules.py 가 시나리오로 검증한다. */
  var PERM_STUDENTS = [
    { id: 'demo-minjun', name: '김민준', division: '초등부', course: '16회', belt: '파란띠', status: 'active',
      phone: '010-1111-2222', birthDate: '2016-05-12', tconId: 'tkd_demo1', note: '땅콩 알레르기 — 간식 확인',
      tuition: { month: '2026-11', amount: 180000, paid: true, method: '카드' },
      counsel: { count: 2, last: '2026-11-18 · 전화 · 승급 상담' } },
    { id: 'demo-seoyeon', name: '이서연', division: '유치부', course: '8회', belt: '노란띠', status: 'active',
      phone: '010-2222-3333', birthDate: '2020-09-18', tconId: 'tkd_demo2', note: '차량 하원 — 화·목 5시 30분',
      tuition: { month: '2026-11', amount: 160000, paid: false, method: '' },
      counsel: { count: 1, last: '2026-11-05 · 대면 · 차량 변경' } },
    { id: 'demo-jiho', name: '박지호', division: '초등부', course: '12회', belt: '빨간띠', status: 'paused',
      phone: '010-3333-4444', birthDate: '2014-02-27', tconId: 'tkd_demo3', note: '휴관 중 — 12월 복귀 예정',
      tuition: { month: '2026-11', amount: 180000, paid: true, method: '현금' },
      counsel: { count: 3, last: '2026-10-28 · 문자 · 휴관 안내' } }
  ];
  var PERM_PATHS = [
    { path: 'students', label: '원생 전체 정보 (연락처·생년월일·티콘 ID·비고)', admin: '읽기·쓰기', tablet: '' },
    { path: 'tuition', label: '원비 (금액·납부·수단)', admin: '읽기·쓰기', tablet: '' },
    { path: 'counsel', label: '상담 기록', admin: '읽기·쓰기', tablet: '' },
    { path: 'shuttle', label: '차량 운행', admin: '읽기·쓰기', tablet: '' },
    { path: 'coupons', label: '쿠폰 지급 현황', admin: '읽기·쓰기', tablet: '' },
    { path: 'meta/settings · logs · admin', label: '도장 설정·문자 로그·관리자 계정', admin: '읽기·쓰기', tablet: '' },
    { path: 'kioskStudents', label: '출석 화면용 최소 정보 (이름·부서·수업·띠·상태)', admin: '읽기·쓰기', tablet: '읽기' },
    { path: 'attendanceEvents', label: '출결 기록', admin: '읽기·쓰기', tablet: '읽기 + 새로 만들기' },
    { path: 'meta/kioskConfig', label: '출석 화면 최소 설정', admin: '읽기·쓰기', tablet: '읽기' }
  ];
  var PERM_PRIVATE = ['phone', 'birthDate', 'tconId', 'note', 'tuitionDay', 'siblingDiscount', 'monthlyFee', 'attendCount'];

  function permEsc(v) {
    return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function permSanitize() {
    return PERM_STUDENTS.map(function (s) {
      var body = (typeof FB.kioskStudentBody === 'function') ? FB.kioskStudentBody(s) : null;
      return { full: s, kiosk: body };
    });
  }
  function permLeaks(rows) {
    var n = 0;
    (rows || []).forEach(function (r) {
      if (!r || !r.kiosk) { n++; return; }
      PERM_PRIVATE.forEach(function (k) {
        var v = r.kiosk[k];
        if (v !== undefined && v !== null && String(v) !== '') { n++; }
      });
    });
    return n;
  }
  /* 지금 이 기기의 역할 — 서버 roles 로 확인된 값이 있으면 그 값, 없으면 화면 선택값 */
  function permRoleNow() {
    var er = engineRole();
    if (er === 'admin' || er === 'tablet') { return er; }
    return S.cfg.role === 'tablet' ? 'tablet' : 'admin';
  }
  function permRow(label, value, locked) {
    return '<div class="fb-perm-row"><span>' + label + '</span><b>' +
      (locked ? '🔒 ' + permEsc(value) : permEsc(value)) + '</b></div>';
  }
  function permCardsHtml(rows, current) {
    var adminCards = rows.map(function (r) {
      var s = r.full, t = s.tuition || {}, c = s.counsel || {};
      return '<div class="fb-perm-card">' +
        '<div class="fb-perm-name">' + permEsc(s.name) +
          ' <span class="tiny-note">' + permEsc(s.division) + ' · ' + permEsc(s.course) + '</span></div>' +
        permRow('띠 / 상태', s.belt + ' · ' + (s.status === 'paused' ? '휴관' : '재원')) +
        permRow('연락처', s.phone) + permRow('생년월일', s.birthDate) +
        permRow('티콘 ID', s.tconId) + permRow('비고', s.note) +
        permRow('원비', t.month + ' ' + numText(t.amount) + '원 ' + (t.paid ? '납부(' + t.method + ')' : '미납')) +
        permRow('상담', c.count + '건 · ' + c.last) +
        '</div>';
    }).join('');
    var tabletCards = rows.map(function (r) {
      var s = r.full, k = r.kiosk || {};
      return '<div class="fb-perm-card deny">' +
        '<div class="fb-perm-name">' + permEsc(k.name || s.name) +
          ' <span class="tiny-note">' + permEsc(k.division) + ' · ' + permEsc(k.course) + '</span></div>' +
        permRow('띠 / 상태', (k.belt || '') + ' · ' + (k.status === 'paused' ? '휴관' : '재원')) +
        permRow('연락처', '받지 않음', true) + permRow('생년월일', '받지 않음', true) +
        permRow('티콘 ID', '받지 않음', true) + permRow('비고', '받지 않음', true) +
        permRow('원비', '차단 (tuition)', true) + permRow('상담', '차단 (counsel)', true) +
        '</div>';
    }).join('');
    return '<div class="fb-perm-col' + (current === 'admin' ? ' here' : '') + '">' +
        '<div class="fb-perm-col-head">👨‍💼 관리자 PC · students <span class="chip ok">전체 정보</span>' +
          (current === 'admin' ? ' <span class="chip wait">이 기기</span>' : '') + '</div>' + adminCards + '</div>' +
      '<div class="fb-perm-col' + (current === 'tablet' ? ' here' : '') + '">' +
        '<div class="fb-perm-col-head">📱 출석 태블릿 · kioskStudents <span class="chip wait">최소 정보</span>' +
          (current === 'tablet' ? ' <span class="chip wait">이 기기</span>' : '') + '</div>' + tabletCards + '</div>';
  }
  function permTableHtml() {
    return PERM_PATHS.map(function (p) {
      var tablet = p.tablet
        ? '<span class="chip ok">✅ ' + p.tablet + '</span>'
        : '<span class="chip off">❌ 차단</span>';
      return '<tr><td><b>' + permEsc(p.path) + '</b><br><span class="tiny-note">' + permEsc(p.label) + '</span></td>' +
        '<td><span class="chip ok">✅ ' + p.admin + '</span></td><td>' + tablet + '</td></tr>';
    }).join('');
  }
  /* 버튼을 누를 때 실행 — 결과를 1줄로 돌려준다(테스트에서도 그대로 확인) */
  function runPermDemo() {
    var current = permRoleNow();
    var rows = permSanitize();
    var leak = permLeaks(rows);
    var blocked = PERM_PATHS.filter(function (p) { return !p.tablet; }).length;
    setHtml('fb-perm-cards', permCardsHtml(rows, current));
    setHtml('fb-perm-table', permTableHtml());
    setText('fb-perm-th-admin', '관리자 PC' + (current === 'admin' ? ' (이 기기)' : ''));
    setText('fb-perm-th-tablet', '출석 태블릿' + (current === 'tablet' ? ' (이 기기)' : ''));
    show('fb-perm-wrap', true);
    var tag = $('fb-perm-tag');
    if (tag) {
      tag.textContent = current === 'admin' ? '관리자 PC 시점' : '출석 태블릿 시점';
      tag.className = 'chip ' + (current === 'admin' ? 'ok' : 'wait');
    }
    var line = '🧪 테스트 결과 — 관리자 PC: students ' + rows.length + '명 전체(연락처·생년월일·비고·원비·상담) 읽기·쓰기 가능 · ' +
      '출석 태블릿: kioskStudents ' + rows.length + '명 최소 정보만 수신(개인정보 ' + leak + '칸) · ' +
      'students·tuition·counsel 등 ' + blocked + '경로 차단' + (leak ? ' ⚠️ 개인정보가 샜습니다!' : '');
    var el = $('fb-perm-result');
    if (el) {
      el.textContent = line + ' — 이 기기 역할 「' + (current === 'admin' ? '관리자 PC' : '출석 태블릿') + '」 시점으로 표시했습니다.';
      el.style.color = leak ? '#c0392b' : '#0b7a55';
      el.style.fontWeight = '800';
    }
    return { role: current, students: rows.length, leak: leak, blocked: blocked, line: line };
  }

  /* ---------- 화면 아래 작은 상태 알약 ---------- */
  function ensurePill() {
    if ($('fb-pill')) { return; }
    var d = document.createElement('div');
    d.id = 'fb-pill';
    d.className = 'fb-pill';
    d.innerHTML = '<span class="fb-pill-tag" id="fb-pill-tag">🧪 Firebase 테스트 v5</span><span class="fb-pill-state" id="fb-pill-state">⚪ 미연결(로컬 모드)</span>';
    document.body.appendChild(d);
  }

  /* ---------- 이벤트 연결 ---------- */
  function bind() {
    var map = [
      ['fb-save', onSave], ['fb-test', onTest], ['fb-mock', connectMock],
      ['fb-admin-login', function () { loginAs('admin'); }],
      ['fb-tablet-login', function () { loginAs('tablet'); }],
      ['fb-admin-logout', function () { logoutAs('admin'); }],
      ['fb-tablet-logout', function () { logoutAs('tablet'); }],
      ['fb-mig-preview', onPreview], ['fb-mig-run', onMigrate],
      ['fb-flush', onFlush], ['fb-retry', onRetry], ['fb-usage-reset', onUsageReset],
      ['fb-perm-run', runPermDemo],
      ['fb-guide', onGuide]
    ];
    map.forEach(function (pair) {
      var el = $(pair[0]);
      if (el) { el.addEventListener('click', pair[1]); }
    });
    var toggle = $('fb-queue-toggle');
    if (toggle) {
      toggle.addEventListener('click', function () {
        S.queueOpen = !S.queueOpen;
        show('fb-queue-list', S.queueOpen);
        toggle.textContent = S.queueOpen ? '대기 목록 닫기' : '대기 목록 보기';
        renderQueue();
      });
    }
    var modeSel = $('fb-mode');
    if (modeSel) {
      modeSel.addEventListener('change', function () {
        if (modeSel.value === 'off') { disconnect(); }
        else if (modeSel.value === 'mock') { connectMock(); }
        else { S.msg = 'firebaseConfig 를 붙여넣고 「설정 저장」을 눌러 주세요.'; S.msgKind = ''; S.cfg.mode = 'firestore'; renderAll(); }
      });
    }
  }

  /* ---------- 시작 ---------- */
  function boot() {
    if (!$('admin-fb-panel')) { return; }
    S.cfg = loadConfig();
    deviceId();
    ensurePill();
    bind();
    /* 저장해 둔 훅이 없으면 앱이 준비될 때까지 잠깐 기다린다 */
    var tries = 0;
    (function ready() {
      tries++;
      var ok = window.__tdk && window.__tdk.app;
      if (!ok && tries < 60) { setTimeout(ready, 150); return; }
      if (S.cfg.mode === 'mock') { connectMock(); }
      else if (S.cfg.mode === 'firestore') { connectFirestore(); }
      else { renderAll(); }
      if (S.timer) { clearInterval(S.timer); }
      S.timer = setInterval(function () { renderStatus(); renderUsage(); renderQueue(); }, 2000);
    })();
  }

  window.TDKFB = {
    /* 이 기기의 역할 — 화면에서 고른 값이 아니라 서버 roles 로 확인된 유효 권한.
       역할을 아직 확인하지 못한 상태에서는 화면 선택값으로 되돌아간다
       (권한은 엔진·규칙이 잠그므로 안전하고, 문자 발송 같은 기기 안쪽 동작은 예전처럼 유지). */
    deviceRole: function () {
      var er = engineRole();
      if (er === 'admin' || er === 'tablet') { return er; }
      return S.cfg.role === 'tablet' ? 'tablet' : 'admin';
    },
    requestedRole: function () { return S.cfg.role; },
    effectiveRole: engineRole,
    verifiedRole: verifiedRole,
    roleLabel: function (r) { return roleLabel(r); },
    loginAs: loginAs,
    auth: function () { return S.auth ? { uid: S.auth.uid, email: S.auth.email, role: S.auth.role } : null; },
    relayLog: function () { return relayLog(); },
    engine: function () { return S.engine; },
    adapter: function () { return S.adapter; },
    server: function () { return S.server; },
    config: function () { return S.cfg; },
    connectMock: connectMock,
    connectFirestore: connectFirestore,
    disconnect: disconnect,
    permDemo: runPermDemo,
    permData: function () {
      return { students: PERM_STUDENTS, paths: PERM_PATHS, sanitize: permSanitize, leaks: permLeaks, role: permRoleNow };
    },
    flush: function () { return S.engine ? S.engine.flush() : null; },
    preview: onPreview,
    plan: function () { return S.plan; },
    render: renderAll,
    onAdminTab: function (tab) {
      if (tab === 'settings') { renderAll(); }
    },
    state: S
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(boot, 400); });
  } else {
    setTimeout(boot, 400);
  }
})();
