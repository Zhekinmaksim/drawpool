// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IYieldSource} from "./interfaces/IYieldSource.sol";
import {IRandomnessSource} from "./interfaces/IRandomnessSource.sol";

/// @title DrawPool
/// @notice No-loss prize savings on OPN Chain. Depositors never lose principal;
///         it is always withdrawable 1:1. The yield earned across all deposits is
///         pooled and paid out, in full, to one depositor per draw, chosen with
///         odds proportional to their balance. The prize auto-compounds into the
///         winner's deposit.
///
/// @dev    OPN-NATIVE DESIGN
///         - Randomness comes from FinalityRandomness, which is only sound because
///           OPN has instant finality and no reorgs (see that contract).
///         - The deposit/withdraw lock spanning a draw is acceptable precisely
///           because OPN's ~1s blocks + COMMIT_DELAY make the window a few seconds.
///         - Both dependencies are interfaces, so a VRF and a real yield adapter
///           swap in without redeploying this pool.
contract DrawPool is ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public immutable asset;
    IYieldSource public immutable yield;
    IRandomnessSource public immutable rng;

    uint256 public immutable drawInterval; // seconds between draws
    uint256 public lastDrawAt;

    // --- depositor accounting -----------------------------------------------
    mapping(address => uint256) public balanceOf; // principal, withdrawable 1:1
    uint256 public totalDeposited;

    address[] private _participants;
    mapping(address => uint256) private _indexPlusOne; // 0 == not present

    // --- draw state ----------------------------------------------------------
    struct Draw {
        uint64 id;
        uint64 startedAt;
        uint256 snapshotTotal; // total weight at draw start (pool is locked, so stable)
        uint256 prize;
        address winner;
        bool awarded;
        uint256 randomness; // the entropy used to pick the winner (provable on-chain)
    }

    bool public drawActive;
    uint64 public drawCount;
    Draw public currentDraw;
    Draw[] public history;

    event Deposited(address indexed user, uint256 amount, uint256 newBalance);
    event Withdrawn(address indexed user, uint256 amount, uint256 newBalance);
    event DrawStarted(uint64 indexed id, uint256 snapshotTotal, uint256 availableAtBlock);
    event DrawAwarded(uint64 indexed id, address indexed winner, uint256 prize, uint256 random);

    error PoolLocked();
    error NoActiveDraw();
    error DrawAlreadyActive();
    error TooEarly();
    error NothingDeposited();
    error RandomnessNotReady();
    error NoPrizeYet();

    constructor(
        IERC20 _asset,
        IYieldSource _yield,
        IRandomnessSource _rng,
        uint256 _drawInterval
    ) {
        require(_yield.asset() == address(_asset), "asset mismatch");
        asset = _asset;
        yield = _yield;
        rng = _rng;
        drawInterval = _drawInterval;
        lastDrawAt = block.timestamp;
    }

    // --- views ---------------------------------------------------------------

    function participantCount() external view returns (uint256) {
        return _participants.length;
    }

    function participantAt(uint256 i) external view returns (address) {
        return _participants[i];
    }

    /// @notice Current claimable prize (accrued yield not yet awarded).
    function currentPrize() external view returns (uint256) {
        return yield.accruedYield();
    }

    /// @notice Win odds of `user` in basis points of the current pool (10000 = 100%).
    function oddsBps(address user) external view returns (uint256) {
        if (totalDeposited == 0) return 0;
        return (balanceOf[user] * 10_000) / totalDeposited;
    }

    function nextDrawAt() external view returns (uint256) {
        return lastDrawAt + drawInterval;
    }

    function historyLength() external view returns (uint256) {
        return history.length;
    }

    // --- deposits / withdrawals ---------------------------------------------

    function deposit(uint256 amount) external nonReentrant {
        if (drawActive) revert PoolLocked();
        require(amount > 0, "zero amount");

        asset.safeTransferFrom(msg.sender, address(this), amount);
        asset.forceApprove(address(yield), amount);
        yield.supply(amount);

        if (balanceOf[msg.sender] == 0) _addParticipant(msg.sender);
        balanceOf[msg.sender] += amount;
        totalDeposited += amount;

        emit Deposited(msg.sender, amount, balanceOf[msg.sender]);
    }

    function withdraw(uint256 amount) external nonReentrant {
        if (drawActive) revert PoolLocked();
        uint256 bal = balanceOf[msg.sender];
        require(amount > 0 && amount <= bal, "bad amount");

        balanceOf[msg.sender] = bal - amount;
        totalDeposited -= amount;
        if (balanceOf[msg.sender] == 0) _removeParticipant(msg.sender);

        yield.redeem(amount, msg.sender); // 1:1, no loss

        emit Withdrawn(msg.sender, amount, balanceOf[msg.sender]);
    }

    // --- draw lifecycle ------------------------------------------------------

    /// @notice Open a draw. Permissionless. Locks the pool and commits to future
    ///         randomness so no one can react to the outcome.
    function startDraw() external nonReentrant {
        if (drawActive) revert DrawAlreadyActive();
        if (block.timestamp < lastDrawAt + drawInterval) revert TooEarly();
        if (totalDeposited == 0 || _participants.length == 0) revert NothingDeposited();

        drawActive = true;
        uint64 id = ++drawCount;
        uint256 availableAt = rng.request(id);

        currentDraw = Draw({
            id: id,
            startedAt: uint64(block.timestamp),
            snapshotTotal: totalDeposited,
            prize: 0,
            winner: address(0),
            awarded: false,
            randomness: 0
        });

        emit DrawStarted(id, totalDeposited, availableAt);
    }

    /// @notice Settle the open draw once randomness is ready. Permissionless.
    ///         Harvests yield as the prize, selects a balance-weighted winner, and
    ///         auto-compounds the prize into their deposit. Unlocks the pool.
    function award() external nonReentrant {
        if (!drawActive) revert NoActiveDraw();

        (uint256 random, bool ready) = rng.reveal(currentDraw.id);
        if (!ready) revert RandomnessNotReady();

        uint256 prize = yield.harvest(address(this));
        if (prize == 0) revert NoPrizeYet();

        address winner = _selectWinner(random, currentDraw.snapshotTotal);

        // Auto-compound the prize into the winner's withdrawable principal.
        asset.forceApprove(address(yield), prize);
        yield.supply(prize);
        balanceOf[winner] += prize;
        totalDeposited += prize;

        currentDraw.prize = prize;
        currentDraw.winner = winner;
        currentDraw.awarded = true;
        currentDraw.randomness = random;
        history.push(currentDraw);

        lastDrawAt = block.timestamp;
        drawActive = false;

        emit DrawAwarded(currentDraw.id, winner, prize, random);
    }

    // --- internals -----------------------------------------------------------

    /// @dev Walks participants accumulating balances until the weighted target is
    ///      crossed. O(n); fine at hackathon scale. The pool is locked during a
    ///      draw, so live balances equal the start-of-draw snapshot.
    function _selectWinner(uint256 random, uint256 total) internal view returns (address) {
        uint256 target = random % total;
        uint256 cumulative;
        uint256 n = _participants.length;
        for (uint256 i = 0; i < n; i++) {
            address p = _participants[i];
            cumulative += balanceOf[p];
            if (cumulative > target) return p;
        }
        // Unreachable while total == sum(balances); defensive fallback.
        return _participants[n - 1];
    }

    function _addParticipant(address user) internal {
        _participants.push(user);
        _indexPlusOne[user] = _participants.length;
    }

    function _removeParticipant(address user) internal {
        uint256 idx = _indexPlusOne[user];
        require(idx != 0, "not participant");
        uint256 last = _participants.length;
        if (idx != last) {
            address moved = _participants[last - 1];
            _participants[idx - 1] = moved;
            _indexPlusOne[moved] = idx;
        }
        _participants.pop();
        delete _indexPlusOne[user];
    }
}
