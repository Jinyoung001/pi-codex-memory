import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { memoryTools } from '../src/read-path.ts';
import { listMemories, readMemory, searchMemories } from '../src/memory-backend.ts';

test('pinned backend defaults: 2000 list, 200 search, 20000 read tokens; UTF-8 and minimal windows', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pcm-contract-'));
  try {
    for (let i = 0; i < 2001; i++) fs.writeFileSync(path.join(root, `${String(i).padStart(4, '0')}.txt`), '');
    assert.equal(listMemories(root, {}).entries.length, 2000);
    assert.equal(listMemories(root, { max_results: 9999 }).entries.length, 2000);
    assert.equal(listMemories(root, { cursor: '+2000' }).entries.length, 1);
    const text = 'found\n'.repeat(220) + 'x'.repeat(20000);
    fs.writeFileSync(path.join(root, '0000.txt'), text);
    assert.equal(searchMemories(root, { queries: ['found'] }).matches.length, 200);
    assert.equal(readMemory(root, { path: '0000.txt' }).content, text);
    assert.equal(readMemory(root, { path: '0000.txt', max_tokens: 0 }).content, text);
    assert.throws(() => readMemory(root, { path: '0000.txt', max_tokens: NaN }), /positive/);
    fs.writeFileSync(path.join(root, '0000.txt'), '\ufeffalpha\r\nbeta\r\nalpha beta\r\n');
    assert.equal(readMemory(root, { path: '0000.txt', max_lines: 1 }).content, '\ufeffalpha\r\n');
    assert.deepEqual(searchMemories(root, { path: '0000.txt', queries: ['alpha', 'beta'], match_mode: { type: 'all_within_lines', line_count: 3 } }).matches.map(m => [m.match_line_number, m.content]), [[1, '\ufeffalpha\nbeta'], [3, 'alpha beta']]);
    assert.equal(readMemory(root, { path: '0000.txt', line_offset: 4 }).content, '');
    assert.throws(() => readMemory(root, { path: '0000.txt', line_offset: 5 }), /exceeds/);
    fs.writeFileSync(path.join(root, '0001.txt'), Buffer.from([0xff, 0xfe]));
    assert.throws(() => readMemory(root, { path: '0001.txt' }), /encoded data/);
    assert.equal(searchMemories(root, { queries: ['alpha'] }).matches.length, 2);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('retrieval: case default, normalized windows, paging, bounded read', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pcm-tools-'));
  try {
    fs.writeFileSync(path.join(root, 'MEMORY.md'), 'Alpha\nalpha\nfoo-bar\nignore\nbaz\n' + '한글'.repeat(3000));
    fs.mkdirSync(path.join(root, 'skills'));
    const tools = Object.fromEntries(memoryTools(root).map(t => [t.name, p => t.execute('test', p)]));
    const get = r => JSON.parse(r.content[0].text);
    assert.deepEqual(get(await tools.memories_search({ queries: ['Alpha'] })).matches.map(m => m.match_line_number), [1]);
    assert.match(get(await tools.memories_search({ queries: ['foobar', 'baz'], normalized: true, match_mode: { type: 'all_within_lines', line_count: 3 } })).matches[0].content, /foo-bar[\s\S]*baz/);
    assert.equal(get(await tools.memories_list({ max_results: 1 })).next_cursor, '1');
    assert.deepEqual(get(await tools.memories_list({ cursor: '1' })).entries, [{ path: 'skills', entry_type: 'directory' }]);
    await assert.rejects(tools.memories_search({ queries: ['alpha'], cursor: '1abc' }), /cursor/);
    const read = get(await tools.memories_read({ path: 'MEMORY.md', max_tokens: 100 }));
    assert.ok(Buffer.byteLength(read.content.replace(/…\d+ tokens truncated…/,'')) <= 400);
    assert.match(read.content,/…\d+ tokens truncated…/);
    assert.equal(read.truncated, true);
    fs.writeFileSync(path.join(root, 'skills', 'probe.py'), '# searchable helper\n');
    assert.equal(get(await tools.memories_search({ queries: ['searchable'] })).matches[0].path, 'skills/probe.py');
    assert.equal(get(await tools.memories_read({ path: 'skills/probe.py', line_offset: 1, max_lines: 1 })).content, '# searchable helper\n');
    await assert.rejects(tools.memories_read({ path: '.git/config' }), /invalid/);
    await assert.rejects(tools.memories_read({ path: '../other.txt' }), /invalid/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
