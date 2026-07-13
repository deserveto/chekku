import { describe, expect, it } from 'vitest';
import { gatewayCompatibilityProcessor } from './gateway-compatibility.js';

describe('gatewayCompatibilityProcessor', () => {
  const process = gatewayCompatibilityProcessor.processLLMRequest!;

  const call = (prompt: any[], provider: string) =>
    process({
      prompt,
      model: { provider } as any,
    } as any) as Promise<any> | undefined;

  it('merges multiple system messages when provider is gateway.chat', async () => {
    const result = await call(
      [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'system', content: 'Browser context: at example.com' },
        { role: 'user', content: 'Hello' },
      ],
      'gateway.chat',
    );

    expect(result).toBeDefined();
    expect(result.prompt).toHaveLength(2);
    expect(result.prompt[0]).toEqual({
      role: 'system',
      content: 'You are a helpful assistant.\n\nBrowser context: at example.com',
    });
    expect(result.prompt[1]).toEqual({ role: 'user', content: 'Hello' });
  });

  it('places the merged system message at the beginning', async () => {
    const result = await call(
      [
        { role: 'user', content: 'Hello' },
        { role: 'system', content: 'System A' },
        { role: 'assistant', content: 'Hi' },
        { role: 'system', content: 'System B' },
      ],
      'gateway.chat',
    );

    expect(result.prompt[0].role).toBe('system');
    expect(result.prompt[0].content).toBe('System A\n\nSystem B');
  });

  it('preserves non-system message order', async () => {
    const result = await call(
      [
        { role: 'system', content: 'Sys' },
        { role: 'system', content: 'Ctx' },
        { role: 'user', content: 'First' },
        { role: 'assistant', content: 'Second' },
        { role: 'user', content: 'Third' },
      ],
      'gateway.chat',
    );

    expect(result.prompt[1]).toEqual({ role: 'user', content: 'First' });
    expect(result.prompt[2]).toEqual({ role: 'assistant', content: 'Second' });
    expect(result.prompt[3]).toEqual({ role: 'user', content: 'Third' });
  });

  it('leaves unrelated providers unchanged', async () => {
    const prompt = [
      { role: 'system', content: 'Sys' },
      { role: 'system', content: 'Ctx' },
      { role: 'user', content: 'Hi' },
    ];

    expect(await call(prompt, 'openai')).toBeUndefined();
    expect(await call(prompt, 'anthropic')).toBeUndefined();
  });

  it('returns unchanged when zero system messages exist', async () => {
    expect(
      await call([{ role: 'user', content: 'Hello' }], 'gateway.chat'),
    ).toBeUndefined();
  });

  it('returns unchanged when exactly one system message exists', async () => {
    expect(
      await call(
        [
          { role: 'system', content: 'Single system' },
          { role: 'user', content: 'Hello' },
        ],
        'gateway.chat',
      ),
    ).toBeUndefined();
  });
});
