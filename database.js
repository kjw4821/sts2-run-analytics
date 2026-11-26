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
        db.exec('PRAGMA user_version = 1');
      } else if (version !== 1) {
        throw new Error(`지원하지 않는 DB 버전입니다. (${version})`);
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
                      ascension, result, defeat_cause, build_id, schema_version)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const addFloor = db.prepare(`
    INSERT INTO FloorRecords (run_id, act_number, visit_order, map_point_type, room_type,
                              current_hp, max_hp, current_gold) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const addChoice = db.prepare('INSERT INTO CardChoices VALUES (?, ?, ?, ?, ?)');
  const addAction = db.prepare("INSERT INTO RunActions VALUES (?, 'rest', ?, ?)");
  const addRunRelic = db.prepare('INSERT INTO RunRelics VALUES (?, ?, ?, ?)');
  const addDeckCard = db.prepare('INSERT INTO RunDeckCards VALUES (?, ?, ?, ?)');
  const runColumns = 'run_id, character_id, play_mode, game_mode, player_count, ascension, result';
  const findRun = db.prepare(`SELECT ${runColumns}, defeat_cause, build_id FROM Runs WHERE run_id = ?`);
  const listRuns = db.prepare(`
    SELECT ${runColumns} FROM Runs
    WHERE (? IS NULL OR character_id = ?) AND (? IS NULL OR play_mode = ?)
      AND (? IS NULL OR ascension = ?) AND (? IS NULL OR result = ?)
    ORDER BY run_id DESC
  `);
  const listCharacters = db.prepare('SELECT DISTINCT character_id FROM Runs ORDER BY character_id');
  const findFloors = db.prepare(`
    SELECT act_number, visit_order, map_point_type, room_type, current_hp, max_hp, current_gold
    FROM FloorRecords WHERE run_id = ? ORDER BY act_number, visit_order
  `);
  const findRelics = db.prepare('SELECT relic_id, added_floor FROM RunRelics WHERE run_id = ? ORDER BY relic_order');
  const findDeck = db.prepare('SELECT card_id, upgrade_level FROM RunDeckCards WHERE run_id = ? ORDER BY card_order');
  const deleteRun = db.prepare('DELETE FROM Runs WHERE run_id = ?');

  return {
    importRun(bytes, run) {
      const hash = createHash('sha256').update(bytes).digest('hex');
      return transaction(() => {
        const existing = findHash.get(hash);
        if (existing) return { status: 'duplicate', runId: existing.run_id };

        addCharacter.run(run.characterId);
        const { lastInsertRowid: runId } = addRun.run(hash, run.characterId, run.playMode,
          run.gameMode, run.playerCount, run.ascension, run.result, run.defeatCause,
          run.buildId, run.schemaVersion);
        for (const floor of run.floors) {
          const { lastInsertRowid: floorId } = addFloor.run(runId, floor.actNumber,
            floor.visitOrder, floor.mapPointType, floor.roomType, floor.currentHp,
            floor.maxHp, floor.currentGold);
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
          addDeckCard.run(runId, card.order, card.cardId, card.upgradeLevel);
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
    detail(id) {
      const run = findRun.get(id);
      if (!run) return null;
      return { run, floors: findFloors.all(id), relics: findRelics.all(id), deck: findDeck.all(id) };
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
