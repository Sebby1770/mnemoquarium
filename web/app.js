const canvas = document.getElementById("tank");
const phraseInput = document.getElementById("phrase");
const seedInput = document.getElementById("seed");
const popInput = document.getElementById("population");
const speedInput = document.getElementById("speed");
const inspectEl = document.getElementById("inspect");

const view = new AquariumView(canvas);
const compareA = new AquariumView(document.getElementById("tank-a"));
const compareB = new AquariumView(document.getElementById("tank-b"));

let world = World.fromPhrase(phraseInput.value, { population: Number(popInput.value) });
let playing = true;
let lastStep = 0;

function delay() {
  return 420 - Number(speedInput.value) * 18;
}

function growFromForm() {
  world = World.fromPhrase(phraseInput.value, {
    seed: seedInput.value === "" ? undefined : Number(seedInput.value),
    population: Number(popInput.value) || 28,
  });
  view.attach(world);
  paintHud();
}

function paintHud() {
  const census = world.census();
  document.getElementById("kpis").innerHTML = [
    ["Tick", census.tick],
    ["Season", census.season],
    ["Population", census.population],
    ["Nutrients", census.nutrient_total],
    ["Mutations", census.mutations],
    ["Predations", census.predations],
  ].map(([k, v]) => `<div class="kpi"><strong>${v}</strong><span>${k}</span></div>`).join("");

  document.getElementById("legend").innerHTML = census.species
    .slice()
    .sort((a, b) => b.population - a.population)
    .map((sp) => {
      const kind = typeof fishKind === "function" ? fishKind(sp) : "";
      return `
      <div class="sp">
        <span class="dot" style="background:hsl(${sp.hue} 78% 56%)"></span>
        <span>${sp.glyph} ${sp.name} · ${sp.population}</span>
        <span class="kind">${kind || ""}</span>
      </div>`;
    }).join("");

  const events = world.events.length ? world.events : ["the brine is quiet"];
  document.getElementById("events").innerHTML = events.map((e) => `<li>${e}</li>`).join("");
}

view.onPick = (vis) => {
  if (!vis) {
    inspectEl.hidden = true;
    inspectEl.innerHTML = "";
    return;
  }
  const sp = vis.sp;
  inspectEl.hidden = false;
  inspectEl.innerHTML = `
    <strong>${sp.name}</strong>
    ${fishKind(sp)} from “${sp.source_word}”<br>
    energy ${vis.org.energy} · age ${vis.org.age}<br>
    eat ${sp.appetite} · curious ${sp.curiosity}
  `;
};

function loop(now) {
  if (playing && now - lastStep >= delay()) {
    world.step();
    paintHud();
    lastStep = now;
  }
  view.stepVisual(now);
  view.draw(now);
  if (compareA.world) {
    compareA.stepVisual(now);
    compareA.draw(now);
  }
  if (compareB.world) {
    compareB.stepVisual(now);
    compareB.draw(now);
  }
  requestAnimationFrame(loop);
}

document.getElementById("seed-form").addEventListener("submit", (event) => {
  event.preventDefault();
  growFromForm();
});
document.getElementById("btn-play").addEventListener("click", (event) => {
  playing = !playing;
  event.target.textContent = playing ? "Pause" : "Play";
});
document.getElementById("btn-step").addEventListener("click", () => {
  playing = false;
  document.getElementById("btn-play").textContent = "Play";
  world.step();
  paintHud();
});
document.getElementById("btn-feed").addEventListener("click", () => view.feed());
document.getElementById("btn-lights").addEventListener("click", (event) => {
  view.lights = !view.lights;
  event.target.textContent = view.lights ? "Lights" : "Lights (off)";
});
document.getElementById("btn-tap").addEventListener("click", () => {
  const water = view.waterRect();
  view.tap(water.x + water.w * 0.5, water.y + water.h * 0.35);
});
document.getElementById("btn-full").addEventListener("click", async () => {
  const cabinet = document.querySelector(".cabinet");
  if (!document.fullscreenElement) await cabinet.requestFullscreen();
  else await document.exitFullscreen();
});
canvas.addEventListener("click", (event) => {
  const pt = view.eventToLocal(event);
  const hit = view.pickAt(pt.x, pt.y);
  if (!hit) view.tap(pt.x, pt.y);
});
window.addEventListener("resize", () => {
  view.resize();
  compareA.resize();
  compareB.resize();
});
document.addEventListener("fullscreenchange", () => {
  view.resize();
});

document.getElementById("btn-share").addEventListener("click", async () => {
  const url = new URL(location.href);
  url.hash = new URLSearchParams({
    phrase: phraseInput.value,
    seed: seedInput.value,
    pop: popInput.value,
  }).toString();
  history.replaceState(null, "", url);
  try {
    await navigator.clipboard.writeText(url.toString());
    document.getElementById("btn-share").textContent = "Copied";
    setTimeout(() => { document.getElementById("btn-share").textContent = "Copy share link"; }, 1400);
  } catch {
    prompt("Copy this tank URL", url.toString());
  }
});

document.getElementById("btn-compare").addEventListener("click", () => {
  const steps = Number(document.getElementById("compare-steps").value) || 48;
  const a = World.fromPhrase(document.getElementById("phrase-a").value);
  const b = World.fromPhrase(document.getElementById("phrase-b").value);
  for (let i = 0; i < steps; i += 1) {
    a.step();
    b.step();
  }
  document.getElementById("label-a").textContent = a.phrase;
  document.getElementById("label-b").textContent = b.phrase;
  compareA.attach(a);
  compareB.attach(b);
  compareA.resize();
  compareB.resize();
  document.getElementById("compare-out").textContent = compareWorlds(a, b);
});

const boot = new URLSearchParams(location.hash.replace(/^#/, ""));
if (boot.get("phrase")) phraseInput.value = boot.get("phrase");
if (boot.get("seed")) seedInput.value = boot.get("seed");
if (boot.get("pop")) popInput.value = boot.get("pop");
growFromForm();
requestAnimationFrame(loop);
