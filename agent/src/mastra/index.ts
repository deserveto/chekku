import 'dotenv/config';
import { Mastra } from '@mastra/core/mastra';
import { MastraEditor } from '@mastra/editor';
import { LibSQLStore } from '@mastra/libsql';
import { PinoLogger } from '@mastra/loggers';
import { env } from '../config/env.js';
import { requestIdInjector, requestLogger } from '../config/middleware.js';
import { mainAgent } from '../agents/main-agent.js';
import { pmAgent } from '../agents/pm-agent.js';
import { qaWebAgent } from '../agents/qa-web-agent.js';
import { qaAndroidAgent } from '../agents/qa-android-agent.js';
import {
  socialMediaAgent,
  registerSocialSlashCommands,
} from '../agents/social-media-agent.js';
import { OpenAICompatibleGateway } from './gateways/openai-compatible.js';
import { garageMcpServer } from './mcp/garage-mcp-server.js';
import { healthRoute } from './routes/health.js';
import { modelsRoute } from './routes/models.js';
import { storedAgentTools } from './tools/registry.js';

const storage = new LibSQLStore({
  id: 'chekku-storage',
  url: env.DATABASE_URL,
  ...(env.DATABASE_AUTH_TOKEN
    ? { authToken: env.DATABASE_AUTH_TOKEN }
    : {}),
});

export const mastra = new Mastra({
  agents: { mainAgent, pmAgent, qaWebAgent, qaAndroidAgent, socialMediaAgent },
  mcpServers: { garage: garageMcpServer },
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
    cors: { origin: env.WEB_URL, credentials: true },
    middleware: [requestIdInjector, requestLogger],
    apiRoutes: [healthRoute, modelsRoute],
  },
});

// Telegram intercepts /command messages as native slash commands and routes
// them through the Chat SDK's slash-command pipeline — they never reach the
// agent's onDirectMessage handler. Register our command handlers on the SDK
// once it's initialized (Mastra fires AgentChannels.initialize() asynchronously).
const socialChannels = socialMediaAgent.getChannels();
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
