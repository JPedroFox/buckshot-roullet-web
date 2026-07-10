'use strict';

const ITEM_TYPES = {
  VER_MUNICAO: 'ver_municao',
  RETIRAR_MUNICAO: 'retirar_municao',
  TRAVAR_ADVERSARIO: 'travar_adversario',
  CURAR: 'curar',
  DANO_DOBRADO: 'dano_dobrado',
};

const MAX_INVENTORY = 8;
const HEAL_AMOUNT = 1;

/**
 * Item 1 - Ver munição.
 * Revela a bala do topo SEM removê-la. Resultado é privado — quem
 * chama (turn.js/servidor) decide mandar isso só pro socket de quem usou.
 */
function verMunicao(chamber) {
  if (!chamber || chamber.sequencia.length === 0) {
    throw new Error('verMunicao: chamber vazio');
  }
  return { bullet: chamber.sequencia[0] };
}

/**
 * Item 2 - Retirar munição.
 * Remove a bala do topo. Resultado é PÚBLICO (todos sabem o que era).
 * Muta o chamber in-place, igual resolveShot.
 */
function retirarMunicao(chamber) {
  if (!chamber || chamber.sequencia.length === 0) {
    throw new Error('retirarMunicao: chamber vazio');
  }
  const bullet = chamber.sequencia.shift();
  return { bullet, chamberEmpty: chamber.sequencia.length === 0 };
}

/**
 * Item 3 - Travar adversário.
 * Não acumula (efeito booleano, não contador). Cancelamento por troca
 * de fase (PvE) ou recarga (PvP) é responsabilidade de turn.js, não daqui.
 */
function travarAdversario() {
  return { effect: 'skip_next_turn', appliesTo: 'opponent' };
}

/**
 * Item 4 - Curar.
 * Não ultrapassa vida máxima.
 */
function curar(currentLife, maxLife) {
  const newLife = Math.min(currentLife + HEAL_AMOUNT, maxLife);
  return { newLife };
}

/**
 * Item 5 - Dano dobrado.
 * O efeito em si só marca a intenção; quem consome de fato é
 * resolveShot (via doubleDamageActive), e só é consumido se a bala
 * for real (ver shot.js).
 */
function danoDobrado() {
  return { effect: 'double_damage', consumedOnNextShot: true };
}

/**
 * Sorteia um item aleatório entre os 5 tipos, distribuição uniforme
 * (seção 7: "aleatória e uniforme entre os 5 tipos").
 */
function randomItemType() {
  const types = Object.values(ITEM_TYPES);
  const index = Math.floor(Math.random() * types.length);
  return types[index];
}

/**
 * Distribui N itens aleatórios, respeitando o teto de inventário.
 * Retorna só os itens que cabem — quem chama decide o que fazer com
 * o excedente (nesse design, itens que não cabem simplesmente não
 * são adicionados; não há regra de "descarte" declarada no doc).
 */
function distributeItems(currentInventory, count) {
  const drawn = [];
  for (let i = 0; i < count; i++) {
    if (currentInventory.length + drawn.length >= MAX_INVENTORY) break;
    drawn.push(randomItemType());
  }
  return drawn;
}

module.exports = {
  ITEM_TYPES,
  MAX_INVENTORY,
  verMunicao,
  retirarMunicao,
  travarAdversario,
  curar,
  danoDobrado,
  randomItemType,
  distributeItems,
};