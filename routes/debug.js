const { emit, emitToStreamer, getAllSubscriberCounts } = require('../lib/bus');
const { logLine } = require('../lib/logger');
const { getUserByTwitchId } = require('../db');
const { findUserByUsername } = require('../lib/donationalerts');

function registerDebugRoutes(app) {
  // Страница диагностики
  app.get('/debug', (req, res) => {
    res.sendFile('debug.html', { root: __dirname + '/..' });
  });

  // Тестовая страница overlay
  app.get('/test-overlay', (req, res) => {
    res.sendFile('test-overlay.html', { root: __dirname + '/..' });
  });

  // Получение количества подписчиков
  app.get('/debug/subscribers', (req, res) => {
    const counts = getAllSubscriberCounts();
    const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
    res.json({ ...counts, total });
  });

  // Отправка тестового доната (новый метод через processDonation)
  app.post('/debug/fake-donation', async (req, res) => {
    try {
      const { streamer_twitch_id, da_user_id, username, amount, message, currency = 'RUB' } = req.body;
      
      if (!streamer_twitch_id) {
        return res.status(400).json({ error: 'Требуется streamer_twitch_id' });
      }

      logLine(`[DEBUG] Отправка тест-доната через processDonation: ${username} - ${amount} ${currency}`);
      logLine(`[DEBUG] Streamer ID: ${streamer_twitch_id}, DA User ID: ${da_user_id || 'none'}`);

      // Создаем фейковый объект доната в формате DonationAlerts API
      const fakeDonation = {
        id: `debug_${Date.now()}`,
        username: username,
        amount: amount,
        message: message || 'Тестовый донат',
        currency: currency,
        user_id: da_user_id || null, // DA user_id если есть
        created_at: new Date().toISOString()
      };
      
      logLine(`[DEBUG] Created fake donation object:`, JSON.stringify(fakeDonation, null, 2));

      // Используем новый процесс обработки донатов
      const { processDonation } = require('../lib/donationalerts-poll');
      
      try {
        await processDonation(streamer_twitch_id, fakeDonation);
      } catch (processError) {
        console.error(`[DEBUG] Error in processDonation:`, processError.message);
        // Продолжаем выполнение, так как это может быть ожидаемая ошибка
      }

      logLine(`[DEBUG] Тест-донат обработан через processDonation для стримера ${streamer_twitch_id}`);
      
      res.json({ 
        success: true, 
        message: `Тест-донат обработан для стримера ${streamer_twitch_id}`,
        donation: fakeDonation
      });

    } catch (error) {
      logLine(`[DEBUG] Ошибка обработки тест-доната: ${error.message}`);
      res.status(500).json({ error: error.message });
    }
  });

  // Отправка тестового аватара
  app.post('/debug/fake-spawn', async (req, res) => {
    try {
      const { streamer_id, username } = req.body;
      
      if (!streamer_id || !username) {
        return res.status(400).send('Требуются streamer_id и username');
      }

      logLine(`[DEBUG] Отправка тест-аватара: ${username}`);

      // Ищем пользователя
      let user = await findUserByUsername(username);
      if (!user) {
        return res.status(404).send(`Пользователь ${username} не найден`);
      }

      // Получаем данные аватара
      const { getAvatarByTwitchId } = require('../db');
      let avatarData = getAvatarByTwitchId(user.twitch_user_id);
      
      if (!avatarData) {
        avatarData = {
          body_skin: 'body_skin_1',
          face_skin: 'face_skin_1',
          clothes_type: 'clothes_type_1',
          others_type: 'others_1'
        };
      }

      // Отправляем события
      const spawnData = {
        userId: user.twitch_user_id,
        displayName: user.display_name || username,
        color: null,
        avatarData,
        ts: Date.now(),
        source: 'debug_spawn'
      };

      emit('spawn', spawnData);
      emitToStreamer(streamer_id, 'spawn', spawnData);
      emitToStreamer(streamer_id, 'avatar:show', {
        streamerId: streamer_id,
        twitchUserId: user.twitch_user_id,
        avatarData,
        source: 'debug_spawn'
      });

      logLine(`[DEBUG] Тест-аватар отправлен для ${username}`);
      
      res.json({ 
        success: true, 
        message: `Тест-аватар отправлен для ${username}`,
        user: {
          twitch_user_id: user.twitch_user_id,
          display_name: user.display_name
        }
      });

    } catch (error) {
      logLine(`[DEBUG] Ошибка отправки тест-аватара: ${error.message}`);
      res.status(500).json({ error: error.message });
    }
  });

  // Получение списка пользователей
  app.get('/debug/users', (req, res) => {
    try {
      const { getAllUsers } = require('../db');
      const users = getAllUsers();
      res.json(users.map(user => ({
        twitch_user_id: user.twitch_user_id,
        display_name: user.display_name,
        login: user.login,
        da_user_id: user.da_user_id,
        da_username: user.da_username,
        has_avatar: !!user.avatar_data
      })));
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Получение списка стримеров с DA
  app.get('/debug/streamers', (req, res) => {
    try {
      const { getAllStreamers } = require('../db');
      const streamers = getAllStreamers();
      res.json(streamers.map(streamer => ({
        streamer_twitch_id: streamer.streamer_twitch_id,
        twitch_login: streamer.twitch_login,
        da_user_id: streamer.da_user_id,
        status: streamer.status,
        has_token: !!streamer.da_access_token,
        expires_at: streamer.da_expires_at
      })));
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Тест нормализации имени
app.get('/debug/test-normalize', (req, res) => {
  try {
    const { findUserByNormalizedLogin } = require('../db');
    const { username } = req.query;

    if (!username) {
      return res.status(400).json({ error: 'Требуется параметр username' });
    }

    const normalized = username.trim().toLowerCase().replace(/\s+/g, ' ').replace(/[_\-]+/g, '_');
    const user = findUserByNormalizedLogin(username);

    res.json({
      original: username,
      normalized: normalized,
      found_user: user ? {
        twitch_user_id: user.twitch_user_id,
        display_name: user.display_name,
        login: user.login,
        da_user_id: user.da_user_id,
        da_username: user.da_username
      } : null
    });
  } catch (error) {
    res.status(500).json({ error: error.message, stack: error.stack });
  }
});

  app.get('/debug/config', (req, res) => {
    try {
      const { DA_CLIENT_ID, DA_CLIENT_SECRET, DA_REDIRECT_URI } = require('../lib/config');
      
      res.json({
        DA_CLIENT_ID: DA_CLIENT_ID ? `${DA_CLIENT_ID.substring(0, 4)}...` : 'MISSING',
        DA_CLIENT_SECRET: DA_CLIENT_SECRET ? 'SET' : 'MISSING',
        DA_REDIRECT_URI: DA_REDIRECT_URI || 'MISSING',
        has_client_id: !!DA_CLIENT_ID,
        has_client_secret: !!DA_CLIENT_SECRET,
        has_redirect_uri: !!DA_REDIRECT_URI
      });
    } catch (error) {
      res.status(500).json({ error: error.message, stack: error.stack });
    }
  });

  // Простой тест доната для текущего пользователя
  app.post('/debug/test-my-donation', async (req, res) => {
    try {
      const uid = req.cookies.uid;
      if (!uid) {
        return res.status(401).json({ error: 'Необходимо войти в систему' });
      }

      const { username = 'TestUser', amount = 100, message = 'Тестовый донат' } = req.body;

      logLine(`[DEBUG] Тест доната для пользователя ${uid}: ${username} - ${amount} RUB`);

      // Создаем фейковый объект доната
      const fakeDonation = {
        id: `test_${Date.now()}`,
        username: username,
        amount: amount,
        message: message,
        currency: 'RUB',
        user_id: null, // Будет матчиться по нику
        created_at: new Date().toISOString()
      };

      // Используем процесс обработки донатов
      const { processDonation } = require('../lib/donationalerts-poll');
      await processDonation(uid, fakeDonation);

      res.json({ 
        success: true, 
        message: `Тестовый донат от ${username} отправлен для стримера ${uid}`,
        donation: fakeDonation
      });
    } catch (error) {
      logLine(`[DEBUG] Ошибка тест-доната: ${error.message}`);
      res.status(500).json({ error: error.message, stack: error.stack });
    }
  });


  // Очистка кэша аватаров
  app.post('/debug/clear-avatar-cache', (req, res) => {
    try {
      const { userId } = req.body;
      
      if (userId) {
        emit('clearAvatarCache', { userId });
        logLine(`[DEBUG] Кэш аватара очищен для пользователя ${userId}`);
        res.json({ success: true, message: `Кэш аватара очищен для ${userId}` });
      } else {
        // Очистка всего кэша
        emit('clearAvatarCache', { userId: 'all' });
        logLine(`[DEBUG] Весь кэш аватаров очищен`);
        res.json({ success: true, message: 'Весь кэш аватаров очищен' });
      }
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });
}

module.exports = { registerDebugRoutes };
