import type { AppLogger } from '../logger';
import type { CalendarReconnectMail, CompanyDeletedMail, CompanyExportReadyMail, CompanyPurgeNoticeMail, CompanyRecoveredMail, InvitationMail, MailProvider, OwnershipChangeMail, PasswordResetMail, VerificationMail } from './ports';

/** Sin proveedor: el servicio informa que no está disponible. Es el valor por defecto (y el único válido hoy en producción). */
export class UnavailableMailProvider implements MailProvider {
  readonly available = false;
  sendVerificationCode(): Promise<void> {
    return Promise.reject(new Error('MailProvider no configurado'));
  }
  sendPasswordReset(): Promise<void> {
    return Promise.reject(new Error('MailProvider no configurado'));
  }
  sendInvitation(): Promise<void> {
    return Promise.reject(new Error('MailProvider no configurado'));
  }
  sendOwnershipChange(): Promise<void> {
    return Promise.reject(new Error('MailProvider no configurado'));
  }
  sendCompanyDeleted(): Promise<void> {
    return Promise.reject(new Error('MailProvider no configurado'));
  }
  sendCompanyExportReady(): Promise<void> {
    return Promise.reject(new Error('MailProvider no configurado'));
  }
  sendCompanyPurgeNotice(): Promise<void> {
    return Promise.reject(new Error('MailProvider no configurado'));
  }
  sendCompanyRecovered(): Promise<void> {
    return Promise.reject(new Error('MailProvider no configurado'));
  }
  sendCalendarReconnect(): Promise<void> {
    return Promise.reject(new Error('MailProvider no configurado'));
  }
}
/** SOLO PRUEBAS: guarda los correos en memoria. La configuración lo rechaza en producción. */
export class MemoryMailProvider implements MailProvider {
  readonly available = true;
  readonly outbox: VerificationMail[] = [];
  readonly resetOutbox: PasswordResetMail[] = [];
  readonly inviteOutbox: InvitationMail[] = [];
  readonly ownershipOutbox: OwnershipChangeMail[] = [];
  readonly companyDeletedOutbox: CompanyDeletedMail[] = [];
  readonly companyExportReadyOutbox: CompanyExportReadyMail[] = [];
  readonly companyPurgeNoticeOutbox: CompanyPurgeNoticeMail[] = [];
  readonly companyRecoveredOutbox: CompanyRecoveredMail[] = [];
  readonly calendarReconnectOutbox: CalendarReconnectMail[] = [];
  failNext = false;
  sendVerificationCode(mail: VerificationMail): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      return Promise.reject(new Error('fallo simulado del proveedor'));
    }
    this.outbox.push(mail);
    return Promise.resolve();
  }
  sendPasswordReset(mail: PasswordResetMail): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      return Promise.reject(new Error('fallo simulado del proveedor'));
    }
    this.resetOutbox.push(mail);
    return Promise.resolve();
  }
  sendInvitation(mail: InvitationMail): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      return Promise.reject(new Error('fallo simulado del proveedor'));
    }
    this.inviteOutbox.push(mail);
    return Promise.resolve();
  }
  sendOwnershipChange(mail: OwnershipChangeMail): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      return Promise.reject(new Error('fallo simulado del proveedor'));
    }
    this.ownershipOutbox.push(mail);
    return Promise.resolve();
  }
  sendCompanyDeleted(mail: CompanyDeletedMail): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      return Promise.reject(new Error('fallo simulado del proveedor'));
    }
    this.companyDeletedOutbox.push(mail);
    return Promise.resolve();
  }
  sendCompanyExportReady(mail: CompanyExportReadyMail): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      return Promise.reject(new Error('fallo simulado del proveedor'));
    }
    this.companyExportReadyOutbox.push(mail);
    return Promise.resolve();
  }
  sendCompanyPurgeNotice(mail: CompanyPurgeNoticeMail): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      return Promise.reject(new Error('fallo simulado del proveedor'));
    }
    this.companyPurgeNoticeOutbox.push(mail);
    return Promise.resolve();
  }
  sendCompanyRecovered(mail: CompanyRecoveredMail): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      return Promise.reject(new Error('fallo simulado del proveedor'));
    }
    this.companyRecoveredOutbox.push(mail);
    return Promise.resolve();
  }
  sendCalendarReconnect(mail: CalendarReconnectMail): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      return Promise.reject(new Error('fallo simulado del proveedor'));
    }
    this.calendarReconnectOutbox.push(mail);
    return Promise.resolve();
  }
  lastInvitation(to: string): InvitationMail | undefined {
    return [...this.inviteOutbox].reverse().find((m) => m.to === to);
  }
  /** Extrae el token del fragmento del enlace de invitación (solo pruebas). */
  lastInvitationToken(to: string): string | undefined {
    const url = this.lastInvitation(to)?.inviteUrl;
    return url ? new URL(url).hash.replace(/^#token=/, '') : undefined;
  }
  lastReset(to: string): PasswordResetMail | undefined {
    return [...this.resetOutbox].reverse().find((m) => m.to === to);
  }
  /** Extrae el token del fragmento del enlace (solo pruebas). */
  lastResetToken(to: string): string | undefined {
    const url = this.lastReset(to)?.resetUrl;
    return url ? new URL(url).hash.replace(/^#token=/, '') : undefined;
  }
  last(to: string): VerificationMail | undefined {
    return [...this.outbox].reverse().find((m) => m.to === to);
  }
}

/** SOLO DESARROLLO: imprime el código en el log para poder completar el flujo sin proveedor. Rechazado en producción. */
export class ConsoleMailProvider implements MailProvider {
  readonly available = true;
  constructor(private readonly log: AppLogger) {}
  sendVerificationCode(mail: VerificationMail): Promise<void> {
    this.log.warn({ to: mail.to, code: mail.code }, 'DEV ONLY: correo de verificación (no se envía)');
    return Promise.resolve();
  }
  sendPasswordReset(mail: PasswordResetMail): Promise<void> {
    this.log.warn({ to: mail.to, resetUrl: mail.resetUrl }, 'DEV ONLY: correo de restablecimiento (no se envía)');
    return Promise.resolve();
  }
  sendInvitation(mail: InvitationMail): Promise<void> {
    this.log.warn({ to: mail.to, inviteUrl: mail.inviteUrl }, 'DEV ONLY: correo de invitación (no se envía)');
    return Promise.resolve();
  }
  sendOwnershipChange(mail: OwnershipChangeMail): Promise<void> {
    this.log.warn({ to: mail.to, agency: mail.agencyName }, 'DEV ONLY: aviso de cambio de administración (no se envía)');
    return Promise.resolve();
  }
  sendCompanyDeleted(mail: CompanyDeletedMail): Promise<void> {
    this.log.warn({ to: mail.to, audience: mail.audience }, 'DEV ONLY: aviso de empresa eliminada (no se envía)');
    return Promise.resolve();
  }
  sendCompanyExportReady(mail: CompanyExportReadyMail): Promise<void> {
    this.log.warn({ to: mail.to, downloadUrl: mail.downloadUrl }, 'DEV ONLY: aviso de copia de datos lista (no se envía)');
    return Promise.resolve();
  }
  sendCompanyPurgeNotice(mail: CompanyPurgeNoticeMail): Promise<void> {
    this.log.warn({ to: mail.to, audience: mail.audience }, 'DEV ONLY: aviso de borrado definitivo en 24 horas (no se envía)');
    return Promise.resolve();
  }
  sendCompanyRecovered(mail: CompanyRecoveredMail): Promise<void> {
    this.log.warn({ to: mail.to, audience: mail.audience }, 'DEV ONLY: aviso de empresa recuperada (no se envía)');
    return Promise.resolve();
  }
  sendCalendarReconnect(mail: CalendarReconnectMail): Promise<void> {
    this.log.warn({ to: mail.to, reconnectUrl: mail.reconnectUrl }, 'DEV ONLY: aviso de Google Calendar a reconectar (no se envía)');
    return Promise.resolve();
  }
}
