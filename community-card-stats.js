const CACHE_MS = 5 * 60 * 1000;
const RETRY_MS = 60 * 1000;

function normalizeId(id) {
  return id.replace(/^(CARD|CHARACTER)\./i, '').toUpperCase();
}

function parseRate(rate) {
  return Number.isFinite(rate) && rate >= 0 && rate <= 100 ? rate / 100 : null;
}

function createCommunityCardStats(fetchStats = fetch) {
  const cache = new Map();

  async function load(url) {
    try {
      const response = await fetchStats(url, { signal: AbortSignal.timeout(2500) });
      if (!response.ok) return null;
      const { rows } = await response.json();
      if (!Array.isArray(rows)) return null;
      const rates = new Map();
      for (const row of rows) {
        if (typeof row?.id !== 'string' || row.upgraded) continue;
        const winRate = parseRate(row.win_rate);
        const hasSample = Number.isSafeInteger(row.picks) && row.picks > 0 &&
          Number.isSafeInteger(row.wins) && row.wins >= 0 && row.wins <= row.picks;
        rates.set(normalizeId(row.id), {
          pickRate: parseRate(row.pick_rate),
          holding: winRate === null ? null : {
            winRate,
            wins: hasSample ? row.wins : null,
            sample: hasSample ? row.picks : null,
          },
        });
      }
      return rates;
    } catch {
      return null;
    }
  }

  return async function lookup(filters, ids) {
    if (!ids.length) return { rates: new Map(), holdings: new Map(), scope: null };
    const bracketParts = [];
    if (filters.mode === 'single') bracketParts.push('solo');
    if (filters.ascension === 10) bracketParts.push('a10');
    const bracket = bracketParts.join(':') || 'all';
    const character = filters.character ? normalizeId(filters.character) : null;
    const url = new URL('https://spire-codex.com/api/runs/metrics/cards');
    url.searchParams.set('bracket', bracket);
    if (character) url.searchParams.set('character', character);
    const key = url.href;
    let entry = cache.get(key);
    if (!entry || entry.expires <= Date.now()) {
      entry = { expires: Infinity };
      entry.result = load(url).then((rates) => {
        entry.expires = Date.now() + (rates ? CACHE_MS : RETRY_MS);
        return rates;
      });
      cache.set(key, entry);
      if (cache.size > 64) cache.delete(cache.keys().next().value);
    }
    const rates = await entry.result;
    return {
      rates: new Map(ids.map((id) => [id, rates?.get(normalizeId(id))?.pickRate ?? null])),
      holdings: new Map(ids.map((id) => [id, rates?.get(normalizeId(id))?.holding ?? null])),
      scope: { character, bracket, available: rates !== null },
    };
  };
}

module.exports = { createCommunityCardStats };
