# lattice-swap-web

The browser buyer UI for NEX<->BTC atomic swaps: a static page over the
[lattice-swap](https://github.com/0xLattice/lattice-swap) browser driver,
`web/driver`, pinned as the submodule `vendor/lattice-swap`. There is no
backend. The page keeps its own Bitcoin wallet key in the browser
(IndexedDB). You deposit BTC to it, the swap funds its lock from it, and any
change or refund comes back to it.

The page shows only what the driver exposes. Each screen follows
`Buyer#status()`:

- **Swap** and **Review**: the best offer on the relay, an amount in its
  range, the price, and the funding fee the driver would pay at today's rate.
- **Fund your wallet** (`step: fund-wallet`): the wallet's address, with
  `need`, `wallet.confirmed` and `wallet.unconfirmed`. If the offer is gone
  (`step: offer-gone`), it says so and you pick another.
- **Progress** (`swapping`, `finishing`, `done`): four steps from
  `confirmations`. It asks for the recovery file once `backupCovers` is
  `lock`, shows `deadlines` as a reminder, and shows the "Keep this page
  open" banner while `mustStayOpen`. A `warning` while swapping shows as
  stalled. It also shows `refunding`, `refunded`, and each `outcome`.
- **Wallet**: the balance and deposit address. Withdraw is off while a swap
  holds the wallet's outputs.
- **Settings**: the Esplora and Nexus read URLs, which you trust for what
  they report, and Restore from a recovery file.

Nothing watches a swap while the page is closed. If a swap stalls, come back
by the cancel time it shows, and keep the page open until the refund
confirms.

## Configuration

These are build-time settings, in `.env` (mainnet) and `.env.signet`. An
environment variable of the same name overrides them:

| Variable | Mainnet default |
| --- | --- |
| `VITE_NETWORK` | `bitcoin` |
| `VITE_ESPLORA` | `https://mempool.space/api` |
| `VITE_NEXUS` | `https://lattice-mainnet-read.fly.dev` |
| `VITE_NEXUS_GENESIS` | the driver's |
| `VITE_RELAY` | none: the page says no relay is configured |

`npm run build` writes the mainnet page to `dist/`. `npm run build:signet`
writes the signet page to `dist-signet/`.

### One origin per network

Each network's page needs an origin of its own (scheme, host and port), not
a path beside the other's. The browser keys everything the page keeps by
origin, never by path: the IndexedDB store holding the wallet key and each
swap's record, the Web Lock that keeps one tab at a time, and the saved
Settings. Both builds use the same names for these. On one origin, a signet
page would open the mainnet wallet and its swaps, and an open tab of one
network would hold the other off as "open in another tab". Nor is a path a
security boundary: any page on the origin can read the other's wallet key.

- Mainnet: `https://swap.lattice.build`, this repository's Pages site.
  `public/CNAME` names it, and only the mainnet build carries it.
- Signet: not deployed from here, since a repository has one Pages site. To
  host it, serve `dist-signet/` (or the release's `-signet.tar.gz`) from
  its own origin, such as `https://swap-signet.lattice.build`.

The built page carries a Content-Security-Policy: its own scripts and
their wasm, and requests to any `https:` or `wss:` server, since the buyer
picks the Esplora and Nexus servers they trust.

## Develop

Rust with the `wasm32-unknown-unknown` target, a clang that has the
WebAssembly target, wasm-bindgen-cli 0.2.130, and Node 22 or later:

```sh
git submodule update --init
CC_wasm32_unknown_unknown=clang AR_wasm32_unknown_unknown=llvm-ar npm run wasm
npm ci
npm run dev
npm test && npm run lint && npm run typecheck
```

The tests run the page in jsdom against the driver's own fakes
(`web/driver/test/fakes.js`): a fake Esplora, Nexus node and relay, with the
seller's swap-wasm machine standing in for the session.

To move to a newer driver, check out another lattice-swap commit in
`vendor/lattice-swap` and commit the submodule.

## Deploy and release

CI builds the wasm, then runs the lint, typecheck, tests and both builds.
Each push to main deploys the mainnet build to GitHub Pages, at
`swap.lattice.build`: a `CNAME` record for it pointing at
`0xlattice.github.io`, and the domain verified for the 0xLattice
organization.

A `v*` tag matching `package.json`'s version makes a draft release. It
holds `lattice-swap-web-<version>-mainnet.tar.gz` and `-signet.tar.gz`, each
with a `.sha256` file, plus `SHA256SUMS` and a build provenance attestation:

```sh
shasum -a 256 -c lattice-swap-web-<version>-mainnet.tar.gz.sha256
gh attestation verify lattice-swap-web-<version>-mainnet.tar.gz --repo 0xLattice/lattice-swap-web
```

## License

MIT
