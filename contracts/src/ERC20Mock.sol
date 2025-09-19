// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract ERC20Mock {
    string public name; string public symbol; uint8 public decimals = 18;
    mapping(address=>uint256) public balanceOf;
    event Transfer(address indexed from, address indexed to, uint256 value);
    constructor(string memory n, string memory s, uint256 supply) { name=n; symbol=s; balanceOf[msg.sender]=supply; }
    function transfer(address to, uint256 v) external returns(bool){ require(balanceOf[msg.sender]>=v,"bal"); balanceOf[msg.sender]-=v; balanceOf[to]+=v; emit Transfer(msg.sender,to,v); return true; }
}
