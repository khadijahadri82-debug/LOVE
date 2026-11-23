const poems = [
  {
    id: "biqudra",
    title: "على قدر أهل العزم",
    poet: "أبو الطيب المتنبي",
    excerpt: "على قدر أهل العزم تأتي العزائم، وتأتي على قدر الكرام المكارم.",
    verses: `على قدرِ أهلِ العزمِ تأتي العزائـمُ
وتأتي على قدرِ الكرامِ المكارمُ

وتعظمُ في عينِ الصغيرِ صغارُها
وتصغرُ في عينِ العظيمِ العظائـمُ`
  },
  {
    id: "nizar",
    title: "ألا أيها الليل",
    poet: "أبو الحسن الششتري",
    excerpt: "ألَا أيّها الليلُ أطلْ ثم صلْ، وأصبحتُ فيك على قلبٍ معلّق.",
    verses: `ألا أيّها الليلُ أطلْ ثم صِلْ
وبعضُ الوصالِ على القلبِ حُبْلُ

ففي هدوءِ الليلِ ترجعُ الأشواقُ
وتعرفُ أرواحُنا طرقَ المعنى`
  },
  {
    id: "maha",
    title: "رسالة من المطر",
    poet: "من وحي نسيم",
    excerpt: "إذا لمعت عيناك في المطر، فإني سأبقى قريباً من حلمك.",
    verses: `إذا لمعتْ عيناكِ في المطارِ
بعثتُ إليكِ بعضَ الكلامِ

فلا يطولُ غيابُ المسافاتِ
والقلبُ يعرفُ طريقَ العودة`
  },
  {
    id: "ghurob",
    title: "فوق القمر",
    poet: "الشاعر مجهول",
    excerpt: "ليت المسافات تعرف كم نشتاق، وليت القمر يحملها إليك.",
    verses: `ليتَ المسافاتِ تعرفُ كم نشتاقُ
وليتَ القمرَ يحملُ ما في القلبِ

فلا أنا من هذا الحضورِ بعيدةٌ
ولا أنتَ عن روحي أبداً غريبُ`
  },
  {
    id: "sukoon",
    title: "هدوء الليل",
    poet: "من وحي نسيم",
    excerpt: "في هدوء الليل، تصبح القصائد أقرب للقلب.",
    verses: `في هدوءِ الليلِ تصبحُ القصائـدُ
أقربَ إلى القلبِ من كلِّ الصدى

بعضُ الكلماتِ يشبهُ حضناً من بعيدٍ
وبعضُ السكوتِ يدلّنا إلى الندى`
  }
];

const app = document.getElementById("app");
const favoriteCount = document.getElementById("favoriteCount");
const poemsNav = document.getElementById("poemsNav");
const favoritesNav = document.getElementById("favoritesNav");
const favoritesLink = document.getElementById("favoritesLink");
const brandButton = document.getElementById("brandButton");

let favorites = loadFavorites();
let currentView = "poems";
let currentPoemId = null;
let searchQuery = "";
let disposeChat = null;

function loadFavorites() {
  try {
    return JSON.parse(localStorage.getItem("nasim-favorites")) || [];
  } catch {
    return [];
  }
}

function saveFavorites() {
  localStorage.setItem("nasim-favorites", JSON.stringify(favorites));
  updateFavoriteCount();
}

function updateFavoriteCount() {
  favoriteCount.textContent = favorites.length;
  favoriteCount.classList.remove("bump");
  void favoriteCount.offsetWidth;
  favoriteCount.classList.add("bump");
}

function heartIcon(saved = false) {
  return `<svg viewBox="0 0 24 24" aria-hidden="true" style="${saved ? "fill: currentColor" : ""}">
    <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78L12 21.23l8.84-8.84a5.5 5.5 0 0 0 0-7.78Z"/>
  </svg>`;
}

function poemCard(poem, index) {
  const saved = favorites.includes(poem.id);
  return `
    <article class="poem-card" style="animation-delay:${index * 55}ms">
      <div class="poem-card-header">
        <div>
          <h3>${poem.title}</h3>
          <p class="poet-name">${poem.poet}</p>
        </div>
        <button class="heart-button ${saved ? "saved" : ""}" type="button" data-favorite="${poem.id}" aria-label="${saved ? "حيدها من المفضلة" : "زيدها للمفضلة"}" aria-pressed="${saved}">
          ${heartIcon(saved)}
        </button>
      </div>
      <p class="excerpt">${poem.excerpt}</p>
      <button class="open-poem" type="button" data-open="${poem.id}">قرا القصيدة <span>←</span></button>
    </article>`;
}

function matchingPoems() {
  const query = searchQuery.trim().toLocaleLowerCase();
  if (!query) return poems;
  return poems.filter(poem =>
    [poem.title, poem.poet, poem.excerpt, poem.verses]
      .join(" ")
      .toLocaleLowerCase()
      .includes(query)
  );
}

function poemResultsMarkup(results) {
  if (!results.length) {
    return `<div class="empty-state"><p>ما لقيتش قصيدة بهاد الكلمات.</p></div>`;
  }
  return `<section class="poem-list">${results.map(poemCard).join("")}</section>`;
}

function disposePrivateChat() {
  if (!disposeChat) return;
  disposeChat();
  disposeChat = null;
}

function isPrivateChatRoute() {
  return location.pathname.replace(/\/+$/, "") === "/private-chat" || location.hash === "#private-chat";
}

function renderPoems() {
  disposePrivateChat();
  currentView = "poems";
  currentPoemId = null;
  updateNav();
  const results = matchingPoems();
  app.innerHTML = `
    <section class="hero">
      <p class="eyebrow">قصيدة اليوم</p>
      <h1>بعض الكلمات تشبه حضناً من بعيد.</h1>
    </section>
    <form class="poetry-search" id="poemSearchForm" role="search">
      <label for="poemSearch">بحث في القصائد</label>
      <div class="poetry-search-control">
        <input id="poemSearch" type="search" autocomplete="off" placeholder="العنوان، الشاعر أو كلمة من القصيدة" />
        <button class="poetry-search-submit" type="submit" aria-label="بحث">
          <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.8" cy="10.8" r="6.3"/><path d="m16 16 4.2 4.2"/></svg>
        </button>
      </div>
      <p class="poetry-search-error" id="poemSearchError" role="alert" hidden></p>
    </form>
    <div class="section-heading">
      <h2>قرا شي قصيدة</h2>
      <span id="poemResultCount">${results.length} قصائد</span>
    </div>
    <div id="poemResults">${poemResultsMarkup(results)}</div>`;
  document.getElementById("poemSearch").value = searchQuery;
  syncHash();
  app.focus({ preventScroll: true });
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function updatePoemSearchResults() {
  const results = matchingPoems();
  const resultsElement = document.getElementById("poemResults");
  const countElement = document.getElementById("poemResultCount");
  if (!resultsElement || !countElement) return;
  resultsElement.innerHTML = poemResultsMarkup(results);
  countElement.textContent = `${results.length} قصائد`;
}

function renderFavorites() {
  disposePrivateChat();
  currentView = "favorites";
  currentPoemId = null;
  updateNav();
  const savedPoems = poems.filter(poem => favorites.includes(poem.id));
  app.innerHTML = `
    <section class="favorites-hero">
      <h1>أجمل ما أحببت</h1>
      <p>القصائد اللي خلاو في قلبك شي حكاية.</p>
    </section>
    ${savedPoems.length
      ? `<section class="poem-list">${savedPoems.map(poemCard).join("")}</section>`
      : `<div class="empty-state">
          <div>
            ${heartIcon()}
            <p>ما زال ما اختاريتي شي قصيدة.<br>اضغط القلب قريب للي يلامس قلبك.</p>
          </div>
        </div>`}`;
  syncHash();
  app.focus({ preventScroll: true });
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function renderReader(poemId) {
  disposePrivateChat();
  const poem = poems.find(item => item.id === poemId);
  if (!poem) {
    renderPoems();
    return;
  }

  currentView = "reader";
  currentPoemId = poem.id;
  const saved = favorites.includes(poem.id);
  updateNav();
  app.innerHTML = `
    <article class="reader">
      <div class="reader-toolbar">
        <button class="back-button" type="button" id="backButton"><span>→</span> رجع للقصائد</button>
        <button class="heart-button ${saved ? "saved" : ""}" type="button" data-favorite="${poem.id}" aria-label="${saved ? "حيدها من المفضلة" : "زيدها للمفضلة"}" aria-pressed="${saved}">
          ${heartIcon(saved)}
        </button>
      </div>
      <div class="reader-body">
        <h1>${poem.title}</h1>
        <p class="poet-name">${poem.poet}</p>
        <p class="poem-verses">${poem.verses}</p>
      </div>
    </article>`;
  syncHash();
  app.focus({ preventScroll: true });
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function renderPrivateChat(accessCode = "") {
  disposePrivateChat();
  currentView = "chat";
  currentPoemId = null;
  updateNav();
  const template = document.getElementById("privateChatTemplate");
  app.replaceChildren(template.content.cloneNode(true));
  syncHash();
  app.focus({ preventScroll: true });
  window.scrollTo({ top: 0, behavior: "smooth" });

  const chatRoot = app.querySelector(".private-chat");
  if (typeof window.initPrivateChat !== "function") {
    document.getElementById("pageError").textContent = "تعذّر تحميل المحادثة. أعد تحميل الصفحة.";
    document.getElementById("pageError").hidden = false;
    return;
  }
  disposeChat = window.initPrivateChat(chatRoot, accessCode);
}

function syncHash() {
  if (currentView === "chat") {
    history.replaceState(null, "", "/#private-chat");
  } else if (currentView === "favorites") {
    history.replaceState(null, "", "/#favorites");
  } else if (currentView === "reader") {
    history.replaceState(null, "", `/#poem=${currentPoemId}`);
  } else {
    history.replaceState(null, "", "/");
  }
}

function updateNav() {
  poemsNav.classList.toggle("active", currentView === "poems");
  favoritesNav.classList.toggle("active", currentView === "favorites");
}

function toggleFavorite(id, button) {
  const index = favorites.indexOf(id);
  if (index >= 0) {
    favorites.splice(index, 1);
  } else {
    favorites.push(id);
  }
  saveFavorites();

  button.classList.remove("pop");
  void button.offsetWidth;
  button.classList.add("pop");

  const saved = favorites.includes(id);
  button.classList.toggle("saved", saved);
  button.setAttribute("aria-pressed", String(saved));
  button.setAttribute("aria-label", saved ? "حيدها من المفضلة" : "زيدها للمفضلة");
  button.innerHTML = heartIcon(saved);

  if (currentView === "favorites") {
    renderFavorites();
  }
}

app.addEventListener("input", event => {
  if (event.target.id !== "poemSearch") return;
  searchQuery = event.target.value;
  updatePoemSearchResults();
});

app.addEventListener("submit", async event => {
  const form = event.target.closest("#poemSearchForm");
  if (!form) return;
  event.preventDefault();

  const searchInput = form.querySelector("#poemSearch");
  const searchError = form.querySelector("#poemSearchError");
  const submitButton = form.querySelector(".poetry-search-submit");
  if (submitButton.disabled) return;
  const candidate = searchInput.value.trim();
  searchQuery = searchInput.value;
  searchError.hidden = true;

  if (/^CHAT_TOKEN_[12](?:=.*)?$/i.test(candidate)
    || /^replace-with-(?:a-unique|a-different)-64-character-hex-token$/i.test(candidate)) {
    searchError.textContent = "انسخ قيمة الرمز بعد علامة = من ملف .env، وليس اسم المتغير أو القيمة النموذجية في .env.example.";
    searchError.hidden = false;
    return;
  }

  if (/^[A-Z0-9]{4}$/.test(candidate) || /^[A-Fa-f0-9]{64}$/.test(candidate)) {
    submitButton.disabled = true;
    try {
      const response = await fetch("/api/private-route", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ code: candidate })
      });
      const result = await response.json();
      if (!response.ok) throw new Error(window.getApiErrorMessage(result?.error, "تعذّر التحقق من الرمز. حاول مرة أخرى."));
      if (result.openChat) {
        searchQuery = "";
        renderPrivateChat(candidate);
        return;
      }
    } catch (error) {
      searchError.textContent = window.getApiErrorMessage(error?.message, "تعذّر التحقق من الرمز. حاول مرة أخرى.");
      searchError.hidden = false;
    } finally {
      submitButton.disabled = false;
    }
  }
  updatePoemSearchResults();
});

app.addEventListener("click", event => {
  const favoriteButton = event.target.closest("[data-favorite]");
  if (favoriteButton) {
    toggleFavorite(favoriteButton.dataset.favorite, favoriteButton);
    return;
  }

  const openButton = event.target.closest("[data-open]");
  if (openButton) {
    renderReader(openButton.dataset.open);
    return;
  }

  if (event.target.closest("#backButton")) {
    renderPoems();
  }
});

poemsNav.addEventListener("click", renderPoems);
favoritesNav.addEventListener("click", renderFavorites);
favoritesLink.addEventListener("click", renderFavorites);
brandButton.addEventListener("click", renderPoems);

window.addEventListener("popstate", () => {
  if (isPrivateChatRoute()) renderPrivateChat();
  else if (location.hash === "#favorites") renderFavorites();
  else if (location.hash.startsWith("#poem=")) renderReader(location.hash.split("=")[1]);
  else renderPoems();
});

updateFavoriteCount();

if (isPrivateChatRoute()) {
  renderPrivateChat();
} else if (location.hash === "#favorites") {
  renderFavorites();
} else if (location.hash.startsWith("#poem=")) {
  renderReader(location.hash.split("=")[1]);
} else {
  renderPoems();
}
