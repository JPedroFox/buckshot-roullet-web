'use strict';

const express = require('express');
const { requireAuthHeader } = require('./authMiddleware');
const { getLeaderboard, resetSeason, getSeasonStartedAt } = require('./rankingRepository');
const { hasCompletedPveMatch } = require('./matchRepository');

const router = express.Router();

router.get('/leaderboard', requireAuthHeader, async (req, res) => {
  try {
    const pveDone = await hasCompletedPveMatch(req.user.sub);
    if (!pveDone) {
      return res.status(403).json({
        error: 'Vença uma partida de PvE (as 3 fases) primeiro antes de ver o ranking.',
      });
    }

    const [leaderboard, seasonStartedAt] = await Promise.all([
      getLeaderboard(),
      getSeasonStartedAt(),
    ]);
    res.status(200).json({ leaderboard, seasonStartedAt });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('leaderboard error:', err);
    res.status(500).json({ error: 'erro interno' });
  }
});

/**
 * Reset manual de temporada -- REMENDO TEMPORÁRIO, não é um sistema de
 * admin de verdade. O schema ainda não tem conceito de "usuário admin"
 * (nenhuma coluna de role em `users`), então a única proteção aqui é
 * uma chave secreta fixa via variável de ambiente (ADMIN_RESET_KEY),
 * comparada num header customizado. Isso é aceitável só porque esse é
 * um projeto pessoal em fase de teste com poucos usuários confiáveis.
 * Antes de qualquer uso real, isso precisa virar um painel de admin de
 * verdade com autenticação própria (role no banco, não uma chave
 * estática que qualquer um com acesso ao .env consegue usar).
 */
router.post('/reset-season', async (req, res) => {
  const expectedKey = process.env.ADMIN_RESET_KEY;
  if (!expectedKey) {
    return res.status(500).json({
      error: 'ADMIN_RESET_KEY não configurada no servidor -- defina a variável de ambiente antes de usar esse endpoint',
    });
  }

  const providedKey = req.headers['x-admin-key'];
  if (providedKey !== expectedKey) {
    return res.status(403).json({ error: 'chave de admin inválida' });
  }

  try {
    await resetSeason();
    res.status(200).json({ message: 'temporada resetada com sucesso' });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('reset-season error:', err);
    res.status(500).json({ error: 'erro interno' });
  }
});

module.exports = router;
