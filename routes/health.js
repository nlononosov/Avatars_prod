const { PORT, BASE_URL, SCOPES, CLIENT_ID, CLIENT_SECRET } = require('../lib/config');
const { status } = require('../services/bot');
const { getHealthStatus } = require('../lib/redis');
const { getPollingMetrics } = require('../lib/donationalerts-poll');

function registerHealthRoute(app) {
  app.get('/health', (_req, res) => {
    const bot = status();
    const redisHealth = getHealthStatus();
    const pollMetrics = getPollingMetrics();
    
    res.json({
      ok: true,
      baseUrl: BASE_URL,
      port: PORT,
      scopes: SCOPES,
      hasClientId: Boolean(CLIENT_ID),
      hasClientSecret: Boolean(CLIENT_SECRET),
      botRunning: bot.running,
      redis: {
        status: redisHealth.disabled ? 'disabled' : 'enabled',
        isRequired: redisHealth.isRequired,
        lastHealthCheck: redisHealth.lastHealthCheck
      },
      polling: {
        streamerCount: pollMetrics.streamerCount,
        concurrency: pollMetrics.actualConcurrency,
        interval: pollMetrics.actualInterval,
        queueSize: pollMetrics.queueSize,
        pending: pollMetrics.pending
      },
      scalability: {
        canScaleHorizontally: !redisHealth.disabled,
        asyncDbEnabled: true,
        dbWorkerThread: true,
        lazyCacheEnabled: true,
        dynamicPollingEnabled: true
      }
    });
  });
}

module.exports = { registerHealthRoute };


