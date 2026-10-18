"use client";

/**
 * Mock wallet balance generator
 *
 * Lets a developer describe any wallet state — asset codes, balances, limits,
 * trustline authorisation — and inject it into the sandbox so components render
 * against it without spending testnet XLM.
 */

import React from "react";
import { Button } from "../../../components/Button";
import { Card } from "../../../components/Card";
import { formatBalance, trimBalance } from "../../../lib/sandbox-wallet";
import {
  describeInjectedWallet,
  rowsToSpecs,
  useSandboxWallet,
} from "../hooks/useSandboxWallet";

interface WalletBalanceGeneratorProps {
  className?: string;
}

export function WalletBalanceGenerator({ className = "" }: WalletBalanceGeneratorProps) {
  const wallet = useSandboxWallet();
  const preview = wallet.preview;
  const draftRows = rowsToSpecs(wallet.rows);

  return (
    <Card className={className}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-white">Mock wallet balance generator</h2>
          <p className="mt-1 text-sm text-gray-400">
            Define asset codes and balances, then inject the state into the sandbox. Blank balance
            values are treated as zero.
          </p>
        </div>
        <span
          data-testid="sandbox-wallet-injected"
          className="rounded-full border border-trellis-vine/40 px-3 py-1 text-xs text-gray-300"
        >
          {wallet.injected ? "injected" : "not injected"}
        </span>
      </div>

      <div className="mt-5 flex flex-wrap gap-2" data-testid="wallet-presets">
        {wallet.presets.map((preset) => (
          <button
            key={preset.id}
            type="button"
            data-testid={`wallet-preset-${preset.id}`}
            title={preset.description}
            onClick={() => wallet.applyPreset(preset.id)}
            className="rounded-full border border-trellis-vine/40 px-3 py-1 text-xs text-gray-200 transition-smooth hover:border-trellis-vine hover:bg-trellis-vine/10"
          >
            {preset.label}
          </button>
        ))}
      </div>

      <div className="mt-5">
        <label className="block text-xs uppercase tracking-wide text-gray-400" htmlFor="sandbox-wallet-label">
          Wallet label
        </label>
        <input
          id="sandbox-wallet-label"
          data-testid="wallet-label"
          value={wallet.label}
          onChange={(event) => wallet.setLabel(event.target.value)}
          className="mt-1 w-full rounded-lg border border-gray-700 bg-gray-900/60 px-3 py-2 text-sm text-white outline-none focus:border-trellis-vine"
        />
      </div>

      <div className="mt-5 overflow-x-auto">
        <table className="w-full min-w-[46rem] border-collapse text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wide text-gray-400">
              <th className="pb-2 pr-2">Asset</th>
              <th className="pb-2 pr-2">Issuer</th>
              <th className="pb-2 pr-2">Balance</th>
              <th className="pb-2 pr-2">Limit</th>
              <th className="pb-2 pr-2">Authorised</th>
              <th className="pb-2 pr-2">Sponsored</th>
              <th className="pb-2" />
            </tr>
          </thead>
          <tbody data-testid="wallet-balance-rows">
            {wallet.rows.map((row, index) => {
              const native = /^(native|xlm)$/i.test(row.asset.trim());
              return (
                <tr key={row.id} className="border-t border-gray-800">
                  <td className="py-2 pr-2">
                    <input
                      aria-label={`Asset code, row ${index + 1}`}
                      data-testid={`wallet-row-${index}-asset`}
                      value={row.asset}
                      placeholder="USDC"
                      onChange={(event) => wallet.updateRow(row.id, { asset: event.target.value })}
                      className="w-28 rounded border border-gray-700 bg-gray-900/60 px-2 py-1 text-white outline-none focus:border-trellis-vine"
                    />
                  </td>
                  <td className="py-2 pr-2">
                    <input
                      aria-label={`Issuer, row ${index + 1}`}
                      data-testid={`wallet-row-${index}-issuer`}
                      value={native ? "" : row.issuer}
                      disabled={native}
                      placeholder={native ? "—" : "G…"}
                      onChange={(event) => wallet.updateRow(row.id, { issuer: event.target.value })}
                      className="w-64 rounded border border-gray-700 bg-gray-900/60 px-2 py-1 font-mono text-xs text-white outline-none focus:border-trellis-vine disabled:opacity-40"
                    />
                  </td>
                  <td className="py-2 pr-2">
                    <input
                      aria-label={`Balance, row ${index + 1}`}
                      data-testid={`wallet-row-${index}-balance`}
                      value={row.balance}
                      onChange={(event) => wallet.updateRow(row.id, { balance: event.target.value })}
                      className="w-28 rounded border border-gray-700 bg-gray-900/60 px-2 py-1 text-white outline-none focus:border-trellis-vine"
                    />
                  </td>
                  <td className="py-2 pr-2">
                    <input
                      aria-label={`Trustline limit, row ${index + 1}`}
                      data-testid={`wallet-row-${index}-limit`}
                      value={native ? "" : row.limit}
                      disabled={native}
                      placeholder={native ? "—" : "default"}
                      onChange={(event) => wallet.updateRow(row.id, { limit: event.target.value })}
                      className="w-28 rounded border border-gray-700 bg-gray-900/60 px-2 py-1 text-white outline-none focus:border-trellis-vine disabled:opacity-40"
                    />
                  </td>
                  <td className="py-2 pr-2">
                    <input
                      type="checkbox"
                      aria-label={`Authorised, row ${index + 1}`}
                      data-testid={`wallet-row-${index}-authorized`}
                      checked={row.authorized}
                      onChange={(event) =>
                        wallet.updateRow(row.id, { authorized: event.target.checked })
                      }
                    />
                  </td>
                  <td className="py-2 pr-2">
                    <input
                      type="checkbox"
                      aria-label={`Sponsored, row ${index + 1}`}
                      data-testid={`wallet-row-${index}-sponsored`}
                      checked={row.sponsored}
                      onChange={(event) =>
                        wallet.updateRow(row.id, { sponsored: event.target.checked })
                      }
                    />
                  </td>
                  <td className="py-2 text-right">
                    <button
                      type="button"
                      aria-label={`Remove row ${index + 1}`}
                      data-testid={`wallet-row-${index}-remove`}
                      onClick={() => wallet.removeRow(row.id)}
                      className="rounded px-2 py-1 text-xs text-red-300 transition-smooth hover:bg-red-500/10"
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <Button size="sm" variant="outline" onClick={() => wallet.addRow("")} data-testid="wallet-add-row">
          Add asset
        </Button>
        <Button size="sm" onClick={() => wallet.generate()} data-testid="wallet-generate">
          Generate &amp; inject
        </Button>
        <Button size="sm" variant="secondary" onClick={wallet.clear} data-testid="wallet-clear">
          Clear mock wallet
        </Button>
      </div>

      {(wallet.error || wallet.validationError) && (
        <div
          data-testid="wallet-error"
          className="mt-4 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-300"
        >
          {wallet.error ?? wallet.validationError}
          {wallet.errorField ? (
            <span className="ml-1 text-red-400/80">(field: {wallet.errorField})</span>
          ) : null}
        </div>
      )}

      {preview && (
        <div className="mt-5" data-testid="wallet-preview">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-gray-400">Preview</h3>
          <p className="mt-1 text-sm text-gray-300" data-testid="wallet-preview-summary">
            {wallet.summary}
          </p>

          <ul className="mt-3 space-y-1" data-testid="wallet-preview-balances">
            {preview.balances.map((balance) => (
              <li key={balance.key} className="flex flex-wrap items-center gap-2 text-sm text-gray-300">
                <span className="font-mono text-trellis-amber">{balance.label}</span>
                <span>{formatBalance(balance.balanceStroops)}</span>
                <span className="text-xs text-gray-500">
                  {balance.isNative
                    ? "native"
                    : `${balance.type}${balance.hasTrustline ? " · trustline" : ""}${
                        balance.authorized ? "" : " · unauthorised"
                      }`}
                </span>
                {balance.limit ? (
                  <span className="text-xs text-gray-500">limit {trimBalance(balance.limit)}</span>
                ) : null}
              </li>
            ))}
          </ul>

          <dl className="mt-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
            <div>
              <dt className="text-xs uppercase tracking-wide text-gray-500">Subentries</dt>
              <dd data-testid="wallet-reserve-subentries" className="text-white">
                {preview.reserve.subentryCount}
              </dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-gray-500">Min reserve</dt>
              <dd data-testid="wallet-reserve-minimum" className="text-white">
                {trimBalance(preview.reserve.minimumReserve)} XLM
              </dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-gray-500">Spendable</dt>
              <dd
                data-testid="wallet-reserve-spendable"
                className={preview.reserve.belowMinimum ? "text-red-300" : "text-white"}
              >
                {wallet.spendable} XLM
              </dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-gray-500">Below minimum</dt>
              <dd data-testid="wallet-reserve-below" className="text-white">
                {preview.reserve.belowMinimum ? "yes" : "no"}
              </dd>
            </div>
          </dl>

          {wallet.warnings.length > 0 && (
            <ul className="mt-4 space-y-1" data-testid="wallet-warnings">
              {wallet.warnings.map((warning) => (
                <li key={warning} className="text-xs text-trellis-amber">
                  ⚠ {warning}
                </li>
              ))}
            </ul>
          )}

          <p className="mt-3 text-xs text-gray-500">
            {draftRows.length} asset row(s) submitted · {describeInjectedWallet(wallet.injected)}
          </p>
        </div>
      )}
    </Card>
  );
}

export default WalletBalanceGenerator;
