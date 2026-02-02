'use strict';

// Camada de adaptação para o módulo legado `backend/baileys.js`.
// Objetivo: centralizar o acesso ao WhatsApp em um único ponto para facilitar
// futuras refatorações (ex.: mover `baileys.js` para `src/`, trocar implementação, etc.).

const baileys = require('./baileysClient');

const startBot = typeof baileys === 'function' ? baileys : baileys?.startBot;

module.exports = {
  // API normalizada
  startBot,
  getSocket: baileys.getSocket,
  getQrState: baileys.getQrState,
  forceNewQr: baileys.forceNewQr,

  // API legada (para injeção onde o shape atual é esperado)
  raw: baileys,
};
