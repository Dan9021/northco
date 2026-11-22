(function () {
  var url = "https://vanjowcvzvqkzbdxwunb.supabase.co";
  var key = "sb_publishable_GYpISpry5P7Ntnru55ZS3A_a7b3N4hq";
  var CACHE_KEY = "northco-notice";
  var notice = document.querySelector(".notice");
  if (!notice) return;

  // Show the last known text straight away so the banner doesn't flash the default before the fetch returns.
  try {
    var cached = sessionStorage.getItem(CACHE_KEY);
    if (cached) notice.textContent = cached;
  } catch (e) {}

  fetch(url + "/rest/v1/site_settings?select=value&key=eq.navbar_notice", {
    headers: {
      apikey: key,
      Authorization: "Bearer " + key
    }
  }).then(function (response) {
    if (!response.ok) return null;
    return response.json();
  }).then(function (rows) {
    if (!rows || !rows.length || typeof rows[0].value !== "string") return;
    notice.textContent = rows[0].value;
    try { sessionStorage.setItem(CACHE_KEY, rows[0].value); } catch (e) {}
  }).catch(function () {});
})();
