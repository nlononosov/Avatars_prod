const tmi = require('tmi.js');
const { logLine } = require('../lib/logger');
const { getUserByTwitchId, saveOrUpdateAvatar, getAvatarByTwitchId, saveOrUpdateUser, addUserToStreamer } = require('../db');
const { emit, emitToStreamer, getSubscriberCount, getStreamerSubscriberCount } = require('../lib/bus');
const { CLIENT_ID, CLIENT_SECRET } = require('../lib/config');

// ==================== MULTI-BOT MANAGER ====================
// Хранилище всех активных ботов по streamer_id
const botClients = new Map(); // streamerId -> { client, profile, ready, states, interval }

function normalizeChannel(ch) {
  if (!ch) return ch;
  return ch.startsWith('#') ? ch : `#${ch}`;
}

// Получить или создать состояние для стримера
function getStreamerState(streamerId) {
  if (!botClients.has(streamerId)) {
    botClients.set(streamerId, {
      activeAvatars: new Set(),
      avatarLastActivity: new Map(),
      avatarStates: new Map(),
      avatarTimeoutInterval: null,
      avatarTimeoutSeconds: 300,
      raceState: {
        isActive: false,
        participants: new Set(),
        participantNames: new Map(),
        positions: new Map(),
        speeds: new Map(),
        modifiers: new Map(),
        maxParticipants: 10,
        countdown: 0,
        raceStarted: false,
        raceFinished: false,
        winner: null,
        speedModifiers: new Map(),
        startTime: null
      },
      foodGameState: {
        isActive: false,
        participants: new Set(),
        participantNames: new Map(),
        scores: new Map(),
        directions: new Map(),
        speedModifiers: new Map(),
        carrots: [],
        gameStarted: false,
        gameFinished: false,
        startTime: null,
        winner: null
      },
      racePlanState: {
        isActive: false,
        participants: new Set(),
        participantNames: new Map(),
        positions: new Map(),
        levels: new Map(),
        lives: new Map(),
        obstacles: [],
        gameStarted: false,
        gameFinished: false,
        startTime: null,
        winner: null,
        maxParticipants: 8,
        trackWidth: 1200
      },
      Game: {
        isActive: false,
        gameFinished: false,
        players: new Map(),
        obstacles: [],
        lanes: [0, 1, 2],
        maxLives: 3
      }
    });
  }
  return botClients.get(streamerId);
}

function getPlaneGameState(streamerId) {
  const state = getStreamerState(streamerId);
  return {
    racePlanState: state.racePlanState,
    Game: state.Game
  };
}
// ==================== END MULTI-BOT MANAGER ====================

// Помощник для отправки событий в канал стримера
function emitOverlay(event, payload, channel, streamerId) {
  if (streamerId) {
    // Normalize streamerId to string for consistent matching
    emitToStreamer(String(streamerId), event, payload);
  } else {
    emit(event, payload);
  }
}

// Функция для обновления тайминга удаления аватаров (для конкретного стримера)
function setAvatarTimeoutSeconds(streamerId, seconds) {
  const state = getStreamerState(streamerId);
  const oldTimeout = state.avatarTimeoutSeconds;
  state.avatarTimeoutSeconds = seconds;
  logLine(`[bot] Avatar timeout updated from ${oldTimeout}s to ${seconds}s for streamer ${streamerId}`);
  
  // Перезапускаем интервал с новым таймингом
  if (state.avatarTimeoutInterval) {
    clearInterval(state.avatarTimeoutInterval);
  }
  startAvatarTimeoutChecker(streamerId);
}

// Функция для запуска проверки неактивных аватаров
function startAvatarTimeoutChecker(streamerId) {
  const state = getStreamerState(streamerId);
  if (state.avatarTimeoutInterval) {
    clearInterval(state.avatarTimeoutInterval);
  }
  
  // Проверяем чаще: раз в секунду, либо динамически от таймаута
  const period = Math.max(1000, Math.min(10000, Math.floor(state.avatarTimeoutSeconds * 1000 / 4)));
  state.avatarTimeoutInterval = setInterval(() => checkInactiveAvatars(streamerId), period);
  
  // Мгновенно проверить один раз при старте
  checkInactiveAvatars(streamerId);
  
  logLine(`[bot] Started avatar timeout checker (timeout=${state.avatarTimeoutSeconds}s, period=${period}ms) for streamer ${streamerId}`);
}

// Функция для проверки и удаления неактивных аватаров
function checkInactiveAvatars(streamerId) {
  const state = getStreamerState(streamerId);
  const now = Date.now();
  
  // Загружаем актуальные настройки из БД для текущего стримера
  let currentTimeoutSeconds = state.avatarTimeoutSeconds;
  try {
    const { getAvatarTimeoutSeconds } = require('../db');
    const dbTimeout = getAvatarTimeoutSeconds(streamerId);
    if (dbTimeout) {
      currentTimeoutSeconds = dbTimeout;
      if (dbTimeout !== state.avatarTimeoutSeconds) {
        state.avatarTimeoutSeconds = dbTimeout;
      }
    }
  } catch (error) {
    logLine(`[bot] Error loading timeout from DB: ${error.message}`);
  }
  
  const timeoutMs = currentTimeoutSeconds * 1000;
  const tiredTimeoutMs = timeoutMs / 2;
  const inactiveUsers = [];
  const tiredUsers = [];
  
  const botData = botClients.get(streamerId);
  if (!botData || !botData.client) return;
  
  for (const [userId, lastActivity] of state.avatarLastActivity.entries()) {
    const timeSinceActivity = now - lastActivity;
    
    if (timeSinceActivity > timeoutMs) {
      inactiveUsers.push(userId);
    } else if (timeSinceActivity > tiredTimeoutMs) {
      const currentState = state.avatarStates.get(userId);
      if (currentState !== 'tired') {
        tiredUsers.push(userId);
      }
    }
  }
  
  if (tiredUsers.length > 0) {
    for (const userId of tiredUsers) {
      state.avatarStates.set(userId, 'tired');
      emitOverlay('avatarStateChanged', { userId, state: 'tired' }, null, streamerId);
    }
  }
  
  if (inactiveUsers.length > 0) {
    for (const userId of inactiveUsers) {
      state.activeAvatars.delete(userId);
      state.avatarLastActivity.delete(userId);
      state.avatarStates.delete(userId);
      // Удаляем из Redis асинхронно
      removeActiveAvatar(streamerId, userId).catch(err => {
        logLine(`[bot] Failed to remove active avatar from Redis: ${err.message}`);
      });
      emitOverlay('avatarRemoved', { userId }, null, streamerId);
    }
  }
}

// Функция для обновления активности аватара
function updateAvatarActivity(streamerId, userId) {
  const state = getStreamerState(streamerId);
  const previousState = state.avatarStates.get(userId);
  state.avatarLastActivity.set(userId, Date.now());
  
  // Добавляем только если еще не добавлен (для производительности избегаем лишних вызовов)
  if (!state.activeAvatars.has(userId)) {
    state.activeAvatars.add(userId);
    // Синхронизируем с Redis асинхронно (fire-and-forget для производительности)
    addActiveAvatar(streamerId, userId).catch(err => {
      logLine(`[bot] Failed to sync active avatar: ${err.message}`);
    });
  }
  
  if (previousState === 'tired') {
    state.avatarStates.set(userId, 'normal');
    emitOverlay('avatarStateChanged', { userId, state: 'normal' }, null, streamerId);
  } else if (!previousState) {
    state.avatarStates.set(userId, 'normal');
  }
}

// Функция для получения текущего тайминга
function getAvatarTimeoutSeconds(streamerId) {
  const state = getStreamerState(streamerId);
  return state.avatarTimeoutSeconds;
}

async function refreshToken(profile) {
  if (!profile.refresh_token) {
    throw new Error('No refresh token available');
  }

  try {
    const tokenParams = new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: profile.refresh_token
    });

    const tokenResp = await fetch('https://id.twitch.tv/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: tokenParams.toString()
    });

    if (!tokenResp.ok) {
      const txt = await tokenResp.text();
      throw new Error(`Token refresh failed: ${tokenResp.status} ${txt}`);
    }

    const tokenData = await tokenResp.json();
    const expiresAt = tokenData.expires_in ? Math.floor(Date.now() / 1000) + Number(tokenData.expires_in) : null;

    // Update user with new tokens
    saveOrUpdateUser({
      twitch_user_id: profile.twitch_user_id,
      display_name: profile.display_name,
      login: profile.login,
      profile_image_url: profile.profile_image_url,
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token || profile.refresh_token,
      scope: tokenData.scope || profile.scope,
      expires_at: expiresAt
    });

    return {
      ...profile,
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token || profile.refresh_token,
      expires_at: expiresAt
    };
  } catch (error) {
    logLine(`[bot] token refresh error: ${error.message}`);
    throw error;
  }
}

async function ensureBotFor(uid) {
  // Проверяем, есть ли уже бот для этого стримера локально
  if (botClients.has(uid) && botClients.get(uid).client) {
    const botData = botClients.get(uid);
    logLine(`[bot] Already connected for user ${uid}`);
    return { profile: botData.profile, client: botData.client };
  }

  // Проверяем в Redis, не запущен ли бот в другом процессе
  const { stateManager } = require('../lib/state-redis');
  const botState = await stateManager.getBotState(uid);
  const currentProcessId = String(process.pid);
  
  if (botState && botState.active && botState.ownerProcessId) {
    // Проверяем, является ли текущий процесс владельцем
    const ownerProcessId = String(botState.ownerProcessId);
    if (ownerProcessId && !ownerProcessId.startsWith(currentProcessId)) {
      // Бот действительно запущен в другом процессе
      logLine(`[bot] Bot for streamer ${uid} is already active in another process ${ownerProcessId}, skipping creation`);
      throw new Error(`Bot is already active in another process`);
    } else {
      // Бот был в этом же процессе, но упал - очищаем старое состояние
      logLine(`[bot] Bot state found for current process, but bot is not running locally. Clearing old state...`);
      await stateManager.deleteBotState(uid).catch(err => {
        logLine(`[bot] Failed to clear old bot state: ${err.message}`);
      });
    }
  }

  // Используем распределенную блокировку для создания бота
  const Redlock = require('redlock');
  const { getClient } = require('../lib/redis');
  const redisClient = await getClient();
  const redlock = new Redlock([redisClient], {
    driftFactor: 0.01,
    retryCount: 3,
    retryDelay: 200,
    retryJitter: 100,
  });

  const lockKey = `lock:bot:create:${uid}`;
  const lockTTL = 10000; // 10 секунд на создание бота

  let lock;
  try {
    lock = await redlock.acquire([lockKey], lockTTL);
    logLine(`[bot] Acquired lock for bot creation: ${uid}`);
    
    // Повторная проверка после получения блокировки (double-check)
    const recheckBotState = await stateManager.getBotState(uid);
    if (recheckBotState && recheckBotState.active && recheckBotState.ownerProcessId) {
      logLine(`[bot] Bot for streamer ${uid} was created by another process while waiting for lock`);
      await lock.unlock();
      throw new Error(`Bot is already active in another process`);
    }

    let profile = getUserByTwitchId(uid);
    if (!profile) {
      await lock.unlock();
      throw new Error('User not found in DB');
    }

    // Check if token is expired and refresh if needed
    if (profile.expires_at && Date.now() / 1000 > profile.expires_at) {
      logLine(`[bot] Token expired for user ${uid}, refreshing...`);
      try {
        profile = await refreshToken(profile);
      } catch (error) {
        await lock.unlock();
        throw new Error(`Token refresh failed: ${error.message}`);
      }
    }

    const client = new tmi.Client({
    options: { debug: false },
    connection: { secure: true, reconnect: true },
    identity: { username: profile.login, password: `oauth:${profile.access_token}` },
    channels: [ profile.login ]
  });

  const states = getStreamerState(uid);
  let avatarShowHandler = null;
  let connectionResolver = null;
  let connectionRejector = null;
  
  // Создаем Promise для ожидания подключения
  const connectionPromise = new Promise((resolve, reject) => {
    connectionResolver = resolve;
    connectionRejector = reject;
  });
  
  client.on('connected', async (addr, port) => {
    logLine(`[bot] connected to ${addr}:${port} → #${profile.login} for streamer ${uid}`);
    const processId = `${process.pid}-${Date.now()}`;
    botClients.set(uid, { client, profile, ready: true, processId, ...states });
    
    // Загружаем настройки тайминга из БД
    try {
      const { getAvatarTimeoutSeconds } = require('../db');
      const dbTimeout = getAvatarTimeoutSeconds(uid);
      if (dbTimeout && dbTimeout !== states.avatarTimeoutSeconds) {
        states.avatarTimeoutSeconds = dbTimeout;
        logLine(`[bot] Loaded avatar timeout from DB: ${dbTimeout} seconds`);
      }
    } catch (error) {
      logLine(`[bot] Error loading timeout from DB: ${error.message}`);
    }
    
    // Сохраняем состояние бота в Redis с указанием владельца процесса
    await saveBotStateToRedis(uid, processId).catch(err => {
      logLine(`[bot] Failed to save bot state to Redis: ${err.message}`);
    });
    
    // Освобождаем блокировку после успешного создания
    if (lock) {
      await lock.unlock().catch(err => {
        logLine(`[bot] Failed to unlock: ${err.message}`);
      });
    }
    
    startAvatarTimeoutChecker(uid);
    
    // Подписываемся на события bus для отслеживания аватаров из донатов
    const { on } = require('../lib/bus');
    avatarShowHandler = (data) => {
      if (data.streamerId === uid && data.twitchUserId) {
        logLine(`[bot] Avatar shown via donation for user ${data.twitchUserId}`);
        updateAvatarActivity(uid, data.twitchUserId);
      }
    };
    on('avatar:show', avatarShowHandler);
    
    // Разрешаем промис подключения
    if (connectionResolver) {
      connectionResolver({ profile, client });
    }
  });
  client.on('disconnected', async (reason) => {
    logLine(`[bot] disconnected for streamer ${uid}: ${reason}`);
    if (botClients.has(uid)) {
      botClients.get(uid).ready = false;
    }
    // Очищаем состояние бота в Redis при отключении
    await stateManager.deleteBotState(uid).catch(err => {
      logLine(`[bot] Failed to delete bot state from Redis: ${err.message}`);
    });
    // Отписываемся от событий
    if (avatarShowHandler) {
      const { off } = require('../lib/bus');
      off('avatar:show', avatarShowHandler);
    }
  });
  client.on('notice', async (channel, msgid, message) => {
    if (msgid === 'login_unrecognized') {
      logLine(`[bot] authentication failed for streamer ${uid}: ${message}`);
      botClients.delete(uid);
      if (connectionRejector) {
        connectionRejector(new Error(`Login authentication failed: ${message}`));
      }
      // Очищаем состояние при ошибке аутентификации
      if (lock) {
        await lock.unlock().catch(() => {});
      }
      await stateManager.deleteBotState(uid).catch(() => {});
    }
  });
  client.on('message', (channel, tags, message, self) => {
    if (self) return;
    
    const botData = botClients.get(uid);
    if (!botData || !botData.ready) {
      return;
    }
    
    const text = message.trim().toLowerCase();
    const userId = tags['user-id'];
    const displayName = tags['display-name'] || tags.username;
    const color = tags['color'] || null;
    const isStreamer = tags['badges'] && (tags['badges'].broadcaster || tags['badges'].moderator);
    
    // Обновляем активность аватара при любом сообщении
    updateAvatarActivity(uid, userId);
    
    if (text === '!ping') {
      client.say(channel, 'pong').catch(err => logLine(`[bot] say error: ${err.message}`));
      return;
    }

    if (text === '!start') {
      // Ensure user exists in database first
      let user = getUserByTwitchId(userId);
      if (!user) {
        const userData = {
          twitch_user_id: userId,
          display_name: displayName,
          login: displayName.toLowerCase().replace(/\s+/g, ''),
          profile_image_url: null,
          access_token: 'chat_user',
          refresh_token: null,
          scope: null,
          expires_at: null
        };
        saveOrUpdateUser(userData);
      }
      
      // Load or create default avatar
      let avatarData = getAvatarByTwitchId(userId);
      if (!avatarData) {
        try {
          avatarData = {
            body_skin: 'body_skin_1',
            face_skin: 'face_skin_1', 
            clothes_type: 'clothes_type_1',
            others_type: 'others_1'
          };
          saveOrUpdateAvatar(userId, avatarData);
        } catch (error) {
          avatarData = {
            body_skin: 'body_skin_1',
            face_skin: 'face_skin_1', 
            clothes_type: 'clothes_type_1',
            others_type: 'others_1'
          };
        }
      }
      
      // Add user to streamer's chat list
      try {
        addUserToStreamer(userId, uid);
      } catch (error) {
        logLine(`[bot] Error adding user to streamer: ${error.message}`);
      }
      
      // Emit avatar:show event (normalize uid to string for consistent streamerId matching)
      emitToStreamer(String(uid), 'avatar:show', {
        streamerId: String(uid),
        twitchUserId: String(userId),
        displayName: displayName,
        color: color,
        avatarData,
        source: 'twitch_chat'
      });
      
      // Добавляем аватар асинхронно (fire-and-forget для производительности)
      addActiveAvatar(uid, userId).catch(err => {
        logLine(`[bot] Failed to add active avatar: ${err.message}`);
      });
      logLine(`[overlay] spawn requested by ${displayName} (${userId}) for streamer ${uid}`);
      return;
    }

    // Race command
    if (text === '!race') {
      if (states.raceState.isActive && !states.raceState.raceFinished) {
        client.say(channel, '🏁 Гонка уже идет! Дождитесь завершения.').catch(err => logLine(`[bot] say error: ${err.message}`));
        return;
      }
      startRace(uid, client, channel, states.raceState);
      return;
    }



    // Check for race participation
    if (text === '+' && states.raceState.isActive && !states.raceState.raceStarted) {
      joinRace(uid, userId, displayName, client, channel, states.raceState);
      return;
    }

    // Check for race cheering (mentions during race)
    if (states.raceState.isActive && states.raceState.raceStarted && !states.raceState.raceFinished) {
      checkRaceCheering(text, client, channel, states.raceState, uid);
    }

    // Check for food game registration
    if (text === '+' && states.foodGameState.isActive && !states.foodGameState.gameStarted) {
      joinFoodGame(uid, userId, displayName, client, channel);
      return;
    }

    // Check for food game commands
    if (states.foodGameState.isActive && states.foodGameState.gameStarted && !states.foodGameState.gameFinished) {
      checkFoodGameCommand(uid, text, userId, displayName, client, channel);
      checkFoodGameCheering(uid, text, client, channel);
    }

    // Race plan command
    if (text === '!race-plan') {
      if (states.racePlanState.isActive && !states.racePlanState.gameFinished) {
        client.say(channel, '✈️ Гонка на самолетах уже идет! Дождитесь завершения.').catch(err => logLine(`[bot] say error: ${err.message}`));
        return;
      }
      startRacePlan(uid, client, channel);
      return;
    }

    // Check for race plan registration
    if (text === '+' && states.racePlanState.isActive && !states.racePlanState.gameStarted) {
      joinRacePlan(uid, userId, displayName, client, channel);
      return;
    }

    // Check for race plan commands
    if (states.racePlanState.isActive && states.racePlanState.gameStarted && !states.racePlanState.gameFinished) {
      checkRacePlanCommand(uid, text, userId, displayName, client, channel);
      checkRacePlanCheering(uid, text, client, channel);
    }


    // смена полосы
    if (states.Game.isActive && !states.Game.gameFinished) {
      if (UP_WORDS.has(text)) {
        let p = states.Game.players.get(userId);
        if (!p) {
          p = { lane: 1, x: 50, width: 72, lives: 3, out: false, prevX: 50 };
          states.Game.players.set(userId, p);
        }
        const oldLane = p.lane ?? 1;
        p.lane = clampLane(oldLane - 1);
        emitLevelUpdate(uid, userId, p.lane, client, channel);
        return;
      }
      if (DOWN_WORDS.has(text)) {
        let p = states.Game.players.get(userId);
        if (!p) {
          p = { lane: 1, x: 50, width: 72, lives: 3, out: false, prevX: 50 };
          states.Game.players.set(userId, p);
        }
        const oldLane = p.lane ?? 1;
        p.lane = clampLane(oldLane + 1);
        emitLevelUpdate(uid, userId, p.lane, client, channel);
        return;
      }
    }

    // Если пользователь не активен в памяти — попробуем «лениво» восстановить
    if (!states.activeAvatars.has(userId)) {
      const avatarData = getAvatarByTwitchId(userId);
      if (avatarData) {
        // Добавляем аватар асинхронно (fire-and-forget для производительности)
        addActiveAvatar(uid, userId).catch(err => {
          logLine(`[bot] Failed to add active avatar: ${err.message}`);
        });
        emitOverlay('spawn', {
          userId,
          displayName,
          color,
          avatarData,
          ts: Date.now()
        }, channel, uid);
      }
    }

    // Приветствия: распознаём разумный набор, игнорируем пунктуацию в начале
    function isGreeting(s) {
      const t = String(s || '').toLowerCase().replace(/[.,!?:;()\[\]{}'"`«»]+/g, ' ').trim();
      // примеры: "привет", "привет всем", "здарова", "добрый вечер",
      // "hi", "hello there", "hey", "yo", "good morning", "howdy", "greetings"
      
      // Простые русские приветствия
      const russianGreetings = /^(привет(ик|ствую)?|здравствуй(те)?|здар(ова|овa|ов)|салют|хай|ку|добр(ое утро|ый день|ый вечер))/;
      // Английские приветствия
      const englishGreetings = /^(hi|hello|hey|yo|good (morning|afternoon|evening)|howdy|greetings)\b/;
      
      const russianOk = russianGreetings.test(t);
      const englishOk = englishGreetings.test(t);
      const ok = russianOk || englishOk;
      
      logLine(`[debug] isGreeting("${s}") → "${t}" → russian: ${russianOk}, english: ${englishOk}, final: ${ok}`);
      return ok;
    }
    
    // Проверяем приветствие
    const isGreetingResult = isGreeting(message);
    logLine(`[debug] Greeting check for "${message}": ${isGreetingResult}`);
    
    if (isGreetingResult) {
      emitOverlay('hi', { userId }, channel, uid);
      return;
    }

    // Смех: Unicode-регэксп с явными разделителями до/после ИЛИ концом строки
    // Покрывает: lol/lmao/rofl/kek/кек/ахаха/ахааа/хааа/хехе/хи-хи/хо-хо/ржу/орууу и варианты со знаками
    function isLaughing(s) {
      const t = String(s || '').toLowerCase().trim();
      
      // Простые слова смеха (точное совпадение)
      const simpleLaugh = /^(лол|лул|кек|ржу|lol|lmao|rofl|kek)$/;
      
      // Смех по первым буквам (независимо от длины)
      // ахах, ахахах, ахахахах - начинается с "ах"
      // хах, хахах, хахахах - начинается с "ха" 
      // хех, хехех, хехехех - начинается с "хе"
      // хих, хихих, хихихих - начинается с "хи"
      // хох, хохох, хохохох - начинается с "хо"
      // ор, орр, орру, оррууу - начинается с "ор"
      // ха, хаха, хахаха - начинается с "ха"
      const patternLaugh = /(^|[\s.,!?…:;()"'«»\-\[\]\\\/])(ах[ах]*|ха[ха]*|хе[хе]*|хи[хи]*|хо[хо]*|ор[ру]*|haha+|hehe+|hoho+)(?=$|[\s.,!?…:;()"'«»\-\[\]\\\/])/u;
      
      const simpleOk = simpleLaugh.test(t);
      const patternOk = patternLaugh.test(t);
      const ok = simpleOk || patternOk;
      
      logLine(`[debug] isLaughing("${s}") → "${t}" → simple: ${simpleOk}, pattern: ${patternOk}, final: ${ok}`);
      return ok;
    }
    
    if (isLaughing(message)) {
      emitOverlay('laugh', { userId }, channel, uid);
      return;
    }
    
    // 1) Эмоты Twitch приходят в tags.emotes как диапазоны "start-end"
    const emoteMap = tags?.emotes || {};
    const hasTwitchEmotes = Object.keys(emoteMap).length > 0;

    // Считаем, покрывают ли эмоты всё содержимое (игнорируя пробелы)
    const noSpaces = message.replace(/\s+/g, '');
    let emoteChars = 0;
    for (const ranges of Object.values(emoteMap)) {
      for (const range of ranges) {
        const [s, e] = range.split('-').map(Number);
        emoteChars += (e - s + 1);
      }
    }
    const emoteOnly = hasTwitchEmotes && emoteChars === noSpaces.length;

    // 2) Поддержка «чистых» Unicode-эмодзи (если Twitch их не пометил как emotes)
    const unicodeEmojiOnly =
      !hasTwitchEmotes &&
      /^[\p{Extended_Pictographic}\uFE0F\u200D\s]+$/u.test(message) &&
      /[\p{Extended_Pictographic}]/u.test(message);

    if (emoteOnly || unicodeEmojiOnly) {
      // Функция для извлечения URL первого эмодзи
      function extractFirstEmojiUrl(message, tags) {
        const emoteMap = (tags && (tags.emotes || tags['emotes'])) || {};
        if (Object.keys(emoteMap).length > 0) {
          const firstId = Object.keys(emoteMap)[0]; // ← ID смайлика
          // Twitch CDN: варианты размеров 1.0 / 2.0 / 3.0
          return `https://static-cdn.jtvnw.net/emoticons/v2/${firstId}/default/dark/3.0`;
        }
        // если это юникод-эмодзи, просто возвращаем сам символ
        return message.trim() || '🙂';
      }
      
      const emoji = extractFirstEmojiUrl(message, tags);
      emitOverlay('emoji', { userId, emoji }, channel, uid);
      return;
    }
    
    // No emotes found - normal movement
    const messageLength = message.length;
    const moveDistance = Math.min(messageLength * 8, 200);
    const direction = Math.random() > 0.5 ? 1 : -1;
    
    emitOverlay('move', {
      userId,
      distance: moveDistance * direction,
      messageLength
    }, channel, uid);
  });

    // Запускаем подключение
    await client.connect();
    
    // Устанавливаем таймаут для промиса подключения
    const timeout = setTimeout(() => {
      if (connectionRejector) {
        connectionRejector(new Error('Connection timeout'));
      }
    }, 10000);
    
    // Ожидаем успешного подключения или ошибки
    const result = await Promise.race([
      connectionPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Connection timeout')), 10000))
    ]);
    
    clearTimeout(timeout);
    return result;
  } catch (error) {
    if (error.name === 'LockError') {
      logLine(`[bot] Failed to acquire lock for bot creation: ${uid}, another process is creating the bot`);
      throw new Error(`Bot creation in progress by another process`);
    }
    logLine(`[bot] connection failed: ${error.message}`);
    botClients.delete(uid);
    // Освобождаем блокировку при ошибке
    if (lock) {
      await lock.unlock().catch(() => {});
    }
    // Очищаем состояние бота в Redis
    await stateManager.deleteBotState(uid).catch(() => {});
    throw error;
  }
}

async function stopBot(streamerId) {
  if (!streamerId) {
    // Stop all bots if no streamerId provided
    const promises = Array.from(botClients.keys()).map(id => stopBotForStreamer(id));
    await Promise.all(promises);
    return true;
  }
  return await stopBotForStreamer(streamerId);
}

async function stopBotForStreamer(streamerId) {
  if (!botClients.has(streamerId)) return false;
  
  const botData = botClients.get(streamerId);
  if (botData.client) {
    try {
      await botData.client.disconnect();
    } catch (error) {
      logLine(`[bot] error disconnecting bot for streamer ${streamerId}: ${error.message}`);
    }
  }
  
  if (botData.avatarTimeoutInterval) {
    clearInterval(botData.avatarTimeoutInterval);
  }
  
  botClients.delete(streamerId);
  logLine(`[bot] stopped for streamer ${streamerId}`);
  return true;
}

function status() {
  return { 
    running: botClients.size > 0,
    bot_count: botClients.size,
    bots: Array.from(botClients.entries()).map(([streamerId, data]) => ({
      streamerId,
      ready: data.ready,
      activeAvatars: Array.from(data.activeAvatars || [])
    }))
  };
}

// Функция для добавления аватара в активный список (для донатов)
async function addActiveAvatar(streamerId, userId) {
  const state = getStreamerState(streamerId);
  state.activeAvatars.add(userId);
  
  // Синхронизируем с Redis для всех процессов
  const { stateManager } = require('../lib/state-redis');
  await stateManager.addActiveAvatar(streamerId, userId).catch(err => {
    logLine(`[bot] Failed to sync active avatar to Redis: ${err.message}`);
  });
  
  logLine(`[bot] Added avatar ${userId} to active list for streamer ${streamerId}`);
}

// Функция для удаления аватара из активного списка
async function removeActiveAvatar(streamerId, userId) {
  const state = getStreamerState(streamerId);
  state.activeAvatars.delete(userId);
  
  // Синхронизируем с Redis для всех процессов
  const { stateManager } = require('../lib/state-redis');
  await stateManager.removeActiveAvatar(streamerId, userId).catch(err => {
    logLine(`[bot] Failed to sync active avatar removal to Redis: ${err.message}`);
  });
  
  logLine(`[bot] Removed avatar ${userId} from active list for streamer ${streamerId}`);
}

function getBotClientFor(streamerId) {
  if (!streamerId) return null;
  const botData = botClients.get(streamerId);
  return botData ? botData.client : null;
}

// Получить Twitch-канал ("#login") для конкретного стримера
function getBotChannelFor(streamerId) {
  try {
    const { getUserByTwitchId } = require('../db');
    const profile = getUserByTwitchId(streamerId);
    if (profile && profile.login) {
      return normalizeChannel(profile.login);
    }
    return null;
  } catch (_) {
    return null;
  }
}

// Доступ к состояниям стримера (гонки/игры)
// getStreamerState уже объявлена выше в менеджере ботов

// Race game functions
function startRace(streamerId, client, channel, raceState, settings = {}) {
  const { minParticipants = 1, maxParticipants = 10, registrationTime = 10 } = settings;
  
  // Prevent multiple race starts
  if (raceState.isActive && !raceState.raceFinished) {
    return;
  }
  
  if (raceState.isActive) {
    raceState.isActive = false;
    raceState.participants.clear();
    raceState.participantNames.clear();
    raceState.positions.clear();
    raceState.speeds.clear();
    raceState.modifiers.clear();
    raceState.speedModifiers.clear();
    raceState.winner = null;
    raceState.raceStarted = false;
    raceState.raceFinished = false;
    raceState.startTime = null;
    raceState.countdown = 0;
  }

  raceState.isActive = true;
  raceState.countdown = 0;
  raceState.raceStarted = false;
  raceState.raceFinished = false;
  raceState.winner = null;
  raceState.startTime = null;
  raceState.minParticipants = minParticipants;
  raceState.maxParticipants = maxParticipants;

  // Синхронизируем состояние игры с Redis
  const { stateManager } = require('../lib/state-redis');
  const gameStateForRedis = {
    isActive: raceState.isActive,
    participants: Array.from(raceState.participants),
    participantNames: Object.fromEntries(raceState.participantNames),
    positions: Object.fromEntries(raceState.positions),
    speeds: Object.fromEntries(raceState.speeds),
    speedModifiers: Object.fromEntries(raceState.speedModifiers),
    maxParticipants: raceState.maxParticipants,
    minParticipants: raceState.minParticipants,
    raceStarted: raceState.raceStarted,
    raceFinished: raceState.raceFinished,
    winner: raceState.winner,
    startTime: raceState.startTime,
    countdown: raceState.countdown
  };
  stateManager.setGameState(streamerId, 'race', gameStateForRedis).catch(err => {
    logLine(`[bot] Failed to sync race state to Redis: ${err.message}`);
  });

  client.say(channel, `🏁 Кто хочет участвовать в гонке, отправьте + в чат! У вас есть ${registrationTime} секунд! (${minParticipants}-${maxParticipants} участников)`).catch(err => logLine(`[bot] say error: ${err.message}`));
  
  setTimeout(() => {
    if (raceState.participants.size < minParticipants) {
      client.say(channel, `⏰ Время вышло! Недостаточно участников (${raceState.participants.size}/${minParticipants}). Гонка отменена.`).catch(err => logLine(`[bot] say error: ${err.message}`));
      raceState.isActive = false;
      return;
    }
    
    if (raceState.participants.size > maxParticipants) {
      const participantsArray = Array.from(raceState.participants);
      const selectedParticipants = participantsArray.slice(0, maxParticipants);
      raceState.participants.clear();
      raceState.participantNames.clear();
      selectedParticipants.forEach(participantId => {
        raceState.participants.add(participantId);
      });
      client.say(channel, `🎯 Слишком много участников! Выбраны первые ${maxParticipants} участников.`).catch(err => logLine(`[bot] say error: ${err.message}`));
    }
    
    startRaceCountdown(streamerId, client, channel, raceState);
  }, registrationTime * 1000);
}

function joinRace(streamerId, userId, displayName, client, channel, raceState) {
  if (raceState.participants.has(userId)) {
    return;
  }

  if (raceState.participants.size >= raceState.maxParticipants) {
    client.say(channel, `@${displayName} Гонка уже заполнена! Максимум ${raceState.maxParticipants} участников.`).catch(err => logLine(`[bot] say error: ${err.message}`));
    return;
  }

  raceState.participants.add(userId);
  raceState.participantNames.set(userId, displayName);
  client.say(channel, `@${displayName} присоединился к гонке! (${raceState.participants.size}/${raceState.maxParticipants})`).catch(err => logLine(`[bot] say error: ${err.message}`));

  if (raceState.participants.size >= raceState.maxParticipants) {
    setTimeout(() => startRaceCountdown(streamerId, client, channel, raceState), 1000);
  }
}

function startRaceCountdown(streamerId, client, channel, raceState) {
  if (!raceState.isActive) return;

  raceState.raceStarted = true;
  raceState.startTime = Date.now();

  // Emit race start event to overlay
  const raceStartData = {
    participants: Array.from(raceState.participants),
    countdown: 3
  };
  logLine(`[bot] Emitting raceStart event: ${JSON.stringify(raceStartData)}`);
  emitOverlay('raceStart', raceStartData, channel, streamerId);

  // Countdown
  let count = 3;
  const countdownInterval = setInterval(() => {
    if (count > 0) {
      client.say(channel, `🏁 ${count}...`).catch(err => logLine(`[bot] say error: ${err.message}`));
      count--;
    } else {
      clearInterval(countdownInterval);
      client.say(channel, '🏁 ГОНКА НАЧАЛАСЬ! Бегите к финишу!').catch(err => logLine(`[bot] say error: ${err.message}`));
      
      // Start race monitoring
      startRaceMonitoring(streamerId, client, channel, raceState);
    }
  }, 1000);
}

function startRaceMonitoring(streamerId, client, channel, raceState) {
  // Emit race monitoring start
  emitOverlay('raceMonitoring', {
    participants: Array.from(raceState.participants),
    speedModifiers: Object.fromEntries(raceState.speedModifiers)
  }, channel, streamerId);
}

function checkRaceCheering(text, client, channel, raceState, streamerId) {
  // Check if message mentions any race participant
  const participants = Array.from(raceState.participants);
  
  for (const participantId of participants) {
    // This is a simplified check - in real implementation you'd need to get display names
    // and check if they're mentioned in the message
    if (text.toLowerCase().includes('@') || text.includes('cheer') || text.includes('go')) {
      // Add speed modifier
      const currentModifier = raceState.speedModifiers.get(participantId) || 0;
      raceState.speedModifiers.set(participantId, currentModifier + 0.05); // 5% speed boost per cheer (уменьшено в 2 раза)
      
      // Emit speed update
      emitOverlay('raceSpeedUpdate', {
        participantId: participantId,
        speedModifier: raceState.speedModifiers.get(participantId)
      }, channel, streamerId);
      
      client.say(channel, `💨 Участник получил ускорение!`).catch(err => logLine(`[bot] say error: ${err.message}`));
      break;
    }
  }
}

function finishRace(winnerId, client, channel) {
  if (raceState.raceFinished) return;
  
  raceState.raceFinished = true;
  raceState.winner = winnerId;
  
  // Get winner's display name from participants
  const winnerName = raceState.participantNames.get(winnerId) || winnerId;
  
  // Синхронизируем завершение игры с Redis
  const { stateManager } = require('../lib/state-redis');
  const streamerId = Array.from(botClients.entries()).find(([id, data]) => data.client === client)?.[0];
  if (streamerId) {
    const gameStateForRedis = {
      isActive: raceState.isActive,
      participants: Array.from(raceState.participants),
      participantNames: Object.fromEntries(raceState.participantNames),
      positions: Object.fromEntries(raceState.positions),
      speeds: Object.fromEntries(raceState.speeds),
      speedModifiers: Object.fromEntries(raceState.speedModifiers),
      maxParticipants: raceState.maxParticipants,
      raceStarted: raceState.raceStarted,
      raceFinished: raceState.raceFinished,
      winner: raceState.winner,
      startTime: raceState.startTime
    };
    stateManager.setGameState(streamerId, 'race', gameStateForRedis).catch(err => {
      logLine(`[bot] Failed to sync race finish to Redis: ${err.message}`);
    });
  }
  
  // Emit race finish
  emitOverlay('raceFinish', {
    winner: winnerId,
    participants: Array.from(raceState.participants)
  }, channel);
  
  client.say(
    normalizeChannel(channel),
    `🏆 Гонка завершена! Поздравляем победителя @${winnerName}!`
  ).catch(err => logLine(`[bot] say error: ${err.message}`));
  
  // Reset race state after 5 seconds
  setTimeout(() => {
    raceState.isActive = false;
    raceState.participants.clear();
    raceState.participantNames.clear();
    raceState.speedModifiers.clear();
    raceState.raceStarted = false;
    raceState.raceFinished = false;
    raceState.winner = null;
    
    // Удаляем состояние игры из Redis после сброса
    if (streamerId) {
      stateManager.deleteGameState(streamerId, 'race').catch(err => {
        logLine(`[bot] Failed to delete race state from Redis: ${err.message}`);
      });
    }
  }, 5000);
}

function getBotClient() {
  for (const data of botClients.values()) {
    if (data.client) {
      return data.client;
    }
  }
  return null;
}

function getBotChannel() {
  for (const data of botClients.values()) {
    if (data?.profile?.login) {
      return normalizeChannel(data.profile.login);
    }
  }
  return null;
}

// === Константы команд ===
const UP_WORDS  = new Set(['верх','вверх','up','u','w','↑']);
const DOWN_WORDS= new Set(['низ','вниз','down','d','s','↓']);

// === Константы для препятствий ===
const LANES = [0,1,2]; // 0=верх, 1=центр, 2=низ
const OBSTACLE_TYPES = ['bird', 'plane', 'rock'];

function randInt(min, max) { 
  return min + Math.floor(Math.random() * (max - min + 1)); 
}

function sweptPass(prevX, currX, c2, halfSum) {
  // пересёк ли отрезок [prevX, currX] горизонтальный интервал [c2 - halfSum, c2 + halfSum]
  const minX = Math.min(prevX, currX);
  const maxX = Math.max(prevX, currX);
  return !(maxX < c2 - halfSum || minX > c2 + halfSum);
}

// Метрики хитбокса аватаров (половины размеров, поступают с клиента)
const AvatarMetrics = new Map(); // userId -> { halfW, halfH }

// Вспомогательно
function clampLane(l) { return Math.max(0, Math.min(2, l|0)); }

function setAvatarMetrics(userId, halfW, halfH) {
  AvatarMetrics.set(userId, { halfW, halfH });
}
function emitLevelUpdate(streamerId, userId, level, client, channel) {
  const { racePlanState } = getPlaneGameState(streamerId);
  racePlanState.levels.set(userId, level);
  emitOverlay('racePlanLevelUpdate', { userId, level }, channel, streamerId);
}

function spawnGameObstacle(streamerId, channel) {
  const { Game, racePlanState } = getPlaneGameState(streamerId);
  if (!Game.isActive || Game.gameFinished) return;
  
  const id = `obs_${Date.now()}_${Math.random().toString(16).slice(2, 6)}`;
  const lane = LANES[randInt(0, 2)];
  const speed = randInt(6, 10);
  const xStart = 1200;
  const width = 80;
  const type = OBSTACLE_TYPES[randInt(0, OBSTACLE_TYPES.length - 1)];

  const obs = { id, lane, x: xStart, speed, width, hit: false, type };
  Game.obstacles.push(obs);
  racePlanState.obstacles.push(obs);

  logLine(`[bot] Spawning obstacle ${id} in lane ${lane} (type: ${type}) for streamer ${streamerId}`);

  emitOverlay('racePlanObstacleSpawn', { id, lane, x: xStart, type }, channel, streamerId);
}



function serverTick(streamerId) {
  const { racePlanState, Game } = getPlaneGameState(streamerId);
  logLine(`[bot] serverTick called for streamer ${streamerId}: Game.isActive=${Game.isActive}, Game.gameFinished=${Game.gameFinished}`);
  if (!Game.isActive || Game.gameFinished) {
    logLine(`[bot] serverTick early return due to flags for streamer ${streamerId}`);
    return;
  }

  const now = Date.now();
  const lastTs = Game.lastTickTs || now;
  const dt = Math.min(200, now - lastTs);
  Game.lastTickTs = now;

  logLine(`[bot] serverTick for streamer ${streamerId}: dt=${dt}ms, players=${Game.players.size}, obstacles=${Game.obstacles.length}`);

  const AVATAR_SPEED = 20;
  const OBSTACLE_SPEED = 180;

  Game.players.forEach((p, id) => {
    if (p.out || p.lives <= 0) return;
    p.prevX = p.x;
    p.x += AVATAR_SPEED * (dt / 1000);
    logLine(`[bot] Player ${id} moved: x=${p.x.toFixed(1)} (streamer ${streamerId})`);
  });

  maybeSpawnObstacle(streamerId, now);

  Game.obstacles.forEach(o => {
    o.x -= OBSTACLE_SPEED * (dt / 1000);
  });

  handleGameCollisions(streamerId);
  checkFinishLine(streamerId);

  Game.obstacles = Game.obstacles.filter(o => o.x + (o.width ?? 80) > 0);

  broadcastState(streamerId);
}

function checkFinishLine(streamerId) {
  const { racePlanState, Game } = getPlaneGameState(streamerId);
  if (Game.gameFinished) return;

  const FINISH_LINE = racePlanState.trackWidth - 50;
  let alivePlayers = 0;
  let winner = null;
  let maxX = 0;

  Game.players.forEach((p, id) => {
    if (p.out || p.lives <= 0) return;

    alivePlayers++;

    const avatarWidth = 40;
    if (p.x + avatarWidth >= FINISH_LINE) {
      if (!winner || p.x > maxX) {
        winner = id;
        maxX = p.x;
      }
    }
  });

  const client = getBotClientFor(streamerId);
  const channel = getBotChannelFor(streamerId);

  if (alivePlayers === 0) {
    Game.gameFinished = true;
    Game.isActive = false;

    logLine(`[bot] Game finished without winners for streamer ${streamerId}`);

    emitOverlay('racePlanEnd', {
      winner: null,
      winnerName: null,
      noWinners: true,
      finalLives: Object.fromEntries(racePlanState.lives)
    }, channel, streamerId);

    if (client && channel) {
      client.say(channel, `💀 Гонка завершена! Победителей нет - все игроки выбыли!`).catch(err => logLine(`[bot] say error: ${err.message}`));
    }

    setTimeout(() => {
      resetGameState(streamerId);
    }, 5000);
    return;
  }

  if (winner) {
    Game.gameFinished = true;
    Game.isActive = false;

    const winnerName = racePlanState.participantNames.get(winner) || 'Unknown';

    logLine(`[bot] Game finished! Winner: ${winnerName} (${winner}) at x:${maxX.toFixed(1)} for streamer ${streamerId}`);

    emitOverlay('racePlanEnd', {
      winner,
      winnerName,
      noWinners: false,
      finalLives: Object.fromEntries(racePlanState.lives)
    }, channel, streamerId);

    if (client && channel) {
      client.say(channel, `🏆 Гонка завершена! Победитель: @${winnerName}!`).catch(err => logLine(`[bot] say error: ${err.message}`));
    }

    setTimeout(() => {
      resetGameState(streamerId);
    }, 5000);
  }
}

function resetGameState(streamerId) {
  const { racePlanState, Game } = getPlaneGameState(streamerId);
  Game.isActive = false;
  Game.gameFinished = false;
  Game.players.clear();
  Game.obstacles = [];
  Game.nextObstacleTs = null;
  Game.lastTickTs = null;

  racePlanState.isActive = false;
  racePlanState.gameFinished = true;
  racePlanState.participants.clear();
  racePlanState.participantNames.clear();
  racePlanState.positions.clear();
  racePlanState.levels.clear();
  racePlanState.lives.clear();
  racePlanState.obstacles = [];
  racePlanState.winner = null;

  logLine(`[bot] Game state reset after finish for streamer ${streamerId}`);
}

function maybeSpawnObstacle(streamerId, now) {
  const { Game } = getPlaneGameState(streamerId);
  if (!Game.nextObstacleTs) Game.nextObstacleTs = now;
  if (now < Game.nextObstacleTs) return;

  const channel = getBotChannelFor(streamerId);
  if (channel) {
    spawnGameObstacle(streamerId, channel);
  }
  Game.nextObstacleTs = now + 1600;
}

function sweptOverlap1D(x0, x1, cx2, halfSum) {
  const minX = Math.min(x0, x1);
  const maxX = Math.max(x0, x1);
  return !(maxX < cx2 - halfSum || minX > cx2 + halfSum);
}

function handleGameCollisions(streamerId) {
  const { racePlanState, Game } = getPlaneGameState(streamerId);
  const AVATAR_BASE_W = 72;     // как у тебя было
  const AVATAR_SCALE  = 0.4;    // как в overlay.css

  Game.players.forEach((p, id) => {
    if (p.out || p.lives <= 0) return;

    for (const o of Game.obstacles) {
      if (o.hitFor?.has(id)) continue;           // чтобы не бить дважды одним объектом
      if (p.lane !== o.lane) continue;           // по вертикали — lane-only

      // Используем метрики хитбокса игрока или масштабируем базовую ширину
      const pHalf = Number.isFinite(p.halfW) ? p.halfW : ((p.width ?? AVATAR_BASE_W) * AVATAR_SCALE) / 2;
      const obstacleHalf = Number.isFinite(o.width) ? o.width/2 : 40;
      const halfSum = pHalf + obstacleHalf;

      // Используем swept-test для предотвращения пролета между тиками
      const hit = sweptOverlap1D(p.prevX ?? p.x, p.x, o.x, halfSum);
      if (!hit) continue;

      // столкновение
      logLine(`[bot] Collision detected: player ${id} at x:${p.x.toFixed(1)} with obstacle at x:${o.x.toFixed(1)} (pHalf:${pHalf}, oHalf:${obstacleHalf}) [streamer ${streamerId}]`);
      p.lives = Math.max(0, (p.lives ?? 3) - 1);
      if (p.lives <= 0) p.out = true;

      if (!o.hitFor) o.hitFor = new Set();
      o.hitFor.add(id);

      // синхронизируем с racePlanState
      racePlanState.lives.set(id, p.lives);
      
      emitOverlay('racePlanCollision', { playerId: id, lives: p.lives }, getBotChannelFor(streamerId), streamerId);
      break;
    }
    
    // Сохраняем текущую позицию для следующего тика
    p.prevX = p.x;
  });

  // убрать с поля «сработавшие» препятствия (те, что столкнулись с игроками)
  const obstaclesToRemove = [];
  Game.obstacles = Game.obstacles.filter(o => {
    if (o.hitFor && o.hitFor.size > 0) {
      obstaclesToRemove.push(o);
      return false;
    }
    return true;
  });

  obstaclesToRemove.forEach(o => {
    emitOverlay('obstacleRemove', { id: o.id }, getBotChannelFor(streamerId), streamerId);
    logLine(`[bot] Removing obstacle ${o.id} after collision for streamer ${streamerId}`);

    const index = racePlanState.obstacles.findIndex(obs => obs.id === o.id);
    if (index !== -1) {
      racePlanState.obstacles.splice(index, 1);
    }
  });
}

function broadcastState(streamerId) {
  const { Game } = getPlaneGameState(streamerId);
  logLine(`[bot] === BROADCAST STATE for streamer ${streamerId} ===`);
  logLine(`[bot] Game.players.size: ${Game.players.size}`);
  logLine(`[bot] Game.obstacles.length: ${Game.obstacles.length}`);
  
  const players = Array.from(Game.players.entries()).map(([id, p]) => ({
    id,
    lane: p.lane ?? 1,
    x: p.x ?? 50,
    lives: Math.max(0, p.lives ?? Game.maxLives),
    out: !!p.out,
  }));
  
  logLine(`[bot] Broadcasting state for streamer ${streamerId}: ${players.length} players, Game.isActive: ${Game.isActive}`);
  if (players.length > 0) {
    logLine(`[bot] First player data:`, players[0]);
  }
  
  const stateData = {
    players,
    started: !!Game.isActive,
    finished: !!Game.gameFinished,
  };
  
  const botChannel = getBotChannelFor(streamerId);
  logLine(`[bot] Emitting racePlanState for streamer ${streamerId}:`, JSON.stringify(stateData));
  logLine(`[bot] Bot channel: ${botChannel}`);
  emitOverlay('racePlanState', stateData, botChannel, streamerId);
  
  const obstaclesData = Game.obstacles.map(o => ({
    id: o.id,
    x: o.x,
    lane: o.lane,
    type: o.type
  }));
  
  if (obstaclesData.length > 0) {
    logLine(`[bot] Emitting racePlanObstacleBatch for streamer ${streamerId}:`, obstaclesData);
    emitOverlay('racePlanObstacleBatch', obstaclesData, botChannel, streamerId);
  }
}

function startFoodGame(streamerId, client, channel, settings = {}) {
  const { minParticipants = 1, maxParticipants = 10, registrationTime = 10 } = settings;
  const { foodGameState } = getStreamerState(streamerId);

  logLine(`[bot] Starting food game for streamer ${streamerId} in channel ${channel} with settings: ${JSON.stringify(settings)}`);

  if (foodGameState.isActive && !foodGameState.gameFinished) {
    logLine(`[bot] Food game already active for streamer ${streamerId}, ignoring start request`);
    return;
  }

  // Полный сброс состояния
  foodGameState.isActive = true;
  foodGameState.gameFinished = false;
  foodGameState.gameStarted = false;
  foodGameState.winner = null;
  foodGameState.startTime = null;
  foodGameState.participants.clear();
  foodGameState.participantNames.clear();
  foodGameState.scores.clear();
  foodGameState.directions.clear();
  foodGameState.speedModifiers.clear();
  foodGameState.carrots = [];

  client.say(channel, `🥕 Кто хочет участвовать в игре "Собери еду", отправьте + в чат! У вас есть ${registrationTime} секунд! (${minParticipants}-${maxParticipants} участников)`).catch(err => logLine(`[bot] say error: ${err.message}`));

  setTimeout(() => {
    const { foodGameState: currentState } = getStreamerState(streamerId);
    if (!currentState.isActive || currentState.gameFinished) {
      return;
    }

    if (currentState.participants.size < minParticipants) {
      client.say(channel, `⏰ Время вышло! Недостаточно участников (${currentState.participants.size}/${minParticipants}). Игра отменена.`).catch(err => logLine(`[bot] say error: ${err.message}`));
      currentState.isActive = false;
      currentState.gameStarted = false;
      return;
    }

    if (currentState.participants.size > maxParticipants) {
      const participantsArray = Array.from(currentState.participants);
      const selectedParticipants = participantsArray.slice(0, maxParticipants);

      currentState.participants.clear();
      currentState.participantNames.clear();

      selectedParticipants.forEach(participantId => {
        currentState.participants.add(participantId);
      });

      client.say(channel, `🎯 Слишком много участников! Выбраны первые ${maxParticipants} участников.`).catch(err => logLine(`[bot] say error: ${err.message}`));
    }

    startFoodGameCountdown(streamerId, client, channel);
  }, registrationTime * 1000);
}

function startFoodGameCountdown(streamerId, client, channel) {
  const { foodGameState } = getStreamerState(streamerId);
  if (!foodGameState.isActive) {
    return;
  }

  foodGameState.gameStarted = true;
  foodGameState.startTime = Date.now();

  foodGameState.participants.forEach(participantId => {
    foodGameState.scores.set(participantId, 0);
    foodGameState.directions.set(participantId, 1);
    foodGameState.speedModifiers.set(participantId, 0);
  });

  const foodGameStartData = {
    participants: Array.from(foodGameState.participants).map(participantId => ({
      userId: participantId,
      displayName: foodGameState.participantNames.get(participantId) || `Пользователь ${participantId}`
    })),
    countdown: 3
  };

  logLine(`[bot] Emitting foodGameStart for streamer ${streamerId}: ${JSON.stringify(foodGameStartData)}`);
  emitOverlay('foodGameStart', foodGameStartData, channel, streamerId);

  let count = 3;
  const countdownInterval = setInterval(() => {
    const { foodGameState: currentState } = getStreamerState(streamerId);
    if (!currentState.isActive || currentState.gameFinished) {
      clearInterval(countdownInterval);
      return;
    }

    if (count > 0) {
      client.say(channel, `🥕 ${count}...`).catch(err => logLine(`[bot] say error: ${err.message}`));
      count--;
    } else {
      clearInterval(countdownInterval);
      client.say(channel, '🥕 ИГРА НАЧАЛАСЬ! Собирайте падающие морковки! Пишите "1" чтобы повернуть!').catch(err => logLine(`[bot] say error: ${err.message}`));
      startFoodGameMonitoring(streamerId, client, channel);
    }
  }, 1000);
}

function startFoodGameMonitoring(streamerId, client, channel) {
  const { foodGameState } = getStreamerState(streamerId);

  emitOverlay('foodGameMonitoring', {
    participants: Array.from(foodGameState.participants).map(participantId => ({
      userId: participantId,
      displayName: foodGameState.participantNames.get(participantId) || `Пользователь ${participantId}`
    })),
    scores: Object.fromEntries(foodGameState.scores),
    directions: Object.fromEntries(foodGameState.directions),
    speedModifiers: Object.fromEntries(foodGameState.speedModifiers)
  }, channel, streamerId);

  const carrotInterval = setInterval(() => {
    const { foodGameState: currentState } = getStreamerState(streamerId);
    if (!currentState.isActive || currentState.gameFinished) {
      clearInterval(carrotInterval);
      return;
    }
    spawnCarrot(streamerId, channel);
  }, 2000);

  const collisionInterval = setInterval(() => {
    const { foodGameState: currentState } = getStreamerState(streamerId);
    if (!currentState.isActive || currentState.gameFinished) {
      clearInterval(collisionInterval);
      return;
    }
    checkCarrotCollisions(streamerId, client, channel);
  }, 100);
}

function joinFoodGame(streamerId, userId, displayName, client, channel) {
  const { foodGameState } = getStreamerState(streamerId);

  if (!foodGameState.isActive || foodGameState.gameFinished) {
    return;
  }

  if (foodGameState.participants.has(userId)) {
    client.say(channel, `@${displayName} вы уже участвуете в игре!`).catch(err => logLine(`[bot] say error: ${err.message}`));
    return;
  }

  foodGameState.participants.add(userId);
  foodGameState.participantNames.set(userId, displayName);
  foodGameState.scores.set(userId, 0);
  foodGameState.directions.set(userId, 1);
  foodGameState.speedModifiers.set(userId, 0);

  const participantCount = foodGameState.participants.size;
  client.say(channel, `🥕 @${displayName} присоединился к игре! Участников: ${participantCount}`).catch(err => logLine(`[bot] say error: ${err.message}`));
  logLine(`[bot] User ${displayName} (${userId}) joined food game for streamer ${streamerId}. Total participants: ${participantCount}`);
}

function checkFoodGameCommand(streamerId, text, userId, displayName, client, channel) {
  const { foodGameState } = getStreamerState(streamerId);
  if (!foodGameState.isActive || !foodGameState.gameStarted || foodGameState.gameFinished) return;

  if (!foodGameState.participants.has(userId)) return;

  if (text.trim() === '1') {
    const currentDirection = foodGameState.directions.get(userId) || 1;
    const newDirection = -currentDirection;

    foodGameState.directions.set(userId, newDirection);

    emitOverlay('foodGameDirectionUpdate', {
      userId,
      direction: newDirection
    }, channel, streamerId);

    logLine(`[bot] User ${displayName} changed direction to ${newDirection > 0 ? 'right' : 'left'} (streamer ${streamerId})`);
  }
}

function checkFoodGameCheering(streamerId, text, client, channel) {
  const { foodGameState } = getStreamerState(streamerId);
  if (!foodGameState.isActive || !foodGameState.gameStarted || foodGameState.gameFinished) return;

  const participants = Array.from(foodGameState.participants);

  for (const participantId of participants) {
    const participantName = foodGameState.participantNames.get(participantId);
    if (!participantName) continue;

    const mentionPattern = new RegExp(`@?${participantName}`, 'i');
    if (mentionPattern.test(text) || text.toLowerCase().includes('cheer') || text.includes('go')) {
      const currentModifier = foodGameState.speedModifiers.get(participantId) || 0;
      const newModifier = Math.min(currentModifier + 0.05, 3.0);
      foodGameState.speedModifiers.set(participantId, newModifier);

      emitOverlay('foodGameSpeedUpdate', {
        userId: participantId,
        speedModifier: newModifier
      }, channel, streamerId);

      client.say(channel, `💨 @${participantName} получил ускорение! Скорость: +${Math.round(newModifier * 100)}%`).catch(err => logLine(`[bot] say error: ${err.message}`));
      logLine(`[bot] User ${participantName} got speed boost: +${Math.round(newModifier * 100)}% (streamer ${streamerId})`);
      break;
    }
  }
}

function spawnCarrot(streamerId, channel) {
  const { foodGameState } = getStreamerState(streamerId);
  if (!foodGameState.isActive || foodGameState.gameFinished) return;

  const carrot = {
    id: Date.now() + Math.random(),
    x: Math.random() * 1200,
    y: -30,
    speed: 2 + Math.random() * 2,
    collected: false
  };

  foodGameState.carrots.push(carrot);

  emitOverlay('carrotSpawn', { ...carrot }, channel, streamerId);

  setTimeout(() => {
    const { foodGameState: currentState } = getStreamerState(streamerId);
    const index = currentState.carrots.findIndex(c => c.id === carrot.id);
    if (index !== -1) {
      currentState.carrots.splice(index, 1);
      emitOverlay('carrotRemove', { id: carrot.id }, channel, streamerId);
    }
  }, 15000);
}

function checkCarrotCollisions(streamerId, client, channel) {
  const { foodGameState } = getStreamerState(streamerId);
  if (!foodGameState.isActive || foodGameState.gameFinished) return;

  foodGameState.participants.forEach(userId => {
    const score = foodGameState.scores.get(userId) || 0;
    if (score >= 10) {
      foodGameState.winner = userId;
      foodGameState.gameFinished = true;
      foodGameState.isActive = false;

      const winnerName = foodGameState.participantNames.get(userId) || 'Unknown';
      logLine(`[bot] Food game winner for streamer ${streamerId}: ${winnerName} (${userId})`);

      emitOverlay('foodGameEnd', {
        winner: userId,
        winnerName,
        finalScores: Object.fromEntries(foodGameState.scores)
      }, channel, streamerId);

      if (client && channel) {
        client.say(channel, `🏁 Игра "Собери морковку" завершена! Победитель: @${winnerName}!`).catch(err => logLine(`[bot] say error: ${err.message}`));
      }
    }
  });
}

/**
 * Завершает игру "Собери морковку" и объявляет победителя в чате.
 * @param {string} winnerName - Имя победителя.
 * @param {Object} client - Клиент Twitch бота.
 * @param {string} channel - Канал Twitch.
 */
function finishFoodGame(winnerName, client, channel) {
  if (client && channel) {
    client.say(channel, `🏁 Игра "Собери морковку" завершена! Поздравляем победителя: ${winnerName}! 🏆`);
    console.log(`[Bot] Announced food game winner: ${winnerName} in channel: ${channel}`);
  } else {
    console.error('[Bot] Cannot announce food game winner: Bot client or channel not available.');
  }
}

function startRacePlan(streamerId, client, channel, settings = {}) {
  const { minParticipants = 1, maxParticipants = 8, registrationTime = 10 } = settings;
  
  logLine(`[bot] Starting race plan in channel: ${channel} with settings:`, settings);
  logLine(`[bot] Client object:`, typeof client, client ? 'exists' : 'null');
  logLine(`[bot] Channel:`, channel);
  logLine(`[bot] Streamer: ${streamerId}`);

  const { racePlanState, Game } = getPlaneGameState(streamerId);
  
  // Проверяем client объект
  if (!client) {
    logLine(`[bot] ERROR: No client provided to startRacePlan!`);
    return;
  }
  
  if (!client.say) {
    logLine(`[bot] ERROR: client.say is not available!`);
    return;
  }
  
  // Prevent multiple game starts
  if (racePlanState.isActive && !racePlanState.gameFinished) {
    logLine(`[bot] Race plan already active, ignoring start request`);
    return;
  }
  
  // Allow starting new game even if one is active (reset previous game)
  if (racePlanState.isActive) {
    logLine(`[bot] Resetting previous race plan state`);
    // Reset game state
    racePlanState.isActive = false;
    racePlanState.participants.clear();
    racePlanState.participantNames.clear();
    racePlanState.positions.clear();
    racePlanState.levels.clear();
    racePlanState.lives.clear();
    racePlanState.obstacles = [];
    racePlanState.winner = null;
    racePlanState.gameStarted = false;
    racePlanState.gameFinished = false;
    racePlanState.startTime = null;
  }

  // Set game state
  racePlanState.isActive = true;
  racePlanState.participants.clear();
  racePlanState.participantNames.clear();
  racePlanState.positions.clear();
  racePlanState.levels.clear();
  racePlanState.lives.clear();
  racePlanState.obstacles = [];
  racePlanState.winner = null;
  racePlanState.gameStarted = false;
  racePlanState.gameFinished = false;
  racePlanState.startTime = null;

  // Синхронизируем с новым состоянием Game
  Game.isActive = true; // активируем сразу при старте регистрации
  Game.gameFinished = false;
  Game.players.clear();
  Game.obstacles = []; // очищаем препятствия

  // Announce game with settings
  logLine(`[bot] About to send announcement message to channel: ${channel}`);
  if (!client || !client.say) {
    logLine(`[bot] ERROR: client or client.say is not available!`);
    return;
  }
  client.say(channel, `✈️ Кто хочет участвовать в гонке на самолетах, отправьте + в чат! У вас есть ${registrationTime} секунд! (${minParticipants}-${maxParticipants} участников)`).catch(err => {
    logLine(`[bot] say error: ${err.message}`);
    logLine(`[bot] Full error: ${JSON.stringify(err)}`);
  });
  logLine(`[bot] Race plan announced in channel: ${channel}`);
  
  // Start registration timer
  setTimeout(() => {
    if (racePlanState.participants.size < minParticipants) {
      client.say(channel, `⏰ Время вышло! Недостаточно участников (${racePlanState.participants.size}/${minParticipants}). Гонка отменена.`).catch(err => {
        logLine(`[bot] say error: ${err.message}`);
        logLine(`[bot] Full error: ${JSON.stringify(err)}`);
      });
      racePlanState.isActive = false;
      return;
    }
    
    // Limit participants if too many joined
    if (racePlanState.participants.size > maxParticipants) {
      const participantsArray = Array.from(racePlanState.participants);
      const selectedParticipants = participantsArray.slice(0, maxParticipants);
      
      // Reset participants to only selected ones
      racePlanState.participants.clear();
      racePlanState.participantNames.clear();
      
      selectedParticipants.forEach(participantId => {
        racePlanState.participants.add(participantId);
      });
      
      client.say(channel, `🎯 Слишком много участников! Выбраны первые ${maxParticipants} участников.`).catch(err => {
        logLine(`[bot] say error: ${err.message}`);
        logLine(`[bot] Full error: ${JSON.stringify(err)}`);
      });
    }
    
    logLine(`[bot] About to call startRacePlanCountdown with client: ${typeof client}, channel: ${channel}`);
    startRacePlanCountdown(streamerId, client, channel);
  }, registrationTime * 1000);
}

function joinRacePlan(streamerId, userId, displayName, client, channel) {
  logLine(`[bot] joinRacePlan called for streamer ${streamerId} with client: ${typeof client}, channel: ${channel}`);
  const { racePlanState, Game } = getPlaneGameState(streamerId);
  
  if (!client || !client.say) {
    logLine(`[bot] ERROR: client or client.say not available in joinRacePlan!`);
    return;
  }
  
  if (racePlanState.participants.has(userId)) {
    client.say(channel, `@${displayName} вы уже участвуете в гонке на самолетах!`).catch(err => {
      logLine(`[bot] say error: ${err.message}`);
      logLine(`[bot] Full error: ${JSON.stringify(err)}`);
    });
    return;
  }

  racePlanState.participants.add(userId);
  racePlanState.participantNames.set(userId, displayName);
  racePlanState.positions.set(userId, { x: 50, y: 0 });
  racePlanState.levels.set(userId, 1);
  racePlanState.lives.set(userId, 3);

  // Добавляем в Game состояние
  Game.players.set(userId, {
    lane: 1, // middle lane
    lives: 3,
    out: false,
    x: 50, // стартовая позиция по X
    width: 72, // ширина аватара для коллизий
    prevX: 50 // предыдущая позиция для swept-test
  });

  const participantCount = racePlanState.participants.size;
  client.say(channel, `✈️ @${displayName} присоединился к гонке на самолетах! Участников: ${participantCount}`).catch(err => {
    logLine(`[bot] say error: ${err.message}`);
    logLine(`[bot] Full error: ${JSON.stringify(err)}`);
  });
  logLine(`[bot] User ${displayName} (${userId}) joined race plan for streamer ${streamerId}. Total participants: ${participantCount}`);
}

function startRacePlanCountdown(streamerId, client, channel) {
  logLine(`[bot] startRacePlanCountdown called for streamer ${streamerId} with client: ${typeof client}, channel: ${channel}`);
  const { racePlanState, Game } = getPlaneGameState(streamerId);
  
  if (!racePlanState.isActive) {
    logLine(`[bot] Race plan not active for streamer ${streamerId}, returning from countdown`);
    return;
  }

  if (!client || !client.say) {
    logLine(`[bot] ERROR: client or client.say not available in countdown!`);
    return;
  }

  racePlanState.gameStarted = true;
  racePlanState.startTime = Date.now();

  Game.isActive = true;

  const racePlanStartData = {
    participants: Array.from(racePlanState.participants),
    countdown: 3,
    levels: Object.fromEntries(racePlanState.levels),
    lives: Object.fromEntries(racePlanState.lives)
  };
  logLine(`[bot] Emitting racePlanStart event for streamer ${streamerId}: ${JSON.stringify(racePlanStartData)}`);
  logLine(`[bot] Race plan participants count: ${racePlanState.participants.size}`);
  logLine(`[bot] Race plan participants: ${Array.from(racePlanState.participants).join(', ')}`);
  emitOverlay('racePlanStart', racePlanStartData, channel, streamerId);

  let count = 3;
  logLine(`[bot] Starting countdown with client: ${typeof client}, channel: ${channel}`);
  
  const countdownInterval = setInterval(() => {
    logLine(`[bot] Countdown tick: ${count}, client available: ${!!client}, client.say available: ${!!(client && client.say)}`);
    if (!racePlanState.isActive) {
      clearInterval(countdownInterval);
      return;
    }

    if (count > 0) {
      if (client && client.say) {
        client.say(channel, `✈️ ${count}...`).catch(err => {
          logLine(`[bot] say error: ${err.message}`);
          logLine(`[bot] Full error: ${JSON.stringify(err)}`);
        });
        logLine(`[bot] Sent countdown message: ${count}`);
      } else {
        logLine(`[bot] ERROR: Cannot send countdown message - client not available`);
      }
      count--;
    } else {
      clearInterval(countdownInterval);
      if (client && client.say) {
        client.say(channel, '✈️ ГОНКА НАЧАЛАСЬ! Пишите "верх" или "низ" для управления!').catch(err => {
          logLine(`[bot] say error: ${err.message}`);
          logLine(`[bot] Full error: ${JSON.stringify(err)}`);
        });
        logLine(`[bot] Sent start message`);
      } else {
        logLine(`[bot] ERROR: Cannot send start message - client not available`);
      }

      startPlaneRaceMonitoring(streamerId, client, channel);
    }
  }, 1000);
}

function startPlaneRaceMonitoring(streamerId, client, channel) {
  logLine(`[bot] === STARTING PLANE RACE MONITORING for streamer ${streamerId} ===`);
  const { racePlanState, Game } = getPlaneGameState(streamerId);
  logLine(`[bot] Game.isActive: ${Game.isActive}, Game.gameFinished: ${Game.gameFinished}`);
  logLine(`[bot] Game.players.size: ${Game.players.size}`);
  
  emitOverlay('racePlanMonitoring', {
    participants: Array.from(racePlanState.participants),
    positions: Object.fromEntries(racePlanState.positions),
    levels: Object.fromEntries(racePlanState.levels),
    lives: Object.fromEntries(racePlanState.lives)
  }, channel, streamerId);

  const obstacleInterval = setInterval(() => {
    const { Game: currentGame } = getPlaneGameState(streamerId);
    logLine(`[bot] Obstacle spawn check for streamer ${streamerId}: Game.isActive=${currentGame.isActive}, Game.gameFinished=${currentGame.gameFinished}`);
    if (!currentGame.isActive || currentGame.gameFinished) {
      logLine(`[bot] Stopping obstacle spawn interval for streamer ${streamerId}`);
      clearInterval(obstacleInterval);
      return;
    }
    logLine(`[bot] Spawning obstacle for streamer ${streamerId}`);
    spawnGameObstacle(streamerId, channel);
  }, 4000);

  const gameTickInterval = setInterval(() => {
    const { Game: currentGame } = getPlaneGameState(streamerId);
    logLine(`[bot] Tick check for streamer ${streamerId}: Game.isActive=${currentGame.isActive}, Game.gameFinished=${currentGame.gameFinished}`);
    if (!currentGame.isActive || currentGame.gameFinished) {
      logLine(`[bot] Stopping game tick interval for streamer ${streamerId}`);
      clearInterval(gameTickInterval);
      return;
    }

    logLine(`[bot] Running serverTick() for streamer ${streamerId}`);
    serverTick(streamerId);
  }, 100);
  
  logLine(`[bot] Game tick started for streamer ${streamerId}, interval ID: ${gameTickInterval}`);
}

function checkRacePlanCommand(streamerId, text, userId, displayName, client, channel) {
  const { racePlanState, Game } = getPlaneGameState(streamerId);
  if (!racePlanState.isActive || !racePlanState.gameStarted || racePlanState.gameFinished) return;

  if (!racePlanState.participants.has(userId)) return;

  if (text.trim() === 'верх') {
    const currentLevel = racePlanState.levels.get(userId) || 1;
    if (currentLevel > 0) {
      const newLevel = currentLevel - 1;
      racePlanState.levels.set(userId, newLevel);

      const gamePlayer = Game.players.get(userId);
      if (gamePlayer) {
        gamePlayer.lane = newLevel;
      }

      emitOverlay('racePlanLevelUpdate', {
        userId,
        level: newLevel
      }, channel, streamerId);

      logLine(`[bot] User ${displayName} moved to level ${newLevel} (streamer ${streamerId})`);
    }
  } else if (text.trim() === 'низ') {
    const currentLevel = racePlanState.levels.get(userId) || 1;
    if (currentLevel < 2) {
      const newLevel = currentLevel + 1;
      racePlanState.levels.set(userId, newLevel);

      const gamePlayer = Game.players.get(userId);
      if (gamePlayer) {
        gamePlayer.lane = newLevel;
      }

      emitOverlay('racePlanLevelUpdate', {
        userId,
        level: newLevel
      }, channel, streamerId);

      logLine(`[bot] User ${displayName} moved to level ${newLevel} (streamer ${streamerId})`);
    }
  }
}

function checkRacePlanCheering(streamerId, text, client, channel) {
  const { racePlanState } = getPlaneGameState(streamerId);
  if (!racePlanState.isActive || !racePlanState.gameStarted || racePlanState.gameFinished) return;

  const participants = Array.from(racePlanState.participants);

  for (const participantId of participants) {
    const participantName = racePlanState.participantNames.get(participantId);
    if (!participantName) continue;

    const mentionPattern = new RegExp(`@?${participantName}`, 'i');
    if (mentionPattern.test(text) || text.toLowerCase().includes('cheer') || text.includes('go')) {
      const currentPos = racePlanState.positions.get(participantId) || { x: 50, y: 0 };
      racePlanState.positions.set(participantId, { x: currentPos.x + 5, y: currentPos.y });

      emitOverlay('racePlanPositionUpdate', {
        userId: participantId,
        position: racePlanState.positions.get(participantId)
      }, channel, streamerId);

      if (client && channel) {
        client.say(channel, `💨 @${participantName} получил ускорение!`).catch(err => logLine(`[bot] say error: ${err.message}`));
      }
      logLine(`[bot] User ${participantName} got speed boost (streamer ${streamerId})`);
      break;
    }
  }
}

function spawnObstacle(streamerId, channel) {
  const { racePlanState } = getPlaneGameState(streamerId);
  if (!racePlanState.isActive || racePlanState.gameFinished) return;

  const randomLevel = Math.floor(Math.random() * 3);
  const obstacle = {
    id: Date.now() + Math.random(),
    x: 1200,
    y: randomLevel,
    speed: 3 + Math.random() * 2,
    type: Math.random() > 0.5 ? 'bird' : 'plane'
  };

  racePlanState.obstacles.push(obstacle);

  logLine(`[bot] Spawning obstacle in lane ${randomLevel} (type: ${obstacle.type}) for streamer ${streamerId}`);

  emitOverlay('obstacleSpawn', obstacle, channel, streamerId);

  setTimeout(() => {
    const { racePlanState: currentState } = getPlaneGameState(streamerId);
    const index = currentState.obstacles.findIndex(o => o.id === obstacle.id);
    if (index !== -1) {
      currentState.obstacles.splice(index, 1);
      emitOverlay('obstacleRemove', { id: obstacle.id }, channel, streamerId);
    }
  }, 15000);
}

// Удаляем дублированную функцию serverTick - используем первую версию

// Функция обработки коллизий
function handleCollision(streamerId, playerId) {
  const { racePlanState, Game } = getPlaneGameState(streamerId);
  const p = Game.players.get(playerId);
  if (!p) return;
  
  p.lives = Math.max(0, p.lives - 1);
  if (p.lives <= 0) {
    p.out = true;
  }
  
  // Синхронизируем с racePlanState
  racePlanState.lives.set(playerId, p.lives);
  
  // Отправляем событие коллизии
  emitOverlay('racePlanCollision', { playerId, lives: p.lives }, getBotChannelFor(streamerId), streamerId);
  
  logLine(`[bot] Player ${playerId} collision: lives=${p.lives}, out=${p.out} (streamer ${streamerId})`);
}

function checkRacePlanCollisions(streamerId, channel) {
  const { racePlanState } = getPlaneGameState(streamerId);
  if (!racePlanState.isActive || racePlanState.gameFinished) return;

  const client = getBotClientFor(streamerId);

  racePlanState.participants.forEach(userId => {
    const position = racePlanState.positions.get(userId) || { x: 50, y: 0 };
    const level = racePlanState.levels.get(userId) || 1;
    const lives = racePlanState.lives.get(userId) || 3;

    if (lives <= 0) return;

    for (let i = racePlanState.obstacles.length - 1; i >= 0; i--) {
      const obstacle = racePlanState.obstacles[i];

      if (obstacle.y === level) {
        const m = AvatarMetrics.get(userId) || { halfW: 36, halfH: 36 };
        const halfObs = (obstacle.width || 80) / 2;

        const dx = Math.abs(position.x - obstacle.x);
        const overlapX = dx <= (m.halfW + halfObs);

        if (overlapX) {
          handleCollision(streamerId, userId);

          racePlanState.obstacles.splice(i, 1);
          emitOverlay('obstacleRemove', { id: obstacle.id }, channel, streamerId);

          obstacle.hit = true;

          logLine(`[bot] User ${userId} hit obstacle! dx: ${dx}, halfW: ${m.halfW}, halfObs: ${halfObs} (streamer ${streamerId})`);
          break;
        }
      }
    }

    if (position.x >= 1100) {
      if (!racePlanState.winner) {
        racePlanState.winner = userId;
        racePlanState.gameFinished = true;
        racePlanState.isActive = false;

        const winnerName = racePlanState.participantNames.get(userId) || 'Unknown';
        logLine(`[bot] Plane race winner: ${winnerName} (${userId}) for streamer ${streamerId}`);

        emitOverlay('racePlanEnd', {
          winner: userId,
          winnerName,
          finalLives: Object.fromEntries(racePlanState.lives)
        }, channel, streamerId);

        if (client && channel) {
          client.say(channel, `🏆 Гонка завершена! Победитель: @${winnerName}!`).catch(err => logLine(`[bot] say error: ${err.message}`));
        }
      }
    }
  });
}

function handleRacePlanCollision(streamerId, playerId, obstacleId) {
  const { racePlanState, Game } = getPlaneGameState(streamerId);
  logLine(`[bot] handleRacePlanCollision called for player: ${playerId}, obstacle: ${obstacleId}, streamer ${streamerId}`);
  
  const player = Game.players.get(playerId);
  if (!player) {
    logLine(`[bot] Player ${playerId} not found in Game state`);
    return;
  }
  
  // Уменьшаем жизни игрока
  player.lives = Math.max(0, player.lives - 1);
  logLine(`[bot] Player ${playerId} lives reduced to: ${player.lives}`);
  
  // Обновляем состояние в racePlanState
  racePlanState.lives.set(playerId, player.lives);
  
  // Если жизни закончились, исключаем игрока
  if (player.lives <= 0) {
    player.out = true;
    logLine(`[bot] Player ${playerId} is out of the race`);
    
    // Отправляем событие коллизии на overlay
    emitOverlay('racePlanCollision', { playerId, lives: 0 }, getBotChannelFor(streamerId), streamerId);
  } else {
    // Отправляем событие коллизии с оставшимися жизнями
    emitOverlay('racePlanCollision', { playerId, lives: player.lives }, getBotChannelFor(streamerId), streamerId);
  }
  
  logLine(`[bot] Player ${playerId} collision: lives=${player.lives}, out=${player.out} (streamer ${streamerId})`);
}

function finishRacePlan(streamerId, winnerName, client, channel) {
  const { Game } = getPlaneGameState(streamerId);
  Game.isActive = false;
  Game.gameFinished = true;
  Game.obstacles = [];

  if (client && channel) {
    client.say(channel, `🏆 Гонка на самолетах завершена! Поздравляем победителя: ${winnerName}! 🏆`);
    console.log(`[Bot] Announced plane race winner: ${winnerName} in channel: ${channel}`);
  } else {
    console.error(`[Bot] Cannot announce plane race winner: Bot client or channel not available for streamer ${streamerId}.`);
  }
}

// Восстановление ботов при старте сервера из Redis
async function restoreBotsFromRedis() {
  try {
    const { stateManager } = require('../lib/state-redis');
    // Используем синхронный модуль, так как getAllStreamers синхронная
    const db = require('../db');
    
    const streamers = db.getAllStreamers();
    if (!streamers || streamers.length === 0) {
      logLine('[bot] No streamers found in database for restoration');
      return;
    }

    logLine(`[bot] Restoring bots for ${streamers.length} streamers from Redis...`);
    
    let restored = 0;
    for (const streamer of streamers) {
      const streamerId = streamer.streamer_twitch_id;
      
      try {
        // Проверяем состояние бота в Redis
        const botState = await stateManager.getBotState(streamerId);
        
        // Проверяем, является ли текущий процесс владельцем бота
        if (botState && botState.active && botState.ownerProcessId) {
          const currentProcessId = String(process.pid);
          const ownerProcessId = String(botState.ownerProcessId);
          
          // Если бот активен в другом процессе - не восстанавливаем
          if (ownerProcessId && !ownerProcessId.startsWith(currentProcessId)) {
            logLine(`[bot] Bot for streamer ${streamerId} is already active in another process (${ownerProcessId}), skipping restoration`);
            continue;
          }
          
          // Если ownerProcessId не начинается с текущего PID, но есть запись - очищаем (старый процесс умер)
          if (ownerProcessId && !ownerProcessId.startsWith(currentProcessId)) {
            logLine(`[bot] Clearing stale bot state for streamer ${streamerId} (old process: ${ownerProcessId})`);
            await stateManager.deleteBotState(streamerId).catch(() => {});
            continue;
          }
        }
        
        if (botState && botState.active) {
          // Восстанавливаем состояние
          const localState = getStreamerState(streamerId);
          if (botState.avatarTimeoutSeconds) {
            localState.avatarTimeoutSeconds = botState.avatarTimeoutSeconds;
          }
          
          // Восстанавливаем активные аватары
          const activeAvatars = await stateManager.getActiveAvatars(streamerId);
          for (const userId of activeAvatars) {
            localState.activeAvatars.add(userId);
            
            // Восстанавливаем активность
            const activity = await stateManager.getAvatarActivity(streamerId, userId);
            if (activity) {
              localState.avatarLastActivity.set(userId, activity);
            }
            
            // Восстанавливаем состояние аватара
            const avatarState = await stateManager.getAvatarState(streamerId, userId);
            if (avatarState) {
              localState.avatarStates.set(userId, avatarState);
            }
          }
          
          // Переподключаем бота к Twitch только если он не активен в другом процессе
          try {
            await ensureBotFor(streamerId);
            restored++;
            logLine(`[bot] Restored bot for streamer ${streamerId}`);
          } catch (error) {
            if (error.message.includes('already active') || error.message.includes('another process')) {
              logLine(`[bot] Bot for streamer ${streamerId} is managed by another process, skipping restoration`);
            } else {
              logLine(`[bot] Failed to restore bot for streamer ${streamerId}: ${error.message}`);
            }
          }
        }
      } catch (error) {
        logLine(`[bot] Error restoring bot for streamer ${streamerId}: ${error.message}`);
      }
    }
    
    logLine(`[bot] Bot restoration completed: ${restored}/${streamers.length} bots restored`);
  } catch (error) {
    logLine(`[bot] Error during bot restoration: ${error.message}`);
  }
}

// Сохранение состояния бота в Redis
async function saveBotStateToRedis(streamerId, processId) {
  try {
    const { stateManager } = require('../lib/state-redis');
    const botData = botClients.get(streamerId);
    
    if (!botData) {
      return;
    }
    
    const state = getStreamerState(streamerId);
    const botState = {
      active: botData.client && botData.ready,
      ownerProcessId: processId || botData.processId || `${process.pid}-${Date.now()}`,
      avatarTimeoutSeconds: state.avatarTimeoutSeconds,
      lastUpdate: Date.now()
    };
    
    await stateManager.setBotState(streamerId, botState);
  } catch (error) {
    logLine(`[bot] Error saving bot state to Redis for ${streamerId}: ${error.message}`);
  }
}

// Watchdog для автоматического мониторинга и восстановления ботов
let botWatchdogInterval = null;

async function checkBotsHealth() {
  try {
    const { stateManager } = require('../lib/state-redis');
    const db = require('../db');
    
    const streamers = db.getAllStreamers();
    if (!streamers || streamers.length === 0) {
      return;
    }
    
    for (const streamer of streamers) {
      const streamerId = streamer.streamer_twitch_id;
      const botData = botClients.get(streamerId);
      const botState = await stateManager.getBotState(streamerId);
      
      // Если бот должен быть активен (по Redis), но локально не подключен
      if (botState && botState.active) {
        const isLocalActive = botData && botData.client && botData.ready;
        const currentProcessId = `${process.pid}`;
        const isOwner = botState.ownerProcessId && botState.ownerProcessId.startsWith(currentProcessId);
        
        // Если мы владелец бота, но он упал - переподключаем
        if (isOwner && !isLocalActive) {
          logLine(`[bot watchdog] Bot for streamer ${streamerId} is down, attempting to restore...`);
          try {
            await ensureBotFor(streamerId);
            logLine(`[bot watchdog] Successfully restored bot for streamer ${streamerId}`);
          } catch (error) {
            logLine(`[bot watchdog] Failed to restore bot for streamer ${streamerId}: ${error.message}`);
            // Если не удалось восстановить - очищаем состояние в Redis
            if (error.message.includes('already active') || error.message.includes('another process')) {
              // Бот перехвачен другим процессом - это нормально
            } else {
              // Реальная ошибка - очищаем состояние
              await stateManager.deleteBotState(streamerId).catch(() => {});
            }
          }
        }
      }
      
      // Если бот локально активен, обновляем timestamp в Redis
      if (botData && botData.client && botData.ready) {
        await saveBotStateToRedis(streamerId, botData.processId).catch(() => {});
      }
    }
  } catch (error) {
    logLine(`[bot watchdog] Error checking bots health: ${error.message}`);
  }
}

function startBotWatchdog() {
  if (botWatchdogInterval) {
    clearInterval(botWatchdogInterval);
  }
  
  // Проверяем здоровье ботов каждые 30 секунд
  botWatchdogInterval = setInterval(() => {
    checkBotsHealth().catch(error => {
      logLine(`[bot watchdog] Unhandled error: ${error.message}`);
    });
  }, 30000);
  
  // Первая проверка через 10 секунд после старта
  setTimeout(() => {
    checkBotsHealth().catch(error => {
      logLine(`[bot watchdog] Initial check error: ${error.message}`);
    });
  }, 10000);
  
  logLine('[bot watchdog] Bot watchdog started');
}

function stopBotWatchdog() {
  if (botWatchdogInterval) {
    clearInterval(botWatchdogInterval);
    botWatchdogInterval = null;
    logLine('[bot watchdog] Bot watchdog stopped');
  }
}

module.exports = { ensureBotFor, stopBot, status, addActiveAvatar, removeActiveAvatar, finishRace, finishFoodGame, getBotClient, getBotClientFor, getBotChannel, getBotChannelFor, startRace, startFoodGame, checkFoodGameCommand, checkFoodGameCheering, checkCarrotCollisions, spawnCarrot, joinFoodGame, startFoodGameCountdown, startFoodGameMonitoring, setAvatarTimeoutSeconds, getAvatarTimeoutSeconds, startRacePlan, joinRacePlan, checkRacePlanCommand, checkRacePlanCheering, spawnObstacle, checkRacePlanCollisions, handleRacePlanCollision, finishRacePlan, setAvatarMetrics, getStreamerState, restoreBotsFromRedis, saveBotStateToRedis, startBotWatchdog, stopBotWatchdog };


