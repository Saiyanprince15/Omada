import 'dotenv/config';
import { createServer } from 'http';
import app from './app';
import { initSocket } from './socket';
import { connectRedis } from './lib/redis';
import { prisma } from './lib/prisma';
import { expireProvisionalTeams } from './services/provisionalExpiration';

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

  // Expire stale provisional teams in-process. The sweep is idempotent
  // and uses the same per-team advisory lock as response handlers.
  const provisionalExpirationTimer = setInterval(() => {
    expireProvisionalTeams().catch((err) => {
      console.error('[provisional-expiration] Sweep failed:', err);
    });
  }, 60_000);
  provisionalExpirationTimer.unref();
  expireProvisionalTeams().catch((err) => {
    console.error('[provisional-expiration] Initial sweep failed:', err);
  });

  // Graceful shutdown
  process.on('SIGTERM', async () => {
    console.log('[server] SIGTERM received, shutting down...');
    clearInterval(provisionalExpirationTimer);
    await prisma.$disconnect();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('[server] Fatal error:', err);
  process.exit(1);
});
