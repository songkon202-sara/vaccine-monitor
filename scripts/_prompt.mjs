import readline from 'node:readline';

// ตัวช่วยถามค่าจากผู้ใช้ รองรับการพิมพ์แบบซ่อน (โทเคน/รหัส) และการป้อนค่าผ่าน pipe
export function createPrompter() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: !!process.stdin.isTTY,
  });
  let muted = false;
  if (rl.terminal && typeof rl._writeToOutput === 'function') {
    const orig = rl._writeToOutput.bind(rl);
    rl._writeToOutput = (s) => {
      if (!muted) orig(s);
    };
  }

  const queue = [];
  const waiters = [];
  rl.on('line', (l) => (waiters.length ? waiters.shift()(l) : queue.push(l)));
  rl.on('close', () => {
    while (waiters.length) waiters.shift()('');
  });
  const next = () => (queue.length ? Promise.resolve(queue.shift()) : new Promise((r) => waiters.push(r)));

  return {
    async ask(question, { hidden = false } = {}) {
      process.stdout.write(question);
      muted = hidden && rl.terminal;
      const answer = await next();
      muted = false;
      if (hidden && rl.terminal) process.stdout.write('\n');
      return answer.trim();
    },
    // ถามจนกว่าจะได้ค่า (สูงสุด 3 ครั้ง)
    async need(question, opts = {}) {
      for (let i = 0; i < 3; i++) {
        const v = await this.ask(question, opts);
        if (v) return v;
        console.log('  ต้องกรอกค่านี้');
      }
      throw new Error('ไม่ได้รับค่าที่จำเป็น');
    },
    close() {
      rl.close();
    },
  };
}
