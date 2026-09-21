# Reading a dataset that is not on a local disk

`npm test` at the root covers the record layer: formats, code pages, search, and the URI plumbing
against a stub file system. What it cannot cover is the half this project does not own - whether a
real file system extension answers `stat` and `readFile` the way the viewer expects.

So this suite runs the viewer, inside a real VS Code, against a real **SSH FS** connection to a real
SSH server. It is not part of `npm test`: it needs a container and a few minutes.

Run it after touching anything under `src/dataSetFiles.ts`, or before believing a bug report that
starts with "it does not work over SSH".

## The server

An SSH server in a container, holding the sample datasets. Nothing of yours is involved - not your
keys, not your `known_hosts`, not a customer's machine.

```bash
# A throwaway key for this container alone.
mkdir -p /tmp/rcsshtest && ssh-keygen -t ed25519 -f /tmp/rcsshtest/testkey -N "" -q

podman run -d --name rcsshtest -p 2222:2222 \
    -e PUBLIC_KEY="$(cat /tmp/rcsshtest/testkey.pub)" \
    -e USER_NAME=raincode -e SUDO_ACCESS=false \
    docker.io/linuxserver/openssh-server

# The datasets the suite expects, at /data on the server.
node ../tools/make-samples.js /tmp/rcsshtest/samples
podman cp /tmp/rcsshtest/samples rcsshtest:/data

# Prove the server is up before blaming the extension.
ssh -i /tmp/rcsshtest/testkey -p 2222 -o StrictHostKeyChecking=no \
    -o UserKnownHostsFile=/dev/null raincode@localhost ls -l /data
```

On Windows, `/tmp` is your Git Bash temp directory; the runner looks for the key at
`%TEMP%\rcsshtest\testkey` unless `RCSSH_KEY` says otherwise.

## The run

```bash
cd test-integration
npm install
npm run --prefix .. compile     # the suite reads the viewer's compiled out/
VSCODE_EXE="C:/Users/<you>/AppData/Local/Programs/Microsoft VS Code/Code.exe" npm test
```

`VSCODE_EXE` is optional: without it, a VS Code is downloaded (325 MB, once). With it, your installed
one is used - with its own user-data and extensions directories, so your profile is untouched. A
window opens while the tests run; it closes itself.

What passes when this works:

```
  stat -> {"type":1,"ctime":0,"mtime":1789995285,"size":40000}
    OK VS Code can stat it through the provider
  meta -> ssh://rcsshtest/data/PAYROLL.EMPLOYEE.meta
    OK the .meta beside it is found and read
    OK a .meta finds its data file
  record 1 -> "E00001DUPONT              LAGOS               "
  search TANAKA -> 50 records
    OK fixed records are read and decoded from EBCDIC
  record 1 -> "TXN00001 DUPONT AMOUNT=000991" (29 bytes)
    OK variable records are cut by their descriptor word
    OK a file over the limit is refused, by name and by setting
    OK the custom editor opens on it
```

## Afterwards

```bash
podman rm -f rcsshtest
```

## Two things this cost an afternoon, so they are written down

- **SSH FS ignores `root` in a workspace-level config**, at least in 1.27.0: `ssh://rcsshtest/data/x`
  reaches `/data/x` on the server, while a config with `"root": "/data"` and `ssh://rcsshtest/x` gives
  `EntryNotFound`. The suite therefore spells out the whole path.
- A path with spaces handed to `spawnSync(..., { shell: true })` needs its own quotes, or the VS Code
  CLI is never found and the suite fails saying SSH FS is not installed.
