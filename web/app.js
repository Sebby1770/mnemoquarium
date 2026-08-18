const canvas = document.getElementById("tank");
const ctx = canvas.getContext("2d");
const phraseInput = document.getElementById("phrase");
const seedInput = document.getElementById("seed");
const popInput = document.getElementById("population");
const speedInput = document.getElementById("speed");

let world = World.fromPhrase(phraseInput.value, { population: Number(popInput.value) });
let playing = true;
let last = 0;

function delay() {
  return 420 - Number(speedInput.value) * 18;
}

function growFromForm() {
  world = World.fromPhrase(phraseInput.value, {
    seed: seedInput.value === "" ? undefined : Number(seedInput.value),
    population: Number(popInput.value) || 28,
  });
  draw();
}

function draw() {
  const w = canvas.width;
  const h = canvas.height;
  const cellW = w / world.width;
  const cellH = h / world.height;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "#061318";
  ctx.fillRect(0, 0, w, h);

  for (let y = 0; y < world.height; y += 1) {
    for (let x = 0; x < world.width; x += 1) {
      const n = world.nutrients[y][x];
      const light = 8 + n * 6;
      ctx.fillStyle = `hsla(185, 42%, ${light}%, ${0.18 + n * 0.07})`;
      ctx.fillRect(x * cellW, y * cellH, cellW + 0.5, cellH + 0.5);
    }
  }

  const groups = new Map();
  for (const org of world.organisms) {
    const key = `${org.x},${org.y}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(org);
  }
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  groups.forEach((list, key) => {
    const [x, y] = key.split(",").map(Number);
    const top = list.slice().sort((a, b) => b.energy - a.energy)[0];
    const sp = world.species[top.species_index];
    const cx = x * cellW + cellW / 2;
    const cy = y * cellH + cellH / 2;
    const r = Math.max(3, Math.min(cellW * 0.46, 2 + top.energy * 0.12));
    ctx.fillStyle = `hsl(${sp.hue} 78% 56%)`;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#071014";
    ctx.font = `700 ${Math.max(9, Math.floor(cellW * 0.62))}px ui-monospace, monospace`;
    ctx.fillText(sp.glyph, cx, cy + 0.5);
    if (list.length > 1) {
      ctx.fillStyle = "#e2e8f0";
      ctx.font = "700 10px ui-monospace, monospace";
      ctx.fillText(String(list.length), cx + r * 0.7, cy - r * 0.7);
    }
  });

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
    .map((sp) => `
      <div class="sp">
        <span class="dot" style="background:hsl(${sp.hue} 78% 56%)"></span>
        <span>${sp.glyph} ${sp.name} · ${sp.population} · from ${sp.source_word}</span>
      </div>`).join("");

  const events = world.events.length ? world.events : ["the brine is quiet"];
  document.getElementById("events").innerHTML = events.map((e) => `<li>${e}</li>`).join("");
}

function tick(now) {
  if (playing && now - last >= delay()) {
    world.step();
    draw();
    last = now;
  }
  requestAnimationFrame(tick);
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
  draw();
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
  document.getElementById("compare-out").textContent = compareWorlds(a, b);
});

const boot = new URLSearchParams(location.hash.replace(/^#/, ""));
if (boot.get("phrase")) phraseInput.value = boot.get("phrase");
if (boot.get("seed")) seedInput.value = boot.get("seed");
if (boot.get("pop")) popInput.value = boot.get("pop");
growFromForm();
requestAnimationFrame(tick);
