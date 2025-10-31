const { ensureBotFor, stopBot, status } = require('../services/bot');
const { logLine } = require('../lib/logger');

function registerBotRoutes(app) {
  app.post('/bot/start', async (req, res) => {
    try {
      const uid = req.cookies.uid;
      if (!uid) return res.status(401).send('Неизвестен пользователь (нет cookie uid)');
      
      const { profile } = await ensureBotFor(String(uid));
      res.status(200).send(`✅ Бот успешно запущен и подключён к #${profile.login}. Напиши в чате "!ping" — ответит "pong".`);
    } catch (e) {
      logLine(`[bot] start error: ${e?.message || e}`);
      res.status(500).send('Ошибка запуска бота: ' + (e?.message || e));
    }
  });

  app.post('/bot/stop', async (req, res) => {
    try {
      const uid = req.cookies.uid;
      const changed = await stopBot(uid ? String(uid) : null);
      if (!changed) return res.status(200).send('Бот уже остановлен.');
      res.status(200).send('Бот остановлен.');
    } catch (e) {
      logLine(`[bot] stop error: ${e?.message || e}`);
      res.status(500).send('Ошибка остановки бота: ' + (e?.message || e));
    }
  });

  app.get('/bot/status', (_req, res) => {
    res.json(status());
  });
}

module.exports = { registerBotRoutes };


