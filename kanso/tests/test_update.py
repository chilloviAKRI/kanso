"""Check that startup updates select and install only verified Kanso packages."""

from contextlib import nullcontext
import hashlib
from importlib.machinery import SourceFileLoader
from importlib.util import module_from_spec, spec_from_loader
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch


path = Path(__file__).resolve().parents[1] / "packaging/launch"
loader = SourceFileLoader("kanso_launch", str(path))
launcher = module_from_spec(spec_from_loader(loader.name, loader))
loader.exec_module(launcher)


def metadata(version, contents):
    return {
        "version": version,
        "sha256": hashlib.sha256(contents).hexdigest(),
        "size": len(contents),
    }


class ReleaseSelection(unittest.TestCase):
    def select(self, data, installed="160.0.1-9"):
        with patch.object(launcher, "curl", return_value=json.dumps(data).encode()):
            return launcher.latest_package(installed)

    def test_releases_use_arch_version_order(self):
        self.assertEqual(self.select(metadata("160.0.1-10", b"package"))[0], "160.0.1-10")
        self.assertIsNone(self.select(metadata("160.0.1-9", b"package")))
        self.assertIsNone(self.select(metadata("160.0.1-8", b"package")))

    def test_non_release_versions_are_rejected(self):
        with self.assertRaises(ValueError):
            self.select(metadata("160.0.1-10-beta", b"package"))

    def test_unverified_assets_are_rejected(self):
        for field, value in (("sha256", "bad"), ("size", 0), ("size", True)):
            with self.subTest(field=field):
                data = metadata("160.0.1-10", b"package")
                data[field] = value
                with self.assertRaises(ValueError):
                    self.select(data)


class UserUpdate(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.app = self.root / "kanso-browser"
        self.app.mkdir()
        (self.app / "release-version").write_text("160.0.1-9\n")
        self.profile = self.root / "profile"
        self.profile.write_text("saved profile")

        package = self.root / "package"
        replacement = package / "usr/lib/kanso-browser"
        (replacement / "browser").mkdir(parents=True)
        (replacement / "browser/omni.ja").touch()
        (replacement / "release-version").write_text("160.0.1-10\n")
        for name in ("launch", "kanso-browser"):
            file = replacement / name
            file.write_text("#!/bin/sh\nexit 0\n")
            file.chmod(0o755)
        (package / ".PKGINFO").write_text("pkgname = kanso-browser\npkgver = 160.0.1-10\narch = x86_64\n")
        archive = self.root / "test.pkg.tar.zst"
        launcher.run("bsdtar", "--zstd", "-cf", archive, "-C", package, ".PKGINFO", "usr")
        self.contents = archive.read_bytes()

    def apply(self, content):
        def download(url, *args):
            if url == launcher.LATEST_RELEASE:
                return json.dumps(metadata("160.0.1-10", self.contents)).encode()
            Path(args[args.index("--output") + 1]).write_bytes(content)
            return b""

        with patch.object(launcher, "curl", side_effect=download), patch.object(launcher, "notify"):
            launcher.update_user(self.app, launcher.latest_package("160.0.1-9"))

    def test_good_package_replaces_application_and_preserves_profile(self):
        self.apply(self.contents)
        self.assertEqual(launcher.version_in(self.app), "160.0.1-10")
        self.assertEqual(self.profile.read_text(), "saved profile")

    def test_corrupt_package_leaves_installed_version(self):
        with self.assertRaises(ValueError):
            self.apply(bytes([self.contents[0] ^ 1]) + self.contents[1:])
        self.assertEqual(launcher.version_in(self.app), "160.0.1-9")
        self.assertEqual(self.profile.read_text(), "saved profile")

    def test_open_browser_skips_update(self):
        browser = self.app / "kanso-browser"
        shutil.copy2("/usr/bin/sleep", browser)
        self.assertFalse(launcher.is_running(self.app))
        process = subprocess.Popen([browser, "30"])
        try:
            self.assertTrue(launcher.is_running(self.app))
            with patch.object(launcher, "curl") as fetch:
                self.assertIsNone(launcher.check_offer(self.app))
            fetch.assert_not_called()
        finally:
            process.terminate()
            process.wait(timeout=5)
        self.assertFalse(launcher.is_running(self.app))

    def test_offline_launch_uses_installed_browser(self):
        browser = self.app / "kanso-browser"
        browser.write_text('#!/bin/sh\ntest "$1" = https://example.com\n')
        browser.chmod(0o755)
        with (patch.object(launcher, "is_running", return_value=False),
              patch.object(launcher, "curl", side_effect=subprocess.TimeoutExpired("curl", 4)),
              patch.object(launcher, "tor_session", return_value=nullcontext(None)),
              patch.object(launcher, "SYSTEM_COMMAND", self.root / "no-system-install")):
            self.assertEqual(launcher.launch(self.app, ["https://example.com"]), 0)

    def test_launch_only_installs_after_browser_requests_restart(self):
        offer = {"installed": "160.0.1-9", "available": "160.0.1-10"}
        for exit_code in (0, launcher.UPDATE_EXIT_STATUS):
            with self.subTest(exit_code=exit_code):
                def simulate_install(_app):
                    (self.app / "release-version").write_text("160.0.1-10\n")

                with (patch.object(launcher, "check_offer", return_value=offer),
                      patch.object(launcher, "apply_offer", side_effect=simulate_install) as apply,
                      patch.object(launcher, "tor_session", return_value=nullcontext(None)),
                      patch.object(launcher, "SYSTEM_COMMAND", self.root / "no-system-install"),
                      patch.object(launcher, "subprocess") as processes):
                    processes.Popen.return_value.wait.side_effect = [exit_code, 0]
                    args = ["--profile", str(self.profile), "https://example.com"]
                    self.assertEqual(launcher.launch(self.app, args), 0)
                    first, *restarted = processes.Popen.call_args_list
                    self.assertEqual(json.loads(first.kwargs["env"][launcher.OFFER_ENV]), offer)
                    if exit_code == 0:
                        apply.assert_not_called()
                        self.assertFalse(restarted)
                    else:
                        apply.assert_called_once_with(self.app)
                        self.assertEqual(restarted[0].args[0][1:], args[:2])
                        self.assertNotIn(launcher.OFFER_ENV, restarted[0].kwargs["env"])
                        self.assertEqual(restarted[0].kwargs["env"]["MOZ_PURGE_CACHES"], "1")


if __name__ == "__main__":
    unittest.main()
