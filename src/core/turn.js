'use strict';

const { generateChamber } = require('./chamber');
const { resolveShot, TARGET_SELF, TARGET_OPPONENT } = require('./shot');
const { ITEM_TYPES, verMunicao, retirarMunicao, travarAdversario, curar, danoDobrado, distributeItems } = require('./items');

const ACTION_USE_ITEM = 'use_item';
const ACTION_SHOOT = 'shoot';

/**
 * Cria o estado inicial de uma partida.
 *
 * @param {Object} config
 * @param {number} config.maxLives
 * @param {number} config.itemsPerReload
 * @param {'pvp'|'pve'} config.mode
 * @param {string[]} playerIds - exatamente 2 ids, na ordem que preferir;
 *   se whoStartsRule === 'random', a ordem de fato é sorteada aqui dentro.
 * @param {'random'|'human_first'} whoStartsRule
 */
function createGameState(config, playerIds, whoStartsRule = 'random') {
  if (playerIds.length !== 2) {
    throw new Error('createGameState: precisa de exatamente 2 jogadores');
  }
  if (playerIds[0] === playerIds[1]) {
    throw new Error('createGameState: os dois jogadores não podem ter o mesmo id — isso corrompe o estado (inventário e vida compartilhados)');
  }

  const turnOrder =
    whoStartsRule === 'random' && Math.random() < 0.5
      ? [playerIds[1], playerIds[0]]
      : [...playerIds];

  const players = {};
  playerIds.forEach((id) => {
    players[id] = {
      life: config.maxLives,
      inventory: [],
      skipNextTurn: false,
      // true enquanto o jogador foi pulado por "travar adversário" mas
      // ainda não teve um turno DE VERDADE depois disso. Sem isso, o
      // lock podia ser reaplicado no instante em que era consumido pelo
      // pulo, antes do oponente sequer jogar -- travando pra sempre.
      lockCooldown: false,
    };
  });

  const chamber = generateChamber();
  turnOrder.forEach((id) => {
    const drawn = distributeItems(players[id].inventory, config.itemsPerReload);
    players[id].inventory.push(...drawn);
  });

  return {
    mode: config.mode,
    maxLives: config.maxLives,
    itemsPerReload: config.itemsPerReload,
    players,
    turnOrder,
    turnIndex: 0,
    chamber,
    hasPickedUpGunThisTurn: false,
    doubleDamageActive: { [playerIds[0]]: false, [playerIds[1]]: false },
    reloadCount: 1,
    gameOver: false,
    winnerId: null,
  };
}

function currentPlayerId(state) {
  return state.turnOrder[state.turnIndex];
}

function opponentIdOf(state, playerId) {
  return state.turnOrder.find((id) => id !== playerId);
}

/**
 * Avança para o próximo jogador, respeitando "travar adversário"
 * (skip_next_turn). Não usar recursão infinita: com só 2 jogadores,
 * o próprio jogador nunca deveria ter skipNextTurn ao chegar sua vez
 * de novo nesse fluxo simples, mas o loop protege mesmo assim.
 *
 * Quando um jogador é pulado, ele entra em "lockCooldown": o item não
 * pode ser reaplicado nele até que ele realmente jogue um turno de
 * verdade (não pulado) de novo. Sem isso, o lock pode ser consumido
 * pelo próprio pulo e reaplicado imediatamente, travando o oponente
 * pra sempre sem ele nunca agir.
 */
function advanceTurn(state) {
  const total = state.turnOrder.length;
  let attempts = 0;
  do {
    state.turnIndex = (state.turnIndex + 1) % total;
    attempts++;
    const nextId = currentPlayerId(state);
    if (state.players[nextId].skipNextTurn) {
      state.players[nextId].skipNextTurn = false; // consumido, não acumula
      state.players[nextId].lockCooldown = true; // ainda não teve turno de verdade
      continue; // pula esse jogador, tenta o próximo
    }
    // turno de verdade pra nextId -- libera o cooldown, se houver
    state.players[nextId].lockCooldown = false;
    break;
  } while (attempts < total + 1);

  state.hasPickedUpGunThisTurn = false;
}

/**
 * Recarrega a arma: novo chamber + itens pra ambos.
 * Regra (seção 7, item 3): "travar adversário" pendente é cancelado
 * se a recarga acontecer antes de ser aplicado (PvP).
 */
function reload(state) {
  state.chamber = generateChamber();
  state.reloadCount += 1;
  state.turnOrder.forEach((id) => {
    const drawn = distributeItems(state.players[id].inventory, state.itemsPerReload);
    state.players[id].inventory.push(...drawn);
    // cancelamento do lock pendente na recarga (regra explícita da seção 7)
    state.players[id].skipNextTurn = false;
    state.players[id].lockCooldown = false;
  });
}

function checkGameOver(state) {
  for (const id of state.turnOrder) {
    if (state.players[id].life <= 0) {
      state.gameOver = true;
      state.winnerId = opponentIdOf(state, id);
      return true;
    }
  }
  return false;
}

/**
 * Aplica uma ação de um jogador ao estado do jogo.
 * Retorna { state, publicEvent, privateEvent }.
 * privateEvent (se existir) deve ser enviado SÓ pro socket do playerId
 * que agiu — nunca broadcast (seção 12).
 *
 * @param {Object} state
 * @param {{ type: 'use_item'|'shoot', playerId: string, itemType?: string, target?: 'self'|'opponent' }} action
 */
function applyAction(state, action) {
  if (state.gameOver) {
    throw new Error('applyAction: partida já terminou');
  }
  if (action.playerId !== currentPlayerId(state)) {
    throw new Error('applyAction: não é o turno desse jogador');
  }

  if (action.type === ACTION_USE_ITEM) {
    return handleUseItem(state, action);
  }
  if (action.type === ACTION_SHOOT) {
    return handleShoot(state, action);
  }
  throw new Error(`applyAction: tipo de ação desconhecido "${action.type}"`);
}

function handleUseItem(state, action) {
  if (state.hasPickedUpGunThisTurn) {
    throw new Error('handleUseItem: não é possível usar item depois de pegar a arma');
  }

  const { playerId, itemType } = action;
  const player = state.players[playerId];
  const itemIndex = player.inventory.indexOf(itemType);
  if (itemIndex === -1) {
    throw new Error(`handleUseItem: jogador não tem o item "${itemType}"`);
  }

  const opponentId = opponentIdOf(state, playerId);
  let privateEvent = null;
  let publicPayload = { itemType, playerId };

  switch (itemType) {
    case ITEM_TYPES.VER_MUNICAO: {
      const { bullet } = verMunicao(state.chamber);
      privateEvent = { type: 'item_result', playerId, itemType, bullet };
      break;
    }
    case ITEM_TYPES.RETIRAR_MUNICAO: {
      const { bullet, chamberEmpty } = retirarMunicao(state.chamber);
      publicPayload.bullet = bullet; // público, todos sabem (seção 7)
      if (chamberEmpty) {
        reload(state);
        publicPayload.reloaded = true;
      }
      break;
    }
    case ITEM_TYPES.TRAVAR_ADVERSARIO: {
      if (state.players[opponentId].skipNextTurn || state.players[opponentId].lockCooldown) {
        throw new Error('handleUseItem: oponente já está travado ou ainda não teve um turno de verdade desde o último lock');
      }
      travarAdversario();
      state.players[opponentId].skipNextTurn = true;
      break;
    }
    case ITEM_TYPES.CURAR: {
      const { newLife } = curar(player.life, state.maxLives);
      player.life = newLife;
      publicPayload.newLife = newLife;
      break;
    }
    case ITEM_TYPES.DANO_DOBRADO: {
      danoDobrado();
      state.doubleDamageActive[playerId] = true;
      break;
    }
    default:
      throw new Error(`handleUseItem: item desconhecido "${itemType}"`);
  }

  player.inventory.splice(itemIndex, 1);

  return {
    state,
    publicEvent: { type: 'use_item', ...publicPayload },
    privateEvent,
  };
}

function handleShoot(state, action) {
  const { playerId, target } = action;
  const opponentId = opponentIdOf(state, playerId);

  state.hasPickedUpGunThisTurn = true;

  const result = resolveShot({
    chamber: state.chamber,
    target,
    shooterId: playerId,
    opponentId,
    doubleDamageActive: state.doubleDamageActive[playerId],
  });

  if (result.doubleDamageConsumed) {
    state.doubleDamageActive[playerId] = false;
  }

  if (result.damage > 0 && result.damagedPlayerId) {
    state.players[result.damagedPlayerId].life -= result.damage;
  }

  const isGameOver = checkGameOver(state);

  if (!isGameOver) {
    if (result.chamberEmpty) {
      reload(state);
    }
    if (result.turnEnds) {
      advanceTurn(state);
    } else {
      // bala vazia em si mesmo: mesmo jogador joga de novo, mas é um
      // turno NOVO — recupera a possibilidade de usar itens.
      state.hasPickedUpGunThisTurn = false;
    }
  }

  return {
    state,
    publicEvent: {
      type: target === TARGET_SELF ? 'shot_self' : 'shot_opponent',
      playerId,
      bullet: result.bullet,
      damage: result.damage,
      damagedPlayerId: result.damagedPlayerId,
      chamberEmpty: result.chamberEmpty,
      gameOver: state.gameOver,
      winnerId: state.winnerId,
    },
    privateEvent: null,
  };
}

module.exports = {
  createGameState,
  applyAction,
  currentPlayerId,
  opponentIdOf,
  ACTION_USE_ITEM,
  ACTION_SHOOT,
};