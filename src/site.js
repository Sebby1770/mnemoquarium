/* The website stays light: no engine or WebGL until the visitor opens Play.
   Old sea links at the site root still go directly to the same sea. */
import { dailyPhrase } from "./daily.js";

const params = new URLSearchParams(location.search);
if (params.has("phrase") || params.has("daily")) {
  location.replace(new URL(`./play.html${location.search}${location.hash}`, location.href));
}
const daily = document.getElementById("daily-phrase");
if (daily) daily.textContent = dailyPhrase();
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("./sw.js").catch(() => {}));
}
