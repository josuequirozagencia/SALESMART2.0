export { AttributionModule } from './attribution.module';
export { AttributionService, DEFAULT_GRACE_MS, MAX_GRACE_MS, phoneHash, type RecordResult } from './attribution.service';
export { CapiSenderService, CAPI_BATCH, CAPI_MAX_ATTEMPTS, CAPI_MAX_AGE_MS } from './capi-sender.service';
export { CapiSenderJob } from './capi-sender.job';
export { FakeCapiProvider } from './capi.fake';
export { CAPI_PROVIDER, CapiSendError, NoCapiProvider, type CapiEvent, type CapiEventType, type CapiProvider } from './capi.ports';
