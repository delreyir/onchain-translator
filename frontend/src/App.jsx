import { useEffect, useMemo, useState } from "react";
import {
  createPublicClient,
  createWalletClient,
  custom,
  http,
  decodeEventLog,
  parseEther,
  formatEther,
} from "viem";
import {
  ritualChain,
  TEE_SERVICE_REGISTRY,
  RITUAL_WALLET,
  CAPABILITY_LLM,
  TRANSLATOR_ADDRESS,
  translatorAbi,
  teeRegistryAbi,
  ritualWalletAbi,
  LANGUAGES,
} from "./ritual.js";

const publicClient = createPublicClient({
  chain: ritualChain,
  transport: http(),
});

const GITHUB = "https://github.com/delreyir/onchain-translator";

export default function App() {
  const [account, setAccount] = useState(null);

  const walletClient = useMemo(() => {
    if (typeof window === "undefined" || !window.ethereum) return null;
    return createWalletClient({
      chain: ritualChain,
      transport: custom(window.ethereum),
    });
  }, []);

  useEffect(() => {
    if (!window.ethereum) return;
    // Auto-reconnect on load, unless the user explicitly disconnected.
    if (localStorage.getItem("wallet:disconnected") !== "1") {
      window.ethereum
        .request({ method: "eth_accounts" })
        .then((accs) => accs[0] && setAccount(accs[0]))
        .catch(() => {});
    }
    // Keep the UI in sync when the user switches or disconnects in the wallet.
    const onAccountsChanged = (accs) => {
      if (accs && accs.length) {
        localStorage.removeItem("wallet:disconnected");
        setAccount(accs[0]);
      } else {
        setAccount(null);
      }
    };
    window.ethereum.on?.("accountsChanged", onAccountsChanged);
    return () =>
      window.ethereum.removeListener?.("accountsChanged", onAccountsChanged);
  }, []);

  return (
    <div className="page">
      <NavBar account={account} setAccount={setAccount} />
      <Hero />
      <Translate account={account} setAccount={setAccount} walletClient={walletClient} />
      <HowItWorks />
      <AgentSection account={account} setAccount={setAccount} walletClient={walletClient} />
      <Why />
      <ChainReference />
      <Faq />
      <Footer />
    </div>
  );
}

/* ============================ wallet helpers ============================ */

async function ensureChain() {
  const hexId = "0x" + ritualChain.id.toString(16);
  try {
    await window.ethereum.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: hexId }],
    });
  } catch (e) {
    if (e.code === 4902) {
      await window.ethereum.request({
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId: hexId,
            chainName: ritualChain.name,
            nativeCurrency: ritualChain.nativeCurrency,
            rpcUrls: ritualChain.rpcUrls.default.http,
            blockExplorerUrls: [ritualChain.blockExplorers.default.url],
          },
        ],
      });
    } else throw e;
  }
}

async function connectWallet(setAccount) {
  if (!window.ethereum) {
    alert("No EVM wallet found. Install MetaMask.");
    return;
  }
  const [acc] = await window.ethereum.request({ method: "eth_requestAccounts" });
  await ensureChain();
  localStorage.removeItem("wallet:disconnected");
  setAccount(acc);
}

async function disconnectWallet(setAccount) {
  try {
    // Newer wallets support revoking the dApp's account permission.
    await window.ethereum?.request?.({
      method: "wallet_revokePermissions",
      params: [{ eth_accounts: {} }],
    });
  } catch {
    /* not all wallets support this — fall back to clearing local state */
  }
  localStorage.setItem("wallet:disconnected", "1");
  setAccount(null);
}

const configured = () =>
  TRANSLATOR_ADDRESS && /^0x[a-fA-F0-9]{40}$/.test(TRANSLATOR_ADDRESS);

/* ============================ NavBar ============================ */

function NavBar({ account, setAccount }) {
  return (
    <nav className="nav">
      <div className="nav-inner">
        <a href="#top" className="brand">
          <span className="brand-glyph">◇</span> onchain-translator
        </a>
        <div className="nav-links">
          <a href="#try">Try it</a>
          <a href="#how">How it works</a>
          <a href="#agent">Agent</a>
          <a href="#chain">Chain</a>
          <a href={GITHUB} target="_blank" rel="noreferrer">
            GitHub
          </a>
        </div>
        {account ? (
          <span style={{ display: "inline-flex", gap: "8px", alignItems: "center" }}>
            <span className="mono pill">
              {account.slice(0, 6)}…{account.slice(-4)}
            </span>
            <button
              className="btn outline sm"
              onClick={() => disconnectWallet(setAccount)}
              title="Disconnect wallet"
            >
              Disconnect
            </button>
          </span>
        ) : (
          <button className="btn outline sm" onClick={() => connectWallet(setAccount)}>
            Connect
          </button>
        )}
      </div>
    </nav>
  );
}

/* ============================ Hero ============================ */

function Hero() {
  return (
    <header id="top" className="hero">
      <div className="hero-grid-bg" />
      <div className="container">
        <div className="counter mono">00 / 06 · ritual · chain 1979</div>
        <h1 className="display">
          Translate anything
          <br />
          <span className="accent">fully on-chain.</span>
        </h1>
        <p className="lede">
          A smart contract that thinks. Text is translated by an open-weight LLM
          running inside a TEE, verified, bound to your request, and stored
          on-chain. No API keys. No oracles. No backend.
        </p>
        <div className="hero-cta">
          <a href="#try" className="btn primary">
            Try it ↓
          </a>
          <a href={GITHUB} target="_blank" rel="noreferrer" className="btn outline">
            View source ↗
          </a>
        </div>
        <div className="scroll-hint mono">scroll</div>
      </div>
    </header>
  );
}

/* ============================ Translate (01) ============================ */

function Translate({ account, setAccount, walletClient }) {
  const [text, setText] = useState("");
  const [lang, setLang] = useState("Arabic");
  const [status, setStatus] = useState("idle");
  const [result, setResult] = useState("");
  const [error, setError] = useState("");
  const [txHash, setTxHash] = useState("");
  const [rwBalance, setRwBalance] = useState(null);

  const busy = ["selecting", "submitting", "inferring", "depositing"].includes(
    status
  );

  async function refreshBalance() {
    if (!account || !configured()) return;
    try {
      const bal = await publicClient.readContract({
        address: RITUAL_WALLET,
        abi: ritualWalletAbi,
        functionName: "balanceOf",
        args: [account],
      });
      setRwBalance(bal);
    } catch {
      /* ignore */
    }
  }

  useEffect(() => {
    refreshBalance();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account]);

  async function fetchExecutor() {
    const services = await publicClient.readContract({
      address: TEE_SERVICE_REGISTRY,
      abi: teeRegistryAbi,
      functionName: "getServicesByCapability",
      args: [CAPABILITY_LLM, true],
    });
    const valid = services.find((s) => s.isValid);
    if (!valid) throw new Error("No valid LLM executor available right now.");
    return valid.node.teeAddress;
  }

  async function deposit() {
    setError("");
    try {
      await ensureChain();
      setStatus("depositing");
      // Manual translate is paid from the *caller's* RitualWallet balance,
      // so the connected user funds their own balance (not the contract).
      const hash = await walletClient.writeContract({
        account,
        address: RITUAL_WALLET,
        abi: ritualWalletAbi,
        functionName: "deposit",
        args: [100000n],
        value: parseEther("0.5"),
      });
      await publicClient.waitForTransactionReceipt({ hash });
      setStatus("idle");
      await refreshBalance();
      alert("Deposited 0.5 RITUAL into your fee balance. You can now translate on-chain.");
    } catch (e) {
      setError(e.shortMessage || e.message);
      setStatus("idle");
    }
  }

  async function translate() {
    setError("");
    setResult("");
    setTxHash("");
    if (!account) return setError("Connect your wallet first.");
    if (!text.trim()) return setError("Enter some text to translate.");
    try {
      await ensureChain();
      setStatus("selecting");
      const executor = await fetchExecutor();
      setStatus("submitting");
      const hash = await walletClient.writeContract({
        account,
        address: TRANSLATOR_ADDRESS,
        abi: translatorAbi,
        functionName: "translate",
        args: [executor, text, lang],
        gas: 5_000_000n,
      });
      setTxHash(hash);
      setStatus("inferring");
      const receipt = await publicClient.waitForTransactionReceipt({ hash });

      let translated = "";
      let hadError = false;
      for (const log of receipt.logs) {
        if (log.address.toLowerCase() !== TRANSLATOR_ADDRESS.toLowerCase())
          continue;
        try {
          const d = decodeEventLog({
            abi: translatorAbi,
            data: log.data,
            topics: log.topics,
          });
          if (d.eventName === "TranslationCompleted") {
            translated = d.args.translatedText;
            hadError = d.args.hasError;
          }
        } catch {
          /* not ours */
        }
      }
      if (hadError || !translated) {
        const count = await publicClient.readContract({
          address: TRANSLATOR_ADDRESS,
          abi: translatorAbi,
          functionName: "translationsCount",
        });
        const t = await publicClient.readContract({
          address: TRANSLATOR_ADDRESS,
          abi: translatorAbi,
          functionName: "getTranslation",
          args: [count - 1n],
        });
        if (t.hasError) throw new Error(t.errorMessage || "LLM error");
        translated = t.translatedText;
      }
      setResult(translated);
      setStatus("done");
      refreshBalance();
    } catch (e) {
      setError(e.shortMessage || e.message);
      setStatus("idle");
    }
  }

  return (
    <section id="try" className="block">
      <div className="container">
        <SectionHead n="01" kicker="Try it" titleA="Translate" titleB="on demand" />
        {!configured() && (
          <div className="note warn mono">
            demo mode: set VITE_TRANSLATOR_ADDRESS in frontend/.env after deploy
          </div>
        )}
        <div className="terminal">
          <div className="terminal-bar mono">
            <span className="tdot" />
            <span className="tdot" />
            <span className="tdot" />
            <span className="tpath">translate.sol</span>
          </div>
          <div className="terminal-body">
            <div className="io">
              <div>
                <div className="io-label mono">input</div>
                <textarea
                  rows={5}
                  placeholder="Type something to translate…"
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                />
              </div>
              <div>
                <div className="io-label mono">output{result && ` · ${lang}`}</div>
                <div className="io-out">
                  {result ? <p>{result}</p> : <span className="ph">→ on-chain translation</span>}
                </div>
              </div>
            </div>
            <div className="io-actions">
              <select value={lang} onChange={(e) => setLang(e.target.value)}>
                {LANGUAGES.map((l) => (
                  <option key={l} value={l}>
                    → {l}
                  </option>
                ))}
              </select>
              {account ? (
                <>
                  <button className="btn outline" onClick={deposit} disabled={busy || !configured()}>
                    Fund my balance (0.5 RIT)
                  </button>
                  <button className="btn primary" onClick={translate} disabled={busy || !configured()}>
                    {busy ? "working…" : "Translate on-chain"}
                  </button>
                </>
              ) : (
                <button className="btn primary" onClick={() => connectWallet(setAccount)}>
                  Connect wallet
                </button>
              )}
            </div>
            {account && configured() && (
              <div className="statusline mono">
                fee balance:{" "}
                {rwBalance == null
                  ? "…"
                  : `${Number(formatEther(rwBalance)).toFixed(3)} RIT`}
                {rwBalance != null && rwBalance < parseEther("0.32") && (
                  <span> · low — click “Fund my balance” first</span>
                )}
              </div>
            )}
            {status !== "idle" && (
              <div className="statusline mono">
                <span className="blink">▍</span> {statusText(status)}
                {txHash && (
                  <a
                    href={`${ritualChain.blockExplorers.default.url}/tx/${txHash}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    tx ↗
                  </a>
                )}
              </div>
            )}
            {error && <div className="note error mono">{error}</div>}
          </div>
        </div>
      </div>
    </section>
  );
}

function statusText(s) {
  return (
    {
      selecting: "selecting TEE executor…",
      submitting: "submitting to LLM precompile 0x0802…",
      inferring: "running inference inside TEE (10–40s)…",
      depositing: "depositing into RitualWallet…",
      done: "done.",
    }[s] || s
  );
}

/* ============================ How it works ============================ */

function HowItWorks() {
  const steps = [
    {
      n: "01",
      a: "Build the",
      b: "prompt",
      desc: "The contract assembles an OpenAI-style message array on-chain and JSON-escapes your input. No off-chain prep.",
      code: '[{"role":"system",…},{"role":"user","content":"…"}]',
    },
    {
      n: "02",
      a: "Encode the",
      b: "request",
      desc: "30-field LLM request is ABI-encoded with convoHistory left empty, then sent to the precompile in one call.",
      code: "LLM_PRECOMPILE.call(input) // 0x0802",
    },
    {
      n: "03",
      a: "TEE runs",
      b: "inference",
      desc: "A registered executor runs zai-org/GLM-4.7-FP8 inside an enclave and hardware-attests the completion.",
      code: "executor to enclave to attested output",
    },
    {
      n: "04",
      a: "Result",
      b: "settles",
      desc: "The chain re-executes your tx with the result injected; the contract decodes and stores it in the same transaction.",
      code: "abi.decode(actualOutput,(bool,bytes,…))",
    },
  ];
  return (
    <section id="how" className="block alt">
      <div className="container">
        <SectionHead n="02" kicker="How it works" titleA="One transaction," titleB="four steps" />
        <div className="steps">
          {steps.map((s) => (
            <div key={s.n} className="step">
              <div className="step-n mono">{s.n}</div>
              <h3 className="display">
                {s.a}
                <br />
                {s.b}
              </h3>
              <p>{s.desc}</p>
              <div className="code-line mono">{s.code}</div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ============================ Agent (06) ============================ */

function AgentSection({ account, setAccount, walletClient }) {
  const [url, setUrl] = useState("https://api.adviceslip.com/advice");
  const [lang, setLang] = useState("Arabic");
  const [every, setEvery] = useState(40);
  const [runs, setRuns] = useState(10);
  const [running, setRunning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [feed, setFeed] = useState([]);
  const [err, setErr] = useState("");

  async function refresh() {
    if (!configured()) return;
    try {
      const [isRunning, recent] = await Promise.all([
        publicClient.readContract({
          address: TRANSLATOR_ADDRESS,
          abi: translatorAbi,
          functionName: "agentRunning",
        }),
        publicClient.readContract({
          address: TRANSLATOR_ADDRESS,
          abi: translatorAbi,
          functionName: "getRecent",
          args: [12n],
        }),
      ]);
      setRunning(isRunning);
      setFeed(recent.filter((t) => t.autonomous));
    } catch {
      /* not deployed yet */
    }
  }

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 6000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function start() {
    setErr("");
    if (!account) return connectWallet(setAccount);
    try {
      setBusy(true);
      await ensureChain();
      const hash = await walletClient.writeContract({
        account,
        address: TRANSLATOR_ADDRESS,
        abi: translatorAbi,
        functionName: "startAgent",
        args: [url, lang, Number(every), Number(runs)],
      });
      await publicClient.waitForTransactionReceipt({ hash });
      await refresh();
    } catch (e) {
      setErr(e.shortMessage || e.message);
    } finally {
      setBusy(false);
    }
  }

  async function stop() {
    setErr("");
    try {
      setBusy(true);
      await ensureChain();
      const hash = await walletClient.writeContract({
        account,
        address: TRANSLATOR_ADDRESS,
        abi: translatorAbi,
        functionName: "stopAgent",
      });
      await publicClient.waitForTransactionReceipt({ hash });
      await refresh();
    } catch (e) {
      setErr(e.shortMessage || e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section id="agent" className="block">
      <div className="container">
        <SectionHead
          n="03"
          kicker="Autonomous agent"
          titleA="Let the contract"
          titleB="run itself"
        />
        <p className="block-lede">
          Powered by the enshrined Scheduler. The contract wakes itself up,
          fetches fresh text over HTTP, and translates it. No server. No cron.
          Three precompiles working together.
        </p>

        <div className="agent-wrap">
          <div className="agent-config">
            <div className="agent-status mono">
              <span className={`sdot ${running ? "on" : "off"}`} />
              {running ? "agent: running" : "agent: idle"}
            </div>
            <label className="io-label mono">source url</label>
            <input value={url} onChange={(e) => setUrl(e.target.value)} />
            <div className="agent-row">
              <div>
                <label className="io-label mono">to</label>
                <select value={lang} onChange={(e) => setLang(e.target.value)}>
                  {LANGUAGES.map((l) => (
                    <option key={l}>{l}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="io-label mono">every (blocks)</label>
                <input
                  type="number"
                  min="1"
                  value={every}
                  onChange={(e) => setEvery(e.target.value)}
                />
              </div>
              <div>
                <label className="io-label mono">runs</label>
                <input
                  type="number"
                  min="1"
                  value={runs}
                  onChange={(e) => setRuns(e.target.value)}
                />
              </div>
            </div>
            {running ? (
              <button className="btn outline" onClick={stop} disabled={busy || !configured()}>
                {busy ? "…" : "Stop agent"}
              </button>
            ) : (
              <button className="btn primary" onClick={start} disabled={busy || !configured()}>
                {busy ? "starting…" : account ? "Start agent (owner)" : "Connect to start"}
              </button>
            )}
            {err && <div className="note error mono">{err}</div>}
            <p className="fineprint mono">
              owner-only · agent pays its own fees from RitualWallet
            </p>
          </div>

          <div className="agent-feed">
            <div className="feed-head mono">
              live on-chain feed<span className="feed-count">{feed.length}</span>
            </div>
            {feed.length === 0 ? (
              <div className="feed-empty">
                No autonomous translations yet. Start the agent and watch entries
                appear here, written by the chain itself.
              </div>
            ) : (
              feed.map((t, i) => (
                <div key={i} className="feed-item">
                  <div className="feed-lang mono">→ {t.targetLang}</div>
                  <div className="feed-translated">
                    {t.hasError ? `⚠ ${t.errorMessage}` : t.translatedText}
                  </div>
                  <div className="feed-source mono">{t.sourceText.slice(0, 110)}</div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

/* ============================ Why ============================ */

function Why() {
  const cards = [
    {
      t: "Verifiable, not trusted",
      d: "The model runs in a TEE. The executor's attestation is on-chain and bound to your request, so no operator can fabricate the result.",
    },
    {
      t: "Lives on-chain",
      d: "Every translation is decoded, stored in contract storage, and emitted as an event. Permanent, public, and indexable.",
    },
    {
      t: "Zero infrastructure",
      d: "No translation API, no server, no keys. convoHistory is empty, so the contract talks to the precompile directly.",
    },
    {
      t: "Autonomous",
      d: "Scheduler + HTTP + LLM let the contract drive itself. It reads the web and translates with no human in the loop.",
    },
  ];
  return (
    <section className="block alt">
      <div className="container">
        <SectionHead n="04" kicker="Why it's different" titleA="Not a wrapper." titleB="A contract that thinks." />
        <div className="why-grid">
          {cards.map((c) => (
            <div key={c.t} className="why-card">
              <div className="why-mark mono">◇</div>
              <h4>{c.t}</h4>
              <p>{c.d}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ============================ Chain Reference ============================ */

function ChainReference() {
  const contracts = [
    ["LLM precompile", "0x0000000000000000000000000000000000000802"],
    ["HTTP precompile", "0x0000000000000000000000000000000000000801"],
    ["Scheduler", "0x56e776BAE2DD60664b69Bd5F865F1180ffB7D58B"],
    ["RitualWallet", "0x532F0dF0896F353d8C3DD8cc134e8129DA2a3948"],
    ["TEEServiceRegistry", "0x9644e8562cE0Fe12b4deeC4163c064A8862Bf47F"],
  ];
  return (
    <section id="chain" className="block">
      <div className="container">
        <SectionHead n="05" kicker="Chain reference" titleA="Built on" titleB="Ritual" />
        <div className="chain-grid">
          <div className="chain-col">
            <div className="chain-h mono">chain</div>
            <KV k="Chain ID" v="1979" />
            <KV k="Currency" v="RITUAL" />
            <KV k="Block time" v="~350ms" />
            <KV k="Model" v="GLM-4.7-FP8" />
          </div>
          <div className="chain-col">
            <div className="chain-h mono">endpoints</div>
            <KV k="RPC" v="rpc.ritualfoundation.org" />
            <KV k="Explorer" v="explorer.ritualfoundation.org" />
            <KV k="Faucet" v="faucet.ritualfoundation.org" />
          </div>
          <div className="chain-col wide">
            <div className="chain-h mono">contracts &amp; precompiles</div>
            {contracts.map(([k, v]) => (
              <a
                key={k}
                className="kv link"
                href={`${ritualChain.blockExplorers.default.url}/address/${v}`}
                target="_blank"
                rel="noreferrer"
              >
                <span className="kv-k">{k}</span>
                <span className="kv-v mono">
                  {v.slice(0, 10)}…{v.slice(-6)}
                </span>
              </a>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

function KV({ k, v }) {
  return (
    <div className="kv">
      <span className="kv-k">{k}</span>
      <span className="kv-v mono">{v}</span>
    </div>
  );
}

/* ============================ FAQ ============================ */

function Faq() {
  const items = [
    {
      q: "Is the translation really on-chain?",
      a: "Yes. The contract sends the prompt to the LLM precompile, decodes the completion, and stores the translated text on-chain. The model runs off-chain in a TEE, but the request, result, and verification all live on-chain.",
    },
    {
      q: "Do I need an API key or a server?",
      a: "No. The LLM is enshrined as a chain precompile. convoHistory is empty so no storage credentials are needed. The dApp is a contract plus a static frontend.",
    },
    {
      q: "What does it cost?",
      a: "Each in-flight call escrows ~0.31 testnet RITUAL from your RitualWallet balance, refunded to actual usage after settlement. Fund your own balance with ~0.5 RIT (the “Fund my balance” button). Get testnet RIT from the faucet.",
    },
    {
      q: "Why 10–40 seconds?",
      a: "GLM-4.7-FP8 is a reasoning model: it produces an internal chain-of-thought before the final answer, so the output budget is high and the TTL is 300 blocks.",
    },
    {
      q: "How does the autonomous agent run with no server?",
      a: "The enshrined Scheduler (a system contract invoked by the block proposer) wakes the contract on a schedule. The agent pays its own fees from the RitualWallet. To kill it you'd have to take the network down.",
    },
  ];
  const [open, setOpen] = useState(0);
  return (
    <section id="faq" className="block alt">
      <div className="container">
        <SectionHead n="06" kicker="FAQ" titleA="Good to" titleB="know" />
        <div className="faq">
          {items.map((it, i) => (
            <div
              key={i}
              className={`faq-item ${open === i ? "open" : ""}`}
              onClick={() => setOpen(open === i ? -1 : i)}
            >
              <div className="faq-q">
                <span>{it.q}</span>
                <span className="faq-mark mono">{open === i ? "−" : "+"}</span>
              </div>
              {open === i && <p className="faq-a">{it.a}</p>}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ============================ Footer ============================ */

function Footer() {
  return (
    <footer className="footer">
      <div className="container footer-inner">
        <span className="brand">
          <span className="brand-glyph">◇</span> onchain-translator
        </span>
        <div className="footer-links mono">
          <a href="https://faucet.ritualfoundation.org" target="_blank" rel="noreferrer">
            faucet
          </a>
          <a href="https://explorer.ritualfoundation.org" target="_blank" rel="noreferrer">
            explorer
          </a>
          <a href="https://docs.ritualfoundation.org" target="_blank" rel="noreferrer">
            docs
          </a>
          <a href={GITHUB} target="_blank" rel="noreferrer">
            github
          </a>
        </div>
        <span className="footer-tag mono">built on ritual · chain 1979</span>
      </div>
    </footer>
  );
}

/* ============================ shared ============================ */

function SectionHead({ n, kicker, titleA, titleB }) {
  return (
    <div className="section-head">
      <div className="section-counter mono">
        {n} <span className="section-kicker">{kicker}</span>
      </div>
      <h2 className="display">
        {titleA}
        <br />
        <span className="accent">{titleB}</span>
      </h2>
    </div>
  );
}
