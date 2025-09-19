// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract AttestationRegistry {
    mapping(bytes32 => bytes32) public subjectOf; // attestId => orderHash
    event Recorded(bytes32 indexed attestId, bytes32 indexed orderHash);
    function record(bytes32 attestId, bytes32 orderHash) external {
        require(subjectOf[attestId] == bytes32(0), "used");
        subjectOf[attestId] = orderHash;
        emit Recorded(attestId, orderHash);
    }
    function isValid(bytes32 attestId, bytes32 orderHash) external view returns (bool) {
        return subjectOf[attestId] == orderHash;
    }
}
