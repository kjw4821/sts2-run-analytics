const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const endpoints = {
  CHARACTER: 'characters',
  CARD: 'cards',
  RELIC: 'relics',
  ENCOUNTER: 'encounters',
  EVENT: 'events',
  MONSTER: 'monsters',
  ENCHANTMENT: 'enchantments',
};
const CACHE_MS = 60 * 60 * 1000;
const RETRY_MS = 60 * 1000;
const LOCAL_DIRECTORY = join(__dirname, 'data', 'spire-codex-kor');

function koreanCardRender(value) {
  if (typeof value !== 'string') return undefined;
  const match = /^https:\/\/cdn\.spire-codex\.com\/cards-full\/(stable|beta)\/(?:kor\/|eng\/)?([\w-]+\.webp)$/i.exec(value);
  if (match) return `https://cdn.spire-codex.com/cards-full/${match[1]}/kor/${match[2]}`;
}

function readCatalog(entries) {
  if (!Array.isArray(entries)) throw new TypeError('Expected a catalog array');
  const catalog = new Map();
  for (const entry of entries) {
    if (typeof entry?.id !== 'string' || typeof entry.name !== 'string') continue;
    const id = entry.id.trim().toUpperCase();
    const name = entry.name.trim();
    if (id && name) {
      const image = [entry.image_url, entry.beta_image_url].find((path) =>
        typeof path === 'string' && /^\/static\/images\/(?:cards|relics|monsters|events|misc\/ancients)\/(?:beta\/)?[\w-]+\.(?:webp|png)$/i.test(path));
      catalog.set(id, {
        name,
        rarity: typeof entry.rarity_key === 'string' ? entry.rarity_key.toLowerCase() : undefined,
        type: typeof entry.type_key === 'string' ? entry.type_key.toLowerCase() : undefined,
        image: image && `https://spire-codex.com${image}`,
        fullImage: koreanCardRender(entry.image_url_card),
        upgradedImage: koreanCardRender(entry.image_url_card_upg),
        description: typeof entry.description === 'string' ? entry.description : undefined,
        enchantmentEffect: typeof entry.description_raw === 'string' && entry.description_raw.includes('{Amount}')
          ? entry.description_raw
          : typeof entry.description === 'string' ? entry.description : undefined,
        upgradeDescription: typeof entry.upgrade_description === 'string' ? entry.upgrade_description : undefined,
      });
    }
  }
  return catalog;
}

function createGameNames(fetchCatalog = fetch, localDirectory = LOCAL_DIRECTORY) {
  const localCatalogs = new Map();
  const cache = new Map();

  for (const [type, endpoint] of Object.entries(endpoints)) {
    const filename = `${endpoint}.json`;
    try {
      const content = readFileSync(join(localDirectory, filename), 'utf8');
      localCatalogs.set(type, readCatalog(JSON.parse(content.replace(/^\uFEFF/, ''))));
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

      const names = readCatalog(await response.json());
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

  async function lookup(ids, defaultType, field = 'name') {
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
      const localName = localCatalogs.get(type)?.get(key)?.[field];
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
      const name = stable.get(key)?.[field] ?? beta.get(key)?.[field];
      if (name !== undefined) names.set(raw, name);
    }
    return names;
  }

  async function cardDetails(deck) {
    // Run files omit the upgrade level for base cards. Existing databases store this as NULL.
    const displayedDeck = deck.map((card) => ({ ...card, upgrade_level: card.upgrade_level ?? 0 }));
    const ids = [...new Set(displayedDeck.map((card) => card.card_id))];
    const baseIds = [...new Set(displayedDeck.filter((card) => card.upgrade_level === 0).map((card) => card.card_id))];
    const upgradedIds = [...new Set(displayedDeck.filter((card) => card.upgrade_level === 1).map((card) => card.card_id))];
    const enchantmentIds = [...new Set(displayedDeck.map((card) => card.enchantment_id).filter(Boolean))];
    const [names, rarities, portraits, base, upgraded, descriptions, upgradeDescriptions,
      enchantmentNames, enchantmentEffects] = await Promise.all([
      lookup(ids, 'CARD'),
      lookup(ids, 'CARD', 'rarity'),
      lookup(ids, 'CARD', 'image'),
      lookup(baseIds, 'CARD', 'fullImage'),
      lookup(upgradedIds, 'CARD', 'upgradedImage'),
      lookup(baseIds, 'CARD', 'description'),
      lookup(upgradedIds, 'CARD', 'upgradeDescription'),
      lookup(enchantmentIds, 'ENCHANTMENT'),
      lookup(enchantmentIds, 'ENCHANTMENT', 'enchantmentEffect'),
    ]);
    return displayedDeck.map((card) => ({
      ...card,
      name: names.get(card.card_id) ?? null,
      rarity: rarities.get(card.card_id) ?? null,
      enchantment_name: enchantmentNames.get(card.enchantment_id) ?? null,
      enchantment_effect: enchantmentEffects.get(card.enchantment_id)
        ?.replaceAll('{Amount}', card.enchantment_amount ?? 'X')
        .replace(/\[\/?[a-z]+\]/gi, '') ?? null,
      image_url: portraits.get(card.card_id) ?? null,
      full_image_url: (card.upgrade_level === 0 ? base.get(card.card_id) :
        card.upgrade_level === 1 ? upgraded.get(card.card_id) : null) ?? null,
      description: (card.upgrade_level === 0 ? descriptions.get(card.card_id) :
        card.upgrade_level === 1 ? upgradeDescriptions.get(card.card_id) : null) ?? null,
    }));
  }

  async function relicDetails(relics) {
    const ids = [...new Set(relics.map((relic) => relic.relic_id))];
    const [names, images, descriptions] = await Promise.all([
      lookup(ids, 'RELIC'),
      lookup(ids, 'RELIC', 'image'),
      lookup(ids, 'RELIC', 'description'),
    ]);
    return relics.map((relic) => ({
      ...relic,
      name: names.get(relic.relic_id) ?? null,
      image_url: images.get(relic.relic_id) ?? null,
      description: descriptions.get(relic.relic_id)?.replace(/\[\/?[a-z]+\]/gi, '') ?? null,
    }));
  }

  async function visitDetails(floors) {
    const rooms = floors.flatMap((floor) => floor.rooms);
    const models = [...new Set(rooms.map((room) => room.model_id).filter(Boolean))];
    const monsters = [...new Set(rooms.flatMap((room) => room.monster_ids))];
    const [modelNames, eventImages, monsterNames, monsterImages] = await Promise.all([
      lookup(models),
      lookup(models, 'EVENT', 'image'),
      lookup(monsters, 'MONSTER'),
      lookup(monsters, 'MONSTER', 'image'),
    ]);
    return floors.map((floor) => ({
      ...floor,
      rooms: floor.rooms.map((room) => ({
        ...room,
        name: modelNames.get(room.model_id) ?? null,
        image_url: eventImages.get(room.model_id) ?? null,
        monsters: room.monster_ids.map((id) => ({
          id, name: monsterNames.get(id) ?? null, image_url: monsterImages.get(id) ?? null,
        })),
      })),
    }));
  }

  return { lookup, cardDetails, relicDetails, visitDetails };
}

module.exports = { createGameNames };
