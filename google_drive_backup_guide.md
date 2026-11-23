# ☁️ 경희대MTA태권도 · 구글 드라이브 자동 백업 안내

도장 앱(`index.html`)의 데이터를 **유수정 님의 구글 드라이브**(`ysj0410@gmail.com`)에 자동으로 백업하고, 태블릿·도장폰·PC에서 이어 쓸 수 있게 하는 방법입니다.
처음 **한 번만 2분** 설정하면, 그 뒤로는 앱이 알아서 백업합니다.

## 1. 백업이 저장되는 곳

| 항목 | 값 |
| --- | --- |
| 드라이브 계정 | ysj0410@gmail.com |
| 폴더 이름 | **경희대MTA태권도 백업** (이번 작업을 위해 새로 만든 전용 폴더) |
| 폴더 ID | `1QzMPKIgcdQ7MoYamS5ziDBzUB7IcD03f` |
| 폴더 링크 | https://drive.google.com/drive/folders/1QzMPKIgcdQ7MoYamS5ziDBzUB7IcD03f |
| 최신 백업 파일 | `mta-taekwondo-backup-latest.json` |
| 날짜별 사본 | `mta-taekwondo-backup-2026-11-20-2130.json` (백업할 때마다 한 개씩) |

> 이 폴더 **안에만** 백업이 쌓입니다. 드라이브의 다른 파일은 읽지도, 건드리지도 않습니다.

## 2. 설정 4단계 (약 2분)

준비물: 구글에 로그인된 크롬/사파리 창 하나.

### 1) Apps Script 새 프로젝트 열기
1. 주소창에 **script.google.com** 을 입력하고 엽니다.
2. 왼쪽 위 **새 프로젝트**를 누릅니다.

### 2) 코드 붙여넣고 저장
1. 앱에서 **관리자 → ☁️ 구글 드라이브 자동 백업 · 동기화 → 📋 Apps Script 코드 보기/복사** 를 누릅니다.
2. **📋 코드 복사** 를 누릅니다.
3. script.google.com 편집기에서 `function myFunction() { ... }` 부분을 **모두 지우고** 붙여넣습니다(Ctrl+V / ⌘+V).
4. **💾 저장**(Ctrl+S / ⌘+S)을 누릅니다.

### 3) 웹 앱으로 배포
1. 오른쪽 위 **배포 → 새 배포** 를 누릅니다.
2. 왼쪽 톱니바퀴(유형 선택)에서 **웹 앱** 을 고릅니다.
3. 설정을 이렇게 맞춥니다.
   - **설명**: `도장 백업` (아무 말이나 괜찮습니다)
   - **실행할 사용자**: **나(ysj0410@gmail.com)**
   - **액세스 권한**: **모든 사용자** ← 이게 아니면 태블릿에서 백업이 안 됩니다
4. **배포** 를 누르고, 처음 나오는 **액세스 승인**(권한 검토 → 계정 선택 → 고급 → 이동 → 허용)을 한 번 통과합니다.
5. **웹 앱 URL**(`https://script.google.com/macros/s/…/exec`)을 **복사**합니다.

### 4) 앱에 주소 붙여넣고 확인
1. 도장 앱 → **관리자 → ☁️ 구글 드라이브 자동 백업 · 동기화** 의 **Apps Script 웹 앱 URL** 칸에 붙여넣습니다.
2. **URL 저장** → **☁️ 지금 드라이브에 백업** 을 누릅니다.
3. 상태칩이 **연동됨** 으로 바뀌고, **마지막 드라이브 백업** 시각이 나오면 성공입니다.
4. 드라이브의 **경희대MTA태권도 백업** 폴더를 열어 `mta-taekwondo-backup-latest.json` 이 보이는지 확인합니다.

## 3. 이렇게 동작합니다

| 기능 | 동작 |
| --- | --- |
| ☁️ 지금 드라이브에 백업 | 지금 데이터 전체(관원·얼굴 특징값·출석 이력·원비·문자 템플릿·설정)를 `-latest.json` 으로 저장하고, 같은 시각의 날짜별 사본도 남깁니다. |
| 📥 드라이브에서 불러오기 | 드라이브의 최신 백업을 받아 **확인 모달**을 띄운 뒤, 확인을 누르면 이 기기 데이터를 그 내용으로 바꿉니다. 새 도장폰·PC에서 이어 쓰기용. |
| 매일 자동 백업 | 켜 두면 **하루 한 번** 앱을 열 때, 그리고 **출석·원비·명단이 바뀐 뒤 2분** 안에 최신 상태를 조용히 올립니다(연속 변경은 하나로 묶음). |
| 앱 열 때 자동 동기화 | **기본 켜짐.** 앱을 열면 드라이브 최신 백업과 이 기기를 자동으로 맞춥니다 — 드라이브가 더 최신이면 **확인 없이 자동 적용**, 이 기기가 더 최신이면 **드라이브로 자동 백업**. 기기가 비어 있으면(예시 관원만 있거나 관원·출석이 없으면) 드라이브 백업을 그대로 받아오고, 빈 데이터로 드라이브 백업을 덮어쓰지 않습니다. 인터넷이 없으면 아무것도 바꾸지 않고 다음에 열 때 다시 확인합니다. |
| 최신 백업 시각 | 패널 아래에 "마지막 드라이브 백업: 2026년 11월 20일 (금) 오후 9:30" 처럼 표시됩니다. 그 아래에 **이 기기 마지막 수정** 시각도 함께 보입니다. |

- 백업 파일에는 **관리자 계정 해시**도 들어 있어, 드라이브 백업으로 복원하면 관리자 아이디·비밀번호도 함께 되살아납니다.
- 복원 파일에 드라이브 주소가 없으면 **이 기기의 연동 주소는 지우지 않습니다**. 새 기기에서 주소가 들어 있는 백업을 복원하면 그 주소가 그대로 따라옵니다.

## 4. 꼭 지켜 주세요 (보안)

- 웹 앱 URL은 **관장님 드라이브에만 연결되는 긴 비밀 주소**입니다. 주소를 아는 사람은 백업을 읽을 수 있으니, 메신저·게시판에 그대로 붙여넣거나 화면을 공유하지 마세요.
- 주소가 새어 나간 것 같으면 script.google.com → **배포 관리 → 보관처리(아카이브)** 후 새로 배포해 새 주소를 앱에 넣으면 됩니다.
- 더 단단하게 잠그고 싶으면 `Code.gs` 의 `var TOKEN = '';` 에 비밀 문자열을 넣고, 앱의 주소 뒤에 `&token=그문자열` 을 붙여 저장하세요. (앱은 주소를 그대로 호출하므로 `?` 가 이미 있으면 `&token=…` 형태로 붙입니다.)

## 5. 잘 안 될 때

| 증상 | 확인 |
| --- | --- |
| "웹 앱이 HTML을 돌려줬어요" | 배포 액세스가 **모든 사용자** 인지 확인하고, 바꿨으면 **새 배포**로 다시 만들어 URL을 새로 넣으세요. |
| "URL과 인터넷 연결을 확인하세요" | 주소 끝이 `/exec` 인지, 태블릿 인터넷이 되는지 확인하세요. |
| "아직 백업이 없습니다" | 먼저 **☁️ 지금 드라이브에 백업** 을 한 번 누르세요. |
| 폴더가 안 보여요 | 드라이브에서 `경희대MTA태권도 백업` 을 검색하거나 위 폴더 링크를 누르세요. |
| 백업은 되는데 복원이 안 돼요 | 앱 화면의 4단계로 만든 **그 웹 앱** 주소인지 확인하세요(다른 프로젝트 주소면 다른 폴더를 봅니다). |

## 6. Code.gs (그대로 붙여넣는 코드)

앱의 **📋 코드 복사** 버튼과 같은 내용입니다. 폴더 ID가 코드에 고정되어 있어, 이 코드는 **위의 전용 폴더에만** 백업을 씁니다.

```javascript
/**
 * 경희대MTA태권도 · 구글 드라이브 자동 백업 (Google Apps Script)
 * 이 코드를 script.google.com 새 프로젝트에 붙여넣고 웹 앱으로 배포하면
 * 아래 백업 폴더에 mta-taekwondo-backup-latest.json 과 날짜별 사본이 쌓입니다.
 */

// 이번에 앱을 위해 새로 만든 전용 폴더 (기존 드라이브 파일은 건드리지 않습니다)
var FOLDER_ID = '1QzMPKIgcdQ7MoYamS5ziDBzUB7IcD03f';
var FOLDER_NAME = '경희대MTA태권도 백업';
var LATEST_NAME = 'mta-taekwondo-backup-latest.json';
var DAILY_PREFIX = 'mta-taekwondo-backup-';
var TOKEN = ''; // 선택: 앱의 주소 뒤에 &token=... 을 붙여 쓰려면 같은 값을 여기에 넣으세요

function backupFolder_() {
  if (FOLDER_ID) { return DriveApp.getFolderById(FOLDER_ID); }
  var it = DriveApp.getFoldersByName(FOLDER_NAME);
  if (it.hasNext()) { return it.next(); }
  return DriveApp.createFolder(FOLDER_NAME);
}

function findFile_(folder, name) {
  var it = folder.getFilesByName(name);
  return it.hasNext() ? it.next() : null;
}

function upsertFile_(folder, name, text) {
  var file = findFile_(folder, name);
  if (file) { file.setContent(text); return file; }
  return folder.createFile(name, text, MimeType.PLAIN_TEXT);
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function tokenOk_(e) {
  if (!TOKEN) { return true; }
  var t = (e && e.parameter && e.parameter.token) || '';
  return String(t) === TOKEN;
}

function doPost(e) {
  try {
    var body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (!tokenOk_(e) && !tokenOk_({ parameter: body })) {
      return json_({ ok: false, error: '토큰이 맞지 않습니다.' });
    }
    var data = body.data || body.backup || body;
    if (!data || !data.students || !data.students.length) {
      return json_({ ok: false, error: '관원 명단이 없는 백업은 저장하지 않습니다.' });
    }
    var folder = backupFolder_();
    var text = JSON.stringify(data, null, 2);
    var latest = upsertFile_(folder, LATEST_NAME, text);
    var stamp = Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd-HHmm');
    var dailyName = DAILY_PREFIX + stamp + '.json';
    upsertFile_(folder, dailyName, text);
    return json_({
      ok: true,
      fileId: latest.getId(),
      url: latest.getUrl(),
      savedAt: new Date().toISOString(),
      daily: dailyName,
      students: data.students.length
    });
  } catch (err) {
    return json_({ ok: false, error: String((err && err.message) || err) });
  }
}

function doGet(e) {
  try {
    if (!tokenOk_(e)) { return json_({ ok: false, error: '토큰이 맞지 않습니다.' }); }
    var action = (e && e.parameter && e.parameter.action) || 'latest';
    var folder = backupFolder_();
    if (action === 'list') {
      var files = folder.getFiles();
      var out = [];
      while (files.hasNext() && out.length < 60) {
        var f = files.next();
        if (f.getName().indexOf(DAILY_PREFIX) === 0) {
          out.push({ name: f.getName(), updated: f.getLastUpdated().toISOString() });
        }
      }
      return json_({ ok: true, files: out });
    }
    var latest = findFile_(folder, LATEST_NAME);
    if (!latest) { return json_({ ok: false, error: '아직 백업이 없습니다. 먼저 「지금 드라이브에 백업」을 눌러 주세요.' }); }
    var data = JSON.parse(latest.getBlob().getDataAsString('utf-8'));
    return json_({
      ok: true,
      fileId: latest.getId(),
      modifiedTime: latest.getLastUpdated().toISOString(),
      data: data
    });
  } catch (err) {
    return json_({ ok: false, error: String((err && err.message) || err) });
  }
}

// 설정 확인용: 편집기에서 이 함수를 한 번 실행해 보세요.
function testBackupFolder() {
  var f = backupFolder_();
  Logger.log(f.getName() + ' · ' + f.getId() + ' · ' + f.getUrl());
}
```
