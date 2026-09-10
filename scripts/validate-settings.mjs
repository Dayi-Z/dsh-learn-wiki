import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'
const req = createRequire('file:///D:/Harness/dsh-learn-wiki/index.js')
const Y = req('D:/Harness/dsh-desktop/resources/app/node_modules/js-yaml')
const txt = await readFile(join(homedir(), '.dsh', 'settings.yaml'), 'utf8')
const doc = (Y.load ?? Y.parse)(txt)
const p = doc?.['llm-pi-ai']?.providers?.opencodefree
console.log('YAML 解析 OK')
console.log('opencodefree.headers = ' + JSON.stringify(p?.headers))
console.log('opencodefree.models  = ' + (p?.models ?? []).map(m => m.id).join(', '))
console.log('agent-default-model  = ' + JSON.stringify(doc?.['agent-default-model']))
