#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const { existsSync } = require('node:fs');
const { join } = require('node:path');

const [scriptName, ...scriptArgs] = process.argv.slice(2);
if (!scriptName) {
  console.error('Usage: node scripts/bash.js <script.sh> [args...]');
  process.exit(1);
}

const scriptPath = join(__dirname, scriptName).replace(/\\/g, '/');
if (!existsSync(scriptPath)) {
  console.error(`Script not found: ${scriptPath}`);
  process.exit(1);
}

let bash = 'bash';
if (process.platform === 'win32') {
  const candidates = [
    process.env.CHEKKU_BASH,
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
  ].filter(Boolean);
  bash = candidates.find((c) => existsSync(c)) || 'bash';
}

const result = spawnSync(bash, [scriptPath, ...scriptArgs], {
  stdio: 'inherit',
});

process.exit(result.status ?? 1);
