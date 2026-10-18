"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  LedgerError,
  connectLedgerWallet,
  disconnectLedger,
  getActiveLedgerAdapter,
  isWebHidSupported,
  ledgerErrorHint,
  normalizeLedgerError,
  type LedgerAccount,
  type LedgerAppConfiguration,
} from "@/features/wallet/ledger";
import LedgerPromptGuide from "./LedgerPromptGuide";
import useFocusTrap from "@/components/useFocusTrap";

export interface LedgerConnectModalProps {
  open: boolean;
  onClose: () => void;
  /** Called once the device has approved and returned an address. */
  onConnected?: (account: LedgerAccount) => void;
  /** BIP-32 account path to derive. Defaults to `44'/148'/0'`. */
  derivationPath?: string;
  className?: string;
}

function shortenAddress(address: string): string {
  if (!address || address.length < 12) return address;
  return `${address.slice(0, 6)}...${address.slice(-6)}`;
}

/**
 * Guided Ledger connection flow.
 *
 * Opens a WebHID session, derives the Stellar account (`m/44'/148'/0'` by
 * default) and asks the device to display the address so the user can verify it
 * before the app trusts it. The session stays open after the modal closes so the
 * connected wallet can keep signing; use Disconnect to release the device.
 */
export default function LedgerConnectModal({
  open,
  onClose,
  onConnected,
  derivationPath,
  className = "",
}: LedgerConnectModalProps) {
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [account, setAccount] = useState<LedgerAccount | null>(null);
  const [appConfig, setAppConfig] = useState<LedgerAppConfiguration | null>(null);
  const [error, setError] = useState<LedgerError | null>(null);
  const notifiedRef = useRef(false);
  const hadErrorRef = useRef(false);
  const onConnectedRef = useRef(onConnected);
  onConnectedRef.current = onConnected;

  const connect = useCallback(async () => {
    setBusy(true);
    setError(null);
    setStep(0);

    try {
      setStep(1);
      // Reuse an open session when there is one, but start a fresh one after a
      // failure: a stale WebHID session is the usual cause of a retry loop.
      const adapter = await connectLedgerWallet({
        derivationPath,
        force: hadErrorRef.current,
      });
      setStep(2);

      // Ask the device to display the address so the user verifies the key.
      const derived = await adapter.getAccount({ display: true });
      setAccount(derived);
      setStep(3);
      hadErrorRef.current = false;

      try {
        setAppConfig(await adapter.getAppConfiguration());
      } catch {
        // The app configuration is informative only; signing still works without it.
        setAppConfig(null);
      }

      if (!notifiedRef.current) {
        notifiedRef.current = true;
        onConnectedRef.current?.(derived);
      }
    } catch (caught) {
      hadErrorRef.current = true;
      setError(normalizeLedgerError(caught, "unknown"));
    } finally {
      setBusy(false);
    }
  }, [derivationPath]);

  // Reset and start the flow whenever the modal is opened.
  useEffect(() => {
    if (!open) {
      notifiedRef.current = false;
      return;
    }

    notifiedRef.current = false;
    hadErrorRef.current = false;
    setAccount(null);
    setAppConfig(null);
    setError(null);
    void connect();
  }, [open, connect]);

  // Close on Escape while the dialog is open.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  const handleDisconnect = useCallback(async () => {
    await disconnectLedger();
    setAccount(null);
    setAppConfig(null);
    setStep(0);
  }, []);

  const activeAdapter = getActiveLedgerAdapter();
  const webHidSupported = isWebHidSupported();

  const trapRef = useFocusTrap<HTMLDivElement>({
    active: open,
    onEscape: onClose,
  });

  if (!open) return null;

  return (
    <div
      className={`fixed inset-0 z-[70] flex items-center justify-center bg-black/60 p-4 ${className}`}
      role="presentation"
      onClick={(event: React.MouseEvent<HTMLDivElement>) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={trapRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="ledger-connect-title"
        className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-xl border border-trellis-vine/30 nebula-bg p-6 space-y-5"
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 id="ledger-connect-title" className="text-xl font-bold text-white">
              Connect a Ledger device
            </h2>
            <p className="text-xs text-gray-400">
              Hardware signing for high-value Soroban transactions. Keys never leave the device.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-trellis-vine/20 px-2 py-1 text-xs text-gray-400 hover:text-white transition-smooth"
            aria-label="Close Ledger dialog"
          >
            ✕
          </button>
        </div>

        {!webHidSupported && (
          <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-200">
            This browser does not expose WebHID. Open Trellis in Chrome, Edge, Brave or Opera over
            HTTPS (or localhost) to use a Ledger device.
          </p>
        )}

        <LedgerPromptGuide activeStep={step} errorCode={error?.code ?? null} />

        <div
          className="rounded-lg border border-trellis-vine/20 bg-trellis-ground/40 p-4 text-sm"
          role="status"
          aria-live="polite"
        >
          {busy && <p className="text-gray-300">Waiting for your Ledger… check the device screen.</p>}

          {!busy && error && (
            <div className="space-y-1">
              <p className="font-semibold text-rose-300">{error.message}</p>
              <p className="text-xs text-gray-400">{ledgerErrorHint(error.code)}</p>
              {error.statusCode !== null && (
                <p className="text-[11px] font-mono text-gray-500">
                  status 0x{error.statusCode.toString(16).padStart(4, "0")}
                </p>
              )}
            </div>
          )}

          {!busy && !error && account && (
            <div className="space-y-1">
              <p className="font-semibold text-emerald-300">Ledger verified</p>
              <p className="font-mono text-xs text-gray-300">{account.address}</p>
              <p className="text-[11px] text-gray-500">
                Path <span className="font-mono">{account.derivationPath}</span>
                {appConfig ? ` · Stellar app ${appConfig.version}` : ""}
                {appConfig
                  ? appConfig.hashSigningEnabled
                    ? " · hash signing enabled"
                    : " · hash signing disabled"
                  : ""}
                {activeAdapter ? ` · signing via ${activeAdapter.appKind}` : ""}
              </p>
              <p className="text-[11px] text-gray-500">
                Address (short): <span className="font-mono">{shortenAddress(account.address)}</span>
              </p>
            </div>
          )}

          {!busy && !error && !account && (
            <p className="text-gray-400">Not connected yet.</p>
          )}
        </div>

        <div className="flex flex-wrap justify-end gap-2">
          {account && (
            <button
              type="button"
              onClick={handleDisconnect}
              className="rounded-lg border border-rose-500/30 px-3 py-1.5 text-xs text-rose-300 hover:bg-rose-500/10 transition-smooth"
            >
              Disconnect
            </button>
          )}
          <button
            type="button"
            onClick={() => void connect()}
            disabled={busy}
            className="rounded-lg border border-trellis-vine/30 bg-trellis-vine/10 px-3 py-1.5 text-xs hover:bg-trellis-vine/20 disabled:opacity-50 transition-smooth"
          >
            {error ? "Try again" : busy ? "Connecting…" : "Reconnect"}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-trellis-vine/30 px-3 py-1.5 text-xs hover:bg-trellis-vine/20 transition-smooth"
          >
            {account ? "Done" : "Cancel"}
          </button>
        </div>
      </div>
    </div>
  );
}
