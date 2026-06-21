// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IScheduler {
    function schedule(
        bytes memory data,
        uint32 gas,
        uint32 startBlock,
        uint32 numCalls,
        uint32 frequency,
        uint32 ttl,
        uint256 maxFeePerGas,
        uint256 maxPriorityFeePerGas,
        uint256 value,
        address payer
    ) external returns (uint256 callId);

    function cancel(uint256 callId) external;

    function approveScheduler(address schedulerContract) external;
}

interface ITEEServiceRegistry {
    struct TEEServiceNode {
        address paymentAddress;
        address teeAddress;
        uint8 teeType;
        bytes publicKey;
        string endpoint;
        bytes32 certPubKeyHash;
        uint8 capability;
    }
    struct TEEServiceContext {
        TEEServiceNode node;
        bool isValid;
        bytes32 workloadId;
    }

    function getServicesByCapability(uint8 capability, bool checkValidity)
        external
        view
        returns (TEEServiceContext[] memory);
}

/// @title RitualTranslatorAgent
/// @notice An autonomous, self-driving translator on Ritual Chain.
///
///  Two modes, both fully on-chain:
///
///  1. MANUAL  — `translate(executor, text, lang)` lets any user translate
///     text on demand via the LLM precompile (0x0802).
///
///  2. AGENT   — the contract becomes an autonomous agent. The owner calls
///     `startAgent(...)`, which uses the enshrined Scheduler (0x56e7…) to wake
///     the contract up every N blocks with NO server or cron. On each wakeup
///     the agent alternates between two phases:
///        • FETCH     — pull fresh text from a real Web2 URL (HTTP precompile)
///        • TRANSLATE — translate that text into the target language (LLM)
///     and stores every result on-chain. The agent lives as long as it has
///     RitualWallet funds. This is exactly Ritual's "contract that thinks,
///     reads the web, and acts on its own" thesis.
///
///  Constraint respected: at most one async precompile call per transaction,
///  which is why FETCH and TRANSLATE happen on alternating wakeups.
contract RitualTranslatorAgent {
    // --- Ritual system addresses (chain id 1979) ---
    address internal constant LLM_PRECOMPILE =
        0x0000000000000000000000000000000000000802;
    address internal constant HTTP_PRECOMPILE =
        0x0000000000000000000000000000000000000801;
    address internal constant RITUAL_WALLET =
        0x532F0dF0896F353d8C3DD8cc134e8129DA2a3948;
    IScheduler internal constant SCHEDULER =
        IScheduler(0x56e776BAE2DD60664b69Bd5F865F1180ffB7D58B);
    ITEEServiceRegistry internal constant REGISTRY =
        ITEEServiceRegistry(0x9644e8562cE0Fe12b4deeC4163c064A8862Bf47F);

    uint8 internal constant CAP_HTTP = 0;
    uint8 internal constant CAP_LLM = 1;

    string internal constant MODEL = "zai-org/GLM-4.7-FP8";
    int256 internal constant MAX_COMPLETION_TOKENS = 4096;
    int256 internal constant TEMPERATURE = 200; // 0.2
    uint256 internal constant LLM_TTL = 300;
    uint256 internal constant HTTP_TTL = 60;

    struct StorageRef {
        string platform;
        string path;
        string keyRef;
    }

    struct Translation {
        address user;
        string sourceText;
        string targetLang;
        string translatedText;
        bool hasError;
        string errorMessage;
        bool autonomous; // true if produced by the agent
        uint256 timestamp;
    }

    address public owner;

    Translation[] public translations;
    mapping(address => uint256[]) public userTranslationIds;

    // --- agent state ---
    enum Phase {
        Fetch,
        Translate
    }
    bool public agentRunning;
    Phase public phase;
    string public sourceUrl;
    string public agentLang;
    string public pendingSource;
    uint256 public agentCallId;
    uint256 public agentRuns;

    event TranslationCompleted(
        uint256 indexed id,
        address indexed user,
        string targetLang,
        string translatedText,
        bool hasError,
        bool autonomous
    );
    event AgentStarted(string sourceUrl, string targetLang, uint32 everyBlocks, uint32 runs);
    event AgentStopped();
    event SourceFetched(string source);

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    // -------------------------------------------------------------------------
    // Fees
    // -------------------------------------------------------------------------

    function depositForFees(uint256 lockDuration) external payable {
        require(msg.value > 0, "no value");
        (bool ok, ) = RITUAL_WALLET.call{value: msg.value}(
            abi.encodeWithSignature("deposit(uint256)", lockDuration)
        );
        require(ok, "deposit failed");
    }

    // -------------------------------------------------------------------------
    // MANUAL MODE
    // -------------------------------------------------------------------------

    function translate(
        address executor,
        string calldata text,
        string calldata targetLang
    ) external returns (uint256 id) {
        require(executor != address(0), "executor required");
        require(bytes(text).length > 0, "empty text");
        require(bytes(targetLang).length > 0, "lang required");

        string memory system = _translatePrompt(targetLang);
        id = _runLLM(executor, system, text, text, targetLang, false);
    }

    // -------------------------------------------------------------------------
    // AGENT MODE
    // -------------------------------------------------------------------------

    /// @notice Turn this contract into an autonomous translating agent.
    /// @param url a Web2 URL returning text/JSON to translate (e.g. a quote API).
    /// @param targetLang language to translate fetched text into.
    /// @param everyBlocks blocks between wakeups (frequency).
    /// @param runs total number of wakeups to schedule.
    function startAgent(
        string calldata url,
        string calldata targetLang,
        uint32 everyBlocks,
        uint32 runs
    ) external onlyOwner {
        require(bytes(url).length > 0, "url required");
        require(everyBlocks >= 1, "freq>=1");
        require(runs >= 1, "runs>=1");

        sourceUrl = url;
        agentLang = targetLang;
        phase = Phase.Fetch;
        pendingSource = "";
        agentRunning = true;
        agentRuns = runs;

        // Authorize the Scheduler to call back into this contract.
        SCHEDULER.approveScheduler(address(SCHEDULER));

        bytes memory callData = abi.encodeWithSelector(
            this.wakeUp.selector,
            uint256(0) // placeholder, overwritten with executionIndex
        );

        agentCallId = SCHEDULER.schedule(
            callData,
            5_000_000, // gas per wakeup (async encode is heavy)
            uint32(block.number) + 5, // startBlock
            runs, // numCalls
            everyBlocks, // frequency
            120, // ttl (covers async settlement)
            block.basefee, // maxFeePerGas
            0, // maxPriorityFeePerGas
            0, // value
            address(this) // payer (this contract's RitualWallet balance)
        );

        emit AgentStarted(url, targetLang, everyBlocks, runs);
    }

    function stopAgent() external onlyOwner {
        agentRunning = false;
        if (agentCallId != 0) {
            // best-effort cancel; ignore failure if already completed
            try SCHEDULER.cancel(agentCallId) {} catch {}
        }
        emit AgentStopped();
    }

    /// @notice Wakeup entry point. Called by the Scheduler (or owner for tests).
    ///         Alternates FETCH and TRANSLATE so only one async call runs per tx.
    function wakeUp(uint256 /* executionIndex */) external {
        require(
            msg.sender == address(SCHEDULER) || msg.sender == owner,
            "unauthorized"
        );
        if (!agentRunning) return;

        if (phase == Phase.Fetch) {
            _agentFetch();
            phase = Phase.Translate;
        } else {
            _agentTranslate();
            phase = Phase.Fetch;
        }
    }

    function _agentFetch() internal {
        address executor = _pickExecutor(CAP_HTTP);
        bytes memory input = _encodeHTTPGet(executor, sourceUrl);

        (bool success, bytes memory raw) = HTTP_PRECOMPILE.call(input);
        require(success, "http call failed");

        (, bytes memory actualOutput) = abi.decode(raw, (bytes, bytes));
        (
            uint16 statusCode,
            ,
            ,
            bytes memory body,
            string memory err
        ) = abi.decode(actualOutput, (uint16, string[], string[], bytes, string));

        require(bytes(err).length == 0, err);
        require(statusCode == 200, "http status != 200");

        pendingSource = string(body);
        emit SourceFetched(pendingSource);
    }

    function _agentTranslate() internal {
        if (bytes(pendingSource).length == 0) return;
        address executor = _pickExecutor(CAP_LLM);
        string memory system = _extractTranslatePrompt(agentLang);
        _runLLM(executor, system, pendingSource, pendingSource, agentLang, true);
        pendingSource = "";
    }

    // -------------------------------------------------------------------------
    // Shared LLM execution
    // -------------------------------------------------------------------------

    function _runLLM(
        address executor,
        string memory systemPrompt,
        string memory userText,
        string memory storedSource,
        string memory lang,
        bool autonomous
    ) internal returns (uint256 id) {
        id = translations.length;
        translations.push(
            Translation({
                user: msg.sender,
                sourceText: storedSource,
                targetLang: lang,
                translatedText: "",
                hasError: false,
                errorMessage: "",
                autonomous: autonomous,
                timestamp: block.timestamp
            })
        );
        userTranslationIds[msg.sender].push(id);

        string memory messagesJson = _buildMessages(systemPrompt, userText);
        bytes memory input = _encodeLLMRequest(executor, messagesJson);

        (bool success, bytes memory raw) = LLM_PRECOMPILE.call(input);
        require(success, "precompile call failed");

        (, bytes memory actualOutput) = abi.decode(raw, (bytes, bytes));
        (
            bool hasError,
            bytes memory completionData,
            ,
            string memory errorMessage,

        ) = abi.decode(actualOutput, (bool, bytes, bytes, string, StorageRef));

        Translation storage t = translations[id];
        if (hasError) {
            t.hasError = true;
            t.errorMessage = errorMessage;
            emit TranslationCompleted(id, msg.sender, lang, "", true, autonomous);
            return id;
        }

        string memory content = _extractContent(completionData);
        t.translatedText = content;
        emit TranslationCompleted(id, msg.sender, lang, content, false, autonomous);
    }

    // -------------------------------------------------------------------------
    // Views
    // -------------------------------------------------------------------------

    function translationsCount() external view returns (uint256) {
        return translations.length;
    }

    function getTranslation(uint256 id) external view returns (Translation memory) {
        require(id < translations.length, "bad id");
        return translations[id];
    }

    function getUserTranslationIds(address user)
        external
        view
        returns (uint256[] memory)
    {
        return userTranslationIds[user];
    }

    /// @notice Returns the most recent `n` translations (newest first).
    function getRecent(uint256 n) external view returns (Translation[] memory) {
        uint256 total = translations.length;
        if (n > total) n = total;
        Translation[] memory out = new Translation[](n);
        for (uint256 i = 0; i < n; i++) {
            out[i] = translations[total - 1 - i];
        }
        return out;
    }

    // -------------------------------------------------------------------------
    // Internal: executor selection
    // -------------------------------------------------------------------------

    function _pickExecutor(uint8 capability) internal view returns (address) {
        ITEEServiceRegistry.TEEServiceContext[] memory svcs = REGISTRY
            .getServicesByCapability(capability, true);
        for (uint256 i = 0; i < svcs.length; i++) {
            if (svcs[i].isValid) return svcs[i].node.teeAddress;
        }
        revert("no executor");
    }

    // -------------------------------------------------------------------------
    // Internal: prompt building
    // -------------------------------------------------------------------------

    function _translatePrompt(string memory lang)
        internal
        pure
        returns (string memory)
    {
        return
            string.concat(
                "You are a professional translation engine. Translate the ",
                "user's text into ",
                _jsonEscape(lang),
                ". Output ONLY the translated text, with no explanations or quotes."
            );
    }

    function _extractTranslatePrompt(string memory lang)
        internal
        pure
        returns (string memory)
    {
        return
            string.concat(
                "You will receive raw content (often JSON) fetched from a URL. ",
                "Extract the main human-readable message and translate it into ",
                _jsonEscape(lang),
                ". Output ONLY the translated message, nothing else."
            );
    }

    function _buildMessages(string memory systemPrompt, string memory userText)
        internal
        pure
        returns (string memory)
    {
        return
            string.concat(
                '[{"role":"system","content":"',
                systemPrompt,
                '"},{"role":"user","content":"',
                _jsonEscape(userText),
                '"}]'
            );
    }

    function _jsonEscape(string memory s) internal pure returns (string memory) {
        bytes memory b = bytes(s);
        bytes memory out = new bytes(b.length * 6);
        uint256 j = 0;
        for (uint256 i = 0; i < b.length; i++) {
            bytes1 c = b[i];
            if (c == '"') {
                out[j++] = "\\";
                out[j++] = '"';
            } else if (c == "\\") {
                out[j++] = "\\";
                out[j++] = "\\";
            } else if (c == 0x0a) {
                out[j++] = "\\";
                out[j++] = "n";
            } else if (c == 0x0d) {
                out[j++] = "\\";
                out[j++] = "r";
            } else if (c == 0x09) {
                out[j++] = "\\";
                out[j++] = "t";
            } else if (uint8(c) < 0x20) {
                out[j++] = "\\";
                out[j++] = "u";
                out[j++] = "0";
                out[j++] = "0";
                out[j++] = _hexChar(uint8(c) >> 4);
                out[j++] = _hexChar(uint8(c) & 0x0f);
            } else {
                out[j++] = c;
            }
        }
        assembly {
            mstore(out, j)
        }
        return string(out);
    }

    function _hexChar(uint8 v) internal pure returns (bytes1) {
        return v < 10 ? bytes1(uint8(0x30 + v)) : bytes1(uint8(0x57 + v));
    }

    // -------------------------------------------------------------------------
    // Internal: ABI encoders
    // -------------------------------------------------------------------------

    function _encodeHTTPGet(address executor, string memory url)
        internal
        pure
        returns (bytes memory)
    {
        return
            abi.encode(
                executor, // 1  executor
                new bytes[](0), // 2  encryptedSecrets
                HTTP_TTL, // 3  ttl
                new bytes[](0), // 4  secretSignatures
                bytes(""), // 5  userPublicKey
                url, // 6  url
                uint8(1), // 7  method = GET
                new string[](0), // 8  headersKeys
                new string[](0), // 9  headersValues
                bytes(""), // 10 body
                uint256(0), // 11 dkmsKeyIndex
                uint8(0), // 12 dkmsKeyFormat
                false // 13 piiEnabled
            );
    }

    function _encodeLLMRequest(address executor, string memory messagesJson)
        internal
        pure
        returns (bytes memory)
    {
        StorageRef memory emptyHistory = StorageRef("", "", "");
        return
            abi.encode(
                executor, // 1
                new bytes[](0), // 2
                LLM_TTL, // 3
                new bytes[](0), // 4
                bytes(""), // 5
                messagesJson, // 6
                MODEL, // 7
                int256(0), // 8
                "", // 9
                false, // 10
                MAX_COMPLETION_TOKENS, // 11
                "", // 12
                "", // 13
                uint256(1), // 14
                true, // 15
                int256(0), // 16
                "medium", // 17
                bytes(""), // 18
                int256(-1), // 19
                "auto", // 20
                "", // 21
                false, // 22
                TEMPERATURE, // 23
                bytes(""), // 24
                bytes(""), // 25
                int256(-1), // 26
                int256(1000), // 27
                "", // 28
                false, // 29
                emptyHistory // 30
            );
    }

    function _extractContent(bytes memory completionData)
        internal
        pure
        returns (string memory)
    {
        if (completionData.length == 0) return "";

        (, , , , , , uint256 choicesCount, bytes[] memory choicesData, ) = abi
            .decode(
                completionData,
                (
                    string,
                    string,
                    uint256,
                    string,
                    string,
                    string,
                    uint256,
                    bytes[],
                    bytes
                )
            );

        if (choicesCount == 0 || choicesData.length == 0) return "";

        (, , bytes memory messageData) = abi.decode(
            choicesData[0],
            (uint256, string, bytes)
        );

        (, string memory content, , , ) = abi.decode(
            messageData,
            (string, string, string, uint256, bytes[])
        );

        return content;
    }

    receive() external payable {}
}
