const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { connectTurso } = require('./turso');

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

  return createStore(db, (work) => transaction(() => {
    const operations = work();
    let step = operations.next();
    while (!step.done) {
      const results = step.value.map(([sql, args = []]) => {
        const stmt = db.prepare(sql);
        const params = Array.isArray(args) ? args : [args];
        if (stmt.columns().length) return { rows: stmt.all(...params) };
        return { changes: stmt.run(...params).changes };
      });
      step = operations.next(results);
    }
    return step.value;
  }));
}

async function openTursoDatabase(url, token, request) {
  const db = connectTurso(url, token, request);
  await db.transaction(async (execute) => {
    await execute([['CREATE TABLE IF NOT EXISTS SpireSchemaVersion (version INTEGER NOT NULL)']]);
    const [{ rows: versions }] = await execute([['SELECT version FROM SpireSchemaVersion']]);
    if (versions.length === 1 && versions[0].version === 4) return;
    if (versions.length) throw new Error('Unsupported Turso schema version.');
    const schema = ['schema.sql', 'visit-rooms.sql']
      .flatMap((name) => readFileSync(join(__dirname, name), 'utf8').split(';'))
      .map((sql) => sql.trim()).filter((sql) => sql && !sql.startsWith('PRAGMA foreign_keys'));
    await execute([...schema.map((sql) => [sql]), ['INSERT INTO SpireSchemaVersion VALUES (4)']]);
  });

  const adapter = {
    prepare(sql) {
      const read = (args) => db.execute([[sql, args]])
        .then(([result]) => result);
      return {
        all: (...args) => read(args.length === 1 && typeof args[0] === 'object' && args[0] !== null
          ? args[0] : args).then(({ rows }) => rows),
        get: (...args) => read(args).then(({ rows }) => rows[0]),
      };
    },
    close() {},
  };
  return createStore(adapter, (work) => db.transaction(async (execute) => {
    const operations = work();
    let step = operations.next();
    while (!step.done) step = operations.next(await execute(step.value));
    return step.value;
  }));
}

function* importOperations(hash, run) {
  const [{ rows: [existing] }] = yield [['SELECT run_id FROM Runs WHERE source_hash = ?', [hash]]];
  let runId = existing?.run_id;
  if (!existing) {
    const [, { rows: [saved] }] = yield [
      ['INSERT INTO Characters VALUES (?) ON CONFLICT DO NOTHING', [run.characterId]],
      [`INSERT INTO Runs (source_hash, character_id, play_mode, game_mode, player_count,
                          ascension, result, defeat_cause, build_id, schema_version, start_time)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING run_id`,
      [hash, run.characterId, run.playMode, run.gameMode, run.playerCount, run.ascension,
        run.result, run.defeatCause, run.buildId, run.schemaVersion, run.startTime ?? null]],
    ];
    runId = saved.run_id;
  }

  const statements = [];
  const roomInserts = [];
  const enchantmentInserts = [];
  let startTimeUpdate;
  const floorId = '(SELECT floor_record_id FROM FloorRecords WHERE run_id = ? AND act_number = ? AND visit_order = ?)';
  for (const floor of run.floors) {
    const visit = [runId, floor.actNumber, floor.visitOrder];
    if (!existing) {
      statements.push(
        [`INSERT INTO FloorRecords (run_id, act_number, visit_order, map_point_type, room_type,
                                    current_hp, max_hp, current_gold) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [...visit, floor.mapPointType, floor.roomType, floor.currentHp, floor.maxHp, floor.currentGold]],
      );
      for (const card of floor.cardChoices) {
        statements.push(
          ['INSERT INTO Cards VALUES (?) ON CONFLICT DO NOTHING', [card.cardId]],
          [`INSERT INTO CardChoices VALUES (${floorId}, ?, ?, ?, ?)`,
          [...visit, card.order, card.cardId, card.roomType, card.picked === null ? null : Number(card.picked)]],
        );
      }
      for (const action of floor.restActions) {
        statements.push([`INSERT INTO RunActions VALUES (${floorId}, 'rest', ?, ?)`,
          [...visit, action.order, action.code]]);
      }
    }
    for (const room of floor.rooms ?? []) {
      roomInserts.push({ index: statements.length, monsters: room.monsters });
      statements.push([`INSERT INTO VisitRooms (floor_record_id, room_order, room_type, model_id)
        SELECT floor_record_id, ?, ?, ? FROM FloorRecords
        WHERE run_id = ? AND act_number = ? AND visit_order = ?
        ON CONFLICT (floor_record_id, room_order) DO NOTHING RETURNING visit_room_id`,
      [room.order, room.roomType, room.modelId, ...visit]]);
    }
  }
  if (!existing) {
    for (const relic of run.relics) {
      statements.push(
        ['INSERT INTO Relics VALUES (?) ON CONFLICT DO NOTHING', [relic.relicId]],
        ['INSERT INTO RunRelics VALUES (?, ?, ?, ?)', [runId, relic.order, relic.relicId, relic.addedFloor]],
      );
    }
  }
  for (const card of run.deck) {
    const enchantment = card.enchantmentId ?? null;
    const amount = enchantment ? card.enchantmentAmount ?? null : null;
    if (!existing) {
      statements.push(
        ['INSERT INTO Cards VALUES (?) ON CONFLICT DO NOTHING', [card.cardId]],
        ['INSERT INTO RunDeckCards VALUES (?, ?, ?, ?, ?, ?)',
          [runId, card.order, card.cardId, card.upgradeLevel, enchantment, amount]],
      );
    } else if (enchantment) {
      enchantmentInserts.push(statements.length);
      statements.push([`UPDATE RunDeckCards SET enchantment_id = ?, enchantment_amount = ?
        WHERE run_id = ? AND card_order = ? AND card_id = ? AND enchantment_id IS NULL`,
      [enchantment, amount, runId, card.order, card.cardId]]);
    }
  }
  if (existing && run.startTime != null) {
    startTimeUpdate = statements.length;
    statements.push(['UPDATE Runs SET start_time = ? WHERE run_id = ? AND start_time IS NULL', [run.startTime, runId]]);
  }

  const results = statements.length ? yield statements : [];
  let roomsUpdated = 0;
  const monsters = [];
  for (const room of roomInserts) {
    const [saved] = results[room.index].rows;
    if (!saved) continue;
    roomsUpdated += 1;
    for (const monster of room.monsters) {
      monsters.push(['INSERT INTO RoomMonsters VALUES (?, ?, ?)', [saved.visit_room_id, monster.order, monster.id]]);
    }
  }
  if (monsters.length) yield monsters;
  if (!existing) return { status: 'imported', runId };
  return {
    status: 'duplicate',
    runId,
    enchantmentsUpdated: enchantmentInserts.reduce((sum, index) => sum + results[index].changes, 0),
    roomsUpdated,
    startTimeUpdated: (results[startTimeUpdate]?.changes ?? 0) > 0,
  };
}

function createStore(db, write) {
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
        AND ($result IS NULL OR result = $result)
    ),
    visits AS (
      SELECT floor_record_id, run_id,
        LOWER(COALESCE(TRIM(room_type), '')) AS room_type
      FROM FloorRecords JOIN matching_runs USING (run_id)
    ),
    classified_visits AS (
      SELECT *,
        room_type NOT IN ('', 'unknown') OR EXISTS (
          SELECT 1 FROM VisitRooms r WHERE r.floor_record_id = visits.floor_record_id
            AND LOWER(TRIM(r.room_type)) NOT IN ('', 'unknown')
        ) AS known_room
      FROM visits
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
      COUNT(*) FILTER (WHERE known_room) AS known_visits,
      COUNT(DISTINCT run_id) FILTER (WHERE known_room) AS known_runs,
      COUNT(*) FILTER (WHERE room_type = 'elite' OR EXISTS (
        SELECT 1 FROM VisitRooms r WHERE r.floor_record_id = classified_visits.floor_record_id
          AND LOWER(TRIM(r.room_type)) = 'elite'
      )) AS elite_visits,
      (SELECT COUNT(DISTINCT floor_record_id) FROM RunActions JOIN visits USING (floor_record_id)
        WHERE action_type = 'rest') AS rest_visits,
      (SELECT COUNT(DISTINCT run_id) FROM RunActions JOIN visits USING (floor_record_id)
        WHERE action_type = 'rest') AS rest_runs,
      (SELECT json_group_array(json_object('code', code, 'count', count, 'visits', visits))
        FROM (SELECT code, count, visits FROM rest_counts ORDER BY code)) AS rest_actions
    FROM classified_visits
  `);
  const findFloors = db.prepare(`
    SELECT floor_record_id, act_number, visit_order, map_point_type, room_type, current_hp, max_hp, current_gold
    FROM FloorRecords WHERE run_id = ? ORDER BY act_number, visit_order
  `);
  const findRooms = db.prepare(`
    SELECT VisitRooms.floor_record_id, VisitRooms.room_type, VisitRooms.model_id,
           (SELECT json_group_array(monster_id)
            FROM (
              SELECT monster_id FROM RoomMonsters
              WHERE visit_room_id = VisitRooms.visit_room_id
              ORDER BY monster_order
            )) AS monsters
    FROM VisitRooms JOIN FloorRecords USING (floor_record_id)
    WHERE FloorRecords.run_id = ?
    ORDER BY VisitRooms.floor_record_id, room_order
  `);
  const findRelics = db.prepare('SELECT relic_id, added_floor FROM RunRelics WHERE run_id = ? ORDER BY relic_order');
  const findDeck = db.prepare(`
    SELECT card_id, upgrade_level, enchantment_id, enchantment_amount
    FROM RunDeckCards WHERE run_id = ? ORDER BY card_order
  `);
  const deleteRunSql = 'DELETE FROM Runs WHERE run_id = ?';

  async function readTendency({ character, mode, ascension }, result = null) {
    const [analysis] = await tendencyAnalysis.all({ character, mode, ascension, result });
    return { ...analysis, rest_actions: JSON.parse(analysis.rest_actions) };
  }

  return {
    importRun(bytes, run) {
      const hash = createHash('sha256').update(bytes).digest('hex');
      return write(() => importOperations(hash, run));
    },
    async list({ character, mode, ascension, result }) {
      return {
        runs: await listRuns.all(character, character, mode, mode, ascension, ascension, result, result),
        characters: (await listCharacters.all()).map((row) => row.character_id),
      };
    },
    dashboard() {
      return dashboard.all();
    },
    cardAnalysis({ character, mode, ascension }) {
      return cardAnalysis.all({ character, mode, ascension });
    },
    async tendencyAnalysis(filters) {
      const analysis = await readTendency(filters);
      if (filters.character === null || filters.ascension === null) return analysis;
      return {
        ...analysis,
        comparison: {
          win: await readTendency(filters, 'win'),
          loss: await readTendency(filters, 'loss'),
        },
      };
    },
    async detail(id) {
      const run = await findRun.get(id);
      if (!run) return null;
      const roomsByFloor = new Map();
      for (const { floor_record_id: floorId, monsters, ...room } of await findRooms.all(id)) {
        if (!roomsByFloor.has(floorId)) roomsByFloor.set(floorId, []);
        roomsByFloor.get(floorId).push({ ...room, monster_ids: JSON.parse(monsters) });
      }
      const floors = (await findFloors.all(id)).map(({ floor_record_id: floorId, ...floor }) => ({
        ...floor, rooms: roomsByFloor.get(floorId) ?? [],
      }));
      return { run, floors, relics: await findRelics.all(id), deck: await findDeck.all(id) };
    },
    delete(id) {
      return write(function* () {
        const [result] = yield [[deleteRunSql, [id]]];
        return result.changes > 0;
      });
    },
    close() {
      db.close();
    },
  };
}

module.exports = { openDatabase, openTursoDatabase };
