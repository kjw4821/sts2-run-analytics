const form = document.querySelector('#run-form');
const playerIdInput = document.querySelector('#player-id');
const folderInput = document.querySelector('#profile-folder');
const fileInput = document.querySelector('#run-files');
const filePlayerIdInput = document.querySelector('#file-player-id');
const importModeButtons = form.querySelectorAll('[data-import-mode]');
const folderFields = document.querySelector('#folder-fields');
const fileFields = document.querySelector('#file-fields');
const importButton = form.querySelector('button[type="submit"]');
const importStatus = document.querySelector('#status');
const importResults = document.querySelector('#import-results');
const filters = document.querySelector('#filters');
const characterFilter = document.querySelector('#character-filter');
const records = document.querySelector('#records');
const recordsStatus = document.querySelector('#records-status');
const recordPages = document.querySelector('#record-pages');
const recordPage = document.querySelector('#record-page');
const previousRecords = document.querySelector('#previous-records');
const nextRecords = document.querySelector('#next-records');
const dashboard = document.querySelector('#dashboard');
const dashboardStatus = document.querySelector('#dashboard-status');
const cardFilters = document.querySelector('#card-filters');
const cardAnalysisStatus = document.querySelector('#card-analysis-status');
const cardAnalysis = document.querySelector('#card-analysis');
const tendencyFilters = document.querySelector('#tendency-filters');
const tendencyStatus = document.querySelector('#tendency-status');
const tendencyAnalysis = document.querySelector('#tendency-analysis');
const tendencyComparison = document.querySelector('#tendency-comparison');
const comparisonStatus = document.querySelector('#comparison-status');
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
const importSelections = { folder: { files: [], message: '' }, files: { files: [], message: '' } };
let importMode = 'folder';
const recordsPerPage = 10;
let currentPage = 1;
let listedRuns = [];
let listedCharacterNames = {};
let listRequest = 0;
let dashboardRequest = 0;
let cardAnalysisRequest = 0;
let tendencyRequest = 0;
let detailRequest = 0;
let activeRun = null;

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

function showImportSelection() {
  const { files, message } = importSelections[importMode];
  importButton.disabled = files.length === 0;
  importStatus.textContent = message;
  importResults.replaceChildren();
  importResults.hidden = true;
}

for (const button of importModeButtons) {
  button.addEventListener('click', () => {
    if (importMode === button.dataset.importMode) return;
    importMode = button.dataset.importMode;
    const useFolder = importMode === 'folder';
    folderFields.hidden = folderFields.disabled = !useFolder;
    fileFields.hidden = fileFields.disabled = useFolder;
    for (const option of importModeButtons) {
      option.setAttribute('aria-pressed', String(option === button));
    }
    showImportSelection();
  });
}

folderInput.addEventListener('change', () => {
  const files = Array.from(folderInput.files);
  const folderName = files[0]?.webkitRelativePath.split('/')[0] ?? '';
  const selection = importSelections.folder;
  playerIdInput.value = '';

  if (!/^\d+$/.test(folderName)) {
    selection.files = [];
    selection.message = files.length
      ? 'Steam 폴더 아래의 숫자 ID 폴더를 선택하세요.'
      : '선택한 폴더에서 파일을 찾지 못했습니다.';
  } else {
    playerIdInput.value = folderName;
    selection.files = files.filter((file) => /\.run$/i.test(file.name));
    selection.message = selection.files.length
      ? `.run 파일 ${selection.files.length}개를 찾았습니다.`
      : '선택한 폴더와 하위 폴더에 .run 파일이 없습니다.';
  }
  showImportSelection();
});

fileInput.addEventListener('change', () => {
  const files = Array.from(fileInput.files).filter((file) => /\.run$/i.test(file.name));
  importSelections.files = {
    files,
    message: files.length ? `.run 파일 ${files.length}개를 선택했습니다.` : '.run 파일을 선택하세요.',
  };
  showImportSelection();
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (importButton.disabled) return;
  const useFolder = importMode === 'folder';
  const { files } = importSelections[importMode];
  const playerId = (useFolder ? playerIdInput : filePlayerIdInput).value.trim();
  const fields = useFolder ? folderFields : fileFields;
  const controls = [fields, importButton, ...importModeButtons];
  for (const control of controls) control.disabled = true;
  importResults.replaceChildren();
  importResults.hidden = false;
  const totals = { imported: 0, duplicate: 0, failed: 0 };
  try {
    for (const [index, file] of files.entries()) {
      importStatus.textContent = `${index + 1}/${files.length} 파일 처리 중…`;
      const row = element('li');
      const relativeName = useFolder ? file.webkitRelativePath.split('/').slice(1).join('/') : file.name;
      try {
        const headers = { 'Content-Type': 'application/octet-stream' };
        if (playerId) headers['X-Player-Id'] = playerId;
        const query = new URLSearchParams({ filename: file.name });
        const result = await api(`/api/import?${query}`, { method: 'POST', headers, body: file });
        totals[result.status] += 1;
        const additions = [];
        if (result.roomsUpdated) additions.push('방문 정보');
        if (result.enchantmentsUpdated) additions.push('인챈트 정보');
        if (result.startTimeUpdated) additions.push('시작 시각');
        const label = result.status === 'imported' ? '저장 완료' :
          additions.length ? `기존 기록에 ${additions.join('·')} 추가` : '이미 저장된 파일';
        row.append(element('span', `${relativeName} · ${label}`),
          action('기록 보기', () => showDetail(result.runId)));
      } catch (error) {
        totals.failed += 1;
        row.append(element('span', `${relativeName} · 실패 (${error.message})`));
      }
      importResults.append(row);
    }
    importStatus.textContent = `저장 ${totals.imported}개 · 중복 ${totals.duplicate}개 · 실패 ${totals.failed}개`;
    await Promise.all([loadRecords(true), loadDashboard(), loadCardAnalysis(), loadTendencyAnalysis()]);
  } finally {
    for (const control of controls) control.disabled = false;
  }
});

const winRateFormat = new Intl.NumberFormat('ko-KR', { style: 'percent', maximumFractionDigits: 1 });
const startTimeFormat = new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

function scoreText({ total, wins, decided, win_rate }) {
  const rate = win_rate === null ? '산출 불가' : winRateFormat.format(win_rate);
  return `총 ${total}런 · 승률 ${rate} (${wins}/${decided})`;
}

function showCharacterRuns(mode, character) {
  if (!Array.from(characterFilter.options).some((option) => option.value === character)) {
    characterFilter.add(new Option(character, character));
  }
  characterFilter.value = character;
  filters.elements.mode.value = mode;
  filters.elements.ascension.value = '';
  filters.elements.result.value = '';
  loadRecords(true);
  document.querySelector('#records-title').focus();
}

async function loadDashboard() {
  const request = ++dashboardRequest;
  dashboardStatus.textContent = '성적을 불러오는 중…';
  try {
    const { groups, characterNames } = await api('/api/dashboard');
    if (request !== dashboardRequest) return;
    const overall = groups.find((group) => group.play_mode === null);
    const modes = element('div');
    modes.className = 'dashboard-modes';
    for (const [mode, label] of Object.entries(modeLabels)) {
      const summary = groups.find((group) => group.play_mode === mode && group.character_id === null);
      const characters = groups.filter((group) => group.play_mode === mode && group.character_id !== null);
      const panel = element('div');
      panel.className = 'dashboard-mode';
      panel.append(element('h3', label), element('p', scoreText(summary)));
      const list = element('ul');
      list.className = 'record-list';
      for (const group of characters) {
        const id = group.character_id;
        const name = Object.hasOwn(characterNames, id) ? characterNames[id] : id;
        const row = element('li');
        row.append(action(`${name} · ${scoreText(group)}`, () => showCharacterRuns(mode, id)));
        list.append(row);
      }
      if (characters.length) panel.append(list);
      modes.append(panel);
    }
    dashboard.replaceChildren(element('p', `전체 · ${scoreText(overall)}`),
      element('p', '괄호 안은 승리 수 / 승패가 확인된 런 수입니다.'), modes);
    dashboardStatus.textContent = overall.total ? '' : '저장된 기록이 없습니다.';
  } catch (error) {
    if (request !== dashboardRequest) return;
    dashboard.replaceChildren();
    dashboardStatus.textContent = error.message;
  }
}

function formatCardRate(numerator, denominator) {
  return denominator ? `${winRateFormat.format(numerator / denominator)} (${numerator} / ${denominator})`
    : '산출 불가 (0 / 0)';
}

function rankedCard(card, rank, community) {
  const row = element('li');
  row.className = 'ranked-card';
  const artwork = element('div');
  artwork.className = 'ranked-card-art';
  const source = card.full_image_url || card.image_url;
  if (source) {
    const image = element('img');
    image.alt = '';
    image.loading = 'lazy';
    image.referrerPolicy = 'no-referrer';
    image.addEventListener('error', () => {
      if (image.src === card.full_image_url && card.image_url && card.image_url !== card.full_image_url) {
        image.src = card.image_url;
      } else {
        image.remove();
      }
    });
    image.src = source;
    artwork.append(image);
  }
  const stats = element('div');
  const value = card.community_pick_rate;
  const communityRate = Number.isFinite(value) ? winRateFormat.format(value)
    : community?.available ? '통계 없음' : '조회 실패';
  stats.append(
    element('h4', `${rank}위 · ${card.name}`),
    element('p', `내 채용률 ${formatCardRate(card.picked, card.offered)} | 커뮤니티 채용률 ${communityRate}`),
    element('p', `선택 런 승률 ${formatCardRate(card.wins, card.decided)}`),
  );
  row.append(artwork, stats);
  return row;
}

async function loadCardAnalysis() {
  const request = ++cardAnalysisRequest;
  cardAnalysis.hidden = true;
  cardAnalysisStatus.textContent = '카드 선택 기록을 불러오는 중…';
  try {
    const query = new URLSearchParams(new FormData(cardFilters));
    const characterLabel = cardFilters.elements.character.selectedOptions[0]?.textContent;
    const { cards, community } = await api(`/api/card-analysis?${query}`);
    if (request !== cardAnalysisRequest) return;
    const groups = Object.entries({ attack: '공격', skill: '스킬', power: '파워' }).map(([type, label]) => {
      const group = element('div');
      group.append(element('h3', label));
      const leaders = cards.filter((card) => card.type === type);
      if (leaders.length) {
        const list = element('ol');
        list.className = 'ranked-cards';
        list.append(...leaders.map((card, index) => rankedCard(card, index + 1, community)));
        group.append(list);
      } else {
        group.append(element('p', '선택 기록이 없습니다.'));
      }
      return group;
    });
    cardAnalysis.replaceChildren(...groups);
    cardAnalysis.hidden = !cards.length;
    cardAnalysisStatus.textContent = cards.length ? '' : '조건에 해당하는 전투 카드 선택 기록이 없습니다.';
    if (cards.length && community) {
      const character = community.character ? characterLabel || community.character : '전체 캐릭터';
      const mode = community.bracket.includes('solo') ? '싱글' : '전체 참가 방식';
      const ascension = community.bracket.includes('a10') ? '승천 10' : '전체 승천';
      cardAnalysisStatus.textContent = `내 채용률은 전투 보상 기준입니다. 커뮤니티 채용률은 Spire Codex 무료 선택 화면 기준입니다 (${character} · ${mode} · ${ascension}).`;
    }
  } catch (error) {
    if (request === cardAnalysisRequest) cardAnalysisStatus.textContent = error.message;
  }
}

function tendencyMetrics(stats) {
  const restMetric = (code) => [
    stats.rest_actions.find((action) => action.code === code)?.visits ?? 0,
    stats.rest_visits, stats.rest_runs, '휴식 행동 미기록',
  ];
  return [
    ['엘리트 방문 비율', stats.elite_visits, stats.known_visits, stats.known_runs, '장소 유형 미기록'],
    ['휴식처 회복 비율', ...restMetric('HEAL')],
    ['휴식처 강화 비율', ...restMetric('SMITH')],
  ];
}

function renderTendencyComparison(comparison) {
  if (!comparison) {
    comparisonStatus.textContent = '캐릭터와 승천 단계를 지정한 뒤 필터를 적용해 주세요.';
    return;
  }
  const { win, loss } = comparison;
  comparisonStatus.textContent = `승리 ${win.runs}개 런 · 패배 ${loss.runs}개 런`;
  const formatGroup = (runs, picked, visits, validRuns, missing) => {
    if (!runs) return '기록 없음';
    return visits ? `${formatCardRate(picked, visits)} · ${validRuns}개 런` : `산출 불가 (${missing}) · 0개 런`;
  };
  const lossMetrics = tendencyMetrics(loss);
  const rows = tendencyMetrics(win).map(([label, picked, visits, validRuns, missing], index) => {
    const [, lossPicked, lossVisits, lossRuns, lossMissing] = lossMetrics[index];
    let difference = '비교할 기록 부족';
    if (visits && lossVisits) {
      const points = 100 * (picked / visits - lossPicked / lossVisits);
      const rounded = Number(points.toFixed(1));
      difference = `${rounded > 0 ? '+' : ''}${rounded.toFixed(1)}%p`;
    }
    const row = element('tr');
    const heading = element('th', label);
    heading.scope = 'row';
    row.append(heading, element('td', formatGroup(win.runs, picked, visits, validRuns, missing)),
      element('td', formatGroup(loss.runs, lossPicked, lossVisits, lossRuns, lossMissing)), element('td', difference));
    return row;
  });
  tendencyComparison.tBodies[0].replaceChildren(...rows);
  tendencyComparison.hidden = false;
}

async function loadTendencyAnalysis() {
  const request = ++tendencyRequest;
  tendencyAnalysis.hidden = true;
  tendencyComparison.hidden = true;
  comparisonStatus.textContent = '';
  tendencyStatus.textContent = '플레이 성향을 불러오는 중…';
  try {
    const query = new URLSearchParams(new FormData(tendencyFilters));
    const stats = await api(`/api/tendency-analysis?${query}`);
    if (request !== tendencyRequest) return;
    tendencyStatus.textContent = stats.runs ? `분석 대상 ${stats.runs}개 런` : '조건에 해당하는 기록이 없습니다.';
    const metrics = [
      ...tendencyMetrics(stats).map(([label, picked, visits, , missing]) =>
        [label, visits ? formatCardRate(picked, visits) : `산출 불가 (${missing})`]),
      ...stats.rest_actions.filter(({ code }) => code !== 'HEAL' && code !== 'SMITH')
        .map(({ code, count }) => [`기타 휴식 행동 · ${code}`, `${count}회`]),
    ];
    tendencyAnalysis.replaceChildren(...metrics.flatMap(([label, value]) =>
      [element('dt', label), element('dd', value)]));
    tendencyAnalysis.hidden = !stats.runs;
    renderTendencyComparison(stats.comparison);
  } catch (error) {
    if (request === tendencyRequest) tendencyStatus.textContent = error.message;
  }
}

async function loadRecords(resetPage = false) {
  const request = ++listRequest;
  recordsStatus.textContent = '기록을 불러오는 중…';
  records.replaceChildren();
  recordPages.hidden = true;
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
    for (const analysis of [cardFilters, tendencyFilters]) {
      const select = analysis.elements.character;
      const selectedCharacter = select.value;
      select.replaceChildren(new Option('전체', ''),
        ...characters.map((id) => new Option(characterName(id), id)));
      if (selectedCharacter && !characters.includes(selectedCharacter)) {
        select.append(new Option(characterName(selectedCharacter), selectedCharacter));
      }
      select.value = selectedCharacter;
    }
    listedRuns = runs;
    listedCharacterNames = characterNames;
    if (resetPage) currentPage = 1;
    renderRecordPage();
  } catch (error) {
    if (request === listRequest) recordsStatus.textContent = error.message;
  }
}

function renderRecordPage() {
  const total = listedRuns.length;
  const pageCount = Math.max(1, Math.ceil(total / recordsPerPage));
  currentPage = Math.min(pageCount, Math.max(1, currentPage));
  const start = (currentPage - 1) * recordsPerPage;
  records.replaceChildren();
  for (const run of listedRuns.slice(start, start + recordsPerPage)) {
    const row = element('li');
    const level = run.ascension === null ? '승천 확인 불가' : `승천 ${run.ascension}`;
    const started = run.start_time == null ? '시작 시각 미상' : startTimeFormat.format(run.start_time * 1000);
    const id = run.character_id;
    const name = element('span', Object.hasOwn(listedCharacterNames, id) ? listedCharacterNames[id] : displayId(id));
    name.className = 'record-character';
    name.dataset.character = run.character_id.toUpperCase().replace(/^CHARACTER\./, '');
    const result = element('span', resultLabels[run.result]);
    result.className = 'record-result';
    result.dataset.result = run.result;
    const recordButton = action(undefined, () => showDetail(run.run_id));
    recordButton.append(name, ` · ${modeLabels[run.play_mode]} · ${level} · `, result, ` · ${started}`);
    row.append(recordButton);
    records.append(row);
  }
  recordsStatus.textContent = total ? `총 ${total}건` : '조건에 맞는 저장 기록이 없습니다.';
  recordPages.hidden = pageCount === 1;
  recordPage.textContent = `${currentPage} / ${pageCount}`;
  previousRecords.disabled = currentPage === 1;
  nextRecords.disabled = currentPage === pageCount;
}

previousRecords.addEventListener('click', () => { currentPage -= 1; renderRecordPage(); });
nextRecords.addEventListener('click', () => { currentPage += 1; renderRecordPage(); });

filters.addEventListener('submit', (event) => {
  event.preventDefault();
  loadRecords(true);
});
filters.addEventListener('reset', () => setTimeout(() => loadRecords(true), 0));

function visitImage(source) {
  const image = element('img');
  image.alt = '';
  image.loading = 'lazy';
  image.referrerPolicy = 'no-referrer';
  image.addEventListener('error', () => image.remove(), { once: true });
  image.src = source;
  return image;
}

function visitRoom(room) {
  const section = element('div');
  section.className = 'visit-room';
  const artwork = element('div');
  artwork.className = 'visit-art';
  const monsters = new Map();
  for (const monster of room.monsters ?? []) {
    const entry = monsters.get(monster.id);
    if (entry) entry.count += 1;
    else monsters.set(monster.id, { ...monster, count: 1 });
  }
  if (room.image_url) artwork.append(visitImage(room.image_url));
  for (const monster of monsters.values()) {
    if (monster.image_url) artwork.append(visitImage(monster.image_url));
  }
  const place = placeLabels.get(room.room_type) ?? room.room_type ?? '장소 확인 불가';
  const name = room.name ?? room.model_id;
  section.append(artwork, element('h4', name ? `${place} · ${name}` : place));
  if (monsters.size) {
    const names = Array.from(monsters.values(), (monster) =>
      (monster.name ?? monster.id) + (monster.count > 1 ? ` × ${monster.count}` : ''));
    section.append(element('p', names.join(', ')));
  }
  return section;
}

function visitPath(floors) {
  const path = element('details');
  path.append(element('summary', `방문 경로 · ${floors.length}곳`));
  if (!floors.length) path.append(element('p', '확인 가능한 방문 기록이 없습니다.'));
  const acts = new Map();
  for (const floor of floors) {
    if (!acts.has(floor.act_number)) acts.set(floor.act_number, []);
    acts.get(floor.act_number).push(floor);
  }
  for (const [act, visits] of acts) {
    const group = element('details');
    group.className = 'visit-act';
    const list = element('ol');
    list.className = 'visit-list';
    for (const floor of visits) {
      const tile = element('li');
      const rooms = floor.rooms?.length ? floor.rooms :
        [{ room_type: floor.room_type ?? floor.map_point_type }];
      for (const room of rooms) tile.append(visitRoom(room));
      tile.append(element('p', `${floor.visit_order}번째 방문 · 체력 ${floor.current_hp ?? '—'}/${floor.max_hp ?? '—'} · 골드 ${floor.current_gold ?? '—'}`));
      list.append(tile);
    }
    group.append(element('summary', `${act}막 · ${visits.length}곳`), list);
    path.append(group);
  }
  path.open = true;
  return path;
}

function relicDetails(relics) {
  const details = element('details');
  details.append(element('summary', `최종 유물 · ${relics.length}개`));
  if (!relics.length) {
    details.append(element('p', '확인 가능한 유물이 없습니다.'));
    return details;
  }
  const grid = element('ul');
  grid.className = 'relic-grid';
  for (const relic of relics) {
    const tile = element('li');
    const artwork = element('div');
    artwork.className = 'relic-art';
    const placeholder = element('span', '이미지 없음');
    artwork.append(placeholder);
    if (relic.image_url) {
      const image = element('img');
      image.alt = '';
      image.loading = 'lazy';
      image.referrerPolicy = 'no-referrer';
      image.addEventListener('load', () => { placeholder.hidden = true; }, { once: true });
      image.addEventListener('error', () => image.remove(), { once: true });
      artwork.append(image);
      image.src = relic.image_url;
    }
    const effect = element('p', relic.description || '효과 설명 없음');
    effect.className = 'relic-effect';
    tile.append(artwork, element('strong', relic.name ?? displayId(relic.relic_id)), effect);
    grid.append(tile);
  }
  details.open = true;
  details.append(grid);
  return details;
}

function deckDetails(deck) {
  const groups = new Map();
  for (const card of deck) {
    const key = JSON.stringify([card.card_id, card.upgrade_level, card.enchantment_id, card.enchantment_amount]);
    const group = groups.get(key);
    if (group) group.count += 1;
    else groups.set(key, { ...card, count: 1 });
  }
  const details = element('details');
  details.append(element('summary', `최종 덱 · ${deck.length}장`));
  if (!groups.size) {
    details.append(element('p', '확인 가능한 카드가 없습니다.'));
    return details;
  }
  const grid = element('ul');
  grid.className = 'deck-grid';
  for (const card of groups.values()) {
    const tile = element('li');
    const artwork = element('div');
    artwork.className = 'deck-art';
    const placeholder = element('span', '이미지 없음');
    artwork.append(placeholder);
    const effect = element('p', card.description);
    effect.className = 'deck-effect';
    effect.hidden = Boolean(card.full_image_url) || !card.description;
    if (card.full_image_url || card.image_url) {
      const image = element('img');
      image.alt = '';
      image.loading = 'lazy';
      image.referrerPolicy = 'no-referrer';
      image.style.visibility = 'hidden';
      image.addEventListener('load', () => {
        placeholder.hidden = true;
        image.style.visibility = '';
        if (card.full_image_url && !artwork.classList.contains('portrait')) {
          image.alt = card.description ?? '';
        }
      });
      artwork.classList.toggle('portrait', !card.full_image_url);
      image.addEventListener('error', () => {
        if (!artwork.classList.contains('portrait')) {
          artwork.classList.add('portrait');
          effect.hidden = !card.description;
          if (card.image_url) {
            image.src = card.image_url;
            return;
          }
        }
        image.remove();
      });
      image.src = card.full_image_url || card.image_url;
      artwork.append(image);
    }
    const upgrade = card.upgrade_level > 0 ? '+' : '';
    const enchantment = card.enchantment_id
      ? ` (${card.enchantment_effect || card.enchantment_name || card.enchantment_id})`
      : '';
    const quantity = card.count > 1 ? ` × ${card.count}` : '';
    const label = element(card.upgrade_level > 0 ? 'strong' : 'span',
      (card.name ?? displayId(card.card_id)) + upgrade + enchantment + quantity);
    label.className = 'deck-label';
    label.dataset.rarity = card.rarity ?? '';
    tile.append(artwork, label, effect);
    grid.append(tile);
  }
  details.open = true;
  details.append(grid);
  return details;
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
      visitPath(floors),
      relicDetails(relics),
      deckDetails(deck));
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
    await Promise.all([loadRecords(), loadDashboard(), loadCardAnalysis(), loadTendencyAnalysis()]);
    importStatus.textContent = '기록을 삭제했습니다.';
  } catch (error) {
    importStatus.textContent = error.message;
  } finally {
    deleteButton.disabled = false;
  }
});

loadRecords();
loadDashboard();
cardFilters.addEventListener('submit', (event) => {
  event.preventDefault();
  loadCardAnalysis();
});
loadCardAnalysis();
tendencyFilters.addEventListener('submit', (event) => {
  event.preventDefault();
  loadTendencyAnalysis();
});
loadTendencyAnalysis();
