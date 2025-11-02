const { Worker } = require('worker_threads');
const path = require('path');

const workerPath = path.join(__dirname, 'worker.js');
let worker = createWorker();
let seq = 0;
const pending = new Map();

function createWorker() {
  const instance = new Worker(workerPath, {
    env: process.env,
  });

  instance.on('message', ({ id, result, error }) => {
    const deferred = pending.get(id);
    if (!deferred) {
      return;
    }

    pending.delete(id);

    if (error) {
      const err = new Error(error.message);
      err.stack = error.stack;
      err.name = error.name;
      deferred.reject(err);
    } else {
      deferred.resolve(result);
    }
  });

  instance.on('error', (error) => {
    console.error('[db:async] Worker crashed:', error);
    restartWorker();
  });

  instance.on('exit', (code) => {
    if (code !== 0) {
      console.error(`[db:async] Worker exited with code ${code}, restarting`);
      restartWorker();
    }
  });

  return instance;
}

function restartWorker() {
  for (const { reject } of pending.values()) {
    reject(new Error('Database worker restarted'));
  }
  pending.clear();
  worker = createWorker();
}

function call(method, args) {
  if (!worker) {
    worker = createWorker();
  }

  const id = ++seq;

  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });

    try {
      worker.postMessage({ id, method, args });
    } catch (error) {
      pending.delete(id);
      reject(error);
    }
  });
}

module.exports = new Proxy({}, {
  get(_target, prop) {
    if (prop === 'terminate') {
      return async () => {
        if (worker) {
          await worker.terminate();
          worker = null;
        }
      };
    }

    return (...args) => call(prop, args);
  }
});

