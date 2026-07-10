'use strict';

const {
  ITEM_TYPES,
  MAX_INVENTORY,
  verMunicao,
  retirarMunicao,
  curar,
  travarAdversario,
  danoDobrado,
  distributeItems,
} = require('../items');

function makeChamber(sequencia) {
  return { sequencia: [...sequencia] };
}

describe('verMunicao', () => {
  test('revela a bala do topo sem remover', () => {
    const chamber = makeChamber(['real', 'vazia']);
    const result = verMunicao(chamber);

    expect(result.bullet).toBe('real');
    expect(chamber.sequencia).toEqual(['real', 'vazia']); // não mutou
  });

  test('lança erro se chamber vazio', () => {
    expect(() => verMunicao(makeChamber([]))).toThrow();
  });
});

describe('retirarMunicao', () => {
  test('remove a bala do topo e retorna o que era', () => {
    const chamber = makeChamber(['vazia', 'real']);
    const result = retirarMunicao(chamber);

    expect(result.bullet).toBe('vazia');
    expect(chamber.sequencia).toEqual(['real']); // mutou de verdade
  });

  test('sinaliza chamberEmpty quando remove a última', () => {
    const chamber = makeChamber(['real']);
    const result = retirarMunicao(chamber);

    expect(result.chamberEmpty).toBe(true);
  });

  test('lança erro se chamber vazio', () => {
    expect(() => retirarMunicao(makeChamber([]))).toThrow();
  });
});

describe('curar', () => {
  test('recupera 1 ponto de vida', () => {
    const result = curar(3, 6);
    expect(result.newLife).toBe(4);
  });

  test('não ultrapassa vida máxima', () => {
    const result = curar(6, 6);
    expect(result.newLife).toBe(6);
  });
});

describe('travarAdversario', () => {
  test('retorna efeito correto', () => {
    const result = travarAdversario();
    expect(result.effect).toBe('skip_next_turn');
    expect(result.appliesTo).toBe('opponent');
  });
});

describe('danoDobrado', () => {
  test('retorna efeito correto', () => {
    const result = danoDobrado();
    expect(result.effect).toBe('double_damage');
    expect(result.consumedOnNextShot).toBe(true);
  });
});

describe('distributeItems', () => {
  test('gera a quantidade pedida quando inventário tem espaço', () => {
    const drawn = distributeItems([], 4);
    expect(drawn.length).toBe(4);
    drawn.forEach((item) => {
      expect(Object.values(ITEM_TYPES)).toContain(item);
    });
  });

  test('respeita o teto de inventário (não passa de MAX_INVENTORY)', () => {
    const alreadyFull = new Array(MAX_INVENTORY - 2).fill(ITEM_TYPES.CURAR);
    const drawn = distributeItems(alreadyFull, 4);
    // só cabem 2, mesmo pedindo 4
    expect(drawn.length).toBe(2);
  });

  test('não gera nada se inventário já está cheio', () => {
    const full = new Array(MAX_INVENTORY).fill(ITEM_TYPES.CURAR);
    const drawn = distributeItems(full, 4);
    expect(drawn.length).toBe(0);
  });

  test('distribuição é aproximadamente uniforme entre os 5 tipos (checagem estatística)', () => {
    const counts = {};
    Object.values(ITEM_TYPES).forEach((t) => (counts[t] = 0));

    const RUNS = 5000;
    for (let i = 0; i < RUNS; i++) {
      const [item] = distributeItems([], 1);
      counts[item]++;
    }

    const expected = RUNS / 5;
    Object.values(counts).forEach((count) => {
      // margem generosa (±30%) só pra pegar viés grosseiro, evitar flaky test
      expect(count).toBeGreaterThan(expected * 0.7);
      expect(count).toBeLessThan(expected * 1.3);
    });
  });
});