import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { FsError, fakeContext, memfs, reset, shown, state, Uri } from './helpers/vscodeStub';
import * as storage from '../src/services/storageService';
import { categoryNameMatches, matchesFilter, parseFilter } from '../src/models/filter';
import {
  compareByDueDate,
  createTodo,
  duplicateTodo,
  isOverdue,
  isValidDueDate,
  normalizeTags,
  readTags,
  todayLocal,
} from '../src/models/todo';

/**
 * Exercises the storage service against an in-memory filesystem.
 *
 * These cover the failure paths that turn into data loss, which is where the
 * interesting behaviour lives: what the service does when the file is corrupt,
 * missing, locked, or edited underneath it.
 */

const FILE = '/work/storage/toudou-project.json';

interface Ctx {
  workspaceState: {
    get: <T>(k: string, f?: T) => T | undefined;
    update: (k: string, v: unknown) => Thenable<void>;
  };
  globalState: unknown;
  storageUri: Uri | undefined;
}

let context: Ctx;
let changes: number;

async function init(): Promise<void> {
  changes = 0;
  await storage.initStorage(context as never, () => {
    changes++;
  });
}

/** The file as the extension would write it. */
function fileOf(todos: { id: string; title: string; order: number }[], extra = {}): string {
  return JSON.stringify({ categories: [], todos, history: [], ...extra }, null, 2);
}

function todo(id: string, title: string, order = 0) {
  return { id, title, order, createdAt: '2026-07-28T00:00:00.000Z' };
}

function storedTodos(): { id: string; title: string }[] {
  const raw = memfs.read(FILE);
  return raw ? (JSON.parse(raw) as { todos: { id: string; title: string }[] }).todos : [];
}

beforeEach(() => {
  reset();
  context = fakeContext() as unknown as Ctx;
});

describe('a file that cannot be read', () => {
  it('refuses to write over invalid JSON', async () => {
    memfs.seed(FILE, '{"todos": [{"id": "a", "title": "real work", "order": 0}');
    await init();

    assert.equal(storage.getTodos().length, 0, 'nothing could be parsed');
    assert.match(shown.at(-1)!.message, /not valid JSON/);

    await storage.addTodo(todo('new', 'added blind') as never);

    assert.equal(
      memfs.read(FILE),
      '{"todos": [{"id": "a", "title": "real work", "order": 0}',
      'the truncated file is left exactly as it was',
    );
    assert.match(shown.at(-1)!.message, /change not saved/);
  });

  it('refuses to write when the read itself fails', async () => {
    memfs.seed(FILE, fileOf([todo('a', 'real work')]));
    memfs.failure = (op) =>
      op === 'readFile' ? new FsError('EBUSY: resource busy', 'EBUSY') : undefined;
    await init();

    const before = memfs.read(FILE);
    await storage.addTodo(todo('new', 'added blind') as never);

    assert.equal(memfs.read(FILE), before);
    assert.match(shown.at(-1)!.message, /change not saved/);
  });

  it('raises the alarm once, not once per item of a batch', async () => {
    memfs.seed(FILE, 'not json at all');
    await init();
    shown.length = 0;

    await storage.addTodo(todo('a', 'one') as never);
    await storage.addTodo(todo('b', 'two') as never);
    await storage.addTodo(todo('c', 'three') as never);

    assert.equal(shown.filter((s) => /change not saved/.test(s.message)).length, 1);
  });

  it('resumes writing once the file parses again', async () => {
    memfs.seed(FILE, 'not json at all');
    await init();

    memfs.seed(FILE, fileOf([todo('a', 'recovered')]));
    assert.equal(await storage.reloadStorage(), true);

    await storage.addTodo(todo('b', 'written after recovery') as never);
    assert.deepEqual(
      storedTodos().map((t) => t.title),
      ['recovered', 'written after recovery'],
    );
  });
});

describe('creating the file on demand', () => {
  /** A window with no folder open: nothing triggers a write on its own. */
  const UNNAMED = '/work/storage/toudou-default.json';

  it('writes an empty file when there is none yet', async () => {
    state.folders = undefined;
    await init();
    assert.equal(memfs.exists(UNNAMED), false, 'nothing is written before it is asked for');

    assert.equal(await storage.ensureStorageFile(), true);

    assert.deepEqual(JSON.parse(memfs.read(UNNAMED)!).todos, []);
  });

  it('recreates a file that vanished, from what is in memory', async () => {
    memfs.seed(FILE, fileOf([todo('a', 'still here')]));
    await init();

    memfs.clear();
    await storage.checkForExternalChanges();
    assert.equal(await storage.ensureStorageFile(), true);

    assert.deepEqual(
      storedTodos().map((t) => t.title),
      ['still here'],
    );
  });

  it('leaves an existing file untouched', async () => {
    memfs.seed(FILE, fileOf([todo('a', 'already there')]));
    await init();

    assert.equal(await storage.ensureStorageFile(), false);

    assert.deepEqual(
      storedTodos().map((t) => t.title),
      ['already there'],
    );
  });

  it('does not overwrite a file it failed to read', async () => {
    memfs.seed(FILE, 'not json at all');
    await init();

    assert.equal(await storage.ensureStorageFile(), false);

    assert.equal(memfs.read(FILE), 'not json at all');
  });
});

describe('a file that disappears', () => {
  it('keeps the todos in memory instead of blanking the view', async () => {
    memfs.seed(FILE, fileOf([todo('a', 'still here')]));
    await init();
    assert.equal(storage.getTodos().length, 1);

    memfs.clear(); // unmounted drive, sync client renaming the file away
    await storage.checkForExternalChanges();

    assert.equal(storage.getTodos().length, 1, 'the list survives the file');
  });

  it('recreates the file from memory on the next write', async () => {
    memfs.seed(FILE, fileOf([todo('a', 'still here')]));
    await init();

    memfs.clear();
    await storage.checkForExternalChanges();
    await storage.addTodo(todo('b', 'added while gone') as never);

    assert.deepEqual(
      storedTodos().map((t) => t.title),
      ['still here', 'added while gone'],
      'the restored file holds everything, not just the new todo',
    );
  });
});

describe('a file shared with another client', () => {
  it('keeps top-level keys it does not understand', async () => {
    memfs.seed(FILE, fileOf([todo('a', 'ours')], { vault: 'notes', schemaVersion: 4 }));
    await init();

    await storage.addTodo(todo('b', 'added here') as never);

    const written = JSON.parse(memfs.read(FILE)!) as Record<string, unknown>;
    assert.equal(written.vault, 'notes');
    assert.equal(written.schemaVersion, 4);
  });

  it('keeps entries it cannot validate', async () => {
    const foreign = { id: 'x', title: 'from elsewhere', due: '2026-08-01' };
    memfs.seed(
      FILE,
      JSON.stringify({ categories: [], todos: [todo('a', 'ours'), foreign], history: [] }),
    );
    await init();

    assert.equal(storage.getTodos().length, 1, 'only the valid one reaches the view');
    await storage.addTodo(todo('b', 'added here') as never);

    const written = JSON.parse(memfs.read(FILE)!) as { todos: unknown[] };
    assert.deepEqual(written.todos.at(-1), foreign, 'the foreign entry survives our write');
  });

  it('keeps foreign fields through completion and restoration', async () => {
    const tagged = { ...todo('a', 'ours'), tags: ['call'], dueDate: '2026-08-01' };
    memfs.seed(FILE, fileOf([tagged]));
    await init();

    await storage.completeTodoById('a');
    const done = (JSON.parse(memfs.read(FILE)!) as { history: Record<string, unknown>[] })
      .history[0];
    assert.deepEqual(done.tags, ['call']);
    assert.equal(done.dueDate, '2026-08-01');
    assert.equal('order' in done, false, 'a finished todo has no place in the list');

    await storage.restoreFromHistory('a');
    const back = (JSON.parse(memfs.read(FILE)!) as { todos: Record<string, unknown>[] }).todos[0];
    assert.deepEqual(back.tags, ['call']);
    assert.equal(back.dueDate, '2026-08-01');
    assert.equal('completedAt' in back, false);
  });

  it('applies a mutation on top of an edit made underneath it', async () => {
    memfs.seed(FILE, fileOf([todo('a', 'ours')]));
    await init();

    // Another window adds a todo without us noticing.
    memfs.seed(FILE, fileOf([todo('a', 'ours'), todo('b', 'theirs', 1)]));

    await storage.addTodo(todo('c', 'ours too', 2) as never);

    assert.deepEqual(
      storedTodos().map((t) => t.title),
      ['ours', 'theirs', 'ours too'],
      'their todo is not clobbered',
    );
  });

  it('refreshes the views when a mutation turns out to change nothing', async () => {
    memfs.seed(FILE, fileOf([todo('a', 'ours')]));
    await init();

    memfs.seed(FILE, fileOf([todo('a', 'ours'), todo('b', 'theirs', 1)]));

    const before = changes;
    // Nothing to delete: the callback must still fire, because the re-read
    // above consumed the external change and the poll will not report it.
    await storage.deleteTodo('does-not-exist');

    assert.ok(changes > before, 'the external change reached the views');
    assert.equal(storage.getTodos().length, 2);
  });
});

describe('writing', () => {
  it('goes through a temporary file and leaves none behind', async () => {
    memfs.seed(FILE, fileOf([]));
    await init();

    await storage.addTodo(todo('a', 'one') as never);

    assert.deepEqual(
      memfs.paths().filter((p) => p.endsWith('.tmp')),
      [],
    );
    assert.equal(storedTodos().length, 1);
  });

  it('falls back to a direct write when the rename is blocked', async () => {
    memfs.seed(FILE, fileOf([]));
    await init();
    memfs.failure = (op) =>
      op === 'rename' ? new FsError('EPERM: operation not permitted', 'EPERM') : undefined;

    await storage.addTodo(todo('a', 'saved anyway') as never);

    assert.deepEqual(
      storedTodos().map((t) => t.title),
      ['saved anyway'],
      'losing the change would be worse than losing atomicity',
    );
    assert.deepEqual(
      memfs.paths().filter((p) => p.endsWith('.tmp')),
      [],
      'the temp file is cleaned up',
    );
  });

  it('reports a write that fails for any other reason', async () => {
    memfs.seed(FILE, fileOf([]));
    await init();
    memfs.failure = (op) =>
      op === 'writeFile' ? new FsError('ENOSPC: no space left on device', 'ENOSPC') : undefined;

    await storage.addTodo(todo('a', 'never lands') as never);

    assert.equal(storedTodos().length, 0);
    assert.match(shown.at(-1)!.message, /could not save/);
    assert.match(shown.at(-1)!.message, /ENOSPC/, 'the errno tells a disk problem from a bug');
  });

  it('sweeps a temporary file left by a window that died mid-write', async () => {
    memfs.seed(FILE, fileOf([]));
    const stale = '/work/storage/.toudou-project.json.999.tmp';
    memfs.seed(stale, '{}');
    memfs.setMtime(stale, Date.now() - 10 * 60_000);

    await init();

    assert.equal(memfs.exists(stale), false);
  });

  it('spares a temporary file another window may still be renaming', async () => {
    memfs.seed(FILE, fileOf([]));
    const fresh = '/work/storage/.toudou-project.json.999.tmp';
    memfs.seed(fresh, '{}');
    memfs.setMtime(fresh, Date.now());

    await init();

    assert.equal(memfs.exists(fresh), true);
  });
});

describe('serialization', () => {
  it('does not let concurrent mutations drop one another', async () => {
    memfs.seed(FILE, fileOf([]));
    await init();

    await Promise.all([
      storage.addTodo(todo('a', 'one') as never),
      storage.addTodo(todo('b', 'two') as never),
      storage.addTodo(todo('c', 'three') as never),
    ]);

    assert.deepEqual(
      storedTodos()
        .map((t) => t.title)
        .sort(),
      ['one', 'three', 'two'],
    );
  });

  it('gives every todo of a category a distinct order', async () => {
    memfs.seed(FILE, fileOf([]));
    await init();

    await Promise.all([
      storage.addTodo(todo('a', 'one') as never),
      storage.addTodo(todo('b', 'two') as never),
      storage.addTodo(todo('c', 'three') as never),
    ]);

    const orders = storage.getTodos().map((t) => t.order);
    assert.equal(new Set(orders).size, orders.length);
  });
});

describe('undo', () => {
  it('restores the previous state on disk', async () => {
    memfs.seed(FILE, fileOf([todo('a', 'first')]));
    await init();

    await storage.addTodo(todo('b', 'second') as never);
    assert.equal(storedTodos().length, 2);

    assert.equal(await storage.undo(), true);
    assert.deepEqual(
      storedTodos().map((t) => t.title),
      ['first'],
    );

    assert.equal(await storage.redo(), true);
    assert.equal(storedTodos().length, 2);
  });

  it('reports nothing to undo rather than throwing', async () => {
    memfs.seed(FILE, fileOf([]));
    await init();
    assert.equal(await storage.undo(), false);
    assert.equal(await storage.redo(), false);
  });

  it('drops snapshots that describe a state the file no longer has', async () => {
    memfs.seed(FILE, fileOf([todo('a', 'first')]));
    await init();
    await storage.addTodo(todo('b', 'second') as never);

    // An edit from elsewhere: undoing to our snapshot would silently revert it.
    memfs.seed(FILE, fileOf([todo('a', 'first'), todo('z', 'theirs', 5)]));
    await storage.checkForExternalChanges();

    assert.equal(await storage.undo(), false);
    assert.deepEqual(
      storedTodos().map((t) => t.title),
      ['first', 'theirs'],
    );
  });
});

describe('storage path resolution', () => {
  it('keeps a relative path inside the workspace', async () => {
    state.config.set('toudou.defaultStoragePath', '.vscode/todos.json');
    await init();
    assert.equal(storage.getStorageFileUri()?.path, '/work/project/.vscode/todos.json');
  });

  it('refuses a relative path that climbs out of the workspace', async () => {
    state.config.set('toudou.defaultStoragePath', '../../etc/todos.json');
    await init();
    assert.equal(storage.getStorageFileUri(), undefined);
    assert.match(shown.at(-1)!.message, /outside the workspace/);
  });

  it('substitutes the workspace name', async () => {
    state.config.set('toudou.defaultStoragePath', '.vscode/toudou-{workspace}.json');
    await init();
    assert.equal(storage.getStorageFileUri()?.path, '/work/project/.vscode/toudou-project.json');
  });

  it('warns once per absolute path, not on every window', async () => {
    state.config.set('toudou.defaultStoragePath', '/elsewhere/todos.json');
    await init();
    assert.equal(shown.filter((s) => /absolute path/.test(s.message)).length, 1);

    await init();
    assert.equal(
      shown.filter((s) => /absolute path/.test(s.message)).length,
      1,
      'a deliberate setup stays quiet',
    );
  });

  it('reports a storage folder it cannot create', async () => {
    memfs.failure = (op) =>
      op === 'createDirectory' ? new FsError('EACCES: permission denied', 'EACCES') : undefined;

    await init();

    assert.match(shown.at(-1)!.message, /could not create the storage folder/);
  });
});

describe('tags', () => {
  /** The first stored todo, raw, as the next reader of the file would see it. */
  function storedTodo(): Record<string, unknown> {
    return (JSON.parse(memfs.read(FILE)!) as { todos: Record<string, unknown>[] }).todos[0];
  }

  it('normalizes like Toudou Desktop', () => {
    assert.deepEqual(
      normalizeTags([' #Call ', 'call', '##work', '', '  ', '# ', 'WORK', '#  spaced ']),
      ['Call', 'work', 'spaced'],
      'trimmed, leading # stripped, empties dropped, first spelling wins',
    );
  });

  it('reads only an array, and only its strings', () => {
    assert.deepEqual(readTags({ tags: 'call;bank' }), []);
    assert.deepEqual(readTags({ tags: { call: true } }), []);
    assert.deepEqual(readTags({ tags: ['call', 3, null, '#bank'] }), ['call', 'bank']);
    assert.deepEqual(readTags({}), []);
  });

  it('writes tags at creation only when there are some', () => {
    const plain = JSON.parse(JSON.stringify(createTodo('a'))) as Record<string, unknown>;
    assert.equal('tags' in plain, false);
    assert.deepEqual(createTodo('b', undefined, undefined, 0, undefined, ['#x', 'X']).tags, ['x']);
  });

  it('copies tags onto a duplicate', () => {
    const source = { ...createTodo('a'), tags: ['call'] };
    assert.deepEqual(duplicateTodo(source, undefined, 1).tags, ['call']);
  });

  it('sets normalized tags, and removes the key once they are cleared', async () => {
    memfs.seed(FILE, fileOf([todo('a', 'ours')]));
    await init();

    await storage.setTodoTags('a', [' #Call', 'call', 'work ']);
    assert.deepEqual(storedTodo().tags, ['Call', 'work']);

    await storage.setTodoTags('a', []);
    assert.equal('tags' in storedTodo(), false);
  });

  it('never overwrites a tags value another tool wrote in another shape', async () => {
    const foreign = { ...todo('a', 'ours'), tags: 'call;bank' };
    memfs.seed(FILE, fileOf([foreign]));
    await init();

    await storage.setTodoTags('a', ['work']);
    assert.equal(storedTodo().tags, 'call;bank');
    await storage.setTodoTags('a', []);
    assert.equal(storedTodo().tags, 'call;bank', 'clearing does not drop it either');

    await storage.completeTodoById('a');
    await storage.restoreFromHistory('a');
    assert.equal(storedTodo().tags, 'call;bank', 'and it survives a round trip');
  });

  it('lists every tag of the file once, sorted, ignoring foreign shapes', async () => {
    memfs.seed(
      FILE,
      JSON.stringify({
        categories: [],
        todos: [
          { ...todo('a', 'one'), tags: ['work', 'Call'] },
          { ...todo('b', 'two', 1), tags: 'nope' },
        ],
        history: [
          {
            ...todo('c', 'done'),
            completedAt: '2026-07-29T00:00:00.000Z',
            tags: ['call', 'admin'],
          },
        ],
      }),
    );
    await init();

    assert.deepEqual(storage.getAllTags(), ['admin', 'Call', 'work']);
  });
});

describe('due dates', () => {
  function storedTodo(): Record<string, unknown> {
    return (JSON.parse(memfs.read(FILE)!) as { todos: Record<string, unknown>[] }).todos[0];
  }

  it('accepts only real calendar days written YYYY-MM-DD', () => {
    for (const ok of ['2026-02-28', '2024-02-29', '2026-12-31']) assert.ok(isValidDueDate(ok), ok);
    for (const bad of [
      '2026-02-30',
      '2025-02-29',
      '2026-13-01',
      '2026-00-10',
      '2026-1-5',
      '2026-11-05T00:00:00Z',
      '',
    ]) {
      assert.equal(isValidDueDate(bad), false, bad);
    }
  });

  it('is overdue strictly before today, by local calendar day', () => {
    assert.equal(todayLocal(new Date(2026, 0, 5, 23, 59)), '2026-01-05');
    assert.equal(isOverdue({ dueDate: '2026-01-04' }, '2026-01-05'), true);
    assert.equal(isOverdue({ dueDate: '2026-01-05' }, '2026-01-05'), false);
    assert.equal(isOverdue({ dueDate: 20260101 }, '2026-01-05'), false, 'a foreign value is none');
    assert.equal(isOverdue({}, '2026-01-05'), false);
  });

  it('sorts soonest first, undated last, ties in manual order', () => {
    const at = (id: string, order: number, dueDate?: string) => ({
      ...todo(id, id, order),
      dueDate,
    });
    const sorted = [
      at('undated-late', 3),
      at('later', 0, '2026-12-01'),
      at('soon-b', 2, '2026-11-10'),
      at('undated-early', 1),
      at('soon-a', 1, '2026-11-10'),
    ].sort((a, b) => compareByDueDate(a as never, b as never));
    assert.deepEqual(
      sorted.map((t) => t.id),
      ['soon-a', 'soon-b', 'later', 'undated-early', 'undated-late'],
    );
  });

  it('is omitted at creation when unset, and copied on duplicate', () => {
    const plain = JSON.parse(JSON.stringify(createTodo('a'))) as Record<string, unknown>;
    assert.equal('dueDate' in plain, false);
    const dated = createTodo('b', undefined, undefined, 0, undefined, [], '2026-11-10');
    assert.equal(duplicateTodo(dated, undefined, 1).dueDate, '2026-11-10');
  });

  it('sets, clears, and refuses an impossible date', async () => {
    memfs.seed(FILE, fileOf([todo('a', 'ours')]));
    await init();

    await storage.setTodoDueDate('a', '2026-11-10');
    assert.equal(storedTodo().dueDate, '2026-11-10');

    await storage.setTodoDueDate('a', '2026-02-30');
    assert.equal(storedTodo().dueDate, '2026-11-10', 'an impossible date changes nothing');

    await storage.setTodoDueDate('a', undefined);
    assert.equal('dueDate' in storedTodo(), false);
  });

  it('is carried through completion and restoration', async () => {
    memfs.seed(FILE, fileOf([todo('a', 'ours')]));
    await init();
    await storage.setTodoDueDate('a', '2026-11-10');

    await storage.completeTodoById('a');
    assert.equal(storage.getHistory()[0].dueDate, '2026-11-10');
    await storage.restoreFromHistory('a');
    assert.equal(storedTodo().dueDate, '2026-11-10');
  });

  it('never overwrites a due date another tool wrote in another shape', async () => {
    const foreign = { ...todo('a', 'ours'), dueDate: { day: 10 } };
    memfs.seed(FILE, fileOf([foreign]));
    await init();

    await storage.setTodoDueDate('a', '2026-11-10');
    await storage.setTodoDueDate('a', undefined);
    assert.deepEqual(storedTodo().dueDate, { day: 10 });
  });
});

describe('filter', () => {
  const tagged = (tags: unknown) => ({ tags });
  const keeps = (item: { tags?: unknown }, raw: string, fields: string[] = ['Call the bank']) =>
    matchesFilter(item, fields, parseFilter(raw));

  it('matches plain text on the fields and as a substring of tag names', () => {
    assert.equal(keeps(tagged([]), 'bank'), true);
    assert.equal(keeps(tagged(['rdv-medecin']), 'medecin'), true, 'tag names are searched');
    assert.equal(keeps(tagged(['rdv-medecin']), 'MEDECIN'), true, 'case-insensitively');
    assert.equal(keeps(tagged(['work']), 'garden'), false);
  });

  it('keeps only entries carrying the tag by its whole name, whatever its case', () => {
    assert.equal(keeps(tagged(['Call']), '#call'), true);
    assert.equal(keeps(tagged(['rdv-medecin']), '#rdv'), false, 'no substring in tag mode');
    assert.equal(keeps(tagged([]), '#bank'), false, 'the title does not stand in for a tag');
  });

  it('requires every tag of the filter', () => {
    assert.equal(keeps(tagged(['call', 'work']), '#call #WORK'), true);
    assert.equal(keeps(tagged(['call']), '#call #work'), false);
  });

  it('reads a mixed filter as tags AND text', () => {
    assert.equal(keeps(tagged(['call']), '#call bank'), true);
    assert.equal(keeps(tagged(['call']), '#call garden'), false, 'the text must match too');
    assert.equal(keeps(tagged([]), '#call bank'), false, 'and the tag must be carried');
    assert.deepEqual(parseFilter('  #a  plain   #  words '), { tags: ['a'], text: 'plain words' });
  });

  it('treats a non-array tags value as no tags', () => {
    assert.equal(keeps(tagged('call;bank'), '#call'), false);
    assert.equal(keeps(tagged('call;bank'), 'call;bank', ['title']), false);
    assert.equal(keeps(tagged('call;bank'), 'bank'), true, 'the fields still match');
  });

  it('never shows a category for its name in tag mode', () => {
    assert.equal(categoryNameMatches('Work', parseFilter('work')), true);
    assert.equal(categoryNameMatches('Work', parseFilter('#work')), false);
    assert.equal(categoryNameMatches('Work', parseFilter('#call work')), false);
    assert.equal(categoryNameMatches('Home', parseFilter('work')), false);
  });
});
