"""Check the reviewed pin and native integration without substituting app tests."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

from run import checked_runner

DIRECTORY = Path(__file__).resolve().parent
ROOT = DIRECTORY.parent.parent


class ContractTests(unittest.TestCase):
    def test_reviewed_runner_bytes(self):
        self.assertEqual(checked_runner(DIRECTORY), DIRECTORY / 'vendor/verify.py')

    def test_modified_runner_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'vendor').mkdir()
            (root / 'upstream.json').write_bytes((DIRECTORY / 'upstream.json').read_bytes())
            (root / 'vendor/verify.py').write_text('raise SystemExit(0)')
            with self.assertRaises(ValueError):
                checked_runner(root)

    def test_map_preserves_native_checks_and_rehearsal_gap(self):
        data = json.loads((ROOT / 'verification.json').read_text())
        checks = data['checks']
        self.assertEqual(checks['native-gates']['argv'], ['make', 'before-commit'])
        self.assertEqual(checks['host-types']['argv'], ['bun', 'run', 'typecheck:host'])
        self.assertEqual(checks['host-tests']['argv'], ['bun', 'run', 'test:host'])
        self.assertIn('event-rehearsal', data['profiles']['release'])
        self.assertTrue(checks['event-rehearsal']['blocked_reason'])
        self.assertNotIn('event-rehearsal', data['profiles']['fast'])
        spec = importlib.util.spec_from_file_location('verifier', checked_runner(DIRECTORY))
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        for profile in ('fast', 'release'):
            module.load_map(ROOT / 'verification.json', profile)

    def test_pin_names_immutable_source(self):
        pin = json.loads((DIRECTORY / 'upstream.json').read_text())
        self.assertEqual(pin['commit'], 'b434822e6bd2e80480dc8af610ad3f2a234a35e0')
        self.assertEqual(pin['license'], 'MIT')
        self.assertTrue((DIRECTORY / 'vendor/LICENSE').is_file())


if __name__ == '__main__':
    unittest.main()
