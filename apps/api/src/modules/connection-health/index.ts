export { ConnectionHealthModule } from './connection-health.module';
export { ConnectionHealthService, type ConnectionHealthView, type HealthList, type FailedEventView, type ConnectionKind } from './connection-health.service';
export { ConnectionHealthJob } from './connection-health.job';
export { judge, alertReasons, describeError, ALERT_TEXT, ALERT_REASONS, LAG_WARN_S, LAG_CRIT_S, MIN_LAG_SAMPLES, BACKLOG_S, SILENT_HOURS, type HealthFacts, type HealthVerdict, type HealthLevel, type HealthReason, type AlertReason } from './health-model';
