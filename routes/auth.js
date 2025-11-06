const path = require('path');
const crypto = require('crypto');
const { BASE_URL, CLIENT_ID, CLIENT_SECRET, SCOPES, isClientIdValid, isClientSecretValid } = require('../lib/config');
const { logLine } = require('../lib/logger');
const { saveOrUpdateUser } = require('../db');

const TWITCH_CONFIG_ERROR_MESSAGE = [
  '❌ Неверный или не установлен Client ID.',
  'ВАЖНО: Проверьте следующие пункты:',
  '1. Откройте файл .env в корне проекта',
  '2. Найдите строку TWITCH_CLIENT_ID=',
  '3. Убедитесь, что значение:',
  '   - НЕ является "your_twitch_client_id" или другой заглушкой',
  '   - НЕ содержит лишних пробелов или кавычек',
  '   - Начинается с реального Client ID (обычно строка из ~30 символов)',
  '4. Получите реальный Client ID:',
  '   - Зайдите на https://dev.twitch.tv/console/apps',
  '   - Создайте приложение или используйте существующее',
  '   - Скопируйте Client ID',
  '5. Установите Redirect URI в настройках приложения: http://localhost:3000/auth/twitch/callback',
  '6. Сохраните .env файл и перезапустите сервер',
  'Если используете Client Secret, также проверьте TWITCH_CLIENT_SECRET.'
].join('\n');

const TWITCH_CONFIG_ERROR_CODE = 'twitch_config_missing';

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[ch] || ch));
}

function renderTwitchConfigError(details) {
  const fullMessage = details ? `${TWITCH_CONFIG_ERROR_MESSAGE}\n\nДетали: ${details}` : TWITCH_CONFIG_ERROR_MESSAGE;
  const html = `<pre>${escapeHtml(fullMessage)}</pre>`;
  return `<!doctype html><meta charset="utf-8">${html}`;
}

function twitchConfigHasErrors() {
  return !isClientIdValid || !isClientSecretValid;
}

function sendTwitchConfigJsonError(res, details) {
  logLine('[oauth] Twitch client configuration is invalid.');
  return res.status(500).json({
    error: TWITCH_CONFIG_ERROR_CODE,
    code: TWITCH_CONFIG_ERROR_CODE,
    message: details ? `${TWITCH_CONFIG_ERROR_MESSAGE}\n\nДетали: ${details}` : TWITCH_CONFIG_ERROR_MESSAGE
  });
}

function sendTwitchConfigHtmlError(res, details) {
  res.setHeader('Cache-Control', 'no-store');
  logLine('[oauth] Twitch client configuration is invalid.');
  return res.status(500).send(renderTwitchConfigError(details));
}

function registerAuthRoutes(app) {
  app.get('/', (_req, res) => {
    res.sendFile(path.join(__dirname, '..', 'index.html'));
  });

  app.get('/auth/status', (req, res) => {
    const uid = req.cookies.uid;
    res.json({ authenticated: Boolean(uid) });
  });

  app.get('/auth/twitch/init', (req, res) => {
    if (twitchConfigHasErrors()) {
      return sendTwitchConfigJsonError(res);
    }

    const state = crypto.randomBytes(16).toString('hex');
    res.cookie('oauth_state', state, { httpOnly: true, sameSite: 'lax' });
    const redirectUri = `${BASE_URL}/auth/twitch/callback`;
    const forceLogin = Boolean(req.cookies.force_login);
    const params = new URLSearchParams({
      client_id: CLIENT_ID,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: SCOPES.join(' '),
      state
    });
    if (forceLogin) params.set('force_verify', 'true');
    const url = `https://id.twitch.tv/oauth2/authorize?${params.toString()}`;
    res.json({ authorizeUrl: url });
  });

  app.get('/auth/twitch', (req, res) => {
    if (twitchConfigHasErrors()) {
      return res.redirect(`/?error=${TWITCH_CONFIG_ERROR_CODE}`);
    }

    const state = crypto.randomBytes(16).toString('hex');
    res.cookie('oauth_state', state, { httpOnly: true, sameSite: 'lax' });
    const redirectUri = `${BASE_URL}/auth/twitch/callback`;
    const forceLogin = Boolean(req.cookies.force_login);
    const params = new URLSearchParams({
      client_id: CLIENT_ID,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: SCOPES.join(' '),
      state
    });
    if (forceLogin) params.set('force_verify', 'true');
    res.redirect(`https://id.twitch.tv/oauth2/authorize?${params.toString()}`);
  });

  app.get('/auth/twitch/callback', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const { code, state, error, error_description } = req.query;
    const savedState = req.cookies.oauth_state;
    res.clearCookie('oauth_state');
    res.clearCookie('force_login');

    if (error) {
      return res.status(400).send(`<meta charset="utf-8"><pre>OAuth error: ${error} — ${error_description || ''}</pre>`);
    }
    if (!state || !savedState || state !== savedState) {
      return res.status(400).send(`<meta charset="utf-8"><pre>Invalid OAuth state</pre><script>setTimeout(()=>window.close(),1)</script>`);
    }
    if (!code) return res.status(400).send(`<meta charset="utf-8"><pre>Missing code</pre>`);

    if (twitchConfigHasErrors()) {
      return sendTwitchConfigHtmlError(res);
    }

    try {
      const redirectUri = `${BASE_URL}/auth/twitch/callback`;
      const tokenParams = new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri
      });

      const tokenResp = await fetch('https://id.twitch.tv/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: tokenParams.toString()
      });
      if (!tokenResp.ok) {
        const txt = await tokenResp.text();
        logLine(`[oauth] token exchange failed: ${tokenResp.status} ${txt}`);
        if (tokenResp.status === 400 && /invalid[_\s-]*client/i.test(txt)) {
          return sendTwitchConfigHtmlError(res, 'Неверный Client ID или Client Secret.');
        }
        return res.status(500).send(`<meta charset="utf-8"><pre>Token exchange failed: ${tokenResp.status}\n${txt}</pre>`);
      }
      const tokenData = await tokenResp.json();

      const userResp = await fetch('https://api.twitch.tv/helix/users', {
        headers: { Authorization: `Bearer ${tokenData.access_token}`, 'Client-ID': CLIENT_ID }
      });
      if (!userResp.ok) {
        const txt = await userResp.text();
        logLine(`[oauth] get user failed: ${userResp.status} ${txt}`);
        return res.status(500).send(`<meta charset=\"utf-8\"><pre>Failed to fetch user</pre>`);
      }
      const userJson = await userResp.json();
      const user = (userJson.data && userJson.data[0]) || null;
      if (!user) return res.status(500).send(`<meta charset="utf-8"><pre>User payload empty</pre>`);

      const expiresAt = tokenData.expires_in ? Math.floor(Date.now() / 1000) + Number(tokenData.expires_in) : null;
      saveOrUpdateUser({
        twitch_user_id: String(user.id),
        display_name: user.display_name || user.login,
        login: user.login,
        profile_image_url: user.profile_image_url || null,
        access_token: tokenData.access_token,
        refresh_token: tokenData.refresh_token || null,
        scope: tokenData.scope || SCOPES,
        expires_at: expiresAt
      });

      res.cookie('uid', String(user.id), { httpOnly: false, sameSite: 'lax' });

      return res.status(200).send(`
      <!doctype html><meta charset="utf-8">
      <script>
        try {
          if (window.opener) {
            window.opener.postMessage({type:'twitch_auth_ok'}, '*');
            window.close();
          } else {
            window.location = '/success';
          }
        } catch (e) { window.location = '/success'; }
      </script>
    `);
    } catch (err) {
      logLine(`[oauth] internal error: ${err?.message || err}`);
      return res.status(500).send(`<meta charset="utf-8"><pre>Internal error: ${err?.message || err}</pre>`);
    }
  });
}

module.exports = { registerAuthRoutes };


