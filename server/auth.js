'use strict';

const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { pool } = require('./db');

// ATENÇÃO: em produção isso TEM que vir de variável de ambiente.
// Esse valor default só existe pra não travar o dev local; se o
// servidor subir com esse valor em produção, qualquer um que leia o
// código-fonte pode forjar tokens de qualquer usuário.
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-troque-em-producao';
const JWT_EXPIRES_IN = '7d';
const SALT_ROUNDS = 10;
const USERNAME_REGEX = /^[a-zA-Z0-9_]{3,20}$/;
const MIN_PASSWORD_TYPES = 2;

class AuthError extends Error {}

function normalizeUsername(username) {
  return String(username || '').trim().toLowerCase();
}

/**
 * Conta quantos tipos de caractere aparecem na senha: minúscula,
 * maiúscula, número, símbolo. Espelha a mesma regra usada no
 * checklist/barra de força do register.html -- se um lado mudar, o
 * outro tem que mudar junto ou a UI mente sobre o que o servidor aceita.
 */
function countPasswordTypes(password) {
  let types = 0;
  if (/[a-z]/.test(password)) types++;
  if (/[A-Z]/.test(password)) types++;
  if (/[0-9]/.test(password)) types++;
  if (/[^a-zA-Z0-9]/.test(password)) types++;
  return types;
}

function signToken(user) {
  return jwt.sign({ sub: user.id, username: user.username }, JWT_SECRET, {
    expiresIn: JWT_EXPIRES_IN,
  });
}

/**
 * Lança se o token for inválido/expirado. Quem chama decide o que fazer.
 */
function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

async function registerUser(username, password) {
  if (!username || !password) {
    throw new AuthError('username e password são obrigatórios');
  }
  const normalized = normalizeUsername(username);
  if (!USERNAME_REGEX.test(normalized)) {
    throw new AuthError('username deve ter 3-20 caracteres: letras, números e _ apenas');
  }
  if (password.length < 6) {
    throw new AuthError('senha precisa ter pelo menos 6 caracteres');
  }
  if (countPasswordTypes(password) < MIN_PASSWORD_TYPES) {
    throw new AuthError('senha muito fraca: combine pelo menos 2 tipos de caractere (minúsculas, maiúsculas, números, símbolos)');
  }

  const existing = await pool.query('SELECT id FROM users WHERE username = $1', [normalized]);
  if (existing.rows.length > 0) {
    throw new AuthError('esse username já está em uso');
  }

  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
  const result = await pool.query(
    'INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id, username',
    [normalized, passwordHash]
  );
  const user = result.rows[0];
  return { user, token: signToken(user) };
}

async function loginUser(username, password) {
  if (!username || !password) {
    throw new AuthError('username e password são obrigatórios');
  }
  const normalized = normalizeUsername(username);
  const result = await pool.query(
    'SELECT id, username, password_hash FROM users WHERE username = $1',
    [normalized]
  );

  // Mensagem genérica de propósito: não revelar se foi o username que
  // não existe ou a senha que está errada (evita enumeração de contas).
  const genericError = () => new AuthError('usuário ou senha inválidos');

  if (result.rows.length === 0) {
    throw genericError();
  }
  const row = result.rows[0];
  const valid = await bcrypt.compare(password, row.password_hash);
  if (!valid) {
    throw genericError();
  }

  const user = { id: row.id, username: row.username };
  return { user, token: signToken(user) };
}

module.exports = {
  registerUser,
  loginUser,
  verifyToken,
  normalizeUsername,
  countPasswordTypes,
  AuthError,
};
