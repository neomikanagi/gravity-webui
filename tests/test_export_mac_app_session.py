"""Offline tests: synthetic App container only; no SSH, login or network."""
import importlib.util
import json
import plistlib
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/export_mac_app_session.py'
spec = importlib.util.spec_from_file_location('export_mac_app_session', SCRIPT)
export = importlib.util.module_from_spec(spec)
spec.loader.exec_module(export)


class ExportTests(unittest.TestCase):
    def make_container(self, root, name='synthetic-container'):
        data = root / name / 'Data'
        user = data / 'Documents/userInfo/user.json'
        user.parent.mkdir(parents=True)
        user.write_bytes(plistlib.dumps({'token': 'synthetic%2Btoken%3D', 'app_version': '14.2'}))
        prefs = data / 'Library/Preferences/com.hiclub.gravity.plist'
        prefs.parent.mkdir(parents=True)
        prefs.write_bytes(plistlib.dumps({}))
        return user

    def test_detects_real_data_layout(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            user = self.make_container(root)
            self.assertEqual(export.find_user_json(root), user)
            session = export.read_session(user)
            self.assertEqual(session['token'], 'synthetic%2Btoken%3D')
            self.assertEqual(session['source'], 'macos-app')

    def test_ambiguous_containers_are_not_guessed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.make_container(root, 'a')
            self.make_container(root, 'b')
            with self.assertRaisesRegex(ValueError, 'app_container_ambiguous'):
                export.find_user_json(root)

    def test_no_token_fails_without_writing(self):
        with tempfile.TemporaryDirectory() as directory:
            user = self.make_container(Path(directory))
            user.write_bytes(plistlib.dumps({'token': ''}))
            with self.assertRaisesRegex(ValueError, 'app_token_missing'):
                export.read_session(user)

    def test_owner_identity_is_exact_and_never_required_for_listening(self):
        with tempfile.TemporaryDirectory() as directory:
            user = self.make_container(Path(directory))
            user.write_bytes(plistlib.dumps({'token': 'synthetic%2Btoken%3D', 'user_id': 123456}))
            self.assertEqual(export.read_session(user)['user_id'], '123456')
            for bad in [None, 0, '01', 'bad', '１２３']:
                user.write_bytes(plistlib.dumps({'token': 'synthetic%2Btoken%3D', **({} if bad is None else {'user_id': bad})}))
                self.assertIsNone(export.read_session(user)['user_id'])

    def test_atomic_output_is_private_and_preserves_app_file(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            user = self.make_container(root)
            before = user.read_bytes()
            out = root / '.session/www-token.json'
            export.write_private(out, export.read_session(user))
            self.assertEqual(out.stat().st_mode & 0o777, 0o600)
            self.assertEqual(out.parent.stat().st_mode & 0o777, 0o700)
            self.assertEqual(json.loads(out.read_text())['token'], 'synthetic%2Btoken%3D')
            self.assertEqual(user.read_bytes(), before)
            self.assertEqual(list(out.parent.iterdir()), [out])


if __name__ == '__main__':
    unittest.main()
