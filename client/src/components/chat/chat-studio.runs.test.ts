import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const chatStudio = readFileSync(
  new URL('./chat-studio.tsx', import.meta.url),
  'utf8',
);

describe('chat-studio run-lifecycle wiring', () => {
  it('starts runs through the run API instead of owning a live stream', () => {
    expect(chatStudio).toContain('startRun({');
    expect(chatStudio).not.toContain('agent.stream(');
    expect(chatStudio).not.toContain('processDataStream');
    expect(chatStudio).not.toContain('consumeStream');
  });

  it('discovers an existing run on mount and reconnects to it', () => {
    expect(chatStudio).toContain('await getActiveRun(agentId, threadId)');
    expect(chatStudio).toContain('attachToRun(run)');
  });

  it('attaches to the existing run on conflict instead of duplicating', () => {
    expect(chatStudio).toContain('reason instanceof RunConflictError');
    expect(chatStudio).toContain('attachToRun(reason.run)');
  });

  it('synthesizes the in-flight user turn from the run record on attach', () => {
    // Mastra persists the user message only at turn end, so attaching to a
    // running run must render the prompt from the run summary.
    expect(chatStudio).toContain('const attachToRun = useCallback(');
    expect(chatStudio).toContain('message.content === run.prompt');
  });

  it('refreshes the thread list as soon as a run starts', () => {
    expect(chatStudio).toContain('void refreshThreads();');
  });

  it('cancels by run id instead of aborting the whole thread', () => {
    expect(chatStudio).toContain('await cancelRun(run.id)');
    expect(chatStudio).not.toContain('abortThread');
  });

  it('keeps navigation available while a run is executing', () => {
    // The old guard silently swallowed thread clicks during streaming.
    const openThreadStart = chatStudio.indexOf('const openThread');
    const openThread = chatStudio.slice(
      openThreadStart,
      chatStudio.indexOf('};', openThreadStart),
    );
    expect(openThread).not.toContain('isStreaming');
    expect(chatStudio).not.toContain('disabled={isStreaming}');
    expect(chatStudio).not.toContain('const [isStreaming, setIsStreaming]');
  });

  it('separates authoritative run state from subscription state', () => {
    expect(chatStudio).toContain("activeRun?.status === 'running'");
    expect(chatStudio).toContain("useState<\n    'idle' | 'connecting' | 'connected'\n  >('idle')");
  });

  it('renders a live running indicator from polled active runs', () => {
    expect(chatStudio).toContain('listActiveRuns(agentId)');
    expect(chatStudio).toContain('chat-thread-running');
    expect(chatStudio).toContain('sidebarRuns[thread.id]');
  });

  it('drops the observation without cancelling the run on unmount', () => {
    expect(chatStudio).toContain(
      '// Dropping the observation never cancels the server-owned run.',
    );
    expect(chatStudio).toContain('subscriptionRef.current?.abort()');
  });
});
