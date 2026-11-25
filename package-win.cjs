const {cpSync, existsSync, mkdirSync, renameSync, writeFileSync} = require('node:fs');
const path = require('node:path');
const manifest = require('./package.json');
const lockfile = require('./package-lock.json');

if (process.platform !== 'win32') throw Error('Run this command with a Windows Electron download.');
const runtime = path.dirname(require('electron'));
if (!existsSync(path.join(runtime,'version'))) throw Error('Install the Electron runtime before packaging.');
const output = path.join(__dirname,'release',`Mimo-win-${process.arch}`);
const refresh = process.argv.includes('--refresh');
if (existsSync(output) && !refresh) throw Error(`Use --refresh to update the existing build: ${output}`);
const model = path.join(__dirname,'voice-model');
if (!existsSync(path.join(model,'onnx','model_quantized.onnx'))) throw Error('The bundled Memo voice model is missing.');

if (!existsSync(path.join(output,'Mimo.exe'))) {
  mkdirSync(path.dirname(output), {recursive:true});
  cpSync(runtime, output, {recursive:true});
  renameSync(path.join(output,'electron.exe'), path.join(output,'Mimo.exe'));
}
const app = path.join(output,'resources','app');
mkdirSync(app, {recursive:true});
for (const file of [
  'desktop.cjs','companion.cjs','conversation.cjs','reminder-language.cjs','preload.cjs','speech.cjs',
  'store.cjs','windows-speech.ps1','avatar.js','dashboard.js','studio.js','widget.js','style.css',
  'index.html','widget.html','mimo.svg','memo-voice.cjs','memo-voice-worker.cjs','actions.cjs','actions-ui.js',
  'workflows.cjs','workflows-ui.js','mimo-n8n-starter.json','agent.cjs','agent-ui.js'
]) cpSync(path.join(__dirname,file), path.join(app,file));
cpSync(model,path.join(app,'voice-model'),{recursive:true});
cpSync(path.join(__dirname,'voice-clips'),path.join(app,'voice-clips'),{recursive:true});
for (const [folder,info] of Object.entries(lockfile.packages)) {
  if (!folder || info.dev) continue;
  const source = path.join(__dirname,folder);
  if (info.optional && !existsSync(source)) continue;
  cpSync(source,path.join(app,folder),{recursive:true});
}
writeFileSync(path.join(app,'package.json'),JSON.stringify({
  name:manifest.name, version:manifest.version, description:manifest.description, main:manifest.main
}, null, 2));
console.log(path.join(output,'Mimo.exe'));
