import { URI } from 'vscode-uri';

/**
 * Enough of the VS Code API to run the parts of the extension that only touch files, outside VS Code.
 *
 * The viewer reads a dataset through `workspace.fs`, which is what lets it open a file on an SSH FS
 * mount as readily as one on the disk. That is exactly the path that was broken, and it is worth a
 * test that does not need an editor, an SSH server or a network - so here it is backed by a map.
 *
 * `Uri` is the real thing: vscode-uri is the package VS Code's own Uri comes from, so the path
 * arithmetic under test (a sibling file of `ssh://host/dir/file.seq`) behaves identically.
 */

export const Uri = URI;
export type Uri = URI;

export enum FileType {
    Unknown = 0,
    File = 1,
    Directory = 2,
    SymbolicLink = 64,
}

export class FileSystemError extends Error {
    static FileNotFound(uri?: URI): FileSystemError {
        return new FileSystemError('File not found: ' + (uri ? uri.toString() : ''));
    }
}

/** What a scheme other than `file:` is served from: a map of URI string to bytes. */
export class StubFileSystem {
    private readonly files = new Map<string, Uint8Array>();

    write(uri: URI, contents: Uint8Array | string): void {
        this.files.set(uri.toString(), typeof contents === 'string' ? Buffer.from(contents, 'utf8') : contents);
    }

    /** Set to have stat() throw, the way a file system that cannot stat a path does. */
    statFails = false;

    /** Set to have stat() report nothing useful, which some providers do. */
    statReportsNoSize = false;

    clear(): void {
        this.files.clear();
        this.statFails = false;
        this.statReportsNoSize = false;
    }

    async stat(uri: URI): Promise<{ type: FileType; size: number; ctime: number; mtime: number }> {
        if (this.statFails) throw new Error('stat is not supported here');

        const contents = this.files.get(uri.toString());
        if (!contents) throw FileSystemError.FileNotFound(uri);

        return {
            type: FileType.File,
            size: this.statReportsNoSize ? 0 : contents.length,
            ctime: 0,
            mtime: 0,
        };
    }

    async readFile(uri: URI): Promise<Uint8Array> {
        const contents = this.files.get(uri.toString());
        if (!contents) throw FileSystemError.FileNotFound(uri);
        return contents;
    }
}

export const stubFileSystem = new StubFileSystem();

/** Settings the code under test reads. Tests set what they need. */
export const stubConfiguration = new Map<string, unknown>();

export const workspace = {
    fs: {
        stat: (uri: URI) => stubFileSystem.stat(uri),
        readFile: (uri: URI) => stubFileSystem.readFile(uri),
    },

    getConfiguration(section: string) {
        return {
            get<T>(key: string, fallback?: T): T | undefined {
                const value = stubConfiguration.get(section + '.' + key);
                return (value as T) ?? fallback;
            },
        };
    },
};

/** Installs this module as `vscode` for everything required from here on. */
export function install(): void {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Module = require('module');
    const load = Module._load;

    Module._load = function (request: string, ...rest: unknown[]) {
        if (request === 'vscode') return module.exports;
        return load.call(this, request, ...rest);
    };
}
