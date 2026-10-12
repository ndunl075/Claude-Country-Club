import { DEFAULT_SETTINGS, type CountryClubAPI, type HostState, type IntegrationPreview, type SavedRound } from '../../../../packages/contracts';

/** This fallback never touches agent configuration. It exists for browser previews. */
export function createPreviewAPI(): CountryClubAPI {
  const listeners = new Set<(state: HostState) => void>();
  const freezes = new Set<() => void | Promise<void>>();
  let saved: SavedRound | null = null;
  try { saved = JSON.parse(localStorage.getItem('ccc-preview-round') || 'null'); } catch { /* Empty or unavailable local storage. */ }
  let state: HostState = {
    settings: { ...DEFAULT_SETTINGS }, sessions: [], selectedSession: null,
    integrations: ['claude', 'codex'].map(provider => ({ provider: provider as 'claude' | 'codex', status: 'not-connected', configPath: 'Browser preview — no configuration files', exists: false, note: 'Local demonstration only. The desktop app connects your agents.' })),
    practice: false, suspended: true, brokerReady: false, diagnostics: [], version: '0.1.0-preview', platform: 'browser',
  };
  const publish = () => { const copy = structuredClone(state); listeners.forEach(listener => listener(copy)); return copy; };
  return {
    getState: async () => structuredClone(state),
    setSettings: async patch => { state.settings = { ...state.settings, ...patch }; return publish(); },
    loadRound: async () => saved && structuredClone(saved),
    saveRound: async (value, revision) => {
      if (saved && revision <= saved.revision) throw new Error('This save is older than the stored round.');
      const next = { state: structuredClone(value), revision };
      localStorage.setItem('ccc-preview-round', JSON.stringify(next)); saved = next; return { revision };
    },
    practice: async () => { state.practice = true; state.suspended = false; publish(); },
    hide: async () => { state.suspended = true; publish(); await Promise.all([...freezes].map(fn => fn())); },
    selectSession: async key => { state.selectedSession = key; state.settings.selectedSession = key; state.practice = false; state.suspended = state.sessions.find(s => s.key === key)?.state !== 'working'; publish(); },
    previewIntegration: async provider => ({ provider, configPath: 'Browser preview — no real files', beforeHash: 'preview', before: '{\n  "hooks": {}\n}', after: '{\n  "hooks": {\n    "country-club": "LOCAL PREVIEW ONLY"\n  }\n}', note: 'This preview updates only this browser demo. Install the desktop app for agent hooks.' }),
    applyIntegration: async (preview: IntegrationPreview) => { state.integrations = state.integrations.map(item => item.provider === preview.provider ? { ...item, status: 'installed', note: 'Connected in the local demonstration only.' } : item); return publish(); },
    removeIntegration: async provider => { state.integrations = state.integrations.map(item => item.provider === provider ? { ...item, status: 'not-connected' } : item); return publish(); },
    inspectClient: async provider => { state.integrations = state.integrations.map(item => item.provider === provider ? { ...item, client: { status: 'not-checked', note: 'Client version inspection is available only in the desktop app.' } } : item); return publish(); },
    simulate: async kind => {
      state.practice = false; state.selectedSession = 'demo-session';
      state.sessions = [{ key: 'demo-session', provider: 'claude', state: kind === 'start' ? 'working' : kind === 'attention' ? 'attention' : 'stopped', generation: 1, updatedAt: Date.now(), reliable: true, source: 'demo', lastEventKind: kind, adapterVersion: 'synthetic' }];
      state.suspended = kind !== 'start'; publish();
      if (kind !== 'start') await Promise.all([...freezes].map(fn => fn()));
    },
    exportProgress: async () => false, importProgress: async () => false,
    previewDiagnostics: async () => { throw new Error('Diagnostic export is available only in the desktop app.'); },
    exportDiagnostics: async () => { throw new Error('Diagnostic export is available only in the desktop app.'); },
    openDocumentation: async () => undefined,
    checkForUpdates: async () => undefined,
    onState: callback => { listeners.add(callback); return () => { listeners.delete(callback); }; },
    onFreeze: callback => { freezes.add(callback); return () => { freezes.delete(callback); }; },
  };
}
