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
  const [text, setText] = useState("");
  const [lang, setLang] = useState("Arabic");
  const [status, setStatus] = useState("idle");
  const [result, setResult] = useState("");
  const [error, setError] = useState("");
  const [txHash, setTxHash] = useState("");

  const walletClient = useMemo(() => {
    if (typeof window === "undefined" || !window.ethereum) return null;
    return createWalletClient({
      chain: ritualChain,
      transport: custom(window.ethereum),
    });
  }, []);

  const configured =
    TRANSLATOR_ADDRESS && /^0x[a-fA-F0-9]{40}$/.test(TRANSLATOR_ADDRESS);

  useEffect(() => {
    if (window.ethereum) {
      window.ethereum
        .request({ method: "eth_accounts" })
        .then((accs) => accs[0] && setAccount(accs[0]))
        .catch(() => {});
    }
  }, []);

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

  async function connect() {
    setError("");
    if (!window.ethereum) {
      setError("No EVM wallet found. Install MetaMask.");
      return;
    }
    const [acc] = await window.ethereum.request({
      method: "eth_requestAccounts",
    });
    await ensureChain();
    setAccount(acc);
  }

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
        args: [100000n], // lock ~10h
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

      // Pull the translation out of the TranslationCompleted event.
      let translated = "";
      let hadError = false;
      for (const log of receipt.logs) {
        if (
          log.address.toLowerCase() !== TRANSLATOR_ADDRESS.toLowerCase()
        )
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
        // Fallback: read the latest stored translation.
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

  const busy = ["selecting-executor", "submitting", "inferring", "depositing"].includes(
    status
  );

  return (
    <div className="app">
      <header>
        <h1>🌐 Onchain Translator</h1>
        <p className="sub">
          Text translated <strong>fully on-chain</strong> by the Ritual LLM
          precompile (<code>0x0802</code>). No API keys, no backend.
        </p>
      </header>

      {!configured && (
        <div className="banner error">
          Set <code>VITE_TRANSLATOR_ADDRESS</code> in <code>frontend/.env</code>{" "}
          to your deployed contract address.
        </div>
      )}

      <div className="wallet-row">
        {account ? (
          <span className="pill">
            {account.slice(0, 6)}…{account.slice(-4)}
          </span>
        ) : (
          <button onClick={connect}>Connect Wallet</button>
        )}
        {account && (
          <button className="ghost" onClick={deposit} disabled={busy || !configured}>
            Fund contract (0.5 RIT)
          </button>
        )}
      </div>

      <div className="card">
        <label>Source text</label>
        <textarea
          rows={5}
          placeholder="Type something to translate…"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />

        <div className="controls">
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
          <button
            className="primary"
            onClick={translate}
            disabled={busy || !configured || !account}
          >
            {busy ? "Working…" : "Translate on-chain"}
          </button>
        </div>
      </div>

      {status !== "idle" && (
        <div className="status">
          <StatusLine status={status} />
          {txHash && (
            <a
              href={`${ritualChain.blockExplorers.default.url}/tx/${txHash}`}
              target="_blank"
              rel="noreferrer"
            >
              View transaction ↗
            </a>
          )}
        </div>
      )}

      {result && (
        <div className="card result">
          <label>Translation ({lang})</label>
          <p>{result}</p>
        </div>
      )}

      {error && <div className="banner error">{error}</div>}

      <footer>
        Ritual Chain · id 1979 ·{" "}
        <a href="https://faucet.ritualfoundation.org" target="_blank" rel="noreferrer">
          Faucet
        </a>
      </footer>
    </div>
  );
}

function StatusLine({ status }) {
  const map = {
    "selecting-executor": "Selecting a TEE executor from the registry…",
    submitting: "Submitting transaction to the LLM precompile…",
    inferring: "Running inference in the TEE (10–40s)…",
    depositing: "Depositing fees into RitualWallet…",
    done: "Done ✓",
  };
  return <span>{map[status] || status}</span>;
}
