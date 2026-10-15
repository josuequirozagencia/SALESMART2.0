import type { InvitationMail, OwnershipChangeMail, PasswordResetMail, VerificationMail } from './ports';

export interface MailContent {
  subject: string;
  html: string;
  text: string;
}

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** Marco común: estilos en línea (los clientes de correo no cargan CSS externo), sin imágenes ni scripts. */
function frame(title: string, body: string, footer = 'Si no fuiste tú, ignora este correo: no se hará ningún cambio en tu cuenta.'): string {
  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title></head>
<body style="margin:0;padding:0;background:#f4f2fc;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#16112e;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f2fc;padding:24px 12px;"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border-radius:14px;padding:28px;">
<tr><td style="font-size:17px;font-weight:700;padding-bottom:18px;"><span style="display:inline-block;width:30px;height:30px;line-height:30px;text-align:center;border-radius:8px;background:#6a44f2;color:#ffffff;margin-right:8px;">S</span>Sales Smart</td></tr>
${body}
<tr><td style="font-size:12px;color:#5f5a7a;padding-top:22px;border-top:1px solid #e2def2;">${esc(footer)}</td></tr>
</table></td></tr></table></body></html>`;
}

export function verificationMail(m: VerificationMail): MailContent {
  const minutes = Math.max(1, Math.round(m.expiresInMinutes));
  const html = frame(
    'Verifica tu correo',
    `<tr><td style="font-size:22px;font-weight:700;padding-bottom:8px;">Verifica tu correo</td></tr>
<tr><td style="font-size:14px;line-height:1.5;color:#3b3558;padding-bottom:16px;">Usa este código para terminar de crear tu cuenta. Vence en ${minutes} minutos.</td></tr>
<tr><td align="center" style="padding:6px 0 4px;"><div style="display:inline-block;font-family:'IBM Plex Mono',Menlo,Consolas,monospace;font-size:34px;letter-spacing:10px;font-weight:600;color:#6a44f2;background:#ece6ff;border-radius:12px;padding:14px 18px 14px 28px;">${esc(m.code)}</div></td></tr>`,
  );
  const text = `Verifica tu correo — Sales Smart\n\nTu código es: ${m.code}\nVence en ${minutes} minutos.\n\nSi no fuiste tú, ignora este correo: no se hará ningún cambio en tu cuenta.\n`;
  return { subject: 'Tu código de verificación de Sales Smart', html, text };
}

export function passwordResetMail(m: PasswordResetMail): MailContent {
  // El enlace lo arma el servidor con FRONTEND_BASE_URL; aun así solo se admite http(s) (nada de javascript:)
  if (!/^https?:\/\//i.test(m.resetUrl)) throw new Error('resetUrl debe ser http(s)');
  const minutes = Math.max(1, Math.round(m.expiresInMinutes));
  const url = esc(m.resetUrl);
  const html = frame(
    'Crea una contraseña nueva',
    `<tr><td style="font-size:22px;font-weight:700;padding-bottom:8px;">Crea una contraseña nueva</td></tr>
<tr><td style="font-size:14px;line-height:1.5;color:#3b3558;padding-bottom:18px;">Recibimos una solicitud para restablecer tu contraseña. El enlace funciona una sola vez y vence en ${minutes} minutos.</td></tr>
<tr><td align="center" style="padding-bottom:14px;"><a href="${url}" style="display:inline-block;background:#6a44f2;color:#ffffff;text-decoration:none;font-weight:600;font-size:14px;border-radius:10px;padding:12px 22px;">Crear contraseña nueva</a></td></tr>
<tr><td style="font-size:12px;line-height:1.5;color:#5f5a7a;word-break:break-all;">Si el botón no funciona, copia y pega este enlace en tu navegador:<br>${url}</td></tr>`,
  );
  const text = `Crea una contraseña nueva — Sales Smart\n\nAbre este enlace para elegir una contraseña nueva (funciona una sola vez y vence en ${minutes} minutos):\n${m.resetUrl}\n\nSi no fuiste tú, ignora este correo: no se hará ningún cambio en tu cuenta.\n`;
  return { subject: 'Restablece tu contraseña de Sales Smart', html, text };
}

export function invitationMail(m: InvitationMail): MailContent {
  if (!/^https?:\/\//i.test(m.inviteUrl)) throw new Error('inviteUrl debe ser http(s)');
  const days = Math.max(1, Math.round(m.expiresInDays));
  const url = esc(m.inviteUrl);
  const org = esc(m.organizationName);
  const agency = m.kind === 'agency';
  const html = frame(
    'Te invitaron a Sales Smart',
    `<tr><td style="font-size:22px;font-weight:700;padding-bottom:8px;">Te invitaron a Sales Smart</td></tr>
<tr><td style="font-size:14px;line-height:1.5;color:#3b3558;padding-bottom:18px;">${agency ? 'Crearon la agencia' : 'Crearon la cuenta de'} <b>${org}</b> y te invitan a administrarla. Acepta la invitación para elegir tu contraseña. El enlace funciona una sola vez y vence en ${days} ${days === 1 ? 'día' : 'días'}.</td></tr>
<tr><td align="center" style="padding-bottom:14px;"><a href="${url}" style="display:inline-block;background:#6a44f2;color:#ffffff;text-decoration:none;font-weight:600;font-size:14px;border-radius:10px;padding:12px 22px;">Aceptar la invitación</a></td></tr>
<tr><td style="font-size:12px;line-height:1.5;color:#5f5a7a;word-break:break-all;">Si el botón no funciona, copia y pega este enlace en tu navegador:<br>${url}</td></tr>`,
  );
  const text = `Te invitaron a Sales Smart

${agency ? 'Crearon la agencia' : 'Crearon la cuenta de'} ${m.organizationName} y te invitan a administrarla. Abre este enlace para aceptar y elegir tu contraseña (funciona una sola vez y vence en ${days} ${days === 1 ? 'día' : 'días'}):
${m.inviteUrl}

Si no esperabas esta invitación, ignora este correo: no se hará ningún cambio.
`;
  return { subject: `Te invitaron a ${m.organizationName.slice(0, 60)} en Sales Smart`, html, text };
}

/** Aviso al administrador de un cliente: cambió quién administra su cuenta (ADR-22). No lleva enlaces ni datos del negocio. */
export function ownershipChangeMail(m: OwnershipChangeMail): MailContent {
  const org = esc(m.organizationName);
  const agency = m.agencyName === null ? null : esc(m.agencyName);
  const previous = m.previousAgencyName === null ? null : esc(m.previousAgencyName);
  const headline = agency ? `Ahora ${agency} administra tu cuenta` : 'Administras tu cuenta directamente';
  const detail = agency
    ? `La cuenta de <b>${org}</b> ahora la administra la agencia <b>${agency}</b>${previous ? `, en lugar de <b>${previous}</b>` : ''}. Tu plan, tu facturación y tus datos no cambian.`
    : `La cuenta de <b>${org}</b> ya no está a cargo de una agencia${previous ? ` (antes: <b>${previous}</b>)` : ''}: la administras tú directamente. Tu plan, tu facturación y tus datos no cambian.`;
  const html = frame(
    headline,
    `<tr><td style="font-size:22px;font-weight:700;padding-bottom:8px;">${headline}</td></tr>
<tr><td style="font-size:14px;line-height:1.5;color:#3b3558;padding-bottom:8px;">${detail}</td></tr>
<tr><td style="font-size:13px;line-height:1.5;color:#5f5a7a;">Si no esperabas este cambio, responde a este correo o escribe a quien te atiende en Sales Smart.</td></tr>`,
    'Aviso informativo de Sales Smart.',
  );
  const plain = agency
    ? `La cuenta de ${m.organizationName} ahora la administra la agencia ${m.agencyName}${m.previousAgencyName ? `, en lugar de ${m.previousAgencyName}` : ''}. Tu plan, tu facturación y tus datos no cambian.`
    : `La cuenta de ${m.organizationName} ya no está a cargo de una agencia${m.previousAgencyName ? ` (antes: ${m.previousAgencyName})` : ''}: la administras tú directamente. Tu plan, tu facturación y tus datos no cambian.`;
  const text = `${m.agencyName ? `Ahora ${m.agencyName} administra tu cuenta` : 'Administras tu cuenta directamente'} — Sales Smart

${plain}

Si no esperabas este cambio, responde a este correo o escribe a quien te atiende en Sales Smart.
`;
  return { subject: m.agencyName ? `Cambió la administración de ${m.organizationName.slice(0, 60)}` : `Administras ${m.organizationName.slice(0, 60)} directamente`, html, text };
}
