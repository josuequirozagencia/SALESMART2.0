import { Module } from '@nestjs/common';
import type { AppConfig } from '../../config';
import { APP_CONFIG } from '../../tokens';
import { FakePushSender } from './push.fake';
import { PUSH_SENDER, type PushSender } from './push.port';
import { PushController } from './push.controller';
import { PushService } from './push.service';
import { WebPushSender } from './webpush.sender';

/** Sin adaptador (push apagado o sin claves) se usa uno que no envía nada: `PushService` ya corta antes con `config.push.enabled`. */
const OFF: PushSender = { name: 'fake', send: () => Promise.resolve('failed') };

/** Notificaciones push del navegador (v6 fase E, ADR-64). */
@Module({
  controllers: [PushController],
  providers: [
    PushService,
    {
      provide: PUSH_SENDER,
      useFactory: (cfg: AppConfig): PushSender => {
        if (cfg.push.provider === 'fake') return new FakePushSender();
        if (cfg.push.enabled && cfg.push.vapidPublicKey && cfg.push.vapidPrivateKey && cfg.push.vapidSubject) return new WebPushSender(cfg.push.vapidSubject, cfg.push.vapidPublicKey, cfg.push.vapidPrivateKey);
        return OFF;
      },
      inject: [APP_CONFIG],
    },
  ],
  exports: [PushService, PUSH_SENDER],
})
export class PushModule {}
