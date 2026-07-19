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

/**
 * GET autenticado via header Authorization: Bearer <token>.
 * Usado pra endpoints protegidos como /auth/me.
 */
async function fetchAuthed(path) {
  const res = await fetch(path, {
    headers: { Authorization: 'Bearer ' + getToken() },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'erro desconhecido');
  return data;
}

/**
 * Checa se o usuário já completou o tutorial de PvE (partida até o
 * fim, vencendo as 3 fases). Usado pra proteger PvP e ranking mesmo se
 * alguém digitar a URL direto, sem passar pelos botões do perfil (que
 * já ficam desabilitados, mas isso sozinho não é proteção de verdade
 * -- o servidor também bloqueia find_match e /ranking/leaderboard).
 * Se bloqueado, redireciona pro perfil com um aviso e devolve false.
 */
async function requirePveCompleted() {
  try {
    const { user } = await fetchAuthed('/auth/me');
    if (!user.pveCompleted) {
      alert('Vença uma partida de PvE (as 3 fases) primeiro antes de acessar o PvP/ranking.');
      window.location.href = '/profile.html';
      return false;
    }
    return true;
  } catch (err) {
    // se não conseguimos nem checar, não arrisca -- manda pro perfil
    window.location.href = '/profile.html';
    return false;
  }
}
