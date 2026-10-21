#!/usr/bin/env python3
"""Vocabulario compartido del Daily Hack.

Los registros se guardan con claves, no con texto: `pais` es un codigo ISO de
dos letras y `sector` es un slug. Las dos paginas, la inglesa y la espanola,
se generan del mismo registro, asi que traducir una etiqueta es cambiar una
linea de este archivo y no volver a clasificar nada.

La region no se guarda: se calcula al construir cada pagina, porque no es la
misma en los dos idiomas. En espanol el primer bloque es Peru y Estados Unidos
cae en "resto del mundo". En ingles el primer bloque es Estados Unidos y Peru
cae dentro de America Latina.
"""

# Los sectores que el clasificador puede elegir. Es una lista cerrada a
# proposito: un enum deja que el modelo responda "otros" en vez de inventar
# una categoria nueva que ninguna pagina sabe traducir.
SECTORES = {
    'gobierno':     ('Gobierno y Defensa',             'Government and Defence'),
    'telecom':      ('Telecomunicaciones',             'Telecommunications'),
    'finanzas':     ('Servicios Financieros y Seguros', 'Financial Services and Insurance'),
    'salud':        ('Salud',                          'Healthcare'),
    'educacion':    ('Educación',                      'Education'),
    'energia':      ('Energía y Servicios Públicos',   'Energy and Utilities'),
    'mineria':      ('Minería e Hidrocarburos',        'Mining and Oil'),
    'manufactura':  ('Manufactura',                    'Manufacturing'),
    'transporte':   ('Transporte y Logística',         'Transport and Logistics'),
    'retail':       ('Retail y Consumo',               'Retail and Consumer'),
    'tecnologia':   ('Tecnología',                     'Technology'),
    'servicios':    ('Servicios Profesionales',        'Professional Services'),
    'construccion': ('Construcción e Inmobiliaria',    'Construction and Real Estate'),
    'agro':         ('Agro y Alimentos',               'Agriculture and Food'),
    'hoteleria':    ('Hotelería y Turismo',            'Hospitality and Tourism'),
    'medios':       ('Medios y Entretenimiento',       'Media and Entertainment'),
    'otros':        ('Sin identificar',                'Unidentified'),
}

TIPOS = {
    'ransomware': ('Ransomware',            'Ransomware'),
    'filtracion': ('Filtración de datos',   'Data leak'),
}

ESTADOS = {
    'reclamado':  ('Reclamado por el grupo',        'Claimed by the group'),
    'confirmado': ('Confirmado por la víctima',     'Confirmed by the victim'),
    'verificado': ('Brecha verificada por HIBP',    'Breach verified by HIBP'),
}

# Paises que aparecen de verdad en los sitios de filtracion. No es la ISO
# entera: lo que no este aqui se muestra como "Sin identificar" en vez de
# inventarle un nombre a un codigo que el clasificador se saco de la manga.
PAISES = {
    'US': ('Estados Unidos', 'United States'), 'CA': ('Canadá', 'Canada'),
    'MX': ('México', 'Mexico'), 'GT': ('Guatemala', 'Guatemala'),
    'SV': ('El Salvador', 'El Salvador'), 'HN': ('Honduras', 'Honduras'),
    'NI': ('Nicaragua', 'Nicaragua'), 'CR': ('Costa Rica', 'Costa Rica'),
    'PA': ('Panamá', 'Panama'), 'CU': ('Cuba', 'Cuba'),
    'DO': ('República Dominicana', 'Dominican Republic'),
    'PR': ('Puerto Rico', 'Puerto Rico'), 'JM': ('Jamaica', 'Jamaica'),
    'TT': ('Trinidad y Tobago', 'Trinidad and Tobago'),
    'CO': ('Colombia', 'Colombia'), 'VE': ('Venezuela', 'Venezuela'),
    'EC': ('Ecuador', 'Ecuador'), 'PE': ('Perú', 'Peru'),
    'BO': ('Bolivia', 'Bolivia'), 'CL': ('Chile', 'Chile'),
    'AR': ('Argentina', 'Argentina'), 'UY': ('Uruguay', 'Uruguay'),
    'PY': ('Paraguay', 'Paraguay'), 'BR': ('Brasil', 'Brazil'),
    'ES': ('España', 'Spain'), 'PT': ('Portugal', 'Portugal'),
    'FR': ('Francia', 'France'), 'DE': ('Alemania', 'Germany'),
    'IT': ('Italia', 'Italy'), 'GB': ('Reino Unido', 'United Kingdom'),
    'IE': ('Irlanda', 'Ireland'), 'NL': ('Países Bajos', 'Netherlands'),
    'BE': ('Bélgica', 'Belgium'), 'CH': ('Suiza', 'Switzerland'),
    'AT': ('Austria', 'Austria'), 'SE': ('Suecia', 'Sweden'),
    'NO': ('Noruega', 'Norway'), 'DK': ('Dinamarca', 'Denmark'),
    'FI': ('Finlandia', 'Finland'), 'PL': ('Polonia', 'Poland'),
    'CZ': ('Chequia', 'Czechia'), 'SK': ('Eslovaquia', 'Slovakia'),
    'HU': ('Hungría', 'Hungary'), 'RO': ('Rumanía', 'Romania'),
    'BG': ('Bulgaria', 'Bulgaria'), 'GR': ('Grecia', 'Greece'),
    'TR': ('Turquía', 'Turkey'), 'UA': ('Ucrania', 'Ukraine'),
    'RU': ('Rusia', 'Russia'), 'IL': ('Israel', 'Israel'),
    'AE': ('Emiratos Árabes Unidos', 'United Arab Emirates'),
    'SA': ('Arabia Saudita', 'Saudi Arabia'), 'QA': ('Catar', 'Qatar'),
    'KW': ('Kuwait', 'Kuwait'), 'EG': ('Egipto', 'Egypt'),
    'MA': ('Marruecos', 'Morocco'), 'NG': ('Nigeria', 'Nigeria'),
    'KE': ('Kenia', 'Kenya'), 'ZA': ('Sudáfrica', 'South Africa'),
    'GA': ('Gabón', 'Gabon'), 'IN': ('India', 'India'),
    'PK': ('Pakistán', 'Pakistan'), 'BD': ('Bangladés', 'Bangladesh'),
    'CN': ('China', 'China'), 'HK': ('Hong Kong', 'Hong Kong'),
    'TW': ('Taiwán', 'Taiwan'), 'JP': ('Japón', 'Japan'),
    'KR': ('Corea del Sur', 'South Korea'), 'SG': ('Singapur', 'Singapore'),
    'MY': ('Malasia', 'Malaysia'), 'TH': ('Tailandia', 'Thailand'),
    'VN': ('Vietnam', 'Vietnam'), 'ID': ('Indonesia', 'Indonesia'),
    'PH': ('Filipinas', 'Philippines'), 'AU': ('Australia', 'Australia'),
    'NZ': ('Nueva Zelanda', 'New Zealand'),
}

# Lo que cuenta como America Latina para el bloque regional. Peru esta aqui
# tambien: en la pagina inglesa va dentro de este bloque, y en la espanola
# sale antes, en su propio bloque.
LATAM = {'MX', 'GT', 'SV', 'HN', 'NI', 'CR', 'PA', 'CU', 'DO', 'PR', 'JM', 'TT',
         'CO', 'VE', 'EC', 'PE', 'BO', 'CL', 'AR', 'UY', 'PY', 'BR'}

I = {'es': 0, 'en': 1}


def etiqueta(tabla, clave, idioma, defecto=''):
    """Traduce una clave con su tabla. Una clave que no existe no revienta la
    pagina: devuelve el defecto, que es lo que corresponde a un dato sucio."""
    fila = tabla.get(clave)
    return fila[I[idioma]] if fila else defecto


def pais(codigo, idioma):
    return etiqueta(PAISES, (codigo or '').upper(), idioma,
                    'Sin identificar' if idioma == 'es' else 'Unidentified')


def region(codigo, idioma):
    """El bloque regional al que va una victima, que depende del idioma."""
    c = (codigo or '').upper()
    if idioma == 'es':
        if c == 'PE':
            return 'peru'
        return 'latam' if c in LATAM else 'resto'
    if c == 'US':
        return 'usa'
    return 'latam' if c in LATAM else 'resto'


# El orden de los bloques en cada pagina, y como se titulan.
REGIONES = {
    'es': [('peru',  'Perú'),
           ('latam', 'América Latina'),
           ('resto', 'Resto del mundo')],
    'en': [('usa',   'United States'),
           ('latam', 'Latin America'),
           ('resto', 'Rest of the world')],
}
