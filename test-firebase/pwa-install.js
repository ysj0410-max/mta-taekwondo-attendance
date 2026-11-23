/* =============================================================
   경희대MTA태권도 — 「📲 홈 화면에 앱으로 설치」 도우미
   -------------------------------------------------------------
   · service-worker.js 등록 (https 에서만, 중복 등록 방지, 실패는 조용히)
   · beforeinstallprompt 를 잡아 두었다가 버튼 한 번으로 설치 창 띄우기
   · 관리자 화면 오른쪽 위(잠금 버튼 옆)에 작은 버튼 하나만 둡니다.
     → 출석(키오스크) 화면에는 어떤 것도 그리지 않습니다.
   · 앱 본체(index.html) 코드는 건드리지 않는 독립 스크립트입니다.
   ============================================================= */
(function () {
  'use strict';

  var btn = null;
  var deferredPrompt = null;
  var installCheckedAt = 0;

  /* ---------- 상태 판별 ---------- */
  function isStandalone() {
    try {
      if (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) { return true; }
      if (window.matchMedia && window.matchMedia('(display-mode: fullscreen)').matches) { return true; }
    } catch (e) {}
    return window.navigator.standalone === true;
  }

  function ua() { return String(window.navigator.userAgent || ''); }

  function isIOS() {
    var u = ua();
    if (/iPad|iPhone|iPod/.test(u)) { return true; }
    return /Macintosh/.test(u) && 'ontouchend' in document;   /* 아이패드 사파리(데스크톱 UA) */
  }

  function isAndroid() { return /Android/i.test(ua()); }

  function isSafari() {
    var u = ua();
    return /Safari/i.test(u) && !/Chrome|CriOS|Edg|OPR|SamsungBrowser/i.test(u);
  }

  function isSecure() {
    return location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  }

  /* ---------- 서비스 워커 등록 ---------- */
  function registerWorker() {
    if (!('serviceWorker' in navigator)) { return; }
    if (!isSecure()) { return; }                       /* file:// · http://localhost 외에는 조용히 넘어감 */

    var started = false;
    function start() {
      if (started) { return; }
      started = true;
      registerOnce();
    }

    /* 이미 등록된 것이 있으면 같은 scope 에 다시 등록하지 않습니다 */
    navigator.serviceWorker.getRegistration('./').then(function (reg) {
      if (reg) {
        started = true;
        try { reg.update(); } catch (e) {}
        return;
      }
      start();
    }).catch(function () { start(); });

    /* 앱 화면 그리기를 방해하지 않도록 load 이후에 시작 */
    if (document.readyState === 'complete') { setTimeout(start, 1200); }
    else { window.addEventListener('load', function () { setTimeout(start, 1200); }); }
  }

  function registerOnce() {
    try {
      navigator.serviceWorker.register('./service-worker.js', { scope: './' }).then(function (reg) {
        window.__pwaRegistration = reg;
        try { reg.update(); } catch (e) {}
      }).catch(function (err) {
        window.__pwaSWError = String(err && err.message ? err.message : err);
      });
    } catch (e) {
      window.__pwaSWError = String(e && e.message ? e.message : e);
    }
  }

  /* ---------- 설치 버튼 위치 ---------- */
  function mountButton() {
    var bar = document.getElementById('admin-lockbar');
    if (!bar) { return false; }
    if (document.getElementById('btn-pwa-install')) { btn = document.getElementById('btn-pwa-install'); return true; }

    btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'btn-pwa-install';
    btn.className = 'btn btn-sm pwa-install-btn';
    btn.title = '핸드폰 홈 화면에 앱처럼 추가하는 방법을 봅니다';
    btn.addEventListener('click', function (ev) {
      if (ev && ev.preventDefault) { ev.preventDefault(); }
      openGuide();
    });

    var lockBtn = document.getElementById('btn-admin-lock');
    if (lockBtn && lockBtn.parentNode === bar) { bar.insertBefore(btn, lockBtn); }
    else { bar.appendChild(btn); }

    refreshButton();
    return true;
  }

  function refreshButton() {
    var b = document.getElementById('btn-pwa-install');
    if (!b) { return; }
    btn = b;
    if (isStandalone()) {
      b.textContent = '📲 앱으로 실행 중';
      b.classList.add('pwa-on');
    } else if (deferredPrompt) {
      b.textContent = '📲 앱으로 설치';
      b.classList.remove('pwa-on');
    } else {
      b.textContent = '📲 홈 화면에 앱 설치';
      b.classList.remove('pwa-on');
    }
  }

  function watchAdminBar() {
    mountButton();
    var tries = 0;
    var timer = setInterval(function () {
      tries += 1;
      if (!document.getElementById('btn-pwa-install')) { mountButton(); }
      if (tries > 60) { clearInterval(timer); }
    }, 500);
    /* 관리자 화면이 다시 그려져 버튼이 사라지면 조용히 다시 붙입니다 */
    if (window.MutationObserver) {
      var mo = new MutationObserver(function () {
        if (!document.getElementById('btn-pwa-install')) { mountButton(); }
      });
      try { mo.observe(document.body, { childList: true, subtree: true }); } catch (e) {}
    }
  }

  /* ---------- 스타일 (앱 색을 그대로 씁니다) ---------- */
  function injectStyle() {
    if (document.getElementById('pwa-install-style')) { return; }
    var css =
      '.pwa-install-btn{white-space:nowrap}' +
      '.pwa-install-btn.pwa-on{background:#12402f;border-color:#1e6b51;color:#9df3d2}' +
      '.pwa-back{position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(13,27,62,.45);z-index:9998;display:flex;' +
      'align-items:center;justify-content:center;padding:16px}' +
      '.pwa-card{background:#fff;border-radius:18px;max-width:430px;width:100%;max-height:88vh;overflow:auto;' +
      'box-shadow:0 20px 50px rgba(13,27,62,.28);padding:20px 20px 16px;color:#111827;' +
      'font-family:"Pretendard","Apple SD Gothic Neo","Malgun Gothic",system-ui,-apple-system,sans-serif}' +
      '.pwa-card h3{margin:0 0 6px;font-size:18px;color:#0d1b3e}' +
      '.pwa-card .pwa-sub{font-size:12.5px;color:#6b7280;line-height:1.5;margin:0 0 14px}' +
      '.pwa-card ol{margin:0 0 12px;padding-left:20px;font-size:14px;line-height:1.75}' +
      '.pwa-card ol li{margin-bottom:2px}' +
      '.pwa-card b{color:#0d1b3e}' +
      '.pwa-note{background:#f2f4f9;border-radius:12px;padding:10px 12px;font-size:12.5px;' +
      'color:#374151;line-height:1.6;margin:0 0 12px}' +
      '.pwa-tabs{display:flex;gap:6px;margin:0 0 12px}' +
      '.pwa-tab{flex:1;border:1px solid #e5e8ef;background:#fff;border-radius:11px;padding:8px 6px;' +
      'font-size:13px;cursor:pointer;color:#374151}' +
      '.pwa-tab.on{background:#0d1b3e;border-color:#0d1b3e;color:#fff}' +
      '.pwa-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:6px}' +
      '.pwa-btn{border:1px solid #e5e8ef;background:#fff;border-radius:12px;padding:10px 14px;font-size:14px;' +
      'cursor:pointer;color:#111827}' +
      '.pwa-btn.primary{background:#0d1b3e;border-color:#0d1b3e;color:#fff;font-weight:600}' +
      '.pwa-btn.mint{background:#12b886;border-color:#12b886;color:#fff;font-weight:600}' +
      '.pwa-toast{position:fixed;left:50%;transform:translateX(-50%);bottom:26px;background:#0d1b3e;' +
      'color:#fff;padding:11px 16px;border-radius:14px;font-size:13.5px;z-index:9999;' +
      'box-shadow:0 10px 26px rgba(13,27,62,.3);opacity:0;transition:opacity .2s}' +
      '.pwa-toast.show{opacity:1}' +
      '@media (max-width:520px){.pwa-card{border-radius:16px}}';
    var st = document.createElement('style');
    st.id = 'pwa-install-style';
    st.textContent = css;
    document.head.appendChild(st);
  }

  /* ---------- 안내 모달 ---------- */
  var platform = 'android';

  function stepsHtml(p) {
    if (p === 'ios' || (p === 'safari' && isIOS())) {
      return '<ol>' +
        '<li>아이폰 <b>사파리</b>로 이 주소를 열어 주세요.</li>' +
        '<li>아래쪽 <b>공유 버튼(□↑)</b>을 누릅니다.</li>' +
        '<li>목록에서 <b>「홈 화면에 추가」</b>를 누릅니다.</li>' +
        '<li>오른쪽 위 <b>「추가」</b> → 홈 화면에 <b>MTA태권도</b> 아이콘이 생깁니다.</li>' +
        '</ol>' +
        '<div class="pwa-note">아이폰은 크롬·네이버앱이 아니라 <b>사파리</b>에서 열어야 홈 화면에 추가할 수 있어요.</div>';
    }
    if (p === 'desktop') {
      return '<ol>' +
        '<li>크롬으로 이 주소를 열어 주세요.</li>' +
        '<li>주소창 오른쪽의 <b>설치 아이콘(⊕ 모양)</b>을 누릅니다.</li>' +
        '<li><b>「설치」</b>를 누르면 바탕화면·시작메뉴에 앱이 생깁니다.</li>' +
        '</ol>' +
        '<div class="pwa-note">설치 아이콘이 안 보이면 주소창 오른쪽 <b>⋮ → 저장 및 공유 → 바로가기 만들기</b>를 쓰셔도 됩니다.</div>';
    }
    return '<ol>' +
      '<li>핸드폰 <b>크롬</b>으로 이 주소를 열어 주세요.</li>' +
      '<li>오른쪽 위 <b>⋮</b>을 누릅니다.</li>' +
      '<li><b>「앱 설치」</b> 또는 <b>「홈 화면에 추가」</b>를 누릅니다.</li>' +
      '<li><b>「설치」</b>를 누르면 홈 화면에 <b>MTA태권도</b> 아이콘이 생깁니다.</li>' +
      '</ol>' +
      '<div class="pwa-note">한 번 설치하면 주소를 칠 필요 없이 아이콘만 누르면 앱처럼 전체 화면으로 열립니다.</div>';
  }

  function openGuide() {
    closeGuide();
    injectStyle();

    var html =
      '<div class="pwa-back" id="pwa-back">' +
        '<div class="pwa-card" role="dialog" aria-modal="true" aria-labelledby="pwa-title">' +
          '<h3 id="pwa-title">📲 홈 화면에 앱으로 설치</h3>' +
          '<p class="pwa-sub">주소를 매번 치지 않고, 홈 화면 아이콘만 눌러 앱처럼 열 수 있어요. (설치비·앱스토어 없이 무료)</p>' +
          '<div class="pwa-tabs">' +
            '<button type="button" class="pwa-tab" data-p="android">🤖 안드로이드</button>' +
            '<button type="button" class="pwa-tab" data-p="ios">🍎 아이폰</button>' +
            '<button type="button" class="pwa-tab" data-p="desktop">💻 컴퓨터</button>' +
          '</div>' +
          '<div id="pwa-steps"></div>' +
          '<div class="pwa-actions">' +
            (deferredPrompt ? '<button type="button" class="pwa-btn mint" id="pwa-do-install">지금 설치하기</button>' : '') +
            '<button type="button" class="pwa-btn" id="pwa-close">닫기</button>' +
          '</div>' +
        '</div>' +
      '</div>';

    var host = document.createElement('div');
    host.innerHTML = html;
    document.body.appendChild(host);

    var steps = document.getElementById('pwa-steps');
    var tabs = document.querySelectorAll('.pwa-tab');

    function paint(p) {
      platform = p;
      steps.innerHTML = stepsHtml(p);
      for (var i = 0; i < tabs.length; i++) {
        tabs[i].classList.toggle('on', tabs[i].getAttribute('data-p') === p);
      }
    }
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].addEventListener('click', function (ev) {
        paint(ev.currentTarget.getAttribute('data-p'));
      });
    }

    var start = isIOS() ? 'ios' : (isAndroid() ? 'android' : 'desktop');
    paint(start);

    document.getElementById('pwa-close').addEventListener('click', closeGuide);
    document.getElementById('pwa-back').addEventListener('click', function (ev) {
      if (ev.target === ev.currentTarget) { closeGuide(); }
    });

    var doInstall = document.getElementById('pwa-do-install');
    if (doInstall) {
      doInstall.addEventListener('click', function () {
        if (!deferredPrompt) { return; }
        var p = deferredPrompt;
        deferredPrompt = null;
        closeGuide();
        try {
          p.prompt();
          if (p.userChoice && p.userChoice.then) {
            p.userChoice.then(function (choice) {
              if (choice && choice.outcome === 'accepted') { toast('설치를 시작했어요. 홈 화면을 확인해 보세요!'); }
              refreshButton();
            });
          }
        } catch (e) {}
      });
    }

    document.addEventListener('keydown', onEsc, true);
  }

  function onEsc(ev) {
    if (ev.key === 'Escape' || ev.keyCode === 27) { closeGuide(); }
  }

  function closeGuide() {
    var back = document.getElementById('pwa-back');
    if (back && back.parentNode) { back.parentNode.removeChild(back); }
    document.removeEventListener('keydown', onEsc, true);
  }

  function toast(msg) {
    injectStyle();
    var t = document.createElement('div');
    t.className = 'pwa-toast';
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(function () { t.classList.add('show'); }, 30);
    setTimeout(function () {
      t.classList.remove('show');
      setTimeout(function () { if (t.parentNode) { t.parentNode.removeChild(t); } }, 300);
    }, 3200);
  }

  /* ---------- 설치 이벤트 ---------- */
  window.addEventListener('beforeinstallprompt', function (ev) {
    ev.preventDefault();
    deferredPrompt = ev;
    refreshButton();
  });

  window.addEventListener('appinstalled', function () {
    deferredPrompt = null;
    installCheckedAt = Date.now();
    refreshButton();
    toast('홈 화면에 추가됐어요. 이제 아이콘으로 바로 열 수 있습니다!');
  });

  /* ---------- 시작 ---------- */
  function boot() {
    if (!isSecure()) { return; }        /* 파일로 열었을 때는 아무 것도 하지 않음 */
    injectStyle();
    watchAdminBar();
    registerWorker();
    refreshButton();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  /* 테스트·안내용 */
  window.MTA_PWA = {
    isStandalone: isStandalone,
    isIOS: isIOS,
    isAndroid: isAndroid,
    hasPrompt: function () { return !!deferredPrompt; },
    open: openGuide,
    state: function () {
      return {
        standalone: isStandalone(),
        secure: isSecure(),
        prompt: !!deferredPrompt,
        button: !!(document.getElementById('btn-pwa-install')),
        swError: window.__pwaSWError || null,
        checked: installCheckedAt
      };
    }
  };
})();
