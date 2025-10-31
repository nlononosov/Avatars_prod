const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dbPath = path.join(__dirname, 'data.sqlite');
const db = new Database(dbPath, { fileMustExist: false });

// Gift types and IDs
const GIFT_TYPES = {
  COMMON: 'common',
  UNCOMMON: 'uncommon', 
  RARE: 'rare'
};

const GIFT_IDS = {
  [GIFT_TYPES.COMMON]: ['1'],
  [GIFT_TYPES.UNCOMMON]: ['1'],
  [GIFT_TYPES.RARE]: ['1']
};

// Надёжнее работать в WAL
db.pragma('journal_mode = WAL');

// 1) Базовая таблица, если её ещё нет
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  twitch_user_id TEXT UNIQUE NOT NULL,
  display_name TEXT,
  login TEXT,
  -- Колонки ниже могут отсутствовать в старой базе, добавим миграцией
  profile_image_url TEXT,
  access_token TEXT NOT NULL,
  refresh_token TEXT,
  scope TEXT,
  expires_at INTEGER,
  updated_at INTEGER NOT NULL
);
`);

// 2) Таблица для настроек игр стримеров
db.exec(`
CREATE TABLE IF NOT EXISTS streamer_game_settings (
  streamer_id TEXT PRIMARY KEY,
  min_participants INTEGER NOT NULL DEFAULT 1,
  max_participants INTEGER NOT NULL DEFAULT 10,
  registration_time INTEGER NOT NULL DEFAULT 10,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
`);

// 3) Таблица для подарков с названиями
db.exec(`
CREATE TABLE IF NOT EXISTS gifts (
  id TEXT PRIMARY KEY,
  gift_type TEXT NOT NULL,
  gift_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
`);

// 4) Миграция: добавить недостающие колонки в существующую таблицу
(function migrateUsersTable() {
  const cols = db.prepare(`PRAGMA table_info('users')`).all()
    .reduce((acc, c) => (acc.add(c.name), acc), new Set());

  const addColumn = (name, type) => {
    const sql = `ALTER TABLE users ADD COLUMN ${name} ${type}`;
    db.exec(sql);
  };

  // Добавляем по необходимости (SQLite допускает ADD COLUMN без дефолта)
  if (!cols.has('profile_image_url')) addColumn('profile_image_url', 'TEXT');
  if (!cols.has('refresh_token')) addColumn('refresh_token', 'TEXT');
  if (!cols.has('scope')) addColumn('scope', 'TEXT');
  if (!cols.has('expires_at')) addColumn('expires_at', 'INTEGER');
  if (!cols.has('updated_at')) addColumn('updated_at', "INTEGER NOT NULL DEFAULT (strftime('%s','now'))");
  if (!cols.has('coins')) addColumn('coins', 'INTEGER NOT NULL DEFAULT 0');
  if (!cols.has('da_username')) addColumn('da_username', 'TEXT');
  if (!cols.has('da_user_id')) addColumn('da_user_id', 'TEXT');
  if (!cols.has('avatar_timeout_seconds')) addColumn('avatar_timeout_seconds', 'INTEGER NOT NULL DEFAULT 300');

  // Убедимся в уникальности twitch_user_id (на старых БД индекса мог не быть)
  const idx = db.prepare(`PRAGMA index_list('users')`).all();
  const hasUniqueIdx = idx.some(i => i.unique && i.name === 'users_twitch_user_id_unique');

  if (!hasUniqueIdx) {
    // Попробуем создать уникальный индекс (если в таблице уже есть дубль — упадёт).
    // Если боитесь падения, сначала вручную почистите дубликаты.
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS users_twitch_user_id_unique ON users(twitch_user_id)`);
  }
})();

// Инициализация подарков с названиями
(function initializeGifts() {
  const now = Date.now();
  
  const gifts = [
    { id: 'gift_common_1', gift_type: 'common', gift_id: '1', name: 'Печенька', description: 'Вкусное печенье для поднятия настроения' },
    { id: 'gift_uncommon_1', gift_type: 'uncommon', gift_id: '1', name: 'Коробочка', description: 'Загадочная коробочка с сюрпризом' },
    { id: 'gift_rare_1', gift_type: 'rare', gift_id: '1', name: 'Тортик', description: 'Праздничный тортик для особого случая' }
  ];
  
  gifts.forEach(gift => {
    const existing = db.prepare(`SELECT id FROM gifts WHERE id = ?`).get(gift.id);
    if (!existing) {
      db.prepare(`
        INSERT INTO gifts (id, gift_type, gift_id, name, description, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(gift.id, gift.gift_type, gift.gift_id, gift.name, gift.description, now, now);
    }
  });
})();

// 3) Таблица для аватаров пользователей
db.exec(`
CREATE TABLE IF NOT EXISTS user_avatars (
  twitch_user_id TEXT PRIMARY KEY,
  body_skin TEXT NOT NULL DEFAULT 'body_skin_1',
  face_skin TEXT NOT NULL DEFAULT 'face_skin_1', 
  clothes_type TEXT NOT NULL DEFAULT 'clothes_type_1',
  others_type TEXT NOT NULL DEFAULT 'others_1',
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  FOREIGN KEY(twitch_user_id) REFERENCES users(twitch_user_id) ON DELETE CASCADE
);
`);

// 4) Таблица заблокированных скинов
db.exec(`
CREATE TABLE IF NOT EXISTS locked_skins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  skin_type TEXT NOT NULL,
  skin_id TEXT NOT NULL,
  price INTEGER NOT NULL DEFAULT 100,
  is_locked BOOLEAN NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  UNIQUE(skin_type, skin_id)
);
`);

// 5) Таблица купленных скинов пользователей
db.exec(`
CREATE TABLE IF NOT EXISTS user_purchased_skins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  twitch_user_id TEXT NOT NULL,
  skin_type TEXT NOT NULL,
  skin_id TEXT NOT NULL,
  purchased_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  FOREIGN KEY (twitch_user_id) REFERENCES users(twitch_user_id),
  UNIQUE(twitch_user_id, skin_type, skin_id)
);
`);

// 4) Таблица для подарков пользователей
db.exec(`
CREATE TABLE IF NOT EXISTS user_gifts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  twitch_user_id TEXT NOT NULL,
  gift_type TEXT NOT NULL,
  gift_id TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  FOREIGN KEY(twitch_user_id) REFERENCES users(twitch_user_id) ON DELETE CASCADE,
  UNIQUE(twitch_user_id, gift_type, gift_id)
);
`);

// 5) Таблица для связи пользователей со стримерами
db.exec(`
CREATE TABLE IF NOT EXISTS user_streamers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_twitch_id TEXT NOT NULL,
  streamer_twitch_id TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  FOREIGN KEY(user_twitch_id) REFERENCES users(twitch_user_id) ON DELETE CASCADE,
  FOREIGN KEY(streamer_twitch_id) REFERENCES users(twitch_user_id) ON DELETE CASCADE,
  UNIQUE(user_twitch_id, streamer_twitch_id)
);
`);

// 6) Таблица для токенов DonationAlerts стримеров
db.exec(`
CREATE TABLE IF NOT EXISTS streamers (
  streamer_twitch_id TEXT PRIMARY KEY,
  twitch_login TEXT,
  da_user_id TEXT,
  da_access_token TEXT,
  da_refresh_token TEXT,
  da_expires_at INTEGER,
  status TEXT DEFAULT 'active',
  created_at INTEGER DEFAULT (strftime('%s','now')),
  updated_at INTEGER DEFAULT (strftime('%s','now'))
);
`);

// 7) Индекс для быстрого поиска по da_user_id
db.exec(`CREATE INDEX IF NOT EXISTS idx_streamers_da_user_id ON streamers(da_user_id);`);

// 8) Таблица идемпотентности для донатов
db.exec(`
CREATE TABLE IF NOT EXISTS donations_processed (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  streamer_twitch_id TEXT NOT NULL,
  donation_id TEXT NOT NULL,
  created_at INTEGER DEFAULT (strftime('%s','now')),
  UNIQUE(streamer_twitch_id, donation_id)
);
`);

// 9) Индекс для быстрого поиска обработанных донатов
db.exec(`CREATE INDEX IF NOT EXISTS idx_donations_processed_lookup ON donations_processed(streamer_twitch_id, donation_id);`);

// 6) Инициализация заблокированных скинов
(function initializeLockedSkins() {
  try {
    // Получаем все доступные скины из файловой системы
    const allParts = getAvailableAvatarParts();
    const allSkins = [];
    
    Object.keys(allParts).forEach(skinType => {
      allParts[skinType].forEach(part => {
        allSkins.push({
          skin_type: skinType,
          skin_id: part.id,
          price: getDefaultPriceForSkin(skinType, part.id)
        });
      });
    });
    
    // Проверяем каждый скин и добавляем его в заблокированные, если его там нет
    const insertStmt = db.prepare('INSERT OR IGNORE INTO locked_skins (skin_type, skin_id, price) VALUES (?, ?, ?)');
    let addedCount = 0;
    
    allSkins.forEach(skin => {
      const existing = db.prepare('SELECT id FROM locked_skins WHERE skin_type = ? AND skin_id = ?').get(skin.skin_type, skin.skin_id);
      if (!existing && skin.price > 0) {
        insertStmt.run(skin.skin_type, skin.skin_id, skin.price);
        addedCount++;
      }
    });
    
    if (addedCount > 0) {
      console.log(`[db] Added ${addedCount} new locked skins automatically`);
    }
  } catch (error) {
    console.error('[db] Error initializing locked skins:', error);
  }
})();

// Функция для определения цены по умолчанию для скина
function getDefaultPriceForSkin(skinType, skinId) {
  // Скины с номером 1 всегда бесплатные
  if (skinId.includes('_1') || skinId.endsWith('_1')) {
    return 0;
  }
  
  // Определяем цену в зависимости от типа и номера скина
  const basePrices = {
    'body': 200,
    'face': 100,
    'clothes': 150,
    'others': 120
  };
  
  const basePrice = basePrices[skinType] || 100;
  
  // Извлекаем номер скина для увеличения цены
  const match = skinId.match(/_(\d+)$/);
  if (match) {
    const skinNumber = parseInt(match[1]);
    return basePrice + (skinNumber - 2) * 50; // Увеличиваем цену на 50 монет за каждый номер
  }
  
  return basePrice;
}

// 7) Очистка старых подарков для корректной работы новой системы
(function clearOldGifts() {
  try {
    // Удаляем все старые подарки с неправильными типами
    const deletedRows = db.prepare(`
      DELETE FROM user_gifts 
      WHERE gift_type IN ('gift_common', 'gift_uncommon', 'gift_rare')
    `).run();
    
    if (deletedRows.changes > 0) {
      console.log(`[db] Cleared ${deletedRows.changes} old gift records with incorrect types`);
    }
  } catch (error) {
    console.error('[db] Error clearing old gifts:', error);
  }
})();

// 7) Подготовленный UPSERT (работает и для новой, и для мигрированной схемы)
const upsertStmt = db.prepare(`
INSERT INTO users (
  twitch_user_id, display_name, login, profile_image_url,
  access_token, refresh_token, scope, expires_at, updated_at, coins
) VALUES (
  @twitch_user_id, @display_name, @login, @profile_image_url,
  @access_token, @refresh_token, @scope, @expires_at, @updated_at, @coins
)
ON CONFLICT(twitch_user_id) DO UPDATE SET
  display_name=excluded.display_name,
  login=excluded.login,
  profile_image_url=excluded.profile_image_url,
  access_token=excluded.access_token,
  refresh_token=excluded.refresh_token,
  scope=excluded.scope,
  expires_at=excluded.expires_at,
  updated_at=excluded.updated_at,
  coins=excluded.coins
`);

function saveOrUpdateUser(user) {
  const now = Math.floor(Date.now() / 1000);
  upsertStmt.run({
    twitch_user_id: user.twitch_user_id,
    display_name: user.display_name || null,
    login: user.login || null,
    profile_image_url: user.profile_image_url || null,
    access_token: user.access_token,
    refresh_token: user.refresh_token || null,
    scope: Array.isArray(user.scope) ? user.scope.join(' ') : (user.scope || null),
    expires_at: user.expires_at || null,
    updated_at: now,
    coins: user.coins || 0
  });
  
  // Update DonationAlerts cache if available
  try {
    const { updateUserInCache } = require('./lib/donationalerts');
    updateUserInCache(user);
  } catch (error) {
    // Ignore if DonationAlerts module is not available
  }
}

function getUserByTwitchId(twitchUserId) {
  return db.prepare('SELECT * FROM users WHERE twitch_user_id = ?').get(twitchUserId);
}

function getUserByLogin(login) {
  return db.prepare('SELECT * FROM users WHERE login = ?').get(login);
}

function getAllUsers() {
  return db.prepare('SELECT * FROM users').all();
}

// DonationAlerts connection functions
function updateUserDAConnection(twitchUserId, daUsername) {
  const stmt = db.prepare('UPDATE users SET da_username = ?, updated_at = ? WHERE twitch_user_id = ?');
  const now = Math.floor(Date.now() / 1000);
  return stmt.run(daUsername, now, twitchUserId);
}

function getUserDAConnection(twitchUserId) {
  const user = db.prepare('SELECT da_username FROM users WHERE twitch_user_id = ?').get(twitchUserId);
  return user ? user.da_username : null;
}

function getUsersWithDAConnection() {
  return db.prepare('SELECT * FROM users WHERE da_username IS NOT NULL').all();
}

// Функции для работы с токенами DonationAlerts стримеров
function upsertStreamerDA(creds) {
  const now = Math.floor(Date.now() / 1000);
  const stmt = db.prepare(`
    INSERT INTO streamers (
      streamer_twitch_id, twitch_login, da_user_id, da_access_token, 
      da_refresh_token, da_expires_at, status, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(streamer_twitch_id) DO UPDATE SET
      twitch_login = excluded.twitch_login,
      da_user_id = excluded.da_user_id,
      da_access_token = excluded.da_access_token,
      da_refresh_token = excluded.da_refresh_token,
      da_expires_at = excluded.da_expires_at,
      status = excluded.status,
      updated_at = excluded.updated_at
  `);
  
  return stmt.run(
    creds.streamer_twitch_id,
    creds.twitch_login || null,
    creds.da_user_id,
    creds.da_access_token,
    creds.da_refresh_token,
    creds.da_expires_at,
    creds.status || 'active',
    now
  );
}

function getStreamerDA(streamerTwitchId) {
  return db.prepare('SELECT * FROM streamers WHERE streamer_twitch_id = ?').get(streamerTwitchId);
}

function getAllStreamers() {
  return db.prepare('SELECT * FROM streamers WHERE status = ?').all('active');
}

// Функции для идемпотентности донатов
function markDonationProcessed(streamerTwitchId, donationId) {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO donations_processed (streamer_twitch_id, donation_id)
    VALUES (?, ?)
  `);
  return stmt.run(streamerTwitchId, donationId);
}

function isDonationProcessed(streamerTwitchId, donationId) {
  const result = db.prepare(`
    SELECT 1 FROM donations_processed 
    WHERE streamer_twitch_id = ? AND donation_id = ?
  `).get(streamerTwitchId, donationId);
  return !!result;
}

// Функции для работы с DA пользователей
function setUserDA(userTwitchId, { da_user_id, da_username }) {
  const now = Math.floor(Date.now() / 1000);
  const stmt = db.prepare(`
    UPDATE users SET da_user_id = ?, da_username = ?, updated_at = ?
    WHERE twitch_user_id = ?
  `);
  return stmt.run(da_user_id, da_username, now, userTwitchId);
}

function findUserByDAUserId(da_user_id) {
  return db.prepare('SELECT * FROM users WHERE da_user_id = ?').get(da_user_id);
}

function findUserByNormalizedLogin(login) {
  if (!login || typeof login !== 'string') return null;
  
  try {
    // Нормализация логина с дополнительной валидацией
    const normalized = login.trim().toLowerCase().replace(/\s+/g, ' ').replace(/[_\-]+/g, '_');
    if (!normalized || normalized.length === 0) return null;
    
    // Поиск по нормализованному логину
    const user = db.prepare('SELECT * FROM users WHERE login = ?').get(normalized);
    if (user) return user;
    
    // Fallback - поиск по display_name
    return db.prepare('SELECT * FROM users WHERE display_name = ?').get(normalized);
  } catch (error) {
    console.error(`[DB] Error finding user by normalized login "${login}":`, error.message);
    return null;
  }
}

// Функции для работы с настройками тайминга аватаров
function setAvatarTimeoutSeconds(twitchUserId, seconds) {
  const stmt = db.prepare('UPDATE users SET avatar_timeout_seconds = ?, updated_at = ? WHERE twitch_user_id = ?');
  const now = Math.floor(Date.now() / 1000);
  return stmt.run(seconds, now, twitchUserId);
}

function getAvatarTimeoutSeconds(twitchUserId) {
  const user = db.prepare('SELECT avatar_timeout_seconds FROM users WHERE twitch_user_id = ?').get(twitchUserId);
  return user ? user.avatar_timeout_seconds : 300; // Default 5 minutes
}

// Функции для работы с монетами
function getUserCoins(twitchUserId) {
  const user = db.prepare('SELECT coins FROM users WHERE twitch_user_id = ?').get(twitchUserId);
  return user ? user.coins : 0;
}

function updateUserCoins(twitchUserId, coins) {
  const stmt = db.prepare('UPDATE users SET coins = ?, updated_at = ? WHERE twitch_user_id = ?');
  const now = Math.floor(Date.now() / 1000);
  return stmt.run(coins, now, twitchUserId);
}

function addUserCoins(twitchUserId, amount) {
  const currentCoins = getUserCoins(twitchUserId);
  const newCoins = Math.max(0, currentCoins + amount);
  updateUserCoins(twitchUserId, newCoins);
  return newCoins;
}

// Функции для работы с заблокированными скинами
function getLockedSkins() {
  return db.prepare('SELECT * FROM locked_skins WHERE is_locked = 1').all();
}

function getUserPurchasedSkins(twitchUserId) {
  return db.prepare('SELECT skin_type, skin_id FROM user_purchased_skins WHERE twitch_user_id = ?').all(twitchUserId);
}

function isSkinPurchased(twitchUserId, skinType, skinId) {
  const purchased = db.prepare('SELECT 1 FROM user_purchased_skins WHERE twitch_user_id = ? AND skin_type = ? AND skin_id = ?').get(twitchUserId, skinType, skinId);
  return !!purchased;
}

function purchaseSkin(twitchUserId, skinType, skinId, price) {
  const currentCoins = getUserCoins(twitchUserId);
  
  if (currentCoins < price) {
    return { success: false, error: 'Недостаточно монет' };
  }
  
  try {
    // Начинаем транзакцию
    db.exec('BEGIN TRANSACTION');
    
    // Списываем монеты
    const newCoins = currentCoins - price;
    updateUserCoins(twitchUserId, newCoins);
    
    // Добавляем скин в купленные
    const insertStmt = db.prepare('INSERT INTO user_purchased_skins (twitch_user_id, skin_type, skin_id) VALUES (?, ?, ?)');
    insertStmt.run(twitchUserId, skinType, skinId);
    
    // Завершаем транзакцию
    db.exec('COMMIT');
    
    return { success: true, newCoins };
  } catch (error) {
    db.exec('ROLLBACK');
    console.error('Error purchasing skin:', error);
    return { success: false, error: 'Ошибка при покупке скина' };
  }
}

function getSkinPrice(skinType, skinId) {
  const skin = db.prepare('SELECT price FROM locked_skins WHERE skin_type = ? AND skin_id = ?').get(skinType, skinId);
  return skin ? skin.price : 0;
}

// Функции для управления ценами скинов
function getAllSkinsWithPrices() {
  // Получаем все доступные части аватара
  const allParts = getAvailableAvatarParts();
  const lockedSkins = getLockedSkins();
  
  // Создаем мапу заблокированных скинов для быстрого поиска
  const lockedMap = new Map();
  lockedSkins.forEach(skin => {
    lockedMap.set(`${skin.skin_type}_${skin.skin_id}`, skin);
  });
  
  // Объединяем все части с информацией о ценах
  const result = [];
  Object.keys(allParts).forEach(skinType => {
    allParts[skinType].forEach(part => {
      const key = `${skinType}_${part.id}`;
      const lockedInfo = lockedMap.get(key);
      
      result.push({
        skinType,
        skinId: part.id,
        name: part.name,
        path: part.path,
        price: lockedInfo ? lockedInfo.price : 0,
        isLocked: !!lockedInfo,
        isLockedValue: lockedInfo ? lockedInfo.is_locked : false
      });
    });
  });
  
  return result;
}

function updateSkinPrice(skinType, skinId, price, isLocked = true) {
  try {
    // Проверяем, существует ли запись
    const existing = db.prepare('SELECT id FROM locked_skins WHERE skin_type = ? AND skin_id = ?').get(skinType, skinId);
    
    if (existing) {
      // Обновляем существующую запись
      const stmt = db.prepare('UPDATE locked_skins SET price = ?, is_locked = ? WHERE skin_type = ? AND skin_id = ?');
      stmt.run(price, isLocked ? 1 : 0, skinType, skinId);
    } else {
      // Создаем новую запись
      const stmt = db.prepare('INSERT INTO locked_skins (skin_type, skin_id, price, is_locked) VALUES (?, ?, ?, ?)');
      stmt.run(skinType, skinId, price, isLocked ? 1 : 0);
    }
    
    return { success: true };
  } catch (error) {
    console.error('Error updating skin price:', error);
    return { success: false, error: 'Failed to update skin price' };
  }
}

function bulkUpdateSkinPrices(skins) {
  let updated = 0;
  const errors = [];
  
  try {
    db.exec('BEGIN TRANSACTION');
    
    skins.forEach(skin => {
      try {
        const result = updateSkinPrice(skin.skinType, skin.skinId, skin.price, skin.isLocked);
        if (result.success) {
          updated++;
        } else {
          errors.push(`${skin.skinType}_${skin.skinId}: ${result.error}`);
        }
      } catch (error) {
        errors.push(`${skin.skinType}_${skin.skinId}: ${error.message}`);
      }
    });
    
    db.exec('COMMIT');
    
    return { updated, errors };
  } catch (error) {
    db.exec('ROLLBACK');
    console.error('Error in bulk update:', error);
    return { updated: 0, errors: [error.message] };
  }
}

// Функция для принудительного обновления всех скинов из файловой системы
function refreshSkinsFromFilesystem() {
  try {
    // Получаем все доступные скины из файловой системы
    const allParts = getAvailableAvatarParts();
    const allSkins = [];
    
    Object.keys(allParts).forEach(skinType => {
      allParts[skinType].forEach(part => {
        allSkins.push({
          skin_type: skinType,
          skin_id: part.id,
          price: getDefaultPriceForSkin(skinType, part.id)
        });
      });
    });
    
    // Проверяем каждый скин и добавляем его в заблокированные, если его там нет
    const insertStmt = db.prepare('INSERT OR IGNORE INTO locked_skins (skin_type, skin_id, price) VALUES (?, ?, ?)');
    let addedCount = 0;
    
    allSkins.forEach(skin => {
      const existing = db.prepare('SELECT id FROM locked_skins WHERE skin_type = ? AND skin_id = ?').get(skin.skin_type, skin.skin_id);
      if (!existing && skin.price > 0) {
        insertStmt.run(skin.skin_type, skin.skin_id, skin.price);
        addedCount++;
      }
    });
    
    console.log(`[db] Refreshed skins from filesystem: ${addedCount} new skins added`);
    return { success: true, addedCount, totalSkins: allSkins.length };
  } catch (error) {
    console.error('[db] Error refreshing skins from filesystem:', error);
    return { success: false, error: error.message };
  }
}

// Аватар функции
const upsertAvatarStmt = db.prepare(`
INSERT INTO user_avatars (twitch_user_id, body_skin, face_skin, clothes_type, others_type, updated_at)
VALUES (@twitch_user_id, @body_skin, @face_skin, @clothes_type, @others_type, @updated_at)
ON CONFLICT(twitch_user_id) DO UPDATE SET
  body_skin=excluded.body_skin,
  face_skin=excluded.face_skin,
  clothes_type=excluded.clothes_type,
  others_type=excluded.others_type,
  updated_at=excluded.updated_at
`);

function saveOrUpdateAvatar(twitchUserId, avatarData) {
  const now = Math.floor(Date.now() / 1000);
  upsertAvatarStmt.run({
    twitch_user_id: twitchUserId,
    body_skin: avatarData.body_skin || 'body_skin_1',
    face_skin: avatarData.face_skin || 'face_skin_1',
    clothes_type: avatarData.clothes_type || 'clothes_type_1',
    others_type: avatarData.others_type || 'others',
    updated_at: now
  });
}

function getAvatarByTwitchId(twitchUserId) {
  return db.prepare('SELECT * FROM user_avatars WHERE twitch_user_id = ?').get(twitchUserId);
}

// Gift statistics functions
function addGiftToUser(twitchUserId, giftType, giftId) {
  const now = Math.floor(Date.now() / 1000);
  
  // Check if gift record exists
  const existingGift = db.prepare(`
    SELECT * FROM user_gifts 
    WHERE twitch_user_id = ? AND gift_type = ? AND gift_id = ?
  `).get(twitchUserId, giftType, giftId);
  
  if (existingGift) {
    // Update existing gift count
    db.prepare(`
      UPDATE user_gifts 
      SET count = count + 1, updated_at = ?
      WHERE twitch_user_id = ? AND gift_type = ? AND gift_id = ?
    `).run(now, twitchUserId, giftType, giftId);
  } else {
    // Insert new gift record
    db.prepare(`
      INSERT INTO user_gifts (twitch_user_id, gift_type, gift_id, count, created_at, updated_at)
      VALUES (?, ?, ?, 1, ?, ?)
    `).run(twitchUserId, giftType, giftId, now, now);
  }
}

function getUserGifts(twitchUserId) {
  return db.prepare(`
    SELECT gift_type, gift_id, count, created_at, updated_at
    FROM user_gifts 
    WHERE twitch_user_id = ?
    ORDER BY updated_at DESC
  `).all(twitchUserId);
}

function getUserGiftStats(twitchUserId) {
  const stats = db.prepare(`
    SELECT 
      gift_type,
      COUNT(*) as unique_gifts,
      SUM(count) as total_gifts
    FROM user_gifts 
    WHERE twitch_user_id = ?
    GROUP BY gift_type
  `).all(twitchUserId);
  
  return stats;
}

function getRandomGift() {
  const giftTypes = Object.values(GIFT_TYPES);
  const randomType = giftTypes[Math.floor(Math.random() * giftTypes.length)];
  const availableIds = GIFT_IDS[randomType];
  const randomId = availableIds[Math.floor(Math.random() * availableIds.length)];
  
  return {
    type: randomType,
    id: randomId,
    path: `/parts/gift_${randomType}/gift_${randomType}_${randomId}.png`
  };
}

// Avatar customization functions
function getAvailableAvatarParts() {
  const partsDir = path.join(__dirname, 'parts');
  const layers = ['body', 'face', 'clothes', 'others'];
  const availableParts = {};

  layers.forEach(layer => {
    const layerDir = path.join(partsDir, layer);
    if (fs.existsSync(layerDir)) {
      const files = fs.readdirSync(layerDir)
        .filter(file => file.endsWith('.png'))
        .map(file => {
          const name = file.replace('.png', '');
          return {
            id: name,
            name: name.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()),
            path: `/parts/${layer}/${file}`
          };
        });
      availableParts[layer] = files;
    } else {
      availableParts[layer] = [];
    }
  });

  return availableParts;
}

function getAvailableGifts() {
  const partsDir = path.join(__dirname, 'parts');
  const giftTypes = ['gift_common', 'gift_uncommon', 'gift_rare'];
  const availableGifts = {};

  giftTypes.forEach(giftType => {
    const giftDir = path.join(partsDir, giftType);
    if (fs.existsSync(giftDir)) {
      const files = fs.readdirSync(giftDir)
        .filter(file => file.endsWith('.png'))
        .map(file => {
          const name = file.replace('.png', '');
          const rarity = giftType.replace('gift_', '');
          return {
            id: name,
            name: name.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()),
            path: `/parts/${giftType}/${file}`,
            rarity: rarity
          };
        });
      availableGifts[giftType] = files;
    } else {
      availableGifts[giftType] = [];
    }
  });

  return availableGifts;
}

function updateAvatarPart(twitchUserId, partType, partId) {
  const now = Math.floor(Date.now() / 1000);
  
  // Check if avatar exists
  const existingAvatar = getAvatarByTwitchId(twitchUserId);
  if (!existingAvatar) {
    return false;
  }

  // Map part types to database fields
  const fieldMap = {
    'body': 'body_skin',
    'face': 'face_skin', 
    'clothes': 'clothes_type',
    'others': 'others_type'
  };
  
  const updateField = fieldMap[partType];
  if (!updateField) {
    return false;
  }
  
  db.prepare(`
    UPDATE user_avatars 
    SET ${updateField} = ?, updated_at = ?
    WHERE twitch_user_id = ?
  `).run(partId, now, twitchUserId);
  
  return true;
}

// User-streamer relationship functions
function addUserToStreamer(userTwitchId, streamerTwitchId) {
  try {
    db.prepare(`
      INSERT OR IGNORE INTO user_streamers (user_twitch_id, streamer_twitch_id)
      VALUES (?, ?)
    `).run(userTwitchId, streamerTwitchId);
    return true;
  } catch (error) {
    console.error('Error adding user to streamer:', error);
    return false;
  }
}

function getStreamerUsers(streamerTwitchId, searchQuery = '') {
  let sql = `
    SELECT DISTINCT 
      u.twitch_user_id,
      u.display_name,
      u.login,
      u.profile_image_url,
      ua.body_skin,
      ua.face_skin,
      ua.clothes_type,
      ua.others_type,
      us.created_at
    FROM user_streamers us
    JOIN users u ON us.user_twitch_id = u.twitch_user_id
    LEFT JOIN user_avatars ua ON u.twitch_user_id = ua.twitch_user_id
    WHERE us.streamer_twitch_id = ?
  `;
  
  const params = [streamerTwitchId];
  
  if (searchQuery.trim()) {
    sql += ` AND (u.display_name LIKE ? OR u.login LIKE ?)`;
    const searchPattern = `%${searchQuery.trim()}%`;
    params.push(searchPattern, searchPattern);
  }
  
  sql += ` ORDER BY us.created_at DESC`;
  
  return db.prepare(sql).all(...params);
}

function getUserAvatarPreview(twitchUserId) {
  return db.prepare(`
    SELECT 
      ua.body_skin,
      ua.face_skin,
      ua.clothes_type,
      ua.others_type,
      u.display_name,
      u.login
    FROM user_avatars ua
    JOIN users u ON ua.twitch_user_id = u.twitch_user_id
    WHERE ua.twitch_user_id = ?
  `).get(twitchUserId);
}

function giveGiftToUser(userTwitchId, giftType, giftId) {
  try {
    const now = Math.floor(Date.now() / 1000);
    
    // Convert gift_common -> common, gift_uncommon -> uncommon, gift_rare -> rare
    const normalizedGiftType = giftType.replace('gift_', '');
    
    // Check if gift record exists
    const existingGift = db.prepare(`
      SELECT * FROM user_gifts 
      WHERE twitch_user_id = ? AND gift_type = ? AND gift_id = ?
    `).get(userTwitchId, normalizedGiftType, giftId);
    
    if (existingGift) {
      // Update existing gift count
      db.prepare(`
        UPDATE user_gifts 
        SET count = count + 1, updated_at = ?
        WHERE twitch_user_id = ? AND gift_type = ? AND gift_id = ?
      `).run(now, userTwitchId, normalizedGiftType, giftId);
    } else {
      // Insert new gift record
      db.prepare(`
        INSERT INTO user_gifts (twitch_user_id, gift_type, gift_id, count, created_at, updated_at)
        VALUES (?, ?, ?, 1, ?, ?)
      `).run(userTwitchId, normalizedGiftType, giftId, now, now);
    }
    
    return true;
  } catch (error) {
    console.error('Error giving gift to user:', error);
    return false;
  }
}

// Функции для работы с настройками игр
function setGameSettings(streamerId, settings) {
  try {
    const now = Date.now();
    
    // Проверяем, существует ли запись для этого стримера
    const existing = db.prepare(`
      SELECT streamer_id FROM streamer_game_settings WHERE streamer_id = ?
    `).get(streamerId);
    
    if (existing) {
      // Обновляем существующую запись
      db.prepare(`
        UPDATE streamer_game_settings 
        SET min_participants = ?, max_participants = ?, registration_time = ?, updated_at = ?
        WHERE streamer_id = ?
      `).run(
        settings.minParticipants,
        settings.maxParticipants,
        settings.registrationTime,
        now,
        streamerId
      );
    } else {
      // Создаем новую запись
      db.prepare(`
        INSERT INTO streamer_game_settings 
        (streamer_id, min_participants, max_participants, registration_time, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        streamerId,
        settings.minParticipants,
        settings.maxParticipants,
        settings.registrationTime,
        now,
        now
      );
    }
    
    return true;
  } catch (error) {
    console.error('Error setting game settings:', error);
    return false;
  }
}

function getGameSettings(streamerId) {
  try {
    const settings = db.prepare(`
      SELECT min_participants, max_participants, registration_time 
      FROM streamer_game_settings 
      WHERE streamer_id = ?
    `).get(streamerId);
    
    if (settings) {
      return {
        minParticipants: settings.min_participants,
        maxParticipants: settings.max_participants,
        registrationTime: settings.registration_time
      };
    } else {
      // Возвращаем значения по умолчанию
      return {
        minParticipants: 1,
        maxParticipants: 10,
        registrationTime: 10
      };
    }
  } catch (error) {
    console.error('Error getting game settings:', error);
    return {
      minParticipants: 1,
      maxParticipants: 10,
      registrationTime: 10
    };
  }
}

// Функции для работы с подарками
function getGiftInfo(giftType, giftId) {
  try {
    console.log(`[DB] getGiftInfo called with: giftType=${giftType}, giftId=${giftId}`);
    
    const gift = db.prepare(`
      SELECT name, description FROM gifts 
      WHERE gift_type = ? AND gift_id = ?
    `).get(giftType, giftId);
    
    console.log(`[DB] Found gift:`, gift);
    
    if (gift) {
      return {
        name: gift.name,
        description: gift.description
      };
    } else {
      // Возвращаем дефолтное название если подарок не найден
      console.log(`[DB] Gift not found, returning default name`);
      return {
        name: `Подарок ${giftType} #${giftId}`,
        description: `Подарок типа ${giftType}`
      };
    }
  } catch (error) {
    console.error('Error getting gift info:', error);
    return {
      name: `Подарок ${giftType} #${giftId}`,
      description: `Подарок типа ${giftType}`
    };
  }
}

function getAllGifts() {
  try {
    const gifts = db.prepare(`
      SELECT id, gift_type, gift_id, name, description 
      FROM gifts 
      ORDER BY gift_type, gift_id
    `).all();
    
    return gifts;
  } catch (error) {
    console.error('Error getting all gifts:', error);
    return [];
  }
}

function updateGiftInfo(giftType, giftId, name, description) {
  try {
    const now = Date.now();
    const giftIdStr = `gift_${giftType}_${giftId}`;
    
    const existing = db.prepare(`SELECT id FROM gifts WHERE id = ?`).get(giftIdStr);
    
    if (existing) {
      // Обновляем существующий подарок
      db.prepare(`
        UPDATE gifts 
        SET name = ?, description = ?, updated_at = ?
        WHERE id = ?
      `).run(name, description, now, giftIdStr);
    } else {
      // Создаем новый подарок
      db.prepare(`
        INSERT INTO gifts (id, gift_type, gift_id, name, description, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(giftIdStr, giftType, giftId, name, description, now, now);
    }
    
    return true;
  } catch (error) {
    console.error('Error updating gift info:', error);
    return false;
  }
}

module.exports = {
  saveOrUpdateUser,
  getUserByTwitchId,
  getUserByLogin,
  getAllUsers,
  saveOrUpdateAvatar,
  getAvatarByTwitchId,
  addGiftToUser,
  getUserGifts,
  getUserGiftStats,
  getRandomGift,
  getAvailableAvatarParts,
  getAvailableGifts,
  updateAvatarPart,
  addUserToStreamer,
  getStreamerUsers,
  getUserAvatarPreview,
  giveGiftToUser,
  getUserCoins,
  updateUserCoins,
  addUserCoins,
  getLockedSkins,
  getUserPurchasedSkins,
  isSkinPurchased,
  purchaseSkin,
  getSkinPrice,
  getAllSkinsWithPrices,
  updateSkinPrice,
  bulkUpdateSkinPrices,
  getDefaultPriceForSkin,
  refreshSkinsFromFilesystem,
  updateUserDAConnection,
  getUserDAConnection,
  getUsersWithDAConnection,
  upsertStreamerDA,
  getStreamerDA,
  getAllStreamers,
  markDonationProcessed,
  isDonationProcessed,
  setUserDA,
  findUserByDAUserId,
  findUserByNormalizedLogin,
  setAvatarTimeoutSeconds,
  getAvatarTimeoutSeconds,
  setGameSettings,
  getGameSettings,
  getGiftInfo,
  getAllGifts,
  updateGiftInfo,
  GIFT_TYPES,
  GIFT_IDS,
  db
};
