const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const endpoints = {
  CHARACTER: 'characters',
  CARD: 'cards',
  RELIC: 'relics',
  ENCOUNTER: 'encounters',
  EVENT: 'events',
};
const CACHE_MS = 60 * 60 * 1000;
const RETRY_MS = 60 * 1000;
const LOCAL_DIRECTORY = join(__dirname, 'data', 'spire-codex-kor');

function readNames(entries) {
  if (!Array.isArray(entries)) throw new TypeError('Expected a catalog array');
  const names = new Map();
  for (const entry of entries) {
    if (typeof entry?.id !== 'string' || typeof entry.name !== 'string') continue;
    const id = entry.id.trim().toUpperCase();
    const name = entry.name.trim();
    if (id && name) names.set(id, name);
  }
  return names;
}

function createGameNames(fetchCatalog = fetch, localDirectory = LOCAL_DIRECTORY) {
  const localCatalogs = new Map();
  const cache = new Map();

  for (const [type, endpoint] of Object.entries(endpoints)) {
    const filename = `${endpoint}.json`;
    try {
      const content = readFileSync(join(localDirectory, filename), 'utf8');
      localCatalogs.set(type, readNames(JSON.parse(content.replace(/^\uFEFF/, ''))));
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.warn(`Spire Codex: ${filename} could not be loaded; using the API for its names.`);
      }
    }
  }

  async function fetchNames(endpoint, beta, entry) {
    const url = new URL(`https://spire-codex.com/api/${endpoint}?lang=kor`);
    if (beta) url.searchParams.set('channel', 'beta');

    let delay = RETRY_MS;
    try {
      const response = await fetchCatalog(url, { signal: AbortSignal.timeout(2500) });
      if (!response.ok) {
        const retryAfter = response.headers.get('retry-after');
        if (response.status === 429 && retryAfter) {
          const retryMs = /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - Date.now();
          if (Number.isFinite(retryMs)) delay = Math.max(delay, retryMs);
        }
        return;
      }

      const names = readNames(await response.json());
      if (!names.size) return;
      entry.names = names;
      delay = CACHE_MS;
    } catch {
      // Keep the last successful catalog if the upstream request fails.
    } finally {
      entry.expires = Date.now() + delay;
    }
  }

  function catalog(endpoint, beta) {
    const key = `${endpoint}:${beta}`;
    let entry = cache.get(key);
    if (!entry) {
      entry = { expires: 0, names: new Map(), pending: null };
      cache.set(key, entry);
    }
    if (entry.pending) return entry.pending;
    if (Date.now() < entry.expires) return entry.names;
    entry.pending = fetchNames(endpoint, beta, entry).then(() => {
      entry.pending = null;
      return entry.names;
    });
    return entry.pending;
  }

  async function lookup(ids, defaultType) {
    const missing = [];
    const catalogs = new Map();
    const names = new Map();
    for (const raw of ids) {
      if (typeof raw !== 'string') continue;
      const id = raw.trim().toUpperCase();
      const separator = id.indexOf('.');
      const type = separator === -1 ? defaultType : id.slice(0, separator);
      if (!Object.hasOwn(endpoints, type) || (defaultType && type !== defaultType)) continue;
      const key = id.slice(separator + 1);
      const localName = localCatalogs.get(type)?.get(key);
      if (localName !== undefined) {
        names.set(raw, localName);
        continue;
      }
      const endpoint = endpoints[type];
      if (!catalogs.has(type)) {
        catalogs.set(type, Promise.all([catalog(endpoint, false), catalog(endpoint, true)]));
      }
      missing.push({ raw, type, key });
    }
    const loaded = new Map(await Promise.all(Array.from(catalogs, async ([type, request]) =>
      [type, await request])));
    for (const { raw, type, key } of missing) {
      const [stable, beta] = loaded.get(type);
      const name = stable.get(key) ?? beta.get(key);
      if (name !== undefined) names.set(raw, name);
    }
    return names;
  }

  return { lookup };
}

module.exports = { createGameNames };
