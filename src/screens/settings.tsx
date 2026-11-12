import { useEffect, useState } from 'preact/hooks';
import { checkEsplora, checkNexusNode, DEFAULTS, offers } from 'lattice-swap-driver';
import { isRelayUrl, sameServer, saveSetting, type AppConfig, type Directory, type Setting } from '../config';
import { MAX_DIRECTORY_RELAYS, readDirectory } from '../directory';
import { bounded, host } from '../format';

/** What a check of a server found: null while it runs. */
type Checked = { ok: boolean; text: string } | null;

/** How long a check waits on a server before it counts as unreachable. */
export const CHECK_TIMEOUT = 15_000;

type Fetch = typeof globalThis.fetch;

/** Whether `a` and `b` name the same servers, in order. */
const sameServers = (a: string[], b: string[]) => a.length === b.length && a.every((url, i) => sameServer(url, b[i]));

/** No directory: one whose node is empty. */
const NO_DIRECTORY: Directory = { node: '', chain: '' };

/** Whether `a` and `b` are the same directory: none, or the same chain on
 * the same node. */
const sameDirectory = (a: Directory, b: Directory) =>
  a.node.trim() === '' ? b.node.trim() === '' : sameServer(a.node, b.node) && a.chain.trim() === b.chain.trim();

export function Settings({
  config,
  onRestore,
  swapRuns,
}: {
  config: AppConfig;
  onRestore: (file: string) => Promise<void>;
  /** Whether a swap is running, asked of the wallet: it carries on with
   * new servers once they are saved, checked again as it resumes. */
  swapRuns: () => Promise<boolean>;
}) {
  const [esplora, setEsplora] = useState(config.esplora);
  const [nexus, setNexus] = useState(config.nexus);
  const [relays, setRelays] = useState(config.relays);
  const [relay, setRelay] = useState('');
  const directory = config.directory ?? NO_DIRECTORY;
  const [directoryNode, setDirectoryNode] = useState(directory.node);
  const [directoryChain, setDirectoryChain] = useState(directory.chain);
  const [restore, setRestore] = useState<{ ok: boolean; text: string } | null>(null);
  const [checked, setChecked] = useState<Record<Setting, Checked>>({ esplora: null, nexus: null });
  const [saving, setSaving] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const [runs, setRuns] = useState(false);
  // Aborted once Settings closes: a check or save still running ends
  // there, and changes nothing.
  const [closed] = useState(() => new AbortController());
  const genesis = config.nexusGenesis ?? DEFAULTS.nexusGenesis;
  const pageFetch = config.driver?.fetch as Fetch | undefined;
  const drivers: Record<Setting | 'relays' | 'directory', (url: string, fetch: Fetch) => Promise<void>> = {
    esplora: (url, fetch) => checkEsplora(url, config.network, fetch),
    nexus: (url, fetch) => checkNexusNode(url, genesis, fetch),
    // A relay is one whose offers can be read.
    relays: (url, fetch) => offers(url, fetch).then(() => {}),
    // A directory is one whose relays can be read, of the chain typed.
    directory: (url, fetch) => readDirectory({ node: url, chain: directoryChain.trim() }, fetch).then(() => {}),
  };
  const changed =
    !sameServer(esplora, config.esplora) ||
    !sameServer(nexus, config.nexus) ||
    !sameServers(relays, config.relays) ||
    !sameDirectory({ node: directoryNode, chain: directoryChain }, directory);

  /** The driver's check of `url` for `name`, given up after
   * CHECK_TIMEOUT or once Settings closes: one a server could not answer
   * is unreachable; one it answered and the driver refused, refused with
   * the driver's reason. */
  async function check(name: Setting | 'relays' | 'directory', url: string): Promise<{ ok: boolean; text: string }> {
    // The page is https, and a browser fetches no plain http from it.
    if (location.protocol === 'https:' && !/^https:\/\//i.test(url.trim())) {
      return { ok: false, text: 'refused: must be an https URL' };
    }
    const stop = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      stop.abort();
    }, CHECK_TIMEOUT);
    const close = () => stop.abort();
    closed.signal.addEventListener('abort', close);
    const signal = stop.signal;
    const given = new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    given.catch(() => {});
    /** Whether the server failed to answer the last request. */
    let unread = false;
    const fetch: Fetch = async (input, init) => {
      try {
        const response = await (pageFetch ?? globalThis.fetch)(input, { ...init, signal });
        // A missing answer is the driver's to judge: some it allows.
        unread = !response.ok && response.status !== 404;
        return response;
      } catch (e) {
        unread = true;
        throw e;
      }
    };
    try {
      await Promise.race([drivers[name](url, fetch), given]);
      return { ok: true, text: 'Reachable.' };
    } catch (e) {
      if (timedOut) return { ok: false, text: 'Unreachable: timed out' };
      // swap-wasm throws its reasons as strings.
      const message = e instanceof Error ? e.message : String(e);
      if (unread) return { ok: false, text: `Unreachable: ${message}` };
      return { ok: false, text: message.startsWith('refused:') ? message : `refused: ${message}` };
    } finally {
      clearTimeout(timer);
      closed.signal.removeEventListener('abort', close);
    }
  }

  // The servers in use, checked as the page opens Settings, and whether a
  // swap runs on them.
  useEffect(() => {
    for (const name of ['esplora', 'nexus'] as const) {
      check(name, config[name]).then((result) => !closed.signal.aborted && setChecked((was) => ({ ...was, [name]: result })));
    }
    swapRuns().then(
      (r) => !closed.signal.aborted && setRuns(r),
      () => {},
    );
    return () => closed.abort();
  }, []);

  /** Saves `next`, an empty or the public URL for the public server,
   * once the driver's checks pass for each new server of your own, each
   * relay added and a relay directory set, and reloads onto them; saves nothing if a check refuses
   * one, or if Settings closes first. */
  const save = async (next: Record<Setting, string> & { relays: string[]; directory: Directory }) => {
    setSaving(true);
    setRefused(null);
    const own = (name: Setting) => {
      const url = next[name].trim();
      return url === '' || sameServer(url, config.defaults[name]) ? '' : url;
    };
    for (const name of ['esplora', 'nexus'] as const) {
      const url = own(name);
      if (url === '' || sameServer(url, config[name])) continue;
      const result = await check(name, url);
      if (closed.signal.aborted) return;
      if (!result.ok) {
        setRefused(`Not saved: ${result.text}`);
        setSaving(false);
        return;
      }
    }
    for (const url of next.relays) {
      if (config.relays.some((was) => sameServer(was, url))) continue;
      const result = await check('relays', url);
      if (closed.signal.aborted) return;
      if (!result.ok) {
        setRefused(`Not saved: ${url}: ${result.text}`);
        setSaving(false);
        return;
      }
    }
    const nextDirectory = { node: next.directory.node.trim(), chain: next.directory.chain.trim() };
    if (!sameDirectory(nextDirectory, directory)) {
      const result =
        nextDirectory.node === ''
          ? { ok: true, text: '' }
          : !isRelayUrl(nextDirectory.node)
            ? { ok: false, text: `${nextDirectory.node} is not a node's URL (https://…)` }
            : !/^[^/]+(\/[^/]+)*$/.test(nextDirectory.chain)
              ? { ok: false, text: 'name the chain of the directory, as Nexus/testnet/swap-relays' }
              : await check('directory', nextDirectory.node);
      if (closed.signal.aborted) return;
      if (!result.ok) {
        setRefused(`Not saved: relay directory: ${result.text}`);
        setSaving(false);
        return;
      }
    }
    const ownRelays = sameServers(next.relays, config.defaults.relays) ? '' : JSON.stringify(next.relays);
    const ownDirectory = sameDirectory(nextDirectory, config.defaults.directory ?? NO_DIRECTORY)
      ? ''
      : JSON.stringify(nextDirectory.node === '' ? NO_DIRECTORY : nextDirectory);
    // A host's own node is not the buyer's to set.
    const kept =
      saveSetting(config.network, 'esplora', own('esplora')) &&
      (config.ownNode || saveSetting(config.network, 'nexus', own('nexus'))) &&
      saveSetting(config.network, 'relays', ownRelays) &&
      saveSetting(config.network, 'directory', ownDirectory);
    if (!kept) {
      setRefused('Not saved: this browser keeps no settings (private mode?)');
      setSaving(false);
      return;
    }
    location.reload();
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
    const isPublic = sameServer(config[name], config.defaults[name]);
    return (
      <>
        <span>{isPublic ? `Public (${host(config[name])})` : `Your ${of}`}</span>
        {status(name)}
        {isPublic ? (
          <span class="small muted">{trust(host(config[name]))}</span>
        ) : (
          <button type="button" class="link" disabled={saving} onClick={() => save({ esplora: config.esplora, nexus: config.nexus, relays: config.relays, directory, [name]: '' })}>
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
        These servers are trusted to report the chains honestly. Use your own for the strongest guarantees. Yours must
        be an https URL{config.ownNode ? '' : ": a Nexus node's public read port, started with --public-submit"}.
      </span>
      {runs && <span class="small muted">A swap is running: it carries on with the servers you save.</span>}
      <div class="field top-rule">
        <label for="relay" class="label">
          Relays
        </label>
        {relays.length === 0 && <span class="small muted">None: no offers are listed.</span>}
        {relays.map((url) => (
          <div key={url} class="row">
            <span>{url}</span>
            <button
              type="button"
              class="link"
              aria-label={`Remove ${url}`}
              disabled={saving}
              onClick={() => setRelays(relays.filter((r) => !sameServer(r, url)))}
            >
              Remove
            </button>
          </div>
        ))}
        <input id="relay" class="text" placeholder="https://" value={relay} onInput={(e) => setRelay(e.currentTarget.value)} />
        <button
          type="button"
          class="secondary"
          disabled={saving || relay.trim() === ''}
          onClick={() => {
            if (!isRelayUrl(relay)) return setRefused(`Not added: ${relay.trim()} is not a relay's URL (https://…)`);
            setRefused(null);
            if (!relays.some((url) => sameServer(url, relay))) setRelays([...relays, relay.trim()]);
            setRelay('');
          }}
        >
          Add relay
        </button>
        <span class="small muted">
          Offers are listed from each relay, and each is taken through the relay it is listed on. A relay can delay a
          swap, which ends in a refund, but cannot change it.
        </span>
      </div>
      <div class="field top-rule">
        <label for="directory" class="label">
          Relay directory
        </label>
        <input
          id="directory"
          class="text"
          placeholder="https://"
          value={directoryNode}
          onInput={(e) => setDirectoryNode(e.currentTarget.value)}
        />
        <label for="directory-chain" class="small muted">
          Its chain
        </label>
        <input id="directory-chain" class="text" value={directoryChain} onInput={(e) => setDirectoryChain(e.currentTarget.value)} />
        <span class="small muted">
          A node hosting the relay directory's chain: up to {MAX_DIRECTORY_RELAYS} of the relays it lists are read beside
          yours. You trust the node for which relays it lists, not for your funds. Empty for none.
        </span>
        <span class="small muted">
          The directory's relays are contacted from your browser, and a directory you don't trust can point you at hosts
          of its choosing.
        </span>
      </div>
      {refused !== null && (
        <p role="alert" class="error">
          {bounded(refused)}
        </p>
      )}
      {changed && (
        <button type="button" class="primary" disabled={saving} onClick={() => save({ esplora, nexus, relays, directory: { node: directoryNode, chain: directoryChain } })}>
          {saving ? 'Checking…' : 'Save and reload'}
        </button>
      )}
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
