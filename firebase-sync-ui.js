/* =============================================================================
   경희대MTA태권도 — 🔥 Firebase 실시간 동기화 설정 패널
   -----------------------------------------------------------------------------
   · 「🔐 관리자 계정」 탭 안에 「🔥 Firebase 실시간 동기화」 패널을 살립니다.
   · firebaseConfig 는 코드에 넣지 않고, 이 화면에서 붙여넣어 기기(localStorage)에
     저장합니다. (tdk.fbConfig.v1 — 다른 기기로 자동 전송되지 않습니다)
   · v43 — 관리자 계정 단일 구조: 모든 기기(PC·태블릿·폰)가 같은 관리자 계정으로
     로그인해 하나의 Firestore 를 함께 씁니다. 태블릿 전용 계정·역할 선택은 없습니다.
   · v48 — 앱을 켜면 이 Firebase 로그인이 첫 화면(관문)입니다. 앱 잠금(admin / 0000)은
     없어졌습니다 — 로그인한 계정이 서버 roles/{uid} 에서 관리자로 확인되어야 본문이 열립니다.
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

  /* v48 — 첫 화면 관문 상태 (아래 「v48 — 첫 화면의 Firebase 로그인 관문」 절) */
  var G = { step: 'checking', locked: true, busy: false, deciding: null, uid: '', email: '', offline: false };
  var VERIFIED_KEY = 'tdk.fbGate.v1';

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

  /* 세션 변화를 관문에 그대로 반영한다 (v48).
     · 늦게 복원된 세션이 생기면 roles/{uid} 를 확인해 관문을 연다(관리자일 때만).
     · 세션이 사라지면(다른 탭 로그아웃·만료) 다시 잠그고 로그인 화면으로 돌아간다. */
  function watchAuthRestore(adapter, engine) {
    if (!adapter || typeof adapter.onAuthChange !== 'function') { return; }
    if (S.authUnsub) { try { S.authUnsub(); } catch (e) {} S.authUnsub = null; }
    try {
      S.authUnsub = adapter.onAuthChange(function (user) {
        if (S.engine !== engine) { return; }
        var uid = (user && user.uid) ? String(user.uid) : '';
        if (!uid) {
          /* 세션이 사라졌다 — 열려 있던 관문을 다시 잠근다 */
          if (G.step === 'ready') { gateLock('expired'); }
          return;
        }
        if (G.step === 'ready' && G.uid === uid) { return; }
        gateDecide();
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
      /* v49 — 동기적으로 예외가 나도 「확인 중」에 갇히지 않게 관문을 내린다 */
      try { gateConnectFailed(err); } catch (e) {}
      return Promise.resolve(false);
    }
    var result = connecting.then(function (adapter) {
      try {
        S.adapter = adapter;
        var engine = makeEngine(adapter);
        saveConfig({ mode: 'firestore', config: v.config });
        S.msg = '🔥 Firebase 에 연결했습니다.';
        S.msgKind = 'ok';
        renderAll();
        /* 세션이 늦게 복원되거나 사라지는 것까지 계속 지켜본다 */
        try { watchAuthRestore(adapter, engine); } catch (e) {}
        /* 저장된 로그인 세션 → roles/{uid} 확인 → 관문을 열지 정한다 */
        return gateDecide().then(function (ok) { return !!ok; }, function () { return false; });
      } catch (err) {
        showError('⚠️ 연결하지 못했습니다: ', err);
        try { gateConnectFailed(err); } catch (e) {}
        return false;
      }
    }, function (err) {
      S.adapter = null;
      S.msg = '⚠️ 연결하지 못했습니다: ' + FB.errorText(err) + ' — 인터넷과 firebaseConfig 를 확인해 주세요.';
      S.msgKind = 'warn';
      renderAll();
      /* v49 — 연결이 실패·시간초과하면 반드시 로그인(또는 설정) 화면으로 내려온다 */
      try { gateConnectFailed(err); } catch (e) {}
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

  /* v48 — 패널의 로그인 안내칸. 실제 로그인은 첫 화면 관문이 맡고,
     여기서는 「지금 어느 계정인지」만 보여 준다. */
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
      hint.innerHTML = '로그인은 앱을 열 때 첫 화면에서 합니다 — 이 화면에서는 계정을 바꿀 때만 <b>로그아웃</b>을 눌러 주세요.';
    }
    var note = $('fb-role-state');
    if (!note) { return; }
    if (!S.adapter || S.adapter.mode !== 'firestore') {
      note.textContent = '실제 Firebase 모드에서만 로그인합니다. (모의 모드는 로그인 없이 시험)';
      return;
    }
    if (!a) {
      note.textContent = '아직 로그인하지 않았습니다 — 앱 첫 화면의 로그인에서 관리자 계정으로 들어와 주세요.';
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
    /* v48 — 미연결(로컬) 모드는 없다: 저장된 설정이 있으면 실제 Firebase, 연습은 모의 모드 */
    if (modeSel) { modeSel.value = (S.cfg.mode === 'mock') ? 'mock' : 'firestore'; }
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

  /* v48 — 로그아웃: 세션을 닫고 첫 화면 관문을 다시 잠갔다
     (앱 잠금 admin/0000 은 없어졌으므로 「잠금」도 로그아웃 하나로 한다) */
  function logoutNow() {
    var ad = S.adapter;
    var p = null;
    try { p = (ad && typeof ad.signOut === 'function') ? ad.signOut() : null; } catch (e) { p = null; }
    return Promise.resolve(p).then(function () { return true; }, function () { return false; }).then(function () {
      clearVerified();
      G.uid = '';
      G.email = '';
      S.auth = null;
      gateLock('logout');
      S.msg = '로그아웃했습니다 — 다음에 관리자 계정으로 로그인해 주세요.';
      S.msgKind = '';
      try { renderAll(); } catch (e) {}
      return true;
    });
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

  /* =========================================================================
     v48 — 첫 화면의 Firebase 로그인 관문
     -------------------------------------------------------------------------
     · index.html 의 #login-gate 가 앱 본문 위를 덮고 있다. 관문이 열려야(ready)
       앱 본문과 실시간 동기화가 보인다. 앱은 window.__tdkGate.locked 로 잠금을 안다.
     · 순서: 저장된 세션 확인 → 서버 roles/{uid} 확인 → admin 이면 열림
             세션 없음 → 로그인 화면 · 관리자 아님 → 사유 안내 뒤 다시 로그인
             설정 없음(새 기기·저장소 초기화) → firebaseConfig 입력 화면
     · 인터넷이 없을 때는 「마지막으로 관리자 확인된 계정」(이 기기에 기록)에 한해
       관문을 연다 — 출석이 인터넷 때문에 멈추지 않게(기록은 기기에 쌓였다가 연결되면 보낸다).
     ========================================================================= */
  function gateRoot() { return $('login-gate'); }

  /* 관문 문구·단계 — 지금 보여 줄 한 단계만 남기고 나머지는 숨긴다 */
  function gateShowStep(step) {
    G.step = step;
    /* v49 — 「확인 중」을 벗어나면 느린 응답 안내·보조 버튼은 감춘다 */
    if (step !== 'checking') { gateClearSlow(); }
    var steps = { checking: 'gate-check', login: 'gate-form', denied: 'gate-denied', setup: 'gate-setup' };
    Object.keys(steps).forEach(function (k) { show(steps[k], k === step); });
    var root = gateRoot();
    if (root) {
      if (root.classList) { root.classList.toggle('off', step === 'ready'); }
      root.style.display = (step === 'ready') ? 'none' : 'flex';
    }
    setLocked(step !== 'ready', step);
    if (step !== 'ready') { try { renderAll(); } catch (e) {} }
  }

  /* 잠금 상태를 앱과 나누어 가진다 — 앱은 이 값으로 출석 입력까지 막는다 */
  function setLocked(locked, reason) {
    G.locked = !!locked;
    try {
      window.__tdkGate = { locked: !!locked, step: G.step, reason: reason || '', uid: G.uid, email: G.email };
    } catch (e) {}
    try {
      if (window.__tdk && typeof window.__tdk.onGate === 'function') {
        window.__tdk.onGate(!!locked ? 'locked' : 'ready');
      }
    } catch (e) {}
  }

  function gateMsg(text, kind) {
    var el = $('gate-msg');
    if (!el) { return; }
    el.textContent = String(text == null ? '' : text);
    el.className = 'gate-msg' + (kind === 'bad' ? ' bad' : (kind === 'warn' ? ' warn' : (kind === 'ok' ? ' ok' : '')));
    el.style.display = text ? '' : 'none';
  }
  function gateNote(text) {
    var el = $('gate-note');
    if (!el) { return; }
    el.textContent = String(text || '');
    el.style.display = text ? '' : 'none';
  }
  function gateBusy(on, label) {
    G.busy = !!on;
    var btn = $('gate-login');
    if (btn) { btn.disabled = !!on; btn.textContent = on ? (label || '로그인 중…') : '로그인'; }
  }

  /* ---------------------------------------------------------------------------
     v49 — 「로그인 상태를 확인하는 중…」에 갇히지 않게 하는 안전장치
     · 서버 확인이 SLOW_AFTER_MS(5초)를 넘기면 안내 문구와 「다시 시도」·
       「로그인 화면으로」 버튼을 띄운다.
     · 연결·권한 확인에는 각각 시간 제한(CONNECT/VERIFY_TIMEOUT_MS)이 있고,
       실패·시간초과는 반드시 로그인(또는 설정) 화면으로 내려온다.
     --------------------------------------------------------------------------- */
  var SLOW_AFTER_MS = 5000;
  var VERIFY_TIMEOUT_MS = 8000;
  var slowTimer = null;
  function gateClearSlow() {
    if (slowTimer) { try { clearTimeout(slowTimer); } catch (e) {} slowTimer = null; }
    show('gate-slow', false);
  }
  function gateArmSlow(ms) {
    gateClearSlow();
    var wait = Number(ms) > 0 ? Number(ms) : SLOW_AFTER_MS;
    try {
      slowTimer = setTimeout(function () {
        slowTimer = null;
        if (G.step !== 'checking') { return; }
        show('gate-slow', true);
        gateMsg('서버 응답을 기다리는 중… ' + Math.round(wait / 1000) + '초가 넘었습니다. 그대로 기다리거나 아래 버튼으로 빠져나오세요.', 'warn');
      }, wait);
    } catch (e) { slowTimer = null; }
  }

  /* 로그인 화면으로 내려온다 — 마지막 관리자 확인 기록이 있으면 「인터넷 없이 열기」도 함께 보여 준다 */
  function gateToLogin(msg, note) {
    G.uid = '';
    G.email = '';
    S.auth = null;
    if (S.engine && typeof S.engine.setVerifiedRole === 'function') {
      try { S.engine.setVerifiedRole(''); } catch (e) {}
    }
    gateShowStep('login');
    gateMsg(msg || '', msg ? 'warn' : '');
    gateNote(note || ('도장 ID ' + S.cfg.dojangId + ' · 관리자 계정으로 로그인해 주세요.'));
    var cached = cachedVerified();
    var off = $('gate-offline-open');
    if (off) {
      off.style.display = cached ? '' : 'none';
      off.textContent = cached
        ? ('📴 인터넷 없이 열기 (마지막 관리자: ' + String(cached.email || cached.uid) + ')')
        : '📴 인터넷 없이 열기';
    }
    var em = $('gate-email');
    if (em && !em.value && S.cfg.adminEmail) { em.value = String(S.cfg.adminEmail); }
    return false;
  }

  /* 마지막으로 관리자 확인된 계정 — 인터넷이 없을 때만 쓰는 기억 */
  function rememberVerified(info) {
    if (!info || !info.uid) { return; }
    try {
      localStorage.setItem(VERIFIED_KEY, JSON.stringify({
        uid: String(info.uid), email: String(info.email || ''), at: new Date().toISOString()
      }));
    } catch (e) {}
  }
  function cachedVerified() {
    try {
      var v = JSON.parse(localStorage.getItem(VERIFIED_KEY) || 'null');
      return (v && v.uid) ? v : null;
    } catch (e) { return null; }
  }
  function clearVerified() { try { localStorage.removeItem(VERIFIED_KEY); } catch (e) {} }

  /* 서버 roles/{uid} 를 직접 읽어 관리자인지 확인하고, 엔진의 유효 권한도 맞춘다 */
  function verifyAdminNow(uid) {
    var ad = S.adapter;
    var id = String(uid || '');
    if (!id) {
      var cu = null;
      try { cu = (ad && typeof ad.currentUser === 'function') ? ad.currentUser() : null; } catch (e) { cu = null; }
      id = (cu && cu.uid) ? String(cu.uid) : '';
    }
    if (!ad || !id) { return Promise.resolve({ verified: '', role: 'none', reason: 'no-sign-in' }); }
    var path = 'dojangs/' + S.cfg.dojangId + '/roles/' + id;
    if (typeof ad.getDoc !== 'function') { return Promise.resolve({ verified: '', role: 'none', reason: 'no-adapter', uid: id, path: path }); }
    var call;
    try { call = ad.getDoc(path); } catch (err) { call = Promise.reject(err); }
    /* v49 — 서버가 응답하지 않아도(모바일 네트워크·캐시·IndexedDB 지연) 영원히 기다리지 않는다 */
    var bounded = (typeof FB.withinTime === 'function')
      ? FB.withinTime(Promise.resolve(call), VERIFY_TIMEOUT_MS, function () {
          return {
            code: 'verify-timeout',
            message: '관리자 권한 확인이 ' + Math.round(VERIFY_TIMEOUT_MS / 1000) + '초 안에 끝나지 않았습니다 — 인터넷을 확인해 주세요'
          };
        })
      : Promise.resolve(call);
    return bounded.then(function (res) {
      var v = (res && res.exists && res.data) ? String(res.data.role || '') : '';
      /* 서버 roles 로 유효 권한을 잠근다 — admin 이면 엔진이 구독·전송을 시작한다 */
      if (S.engine && typeof S.engine.setVerifiedRole === 'function') {
        try { S.engine.setVerifiedRole(v); } catch (e) {}
      }
      return { verified: v, role: v || 'none', uid: id, email: G.email, path: path };
    }, function (err) {
      if (S.engine && typeof S.engine.setVerifiedRole === 'function') {
        try { S.engine.setVerifiedRole(''); } catch (e) {}
      }
      return { verified: '', role: 'none', uid: id, error: FB.errorText(err), path: path };
    });
  }

  /* 지금 세션이 관리자인지 보고 관문을 열지 정한다 (동시에 여러 번 불러도 한 번만 확인) */
  function gateDecide(pre) {
    if (G.deciding) { return G.deciding; }
    var p = decideNow(pre || null);
    G.deciding = p;
    var done = function () { if (G.deciding === p) { G.deciding = null; } };
    p.then(done, done);
    return p;
  }

  function decideNow(pre) {
    var ad = S.adapter;
    if (!ad || ad.mode !== 'firestore') {
      /* v49 — 연결이 없으면 단계만 보고 판단한다: 설정이 없으면 설정 화면,
         설정은 있는데 연결이 실패한 것이면 로그인 화면 + 다시 시도 */
      var cfgOk = FB.validateConfig(S.cfg.config || {}).ok;
      if (!cfgOk) {
        fillGateSetup();
        gateShowStep('setup');
        gateMsg('', '');
        return Promise.resolve(false);
      }
      return Promise.resolve(gateToLogin(
        (S.msgKind === 'warn' && /연결하지 못했습니다/.test(String(S.msg || '')))
          ? S.msg + ' — 「🔄 연결 다시 시도」를 눌러 주세요.'
          : 'Firebase 에 연결하지 못했습니다 — 「🔄 연결 다시 시도」를 눌러 주세요.',
        '도장 ID ' + S.cfg.dojangId + ' · 로그인하려면 먼저 서버에 연결되어야 합니다.'));
    }
    var uid = String((pre && pre.uid) || '');
    var email = String((pre && pre.email) || '');
    if (!uid) {
      var cu = null;
      try { cu = (typeof ad.currentUser === 'function') ? ad.currentUser() : null; } catch (e) { cu = null; }
      uid = (cu && cu.uid) ? String(cu.uid) : '';
      email = (cu && cu.email) || '';
    }
    if (!uid) {
      /* 세션이 없다 — 로그인 화면 */
      return Promise.resolve(gateToLogin('', '도장 ID ' + S.cfg.dojangId + ' · 관리자 계정으로 로그인해 주세요.'));
    }
    G.uid = uid;
    G.email = email;
    gateShowStep('checking');
    gateMsg('', '');
    gateNote('도장 ID ' + S.cfg.dojangId + ' · 관리자 권한을 확인하는 중…');
    gateArmSlow();
    return verifyAdminNow(uid).then(function (r) {
      if (r && r.verified === 'admin') {
        gateUnlock({ uid: uid, email: email });
        return true;
      }
      if (r && r.error) {
        /* 서버에 닿지 못했다 — 이 기기에서 마지막으로 관리자 확인된 바로 그 계정이면 연다 */
        var cached = cachedVerified();
        if (cached && String(cached.uid) === uid) {
          gateUnlock({ uid: uid, email: email || cached.email, offline: true });
          return true;
        }
        gateToLogin('관리자 권한을 확인하지 못했습니다 — 인터넷 연결을 확인한 뒤 다시 시도해 주세요. (' + String(r.error) + ')',
          '도장 ID ' + S.cfg.dojangId + ' · 「🔄 연결 다시 시도」로 다시 확인할 수 있습니다.');
        return false;
      }
      /* 로그인은 됐지만 관리자가 아니다 */
      gateDenied(r);
      return false;
    }, function (err) {
      gateToLogin('권한을 확인하지 못했습니다: ' + FB.errorText(err), '도장 ID ' + S.cfg.dojangId);
      return false;
    });
  }

  function gateDenied(r) {
    var role = (r && (r.verified || r.role)) || '';
    var who = G.email || G.uid;
    var path = (r && r.path) || ('dojangs/' + S.cfg.dojangId + '/roles/' + G.uid);
    setHtml('gate-denied-msg',
      (who ? '<b>' + escHtml(who) + '</b> 계정은 ' : '') + '이 도장의 관리자가 아닙니다' +
      (role ? ' (서버 역할: ' + escHtml(role) + ')' : ' (서버 역할 문서 없음)') + '.<br>' +
      'Firebase 콘솔에서 <b>' + escHtml(path) + '</b> 문서의 role 을 <b>admin</b> 으로 맞추거나, 관리자 계정으로 다시 로그인해 주세요.');
    gateShowStep('denied');
    gateMsg('', '');
    /* 세션이 남아 있으면 다음 실행에도 같은 계정으로 막히니 로그아웃해 둔다 */
    S.auth = null;
    clearVerified();
    try {
      if (S.adapter && typeof S.adapter.signOut === 'function') {
        Promise.resolve(S.adapter.signOut()).then(function () {}, function () {});
      }
    } catch (e) {}
  }

  function gateUnlock(info) {
    info = info || {};
    if (info.uid) { G.uid = String(info.uid); }
    if (info.email) { G.email = String(info.email); }
    G.offline = !!info.offline;
    S.auth = { uid: G.uid, email: G.email, role: 'admin' };
    if (S.engine && typeof S.engine.setVerifiedRole === 'function') {
      try { S.engine.setVerifiedRole('admin'); } catch (e) {}
    }
    if (!info.offline) { rememberVerified({ uid: G.uid, email: G.email }); }
    gateBusy(false);
    gateMsg('', '');
    gateShowStep('ready');
    if (info.mock) {
      S.msg = '🧪 연습(모의) 모드로 열었습니다 — 실제 서버 자료와 섞이지 않는 시험용입니다.';
      S.msgKind = '';
    } else if (info.offline) {
      S.msg = '⚠️ 인터넷이 없어 「마지막으로 관리자 확인된 계정」으로 열었습니다 — 찍은 출석은 이 기기에 보관되고, 연결되면 자동으로 보냅니다.';
      S.msgKind = 'warn';
    } else {
      S.msg = '✅ 관리자 계정(' + (G.email || G.uid) + ')으로 확인되어 출결·관리자 화면과 동기화를 시작했습니다.';
      S.msgKind = 'ok';
    }
    try { renderAll(); } catch (e) {}
    return true;
  }

  /* 관문을 다시 잠근다 — 로그인 화면(또는 설정 화면)으로 돌아간다 */
  function gateLock(reason) {
    gateBusy(false);
    var ad = S.adapter;
    var canLogin = !!(ad && ad.mode === 'firestore');
    if (reason === 'logout' || reason === 'expired') { G.uid = ''; G.email = ''; }
    S.auth = null;
    if (S.engine && typeof S.engine.setVerifiedRole === 'function') {
      try { S.engine.setVerifiedRole(''); } catch (e) {}
    }
    gateShowStep(canLogin ? 'login' : 'setup');
    if (reason === 'logout') { gateMsg('로그아웃했습니다 — 다시 로그인해 주세요.', 'ok'); }
    else if (reason === 'expired') { gateMsg('로그인 세션이 끝났습니다 — 다시 로그인해 주세요.', 'warn'); }
    else { gateMsg('', ''); }
    return false;
  }

  /* v49 — Firebase 연결(어댑터 만들기)이 실패하거나 시간을 넘겼을 때 관문을 반드시 움직인다.
     v48 까지는 이 자리에서 관문을 전혀 바꾸지 않아 「로그인 상태를 확인하는 중…」
     스피너에 영원히 갇혔다. */
  function gateConnectFailed(err) {
    if (G.step === 'ready') { return false; }   /* 이미 열려 있으면(재연결 시도 중) 건드리지 않는다 */
    gateClearSlow();
    gateBusy(false);
    var why = FB.errorText(err);
    var v = FB.validateConfig(S.cfg.config || {});
    if (!v.ok) {
      fillGateSetup();
      gateShowStep('setup');
      gateMsg('Firebase 에 연결하지 못했습니다: ' + why + ' — firebaseConfig 를 확인해 주세요.', 'warn');
      gateNote('');
      return false;
    }
    return gateToLogin('Firebase 에 연결하지 못했습니다: ' + why + ' — 인터넷을 확인한 뒤 「🔄 연결 다시 시도」를 눌러 주세요.',
      '도장 ID ' + S.cfg.dojangId + ' · 로그인하려면 먼저 서버에 연결되어야 합니다.');
  }

  /* 「다시 시도」 — 멈춰 있던 연결은 버리고 새로 연결한 뒤 관문을 다시 정한다 */
  function gateRetryConnect() {
    gateClearSlow();
    if (G.step === 'ready') { return Promise.resolve(true); }
    var v = FB.validateConfig(S.cfg.config || {});
    if (!v.ok) {
      fillGateSetup();
      gateShowStep('setup');
      gateMsg('연결 설정이 없습니다 — firebaseConfig 를 넣어 주세요.', 'warn');
      return Promise.resolve(false);
    }
    S.connecting = null;                 /* 응답이 없는 이전 시도는 기다리지 않는다 */
    gateShowStep('checking');
    gateMsg('', '');
    gateNote('도장 ID ' + S.cfg.dojangId + ' · Firebase 에 다시 연결하는 중…');
    gateArmSlow();
    return Promise.resolve(connectFirestore()).then(function () {
      return G.step === 'ready';
    }, function (err) {
      gateConnectFailed(err);
      return false;
    });
  }

  /* 「로그인 화면으로」 — 서버 응답을 더 기다리지 않고 바로 로그인 화면으로 내린다 */
  function gateEscapeToLogin() {
    gateClearSlow();
    if (G.step === 'ready') { return false; }
    var v = FB.validateConfig(S.cfg.config || {});
    if (!v.ok) {
      fillGateSetup();
      gateShowStep('setup');
      gateMsg('연결 설정이 없습니다 — firebaseConfig 를 넣어 주세요.', 'warn');
      return false;
    }
    return gateToLogin('서버 응답을 기다리지 않고 로그인 화면으로 왔습니다 — 「🔄 연결 다시 시도」를 누르면 다시 연결합니다.',
      '도장 ID ' + S.cfg.dojangId + ' · 관리자 계정으로 로그인해 주세요.');
  }

  /* 「인터넷 없이 열기」 — 이 기기에서 마지막으로 관리자 확인된 계정이 있을 때만 */
  function gateOfflineOpen() {
    var cached = cachedVerified();
    if (!cached) {
      gateMsg('이 기기에서 관리자로 확인된 기록이 없습니다 — 인터넷이 연결된 뒤 로그인해 주세요.', 'warn');
      show('gate-offline-open', false);
      return false;
    }
    return gateUnlock({ uid: cached.uid, email: cached.email, offline: true });
  }

  /* 로그인 버튼 — 이메일·비밀번호 → Firebase 로그인 → roles/{uid} 확인 */
  function gateLogin() {
    if (G.busy) { return false; }
    var email = val('gate-email').trim();
    var pw = val('gate-pw');
    if (!email || !pw) {
      gateMsg('관리자 이메일과 비밀번호를 모두 입력해 주세요.', 'warn');
      return false;
    }
    var ad = S.adapter;
    if (!ad || ad.mode !== 'firestore' || typeof ad.signInEmail !== 'function') {
      /* v49 — 연결이 아직(또는 실패로) 없으면 먼저 다시 연결해 보고, 되면 바로 로그인한다 */
      gateBusy(true);
      gateMsg('Firebase 에 연결하는 중…', '');
      return Promise.resolve(gateRetryConnect()).then(function () {
        gateBusy(false);
        if (G.step === 'ready') { return true; }
        var ad2 = S.adapter;
        if (!ad2 || ad2.mode !== 'firestore' || typeof ad2.signInEmail !== 'function') {
          gateMsg('Firebase 에 아직 연결되지 않았습니다 — 인터넷을 확인한 뒤 「🔄 연결 다시 시도」를 눌러 주세요.', 'warn');
          return false;
        }
        return gateLogin();
      }, function () {
        gateBusy(false);
        gateMsg('Firebase 에 연결하지 못했습니다 — 「🔄 연결 다시 시도」를 눌러 주세요.', 'warn');
        return false;
      });
    }
    gateBusy(true);
    gateMsg('로그인하는 중…', '');
    var signing;
    try { signing = ad.signInEmail(email, pw); } catch (err) { signing = Promise.reject(err); }
    Promise.resolve(signing).then(function (u) {
      if (!u || !u.uid) {
        gateBusy(false);
        gateMsg('로그인 응답에 사용자 정보가 없습니다 — 다시 시도해 주세요.', 'warn');
        return;
      }
      var pwEl = $('gate-pw');
      if (pwEl) { pwEl.value = ''; }
      saveConfig({ adminEmail: email });
      gateBusy(false);
      gateDecide({ uid: String(u.uid), email: String(u.email || email) });
    }, function (err) {
      gateBusy(false);
      gateMsg('로그인하지 못했습니다: ' + FB.errorText(err) + ' — 이메일·비밀번호를 확인해 주세요.', 'bad');
    });
    return true;
  }

  /* 설정 화면 — 이 기기에 firebaseConfig 가 없을 때(새 기기·저장소 초기화) */
  function fillGateSetup() {
    var dj = $('gate-dojang');
    if (dj && !dj.value) { dj.value = S.cfg.dojangId || DEFAULT_DOJANG; }
    var ar = $('gate-config');
    if (ar && !ar.value && S.cfg.config) {
      try {
        ar.value = FB.stableStringify(S.cfg.config).replace(/,"/g, ',\n  "').replace(/^\{/, '{\n  ').replace(/\}$/, '\n}');
      } catch (e) {}
    }
  }
  function gateSetupSave() {
    var raw = val('gate-config').trim();
    var parsed = null;
    if (raw) {
      try { parsed = JSON.parse(raw); } catch (e) { parsed = null; }
      if (!parsed) {
        var m = raw.match(/\{[\s\S]*\}/);
        if (m) { try { parsed = JSON.parse(m[0]); } catch (e2) { parsed = null; } }
      }
    }
    var v = FB.validateConfig(parsed || {});
    if (!v.ok) {
      gateMsg('firebaseConfig 를 확인해 주세요: ' + v.errors.join(' / '), 'bad');
      return Promise.resolve(false);
    }
    var dj = FB.safeId(val('gate-dojang') || DEFAULT_DOJANG);
    saveConfig({ mode: 'firestore', dojangId: dj, config: v.config });
    gateMsg('Firebase 에 연결하는 중…', '');
    return Promise.resolve(connectFirestore()).then(function () { return gateDecide(); });
  }

  /* 앱을 열 때 관문을 처음 세운다 */
  function startGate() {
    S.cfg = loadConfig();
    var v = FB.validateConfig(S.cfg.config || {});
    if (S.cfg.mode === 'mock') { connectMock(); gateUnlock({ mock: true }); return; }
    if (!v.ok) {
      fillGateSetup();
      gateShowStep('setup');
      if (S.cfg.config) { gateMsg('저장된 firebaseConfig 를 확인해 주세요: ' + v.errors.join(' / '), 'warn'); }
      return;
    }
    gateShowStep('checking');
    gateNote('도장 ID ' + S.cfg.dojangId + ' · 로그인 상태를 확인하는 중…');
    gateArmSlow();
    /* v49 — 연결이 어떤 이유로든 끝나지 않으면 8초 뒤 실패로 돌아온다.
       그때는 gateConnectFailed 가 로그인 화면 + 「다시 시도」로 내려 준다. */
    Promise.resolve(connectFirestore()).then(function () {}, function (err) {
      gateConnectFailed(err);
    });
  }

  /* 관문의 버튼·입력 연결 */
  function bindGate() {
    var form = $('gate-form');
    if (form) {
      form.addEventListener('submit', function (ev) {
        if (ev && typeof ev.preventDefault === 'function') { ev.preventDefault(); }
        gateLogin();
      });
    }
    var btn = $('gate-login');
    if (btn) {
      btn.addEventListener('click', function (ev) {
        if (ev && typeof ev.preventDefault === 'function') { ev.preventDefault(); }
        gateLogin();
      });
    }
    var retry = $('gate-denied-logout');
    if (retry) { retry.addEventListener('click', function () { gateLock('retry'); }); }
    /* v49 — 「확인 중」에 갇히지 않게 하는 보조 버튼들 */
    var slowRetry = $('gate-slow-retry');
    if (slowRetry) {
      slowRetry.addEventListener('click', function (ev) {
        if (ev && typeof ev.preventDefault === 'function') { ev.preventDefault(); }
        gateRetryConnect();
      });
    }
    var slowLogin = $('gate-slow-login');
    if (slowLogin) {
      slowLogin.addEventListener('click', function (ev) {
        if (ev && typeof ev.preventDefault === 'function') { ev.preventDefault(); }
        gateEscapeToLogin();
      });
    }
    var retryBtn = $('gate-retry');
    if (retryBtn) {
      retryBtn.addEventListener('click', function (ev) {
        if (ev && typeof ev.preventDefault === 'function') { ev.preventDefault(); }
        gateRetryConnect();
      });
    }
    var offBtn = $('gate-offline-open');
    if (offBtn) {
      offBtn.addEventListener('click', function (ev) {
        if (ev && typeof ev.preventDefault === 'function') { ev.preventDefault(); }
        gateOfflineOpen();
      });
    }
    var save = $('gate-setup-save');
    if (save) {
      save.addEventListener('click', function (ev) {
        if (ev && typeof ev.preventDefault === 'function') { ev.preventDefault(); }
        gateSetupSave();
      });
    }
  }

  /* ---------- 시작 ---------- */
  function boot() {
    S.cfg = loadConfig();
    deviceId();
    ensurePill();
    bind();
    bindGate();
    if (!$('admin-fb-panel') && !$('login-gate')) { return; }
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
        /* v48 — 첫 화면은 로그인 관문이다. 저장된 세션 → roles 확인 뒤 본문을 연다 */
        startGate();
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
    roleLabel: function (r) { return roleLabel(r); },
    /* v48 — 첫 화면 로그인 관문 */
    logout: logoutNow,
    gate: {
      state: function () {
        return { step: G.step, locked: G.step !== 'ready', busy: G.busy, uid: G.uid, email: G.email, offline: G.offline };
      },
      login: gateLogin,
      decide: gateDecide,
      retry: gateRetryConnect,
      toLogin: gateEscapeToLogin,
      offlineOpen: gateOfflineOpen,
      slowShown: function () { var e = $('gate-slow'); return !!e && e.style.display !== 'none'; },
      lock: gateLock,
      unlock: gateUnlock,
      logout: logoutNow,
      setup: gateSetupSave,
      cached: cachedVerified
    },
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
