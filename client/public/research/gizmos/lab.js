const lab = document.querySelector("#gizmo-lab");

const recipe = `{
  "version": 1,
  "widget": "spotlight",
  "title": "Passing the lantern",
  "seats": ["Mira", "Otto", "Sable", "Kit"],
  "advance": "table"
}`;
const defaultRule = "add 1\ncap 6";
const sample = JSON.parse(recipe);
const manifestKeys = new Set(Object.keys(sample));

function validLabel(text) {
  return Object.prototype.toString.call(text) === "[object String]" && text.trim().length > 0;
}

function parseManifest(source) {
  if (source.length > 2048) throw new Error("The manifest must fit within 2,048 characters.");
  let value;
  try {
    value = JSON.parse(source);
  } catch {
    throw new Error("Check the JSON punctuation, then install again.");
  }
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error("Use one JSON object for this Gizmo.");
  }
  const extra = Object.keys(value).find((key) => !manifestKeys.has(key));
  if (extra !== undefined)
    throw new Error(`Unknown field “${extra}”. Use the fields in the sample.`);
  if (value.version !== 1 || value.widget !== "spotlight") {
    throw new Error('The catalog supports version 1 and widget "spotlight".');
  }
  if (!validLabel(value.title) || value.title.length > 40) {
    throw new Error("Give the Gizmo a title of 1–40 characters.");
  }
  if (
    !Array.isArray(value.seats) ||
    value.seats.length < 2 ||
    value.seats.length > 6 ||
    !value.seats.every((seat) => validLabel(seat) && seat.length <= 20)
  ) {
    throw new Error("Provide 2–6 seat names of 1–20 characters each.");
  }
  const seats = value.seats.map((seat) => seat.trim());
  if (new Set(seats).size !== seats.length) throw new Error("Give each seat a different name.");
  if (value.advance !== "owner" && value.advance !== "table") {
    throw new Error('Set advance to "owner" or "table".');
  }
  return { ...value, seats, title: value.title.trim() };
}

function parseRule(source) {
  const lines = source.trim().split(/\r?\n/u);
  if (source.length > 200 || lines.length > 4) throw new Error("Use up to four rule lines.");
  return lines.map((line, index) => {
    const tokens = /^(add|cap) (-?[0-6])$/u.exec(line.trim());
    if (!tokens || (tokens[1] === "cap" && Number(tokens[2]) < 0)) {
      throw new Error(
        `Line ${index + 1} needs add with an integer from -6 to 6, or cap with an integer from 0 to 6.`,
      );
    }
    return { op: tokens[1], amount: Number(tokens[2]) };
  });
}

function stepPressure(pressure, rule) {
  for (const { op, amount } of rule) {
    pressure = op === "add" ? pressure + amount : Math.min(pressure, amount);
  }
  return Math.max(0, Math.min(6, pressure));
}

lab.innerHTML = `
  <div class="lab-toolbar">
    <label for="lab-role">Try as
      <select id="lab-role"><option value="owner">Table owner</option><option value="player">Player</option></select>
    </label>
    <button type="button" id="lab-reset">Reset sandbox</button>
  </div>
  <section class="lab-unit" aria-labelledby="lab-install-title">
    <div class="lab-edit">
      <h3 id="lab-install-title">Install a spotlight tracker</h3>
      <p>Rename the seats and install the manifest. Set <code>advance</code> to <code>"owner"</code> to reserve the pass action for the table owner.</p>
      <label for="lab-manifest">Gizmo manifest</label>
      <textarea id="lab-manifest" maxlength="2048" rows="7" spellcheck="false" autocapitalize="off"></textarea>
      <button type="button" class="lab-action" id="lab-install">Install manifest</button>
      <span id="lab-install-status" role="status"></span>
    </div>
    <div class="lab-preview">
      <p class="lab-caption">On the table</p>
      <h4 id="lab-name"></h4>
      <p class="lab-help">Choose whoever just had a character moment. Their name moves to the back of the queue.</p>
      <ol id="lab-seats" aria-label="Spotlight order"></ol>
      <button type="button" id="lab-pass">Pass spotlight</button>
      <span id="lab-turn-status" role="status"></span>
    </div>
  </section>
  <section class="lab-unit" aria-labelledby="lab-rule-title">
    <div class="lab-edit">
      <h3 id="lab-rule-title">Attach a pressure rule</h3>
      <p>For this experiment, we link each pass to scene pressure. Try <code>add 2</code> followed by <code>cap 4</code>, or enter an unknown verb to test the interpreter.</p>
      <label for="lab-rule">On spotlight pass</label>
      <textarea id="lab-rule" maxlength="200" rows="3" spellcheck="false" autocapitalize="off"></textarea>
      <button type="button" class="lab-action" id="lab-apply">Apply rule</button>
      <span id="lab-rule-status" role="status"></span>
    </div>
    <div class="lab-preview lab-clock">
      <p class="lab-caption">Scene pressure</p>
      <p id="lab-value"></p>
      <div id="lab-ticks" aria-hidden="true"></div>
      <button type="button" id="lab-step">Pass and run rule</button>
      <span id="lab-effect" role="status"></span>
    </div>
  </section>`;

const el = (id) => lab.querySelector(`#lab-${id}`);
const manifest = el("manifest");
const source = el("rule");
const role = el("role");
let installed = sample;
let rule = parseRule(defaultRule);
let queue = [...sample.seats];
let pressure = 0;

function message(id, text, error = false) {
  const target = el(id);
  target.textContent = text;
  target.classList.toggle("lab-error", error);
}

const sceneMark = document.querySelector("#scene-mark");
const sceneResult = document.querySelector("#scene-result");
sceneMark.addEventListener("click", () => markMoment("Sable"));

function render() {
  const owner = role.value === "owner";
  manifest.readOnly = source.readOnly = !owner;
  el("install").disabled = el("apply").disabled = !owner;
  const canPass = owner || installed.advance === "table";
  sceneMark.disabled = !canPass || !queue.includes("Sable");
  sceneResult.textContent = `Spotlight order: ${queue.join(", ")}. Scene pressure: ${pressure} of 6.`;
  el("pass").disabled = el("step").disabled = !canPass;
  el("name").textContent = installed.title;
  el("seats").replaceChildren(
    ...queue.map((name, index) => {
      const item = document.createElement("li");
      const choose = document.createElement("button");
      choose.type = "button";
      choose.textContent = name;
      choose.setAttribute("aria-label", `Mark a character moment for ${name}`);
      choose.disabled = !canPass;
      choose.addEventListener("click", () => {
        markMoment(name);
        el("seats").lastElementChild.firstElementChild.focus();
      });
      item.append(choose);
      if (index === 0) item.setAttribute("aria-current", "step");
      return item;
    }),
  );
  el("value").textContent = `${pressure} / 6`;
  el("ticks").replaceChildren(
    ...Array.from({ length: 6 }, (_, i) => {
      const tick = document.createElement("span");
      tick.classList.toggle("lab-filled", i < pressure);
      return tick;
    }),
  );
  message(
    "turn-status",
    canPass ? `Next in line: ${queue[0]}.` : "The owner passes the spotlight at this table.",
  );
}

function reset() {
  role.value = "owner";
  installed = sample;
  manifest.value = recipe;
  source.value = defaultRule;
  rule = parseRule(source.value);
  queue = [...installed.seats];
  pressure = 0;
  message("install-status", "Sample installed.");
  message("rule-status", "Sample rule active.");
  message("effect", "Waiting for the first pass.");
  render();
}

el("install").addEventListener("click", () => {
  if (role.value !== "owner") return;
  try {
    installed = parseManifest(manifest.value);
    queue = [...installed.seats];
    render();
    message("install-status", "Installed. The queue follows the new seat order.");
  } catch (error) {
    message("install-status", error.message, true);
  }
});
el("apply").addEventListener("click", () => {
  if (role.value !== "owner") return;
  try {
    rule = parseRule(source.value);
    message("rule-status", "Rule active. Pass the spotlight to run it.");
  } catch (error) {
    message("rule-status", `${error.message} The previous rule remains active.`, true);
  }
});

function markMoment(name) {
  if (role.value !== "owner" && installed.advance !== "table") return;
  const before = pressure;
  queue = [...queue.filter((seat) => seat !== name), name];
  pressure = stepPressure(pressure, rule);
  render();
  message("effect", `${name} moved to the back. Pressure moved from ${before} to ${pressure}.`);
}

el("pass").addEventListener("click", () => markMoment(queue[0]));
el("step").addEventListener("click", () => markMoment(queue[0]));
role.addEventListener("change", render);
el("reset").addEventListener("click", reset);
reset();
