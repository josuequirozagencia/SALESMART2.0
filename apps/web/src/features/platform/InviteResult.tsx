import { useState } from 'react';
import type { InvitationIssued } from '../../lib/types';
import { Alert, Button } from '../../ui/controls';

const longDate = (iso: string): string => new Date(iso).toLocaleDateString('es-EC', { day: '2-digit', month: '2-digit', year: 'numeric' });

/**
 * Resultado del envío de una invitación. Con `sent` el enlace NO viaja (solo en el correo). Si el correo no salió, el servidor devuelve el
 * enlace al Súper Admin (ADR-39): aquí se muestra para copiarlo y entregarlo por otro medio (WhatsApp, etc.). Es de un solo uso.
 */
export function InviteResult({ invitation }: { invitation: InvitationIssued }) {
  const [copied, setCopied] = useState<'ok' | 'fail'>();
  const url = invitation.invite_url;

  async function copy() {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied('ok');
    } catch {
      setCopied('fail'); // sin permiso de portapapeles: el campo de texto permite copiarlo a mano
    }
  }

  if (invitation.delivery === 'sent') {
    return <Alert kind="ok">Enviamos la invitación a <b>{invitation.email}</b>. El enlace vence el {longDate(invitation.expires_at)} y funciona una sola vez.</Alert>;
  }
  return (
    <div className="grid gap-2">
      <Alert kind="info">
        {invitation.delivery === 'unavailable' ? 'El envío de correos no está configurado todavía.' : 'No pudimos enviar el correo.'} Entrega este enlace a <b>{invitation.email}</b> por otro medio: funciona una sola vez y vence el {longDate(invitation.expires_at)}.
      </Alert>
      {url ? (
        <>
          <label htmlFor="invite-url" className="text-[12.5px] font-semibold">Enlace de invitación</label>
          <input id="invite-url" readOnly value={url} onFocus={(e) => e.currentTarget.select()} className="w-full rounded-[10px] border border-line bg-surface px-3 py-[11px] font-mono text-[12px]" />
          <div className="flex items-center gap-3">
            <Button onClick={() => void copy()}>Copiar enlace</Button>
            {copied === 'ok' ? <span role="status" className="text-[12.5px] text-ok">Copiado</span> : null}
            {copied === 'fail' ? <span role="status" className="text-[12.5px] text-muted">Selecciónalo y cópialo a mano</span> : null}
          </div>
          <p className="text-[12px] text-muted">Trátalo como una contraseña: quien lo tenga puede aceptar la invitación. Si lo pierdes, usa «Reenviar invitación» (el enlace anterior deja de valer).</p>
        </>
      ) : null}
    </div>
  );
}
