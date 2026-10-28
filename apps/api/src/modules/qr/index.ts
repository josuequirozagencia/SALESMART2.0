export { QrModule } from './qr.module';
export { QrHeartbeatJob } from './qr-heartbeat.job';
export { QrOutboundService, type QrDispatch } from './qr-outbound.service';
export { QrConnectionsService, MAX_QR_CHANNELS, type QrChannelView, type QrList } from './qr-connections.service';
export { QR_SESSION, QrSessionError, isRetryableQr, type QrSessionProvider, type QrCredentials, type QrErrorCode } from './qr-session.port';
export { FakeQrSession, FAKE_QR_KEY } from './qr-session.fake';
export { EvolutionProvider } from './evolution.provider';
export { dailyLimit, sendGate, warmupDay, MIN_GAP_MS } from './qr-limits';
