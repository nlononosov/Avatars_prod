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

// Start DonationAlerts polling
const { startPolling } = require('./lib/donationalerts-poll');
startPolling();

app.listen(PORT, () => {
  console.log(`Server listening on ${BASE_URL}`);
});
