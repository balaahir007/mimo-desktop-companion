const {spawn} = require('node:child_process');
const {createInterface} = require('node:readline');
const {readFileSync} = require('node:fs');
const path = require('node:path');
const {MemoVoice} = require('./memo-voice.cjs');
const {wakePhrases} = require('./reminder-language.cjs');
const {voiceLines} = require('./companion.cjs');

class WindowsSpeech {
  constructor() { this.memo = new MemoVoice(); }

  run(mode, {input, language = 'en-US', onEvent = () => {}, waveFile, timeout = 22000} = {}) {
    if (process.platform !== 'win32')
      return {result: Promise.resolve({type:'error', text:'System voice services require Windows.'}), cancel() {}};
    const exe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const child = spawn(exe, ['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass',
      '-File',path.join(__dirname, 'windows-speech.ps1'),'-Mode',mode,'-Language',language,
      ...(waveFile ? ['-WaveFile', waveFile] : [])],
    {windowsHide: true, stdio: ['pipe', 'pipe', 'ignore']});
    const stdout = createInterface({input: child.stdout});
    let response;
    let cancelled = false;
    let timedOut = false;
    const startupTimer = mode === 'wake' && setTimeout(() => child.kill(), 15000);
    const timer = timeout && setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeout);
    stdout.on('line', line => {
      let event;
      try { event = JSON.parse(line); } catch { return; }
      if (cancelled || timedOut) return;
      if (event.type === 'ready') clearTimeout(startupTimer);
      if (['ready','partial'].includes(event.type)) onEvent(event);
      else response = event;
    });
    child.on('error', () => {});
    child.stdin.on('error', () => {});
    child.stdin.end(input ? Buffer.from(JSON.stringify(input)).toString('base64') + '\n' : undefined);
    return {
      result: new Promise(resolve => child.once('close', () => {
        clearTimeout(timer);
        clearTimeout(startupTimer);
        stdout.close();
        if (cancelled) resolve({type:'cancelled'});
        else if (timedOut && mode === 'listen') resolve({type:'empty'});
        else resolve(response || {type:'error', text:['listen','wake'].includes(mode) ?
          'Speech recognition is unavailable. You can type below.' : 'Windows voice playback is unavailable.'});
      })),
      cancel() { cancelled = true; child.kill(); }
    };
  }

  listen(onEvent, language, name = 'Memo') {
    return this.run('listen', {onEvent, language, input:{names:[...new Set([name,'Memo','Mimo'])]}});
  }

  wake(name, onEvent) {
    return this.run('wake', {onEvent, input:{phrases:wakePhrases(name)}, timeout:0});
  }

  systemSpeak(text, profile) {
    return this.run('speak', {
      input: {text, voice:profile.voice, rate:Math.round((profile.rate - 1) * 10), volume:profile.volume},
      timeout:22000
    });
  }

  speak(text, profile) {
    if (profile.voice) return this.systemSpeak(text,profile);
    const clip = profile.rate === 1 && Object.keys(voiceLines).find(key => voiceLines[key] === text);
    if (clip) {
      try {
        // The bundled clips are 16-bit PCM WAVs with a fixed 44-byte header.
        const wave = readFileSync(path.join(__dirname,'voice-clips',clip + '.wav'));
        for (let i = 44; i < wave.length; i += 2)
          wave.writeInt16LE(Math.round(wave.readInt16LE(i) * profile.volume / 100),i);
        return this.run('play',{input:{audio:wave.toString('base64')},timeout:15000});
      } catch {
        // If the clip is missing, use the same local synthesis path as other lines.
      }
    }
    const generated = this.memo.render(text,profile.rate,profile.volume);
    let playback;
    let cancelled = false;
    let timer;
    const fallback = new Promise(resolve => {
      timer = setTimeout(() => resolve({error:'Voice synthesis timed out.'}),6500);
    });
    const result = Promise.race([generated.result,fallback]).then(output => {
      clearTimeout(timer);
      if (cancelled || output.cancelled) return {type:'cancelled'};
      if (output.error) {
        generated.cancel();
        playback = this.systemSpeak(text,profile);
      } else {
        playback = this.run('play',{input:{audio:output.audio},timeout:25000});
      }
      return playback.result;
    });
    return {result, cancel() { cancelled = true; generated.cancel(); playback?.cancel(); }};
  }

  async voices() {
    const result = await this.run('voices', {timeout: 8000}).result;
    return result.voices || [];
  }
}

module.exports = {WindowsSpeech};
