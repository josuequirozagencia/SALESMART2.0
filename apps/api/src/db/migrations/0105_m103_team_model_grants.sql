-- M10.3 (ADR-56): ajustes de permisos por persona y historia del equipo. Ambas son tablas de IDENTIDAD (solo app_identity).
-- member_permissions: un ajuste reemplazado se marca revocado (UPDATE); sin DELETE, como el resto de la identidad (ADR-35). member_history es APPEND-ONLY: solo SELECT/INSERT.
REVOKE ALL ON TABLE "member_permissions", "member_history" FROM PUBLIC, "app_rw", "app_platform";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "member_permissions" TO "app_identity";--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "member_history" TO "app_identity";--> statement-breakpoint
-- `team.manage` (sin uso hasta hoy) pasa a llamarse `users.manage`: el administrador lo conserva y NO es otorgable a un asesor (ADR-56 B3 #6).
INSERT INTO "permissions" ("key", "scope", "description") VALUES ('users.manage', 'tenant', 'users.manage') ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint
INSERT INTO "role_permissions" ("role_key", "permission_key") SELECT "role_key", 'users.manage' FROM "role_permissions" WHERE "permission_key" = 'team.manage' AND NOT EXISTS (SELECT 1 FROM "role_permissions" r2 WHERE r2."role_key" = "role_permissions"."role_key" AND r2."permission_key" = 'users.manage');--> statement-breakpoint
DELETE FROM "role_permissions" WHERE "permission_key" = 'team.manage';--> statement-breakpoint
DELETE FROM "permissions" WHERE "key" = 'team.manage';
