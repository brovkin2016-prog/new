// Winger for Windows' window: opened by its key, a link added, on through a real server, the programs list, the journal
const { chromium } = require("playwright");
const fs = require("fs");
(async () => {
  const token = fs.readFileSync(process.env.WDATA + "/ui-token", "utf8").trim();
  const browser = await chromium.launch({ args: ["--no-proxy-server"] });
  const ctx = await browser.newContext({ viewport: { width: 440, height: 860 }, colorScheme: process.env.DARK ? "dark" : "light",
    permissions: ["clipboard-read", "clipboard-write"] });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  let ok = true;
  const want = (c, what) => { if (!c) { ok = false; console.log("FAIL", what); } };
  try {
    const bare = await page.goto("http://127.0.0.1:47710/");
    want(bare.status() === 403, "without the key: refused");
    await page.goto("http://127.0.0.1:47710/?t=wrong");
    want((await page.content()).includes("Откройте Winger"), "a wrong key: refused");
    await page.goto("http://127.0.0.1:47710/?t=" + token);
    await page.waitForSelector("text=Пока ни одного");
    await page.click("#add");
    await page.fill(".sheet textarea", "Ваш VPN:\n" + process.env.WLINK + "\nИмпорт — в Winger");
    await page.click(".sheet button:has-text('Добавить')");
    await page.waitForSelector(".toast:has-text('Добавлен сервер')");
    await page.waitForSelector("#conns .row:has-text('Тест')");
    await page.click("#power");
    await page.waitForSelector("#state:has-text('Включено')", { timeout: 40000 });
    await page.waitForSelector("#note:has-text('Отклик')", { timeout: 10000 });
    await page.screenshot({ path: (process.env.OUT || ".") + "/win-on" + (process.env.DARK ? "-d" : "") + ".png" });
    want((await page.innerText("#conns")).includes("● включено"), "the connection's row says it is on");
    await page.click("#mode button[data-only='1']");
    await page.waitForSelector("#apps label");
    want((await page.$$("#apps label")).length > 0, "the running programs are listed");
    await page.click("#journal");
    await page.waitForSelector(".toast:has-text('Скопировано')", { timeout: 20000 });
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    want(clip.startsWith("Winger для Windows") && clip.includes("connected via") && !clip.includes("test-pass-123") && !/\d+\.\d+\.\d+\.\d+/.test(clip),
      "the journal: what happened, nothing private");
    await page.click("#power");
    await page.waitForSelector("#state:has-text('Выключено')", { timeout: 10000 });
    const r = await page.evaluate(() => fetch("/api/connect", { method: "POST", body: "x" }).then((r) => r.status));
    want(r === 415, "a plain form post is refused");
  } catch (e) {
    ok = false; console.log("FAIL", String(e).split("\n")[0]);
    console.log("url:", page.url(), "body:", (await page.innerText("body").catch(() => "")).slice(0, 300).replace(/\n/g, " / "));
    await page.screenshot({ path: (process.env.OUT || ".") + "/win-fail.png" });
  }
  console.log(ok ? "ok   window" : "FAIL window");
  console.log("errors:", errors.length ? errors.join("; ") : "none");
  await browser.close();
  process.exit(ok && !errors.length ? 0 : 1);
})();
