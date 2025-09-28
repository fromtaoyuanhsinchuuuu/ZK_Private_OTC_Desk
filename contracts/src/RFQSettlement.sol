// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IRegistry {
    function isValid(bytes32 attestId, bytes32 orderHash) external view returns (bool);
    function attMaskByOrder(bytes32 orderHash) external view returns (uint8);
    function attestationOK(bytes32 orderHash) external view returns (bool);
}

interface IERC20 {
    function transfer(address to, uint256 value) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

contract RFQSettlement {
    /// @notice Bitmask representing the three attestation types (1|2|4 = 0x07)
    uint8 public constant FULL_ATTESTATION_MASK = 0x07;

    /// @notice EIP-712 domain & quote struct hashes
    bytes32 public constant EIP712_DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );
    bytes32 public constant QUOTE_TYPEHASH = keccak256(
        "QuoteCommitment(bytes32 orderHash,address maker,uint256 quoteAmount,uint64 validUntil,uint256 nonce)"
    );

    /// @notice Registry contract for attestation validation
    IRegistry public immutable registry;

    /// @notice Cached domain separator for EIP-712 signatures
    bytes32 private immutable _DOMAIN_SEPARATOR;

    /// @notice RFQ metadata stored on-chain
    struct RFQ {
        address maker;
        uint64 expiry;
    }

    /// @notice Commitment signed off-chain by the quote maker
    struct QuoteCommitment {
        bytes32 orderHash;
        address maker;
        uint256 quoteAmount;
        uint64 validUntil;
        uint256 nonce;
    }

    /// @notice RFQs keyed by order hash
    mapping(bytes32 => RFQ) public rfqs;
    /// @notice Anti-replay protection for orders
    mapping(bytes32 => bool) public usedOrder;
    /// @notice Anti-replay protection for quotes
    mapping(bytes32 => bool) public usedQuote;

    /// ---------------------------------------------------------------------
    /// Errors
    /// ---------------------------------------------------------------------
    error RFQExists();
    error InvalidExpiry();
    error RFQNotOpen();
    error NotRFQMaker();
    error RFQExpired();
    error OrderUsed();
    error QuoteExpired();
    error QuoteUsed();
    error InvalidQuoteSignature();
    error QuoteAmountMismatch(uint256 expected, uint256 provided);
    error AttestationMissing(uint8 mask);
    error InvalidSolvencyAttestation();
    error InvalidKycAttestation();
    error InvalidWhitelistAttestation();
    error InvalidBestExecAttestation();
    error BaseTransferFailed();
    error QuoteTransferFailed();

    /// ---------------------------------------------------------------------
    /// Events
    /// ---------------------------------------------------------------------
    event RFQCreated(bytes32 indexed orderHash, address indexed maker, uint64 expiry);
    event RFQCancelled(bytes32 indexed orderHash);
    event RFQExpiredEvent(bytes32 indexed orderHash);
    event QuoteConsumed(bytes32 indexed quoteHash, bytes32 indexed orderHash, address indexed maker);
    event RFQSettled(
        bytes32 indexed orderHash,
        address indexed maker,
        address indexed taker,
        address baseToken,
        address quoteToken,
        uint256 baseAmount,
        uint256 quoteAmount,
        uint64 rfqExpiry,
        uint64 quoteValidUntil,
        uint256 quoteNonce
    );

    constructor(address registry_) {
        registry = IRegistry(registry_);
        _DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH,
                keccak256(bytes("ZKPrivateOTC")),
                keccak256(bytes("1")),
                block.chainid,
                address(this)
            )
        );
    }

    /// ---------------------------------------------------------------------
    /// RFQ lifecycle
    /// ---------------------------------------------------------------------

    function domainSeparator() external view returns (bytes32) {
        return _DOMAIN_SEPARATOR;
    }

    function createRFQ(bytes32 orderHash, uint64 expiry) external {
        if (expiry <= block.timestamp) revert InvalidExpiry();
        if (rfqs[orderHash].maker != address(0) || usedOrder[orderHash]) revert RFQExists();

        rfqs[orderHash] = RFQ({maker: msg.sender, expiry: expiry});
        emit RFQCreated(orderHash, msg.sender, expiry);
    }

    function cancelRFQ(bytes32 orderHash) external {
        RFQ storage order = rfqs[orderHash];
        if (order.maker == address(0)) revert RFQNotOpen();
        if (msg.sender != order.maker) revert NotRFQMaker();

        delete rfqs[orderHash];
        usedOrder[orderHash] = true;
        emit RFQCancelled(orderHash);
    }

    function isOpen(bytes32 orderHash) public view returns (bool) {
        RFQ memory order = rfqs[orderHash];
        return order.maker != address(0) && !usedOrder[orderHash] && block.timestamp <= order.expiry;
    }

    /// ---------------------------------------------------------------------
    /// Quote commitment helpers
    /// ---------------------------------------------------------------------

    function quoteStructHash(QuoteCommitment calldata quote_) external pure returns (bytes32) {
        return keccak256(
            abi.encode(
                QUOTE_TYPEHASH,
                quote_.orderHash,
                quote_.maker,
                quote_.quoteAmount,
                quote_.validUntil,
                quote_.nonce
            )
        );
    }

    function quoteDigest(QuoteCommitment calldata quote_) external view returns (bytes32) {
        return _digest(quote_);
    }

    /// ---------------------------------------------------------------------
    /// Settlement
    /// ---------------------------------------------------------------------

    function settleRFQ(
        QuoteCommitment calldata quote_,
        uint8 v,
        bytes32 r,
        bytes32 s,
        bytes32 solvencyAtt,
        bytes32 kycAtt,
        bytes32 whitelistAtt,
        bytes32 bestExecAtt,
        address taker,
        address baseToken,
        address quoteToken,
        uint256 size,
        uint256 price
    ) external {
        bytes32 orderHash = quote_.orderHash;
        RFQ storage order = rfqs[orderHash];

        if (usedOrder[orderHash]) revert OrderUsed();
        if (order.maker == address(0)) revert RFQNotOpen();
        if (block.timestamp > order.expiry) {
            delete rfqs[orderHash];
            usedOrder[orderHash] = true;
            emit RFQExpiredEvent(orderHash);
            revert RFQExpired();
        }
        if (quote_.maker != order.maker) revert NotRFQMaker();
        if (block.timestamp > quote_.validUntil) revert QuoteExpired();

        bytes32 quoteKey = _hash(quote_);
        if (usedQuote[quoteKey]) revert QuoteUsed();
        if (_verify(quote_, v, r, s) != quote_.maker) revert InvalidQuoteSignature();

        if (quote_.quoteAmount != (size * price) / 1e6) {
            revert QuoteAmountMismatch((size * price) / 1e6, quote_.quoteAmount);
        }

        if (!registry.isValid(solvencyAtt, orderHash)) revert InvalidSolvencyAttestation();
        if (!registry.isValid(kycAtt, orderHash)) revert InvalidKycAttestation();
        if (!registry.isValid(whitelistAtt, orderHash)) revert InvalidWhitelistAttestation();
        if (bestExecAtt != bytes32(0) && !registry.isValid(bestExecAtt, orderHash)) revert InvalidBestExecAttestation();

        if (!registry.attestationOK(orderHash)) {
            revert AttestationMissing(registry.attMaskByOrder(orderHash));
        }

        usedQuote[quoteKey] = true;
        usedOrder[orderHash] = true;

        if (!IERC20(baseToken).transfer(taker, size)) revert BaseTransferFailed();
        if (!IERC20(quoteToken).transfer(order.maker, quote_.quoteAmount)) revert QuoteTransferFailed();

        emit QuoteConsumed(quoteKey, orderHash, order.maker);
        emit RFQSettled(
            orderHash,
            order.maker,
            taker,
            baseToken,
            quoteToken,
            size,
            quote_.quoteAmount,
            order.expiry,
            quote_.validUntil,
            quote_.nonce
        );

        delete rfqs[orderHash];
    }

    /// ---------------------------------------------------------------------
    /// Internal helpers
    /// ---------------------------------------------------------------------

    function _hash(QuoteCommitment calldata quote_) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                QUOTE_TYPEHASH,
                quote_.orderHash,
                quote_.maker,
                quote_.quoteAmount,
                quote_.validUntil,
                quote_.nonce
            )
        );
    }

    function _digest(QuoteCommitment calldata quote_) internal view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", _DOMAIN_SEPARATOR, _hash(quote_)));
    }

    function _verify(QuoteCommitment calldata quote_, uint8 v, bytes32 r, bytes32 s) internal view returns (address) {
        return ecrecover(_digest(quote_), v, r, s);
    }
}

