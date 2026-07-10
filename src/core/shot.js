'use strict';

const TARGET_SELF = 'self';
const TARGET_OPPONENT = 'opponent';

/**
 * Resolve um único disparo.
 * NÃO decide alvo, NÃO aplica dano no estado do jogador — só calcula
 * o resultado puro a partir do chamber e do alvo escolhido.
 *
 * Quem chama (turn.js / servidor) é responsável por:
 * - aplicar `damage` no jogador certo
 * - decidir se o turno realmente passa, usando `turnEnds`
 * - disparar a recarga quando `chamberEmpty` vier true
 *
 * @param {Object} params
 * @param {{ sequencia: Array<'real'|'vazia'> }} params.chamber - mutado in-place (shift do topo)
 * @param {'self'|'opponent'} params.target
 * @param {string} params.shooterId
 * @param {string} params.opponentId
 * @param {boolean} [params.doubleDamageActive] - efeito "Dano dobrado" (item 5) ativo?
 *
 * @returns {{
 *   bullet: 'real'|'vazia',
 *   damage: number,
 *   damagedPlayerId: string|null,
 *   turnEnds: boolean,
 *   chamberEmpty: boolean,
 *   doubleDamageConsumed: boolean
 * }}
 */
function resolveShot({ chamber, target, shooterId, opponentId, doubleDamageActive = false }) {
  if (!chamber || !Array.isArray(chamber.sequencia) || chamber.sequencia.length === 0) {
    throw new Error('resolveShot: chamber vazio ou inválido — precisa recarregar antes de atirar');
  }
  if (target !== TARGET_SELF && target !== TARGET_OPPONENT) {
    throw new Error(`resolveShot: target inválido "${target}"`);
  }

  const bullet = chamber.sequencia.shift();
  const chamberEmpty = chamber.sequencia.length === 0;

  if (bullet === 'vazia') {
    // Bala vazia em si mesmo: joga de novo, turno não termina.
    // Bala vazia no oponente: turno termina, sem dano.
    return {
      bullet,
      damage: 0,
      damagedPlayerId: null,
      turnEnds: target === TARGET_OPPONENT,
      chamberEmpty,
      doubleDamageConsumed: false,
    };
  }

  // bullet === 'real'
  const damage = doubleDamageActive ? 2 : 1;
  const damagedPlayerId = target === TARGET_SELF ? shooterId : opponentId;

  return {
    bullet,
    damage,
    damagedPlayerId,
    turnEnds: true, // bala real sempre termina o turno, mire em quem mirar
    chamberEmpty,
    doubleDamageConsumed: doubleDamageActive,
  };
}

module.exports = { resolveShot, TARGET_SELF, TARGET_OPPONENT };