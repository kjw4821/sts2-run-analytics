const { mkdirSync } = require('node:fs');
const { basename, dirname, join, resolve } = require('node:path');
const express = require('express');
const { openDatabase } = require('./database');
const { createGameNames } = require('./game-names');
const { parseRun, selectRunPlayer, extractRun } = require('./run-record');

const MAX_FILE_BYTES = 16 * 1024 * 1024;
function json(response, status, payload) {
  return response.set('Cache-Control', 'no-store').status(status).json(payload);
}

function positiveId(text) {
  const value = Number(text);
  return /^\d+$/.test(text) && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function readFilters(params) {
  const character = params.get('character') || null;
  const mode = params.get('mode') || null;
  const result = params.get('result') || null;
  const level = params.get('ascension');
  const ascension = level ? Number(level) : null;
  if ((mode !== null && !['single', 'multi'].includes(mode)) ||
      (result !== null && !['win', 'loss', 'abandoned', 'unknown'].includes(result)) ||
      (level && (!/^\d+$/.test(level) || !Number.isSafeInteger(ascension)))) return null;
  return { character, mode, ascension, result };
}

function validateUpload(request, response, next) {
  const { filename } = request.query;
  if (!request.is('application/octet-stream') || typeof filename !== 'string' ||
      basename(filename) !== filename || !/\.run$/i.test(filename)) {
    return json(response, 400, { message: '.run 파일을 선택해 주세요.' });
  }
  return next();
}

function importFile(request, response, database) {
  const bytes = request.body;
  let run;
  try {
    run = parseRun(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return json(response, 400, { message: 'UTF-8 JSON 기록 파일을 읽을 수 없습니다.' });
  }
  let record;
  try {
    const player = selectRunPlayer(run, (request.headers['x-player-id'] || '').trim());
    record = extractRun(run, player);
  } catch (error) {
    return json(response, 400, { message: error.message });
  }
  const result = database.importRun(bytes, record);
  return json(response, result.status === 'imported' ? 201 : 200, { ...result, playMode: record.playMode });
}

function createApp(database, gameNames = createGameNames()) {
  const app = express();
  app.disable('x-powered-by');
  app.enable('case sensitive routing');
  app.enable('strict routing');
  app.use((request, response, next) => {
    const host = request.headers.host || '';
    if (!/^(?:localhost|127\.0\.0\.1)(?::\d+)?$/i.test(host) ||
        (request.headers.origin && request.headers.origin !== `http://${host}`)) {
      return json(response, 403, { message: '로컬 주소에서 접속해 주세요.' });
    }
    return next();
  });

  for (const [route, filename] of [['/', 'index.html'], ['/app.js', 'app.js'], ['/styles.css', 'styles.css']]) {
    app.get(route, (_request, response) => {
      response.set('Cache-Control', 'no-cache').sendFile(filename, { root: __dirname });
    });
  }

  app.post('/api/import', validateUpload,
    express.raw({ type: 'application/octet-stream', limit: MAX_FILE_BYTES, inflate: false }),
    (request, response) => importFile(request, response, database));
  app.get('/api/dashboard', async (_request, response) => {
    const groups = database.dashboard();
    const ids = [...new Set(groups.map((group) => group.character_id).filter(Boolean))];
    const names = await gameNames.lookup(ids, 'CHARACTER');
    return json(response, 200, { groups, characterNames: Object.fromEntries(names) });
  });
  app.get('/api/card-analysis', async (request, response) => {
    const filters = readFilters(new URL(request.originalUrl, 'http://localhost').searchParams);
    if (!filters) return json(response, 400, { message: '필터 값을 확인해 주세요.' });
    const rows = database.cardAnalysis(filters).filter((row) => row.picked > 0);
    const ids = rows.map((row) => row.card_id);
    const [rarities, types] = await Promise.all([
      gameNames.lookup(ids, 'CARD', 'rarity'),
      gameNames.lookup(ids, 'CARD', 'type'),
    ]);
    const ranked = rows.filter(({ card_id: id }) => rarities.get(id) !== 'basic')
      .sort((a, b) => b.picked - a.picked || a.offered - b.offered || a.card_id.localeCompare(b.card_id));
    const leaders = ['attack', 'skill', 'power'].flatMap((type) =>
      ranked.filter(({ card_id: id }) => types.get(id) === type).slice(0, 3)
        .map((row) => ({ ...row, type })));
    const leaderIds = leaders.map((row) => row.card_id);
    const [names, fullImages, portraits] = await Promise.all([
      gameNames.lookup(leaderIds, 'CARD'),
      gameNames.lookup(leaderIds, 'CARD', 'fullImage'),
      gameNames.lookup(leaderIds, 'CARD', 'image'),
    ]);
    return json(response, 200, { cards: leaders.map((row) => ({
      ...row,
      name: names.get(row.card_id) ?? row.card_id,
      full_image_url: fullImages.get(row.card_id) ?? null,
      image_url: portraits.get(row.card_id) ?? null,
    })) });
  });
  app.get('/api/tendency-analysis', (request, response) => {
    const filters = readFilters(new URL(request.originalUrl, 'http://localhost').searchParams);
    if (!filters) return json(response, 400, { message: '필터 값을 확인해 주세요.' });
    return json(response, 200, database.tendencyAnalysis(filters));
  });
  app.get('/api/runs', async (request, response) => {
    const filters = readFilters(new URL(request.originalUrl, 'http://localhost').searchParams);
    if (!filters) return json(response, 400, { message: '필터 값을 확인해 주세요.' });
    const list = database.list(filters);
    const characterNames = await gameNames.lookup(list.characters, 'CHARACTER');
    return json(response, 200, { ...list, characterNames: Object.fromEntries(characterNames) });
  });
  app.get('/api/runs/:id', async (request, response, next) => {
    const id = positiveId(request.params.id);
    const record = id && database.detail(id);
    if (!record) return next();
    const { run, floors, relics, deck } = record;
    const [characters, causes, displayRelics, cards, visits] = await Promise.all([
      gameNames.lookup([run.character_id], 'CHARACTER'),
      gameNames.lookup([run.defeat_cause]),
      gameNames.relicDetails(relics),
      gameNames.cardDetails(deck),
      gameNames.visitDetails(floors),
    ]);
    return json(response, 200, {
      ...record,
      run: {
        ...run,
        character_name: characters.get(run.character_id) ?? null,
        defeat_cause_name: causes.get(run.defeat_cause) ?? null,
      },
      relics: displayRelics,
      deck: cards,
      floors: visits,
    });
  });
  app.delete('/api/runs/:id', (request, response, next) => {
    const id = positiveId(request.params.id);
    return id && database.delete(id) ? response.status(204).end() : next();
  });
  app.use((_request, response) => json(response, 404, { message: '요청한 기록을 찾을 수 없습니다.' }));
  app.use((error, _request, response, next) => {
    if (response.headersSent) return next(error);
    if (error.type === 'entity.too.large') {
      return json(response, 413, { message: '파일 한 개는 최대 16 MiB까지 가져올 수 있습니다.' });
    }
    if (error.type === 'encoding.unsupported') {
      return json(response, 415, { message: '압축하지 않은 .run 파일을 보내 주세요.' });
    }
    if (error.status === 400) {
      return json(response, 400, { message: '요청 형식을 확인해 주세요.' });
    }
    console.error(error.message);
    return json(response, 500, { message: '서버에서 기록을 처리하지 못했습니다.' });
  });
  return app;
}

if (require.main === module) {
  const filename = resolve(process.env.SPIRE_DB_PATH || join(__dirname, 'data', 'runs.sqlite'));
  mkdirSync(dirname(filename), { recursive: true });
  const database = openDatabase(filename);
  const port = Number(process.env.PORT || 3000);
  const server = createApp(database).listen(port, '127.0.0.1', () => {
    console.log(`Spire Analytics http://127.0.0.1:${server.address().port}`);
  });
  server.on('close', () => database.close());
}

module.exports = { createApp };
