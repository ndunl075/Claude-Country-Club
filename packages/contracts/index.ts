export type Provider = 'claude' | 'codex';
export type EventKind = 'start' | 'activity' | 'attention' | 'stop' | 'interrupted' | 'failed' | 'session-ended';
export interface AgentEvent {
  protocolVersion: 1; eventId: string; provider: Provider; adapterVersion: string;
  sessionKey: string; turnId?: string; rootSessionKey?: string; kind: EventKind;
}
export type SessionState = 'working' | 'attention' | 'stopped' | 'interrupted' | 'failed' | 'closed' | 'unknown';
export interface AgentSession { key: string; provider: Provider; state: SessionState; turnId?: string; generation: number; updatedAt: number; reliable: boolean; source?: 'demo' | 'local-hook'; lastEventKind?: EventKind; adapterVersion?: string; }
export interface Settings {
  automatic: boolean; delayMs: number; sound: boolean; reducedMotion: boolean;
  highContrast: boolean; startAtLogin: boolean; selectedSession: string | null;
}
export interface ClientInfo { status: 'not-checked' | 'found' | 'missing' | 'limited'; executable?: string; version?: string; note: string; }
export interface IntegrationInfo { provider: Provider; status: 'not-connected' | 'installed' | 'trust-required' | 'limited'; configPath: string; exists: boolean; note: string; client?: ClientInfo; }
// before/after contain only reviewed app-owned hook groups, not full config.
// beforeHash binds the complete source file for main-process revalidation.
export interface IntegrationPreview { provider: Provider; configPath: string; beforeHash: string; before: string; after: string; note: string; }
export interface Diagnostic { time: string; code: string; message: string; }
export interface HostState {
  settings: Settings; sessions: AgentSession[]; integrations: IntegrationInfo[];
  selectedSession: string | null; practice: boolean; suspended: boolean;
  brokerReady: boolean; diagnostics: Diagnostic[]; version: string; platform: string;
}
export interface SavedRound { revision: number; state: unknown; }
export interface DiagnosticsPreview { id: string; content: string; }
export interface CountryClubAPI {
  getState(): Promise<HostState>;
  setSettings(patch: Partial<Settings>): Promise<HostState>;
  loadRound(): Promise<SavedRound | null>;
  saveRound(state: unknown, revision: number): Promise<{ revision: number }>;
  practice(): Promise<void>;
  hide(): Promise<void>;
  selectSession(key: string | null): Promise<void>;
  previewIntegration(provider: Provider): Promise<IntegrationPreview>;
  applyIntegration(preview: IntegrationPreview): Promise<HostState>;
  removeIntegration(provider: Provider): Promise<HostState>;
  inspectClient(provider: Provider, choose?: boolean): Promise<HostState>;
  simulate(kind: 'start' | 'attention' | 'stop'): Promise<void>;
  exportProgress(): Promise<boolean>;
  previewDiagnostics(): Promise<DiagnosticsPreview>;
  exportDiagnostics(id: string): Promise<boolean>;
  importProgress(): Promise<boolean>;
  openDocumentation(): Promise<void>;
  checkForUpdates(): Promise<void>;
  onState(callback: (state: HostState) => void): () => void;
  onFreeze(callback: () => void | Promise<void>): () => void;
}
declare global { interface Window { countryClub: CountryClubAPI; } }
export const DEFAULT_SETTINGS: Settings = { automatic: false, delayMs: 2000, sound: false, reducedMotion: false, highContrast: false, startAtLogin: false, selectedSession: null };
export function validateEvent(value: unknown): AgentEvent {
  if (!value || typeof value !== 'object') throw new Error('Invalid event');
  const e = value as Record<string, unknown>;
  const bounded = (v: unknown) => typeof v === 'string' && /^[a-zA-Z0-9_.:-]{1,128}$/.test(v);
  if (e.protocolVersion !== 1 || !['claude', 'codex'].includes(String(e.provider)) || !bounded(e.eventId) || !bounded(e.sessionKey) || !bounded(e.adapterVersion) || !['start','activity','attention','stop','interrupted','failed','session-ended'].includes(String(e.kind)) || (e.turnId !== undefined && !bounded(e.turnId)) || (e.rootSessionKey !== undefined && !bounded(e.rootSessionKey))) throw new Error('Invalid event schema');
  return { protocolVersion: 1, eventId: e.eventId as string, sessionKey: e.sessionKey as string, provider: e.provider as Provider, adapterVersion: e.adapterVersion as string, kind: e.kind as EventKind, ...(e.turnId ? { turnId: e.turnId as string } : {}), ...(e.rootSessionKey ? { rootSessionKey: e.rootSessionKey as string } : {}) };
}
