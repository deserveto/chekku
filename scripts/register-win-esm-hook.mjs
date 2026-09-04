// Registers scripts/win-esm-specifier-hook.mjs as a module-customization
// resolve hook. Loaded via NODE_OPTIONS=--import (see scripts/mastra-dev.mjs)
// so every Node process in the Mastra dev tree inherits the hook, including
// the server process that executes agent/.mastra/output/index.mjs.
import { register } from 'node:module';

register(new URL('win-esm-specifier-hook.mjs', import.meta.url));
