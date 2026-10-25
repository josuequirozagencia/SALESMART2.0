export { TagsModule } from './tags.module';
export { SystemTagsService, SYSTEM_TAGS, type SystemTagKey, type TagView } from './system-tags.service';
export { ContactTaggingService } from './contact-tagging.service';
export { tagIdsSchema } from './tags.dto';
export { TagChangeBus, type TagChange, type TagChangeListener, type TagChangeOrigin, type TagDeleted, type TagDeletedListener } from './tag-change.bus';
