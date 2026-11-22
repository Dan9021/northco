(function () {
  "use strict";

  // Staff applications. Rules (who can read, send or review) are enforced by the database policies
  // in supabase_applications.sql; this file only draws the page and sends requests.
  var SUPABASE_URL = "https://vanjowcvzvqkzbdxwunb.supabase.co";
  var SUPABASE_PUBLISHABLE_KEY = "sb_publishable_GYpISpry5P7Ntnru55ZS3A_a7b3N4hq";
  var STATUS_LABEL = { pending: "Pending", accepted: "Accepted", rejected: "Not accepted" };

  var accountEl = document.getElementById("jobs-account");
  var listEl = document.getElementById("jobs-list");
  var mineSection = document.getElementById("my-applications");
  var mineList = document.getElementById("my-applications-list");
  var messageEl = document.getElementById("jobs-message");
  if (!accountEl || !listEl) return;

  var client = null;
  var user = null;
  var shownUserId;            // undefined until the first session has been handled
  var openings = [];
  var mine = [];
  var loadFailed = false;
  var loadSeq = 0;

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function say(text) {
    messageEl.textContent = text || "";
  }

  function displayName() {
    var meta = (user && user.user_metadata) || {};
    return meta.northco_display_name || meta.full_name || meta.name || meta.user_name || "Discord user";
  }

  async function withdraw(app) {
    if (!window.confirm("Withdraw your application for " + app.role_title + "?")) return;
    var result = await client.from("applications").delete().eq("id", app.id);
    if (result.error) {
      say("Couldn't withdraw the application: " + result.error.message);
      return;
    }
    say("Application withdrawn.");
    await refresh();
  }

  function signIn() {
    if (!client) return;
    var button = this;
    button.disabled = true;
    client.auth.signInWithOAuth({
      provider: "discord",
      options: { redirectTo: window.location.href.split("#")[0] }
    }).then(function (result) {
      if (result.error) {
        say("Discord sign-in couldn't start: " + result.error.message);
        button.disabled = false;
      }
    });
  }

  function renderAccount() {
    accountEl.replaceChildren();
    if (!client) return;
    if (user) {
      accountEl.append(el("p", null, "Signed in with Discord as " + displayName() + "."));
      var profile = el("a", "btn btn-ghost", "Your profile");
      profile.href = "profile.html";
      accountEl.append(profile);
    } else {
      accountEl.append(el("p", null, "Sign in with Discord to apply. We use it to know who to reply to."));
      var login = el("button", "btn btn-primary", "Continue with Discord");
      login.type = "button";
      login.addEventListener("click", signIn);
      accountEl.append(login);
    }
  }

  function renderJobs() {
    listEl.replaceChildren();
    if (loadFailed) {
      listEl.append(el("p", "jobs-state", "Couldn't load the open roles. Please try again later."));
      return;
    }
    if (!openings.length) {
      listEl.append(el("p", "jobs-state", "There are no open roles right now. Check back soon."));
      return;
    }
    openings.forEach(function (opening) {
      var card = el("article", "job");
      card.append(el("h3", null, opening.title));
      if (opening.description) card.append(el("p", null, opening.description));

      var mineHere = mine.filter(function (a) { return a.opening_id === opening.id; });
      var pending = mineHere.some(function (a) { return a.status === "pending"; });
      var accepted = mineHere.some(function (a) { return a.status === "accepted"; });

      if (pending || accepted) {
        var done = el("button", "btn btn-primary", pending ? "Application pending" : "Application accepted");
        done.type = "button";
        done.disabled = true;
        card.append(done);
      } else {
        // Every role has its own page with its requirements and its application form.
        var link = el("a", "btn btn-primary", "View role and apply");
        link.href = "apply.html?role=" + encodeURIComponent(opening.id);
        card.append(link);
      }
      listEl.append(card);
    });
  }

  function renderMine() {
    mineList.replaceChildren();
    mineSection.hidden = !user || !mine.length;
    mine.forEach(function (app) {
      var row = el("div", "app-row");
      var copy = el("div", "app-row-copy");
      copy.append(el("strong", null, app.role_title));
      copy.append(el("span", null, "Sent " + new Date(app.created_at).toLocaleDateString()));
      var badge = el("span", "app-badge app-" + app.status, STATUS_LABEL[app.status] || app.status);
      row.append(copy, badge);
      if (app.status === "pending") {
        var button = el("button", "btn btn-ghost app-withdraw", "Withdraw");
        button.type = "button";
        button.addEventListener("click", function () { withdraw(app); });
        row.append(button);
      }
      mineList.append(row);
    });
  }

  function render() {
    renderAccount();
    renderJobs();
    renderMine();
  }

  async function refresh() {
    var seq = ++loadSeq;
    var openingsQuery = client.from("job_openings")
      .select("id, title, description")
      .eq("is_open", true)
      .order("created_at", { ascending: true });
    var mineQuery = user
      ? client.from("applications")
          .select("id, opening_id, role_title, status, created_at")
          .order("created_at", { ascending: false })
      : Promise.resolve({ data: [], error: null });
    var results = await Promise.all([openingsQuery, mineQuery]);
    if (seq !== loadSeq) return;
    loadFailed = !!results[0].error;
    openings = results[0].data || [];
    mine = results[1].error ? [] : (results[1].data || []);
    render();
  }

  function handleSession(session) {
    var next = session ? session.user : null;
    var id = next ? next.id : null;
    if (id === shownUserId) return;
    shownUserId = id;
    user = next;
    refresh();
  }

  if (!window.supabase) {
    listEl.replaceChildren(el("p", "jobs-state", "Applications are unavailable right now. Please try again later."));
    return;
  }

  client = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
  // Don't call Supabase from inside this callback (it can deadlock), so hand off to the next tick.
  client.auth.onAuthStateChange(function (_event, session) {
    setTimeout(function () { handleSession(session); }, 0);
  });
  client.auth.getSession().then(function (result) {
    handleSession(result.data ? result.data.session : null);
  });
})();
