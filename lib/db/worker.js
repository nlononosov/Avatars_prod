const { parentPort } = require('worker_threads');
const path = require('path');

// Load the synchronous database module inside the worker. All heavy
// better-sqlite3 work will run here, keeping the main event loop free.
const dbPath = path.join(__dirname, '../../db.js');
const dbModule = require(dbPath);

parentPort.on('message', async (message) => {
  const { id, method, args = [] } = message || {};

  if (typeof id === 'undefined') {
    return;
  }

  try {
    const fn = dbModule[method];
    if (typeof fn !== 'function') {
      throw new Error(`db method "${method}" is not available`);
    }

    const result = await Promise.resolve().then(() => fn(...args));
    parentPort.postMessage({ id, result });
  } catch (error) {
    parentPort.postMessage({
      id,
      error: {
        message: error?.message || String(error),
        stack: error?.stack,
        name: error?.name || 'Error'
      }
    });
  }
});

