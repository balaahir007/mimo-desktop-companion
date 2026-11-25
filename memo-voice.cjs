const path = require('node:path');
const {Worker} = require('node:worker_threads');

class MemoVoice {
  constructor() {
    this.next = 0;
    this.pending = new Map();
  }

  engine() {
    if (this.worker) return this.worker;
    const worker = new Worker(path.join(__dirname,'memo-voice-worker.cjs'));
    worker.on('message', result => {
      if (!result.id) return;
      const complete = this.pending.get(result.id);
      this.pending.delete(result.id);
      complete?.(result);
    });
    const reset = message => {
      if (this.worker !== worker) return;
      this.worker = undefined;
      for (const complete of this.pending.values()) complete({error:message});
      this.pending.clear();
    };
    worker.on('error', error => reset(error.message));
    worker.on('exit', () => reset('The Memo voice worker stopped.'));
    worker.unref();
    this.worker = worker;
    return worker;
  }

  warm() { this.engine().postMessage({warm:true}); }

  render(text, rate, volume) {
    const id = ++this.next;
    const result = new Promise(resolve => {
      this.pending.set(id,resolve);
      try { this.engine().postMessage({id,text,rate,volume}); }
      catch (error) { this.pending.delete(id); resolve({error:error.message}); }
    });
    return {result, cancel:() => {
      const complete = this.pending.get(id);
      this.pending.delete(id);
      complete?.({cancelled:true});
    }};
  }

  dispose() {
    const worker = this.worker;
    if (!worker) return;
    worker.ref();
    return new Promise(resolve => {
      worker.once('exit',resolve);
      worker.postMessage({dispose:true});
    });
  }
}

module.exports = {MemoVoice};
