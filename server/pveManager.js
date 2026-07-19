'use strict';

const crypto = require('crypto');
const { createPveMatch } = require('../src/core/pve');

/**
 * Store em memória das partidas PvE ativas. Mais simples que o
 * gameManager de PvP: só 1 jogador humano por partida, sem sala/room
 * de socket, sem timers de turno/reconexão (seção 9 só define esses
 * timers pra PvP e pra reconexão de PvE em termos de "cancela sem
 * vitória/derrota" -- isso ainda NÃO está implementado aqui; é uma
 * lacuna consciente, não um esquecimento, porque o escopo pedido foi
 * "backend + client de teste", sem timers/reconexão por enquanto).
 */
const matches = new Map(); // matchId -> { match, humanId, socketId }

function createMatch(humanId, socketId) {
  const matchId = crypto.randomUUID();
  const match = createPveMatch(humanId);
  matches.set(matchId, { match, humanId, socketId });
  return matchId;
}

function getMatch(matchId) {
  return matches.get(matchId) || null;
}

/**
 * Acha uma partida PvE não finalizada pra esse humano -- usado pra
 * resumir a partida se a página for recarregada, igual fizemos no PvP.
 */
function findActiveMatchByHumanId(humanId) {
  for (const [matchId, entry] of matches.entries()) {
    if (entry.humanId === humanId && !entry.match.finished) {
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
  setSocketId,
  removeMatch,
  _debugAllMatches: matches,
};
