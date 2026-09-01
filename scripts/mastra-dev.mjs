// Dev wrapper for the agent workspace: runs `mastra dev` with the win32 ESM
// specifier hook preloaded into the process tree (see
// scripts/win-esm-specifier-hook.mjs for why this exists).
//
// `mastra dev` bundles into agent/.mastra/output and immediately spawns the
// server from that bundle, so no post-build fixer step can cover the dev
// flow on Windows — the hook has to be active at module-resolution time.
import { spawn } from 'node:child_process';

const registerScript = new URL('./register-win-esm-hook.mjs', import.meta.url).href;

// NODE_OPTIONS propagates to every child Node process, including the server
// `mastra dev` spawns from the initial bundle. Forward slashes keep the
// value free of quoting hazards on Windows.
const hookFlag = `--import ${registerScript}`;
process.env.NODE_OPTIONS = process.env.NODE_OPTIONS
  ? `${process.env.NODE_OPTIONS} ${hookFlag}`
  : hookFlag;

const child = spawn('mastra', ['dev'], {
  shell: true,
  stdio: 'inherit',
  windowsHide: false,
});
child.on('exit', (code) => process.exit(code ?? 0));
