import { Module } from '@nestjs/common';
import { RealtimeModule } from '../realtime';
import type { AppConfig } from '../../config';
import { WEB_MEDIA_ORIGINS } from '../../http';
import { APP_CONFIG } from '../../tokens';
import { ChannelsModule } from '../channels';
import { OrganizationsModule } from '../organizations';
import { PlatformModule } from '../platform';
import { AttachmentsJob } from './attachments.job';
import { AttachmentsService } from './attachments.service';
import { InboundMediaService } from './inbound-media.service';
import { ClamAvScanner, FakeScanner, NoScanner, VIRUS_SCANNER, type VirusScanner } from './scanner';
import { StorageGateway } from './storage.gateway';
import { AUDIO_TRANSCODER, FakeTranscoder, FfmpegTranscoder, NoTranscoder, type AudioTranscoder } from './transcoder';

/** El antivirus que dice la configuración. */
export function buildScanner(cfg: AppConfig): VirusScanner {
  const a = cfg.attachments;
  if (a.virusScanner === 'clamav') return new ClamAvScanner(a.clamavHost ?? 'localhost', a.clamavPort);
  return a.virusScanner === 'fake' ? new FakeScanner() : new NoScanner();
}

/** El conversor de audio que dice la configuración. */
export function buildTranscoder(cfg: AppConfig): AudioTranscoder {
  const a = cfg.attachments;
  if (a.audioTranscoder === 'ffmpeg') return new FfmpegTranscoder(a.ffmpegPath);
  return a.audioTranscoder === 'fake' ? new FakeTranscoder() : new NoTranscoder();
}

/**
 * Archivos adjuntos (M5.6d, ADR-50): almacenamiento privado con URL firmada, antivirus, conversión de audio y la descarga de lo que mandan los clientes. Las piezas que hablan con el
 * mundo (almacenamiento, antivirus, conversor) son adaptadores elegidos por configuración. Lo que depende de las conversaciones (subir, enviar, entregar) vive en `inbox`.
 */
@Module({
  imports: [ChannelsModule, OrganizationsModule, PlatformModule, RealtimeModule],
  providers: [
    StorageGateway,
    AttachmentsService,
    InboundMediaService,
    AttachmentsJob,
    { provide: VIRUS_SCANNER, useFactory: buildScanner, inject: [APP_CONFIG] },
    { provide: AUDIO_TRANSCODER, useFactory: buildTranscoder, inject: [APP_CONFIG] },
    // La web necesita permitir (CSP) el origen desde donde se leen los archivos; lo busca `HttpModule` por este token
    { provide: WEB_MEDIA_ORIGINS, useFactory: (storage: StorageGateway) => () => storage.mediaOrigins(), inject: [StorageGateway] },
  ],
  exports: [AttachmentsService, StorageGateway, InboundMediaService, AttachmentsJob, VIRUS_SCANNER, AUDIO_TRANSCODER],
})
export class AttachmentsModule {}
