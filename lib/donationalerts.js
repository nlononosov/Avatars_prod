// Ленивая загрузка кэша пользователей вместо глобальной загрузки всех пользователей
const usernameCache = new Map();
const cacheMaxSize = 10000; // Максимум 10000 пользователей в памяти
const cacheTTL = 3600000; // 1 час

// Отслеживание времени последнего доступа
const cacheAccessTimes = new Map();

// Initialize username cache lazily - не загружает всех пользователей
function initializeUsernameCache() {
  console.log('[DA] Username cache initialized (lazy loading mode)');
}

// Find user by username (case-insensitive) с ленивой загрузкой
async function findUserByUsername(username) {
  const normalizedUsername = username.toLowerCase().trim();
  
  // Проверяем кэш
  if (usernameCache.has(normalizedUsername)) {
    cacheAccessTimes.set(normalizedUsername, Date.now());
    return usernameCache.get(normalizedUsername);
  }
  
  // Загружаем из БД только конкретного пользователя
  try {
    const { getUserByLogin } = require('../db');
    const user = getUserByLogin(normalizedUsername);
    
    if (user) {
      // Добавляем в кэш
      addUserToCache(user);
    }
    
    return user || null;
  } catch (error) {
    console.error('[DA] Error finding user by username:', error);
    return null;
  }
}

// Clean up old cache entries when limit reached
function cleanCacheIfNeeded() {
  if (usernameCache.size < cacheMaxSize) return;
  
  // Сортируем по времени доступа
  const sortedEntries = Array.from(cacheAccessTimes.entries())
    .sort((a, b) => a[1] - b[1]);
  
  // Удаляем 20% самых старых записей
  const toRemove = Math.floor(cacheMaxSize * 0.2);
  
  for (let i = 0; i < toRemove && i < sortedEntries.length; i++) {
    const [username] = sortedEntries[i];
    usernameCache.delete(username);
    cacheAccessTimes.delete(username);
  }
  
  console.log(`[DA] Cleaned cache: removed ${toRemove} old entries`);
}

// Add user to cache
function addUserToCache(user) {
  if (!user.login) return;
  
  cleanCacheIfNeeded();
  
  const normalized = user.login.toLowerCase();
  usernameCache.set(normalized, user);
  cacheAccessTimes.set(normalized, Date.now());
}

// Update user in cache
function updateUserInCache(user) {
  if (!user.login) return;
  
  const normalized = user.login.toLowerCase();
  
  // Обновляем только если пользователь уже в кэше
  if (usernameCache.has(normalized)) {
    usernameCache.set(normalized, user);
    cacheAccessTimes.set(normalized, Date.now());
  }
}

// Legacy functions removed - use lib/donationalerts-poll.js instead

// Legacy polling and processing functions removed - use lib/donationalerts-poll.js instead

module.exports = {
  initializeUsernameCache,
  addUserToCache,
  updateUserInCache,
  findUserByUsername
};
