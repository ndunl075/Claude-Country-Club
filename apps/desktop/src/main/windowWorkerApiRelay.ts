const names = new Set(['state','settings','load','save','practice','hide','select','preview','apply','remove','inspect-client','simulate','export','diagnostics-preview','diagnostics-export','import','docs','updates']);
export type ControllerApiHandlers = ReadonlyMap<string, (...args: any[]) => unknown>;

// The worker can request only existing, named desktop operations. It never
// receives a raw IPC channel, filesystem path, shell primitive, or controller
// object. Controller handlers retain their existing validation and ownership.
export async function relayWindowWorkerApi(payload: unknown, handlers: ControllerApiHandlers): Promise<unknown> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Invalid worker API request');
  const request = payload as { name?: unknown; args?: unknown };
  if (typeof request.name !== 'string' || !names.has(request.name) || !Array.isArray(request.args)) throw new Error('Denied worker API request');
  if (Buffer.byteLength(JSON.stringify(request.args), 'utf8') > 256 * 1024) throw new Error('Worker API payload too large');
  const handler = handlers.get(request.name);
  if (!handler) throw new Error('Unavailable worker API request');
  return handler(...request.args);
}
