import { InMemoryThreadStateStorage } from '@mastra/core/storage';

/**
 * Bounded thread-state store for the composition root's `threadState`
 * backfill, plus the eviction wiring that keeps it from leaking state
 * for deleted threads.
 *
 * `Memory#deleteThread` only deletes the memory domain (thread rows and
 * messages) and never touches the `threadState` domain, so without this
 * wiring every thread's task state would live for the agent server's
 * whole process lifetime — a model-influenced, never-evicting growth
 * path.
 */

export const MAX_THREAD_STATE_THREADS = 2048;

type EvictableStores = {
  memory?: {
    deleteThread: (args: { threadId: string }) => Promise<unknown>;
  };
  threadState?: {
    deleteState?: (args: { threadId: string; type: string }) => Promise<unknown>;
    evictThread?: (threadId: string) => void;
  };
};

function evict(store: NonNullable<EvictableStores['threadState']>, threadId: string): void {
  if (typeof store.evictThread === 'function') {
    store.evictThread(threadId);
    return;
  }
  // Foreign store (e.g. core's plain InMemoryThreadStateStorage under the
  // vitest mock): drop the task state type explicitly.
  void store.deleteState?.({ threadId, type: 'task' }).catch(() => undefined);
}

export class BoundedThreadStateStorage extends InMemoryThreadStateStorage {
  readonly maxThreads: number;
  // Monotonic counter, not Date.now(): bursts of writes inside one
  // millisecond must still produce a strict touch order for eviction.
  #touchCounter = 0;
  #lastTouched = new Map<string, number>();

  constructor({ maxThreads = MAX_THREAD_STATE_THREADS }: { maxThreads?: number } = {}) {
    super();
    this.maxThreads = maxThreads;
  }

  #touch(threadId: string): void {
    this.#lastTouched.set(threadId, ++this.#touchCounter);
  }

  async setState<T = unknown>(args: {
    threadId: string;
    type: string;
    value: T;
  }): Promise<void> {
    this.#touch(args.threadId);
    await super.setState(args);
    this.#evictOverflow();
  }

  async getState<T = unknown>(args: {
    threadId: string;
    type: string;
  }): Promise<T | undefined> {
    const value = await super.getState<T>(args);
    if (value !== undefined) this.#touch(args.threadId);
    return value;
  }

  #evictOverflow(): void {
    const stateByThread = (
      this as unknown as { stateByThread: Map<string, Map<string, unknown>> }
    ).stateByThread;
    if (stateByThread.size <= this.maxThreads) return;
    const ordered = [...stateByThread.keys()].sort(
      (a, b) => (this.#lastTouched.get(a) ?? 0) - (this.#lastTouched.get(b) ?? 0),
    );
    const excess = stateByThread.size - this.maxThreads;
    for (const threadId of ordered.slice(0, excess)) {
      this.evictThread(threadId);
    }
  }

  /** Drop every state type recorded for one thread. */
  evictThread(threadId: string): void {
    const stateByThread = (
      this as unknown as { stateByThread: Map<string, Map<string, unknown>> }
    ).stateByThread;
    stateByThread.delete(threadId);
    this.#lastTouched.delete(threadId);
  }
}

/**
 * After a successful memory-domain thread deletion, drop the thread's
 * state entries so the backfilled store cannot leak them for the process
 * lifetime. A failed deletion keeps the state (conservative: the thread
 * may still exist).
 */
export function wireThreadStateEviction(stores: EvictableStores): void {
  const memory = stores?.memory;
  const threadState = stores?.threadState;
  if (!memory || !threadState) return;

  const original = memory.deleteThread.bind(memory);
  memory.deleteThread = async (args: { threadId: string }) => {
    const result = await original(args);
    evict(threadState, args.threadId);
    return result;
  };
}
