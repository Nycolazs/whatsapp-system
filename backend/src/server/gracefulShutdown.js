function installGracefulShutdown({
  getServer,
  onShutdown,
  logger = console,
  exit = process.exit,
  signals = ['SIGTERM', 'SIGINT'],
} = {}) {
  const closeServer = () =>
    new Promise((resolve) => {
      const server = typeof getServer === 'function' ? getServer() : null;
      if (!server) return resolve();
      try {
        server.close(() => resolve());
      } catch (_e) {
        resolve();
      }
    });

  const shutdown = (signal) => {
    try {
      logger.log(`[shutdown] received ${signal}`);
    } catch (_e) {}

    Promise.resolve()
      .then(closeServer)
      .finally(() => {
        try {
          if (typeof onShutdown === 'function') onShutdown(signal);
        } catch (_e) {}
        exit(0);
      });
  };

  for (const signal of signals) {
    process.on(signal, () => shutdown(signal));
  }

  return { shutdown };
}

module.exports = {
  installGracefulShutdown,
};
