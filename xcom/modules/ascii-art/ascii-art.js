/**
 * ASCII Art Module
 * Simple offline ASCII art generator for packet radio messages.
 *
 * Notes:
 * - Uses a small built-in 5x7 font (A-Z, 0-9, basic punctuation).
 * - Avoids external dependencies.
 */

class AsciiArtModule {
  constructor() {
    this.init();
  }

  init() {
    this.createModuleStructure();
    this.bindEvents();
    this.render();

    if (window.radioApp) window.radioApp.updateStatus('ASCII Art module loaded');
  }

  createModuleStructure() {
    const moduleContainer = document.getElementById('ascii-art');
    moduleContainer.innerHTML = `
      <div class="ascii-art-container">
        <div class="ascii-art-header">
          <h2>ASCII Art Generator</h2>
          <p class="ascii-art-subtitle">
            Turn a short phrase into a copy/paste ASCII banner for packets, BBS posts, logs, and notes.
          </p>
        </div>

        <div class="xModuleIntro">
          <div class="xModuleIntroTitle">What you can do here</div>
          <div class="xModuleIntroText">
            Generate clean ASCII banners for radio/packet text, then copy the result into whatever system you're using.
            <ul class="xModuleIntroList">
              <li>Create a banner from a short phrase.</li>
              <li>Adjust scale, spacing, border, and characters to fit your link/BBS limits.</li>
              <li>Copy the output with one click.</li>
            </ul>
          </div>
        </div>

        <div class="ascii-art-controls">
          <div class="ascii-art-row">
            <label for="asciiArtText">Text</label>
            <input id="asciiArtText" type="text" maxlength="40" placeholder="CQ CQ DE VE3YLO" autocomplete="off" />
          </div>

          <div class="ascii-art-row ascii-art-grid">
            <div class="ascii-art-field">
              <label for="asciiArtScale">Scale</label>
              <select id="asciiArtScale">
                <option value="1" selected>1x</option>
                <option value="2">2x</option>
                <option value="3">3x</option>
              </select>
            </div>

            <div class="ascii-art-field">
              <label for="asciiArtOn">Ink char</label>
              <input id="asciiArtOn" type="text" value="#" maxlength="1" />
            </div>

            <div class="ascii-art-field">
              <label for="asciiArtOff">Background</label>
              <input id="asciiArtOff" type="text" value=" " maxlength="1" />
            </div>

            <div class="ascii-art-field">
              <label for="asciiArtSpacing">Spacing</label>
              <select id="asciiArtSpacing">
                <option value="0">0</option>
                <option value="1" selected>1</option>
                <option value="2">2</option>
              </select>
            </div>

            <div class="ascii-art-field">
              <label for="asciiArtBorder">Border</label>
              <select id="asciiArtBorder">
                <option value="none" selected>None</option>
                <option value="box">Box</option>
                <option value="line">Line (top/bottom)</option>
              </select>
            </div>
          </div>

          <div class="ascii-art-actions">
            <button id="asciiArtGenerateBtn" type="button">Generate</button>
            <button id="asciiArtCopyBtn" type="button">Copy</button>
            <button id="asciiArtClearBtn" type="button" class="secondary">Clear</button>
          </div>

          <div class="ascii-art-hint">
            Tip: keep line lengths reasonable for your BBS/node. You can also change the ink character to <code>*</code> or <code>@</code>.
          </div>
        </div>

        <div class="ascii-art-output">
          <div class="ascii-art-output-header">
            <h3>Output</h3>
            <div class="ascii-art-meta" id="asciiArtMeta">—</div>
          </div>
          <textarea id="asciiArtOutput" spellcheck="false" wrap="off" readonly></textarea>
        </div>
      </div>
    `;

    this.textEl = moduleContainer.querySelector('#asciiArtText');
    this.scaleEl = moduleContainer.querySelector('#asciiArtScale');
    this.onEl = moduleContainer.querySelector('#asciiArtOn');
    this.offEl = moduleContainer.querySelector('#asciiArtOff');
    this.spacingEl = moduleContainer.querySelector('#asciiArtSpacing');
    this.borderEl = moduleContainer.querySelector('#asciiArtBorder');
    this.generateBtn = moduleContainer.querySelector('#asciiArtGenerateBtn');
    this.copyBtn = moduleContainer.querySelector('#asciiArtCopyBtn');
    this.clearBtn = moduleContainer.querySelector('#asciiArtClearBtn');
    this.outputEl = moduleContainer.querySelector('#asciiArtOutput');
    this.metaEl = moduleContainer.querySelector('#asciiArtMeta');
  }

  bindEvents() {
    const rerender = () => this.render();
    this.generateBtn.addEventListener('click', rerender);

    // Live updates while typing (nice UX, still lightweight)
    this.textEl.addEventListener('input', rerender);
    this.scaleEl.addEventListener('change', rerender);
    this.onEl.addEventListener('input', rerender);
    this.offEl.addEventListener('input', rerender);
    this.spacingEl.addEventListener('change', rerender);
    this.borderEl.addEventListener('change', rerender);

    this.textEl.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.render();
      }
    });

    this.copyBtn.addEventListener('click', () => this.copyOutput());
    this.clearBtn.addEventListener('click', () => this.clear());
  }

  clear() {
    this.textEl.value = '';
    this.outputEl.value = '';
    this.metaEl.textContent = '—';
    if (window.radioApp) window.radioApp.updateStatus('ASCII Art cleared');
    this.textEl.focus();
  }

  normalizeCharInput(value, fallback) {
    const raw = (value ?? '').toString();
    if (!raw) return fallback;
    return raw[0];
  }

  render() {
    const textRaw = (this.textEl.value || '').toUpperCase();
    const text = textRaw.trim();
    const scale = Math.max(1, Math.min(3, parseInt(this.scaleEl.value, 10) || 1));
    const onChar = this.normalizeCharInput(this.onEl.value, '#');
    const offChar = this.normalizeCharInput(this.offEl.value, ' ');
    const spacing = Math.max(0, Math.min(4, parseInt(this.spacingEl.value, 10) || 0));
    const border = (this.borderEl.value || 'none');

    if (!text) {
      this.outputEl.value = '';
      this.metaEl.textContent = '—';
      return;
    }

    const lines = this.renderTextToLines(text, { scale, onChar, offChar, spacing });
    const bordered = this.applyBorder(lines, { border, offChar });
    const out = bordered.join('\n');

    this.outputEl.value = out;
    this.metaEl.textContent = `${bordered.length} lines, max width ${this.maxWidth(bordered)} chars`;
  }

  // Public helper for testing/automation
  setTextAndRender(text) {
    this.textEl.value = (text ?? '').toString();
    this.render();
    return this.outputEl.value;
  }

  maxWidth(lines) {
    return (lines || []).reduce((m, l) => Math.max(m, (l || '').length), 0);
  }

  applyBorder(lines, { border, offChar }) {
    const content = Array.isArray(lines) ? lines : [];
    if (content.length === 0) return [];

    const width = this.maxWidth(content);
    const padToWidth = (s) => s + offChar.repeat(Math.max(0, width - (s || '').length));

    if (border === 'none') {
      return content.map(padToWidth);
    }

    if (border === 'line') {
      const hr = '-'.repeat(width);
      return [hr, ...content.map(padToWidth), hr];
    }

    // box
    const top = `+${'-'.repeat(width + 2)}+`;
    const bottom = top;
    const boxed = content.map((l) => `| ${padToWidth(l)} |`);
    return [top, ...boxed, bottom];
  }

  renderTextToLines(text, { scale, onChar, offChar, spacing }) {
    const glyphHeight = 7;
    const out = Array.from({ length: glyphHeight * scale }, () => '');
    const spacer = offChar.repeat(spacing);

    for (const ch of text) {
      const glyph = this.getGlyph(ch);
      for (let row = 0; row < glyphHeight; row++) {
        const patternRow = glyph[row] || '00000';
        const renderedRow = this.renderRow(patternRow, { scale, onChar, offChar });
        for (let sy = 0; sy < scale; sy++) {
          const outRowIndex = row * scale + sy;
          out[outRowIndex] += renderedRow + spacer;
        }
      }
    }

    // Trim trailing spacer on each line
    return out.map((l) => l.replace(new RegExp(`${this.escapeRegExp(offChar)}{0,}$`), '').replace(/\s+$/, ''));
  }

  renderRow(bits, { scale, onChar, offChar }) {
    // bits is 5 chars string '0'/'1'
    let s = '';
    for (const b of bits) {
      const c = b === '1' ? onChar : offChar;
      s += c.repeat(scale);
    }
    return s;
  }

  escapeRegExp(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  getGlyph(ch) {
    const font = AsciiArtModule.FONT_5X7;
    if (font[ch]) return font[ch];
    if (ch === ' ') return font[' '];
    return font['?'];
  }

  async copyOutput() {
    const text = this.outputEl.value || '';
    if (!text.trim()) {
      alert('Nothing to copy yet.');
      return;
    }

    try {
      await navigator.clipboard.writeText(text);
      if (window.radioApp) window.radioApp.updateStatus('ASCII Art copied to clipboard');
    } catch (err) {
      // Fallback for environments where clipboard API is blocked
      try {
        this.outputEl.focus();
        this.outputEl.select();
        const ok = document.execCommand('copy');
        if (!ok) throw new Error('execCommand copy returned false');
        if (window.radioApp) window.radioApp.updateStatus('ASCII Art copied to clipboard');
      } catch (err2) {
        console.warn('Clipboard copy failed', err, err2);
        alert('Copy failed. You can manually select the output and copy it.');
      }
    }
  }
}

// A tiny 5x7 font. Each character is 7 strings of 5 bits.
// Designed for legibility, not perfection.
AsciiArtModule.FONT_5X7 = {
  ' ': [
    '00000',
    '00000',
    '00000',
    '00000',
    '00000',
    '00000',
    '00000'
  ],
  '?': [
    '01110',
    '10001',
    '00010',
    '00100',
    '00100',
    '00000',
    '00100'
  ],
  '!': [
    '00100',
    '00100',
    '00100',
    '00100',
    '00100',
    '00000',
    '00100'
  ],
  '.': [
    '00000',
    '00000',
    '00000',
    '00000',
    '00000',
    '00110',
    '00110'
  ],
  ':': [
    '00000',
    '00110',
    '00110',
    '00000',
    '00110',
    '00110',
    '00000'
  ],
  '-': [
    '00000',
    '00000',
    '00000',
    '01110',
    '00000',
    '00000',
    '00000'
  ],
  '/': [
    '00001',
    '00010',
    '00100',
    '01000',
    '10000',
    '00000',
    '00000'
  ],
  '+': [
    '00000',
    '00100',
    '00100',
    '11111',
    '00100',
    '00100',
    '00000'
  ],
  '=': [
    '00000',
    '00000',
    '11111',
    '00000',
    '11111',
    '00000',
    '00000'
  ],
  '_': [
    '00000',
    '00000',
    '00000',
    '00000',
    '00000',
    '00000',
    '11111'
  ],
  '0': [
    '01110',
    '10001',
    '10011',
    '10101',
    '11001',
    '10001',
    '01110'
  ],
  '1': [
    '00100',
    '01100',
    '00100',
    '00100',
    '00100',
    '00100',
    '01110'
  ],
  '2': [
    '01110',
    '10001',
    '00001',
    '00010',
    '00100',
    '01000',
    '11111'
  ],
  '3': [
    '11110',
    '00001',
    '00001',
    '01110',
    '00001',
    '00001',
    '11110'
  ],
  '4': [
    '00010',
    '00110',
    '01010',
    '10010',
    '11111',
    '00010',
    '00010'
  ],
  '5': [
    '11111',
    '10000',
    '11110',
    '00001',
    '00001',
    '10001',
    '01110'
  ],
  '6': [
    '00110',
    '01000',
    '10000',
    '11110',
    '10001',
    '10001',
    '01110'
  ],
  '7': [
    '11111',
    '00001',
    '00010',
    '00100',
    '01000',
    '01000',
    '01000'
  ],
  '8': [
    '01110',
    '10001',
    '10001',
    '01110',
    '10001',
    '10001',
    '01110'
  ],
  '9': [
    '01110',
    '10001',
    '10001',
    '01111',
    '00001',
    '00010',
    '01100'
  ],
  'A': [
    '01110',
    '10001',
    '10001',
    '11111',
    '10001',
    '10001',
    '10001'
  ],
  'B': [
    '11110',
    '10001',
    '10001',
    '11110',
    '10001',
    '10001',
    '11110'
  ],
  'C': [
    '01110',
    '10001',
    '10000',
    '10000',
    '10000',
    '10001',
    '01110'
  ],
  'D': [
    '11110',
    '10001',
    '10001',
    '10001',
    '10001',
    '10001',
    '11110'
  ],
  'E': [
    '11111',
    '10000',
    '10000',
    '11110',
    '10000',
    '10000',
    '11111'
  ],
  'F': [
    '11111',
    '10000',
    '10000',
    '11110',
    '10000',
    '10000',
    '10000'
  ],
  'G': [
    '01110',
    '10001',
    '10000',
    '10111',
    '10001',
    '10001',
    '01110'
  ],
  'H': [
    '10001',
    '10001',
    '10001',
    '11111',
    '10001',
    '10001',
    '10001'
  ],
  'I': [
    '01110',
    '00100',
    '00100',
    '00100',
    '00100',
    '00100',
    '01110'
  ],
  'J': [
    '00111',
    '00010',
    '00010',
    '00010',
    '10010',
    '10010',
    '01100'
  ],
  'K': [
    '10001',
    '10010',
    '10100',
    '11000',
    '10100',
    '10010',
    '10001'
  ],
  'L': [
    '10000',
    '10000',
    '10000',
    '10000',
    '10000',
    '10000',
    '11111'
  ],
  'M': [
    '10001',
    '11011',
    '10101',
    '10101',
    '10001',
    '10001',
    '10001'
  ],
  'N': [
    '10001',
    '11001',
    '10101',
    '10011',
    '10001',
    '10001',
    '10001'
  ],
  'O': [
    '01110',
    '10001',
    '10001',
    '10001',
    '10001',
    '10001',
    '01110'
  ],
  'P': [
    '11110',
    '10001',
    '10001',
    '11110',
    '10000',
    '10000',
    '10000'
  ],
  'Q': [
    '01110',
    '10001',
    '10001',
    '10001',
    '10101',
    '10010',
    '01101'
  ],
  'R': [
    '11110',
    '10001',
    '10001',
    '11110',
    '10100',
    '10010',
    '10001'
  ],
  'S': [
    '01111',
    '10000',
    '10000',
    '01110',
    '00001',
    '00001',
    '11110'
  ],
  'T': [
    '11111',
    '00100',
    '00100',
    '00100',
    '00100',
    '00100',
    '00100'
  ],
  'U': [
    '10001',
    '10001',
    '10001',
    '10001',
    '10001',
    '10001',
    '01110'
  ],
  'V': [
    '10001',
    '10001',
    '10001',
    '10001',
    '10001',
    '01010',
    '00100'
  ],
  'W': [
    '10001',
    '10001',
    '10001',
    '10101',
    '10101',
    '10101',
    '01010'
  ],
  'X': [
    '10001',
    '10001',
    '01010',
    '00100',
    '01010',
    '10001',
    '10001'
  ],
  'Y': [
    '10001',
    '10001',
    '01010',
    '00100',
    '00100',
    '00100',
    '00100'
  ],
  'Z': [
    '11111',
    '00001',
    '00010',
    '00100',
    '01000',
    '10000',
    '11111'
  ]
};
