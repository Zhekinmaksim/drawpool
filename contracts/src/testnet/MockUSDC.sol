// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title MockUSDC
/// @notice 6-decimal test stablecoin for OPN testnet. No official USDC bridge
///         exists on testnet yet, so the demo mints its own. Public faucet.
contract MockUSDC is ERC20 {
    uint8 private constant DECIMALS = 6;
    uint256 public constant FAUCET_AMOUNT = 1_000 * 10 ** DECIMALS;

    constructor() ERC20("Test USD Coin", "tUSDC") {}

    function decimals() public pure override returns (uint8) {
        return DECIMALS;
    }

    /// @notice Mint the faucet amount to the caller. Testnet only.
    function faucet() external {
        _mint(msg.sender, FAUCET_AMOUNT);
    }

    /// @notice Mint an arbitrary amount to `to`. Testnet only, used to seed sponsors.
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
