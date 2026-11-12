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
  range, the price, and the funding fee the driver would pay at today's rate
  (`wallet.need`). A browser with no wallet shows the fee as unknown: the
  key is made only when you start a swap, make a wallet or restore one.
- **Fund your wallet** (`step: fund-wallet`): the wallet's address, with
  `need`, `wallet.confirmed` and `wallet.unconfirmed`. If the offer is gone
  (`step: offer-gone`), it says so and you pick another.
- **Progress** (`swapping`, `finishing`, `asking`, `done`): the amounts and NEX
  address from `btc_amount`, `nex_amount` less `nex_fee` (the NEX that
  arrives, as Review's "You get") and `nexAddress`, and four steps
  from `confirmations`, each "n of" `btc_confirmations` or
  `nex_confirmations`. It asks for the recovery file once `backupCovers` is
  `lock`, shows `deadlines` as a reminder, and shows the "Keep this page
  open" banner while `mustStayOpen`. A `warning` while swapping shows as
  stalled. It also shows `refunding`, `refunded`, and each `outcome`.
- **Wallet**: the balance and deposit address. Withdraw is off while the
  swap is `running`.
- **Settings**: for each chain, the server it is read from: the build's
  public one, which you trust for what it reports, or your own Esplora or
  Nexus node. Each is checked as Settings opens, and a new one before it is
  saved, with the driver's checks (`Wallet#check`), given up after 15
  seconds. A server of your own must be an `https:` URL, as the page is and
  a browser fetches no plain http from it: for a Nexus node, its public read
  port served over https and started with `--public-submit` (the node's
  loopback RPC is not reachable from a page). A running swap carries on
  with the servers saved, its checks run again as it resumes. The relays
  whose offers are listed: the build's, and any you add. And a relay
  directory, a node hosting the directory's chain (lattice-swap's
  `relay-dir`) and the chain's path: up to 16 of the relays it lists at
  the tip, picked at random, are read after yours, and their offers marked
  "via directory". The tip is that node's word, so it can hide relays or
  name useless ones, but not move funds: an offer is signed by its seller
  and listed only on the relay it names. Its relays are contacted from
  your browser, so a directory you don't trust can point you at hosts of
  its choosing. The directory is read in batches (`GET /volumes?cids=`),
  waiting out a node's rate limit, within 15 seconds; a read cut short
  keeps the relays listed by then and says so. If it cannot be read, the
  page says so and lists your relays' offers. A read that failed or was
  cut short is tried again at most once a minute. And Restore from a recovery file.

Nothing watches a swap while the page is closed. If a swap stalls, come back
by the cancel time it shows, and keep the page open until the refund
confirms. While it waits unconfirmed, the open page bumps the refund's fee
by CPFP, submitting the pair to the Esplora's `POST /txs/package`, as
mempool.space serves it.

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
| `VITE_RELAY_DIRECTORY` | none: no relay directory is read |
| `VITE_RELAY_DIRECTORY_CHAIN` | none (signet: `Nexus/testnet/swap-relays`) |

No public node is known to host a relay directory's chain, so neither
build reads one unless the buyer sets one in Settings; the signet build
fills in the test directory's chain. Mainnet sets no chain until a mainnet
directory exists.

`npm run build` writes the mainnet page to `dist/`. `npm run build:signet`
writes the signet page to `dist-signet/`.

Signet swaps trade on mainnet's Nexus: real NEX for test coins worth
nothing. The driver refuses such an offer unless the buyer's policy sets
`test_btc_for_mainnet_nex`, so a page built for any network but `bitcoin`
sets it, and the mainnet page never does.

### One origin per network

Each network's page needs an origin of its own (scheme, host and port), not
a path beside the other's. The browser keys everything the page keeps by
origin, never by path: the IndexedDB store holding the wallet key and each
swap's record, the Web Lock that keeps one tab at a time, and the saved
Settings. Both builds use the same names for these. On one origin, a signet
page would open the mainnet wallet and its swaps, and an open tab of one
network would hold the other off as "open in another tab". Nor is a path a
security boundary: any page on the origin can read the other's wallet key.

- Mainnet: meant for `https://swap.lattice.build`, this repository's Pages
  site, once the steps under [Deploy and release](#deploy-and-release) are
  done. Until then nothing is published.
- Signet: not deployed from here, since a repository has one Pages site. To
  host it, serve `dist-signet/` (or the release's `-signet.tar.gz`) from
  its own origin, such as `https://swap-signet.lattice.build`.

The built page carries a Content-Security-Policy: its own scripts and
their wasm, and requests to any `https:` or `wss:` server, since the buyer
picks the Esplora and Nexus servers they trust.

## Develop

The Rust that `vendor/lattice-swap/rust-toolchain.toml` pins (rustup
installs it, with the `wasm32-unknown-unknown` target), a clang that has
the WebAssembly target, wasm-bindgen-cli 0.2.130, and Node 22 or later:

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

`e2e/` runs the page against real chains: built for regtest, served, and
driven in Chromium by Playwright (`e2e/page.mjs`), it takes a CLI seller's
offer from a relay against a regtest bitcoind and a lattice-node in Docker,
with lattice-swap's own end-to-end harness (`e2e/tests/page.rs`). CI's `e2e`
job runs it; locally, with Docker, the wasm built and `npm ci`:

```sh
npx playwright install chromium
(cd vendor/lattice-swap && cargo build -p lattice-swap --target-dir ../../e2e/target)
cd e2e && NEXUS_NODE_IMAGE=<the image vendor/lattice-swap's CI pins> \
  LATTICE_SWAP=$PWD/target/debug/lattice-swap cargo test -- --ignored --test-threads=1
```

To move to a newer driver, check out another lattice-swap commit in
`vendor/lattice-swap` and commit the submodule.

## Deploy and release

CI builds the wasm, then runs the lint, typecheck, tests and both builds,
and the end-to-end test.
A push to main deploys the mainnet build to GitHub Pages only once the
repository variable `PAGES_CNAME` is `swap.lattice.build`. Until then the
deploy job is skipped, so nothing is published at the default
`0xlattice.github.io/lattice-swap-web/` address, an origin shared with
every other Pages site of the organization.

To set up the domain, in order:

1. Verify `lattice.build` for the 0xLattice organization: Organization
   settings → Pages → Add a domain. Then add the TXT record it shows,
   `_github-pages-challenge-0xLattice.lattice.build`, and click Verify.
2. Add a DNS `CNAME` record from `swap.lattice.build` to
   `0xlattice.github.io`, unproxied.
3. Set the Pages custom domain:
   `gh api -X PUT repos/0xLattice/lattice-swap-web/pages -f cname=swap.lattice.build`.
4. Set the repository variable:
   `gh variable set PAGES_CNAME --body swap.lattice.build --repo 0xLattice/lattice-swap-web`.
   The next push to main deploys.
5. Wait for GitHub to issue the certificate. Then turn on Enforce HTTPS
   (`gh api -X PUT repos/0xLattice/lattice-swap-web/pages -F https_enforced=true`)
   before announcing the site.

A deployment from Actions ignores a `CNAME` file: the domain is the Pages
setting of step 3. `public/CNAME` only records it, in the mainnet build and
its release tarball. It is harmless there.

A `v*` tag matching `package.json`'s version makes a draft release. It
holds `lattice-swap-web-<version>-mainnet.tar.gz` and `-signet.tar.gz`, each
with a `.sha256` file, plus `SHA256SUMS` and a build provenance attestation:

```sh
shasum -a 256 -c lattice-swap-web-<version>-mainnet.tar.gz.sha256
gh attestation verify lattice-swap-web-<version>-mainnet.tar.gz --repo 0xLattice/lattice-swap-web
```

## License

MIT
