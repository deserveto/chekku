import { describe, expect, it, vi } from 'vitest';
import {
  BoundedThreadStateStorage,
  wireThreadStateEviction,
} from './task-state-store.js';

/**
 * The backfilled threadState store keeps task state for the agent
 * server's whole process lifetime. Without a bound and without eviction
 * on thread deletion it is an unbounded, model-influenced growth path.
 */
describe('BoundedThreadStateStorage', () => {
  it('evicts the least recently touched thread above the cap', async () => {
    const store = new BoundedThreadStateStorage({ maxThreads: 2 });
    await store.setState({ threadId: 't1', type: 'task', value: [] });
    await store.setState({ threadId: 't2', type: 'task', value: [] });
    // Touch t1 so t2 becomes the least recently used.
    await store.getState({ threadId: 't1', type: 'task' });
    await store.setState({ threadId: 't3', type: 'task', value: [] });

    expect(await store.getState({ threadId: 't2', type: 'task' })).toBeUndefined();
    expect(await store.getState({ threadId: 't1', type: 'task' })).toBeDefined();
    expect(await store.getState({ threadId: 't3', type: 'task' })).toBeDefined();
  });

  it('retains every thread exactly at the cap', async () => {
    // A regression like evicting at `size >= maxThreads` would churn the
    // store on every write at capacity; only overflow may evict.
    const store = new BoundedThreadStateStorage({ maxThreads: 2 });
    await store.setState({ threadId: 't1', type: 'task', value: [] });
    await store.setState({ threadId: 't2', type: 'task', value: [] });
    expect(await store.getState({ threadId: 't1', type: 'task' })).toBeDefined();
    expect(await store.getState({ threadId: 't2', type: 'task' })).toBeDefined();
  });

  it('evicts every state type of a thread on evictThread', async () => {
    const store = new BoundedThreadStateStorage();
    await store.setState({ threadId: 't1', type: 'task', value: [] });
    await store.setState({ threadId: 't1', type: 'goal', value: {} });
    store.evictThread('t1');
    expect(await store.getState({ threadId: 't1', type: 'task' })).toBeUndefined();
    expect(await store.getState({ threadId: 't1', type: 'goal' })).toBeUndefined();
  });
});

describe('wireThreadStateEviction', () => {
  it('evicts thread state after a successful memory deleteThread', async () => {
    const threadState = new BoundedThreadStateStorage();
    await threadState.setState({ threadId: 't1', type: 'task', value: [] });

    const deleteThread = vi.fn(
      async (_args: { threadId: string }) => undefined,
    );
    const stores = {
      memory: { deleteThread },
      threadState,
    };

    wireThreadStateEviction(stores);

    await stores.memory.deleteThread({ threadId: 't1' });
    expect(deleteThread).toHaveBeenCalledTimes(1);
    expect(
      await threadState.getState({ threadId: 't1', type: 'task' }),
    ).toBeUndefined();
  });

  it('keeps thread state when the memory deletion fails', async () => {
    const threadState = new BoundedThreadStateStorage();
    await threadState.setState({ threadId: 't1', type: 'task', value: [] });

    const stores = {
      memory: {
        deleteThread: vi.fn(async (_args: { threadId: string }) => {
          throw new Error('db down');
        }),
      },
      threadState,
    };

    wireThreadStateEviction(stores);

    await expect(stores.memory.deleteThread({ threadId: 't1' })).rejects.toThrow(
      'db down',
    );
    expect(
      await threadState.getState({ threadId: 't1', type: 'task' }),
    ).toBeDefined();
  });

  it('tolerates a missing memory store or threadState without one', () => {
    expect(() =>
      wireThreadStateEviction({ memory: undefined }),
    ).not.toThrow();
  });
});
