'use strict';

const crypto = require('crypto');
const { createGameState } = require('../src/core/turn');

/**
 * Store em memória das partidas ativas.
 * matchId -> {
 *   state,               // estado do jogo (src/core/turn.js)
 *   config,              // config usada pra criar o jogo
 *   sockets: { [playerId]: socketId | null }, // null = desconectado
 *   timers: { turnTimer: Timeout|null, reconnectTimer: Timeout|null }
 * }
 *
 * Isso é intencionalmente em memória, não no banco — o banco (seção 11)
 * guarda o resultado agregado e o log de eventos, não o estado live da
 * partida. Se o processo cair, partidas em andamento se perdem; isso é
 * uma limitação conhecida de v1, não um esquecimento.
 */
const matches = new Map();

function createMatch(config, playerIds, whoStartsRule = 'random') {
  const matchId = crypto.randomUUID();
  const state = createGameState(config, playerIds, whoStartsRule);

  const sockets = {};
  playerIds.forEach((id) => {
    sockets[id] = null;
  });

  matches.set(matchId, {
    state,
    config,
    sockets,
    timers: { turnTimer: null, reconnectTimer: null },
  });

  return matchId;
}

function getMatch(matchId) {
  return matches.get(matchId) || null;
}

function removeMatch(matchId) {
  const match = matches.get(matchId);
  if (match) {
    clearTimersOf(match);
    matches.delete(matchId);
  }
}

function clearTimersOf(match) {
  if (match.timers.turnTimer) clearTimeout(match.timers.turnTimer);
  if (match.timers.reconnectTimer) clearTimeout(match.timers.reconnectTimer);
  match.timers.turnTimer = null;
  match.timers.reconnectTimer = null;
}

function setSocket(matchId, playerId, socketId) {
  const match = matches.get(matchId);
  if (!match) return false;
  if (!(playerId in match.sockets)) return false;
  match.sockets[playerId] = socketId;
  return true;
}

/**
 * Encontra em qual partida um dado socketId está jogando, e como qual
 * playerId. Usado no evento 'disconnect', que só nos dá o socketId.
 */
function findBySocketId(socketId) {
  for (const [matchId, match] of matches.entries()) {
    for (const [playerId, sid] of Object.entries(match.sockets)) {
      if (sid === socketId) {
        return { matchId, playerId, match };
      }
    }
  }
  return null;
}

/**
 * Procura uma partida NÃO finalizada em que esse playerId já participa.
 * Base da reconexão automática por nome: se "alice" tentar entrar de
 * novo na fila e já estiver numa partida em andamento, tratamos como
 * reconexão, não como nova partida.
 */
function findActiveMatchByPlayerId(playerId) {
  for (const [matchId, match] of matches.entries()) {
    if (match.state.gameOver) continue;
    if (playerId in match.sockets) {
      return { matchId, match };
    }
  }
  return null;
}

/**
 * Verifica se um playerId já está "em uso" em alguma partida ativa —
 * usado pra impedir dois jogadores diferentes escolherem o mesmo nome
 * ao mesmo tempo (não há autenticação real ainda, então o nome É a
 * identidade; permitir duplicata corrompe o estado da partida).
 */
function isPlayerIdActiveElsewhere(playerId) {
  return findActiveMatchByPlayerId(playerId) !== null;
}

module.exports = {
  createMatch,
  getMatch,
  removeMatch,
  setSocket,
  clearTimersOf,
  findBySocketId,
  findActiveMatchByPlayerId,
  isPlayerIdActiveElsewhere,
  _debugAllMatches: matches, // só pra testes
};