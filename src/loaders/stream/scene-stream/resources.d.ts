import type { SceneSourceHandle } from "./SceneStreamLoader.js";
import type { SceneStreamOptions } from "./SceneStreamScheduler.js";
import type { BudgetedSceneSource, SceneMemory } from "./memory.js";
export declare function logicalUrl(url: string): string;
export declare function readSceneBytes(
  url: string,
  options: SceneStreamOptions,
  signal: AbortSignal,
  limit: number,
  optional?: boolean,
): Promise<Uint8Array | undefined>;
export declare class SceneBudgetError extends Error {
  readonly sourceKey: string;
  readonly phase: string;
  readonly requestedBytes: number;
  readonly availableBytes: number;
  constructor(
    sourceKey: string,
    phase: string,
    requestedBytes: number,
    availableBytes: number,
  );
}
export interface SceneSourceLease {
  promise: Promise<SceneSourceHandle>;
  /** Resolves after the last owner releases and worker cache disposal is acknowledged. */
  release(): Promise<void>;
}
export declare class SceneSources {
  readonly entries: Map<string, unknown>;
  readonly closing: Set<Promise<void>>;
  constructor(
    load: (
      source: BudgetedSceneSource,
      signal: AbortSignal,
    ) => Promise<SceneSourceHandle>,
    memory: SceneMemory,
    signal: AbortSignal,
    onChange?: () => void,
  );
  acquire(source: BudgetedSceneSource): SceneSourceLease | undefined;
  acquireWhenAvailable(
    source: BudgetedSceneSource,
    signal: AbortSignal,
  ): Promise<SceneSourceLease>;
  wake(): void;
  dispose(): Promise<void>;
}
