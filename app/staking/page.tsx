import { MultiAssetStakingEngine } from "@/lib/staking/engine";
import { TokenInterface } from "@/lib/staking/types";
import AutoCompoundPanel from "@/components/staking/AutoCompoundPanel";

const rewardToken: TokenInterface = {
  contractId: "REWARD",
  name: "stellAI Rewards",
  symbol: "sAI",
  decimals: 7,
};

const xlmToken: TokenInterface = {
  contractId: "XLM",
  name: "Stellar Lumens",
  symbol: "XLM",
  decimals: 7,
};

const usdcToken: TokenInterface = {
  contractId: "USDC",
  name: "USD Coin",
  symbol: "USDC",
  decimals: 6,
};

const engine = new MultiAssetStakingEngine({
  rewardToken,
  emissionPerSecond: 90,
  assets: [
    {
      id: "xlm",
      token: xlmToken,
      rewardWeight: 2,
      stakeMultiplier: 1,
      minStake: 10,
      unbondingPeriodMs: 7 * 24 * 60 * 60 * 1000,
    },
    {
      id: "usdc",
      token: usdcToken,
      rewardWeight: 1,
      stakeMultiplier: 1.5,
      minStake: 5,
      unbondingPeriodMs: 14 * 24 * 60 * 60 * 1000,
    },
  ],
});

engine.stake("alice", "xlm", 100, 0);
engine.stake("bob", "usdc", 50, 0);
engine.unstake("alice", "xlm", 20, 0);

const supportedAssets = engine.getSupportedAssets().map((asset) => ({
  ...asset,
  emissionPerSecond: engine.getAssetEmissionRate(asset.id),
  apy: engine.getAPY(asset.id),
}));

const previewAtTenSeconds = [
  {
    userId: "alice",
    assetId: "xlm",
    symbol: xlmToken.symbol,
    reward: engine.previewRewards("alice", "xlm", 10_000),
  },
  {
    userId: "bob",
    assetId: "usdc",
    symbol: usdcToken.symbol,
    reward: engine.previewRewards("bob", "usdc", 10_000),
  },
];

const poolData = supportedAssets.map((asset) => ({
  assetId: asset.id,
  token: asset.token,
  rewardWeight: asset.rewardWeight,
  multiplier: asset.stakeMultiplier ?? 1,
  emissionPerSecond: asset.emissionPerSecond,
  apy: asset.apy,
}));

const alicePortfolio = engine.getPortfolio("alice");
const unbondingQueue = alicePortfolio.positions.flatMap(p => 
  p.unbondingRequests.map(r => ({
    assetId: p.assetId,
    amount: r.amount,
    unlockTime: r.unlockTime
  }))
);

export default function StakingPage() {
  return (
    <main className="pt-24 pb-16 min-h-screen bg-trellis-ground">
      <section className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 space-y-10">
        <div className="space-y-4 max-w-3xl">
          <div className="inline-flex items-center rounded-full border border-trellis-vine/30 bg-trellis-vine/10 px-4 py-2 text-xs font-bold uppercase tracking-[0.25em] text-trellis-vine">
            Multi-asset staking
          </div>
          <h1 className="text-4xl md:text-6xl font-bold glow-text leading-tight">
            Stake multiple tokens through one rewards pool.
          </h1>
          <p className="text-lg text-gray-300 max-w-2xl">
            This staking layer accepts SEP-41 style token interfaces, normalizes each
            asset with a configurable multiplier, and splits reward emissions across
            supported tokens without hard-coding a single asset.
          </p>
        </div>

        <div className="grid gap-6 md:grid-cols-3">
          <div className="rounded-2xl border border-trellis-vine/20 bg-trellis-ground/50 p-6">
            <p className="text-xs uppercase tracking-[0.2em] text-trellis-vine/80 mb-2">
              Reward token
            </p>
            <h2 className="text-2xl font-bold text-white">{rewardToken.symbol}</h2>
            <p className="text-sm text-gray-400 mt-2">
              Rewards accrue in {rewardToken.name} across all supported staking assets.
            </p>
          </div>
          <div className="rounded-2xl border border-trellis-vine/20 bg-trellis-ground/50 p-6">
            <p className="text-xs uppercase tracking-[0.2em] text-trellis-vine/80 mb-2">
              Emission rate
            </p>
            <h2 className="text-2xl font-bold text-white">90 / sec</h2>
            <p className="text-sm text-gray-400 mt-2">
              Allocated to each token pool by reward weight.
            </p>
          </div>
          <div className="rounded-2xl border border-trellis-vine/20 bg-trellis-ground/50 p-6">
            <p className="text-xs uppercase tracking-[0.2em] text-trellis-vine/80 mb-2">
              Token interface
            </p>
            <h2 className="text-2xl font-bold text-white">SEP-41 ready</h2>
            <p className="text-sm text-gray-400 mt-2">
              Each asset is described through token metadata and standard token methods.
            </p>
          </div>
        </div>

        <section className="space-y-4">
          <h2 className="text-2xl font-bold text-white">Supported assets & APY</h2>
          <div className="overflow-hidden rounded-2xl border border-trellis-vine/20 bg-trellis-ground/40">
            <table className="w-full text-left">
              <thead className="bg-trellis-ground/60 text-xs uppercase tracking-[0.2em] text-gray-400">
                <tr>
                  <th className="px-4 py-3">Asset</th>
                  <th className="px-4 py-3">Token</th>
                  <th className="px-4 py-3">APY</th>
                  <th className="px-4 py-3">Emission / sec</th>
                  <th className="px-4 py-3">Minimum</th>
                </tr>
              </thead>
              <tbody>
                {supportedAssets.map((asset) => (
                  <tr key={asset.id} className="border-t border-trellis-vine/10">
                    <td className="px-4 py-3 font-semibold text-white">{asset.id}</td>
                    <td className="px-4 py-3 text-gray-300">{asset.token.symbol}</td>
                    <td className="px-4 py-3 text-trellis-vine font-bold">{(asset.apy / 1000000).toFixed(2)}M %</td>
                    <td className="px-4 py-3 text-gray-300">{asset.emissionPerSecond}</td>
                    <td className="px-4 py-3 text-gray-300">
                      {asset.minStake ?? 0} {asset.token.symbol}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="space-y-4">
          <h2 className="text-2xl font-bold text-white">Unbonding Queue (Alice)</h2>
          {unbondingQueue.length === 0 ? (
            <p className="text-gray-400">No pending unbonding requests.</p>
          ) : (
            <div className="overflow-hidden rounded-2xl border border-trellis-vine/20 bg-trellis-ground/40">
              <table className="w-full text-left">
                <thead className="bg-trellis-ground/60 text-xs uppercase tracking-[0.2em] text-gray-400">
                  <tr>
                    <th className="px-4 py-3">Asset</th>
                    <th className="px-4 py-3">Amount</th>
                    <th className="px-4 py-3">Unlock Time</th>
                  </tr>
                </thead>
                <tbody>
                  {unbondingQueue.map((req, i) => (
                    <tr key={i} className="border-t border-trellis-vine/10">
                      <td className="px-4 py-3 font-semibold text-white uppercase">{req.assetId}</td>
                      <td className="px-4 py-3 text-gray-300">{req.amount}</td>
                      <td className="px-4 py-3 text-gray-300">
                        {new Date(req.unlockTime).toLocaleString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="grid gap-6 lg:grid-cols-2">
          <div className="rounded-2xl border border-trellis-vine/20 bg-trellis-ground/40 p-6">
            <h2 className="text-2xl font-bold text-white mb-4">Reward split</h2>
            <div className="space-y-4">
              {poolData.map((pool) => (
                <div
                  key={pool.assetId}
                  className="rounded-xl border border-trellis-vine/10 bg-black/20 p-4"
                >
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <h3 className="text-lg font-semibold text-white">{pool.token.symbol}</h3>
                      <p className="text-sm text-gray-400">
                        Weight {pool.rewardWeight} and multiplier {pool.multiplier}x
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="text-xs uppercase tracking-[0.2em] text-gray-500">
                        Emission
                      </p>
                      <p className="text-lg font-bold text-trellis-amber">
                        {pool.emissionPerSecond} / sec
                      </p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-2xl border border-trellis-vine/20 bg-trellis-ground/40 p-6">
            <h2 className="text-2xl font-bold text-white mb-4">Ten second preview</h2>
            <div className="space-y-4">
              {previewAtTenSeconds.map((entry) => (
                <div
                  key={`${entry.userId}-${entry.assetId}`}
                  className="flex items-center justify-between rounded-xl border border-trellis-vine/10 bg-black/20 px-4 py-3"
                >
                  <div>
                    <p className="font-semibold text-white capitalize">{entry.userId}</p>
                    <p className="text-sm text-gray-400">{entry.symbol} position</p>
                  </div>
                  <div className="text-right">
                    <p className="text-xs uppercase tracking-[0.2em] text-gray-500">
                      Reward preview
                    </p>
                    <p className="text-lg font-bold text-trellis-vine">
                      {entry.reward.toFixed(2)} {rewardToken.symbol}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>
        <AutoCompoundPanel />
      </section>
    </main>
  );
}
