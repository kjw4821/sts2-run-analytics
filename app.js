const form = document.querySelector('#run-form');
const playerIdInput = document.querySelector('#player-id');
const fileInput = document.querySelector('#run-file');
const summary = document.querySelector('#summary');
const status = document.querySelector('#status');
const character = document.querySelector('#player-character');

let latestRequest = 0;

const resultLabels = { win: '승리', loss: '패배', abandoned: '중단', unknown: '확인 불가' };

fileInput.addEventListener('change', () => {
  latestRequest += 1;
  summary.hidden = true;
  character.textContent = '';
  status.textContent = '';
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const request = ++latestRequest;
  summary.hidden = true;
  character.textContent = '';
  status.textContent = '';

  const playerId = playerIdInput.value.trim();
  const file = fileInput.files[0];
  if (!file || !/\.run$/i.test(file.name)) {
    status.textContent = '.run 파일을 선택해 주세요.';
    fileInput.focus();
    return;
  }

  let run;
  try {
    run = parseRun(await file.text());
  } catch {
    if (request === latestRequest) {
      status.textContent = '기록 파일을 읽을 수 없습니다. JSON 형식을 확인해 주세요.';
    }
    return;
  }

  if (request !== latestRequest) return;

  if (!Array.isArray(run?.players) || run.players.length === 0) {
    status.textContent = '기록에서 참가자 목록을 찾을 수 없습니다.';
    return;
  }

  const playerCount = run.players.length;
  document.querySelector('#run-mode').textContent = playerCount === 1 ? '싱글' : '멀티';
  document.querySelector('#player-count').textContent = playerCount + '명';
  document.querySelector('#run-ascension').textContent =
    Number.isSafeInteger(run.ascension) && run.ascension >= 0
      ? String(run.ascension)
      : '확인 불가';
  document.querySelector('#run-result').textContent = resultLabels[getRunResult(run)];
  document.querySelector('#selected-file').textContent = file.name;
  character.textContent = '—';
  summary.hidden = false;

  let player = run.players[0];
  if (playerCount > 1) {
    if (!playerId) {
      status.textContent = '멀티 기록에서 내 참가자를 찾으려면 플레이어 ID를 입력해 주세요.';
      playerIdInput.focus();
      return;
    }

    player = run.players.find((entry) => entry?.id === playerId);
    if (!player) {
      const hasUnreadableId = run.players.some((entry) => typeof entry?.id === 'number');
      status.textContent = hasUnreadableId
        ? '이 브라우저에서는 긴 플레이어 ID를 정확히 읽을 수 없습니다. 최신 Chrome에서 다시 시도해 주세요.'
        : '입력한 플레이어 ID와 일치하는 참가자가 없습니다.';
      return;
    }
  }

  if (typeof player?.character !== 'string' || !player.character.trim()) {
    status.textContent = '참가자 기록에서 캐릭터 정보를 찾을 수 없습니다.';
    return;
  }

  try {
    const record = extractRun(run, player);
    character.textContent = record.characterId.replace(/^CHARACTER\./, '');
  } catch (error) {
    status.textContent = error.message;
  }
});
