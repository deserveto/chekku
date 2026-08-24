import 'dotenv/config';
import { Mastra } from '@mastra/core/mastra';
import { MastraEditor } from '@mastra/editor';
import { PostgresStore } from '@mastra/pg';
import { PinoLogger } from '@mastra/loggers';
import { InMemoryThreadStateStorage } from '@mastra/core/storage';
import { env } from '../config/env.js';
import { requestIdInjector, requestLogger } from '../config/middleware.js';
import { registerTaskSignalProcessors } from './tasks/task-signals.js';
import { mainAgent } from '../agents/main-agent.js';
import { pmAgent } from '../agents/pm-agent.js';
import { qaWebAgent } from '../agents/qa-web-agent.js';
import { qaAndroidAgent } from '../agents/qa-android-agent.js';
import {
  socialMediaContentWriter,
  registerSocialSlashCommands,
} from '../agents/social-media-content-writer.js';
import { socialMediaStrategistAgent } from '../agents/social-media-strategist-agent.js';
import { socialMediaSupervisorAgent } from '../agents/social-media-supervisor-agent.js';
import { visualContentAgent } from '../agents/visual-content-agent.js';
import { OpenAICompatibleGateway } from './gateways/openai-compatible.js';
import { garageMcpServer } from './mcp/garage-mcp-server.js';
import { searxngMcpServer } from './mcp/searxng-mcp-server.js';
import { webReaderMcpServer } from './mcp/web-reader-mcp-server.js';
import { healthRoute } from './routes/health.js';
import { modelsRoute } from './routes/models.js';
import {
  activeRunRoute,
  cancelRunRoute,
  listRunsRoute,
  runEventsRoute,
  runStatusRoute,
  startRunRoute,
} from './routes/runs.js';
import { storedAgentTools } from './tools/registry.js';
import { generateSocialPostVisual } from './workflows/generate-social-post-visual.js';
import { repurposeSocialPost } from './workflows/repurpose-social-post.js';
import { weeklySocialDrafts } from './workflows/weekly-social-drafts.js';

const storage = new PostgresStore({
  id: 'chekku-storage',
  connectionString: env.DATABASE_URL,
});

// @mastra/pg 1.15.0 does not implement the `threadState` storage domain, so
// the native task tools' `resolveTaskStore` (getStore('threadState')) would
// return undefined and every task_write/update/complete/check call would
// fail with the misleading "requires agent memory" error. Mastra's
// composite store backfills this domain with an in-memory store by default;
// mirror that here until @mastra/pg ships the domain (newer @mastra/pg
// requires @mastra/core >= 1.53, so upgrading now would churn the whole
// pinned Mastra stack). Task state is durable for the process lifetime;
// across restarts the client rebuilds the latest snapshot from persisted
// Memory task tool results.
if (!storage.stores?.threadState) {
  storage.stores = {
    ...storage.stores,
    threadState: new InMemoryThreadStateStorage(),
  };
}

export const mastra = new Mastra({
  agents: {
    mainAgent,
    pmAgent,
    qaWebAgent,
    qaAndroidAgent,
    socialMediaContentWriter,
    socialMediaStrategistAgent,
    socialMediaSupervisorAgent,
    visualContentAgent,
  },
  workflows: { weeklySocialDrafts, repurposeSocialPost, generateSocialPostVisual },
  mcpServers: {
    garage: garageMcpServer,
    searxng: searxngMcpServer,
    'web-reader': webReaderMcpServer,
  },
  tools: storedAgentTools,
  storage,
  editor: new MastraEditor({ source: 'db' }),
  gateways: {
    openAICompatible: new OpenAICompatibleGateway(),
  },
  logger: new PinoLogger({
    name: 'Chekku',
    level: env.LOG_LEVEL,
  }),
  server: {
    port: env.PORT,
    host: env.HOST,
    // Chat uploads arrive as base64-inflated multimodal message parts; the
    // client caps payloads at 8 MiB of base64, so the default 4.5 MiB body
    // limit would reject multi-image/PDF-page messages before they reach Memory.
    bodySizeLimit: 12 * 1024 * 1024,
    cors: { origin: env.WEB_URL, credentials: true },
    middleware: [requestIdInjector, requestLogger],
    apiRoutes: [
      healthRoute,
      modelsRoute,
      startRunRoute,
      activeRunRoute,
      listRunsRoute,
      runStatusRoute,
      runEventsRoute,
      cancelRunRoute,
    ],
  },
});

// Mastra#addProcessor dedupes by processor id, and every agent's
// TaskSignalProvider carries a `task-state` processor with that same
// hardcoded id — left to the default registration path, only the first
// agent's processor would receive its mastra reference and the other
// seven would lose durable task state. Unique-key registration gives
// every agent's processor a live reference (see task-signals.ts).
registerTaskSignalProcessors(mastra);

// Telegram intercepts /command messages as native slash commands and routes
// them through the Chat SDK's slash-command pipeline — they never reach the
// agent's onDirectMessage handler. Register our command handlers on the SDK
// once it's initialized (Mastra fires AgentChannels.initialize() asynchronously).
const socialChannels = socialMediaContentWriter.getChannels();
if (socialChannels) {
  void (async () => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const sdk = socialChannels.sdk;
      if (sdk) {
        registerSocialSlashCommands(sdk);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  })();
}
