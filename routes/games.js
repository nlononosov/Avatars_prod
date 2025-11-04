const express = require('express');

function registerGameRoutes(app) {
  // Запуск обычной гонки
  app.post('/api/game/race/start', express.json(), async (req, res) => {
    try {
      const uid = req.cookies.uid;
      if (!uid) return res.status(401).json({ error: 'Unauthorized' });

      const { ensureBotFor, getBotClientFor, getBotChannelFor, getStreamerState, startRace } = require('../services/bot');
      let client = getBotClientFor(uid);
      if (!client) {
        try { await ensureBotFor(String(uid)); } catch (e) {}
        client = getBotClientFor(uid);
      }
      const channel = getBotChannelFor(uid);
      if (!client || !channel) return res.status(400).json({ error: 'Bot not connected' });

      const { raceState } = getStreamerState(uid);
      const settings = {
        minParticipants: Number(req.body?.minParticipants) || 1,
        maxParticipants: Number(req.body?.maxParticipants) || 10,
        registrationTime: Number(req.body?.registrationTime) || 10
      };
      startRace(uid, client, channel, raceState, settings);
      return res.json({ success: true, message: 'Гонка объявлена в чате' });
    } catch (error) {
      console.error('[games] race start error:', error);
      return res.status(500).json({ error: 'Failed to start race' });
    }
  });

  // Запуск гонки на самолетах
  app.post('/api/game/plane/start', express.json(), async (req, res) => {
    try {
      const uid = req.cookies.uid;
      if (!uid) return res.status(401).json({ error: 'Unauthorized' });

      const { ensureBotFor, getBotClientFor, getBotChannelFor, getStreamerState, startRacePlan } = require('../services/bot');
      let client = getBotClientFor(uid);
      if (!client) {
        try { await ensureBotFor(String(uid)); } catch (e) {}
        client = getBotClientFor(uid);
      }
      const channel = getBotChannelFor(uid);
      if (!client || !channel) return res.status(400).json({ error: 'Bot not connected' });

      const { racePlanState, Game } = getStreamerState(uid);
      const settings = {
        minParticipants: Number(req.body?.minParticipants) || 1,
        maxParticipants: Number(req.body?.maxParticipants) || 8,
        registrationTime: Number(req.body?.registrationTime) || 10
      };
      startRacePlan(uid, client, channel, settings);
      return res.json({ success: true, message: 'Гонка на самолетах объявлена в чате' });
    } catch (error) {
      console.error('[games] plane race start error:', error);
      return res.status(500).json({ error: 'Failed to start plane race' });
    }
  });

  // Запуск игры "Собери еду"
  app.post('/api/game/food/start', express.json(), async (req, res) => {
    try {
      const uid = req.cookies.uid;
      if (!uid) return res.status(401).json({ error: 'Unauthorized' });

      const { ensureBotFor, getBotClientFor, getBotChannelFor, getStreamerState, startFoodGame } = require('../services/bot');
      let client = getBotClientFor(uid);
      if (!client) {
        try { await ensureBotFor(String(uid)); } catch (e) {}
        client = getBotClientFor(uid);
      }
      const channel = getBotChannelFor(uid);
      if (!client || !channel) return res.status(400).json({ error: 'Bot not connected' });

      const { foodGameState } = getStreamerState(uid);
      const settings = {
        minParticipants: Number(req.body?.minParticipants) || 1,
        maxParticipants: Number(req.body?.maxParticipants) || 10,
        registrationTime: Number(req.body?.registrationTime) || 10
      };
      startFoodGame(uid, client, channel, settings);
      return res.json({ success: true, message: 'Игра объявлена в чате' });
    } catch (error) {
      console.error('[games] food start error:', error);
      return res.status(500).json({ error: 'Failed to start food game' });
    }
  });
}

module.exports = { registerGameRoutes };


