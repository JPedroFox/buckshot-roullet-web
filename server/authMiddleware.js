'use strict';

const { verifyToken } = require('./auth');

/**
 * Middleware pra proteger rotas REST com JWT via header:
 * Authorization: Bearer <token>
 * Em caso de sucesso, popula req.user com o payload do token
 * ({ sub: userId, username }).
 */
function requireAuthHeader(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'token ausente' });
  }
  try {
    req.user = verifyToken(token);
    next();
  } catch (err) {
    res.status(401).json({ error: 'token inválido ou expirado' });
  }
}

module.exports = { requireAuthHeader };
