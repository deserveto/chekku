import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  createCurrentAppTool,
  parseForegroundApp,
  type AdbExecFn,
} from './current-app.js';

const RESUMED_LINE_RELATIVE =
  '    topResumedActivity=ActivityRecord{4f78a93 u0 com.noted.app/.MainActivity} t20}';
const RESUMED_LINE_FULLY_QUALIFIED =
  '  mResumedActivity=ActivityRecord{abc u0 com.example.app/com.example.app.LoginActivity} t1';

function makeTool(overrides: { exec?: AdbExecFn; enabled?: boolean } = {}) {
  return createCurrentAppTool({
    enabled: true,
    adbPath: 'adb',
    exec:
      overrides.exec ??
      (async () => ({ stdout: '', stderr: '', code: 0 })),
  });
}

type ToolOutput = { appId: string; activity?: string; message: string };

describe('parseForegroundApp', () => {
  it('extracts the appId and resolves a relative activity', () => {
    const parsed = parseForegroundApp(RESUMED_LINE_RELATIVE);
    expect(parsed?.appId).toBe('com.noted.app');
    expect(parsed?.activity).toBe('com.noted.app.MainActivity');
  });

  it('extracts the appId and keeps a fully-qualified activity', () => {
    const parsed = parseForegroundApp(RESUMED_LINE_FULLY_QUALIFIED);
    expect(parsed?.appId).toBe('com.example.app');
    expect(parsed?.activity).toBe('com.example.app.LoginActivity');
  });

  it('returns undefined when no ResumedActivity line is present', () => {
    expect(parseForegroundApp('nothing relevant here\nor here')).toBeUndefined();
  });
});

describe('createCurrentAppTool', () => {
  it('has id current_app and an optional, validated device_id', async () => {
    const tool = makeTool();
    expect(tool.id).toBe('current_app');

    const schema = tool.inputSchema as unknown as z.ZodTypeAny;
    expect(schema.safeParse({}).success).toBe(true);
    expect(schema.safeParse({ device_id: 'emulator-5554' }).success).toBe(true);
    expect(schema.safeParse({ device_id: 'evil; rm -rf /' }).success).toBe(false);
    expect(schema.safeParse({ unexpected: 1 }).success).toBe(false);
  });

  it('returns the foreground appId parsed from dumpsys', async () => {
    const tool = makeTool({
      exec: async () => ({ stdout: RESUMED_LINE_RELATIVE, stderr: '', code: 0 }),
    });
    const output = (await tool.execute!({}, {} as never)) as ToolOutput;

    expect(output.appId).toBe('com.noted.app');
    expect(output.activity).toBe('com.noted.app.MainActivity');
    expect(output.message).toContain('com.noted.app');
  });

  it('targets the given device via -s <device_id>', async () => {
    let captured: string[] = [];
    const tool = makeTool({
      exec: async (_command, args) => {
        captured = args;
        return { stdout: RESUMED_LINE_RELATIVE, stderr: '', code: 0 };
      },
    });
    await tool.execute!({ device_id: 'emulator-5554' }, {} as never);

    expect(captured).toContain('-s');
    expect(captured).toContain('emulator-5554');
    expect(captured).toContain('dumpsys');
  });

  it('returns an empty appId with a clear message when no app is detected', async () => {
    const tool = makeTool({
      exec: async () => ({ stdout: 'GARBAGE without resumed activity', stderr: '', code: 0 }),
    });
    const output = (await tool.execute!({}, {} as never)) as ToolOutput;

    expect(output.appId).toBe('');
    expect(output.message).toContain('Could not determine');
  });

  it('returns a not-enabled message when disabled', async () => {
    const tool = createCurrentAppTool({ enabled: false });
    const output = (await tool.execute!({}, {} as never)) as ToolOutput;

    expect(output.appId).toBe('');
    expect(output.message).toContain('not enabled');
  });

  it('returns a safe message when adb fails', async () => {
    const tool = makeTool({
      exec: async () => {
        throw new Error('ENOENT adb (and secrets should not leak)');
      },
    });
    const output = (await tool.execute!({}, {} as never)) as ToolOutput;

    expect(output.appId).toBe('');
    expect(output.message).not.toContain('secrets');
    expect(output.message).toContain('adb');
  });
});
