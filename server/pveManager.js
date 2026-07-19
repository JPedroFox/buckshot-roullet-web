'use strict';

const crypto = require('crypto');
const { createPveMatch } = require('../src/core/pve');

/**
 * Store em memória das partidas PvE ativas. Diferente do gameManager
 * de PvP: só 1 jogador humano por partida, sem sala/room de socket
 * (as mensagens vão direto pro socketId do jogador).
 *
 * timers.turnTimer/turnTimerStartedAt/turnTimerRemainingMs reusam as
 * mesmas funções de server/timers.js, que só esperam um objeto com
 * campo `.timers` -- não importa a forma do resto do match.
 */
const matches = new Map(); // matchId -> { match, humanId, userId, socketId, timers, persisted }

function createMatch(humanId, userId, socketId) {
  const matchId = crypto.randomUUID();
  const match = createPveMatch(humanId);
  matches.set(matchId, {
    match,
    humanId,
    userId,
    socketId,
    timers: { turnTimer: null, turnTimerStartedAt: null, turnTimerRemainingMs: null },
    persisted: false,
  });
  return matchId;
}

function getMatch(matchId) {
  return matches.get(matchId) || null;
}

/**
 * Acha uma partida PvE não finalizada pra esse humano -- só cobre o
 * caso de reenvio acidental de 'pve_start' com o socket ainda
 * conectado (ex: duplo clique). NÃO é reconexão pós-queda: como o
 * PvE cancela a fase imediatamente ao desconectar (seção 9), não
 * existe mais "retomar depois de cair" -- só existe "começar de novo".
 */
function findActiveMatchByHumanId(humanId) {
  for (const [matchId, entry] of matches.entries()) {
    if (entry.humanId === humanId && !entry.match.finished) {
      return { matchId, entry };
    }
  }
  return null;
}

/**
 * Acha a partida associada a um socketId -- usado no handler de
 * 'disconnect' pra saber qual partida cancelar.
 */
function findBySocketId(socketId) {
  for (const [matchId, entry] of matches.entries()) {
    if (entry.socketId === socketId) {
      return { matchId, entry };
    }
  }
  return null;
}

function setSocketId(matchId, socketId) {
  const entry = matches.get(matchId);
  if (!entry) return false;
  entry.socketId = socketId;
  return true;
}

function removeMatch(matchId) {
  matches.delete(matchId);
}

module.exports = {
  createMatch,
  getMatch,
  findActiveMatchByHumanId,
  findBySocketId,
  setSocketId,
  removeMatch,
  _debugAllMatches: matches,
};
