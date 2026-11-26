// Turso SQL over HTTP uses a baton to keep a transaction on one connection.
function encode(value) {
  if (value === null) return { type: 'null' };
  if (typeof value === 'string') return { type: 'text', value };
  if (Number.isSafeInteger(value)) return { type: 'integer', value: String(value) };
  throw new TypeError('Unsupported SQL parameter');
}

function statement(sql, args = []) {
  if (Array.isArray(args)) return { sql, args: args.map(encode) };
  return { sql, named_args: Object.entries(args).map(([name, value]) => ({ name, value: encode(value) })) };
}

function decode(result) {
  return {
    rows: result.rows.map((row) => Object.fromEntries(row.map(({ type, value }, index) => [
      result.cols[index].name, type === 'integer' || type === 'float' ? Number(value) : value ?? null,
    ]))),
    changes: result.affected_row_count,
  };
}

function connectTurso(databaseUrl, token, request = fetch) {
  const url = new URL(databaseUrl.replace(/^(?:libsql|turso):\/\//i, 'https://'));
  if (url.protocol !== 'https:' || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash || !token) {
    throw new Error('Check the Turso database URL and auth token.');
  }

  function connection() {
    let baton = null;
    let endpoint = new URL('/v2/pipeline', url);

    return async (statements, close = true) => {
      const requests = statements.map(([sql, args]) => ({ type: 'execute', stmt: statement(sql, args) }));
      if (close) requests.push({ type: 'close' });
      const response = await request(endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ baton, requests }),
        redirect: 'error',
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) throw new Error(`Turso HTTP request failed (${response.status})`);
      const payload = await response.json();
      baton = payload.baton;
      if (payload.base_url) {
        const next = new URL('/v2/pipeline', payload.base_url);
        if (next.protocol !== 'https:' || next.origin !== url.origin) {
          throw new Error('Turso returned an unexpected connection URL.');
        }
        endpoint = next;
      }
      if (!close && !baton) throw new Error('Turso did not retain the transaction connection.');
      if (payload.results.length !== requests.length) throw new Error('Incomplete Turso response.');
      return payload.results.flatMap(({ type, error, response: item }, index) => {
        if (type === 'error') {
          // SQL templates contain no bound values or credentials.
          const operation = statements[index]?.[0].trim().split(/\s+/).slice(0, 5).join(' ') ?? 'close';
          const detail = error.code === 'SQL_PARSE_ERROR' && typeof error.message === 'string'
            ? `: ${error.message.replace(/\s+/g, ' ').slice(0, 200)}` : '';
          throw new Error(`Turso SQL failed (${error.code ?? 'unknown'}) at ${operation}${detail}`);
        }
        return item.type === 'execute' ? [decode(item.result)] : [];
      });
    };
  }

  return {
    execute: (statements) => connection()(statements),
    async transaction(work) {
      const execute = connection();
      try {
        const [, { rows: [settings] }] = await execute([
          ['PRAGMA foreign_keys = 1'], ['PRAGMA foreign_keys'], ['BEGIN IMMEDIATE'],
        ], false);
        if (settings?.foreign_keys !== 1) throw new Error('Turso foreign key checks are disabled.');
        const result = await work(async (statements) => {
          const results = [];
          for (let offset = 0; offset < statements.length; offset += 100) {
            results.push(...await execute(statements.slice(offset, offset + 100), false));
          }
          return results;
        });
        await execute([['COMMIT']]);
        return result;
      } catch (error) {
        await execute([['ROLLBACK']]).catch(() => {});
        throw error;
      }
    },
  };
}

module.exports = { connectTurso };
