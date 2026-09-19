"""Every script the hosted workflow runs must exist and load.

The first deploy of the rebuild failed because scripts/review.cjs still required two
front-end files the rebuild had deleted, and no test ran it. These checks read the
workflow itself, so a step can never point at a missing file or a broken import again.
"""
import importlib
import re
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
WORKFLOW = (ROOT / '.github' / 'workflows' / 'publish.yml').read_text(encoding='utf-8')


class WorkflowTests(unittest.TestCase):
    def test_every_python_step_exists_and_imports(self):
        scripts = re.findall(r'python scripts/(\w+)\.py', WORKFLOW)
        self.assertIn('build_site', scripts)
        for name in scripts:
            with self.subTest(script=name):
                self.assertTrue((ROOT / 'scripts' / f'{name}.py').is_file())
                importlib.import_module(name)

    def test_every_node_step_and_its_local_requires_exist(self):
        for name in re.findall(r'node (?:--check )?((?:scripts|site)/[\w./-]+\.c?js)', WORKFLOW):
            path = ROOT / name
            with self.subTest(script=name):
                self.assertTrue(path.is_file())
                for target in re.findall(r"require\(['\"](\.{1,2}/[^'\"]+)['\"]\)", path.read_text(encoding='utf-8')):
                    resolved = (path.parent / target).resolve()
                    self.assertTrue(resolved.is_file() or resolved.with_suffix('.js').is_file(), f'{name} requires {target}')

    def test_the_step_that_broke_the_first_deploy_is_gone(self):
        self.assertNotIn('review.cjs', WORKFLOW)


if __name__ == '__main__':
    unittest.main()
