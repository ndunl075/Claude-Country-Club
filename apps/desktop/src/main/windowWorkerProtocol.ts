// Contract for the future controller/window-worker boundary. This module does
// not launch a worker; it makes that boundary explicit and bounded first.
export const WINDOW_WORKER_PROTOCOL = 1 as const;
export const MAX_WINDOW_WORKER_MESSAGE_BYTES = 256 * 1024;
const id = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,128}$/.test(value);
const nonce = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{48}$/i.test(value);
const generation = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= 2 ** 31 - 1;
const bounded = (value: unknown) => {
  try { return Buffer.byteLength(JSON.stringify(value), 'utf8') <= MAX_WINDOW_WORKER_MESSAGE_BYTES; }
  catch { return false; }
};

export type ControllerToWindowWorker =
  | { protocolVersion: 1; type: 'init'; generation: number; nonce: string }
  | { protocolVersion: 1; type: 'command'; generation: number; id: string; command: string; payload: unknown }
  | { protocolVersion: 1; type: 'response'; generation: number; id: string; ok: boolean; payload?: unknown; errorCode?: string };
export type WindowWorkerToController =
  | { protocolVersion: 1; type: 'ready'; generation: number; nonce: string }
  | { protocolVersion: 1; type: 'request'; generation: number; id: string; command: string; payload: unknown }
  | { protocolVersion: 1; type: 'response'; generation: number; id: string; ok: boolean; payload?: unknown; errorCode?: string };

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
export function parseControllerMessage(value: unknown): ControllerToWindowWorker | undefined {
  const message = object(value); if (!message || message.protocolVersion !== WINDOW_WORKER_PROTOCOL || !generation(message.generation) || !bounded(message)) return;
  if (message.type === 'init' && nonce(message.nonce)) return { protocolVersion: 1, type: 'init', generation: message.generation as number, nonce: message.nonce };
  if (message.type === 'command' && id(message.id) && id(message.command)) return { protocolVersion: 1, type: 'command', generation: message.generation as number, id: message.id, command: message.command, payload: message.payload };
  if (message.type === 'response' && id(message.id) && typeof message.ok === 'boolean' && (message.errorCode === undefined || id(message.errorCode))) return { protocolVersion: 1, type: 'response', generation: message.generation as number, id: message.id, ok: message.ok, ...(message.payload === undefined ? {} : { payload: message.payload }), ...(message.errorCode ? { errorCode: message.errorCode } : {}) };
}
export function parseWorkerMessage(value: unknown): WindowWorkerToController | undefined {
  const message = object(value); if (!message || message.protocolVersion !== WINDOW_WORKER_PROTOCOL || !generation(message.generation) || !bounded(message)) return;
  if (message.type === 'ready' && nonce(message.nonce)) return { protocolVersion: 1, type: 'ready', generation: message.generation as number, nonce: message.nonce };
  if (message.type === 'request' && id(message.id) && id(message.command)) return { protocolVersion: 1, type: 'request', generation: message.generation as number, id: message.id, command: message.command, payload: message.payload };
  if (message.type === 'response' && id(message.id) && typeof message.ok === 'boolean' && (message.errorCode === undefined || id(message.errorCode))) {
    return { protocolVersion: 1, type: 'response', generation: message.generation as number, id: message.id, ok: message.ok, ...(message.payload === undefined ? {} : { payload: message.payload }), ...(message.errorCode ? { errorCode: message.errorCode } : {}) };
  }
}
export function isCurrentWorkerMessage(value: unknown, generationValue: number, nonceValue: string): value is WindowWorkerToController {
  const message = parseWorkerMessage(value);
  return !!message && message.generation === generationValue && (message.type !== 'ready' || message.nonce === nonceValue);
}
