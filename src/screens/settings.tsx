import { useState } from 'preact/hooks';
import { saveSetting, type AppConfig } from '../config';
import { bounded } from '../format';

export function Settings({ config, onRestore }: { config: AppConfig; onRestore: (file: string) => Promise<void> }) {
  const [esplora, setEsplora] = useState(config.esplora);
  const [nexus, setNexus] = useState(config.nexus);
  const [restore, setRestore] = useState<{ ok: boolean; text: string } | null>(null);
  const changed = esplora.trim() !== config.esplora || nexus.trim() !== config.nexus;
  const save = () => {
    saveSetting(config.network, 'esplora', esplora);
    saveSetting(config.network, 'nexus', nexus);
    location.reload();
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
        <input id="esplora" class="text" value={esplora} onInput={(e) => setEsplora(e.currentTarget.value)} />
      </div>
      <div class="field">
        <label for="nexus" class="label">
          Nexus read URL
        </label>
        <input id="nexus" class="text" value={nexus} onInput={(e) => setNexus(e.currentTarget.value)} />
      </div>
      <span class="small muted">
        These servers are trusted to report the chains honestly. Use your own for the strongest guarantees.
      </span>
      {changed && (
        <button type="button" class="primary" onClick={save}>
          Save and reload
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
