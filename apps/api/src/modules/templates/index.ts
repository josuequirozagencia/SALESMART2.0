export { TemplatesModule } from './templates.module';
export { TemplatesService, STALE_MS, type TemplateView, type TemplateList, type SyncSummary } from './templates.service';
export { TemplatesSyncJob } from './templates-sync.job';
export { analyze, checkValue, prepare, renderedText, variablesOf, keysIn, type Analysis, type Prepared, type RenderedTemplate, type TemplateVariable, type VariablePart } from './template-model';
