-- M1.5 (ADR-25, ADR-33): trials y trial_config son tablas de identidad. Solo app_identity: trials SELECT/INSERT/UPDATE (sin DELETE),
-- trial_config SOLO SELECT (se cambia por migración o con el rol propietario; no hay endpoint de edición todavía).
REVOKE ALL ON TABLE "trials", "trial_config" FROM PUBLIC, "app_rw", "app_platform";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "trials" TO "app_identity";--> statement-breakpoint
GRANT SELECT ON TABLE "trial_config" TO "app_identity";--> statement-breakpoint
-- Valores PROVISIONALES (Build Spec §15 #8): prueba 7 días, extensión 3, retención 30, 1000 créditos de bienvenida (cifra de ejemplo).
INSERT INTO "trial_config" ("id", "days", "extension_days", "retention_days", "welcome_credits") VALUES (true, 7, 3, 30, 1000);--> statement-breakpoint
-- Transiciones de la extensión: una sola por cuenta. El CHECK trials_ext_consistent valida el ESTADO; este trigger valida el CAMBIO.
CREATE FUNCTION "trials_ext_transition"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id
     OR NEW.started_at IS DISTINCT FROM OLD.started_at THEN
    RAISE EXCEPTION 'trials: organization_id, owner_user_id y started_at son inmutables' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.ext_status IS DISTINCT FROM OLD.ext_status THEN
    IF NOT ((OLD.ext_status = 'none' AND NEW.ext_status = 'pending')
         OR (OLD.ext_status = 'pending' AND NEW.ext_status IN ('approved', 'denied'))) THEN
      RAISE EXCEPTION 'trials: transición de extensión no permitida (% -> %)', OLD.ext_status, NEW.ext_status USING ERRCODE = 'check_violation';
    END IF;
  ELSIF (NEW.ext_reason, NEW.ext_requested_at, NEW.ext_decided_by, NEW.ext_decided_at, NEW.ext_days_granted)
        IS DISTINCT FROM (OLD.ext_reason, OLD.ext_requested_at, OLD.ext_decided_by, OLD.ext_decided_at, OLD.ext_days_granted) THEN
    RAISE EXCEPTION 'trials: los datos de la extensión no se modifican sin cambiar de estado' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER "trials_ext_transition" BEFORE UPDATE ON "trials" FOR EACH ROW EXECUTE FUNCTION "trials_ext_transition"();
