// server.js
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const path = require('path');

const { PORT, BASE_URL, assertConfig } = require('./lib/config');
const { sseHandler } = require('./lib/logger');
const { registerAuthRoutes } = require('./routes/auth');
const { registerSuccessRoute } = require('./routes/success');
const { registerMyAvatarRoute } = require('./routes/my-avatar');
const { registerAvatarCustomizeRoutes } = require('./routes/avatar-customize');
const { registerBotRoutes } = require('./routes/bot');
const { registerHealthRoute } = require('./routes/health');
const { registerLogoutRoute } = require('./routes/logout');
const { registerGiftRoutes } = require('./routes/gifts');
const { registerMyChatRoute } = require('./routes/my-chat');
const { registerPaymentSuccessRoute } = require('./routes/payment-success');
const { registerDonationAlertsRoute } = require('./routes/donationalerts');
const { registerDonationAlertsAuthRoutes } = require('./routes/donationalerts-auth');
const { registerDonationAlertsConnectRoutes } = require('./routes/donationalerts-connect');
const { registerDebugRoutes } = require('./routes/debug');
const { registerGameRoutes } = require('./routes/games');
const { overlayEventsHandler } = require('./lib/bus');
const { registerMetrics } = require('./lib/metrics');
const { handleWebhook, validateWebhook } = require('./lib/yookassa');
const { initializeUsernameCache } = require('./lib/donationalerts');
const { restoreBotsFromRedis } = require('./services/bot');
const { getClient, getHealthStatus } = require('./lib/redis');

const app = express();
app.use(cors());
app.use(cookieParser());
app.use(express.json());
app.use(express.static(__dirname));

assertConfig(console);

registerMetrics(app);

// Logs SSE
app.get('/events', sseHandler);

// Overlay SSE
app.get('/overlay/events', (req, res) => {
  // Parse query parameters manually if needed
  req.query = req.query || {};
  overlayEventsHandler(req, res);
});

// Race finish API - DEPRECATED: these endpoints are no longer used with multi-bot architecture
// app.post('/api/race/finish', ...)
// app.post('/api/food-game/finish', ...)

// YooKassa webhook
app.post('/api/payment/webhook', validateWebhook, handleWebhook);

// Routes
registerAuthRoutes(app);
registerSuccessRoute(app);
registerMyAvatarRoute(app);
registerAvatarCustomizeRoutes(app);
registerBotRoutes(app);
registerHealthRoute(app);
registerLogoutRoute(app);
registerGiftRoutes(app);
registerMyChatRoute(app);
registerPaymentSuccessRoute(app);
registerDonationAlertsRoute(app);
registerDonationAlertsAuthRoutes(app);
registerDonationAlertsConnectRoutes(app);
registerDebugRoutes(app);
registerGameRoutes(app);

// API для метрик хитбокса аватаров - DEPRECATED: requires streamerId for multi-bot
// app.post('/api/plane-race/avatar-metrics', ...)

// Initialize DonationAlerts username cache
initializeUsernameCache();

// Проверка Redis при старте (для продакшена)
async function checkRedisConnection() {
  const REDIS_REQUIRED = process.env.REDIS_REQUIRED === 'true';
  
  if (REDIS_REQUIRED) {
    try {
      const client = await getClient();
      await client.ping();
      console.log('[Server] Redis connection verified');
      return true;
    } catch (error) {
      console.error('[Server] CRITICAL: Redis is required but connection failed:', error.message);
      process.exit(1);
    }
  } else {
    // Проверяем, но не падаем
    try {
      const health = getHealthStatus();
      if (health.disabled) {
        console.warn('[Server] WARNING: Redis is unavailable, some features may not work correctly');
      } else {
        console.log('[Server] Redis connection available');
      }
    } catch (error) {
      console.warn('[Server] WARNING: Could not check Redis status:', error.message);
    }
  }
}

// Автоматическое восстановление ботов при старте
async function initializeBots() {
  try {
    console.log('[Server] Restoring bots from Redis...');
    await restoreBotsFromRedis();
    console.log('[Server] Bot restoration completed');
    
    // Запускаем watchdog для автоматического мониторинга ботов
    const { startBotWatchdog } = require('./services/bot');
    startBotWatchdog();
  } catch (error) {
    console.error('[Server] Error restoring bots:', error.message);
    // Не падаем при ошибке восстановления, просто логируем
  }
}

// Инициализация приложения
async function startServer() {
  // Проверяем Redis перед запуском
  await checkRedisConnection();
  
  // Восстанавливаем ботов
  await initializeBots();
  
  // Start DonationAlerts polling
  const { startPolling } = require('./lib/donationalerts-poll');
  startPolling();
  
  app.listen(PORT, () => {
    console.log(`Server listening on ${BASE_URL}`);
  });
}

startServer().catch((error) => {
  console.error('[Server] Failed to start server:', error);
  process.exit(1);
});
