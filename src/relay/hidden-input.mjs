import readline from 'node:readline';

const MAX_HIDDEN_HEX_BYTES = 64 * 1024;

/** Reads one non-empty hex value from a real TTY without echoing it. */
export async function promptForHiddenHex({
  prompt,
  input = process.stdin,
  output = process.stderr,
} = {}) {
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== 'function') {
    throw new Error('A real interactive terminal is required for hidden signature input');
  }
  output.write(prompt ?? 'Hidden hex value: ');
  readline.emitKeypressEvents(input);
  const previousRawMode = Boolean(input.isRaw);
  const chunks = [];
  let byteLength = 0;

  return new Promise((resolve, reject) => {
    let settled = false;
    const clear = () => {
      for (const chunk of chunks) chunk.fill(0);
      chunks.length = 0;
      byteLength = 0;
    };
    const cleanup = () => {
      if (settled) return;
      settled = true;
      input.off('keypress', onKeypress);
      input.setRawMode(previousRawMode);
      input.pause();
      output.write('\n');
    };
    const fail = (message) => {
      cleanup();
      clear();
      reject(new Error(message));
    };
    const finish = () => {
      cleanup();
      const valueBytes = Buffer.concat(chunks, byteLength);
      try {
        const value = valueBytes.toString('ascii');
        if (!/^0x(?:[0-9a-fA-F]{2})+$/.test(value)) {
          clear();
          reject(new Error('Hidden signature must be non-empty, even-length 0x hex'));
          return;
        }
        clear();
        resolve(value);
      } finally {
        valueBytes.fill(0);
      }
    };

    function onKeypress(sequence, key = {}) {
      if ((key.ctrl && key.name === 'c') || sequence === '\u0003') {
        fail('Hidden signature input cancelled');
        return;
      }
      if (key.name === 'return' || key.name === 'enter') {
        finish();
        return;
      }
      if (key.name === 'backspace') {
        const removed = chunks.pop();
        if (removed) {
          byteLength -= removed.length;
          removed.fill(0);
        }
        return;
      }
      if (typeof sequence !== 'string' || sequence.length === 0 || key.ctrl || key.meta) return;
      if (!/^[0-9a-fA-Fx]+$/.test(sequence)) {
        fail('Hidden signature contains a non-hex character');
        return;
      }
      const chunk = Buffer.from(sequence, 'ascii');
      if (byteLength + chunk.length > MAX_HIDDEN_HEX_BYTES) {
        chunk.fill(0);
        fail('Hidden signature is too large');
        return;
      }
      chunks.push(chunk);
      byteLength += chunk.length;
    }

    input.setRawMode(true);
    input.resume();
    input.on('keypress', onKeypress);
  });
}
