(function(){
  const originalFetch = window.fetch.bind(window);
  const state = {
    authMode: "none",
    user: null,
    permissions: [],
    roles: [],
    csrfToken: "",
    notifications: [],
    unreadCount: 0
  };

  function apiUrl(input){
    try{
      const raw = typeof input === "string" ? input : input && input.url;
      return new URL(raw || "", location.href);
    }catch(error){
      return null;
    }
  }

  function isApiWrite(input, init){
    const url = apiUrl(input);
    const method = String((init && init.method) || (input && input.method) || "GET").toUpperCase();
    return url && url.origin === location.origin && url.pathname.startsWith("/api/") && !["GET","HEAD","OPTIONS"].includes(method);
  }

  async function loadAuth(){
    try{
      const response = await originalFetch("/api/auth/me",{credentials:"same-origin"});
      const data = await response.json().catch(()=>({}));
      Object.assign(state,data);
      if(!data.user && data.authMode === "google" && !location.pathname.endsWith("/login.html")){
        location.href = `/login.html?next=${encodeURIComponent(location.pathname + location.search)}`;
      }
    }catch(error){
      state.error = error.message || "Could not load auth state";
    }
    return state;
  }

  const ready = loadAuth();

  window.MERCH_AUTH = {
    state,
    ready,
    hasRole(role){
      const user = state.user || {};
      return Boolean(user.isAdmin || (user.roles || []).includes("Admin") || (user.roles || []).includes(role));
    },
    can(permission){
      return state.permissions.includes("all") || state.permissions.includes(permission);
    }
  };

  window.fetch = async function(input,init){
    const options = Object.assign({},init || {});
    if(isApiWrite(input,options)){
      await ready;
      options.credentials = options.credentials || "same-origin";
      const headers = new Headers(options.headers || (input && input.headers) || {});
      if(state.csrfToken)headers.set("x-csrf-token",state.csrfToken);
      options.headers = headers;
    }
    const response = await originalFetch(input,options);
    const url = apiUrl(input);
    if(response.status === 401 && url && url.origin === location.origin && !location.pathname.endsWith("/login.html")){
      location.href = `/login.html?next=${encodeURIComponent(location.pathname + location.search)}`;
    }
    return response;
  };

  function escapeHtml(value){
    return String(value || "").replace(/[&<>"']/g,ch=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[ch]));
  }

  async function loadNotifications(){
    if(state.authMode !== "google" || !state.user)return;
    try{
      const response = await originalFetch("/api/notifications",{credentials:"same-origin"});
      const data = await response.json().catch(()=>({}));
      state.notifications = data.notifications || [];
      state.unreadCount = Number(data.unreadCount || 0);
      renderAuthBar();
    }catch(error){}
  }

  async function markAllRead(){
    await ready;
    await window.fetch("/api/notifications/read",{
      method:"POST",
      headers:{"content-type":"application/json"},
      body:JSON.stringify({all:true})
    }).catch(()=>{});
    await loadNotifications();
  }

  async function markOneRead(id){
    await ready;
    await window.fetch("/api/notifications/read",{
      method:"POST",
      headers:{"content-type":"application/json"},
      body:JSON.stringify({id})
    }).catch(()=>{});
  }

  async function logout(){
    await ready;
    await window.fetch("/api/auth/logout",{method:"POST",headers:{"content-type":"application/json"},body:"{}"}).catch(()=>{});
    location.href = "/login.html";
  }

  function renderAuthBar(){
    if(state.authMode !== "google" || !state.user)return;
    let bar = document.getElementById("auth-bar");
    if(!bar){
      bar = document.createElement("div");
      bar.id = "auth-bar";
      document.body.prepend(bar);
    }
    const user = state.user;
    const roles = (user.roles || []).join(", ") || "No roles";
    const adminLink = user.isAdmin ? '<a class="auth-link" href="/admin-users.html">Users</a>' : "";
    const notificationRows = (state.notifications || []).slice(0,8).map(item=>`
      <a class="auth-note ${item.isRead?"read":"unread"}" href="${escapeHtml(item.url || "#")}" data-note-id="${escapeHtml(item.id)}">
        <strong>${escapeHtml(item.title)}</strong>
        <span>${escapeHtml(item.body || "")}</span>
      </a>`).join("") || '<p class="auth-empty">No notifications.</p>';
    const unread = `<button type="button" class="auth-link auth-button" id="auth-notifications">${state.unreadCount ? `${state.unreadCount} unread` : "Notifications"}</button>`;
    bar.innerHTML = `
      <style>
        #auth-bar{position:sticky;top:0;z-index:50;margin:-22px -16px 16px;padding:7px 16px;border-bottom:1px solid var(--ds-line);background:var(--ds-bg-surface);display:flex;align-items:center;justify-content:flex-end;gap:10px;font:12px var(--ds-font-sans);color:var(--ds-text-muted)}
        #auth-bar strong{color:var(--ds-text);font-weight:650}
        #auth-bar .auth-link{color:var(--ds-action);text-decoration:none;border:0;background:transparent;font:inherit;font-weight:650;cursor:pointer;padding:0}
        #auth-bar .auth-muted{color:var(--ds-text-soft)}
        #auth-bar .auth-menu-wrap{position:relative}
        #auth-bar .auth-menu{position:absolute;right:0;top:24px;width:min(360px,calc(100vw - 24px));max-height:420px;overflow:auto;border:1px solid var(--ds-line);border-radius:var(--ds-radius);background:var(--ds-bg-surface);box-shadow:var(--ds-shadow);padding:8px;display:none}
        #auth-bar .auth-menu.open{display:block}
        #auth-bar .auth-note{display:block;text-decoration:none;border:1px solid var(--ds-line);border-radius:var(--ds-radius);padding:8px;margin-bottom:6px;background:var(--ds-bg-muted);color:var(--ds-text-muted)}
        #auth-bar .auth-note.unread{border-color:var(--ds-action);background:var(--ds-action-soft)}
        #auth-bar .auth-note strong,#auth-bar .auth-note span{display:block}
        #auth-bar .auth-note span{font-size:11px;line-height:1.4;margin-top:2px;color:var(--ds-text-muted)}
        #auth-bar .auth-menu-actions{display:flex;justify-content:flex-end;border-top:1px solid var(--ds-line);padding-top:7px;margin-top:4px}
        #auth-bar .auth-empty{padding:10px;color:var(--ds-text-soft)}
        @media(max-width:720px){#auth-bar{align-items:flex-start;justify-content:flex-start;flex-wrap:wrap;margin:-18px -10px 14px}}
      </style>
      <span><strong>${escapeHtml(user.displayName || user.email)}</strong> &middot; ${escapeHtml(roles)}</span>
      <span class="auth-menu-wrap">
        ${unread}
        <span class="auth-menu" id="auth-notification-menu">
          ${notificationRows}
          <span class="auth-menu-actions"><button type="button" class="auth-link auth-button" id="auth-read-all">Mark all read</button></span>
        </span>
      </span>
      ${adminLink}
      <button type="button" class="auth-link auth-button" id="auth-logout">Sign out</button>
    `;
    document.getElementById("auth-logout")?.addEventListener("click",logout);
    document.getElementById("auth-read-all")?.addEventListener("click",markAllRead);
    document.getElementById("auth-notifications")?.addEventListener("click",()=>{
      document.getElementById("auth-notification-menu")?.classList.toggle("open");
    });
    document.querySelectorAll("#auth-bar .auth-note").forEach(link=>{
      link.addEventListener("click",async(event)=>{
        event.preventDefault();
        const id=link.getAttribute("data-note-id")||"";
        if(id)await markOneRead(id);
        const href=link.getAttribute("href")||"#";
        if(href && href !== "#")location.href=href;
      });
    });
  }

  document.addEventListener("DOMContentLoaded",async()=>{
    await ready;
    renderAuthBar();
    loadNotifications();
    if(state.authMode === "google" && state.user)setInterval(loadNotifications,60000);
  });
})();
