// Cranium landing page.
//
// Who is looking comes from Yard Auth, never from code in this repo. One
// session covers the page and every service of the project:
//   app/__yard/auth/me                always 200: { authenticated, user_id, email, ... }
//   __yard/auth/logout?return=/       ends the Cranium session, not the Yard
//                                     account, and comes back to this page
// Signing in needs no endpoint of its own: the app is access=authenticated,
// so following a link to app/ sends an anonymous visitor through Yard Auth
// and back into the app.
//
// window.yard (injected by the edge through embed.js) supplies the Yard
// avatar and the pricing tier. Every URL is relative so the page works at
// <username>.yard.sh/cranium/, inside a /@sandbox/, and on a custom domain.
(function () {
  "use strict";

  // Resolve against the directory the page is served from, even when the URL
  // arrives without its trailing slash (/cranium rather than /cranium/).
  var base = location.href.split(/[?#]/)[0];
  if (!/\/$/.test(base) && !/\.html?$/.test(base)) base += "/";
  var APP = new URL("app/", base).href;
  var LOGOUT = new URL("__yard/auth/logout?return=/", base).href;

  var FLAG_COLORS = ["#E8431F", "#2D5BFF", "#3C8D2F", "#C99A06", "#0E9384", "#8E3FAF", "#D6457A", "#52606D"];

  function el(tag, attrs, kids) {
    var node = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === "text") node.textContent = attrs[k];
      else if (attrs[k] != null) node.setAttribute(k, attrs[k]);
    });
    (kids || []).forEach(function (kid) {
      if (kid) node.appendChild(kid);
    });
    return node;
  }

  // Same hash and palette as the app (ui.js colorOf), so a person's colour
  // matches in both.
  function colorOf(id) {
    var h = 0;
    for (var i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
    return FLAG_COLORS[h % FLAG_COLORS.length];
  }

  function avatar(who) {
    if (who.avatarUrl) return el("img", { class: "av", src: who.avatarUrl, alt: "", width: "30", height: "30" });
    var node = el("span", { class: "av", text: (who.name || "?").trim().charAt(0).toUpperCase() || "?" });
    node.style.setProperty("--c", colorOf(who.id || who.name));
    return node;
  }

  /* ----------------------------------------------------------------- auth */

  async function getJSON(path) {
    try {
      var res = await fetch(new URL(path, APP), {
        credentials: "same-origin",
        headers: { Accept: "application/json" },
        redirect: "error", // a gate redirect means "not signed in", not data
      });
      if (!res.ok) return null;
      return await res.json();
    } catch (err) {
      return null;
    }
  }

  async function ownership() {
    try {
      if (window.yard && typeof window.yard.ownership === "function") return await window.yard.ownership();
    } catch (err) {}
    return null;
  }

  async function whoIsHere() {
    var results = await Promise.all([getJSON("__yard/auth/me"), ownership()]);
    var session = results[0];
    var yardUser = results[1] && results[1].signed_in ? results[1].user : null;
    if (!session || !session.authenticated) return null;

    // The app's own profile holds the name people see on their cursor.
    var profile = await getJSON("api/me");
    return {
      id: session.user_id || "",
      name: (profile && profile.name) || (session.email ? session.email.split("@")[0] : "") || "you",
      email: session.email || "",
      entitlement: session.entitlement || "none",
      avatarUrl: yardUser && yardUser.avatar_url ? yardUser.avatar_url : "",
    };
  }

  var slot = document.getElementById("auth");

  function renderSignedOut() {
    slot.replaceChildren(el("a", { class: "btn btn--sm", href: APP, text: "Log in" }));
  }

  function renderSignedIn(who) {
    var trigger = el(
      "button",
      { class: "me", type: "button", "aria-haspopup": "menu", "aria-expanded": "false", "aria-controls": "meMenu" },
      [avatar(who), el("span", { class: "me-name", text: who.name })],
    );
    var menu = el("div", { class: "menu", id: "meMenu", role: "menu", hidden: "" }, [
      el("div", { class: "menu__head" }, [
        avatar(who),
        el("div", {}, [
          el("p", { class: "menu__name", text: who.name }),
          who.email ? el("p", { class: "menu__sub", text: who.email }) : null,
          who.entitlement === "owner" ? el("p", { class: "menu__sub", text: "Project owner" }) : null,
        ]),
      ]),
      el("a", { class: "menu__item", role: "menuitem", href: APP, text: "Open Cranium" }),
      el("a", { class: "menu__item", role: "menuitem", href: "https://yard.sh/library/security", text: "Connected apps" }),
      el("a", { class: "menu__item menu__item--quiet", role: "menuitem", href: LOGOUT, text: "Log out" }),
    ]);

    function setOpen(open) {
      menu.hidden = !open;
      trigger.setAttribute("aria-expanded", String(open));
    }
    trigger.addEventListener("click", function (e) {
      e.stopPropagation();
      setOpen(menu.hidden);
    });
    document.addEventListener("click", function (e) {
      if (!menu.hidden && !menu.contains(e.target)) setOpen(false);
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && !menu.hidden) {
        setOpen(false);
        trigger.focus();
      }
    });

    slot.replaceChildren(
      el("a", { class: "btn btn--sm btn--tomato", href: APP, text: "Open Cranium" }),
      el("div", { class: "me-wrap" }, [trigger, menu]),
    );

    // The rest of the page greets them too.
    document.getElementById("heroCta").textContent = "Back to your documents";
    document.getElementById("planCta").textContent = "Open Cranium";
    document.getElementById("closerCta").textContent = "Back to your documents";
    var foot = document.getElementById("footAuth");
    foot.textContent = "Log out";
    foot.href = LOGOUT;
  }

  // Every link into the app points at the resolved app URL.
  document.querySelectorAll('a[href="app/"]').forEach(function (a) {
    a.href = APP;
  });

  whoIsHere().then(function (who) {
    if (who) renderSignedIn(who);
    else renderSignedOut();
  });

  /* -------------------------------------------------------------- pricing */

  // The one free tier, from the project's own data. The copy in the HTML is
  // the fallback when window.yard.project isn't there (a local preview
  // without project data).
  function fillPricing() {
    var project = window.yard && window.yard.project;
    var tier = project && project.tiers && (project.tiers.find(function (t) { return t.is_default; }) || project.tiers[0]);
    if (!tier) return false;
    document.getElementById("planName").textContent = tier.name;
    document.getElementById("planPrice").textContent =
      tier.price_cents ? "$" + (tier.price_cents / 100).toFixed(tier.price_cents % 100 ? 2 : 0) : "$0";
    if (tier.description) document.getElementById("planDesc").textContent = tier.description;
    if (tier.features && tier.features.length) {
      document.getElementById("planFeatures").replaceChildren.apply(
        document.getElementById("planFeatures"),
        tier.features.map(function (f) {
          return el("li", { text: f });
        }),
      );
    }
    return true;
  }
  // embed.js may land after this script; give it a moment.
  var tries = 0;
  (function waitForYard() {
    if (fillPricing() || ++tries > 40) return;
    setTimeout(waitForYard, 100);
  })();

  /* ---------------------------------------------------------------- theme */

  var themeBtn = document.getElementById("theme");
  function currentTheme() {
    return document.documentElement.dataset.theme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  }
  function paintTheme() {
    themeBtn.setAttribute("aria-label", currentTheme() === "dark" ? "Switch to light" : "Switch to dark");
  }
  themeBtn.addEventListener("click", function () {
    var next = currentTheme() === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem("cranium.theme", next);
    } catch (err) {}
    paintTheme();
  });
  paintTheme();

  /* ------------------------------------------------------------------ nav */

  var nav = document.getElementById("nav");
  function onScroll() {
    nav.classList.toggle("stuck", window.scrollY > 8);
  }
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  /* ----------------------------------------------------------------- demo */

  // Two pretend collaborators take turns in the hero document: type a line,
  // tick a box, type a quote, then start over. It only runs while the demo
  // is on screen, the tab is visible, and the visitor hasn't asked for less
  // motion.
  var carets = {
    ines: document.querySelector('.lp-caret[data-who="ines"]'),
    sam: document.querySelector('.lp-caret[data-who="sam"]'),
  };
  var typed = document.querySelectorAll(".demo .typed");
  var boxes = document.querySelectorAll(".demo .box");
  var SCRIPT = [
    { who: "ines", type: 0, text: " Bring boots." },
    { who: "sam", type: 1, text: " (not decaf)" },
    { who: "sam", check: 0 },
    { who: "ines", type: 2, text: "A lake swim at 7am, for the brave" },
    { who: "ines", check: 2 },
    { who: "sam", type: 3, text: "Nobody opens a laptop. Except this one." },
    { pause: 2600 },
    { reset: true },
  ];

  var reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  var visible = false;
  var step = 0;
  var timer = 0;

  // Puts a collaborator's caret right after `node`, or at the end of the
  // label beside a checkbox.
  function place(who, node) {
    var caret = carets[who];
    if (node.classList.contains("box")) node.nextElementSibling.append(caret);
    else node.after(caret);
    caret.classList.remove("is-typing");
    void caret.offsetWidth;
    caret.classList.add("is-typing");
  }

  function run() {
    clearTimeout(timer);
    if (!visible || document.hidden) return;
    var s = SCRIPT[step];
    step = (step + 1) % SCRIPT.length;

    if (s.pause) return (timer = setTimeout(run, s.pause));
    if (s.reset) {
      typed.forEach(function (t) {
        t.textContent = "";
      });
      boxes.forEach(function (b) {
        b.classList.remove("is-checked");
      });
      place("ines", typed[0]);
      place("sam", typed[1]);
      return (timer = setTimeout(run, 900));
    }
    if (s.check !== undefined) {
      var box = boxes[s.check];
      place(s.who, box);
      box.classList.add("is-checked");
      return (timer = setTimeout(run, 700));
    }
    var target = typed[s.type];
    place(s.who, target);
    var i = 0;
    (function tick() {
      // Scrolled away mid-line: start over cleanly when it's back.
      if (!visible || document.hidden) return (step = SCRIPT.length - 1);
      target.textContent = s.text.slice(0, ++i);
      if (i < s.text.length) timer = setTimeout(tick, 45 + Math.random() * 70);
      else timer = setTimeout(run, 650);
    })();
  }

  if (reduced) {
    // Show the finished page instead of the animation.
    SCRIPT.forEach(function (s) {
      if (s.type !== undefined) typed[s.type].textContent = s.text;
      if (s.check !== undefined) boxes[s.check].classList.add("is-checked");
    });
  } else if ("IntersectionObserver" in window) {
    new IntersectionObserver(function (entries) {
      visible = entries[0].isIntersecting;
      if (visible) run();
      else clearTimeout(timer);
    }).observe(document.querySelector(".demo"));
    document.addEventListener("visibilitychange", function () {
      if (!document.hidden) run();
    });
  }
})();
