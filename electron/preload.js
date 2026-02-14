const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('__ELECTRON_APP__', true);
