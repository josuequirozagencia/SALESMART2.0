export { CAPTCHA_VERIFIER, type CaptchaVerifier } from './ports';
export { FAKE_CAPTCHA_PASS } from './fakes';
// El correo es infraestructura compartida (src/mail); se reexporta aquí para no romper las importaciones existentes
export { MAIL_PROVIDER, MemoryMailProvider, type MailProvider, type VerificationMail, type PasswordResetMail } from '../../../mail';
