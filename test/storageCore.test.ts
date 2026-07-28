import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  applyManualOrder,
  clampWatchIntervalSeconds,
  DEFAULT_INTERVAL_SECONDS,
  describeFsError,
  errnoOf,
  isAbsolutePath,
  isInside,
  isMissing,
  parseStorageData,
  sameSignature,
  serializeStorageData,
  trimUndoStack,
} from '../src/services/storageCore';

const TODO = {
  id: 't1',
  title: 'Write tests',
  description: undefined,
  categoryId: undefined,
  priority: undefined,
  inProgress: undefined,
  order: 0,
  createdAt: '2026-07-28T10:00:00.000Z',
};

/** What a write to disk would produce for the given file contents. */
function roundTrip(raw: string): unknown {
  return JSON.parse(serializeStorageData(parseStorageData(raw)));
}

describe('parseStorageData', () => {
  it('reads the fields it owns', () => {
    const data = parseStorageData(
      JSON.stringify({ workspace: 'demo', todos: [TODO], sortMode: 'priority' }),
    );
    assert.equal(data.workspace, 'demo');
    assert.equal(data.todos.length, 1);
    assert.equal(data.todos[0].title, 'Write tests');
    assert.equal(data.sortMode, 'priority');
  });

  it('rejects anything that is not a JSON object', () => {
    assert.throws(() => parseStorageData('[]'));
    assert.throws(() => parseStorageData('"nope"'));
    assert.throws(() => parseStorageData('null'));
    assert.throws(() => parseStorageData('{'));
  });

  it('ignores an unknown sort mode', () => {
    assert.equal(parseStorageData('{"sortMode":"whatever"}').sortMode, undefined);
  });

  it('never adopts a prototype from the file', () => {
    const data = parseStorageData('{"__proto__":{"polluted":true},"todos":[]}');
    assert.equal((data as unknown as Record<string, unknown>).polluted, undefined);
    assert.equal(({} as Record<string, unknown>).polluted, undefined);
    assert.equal(Object.keys(data.foreign.keys).length, 0);
  });
});

describe('storage round-trip', () => {
  it('keeps top-level keys written by another client', () => {
    const raw = JSON.stringify({
      todos: [TODO],
      obsidianVersion: 3,
      vault: { name: 'notes' },
    });
    const out = roundTrip(raw) as Record<string, unknown>;
    assert.equal(out.obsidianVersion, 3);
    assert.deepEqual(out.vault, { name: 'notes' });
  });

  it('keeps entries it cannot validate instead of deleting them', () => {
    // A todo without a numeric `order`, as a peer editor might write it.
    const foreignTodo = { id: 'x', title: 'From Obsidian', due: '2026-08-01' };
    const raw = JSON.stringify({
      todos: [TODO, foreignTodo],
      categories: [{ id: 'c', name: 'no order' }],
      history: [{ id: 'h', title: 'no completedAt' }],
    });

    const data = parseStorageData(raw);
    assert.equal(data.todos.length, 1, 'only the valid todo is exposed to the UI');
    assert.equal(data.foreign.todos.length, 1);

    const out = roundTrip(raw) as Record<string, unknown[]>;
    assert.deepEqual(out.todos[1], foreignTodo, 'the foreign todo survives a write');
    assert.equal(out.categories.length, 1);
    assert.equal(out.history.length, 1);
  });

  it('drops nothing when the file is only ours', () => {
    const raw = JSON.stringify({ workspace: 'demo', categories: [], todos: [TODO], history: [] });
    assert.deepEqual(roundTrip(raw), JSON.parse(raw));
  });

  it('omits absent optional fields', () => {
    const out = roundTrip('{}') as Record<string, unknown>;
    assert.deepEqual(Object.keys(out), ['categories', 'todos', 'history']);
  });
});

describe('sameSignature', () => {
  it('treats a missing file as equal only to another missing file', () => {
    assert.equal(sameSignature(undefined, undefined), true);
    assert.equal(sameSignature({ mtime: 1, size: 1 }, undefined), false);
    assert.equal(sameSignature(undefined, { mtime: 1, size: 1 }), false);
  });

  it('compares size as well as mtime', () => {
    assert.equal(sameSignature({ mtime: 10, size: 5 }, { mtime: 10, size: 5 }), true);
    assert.equal(sameSignature({ mtime: 10, size: 6 }, { mtime: 10, size: 5 }), false);
    assert.equal(sameSignature({ mtime: 11, size: 5 }, { mtime: 10, size: 5 }), false);
  });
});

describe('filesystem errors', () => {
  it('extracts the errno from a Node message', () => {
    assert.equal(
      errnoOf(new Error("EPERM: operation not permitted, rename '/a' -> '/b'")),
      'EPERM',
    );
    assert.equal(errnoOf(new Error('Unable to write file (EBUSY: resource busy)')), 'EBUSY');
  });

  it('falls back to the VS Code error code', () => {
    assert.equal(
      errnoOf(Object.assign(new Error('nope'), { code: 'FileNotFound' })),
      'FileNotFound',
    );
    assert.equal(errnoOf(new Error('nope')), undefined);
  });

  it('recognizes a missing file from either side', () => {
    assert.equal(isMissing(new Error("ENOENT: no such file or directory, stat '/a'")), true);
    assert.equal(isMissing(Object.assign(new Error('nope'), { code: 'FileNotFound' })), true);
    assert.equal(isMissing(new Error("EACCES: permission denied, open '/a'")), false);
  });

  it('prefixes the code only when the message lacks it', () => {
    const withCode = new Error("EPERM: operation not permitted, open '/a'");
    assert.equal(describeFsError(withCode), withCode.message);
    const vscodeStyle = Object.assign(new Error('Permission denied'), { code: 'NoPermissions' });
    assert.equal(describeFsError(vscodeStyle), 'NoPermissions: Permission denied');
  });
});

describe('paths', () => {
  it('recognizes absolute paths on both platforms', () => {
    assert.equal(isAbsolutePath('/home/u/todos.json'), true);
    assert.equal(isAbsolutePath('C:\\Users\\u\\todos.json'), true);
    assert.equal(isAbsolutePath('c:/Users/u/todos.json'), true);
    assert.equal(isAbsolutePath('.toudou/todos.json'), false);
    assert.equal(isAbsolutePath('../escape.json'), false);
  });

  it('does not mistake a sibling folder for a child', () => {
    assert.equal(isInside('/home/u/proj', '/home/u/proj/todos.json'), true);
    assert.equal(isInside('/home/u/proj/', '/home/u/proj/todos.json'), true);
    assert.equal(isInside('/home/u/proj', '/home/u/project-evil/todos.json'), false);
    assert.equal(isInside('/home/u/proj', '/etc/passwd'), false);
  });
});

describe('applyManualOrder', () => {
  const items = (...ids: string[]) => ids.map((id, index) => ({ id, order: index }));

  it('renumbers gaplessly in the requested order', () => {
    const list = items('a', 'b', 'c');
    applyManualOrder(list, ['c', 'a', 'b']);
    assert.deepEqual(
      list.map((i) => [i.id, i.order]),
      [
        ['a', 1],
        ['b', 2],
        ['c', 0],
      ],
    );
  });

  it('appends what the caller did not know about, without collisions', () => {
    // `d` was added by another editor while the drag was in flight.
    const list = items('a', 'b', 'c', 'd');
    applyManualOrder(list, ['c', 'b', 'a']);
    const orders = list.map((i) => i.order).sort((x, y) => x - y);
    assert.deepEqual(orders, [0, 1, 2, 3], 'no two entries share an order');
    assert.equal(list.find((i) => i.id === 'd')!.order, 3);
  });

  it('keeps the relative order of several unknown entries', () => {
    const list = [
      { id: 'known', order: 5 },
      { id: 'x', order: 1 },
      { id: 'y', order: 3 },
    ];
    applyManualOrder(list, ['known']);
    assert.equal(list.find((i) => i.id === 'known')!.order, 0);
    assert.equal(list.find((i) => i.id === 'x')!.order, 1);
    assert.equal(list.find((i) => i.id === 'y')!.order, 2);
  });

  it('ignores ids that are not in the list', () => {
    const list = items('a', 'b');
    applyManualOrder(list, ['ghost', 'b', 'a']);
    assert.deepEqual(
      list.map((i) => [i.id, i.order]),
      [
        ['a', 1],
        ['b', 0],
      ],
    );
  });
});

describe('trimUndoStack', () => {
  it('caps the number of entries', () => {
    const stack = ['1', '2', '3', '4'];
    trimUndoStack(stack, 2, 1000);
    assert.deepEqual(stack, ['3', '4']);
  });

  it('caps the total size, oldest first', () => {
    const stack = ['aaaa', 'bbbb', 'cc'];
    trimUndoStack(stack, 50, 6);
    assert.deepEqual(stack, ['bbbb', 'cc']);
  });

  it('always keeps the most recent snapshot, however large', () => {
    const stack = ['x'.repeat(100)];
    trimUndoStack(stack, 50, 10);
    assert.equal(stack.length, 1);
  });

  it('leaves a stack within budget alone', () => {
    const stack = ['a', 'b'];
    trimUndoStack(stack, 50, 1000);
    assert.deepEqual(stack, ['a', 'b']);
  });
});

describe('clampWatchIntervalSeconds', () => {
  it('keeps a sane value', () => {
    assert.equal(clampWatchIntervalSeconds(5), 5);
    assert.equal(clampWatchIntervalSeconds(10), 10);
  });

  it('falls back when the setting is not a finite number', () => {
    // settings.json is not type-coerced, so anything can arrive here.
    assert.equal(clampWatchIntervalSeconds('fast'), DEFAULT_INTERVAL_SECONDS);
    assert.equal(clampWatchIntervalSeconds(undefined), DEFAULT_INTERVAL_SECONDS);
    assert.equal(clampWatchIntervalSeconds(NaN), DEFAULT_INTERVAL_SECONDS);
    assert.equal(clampWatchIntervalSeconds(Infinity), DEFAULT_INTERVAL_SECONDS);
    assert.equal(clampWatchIntervalSeconds(null), DEFAULT_INTERVAL_SECONDS);
  });

  it('never lets the poll become a busy loop', () => {
    assert.equal(clampWatchIntervalSeconds(0), 1);
    assert.equal(clampWatchIntervalSeconds(-10), 1);
    assert.equal(clampWatchIntervalSeconds(0.001), 1);
  });

  it('caps an absurdly long interval', () => {
    assert.equal(clampWatchIntervalSeconds(10 ** 9), 3600);
  });
});
