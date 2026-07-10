'use strict';

const TURN_TIMEOUT_MS = 60 * 1000; // 1 minuto (seção 9)
const RECONNECT_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutos (seção 9)

/**
 * Inicia (ou reinicia do zero) o timer de turno pra uma partida.
 * onExpire é chamado se o tempo esgotar sem o jogador agir.
 */
function startTurnTimer(match, onExpire) {
  clearTurnTimer(match);
  match.timers.turnTimerStartedAt = Date.now();
  match.timers.turnTimerRemainingMs = TURN_TIMEOUT_MS;
  match.timers.turnTimer = setTimeout(onExpire, TURN_TIMEOUT_MS);
}

function clearTurnTimer(match) {
  if (match.timers.turnTimer) {
    clearTimeout(match.timers.turnTimer);
    match.timers.turnTimer = null;
  }
}

/**
 * Pausa o timer de turno (jogador caiu durante o PRÓPRIO turno) e
 * guarda quanto tempo restava, pra retomar exatamente dali (seção 9).
 */
function pauseTurnTimer(match) {
  if (!match.timers.turnTimer) return;
  const elapsed = Date.now() - match.timers.turnTimerStartedAt;
  match.timers.turnTimerRemainingMs = Math.max(TURN_TIMEOUT_MS - elapsed, 0);
  clearTurnTimer(match);
}

/**
 * Retoma o timer de turno de onde parou.
 */
function resumeTurnTimer(match, onExpire) {
  const remaining = match.timers.turnTimerRemainingMs ?? TURN_TIMEOUT_MS;
  match.timers.turnTimerStartedAt = Date.now();
  match.timers.turnTimer = setTimeout(onExpire, remaining);
}

/**
 * Inicia o timer de reconexão (2 min). Independente do timer de turno
 * (seção 9: "nunca somados").
 */
function startReconnectTimer(match, onExpire) {
  clearReconnectTimer(match);
  match.timers.reconnectTimer = setTimeout(onExpire, RECONNECT_TIMEOUT_MS);
}

function clearReconnectTimer(match) {
  if (match.timers.reconnectTimer) {
    clearTimeout(match.timers.reconnectTimer);
    match.timers.reconnectTimer = null;
  }
}

module.exports = {
  TURN_TIMEOUT_MS,
  RECONNECT_TIMEOUT_MS,
  startTurnTimer,
  clearTurnTimer,
  pauseTurnTimer,
  resumeTurnTimer,
  startReconnectTimer,
  clearReconnectTimer,
};