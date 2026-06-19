// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @title IRandomnessSource
/// @notice Pull-based randomness beacon. A consumer first `request`s randomness
///         for a key, then polls `reveal` until it is ready.
/// @dev    The OPN testnet implementation (FinalityRandomness) derives entropy
///         from a *future finalized block hash*. That construction is unsafe on
///         reorg-prone chains, but OPN has instant Tendermint-BFT finality and no
///         reorgs, so a committed future block hash cannot be rewritten. The same
///         interface lets a true VRF adapter drop in once OPN ships a native
///         oracle (see roadmap) with zero changes to the consumer.
interface IRandomnessSource {
    /// @notice Register a commitment for `key`. Randomness becomes available only
    ///         after a future block, so it cannot be predicted at request time.
    /// @return availableAtBlock Block height after which `reveal` can succeed.
    function request(uint256 key) external returns (uint256 availableAtBlock);

    /// @notice Resolve randomness for `key`.
    /// @return random The random word (undefined if `ready` is false).
    /// @return ready  True once the committed block is finalized and readable.
    /// @dev    State-changing: if the commitment window lapsed it self-heals by
    ///         re-committing to a fresh future block and returns ready=false.
    function reveal(uint256 key) external returns (uint256 random, bool ready);

    /// @notice View helper for frontends. True if `reveal` would succeed now.
    function isReady(address consumer, uint256 key) external view returns (bool);
}
