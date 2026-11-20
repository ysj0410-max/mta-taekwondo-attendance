# -*- coding: utf-8 -*-
"""index.html <head> 에 PWA 태그를 넣는 패치 스크립트 (몇 번을 실행해도 안전).

- <meta name="theme-color"> 바로 뒤에 매니페스트·아이콘·iOS 메타·설치 도우미 스크립트를 넣습니다.
- 이미 들어 있으면 아무 것도 하지 않습니다(동시 작업 합치기 대비).
- 앱 본체 코드(인라인 <script>)는 한 줄도 건드리지 않습니다.
"""
import sys

PATH = sys.argv[1] if len(sys.argv) > 1 else 'taekwondo-attendance/index.html'
ANCHOR = '<meta name="theme-color" content="#0d1b3e">\n'

BLOCK = (
    '<!-- 📲 홈 화면 앱(PWA): 매니페스트 · 아이콘 · 설치 도우미 -->\n'
    '<link rel="manifest" href="manifest.webmanifest">\n'
    '<link rel="icon" type="image/png" sizes="32x32" href="icons/favicon-32.png">\n'
    '<link rel="icon" type="image/png" sizes="192x192" href="icons/icon-192.png">\n'
    '<link rel="apple-touch-icon" sizes="180x180" href="icons/apple-touch-icon.png">\n'
    '<meta name="mobile-web-app-capable" content="yes">\n'
    '<meta name="apple-mobile-web-app-capable" content="yes">\n'
    '<meta name="apple-mobile-web-app-title" content="MTA태권도">\n'
    '<meta name="application-name" content="MTA태권도">\n'
    '<script defer src="pwa-install.js"></script>\n'
)

html = open(PATH, encoding='utf-8').read()

if 'rel="manifest"' in html:
    print('이미 PWA 태그가 있습니다 — 변경 없음:', PATH)
    sys.exit(0)

if ANCHOR not in html:
    print('앵커(theme-color 메타)를 찾지 못했습니다:', PATH)
    sys.exit(1)

html = html.replace(ANCHOR, ANCHOR + BLOCK, 1)
open(PATH, 'w', encoding='utf-8').write(html)
print('PWA 태그 삽입 완료:', PATH)
