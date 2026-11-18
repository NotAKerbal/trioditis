// Shared engine for the Crossroads (B) iterations: chat list rows, chat pane, details panel,
// approvals, drafts and menus. Each variant page owns the navigation. Before loading this file
// it defines NAV = { render() {...}, menus: { name: (anchor) => html } } and provides #q, #rows,
// #chat, #det, #menu, #viamenu and #toast in its markup. Optional NAV hooks:
// base(chat) replaces the view test, rows(list) renders the list, click(event) handles clicks
// first (return true to stop), shown(list) returns the chats actually on screen in order (when
// rows() hides some, e.g. in collapsed sections), and schedule: true adds scheduled sending.

const chats = makeChats();
const $ = (id) => document.getElementById(id);
const stage = $('stage');
fitStage($('wrap'), stage, 1280, 800);

chats.forEach((c) => {
  c.via = c.net;
  c.notify = c.muted ? 'off' : c.group ? 'mentions' : 'all';
  c.agentAccess = c.labels && (c.labels.includes('Family') || c.labels.includes('Work')) ? 'draft' : 'none';
  c.mine = {};
});

const VIEWS = [
  { id: 'inbox', name: 'Inbox', ic: 'inbox', test: (c) => !c.archived && !c.request },
  // Opening a chat clears its unread count and mention; it stays in these views until another chat opens.
  { id: 'unread', name: 'Unread', ic: 'eye', test: (c) => !c.archived && !c.request && ((c.unread > 0 && !c.muted) || (c.id === sel && c.wasUnread)) },
  { id: 'mentions', name: 'Mentions', ic: 'at', test: (c) => c.mention || (c.id === sel && c.wasMention) },
  { id: 'pinned', name: 'Pinned', ic: 'pin', test: (c) => c.pinned },
  { id: 'requests', name: 'Requests', ic: 'user', test: (c) => c.request },
  { id: 'agents', name: 'Agents', ic: 'sparkle', test: (c) => c.agent },
  { id: 'archived', name: 'Archived', ic: 'archive', test: (c) => c.archived },
];
const NET_KEYS = Object.keys(NETS).filter((k) => k !== 'ai');

// One view plus optional network and label refinements, all combined.
const filt = { view: 'inbox', net: null, label: null };
let sel = null;
let detOpen = true;
let replyTo = null;
let healthDismissed = false;

const byId = (id) => chats.find((c) => c.id === id);
const current = () => byId(sel);
const viewOf = (id) => VIEWS.find((v) => v.id === id);

function matches(c) {
  return (NAV.base ? NAV.base(c) : viewOf(filt.view).test(c)) && (!filt.net || c.net === filt.net) && (!filt.label || (c.labels || []).includes(filt.label));
}
function visible() {
  const q = ($('q')?.value || '').trim().toLowerCase();
  return chats
    .filter(matches)
    .filter((c) => !q || c.name.toLowerCase().includes(q) || c.msgs.some((m) => (m.text || '').toLowerCase().includes(q)))
    .sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));
}

const unreadCount = (test) => chats.filter((c) => test(c) && c.unread && !c.muted).length;
function viewCount(v) {
  if (v.id === 'requests') return chats.filter(v.test).length;
  if (v.id === 'archived') return 0;
  return unreadCount(v.test);
}
const netCount = (k) => unreadCount((c) => c.net === k && !c.archived && !c.request);
const labelCount = (l) => unreadCount((c) => (c.labels || []).includes(l) && !c.archived);
const maturityTag = (k) => NETS[k].maturity === 'beta' ? '<span class="mat">beta</span>' : NETS[k].maturity === 'experimental' ? '<span class="mat">exp</span>' : '';
const unhealthy = () => NET_KEYS.filter((k) => NETS[k].health);

// Removable chips for the network and label refinements currently applied.
function activeFiltersHTML() {
  const chips = [];
  if (filt.net) chips.push(`<button class="fchip" data-clear="net" title="Remove filter">${netBadge(filt.net, 14)} ${NETS[filt.net].name} ${icon('x', 12)}</button>`);
  if (filt.label) chips.push(`<button class="fchip" data-clear="label" title="Remove filter"><span class="lbdot" style="background:${LABELS[filt.label]}"></span>${filt.label} ${icon('x', 12)}</button>`);
  return chips.length ? `<div class="fchips">${chips.join('')}</div>` : '';
}

function healthBannerHTML() {
  const bad = unhealthy();
  if (healthDismissed || !bad.length) return '';
  return `<div class="banner">${icon('alert', 15)}<span><b>${NETS[bad[0]].name}:</b> ${NETS[bad[0]].health.toLowerCase()}. New texts arrive when it's back.</span><button data-act="dismiss-health" title="Dismiss">${icon('x', 14)}</button></div>`;
}

function rowHTML(c) {
  const pending = c.msgs.some((m) => m.kind === 'approval' && m.approval.state === 'pending');
  return `<div class="row${c.id === sel ? ' sel' : ''}${c.unread ? '' : ' read'}" data-id="${c.id}">${avatar(c, 42)}
    <div class="mid"><div class="l1"><span class="nm">${esc(c.name)}</span>${c.pinned ? `<span class="ic">${icon('pin', 12)}</span>` : ''}${c.muted ? `<span class="ic">${icon('mute', 12)}</span>` : ''}<span class="tm">${c.time}</span></div>
    <div class="l2"><span class="pv${pending ? ' need' : ''}">${esc(preview(c))}</span>${c.mention ? '<span class="pill">@</span>' : c.unread ? `<span class="pill${c.muted ? ' muted' : ''}">${c.unread}</span>` : ''}</div></div></div>`;
}

function renderList() {
  const list = visible();
  const banner = NAV.healthBanner ? healthBannerHTML() : '';
  const filtered = filt.net || filt.label || ($('q')?.value || '').trim();
  if (NAV.rows) { $('rows').innerHTML = NAV.rows(list); return; }
  $('rows').innerHTML = banner + (list.map(rowHTML).join('')
    || `<div class="none">No chats match.${filtered ? '<br><button class="btn ghost" data-clear="all" style="margin-top:8px">Clear filters</button>' : ''}</div>`);
}

function msgHTML(c, m, i) {
  if (m.kind === 'approval') return approvalHTML(c, m, i);
  const prev = c.msgs[i - 1];
  const side = m.from === 'me' ? 'me' : 'them';
  const who = c.group && side === 'them' && (!prev || prev.from !== m.from) ? `<div class="who" style="color:hsl(${hue(m.from)} 55% 40%)">${esc(m.from)}</div>` : '';
  const quote = m.quote ? `<div class="quote">${esc(m.quote)}</div>` : '';
  const body = m.media ? `<div class="media">${icon('eye', 22)}</div>` : `<div class="bub">${quote}${esc(m.text)}</div>`;
  const rx = Object.entries(m.reactions || {}).filter(([, n]) => n > 0);
  const rxHTML = rx.length ? `<div class="rx">${rx.map(([e, n]) => `<button class="${m.mine && m.mine[e] ? 'mine' : ''}" data-react="${e}" data-i="${i}">${e} ${n}</button>`).join('')}</div>` : '';
  const hov = c.agent ? '' : `<div class="hov">${['❤️', '😂', '👍'].map((e) => `<button data-react="${e}" data-i="${i}">${e}</button>`).join('')}<button data-reply="${i}" title="Reply">${icon('reply', 15)}</button></div>`;
  const fix = m.status === 'unknown' ? `<button class="fix" data-fix="${i}">Check again</button>` : '';
  const by = m.by ? `<span class="by">${icon('sparkle', 11)} ${m.by}</span>` : '';
  if (m.status === 'scheduled') {
    return `<div class="m me sched"><div class="bub">${esc(m.text)}</div><div class="meta">${icon('clock', 12)} Sends ${esc(m.at)} on ${NETS[m.via || c.net].name}<button class="schedbtn" data-sched="now" data-i="${i}">Send now</button><button class="schedbtn" data-sched="cancel" data-i="${i}">Cancel</button></div></div>`;
  }
  return `<div class="m ${side}">${who}${body}${hov}${rxHTML}<div class="meta">${by}${m.t}${side === 'me' ? statusHTML(m.status) : ''}${fix}</div></div>`;
}

function approvalHTML(c, m, i) {
  const a = m.approval;
  const to = byId(a.to);
  const target = `<div class="to">Reply to ${avatar(to, 20, false)} <b style="color:var(--text)">${esc(to.name)}</b> on ${netBadge(to.net)} ${NETS[to.net].name}</div>`;
  if (a.state === 'sent') return `<div class="card done"><div class="h">${icon('check', 14)} APPROVED AND SENT</div>${target}<div class="q">${esc(a.text)}</div></div>`;
  if (a.state === 'rejected') return `<div class="card done"><div class="h">${icon('x', 14)} REJECTED</div>${target}</div>`;
  if (a.state === 'revoked') return `<div class="card done"><div class="h">${icon('lock', 14)} DISCARDED</div>${target}<div class="hint">${icon('info', 14)}<span>Dots no longer has draft access to ${esc(to.name)}'s chat.</span></div></div>`;
  const editing = a.state === 'editing';
  return `<div class="card"><div class="h">${icon('sparkle', 14)} DOTS WANTS TO SEND</div>${target}
    ${editing ? `<textarea id="aedit" rows="2">${esc(a.edit ?? a.text)}</textarea>` : `<div class="q">${esc(a.text)}</div>`}
    <div class="btns"><button class="btn pri" data-ap="approve" data-i="${i}">${icon('check', 15)} ${editing ? 'Send edited' : 'Approve & send'}</button>
    ${editing ? '' : `<button class="btn sec" data-ap="edit" data-i="${i}">${icon('pencil', 14)} Edit</button>`}<button class="btn ghost" data-ap="reject" data-i="${i}">Reject</button></div></div>`;
}

function renderChat() {
  const focus = captureFocus();
  const c = current();
  if (!c) { $('chat').innerHTML = `<div class="none" style="margin:auto">No chat open. Pick one from the list.</div>`; return; }
  const net = NETS[c.net];
  const sub = c.agent ? `${icon('sparkle', 12)} Agent · connected via MCP` : `${netBadge(c.net, 14)} ${net.name}${c.group ? ' · 4 members' : ''}${c.alt ? ` · also on ${c.alt.map((k) => NETS[k].name).join(', ')}` : ''}`;
  const nets = [c.net, ...(c.alt || [])];
  const via = c.agent
    ? `<span class="via static">${icon('sparkle', 12)} Agent thread</span>`
    : nets.length > 1
      ? `<button class="via" data-act="via">Send via ${netBadge(c.via, 14)} ${NETS[c.via].name} ${icon('down', 13)}</button>`
      : `<span class="via static">${netBadge(c.via, 14)} ${NETS[c.via].name}</span>`;
  const rq = replyTo != null && c.msgs[replyTo] ? `<div class="rq">${icon('reply', 14)}<span>Replying to <b>${esc(c.msgs[replyTo].from === 'me' ? 'yourself' : c.msgs[replyTo].from === 'them' ? c.name : c.msgs[replyTo].from)}</b>: ${esc(c.msgs[replyTo].text)}</span><button class="cb" style="width:22px;height:22px" data-act="unreply">${icon('x', 13)}</button></div>` : '';
  $('chat').innerHTML = `
    <div class="ch">${avatar(c, 38)}<div><div class="t">${esc(c.name)}</div><div class="s">${sub}</div></div>
      <div class="tools"><button class="hb" title="Search in chat">${icon('search', 18)}</button><button class="hb${detOpen ? ' on' : ''}" data-act="det" title="Chat settings">${icon('info', 18)}</button></div></div>
    <div class="msgs" id="msgs"><div class="day">Today</div>${c.msgs.map((m, i) => msgHTML(c, m, i)).join('')}</div>
    ${c.request ? `<div class="comp" style="padding:14px 16px;display:flex;align-items:center;gap:10px"><span style="flex:1;color:var(--dim);font-size:13px">${esc(c.name)} wants to message you on ${net.name}.</span><button class="btn sec" data-act="block">Block</button><button class="btn pri" data-act="accept">Accept</button></div>` : `
    <div class="comp">${rq}
      <div class="row1"><button class="cb" title="Attach">${icon('attach', 18)}</button>
        <textarea id="ta" placeholder="${c.agent ? `Message ${esc(c.name)}` : 'Write a message'}">${esc(c.draft || '')}</textarea>
        <button class="cb" title="Emoji">${icon('smile', 18)}</button>${NAV.schedule && !c.agent ? `<button class="cb" data-menu="schedule" title="Schedule for later">${icon('clock', 18)}</button>` : ''}<button class="cb send" data-act="send" title="Send (Enter)">${icon('send', 17)}</button></div>
      <div class="row2">${via}${c.agent || c.agentAccess !== 'draft' ? '' : `<button class="ai-link" data-act="draft">${icon('sparkle', 13)} Draft with Dots</button>`}</div>
    </div>`}`;
  const ms = $('msgs');
  ms.scrollTop = ms.scrollHeight;
  restoreFocus(focus);
}

function seg(name, value, opts) {
  return `<div class="seg">${opts.map(([v, l]) => `<button class="${value === v ? 'on' : ''}" data-seg="${name}" data-v="${v}">${l}</button>`).join('')}</div>`;
}

function renderDet() {
  const det = $('det');
  det.hidden = !detOpen;
  const c = current();
  if (!c) { det.innerHTML = ''; det.hidden = true; return; }
  if (!detOpen) return;
  const top = `<div class="top">${avatar(c, 68, false)}<div class="nm">${esc(c.name)}</div><div class="sub">${c.agent ? 'External agent' : c.group ? `Group on ${NETS[c.net].name}` : `${[c.net, ...(c.alt || [])].length} network${c.alt ? 's' : ''}`}</div>
    <div class="qa"><button class="${c.pinned ? 'on' : ''}" data-tog="pinned">${icon('pin', 17)}${c.pinned ? 'Pinned' : 'Pin'}</button><button class="${c.muted ? 'on' : ''}" data-tog="muted">${icon(c.muted ? 'mute' : 'bell', 17)}${c.muted ? 'Muted' : 'Mute'}</button><button data-tog="unread">${icon('eye', 17)}Unread</button><button class="${c.archived ? 'on' : ''}" data-tog="archived">${icon('archive', 17)}${c.archived ? 'Archived' : 'Archive'}</button></div></div>`;
  if (c.agent) {
    const scopes = c.id === 'dots'
      ? [['ok', 'Read Family and Work chats'], ['ok', 'Draft replies'], ['ok', 'Send, after you approve each one'], ['no', 'Read anything else']]
      : [['ok', 'Read Design Guild (Discord)'], ['no', 'Draft or send'], ['no', 'Read anything else']];
    det.innerHTML = `${top}
      <div class="dsec"><h4>What ${esc(c.name)} can do</h4>${scopes.map(([k, t]) => `<div class="scope"><span class="${k}">${icon(k === 'ok' ? 'check' : 'x', 15)}</span>${t}</div>`).join('')}
        <div class="hint">${icon('info', 14)}<span>Change access per chat from that chat's settings.</span></div></div>
      <div class="dsec"><h4>Activity</h4><div class="scope">${icon('eye', 15)} 14 reads today</div><div class="scope">${icon('pencil', 15)} 3 drafts · 1 waiting</div>
        <button class="btn sec" style="margin-top:10px;width:100%;justify-content:center">View audit log</button></div>
      <div class="dsec"><button class="btn sec" style="width:100%;justify-content:center;color:#dc2626">Disconnect ${esc(c.name)}</button></div>`;
    return;
  }
  const nets = [c.net, ...(c.alt || [])];
  det.innerHTML = `${top}
    ${c.group ? `<div class="dsec"><h4>Members</h4>${['You', 'Priya', 'Marco', 'Dev'].map((n) => `<div class="member">${avatar({ name: n, net: c.net }, 24, false)}${n}</div>`).join('')}</div>`
    : `<div class="dsec"><h4>Networks</h4>${nets.map((k) => `<div class="nrow">${netBadge(k, 22)}<div class="x"><div>${NETS[k].name}</div><div>${k === 'wa' ? '+1 555 010 2231' : k === 'sg' ? 'Signal username' : NETS[k].name + ' account'}</div></div>${k === c.via ? '<span class="tag">Sending</span>' : ''}</div>`).join('')}
      ${c.request ? '' : `<button class="btn ghost" style="padding:0;height:26px;margin-top:4px">${icon('plus', 14)} Link another account</button>`}</div>`}
    <div class="dsec"><h4>${icon('bell', 12)} Notify me</h4>${seg('notify', c.notify, [['all', 'Everything'], ['mentions', 'Mentions'], ['off', 'Off']])}</div>
    <div class="dsec"><h4>${icon('tag', 12)} Labels</h4><div class="lchips">${Object.keys(LABELS).map((l) => `<button class="lchip${(c.labels || []).includes(l) ? ' on' : ''}" data-lab="${l}"><i style="background:${LABELS[l]}"></i>${l}</button>`).join('')}<button class="lchip">${icon('plus', 12)}</button></div></div>
    <div class="dsec"><h4>${icon('sparkle', 12)} Dots in this chat</h4>${seg('agent', c.agentAccess, [['none', 'No access'], ['read', 'Read'], ['draft', 'Draft']])}
      <div class="hint">${icon('lock', 14)}<span>${c.agentAccess === 'none' ? "Dots can't see this chat." : c.agentAccess === 'read' ? 'Dots can read and summarize, but not write.' : 'Dots can suggest replies. Anything it sends waits for your approval.'}</span></div></div>
    <div class="sealed">${icon('lock', 14)}<span>Sealed. Messages are stored encrypted to your devices; the server can't read them.</span></div>`;
}

function render() { NAV.render(); renderList(); renderChat(); renderDet(); }
const shownIds = () => (NAV.shown ? NAV.shown(visible()) : visible()).map((c) => c.id);

// The open chat must be one the list shows. When an action (archive, snooze, block…) takes it off
// screen, open the next chat after it (from prevOrder, the list before the change), else the first
// one, else nothing. Typing a search keeps the open chat, like most chat apps.
function reconcile(prevOrder = []) {
  const shown = shownIds();
  if (sel && shown.includes(sel)) return render();
  const i = prevOrder.indexOf(sel);
  const next = (i >= 0 ? [...prevOrder.slice(i + 1), ...prevOrder.slice(0, i).reverse()] : []).find((id) => shown.includes(id)) || shown[0];
  if (next) return select(next);
  sel = null;
  replyTo = null;
  render();
}
// A view or filter change that hides the open chat closes it rather than opening another one,
// because opening a chat marks it read and nobody asked to read it.
function refreshNav() {
  if (sel && !shownIds().includes(sel)) { sel = null; replyTo = null; }
  render();
}
// After an action on a chat: move the selection only if that action took the open chat off screen.
// An open chat that was already off screen (opened from search, or in a collapsed section) stays open.
function reconcileAfter(before) {
  if (!before.includes(sel)) return render();
  reconcile(before);
}

function select(id) {
  // A chat opened while unread stays listed as unread until a different chat is opened.
  if (id !== sel) {
    chats.forEach((x) => {
      x.wasUnread = x.id === id && x.unread > 0 && !x.muted;
      x.wasMention = x.id === id && !!x.mention;
    });
  }
  sel = id;
  replyTo = null;
  const c = current();
  if (c) { if (!c.muted) c.unread = 0; c.mention = false; }
  closeVia();
  render();
}

function toast(text) {
  const t = $('toast');
  t.innerHTML = text;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, 3200);
}

function sendFrom(c, text, by, quote) {
  const m = { from: 'me', text, t: nowTime(), by, quote };
  c.msgs.push(m);
  c.time = m.t;
  c.ts = Date.now();
  simulateSend(m, () => { if (sel === c.id) renderChat(); else renderList(); });
}

function send() {
  const c = current();
  const ta = $('ta');
  if (!c || !ta || !ta.value.trim()) return;
  const q = replyTo != null ? c.msgs[replyTo].text : undefined;
  sendFrom(c, ta.value.trim(), c.draftAi ? 'drafted by Dots' : null, q);
  c.draft = '';
  c.draftAi = false;
  replyTo = null;
  if (c.via !== c.net) toast(`Sent to ${esc(c.name)} on ${NETS[c.via].name}`);
  render();
  $('ta')?.focus();
}

/* menus: a single floating panel, anchored under (or above) the control that opened it */
let menuOwner = null;
function placeAt(el, anchor, { above = false, alignRight = false } = {}) {
  const sr = stage.getBoundingClientRect();
  const s = sr.width / 1280;
  const ar = anchor.getBoundingClientRect();
  el.hidden = false;
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  let left = ((alignRight ? ar.right : ar.left) - sr.left) / s - (alignRight ? w : 0);
  left = Math.max(8, Math.min(1280 - w - 8, left));
  const below = (ar.bottom - sr.top) / s + 6;
  const over = (ar.top - sr.top) / s - h - 6;
  // Open above when asked to, or when there's no room below (menus from a bottom bar).
  let top = above || (below + h > 792 && over >= 8) ? over : below;
  top = Math.max(8, Math.min(800 - h - 8, top));
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
}
function closeMenu() { $('menu').hidden = true; menuOwner = null; }
function openMenu(name, anchor) {
  if (menuOwner === name) return closeMenu();
  const build = name === 'account' ? accountMenuHTML : name === 'schedule' ? scheduleMenuHTML : NAV.menus[name];
  $('menu').innerHTML = build(anchor);
  menuOwner = name;
  placeAt($('menu'), anchor, { alignRight: anchor.dataset.align === 'right' });
}
function accountMenuHTML() {
  return `<div class="who"><span class="meav">IC</span><div><div>Isaac</div><div>trioditis.home · 3 devices</div></div></div><div class="sep"></div>
    <button class="mi" data-act="connect">${icon('plus', 16)} Connect a network</button>
    <button class="mi" data-act="settings">${icon('sliders', 16)} Settings</button>
    <button class="mi" data-act="agents">${icon('sparkle', 16)} Agents and access</button>
    <button class="mi" data-act="devices">${icon('lock', 16)} Devices and keys</button>`;
}

const SCHEDULE_TIMES = ['later today at 6:00 PM', 'tomorrow at 9:00 AM', 'Monday at 9:00 AM'];
function scheduleMenuHTML() {
  return `<div class="mh">Send later</div>${SCHEDULE_TIMES.map((w) => `<button class="mi" data-schedule="${w}">${icon('clock', 15)} ${w[0].toUpperCase() + w.slice(1)}</button>`).join('')}
    <button class="mi" data-act="custom-time">${icon('pencil', 15)} Pick a date and time…</button>`;
}
function scheduleFrom(c, at) {
  const text = (c.draft || '').trim();
  if (!text) return toast('Write a message first, then pick when it sends');
  c.msgs.push({ from: 'me', text, t: '', status: 'scheduled', at, via: c.via });
  c.draft = '';
  c.draftAi = false;
  toast(`Scheduled for ${esc(at)}. It sends on ${NETS[c.via].name}.`);
  render();
}

function closeVia() { $('viamenu').hidden = true; }
function openVia(btn) {
  const c = current();
  const m = $('viamenu');
  m.innerHTML = `<div class="h">Send ${esc(c.name)} messages via</div>${[c.net, ...(c.alt || [])].map((k) => `<button data-via="${k}">${netBadge(k, 18)} ${NETS[k].name}${k === c.via ? `<span class="ck">${icon('check', 15)}</span>` : ''}</button>`).join('')}`;
  placeAt(m, btn, { above: true });
}

stage.addEventListener('click', (e) => {
  const t = e.target.closest('[data-menu],[data-view],[data-net],[data-label],[data-clear],[data-id],[data-act],[data-react],[data-reply],[data-ap],[data-seg],[data-lab],[data-tog],[data-via],[data-fix]');
  if (!e.target.closest('#viamenu,[data-act="via"]')) closeVia();
  if (!e.target.closest('#menu,[data-menu]')) closeMenu();
  if (NAV.click && NAV.click(e)) return;
  const sch = e.target.closest('[data-schedule],[data-sched]');
  if (sch) {
    const c = current();
    closeMenu();
    if (sch.dataset.schedule) return scheduleFrom(c, sch.dataset.schedule);
    const i = +sch.dataset.i;
    const m = c.msgs[i];
    c.msgs.splice(i, 1);
    if (sch.dataset.sched === 'cancel') {
      const kept = (c.draft || '').trim();
      c.draft = kept ? `${c.draft}\n${m.text}` : m.text;
      toast(kept ? 'Canceled. The message was added below your draft.' : 'Canceled. The message is back in the composer.');
      return render();
    }
    sendFrom(c, m.text, null);
    if ((m.via || c.net) !== c.net) toast(`Sent on ${NETS[m.via].name}`);
    return render();
  }
  if (!t) return;
  const c = current();
  const d = t.dataset;
  if (d.menu) return openMenu(d.menu, t);
  if (d.view) { filt.view = d.view; closeMenu(); return refreshNav(); }
  if (d.net) { filt.net = filt.net === d.net ? null : d.net; closeMenu(); return refreshNav(); }
  if (d.label) { filt.label = filt.label === d.label ? null : d.label; closeMenu(); return refreshNav(); }
  if (d.clear) {
    if (d.clear !== 'label') filt.net = null;
    if (d.clear !== 'net') filt.label = null;
    if (d.clear === 'all' && $('q')) $('q').value = '';
    return refreshNav();
  }
  if (d.id) return select(d.id);
  if (d.react) {
    const m = c.msgs[+d.i];
    m.reactions = m.reactions || {};
    m.mine = m.mine || {};
    m.mine[d.react] = !m.mine[d.react];
    m.reactions[d.react] = (m.reactions[d.react] || 0) + (m.mine[d.react] ? 1 : -1);
    return renderChat();
  }
  if (d.reply) { replyTo = +d.reply; renderChat(); return $('ta')?.focus(); }
  if (d.fix) {
    const m = c.msgs[+d.fix];
    m.status = 'checking';
    renderChat();
    setTimeout(() => { m.status = 'delivered'; renderChat(); toast('Confirmed delivered. No resend needed.'); }, 1100);
    return;
  }
  if (d.ap) {
    const a = c.msgs[+d.i].approval;
    if (d.ap === 'edit') { a.state = 'editing'; renderChat(); return $('aedit').focus(); }
    if (d.ap === 'reject') { a.state = 'rejected'; return render(); }
    const to = byId(a.to);
    if (to.agentAccess !== 'draft') { a.state = 'revoked'; toast(`Discarded. Dots no longer has access to ${esc(to.name)}`); return render(); }
    if (a.state === 'editing') {
      const text = (a.edit ?? a.text).trim();
      if (!text) { toast('The message is empty. Write something, or reject the draft.'); return $('aedit').focus(); }
      a.text = text;
    }
    a.state = 'sent';
    c.unread = 0;
    sendFrom(to, a.text, 'sent by Dots');
    toast(`Sent to ${esc(to.name)} on ${NETS[to.net].name}`);
    return render();
  }
  if (d.seg === 'notify') { c.notify = d.v; c.muted = d.v === 'off'; return render(); }
  if (d.seg === 'agent') {
    c.agentAccess = d.v;
    if (d.v !== 'draft' && revokeApprovals(chats, c.id)) toast(`Dots's pending draft for ${esc(c.name)} was discarded`);
    return render();
  }
  if (d.lab) { c.labels = c.labels || []; c.labels = c.labels.includes(d.lab) ? c.labels.filter((x) => x !== d.lab) : [...c.labels, d.lab]; return render(); }
  if (d.tog) {
    const before = shownIds();
    if (d.tog === 'unread') { c.unread = c.unread || 1; toast('Marked unread'); return reconcileAfter(before); }
    c[d.tog] = !c[d.tog];
    if (d.tog === 'muted') c.notify = c.muted ? 'off' : c.group ? 'mentions' : 'all';
    if (d.tog === 'archived') toast(c.archived ? `Archived ${esc(c.name)}` : `Moved ${esc(c.name)} back to the inbox`);
    return reconcileAfter(before);
  }
  if (d.via) { c.via = d.via; closeVia(); return render(); }
  const act = d.act;
  closeMenu();
  if (act === 'det') { detOpen = !detOpen; return renderChat(), renderDet(); }
  if (act === 'send') return send();
  if (act === 'unreply') { replyTo = null; return renderChat(); }
  if (act === 'via') return $('viamenu').hidden ? openVia(t) : closeVia();
  if (act === 'draft') {
    if (c.agentAccess !== 'draft') return toast(`Dots doesn't have draft access to ${esc(c.name)}`);
    c.draft = DRAFTS[c.id] || 'Sounds good!';
    c.draftAi = true;
    renderChat();
    return $('ta').focus();
  }
  if (act === 'dismiss-health') { healthDismissed = true; return renderList(); }
  if (act === 'accept') { c.request = false; toast(`Accepted ${esc(c.name)}`); filt.view = 'inbox'; return render(); }
  if (act === 'block') { const before = shownIds(); c.request = false; c.archived = true; toast(`Blocked ${esc(c.name)}`); return reconcileAfter(before); }
  if (act === 'new') return toast('New message: pick a person, then a network');
  if (act === 'connect') return toast('Opens the shared login stepper for any network');
  if (act === 'settings') return toast('Settings: account, notifications, backups');
  if (act === 'agents') return toast('Agents and access: connected agents, grants, audit log');
  if (act === 'devices') return toast('Devices and keys: approve new devices, recovery key');
  if (act === 'custom-time') return toast('Opens a date and time picker');
  if (act === 'labels') return toast('Edit labels: rename, recolor, or add one');
});

stage.addEventListener('input', (e) => {
  if (e.target.id === 'q') renderList();
  if (e.target.id === 'ta') { const c = current(); c.draft = e.target.value; if (!c.draft) c.draftAi = false; }
  if (e.target.id === 'aedit') current().msgs.find((m) => m.kind === 'approval').approval.edit = e.target.value;
});

stage.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && e.target.id === 'ta') { e.preventDefault(); send(); }
  if (e.key === 'Escape') { closeVia(); closeMenu(); if (replyTo != null) { replyTo = null; renderChat(); } }
});

$('searchbox')?.insertAdjacentHTML('afterbegin', icon('search', 16));
select('mom');
