import { useState } from 'react';
import { Icon } from '../../ui/Icon';
import { mapLink, mapTiles, validPlace, type Place } from '../../lib/osm';

const W = 260;
const H = 150;
const ZOOM = 16;

/**
 * La ubicación de un mensaje como en WhatsApp (v13 S3.2): miniatura de mapa con un pin al centro y debajo el nombre y la dirección; tocarla abre el mapa (OpenStreetMap) en otra pestaña.
 * La miniatura son baldosas de OpenStreetMap que carga el navegador, con la atribución visible; si alguna falla —sin red, bloqueo, límite del servidor de baldosas— se cambia por una tarjeta
 * neutra con el pin, y la ubicación sigue siendo útil (el enlace funciona). Las baldosas llevan `referrerPolicy="origin"`: la política de uso de OSM pide un Referer válido y la de la
 * aplicación es no enviar ninguno. Nada de esto toca el servidor de la aplicación: las coordenadas no pasan por nuestros registros.
 */
export function LocationCard({ place, name, address }: { place: Place; name: string | null; address: string | null }) {
  const [failed, setFailed] = useState(false);
  if (!validPlace(place)) return null;
  const label = [name, address].filter((x): x is string => !!x).join(' · ');
  const tiles = failed ? [] : mapTiles(place, ZOOM, W, H);
  return (
    <span className="mt-1 grid w-[260px] max-w-full gap-1">
      <a
        href={mapLink(place, ZOOM)}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={`Abrir la ubicación en el mapa${label ? `: ${label}` : ''}`}
        className="relative block overflow-hidden rounded-lg border border-line bg-surface2 text-fg no-underline"
        style={{ height: H }}
      >
        {failed ? (
          <span className="grid h-full place-items-center gap-1 text-center text-[12.5px] text-muted"><span><Icon name="pin" size={28} className="mx-auto text-crit" /><span className="mt-1 block">Ver en el mapa</span></span></span>
        ) : (
          <>
            {tiles.map((t) => (
              <img key={t.url} src={t.url} alt="" width={256} height={256} draggable={false} loading="lazy" referrerPolicy="origin" onError={() => setFailed(true)} className="absolute max-w-none select-none" style={{ left: t.left, top: t.top }} />
            ))}
            <Icon name="pin" size={30} strokeWidth={2.2} className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-full text-crit drop-shadow [fill:var(--surface)]" />
          </>
        )}
      </a>
      {label ? <span className="block break-words text-[13px]">{label}</span> : null}
      {!failed ? <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer" className="justify-self-end text-[10.5px] text-muted underline">© colaboradores de OpenStreetMap</a> : null}
    </span>
  );
}
