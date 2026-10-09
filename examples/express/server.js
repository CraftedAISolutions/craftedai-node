// Run: npm install && npx craftedai init && npm start   (Node >= 20.19)
import { CraftedAI } from '@craftedai/node';
import { createApp } from './app.js';

// Load .env when there is one (init writes it); variables already in the environment win.
try {
  process.loadEnvFile();
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}

const PORT = Number(process.env.PORT ?? 4000);
// Reads CRAFTEDAI_SECRET_KEY, CRAFTEDAI_APP_SECRET, CRAFTEDAI_ORG_ID and, optionally, CRAFTEDAI_PUBLIC_URL.
const craftedai = new CraftedAI();

const app = createApp({
  craftedai,
  ...(process.env.CRAFTEDAI_AGENT_ID ? { agentId: process.env.CRAFTEDAI_AGENT_ID } : {}),
  e2e: process.env.EXAMPLE_E2E === '1',
});

app.listen(PORT, () => console.log(`example listening on http://localhost:${PORT}`));
