import * as posix from 'node:path/posix';

/**
 * An in-memory stand-in for the slice of the `vscode` API the storage service
 * uses, substituted for the real module by esbuild at test build time.
 *
 * The point is to exercise the service itself — its queue, its signatures, its
 * refusal to write over data it could not read — rather than a copy of its
 * logic. Nothing here is imported by the extension.
 */

// --- Uri ---

export class Uri {
  private constructor(
    readonly scheme: string,
    readonly path: string,
  ) {}

  static file(path: string): Uri {
    return new Uri('file', path.startsWith('/') ? path : '/' + path);
  }

  static joinPath(base: Uri, ...segments: string[]): Uri {
    return new Uri(base.scheme, posix.join(base.path, ...segments));
  }

  with(change: { path?: string }): Uri {
    return new Uri(this.scheme, change.path ?? this.path);
  }

  get fsPath(): string {
    return this.path;
  }

  toString(): string {
    return `${this.scheme}://${this.path}`;
  }
}

export enum FileType {
  Unknown = 0,
  File = 1,
  Directory = 2,
  SymbolicLink = 64,
}

export interface FileStat {
  type: FileType;
  ctime: number;
  mtime: number;
  size: number;
}

export class Disposable {
  constructor(private readonly callback: () => void) {}
  dispose(): void {
    this.callback();
  }
}

export class RelativePattern {
  constructor(
    readonly base: Uri,
    readonly pattern: string,
  ) {}
}

// --- Errors ---

/** Carries a `code` the way VS Code's own filesystem errors do. */
export class FsError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

export function fileNotFound(path: string): FsError {
  return new FsError(`ENOENT: no such file or directory, '${path}'`, 'FileNotFound');
}

// --- Filesystem ---

interface Entry {
  type: FileType;
  content: Uint8Array;
  mtime: number;
}

type FailureHook = (operation: string, path: string) => Error | undefined;

export class MemoryFs {
  private readonly entries = new Map<string, Entry>();
  /** Advanced by hand so two writes never share an mtime by accident. */
  private clock = Date.now();
  /** Lets a test make any single operation fail the way a real disk would. */
  failure: FailureHook = () => undefined;

  private check(operation: string, uri: Uri): void {
    const error = this.failure(operation, uri.path);
    if (error) throw error;
  }

  private require(uri: Uri): Entry {
    const entry = this.entries.get(uri.path);
    if (!entry) throw fileNotFound(uri.path);
    return entry;
  }

  // --- Test-side helpers ---

  /** Writes without going through the failure hooks, to set a scenario up. */
  seed(path: string, content: string): void {
    this.mkdirp(posix.dirname(path));
    this.entries.set(path, {
      type: FileType.File,
      content: Buffer.from(content, 'utf-8'),
      mtime: (this.clock += 1000),
    });
  }

  read(path: string): string | undefined {
    const entry = this.entries.get(path);
    return entry && entry.type === FileType.File
      ? Buffer.from(entry.content).toString('utf-8')
      : undefined;
  }

  exists(path: string): boolean {
    return this.entries.has(path);
  }

  paths(): string[] {
    return [...this.entries.keys()].sort();
  }

  setMtime(path: string, mtime: number): void {
    const entry = this.entries.get(path);
    if (entry) entry.mtime = mtime;
  }

  clear(): void {
    this.entries.clear();
  }

  mkdirp(path: string): void {
    const parts = path.split('/').filter(Boolean);
    let current = '';
    for (const part of parts) {
      current += '/' + part;
      if (!this.entries.has(current)) {
        this.entries.set(current, {
          type: FileType.Directory,
          content: new Uint8Array(),
          mtime: 0,
        });
      }
    }
  }

  // --- The vscode.workspace.fs surface ---

  readonly api = {
    stat: async (uri: Uri): Promise<FileStat> => {
      this.check('stat', uri);
      const entry = this.require(uri);
      return { type: entry.type, ctime: 0, mtime: entry.mtime, size: entry.content.byteLength };
    },

    readFile: async (uri: Uri): Promise<Uint8Array> => {
      this.check('readFile', uri);
      const entry = this.require(uri);
      if (entry.type !== FileType.File)
        throw new FsError('EISDIR: is a directory', 'FileIsADirectory');
      return entry.content;
    },

    writeFile: async (uri: Uri, content: Uint8Array): Promise<void> => {
      this.check('writeFile', uri);
      this.mkdirp(posix.dirname(uri.path));
      this.entries.set(uri.path, {
        type: FileType.File,
        content: Uint8Array.from(content),
        mtime: (this.clock += 1000),
      });
    },

    rename: async (source: Uri, target: Uri): Promise<void> => {
      this.check('rename', source);
      const entry = this.require(source);
      this.entries.delete(source.path);
      this.entries.set(target.path, { ...entry, mtime: (this.clock += 1000) });
    },

    delete: async (uri: Uri): Promise<void> => {
      this.check('delete', uri);
      this.require(uri);
      this.entries.delete(uri.path);
    },

    createDirectory: async (uri: Uri): Promise<void> => {
      this.check('createDirectory', uri);
      this.mkdirp(uri.path);
    },

    readDirectory: async (uri: Uri): Promise<[string, FileType][]> => {
      this.check('readDirectory', uri);
      const prefix = uri.path.endsWith('/') ? uri.path : uri.path + '/';
      const children: [string, FileType][] = [];
      for (const [path, entry] of this.entries) {
        if (!path.startsWith(prefix)) continue;
        const name = path.slice(prefix.length);
        if (name.includes('/')) continue;
        children.push([name, entry.type]);
      }
      return children;
    },
  };
}

// --- Recorded UI ---

export interface Shown {
  kind: 'error' | 'warning' | 'info';
  message: string;
}

export const shown: Shown[] = [];

export const window = {
  showErrorMessage: (message: string): Thenable<undefined> => {
    shown.push({ kind: 'error', message });
    return Promise.resolve(undefined);
  },
  showWarningMessage: (message: string): Thenable<undefined> => {
    shown.push({ kind: 'warning', message });
    return Promise.resolve(undefined);
  },
  showInformationMessage: (message: string): Thenable<undefined> => {
    shown.push({ kind: 'info', message });
    return Promise.resolve(undefined);
  },
};

// --- Workspace ---

export const memfs = new MemoryFs();

export const state = {
  folders: [{ uri: Uri.file('/work/project'), name: 'project', index: 0 }] as
    | { uri: Uri; name: string; index: number }[]
    | undefined,
  config: new Map<string, unknown>(),
};

export const workspace = {
  fs: memfs.api,
  get workspaceFolders() {
    return state.folders;
  },
  getConfiguration: (section: string) => ({
    get: <T>(key: string, fallback?: T): T | undefined =>
      (state.config.get(`${section}.${key}`) as T | undefined) ?? fallback,
  }),
  createFileSystemWatcher: () => ({
    onDidCreate: () => new Disposable(() => undefined),
    onDidChange: () => new Disposable(() => undefined),
    onDidDelete: () => new Disposable(() => undefined),
    dispose: () => undefined,
  }),
};

export const l10n = {
  t: (message: string, ...args: unknown[]): string =>
    message.replace(/\{(\d+)\}/g, (whole, index: string) => {
      const value = args[Number(index)];
      return value === undefined ? whole : String(value);
    }),
};

export const commands = {
  executed: [] as { command: string; args: unknown[] }[],
  executeCommand: (command: string, ...args: unknown[]): Thenable<undefined> => {
    commands.executed.push({ command, args });
    return Promise.resolve(undefined);
  },
};

// --- Test lifecycle ---

/** A workspaceState/globalState pair backed by a plain map. */
export function memento() {
  const store = new Map<string, unknown>();
  return {
    get: <T>(key: string, fallback?: T): T | undefined =>
      store.has(key) ? (store.get(key) as T) : fallback,
    update: (key: string, value: unknown): Thenable<void> => {
      if (value === undefined) store.delete(key);
      else store.set(key, value);
      return Promise.resolve();
    },
    keys: () => [...store.keys()],
  };
}

export function fakeContext(storageUri: Uri | undefined = Uri.file('/work/storage')) {
  return { workspaceState: memento(), globalState: memento(), storageUri };
}

export function reset(): void {
  shown.length = 0;
  commands.executed.length = 0;
  state.config.clear();
  state.folders = [{ uri: Uri.file('/work/project'), name: 'project', index: 0 }];
  memfs.failure = () => undefined;
  // Emptied rather than replaced: the service holds a reference to `memfs.api`.
  memfs.clear();
}
