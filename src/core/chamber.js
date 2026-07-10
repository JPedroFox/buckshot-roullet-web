'use strict';

const MIN_BULLETS = 2;
const MAX_BULLETS = 8;
const EXTRA_REAL_CHANCE = 0.3; // 30% real / 70% vazia, aplicado só às balas "extras"

/**
 * Sorteia um inteiro entre min e max, inclusive.
 */
function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Embaralha um array in-place (Fisher-Yates).
 */
function shuffle(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

/**
 * Gera um novo pente completo, seguindo a seção 5 do design:
 * - total de balas: aleatório entre 2 e 8
 * - garantia mínima: 1 real e 1 vazia
 * - balas restantes: 30% real / 70% vazia, sorteadas uma única vez
 *   (não é recalculado bala a bala durante o disparo)
 *
 * @returns {{ total: number, real: number, vazia: number, sequencia: Array<'real'|'vazia'> }}
 */
function generateChamber() {
  const total = randomInt(MIN_BULLETS, MAX_BULLETS);

  // As 2 garantidas
  let real = 1;
  let vazia = 1;

  // Balas restantes (pode ser 0 se total === 2)
  const remaining = total - 2;
  for (let i = 0; i < remaining; i++) {
    if (Math.random() < EXTRA_REAL_CHANCE) {
      real++;
    } else {
      vazia++;
    }
  }

  const sequencia = shuffle([
    ...Array(real).fill('real'),
    ...Array(vazia).fill('vazia'),
  ]);

  return { total, real, vazia, sequencia };
}

module.exports = { generateChamber, MIN_BULLETS, MAX_BULLETS, EXTRA_REAL_CHANCE, randomInt, shuffle };