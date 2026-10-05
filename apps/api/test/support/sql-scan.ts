/** Escáner estático de SQL de migraciones: construcciones prohibidas por ADR-24. */
export interface SqlFinding {
  rule: string;
  excerpt: string;
}

const FORBIDDEN: Array<[string, RegExp]> = [
  ['P8 USING (true)', /\busing\s*\(\s*true\s*\)/i],
  ['P8 WITH CHECK (true)', /\bwith\s+check\s*\(\s*true\s*\)/i],
  ['P8 SECURITY DEFINER', /\bsecurity\s+definer\b/i],
  ['P8 BYPASSRLS', /\bbypassrls\b/i],
  ['P8 DISABLE RLS', /\bdisable\s+row\s+level\s+security\b/i],
  ['P8 NO FORCE RLS', /\bno\s+force\s+row\s+level\s+security\b/i],
  ['P1 sesión', /\bset\s+session\b|set_config\s*\([^)]*,\s*false\s*\)/i],
  ['P7 advisory de sesión', /pg_(try_)?advisory_lock/i],
  ['roles en migraciones', /\b(create|alter|drop)\s+role\b/i],
  ['GRANT a PUBLIC', /\bgrant\b[^;]*\bto\s+public\b/i],
  ['TRUNCATE a app roles', /\bgrant\b[^;]*\btruncate\b/i],
];

export function stripSqlComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * `identityTables`: tablas de identidad (ADR-25) que, aunque tengan organization_id (p. ej. organization_members),
 * NO llevan RLS por organización; su acceso se restringe por GRANT a app_identity y lo verifica el audit.
 */
export function scanMigrationSql(sqlText: string, allowedDefiners: readonly string[] = [], identityTables: readonly string[] = []): SqlFinding[] {
  const sql = stripSqlComments(sqlText);
  const out: SqlFinding[] = [];
  for (const [rule, re] of FORBIDDEN) {
    const m = re.exec(sql);
    if (m) {
      if (rule === 'P8 SECURITY DEFINER' && allowedDefiners.length > 0) continue;
      out.push({ rule, excerpt: m[0] });
    }
  }
  // Toda tabla con organization_id debe declarar FORCE RLS + una política
  for (const m of sql.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?(?:"?public"?\.)?"?(\w+)"?\s*\(([\s\S]*?)\);/gi)) {
    const [, table, body] = m;
    if (table && body && !identityTables.includes(table) && /\borganization_id\b/i.test(body)) {
      const t = new RegExp(`"?${table}"?`, 'i').source;
      if (!new RegExp(`alter\\s+table\\s+(?:"?public"?\\.)?${t}\\s+force\\s+row\\s+level\\s+security`, 'i').test(sql)) out.push({ rule: 'tabla tenant sin FORCE RLS', excerpt: table });
      if (!new RegExp(`create\\s+policy\\s+[^;]*\\bon\\s+(?:"?public"?\\.)?${t}\\b`, 'i').test(sql)) out.push({ rule: 'tabla tenant sin política', excerpt: table });
    }
  }
  return out;
}
