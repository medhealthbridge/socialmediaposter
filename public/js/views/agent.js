import { $, $$, api, state, esc, icon, toast, refresh, refreshCounts, go, fmt } from '../core.js';

const KEY = 'agent-chat';
const load = () => { try { return JSON.parse(sessionStorage.getItem(KEY) || '[]'); } catch { return []; } };
const save = (h) => { try { sessionStorage.setItem(KEY, JSON.stringify(h.slice(-40))); } catch { /* storage blocked */ } };

const EXAMPLES = [
  'Write 3 posts about our new opening hours and queue them',
  'What is waiting in my queue?',
  'Draft a post for each account about today’s special, tailored to each network',
  'How did last month go? Which post did best?',
  'Did anything fail recently, and why?',
];

export async function render(root) {
  let history = load();
  let busyNow = false;
  const hasKey = state.settings.ai?.hasKey?.[state.settings.ai.provider];

  root.innerHTML = `<div class="page">
    <div class="page-head"><div class="grow"><h1>Agent</h1><p class="sub">Tell it what you want in plain words. It uses the app for you — writing, queueing, scheduling and reading your results.</p></div>
      <label class="check" data-tip="When off, the agent can prepare posts but not send them"><span class="switch"><input type="checkbox" id="canPub" ${state.settings.agentCanPublish ? 'checked' : ''}><span></span></span> Allow publishing</label>
      <button class="btn ghost sm" id="clear">${icon('trash')} Clear chat</button></div>
    ${hasKey ? '' : `<div class="callout warn">${icon('alert')}<div>The agent needs an AI key. <a href="#/settings?s=ai">Add one in Settings</a> — Google Gemini has a free tier.</div></div>`}
    <div class="card chat" id="chat"></div>
    <form class="chat-bar card" id="bar">
      <textarea id="msg" rows="2" placeholder="e.g. write three posts about the weekend sale and queue them" ${hasKey ? '' : 'disabled'}></textarea>
      <button class="btn primary" id="send" ${hasKey ? '' : 'disabled'}>${icon('send')} Send</button>
    </form>
  </div>`;

  const chat = $('#chat', root);
  function draw() {
    chat.innerHTML = history.length ? history.map((m) => `
      <div class="msg ${m.role}">
        <div class="who">${m.role === 'you' ? 'You' : 'Agent'}</div>
        <div class="bubble">${esc(m.text).replace(/\n/g, '<br>')}
          ${m.used?.length ? `<div class="tools">${m.used.map((u) => `<span class="pill ${u.ok ? '' : 'over'}" data-tip="${esc(JSON.stringify(u.args || {}))}">${icon(u.ok ? 'check' : 'alert')} ${esc(u.name.replace(/_/g, ' '))}</span>`).join('')}</div>` : ''}
        </div>
      </div>`).join('')
      : `<div class="empty">${icon('sparkle')}<b>Ask for anything</b><span>It can write, queue, schedule, check your results and explain failures.</span>
         <div class="row" style="justify-content:center;max-width:620px">${EXAMPLES.map((e) => `<button class="chip plain" data-ex="${esc(e)}">${esc(e)}</button>`).join('')}</div></div>`;
    if (busyNow) chat.insertAdjacentHTML('beforeend', `<div class="msg agent"><div class="who">Agent</div><div class="bubble thinking">Working…</div></div>`);
    chat.scrollTop = chat.scrollHeight;
  }

  async function send(text) {
    if (busyNow || !text.trim()) return;
    history.push({ role: 'you', text });
    busyNow = true; save(history); draw();
    try {
      const r = await api('/agent', { method: 'POST', body: { message: text, history: history.slice(0, -1).map(({ role, text: t }) => ({ role, text: t })) } });
      history.push({ role: 'agent', text: r.reply, used: r.used });
      // Anything it changed should show up immediately elsewhere in the app.
      if (r.used.some((u) => u.ok && u.name !== 'list_accounts' && !u.name.startsWith('get_') && !u.name.startsWith('list_'))) { await refresh(); await refreshCounts(); }
    } catch (e) {
      history.push({ role: 'agent', text: `Sorry — ${e.message}` });
    } finally {
      busyNow = false; save(history); draw();
    }
  }

  $('#bar', root).onsubmit = (e) => { e.preventDefault(); const t = $('#msg', root).value; $('#msg', root).value = ''; send(t); };
  $('#msg', root).onkeydown = (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); $('#bar', root).requestSubmit(); } };
  chat.onclick = (e) => { const b = e.target.closest('[data-ex]'); if (b) send(b.dataset.ex); };
  $('#clear', root).onclick = () => { history = []; save(history); draw(); };
  $('#canPub', root).onchange = async (e) => {
    state.settings = await api('/settings', { method: 'PUT', body: { agentCanPublish: e.target.checked } });
    toast(e.target.checked ? 'The agent can publish now' : 'The agent can no longer publish', 'ok');
  };
  draw();
  $('#msg', root).focus();
}
