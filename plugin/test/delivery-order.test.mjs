import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

let client
runInNewContext(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'), {
  window: { __ModuleLoader__: { load(definition) { client = definition.factory(() => ({})) } } },
})

// E2E #23: the 交付 tab opened on the earliest draft, with the final file folded below it.
test('a task\'s delivered files are listed newest first, so the 交付 tab opens on the last delivery', () => {
  const project = { files: [
    { path: 'draft.md', at: 1, by: { threadId: 't_a' } },
    { path: 'other.md', at: 5, by: { threadId: 't_b' } },
    { path: 'final.md', at: 9, by: { threadId: 't_a' } },
    { path: 'v2.md', at: 4, by: { threadId: 't_a' } },
  ] }
  assert.equal(client.deliveredFiles(project, { id: 't_a' }).map(f => f.path).join(','), 'final.md,v2.md,draft.md')
  assert.equal(client.deliveredFiles({}, { id: 't_a' }).length, 0)
})

test('the 交付 tab puts the file to look at first on top: the page of the last delivery before its screenshots', () => {
  const at = 1_000_000
  const files = [
    { path: 'page-mobile.png', mime: 'image/png', at: at + 100 }, { path: 'page-desktop.png', mime: 'image/png', at: at + 50 },
    { path: 'page.html', mime: 'text/html', at }, { path: 'draft.html', mime: 'text/html', at: at - 3_600_000 },
  ]
  assert.equal(client.deliveryOrder(files).map(f => f.path).join(','), 'page.html,page-mobile.png,page-desktop.png,draft.html')
  const docs = [{ path: 'final.md', at: 9 }, { path: 'data.csv', at: 9 }]
  assert.equal(client.deliveryOrder(docs)[0].path, 'final.md')
  assert.equal(client.deliveryOrder([{ path: 'a.zip', at: 2 }, { path: 'b.bin', at: 1 }]).map(f => f.path).join(','), 'a.zip,b.bin', 'nothing to preview: the order stays')
  assert.equal(client.deliveryOrder([]).length, 0)
})
