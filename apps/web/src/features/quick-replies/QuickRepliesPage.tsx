import { SettingsNav } from '../app/SettingsNav';
import { QuickRepliesPanel } from './QuickRepliesPanel';

/** Configuración › Respuestas rápidas (M5.6b, ADR-50): las del administrador y las que comparte con toda la empresa. Quien responde las maneja desde el Inbox. */
export function QuickRepliesPage() {
  return (
    <div className="grid gap-4">
      <SettingsNav />
      <QuickRepliesPanel />
    </div>
  );
}
