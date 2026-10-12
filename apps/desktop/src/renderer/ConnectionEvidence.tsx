import type { AgentSession, ClientInfo } from '../../../../packages/contracts';

export const isDemoSession = (session: AgentSession) => session.source === 'demo' || session.key === 'codex:local-demo' || session.key === 'demo-session';

export function ConnectionEvidence({ sessions }: { sessions: AgentSession[] }) {
  const latest = (source: 'local-hook' | 'demo') => sessions.filter(session => source === 'demo' ? isDemoSession(session) : session.source === 'local-hook' && !isDemoSession(session)).sort((a, b) => b.updatedAt - a.updatedAt)[0];
  const hook = latest('local-hook');
  const demo = latest('demo');
  return <div className="connection-evidence" aria-label="Lifecycle event evidence">
    <strong>{hook ? 'Local hook event received' : 'Waiting for a local hook event'}</strong>
    <p>{hook ? <>{hook.lastEventKind || hook.state} · <time dateTime={new Date(hook.updatedAt).toISOString()}>{new Date(hook.updatedAt).toLocaleTimeString()}</time>{hook.adapterVersion ? ` · adapter ${hook.adapterVersion}` : ''}</> : 'Start a normal turn in your existing client after reviewing its hook trust settings.'}</p>
    <p className="demo-evidence">{demo ? `Synthetic demo: ${demo.lastEventKind || demo.state} received. This does not verify your coding client.` : 'Synthetic demo: not run for this provider.'}</p>
    <small>Hook receipt confirms local transport, not certification of a client or version.</small>
  </div>;
}

export function ClientCheck({ name, client, disabled, preview, onCheck, onChoose }: { name: string; client?: ClientInfo; disabled: boolean; preview: boolean; onCheck: () => void; onChoose: () => void }) {
  return <div className="client-check">
    <strong>{client?.status === 'found' ? 'Client version reported' : client?.status === 'missing' ? 'Client executable not found' : client?.status === 'limited' ? 'Client check limited' : 'Client version not checked'}</strong>
    <p>{client?.version ? `${client.version} · ` : ''}{client?.note || 'Checking is optional. It runs a bounded local version command only when you choose.'}</p>
    <div className="client-check-actions"><button disabled={disabled || preview} aria-label={`Check ${name} version`} onClick={onCheck}>Check client version</button><button disabled={disabled || preview} aria-label={`Choose ${name} executable`} onClick={onChoose}>Choose executable…</button></div>
    {client?.executable && <details><summary>Checked executable</summary><code>{client.executable}</code></details>}
  </div>;
}
