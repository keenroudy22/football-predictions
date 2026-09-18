import os
import re
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'scripts'))

import build_night_theme as night


class NightThemeTests(unittest.TestCase):
    def test_night_css_is_in_sync_with_the_light_stylesheets(self):
        """night.css is generated. Editing a light stylesheet without rerunning
        the generator leaves the dark theme stale, so the build fails instead.

        Fix by running: python scripts/build_night_theme.py
        """
        with open(night.OUT, encoding='utf-8') as handle:
            on_disk = handle.read()
        night.build()
        with open(night.OUT, encoding='utf-8') as handle:
            regenerated = handle.read()
        # Restore whatever was committed so the test never mutates the tree.
        with open(night.OUT, 'w', encoding='utf-8') as handle:
            handle.write(on_disk)
        self.assertEqual(on_disk, regenerated,
                         'night.css is stale. Run python scripts/build_night_theme.py')

    def test_index_loads_the_theme_last(self):
        with open(os.path.join(ROOT, 'site', 'index.html'), encoding='utf-8') as handle:
            html = handle.read()
        sheets = re.findall(r'<link rel="stylesheet" href="([\w.]+\.css)', html)
        self.assertIn('night.css', sheets, 'night.css is not linked')
        self.assertEqual(sheets[-1], 'night.css',
                         'night.css must load last to override the light sheets')

    def test_surfaces_stay_dark_and_ink_stays_light(self):
        # A dark navy masthead must not invert to white.
        self.assertLess(night.luminance(night.parse(night.convert('112638', 'surface'))[:3]), 0.08)
        # White card backgrounds come down to a dark surface.
        self.assertLess(night.luminance(night.parse(night.convert('ffffff', 'surface'))[:3]), 0.08)
        # Dark body ink inverts to readable light text.
        self.assertGreater(night.luminance(night.parse(night.convert('182942', 'ink'))[:3]), 0.5)
        # White text on a dark panel stays white.
        self.assertGreater(night.luminance(night.parse(night.convert('ffffff', 'ink'))[:3]), 0.5)

    def test_every_ink_colour_is_readable_on_the_page_background(self):
        """Any colour used as text must clear 4.5:1 against the page ground."""
        for sheet in night.SOURCES:
            path = os.path.join(night.SITE, sheet)
            if not os.path.exists(path):
                continue
            with open(path, encoding='utf-8') as handle:
                found = set(night.HEX.findall(handle.read()))
            for raw in found:
                if len(raw) in (4, 8):  # carries alpha; composite is not knowable here
                    continue
                mapped = night.parse(night.convert(raw, 'ink'))[:3]
                ratio = night.contrast(mapped, night.BG)
                self.assertGreaterEqual(
                    round(ratio, 2), 4.5,
                    '#%s maps to a text colour at %.2f:1 on the page background' % (raw, ratio))

    def test_semantic_hues_stay_distinguishable(self):
        green = night.parse(night.convert('176545', 'ink'))[:3]
        red = night.parse(night.convert('a62d39', 'ink'))[:3]
        amber = night.parse(night.convert('d5a043', 'ink'))[:3]
        for a, b, names in ((green, red, 'win/loss'), (green, amber, 'open/recheck'),
                            (red, amber, 'loss/recheck')):
            far = sum(abs(a[i] - b[i]) for i in range(3))
            self.assertGreater(far, 0.35, '%s colours are too close to tell apart' % names)


if __name__ == '__main__':
    unittest.main()
