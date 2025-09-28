// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract AttestationRegistry {
    uint8 public constant ATTESTATION_KYC = 0x01;
    uint8 public constant ATTESTATION_SOLVENCY = 0x02;
    uint8 public constant ATTESTATION_SANCTIONS = 0x04;
    uint8 public constant FULL_ATTESTATION_MASK = ATTESTATION_KYC | ATTESTATION_SOLVENCY | ATTESTATION_SANCTIONS;

    mapping(bytes32 => bytes32) public subjectOf; // attestId => orderHash
    mapping(bytes32 => uint8) public attMaskByOrder; // orderHash => mask

    error AttestationAlreadyRecorded();
    error InvalidAttestationType(uint8 provided);

    event Recorded(bytes32 indexed attestId, bytes32 indexed orderHash);
    event AttestationRecorded(uint8 attType, bytes32 indexed orderHash, uint8 newMask);

    function record(bytes32, bytes32) external pure {
        revert("AttestationRegistry: attType required");
    }

    function record(bytes32 attestId, bytes32 orderHash, uint8 attType) external {
        if (subjectOf[attestId] != bytes32(0)) revert AttestationAlreadyRecorded();
        subjectOf[attestId] = orderHash;
        emit Recorded(attestId, orderHash);

        if (attType == 0) revert InvalidAttestationType(attType);
        uint8 normalized = _normalizeAttType(attType);
        uint8 newMask = attMaskByOrder[orderHash] | normalized;
        attMaskByOrder[orderHash] = newMask;
        emit AttestationRecorded(normalized, orderHash, newMask);
    }

    function isValid(bytes32 attestId, bytes32 orderHash) external view returns (bool) {
        return subjectOf[attestId] == orderHash;
    }

    function attestationOK(bytes32 orderHash) external view returns (bool) {
        return (attMaskByOrder[orderHash] & FULL_ATTESTATION_MASK) == FULL_ATTESTATION_MASK;
    }

    function _normalizeAttType(uint8 attType) internal pure returns (uint8) {
        if (
            attType == ATTESTATION_KYC || attType == ATTESTATION_SOLVENCY || attType == ATTESTATION_SANCTIONS
        ) {
            return attType;
        }
        revert InvalidAttestationType(attType);
    }
}
