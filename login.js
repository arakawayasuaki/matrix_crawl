require("dotenv").config({ quiet: true });
const { chromium } = require("playwright");
const tls = require("tls");
const url = require("url");

const fs = require("fs");
const path = require("path");

// StorageStateファイルのパス (Cookie + LocalStorage)
const STORAGE_STATE_PATH = path.join(__dirname, "storage.json");
const ARTIFACTS_DIR = path.join(__dirname, "artifacts");
const COMPONENT_TEST_DIR = path.join(ARTIFACTS_DIR, "component-tests");
const BEHAVIOR_TEST_DIR = path.join(ARTIFACTS_DIR, "behavior-tests");
const CI_DATAMODEL_DIR = path.join(ARTIFACTS_DIR, "ci-datamodel");

// =========================
// Runtime options
// =========================
const DEFAULT_BASE_URL = "https://dev.ntmatrix.app";

function getArg(flag) {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return undefined;
  return process.argv[idx + 1];
}

function hasFlag(flag) {
  return process.argv.includes(flag);
}

// =========================
// Output mode
// =========================
const CHECKLIST_MODE =
  hasFlag("--checklist") ||
  String(process.env.NTMATRIX_CHECKLIST || "") === "1";
const CHECKLIST_DETAILS =
  hasFlag("--checklist-details") ||
  String(process.env.NTMATRIX_CHECKLIST_DETAILS || "") === "1";

function formatForLog(x) {
  if (typeof x === "string") return x;
  try {
    return JSON.stringify(x);
  } catch {
    return String(x);
  }
}

function setupChecklistMode() {
  if (!CHECKLIST_MODE) return;
  const toStderr = (...args) => {
    try {
      process.stderr.write(args.map(formatForLog).join(" ") + "\n");
    } catch {
      // ignore
    }
  };
  // Ensure stdout only contains "item OK/NG". Everything else goes to stderr.
  console.log = toStderr;
  console.info = toStderr;
  console.warn = toStderr;
}

function emitChecklist(item, ok) {
  if (!CHECKLIST_MODE) return;
  const status = ok ? "OK" : "NG";
  if (!CHECKLIST_DETAILS) {
    process.stdout.write(`${item}\t${status}\n`);
    return;
  }
  const desc = describeChecklistItem(item)
    .replace(/\r?\n/g, " ")
    .replace(/\t/g, " ");
  process.stdout.write(`${item}\t${status}\t${desc}\n`);
}

function emitChecklistFromSteps(prefix, steps) {
  if (!CHECKLIST_MODE) return;
  if (!Array.isArray(steps)) return;
  for (const s of steps) {
    if (!s || !s.step) continue;
    emitChecklist(`${prefix}.${s.step}`, !!s.ok);
  }
}

function safeChecklistKey(s, maxLen = 140) {
  return String(s || "")
    .replace(/\s+/g, "_")
    .replace(/[^\w.\-:@/]+/g, "_")
    .slice(0, maxLen);
}

function describeChecklistItem(key) {
  const fixed = {
    login: "ログイン状態を確認（必要なら手動ログイン/StorageState更新）",
    behavior_smoke:
      "デザイナー動作スモーク（入力2つ配置・プロパティ編集・プレビュー入力・DataModelバインド）",
    test_all_components:
      "全コンポーネントを列挙して1つずつドラッグ&ドロップ→DOM増加を確認→Undoで後片付け",
    link_check:
      "画面内リンクを巡回し、HTTPステータス>=400等のリンク切れが無いことを確認",
    chinese_check:
      "各メニューの右側メインコンテンツに中国語（漢字レンジ）混入が無いことを確認",
  };
  if (fixed[key]) return fixed[key];

  if (key.startsWith("behavior_smoke.")) {
    const step = key.slice("behavior_smoke.".length);
    const map = {
      ci_datamodel_create:
        "CI専用DataModelを作成（テスト用にのみ使用し、終了時に削除）",
      designer_ready: "デザイナーキャンバス(#rendererContent)の表示を確認",
      drop_two_inputs:
        "入力ボックス(input)を2つキャンバスへ配置（要素数増加で判定）",
      set_first_input_props: "1つ目の入力にプロパティ（タイトル等）を設定",
      set_second_input_props: "2つ目の入力にプロパティ（タイトル等）を設定",
      datamodel_bind:
        "デザイナーのDataModel設定で作成したCI DataModelを選択してバインド",
      designer_title_reflect:
        "デザイナー上でタイトル(Name/Age)がキャンバスに反映されたことを確認",
      designer_toolbar_preview_type:
        "デザイナーツールバーのプレビュー(eye-slash)で入力できることを確認",
      preview_type:
        "プレビュー画面でName/Ageに入力でき、表示反映されることを確認",
      ci_datamodel_delete:
        "CI専用DataModelを削除（作成したIDのみ削除・他は削除しない）",
    };
    if (map[step]) return map[step];
    return `behavior_smoke のステップ: ${step}`;
  }

  if (key.startsWith("component.")) {
    const name = key.slice("component.".length);
    return `コンポーネント「${name}」をキャンバスへドラッグ&ドロップして配置できることを確認（Undoで戻す）`;
  }

  if (key.startsWith("link_broken.")) {
    const href = key.slice("link_broken.".length);
    return `リンク切れ検出: ${href}`;
  }

  if (key.startsWith("chinese.")) {
    const menu = key.slice("chinese.".length);
    return `中国語混入検出（右側コンテンツ）: ${menu}`;
  }

  return "";
}

function parseCookieHeader(cookieHeader) {
  // "a=b; c=d" -> [{ name:"a", value:"b", url: BASE_URL }, ...]
  return cookieHeader
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((pair) => {
      const eq = pair.indexOf("=");
      if (eq === -1) return null;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (!name) return null;
      return { name, value };
    })
    .filter(Boolean);
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function nowTag() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(
    d.getHours()
  )}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

async function fillFirstInputNearLabel(container, labelText, value) {
  // Find a label/span/div containing labelText, then fill the first following input.
  const label = container.locator(`text=${labelText}`).first();
  if ((await label.count().catch(() => 0)) === 0) return false;
  const input = label.locator("xpath=following::input[1]").first();
  if ((await input.count().catch(() => 0)) === 0) return false;
  await input.click({ force: true }).catch(() => {});
  await input.fill(String(value)).catch(() => {});
  return true;
}

async function findDataModelRowById(page, dmId) {
  // Returns locator for the row (tr) that contains dmId in first column.
  const cell = page.locator(`text=${dmId}`).first();
  if ((await cell.count().catch(() => 0)) === 0) return null;
  const row = cell.locator("xpath=ancestor::tr[1]").first();
  if ((await row.count().catch(() => 0)) === 0) return null;
  return row;
}

async function doesDataModelExist(context, baseUrl, dmId) {
  const page = await context.newPage();
  await page
    .goto(`${baseUrl}/dataModel`, { waitUntil: "networkidle" })
    .catch(() => {});
  await page.waitForTimeout(1200);
  const search = page
    .locator(
      'input[placeholder="search"], input[placeholder*="search"], .input-group input[type="text"]'
    )
    .first();
  if ((await search.count().catch(() => 0)) > 0) {
    await search.fill(dmId).catch(() => {});
    await page.waitForTimeout(600);
  }
  const matches = await page
    .locator(`text=${dmId}`)
    .count()
    .catch(() => 0);
  await page.close().catch(() => {});
  return matches === 1;
}

async function createCiDataModel(context, baseUrl, runId, outDir) {
  const page = await context.newPage();
  await page
    .goto(`${baseUrl}/dataModel`, { waitUntil: "networkidle" })
    .catch(() => {});
  await page.waitForTimeout(1500);

  // Create button on top right: "新しいDataModelを作成"
  const created = await clickFirstVisible(page, [
    'button:has-text("新しいDataModelを作成")',
    'a:has-text("新しいDataModelを作成")',
    'button:has-text("DataModelを作成")',
    'a:has-text("DataModelを作成")',
    "button:has(i.fa-plus)",
  ]);
  if (!created) {
    await page
      .screenshot({
        path: path.join(outDir, "datamodel-create-button-missing.png"),
        fullPage: true,
      })
      .catch(() => {});
    throw new Error("DataModel作成ボタンが見つかりませんでした");
  }

  await page.waitForLoadState("domcontentloaded").catch(() => {});
  await page.waitForTimeout(1500);

  // Generate unique DM id/name (safe & deterministic)
  const dmId = `ci_dm_${Date.now()}`;
  const dmName = `CI_DM_${runId}`;

  // Scope to the creation modal: "DataModelの追加"
  const modal = page
    .locator(
      '.nmodal.modal:has-text("DataModelの追加"), .modal:has-text("DataModelの追加")'
    )
    .first();
  await modal.waitFor({ state: "visible", timeout: 10000 }).catch(() => {});

  // Fill DataModel ID / Name (these labels exist inside modal)
  const okId = await fillFirstInputNearLabel(modal, "DataModel ID", dmId);
  const okName = await fillFirstInputNearLabel(modal, "DataModel名", dmName);

  // Add minimal column (PK required per matrix.md) – add one string column "id"
  await modal
    .locator('button:has-text("カラムの追加")')
    .first()
    .click({ force: true })
    .catch(() => {});
  await page.waitForTimeout(800);

  const firstRow = modal.locator("table tbody tr").first();
  const rowInputs = firstRow.locator("input.form-control");
  if ((await rowInputs.count().catch(() => 0)) >= 2) {
    await rowInputs
      .nth(0)
      .fill("id")
      .catch(() => {}); // カラムID
    await rowInputs
      .nth(1)
      .fill("id")
      .catch(() => {}); // カラム名
  }
  // Select primary key (required). The PK column uses a magnifier icon; clicking it turns green when selected.
  await firstRow
    .locator("td")
    .nth(1)
    .locator("i.fa")
    .first()
    .click({ force: true })
    .catch(() => {});

  await page
    .screenshot({
      path: path.join(outDir, "datamodel-create-form.png"),
      fullPage: true,
    })
    .catch(() => {});

  if (!okId || !okName) {
    throw new Error(
      `DataModel作成フォームの入力欄が特定できませんでした (id=${okId}, name=${okName})`
    );
  }

  // Save/Create
  const saved = await clickFirstVisible(modal, [
    'button:has-text("作成")',
    'button:has-text("保存")',
    'button:has-text("登録")',
    'button:has-text("確認")',
    'button:has-text("OK")',
  ]);
  if (!saved) {
    await page
      .screenshot({
        path: path.join(outDir, "datamodel-create-save-missing.png"),
        fullPage: true,
      })
      .catch(() => {});
    throw new Error("DataModel作成の保存/作成ボタンが見つかりませんでした");
  }

  // Wait for modal to close; if it stays open, check PK warning and retry once.
  await page.waitForTimeout(800);
  const stillOpen = await modal.isVisible().catch(() => false);
  if (stillOpen) {
    const pkWarn =
      (await page
        .locator("text=pkが選択されていません")
        .count()
        .catch(() => 0)) > 0;
    if (pkWarn) {
      await firstRow
        .locator("td")
        .nth(1)
        .locator("i.fa")
        .first()
        .click({ force: true })
        .catch(() => {});
      await modal
        .locator('button:has-text("保存")')
        .first()
        .click({ force: true })
        .catch(() => {});
    }
  }

  const closedOk = await modal
    .waitFor({ state: "hidden", timeout: 15000 })
    .then(() => true)
    .catch(() => false);
  if (!closedOk) {
    await page
      .screenshot({
        path: path.join(outDir, "datamodel-create-still-open.png"),
        fullPage: true,
      })
      .catch(() => {});
    throw new Error(
      "DataModel作成後もモーダルが閉じませんでした（バリデーションの可能性）"
    );
  }

  // Wait and verify it exists on list
  await page.waitForTimeout(1500);
  await page
    .goto(`${baseUrl}/dataModel`, { waitUntil: "networkidle" })
    .catch(() => {});
  await page.waitForTimeout(1500);

  // Use search input (top right) to filter
  const search = page
    .locator(
      'input[placeholder="search"], input[placeholder*="search"], .input-group input[type="text"]'
    )
    .first();
  if ((await search.count().catch(() => 0)) > 0) {
    await search.fill(dmId).catch(() => {});
    await page.waitForTimeout(800);
  }

  const row = await findDataModelRowById(page, dmId);
  if (!row) {
    await page
      .screenshot({
        path: path.join(outDir, "datamodel-create-not-found.png"),
        fullPage: true,
      })
      .catch(() => {});
    throw new Error(`作成したDataModelが一覧で見つかりませんでした: ${dmId}`);
  }

  await page
    .screenshot({
      path: path.join(outDir, "datamodel-created.png"),
      fullPage: true,
    })
    .catch(() => {});
  await page.close().catch(() => {});
  return { dmId, dmName };
}

async function deleteCiDataModel(context, baseUrl, dmId, outDir) {
  const page = await context.newPage();
  await page
    .goto(`${baseUrl}/dataModel`, { waitUntil: "networkidle" })
    .catch(() => {});
  await page.waitForTimeout(1500);

  // Filter by id
  const search = page
    .locator(
      'input[placeholder="search"], input[placeholder*="search"], .input-group input[type="text"]'
    )
    .first();
  if ((await search.count().catch(() => 0)) > 0) {
    await search.fill(dmId).catch(() => {});
    await page.waitForTimeout(800);
  }

  // Guard: match count must be exactly 1
  const matches = await page
    .locator(`text=${dmId}`)
    .count()
    .catch(() => 0);
  if (matches !== 1) {
    await page
      .screenshot({
        path: path.join(outDir, "datamodel-delete-guard.png"),
        fullPage: true,
      })
      .catch(() => {});
    throw new Error(
      `削除ガード: DataModel ID "${dmId}" の一致件数が1件ではありません (count=${matches})`
    );
  }

  const row = await findDataModelRowById(page, dmId);
  if (!row) {
    await page
      .screenshot({
        path: path.join(outDir, "datamodel-delete-row-missing.png"),
        fullPage: true,
      })
      .catch(() => {});
    throw new Error(`削除対象行が見つかりませんでした: ${dmId}`);
  }

  // Open row menu (right-most ≡ button)
  const menuBtn = row
    .locator(
      'button:has-text("≡"), button:has(i.fa-reorder), button:has(i.fa-bars)'
    )
    .first();
  await menuBtn.click({ force: true }).catch(() => {});
  await page.waitForTimeout(500);

  // Click delete
  const delClicked = await clickFirstVisible(page, [
    "text=削除",
    "text=Delete",
    'button:has-text("削除")',
  ]);
  if (!delClicked) {
    await page
      .screenshot({
        path: path.join(outDir, "datamodel-delete-action-missing.png"),
        fullPage: true,
      })
      .catch(() => {});
    throw new Error(
      "削除アクションが見つかりませんでした（他のDataModelは削除しません）"
    );
  }

  // Confirm dialog
  await page.waitForTimeout(800);
  await page
    .screenshot({
      path: path.join(outDir, "datamodel-delete-confirm.png"),
      fullPage: true,
    })
    .catch(() => {});
  await clickFirstVisible(page, [
    'button:has-text("削除")',
    'button:has-text("OK")',
    'button:has-text("確認")',
    'button:has-text("はい")',
  ]);
  await page.waitForTimeout(2000);

  // Verify gone
  await page
    .goto(`${baseUrl}/dataModel`, { waitUntil: "networkidle" })
    .catch(() => {});
  await page.waitForTimeout(1500);
  if ((await search.count().catch(() => 0)) > 0) {
    await search.fill(dmId).catch(() => {});
    await page.waitForTimeout(800);
  }
  const still = await page
    .locator(`text=${dmId}`)
    .count()
    .catch(() => 0);
  await page
    .screenshot({
      path: path.join(outDir, "datamodel-deleted.png"),
      fullPage: true,
    })
    .catch(() => {});
  await page.close().catch(() => {});
  if (still !== 0) throw new Error(`DataModel削除後も残っています: ${dmId}`);
}

async function dumpPageArtifacts(page, label) {
  ensureDir(ARTIFACTS_DIR);
  const safe = String(label).replace(/[^a-zA-Z0-9._-]+/g, "_");
  const prefix = path.join(ARTIFACTS_DIR, safe);
  const url = page.url();
  let title = "";
  try {
    title = await page.title();
  } catch {}
  const html = await page.content().catch(() => "");
  fs.writeFileSync(
    `${prefix}.meta.json`,
    JSON.stringify({ url, title }, null, 2)
  );
  if (html) fs.writeFileSync(`${prefix}.html`, html);
  // DOM summary (SPAシェルでも状況が分かるようにしておく)
  try {
    const summary = await page.evaluate(() => {
      const exists = (sel) => !!document.querySelector(sel);
      const roots = ["#app", "#root", "main", "[role=main]"].filter(exists);
      const linksAll = Array.from(document.querySelectorAll("a[href]"));
      const links = linksAll.slice(0, 200).map((a) => ({
        href: a.getAttribute("href"),
        text: (a.textContent || "").trim().slice(0, 120),
      }));
      const inputsAll = Array.from(document.querySelectorAll("input"));
      const inputs = inputsAll.slice(0, 50).map((i) => ({
        type: i.getAttribute("type") || "",
        name: i.getAttribute("name") || "",
        placeholder: i.getAttribute("placeholder") || "",
      }));
      return {
        documentTitle: document.title,
        bodyTextLen: (document.body?.innerText || "").length,
        roots,
        linkCount: linksAll.length,
        links,
        inputCount: inputsAll.length,
        inputs,
      };
    });
    fs.writeFileSync(
      `${prefix}.summary.json`,
      JSON.stringify(summary, null, 2)
    );
  } catch (e) {
    console.log("summary 生成に失敗:", e?.message || e);
  }
  await page
    .screenshot({ path: `${prefix}.png`, fullPage: true })
    .catch(() => {});
  console.log(`ダンプ出力: ${prefix}.{html,png,meta.json,summary.json}`);
}

async function clickFirstVisible(page, selectors) {
  for (const sel of selectors) {
    const loc = page.locator(sel).first();
    if ((await loc.count().catch(() => 0)) > 0) {
      await loc.click({ force: true }).catch(() => {});
      return true;
    }
  }
  return false;
}

async function openAndCloseCommitDialog(page, outDir, result, strictCommit) {
  // Best-effort: open commit dialog and close it without saving.
  const opened = await clickFirstVisible(page, [
    'button:has-text("コミット")',
    'a:has-text("コミット")',
    'button[title*="コミット"]',
    'a[title*="コミット"]',
    // fallback icons
    "button:has(i.fa-save)",
    "button:has(i.fa-upload)",
    "button:has(i.fa-cloud-upload)",
  ]);

  if (!opened) {
    result.steps.push({
      step: "commit_dialog",
      ok: false,
      warning: !strictCommit,
      strict: strictCommit,
      note: "コミット ボタンが見つかりませんでした",
    });
    if (strictCommit) throw new Error("コミット ボタンが見つかりませんでした");
    return;
  }

  const dialog = page.locator(
    '.n-dialog, .n-modal, .modal, [role="dialog"], .dialog, .ant-modal'
  );
  const appeared = await dialog
    .first()
    .waitFor({ state: "visible", timeout: 8000 })
    .then(() => true)
    .catch(() => false);

  await page
    .screenshot({
      path: path.join(
        outDir,
        appeared ? "commit-dialog.png" : "commit-no-dialog.png"
      ),
      fullPage: true,
    })
    .catch(() => {});

  if (!appeared) {
    result.steps.push({
      step: "commit_dialog",
      ok: false,
      warning: !strictCommit,
      strict: strictCommit,
      note: "コミットダイアログが表示されませんでした",
    });
    if (strictCommit)
      throw new Error("コミットダイアログが表示されませんでした");
    return;
  }

  const closed = await clickFirstVisible(page, [
    'button:has-text("キャンセル")',
    'button:has-text("閉じる")',
    'button:has-text("取消")',
    "button:has(i.fa-times)",
    ".n-dialog__close",
    ".n-modal__close",
    '.modal-header button.close, button.close, [aria-label="close"]',
  ]);

  if (closed) {
    await dialog
      .first()
      .waitFor({ state: "hidden", timeout: 8000 })
      .catch(() => {});
  }

  result.steps.push({
    step: "commit_dialog",
    ok: true,
  });
}

async function openAndCloseDataModelPanel(
  page,
  outDir,
  result,
  strictDataModel
) {
  // Best-effort: open "block" (DataModel/Filter/DPS) panel and close it.
  // UI varies, so we click several likely toolbar icons and look for known texts.
  const opened = await clickFirstVisible(page, [
    // common "block" icons
    "button:has(i.fa-cubes)",
    "button:has(i.fa-cube)",
    "button:has(i.fa-th)",
    "button:has(i.fa-th-large)",
    "button:has(i.fa-puzzle-piece)",
    // sometimes it's a dropdown / icon-only button
    'button[title*="DataModel"]',
    'button[title*="データ"]',
  ]);

  if (!opened) {
    result.steps.push({
      step: "datamodel_panel",
      ok: false,
      warning: !strictDataModel,
      strict: strictDataModel,
      note: "DataModel(積み木)アイコンが見つかりませんでした",
    });
    if (strictDataModel)
      throw new Error("DataModel(積み木)アイコンが見つかりませんでした");
    return;
  }

  // Wait for any dialog/drawer and/or presence of known texts
  const dialogLike = page.locator(
    '.n-dialog, .n-modal, .modal, [role="dialog"], .n-drawer, .drawer, .ant-modal'
  );
  const appeared = await dialogLike
    .first()
    .waitFor({ state: "visible", timeout: 8000 })
    .then(() => true)
    .catch(() => false);

  const hasKnownText =
    (await page
      .locator("text=データ構造の生成")
      .count()
      .catch(() => 0)) > 0 ||
    (await page
      .locator("text=DataModel")
      .count()
      .catch(() => 0)) > 0 ||
    (await page
      .locator("text=フィルター")
      .count()
      .catch(() => 0)) > 0 ||
    (await page
      .locator("text=DPS")
      .count()
      .catch(() => 0)) > 0;

  await page
    .screenshot({
      path: path.join(
        outDir,
        hasKnownText ? "datamodel-panel.png" : "datamodel-panel-unknown.png"
      ),
      fullPage: true,
    })
    .catch(() => {});

  if (!appeared && !hasKnownText) {
    result.steps.push({
      step: "datamodel_panel",
      ok: false,
      warning: !strictDataModel,
      strict: strictDataModel,
      note: "DataModelパネルらしき表示を検出できませんでした",
    });
    if (strictDataModel)
      throw new Error("DataModelパネルらしき表示を検出できませんでした");
    return;
  }

  // Try to click "データ構造の生成" if present (non-destructive)
  if (
    (await page
      .locator("text=データ構造の生成")
      .count()
      .catch(() => 0)) > 0
  ) {
    await page
      .locator("text=データ構造の生成")
      .first()
      .click({ force: true })
      .catch(() => {});
    await page.waitForTimeout(500);
    await page
      .screenshot({
        path: path.join(outDir, "datamodel-generate-schema.png"),
        fullPage: true,
      })
      .catch(() => {});
  }

  // Close dialog/drawer (best-effort)
  await clickFirstVisible(page, [
    'button:has-text("閉じる")',
    'button:has-text("キャンセル")',
    "button:has(i.fa-times)",
    ".n-dialog__close",
    ".n-modal__close",
    ".n-drawer__close",
    '.modal-header button.close, button.close, [aria-label="close"]',
  ]);

  result.steps.push({
    step: "datamodel_panel",
    ok: true,
    detected: { appeared, hasKnownText },
  });
}

async function bindDataModelInDesigner(page, dmId, outDir, result, strictBind) {
  // matrix.md 3.2.1:
  // Open block(DataModel) modal -> generate schema -> (center) hamburger menu -> "DataModelの選択" -> select existing dmId.
  const opened = await clickFirstVisible(page, [
    "button:has(i.fa-cubes)",
    "button:has(i.fa-cube)",
    "button:has(i.fa-th)",
    "button:has(i.fa-th-large)",
    "button:has(i.fa-puzzle-piece)",
    'button[title*="DataModel"]',
    'button[title*="データ"]',
  ]);
  if (!opened) {
    result.steps.push({
      step: "datamodel_bind",
      ok: false,
      warning: !strictBind,
      strict: strictBind,
      note: "DataModel(積み木)アイコンが見つかりませんでした",
    });
    if (strictBind)
      throw new Error("DataModel(積み木)アイコンが見つかりませんでした");
    return false;
  }

  await page.waitForTimeout(800);

  const modal = page
    .locator(
      ".nmodal.modal:visible, .modal:visible, .n-modal:visible, .n-dialog:visible"
    )
    .first();
  const modalVisible = await modal
    .waitFor({ state: "visible", timeout: 8000 })
    .then(() => true)
    .catch(() => false);
  const scope = modalVisible ? modal : page.locator("body");

  await page
    .screenshot({
      path: path.join(outDir, "datamodel-bind-open.png"),
      fullPage: true,
    })
    .catch(() => {});
  const html = await page.content().catch(() => "");
  if (html)
    fs.writeFileSync(path.join(outDir, "datamodel-bind-open.html"), html);

  // Generate schema
  await clickFirstVisible(scope, ['button:has-text("データ構造の生成")']);
  await page.waitForTimeout(800);
  await page
    .screenshot({
      path: path.join(outDir, "datamodel-bind-after-generate.png"),
      fullPage: true,
    })
    .catch(() => {});

  // Open mapping panel menu (hamburger button in the modal) and select "DataModelの選択"
  await clickFirstVisible(scope, [
    "button:has(i.fa-bars)",
    "button:has(i.fa-reorder)",
    "button:has(i.fa-navicon)",
    'button:has-text("≡")',
    "i.fa-bars",
    "i.fa-reorder",
    "i.fa-navicon",
  ]);
  await page.waitForTimeout(500);

  const selectDmClicked = await clickFirstVisible(page, [
    "text=DataModelの選択",
    "text=DataModel 選択",
    "text=DataModel選択",
    "text=DataModelを選択",
    "text=DataModel を選択",
  ]);
  if (!selectDmClicked) {
    result.steps.push({
      step: "datamodel_bind",
      ok: false,
      warning: !strictBind,
      strict: strictBind,
      note: "「DataModelの選択」が見つかりませんでした",
    });
    if (strictBind)
      throw new Error("「DataModelの選択」が見つかりませんでした");
    // close
    await clickFirstVisible(page, [
      'button:has-text("閉じる")',
      'button:has-text("キャンセル")',
      "button:has(i.fa-times)",
      ".n-dialog__close",
      ".n-modal__close",
      ".n-drawer__close",
      '.modal-header button.close, button.close, [aria-label="close"]',
    ]);
    return false;
  }

  // DataModel selector modal/dialog (newest visible modal/dialog)
  await page.waitForTimeout(800);
  const selector = page
    .locator(
      ".nmodal.modal:visible, .modal:visible, .n-modal:visible, .n-dialog:visible"
    )
    .last();

  await page
    .screenshot({
      path: path.join(outDir, "datamodel-select-open.png"),
      fullPage: true,
    })
    .catch(() => {});

  // Search/filter by dmId if input exists.
  // This modal sometimes uses placeholder "Please Input", so we broaden the selector.
  const search = selector
    .locator(
      'input[placeholder*="Please" i], input[placeholder*="Input" i], input[placeholder="search"], input[placeholder*="search"], input[placeholder*="検索"], input[type="search"], input[type="text"], input'
    )
    .filter({ hasNot: selector.locator("input[disabled]") })
    .first();
  if ((await search.count().catch(() => 0)) > 0) {
    await search.fill(dmId).catch(() => {});
    await page.waitForTimeout(700);
  }

  const dmHit = selector.locator(`text=${dmId}`).first();
  const hitOk = await dmHit
    .waitFor({ state: "visible", timeout: 8000 })
    .then(() => true)
    .catch(() => false);
  if (hitOk) {
    await dmHit.click({ force: true }).catch(() => {});
    await page.waitForTimeout(400);
  }

  const confirmOk = await clickFirstVisible(selector, [
    'button:has-text("保存")',
  ]);
  if (confirmOk) {
    await selector.waitFor({ state: "hidden", timeout: 15000 }).catch(() => {});
  }

  await page
    .screenshot({
      path: path.join(outDir, "datamodel-select-after.png"),
      fullPage: true,
    })
    .catch(() => {});

  const selectedNow =
    (await scope
      .locator(`text=${dmId}`)
      .count()
      .catch(() => 0)) > 0 ||
    (await scope
      .locator("text=DataModelが選択されていません")
      .count()
      .catch(() => 0)) === 0;

  if (!hitOk) {
    result.steps.push({
      step: "datamodel_bind",
      ok: false,
      warning: !strictBind,
      strict: strictBind,
      note: `DataModel選択UIで dmId が見つかりませんでした: ${dmId}`,
    });
    if (strictBind)
      throw new Error(`DataModel選択UIで dmId が見つかりませんでした: ${dmId}`);
    return false;
  }
  if (!confirmOk) {
    result.steps.push({
      step: "datamodel_bind",
      ok: false,
      warning: !strictBind,
      strict: strictBind,
      note: "DataModel選択UIの確定ボタンが見つかりませんでした",
    });
    if (strictBind)
      throw new Error("DataModel選択UIの確定ボタンが見つかりませんでした");
    return false;
  }
  if (!selectedNow) {
    result.steps.push({
      step: "datamodel_bind",
      ok: false,
      warning: !strictBind,
      strict: strictBind,
      note: `DataModel選択後の反映を確認できませんでした: ${dmId}`,
    });
    if (strictBind)
      throw new Error(`DataModel選択後の反映を確認できませんでした: ${dmId}`);
    return false;
  }

  result.steps.push({ step: "datamodel_bind", ok: true, dmId });
  return true;
}

async function performDragAndDropAt(
  page,
  componentName,
  dropDx = 100,
  dropDy = 100
) {
  // Same logic as performDragAndDrop but allows dropping at different offsets to avoid overlap.
  try {
    console.log(`Searching for component: ${componentName}`);
    const sourceSelector = `.componentItem:has-text("${componentName}") >> visible=true`;
    try {
      await page.waitForSelector(sourceSelector, { timeout: 5000 });
    } catch {}
    const source = page.locator(sourceSelector).first();
    if ((await source.count()) === 0) {
      console.error(
        `Visible Component "${componentName}" not found in sidebar.`
      );
      return false;
    }

    const targetSelector = "#rendererContent";
    await page.waitForSelector(targetSelector, { timeout: 5000 });
    const target = page.locator(targetSelector).first();
    const sourceBox = await source.boundingBox();
    const targetBox = await target.boundingBox();
    if (!sourceBox || !targetBox) {
      console.error("Bounding box missing for drag operation.");
      return false;
    }

    await page.mouse.move(
      sourceBox.x + sourceBox.width / 2,
      sourceBox.y + sourceBox.height / 2
    );
    await page.mouse.down();
    await page.waitForTimeout(150);
    await page.mouse.move(targetBox.x + dropDx, targetBox.y + dropDy, {
      steps: 20,
    });
    await page.waitForTimeout(150);
    await page.mouse.up();
    await page.waitForTimeout(800);
    return true;
  } catch (e) {
    console.error("Error during Drag and Drop:", e);
    return false;
  }
}

async function openPreviewPage(page) {
  // Try to open preview; it may open a new tab or the same tab.
  const ctx = page.context();
  const beforePages = ctx.pages();

  const clicked = await clickFirstVisible(page, [
    'button:has-text("プレビュー")',
    'a:has-text("プレビュー")',
    'button[title*="プレビュー"]',
    'a[title*="プレビュー"]',
    '[aria-label*="プレビュー"]',
    // fallback: common "play" icon buttons
    "button:has(i.fa-play)",
    "button:has(.fa-play)",
  ]);
  if (!clicked) {
    throw new Error("プレビュー ボタンが見つかりませんでした");
  }

  // Wait for either a new page or a navigation.
  let preview = null;
  try {
    preview = await ctx.waitForEvent("page", { timeout: 8000 });
  } catch {
    // no new page - use current
  }
  if (preview) {
    await preview.waitForLoadState("domcontentloaded").catch(() => {});
    return preview;
  }

  // If same page navigated, detect if URL changed.
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  const afterPages = ctx.pages();
  if (afterPages.length > beforePages.length) {
    return afterPages[afterPages.length - 1];
  }
  return page;
}

async function testBehaviorSmoke(page) {
  ensureDir(BEHAVIOR_TEST_DIR);
  const runId = nowTag();
  const outDir = path.join(BEHAVIOR_TEST_DIR, runId);
  ensureDir(outDir);

  const result = {
    runId,
    url: page.url(),
    steps: [],
    ok: true,
  };
  const strictPreview = hasFlag("--behavior-strict-preview");
  const behaviorCommit = hasFlag("--behavior-commit");
  const strictCommit = hasFlag("--behavior-strict-commit");
  const behaviorDataModel = hasFlag("--behavior-datamodel");
  const strictDataModel = hasFlag("--behavior-strict-datamodel");
  const behaviorDataModelBind = hasFlag("--behavior-datamodel-bind");
  const strictDataModelBind = hasFlag("--behavior-strict-datamodel-bind");
  const ciDataModel = hasFlag("--ci-datamodel");

  // If enabled, create a dedicated CI DataModel and ensure cleanup at the end (delete ONLY that ID).
  const baseUrl = new URL(page.url()).origin;
  ensureDir(CI_DATAMODEL_DIR);
  const ciOutDir = path.join(CI_DATAMODEL_DIR, runId);
  ensureDir(ciOutDir);
  let ciCreated = null; // only set when we confirm DataModel exists (so we never delete anything else)

  const fail = async (step, err) => {
    result.ok = false;
    result.steps.push({ step, ok: false, error: err?.message || String(err) });
    await page
      .screenshot({
        path: path.join(outDir, `fail-${step}.png`),
        fullPage: true,
      })
      .catch(() => {});
  };

  try {
    if (ciDataModel) {
      ciCreated = await createCiDataModel(
        page.context(),
        baseUrl,
        runId,
        ciOutDir
      );
      result.steps.push({
        step: "ci_datamodel_create",
        ok: true,
        dmId: ciCreated.dmId,
      });
    }
    // Wait for designer canvas
    await page.waitForSelector("#rendererContent", { timeout: 20000 });
    result.steps.push({ step: "designer_ready", ok: true });

    // From @matrix.md: drag two "入力ボックス input"
    const comp = "入力ボックス input";
    const beforeCount = await page
      .locator("#rendererContent *")
      .count()
      .catch(() => 0);
    await performDragAndDropAt(page, comp, 120, 120);
    await performDragAndDropAt(page, comp, 220, 200);
    const afterCount = await page
      .locator("#rendererContent *")
      .count()
      .catch(() => 0);
    if (afterCount <= beforeCount)
      throw new Error("input を2つ追加できませんでした");
    result.steps.push({
      step: "drop_two_inputs",
      ok: true,
      beforeCount,
      afterCount,
    });

    // Select inputs on canvas (best-effort: click first two inputs)
    // NOTE: Designer canvas may render inputs not as <input>. We also check for n-input wrapper.
    const canvasInputs = page.locator(
      "#rendererContent input, #rendererContent .n-input__input-el"
    );
    if ((await canvasInputs.count().catch(() => 0)) >= 1) {
      await canvasInputs
        .nth(0)
        .click({ force: true })
        .catch(() => {});
      // Set properties: id/name/タイトル -> Name
      // NOTE: inputによってはid/nameプロパティが存在しないため、見つからなければスキップ
      await editComponentProperty(page, "id", "Name").catch(() => {});
      await editComponentProperty(page, "name", "Name").catch(() => {});
      await editComponentProperty(page, "タイトル", "Name").catch(() => {});
      result.steps.push({ step: "set_first_input_props", ok: true });
    } else {
      result.steps.push({
        step: "set_first_input_props",
        ok: false,
        note: "canvas input not found",
      });
    }

    if ((await canvasInputs.count().catch(() => 0)) >= 2) {
      await canvasInputs
        .nth(1)
        .click({ force: true })
        .catch(() => {});
      // Set properties: id/name/タイトル -> Age
      await editComponentProperty(page, "id", "Age").catch(() => {});
      await editComponentProperty(page, "name", "Age").catch(() => {});
      await editComponentProperty(page, "タイトル", "Age").catch(() => {});
      result.steps.push({ step: "set_second_input_props", ok: true });
    } else {
      result.steps.push({
        step: "set_second_input_props",
        ok: false,
        note: "second canvas input not found",
      });
    }

    // Optional: bind the dedicated CI DataModel into designer (matrix.md 3.2.1 selection)
    if (ciCreated && (behaviorDataModelBind || strictDataModelBind)) {
      await bindDataModelInDesigner(
        page,
        ciCreated.dmId,
        ciOutDir,
        result,
        strictDataModelBind
      );
    }

    await page
      .screenshot({ path: path.join(outDir, "designer.png"), fullPage: true })
      .catch(() => {});

    // === Required: behavior check in designer (stable, does not depend on preview routing/permissions) ===
    // In design mode, inputs may not be editable. Instead, verify that "タイトル" changes reflect on canvas.
    const hasNameOnCanvas =
      (await page
        .locator('#rendererContent :text("Name")')
        .count()
        .catch(() => 0)) > 0 ||
      (await page
        .locator("#rendererContent")
        .filter({ hasText: "Name" })
        .count()
        .catch(() => 0)) > 0;
    const hasAgeOnCanvas =
      (await page
        .locator('#rendererContent :text("Age")')
        .count()
        .catch(() => 0)) > 0 ||
      (await page
        .locator("#rendererContent")
        .filter({ hasText: "Age" })
        .count()
        .catch(() => 0)) > 0;

    if (!hasNameOnCanvas || !hasAgeOnCanvas) {
      throw new Error(
        `デザイナー上でタイトル反映を確認できませんでした (Name=${hasNameOnCanvas}, Age=${hasAgeOnCanvas})`
      );
    }
    result.steps.push({
      step: "designer_title_reflect",
      ok: true,
      hasNameOnCanvas,
      hasAgeOnCanvas,
    });

    // === Required: designer toolbar preview (recommended by user) ===
    // The preview button on designer toolbar should allow typing. It may open a new tab or toggle in-place.
    const ctx = page.context();
    const beforePages = ctx.pages();
    // Prefer the designer-toolbar preview icon: <i class="fa fa-eye-slash"></i>
    const previewClicked = await clickFirstVisible(page, [
      "button:has(i.fa-eye-slash)",
      "a:has(i.fa-eye-slash)",
      // fallbacks (labels/titles)
      'button:has-text("プレビュー")',
      'a:has-text("プレビュー")',
      'button[title*="プレビュー"]',
      'a[title*="プレビュー"]',
    ]);
    if (!previewClicked) {
      throw new Error(
        "デザイナー上部のプレビュー ボタンが見つかりませんでした"
      );
    }

    let designerRuntimePage = page;
    try {
      const p2 = await ctx.waitForEvent("page", { timeout: 5000 });
      await p2.waitForLoadState("domcontentloaded").catch(() => {});
      designerRuntimePage = p2;
    } catch {
      // in-place preview
    }
    if (designerRuntimePage === page) {
      const afterPages = ctx.pages();
      if (afterPages.length > beforePages.length) {
        designerRuntimePage = afterPages[afterPages.length - 1];
      }
    }

    const runtimeInputs = designerRuntimePage.locator(
      "#rendererContent input:visible"
    );
    await runtimeInputs
      .first()
      .waitFor({ state: "visible", timeout: 15000 })
      .catch(() => {});
    const inputCount = await runtimeInputs.count().catch(() => 0);
    if (inputCount < 2) {
      await designerRuntimePage
        .screenshot({
          path: path.join(outDir, "designer-preview-missing-input.png"),
          fullPage: true,
        })
        .catch(() => {});
      throw new Error(
        `デザイナー内プレビューで入力欄を検出できませんでした (inputs=${inputCount})`
      );
    }

    const i0 = runtimeInputs.nth(0);
    const i1 = runtimeInputs.nth(1);
    await i0.fill("Alice").catch(() => {});
    await i1.fill("20").catch(() => {});
    const v0 = await i0.inputValue().catch(() => "");
    const v1 = await i1.inputValue().catch(() => "");
    const designerPreviewTypeOk = v0.includes("Alice") && v1.includes("20");
    await designerRuntimePage
      .screenshot({
        path: path.join(outDir, "designer-preview.png"),
        fullPage: true,
      })
      .catch(() => {});
    if (!designerPreviewTypeOk) {
      throw new Error("デザイナー内プレビューで入力できませんでした");
    }
    result.steps.push({
      step: "designer_toolbar_preview_type",
      ok: true,
      inputCount,
    });

    // Optional: commit dialog open/close smoke test (no actual commit)
    if (behaviorCommit || strictCommit) {
      await openAndCloseCommitDialog(page, outDir, result, strictCommit);
    }

    // Optional: DataModel panel open/close smoke test (based on matrix.md "block icon")
    if (behaviorDataModel || strictDataModel) {
      await openAndCloseDataModelPanel(page, outDir, result, strictDataModel);
    }

    // === Optional: external preview flow (may be blocked by permissions/routing) ===
    const previewPage = await openPreviewPage(page);
    await previewPage.waitForLoadState("domcontentloaded").catch(() => {});
    await previewPage.waitForTimeout(2000);

    // Some environments show a "preview launcher" (project/version/org/developer selection),
    // which matches @matrix.md 6.4. In that case, click its "プレビュー" button again.
    const isPreviewLauncher =
      (await previewPage
        .locator("main#login, #login")
        .count()
        .catch(() => 0)) > 0 &&
      (await previewPage
        .locator("text=開発者")
        .count()
        .catch(() => 0)) > 0 &&
      (await previewPage
        .locator('button:has-text("プレビュー")')
        .count()
        .catch(() => 0)) > 0;

    let runtimePage = previewPage;
    if (isPreviewLauncher) {
      await previewPage
        .screenshot({
          path: path.join(outDir, "preview-launcher.png"),
          fullPage: true,
        })
        .catch(() => {});

      const ctx = previewPage.context();
      const before = ctx.pages();
      await previewPage
        .locator('button:has-text("プレビュー")')
        .first()
        .click({ force: true })
        .catch(() => {});

      try {
        const p2 = await ctx.waitForEvent("page", { timeout: 8000 });
        await p2.waitForLoadState("domcontentloaded").catch(() => {});
        runtimePage = p2;
      } catch {
        await previewPage.waitForLoadState("domcontentloaded").catch(() => {});
        const after = ctx.pages();
        runtimePage =
          after.length > before.length ? after[after.length - 1] : previewPage;
      }

      await runtimePage.waitForTimeout(2000);
      await runtimePage
        .screenshot({
          path: path.join(outDir, "preview-runtime.png"),
          fullPage: true,
        })
        .catch(() => {});
    }

    const previewInputs = await runtimePage
      .locator("input")
      .count()
      .catch(() => 0);
    const hasName =
      (await runtimePage
        .locator("text=Name")
        .count()
        .catch(() => 0)) > 0;
    const hasAge =
      (await runtimePage
        .locator("text=Age")
        .count()
        .catch(() => 0)) > 0;

    // Try typing into first two inputs (ignore failures, but record)
    let typeOk = false;
    if (previewInputs >= 2) {
      const i0 = runtimePage.locator("input").nth(0);
      const i1 = runtimePage.locator("input").nth(1);
      await i0.fill("Alice").catch(() => {});
      await i1.fill("20").catch(() => {});
      const v0 = await i0.inputValue().catch(() => "");
      const v1 = await i1.inputValue().catch(() => "");
      typeOk = v0.includes("Alice") && v1.includes("20");
    }

    await runtimePage
      .screenshot({ path: path.join(outDir, "preview.png"), fullPage: true })
      .catch(() => {});
    const html = await runtimePage.content().catch(() => "");
    if (html) fs.writeFileSync(path.join(outDir, "preview.html"), html);

    if (!typeOk) {
      // In many projects, preview routing/permissions may hide newly created pages.
      // Treat as warning by default, but allow strict mode for CI gating.
      result.steps.push({
        step: "preview_type",
        ok: false,
        previewInputs,
        hasName,
        hasAge,
        previewLauncher: isPreviewLauncher,
        warning: true,
        strict: strictPreview,
      });
      if (strictPreview) {
        throw new Error(
          `プレビューで入力できませんでした (inputs=${previewInputs})`
        );
      }
    } else {
      result.steps.push({
        step: "preview_type",
        ok: true,
        previewInputs,
        hasName,
        hasAge,
        previewLauncher: isPreviewLauncher,
      });
    }
  } catch (e) {
    await fail("behavior_smoke", e);
  } finally {
    if (ciCreated) {
      try {
        await deleteCiDataModel(
          page.context(),
          baseUrl,
          ciCreated.dmId,
          ciOutDir
        );
        result.steps.push({
          step: "ci_datamodel_delete",
          ok: true,
          dmId: ciCreated.dmId,
        });
      } catch (e) {
        // Never delete anything else; just record failure
        result.steps.push({
          step: "ci_datamodel_delete",
          ok: false,
          dmId: ciCreated.dmId,
          error: e?.message || String(e),
        });
        // If deletion fails, CI should fail (to avoid leaving trash behind)
        result.ok = false;
        process.exitCode = 1;
      }
    }
  }

  fs.writeFileSync(
    path.join(outDir, "summary.json"),
    JSON.stringify(result, null, 2)
  );
  if (!result.ok) process.exitCode = 1;
  console.log(`Behavior smoke summary: ${path.join(outDir, "summary.json")}`);
  return result;
}

async function getComponentCatalog(page) {
  const items = await page.evaluate(() => {
    const nodes = Array.from(document.querySelectorAll(".componentItem"));
    const normalize = (s) =>
      (s || "")
        .replace(/\u00A0/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    return nodes
      .map((el) => ({
        text: normalize(el.textContent),
        visible:
          !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length) &&
          getComputedStyle(el).visibility !== "hidden" &&
          getComputedStyle(el).display !== "none",
        draggable:
          el.getAttribute("draggable") === "true" ||
          !!el.closest('[draggable="true"]'),
      }))
      .filter((x) => x.text && x.text.length <= 80);
  });

  const pool = items.some((x) => x.draggable)
    ? items.filter((x) => x.draggable)
    : items;
  const uniq = new Map();
  for (const it of pool) {
    if (!uniq.has(it.text)) uniq.set(it.text, it);
  }
  return Array.from(uniq.keys());
}

async function tryUndo(page) {
  try {
    await page.keyboard.press("Meta+Z").catch(() => {});
    await page.keyboard.press("Control+Z").catch(() => {});
    await page.waitForTimeout(250);
  } catch {}

  const undoBtn = page.locator(
    'button:has(i.fa-undo), button:has(i.fa-rotate-left), button[title*="Undo"], button[title*="戻す"], button:has-text("戻す")'
  );
  if ((await undoBtn.count().catch(() => 0)) > 0) {
    await undoBtn
      .first()
      .click({ force: true })
      .catch(() => {});
    await page.waitForTimeout(250);
  }
}

async function testAllComponents(page) {
  ensureDir(COMPONENT_TEST_DIR);
  const runId = nowTag();
  const outDir = path.join(COMPONENT_TEST_DIR, runId);
  ensureDir(outDir);

  await page.waitForLoadState("domcontentloaded").catch(() => {});
  await page.waitForTimeout(3000);

  const catalog = await getComponentCatalog(page);
  console.log(`Component catalog: ${catalog.length} items`);

  const searchInput = page
    .locator('input[placeholder="検索"], input[placeholder*="検索"]')
    .first();

  const results = [];
  for (const name of catalog) {
    const safeName =
      name.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 60) || "component";
    const stepPrefix = path.join(outDir, safeName);
    console.log(`\n[component] ${name}`);

    try {
      if ((await searchInput.count().catch(() => 0)) > 0) {
        await searchInput.fill("").catch(() => {});
        await searchInput.fill(name).catch(() => {});
        await page.waitForTimeout(400);
      }

      const beforeCount = await page
        .locator("#rendererContent *")
        .count()
        .catch(() => 0);
      await performDragAndDrop(page, name);
      await page.waitForTimeout(800);
      const afterCount = await page
        .locator("#rendererContent *")
        .count()
        .catch(() => 0);

      const ok = afterCount > beforeCount;
      results.push({ name, ok, beforeCount, afterCount });
      emitChecklist(`component.${name}`, ok);

      if (!ok) {
        await page
          .screenshot({ path: `${stepPrefix}.fail.png`, fullPage: true })
          .catch(() => {});
        const html = await page.content().catch(() => "");
        if (html) fs.writeFileSync(`${stepPrefix}.fail.html`, html);
      }

      await tryUndo(page);
      if ((await searchInput.count().catch(() => 0)) > 0) {
        await searchInput.fill("").catch(() => {});
        await page.waitForTimeout(200);
      }
    } catch (e) {
      results.push({ name, ok: false, error: e?.message || String(e) });
      await page
        .screenshot({ path: `${stepPrefix}.error.png`, fullPage: true })
        .catch(() => {});
    }
  }

  fs.writeFileSync(
    path.join(outDir, "summary.json"),
    JSON.stringify(
      {
        runId,
        url: page.url(),
        total: results.length,
        passed: results.filter((r) => r.ok).length,
        failed: results.filter((r) => !r.ok).length,
        results,
      },
      null,
      2
    )
  );

  const failed = results.filter((r) => !r.ok);
  emitChecklist("test_all_components", failed.length === 0);
  if (failed.length > 0) {
    console.error(`Component test failed: ${failed.length}/${results.length}`);
    process.exitCode = 1;
  } else {
    console.log(`Component test passed: ${results.length}/${results.length}`);
  }
  return {
    runId,
    url: page.url(),
    total: results.length,
    passed: results.filter((r) => r.ok).length,
    failed: failed.length,
    results,
  };
}

async function applyCookiesToContext(context, baseUrl) {
  const cookiesJsonPath = getArg("--cookies");
  const cookieHeader = process.env.NTMATRIX_COOKIE || getArg("--cookie-header");

  if (cookiesJsonPath) {
    const raw = fs.readFileSync(cookiesJsonPath, "utf8");
    const parsed = JSON.parse(raw);
    const cookies = Array.isArray(parsed) ? parsed : parsed.cookies;
    if (!Array.isArray(cookies)) {
      throw new Error(
        `cookies json must be an array or { cookies: [...] }: ${cookiesJsonPath}`
      );
    }
    await context.addCookies(
      cookies.map((c) => ({
        ...c,
        // Playwright requires either url or (domain+path). If url missing, set it.
        url: c.url || baseUrl,
      }))
    );
    console.log(`Cookieを読み込みました: ${cookiesJsonPath}`);
    return true;
  }

  if (cookieHeader) {
    const cookiePairs = parseCookieHeader(cookieHeader);
    if (cookiePairs.length === 0) return false;
    await context.addCookies(cookiePairs.map((c) => ({ ...c, url: baseUrl })));
    console.log("CookieヘッダーからCookieを適用しました。");
    return true;
  }

  return false;
}

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

    // 既にCIテストプロジェクトが存在するかチェック
    await page.waitForTimeout(1000); // 一覧描画待ち
    const exists = await page.locator(`text=${projectName}`).count();
    if (exists > 0) {
      console.log(
        `既に${projectName}プロジェクトが存在するため作成をスキップします。`
      );
      return;
    }

    // 「新しいプロジェクトを作成」ボタンを探してクリック
    // 「新しいプロジェクトを作成」ボタンを探してクリック
    // CSSクラス（btn-info.pull-right）だけでなく、テキストやroleも考慮
    const createBtn = await page.locator(
      'button:has-text("新しいプロジェクトを作成"), a:has-text("新しいプロジェクトを作成")'
    );
    if ((await createBtn.count()) > 0) {
      await createBtn.first().click();
      await page.waitForTimeout(1000); // モーダル/パネル表示待ち

      // Blank projectパネルをクリック
      // モーダルが表示されていることを確認
      const modalDialog = page.locator('.modal, .nmodal, [role="dialog"]');
      await modalDialog
        .first()
        .waitFor({ state: "visible", timeout: 10000 })
        .catch(() => {});

      // モーダルないの「Blank」または「空白」を含む要素を探す
      // 以前は div.panel-body だったが、構造を検索する
      // 具体的には .panel-body の中のテキスト、あるいは .panel 自体
      const blankPanel = modalDialog.locator(
        'div.panel-body:has-text("Blank"), div.panel-body:has-text("空白"), .panel:has-text("Blank"), .panel:has-text("空白")'
      );

      // 見つからない場合は、"Blank" というテキストを持つ任意のdivをクリック (Modal内に限定)
      let targetPanel = blankPanel;
      if ((await blankPanel.count()) === 0) {
        targetPanel = modalDialog.locator(
          'div:has-text("Blank"), div:has-text("空白")'
        );
      }

      if ((await targetPanel.count()) > 0) {
        // 最初の候補をクリック
        const panel = targetPanel.first();
        // force: true を追加して、多少の被りがあってもクリックを実行
        await panel.click({ force: true });

        await page.waitForTimeout(1000);

        // モーダル内の入力欄 (input.form-control)
        // 既に modalDialog は取得済みだが、再取得または子要素検索
        const modal = modalDialog.first();

        // 入力欄を探す。placeholderやlabelもヒントにできるが、ここでは input[type="text"] を優先
        let nameInput = modal.locator('input[type="text"], input.form-control');

        // モーダルが見つからない場合はページ全体から探す (fallback)
        if ((await modal.count()) === 0) {
          nameInput = page.locator('input[type="text"].form-control');
        }

        try {
          // モーダルがアニメーションで表示されるのを待つ
          await modal.waitFor({ state: "visible", timeout: 10000 });
          // 入力欄が表示され、操作可能になるまで待つ
          await nameInput.first().waitFor({ state: "visible", timeout: 10000 });
        } catch (e) {
          console.log(
            "プロジェクト名入力欄またはモーダルの待機中にタイムアウトしました。"
          );
        }

        if ((await nameInput.count()) > 0) {
          console.log(
            "プロジェクト名入力欄が見つかりました。フォーカスを設定します。"
          );
          // フォーカスを確実にするためにクリック
          await nameInput.first().click({ force: true });
          await page.waitForTimeout(500);

          await nameInput.first().fill(projectName); // typeよりfillの方が確実な場合がある
          console.log(`プロジェクト名「${projectName}」を入力しました。`);

          // input/changeイベントをdispatchしてバリデーションを確実に通す
          await nameInput.first().evaluate((el) => {
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
            el.blur();
          });

          await page.waitForTimeout(1000); // バリデーション待ち

          // 完了ボタンをクリック
          // btn-primary かつ "完了" or "Create" or "OK"
          const doneBtn = await page.locator(
            'button.btn-primary:has-text("完了"), button:has-text("Create"), button:has-text("OK")'
          );
          if ((await doneBtn.count()) > 0) {
            console.log("完了ボタンをクリックします。");
            await doneBtn.first().click();

            // プロジェクト作成後の遷移を待機。
            // 成功するとモーダルが消える、またはURLが変わるなどの変化があるはず。
            // ここでは "プロジェクト...を自動作成しました" と出す前に少し待つ
            await page.waitForTimeout(5000);
            console.log(`プロジェクト「${projectName}」を自動作成しました。`);
          } else {
            console.log(
              "完了ボタンが見つかりませんでした。スクリーンショットを保存します。"
            );
            await page.screenshot({
              path: "debug-create-project-no-done-btn.png",
            });
          }
        } else {
          console.log(
            "プロジェクト名入力欄が見つかりませんでした。スクリーンショットを保存します。"
          );
          await page.screenshot({ path: "debug-create-project-no-input.png" });
        }
      } else {
        console.log(
          "Blank projectパネルが見つかりませんでした。スクリーンショットを保存します。"
        );
        await page.screenshot({
          path: "debug-create-project-no-blank-panel.png",
        });
      }
    } else {
      console.log(
        "新しいプロジェクトを作成ボタンが見つかりませんでした。スクリーンショットを保存します。"
      );
      await page.screenshot({ path: "debug-create-project-no-create-btn.png" });
    }
  } else {
    console.log("プロジェクトメニューが見つかりませんでした。");
  }
}

// プロジェクト詳細画面へ遷移する (UI管理画面へ)
async function openProjectDetail(page, projectName) {
  // プロジェクト一覧で該当プロジェクトを探す
  await page.waitForTimeout(2000); // 一覧描画待ち

  // リスト表示とグリッド表示の両方に対応するため、テキストで探す
  // 行またはカード全体を取得したい
  const projectElement = page.locator(`text=${projectName}`).first();

  if ((await projectElement.count()) > 0) {
    // 親要素へ遡って、行(tr)またはカード(div[class*="project"])を探す
    const rowHandle = await projectElement.evaluateHandle((el) => {
      return el.closest('tr, .list-group-item, div[class*="project"], li');
    });

    if (rowHandle) {
      // プロジェクトカード内の「UI」または「programManagement」リンクを探す
      // 構造: <a href="/programManagement?..." title="UI">...</a>
      const uiLink = await rowHandle
        .asElement()
        .$(
          'a[href*="/programManagement"][title="UI"], a[href*="/programManagement"]'
        );

      if (uiLink) {
        console.log("UI管理画面へのリンクをクリックします。");
        await uiLink.click();
        return true;
      }

      // リンクがない場合 (権限不足や構造違い)
      console.log("UI管理画面へのリンクが見つかりません。");

      // バックアップ: 3点リーダ -> 編集 (以前のロジック)
      let moreBtn = await rowHandle
        .asElement()
        .$(
          'button[aria-label="more"], button[aria-label="More"], .fa-ellipsis-h, .fa-ellipsis-v, .dropdown-toggle'
        );
      if (moreBtn) {
        await moreBtn.click();
        await page.waitForTimeout(500);
        const editBtn = page
          .locator(
            '.dropdown-menu a:has-text("編集"), .dropdown-menu a:has-text("Edit")'
          )
          .first();
        if ((await editBtn.count()) > 0) {
          await editBtn.click({ force: true });
          return true;
        }
      }

      // 最終手段: タイトルクリック (ただしこれは展開しかしない可能性大)
      console.log("タイトルをクリックしてみます。");
      await projectElement.click();
      return true;
    }
  } else {
    console.log(`プロジェクト「${projectName}」が見つかりませんでした。`);
  }
  return false;
}

// プロジェクト内部の自動化処理
async function automateProjectInternal(page) {
  console.log("プロジェクト内部の自動化を開始します...");

  // 1. 管理画面 (/programManagement) がロードされるのを待つ
  try {
    await page.waitForURL("**/programManagement*", { timeout: 20000 });
    console.log("管理画面に遷移しました:", page.url());
  } catch (e) {
    console.log(
      "管理画面への遷移がタイムアウトしました。現在のURL:",
      page.url()
    );
  }

  await page.waitForLoadState("domcontentloaded");
  await page.waitForTimeout(3000);

  // 2. 「ページ/コンポーネント」メニューをクリック
  console.log("「ページ/コンポーネント」メニューを探します...");
  // 2. 「ページ/コンポーネント」メニューをクリック
  console.log("「ページ/コンポーネント」メニューを探します...");

  // a.dropdown-toggle を優先して探す
  let pageMenu = page
    .locator("a.dropdown-toggle")
    .filter({
      hasText:
        /プロジェクト\/ページ\/コンポーネント管理|ページ\/コンポーネント/,
    })
    .first();

  if ((await pageMenu.count()) === 0) {
    console.log("a.dropdown-toggle が見つかりません。汎用検索します。");
    // テキストが厳密に一致するものを探す
    pageMenu = page
      .locator("a, span")
      .filter({ hasText: /^プロジェクト\/ページ\/コンポーネント管理$/ })
      .first();
  }

  if ((await pageMenu.count()) > 0) {
    console.log(
      "メニュー要素をクリックします。: " + (await pageMenu.textContent()).trim()
    );

    // 親の li 要素を取得
    const liElement = pageMenu.locator("..");

    await pageMenu.click({ force: true });

    // この li 内の ul.dropdown-menu が visible になるのを待つ
    // 複数の ul がある可能性があるため、"ページの追加" を含むものをターゲットにする
    const specificDropdown = liElement
      .locator("ul.dropdown-menu")
      .filter({ hasText: "ページの追加" })
      .first();

    try {
      await specificDropdown.waitFor({ state: "visible", timeout: 3000 });
      console.log("対象のドロップダウンが表示されました。");

      // ドロップダウンの中身をログ出力 (デバッグ用)
      const html = await specificDropdown.innerHTML();
      console.log("Dropdown Content: " + html);
    } catch (e) {
      console.log(
        "ドロップダウンの表示待機でタイムアウトしました。再試行します。"
      );
      await pageMenu.click({ force: true });
      await specificDropdown.waitFor({ state: "visible", timeout: 3000 });
    }

    // 3. ドロップダウン内の「ページの追加」をクリック
    // 3. ドロップダウン内の「ページの追加」をクリック
    // Extract Project ID before clicking (from current URL)
    const currentUrl = page.url();
    console.log(`Current URL before page creation: ${currentUrl}`);
    let projectId = "";
    try {
      const urlObj = new URL(currentUrl);
      const sParam = urlObj.searchParams.get("s");
      if (sParam) {
        const decodedS = Buffer.from(sParam, "base64").toString("utf8");
        console.log(`Decoded S param: ${decodedS}`);
        const params = new URLSearchParams(decodedS);
        projectId = params.get("pid") || params.get("oid");
        console.log(`Extracted Project ID: ${projectId}`);
      }
    } catch (e) {
      console.error("Error parsing Project ID:", e);
    }

    const addPageBtn = specificDropdown
      .locator('a:has-text("ページの追加")')
      .first();
    if ((await addPageBtn.count()) > 0) {
      console.log("「ページの追加」をクリックします。");
      await addPageBtn.evaluate((el) => el.click());
      console.log("クリックコマンドを送信しました。");
      await page.waitForTimeout(3000);

      // Dump HTML to check keys
      const designerHtml = await page.content();
      const fs = require("fs");
      fs.writeFileSync("designer_dump.html", designerHtml);
      console.log("designer_dump.html を保存しました。");

      // Check if we are already in the designer (EditProjectSelf)
      const currentUrlAfterCreate = page.url();
      if (
        currentUrlAfterCreate.includes("EditProjectSelf") ||
        currentUrlAfterCreate.includes("designer")
      ) {
        console.log(
          `ページ作成後、自動的にデザイナーに遷移しました: ${currentUrlAfterCreate}`
        );
        const finalHtml = await page.content();
        fs.writeFileSync("designer_final_dump.html", finalHtml);

        if (hasFlag("--behavior-smoke")) {
          console.log(
            "Running behavior smoke test (based on matrix.md 2.4)..."
          );
          const r = await testBehaviorSmoke(page);
          emitChecklist("behavior_smoke", !!r?.ok);
          emitChecklistFromSteps("behavior_smoke", r?.steps);
          return;
        }

        if (hasFlag("--test-all-components")) {
          console.log("Running test: all components");
          await testAllComponents(page);
          return;
        }

        // --- Drag and Drop Implementation ---
        console.log(
          "Starting Drag and Drop of Label component (Auto-Redirect)..."
        );
        await performDragAndDrop(page, "ラベル");

        console.log("Waiting for component to appear on canvas...");
        await page.waitForTimeout(5000); // 5秒待機

        // Edit the Label Text directly on Canvas (contenteditable)
        console.log(
          "Setting Label text to 'Hello world' via canvas element..."
        );

        // Target the contenteditable element.
        // We search globally since #rendererContent might have multiple layers
        const editableLabel = page.locator(".nt-editable").first();

        try {
          // Attached状態（DOMに存在）を待つ
          await editableLabel.waitFor({ state: "attached", timeout: 10000 });
          console.log("Found editable label (attached).");

          // Force update via evaluate
          await editableLabel.evaluate((el) => {
            el.innerText = "Hello world";
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
            el.dispatchEvent(new Event("blur", { bubbles: true }));
          });

          console.log("Updated text via evaluate.");
        } catch (e) {
          console.error("Failed to edit canvas element:", e.message);
        }

        // Verify
        await page.waitForTimeout(1000);
        const labelText = await editableLabel.innerText();
        console.log(`Current Label Text: "${labelText}"`);
        if (labelText.includes("Hello world")) {
          console.log("SUCCESS: Label text updated to 'Hello world'.");
        } else {
          console.error("FAILURE: Label text did not update.");
        }
        // ------------------------------------

        // We are done with entry
        return;
      }

      // Find Page ID
      const pageIds = await page.evaluate(() => {
        // Look for nodes that are likely pages (under the page node if possible, or just all data-node-id)
        // The dump showed data-node-id on the divs wrapping the page links
        const nodes = Array.from(
          document.querySelectorAll("div[data-node-id]")
        );
        return nodes
          .map((el) => el.getAttribute("data-node-id"))
          .filter((id) => id && id.length > 10); // Simple filter
      });
      console.log("Found Node IDs:", pageIds);

      let targetPageId = null;
      if (pageIds.length > 0) {
        pageIds.sort(); // String sort is usually fine for these long IDs (timestamps/snowflakes)
        targetPageId = pageIds[pageIds.length - 1]; // Pick latest
        console.log(`Targeting Page ID: ${targetPageId}`);
      }

      if (targetPageId) {
        console.log(`Interacting with Page ID: ${targetPageId}`);

        // Selector for the page row
        const rowSelector = `div[data-node-id="${targetPageId}"]`;
        // The icon is inside the row. We need to find the specific element structure.
        // Based on dump: .node-content contains the link and the dropdown.
        // Dropdown trigger is inside a span with display:none (unhidden on hover)

        // We will use evaluate to simulate the hover class or property if simple hover doesn't work,
        // but page.hover() is best first try.

        try {
          // Debug visibility
          const isVisible = await page.isVisible(rowSelector);
          console.log(`Element ${rowSelector} visible: ${isVisible}`);
          if (!isVisible) {
            const box = await page.locator(rowSelector).boundingBox();
            console.log(`Element bounding box:`, box);
            // Try to scroll into view
            await page
              .locator(rowSelector)
              .scrollIntoViewIfNeeded()
              .catch((e) => console.log("Scroll failed:", e));
          }

          try {
            // Hover to reveal the menu
            console.log(`Hovering over ${rowSelector}...`);
            await page.hover(rowSelector, { timeout: 2000 }); // Short timeout
            await page.waitForTimeout(500); // Wait for transition
          } catch (e) {
            console.log(
              "Hover failed (continuing to click anyway):",
              e.message
            );
            // Fallback: force visibility of the menu icon via JS if possible
            // This depends on how the menu is hidden.
            // If it's a child element that is hidden, we might need to target that.
          }

          // The menu icon selector
          // From dump: span > div[n-component="NDropDown"] > i.fa-ellipsis-v
          const menuIconSelector = `${rowSelector} .fa-ellipsis-v, ${rowSelector} [aria-label="more"], ${rowSelector} button`;

          // Click the ellipsis
          console.log(`Clicking 3-dot menu: ${menuIconSelector}`);
          await page.click(menuIconSelector, { force: true });
          await page.waitForTimeout(1000); // Wait for dropdown

          // Inspect dropdown options
          // We look for any likely action.
          const menuItems = await page.$$eval(
            ".n-dropdown-option, .dropdown-menu li",
            (items) => items.map((i) => i.innerText.trim())
          );
          console.log("Dropdown items found:", menuItems);

          // Try to click "開く" (Open) or "編集" (Edit) or "UI"
          const clicked = await page.evaluate(() => {
            // NDropDown often renders options in a popper/body layer.
            const items = Array.from(
              document.querySelectorAll(
                ".n-dropdown-option, .dropdown-menu li, .dropdown-item"
              )
            );
            // Filter for visible items if possible, but for now just text match
            const target = items.find(
              (i) =>
                i.innerText.includes("編集") ||
                i.innerText.includes("開く") ||
                i.innerText.includes("UI") ||
                i.innerText.includes("Edit") ||
                i.innerText.includes("Open")
            );

            // If specifically looking for "UI" (UI Designer)
            if (target) {
              target.click();
              return target.innerText;
            } else if (items.length > 0) {
              // Fallback: click the first item if it's the only logic choice (often "Edit" is first)
              items[0].click();
              return items[0].innerText;
            }
            return null;
          });

          if (clicked) {
            console.log(`Clicked menu item: ${clicked}`);
          } else {
            console.error("No suitable menu item found to click.");
          }

          // Wait for designer elements
          await page.waitForFunction(
            () =>
              document.querySelector("#nt-ui-canvas") ||
              document.querySelector(".newtypeDesigner"),
            { timeout: 20000 }
          );
          console.log("Designer elements detected after menu interaction!");
        } catch (e) {
          console.error("Error interacting with 3-dot menu:", e);
        }

        const finalUrl = page.url();
        const finalTitle = await page.title();
        console.log(`Final URL: ${finalUrl}`);
        console.log(`Final Title: ${finalTitle}`);

        // Final Dump for verification
        const finalHtml = await page.content();
        fs.writeFileSync("designer_final_dump.html", finalHtml);
        console.log("Saved designer_final_dump.html");

        if (hasFlag("--behavior-smoke")) {
          console.log(
            "Running behavior smoke test (based on matrix.md 2.4)..."
          );
          const r = await testBehaviorSmoke(page);
          emitChecklist("behavior_smoke", !!r?.ok);
          emitChecklistFromSteps("behavior_smoke", r?.steps);
          return;
        }

        if (hasFlag("--test-all-components")) {
          console.log("Running test: all components");
          await testAllComponents(page);
          return;
        }

        // --- Drag and Drop Implementation ---
        console.log("Starting Drag and Drop of Input component...");
        await performDragAndDrop(page, "Input");
        // ------------------------------------
      }

      await page.screenshot({ path: "debug-designer-entry.png" });
    } else {
      console.log("「ページの追加」メニューが見つかりませんでした。");
      await page.screenshot({ path: "debug-add-page-not-found.png" });
    }
  } else {
    console.log("「ページ/コンポーネント」メニューが見つかりませんでした。");
    await page.screenshot({ path: "debug-page-menu-not-found.png" });
  }
}

// Drag and Drop Helper Function
async function performDragAndDrop(page, componentName) {
  try {
    console.log(`Searching for component: ${componentName}`);

    // Use a selector that ensures we get the visible component specific to the name.
    // We use >> visible=true to filter out hidden duplicates.
    const sourceSelector = `.componentItem:has-text("${componentName}") >> visible=true`;

    // Wait for the visible component to appear
    try {
      await page.waitForSelector(sourceSelector, { timeout: 5000 });
    } catch (e) {
      console.log(
        `WaitForSelector failed for ${componentName}. Trying to find if any exist...`
      );
    }

    const source = page.locator(sourceSelector).first();

    // Check availability
    if ((await source.count()) === 0) {
      console.error(
        `Visible Component "${componentName}" not found in sidebar.`
      );

      // Debug: check if hidden ones exist
      const anySource = page.locator(
        `.componentItem:has-text("${componentName}")`
      );
      const count = await anySource.count();
      if (count > 0) {
        console.log(
          `Found ${count} hidden elements matching "${componentName}". Trying to expand sidebar...`
        );

        // Try to click toggle bar (left side)
        // Based on dump: left sider has static-positioned or we pick the first toggle bar
        const toggler = page
          .locator(".n-layout-sider--static-positioned .n-layout-toggle-bar")
          .first();
        if (await toggler.isVisible()) {
          console.log("Clicking toggle bar...");
          await toggler.click();
          await page.waitForTimeout(1000);
          // Retry finding source
          if ((await source.count()) > 0) {
            console.log("Component became visible!");
          }
        }
      }
      return;
    }

    console.log(`Visible component "${componentName}" found.`);

    // Target: Central Canvas
    const targetSelector = "#rendererContent";
    await page.waitForSelector(targetSelector, { timeout: 5000 });
    const target = page.locator(targetSelector).first();

    const sourceBox = await source.boundingBox();
    const targetBox = await target.boundingBox();

    if (sourceBox && targetBox) {
      console.log(
        `Dragging from (${sourceBox.x}, ${sourceBox.y}) to (${
          targetBox.x + 100
        }, ${targetBox.y + 100})`
      );

      // Manual Mouse Drag
      await page.mouse.move(
        sourceBox.x + sourceBox.width / 2,
        sourceBox.y + sourceBox.height / 2
      );
      await page.mouse.down();
      await page.waitForTimeout(200);

      // Drag moves
      await page.mouse.move(targetBox.x + 100, targetBox.y + 100, {
        steps: 20,
      });
      await page.waitForTimeout(200);

      await page.mouse.up();
      console.log("Drop action completed.");

      await page.waitForTimeout(3000); // Wait for UI update

      // Verify
      const canvasContent = await target.innerHTML();
      // Check for both user-visible text or internal classes
      if (
        canvasContent.includes("n-input") ||
        canvasContent.includes("input") ||
        canvasContent.includes("入力")
      ) {
        console.log("Verification Success: Component detected in canvas.");
      } else {
        console.log(
          "Verification Warning: Could not explicitly confirm component in canvas."
        );
        console.log(
          "Canvas content snippet: " + canvasContent.substring(0, 200)
        );
      }
    } else {
      console.error("Bounding box missing for drag operation.");
    }

    await page.screenshot({ path: "debug-after-success-dnd.png" });
  } catch (e) {
    console.error("Error during Drag and Drop:", e);
    await page.screenshot({ path: "debug-dnd-error.png" });
  }
}

// ドメインごとのSSL証明書有効期限チェック
async function checkSSLCertExpiry(targetUrl) {
  return new Promise((resolve, reject) => {
    const { hostname, port } = url.parse(targetUrl);
    const socket = tls.connect(
      port || 443,
      hostname,
      { servername: hostname },
      () => {
        const cert = socket.getPeerCertificate();
        if (cert && cert.valid_to) {
          resolve(cert.valid_to); // 例: 'Jul  7 23:59:59 2025 GMT'
        } else {
          reject("証明書情報が取得できませんでした");
        }
        socket.end();
      }
    );
    socket.on("error", reject);
  });
}

// Helper to edit component properties in the right sidebar
// Returns true if a matching property input was found and we attempted to set it.
async function editComponentProperty(page, propertyLabel, value) {
  try {
    // There might be multiple sidebars sharing this class.
    // The one with properties is usually the last one or can be identified by content.
    // Based on logs, the first one is component list.
    const sidebar = page
      .locator("aside.n-layout-sider--right-placement")
      .last();
    await sidebar.waitFor({ state: "visible", timeout: 5000 });

    const shouldDebug = hasFlag("--debug-properties");

    const synonyms = {
      title: ["タイトル", "Title", "表示名", "ラベル", "項目名"],
      タイトル: ["Title", "title", "表示名", "ラベル", "項目名"],
      id: ["ID", "Id", "識別子", "キー"],
      name: ["Name", "名称", "名前"],
    };

    const candidates = [propertyLabel, ...(synonyms[propertyLabel] || [])];

    let label = sidebar
      .locator(`.title label:has-text("${candidates[0]}")`)
      .first();
    for (const c of candidates) {
      label = sidebar.locator(`.title label:has-text("${c}")`).first();
      if ((await label.count()) > 0) break;
    }

    if ((await label.count()) === 0) {
      console.log(
        `Property label "${propertyLabel}" not found. Listing available properties...`
      );
      const allLabels = await sidebar.locator(".title label").allInnerTexts();
      console.log("Available Properties:", allLabels);

      // id/name はコンポーネントによっては存在しない。挙動テストではスキップ扱いにする。
      if (propertyLabel === "id" || propertyLabel === "name") {
        console.log(
          `Skipping "${propertyLabel}" because it does not exist in this component properties.`
        );
        return false;
      }

      if (propertyLabel === "title") {
        console.log("Trying to find 'タイトル' or similar...");
        const fallbacks = ["タイトル", "表示名", "ラベル", "項目名", "Title"];
        for (const fb of fallbacks) {
          label = sidebar.locator(`.title label:has-text("${fb}")`).first();
          if ((await label.count()) > 0) {
            console.log(`Found fallback property: ${fb}`);
            break;
          }
        }
      }

      if (propertyLabel === "テキスト") {
        console.log("Trying to find 'Text' or 'Value' or similar...");
        const fallbacks = [
          "Text",
          "Value",
          "内容",
          "表示テキスト",
          "ツールチップのテキスト",
        ];
        for (const fb of fallbacks) {
          label = sidebar.locator(`.title label:has-text("${fb}")`).first();
          if ((await label.count()) > 0) {
            console.log(`Found fallback property: ${fb}`);
            break;
          }
        }

        // If still not found, defaulting to the VERY FIRST input in the sidebar
        if ((await label.count()) === 0) {
          console.log(
            "No matching property label found. Attempting to target the first text input."
          );
          const firstInput = sidebar.locator('input[type="text"]').first();
          if ((await firstInput.count()) > 0) {
            console.log("Found an input. Filling it...");
            await firstInput.click();
            await firstInput.fill(value);
            await firstInput.press("Enter");
            return true;
          }
        }
      }
    }

    if ((await label.count()) > 0) {
      // Traverse to input
      const titleDiv = label.locator("xpath=..");

      // Try explicit hierarchy from dump:
      // The input structure in dump:
      // <div class="title"><label>...</label></div>
      // <div class="n-input ..."> ... <input ...> </div>
      // OR the input is further down.

      // We'll search for the first input that appears AFTER this title div, in the same container.
      // Using Playwright locator chaining with xpath is robust.

      // Strategy: Find the closest input following the title div
      const inputField = page
        .locator("input")
        .filter({
          has: page.locator(
            `xpath=preceding::label[contains(text(), "${await label.innerText()}")]`
          ),
        })
        .first();

      // Check if that actually worked (Playwright sometimes struggles with reversed axis in filter)
      // Let's use simple execution context if locator fails
      const nextInput = titleDiv.locator("xpath=following::input[1]");

      if ((await nextInput.count()) > 0) {
        console.log(
          `Found input for "${propertyLabel}". Filling with "${value}"...`
        );
        if (shouldDebug) {
          const allLabels = await sidebar
            .locator(".title label")
            .allInnerTexts();
          console.log("DEBUG: Available Properties in Sidebar:", allLabels);
        }
        // Try clicking the parent wrapper first, as the input itself might be hidden/overlayed
        const wrapper = nextInput.locator("xpath=..");
        if (await wrapper.isVisible()) {
          await wrapper.click({ force: true });
        } else {
          // Try forcing click on input
          await nextInput
            .click({ force: true })
            .catch((e) => console.log("Force click failed:", e.message));
        }

        // Use JS to set value directly to bypass visibility checks
        await nextInput.evaluate((el, val) => {
          el.value = val;
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
          el.dispatchEvent(new Event("blur", { bubbles: true }));
        }, value);

        await page.waitForTimeout(500);
        return true;
      } else {
        console.error(`Input field for "${propertyLabel}" not found.`);
        return false;
      }
    }

    await page.waitForTimeout(1000);
    return false;
  } catch (e) {
    console.error(`Error editing property "${propertyLabel}":`, e);
    return false;
  }
}

async function isProbablyLoggedIn(page) {
  try {
    const u = page.url();
    if (u.includes("/login") || u.includes("/loginDev")) return false;
    // Logged-in shell typically has left nav items
    const navCount = await page
      .locator(".px-nav-content .px-nav-item")
      .count()
      .catch(() => 0);
    if (navCount > 0) return true;
    // Fallback: if login form fields are present, treat as not logged in
    const loginFieldCount = await page
      .locator('input[placeholder*="メール形式"], text=認証コード')
      .count()
      .catch(() => 0);
    return loginFieldCount === 0;
  } catch {
    return false;
  }
}

async function waitForManualLogin(page, timeoutMs) {
  const start = Date.now();
  let lastLogAt = 0;
  while (Date.now() - start < timeoutMs) {
    if (await isProbablyLoggedIn(page)) return true;
    const elapsed = Date.now() - start;
    if (elapsed - lastLogAt > 10000) {
      console.log(
        `ログイン待機中...（経過${Math.floor(
          elapsed / 1000
        )}秒, url=${page.url()}）`
      );
      lastLogAt = elapsed;
    }
    await page.waitForTimeout(500).catch(() => {});
  }
  return false;
}

(async () => {
  const baseUrl = getArg("--base-url") || DEFAULT_BASE_URL;
  const loginUrl = `${baseUrl}/login`;
  const homeUrl = `${baseUrl}/`;
  const headless = hasFlag("--headless");
  const interactive = hasFlag("--interactive"); // 明示的に指定された場合のみ対話待ちする
  const isCI = String(process.env.CI || "").toLowerCase() === "true";
  const loginWaitSeconds = Number(getArg("--login-wait-seconds") || 600);
  const loginWaitMs = Number.isFinite(loginWaitSeconds)
    ? Math.max(5, loginWaitSeconds) * 1000
    : 600000;

  // CI/自動テストとして実行されているか（ログインが必要なら fail させたい）
  const isTestModeRequested =
    hasFlag("--test-all-components") ||
    hasFlag("--behavior-smoke") ||
    hasFlag("--behavior-commit") ||
    hasFlag("--behavior-strict-commit") ||
    hasFlag("--behavior-datamodel") ||
    hasFlag("--behavior-strict-datamodel") ||
    hasFlag("--behavior-datamodel-bind") ||
    hasFlag("--behavior-strict-datamodel-bind") ||
    hasFlag("--ci-datamodel");

  setupChecklistMode();

  let browser = await chromium.launch({ headless });

  // StorageStateの読み込み設定
  let contextOptions = {};
  if (fs.existsSync(STORAGE_STATE_PATH)) {
    try {
      contextOptions.storageState = STORAGE_STATE_PATH;
      console.log("StorageState(Cookie+LocalStorage)を読み込みました。");
    } catch (e) {
      console.log("StorageStateの読み込みに失敗しました:", e);
    }
  }
  let context = await browser.newContext(contextOptions);
  // StorageStateが無い場合のみ、保持Cookieを注入してログイン復元を試みる
  if (!contextOptions.storageState) {
    try {
      await applyCookiesToContext(context, baseUrl);
    } catch (e) {
      console.log("Cookieの適用に失敗しました:", e?.message || e);
    }
  }

  let page = await context.newPage();

  // ログイン状態確認（トップページにアクセスしてみる）
  await page.goto(homeUrl);
  await page.waitForLoadState("networkidle");
  await dumpPageArtifacts(page, "home_or_redirect");
  // SPA描画待ち（networkidle だけだと早すぎることがある）
  await page.waitForTimeout(4000);
  await dumpPageArtifacts(page, "home_after_wait");

  // ログインページにリダイレクトされたか、ログインが必要な要素があるかで判断
  // /loginDev へリダイレクトされるケースがあるため両方見る
  const isLoginPage =
    page.url().includes("/login") ||
    page.url().includes("/loginDev") ||
    (await page
      .locator('input[placeholder*="メール形式"], text=認証コード')
      .count()
      .catch(() => 0)) > 0;

  if (isLoginPage) {
    console.log("ログインが必要です。手動でログインしてください。");
    // ログイン画面を開く
    await page.goto(loginUrl);
    await page.waitForLoadState("networkidle");
    await dumpPageArtifacts(page, "login");

    // headless かつ interactive 指定が無い場合:
    // - CIでは入力待ちできないため失敗扱いで終了
    // - ローカル/手元実行では、自動でブラウザ(表示あり)を開いて手動ログイン→storage更新→続行
    if (headless && !interactive) {
      if (isCI) {
        console.log(
          "headless でログインが必要なため終了します。Cookie/StorageStateを渡すか、--interactive を付けて手動ログインしてください。"
        );
        if (isTestModeRequested) {
          console.error(
            "CI(非対話)でテストモード実行中にログインが必要になったため失敗扱いにします（exitCode=1）。storage.json を更新して再実行してください。"
          );
          process.exitCode = 1;
        }
        emitChecklist("login", false);
        await browser.close().catch(() => {});
        return;
      }

      console.log(
        "Cookie/StorageStateが失効しているため、ブラウザ(表示あり)を開いて手動ログインに切り替えます。ログイン完了を自動検知してstorage.jsonを保存します。"
      );

      // headless で開いたブラウザは閉じ、headed で再起動して同一実行で継続する
      await browser.close().catch(() => {});
      browser = await chromium.launch({ headless: false });
      context = await browser.newContext(contextOptions);
      if (!contextOptions.storageState) {
        try {
          await applyCookiesToContext(context, baseUrl);
        } catch (e) {
          console.log("Cookieの適用に失敗しました:", e?.message || e);
        }
      }
      page = await context.newPage();

      await page.goto(loginUrl);
      await page.waitForLoadState("networkidle");
      await dumpPageArtifacts(page, "login_interactive");

      // ログイン完了を自動検知できた場合のみ storage を保存（未ログインで上書きしない）
      const ok = await waitForManualLogin(page, loginWaitMs);
      if (!ok) {
        console.error(
          "ログイン完了を確認できませんでした（timeout）。storage.json は更新せずに終了します。"
        );
        process.exitCode = 1;
        emitChecklist("login", false);
        await browser.close().catch(() => {});
        return;
      }
      await context.storageState({ path: STORAGE_STATE_PATH });
      console.log("StorageStateを保存しました。");

      // トップページに遷移（念のため）
      if (!page.url().includes(homeUrl) || page.url().includes("/login")) {
        await page.goto(homeUrl);
        await page.waitForLoadState("networkidle");
      }
      emitChecklist("login", true);
      // 以降はこの headed セッションで続行
    }

    // ユーザーが手動でログインするのを待つ
    console.log(
      "手動でログインしてください。ログイン完了を自動検知してstorage.jsonを保存します。"
    );

    // ログイン成功後、StorageStateを保存
    const ok = await waitForManualLogin(page, loginWaitMs);
    if (!ok) {
      console.error(
        "ログイン完了を確認できませんでした（timeout）。storage.json は更新せずに終了します。"
      );
      process.exitCode = 1;
      emitChecklist("login", false);
      await browser.close().catch(() => {});
      return;
    }
    await context.storageState({ path: STORAGE_STATE_PATH });
    console.log("StorageStateを保存しました。");

    // トップページに遷移（念のため）
    if (!page.url().includes(homeUrl) || page.url().includes("/login")) {
      await page.goto(homeUrl);
      await page.waitForLoadState("networkidle");
    }
    emitChecklist("login", true);
  } else {
    console.log("ログイン済みです。スキップします。");
    emitChecklist("login", true);
  }

  console.log("Current URL:", page.url());

  // サイドバーのリンク一覧を取得
  let links = [];
  const chineseFindings = [];
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
        chineseFindings.push({ menuText, where: "main_content" });
      }

      // 詳細画面に遷移したらクロールを即時終了
      if (page.url().includes("/project?s=")) {
        console.log(
          "詳細画面に遷移したため、このメニューのクロールをスキップします。"
        );
        await page
          .goto(baseUrl, { waitUntil: "domcontentloaded" })
          .catch(() => {});
        await page.waitForLoadState("networkidle").catch(() => {});
        return;
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

    // === ここからSSL証明書有効期限チェック ===
    const checkedDomains = new Set();
    for (const link of links) {
      if (!link.href) continue;
      let targetUrl = link.href;
      if (targetUrl.startsWith("/")) {
        targetUrl = baseUrl + targetUrl;
      } else if (!targetUrl.startsWith("http")) {
        continue;
      }
      const { hostname } = url.parse(targetUrl);
      if (!hostname || checkedDomains.has(hostname)) continue;
      checkedDomains.add(hostname);
      try {
        const validTo = await checkSSLCertExpiry(targetUrl);
        const expiryDate = new Date(validTo);
        const now = new Date();
        const diffDays = Math.floor((expiryDate - now) / (1000 * 60 * 60 * 24));
        if (diffDays < 0) {
          console.log(
            `【警告】証明書が期限切れです: ${hostname} (有効期限: ${validTo})`
          );
        } else if (diffDays < 30) {
          console.log(
            `【警告】証明書の有効期限が30日未満です: ${hostname} (有効期限: ${validTo})`
          );
        } else {
          console.log(
            `証明書有効期限: ${hostname} → ${validTo}（残り${diffDays}日）`
          );
        }
      } catch (e) {
        console.log(`証明書情報取得失敗: ${hostname} (${e})`);
      }
    }
    // === ここまで ===

    // プロジェクト自動作成処理は必ず実行
    await createProject(page, "CIテスト");
    // プロジェクト詳細画面を開く処理
    if (await openProjectDetail(page, "CIテスト")) {
      // 詳細画面に入れたら、内部操作の自動化を実行
      await automateProjectInternal(page);
    }
  } catch (e) {
    console.log("サイドバーのリンクが取得できませんでした:", e.message);
    await browser.close();
    process.exit(1);
  }

  // 各リンクをクロールしてリンク切れをチェック
  const brokenLinks = [];
  // NOTE: baseUrl は上で定義済み（CLIで変更可能）
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

  // checklist items (stdout only): overall + failures only
  emitChecklist("link_check", brokenLinks.length === 0);
  for (const bl of brokenLinks) {
    emitChecklist(`link_broken.${safeChecklistKey(bl.href)}`, false);
  }
  emitChecklist("chinese_check", chineseFindings.length === 0);
  for (const cf of chineseFindings) {
    emitChecklist(`chinese.${safeChecklistKey(cf.menuText)}`, false);
  }

  // ブラウザを閉じてプロセスを終了
  await browser.close();
  process.exit(0);
})();
