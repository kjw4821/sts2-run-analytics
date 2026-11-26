const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { DatabaseSync } = require('node:sqlite');

function openDatabase(filename) {
  const db = new DatabaseSync(filename);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

  function transaction(work) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  try {
    transaction(() => {
      const { user_version: version } = db.prepare('PRAGMA user_version').get();
      if (version === 0) {
        db.exec(readFileSync(join(__dirname, 'schema.sql'), 'utf8'));
      } else if (version === 1) {
        db.exec(`
          ALTER TABLE RunDeckCards ADD COLUMN enchantment_id TEXT;
          ALTER TABLE RunDeckCards ADD COLUMN enchantment_amount INTEGER CHECK (enchantment_amount >= 0);
        `);
      } else if (version !== 2 && version !== 3 && version !== 4) {
        throw new Error(`지원하지 않는 DB 버전입니다. (${version})`);
      }
      if (version < 3) {
        db.exec(readFileSync(join(__dirname, 'visit-rooms.sql'), 'utf8'));
      }
      if (version > 0 && version < 4) {
        db.exec('ALTER TABLE Runs ADD COLUMN start_time INTEGER CHECK (start_time BETWEEN 0 AND 8640000000000)');
      }
      if (version < 4) {
        db.exec('PRAGMA user_version = 4');
      }
    });
  } catch (error) {
    db.close();
    throw error;
  }

  const findHash = db.prepare('SELECT run_id FROM Runs WHERE source_hash = ?');
  const addCharacter = db.prepare('INSERT INTO Characters VALUES (?) ON CONFLICT DO NOTHING');
  const addCard = db.prepare('INSERT INTO Cards VALUES (?) ON CONFLICT DO NOTHING');
  const addRelic = db.prepare('INSERT INTO Relics VALUES (?) ON CONFLICT DO NOTHING');
  const addRun = db.prepare(`
    INSERT INTO Runs (source_hash, character_id, play_mode, game_mode, player_count,
                      ascension, result, defeat_cause, build_id, schema_version, start_time)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const fillStartTime = db.prepare('UPDATE Runs SET start_time = ? WHERE run_id = ? AND start_time IS NULL');
  const addFloor = db.prepare(`
    INSERT INTO FloorRecords (run_id, act_number, visit_order, map_point_type, room_type,
                              current_hp, max_hp, current_gold) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const addChoice = db.prepare('INSERT INTO CardChoices VALUES (?, ?, ?, ?, ?)');
  const findFloorId = db.prepare(`
    SELECT floor_record_id FROM FloorRecords WHERE run_id = ? AND act_number = ? AND visit_order = ?
  `);
  const addRoom = db.prepare(`
    INSERT INTO VisitRooms (floor_record_id, room_order, room_type, model_id) VALUES (?, ?, ?, ?)
    ON CONFLICT (floor_record_id, room_order) DO NOTHING
  `);
  const addMonster = db.prepare('INSERT INTO RoomMonsters VALUES (?, ?, ?)');

  function saveRooms(floorId, rooms) {
    let saved = 0;
    for (const room of rooms) {
      const { changes, lastInsertRowid: roomId } = addRoom.run(floorId, room.order, room.roomType, room.modelId);
      if (!changes) continue;
      for (const monster of room.monsters) addMonster.run(roomId, monster.order, monster.id);
      saved += 1;
    }
    return saved;
  }
  const addAction = db.prepare("INSERT INTO RunActions VALUES (?, 'rest', ?, ?)");
  const addRunRelic = db.prepare('INSERT INTO RunRelics VALUES (?, ?, ?, ?)');
  const addDeckCard = db.prepare('INSERT INTO RunDeckCards VALUES (?, ?, ?, ?, ?, ?)');
  const fillDeckEnchantment = db.prepare(`
    UPDATE RunDeckCards SET enchantment_id = ?, enchantment_amount = ?
    WHERE run_id = ? AND card_order = ? AND card_id = ? AND enchantment_id IS NULL
  `);
  const runColumns = 'run_id, character_id, play_mode, game_mode, player_count, ascension, result, start_time';
  const findRun = db.prepare(`SELECT ${runColumns}, defeat_cause, build_id FROM Runs WHERE run_id = ?`);
  const listRuns = db.prepare(`
    SELECT ${runColumns} FROM Runs
    WHERE (? IS NULL OR character_id = ?) AND (? IS NULL OR play_mode = ?)
      AND (? IS NULL OR ascension = ?) AND (? IS NULL OR result = ?)
    ORDER BY run_id DESC
  `);
  const listCharacters = db.prepare('SELECT DISTINCT character_id FROM Runs ORDER BY character_id');
  const dashboardCounts = `
    COUNT(run_id) AS total,
    COUNT(*) FILTER (WHERE result = 'win') AS wins,
    COUNT(*) FILTER (WHERE result IN ('win', 'loss')) AS decided,
    1.0 * COUNT(*) FILTER (WHERE result = 'win') /
      NULLIF(COUNT(*) FILTER (WHERE result IN ('win', 'loss')), 0) AS win_rate
  `;
  const dashboard = db.prepare(`
    SELECT NULL AS play_mode, NULL AS character_id, ${dashboardCounts} FROM Runs
    UNION ALL
    SELECT modes.play_mode, NULL, ${dashboardCounts}
    FROM (SELECT 'single' AS play_mode UNION ALL SELECT 'multi') AS modes
    LEFT JOIN Runs ON Runs.play_mode = modes.play_mode
    GROUP BY modes.play_mode
    UNION ALL
    SELECT play_mode, character_id, ${dashboardCounts}
    FROM Runs GROUP BY play_mode, character_id
    ORDER BY play_mode, character_id
  `);
  const cardAnalysis = db.prepare(`
    SELECT card_id, COUNT(*) AS offered, SUM(was_picked) AS picked,
      COUNT(DISTINCT run_id) FILTER (WHERE was_picked = 1 AND result = 'win') AS wins,
      COUNT(DISTINCT run_id) FILTER (WHERE was_picked = 1 AND result IN ('win', 'loss')) AS decided
    FROM CardChoices
    JOIN FloorRecords USING (floor_record_id)
    JOIN Runs USING (run_id)
    WHERE CardChoices.room_type IN ('monster', 'elite', 'boss')
      AND was_picked IS NOT NULL
      AND ($character IS NULL OR character_id = $character)
      AND ($mode IS NULL OR play_mode = $mode)
      AND ($ascension IS NULL OR ascension = $ascension)
    GROUP BY card_id
    ORDER BY offered DESC, picked DESC, card_id
  `);
  const tendencyAnalysis = db.prepare(`
    WITH matching_runs AS (
      SELECT run_id FROM Runs
      WHERE ($character IS NULL OR character_id = $character)
        AND ($mode IS NULL OR play_mode = $mode)
        AND ($ascension IS NULL OR ascension = $ascension)
    ),
    visits AS (
      SELECT floor_record_id,
        LOWER(COALESCE(TRIM(room_type), '')) AS room_type
      FROM FloorRecords JOIN matching_runs USING (run_id)
    ),
    rest_counts AS (
      SELECT UPPER(TRIM(action_code)) AS code, COUNT(*) AS count,
        COUNT(DISTINCT floor_record_id) AS visits
      FROM RunActions JOIN visits USING (floor_record_id)
      WHERE action_type = 'rest'
      GROUP BY UPPER(TRIM(action_code))
    )
    SELECT
      (SELECT COUNT(*) FROM matching_runs) AS runs,
      COUNT(*) FILTER (WHERE room_type NOT IN ('', 'unknown') OR EXISTS (
        SELECT 1 FROM VisitRooms r WHERE r.floor_record_id = visits.floor_record_id
          AND LOWER(TRIM(r.room_type)) NOT IN ('', 'unknown')
      )) AS known_visits,
      COUNT(*) FILTER (WHERE room_type = 'elite' OR EXISTS (
        SELECT 1 FROM VisitRooms r WHERE r.floor_record_id = visits.floor_record_id
          AND LOWER(TRIM(r.room_type)) = 'elite'
      )) AS elite_visits,
      (SELECT COUNT(DISTINCT floor_record_id) FROM RunActions JOIN visits USING (floor_record_id)
        WHERE action_type = 'rest') AS rest_visits,
      (SELECT json_group_array(json_object('code', code, 'count', count, 'visits', visits) ORDER BY code)
        FROM rest_counts) AS rest_actions
    FROM visits
  `);
  const findFloors = db.prepare(`
    SELECT floor_record_id, act_number, visit_order, map_point_type, room_type, current_hp, max_hp, current_gold
    FROM FloorRecords WHERE run_id = ? ORDER BY act_number, visit_order
  `);
  const findRooms = db.prepare(`
    SELECT VisitRooms.floor_record_id, VisitRooms.room_type, VisitRooms.model_id,
           (SELECT json_group_array(monster_id ORDER BY monster_order)
            FROM RoomMonsters WHERE visit_room_id = VisitRooms.visit_room_id) AS monsters
    FROM VisitRooms JOIN FloorRecords USING (floor_record_id)
    WHERE FloorRecords.run_id = ?
    ORDER BY VisitRooms.floor_record_id, room_order
  `);
  const findRelics = db.prepare('SELECT relic_id, added_floor FROM RunRelics WHERE run_id = ? ORDER BY relic_order');
  const findDeck = db.prepare(`
    SELECT card_id, upgrade_level, enchantment_id, enchantment_amount
    FROM RunDeckCards WHERE run_id = ? ORDER BY card_order
  `);
  const deleteRun = db.prepare('DELETE FROM Runs WHERE run_id = ?');

  return {
    importRun(bytes, run) {
      const hash = createHash('sha256').update(bytes).digest('hex');
      return transaction(() => {
        const existing = findHash.get(hash);
        if (existing) {
          let updated = 0;
          for (const card of run.deck) {
            if (!card.enchantmentId) continue;
            updated += fillDeckEnchantment.run(card.enchantmentId, card.enchantmentAmount ?? null,
              existing.run_id, card.order, card.cardId).changes;
          }
          let roomsUpdated = 0;
          for (const floor of run.floors) {
            const saved = findFloorId.get(existing.run_id, floor.actNumber, floor.visitOrder);
            if (saved) roomsUpdated += saveRooms(saved.floor_record_id, floor.rooms ?? []);
          }
          const startTimeUpdated = run.startTime != null && fillStartTime.run(run.startTime, existing.run_id).changes > 0;
          return { status: 'duplicate', runId: existing.run_id, enchantmentsUpdated: updated, roomsUpdated, startTimeUpdated };
        }

        addCharacter.run(run.characterId);
        const { lastInsertRowid: runId } = addRun.run(hash, run.characterId, run.playMode,
          run.gameMode, run.playerCount, run.ascension, run.result, run.defeatCause,
          run.buildId, run.schemaVersion, run.startTime ?? null);
        for (const floor of run.floors) {
          const { lastInsertRowid: floorId } = addFloor.run(runId, floor.actNumber,
            floor.visitOrder, floor.mapPointType, floor.roomType, floor.currentHp,
            floor.maxHp, floor.currentGold);
          saveRooms(floorId, floor.rooms ?? []);
          for (const card of floor.cardChoices) {
            addCard.run(card.cardId);
            addChoice.run(floorId, card.order, card.cardId, card.roomType,
              card.picked === null ? null : Number(card.picked));
          }
          for (const action of floor.restActions) addAction.run(floorId, action.order, action.code);
        }
        for (const relic of run.relics) {
          addRelic.run(relic.relicId);
          addRunRelic.run(runId, relic.order, relic.relicId, relic.addedFloor);
        }
        for (const card of run.deck) {
          addCard.run(card.cardId);
          addDeckCard.run(runId, card.order, card.cardId, card.upgradeLevel,
            card.enchantmentId ?? null, card.enchantmentId ? card.enchantmentAmount ?? null : null);
        }
        return { status: 'imported', runId };
      });
    },
    list({ character, mode, ascension, result }) {
      return {
        runs: listRuns.all(character, character, mode, mode, ascension, ascension, result, result),
        characters: listCharacters.all().map((row) => row.character_id),
      };
    },
    dashboard() {
      return dashboard.all();
    },
    cardAnalysis({ character, mode, ascension }) {
      return cardAnalysis.all({ character, mode, ascension });
    },
    tendencyAnalysis({ character, mode, ascension }) {
      const analysis = tendencyAnalysis.get({ character, mode, ascension });
      return { ...analysis, rest_actions: JSON.parse(analysis.rest_actions) };
    },
    detail(id) {
      const run = findRun.get(id);
      if (!run) return null;
      const roomsByFloor = new Map();
      for (const { floor_record_id: floorId, monsters, ...room } of findRooms.all(id)) {
        if (!roomsByFloor.has(floorId)) roomsByFloor.set(floorId, []);
        roomsByFloor.get(floorId).push({ ...room, monster_ids: JSON.parse(monsters) });
      }
      const floors = findFloors.all(id).map(({ floor_record_id: floorId, ...floor }) => ({
        ...floor, rooms: roomsByFloor.get(floorId) ?? [],
      }));
      return { run, floors, relics: findRelics.all(id), deck: findDeck.all(id) };
    },
    delete(id) {
      return deleteRun.run(id).changes > 0;
    },
    close() {
      db.close();
    },
  };
}

module.exports = { openDatabase };
