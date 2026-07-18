'use strict';

process.env.JWT_SECRET = 'test-secret';

const jwt = require('jsonwebtoken');
const { createServer } = require('../index');
const gameManager = require('../gameManager');
const { pool } = require('../db');
const ioc = require('socket.io-client');

let httpServer;
let io;
let port;

// `sub: null` de propósito: esses usernames de teste NÃO existem na
// tabela `users` (não passaram por /auth/register), então não têm um
// id bigint real. Se sub fosse a string do username, a tentativa de
// persistir resultado de partida quebraria (bigint inválido). Com
// sub null, matchRepository.saveMatchResult grava a partida mas pula
// a atualização de estatísticas do usuário (checa `if (p.userId)`).
function tokenFor(username) {
  return jwt.sign({ sub: null, username }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

function connectClient(username) {
  return new Promise((resolve, reject) => {
    const socket = ioc(`http://localhost:${port}`, {
      transports: ['websocket'],
      auth: { token: tokenFor(username) },
    });
    socket.on('connect', () => resolve(socket));
    socket.on('connect_error', (err) => reject(err));
  });
}

function connectClientRaw(authPayload) {
  return new Promise((resolve, reject) => {
    const socket = ioc(`http://localhost:${port}`, {
      transports: ['websocket'],
      auth: authPayload,
    });
    socket.on('connect', () => resolve(socket));
    socket.on('connect_error', (err) => reject(err));
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

afterAll(async () => {
  for (const match of gameManager._debugAllMatches.values()) {
    gameManager.clearTimersOf(match);
  }
  io.close();
  await new Promise((resolve) => httpServer.close(resolve));
  // Sem isso, a conexão do pool do Postgres aberta pelas partidas que
  // terminaram durante os testes (persistMatchIfNeeded) fica pendurada
  // e o worker do Jest não sai limpo no final.
  await pool.end();
});

describe('autenticação do socket', () => {
  test('conexão sem token é rejeitada', async () => {
    await expect(connectClientRaw({})).rejects.toBeTruthy();
  });

  test('conexão com token inválido é rejeitada', async () => {
    await expect(connectClientRaw({ token: 'token-forjado-invalido' })).rejects.toBeTruthy();
  });

  test('conexão com token válido funciona', async () => {
    const socket = await connectClient('validuser');
    expect(socket.connected).toBe(true);
    socket.disconnect();
  });
});

describe('matchmaking', () => {
  test('dois jogadores encontram partida um com o outro, identidade vem do token', async () => {
    const p1 = await connectClient('alice');
    const p2 = await connectClient('bob');

    p1.emit('find_match');
    await waitFor(p1, 'waiting_for_opponent');
    p2.emit('find_match');

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

  test('BUG antigo (impersonation): playerId enviado no payload é ignorado, só o token vale', async () => {
    const p1 = await connectClient('realuser');
    p1.emit('find_match', { playerId: 'nome_forjado_tentando_ser_outro_alguem' });
    await waitFor(p1, 'waiting_for_opponent');

    const p2 = await connectClient('outrouser');
    p2.emit('find_match');
    const [foundP1] = await Promise.all([waitFor(p1, 'match_found'), waitFor(p2, 'match_found')]);

    expect(foundP1.yourPlayerId).toBe('realuser');

    p1.disconnect();
    p2.disconnect();
  });
});

describe('partida completa: informação privada nunca vaza pro adversário', () => {
  test('ver_municao só chega no jogador que usou', async () => {
    const p1 = await connectClient('alice2');
    const p2 = await connectClient('bob2');

    let latestStateP1 = null;
    p1.on('state_update', (s) => {
      latestStateP1 = s;
    });

    p1.emit('find_match');
    await waitFor(p1, 'waiting_for_opponent');
    p2.emit('find_match');

    const [foundP1] = await Promise.all([waitFor(p1, 'match_found'), waitFor(p2, 'match_found')]);
    const matchId = foundP1.matchId;

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
    const [currentClient, otherClient] =
      currentTurnPlayerId === 'alice2' ? [p1, p2] : [p2, p1];

    currentClient.emit('use_item', { matchId, itemType: 'ver_municao' });

    const result = await Promise.race([
      waitFor(currentClient, 'item_result').then((r) => ({ type: 'private', r })),
      waitFor(currentClient, 'error_msg').then((r) => ({ type: 'error', r })),
    ]);

    if (result.type === 'error') {
      expect(result.r).toMatch(/não tem o item/);
    } else {
      expect(['real', 'vazia']).toContain(result.r.bullet);
    }

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
    const p1 = await connectClient('alice3');
    const p2 = await connectClient('bob3');
    const clientsById = { alice3: p1, bob3: p2 };

    let latestState = null;
    const onStateUpdate = (s) => {
      latestState = s;
    };
    p1.on('state_update', onStateUpdate);
    p2.on('state_update', onStateUpdate);

    p1.emit('find_match');
    await waitFor(p1, 'waiting_for_opponent');
    p2.emit('find_match');

    const [foundP1] = await Promise.all([waitFor(p1, 'match_found'), waitFor(p2, 'match_found')]);
    const matchId = foundP1.matchId;

    await new Promise((resolve) => {
      const check = setInterval(() => {
        if (latestState) {
          clearInterval(check);
          resolve();
        }
      }, 20);
    });

    let guard = 0;
    while (!latestState.gameOver && guard < 300) {
      guard++;
      const currentId = latestState.currentTurnPlayerId;
      const currentClient = clientsById[currentId];
      const stateBefore = latestState;

      currentClient.emit('shoot', { matchId, target: 'opponent' });

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

describe('reconexão baseada em identidade autenticada', () => {
  test('reconectar com o mesmo token volta pra partida em andamento, não cria nova', async () => {
    const p1 = await connectClient('alice4');
    const p2 = await connectClient('bob4');

    p1.emit('find_match');
    await waitFor(p1, 'waiting_for_opponent');
    p2.emit('find_match');

    const [foundP1] = await Promise.all([waitFor(p1, 'match_found'), waitFor(p2, 'match_found')]);
    const originalMatchId = foundP1.matchId;

    p1.disconnect();
    await new Promise((resolve) => setTimeout(resolve, 100));

    const p1Reconnected = await connectClient('alice4');
    p1Reconnected.emit('find_match');

    const rejoined = await waitFor(p1Reconnected, 'rejoined');
    expect(rejoined.matchId).toBe(originalMatchId);
    expect(rejoined.yourPlayerId).toBe('alice4');

    p1Reconnected.disconnect();
    p2.disconnect();
  });

  test('mesmo usuário autenticado em duas conexões simultâneas: a segunda recebe erro ao entrar na fila', async () => {
    const p1 = await connectClient('duplicado');
    const p2 = await connectClient('duplicado');

    p1.emit('find_match');
    await waitFor(p1, 'waiting_for_opponent');

    p2.emit('find_match');
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
