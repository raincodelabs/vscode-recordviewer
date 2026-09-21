# Publishing this extension

Developer notes. Not part of the package - `.vscodeignore` keeps it out of the `.vsix`.

## Build and check

```bash
npm install
npm test          # the record layer, against crafted files: formats, code pages, search
npm run typecheck
npm run compile   # dist/extension.js, what the package ships
```

`test-integration/` is a separate suite that runs the viewer against a real SSH FS connection to a
container; it is not part of `npm test` and its README says how to stand the server up. Run it after
touching `src/dataSetFiles.ts`.

Run it from a second VS Code window with the extension loaded, and right-click a `.seq`, a `.dat`
or any other file to choose *Open as Mainframe Records*:

```bash
code --new-window --extensionDevelopmentPath=. <a folder holding datasets>
```

The repository ignores `**/.vscode/`, so the F5 launch configuration in `.vscode/launch.json` is local
to whoever writes it - hence the command line above, which needs nothing checked in.

## Package and publish

```bash
npx vsce package                       # raincode-record-viewer-<version>.vsix
npx vsce publish                       # needs a Personal Access Token for the raincode publisher
```

The token comes from the Azure DevOps organisation behind the `raincode` publisher, with the
**Marketplace: Manage** scope; `vsce login raincode` stores it. The publisher is the same one the
Raincode COBOL Debugger is published under, which lives in the raincode monorepo under
`dotnet/runtime/VSCodePlugin`.

## Before the first publication

- **The licence** is MIT (`LICENSE.txt`, declared as `"license": "MIT"`), which disclaims warranty and
  liability; the README says the rest out loud - as is, no support, used under the user's own
  responsibility. Worth a look from whoever owns that decision before the first publication, since it
  makes the source redistributable by anyone who gets the package.
- **The icon** is the Raincode square from the debugger extension. Fine for a Raincode publisher;
  check it is the mark that is meant to be used publicly.
- **The source lives in two places.** `origin` is the internal
  `owngit.corp.phidani.be:raincode/vscode-recordviewer`, and `github` is the public
  `github.com/raincodelabs/vscode-recordviewer`, which is the URL `package.json` names and the one
  the Marketplace shows. Push to both, or the public one goes stale:

  ```bash
  git push origin main && git push github main
  ```

  The `github` remote is the HTTPS URL on purpose. `git@github.com:raincodelabs/...` is refused for
  the SSH key this machine offers - it authenticates as a GitHub account that has no write access to
  the organisation - while the stored HTTPS credential does. Fix the SSH side if you prefer it; the
  push works either way.

  Nothing internal belongs in what goes out: no customer host names, paths or data. The tests use
  `ssh://mainframe-host/datasets/...`, which resolves to nothing anywhere.

## Code pages

`src/core/codepages.generated.ts` is generated from .NET's own tables:

```bash
pwsh -File tools/gen-codepages.ps1
```

Add the page to the list at the top of that script, run it, and commit both. The script fails rather
than emitting a table if a byte does not decode to exactly one character - the viewer's one-byte
one-column model depends on it.
