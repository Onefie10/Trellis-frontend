/**
 * Side-Effect Dispatcher React Hook and Helpers.
 *
 * Provides a clean hook for UI components to dispatch async actions,
 * surface progress, observe retries, handle optimistic states,
 * and display accessible error/recovery states.
 */

'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  sideEffectDeadLetterQueue,
  SideEffectDeadLetterQueue,
} from './dead-letter';
import {
  sideEffectDispatcher,
  SideEffectDispatcher,
  type SideEffectHandler,
} from './dispatcher';
import type {
  DeadLetterSideEffect,
  SideEffectDescriptor,
  SideEffectExecutionResult,
  SideEffectStatus,
} from './types';

export interface UseSideEffectOptions<TPayload, TResult> {
  dispatcher?: SideEffectDispatcher;
  handler?: SideEffectHandler<TPayload, TResult>;
  onSuccess?: (result: TResult) => void;
  onError?: (error: string) => void;
}

export interface UseSideEffectReturn<TPayload, TResult> {
  dispatch: (descriptor: SideEffectDescriptor<TPayload>) => Promise<SideEffectExecutionResult<TResult>>;
  status: SideEffectStatus;
  isLoading: boolean;
  isCached: boolean;
  result: TResult | null;
  error: string | null;
  reset: () => void;
}

export function useSideEffect<TPayload = unknown, TResult = unknown>(
  options: UseSideEffectOptions<TPayload, TResult> = {},
): UseSideEffectReturn<TPayload, TResult> {
  const [status, setStatus] = useState<SideEffectStatus>('idle');
  const [result, setResult] = useState<TResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isCached, setIsCached] = useState(false);

  const dispatcher = options.dispatcher ?? sideEffectDispatcher;

  const dispatch = useCallback(
    async (descriptor: SideEffectDescriptor<TPayload>): Promise<SideEffectExecutionResult<TResult>> => {
      setStatus('in_progress');
      setError(null);

      try {
        const execution = await dispatcher.dispatch<TPayload, TResult>(descriptor, options.handler);
        setStatus(execution.status);
        setIsCached(execution.isCached);

        if (execution.ok) {
          setResult(execution.result ?? null);
          options.onSuccess?.(execution.result as TResult);
        } else {
          setError(execution.error ?? 'Operation failed');
          options.onError?.(execution.error ?? 'Operation failed');
        }

        return execution;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        setStatus('failed');
        setError(msg);
        options.onError?.(msg);
        return {
          ok: false,
          key: descriptor.key,
          status: 'failed',
          error: msg,
          isCached: false,
          attempts: 1,
        };
      }
    },
    [dispatcher, options],
  );

  const reset = useCallback(() => {
    setStatus('idle');
    setResult(null);
    setError(null);
    setIsCached(false);
  }, []);

  return {
    dispatch,
    status,
    isLoading: status === 'in_progress' || status === 'queued',
    isCached,
    result,
    error,
    reset,
  };
}

/**
 * Hook to observe and interact with the Dead Letter Queue in dashboards and admin views.
 */
export function useSideEffectDLQ(dlq: SideEffectDeadLetterQueue = sideEffectDeadLetterQueue) {
  const [entries, setEntries] = useState<readonly DeadLetterSideEffect[]>([]);
  const [isReplaying, setIsReplaying] = useState(false);

  useEffect(() => {
    setEntries(dlq.list());
    return dlq.subscribe(setEntries);
  }, [dlq]);

  const replay = useCallback(
    async (id: string, customDispatcher?: SideEffectDispatcher) => {
      const activeDispatcher = customDispatcher ?? sideEffectDispatcher;
      setIsReplaying(true);
      try {
        return await activeDispatcher.replayDeadLetter(id);
      } finally {
        setIsReplaying(false);
      }
    },
    [],
  );

  const discard = useCallback(
    (id: string) => {
      return dlq.resolve(id, 'discarded');
    },
    [dlq],
  );

  const clear = useCallback(() => {
    dlq.clear();
  }, [dlq]);

  return {
    entries,
    isReplaying,
    replay,
    discard,
    clear,
  };
}
