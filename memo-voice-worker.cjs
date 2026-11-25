const {readFileSync} = require('node:fs');
const path = require('node:path');
const {parentPort} = require('node:worker_threads');
const {KokoroTTS} = require('kokoro-js');
const {env, Tensor} = require('@huggingface/transformers');

env.allowRemoteModels = false;
env.localModelPath = __dirname;
env.useFSCache = false;

const sources = [['af_sky',0.50],['af_bella',0.38],['af_nicole',0.12]];
const formantScale = 1.16;

class MemoTTS extends KokoroTTS {
  constructor(model, tokenizer) {
    super(model, tokenizer);
    this.styles = sources.map(([name, contribution]) => {
      const data = readFileSync(path.join(__dirname,'voice-model','voices',name + '.bin'));
      return {data: new Float32Array(data.buffer,data.byteOffset,data.length / 4), contribution};
    });
  }

  async generate_from_ids(input, {speed}) {
    const offset = 256 * Math.min(Math.max(input.dims.at(-1) - 2, 0), 509);
    const style = new Float32Array(256);
    for (const {data,contribution} of this.styles)
      for (let i = 0; i < style.length; i++) style[i] += data[offset + i] * contribution;
    const {waveform} = await this.model({
      input_ids: input, style: new Tensor('float32',style,[1,256]),
      speed: new Tensor('float32',[speed],[1])
    });
    return waveform.data;
  }
}

function encodeWave(samples, volume) {
  const rate = 24000;
  const count = Math.floor(samples.length / formantScale);
  const wave = Buffer.alloc(44 + count * 2);
  wave.write('RIFF',0);
  wave.writeUInt32LE(wave.length - 8,4);
  wave.write('WAVEfmt ',8);
  wave.writeUInt32LE(16,16);
  wave.writeUInt16LE(1,20);
  wave.writeUInt16LE(1,22);
  wave.writeUInt32LE(rate,24);
  wave.writeUInt32LE(rate * 2,28);
  wave.writeUInt16LE(2,32);
  wave.writeUInt16LE(16,34);
  wave.write('data',36);
  wave.writeUInt32LE(count * 2,40);
  for (let i = 0; i < count; i++) {
    const source = i * formantScale;
    const index = Math.floor(source);
    const blend = source - index;
    const sample = samples[index] * (1-blend) + (samples[index+1] ?? samples[index]) * blend;
    const output = Math.round(Math.max(-1,Math.min(1,sample * volume / 100)) * 32767);
    wave.writeInt16LE(output,44 + i * 2);
  }
  return wave;
}

let model;
let pending = Promise.resolve();
parentPort.on('message', request => {
  pending = pending.then(async () => {
    if (request.dispose) {
      parentPort.close();
      return;
    }
    try {
      model ??= KokoroTTS.from_pretrained('voice-model',{dtype:'q8',device:'cpu'})
        .then(base => new MemoTTS(base.model,base.tokenizer));
      const voice = await model;
      if (request.warm) return;
      const samples = await voice.generate(request.text, {
        // This selects the American phoneme rules. Memo supplies its own style embedding.
        voice:'af_sky', speed:request.rate * 1.06 / formantScale
      });
      const wave = encodeWave(samples,request.volume);
      parentPort.postMessage({id:request.id, audio:wave.toString('base64')});
    } catch (error) {
      model = undefined;
      parentPort.postMessage({id:request.id, error:error.message});
    }
  });
});
