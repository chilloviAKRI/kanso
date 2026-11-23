#!/usr/bin/env python3
"""Exercise the packaged browser with an isolated profile and Omarchy state."""

import argparse
import base64
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import shutil
import socket
import struct
import subprocess
import tempfile
from threading import Event, Thread
from time import monotonic, sleep
import zlib
from xml.sax.saxutils import escape


def wait_for(check, description, timeout=10):
    deadline = monotonic() + timeout
    while monotonic() < deadline:
        if result := check():
            return result
        sleep(0.06)
    raise AssertionError(f"Timed out waiting for {description}")


class Marionette:
    def __init__(self, port):
        self.sock = socket.create_connection(("127.0.0.1", port), timeout=30)
        self.stream = self.sock.makefile("rb")
        self.serial = 0
        assert self.recv()["marionetteProtocol"] == 3
        self.send("WebDriver:NewSession")

    def recv(self):
        size = bytearray()
        while byte := self.stream.read(1):
            if byte == b":":
                return json.loads(self.stream.read(int(size)))
            size.extend(byte)
        raise RuntimeError("The browser closed its automation connection")

    def send(self, command, **parameters):
        self.serial += 1
        request = json.dumps([0, self.serial, command, parameters]).encode()
        self.sock.sendall(str(len(request)).encode() + b":" + request)
        kind, serial, error, result = self.recv()
        assert kind == 1 and serial == self.serial
        if error:
            raise RuntimeError(f"{command} failed: {error}")
        return result.get("value") if isinstance(result, dict) and "value" in result else result

    def close(self):
        self.stream.close()
        self.sock.close()

    def execute(self, script, *arguments, context="content", async_script=False):
        self.send("Marionette:SetContext", value=context)
        command = "WebDriver:ExecuteAsyncScript" if async_script else "WebDriver:ExecuteScript"
        return self.send(command, script=script, args=list(arguments), newSandbox=True)


def png(path, *colors):
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))

    width, height = 64, 64
    data = chunk(b"IHDR", struct.pack(">2I5B", width, height, 8, 2, 0, 0, 0))
    pixels = b"".join(bytes(colors[x * len(colors) // width]) for x in range(width))
    rows = (b"\0" + pixels) * height
    data += chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b"")
    path.write_bytes(b"\x89PNG\r\n\x1a\n" + data)


def set_theme(location, mode, background, foreground, accent):
    location.mkdir()
    (location / "colors.toml").write_text(
        f'mode = "{mode}"\nbackground = "{background}"\nforeground = "{foreground}"\naccent = "{accent}"\n'
    )


def set_wallpaper(location, image):
    staged = location.with_suffix(".next")
    staged.symlink_to(image)
    staged.replace(location)


def address(browser, url):
    browser.send("Marionette:SetContext", value="content")
    browser.send("WebDriver:Navigate", url=url)


def chrome(browser):
    return browser.execute("""
        const root = document.documentElement;
        return [root.getAttribute("theme-effective-id"),
          root.style.getPropertyValue("--kanso-accent"),
          Services.prefs.getIntPref("browser.theme.content-theme"),
          Services.appinfo.name,
          getComputedStyle(document.querySelector(".tab-background[selected]")).borderTopLeftRadius,
          getComputedStyle(document.querySelector("#urlbar > .urlbar-background")).borderTopLeftRadius];
    """, context="chrome")


def page(browser):
    return browser.execute(r"""
        const root = document.documentElement;
        return {title: document.title, omarchy: root.hasAttribute("omarchy"),
          mode: root.style.colorScheme, font: root.style.getPropertyValue("--kanso-font"),
          waveColors: root.style.getPropertyValue("--kanso-wallpaper-colors").trim().split(/\s+/).filter(Boolean),
          borderWidth: getComputedStyle(document.querySelector("main")).borderTopWidth,
          radius: getComputedStyle(document.querySelector("main")).borderTopLeftRadius};
    """)


def verify_selection_colors(browser):
    expected = ["rgb(0, 107, 230)", "rgb(255, 255, 255)"]
    toolbar = browser.execute("""
        const field = gURLBar.inputField;
        field.focus();
        const selection = getComputedStyle(field, "::selection");
        const colors = [selection.backgroundColor, selection.color];
        gBrowser.selectedBrowser.focus();
        return colors;
    """, context="chrome")
    assert toolbar == expected, toolbar

    content = browser.execute("""
        const sample = document.createElement("span");
        sample.style.backgroundColor = "Highlight";
        sample.style.color = "HighlightText";
        document.body.append(sample);
        const style = getComputedStyle(sample);
        const colors = [style.backgroundColor, style.color];
        sample.remove();
        return colors;
    """)
    assert content == expected, content


@contextmanager
def search_endpoint():
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            body = self.path.encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *_args):
            pass

    with ThreadingHTTPServer(("127.0.0.1", 0), Handler) as server:
        worker = Thread(target=server.serve_forever, daemon=True)
        worker.start()
        try:
            yield "http://127.0.0.1:" + str(server.server_port)
        finally:
            server.shutdown()
            worker.join()


def verify_search(browser):
    with search_endpoint() as url:
        result = browser.execute("""
            const [template, done] = arguments;
            const { SearchService } = ChromeUtils.importESModule(
              "moz-src:///toolkit/components/search/SearchService.sys.mjs");
            (async () => {
              const engine = await SearchService.addUserEngine({name: "Kanso Test", url: template});
              await SearchService.setDefault(engine, SearchService.CHANGE_REASON.USER);
              return (await SearchService.getDefault()).name;
            })().then(done, error => done(String(error)));
        """, url + "/find?q={searchTerms}", context="chrome", async_script=True)
        assert result == "Kanso Test", result
        address(browser, "about:newtab")
        field = browser.send("WebDriver:FindElement", using="css selector", value="#query")
        element_id = field["element-6066-11e4-a52e-4f735466cecf"]
        browser.send("WebDriver:ElementSendKeys", id=element_id, text="kanso test\ue007")
        wait_for(
            lambda: (browser.send("WebDriver:GetCurrentURL") or "").startswith(url + "/find?q="),
            "search navigation via the browser's selected engine",
        )
        assert browser.execute("return document.body.textContent").strip() in (
            "/find?q=kanso+test", "/find?q=kanso%20test"
        )


def select_font(path, family):
    if not family:
        return
    staged = path.with_suffix(".next")
    staged.write_text(f"""<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig>
  <include>/etc/fonts/fonts.conf</include>
  <match target="pattern">
    <test name="family" qual="any"><string>monospace</string></test>
    <edit name="family" mode="prepend_first" binding="strong">
      <string>{escape(family)}</string>
    </edit>
  </match>
</fontconfig>
""")
    staged.replace(path)


def verify_signed_extension(browser, xpi):
    result = browser.execute("""
        const [path, done] = arguments;
        const { AddonManager } = ChromeUtils.importESModule(
          "resource://gre/modules/AddonManager.sys.mjs");
        (async () => {
          const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
          file.initWithPath(path);
          const install = await AddonManager.getInstallForFile(file);
          if (install.addon.signedState < AddonManager.SIGNEDSTATE_SIGNED) {
            throw new Error("Firefox did not recognize the add-on signature");
          }
          await install.install();
          const addon = await AddonManager.getAddonByID(install.addon.id);
          return addon.isActive;
        })().then(done, error => done(String(error)));
    """, str(xpi.resolve()), context="chrome", async_script=True)
    assert result is True, result


SYNCED_THEME = "firefox-compact-light@mozilla.org"


def enable_synced_theme(browser):
    result = browser.execute("""
        const [id, done] = arguments;
        const { AddonManager } = ChromeUtils.importESModule(
          "resource://gre/modules/AddonManager.sys.mjs");
        (async () => {
          const theme = await AddonManager.getAddonByID(id);
          await theme.enable();
          return theme.isActive;
        })().then(done, error => done(String(error)));
    """, SYNCED_THEME, context="chrome", async_script=True)
    assert result is True, result

    def selected_theme():
        return browser.execute("""
            return Services.prefs.getStringPref("extensions.activeThemeID", "");
        """, context="chrome")

    wait_for(lambda: selected_theme() == SYNCED_THEME, "Firefox theme activation")


def verify_tab_chrome(browser, width):
    result = browser.execute("""
        const toolbox = document.getElementById("navigator-toolbox");
        const tabs = gBrowser.tabContainer;
        const measure = () => ["#TabsToolbar", ".tab-background[selected]", "#nav-bar"].map(selector => {
          const { y, height } = document.querySelector(selector).getBoundingClientRect();
          return [y, height];
        });
        const background = getComputedStyle(document.querySelector(".tab-background[selected]"));
        const outline = [background.outlineWidth, background.outlineOffset, background.boxShadow];
        const normal = measure();
        tabs.toggleAttribute("movingtab", true);
        toolbox.toggleAttribute("movingtab", true);
        const dragging = measure();
        tabs.toggleAttribute("movingtab", false);
        toolbox.toggleAttribute("movingtab", false);
        return { outline, normal, dragging };
    """, context="chrome")
    assert result["normal"] == result["dragging"], result
    assert result["outline"] == [f"{width}px", f"{-width}px", "none"], result


def verify(browser, current, first, second, video, font_config, fonts, compositor, args):
    address(browser, "about:newtab")
    assert browser.execute("""
        const form = document.getElementById("search");
        return form.elements.length === 1 && form.elements[0].type === "search"
          && !form.querySelector("kbd");
    """)
    target_id = "kanso-omarchy@local"
    original = wait_for(lambda: chrome(browser) if chrome(browser)[0] == target_id else None,
                        "Omarchy browser chrome")
    assert original[:3] == [target_id, "#7daea3", 0], original
    if not args.reference:
        assert original[3] == "Kanso", original
        verify_selection_colors(browser)

    initial = wait_for(lambda: page(browser)["waveColors"], "the first wallpaper palette")
    sampled = [bytes.fromhex(color[1:]) for color in initial]
    for expected in [(50, 90, 77), (128, 95, 158), (206, 150, 158)]:
        assert any(max(abs(a - b) for a, b in zip(color, expected)) <= 2
                   for color in sampled), initial
    density, tones, has_image = browser.execute("""
        const canvas = document.querySelector("canvas#waves");
        const data = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
        let painted = 0;
        const tones = new Set();
        for (let i = 0; i < data.length; i += 4) {
          if (data[i + 3]) {
            painted++;
            tones.add(data.slice(i, i + 3).join(","));
          }
        }
        return [painted * 4 / data.length, tones.size, !!document.querySelector("#wallpaper, img")];
    """)
    assert 0.07 < density < 0.32 and tones >= 6 and not has_image, (density, tones, has_image)
    sample_wave = 'return document.getElementById("waves").toDataURL();'
    first_frame = browser.execute(sample_wave)
    wait_for(lambda: browser.execute(sample_wave) != first_frame, "pixel wave motion", timeout=2)
    browser.execute('Services.prefs.setIntPref("ui.prefersReducedMotion", 1);', context="chrome")
    wait_for(lambda: browser.execute('return matchMedia("(prefers-reduced-motion: reduce)").matches'),
             "reduced motion preference")
    # A media query can match before Gecko dispatches its change event.
    browser.execute("""
        const done = arguments[0];
        requestAnimationFrame(() => requestAnimationFrame(() => done(true)));
    """, async_script=True)
    still_frame = browser.execute(sample_wave)
    sleep(0.20)
    assert browser.execute(sample_wave) == still_frame
    browser.execute('Services.prefs.setIntPref("ui.prefersReducedMotion", 0);', context="chrome")
    if fonts:
        wait_for(lambda: json.loads(page(browser)["font"] or "null") == fonts[0], "the initial Omarchy font")
    if args.screenshot:
        browser.send("Marionette:SetContext", value="content")
        args.screenshot.write_bytes(base64.b64decode(browser.send("WebDriver:TakeScreenshot")))

    first_window = browser.send("WebDriver:GetWindowHandle")
    browser.execute("OpenBrowserWindow();", context="chrome")
    other = wait_for(
        lambda: next((handle for handle in browser.send("WebDriver:GetWindowHandles")
                      if handle != first_window), None),
        "second browser window",
    )
    browser.send("WebDriver:SwitchToWindow", handle=other)
    address(browser, "about:newtab")
    wait_for(lambda: page(browser)["waveColors"], "wallpaper in the second window")
    enable_synced_theme(browser)
    # Firefox Sync uses the normal AddonManager activation path. Both chrome
    # and an already-open New Tab must keep the desktop appearance.
    for handle in (first_window, other):
        browser.send("WebDriver:SwitchToWindow", handle=handle)
        assert chrome(browser)[:3] == original[:3]
        assert page(browser)["waveColors"]
    if compositor:
        wait_for(lambda: page(browser)["borderWidth"] == "2px", "the initial Hyprland border")
    verify_tab_chrome(browser, 2 if compositor else 1)
    if compositor:
        assert chrome(browser)[4:] == ["0px", "0px"]
        compositor.radius = 9
        compositor.border = 3
        wait_for(
            lambda: chrome(browser)[4:] == ["9px", "9px"] and
            page(browser)["radius"] == "9px" and page(browser)["borderWidth"] == "3px",
            "Hyprland rounding and border in the new tab and browser chrome",
            timeout=3,
        )
        browser.send("WebDriver:SwitchToWindow", handle=first_window)
        assert chrome(browser)[4:] == ["9px", "9px"] and page(browser)["radius"] == "9px"
        verify_tab_chrome(browser, 3)
        compositor.radius = 0
        compositor.border = 0
        wait_for(
            lambda: chrome(browser)[4:] == ["0px", "0px"] and
            page(browser)["radius"] == "0px" and page(browser)["borderWidth"] == "0px",
            "switching Hyprland back to sharp corners and no border",
            timeout=3,
        )
        verify_tab_chrome(browser, 0)
        browser.send("WebDriver:SwitchToWindow", handle=other)

    theme = current / "theme"
    theme.rename(current / "theme.old")
    sleep(0.85)
    assert chrome(browser)[:3] == original[:3], "palette was lost during the theme swap"
    set_theme(current / "theme.next", "light", "#eff1f5", "#4c4f69", "#1e66f5")
    (current / "theme.next").rename(theme)
    set_wallpaper(current / "background", second)

    wait_for(lambda: chrome(browser)[:3] == [target_id, "#1e66f5", 1],
             "the light theme in the second window", timeout=2)
    assert browser.execute("return matchMedia('(prefers-color-scheme: light)').matches")
    browser.send("WebDriver:SwitchToWindow", handle=first_window)
    assert chrome(browser)[:3] == [target_id, "#1e66f5", 1]
    wait_for(lambda: page(browser)["mode"] == "light" and page(browser)["waveColors"] not in ([], initial),
             "the light theme and new wallpaper tone in the original tab", timeout=2)
    if not args.reference:
        verify_selection_colors(browser)
    browser.execute("""
        Services.prefs.setBoolPref("browser.kanso.follow-omarchy", false)
    """, context="chrome")
    wait_for(lambda: chrome(browser)[0] == SYNCED_THEME, "restoring the selected Firefox theme")
    wait_for(lambda: not page(browser)["omarchy"] and not page(browser)["waveColors"], "resetting New Tab")
    browser.execute("""
        Services.prefs.setBoolPref("browser.kanso.follow-omarchy", true)
    """, context="chrome")
    wait_for(lambda: chrome(browser)[0] == target_id, "re-enabling theme sync")

    shutil.rmtree(theme)
    set_theme(theme, "dark", "#182431", "#f0e9d4", "#75aacf")
    set_wallpaper(current / "background", first)
    wait_for(lambda: chrome(browser)[:3] == [target_id, "#75aacf", 0],
             "the custom theme", timeout=2)
    if len(fonts) > 1:
        select_font(font_config, fonts[1])
        wait_for(lambda: json.loads(page(browser)["font"] or "null") == fonts[1],
                 "the new Omarchy font", timeout=2)
    wait_for(lambda: page(browser)["waveColors"] == initial, "first wallpaper restored")
    set_wallpaper(current / "background", video)
    wait_for(lambda: page(browser)["waveColors"] not in ([], initial),
             "the palette of the video wallpaper", timeout=4)
    (current / "background").unlink()
    wait_for(lambda: not page(browser)["waveColors"], "theme color fallback after removing wallpaper")
    verify_search(browser)

    if not args.reference:
        address(browser, "about:preferences#appearance")
        find_checkbox = """
            function find(root) {
              const item = root.getElementById("kansoFollowOmarchy");
              if (item) {
                return item;
              }
              for (const node of root.querySelectorAll("*")) {
                const item = node.shadowRoot && find(node.shadowRoot);
                if (item) {
                  return item;
                }
              }
              return null;
            }
            const checkbox = find(document);
        """
        wait_for(
            lambda: browser.execute(find_checkbox + "return checkbox?.checked === true;"),
            "the Omarchy checkbox in Appearance",
        )
        browser.execute(find_checkbox + 'checkbox.shadowRoot.getElementById("input").click();')
        wait_for(lambda: chrome(browser)[0] == SYNCED_THEME, "restoring the selected theme in Settings")
        browser.execute(find_checkbox + 'checkbox.shadowRoot.getElementById("input").click();')
        wait_for(lambda: chrome(browser)[0] == target_id, "re-enabling theme sync in Settings")

    if args.signed_xpi:
        verify_signed_extension(browser, args.signed_xpi)


PROFILE_TEST_URL = "data:text/html,profile-check"


def save_profile_markers(browser):
    address(browser, PROFILE_TEST_URL)
    result = browser.execute("""
        const [url, done] = arguments;
        const { PlacesUtils } = ChromeUtils.importESModule(
          "resource://gre/modules/PlacesUtils.sys.mjs");
        (async () => {
          await PlacesUtils.bookmarks.insert({
            parentGuid: PlacesUtils.bookmarks.toolbarGuid,
            url,
            title: "Kanso profile check",
          });
          Services.prefs.setBoolPref("browser.sessionstore.resume_session_once", true);
          Services.prefs.savePrefFile(null);
        })().then(() => done(true), error => done(String(error)));
    """, PROFILE_TEST_URL, context="chrome", async_script=True)
    assert result is True, result


def profile_markers(browser):
    return browser.execute("""
        const [url, done] = arguments;
        const { PlacesUtils } = ChromeUtils.importESModule(
          "resource://gre/modules/PlacesUtils.sys.mjs");
        PlacesUtils.bookmarks.fetch({ url }).then(bookmark => {
          const windows = Services.wm.getEnumerator("navigator:browser");
          let tabRestored = false;
          for (const win of windows) {
            tabRestored ||= [...win.gBrowser.browsers].some(tab => tab.currentURI.spec === url);
          }
          done([Boolean(bookmark), tabRestored]);
        }, error => done(String(error)));
    """, PROFILE_TEST_URL, context="chrome", async_script=True)


@contextmanager
def running_browser(executable, profile, log_path, environment, restart=False):
    port_file = profile / "MarionetteActivePort"
    port_file.unlink(missing_ok=True)
    with log_path.open("wb") as log:
        process = subprocess.Popen([
            executable, "--headless", "--profile", profile, "--no-remote", "--marionette",
            "--remote-allow-system-access", *([] if restart else ["about:blank"]),
        ], env=environment, stdout=log, stderr=subprocess.STDOUT)
        browser = None
        try:
            wait_for(lambda: port_file.exists() and port_file.stat().st_size, "Marionette startup", timeout=55)
            port = int(port_file.read_text().splitlines()[0])
            browser = Marionette(port)
            yield browser
        except Exception:
            print(log_path.read_text(errors="replace"))
            raise
        finally:
            if browser:
                browser.close()
            if process.poll() is None:
                if not restart:
                    try:
                        process.wait(5)
                    except subprocess.TimeoutExpired:
                        pass
                if process.poll() is None:
                    process.terminate()
                    try:
                        process.wait(15)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait()


class HyprlandFixture:
    radius = 0
    border = 2

    def __init__(self, runtime):
        self.runtime = runtime
        self.signature = "kanso_smoke_123"
        self.directory = runtime / "hypr" / self.signature
        self.directory.mkdir(parents=True, mode=0o700)
        self.stop = Event()

    def __enter__(self):
        self.server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.server.bind(str(self.directory / ".socket.sock"))
        self.server.listen()
        self.server.settimeout(0.12)
        self.worker = Thread(target=self._respond, daemon=True)
        self.worker.start()
        return self

    def _respond(self):
        while not self.stop.is_set():
            try:
                connection, _ = self.server.accept()
            except TimeoutError:
                continue
            with connection:
                connection.settimeout(0.4)
                try:
                    request = connection.recv(128)
                    if (b"getoption decoration:rounding" in request and
                            b"getoption general:border_size" in request):
                        options = {"decoration:rounding": self.radius, "general:border_size": self.border}
                        response = "\n\n".join(json.dumps({"option": key, "int": value, "set": True})
                                               for key, value in options.items())
                        connection.sendall(response.encode())
                except OSError:
                    continue

    def __exit__(self, *_error):
        self.stop.set()
        self.worker.join()
        self.server.close()

    @property
    def environment(self):
        return {
            "XDG_RUNTIME_DIR": str(self.runtime),
            "HYPRLAND_INSTANCE_SIGNATURE": self.signature,
        }


@contextmanager
def compositor_fixture(runtime):
    if shutil.which("hyprctl"):
        with HyprlandFixture(runtime) as fixture:
            yield fixture
    else:
        yield None


def main():
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument("browser", type=Path)
    cli.add_argument("--reference", action="store_true", help="Check an instrumented upstream binary")
    cli.add_argument("--screenshot", type=Path)
    cli.add_argument("--signed-xpi", type=Path)
    args = cli.parse_args()
    executable = args.browser.resolve()
    if not executable.is_file():
        cli.error(f"Browser does not exist: {executable}")

    with tempfile.TemporaryDirectory(prefix="kanso-smoke-") as directory:
        root = Path(directory)
        current = root / "current"
        current.mkdir()
        set_theme(current / "theme", "dark", "#282828", "#d4be98", "#7daea3")
        first, second = root / "wallpaper-a.png", root / "wallpaper-b.png"
        png(first, (50, 90, 77), (128, 95, 158), (206, 150, 158))
        png(second, (107, 61, 112))
        set_wallpaper(current / "background", first)
        video = root / "video-wallpaper.mp4"
        subprocess.run([
            "/usr/bin/ffmpeg", "-nostdin", "-loglevel", "error", "-loop", "1",
            "-i", second, "-frames:v", "12", "-c:v", "libx264", "-pix_fmt", "yuv420p", video,
        ], check=True)
        font_config = root / "fonts.conf"
        matches = subprocess.check_output([
            "/usr/bin/fc-list", ":spacing=100", "-f", "%{family}\n",
        ], text=True)
        fonts = sorted({line.split(",")[0] for line in matches.splitlines() if line})[:2]
        if fonts:
            select_font(font_config, fonts[0])

        profile = root / "profile"
        profile.mkdir()
        (profile / "user.js").write_text('''
user_pref("marionette.port", 0);
user_pref("ui.prefersReducedMotion", 0);
user_pref("browser.aboutwelcome.enabled", false);
user_pref("browser.shell.checkDefaultBrowser", false);
user_pref("browser.startup.page", 0);
user_pref("datareporting.policy.dataSubmissionEnabled", false);
''')
        environment = {
            **os.environ,
            "KANSO_OMARCHY_CURRENT_DIR": str(current),
            "MOZ_REMOTE_ALLOW_SYSTEM_ACCESS": "1",
            **({"FONTCONFIG_FILE": str(font_config)} if fonts else {}),
        }
        with compositor_fixture(root / "runtime") as compositor:
            if compositor:
                environment.update(compositor.environment)
            with running_browser(executable, profile, root / "browser.log", environment) as browser:
                verify(browser, current, first, second, video, font_config, fonts, compositor, args)
                save_profile_markers(browser)
                browser.send("Marionette:Quit", flags=["eAttemptQuit"])
            with running_browser(executable, profile, root / "restart.log", environment, restart=True) as browser:
                wait_for(lambda: profile_markers(browser) == [True, True],
                         "the bookmark and open tab after restarting Kanso")
                stored_theme = browser.execute("""
                    return Services.prefs.getStringPref("extensions.activeThemeID", "");
                """, context="chrome")
                assert stored_theme == SYNCED_THEME
                wait_for(lambda: chrome(browser)[0] == "kanso-omarchy@local",
                         "Omarchy overriding the stored Firefox theme on startup")
    print("Kanso browser smoke test passed")


if __name__ == "__main__":
    main()
