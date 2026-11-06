//! The page against real chains: built for regtest, served, and driven in
//! Chromium by page.mjs, it takes a CLI seller's offer from a relay. The
//! world is lattice-swap's own end-to-end one
//! (vendor/lattice-swap/crates/lattice-swap/tests/e2e.rs), cut down to what
//! these tests use: a regtest bitcoind, a lattice-node in Docker, the
//! Esplora shim over the bitcoind, a relay, and the `lattice-swap` binary as
//! the seller. The test, not the parties, mines both chains.
//!
//! Ignored by a plain `cargo test`; run with `NEXUS_NODE_IMAGE` naming the
//! node image, `LATTICE_SWAP` the seller's binary, the page's wasm built,
//! `npm ci` and Playwright's Chromium installed, and `-- --ignored`.

use std::io::{BufRead, BufReader};
use std::net::TcpListener;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use bitcoin::{Amount, Network};
use corepc_node::{Conf, Node};
use ed25519_dalek::SigningKey;
use rand_core::{OsRng, RngCore};
use serde_json::{json, Value};
use swap::bitcoind::Bitcoind;
use swap::SecretBytes;
use swap_nexus_tx::address;
use swap_nexus_tx::rpc::Client;
use swap_relay::board::Board;
use swap_relay::Relay;

#[path = "../../vendor/lattice-swap/crates/lattice-swap/tests/esplora/mod.rs"]
mod esplora;

const TIMEOUT: Duration = Duration::from_secs(10);
/// Nexus's block reward over its first halving interval.
const REWARD: u64 = 1_048_576;
const BTC_AMOUNT: Amount = Amount::from_sat(50_000_000);
const BTC_FEE: Amount = Amount::from_sat(1_000);
/// As in lattice-swap's e2e.rs: nothing is bumped, and each swap
/// transaction costs exactly `BTC_FEE`, but redeem, which pays two.
const NO_BUMP: [&str; 4] = ["--fallback-fee-rate", "1", "--max-fee-rate", "1"];
/// The seller's quote, as in e2e.rs: `BTC_AMOUNT` buys `NEX_AMOUNT`.
const PRICE: u64 = 49_999_999;
const MIN_BTC_AMOUNT: Amount = Amount::from_sat(10_000_000);
const MAX_BTC_AMOUNT: Amount = Amount::from_sat(60_000_000);
const NEX_AMOUNT: u64 = 1_000_000;
/// What the buyer's bitcoind wallet holds, to fund the page's wallet from.
const BUYER_BTC: Amount = Amount::from_sat(100_000_000);

fn random32() -> [u8; 32] {
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    bytes
}

fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

fn wait_for<T>(what: &str, mut poll: impl FnMut() -> Option<T>) -> T {
    let deadline = Instant::now() + Duration::from_secs(120);
    loop {
        if let Some(value) = poll() {
            return value;
        }
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        thread::sleep(Duration::from_millis(250));
    }
}

/// A relay on loopback: its URL and the relay.
fn relay() -> (String, Arc<Relay>) {
    let relay = Arc::new(Relay {
        board: Board::new(10),
        rejoins: Board::new(10),
    });
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    listener.set_nonblocking(true).unwrap();
    let serving = relay.clone();
    thread::spawn(move || {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(async {
            let listener = tokio::net::TcpListener::from_std(listener).unwrap();
            swap_relay::serve(listener, serving).await.unwrap();
        });
    });
    (url, relay)
}

/// A lattice-node in Docker, as in e2e.rs.
struct Nexus {
    container: String,
    url: String,
    /// The public read port, which also takes submits: the page's Nexus.
    public: String,
    cookie: String,
}

impl Nexus {
    fn start() -> Self {
        let image =
            std::env::var("NEXUS_NODE_IMAGE").expect("NEXUS_NODE_IMAGE names the node image");
        let (rpc, p2p, public) = (free_port(), free_port(), free_port());
        let script = format!(
            "lattice-node --data-directory /tmp/d --identity-key /tmp/p.key \
             --listen-port {p2p} --rpc-port {rpc} --websocket-port 0 --no-default-peers \
             --public-read-port {public} --public-submit --public-read-rate 0 \
             --public-read-expensive-rate 0 --public-read-max-rate 0 --public-submit-rate 0"
        );
        let out = Command::new("docker")
            .args([
                "run",
                "-d",
                "--network",
                "host",
                "--platform",
                "linux/amd64",
            ])
            .args(["--entrypoint", "sh", &image, "-c", &script])
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        let mut nexus = Nexus {
            container: String::from_utf8(out.stdout).unwrap().trim().to_string(),
            url: format!("http://127.0.0.1:{rpc}"),
            public: format!("http://127.0.0.1:{public}"),
            cookie: String::new(),
        };
        nexus.cookie = wait_for("node cookie", || {
            let out = Command::new("docker")
                .args(["exec", &nexus.container, "cat", "/tmp/d/.cookie"])
                .output()
                .unwrap();
            out.status
                .success()
                .then(|| String::from_utf8(out.stdout).unwrap())
        });
        wait_for("node RPC", || nexus.client().min_relay_fee().ok());
        nexus
    }

    fn client(&self) -> Client {
        Client::new(&self.url, &self.cookie, TIMEOUT)
    }

    fn balance(&self, address: &str) -> u64 {
        self.client().account(address).unwrap().balance
    }

    /// Transactions waiting in the node's pool.
    fn pending(&self) -> u64 {
        use base64::Engine;
        let token = base64::engine::general_purpose::STANDARD.encode(self.cookie.trim());
        let json: Value = ureq::get(&format!("{}/api/mempool", self.url))
            .set("Authorization", &format!("Basic {token}"))
            .timeout(TIMEOUT)
            .call()
            .unwrap()
            .into_json()
            .unwrap();
        match &json["count"] {
            Value::String(count) => count.parse().unwrap(),
            count => count.as_u64().expect("a count"),
        }
    }

    /// Mines one block, paying its reward to `recipient` or, with `None`,
    /// burning it, and waits until the node executes it.
    fn mine(&self, recipient: Option<&str>) {
        let client = self.client();
        let height = client.health().unwrap().height;
        let mut args: Vec<String> = [
            "exec",
            &self.container,
            "lattice-mining-coordinator",
            "--node",
            &self.url,
            "--rpc-cookie-file",
            "/tmp/d/.cookie",
            "--workers",
            "1",
            "--batch-size",
            "1000",
            "--once",
        ]
        .map(String::from)
        .to_vec();
        if let Some(address) = recipient {
            args.extend(["--recipient".into(), format!("Nexus={address}")]);
        }
        wait_for("a mined block", || {
            if client.health().unwrap().height > height {
                return Some(());
            }
            let out = Command::new("docker").args(&args).output().unwrap();
            assert!(
                out.status.success(),
                "{}",
                String::from_utf8_lossy(&out.stderr)
            );
            None
        });
    }
}

impl Drop for Nexus {
    fn drop(&mut self) {
        let _ = Command::new("docker")
            .args(["rm", "-f", &self.container])
            .output();
    }
}

fn wallet_client(node: &Node, wallet: &str) -> Bitcoind {
    let cookie = std::fs::read_to_string(&node.params.cookie_file).unwrap();
    let url = match wallet {
        "" => node.rpc_url(),
        wallet => node.rpc_url_with_wallet(wallet),
    };
    Bitcoind::new(&url, &cookie, Network::Regtest, TIMEOUT)
}

/// The wallet's confirmed balance.
fn btc_balance(wallet: &Bitcoind) -> Amount {
    let balances = wallet.call("getbalances", json!([])).unwrap();
    let trusted = balances["mine"]["trusted"].as_f64().unwrap();
    Amount::from_btc(trusted).unwrap()
}

/// A process, killed if the test ends first.
struct Party(Child);

impl Drop for Party {
    fn drop(&mut self) {
        let _ = self.0.kill();
    }
}

/// A regtest bitcoind with a seller wallet and a buyer wallet holding 1
/// BTC, a Nexus node whose first two blocks pay the seller, and a
/// directory for the seller's swap file.
struct World {
    bitcoind: Node,
    miner: bitcoin::Address,
    nexus: Nexus,
    nexus_genesis: String,
    seller_nex: SecretBytes,
    buyer_nex: String,
    nex_fee: u64,
    directory: tempfile::TempDir,
    nexus_cookie: PathBuf,
    key_file: PathBuf,
}

impl World {
    fn new() -> Self {
        let mut conf = Conf::default();
        conf.args.push("-txindex");
        let bitcoind = Node::from_downloaded_with_conf(&conf).expect("start bitcoind");
        let miner = bitcoind.client.new_address().unwrap();
        bitcoind.client.generate_to_address(101, &miner).unwrap();
        for name in ["seller", "buyer"] {
            bitcoind.create_wallet(name).unwrap();
        }
        let buyer_btc = wallet_client(&bitcoind, "buyer")
            .call("getnewaddress", json!([]))
            .unwrap();
        wallet_client(&bitcoind, "default")
            .call("sendtoaddress", json!([buyer_btc, BUYER_BTC.to_btc()]))
            .unwrap();
        bitcoind.client.generate_to_address(1, &miner).unwrap();
        wait_for("the txindex", || {
            wallet_client(&bitcoind, "buyer").check_node().ok()
        });

        let nexus = Nexus::start();
        let seller_nex = SecretBytes(random32());
        for _ in 0..2 {
            nexus.mine(Some(&seller_nex.nex_address()));
        }
        let buyer_nex = address(
            &SigningKey::from_bytes(&random32())
                .verifying_key()
                .to_bytes(),
        );
        let nex_fee = nexus.client().min_relay_fee().unwrap();
        let nexus_genesis = nexus.client().genesis().unwrap();

        let directory = tempfile::tempdir().unwrap();
        let nexus_cookie = directory.path().join("nexus.cookie");
        std::fs::write(&nexus_cookie, &nexus.cookie).unwrap();
        let key_file = directory.path().join("nex.key");
        std::fs::write(&key_file, hex::encode(seller_nex.0)).unwrap();
        std::fs::set_permissions(
            &key_file,
            std::os::unix::fs::PermissionsExt::from_mode(0o600),
        )
        .unwrap();
        World {
            bitcoind,
            miner,
            nexus,
            nexus_genesis,
            seller_nex,
            buyer_nex,
            nex_fee,
            directory,
            nexus_cookie,
            key_file,
        }
    }

    /// The seller's state, as its swap file holds it; empty before it
    /// exists.
    fn seller_state(&self, swap_id: &str) -> String {
        let path = self
            .directory
            .path()
            .join("seller")
            .join(format!("{swap_id}.json"));
        let Ok(text) = std::fs::read_to_string(path) else {
            return String::new();
        };
        match &serde_json::from_str::<Value>(&text).unwrap()["state"] {
            Value::Object(state) => state.keys().next().unwrap().clone(),
            Value::String(state) => state.clone(),
            state => panic!("a state: {state}"),
        }
    }

    /// The CLI seller listing an offer on `relay`, with timelocks small for
    /// regtest: the seller, the swap id, and the rest of its output once
    /// it ends. `t1` is at least the tool's floor of 1 + 6 x
    /// (`nex_confirmations` + 1) + 3.
    fn offer(
        &self,
        relay: &str,
        t1: u16,
        t2: u16,
        nex_confirmations: u64,
    ) -> (Party, String, JoinHandle<String>) {
        let binary = std::env::var("LATTICE_SWAP").expect("LATTICE_SWAP names the seller's binary");
        let cookie = self.bitcoind.params.cookie_file.to_str().unwrap();
        let mut seller = Party(
            Command::new(binary)
                .arg("offer")
                .args(["--relay", relay])
                .args(["--price", &PRICE.to_string()])
                .args(["--min-btc-amount", &MIN_BTC_AMOUNT.to_sat().to_string()])
                .args(["--max-btc-amount", &MAX_BTC_AMOUNT.to_sat().to_string()])
                .args(["--btc-fee", &BTC_FEE.to_sat().to_string()])
                .args(["--min-btc-fee-rate", "1"])
                .args(["--nex-fee", &self.nex_fee.to_string()])
                .args([
                    "--t1",
                    &t1.to_string(),
                    "--t2",
                    &t2.to_string(),
                    "--margin",
                    "3",
                ])
                .args(["--btc-confirmations", "1"])
                .args(["--nex-confirmations", &nex_confirmations.to_string()])
                .args(NO_BUMP)
                .arg("--dir")
                .arg(self.directory.path().join("seller"))
                .arg("--nex-key-file")
                .arg(&self.key_file)
                .args([
                    "--btc-url",
                    &self.bitcoind.rpc_url(),
                    "--btc-wallet",
                    "seller",
                ])
                .args(["--btc-cookie", cookie, "--btc-network", "regtest"])
                .args(["--nexus-url", &self.nexus.url, "--nexus-cookie"])
                .arg(&self.nexus_cookie)
                .args(["--nexus-genesis", &self.nexus_genesis])
                .stdout(Stdio::piped())
                .spawn()
                .unwrap(),
        );
        let mut reader = BufReader::new(seller.0.stdout.take().unwrap());
        let mut offer = String::new();
        reader.read_line(&mut offer).unwrap();
        let swap_id = serde_json::from_str::<Value>(&offer).unwrap()["template"]["swap_id"]
            .as_str()
            .unwrap()
            .to_string();
        wait_for("the offer listed", || {
            let offers: Value = ureq::get(&format!("{relay}/offers"))
                .call()
                .unwrap()
                .into_json()
                .unwrap();
            (!offers.as_array().unwrap().is_empty()).then_some(())
        });
        let rest = thread::spawn(move || {
            let mut rest = String::new();
            std::io::Read::read_to_string(&mut reader, &mut rest).unwrap();
            rest
        });
        (seller, swap_id, rest)
    }

    /// One round of mining: a Bitcoin block if `btc` or its pool holds
    /// something, a Nexus block if `nexus` or its pool holds something and
    /// `nexus_on`.
    fn mine(&self, btc: bool, nexus: bool, nexus_on: bool) {
        let mempool = wallet_client(&self.bitcoind, "")
            .call("getmempoolinfo", json!([]))
            .unwrap();
        if btc || mempool["size"].as_u64() > Some(0) {
            self.bitcoind
                .client
                .generate_to_address(1, &self.miner)
                .unwrap();
        }
        if nexus_on && (nexus || self.nexus.pending() > 0) {
            self.nexus.mine(None);
        }
    }

    /// What the bitcoind sees at `address` in blocks.
    fn received(&self, address: &str) -> Amount {
        let received = wallet_client(&self.bitcoind, "")
            .call(
                "scantxoutset",
                json!(["start", [format!("addr({address})")]]),
            )
            .unwrap();
        Amount::from_btc(received["total_amount"].as_f64().unwrap()).unwrap()
    }
}

/// The page in Chromium, page.mjs: what it shows, one JSON line each time
/// it changes.
struct Page {
    party: Party,
    lines: Receiver<Value>,
    shown: Vec<Value>,
}

impl Page {
    /// Builds the page against `world` and `relay`, with `bounds` as its
    /// VITE_BOUNDS, takes the relay's offer to the Fund screen and funds
    /// the address it shows with what it says is needed, from the buyer's
    /// bitcoind wallet: the page and its wallet's address.
    fn open(world: &World, relay: &str, name: &str, bounds: Value) -> (Page, String) {
        let out = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("out")
            .join(name);
        let config = json!({
            "esplora": esplora::esplora(wallet_client(&world.bitcoind, "")),
            "nexus": world.nexus.public,
            "genesis": world.nexus_genesis,
            "relay": relay,
            "bounds": bounds,
            "btc_amount": BTC_AMOUNT.to_btc().to_string(),
            "nex_address": world.buyer_nex,
            "port": free_port(),
            "out": out,
        });
        let path = world.directory.path().join("page.json");
        std::fs::write(&path, config.to_string()).unwrap();
        let mut party = Party(
            Command::new("node")
                .arg(concat!(env!("CARGO_MANIFEST_DIR"), "/page.mjs"))
                .arg(&path)
                .stdout(Stdio::piped())
                .spawn()
                .expect("node"),
        );
        let reader = BufReader::new(party.0.stdout.take().unwrap());
        let (send, lines) = mpsc::channel::<Value>();
        thread::spawn(move || {
            for line in reader.lines() {
                let line = line.unwrap();
                eprintln!("page: {line}");
                if send.send(serde_json::from_str(&line).unwrap()).is_err() {
                    return;
                }
            }
        });
        let fund = lines
            .recv_timeout(Duration::from_secs(300))
            .expect("the Fund screen");
        let fund = &fund["fund"];
        let address = fund["address"].as_str().unwrap().to_string();
        let need = Amount::from_sat(fund["need"].as_u64().unwrap());
        wallet_client(&world.bitcoind, "buyer")
            .call("sendtoaddress", json!([address, need.to_btc()]))
            .unwrap();
        let page = Page {
            party,
            lines,
            shown: Vec::new(),
        };
        (page, address)
    }

    /// What the page showed since last asked.
    fn read(&mut self) -> Vec<Value> {
        let new: Vec<Value> = self.lines.try_iter().collect();
        self.shown.extend(new.iter().cloned());
        new
    }

    /// Whether page.mjs has ended, and it succeeded.
    fn ended(&mut self) -> Option<bool> {
        self.party
            .0
            .try_wait()
            .unwrap()
            .map(|status| status.success())
    }

    /// The steps the page showed current, each once, in order.
    fn steps(&self) -> Vec<&str> {
        let mut steps: Vec<&str> = Vec::new();
        for title in self.shown.iter().filter_map(|line| line["step"].as_str()) {
            if steps.last() != Some(&title) {
                steps.push(title);
            }
        }
        steps
    }

    /// The details the page showed under `step`.
    fn details(&self, step: &str) -> Vec<&str> {
        self.shown
            .iter()
            .filter(|line| line["step"] == step)
            .map(|line| line["detail"].as_str().unwrap())
            .collect()
    }

    /// The headlines of the boxes the page showed, each once, in order.
    fn boxes(&self) -> Vec<&str> {
        let mut boxes: Vec<&str> = Vec::new();
        for text in self.shown.iter().filter_map(|line| line["box"].as_str()) {
            if boxes.last() != Some(&text) {
                boxes.push(text);
            }
        }
        boxes
    }
}

/// The bounds the page takes regtest's shallow terms under, as VITE_BOUNDS:
/// the CLI buyer's in e2e.rs.
fn bounds(world: &World, max_t1: u16) -> Value {
    json!({
        "max_btc_fee": BTC_FEE.to_sat(), "max_nex_fee": world.nex_fee,
        "max_t1": max_t1, "min_t2": 10, "min_refund_window": 9, "min_margin": 3,
        "min_btc_fee_rate": 1, "min_btc_confirmations": 1, "min_nex_confirmations": 1,
    })
}

const DEADLINE: Duration = Duration::from_secs(900);

/// The page takes the offer, funded from the address it shows, and swaps:
/// it steps through the lock, the seller's lock, the finish and the NEX
/// received, its Nexus confirmations rising, to "Swap again".
#[test]
#[ignore = "needs Docker, NEXUS_NODE_IMAGE, LATTICE_SWAP and the page's wasm and Chromium"]
fn the_page_swaps() {
    let world = World::new();
    let (relay, board) = relay();
    // Three Nexus confirmations, so the depth the page counts can rise.
    let (mut seller, _, seller_out) = world.offer(&relay, 28, 10, 3);
    let (mut page, wallet) = Page::open(&world, &relay, "swaps", bounds(&world, 28));

    // Each pool mined as it fills; and a Nexus block each time the page
    // shows a Nexus depth, so it shows every depth in turn: the page reads
    // the chains only on its poll, every 10 s.
    let deadline = Instant::now() + DEADLINE;
    let mut seller_done = None;
    let ended = loop {
        assert!(Instant::now() < deadline, "the swap timed out");
        if let Some(ended) = page.ended() {
            break ended;
        }
        seller_done = seller_done.or(seller.0.try_wait().unwrap());
        let paced = page.read().iter().any(|line| {
            line["step"] == "NEX received"
                || (line["step"] == "Seller locks NEX"
                    && line["detail"].as_str().unwrap().starts_with("NEX lock:"))
        });
        world.mine(false, paced, true);
        thread::sleep(Duration::from_millis(400));
    };
    page.read();
    assert!(ended, "the page failed: {:?}", page.shown);
    assert_eq!(
        page.steps(),
        [
            "Lock your BTC",
            "Seller locks NEX",
            "Finish",
            "NEX received"
        ]
    );
    // "1 NEX is in your address · N Nexus confirmations.": N rises, to
    // "3+" once done.
    let depths: Vec<String> = page
        .details("NEX received")
        .iter()
        .map(|detail| {
            assert!(
                detail.starts_with("1 NEX is in your address · "),
                "{detail}"
            );
            detail
                .split(" · ")
                .nth(1)
                .unwrap()
                .split(' ')
                .next()
                .unwrap()
                .to_string()
        })
        .collect();
    let (last, counted) = depths.split_last().unwrap();
    assert_eq!(last, "3+", "{depths:?}");
    let counted: Vec<u64> = counted.iter().map(|n| n.parse().unwrap()).collect();
    assert!(counted.len() >= 2, "{depths:?}");
    assert!(counted.windows(2).all(|w| w[0] < w[1]), "{depths:?}");

    let status = seller_done.unwrap_or_else(|| seller.0.wait().unwrap());
    assert!(status.success(), "{status}");
    assert_eq!(seller_out.join().unwrap(), "outcome: Swapped\n");
    assert_eq!(
        world.nexus.balance(&world.buyer_nex),
        NEX_AMOUNT - world.nex_fee
    );
    assert_eq!(
        world.nexus.balance(&world.seller_nex.nex_address()),
        2 * REWARD - NEX_AMOUNT - world.nex_fee
    );
    // Redeem pays two fees.
    let seller_wallet = wallet_client(&world.bitcoind, "seller");
    assert_eq!(btc_balance(&seller_wallet), BTC_AMOUNT - BTC_FEE * 2);
    // The deposit less the lock and the funding's fee: under 1000 sat.
    let change = world.received(&wallet);
    assert!(change < Amount::from_sat(1_000), "{change}");
    assert!(board.board.offers().is_empty());
}

/// The seller goes once its NEX is locked: as time passes the page shows
/// the refund, then the BTC back in its wallet.
#[test]
#[ignore = "needs Docker, NEXUS_NODE_IMAGE, LATTICE_SWAP and the page's wasm and Chromium"]
fn the_page_refunds_when_the_seller_goes() {
    let world = World::new();
    let (relay, _board) = relay();
    // Two Nexus confirmations with Nexus mined only as its pool fills: the
    // NEX lock stays one deep, so the page never signs the redeem. A t2
    // wide enough for the refund to confirm, read on the page's 10 s poll.
    let (mut seller, swap_id, seller_out) = world.offer(&relay, 24, 40, 2);
    let (mut page, wallet) = Page::open(&world, &relay, "refunds", bounds(&world, 24));
    let deadline = Instant::now() + DEADLINE;
    while world.seller_state(&swap_id) != "AwaitRedeemSignature" {
        assert!(Instant::now() < deadline, "the NEX lock timed out");
        page.read();
        world.mine(false, false, true);
        thread::sleep(Duration::from_millis(400));
    }
    seller.0.kill().unwrap();
    seller.0.wait().unwrap();
    seller_out.join().unwrap();

    // A Bitcoin block every round, so t1 comes; no more Nexus.
    let ended = loop {
        assert!(Instant::now() < deadline, "the refund timed out");
        if let Some(ended) = page.ended() {
            break ended;
        }
        page.read();
        world.mine(true, false, false);
        thread::sleep(Duration::from_millis(1500));
    };
    page.read();
    assert!(ended, "the page failed: {:?}", page.shown);
    let boxes = page.boxes();
    assert_eq!(
        boxes.last().copied(),
        Some("Refunded. Your BTC is back in your wallet."),
        "{boxes:?}"
    );
    assert!(boxes.contains(&"Refunding your BTC"), "{boxes:?}");
    // The lock less cancel's and refund's fees, back in the wallet.
    let held = world.received(&wallet);
    assert!(held >= BTC_AMOUNT - BTC_FEE * 2, "{held}");
    assert!(held < BTC_AMOUNT, "{held}");
    assert_eq!(world.nexus.balance(&world.buyer_nex), 0);
}
