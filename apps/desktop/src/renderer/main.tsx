import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import type { CountryClubAPI, DiagnosticsPreview, IntegrationInfo, IntegrationPreview, Provider, Settings } from '../../../../packages/contracts';
import { isMoving, totalScore } from '../../../../packages/game';
import type { Hole } from '../../../../packages/game/types';
import { CourseCanvas } from './CourseCanvas';
import { ClientCheck, ConnectionEvidence, isDemoSession } from './ConnectionEvidence';
import { createPreviewAPI } from './preview';
import { canPlay, useClubRound } from './useClubRound';
import './styles.css';

const previewMode = !window.countryClub;
const api: CountryClubAPI = window.countryClub || createPreviewAPI();
const providerName = (provider: Provider) => provider === 'claude' ? 'Claude Code' : 'Codex CLI';
const humanError = (error: unknown) => error instanceof Error ? error.message : String(error);
type Tab = 'play' | 'connections' | 'settings';
type Modal = { kind: 'diagnostics'; preview: DiagnosticsPreview } | { kind: 'connect'; preview: IntegrationPreview } | { kind: 'remove'; integration: IntegrationInfo } | { kind: 'reset' | 'import' } | null;

function Icon({ name, size = 20 }: { name: string; size?: number }) {
  const paths: Record<string, ReactNode> = {
    flag: <><path d="M5 21V3m0 1c5-4 8 5 14 1v9c-6 4-9-5-14-1" /></>,
    link: <><path d="m10 13 4-4m-5 7-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m0 10a4 4 0 0 0 6 0l4-4a4 4 0 0 0-6-6l-1 1" /></>,
    settings: <><path d="M4 7h16M4 17h16" /><circle cx="9" cy="7" r="3" /><circle cx="16" cy="17" r="3" /></>,
    arrow: <path d="M5 12h14m-5-5 5 5-5 5" />,
    chevron: <path d="m9 5 7 7-7 7" />,
    leaf: <><path d="M4 20C3 8 10 3 21 3c0 12-6 17-13 14M4 20 16 8" /></>,
    moon: <path d="M20 15A9 9 0 0 1 9 4a9 9 0 1 0 11 11Z" />,
    wave: <><path d="M2 8c4-5 6 5 10 0s6 5 10 0M2 15c4-5 6 5 10 0s6 5 10 0" /></>,
    check: <path d="m5 12 4 4L20 5" />,
    close: <path d="m6 6 12 12M6 18 18 6" />,
    pause: <><path d="M8 5v14M16 5v14" /></>,
    sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l2 2m10 10 2 2M5 19l2-2M17 7l2-2" /></>,
    shield: <><path d="m12 2 9 4v6c0 5-9 10-9 10S3 17 3 12V6l9-4Z" /><path d="m7 12 3 3 6-6" /></>,
    refresh: <><path d="M20 7v5h-5M4 17v-5h5" /><path d="M19 9A8 8 0 0 0 5 6M5 15a8 8 0 0 0 14 3" /></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name] || paths.flag}</svg>;
}

function Dialog({ title, children, onClose, busy }: { title: string; children: ReactNode; onClose: () => void; busy: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const dialog = ref.current; dialog?.showModal(); return () => dialog?.close(); }, []);
  return <dialog ref={ref} className="dialog" aria-labelledby="dialog-title" onCancel={event => { event.preventDefault(); if (!busy) onClose(); }} onClick={event => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <div className="dialog-head"><div><span className="eyebrow">CLUBHOUSE DESK</span><h2 id="dialog-title">{title}</h2></div><button className="icon-button" aria-label="Close dialog" disabled={busy} onClick={onClose}><Icon name="close" /></button></div>
    {children}
  </dialog>;
}

function SettingToggle({ label, description, value, onChange, disabled }: { label: string; description: string; value: boolean; onChange: () => void; disabled?: boolean }) {
  return <div className="setting-row"><div><strong>{label}</strong><p>{description}</p></div><button role="switch" aria-label={label} aria-checked={value} className={`toggle ${value ? 'on' : ''}`} onClick={onChange} disabled={disabled}><span /></button></div>;
}

const themes: { id: Hole['theme']; title: string; subtitle: string; icon: string }[] = [
  { id: 'garden', title: 'The Gardens', subtitle: 'Hedges, hush & a little finesse', icon: 'leaf' },
  { id: 'coast', title: 'The Coast', subtitle: 'Salt air & sandy shortcuts', icon: 'wave' },
  { id: 'night', title: 'After Hours', subtitle: 'One more under the lights', icon: 'moon' },
];

function App() {
  const club = useClubRound(api);
  const { host, round } = club;
  const [tab, setTab] = useState<Tab>('play');
  const [angle, setAngle] = useState(315);
  const [power, setPower] = useState(45);
  const [modal, setModal] = useState<Modal>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [actionError, setActionError] = useState('');
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const hole = round.holes[round.holeIndex];
  const moving = isMoving(round);
  const allowed = club.ready && canPlay(host) && !club.frozen && !club.pending;
  const selected = host?.sessions.find(session => session.key === host.selectedSession);
  const playingStatus = host?.practice ? 'Local practice' : selected && isDemoSession(selected) ? `Synthetic demo · ${selected.state}` : selected?.state === 'working' ? 'Agent at work' : selected?.state === 'attention' ? 'Your agent needs you' : selected?.state === 'stopped' ? 'Agent stopped' : 'The clubhouse is open';
  const parPlayed = round.scores.reduce((sum, _score, index) => sum + round.holes[index].par, 0);
  const score = totalScore(round);
  const completedScore = round.scores.reduce((sum, value) => sum + value, 0);
  const scoreDelta = completedScore - parPlayed;

  useEffect(() => {
    const dx = hole.cup.x - round.ball.x; const dy = hole.cup.y - round.ball.y;
    setAngle((Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360);
  }, [round.id, round.holeIndex]);

  const action = async (fn: () => Promise<unknown>, success?: string) => {
    setActionError(''); setNotice(''); setActionBusy(true);
    try { await fn(); if (success) setNotice(success); } catch (error) { setActionError(humanError(error)); }
    finally { setActionBusy(false); }
  };
  const setting = (patch: Partial<Settings>) => action(() => api.setSettings(patch));
  const preview = (provider: Provider) => action(async () => setModal({ kind: 'connect', preview: await api.previewIntegration(provider) }));
  const takeShot = (impulse: { x: number; y: number }) => {
    if (!allowed || moving || round.status !== 'playing') return;
    club.takeShot(impulse);
    if (host?.settings.sound) {
      const audio = new AudioContext(); const tone = audio.createOscillator(); const gain = audio.createGain();
      tone.type = 'sine'; tone.frequency.setValueAtTime(310, audio.currentTime); tone.frequency.exponentialRampToValueAtTime(130, audio.currentTime + 0.07);
      gain.gain.setValueAtTime(0.035, audio.currentTime); gain.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + 0.09);
      tone.connect(gain); gain.connect(audio.destination); tone.start(); tone.stop(audio.currentTime + 0.1); tone.onended = () => { void audio.close(); };
    }
  };
  const roundSummary = round.status === 'complete';
  const companion = !!host && !host.practice && selected?.state === 'working' && !host.suspended;
  useEffect(() => {
    document.body.classList.toggle('companion-window', companion);
    if (companion) setTab('play');
    return () => { document.body.classList.remove('companion-window'); };
  }, [companion]);

  return <div className={`app ${companion && tab === 'play' ? 'companion' : ''} ${tab === 'play' ? 'course-only' : ''} ${host?.settings.highContrast ? 'high-contrast' : ''} ${host?.settings.reducedMotion ? 'reduced-motion' : ''}`} onKeyDown={event => {
    if (event.key === 'Escape' && !event.defaultPrevented && !modal && tab === 'play') { event.preventDefault(); if (!event.repeat) void action(() => api.hide()); }
  }}>
    <header className="masthead">
      <nav aria-label="Main navigation">{([{ id: 'play', icon: 'flag', label: 'Play' }, { id: 'connections', icon: 'link', label: 'Connections' }, { id: 'settings', icon: 'settings', label: 'Settings' }] as const).filter(item => tab !== 'play' || item.id !== 'play').map(item => <button key={item.id} className={`nav-button ${tab === item.id ? 'active' : ''}`} aria-label={item.label} title={item.label} aria-current={tab === item.id ? 'page' : undefined} onClick={() => setTab(item.id)}><Icon name={item.icon} size={17} /><span>{item.label}</span></button>)}</nav>
      <button className="quiet-button hide-button" onClick={() => void action(() => api.hide())} title="Save, pause, and hide to tray" aria-label={companion ? 'Pause and hide to tray' : 'Hide to tray'}><Icon name="pause" size={20} /></button>
    </header>

    {previewMode && <div className="preview-banner"><span className="status-dot" /> Browser preview · local demo only · no agent configuration is changed</div>}
    <main>
      {tab !== 'play' && <div className="page-heading"><h1>{tab === 'connections' ? 'Connections' : 'Settings'}</h1><div className={`session-pill ${host?.practice || selected?.state === 'working' ? 'working' : ''}`} role="status"><span className="status-dot" />{playingStatus}</div></div>}

      {(club.error || actionError || notice) && <div className={`message ${club.error || actionError ? 'error' : ''}`} role={club.error || actionError ? 'alert' : 'status'}><span>{club.error || actionError || notice}</span>{club.error ? club.restoreFailed ? <button onClick={() => setModal({ kind: 'reset' })}>New round</button> : <button disabled={club.pending} onClick={() => void club.retrySave()}>Retry save</button> : <button aria-label="Dismiss message" onClick={() => { setNotice(''); setActionError(''); }}><Icon name="close" size={16} /></button>}</div>}

      {tab === 'play' && <div className="play-layout">
        <section className="game-card" aria-label="Mini golf game">
          <div className="game-heading"><div className="hole-number" aria-label={`Hole ${round.holeIndex + 1} of 9`}>{String(round.holeIndex + 1).padStart(2, '0')}</div><div className="hole-title"><span className="eyebrow">{selected && !host?.practice && isDemoSession(selected) ? 'Synthetic demo' : themes.find(theme => theme.id === hole.theme)?.title} <span className="dot-separator">·</span> PAR {hole.par}</span><h2>{hole.name}</h2></div><div className="stroke-count" aria-live="polite" aria-atomic="true"><span>STROKE</span><strong>{round.strokes}</strong></div></div>
          <div className={`course-frame ${hole.theme}`}>
            <CourseCanvas round={round} enabled={allowed} angle={angle} power={power} setAngle={setAngle} setPower={setPower} onShot={takeShot} reducedMotion={host?.settings.reducedMotion || false} highContrast={host?.settings.highContrast || false} />
          </div>
          <div className="course-actions">
            <div className="course-quick-action" role="status">
              {!club.ready ? <span>Restoring round…</span> : (round.status === 'holed' || roundSummary) ? <><span>{roundSummary ? `${completedScore} strokes · ${scoreDelta === 0 ? 'even par' : `${Math.abs(scoreDelta)} ${scoreDelta < 0 ? 'under' : 'over'} par`}` : round.strokes === 1 ? 'Hole in one!' : 'Hole complete'}</span><button disabled={club.pending || (!allowed && !roundSummary)} onClick={() => roundSummary ? setModal({ kind: 'reset' }) : void club.advance()}>{roundSummary ? 'Another round' : round.holeIndex === 8 ? 'Finish round' : 'Next hole'}<Icon name="arrow" size={13} /></button>{!allowed && !roundSummary && <button disabled={actionBusy} onClick={() => void action(() => api.practice())}>Continue in local practice</button>}</> : (!canPlay(host) || club.frozen) && !club.error ? <button disabled={actionBusy} onClick={() => void action(() => api.practice())}>Play local practice<Icon name="arrow" size={13} /></button> : club.pending ? <span>Saving…</span> : null}
            </div>
            <div className="gesture-hint"><span id="aim-instructions">Drag back from the ball. Release to putt.</span><span id="aim-state" className="visually-hidden">Aim {Math.round(angle) % 360} degrees, power {Math.round(power)} percent. Focus the course; left and right arrows aim, up and down arrows change power, Space putts. Escape cancels a drag, or saves and hides when no drag is active.</span><details className="keyboard-help"><summary aria-label="Keyboard controls" title="Keyboard controls">?</summary><p>Focus the course. <kbd>←</kbd> <kbd>→</kbd> aim, <kbd>↑</kbd> <kbd>↓</kbd> change power, and <kbd>Space</kbd> putts. <kbd>Esc</kbd> cancels a drag; press again to save and hide.</p></details></div>
          </div>
        </section>
      </div>}

      {tab === 'connections' && <div className="connections-layout">
        <section className="subscription-note"><Icon name="shield" size={23} /><div><strong>Keep your existing client and sign-in.</strong><p>Country Club observes local lifecycle hooks. It needs no account, API key, token, or subscription credentials and runs no model inference. Your agent’s normal plan, billing, and usage limits still apply.</p><p>Local Claude Code and Codex CLI hooks are integration candidates. Installed client versions and desktop, IDE, browser, cloud, and remote surfaces are not certified by this setup.</p></div><button className="secondary-button" disabled={actionBusy} onClick={() => void action(async () => { await api.practice(); setTab('play'); })}>Practice without connecting</button></section>

        <div className="provider-grid">{(['claude', 'codex'] as const).map(provider => {
          const integration = host?.integrations.find(item => item.provider === provider);
          const connected = integration?.status === 'installed';
          return <section className="provider-card" key={provider}><div className="provider-top"><span className={`provider-logo ${provider}`}>{provider === 'claude' ? '✳' : <svg width="30" height="30" viewBox="0 0 32 32" aria-hidden="true"><path d="m7 9 9-5 9 5v14l-9 5-9-5V9Z" stroke="currentColor" strokeWidth="2" fill="none" /><path d="m7 9 18 14M25 9 7 23M16 4v24" stroke="currentColor" strokeWidth="1.6" /></svg>}</span><span className={`integration-badge ${connected ? 'connected' : ''}`}><span className="status-dot" />{connected ? 'Hooks installed' : integration?.status === 'trust-required' ? 'Trust required' : integration?.status === 'limited' ? 'Limited support' : 'Not connected'}</span></div><h3>{providerName(provider)}</h3><p>{provider === 'claude' ? 'A few good holes between Claude’s next thoughts.' : 'A breath of fresh air while Codex finds its flow.'}</p><div className="integration-note">{integration?.note || 'Checking local integration…'}</div><ClientCheck name={providerName(provider)} client={integration?.client} disabled={!host || actionBusy} preview={previewMode} onCheck={() => void action(() => api.inspectClient(provider))} onChoose={() => void action(() => api.inspectClient(provider, true))} /><ConnectionEvidence sessions={host?.sessions.filter(session => session.provider === provider) || []} /><button className={connected ? 'secondary-button' : 'primary-button'} disabled={!host || actionBusy} onClick={() => connected && integration ? setModal({ kind: 'remove', integration }) : void preview(provider)}>{connected ? 'Review disconnection' : integration?.status === 'trust-required' ? 'Review connection & trust' : 'Review connection'}<Icon name={connected ? 'link' : 'arrow'} size={17} /></button>{integration?.status === 'trust-required' && <button className="quiet-button provider-remove" disabled={actionBusy} onClick={() => setModal({ kind: 'remove', integration })}>Review disconnection</button>}<details><summary>Configuration location</summary><code>{integration?.configPath || 'Loading…'}</code></details></section>;
        })}</div>
        <section className="connection-readiness"><span className="eyebrow">FINISH YOUR LOCAL SETUP</span><h2>Review trust, then try a normal turn.</h2><ol><li>Optionally check the installed client version. Review and confirm hooks for each client you choose.</li><li>Complete the client’s own hook trust review, then start a normal turn yourself. The demo does not send a prompt or verify a provider.</li><li>Look for a local hook event below the provider card, choose its session, and opt in to automatic play when you are ready.</li></ol><SettingToggle label="Open automatically while my agent works" description="Optional and off by default. Only the selected session can open the game; version certification remains separate." value={host?.settings.automatic || false} disabled={!host || actionBusy} onChange={() => void setting({ automatic: !host?.settings.automatic })} /></section>
        <section className="session-card"><div><span className="eyebrow">ONE SESSION, ONE ROUND</span><h2>Choose who you’re waiting on.</h2><p>Only the selected session can open or pause your round.</p></div><div className="session-controls"><label htmlFor="session-picker">Active coding session</label><select id="session-picker" value={host?.selectedSession || ''} disabled={actionBusy || !host} onChange={event => void action(() => api.selectSession(event.target.value || null))}><option value="">Choose a session</option>{host?.sessions.map(session => <option value={session.key} key={session.key}>{isDemoSession(session) ? 'Synthetic demo' : providerName(session.provider)} · {session.key} · {session.state}{session.reliable ? '' : ' · limited'}</option>)}</select>{!host?.sessions.length && <p className="helper-text">Start a new agent turn after connecting to see it here.</p>}</div></section>
        <section className="connection-bottom"><div className="local-note"><Icon name="shield" size={24} /><div><strong>Just a local handshake.</strong><p>No code, prompts, or chat contents are read. Only lifecycle signals.</p></div></div><button className="secondary-button" onClick={() => void action(() => api.openDocumentation())}>Setup & troubleshooting <Icon name="arrow" size={16} /></button></section>
        <section className="demo-card"><div><strong>Try the handoff</strong><p>Synthetic demo events use no inference and do not verify a real client. Use Connections to return here after Demo start.</p></div><div className="demo-actions"><button disabled={actionBusy} onClick={() => void action(async () => { await api.simulate('start'); setTab('play'); }, 'Synthetic demo started. Open Connections to try attention or stop.')}>Demo start</button><button disabled={actionBusy} onClick={() => void action(() => api.simulate('attention'), 'Demo attention sent. The round is paused.')}>Demo attention</button><button disabled={actionBusy} onClick={() => void action(() => api.simulate('stop'), 'Demo stop sent. The round is saved.')}>Demo stop</button></div></section>
      </div>}

      {tab === 'settings' && <div className="settings-layout"><section className="settings-card"><div className="card-heading"><span className="card-icon"><Icon name="leaf" size={22} /></span><div><h2>A quiet companion</h2><p>Let the club fit around your work.</p></div></div><SettingToggle label="Open automatically while my agent works" description="Off by default. Uses your selected agent session only." value={host?.settings.automatic || false} disabled={!host || actionBusy} onChange={() => void setting({ automatic: !host?.settings.automatic })} /><div className="setting-row"><div><strong>A moment before tee-off</strong><p>Skip short waits before the clubhouse appears.</p></div><select aria-label="Automatic opening delay" disabled={!host || actionBusy} value={host?.settings.delayMs ?? 2000} onChange={event => void setting({ delayMs: Number(event.target.value) })}>{[1000, 2000, 5000, 10000, 30000].map(value => <option value={value} key={value}>{value === 1000 ? '1 second' : `${value / 1000} seconds`}</option>)}</select></div><SettingToggle label="Gentle game sounds" description="A soft little tap with each putt. Off by default." value={host?.settings.sound || false} disabled={!host || actionBusy} onChange={() => void setting({ sound: !host?.settings.sound })} /><SettingToggle label="Start at login" description="Keep the clubhouse available in your system tray." value={host?.settings.startAtLogin || false} disabled={!host || actionBusy} onChange={() => void setting({ startAtLogin: !host?.settings.startAtLogin })} /></section><section className="settings-card"><div className="card-heading"><span className="card-icon"><Icon name="sun" size={22} /></span><div><h2>Comfort on the course</h2><p>Small adjustments for your kind of green.</p></div></div><SettingToggle label="Reduce motion" description="Remove decorative transitions. Ball physics stay consistent." value={host?.settings.reducedMotion || false} disabled={!host || actionBusy} onChange={() => void setting({ reducedMotion: !host?.settings.reducedMotion })} /><SettingToggle label="Higher contrast" description="Stronger text, course edges, and focus outlines." value={host?.settings.highContrast || false} disabled={!host || actionBusy} onChange={() => void setting({ highContrast: !host?.settings.highContrast })} /><div className="keyboard-note"><span className="eyebrow">EVERY PUTT, KEYBOARD FRIENDLY</span><p>Drag back from the ball, then release to putt. Pull farther for more speed; the ball travels opposite your pull. For keyboard play, focus the course, then use <kbd>←</kbd> <kbd>→</kbd> to aim, <kbd>↑</kbd> <kbd>↓</kbd> for power, and <kbd>Space</kbd> to putt. Escape cancels a drag first; press again to save and hide.</p></div></section><section className="settings-card progress-settings"><div className="card-heading"><span className="card-icon"><Icon name="flag" size={22} /></span><div><h2>Keep your place</h2><p>Shots save before they roll. Every round stays on this computer.</p></div></div><div className="progress-actions"><button className="secondary-button" disabled={actionBusy || club.pending || !club.ready || club.restoreFailed || previewMode} onClick={() => void action(async () => { const exported = await club.exportRound(); setNotice(exported ? 'Progress exported to your chosen file.' : 'Export canceled. Your round is unchanged.'); })}>Export progress</button><button className="secondary-button" disabled={actionBusy || club.pending || !club.ready || previewMode} onClick={() => setModal({ kind: 'import' })}>Import progress</button><button className="quiet-button" disabled={club.pending || actionBusy || !club.ready} onClick={() => setModal({ kind: 'reset' })}>Start a new round</button></div>{club.restoreFailed && <p className="helper-text" role="status">The existing save cannot be read and has not been replaced. Import a valid backup or confirm a fresh round. Export is available for readable rounds.</p>}{previewMode && <p className="helper-text">File import and export are available in the desktop app.</p>}</section><section className="settings-card round-details"><details><summary>Round scorecard · {score} strokes</summary><div className="scorecard-holes">{round.holes.map((item, index) => <div key={item.id} className={`score-hole ${index === round.holeIndex ? 'current' : ''}`} aria-label={`Hole ${index + 1}, ${item.name}, par ${item.par}, ${round.scores[index] !== undefined ? `${round.scores[index]} strokes` : index === round.holeIndex ? `${round.strokes} strokes, current hole` : 'not played'}`}><span>{index + 1}</span><strong>{round.scores[index] ?? (index === round.holeIndex && round.strokes ? round.strokes : '—')}</strong><small>PAR {item.par}</small></div>)}</div></details></section><section className="settings-card updates-card"><div><h3>Updates on your terms</h3><p>Open the release page in your browser and choose an installer yourself. No background checks or installations.</p></div><button className="secondary-button" disabled={actionBusy || previewMode} onClick={() => void action(() => api.checkForUpdates(), 'Release page opened. Choose an installer to update when you are ready.')}>Check for updates <Icon name="arrow" size={16} /></button></section><section className="settings-card diagnostics-card"><div><h3>Clubhouse details</h3><p>Version {host?.version || '…'} · {host?.platform || 'desktop'} · Local event broker {host?.brokerReady ? 'ready' : previewMode ? 'preview' : 'not ready'}</p></div><div className="diagnostic-actions"><button className="quiet-button" aria-expanded={showDiagnostics} onClick={() => setShowDiagnostics(!showDiagnostics)}>{showDiagnostics ? 'Hide' : 'View'} diagnostics</button><button className="secondary-button" disabled={previewMode || !host || actionBusy} onClick={() => void action(async () => setModal({ kind: 'diagnostics', preview: await api.previewDiagnostics() }))}>{actionBusy ? 'Preparing…' : 'Review diagnostic export'}</button></div>{showDiagnostics && <div className="diagnostic-log">{host?.diagnostics.length ? host.diagnostics.slice(0, 12).map((item, index) => <p key={`${item.time}-${index}`}><code>{item.time} · {item.code}</code><span>{item.message}</span></p>) : <p>No diagnostic events. All quiet at the club.</p>}</div>}</section></div>}


    </main>

    {modal && <Dialog busy={actionBusy || club.pending} onClose={() => setModal(null)} title={modal.kind === 'diagnostics' ? 'Review diagnostic export' : modal.kind === 'connect' ? `A connection with ${providerName(modal.preview.provider)}.` : modal.kind === 'remove' ? `Disconnect ${providerName(modal.integration.provider)}?` : modal.kind === 'import' ? 'Bring your round with you.' : 'A fresh set of fairways?'}>
      {modal.kind === 'diagnostics' && <><p className="dialog-copy">Prepared locally with only version/platform, status summaries, and timestamped error codes. Excludes raw diagnostic messages, paths, session/turn IDs, configuration, tokens, and game state. Nothing is uploaded.</p><pre className="diagnostic-preview" role="region" aria-label="Diagnostic report JSON" tabIndex={0}>{modal.preview.content}</pre><div className="dialog-actions"><button className="secondary-button" disabled={actionBusy} onClick={() => setModal(null)}>Keep private</button><button className="primary-button" disabled={actionBusy} onClick={() => void action(async () => { const saved = await api.exportDiagnostics(modal.preview.id); setModal(null); setNotice(saved ? 'Diagnostic report saved.' : 'Diagnostic export canceled.'); })}>{actionBusy ? 'Saving…' : 'Save diagnostic report'}</button></div></>}
      {modal.kind === 'connect' && <><div className="review-note"><Icon name="shield" size={21} /><p>{modal.preview.note}</p></div><p className="dialog-copy">Only Country Club hook entries are shown below. All other settings and hooks stay intact. Nothing changes until you confirm; keep coding clients idle. The complete local rollback backup may contain sensitive user settings and is not uploaded. Complete the client’s hook trust review; installation alone does not verify that hooks are trusted or firing.</p><code className="config-path">{modal.preview.configPath}</code><div className="diff-grid"><div><span className="eyebrow">COUNTRY CLUB HOOKS · BEFORE</span><pre>{modal.preview.before || '(no Country Club hook entries)'}</pre></div><div><span className="eyebrow">COUNTRY CLUB HOOKS · AFTER</span><pre>{modal.preview.after}</pre></div></div><div className="dialog-actions"><button className="secondary-button" disabled={actionBusy} onClick={() => setModal(null)}>Keep as is</button><button className="primary-button" disabled={actionBusy} onClick={() => void action(async () => { await api.applyIntegration(modal.preview); setModal(null); }, `${providerName(modal.preview.provider)} connection updated. Start a new turn and select its session.`)}>{actionBusy ? 'Connecting…' : 'Confirm connection'}<Icon name="check" size={17} /></button></div></>}
      {modal.kind === 'remove' && <><div className="review-note"><Icon name="link" size={21} /><p>Disconnection preview</p></div><p className="dialog-copy">Remove Country Club’s owned integration entries from this local configuration. Your other agent settings and hooks are preserved. Your golf progress stays saved.</p><code className="config-path">{modal.integration.configPath}</code><div className="removal-preview"><span>Current connection</span><strong>{providerName(modal.integration.provider)} · {modal.integration.status}</strong><Icon name="arrow" /><span>After confirmation</span><strong>Country Club disconnected</strong></div><div className="dialog-actions"><button className="secondary-button" disabled={actionBusy} onClick={() => setModal(null)}>Stay connected</button><button className="primary-button" disabled={actionBusy} onClick={() => void action(async () => { await api.removeIntegration(modal.integration.provider); setModal(null); }, 'The integration was removed. Your round is still here.')}>{actionBusy ? 'Disconnecting…' : 'Confirm disconnection'}</button></div></>}
      {modal.kind === 'import' && <><p className="dialog-copy">Choose a Country Club progress JSON file. A valid import replaces the current round. Invalid or canceled imports leave the current round unchanged. Export first if you want to keep a separate copy.</p><div className="reset-summary"><Icon name="flag" size={27} /><div><strong>Current round</strong><span>{club.restoreFailed ? 'Existing save could not be read; it has not been replaced.' : `${round.scores.length} holes complete · ${score} strokes`}</span></div></div><div className="dialog-actions"><button className="secondary-button" disabled={actionBusy || club.pending} onClick={() => setModal(null)}>Keep my round</button><button className="primary-button" disabled={actionBusy || club.pending} onClick={() => void action(async () => { const imported = await club.importRound(); setModal(null); setNotice(imported ? 'Progress imported.' : 'Import canceled. Your round is unchanged.'); })}>{actionBusy ? 'Importing…' : 'Choose progress file'}</button></div></>}
      {modal.kind === 'reset' && <><p className="dialog-copy">Begin a new nine-hole round. This replaces the current round on this computer. Export a readable round first if you want to keep a separate copy.</p><div className="reset-summary"><Icon name="flag" size={27} /><div><strong>The Club Nine</strong><span>{club.restoreFailed ? 'Unreadable save preserved until you confirm.' : `${round.scores.length} holes complete · ${score} strokes`}</span></div></div><div className="dialog-actions"><button className="secondary-button" disabled={club.pending} onClick={() => setModal(null)}>Keep my round</button><button className="primary-button" disabled={club.pending} onClick={() => { setModal(null); void club.newRound(); }}>{club.pending ? 'Preparing…' : 'Start fresh'}<Icon name="arrow" size={17} /></button></div></>}
      {actionError && <p className="dialog-error" role="alert">{actionError}</p>}
    </Dialog>}
  </div>;
}

createRoot(document.getElementById('root')!).render(<App />);
