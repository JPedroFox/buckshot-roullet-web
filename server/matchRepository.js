'use strict';

const { pool } = require('./db');

/**
 * Salva o resultado de uma partida PvP encerrada: cria a linha em
 * `matches`, uma linha em `match_players` por jogador, e atualiza as
 * estatísticas em `users` (seção 10: +1 ponto por vitória, -0.5 por
 * derrota, só conta PvP).
 *
 * Tudo dentro de uma transação -- ou tudo é salvo, ou nada é (evita
 * partida meio-salva se o processo cair no meio do caminho).
 *
 * @param {Object} params
 * @param {'pvp'} params.mode
 * @param {'finished'|'abandoned'} params.status
 * @param {Array<{ userId: number, finalLives: number, result: 'win'|'loss' }>} params.players
 * @returns {Promise<number>} o id da partida criada
 */
async function saveMatchResult({ mode, status, players }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const matchResult = await client.query(
      `INSERT INTO matches (mode, status, ended_at) VALUES ($1, $2, now()) RETURNING id`,
      [mode, status]
    );
    const matchId = matchResult.rows[0].id;

    for (const p of players) {
      await client.query(
        `INSERT INTO match_players (match_id, user_id, final_lives, result)
         VALUES ($1, $2, $3, $4)`,
        [matchId, p.userId, p.finalLives, p.result]
      );

      // Ranking (seção 10) só conta PvP, e só se tivermos um user_id de
      // verdade (defensivo -- em teoria sempre teremos, já que só
      // usuários autenticados entram em partida).
      if (mode === 'pvp' && p.userId) {
        const isWin = p.result === 'win';
        const isLoss = p.result === 'loss';
        const pointsDelta = isWin ? 1 : isLoss ? -0.5 : 0;

        await client.query(
          `UPDATE users SET
             total_wins    = total_wins + $2,
             total_losses  = total_losses + $3,
             season_wins   = season_wins + $2,
             season_losses = season_losses + $3,
             season_points = season_points + $4
           WHERE id = $1`,
          [p.userId, isWin ? 1 : 0, isLoss ? 1 : 0, pointsDelta]
        );
      }
    }

    await client.query('COMMIT');
    return matchId;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { saveMatchResult };
