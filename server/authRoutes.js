'use strict';

const express = require('express');
const { registerUser, loginUser, AuthError } = require('./auth');

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

module.exports = router;
