import type { CalendarReconnectMail, CompanyDeletedMail, CompanyExportReadyMail, CompanyPurgeNoticeMail, CompanyRecoveredMail, InvitationMail, OwnershipChangeMail, PasswordResetMail, VerificationMail } from './ports';

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

/** Fecha larga en la zona de la empresa; si la zona no se reconoce, UTC (el correo nunca falla por eso). */
function longDate(d: Date, timeZone: string): string {
  const opts: Intl.DateTimeFormatOptions = { dateStyle: 'long', timeStyle: 'short' };
  try {
    return new Intl.DateTimeFormat('es', { ...opts, timeZone }).format(d);
  } catch {
    return new Intl.DateTimeFormat('es', { ...opts, timeZone: 'UTC' }).format(d);
  }
}

/** Aviso de empresa eliminada (ADR-59 #14). Sin datos del negocio: la empresa ya no es accesible y el correo informa el plazo. Al dueño se le suma el enlace para pedir la copia de sus datos (F3b). */
export function companyDeletedMail(m: CompanyDeletedMail): MailContent {
  const org = esc(m.organizationName);
  const untilPlain = longDate(m.purgeAfter, m.timeZone);
  const until = esc(untilPlain);
  const owner = m.audience === 'owner';
  const headline = owner ? 'Tu empresa fue eliminada' : 'Un cliente tuyo fue eliminado';
  const help = owner ? 'Si necesitas una copia de tus datos o crees que fue un error, escribe a quien te atiende en Sales Smart antes de esa fecha.' : 'Si crees que fue un error, escribe a quien te atiende en Sales Smart antes de esa fecha.';
  const detail = owner
    ? `La cuenta de <b>${org}</b> fue eliminada y ya nadie puede entrar. Si fue un error, se puede recuperar hasta el <b>${until}</b>; pasada esa fecha borramos todos sus datos de forma definitiva.`
    : `Tu cliente <b>${org}</b> fue eliminado de la plataforma y ya no tienes acceso a su cuenta. Se puede recuperar hasta el <b>${until}</b>; pasada esa fecha se borran todos sus datos de forma definitiva.`;
  const exportUrl = owner && m.exportUrl && /^https?:\/\//i.test(m.exportUrl) ? m.exportUrl : null;
  const exportHtml = exportUrl
    ? `<tr><td style="font-size:14px;line-height:1.5;color:#3b3558;padding:6px 0 14px;">Puedes pedir una <b>copia completa de tus datos</b> antes de esa fecha. Te pediremos tu contraseña para entregártela.</td></tr>
<tr><td align="center" style="padding-bottom:14px;"><a href="${esc(exportUrl)}" style="display:inline-block;background:#6a44f2;color:#ffffff;text-decoration:none;font-weight:600;font-size:14px;border-radius:10px;padding:12px 22px;">Pedir la copia de mis datos</a></td></tr>
<tr><td style="font-size:12px;line-height:1.5;color:#5f5a7a;word-break:break-all;padding-bottom:10px;">Este enlace es solo tuyo: no lo compartas. Si el botón no funciona, copia y pega este enlace en tu navegador:<br>${esc(exportUrl)}</td></tr>`
    : '';
  const html = frame(
    headline,
    `<tr><td style="font-size:22px;font-weight:700;padding-bottom:8px;">${headline}</td></tr>
<tr><td style="font-size:14px;line-height:1.5;color:#3b3558;padding-bottom:8px;">${detail}</td></tr>
${exportHtml}<tr><td style="font-size:13px;line-height:1.5;color:#5f5a7a;">${help}</td></tr>`,
    'Aviso informativo de Sales Smart.',
  );
  const plain = owner
    ? `La cuenta de ${m.organizationName} fue eliminada y ya nadie puede entrar. Si fue un error, se puede recuperar hasta el ${untilPlain}; pasada esa fecha borramos todos sus datos de forma definitiva.`
    : `Tu cliente ${m.organizationName} fue eliminado de la plataforma y ya no tienes acceso a su cuenta. Se puede recuperar hasta el ${untilPlain}; pasada esa fecha se borran todos sus datos de forma definitiva.`;
  const exportText = exportUrl ? `Puedes pedir una copia completa de tus datos antes de esa fecha (te pediremos tu contraseña). Este enlace es solo tuyo, no lo compartas:\n${exportUrl}\n\n` : '';
  const text = `${headline} — Sales Smart\n\n${plain}\n\n${exportText}${help}\n`;
  return { subject: owner ? `Eliminamos la cuenta de ${m.organizationName.slice(0, 60)}` : `Eliminaron a tu cliente ${m.organizationName.slice(0, 60)}`, html, text };
}

/** Aviso de que la copia completa de los datos ya está lista (F3b, ADR-59 #9). El enlace no baja nada por sí solo: abre una página que pide la contraseña del dueño. */
export function companyExportReadyMail(m: CompanyExportReadyMail): MailContent {
  if (!/^https?:\/\//i.test(m.downloadUrl)) throw new Error('downloadUrl debe ser http(s)');
  const org = esc(m.organizationName);
  const url = esc(m.downloadUrl);
  const untilPlain = longDate(m.expiresAt, m.timeZone);
  const until = esc(untilPlain);
  const size = m.totalBytes < 1024 ** 2 ? `${Math.max(1, Math.round(m.totalBytes / 1024))} KB` : m.totalBytes < 1024 ** 3 ? `${(m.totalBytes / 1024 ** 2).toFixed(1)} MB` : `${(m.totalBytes / 1024 ** 3).toFixed(2)} GB`;
  const partsText = m.parts === 1 ? 'un archivo' : `${m.parts} archivos`;
  const html = frame(
    'La copia de tus datos está lista',
    `<tr><td style="font-size:22px;font-weight:700;padding-bottom:8px;">La copia de tus datos está lista</td></tr>
<tr><td style="font-size:14px;line-height:1.5;color:#3b3558;padding-bottom:18px;">Preparamos la copia completa de los datos de <b>${org}</b> (${partsText}, ${size}). Puedes bajarla hasta el <b>${until}</b>; después la borramos. Te pediremos tu contraseña.</td></tr>
<tr><td align="center" style="padding-bottom:14px;"><a href="${url}" style="display:inline-block;background:#6a44f2;color:#ffffff;text-decoration:none;font-weight:600;font-size:14px;border-radius:10px;padding:12px 22px;">Bajar mis datos</a></td></tr>
<tr><td style="font-size:12px;line-height:1.5;color:#5f5a7a;word-break:break-all;">Este enlace es solo tuyo: no lo compartas. Si el botón no funciona, copia y pega este enlace en tu navegador:<br>${url}</td></tr>`,
    'Aviso informativo de Sales Smart.',
  );
  const text = `La copia de tus datos está lista — Sales Smart\n\nPreparamos la copia completa de los datos de ${m.organizationName} (${partsText}, ${size}). Puedes bajarla hasta el ${untilPlain}; después la borramos. Te pediremos tu contraseña.\n\nEste enlace es solo tuyo, no lo compartas:\n${m.downloadUrl}\n`;
  return { subject: `La copia de los datos de ${m.organizationName.slice(0, 60)} está lista`, html, text };
}

/** Aviso de «mañana se borra» (F3c, ADR-59 #14): la última oportunidad de recuperar la empresa o de bajar la copia de sus datos. Sin enlaces: el del primer correo sigue valiendo. */
export function companyPurgeNoticeMail(m: CompanyPurgeNoticeMail): MailContent {
  const org = esc(m.organizationName);
  const untilPlain = longDate(m.purgeAfter, m.timeZone);
  const until = esc(untilPlain);
  const owner = m.audience === 'owner';
  const headline = owner ? 'Mañana borramos tu cuenta de forma definitiva' : 'Mañana se borra un cliente tuyo de forma definitiva';
  const detail = owner
    ? `La cuenta de <b>${org}</b> está eliminada y el <b>${until}</b> borraremos todos sus datos de forma definitiva: después no se podrán recuperar. Si necesitas una copia de tus datos, usa el enlace del primer correo que te enviamos al eliminarla. Si fue un error, escribe ya a quien te atiende en Sales Smart.`
    : `Tu cliente <b>${org}</b> está eliminado y el <b>${until}</b> se borrarán todos sus datos de forma definitiva: después no se podrán recuperar. Si fue un error, escribe ya a quien te atiende en Sales Smart.`;
  const html = frame(
    headline,
    `<tr><td style="font-size:22px;font-weight:700;padding-bottom:8px;">${headline}</td></tr>
<tr><td style="font-size:14px;line-height:1.5;color:#3b3558;padding-bottom:8px;">${detail}</td></tr>`,
    'Aviso informativo de Sales Smart.',
  );
  const plain = owner
    ? `La cuenta de ${m.organizationName} está eliminada y el ${untilPlain} borraremos todos sus datos de forma definitiva: después no se podrán recuperar. Si necesitas una copia de tus datos, usa el enlace del primer correo que te enviamos al eliminarla. Si fue un error, escribe ya a quien te atiende en Sales Smart.`
    : `Tu cliente ${m.organizationName} está eliminado y el ${untilPlain} se borrarán todos sus datos de forma definitiva: después no se podrán recuperar. Si fue un error, escribe ya a quien te atiende en Sales Smart.`;
  return { subject: owner ? `Mañana borramos la cuenta de ${m.organizationName.slice(0, 60)}` : `Mañana se borra a tu cliente ${m.organizationName.slice(0, 60)}`, html, text: `${headline} — Sales Smart\n\n${plain}\n` };
}

/** Aviso de empresa recuperada (ADR-59 #14). */
export function companyRecoveredMail(m: CompanyRecoveredMail): MailContent {
  const org = esc(m.organizationName);
  const owner = m.audience === 'owner';
  const headline = owner ? 'Tu empresa fue recuperada' : 'Tu cliente fue recuperado';
  const detail = owner
    ? `La cuenta de <b>${org}</b> volvió a estar disponible, tal como estaba. Entra de nuevo con tu correo y tu contraseña: las sesiones anteriores se cerraron.`
    : `Tu cliente <b>${org}</b> volvió a estar disponible y recuperas el acceso que tenías.`;
  const html = frame(
    headline,
    `<tr><td style="font-size:22px;font-weight:700;padding-bottom:8px;">${headline}</td></tr>
<tr><td style="font-size:14px;line-height:1.5;color:#3b3558;padding-bottom:8px;">${detail}</td></tr>`,
    'Aviso informativo de Sales Smart.',
  );
  const plain = owner
    ? `La cuenta de ${m.organizationName} volvió a estar disponible, tal como estaba. Entra de nuevo con tu correo y tu contraseña: las sesiones anteriores se cerraron.`
    : `Tu cliente ${m.organizationName} volvió a estar disponible y recuperas el acceso que tenías.`;
  return { subject: owner ? `Recuperamos la cuenta de ${m.organizationName.slice(0, 60)}` : `Recuperaron a tu cliente ${m.organizationName.slice(0, 60)}`, html, text: `${headline} — Sales Smart\n\n${plain}\n` };
}

/** Aviso a quien administra las conexiones: Google Calendar necesita volver a conectarse (ADR-67). Solo se admite un enlace http(s) o ninguno. */
export function calendarReconnectMail(m: CalendarReconnectMail): MailContent {
  if (m.reconnectUrl !== null && !/^https?:\/\//i.test(m.reconnectUrl)) throw new Error('reconnectUrl debe ser http(s)');
  const org = esc(m.organizationName);
  const headline = 'Google Calendar necesita volver a conectarse';
  const detail = `Google dejó de aceptar la conexión del calendario de <b>${org}</b> (por ejemplo, porque se quitó el acceso o venció la autorización). Mientras tanto, las citas se siguen guardando en Sales Smart, pero no se envían a Google; al volver a conectar, las pendientes salen solas.`;
  const button = m.reconnectUrl
    ? `<tr><td align="center" style="padding:6px 0 14px;"><a href="${esc(m.reconnectUrl)}" style="display:inline-block;background:#6a44f2;color:#ffffff;text-decoration:none;font-weight:600;font-size:14px;border-radius:10px;padding:12px 22px;">Volver a conectar</a></td></tr>
<tr><td style="font-size:12px;line-height:1.5;color:#5f5a7a;word-break:break-all;">Si el botón no funciona, copia y pega este enlace en tu navegador:<br>${esc(m.reconnectUrl)}</td></tr>`
    : `<tr><td style="font-size:14px;line-height:1.5;color:#3b3558;">Entra a Sales Smart › Configuración › Google Calendar y pulsa «Conectar».</td></tr>`;
  const html = frame(
    headline,
    `<tr><td style="font-size:22px;font-weight:700;padding-bottom:8px;">${headline}</td></tr>
<tr><td style="font-size:14px;line-height:1.5;color:#3b3558;padding-bottom:12px;">${detail}</td></tr>
${button}`,
    'Recibes este aviso porque administras las conexiones de tu empresa en Sales Smart.',
  );
  const how = m.reconnectUrl ? `Vuelve a conectar aquí: ${m.reconnectUrl}` : 'Entra a Sales Smart > Configuración > Google Calendar y pulsa «Conectar».';
  const text = `${headline} — Sales Smart\n\nGoogle dejó de aceptar la conexión del calendario de ${m.organizationName} (por ejemplo, porque se quitó el acceso o venció la autorización). Mientras tanto, las citas se siguen guardando en Sales Smart, pero no se envían a Google; al volver a conectar, las pendientes salen solas.\n\n${how}\n\nRecibes este aviso porque administras las conexiones de tu empresa en Sales Smart.\n`;
  return { subject: `Reconecta Google Calendar en ${m.organizationName.slice(0, 60)}`, html, text };
}
