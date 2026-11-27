const CACHE_MS = 5 * 60 * 1000;
const RETRY_MS = 60 * 1000;

function createCommunityAscensionStats(fetchStats = fetch) {
  const cache = new Map();

  function load(players) {
    const cached = cache.get(players);
    if (cached && cached.expires > Date.now()) return cached.result;

    const url = new URL('https://spire-codex.com/api/charts/winrate-by-ascension');
    url.searchParams.set('split', 'character');
    if (players) url.searchParams.set('players', players);
    const entry = { expires: Infinity };
    entry.result = (async () => {
      try {
        const response = await fetchStats(url, { signal: AbortSignal.timeout(2500) });
        if (!response.ok) return null;
        const { series } = await response.json();
        return Array.isArray(series) ? series : null;
      } catch {
        return null;
      }
    })().then((series) => {
      entry.expires = Date.now() + (series ? CACHE_MS : RETRY_MS);
      return series;
    });
    cache.set(players, entry);
    return entry.result;
  }

  return async function lookup({ mode, character }) {
    const playerCounts = mode === 'multi' ? [2, 3, 4] : [mode === 'single' ? 1 : null];
    const charts = await Promise.all(playerCounts.map(load));
    if (charts.some((chart) => chart === null)) return null;

    const id = character ? character.replace(/^CHARACTER\./i, '').toUpperCase() : 'ALL';
    const totals = new Map();
    for (const chart of charts) {
      const points = chart.find((series) => series?.id === id)?.points;
      if (!Array.isArray(points)) continue;
      for (const { x, y, n } of points.filter(Boolean)) {
        if (!Number.isSafeInteger(x) || x < 0 || !Number.isSafeInteger(n) || n <= 0 ||
            !Number.isFinite(y) || y < 0 || y > 100) continue;
        const total = totals.get(x) ?? { sample: 0, weightedRate: 0 };
        total.sample += n;
        total.weightedRate += y / 100 * n;
        totals.set(x, total);
      }
    }
    return Array.from(totals, ([ascension, { sample, weightedRate }]) =>
      ({ ascension, sample, win_rate: weightedRate / sample }));
  };
}

module.exports = { createCommunityAscensionStats };
