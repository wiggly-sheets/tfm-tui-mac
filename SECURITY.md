# Security policy

## Supported versions

The latest tagged release and the `main` branch. Older releases do not get
backported fixes — upgrade with `install.sh` or rebuild from source.

## Reporting a vulnerability

Use GitHub's private vulnerability report:
<https://github.com/wiggly-sheets/tfm-tui-mac/security/advisories/new>.

Please do not open a public issue for anything exploitable. The report is
visible only to the maintainers until a fix is published. There is no security
email address; GitHub's form is the only channel.

## In scope

The tfm binary and the code in this repository:

- File operations: delete, trash, move, copy, rename, permission changes, and
  the undo history.
- Path handling: symlinks, archive extraction, path traversal, and shell
  arguments passed to external tools.
- Config and plugin loading, the embedded terminal, and the server/connection
  features.
- Release artifacts: the published binaries and their `.sha256` sidecars.

Out of scope: the terminal emulator, and any bug you can only trigger by
attacking your own machine with your own files.

## Plugins

Plugins are third-party code, not part of tfm. They run in the tfm process with
your user's permissions and no sandbox, so a plugin can do anything you can do.
Install plugins only from sources you trust, and report a plugin's problems to
its author.

## Installer

`install.sh` downloads the release binary, compares its SHA-256 against the
published sidecar, and refuses to install a release that does not publish one.
An existing checksum that does not match is a hard failure. `TFM_NO_VERIFY=1`
skips the check and should be treated as trusting the download blindly. The
bundled ffmpeg sidecar is verified the same way, but is optional: when its
checksum is missing or wrong, tfm installs without video thumbnails.

## Response expectations

Reports are read as quickly as a small spare-time project allows: usually
within a few days. A confirmed, exploitable bug gets a fix and a release before
the report becomes public. This is not a paid support channel, so no response
or fix deadline is promised.
