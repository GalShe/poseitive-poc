// voice.js — משוב קולי בעברית באמצעות מנוע הדיבור של המכשיר (Web Speech API).
// באייפון יש קול עברי מובנה; באנדרואיד בדרך כלל דרך שירותי הדיבור של גוגל.
// אם אין קול עברי במכשיר, נופלים לצפצופים בלבד ומציגים הודעה.

const HEB_NUMBERS = ['', 'אחת', 'שתיים', 'שלוש', 'ארבע', 'חמש', 'שש', 'שבע', 'שמונה', 'תשע', 'עשר',
  'אחת עשרה', 'שתים עשרה', 'שלוש עשרה', 'ארבע עשרה', 'חמש עשרה', 'שש עשרה', 'שבע עשרה', 'שמונה עשרה', 'תשע עשרה', 'עשרים'];

export class Voice {
  constructor() {
    this.enabled = true;
    this.voice = null;
    this.lastSaid = {};          // מתי נאמר כל משפט לאחרונה (למניעת חזרות)
    this.busyUntil = 0;
    this.audioCtx = null;
    this.supported = 'speechSynthesis' in window;
    if (this.supported) {
      const pick = () => {
        const vs = speechSynthesis.getVoices();
        this.voice = vs.find((v) => /^he|^iw/i.test(v.lang)) || null;
      };
      pick();
      speechSynthesis.addEventListener?.('voiceschanged', pick);
    }
  }

  get hasHebrew() { return !!this.voice; }

  // חייב להיקרא מתוך לחיצה של המשתמש (דרישה של iOS להפעלת שמע ודיבור)
  unlock() {
    try {
      this.audioCtx ??= new (window.AudioContext || window.webkitAudioContext)();
      this.audioCtx.resume?.();
    } catch { /* אין אודיו */ }
    if (this.supported) {
      try {
        const u = new SpeechSynthesisUtterance(' ');
        u.volume = 0;
        speechSynthesis.speak(u);
      } catch { /* ignore */ }
    }
  }

  beep(freq = 880, ms = 140) {
    if (!this.enabled || !this.audioCtx) return;
    try {
      const o = this.audioCtx.createOscillator(), g = this.audioCtx.createGain();
      o.frequency.value = freq; g.gain.value = 0.08;
      o.connect(g); g.connect(this.audioCtx.destination);
      o.start(); o.stop(this.audioCtx.currentTime + ms / 1000);
    } catch { /* ignore */ }
  }

  // priority: הודעה חשובה קוטעת הודעה פחות חשובה. cooldownMs: לא לחזור על אותו משפט מהר מדי
  say(text, { priority = 1, cooldownMs = 3000 } = {}) {
    if (!this.enabled || !text) return false;
    const now = performance.now();
    if (now - (this.lastSaid[text] ?? -Infinity) < cooldownMs) return false;
    if (!this.supported || !this.voice) { this.beep(priority > 1 ? 330 : 880, 200); return false; }
    if (speechSynthesis.speaking && now < this.busyUntil && priority < 2) return false;
    try {
      if (priority >= 2) speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.voice = this.voice; u.lang = this.voice.lang; u.rate = 1.05;
      speechSynthesis.speak(u);
      this.lastSaid[text] = now;
      this.busyUntil = now + 250 + text.length * 70;   // הערכה גסה של משך הדיבור
      return true;
    } catch { return false; }
  }

  count(n) { return this.say(HEB_NUMBERS[n] ?? String(n), { priority: 1, cooldownMs: 0 }); }
}
