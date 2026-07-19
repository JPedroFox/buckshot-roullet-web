'use strict';

const { createGameState, applyAction, currentPlayerId, ACTION_USE_ITEM, ACTION_SHOOT } = require('./turn');
const { playAiTurn, resetTurnToHumanIfReloaded } = require('./ai');

const AI_ID = '__ai__';

// Seção 3: vidas e itens por recarga crescem por fase.
const PVE_PHASES = [
  { maxLives: 2, itemsPerReload: 0 },
  { maxLives: 4, itemsPerReload: 2 },
  { maxLives: 6, itemsPerReload: 4 },
];

/**
 * Cria uma partida de PvE nova, já na Fase 1.
 */
function createPveMatch(humanId) {
  const match = {
    humanId,
    aiId: AI_ID,
    phaseIndex: 0,
    state: null,
    finished: false,
    result: null, // 'victory' | 'defeat' enquanto null a partida ainda está em andamento
  };
  startPhase(match, 0);
  return match;
}

/**
 * Inicia (ou reinicia) uma fase: vida no máximo, inventário zerado,
 * efeitos ativos cancelados (tudo isso é implícito em criar um
 * gameState novo do zero) -- e o humano sempre começa (seção 3).
 */
function startPhase(match, phaseIndex) {
  const phaseConfig = PVE_PHASES[phaseIndex];
  match.phaseIndex = phaseIndex;
  match.state = createGameState(
    { maxLives: phaseConfig.maxLives, itemsPerReload: phaseConfig.itemsPerReload, mode: 'pve' },
    [match.humanId, match.aiId],
    'human_first'
  );
}

/**
 * Executa a transição de fase de verdade: decide o destino da partida
 * de PvE (derrota, próxima fase, ou vitória final) e, se for o caso,
 * gera a fase nova (vida cheia, inventário zerado, PENTE NOVO --
 * seção 3: toda troca de fase é uma recarga).
 *
 * IMPORTANTE: isso NÃO é mais chamado automaticamente assim que
 * `state.gameOver` vira true. Antes era chamado na hora, e o efeito
 * colateral era o jogador nunca "ver" o momento em que a fase terminou
 * -- a tela já pulava pro estado da fase nova instantaneamente. Agora
 * quem orquestra (o servidor) decide QUANDO chamar isso, normalmente
 * depois de uma pausa proposital pra dar tempo de perceber a virada.
 */
function advancePhase(match) {
  if (!match.state.gameOver) return; // nada a avançar, a fase atual ainda está rolando

  if (match.state.winnerId === match.aiId) {
    match.finished = true;
    match.result = 'defeat';
    return;
  }
  // humano venceu essa fase
  const isLastPhase = match.phaseIndex === PVE_PHASES.length - 1;
  if (isLastPhase) {
    match.finished = true;
    match.result = 'victory';
  } else {
    startPhase(match, match.phaseIndex + 1);
  }
}

/**
 * Deixa a IA jogar sozinha enquanto for a vez dela -- pode ser mais de
 * um turno seguido (ex: bala vazia em si mesmo dá turno extra pra
 * IA). Para assim que virar a vez do humano, a fase acabar, ou a
 * partida acabar. NÃO avança de fase sozinha (ver advancePhase acima)
 * -- só para o loop, deixando o estado "congelado" no fim da fase pra
 * quem orquestra decidir quando seguir em frente.
 *
 * @param {Object} match
 * @param {(publicEvent: Object) => void} [onEvent] - chamado
 *   imediatamente após CADA ação da IA (item usado ou tiro), assim que
 *   ela acontece -- é isso que permite ao servidor transmitir as ações
 *   da IA em tempo real (com as pausas de "pensando" de ai.js) em vez
 *   de mandar tudo de uma vez só no final.
 * @returns {Promise<Array>} lista achatada de publicEvents de todos os
 *   turnos da IA jogados nesse ciclo.
 */
async function runAiTurnsIfNeeded(match, onEvent) {
  const aiEvents = [];
  while (!match.finished && !match.state.gameOver && currentPlayerId(match.state) === match.aiId) {
    const { events } = await playAiTurn(match.state, match.aiId, match.humanId, { onEvent });
    aiEvents.push(...events);
  }
  return aiEvents;
}

/**
 * Aplica SÓ a ação do jogador humano (usar item ou atirar), sem deixar
 * a IA jogar ainda e SEM avançar de fase ainda, mesmo que a fase tenha
 * acabado de terminar nessa própria ação. Separado de propósito: assim
 * o servidor pode emitir o evento do humano imediatamente, e só depois
 * (com uma pausa perceptível) mandar a IA "pensar" e agir, e só DEPOIS
 * disso avançar de fase se for o caso.
 *
 * @param {Object} match - objeto retornado por createPveMatch
 * @param {{ type: string, itemType?: string, target?: string }} action
 *   -- playerId é sempre match.humanId, atribuído aqui dentro (quem
 *   chama não precisa e não deve poder escolher outro id).
 * @returns {{ result: Object, phaseIndexBefore: number }}
 */
function applyHumanActionOnly(match, action) {
  if (match.finished) {
    throw new Error('applyHumanActionOnly: partida de PvE já terminou');
  }

  const phaseIndexBefore = match.phaseIndex;
  const fullAction = { ...action, playerId: match.humanId };
  const result = applyAction(match.state, fullAction);

  if (fullAction.type === ACTION_SHOOT) {
    resetTurnToHumanIfReloaded(match.state, match.humanId, result.publicEvent);
  }

  return { result, phaseIndexBefore };
}

module.exports = {
  createPveMatch,
  applyHumanActionOnly,
  runAiTurnsIfNeeded,
  advancePhase,
  PVE_PHASES,
  AI_ID,
  ACTION_USE_ITEM,
  ACTION_SHOOT,
};
