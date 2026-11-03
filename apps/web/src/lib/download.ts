/**
 * Inicia la descarga de una URL firmada del almacenamiento. Se usa un enlace temporal en lugar de `fetch`: el archivo puede pesar cientos de megabytes y debe bajar directo al disco, sin pasar por la
 * memoria de la página, y el almacenamiento ya lo marca como adjunto (`Content-Disposition`), así que la página no se cierra.
 */
export function startDownload(url: string, filename: string): void {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener noreferrer';
  document.body.appendChild(a);
  a.click();
  a.remove();
}
