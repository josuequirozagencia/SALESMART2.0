/**
 * Imagen propia para el fondo del chat (v6 fase F): se lee en el navegador, se reduce a un máximo de 1280 px de lado y se guarda como JPEG (≈ 100–400 KB). Nunca sale del navegador: no hay
 * subida al servidor. Rechaza lo que no sea JPEG, PNG o WebP, lo mayor de 8 MB y lo que el navegador no pueda leer.
 */
export const MAX_ORIGINAL_BYTES = 8 * 1024 * 1024;
const MAX_SIDE = 1280;

export async function fileToChatBackground(file: File): Promise<string> {
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) throw new Error('La imagen debe ser JPEG, PNG o WebP.');
  if (file.size > MAX_ORIGINAL_BYTES) throw new Error('La imagen pesa demasiado: el máximo es 8 MB.');
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('No pudimos leer la imagen.'));
      i.src = url;
    });
    const scale = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Este navegador no puede preparar la imagen.');
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.78);
  } finally {
    URL.revokeObjectURL(url);
  }
}
