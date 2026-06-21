// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title OnchainTranslator
/// @notice Translates arbitrary text fully on-chain using Ritual Chain's LLM
///         precompile (0x0802, model `zai-org/GLM-4.7-FP8`).
///
///         The LLM call is a SHORT-RUNNING async precompile: the executor runs
///         inference off-chain inside a TEE and the chain re-executes this tx
///         with the settled result injected (fulfilled replay). There is no
///         callback — the result is available in the SAME transaction, so we
///         decode it and persist the translation in contract storage here.
///
///         Conversation history (`convoHistory`) is left empty
///         (`("","","")`), so NO off-chain storage provider or credentials are
///         required. The translator is fully stateless from the LLM's view.
contract OnchainTranslator {
    // --- Ritual system addresses (chain id 1979) ---
    address internal constant LLM_PRECOMPILE =
        0x0000000000000000000000000000000000000802;
    address internal constant RITUAL_WALLET =
        0x532F0dF0896F353d8C3DD8cc134e8129DA2a3948;

    string internal constant MODEL = "zai-org/GLM-4.7-FP8";

    // GLM-4.7-FP8 is a reasoning model: keep the output budget high so the
    // chain-of-thought does not starve the final answer.
    int256 internal constant MAX_COMPLETION_TOKENS = 4096;
    // Low temperature -> deterministic, faithful translations.
    int256 internal constant TEMPERATURE = 200; // 0.2 (scaled x1000)
    // TTL in blocks: reasoning inference can take 10-40s. 300 ~= 105s.
    uint256 internal constant TTL = 300;

    /// @dev StorageRef tuple expected by the LLM precompile (field 30).
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
        uint256 timestamp;
    }

    Translation[] public translations;
    mapping(address => uint256[]) public userTranslationIds;

    event TranslationRequested(
        uint256 indexed id,
        address indexed user,
        string targetLang
    );
    event TranslationCompleted(
        uint256 indexed id,
        address indexed user,
        string targetLang,
        string translatedText,
        bool hasError
    );

    /// @notice Deposit RITUAL into the RitualWallet to cover LLM fees for this
    ///         contract. Each in-flight GLM-4.7-FP8 call escrows ~0.31 RIT, so
    ///         deposit at least ~0.4 RIT before translating.
    /// @param lockDuration number of blocks to lock the deposit for.
    function depositForFees(uint256 lockDuration) external payable {
        require(msg.value > 0, "no value");
        (bool ok, ) = RITUAL_WALLET.call{value: msg.value}(
            abi.encodeWithSignature("deposit(uint256)", lockDuration)
        );
        require(ok, "deposit failed");
    }

    /// @notice Translate `text` into `targetLang` on-chain.
    /// @param executor a valid LLM TEE executor (node.teeAddress) fetched from
    ///        the TEEServiceRegistry off-chain.
    /// @param text the source text to translate.
    /// @param targetLang target language name (e.g. "French", "Arabic").
    /// @return id the id of the stored translation.
    function translate(
        address executor,
        string calldata text,
        string calldata targetLang
    ) external returns (uint256 id) {
        require(executor != address(0), "executor required");
        require(bytes(text).length > 0, "empty text");
        require(bytes(targetLang).length > 0, "lang required");

        id = translations.length;
        translations.push(
            Translation({
                user: msg.sender,
                sourceText: text,
                targetLang: targetLang,
                translatedText: "",
                hasError: false,
                errorMessage: "",
                timestamp: block.timestamp
            })
        );
        userTranslationIds[msg.sender].push(id);
        emit TranslationRequested(id, msg.sender, targetLang);

        string memory messagesJson = _buildMessages(text, targetLang);
        bytes memory input = _encodeLLMRequest(executor, messagesJson);

        (bool success, bytes memory raw) = LLM_PRECOMPILE.call(input);
        require(success, "precompile call failed");

        // Unwrap the short-running async envelope: (simmedInput, actualOutput).
        (, bytes memory actualOutput) = abi.decode(raw, (bytes, bytes));

        (
            bool hasError,
            bytes memory completionData,
            ,
            string memory errorMessage,

        ) = abi.decode(
                actualOutput,
                (bool, bytes, bytes, string, StorageRef)
            );

        Translation storage t = translations[id];
        if (hasError) {
            t.hasError = true;
            t.errorMessage = errorMessage;
            emit TranslationCompleted(id, msg.sender, targetLang, "", true);
            return id;
        }

        string memory content = _extractContent(completionData);
        t.translatedText = content;
        emit TranslationCompleted(id, msg.sender, targetLang, content, false);
    }

    // -------------------------------------------------------------------------
    // Views
    // -------------------------------------------------------------------------

    function translationsCount() external view returns (uint256) {
        return translations.length;
    }

    function getTranslation(uint256 id)
        external
        view
        returns (Translation memory)
    {
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

    // -------------------------------------------------------------------------
    // Internal: prompt construction
    // -------------------------------------------------------------------------

    /// @dev Builds an OpenAI-style messages JSON array, JSON-escaping user input.
    function _buildMessages(string calldata text, string calldata targetLang)
        internal
        pure
        returns (string memory)
    {
        string memory escapedLang = _jsonEscape(targetLang);
        string memory escapedText = _jsonEscape(text);

        string memory system = string.concat(
            "You are a professional translation engine. Translate the user's ",
            "text into ",
            escapedLang,
            ". Output ONLY the translated text, with no explanations, no ",
            "quotes, and no extra commentary."
        );

        return
            string.concat(
                '[{"role":"system","content":"',
                system,
                '"},{"role":"user","content":"',
                escapedText,
                '"}]'
            );
    }

    /// @dev Minimal JSON string escaper for the characters that would break a
    ///      JSON string literal.
    function _jsonEscape(string memory s)
        internal
        pure
        returns (string memory)
    {
        bytes memory b = bytes(s);
        // Worst case every char expands to 2 (e.g. \" ) plus \u00XX (6) for
        // control chars; allocate generously.
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
                // Other control chars -> \u00XX
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
        // shrink to used length
        assembly {
            mstore(out, j)
        }
        return string(out);
    }

    function _hexChar(uint8 v) internal pure returns (bytes1) {
        return
            v < 10
                ? bytes1(uint8(0x30 + v)) // '0'..'9'
                : bytes1(uint8(0x57 + v)); // 'a'..'f'
    }

    // -------------------------------------------------------------------------
    // Internal: ABI encode the 30-field LLM request
    // -------------------------------------------------------------------------

    function _encodeLLMRequest(address executor, string memory messagesJson)
        internal
        pure
        returns (bytes memory)
    {
        StorageRef memory emptyHistory = StorageRef("", "", "");
        return
            abi.encode(
                executor, // 1  executor
                new bytes[](0), // 2  encryptedSecrets
                TTL, // 3  ttl
                new bytes[](0), // 4  secretSignatures
                bytes(""), // 5  userPublicKey
                messagesJson, // 6  messagesJson
                MODEL, // 7  model
                int256(0), // 8  frequencyPenalty
                "", // 9  logitBiasJson
                false, // 10 logprobs
                MAX_COMPLETION_TOKENS, // 11 maxCompletionTokens
                "", // 12 metadataJson
                "", // 13 modalitiesJson
                uint256(1), // 14 n
                true, // 15 parallelToolCalls
                int256(0), // 16 presencePenalty
                "medium", // 17 reasoningEffort
                bytes(""), // 18 responseFormatData
                int256(-1), // 19 seed
                "auto", // 20 serviceTier
                "", // 21 stopJson
                false, // 22 stream
                TEMPERATURE, // 23 temperature
                bytes(""), // 24 toolChoiceData
                bytes(""), // 25 toolsData
                int256(-1), // 26 topLogprobs
                int256(1000), // 27 topP
                "", // 28 user
                false, // 29 piiEnabled
                emptyHistory // 30 convoHistory
            );
    }

    // -------------------------------------------------------------------------
    // Internal: decode the nested completion payload to extract the answer
    // -------------------------------------------------------------------------

    /// @dev completionData layout:
    ///  (string id, string object, uint256 created, string model,
    ///   string systemFingerprint, string serviceTier,
    ///   uint256 choicesCount, bytes[] choicesData, bytes usageData)
    ///  choicesData[0]: (uint256 index, string finishReason, bytes messageData)
    ///  messageData: (string role, string content, string refusal,
    ///                uint256 toolCallsCount, bytes[] toolCallsData)
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

    /// @notice Accept native RITUAL (e.g. fee refunds from RitualWallet).
    receive() external payable {}
}
