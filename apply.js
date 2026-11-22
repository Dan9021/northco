(function () {
  "use strict";

  // One page per role: apply.html?role=<id>. It shows the role, its requirements and the application form
  // built from the questions the admins wrote. The rules (required answers, lengths, who may apply) are
  // enforced by the database; see supabase_questions.sql.
  var SUPABASE_URL = "https://vanjowcvzvqkzbdxwunb.supabase.co";
  var SUPABASE_PUBLISHABLE_KEY = "sb_publishable_GYpISpry5P7Ntnru55ZS3A_a7b3N4hq";
  var STATUS_LABEL = { pending: "Pending", accepted: "Accepted", rejected: "Not accepted" };

  var titleEl = document.getElementById("apply-title");
  var descEl = document.getElementById("apply-desc");
  var reqSection = document.getElementById("apply-requirements");
  var reqList = document.getElementById("apply-requirements-list");
  var accountEl = document.getElementById("apply-account");
  var formWrap = document.getElementById("apply-form-wrap");
  var messageEl = document.getElementById("apply-message");
  if (!titleEl || !formWrap) return;

  var roleId = new URLSearchParams(window.location.search).get("role");
  var client = null;
  var user = null;
  var shownUserId;            // undefined until the first session has been handled
  var opening = null;
  var sections = [];
  var sectionsLoadError = false;
  var questionsLoadError = false;
  var questions = [];
  var mine = [];
  var loadSeq = 0;
  var draftSaveTimer = null;
  var draftSaveChain = Promise.resolve();
  var draftSaveVersion = 0;
  var draftAnswers = {};
  var draftLoadError = false;

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function say(text) {
    messageEl.textContent = text || "";
  }

  function collectAnswers(controls) {
    var answers = {};
    controls.forEach(function (item) {
      var value = item.control.value;
      if (value.trim()) answers[item.question.id] = value;
    });
    return answers;
  }

  function scheduleDraftSave(answers, note) {
    var version = ++draftSaveVersion;
    var ownerId = user && user.id;
    var openingId = opening && opening.id;
    draftAnswers = answers;
    if (!ownerId || !openingId) return;
    clearTimeout(draftSaveTimer);
    note.textContent = "Saving draft…";
    draftSaveTimer = setTimeout(function () {
      draftSaveTimer = null;
      if (!user || user.id !== ownerId || !opening || opening.id !== openingId) return;
      draftSaveChain = draftSaveChain.catch(function () {}).then(async function () {
        var result = await client.from("application_drafts").upsert({
          user_id: ownerId,
          opening_id: openingId,
          answers: answers,
          updated_at: new Date().toISOString()
        }, { onConflict: "user_id,opening_id" });
        if (version !== draftSaveVersion) return;
        note.textContent = result.error
          ? "Draft autosave is unavailable. Your answers may not be saved."
          : "Draft saved automatically.";
      }).catch(function () {
        if (version === draftSaveVersion) note.textContent = "Draft autosave is unavailable. Your answers may not be saved.";
      });
    }, 700);
  }

  function friendlyError(error) {
    if (error.code === "23505") return "You already have a pending application for this role.";
    if (error.code === "42501") return "Your account can't send applications right now.";
    if (error.code === "23514" && error.message && error.message.indexOf("violates") === -1) return error.message;
    if (error.code === "23514") return "One of your answers is too short or too long. Please check the fields.";
    return "Couldn't send your application: " + error.message;
  }

  function fail(text) {
    titleEl.textContent = "Role not available";
    descEl.hidden = false;
    descEl.textContent = text;
    reqSection.hidden = true;
    accountEl.replaceChildren();
    formWrap.replaceChildren();
  }

  function renderRole() {
    document.title = "Northco – " + opening.title;
    titleEl.textContent = opening.title;
    descEl.textContent = opening.description || "";
    descEl.hidden = !opening.description;
    var lines = (opening.requirements || "").split("\n").map(function (l) { return l.trim(); }).filter(Boolean);
    reqList.replaceChildren();
    lines.forEach(function (line) { reqList.append(el("li", null, line)); });
    reqSection.hidden = !lines.length;
  }

  function signIn() {
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

  function displayName() {
    var meta = (user && user.user_metadata) || {};
    return meta.northco_display_name || meta.full_name || meta.name || meta.user_name || "Discord user";
  }

  function renderAccount() {
    accountEl.replaceChildren();
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

  function buildForm() {
    var form = el("form", "job-form apply-form");
    var panels = [];
    var controls = [];
    var controlsBySection = Object.create(null);
    var currentStep = 0;
    var progressLabel = el("p", "apply-progress-label");
    progressLabel.setAttribute("aria-live", "polite");
    var progress = el("div", "apply-progress");
    progress.setAttribute("role", "progressbar");
    progress.setAttribute("aria-label", "Application progress");
    progress.setAttribute("aria-valuemin", "1");
    progress.setAttribute("aria-valuemax", String(sections.length));
    var progressFill = el("span", "apply-progress-fill");
    progress.append(progressFill);
    form.append(progressLabel, progress);

    sections.forEach(function (section, sectionIndex) {
      var panel = el("section", "apply-step");
      panel.setAttribute("aria-labelledby", "apply-section-title-" + section.id);
      var heading = el("h3", "apply-section-title", section.title);
      heading.id = "apply-section-title-" + section.id;
      heading.tabIndex = -1;
      panel.append(heading);
      if (section.description) panel.append(el("p", "apply-section-description", section.description));
      controlsBySection[section.id] = [];

      questions.filter(function (q) { return q.section_id === section.id; }).forEach(function (q) {
        var label = el("label", "settings-field");
        var id = "q-" + q.id;
        label.setAttribute("for", id);
        label.append(q.label);
        if (q.required) {
          var mark = el("span", "req-mark", " *");
          mark.setAttribute("aria-hidden", "true");
          label.append(mark);
        }
        var control;
        if (q.kind === "short") {
          control = el("input", "settings-input");
          control.type = "text";
          control.autocomplete = "off";
        } else {
          control = el("textarea", "settings-input");
          control.rows = 4;
        }
        control.id = id;
        control.maxLength = q.max_length;
        control.setAttribute("aria-required", String(!!q.required));
        var savedValue = draftAnswers[q.id];
        if (typeof savedValue === "string") control.value = savedValue;
        if (q.help) {
          var hint = el("span", "apply-hint", q.help);
          hint.id = id + "-hint";
          control.setAttribute("aria-describedby", hint.id);
          label.append(hint);
        }
        label.append(control);
        panel.append(label);
        var item = { question: q, control: control };
        controls.push(item);
        controlsBySection[section.id].push(item);
      });

      panels.push(panel);
      form.append(panel);
      if (sectionIndex === sections.length - 1) {
        var consent = el("label", "settings-check apply-consent");
        var box = el("input");
        box.type = "checkbox";
        box.setAttribute("aria-label", "I agree to the privacy notice");
        var consentText = el("span");
        consentText.append("I understand that Northco admins will see this application, as described in the ");
        var link = el("a", null, "Privacy Policy");
        link.href = "privacy.html";
        consentText.append(link, ".");
        consent.append(box, consentText);
        panel.append(consent);
        form._consent = box;
      }
    });

    var actions = el("div", "apply-step-actions");
    var back = el("button", "btn btn-ghost", "Back");
    back.type = "button";
    back.addEventListener("click", function () {
      if (currentStep > 0) {
        currentStep -= 1;
        renderStep(true);
      }
    });
    var next = el("button", "btn btn-primary", "Next");
    next.type = "button";
    next.addEventListener("click", function () {
      var currentSection = sections[currentStep];
      var missing = (controlsBySection[currentSection.id] || []).filter(function (item) {
        return item.question.required && !item.control.value.trim();
      })[0];
      if (missing) {
        say("Please answer: " + missing.question.label);
        missing.control.focus();
        return;
      }
      if (currentStep < sections.length - 1) {
        currentStep += 1;
        renderStep(true);
      }
    });
    var submit = el("button", "btn btn-primary profile-button", "Send application");
    submit.type = "submit";
    actions.append(back, next, submit);
    form.append(actions);

    var note = el("p", "settings-note apply-form-note");
    note.setAttribute("role", "status");
    form.append(note);

    function renderStep(shouldFocus) {
      panels.forEach(function (panel, index) { panel.hidden = index !== currentStep; });
      progressLabel.textContent = "Section " + (currentStep + 1) + " of " + sections.length;
      progress.setAttribute("aria-valuenow", String(currentStep + 1));
      progressFill.style.width = ((currentStep + 1) / sections.length * 100) + "%";
      back.hidden = currentStep === 0;
      next.hidden = currentStep === sections.length - 1;
      submit.hidden = currentStep !== sections.length - 1;
      if (shouldFocus && panels[currentStep]) panels[currentStep].querySelector("h3").focus();
    }

    controls.forEach(function (item) {
      item.control.addEventListener("input", function () {
        scheduleDraftSave(collectAnswers(controls), note);
      });
    });
    note.textContent = draftLoadError
      ? "Draft autosave is unavailable. Your answers may not be saved."
      : Object.keys(draftAnswers).length
        ? "Your saved draft was restored. Changes save automatically."
        : "Your answers save automatically as you type.";

    form.addEventListener("submit", function (event) {
      event.preventDefault();
      var missing = null;
      for (var i = 0; i < sections.length && !missing; i += 1) {
        var sectionControls = controlsBySection[sections[i].id] || [];
        missing = sectionControls.filter(function (item) {
          return item.question.required && !item.control.value.trim();
        })[0] || null;
        if (missing) {
          currentStep = i;
          renderStep(true);
        }
      }
      if (missing) {
        say("Please answer: " + missing.question.label);
        missing.control.focus();
        return;
      }
      if (!form._consent.checked) {
        currentStep = sections.length - 1;
        renderStep(true);
        say("Please review and accept the privacy notice to continue.");
        form._consent.focus();
        return;
      }
      var answers = collectAnswers(controls);
      send(answers, submit, note);
    });

    renderStep(false);
    return form;
  }

  async function send(answers, submit, note) {
    clearTimeout(draftSaveTimer);
    draftSaveTimer = null;
    draftSaveVersion += 1;
    submit.disabled = true;
    note.textContent = "Sending…";
    await draftSaveChain;
    // role_title and discord_name are filled in by the database, and the answers are checked against the real questions.
    var result = await client.from("applications").insert({
      user_id: user.id,
      opening_id: opening.id,
      answers: answers
    });
    submit.disabled = false;
    if (result.error) {
      note.textContent = friendlyError(result.error);
      scheduleDraftSave(answers, note);
      return;
    }
    var draftCleanup = await client.from("application_drafts")
      .delete()
      .eq("user_id", user.id)
      .eq("opening_id", opening.id);
    draftAnswers = {};
    say(draftCleanup.error
      ? "Application sent. The saved draft could not be cleared, but it won't affect your application."
      : "Application sent. You can follow it on the Employment page.");
    await refresh();
  }

  function renderForm() {
    formWrap.replaceChildren();
    if (!user) return;

    var pending = mine.filter(function (a) { return a.status === "pending"; })[0];
    var accepted = mine.filter(function (a) { return a.status === "accepted"; })[0];
    if (pending || accepted) {
      var current = pending || accepted;
      var box = el("div", "app-row");
      var copy = el("div", "app-row-copy");
      copy.append(
        el("strong", null, pending ? "Your application is being reviewed" : "Your application was accepted"),
        el("span", null, "Sent " + new Date(current.created_at).toLocaleDateString())
      );
      box.append(copy, el("span", "app-badge app-" + current.status, STATUS_LABEL[current.status]));
      var back = el("a", "btn btn-ghost", "Back to Employment");
      back.href = "employment.html";
      box.append(back);
      formWrap.append(box);
      return;
    }

    if (mine.length) {
      formWrap.append(el("p", "jobs-state", "Your previous application for this role wasn't accepted. You can apply again."));
    }
    if (sectionsLoadError || questionsLoadError) {
      formWrap.append(el("p", "jobs-state", "The application form is unavailable right now. Please try again later."));
      return;
    }
    if (!sections.length || !questions.length) {
      formWrap.append(el("p", "jobs-state", "This role has no application form yet. Please check back soon."));
      return;
    }
    formWrap.append(el("h2", null, "Application"), buildForm());
  }

  async function refresh() {
    var seq = ++loadSeq;
    var queries = [
      client.from("job_openings")
        .select("id, title, description, requirements, is_open")
        .eq("id", roleId)
        .maybeSingle(),
      client.from("application_sections")
        .select("id, title, description, position, created_at")
        .eq("opening_id", roleId)
        .order("position", { ascending: true })
        .order("created_at", { ascending: true }),
      client.from("application_questions")
        .select("id, section_id, position, label, help, kind, required, max_length, created_at")
        .eq("opening_id", roleId)
        .order("position", { ascending: true })
        .order("created_at", { ascending: true }),
      user
        ? client.from("applications")
            .select("id, status, created_at")
            .eq("opening_id", roleId)
            .order("created_at", { ascending: false })
        : Promise.resolve({ data: [], error: null }),
      user
        ? client.from("application_drafts")
            .select("answers")
            .eq("opening_id", roleId)
            .maybeSingle()
        : Promise.resolve({ data: null, error: null })
    ];
    var results = await Promise.all(queries);
    if (seq !== loadSeq) return;
    if (results[0].error) {
      fail("Couldn't load this role. Please try again later.");
      return;
    }
    if (!results[0].data || !results[0].data.is_open) {
      fail("This role doesn't exist or isn't open for applications anymore.");
      return;
    }
    opening = results[0].data;
    sectionsLoadError = !!results[1].error;
    sections = sectionsLoadError ? [] : (results[1].data || []);
    questionsLoadError = !!results[2].error;
    questions = questionsLoadError ? [] : (results[2].data || []);
    mine = results[3].error ? [] : (results[3].data || []);
    draftLoadError = !!results[4].error;
    draftAnswers = results[4].data && results[4].data.answers && typeof results[4].data.answers === "object"
      ? results[4].data.answers
      : {};
    renderRole();
    renderAccount();
    renderForm();
  }

  function handleSession(session) {
    var next = session ? session.user : null;
    var id = next ? next.id : null;
    if (id === shownUserId) return;
    clearTimeout(draftSaveTimer);
    draftSaveTimer = null;
    draftSaveVersion += 1;
    draftAnswers = {};
    shownUserId = id;
    user = next;
    say("");
    refresh();
  }

  if (!roleId || !/^[0-9a-f-]{36}$/i.test(roleId)) {
    fail("This link doesn't point to a role. Pick one from the Employment page.");
    return;
  }
  if (!window.supabase) {
    fail("Applications are unavailable right now. Please try again later.");
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
