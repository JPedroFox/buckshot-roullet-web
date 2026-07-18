'use strict';

const { pool } = require('./db');

// Piso de classificação (seção 10): mínimo de partidas PvP na temporada
// atual pra aparecer no ranking oficial.
const MIN_MATCHES_FOR_RANKING = 10;

/**
 * Estatísticas de um usuário, já com os campos derivados de
 * classificação calculados (não ficam armazenados no banco, são
 * derivados de season_wins + season_losses a cada consulta).
 */
async function getUserStats(userId) {
  const result = await pool.query(
    `SELECT username, season_wins, season_losses, season_points, total_wins, total_losses
     FROM users WHERE id = $1`,
    [userId]
  );
  if (result.rows.length === 0) return null;

  const row = result.rows[0];
  const seasonGamesPlayed = row.season_wins + row.season_losses;
  const qualified = seasonGamesPlayed >= MIN_MATCHES_FOR_RANKING;

  return {
    username: row.username,
    seasonWins: row.season_wins,
    seasonLosses: row.season_losses,
    seasonPoints: row.season_points,
    totalWins: row.total_wins,
    totalLosses: row.total_losses,
    seasonGamesPlayed,
    qualified,
    gamesUntilQualified: qualified ? 0 : MIN_MATCHES_FOR_RANKING - seasonGamesPlayed,
  };
}

/**
 * Ranking oficial: só usuários classificados (piso de partidas
 * cumprido), ordenados por pontos da temporada (seção 10: +1 vitória,
 * -0.5 derrota). Empate desempatado por número de vitórias.
 */
async function getLeaderboard(limit = 50) {
  const result = await pool.query(
    `SELECT username, season_wins, season_losses, season_points
     FROM users
     WHERE (season_wins + season_losses) >= $1
     ORDER BY season_points DESC, season_wins DESC, username ASC
     LIMIT $2`,
    [MIN_MATCHES_FOR_RANKING, limit]
  );

  return result.rows.map((row, index) => ({
    rank: index + 1,
    username: row.username,
    seasonWins: row.season_wins,
    seasonLosses: row.season_losses,
    seasonPoints: row.season_points,
  }));
}

/**
 * Reset de temporada (seção 10): zera season_wins/season_losses/
 * season_points de TODOS os usuários. total_wins/total_losses
 * (histórico vitalício) NÃO são tocados. Sem tabela de snapshot --
 * o histórico da temporada anterior é perdido de propósito, conforme
 * o design.
 */
async function resetSeason() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE users SET season_wins = 0, season_losses = 0, season_points = 0`
    );
    await client.query(
      `INSERT INTO app_settings (key, value) VALUES ('season_started_at', now()::text)
       ON CONFLICT (key) DO UPDATE SET value = now()::text`
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function getSeasonStartedAt() {
  const result = await pool.query(`SELECT value FROM app_settings WHERE key = 'season_started_at'`);
  return result.rows.length > 0 ? result.rows[0].value : null;
}

module.exports = {
  MIN_MATCHES_FOR_RANKING,
  getUserStats,
  getLeaderboard,
  resetSeason,
  getSeasonStartedAt,
};
