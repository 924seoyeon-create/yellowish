# 🔥 노릇노릇

> 해야 할 일을 관리하는 앱이 아니라, 해야 할 일을 지금 하게 만드는 앱.

서버 없이 동작하는 정적 PWA입니다. Todo 목록 대신 지금 해야 할 **하나의 행동**을 보여주고,
🔥 불이 발등에 가까워지는 긴급도 시각화와 🔔 신내림(FOCUS BURST)으로 실제 시작을 돕습니다.

## 실행 방법

별도 빌드 과정이 없습니다. 정적 파일을 아무 방식으로든 서빙하면 됩니다.

```bash
npx http-server . -p 8099
# 또는
python -m http.server 8099
```

그다음 `http://localhost:8099` 접속. (`file://`로 직접 열어도 대부분 기능은 동작하지만,
Service Worker 등록은 http/https 컨텍스트에서만 됩니다.)

## 프로젝트 구조

```text
index.html      화면 마크업 (홈 / 오늘 / 작업추가 / 상세 / 신내림 / 타이머 / 종료 / 패턴)
style.css       전체 스타일
app.js          상태 관리, localStorage 저장, 화면 전환, 타이머 로직
manifest.json   PWA 매니페스트
sw.js           앱 shell 캐싱 Service Worker
icons/          PWA 아이콘 (192px, 512px)
```

데이터는 모두 브라우저 `localStorage`에 저장됩니다 (`tasks`, `focus_sessions`). 새로고침하거나
앱을 다시 열어도 유지되며, 별도 서버나 계정이 필요 없습니다.

## 배포

정적 파일만으로 구성되어 있어 GitHub Pages, Netlify, Vercel, Cloudflare Pages 등
어디에든 그대로 올리면 동작합니다. 루트 디렉터리를 통째로 배포하세요.

### GitHub Pages

이 저장소에는 `.github/workflows/pages.yml`이 이미 포함되어 있어서, `main` 브랜치에
푸시만 하면 자동으로 GitHub Pages에 배포됩니다.

1. GitHub에서 새 저장소를 만듭니다 (Public/Private 무관, README 등 초기 파일 없이 빈 저장소로).
2. 이 로컬 저장소에 원격을 연결하고 푸시합니다.
   ```bash
   git remote add origin https://github.com/<사용자명>/<저장소명>.git
   git push -u origin main
   ```
3. GitHub 저장소 페이지에서 **Settings → Pages**로 이동해 **Source**를 **GitHub Actions**로 설정합니다.
   (한 번만 설정하면 이후 `main`에 푸시할 때마다 자동 배포됩니다.)
4. 잠시 후 **Settings → Pages** 상단에 표시되는 `https://<사용자명>.github.io/<저장소명>/` 주소로 접속하면 됩니다.

모든 리소스 경로가 상대경로(`./style.css`, `./app.js` 등)로 되어 있어서, 저장소 이름이 붙는
하위 경로(`/<저장소명>/`)에 배포되어도 그대로 동작합니다.

## PWA로 설치하기 (Microsoft Edge / Windows)

1. Edge에서 배포된 주소(또는 로컬 서버 주소)로 접속합니다.
2. 주소창 오른쪽의 **앱 설치** 아이콘(⊕ 모양)을 클릭합니다. 안 보이면 우측 상단
   `···` 메뉴 → **앱** → **이 사이트를 앱으로 설치**를 선택합니다.
3. 설치 대화상자에서 **설치**를 누릅니다.
4. 설치가 끝나면 노릇노릇이 독립된 창(Windows 앱)으로 실행됩니다.
5. 앱 창 우측 상단 `···` 메뉴 → **기타 도구** → **바탕화면에 바로가기 만들기**를 선택하면
   바탕화면에서 바로 실행할 수 있는 바로가기가 생성됩니다.

이후에는 시작 메뉴 또는 바탕화면 바로가기로 브라우저 주소창 없이 독립 앱처럼 실행됩니다.

## 핵심 행동 루프

```text
🪵 (홈) → 🦶🔥 (오늘) → 🔥 지금 시작 → 🔔 FOCUS BURST → 실제 작업 → 기록 → 📊 패턴
```
