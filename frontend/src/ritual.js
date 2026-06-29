import { defineChain } from "viem";

// --- Ritual Chain (testnet) ---
export const ritualChain = defineChain({
  id: 1979,
  name: "Ritual",
  nativeCurrency: { name: "RITUAL", symbol: "RITUAL", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://rpc.ritualfoundation.org"] },
  },
  blockExplorers: {
    default: {
      name: "Ritual Explorer",
      url: "https://explorer.ritualfoundation.org",
    },
  },
});

// --- System contracts ---
export const TEE_SERVICE_REGISTRY =
  "0x9644e8562cE0Fe12b4deeC4163c064A8862Bf47F";
// RitualWallet: prepaid fee escrow. Manual (EOA-initiated) precompile calls are
// paid from the *caller's* balance here, so each user funds their own balance.
export const RITUAL_WALLET = "0x532F0dF0896F353d8C3DD8cc134e8129DA2a3948";
export const CAPABILITY_LLM = 1;

// --- Your deployed translator ---
export const TRANSLATOR_ADDRESS = import.meta.env.VITE_TRANSLATOR_ADDRESS;

// --- ABIs ---
const translationTuple = {
  type: "tuple",
  components: [
    { name: "user", type: "address" },
    { name: "sourceText", type: "string" },
    { name: "targetLang", type: "string" },
    { name: "translatedText", type: "string" },
    { name: "hasError", type: "bool" },
    { name: "errorMessage", type: "string" },
    { name: "autonomous", type: "bool" },
    { name: "timestamp", type: "uint256" },
  ],
};

export const translatorAbi = [
  {
    type: "function",
    name: "translate",
    stateMutability: "nonpayable",
    inputs: [
      { name: "executor", type: "address" },
      { name: "text", type: "string" },
      { name: "targetLang", type: "string" },
    ],
    outputs: [{ name: "id", type: "uint256" }],
  },
  {
    type: "function",
    name: "depositForFees",
    stateMutability: "payable",
    inputs: [{ name: "lockDuration", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "startAgent",
    stateMutability: "nonpayable",
    inputs: [
      { name: "url", type: "string" },
      { name: "targetLang", type: "string" },
      { name: "everyBlocks", type: "uint32" },
      { name: "runs", type: "uint32" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "stopAgent",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [],
  },
  {
    type: "function",
    name: "agentRunning",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "owner",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "sourceUrl",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "string" }],
  },
  {
    type: "function",
    name: "getTranslation",
    stateMutability: "view",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [translationTuple],
  },
  {
    type: "function",
    name: "getRecent",
    stateMutability: "view",
    inputs: [{ name: "n", type: "uint256" }],
    outputs: [{ type: "tuple[]", components: translationTuple.components }],
  },
  {
    type: "function",
    name: "translationsCount",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "event",
    name: "TranslationCompleted",
    inputs: [
      { name: "id", type: "uint256", indexed: true },
      { name: "user", type: "address", indexed: true },
      { name: "targetLang", type: "string", indexed: false },
      { name: "translatedText", type: "string", indexed: false },
      { name: "hasError", type: "bool", indexed: false },
      { name: "autonomous", type: "bool", indexed: false },
    ],
  },
];

export const teeRegistryAbi = [
  {
    name: "getServicesByCapability",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "capability", type: "uint8" },
      { name: "checkValidity", type: "bool" },
    ],
    outputs: [
      {
        name: "services",
        type: "tuple[]",
        components: [
          {
            name: "node",
            type: "tuple",
            components: [
              { name: "paymentAddress", type: "address" },
              { name: "teeAddress", type: "address" },
              { name: "teeType", type: "uint8" },
              { name: "publicKey", type: "bytes" },
              { name: "endpoint", type: "string" },
              { name: "certPubKeyHash", type: "bytes32" },
              { name: "capability", type: "uint8" },
            ],
          },
          { name: "isValid", type: "bool" },
          { name: "workloadId", type: "bytes32" },
        ],
      },
    ],
  },
];

export const ritualWalletAbi = [
  {
    type: "function",
    name: "deposit",
    stateMutability: "payable",
    inputs: [{ name: "lockDuration", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "lockUntil",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
];

export const LANGUAGES = [
  "Arabic",
  "English",
  "French",
  "Spanish",
  "German",
  "Italian",
  "Portuguese",
  "Chinese",
  "Japanese",
  "Korean",
  "Russian",
  "Turkish",
  "Hindi",
];
