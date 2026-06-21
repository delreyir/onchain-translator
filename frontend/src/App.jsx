import { useEffect, useMemo, useState } from "react";
import {
  createPublicClient,
  createWalletClient,
  custom,
  http,
  decodeEventLog,
  parseEther,
} from "viem";
import {
  ritualChain,
  TEE_SERVICE_REGISTRY,
  CAPABILITY_LLM,
  TRANSLATOR_ADDRESS,
  translatorAbi,
  teeRegistryAbi,
  LANGUAGES,
} from "./ritual.js";

const publicClient = createPublicClient({
  chain: ritualChain,
  transport: http(),
});

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
    if (window.ethereum) {
      window.ethereum
        .request({ method: "eth_accounts" })
        .then((accs) => accs[0] && setAccount(accs[0]))
        .catch(() => {});
    }
  }, []);

  return (
    <div className="page">
      <NavBar account={account} setAccount={setAccount} />
      <Hero account={account} setAccount={setAccount} walletClient={walletClient} />
      <Marquee />
      <Features />
      <HowItWorks />
      <AgentSection account={account} setAccount={setAccount} walletClient={walletClient} />
      <Languages />
      <Faq />
      <Footer />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Wallet helpers                                                      */
/* ------------------------------------------------------------------ */

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
    } else {
      throw e;
    }
  }
}

async function connectWallet(setAccount) {
  if (!window.ethereum) {
    alert("No EVM wallet found. Install MetaMask.");
    return;
  }
  const [acc] = await window.ethereum.request({
    method: "eth_requestAccounts",
  });
  await ensureChain();
  setAccount(acc);
}

/* ------------------------------------------------------------------ */
/* NavBar                                                              */
/* ------------------------------------------------------------------ */

function NavBar({ account, setAccount }) {
  return (
    <nav className="nav">
      <div className="nav-inner">
        <div className="brand">
          <span className="brand-glyph">◇</span> Onchain Translator
        </div>
        <div className="nav-links">
          <a href="#why">Why</a>
          <a href="#how">How it works</a>
          <a href="#agent">Agent</a>
          <a href="#langs">Languages</a>
          <a href="#faq">FAQ</a>
        </div>
        {account ? (
          <span className="pill">
            {account.slice(0, 6)}…{account.slice(-4)}
          </span>
        ) : (
          <button className="btn-sm" onClick={() => connectWallet(setAccount)}>
            Connect
          </button>
        )}
      </div>
    </nav>
  );
}

/* ------------------------------------------------------------------ */
/* Hero + live translate widget                                        */
/* ------------------------------------------------------------------ */

function Hero({ account, setAccount, walletClient }) {
  const [text, setText] = useState("");
  const [lang, setLang] = useState("Arabic");
  const [status, setStatus] = useState("idle");
  const [result, setResult] = useState("");
  const [error, setError] = useState("");
  const [txHash, setTxHash] = useState("");

  const configured =
    TRANSLATOR_ADDRESS && /^0x[a-fA-F0-9]{40}$/.test(TRANSLATOR_ADDRESS);

  const busy = [
    "selecting-executor",
    "submitting",
    "inferring",
    "depositing",
  ].includes(status);

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
      const hash = await walletClient.writeContract({
        account,
        address: TRANSLATOR_ADDRESS,
        abi: translatorAbi,
        functionName: "depositForFees",
        args: [100000n],
        value: parseEther("0.5"),
      });
      setStatus("depositing");
      await publicClient.waitForTransactionReceipt({ hash });
      setStatus("idle");
      alert("Deposited 0.5 RITUAL to the contract's RitualWallet balance.");
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
      setStatus("selecting-executor");
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
          const decoded = decodeEventLog({
            abi: translatorAbi,
            data: log.data,
            topics: log.topics,
          });
          if (decoded.eventName === "TranslationCompleted") {
            translated = decoded.args.translatedText;
            hadError = decoded.args.hasError;
          }
        } catch {
          /* not our event */
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
    } catch (e) {
      setError(e.shortMessage || e.message);
      setStatus("idle");
    }
  }

  return (
    <header className="hero">
      <div className="hero-bg" />
      <div className="hero-inner">
        <div className="badge">⚡ Live on Ritual Chain · id 1979</div>
        <h1>
          Translate any text
          <br />
          <span className="grad">fully on-chain.</span>
        </h1>
        <p className="lede">
          Powered by Ritual's enshrined LLM precompile{" "}
          <code>0x0802</code>. The model runs inside a TEE, the result is
          cryptographically bound to your request, and every translation is
          stored on-chain. No API keys. No oracles. No backend.
        </p>

        <div className="widget">
          {!configured && (
            <div className="banner warn">
              Demo mode — set <code>VITE_TRANSLATOR_ADDRESS</code> in{" "}
              <code>frontend/.env</code> after deploying to enable live
              translations.
            </div>
          )}

          <div className="widget-grid">
            <div className="field">
              <label>Source text</label>
              <textarea
                rows={6}
                placeholder="Type something to translate…"
                value={text}
                onChange={(e) => setText(e.target.value)}
              />
            </div>
            <div className="field">
              <label>Translation {result && `· ${lang}`}</label>
              <div className="output">
                {result ? (
                  <p>{result}</p>
                ) : (
                  <span className="placeholder">
                    The on-chain translation appears here.
                  </span>
                )}
              </div>
            </div>
          </div>

          <div className="widget-actions">
            <select value={lang} onChange={(e) => setLang(e.target.value)}>
              {LANGUAGES.map((l) => (
                <option key={l} value={l}>
                  → {l}
                </option>
              ))}
            </select>

            {account ? (
              <>
                <button
                  className="btn-ghost"
                  onClick={deposit}
                  disabled={busy || !configured}
                >
                  Fund 0.5 RIT
                </button>
                <button
                  className="btn-primary"
                  onClick={translate}
                  disabled={busy || !configured}
                >
                  {busy ? "Working…" : "Translate on-chain"}
                </button>
              </>
            ) : (
              <button
                className="btn-primary"
                onClick={() => connectWallet(setAccount)}
              >
                Connect wallet to start
              </button>
            )}
          </div>

          {status !== "idle" && (
            <div className="statusbar">
              <span className="dot" />
              <StatusLine status={status} />
              {txHash && (
                <a
                  href={`${ritualChain.blockExplorers.default.url}/tx/${txHash}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  view tx ↗
                </a>
              )}
            </div>
          )}
          {error && <div className="banner error">{error}</div>}
        </div>
      </div>
    </header>
  );
}

function StatusLine({ status }) {
  const map = {
    "selecting-executor": "Selecting a TEE executor from the registry…",
    submitting: "Submitting to the LLM precompile…",
    inferring: "Running inference inside the TEE (10–40s)…",
    depositing: "Depositing fees into RitualWallet…",
    done: "Done ✓",
  };
  return <span>{map[status] || status}</span>;
}

/* ------------------------------------------------------------------ */
/* Marquee                                                             */
/* ------------------------------------------------------------------ */

function Marquee() {
  const items = [
    "TEE-verified inference",
    "zai-org/GLM-4.7-FP8",
    "64K context",
    "On-chain storage",
    "No API keys",
    "Stateless · no backend",
    "EVM · chain 1979",
  ];
  const row = [...items, ...items];
  return (
    <div className="marquee">
      <div className="marquee-track">
        {row.map((t, i) => (
          <span key={i} className="marquee-item">
            {t} <em>◇</em>
          </span>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Features                                                            */
/* ------------------------------------------------------------------ */

function Features() {
  const cards = [
    {
      icon: "🛡️",
      title: "Verifiable, not trusted",
      body: "The model runs in a Trusted Execution Environment. The executor's attestation is registered on-chain and the output is bound to your exact request — an operator cannot fabricate or tamper with the result.",
    },
    {
      icon: "⛓️",
      title: "Translations live on-chain",
      body: "Every translation is decoded and persisted in contract storage and emitted as an event. Anyone can read, index, or build on the full history — it's permanent and public.",
    },
    {
      icon: "🔌",
      title: "Zero infrastructure",
      body: "No translation API, no server, no keys. The conversation-history field is left empty, so the contract talks to the LLM precompile directly with nothing to host or leak.",
    },
  ];
  return (
    <section id="why" className="section">
      <h2 className="section-title">Why Onchain Translator?</h2>
      <p className="section-sub">
        Not a wrapper around a Web2 API — a smart contract that thinks.
      </p>
      <div className="cards">
        {cards.map((c) => (
          <div key={c.title} className="feature-card">
            <div className="feature-icon">{c.icon}</div>
            <h3>{c.title}</h3>
            <p>{c.body}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* How it works                                                        */
/* ------------------------------------------------------------------ */

function HowItWorks() {
  const steps = [
    {
      n: "01",
      title: "You submit",
      body: "Call translate(executor, text, lang). The contract builds an OpenAI-style prompt on-chain and JSON-escapes your input.",
    },
    {
      n: "02",
      title: "Chain encodes",
      body: "The 30-field LLM request is ABI-encoded with convoHistory left empty, then sent to precompile 0x0802.",
    },
    {
      n: "03",
      title: "TEE infers",
      body: "A registered executor runs GLM-4.7-FP8 inside an enclave and produces a hardware-attested completion.",
    },
    {
      n: "04",
      title: "Result settles",
      body: "The chain re-executes your tx with the result injected, the contract decodes it and stores the translation — same transaction.",
    },
  ];
  return (
    <section id="how" className="section alt">
      <h2 className="section-title">How it works</h2>
      <p className="section-sub">
        One transaction, four protocol-level steps.
      </p>
      <div className="steps">
        {steps.map((s) => (
          <div key={s.n} className="step">
            <span className="step-n">{s.n}</span>
            <h3>{s.title}</h3>
            <p>{s.body}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Autonomous Agent                                                    */
/* ------------------------------------------------------------------ */

function AgentSection({ account, setAccount, walletClient }) {
  const [url, setUrl] = useState("https://api.adviceslip.com/advice");
  const [lang, setLang] = useState("Arabic");
  const [every, setEvery] = useState(40);
  const [runs, setRuns] = useState(10);
  const [running, setRunning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [feed, setFeed] = useState([]);
  const [err, setErr] = useState("");

  const configured =
    TRANSLATOR_ADDRESS && /^0x[a-fA-F0-9]{40}$/.test(TRANSLATOR_ADDRESS);

  async function refresh() {
    if (!configured) return;
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
      /* contract may not be deployed yet */
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
    <section id="agent" className="section alt">
      <h2 className="section-title">🤖 Autonomous Agent</h2>
      <p className="section-sub">
        Let the contract drive itself: it wakes up on the enshrined Scheduler,
        fetches fresh text over HTTP, and translates it — no server, no cron.
      </p>

      <div className="agent-wrap">
        <div className="agent-config card">
          <div className="agent-status">
            <span className={`status-dot ${running ? "on" : "off"}`} />
            {running ? "Agent is running" : "Agent is idle"}
          </div>

          <label>Source URL</label>
          <input
            type="text"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://api.adviceslip.com/advice"
          />

          <div className="agent-row">
            <div>
              <label>Translate to</label>
              <select value={lang} onChange={(e) => setLang(e.target.value)}>
                {LANGUAGES.map((l) => (
                  <option key={l} value={l}>
                    {l}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label>Every (blocks)</label>
              <input
                type="number"
                min="1"
                value={every}
                onChange={(e) => setEvery(e.target.value)}
              />
            </div>
            <div>
              <label>Runs</label>
              <input
                type="number"
                min="1"
                value={runs}
                onChange={(e) => setRuns(e.target.value)}
              />
            </div>
          </div>

          <div className="agent-actions">
            {running ? (
              <button className="btn-ghost" onClick={stop} disabled={busy || !configured}>
                {busy ? "…" : "Stop agent"}
              </button>
            ) : (
              <button
                className="btn-primary"
                onClick={start}
                disabled={busy || !configured}
              >
                {busy ? "Starting…" : account ? "Start agent (owner)" : "Connect to start"}
              </button>
            )}
          </div>
          {err && <div className="banner error">{err}</div>}
          <p className="agent-note">
            Only the contract owner can start/stop. The agent pays its own fees
            from the contract's RitualWallet balance.
          </p>
        </div>

        <div className="agent-feed">
          <div className="feed-head">
            Live on-chain feed
            <span className="feed-count">{feed.length}</span>
          </div>
          {feed.length === 0 ? (
            <div className="feed-empty">
              No autonomous translations yet. Start the agent and watch them
              appear here, written by the chain itself.
            </div>
          ) : (
            feed.map((t, i) => (
              <div key={i} className="feed-item">
                <div className="feed-lang">→ {t.targetLang}</div>
                <div className="feed-translated">
                  {t.hasError ? `⚠ ${t.errorMessage}` : t.translatedText}
                </div>
                <div className="feed-source">{t.sourceText.slice(0, 120)}</div>
              </div>
            ))
          )}
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Languages                                                           */
/* ------------------------------------------------------------------ */

function Languages() {
  return (
    <section id="langs" className="section">
      <h2 className="section-title">{LANGUAGES.length}+ languages</h2>
      <p className="section-sub">
        Translate to and from any of these — add more by editing one array.
      </p>
      <div className="lang-grid">
        {LANGUAGES.map((l) => (
          <span key={l} className="lang-chip">
            {l}
          </span>
        ))}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* FAQ                                                                 */
/* ------------------------------------------------------------------ */

function Faq() {
  const items = [
    {
      q: "Is the translation really on-chain?",
      a: "Yes. The contract sends the prompt to the LLM precompile, decodes the completion, and stores the translated text in contract storage. The model itself runs off-chain inside a TEE, but the request, the result, and its verification all live on-chain.",
    },
    {
      q: "Do I need an API key or a server?",
      a: "No. The LLM is enshrined as a chain precompile. Because the conversation-history field is empty, no storage provider or credentials are needed. The dApp is just a contract plus a static frontend.",
    },
    {
      q: "What does it cost?",
      a: "Each in-flight call escrows roughly 0.31 testnet RITUAL in the RitualWallet, refunded down to actual usage after settlement. Fund the contract with ~0.5 RIT to start. Get testnet RIT from the faucet.",
    },
    {
      q: "Why does a translation take 10–40 seconds?",
      a: "GLM-4.7-FP8 is a reasoning model. It produces an internal chain-of-thought before the final answer, which is why the output budget is set high and the TTL is 300 blocks.",
    },
    {
      q: "Which wallet do I use?",
      a: "Any EVM wallet (MetaMask works). The site adds and switches to Ritual Chain (id 1979) automatically when you connect.",
    },
  ];
  const [open, setOpen] = useState(0);
  return (
    <section id="faq" className="section alt">
      <h2 className="section-title">FAQ</h2>
      <div className="faq">
        {items.map((it, i) => (
          <div
            key={i}
            className={`faq-item ${open === i ? "open" : ""}`}
            onClick={() => setOpen(open === i ? -1 : i)}
          >
            <div className="faq-q">
              <span>{it.q}</span>
              <span className="faq-mark">{open === i ? "−" : "+"}</span>
            </div>
            {open === i && <p className="faq-a">{it.a}</p>}
          </div>
        ))}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Footer                                                              */
/* ------------------------------------------------------------------ */

function Footer() {
  return (
    <footer className="footer">
      <div className="footer-inner">
        <div className="brand">
          <span className="brand-glyph">◇</span> Onchain Translator
        </div>
        <div className="footer-links">
          <a href="https://faucet.ritualfoundation.org" target="_blank" rel="noreferrer">
            Faucet
          </a>
          <a href="https://explorer.ritualfoundation.org" target="_blank" rel="noreferrer">
            Explorer
          </a>
          <a href="https://docs.ritualfoundation.org" target="_blank" rel="noreferrer">
            Ritual Docs
          </a>
        </div>
        <span className="muted">Built on Ritual Chain · id 1979</span>
      </div>
    </footer>
  );
}
