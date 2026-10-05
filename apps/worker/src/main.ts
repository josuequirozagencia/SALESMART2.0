// Worker: cascarón de M0. Los trabajos (colas) se añaden con los módulos funcionales.
// Regla: todo job que toque datos de negocio entra con TenantContext.run(...) y usa Database.withTenant(...).
import { createLogger, describeConfig, loadConfig } from '@sales-smart/api';

const cfg = loadConfig();
const log = createLogger({ level: cfg.logLevel });
log.info({ config: describeConfig(cfg) }, 'worker iniciado (sin trabajos registrados)');
