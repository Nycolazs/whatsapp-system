const { EventEmitter } = require('events');

const emitter = new EventEmitter();

let activeAccount = null;

function getActiveAccount() {
  return activeAccount;
}

function setActiveAccount(account) {
  const next = account || null;
  if (next === activeAccount) return;
  activeAccount = next;
  emitter.emit('changed', activeAccount);
}

module.exports = {
  emitter,
  getActiveAccount,
  setActiveAccount,
};
