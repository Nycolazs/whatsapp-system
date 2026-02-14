'use strict';

const { createLogger } = require('../logger');

const auditLogger = createLogger('audit');

function logAudit({ action, userId, userName, userType, details, ip, result = 'success' }) {
  const entry = {
    timestamp: new Date().toISOString(),
    action,
    userId: userId || null,
    userName: userName || null,
    userType: userType || null,
    ip: ip || null,
    result,
    details: details || null,
  };

  if (result === 'success') {
    auditLogger.info(`[AUDIT] ${action}`, entry);
  } else {
    auditLogger.warn(`[AUDIT] ${action} (${result})`, entry);
  }
}

function auditMiddleware(action) {
  return (req, res, next) => {
    const originalJson = res.json.bind(res);
    const originalStatus = res.status.bind(res);
    let statusCode = 200;

    res.status = function (code) {
      statusCode = code;
      return originalStatus(code);
    };

    res.json = function (body) {
      const result = statusCode >= 200 && statusCode < 300 ? 'success' : 'failure';
      
      logAudit({
        action,
        userId: req.session?.userId || req.userId || null,
        userName: req.session?.userName || req.userName || null,
        userType: req.session?.userType || req.userType || null,
        ip: req.ip || req.connection?.remoteAddress,
        result,
        details: {
          statusCode,
          errorMessage: body?.error || null,
        },
      });

      return originalJson(body);
    };

    next();
  };
}

module.exports = {
  logAudit,
  auditMiddleware,
};
