// Supabase Configuration
const SUPABASE_URL = 'https://morosdhhoznicppmrqyr.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_agkPOONNtck7k-an-rpwOg_GTXoo5de';

let currentUser = null;
// Set once the server confirms this account has bought the report.
let knownEntitled = false;
window.sbClient = null;

// Last email check, kept in memory only so the action plan can be built
// without re-querying. Nothing is persisted.
let lastEmailResult = null;

// Whether an address has been looked up at all, which is not the same as
// lastEmailResult: a clean result clears that one. The explainer needs the
// distinction, because it belongs to the moment before anybody has asked.
let hasSearched = false;

// Last plan returned by /api/report, full or teaser depending on access.
let lastReport = null;

// Last password exposure count, so the card can be re-rendered when
// sign-in state changes.
let lastPasswordCount = null;

// Preview mode (?demo=1). Renders gated content from fixed sample data so
// the report can be reviewed without signing in or spending an API call.
// It never touches auth state and never calls the breach API.
let demoMode = false;

// Set when somebody asks to buy without an account yet, so that getting one
// carries straight on to the checkout. Kept in sessionStorage as well as in
// memory because Google and GitHub leave the page entirely and come back,
// which a variable does not survive.
const PURCHASE_INTENT = 'aie-buy-after-signin';

function wantsToBuy(value) {
    try {
        if (value) sessionStorage.setItem(PURCHASE_INTENT, '1');
        else sessionStorage.removeItem(PURCHASE_INTENT);
    } catch (e) { /* private browsing; the in-memory half still works */ }
    pendingPurchase = value;
}

let pendingPurchase = false;
try { pendingPurchase = sessionStorage.getItem(PURCHASE_INTENT) === '1'; } catch (e) { /* ignore */ }

// Called from every route into a session: the email forms, which set
// currentUser themselves, and onAuthStateChange, which covers Google and
// GitHub. The flag is cleared first, so whichever arrives second does
// nothing.
function resumePendingPurchase() {
    // Only the report purchase takes this sign-in round trip now. Monitoring is
    // email-based and goes straight to Stripe Checkout without an account.
    if (!pendingPurchase || !currentUser) return;
    wantsToBuy(false);
    // A beat for the modal to close, so the checkout does not open behind it.
    setTimeout(() => startPurchase(null), 400);
}
let demoTeaser = false;

// Gated content renders when the user is signed in, or in preview mode.
function isUnlocked() {
    return !!currentUser || demoMode;
}

// =======================================================================
// LANGUAGE
// Both languages sit side by side so a change to one is visibly a change
// to the other. The plan itself is translated on the server; `lang` is
// sent with every /api/report call.
// =======================================================================
const COPY = {
    es: {
        docTitle: '¿Se filtró tu correo? Revísalo gratis | ¿Estoy expuesto?',
        brand: '¿Estoy expuesto?',
        signin: 'Entrar', signout: 'Cerrar sesión', menu: 'Mi cuenta',
        heroTag: 'Gratis',
        heroBadge: 'Sin cuenta · Sin tarjeta',
        dailyTag: 'Hackeos hoy',
        dailyBadge: 'Actualizado cada mañana',
        dailyCount: (n) => (n === 1 ? '1 víctima nueva hoy' : `${num(n)} víctimas nuevas hoy`),
        poolHookTag: 'Fondo de dinero',
        poolHookUpTo: 'hasta',
        poolHookLabel: 'por persona',
        poolHookNew: 'NUEVO',
        priceHookTag: 'Precios',
        priceHookLabel: 'Ver todos los planes',
        heroTitle: 'Puede que te deban dinero. Nadie te avisó.',
        heroLede: 'Cuando una empresa filtra tus datos, por un ataque de ransomware o una brecha común, muchas veces tiene que pagarte. El aviso llega por correo postal, parece basura y casi nadie reclama. Escribe tu correo y te decimos si hay dinero que puedas reclamar, y qué más hacer.',
        heroBtn: 'Revisar mi correo',
        heroPlaceholder: 'tucorreo@ejemplo.com',
        checking: 'Revisando...',
        trust1: 'Solo sitios oficiales', trust2: 'Nunca cobramos comisión', trust3: 'Revisión gratis: no lo guardamos',

        pwTitle: 'Revisar también una contraseña',
        pwSub: 'Tu contraseña nunca sale de este dispositivo.',
        pwPlaceholder: '••••••••••',
        pwBtn: 'Revisar', pwShow: 'Mostrar contraseña', pwHide: 'Ocultar contraseña',
        pwNote: 'Solo enviamos las primeras cinco letras de un código calculado en tu navegador. Ni nosotros ni nadie más puede reconstruir tu contraseña a partir de eso.',

        // Same wording as the first answer on the FAQ page, deliberately. Two
        // versions of the same paragraph on one site reads as carelessness.
        explainBadge: 'Antes de empezar',
        explainTitle: '¿Qué cosa es estar expuesto?',
        explainP1: 'Cuando te registras en una tienda, una red social o un banco por internet, esa empresa guarda tus datos: tu correo, a veces tu contraseña, tu teléfono, tu dirección.',
        explainP2: 'Si a esa empresa le roban su base de datos, tus datos salen de ahí y empiezan a circular en listas que pasan de mano en mano entre desconocidos. Eso es estar expuesto: que información tuya ande dando vueltas por ahí sin que tú lo sepas.',
        explainP3: 'No lo causaste tú. Lo causó la empresa a la que le confiaste tus datos.',
        explainBtn: 'Ver todas las preguntas',

        offerBadge: 'Informe Completo',
        offerTitle: 'Estás expuesto. Esto es exactamente qué hacer.',
        offerLede: 'Un Informe Completo sobre tu correo filtrado: todo lo que quedó expuesto, un plan paso a paso para blindar tus cuentas, y los acuerdos que tus datos podrían reclamar.',
        offerLi1: 'Todo lo que quedó expuesto, y cómo arreglar cada cosa',
        offerLi2: 'Tu plan de seguridad completo, paso a paso, descargable en PDF',
        offerLi3: 'Acuerdos que tu correo podría reclamar, con enlaces oficiales gratis',
        offerPer: 'pago único',
        offerBtn: 'Ver un ejemplo',
        offerBuyBtn: 'Obtener mi Informe Completo',

        alertsBadge: 'Alertas &middot; solo EE.&nbsp;UU.',
        alertsTitle: 'Si demandan a una empresa que filtró tus datos, te avisamos.',
        alertsLede: 'Las empresas que pierden datos terminan pagando acuerdos colectivos. El dinero existe y casi nadie lo reclama, porque el aviso llega por correo postal y se confunde con publicidad.',
        alertsLi1: (casos, abiertos) => `<a href="/settlements/" class="alerts-link">${casos} casos en seguimiento, ${abiertos} abiertos para reclamar ahora</a>`,
        alertsLi2: 'Un aviso al mes, y uno aparte cuando haya algo que reclamar',
        alertsLi3: 'Si vives en California, te marcamos el pago estatutario extra',
        alertsFirstName: 'Nombre', alertsLastName: 'Apellido',
        alertsStateLabel: 'Estado donde resides',
        alertsStatePick: 'Elige tu estado',
        alertsConsent: 'Acepto que usen mi nombre y estado para cruzarlos con los casos activos y avisarme. Puedo darme de baja cuando quiera.',
        alertsPer: 'al mes', alertsBtn: 'Activar alertas',
        alertsOpening: 'Abriendo…',
        alertsErrName: 'Escribe tu nombre y apellido.',
        alertsErrState: 'Elige el estado donde resides.',
        alertsErrConsent: 'Marca la casilla para continuar.',
        alertsErrFail: 'No pudimos abrir el pago. Inténtalo de nuevo en un momento.',
        monitorBadge: 'Monitoreo',
        monitorTitle: 'No te pierdas más dinero.',
        monitorLede: 'Vigilamos tu correo y te avisamos apenas aparece en una filtración nueva, o apenas se abre un acuerdo que podrías reclamar.',
        monitorYearlyLabel: 'Pagar al año y ahorrar',
        monitorMo: '/mes', monitorYr: '/año',
        monitorBreachK: 'Alertas de filtraciones',
        monitorBreachD: 'Te avisamos apenas tu correo aparece en una filtración nueva.',
        monitorSettlementK: 'Alertas de acuerdos',
        monitorSettlementD: 'Te avisamos apenas se abre un acuerdo nuevo que podrías reclamar.',
        monitorComboK: 'Alertas de filtraciones + acuerdos',
        monitorComboD: 'Cada filtración nueva que incluya tu correo, y cada acuerdo nuevo que podrías reclamar.',
        monitorBtn: 'Empezar prueba de 14 días', monitorBtnBoth: 'Activar ambos',
        monitorNote: 'Prueba gratis de 14 días, cancela cuando quieras. No necesitas cuenta; te enviamos un correo para confirmar. Los enlaces para reclamar siempre son gratis.',
        monitorErrEmail: 'Primero revisa un correo arriba para activar el monitoreo.',
        alertsActive: 'Tus alertas están activas.',

        // La cara con coincidencia. El titular cambia porque un hecho ya
        // ocurrido convence mas que una promesa: "pudiste haber cobrado" es
        // comprobable, "te avisaremos" hay que creerlo.
        alertsMissedTitle: 'Ya pudiste haber cobrado, y nadie te avisó.',
        alertsMissedLede: 'Tu correo aparece en filtraciones que terminaron en acuerdo. Esto es lo que se pagaba, y cuándo venció el plazo:',
        missedProofTitle: 'Tus datos ya han valido dinero.',
        missedProofLede: ({ proofMax, openN, openMax, eligible }) => {
            const paid = proofMax
                ? `Estos acuerdos pagaron a quienes estaban en la demanda <b>hasta ${proofMax} por persona</b>.`
                : 'Estos acuerdos pagaron dinero real a quienes estaban en la demanda.';
            const past = ' Sus plazos ya cerraron, así que no puedes reclamarlos &mdash; pero tu correo sigue apareciendo en filtraciones que terminan en acuerdo.';
            const pool = (openN && openMax)
                ? ` Ahora mismo <b>${openN} están pagando</b>, hasta ${openMax} por persona, y cada semana se abren nuevos.`
                : ' Se abren nuevos todo el tiempo.';
            const hook = eligible
                ? ' Activa el monitoreo y te avisamos por correo apenas uno coincida con tu dirección.'
                : '';
            return paid + past + pool + hook;
        },
        missedCtaBtn: 'Activar monitoreo &mdash; no te pierdas el próximo',
        missedCtaNote: 'Alertas de nuevas filtraciones o nuevos acuerdos. Sin cuenta, cancela cuando quieras.',
        alertsCaveat: 'Para cobrar había que pertenecer a la clase, lo que normalmente exige haber recibido la carta de aviso de la empresa. Aparecer en la filtración no lo garantiza. No somos abogados y no reclamamos por ti.',
        ccBadge: 'Tus reclamos &middot; EE.&nbsp;UU.',
        ccTitle: '¿Qué acuerdos podrías reclamar realmente?',
        ccLede: 'Tu correo encontró las filtraciones. Esto encuentra el dinero. Marca cada empresa de la que hayas sido cliente, paciente o empleado, y sumamos lo que podrías reclamar ahora mismo.',
        ccStep2: 'Paso 2 &middot; ¿cuáles de estas has usado?',
        ccStateLabel: 'Estado donde resides',
        ccNumLabel: 'Podrías reclamar',
        ccNumSub: (n) => `en ${n} acuerdo${n === 1 ? '' : 's'} donde podrías calificar`,
        ccNumNote: '&ldquo;Hasta&rdquo; son los montos máximos publicados. Aparecer no es una promesa de pago.',
        ccClosedTag: 'cerrado',
        ccClosedWhen: (d) => `cerró ${d}`,
        ccNumNoAmount: 'dinero que podrías reclamar',
        ccLockedTitle: 'Acuerdos abiertos para ti',
        ccUnlockedTitle: 'Tus acuerdos, y dónde reclamar',
        ccLockedLede: 'Estos son los acuerdos abiertos que coinciden con tu correo. Los enlaces oficiales para reclamar son gratis.',
        ccPlanOnceK: 'Ver ahora', ccPlanOnceP: 'una vez',
        ccPlanOnceD: 'Desbloquea tu lista completa: qué empresas, los montos y los enlaces oficiales para reclamar hoy.',
        ccPlanOnceBtn: 'Ver mis acuerdos',
        ccPlanSubK: 'Monitoreo', ccPlanSubP: 'al mes &middot; $30/año',
        ccPlanSubD: 'Te vigilamos y te avisamos en cuanto se abre uno nuevo donde podrías calificar.',
        ccPlanSubBtn: 'Activar monitoreo',
        ccUnavail: 'Estamos preparando el cobro para tu país. Activa el monitoreo abajo y te avisamos por correo en cuanto esté listo.',
        ccCaveat: 'Podrías calificar si fuiste cliente, paciente o empleado de la empresa en el periodo afectado. Aparecer no es elegibilidad. Enlazamos solo al administrador oficial. No somos abogados y no reclamamos por ti.',
        ccUpsellTitle: 'Cada semana se abren acuerdos nuevos. Y los plazos cierran rápido.',
        ccUpsellBody: 'Si se te pasa una fecha, ese dinero se pierde para siempre. Activa el monitoreo y te avisamos por correo apenas se abre un acuerdo nuevo donde podrías calificar, para que nunca dejes dinero sobre la mesa.',
        ccUpsellBtn: 'Empezar prueba de 14 días &middot; US$&nbsp;7.99/mes',
        ccUpsellNote: 'Alertas de filtraciones y acuerdos juntas. $39.99/año. Cancela cuando quieras.',
        poolTag: 'El fondo de dinero',
        poolTitle: 'Te ayudamos a reclamar el dinero que las empresas te deben.',
        poolLede: 'Las empresas que filtran datos llegan a acuerdos de demanda colectiva y le pagan a los afectados. Ahora mismo hay acuerdos abiertos para reclamar, y seguimos cada uno. Busca una empresa con la que has tenido trato y mira cuánto están pagando.',
        poolStatOpen: 'abiertos para reclamar ahora',
        poolStatTracked: 'acuerdos en seguimiento',
        poolStatMax: 'por persona, casos abiertos',
        poolBrowse: 'Ver todos los acuerdos &rarr;',
        poolPricing: 'Ver todos los planes y precios &rarr;',
        priceFreeK: 'Chequeo gratis', priceFreeD: 'Tu correo contra las filtraciones. Sin tarjeta.',
        priceReportK: 'Informe Completo', priceReportP: 'pago único', priceReportD: 'Todo lo expuesto + cómo arreglarlo + acuerdos que podrían deberte. Enlaces de reclamo gratis.',
        priceMonK: 'Monitoreo', priceSoon: 'pronto', priceMonP: '/mes &middot; $30/año',
        priceMonD: 'Elige uno: alertas de filtraciones o alertas de acuerdos.',
        priceComboK: 'Combo', priceComboP: '/mes &middot; $50/año',
        priceComboD: 'Ambos: monitoreo de filtraciones y de acuerdos.',
        alertsMissedMax: 'hasta',
        alertsMissedClosed: 'El plazo cerró el',
        alertsMissedNoAmount: 'con acuerdo pagado',
        alertsMissedClaim: 'Reclamar en',
        missedSuitTitle: 'A una de las empresas que filtró tu correo la están demandando.',
        missedSuitLede: 'Todavía no hay dinero que reclamar, pero el caso está vivo. Esto es lo que hay hoy:',
        missedSuitState: 'Demanda en curso',
        missedSuitLink: 'Ver el caso',
        missedNoneTitle: 'Por ahora no hay dinero reclamable en tus filtraciones.',
        missedNoneBody: (casos, abiertas) =>
            `Ninguna de las empresas que filtró tu correo ha pagado un acuerdo todavía. ` +
            `Seguimos ${num(casos)} casos en Estados Unidos y ${num(abiertas)} están en curso ahora mismo. ` +
            `Los acuerdos tardan años en llegar y casi nadie se entera cuando llegan.`,

        // Deliberately in English inside the Spanish copy. It is shown to
        // somebody the server places in the United States who landed here,
        // and it has one job: to be understood by a reader who may not read
        // the page it is sitting on. Its counterpart in the en block is in
        // Spanish, for the same reason and in the other direction.
        langHintText: 'This page is also available in',
        langHintLink: 'English',
        footLeft: '<a href="https://www.am-i-exposed.com/" rel="noopener">Guillermo Carlin</a> · Datos de filtraciones por <a href="https://haveibeenpwned.com/" rel="noopener">Have I Been Pwned</a>',
        footCases: 'Casos y acuerdos',
        footPricing: 'Precios',
        footManage: 'Gestionar suscripción',
        footFaq: 'Preguntas frecuentes',
        footLeaked: 'Si se filtró tu correo',
        footPassword: 'Si se filtró tu contraseña',
        footPrivacy: 'Privacidad',
        footPrivacyUs: 'Privacidad EE.&nbsp;UU.',
        footTerms: 'Términos',

        demoTag: 'Modo de ejemplo',
        demoBody: 'Todo lo que ves abajo son datos ficticios. No se consultó ninguna base de datos real.',
        demoExit: 'Salir del ejemplo',
        demoPrintNotice: 'EJEMPLO — Este reporte se generó con datos ficticios. No corresponde a ninguna persona real.',

        reportBack: '← Volver', reportPdf: 'Descargar PDF',
        modalSigninTitle: 'Entrar', modalSigninBtn: 'Entrar',
        modalSignupTitle: 'Crear cuenta', modalSignupBtn: 'Crear cuenta',
        modalNoAccount: '¿No tienes cuenta?', modalSignupLink: 'Crear una',
        modalHaveAccount: '¿Ya tienes cuenta?', modalSigninLink: 'Entrar',
        modalOr: 'o continúa con',
        modalEmailPlaceholder: 'tucorreo@ejemplo.com',
        modalPwPlaceholder: 'Contraseña',
        modalNewPwPlaceholder: 'Contraseña (mínimo 8 caracteres)',
        modalRepeatPwPlaceholder: 'Repite la contraseña',

        changePw: 'Cambiar contraseña',
        modalForgotLink: '¿Olvidaste tu contraseña?',
        modalResetTitle: 'Recuperar contraseña',
        modalResetHint: 'Escribe tu correo y te enviamos un enlace para poner una contraseña nueva.',
        modalResetBtn: 'Enviar enlace',
        modalBackToSignin: 'Volver a entrar',
        modalNewPwTitle: 'Nueva contraseña',
        modalNewPwHint: 'Elige una contraseña nueva. Necesita al menos 8 caracteres.',
        modalNewPwBtn: 'Guardar contraseña',
        // Says the same thing whether or not the address has an account,
        // so the form cannot be used to find out who is registered.
        okReset: 'Si esa dirección tiene una cuenta, el enlace ya va en camino. Revisa tu correo, incluida la carpeta de spam.',
        okPwChanged: 'Contraseña actualizada. Ya puedes usarla.',
        errPwMismatch: 'Las dos contraseñas no coinciden.',
        errResetFail: 'No pudimos enviar el enlace. Intenta de nuevo en un momento.',
        errResetLimit: 'Se enviaron demasiados correos en la última hora. Espera un rato y vuelve a intentarlo.',
        errPwChangeFail: 'No pudimos cambiar la contraseña. Pide un enlace nuevo e intenta otra vez.',

        errNoEmail: 'Escribe un correo electrónico.',
        errBadEmail: 'Ese correo no parece válido. Revísalo e intenta de nuevo.',
        errEmailFail: 'No pudimos revisar tu correo. Intenta de nuevo en un momento.',
        errNoPw: 'Escribe una contraseña.',
        errPwFail: 'No pudimos revisar la contraseña. Intenta de nuevo en un momento.',
        errFields: 'Completa los dos campos.',
        errShortPw: 'La contraseña debe tener al menos 8 caracteres.',
        errPwnedPw: (n) => `Esa contraseña ya apareció en filtraciones conocidas, ${n.toLocaleString('es')} ${n === 1 ? 'vez' : 'veces'}. Elige otra.`,
        checkingPw: 'Comprobando la contraseña...',
        errBlocked: 'No se puede entrar porque un script necesario fue bloqueado. Desactiva el bloqueador de anuncios para este sitio, o prueba con otro navegador.',
        errSignin: 'No pudimos iniciar sesión. Intenta de nuevo.',
        errBadCreds: 'Correo o contraseña incorrectos. Si no la recuerdas, usa "¿Olvidaste tu contraseña?".',
        errUnconfirmed: 'Falta confirmar tu correo. Busca el mensaje que te enviamos al crear la cuenta.',
        errTooMany: 'Demasiados intentos. Espera unos minutos y vuelve a probar.',
        errEmailTaken: 'Ya existe una cuenta con ese correo. Entra, o usa "¿Olvidaste tu contraseña?".',
        okSignup: 'Cuenta creada. Revisa tu correo para confirmarla y luego entra.',
        okSignupThenBuy: 'Cuenta creada. Confirma el enlace que te mandamos al correo, vuelve a entrar y seguimos con la compra.',

        cleanTitle: 'Buenas noticias: no apareces',
        cleanBody: (email) => `No encontramos <span class="who">${email}</span> en ninguna filtración conocida. Esto no garantiza que nunca pase, así que vale la pena repetir el chequeo de vez en cuando.`,
        expTitle: 'Tu correo está expuesto',
        expBody: (email, n) => `Encontramos <span class="who">${email}</span> en ${n} ${n === 1 ? 'filtración de datos' : 'filtraciones de datos'}. Algunas terminaron en acuerdos que pagaron a los afectados. Mira abajo lo que puedes reclamar.`,
        tallyBreaches: (n) => n === 1 ? 'filtración' : 'filtraciones',
        tallyAccounts: 'cuentas afectadas en total',
        tallyOldest: 'la más antigua',
        lblWhere: 'Dónde apareció tu correo',
        lblExposed: 'Qué se expuso sobre ti',
        inBreaches: (n) => n === 1 ? '1 filtración' : `${n} filtraciones`,
        teaserMore: (n) => n === 1 ? '+1 tipo más en tu Reporte completo' : `+${n} tipos más en tu Reporte completo`,
        owedClaimLabel: 'por reclamar',
        accountsIn: 'cuentas en esta filtración',
        showMore: (n) => n === 1 ? 'Ver 1 filtración más' : `Ver las otras ${n} filtraciones`,
        showAllFree: 'Ver todas las filtraciones gratis · sin tarjeta',
        noDate: 'Fecha no publicada',
        notPublished: 'No publicado',
        stealerFlag: '<b>Esta es la más grave.</b> Un programa malicioso copió contraseñas guardadas directamente de un computador. Si alguna de tus contraseñas se repite en varios sitios, cámbiala hoy.',

        gateTitle: 'Crea una cuenta gratis para ver el detalle',
        gateBody: 'Te mostramos en qué filtraciones apareciste, qué datos se expusieron y desde cuándo. Es gratis y toma menos de un minuto.',
        gateSignup: 'Crear cuenta gratis', gateSignin: 'Ya tengo cuenta',

        nextTitle: 'Te decimos qué hacer, paso a paso',
        nextBody: (n) => `Tenemos un plan ordenado por urgencia para las ${n} ${n === 1 ? 'filtración' : 'filtraciones'} en las que apareces.`,
        nextBtn: 'Ver mi plan',
        buildingPlan: 'Preparando tu plan...',
        planFail: 'No pudimos preparar tu plan. Intenta de nuevo en un momento.',

        pwExpTitle: 'Esta contraseña ya está en manos de terceros',
        pwExpBodyFree: 'Esta contraseña aparece en filtraciones públicas. Cámbiala donde sea que la uses.',
        pwExpBody: (n) => `Apareció <span class="who">${n} veces</span> en listas de contraseñas robadas. Los programas que intentan entrar a cuentas ajenas la prueban de primeras.`,
        pwCleanTitle: 'Esta contraseña no aparece',
        pwCleanBody: 'No la encontramos en ninguna lista de contraseñas robadas. Sigue siendo buena idea no repetirla entre sitios.',
        pwRiskLabel: 'riesgo',
        pwSev: {
            critical: { label: 'Muy alto', summary: 'Es una de las contraseñas más usadas del mundo. Está entre las primeras que prueban los delincuentes, así que cualquier cuenta que la use es muy fácil de abrir.' },
            high:     { label: 'Alto',     summary: 'Esta contraseña está en las listas que los delincuentes se pasan entre ellos para entrar a cuentas ajenas. Dala por pública.' },
            moderate: { label: 'Medio',    summary: 'Esta contraseña se ha escapado más de una vez, así que ya está circulando, aunque no sea de las más comunes.' },
            low:      { label: 'Bajo',     summary: 'Esta contraseña se ha escapado solo unas pocas veces. Aun así es una vez de más, así que no conviene seguir usándola.' },
        },
        pwSteps: [
            'Cámbiala en toda cuenta donde la hayas usado. Empieza por tu correo y después el banco. El correo es lo más importante, porque quien entra ahí puede pedir el cambio de contraseña de todo lo demás.',
            'No la vuelvas a usar en ningún lado. Los delincuentes toman una contraseña que se escapó y la prueban en cientos de sitios, a ver si la repetiste.',
            'Donde el sitio lo ofrezca, activa el segundo paso para entrar. Manda un código corto a tu teléfono después de la contraseña, y mantiene la cuenta segura incluso si alguien ya se sabe esa contraseña.',
            'Deja que tu teléfono o tu navegador recuerde las contraseñas por ti. Así cada sitio puede tener una distinta y no tienes que memorizar ninguna.',
        ],
        pwWhatToDo: 'Qué hacer ahora',
        pwPlanTitleA: 'Esta es una contraseña. ¿Y todo lo demás?',
        pwPlanBodyA: 'Tu plan de acción cubre cada filtración en la que aparece tu correo, qué se llevaron en cada una y qué hacer, en orden.',
        pwPlanBtnA: 'Ver mi plan',
        pwPlanBodyB: 'Revisa también tu correo y te armamos un plan que cubre cada filtración en la que aparece, qué se llevaron y qué hacer.',
        pwPlanBtnB: 'Revisar mi correo también',

        planHeading: 'Lo que quedó expuesto, y cómo protegerte',
        planPreparedFor: 'Preparado para',
        planWhatHappened: 'Qué pasó',
        planWhyMatters: 'Por qué importa',
        planWhatToDo: 'Qué hacer, paso a paso',
        planSummary: (total, actions, criticals) => {
            const b = total === 1 ? 'una empresa' : `${total} empresas`;
            const urgent = criticals === 1 ? 'solo el primero es urgente' : `solo los primeros ${criticals} son urgentes`;
            return `<p><strong>Tu correo apareció en filtraciones de ${b}.</strong></p>`
                + `<p>Ese número asusta, pero es menos grave de lo que parece. Significa que, con los años, ${b} a ${total === 1 ? 'la que' : 'las que'} alguna vez le diste tu correo ${total === 1 ? 'fue' : 'fueron'} atacada${total === 1 ? '' : 's'} por delincuentes. Muchas de esas son viejas y ya no importan.</p>`
                + `<p>No tienes que resolver ${total === 1 ? 'la' : 'las'} ${total}. Hay <strong>${actions} cosas</strong> que vale la pena hacer, y ${urgent}.</p>`
                + `<p>Ve bajando la lista en orden. Cada paso te dice qué pasó, por qué importa y exactamente qué hacer. Si solo alcanzas a hacer ${criticals === 1 ? 'el primero' : `los primeros ${criticals}`}, ya habrás cubierto casi todo el riesgo real.</p>`;
        },
        planReassure: 'Nada de esto es culpa tuya. No puedes evitar que ataquen a las empresas. Solo puedes asegurarte de que no te cueste nada.',
        appendixTitle: 'Anexo: todas las filtraciones en las que apareces',
        appendixLede: 'La lista completa, de la más reciente a la más antigua, para tus registros.',
        appendixCompany: 'Empresa', appendixDate: 'Fecha', appendixTaken: 'Qué se llevaron',
        planFooter: (date) => `Generado por ¿Estoy expuesto? con datos de Have I Been Pwned el ${date}. Esto es orientación general de seguridad, no asesoría legal ni financiera.`,
        teaserNote: 'Aquí va el primer paso completo, para que veas exactamente qué recibes.',
        paywallTitle: (n) => n === 1 ? 'Falta 1 paso más, escrito igual' : `Faltan ${n} pasos más, escritos igual`,
        paywallPitch: 'Al desbloquear recibes tu plan de seguridad completo en palabras normales — qué quedó expuesto y exactamente cómo arreglar cada cosa — además de la guía para reclamar cada acuerdo abierto que tus datos podrían reclamar, y una copia para imprimir o guardar.',
        paywallBtn: 'Desbloquear mi Informe Completo',
        paywallFine: 'Un solo pago. Puedes volver y actualizar tu informe durante 30 días.',

        // Full Report: the settlements half of the paid report.
        claimPackTitle: 'Acuerdos que tus datos podrían reclamar',
        claimPersonalTitle: 'Acuerdos ligados a tu correo',
        claimPersonalLede: (open) => open > 0
            ? 'Tu correo apareció en las filtraciones detrás de estos acuerdos. Los abiertos todavía los puedes reclamar; los demás muestran cuánto ha valido este tipo de exposición.'
            : 'Tu correo apareció en las filtraciones detrás de estos acuerdos. Sus plazos ya cerraron, pero prueban que tus datos estuvieron en el fondo y cuánto valían. Abren acuerdos nuevos todo el tiempo.',
        claimOpenTitle: 'Abiertos ahora mismo',
        claimOpenLede: 'Estos acuerdos en Estados Unidos están abiertos hoy. Puedes reclamar si fuiste cliente, paciente, miembro o empleado de la empresa durante el periodo que cubre. La guía de abajo es cómo reclamarlos bien.',
        claimOpenLine: (n) => n === 1 ? 'Hay 1 acuerdo abierto ahora mismo.' : `Hay ${n} acuerdos abiertos ahora mismo.`,
        claimUpTo: (money) => `hasta ${money}`,
        claimStatusOpen: 'Abierto',
        claimStatusClosed: 'Cerrado',
        claimProofFlat: 'Sin comprobante',
        claimProofNeeded: 'Con comprobante cobras más',
        claimOfficial: 'Sitio oficial de reclamo',
        claimDeadline: (d) => `Reclama antes del ${d}`,
        claimFreeNote: 'Reclamar siempre es gratis. Solo enlazamos al administrador oficial.',
        planSecurityTitle: 'Protégete de aquí en adelante',

        payOpening: 'Abriendo la caja',
        payClose: 'Cerrar',
        payConfirming: 'Confirmando tu pago…',
        payReady: 'Pago confirmado. Tu plan completo ya está disponible.',
        payReadyCheck: 'Pago confirmado. Escribe tu correo arriba y te damos el plan completo.',
        paySlow: 'Tu pago se está procesando. Puede tardar unos minutos; vuelve a entrar con la misma cuenta y tu plan estará listo.',
        payCancelled: 'El pago no se completó. No se cobró nada.',
        payFail: 'No pudimos abrir la caja. Intenta de nuevo en un momento.',
    },
    en: {
        docTitle: 'Check If Your Email Was in a Data Breach | Am I Exposed?',
        brand: 'Am I Exposed?',
        signin: 'Sign in', signout: 'Sign out', menu: 'My account',
        heroTag: 'Free',
        heroBadge: 'No account · No card',
        dailyTag: 'Daily Hack',
        dailyBadge: 'Updated every morning',
        dailyCount: (n) => (n === 1 ? '1 new victim today' : `${num(n)} new victims today`),
        poolHookTag: 'Money Pool',
        poolHookUpTo: 'up to',
        poolHookLabel: 'per person',
        poolHookNew: 'NEW',
        priceHookTag: 'Pricing',
        priceHookLabel: 'See all plans',
        heroTitle: 'You may be owed money. Nobody told you.',
        heroLede: 'When a company leaks your data, in a ransomware attack or an ordinary breach, it often has to pay you. The notice comes by post, looks like junk, and almost nobody claims. Enter your email and we will tell you if there is money you can claim, and what else to do.',
        heroBtn: 'Check my email',
        heroPlaceholder: 'you@example.com',
        checking: 'Checking...',
        trust1: 'Official claim sites only', trust2: 'We never take a cut', trust3: 'Free check: email not stored',

        pwTitle: 'Check a password too',
        pwSub: 'Your password never leaves this device.',
        pwPlaceholder: '••••••••••',
        pwBtn: 'Check', pwShow: 'Show password', pwHide: 'Hide password',
        pwNote: 'We only send the first five letters of a code your browser works out. Neither we nor anyone else can rebuild your password from that.',

        explainBadge: 'Before you start',
        explainTitle: 'What does being exposed actually mean?',
        explainP1: 'When you sign up with a shop, a social network or an online bank, that company stores your details: your email address, sometimes your password, your phone number, your home address.',
        explainP2: "If that company's database is stolen, your details leave it and start circulating in lists that get passed from one stranger to the next. That is what being exposed means: information about you is out there without you knowing.",
        explainP3: 'You did not cause it. The company you trusted with your details did.',
        explainBtn: 'See all the questions',

        offerBadge: 'Full Report',
        offerTitle: "You're exposed. Here's exactly what to do.",
        offerLede: 'A Full Report on your breached email: everything that was exposed, a step-by-step plan to lock your accounts down, and the settlements your data may be owed.',
        offerLi1: 'Everything that was exposed, and how to fix each one',
        offerLi2: 'Your full security plan, step by step, downloadable as a PDF',
        offerLi3: 'Settlements your email may be owed, with free official claim links',
        offerPer: 'one time',
        offerBtn: 'See an example',
        offerBuyBtn: 'Get my Full Report',

        alertsBadge: 'Alerts &middot; US only',
        alertsTitle: 'If a company that leaked your data gets sued, we’ll let you know.',
        alertsLede: 'Companies that lose data end up paying class action settlements. The money is real and almost nobody claims it, because the notice arrives by post and looks like junk mail.',
        alertsLi1: (casos, abiertos) => `<a href="/settlements/" class="alerts-link">${casos} cases tracked, ${abiertos} open to claim now</a>`,
        alertsLi2: 'One note a month, and a separate one when there is something to claim',
        alertsLi3: 'If you live in California, we flag the extra statutory payment',
        alertsFirstName: 'First name', alertsLastName: 'Last name',
        alertsStateLabel: 'State you live in',
        alertsStatePick: 'Choose your state',
        alertsConsent: 'I agree that my name and state may be used to match me against active cases and alert me. I can unsubscribe at any time.',
        alertsPer: 'a month', alertsBtn: 'Turn on alerts',
        alertsOpening: 'Opening…',
        alertsErrName: 'Enter your first and last name.',
        alertsErrState: 'Choose the state you live in.',
        alertsErrConsent: 'Tick the box to continue.',
        alertsErrFail: 'We could not open the payment. Try again in a moment.',
        monitorBadge: 'Monitoring',
        monitorTitle: 'Never miss money again.',
        monitorLede: 'We watch your email and tell you the moment it turns up in a new breach, or a new settlement opens that you could claim.',
        monitorYearlyLabel: 'Pay yearly and save',
        monitorMo: '/mo', monitorYr: '/yr',
        monitorBreachK: 'Breach alerts',
        monitorBreachD: 'Email the moment your address turns up in a new breach.',
        monitorSettlementK: 'Settlement alerts',
        monitorSettlementD: 'Email the moment a new settlement opens that you may be able to claim.',
        monitorComboK: 'Breach + settlement alerts',
        monitorComboD: 'Every new breach that includes your email, and every new settlement you may qualify for.',
        monitorBtn: 'Start 14-day free trial', monitorBtnBoth: 'Turn on both',
        monitorNote: '14-day free trial, cancel anytime. No account needed; we email you to confirm. Claim links are always free.',
        monitorErrEmail: 'Check an email above first to turn on monitoring.',
        alertsActive: 'Your alerts are on.',

        // The matched face. The headline changes because something that
        // already happened persuades better than a promise: "you could have
        // claimed" can be checked, "we will tell you" has to be believed.
        alertsMissedTitle: 'You could already have claimed, and nobody told you.',
        alertsMissedLede: 'Your email appears in breaches that ended in a settlement. This is what they paid, and when the window closed:',
        missedProofTitle: 'Your data has already been worth money.',
        missedProofLede: ({ proofMax, openN, openMax, eligible }) => {
            const paid = proofMax
                ? `These settlements paid people in the class <b>up to ${proofMax} each</b>.`
                : 'These settlements paid people in the class real money.';
            const past = ' Their claim windows have closed, so these aren&rsquo;t yours to take &mdash; but your email keeps turning up in breaches that settle.';
            const pool = (openN && openMax)
                ? ` Right now <b>${openN} are paying out</b>, up to ${openMax} per person, and new ones open every week.`
                : ' New ones open all the time.';
            const hook = eligible
                ? ' Turn on monitoring and we&rsquo;ll email you the moment one matches your address.'
                : '';
            return paid + past + pool + hook;
        },
        missedCtaBtn: 'Turn on monitoring &mdash; catch the next one',
        missedCtaNote: 'New-breach or new-settlement alerts. No account needed, cancel anytime.',
        alertsCaveat: 'Claiming required being in the class, which usually means having received the company&rsquo;s notice letter. Appearing in the breach does not guarantee it. We are not lawyers and we do not claim on your behalf.',
        ccBadge: 'Your claims &middot; US',
        ccTitle: 'Which settlements could you actually claim?',
        ccLede: 'Your email found the breaches. This finds the money. Tick every company you have been a customer, patient or employee of, and we add up what you could claim right now.',
        ccStep2: 'Step 2 &middot; which of these have you used?',
        ccStateLabel: 'State you live in',
        ccNumLabel: 'You could claim',
        ccNumSub: (n) => `across ${n} settlement${n === 1 ? '' : 's'} where you might qualify`,
        ccNumNote: '&ldquo;Up to&rdquo; means the published maximums. Appearing is not a promise of payment.',
        ccClosedTag: 'closed',
        ccClosedWhen: (d) => `closed ${d}`,
        ccNumNoAmount: 'money you might be able to claim',
        ccLockedTitle: 'Open settlements for you',
        ccUnlockedTitle: 'Your settlements, and where to claim',
        ccLockedLede: 'These are the open settlements matched to your email. The official claim links are free.',
        ccPlanOnceK: 'See now', ccPlanOnceP: 'one time',
        ccPlanOnceD: 'Unlock your full list: which companies, the amounts, and the official links to claim today.',
        ccPlanOnceBtn: 'See my settlements',
        ccPlanSubK: 'Monitoring', ccPlanSubP: 'a month &middot; $30/yr',
        ccPlanSubD: 'We watch and tell you the moment a new one opens where you might qualify.',
        ccPlanSubBtn: 'Turn on monitoring',
        ccUnavail: 'Checkout is being set up for your country. Turn on monitoring below and we will email you the moment it is ready.',
        ccCaveat: 'You might qualify if you were a customer, patient or employee in the affected period. Appearing is not eligibility. We link only to the official administrator. We are not lawyers and we never file for you.',
        ccUpsellTitle: 'New settlements open every week. The windows close fast.',
        ccUpsellBody: 'Miss a deadline and that money is gone for good. Turn on monitoring and we will email you the moment a new settlement opens where you might qualify, so you never leave money on the table again.',
        ccUpsellBtn: 'Start 14-day free trial &middot; US$&nbsp;7.99/mo',
        ccUpsellNote: 'Breach and settlement alerts together. $39.99/yr. Cancel anytime.',
        poolTag: 'The money pool',
        poolTitle: 'We help you claim the money companies owe you.',
        poolLede: 'Companies that leak data settle class actions and pay the people affected. Right now there are settlements open to claim, and we track every one. Search a company you have dealt with and see what they are paying.',
        poolStatOpen: 'open to claim now',
        poolStatTracked: 'settlements tracked',
        poolStatMax: 'per person, open cases',
        poolBrowse: 'Browse all settlements &rarr;',
        poolPricing: 'See all plans &amp; pricing &rarr;',
        priceFreeK: 'Free check', priceFreeD: 'Your email vs breaches. No card.',
        priceReportK: 'Full Report', priceReportP: 'one time', priceReportD: 'Everything exposed + how to fix it + settlements you may be owed. Claim links free.',
        priceMonK: 'Monitoring', priceSoon: 'soon', priceMonP: '/mo &middot; $30/yr',
        priceMonD: 'Pick one: new-breach alerts or new-settlement alerts.',
        priceComboK: 'Combo', priceComboP: '/mo &middot; $50/yr',
        priceComboD: 'Both: breach and settlement monitoring.',
        alertsMissedMax: 'up to',
        alertsMissedClosed: 'The window closed on',
        alertsMissedNoAmount: 'settled and paid out',
        alertsMissedClaim: 'Claim at',
        missedSuitTitle: 'One of the companies that leaked your email is being sued.',
        missedSuitLede: 'There is no money to claim yet, but the case is alive. This is where it stands:',
        missedSuitState: 'Lawsuit in progress',
        missedSuitLink: 'See the case',
        missedNoneTitle: 'There is no money to claim on your breaches yet.',
        missedNoneBody: (casos, abiertas) =>
            `None of the companies that leaked your email has paid out a settlement yet. ` +
            `We follow ${num(casos)} United States cases and ${num(abiertas)} are live right now. ` +
            `Settlements take years to arrive, and almost nobody hears about them when they do.`,

        // In Spanish inside the English copy, for the same reason its twin in
        // the es block is in English: it addresses a reader who may not read
        // the page it is sitting on.
        langHintText: 'Esta página también está disponible en',
        langHintLink: 'español',
        footLeft: '<a href="https://www.am-i-exposed.com/" rel="noopener">Guillermo Carlin</a> · Breach data by <a href="https://haveibeenpwned.com/" rel="noopener">Have I Been Pwned</a>',
        footCases: 'Settlements',
        footPricing: 'Pricing',
        footManage: 'Manage subscription',
        footFaq: 'FAQ',
        footLeaked: 'If your email leaked',
        footPassword: 'If your password leaked',
        footPrivacy: 'Privacy',
        footPrivacyUs: 'U.S. privacy',
        footTerms: 'Terms',

        demoTag: 'Preview mode',
        demoBody: 'Everything below is fictional sample data. Nothing was checked against any real database.',
        demoExit: 'Exit preview',
        demoPrintNotice: 'PREVIEW — This report was generated from fictional sample data. It is not a real breach result for any person.',

        reportBack: '← Back', reportPdf: 'Download PDF',
        modalSigninTitle: 'Sign in', modalSigninBtn: 'Sign in',
        modalSignupTitle: 'Create account', modalSignupBtn: 'Create account',
        modalNoAccount: "Don't have an account?", modalSignupLink: 'Create one',
        modalHaveAccount: 'Already have an account?', modalSigninLink: 'Sign in',
        modalOr: 'or continue with',
        modalEmailPlaceholder: 'you@example.com',
        modalPwPlaceholder: 'Password',
        modalNewPwPlaceholder: 'Password (min 8 characters)',
        modalRepeatPwPlaceholder: 'Repeat the password',

        changePw: 'Change password',
        modalForgotLink: 'Forgot your password?',
        modalResetTitle: 'Reset your password',
        modalResetHint: 'Enter your email and we will send you a link to set a new password.',
        modalResetBtn: 'Send the link',
        modalBackToSignin: 'Back to sign in',
        modalNewPwTitle: 'New password',
        modalNewPwHint: 'Choose a new password. It needs at least 8 characters.',
        modalNewPwBtn: 'Save password',
        // Says the same thing whether or not the address has an account,
        // so the form cannot be used to find out who is registered.
        okReset: 'If that address has an account, the link is on its way. Check your email, including the spam folder.',
        okPwChanged: 'Password updated. You can use it now.',
        errPwMismatch: 'The two passwords do not match.',
        errResetFail: 'We could not send the link. Please try again in a moment.',
        errResetLimit: 'Too many emails have been sent in the last hour. Please wait a while and try again.',
        errPwChangeFail: 'We could not change the password. Ask for a new link and try again.',

        errNoEmail: 'Please enter an email address.',
        errBadEmail: 'That email does not look right. Check it and try again.',
        errEmailFail: 'We could not check your email. Please try again in a moment.',
        errNoPw: 'Please enter a password.',
        errPwFail: 'We could not check that password. Please try again in a moment.',
        errFields: 'Please fill in both fields.',
        errShortPw: 'Password must be at least 8 characters.',
        errPwnedPw: (n) => `That password has already turned up in known breaches, ${n.toLocaleString('en')} ${n === 1 ? 'time' : 'times'}. Please choose another.`,
        checkingPw: 'Checking the password...',
        errBlocked: 'Sign-in is unavailable because a required script was blocked. Disable your ad blocker for this site, or try another browser.',
        errSignin: 'Could not start sign-in. Please try again.',
        errBadCreds: 'Wrong email or password. If you cannot remember it, use "Forgot your password?".',
        errUnconfirmed: 'Your email is not confirmed yet. Look for the message we sent when you created the account.',
        errTooMany: 'Too many attempts. Wait a few minutes and try again.',
        errEmailTaken: 'An account with that email already exists. Sign in, or use "Forgot your password?".',
        okSignup: 'Account created. Check your email to confirm, then sign in.',
        okSignupThenBuy: 'Account created. Follow the link we emailed you, sign back in, and we will pick the purchase up from there.',

        cleanTitle: 'Good news: you are not in there',
        cleanBody: (email) => `We did not find <span class="who">${email}</span> in any known breach. That is no guarantee for the future, so it is worth checking again now and then.`,
        expTitle: 'Your email is exposed',
        expBody: (email, n) => `We found <span class="who">${email}</span> in ${n} data ${n === 1 ? 'breach' : 'breaches'}. Some of them ended in settlements that paid people out. See what you can claim below.`,
        tallyBreaches: (n) => n === 1 ? 'breach' : 'breaches',
        tallyAccounts: 'accounts affected in total',
        tallyOldest: 'oldest one',
        lblWhere: 'Where your email showed up',
        lblExposed: 'What was exposed about you',
        inBreaches: (n) => n === 1 ? '1 breach' : `${n} breaches`,
        teaserMore: (n) => n === 1 ? '+1 more type in your Full Report' : `+${n} more types in your Full Report`,
        owedClaimLabel: 'to claim',
        accountsIn: 'accounts in this breach',
        showMore: (n) => n === 1 ? 'Show 1 more breach' : `Show the other ${n} breaches`,
        showAllFree: 'Show me all breaches for free · no credit card',
        noDate: 'Breach date not published',
        notPublished: 'Not published',
        stealerFlag: '<b>This is the serious one.</b> A malicious program copied saved passwords straight off a computer. If you reuse any password across sites, change it today.',

        gateTitle: 'Create a free account to see the detail',
        gateBody: 'We show you which breaches you appeared in, what was exposed and since when. It is free and takes under a minute.',
        gateSignup: 'Create free account', gateSignin: 'I already have an account',

        nextTitle: 'We tell you what to do, step by step',
        nextBody: (n) => `We have a plan ordered by urgency for the ${n} ${n === 1 ? 'breach' : 'breaches'} you appear in.`,
        nextBtn: 'See my plan',
        buildingPlan: 'Building your plan...',
        planFail: 'We could not build your plan. Please try again in a moment.',

        pwExpTitle: "This password is already in other people's hands",
        pwExpBodyFree: 'This password appears in public data breaches. Change it everywhere you use it.',
        pwExpBody: (n) => `It appeared <span class="who">${n} times</span> in stolen password lists. Programs that break into accounts try it first.`,
        pwCleanTitle: 'This password does not show up',
        pwCleanBody: 'We did not find it in any stolen password list. It is still a good idea not to reuse it across sites.',
        pwRiskLabel: 'risk',
        pwSev: {
            critical: { label: 'Critical', summary: 'This is one of the most commonly used passwords in the world. It is among the first ones criminals try, which makes any account using it very easy to break into.' },
            high:     { label: 'High',     summary: 'This password appears on lists that criminals pass around and use to break into accounts. Treat it as public knowledge.' },
            moderate: { label: 'Moderate', summary: 'This password has escaped more than once, so it is out there, even though it is not one of the very common ones.' },
            low:      { label: 'Low',      summary: 'This password has only escaped a few times. That is still once too many, so it is not safe to keep using.' },
        },
        pwSteps: [
            'Change it on every account where you have used it. Start with your email, then your bank. Your email matters most, because anyone who gets into it can reset the password on everything else you own.',
            'Do not use this password anywhere again. Criminals take a password that has escaped and try it on hundreds of other websites, hoping you used it twice.',
            'Where a website offers it, turn on the second step for logging in. It sends a short code to your phone after your password, and keeps the account safe even when somebody already knows that password.',
            'Let your phone or your web browser remember your passwords for you. Then every website can have a different one, and you never have to memorise any of them.',
        ],
        pwWhatToDo: 'What to do now',
        pwPlanTitleA: 'This is one password. What about everything else?',
        pwPlanBodyA: 'Your action plan covers every breach your email appears in, what was taken in each, and what to do about it, in order.',
        pwPlanBtnA: 'See my plan',
        pwPlanBodyB: 'Check your email address as well, and we will build you a plan covering every breach it appears in, what was taken, and what to do about it.',
        pwPlanBtnB: 'Check my email too',

        planHeading: "What was exposed, and how to protect yourself",
        planPreparedFor: 'Prepared for',
        planWhatHappened: 'What happened',
        planWhyMatters: 'Why this matters',
        planWhatToDo: 'What to do, step by step',
        planSummary: (total, actions, criticals) => {
            const urgent = criticals === 1 ? 'only the first is urgent' : `only the first ${criticals} are urgent`;
            return `<p><strong>Your email address was found in ${total} company break-in${total > 1 ? 's' : ''}.</strong></p>`
                + `<p>That number sounds frightening. It is less bad than it looks. It means that over the years, ${total} compan${total > 1 ? 'ies' : 'y'} you once gave your email address to ${total > 1 ? 'were' : 'was'} broken into by criminals. Many of those are old and no longer matter.</p>`
                + `<p>You do not need to deal with all ${total}. There are <strong>${actions} things</strong> worth doing, and ${urgent}.</p>`
                + `<p>Work down the list in order. Each step tells you what happened, why it matters, and exactly what to do. If you only ever do ${criticals === 1 ? 'the first one' : `the first ${criticals}`}, you will have dealt with almost all of the real risk.</p>`;
        },
        planReassure: 'Nothing here is your fault. You cannot stop companies being broken into. You can only make sure it does not cost you anything.',
        appendixTitle: 'Appendix: every break-in you appear in',
        appendixLede: 'The full list, newest first, for your records.',
        appendixCompany: 'Company', appendixDate: 'Date', appendixTaken: 'What was taken',
        planFooter: (date) => `Generated by Am I Exposed? from Have I Been Pwned breach data on ${date}. This is general security guidance, not legal or financial advice.`,
        teaserNote: 'Here is the first step in full, so you can see exactly what you are getting.',
        paywallTitle: (n) => n === 1 ? '1 more step, written the same way' : `${n} more steps, written the same way`,
        paywallPitch: 'Unlocking gives you your full security action plan in plain English — what was exposed and exactly how to fix each one — plus the filing guide for every open settlement your data may be owed, and a copy you can print or save.',
        paywallBtn: 'Unlock my Full Report',
        paywallFine: 'One payment. You can come back and update your report for 30 days.',

        // Full Report: the settlements half of the paid report.
        claimPackTitle: 'Settlements your data may be owed',
        claimPersonalTitle: 'Settlements tied to your email',
        claimPersonalLede: (open) => open > 0
            ? 'Your email was found in the breaches behind these settlements. The open ones you can still claim; the rest show what this kind of exposure has been worth.'
            : 'Your email was found in the breaches behind these settlements. Their claim windows have closed, but they show your data was in the pool and what it was worth. New ones open all the time.',
        claimOpenTitle: 'Open right now',
        claimOpenLede: 'These US settlements are open today. You may be able to claim if you were a customer, patient, member or employee of the company during the period it covers. The guide below is how to claim them well.',
        claimOpenLine: (n) => n === 1 ? 'There is 1 settlement open right now.' : `There are ${n} settlements open right now.`,
        claimUpTo: (money) => `up to ${money}`,
        claimStatusOpen: 'Open',
        claimStatusClosed: 'Closed',
        claimProofFlat: 'No proof needed',
        claimProofNeeded: 'Proof can raise your payout',
        claimOfficial: 'Official claim site',
        claimDeadline: (d) => `Claim by ${d}`,
        claimFreeNote: 'Filing is always free. We only link to the official administrator.',
        planSecurityTitle: 'Protect yourself going forward',

        payOpening: 'Opening the checkout',
        payClose: 'Close',
        payConfirming: 'Confirming your payment…',
        payReady: 'Payment confirmed. Your full plan is ready.',
        payReadyCheck: 'Payment confirmed. Type your email above and we will build your full plan.',
        paySlow: 'Your payment is still processing. It can take a few minutes; come back with the same account and your plan will be waiting.',
        payCancelled: 'The payment was not completed. Nothing was charged.',
        payFail: 'We could not open the checkout. Please try again in a moment.',
    },
};

// The URL decides the language, because each language now has its own page:
// English at / and Spanish at /es/. Reading navigator.language here instead
// would let a browser in English rewrite the Spanish page in place, which is
// what used to happen and is why only one of the two was ever indexable.
let lang = document.documentElement.lang === 'en' ? 'en' : 'es';

// Where this visitor came from, for the daily counters. utm_source when the
// link carried one, otherwise the referring site's host. Worked out once, on
// load, because a later navigation inside the page would lose the referrer.
const visitOrigin = (() => {
    try {
        const utm = new URLSearchParams(location.search).get('utm_source');
        if (utm) return utm.slice(0, 50);
        if (!document.referrer) return 'desconocido';
        const host = new URL(document.referrer).hostname.replace(/^www\./, '');
        // Arriving from our own pages is not an origin.
        return host === location.hostname.replace(/^www\./, '') ? 'desconocido' : host;
    } catch (e) {
        return 'desconocido';
    }
})();

const t = () => COPY[lang];
const locale = () => (lang === 'es' ? 'es-CO' : 'en-US');
const num = (n) => Number(n).toLocaleString(locale());



// El boton rojo del hero. La portada no se regenera cada manana, asi que la
// cifra se pide al cargar en vez de venir escrita en el HTML. Si el archivo
// no esta o la red falla, el boton se queda con su texto fijo: sigue siendo
// el enlace al registro, que es para lo que esta.
let dailyHack = null;

function renderDailyHack() {
    const el = document.getElementById('dailyHackCount');
    if (!el || !dailyHack || !dailyHack.new) return;
    el.textContent = t().dailyCount(dailyHack.new);
}

async function loadDailyHack() {
    try {
        const response = await fetch('/daily-hack.json');
        if (!response.ok) return;
        const data = await response.json();
        if (typeof data.new === 'number') {
            dailyHack = data;
            renderDailyHack();
        }
    } catch (_) {
        // Sin cifra el boton dice "actualizado cada manana", que es cierto.
    }
}

function applyLang() {
    document.documentElement.lang = lang;
    document.title = t().docTitle;

    document.querySelectorAll('[data-i18n]').forEach(el => {
        const value = t()[el.dataset.i18n];
        if (typeof value === 'string') el.innerHTML = value;
    });

    // The written pages have a URL per language. Translating the label
    // without moving the link would send a reader in English to a page in
    // Spanish, which is worse than not offering the link at all.
    document.querySelectorAll('[data-href-es][data-href-en]').forEach(a => {
        a.setAttribute('href', lang === 'es' ? a.dataset.hrefEs : a.dataset.hrefEn);
    });

    document.getElementById('emailInput').placeholder = t().heroPlaceholder;
    document.getElementById('passwordInput').placeholder = t().pwPlaceholder;
    document.getElementById('signinEmail').placeholder = t().modalEmailPlaceholder;
    document.getElementById('signupEmail').placeholder = t().modalEmailPlaceholder;
    document.getElementById('signinPassword').placeholder = t().modalPwPlaceholder;
    document.getElementById('signupPassword').placeholder = t().modalNewPwPlaceholder;
    document.getElementById('resetEmail').placeholder = t().modalEmailPlaceholder;
    document.getElementById('newPassword').placeholder = t().modalNewPwPlaceholder;
    document.getElementById('newPasswordConfirm').placeholder = t().modalRepeatPwPlaceholder;

    // The show/hide label depends on the current input state, not only the
    // language, so it cannot come from the data-i18n sweep above.
    const pwInput = document.getElementById('passwordInput');
    document.getElementById('pwShowToggle').textContent =
        pwInput.type === 'password' ? t().pwShow : t().pwHide;
    document.getElementById('newPwShowToggle').textContent =
        document.getElementById('newPassword').type === 'password' ? t().pwShow : t().pwHide;
    [['signinPassword', 'signinPwShowToggle'],
     ['signupPassword', 'signupPwShowToggle']].forEach(([inputId, toggleId]) => {
        document.getElementById(toggleId).textContent =
            document.getElementById(inputId).type === 'password' ? t().pwShow : t().pwHide;
    });

    // The switch is a pair of links now, one per language, so the current one
    // is aria-current="page" rather than a pressed button.
    document.querySelectorAll('[data-lang]').forEach(a => {
        if (a.dataset.lang === lang) a.setAttribute('aria-current', 'page');
        else a.removeAttribute('aria-current');
    });

    // The currency is written differently in each locale, so the price has
    // to be re-formatted, not just re-inserted.
    renderPrice();

    // The data-i18n sweep above has just overwritten the count with the
    // fixed label, so it has to be written back in the new language.
    renderDailyHack();
    // Same story for the alerts-card count, which is a function fed by the
    // funnel dataset rather than a fixed string.
    renderAlertsCount();
    // The funnel's number and locked list carry amounts and a count, both
    // written per language, so they have to be redrawn after a switch too.
    renderFunnelNumber();
    // The money-pool banner's stats and chips are per-language as well.
    renderPoolStats();
}

// Redraw every rendered region. Used after a language change and after a
// sign-in state change, since both alter what the same data should say.
function rerenderAll() {
    const reportWasOpen = document.getElementById('reportView').classList.contains('active');
    lastReport = null;

    if (lastEmailResult) {
        renderEmailResult(lastEmailResult.breaches, lastEmailResult.email);
    }
    if (lastPasswordCount !== null) {
        renderPasswordExposed(lastPasswordCount);
    }
    refreshMissed();
    if (reportWasOpen) {
        openReport();
    } else {
        closeReport();
    }
}

// Escape HTML to prevent XSS
function escapeHtml(str) {
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// The session token used to travel in the JSON body, as an accessToken field.
// A header is the right place for it: body logging, APM agents and error
// reporters write request bodies down, and they redact Authorization by
// default while knowing nothing about a field called accessToken.
function authHeaders(accessToken) {
    const headers = { 'Content-Type': 'application/json' };
    if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
    return headers;
}

// =======================================================================
// PREVIEW MODE
// =======================================================================
async function startDemo() {
    demoMode = true;
    // hidden has to come off explicitly. Leaving it to the inline display
    // above works only because an inline style outranks the [hidden] rule,
    // which is too subtle a thing to depend on.
    const banner = document.getElementById('demoBanner');
    banner.hidden = false;
    banner.style.display = 'flex';
    document.body.classList.add('demo-active');

    document.getElementById('passwordInput').value = 'sample-password';
    openPasswordFold(true);
    renderPasswordExposed(52372427);

    // The sample data lives on the server alongside the plan engine, so
    // there is only ever one copy of either.
    try {
        const response = await fetch('/api/report', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ demo: true, lang }),
        });
        if (!response.ok) return;
        const data = await response.json();
        // In teaser mode this full response must not be cached, or
        // openReport would reuse it and show the paid view.
        if (!demoTeaser) lastReport = data;
        lastEmailResult = { email: data.email, breaches: data.breaches };
        document.getElementById('emailInput').value = data.email;
        renderEmailResult(data.breaches, data.email);
        refreshPasswordCTA();
    } catch (e) {
        console.error('Demo load failed:', e);
    }
}

function exitDemo() {
    window.location.href = window.location.pathname;
}

// The offer's "see an example" button. Same preview the ?demo= query gives,
// but reached from the page instead of a hand-typed URL.
function openSampleReport() {
    window.location.href = window.location.pathname + '?demo=1&teaser=1';
}

// =======================================================================
// AUTH
// =======================================================================
function initSupabase() {
    if (window.supabase && !window.sbClient) {
        try {
            const { createClient } = window.supabase;
            window.sbClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
        } catch (e) {
            console.error('Supabase init failed:', e);
        }
    }
}

// The Supabase library is loaded from a CDN that ad blockers and corporate
// proxies sometimes block. Without this guard the auth buttons throw an
// uncaught TypeError and appear to do nothing at all.
function requireClient() {
    initSupabase();
    if (window.sbClient) return true;
    showAuthMsg(t().errBlocked, 'bad');
    return false;
}

function showAuthMsg(text, kind) {
    const el = document.getElementById('authError');
    el.textContent = text;
    el.className = 'auth-msg ' + (kind === 'good' ? 'good' : 'bad');
    el.style.display = 'block';
}

function hideAuthMsg() {
    document.getElementById('authError').style.display = 'none';
}

async function initAuth() {
    if (!window.sbClient) return;

    // Keeps the UI in sync with token refreshes, sign-out in another tab,
    // and the redirect back from an OAuth provider.
    window.sbClient.auth.onAuthStateChange((event, session) => {
        const was = !!currentUser;
        currentUser = session?.user ?? null;
        updateAuthUI();
        if (was !== !!currentUser) rerenderAll();

        // Only when somebody has just become signed in, not on every token
        // refresh, and never on the recovery session, which belongs to
        // somebody halfway through getting back into their account.
        if (!was && currentUser && event !== 'PASSWORD_RECOVERY') {
            announceAccount(session.access_token);
            resumePendingPurchase();
        }

        // Following a recovery link signs the visitor in with a session that
        // exists only to let them set a password. Ask for it straight away,
        // because leaving them on the page signed in and none the wiser is
        // how people end up locked out a second time.
        if (event === 'PASSWORD_RECOVERY') {
            try { history.replaceState(null, '', window.location.pathname); } catch (e) { /* ignore */ }
            openAuthModal('newPassword');
        }
    });

    try {
        const { data: { session }, error } = await window.sbClient.auth.getSession();
        if (error) console.error('Auth error:', error);
        currentUser = session?.user ?? null;
        updateAuthUI();
    } catch (e) {
        console.error('InitAuth failed:', e);
    }
}

async function signInWithProvider(provider) {
    if (!requireClient()) return;
    try {
        const { error } = await window.sbClient.auth.signInWithOAuth({
            provider,
            options: { redirectTo: window.location.origin },
        });
        if (error) showAuthMsg(error.message, 'bad');
    } catch (e) {
        showAuthMsg(t().errSignin, 'bad');
    }
}

function updateAuthUI() {
    const authUI = document.getElementById('authUI');
    const userUI = document.getElementById('userUI');

    if (currentUser) {
        authUI.style.display = 'none';
        userUI.style.display = 'block';
        document.getElementById('userEmail').textContent = currentUser.email;
    } else {
        authUI.style.display = 'block';
        userUI.style.display = 'none';
    }

    refreshOfferCard();
}

function openAuthModal(form) {
    document.getElementById('authModal').classList.add('active');
    switchForm(form);
    hideAuthMsg();
}

function closeAuthModal() {
    document.getElementById('authModal').classList.remove('active');
    hideAuthMsg();
    hideAuthPasswords();
}

const AUTH_FORMS = ['signin', 'signup', 'reset', 'newPassword'];

function switchForm(form) {
    AUTH_FORMS.forEach(name => {
        document.getElementById(name + 'Form').classList.remove('active');
    });
    document.getElementById(form + 'Form').classList.add('active');
    hideAuthMsg();

    // Google and GitHub have nothing to do with recovering a password, and
    // offering them there only invites the wrong click.
    const providers = document.getElementById('authProviders');
    providers.style.display = (form === 'reset' || form === 'newPassword') ? 'none' : '';
}

async function sendPasswordReset() {
    const email = document.getElementById('resetEmail').value.trim();
    if (!email) { showAuthMsg(t().errNoEmail, 'bad'); return; }
    if (!requireClient()) return;

    // The link comes back to this same page. Supabase puts a recovery
    // session in the URL fragment, which the client picks up and reports
    // through onAuthStateChange below.
    const redirectTo = window.location.origin + window.location.pathname;

    try {
        const { error } = await window.sbClient.auth.resetPasswordForEmail(email, { redirectTo });
        if (error) {
            console.error('Reset request failed:', error.message);
            // Being rate limited says nothing about whether the address has
            // an account, so it can be reported plainly. Telling somebody
            // the link is on its way when nothing was sent leaves them
            // refreshing an inbox for a mail that is never coming.
            const limited = error.status === 429
                || /rate limit/i.test(error.message || '');
            if (limited) { showAuthMsg(t().errResetLimit, 'bad'); return; }
            // Any other failure is reported the same way as a success on
            // purpose. Supabase says whether an address is registered, and
            // relaying that would turn this form into a way of checking who
            // has an account.
        }
    } catch (e) {
        showAuthMsg(t().errResetFail, 'bad');
        return;
    }
    showAuthMsg(t().okReset, 'good');
    document.getElementById('resetEmail').value = '';
    // Long enough to read, then out of the way. There is nothing else to do
    // on this form once the link has been sent.
    setTimeout(closeAuthModal, 5000);
}

// Used both after following a recovery link and from the account menu. In
// either case Supabase only accepts the change with a live session, which
// is what stands in for asking the old password.
// A site that exists to tell people their passwords were leaked has no
// business accepting a leaked password. This follows NIST 800-63B: a length
// floor and a check against known breaches, instead of composition rules
// about symbols and capitals, which mostly produce Password1! and are no
// stronger for it.
const MIN_PASSWORD = 8;

async function passwordProblem(password) {
    if (password.length < MIN_PASSWORD) return t().errShortPw;
    try {
        const count = await checkPasswordWithKAnonymity(password);
        if (count > 0) return t().errPwnedPw(count);
    } catch (e) {
        // Fails open on purpose. If Have I Been Pwned is unreachable, the
        // length floor still applies, and locking somebody out of their own
        // account over a third party being down would be worse.
        console.error('Breach check unavailable:', e.name);
    }
    return null;
}

async function applyNewPassword() {
    const password = document.getElementById('newPassword').value;
    const confirm = document.getElementById('newPasswordConfirm').value;

    if (!password || !confirm) { showAuthMsg(t().errFields, 'bad'); return; }
    if (password !== confirm) { showAuthMsg(t().errPwMismatch, 'bad'); return; }
    if (!requireClient()) return;

    showAuthMsg(t().checkingPw, 'good');
    const problem = await passwordProblem(password);
    if (problem) { showAuthMsg(problem, 'bad'); return; }

    try {
        const { error } = await window.sbClient.auth.updateUser({ password });
        if (error) { showAuthMsg(error.message || t().errPwChangeFail, 'bad'); return; }
    } catch (e) {
        showAuthMsg(t().errPwChangeFail, 'bad');
        return;
    }

    document.getElementById('newPassword').value = '';
    document.getElementById('newPasswordConfirm').value = '';
    showAuthMsg(t().okPwChanged, 'good');
    setTimeout(closeAuthModal, 2000);
}

function openChangePassword() {
    document.getElementById('userDropdown').classList.remove('active');
    openAuthModal('newPassword');
}

function toggleUserMenu() {
    document.getElementById('userDropdown').classList.toggle('active');
}

// Supabase answers in English, with wording aimed at whoever built the site
// rather than whoever is trying to get into their account. These are the
// cases that actually reach people; anything else falls back to a generic
// line and the real text goes to the console, where it is of some use.
function authErrorMessage(error) {
    const raw = (error && error.message) || '';
    const status = error && error.status;

    if (status === 429 || /rate limit|too many/i.test(raw)) return t().errTooMany;
    if (/invalid login credentials/i.test(raw))              return t().errBadCreds;
    if (/email not confirmed|not confirmed/i.test(raw))      return t().errUnconfirmed;
    if (/already registered|already exists/i.test(raw))      return t().errEmailTaken;
    if (/at least \d+ characters|password.*short/i.test(raw)) return t().errShortPw;
    if (/validate email|invalid format/i.test(raw))          return t().errBadEmail;

    console.error('Auth error:', raw);
    return t().errSignin;
}

// Lets the server know an account exists, so it can reach the CRM. Sign-up and
// sign-in never touch our server otherwise, and nothing the visitor is doing
// should wait on this, so it is not awaited and its failures stay in the
// console. Once per page load: a token refresh is not a new account.
// Keyed on the account and kept in localStorage, which other tabs can see.
// Two tabs open at once each announced the same sign-in, and both reached
// Zoho before either had written anything, so the person was created twice.
let accountAnnounced = false;

function announceAccount(accessToken) {
    if (accountAnnounced || !accessToken) return;

    // The "2" is a reset. The previous key was written before the request
    // was made, so every account that signed in while the CRM was down got
    // marked as announced anyway, and would never have been sent again from
    // that browser. Changing the name retires all of those marks and gives
    // each of them one more attempt.
    const key = currentUser ? `aie-announced2-${currentUser.id}` : null;
    try {
        if (key && localStorage.getItem(key)) { accountAnnounced = true; return; }
    } catch (e) { /* private browsing; the server-side mark still holds */ }

    // In memory immediately, on disk only after the server says it worked.
    // The first stops this tab asking twice. Not writing the second until
    // there is something to remember is the whole fix: a failure recorded as
    // a success is a customer who never reaches the CRM and no sign that
    // anything went wrong.
    accountAnnounced = true;

    fetch('/api/account-sync', {
        method: 'POST',
        headers: authHeaders(accessToken),
        body: JSON.stringify({ lang }),
    }).then(async response => {
        // synced, not ok. The endpoint answers 200 whether or not the CRM
        // took the record, and it is the CRM that this mark is about.
        const body = response.ok ? await response.json().catch(() => null) : null;
        if (body?.synced) {
            try {
                if (key) localStorage.setItem(key, '1');
            } catch (e) { /* ignore */ }
            return;
        }
        // Left unmarked on purpose, so the next visit tries again.
        console.error('Account not synced:', response.status);
    }).catch(e => {
        console.error('Account sync failed:', e.name);
    });
}

async function signInWithEmail() {
    // Trimmed because a trailing space from autofill or a phone keyboard is
    // invisible, and the only thing that comes back is "wrong password".
    const email = document.getElementById('signinEmail').value.trim();
    const password = document.getElementById('signinPassword').value;

    if (!email || !password) { showAuthMsg(t().errFields, 'bad'); return; }
    if (!requireClient()) return;

    const { data, error } = await window.sbClient.auth.signInWithPassword({ email, password });

    if (error) {
        showAuthMsg(authErrorMessage(error), 'bad');
    } else {
        currentUser = data.user;
        updateAuthUI();
        closeAuthModal();
        document.getElementById('signinEmail').value = '';
        document.getElementById('signinPassword').value = '';
        // Setting currentUser here can beat onAuthStateChange to it, which
        // would make the sign-in look like it was already in progress and
        // skip the resume. Asking twice is harmless; the flag sees to that.
        resumePendingPurchase();
    }
}

async function signUpWithEmail() {
    const email = document.getElementById('signupEmail').value.trim();
    const password = document.getElementById('signupPassword').value;

    if (!email || !password) { showAuthMsg(t().errFields, 'bad'); return; }
    if (!requireClient()) return;

    showAuthMsg(t().checkingPw, 'good');
    const problem = await passwordProblem(password);
    if (problem) { showAuthMsg(problem, 'bad'); return; }

    // The language travels with the account so the CRM, and anything written
    // to this person later, knows which one to use. It is the only thing we
    // know about them beyond the address.
    const { data, error } = await window.sbClient.auth.signUp({
        email,
        password,
        options: { data: { lang } },
    });

    if (error) { showAuthMsg(authErrorMessage(error), 'bad'); return; }

    // When email confirmation is enabled, signUp returns a user but no
    // session. The account is not usable yet, so it must not unlock gated
    // content: only a real session counts as signed in.
    if (data.session) {
        currentUser = data.session.user;
        updateAuthUI();
        closeAuthModal();
        document.getElementById('signupEmail').value = '';
        document.getElementById('signupPassword').value = '';
        resumePendingPurchase();
        return;
    }

    // No session means email confirmation is switched on in Supabase, so the
    // account is not usable yet. Somebody who was on their way to paying
    // needs telling that, rather than being left looking at a modal that
    // closed and a purchase that never happened.
    if (pendingPurchase) {
        showAuthMsg(t().okSignupThenBuy, 'good');
        document.getElementById('signupEmail').value = '';
        document.getElementById('signupPassword').value = '';
        return;
    }

    showAuthMsg(t().okSignup, 'good');
    document.getElementById('signupEmail').value = '';
    document.getElementById('signupPassword').value = '';
}

async function signOut() {
    if (window.sbClient) {
        await window.sbClient.auth.signOut();
    }
    currentUser = null;
    updateAuthUI();
    rerenderAll();
    document.getElementById('userDropdown').classList.remove('active');
}

// =======================================================================
// SHARED PIECES
// =======================================================================
const ICON_BAD  = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 8v5.4" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/><circle cx="12" cy="17.2" r="1.4" fill="currentColor"/></svg>';
const ICON_GOOD = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M19 7.5l-8.4 9L5 11" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_WARN = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 8.4v5" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/><circle cx="12" cy="16.6" r="1.3" fill="currentColor"/></svg>';
const ICON_LOCK = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="2.8" y="7" width="10.4" height="6.6" rx="1.8" stroke="currentColor" stroke-width="1.5"/><path d="M5.4 7V5.2a2.6 2.6 0 015.2 0V7" stroke="currentColor" stroke-width="1.5"/></svg>';
const ICON_CLOCK = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="6.4" stroke="currentColor" stroke-width="1.5"/><path d="M8 4.6V8l2.3 1.4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';

function siteName(breach) {
    return breach.title || breach.name || (lang === 'es' ? 'una filtración sin nombre' : 'an unnamed breach');
}

const PRIORITY_LABEL = {
    es: { critical: 'Hazlo primero', high: 'Esta semana', medium: 'Este mes' },
    en: { critical: 'Do this first', high: 'Do this week', medium: 'Do this month' },
};

// These domains come from HIBP and are turned into clickable links, so
// accept only a plain hostname. Anything else (a javascript: payload, an
// embedded path or credentials) is rendered as inert text instead.
function safeDomain(raw) {
    if (!raw) return null;
    const value = String(raw).trim().toLowerCase();
    return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(value) && value.length <= 253
        ? value
        : null;
}

// HIBP returns BreachDate as YYYY-MM-DD, or omits it on a few old records.
function formatBreachDate(raw) {
    if (!raw) return null;
    const parts = String(raw).split('-');
    if (parts.length !== 3) return String(raw);
    const date = new Date(Date.UTC(+parts[0], +parts[1] - 1, +parts[2]));
    if (isNaN(date.getTime())) return String(raw);
    return date.toLocaleDateString(locale(), {
        year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC',
    });
}

function todayLong() {
    return new Date().toLocaleDateString(locale(), { year: 'numeric', month: 'long', day: 'numeric' });
}

// A data class naming a password is the one that decides urgency, so it is
// the only chip that gets colour. Matched against the English label, which
// is what HIBP sends, before any translation below.
function isPasswordClass(label) {
    return /password/i.test(String(label));
}

// HIBP sends its data classes in English only. Left untranslated they are
// the part of a Spanish result a non-technical reader most needs to
// understand, so the common ones are mapped here. Anything not listed
// falls through as the original label rather than being dropped.
const DATA_CLASS_ES = {
    'Email addresses': 'Correos electrónicos',
    'Passwords': 'Contraseñas',
    'Historical passwords': 'Contraseñas anteriores',
    'Password hints': 'Pistas de contraseña',
    'Usernames': 'Nombres de usuario',
    'Names': 'Nombres',
    'Phone numbers': 'Números de teléfono',
    'Physical addresses': 'Direcciones físicas',
    'Geographic locations': 'Ubicación geográfica',
    'Dates of birth': 'Fechas de nacimiento',
    'Genders': 'Género',
    'IP addresses': 'Direcciones IP',
    'Security questions and answers': 'Preguntas y respuestas de seguridad',
    'Credit cards': 'Tarjetas de crédito',
    'Credit card CVV': 'Código CVV de la tarjeta',
    'Partial credit card data': 'Datos parciales de tarjeta',
    'Bank account numbers': 'Números de cuenta bancaria',
    'Payment histories': 'Historial de pagos',
    'Historical payment information': 'Información de pagos anteriores',
    'Government issued IDs': 'Documentos de identidad',
    'Social security numbers': 'Números de seguridad social',
    'National identification numbers': 'Números de identificación nacional',
    'Passport numbers': 'Números de pasaporte',
    "Driver's licenses": 'Licencias de conducir',
    'Tax records': 'Registros tributarios',
    'Health insurance information': 'Información de seguro de salud',
    'Medical conditions': 'Condiciones médicas',
    'Medical records': 'Historias clínicas',
    'Job titles': 'Cargos',
    'Employers': 'Empleadores',
    'Occupations': 'Ocupaciones',
    'Salutations': 'Tratamientos de cortesía',
    'Social media profiles': 'Perfiles de redes sociales',
    'Website activity': 'Actividad en el sitio',
    'Browsing histories': 'Historial de navegación',
    'Browser user agent details': 'Datos del navegador',
    'Device information': 'Información del dispositivo',
    'Purchases': 'Compras',
    'Purchasing habits': 'Hábitos de compra',
    'Private messages': 'Mensajes privados',
    'Chat logs': 'Conversaciones de chat',
    'Support tickets': 'Tickets de soporte',
    'Profile photos': 'Fotos de perfil',
    'Avatars': 'Avatares',
    'Spoken languages': 'Idiomas',
    'Nationalities': 'Nacionalidades',
    'Time zones': 'Zonas horarias',
    'Account balances': 'Saldos de cuenta',
    'Login histories': 'Historial de inicios de sesión',
    'Recovery email addresses': 'Correos de recuperación',
    'Relationship statuses': 'Estado sentimental',
    'Marital statuses': 'Estado civil',
    'Family members\' names': 'Nombres de familiares',
    'Education levels': 'Nivel educativo',
    'Income levels': 'Nivel de ingresos',
    'Political views': 'Opiniones políticas',
    'Religions': 'Religión',
    'Sexual orientations': 'Orientación sexual',
    'Physical attributes': 'Características físicas',
    'Biometric data': 'Datos biométricos',
    'Vehicle details': 'Datos del vehículo',
    'Utility bills': 'Facturas de servicios',
    'Personal descriptions': 'Descripciones personales',
    'Age groups': 'Rango de edad',
    'Social connections': 'Contactos',
    'SMS messages': 'Mensajes de texto',
    'Survey results': 'Respuestas de encuestas',
    'User website URLs': 'Direcciones de sitios del usuario',
};

function dataClassLabel(raw) {
    if (lang !== 'es') return raw;
    return DATA_CLASS_ES[raw] || raw;
}

// =======================================================================
// EMAIL CHECK
// =======================================================================
async function checkEmail() {
    const email = document.getElementById('emailInput').value.trim();
    const btn = document.getElementById('emailCheckBtn');
    const resultDiv = document.getElementById('emailResult');
    const errorDiv = document.getElementById('emailError');

    if (!email) {
        errorDiv.textContent = t().errNoEmail;
        errorDiv.style.display = 'block';
        resultDiv.style.display = 'none';
        return;
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        errorDiv.textContent = t().errBadEmail;
        errorDiv.style.display = 'block';
        resultDiv.style.display = 'none';
        return;
    }

    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span>' + escapeHtml(t().checking);
    errorDiv.style.display = 'none';
    resultDiv.style.display = 'none';

    try {
        // POST, not GET: a query string would put the user's email into
        // Vercel's access logs, which contradicts the promise above.
        const response = await fetch('/api/check-email', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, lang, origen: visitOrigin }),
        });
        const data = await response.json();

        if (!response.ok) throw new Error(data.error || t().errEmailFail);

        if (data.found) {
            lastEmailResult = { email, breaches: data.breaches };
            lastReport = null;
            renderEmailResult(data.breaches, email);
        } else {
            lastEmailResult = null;
            lastReport = null;
            renderCleanEmail(email);
        }
        hasSearched = true;
        refreshPasswordCTA();
        refreshOfferCard();
        // The result is the whole point of the visit, but it renders below the
        // hero and the Money Pool section, far enough down that a visitor can
        // type an email, watch the page not move, and assume nothing happened.
        // Bring it to the top of the viewport so it lands as the alert it is;
        // the claim-now money card and the regret strip sit right beneath it.
        // rAF lets the display:block set during render lay out before we measure.
        requestAnimationFrame(() => {
            const top = resultDiv.getBoundingClientRect().top + window.pageYOffset - 16;
            window.scrollTo({ top: top < 0 ? 0 : top, behavior: 'smooth' });
        });
    } catch (error) {
        errorDiv.textContent = error.message || t().errEmailFail;
        errorDiv.style.display = 'block';
        resultDiv.style.display = 'none';
    } finally {
        btn.disabled = false;
        btn.textContent = t().heroBtn;
    }
}

function renderCleanEmail(email) {
    const resultDiv = document.getElementById('emailResult');
    resultDiv.innerHTML = `
        <div class="card">
            <div class="verdict">
                <div class="verdict-icon good">${ICON_GOOD}</div>
                <div>
                    <h2>${escapeHtml(t().cleanTitle)}</h2>
                    <p>${t().cleanBody(escapeHtml(email))}</p>
                </div>
            </div>
        </div>`;
    resultDiv.style.display = 'block';

    // No breaches, so no breach list below the money card.
    const blockDiv = document.getElementById('breachListBlock');
    if (blockDiv) { blockDiv.innerHTML = ''; blockDiv.style.display = 'none'; }
}

function renderEmailResult(breaches, email) {
    const resultDiv = document.getElementById('emailResult');
    const count = breaches.length;
    const unlocked = isUnlocked();

    // Which breaches you are in is free. What leaked in each one is gated.
    // A heavily exposed address can return hundreds of breaches, so the whole
    // list is folded behind one button and rendered below the money card: the
    // first thing under the verdict is whether there is money to claim, not a
    // wall of breach names.
    const breachCard = (breach) => {
        const label = siteName(breach);
        const when = formatBreachDate(breach.breachDate);
        const classes = Array.isArray(breach.dataClasses) ? breach.dataClasses : [];
        const domain = safeDomain(breach.domain);

        const domainHTML = domain
            ? `<a class="breach-url" href="https://${domain}" target="_blank" rel="noopener noreferrer nofollow">${escapeHtml(domain)}</a>`
            : (breach.domain ? `<span class="breach-url">${escapeHtml(breach.domain)}</span>` : '');

        const scaleHTML = unlocked && breach.pwnCount
            ? ` &middot; <b>${num(breach.pwnCount)}</b> ${escapeHtml(t().accountsIn)}`
            : '';

        const chipsHTML = unlocked && classes.length
            ? `<div class="chips">${classes.map(c =>
                `<span class="chip${isPasswordClass(c) ? ' hot' : ''}">${escapeHtml(dataClassLabel(c))}</span>`).join('')}</div>`
            : '';

        const flagHTML = unlocked && breach.isStealerLog
            ? `<div class="flag">${ICON_WARN}<span>${t().stealerFlag}</span></div>`
            : '';

        return `
            <div class="breach">
                <div class="breach-top">
                    <span class="breach-name">${escapeHtml(label)}</span>
                    ${domainHTML}
                </div>
                <div class="breach-meta">${when ? escapeHtml(when) : escapeHtml(t().noDate)}${scaleHTML}</div>
                ${chipsHTML}
                ${flagHTML}
            </div>`;
    };

    const breachListHTML = `
        <div class="section-lbl">${escapeHtml(t().lblWhere)}</div>
        <button type="button" class="more-btn" data-action="showAllBreaches">${escapeHtml(t().showAllFree)}</button>
        <div id="breachRest" hidden>${breaches.map(breachCard).join('')}</div>`;

    // Roll-up: how many breaches exposed each kind of data.
    let rollupHTML = '';
    if (unlocked) {
        const tally = new Map();
        breaches.forEach(b => {
            (Array.isArray(b.dataClasses) ? b.dataClasses : []).forEach(c => {
                tally.set(c, (tally.get(c) || 0) + 1);
            });
        });
        const ranked = [...tally.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
        if (ranked.length) {
            rollupHTML = `
                <div class="section-lbl">${escapeHtml(t().lblExposed)}</div>
                <div class="rollup">
                    ${ranked.map(([name, n]) => `
                        <div class="rollup-row">
                            <span>${escapeHtml(dataClassLabel(name))}</span>
                            <span class="rollup-count">${escapeHtml(t().inBreaches(n))}</span>
                        </div>`).join('')}
                </div>`;
        }
    }

    let tallyHTML = '';
    if (unlocked) {
        const totalAccounts = breaches.reduce((s, b) => s + (Number(b.pwnCount) || 0), 0);
        const dates = breaches.map(b => b.breachDate).filter(Boolean).sort();
        const oldestYear = dates.length ? String(dates[0]).slice(0, 4) : null;
        tallyHTML = `
            <div class="tally">
                <div class="tally-box">
                    <div class="tally-num bad">${num(count)}</div>
                    <div class="tally-lbl">${escapeHtml(t().tallyBreaches(count))}</div>
                </div>
                ${totalAccounts ? `
                <div class="tally-box">
                    <div class="tally-num">${num(totalAccounts)}</div>
                    <div class="tally-lbl">${escapeHtml(t().tallyAccounts)}</div>
                </div>` : ''}
                ${oldestYear ? `
                <div class="tally-box">
                    <div class="tally-num">${escapeHtml(oldestYear)}</div>
                    <div class="tally-lbl">${escapeHtml(t().tallyOldest)}</div>
                </div>` : ''}
            </div>`;
    }

    const nextHTML = unlocked ? `
        <div class="nextstep">
            <p><strong>${escapeHtml(t().nextTitle)}.</strong> ${escapeHtml(t().nextBody(count))}</p>
            <button class="btn sm accent" data-action="openReport">${escapeHtml(t().nextBtn)}</button>
        </div>` : '';

    const gateHTML = unlocked ? '' : `
        <div class="gate">
            <h3>${escapeHtml(t().gateTitle)}</h3>
            <p>${escapeHtml(t().gateBody)}</p>
            <div class="gate-btns">
                <button class="btn sm" data-action="openAuthModal" data-arg="signup">${escapeHtml(t().gateSignup)}</button>
                <button class="ghost-btn" data-action="openAuthModal" data-arg="signin">${escapeHtml(t().gateSignin)}</button>
            </div>
        </div>`;

    // Anonymous visitors do not get the full per-class rollup (gated above for
    // signed-in users), but a short teaser of the top data types leaked gives
    // them real free value that makes the Full Report below worth $5. The
    // per-breach chips and the stealer flags stay gated; only this aggregate
    // top-3 is surfaced.
    let teaserHTML = '';
    let owedHTML = '';
    if (!unlocked) {
        const tally = new Map();
        breaches.forEach(b => {
            (Array.isArray(b.dataClasses) ? b.dataClasses : []).forEach(c => {
                tally.set(c, (tally.get(c) || 0) + 1);
            });
        });
        const ranked = [...tally.entries()].sort((a, b) => b[1] - a[1]);
        if (ranked.length) {
            const top = ranked.slice(0, 3);
            const moreCount = ranked.length - top.length;
            teaserHTML = `
                <div class="section-lbl">${escapeHtml(t().lblExposed)}</div>
                <div class="rollup teaser">
                    ${top.map(([name, n]) => `
                        <div class="rollup-row">
                            <span>${escapeHtml(dataClassLabel(name))}</span>
                            <span class="rollup-count">${escapeHtml(t().inBreaches(n))}</span>
                        </div>`).join('')}
                </div>
                ${moreCount > 0 ? `<p class="teaser-more">${escapeHtml(t().teaserMore(moreCount))}</p>` : ''}`;
        }
        // The settlements money hook: "up to $X to claim", the same pool maximum
        // the public money-pool banner shows (never a per-user promise), routed
        // to the on-page money/monitoring target. Number from funnelData so it
        // never drifts from the banner; a static fallback until that loads.
        const owedNum = funnelData && funnelData.meta && funnelData.meta.maxPorPersona
            ? poolMoney(funnelData.meta.maxPorPersona) : '$5,050';
        owedHTML = `
            <button type="button" class="owed-tile" data-action="goClaim">
                <span class="owed-tile-main">
                    <span class="owed-tile-up">${escapeHtml(t().poolHookUpTo)}</span>
                    <span class="owed-tile-num" id="resultOwedNum">${escapeHtml(owedNum)}</span>
                    <span class="owed-tile-lbl">${escapeHtml(t().owedClaimLabel)}</span>
                </span>
                <span class="owed-tile-arrow" aria-hidden="true">&rarr;</span>
            </button>`;
    }

    resultDiv.innerHTML = `
        <div class="card">
            <div class="verdict">
                <div class="verdict-icon bad">${ICON_BAD}</div>
                <div>
                    <h2>${escapeHtml(t().expTitle)}</h2>
                    <p>${t().expBody(escapeHtml(email), count)}</p>
                </div>
            </div>
            ${tallyHTML}
            ${rollupHTML}
            ${teaserHTML}
            ${owedHTML}
            ${nextHTML}
            ${gateHTML}
        </div>`;
    resultDiv.style.display = 'block';

    // The breach list lives in its own block below the money card, so the first
    // thing under the verdict is whether there is money to claim. The whole list
    // is folded behind one free-to-open button.
    const blockDiv = document.getElementById('breachListBlock');
    if (blockDiv) {
        blockDiv.innerHTML = breachListHTML;
        blockDiv.style.display = 'block';
    }
}

function showAllBreaches(btn) {
    const rest = document.getElementById('breachRest');
    if (rest) rest.hidden = false;
    btn.remove();
}

// =======================================================================
// ACTION PLAN
// The plan is built on the server (/api/report) so that paid text never
// reaches an unpaid browser. Only display helpers live here.
// =======================================================================
async function openReport() {
    if (!lastEmailResult && !demoMode) return;

    const view = document.getElementById('reportView');
    document.getElementById('reportBody').innerHTML =
        `<div class="report-loading"><span class="spinner"></span>${escapeHtml(t().buildingPlan)}</div>`;
    view.classList.add('active');
    document.body.style.overflow = 'hidden';
    view.scrollTop = 0;

    let data = lastReport;
    // A cached plan is only reusable for the same address AND the same
    // language, since the server writes the prose in the language it is
    // given.
    const needsFetch = !data
        || data.lang !== lang
        || (!demoMode && data.email !== lastEmailResult.email);

    if (needsFetch) {
        try {
            let accessToken = null;
            if (window.sbClient) {
                const { data: { session } } = await window.sbClient.auth.getSession();
                accessToken = session?.access_token || null;
            }
            const response = await fetch('/api/report', {
                method: 'POST',
                headers: authHeaders(accessToken),
                body: JSON.stringify(demoMode
                    ? { demo: true, teaser: demoTeaser, lang }
                    : { email: lastEmailResult.email, lang }),
            });
            data = await response.json();
            if (!response.ok) throw new Error(data.error || t().planFail);
            lastReport = data;
        } catch (error) {
            document.getElementById('reportBody').innerHTML =
                `<div class="report-loading">${escapeHtml(error.message || t().planFail)}</div>`;
            return;
        }
    }

    const entitled = data.entitled === true;
    document.getElementById('reportBody').innerHTML = entitled
        ? fullReportHTML(data)
        : teaserHTML(data);

    // Offering "Download PDF" on a paywall makes no sense.
    document.getElementById('reportPrintBtn').style.display = entitled ? '' : 'none';

    if (entitled) hideOffer();
}

// The offer card only appears once an address has actually come back exposed.
// Selling a plan of action to somebody who has not checked anything yet, or
// who checked and came back clean, is selling them a solution to a problem
// they do not have. So it starts hidden, in the markup rather than here, and
// a clean result puts it away again.
//
// It also stays down once they have an account, because from then on the
// paywall inside their own report makes the same case with their own data,
// and two pitches on one page read as a mistake. Once bought, it is gone for
// good.
function refreshOfferCard() {
    const card = document.getElementById('offerCard');
    // priceInfo is set directly now (a fixed US$5), so it is never null in
    // practice; the guard stays so the card hides rather than showing
    // "&mdash; per report" over a buy button if that ever changes.
    if (card) {
        card.hidden = !lastEmailResult || !!currentUser || knownEntitled
            || (priceChecked && !priceInfo);
    }

    // The explainer answers "what does this even mean", which is a question
    // people have before they check. Once there is a result on the page, of
    // either kind, it has been overtaken: a breach puts the plan next, and a
    // clean result ends the matter. So it belongs only to the page nobody has
    // asked anything of yet.
    const explain = document.getElementById('explainCard');
    if (explain) explain.hidden = hasSearched;

    // Not awaited: it asks the server whether this visitor is in the United
    // States, and the rest of the page has no reason to wait for that.
    refreshAlertsCard();
    // Esta no pregunta nada al servidor y no depende del pais: sale para
    // todo el mundo en cuanto hay un resultado.
    refreshMissed();
    // El funnel de cross-check (Paso 2 + numero + lista bloqueada). Mismo gate
    // que la tarjeta de alertas; no bloquea a la tarjeta gratis de arriba.
    refreshFunnel();
}

function hideOffer() {
    knownEntitled = true;
    refreshOfferCard();
}

// =======================================================================
// ALERT SUBSCRIPTION
//
// Offered only to visitors the server places in the United States, because
// the thing being sold is notice of United States class action settlements.
// The country is decided in /api/alerts-config and never comes back to the
// page: the answer is eligible or not, and the page cannot tell the
// difference between "you are in Peru" and "this is not configured yet".
// =======================================================================

// Written out rather than fetched: it is fifty one strings that have not
// changed since 1959 and are the same in both languages.
const US_STATES = [
    'Alabama', 'Alaska', 'Arizona', 'Arkansas', 'California', 'Colorado',
    'Connecticut', 'Delaware', 'District of Columbia', 'Florida', 'Georgia',
    'Hawaii', 'Idaho', 'Illinois', 'Indiana', 'Iowa', 'Kansas', 'Kentucky',
    'Louisiana', 'Maine', 'Maryland', 'Massachusetts', 'Michigan',
    'Minnesota', 'Mississippi', 'Missouri', 'Montana', 'Nebraska', 'Nevada',
    'New Hampshire', 'New Jersey', 'New Mexico', 'New York',
    'North Carolina', 'North Dakota', 'Ohio', 'Oklahoma', 'Oregon',
    'Pennsylvania', 'Rhode Island', 'South Carolina', 'South Dakota',
    'Tennessee', 'Texas', 'Utah', 'Vermont', 'Virginia', 'Washington',
    'West Virginia', 'Wisconsin', 'Wyoming',
];

let alertsConfig = null;      // null until asked, then {eligible, plans}
// La promesa, no un booleano. Marcar "ya preguntado" antes de que llegue la
// respuesta hacia que una segunda llamada devolviera null mientras la primera
// seguia en vuelo, y quien la recibia leia .eligible de null. Guardar la
// promesa hace que la segunda espere a la misma peticion.
let alertsConfigPromise = null;

// Asked once per visit, and only after somebody has actually run a check, so
// a visitor who reads the page and leaves never costs an invocation.
async function loadAlertsConfig() {
    if (alertsConfigPromise) return alertsConfigPromise;
    alertsConfigPromise = (async () => {
        try {
            const response = await fetch('/api/alerts-config');
            alertsConfig = response.ok ? await response.json() : { eligible: false };
        } catch (e) {
            // Not eligible rather than an error: a visitor should see no card,
            // not a card that breaks when they press it.
            alertsConfig = { eligible: false };
        }
        return alertsConfig;
    })();
    return alertsConfigPromise;
}

// Los casos cruzados contra las filtraciones de esta direccion, y las cifras
// del catalogo entero. Se pide una sola vez.
//
// El archivo era una lista y ahora es un objeto con las cifras al lado, asi
// que se aceptan las dos formas: una pestaña abierta desde antes del cambio
// sigue teniendo la lista vieja en cache y no tiene por que romperse.
const VACIO = { casos: 0, acuerdos: 0, abiertas: 0, filas: [] };
let settlements = null;

// El dataset del funnel: cuentas reconciliadas (las mismas que cuenta el hub
// de /settlements/), los acuerdos abiertos con monto, y las empresas del Paso
// 2. Una sola fuente para cada numero que ve el visitante.
let funnelData = null;
async function loadFunnel() {
    if (funnelData) return funnelData;
    try {
        const response = await fetch('/funnel.json');
        funnelData = response.ok ? await response.json() : null;
    } catch (e) {
        funnelData = null;
    }
    if (funnelData) { renderAlertsCount(); renderPoolStats(); }
    return funnelData;
}

// El conteo de la tarjeta de alertas ("N casos en seguimiento, M abiertos")
// sale del dataset, no de un numero escrito a mano que se queda viejo con cada
// recoleccion. El barrido data-i18n deja intacto el texto de respaldo porque
// alertsLi1 es una funcion, no una cadena; esto lo rellena cuando hay datos.
function renderAlertsCount() {
    const el = document.querySelector('[data-i18n="alertsLi1"]');
    const li1 = t().alertsLi1;
    if (!el || !funnelData?.meta || typeof li1 !== 'function') return;
    const nf = new Intl.NumberFormat(lang === 'en' ? 'en-US' : 'es-CO');
    el.innerHTML = li1(nf.format(funnelData.meta.casos),
                       nf.format(funnelData.meta.abiertos));
}

// The public money-pool banner: stats and chips from funnel.json, so the figures
// a visitor (and a payment reviewer) reads are the same ones /settlements/ shows.
function renderPoolStats() {
    if (!funnelData?.meta) return;
    const m = funnelData.meta;
    const nf = new Intl.NumberFormat(lang === 'en' ? 'en-US' : 'es-CO');
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    set('poolOpen', nf.format(m.abiertos));
    set('poolTracked', nf.format(m.casos));
    set('poolMax', poolMoney(m.maxPorPersona));
    // The hero's Money Pool badge shows the same "most any one person can claim"
    // figure, so it never drifts from the pool stats below it.
    set('poolBadgeNum', poolMoney(m.maxPorPersona));
    // The result's "up to $X to claim" tile shares the same figure. It is only
    // on the page after a check, so this is a no-op until then; it keeps the
    // tile correct when the funnel dataset finishes loading after a check.
    set('resultOwedNum', poolMoney(m.maxPorPersona));
    renderPoolChips();
}

// El monto grande se escribe sin decimales y sin el "US$" de la moneda, que en
// un titular se lee mejor como "$5,050" que como "US$ 5.050".
function poolMoney(n) {
    const nf = new Intl.NumberFormat(lang === 'en' ? 'en-US' : 'es-CO');
    return '$' + nf.format(Number(n) || 0);
}

function renderPoolChips() {
    const box = document.getElementById('poolChips');
    if (!box || !funnelData?.open) return;
    const top = funnelData.open.filter(o => o.porPersona)
        .sort((a, b) => b.porPersona - a.porPersona).slice(0, 4);
    box.innerHTML = top.map(o =>
        `<span class="pool-chip">${escapeHtml(displayName(o.slug, o.empresa))} `
        + `<b>${escapeHtml(t().alertsMissedMax + ' ' + poolMoney(o.porPersona))}</b></span>`).join('');
}

async function loadSettlements() {
    if (settlements) return settlements;
    try {
        const response = await fetch('/settlements.json');
        const data = response.ok ? await response.json() : null;
        // La forma vieja solo contenia acuerdos pagados, asi que una fila sin
        // tipo es un acuerdo. Sin esto, un navegador con el archivo viejo en
        // cache pintaria Yahoo como "demanda en curso" durante una hora.
        settlements = Array.isArray(data)
            ? { ...VACIO, filas: data.map(f => ({ tipo: 'acuerdo', ...f })) }
            : (data && Array.isArray(data.filas) ? data : VACIO);
    } catch (e) {
        settlements = VACIO;
    }
    return settlements;
}

// Matched on the breach's machine name, which Have I Been Pwned keeps
// stable, rather than on its display title. Title matching is what produced
// Canva against "canvas" and Apollo against ApolloMD while this catalogue
// was being built; getting it wrong here would tell somebody they had money
// coming from a company they have never used.
async function missedSettlements() {
    if (!lastEmailResult?.breaches?.length) return [];
    const data = await loadSettlements();
    if (!data.filas.length) return [];

    const mine = new Set(lastEmailResult.breaches.map(b => b.name));
    // Lo que paga va primero: es lo unico accionable hoy.
    return data.filas
        .filter(s => mine.has(s.hibp))
        .sort((a, b) => (a.tipo === 'acuerdo' ? 0 : 1) - (b.tipo === 'acuerdo' ? 0 : 1)
            || (b.porPersona || 0) - (a.porPersona || 0));
}

// Un host corriente y, si acaso, una ruta corriente. Nada de credenciales,
// puertos, espacios ni esquemas raros: lo que no encaje no se enlaza, y la
// fila sale sin enlace, que es molesto pero inofensivo.
const CLAIM_HOST = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/i;
const CLAIM_PATH = /^[a-z0-9._~\-/%]*$/i;

function sitioValido(valor) {
    if (typeof valor !== 'string') return null;
    let s = valor.trim().replace(/[.,;)"'<>]+$/, '');
    if (!s || s.length > 200 || /[\s\\@<>"']/.test(s)) return null;
    const bajo = s.toLowerCase();
    // Explicito, aunque el patron del host ya los rechazaria por los dos
    // puntos: que esto dependa de un efecto secundario de otra regla es
    // justo como se rompen los validadores cuando alguien los retoca.
    if (['javascript:', 'data:', 'vbscript:', 'file:', 'about:', 'blob:'].some(x => bajo.startsWith(x))) return null;
    if (bajo.slice(0, 12).includes('%')) return null;
    if (bajo.startsWith('http://') || bajo.startsWith('https://')) s = s.slice(s.indexOf('://') + 3);
    else if (s.includes('://')) return null;
    s = s.replace(/^\/+/, '');
    const corte = s.indexOf('/');
    const host = corte === -1 ? s : s.slice(0, corte);
    const resto = corte === -1 ? '' : s.slice(corte + 1);
    if (!CLAIM_HOST.test(host) || host.split('.').some(e => e.startsWith('-') || e.endsWith('-'))) return null;
    if (resto && !CLAIM_PATH.test(resto)) return null;
    return host + (resto ? '/' + resto : '');
}

// Lo que alguien pudo haber cobrado es informacion, no producto: no depende
// de donde viva ni de que pueda comprar nada, asi que vive en su propia
// tarjeta y no dentro de la de alertas, que solo se ofrece en Estados Unidos.
// Mientras estuvo ahi dentro, un visitante de Lima con su correo en la
// filtracion de Neiman Marcus no se enteraba de que hubo dinero.
function renderMissed(rows, meta) {
    const card = document.getElementById('missedCard');
    const title = document.getElementById('missedTitle');
    const lede = document.getElementById('missedLede');
    const none = document.getElementById('missedNone');
    const list = document.getElementById('alertsMissedList');
    const caveat = document.getElementById('missedCaveat');
    const cta = document.getElementById('missedCta');
    if (!card || !list) return;
    if (cta) cta.hidden = true;

    // Sin coincidencia es el caso de casi todo el mundo: de las mil y pico
    // filtraciones que sigue HIBP, treinta y cinco tienen caso en Estados
    // Unidos. Decirle a esa persona que no hay nada y cuantos casos se
    // vigilan es mas util, y mas honesto, que no decirle nada.
    if (!rows.length) {
        if (!meta || !meta.casos) { card.hidden = true; return; }
        card.hidden = false;
        title.innerHTML = t().missedNoneTitle;
        lede.hidden = true;
        list.innerHTML = '';
        caveat.hidden = true;
        none.hidden = false;
        // Counts come from funnel.json (the same source as the hub, the alerts
        // card and the banner) so this line cannot contradict them. "Live right
        // now" is cases not yet settled: casos - acuerdos (= the hub's "still in
        // court"). Falls back to the settlements meta only until funnel.json loads.
        const fm = funnelData && funnelData.meta;
        const casos = fm ? fm.casos : meta.casos;
        const live = fm ? (fm.casos - fm.acuerdos) : meta.abiertas;
        none.textContent = t().missedNoneBody(casos, live);
        return;
    }

    card.hidden = false;
    none.hidden = true;
    lede.hidden = false;

    const fmt = n => new Intl.NumberFormat(lang === 'en' ? 'en-US' : 'es-CO',
        { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n);
    const when = iso => {
        // Parsed as parts rather than through Date(iso), which reads a bare
        // date as UTC midnight and then prints the day before in any
        // timezone west of London. This date is the whole point of the line.
        const [y, m, d] = (iso || '').split('-').map(Number);
        if (!y) return '';
        return new Date(y, m - 1, d).toLocaleDateString(
            lang === 'en' ? 'en-US' : 'es-ES',
            { year: 'numeric', month: 'long', day: 'numeric' });
    };

    const pagan = rows.some(r => r.tipo === 'acuerdo');
    if (pagan) {
        // These matched settlements are closed (historical), so leading with
        // regret is a dead end. Reframe forward: use what they paid as proof the
        // reader's data has real value, point at the money open right now, and
        // offer monitoring to catch the next match. Numbers: the biggest
        // per-person payout among the matches, and the live open pool.
        const payouts = rows.filter(r => r.tipo === 'acuerdo' && r.porPersona).map(r => r.porPersona);
        const proofMax = payouts.length ? Math.max(...payouts) : 0;
        const fm = funnelData && funnelData.meta;
        const eligible = !!(alertsConfig && alertsConfig.eligible);
        title.innerHTML = t().missedProofTitle;
        lede.innerHTML = t().missedProofLede({
            proofMax: proofMax ? fmt(proofMax) : null,
            openN: fm ? fm.abiertos : null,
            openMax: fm && fm.maxPorPersona ? fmt(fm.maxPorPersona) : null,
            eligible,
        });
        caveat.hidden = false;
        if (cta) cta.hidden = !eligible;
    } else {
        title.innerHTML = t().missedSuitTitle;
        lede.innerHTML = t().missedSuitLede;
        caveat.hidden = true;
        if (cta) cta.hidden = true;
    }

    // The claim link is the whole point of telling somebody this. A line that
    // says money existed and then stops is worse than saying nothing: it
    // leaves the reader to search for the administrator themselves, which is
    // exactly where the sites that charge to file a free claim are waiting.
    //
    // Two links, because they answer different questions. The company name
    // opens our own page for the case, which says who was covered and whether
    // the window is shut. "Claim at" goes straight to the court-appointed
    // administrator, with nofollow and noopener, because that is the only
    // place a claim counts and we take nothing from it.
    list.innerHTML = rows.map(s => {
        const nombre = escapeHtml(s.titulo || s.empresa);
        const co = s.slug
            ? `<a class="m-co" href="/settlements/${encodeURIComponent(s.slug)}/">${nombre}</a>`
            : `<span class="m-co">${nombre}</span>`;

        // Una demanda en curso no tiene dinero ni plazo, y ponerle una cifra
        // al lado seria prometer lo que nadie ha prometido. Dice lo que es y
        // enlaza el caso.
        if (s.tipo !== 'acuerdo') {
            const caso = sitioExterno(s.fuente)
                ? `<a class="m-claim" href="${escapeHtml(s.fuente)}" rel="nofollow noopener" target="_blank">${escapeHtml(t().missedSuitLink)}</a>`
                : '';
            return `
        <li>
            ${co}
            <span class="m-amt">${escapeHtml(t().missedSuitState)}</span>
            ${caso}
        </li>`;
        }

        // El valor viene de raspar otra web, y aqui se convierte en el enlace
        // mas confiado de la pagina: le decimos a alguien que entregue sus
        // datos ahi para cobrar. El generador ya lo valida, y se vuelve a
        // validar aqui porque este archivo lee un JSON servido, y un fallo
        // de extraccion rio arriba no debe terminar en un destino cualquiera
        // con nuestra recomendacion encima.
        const sitio = sitioValido(s.sitio);
        const href = sitio && 'https://' + sitio;
        const reclamo = href
            ? `<a class="m-claim" href="${escapeHtml(href)}" rel="nofollow noopener" target="_blank">${escapeHtml(t().alertsMissedClaim)} ${escapeHtml(sitio)}</a>`
            : '';
        return `
        <li>
            ${co}
            <span class="m-amt">${s.porPersona
                ? escapeHtml(t().alertsMissedMax + ' ' + fmt(s.porPersona))
                : escapeHtml(t().alertsMissedNoAmount)}</span>
            ${s.plazo ? `<span class="m-when">${escapeHtml(t().alertsMissedClosed + ' ' + when(s.plazo))}</span>` : ''}
            ${reclamo}
        </li>`;
    }).join('');
}

// El enlace al caso es a classaction.org o a topclassactions.com, que es de
// donde salio la ficha. Se comprueba el esquema y el host antes de ponerlo
// en un href, por lo mismo que el sitio de reclamo: lo escribio un raspador.
function sitioExterno(url) {
    try {
        const u = new URL(String(url || ''));
        return u.protocol === 'https:' &&
            ['www.classaction.org', 'classaction.org',
             'topclassactions.com', 'www.topclassactions.com'].includes(u.hostname);
    } catch (e) {
        return false;
    }
}

// Se recalcula con cada revision y con cada cambio de idioma, porque las
// cantidades y las fechas se escriben segun el idioma.
async function refreshMissed() {
    if (!document.getElementById('missedCard')) return;
    if (!lastEmailResult?.breaches?.length) { renderMissed([], null); return; }
    // loadFunnel too, so the no-match count reads the single-source figures
    // rather than the settlements.json meta that disagrees with them.
    const [filas, meta] = await Promise.all([missedSettlements(), loadSettlements(), loadFunnel()]);
    renderMissed(filas, meta);
}

async function refreshAlertsCard() {
    const card = document.getElementById('alertsCard');
    if (!card) return;

    // Only once a check has found something: the monitoring pitch has nothing
    // to attach itself to before that. Monitoring is email-based, so there is
    // no US gate and no account form; eligibility is just whether Stripe is
    // configured to sell the plans.
    if (!lastEmailResult) { card.hidden = true; return; }

    const config = await loadAlertsConfig();
    card.hidden = !config.eligible;
    if (config.eligible) renderMonitorPrices();
}

// -------------------------------------------------------------- cross-check funnel
// Paso 2: the visitor ticks companies they have dealt with, which widens the
// email match with open settlements their email alone cannot find. The number
// is free; the itemized list and the gate ($5 one-time / $3-mo) are paid.

// Unos pocos nombres salen feos del slug ("Cvs", "Johnson Johnson"). Solo para
// lo que el visitante lee (chips y lista) se retocan los que se muestran; el
// resto cae al nombre del dato. La limpieza a fondo del catalogo es aparte.
const CO_DISPLAY = {
    'cvs': 'CVS',
    'johnson-johnson': 'Johnson & Johnson',
    'its-technologies-logistics-llc': 'ITS Technologies Logistics',
    'mgm-resorts': 'MGM Resorts',
    'hyundai-kia': 'Hyundai / Kia',
    'american-medical-collection-agency': 'American Medical Collection Agency',
};
function displayName(slug, fallback) { return CO_DISPLAY[slug] || fallback; }

// A bare YYYY-MM-DD, formatted as a short local date for the closed-chip meta.
// Parsed as parts, not through Date(iso), which reads a bare date as UTC
// midnight and can print the day before west of London.
function funnelWhen(iso) {
    const [y, m, d] = (iso || '').split('-').map(Number);
    if (!y) return '';
    return new Date(y, m - 1, d).toLocaleDateString(lang === 'en' ? 'en-US' : 'es-ES',
        { year: 'numeric', month: 'short', day: 'numeric' });
}

function fillFunnelChips() {
    const box = document.getElementById('funnelChips');
    if (!box || box.children.length || !funnelData?.chips) return;
    const openSlugs = new Set((funnelData.open || []).map(o => o.slug));
    const closedBySlug = {};
    for (const r of (settlements?.filas || [])) closedBySlug[r.slug] = r;
    box.innerHTML = funnelData.chips.map(c => {
        const slug = escapeHtml(c.slug);
        const name = escapeHtml(displayName(c.slug, c.empresa));
        // Open: a real toggle that adds to the claimable total.
        if (openSlugs.has(c.slug)) {
            return `<button type="button" class="cc-chip" data-cc-slug="${slug}">${name}</button>`;
        }
        // Closed: matched in the history but the claim window has passed. Never
        // counted toward the total. Shown greyed, with what it paid per person
        // and when the window shut, so the chip informs instead of doing nothing
        // when tapped. A span, not a button, so it is not an action.
        const row = closedBySlug[c.slug] || {};
        const amt = row.porPersona ? t().claimUpTo(funnelFmt(row.porPersona)) : '';
        const date = funnelWhen(row.plazo);
        const meta = [amt, date && t().ccClosedWhen(date)].filter(Boolean).join(' · ');
        return `<span class="cc-chip cc-closed" data-cc-slug="${slug}">`
            + `<span class="cc-closed-name">${name}`
            + `<span class="cc-tag">${escapeHtml(t().ccClosedTag)}</span></span>`
            + (meta ? `<span class="cc-closed-meta">${escapeHtml(meta)}</span>` : '')
            + `</span>`;
    }).join('');
}

function funnelPicked() {
    return Array.from(document.querySelectorAll('#funnelChips .cc-chip.on'))
        .map(b => b.dataset.ccSlug);
}

function funnelFmt(n) {
    return new Intl.NumberFormat(lang === 'en' ? 'en-US' : 'es-CO',
        { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n);
}

function funnelMatch() {
    return window.FunnelMatch.selectClaimable({
        breaches: (lastEmailResult?.breaches || []).map(b => b.name),
        matched: (settlements && settlements.filas) || [],
        open: (funnelData && funnelData.open) || [],
        companies: funnelPicked(),
        todayISO: new Date().toISOString().slice(0, 10),
    });
}

function renderFunnelNumber() {
    if (!funnelData || !window.FunnelMatch) return;
    const numBox = document.getElementById('funnelNumber');
    const locked = document.getElementById('funnelLocked');
    if (!numBox || !locked) return;
    const res = funnelMatch();
    // Only claimable (open) settlements drive the number and the list; closed
    // email matches stay in the historical money card above.
    const claim = res.openItems;
    if (!claim.length) { numBox.hidden = true; locked.hidden = true; return; }
    numBox.hidden = false;
    locked.hidden = false;
    document.getElementById('funnelTotal').textContent =
        res.openTotalMax > 0 ? (t().alertsMissedMax + ' ' + funnelFmt(res.openTotalMax))
            : t().ccNumNoAmount;
    document.getElementById('funnelSub').textContent = t().ccNumSub(claim.length);
    // The list is free: the official claim links are always free, so the
    // matched settlements are named in full with their links, no gate.
    revealFunnelList();
}

async function refreshFunnel() {
    const card = document.getElementById('crosscheckCard');
    if (!card) return;
    // After a check, whenever we have funnel data. The free money card above is
    // for everyone; this is the company-ticking layer that widens the email
    // match with settlements the address alone cannot find. It is free, so it
    // does not depend on whether payments are configured.
    if (!lastEmailResult) { card.hidden = true; return; }
    const data = await loadFunnel();
    if (!data) { card.hidden = true; return; }   // degrade: #missedCard remains
    await loadSettlements();                       // for the email-matched items
    card.hidden = false;
    fillFunnelChips();
    renderFunnelNumber();
    // The free funnel (matched settlements + claim links) shows regardless; the
    // paid upsell only when Stripe is configured to sell monitoring, so it stays
    // hidden on an environment with no payments rather than 503-ing on a click.
    const up = card.querySelector('.cc-upsell');
    if (up) {
        const config = await loadAlertsConfig();
        up.hidden = !config.eligible;
    }
}

// Rebuilds the matched open-settlement list: names the companies and adds the
// official (free) claim links. Remembered in sessionStorage so a reload in the
// same session keeps it in view.
function revealFunnelList() {
    const locked = document.getElementById('funnelLocked');
    const list = document.getElementById('funnelLockedList');
    if (!locked || !list || !window.FunnelMatch) return;
    const res = funnelMatch();
    list.innerHTML = res.openItems.map(it => {
        const amt = it.porPersona ? (t().alertsMissedMax + ' ' + funnelFmt(it.porPersona))
            : (it.fondo ? funnelFmt(it.fondo) : '');
        const sitio = sitioValido(it.sitio);
        const href = sitio && ('https://' + sitio);
        const claim = href
            ? `<a class="cc-l-claim" href="${escapeHtml(href)}" rel="nofollow noopener" target="_blank">${escapeHtml(t().alertsMissedClaim)} ${escapeHtml(sitio)}</a>`
            : '';
        return `<li class="cc-unlocked-row">`
            + `<a class="cc-l-co2" href="/settlements/${encodeURIComponent(it.slug)}/">${escapeHtml(displayName(it.slug, it.empresa))}</a>`
            + (amt ? `<span class="cc-l-amt">${escapeHtml(amt)}</span>` : '')
            + claim + `</li>`;
    }).join('');
    const title = locked.querySelector('h3');
    if (title) title.textContent = t().ccUnlockedTitle;
}

// Monitoring goes straight to Stripe Checkout for the email just checked. It is
// email-based: no account, no form. base is 'breach' | 'settlement' | 'combo';
// the month/year switch decides the interval. Double opt-in confirms the
// address after payment, so there is no consent form here.
function monitorEmail() {
    return lastEmailResult?.email || currentUser?.email || null;
}

function monitorInterval() {
    const yearly = document.getElementById('monitorYearly');
    return yearly && yearly.checked ? 'year' : 'month';
}

// The prices shown on the three monitoring cards. These are display only; the
// real prices live in Stripe and are keyed by the plan name checkout.js sends.
// Two months free on the yearly, which is the whole reason to offer it.
const MONITOR_PRICES = {
    breach: { month: 3, year: 30 },
    settlement: { month: 3, year: 30 },
    combo: { month: 5, year: 50 },
    // Unified monitoring tier (both alerts, 14-day trial), matching the app.
    monitoring: { month: 7.99, year: 39.99 },
};

// Rewrites each card's figure when the month/year switch moves, so the price
// the visitor reads always matches the plan the button will buy.
function renderMonitorPrices() {
    const yearly = monitorInterval() === 'year';
    const per = yearly ? t().monitorYr : t().monitorMo;
    document.querySelectorAll('#alertsCard .mon-plan').forEach(card => {
        const base = card.querySelector('[data-action="startMonitor"]')?.dataset.arg;
        const p = MONITOR_PRICES[base];
        const v = card.querySelector('.mon-v');
        if (!p || !v) return;
        v.innerHTML = `US$&nbsp;${yearly ? p.year : p.month}<small>${escapeHtml(per)}</small>`;
    });
}

async function startMonitor(btn) {
    const base = btn?.dataset?.arg;
    if (!base) return;
    const email = monitorEmail();
    if (!email) { alertsError(t().monitorErrEmail); return; }
    alertsError('');
    const plan = `${base}_${monitorInterval()}`;
    const original = btn ? btn.innerHTML : null;
    if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>' + escapeHtml(t().alertsOpening); }
    try {
        // No account and no token: monitoring is keyed on the email, not a
        // Supabase user, so checkout.js takes the email straight from the body.
        const response = await fetch(`/api/checkout?plan=${encodeURIComponent(plan)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, lang }),
        });
        const data = await response.json().catch(() => null);
        if (!response.ok || !data?.url) throw new Error(data?.error || t().alertsErrFail);
        window.location.href = data.url;
    } catch (e) {
        if (btn) { btn.disabled = false; btn.innerHTML = original; }
        alertsError(t().alertsErrFail);
    }
}

function alertsError(message) {
    const box = document.getElementById('alertsError');
    if (!box) return;
    box.textContent = message || '';
    box.style.display = message ? 'block' : 'none';
}


function reportHeaderHTML(email) {
    return `
        <div class="demo-print-notice">${escapeHtml(t().demoPrintNotice)}</div>
        <header class="plan-header">
            <div>
                <h1>${escapeHtml(t().planHeading)}</h1>
                <p class="plan-meta">${escapeHtml(t().planPreparedFor)} ${escapeHtml(email || '')} &middot; ${escapeHtml(todayLong())}</p>
            </div>
            <div class="plan-brand">${escapeHtml(t().brand)}</div>
        </header>`;
}

function actionHTML(a, i) {
    return `
        <section class="plan-action">
            <div class="plan-action-head">
                <span class="plan-step-num">${i + 1}</span>
                <h3>${escapeHtml(a.title)}</h3>
                <span class="plan-pill plan-${a.priority}">${escapeHtml(PRIORITY_LABEL[lang][a.priority] || '')}</span>
            </div>
            <div class="plan-time">${ICON_CLOCK}${escapeHtml(a.time)}</div>

            <div class="plan-block">
                <div class="plan-label">${escapeHtml(t().planWhatHappened)}</div>
                <p>${escapeHtml(a.whatHappened)}</p>
            </div>

            <div class="plan-block">
                <div class="plan-label">${escapeHtml(t().planWhyMatters)}</div>
                <p>${escapeHtml(a.whyItMatters)}</p>
            </div>

            <div class="plan-block">
                <div class="plan-label">${escapeHtml(t().planWhatToDo)}</div>
                <ol class="plan-steps">
                    ${a.steps.map(step => `<li>${escapeHtml(step)}</li>`).join('')}
                </ol>
            </div>
        </section>`;
}

function planSummaryHTML(stats, actionCount, criticals) {
    return `
        <section class="plan-summary">
            ${t().planSummary(stats.total, actionCount, criticals)}
            <p class="plan-reassure">${escapeHtml(t().planReassure)}</p>
        </section>`;
}

// --- Full Report: settlements rendering --------------------------------------------------

function claimMoney(n) {
    const v = Number(n);
    if (!isFinite(v) || v <= 0) return '';
    try { return '$' + v.toLocaleString('en-US'); } catch (e) { return '$' + v; }
}

function claimSiteUrl(sitio) {
    const s = String(sitio || '').trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
    return s ? 'https://' + s : '';
}

function claimLinkHTML(sitio) {
    const url = claimSiteUrl(sitio);
    if (!url) return '';
    const host = url.replace(/^https?:\/\//, '');
    return `<a class="claim-link" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer nofollow">${escapeHtml(t().claimOfficial)} &rarr; ${escapeHtml(host)}</a>`;
}

function personalClaimCardHTML(c) {
    const open = c.status === 'open';
    const amount = claimMoney(c.porPersona);
    const deadline = open && c.plazo ? formatBreachDate(c.plazo) : '';
    return `
        <div class="claim-card ${open ? 'claim-open' : 'claim-closed'}">
            <div class="claim-card-head">
                <span class="claim-co">${escapeHtml(c.empresa)}</span>
                <span class="claim-badge ${open ? 'claim-badge-open' : 'claim-badge-closed'}">${escapeHtml(open ? t().claimStatusOpen : t().claimStatusClosed)}</span>
            </div>
            ${amount ? `<div class="claim-amt">${escapeHtml(t().claimUpTo(amount))}</div>` : ''}
            ${c.elegible ? `<p class="claim-elig">${escapeHtml(c.elegible)}</p>` : ''}
            ${deadline ? `<div class="claim-deadline">${escapeHtml(t().claimDeadline(deadline))}</div>` : ''}
            ${open ? claimLinkHTML(c.sitio) : ''}
        </div>`;
}

function openClaimCardHTML(c) {
    const deadline = c.plazo ? formatBreachDate(c.plazo) : '';
    let proof = '';
    if (c.comprobante === 'no') proof = `<span class="claim-proof claim-proof-flat">${escapeHtml(t().claimProofFlat)}</span>`;
    else if (c.comprobante === 'yes') proof = `<span class="claim-proof claim-proof-need">${escapeHtml(t().claimProofNeeded)}</span>`;
    return `
        <div class="claim-card claim-open">
            <div class="claim-card-head">
                <span class="claim-co">${escapeHtml(c.empresa)}</span>
                ${c.pagoTexto ? `<span class="claim-badge claim-badge-open">${escapeHtml(c.pagoTexto)}</span>` : ''}
            </div>
            ${c.cubre ? `<p class="claim-elig">${escapeHtml(c.cubre)}</p>` : ''}
            <div class="claim-card-foot">
                ${deadline ? `<span class="claim-deadline">${escapeHtml(t().claimDeadline(deadline))}</span>` : ''}
                ${proof}
            </div>
            ${claimLinkHTML(c.sitio)}
        </div>`;
}

function claimGuideHTML(guide) {
    if (!guide) return '';
    return `
        <section class="claim-guide">
            <h3>${escapeHtml(guide.title)}</h3>
            <p class="claim-guide-intro">${escapeHtml(guide.intro)}</p>
            <ol class="claim-guide-steps">
                ${(guide.steps || []).map(s => `<li>${escapeHtml(s)}</li>`).join('')}
            </ol>
        </section>`;
}

// Paid: exposure history + the open pool + the filing guide (money first).
function claimsFullHTML(claims) {
    if (!claims) return '';
    const personal = claims.personal || [];
    const open = claims.open || [];
    if (!personal.length && !open.length) return '';

    const personalBlock = personal.length ? `
        <h3 class="claim-sub">${escapeHtml(t().claimPersonalTitle)}</h3>
        <p class="claim-lede">${escapeHtml(t().claimPersonalLede(claims.personalOpenCount || 0))}</p>
        <div class="claim-grid">${personal.map(personalClaimCardHTML).join('')}</div>` : '';

    const openBlock = open.length ? `
        <h3 class="claim-sub">${escapeHtml(t().claimOpenTitle)}</h3>
        <p class="claim-lede">${escapeHtml(t().claimOpenLede)}</p>
        <div class="claim-grid">${open.map(openClaimCardHTML).join('')}</div>` : '';

    return `
        <section class="claim-pack">
            <h2>${escapeHtml(t().claimPackTitle)}</h2>
            <p class="claim-free-note">${escapeHtml(t().claimFreeNote)}</p>
            ${personalBlock}
            ${openBlock}
            ${claimGuideHTML(claims.guide)}
        </section>`;
}

// Teaser: exposure history stays visible (free, and it sells), plus a line on
// how many are open. The guide and the open-settlement detail are paid.
function claimsTeaserHTML(claims) {
    if (!claims) return '';
    const personal = claims.personal || [];
    if (!personal.length && !(claims.openCount > 0)) return '';

    const personalBlock = personal.length ? `
        <h3 class="claim-sub">${escapeHtml(t().claimPersonalTitle)}</h3>
        <p class="claim-lede">${escapeHtml(t().claimPersonalLede(claims.personalOpenCount || 0))}</p>
        <div class="claim-grid">${personal.map(personalClaimCardHTML).join('')}</div>` : '';

    const openLine = claims.openCount > 0
        ? `<p class="claim-openline">${escapeHtml(t().claimOpenLine(claims.openCount))}</p>` : '';

    return `
        <section class="claim-pack">
            <h2>${escapeHtml(t().claimPackTitle)}</h2>
            <p class="claim-free-note">${escapeHtml(t().claimFreeNote)}</p>
            ${personalBlock}
            ${openLine}
        </section>`;
}

function fullReportHTML(data) {
    const criticals = data.actions.filter(a => a.priority === 'critical').length;

    const rows = (data.breaches || []).map(b => {
        const d = safeDomain(b.domain);
        const when = formatBreachDate(b.breachDate);
        const classes = Array.isArray(b.dataClasses) ? b.dataClasses : [];
        return `<tr>
            <td>${escapeHtml(siteName(b))}${d ? `<br><span class="appendix-domain">${escapeHtml(d)}</span>` : ''}</td>
            <td>${when ? escapeHtml(when) : escapeHtml(t().notPublished)}</td>
            <td>${classes.length ? escapeHtml(classes.map(dataClassLabel).join(', ')) : escapeHtml(t().notPublished)}</td>
        </tr>`;
    }).join('');

    return reportHeaderHTML(data.email)
        + `<h2 class="plan-security-title">${escapeHtml(t().planSecurityTitle)}</h2>`
        + planSummaryHTML(data.stats, data.actions.length, criticals)
        + data.actions.map(actionHTML).join('')
        + claimsFullHTML(data.claims)
        + (rows ? `
            <section class="plan-appendix">
                <h2>${escapeHtml(t().appendixTitle)}</h2>
                <p class="plan-why">${escapeHtml(t().appendixLede)}</p>
                <div class="appendix-scroll">
                    <table class="appendix-table">
                        <thead><tr>
                            <th>${escapeHtml(t().appendixCompany)}</th>
                            <th>${escapeHtml(t().appendixDate)}</th>
                            <th>${escapeHtml(t().appendixTaken)}</th>
                        </tr></thead>
                        <tbody>${rows}</tbody>
                    </table>
                </div>
            </section>` : '')
        + `<footer class="plan-footer">${escapeHtml(t().planFooter(todayLong()))}</footer>`;
}

// What an unpaid visitor sees: the first action in full, so the quality is
// obvious, then the titles of everything still locked.
function teaserHTML(data) {
    const locked = data.locked || [];
    const criticals = data.criticalCount || 0;

    const lockedHTML = locked.map((a, i) => `
        <div class="locked-action">
            <span class="plan-step-num muted">${i + 2}</span>
            <div class="locked-body">
                <div class="locked-title">${escapeHtml(a.title)}</div>
                <div class="locked-meta">${escapeHtml(PRIORITY_LABEL[lang][a.priority] || '')} &middot; ${escapeHtml(a.time)}</div>
            </div>
            <span class="locked-icon">${ICON_LOCK}</span>
        </div>`).join('');

    return reportHeaderHTML(data.email)
        + `<h2 class="plan-security-title">${escapeHtml(t().planSecurityTitle)}</h2>`
        + planSummaryHTML(data.stats, data.totalActions, criticals)
        + `<div class="teaser-note">${escapeHtml(t().teaserNote)}</div>`
        + (data.preview ? actionHTML(data.preview, 0) : '')
        + `
        <section class="paywall">
            <h2>${escapeHtml(t().paywallTitle(locked.length))}</h2>
            <div class="locked-list">${lockedHTML}</div>
            <p class="paywall-pitch">${escapeHtml(t().paywallPitch)}</p>
            <button class="btn accent" data-action="startPurchase">${escapeHtml(t().paywallBtn)}</button>
            <p class="paywall-fine">${escapeHtml(t().paywallFine)}</p>
        </section>`
        + claimsTeaserHTML(data.claims);
}

// =======================================================================
// PAYMENT (Stripe)
// The amount is never written here. It comes from /api/checkout, which
// reads it from the environment, so the price exists in one place and a
// visitor cannot name their own.
// =======================================================================
let priceInfo = null;
// Si ya contesto el servidor. Distinto de priceInfo nulo por no haber
// preguntado todavia: sin esta diferencia, la tarjeta se esconde durante el
// primer instante de carga en los paises donde si hay precio.
let priceChecked = false;

async function loadPrice() {
    // The report is a fixed US$5 now (Stripe, USD for everyone), so there is no
    // per-visit price call: set the figure directly. /api/checkout is POST-only.
    priceChecked = true;
    priceInfo = { available: true, amount: 5, currency: 'USD', plan: 'report' };
    renderPrice();
    maybeShowLangHint();
    refreshOfferCard();
}

const LANG_HINT_DISMISSED = 'aie-lang-hint-off';

// The language hint used to key off which payment provider the visitor's
// country resolved to (a US visitor got a different checkout). With a single
// USD checkout there is no geo signal any more, so the hint stays dormant
// rather than guessing which language a visitor would prefer.
function maybeShowLangHint() {
    return;
}

function dismissLangHint() {
    const hint = document.getElementById('langHint');
    if (hint) hint.hidden = true;
    try { localStorage.setItem(LANG_HINT_DISMISSED, '1'); } catch (e) { /* ignore */ }
}

// A currency symbol belongs to the currency's own locale, not the reader's.
// Intl writes PEN as "S/" only under es-PE; asked in es-CO or en-US the
// same call returns "PEN 19", which reads like a foreign price tag on a
// Peruvian product. An English-speaking buyer should still see "S/ 19",
// because that is what the price is.
const CURRENCY_LOCALE = {
    PEN: 'es-PE', COP: 'es-CO', MXN: 'es-MX', ARS: 'es-AR',
    CLP: 'es-CL', UYU: 'es-UY', BRL: 'pt-BR', USD: 'en-US',
};

function formatPrice({ amount, currency }) {
    try {
        // The currency symbol follows the currency's own locale, not the
        // reader's, so the fixed USD price renders as "$5" in both languages.
        const fmt = lang === 'en' ? 'en-US' : (CURRENCY_LOCALE[currency] || locale());
        return new Intl.NumberFormat(fmt, {
            style: 'currency',
            currency,
            // A whole-sol price should not read as "19.00".
            maximumFractionDigits: Number.isInteger(amount) ? 0 : 2,
        }).format(amount);
    } catch (e) {
        return `${currency} ${num(amount)}`;
    }
}

// With no price configured on the server there is nothing to sell, and a
// lone placeholder dash on the card looks like a bug. The card still reads
// fine without it: its button offers the sample, not the purchase.
function renderPrice() {
    const el = document.getElementById('offerPriceAmount');
    if (!el) return;
    const price = el.closest('.price');
    if (!priceInfo) {
        if (price) price.style.display = 'none';
        return;
    }
    if (price) price.style.display = '';

    // One fixed price for everyone now: US$5, in USD, through Stripe. No
    // per-provider branch and no dual-currency note.
    el.textContent = formatPrice(priceInfo);
    const nota = document.getElementById('offerPriceNote');
    if (nota) { nota.hidden = true; nota.textContent = ''; }
    syncJsonLdPrice();
}

// The structured data carries a hardcoded price because a crawler that does
// not run scripts still has to read one. This rewrites it from the figure
// the API just returned, so the number a rendering crawler indexes comes
// from the same place the buyer's checkout does.
function syncJsonLdPrice() {
    const node = document.getElementById('appJsonLd');
    if (!node || !priceInfo) return;
    try {
        const data = JSON.parse(node.textContent);
        const paid = (data.offers || []).find(o => Number(o.price) > 0);
        if (!paid) return;
        paid.price = Number(priceInfo.amount).toFixed(2);
        paid.priceCurrency = priceInfo.currency;
        node.textContent = JSON.stringify(data, null, 4);
    } catch (e) {
        console.error('Could not sync the structured price:', e.name);
    }
}

async function startPurchase(btn) {
    // The sample sells. Somebody reading it has seen exactly what the plan
    // looks like, which is the best moment they will ever be in to buy one,
    // and refusing them there because the page they are on is an example was
    // turning the strongest pitch on the site into a dead end. What they buy
    // is 30 days of access on their account, not a plan for one address, so
    // buying from the sample and checking their own address afterwards is a
    // perfectly ordinary order of events.

    // A purchase has to belong to an account, because that is what the
    // access is attached to. Asking to sign in first is not a detour: it is
    // the only way the payment can be honoured afterwards. The intent is
    // remembered so that signing in carries on to the checkout instead of
    // dropping them back where they started, wondering what happened.
    // Guest checkout: no sign-up form before paying. A signed-in buyer binds the
    // purchase to their account; a guest buys with the email they just checked,
    // and the webhook then creates/links the account and emails a one-click
    // magic link to the report. Only when there is neither a session nor a
    // checked email is there nothing to attach the report to.
    const guestEmail = (lastEmailResult && lastEmailResult.email) || null;
    if (!currentUser && !guestEmail) {
        const input = document.getElementById('emailInput');
        if (input) { input.scrollIntoView({ behavior: 'smooth', block: 'center' }); input.focus(); }
        showPayBanner(lang === 'es'
            ? 'Revisa tu correo primero y luego compra el informe.'
            : 'Check your email first, then buy the report.', 'warn');
        return;
    }

    const original = btn ? btn.innerHTML : null;
    const restore = () => {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = original;
        }
    };
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<span class="spinner"></span>' + escapeHtml(t().payOpening);
    }

    try {
        // Signed in: carry the access token so the purchase binds to the account
        // (client_reference_id -> purchases.user_id). Guest: no token; the email
        // is what the webhook attaches the new account to.
        let accessToken = null;
        let email = guestEmail;
        if (currentUser) {
            if (!requireClient()) { restore(); return; }
            const { data: { session } } = await window.sbClient.auth.getSession();
            accessToken = session?.access_token || null;
            email = currentUser.email || guestEmail;
        }

        // The checked address does not survive the round trip to Stripe
        // Checkout, so it is parked here and picked up again on the way back.
        try {
            if (email) sessionStorage.setItem('aie-pending-email', email);
        } catch (e) { /* not essential */ }

        // Stripe Checkout (hosted).
        const response = await fetch('/api/checkout?plan=report', {
            method: 'POST',
            headers: accessToken
                ? authHeaders(accessToken)
                : { 'Content-Type': 'application/json' },
            body: JSON.stringify({ lang, email }),
        });
        const data = await response.json().catch(() => null);
        if (!response.ok || !data?.url) {
            throw new Error(data?.error || t().payFail);
        }
        window.location.href = data.url;
    } catch (error) {
        restore();
        showPayBanner(error.message || t().payFail, 'warn');
    }
}

function showPayBanner(text, tone) {
    const banner = document.getElementById('payBanner');
    document.getElementById('payBannerText').textContent = text;
    banner.classList.toggle('warn', tone === 'warn');
    // .show also pins it to the top of the viewport, above the report view,
    // because that is where the buttons that raise it live.
    banner.classList.add('show');
}

function dismissPayBanner() {
    document.getElementById('payBanner').classList.remove('show');
}

// Whether this account has access right now, read from its own purchase
// rows through RLS. Used only to decide when to stop waiting for the
// webhook; /api/report remains the authority on what gets sent.
async function hasPaidAccess() {
    if (!window.sbClient || !currentUser) return false;
    // When to stop waiting for the webhook. /api/report stays the authority on
    // access (it filters live_mode against the server's Stripe env); this only
    // decides the polling, from the account's own paid, unexpired Stripe rows
    // read through RLS.
    try {
        const { data, error } = await window.sbClient
            .from('purchases')
            .select('id')
            .eq('status', 'paid')
            .eq('provider', 'stripe')
            .or(`expires_at.is.null,expires_at.gt.${new Date().toISOString()}`)
            .limit(1);
        if (error) return false;
        return Array.isArray(data) && data.length > 0;
    } catch (e) {
        return false;
    }
}

// Stripe sends the buyer back to the site and the webhook arrives separately,
// and the redirect usually wins the race. Polling for a few seconds is the
// difference between "your plan is ready" and telling someone who has just
// paid that they have not.
async function waitForEntitlement(attempts = 8, gapMs = 2000) {
    for (let i = 0; i < attempts; i++) {
        if (await hasPaidAccess()) return true;
        await new Promise(resolve => setTimeout(resolve, gapMs));
    }
    return hasPaidAccess();
}

// Straight to the plan from the receipt. The buyer's address is taken from
// their session, never from the link: an email address in a URL ends up in
// server logs and referrer headers, and this one belongs to somebody who
// just paid us to take their exposure seriously.
async function openPlanForAccount() {
    try { history.replaceState(null, '', window.location.pathname); } catch (e) { /* ignore */ }

    if (!currentUser?.email) {
        openAuthModal('signin');
        return;
    }

    document.getElementById('emailInput').value = currentUser.email;
    await checkEmail();
    await openReport();
}

async function handleReturnFromCheckout(outcome) {
    // Drop the query string so a reload does not replay this.
    try { history.replaceState(null, '', window.location.pathname); } catch (e) { /* ignore */ }

    let email = null;
    try {
        email = sessionStorage.getItem('aie-pending-email');
        sessionStorage.removeItem('aie-pending-email');
    } catch (e) { /* ignore */ }

    if (email) document.getElementById('emailInput').value = email;

    if (outcome === 'error') {
        showPayBanner(t().payCancelled, 'warn');
        return;
    }

    showPayBanner(t().payConfirming);
    const paid = await waitForEntitlement();

    if (!paid) {
        showPayBanner(t().paySlow, 'warn');
        return;
    }

    // The cached plan was fetched as a teaser; it has to be asked for again
    // now that the account is entitled.
    lastReport = null;

    if (!email) {
        // Bought from the sample, so there is no address of their own to
        // build a plan from yet. Say what to do rather than announcing that
        // something is ready and showing nothing.
        showPayBanner(t().payReadyCheck);
        closeReport();
        const input = document.getElementById('emailInput');
        input.scrollIntoView({ behavior: 'smooth', block: 'center' });
        input.focus();
        return;
    }

    showPayBanner(t().payReady);
    await checkEmail();
    await openReport();
}

function closeReport() {
    document.getElementById('reportView').classList.remove('active');
    document.body.style.overflow = '';
}

function printReport() {
    window.print();
}

// =======================================================================
// PASSWORD CHECK (k-anonymity via HIBP)
// =======================================================================
function togglePasswordFold() {
    const fold = document.getElementById('pwFold');
    openPasswordFold(fold.dataset.open !== '1');
}

function openPasswordFold(open) {
    const fold = document.getElementById('pwFold');
    fold.dataset.open = open ? '1' : '0';
    document.getElementById('pwBody').hidden = !open;
}

async function checkPassword() {
    const password = document.getElementById('passwordInput').value;
    const btn = document.getElementById('passwordCheckBtn');
    const resultDiv = document.getElementById('passwordResult');
    const errorDiv = document.getElementById('passwordError');

    if (!password) {
        errorDiv.textContent = t().errNoPw;
        errorDiv.style.display = 'block';
        resultDiv.style.display = 'none';
        return;
    }

    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span>' + escapeHtml(t().checking);
    errorDiv.style.display = 'none';
    resultDiv.style.display = 'none';

    try {
        const exposureCount = await checkPasswordWithKAnonymity(password);
        if (exposureCount > 0) {
            renderPasswordExposed(exposureCount);
        } else {
            lastPasswordCount = null;
            renderCleanPassword();
        }
        // Counted from here because this check never reaches our server: the
        // browser talks to api.pwnedpasswords.com directly, which is what
        // keeps the password on this device. Only the outcome is reported,
        // never the password or its hash.
        countPasswordCheck(exposureCount > 0 ? 'expuesto' : 'limpio');
    } catch (error) {
        errorDiv.textContent = error.message || t().errPwFail;
        errorDiv.style.display = 'block';
        resultDiv.style.display = 'none';
    } finally {
        btn.disabled = false;
        btn.textContent = t().pwBtn;
    }
}

// Fire and forget, with no await anywhere near the result the person is
// waiting for. A lost count is worth nothing next to a slow answer.
function countPasswordCheck(resultado) {
    try {
        fetch('/api/track-check', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ lang, resultado, origen: visitOrigin }),
            keepalive: true,
        }).catch(() => { /* counters are not worth reporting */ });
    } catch (e) { /* ignore */ }
}

async function checkPasswordWithKAnonymity(password) {
    // SHA1 hash the password (k-anonymity only sends first 5 chars)
    const hash = await sha1(password);
    const prefix = hash.substring(0, 5);
    const suffix = hash.substring(5).toUpperCase();

    // Add-Padding pads the response with decoy hashes so an observer cannot
    // infer the prefix from the response size.
    const response = await fetch(`https://api.pwnedpasswords.com/range/${prefix}`, {
        headers: { 'Add-Padding': 'true' },
    });
    if (!response.ok) throw new Error(t().errPwFail);

    const text = await response.text();
    const lines = text.split(/\r?\n/);

    // Padded decoy entries always carry a count of 0 and must not be
    // treated as a match. The count returned is the number of separate
    // times this password appears across breached datasets.
    for (const line of lines) {
        const [candidate, count] = line.split(':');
        if (candidate === suffix && Number(count) > 0) {
            return Number(count);
        }
    }

    return 0;
}

// Severity driven by how common the password is. A password seen three
// times and one seen forty million are not the same problem, and saying
// the same thing about both is how advice gets ignored.
function passwordSeverity(count) {
    if (count >= 100000) return { ...t().pwSev.critical, bars: 5 };
    if (count >= 1000)   return { ...t().pwSev.high,     bars: 4 };
    if (count >= 10)     return { ...t().pwSev.moderate, bars: 3 };
    return { ...t().pwSev.low, bars: 2 };
}

// The action plan is built from email breach data, so this offers the plan
// when an email result exists and points at the email check when it does not.
function passwordPlanCTA() {
    if (lastEmailResult) {
        return `
            <div class="nextstep">
                <p><strong>${escapeHtml(t().pwPlanTitleA)}</strong> ${escapeHtml(t().pwPlanBodyA)}</p>
                <button class="btn sm accent" data-action="openReport">${escapeHtml(t().pwPlanBtnA)}</button>
            </div>`;
    }
    return `
        <div class="nextstep">
            <p><strong>${escapeHtml(t().pwPlanTitleA)}</strong> ${escapeHtml(t().pwPlanBodyB)}</p>
            <button class="btn sm accent" data-action="focusEmailCheck">${escapeHtml(t().pwPlanBtnB)}</button>
        </div>`;
}

// The password card's call to action depends on whether an email result
// exists, and the two checks can happen in either order. Whichever runs
// second has to redraw the other, or the card keeps offering a check that
// has already been done.
function refreshPasswordCTA() {
    if (lastPasswordCount !== null) renderPasswordExposed(lastPasswordCount);
}

function focusEmailCheck() {
    const input = document.getElementById('emailInput');
    input.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setTimeout(() => input.focus(), 400);
}

function renderCleanPassword() {
    const resultDiv = document.getElementById('passwordResult');
    resultDiv.innerHTML = `
        <div class="card" style="margin-top: 18px;">
            <div class="verdict">
                <div class="verdict-icon good">${ICON_GOOD}</div>
                <div>
                    <h2>${escapeHtml(t().pwCleanTitle)}</h2>
                    <p>${escapeHtml(t().pwCleanBody)}</p>
                </div>
            </div>
        </div>`;
    resultDiv.style.display = 'block';
}

// Free tier is told the password is exposed. The exposure count, severity
// and remediation steps are the gated detail.
function renderPasswordExposed(count) {
    lastPasswordCount = count;
    const resultDiv = document.getElementById('passwordResult');
    let inner;

    if (isUnlocked()) {
        const sev = passwordSeverity(count);
        const bars = Array.from({ length: 5 }, (_, i) =>
            `<i${i < sev.bars ? ' class="on"' : ''}></i>`).join('');
        inner = `
            <p>${t().pwExpBody(num(count))}</p>
            <div class="strength">${bars}</div>
            <div class="section-lbl">${escapeHtml(sev.label)} ${escapeHtml(t().pwRiskLabel)}</div>
            <p class="verdict-note" style="font-size: 14.5px; color: var(--muted);">${escapeHtml(sev.summary)}</p>
            <div class="section-lbl">${escapeHtml(t().pwWhatToDo)}</div>
            <ol class="steps-inline">
                ${t().pwSteps.map(s => `<li>${escapeHtml(s)}</li>`).join('')}
            </ol>
            ${passwordPlanCTA()}`;
    } else {
        inner = `
            <p>${escapeHtml(t().pwExpBodyFree)}</p>
            <div class="gate">
                <h3>${escapeHtml(t().gateTitle)}</h3>
                <p>${escapeHtml(t().gateBody)}</p>
                <div class="gate-btns">
                    <button class="btn sm" data-action="openAuthModal" data-arg="signup">${escapeHtml(t().gateSignup)}</button>
                    <button class="ghost-btn" data-action="openAuthModal" data-arg="signin">${escapeHtml(t().gateSignin)}</button>
                </div>
            </div>`;
    }

    resultDiv.innerHTML = `
        <div class="card" style="margin-top: 18px;">
            <div class="verdict">
                <div class="verdict-icon bad">${ICON_BAD}</div>
                <div>
                    <h2>${escapeHtml(t().pwExpTitle)}</h2>
                </div>
            </div>
            ${inner}
        </div>`;
    resultDiv.style.display = 'block';
}

// SHA1 hash (for k-anonymity)
async function sha1(str) {
    const buffer = new TextEncoder().encode(str);
    const hashBuffer = await crypto.subtle.digest('SHA-1', buffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
}

// Both fields at once: the point is to compare them, so revealing one and
// not the other would not help.
// Sign in and sign up. Somebody who cannot see what they are typing has no
// way to tell a wrong password from a stuck shift key, and the error we get
// back says the same thing either way.
function togglePwField(inputId, toggleId) {
    const input = document.getElementById(inputId);
    const toggle = document.getElementById(toggleId);
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    toggle.textContent = show ? t().pwHide : t().pwShow;
}

// Closing the modal must put every revealed field back, or the next person to
// open it finds a password sitting there in plain text.
function hideAuthPasswords() {
    [['signinPassword', 'signinPwShowToggle'],
     ['signupPassword', 'signupPwShowToggle'],
     ['newPassword',    'newPwShowToggle'],
     ['newPasswordConfirm', null]].forEach(([inputId, toggleId]) => {
        const input = document.getElementById(inputId);
        if (input) input.type = 'password';
        if (toggleId) {
            const toggle = document.getElementById(toggleId);
            if (toggle) toggle.textContent = t().pwShow;
        }
    });
}

function toggleNewPasswordVisibility() {
    const fields = [document.getElementById('newPassword'),
                    document.getElementById('newPasswordConfirm')];
    const toggle = document.getElementById('newPwShowToggle');
    const show = fields[0].type === 'password';
    fields.forEach(f => { f.type = show ? 'text' : 'password'; });
    toggle.textContent = show ? t().pwHide : t().pwShow;
}

function togglePasswordVisibility() {
    const input = document.getElementById('passwordInput');
    const toggle = document.getElementById('pwShowToggle');
    if (input.type === 'password') {
        input.type = 'text';
        toggle.textContent = t().pwHide;
    } else {
        input.type = 'password';
        toggle.textContent = t().pwShow;
    }
}

// =======================================================================
// BOOT
// =======================================================================

// Every button used to carry its own onclick="fn()". A Content Security
// Policy cannot allow those without 'unsafe-inline' in script-src, and
// 'unsafe-inline' gives away most of what the policy is for: with it, an
// injected <script> runs too. So each button now names its action in
// data-action, with any literal arguments in data-arg and data-arg2, and the
// dispatch happens here.
//
// Delegated from the document rather than bound per button, because half of
// these buttons are written into the page later by renderEmailResult,
// renderPaywall and the password plan. Binding on load would miss them.
// The missed-settlements card's call to action: send the reader to the
// monitoring card (the forward-looking offer) and flash it so the connection
// is obvious. Does nothing when monitoring is not on offer here.
function goMonitor() {
    const card = document.getElementById('alertsCard');
    if (!card || card.hidden) return;
    card.scrollIntoView({ behavior: 'smooth', block: 'start' });
    card.classList.add('flash');
    setTimeout(() => card.classList.remove('flash'), 1400);
}

// The "up to $X to claim" tile in the result sends the visitor to the best
// money target that is actually on the page: monitoring when it is showing
// (United States), otherwise the settlements money card every visitor gets,
// and the public money pool as a last resort. Never a dead click.
function goClaim() {
    const alerts = document.getElementById('alertsCard');
    const missed = document.getElementById('missedCard');
    const card = (alerts && !alerts.hidden) ? alerts
        : (missed && !missed.hidden) ? missed
        : document.getElementById('poolBanner');
    if (!card) return;
    card.scrollIntoView({ behavior: 'smooth', block: 'start' });
    card.classList.add('flash');
    setTimeout(() => card.classList.remove('flash'), 1400);
}

const ACTIONS = {
    applyNewPassword, checkEmail, checkPassword, closeAuthModal, closeReport,
    dismissLangHint, dismissPayBanner, exitDemo, focusEmailCheck, goClaim, goMonitor,
    openAuthModal, openChangePassword, openReport, openSampleReport, printReport,
    sendPasswordReset, showAllBreaches, signInWithEmail, signInWithProvider,
    signOut, signUpWithEmail, startMonitor, startPurchase, switchForm,
    toggleNewPasswordVisibility, togglePasswordFold, togglePasswordVisibility,
    togglePwField, toggleUserMenu,
};

// These two were written to take the button itself, to put a spinner in it
// and to find the list it belongs to. The rest take the attribute's literals,
// or nothing at all.
const ACTIONS_TAKING_ELEMENT = new Set(['showAllBreaches', 'startPurchase', 'startMonitor']);

document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const fn = ACTIONS[el.dataset.action];
    if (!fn) {
        console.error('No handler for action:', el.dataset.action);
        return;
    }
    if (ACTIONS_TAKING_ELEMENT.has(el.dataset.action)) fn(el);
    else if (el.dataset.arg !== undefined) fn(el.dataset.arg, el.dataset.arg2);
    else fn();
});

document.addEventListener('click', (e) => {
    // Close the account dropdown when clicking anywhere else.
    if (!e.target.closest('.user-menu')) {
        document.getElementById('userDropdown').classList.remove('active');
    }
});

// Paso 2 chips toggle and the state select both change who matches, so each
// recomputes the number and the locked list. Delegated, because the chips are
// written into the card after the dataset loads.
document.addEventListener('click', (e) => {
    const chip = e.target.closest('.cc-chip');
    // Closed chips are informational, not selectable: they carry no open claim,
    // so toggling one would offer a selection that can never add to the total.
    if (!chip || chip.classList.contains('cc-closed')) return;
    chip.classList.toggle('on');
    renderFunnelNumber();
});
document.addEventListener('change', (e) => {
    // The month/year switch rewrites the three monitoring prices in place.
    if (e.target && e.target.id === 'monitorYearly') renderMonitorPrices();
});

// Enter submits from either input.
document.getElementById('emailInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') checkEmail();
});
document.getElementById('passwordInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') checkPassword();
});

window.addEventListener('DOMContentLoaded', async () => {
    applyLang();

    loadDailyHack();
    loadFunnel();

    const priceReady = loadPrice();

    initSupabase();

    const params = new URLSearchParams(window.location.search);
    if (params.get('demo') === '1') {
        // ?demo=1&teaser=1 shows the unpaid view instead of the full plan.
        demoTeaser = params.get('teaser') === '1';
        if (window.sbClient) initAuth();
        startDemo().then(() => {
            // ?demo=1&report=1 jumps straight to the action plan.
            if (params.get('report') === '1' || demoTeaser) openReport();
        });
        return;
    }

    // Coming back from Stripe Checkout needs the session resolved and the
    // price loaded first: the first says whose purchase to look for, the
    // second says whether this deployment is looking at test rows or real
    // ones.
    // Stripe return: ?checkout=success|cancel (&plan=report|breach|...).
    const checkout = params.get('checkout');
    // ?plan=1 is the link in the purchase receipt. It needs the session
    // resolved too, because whose plan to open is a question only the
    // session answers.
    const wantsPlan = params.get('plan') === '1';
    if (window.sbClient) {
        const ready = initAuth();
        if (checkout || wantsPlan) await ready;
    }
    if (checkout) {
        await priceReady;
        try { history.replaceState(null, '', window.location.pathname); } catch (e) { /* ignore */ }
        if (checkout === 'cancel') {
            showPayBanner(t().payCancelled, 'warn');
        } else if (params.get('plan') === 'report') {
            if (currentUser) {
                // Signed-in buyer: confirm entitlement, then open the report.
                await handleReturnFromCheckout('ok');
            } else {
                // Guest buyer: the account is being created from the paid email
                // and a magic link is on its way. There is nothing to open here.
                showPayBanner(lang === 'es'
                    ? 'Pago recibido. Te enviamos un enlace para abrir tu Informe Completo. Revisa tu correo (y la carpeta de spam).'
                    : 'Payment received. We emailed you a link to open your Full Report. Check your inbox (and spam).');
            }
        } else {
            // A monitoring subscription: it activates once the owner confirms
            // the email we just sent.
            showPayBanner(lang === 'es'
                ? 'Pago recibido. Revisa tu correo para confirmar el monitoreo.'
                : 'Payment received. Check your email to confirm your monitoring.');
        }
        return;
    }
    if (wantsPlan) {
        await priceReady;
        await openPlanForAccount();
    }
});
