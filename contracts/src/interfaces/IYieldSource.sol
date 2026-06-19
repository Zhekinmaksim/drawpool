// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @title IYieldSource
/// @notice Abstraction over wherever pool principal is parked to generate yield.
///         Principal is always redeemable 1:1 (this is what makes the pool "no-loss").
///         Only the yield generated on top of principal is ever raffled.
/// @dev    On OPN testnet the SponsoredYieldSource implementation is used. In
///         production this is swapped for a lending- or staking-backed adapter
///         without touching DrawPool. The DrawPool only knows this interface.
interface IYieldSource {
    /// @notice The ERC20 asset managed by this source.
    function asset() external view returns (address);

    /// @notice Pull `amount` of asset from `msg.sender` and park it as principal.
    function supply(uint256 amount) external;

    /// @notice Return `amount` of principal to `to`. MUST always succeed 1:1.
    function redeem(uint256 amount, address to) external;

    /// @notice Total principal currently parked (never lost).
    function totalPrincipal() external view returns (uint256);

    /// @notice Yield accrued on top of principal, claimable into the prize pool.
    function accruedYield() external view returns (uint256);

    /// @notice Sweep all accrued yield to `to`. Returns the amount swept.
    function harvest(address to) external returns (uint256);
}
