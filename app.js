const form = document.querySelector('#run-form');
const playerIdInput = document.querySelector('#player-id');
const fileInput = document.querySelector('#run-file');
const importStatus = document.querySelector('#status');
const importResults = document.querySelector('#import-results');
const filters = document.querySelector('#filters');
const characterFilter = document.querySelector('#character-filter');
const records = document.querySelector('#records');
const recordsStatus = document.querySelector('#records-status');
const detail = document.querySelector('#detail');
const detailTitle = document.querySelector('#detail-title');
const detailContent = document.querySelector('#detail-content');
const deleteButton = document.querySelector('#delete-run');

const resultLabels = { win: '승리', loss: '패배', abandoned: '중단', unknown: '확인 불가' };
const modeLabels = { single: '싱글', multi: '멀티' };
const gameModeLabels = new Map([
  ['standard', '일반'],
  ['daily', '일일 도전'],
  ['custom', '커스텀'],
  ['blitz', '블리츠'],
  ['dread', '드레드'],
]);
const placeLabels = new Map([
  ['monster', '일반 전투'],
  ['elite', '엘리트 전투'],
  ['boss', '보스 전투'],
  ['shop', '상점'],
  ['treasure', '보물'],
  ['rest_site', '휴식 장소'],
  ['event', '이벤트'],
  ['ancient', '고대의 존재'],
  ['unknown', '미지의 방'],
]);
const playerIdKey = 'spire-analytics.player-id';
let listRequest = 0;
let detailRequest = 0;
let activeRun = null;

try {
  playerIdInput.value = localStorage.getItem(playerIdKey) || '';
} catch {
  // The current import can still use the typed ID.
}

function displayId(value) {
  return value || '확인 불가';
}

function element(tag, text) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  return node;
}

function action(label, handler) {
  const button = element('button', label);
  button.type = 'button';
  button.className = 'secondary';
  button.addEventListener('click', handler);
  return button;
}

async function api(path, options) {
  const response = await fetch(path, options);
  if (response.status === 204) return null;
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.message || '요청을 처리하지 못했습니다.');
  return payload;
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const files = Array.from(fileInput.files);
  if (!files.length) return;
  const playerId = playerIdInput.value.trim();
  const submit = form.querySelector('button');
  for (const control of [fileInput, playerIdInput, submit]) control.disabled = true;
  importResults.replaceChildren();
  importResults.hidden = false;
  const totals = { imported: 0, duplicate: 0, failed: 0 };
  try {
    for (const [index, file] of files.entries()) {
      importStatus.textContent = `${index + 1}/${files.length} 파일 처리 중…`;
      const row = element('li');
      try {
        if (!/\.run$/i.test(file.name)) throw new Error('.run 파일을 선택해 주세요.');
        const headers = { 'Content-Type': 'application/octet-stream' };
        if (/^\d+$/.test(playerId)) headers['X-Player-Id'] = playerId;
        const query = new URLSearchParams({ filename: file.name });
        const result = await api(`/api/import?${query}`, { method: 'POST', headers, body: file });
        totals[result.status] += 1;
        const label = result.status === 'imported' ? '저장 완료' : '이미 저장된 파일';
        row.append(element('span', `${file.name} · ${label}`),
          action('기록 보기', () => showDetail(result.runId)));
        if (result.status === 'imported' && result.playMode === 'multi') {
          try {
            localStorage.setItem(playerIdKey, playerId);
          } catch {
            // Storage may be unavailable in this browser.
          }
        }
      } catch (error) {
        totals.failed += 1;
        row.append(element('span', `${file.name} · 실패 (${error.message})`));
      }
      importResults.append(row);
    }
    importStatus.textContent = `저장 ${totals.imported}개 · 중복 ${totals.duplicate}개 · 실패 ${totals.failed}개`;
    await loadRecords();
  } finally {
    for (const control of [fileInput, playerIdInput, submit]) control.disabled = false;
  }
});

async function loadRecords() {
  const request = ++listRequest;
  recordsStatus.textContent = '기록을 불러오는 중…';
  records.replaceChildren();
  try {
    const query = new URLSearchParams(new FormData(filters));
    const { runs, characters, characterNames = {} } = await api(`/api/runs?${query}`);
    if (request !== listRequest) return;
    const characterName = (id) => Object.hasOwn(characterNames, id) ? characterNames[id] : displayId(id);
    const selected = characterFilter.value;
    characterFilter.replaceChildren(new Option('전체', ''),
      ...characters.map((id) => new Option(characterName(id), id)));
    if (selected && !characters.includes(selected)) {
      characterFilter.append(new Option(characterName(selected), selected));
    }
    characterFilter.value = selected;
    for (const run of runs) {
      const row = element('li');
      const level = run.ascension === null ? '승천 확인 불가' : `승천 ${run.ascension}`;
      const title = [characterName(run.character_id), modeLabels[run.play_mode], level, resultLabels[run.result]].join(' · ');
      row.append(action(title, () => showDetail(run.run_id)));
      records.append(row);
    }
    recordsStatus.textContent = runs.length ? `${runs.length}건` : '조건에 맞는 저장 기록이 없습니다.';
  } catch (error) {
    if (request === listRequest) recordsStatus.textContent = error.message;
  }
}

filters.addEventListener('submit', (event) => {
  event.preventDefault();
  loadRecords();
});
filters.addEventListener('reset', () => setTimeout(loadRecords, 0));

function detailList(title, items) {
  const section = element('details');
  const list = element('ol');
  for (const item of items) list.append(element('li', item));
  section.append(element('summary', `${title} · ${items.length}건`),
    items.length ? list : element('p', '확인 가능한 기록이 없습니다.'));
  return section;
}

async function showDetail(id) {
  const request = ++detailRequest;
  activeRun = null;
  detail.hidden = false;
  deleteButton.hidden = true;
  detailTitle.textContent = '기록 상세';
  detailContent.replaceChildren(element('p', '기록을 불러오는 중…'));
  detailTitle.focus();
  try {
    const { run, floors, relics, deck } = await api(`/api/runs/${id}`);
    if (request !== detailRequest) return;
    const values = [
      ['캐릭터', run.character_name ?? displayId(run.character_id)],
      ['참가 방식', `${modeLabels[run.play_mode]} · ${run.player_count}명`],
      ['게임 모드', gameModeLabels.get(run.game_mode) ?? run.game_mode],
      ['승천 단계', run.ascension],
      ['결과', resultLabels[run.result]],
    ];
    if (run.defeat_cause) values.push(['패배 원인', run.defeat_cause_name ?? displayId(run.defeat_cause)]);
    const summary = element('dl');
    for (const [label, value] of values) {
      summary.append(element('dt', label), element('dd', value ?? '확인 불가'));
    }
    detailContent.replaceChildren(summary,
      detailList('방문 경로', floors.map((floor) => {
        const place = floor.room_type ?? floor.map_point_type;
        const label = placeLabels.get(place) ?? place ?? '장소 확인 불가';
        return `${floor.act_number}막 ${floor.visit_order}번째 · ${label} · 체력 ${floor.current_hp ?? '—'}/${floor.max_hp ?? '—'} · 골드 ${floor.current_gold ?? '—'}`;
      })),
      detailList('최종 유물', relics.map((relic) => relic.name ?? displayId(relic.relic_id))),
      detailList('최종 덱', deck.map((card) => {
        const upgrade = card.upgrade_level > 0 ? ` +${card.upgrade_level}` : '';
        return (card.name ?? displayId(card.card_id)) + upgrade;
      })));
    activeRun = id;
    deleteButton.hidden = false;
  } catch (error) {
    if (request === detailRequest) detailContent.replaceChildren(element('p', error.message));
  }
}

deleteButton.addEventListener('click', async () => {
  const id = activeRun;
  if (id === null || !confirm('저장된 기록을 삭제할까요?')) return;
  deleteButton.disabled = true;
  try {
    await api(`/api/runs/${id}`, { method: 'DELETE' });
    if (activeRun === id) {
      ++detailRequest;
      activeRun = null;
      detail.hidden = true;
    }
    await loadRecords();
    importStatus.textContent = '기록을 삭제했습니다.';
  } catch (error) {
    importStatus.textContent = error.message;
  } finally {
    deleteButton.disabled = false;
  }
});

loadRecords();
