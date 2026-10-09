// Virtual factory: a top-down conveyor cell. Physics is separate from drawing so it
// can be unit tested without a canvas.

export const INPUT_TAGS = ['START_PB', 'STOP_PB', 'ESTOP', 'RESET_PB', 'PE_ENTRY', 'PE_MID', 'PE_TALL', 'PE_END'];
export const OUTPUT_TAGS = ['MOTOR', 'DIVERTER', 'LIGHT_GREEN', 'LIGHT_AMBER', 'LIGHT_RED'];

export const TAG_INFO = {
  START_PB: 'Start pushbutton (ON while pressed)',
  STOP_PB: 'Stop pushbutton (ON while pressed, use an NC contact)',
  ESTOP: 'Emergency stop (ON while latched in; release with RESET or the Release button). Also hard-cuts motor & diverter power',
  RESET_PB: 'Reset pushbutton (ON while pressed). Also releases the E-stop latch',
  PE_ENTRY: 'Photo-eye at conveyor entry (ON when blocked)',
  PE_MID: 'Photo-eye mid conveyor (ON when blocked)',
  PE_TALL: 'Height photo-eye at the diverter, only sees TALL boxes',
  PE_END: 'Photo-eye at conveyor discharge (ON when blocked)',
  MOTOR: 'Conveyor motor contactor',
  DIVERTER: 'Pneumatic pusher: pushes boxes into the reject bin',
  LIGHT_GREEN: 'Stack light green',
  LIGHT_AMBER: 'Stack light amber',
  LIGHT_RED: 'Stack light red',
};

export const W = 820;
export const H = 360;
export const BELT = { x0: 90, x1: 700, y0: 140, y1: 220 };
export const BOX = 44;
export const SENSORS = { PE_ENTRY: 175, PE_MID: 340, PE_TALL: 500, PE_END: 672 };
export const DIVERTER_X = 500;
export const SPEED = 90; // px per second
const MID_Y = (BELT.y0 + BELT.y1) / 2;
const PUSH_TRAVEL = BELT.y1 - BELT.y0 + 30;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export class Factory {
  constructor(canvas = null) {
    this.canvas = canvas;
    this.ctx = canvas ? canvas.getContext('2d') : null;
    this.reset();
  }

  reset() {
    this.boxes = [];
    this.outputs = {};
    this.buttons = { START_PB: false, STOP_PB: false, ESTOP: false, RESET_PB: false };
    this.held = {};
    this.unseen = {};
    this.pusher = 0;
    this.beltOffset = 0;
    this.delivered = 0;
    this.rejected = 0;
    this.autoSpawn = false;
    this.spawnInterval = 2.5;
    this.spawnTimer = 0;
    this.tallChance = 0.35;
    this.nextId = 1;
  }

  /**
   * Operator presses a momentary pushbutton. The input stays ON until at least one scan has
   * read it (see consumeInputs), so a quick tap between scans is never missed.
   */
  press(tag) {
    if (tag === 'ESTOP') { this.buttons.ESTOP = true; return; }
    this.buttons[tag] = true;
    this.held[tag] = true;
    this.unseen[tag] = true;
    if (tag === 'RESET_PB') this.buttons.ESTOP = false; // RESET also releases the E-stop latch
  }

  release(tag) {
    this.held[tag] = false;
    if (!this.unseen[tag]) this.buttons[tag] = false;
  }

  releaseEstop() { this.buttons.ESTOP = false; }

  /** Call after a scan has read the inputs: drop momentary presses that were released. */
  consumeInputs() {
    for (const tag of Object.keys(this.unseen)) {
      this.unseen[tag] = false;
      if (!this.held[tag]) this.buttons[tag] = false;
    }
  }

  get motorRunning() {
    return !!this.outputs.MOTOR && !this.buttons.ESTOP;
  }

  spawnBox(tall) {
    const entryX = BELT.x0 + BOX / 2 + 4;
    if (this.boxes.some((b) => !b.pushed && b.x - BOX / 2 < entryX + BOX / 2 + 6)) return false;
    if (tall === undefined) tall = Math.random() < this.tallChance;
    this.boxes.push({ id: this.nextId++, x: entryX, y: MID_Y, tall: !!tall, pushed: false });
    return true;
  }

  removeBoxAt(x, y) {
    const i = this.boxes.findIndex((b) => Math.abs(b.x - x) <= BOX / 2 && Math.abs(b.y - y) <= BOX / 2);
    if (i >= 0) { this.boxes.splice(i, 1); return true; }
    return false;
  }

  sensorBlocked(name) {
    const sx = SENSORS[name];
    return this.boxes.some((b) => !b.pushed && Math.abs(b.x - sx) <= BOX / 2 && (name !== 'PE_TALL' || b.tall));
  }

  readInputs() {
    const i = { ...this.buttons };
    for (const n of Object.keys(SENSORS)) i[n] = this.sensorBlocked(n);
    return i;
  }

  setOutputs(tags) {
    const o = {};
    for (const t of OUTPUT_TAGS) o[t] = !!(tags && tags[t]);
    this.outputs = o;
  }

  /** Advance physics by dt seconds. */
  step(dt) {
    if (this.autoSpawn) {
      this.spawnTimer += dt;
      if (this.spawnTimer >= this.spawnInterval && this.spawnBox()) this.spawnTimer = 0;
    }
    const run = this.motorRunning;
    if (run) this.beltOffset = (this.beltOffset + SPEED * dt) % 24;

    // Pusher (diverter) cylinder
    const target = this.outputs.DIVERTER && !this.buttons.ESTOP ? 1 : 0;
    this.pusher += clamp(target - this.pusher, -3 * dt, 3 * dt);
    const face = BELT.y0 + this.pusher * PUSH_TRAVEL;

    // Boxes riding the belt, front-most first; they queue instead of overlapping
    const onBelt = this.boxes.filter((b) => !b.pushed).sort((a, b) => b.x - a.x);
    let aheadX = Infinity;
    const gateX = DIVERTER_X - 28 - BOX / 2; // an extended pusher blocks the lane
    for (const b of onBelt) {
      if (run) {
        let nx = Math.min(b.x + SPEED * dt, aheadX - BOX - 4);
        if (this.pusher > 0.1 && b.x <= gateX) nx = Math.min(nx, gateX);
        if (nx > b.x) b.x = nx;
      }
      aheadX = b.x;
    }

    // Pusher shoves any box in its lane off the belt
    for (const b of this.boxes) {
      if (b.pushed) b.y += 140 * dt; // once shoved, the box slides off into the bin
      if (Math.abs(b.x - DIVERTER_X) < 26 && face > b.y - BOX / 2) {
        const ny = face + BOX / 2;
        if (ny > b.y) { b.y = ny; }
        if (b.y > MID_Y + 4) b.pushed = true;
      }
    }

    // Remove boxes that left the belt
    this.boxes = this.boxes.filter((b) => {
      if (b.x > BELT.x1) { this.delivered++; return false; }
      if (b.y - BOX / 2 > BELT.y1) { this.rejected++; return false; }
      return true;
    });
  }

  // ---------------------------------------------------------------- drawing
  draw() {
    const c = this.ctx;
    if (!c) return;
    c.clearRect(0, 0, W, H);
    c.fillStyle = '#1b2230';
    c.fillRect(0, 0, W, H);
    // floor grid
    c.strokeStyle = '#232c3d';
    c.lineWidth = 1;
    for (let x = 0; x < W; x += 30) { c.beginPath(); c.moveTo(x, 0); c.lineTo(x, H); c.stroke(); }
    for (let y = 0; y < H; y += 30) { c.beginPath(); c.moveTo(0, y); c.lineTo(W, y); c.stroke(); }

    this.drawBins(c);
    this.drawBelt(c);
    this.drawMotor(c);
    this.drawPusher(c);
    for (const b of this.boxes) this.drawBox(c, b);
    this.drawSensors(c);
    this.drawStackLight(c);

    if (this.buttons.ESTOP) {
      c.fillStyle = 'rgba(200,0,0,0.85)';
      c.fillRect(W / 2 - 150, 12, 300, 34);
      c.fillStyle = '#fff';
      c.font = 'bold 18px system-ui, sans-serif';
      c.textAlign = 'center';
      c.fillText('E-STOP ACTIVE', W / 2, 35);
    }
  }

  drawBins(c) {
    // discharge bin
    c.fillStyle = '#2b3446';
    c.strokeStyle = '#5b6b8a';
    c.lineWidth = 2;
    c.fillRect(BELT.x1 + 12, 120, 90, 120);
    c.strokeRect(BELT.x1 + 12, 120, 90, 120);
    c.fillStyle = '#cfd8ea';
    c.font = '12px system-ui, sans-serif';
    c.textAlign = 'center';
    c.fillText('OUTFEED', BELT.x1 + 57, 165);
    c.font = 'bold 22px system-ui, sans-serif';
    c.fillText(String(this.delivered), BELT.x1 + 57, 195);
    // reject bin
    c.fillStyle = '#2b3446';
    c.fillRect(DIVERTER_X - 45, 262, 90, 80);
    c.strokeRect(DIVERTER_X - 45, 262, 90, 80);
    c.fillStyle = '#cfd8ea';
    c.font = '12px system-ui, sans-serif';
    c.fillText('REJECT BIN', DIVERTER_X, 290);
    c.font = 'bold 22px system-ui, sans-serif';
    c.fillText(String(this.rejected), DIVERTER_X, 320);
    // spawner chute
    c.fillStyle = '#3a4357';
    c.fillRect(BELT.x0 - 8, BELT.y0 - 40, 70, 30);
    c.fillStyle = '#cfd8ea';
    c.font = '11px system-ui, sans-serif';
    c.fillText(this.autoSpawn ? 'INFEED (AUTO)' : 'INFEED', BELT.x0 + 27, BELT.y0 - 21);
  }

  drawBelt(c) {
    const { x0, x1, y0, y1 } = BELT;
    c.fillStyle = '#4a4f59';
    c.fillRect(x0 - 6, y0 - 6, x1 - x0 + 12, y1 - y0 + 12);
    c.fillStyle = '#2d3036';
    c.fillRect(x0, y0, x1 - x0, y1 - y0);
    c.save();
    c.beginPath();
    c.rect(x0, y0, x1 - x0, y1 - y0);
    c.clip();
    c.strokeStyle = '#3c4048';
    c.lineWidth = 3;
    for (let x = x0 - 24 + this.beltOffset; x < x1 + 24; x += 24) {
      c.beginPath(); c.moveTo(x, y0); c.lineTo(x, y1); c.stroke();
    }
    c.restore();
    // direction arrows
    c.fillStyle = this.motorRunning ? '#7dd87d' : '#6b7280';
    for (let x = x0 + 60; x < x1; x += 160) {
      c.beginPath(); c.moveTo(x, y1 + 14); c.lineTo(x + 14, y1 + 20); c.lineTo(x, y1 + 26); c.fill();
    }
  }

  drawMotor(c) {
    const x = BELT.x0 - 44, y = (BELT.y0 + BELT.y1) / 2;
    c.fillStyle = this.motorRunning ? '#22c55e' : this.outputs.MOTOR ? '#a16207' : '#475569';
    c.beginPath(); c.arc(x, y, 22, 0, Math.PI * 2); c.fill();
    c.strokeStyle = '#cbd5e1'; c.lineWidth = 2; c.stroke();
    c.fillStyle = '#fff'; c.font = 'bold 18px system-ui, sans-serif'; c.textAlign = 'center';
    c.fillText('M', x, y + 6);
    c.font = '11px system-ui, sans-serif';
    c.fillText('MOTOR', x, y + 38);
  }

  drawPusher(c) {
    const face = BELT.y0 + this.pusher * PUSH_TRAVEL;
    c.fillStyle = '#64748b';
    c.fillRect(DIVERTER_X - 34, 70, 68, 30); // cylinder body
    c.fillStyle = '#94a3b8';
    c.fillRect(DIVERTER_X - 5, 100, 10, Math.max(0, face - 108)); // rod
    c.fillStyle = this.outputs.DIVERTER ? '#f59e0b' : '#cbd5e1';
    c.fillRect(DIVERTER_X - 28, face - 10, 56, 10); // pusher plate
    c.fillStyle = '#e2e8f0'; c.font = '11px system-ui, sans-serif'; c.textAlign = 'center';
    c.fillText('DIVERTER', DIVERTER_X, 64);
  }

  drawBox(c, b) {
    const s = BOX;
    c.fillStyle = b.tall ? '#3b82f6' : '#c08a4b';
    c.strokeStyle = b.tall ? '#1e3a8a' : '#7c5124';
    c.lineWidth = 2;
    c.fillRect(b.x - s / 2, b.y - s / 2, s, s);
    c.strokeRect(b.x - s / 2, b.y - s / 2, s, s);
    c.strokeStyle = 'rgba(0,0,0,0.25)';
    c.beginPath(); c.moveTo(b.x - s / 2, b.y); c.lineTo(b.x + s / 2, b.y); c.stroke();
    c.fillStyle = '#fff'; c.font = 'bold 12px system-ui, sans-serif'; c.textAlign = 'center';
    c.fillText(b.tall ? 'TALL' : 'BOX', b.x, b.y - 6);
  }

  drawSensors(c) {
    for (const [name, sx] of Object.entries(SENSORS)) {
      const blocked = this.sensorBlocked(name);
      const tall = name === 'PE_TALL';
      const top = BELT.y0 - 16, bot = BELT.y1 + 16;
      c.strokeStyle = blocked ? 'rgba(250,204,21,0.9)' : tall ? 'rgba(192,132,252,0.7)' : 'rgba(248,113,113,0.7)';
      c.setLineDash([5, 4]);
      c.lineWidth = 2;
      c.beginPath(); c.moveTo(sx, top + 6); c.lineTo(sx, bot - 6); c.stroke();
      c.setLineDash([]);
      c.fillStyle = tall ? '#7e22ce' : '#334155';
      c.fillRect(sx - 7, top - 6, 14, 12);
      c.fillRect(sx - 7, bot - 6, 14, 12);
      c.fillStyle = blocked ? '#facc15' : '#1f2937';
      c.beginPath(); c.arc(sx, bot, 3.5, 0, Math.PI * 2); c.fill();
      c.fillStyle = blocked ? '#facc15' : '#cbd5e1';
      c.font = '11px system-ui, sans-serif'; c.textAlign = 'center';
      const ly = name === 'PE_TALL' ? bot + 50 : bot + 26;
      if (name !== 'PE_TALL') c.fillText(name, sx, ly);
      else c.fillText('', sx, ly);
    }
    // label for the height sensor placed so it doesn't overlap the pusher
    const sx = SENSORS.PE_TALL;
    c.fillStyle = this.sensorBlocked('PE_TALL') ? '#facc15' : '#d8b4fe';
    c.textAlign = 'left';
    c.fillText('PE_TALL', sx + 12, BELT.y0 - 18);
  }

  drawStackLight(c) {
    const x = W - 40;
    c.fillStyle = '#334155';
    c.fillRect(x - 3, 20, 6, 96);
    const lamps = [['LIGHT_RED', '#ef4444'], ['LIGHT_AMBER', '#f59e0b'], ['LIGHT_GREEN', '#22c55e']];
    lamps.forEach(([tag, col], i) => {
      const y = 22 + i * 24;
      const on = !!this.outputs[tag];
      c.fillStyle = on ? col : '#3f3f46';
      if (on) { c.shadowColor = col; c.shadowBlur = 18; }
      c.fillRect(x - 14, y, 28, 22);
      c.shadowBlur = 0;
      c.strokeStyle = '#111'; c.lineWidth = 1; c.strokeRect(x - 14, y, 28, 22);
    });
    c.fillStyle = '#cbd5e1'; c.font = '11px system-ui, sans-serif'; c.textAlign = 'center';
    c.fillText('STACK', x, 108);
  }
}
