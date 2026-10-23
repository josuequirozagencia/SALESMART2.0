/** Sustituto de `socket.io-client` para las pruebas: no abre ninguna red; la prueba decide qué «llega» desde el servidor. */
type Handler = (...args: never[]) => void;

export class FakeSocket {
  connected = false;
  closed = false;
  connects = 0;
  authToken: string | null = null;
  private readonly handlers = new Map<string, Handler[]>();

  constructor(readonly opts: { path?: string; auth?: (cb: (data: Record<string, unknown>) => void) => void }) {
    opts.auth?.((d) => { this.authToken = typeof d['token'] === 'string' ? d['token'] : null; });
  }
  on(event: string, fn: Handler): this {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), fn]);
    return this;
  }
  connect(): this {
    this.connects += 1;
    return this;
  }
  close(): this {
    this.closed = true;
    this.connected = false;
    return this;
  }
  /** Lo que haría el servidor o la red: dispara los manejadores registrados. */
  fire(event: string, ...args: unknown[]): void {
    if (event === 'connect') this.connected = true;
    if (event === 'disconnect') this.connected = false;
    for (const fn of this.handlers.get(event) ?? []) (fn as (...a: unknown[]) => void)(...args);
  }
}

export const sockets: FakeSocket[] = [];
export function fakeIo(opts: ConstructorParameters<typeof FakeSocket>[0]): FakeSocket {
  const s = new FakeSocket(opts);
  sockets.push(s);
  return s;
}
export const lastSocket = (): FakeSocket => {
  const s = sockets.at(-1);
  if (!s) throw new Error('no se abrió ninguna conexión en vivo');
  return s;
};
