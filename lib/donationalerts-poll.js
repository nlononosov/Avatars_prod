const axios = require('axios');
const PQueue = require('p-queue').default;
const Redlock = require('redlock');
const LockError = Redlock.LockError;

const db = require('./db/async');
const { emitToStreamer } = require('./bus');
const { DA_CLIENT_ID, DA_CLIENT_SECRET } = require('./config');
const { getClient } = require('./redis');
const { donationPollDuration, donationPollErrors, setDonationPollMetricsProvider, updateDonationQueueMetrics } = require('./metrics');

const POLL_INTERVAL_MS = Number(process.env.DA_POLL_INTERVAL_MS || 5000);
const POLL_CONCURRENCY = Number(process.env.DA_POLL_CONCURRENCY || 4);
const POLL_LOCK_TTL_MS = Number(process.env.DA_POLL_LOCK_TTL_MS || 4500);
const POLL_MIN_INTERVAL_MS = 3000; // Минимальный интервал

// Backoff параметры для обработки ошибок API
const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 60000; // Максимум 1 минута
const RATE_LIMIT_RESPONSE_TIME_MS = 2000; // Время ответа при rate limit

// Трекинг ошибок для каждого стримера
const streamerErrorCount = new Map();
const streamerBackoffUntil = new Map();

const pollQueue = new PQueue({
  concurrency: POLL_CONCURRENCY,
  intervalCap: POLL_CONCURRENCY,
  carryoverConcurrencyCount: true,
});

const refreshQueueMetrics = () => updateDonationQueueMetrics(pollQueue);
pollQueue.on('add', refreshQueueMetrics);
pollQueue.on('next', refreshQueueMetrics);
pollQueue.on('completed', refreshQueueMetrics);
pollQueue.on('error', refreshQueueMetrics);

let redlockPromise;

async function getRedlock() {
  if (!redlockPromise) {
    redlockPromise = getClient().then((client) => {
      const redlock = new Redlock([client], {
        driftFactor: 0.01,
        retryCount: 2,
        retryDelay: 200,
        retryJitter: 100,
      });

      redlock.on('clientError', (error) => {
        console.error('[DA Poll] Redis client error in redlock', error);
      });

      return redlock;
    });
  }

  return redlockPromise;
}

// Refresh token if needed
async function refreshIfNeeded(creds) {
  const now = Math.floor(Date.now() / 1000);
  
  // Проверяем, нужно ли обновить токен (за 60 сек до истечения)
  if (creds.da_expires_at && now >= creds.da_expires_at - 60) {
    try {
      console.log(`[DA Poll] Refreshing token for streamer ${creds.streamer_twitch_id} (token expires at ${creds.da_expires_at})`);
      
      const { exchangeCodeForToken } = require('./donationalerts-oauth');
      const tokenData = await axios.post('https://www.donationalerts.com/oauth/token', {
        grant_type: 'refresh_token',
        refresh_token: creds.da_refresh_token,
        client_id: DA_CLIENT_ID,
        client_secret: DA_CLIENT_SECRET
      }, {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      });
      
      const newCreds = {
        ...creds,
        da_access_token: tokenData.data.access_token,
        da_refresh_token: tokenData.data.refresh_token || creds.da_refresh_token,
        da_expires_at: now + tokenData.data.expires_in - 60,
        status: 'active'
      };
      
      await db.upsertStreamerDA(newCreds);
      console.log(`[DA Poll] Token refreshed for streamer ${creds.streamer_twitch_id}`);
      
      return newCreds;
    } catch (error) {
      console.error(`[DA Poll] Failed to refresh token for streamer ${creds.streamer_twitch_id}:`, error.response?.data || error.message);
      
      // Помечаем как нуждающийся в повторной авторизации
      await db.upsertStreamerDA({
        ...creds,
        status: 'need_reauth'
      });
      
      throw error;
    }
  }
  
  return creds;
}

// Fetch donations from DonationAlerts API с обработкой ошибок
async function fetchDonations(creds, cursorOrSince) {
  const streamerId = creds.streamer_twitch_id;
  
  // Проверяем backoff для этого стримера
  const backoffUntil = streamerBackoffUntil.get(streamerId);
  if (backoffUntil && Date.now() < backoffUntil) {
    const remaining = Math.ceil((backoffUntil - Date.now()) / 1000);
    console.log(`[DA Poll] Streamer ${streamerId} is in backoff, skipping (${remaining}s remaining)`);
    return [];
  }
  
  try {
    const params = { limit: 50 };
    if (cursorOrSince) {
      params.since = cursorOrSince;
    }
    
    const startTime = Date.now();
    const response = await axios.get('https://www.donationalerts.com/api/v1/alerts/donations', {
      headers: { 
        'Authorization': `Bearer ${creds.da_access_token}`,
        'Content-Type': 'application/json'
      },
      params,
      timeout: 10000 // 10 секунд таймаут
    });
    
    const responseTime = Date.now() - startTime;
    
    // Сбрасываем счетчик ошибок при успешном запросе
    streamerErrorCount.set(streamerId, 0);
    streamerBackoffUntil.delete(streamerId);
    
    const donations = response.data?.data || [];
    console.log(`[DA Poll] Fetched ${donations.length} donations for streamer ${streamerId} (${responseTime}ms)`);
    
    // Если ответ медленный - это может быть признак перегрузки API
    if (responseTime > RATE_LIMIT_RESPONSE_TIME_MS) {
      console.warn(`[DA Poll] Slow response for streamer ${streamerId}: ${responseTime}ms`);
    }
    
    return donations;
  } catch (error) {
    const errorCount = (streamerErrorCount.get(streamerId) || 0) + 1;
    streamerErrorCount.set(streamerId, errorCount);
    
    // Rate limit (429) или серверные ошибки (5xx)
    if (error.response?.status === 429 || (error.response?.status >= 500 && error.response?.status < 600)) {
      // Экспоненциальный backoff: 1s, 2s, 4s, 8s, 16s, 32s, 60s (макс)
      const backoffMs = Math.min(
        BACKOFF_MAX_MS,
        BACKOFF_BASE_MS * Math.pow(2, Math.min(errorCount - 1, 6))
      );
      const backoffUntilTime = Date.now() + backoffMs;
      streamerBackoffUntil.set(streamerId, backoffUntilTime);
      
      console.warn(`[DA Poll] Rate limit/server error for streamer ${streamerId}, backing off for ${backoffMs}ms (error count: ${errorCount})`);
      return [];
    }
    
    // Неавторизован (401)
    if (error.response?.status === 401) {
      console.error(`[DA Poll] Unauthorized for streamer ${streamerId}, marking for reauth`);
      await db.upsertStreamerDA({
        ...creds,
        status: 'need_reauth'
      });
      streamerErrorCount.set(streamerId, 0); // Сбрасываем счетчик
      return [];
    }
    
    // Другие ошибки - логируем, но не применяем backoff
    console.error(`[DA Poll] Error fetching donations for streamer ${streamerId}:`, error.response?.status || error.message);
    
    // Если слишком много ошибок подряд - применяем небольшой backoff
    if (errorCount >= 5) {
      const backoffMs = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * errorCount);
      streamerBackoffUntil.set(streamerId, Date.now() + backoffMs);
      console.warn(`[DA Poll] Too many errors for streamer ${streamerId}, backing off for ${backoffMs}ms`);
    }
    
    throw error;
  }
}

// Process individual donation
async function processDonation(streamerId, donation) {
  try {
    // Проверяем идемпотентность
    const alreadyProcessed = await db.isDonationProcessed(streamerId, String(donation.id));
    if (alreadyProcessed) {
      console.log(`[DA Poll] Donation ${donation.id} already processed for streamer ${streamerId}`);
      return;
    }

    // Отмечаем как обработанный
    await db.markDonationProcessed(streamerId, String(donation.id));
    
    console.log(`[DA Poll] Processing donation ${donation.id} from ${donation.username}: ${donation.amount} ${donation.currency}`);
    
    // Матчинг пользователя
    let user = null;
    
    // Сначала ищем по da_user_id
    if (donation.user_id) {
      user = await db.findUserByDAUserId(String(donation.user_id));
      if (user) {
        console.log(`[DA Poll] Matched user by da_user_id: ${user.twitch_user_id} (${user.display_name})`);
      }
    }
    
    // Fallback по нормализованному нику
    if (!user && donation.username) {
      try {
        user = await db.findUserByNormalizedLogin(donation.username);
        if (user) {
          console.log(`[DA Poll] Matched user by normalized username: ${user.twitch_user_id} (${user.display_name})`);
        }
      } catch (error) {
        console.error(`[DA Poll] Error finding user by normalized login "${donation.username}":`, error.message);
      }
    }
    
    if (!user) {
      console.log(`[DA Poll] No user found for donation from ${donation.username}`);
      return;
    }
    
    // Получаем аватар пользователя
    const avatar = await db.getAvatarByTwitchId(user.twitch_user_id);
    if (!avatar) {
      console.log(`[DA Poll] No avatar found for user ${user.twitch_user_id}`);
      return;
    }
    
    // Добавляем пользователя в список стримера (как в команде !start)
    try {
      const success = await db.addUserToStreamer(user.twitch_user_id, streamerId);
      console.log(`[DA Poll] Added user ${user.twitch_user_id} to streamer ${streamerId}: ${success ? 'success' : 'failed'}`);
    } catch (error) {
      console.error(`[DA Poll] Error adding user to streamer: ${error.message}`);
    }
    
    // Создаем spawnData аналогично команде !start
    const spawnData = {
      userId: user.twitch_user_id,
      displayName: user.display_name || donation.username || 'Donator',
      color: null, // DonationAlerts не предоставляет цвет
      avatarData: avatar,
      ts: Date.now(),
      source: 'donationalerts',
      amount: Number(donation.amount),
      message: donation.message || '',
      da_username: donation.username || null,
      currency: donation.currency || 'RUB'
    };
    
    // Эмитим avatar:show событие (убрали spawn для избежания двойного спауна)
    emitToStreamer(streamerId, 'avatar:show', {
      streamerId: streamerId,
      twitchUserId: user.twitch_user_id,
      displayName: user.display_name || donation.username || 'Donator',
      color: null,
      avatarData: avatar,
      source: 'donationalerts',
      amount: Number(donation.amount),
      message: donation.message || '',
      da_username: donation.username || null,
      currency: donation.currency || 'RUB'
    });
    
    // Добавляем аватар в активный список ПОСЛЕ отправки событий
    const { addActiveAvatar, removeActiveAvatar } = require('../services/bot');
    try {
      await addActiveAvatar(streamerId, user.twitch_user_id);
      console.log(`[DA Poll] Added avatar ${user.twitch_user_id} to active list for chat monitoring`);
      
      // Автоматически удаляем аватар из активного списка через 5 минут
      setTimeout(async () => {
        try {
          await removeActiveAvatar(streamerId, user.twitch_user_id);
          console.log(`[DA Poll] Auto-removed avatar ${user.twitch_user_id} from active list after timeout`);
        } catch (err) {
          console.error(`[DA Poll] Error auto-removing avatar from active list: ${err.message}`);
        }
      }, 5 * 60 * 1000);
      
    } catch (error) {
      console.error(`[DA Poll] Error adding avatar to active list: ${error.message}`);
    }
    
    console.log(`[DA Poll] Emitted avatar:show for streamer ${streamerId}, user ${user.twitch_user_id} (${user.display_name})`);
    
  } catch (error) {
    console.error(`[DA Poll] Error processing donation ${donation.id}:`, error);
  }
}

// Poll donations for a specific streamer
async function pollStreamer(streamerId) {
  try {
    const creds = await db.getStreamerDA(streamerId);
    if (!creds || creds.status !== 'active') {
      return;
    }
    
    // Обновляем токен если нужно
    const updatedCreds = await refreshIfNeeded(creds);
    
    // Получаем донаты
    const donations = await fetchDonations(updatedCreds);

    // Обрабатываем каждый донат
    for (const donation of donations) {
      await processDonation(streamerId, donation);
    }
    
  } catch (error) {
    console.error(`[DA Poll] Error polling streamer ${streamerId}:`, error.message);
  }
}

// Legacy function removed - use startPolling instead

// Stop polling (for graceful shutdown)
let pollingInterval = null;
const scheduledTimeouts = new Set();

async function enqueuePoll(streamerId) {
  const redlock = await getRedlock();
  const resource = `locks:donationalerts:${streamerId}`;

  try {
    // Используем правильный API redlock.lock вместо acquire
    const lock = await redlock.lock(resource, POLL_LOCK_TTL_MS);

    await pollQueue.add(async () => {
      const end = donationPollDuration.startTimer({ streamer: streamerId });
      try {
        await pollStreamer(streamerId);
      } catch (error) {
        donationPollErrors.inc({ type: error?.name || 'unknown' });
        throw error;
      } finally {
        end();
        refreshQueueMetrics();
        try {
          // Используем unlock вместо release
          await lock.unlock();
        } catch (error) {
          console.error(`[DA Poll] Failed to release lock for streamer ${streamerId}`, error);
        }
      }
    });
    refreshQueueMetrics();
  } catch (error) {
    if (error instanceof LockError) {
      console.debug(`[DA Poll] Lock already held for streamer ${streamerId}, skipping this cycle`);
    } else {
      console.error(`[DA Poll] Failed to acquire lock for streamer ${streamerId}`, error);
    }
  }
}

// Динамически масштабируемые параметры поллинга
function calculateDynamicConcurrency(streamerCount) {
  // Базовая формула: 4 воркера на 10 стримеров, минимум 2, максимум 50
  const base = Math.ceil(streamerCount / 10 * 4);
  return Math.max(2, Math.min(50, base));
}

function calculateOptimalInterval(streamerCount, concurrency) {
  // Динамический интервал в зависимости от количества стримеров
  // Каждый опрос должен занимать не более 80% интервала
  const avgTimePerStreamer = 1000; // ~1 секунда на стримера
  const estimatedCycleTime = (streamerCount / concurrency) * avgTimePerStreamer;
  
  // Минимальный интервал 3 секунды, оптимальный - в 2 раза больше времени цикла
  const optimalInterval = Math.max(POLL_MIN_INTERVAL_MS, estimatedCycleTime * 2);
  
  return Math.min(optimalInterval, 30000); // Максимум 30 секунд
}

let lastCycleMetrics = {
  streamerCount: 0,
  actualConcurrency: POLL_CONCURRENCY,
  actualInterval: POLL_INTERVAL_MS,
  cycleTime: 0,
  lastUpdate: Date.now()
};

function startPolling() {
  if (pollingInterval) {
    clearTimeout(pollingInterval);
  }

  const scheduleCycle = async () => {
    const cycleStartTime = Date.now();
    
    try {
      const streamers = await db.getAllStreamers() || [];
      refreshQueueMetrics();
      if (streamers.length === 0) {
        console.debug('[DA Poll] No streamers registered for polling cycle');
        return;
      }

      // Динамически пересчитываем параметры
      const dynamicConcurrency = calculateDynamicConcurrency(streamers.length);
      const dynamicInterval = calculateOptimalInterval(streamers.length, dynamicConcurrency);
      
      // Обновляем метрики
      lastCycleMetrics = {
        streamerCount: streamers.length,
        actualConcurrency: dynamicConcurrency,
        actualInterval: dynamicInterval,
        lastUpdate: Date.now()
      };
      
      // Логируем изменения параметров
      if (lastCycleMetrics.actualConcurrency !== POLL_CONCURRENCY || 
          lastCycleMetrics.actualInterval !== POLL_INTERVAL_MS) {
        console.log(`[DA Poll] Dynamic scaling: ${streamers.length} streamers, ` +
          `concurrency=${dynamicConcurrency}, interval=${dynamicInterval}ms`);
      }
      
      // Обновляем concurrency очереди
      pollQueue.concurrency = dynamicConcurrency;

      // Распределяем опросы равномерно по времени интервала
      const jitterBase = Math.max(100, Math.floor(dynamicInterval / Math.max(streamers.length, 1)));
      const staggerDelay = Math.min(jitterBase, 500); // Максимум 500ms между запросами

      streamers.forEach((streamer, index) => {
        const delay = index * staggerDelay;
        const timeoutId = setTimeout(() => {
          scheduledTimeouts.delete(timeoutId);
          enqueuePoll(streamer.streamer_twitch_id).catch((error) => {
            console.error(`[DA Poll] Failed to enqueue poll for streamer ${streamer.streamer_twitch_id}`, error);
          });
        }, delay);
        scheduledTimeouts.add(timeoutId);
      });
      
      // Вычисляем время выполнения цикла
      const cycleTime = Date.now() - cycleStartTime;
      lastCycleMetrics.cycleTime = cycleTime;
      
      // Предупреждение если цикл занимает слишком много времени
      const maxCycleTime = dynamicInterval * 0.8;
      if (cycleTime > maxCycleTime) {
        console.warn(`[DA Poll] Cycle took ${cycleTime}ms (${Math.round(cycleTime / dynamicInterval * 100)}% of interval). ` +
          `Consider increasing concurrency or interval.`);
      }
    } catch (error) {
      console.error('[DA Poll] Error in polling cycle:', error);
    }
  };

  const runLoop = async () => {
    try {
      await scheduleCycle();
    } catch (error) {
      console.error('[DA Poll] Unhandled error in polling loop', error);
    } finally {
      const delay = Math.max(POLL_MIN_INTERVAL_MS, lastCycleMetrics.actualInterval || POLL_INTERVAL_MS);
      pollingInterval = setTimeout(runLoop, delay);
    }
  };

  runLoop().catch((error) => {
    console.error('[DA Poll] Failed to start polling loop', error);
  });
}

// Экспорт метрик для мониторинга
function getPollingMetrics() {
  return {
    ...lastCycleMetrics,
    queueSize: pollQueue.size,
    pending: pollQueue.pending
  };
}

function stopPolling() {
  if (pollingInterval) {
    clearTimeout(pollingInterval);
    pollingInterval = null;
    console.log('[DA Poll] Polling stopped');
  }
  for (const timeoutId of scheduledTimeouts) {
    clearTimeout(timeoutId);
  }
  scheduledTimeouts.clear();
  pollQueue.clear();
}

setDonationPollMetricsProvider(() => getPollingMetrics());

module.exports = { 
  startPolling,
  stopPolling,
  processDonation,
  pollStreamer,
  refreshIfNeeded,
  fetchDonations,
  getPollingMetrics
};
