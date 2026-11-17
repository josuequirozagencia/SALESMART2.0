export { CampaignsModule } from './campaigns.module';
export { CampaignsService, type CampaignAccess, type CampaignView, type CampaignList, type AudiencePreview, type CampaignOptions } from './campaigns.service';
export { CampaignSenderService, MAX_IN_FLIGHT, PAUSING_ERRORS } from './campaign-sender.service';
export { CampaignSenderJob } from './campaign-sender.job';
export { classify, effectiveDailyCap, estimate, type AudienceSkip, type Classified } from './audience';
export { CampaignResultsService, type ResultsView, type RecipientView, type ResultsSummary, type CampaignsSummaryView } from './campaign-results.service';
export { CampaignResponsesService, REPLY_WINDOW_HOURS, OPT_OUT_NOTE } from './campaign-responses.service';
export { isOptOutText, normalizeOptOut } from './campaign-optout';
