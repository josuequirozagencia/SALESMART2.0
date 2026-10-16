// E2E del flujo de acceso (ADR-23) en un navegador real contra la API y la web COMPILADAS.
import { expect, test } from '@playwright/test';
import { adminToken, apiLogin, createAccount, decide, expireTrialOf, hasAgencyAccess, mailMark, nextMail, pendingTrialItemOf, pendingTrialOf, requestExtensionViaApi, trialOf, PASSWORD, state, uiLogin, uniqueEmail } from './support';

const REASON = 'Aún estoy conectando mi WhatsApp y probando los agentes';

test('ADR-23 completo: registro → verificación → prueba → extensión → aprobación → vence → pantalla de vencida; una sola extensión', async ({ page, request }) => {
  const email = uniqueEmail('adr23');
  const { apiBase } = state();

  // Registro por la interfaz
  await page.goto('/signup');
  await page.getByLabel('Nombre completo').fill('Ana E2E');
  await page.getByLabel('Empresa').fill('Mi Empresa E2E');
  await page.getByLabel('WhatsApp').fill('098 421 7730');
  await page.getByLabel('Correo de trabajo').fill(email);
  await page.getByLabel('Contraseña', { exact: true }).fill(PASSWORD);
  await page.getByRole('checkbox').check();
  const since = mailMark();
  await page.getByRole('button', { name: /Crear cuenta y empezar/ }).click();

  // Verificación: el código llega por el «correo» fake; la prueba empieza AQUÍ, no antes
  await expect(page.getByRole('heading', { name: 'Verifica tu correo' })).toBeVisible();
  const { code } = await nextMail('verificación', since);
  await page.getByLabel('Código').fill(code ?? '');
  await page.getByRole('button', { name: 'Verificar y entrar' }).click();

  // Entra solo y ve su prueba con acceso a todo
  await expect(page.getByRole('heading', { name: 'Hola, Mi Empresa E2E' })).toBeVisible();
  await expect(page.getByText(/Ana E2E · Administrador/)).toBeVisible();
  const banner = page.getByRole('region', { name: 'Prueba gratuita' });
  await expect(banner).toContainText(/te quedan (6|7) días/);

  // Pide la extensión (única)
  await banner.getByRole('button', { name: 'Pedir una extensión' }).click();
  const dlg = page.getByRole('dialog', { name: 'Pedir 3 días más' });
  await dlg.getByLabel('¿Para qué necesitas más tiempo?').fill(REASON);
  await dlg.getByRole('button', { name: 'Enviar solicitud' }).click();
  await expect(banner).toContainText('Tu solicitud de extensión está en revisión');
  await expect(banner.getByRole('button', { name: 'Pedir una extensión' })).toHaveCount(0);

  // El Súper Admin la ve y la aprueba (la consola llega en M2: aquí por la API)
  const item = await pendingTrialItemOf(request, email);
  expect(item).toMatchObject({ owner_name: 'Ana E2E', owner_phone: '+593984217730' }); // el perfil del registro llega a la lista del Súper Admin
  await decide(request, item.id, 'approve');

  // Recargar conserva la sesión (cookie de refresh) y refleja la aprobación
  await page.reload();
  await expect(page.getByRole('region', { name: 'Prueba gratuita' })).toContainText('Extensión aprobada (+3 días)');
  await expect(page.getByRole('region', { name: 'Prueba gratuita' })).toContainText(/te quedan (9|10) días/);

  // Una segunda solicitud se rechaza en el servidor
  const token = await apiLogin(request, email);
  const second = await request.post(`${apiBase}/v1/trials/me/extension`, { headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, data: { reason: REASON } });
  expect(second.status()).toBe(409);
  expect(((await second.json()) as { error: { code: string } }).error.code).toBe('EXTENSION_ALREADY_USED');

  // Pasa el tiempo: la cuenta queda en pausa y la pantalla de «vencida» no ofrece otra extensión
  await expireTrialOf(email);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Tu prueba gratuita terminó' })).toBeVisible();
  await expect(page.getByText(/los conservamos 30 días/)).toBeVisible();
  await expect(page.getByRole('button', { name: /Pedir 3 días más/ })).toHaveCount(0);
  expect((await request.get(`${apiBase}/v1/trials/me`, { headers: { authorization: `Bearer ${token}` } })).status()).toBe(200); // lo necesario sigue abierto

  // Cerrar sesión devuelve al login y la cookie ya no recupera la sesión
  await page.getByRole('button', { name: 'Cerrar sesión' }).click();
  await expect(page.getByRole('heading', { name: 'Inicia sesión' })).toBeVisible();
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Inicia sesión' })).toBeVisible();
});

test('prueba vencida SIN extensión usada: la pide desde la pantalla de vencida y el Súper Admin la deniega', async ({ page, request }) => {
  const email = await createAccount(request);
  await expireTrialOf(email);
  await uiLogin(page, email);
  await expect(page.getByRole('heading', { name: 'Tu prueba gratuita terminó' })).toBeVisible();
  await page.getByRole('button', { name: 'Pedir 3 días más' }).click();
  const dlg = page.getByRole('dialog');
  await dlg.getByLabel('¿Para qué necesitas más tiempo?').fill(REASON);
  await dlg.getByRole('button', { name: 'Enviar solicitud' }).click();
  await expect(page.getByText(/Tu solicitud de 3 días más está en revisión/)).toBeVisible();

  await decide(request, await pendingTrialOf(request, email), 'deny');
  await page.reload();
  await expect(page.getByText('La extensión no fue aprobada. Puedes continuar eligiendo un plan.')).toBeVisible();
  await expect(page.getByRole('button', { name: /Pedir 3 días más/ })).toHaveCount(0);
});

test('bloqueo tras 5 intentos fallidos: el 6.º se bloquea aun con la contraseña correcta, con mensaje de espera', async ({ page, request }) => {
  const email = await createAccount(request);
  await page.goto('/login');
  for (let i = 0; i < 5; i++) {
    await page.getByLabel('Correo', { exact: true }).fill(email);
    await page.getByLabel('Contraseña', { exact: true }).fill(`incorrecta-${i}`);
    await page.getByRole('button', { name: 'Entrar' }).click();
    await expect(page.getByRole('alert')).toContainText('Correo o contraseña incorrectos.');
  }
  await page.getByLabel('Contraseña', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page.getByRole('alert')).toContainText(/Demasiados intentos\. Inténtalo de nuevo en/);
  await expect(page.getByRole('heading', { name: 'Inicia sesión' })).toBeVisible();
});

test('mensaje genérico: correo inexistente y contraseña errónea se ven IGUAL', async ({ page, request }) => {
  const email = await createAccount(request);
  const msg = async (e: string) => {
    await page.goto('/login');
    await page.getByLabel('Correo', { exact: true }).fill(e);
    await page.getByLabel('Contraseña', { exact: true }).fill('contraseña-incorrecta');
    await page.getByRole('button', { name: 'Entrar' }).click();
    return page.getByRole('alert').innerText();
  };
  expect(await msg(email)).toBe(await msg(uniqueEmail('nadie')));
});

test('correo desechable rechazado; correo ya registrado NO se revela y no pisa la cuenta existente', async ({ page, request }) => {
  await page.goto('/signup');
  await page.getByLabel('Nombre completo').fill('Ana E2E');
  await page.getByLabel('Empresa').fill('Empresa Temporal');
  await page.getByLabel('WhatsApp').fill('098 421 7730');
  await page.getByLabel('Correo de trabajo').fill('alguien@mailinator.com');
  await page.getByLabel('Contraseña', { exact: true }).fill(PASSWORD);
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: /Crear cuenta y empezar/ }).click();
  await expect(page.getByRole('alert')).toContainText('correo de trabajo o personal permanente');

  // Duplicado: la respuesta es idéntica (avanza a «verifica tu correo»), pero no hay código válido y la contraseña original sigue funcionando
  const existing = await createAccount(request);
  await page.goto('/signup');
  await page.getByLabel('Nombre completo').fill('Ana E2E');
  await page.getByLabel('Empresa').fill('Otra Empresa');
  await page.getByLabel('WhatsApp').fill('098 421 7730');
  await page.getByLabel('Correo de trabajo').fill(existing);
  await page.getByLabel('Contraseña', { exact: true }).fill('Otra-Clave-Distinta-9');
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: /Crear cuenta y empezar/ }).click();
  await expect(page.getByRole('heading', { name: 'Verifica tu correo' })).toBeVisible();
  await page.getByLabel('Código').fill('000000');
  await page.getByRole('button', { name: 'Verificar y entrar' }).click();
  await expect(page.getByRole('alert')).toContainText('Código inválido o vencido');
  await apiLogin(request, existing); // sigue entrando con la contraseña ORIGINAL
});

test('recuperar contraseña: enlace del correo → contraseña nueva → entra; la vieja ya no sirve; el enlace no se reutiliza', async ({ page, request }) => {
  const email = await createAccount(request);
  await page.goto('/forgot');
  await page.getByLabel('Correo', { exact: true }).fill(email);
  const since = mailMark();
  await page.getByRole('button', { name: 'Enviar enlace' }).click();
  await expect(page.getByRole('heading', { name: 'Revisa tu correo' })).toBeVisible();
  const { resetUrl } = await nextMail('restablecimiento', since);

  await page.goto(resetUrl ?? '');
  await expect(page).toHaveURL(/\/reset-password$/); // el token ya no está en la barra de direcciones
  const NEW = 'Nueva-Clave-E2E-2026';
  await page.getByLabel('Contraseña nueva', { exact: true }).fill(NEW);
  await page.getByLabel('Repite la contraseña', { exact: true }).fill(NEW);
  await page.getByRole('button', { name: 'Guardar contraseña' }).click();
  await expect(page.getByText('Contraseña actualizada. Inicia sesión con la nueva.')).toBeVisible();

  await uiLogin(page, email, PASSWORD);
  await expect(page.getByRole('alert')).toContainText('Correo o contraseña incorrectos.');
  await uiLogin(page, email, NEW);
  await expect(page.getByRole('heading', { name: /Hola, Empresa E2E/ })).toBeVisible();

  await page.getByRole('button', { name: 'Cerrar sesión' }).click();
  await page.goto(resetUrl ?? '');
  await page.getByLabel('Contraseña nueva', { exact: true }).fill('Otra-Clave-E2E-2027');
  await page.getByLabel('Repite la contraseña', { exact: true }).fill('Otra-Clave-E2E-2027');
  await page.getByRole('button', { name: 'Guardar contraseña' }).click();
  await expect(page.getByRole('heading', { name: 'Enlace inválido o vencido' })).toBeVisible();
});

test('la CSP de la API no rompe la web: ninguna pantalla de acceso produce violaciones ni errores de consola', async ({ page }) => {
  const problems: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error' || /Content Security Policy/i.test(m.text())) problems.push(m.text()); });
  page.on('pageerror', (e) => problems.push(e.message));
  for (const route of ['/login', '/signup', '/forgot', '/reset-password', '/verify']) {
    const res = await page.goto(route);
    expect(res?.headers()['content-security-policy'], route).toContain("default-src 'self'");
    await expect(page.getByRole('main')).toBeVisible();
  }
  // los errores de red de recursos externos (fuentes de Google sin internet) no cuentan; las violaciones de CSP sí
  expect(problems.filter((p) => /Content Security Policy|Refused to/i.test(p))).toEqual([]);
});

test('consola del Súper Admin: ve la solicitud con el perfil del titular, la APRUEBA desde la interfaz y RECHAZA otra', async ({ page, request }) => {
  const approveMe = await createAccount(request, uniqueEmail('aprobar'));
  const denyMe = await createAccount(request, uniqueEmail('rechazar'));
  await requestExtensionViaApi(request, approveMe, REASON);
  await requestExtensionViaApi(request, denyMe, 'Necesito terminar la migración de contactos');
  await expireTrialOf(denyMe); // una de las dos ya venció: la aprobación/rechazo debe funcionar igual

  const s = state();
  await uiLogin(page, s.rootEmail, s.rootPassword);
  await expect(page.getByRole('heading', { name: 'Consola de plataforma' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Empresas' })).toHaveAttribute('aria-current', 'page'); // la consola abre en «Empresas»
  await page.getByRole('link', { name: /Pruebas/ }).click();
  await expect(page.getByRole('link', { name: /Pruebas/ })).toHaveAttribute('aria-current', 'page');
  const rowOf = (email: string) => page.getByRole('listitem').filter({ hasText: email });
  await expect(rowOf(approveMe)).toContainText('Ana E2E');
  await expect(rowOf(approveMe)).toContainText('+593984217730');
  await expect(rowOf(approveMe)).toContainText(REASON);
  await expect(page.getByRole('navigation', { name: 'Secciones de la consola' }).getByLabel(/solicitudes pendientes$/)).toBeVisible();

  // Aprobar con confirmación
  await rowOf(approveMe).getByRole('button', { name: /Aprobar la extensión/ }).click();
  const dlg = page.getByRole('dialog', { name: 'Aprobar extensión' });
  await expect(dlg).toContainText('Se suman 3 días');
  await dlg.getByRole('button', { name: 'Aprobar' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(rowOf(approveMe)).toHaveCount(0); // ya no está entre las pendientes

  // Rechazar (la prueba ya vencida no se reactiva)
  await rowOf(denyMe).getByRole('button', { name: /Rechazar la extensión/ }).click();
  await expect(page.getByRole('dialog', { name: 'Rechazar extensión' })).toContainText('La prueba no cambia');
  await page.getByRole('dialog').getByRole('button', { name: 'Rechazar' }).click();
  await expect(rowOf(denyMe)).toHaveCount(0);

  // El efecto llegó al servidor
  expect(await trialOf(request, approveMe)).toMatchObject({ status: 'active', extension: { status: 'approved', days_granted: 3 } });
  expect(await trialOf(request, denyMe)).toMatchObject({ status: 'expired', extension: { status: 'denied', days_granted: null } });

  // «Todas» las muestra ya resueltas
  await page.getByRole('tab', { name: 'Todas' }).click();
  await expect(rowOf(approveMe)).toContainText('Aprobada +3 d');
  await expect(rowOf(denyMe)).toContainText('Rechazada');
});

test('empresas y planes: crea un plan, lo asigna a una empresa con la prueba VENCIDA (se reabre) y al quitarlo vuelve la pausa', async ({ page, request }) => {
  const email = await createAccount(request, uniqueEmail('plan'));
  await expireTrialOf(email);
  const planName = `Pro ${uniqueEmail('p').slice(2, 8)}`;

  // 1) La persona cliente está en pausa (prueba vencida)
  await uiLogin(page, email);
  await expect(page.getByRole('heading', { name: 'Tu prueba gratuita terminó' })).toBeVisible();
  await page.getByRole('button', { name: 'Cerrar sesión' }).click();

  // 2) El Súper Admin crea el plan desde la interfaz
  const s = state();
  await uiLogin(page, s.rootEmail, s.rootPassword);
  await page.getByRole('link', { name: 'Planes' }).click();
  await page.getByRole('button', { name: 'Nuevo plan' }).click();
  const dlg = page.getByRole('dialog', { name: 'Nuevo plan' });
  await dlg.getByLabel('Nombre', { exact: true }).fill(planName);
  await dlg.getByLabel('Usuarios').fill('10');
  await dlg.getByLabel('Kanban').check();
  await dlg.getByLabel('Agenda').check();
  await dlg.getByRole('button', { name: 'Crear plan' }).click();
  const card = page.getByRole('listitem').filter({ hasText: planName });
  await expect(card).toContainText('10 usuarios · ilimitados conexiones · ilimitados colas');
  await expect(card.getByLabel(`Módulos de ${planName}`)).toContainText('Kanban');
  await expect(card).toContainText('0 empresas');

  // 3) Lo asigna a la empresa (se busca por el correo del responsable)
  await page.getByRole('link', { name: 'Empresas' }).click();
  await page.getByLabel('Buscar').fill(email);
  const row = page.getByRole('listitem').filter({ hasText: email });
  await expect(row).toContainText('Prueba vencida');
  await row.getByRole('button', { name: /Cambiar el plan/ }).click();
  const assign = page.getByRole('dialog', { name: /Plan de/ });
  await assign.getByLabel('Plan').selectOption({ label: planName });
  await expect(assign).toContainText('dejará de estar en prueba');
  await assign.getByRole('button', { name: 'Asignar plan' }).click();
  await expect(row).toContainText('Activa');
  await expect(row).toContainText(planName);

  // 4) El plan en uso no se archiva (el mensaje sale del servidor)
  await page.getByRole('link', { name: 'Planes' }).click();
  await expect(card).toContainText('1 empresa');
  await card.getByRole('button', { name: /Archivar el plan/ }).click();
  await expect(card.getByRole('alert')).toContainText('lo usan 1 empresa');
  await page.getByRole('button', { name: 'Cerrar sesión' }).click();

  // 5) La persona cliente YA entra: ya no depende de la prueba
  await uiLogin(page, email);
  await expect(page.getByRole('heading', { name: /Hola, Empresa E2E/ })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Prueba gratuita' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Cerrar sesión' }).click();

  // 6) Al quitar el plan vuelve la pausa
  await uiLogin(page, s.rootEmail, s.rootPassword);
  await page.getByLabel('Buscar').fill(email);
  const row2 = page.getByRole('listitem').filter({ hasText: email });
  await row2.getByRole('button', { name: /Cambiar el plan/ }).click();
  const unassign = page.getByRole('dialog', { name: /Plan de/ });
  await unassign.getByLabel('Plan').selectOption({ label: 'Sin plan' });
  await expect(unassign).toContainText('queda en pausa');
  await unassign.getByRole('button', { name: 'Quitar plan' }).click();
  await expect(row2).toContainText('Prueba vencida');
  await page.getByRole('button', { name: 'Cerrar sesión' }).click();
  await uiLogin(page, email);
  await expect(page.getByRole('heading', { name: 'Tu prueba gratuita terminó' })).toBeVisible();
});

test('nueva empresa: el Súper Admin la crea e invita; el dueño abre el enlace, crea su cuenta y entra con su prueba; el enlace no se reutiliza', async ({ page, request }) => {
  const s = state();
  const owner = uniqueEmail('dueno');
  const company = `Cafe ${uniqueEmail('c').slice(2, 8)}`;

  // 1) El Súper Admin crea la empresa desde la consola (Ecuador y su zona horaria vienen sugeridos)
  await uiLogin(page, s.rootEmail, s.rootPassword);
  const since = mailMark();
  await page.getByRole('button', { name: 'Nueva empresa' }).click();
  const dlg = page.getByRole('dialog', { name: 'Nueva empresa' });
  await dlg.getByLabel('Nombre de la empresa').fill(company);
  await dlg.getByLabel('Correo del dueño').fill(owner);
  await expect(dlg.getByLabel('País')).toHaveValue('EC');
  await expect(dlg.getByLabel('Zona horaria')).toHaveValue('America/Guayaquil');
  await dlg.getByRole('button', { name: 'Crear e invitar' }).click();
  const done = page.getByRole('dialog', { name: 'Empresa creada' });
  await expect(done).toContainText('Enviamos la invitación');
  await expect(done.getByLabel('Enlace de invitación')).toHaveCount(0); // con el correo enviado el enlace NO viaja a la pantalla
  await done.getByRole('button', { name: 'Listo' }).click();
  const row = page.getByRole('listitem').filter({ hasText: company });
  await expect(row).toContainText('Invitación pendiente');
  await expect(row).toContainText(owner);
  const { inviteUrl } = await nextMail('invitación', since);
  expect(inviteUrl).toContain('/accept-invite#token=');
  await page.getByRole('button', { name: 'Cerrar sesión' }).click();

  // 2) El dueño abre el enlace: el token se borra de la barra de direcciones y crea su cuenta
  await page.goto(inviteUrl!);
  await expect(page.getByRole('heading', { name: 'Crea tu cuenta' })).toBeVisible();
  await expect(page.getByText(company)).toBeVisible();
  expect(page.url()).not.toContain('token=');
  await page.getByLabel('Nombre completo').fill('Dora Quinde');
  await page.getByLabel('WhatsApp').fill('098 765 4321');
  await page.getByLabel('Contraseña', { exact: true }).fill(PASSWORD);
  await page.getByLabel('Repite la contraseña').fill(PASSWORD);
  await page.getByRole('button', { name: 'Crear cuenta y entrar' }).click();
  await expect(page.getByText(`Cuenta lista. Inicia sesión con ${owner}`)).toBeVisible();

  // 3) Entra con la contraseña elegida y ve su prueba de 7 días (la empresa no tiene plan)
  await uiLogin(page, owner);
  await expect(page.getByRole('heading', { name: new RegExp(`Hola, ${company}`) })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Prueba gratuita' })).toBeVisible();
  expect((await trialOf(request, owner)).status).toBe('active');
  await page.getByRole('button', { name: 'Cerrar sesión' }).click();

  // 4) El enlace es de un solo uso
  await page.goto(inviteUrl!);
  await expect(page.getByRole('heading', { name: 'Invitación no válida' })).toBeVisible();

  // 5) En la consola la empresa ya no figura como pendiente
  await uiLogin(page, s.rootEmail, s.rootPassword);
  await page.getByLabel('Buscar').fill(owner);
  await expect(page.getByRole('listitem').filter({ hasText: company })).toContainText('En prueba');
});

test('agencias y carteras: crea una agencia, su dueño acepta, el Súper Admin le asigna un cliente (acceso) y se lo quita (sin acceso)', async ({ page, request }) => {
  const s = state();
  const owner = uniqueEmail('agencia');
  const clientEmail = await createAccount(request, uniqueEmail('cliente'));
  const agencyName = `Agencia ${uniqueEmail('a').slice(2, 8)}`;

  // 1) El Súper Admin crea la agencia (sin plan) y le llega la invitación al dueño
  await uiLogin(page, s.rootEmail, s.rootPassword);
  const since = mailMark();
  await page.getByRole('link', { name: 'Agencias' }).click();
  await page.getByRole('button', { name: 'Nueva agencia' }).click();
  const dlg = page.getByRole('dialog', { name: 'Nueva agencia' });
  await expect(dlg.getByLabel('Plan')).toHaveCount(0);
  await dlg.getByLabel('Nombre de la agencia').fill(agencyName);
  await dlg.getByLabel('Correo del dueño').fill(owner);
  await dlg.getByRole('button', { name: 'Crear e invitar' }).click();
  await expect(page.getByRole('dialog', { name: 'Agencia creada' })).toContainText('Enviamos la invitación');
  await page.getByRole('button', { name: 'Listo' }).click();
  const row = page.getByRole('listitem').filter({ hasText: agencyName });
  await expect(row).toContainText('Invitación pendiente');
  const { inviteUrl } = await nextMail('invitación', since);
  await page.getByRole('button', { name: 'Cerrar sesión' }).click();

  // 2) El dueño acepta y crea su cuenta
  await page.goto(inviteUrl!);
  await expect(page.getByText(`la agencia ${agencyName}`)).toBeVisible();
  await page.getByLabel('Nombre completo').fill('Dueña Agencia');
  await page.getByLabel('WhatsApp').fill('098 765 4321');
  await page.getByLabel('Contraseña', { exact: true }).fill(PASSWORD);
  await page.getByLabel('Repite la contraseña').fill(PASSWORD);
  await page.getByRole('button', { name: 'Crear cuenta y entrar' }).click();
  await expect(page.getByText('Cuenta lista.')).toBeVisible();

  // 3) El Súper Admin asigna el cliente desde Empresas: la agencia recibe el acceso
  expect(await hasAgencyAccess(owner, clientEmail)).toBe(false);
  await uiLogin(page, s.rootEmail, s.rootPassword);
  await page.getByLabel('Buscar').fill(clientEmail);
  const client = page.getByRole('listitem').filter({ hasText: clientEmail });
  await expect(client).toContainText('Administración directa');
  await client.getByRole('button', { name: /Cambiar la administración/ }).click();
  const change = page.getByRole('dialog', { name: /Administración de/ });
  await change.getByLabel('Administra', { exact: true }).selectOption({ label: agencyName });
  await expect(change).toContainText('La agencia elegida recibe acceso a esta empresa');
  await change.getByLabel('Motivo (opcional)').fill('Alta E2E');
  await change.getByRole('button', { name: 'Guardar cambio' }).click();
  await expect(client).toContainText(`Administrada por ${agencyName}`);
  expect(await hasAgencyAccess(owner, clientEmail)).toBe(true);

  // 4) La cartera lo muestra (con su historial) y «Quitar» corta el acceso
  await page.getByRole('link', { name: 'Agencias' }).click();
  await expect(page).toHaveURL(/\/platform\/agencies$/);
  const agencyRow = page.getByRole('list', { name: 'Agencias' }).getByRole('listitem').filter({ hasText: agencyName });
  await expect(agencyRow).toContainText('Activa');
  await expect(agencyRow.getByLabel('1 cliente')).toBeVisible();
  await agencyRow.getByRole('button', { name: `Cartera de ${agencyName}` }).click();
  const cartera = page.getByRole('dialog', { name: `Cartera de ${agencyName}` });
  await expect(cartera.getByRole('list', { name: 'Clientes' })).toContainText(clientEmail);
  await cartera.getByRole('button', { name: 'Ver historial' }).click();
  await expect(cartera.getByRole('list', { name: 'Cambios' })).toContainText('Alta E2E');
  await cartera.getByRole('button', { name: /Quitar a .* de la cartera/ }).click();
  await expect(cartera.getByText(/pasó a administración directa/)).toBeVisible();
  expect(await hasAgencyAccess(owner, clientEmail)).toBe(false);
  await cartera.getByRole('button', { name: 'Cerrar' }).click();
  await expect(agencyRow.getByLabel('0 clientes')).toBeVisible();

  // 5) Suspender y reactivar la agencia desde la consola
  await agencyRow.getByRole('button', { name: `Suspender a ${agencyName}` }).click();
  await page.getByRole('dialog', { name: `Suspender a ${agencyName}` }).getByRole('button', { name: 'Suspender' }).click();
  await expect(agencyRow).toContainText('Suspendida');
  await agencyRow.getByRole('button', { name: `Reactivar a ${agencyName}` }).click();
  await page.getByRole('dialog', { name: `Reactivar a ${agencyName}` }).getByRole('button', { name: 'Reactivar' }).click();
  await expect(agencyRow).toContainText('Activa');
});

test('contexto: la agencia registra un cliente, entra a uno y a otro sin cerrar sesión y vuelve; el Súper Admin lo ve en Accesos y entra en soporte', async ({ page, request }) => {
  const s = state();
  const { apiBase } = s;
  const JSON_HEADERS = { 'content-type': 'application/json' };
  const owner = uniqueEmail('agencia-ctx');
  const clientEmail = await createAccount(request, uniqueEmail('cliente-ctx'));
  const foreignEmail = await createAccount(request, uniqueEmail('ajeno-ctx'));
  const agencyName = `Agencia ${uniqueEmail('c').slice(2, 8)}`;
  const registered = `Panadería ${uniqueEmail('p').slice(2, 8)}`;
  const admin = await adminToken(request);
  const auth = { ...JSON_HEADERS, authorization: `Bearer ${admin}` };
  const companyIdOf = async (email: string): Promise<string> => ((await (await request.get(`${apiBase}/v1/platform/companies?q=${encodeURIComponent(email)}`, { headers: auth })).json()) as { items: Array<{ id: string }> }).items[0]!.id;

  // Preparación por la API: una agencia con su dueño y un cliente existente en su cartera
  const since = mailMark();
  const created = await request.post(`${apiBase}/v1/platform/agencies`, { headers: auth, data: { name: agencyName, owner_email: owner, timezone: 'America/Guayaquil', country: 'EC' } });
  expect(created.status()).toBe(201);
  const agencyId = ((await created.json()) as { company: { id: string } }).company.id;
  const { inviteUrl } = await nextMail('invitación', since);
  const token = new URL(inviteUrl ?? '').hash.replace(/^#token=/, '');
  expect((await request.post(`${apiBase}/v1/auth/invitations/accept`, { headers: JSON_HEADERS, data: { token, password: PASSWORD, full_name: 'Dueña Agencia', phone: '+593987654321' } })).status()).toBe(200);
  const clientId = await companyIdOf(clientEmail);
  const foreignId = await companyIdOf(foreignEmail);
  expect((await request.put(`${apiBase}/v1/platform/organizations/${clientId}/agency`, { headers: auth, data: { agency_id: agencyId } })).status()).toBe(200);

  // Un cliente AJENO a su cartera no se puede entrar: 404 (no revela si existe)
  const agencyToken = await apiLogin(request, owner);
  const denied = await request.post(`${apiBase}/v1/context/switch`, { headers: { ...JSON_HEADERS, authorization: `Bearer ${agencyToken}` }, data: { target: foreignId } });
  expect(denied.status()).toBe(404);

  // 1) La agencia aterriza en «Mis clientes» y registra un cliente nuevo (sin plan)
  await uiLogin(page, owner);
  await expect(page.getByRole('heading', { name: 'Mis clientes' })).toBeVisible();
  const clients = page.getByRole('list', { name: 'Clientes' });
  await expect(clients.getByRole('listitem')).toHaveCount(1);
  await page.getByRole('button', { name: 'Registrar cliente' }).click();
  const dlg = page.getByRole('dialog', { name: 'Registrar cliente' });
  await expect(dlg.getByLabel('Plan')).toHaveCount(0);
  await dlg.getByLabel('Nombre del cliente').fill(registered);
  await dlg.getByLabel('Correo del dueño').fill(uniqueEmail('dueno'));
  await dlg.getByRole('button', { name: 'Registrar e invitar' }).click();
  await expect(page.getByRole('dialog', { name: 'Cliente registrado' })).toContainText('Enviamos la invitación');
  await page.getByRole('button', { name: 'Listo' }).click();
  await expect(clients.getByRole('listitem')).toHaveCount(2);
  await expect(clients.getByRole('listitem').filter({ hasText: registered })).toContainText('Invitación pendiente');

  // 2) Entra al cliente existente (banner, misma sesión), cambia al nuevo con el selector, recarga (el contexto se conserva) y vuelve
  await clients.getByRole('listitem').filter({ hasText: 'Empresa E2E' }).getByRole('button', { name: /Entrar a/ }).click();
  const banner = page.getByRole('region', { name: 'Contexto de acceso' });
  await expect(banner).toContainText('Administrando Empresa E2E');
  await expect(banner).toContainText('Administrador');
  await expect(page.getByRole('heading', { name: /Hola, Empresa E2E/ })).toBeVisible();
  await banner.getByRole('button', { name: 'Cambiar de cliente' }).click();
  await page.getByRole('dialog', { name: 'Cambiar de cliente' }).getByRole('button', { name: `Entrar a ${registered}` }).click();
  await expect(banner).toContainText(`Administrando ${registered}`);
  await page.reload();
  await expect(page.getByRole('region', { name: 'Contexto de acceso' })).toContainText(`Administrando ${registered}`);
  await page.getByRole('button', { name: 'Volver a mi agencia' }).click();
  await expect(page.getByRole('heading', { name: 'Mis clientes' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Contexto de acceso' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Cerrar sesión' }).click();

  // 3) El Súper Admin ve las dos entradas en «Accesos» y entra en soporte a la empresa
  await uiLogin(page, s.rootEmail, s.rootPassword);
  await page.getByRole('link', { name: 'Accesos' }).click();
  const entries = page.getByRole('list', { name: 'Accesos' }).getByRole('listitem').filter({ hasText: owner });
  await expect(entries).toHaveCount(2);
  await expect(entries.filter({ hasText: registered })).toContainText('Volvió a su cuenta');
  await expect(entries.filter({ hasText: 'Empresa E2E' })).toContainText('Pasó a otra cuenta');

  await page.getByRole('link', { name: 'Empresas' }).click();
  await expect(page.getByRole('list', { name: 'Empresas' })).toBeVisible();
  await page.getByLabel('Buscar').fill(clientEmail);
  const company = page.getByRole('listitem').filter({ hasText: clientEmail });
  await company.getByRole('button', { name: /Entrar a .* \(soporte\)/ }).click();
  const support = page.getByRole('region', { name: 'Contexto de acceso' });
  await expect(support).toContainText('Soporte: estás dentro de Empresa E2E');
  await expect(page.getByRole('heading', { name: /Hola, Empresa E2E/ })).toBeVisible();
  await page.goto('/platform/companies'); // dentro de una empresa la consola de plataforma no se muestra
  await expect(page.getByRole('heading', { name: /Hola, Empresa E2E/ })).toBeVisible();
  await page.getByRole('button', { name: 'Volver a la plataforma' }).click();
  await expect(page.getByRole('heading', { name: 'Consola de plataforma' })).toBeVisible();
  await page.getByRole('link', { name: 'Accesos' }).click();
  await expect(page.getByRole('list', { name: 'Accesos' }).getByRole('listitem').filter({ hasText: s.rootEmail }).first()).toContainText('Volvió a su cuenta');
});

test('proveedores: el Súper Admin guarda un secreto (cifrado, jamás vuelve a verse), activa el proveedor y nadie más lo ve', async ({ page, request }) => {
  const s = state();
  const { apiBase } = s;
  const SECRET = 'sk-e2e-ABCDEF1234567890wxyz';
  await uiLogin(page, s.rootEmail, s.rootPassword);
  await page.getByRole('link', { name: 'Proveedores' }).click();
  await expect(page).toHaveURL(/\/platform\/providers$/);
  const ai = page.getByRole('region', { name: 'IA de texto' });
  await expect(ai).toBeVisible();
  await expect(ai.getByText('Sin proveedor en uso')).toBeVisible();
  await expect(ai.getByRole('button', { name: 'Usar OpenAI' })).toBeDisabled(); // sin credenciales no se activa

  await ai.getByRole('button', { name: 'Configurar OpenAI' }).click();
  const dlg = page.getByRole('dialog', { name: 'Credenciales de OpenAI' });
  await dlg.getByLabel('Clave de API').fill(SECRET);
  await dlg.getByRole('button', { name: 'Guardar' }).click();
  await expect(dlg.getByText('Guardado.')).toBeVisible();
  await expect(dlg.getByText(/termina en wxyz/)).toBeVisible();
  await expect(page.locator('body')).not.toContainText(SECRET);
  await dlg.getByRole('button', { name: 'Cerrar' }).click();

  await ai.getByRole('button', { name: 'Usar OpenAI' }).click();
  await expect(ai.getByText('En uso: OpenAI')).toBeVisible();
  await page.reload(); // lo guardado persiste y el secreto no vuelve
  await expect(page.getByRole('region', { name: 'IA de texto' }).getByText('En uso: OpenAI')).toBeVisible();
  await expect(page.locator('body')).not.toContainText(SECRET);

  // La API tampoco lo devuelve (ni al Súper Admin), y un cliente recibe 403
  const raw = await (await request.get(`${apiBase}/v1/platform/providers`, { headers: { authorization: `Bearer ${await adminToken(request)}` } })).text();
  expect(raw).not.toContain(SECRET);
  expect(raw).toContain('wxyz');
  const client = await createAccount(request, uniqueEmail('proveedores'));
  const clientToken = await apiLogin(request, client);
  expect((await request.get(`${apiBase}/v1/platform/providers`, { headers: { authorization: `Bearer ${clientToken}` } })).status()).toBe(403);
});

test('contactos: crea, busca, edita y borra desde la interfaz; un teléfono repetido se marca en su fila; otra empresa no ve nada', async ({ page, request }) => {
  const { apiBase } = state();
  const email = await createAccount(request, uniqueEmail('contactos'));
  await uiLogin(page, email);
  await page.getByRole('link', { name: 'Contactos' }).click();
  await expect(page).toHaveURL(/\/contacts$/);
  await expect(page.getByText(/Crea el primero con «Nuevo contacto»/)).toBeVisible();

  const fill = async (name: string, phone: string) => {
    await page.getByRole('button', { name: 'Nuevo contacto' }).click();
    const dlg = page.getByRole('dialog', { name: 'Nuevo contacto' });
    await dlg.getByLabel('Nombre', { exact: true }).fill(name);
    await dlg.getByLabel('Teléfono 1 (principal)').fill(phone);
    return dlg;
  };

  // 1) Crear: el número nacional lleva el prefijo del país elegido (Ecuador) y se ve con formato
  const dlg = await fill('Marta Salazar', '098 421 7730');
  await dlg.getByLabel('Correo').fill('marta@correo.test');
  await dlg.getByLabel('Consentimiento para escribirle').selectOption('granted');
  await dlg.getByRole('button', { name: 'Crear contacto' }).click();
  await expect(dlg).toBeHidden();
  const marta = page.getByRole('button', { name: 'Abrir el contacto Marta Salazar' });
  await expect(marta).toContainText('+593 98 421 7730');
  await expect(marta).toContainText('Con consentimiento');
  await expect(page.getByText('1 contacto', { exact: true })).toBeVisible();

  // 2) El mismo teléfono en otro contacto: el servidor lo rechaza y el aviso queda en su fila; con otro número, se crea
  const dup = await fill('Pedro Vera', '0984217730');
  await dup.getByRole('button', { name: 'Crear contacto' }).click();
  await expect(dup.getByText('Ya existe un contacto con este teléfono')).toBeVisible();
  await expect(dup.getByLabel('Nombre', { exact: true })).toHaveValue('Pedro Vera'); // lo escrito se conserva
  await dup.getByLabel('Teléfono 1 (principal)').fill('0991112233');
  await dup.getByRole('button', { name: 'Crear contacto' }).click();
  await expect(dup).toBeHidden();
  await expect(page.getByText('2 contactos', { exact: true })).toBeVisible();

  // 3) Buscar por nombre y por parte del teléfono
  await page.getByLabel('Buscar').fill('pedro');
  await expect(page.getByRole('button', { name: 'Abrir el contacto Marta Salazar' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Abrir el contacto Pedro Vera' })).toBeVisible();
  await page.getByLabel('Buscar').fill('421 77');
  await expect(page.getByRole('button', { name: 'Abrir el contacto Marta Salazar' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Abrir el contacto Pedro Vera' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Limpiar filtros' }).click();
  await expect(page.getByText('2 contactos', { exact: true })).toBeVisible();

  // 4) Editar
  await marta.click();
  const edit = page.getByRole('dialog', { name: 'Contacto' });
  await expect(edit.getByLabel('Teléfono 1 (principal)')).toHaveValue('+593984217730');
  await edit.getByLabel('Nombre', { exact: true }).fill('Marta Salazar Ruiz');
  await edit.getByRole('button', { name: 'Guardar' }).click();
  await expect(edit).toBeHidden();
  await expect(page.getByRole('button', { name: 'Abrir el contacto Marta Salazar Ruiz' })).toBeVisible();

  // 5) Borrar pide confirmación
  await page.getByRole('button', { name: 'Abrir el contacto Pedro Vera' }).click();
  const del = page.getByRole('dialog', { name: 'Contacto' });
  await del.getByRole('button', { name: 'Borrar contacto' }).click();
  await expect(del.getByText('¿Borrar este contacto?')).toBeVisible();
  await del.getByRole('button', { name: 'Sí, borrar' }).click();
  await expect(del).toBeHidden();
  await expect(page.getByRole('button', { name: 'Abrir el contacto Pedro Vera' })).toHaveCount(0);
  await expect(page.getByText('1 contacto', { exact: true })).toBeVisible();
  await page.reload(); // lo guardado persiste
  await expect(page.getByRole('button', { name: 'Abrir el contacto Marta Salazar Ruiz' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Abrir el contacto Pedro Vera' })).toHaveCount(0);

  // 6) Otra empresa no ve ni toca nada de esta (404 uniforme); la lista de la otra está vacía
  const mine = { authorization: `Bearer ${await apiLogin(request, email)}` };
  const id = ((await (await request.get(`${apiBase}/v1/contacts`, { headers: mine })).json()) as { items: Array<{ id: string }> }).items[0]!.id;
  const other = { authorization: `Bearer ${await apiLogin(request, await createAccount(request, uniqueEmail('otra')))}` };
  expect(((await (await request.get(`${apiBase}/v1/contacts`, { headers: other })).json()) as { items: unknown[] }).items).toEqual([]);
  expect((await request.get(`${apiBase}/v1/contacts/${id}`, { headers: other })).status()).toBe(404);
  expect((await request.delete(`${apiBase}/v1/contacts/${id}`, { headers: other })).status()).toBe(404);
});

test('campos personalizados: el administrador define campos, el formulario de contacto los exige y los guarda, archivar los oculta y otra empresa no los ve', async ({ page, request }) => {
  const { apiBase } = state();
  const email = await createAccount(request, uniqueEmail('campos'));
  await uiLogin(page, email);
  await page.getByRole('link', { name: 'Configuración' }).click();
  await expect(page).toHaveURL(/\/settings\/fields$/);
  await expect(page.getByText(/Crea el primero con «Nuevo campo»/)).toBeVisible();

  const create = async (name: string, type: string | null, options: string | null, required = false) => {
    await page.getByRole('button', { name: 'Nuevo campo' }).click();
    const dlg = page.getByRole('dialog', { name: 'Nuevo campo' });
    await dlg.getByLabel('Nombre', { exact: true }).fill(name);
    if (type) await dlg.getByLabel('Tipo').selectOption({ label: type });
    if (options) await dlg.getByLabel('Opciones').fill(options);
    if (required) await dlg.getByLabel('Obligatorio').check();
    await dlg.getByRole('button', { name: 'Crear campo' }).click();
    await expect(dlg).toBeHidden();
  };
  await create('Cédula', null, null, true);
  await create('Interés', 'Selección única', 'Uñas\nBarbería');
  await create('Horarios', 'Selección múltiple', 'Mañana\nTarde');
  const list = page.getByRole('list', { name: 'Campos' });
  await expect(list.getByRole('listitem').filter({ hasText: 'Cédula' })).toContainText('{{contact.cedula}}');
  await expect(list.getByRole('listitem').filter({ hasText: 'Interés' })).toContainText('Uñas · Barbería');

  // Reordenar: bajar «Cédula» la deja en segundo lugar
  await page.getByRole('button', { name: 'Bajar Cédula' }).click();
  await expect(list.getByRole('listitem').nth(1)).toContainText('Cédula');

  // El formulario de contacto exige el obligatorio y guarda todos los valores
  await page.getByRole('link', { name: 'Contactos' }).click();
  await page.getByRole('button', { name: 'Nuevo contacto' }).click();
  const dlg = page.getByRole('dialog', { name: 'Nuevo contacto' });
  await dlg.getByLabel('Nombre', { exact: true }).fill('Marta Salazar');
  await dlg.getByRole('button', { name: 'Crear contacto' }).click();
  await expect(dlg.getByText('Este campo es obligatorio')).toBeVisible();
  await dlg.getByLabel(/Cédula/).fill('0912345678');
  await dlg.getByLabel('Interés').selectOption('Barbería');
  await dlg.getByLabel('Tarde').check();
  await dlg.getByRole('button', { name: 'Crear contacto' }).click();
  await expect(dlg).toBeHidden();

  const mine = { authorization: `Bearer ${await apiLogin(request, email)}` };
  const contacts = async () => ((await (await request.get(`${apiBase}/v1/contacts`, { headers: mine })).json()) as { items: Array<{ id: string; custom_fields: Record<string, unknown> }> }).items;
  expect((await contacts())[0]!.custom_fields).toEqual({ cedula: '0912345678', interes: 'Barbería', horarios: ['Tarde'] });

  // Reabrir muestra lo guardado; editar cambia solo lo tocado
  await page.getByRole('button', { name: 'Abrir el contacto Marta Salazar' }).click();
  const edit = page.getByRole('dialog', { name: 'Contacto' });
  await expect(edit.getByLabel(/Cédula/)).toHaveValue('0912345678');
  await expect(edit.getByLabel('Interés')).toHaveValue('Barbería');
  await expect(edit.getByLabel('Tarde')).toBeChecked();
  await edit.getByLabel('Interés').selectOption('Uñas');
  await edit.getByRole('button', { name: 'Guardar' }).click();
  await expect(edit).toBeHidden();
  expect((await contacts())[0]!.custom_fields).toMatchObject({ interes: 'Uñas', cedula: '0912345678' });

  // Archivar «Interés» lo quita del formulario y de la respuesta; restaurarlo devuelve el valor
  await page.getByRole('link', { name: 'Configuración' }).click();
  await page.getByRole('button', { name: 'Archivar Interés' }).click();
  await expect(page.getByLabel('Ver archivados (1)')).toBeVisible();
  expect((await contacts())[0]!.custom_fields).not.toHaveProperty('interes');
  await page.getByLabel('Ver archivados (1)').check();
  await page.getByRole('button', { name: 'Restaurar Interés' }).click();
  await expect(page.getByRole('list', { name: 'Campos' }).getByRole('listitem').filter({ hasText: 'Interés' })).toBeVisible();
  expect((await contacts())[0]!.custom_fields).toMatchObject({ interes: 'Uñas' });

  // Otra empresa no ve los campos ni puede tocarlos
  const fieldsOf = async (headers: Record<string, string>) => ((await (await request.get(`${apiBase}/v1/custom-fields?archived=include`, { headers })).json()) as { items: Array<{ id: string }> }).items;
  const id = (await fieldsOf(mine))[0]!.id;
  const other = { authorization: `Bearer ${await apiLogin(request, await createAccount(request, uniqueEmail('otra')))}` };
  expect(await fieldsOf(other)).toEqual([]);
  expect((await request.post(`${apiBase}/v1/custom-fields/${id}/archive`, { headers: other })).status()).toBe(404);
});

test('el Súper Admin entra a la consola de plataforma', async ({ page }) => {
  const s = state();
  await uiLogin(page, s.rootEmail, s.rootPassword);
  await expect(page.getByRole('heading', { name: 'Consola de plataforma' })).toBeVisible();
});

test('sin sesión, la raíz y /login coinciden; con sesión, /login lleva a la app', async ({ page, request }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);
  const email = await createAccount(request);
  await uiLogin(page, email);
  await expect(page.getByRole('heading', { name: /Hola, Empresa E2E/ })).toBeVisible();
  await page.goto('/login');
  await expect(page.getByRole('heading', { name: /Hola, Empresa E2E/ })).toBeVisible();
});

test.describe('móvil (390 px)', () => {
  test.use({ viewport: { width: 390, height: 800 } });
  for (const route of ['/login', '/signup', '/forgot']) {
    test(`${route}: sin desborde horizontal y con los controles visibles`, async ({ page }) => {
      await page.goto(route);
      await expect(page.getByRole('main')).toBeVisible();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow).toBeLessThanOrEqual(0);
    });
  }

  test('/contacts: con nombres y correos largos no hay desborde horizontal y se puede abrir y crear', async ({ page, request }) => {
    const { apiBase } = state();
    const email = await createAccount(request, uniqueEmail('movil'));
    const token = await apiLogin(request, email);
    const long = 'Nombre-muy-largo-sin-espacios-'.repeat(5).slice(0, 190);
    const r = await request.post(`${apiBase}/v1/contacts`, { headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, data: { name: long, email: `${'correo-largo-'.repeat(8)}@dominio-largo-de-prueba.test`, phones: ['+593984217730', '+34612345678'] } });
    expect(r.status()).toBe(201);
    await uiLogin(page, email);
    await expect(page.getByRole('heading', { name: /Hola, Empresa E2E/ })).toBeVisible(); // la sesión ya está lista antes de navegar
    await page.goto('/contacts');
    await expect(page.getByRole('button', { name: `Abrir el contacto ${long}` })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    await page.getByRole('button', { name: 'Nuevo contacto' }).click();
    const dlg = page.getByRole('dialog', { name: 'Nuevo contacto' });
    await expect(dlg.getByRole('button', { name: 'Crear contacto' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  });

  test('/settings/fields: con un campo de nombre y opciones largos no hay desborde horizontal y se puede crear', async ({ page, request }) => {
    const { apiBase } = state();
    const email = await createAccount(request, uniqueEmail('movilcf'));
    const token = await apiLogin(request, email);
    const name = 'Nombre-de-campo-muy-largo-sin-espacios-'.repeat(2).slice(0, 78);
    const r = await request.post(`${apiBase}/v1/custom-fields`, { headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, data: { name, type: 'select', options: ['Opcion-larga-'.repeat(7).slice(0, 99), 'Otra'] } });
    expect(r.status()).toBe(201);
    await uiLogin(page, email);
    await expect(page.getByRole('heading', { name: /Hola, Empresa E2E/ })).toBeVisible(); // la sesión ya está lista antes de navegar
    await page.goto('/settings/fields');
    await expect(page.getByRole('button', { name: `Editar ${name}` })).toBeVisible();
    const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(await overflow()).toBeLessThanOrEqual(0);
    await page.getByRole('button', { name: 'Nuevo campo' }).click();
    await expect(page.getByRole('dialog', { name: 'Nuevo campo' }).getByRole('button', { name: 'Crear campo' })).toBeVisible();
    expect(await overflow()).toBeLessThanOrEqual(0);
  });
});
