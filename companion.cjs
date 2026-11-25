const options = {
  preset: ['Bunny','Cloud','Robot','Sprout','Star'], color: ['Lavender','Mint','Peach','Sky','Rose','Sunshine'],
  face: ['Curious','Happy','Sleepy'], accessory: ['None','Bow','Crown'],
  size: ['Small','Medium','Large'], action: ['Wave','Jump','Dance','Celebrate','Walk','Sleep','Breathe']
};
const defaults = Object.fromEntries(Object.entries(options).map(([key,values]) => [key,values[0]]));
Object.assign(defaults, {
  size:'Medium', name:'Memo', voice:'', speech:true, rate:1, volume:85, recognition:null, wake:false,
  shortcut:'Ctrl+Alt+Space', stopShortcut:'Ctrl+Alt+Backspace'
});

function validate(key,value) {
  if (Object.hasOwn(options,key) && options[key].includes(value)) return true;
  switch (key) {
    case 'speech':
    case 'wake': return typeof value === 'boolean';
    case 'recognition': return value === null || typeof value === 'boolean';
    case 'name': return typeof value === 'string' && /^[\p{L}\p{N}][\p{L}\p{N} '-]{0,23}$/u.test(value);
    case 'voice': return typeof value === 'string' && value.length <= 512;
    case 'rate': return [0.8,1,1.2].includes(value);
    case 'volume': return Number.isInteger(value) && value >= 0 && value <= 100;
    case 'shortcut':
    case 'stopShortcut': return typeof value === 'string' && value.length <= 60 &&
      /^(?:(?:Ctrl|Control|Alt|Shift|Super|Win)\+)+(?:[A-Z0-9]|F(?:[1-9]|1\d|2[0-4])|Space|Enter|Tab|Backspace|Delete|Insert|Home|End|PageUp|PageDown|Up|Down|Left|Right)$/i.test(value);
    default: return false;
  }
}

const voiceLines = {
  greeting:"Hey! I'm here. What can I do for you?",
  goodbye:"Okie-dokie! I'll be here if you need me. Bye-bye!"
};
module.exports = {options,defaults,validate,voiceLines};
