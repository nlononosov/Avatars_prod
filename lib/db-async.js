// Упрощенная асинхронная обертка для better-sqlite3
// Использует очередь задач вместо worker threads из-за сложности интеграции

// Простая очередь для асинхронной обработки синхронных вызовов БД
const taskQueue = [];
let processing = false;
let concurrency = parseInt(process.env.DB_CONCURRENCY || '1', 10);

// Обработчик очереди
async function processQueue() {
  if (processing) return;
  
  processing = true;
  
  while (taskQueue.length > 0) {
    const batch = taskQueue.splice(0, Math.min(concurrency, taskQueue.length));
    
    await Promise.all(batch.map(async (task) => {
      try {
        // Выполняем синхронный вызов
        const result = task.fn(...task.args);
        task.resolve(result);
      } catch (error) {
        task.reject(error);
      }
    }));
  }
  
  processing = false;
}

// Удобный интерфейс для вызова методов БД
async function callDb(fn, ...args) {
  return new Promise((resolve, reject) => {
    taskQueue.push({ fn, args, resolve, reject });
    
    if (!processing) {
      setImmediate(processQueue);
    }
  });
}

module.exports = {
  callDb,
  setConcurrency: (c) => {
    concurrency = Math.max(1, parseInt(c, 10));
  },
  getConcurrency: () => concurrency,
  getQueueSize: () => taskQueue.length
};

