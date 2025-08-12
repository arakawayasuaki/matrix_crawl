require("dotenv").config();
const { chromium } = require("playwright");

// プロジェクト自動作成処理（tryの外に定義）
async function createProject(page, projectName) {
  // プロジェクトメニューをクリック
  const projectMenuHandles = await page
    .locator('xpath=//li[contains(., "プロジェクト")]')
    .elementHandles();
  if (projectMenuHandles.length > 0) {
    // li内のaタグまたはbuttonを優先してクリック
    let clicked = false;
    const aTag = await projectMenuHandles[0].$("a");
    if (aTag) {
      await aTag.click().catch(() => {});
      clicked = true;
    } else {
      const btn = await projectMenuHandles[0].$("button");
      if (btn) {
        await btn.click().catch(() => {});
        clicked = true;
      }
    }
    if (!clicked) {
      await projectMenuHandles[0].click().catch(() => {});
    }
    // URLが変わるまで待機
    const beforeUrl = page.url();
    await page
      .waitForFunction((oldUrl) => window.location.href !== oldUrl, beforeUrl, {
        timeout: 5000,
      })
      .catch(() => {});
    await page.waitForTimeout(500);
    // 「新しいプロジェクトを作成」ボタンを探してクリック
    const createBtn = await page.locator(
      'button.btn-info.pull-right:has-text("新しいプロジェクトを作成")'
    );
    if ((await createBtn.count()) > 0) {
      await createBtn.first().click();
      await page.waitForTimeout(500);
      // Blank projectパネルをクリック
      const blankPanel = await page.locator(
        "div.panel-body .font-size-14.font-weight-bold"
      );
      if ((await blankPanel.count()) > 0) {
        await blankPanel.first().click();
        await page.waitForTimeout(500);
        // モーダル内のinput.form-controlを限定して取得
        const modal = await page
          .locator('.modal-content, .modal-dialog, .modal, [role="dialog"]')
          .first();
        let nameInput;
        if ((await modal.count()) > 0) {
          nameInput = await modal.locator("div > input.form-control");
        } else {
          nameInput = await page.locator("div > input.form-control");
        }
        await nameInput.first().waitFor({ state: "visible", timeout: 5000 });
        if ((await nameInput.count()) > 0) {
          await nameInput.first().focus();
          await nameInput.first().type(projectName, { delay: 100 });
          // input/changeイベントをdispatchしてバリデーションを確実に通す
          await nameInput.first().evaluate((el, value) => {
            el.value = value;
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
            el.blur();
          }, projectName);
          await page.waitForTimeout(3000); // 入力後3秒wait
          // 完了ボタンをクリック
          const doneBtn = await page.locator(
            'button.btn-primary:has-text("完了")'
          );
          if ((await doneBtn.count()) > 0) {
            await doneBtn.first().click();
            await page.waitForTimeout(1000);
            console.log(`プロジェクト「${projectName}」を自動作成しました。`);
          } else {
            console.log("完了ボタンが見つかりませんでした。");
          }
        } else {
          console.log("div直下のプロジェクト名入力欄が見つかりませんでした。");
        }
      } else {
        console.log("Blank projectパネルが見つかりませんでした。");
      }
    } else {
      console.log("新しいプロジェクトを作成ボタンが見つかりませんでした。");
    }
  } else {
    console.log("プロジェクトメニューが見つかりませんでした。");
  }
}

// プロジェクト詳細画面を開く処理
async function openProjectDetail(page, projectName) {
  // プロジェクト一覧で該当プロジェクトを探す
  await page.waitForTimeout(2000); // 一覧描画待ち
  const projectRow = await page.locator(`text=${projectName}`).first();
  if ((await projectRow.count()) > 0) {
    // プロジェクト名の親行を取得
    const rowHandle = await projectRow.evaluateHandle((el) =>
      el.closest("tr, .list-group-item, .project-row, .flex")
    );
    if (rowHandle) {
      // 3点リーダ（︙）ボタンを探してクリック
      // よくある: aria-label="more"、fa-ellipsis-h、fa-ellipsis-v、.dropdown-toggle など
      let moreBtn = await rowHandle.asElement().$('button[aria-label="more"]');
      if (!moreBtn)
        moreBtn = await rowHandle
          .asElement()
          .$(".fa-ellipsis-h, .fa-ellipsis-v, .dropdown-toggle, button");
      if (moreBtn) {
        await moreBtn.click();
        await page.waitForTimeout(500);
        // メニューから「編集」をクリック（aタグを直接クリック）
        let editBtn = await page.locator('li.item:has-text("編集") a').first();
        if ((await editBtn.count()) > 0) {
          console.log("編集メニュー(aタグ)をクリックします");
          await editBtn.click({ force: true });
          // 詳細画面が表示されるまでwait（/project?s=... になるまで）
          let url1 = "";
          try {
            await page.waitForURL("**/project?s=*", { timeout: 10000 });
            url1 = page.url();
          } catch {}
          await page.waitForTimeout(1000);
          const url2 = page.url();
          // 詳細画面のタイトルやURLをログ出力
          const detailTitle = await page
            .locator("h1, .modal-title, .panel-title")
            .first()
            .textContent()
            .catch(() => "");
          console.log(`プロジェクト詳細画面タイトル: ${detailTitle}`);
          console.log(`詳細画面URL(遷移直後): ${url1}`);
          console.log(`詳細画面URL(1秒後): ${url2}`);

          // === ここから詳細画面内リンクのクロール＆リンク切れチェック ===
          const detailLinks = await page.$$eval("a[href]", (els) =>
            els.map((el) => ({
              href: el.getAttribute("href"),
              text: el.textContent.trim(),
            }))
          );
          for (const link of detailLinks) {
            if (
              !link.href ||
              link.href === "javascript:void(0)" ||
              link.href === "#"
            )
              continue;
            const url = link.href.startsWith("http")
              ? link.href
              : `https://dev.ntmatrix.app${link.href}`;
            try {
              const response = await page.goto(url, {
                waitUntil: "domcontentloaded",
              });
              if (!response || response.status() >= 400) {
                console.log(`詳細画面リンク切れ: ${url} (${link.text})`);
              }
              // 中国語検出
              const pageText = await page.evaluate(
                () => document.body.innerText
              );
              if (/[\u4e00-\u9fff]/.test(pageText)) {
                console.log(`中国語が含まれています: ${url}`);
              }
            } catch (e) {
              console.log(`詳細画面リンク切れ: ${url} (${link.text})`);
            }
          }
          // === ここまで ===
        } else {
          console.log("編集メニュー(aタグ)が見つかりませんでした。");
        }
      } else {
        console.log("3点リーダ（︙）ボタンが見つかりませんでした。");
      }
    } else {
      console.log("プロジェクト行が見つかりませんでした。");
    }
  } else {
    console.log("該当プロジェクトが見つかりませんでした。");
  }
}

(async () => {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  // ログイン画面を開く
  await page.goto("https://dev.ntmatrix.app/loginDev");
  await page.waitForLoadState("networkidle");

  // ユーザーが手動でログインするのを待つ
  console.log(
    "手動でログインしてください。ログイン後、Enterキーを押してください。"
  );
  await new Promise((resolve) => {
    process.stdin.once("data", () => resolve());
  });

  // トップページに遷移
  await page.goto("https://dev.ntmatrix.app/");
  await page.waitForLoadState("networkidle");
  console.log("Current URL:", page.url());

  // サイドバーのリンク一覧を取得
  let links = [];
  try {
    await page.waitForSelector(".px-nav-content .px-nav-item", {
      timeout: 20000,
    });
    const allLinks = new Map(); // hrefをキーに重複排除

    // サイドバーの最上位メニューを取得し、再帰クロール
    const mainMenuHandles = await page.$$(".px-nav-content .px-nav-item");
    console.log(`mainMenuHandles.length = ${mainMenuHandles.length}`);
    for (let i = 0; i < mainMenuHandles.length; i++) {
      const menuText = await mainMenuHandles[i]
        .innerText()
        .catch(() => "(取得失敗)");
      console.log(`mainMenu[${i}]: ${menuText}`);
    }
    // li.px-nav-item自体をクリックし、右側リンクを必ずクロール
    async function crawlMenuItemAndContent(menuHandle, depth = 1) {
      // メニュー名取得
      const menuText = (await menuHandle.innerText()).trim();
      // li内のaタグまたはbuttonを優先してクリック
      let clicked = false;
      const aTag = await menuHandle.$(":scope > a");
      const beforeUrl = page.url();
      if (aTag) {
        await aTag.click().catch(() => {});
        clicked = true;
      } else {
        const btn = await menuHandle.$(":scope > button");
        if (btn) {
          await btn.click().catch(() => {});
          clicked = true;
        }
      }
      if (!clicked) {
        await menuHandle.click().catch(() => {});
      }
      // URLが変わるまで待機（最大5秒）
      await page
        .waitForFunction(
          (oldUrl) => window.location.href !== oldUrl,
          beforeUrl,
          { timeout: 5000 }
        )
        .catch(() => {});
      await page.waitForTimeout(300);

      // 右側メインコンテンツの中国語チェック
      const mainContentText = await page
        .$eval(
          "main, .main-content, .content-wrapper, .container, .px-main-content",
          (el) => el.innerText
        )
        .catch(() => "");
      if (/[\u4e00-\u9fff]/.test(mainContentText)) {
        console.log(`中国語が含まれています（右側コンテンツ）: ${menuText}`);
      }

      // 詳細画面に遷移したらクロールを即時終了
      if (page.url().includes("/project?s=")) {
        console.log("詳細画面に遷移したため、クロールを終了します。");
        await browser.close();
        process.exit(0);
      }
      // 「プロジェクト」以外は右側リンクをクロール
      if (menuText !== "プロジェクト") {
        const contentLinks = await page.$$eval("body a[href]", (anchors) =>
          anchors
            .filter((a) => {
              // サイドバー内のリンクは除外
              let el = a;
              while (el) {
                if (el.classList && el.classList.contains("px-nav-content"))
                  return false;
                el = el.parentElement;
              }
              return true;
            })
            .map((a) => ({
              href: a.getAttribute("href"),
              text: a.innerText.trim(),
            }))
        );
        for (const cLink of contentLinks) {
          if (cLink.href && !allLinks.has(cLink.href)) {
            console.log(
              `${"  ".repeat(depth)}右側リンク: ${cLink.text} (${
                cLink.href
              }) を検出`
            );
            allLinks.set(cLink.href, { href: cLink.href, text: cLink.text });
          }
        }
      } else {
        console.log(
          `${"  ".repeat(depth)}右側リンク: (プロジェクトはスキップ)`
        );
      }
      // サブメニューがあれば再帰的にクロール
      const subMenu = await menuHandle.$(":scope > ul, :scope > div > ul");
      if (subMenu) {
        const subMenuItems = await subMenu.$$(":scope > li");
        for (const subMenuItem of subMenuItems) {
          await crawlMenuItemAndContent(subMenuItem, depth + 1);
        }
      }
    }
    // サイドバーの各メニューをクロール（プロジェクトは右側リンクスキップ）
    for (const menuHandle of mainMenuHandles) {
      const menuText = (await menuHandle.innerText()).trim();
      console.log("--- crawlMenu entry ---");
      // 通常クロール時はプロジェクトだけ右側リンクスキップ
      if (menuText === "プロジェクト") {
        console.log(`  右側リンク: (プロジェクトはスキップ)`);
        // サブメニューがあれば再帰的にクロール
        const subMenu = await menuHandle.$(":scope > ul, :scope > div > ul");
        if (subMenu) {
          const subMenuItems = await subMenu.$$(":scope > li");
          for (const subMenuItem of subMenuItems) {
            await crawlMenuItemAndContent(subMenuItem, 2);
          }
        }
        continue;
      }
      await crawlMenuItemAndContent(menuHandle, 1);
    }
    links = Array.from(allLinks.values());
    console.log("全ての階層のリンク一覧:");
    links.forEach((link) => console.log(link));

    // プロジェクト自動作成処理は必ず実行
    await createProject(page, "CIテスト");
    // プロジェクト詳細画面を開く処理
    await openProjectDetail(page, "CIテスト");
  } catch (e) {
    console.log("サイドバーのリンクが取得できませんでした:", e.message);
    await browser.close();
    process.exit(1);
  }

  // 各リンクをクロールしてリンク切れをチェック
  const brokenLinks = [];
  const baseUrl = "https://dev.ntmatrix.app";
  for (const link of links) {
    // ダミーリンクは除外
    if (
      !link.href ||
      link.href === "#" ||
      link.href === "javascript:void(0)" ||
      link.href.startsWith("javascript:")
    ) {
      console.log(`スキップ: ${link.text} (${link.href})`);
      continue;
    }
    try {
      let gotoUrl = link.href;
      if (gotoUrl.startsWith("/")) {
        gotoUrl = baseUrl + gotoUrl;
      } else if (!gotoUrl.startsWith("http")) {
        // それ以外のダミーリンクもスキップ
        console.log(`スキップ: ${link.text} (${link.href})`);
        continue;
      }
      const response = await page.goto(gotoUrl, {
        waitUntil: "domcontentloaded",
      });
      const status = response ? response.status() : null;
      if (!status || status >= 400) {
        brokenLinks.push({ ...link, status: status || "No Response" });
        console.log(
          `リンク切れ: ${link.text} (${link.href}) [status: ${status}]`
        );
      } else {
        console.log(`OK: ${link.text} (${link.href}) [status: ${status}]`);
      }
    } catch (err) {
      brokenLinks.push({ ...link, status: "Error", error: err.message });
      console.log(
        `リンク切れ: ${link.text} (${link.href}) [Error: ${err.message}]`
      );
    }
    // 元のページに戻る
    await page.goto(baseUrl, {
      waitUntil: "domcontentloaded",
    });
    await page.waitForLoadState("networkidle");
  }

  // 結果をまとめて表示
  if (brokenLinks.length > 0) {
    console.log("\nリンク切れ一覧:");
    brokenLinks.forEach((link) => {
      console.log(
        `- ${link.text} (${link.href}) [status: ${link.status}${
          link.error ? ", error: " + link.error : ""
        }]`
      );
    });
  } else {
    console.log("\nリンク切れはありませんでした。");
  }

  // ブラウザを閉じてプロセスを終了
  await browser.close();
  process.exit(0);
})();
