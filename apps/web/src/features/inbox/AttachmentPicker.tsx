import { useRef, useState } from 'react';
import { friendlyError } from '../../lib/errors';
import { Alert, Button, Field } from '../../ui/controls';
import { Modal } from '../../ui/Modal';
import { useUploadAttachment } from './useInbox';

interface PickedAttachment {
  id: string;
  filename: string | null;
  kind: string;
  mime_type: string;
}

/** Elegir un archivo para adjuntar. Las notas de voz se graban directo desde el redactor (botón del micrófono), ya no aquí. */
export function AttachmentPicker({ conversationId, onClose, onPicked }: { conversationId: string; onClose: () => void; onPicked: (a: PickedAttachment) => void }) {
  const upload = useUploadAttachment(conversationId);
  const inputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string>();

  const doUpload = async (file: File): Promise<void> => {
    setError(undefined);
    try {
      const picked = await upload.mutateAsync(file);
      onPicked({ id: picked.id, filename: picked.filename, kind: picked.kind, mime_type: picked.mime_type } as PickedAttachment);
    } catch (e) {
      setError(friendlyError(e, 'No pudimos subir el archivo.'));
    }
  };

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const f = e.target.files?.[0];
    if (f) await doUpload(f);
  };

  return (
    <Modal title="Adjuntar archivo" onClose={onClose}>
      <p className="text-[13px] text-muted">Elige un archivo (imagen, video, audio, documento). Tamaño máximo: 25 MB (documento), 16 MB (video/audio), 5 MB (imagen). Para una nota de voz usa el botón del micrófono.</p>
      <Field label="Archivo">
        {(p) => <input {...p} ref={inputRef} type="file" accept="image/jpeg,image/png,video/mp4,video/3gpp,audio/*,application/pdf,application/msword,application/vnd.ms-excel,application/vnd.ms-powerpoint,application/vnd.openxmlformats-officedocument.*,text/plain,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt" onChange={onFile} disabled={upload.isPending} />}
      </Field>
      {upload.isPending ? <p className="text-[12.5px] text-muted">Subiendo…</p> : null}
      {error ? <Alert>{error}</Alert> : null}
      <div className="flex justify-end gap-2">
        <Button onClick={onClose}>Cerrar</Button>
      </div>
    </Modal>
  );
}
