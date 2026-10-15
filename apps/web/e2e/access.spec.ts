// E2E del flujo de acceso (ADR-23) en un navegador real contra la API y la web COMPILADAS.
import { expect, test } from '@playwright/test';
import { apiLogin, createAccount, decide, expireTrialOf, hasAgencyAccess, mailMark, nextMail, pendingTrialItemOf, pendingTrialOf, requestExtensionViaApi, trialOf, PASSWORD, state, uiLogin, uniqueEmail } from './support';

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
  const agencyRow = page.getByRole('listitem').filter({ hasText: agencyName });
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
});
