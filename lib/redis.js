const Redis = require('ioredis');

const {
  REDIS_URL = 'redis://localhost:6379',
  REDIS_TLS = 'false',
  REDIS_REQUIRED = 'false',
} = process.env;

let client;
let subscriber;
let disabled = false;
let disableReason = null;

function createNoopClient() {
  return {
    status: 'ready',
    connect: async () => {},
    disconnect: async () => {},
    publish: async () => 0,
    duplicate: () => createNoopClient(),
    subscribe: async () => {},
    on: () => {},
  };
}

function createClient(options = {}) {
  if (disabled && REDIS_REQUIRED !== 'true') {
    return createNoopClient();
  }

  const url = options.url || REDIS_URL;
  const tls = options.tls ?? (REDIS_TLS === 'true');
  const connectionOptions = tls ? { tls: { rejectUnauthorized: false } } : {};

  const redis = new Redis(url, {
    lazyConnect: true,
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    ...connectionOptions,
  });

  redis.on('error', (error) => {
    if (error?.code === 'ECONNREFUSED' && REDIS_REQUIRED !== 'true') {
      if (!disabled) {
        console.warn('[redis] connection refused, falling back to in-memory mode');
      }
      disabled = true;
      disableReason = error;
      client?.disconnect().catch(() => {});
      subscriber?.disconnect?.().catch(() => {});
      client = null;
      subscriber = null;
      redis.disconnect().catch(() => {});
    } else {
      console.error('[redis] connection error', error);
    }
  });

  redis.on('close', () => {
    if (!disabled) {
      console.warn('[redis] connection closed');
    }
  });

  return redis;
}

async function getClient() {
  if (disabled && REDIS_REQUIRED !== 'true') {
    return createNoopClient();
  }

  if (!client) {
    client = createClient();
  }

  if (client.status === 'end') {
    await client.disconnect().catch(() => {});
    client = createClient();
  }

  if (client.status === 'wait') {
    await client.connect();
  }

  if (client.status === 'connecting' || client.status === 'reconnecting') {
    await new Promise((resolve, reject) => {
      const onReady = () => {
        client.off('error', onError);
        resolve();
      };
      const onError = (err) => {
        client.off('ready', onReady);
        reject(err);
      };

      client.once('ready', onReady);
      client.once('error', onError);
    });
  }

  if (client.status === 'ready') {
    return client;
  }

  try {
    await client.connect();
    return client;
  } catch (error) {
    if (error?.code === 'ECONNREFUSED' && REDIS_REQUIRED !== 'true') {
      disabled = true;
      disableReason = error;
      console.warn('[redis] failed to connect, switching to in-memory mode');
      await client.disconnect().catch(() => {});
      client = null;
      return createNoopClient();
    }
    throw error;
  }
}

async function getSubscriber() {
  if (disabled && REDIS_REQUIRED !== 'true') {
    return createNoopClient();
  }

  if (!subscriber) {
    const baseClient = await getClient();
    if (disabled && REDIS_REQUIRED !== 'true') {
      return createNoopClient();
    }

    subscriber = baseClient.duplicate();
    try {
      await subscriber.connect();
    } catch (error) {
      if (error?.code === 'ECONNREFUSED' && REDIS_REQUIRED !== 'true') {
        disabled = true;
        disableReason = error;
        console.warn('[redis] failed to connect subscriber, switching to in-memory mode');
        await subscriber.disconnect().catch(() => {});
        subscriber = null;
        return createNoopClient();
      }
      throw error;
    }

    subscriber.on('error', (error) => {
      if (error?.code === 'ECONNREFUSED' && REDIS_REQUIRED !== 'true') {
        disabled = true;
        disableReason = error;
        console.warn('[redis] subscriber connection lost, falling back to in-memory mode');
        subscriber?.disconnect().catch(() => {});
        subscriber = null;
        client?.disconnect().catch(() => {});
        client = null;
      } else {
        console.error('[redis] subscriber error', error);
      }
    });
  }

  return subscriber;
}

async function withClient(fn) {
  const redis = await getClient();
  return fn(redis, { disabled, reason: disableReason });
}

module.exports = {
  getClient,
  getSubscriber,
  withClient,
  createNoopClient,
};

