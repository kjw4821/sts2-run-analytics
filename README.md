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
