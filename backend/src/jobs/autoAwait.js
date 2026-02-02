function startAutoAwaitJob({ db, intervalMs = 60 * 1000, logger = console }) {
  if (!db) {
    throw new Error('startAutoAwaitJob: db is required');
  }

  // Job periódico: verifica tickets em 'em_atendimento' e move para 'aguardando' se ultrapassar o timeout configurado
  function processAutoAwait() {
    try {
      const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('await_minutes');
      const minutes = row ? parseInt(row.value || '0', 10) : 0;
      if (!minutes || minutes <= 0) return;

      const cutoff = new Date(Date.now() - minutes * 60000)
        .toISOString()
        .replace('T', ' ')
        .slice(0, 19);

      const result = db
        .prepare(
          "UPDATE tickets SET status = 'aguardando', seller_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE status = 'em_atendimento' AND updated_at <= ?"
        )
        .run(cutoff);

      if (result && result.changes > 0) {
        logger.log(`Auto-await: moved ${result.changes} tickets to 'aguardando' (timeout ${minutes} min)`);
      }
    } catch (err) {
      logger.error('Error processing auto-await:', err);
    }
  }

  const intervalId = setInterval(processAutoAwait, intervalMs);

  return {
    stop() {
      clearInterval(intervalId);
    },
  };
}

module.exports = {
  startAutoAwaitJob,
};
