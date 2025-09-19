// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IRegistry { function isValid(bytes32, bytes32) external view returns (bool); }
interface IERC20 { function transfer(address to, uint256 v) external returns(bool); function balanceOf(address) external view returns(uint256); }

contract RFQSettlement {
    IRegistry public registry;
    mapping(bytes32 => bool) public usedOrder; // Anti-replay protection
    event Settled(bytes32 orderHash, address base, address quote, uint256 size, uint256 price);

    constructor(address registry_) { registry = IRegistry(registry_); }

    function settleRFQ(
        bytes32 orderHash,
        bytes32 solvencyAtt,
        bytes32 kycAtt,
        bytes32 whitelistAtt,
        bytes32 bestExecAtt, // Optional; may be 0x0
        address maker,       // Maker (seller)
        address taker,       // Taker (buyer)
        address base,        // Example: USDC (maker -> taker)
        address quote,       // Example: ETH token (taker -> maker; demo also uses ERC20Mock)
        uint256 size,
        uint256 price
    ) external {
        require(!usedOrder[orderHash], "used");
        require(registry.isValid(solvencyAtt, orderHash), "solv");
        require(registry.isValid(kycAtt,      orderHash), "kyc");
        require(registry.isValid(whitelistAtt,orderHash), "wl");
        if (bestExecAtt != bytes32(0)) { require(registry.isValid(bestExecAtt, orderHash), "best"); }

        // Warning (demo): simple bi-directional transfer.
        // No allowance checks/permit; assumes the contract holds tokens or has been pre-approved.
        require(IERC20(base).transfer(taker, size), "base xfer");
        require(IERC20(quote).transfer(maker, (size*price)/1e6), "quote xfer");

        usedOrder[orderHash] = true;
        emit Settled(orderHash, base, quote, size, price);
    }
}
