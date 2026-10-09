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
    // The alert subscription takes the same route back from sign-in, and the
    // two are mutually exclusive: whichever button was pressed cleared the
    // other's flag before leaving.
    resumePendingAlerts();

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
        heroTitle: '¿Se filtraron tus datos?',
        heroLede: 'Escribe tu correo y te decimos en segundos si aparece en alguna filtración conocida, y qué hacer al respecto.',
        heroBtn: 'Revisar mi correo',
        heroPlaceholder: 'tucorreo@ejemplo.com',
        checking: 'Revisando...',
        trust1: 'No guardamos tu correo', trust2: 'Resultado inmediato', trust3: 'Sin publicidad',

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

        offerBadge: 'Reporte completo',
        offerTitle: 'Sabes que estás expuesto. Ahora, qué hacer.',
        offerLede: 'Un plan personalizado, escrito en palabras normales, ordenado de lo más urgente a lo que puede esperar.',
        offerLi1: 'Qué cuenta cambiar primero y exactamente cómo hacerlo',
        offerLi2: 'Pasos numerados, sin palabras técnicas',
        offerLi3: 'Descargable en PDF para imprimir o compartir',
        offerPer: 'por reporte', offerBtn: 'Ver un ejemplo',

        alertsBadge: 'Alertas &middot; solo EE.&nbsp;UU.',
        alertsTitle: 'Si demandan a una empresa que filtró tus datos, te avisamos.',
        alertsLede: 'Las empresas que pierden datos terminan pagando acuerdos colectivos. El dinero existe y casi nadie lo reclama, porque el aviso llega por correo postal y se confunde con publicidad.',
        alertsLi1: '1.614 casos en seguimiento, 307 todavía abiertos',
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
        alertsActive: 'Tus alertas están activas.',
        footLeft: '<a href="https://www.selenticgroup.com/" rel="noopener">Selentic Group</a> · Datos de filtraciones por <a href="https://haveibeenpwned.com/" rel="noopener">Have I Been Pwned</a>',
        footFaq: 'Preguntas frecuentes',
        footLeaked: 'Si se filtró tu correo',
        footPassword: 'Si se filtró tu contraseña',
        footPrivacy: 'Privacidad',
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
        expTitle: 'Tu correo sí aparece',
        expBody: (email, n) => `Encontramos <span class="who">${email}</span> en ${n} ${n === 1 ? 'filtración de datos' : 'filtraciones de datos'}. Esto es común y tiene solución.`,
        tallyBreaches: (n) => n === 1 ? 'filtración' : 'filtraciones',
        tallyAccounts: 'cuentas afectadas en total',
        tallyOldest: 'la más antigua',
        lblWhere: 'Dónde apareció tu correo',
        lblExposed: 'Qué se expuso sobre ti',
        inBreaches: (n) => n === 1 ? '1 filtración' : `${n} filtraciones`,
        accountsIn: 'cuentas en esta filtración',
        showMore: (n) => n === 1 ? 'Ver 1 filtración más' : `Ver las otras ${n} filtraciones`,
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

        planHeading: 'Tu plan de acción',
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
        paywallPitch: 'Cada uno te dice qué pasó, por qué importa y exactamente qué hacer, en palabras normales. También recibes la lista completa de todas las filtraciones en las que apareces, y una copia para imprimir o guardar.',
        paywallBtn: 'Desbloquear mi plan completo',
        paywallFine: 'Un solo pago. Puedes volver y actualizar tu plan durante 30 días.',

        payOpening: 'Abriendo la caja',
        payClose: 'Cerrar',
        payConfirming: 'Confirmando tu pago con Mercado Pago…',
        payReady: 'Pago confirmado. Tu plan completo ya está disponible.',
        payReadyCheck: 'Pago confirmado. Escribe tu correo arriba y te damos el plan completo.',
        paySlow: 'Tu pago se está procesando. Puede tardar unos minutos; vuelve a entrar con la misma cuenta y tu plan estará listo.',
        payPending: 'Tu pago quedó pendiente de acreditación. Cuando Mercado Pago lo confirme, tu plan completo se desbloquea solo.',
        payCancelled: 'El pago no se completó. No se cobró nada.',
        payFail: 'No pudimos abrir la caja. Intenta de nuevo en un momento.',
    },
    en: {
        docTitle: 'Check If Your Email Was in a Data Breach | Am I Exposed?',
        brand: 'Am I Exposed?',
        signin: 'Sign in', signout: 'Sign out', menu: 'My account',
        heroTag: 'Free',
        heroBadge: 'No account · No card',
        heroTitle: 'Was your data leaked?',
        heroLede: 'Type your email and we will tell you in seconds whether it shows up in a known breach, and what to do about it.',
        heroBtn: 'Check my email',
        heroPlaceholder: 'you@example.com',
        checking: 'Checking...',
        trust1: 'We never store your email', trust2: 'Instant result', trust3: 'No ads',

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

        offerBadge: 'Full report',
        offerTitle: 'You know you are exposed. Now, what to do.',
        offerLede: 'A personal plan written in plain words, ordered from most urgent to what can wait.',
        offerLi1: 'Which account to fix first, and exactly how',
        offerLi2: 'Numbered steps, no technical words',
        offerLi3: 'Downloadable as a PDF to print or share',
        offerPer: 'per report', offerBtn: 'See an example',

        alertsBadge: 'Alerts &middot; US only',
        alertsTitle: 'If a company that leaked your data gets sued, we’ll let you know.',
        alertsLede: 'Companies that lose data end up paying class action settlements. The money is real and almost nobody claims it, because the notice arrives by post and looks like junk mail.',
        alertsLi1: '1,614 cases tracked, 307 still open',
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
        alertsActive: 'Your alerts are on.',
        footLeft: '<a href="https://www.selenticgroup.com/" rel="noopener">Selentic Group</a> · Breach data by <a href="https://haveibeenpwned.com/" rel="noopener">Have I Been Pwned</a>',
        footFaq: 'FAQ',
        footLeaked: 'If your email leaked',
        footPassword: 'If your password leaked',
        footPrivacy: 'Privacy',
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
        expTitle: 'Your email does show up',
        expBody: (email, n) => `We found <span class="who">${email}</span> in ${n} data ${n === 1 ? 'breach' : 'breaches'}. This is common and it can be fixed.`,
        tallyBreaches: (n) => n === 1 ? 'breach' : 'breaches',
        tallyAccounts: 'accounts affected in total',
        tallyOldest: 'oldest one',
        lblWhere: 'Where your email showed up',
        lblExposed: 'What was exposed about you',
        inBreaches: (n) => n === 1 ? '1 breach' : `${n} breaches`,
        accountsIn: 'accounts in this breach',
        showMore: (n) => n === 1 ? 'Show 1 more breach' : `Show the other ${n} breaches`,
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

        planHeading: 'Your Personal Action Plan',
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
        paywallPitch: 'Each one tells you what happened, why it matters, and exactly what to do, in plain English. You also get the full list of every break-in you appear in, and a copy you can print or save.',
        paywallBtn: 'Unlock my full plan',
        paywallFine: 'One payment. You can come back and update your plan for 30 days.',

        payOpening: 'Opening the checkout',
        payClose: 'Close',
        payConfirming: 'Confirming your payment with Mercado Pago…',
        payReady: 'Payment confirmed. Your full plan is ready.',
        payReadyCheck: 'Payment confirmed. Type your email above and we will build your full plan.',
        paySlow: 'Your payment is still processing. It can take a few minutes; come back with the same account and your plan will be waiting.',
        payPending: 'Your payment has not cleared yet. As soon as Mercado Pago confirms it, your full plan unlocks on its own.',
        payCancelled: 'The payment was not completed. Nothing was charged.',
        payFail: 'We could not open the checkout. Please try again in a moment.',
    },
};

// The URL decides the language, because each language now has its own page:
// Spanish at / and English at /en/. Reading navigator.language here instead
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

    const key = currentUser ? `aie-announced-${currentUser.id}` : null;
    try {
        if (key && localStorage.getItem(key)) { accountAnnounced = true; return; }
        if (key) localStorage.setItem(key, '1');
    } catch (e) { /* private browsing; the server-side mark still holds */ }

    accountAnnounced = true;

    fetch('/api/account-sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accessToken, lang }),
    }).catch(e => console.error('Account sync failed:', e.name));
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
}

function renderEmailResult(breaches, email) {
    const resultDiv = document.getElementById('emailResult');
    const count = breaches.length;
    const unlocked = isUnlocked();

    // Which breaches you are in is free. What leaked in each one is gated.
    // A heavily exposed address can return hundreds of breaches. Showing
    // them all at once buries the gate and the next step under a wall of
    // names, so the tail is folded behind a button.
    const VISIBLE = 8;
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

    const shown = breaches.slice(0, VISIBLE).map(breachCard).join('');
    const restCount = breaches.length - VISIBLE;
    const breachHTML = restCount > 0
        ? shown
            + `<div id="breachRest" hidden>${breaches.slice(VISIBLE).map(breachCard).join('')}</div>`
            + `<button type="button" class="more-btn" onclick="showAllBreaches(this)">${escapeHtml(t().showMore(restCount))}</button>`
        : shown;

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
            <button class="btn sm accent" onclick="openReport()">${escapeHtml(t().nextBtn)}</button>
        </div>` : '';

    const gateHTML = unlocked ? '' : `
        <div class="gate">
            <h3>${escapeHtml(t().gateTitle)}</h3>
            <p>${escapeHtml(t().gateBody)}</p>
            <div class="gate-btns">
                <button class="btn sm" onclick="openAuthModal('signup')">${escapeHtml(t().gateSignup)}</button>
                <button class="ghost-btn" onclick="openAuthModal('signin')">${escapeHtml(t().gateSignin)}</button>
            </div>
        </div>`;

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
            <div class="section-lbl">${escapeHtml(t().lblWhere)}</div>
            ${breachHTML}
            ${nextHTML}
            ${gateHTML}
        </div>`;
    resultDiv.style.display = 'block';
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
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(demoMode
                    ? { demo: true, teaser: demoTeaser, lang }
                    : { email: lastEmailResult.email, accessToken, lang }),
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
    if (card) card.hidden = !lastEmailResult || !!currentUser || knownEntitled;

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

// Same shape as PURCHASE_INTENT above, and for the same reason: Google and
// GitHub sign-in leave the page entirely, so a variable does not survive the
// trip. The form values ride along, because being sent to sign in and coming
// back to three empty fields is a good way to lose somebody.
const ALERTS_INTENT = 'aie-alerts-after-signin';

let alertsConfig = null;      // null until asked, then {eligible, ...}
let alertsConfigAsked = false;
let paddleReady = false;
let alertsDone = false;       // checkout completed in this session

function stashAlertsIntent(value) {
    try {
        if (value) sessionStorage.setItem(ALERTS_INTENT, JSON.stringify(value));
        else sessionStorage.removeItem(ALERTS_INTENT);
    } catch (e) { /* private browsing; the click simply will not resume */ }
}

function readAlertsIntent() {
    try {
        const raw = sessionStorage.getItem(ALERTS_INTENT);
        return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
}

function fillAlertStates() {
    const select = document.getElementById('alertsState');
    if (!select || select.options.length) return;
    select.appendChild(new Option(t().alertsStatePick, ''));
    for (const name of US_STATES) select.appendChild(new Option(name, name));
}

// Asked once per visit, and only after somebody has actually run a check, so
// a visitor who reads the page and leaves never costs an invocation.
async function loadAlertsConfig() {
    if (alertsConfigAsked) return alertsConfig;
    alertsConfigAsked = true;
    try {
        const response = await fetch('/api/alerts-config');
        alertsConfig = response.ok ? await response.json() : { eligible: false };
    } catch (e) {
        // Not eligible rather than an error: a visitor should see no card,
        // not a card that breaks when they press it.
        alertsConfig = { eligible: false };
    }
    return alertsConfig;
}

async function refreshAlertsCard() {
    const card = document.getElementById('alertsCard');
    if (!card) return;

    // Same trigger as the paid card: only once a check has actually found
    // something. Before that the pitch has nothing to attach itself to.
    if (!lastEmailResult || alertsDone) { card.hidden = true; return; }

    const config = await loadAlertsConfig();
    card.hidden = !config.eligible;
    if (config.eligible) fillAlertStates();
}

function alertsError(message) {
    const box = document.getElementById('alertsError');
    if (!box) return;
    box.textContent = message || '';
    box.style.display = message ? 'block' : 'none';
}

function loadPaddle() {
    if (paddleReady) return Promise.resolve();
    return new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'https://cdn.paddle.com/paddle/v2/paddle.js';
        script.onload = () => { paddleReady = true; resolve(); };
        script.onerror = () => reject(new Error('paddle.js'));
        document.head.appendChild(script);
    });
}

function alertsFormValues() {
    return {
        firstName: (document.getElementById('alertsFirstName')?.value || '').trim(),
        lastName: (document.getElementById('alertsLastName')?.value || '').trim(),
        state: document.getElementById('alertsState')?.value || '',
        consent: !!document.getElementById('alertsConsent')?.checked,
    };
}

function applyAlertsForm(values) {
    if (!values) return;
    const set = (id, value) => {
        const el = document.getElementById(id);
        if (el && value) el.value = value;
    };
    set('alertsFirstName', values.firstName);
    set('alertsLastName', values.lastName);
    set('alertsState', values.state);
    const consent = document.getElementById('alertsConsent');
    if (consent && values.consent) consent.checked = true;
}

async function startAlertsCheckout() {
    const form = alertsFormValues();

    // Checked before anything else, so somebody is never sent off to create
    // an account only to be told on the way back that a field was empty.
    if (!form.firstName || !form.lastName) return alertsError(t().alertsErrName);
    if (!form.state) return alertsError(t().alertsErrState);
    if (!form.consent) return alertsError(t().alertsErrConsent);
    alertsError('');

    // No account yet. The subscription has to belong to one: user_id is what
    // the webhook writes the row against, and without it the event arrives
    // with nowhere to put it.
    if (!currentUser) {
        stashAlertsIntent(form);
        wantsToBuy(false);   // the two intents are mutually exclusive
        openAuthModal('signup');
        return;
    }

    await openAlertsCheckout(form);
}

async function openAlertsCheckout(form) {
    const button = document.getElementById('alertsBtn');
    const config = await loadAlertsConfig();
    if (!config.eligible) return alertsError(t().alertsErrFail);

    if (button) { button.disabled = true; button.textContent = t().alertsOpening; }

    try {
        await loadPaddle();

        if (config.environment === 'sandbox') Paddle.Environment.set('sandbox');

        Paddle.Initialize({
            token: config.token,
            eventCallback: (event) => {
                if (event?.name !== 'checkout.completed') return;
                // The row is written by the webhook, not here: this only
                // stops the page still offering something just bought.
                alertsDone = true;
                refreshAlertsCard();
            },
        });

        Paddle.Checkout.open({
            items: [{ priceId: config.priceId, quantity: 1 }],
            customer: { email: currentUser.email },
            // Paddle copies this onto the subscription when it is created,
            // which is how /api/paddle-webhook knows whose account this is.
            // Nothing else carries the link.
            customData: {
                user_id: currentUser.id,
                email: currentUser.email,
                first_name: form.firstName,
                last_name: form.lastName,
                state: form.state,
            },
            settings: {
                displayMode: 'overlay',
                theme: document.documentElement.dataset.theme === 'dark'
                    || window.matchMedia('(prefers-color-scheme: dark)').matches
                    ? 'dark' : 'light',
                locale: lang,
            },
        });
    } catch (error) {
        alertsError(t().alertsErrFail);
    } finally {
        if (button) { button.disabled = false; button.textContent = t().alertsBtn; }
    }
}

// Called from the same places as resumePendingPurchase, for the same reason.
function resumePendingAlerts() {
    const form = readAlertsIntent();
    if (!form || !currentUser) return;
    stashAlertsIntent(null);
    applyAlertsForm(form);
    // A beat for the modal to close, so the checkout does not open behind it.
    setTimeout(() => openAlertsCheckout(form), 400);
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
        + planSummaryHTML(data.stats, data.actions.length, criticals)
        + data.actions.map(actionHTML).join('')
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
        + planSummaryHTML(data.stats, data.totalActions, criticals)
        + `<div class="teaser-note">${escapeHtml(t().teaserNote)}</div>`
        + (data.preview ? actionHTML(data.preview, 0) : '')
        + `
        <section class="paywall">
            <h2>${escapeHtml(t().paywallTitle(locked.length))}</h2>
            <div class="locked-list">${lockedHTML}</div>
            <p class="paywall-pitch">${escapeHtml(t().paywallPitch)}</p>
            <button class="btn accent" onclick="startPurchase(this)">${escapeHtml(t().paywallBtn)}</button>
            <p class="paywall-fine">${escapeHtml(t().paywallFine)}</p>
        </section>`;
}

// =======================================================================
// PAYMENT (Mercado Pago)
// The amount is never written here. It comes from /api/checkout, which
// reads it from the environment, so the price exists in one place and a
// visitor cannot name their own.
// =======================================================================
let priceInfo = null;

async function loadPrice() {
    try {
        const response = await fetch('/api/checkout');
        if (!response.ok) return;
        const data = await response.json();
        if (data && data.available) {
            priceInfo = data;
            renderPrice();
        }
    } catch (e) { /* the card keeps its placeholder */ }
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
        return new Intl.NumberFormat(CURRENCY_LOCALE[currency] || locale(), {
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
    el.textContent = formatPrice(priceInfo);
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
    if (!currentUser) {
        wantsToBuy(true);
        stashAlertsIntent(null);   // the two intents are mutually exclusive
        openAuthModal('signup');
        return;
    }
    if (!requireClient()) return;

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
        const { data: { session } } = await window.sbClient.auth.getSession();
        const accessToken = session?.access_token || null;
        if (!accessToken) {
            restore();
            openAuthModal('signin');
            return;
        }

        // The checked address does not survive the round trip to Mercado
        // Pago, so it is parked here and picked up again on the way back.
        try {
            if (lastEmailResult) sessionStorage.setItem('aie-pending-email', lastEmailResult.email);
        } catch (e) { /* not essential */ }

        const response = await fetch('/api/checkout', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ accessToken, lang }),
        });
        const data = await response.json().catch(() => null);
        if (!response.ok || !data?.checkoutUrl) {
            throw new Error(data?.error || t().payFail);
        }
        window.location.href = data.checkoutUrl;
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
    // Test purchases and real ones share a table, so the check has to say
    // which of the two this deployment is talking about.
    const liveMode = priceInfo ? priceInfo.mode === 'live' : true;
    try {
        const { data, error } = await window.sbClient
            .from('purchases')
            .select('id')
            .eq('status', 'paid')
            .eq('live_mode', liveMode)
            .or(`expires_at.is.null,expires_at.gt.${new Date().toISOString()}`)
            .limit(1);
        if (error) return false;
        return Array.isArray(data) && data.length > 0;
    } catch (e) {
        return false;
    }
}

// Mercado Pago sends the buyer back to the site and the webhook separately,
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
    if (outcome === 'pendiente') {
        showPayBanner(t().payPending, 'warn');
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
                <button class="btn sm accent" onclick="openReport()">${escapeHtml(t().pwPlanBtnA)}</button>
            </div>`;
    }
    return `
        <div class="nextstep">
            <p><strong>${escapeHtml(t().pwPlanTitleA)}</strong> ${escapeHtml(t().pwPlanBodyB)}</p>
            <button class="btn sm accent" onclick="focusEmailCheck()">${escapeHtml(t().pwPlanBtnB)}</button>
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
                    <button class="btn sm" onclick="openAuthModal('signup')">${escapeHtml(t().gateSignup)}</button>
                    <button class="ghost-btn" onclick="openAuthModal('signin')">${escapeHtml(t().gateSignin)}</button>
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
document.addEventListener('click', (e) => {
    // Close the account dropdown when clicking anywhere else.
    if (!e.target.closest('.user-menu')) {
        document.getElementById('userDropdown').classList.remove('active');
    }
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

    // Coming back from Mercado Pago needs the session resolved and the
    // price loaded first: the first says whose purchase to look for, the
    // second says whether this deployment is looking at test rows or real
    // ones.
    const pago = params.get('pago');
    // ?plan=1 is the link in the purchase receipt. It needs the session
    // resolved too, because whose plan to open is a question only the
    // session answers.
    const wantsPlan = params.get('plan') === '1';
    if (window.sbClient) {
        const ready = initAuth();
        if (pago || wantsPlan) await ready;
    }
    if (pago) {
        await priceReady;
        await handleReturnFromCheckout(pago);
        return;
    }
    if (wantsPlan) {
        await priceReady;
        await openPlanForAccount();
    }
});
