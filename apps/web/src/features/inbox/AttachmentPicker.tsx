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

export function AttachmentPicker({ conversationId, onClose, onPicked }: { conversationId: string; onClose: () => void; onPicked: (a: PickedAttachment) => void }) {
  const upload = useUploadAttachment(conversationId);
  const inputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string>();
  const [recording, setRecording] = useState(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

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

  const startRecording = async (): Promise<void> => {
    setError(undefined);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream, { mimeType: MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm' });
      chunksRef.current = [];
      rec.ondataavailable = (ev) => { if (ev.data.size > 0) chunksRef.current.push(ev.data); };
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunksRef.current, { type: rec.mimeType });
        const file = new File([blob], 'grabacion.webm', { type: blob.type });
        await doUpload(file);
      };
      recorderRef.current = rec;
      rec.start();
      setRecording(true);
    } catch {
      setError('No pudimos acceder al micrófono. Revisa los permisos del navegador.');
    }
  };

  const stopRecording = (): void => {
    recorderRef.current?.stop();
    setRecording(false);
  };

  return (
    <Modal title="Adjuntar archivo" onClose={onClose}>
      <p className="text-[13px] text-muted">Elige un archivo (imagen, video, audio, documento) o graba un audio. Tamaño máximo: 25 MB (documento), 16 MB (video/audio), 5 MB (imagen).</p>
      <Field label="Archivo">
        {(p) => <input {...p} ref={inputRef} type="file" accept="image/jpeg,image/png,video/mp4,video/3gpp,audio/*,application/pdf,application/msword,application/vnd.ms-excel,application/vnd.ms-powerpoint,application/vnd.openxmlformats-officedocument.*,text/plain,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt" onChange={onFile} disabled={upload.isPending || recording} />}
      </Field>
      <div className="flex gap-2">
        {!recording ? <Button disabled={upload.isPending} onClick={startRecording}>Grabar audio</Button> : <Button variant="primary" onClick={stopRecording}>Detener y subir</Button>}
        <Button disabled={upload.isPending} onClick={() => inputRef.current?.click()}>Elegir archivo</Button>
      </div>
      {upload.isPending ? <p className="text-[12.5px] text-muted">Subiendo…</p> : null}
      {error ? <Alert>{error}</Alert> : null}
      <div className="flex justify-end gap-2">
        <Button onClick={onClose}>Cerrar</Button>
      </div>
    </Modal>
  );
}
