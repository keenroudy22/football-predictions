"""Generate site/night.css: the existing stylesheets recolored for a dark board.

Reads the light stylesheets in load order, maps every colour through a
deterministic light-to-dark transform, and writes one override sheet that
loads last. Selectors, specificity and layout rules are untouched, so this
changes only colour. Re-runnable: edit the light CSS, run this again.

    python scripts/build_night_theme.py
"""
import colorsys
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SITE = os.path.join(ROOT, 'site')
SOURCES = ['style.css', 'readable.css', 'board.css', 'hub.css']
OUT = os.path.join(SITE, 'night.css')

# The board's own palette. Everything else is derived from these.
BG = (0.039, 0.051, 0.075)        # #0A0D13  page
SURFACE = (0.078, 0.102, 0.141)   # #141A24  card
RAISED = (0.114, 0.145, 0.192)    # #1D2531  control
LINE = (0.165, 0.204, 0.255)      # #2A3441  border
TEXT = (0.957, 0.969, 0.980)      # #F4F7FA  primary text
DIM = (0.580, 0.639, 0.706)       # #94A3B4  secondary text

# Semantic hues kept legible on a dark ground.
MINT = '#5eeaa4'
GREEN = '#3fd98b'
AMBER = '#ffb43d'
ROSE = '#ff5d6e'
SKY = '#6fc2f0'

HEX = re.compile(r'#([0-9a-fA-F]{3,8})\b')
# Keywords the stylesheets actually use. Routed through the same transform so a
# `background:white` becomes a surface, not a hole in the theme.
KEYWORDS = {'white': 'ffffff', 'black': '000000', 'whitesmoke': 'f5f5f5',
            'snow': 'fffafa', 'ivory': 'fffff0', 'gainsboro': 'dcdcdc',
            'silver': 'c0c0c0', 'lightgray': 'd3d3d3', 'lightgrey': 'd3d3d3'}
WORD = re.compile(r'(?<![\w-])(%s)(?![\w-])' % '|'.join(KEYWORDS), re.I)


def parse(raw):
    raw = raw.lstrip('#')
    if len(raw) in (3, 4):
        raw = ''.join(c * 2 for c in raw)
    alpha = raw[6:8] if len(raw) == 8 else ''
    r, g, b = (int(raw[i:i + 2], 16) / 255 for i in (0, 2, 4))
    return r, g, b, alpha


def emit(rgb, alpha=''):
    return '#%02x%02x%02x%s' % (
        max(0, min(255, round(rgb[0] * 255))),
        max(0, min(255, round(rgb[1] * 255))),
        max(0, min(255, round(rgb[2] * 255))), alpha)


def mix(a, b, t):
    return tuple(a[i] + (b[i] - a[i]) * t for i in range(3))


def luminance(rgb):
    def channel(c):
        return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4
    r, g, b = (channel(c) for c in rgb)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def contrast(fg, bg):
    a, b = luminance(fg), luminance(bg)
    hi, lo = max(a, b), min(a, b)
    return (hi + 0.05) / (lo + 0.05)


def lift(rgb, floor=4.5, against=BG):
    """Raise a colour's lightness until it clears a contrast ratio."""
    h, l, s = colorsys.rgb_to_hls(*rgb)
    for _ in range(60):
        if contrast(rgb, against) >= floor or l >= 0.97:
            break
        l = min(0.97, l + 0.02)
        rgb = colorsys.hls_to_rgb(h, l, s)
    return rgb


def convert(raw, role='ink'):
    """Map one colour. `role` is 'ink' (text, borders) or 'surface' (backgrounds).

    The distinction matters: a neutral ramp must INVERT for ink, so dark navy
    body text becomes light, but must NOT invert for surfaces, or the already
    dark masthead and active tabs flip to white. The CSS property name tells us
    which, so the caller passes it in.
    """
    r, g, b, alpha = parse(raw)
    h, l, s = colorsys.rgb_to_hls(r, g, b)

    deg_early = h * 360
    chroma = s * (1 - abs(2 * l - 1))
    # This design's ink is a dark navy, not a blue accent. Treat desaturated
    # colours, low-chroma colours, and dark slate-blues as structural neutrals,
    # or every heading and the masthead light up sky blue.
    neutral = (s < 0.18
               or chroma < 0.22
               or (l < 0.40 and 185 <= deg_early <= 265 and s < 0.80))

    if neutral:
        if role == 'surface':
            # Everything lands on the dark surface ramp. Light panels come down
            # to a card; already dark panels stay dark rather than inverting.
            if l >= 0.93:
                return emit(SURFACE, alpha)
            if l >= 0.70:
                return emit(RAISED, alpha)
            if l >= 0.45:
                return emit(LINE, alpha)
            if l >= 0.25:
                return emit(mix(BG, SURFACE, 0.55), alpha)
            return emit(mix(BG, SURFACE, 0.30), alpha)
        # Ink inverts: the darker it was, the brighter it becomes. Light ink
        # stays light -- it was already sitting on something dark, and every
        # surface is dark now anyway.
        if role == 'edge':
            # Borders and rules: one step off the surface, never text-bright.
            return emit(LINE if l < 0.97 else mix(SURFACE, LINE, 0.6), alpha)
        if l >= 0.93:
            return emit(TEXT, alpha)
        if l >= 0.62:
            return emit(DIM, alpha)
        if l >= 0.42:
            return emit(mix(DIM, TEXT, 0.25), alpha)
        return emit(TEXT, alpha)

    deg = h * 360
    # Semantic hues snap to the board palette so meaning stays consistent.
    if 95 <= deg <= 175:
        anchor = parse(GREEN if s > 0.45 else MINT)[:3]
    elif 20 <= deg < 95:
        anchor = parse(AMBER)[:3]
    elif deg < 20 or deg >= 330:
        anchor = parse(ROSE)[:3]
    elif 175 < deg < 260:
        anchor = parse(SKY)[:3]
    else:
        anchor = colorsys.hls_to_rgb(h, 0.68, min(0.75, s + 0.12))

    if role == 'surface':
        # A saturated fill: pale badge washes become dark tints; a strong
        # accent fill keeps its punch but is toned so text can sit on it.
        if l > 0.72:
            return emit(mix(SURFACE, anchor, 0.18), alpha)
        # A strong accent fill stays rich but dark enough for light text.
        return emit(mix(SURFACE, anchor, 0.45), alpha)

    if role == 'edge':
        return emit(mix(SURFACE, anchor, 0.55), alpha)
    # Saturated ink always ends up bright: every surface is dark now, so a pale
    # mint that used to sit on a dark hero must stay readable, not go dark too.
    return emit(lift(anchor), alpha)


# Properties whose colour paints a surface rather than ink.
SURFACE_PROPS = re.compile(
    r'^(background|background-color|background-image|box-shadow|'
    r'text-shadow|accent-color|--[\w-]*(bg|surface|paper|fill|wash|card)[\w-]*)$', re.I)
# Properties that draw a hairline, not text.
EDGE_PROPS = re.compile(
    r'^(border[\w-]*color|border|border-(top|right|bottom|left)|outline|'
    r'outline-color|column-rule|column-rule-color|caret-color|'
    r'--[\w-]*(line|border|edge|rule|divider)[\w-]*)$', re.I)
DECL = re.compile(r'(^|[;{])([\s]*)([-\w]+)(\s*:\s*)([^;{}]*)', re.M)


def recolor(css, seen, roles):
    """Recolour declaration by declaration so each value knows its property."""
    def one(match):
        lead, space, prop, sep, value = match.groups()
        name = prop.strip()
        if name.startswith('--'):
            # A custom property's declaration takes the role its uses imply.
            role = roles.get(name, 'ink')
        else:
            role = ('surface' if SURFACE_PROPS.match(name)
                    else 'edge' if EDGE_PROPS.match(name) else 'ink')
        key = lambda raw: (raw.lower(), role)
        value = HEX.sub(
            lambda m: seen.setdefault(key(m.group(0)), convert(m.group(1), role)), value)
        value = WORD.sub(
            lambda m: seen.setdefault(key(m.group(0)),
                                      convert(KEYWORDS[m.group(0).lower()], role)), value)
        return '%s%s%s%s%s' % (lead, space, prop, sep, value)
    return DECL.sub(one, css)


USE = re.compile(r'([-\w]+)\s*:\s*([^;{}]*var\(\s*(--[\w-]+)[^;{}]*)')


def custom_property_roles(sheets):
    """Decide each --custom-property's role by how the CSS actually uses it.

    A name is not enough: `--white` reads like ink but is used as a background,
    and mapping it as ink paints white cards white-on-white. So count the
    properties each var() feeds and let the majority decide.
    """
    tally = {}
    for css in sheets:
        for prop, _value, var in USE.findall(css):
            name = prop.strip()
            role = ('surface' if SURFACE_PROPS.match(name)
                    else 'edge' if EDGE_PROPS.match(name) else 'ink')
            counts = tally.setdefault(var, {'surface': 0, 'edge': 0, 'ink': 0})
            counts[role] += 1
    return {var: max(counts, key=counts.get) for var, counts in tally.items()}


def build():
    chunks, seen = [], {}
    sheets = []
    for name in SOURCES:
        path = os.path.join(SITE, name)
        if os.path.exists(path):
            with open(path, encoding='utf-8') as handle:
                sheets.append(handle.read())
    roles = custom_property_roles(sheets)
    for name in SOURCES:
        path = os.path.join(SITE, name)
        if not os.path.exists(path):
            continue
        with open(path, encoding='utf-8') as handle:
            css = handle.read()
        css = recolor(css, seen, roles)
        # The import lives in style.css and must not be duplicated here.
        css = re.sub(r'@import[^;]+;', '', css)
        chunks.append('/* %s */\n%s' % (name, css.strip()))

    header = (
        '/* night.css - generated by scripts/build_night_theme.py. Do not edit by hand.\n'
        '   Recolours the light stylesheets for the dark board. Loads last, so it\n'
        '   overrides them by source order at equal specificity. Layout untouched. */\n'
        'html{color-scheme:dark}\n'
        'body{background:%s;color:%s}\n'
        '::selection{background:%s;color:#06210f}\n'
        ':focus-visible{outline:2px solid %s;outline-offset:2px}\n'
        'select,input,textarea,button{color-scheme:dark;background:%s;color:%s;'
        'border-color:%s;font-family:inherit}\n'
        'select{appearance:none;-webkit-appearance:none;padding-right:30px;'
        'background-image:url("data:image/svg+xml,%%3Csvg xmlns=\'http://www.w3.org/2000/svg\' '
        'viewBox=\'0 0 24 24\' fill=\'none\' stroke=\'%%2394A3B4\' stroke-width=\'2.5\' '
        'stroke-linecap=\'round\'%%3E%%3Cpath d=\'M6 9l6 6 6-6\'/%%3E%%3C/svg%%3E");'
        'background-repeat:no-repeat;background-position:right 9px center;'
        'background-size:14px}\n'
        'option{background:%s;color:%s}\n'
        '::placeholder{color:%s;opacity:1}\n'
        'input[type=search]::-webkit-search-cancel-button{filter:invert(1) opacity(.5)}\n'
        'img,video{background:%s}\n'
    ) % (emit(BG), emit(TEXT), MINT, MINT,
         emit(RAISED), emit(TEXT), emit(LINE),
         emit(RAISED), emit(TEXT), emit(DIM), emit(RAISED))

    with open(OUT, 'w', encoding='utf-8') as handle:
        handle.write(header + '\n' + '\n\n'.join(chunks) + '\n')
    return len(seen)


if __name__ == '__main__':
    count = build()
    print('night.css written, %d distinct colours mapped' % count)
