'use strict';

const { generateChamber, MIN_BULLETS, MAX_BULLETS } = require('../chamber');

describe('generateChamber', () => {
  // Roda muitas vezes porque a função é aleatória — precisa cobrir o
  // espaço de possibilidades, não só uma amostra.
  const RUNS = 2000;

  test('total sempre entre 2 e 8', () => {
    for (let i = 0; i < RUNS; i++) {
      const { total } = generateChamber();
      expect(total).toBeGreaterThanOrEqual(MIN_BULLETS);
      expect(total).toBeLessThanOrEqual(MAX_BULLETS);
    }
  });

  test('sempre pelo menos 1 real e 1 vazia', () => {
    for (let i = 0; i < RUNS; i++) {
      const { real, vazia } = generateChamber();
      expect(real).toBeGreaterThanOrEqual(1);
      expect(vazia).toBeGreaterThanOrEqual(1);
    }
  });

  test('real + vazia === total, sempre', () => {
    for (let i = 0; i < RUNS; i++) {
      const { total, real, vazia } = generateChamber();
      expect(real + vazia).toBe(total);
    }
  });

  test('sequencia tem o mesmo tamanho que total', () => {
    for (let i = 0; i < RUNS; i++) {
      const { total, sequencia } = generateChamber();
      expect(sequencia.length).toBe(total);
    }
  });

  test('sequencia contém exatamente a contagem de real/vazia declarada', () => {
    for (let i = 0; i < RUNS; i++) {
      const { real, vazia, sequencia } = generateChamber();
      const realCount = sequencia.filter((b) => b === 'real').length;
      const vaziaCount = sequencia.filter((b) => b === 'vazia').length;
      expect(realCount).toBe(real);
      expect(vaziaCount).toBe(vazia);
    }
  });

  test('quando total é 2, é sempre exatamente 1 real e 1 vazia (sem sorteio extra)', () => {
    // Não dá pra forçar total=2 diretamente (é aleatório), então filtramos
    // as execuções onde isso aconteceu naturalmente.
    let found = false;
    for (let i = 0; i < RUNS; i++) {
      const { total, real, vazia } = generateChamber();
      if (total === 2) {
        found = true;
        expect(real).toBe(1);
        expect(vazia).toBe(1);
      }
    }
    // Com 2000 runs e 7 valores possíveis, é praticamente certo que total=2
    // apareça pelo menos uma vez. Se isso falhar, o gerador de total está enviesado.
    expect(found).toBe(true);
  });

  test('a proporção de reais extras converge perto de 70% (checagem estatística, não exata)', () => {
    // Isola só os casos com total=8 (6 balas extras) pra ter uma amostra
    // grande e consistente de "balas extras".
    let extraReal = 0;
    let extraTotal = 0;
    for (let i = 0; i < RUNS; i++) {
      const { total, real } = generateChamber();
      if (total === MAX_BULLETS) {
        // das 6 extras, quantas foram reais (descontando a 1 garantida)
        extraReal += real - 1;
        extraTotal += 6;
      }
    }
    if (extraTotal > 0) {
      const ratio = extraReal / extraTotal;
      // margem generosa pra evitar teste flaky, só detecta desvio grosseiro
      expect(ratio).toBeGreaterThan(0.55);
      expect(ratio).toBeLessThan(0.85);
    }
  });
});