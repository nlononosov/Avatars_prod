const client = require('prom-client');

const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry });

const donationPollDuration = new client.Histogram({
  name: 'donationalerts_poll_duration_seconds',
  help: 'Duration of DonationAlerts polling tasks',
  labelNames: ['streamer'],
  registers: [registry],
});

const donationPollErrors = new client.Counter({
  name: 'donationalerts_poll_errors_total',
  help: 'Count of polling errors',
  labelNames: ['type'],
  registers: [registry],
});

const donationQueueGauge = new client.Gauge({
  name: 'donationalerts_queue_entries',
  help: 'Size of the DonationAlerts polling queue',
  labelNames: ['state'],
  registers: [registry],
});

const donationConfigGauge = new client.Gauge({
  name: 'donationalerts_poll_config',
  help: 'Dynamic DonationAlerts polling configuration',
  labelNames: ['metric'],
  registers: [registry],
});

const overlayConnectionsGauge = new client.Gauge({
  name: 'overlay_sse_connections',
  help: 'Number of active overlay SSE connections',
  labelNames: ['scope'],
  registers: [registry],
});

const overlayEventsCounter = new client.Counter({
  name: 'overlay_events_total',
  help: 'Number of overlay events emitted',
  labelNames: ['scope', 'event'],
  registers: [registry],
});

const redisHealthGauge = new client.Gauge({
  name: 'redis_health_status',
  help: 'Current Redis connection status',
  labelNames: ['metric'],
  registers: [registry],
});

let donationPollMetricsProvider = null;
const knownOverlayScopes = new Set();

function setDonationPollMetricsProvider(provider) {
  donationPollMetricsProvider = provider;
}

donationQueueGauge.collect = function collectDonationQueue() {
  if (!donationPollMetricsProvider) {
    this.set({ state: 'queued' }, 0);
    this.set({ state: 'pending' }, 0);
    return;
  }
  const metrics = donationPollMetricsProvider();
  this.set({ state: 'queued' }, metrics.queueSize || 0);
  this.set({ state: 'pending' }, metrics.pending || 0);
};

donationConfigGauge.collect = function collectDonationConfig() {
  if (!donationPollMetricsProvider) {
    this.set({ metric: 'streamers' }, 0);
    this.set({ metric: 'concurrency' }, 0);
    this.set({ metric: 'interval_ms' }, 0);
    this.set({ metric: 'cycle_time_ms' }, 0);
    return;
  }
  const metrics = donationPollMetricsProvider();
  this.set({ metric: 'streamers' }, metrics.streamerCount || 0);
  this.set({ metric: 'concurrency' }, metrics.actualConcurrency || 0);
  this.set({ metric: 'interval_ms' }, metrics.actualInterval || 0);
  this.set({ metric: 'cycle_time_ms' }, metrics.cycleTime || 0);
};

function updateDonationQueueMetrics(queue) {
  donationQueueGauge.set({ state: 'queued' }, queue.size);
  donationQueueGauge.set({ state: 'pending' }, queue.pending);
}

function updateOverlaySubscriberMetrics(counts) {
  const currentScopes = new Set(['global']);
  overlayConnectionsGauge.set({ scope: 'global' }, counts.global || 0);
  if (counts.streamers) {
    for (const [streamerId, total] of Object.entries(counts.streamers)) {
      overlayConnectionsGauge.set({ scope: streamerId }, total);
      currentScopes.add(streamerId);
    }
  }

  for (const scope of knownOverlayScopes) {
    if (!currentScopes.has(scope)) {
      overlayConnectionsGauge.set({ scope }, 0);
    }
  }

  knownOverlayScopes.clear();
  for (const scope of currentScopes) {
    knownOverlayScopes.add(scope);
  }
}

function recordOverlayDispatch(scope, eventName) {
  overlayEventsCounter.inc({ scope, event: eventName });
}

function reportRedisHealth(status) {
  redisHealthGauge.set({ metric: 'disabled' }, status.disabled ? 1 : 0);
  redisHealthGauge.set({ metric: 'required' }, status.isRequired ? 1 : 0);
  const healthy = status.lastHealthCheck?.success ? 1 : 0;
  redisHealthGauge.set({ metric: 'healthy' }, healthy);
}

function registerMetrics(app) {
  app.get('/metrics', async (_req, res) => {
    try {
      res.set('Content-Type', registry.contentType);
      res.send(await registry.metrics());
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });
}

module.exports = {
  donationPollDuration,
  donationPollErrors,
  setDonationPollMetricsProvider,
  updateDonationQueueMetrics,
  updateOverlaySubscriberMetrics,
  recordOverlayDispatch,
  reportRedisHealth,
  registerMetrics,
};

