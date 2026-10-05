import pino, { type DestinationStream, type Logger } from 'pino';
import { PlatformContext, TenantContext } from '../tenant';
import { redactPii, redactString } from './redact';

export type AppLogger = Logger;

export interface LoggerOptions {
  level: string;
  /** Solo para tests: destino alternativo al stdout. */
  destination?: DestinationStream;
}

/** Logger JSON estructurado. Todo lo que pasa por él se redacta (args, bindings de child, errores). */
export function createLogger(opts: LoggerOptions): AppLogger {
  const logger = pino(
    {
      level: opts.level,
      base: undefined, // sin pid/hostname
      timestamp: pino.stdTimeFunctions.isoTime,
      messageKey: 'msg',
      formatters: {
        level: (label) => ({ level: label }),
        // log: objeto de la llamada (incluye bindings de child resueltos por pino)
        log: (obj) => redactPii(obj),
        bindings: (b) => redactPii(b),
      },
      serializers: { err: (e: unknown) => redactPii(e), error: (e: unknown) => redactPii(e) },
      hooks: {
        // El mensaje y los argumentos de formato (%s) también pueden llevar PII
        logMethod(args, method) {
          const scrubbed = args.map((a) => (typeof a === 'string' ? redactString(a) : a)) as unknown as Parameters<typeof method>;
          method.apply(this, scrubbed);
        },
      },
      mixin() {
        const t = TenantContext.currentOrNull();
        if (t) return { org_id: t.organizationId, request_id: t.requestId, ...(t.userId ? { user_id: t.userId } : {}) };
        const p = PlatformContext.currentOrNull();
        if (p) return { platform_actor: p.actorUserId, request_id: p.requestId };
        return {};
      },
    },
    opts.destination,
  );

  // pino NO pasa por formatters.log los bindings de child(): se redactan aquí. Los hijos heredan este override
  // (se crean con Object.create), de modo que child().child() también queda cubierto.
  const originalChild = logger.child;
  logger.child = function child(this: Logger, bindings, options) {
    return originalChild.call(this, redactPii(bindings), options);
  } as Logger['child'];
  return logger;
}
