# Agent Discovery System

This directory contains the implementation of the Agent Discovery System for the Trellis application.

## Features
- Full-text search across agent names, descriptions, and capabilities.
- **Client-side semantic (vector) search** for natural-language queries — see below.
- Multi-criteria filtering (category, price range, rating, contract type).
- Trending and recommended agents based on Stellar transaction history.
- Saved searches for quick access.
- Search analytics tracking.

## Directory Structure
```
agent-discovery/
├── components/       # React components for the UI
├── services/         # searchService.ts (Algolia) + semanticSearchService.ts (in-browser)
├── hooks/            # useSearch.ts (Algolia) + useSemanticSearch.ts (in-browser)
├── semantic/         # Embedders, cosine ranking, cache, hybrid index
├── utils/            # Utility functions for search and filtering
└── tests/            # Unit and integration tests
```

## Semantic search

Keyword search cannot match `"financial audit assistant"` to an agent described as
`"ledger reconciliation and reporting"`. The `semantic/` module embeds the
catalogue in the browser and ranks by cosine similarity, so a query is matched on
meaning as well as on words.

### How it works

```
agent  ──buildAgentDocument()──►  normalised text
                                      │
                     TransformersEmbedder (Xenova/all-MiniLM-L6-v2, WASM)
                     or LexicalEmbedder (hashed bag-of-words fallback)
                                      │
                                 Float32Array (384-d)
                                      │
query  ──────────embed ──────────► cosine similarity ──┐
                                                       ├─► hybrid score (0.75·vector + 0.25·lexical)
      ──────────tokenize ──────► weighted lexical ─────┘
```

* `semantic/tokenizer.ts` — camelCase/`snake_case` splitting, stop-word removal,
  character 3-grams, per-field weights (`name` 4 → `author` 0.5) and the lexical
  score that keeps an exact name match on top.
* `semantic/cosine.ts` — dot product, L2 normalisation, cosine similarity, mean
  pooling and 5-decimal quantisation for storage.
* `semantic/transformers-embedder.ts` — lazily imports `@xenova/transformers` and
  runs `Xenova/all-MiniLM-L6-v2` in the WASM backend. The import is guarded: when
  the package is not installed, WASM is unavailable or the model cannot be
  fetched, it throws `EmbeddingUnavailableError` instead of breaking the page.
* `semantic/hash-embedder.ts` — deterministic hashed bag-of-words embedder used as
  the fallback, so search keeps working offline, during SSR and in tests.
* `semantic/embedding-cache.ts` — in-memory LRU plus an optional `localStorage`
  layer keyed by embedder id, so a page reload does not re-embed the catalogue.
* `semantic/semantic-search.ts` — `SemanticSearchIndex`: batch indexing, cache
  reuse, automatic fallback, hybrid ranking, `limit` / `minScore` / `filter` /
  `fields` options.
* `services/semanticSearchService.ts` — one-shot helper that resolves the best
  embedder and reports which one answered.
* `hooks/useSemanticSearch.ts` — React binding: indexes once per catalogue,
  debounces the query and exposes explicit `idle → indexing → searching → ready`
  states.

### Usage

Index a catalogue once and search it as the user types:

```tsx
import { useSemanticSearch } from "@/features/agent-discovery/hooks/useSemanticSearch";

const { results, status, semantic } = useSemanticSearch(agents, query, { limit: 12 });
```

Or run a single query without React:

```ts
import { searchAgentsSemantically } from "@/features/agent-discovery/services/semanticSearchService";

const { results, embedder, semantic, fallbackReason } =
  await searchAgentsSemantically(agents, "financial audit assistant");
```

`app/marketplace/page.tsx` uses the hook for the marketplace search box; when the
model cannot load it silently serves the lexical ranking and the UI keeps working.

### Dependencies

`@xenova/transformers` is declared under `optionalDependencies`: the semantic
layer detects it at runtime and degrades to the lexical embedder when it is
absent, so a plain `npm install` never fails because of the model runtime.

## Setup
1. Install dependencies:
   ```bash
   npm install algoliasearch use-debounce lodash
   ```
2. Add environment variables for Algolia:
   ```bash
   ALGOLIA_APP_ID=your-app-id
   ALGOLIA_API_KEY=your-api-key
   ALGOLIA_INDEX_NAME=your-index-name
   ```

## Development
- Run the development server:
  ```bash
  npm run dev
  ```
- Run tests:
  ```bash
  npm run test
  ```

## Testing
- Unit tests for search query builder.
- Unit tests for semantic scoring (`tests/semantic-search.test.ts`): tokenizer,
  cosine maths, both embedders, the embedding cache, hybrid ranking, fallback
  behaviour and the service helper.
- Integration tests for filtering logic.
- Performance tests for search responses.
- Tests for recommendation algorithm.

## Dependencies
- `algoliasearch`
- `use-debounce`
- `lodash`
- `@xenova/transformers` (optional — client-side ONNX embeddings)
