// DESCARTABLE — arnés mínimo común a ambos spikes
export const A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
export const B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
export const CONTACT_B = 'b0000000-0000-0000-0000-000000000001';
export type Result = { id: string; name: string; ok: boolean; detail: string };
export const results: Result[] = [];
export async function scenario(id: string, name: string, fn: () => Promise<string>) {
  try { const detail = await fn(); results.push({ id, name, ok: true, detail }); console.log(`PASS ${id} ${name} — ${detail}`); }
  catch (e: any) { results.push({ id, name, ok: false, detail: String(e?.message ?? e).split('\n').filter(Boolean)[0] }); console.log(`FAIL ${id} ${name} — ${String(e?.message ?? e).split('\n')[0]}`); }
}
export function eq(actual: unknown, expected: unknown, msg: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${msg}: esperado ${JSON.stringify(expected)}, obtenido ${JSON.stringify(actual)}`);
}
export async function expectError(p: Promise<unknown>, re: RegExp, msg: string) {
  try { await p; } catch (e: any) { if (re.test(String(e?.message ?? e) + String(e?.cause?.message ?? ''))) return String(e?.cause?.message ?? e.message).split('\n').map((l: string) => l.trim()).filter(Boolean).pop()!.slice(0, 90); throw new Error(`${msg}: error distinto: ${String(e?.message).slice(0,120)}`); }
  throw new Error(`${msg}: debía fallar y NO falló`);
}
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
