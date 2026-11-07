import { useEffect, useState } from 'preact/hooks';
import { checkEsplora, checkNexusNode, DEFAULTS } from 'lattice-swap-driver';
import { saveSetting, type AppConfig, type Setting } from '../config';
import { bounded } from '../format';

/** `url`'s host, or `url` if it is none. */
function host(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** What a check of a server found: null while it runs. */
type Checked = { ok: boolean; text: string } | null;

/** The driver's reason for refusing a server, or why it could not be
 * read. */
const why = (e: Error) => (e.message.startsWith('refused:') ? e.message : `Unreachable: ${e.message}`);

export function Settings({
  config,
  onRestore,
  swapRuns,
}: {
  config: AppConfig;
  onRestore: (file: string) => Promise<void>;
  /** Whether a swap is running, asked of the wallet: it keeps the servers
   * it started with, as a reload on others would carry it on there. */
  swapRuns: () => Promise<boolean>;
}) {
  const [esplora, setEsplora] = useState(config.esplora);
  const [nexus, setNexus] = useState(config.nexus);
  const [restore, setRestore] = useState<{ ok: boolean; text: string } | null>(null);
  const [checked, setChecked] = useState<Record<Setting, Checked>>({ esplora: null, nexus: null });
  const [saving, setSaving] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const genesis = config.nexusGenesis ?? DEFAULTS.nexusGenesis;
  const fetch = config.driver?.fetch as typeof globalThis.fetch | undefined;
  const check: Record<Setting, (url: string) => Promise<void>> = {
    esplora: (url) => checkEsplora(url, config.network, fetch),
    nexus: (url) => checkNexusNode(url, genesis, fetch),
  };
  const changed = esplora.trim() !== config.esplora || nexus.trim() !== config.nexus;

  // The servers in use, checked as the page opens Settings.
  useEffect(() => {
    let stopped = false;
    for (const name of ['esplora', 'nexus'] as const) {
      check[name](config[name]).then(
        () => ({ ok: true, text: 'Reachable.' }),
        (e: Error) => ({ ok: false, text: why(e) }),
      ).then((result) => !stopped && setChecked((was) => ({ ...was, [name]: result })));
    }
    return () => {
      stopped = true;
    };
  }, []);

  /** Saves `next`, an empty or the public URL for the public server,
   * once the driver's checks pass for each new server of your own, and
   * reloads onto them; saves nothing if a check refuses one, or while a
   * swap runs. */
  const save = async (next: Record<Setting, string>) => {
    setSaving(true);
    setRefused(null);
    try {
      if (await swapRuns()) throw new Error('Not saved: a swap is running, and keeps the servers it started with. Change them once it ends.');
      const own = (name: Setting) => {
        const url = next[name].trim();
        return url === '' || url === config.defaults[name] ? '' : url;
      };
      for (const name of ['esplora', 'nexus'] as const) {
        const url = own(name);
        if (url === '' || url === config[name]) continue;
        try {
          await check[name](url);
        } catch (e) {
          throw new Error(`Not saved: ${why(e as Error)}`);
        }
      }
      saveSetting(config.network, 'esplora', own('esplora'));
      // A host's own node is not the buyer's to set.
      if (!config.ownNode) saveSetting(config.network, 'nexus', own('nexus'));
      location.reload();
    } catch (e) {
      setRefused((e as Error).message);
      setSaving(false);
    }
  };
  /** The check of the server `name` is read from. */
  const status = (name: Setting) => {
    const result = checked[name];
    return (
      <span role="status" class={result === null || result.ok ? 'small muted' : 'small error'}>
        {result === null ? 'Checking…' : bounded(result.text)}
      </span>
    );
  };
  /** Which server a chain is read from, its check, and the trust a public
   * one asks for; `of` names one of your own. */
  const server = (name: Setting, of: string, trust: (host: string) => string) => {
    const isPublic = config[name] === config.defaults[name];
    return (
      <>
        <span>{isPublic ? `Public (${host(config[name])})` : `Your ${of}`}</span>
        {status(name)}
        {isPublic ? (
          <span class="small muted">{trust(host(config[name]))}</span>
        ) : (
          <button type="button" class="link" disabled={saving} onClick={() => save({ esplora: config.esplora, nexus: config.nexus, [name]: '' })}>
            Use the public {of} ({host(config.defaults[name])})
          </button>
        )}
      </>
    );
  };
  const read = async (file: File | undefined) => {
    if (!file) return;
    try {
      await onRestore(await file.text());
      setRestore({ ok: true, text: 'Restored.' });
    } catch (e) {
      setRestore({ ok: false, text: (e as Error).message });
    }
  };
  return (
    <section class="narrow">
      <h1>Settings</h1>
      <div class="field">
        <label for="esplora" class="label">
          Bitcoin backend (Esplora)
        </label>
        {server('esplora', 'Esplora', (h) => `You trust ${h} to show Bitcoin in time to refund: keep amounts small.`)}
        <input id="esplora" class="text" value={esplora} onInput={(e) => setEsplora(e.currentTarget.value)} />
      </div>
      {config.ownNode ? (
        <div class="field">
          <span class="label">Nexus</span>
          <span>Your node</span>
          {status('nexus')}
        </div>
      ) : (
        <div class="field">
          <label for="nexus" class="label">
            Nexus read URL
          </label>
          {server('nexus', 'node', (h) => `You trust ${h} for how deep the seller's NEX lock is: keep amounts small.`)}
          <input id="nexus" class="text" value={nexus} onInput={(e) => setNexus(e.currentTarget.value)} />
        </div>
      )}
      <span class="small muted">
        These servers are trusted to report the chains honestly. Use your own for the strongest guarantees.
      </span>
      {refused !== null && (
        <p role="alert" class="error">
          {bounded(refused)}
        </p>
      )}
      {changed && (
        <button type="button" class="primary" disabled={saving} onClick={() => save({ esplora, nexus })}>
          {saving ? 'Checking…' : 'Save and reload'}
        </button>
      )}
      <div class="field top-rule">
        <span class="small muted">{config.relay === null ? 'No relay configured.' : `Relay: ${config.relay}`}</span>
      </div>
      <div class="field top-rule">
        <label for="restore" class="secondary file-button">
          Restore from file
        </label>
        <input
          id="restore"
          type="file"
          accept=".json,application/json"
          class="visually-hidden"
          onChange={(e) => {
            read(e.currentTarget.files?.[0]);
            e.currentTarget.value = '';
          }}
        />
        {restore !== null && (
          <p role={restore.ok ? 'status' : 'alert'} class={restore.ok ? 'small' : 'error'}>
            {bounded(restore.text)}
          </p>
        )}
      </div>
    </section>
  );
}
