import { PlaceSearch } from './search';
import { dateOf, daysInYear } from './sun';
import { $, el } from './util';

const hhmm = (h: number) => { const m = Math.round(h * 60) % 1440, H = Math.floor(m / 60); return `${(H + 11) % 12 + 1}:${String(m % 60).padStart(2, '0')} ${H < 12 ? 'am' : 'pm'}`; };
const dayMonth = (d: number) => dateOf(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

interface SliderSpec {
  min: number;
  max: number;
  step: number;
  marks: Record<string, number>;
  near: number;
  show: (v: number) => string;
  onInput: (v: number) => void;
}

class Slider {
  readonly input: HTMLInputElement;
  private readonly val: HTMLElement;

  constructor(host: HTMLElement, private readonly spec: SliderSpec) {
    const { min, max, step } = spec;
    const row = el('label', 'row', `<span class="val"></span><span class="track"><input type="range" min="${min}" max="${max}" step="${step}"></span>`, host);
    this.input = $<HTMLInputElement>('input', row);
    this.val = $('.val', row);
    this.input.addEventListener('input', () => {
      const v = +this.input.value;
      this.show(v);
      spec.onInput(v);
    });
    this.input.addEventListener('keydown', (e) => { if (/^(Arrow|Page|Home|End)/.test(e.key)) e.stopPropagation(); }); // the arrows move the slider, not the camera
  }

  set(v: number) {
    this.input.value = String(v);
    this.show(v);
  }

  private show(v: number) {
    const { marks, near } = this.spec;
    const mark = Object.keys(marks).filter((k) => Math.abs(marks[k] - v) <= near).sort((a, b) => Math.abs(marks[a] - v) - Math.abs(marks[b] - v))[0];
    this.val.innerHTML = `${this.spec.show(v)}${mark ? ` <span class="mark">${mark}</span>` : ''}`;
  }

  setMarks(marks: Record<string, number>) { this.spec.marks = marks; }
}

export class Bar {
  readonly el = el('div', '');
  readonly search: PlaceSearch;
  private readonly time: Slider;
  private readonly date: Slider;

  constructor({ days, onDay, onHour }: { days: Record<string, number>; onDay: (d: number) => void; onHour: (h: number) => void }) {
    this.el.id = 'bar';
    this.search = new PlaceSearch(this.el, 'Search DTLA…');
    this.date = new Slider(this.el, { min: 1, max: daysInYear(), step: 1, marks: days, near: 3, show: dayMonth, onInput: onDay });
    this.time = new Slider(this.el, { min: 0, max: 24 - 1 / 60, step: 1 / 60, marks: {}, near: 1 / 3, show: hhmm, onInput: onHour });
  }

  setDay(d: number, times: Record<string, number>) { this.date.set(d); this.time.setMarks(times); }
  setHour(h: number) { if (document.activeElement !== this.time.input) this.time.set(h); }
  get rect() { return this.el.getBoundingClientRect(); }
}
