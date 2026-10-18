export { ChannelsModule } from './channels.module';
export { WHATSAPP_PROVIDER, WhatsAppProviderError, type WhatsAppProvider, type WhatsAppCredentials, type NumberInfo, type NormalizedMessage, type MessageKind } from './whatsapp.port';
export { FakeWhatsAppProvider, FAKE_WHATSAPP_TOKEN, FAKE_UNKNOWN_PREFIX, FAKE_UNAVAILABLE_ID } from './whatsapp.fake';
export { MetaCloudProvider, type MetaCloudOptions } from './meta-cloud.provider';
export type { ChannelView } from './connections.service';
