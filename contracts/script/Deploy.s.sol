// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
import "forge-std/Script.sol";
import {AttestationRegistry} from "../src/AttestationRegistry.sol";
import {RFQSettlement} from "../src/RFQSettlement.sol";
import {ERC20Mock} from "../src/ERC20Mock.sol";

contract Deploy is Script {
    function run() external {
        // Use PRIVATE_KEY from env to avoid Foundry default sender safety error
        // Accepts 0x-prefixed hex; convert to uint256
        bytes32 pkBytes = vm.envBytes32("PRIVATE_KEY");
        uint256 pk = uint256(pkBytes);
        vm.startBroadcast(pk);
        AttestationRegistry reg = new AttestationRegistry();
        RFQSettlement settle = new RFQSettlement(address(reg));
        ERC20Mock usdc = new ERC20Mock("USDC","USDC", 1_000_000e18);
        ERC20Mock ethm = new ERC20Mock("ETHm","ETHm", 1_000_000e18);
    // Fund the settlement contract with some balances for demo atomic swap
    usdc.transfer(address(settle), 200_000e18);
    ethm.transfer(address(settle), 200_000e18);
        console2.log("REG", address(reg));
        console2.log("SETTLE", address(settle));
        console2.log("USDC", address(usdc));
        console2.log("ETHm", address(ethm));
        vm.stopBroadcast();
    }
}
