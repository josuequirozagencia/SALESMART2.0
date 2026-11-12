export { MailModule } from './mail.module';
export { MAIL_PROVIDER, type MailProvider, type VerificationMail, type PasswordResetMail, type InvitationMail, type OwnershipChangeMail, type CompanyDeletedMail, type CompanyExportReadyMail, type CompanyPurgeNoticeMail, type CompanyRecoveredMail, type CalendarReconnectMail } from './ports';
export { MemoryMailProvider, ConsoleMailProvider, UnavailableMailProvider } from './fakes';
export { ResendMailProvider } from './resend.provider';
