'use strict';

const express = require('express');
const { registerUser, loginUser, AuthError } = require('./auth');
const { requireAuthHeader } = require('./authMiddleware');
const { getUserStats } = require('./rankingRepository');
const { hasCompletedPveMatch } = require('./matchRepository');

const router = express.Router();

router.post('/register', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    const { user, token } = await registerUser(username, password);
    res.status(201).json({ user, token });
  } catch (err) {
    if (err instanceof AuthError) {
      return res.status(400).json({ error: err.message });
    }
    // eslint-disable-next-line no-console
    console.error('register error:', err);
    res.status(500).json({ error: 'erro interno' });
  }
});

router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    const { user, token } = await loginUser(username, password);
    res.status(200).json({ user, token });
  } catch (err) {
    if (err instanceof AuthError) {
      return res.status(401).json({ error: err.message });
    }
    // eslint-disable-next-line no-console
    console.error('login error:', err);
    res.status(500).json({ error: 'erro interno' });
  }
});

router.get('/me', requireAuthHeader, async (req, res) => {
  try {
    const stats = await getUserStats(req.user.sub);
    if (!stats) {
      return res.status(404).json({ error: 'usuário não encontrado' });
    }
    const pveCompleted = await hasCompletedPveMatch(req.user.sub);
    res.status(200).json({ user: { ...stats, pveCompleted } });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('me error:', err);
    res.status(500).json({ error: 'erro interno' });
  }
});

module.exports = router;
