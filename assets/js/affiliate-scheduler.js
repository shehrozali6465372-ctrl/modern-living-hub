/**
 * Modern Living Hub — Affiliate Product URL Manager.
 * All privileged Agent scheduler requests are proxied by the Hub backend.
 * Draft creation is non-publishing; activation is an explicit separate action.
 */
(function () {
  "use strict";
  var BACKEND = (window.BACKEND_URL || "").replace(/\/+$/, "");
  var TOKEN_KEY = "mlh_session_token";
  var SCHEDULE_KEY = "mlh_affiliate_schedule_id";
  var form = document.getElementById("affiliate-scheduler-form");
  var sources = document.getElementById("affiliate-scheduler-sources");
  var addButton = document.getElementById("affiliate-add-source");
  var result = document.getElementById("affiliate-scheduler-result");
  var controls = document.getElementById("affiliate-schedule-controls");
  var status = document.getElementById("affiliate-schedule-status");
  var activeScheduleId = localStorage.getItem(SCHEDULE_KEY);
  var sourceCount = 0;

  if (!form || !sources) return;
  function authHeaders() {
    var token = localStorage.getItem(TOKEN_KEY);
    return token ? { Authorization: "Bearer " + token, "Content-Type": "application/json" } : { "Content-Type": "application/json" };
  }
  function setMessage(el, message, isError) {
    if (!el) return;
    el.textContent = message;
    el.style.color = isError ? "var(--color-error)" : "var(--color-text-light)";
  }
  function addSource() {
    if (sourceCount >= 10) return;
    sourceCount += 1;
    var card = document.createElement("fieldset");
    card.className = "form-group affiliate-source-card";
    card.style.cssText = "border:1px solid var(--color-border,#ddd);border-radius:8px;padding:1rem;margin:.75rem 0;";
    var legend = document.createElement("legend");
    legend.textContent = "Product " + sourceCount;
    card.appendChild(legend);
    [
      ["Product name", "product_name", "e.g. 3-Tier Spice Rack Organizer", "text"],
      ["Product details", "product_details", "Describe the product and useful features", "textarea"],
      ["Affiliate tracking URL", "affiliate_url", "https://www.amazon.com/dp/...?tag=yourtag-20", "url"]
    ].forEach(function (field) {
      var label = document.createElement("label");
      label.textContent = field[0];
      label.style.display = "block";
      label.style.marginTop = ".5rem";
      var input = field[3] === "textarea" ? document.createElement("textarea") : document.createElement("input");
      input.name = field[1];
      input.required = true;
      input.placeholder = field[2];
      input.style.width = "100%";
      if (field[3] !== "textarea") input.type = field[3];
      if (field[1] === "affiliate_url") input.maxLength = 4096;
      card.appendChild(label);
      card.appendChild(input);
    });
    if (sourceCount > 1) {
      var remove = document.createElement("button");
      remove.type = "button";
      remove.className = "btn btn-secondary";
      remove.textContent = "Remove product";
      remove.addEventListener("click", function () {
        card.remove();
        sourceCount -= 1;
        Array.from(sources.querySelectorAll("legend")).forEach(function (item, index) { item.textContent = "Product " + (index + 1); });
        addButton.disabled = sourceCount >= 10;
      });
      card.appendChild(remove);
    }
    sources.appendChild(card);
    addButton.disabled = sourceCount >= 10;
  }
  function sourcePayload() {
    return Array.from(sources.querySelectorAll(".affiliate-source-card")).map(function (card) {
      return {
        product_name: card.querySelector('[name="product_name"]').value.trim(),
        product_details: card.querySelector('[name="product_details"]').value.trim(),
        affiliate_url: card.querySelector('[name="affiliate_url"]').value
      };
    });
  }
  async function api(path, options) {
    var response = await fetch(BACKEND + path, Object.assign({ credentials: "include", headers: authHeaders() }, options || {}));
    var data = await response.json().catch(function () { return {}; });
    if (!response.ok) throw new Error(data.error || "Request failed (HTTP " + response.status + ").");
    return data;
  }
  async function refreshSchedule() {
    if (!activeScheduleId) return;
    try {
      var data = await api("/api/pinterest/affiliate-schedules/" + encodeURIComponent(activeScheduleId));
      controls.style.display = "block";
      status.textContent = "Schedule #" + data.schedule_id + " — " + data.status +
        " | " + data.source_count + " products | " + data.daily_pin_limit + " Pins/day | " +
        data.starts_on + " to " + data.ends_on + " (" + data.timezone + "). Job counts: " +
        JSON.stringify(data.job_counts || {});
      document.getElementById("affiliate-activate-schedule").disabled = data.status !== "draft";
      document.getElementById("affiliate-pause-schedule").disabled = data.status !== "active";
    } catch (error) {
      setMessage(status, error.message, true);
      controls.style.display = "block";
    }
  }
  addButton.addEventListener("click", addSource);
  form.addEventListener("submit", async function (event) {
    event.preventDefault();
    if (!BACKEND || !localStorage.getItem(TOKEN_KEY)) {
      setMessage(result, "Connect Pinterest first. The Hub session is required.", true);
      return;
    }
    var payload = {
      timezone: document.getElementById("affiliate-schedule-timezone").value.trim(),
      starts_on: document.getElementById("affiliate-schedule-start").value,
      days: Number(document.getElementById("affiliate-schedule-days").value),
      daily_pin_limit: Number(document.getElementById("affiliate-schedule-daily-limit").value),
      board_name: document.getElementById("affiliate-schedule-board").value.trim(),
      board_description: document.getElementById("affiliate-schedule-board-description").value.trim(),
      sources: sourcePayload()
    };
    if (!payload.starts_on || payload.sources.length < 1 || payload.sources.length > 10) {
      setMessage(result, "Choose a start date and add between 1 and 10 complete product sources.", true);
      return;
    }
    setMessage(result, "Saving draft… no Pins will be published.", false);
    try {
      var data = await api("/api/pinterest/affiliate-schedules", { method: "POST", body: JSON.stringify(payload) });
      activeScheduleId = String(data.schedule_id);
      localStorage.setItem(SCHEDULE_KEY, activeScheduleId);
      setMessage(result, "Draft saved. " + data.source_count + " products stored; " + data.jobs_created + " jobs queued. Publishing has not started.", false);
      await refreshSchedule();
    } catch (error) {
      setMessage(result, error.message, true);
    }
  });
  document.getElementById("affiliate-activate-schedule").addEventListener("click", async function () {
    if (!activeScheduleId || !window.confirm("Activate this schedule? The worker will publish Pins as jobs become due. This is a real Pinterest publishing authorization.")) return;
    try {
      var data = await api("/api/pinterest/affiliate-schedules/" + encodeURIComponent(activeScheduleId) + "/activate", { method: "POST", body: "{}" });
      setMessage(status, "Schedule activated; " + data.jobs_created + " jobs queued. Actual Pins will publish later as the worker processes due jobs.", false);
      await refreshSchedule();
    } catch (error) { setMessage(status, error.message, true); }
  });
  document.getElementById("affiliate-pause-schedule").addEventListener("click", async function () {
    if (!activeScheduleId || !window.confirm("Pause this schedule and cancel all queued jobs? An in-flight Pin may still finish.")) return;
    try {
      await api("/api/pinterest/affiliate-schedules/" + encodeURIComponent(activeScheduleId) + "/pause", { method: "POST", body: "{}" });
      await refreshSchedule();
    } catch (error) { setMessage(status, error.message, true); }
  });
  document.getElementById("affiliate-refresh-schedule").addEventListener("click", refreshSchedule);
  var dateInput = document.getElementById("affiliate-schedule-start");
  if (dateInput) {
    var zone = document.getElementById("affiliate-schedule-timezone").value || "America/New_York";
    var parts = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
    var dateParts = {};
    parts.forEach(function (part) { dateParts[part.type] = part.value; });
    dateInput.value = dateParts.year + "-" + dateParts.month + "-" + dateParts.day;
  }
  addSource();
  if (activeScheduleId) refreshSchedule();
})();
