// Centralized configuration
require('dotenv').config();

const path = require('path');

const sanitizeEnv = (value) => (typeof value === 'string' ? value.trim() : '');
const isPlaceholder = (value, placeholders) => {
  if (!value) return true;
  const normalized = value.trim().toLowerCase();
  return placeholders.some((ph) => normalized === ph);
};

const PORT = Number(process.env.PORT || 3000);
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');
const rawClientId = sanitizeEnv(process.env.TWITCH_CLIENT_ID);
const rawClientSecret = sanitizeEnv(process.env.TWITCH_CLIENT_SECRET);
const CLIENT_ID = rawClientId;
const CLIENT_SECRET = rawClientSecret;
const CLIENT_ID_PLACEHOLDERS = ['your_twitch_client_id'];
const CLIENT_SECRET_PLACEHOLDERS = ['your_twitch_client_secret'];
const isClientIdValid = !isPlaceholder(CLIENT_ID, CLIENT_ID_PLACEHOLDERS);
const isClientSecretValid = !isPlaceholder(CLIENT_SECRET, CLIENT_SECRET_PLACEHOLDERS);
const SCOPES = (process.env.TWITCH_SCOPES || 'chat:read chat:edit').split(/\s+/).filter(Boolean);

// YooKassa configuration
const YK_SHOP_ID = sanitizeEnv(process.env.YK_SHOP_ID);
const YK_SECRET_KEY = sanitizeEnv(process.env.YK_SECRET_KEY);

// DonationAlerts configuration
const DA_CLIENT_ID = sanitizeEnv(process.env.DA_CLIENT_ID);
const DA_CLIENT_SECRET = sanitizeEnv(process.env.DA_CLIENT_SECRET);
const DA_REDIRECT_URI = sanitizeEnv(process.env.DA_REDIRECT_URI) || `${BASE_URL}/auth/donationalerts/callback`;

function assertConfig(logFn = console) {
  const miss = [];
  if (!CLIENT_ID || !isClientIdValid) miss.push('TWITCH_CLIENT_ID');
  if (!CLIENT_SECRET || !isClientSecretValid) miss.push('TWITCH_CLIENT_SECRET');
  if (!YK_SHOP_ID) miss.push('YK_SHOP_ID');
  if (!YK_SECRET_KEY) miss.push('YK_SECRET_KEY');
  if (!DA_CLIENT_ID) miss.push('DA_CLIENT_ID');
  if (!DA_CLIENT_SECRET) miss.push('DA_CLIENT_SECRET');
  if (!DA_REDIRECT_URI) miss.push('DA_REDIRECT_URI');
  
  if (miss.length) {
    const error = `[config] Missing required environment variables: ${miss.join(', ')}`;
    logFn.error(error);
    throw new Error(error);
  }
  
  logFn.log('[config] BASE_URL =', BASE_URL);
  logFn.log('[config] SCOPES   =', SCOPES.join(' '));
  logFn.log('[config] YK_SHOP_ID =', YK_SHOP_ID ? 'Set' : 'Missing');
  logFn.log('[config] YK_SECRET_KEY =', YK_SECRET_KEY ? 'Set' : 'Missing');
  logFn.log('[config] DA_CLIENT_ID =', DA_CLIENT_ID ? 'Set' : 'Missing');
  logFn.log('[config] DA_CLIENT_SECRET =', DA_CLIENT_SECRET ? 'Set' : 'Missing');
  logFn.log('[config] DA_REDIRECT_URI =', DA_REDIRECT_URI);
}

module.exports = {
  PORT,
  BASE_URL,
  CLIENT_ID,
  CLIENT_SECRET,
  SCOPES,
  YK_SHOP_ID,
  YK_SECRET_KEY,
  DA_CLIENT_ID,
  DA_CLIENT_SECRET,
  DA_REDIRECT_URI,
  assertConfig,
  isClientIdValid,
  isClientSecretValid,
  rootDir: path.join(__dirname, '..')
};


