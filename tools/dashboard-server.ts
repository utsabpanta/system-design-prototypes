/**
 * Serves the dashboard and proxies /api/overview to the admin API.
 *
 * The proxy exists so the page has a same-origin endpoint and does not need
 * the admin URL baked in — the URL changes on every LocalStack reset, and
 * hardcoding it would make the dashboard the one artefact you edit by hand
 * after each redeploy.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import { adminEndpoint } from '../packages/shared/endpoints.js';

const PORT = Number(process.env.DASHBOARD_PORT ?? 4000);
const here = path.dirname(fileURLToPath(import.meta.url));
const INDEX = path.resolve(here, '../dashboard/index.html');

/**
 * Resolved lazily and re-resolved on failure rather than once at startup: the
 * admin API's hostname changes whenever the control plane is redeployed, and a
 * long-running dashboard should pick that up instead of 502-ing until restart.
 */
let cachedAdmin: string | undefined;
async function admin(force = false): Promise<string> {
  if (force || !cachedAdmin) cachedAdmin = await adminEndpoint();
  return cachedAdmin;
}

const server = createServer(async (req, res) => {
  try {
    if (req.url?.startsWith('/api/overview')) {
      let upstream = await fetch(`${await admin()}/admin/overview`, {
        signal: AbortSignal.timeout(20_000),
      }).catch(() => undefined);

      if (!upstream || !upstream.ok) {
        // Stale endpoint after a redeploy is the likely cause; re-resolve once.
        upstream = await fetch(`${await admin(true)}/admin/overview`, {
          signal: AbortSignal.timeout(20_000),
        });
      }

      const body = await upstream.text();
      res.writeHead(upstream.status, { 'content-type': 'application/json' });
      res.end(body);
      return;
    }

    // Read per request rather than caching, so editing the page is just a refresh.
    const html = await readFile(INDEX, 'utf8');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
  } catch (err) {
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
  }
});

server.listen(PORT, async () => {
  console.log(`dashboard   http://localhost:${PORT}`);
  try {
    console.log(`admin api   ${await admin()}`);
  } catch {
    console.log('admin api   (not resolved yet — is ControlPlane deployed?)');
  }
  console.log('\nctrl-c to stop');
});
