import { execFile } from 'node:child_process';

import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

import { env } from '../../config/env.js';

const DEVICE_ID_PATTERN = /^[a-zA-Z0-9._-]+$/;
const DEFAULT_TIMEOUT_MS = 15000;

const inputSchema = z
  .object({
    device_id: z
      .string()
      .regex(DEVICE_ID_PATTERN, 'Invalid device id.')
      .optional(),
  })
  .strict();

const outputSchema = z.object({
  appId: z.string(),
  activity: z.string().optional(),
  message: z.string(),
});

export interface AdbExecResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

export type AdbExecFn = (
  command: string,
  args: string[],
  opts: { timeoutMs: number },
) => Promise<AdbExecResult>;

export interface CreateCurrentAppToolOptions {
  enabled?: boolean;
  adbPath?: string;
  timeoutMs?: number;
  exec?: AdbExecFn;
}

export function parseForegroundApp(
  dumpsys: string,
): { appId: string; activity: string } | undefined {
  const line = dumpsys
    .split('\n')
    .find((entry) => entry.includes('ResumedActivity='));
  if (!line) return undefined;
  const match = line.match(/([a-zA-Z0-9_.]+)\/([a-zA-Z0-9_.$]+)/);
  if (!match) return undefined;
  const appId = match[1];
  const activity = match[2].startsWith('.') ? `${appId}${match[2]}` : match[2];
  return { appId, activity };
}

async function defaultExec(
  command: string,
  args: string[],
  opts: { timeoutMs: number },
): Promise<AdbExecResult> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { timeout: opts.timeoutMs, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        const rawCode = err ? (err as NodeJS.ErrnoException).code : 0;
        resolve({
          stdout: String(stdout),
          stderr: String(stderr),
          code: typeof rawCode === 'number' ? rawCode : null,
        });
      },
    );
  });
}

export function createCurrentAppTool(
  options: CreateCurrentAppToolOptions = {},
) {
  return createTool({
    id: 'current_app',
    description:
      'Return the package name (appId) of the app currently in the foreground on the Android device, plus its activity. Call this before authoring a Maestro flow when the application id is unknown, instead of asking the user. Read-only; it never launches, taps, or mutates the device.',
    inputSchema,
    outputSchema,
    execute: async (input) => {
      if (options.enabled === false) {
        return {
          appId: '',
          message:
            'Maestro is not enabled. Set MAESTRO_ENABLED=true to query the device.',
        };
      }

      const adbPath = options.adbPath ?? env.ADB_PATH;
      const args = input.device_id
        ? ['-s', input.device_id, 'shell', 'dumpsys', 'activity', 'activities']
        : ['shell', 'dumpsys', 'activity', 'activities'];

      try {
        const result = await (options.exec ?? defaultExec)(adbPath, args, {
          timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        });
        const parsed = parseForegroundApp(result.stdout);
        if (!parsed) {
          return {
            appId: '',
            message:
              'Could not determine the foreground app. Ensure a device is connected and an app is open.',
          };
        }
        return {
          appId: parsed.appId,
          activity: parsed.activity,
          message: `Foreground app: ${parsed.appId}`,
        };
      } catch {
        return {
          appId: '',
          message:
            'Could not query the device. Confirm adb is reachable (ADB_PATH) and a device is connected.',
        };
      }
    },
  });
}

export const currentAppTool = createCurrentAppTool({
  enabled: env.MAESTRO_ENABLED === 'true',
});
