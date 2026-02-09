'use strict';

const { EventEmitter } = require('events');

const events = new EventEmitter();
// Permite múltiplos listeners (várias abas/logins)
events.setMaxListeners(0);

module.exports = events;
