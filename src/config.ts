// What the page runs against: the build's settings (.env, .env.signet),
// with the Esplora and Nexus URLs the buyer set in Settings over them.

export interface AppConfig {
  network: string;
  esplora: string;
  nexus: string;
  /** The Nexus genesis offers must name; the driver's default if unset. */
  nexusGenesis?: string;
  /** The relay whose offers are listed; null if none is configured. */
  relay: string | null;
  /** Bounds on the offer's terms other than the CLI's defaults
   * (`swap::offer::Bounds`); the driver's tests use looser ones. */
  bounds?: Record<string, number>;
  /** Anything else the driver's `Wallet.open` takes: its store, locks,
   * poll, a session opener in tests. */
  driver?: Record<string, unknown>;
}

export type Setting = 'esplora' | 'nexus';

const key = (network: string, name: Setting) => `lattice-swap:${network}:${name}`;

function stored(network: string, name: Setting): string | null {
  try {
    return localStorage.getItem(key(network, name));
  } catch {
    return null;
  }
}

/** Keeps `value` for `name`, or drops it when empty. */
export function saveSetting(network: string, name: Setting, value: string): void {
  try {
    if (value.trim() === '') localStorage.removeItem(key(network, name));
    else localStorage.setItem(key(network, name), value.trim());
  } catch {
    // Not kept: the build's setting stays.
  }
}

export function buildConfig(): AppConfig {
  const env = import.meta.env;
  const network = env.VITE_NETWORK || 'bitcoin';
  return {
    network,
    esplora: stored(network, 'esplora') ?? env.VITE_ESPLORA,
    nexus: stored(network, 'nexus') ?? env.VITE_NEXUS,
    nexusGenesis: env.VITE_NEXUS_GENESIS || undefined,
    relay: env.VITE_RELAY || null,
  };
}
