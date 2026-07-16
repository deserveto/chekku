import 'dotenv/config';
import { Mastra } from '@mastra/core/mastra';
import { MastraEditor } from '@mastra/editor';
import { LibSQLStore } from '@mastra/libsql';
import { PinoLogger } from '@mastra/loggers';
import { env } from '../config/env.js';
import { requestIdInjector, requestLogger } from '../config/middleware.js';
import { mainAgent } from '../agents/main-agent.js';
import { qaWebAgent } from '../agents/qa-web-agent.js';
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
  agents: { mainAgent, qaWebAgent },
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
