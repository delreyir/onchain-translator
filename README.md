# 🌐 Onchain Translator + Autonomous Agent on Ritual Chain

Translate text **fully on-chain** using Ritual Chain's LLM precompile
(`0x0802`, model `zai-org/GLM-4.7-FP8`), and let the contract translate **by
itself** as an autonomous on-chain agent.

Two modes:

1. **Manual**: `translate(executor, text, lang)` lets anyone translate text on
   demand. The model runs in a TEE, the result is bound to the request and
   stored on-chain.
2. **Agent**: `startAgent(url, lang, everyBlocks, runs)` makes the contract use
   the enshrined **Scheduler** to wake itself up every N blocks, fetch fresh
   text over **HTTP** (`0x0801`), translate it via the **LLM** (`0x0802`), and
   store it on-chain. No server. No cron. The chain itself drives it.

> This showcases three precompiles working together (Scheduler + HTTP + LLM):
> a contract that *reads the web, thinks, and acts on its own*, which is exactly
> Ritual's autonomous-agent thesis. (Per-tx limit: one async call, so FETCH and
> TRANSLATE run on alternating wakeups.)

---

## How it works

```
User → translate(executor, text, lang)
          │
          ├─ build OpenAI-style messages JSON (on-chain, JSON-escaped)
          ├─ ABI-encode the 30-field LLM request (convoHistory = ("","",""))
          ├─ call LLM precompile 0x0802  ──► TEE executor runs inference
          │                                  (short-running async, fulfilled replay)
          ├─ unwrap (simmedInput, actualOutput)
          ├─ decode (hasError, completionData, …)
          ├─ extract choices[0].message.content
          └─ store + emit TranslationCompleted
```

- **Execution model:** short-running async. No callback. The settled result is
  injected into the same transaction, so the translation is available
  immediately and persisted to storage.
- **No DA credentials:** `convoHistory` is the empty StorageRef `("","","")`, so
  the executor skips off-chain storage entirely.
- **Fees:** each in-flight GLM-4.7-FP8 call escrows ~0.31 RIT in the
  `RitualWallet`. The contract funds itself via `depositForFees`.

---

## Project layout

```
onchain-translator/
├── contracts/RitualTranslatorAgent.sol  # the on-chain translator + agent
├── scripts/deploy.js                 # deploy + fund RitualWallet
├── hardhat.config.js                 # Ritual network (chainId 1979), viaIR
└── frontend/                         # React + viem dApp
    └── src/{App.jsx, ritual.js, …}
```

---

## 1. Deploy the contract

```bash
# from the repo root
npm install
cp .env.example .env        # then edit .env

# .env:
#   PRIVATE_KEY=0x...        (a funded testnet key, get RIT from the faucet)
#   FUND_RIT=0.5             (RITUAL to deposit for LLM fees; 0 to skip)

npm run compile
npm run deploy              # deploys to Ritual and funds the contract
```

Get testnet RITUAL from <https://faucet.ritualfoundation.org>.

The script prints the deployed address. Copy it.

## 2. Run the frontend

```bash
cd frontend
npm install
cp .env.example .env        # set VITE_TRANSLATOR_ADDRESS=<deployed address>
npm run dev
```

Open the printed localhost URL, connect MetaMask (it will add/switch to Ritual
automatically), type text, pick a language, and hit **Translate on-chain**.

---

## Key addresses (Ritual testnet)

| Item | Value |
|---|---|
| Chain ID | `1979` |
| RPC | `https://rpc.ritualfoundation.org` |
| Explorer | `https://explorer.ritualfoundation.org` |
| LLM precompile | `0x0000000000000000000000000000000000000802` |
| RitualWallet | `0x532F0dF0896F353d8C3DD8cc134e8129DA2a3948` |
| TEEServiceRegistry | `0x9644e8562cE0Fe12b4deeC4163c064A8862Bf47F` |
| Model | `zai-org/GLM-4.7-FP8` (64K context) |

---

## Notes & gotchas

- **GLM-4.7-FP8 is a reasoning model.** `maxCompletionTokens` is set to 4096 so
  the chain-of-thought doesn't starve the final answer.
- **TTL = 300 blocks.** Reasoning inference can take 10–40s; a low TTL risks
  `Request expired`.
- **One pending async call per wallet.** Wait for one translation to settle
  before sending another from the same account.
- **Fund before translating.** A 0.1 RIT balance is not enough for one call;
  deposit at least ~0.4 RIT (the deploy script deposits 0.5).
- The contract compiles with `viaIR: true` (the 30-field encode otherwise hits
  "stack too deep").

## Verified

- `npm run compile` → `Compiled 1 Solidity file successfully (evm target: shanghai)`
- `frontend: npx vite build` → built successfully (430 modules)
