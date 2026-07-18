'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret';

const express = require('express');
const request = require('supertest');
const authRoutes = require('../authRoutes');
const { pool } = require('../db');
const { verifyToken } = require('../auth');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/auth', authRoutes);
  return app;
}

const app = buildApp();

beforeEach(async () => {
  // limpa a tabela entre testes -- cada teste começa com banco vazio
  await pool.query('DELETE FROM users');
});

afterAll(async () => {
  await pool.end();
});

describe('POST /auth/register', () => {
  test('registra um usuário novo e retorna token válido', async () => {
    const res = await request(app)
      .post('/auth/register')
      .send({ username: 'alice', password: 'senha123' });

    expect(res.status).toBe(201);
    expect(res.body.user.username).toBe('alice');
    expect(res.body.token).toBeDefined();

    const decoded = verifyToken(res.body.token);
    expect(decoded.username).toBe('alice');
  });

  test('normaliza username pra lowercase', async () => {
    const res = await request(app)
      .post('/auth/register')
      .send({ username: 'AlIcE', password: 'senha123' });

    expect(res.body.user.username).toBe('alice');
  });

  test('rejeita username duplicado (case-insensitive)', async () => {
    await request(app).post('/auth/register').send({ username: 'bob', password: 'senha123' });
    const res = await request(app).post('/auth/register').send({ username: 'BOB', password: 'outrasenha1' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/já está em uso/);
  });

  test('rejeita senha curta', async () => {
    const res = await request(app).post('/auth/register').send({ username: 'carol', password: '123' });
    expect(res.status).toBe(400);
  });

  test('rejeita senha com 6+ caracteres mas só 1 tipo de caractere (fraca)', async () => {
    const res = await request(app).post('/auth/register').send({ username: 'heidi', password: 'aaaaaaaa' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/fraca/);
  });

  test('aceita senha com exatamente 2 tipos de caractere (mínimo aceitável)', async () => {
    const res = await request(app).post('/auth/register').send({ username: 'ivan', password: 'senha1234' });
    expect(res.status).toBe(201);
  });

  test('rejeita username com caracteres inválidos', async () => {
    const res = await request(app).post('/auth/register').send({ username: 'a b!@#', password: 'senha123' });
    expect(res.status).toBe(400);
  });

  test('rejeita campos faltando', async () => {
    const res = await request(app).post('/auth/register').send({ username: 'dave' });
    expect(res.status).toBe(400);
  });

  test('NUNCA retorna o password_hash na resposta', async () => {
    const res = await request(app)
      .post('/auth/register')
      .send({ username: 'eve', password: 'senha123' });
    expect(res.body.user.password_hash).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toMatch(/senha123/);
  });
});

describe('POST /auth/login', () => {
  beforeEach(async () => {
    await request(app).post('/auth/register').send({ username: 'frank', password: 'senhacerta1' });
  });

  test('login com credenciais corretas retorna token', async () => {
    const res = await request(app).post('/auth/login').send({ username: 'frank', password: 'senhacerta1' });
    expect(res.status).toBe(200);
    expect(res.body.token).toBeDefined();
  });

  test('login funciona com case diferente no username', async () => {
    const res = await request(app).post('/auth/login').send({ username: 'FRANK', password: 'senhacerta1' });
    expect(res.status).toBe(200);
  });

  test('senha errada retorna 401 com mensagem genérica', async () => {
    const res = await request(app).post('/auth/login').send({ username: 'frank', password: 'senhaerrada' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('usuário ou senha inválidos');
  });

  test('username inexistente retorna a MESMA mensagem genérica (não revela se a conta existe)', async () => {
    const res = await request(app).post('/auth/login').send({ username: 'naoexiste', password: 'qualquer123' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('usuário ou senha inválidos');
  });
});

describe('senha é armazenada com hash, nunca em texto puro', () => {
  test('password_hash no banco não contém a senha original', async () => {
    await request(app).post('/auth/register').send({ username: 'grace', password: 'minhasenha123' });
    const result = await pool.query('SELECT password_hash FROM users WHERE username = $1', ['grace']);
    expect(result.rows[0].password_hash).not.toBe('minhasenha123');
    expect(result.rows[0].password_hash).not.toContain('minhasenha123');
    expect(result.rows[0].password_hash.startsWith('$2')).toBe(true); // formato bcrypt
  });
});
