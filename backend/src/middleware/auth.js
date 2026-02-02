function requireAuth(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: 'Não autenticado' });
  }

  req.userId = req.session.userId;
  req.userType = req.session.userType;
  req.userName = req.session.userName;
  return next();
}

function requireAdmin(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: 'Não autenticado' });
  }

  if (req.session.userType !== 'admin') {
    return res.status(403).json({ error: 'Acesso negado. Apenas admin.' });
  }

  req.userId = req.session.userId;
  req.userType = req.session.userType;
  req.userName = req.session.userName;
  return next();
}

module.exports = {
  requireAuth,
  requireAdmin,
};
