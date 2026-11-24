'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const call = async (ch, ...args) => {
  const r = await ipcRenderer.invoke(ch, ...args);
  if (!r.ok) throw new Error(r.error);
  return r.value;
};
const on = (ch) => (fn) => { const h = (_e, ...a) => fn(...a); ipcRenderer.on(ch, h); return () => ipcRenderer.removeListener(ch, h); };

const CHANNELS = [
  'app:state', 'settings:set', 'layout:set',
  'conn:save', 'conn:remove', 'conn:test', 'conn:connect', 'conn:disconnect', 'conn:detect', 'conn:parseUrl', 'conn:pickFile',
  'meta:databases', 'meta:schemas', 'meta:objects', 'meta:columns', 'meta:table', 'meta:info',
  'data:table', 'data:count', 'data:distinct', 'data:query', 'data:explain', 'data:cancel', 'data:endSession', 'cache:clear', 'cache:stats',
  'history:list', 'history:clear', 'scripts:save', 'scripts:tabs', 'scripts:delete',
  'dump:tools', 'dump:pickOut', 'dump:run', 'dump:cancel',
  'mcp:state', 'mcp:set', 'mcp:activity', 'file:save', 'shell:reveal', 'shell:open', 'clipboard:write',
];
const api = {};
for (const ch of CHANNELS) {
  const [ns, fn] = ch.split(':');
  (api[ns] ||= {})[fn] = (...a) => call(ch, ...a);
}
api.on = {
  menu: on('menu'), connState: on('conn:state'), history: on('history:add'), dumpProgress: on('dump:progress'),
  mcpActivity: on('mcp:activity'), mcpError: on('mcp:error'),
};
contextBridge.exposeInMainWorld('pelican', api);
