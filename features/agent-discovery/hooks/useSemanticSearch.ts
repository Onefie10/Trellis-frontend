"use client";

/**
 * React binding for the semantic index.
 *
 * The whole point of the hook is that the expensive work happens once: the index
 * is built when the catalogue changes, not on every keystroke, and the query is
 * debounced so typing "financial audit assistant" costs one embedding rather than
 * twenty-eight.
 *
 * State transitions are explicit (`idle` → `indexing` → `searching` → `ready`)
 * so the UI can say "preparing semantic search" instead of showing a spinner with
 * no explanation while 23MB of weights download.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LexicalEmbedder } from "@/features/agent-discovery/semantic/hash-embedder";
import { browserStorage, EmbeddingCache } from "@/features/agent-discovery/semantic/embedding-cache";
import { SemanticSearchIndex } from "@/features/agent-discovery/semantic/semantic-search";
import { TransformersEmbedder } from "@/features/agent-discovery/semantic/transformers-embedder";
import type {
  AgentDocument,
  Embedder,
  SemanticHit,
  SemanticSearchOptions,
} from "@/features/agent-discovery/semantic/types";

export type SemanticSearchStatus = "idle" | "indexing" | "searching" | "ready" | "error";

export interface UseSemanticSearchOptions extends SemanticSearchOptions {
  /** Wait this long after the last keystroke. Default 250ms. */
  debounceMs?: number;
  /** Minimum query length before searching. Default 2. */
  minQueryLength?: number;
  /** Load the ONNX model. Default true. */
  useTransformers?: boolean;
  /** Leave the hook idle until this becomes true. */
  enabled?: boolean;
}

export interface UseSemanticSearchResult<TAgent extends AgentDocument = AgentDocument> {
  results: SemanticHit<TAgent>[];
  status: SemanticSearchStatus;
  /** Which embedder answered the last query. */
  embedder: string;
  /** False while the lexical fallback is serving. */
  semantic: boolean;
  error: string | null;
  /** Number of agents currently indexed. */
  indexed: number;
  /** Forces a re-run (e.g. a "retry with the model" button). */
  refresh: () => void;
}

export function useSemanticSearch<TAgent extends AgentDocument>(
  agents: TAgent[],
  query: string,
  options: UseSemanticSearchOptions = {},
): UseSemanticSearchResult<TAgent> {
  const {
    debounceMs = 250,
    minQueryLength = 2,
    useTransformers = true,
    enabled = true,
    limit,
    minScore,
    hybridWeight,
    filter,
    fields,
  } = options;

  const [results, setResults] = useState<SemanticHit<TAgent>[]>([]);
  const [status, setStatus] = useState<SemanticSearchStatus>("idle");
  const [embedderId, setEmbedderId] = useState<string>("");
  const [semantic, setSemantic] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [indexed, setIndexed] = useState(0);
  const [nonce, setNonce] = useState(0);

  // Identity of the catalogue: re-index only when the agents actually change.
  const catalogueKey = useMemo(
    () =>
      agents
        .map((agent) => `${agent.id}:${agent.name}:${agent.description ?? ""}:${agent.category ?? ""}`)
        .join("|"),
    [agents],
  );

  const indexRef = useRef<SemanticSearchIndex<TAgent> | null>(null);
  const embedderRef = useRef<Embedder | null>(null);
  const runRef = useRef(0);

  useEffect(() => {
    if (!enabled) {
      setStatus("idle");
      return;
    }

    let cancelled = false;
    setStatus("indexing");
    setError(null);

    const cache = new EmbeddingCache({
      storage: browserStorage(),
      namespace: "trellis:agent-embeddings",
    });
    const fallback = new LexicalEmbedder();

    const build = async () => {
      let embedder: Embedder = fallback;
      let usedModel = false;

      if (useTransformers) {
        const transformers = new TransformersEmbedder();
        try {
          await transformers.warmup();
          embedder = transformers;
          usedModel = true;
        } catch {
          // Model unavailable (offline, no WASM, package missing): keep going
          // lexically rather than surfacing an error the user cannot act on.
          embedder = fallback;
        }
      }

      if (cancelled) return;
      embedderRef.current = embedder;

      const index = new SemanticSearchIndex<TAgent>({
        embedder,
        cache,
        fallbackEmbedder: usedModel ? fallback : undefined,
        onEmbedderError: (embedError) => {
          if (!cancelled) {
            setError(embedError instanceof Error ? embedError.message : String(embedError));
          }
        },
      });

      const stats = await index.index(agents);
      if (cancelled) return;

      indexRef.current = index;
      setEmbedderId(index.activeEmbedder.id);
      setSemantic(usedModel && index.activeEmbedder.id.startsWith("transformers:"));
      setIndexed(stats.size);
      setStatus("ready");
    };

    void build();

    return () => {
      cancelled = true;
    };
    // `agents` is represented by `catalogueKey`; listing it as well would re-index
    // on every parent render that rebuilds the array.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalogueKey, enabled, useTransformers, nonce]);

  useEffect(() => {
    if (!enabled || status !== "ready") return;
    const trimmed = query.trim();

    if (trimmed.length < minQueryLength) {
      setResults([]);
      return;
    }

    const index = indexRef.current;
    if (!index) return;

    const run = ++runRef.current;
    setStatus("searching");

    const timer = setTimeout(() => {
      void (async () => {
        try {
          const hits = await index.search(trimmed, { limit, minScore, hybridWeight, filter, fields });
          // Ignore a response that arrived after a newer keystroke.
          if (run !== runRef.current) return;
          setResults(hits);
          setStatus("ready");
        } catch (searchError) {
          if (run !== runRef.current) return;
          setError(searchError instanceof Error ? searchError.message : String(searchError));
          setStatus("error");
        }
      })();
    }, debounceMs);

    return () => clearTimeout(timer);
  }, [
    query,
    status,
    enabled,
    debounceMs,
    minQueryLength,
    limit,
    minScore,
    hybridWeight,
    filter,
    fields,
  ]);

  const refresh = useCallback(() => {
    setNonce((value) => value + 1);
  }, []);

  return {
    results,
    status,
    embedder: embedderId || embedderRef.current?.id || "",
    semantic,
    error,
    indexed,
    refresh,
  };
}
