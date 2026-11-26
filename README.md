# sts2-run-analytics

Node.js 24에서 프로젝트 폴더를 열고 `npm.cmd ci`로 의존성을 설치한 뒤 `node server.js`를 실행합니다.
[http://127.0.0.1:3000](http://127.0.0.1:3000)에서 `.run` 파일을 한 개 이상 선택합니다.
싱글은 ID 없이, 멀티는 숫자 플레이어 ID로 본인 기록을 가져옵니다.
파일 한 개의 크기 제한은 16 MiB입니다.

기록은 `data/runs.sqlite`에 저장됩니다. `SPIRE_DB_PATH`로 DB 위치를 바꿀 수 있습니다.
기록 목록과 상세의 캐릭터·카드·유물·패배 원인 이름은 서버 시작 시 읽은 `data/spire-codex-kor`의 한국어 JSON에서 먼저 찾습니다.
[Spire Codex 개발자 페이지](https://spire-codex.com/kor/developers)의 한국어 ZIP을 해당 폴더에 풀고 서버를 다시 시작하면 새 목록을 읽습니다.
로컬 목록에 없는 이름은 Spire Codex 한국어 API에서 찾아 종류별로 캐시하며, 정식 데이터의 이름을 우선합니다.
API 연결이 끊기면 직전에 받은 목록을 사용하고, 이름이 없는 항목은 기록의 원본 식별자를 표시합니다.
.run 파일과 플레이어 ID는 로컬 서버에서 처리합니다.
슬더스2 게임 기록 분석 프로그램
## Turso 연결 확인

`TURSO_DATABASE_URL`과 `TURSO_AUTH_TOKEN`을 서버에 함께 설정하면 Turso를 사용합니다. 두 값이 없으면 기본적으로 로컬 `data/runs.sqlite`를 사용합니다. 빈 Turso DB에는 서버가 현재 스키마를 생성하며, 기존 로컬 기록을 자동으로 전송하지 않습니다.

Windows에서 저장소 루트의 `.env`에 두 값을 넣고 `node --env-file=.env server.js`를 실행합니다. 토큰은 서버 환경 변수로만 관리합니다. 브라우저에서 `http://127.0.0.1:3000`을 열어 테스트 파일을 가져오고, 동일 파일의 중복 처리와 상세 조회, 삭제를 확인할 수 있습니다.

## Render 배포

GitHub 저장소를 Render Web Service에 연결하고 Runtime은 Node, Build Command는 `npm ci`, Start Command는 `node server.js`, Health Check Path는 `/healthz`로 설정합니다. 무료 인스턴스를 선택할 수 있습니다.

| 환경 변수 | 값 |
| --- | --- |
| `NODE_VERSION` | `24.22.3` |
| `TURSO_DATABASE_URL` | Turso DB URL |
| `TURSO_AUTH_TOKEN` | Turso DB 읽기·쓰기 토큰 |
| `SPIRE_AUTH_USER` | 브라우저 로그인에 쓸 사용자 이름 |
| `SPIRE_AUTH_PASSWORD` | 브라우저 로그인에 쓸 24자 이상의 무작위 비밀번호 |

Render가 제공하는 `RENDER_EXTERNAL_URL`과 `PORT`를 사용합니다. 커스텀 도메인으로 접속하려면 `SPIRE_PUBLIC_ORIGIN`에 해당 HTTPS 주소를 설정합니다. 브라우저에서 배포 주소를 열면 HTTP Basic 인증 창이 뜹니다. 화면과 기록 API에 동일한 인증이 적용되며 `/healthz`는 상태 코드만 반환합니다.

비밀번호는 `node -e "console.log(require('node:crypto').randomBytes(24).toString('base64url'))"`로 생성할 수 있습니다. 로컬에서 인증을 확인하려면 두 `SPIRE_AUTH_*` 값을 `.env`에 추가하고 서버를 재시작합니다.
