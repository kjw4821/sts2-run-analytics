function parseRun(text) {
  return JSON.parse(text, (key, value, context) => {
    if ((key === 'id' || key === 'player_id') && typeof value === 'number') {
      return context?.source ?? (Number.isSafeInteger(value) ? String(value) : value);
    }
    return value;
  });
}

function getRunResult({ win, was_abandoned: wasAbandoned }) {
  if (wasAbandoned === true && win !== true) return 'abandoned';
  if (wasAbandoned === false && typeof win === 'boolean') {
    return win ? 'win' : 'loss';
  }
  return 'unknown';
}

function readArray(value, field) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error(`${field} 형식이 올바르지 않습니다.`);
  return value;
}

function readIdentifier(value, field) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${field} 식별자를 읽을 수 없습니다.`);
  }
  return value;
}

function nonnegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function extractRun(run, player) {
  const characterId = readIdentifier(player?.character, '캐릭터').trim();
  const acts = readArray(run.map_point_history, '방문 기록');
  const floors = acts.flatMap((act, actIndex) =>
    readArray(act, '막별 방문 기록').map((visit, visitIndex) =>
      extractFloor(visit, actIndex + 1, visitIndex + 1, player.id)));
  const relics = readArray(player.relics, '최종 유물').map((relic, index) => ({
    relicId: readIdentifier(relic?.id, '유물'),
    order: index + 1,
    addedFloor: nonnegativeInteger(relic.floor_added_to_deck),
  }));
  const deck = readArray(player.deck, '최종 덱').map((card, index) => ({
    cardId: readIdentifier(card?.id, '카드'),
    order: index + 1,
    upgradeLevel: nonnegativeInteger(card.current_upgrade_level),
  }));
  const result = getRunResult(run);
  const defeatCause = [run.killed_by_encounter, run.killed_by_event]
    .filter((cause) => typeof cause === 'string' && cause && cause !== 'NONE.NONE');

  return {
    characterId,
    playMode: run.players.length === 1 ? 'single' : 'multi',
    gameMode: typeof run.game_mode === 'string' ? run.game_mode : null,
    playerCount: run.players.length,
    ascension: nonnegativeInteger(run.ascension),
    result,
    defeatCause: result === 'loss' && defeatCause.length === 1 ? defeatCause[0] : null,
    buildId: typeof run.build_id === 'string' ? run.build_id : null,
    schemaVersion: nonnegativeInteger(run.schema_version),
    floors,
    relics,
    deck,
  };
}

function extractFloor(visit, actNumber, visitOrder, playerId) {
  if (!visit || typeof visit !== 'object' || Array.isArray(visit)) {
    throw new Error('방문 기록 행의 형식이 올바르지 않습니다.');
  }
  const stats = readArray(visit.player_stats, '방문별 참가자 기록');
  if (stats.length && (typeof playerId !== 'string' || !/^\d+$/.test(playerId))) {
    throw new Error('층별 기록을 연결할 플레이어 ID를 정확히 읽을 수 없습니다.');
  }
  if (stats.some((row) => typeof row?.player_id === 'number')) {
    throw new Error('층별 참가자 ID를 정확히 읽을 수 없습니다.');
  }
  const matches = stats.filter((row) => row?.player_id === playerId);
  if (matches.length > 1) throw new Error('같은 방문에 내 참가자 기록이 중복되어 있습니다.');
  const ownStats = matches[0];
  const rooms = readArray(visit.rooms, '방 기록');
  const allRoomTypes = rooms.map((room) => room?.room_type);
  const roomType = allRoomTypes.every((type) => type === allRoomTypes[0])
    && typeof allRoomTypes[0] === 'string' ? allRoomTypes[0] : null;

  return {
    actNumber,
    visitOrder,
    mapPointType: typeof visit.map_point_type === 'string' ? visit.map_point_type : null,
    roomType,
    currentHp: nonnegativeInteger(ownStats?.current_hp),
    maxHp: nonnegativeInteger(ownStats?.max_hp),
    currentGold: nonnegativeInteger(ownStats?.current_gold),
    cardChoices: readArray(ownStats?.card_choices, '카드 선택').map((choice, index) => ({
      cardId: readIdentifier(choice?.card?.id, '카드'),
      order: index + 1,
      roomType,
      picked: typeof choice.was_picked === 'boolean' ? choice.was_picked : null,
    })),
    restActions: readArray(ownStats?.rest_site_choices, '휴식 행동').map((code, index) => ({
      code: readIdentifier(code, '휴식 행동'),
      order: index + 1,
    })),
  };
}

function selectRunPlayer(run, playerId) {
  if (!Array.isArray(run?.players) || run.players.length === 0) {
    throw new Error('기록에서 참가자 목록을 찾을 수 없습니다.');
  }
  if (run.players.length === 1) return run.players[0];
  if (!/^\d+$/.test(playerId)) {
    throw new Error('멀티 기록의 숫자 플레이어 ID를 입력해 주세요.');
  }
  const matches = run.players.filter((entry) => entry?.id === playerId);
  if (matches.length > 1) throw new Error('같은 플레이어 ID가 참가자 목록에 중복되어 있습니다.');
  if (!matches.length) throw new Error('입력한 플레이어 ID와 일치하는 참가자가 없습니다.');
  return matches[0];
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { parseRun, selectRunPlayer, extractRun };
}
