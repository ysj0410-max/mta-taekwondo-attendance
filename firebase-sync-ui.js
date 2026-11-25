/* =============================================================================
   경희대MTA태권도 — 🔥 Firebase 실시간 동기화 설정 패널
   -----------------------------------------------------------------------------
   · 「🔐 관리자 계정」 탭 안에 「🔥 Firebase 실시간 동기화」 패널을 살립니다.
   · firebaseConfig 는 코드에 넣지 않고, 이 화면에서 붙여넣어 기기(localStorage)에
     저장합니다. (tdk.fbConfig.v1 — 다른 기기로 자동 전송되지 않습니다)
   · v43 — 관리자 계정 단일 구조: 모든 기기(PC·태블릿·폰)가 같은 관리자 계정으로
     로그인해 하나의 Firestore 를 함께 씁니다. 태블릿 전용 계정·역할 선택은 없습니다.
   · 모의 모드(🧪)에서는 실제 Firebase 없이 전 기능을 그대로 연습할 수 있습니다.
     같은 브라우저에서 탭을 두 개 열면 두 기기처럼 서로 동기화됩니다.
   ============================================================================= */
(function () {
  'use strict';

  var FB = window.TDKFirebaseSync;
  if (!FB) { return; }

  var CFG_KEY = 'tdk.fbConfig.v1';
  var DEV_KEY = 'tdk.fbDevice.v1';
  var DEFAULT_DOJANG = 'mta-tkd';

  var S = {
    engine: null,
    server: null,
    adapter: null,
    cfg: { mode: 'off', dojangId: DEFAULT_DOJANG, config: null },
    plan: null,
    queueOpen: false,
    auth: null,
    busy: false,
    connecting: null,
    migrating: null,
    authUnsub: null,
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
      return { mode: 'off', dojangId: DEFAULT_DOJANG, config: null };
    }
    /* v43 — 예전 설정에 남아 있는 role('tablet')은 다음 저장 때 자연히 사라진다 */
    return {
      mode: raw.mode === 'mock' || raw.mode === 'firestore' ? raw.mode : 'off',
      dojangId: FB.safeId(raw.dojangId || DEFAULT_DOJANG),
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
    if (S.authUnsub) { try { S.authUnsub(); } catch (e) {} S.authUnsub = null; }
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
      deviceLabel: '관리자 기기 ' + deviceId(),
      dojangId: S.cfg.dojangId,
      /* 실제 Firebase 모드에서는 서버 roles/{uid} 가 'admin' 일 때만 동기화한다 */
      requireServerRole: S.cfg.mode === 'firestore',
      reload: function () {
        try {
          /* v46 — 원격 변경(다른 기기 출결 등)은 화면에 보이는 부분만 다시 그린다 */
          var sync = window.__tdk && window.__tdk.sync;
          if (!sync) { return; }
          if (typeof sync.refresh === 'function') { sync.refresh(); }
          else if (typeof sync.reload === 'function') { sync.reload(); }
        } catch (e) {}
      },
      onEvent: function (type, payload) {
        if (type === 'quota-blocked') { showWarn(true); }
        if (type === 'storage-full') {
          S.msg = '⚠️ 이 기기의 브라우저 저장 공간(localStorage)이 가득 찼습니다 — 동기화 그림자는 IndexedDB로 옮겨 두었지만, 남은 공간이 부족하면 새 기록이 기기에 남지 않습니다. 「💾 도장 데이터 전체 백업」을 받아 두고 사이트 데이터를 정리해 주세요.';
          S.msgKind = 'warn';
        }
        if (type === 'synced') { saveConfig({ lastSyncAt: payload && payload.at }); }
        if (type === 'full-sync') {
          S.msg = '🔄 전체 다시 불러오기를 시작했습니다 — 서버에서 전체를 다시 받는 중입니다.';
          S.msgKind = 'ok';
        }
        if (type === 'blocked-local') {
          S.msg = '🔒 서버에서 이 계정의 관리자 역할(roles 문서)을 확인하기 전에는 아무것도 올리지 않습니다 — 관리자 계정으로 로그인해 주세요.';
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
    S.msg = '🧪 모의 Firestore 로 켰습니다 · 같은 브라우저에서 이 주소를 탭으로 하나 더 열면 두 기기처럼 동기화됩니다. (연습 모드는 로그인 없이 동작합니다)';
    S.msgKind = 'ok';
    renderAll();
  }

  /* 서버 roles/{uid} 확인 결과를 화면 문구로 — 연결 직후와 늦은 세션 복원이 같은 말을 하도록 */
  function roleVerifiedMsg(r) {
    if (r && r.verified === 'admin') {
      return '✅ 관리자 계정(' + (r.email || r.uid) + ')으로 확인되었습니다 — 데이터 이전을 진행할 수 있습니다.';
    }
    if (r && r.uid) {
      return '🔒 이 계정은 관리자가 아닙니다 — 아래 관리자 계정으로 로그인해 주세요. (관리자로 확인되기 전에는 서버로 아무것도 보내지 않습니다)';
    }
    return '🔒 아직 로그인하지 않았습니다 — 아래 관리자 계정으로 로그인해 주세요. (로그인 전에는 서버로 아무것도 보내지 않습니다)';
  }

  /* connect() 가 기다린 4초 안에는 세션이 복원되지 않았는데 그 뒤에 복원되는 경우까지 따라간다.
     Firebase 의 onAuthStateChanged 로 uid 가 생기면 roles/{uid} 를 다시 읽어 자동으로 🟢 연결됨 까지 간다. */
  function watchAuthRestore(adapter, engine) {
    if (!adapter || typeof adapter.onAuthChange !== 'function') { return; }
    if (S.authUnsub) { try { S.authUnsub(); } catch (e) {} S.authUnsub = null; }
    try {
      S.authUnsub = adapter.onAuthChange(function (user) {
        if (S.engine !== engine) { return; }
        var uid = (user && user.uid) ? String(user.uid) : '';
        if (!uid) { return; }
        /* 이미 누군가 로그인한 상태(로그인 흐름 포함)에서는 그쪽이 처리한다 —
           여기서는 「S.auth 가 비어 있는데 세션이 생겼을 때」만 따라간다 */
        if (S.auth && S.auth.uid) { return; }
        S.auth = { uid: uid, email: (user && user.email) || '', role: '' };
        S.msg = '🔎 로그인 세션이 복원되었습니다 — 이 계정(' + ((user && user.email) || uid) + ')의 역할을 서버에서 확인하는 중…';
        S.msgKind = '';
        renderAll();
        var verifying;
        try { verifying = engine.verifyRole(); } catch (err) { return; }
        Promise.resolve(verifying).then(function (r) {
          if (S.engine !== engine) { return; }
          if (r && r.uid) {
            S.auth = { uid: r.uid, email: r.email || '', role: r.verified || '' };
          }
          S.msg = roleVerifiedMsg(r);
          S.msgKind = (r && r.verified === 'admin') ? 'ok' : 'warn';
          renderAll();
        }, function (err) {
          if (S.engine !== engine) { return; }
          showError('⚠️ 역할 확인에 실패했습니다: ', err);
        });
      });
    } catch (e) { S.authUnsub = null; }
  }

  /* 실시간 구독 옵션 — 증분(델타) 구독에 쓰는 마지막 동기화 시각을 이 기기 저장소에 둔다.
     기기에 그 컬렉션 자료가 아직 없거나(새 기기·초기화) 키가 없으면 어댑터가 전체 구독으로 돌아간다. */
  function adapterOpts(extra) {
    return Object.assign({
      lastSyncStorage: localStorage,
      hasLocalData: function (coll) { return FB.localDataHas(localStorage, coll); }
    }, extra || {});
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
      connecting = FB.createFirestoreAdapter(Object.assign({ dojangId: S.cfg.dojangId }, v.config), adapterOpts({
        basePath: 'dojangs/' + S.cfg.dojangId,
        /* 역할을 서버에서 확인하기 전에는 어댑터도 태블릿(최소) 구독으로 시작한다 */
        onError: function (err) {
          S.msg = '⚠️ 실시간 구독 오류: ' + FB.errorText(err);
          S.msgKind = 'warn';
          renderAll();
        }
      }));
    } catch (err) {
      showError('⚠️ 연결하지 못했습니다: ', err);
      return Promise.resolve(false);
    }
    var result = connecting.then(function (adapter) {
      try {
        S.adapter = adapter;
        var engine = makeEngine(adapter);
        saveConfig({ mode: 'firestore', config: v.config });
        S.msg = '🔥 Firebase 에 연결했습니다. 관리자 계정으로 로그인하면 서버 roles 기준으로 동기화가 시작됩니다.';
        S.msgKind = 'ok';
        /* 이전에 로그인한 세션이 남아 있으면 바로 역할을 확인해 연결 상태를 갱신한다 */
        var cu = null;
        try { cu = (typeof adapter.currentUser === 'function') ? adapter.currentUser() : null; } catch (e) { cu = null; }
        if (cu && cu.uid) {
          S.auth = { uid: cu.uid, email: cu.email || '', role: '' };
          S.msg = '🔎 이전에 로그인한 계정(' + (cu.email || cu.uid) + ')의 역할을 서버에서 확인하는 중…';
          S.msgKind = '';
        }
        renderAll();
        var verifying;
        try { verifying = engine.verifyRole(); } catch (err) { verifying = Promise.reject(err); }
        return Promise.resolve(verifying).then(function (r) {
          try {
            if (r && r.uid) {
              S.auth = { uid: r.uid, email: r.email || '', role: r.verified || '' };
            }
            S.msg = roleVerifiedMsg(r);
            S.msgKind = (r && r.verified === 'admin') ? 'ok' : 'warn';
            renderAll();
          } catch (err) {
            showError('⚠️ 연결 상태를 화면에 표시하지 못했습니다: ', err);
          }
          /* 여기까지 와도 세션이 늦게 복원될 수 있으니 계속 지켜본다 */
          try { watchAuthRestore(adapter, engine); } catch (e) {}
          return true;
        }, function (err) {
          showError('⚠️ 역할 확인에 실패했습니다: ', err);
          try { watchAuthRestore(adapter, engine); } catch (e) {}
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
    /* 헤더 도구 영역의 연결 배지 — 누르면 동기화 상태 창이 열린다 */
    var hdr = $('hdr-fb-chip');
    if (hdr) {
      var hdrText = st.state === 'online' ? '🟢 연결'
        : st.state === 'offline' ? ('🟡 대기' + (st.queued ? ' ' + st.queued : ''))
        : st.state === 'blocked' ? '🔴 한도'
        : st.state === 'error' ? '🟠 연결문제' : '⚪ 로컬';
      hdr.textContent = hdrText;
      hdr.className = 'hdr-fb-chip ' + st.state;
      hdr.title = (st.text || '') + (st.queued ? (' · 전송 대기 ' + st.queued + '건') : '') + ' — 눌러서 동기화 상태 보기';
    }
    if (SYNC_MODAL.open) { renderSyncModal(); }
    var tag = $('fb-pill-tag');
    if (tag) { tag.style.display = 'none'; }
    var usageDate = S.engine ? String(S.engine.usage.snapshot().date || '').replace(/^pt:/, '') : '';
    setText('fb-usage-note', S.engine
      ? (usageDate + ' 기준(미국 태평양 자정 = 한국 오후 4~5시 초기화) · 이 기기 추정치 + 다른 기기 합산')
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
      '지금 찍은 기록은 <b>이 기기 로컬에 임시 보관</b> 중이며, 한도가 풀리면(미국 태평양 자정 = 한국 오후 4~5시) 자동으로 다시 보냅니다. ' +
      '유료 결제로 자동 전환되지 않습니다.<br>' +
      '그동안 <b>Google Drive 백업</b>(「💾 도장 데이터 전체 백업」 또는 「☁️ 드라이브 자동 백업」)을 받아 두시길 권합니다.';
  }

  function renderUsage() {
    var snap = S.engine ? S.engine.usage.snapshot() : {
      reads: 0, writes: 0, deletes: 0,
      limits: { reads: FB.SPARK.reads, writes: FB.SPARK.writes, deletes: FB.SPARK.deletes },
      pct: { reads: 0, writes: 0, deletes: 0 }, level: 0,
      mine: { reads: 0, writes: 0, deletes: 0 },
      total: { reads: 0, writes: 0, deletes: 0 },
      totalPct: { reads: 0, writes: 0, deletes: 0 },
      deviceCount: 1, syncAllowed: false
    };
    /* 바에는 전체 기기 합산을, 아래 작은 줄에 이 기기 값과 합산 기기 수를 함께 보여 준다 */
    var total = snap.total || { reads: snap.reads, writes: snap.writes, deletes: snap.deletes };
    var totalPct = snap.totalPct || snap.pct || {};
    [['reads', 'read', '읽기'], ['writes', 'write', '쓰기'], ['deletes', 'del', '삭제']].forEach(function (row) {
      var k = row[0], barId = 'fb-bar-' + row[1], txtId = 'fb-use-' + row[1];
      var pct = Math.min(1, totalPct[k] || 0);
      var bar = $(barId);
      if (bar) {
        bar.style.width = Math.round(pct * 100) + '%';
        bar.className = pct >= 1 ? 'danger' : (pct >= FB.SPARK.warnRatio ? 'warn' : '');
      }
      setText(txtId, numText(total[k]) + ' / ' + numText(snap.limits[k]) + '  (' + Math.floor((totalPct[k] || 0) * 100) + '%)');
    });
    var mine = snap.mine || { reads: snap.reads, writes: snap.writes, deletes: snap.deletes };
    var devCount = Number(snap.deviceCount) || 1;
    var line = '이 기기: 읽기 ' + numText(mine.reads) + ' · 쓰기 ' + numText(mine.writes) + ' · 삭제 ' + numText(mine.deletes);
    if (!S.engine) {
      line += ' · 동기화를 켜면 기기별 합산이 표시됩니다';
    } else if (snap.syncAllowed === false) {
      line += ' · 다른 기기 합산은 관리자 PC에 표시됩니다';
    } else {
      line += ' · 합산 기기 ' + devCount + '대';
    }
    var devLine = $('fb-usage-devices');
    if (devLine) {
      devLine.textContent = line;
      var rows = (snap.devices || []).map(function (d) {
        return (d.label || d.deviceId) + ' — 읽기 ' + numText(d.reads) + ' · 쓰기 ' + numText(d.writes) +
          ' · 삭제 ' + numText(d.deletes) + (d.blocked ? ' (한도 초과)' : '');
      });
      devLine.title = rows.length ? ('기기별 사용량\n' + rows.join('\n')) : '';
    }
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
    /* 「🗑️ 실패 비우기」 — 실패 건이 없으면 누를 수 없게 */
    var clearBtn = $('fb-clear-failed');
    if (clearBtn) {
      clearBtn.disabled = !(S.engine && sum.failed);
      clearBtn.textContent = sum.failed ? ('🗑️ 실패 비우기 (' + numText(sum.failed) + ')') : '🗑️ 실패 비우기';
      clearBtn.title = sum.failed
        ? '서버 규칙 거부 등으로 실패한 ' + numText(sum.failed) + '건만 목록에서 비웁니다 (대기 중인 출결은 그대로)'
        : '비울 실패 항목이 없습니다';
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
    return r === 'admin' ? '관리자' : String(r || '역할 없음');
  }

  /* ---------- 유효 권한은 서버 roles 기준 (관리자 단일) ----------
     모든 기기가 같은 관리자 계정으로 로그인하고, 실제로 무엇을 할 수 있는지는
     엔진이 서버 roles/{uid} 로 잠근 effectiveRole() 이 정한다 ('admin' 아니면 'none'). */
  function engineRole() {
    return (S.engine && typeof S.engine.effectiveRole === 'function') ? S.engine.effectiveRole() : null;
  }
  function verifiedRole() {
    return (S.engine && typeof S.engine.verifiedRole === 'function') ? S.engine.verifiedRole() : null;
  }
  function roleLockText() {
    var er = engineRole();
    if (er === 'none') {
      return '관리자 계정으로 로그인하면 서버 roles 기준으로 동기화가 시작됩니다. (관리자로 확인되기 전에는 서버로 아무것도 보내지 않습니다)';
    }
    return '서버 roles 문서의 「관리자」 권한으로 동작합니다.';
  }

  function renderAuth() {
    var a = S.auth;
    var el = $('fb-auth');
    if (el) {
      el.textContent = a
        ? ('✅ 로그인: ' + (a.email || a.uid) + (a.role === 'admin' ? ' · 관리자 확인됨' : ' · 관리자 아님'))
        : '로그인 안 됨';
      el.className = 'tiny-note';
    }
    var cardA = $('fb-login-card-admin');
    if (cardA) { cardA.className = 'fb-login-card active'; }
    var hint = $('fb-role-hint');
    if (hint) {
      hint.innerHTML = '모든 기기가 <b>같은 관리자 계정</b>으로 로그인합니다 — 아래 <b>관리자 계정</b>으로 로그인하세요.';
    }
    var note = $('fb-role-state');
    if (!note) { return; }
    if (!S.adapter || S.adapter.mode !== 'firestore') {
      note.textContent = '실제 Firebase 모드에서만 로그인합니다. (모의 모드는 로그인 없이 시험)';
      return;
    }
    if (!a) {
      note.textContent = 'Firebase 콘솔 → Authentication 에서 만든 관리자 계정으로 로그인하세요 — PC·태블릿·폰이 모두 같은 계정을 씁니다.';
      return;
    }
    if (!a.role) {
      note.textContent = '⚠️ 이 계정에는 roles 문서가 없거나 관리자가 아닙니다 — dojangs/' + S.cfg.dojangId + '/roles/' + a.uid +
        ' 문서의 role 을 "admin" 으로 맞춰 주세요. (맞추기 전까지는 역할 미확인 상태라 동기화를 하지 않습니다)'; return;
    }
    note.textContent = a.role === 'admin'
      ? '✅ 관리자 계정입니다 — 서버 roles 기준으로 관리자 권한이 확인되어 모든 데이터를 읽고 쓸 수 있습니다.'
      : '⚠️ 이 계정의 역할은 「' + roleLabel(a.role) + '」입니다 — 관리자 계정으로 다시 로그인해 주세요.';
  }

  function renderAll() {
    var modeSel = $('fb-mode');
    if (modeSel) { modeSel.value = S.cfg.mode; }
    var dj = $('fb-dojang');
    if (dj && !dj.value) { dj.value = S.cfg.dojangId; }
    var emailA = $('fb-admin-email');
    if (emailA && !emailA.value && S.cfg.adminEmail) { emailA.value = S.cfg.adminEmail; }
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
    saveConfig({ dojangId: f.dojangId, mode: f.mode === 'firestore' || f.mode === 'mock' ? f.mode : 'off', config: cfg });
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

  /* 관리자 로그인 — PC·태블릿·폰이 모두 같은 관리자 계정 하나를 쓴다 (v43) */
  function loginAs() {
    if (!S.adapter || S.adapter.mode !== 'firestore' || !S.adapter.signInEmail) {
      S.msg = '실제 Firebase 모드에서만 로그인할 수 있습니다. (모의 모드는 로그인 없이 시험)';
      S.msgKind = 'warn';
      renderAll();
      return;
    }
    var email = val('fb-admin-email').trim();
    var pw = val('fb-admin-pw');
    if (!email || !pw) {
      S.msg = '관리자 계정의 이메일과 비밀번호를 입력해 주세요.';
      S.msgKind = 'warn';
      renderAll();
      return;
    }
    S.msg = '관리자 계정으로 로그인 중…';
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
      var pwEl = $('fb-admin-pw');
      if (pwEl) { pwEl.value = ''; }
      S.auth = { uid: u.uid, email: u.email, role: '' };
      saveConfig({ adminEmail: email });
      var roleCall;
      try {
        roleCall = S.adapter.getDoc('dojangs/' + S.cfg.dojangId + '/roles/' + u.uid);
      } catch (err) {
        if (S.engine && typeof S.engine.setVerifiedRole === 'function') {
          try { S.engine.setVerifiedRole(''); } catch (e) {}
        }
        showError('⚠️ 로그인은 됐지만 관리자 역할을 확인하지 못했습니다: ', err);
        return;
      }
      return Promise.resolve(roleCall).then(function (r) {
        S.auth.role = r && r.exists && r.data ? String(r.data.role || '') : '';
        /* 서버 roles 로 유효 권한을 잠근다 */
        if (S.engine && typeof S.engine.setVerifiedRole === 'function') {
          try { S.engine.setVerifiedRole(S.auth.role); } catch (e) {}
        }
        if (!S.auth.role) {
          S.msg = '⚠️ 로그인은 됐지만 roles 문서가 없습니다 — dojangs/' + S.cfg.dojangId + '/roles/' + u.uid +
            ' 문서에 role: "admin" 을 만들어 주세요. (만들기 전까지는 동기화를 하지 않습니다)';
          S.msgKind = 'warn';
        } else if (S.auth.role !== 'admin') {
          S.msg = '⚠️ 이 계정의 역할은 「' + roleLabel(S.auth.role) + '」이라 관리자가 아닙니다 — roles 문서의 role 을 "admin" 으로 맞추거나 관리자 계정으로 다시 로그인해 주세요.';
          S.msgKind = 'warn';
        } else {
          S.msg = '✅ 관리자 계정으로 로그인했습니다. (서버 roles 기준으로 관리자 권한이 확인되었습니다)';
          S.msgKind = 'ok';
        }
        renderAll();
      }, function (err) {
        if (S.engine && typeof S.engine.setVerifiedRole === 'function') {
          try { S.engine.setVerifiedRole(''); } catch (e) {}
        }
        showError('⚠️ 로그인은 됐지만 관리자 역할을 확인하지 못했습니다: ', err);
      });
    }, function (err) {
      S.msg = '⚠️ 로그인 실패: ' + FB.errorText(err) +
        ' (Firebase Authentication 에서 이메일/비밀번호 로그인을 켜고 관리자 계정을 만들어 주세요)';
      S.msgKind = 'warn';
      renderAll();
    });
  }

  function logoutAs() {
    if (!S.adapter || S.adapter.mode !== 'firestore') {
      S.msg = '로그인된 계정이 없습니다.';
      renderAll();
      return;
    }
    if (S.adapter && typeof S.adapter.signOut === 'function') {
      try { Promise.resolve(S.adapter.signOut()).then(function () {}, function () {}); } catch (e) {}
    }
    S.auth = null;
    /* 로그아웃하면 관리자 확인도 지운다 — 다시 잠금(역할 미확인) 상태로 */
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
      S.msg = '🔒 서버 roles 문서로 관리자 역할이 확인되지 않았습니다 — 「👨‍💼 관리자 계정」으로 로그인한 뒤 다시 시도해 주세요.';
      S.msgKind = 'warn';
      renderAll();
      return;
    }
    var msg = '현재 이 기기의 데이터 ' + numText(S.plan.total) + '건을 Firestore로 보냅니다.\n\n' +
      '· 이미 Firestore에 있는 문서는 건드리지 않습니다(덮어쓰기 없음).\n' +
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

  /* ---------- 🗑️ 실패 항목 비우기 (v32) ----------
     ・서버 규칙 거부 등으로 영구 실패한 항목만 목록에서 지운다 — 대기 중인 출결은 건드리지 않는다.
     ・지운 뒤 배지(🟡 오프라인 대기)가 바로 🟢 연결로 돌아오는지는 엔진이 상태를 다시 계산한다. */
  function failedCount() {
    return S.engine ? (S.engine.outbox.summary().failed || 0) : 0;
  }
  function onClearFailed() {
    if (!S.engine) { return; }
    var n = failedCount();
    if (!n) {
      S.msg = '비울 실패 항목이 없습니다.';
      S.msgKind = '';
      renderAll();
      return;
    }
    var ask = '서버 규칙 거부 등으로 실패한 ' + numText(n) + '건만 목록에서 비웁니다. 대기 중인 출결은 건드리지 않습니다.';
    if (typeof window.confirm === 'function' && !window.confirm(ask)) {
      S.msg = '실패 항목 비우기를 취소했습니다 — 아무것도 지우지 않았습니다.';
      S.msgKind = '';
      renderAll();
      return;
    }
    var r = null;
    try {
      r = (typeof S.engine.clearFailed === 'function')
        ? S.engine.clearFailed('all')
        : { ok: true, removed: S.engine.outbox.dropWhere('failed'), failed: failedCount(), queued: S.engine.outbox.count() };
    } catch (e) { r = null; }
    if (!r) {
      S.msg = '⚠️ 실패 항목을 비우지 못했습니다.';
      S.msgKind = 'warn';
      renderAll();
      return;
    }
    S.msg = '🗑️ 실패 항목 ' + numText(r.removed) + '건을 비웠습니다.' +
      (r.failed ? (' 남은 실패 ' + numText(r.failed) + '건은 「실패 재시도」로 다시 보내 보세요.') : '') +
      (r.queued ? (' 대기 중인 기록 ' + numText(r.queued) + '건은 그대로입니다.') : '');
    S.msgKind = 'ok';
    renderAll();
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

  /* ---------- 화면 아래 작은 상태 알약 ---------- */
  /* ---------- 🔑 Firebase 관리자 계정 확인 (앱 잠금 초기화용) ----------
     앱의 관리자 비밀번호를 잊었을 때 로그인 모달에서 Firebase 관리자 계정으로
     본인 확인만 하는 통로. 서버 roles/{uid} 가 'admin' 인 경우에만 통과한다.
     · 화면에서 고른 역할이 아니라 서버 문서를 본다 (태블릿·권한 없는 계정은 거부)
     · 아직 연결하지 않은 기기라도 설정만 저장돼 있으면 확인용으로 잠깐 연결한다
       (이때는 동기화 엔진을 켜지 않아 기기에 있는 자료를 건드리지 않는다) */
  function verifyAdminCredentials(email, pw) {
    email = String(email || '').trim();
    pw = String(pw || '');
    if (!email || !pw) { return Promise.resolve({ ok: false, reason: 'empty' }); }
    var cfg = loadConfig();
    if (!cfg.config || typeof cfg.config !== 'object') { return Promise.resolve({ ok: false, reason: 'no-config' }); }
    var v = FB.validateConfig(cfg.config);
    if (!v.ok) { return Promise.resolve({ ok: false, reason: 'bad-config', detail: v.errors.join(' / ') }); }
    var base = 'dojangs/' + cfg.dojangId;
    var live = (S.adapter && S.adapter.mode === 'firestore' && typeof S.adapter.signInEmail === 'function') ? S.adapter : null;
    var getting;
    if (live) {
      getting = Promise.resolve(live);
    } else {
      try {
        getting = FB.createFirestoreAdapter(Object.assign({ dojangId: cfg.dojangId }, v.config), adapterOpts({ basePath: base }));
      } catch (err) {
        return Promise.resolve({ ok: false, reason: 'connect-failed', detail: FB.errorText(err) });
      }
    }
    return Promise.resolve(getting).then(function (adapter) {
      return Promise.resolve(adapter.signInEmail(email, pw)).then(function (u) {
        if (!u || !u.uid) { return { ok: false, reason: 'no-user' }; }
        return Promise.resolve(adapter.getDoc(base + '/roles/' + u.uid)).then(function (snap) {
          var role = (snap && snap.exists && snap.data) ? String(snap.data.role || '') : '';
          if (role !== 'admin') {
            return { ok: false, reason: 'not-admin', role: role || 'none', uid: u.uid };
          }
          /* 이미 연결된 기기라면 엔진에도 「관리자로 확인됨」을 알려 바로 관리자로 쓸 수 있게 한다 */
          if (adapter === S.adapter) {
            S.auth = { uid: u.uid, email: u.email || email, role: 'admin', expect: 'admin' };
            saveConfig({ adminEmail: email });
            if (S.engine && typeof S.engine.setVerifiedRole === 'function') {
              try { S.engine.setVerifiedRole('admin'); } catch (e) {}
            }
            try { renderAll(); } catch (e2) {}
          }
          return { ok: true, uid: u.uid, email: u.email || email, role: 'admin', connected: adapter === S.adapter };
        }, function (err) {
          return { ok: false, reason: 'role-read-failed', uid: u.uid, detail: FB.errorText(err) };
        });
      }, function (err) {
        return { ok: false, reason: 'auth-failed', detail: FB.errorText(err) };
      });
    }, function (err) {
      return { ok: false, reason: 'connect-failed', detail: FB.errorText(err) };
    });
  }

  /* ---------- 📊 동기화 상태 창 (헤더 배지·관리자 화면에서 연다) ----------
     · 지금 상태·마지막 동기화·증분(델타) 구독 현황·전송 대기를 한눈에
     · 「🔄 새로고침」        = 대기 중인 기록을 먼저 보내고 앱을 다시 연다
     · 「🔄 전체 다시 불러오기」 = 기기 간 누락이 의심될 때 1회 전체 재동기화 */
  var SYNC_MODAL = { open: false, root: null };

  /* 엔진이 적은 시각(_updatedAt 과 같은 표기: 기기 지역 시각)을 그대로 보여 준다 */
  function isoText(iso) {
    var s = String(iso == null ? '' : iso);
    if (!s) { return '-'; }
    return s.slice(0, 19).replace('T', ' ');
  }

  function syncInfoText() {
    var info = null;
    try { info = S.engine && typeof S.engine.syncInfo === 'function' ? S.engine.syncInfo() : null; } catch (e) { info = null; }
    if (!info) { return '<div class="tiny-note">동기화가 켜져 있지 않습니다 — 증분 구독 정보가 없습니다.</div>'; }
    var names = Object.keys(info.collections || {});
    var rows = names.map(function (k) {
      var at = info.collections[k];
      return '<tr><td>' + escHtml(k) + '</td><td>' + escHtml(isoText(at.iso)) + '</td></tr>';
    }).join('');
    var head = info.delta
      ? '이 기기는 <b>바뀐 것만 받는 증분 구독</b>을 씁니다 — 새로고침마다 2,500건을 다시 읽지 않습니다(변경 0~5건).'
      : '아직 전체 동기화 기록이 없어 <b>다음 연결 때 전체를 한 번</b> 받습니다.';
    return '<div class="tiny-note" style="line-height:1.6">' + head +
      '<br>안전 여유 ' + Math.round((info.safetyMs || 0) / 1000) + '초 · 창을 닫아도 계속 동기화됩니다.' +
      (info.fullSyncAt ? '<br>마지막 전체 다시 불러오기: ' + escHtml(isoText(info.fullSyncAt)) : '') + '</div>' +
      (rows ? '<table class="fb-sync-tbl"><thead><tr><th>컬렉션</th><th>마지막 동기화</th></tr></thead><tbody>' + rows + '</tbody></table>' : '');
  }

  function renderSyncModal() {
    if (!SYNC_MODAL.open || !SYNC_MODAL.root) { return; }
    var st = S.engine ? S.engine.status() : { state: 'local', text: '⚪ 미연결(로컬 모드)', queued: 0, lastSyncAt: '' };
    var sum = S.engine ? S.engine.outbox.summary() : { pending: 0, failed: 0, unacked: 0 };
    var body = SYNC_MODAL.root.querySelector('#fb-sync-modal-body');
    if (!body) { return; }
    body.innerHTML =
      '<div class="fb-sync-state"><span class="chip ' + chipFor(st.state) + '">' + escHtml(st.text) + '</span>' +
      '<span class="tiny-note">마지막 동기화: ' + escHtml(st.lastSyncAt ? isoText(st.lastSyncAt) : '아직 없음') + '</span></div>' +
      '<div class="tiny-note" style="margin:8px 0 10px">보낼 것 <b>' + sum.pending + '</b>건 · 확인 중 <b>' + sum.unacked +
      '</b>건 · 실패 <b>' + sum.failed + '</b>건 · 기기 ID <b>' + escHtml(deviceId()) + '</b></div>' +
      syncInfoText();
  }

  function closeSyncStatus() {
    var root = SYNC_MODAL.root || $('modal-root');
    SYNC_MODAL.open = false;
    SYNC_MODAL.root = null;
    if (root) {
      root.classList.remove('open');
      root.innerHTML = '';
      root.onclick = null;
    }
  }

  function openSyncStatus() {
    var root = $('modal-root');
    if (!root) { return; }
    SYNC_MODAL.open = true;
    SYNC_MODAL.root = root;
    root.innerHTML =
      '<div class="modal-backdrop" data-fbclose="1"></div>' +
      '<div class="modal" role="dialog" aria-modal="true" aria-label="동기화 상태">' +
      '<h3>🔄 동기화 상태</h3>' +
      '<div class="modal-sub">새로고침은 대기 중인 기록을 먼저 보낸 뒤 앱을 다시 엽니다.</div>' +
      '<div class="modal-body" id="fb-sync-modal-body"></div>' +
      '<div class="modal-actions">' +
      '<button class="btn" data-fbclose="1" id="fb-sync-modal-close">닫기</button>' +
      '<button class="btn" id="fb-sync-modal-full" style="font-weight:800">🔄 전체 다시 불러오기</button>' +
      '<button class="btn btn-primary" id="fb-sync-modal-refresh" style="font-weight:800">🔄 새로고침</button>' +
      '</div></div>';
    root.classList.add('open');
    root.onclick = function (ev) {
      var t = ev.target;
      if (!t) { return; }
      if (t.closest && t.closest('[data-fbclose]')) { closeSyncStatus(); return; }
      if (t.closest && t.closest('#fb-sync-modal-full')) { onFullSync(); return; }
      if (t.closest && t.closest('#fb-sync-modal-refresh')) { appRefresh(); }
    };
    renderSyncModal();
  }

  function escHtml(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /* 🔄 전체 다시 불러오기 — 확인을 한 번 받고 델타 기준 시각을 지워 전체 구독 */
  function onFullSync() {
    var msg = '기기 간 누락이 의심될 때만 쓰세요.\n서버에서 전체를 다시 받아 오며, 무료 읽기를 한 번 크게 씁니다(원생·원비 등 약 2,500건).\n지금 전체 다시 불러올까요?';
    if (typeof window.confirm === 'function' && !window.confirm(msg)) { return; }
    var r = null;
    try { r = S.engine && typeof S.engine.forceFullSync === 'function' ? S.engine.forceFullSync() : null; } catch (e) { r = null; }
    S.msg = r ? '🔄 전체 다시 불러오기를 시작했습니다 — 잠시 뒤 화면이 채워집니다.' : '전체 다시 불러오기를 할 수 없습니다(동기화가 꺼져 있음).';
    S.msgKind = r ? 'ok' : 'warn';
    try { renderAll(); } catch (e) {}
    renderSyncModal();
    return r;
  }

  /* ---------- 🔄 새로고침 — 대기 중인 기록을 먼저 보내고 앱을 다시 연다 ----------
     · 「지금 전송」(flush)이 3초 안에 끝나지 않아도 그대로 새로고침한다(보내던 것은 큐에 남아 다음에 다시 보냄).
     · 서비스워커 새 버전이 대기 중이면 SKIP_WAITING 으로 즉시 활성화한다. */
  function appRefresh(opts) {
    opts = opts || {};
    var btn = $('app-refresh-btn');
    var label = btn ? btn.querySelector('.rf-txt') : null;
    if (btn) { btn.disabled = true; btn.classList.add('busy'); }
    if (label) { label.textContent = '보내는 중…'; }
    var flushed = false;
    function finish() {
      if (flushed) { return; }
      flushed = true;
      try { if (typeof opts.beforeReload === 'function') { opts.beforeReload(); } } catch (e) {}
      reloadNow(opts);
    }
    var timer = setTimeout(finish, 3000);
    var sending = null;
    try { sending = (S.engine && typeof S.engine.flush === 'function') ? S.engine.flush() : null; } catch (e) { sending = null; }
    Promise.resolve(sending).then(function () { clearTimeout(timer); finish(); },
      function () { clearTimeout(timer); finish(); });
    return flushed;
  }

  function reloadNow(opts) {
    opts = opts || {};
    var doReload = (typeof opts.reload === 'function') ? opts.reload : function () {
      try { window.location.reload(); } catch (e) {}
    };
    var sw = null;
    try { sw = (typeof navigator !== 'undefined' && navigator.serviceWorker) ? navigator.serviceWorker : null; } catch (e) { sw = null; }
    if (!sw || typeof sw.getRegistration !== 'function') { doReload(); return; }
    var went = false;
    function go() { if (went) { return; } went = true; doReload(); }
    setTimeout(go, 400);   /* 서비스워커가 응답하지 않아도 새로고침은 한다 */
    try {
      sw.getRegistration().then(function (reg) {
        try {
          if (reg && reg.waiting && reg.waiting.postMessage) { reg.waiting.postMessage({ type: 'SKIP_WAITING' }); }
          else if (reg && typeof reg.update === 'function') { try { reg.update(); } catch (e) {} }
        } catch (e) {}
        setTimeout(go, 120);
      }, function () { go(); });
    } catch (e) { go(); }
  }

  function ensurePill() {
    if ($('fb-pill')) { return; }
    var d = document.createElement('div');
    d.id = 'fb-pill';
    d.className = 'fb-pill';
    d.innerHTML = '<span class="fb-pill-state" id="fb-pill-state">⚪ 미연결(로컬 모드)</span>';
    document.body.appendChild(d);
  }

  /* ---------- 이벤트 연결 ---------- */
  function bind() {
    var map = [
      ['fb-save', onSave], ['fb-test', onTest], ['fb-mock', connectMock],
      ['fb-admin-login', function () { loginAs(); }],
      ['fb-admin-logout', function () { logoutAs(); }],
      ['fb-mig-preview', onPreview], ['fb-mig-run', onMigrate],
      ['fb-flush', onFlush], ['fb-retry', onRetry], ['fb-clear-failed', onClearFailed], ['fb-usage-reset', onUsageReset],
      ['fb-guide', onGuide],
      /* 🔄 새로고침 · 동기화 상태 — 헤더 도구 영역과 관리자 화면 양쪽에서 */
      ['app-refresh-btn', function () { appRefresh(); }],
      ['hdr-fb-chip', openSyncStatus],
      ['fb-sync-open', openSyncStatus]
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
    /* 화면이 뜨자마자 옛 동기화 그림자를 IndexedDB 로 옮긴다 —
       localStorage 5MB 한도를 먼저 비워야 앱 데이터 저장이 "저장공간 부족"으로 멈추지 않는다.
       (연결을 하지 않는 로컬 모드에서도 마찬가지) */
    var migrating = null;
    try { migrating = FB.migrateShadowCache(localStorage); } catch (e) { migrating = null; }
    S.migrating = Promise.resolve(migrating).then(function (r) {
      if (r && r.migrated) {
        S.msg = '💾 동기화 내부 기록(그림자)을 IndexedDB 로 옮기고 localStorage ' +
          Math.max(1, Math.round((r.bytesFreed || 0) / 1024)) + 'KB 를 비웠습니다.';
        S.msgKind = 'ok';
      }
      return r;
    }, function () { return null; });
    /* 저장해 둔 훅이 없으면 앱이 준비될 때까지 잠깐 기다린다 */
    var tries = 0;
    (function ready() {
      tries++;
      var ok = window.__tdk && window.__tdk.app;
      if (!ok && tries < 60) { setTimeout(ready, 150); return; }
      Promise.resolve(S.migrating).then(function () {
        if (S.cfg.mode === 'mock') { connectMock(); }
        else if (S.cfg.mode === 'firestore') {
          /* 앱을 껐다 켜도 저장된 firebaseConfig 로 혼자 다시 연결한다.
             로그인 세션은 어댑터가 복원을 기다렸다가(최대 4초) roles/{uid} 로 역할을 확인하므로
             손대지 않아도 🟢 연결 상태로 돌아온다. */
          var v = FB.validateConfig(S.cfg.config || {});
          if (v.ok) { connectFirestore(); }
          else {
            S.msg = '⚠️ 저장된 firebaseConfig 를 확인해 주세요: ' + v.errors.join(' / ') +
              ' — 「설정 저장」을 눌러 다시 연결할 수 있습니다.';
            S.msgKind = 'warn';
            renderAll();
          }
        }
        else { renderAll(); }
      });
      if (S.timer) { clearInterval(S.timer); }
      S.timer = setInterval(function () { renderStatus(); renderUsage(); renderQueue(); }, 2000);
    })();
  }

  window.TDKFB = {
    /* v43 — 모든 기기는 관리자 하나다. 서버 roles 확인 전에는 'none'(잠금)이다. */
    deviceRole: function () { return engineRole() === 'admin' ? 'admin' : 'none'; },
    requestedRole: function () { return 'admin'; },
    effectiveRole: engineRole,
    verifiedRole: verifiedRole,
    /* 🔄 새로고침 — 대기 중인 기록을 보낸 뒤 앱을 다시 연다 */
    refreshApp: appRefresh,
    flushOutbox: function () { return S.engine ? S.engine.flush() : null; },
    /* 🔄 전체 다시 불러오기 — 델타 기준 시각을 지우고 전체 구독 */
    fullSync: onFullSync,
    syncInfo: function () {
      var info = null;
      try { info = S.engine && typeof S.engine.syncInfo === 'function' ? S.engine.syncInfo() : null; } catch (e) { info = null; }
      return info;
    },
    openSyncStatus: openSyncStatus,
    closeSyncStatus: closeSyncStatus,
    /* 🔑 로그인 모달의 「비밀번호 분실 시」 — Firebase 관리자 계정으로 본인 확인 */
    verifyAdminCredentials: verifyAdminCredentials,
    roleLabel: function (r) { return roleLabel(r); },
    loginAs: loginAs,
    auth: function () { return S.auth ? { uid: S.auth.uid, email: S.auth.email, role: S.auth.role } : null; },
    engine: function () { return S.engine; },
    adapter: function () { return S.adapter; },
    server: function () { return S.server; },
    config: function () { return S.cfg; },
    connectMock: connectMock,
    connectFirestore: connectFirestore,
    disconnect: disconnect,
    flush: function () { return S.engine ? S.engine.flush() : null; },
    clearFailed: onClearFailed,
    failedCount: failedCount,
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
