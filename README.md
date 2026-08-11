# pkgwarden companion

Keeps your VS Code extensions on versions that pkgwarden gate has cleared.

pkgwarden gate scans the extensions your organization uses and withholds versions it flags
as malicious or risky. This companion applies that policy inside the editor: it syncs your
organization's allowed versions once a day, checks any version you try to install before
installing it, and cleans up if something you already have installed gets withheld later.

## What it does

- **Sign in once.** Paste a gate token and the companion authenticates against your
  organization's gate instance. The token is stored only in the editor's SecretStorage, and
  is never written to a settings file or the log.
- **Syncs once a day.** In the background it sends the list of extensions you have installed
  (including disabled ones) to gate, then writes the versions gate clears into your user
  `extensions.allowed` setting. The status bar shows how many extensions are pinned and when
  the last sync succeeded. "Sync policy now" asks for a fresh sync without waiting for the
  next daily run.
- **Checks before installing.** The "Install extension…" command opens a quick pick over the
  gate catalog and asks gate about the exact version first. A withheld version is refused
  outright; a version that is only awaiting a scan can still be installed, but only after you
  confirm an explicit warning.
- **Handles versions withheld after the fact.** When a sync reports that a version you
  already have installed has been withheld, `pkgwarden.remediation` decides what happens
  (see below). The companion never rolls back or removes itself.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `pkgwarden.apiUrl` | `https://index.pkgwarden.com` | Base URL of the pkgwarden gate API. |
| `pkgwarden.remediation` | `auto` | `auto` installs the fallback version gate names, or uninstalls the extension when gate names none (or the fallback fails to install), then tells you what it did. `notify` only warns you, with a "Remove now" button that does nothing unless you click it. |

## Commands

- **pkgwarden: Install extension…** installs from the gate-checked catalog.
- **pkgwarden: Sign in with a gate token** authenticates against your gate instance.
- **pkgwarden: Sign out** removes the stored token and stops syncing.
- **pkgwarden: Sync policy now** pulls the latest allowed versions immediately.

## Getting a gate token

Ask your organization's pkgwarden admin for a gate token, or generate one yourself if you
run gate. Docs and token management live at
[gate.pkgwarden.com](https://gate.pkgwarden.com).

## Zero runtime dependencies

The companion ships with no third-party runtime dependencies; everything it needs is the
`vscode` extension API.
