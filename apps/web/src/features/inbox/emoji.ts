/**
 * Emojis del redactor y de las reacciones (M5.8). Lista propia y corta, sin dependencias: cada uno lleva su nombre en español para poder buscarlo.
 * Los «recientes» se guardan solo en el navegador de la persona (comodidad: si no se puede guardar, simplemente no hay recientes).
 */
export interface EmojiItem { e: string; n: string }
export interface EmojiGroup { id: string; label: string; items: EmojiItem[] }

const g = (id: string, label: string, raw: string): EmojiGroup => ({
  id,
  label,
  items: raw.split('|').map((p) => {
    const i = p.indexOf(' ');
    return { e: p.slice(0, i), n: p.slice(i + 1) };
  }),
});

export const EMOJI_GROUPS: EmojiGroup[] = [
  g('caras', 'Caras', '😀 sonrisa feliz|😃 sonrisa grande|😄 alegre|😁 radiante|😆 risa|😅 risa nerviosa sudor|😂 llorar de risa|🤣 carcajada|🙂 sonrisa leve|🙃 al revés|😉 guiño|😊 sonrojado contento|😇 angelito|🥰 enamorado corazones|😍 ojos de corazón|🤩 asombrado estrellas|😘 beso|😗 besito|😋 rico delicioso|😛 lengua|😜 lengua guiño|🤪 loco|😎 genial gafas|🤓 nerd|🥳 fiesta celebrar|😏 pícaro|😒 fastidiado|😞 triste|😔 pensativo|😟 preocupado|😕 confundido|🙁 ceño fruncido|☹️ triste|😣 sufrido|😖 agobiado|😫 cansado|😩 agotado|🥺 suplicante|😢 llorar|😭 llanto|😤 resoplido|😠 enojado|😡 furioso|🤬 insultos|🤯 mente explotando|😳 sonrojo sorpresa|🥵 calor|🥶 frío|😱 grito miedo|😨 miedo|😰 ansiedad|😥 alivio|😓 sudor frío|🤗 abrazo|🤔 pensando|🤭 risa tapada|🤫 silencio|🤥 mentiroso|😶 sin boca|😐 neutral|😑 inexpresivo|😬 mueca|🙄 ojos en blanco|😯 sorprendido|😦 consternado|😧 angustiado|😮 boca abierta|😲 asombro|🥱 bostezo|😴 dormido|🤤 babeando|😪 sueño|😵 mareado|🤐 boca cerrada|🥴 aturdido|🤢 náuseas|🤮 vómito|🤧 estornudo|😷 mascarilla|🤒 fiebre|🤕 herido|🤑 dinero|🤠 vaquero|😈 diablillo|👻 fantasma|💀 calavera|🤖 robot'),
  g('gestos', 'Gestos', '👍 me gusta pulgar arriba bien|👎 pulgar abajo|👌 ok perfecto|✌️ paz victoria|🤞 dedos cruzados suerte|🤟 te quiero|🤘 rock|🤙 llámame|👈 izquierda|👉 derecha|👆 arriba|👇 abajo|☝️ uno|✋ mano alto|🤚 palma|🖐️ mano abierta|🖖 vulcano|👋 saludo hola adiós|🤝 trato acuerdo apretón|🙏 gracias por favor rezar|👏 aplausos|🙌 celebrar manos arriba|👐 manos abiertas|🤲 manos juntas|💪 fuerza músculo|🙋 levantar la mano|🤷 no sé|🤦 error facepalm|🙇 reverencia|💁 informar|🙅 no|🙆 sí ok|👀 ojos mirar|🧠 cerebro|🫶 corazón con manos'),
  g('simbolos', 'Símbolos', '❤️ corazón rojo amor|🧡 corazón naranja|💛 corazón amarillo|💚 corazón verde|💙 corazón azul|💜 corazón morado|🖤 corazón negro|🤍 corazón blanco|💔 corazón roto|💕 dos corazones|💖 corazón brillante|💯 cien perfecto|✅ listo hecho check|✔️ visto|❌ equis no|❗ exclamación|❓ pregunta|⚠️ advertencia|🔥 fuego|⭐ estrella|🌟 estrella brillante|✨ destellos|⚡ rayo|💥 explosión|💫 mareo estrellas|🎉 fiesta confeti|🎊 celebración|🎁 regalo|🏆 trofeo|🥇 medalla oro|🎯 objetivo diana|📌 chincheta|📍 ubicación|🔔 campana|📣 megáfono|💡 idea|🔒 candado|🔑 llave|🆕 nuevo|🆗 ok|🔝 arriba|➡️ flecha derecha|⬅️ flecha izquierda'),
  g('objetos', 'Objetos', '📞 teléfono|📱 celular móvil|💬 chat mensaje|🗨️ globo|✉️ correo sobre|📧 email|📅 calendario fecha|📆 agenda|🕐 reloj hora|⏰ alarma|⏳ tiempo reloj de arena|📝 nota escribir|📋 portapapeles lista|📎 clip adjunto|📁 carpeta|📊 gráfico barras|📈 gráfico subiendo crecimiento|📉 gráfico bajando|💰 dinero bolsa|💵 billete dólar|💳 tarjeta|🧾 recibo factura|🛒 carrito compras|🛍️ bolsas compras|📦 paquete|🚚 camión envío|🏠 casa|🏢 oficina edificio|🚗 auto|✈️ avión|💻 computadora laptop|🖥️ escritorio|🎧 audífonos|📷 cámara|🎥 video|🔍 buscar lupa|🔧 herramienta llave|⚙️ ajustes engranaje|💼 maletín trabajo|🎓 graduación'),
  g('comida', 'Comida y naturaleza', '☕ café|🍵 té|🍺 cerveza|🍷 vino|🥂 brindis|🍕 pizza|🍔 hamburguesa|🍟 papas fritas|🌮 taco|🍰 pastel|🍎 manzana|🍌 plátano|🍓 fresa|🥑 aguacate|🌹 rosa|🌸 flor|🌞 sol|🌙 luna|⭐ estrella|☀️ soleado|⛅ nublado|🌧️ lluvia|🌈 arcoíris|🐶 perro|🐱 gato|🦁 león'),
];

const RECENT_KEY = 'ss.emoji.recent';
const MAX_RECENT = 16;

/** Los emojis usados hace poco (los más recientes primero); vacío si el navegador no deja guardarlos. */
export function readRecentEmojis(): string[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, MAX_RECENT) : [];
  } catch {
    return [];
  }
}

export function rememberEmoji(e: string): string[] {
  const next = [e, ...readRecentEmojis().filter((x) => x !== e)].slice(0, MAX_RECENT);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    /* sin almacenamiento: no hay recientes y no pasa nada */
  }
  return next;
}

const fold = (s: string): string => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Los emojis cuyo nombre contiene lo buscado (sin importar acentos ni mayúsculas); sin repetir. */
export function searchEmojis(query: string): EmojiItem[] {
  const q = fold(query.trim());
  if (!q) return [];
  const seen = new Set<string>();
  const out: EmojiItem[] = [];
  for (const grp of EMOJI_GROUPS) for (const it of grp.items) if (!seen.has(it.e) && fold(it.n).includes(q)) { seen.add(it.e); out.push(it); }
  return out;
}

/** Las seis reacciones rápidas del menú de la burbuja. */
export const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏'] as const;
