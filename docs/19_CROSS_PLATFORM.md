# 19 · Cross-platform support

**Code inspected 18 Oct 2026.** This page summarizes current implementation/build coverage; it is not a claim that the documentation audit launched every released installer. The original September Linux-only investigation is no longer a current support matrix.

| Area | macOS | Windows | Linux |
| --- | --- | --- | --- |
| Web UI | Browser | Browser | Browser |
| Desktop build | Apple silicon and Intel | x64 | x64 |
| CLI package | arm64 and x64 | x64 | arm64 and x64 |
| Local database | PGlite | PGlite | PGlite |
| OS sandbox | Seatbelt | Separate-account sandbox runtime after setup | bubblewrap, else supported Landlock |
| File/folder UI | Native Tauri dialog | Native Tauri dialog | Native Tauri dialog |
| Notifications | System permission, running app | System permission, running app | Desktop notification environment/permission, running app |
| Runtime discovery | Shared local API/lock | Shared local API/lock | Shared local API/lock |

## Runtime and packaging

Desktop loads the static Hub and starts/attaches to a local Node API; CLI uses that same runtime without a window. No packaged Docker or Python model process is required. Native plot export and external coding agents depend on the person's installed tools. GUI startup imports supported login-shell/install PATH entries (`desktop/user-path.ts`).

`release.json`, `scripts/desktop-targets.mjs`, `desktop-release.mjs`, `package-cli.mjs` and the workflows define versions/targets/assets. [DESKTOP](DESKTOP.md) and [CLI](26_CLI.md) document actual formats and commands. Installer availability is a release artifact fact, not a permanent claim based on a build matrix.

Updater signing is implemented; Apple/Windows OS signing and notarization are separate and currently unconfigured. A signed updater package does not remove first-install OS warnings. Native mobile apps, Mac App Store and Flatpak distribution are not shipped targets.

## Backend differences

[24](24_DESKTOP_SANDBOXING.md) owns the detailed sandbox matrix. Windows needs one-time elevated setup and local-drive work folders. Linux capability depends on namespaces/kernel/backend; Landlock does not hide Unix sockets and needs supported TCP rules for network-off. A missing backend is reported explicitly. Path/argv checks are not a replacement for OS confinement.

The human terminal uses passkey unlock and its own allowed commands/folders. Hosted public users reach it through a paired computer rather than the server's filesystem. Browser passkeys depend on the configured origin and OS/browser support; generic IP-address aliases are not interchangeable relying parties.

## Verification

CI includes live sandbox paths on macOS, Windows and two Linux configurations, plus API/Python/web/shared/CLI tests and production builds. Packaged runtime smoke tests and the [Mac hand checklist](desktop/MAC_CHECKLIST.md) cover additional paths. A build/test on one architecture does not substitute for physical-device installation, sleep/wake, notification, credential-manager or vendor-CLI checks on another.

Use current CI/release evidence for the commit being shipped. This page deliberately contains no old pass/fail counts, provisional support roadmap or claims that Windows/Linux confinement is still unbuilt.
