// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {IYieldSource} from "./interfaces/IYieldSource.sol";

/// @title SponsoredYieldSource
/// @notice Testnet yield adapter. Principal is held 1:1 and always redeemable, so
///         the pool stays strictly no-loss. Yield is funded by a sponsor reserve
///         and dripped at a fixed rate per second, simulating lending interest in
///         a way that produces a continuous, self-running demo. In production this
///         contract is replaced by a lending/staking adapter implementing the same
///         IYieldSource interface, with no changes to DrawPool.
/// @dev    Roles are split to avoid a circular constructor dependency with the
///         pool: `owner` (deployer/governance) configures the drip rate; `pool`
///         (set once after deploy) is the only address that may supply/redeem/
///         harvest. Anyone may sponsor.
contract SponsoredYieldSource is IYieldSource, Ownable {
    using SafeERC20 for IERC20;

    IERC20 public immutable token;
    address public pool;

    uint256 public principal;      // redeemable 1:1, never raffled
    uint256 public reserve;        // sponsor-funded pool that drips into yield
    uint256 public accrued;        // materialized yield, ready to harvest
    uint256 public yieldPerSecond; // drip rate from reserve -> accrued
    uint256 public lastAccrual;

    event PoolSet(address indexed pool);
    event Sponsored(address indexed from, uint256 amount);
    event RateSet(uint256 yieldPerSecond);
    event Supplied(uint256 amount);
    event Redeemed(uint256 amount, address indexed to);
    event Harvested(uint256 amount, address indexed to);

    modifier onlyPool() {
        require(msg.sender == pool, "not pool");
        _;
    }

    constructor(IERC20 _token, address admin) Ownable(admin) {
        token = _token;
        lastAccrual = block.timestamp;
    }

    /// @notice Wire the pool once, after both contracts are deployed.
    function setPool(address _pool) external onlyOwner {
        require(pool == address(0), "pool set");
        require(_pool != address(0), "zero pool");
        pool = _pool;
        emit PoolSet(_pool);
    }

    function asset() external view returns (address) {
        return address(token);
    }

    // --- yield accrual -------------------------------------------------------

    function _pendingDrip() internal view returns (uint256) {
        uint256 elapsed = block.timestamp - lastAccrual;
        uint256 drip = elapsed * yieldPerSecond;
        return drip > reserve ? reserve : drip;
    }

    function _accrue() internal {
        uint256 drip = _pendingDrip();
        if (drip > 0) {
            reserve -= drip;
            accrued += drip;
        }
        lastAccrual = block.timestamp;
    }

    // --- IYieldSource (pool-only) -------------------------------------------

    function supply(uint256 amount) external onlyPool {
        token.safeTransferFrom(msg.sender, address(this), amount);
        principal += amount;
        emit Supplied(amount);
    }

    function redeem(uint256 amount, address to) external onlyPool {
        require(amount <= principal, "exceeds principal");
        principal -= amount;
        token.safeTransfer(to, amount);
        emit Redeemed(amount, to);
    }

    function harvest(address to) external onlyPool returns (uint256) {
        _accrue();
        uint256 amount = accrued;
        accrued = 0;
        if (amount > 0) token.safeTransfer(to, amount);
        emit Harvested(amount, to);
        return amount;
    }

    function totalPrincipal() external view returns (uint256) {
        return principal;
    }

    function accruedYield() external view returns (uint256) {
        return accrued + _pendingDrip();
    }

    // --- sponsor / admin -----------------------------------------------------

    /// @notice Add to the reserve that drips into prize yield. Anyone can sponsor.
    function sponsor(uint256 amount) external {
        _accrue();
        token.safeTransferFrom(msg.sender, address(this), amount);
        reserve += amount;
        emit Sponsored(msg.sender, amount);
    }

    /// @notice Configure the drip rate. Owner only.
    function setYieldPerSecond(uint256 rate) external onlyOwner {
        _accrue();
        yieldPerSecond = rate;
        emit RateSet(rate);
    }
}
