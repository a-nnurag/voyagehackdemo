// Netlify Function: runs the unchanged OpsDesk server inside the function and forwards /api/* to it.
// shortcut: SQLite lives in /tmp, so data reseeds on each cold start and is per function instance —
// fine for a demo; move to a hosted database if several people must share live state.
process.env.DB_FILE ||= '/tmp/opsdesk.db';
process.env.OPSDESK_EMBEDDED = '1';
const { default: server } = await import('../../server.js');

const base = await new Promise(ok => server.listen(0, '127.0.0.1', () => ok(`http://127.0.0.1:${server.address().port}`)));

export default async req => {
  const u = new URL(req.url);
  const hasBody = !['GET', 'HEAD'].includes(req.method);
  return fetch(base + u.pathname + u.search, { method: req.method, headers: req.headers, body: hasBody ? await req.text() : undefined });
};

export const config = { path: '/api/*' };
