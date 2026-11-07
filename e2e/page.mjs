// The page as a buyer uses it, for tests/page.rs: built for regtest with
// the test's servers as its VITE_* settings, served by `vite preview`, and
// driven in Chromium from Settings, where both servers must check out, and
// the Swap screen to the Fund screen. Then it only watches.
//
//   node e2e/page.mjs <config.json>
//
// The config: {esplora, nexus, genesis, relay, bounds, btc_amount,
// nex_address, port, out}. What the Fund screen asks for prints as one JSON
// line, `{"fund": {"address", "need"}}`; then, each time it changes, what
// the page shows: the current step, `{"step", "detail"}`, else the box
// headline, `{"box"}`, and any alert, `{"alert"}`. It exits once the page
// offers "Swap again", with a screenshot in `out` either way.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { build, preview } from 'vite';

const c = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const root = fileURLToPath(new URL('..', import.meta.url));
const outDir = join(c.out, 'site');
mkdirSync(c.out, { recursive: true });

// The build's settings: an environment variable overrides .env.
Object.assign(process.env, {
  VITE_NETWORK: 'regtest',
  VITE_ESPLORA: c.esplora,
  VITE_NEXUS: c.nexus,
  VITE_NEXUS_GENESIS: c.genesis,
  VITE_RELAY: c.relay,
  VITE_BOUNDS: JSON.stringify(c.bounds),
});
await build({ root, logLevel: 'warn', build: { outDir, emptyOutDir: true } });
// The test's servers are plain http on loopback, which the page's CSP
// leaves out of connect-src: the built page lets them in, the rest of its
// policy as built. Changed on disk, not answered by a route: Chromium takes
// a routed page for a public one, which may not reach loopback.
const index = join(outDir, 'index.html');
const CONNECT = "connect-src &#39;self&#39; https: wss:";
const html = readFileSync(index, 'utf8');
if (!html.includes(CONNECT)) throw new Error(`the page's CSP has no "${CONNECT}": ${html}`);
writeFileSync(index, html.replace(CONNECT, `${CONNECT} http://127.0.0.1:* ws://127.0.0.1:*`));
const server = await preview({ root, logLevel: 'warn', build: { outDir }, preview: { host: '127.0.0.1', port: c.port, strictPort: true } });
const site = `http://127.0.0.1:${c.port}/`;

const browser = await chromium.launch();
const context = await browser.newContext({ acceptDownloads: false });
// The Esplora shim sends no CORS headers, as Esplora does: added here.
await context.route(
  (url) => url.href.startsWith(`${c.esplora}/`),
  async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, headers: { ...response.headers(), 'access-control-allow-origin': '*' } });
  },
);

const page = await context.newPage();
page.on('console', (message) => console.error(`console: ${message.text()}`));
page.on('pageerror', (error) => console.error(`pageerror: ${error.message}`));
const main = page.getByRole('main');
const say = (line) => console.log(JSON.stringify(line));

try {
  await page.goto(site);
  // Settings checks both servers as it opens: the build's own, public and
  // reachable.
  const header = page.getByRole('banner');
  await header.getByRole('button', { name: 'Settings' }).click();
  await main.getByText('Reachable.').nth(1).waitFor({ timeout: 60_000 });
  await header.getByRole('button', { name: 'Swap', exact: true }).click();
  await main.getByText(/best of 1/).waitFor({ timeout: 60_000 });
  await page.getByLabel('You pay').fill(c.btc_amount);
  await page.getByLabel('Send NEX to').fill(c.nex_address);
  await main.getByRole('button', { name: 'Swap', exact: true }).click();
  await page.getByRole('heading', { name: 'Review swap' }).waitFor();
  await main.getByRole('button', { name: 'Start swap' }).click();
  await page.getByRole('heading', { name: 'Fund your wallet' }).waitFor({ timeout: 60_000 });
  const address = await main.locator('.address code').textContent();
  const needed = main.locator('.row', { hasText: 'Needed' }).locator('.strong');
  await needed.filter({ hasText: /^\d+\.\d{8} BTC$/ }).waitFor({ timeout: 60_000 });
  const need = Number((await needed.textContent()).replace(/ BTC$/, '').replace('.', ''));
  say({ fund: { address, need } });

  // Each kind of line said when it changes: the step or box, the alerts.
  const last = { shown: '', alerts: '' };
  const deadline = Date.now() + 20 * 60_000;
  for (;;) {
    if (Date.now() > deadline) throw new Error('timed out');
    const { alerts, shown, again } = await page.evaluate(() => {
      const main = document.querySelector('main');
      const alerts = [...main.querySelectorAll('[role="alert"]')].map((alert) => ({ alert: alert.textContent }));
      const step = main.querySelector('li[aria-current="step"]');
      const box = main.querySelector('.box.strong-border > .strong');
      const shown = step
        ? { step: step.querySelector('.step-title').textContent, detail: step.querySelector('.step-body > .small.muted')?.textContent ?? '' }
        : box && { box: box.textContent };
      const again = [...main.querySelectorAll('button')].some((button) => button.textContent === 'Swap again');
      return { alerts, shown, again };
    });
    if (JSON.stringify(alerts) !== last.alerts) {
      last.alerts = JSON.stringify(alerts);
      alerts.forEach(say);
    }
    if (shown && JSON.stringify(shown) !== last.shown) {
      last.shown = JSON.stringify(shown);
      say(shown);
    }
    if (again) break;
    await page.waitForTimeout(200);
  }
  await page.screenshot({ path: join(c.out, 'end.png'), fullPage: true });
} catch (e) {
  console.error(e);
  await page.screenshot({ path: join(c.out, 'failure.png'), fullPage: true }).catch(() => {});
  process.exitCode = 1;
}
await browser.close();
await server.close();
process.exit();
