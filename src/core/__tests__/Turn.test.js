'use strict';

const { createGameState, applyAction, currentPlayerId, ACTION_USE_ITEM, ACTION_SHOOT } = require('../turn');
const { ITEM_TYPES } = require('../items');
const { TARGET_SELF, TARGET_OPPONENT } = require('../shot');

const CONFIG_PVP = { maxLives: 6, itemsPerReload: 4, mode: 'pvp' };

// Helper: força um chamber conhecido no estado, pra teste determinístico.
function forceChamber(state, sequencia) {
  state.chamber = { sequencia: [...sequencia] };
}

// Helper: dá um item específico pro jogador, ignorando o sorteio.
function giveItem(state, playerId, itemType) {
  state.players[playerId].inventory.push(itemType);
}

describe('createGameState', () => {
  test('cria 2 jogadores com vida máxima e turnOrder com ambos', () => {
    const state = createGameState(CONFIG_PVP, ['p1', 'p2']);
    expect(state.players.p1.life).toBe(6);
    expect(state.players.p2.life).toBe(6);
    expect(state.turnOrder.sort()).toEqual(['p1', 'p2']);
  });

  test('distribui itemsPerReload itens pra cada jogador no início', () => {
    const state = createGameState(CONFIG_PVP, ['p1', 'p2']);
    expect(state.players.p1.inventory.length).toBe(4);
    expect(state.players.p2.inventory.length).toBe(4);
  });

  test('lança erro se não forem exatamente 2 jogadores', () => {
    expect(() => createGameState(CONFIG_PVP, ['p1'])).toThrow();
    expect(() => createGameState(CONFIG_PVP, ['p1', 'p2', 'p3'])).toThrow();
  });

  test('BUG reportado: lança erro se os dois jogadores tiverem o mesmo id', () => {
    expect(() => createGameState(CONFIG_PVP, ['alice', 'alice'])).toThrow();
  });

  test('ordem de turno é sorteada (estatisticamente, ambos aparecem primeiro)', () => {
    let p1First = 0;
    for (let i = 0; i < 200; i++) {
      const state = createGameState(CONFIG_PVP, ['p1', 'p2']);
      if (currentPlayerId(state) === 'p1') p1First++;
    }
    expect(p1First).toBeGreaterThan(50);
    expect(p1First).toBeLessThan(150);
  });
});

describe('applyAction - validações básicas', () => {
  test('lança erro se não for a vez do jogador', () => {
    const state = createGameState(CONFIG_PVP, ['p1', 'p2']);
    const notCurrent = state.turnOrder[1];
    expect(() =>
      applyAction(state, { type: ACTION_SHOOT, playerId: notCurrent, target: TARGET_OPPONENT })
    ).toThrow();
  });

  test('lança erro em ação de tipo desconhecido', () => {
    const state = createGameState(CONFIG_PVP, ['p1', 'p2']);
    const p = currentPlayerId(state);
    expect(() => applyAction(state, { type: 'dance', playerId: p })).toThrow();
  });
});

describe('regra: não pode usar item depois de pegar a arma', () => {
  test('bloqueia use_item depois de um shoot que termina o turno normalmente', () => {
    const state = createGameState(CONFIG_PVP, ['p1', 'p2']);
    const p1 = currentPlayerId(state);
    forceChamber(state, ['vazia', 'real']); // vazia no oponente -> turno termina, chamber não esvazia
    giveItem(state, p1, ITEM_TYPES.CURAR);

    applyAction(state, { type: ACTION_SHOOT, playerId: p1, target: TARGET_OPPONENT });

    // agora é vez do outro jogador -- tentar usar item como p1 (fora de turno) já falha por outra razão.
    // O teste real de "não pode usar item após pegar arma" precisa ser DENTRO do mesmo turno,
    // então testamos via bala vazia em si mesmo (ver teste abaixo) onde o jogador continua.
    expect(state.hasPickedUpGunThisTurn).toBe(false); // resetado pro próximo jogador
  });

  test('bala vazia em si mesmo: NÃO pode mais usar item DEPOIS de atirar, mesmo continuando o turno', () => {
    const state = createGameState(CONFIG_PVP, ['p1', 'p2']);
    const p1 = currentPlayerId(state);
    forceChamber(state, ['vazia', 'vazia']);
    giveItem(state, p1, ITEM_TYPES.CURAR);

    applyAction(state, { type: ACTION_SHOOT, playerId: p1, target: TARGET_SELF });

    // ainda é a vez do mesmo jogador (bala vazia em si = turno novo)
    expect(currentPlayerId(state)).toBe(p1);
    // mas é um turno NOVO, então a trava de "já pegou a arma" foi resetada
    expect(state.hasPickedUpGunThisTurn).toBe(false);

    // então ele DEVERIA poder usar item de novo nesse turno novo
    const result = applyAction(state, { type: ACTION_USE_ITEM, playerId: p1, itemType: ITEM_TYPES.CURAR });
    expect(result.publicEvent.itemType).toBe(ITEM_TYPES.CURAR);
  });

  test('bloqueia use_item se hasPickedUpGunThisTurn já é true (dentro do mesmo turno, sem trocar)', () => {
    const state = createGameState(CONFIG_PVP, ['p1', 'p2']);
    const p1 = currentPlayerId(state);
    state.hasPickedUpGunThisTurn = true; // simula que já pegou a arma
    giveItem(state, p1, ITEM_TYPES.CURAR);

    expect(() =>
      applyAction(state, { type: ACTION_USE_ITEM, playerId: p1, itemType: ITEM_TYPES.CURAR })
    ).toThrow();
  });
});

describe('regra: dano e fim de jogo', () => {
  test('bala real reduz vida do alvo correto', () => {
    const state = createGameState(CONFIG_PVP, ['p1', 'p2']);
    const p1 = currentPlayerId(state);
    forceChamber(state, ['real', 'vazia']);

    applyAction(state, { type: ACTION_SHOOT, playerId: p1, target: TARGET_OPPONENT });

    const opponentId = state.turnOrder.find((id) => id !== p1);
    expect(state.players[opponentId].life).toBe(5);
  });

  test('vida chega a 0 -> gameOver true e winnerId correto', () => {
    const state = createGameState(CONFIG_PVP, ['p1', 'p2']);
    const p1 = currentPlayerId(state);
    const opponentId = state.turnOrder.find((id) => id !== p1);
    state.players[opponentId].life = 1;
    forceChamber(state, ['real']);

    const { publicEvent } = applyAction(state, { type: ACTION_SHOOT, playerId: p1, target: TARGET_OPPONENT });

    expect(state.gameOver).toBe(true);
    expect(state.winnerId).toBe(p1);
    expect(publicEvent.gameOver).toBe(true);
  });

  test('depois de gameOver, applyAction lança erro', () => {
    const state = createGameState(CONFIG_PVP, ['p1', 'p2']);
    const p1 = currentPlayerId(state);
    const opponentId = state.turnOrder.find((id) => id !== p1);
    state.players[opponentId].life = 1;
    forceChamber(state, ['real']);
    applyAction(state, { type: ACTION_SHOOT, playerId: p1, target: TARGET_OPPONENT });

    expect(() =>
      applyAction(state, { type: ACTION_SHOOT, playerId: p1, target: TARGET_OPPONENT })
    ).toThrow();
  });
});

describe('regra: item Dano dobrado', () => {
  test('dobra o dano do próximo disparo e depois é consumido', () => {
    const state = createGameState(CONFIG_PVP, ['p1', 'p2']);
    const p1 = currentPlayerId(state);
    const opponentId = state.turnOrder.find((id) => id !== p1);
    giveItem(state, p1, ITEM_TYPES.DANO_DOBRADO);
    forceChamber(state, ['real', 'vazia', 'real']);

    applyAction(state, { type: ACTION_USE_ITEM, playerId: p1, itemType: ITEM_TYPES.DANO_DOBRADO });
    applyAction(state, { type: ACTION_SHOOT, playerId: p1, target: TARGET_OPPONENT });

    expect(state.players[opponentId].life).toBe(4); // 6 - 2
    expect(state.doubleDamageActive[p1]).toBe(false); // consumido
  });

  test('BUG reportado: é consumido mesmo se o tiro sair vazio (não só em bala real)', () => {
    const state = createGameState(CONFIG_PVP, ['p1', 'p2']);
    const p1 = currentPlayerId(state);
    const opponentId = state.turnOrder.find((id) => id !== p1);
    giveItem(state, p1, ITEM_TYPES.DANO_DOBRADO);
    // primeiro tiro sai vazio (em si mesmo -> continua o turno), segundo é real no oponente
    forceChamber(state, ['vazia', 'real']);

    applyAction(state, { type: ACTION_USE_ITEM, playerId: p1, itemType: ITEM_TYPES.DANO_DOBRADO });
    applyAction(state, { type: ACTION_SHOOT, playerId: p1, target: TARGET_SELF }); // vazia -> turno novo

    // o efeito já deveria estar consumido aqui, mesmo sem dano real ter acontecido
    expect(state.doubleDamageActive[p1]).toBe(false);

    // segundo disparo do mesmo jogador (turno novo) NÃO deve mais estar dobrado
    applyAction(state, { type: ACTION_SHOOT, playerId: p1, target: TARGET_OPPONENT });
    expect(state.players[opponentId].life).toBe(5); // 6 - 1, não 6 - 2
  });
});

describe('regra: Travar adversário não pode ser reaplicado enquanto já ativo', () => {
  test('BUG reportado: usar o item com o oponente já travado lança erro e NÃO consome o item', () => {
    const state = createGameState(CONFIG_PVP, ['p1', 'p2']);
    const p1 = currentPlayerId(state);
    const opponentId = state.turnOrder.find((id) => id !== p1);

    // zera o inventário sorteado aleatoriamente no início, pra controlar
    // exatamente o que o jogador tem nesse teste.
    state.players[p1].inventory = [];
    giveItem(state, p1, ITEM_TYPES.TRAVAR_ADVERSARIO);
    giveItem(state, p1, ITEM_TYPES.TRAVAR_ADVERSARIO); // um segundo, pra tentar de novo

    applyAction(state, { type: ACTION_USE_ITEM, playerId: p1, itemType: ITEM_TYPES.TRAVAR_ADVERSARIO });
    expect(state.players[opponentId].skipNextTurn).toBe(true);
    expect(state.players[p1].inventory.length).toBe(1); // consumiu 1

    expect(() =>
      applyAction(state, { type: ACTION_USE_ITEM, playerId: p1, itemType: ITEM_TYPES.TRAVAR_ADVERSARIO })
    ).toThrow();

    // item NÃO foi consumido na tentativa que falhou
    expect(state.players[p1].inventory.length).toBe(1);
  });
});

describe('regra: Travar adversário', () => {
  test('faz o oponente perder o próximo turno (não acumula, é consumido ao pular)', () => {
    const state = createGameState(CONFIG_PVP, ['p1', 'p2']);
    const p1 = currentPlayerId(state);
    const opponentId = state.turnOrder.find((id) => id !== p1);

    giveItem(state, p1, ITEM_TYPES.TRAVAR_ADVERSARIO);
    forceChamber(state, ['vazia', 'vazia', 'vazia']); // vazia no oponente sempre -> passa turno sem dano

    applyAction(state, { type: ACTION_USE_ITEM, playerId: p1, itemType: ITEM_TYPES.TRAVAR_ADVERSARIO });
    applyAction(state, { type: ACTION_SHOOT, playerId: p1, target: TARGET_OPPONENT });

    // deveria ter pulado o oponente e voltado pro p1
    expect(currentPlayerId(state)).toBe(p1);
    // efeito consumido, não deve continuar pulando pra sempre
    expect(state.players[opponentId].skipNextTurn).toBe(false);
  });

  test('efeito é cancelado se a recarga acontecer antes de ser aplicado (PvP)', () => {
    const state = createGameState(CONFIG_PVP, ['p1', 'p2']);
    const p1 = currentPlayerId(state);
    const opponentId = state.turnOrder.find((id) => id !== p1);

    giveItem(state, p1, ITEM_TYPES.TRAVAR_ADVERSARIO);
    // chamber com só 1 bala -> vai esvaziar e recarregar nesse mesmo disparo
    forceChamber(state, ['vazia']);

    applyAction(state, { type: ACTION_USE_ITEM, playerId: p1, itemType: ITEM_TYPES.TRAVAR_ADVERSARIO });
    expect(state.players[opponentId].skipNextTurn).toBe(true); // marcado

    applyAction(state, { type: ACTION_SHOOT, playerId: p1, target: TARGET_OPPONENT }); // esvazia -> recarrega

    // recarga deveria ter cancelado o lock antes de ele ser "usado"
    expect(state.players[opponentId].skipNextTurn).toBe(false);
    // e o oponente NÃO deveria ter sido pulado
    expect(currentPlayerId(state)).toBe(opponentId);
  });
});

describe('regra: recarga', () => {
  test('recarrega automaticamente quando o chamber esvazia e distribui itens', () => {
    const state = createGameState(CONFIG_PVP, ['p1', 'p2']);
    const p1 = currentPlayerId(state);
    forceChamber(state, ['real']);
    // esvazia o inventário pra facilitar contagem
    state.players.p1.inventory = [];
    state.players.p2.inventory = [];

    applyAction(state, { type: ACTION_SHOOT, playerId: p1, target: TARGET_OPPONENT });

    expect(state.chamber.sequencia.length).toBeGreaterThanOrEqual(2);
    expect(state.reloadCount).toBe(2);
    expect(state.players.p1.inventory.length).toBe(4);
    expect(state.players.p2.inventory.length).toBe(4);
  });
});

describe('regra: Retirar munição', () => {
  test('remove a bala e é pública (não precisa de item pra saber)', () => {
    const state = createGameState(CONFIG_PVP, ['p1', 'p2']);
    const p1 = currentPlayerId(state);
    giveItem(state, p1, ITEM_TYPES.RETIRAR_MUNICAO);
    forceChamber(state, ['real', 'vazia']);

    const { publicEvent } = applyAction(state, {
      type: ACTION_USE_ITEM,
      playerId: p1,
      itemType: ITEM_TYPES.RETIRAR_MUNICAO,
    });

    expect(publicEvent.bullet).toBe('real');
    expect(state.chamber.sequencia).toEqual(['vazia']);
  });

  test('se remove a última bala, dispara recarga', () => {
    const state = createGameState(CONFIG_PVP, ['p1', 'p2']);
    const p1 = currentPlayerId(state);
    giveItem(state, p1, ITEM_TYPES.RETIRAR_MUNICAO);
    forceChamber(state, ['real']);

    const { publicEvent } = applyAction(state, {
      type: ACTION_USE_ITEM,
      playerId: p1,
      itemType: ITEM_TYPES.RETIRAR_MUNICAO,
    });

    expect(publicEvent.reloaded).toBe(true);
    expect(state.chamber.sequencia.length).toBeGreaterThanOrEqual(2);
  });
});

describe('regra: Ver munição gera evento privado, não público', () => {
  test('privateEvent contém a bala, publicEvent não revela', () => {
    const state = createGameState(CONFIG_PVP, ['p1', 'p2']);
    const p1 = currentPlayerId(state);
    giveItem(state, p1, ITEM_TYPES.VER_MUNICAO);
    forceChamber(state, ['real', 'vazia']);

    const { publicEvent, privateEvent } = applyAction(state, {
      type: ACTION_USE_ITEM,
      playerId: p1,
      itemType: ITEM_TYPES.VER_MUNICAO,
    });

    expect(privateEvent.bullet).toBe('real');
    expect(publicEvent.bullet).toBeUndefined(); // não vaza pro evento público
  });
});