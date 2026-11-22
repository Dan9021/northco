(function () {
  var url = "https://vanjowcvzvqkzbdxwunb.supabase.co";
  var key = "sb_publishable_GYpISpry5P7Ntnru55ZS3A_a7b3N4hq";
  var CACHE_KEY = "northco-terms";
  var content = document.getElementById("terms-body");
  if (!content) return;

  function render(value) {
    var fragment = document.createDocumentFragment();
    var list = null;
    var paragraph = [];

    function flushParagraph() {
      if (!paragraph.length) return;
      var node = document.createElement("p");
      node.textContent = paragraph.join(" ");
      fragment.appendChild(node);
      paragraph = [];
    }

    value.split(/\r?\n/).forEach(function (line) {
      var trimmed = line.trim();
      if (!trimmed) {
        flushParagraph();
        list = null;
        return;
      }
      var heading = /^(#{1,2})\s+(.+)$/.exec(trimmed);
      if (heading) {
        flushParagraph();
        list = null;
        var title = document.createElement(heading[1].length === 1 ? "h2" : "h3");
        title.textContent = heading[2];
        fragment.appendChild(title);
        return;
      }
      if (/^[-*]\s+/.test(trimmed)) {
        flushParagraph();
        if (!list) {
          list = document.createElement("ul");
          fragment.appendChild(list);
        }
        var item = document.createElement("li");
        item.textContent = trimmed.replace(/^[-*]\s+/, "");
        list.appendChild(item);
        return;
      }
      list = null;
      paragraph.push(trimmed);
    });
    flushParagraph();
    content.replaceChildren(fragment);
  }

  function apply(data) {
    if (!data || typeof data.value !== "string") return;
    render(data.value);
    var updated = document.getElementById("terms-updated");
    if (updated && data.updated_at) {
      var date = new Date(data.updated_at);
      if (!Number.isNaN(date.getTime())) {
        updated.textContent = "Last updated: " + date.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
      }
    }
  }

  try {
    var cached = JSON.parse(sessionStorage.getItem(CACHE_KEY) || "null");
    apply(cached);
  } catch (error) {}

  fetch(url + "/rest/v1/site_settings?select=value,updated_at&key=eq.terms_of_service", {
    headers: { apikey: key, Authorization: "Bearer " + key }
  }).then(function (response) {
    if (!response.ok) return null;
    return response.json();
  }).then(function (rows) {
    if (!rows || !rows.length) return;
    apply(rows[0]);
    try { sessionStorage.setItem(CACHE_KEY, JSON.stringify(rows[0])); } catch (error) {}
  }).catch(function () {});
})();
