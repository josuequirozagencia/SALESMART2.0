import { invitationMail, passwordResetMail, verificationMail, type MailContent } from './mail-templates';
import type { InvitationMail, MailProvider, PasswordResetMail, VerificationMail } from './ports';

export interface ResendOptions {
  apiKey: string;
  /** Remitente verificado en Resend: «Sales Smart <no-reply@dominio>» o solo la dirección. */
  from: string;
  /** Solo pruebas: sustituye a `fetch` global. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  baseUrl?: string;
}

/**
 * Adaptador de correo transaccional sobre Resend (ADR-37). Detrás del puerto `MailProvider`: el núcleo no conoce a Resend.
 *  - Host fijo (api.resend.com): nada de la petición del usuario decide a dónde se envía la llamada.
 *  - La clave solo viaja en la cabecera Authorization y NUNCA aparece en mensajes de error ni en logs.
 *  - Tiempo máximo por envío; un fallo lanza (el servicio lo registra y el usuario puede reenviar), jamás finge éxito.
 */
export class ResendMailProvider implements MailProvider {
  readonly available = true;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly url: string;

  constructor(private readonly opts: ResendOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.url = `${opts.baseUrl ?? 'https://api.resend.com'}/emails`;
  }

  sendVerificationCode(mail: VerificationMail): Promise<void> {
    return this.send(mail.to, () => verificationMail(mail));
  }

  sendPasswordReset(mail: PasswordResetMail): Promise<void> {
    return this.send(mail.to, () => passwordResetMail(mail));
  }

  sendInvitation(mail: InvitationMail): Promise<void> {
    return this.send(mail.to, () => invitationMail(mail));
  }

  /** La plantilla se construye DENTRO de la función asíncrona: un error de plantilla es un rechazo, nunca una excepción síncrona. */
  private async send(to: string, build: () => MailContent): Promise<void> {
    const c = build();
    let res: Response;
    try {
      res = await this.fetchImpl(this.url, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.opts.apiKey}`, 'content-type': 'application/json', 'user-agent': 'sales-smart/2.0' },
        body: JSON.stringify({ from: this.opts.from, to: [to], subject: c.subject, html: c.html, text: c.text }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      // El mensaje no lleva detalles de la excepción (pueden incluir la URL o cabeceras); la causa queda adjunta pero el servicio solo registra el mensaje
      throw new Error(e instanceof Error && e.name === 'TimeoutError' ? 'Resend: tiempo de espera agotado' : 'Resend: no se pudo conectar', { cause: e });
    }
    if (res.ok) return;
    let detail = '';
    try {
      const j = (await res.json()) as { name?: string; message?: string };
      detail = [j.name, j.message].filter(Boolean).join(': ').slice(0, 200);
    } catch {
      /* cuerpo no JSON */
    }
    throw new Error(`Resend respondió ${res.status}${detail ? ` (${detail})` : ''}`);
  }
}
