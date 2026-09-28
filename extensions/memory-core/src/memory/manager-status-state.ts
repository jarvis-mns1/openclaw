import fs from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import {
  MEMORY_EMBEDDING_CACHE_TABLE,
  MEMORY_INDEX_VECTOR_TABLE,
  type MemoryProviderStatus,
  type MemorySource,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "openclaw/plugin-sdk/sqlite-runtime";
import type { MemoryIndexDatabase } from "./manager-database-context.js";
import { resolvePersistedMemoryVectorIndexState } from "./manager-vector-rebuild-state.js";

type StatusProvider = {
  id: string;
  model: string;
};

type StatusAggregateRow = {
  kind: "files" | "chunks";
  source: MemorySource;
  c: number;
  bytes: number | null;
};

export function collectMemoryCacheStatus(
  db: Pick<DatabaseSync, "prepare">,
  cache: { enabled: boolean; maxEntries?: number },
  storage?: MemoryProviderStatus["storage"],
): NonNullable<MemoryProviderStatus["cache"]> {
  return cache.enabled
    ? {
        enabled: true,
        entries:
          storage?.embeddingCacheEntries ??
          Number(
            db.prepare(`SELECT COUNT(*) as c FROM ${MEMORY_EMBEDDING_CACHE_TABLE}`).get()?.c ?? 0,
          ),
        maxEntries: cache.maxEntries,
      }
    : { enabled: false, maxEntries: cache.maxEntries };
}

export function collectMemoryVectorStatus(
  db: DatabaseSync,
  vector: MemoryIndexDatabase["vector"],
  hasSemanticChunks: boolean,
): NonNullable<MemoryProviderStatus["vector"]> {
  return {
    enabled: vector.enabled,
    index: resolvePersistedMemoryVectorIndexState({
      db,
      vectorTable: MEMORY_INDEX_VECTOR_TABLE,
      metaVectorDims: vector.dims,
      hasSemanticChunks,
    }),
    storeAvailable: vector.available ?? undefined,
    semanticAvailable: vector.semanticAvailable,
    available: vector.semanticAvailable,
    extensionPath: vector.extensionPath,
    loadError: vector.loadError,
    dims: vector.dims,
  };
}

/** Read only for explicit diagnostics: retained cache payloads can be large even when disabled. */
export function collectMemoryStorageStatus(
  db: DatabaseSync,
  databasePath: string,
): NonNullable<MemoryProviderStatus["storage"]> {
  const query = getNodeSqliteKysely<{ memory_embedding_cache: { embedding: Uint8Array } }>(db)
    .selectFrom("memory_embedding_cache")
    .select((eb) => [
      eb.fn.countAll<number>().as("entries"),
      eb.fn
        .coalesce(eb.fn.sum<number>(eb.fn<number>("octet_length", ["embedding"])), eb.val(0))
        .as("bytes"),
    ]);
  const cache = executeSqliteQuerySync(db, query).rows[0]!;
  const pageSize = Number(db.prepare("PRAGMA page_size").get()?.page_size);
  const freePages = Number(db.prepare("PRAGMA freelist_count").get()?.freelist_count);
  return {
    databaseBytes: fs.statSync(databasePath, { throwIfNoEntry: false })?.size ?? 0,
    walBytes: fs.statSync(`${databasePath}-wal`, { throwIfNoEntry: false })?.size ?? 0,
    reusableBytes: freePages * pageSize,
    embeddingCacheBytes: cache.bytes,
    embeddingCacheEntries: cache.entries,
  };
}

export function resolveStatusProviderInfo(params: {
  provider: StatusProvider | null;
  providerInitialized: boolean;
  requestedProvider: string;
  resolveConfiguredModel?: () => string | undefined;
}): {
  provider: string;
  model?: string;
  searchMode: "hybrid" | "fts-only";
} {
  if (params.provider) {
    return {
      provider: params.provider.id,
      model: params.provider.model,
      searchMode: "hybrid",
    };
  }
  if (params.providerInitialized) {
    return {
      provider: "none",
      model: undefined,
      searchMode: "fts-only",
    };
  }
  return {
    provider: params.requestedProvider,
    model: params.resolveConfiguredModel?.() || undefined,
    searchMode: "hybrid",
  };
}

export function collectMemoryStatusAggregate(params: {
  db: Pick<DatabaseSync, "prepare">;
  sources: Iterable<MemorySource>;
  sourceFilterSql?: string;
  sourceFilterParams?: MemorySource[];
  includeChunkBytes?: boolean;
}): {
  files: number;
  chunks: number;
  sourceCounts: Array<{ source: MemorySource; files: number; chunks: number; chunkBytes?: number }>;
} {
  const totals = { files: 0, chunks: 0 };
  const emptyCounts = { ...totals, ...(params.includeChunkBytes ? { chunkBytes: 0 } : {}) };
  const bySource = new Map<MemorySource, typeof emptyCounts>();
  // Ordinary status uses covering indexes; payload-byte inspection is diagnostic.
  const chunkBytes = params.includeChunkBytes
    ? "COALESCE(SUM(octet_length(text) + octet_length(embedding)), 0)"
    : "NULL";
  const sourceFilterSql = params.sourceFilterSql ?? "";
  const query =
    `SELECT 'files' AS kind, source, COUNT(*) as c, 0 AS bytes FROM memory_index_sources WHERE 1=1${sourceFilterSql} GROUP BY source\n` +
    `UNION ALL\n` +
    `SELECT 'chunks' AS kind, source, COUNT(*) as c, ${chunkBytes} AS bytes FROM memory_index_chunks WHERE 1=1${sourceFilterSql} GROUP BY source`;
  const filterParams = params.sourceFilterParams ?? [];
  const rows = params.db
    .prepare(query)
    // SAFETY: Both UNION branches return the declared kind/source, count, and nullable byte total.
    .all(...filterParams, ...filterParams) as StatusAggregateRow[];
  for (const row of rows) {
    const entry = bySource.get(row.source) ?? { ...emptyCounts };
    entry[row.kind] = row.c;
    totals[row.kind] += row.c;
    if (row.kind === "chunks" && row.bytes !== null) {
      entry.chunkBytes = row.bytes;
    }
    bySource.set(row.source, entry);
  }
  return {
    ...totals,
    sourceCounts: Array.from(params.sources, (source) =>
      Object.assign({ source, ...emptyCounts }, bySource.get(source)),
    ),
  };
}
