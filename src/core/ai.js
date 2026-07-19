'use strict';

const { applyAction, opponentIdOf, ACTION_USE_ITEM, ACTION_SHOOT } = require('./turn');
const { ITEM_TYPES } = require('./items');
const { TARGET_SELF, TARGET_OPPONENT } = require('./shot');

/**
 * PASSO 0 (seção 8): thresholds calculados com a vida do INÍCIO DO
 * TURNO, travados antes de qualquer item ser usado nesse turno --
 * assim uma cura no meio do turno não muda a regra no meio da mesma
 * decisão.
 */
function computeThresholds(vidaInicioTurno) {
  const cauteloso = vidaInicioTurno <= 3;
  return {
    cauteloso,
    thresholdVaziaSegura: cauteloso ? 0.85 : 0.5,
    thresholdRealDanoDobrado: 0.85,
  };
}

/**
 * Calcula p_real/p_vazia. Se `knownNextBullet` estiver definido (a IA
 * usou "Ver munição" e sabe com certeza a próxima bala), a
 * probabilidade vira 100%/0% em vez de recalcular pela contagem geral
 * -- é isso que a seção 8 chama de "recalcula p_real/p_vazia com a
 * informação nova".
 */
function computeProbs(chamber, knownNextBullet) {
  if (knownNextBullet === 'real') return { pReal: 1, pVazia: 0 };
  if (knownNextBullet === 'vazia') return { pReal: 0, pVazia: 1 };
  const seq = chamber.sequencia;
  const real = seq.filter((b) => b === 'real').length;
  const pReal = real / seq.length;
  return { pReal, pVazia: 1 - pReal };
}

/**
 * Regra de PvE (seção 3): "o jogador humano sempre começa -- tanto no
 * início da fase quanto em toda recarga da arma dentro da mesma
 * fase". Isso é diferente de PvP (onde a ordem não é re-sorteada na
 * recarga), então essa regra fica aqui na camada de PvE/IA, não em
 * turn.js, que precisa continuar agnóstico a modo.
 */
function resetTurnToHumanIfReloaded(state, humanId, shotPublicEvent) {
  if (!state.gameOver && shotPublicEvent.chamberEmpty) {
    state.turnIndex = state.turnOrder.indexOf(humanId);
    state.hasPickedUpGunThisTurn = false;
  }
}

// Tempos de "pensamento" da IA, em ms -- puramente de UX, não afeta a
// decisão em si. Ajuste esses números se quiser a IA mais rápida/lenta.
const THINK_DELAY_MS = [1600, 2600]; // pausa antes de começar a decidir o turno
const ACTION_DELAY_MS = [900, 1500]; // pausa entre cada ação (item usado, ou antes do tiro final)

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomDelay([min, max]) {
  return min + Math.random() * (max - min);
}

/**
 * Joga um turno completo da IA, Passo 1 ao Passo 5 (seção 8), e
 * dispara. Muta `state` via applyAction, igual o resto do core.
 *
 * Agora é assíncrona de propósito: insere pausas artificiais entre as
 * ações (puramente de UX -- "a IA está pensando"), e chama `onEvent`
 * imediatamente após CADA ação de verdade acontecer, pra quem estiver
 * ouvindo (o servidor) poder transmitir isso ao vivo pro client em vez
 * de mandar tudo de uma vez só no final do turno.
 *
 * @param {Object} state
 * @param {string} aiId
 * @param {string} humanId
 * @param {{ onEvent?: (publicEvent: Object) => void }} [options]
 * @returns {Promise<{ events: Array, shotResult: Object }>} events é a
 *   lista de publicEvents gerados (itens usados + o tiro final).
 *   Informação PRIVADA da IA (ex: o que "Ver munição" revelou pra ela)
 *   nunca entra nessa lista -- é descartada de propósito (a IA não
 *   conta pro humano o que viu).
 */
async function playAiTurn(state, aiId, humanId, options = {}) {
  const { onEvent } = options;
  const events = [];
  const vidaInicioTurno = state.players[aiId].life;
  const { thresholdVaziaSegura, thresholdRealDanoDobrado } = computeThresholds(vidaInicioTurno);

  let knownNextBullet = null; // null = incerto; 'real'|'vazia' = revelado por Ver munição

  async function tryItem(itemType) {
    if (state.hasPickedUpGunThisTurn) return null;
    if (!state.players[aiId].inventory.includes(itemType)) return null;
    try {
      const result = applyAction(state, { type: ACTION_USE_ITEM, playerId: aiId, itemType });
      events.push(result.publicEvent);
      if (onEvent) onEvent(result.publicEvent);
      await sleep(randomDelay(ACTION_DELAY_MS));
      return result;
    } catch (err) {
      // regra do próprio item impediu (ex: travar já ativo) -- a IA
      // simplesmente desiste dessa ação, sem quebrar o turno todo, e
      // sem pausa artificial (não "agiu" de verdade).
      return null;
    }
  }

  await sleep(randomDelay(THINK_DELAY_MS)); // "pensando" antes de decidir

  // PASSO 1 — Curar
  if (state.players[aiId].life <= state.maxLives / 2) {
    await tryItem(ITEM_TYPES.CURAR);
  }

  // PASSO 2 — Ver munição (só se ainda há incerteza real; nunca
  // desperdiçada se a bala já é dedutível por eliminação, porque nesse
  // caso pReal já é 0 ou 1 e a condição abaixo não passa)
  {
    const { pReal } = computeProbs(state.chamber, knownNextBullet);
    if (pReal > 0 && pReal < 1) {
      const result = await tryItem(ITEM_TYPES.VER_MUNICAO);
      if (result && result.privateEvent) {
        knownNextBullet = result.privateEvent.bullet;
      }
    }
  }

  // PASSO 3 — alvo pretendido
  let { pVazia } = computeProbs(state.chamber, knownNextBullet);
  let target = pVazia >= thresholdVaziaSegura ? TARGET_SELF : TARGET_OPPONENT;

  // PASSO 4 — itens condicionados ao alvo
  if (target === TARGET_SELF) {
    const { pReal } = computeProbs(state.chamber, knownNextBullet);
    if (pReal > 1 - thresholdVaziaSegura) {
      const result = await tryItem(ITEM_TYPES.RETIRAR_MUNICAO);
      if (result) {
        knownNextBullet = null; // novo topo do pente, incerto de novo
        const recalced = computeProbs(state.chamber, knownNextBullet);
        target = recalced.pVazia >= thresholdVaziaSegura ? TARGET_SELF : TARGET_OPPONENT;
      }
    }
  } else {
    // alvo = OPONENTE: nunca usa Retirar munição aqui (jogaria fora
    // dano potencial, conforme a seção 8 explicita)
    const { pReal } = computeProbs(state.chamber, knownNextBullet);
    if (pReal >= thresholdRealDanoDobrado) {
      await tryItem(ITEM_TYPES.DANO_DOBRADO);
    }
  }

  // Travar adversário -- independente do alvo escolhido, heurística
  // declarada da seção 8 (balas_restantes >= 2)
  if (state.chamber.sequencia.length >= 2) {
    await tryItem(ITEM_TYPES.TRAVAR_ADVERSARIO);
  }

  // PASSO 5 — reavaliação final com toda a informação acumulada no turno
  const finalProbs = computeProbs(state.chamber, knownNextBullet);
  const finalTarget = finalProbs.pVazia >= thresholdVaziaSegura ? TARGET_SELF : TARGET_OPPONENT;

  await sleep(randomDelay(ACTION_DELAY_MS)); // pausa antes de puxar o gatilho

  const shotResult = applyAction(state, { type: ACTION_SHOOT, playerId: aiId, target: finalTarget });
  events.push(shotResult.publicEvent);
  if (onEvent) onEvent(shotResult.publicEvent);
  resetTurnToHumanIfReloaded(state, humanId, shotResult.publicEvent);

  return { events, shotResult };
}

module.exports = {
  playAiTurn,
  computeThresholds,
  computeProbs,
  resetTurnToHumanIfReloaded,
  THINK_DELAY_MS,
  ACTION_DELAY_MS,
};
