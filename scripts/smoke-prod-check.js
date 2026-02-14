#!/usr/bin/env node

'use strict';

const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');
const BACKEND_BASE = String(process.env.BACKEND_BASE || 'http://127.0.0.1:3001').replace(/\/+$/, '');
const FRONTEND_BASE = String(process.env.FRONTEND_BASE || 'http://127.0.0.1:8080').replace(/\/+$/, '');
const FRONTEND_RUNTIME_HEADER = 'x-whatsapp-system-runtime';
const FRONTEND_RUNTIME_VALUE = 'electron';

const Database = require(path.join(ROOT_DIR, 'backend', 'node_modules', 'better-sqlite3'));
const { hashPasswordSync } = require(path.join(ROOT_DIR, 'backend', 'src', 'security', 'password'));

const runId = Date.now();
const qaAdminUser = `qa_admin_${runId}`;
const qaAdminPass = `Qa#${runId}Admin`;
const qaSellerName = `qa_seller_${runId}`;
const qaSellerPass = `Qa#${runId}Seller`;
const qaPhone = `55${String(runId).slice(-11)}`;
const qaBlacklistPhone = `55${String(runId + 7).slice(-11)}`;

const cleanupState = {
  dbPath: null,
  adminCreated: false,
  adminUsername: qaAdminUser,
  sellerId: null,
  sellerName: qaSellerName,
  ticketId: null,
  reminderId: null,
  businessExceptionDate: null,
  blacklistPhones: new Set(),
};

const failures = [];
const passes = [];

function logPass(name, details = '') {
  passes.push({ name, details });
  console.log(`PASS ${name}${details ? ` - ${details}` : ''}`);
}

function logFail(name, error) {
  const msg = error && error.message ? error.message : String(error);
  failures.push({ name, error: msg });
  console.error(`FAIL ${name} - ${msg}`);
}

function ensure(condition, message) {
  if (!condition) throw new Error(message);
}

function jsonHeaders(token, extraHeaders = {}) {
  const headers = {
    'Content-Type': 'application/json',
    ...extraHeaders,
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function httpRequest(base, route, {
  method = 'GET',
  token = null,
  headers = {},
  json = undefined,
  body = undefined,
  expected = [200],
  timeoutMs = 15000,
} = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const requestHeaders = { ...headers };
    let requestBody = body;

    if (json !== undefined) {
      requestBody = JSON.stringify(json);
      if (!requestHeaders['Content-Type']) requestHeaders['Content-Type'] = 'application/json';
    }

    if (token) requestHeaders.Authorization = `Bearer ${token}`;

    const res = await fetch(`${base}${route}`, {
      method,
      headers: requestHeaders,
      body: requestBody,
      signal: controller.signal,
    });

    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch (_) {
      data = null;
    }

    ensure(expected.includes(res.status), `status ${res.status} inesperado (esperado: ${expected.join(',')})`);

    return {
      status: res.status,
      text,
      data,
      headers: res.headers,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function runStep(name, fn) {
  try {
    const details = await fn();
    logPass(name, details || 'ok');
  } catch (error) {
    logFail(name, error);
  }
}

function openDb(dbPath) {
  return new Database(dbPath);
}

function createQaAdmin(dbPath) {
  const db = openDb(dbPath);
  try {
    const exists = db.prepare("SELECT id FROM users WHERE username = ? AND role = 'admin'").get(qaAdminUser);
    if (!exists) {
      const hash = hashPasswordSync(qaAdminPass);
      db.prepare('INSERT INTO users (username, password, role) VALUES (?, ?, ?)').run(qaAdminUser, hash, 'admin');
      cleanupState.adminCreated = true;
    }
  } finally {
    db.close();
  }
}

function insertQaTicket(dbPath) {
  const db = openDb(dbPath);
  try {
    const info = db.prepare(
      "INSERT INTO tickets (phone, status, contact_name, created_at, updated_at) VALUES (?, 'pendente', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)"
    ).run(qaPhone, 'QA Smoke Ticket');

    const ticketId = Number(info.lastInsertRowid);
    const msgInfo = db.prepare(
      "INSERT INTO messages (ticket_id, sender, content, created_at, updated_at) VALUES (?, 'client', ?, datetime('now', '-2 minutes'), datetime('now', '-2 minutes'))"
    ).run(ticketId, 'Mensagem de teste QA');

    cleanupState.ticketId = ticketId;
    return { ticketId, messageId: Number(msgInfo.lastInsertRowid) };
  } finally {
    db.close();
  }
}

function cleanupDbArtifacts() {
  if (!cleanupState.dbPath) return;

  const db = openDb(cleanupState.dbPath);
  try {
    if (cleanupState.reminderId) {
      try { db.prepare('DELETE FROM ticket_reminders WHERE id = ?').run(cleanupState.reminderId); } catch (_) {}
    }

    if (cleanupState.ticketId) {
      try { db.prepare('DELETE FROM ticket_reminders WHERE ticket_id = ?').run(cleanupState.ticketId); } catch (_) {}
      try { db.prepare('DELETE FROM messages WHERE ticket_id = ?').run(cleanupState.ticketId); } catch (_) {}
      try { db.prepare('DELETE FROM tickets WHERE id = ?').run(cleanupState.ticketId); } catch (_) {}
    }

    if (cleanupState.sellerId) {
      try { db.prepare('UPDATE tickets SET seller_id = NULL WHERE seller_id = ?').run(cleanupState.sellerId); } catch (_) {}
      try { db.prepare('DELETE FROM sellers WHERE id = ?').run(cleanupState.sellerId); } catch (_) {}
    } else {
      try { db.prepare('DELETE FROM sellers WHERE name = ?').run(cleanupState.sellerName); } catch (_) {}
    }

    for (const phone of cleanupState.blacklistPhones) {
      try { db.prepare('DELETE FROM blacklist WHERE phone = ?').run(phone); } catch (_) {}
    }

    if (cleanupState.businessExceptionDate) {
      try { db.prepare('DELETE FROM business_exceptions WHERE date = ?').run(cleanupState.businessExceptionDate); } catch (_) {}
    }

    if (cleanupState.adminCreated) {
      try { db.prepare('DELETE FROM sellers WHERE name = ?').run(cleanupState.adminUsername); } catch (_) {}
      try { db.prepare("DELETE FROM users WHERE username = ? AND role = 'admin'").run(cleanupState.adminUsername); } catch (_) {}
    }
  } finally {
    db.close();
  }
}

async function testSseEvents(token) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);

  try {
    const res = await fetch(`${BACKEND_BASE}/events`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });

    ensure(res.status === 200, `status ${res.status} inesperado`);
    const ct = String(res.headers.get('content-type') || '');
    ensure(ct.includes('text/event-stream'), `content-type inesperado: ${ct || '(vazio)'}`);

    const reader = res.body && res.body.getReader ? res.body.getReader() : null;
    ensure(reader, 'stream SSE indisponivel');

    const firstChunk = await Promise.race([
      reader.read(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout lendo SSE')), 2500)),
    ]);

    const payload = firstChunk && firstChunk.value ? Buffer.from(firstChunk.value).toString('utf8') : '';
    ensure(payload.includes('event: ready'), 'evento inicial SSE nao encontrado');

    try { await reader.cancel(); } catch (_) {}
    return 'ready event recebido';
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  let adminToken = null;
  let sellerToken = null;
  let ticketId = null;
  let messageId = null;
  let reminderId = null;

  await runStep('Backend healthz', async () => {
    const res = await httpRequest(BACKEND_BASE, '/healthz', { expected: [200] });
    ensure(res.data && res.data.ok === true, 'healthz sem ok=true');
    ensure(res.data && res.data.dbPath, 'healthz sem dbPath');
    cleanupState.dbPath = res.data.dbPath;
    return `db=${cleanupState.dbPath}`;
  });

  if (!cleanupState.dbPath) {
    throw new Error('Nao foi possivel obter dbPath do backend. Abortando.');
  }

  createQaAdmin(cleanupState.dbPath);

  await runStep('Public connection status', async () => {
    await httpRequest(BACKEND_BASE, '/connection-status', { expected: [200] });
    return 'ok';
  });

  await runStep('Public auth has-admin', async () => {
    const res = await httpRequest(BACKEND_BASE, '/auth/has-admin', { expected: [200] });
    ensure(res.data && typeof res.data.hasAdmin === 'boolean', 'payload invalido');
    return `hasAdmin=${res.data.hasAdmin}`;
  });

  await runStep('Unauth session denied', async () => {
    await httpRequest(BACKEND_BASE, '/auth/session', { expected: [401] });
    return '401 ok';
  });

  await runStep('Unauth users denied', async () => {
    await httpRequest(BACKEND_BASE, '/users', { expected: [401] });
    return '401 ok';
  });

  await runStep('Unauth sellers create denied', async () => {
    await httpRequest(BACKEND_BASE, '/sellers', {
      method: 'POST',
      json: { name: `noauth_${runId}`, password: 'NoAuth#123' },
      expected: [401],
    });
    return '401 ok';
  });

  await runStep('Unauth blacklist denied', async () => {
    await httpRequest(BACKEND_BASE, '/blacklist', { expected: [401] });
    return '401 ok';
  });

  await runStep('Admin login', async () => {
    const res = await httpRequest(BACKEND_BASE, '/auth/login', {
      method: 'POST',
      json: { username: qaAdminUser, password: qaAdminPass },
      expected: [200],
    });
    ensure(res.data && res.data.accessToken, 'login sem accessToken');
    adminToken = res.data.accessToken;
    return `user=${qaAdminUser}`;
  });

  if (!adminToken) throw new Error('Login admin falhou.');

  await runStep('Admin session', async () => {
    const res = await httpRequest(BACKEND_BASE, '/auth/session', { token: adminToken, expected: [200] });
    ensure(res.data && res.data.authenticated === true, 'sessao admin invalida');
    return `${res.data.userType}`;
  });

  await runStep('Admin users list', async () => {
    const res = await httpRequest(BACKEND_BASE, '/users', { token: adminToken, expected: [200] });
    ensure(Array.isArray(res.data), 'users nao retornou array');
    return `count=${res.data.length}`;
  });

  await runStep('Admin sellers list', async () => {
    const res = await httpRequest(BACKEND_BASE, '/sellers', { token: adminToken, expected: [200] });
    ensure(Array.isArray(res.data), 'sellers nao retornou array');
    return `count=${res.data.length}`;
  });

  await runStep('Admin assignees', async () => {
    const res = await httpRequest(BACKEND_BASE, '/assignees', { token: adminToken, expected: [200] });
    ensure(Array.isArray(res.data), 'assignees nao retornou array');
    return `count=${res.data.length}`;
  });

  await runStep('Admin ranking sellers', async () => {
    const res = await httpRequest(BACKEND_BASE, '/admin/ranking-sellers', { token: adminToken, expected: [200] });
    ensure(res.data && Array.isArray(res.data.ranking), 'ranking invalido');
    return `count=${res.data.ranking.length}`;
  });

  await runStep('Admin account', async () => {
    const res = await httpRequest(BACKEND_BASE, '/admin/account', { token: adminToken, expected: [200] });
    ensure(res.data && Object.prototype.hasOwnProperty.call(res.data, 'account'), 'payload invalido');
    return `account=${res.data.account || 'null'}`;
  });

  let businessHours = null;
  await runStep('Business hours get', async () => {
    const res = await httpRequest(BACKEND_BASE, '/business-hours', { token: adminToken, expected: [200] });
    ensure(Array.isArray(res.data), 'business-hours nao retornou array');
    businessHours = res.data;
    return `count=${businessHours.length}`;
  });

  await runStep('Business hours put (idempotent)', async () => {
    ensure(Array.isArray(businessHours), 'businessHours ausente');
    await httpRequest(BACKEND_BASE, '/business-hours', {
      method: 'PUT',
      token: adminToken,
      json: businessHours,
      expected: [200],
    });
    return 'ok';
  });

  await runStep('Business exceptions create/delete', async () => {
    const d = new Date(Date.now() + (24 * 60 * 60 * 1000 * 33));
    const date = d.toISOString().slice(0, 10);
    cleanupState.businessExceptionDate = date;

    const create = await httpRequest(BACKEND_BASE, '/business-exceptions', {
      method: 'POST',
      token: adminToken,
      json: {
        date,
        closed: true,
        reason: 'QA smoke exception',
      },
      expected: [201],
    });

    const list = await httpRequest(BACKEND_BASE, '/business-exceptions', {
      token: adminToken,
      expected: [200],
    });

    ensure(Array.isArray(list.data), 'business-exceptions nao retornou array');
    const row = list.data.find((x) => String(x.date) === date);
    ensure(row, 'excecao de negocio nao encontrada apos criar');

    await httpRequest(BACKEND_BASE, `/business-exceptions/${row.id}`, {
      method: 'DELETE',
      token: adminToken,
      expected: [200],
    });

    cleanupState.businessExceptionDate = null;
    return `date=${date}`;
  });

  let businessMessage = null;
  await runStep('Business message get', async () => {
    const res = await httpRequest(BACKEND_BASE, '/business-message', { token: adminToken, expected: [200] });
    ensure(res.data && Object.prototype.hasOwnProperty.call(res.data, 'enabled'), 'payload invalido');
    businessMessage = res.data;
    return 'ok';
  });

  await runStep('Business message put (idempotent)', async () => {
    await httpRequest(BACKEND_BASE, '/business-message', {
      method: 'PUT',
      token: adminToken,
      json: {
        message: String((businessMessage && businessMessage.message) || '').trim() || 'Mensagem QA',
        enabled: !!(businessMessage && businessMessage.enabled),
      },
      expected: [200],
    });
    return 'ok';
  });

  let awaitMinutes = 0;
  await runStep('Await config get/put', async () => {
    const getRes = await httpRequest(BACKEND_BASE, '/admin/await-config', { token: adminToken, expected: [200] });
    awaitMinutes = Number((getRes.data && getRes.data.minutes) || 0);

    await httpRequest(BACKEND_BASE, '/admin/await-config', {
      method: 'PUT',
      token: adminToken,
      json: { minutes: awaitMinutes },
      expected: [200],
    });

    return `minutes=${awaitMinutes}`;
  });

  await runStep('Create seller', async () => {
    const res = await httpRequest(BACKEND_BASE, '/sellers', {
      method: 'POST',
      token: adminToken,
      json: { name: qaSellerName, password: qaSellerPass },
      expected: [201],
    });

    ensure(res.data && res.data.id, 'seller criado sem id');
    cleanupState.sellerId = Number(res.data.id);
    return `sellerId=${cleanupState.sellerId}`;
  });

  await runStep('Update seller active/password', async () => {
    ensure(cleanupState.sellerId, 'sellerId ausente');

    await httpRequest(BACKEND_BASE, `/sellers/${cleanupState.sellerId}`, {
      method: 'PATCH',
      token: adminToken,
      json: { active: true },
      expected: [200],
    });

    await httpRequest(BACKEND_BASE, `/sellers/${cleanupState.sellerId}/change-password`, {
      method: 'POST',
      token: adminToken,
      json: { newPassword: qaSellerPass },
      expected: [200],
    });

    return 'ok';
  });

  await runStep('Seller login', async () => {
    const res = await httpRequest(BACKEND_BASE, '/auth/login', {
      method: 'POST',
      json: { username: qaSellerName, password: qaSellerPass },
      expected: [200],
    });

    ensure(res.data && res.data.accessToken, 'seller login sem token');
    sellerToken = res.data.accessToken;
    return qaSellerName;
  });

  await runStep('Seller forbidden admin routes', async () => {
    ensure(sellerToken, 'seller token ausente');

    await httpRequest(BACKEND_BASE, '/users', { token: sellerToken, expected: [403] });
    await httpRequest(BACKEND_BASE, '/admin/account', { token: sellerToken, expected: [403] });
    return '403 ok';
  });

  ({ ticketId, messageId } = insertQaTicket(cleanupState.dbPath));

  await runStep('Tickets list', async () => {
    const res = await httpRequest(BACKEND_BASE, '/tickets', { token: adminToken, expected: [200] });
    ensure(Array.isArray(res.data), 'tickets nao retornou array');
    return `count=${res.data.length}`;
  });

  await runStep('Ticket by id', async () => {
    const res = await httpRequest(BACKEND_BASE, `/tickets/${ticketId}`, { token: adminToken, expected: [200] });
    ensure(res.data && Number(res.data.id) === Number(ticketId), 'ticket incorreto');
    return `id=${ticketId}`;
  });

  await runStep('Ticket messages endpoints', async () => {
    await httpRequest(BACKEND_BASE, `/messages/${messageId}`, { token: adminToken, expected: [200] });
    await httpRequest(BACKEND_BASE, `/tickets/${ticketId}/messages`, { token: adminToken, expected: [200] });

    const sinceTs = new Date(Date.now() - 120000).toISOString().slice(0, 19).replace('T', ' ');
    await httpRequest(BACKEND_BASE, `/tickets/${ticketId}/messages/since/${encodeURIComponent(sinceTs)}?lastId=0`, {
      token: adminToken,
      expected: [200],
    });

    return 'ok';
  });

  await runStep('Contact ticket endpoints', async () => {
    await httpRequest(BACKEND_BASE, `/contacts/${qaPhone}/active-ticket`, { token: adminToken, expected: [200] });
    await httpRequest(BACKEND_BASE, `/contacts/${qaPhone}/tickets`, { token: adminToken, expected: [200] });
    return qaPhone;
  });

  await runStep('Create/update reminders', async () => {
    await httpRequest(BACKEND_BASE, `/tickets/${ticketId}/assign`, {
      method: 'POST',
      token: adminToken,
      json: { sellerId: cleanupState.sellerId },
      expected: [200],
    });

    const scheduledAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

    const create = await httpRequest(BACKEND_BASE, `/tickets/${ticketId}/reminders`, {
      method: 'POST',
      token: adminToken,
      json: {
        scheduled_at: scheduledAt,
        note: 'Reminder QA',
        message: 'Mensagem lembrete QA',
      },
      expected: [201],
    });

    ensure(create.data && create.data.id, 'reminder sem id');
    reminderId = Number(create.data.id);
    cleanupState.reminderId = reminderId;

    await httpRequest(BACKEND_BASE, `/tickets/${ticketId}/reminders`, { token: adminToken, expected: [200] });
    await httpRequest(BACKEND_BASE, `/reminders/${reminderId}`, {
      method: 'PATCH',
      token: adminToken,
      json: { note: 'Reminder QA updated', status: 'done' },
      expected: [200],
    });

    await httpRequest(BACKEND_BASE, '/reminders/upcoming', { token: adminToken, expected: [200] });
    await httpRequest(BACKEND_BASE, '/reminders/pending', { token: adminToken, expected: [200] });
    await httpRequest(BACKEND_BASE, '/reminders/due', { token: adminToken, expected: [200] });

    return `reminderId=${reminderId}`;
  });

  await runStep('Ticket assign/status', async () => {
    await httpRequest(BACKEND_BASE, `/tickets/${ticketId}/assign`, {
      method: 'POST',
      token: adminToken,
      json: { sellerId: cleanupState.sellerId },
      expected: [200],
    });

    await httpRequest(BACKEND_BASE, `/tickets/${ticketId}/status`, {
      method: 'PATCH',
      token: adminToken,
      json: { status: 'em_atendimento' },
      expected: [200],
    });

    await httpRequest(BACKEND_BASE, `/tickets/seller/${cleanupState.sellerId}?includeClosed=1`, {
      token: adminToken,
      expected: [200],
    });

    await httpRequest(BACKEND_BASE, '/admin/tickets?includeAll=1', {
      token: adminToken,
      expected: [200],
    });

    return 'ok';
  });

  await runStep('Safe validation for send endpoints', async () => {
    await httpRequest(BACKEND_BASE, `/tickets/${ticketId}/send`, {
      method: 'POST',
      token: adminToken,
      json: {},
      expected: [400],
    });

    await httpRequest(BACKEND_BASE, `/tickets/${ticketId}/send-audio`, {
      method: 'POST',
      token: adminToken,
      expected: [400],
    });

    return '400 validation ok';
  });

  await runStep('Blacklist CRUD', async () => {
    await httpRequest(BACKEND_BASE, '/blacklist', { token: adminToken, expected: [200] });

    const add = await httpRequest(BACKEND_BASE, '/blacklist', {
      method: 'POST',
      token: adminToken,
      json: {
        phone: qaBlacklistPhone,
        reason: 'QA blacklist test',
      },
      expected: [201],
    });
    cleanupState.blacklistPhones.add(qaBlacklistPhone);
    ensure(add.data && add.data.phone === qaBlacklistPhone, 'blacklist add retorno invalido');

    await httpRequest(BACKEND_BASE, '/blacklist/by-lid', {
      method: 'POST',
      token: adminToken,
      json: {
        lid: `${qaBlacklistPhone}@lid`,
        reason: 'QA blacklist lid test',
      },
      expected: [400],
    });

    await httpRequest(BACKEND_BASE, `/blacklist/${qaBlacklistPhone}`, {
      method: 'DELETE',
      token: adminToken,
      expected: [200],
    });
    cleanupState.blacklistPhones.delete(qaBlacklistPhone);

    return qaBlacklistPhone;
  });

  await runStep('Contacts endpoints', async () => {
    await httpRequest(BACKEND_BASE, `/profile-picture/${qaPhone}`, { expected: [200] });
    await httpRequest(BACKEND_BASE, `/contact-name/${qaPhone}`, { expected: [200] });
    return 'ok';
  });

  await runStep('SSE events auth stream', async () => {
    return testSseEvents(adminToken);
  });

  await runStep('Frontend browser blocked (login)', async () => {
    await httpRequest(FRONTEND_BASE, '/login', { expected: [403] });
    return '403 ok';
  });

  await runStep('Frontend electron header allows pages', async () => {
    const pages = ['/login', '/agent', '/admin-sellers', '/setup-admin', '/whatsapp-qr'];
    for (const page of pages) {
      await httpRequest(FRONTEND_BASE, page, {
        expected: [200],
        headers: { [FRONTEND_RUNTIME_HEADER]: FRONTEND_RUNTIME_VALUE },
      });
    }
    return `pages=${pages.length}`;
  });

  await runStep('Frontend proxy to backend', async () => {
    const res = await httpRequest(FRONTEND_BASE, '/__api/healthz', {
      expected: [200],
      headers: {
        [FRONTEND_RUNTIME_HEADER]: FRONTEND_RUNTIME_VALUE,
        'x-api-base': BACKEND_BASE,
      },
    });
    ensure(res.data && res.data.ok === true, 'proxy /__api nao retornou health ok');
    return 'ok';
  });

  await runStep('Auth logout', async () => {
    await httpRequest(BACKEND_BASE, '/auth/logout', {
      method: 'POST',
      token: adminToken,
      expected: [200],
    });
    return 'ok';
  });

  cleanupDbArtifacts();

  console.log('');
  console.log('======== SMOKE SUMMARY ========');
  console.log(`PASS: ${passes.length}`);
  console.log(`FAIL: ${failures.length}`);

  if (failures.length > 0) {
    console.log('--- FAILURES ---');
    for (const f of failures) {
      console.log(`- ${f.name}: ${f.error}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log('Smoke test concluido sem falhas criticas.');
}

main()
  .catch((error) => {
    logFail('Smoke runner', error);
    try { cleanupDbArtifacts(); } catch (_) {}
    console.log('');
    console.log('======== SMOKE SUMMARY ========');
    console.log(`PASS: ${passes.length}`);
    console.log(`FAIL: ${failures.length}`);
    process.exitCode = 1;
  });
