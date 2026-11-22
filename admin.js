(function () {
  "use strict";

  // Admin panel. Every rule (who may read, edit, ban or promote) is enforced by the database policies in
  // supabase_profiles.sql and supabase_applications.sql; this file only draws the page and sends requests.
  // A visitor who is not an admin gets the page shell but the database returns nothing and refuses every change.
  var SUPABASE_URL = "https://vanjowcvzvqkzbdxwunb.supabase.co";
  var SUPABASE_PUBLISHABLE_KEY = "sb_publishable_GYpISpry5P7Ntnru55ZS3A_a7b3N4hq";
  var NOTICE_ROW = "navbar_notice";
  var NOTICE_CACHE = "northco-notice";
  var TERMS_ROW = "terms_of_service";
  var TERMS_CACHE = "northco-terms";
  var STATUS_LABEL = { pending: "Pending", accepted: "Accepted", rejected: "Not accepted" };

  var gate = document.getElementById("admin-gate");
  var appEl = document.getElementById("admin-app");
  if (!gate || !appEl) return;

  var accountEl = document.getElementById("admin-account");
  var messageEl = document.getElementById("admin-message");
  var statsEl = document.getElementById("admin-stats");
  var noticeForm = document.getElementById("notice-form");
  var noticeInput = document.getElementById("notice-input");
  var noticeNote = document.getElementById("notice-note");
  var termsForm = document.getElementById("terms-form");
  var termsInput = document.getElementById("terms-input");
  var termsNote = document.getElementById("terms-note");
  var appsFilter = document.getElementById("apps-filter");
  var appsList = document.getElementById("apps-list");
  var openingForm = document.getElementById("opening-form");
  var openingNote = document.getElementById("opening-note");
  var openingsList = document.getElementById("openings-list");
  var usersSearch = document.getElementById("users-search");
  var usersList = document.getElementById("users-list");
  var tabs = Array.prototype.slice.call(document.querySelectorAll(".admin-tab"));
  var panels = {
    overview: document.getElementById("panel-overview"),
    applications: document.getElementById("panel-applications"),
    openings: document.getElementById("panel-openings"),
    users: document.getElementById("panel-users"),
    terms: document.getElementById("panel-terms")
  };

  var client = null;
  var user = null;
  var shownUserId;            // undefined until the first session has been handled
  var noticeDirty = false;
  var termsDirty = false;
  var currentTab = "overview";
  var seqs = { overview: 0, applications: 0, openings: 0, users: 0 };
  var searchTimer = null;

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function say(text) {
    messageEl.textContent = text || "";
  }

  function friendlyError(error) {
    if (!error) return "";
    if (error.code === "42501") return "The database refused this change. Are you still signed in as an admin?";
    if (error.code === "23514") return "One of the values is too short or too long. Please check the fields.";
    if (error.code === "23505") return "That already exists.";
    return error.message || "Something went wrong.";
  }

  function fmtDate(value) {
    if (!value) return "";
    return new Date(value).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  }

  function button(label, className, onClick) {
    var b = el("button", "btn " + className, label);
    b.type = "button";
    b.addEventListener("click", onClick);
    return b;
  }

  function setBusy(container, busy) {
    Array.prototype.forEach.call(container.querySelectorAll("button, input, textarea, select"), function (node) {
      node.disabled = busy;
    });
  }

  function labelled(labelText, control, id) {
    var label = el("label", "settings-field");
    label.setAttribute("for", id);
    control.id = id;
    label.append(labelText, control);
    return label;
  }

  function textBlock(title, text) {
    var wrap = el("div", "admin-block");
    wrap.append(el("strong", null, title), el("p", "admin-text", text));
    return wrap;
  }

  // ------------------------------------------------------------------ gate
  function showGate() {
    appEl.hidden = true;
    gate.hidden = false;
    gate.replaceChildren.apply(gate, arguments);
  }

  function showLoading(text) {
    showGate(el("p", null, text));
  }

  function showSignIn() {
    var login = button("Continue with Discord", "btn-primary", function () {
      login.disabled = true;
      client.auth.signInWithOAuth({
        provider: "discord",
        options: { redirectTo: window.location.href.split("#")[0] }
      }).then(function (result) {
        if (result.error) {
          say("Discord sign-in couldn't start: " + result.error.message);
          login.disabled = false;
        }
      });
    });
    showGate(el("p", null, "Sign in with Discord to open the admin panel."), login);
  }

  function showDenied() {
    var out = button("Sign out", "btn-ghost", function () { client.auth.signOut(); });
    showGate(el("p", null, "This account doesn't have admin access."), out);
  }

  function showProblem(text) {
    showGate(el("p", null, text));
  }

  function renderAccount(name) {
    accountEl.replaceChildren(
      el("p", null, "Signed in as " + name + " (admin)."),
      button("Sign out", "btn-ghost", function () { client.auth.signOut(); })
    );
  }

  // ------------------------------------------------------------------ tabs
  function selectTab(name) {
    currentTab = name;
    tabs.forEach(function (tab) {
      var on = tab.dataset.tab === name;
      tab.setAttribute("aria-selected", String(on));
      tab.tabIndex = on ? 0 : -1;
    });
    Object.keys(panels).forEach(function (key) { panels[key].hidden = key !== name; });
    say("");
    loaders[name]();
  }

  tabs.forEach(function (tab, index) {
    tab.addEventListener("click", function () { selectTab(tab.dataset.tab); });
    tab.addEventListener("keydown", function (event) {
      var next = null;
      if (event.key === "ArrowRight") next = tabs[(index + 1) % tabs.length];
      if (event.key === "ArrowLeft") next = tabs[(index - 1 + tabs.length) % tabs.length];
      if (next) { event.preventDefault(); next.focus(); selectTab(next.dataset.tab); }
    });
  });

  // -------------------------------------------------------------- overview
  function count(table, refine) {
    var query = client.from(table).select("id", { count: "exact", head: true });
    if (refine) query = refine(query);
    return query.then(function (result) { return result.error ? null : result.count; });
  }

  function statTile(value, label) {
    var tile = el("div", "admin-stat");
    tile.append(el("strong", null, value == null ? "–" : String(value)), el("span", null, label));
    return tile;
  }

  async function loadOverview() {
    var seq = ++seqs.overview;
    var results = await Promise.all([
      count("applications", function (q) { return q.eq("status", "pending"); }),
      count("job_openings", function (q) { return q.eq("is_open", true); }),
      count("profiles"),
      count("profiles", function (q) { return q.eq("banned", true); }),
      client.from("site_settings").select("value").eq("key", NOTICE_ROW).maybeSingle()
    ]);
    if (seq !== seqs.overview) return;
    statsEl.replaceChildren(
      statTile(results[0], "Pending applications"),
      statTile(results[1], "Open roles"),
      statTile(results[2], "Members"),
      statTile(results[3], "Banned")
    );
    var row = results[4];
    if (!noticeDirty && row && row.data && typeof row.data.value === "string") {
      noticeInput.value = row.data.value;
    }
  }

  noticeInput.addEventListener("input", function () { noticeDirty = true; noticeNote.textContent = ""; });

  noticeForm.addEventListener("submit", async function (event) {
    event.preventDefault();
    var value = noticeInput.value.trim();
    if (!value) {
      noticeNote.textContent = "The notice can't be empty.";
      return;
    }
    var submit = noticeForm.querySelector("button[type=submit]");
    submit.disabled = true;
    noticeNote.textContent = "Saving…";
    var result = await client.from("site_settings").upsert(
      { key: NOTICE_ROW, value: value, updated_at: new Date().toISOString() },
      { onConflict: "key" }
    );
    submit.disabled = false;
    if (result.error) {
      noticeNote.textContent = "Couldn't save the notice: " + friendlyError(result.error);
      return;
    }
    noticeDirty = false;
    noticeNote.textContent = "Saved. The new notice shows on every page.";
    try { sessionStorage.setItem(NOTICE_CACHE, value); } catch (e) {}
    var live = document.querySelector(".notice");
    if (live) live.textContent = value;
  });

  async function loadTerms() {
    if (!termsInput || termsDirty) return;
    var result = await client.from("site_settings").select("value").eq("key", TERMS_ROW).maybeSingle();
    if (result.error) {
      termsNote.textContent = "Couldn't load the current terms: " + friendlyError(result.error);
      return;
    }
    if (result.data && typeof result.data.value === "string") {
      termsInput.value = result.data.value;
      return;
    }
    try {
      var response = await fetch("terms.html");
      if (!response.ok) return;
      var page = new DOMParser().parseFromString(await response.text(), "text/html");
      var doc = page.querySelector("#terms-body");
      if (!doc) return;
      var lines = [];
      Array.prototype.forEach.call(doc.children, function (node) {
        if (node.matches(".back, .updated")) return;
        if (/^H[1-3]$/.test(node.tagName)) {
          lines.push("#".repeat(Number(node.tagName.slice(1))) + " " + node.textContent.trim());
        } else if (node.tagName === "UL" || node.tagName === "OL") {
          Array.prototype.forEach.call(node.querySelectorAll("li"), function (item) { lines.push("- " + item.textContent.trim()); });
        } else if (node.tagName === "P") {
          lines.push(node.textContent.trim());
        }
      });
      termsInput.value = lines.filter(Boolean).join("\n\n");
    } catch (error) {
      termsNote.textContent = "Couldn't load the default terms. You can still enter them here.";
    }
  }

  termsInput.addEventListener("input", function () { termsDirty = true; termsNote.textContent = ""; });

  termsForm.addEventListener("submit", async function (event) {
    event.preventDefault();
    var value = termsInput.value.trim();
    if (!value) {
      termsNote.textContent = "The terms can't be empty.";
      return;
    }
    var submit = termsForm.querySelector("button[type=submit]");
    submit.disabled = true;
    termsNote.textContent = "Saving…";
    var result = await client.from("site_settings").upsert(
      { key: TERMS_ROW, value: value, updated_at: new Date().toISOString() },
      { onConflict: "key" }
    );
    submit.disabled = false;
    if (result.error) {
      termsNote.textContent = "Couldn't save the terms: " + friendlyError(result.error);
      return;
    }
    termsDirty = false;
    termsNote.textContent = "Saved. The public Terms of Service page is updated.";
    try { sessionStorage.setItem(TERMS_CACHE, JSON.stringify({ value: value, updated_at: new Date().toISOString() })); } catch (e) {}
  });

  // ---------------------------------------------------------- applications
  async function updateApplication(app, changes, box, doneText) {
    setBusy(box, true);
    var result = await client.from("applications").update(changes).eq("id", app.id);
    if (result.error) {
      setBusy(box, false);
      say("Couldn't update the application: " + friendlyError(result.error));
      return;
    }
    say(doneText);
    await loadApplications();
  }

  async function deleteApplication(app, box) {
    if (!window.confirm("Delete this application from " + (app.discord_name || "this user") + " permanently?")) return;
    setBusy(box, true);
    var result = await client.from("applications").delete().eq("id", app.id);
    if (result.error) {
      setBusy(box, false);
      say("Couldn't delete the application: " + friendlyError(result.error));
      return;
    }
    say("Application deleted.");
    await loadApplications();
  }

  function buildApplication(app) {
    var card = el("article", "job admin-card");

    var head = el("div", "admin-card-head");
    head.append(
      el("h3", null, app.role_title),
      el("span", "app-badge app-" + app.status, STATUS_LABEL[app.status] || app.status)
    );

    var metaParts = [app.discord_name || "Unknown Discord name"];
    if (app.roblox_username) metaParts.push("Roblox: " + app.roblox_username);
    if (app.timezone) metaParts.push(app.timezone);
    metaParts.push("Sent " + fmtDate(app.created_at));
    var meta = el("p", "admin-meta", metaParts.join(" · "));

    var details = el("details", "admin-details");
    details.open = app.status === "pending";
    details.append(el("summary", null, "Read the application"));
    if (Array.isArray(app.answers) && app.answers.length) {
      // New applications carry the question text they answered, so edits to a question never rewrite history.
      app.answers.forEach(function (item) {
        details.append(textBlock(String(item.label || "Question"), String(item.answer || "")));
      });
    } else {
      // Applications sent before questions became editable.
      if (app.experience) details.append(textBlock("Experience", app.experience));
      if (app.motivation) details.append(textBlock("Why they want to join", app.motivation));
    }

    var note = el("textarea", "settings-input");
    note.rows = 3;
    note.maxLength = 1000;
    note.value = app.admin_note || "";
    note.placeholder = "Private note, only admins can see it.";
    var noteField = labelled("Admin note", note, "note-" + app.id);

    var actions = el("div", "admin-actions");
    function noteValue() { return note.value.trim() || null; }
    if (app.status !== "accepted") {
      actions.append(button("Accept", "btn-primary", function () {
        updateApplication(app, { status: "accepted", admin_note: noteValue() }, card, "Application accepted.");
      }));
    }
    if (app.status !== "rejected") {
      actions.append(button("Don't accept", "btn-ghost", function () {
        updateApplication(app, { status: "rejected", admin_note: noteValue() }, card, "Application marked as not accepted.");
      }));
    }
    if (app.status !== "pending") {
      actions.append(button("Back to pending", "btn-ghost", function () {
        updateApplication(app, { status: "pending", admin_note: noteValue() }, card, "Application moved back to pending.");
      }));
    }
    actions.append(
      button("Save note", "btn-ghost", function () {
        updateApplication(app, { admin_note: noteValue() }, card, "Note saved.");
      }),
      button("Delete", "btn-danger", function () { deleteApplication(app, card); })
    );

    card.append(head, meta, details, noteField, actions);
    if (app.reviewed_at) card.append(el("p", "admin-meta", "Reviewed " + fmtDate(app.reviewed_at)));
    return card;
  }

  async function loadApplications() {
    var seq = ++seqs.applications;
    var query = client.from("applications")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(100);
    if (appsFilter.value !== "all") query = query.eq("status", appsFilter.value);
    var result = await query;
    if (seq !== seqs.applications) return;
    appsList.replaceChildren();
    if (result.error) {
      appsList.append(el("p", "jobs-state", "Couldn't load applications: " + friendlyError(result.error)));
      return;
    }
    var rows = result.data || [];
    if (!rows.length) {
      appsList.append(el("p", "jobs-state", "No applications here."));
      return;
    }
    rows.forEach(function (app) { appsList.append(buildApplication(app)); });
    if (rows.length === 100) appsList.append(el("p", "jobs-state", "Showing the latest 100 applications."));
  }

  appsFilter.addEventListener("change", loadApplications);

  // -------------------------------------------------------------- openings
  openingForm.addEventListener("submit", async function (event) {
    event.preventDefault();
    var title = openingForm.elements.title.value.trim();
    var description = openingForm.elements.description.value.trim();
    var requirements = openingForm.elements.requirements.value.trim();
    var submit = openingForm.querySelector("button[type=submit]");
    submit.disabled = true;
    openingNote.textContent = "Creating…";
    var result = await client.from("job_openings").insert({
      title: title,
      description: description,
      requirements: requirements,
      is_open: true
    });
    submit.disabled = false;
    if (result.error) {
      openingNote.textContent = "Couldn't create the role: " + friendlyError(result.error);
      return;
    }
    openingForm.reset();
    openingNote.textContent = "Role created with four default questions. Open it below to edit them.";
    await loadOpenings();
  });

  async function saveOpening(opening, fields, box) {
    var title = fields.title.value.trim();
    if (title.length < 2) {
      say("The title needs at least 2 characters.");
      fields.title.focus();
      return;
    }
    setBusy(box, true);
    var result = await client.from("job_openings").update({
      title: title,
      description: fields.description.value.trim(),
      requirements: fields.requirements.value.trim(),
      is_open: fields.open.checked
    }).eq("id", opening.id);
    if (result.error) {
      setBusy(box, false);
      say("Couldn't save the role: " + friendlyError(result.error));
      return;
    }
    say("Role saved.");
    await loadOpenings();
  }

  async function deleteOpening(opening, box) {
    if (!window.confirm("Delete the role “" + opening.title + "”? Applications already sent for it are kept.")) return;
    setBusy(box, true);
    var result = await client.from("job_openings").delete().eq("id", opening.id);
    if (result.error) {
      setBusy(box, false);
      say("Couldn't delete the role: " + friendlyError(result.error));
      return;
    }
    say("Role deleted.");
    await loadOpenings();
  }

  function buildOpening(opening) {
    var card = el("article", "job admin-card");
    var head = el("div", "admin-card-head");
    head.append(
      el("h3", null, opening.title),
      el("span", "app-badge " + (opening.is_open ? "app-accepted" : "app-closed"), opening.is_open ? "Open" : "Closed")
    );

    var title = el("input", "settings-input");
    title.type = "text";
    title.maxLength = 80;
    title.value = opening.title;
    var description = el("textarea", "settings-input");
    description.rows = 3;
    description.maxLength = 1000;
    description.value = opening.description || "";

    var check = el("label", "settings-check");
    var open = el("input");
    open.type = "checkbox";
    open.checked = opening.is_open;
    check.append(open, el("span", null, "Open for applications"));

    var requirements = el("textarea", "settings-input");
    requirements.rows = 4;
    requirements.maxLength = 2000;
    requirements.value = opening.requirements || "";
    requirements.placeholder = "One requirement per line, e.g. Be at least 16 years old";

    var fields = { title: title, description: description, requirements: requirements, open: open };
    var actions = el("div", "admin-actions");
    var page = el("a", "btn btn-ghost", "Open role page");
    page.href = "apply.html?role=" + encodeURIComponent(opening.id);
    page.target = "_blank";
    page.rel = "noopener";
    actions.append(
      button("Save changes", "btn-primary", function () { saveOpening(opening, fields, card); }),
      page,
      button("Delete", "btn-danger", function () { deleteOpening(opening, card); })
    );

    card.append(
      head,
      labelled("Title", title, "opening-title-" + opening.id),
      labelled("Description", description, "opening-desc-" + opening.id),
      labelled("Requirements (one per line)", requirements, "opening-req-" + opening.id),
      check,
      actions,
      buildQuestions(opening)
    );
    return card;
  }

  // ------------------------------------------------------------- questions
  function buildQuestions(opening) {
    var details = el("details", "admin-details");
    details.append(el("summary", null, "Application questions"));
    var body = el("div", "admin-questions");
    details.append(body);
    var loaded = false;
    details.addEventListener("toggle", function () {
      if (details.open && !loaded) {
        loaded = true;
        renderQuestions(opening, body);
      }
    });
    return details;
  }

  async function renderQuestions(opening, body) {
    body.replaceChildren(el("p", "jobs-state", "Loading questions…"));
    var result = await client.from("application_questions")
      .select("*")
      .eq("opening_id", opening.id)
      .order("position", { ascending: true })
      .order("created_at", { ascending: true });
    body.replaceChildren();
    if (result.error) {
      body.append(el("p", "jobs-state", "Couldn't load the questions: " + friendlyError(result.error)));
      return;
    }
    var list = result.data || [];
    body.append(el("p", "admin-meta", "Applicants answer these on the role page. Changing a question never changes applications that were already sent."));
    if (!list.length) body.append(el("p", "jobs-state", "No questions yet. Applicants can't apply until you add one."));
    list.forEach(function (q, index) { body.append(buildQuestionRow(opening, q, index, list, body)); });
    body.append(buildQuestionAdder(opening, list, body));
  }

  function questionControls(q) {
    var label = el("input", "settings-input");
    label.type = "text";
    label.maxLength = 200;
    label.value = q.label || "";
    var help = el("input", "settings-input");
    help.type = "text";
    help.maxLength = 300;
    help.value = q.help || "";
    help.placeholder = "Optional hint shown under the question";
    var kind = el("select", "settings-input");
    [["short", "Short answer (one line)"], ["long", "Long answer (paragraph)"]].forEach(function (pair) {
      var option = el("option", null, pair[1]);
      option.value = pair[0];
      kind.append(option);
    });
    kind.value = q.kind || "long";
    var max = el("input", "settings-input");
    max.type = "number";
    max.min = 1;
    max.max = 3000;
    max.value = q.max_length || 1500;
    var required = el("input");
    required.type = "checkbox";
    required.checked = q.required !== false;
    return { label: label, help: help, kind: kind, max: max, required: required };
  }

  function readQuestion(c) {
    var label = c.label.value.trim();
    var max = parseInt(c.max.value, 10);
    if (label.length < 2) { say("The question needs at least 2 characters."); c.label.focus(); return null; }
    if (!(max >= 1 && max <= 3000)) { say("Max length must be between 1 and 3000."); c.max.focus(); return null; }
    return { label: label, help: c.help.value.trim(), kind: c.kind.value, max_length: max, required: c.required.checked };
  }

  function buildQuestionRow(opening, q, index, list, body) {
    var row = el("div", "admin-q");
    var c = questionControls(q);
    var checkWrap = el("label", "settings-check");
    checkWrap.append(c.required, el("span", null, "Required"));
    var grid = el("div", "admin-q-grid");
    grid.append(
      labelled("Question " + (index + 1), c.label, "q-label-" + q.id),
      labelled("Hint", c.help, "q-help-" + q.id),
      labelled("Type", c.kind, "q-kind-" + q.id),
      labelled("Max characters", c.max, "q-max-" + q.id)
    );

    var actions = el("div", "admin-actions");
    var up = button("↑ Up", "btn-ghost", function () { moveQuestion(opening, list, index, -1, row, body); });
    var down = button("↓ Down", "btn-ghost", function () { moveQuestion(opening, list, index, 1, row, body); });
    up.disabled = index === 0;
    down.disabled = index === list.length - 1;
    actions.append(
      button("Save question", "btn-primary", async function () {
        var values = readQuestion(c);
        if (!values) return;
        setBusy(row, true);
        var result = await client.from("application_questions").update(values).eq("id", q.id);
        if (result.error) { setBusy(row, false); say("Couldn't save the question: " + friendlyError(result.error)); return; }
        say("Question saved.");
        await renderQuestions(opening, body);
      }),
      up,
      down,
      button("Delete", "btn-danger", async function () {
        if (!window.confirm("Delete the question “" + q.label + "”? Applications already sent keep their answers.")) return;
        setBusy(row, true);
        var result = await client.from("application_questions").delete().eq("id", q.id);
        if (result.error) { setBusy(row, false); say("Couldn't delete the question: " + friendlyError(result.error)); return; }
        say("Question deleted.");
        await renderQuestions(opening, body);
      })
    );
    row.append(grid, checkWrap, actions);
    return row;
  }

  async function moveQuestion(opening, list, index, delta, row, body) {
    var target = index + delta;
    if (target < 0 || target >= list.length) return;
    setBusy(row, true);
    var order = list.slice();
    var moved = order.splice(index, 1)[0];
    order.splice(target, 0, moved);
    // Renumber 1..n so positions stay clean even if two questions had the same number.
    var updates = [];
    order.forEach(function (q, i) {
      if (q.position !== i + 1) {
        updates.push(client.from("application_questions").update({ position: i + 1 }).eq("id", q.id));
      }
    });
    var results = await Promise.all(updates);
    var failed = results.filter(function (r) { return r.error; })[0];
    if (failed) say("Couldn't reorder the questions: " + friendlyError(failed.error));
    await renderQuestions(opening, body);
  }

  function buildQuestionAdder(opening, list, body) {
    var box = el("div", "admin-q admin-q-new");
    var c = questionControls({ kind: "long", max_length: 1500, required: true });
    var checkWrap = el("label", "settings-check");
    checkWrap.append(c.required, el("span", null, "Required"));
    var grid = el("div", "admin-q-grid");
    grid.append(
      labelled("New question", c.label, "q-new-label-" + opening.id),
      labelled("Hint", c.help, "q-new-help-" + opening.id),
      labelled("Type", c.kind, "q-new-kind-" + opening.id),
      labelled("Max characters", c.max, "q-new-max-" + opening.id)
    );
    var actions = el("div", "admin-actions");
    actions.append(button("Add question", "btn-primary", async function () {
      var values = readQuestion(c);
      if (!values) return;
      values.opening_id = opening.id;
      var last = list.reduce(function (m, q) { return Math.max(m, q.position || 0); }, 0);
      values.position = last + 1;
      setBusy(box, true);
      var result = await client.from("application_questions").insert(values);
      if (result.error) { setBusy(box, false); say("Couldn't add the question: " + friendlyError(result.error)); return; }
      say("Question added.");
      await renderQuestions(opening, body);
    }));
    box.append(grid, checkWrap, actions);
    return box;
  }

  async function loadOpenings() {
    var seq = ++seqs.openings;
    var result = await client.from("job_openings")
      .select("id, title, description, requirements, is_open, created_at")
      .order("created_at", { ascending: true });
    if (seq !== seqs.openings) return;
    openingsList.replaceChildren();
    if (result.error) {
      openingsList.append(el("p", "jobs-state", "Couldn't load roles: " + friendlyError(result.error)));
      return;
    }
    var rows = result.data || [];
    if (!rows.length) {
      openingsList.append(el("p", "jobs-state", "No roles yet. Create the first one above."));
      return;
    }
    rows.forEach(function (opening) { openingsList.append(buildOpening(opening)); });
  }

  // ----------------------------------------------------------------- users
  async function updateProfile(profile, changes, box, doneText) {
    setBusy(box, true);
    var result = await client.from("profiles").update(changes).eq("id", profile.id);
    if (result.error) {
      setBusy(box, false);
      say("Couldn't update the member: " + friendlyError(result.error));
      return;
    }
    say(doneText);
    await loadUsers();
  }

  function buildUser(profile) {
    var name = profile.display_name || "Unnamed member";
    var row = el("div", "admin-user");

    var avatar;
    if (profile.avatar_url && /^https:\/\//i.test(profile.avatar_url)) {
      avatar = el("img", "admin-avatar");
      avatar.alt = "";
      avatar.width = 40;
      avatar.height = 40;
      avatar.loading = "lazy";
      avatar.referrerPolicy = "no-referrer";
      avatar.src = profile.avatar_url;
    } else {
      avatar = el("span", "admin-avatar admin-avatar-blank", name.charAt(0).toUpperCase());
      avatar.setAttribute("aria-hidden", "true");
    }

    var copy = el("div", "app-row-copy");
    copy.append(el("strong", null, name), el("span", null, "Joined " + fmtDate(profile.created_at)));

    var badges = el("div", "admin-badges");
    var self = user && profile.id === user.id;
    if (self) badges.append(el("span", "app-badge", "You"));
    if (profile.is_admin) badges.append(el("span", "app-badge app-accepted", "Admin"));
    if (profile.banned) badges.append(el("span", "app-badge app-rejected", "Banned"));

    var actions = el("div", "admin-actions admin-user-actions");
    if (!self) {
      actions.append(
        button(profile.banned ? "Unban" : "Ban", profile.banned ? "btn-ghost" : "btn-danger", function () {
          var message = profile.banned
            ? "Unban " + name + "?"
            : "Ban " + name + "? They won't be able to send applications or edit their profile.";
          if (!window.confirm(message)) return;
          updateProfile(profile, { banned: !profile.banned }, row, profile.banned ? "Member unbanned." : "Member banned.");
        }),
        button(profile.is_admin ? "Remove admin" : "Make admin", "btn-ghost", function () {
          var message = profile.is_admin
            ? "Remove admin access from " + name + "?"
            : "Give " + name + " full admin access? They will be able to review applications, edit roles and ban members.";
          if (!window.confirm(message)) return;
          updateProfile(profile, { is_admin: !profile.is_admin }, row, profile.is_admin ? "Admin access removed." : "Admin access granted.");
        })
      );
    }

    row.append(avatar, copy, badges, actions);
    return row;
  }

  async function loadUsers() {
    var seq = ++seqs.users;
    var query = client.from("profiles")
      .select("id, display_name, avatar_url, is_admin, banned, created_at")
      .order("created_at", { ascending: false })
      .limit(100);
    var term = usersSearch.value.trim().replace(/[%_,()]/g, "");
    if (term) query = query.ilike("display_name", "%" + term + "%");
    var result = await query;
    if (seq !== seqs.users) return;
    usersList.replaceChildren();
    if (result.error) {
      usersList.append(el("p", "jobs-state", "Couldn't load members: " + friendlyError(result.error)));
      return;
    }
    var rows = result.data || [];
    if (!rows.length) {
      usersList.append(el("p", "jobs-state", term ? "No members match that name." : "No members yet."));
      return;
    }
    rows.forEach(function (profile) { usersList.append(buildUser(profile)); });
    if (rows.length === 100) usersList.append(el("p", "jobs-state", "Showing 100 members. Search by name to find others."));
  }

  usersSearch.addEventListener("input", function () {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(loadUsers, 300);
  });

  var loaders = {
    overview: loadOverview,
    applications: loadApplications,
    openings: loadOpenings,
    users: loadUsers,
    terms: loadTerms
  };

  // --------------------------------------------------------------- session
  async function handleSession(session) {
    var next = session ? session.user : null;
    var id = next ? next.id : null;
    if (id === shownUserId) return;
    shownUserId = id;
    user = next;
    noticeDirty = false;
    termsDirty = false;
    say("");
    if (!user) {
      showSignIn();
      return;
    }
    showLoading("Checking your access…");
    var result = await client.from("profiles")
      .select("display_name, is_admin, banned")
      .eq("id", user.id)
      .maybeSingle();
    if (id !== shownUserId) return;     // the account changed while we were waiting
    if (result.error) {
      showProblem("Couldn't check your access: " + friendlyError(result.error));
      return;
    }
    var me = result.data;
    if (!me || !me.is_admin || me.banned) {
      showDenied();
      return;
    }
    renderAccount(me.display_name || "Discord user");
    gate.hidden = true;
    appEl.hidden = false;
    selectTab(currentTab);
  }

  if (!window.supabase) {
    showProblem("The admin panel is unavailable right now. Please try again later.");
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
