-- Seed por app_owner con FORCE RLS: se fija el contexto por organización
BEGIN; SELECT set_config('app.org_id','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',true);
INSERT INTO organizations VALUES ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','Empresa A');
INSERT INTO contacts(id,organization_id,name) VALUES ('a0000000-0000-0000-0000-000000000001','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','Ana (A)'),('a0000000-0000-0000-0000-000000000002','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','Alberto (A)');
INSERT INTO deals(organization_id,contact_id,amount) VALUES ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','a0000000-0000-0000-0000-000000000001',100);
COMMIT;
BEGIN; SELECT set_config('app.org_id','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',true);
INSERT INTO organizations VALUES ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','Empresa B');
INSERT INTO contacts(id,organization_id,name) VALUES ('b0000000-0000-0000-0000-000000000001','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','Beto (B)');
INSERT INTO deals(organization_id,contact_id,amount) VALUES ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','b0000000-0000-0000-0000-000000000001',999);
COMMIT;
