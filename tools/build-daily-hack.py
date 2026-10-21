#!/usr/bin/env python3
"""Genera /daily-hack/ y /es/daily-hack/ desde data/radar.json.

Las dos paginas salen del mismo registro y se diferencian en dos cosas: el
idioma, y el orden de los bloques regionales. En ingles manda Estados Unidos,
que es el mercado que paga; en espanol manda Peru, que es donde no tenemos
competencia. Eso no es una preferencia de diseno, es la razon de que existan
las dos paginas.

Las filas van escritas en el HTML, no cargadas por JavaScript: un rastreador
que no ejecuta scripts tiene que poder leer la tabla, que es todo el contenido
que esta pagina tiene para ofrecer. El JavaScript solo esconde filas.

Escribe tambien /daily-hack.json, dos numeros que la portada lee para poner la
cifra del dia en el boton rojo.
"""
import datetime as dt
import html
import json
import os
import sys
from collections import Counter
from urllib.parse import urlsplit

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _radar import (ESTADOS, ESTADOS_CORTO, PAISES, REGIONES,  # noqa: E402
                    SECTORES, TIPOS, etiqueta, pais, region)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DOM = 'https://www.am-i-exposed.com'

# Cuanto se publica. "Daily" quiere decir lo de esta semana; el resto del
# historico vive en data/radar.json y alimenta las cifras, no la tabla.
DIAS_PAGINA = 7
FILAS_VISIBLES = 40
# Debajo de este ancho la tabla deja de ser tabla y cada fila es una ficha.
# Seis columnas con "Servicios Financieros y Seguros" dentro no caben en la
# pantalla de un portatil, y el desbordamiento lateral no se ve: la fila se
# lee cortada y la ultima columna es inalcanzable.
FICHA_HASTA = 1000

RUTAS = {'en': '/daily-hack/', 'es': '/es/daily-hack/'}
SALIDA = {'en': 'daily-hack', 'es': os.path.join('es', 'daily-hack')}

MESES_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
            'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

T = {
 'es': {
  'title': 'Quién fue hackeado hoy: {n} víctimas nuevas | ¿Estoy expuesto?',
  'desc': ('Registro diario de empresas atacadas por ransomware, con país, '
           'industria, grupo y fuente. Actualizado cada mañana. Incluye Perú '
           'y América Latina.'),
  'ogtitle': 'Quién fue hackeado hoy',
  'brand': '¿Estoy expuesto?',
  'navcheck': 'Revisar mi correo', 'navcases': 'Acuerdos',
  'tag': 'Hackeos del día',
  'barmsg': '<b>{n} víctimas nuevas</b> publicadas por grupos de ransomware',
  'barnone': 'Sin casos nuevos en la última corrida',
  'barwhen': 'Actualizado <b>{d}</b> · 06:00 Lima',
  'stale': ('Los datos tienen más de 48 horas: la actualización automática no '
            'corrió. Lo que ves es del {d}.'),
  'h1': 'Quién fue hackeado hoy',
  'stand': ('Registro diario de empresas y entidades que los grupos de '
            'ransomware dicen haber atacado. {n} casos en los últimos {d} días, '
            'con la fuente de cada uno y la diferencia entre lo que el grupo '
            'reclama y lo que la víctima confirma.'),
  'k1': 'víctimas nuevas hoy', 'k2': 'casos en los últimos {d} días',
  'k3': 'en Perú y América Latina', 'k4': 'grupos criminales activos',
  'today': 'Lo de hoy', 'nothing': 'Hoy no hay casos nuevos.',
  'ctah': '¿Y tu correo?',
  'ctap': ('Cuando una de estas empresas pierde una base de datos, los correos '
           'y las contraseñas terminan circulando. La revisión es gratuita, no '
           'pide cuenta ni tarjeta, y tu correo no se guarda.'),
  'ctab': 'Revisar si mi correo se filtró',
  'ctaf': ('Se compara contra las brechas conocidas de Have I Been Pwned. '
           'La contraseña nunca sale de tu navegador.'),
  'fcountry': 'País', 'fsector': 'Industria', 'fgroup': 'Grupo',
  'fsearch': 'Buscar', 'fall': 'Todos', 'fallf': 'Todas',
  'fplace': 'Empresa, grupo, país', 'freset': 'Limpiar',
  'thdate': 'Fecha', 'thvictim': 'Víctima', 'thcountry': 'País',
  'thsector': 'Industria', 'thgroup': 'Grupo', 'thstate': 'Estado',
  'thsource': 'Fuente',
  'more': 'Mostrar todo', 'less': 'Mostrar menos',
  'cases': 'casos', 'case': 'caso', 'nomatch': 'Ningún caso coincide.',
  'sectorh': 'Por industria',
  'sectorp': ('Qué sectores concentran los ataques de la semana. Los casos que '
              'no pudimos identificar con certeza no aparecen aquí.'),
  'readh': 'Cómo leer esta página',
  'read1': ('<b>Lo que publica un grupo criminal es una afirmación, no una '
            'confirmación.</b> {c} de los {t} casos vienen del sitio de '
            'filtración del propio atacante: el grupo dice tener los datos y '
            'aún nadie lo verificó. Solo {v} fueron verificados por Have I Been '
            'Pwned. Cada fila dice en qué estado está y de dónde sale.'),
  'read2': ('El país y la industria los asignamos nosotros a partir del nombre '
            'de la organización. Cuando no estamos seguros decimos "sin '
            'identificar" en lugar de adivinar, así que esa columna tiene '
            'huecos a propósito.'),
  'nexth': 'Siguiente paso',
  'n1': 'Revisar si mi correo se filtró', 'n1d': 'gratis, sin cuenta',
  'n2': 'Acuerdos por filtración de datos',
  'n2d': 'casos en EE.UU. con monto y plazo para reclamar',
  'n3': 'Qué hacer si se filtró mi correo',
  'n4': 'Cómo saber si mi contraseña fue filtrada',
  'dish': 'Informamos, no acusamos',
  'dis1': ('Cada caso de esta página sale de lo que un grupo criminal publicó '
           'en su propio sitio de filtración, o de una brecha verificada por '
           'Have I Been Pwned. Que una empresa aparezca aquí significa que '
           '<b>alguien reclamó un ataque</b>: no es una sentencia, no prueba '
           'que la empresa hiciera algo mal, y no prueba que tus datos estén '
           'circulando.'),
  'dis2': ('No verificamos de forma independiente ninguna de esas afirmaciones, '
           'no alojamos datos filtrados y no publicamos nada de lo que los '
           'grupos dicen tener. Cada fila dice en qué estado está y enlaza su '
           'fuente para que lo compruebes tú.'),
  'src': 'Fuentes', 'under': 'bajo',
  'foot': 'Selentic Group, Lima.',
  'fcheck': 'Revisar mi correo', 'fcases': 'Acuerdos', 'ffaq': 'Preguntas frecuentes',
  'fmail': 'Si se filtró mi correo', 'fpw': 'Si se filtró mi contraseña',
  'fpriv': 'Privacidad', 'fterms': 'Términos',
 },
 'en': {
  'title': 'Who Got Hacked Today: {n} New Victims | Am I Exposed?',
  'desc': ('Daily record of companies hit by ransomware, with country, '
           'industry, group and source. Updated every morning. United States, '
           'Latin America and the rest of the world.'),
  'ogtitle': 'Who got hacked today',
  'brand': 'Am I Exposed?',
  'navcheck': 'Check my email', 'navcases': 'Settlements',
  'tag': 'Daily Hack',
  'barmsg': '<b>{n} new victims</b> posted by ransomware groups',
  'barnone': 'No new cases in the last run',
  'barwhen': 'Updated <b>{d}</b> · 06:00 Lima',
  'stale': ('This data is more than 48 hours old: the automatic update did not '
            'run. What you see is from {d}.'),
  'h1': 'Who got hacked today',
  'stand': ('A daily record of the companies and institutions that ransomware '
            'groups say they have attacked. {n} cases in the last {d} days, '
            'each with its source and with the difference between what the '
            'group claims and what the victim confirms.'),
  'k1': 'new victims today', 'k2': 'cases in the last {d} days',
  'k3': 'in the United States', 'k4': 'active criminal groups',
  'today': "Today's cases", 'nothing': 'No new cases today.',
  'ctah': 'What about your email?',
  'ctap': ('When one of these companies loses a database, the emails and '
           'passwords end up circulating. The check is free, needs no account '
           'and no card, and your email is not stored.'),
  'ctab': 'Check if my email was leaked',
  'ctaf': ('Checked against the known breaches in Have I Been Pwned. Your '
           'password never leaves your browser.'),
  'fcountry': 'Country', 'fsector': 'Industry', 'fgroup': 'Group',
  'fsearch': 'Search', 'fall': 'All', 'fallf': 'All',
  'fplace': 'Company, group, country', 'freset': 'Clear',
  'thdate': 'Date', 'thvictim': 'Victim', 'thcountry': 'Country',
  'thsector': 'Industry', 'thgroup': 'Group', 'thstate': 'Status',
  'thsource': 'Source',
  'more': 'Show all', 'less': 'Show less',
  'cases': 'cases', 'case': 'case', 'nomatch': 'No case matches.',
  'sectorh': 'By industry',
  'sectorp': ('Which sectors the week’s attacks fall into. Cases we could '
              'not identify with confidence are left out.'),
  'readh': 'How to read this page',
  'read1': ('<b>What a criminal group publishes is a claim, not a '
            'confirmation.</b> {c} of the {t} cases come from the attacker’s '
            'own leak site: the group says it holds the data and nobody has '
            'verified it. Only {v} were verified by Have I Been Pwned. Every '
            'row states its status and where it comes from.'),
  'read2': ('Country and industry are assigned by us from the name of the '
            'organisation. Where we are not confident we say "unidentified" '
            'rather than guess, so that column has gaps on purpose.'),
  'nexth': 'Next step',
  'n1': 'Check if my email was leaked', 'n1d': 'free, no account',
  'n2': 'Data breach settlements',
  'n2d': 'United States cases with amounts and claim deadlines',
  'n3': 'What to do if your email was leaked',
  'n4': 'How to know if your password was leaked',
  'dish': 'We report, we do not accuse',
  'dis1': ('Every case on this page comes from what a criminal group published '
           'on its own leak site, or from a breach verified by Have I Been '
           'Pwned. A company appearing here means <b>someone claimed an '
           'attack</b>: it is not a verdict, it does not prove the company did '
           'anything wrong, and it does not prove your data is circulating.'),
  'dis2': ('We do not independently verify any of those claims, we do not host '
           'leaked data, and we publish none of what the groups say they hold. '
           'Every row states its status and links to its source so you can '
           'check it yourself.'),
  'src': 'Sources', 'under': 'under',
  'foot': 'Selentic Group, Lima.',
  'fcheck': 'Check my email', 'fcases': 'Settlements', 'ffaq': 'FAQ',
  'fmail': 'If your email leaked', 'fpw': 'If your password leaked',
  'fpriv': 'Privacy', 'fterms': 'Terms',
 },
}

ENLACES = {
    'es': {'home': '/es/', 'cases': '/settlements/', 'faq': '/es/preguntas-frecuentes/',
           'mail': '/es/que-hacer-si-se-filtro-mi-correo/',
           'pw': '/es/como-saber-si-mi-contrasena-fue-filtrada/',
           'priv': '/es/privacidad/', 'terms': '/es/terminos/'},
    'en': {'home': '/', 'cases': '/settlements/', 'faq': '/faq/',
           'mail': '/what-to-do-if-your-email-was-leaked/',
           'pw': '/how-to-know-if-your-password-was-leaked/',
           'priv': '/privacy/', 'terms': '/terms/'},
}

E = html.escape


# Esta pagina enlaza a sus dos fuentes y a nada mas. Todo lo demas que sale
# en un href esta escrito a mano en la plantilla, no pasa por aqui.
HOSTS = {'www.ransomlook.io', 'ransomlook.io', 'haveibeenpwned.com'}


def etiquetas_movil(t):
    """Las etiquetas de la ficha movil, puestas por CSS y no como atributo en
    cada celda: son siete por fila y doscientas y pico filas por pagina."""
    cols = ['thdate', 'thvictim', 'thcountry', 'thsector', 'thgroup', 'thstate']
    reglas = '\n'.join(
        ' tbody td:nth-child(%d)::before{content:"%s"}' % (n, t[c])
        for n, c in enumerate(cols, 1))
    return '@media (max-width:%dpx){\n%s\n}\n' % (FICHA_HASTA, reglas)


def href(url):
    """Lo que puede salir como enlace, y nada mas. La comprobacion se repite
    aqui aunque el exportador ya la haga, porque una fila vieja del archivo no
    volvio a pasar por el exportador. Sin host conocido y esquema utilizable,
    la fuente se muestra como texto."""
    u = (url or '').strip()
    if not u or any(c in u for c in '\\@'):
        return ''
    if any(ord(c) <= 0x20 or ord(c) == 0x7f for c in u):
        return ''
    try:
        p = urlsplit(u)
        if p.scheme in ('http', 'https') and p.hostname in HOSTS and not p.port:
            return u
    except ValueError:
        pass
    return ''


def fecha(iso, idioma):
    y, m, d = iso.split('-')
    if idioma == 'es':
        return f'{d}/{m}/{y}'
    return f'{MESES_EN[int(m) - 1]} {int(d)}, {y}'


CSS = """
:root{color-scheme:light;
 --alert:#C4121F;--alert-ink:#8E0F18;--alert-soft:#FDEDEE;--alert-line:rgba(196,18,31,.28);
 --ok:#17784F;--ok-soft:rgba(23,120,79,.10)}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){
 --alert:#E2454F;--alert-ink:#FFB4B8;--alert-soft:#261214;--alert-line:rgba(226,69,79,.35);
 --ok:#5FC79A;--ok-soft:rgba(95,199,154,.12)}}
:root[data-theme="dark"]{
 --alert:#E2454F;--alert-ink:#FFB4B8;--alert-soft:#261214;--alert-line:rgba(226,69,79,.35);
 --ok:#5FC79A;--ok-soft:rgba(95,199,154,.12)}
.head-links a[aria-current]{color:var(--alert);font-weight:600}
.alertbar{background:var(--alert);color:#fff}
.alertbar .wrap{display:flex;align-items:center;gap:14px;flex-wrap:wrap;padding-block:11px}
.alertbar .tag{font-family:var(--display);font-weight:900;font-size:13px;letter-spacing:.14em;
 text-transform:uppercase;display:inline-flex;align-items:center;gap:8px;white-space:nowrap}
.alertbar .dot{width:9px;height:9px;border-radius:50%;background:#fff;flex:none}
@media (prefers-reduced-motion:no-preference){.alertbar .dot{animation:dhpulse 2.2s ease-out infinite}}
@keyframes dhpulse{0%{box-shadow:0 0 0 0 rgba(255,255,255,.65)}
 70%{box-shadow:0 0 0 11px rgba(255,255,255,0)}100%{box-shadow:0 0 0 0 rgba(255,255,255,0)}}
.alertbar .msg{font-size:15px}
.alertbar .when{font-size:13px;color:rgba(255,255,255,.78);margin-left:auto;white-space:nowrap}
.stale{background:var(--alert-soft);border:1px solid var(--alert-line);color:var(--alert-ink);
 border-radius:10px;padding:12px 15px;margin:0 0 20px;font-size:15px}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;
 margin:0 0 26px;padding:0;list-style:none}
.kpi{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:15px 16px}
.kpi .n{font-family:var(--display);font-weight:900;font-size:34px;line-height:1;color:var(--ink);
 font-variant-numeric:tabular-nums}
.kpi .l{font-size:13.5px;color:var(--muted);margin-top:5px;line-height:1.35}
.kpi.hot{border-color:var(--alert-line);background:var(--alert-soft)}
.kpi.hot .n{color:var(--alert)}
.today{display:grid;gap:10px;margin:0 0 10px}
.card{background:var(--surface);border:1px solid var(--line);border-left:4px solid var(--alert);
 border-radius:10px;padding:13px 15px}
.card .vic{font-family:var(--display);font-weight:800;font-size:17.5px;color:var(--ink)}
.card .ln{font-size:14px;color:var(--muted);margin-top:3px}
.card .ln b{color:var(--ink-soft);font-weight:600}
.badge{display:inline-block;font-size:11.5px;font-weight:600;letter-spacing:.04em;
 text-transform:uppercase;padding:2px 8px;border-radius:999px;margin-right:6px}
.badge.claim{background:var(--alert-soft);color:var(--alert-ink);border:1px solid var(--alert-line)}
.badge.conf{background:var(--ok-soft);color:var(--ok);border:1px solid var(--ok)}
.cta{background:var(--ink);border-radius:14px;padding:26px 24px;margin:34px 0 10px}
.cta h2{color:var(--bg);margin:0 0 8px;font-size:25px}
.cta p{color:var(--muted);margin:0 0 18px;max-width:58ch}
.cta-btn{display:inline-block;background:var(--alert);color:#fff;text-decoration:none;
 font-weight:700;font-size:17px;font-family:var(--display);padding:13px 24px;border-radius:10px}
.cta-btn:hover{opacity:.9;color:#fff}
.cta .fine{font-size:13.5px;margin:12px 0 0}
.filters{display:flex;flex-wrap:wrap;gap:10px;align-items:flex-end;margin:28px 0 18px}
.fld{display:grid;gap:4px;min-width:0}
.fld label{font-size:11.5px;letter-spacing:.07em;text-transform:uppercase;color:var(--muted);
 font-weight:600}
select,input[type=search]{font:inherit;font-size:15px;color:var(--ink);background:var(--surface);
 border:1px solid var(--line);border-radius:8px;padding:8px 10px;max-width:100%}
input[type=search]{width:210px}
.btn{font:inherit;font-size:14.5px;font-weight:600;background:var(--surface);color:var(--ink);
 border:1px solid var(--line);border-radius:8px;padding:8px 14px;cursor:pointer}
.btn:hover{border-color:var(--accent);color:var(--accent-ink)}
.region{margin:0 0 30px}
.region h2{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}
.region h2 .c{font-size:14px;font-weight:500;color:var(--muted);font-variant-numeric:tabular-nums}
.tablewrap{overflow-x:auto;border:1px solid var(--line);border-radius:12px;background:var(--surface)}
table{border-collapse:collapse;width:100%;font-size:15px}
@media (min-width:1001px){table{min-width:720px}}
/* El contenedor del sitio mide 980px, que es la medida de un texto, no la de
   una tabla de seis columnas: ahi dentro la ultima columna quedaba cortada en
   cualquier pantalla. Las secciones de tabla se salen de esa caja y se
   centran solas; el texto de alrededor conserva su medida. */
@media (min-width:1001px){
 .region{width:min(1240px,calc(100vw - 32px));
  margin-left:calc((100% - min(1240px,100vw - 32px)) / 2)}
}
th,td{text-align:left;vertical-align:top;padding:10px 12px;border-bottom:1px solid var(--line)}
th{font-size:11.5px;letter-spacing:.07em;text-transform:uppercase;color:var(--muted);
 font-weight:600;background:var(--bg)}
tbody tr:last-child td{border-bottom:0}
td.d{white-space:nowrap;font-variant-numeric:tabular-nums;color:var(--muted);font-size:14px}
td .v,td.v{font-weight:600;color:var(--ink)}
/* El nombre enlaza a la fuente: subrayado tenue para que se vea que se puede
   entrar, sin pintar de azul doscientas filas. */
td.v a,.card .vic a{color:inherit;text-decoration:underline;
 text-decoration-color:var(--line);text-underline-offset:3px}
td.v a:hover,.card .vic a:hover{color:var(--accent-ink);text-decoration-color:currentColor}
td .s{font-size:13.5px;color:var(--muted)}
tr[hidden]{display:none}
.more{display:flex;justify-content:center;margin:12px 0 0}
.empty{padding:28px 16px;text-align:center;color:var(--muted)}
.bars{display:grid;gap:7px;margin:0 0 26px}
.bar{display:grid;grid-template-columns:minmax(118px,230px) minmax(0,1fr) 42px;align-items:center;
 gap:11px;padding:3px 0}
.bar .lab{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:14.5px}
.bar .tr{height:10px;background:var(--accent-soft);border-radius:3px;overflow:hidden}
.bar .tr i{display:block;height:100%;background:var(--accent);border-radius:3px}
.bar .c{font-size:13.5px;color:var(--muted);text-align:right;font-variant-numeric:tabular-nums}
.disclaimer{background:var(--surface);border:1px solid var(--line);border-left:3px solid var(--alert);
 border-radius:10px;padding:16px 18px;margin:0 0 20px}
.disclaimer h2{font-size:16px;margin:0 0 7px;color:var(--ink)}
.disclaimer p{font-size:14.5px;line-height:1.55;margin:0 0 10px;max-width:74ch}
.disclaimer p:last-child{margin-bottom:0}
.sources{font-size:13.5px;color:var(--muted);margin:0 0 14px}
@media (max-width:620px){.alertbar .when{margin-left:0;width:100%}}

/* Debajo de 760px la tabla deja de ser una tabla. Con siete columnas y un
   movil, lo que pasaba antes es que Estado y Fuente quedaban fuera de la
   pantalla y nada indicaba que habia que desplazar a un lado: la fila se
   leia incompleta y el enlace a la fuente era inalcanzable. Aqui cada fila
   es una ficha y cada dato lleva su etiqueta delante, generada por CSS para
   no repetirla doscientas veces en el HTML. */
@media (max-width:1000px){
 .tablewrap{overflow-x:visible;border:0;border-radius:0;background:none}
 table{font-size:15px}
 thead{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
 tbody tr{display:block;background:var(--surface);border:1px solid var(--line);
  border-left:3px solid var(--alert);border-radius:10px;padding:11px 13px;margin-bottom:10px}
 tbody td{display:grid;grid-template-columns:minmax(74px,88px) minmax(0,1fr);
  gap:4px 10px;align-items:baseline;justify-items:start;border:0;padding:3px 0}
 /* Toda la celda cae en la segunda columna. Sin esto, una celda con dos
    hijos manda el segundo a la columna de la etiqueta, y la insignia se
    estira de lado a lado porque una celda de rejilla ocupa su hueco. */
 tbody td>*{grid-column:2}
 tbody td::before{color:var(--muted);font-size:11.5px;
  font-weight:600;letter-spacing:.06em;text-transform:uppercase;line-height:1.7}
 tbody td.d{font-size:14px}
 tbody td.v{font-size:16px}
 tbody tr:last-child td{border:0}
}
"""

JS = """
(function(){
 var q=document.getElementById('fQ'),c=document.getElementById('fCountry'),
     s=document.getElementById('fSector'),g=document.getElementById('fGroup'),
     r=document.getElementById('fReset');
 var LIM=%(lim)d;
 function texto(tr){
  if(!tr._t)tr._t=(tr.textContent||'').toLowerCase();
  return tr._t;
 }
 function paint(){
  var Q=q.value.trim().toLowerCase(),C=c.value,S=s.value,G=g.value;
  var open=Q||C||S||G;
  document.querySelectorAll('section.region').forEach(function(sec){
   var n=0;
   sec.querySelectorAll('tr[data-r]').forEach(function(tr){
    var ok=(!C||tr.dataset.c===C)&&(!S||tr.dataset.s===S)&&(!G||tr.dataset.g===G)
           &&(!Q||texto(tr).indexOf(Q)>=0);
    if(ok)n++;
    tr.hidden=!ok||(!open&&n>LIM&&!sec.classList.contains('all'));
   });
   sec.querySelector('.c').textContent=n+' '+(n===1?'%(one)s':'%(many)s');
   var btn=sec.querySelector('.more button');
   if(btn)btn.hidden=open||n<=LIM;
   var em=sec.querySelector('.empty');
   if(em)em.hidden=n>0;
   sec.hidden=open&&n===0;
  });
 }
 [q,c,s,g].forEach(function(el){el.addEventListener('input',paint);el.addEventListener('change',paint);});
 r.addEventListener('click',function(){q.value='';c.value='';s.value='';g.value='';paint();});
 document.querySelectorAll('.more button').forEach(function(b){
  b.addEventListener('click',function(){
   var sec=b.closest('section.region');
   sec.classList.toggle('all');
   b.textContent=sec.classList.contains('all')?'%(less)s':'%(more)s';
   paint();
  });
 });
 paint();
})();
"""


def pagina(idioma, datos, hoy):
    t = T[idioma]
    L = ENLACES[idioma]
    otro = 'en' if idioma == 'es' else 'es'

    items = datos['items']
    dias = sorted({c['day'] for c in items})
    ultimo = dias[-1] if dias else hoy
    corte = (dt.date.fromisoformat(ultimo)
             - dt.timedelta(days=DIAS_PAGINA - 1)).isoformat()
    semana = [c for c in items if c['day'] >= corte]

    n_hoy = sum(1 for c in items if c['day'] == ultimo)
    n_total = len(semana)
    verificados = sum(1 for c in semana if c['status'] == 'verificado')
    grupos = len({c['group'] for c in semana if c['group'] != '—'})
    if idioma == 'es':
        foco = sum(1 for c in semana if region(c['country'], 'es') in ('peru', 'latam'))
    else:
        foco = sum(1 for c in semana if c['country'] == 'US')

    atrasado = (dt.date.fromisoformat(hoy) - dt.date.fromisoformat(ultimo)).days >= 2

    o = []
    w = o.append
    w('<!DOCTYPE html>')
    w(f'<html lang="{idioma}">')
    w('<head>')
    w('    <meta charset="UTF-8">')
    w('    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">')
    w(f'    <title>{E(t["title"].format(n=n_hoy))}</title>')
    w(f'    <meta name="description" content="{E(t["desc"])}">')
    w('    <meta name="robots" content="index, follow">')
    w('    <meta name="theme-color" content="#FAFAFA">')
    w(f'    <link rel="canonical" href="{DOM}{RUTAS[idioma]}">')
    w(f'    <link rel="alternate" hreflang="es" href="{DOM}{RUTAS["es"]}">')
    w(f'    <link rel="alternate" hreflang="en" href="{DOM}{RUTAS["en"]}">')
    w(f'    <link rel="alternate" hreflang="x-default" href="{DOM}{RUTAS["en"]}">')
    w('')
    w('    <meta property="og:type" content="website">')
    w('    <meta property="og:site_name" content="Am I Exposed?">')
    w(f'    <meta property="og:locale" content="{"es_PE" if idioma == "es" else "en_US"}">')
    w(f'    <meta property="og:title" content="{E(t["ogtitle"])}">')
    w(f'    <meta property="og:description" content="{E(t["desc"])}">')
    w(f'    <meta property="og:url" content="{DOM}{RUTAS[idioma]}">')
    w('')
    w('    <link rel="icon" href="/icon.svg" type="image/svg+xml">')
    w('    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>')
    w('    <link href="https://fonts.googleapis.com/css2?family=Nunito:wght@700;800;900'
      '&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">')
    w('    <link rel="stylesheet" href="/content.css">')
    w(f'    <style>{CSS}{etiquetas_movil(t)}</style>')
    w('')
    # Dataset: es lo que hace que el resultado salga con fecha. license y
    # creator no son decoracion: son la atribucion que piden las dos fuentes.
    jsonld = {
        '@context': 'https://schema.org',
        '@type': 'Dataset',
        'name': t['ogtitle'],
        'description': t['desc'],
        'url': f'{DOM}{RUTAS[idioma]}',
        'inLanguage': idioma,
        'license': 'https://creativecommons.org/licenses/by/4.0/',
        'dateModified': datos['generated'][:10],
        'isAccessibleForFree': True,
        'creator': {'@type': 'Organization', 'name': 'Selentic Group',
                    'url': 'https://www.selenticgroup.com/'},
        'isBasedOn': [f['url'] for f in datos['sources']],
        'variableMeasured': ['victim', 'country', 'industry', 'group', 'status'],
    }
    w('    <script type="application/ld+json">')
    w(json.dumps(jsonld, ensure_ascii=False, indent=4))
    w('    </script>')
    w('</head>')
    w('<body>')
    w('')
    w('<header class="site-head">')
    w('    <div class="wrap">')
    w(f'        <a class="brand" href="{L["home"]}">')
    w('            <img src="/icon.svg" alt="" width="26" height="26">')
    w(f'            {E(t["brand"])}')
    w('        </a>')
    w('        <nav class="head-links">')
    w(f'            <a href="{RUTAS[idioma]}" aria-current="page">{E(t["tag"])}</a>')
    w(f'            <a href="{L["cases"]}">{E(t["navcases"])}</a>')
    w(f'            <a href="{L["home"]}">{E(t["navcheck"])}</a>')
    w(f'            <a class="lang-link" href="{RUTAS[otro]}" hreflang="{otro}">'
      f'{otro.upper()}</a>')
    w('        </nav>')
    w('    </div>')
    w('</header>')
    w('')
    w('<div class="alertbar">')
    w('    <div class="wrap">')
    w(f'        <span class="tag"><span class="dot"></span>{E(t["tag"])}</span>')
    msg = t['barmsg'].format(n=n_hoy) if n_hoy else t['barnone']
    w(f'        <span class="msg">{msg}</span>')
    w(f'        <span class="when">{t["barwhen"].format(d=fecha(ultimo, idioma))}</span>')
    w('    </div>')
    w('</div>')
    w('')
    w('<main class="wrap">')
    w(f'    <h1>{E(t["h1"])}</h1>')
    if atrasado:
        w(f'    <p class="stale">{E(t["stale"].format(d=fecha(ultimo, idioma)))}</p>')
    w(f'    <p class="standfirst">{E(t["stand"].format(n=n_total, d=DIAS_PAGINA))}</p>')
    w('')
    w('    <ul class="kpis">')
    w(f'        <li class="kpi hot"><div class="n">{n_hoy}</div>'
      f'<div class="l">{E(t["k1"])}</div></li>')
    w(f'        <li class="kpi"><div class="n">{n_total}</div>'
      f'<div class="l">{E(t["k2"].format(d=DIAS_PAGINA))}</div></li>')
    w(f'        <li class="kpi"><div class="n">{foco}</div>'
      f'<div class="l">{E(t["k3"])}</div></li>')
    w(f'        <li class="kpi"><div class="n">{grupos}</div>'
      f'<div class="l">{E(t["k4"])}</div></li>')
    w('    </ul>')
    w('')
    w(f'    <h2>{E(t["today"])}</h2>')
    hoy_items = [c for c in semana if c['day'] == ultimo][:6]
    if not hoy_items:
        w(f'    <p>{E(t["nothing"])}</p>')
    else:
        w('    <div class="today">')
        for c in hoy_items:
            marca = 'conf' if c['status'] in ('verificado', 'confirmado') else 'claim'
            w('        <div class="card">')
            uc = href(c['sourceUrl'])
            nombre = (f'<a href="{E(uc)}" target="_blank" rel="noopener nofollow">'
                      f'{E(c["victim"])}</a>' if uc else E(c['victim']))
            w(f'            <div class="vic">{nombre}</div>')
            grupo = c['group'] if c['group'] != '—' else ''
            linea = f'<b>{E(grupo)}</b> · ' if grupo else ''
            linea += E(pais(c['country'], idioma))
            if c['sector'] != 'otros':
                linea += ' · ' + E(etiqueta(SECTORES, c['sector'], idioma))
            w(f'            <div class="ln"><span class="badge {marca}">'
              f'{E(etiqueta(ESTADOS, c["status"], idioma))}</span>{linea}</div>')
            u = href(c['sourceUrl'])
            w(f'            <div class="ln"><a href="{E(u)}" target="_blank" '
              f'rel="noopener nofollow">{E(c["source"])}</a></div>' if u
              else f'            <div class="ln">{E(c["source"])}</div>')
            w('        </div>')
        w('    </div>')
    w('')
    w('    <section class="cta">')
    w(f'        <h2>{E(t["ctah"])}</h2>')
    w(f'        <p>{E(t["ctap"])}</p>')
    w(f'        <a class="cta-btn" href="{L["home"]}">{E(t["ctab"])}</a>')
    w(f'        <p class="fine">{E(t["ctaf"])}</p>')
    w('    </section>')
    w('')
    # Filtros. Las opciones salen de lo que hay en la semana: un desplegable
    # con paises que no aparecen en ninguna fila es un callejon sin salida.
    paises_pres = sorted({c['country'] for c in semana if c['country']},
                         key=lambda x: pais(x, idioma))
    sect_pres = sorted({c['sector'] for c in semana if c['sector'] != 'otros'},
                       key=lambda x: etiqueta(SECTORES, x, idioma))
    grupos_pres = sorted({c['group'] for c in semana if c['group'] != '—'},
                         key=str.lower)
    w('    <div class="filters">')
    w(f'        <div class="fld"><label for="fCountry">{E(t["fcountry"])}</label>'
      '<select id="fCountry">')
    w(f'            <option value="">{E(t["fall"])}</option>')
    for p in paises_pres:
        w(f'            <option value="{p}">{E(pais(p, idioma))}</option>')
    w('        </select></div>')
    w(f'        <div class="fld"><label for="fSector">{E(t["fsector"])}</label>'
      '<select id="fSector">')
    w(f'            <option value="">{E(t["fallf"])}</option>')
    for s in sect_pres:
        w(f'            <option value="{s}">{E(etiqueta(SECTORES, s, idioma))}</option>')
    w('        </select></div>')
    w(f'        <div class="fld"><label for="fGroup">{E(t["fgroup"])}</label>'
      '<select id="fGroup">')
    w(f'            <option value="">{E(t["fall"])}</option>')
    for g in grupos_pres:
        w(f'            <option value="{E(g)}">{E(g)}</option>')
    w('        </select></div>')
    w(f'        <div class="fld"><label for="fQ">{E(t["fsearch"])}</label>'
      f'<input type="search" id="fQ" placeholder="{E(t["fplace"])}"></div>')
    w(f'        <button class="btn" type="button" id="fReset">{E(t["freset"])}</button>')
    w('    </div>')
    w('')
    for clave, titulo in REGIONES[idioma]:
        filas = [c for c in semana if region(c['country'], idioma) == clave]
        if not filas:
            continue
        w(f'    <section class="region" id="r-{clave}">')
        w(f'        <h2>{E(titulo)} <span class="c">{len(filas)} '
          f'{E(t["cases"] if len(filas) != 1 else t["case"])}</span></h2>')
        w('        <div class="tablewrap"><table>')
        # Seis columnas, no siete: la fuente vive dentro de la de estado,
        # porque el nombre de la victima ya es su enlace.
        w('            <thead><tr>'
          f'<th>{E(t["thdate"])}</th><th>{E(t["thvictim"])}</th>'
          f'<th>{E(t["thcountry"])}</th><th>{E(t["thsector"])}</th>'
          f'<th>{E(t["thgroup"])}</th><th>{E(t["thstate"])}</th>'
          '</tr></thead>')
        w('            <tbody>')
        # Una fila por linea y sin texto de busqueda duplicado en un atributo:
        # con doscientas y pico filas por pagina, cada adorno son kilobytes.
        for n, c in enumerate(filas):
            oculta = ' hidden' if n >= FILAS_VISIBLES else ''
            marca = 'conf' if c['status'] in ('verificado', 'confirmado') else 'claim'
            tipo = ('' if c['type'] == 'ransomware'
                    else f'<div class="s">{E(etiqueta(TIPOS, c["type"], idioma))}</div>')
            u = href(c['sourceUrl'])
            fuente = (f'<a class="s" href="{E(u)}" target="_blank" '
                      f'rel="noopener nofollow">{E(c["source"])}</a>' if u
                      else f'<span class="s">{E(c["source"])}</span>')
            # El nombre tambien enlaza: "ver el caso" es ver lo que publico la
            # fuente, porque de un caso no guardamos nada mas que esta fila.
            victima = (f'<a href="{E(u)}" target="_blank" rel="noopener nofollow">'
                       f'{E(c["victim"])}</a>' if u else E(c['victim']))
            w(f'<tr data-r data-c="{E(c["country"])}" data-s="{E(c["sector"])}" '
              f'data-g="{E(c["group"])}"{oculta}>'
              f'<td class="d">{fecha(c["day"], idioma)}</td>'
              f'<td class="v">{victima}</td>'
              f'<td>{E(pais(c["country"], idioma))}</td>'
              f'<td>{E(etiqueta(SECTORES, c["sector"], idioma))}</td>'
              f'<td>{E(c["group"])}</td>'
              f'<td><span class="badge {marca}" title="'
              f'{E(etiqueta(ESTADOS, c["status"], idioma))}">'
              f'{E(etiqueta(ESTADOS_CORTO, c["status"], idioma))}</span>{tipo}'
              f'<div class="s">{fuente}</div></td></tr>')
        w('            </tbody>')
        w('        </table>')
        w(f'        <div class="empty" hidden>{E(t["nomatch"])}</div>')
        w('        </div>')
        if len(filas) > FILAS_VISIBLES:
            w(f'        <div class="more"><button class="btn" type="button">'
              f'{E(t["more"])}</button></div>')
        w('    </section>')
    w('')
    cuenta = Counter(c['sector'] for c in semana if c['sector'] != 'otros')
    if cuenta:
        tope = cuenta.most_common(1)[0][1]
        w(f'    <h2>{E(t["sectorh"])}</h2>')
        w(f'    <p>{E(t["sectorp"])}</p>')
        w('    <div class="bars">')
        for s, n in cuenta.most_common():
            ancho = max(3, round(n / tope * 100))
            w(f'        <div class="bar"><span class="lab">'
              f'{E(etiqueta(SECTORES, s, idioma))}</span>'
              f'<span class="tr"><i style="width:{ancho}%"></i></span>'
              f'<span class="c">{n}</span></div>')
        w('    </div>')
    w('')
    w(f'    <h2>{E(t["readh"])}</h2>')
    w(f'    <p>{t["read1"].format(c=n_total - verificados, t=n_total, v=verificados)}</p>')
    w(f'    <p>{E(t["read2"])}</p>')
    w('')
    w(f'    <h2>{E(t["nexth"])}</h2>')
    w('    <ul>')
    w(f'        <li><a href="{L["home"]}">{E(t["n1"])}</a> &mdash; {E(t["n1d"])}</li>')
    w(f'        <li><a href="{L["cases"]}">{E(t["n2"])}</a> &mdash; {E(t["n2d"])}</li>')
    w(f'        <li><a href="{L["mail"]}">{E(t["n3"])}</a></li>')
    w(f'        <li><a href="{L["pw"]}">{E(t["n4"])}</a></li>')
    w('    </ul>')
    w('</main>')
    w('')
    w('<footer class="site-foot">')
    w('    <div class="wrap">')
    w('        <div class="disclaimer">')
    w(f'            <h2>{E(t["dish"])}</h2>')
    w(f'            <p>{t["dis1"]}</p>')
    w(f'            <p>{t["dis2"]}</p>')
    w('        </div>')
    fuentes = ' · '.join(
        f'<a href="{E(f["url"])}" target="_blank" rel="noopener">{E(f["nombre"])}</a> '
        f'{E(t["under"])} <a href="https://creativecommons.org/licenses/by/4.0/" '
        f'target="_blank" rel="noopener license">{E(f["licencia"])}</a>'
        for f in datos['sources'])
    w(f'        <p class="sources">{E(t["src"])}: {fuentes}</p>')
    w('        <nav class="foot-links">')
    w(f'            <a href="{L["home"]}">{E(t["fcheck"])}</a>')
    w(f'            <a href="{L["cases"]}">{E(t["fcases"])}</a>')
    w(f'            <a href="{L["faq"]}">{E(t["ffaq"])}</a>')
    w(f'            <a href="{L["mail"]}">{E(t["fmail"])}</a>')
    w(f'            <a href="{L["pw"]}">{E(t["fpw"])}</a>')
    w(f'            <a href="{L["priv"]}">{E(t["fpriv"])}</a>')
    w(f'            <a href="{L["terms"]}">{E(t["fterms"])}</a>')
    w('        </nav>')
    w(f'        <p>{E(t["foot"])}</p>')
    w('    </div>')
    w('</footer>')
    w('')
    w('<script>' + JS % {'lim': FILAS_VISIBLES, 'one': t['case'], 'many': t['cases'],
                         'more': t['more'], 'less': t['less']} + '</script>')
    w('<script>window.va = window.va || function () { '
      '(window.vaq = window.vaq || []).push(arguments); };</script>')
    w('<script defer src="/_vercel/insights/script.js"></script>')
    w('')
    w('</body>')
    w('</html>')
    return '\n'.join(o) + '\n', n_hoy, ultimo, n_total


def main():
    datos = json.load(open(os.path.join(ROOT, 'data', 'radar.json'), encoding='utf-8'))
    hoy = dt.date.today().isoformat()
    resumen = None
    for idioma in ('en', 'es'):
        texto, n_hoy, ultimo, n_total = pagina(idioma, datos, hoy)
        carpeta = os.path.join(ROOT, SALIDA[idioma])
        os.makedirs(carpeta, exist_ok=True)
        open(os.path.join(carpeta, 'index.html'), 'w', encoding='utf-8').write(texto)
        print(f'{SALIDA[idioma]}/index.html: {len(texto) // 1024} KB')
        resumen = {'date': ultimo, 'new': n_hoy, 'week': n_total}

    # Dos numeros para el boton de la portada. Se lee con fetch, asi que la
    # portada no hay que regenerarla cada dia para que la cifra sea de hoy.
    json.dump(resumen, open(os.path.join(ROOT, 'daily-hack.json'), 'w',
                            encoding='utf-8'), ensure_ascii=False)
    print(f'daily-hack.json: {resumen}')


if __name__ == '__main__':
    main()
