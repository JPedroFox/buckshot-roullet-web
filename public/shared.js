'use strict';

const TOKEN_KEY = 'buckshot_token';
const USERNAME_KEY = 'buckshot_username';

function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

function getUsername() {
  return localStorage.getItem(USERNAME_KEY);
}

function setSession(token, username) {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(USERNAME_KEY, username);
}

function clearSession() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USERNAME_KEY);
}

/**
 * Chama pra proteger uma página: se não tiver sessão salva, manda pra
 * tela de login e devolve false (quem chamou deve parar a execução).
 */
function requireAuth() {
  if (!getToken()) {
    window.location.href = '/index.html';
    return false;
  }
  return true;
}

/**
 * Se já tem sessão salva, não faz sentido mostrar login/cadastro de novo.
 * Usado em index.html e register.html.
 */
function redirectIfAlreadyLoggedIn() {
  if (getToken()) {
    window.location.href = '/profile.html';
  }
}

async function callAuthEndpoint(path, username, password) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'erro desconhecido');
  return data;
}
