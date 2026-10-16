/**
 * Catálogo de proveedores de la plataforma (M2.6, ADR-42; ADR-21): qué servicios hay, qué empresa externa puede estar detrás de cada uno y qué datos
 * necesita. Vive en CÓDIGO (no en la BD): cada proveedor nuevo llega con su adaptador y su contract test, y el catálogo es lo que dice qué se acepta.
 * La BD solo guarda lo que decide el Súper Admin (proveedor activo y credenciales).
 *
 * TODO valor de un proveedor (claves, tokens, URL de la instancia, región…) se trata como credencial: se guarda cifrado y solo se ve su final (últimos 4).
 * `masked` solo decide cómo se TECLEA en la pantalla (oculto o a la vista); el servidor los trata igual.
 * PROVISIONAL: la lista de campos de cada proveedor se ajusta cuando se construye su adaptador (M5 en adelante).
 */
export interface FieldDef {
  readonly key: string;
  readonly label: string;
  /** true = se teclea oculto (claves, tokens); false = a la vista (URL, región, bucket, ID). */
  readonly masked: boolean;
  readonly required: boolean;
  /** `url` = http(s) sin credenciales, query ni fragmento. */
  readonly format?: 'url';
  readonly hint?: string;
}

/** previsto = el plan base · reservas = funciona pero con riesgo conocido · candidato = en comparación (PoC) */
export type Maturity = 'planned' | 'reserved' | 'candidate';
export interface ProviderDef {
  readonly key: string;
  readonly label: string;
  readonly maturity: Maturity;
  readonly note?: string;
  readonly fields: readonly FieldDef[];
}

/**
 *  - `platform`: el Súper Admin elige el proveedor y guarda sus credenciales aquí.
 *  - `env`: se configura con variables de entorno del servidor (solo se muestra su estado).
 *  - `client`: cada empresa pone lo suyo (p. ej. su token); aquí solo se informa.
 *  - `fixed`: no es intercambiable hoy (solo se informa).
 */
export type Managed = 'platform' | 'env' | 'client' | 'fixed';
export interface ServiceDef {
  readonly key: string;
  readonly label: string;
  /** Puerto del núcleo que implementa el proveedor (CLAUDE.md, «Integraciones por adaptador»). */
  readonly adapter: string;
  readonly managed: Managed;
  readonly note: string;
  readonly providers: readonly ProviderDef[];
}

const apiKey: FieldDef = { key: 'api_key', label: 'Clave de API', masked: true, required: true };

export const PROVIDER_CATALOG: readonly ServiceDef[] = [
  {
    key: 'auth',
    label: 'Autenticación',
    adapter: 'AuthProvider',
    managed: 'fixed',
    note: 'Cuentas propias con Argon2id (ADR-01). Clerk queda preparado pero no activo: el dominio usa el identificador interno del usuario.',
    providers: [{ key: 'local', label: 'LocalAuthProvider · Argon2id', maturity: 'planned', fields: [] }],
  },
  {
    key: 'whatsapp_official',
    label: 'WhatsApp oficial',
    adapter: 'WhatsAppProvider',
    managed: 'platform',
    note: 'Varios números por empresa; webhooks, estados y reintentos. Las credenciales de cada número las conecta cada empresa; aquí va la aplicación de la plataforma.',
    providers: [
      {
        key: 'meta_cloud',
        label: 'Meta WhatsApp Cloud API',
        maturity: 'planned',
        fields: [
          { key: 'app_id', label: 'ID de la app de Meta', masked: false, required: true },
          { key: 'app_secret', label: 'Secreto de la app', masked: true, required: true },
          { key: 'verify_token', label: 'Token de verificación del webhook', masked: true, required: true },
        ],
      },
    ],
  },
  {
    key: 'whatsapp_qr',
    label: 'WhatsApp por QR',
    adapter: 'WhatsAppProvider',
    managed: 'platform',
    note: 'Canal NO oficial: puede desconectarse o bloquear el número. Intercambiable; úsalo con la advertencia visible para el cliente.',
    providers: [
      {
        key: 'evolution',
        label: 'Evolution API (QR)',
        maturity: 'reserved',
        note: 'No oficial: riesgo de bloqueo del número.',
        fields: [
          { key: 'base_url', label: 'URL de la instancia', masked: false, required: true, format: 'url' },
          { key: 'api_key', label: 'Clave global de la API', masked: true, required: true },
        ],
      },
    ],
  },
  {
    key: 'ghl',
    label: 'GoHighLevel',
    adapter: 'GHL Integration Layer',
    managed: 'client',
    note: 'Cada empresa guarda su propio token en Integraciones (cifrado). Aquí no hay credenciales de plataforma. OAuth queda preparado para clientes reales.',
    providers: [{ key: 'private_token', label: 'Token privado por empresa', maturity: 'planned', fields: [] }],
  },
  {
    key: 'telephony',
    label: 'Telefonía',
    adapter: 'TelephonyProvider',
    managed: 'platform',
    note: 'Telnyx y SIP/BYOC están previstos, pero todavía no hay adaptador.',
    providers: [
      {
        key: 'twilio',
        label: 'Twilio',
        maturity: 'planned',
        fields: [
          { key: 'account_sid', label: 'Account SID', masked: true, required: true },
          { key: 'auth_token', label: 'Auth Token', masked: true, required: true },
        ],
      },
    ],
  },
  {
    key: 'voice_ai',
    label: 'IA de voz',
    adapter: 'VoiceAIProvider',
    managed: 'platform',
    note: 'Por decidir tras el PoC comparativo (mismo agente y mismos casos). No hay proveedor activo hasta que se decida; las credenciales de los candidatos sirven para la prueba.',
    providers: [
      { key: 'retell', label: 'Retell AI', maturity: 'candidate', fields: [apiKey] },
      { key: 'vapi', label: 'Vapi', maturity: 'candidate', fields: [apiKey] },
    ],
  },
  {
    key: 'text_ai',
    label: 'IA de texto',
    adapter: 'AIProvider',
    managed: 'platform',
    note: 'La clave es de la plataforma (se cobra con Créditos IA). Gemini y OpenRouter quedan disponibles como alternativas.',
    providers: [
      { key: 'openai', label: 'OpenAI', maturity: 'planned', fields: [apiKey] },
      { key: 'gemini', label: 'Google Gemini', maturity: 'planned', fields: [apiKey] },
      { key: 'openrouter', label: 'OpenRouter', maturity: 'planned', fields: [apiKey] },
    ],
  },
  {
    key: 'storage',
    label: 'Almacenamiento',
    adapter: 'StorageAdapter',
    managed: 'platform',
    note: 'Compatible con S3. Los archivos van bajo un prefijo por organización y con URL firmada.',
    providers: [
      {
        key: 's3_compatible',
        label: 'S3 compatible',
        maturity: 'planned',
        fields: [
          { key: 'endpoint', label: 'Endpoint', masked: false, required: true, format: 'url' },
          { key: 'region', label: 'Región', masked: false, required: true },
          { key: 'bucket', label: 'Bucket', masked: false, required: true },
          { key: 'access_key_id', label: 'ID de la clave de acceso', masked: true, required: true },
          { key: 'secret_access_key', label: 'Clave de acceso secreta', masked: true, required: true },
        ],
      },
    ],
  },
  {
    key: 'vector',
    label: 'Base vectorial',
    adapter: 'VectorStore',
    managed: 'fixed',
    note: 'pgvector dentro de la propia base de datos; el filtro por organización y agente es obligatorio. La extensión se instalará con el primer módulo que la use.',
    providers: [{ key: 'pgvector', label: 'pgvector', maturity: 'planned', fields: [] }],
  },
  {
    key: 'mail',
    label: 'Correo transaccional',
    adapter: 'MailProvider',
    managed: 'env',
    note: 'Se configura con variables de entorno del servidor (MAIL_PROVIDER, RESEND_API_KEY, MAIL_FROM, FRONTEND_BASE_URL). Aquí solo se ve su estado.',
    providers: [{ key: 'resend', label: 'Resend', maturity: 'planned', fields: [] }],
  },
  {
    key: 'captcha',
    label: 'Anti-bots del registro',
    adapter: 'CaptchaVerifier',
    managed: 'env',
    note: 'Se configura con variables de entorno del servidor (CAPTCHA_PROVIDER, TURNSTILE_SECRET_KEY y VITE_TURNSTILE_SITE_KEY en la web). Aquí solo se ve su estado.',
    providers: [{ key: 'turnstile', label: 'Cloudflare Turnstile', maturity: 'planned', fields: [] }],
  },
  {
    key: 'payments',
    label: 'Pasarela de pago',
    adapter: 'PaymentProvider',
    managed: 'platform',
    note: 'Decisión abierta: todavía no hay candidatos. Mientras tanto el cobro de los planes es manual (ADR-38).',
    providers: [],
  },
];

export const findService = (key: string): ServiceDef | undefined => PROVIDER_CATALOG.find((s) => s.key === key);
export const findProvider = (service: ServiceDef, key: string): ProviderDef | undefined => service.providers.find((p) => p.key === key);
