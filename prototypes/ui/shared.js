// Shared fake data and helpers for the Trioditis UI prototypes.
// Everything here is invented; nothing talks to a backend.

const NETS = {
  wa: { name: 'WhatsApp', short: 'W', color: '#25D366', maturity: 'stable' },
  sg: { name: 'Signal', short: 'S', color: '#3A76F0', maturity: 'stable' },
  gm: { name: 'Google Messages', short: 'G', color: '#F4B400', maturity: 'stable', health: 'Phone offline for 12 min' },
  tg: { name: 'Telegram', short: 'T', color: '#2AABEE', maturity: 'beta' },
  fb: { name: 'Messenger', short: 'M', color: '#A334FA', maturity: 'beta' },
  ig: { name: 'Instagram', short: 'I', color: '#E1306C', maturity: 'beta' },
  dc: { name: 'Discord', short: 'D', color: '#5865F2', maturity: 'experimental' },
  ai: { name: 'Agents', short: '✦', color: '#0EA5E9', maturity: 'built-in' },
};

const LABELS = {
  Family: '#f472b6',
  Work: '#60a5fa',
  Friends: '#34d399',
};

// tab is the split-inbox bucket used by the Triage prototype.
function makeChats() {
  return [
    {
      id: 'mom', name: 'Mom', net: 'wa', alt: ['sg'], labels: ['Family'], pinned: true, unread: 2, time: '9:41', tab: 'important',
      msgs: [
        { from: 'them', text: 'Morning sweetie ☀️', t: '9:12' },
        { from: 'them', text: 'Are you coming Sunday? Dad is making ribs', t: '9:40' },
        { from: 'them', text: 'Bring the good mustard 😄', t: '9:41' },
      ],
    },
    {
      id: 'dots', name: 'Dots', net: 'ai', agent: true, unread: 1, time: '9:43', tab: 'agents',
      access: 'Draft in Family + Work · sending asks you',
      msgs: [
        { from: 'them', text: 'Good morning. 9 unread across 5 networks. Mom asked about Sunday, and Alex needs the Q4 deck before 3.', t: '9:42' },
        { kind: 'approval', t: '9:43', approval: { to: 'mom', text: "Yes! I'll be there around 2. Bringing the good mustard 😄", state: 'pending' } },
      ],
    },
    {
      id: 'crew', name: 'Climbing crew', net: 'sg', group: true, labels: ['Friends'], unread: 5, mention: true, time: '9:20', tab: 'important',
      msgs: [
        { from: 'Priya', text: 'Gym at 6 tonight?', t: '9:02' },
        { from: 'Marco', text: 'In. Forearms have finally recovered from Tuesday', t: '9:05', reactions: { '💪': 2 } },
        { from: 'Dev', text: "I'll be 15 late, start without me", t: '9:11' },
        { from: 'Priya', text: '@you booked the auto-belay wall for 6:15. Coming?', t: '9:20' },
      ],
    },
    {
      id: 'alex', name: 'Alex Rivera', net: 'gm', labels: ['Work'], unread: 1, time: '8:55', tab: 'important',
      msgs: [
        { from: 'me', text: 'Sending the deck over shortly', t: 'Yesterday', status: 'unknown' },
        { from: 'them', text: 'Can you send the Q4 deck before 3? Leadership moved the review up.', t: '8:55' },
      ],
    },
    {
      id: 'nina', name: 'Nina Park', net: 'wa', labels: ['Work'], unread: 0, time: '8:30', tab: 'important',
      msgs: [
        { from: 'them', text: 'Contract is signed ✍️ thanks for pushing it through', t: '8:30' },
        { from: 'me', text: 'Amazing, congrats!', t: '8:31', status: 'read' },
      ],
    },
    {
      id: 'teresa', name: 'Teresa (landlord)', net: 'fb', unread: 1, time: 'Tue', tab: 'important',
      msgs: [
        { from: 'them', text: 'Plumber is coming Thursday at 10am, please leave the side gate open', t: 'Tue' },
      ],
    },
    {
      id: 'grok', name: 'Grokbot', net: 'ai', agent: true, unread: 0, time: '7:00', tab: 'agents',
      access: 'Read Discord · no drafts',
      msgs: [
        { from: 'them', text: 'Weekly digest: Design Guild had 48 messages and 2 mention you. Want a summary?', t: '7:00' },
      ],
    },
    {
      id: 'sam', name: 'Sam Okafor', net: 'tg', labels: ['Friends'], unread: 0, time: 'Tue', tab: 'other',
      msgs: [
        { from: 'them', text: 'that architecture diagram is unhinged 😂', t: 'Tue' },
        { from: 'me', text: 'it has three roads, it is literally the brand', t: 'Tue', status: 'read' },
      ],
    },
    {
      id: 'dad', name: 'Dad', net: 'sg', labels: ['Family'], unread: 0, time: 'Mon', tab: 'other',
      msgs: [
        { from: 'them', text: '📷 Photo', t: 'Mon', media: true },
        { from: 'them', text: 'New smoker arrived. Sunday is going to be legendary', t: 'Mon' },
      ],
    },
    {
      id: 'guild', name: 'Design Guild', net: 'dc', group: true, labels: ['Work'], muted: true, unread: 48, time: 'Mon', tab: 'other',
      msgs: [
        { from: 'Lena', text: 'New tokens are up in #critique, roast them', t: 'Mon' },
        { from: 'Omar', text: 'the 13px body size is a crime', t: 'Mon' },
      ],
    },
    {
      id: 'jordan', name: 'Jordan Lee', net: 'ig', request: true, unread: 1, time: 'Sun', tab: 'other',
      msgs: [
        { from: 'them', text: 'hey! saw your homelab post, can I ask about the setup?', t: 'Sun' },
      ],
    },
    {
      id: 'spam', name: '+1 (555) 014-2290', net: 'gm', request: true, unread: 1, time: 'Sun', tab: 'other',
      msgs: [
        { from: 'them', text: 'Your package is held at the depot. Confirm delivery here: bit.ly/…', t: 'Sun' },
      ],
    },
  ];
}

// What "Draft with Dots" produces per chat.
const DRAFTS = {
  mom: "Yes! I'll be there around 2. Bringing the good mustard 😄",
  crew: "I'm in for 6:15, thanks for booking Priya 🙌",
  alex: 'On it, you will have the Q4 deck by 1pm.',
  nina: 'Drinks on me next week to celebrate?',
  teresa: "Thanks Teresa, I'll leave the side gate open Thursday.",
  sam: 'okay fair, v2 will have fewer arrows',
  dad: 'That thing is huge. Save me a rib',
  jordan: "Hey! Happy to, what are you curious about?",
};

const ICONS = {
  check: '<path d="M5 12l5 5L20 7"/>',
  checks: '<path d="M2 12.5l4.5 4.5L16 7.5"/><path d="M12 16.5l.5.5L22 7.5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  alert: '<circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/>',
  snooze: '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2M5 3L2 6M19 3l3 3"/>',
  done: '<circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.5 2.5L16 9.5"/>',
  tag: '<path d="M3 12V4h8l10 10-8 8z"/><circle cx="7.5" cy="7.5" r="1.3"/>',
  mute: '<path d="M8.5 4.2A6 6 0 0 1 18 9c0 2.6.6 4.6 1.3 6M6 9c0 6-3 8-3 8h14M3 3l18 18M10 21a2 2 0 0 0 4 0"/>',
  bell: '<path d="M6 9a6 6 0 0 1 12 0c0 6 3 8 3 8H3s3-2 3-8M10 21a2 2 0 0 0 4 0"/>',
  sparkle: '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M19 16l.7 1.8 1.8.7-1.8.7L19 21l-.7-1.8-1.8-.7 1.8-.7z"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
  send: '<path d="M4 12L20 4l-5 16-3-7z"/><path d="M12 13l8-9"/>',
  attach: '<path d="M21 11.5l-8.6 8.6a5 5 0 0 1-7.1-7.1L14 4.3a3.5 3.5 0 0 1 5 5l-8.6 8.6a2 2 0 0 1-2.9-2.9L15.4 7.4"/>',
  smile: '<circle cx="12" cy="12" r="9"/><path d="M8 14s1.5 2 4 2 4-2 4-2M9 9.5h.01M15 9.5h.01"/>',
  reply: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 6 6v4"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  pin: '<path d="M12 16v6M8.5 3h7l-1 6 3.5 4H6l3.5-4z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  more: '<circle cx="5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="19" cy="12" r="1.2"/>',
  inbox: '<path d="M3 13h5l2 3h4l2-3h5"/><path d="M5.5 5h13L21 13v6H3v-6z"/>',
  at: '<circle cx="12" cy="12" r="4"/><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  down: '<path d="M6 9l6 6 6-6"/>',
  sliders: '<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>',
  pencil: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
  archive: '<rect x="3" y="4" width="18" height="5" rx="1"/><path d="M5 9v10h14V9M10 13h4"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  bolt: '<path d="M13 2L4 14h7l-1 8 9-12h-7z"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  filter: '<path d="M3 5h18l-7 8.5V19l-4 2v-7.5z"/>',
  gear: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
  undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>',
};

function icon(name, size = 16) {
  return `<svg class="i" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function initials(name) {
  const words = name.replace(/[^\p{L}\p{N} ]/gu, '').trim().split(/\s+/);
  if (!words[0]) return '#';
  return (words[0][0] + (words[1] ? words[1][0] : '')).toUpperCase();
}

function hue(name) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.codePointAt(0)) % 360;
  return h;
}

// Avatar with the network badge in the corner.
function avatar(chat, size = 36, badge = true) {
  const net = NETS[chat.net];
  const inner = chat.agent
    ? `<span class="av-agent">${icon('sparkle', Math.round(size * 0.5))}</span>`
    : esc(initials(chat.name));
  const bg = chat.agent ? 'linear-gradient(135deg,#38bdf8,#6366f1)' : `hsl(${hue(chat.name)} 45% 42%)`;
  const b = badge && !chat.agent ? `<span class="netb" style="background:${net.color}" title="${net.name}">${net.short}</span>` : '';
  return `<span class="av${chat.group ? ' grp' : ''}" style="width:${size}px;height:${size}px;font-size:${Math.round(size * 0.38)}px;background:${bg}">${inner}${b}</span>`;
}

function netBadge(key, size = 14) {
  const n = NETS[key];
  return `<span class="netb inline" style="background:${n.color};width:${size}px;height:${size}px;font-size:${Math.round(size * 0.62)}px">${n.short}</span>`;
}

function lastMsg(chat) {
  for (let i = chat.msgs.length - 1; i >= 0; i--) {
    if (chat.msgs[i].text) return chat.msgs[i];
  }
  return chat.msgs[chat.msgs.length - 1];
}

function preview(chat) {
  const sent = chat.msgs.filter((x) => x.status !== 'scheduled');
  const m = sent[sent.length - 1];
  if (m.kind === 'approval') {
    return m.approval.state === 'pending' ? 'Needs your approval: reply to Mom' : lastMsg(chat).text;
  }
  const who = m.from === 'me' ? 'You: ' : chat.group ? `${m.from}: ` : '';
  return who + m.text;
}

function nowTime() {
  return new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).replace(/\s?[AP]M$/i, '');
}

// The delivery states from the plan's outbound design.
function statusHTML(status) {
  switch (status) {
    case 'sending': return `<span class="st sending" title="Sending">${icon('clock', 12)}</span>`;
    case 'sent': return `<span class="st sent" title="Sent">${icon('check', 12)}</span>`;
    case 'delivered': return `<span class="st delivered" title="Delivered">${icon('checks', 13)}</span>`;
    case 'read': return `<span class="st read" title="Read">${icon('checks', 13)}</span>`;
    case 'unknown': return `<span class="st unknown" title="The network didn't confirm this message">${icon('alert', 12)} Delivery unknown</span>`;
    case 'scheduled': return `<span class="st sched">${icon('clock', 12)} Scheduled</span>`;
    case 'checking': return `<span class="st unknown" title="Asking the network about this message. Nothing is resent.">${icon('clock', 12)} Delivery unknown · checking…</span>`;
    default: return '';
  }
}

// Walks a message through sending → sent → delivered and calls back after each step.
function simulateSend(msg, onUpdate) {
  msg.status = 'sending';
  setTimeout(() => { msg.status = 'sent'; onUpdate(); }, 700);
  setTimeout(() => { msg.status = 'delivered'; onUpdate(); }, 1700);
}

// Scales a fixed-size stage to fit its container so the prototype reads the same at any width.
function fitStage(wrap, stage, w, h) {
  const fit = () => {
    const s = Math.min(1, wrap.clientWidth / w);
    stage.style.transform = `scale(${s})`;
    wrap.style.height = `${Math.round(h * s)}px`;
  };
  new ResizeObserver(fit).observe(wrap);
  fit();
}

// Text the person types lives in state (chat.draft, approval.edit), so re-renders keep it.
// These two put focus and the caret back after a re-render replaces the field.
function captureFocus() {
  const el = document.activeElement;
  if (!el || !el.id || !(el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return null;
  return { id: el.id, start: el.selectionStart, end: el.selectionEnd };
}
function restoreFocus(f) {
  const el = f && document.getElementById(f.id);
  if (!el || document.activeElement === el) return;
  el.focus({ preventScroll: true });
  el.setSelectionRange(f.start, f.end);
}

// Dots's grant in prototypes A and C: it may draft in Family and Work chats.
function dotsCanDraft(chat) {
  return !chat.agent && (chat.labels || []).some((l) => l === 'Family' || l === 'Work');
}

// When Dots loses access to a chat, its pending approvals for that chat are discarded.
function revokeApprovals(chats, toId) {
  let n = 0;
  for (const c of chats) {
    for (const m of c.msgs) {
      if (m.kind === 'approval' && m.approval.to === toId && ['pending', 'editing'].includes(m.approval.state)) {
        m.approval.state = 'revoked';
        n++;
      }
    }
  }
  return n;
}

function isTyping(e) {
  const t = e.target;
  return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
}
