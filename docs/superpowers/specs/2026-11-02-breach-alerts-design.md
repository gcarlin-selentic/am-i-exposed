# Diseño técnico: flujo de alertas de brechas (breach monitoring)

**Fecha:** 2026-11-02
**Estado:** propuesta, pendiente de aprobación. No se construye nada hasta que el usuario apruebe este documento.
**Autor:** Claude (Opus 4.8), para Guillermo Carlin.

## Intención

Convertir el chequeo puntual gratis ("¿estoy expuesto hoy?") en un producto de
suscripción ("avísame cuando aparezca en una filtración nueva"). El motor
recurrente ya existe: el **Radar de Ataques diario** corre todos los días y ya
toca HIBP. Este diseño no construye un backend nuevo desde cero; conecta cuatro
piezas sobre ese motor.

El producto objetivo es el **Monitoreo de brechas** (3 USD/mes o 30 USD/año) y,
por extensión, el **Combo** (brechas + settlements). Durante el early access la
captura es gratis y las alertas se envían gratis; el cobro se activa cuando
Paddle esté vivo.

## Qué existe hoy (base reutilizable)

- `api/check-email.js`: consulta on-demand a HIBP
  `GET haveibeenpwned.com/api/v3/breachedaccount/{email}?truncateResponse=false`
  con header `hibp-api-key: HIBP_API_KEY`. 404 = limpio, 200 = array de brechas
  (`Name`, `Title`, `Domain`, `BreachDate`, `DataClasses`, `IsStealerLog`, ...),
  429 = rate limited, 401 = key invalida. No guarda el email (promesa de la
  landing).
- `api/_email.js`: envío por Brevo (`BREVO_API_KEY`, `MAIL_FROM`,
  `MAIL_FROM_NAME`) con `layout()` reusable y el contrato "nunca lanza, devuelve
  false". Exports actuales: `sendReceipt`, `sendRefundNotice`, `sendOpsAlert`.
- `api/_shared.js`: helpers service-role de Supabase `sbSelect(path)`,
  `sbInsert(table, row)`, `sbPatch(pathWithFilter, patch)` (PostgREST, devuelven
  `{ ok, status, rows }`, nunca lanzan) y `rateLimitOk(key, max, windowSeconds)`.
- `api/healthcheck.js`: patron de endpoint protegido con `CRON_SECRET` (compara
  en tiempo constante, 401 si no coincide, 503 si no esta configurado).
- El Radar de Ataques diario: rutina en la nube que ya se dispara a diario.

## Qué falta (el delta real, 4 piezas)

1. Una tabla de suscriptores en Supabase (DDL la corre el dueño; Claude no puede).
2. Un formulario de captura en el sitio que llena esa tabla.
3. Un endpoint diario que recorre la tabla, chequea cada email en HIBP, compara
   con lo ya conocido y se queda con lo nuevo (con dedup).
4. El envío de la alerta por Brevo.

El disparo diario lo da el Radar, no un cron nuevo de Vercel (ver Decisiones).

## Matiz técnico que define el diseño

El Radar hoy responde una pregunta **global**: "¿hay brechas nuevas en el
mundo?" (una consulta). El producto necesita una pregunta **por persona**:
"¿alguno de mis suscriptores esta en una brecha nueva?". HIBP no entrega "quien
de tu lista esta en la brecha X" (por privacidad); entrega, email por email, en
que brechas esta. Por eso el flujo recorre la lista y consulta cada email,
comparando contra el estado guardado de esa persona.

## Modelo de datos

Tabla nueva `breach_watch` (DDL la corre el dueño en el dashboard de Supabase,
proyecto `am-i-exposed`, id `morosdhhoznicppmrqyr`). **Doble opt-in**: el alta
nace `pending` y solo pasa a `active` cuando la persona hace clic en el enlace
de confirmación enviado a su correo (decidido 2026-11-02, cierra el bypass de
consentimiento que marcó el security review).

```sql
create table if not exists breach_watch (
  id                 bigint generated always as identity primary key,
  email              text not null,
  status             text not null default 'pending',   -- pending | active | unsubscribed | paused
  plan               text not null default 'free_capture', -- free_capture | breach | combo
  lang               text,                              -- 'es' | 'en'
  known_breaches     text[] not null default '{}',      -- HIBP Names ya vistos para este email
  baseline_done      boolean not null default false,    -- true tras el primer chequeo
  confirm_token      uuid,                              -- lo genera la app por alta/reconfirmación
  confirmed_at       timestamptz,                       -- cuando se confirmó el doble opt-in
  last_checked_at    timestamptz,
  created_at         timestamptz not null default now(),
  unsubscribe_token  uuid not null default gen_random_uuid()
);

create unique index if not exists breach_watch_email_key
  on breach_watch (email);
```

Emails normalizados (minúsculas/trim) en la app antes de insertar, así el índice
único sobre `email` plano basta.

### Doble opt-in (flujo de consentimiento)

- Alta (`/api/monitor-signup`): valida email + casilla de consentimiento, inserta
  `status='pending'` con un `confirm_token` nuevo (app, `crypto.randomUUID()`),
  y envía el correo de confirmación con el enlace. Responde siempre 200
  `{ok:true}` (no revela si el email ya existía).
- Confirmación (`GET /api/confirm-subscription?token=<uuid>`): busca el token en
  una fila `pending`, la pasa a `active` + `confirmed_at=now()` + limpia el
  token, y muestra una página de "listo". Token no encontrado -> página
  "enlace inválido o vencido". El token es el secreto (uuid impredecible), así
  que un GET con el token es el patrón estándar de confirmación por correo.
- Re-alta de un `unsubscribed`: NO se reactiva solo; vuelve a `pending` con un
  token nuevo y re-envía la confirmación. La activación siempre exige el clic,
  así que una baja nunca se revierte sin el dueño del buzón.
- El job diario de alertas lee solo `status='active'`, así que `pending` y
  `unsubscribed` quedan fuera automáticamente.

Notas de diseño:

- `known_breaches` guarda el conjunto de `Name` de HIBP ya conocidos para ese
  email. "Nuevo" = lo que HIBP devuelve hoy menos lo que ya esta en el conjunto.
  Esto dedup por si el job corre dos veces el mismo dia: el segundo pase no
  encuentra nada nuevo.
- `baseline_done` separa el primer chequeo (no alarmar con todo el historico)
  de los siguientes (alertar solo lo que se suma).
- `status` decide a quien se chequea. `plan` registra la titularidad para cuando
  Paddle cobre; durante early access todos los `active` reciben alertas gratis.
- `unsubscribe_token` alimenta el enlace de baja obligatorio en cada correo.
- Sin RLS para esta tabla porque solo la toca el service-role desde el servidor;
  el cliente nunca la lee directo.

## Flujo

### Pieza 2: captura (sitio)

- Formulario en `/settlements/` y/o en la pagina de pricing: un campo email,
  texto de consentimiento explicito (ver Privacidad), boton.
- Endpoint `POST /api/monitor-signup`:
  - Valida formato de email (mismo criterio que `check-email.js`).
  - Rate limit por IP con `rateLimitOk`.
  - `sbInsert('breach_watch', { email, lang, status: 'active', plan: 'free_capture' })`
    con upsert por `lower(email)` (si ya existe, no duplica; reactiva si estaba
    `unsubscribed` solo con nuevo consentimiento).
  - Responde rapido. No chequea HIBP de forma sincrona (no quemar cuota ni
    bloquear la respuesta). El baseline + bienvenida salen en el proximo pase
    diario.

### Pieza 3: job diario (sitio, disparado por el Radar)

Endpoint `POST /api/run-breach-alerts`, protegido con `CRON_SECRET` (mismo gate
que `healthcheck.js`: bearer, comparacion en tiempo constante, 401/503).

Por cada suscriptor `active`:

1. `GET` a HIBP `breachedaccount/{email}?truncateResponse=false`.
2. Resolver resultado:
   - 404 (limpio): `returned = []`.
   - 200: `returned = [Name, ...]` del array.
   - 429/401/otro: registrar error (solo `error.name`, nunca el email), saltar
     este suscriptor sin tocar su fila, seguir con el siguiente.
3. Calcular `nuevos = returned - known_breaches` (funcion pura, testeable).
4. Decidir correo:
   - Si `baseline_done = false`: es el primer chequeo. Enviar **digest de
     bienvenida** con la exposicion actual (o "estas limpio por ahora"). No es
     una alarma. Marcar `baseline_done = true`.
   - Si `baseline_done = true` y `nuevos` no vacio: enviar **alerta** listando
     solo las brechas nuevas, con plan de accion y enlace de baja.
   - Si `nuevos` vacio: no enviar nada.
5. `sbPatch('breach_watch?id=eq.{id}', { known_breaches: union(known, returned), baseline_done: true, last_checked_at: now })`.

Respuesta JSON: `{ checked, alerted, welcomed, errors, at }`. Nunca incluye
emails. 200 normal; 503 si el gate no esta configurado.

Pacing HIBP: el job va secuencial y se mantiene bajo el limite del plan HIBP
(hoy 10/min en total para todo el sitio). Con una lista chica es trivial; a
medida que crezca, introducir una pausa entre consultas (p. ej. una cada ~7s) o
chequear solo cuando el Radar detecto una brecha nueva ese dia. El job NO pasa
por `rateLimitOk` (ese es el limitador por visitante); se autolimita.

### Pieza 4: envio (Brevo)

Agregar a `api/_email.js`, reusando `layout()` y `send()`:

- `sendBreachWelcome({ to, lang, breaches, siteUrl, unsubscribeUrl })`.
- `sendBreachAlert({ to, lang, newBreaches, siteUrl, unsubscribeUrl })`.

Ambos devuelven false en vez de lanzar, igual que el resto del modulo. Un envio
fallido no debe romper el job; se cuenta como error y el suscriptor se reintenta
al dia siguiente (su fila no se marca como notificada hasta que el patch corre;
ver Idempotencia).

### Disparo (Radar -> sitio)

El Radar de Ataques diario, al final de su corrida, hace una llamada HTTPS
autenticada: `POST https://www.am-i-exposed.com/api/run-breach-alerts` con
`Authorization: Bearer <CRON_SECRET>`. El Radar es el scheduler; el sitio hace
el trabajo pesado (ahi viven el service-role de Supabase, la key de HIBP y
Brevo).

## Idempotencia y fallas

- Correr el job dos veces el mismo dia no duplica alertas: tras el primer pase,
  `known_breaches` ya incluye lo nuevo, asi que el segundo pase ve `nuevos`
  vacio.
- Orden importante por si el envio falla: se puede patchear la fila **despues**
  de un envio exitoso para no marcar como "visto" algo que no se logro avisar.
  Decision en Open items (consistencia vs reintento).
- Un suscriptor con error de HIBP (429/timeout) no se toca y se reintenta al dia
  siguiente.
- Fail-safe de privacidad: logs solo con `error.name`, nunca el email, igual que
  `check-email.js`.

## Extension: settlements y combo

El Monitoreo de settlements reusa la misma maquinaria:

- Tabla analoga (o un `kind` en una tabla unificada). El diseño canonico previo
  vive en `docs/superpowers/specs/2026-11-01-paid-settlement-alerts-design.md`
  (rama sin fusionar) y lee `data/open-settlements.json` para casos abiertos.
- El mismo disparo del Radar puede correr los dos pases (brechas y settlements)
  en la misma invocacion.
- El **Combo** = un suscriptor activo en ambos watches. No es un tercer motor;
  es la union de los dos. El precio de combo (5 USD/mes, 50 USD/año) todavia no
  existe en Paddle y hay que crearlo.

## Privacidad y cumplimiento

Cambio real de postura, hay que decirlo claro:

- El chequeo on-demand gratis **sigue sin guardar** el email.
- El monitoreo **si guarda** el email, con consentimiento explicito en el
  formulario ("guardamos tu correo para avisarte; puedes darte de baja cuando
  quieras"). Sin esa casilla/texto, no se inserta.
- Cada correo de alerta/bienvenida lleva enlace de baja funcional
  (`unsubscribe_token`) que marca `status = unsubscribed`.
- El endpoint del job solo responde con secreto; nunca expone la lista.

## Variables de entorno

Ya existentes y reutilizadas: `HIBP_API_KEY`, `BREVO_API_KEY`, `MAIL_FROM`,
`MAIL_FROM_NAME`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `CRON_SECRET`,
`PUBLIC_BASE_URL`. No hace falta ninguna nueva para el MVP del monitoreo de
brechas.

## Qué se testea (TDD)

- Funcion pura `newBreaches(returned, known) -> string[]` (el diff con dedup):
  casos limpio, primera vez, brecha nueva, sin cambios, orden/duplicados.
- Decision de correo segun `baseline_done` y `nuevos` (bienvenida vs alerta vs
  nada).
- Union `known_breaches` tras el pase.
- Gate del endpoint (`CRON_SECRET` ausente -> 503, mal -> 401, bien -> corre).
- El job NO filtra emails en la respuesta ni en logs.

## Decisiones abiertas (requieren al usuario)

1. **Disparo:** Radar llama al endpoint (recomendado, no gasta slot de cron;
   Hobby solo da 2 y estan usados) vs subir Vercel a Pro para un 3er cron.
2. **Secreto en el Radar:** el Radar necesita el `CRON_SECRET` para llamar al
   endpoint. Decidir donde se guarda (secreto de la rutina).
3. **Primer chequeo:** enviar digest de bienvenida (recomendado, engancha) vs
   baseline silencioso.
4. **Consistencia de envio:** patchear la fila antes o despues del envio
   (menos duplicados posibles vs menos riesgo de perder una alerta).
5. **DDL:** el dueño corre el `create table` (Claude esta bloqueado para DDL en
   este proyecto).
6. **Early access:** durante la fase gratis, todos los `active` reciben alertas
   sin pagar; confirmar que es el comportamiento querido hasta que Paddle cobre.

## No-goals (de este diseño)

- No se construye el cobro (eso es Paddle, bloqueado hasta aprobacion de
  dominio).
- No se crea el precio de combo en Paddle.
- No se toca el chequeo on-demand gratis ni su promesa de no guardar email.
- No se migra la rama `wave2-settlement-alerts` (esta stale); se reusa su
  concepto, no su codigo.
