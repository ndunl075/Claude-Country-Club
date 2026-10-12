import { contextBridge, ipcRenderer } from 'electron';
import type { CountryClubAPI } from '../../../../packages/contracts';
const invoke = (name: string, ...args: unknown[]) => ipcRenderer.invoke(`ccc:${name}`, ...args);
const api: CountryClubAPI = {
  previewDiagnostics: () => invoke('diagnostics-preview'), exportDiagnostics: id => invoke('diagnostics-export',id),
  getState: () => invoke('state'), setSettings: patch => invoke('settings', patch),
  loadRound: () => invoke('load'), saveRound: (state, revision) => invoke('save',state,revision),
  practice: () => invoke('practice'), hide: () => invoke('hide'), selectSession: key => invoke('select',key),
  previewIntegration: provider => invoke('preview',provider), applyIntegration: preview => invoke('apply',preview),
  removeIntegration: provider => invoke('remove',provider), simulate: kind => invoke('simulate',kind),
  inspectClient: (provider,choose) => invoke('inspect-client',provider,choose),
  exportProgress: () => invoke('export'), importProgress: () => invoke('import'), openDocumentation: () => invoke('docs'),
  checkForUpdates: () => invoke('updates'),
  onState: callback => { const listener = (_event: unknown, value: Parameters<typeof callback>[0]) => callback(value); ipcRenderer.on('ccc:state',listener); return () => ipcRenderer.removeListener('ccc:state',listener); },
  onFreeze: callback => { const listener = async (_event: unknown, id: string) => { try { await callback(); } finally { ipcRenderer.send('ccc:frozen',id); } }; ipcRenderer.on('ccc:freeze',listener); return () => ipcRenderer.removeListener('ccc:freeze',listener); }
};
contextBridge.exposeInMainWorld('countryClub',api);
