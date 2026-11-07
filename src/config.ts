// What the page runs against: the build's settings (.env, .env.signet),
// with the Esplora and Nexus URLs the buyer set in Settings over them.

export interface AppConfig {
  network: string;
  esplora: string;
  nexus: string;
  /** The build's own servers, the public ones: what `esplora` and `nexus`
   * are unless the buyer set their own. */
  defaults: Record<Setting, string>;
  /** The Nexus genesis offers must name; the driver's default if unset. */
  nexusGenesis?: string;
  /** The relay whose offers are listed; null if none is configured. */
  relay: string | null;
  /** Bounds on the offer's terms other than the CLI's defaults
   * (`swap::offer::Bounds`), from VITE_BOUNDS, JSON: the signet build
   * takes shallow test terms; the driver's tests use looser ones. */
  bounds?: Record<string, number>;
  /** Anything else the driver's `Wallet.open` takes: its store, locks,
   * poll, a session opener in tests. */
  driver?: Record<string, unknown>;
  /** Hands the buyer the file `name`, for a host embedding the page; a
   * download if unset. */
  save?: (name: string, text: string) => void | Promise<void>;
  /** The host runs the Nexus node the page reads: shown as "your node",
   * with no URL to set. */
  ownNode?: boolean;
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

/** Keeps `value` for `name`, or drops it when empty: false if the
 * browser keeps no settings. */
export function saveSetting(network: string, name: Setting, value: string): boolean {
  try {
    if (value.trim() === '') localStorage.removeItem(key(network, name));
    else localStorage.setItem(key(network, name), value.trim());
    return true;
  } catch {
    return false;
  }
}

/** `url` as compared: its scheme and host lowercased, no trailing slash. */
function normal(url: string): string {
  const trimmed = url.trim();
  try {
    return new URL(trimmed).href.replace(/\/+$/, '');
  } catch {
    return trimmed.replace(/\/+$/, '');
  }
}

/** Whether `a` and `b` name the same server. */
export const sameServer = (a: string, b: string) => normal(a) === normal(b);

/** The URL set for `name`, or the public one, `publicUrl`, if none is or
 * the one set is the same server: an older page saved the public one
 * itself. */
function setting(network: string, name: Setting, publicUrl: string): string {
  const own = stored(network, name);
  return own === null || sameServer(own, publicUrl) ? publicUrl : own;
}

export function buildConfig(): AppConfig {
  const env = import.meta.env;
  const network = env.VITE_NETWORK || 'bitcoin';
  return {
    network,
    esplora: setting(network, 'esplora', env.VITE_ESPLORA),
    nexus: setting(network, 'nexus', env.VITE_NEXUS),
    defaults: { esplora: env.VITE_ESPLORA, nexus: env.VITE_NEXUS },
    nexusGenesis: env.VITE_NEXUS_GENESIS || undefined,
    relay: env.VITE_RELAY || null,
    bounds: env.VITE_BOUNDS ? JSON.parse(env.VITE_BOUNDS) : undefined,
  };
}
