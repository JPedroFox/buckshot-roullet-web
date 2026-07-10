'use strict';

const { resolveShot, TARGET_SELF, TARGET_OPPONENT } = require('../shot');

function makeChamber(sequencia) {
  return { sequencia: [...sequencia] };
}

describe('resolveShot', () => {
  test('bala real em si mesmo: causa dano, termina turno', () => {
    const chamber = makeChamber(['real', 'vazia']);
    const result = resolveShot({
      chamber,
      target: TARGET_SELF,
      shooterId: 'p1',
      opponentId: 'p2',
    });

    expect(result.bullet).toBe('real');
    expect(result.damage).toBe(1);
    expect(result.damagedPlayerId).toBe('p1');
    expect(result.turnEnds).toBe(true);
  });

  test('bala real no oponente: causa dano nele, termina turno', () => {
    const chamber = makeChamber(['real']);
    const result = resolveShot({
      chamber,
      target: TARGET_OPPONENT,
      shooterId: 'p1',
      opponentId: 'p2',
    });

    expect(result.damagedPlayerId).toBe('p2');
    expect(result.turnEnds).toBe(true);
  });

  test('bala vazia em si mesmo: sem dano, turno NÃO termina (joga de novo)', () => {
    const chamber = makeChamber(['vazia']);
    const result = resolveShot({
      chamber,
      target: TARGET_SELF,
      shooterId: 'p1',
      opponentId: 'p2',
    });

    expect(result.damage).toBe(0);
    expect(result.damagedPlayerId).toBeNull();
    expect(result.turnEnds).toBe(false);
  });

  test('bala vazia no oponente: sem dano, turno termina', () => {
    const chamber = makeChamber(['vazia']);
    const result = resolveShot({
      chamber,
      target: TARGET_OPPONENT,
      shooterId: 'p1',
      opponentId: 'p2',
    });

    expect(result.damage).toBe(0);
    expect(result.turnEnds).toBe(true);
  });

  test('dano dobrado ativo em bala real: causa 2 de dano e é consumido', () => {
    const chamber = makeChamber(['real']);
    const result = resolveShot({
      chamber,
      target: TARGET_OPPONENT,
      shooterId: 'p1',
      opponentId: 'p2',
      doubleDamageActive: true,
    });

    expect(result.damage).toBe(2);
    expect(result.doubleDamageConsumed).toBe(true);
  });

  test('dano dobrado ativo em bala vazia: não é consumido (não houve dano de verdade)', () => {
    const chamber = makeChamber(['vazia']);
    const result = resolveShot({
      chamber,
      target: TARGET_OPPONENT,
      shooterId: 'p1',
      opponentId: 'p2',
      doubleDamageActive: true,
    });

    expect(result.doubleDamageConsumed).toBe(false);
  });

  test('consome a bala do TOPO da sequência (ordem importa)', () => {
    const chamber = makeChamber(['vazia', 'real']);
    resolveShot({ chamber, target: TARGET_SELF, shooterId: 'p1', opponentId: 'p2' });

    // depois de consumir a primeira ('vazia'), deve sobrar só 'real'
    expect(chamber.sequencia).toEqual(['real']);
  });

  test('chamberEmpty vira true quando a última bala é consumida', () => {
    const chamber = makeChamber(['real']);
    const result = resolveShot({
      chamber,
      target: TARGET_OPPONENT,
      shooterId: 'p1',
      opponentId: 'p2',
    });

    expect(result.chamberEmpty).toBe(true);
    expect(chamber.sequencia.length).toBe(0);
  });

  test('chamberEmpty é false quando ainda restam balas', () => {
    const chamber = makeChamber(['real', 'vazia']);
    const result = resolveShot({
      chamber,
      target: TARGET_OPPONENT,
      shooterId: 'p1',
      opponentId: 'p2',
    });

    expect(result.chamberEmpty).toBe(false);
  });

  test('lança erro se o chamber já estiver vazio', () => {
    const chamber = makeChamber([]);
    expect(() =>
      resolveShot({ chamber, target: TARGET_SELF, shooterId: 'p1', opponentId: 'p2' })
    ).toThrow();
  });

  test('lança erro se target for inválido', () => {
    const chamber = makeChamber(['real']);
    expect(() =>
      resolveShot({ chamber, target: 'parede', shooterId: 'p1', opponentId: 'p2' })
    ).toThrow();
  });
});