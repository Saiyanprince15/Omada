import 'dotenv/config';
import { createServer } from 'http';
import app from './app';
import { initSocket } from './socket';
import { connectRedis } from './lib/redis';
import { prisma } from './lib/prisma';

const PORT = parseInt(process.env.PORT ?? '3000', 10);

async function main() {
  // Connect Redis
  await connectRedis();

  // Create HTTP server
  const httpServer = createServer(app);

  // Init Socket.IO
  initSocket(httpServer);

  httpServer.listen(PORT, () => {
    console.log(`[server] TeamForge API running on http://localhost:${PORT}`);
    console.log(`[server] Environment: ${process.env.NODE_ENV}`);
  });

  // Graceful shutdown
  process.on('SIGTERM', async () => {
    console.log('[server] SIGTERM received, shutting down...');
    await prisma.$disconnect();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('[server] Fatal error:', err);
  process.exit(1);
});
