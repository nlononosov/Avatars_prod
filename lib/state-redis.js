// Управление состоянием ботов и игр через Redis
// Позволяет горизонтальное масштабирование и персистентность

const { getClient } = require('./redis');

// Префиксы для ключей Redis
const PREFIXES = {
  BOT_STATE: 'bot:state:',
  GAME_STATE: 'game:state:',
  AVATAR_ACTIVE: 'avatar:active:',
  AVATAR_ACTIVITY: 'avatar:activity:',
  AVATAR_STATE: 'avatar:state:',
  RACE_STATE: 'game:race:',
  FOOD_GAME_STATE: 'game:food:',
  RACE_PLAN_STATE: 'game:race-plan:',
  GAME_STATE: 'game:general:',
  LOCK: 'lock:'
};

class StateManager {
  constructor() {
    this.localCache = new Map();
    this.cacheTTL = 5000; // 5 секунд локального кэша
  }

  async getClient() {
    const client = await getClient();
    if (client.status === 'ready') {
      return client;
    }
    // При недоступности Redis возвращаем null (fallback на локальное состояние)
    return null;
  }

  // Состояние бота
  async getBotState(streamerId) {
    const cacheKey = `bot_${streamerId}`;
    const cached = this.localCache.get(cacheKey);
    if (cached && Date.now() < cached.expires) {
      return cached.data;
    }

    const client = await this.getClient();
    if (!client) return null;

    try {
      const data = await client.get(`${PREFIXES.BOT_STATE}${streamerId}`);
      const state = data ? JSON.parse(data) : null;
      
      // Кэшируем локально
      if (state) {
        this.localCache.set(cacheKey, {
          data: state,
          expires: Date.now() + this.cacheTTL
        });
      }
      
      return state;
    } catch (error) {
      console.error(`[StateRedis] Error getting bot state for ${streamerId}:`, error);
      return null;
    }
  }

  async setBotState(streamerId, state) {
    const client = await this.getClient();
    if (!client) return false;

    try {
      await client.setex(
        `${PREFIXES.BOT_STATE}${streamerId}`,
        3600, // TTL 1 час
        JSON.stringify(state)
      );
      
      // Обновляем локальный кэш
      const cacheKey = `bot_${streamerId}`;
      this.localCache.set(cacheKey, {
        data: state,
        expires: Date.now() + this.cacheTTL
      });
      
      return true;
    } catch (error) {
      console.error(`[StateRedis] Error setting bot state for ${streamerId}:`, error);
      return false;
    }
  }

  async deleteBotState(streamerId) {
    const client = await this.getClient();
    if (!client) return false;

    try {
      await client.del(`${PREFIXES.BOT_STATE}${streamerId}`);
      this.localCache.delete(`bot_${streamerId}`);
      return true;
    } catch (error) {
      console.error(`[StateRedis] Error deleting bot state for ${streamerId}:`, error);
      return false;
    }
  }

  // Активные аватары
  async getActiveAvatars(streamerId) {
    const client = await this.getClient();
    if (!client) return new Set();

    try {
      const members = await client.smembers(`${PREFIXES.AVATAR_ACTIVE}${streamerId}`);
      return new Set(members);
    } catch (error) {
      console.error(`[StateRedis] Error getting active avatars for ${streamerId}:`, error);
      return new Set();
    }
  }

  async addActiveAvatar(streamerId, userId) {
    const client = await this.getClient();
    if (!client) return false;

    try {
      await client.sadd(`${PREFIXES.AVATAR_ACTIVE}${streamerId}`, userId);
      return true;
    } catch (error) {
      console.error(`[StateRedis] Error adding active avatar for ${streamerId}:`, error);
      return false;
    }
  }

  async removeActiveAvatar(streamerId, userId) {
    const client = await this.getClient();
    if (!client) return false;

    try {
      await client.srem(`${PREFIXES.AVATAR_ACTIVE}${streamerId}`, userId);
      return true;
    } catch (error) {
      console.error(`[StateRedis] Error removing active avatar for ${streamerId}:`, error);
      return false;
    }
  }

  // Активность аватаров (для таймаутов)
  async getAvatarActivity(streamerId, userId) {
    const client = await this.getClient();
    if (!client) return null;

    try {
      const timestamp = await client.get(`${PREFIXES.AVATAR_ACTIVITY}${streamerId}:${userId}`);
      return timestamp ? parseInt(timestamp, 10) : null;
    } catch (error) {
      console.error(`[StateRedis] Error getting avatar activity for ${streamerId}:${userId}:`, error);
      return null;
    }
  }

  async setAvatarActivity(streamerId, userId, timestamp) {
    const client = await this.getClient();
    if (!client) return false;

    try {
      const timeoutSeconds = 600; // 10 минут по умолчанию
      await client.setex(
        `${PREFIXES.AVATAR_ACTIVITY}${streamerId}:${userId}`,
        timeoutSeconds,
        timestamp.toString()
      );
      return true;
    } catch (error) {
      console.error(`[StateRedis] Error setting avatar activity for ${streamerId}:${userId}:`, error);
      return false;
    }
  }

  // Состояния аватаров (normal, tired, etc.)
  async getAvatarState(streamerId, userId) {
    const client = await this.getClient();
    if (!client) return null;

    try {
      const state = await client.get(`${PREFIXES.AVATAR_STATE}${streamerId}:${userId}`);
      return state;
    } catch (error) {
      console.error(`[StateRedis] Error getting avatar state for ${streamerId}:${userId}:`, error);
      return null;
    }
  }

  async setAvatarState(streamerId, userId, state) {
    const client = await this.getClient();
    if (!client) return false;

    try {
      const timeoutSeconds = 600;
      await client.setex(
        `${PREFIXES.AVATAR_STATE}${streamerId}:${userId}`,
        timeoutSeconds,
        state
      );
      return true;
    } catch (error) {
      console.error(`[StateRedis] Error setting avatar state for ${streamerId}:${userId}:`, error);
      return false;
    }
  }

  // Состояния игр
  async getGameState(streamerId, gameType) {
    const client = await this.getClient();
    if (!client) return null;

    try {
      const prefix = {
        'race': PREFIXES.RACE_STATE,
        'food': PREFIXES.FOOD_GAME_STATE,
        'race-plan': PREFIXES.RACE_PLAN_STATE,
        'general': PREFIXES.GAME_STATE
      }[gameType] || PREFIXES.GAME_STATE;

      const data = await client.get(`${prefix}${streamerId}`);
      return data ? JSON.parse(data) : null;
    } catch (error) {
      console.error(`[StateRedis] Error getting game state for ${streamerId}:${gameType}:`, error);
      return null;
    }
  }

  async setGameState(streamerId, gameType, state) {
    const client = await this.getClient();
    if (!client) return false;

    try {
      const prefix = {
        'race': PREFIXES.RACE_STATE,
        'food': PREFIXES.FOOD_GAME_STATE,
        'race-plan': PREFIXES.RACE_PLAN_STATE,
        'general': PREFIXES.GAME_STATE
      }[gameType] || PREFIXES.GAME_STATE;

      await client.setex(
        `${prefix}${streamerId}`,
        1800, // 30 минут
        JSON.stringify(state)
      );
      return true;
    } catch (error) {
      console.error(`[StateRedis] Error setting game state for ${streamerId}:${gameType}:`, error);
      return false;
    }
  }

  async deleteGameState(streamerId, gameType) {
    const client = await this.getClient();
    if (!client) return false;

    try {
      const prefix = {
        'race': PREFIXES.RACE_STATE,
        'food': PREFIXES.FOOD_GAME_STATE,
        'race-plan': PREFIXES.RACE_PLAN_STATE,
        'general': PREFIXES.GAME_STATE
      }[gameType] || PREFIXES.GAME_STATE;

      await client.del(`${prefix}${streamerId}`);
      return true;
    } catch (error) {
      console.error(`[StateRedis] Error deleting game state for ${streamerId}:${gameType}:`, error);
      return false;
    }
  }

  // Очистка кэша
  clearLocalCache() {
    this.localCache.clear();
  }

  // Получить все ключи для стримера (для отладки)
  async getAllKeys(streamerId) {
    const client = await this.getClient();
    if (!client) return [];

    try {
      const patterns = [
        `${PREFIXES.BOT_STATE}${streamerId}*`,
        `${PREFIXES.AVATAR_ACTIVE}${streamerId}*`,
        `${PREFIXES.RACE_STATE}${streamerId}*`,
        `${PREFIXES.FOOD_GAME_STATE}${streamerId}*`,
        `${PREFIXES.RACE_PLAN_STATE}${streamerId}*`
      ];

      const allKeys = [];
      for (const pattern of patterns) {
        const keys = await client.keys(pattern);
        allKeys.push(...keys);
      }

      return allKeys;
    } catch (error) {
      console.error(`[StateRedis] Error getting all keys for ${streamerId}:`, error);
      return [];
    }
  }
}

// Singleton
const stateManager = new StateManager();

module.exports = {
  stateManager,
  PREFIXES
};

