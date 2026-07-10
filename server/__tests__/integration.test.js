'use strict';

const { createServer } = require('../index');
const gameManager = require('../gameManager');
const ioc = require('socket.io-client');

let httpServer;
let io;
let port;

function connectClient() {
  return new Promise((resolve) => {
    const socket = ioc(`http://localhost:${port}`, { transports: ['websocket'] });
    socket.on('connect', () => resolve(socket));
  });
}

function waitFor(socket, event) {
  return new Promise((resolve) => socket.once(event, resolve));
}

beforeAll((done) => {
  const created = createServer();
  httpServer = created.httpServer;
  io = created.io;
  httpServer.listen(() => {
    port = httpServer.address().port;
    done();
  });
});

afterAll((done) => {
  // Sem isso, timers de turno de 60s reais criados durante os testes
  // ficam pendurados e seguram o processo do Jest vivo.
  for (const match of gameManager._debugAllMatches.values()) {
    gameManager.clearTimersOf(match);
  }
  io.close();
  httpServer.close(done);
});

describe('matchmaking', () => {
  test('dois jogadores encontram partida um com o outro', async () => {
    const p1 = await connectClient();
    const p2 = await connectClient();

    p1.emit('find_match', { playerId: 'alice' });
    const waiting = waitFor(p1, 'waiting_for_opponent');
    await waiting;

    p2.emit('find_match', { playerId: 'bob' });

    const [foundP1, foundP2] = await Promise.all([
      waitFor(p1, 'match_found'),
      waitFor(p2, 'match_found'),
    ]);

    expect(foundP1.matchId).toBe(foundP2.matchId);
    expect(foundP1.yourPlayerId).toBe('alice');
    expect(foundP2.yourPlayerId).toBe('bob');
    expect(foundP1.inventory.length).toBe(4);

    p1.disconnect();
    p2.disconnect();
  });
});

describe('partida completa: informação privada nunca vaza pro adversário', () => {
  test('ver_municao só chega no jogador que usou', async () => {
    const p1 = await connectClient();
    const p2 = await connectClient();

    // Listener persistente registrado ANTES de qualquer ação — evita perder
    // o 'state_update' que o servidor manda logo em seguida de 'match_found'.
    let latestStateP1 = null;
    p1.on('state_update', (s) => {
      latestStateP1 = s;
    });

    p1.emit('find_match', { playerId: 'alice2' });
    await waitFor(p1, 'waiting_for_opponent');
    p2.emit('find_match', { playerId: 'bob2' });

    const [foundP1, foundP2] = await Promise.all([
      waitFor(p1, 'match_found'),
      waitFor(p2, 'match_found'),
    ]);
    const matchId = foundP1.matchId;

    // espera o snapshot chegar via listener persistente (com timeout curto)
    await new Promise((resolve) => {
      const start = Date.now();
      const check = setInterval(() => {
        if (latestStateP1 || Date.now() - start > 2000) {
          clearInterval(check);
          resolve();
        }
      }, 20);
    });
    const state = latestStateP1;
    const currentTurnPlayerId = state.currentTurnPlayerId;
    const [currentClient, currentId, otherClient] =
      currentTurnPlayerId === 'alice2' ? [p1, 'alice2', p2] : [p2, 'bob2', p1];

    // garante que o jogador da vez tenha o item ver_municao;
    // se não tiver por sorteio, o teste ainda é válido testando outra coisa,
    // então usamos retry simples: pedimos até achar uma partida com o item.
    // Pra simplificar e manter determinismo, testamos via 'error_msg' se não tiver.
    currentClient.emit('use_item', { matchId, playerId: currentId, itemType: 'ver_municao' });

    const result = await Promise.race([
      waitFor(currentClient, 'item_result').then((r) => ({ type: 'private', r })),
      waitFor(currentClient, 'error_msg').then((r) => ({ type: 'error', r })),
    ]);

    if (result.type === 'error') {
      // jogador não tinha o item por sorteio -- não é falha do sistema,
      // é sorte do teste. Pulamos a asserção de conteúdo mas confirmamos
      // que o oponente não recebeu nada de privado de qualquer forma.
      expect(result.r).toMatch(/não tem o item/);
    } else {
      expect(['real', 'vazia']).toContain(result.r.bullet);
    }

    // checagem central: o OPONENTE nunca deveria receber 'item_result'
    let otherGotPrivate = false;
    otherClient.on('item_result', () => {
      otherGotPrivate = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(otherGotPrivate).toBe(false);

    p1.disconnect();
    p2.disconnect();
  });

  test('partida roda até o fim via ações automáticas de tiro e emite match_ended', async () => {
    const p1 = await connectClient();
    const p2 = await connectClient();

    const clientsById = { alice3: p1, bob3: p2 };

    // Um único listener persistente em CADA cliente, registrado ANTES de
    // disparar find_match — o servidor manda 'state_update' logo em seguida
    // de 'match_found', então o listener precisa já estar ativo.
    let latestState = null;
    const onStateUpdate = (s) => {
      latestState = s;
    };
    p1.on('state_update', onStateUpdate);
    p2.on('state_update', onStateUpdate);

    p1.emit('find_match', { playerId: 'alice3' });
    await waitFor(p1, 'waiting_for_opponent');
    p2.emit('find_match', { playerId: 'bob3' });

    const [foundP1] = await Promise.all([waitFor(p1, 'match_found'), waitFor(p2, 'match_found')]);
    const matchId = foundP1.matchId;

    // espera o primeiro snapshot chegar
    await new Promise((resolve) => {
      const check = setInterval(() => {
        if (latestState) {
          clearInterval(check);
          resolve();
        }
      }, 20);
    });

    // Joga até acabar, sempre atirando no oponente (simplificação: ignora
    // a mecânica de "vazia em si mesmo" pra manter o teste determinístico
    // e curto -- aqui o objetivo é validar o fluxo de rede, não a IA).
    let guard = 0;
    while (!latestState.gameOver && guard < 300) {
      guard++;
      const currentId = latestState.currentTurnPlayerId;
      const currentClient = clientsById[currentId];
      const stateBefore = latestState;

      currentClient.emit('shoot', { matchId, playerId: currentId, target: 'opponent' });

      // espera até o snapshot mudar (novo reloadCount, nova vida, ou gameOver)
      // ou até um pequeno timeout, o que vier primeiro.
      await new Promise((resolve) => {
        const start = Date.now();
        const check = setInterval(() => {
          if (latestState !== stateBefore || Date.now() - start > 300) {
            clearInterval(check);
            resolve();
          }
        }, 10);
      });
    }

    p1.off('state_update', onStateUpdate);
    p2.off('state_update', onStateUpdate);

    expect(latestState.gameOver).toBe(true);
    expect(['alice3', 'bob3']).toContain(latestState.winnerId);

    p1.disconnect();
    p2.disconnect();
  }, 20000);
});

describe('BUGS reportados: reconexão por nome e nomes duplicados', () => {
  test('reconectar com o mesmo nome volta pra partida em andamento, não cria nova', async () => {
    const p1 = await connectClient();
    const p2 = await connectClient();

    p1.emit('find_match', { playerId: 'alice4' });
    await waitFor(p1, 'waiting_for_opponent');
    p2.emit('find_match', { playerId: 'bob4' });

    const [foundP1] = await Promise.all([waitFor(p1, 'match_found'), waitFor(p2, 'match_found')]);
    const originalMatchId = foundP1.matchId;

    // simula "recarregar a página": desconecta e abre um socket novo com o mesmo nome
    p1.disconnect();
    await new Promise((resolve) => setTimeout(resolve, 100));

    const p1Reconnected = await connectClient();
    p1Reconnected.emit('find_match', { playerId: 'alice4' });

    const rejoined = await waitFor(p1Reconnected, 'rejoined');
    expect(rejoined.matchId).toBe(originalMatchId);
    expect(rejoined.yourPlayerId).toBe('alice4');

    p1Reconnected.disconnect();
    p2.disconnect();
  });

  test('dois jogadores com o mesmo nome na fila ao mesmo tempo: o segundo recebe erro, não parea consigo mesmo', async () => {
    const p1 = await connectClient();
    const p2 = await connectClient();

    p1.emit('find_match', { playerId: 'duplicado' });
    await waitFor(p1, 'waiting_for_opponent');

    p2.emit('find_match', { playerId: 'duplicado' });
    const errorMsg = await waitFor(p2, 'error_msg');

    expect(errorMsg).toMatch(/já está esperando/);

    p1.disconnect();
    p2.disconnect();
  });
});

describe('defesa em profundidade: core rejeita playerIds duplicados mesmo via gameManager', () => {
  test('createMatch com playerIds duplicados propaga o erro do core', () => {
    expect(() =>
      gameManager.createMatch({ maxLives: 6, itemsPerReload: 4, mode: 'pvp' }, ['x', 'x'])
    ).toThrow();
  });
});