require("dotenv").config();
const { chromium } = require("playwright");
const tls = require("tls");
const url = require("url");

const fs = require("fs");
const path = require("path");

// StorageStateファイルのパス (Cookie + LocalStorage)
const STORAGE_STATE_PATH = path.join(__dirname, "storage.json");

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
      await modalDialog.first().waitFor({ state: "visible", timeout: 10000 }).catch(() => {});

      // モーダルないの「Blank」または「空白」を含む要素を探す
      // 以前は div.panel-body だったが、構造を検索する
      // 具体的には .panel-body の中のテキスト、あるいは .panel 自体
      const blankPanel = modalDialog.locator(
        'div.panel-body:has-text("Blank"), div.panel-body:has-text("空白"), .panel:has-text("Blank"), .panel:has-text("空白")'
      );
      
      // 見つからない場合は、"Blank" というテキストを持つ任意のdivをクリック (Modal内に限定)
      let targetPanel = blankPanel;
      if ((await blankPanel.count()) === 0) {
         targetPanel = modalDialog.locator('div:has-text("Blank"), div:has-text("空白")');
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
            console.log("プロジェクト名入力欄またはモーダルの待機中にタイムアウトしました。");
        }

        if ((await nameInput.count()) > 0) {
          console.log("プロジェクト名入力欄が見つかりました。フォーカスを設定します。");
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
            console.log("完了ボタンが見つかりませんでした。スクリーンショットを保存します。");
            await page.screenshot({ path: 'debug-create-project-no-done-btn.png' });
          }
        } else {
          console.log("プロジェクト名入力欄が見つかりませんでした。スクリーンショットを保存します。");
           await page.screenshot({ path: 'debug-create-project-no-input.png' });
        }
      } else {
        console.log("Blank projectパネルが見つかりませんでした。スクリーンショットを保存します。");
        await page.screenshot({ path: 'debug-create-project-no-blank-panel.png' });
      }
    } else {
      console.log("新しいプロジェクトを作成ボタンが見つかりませんでした。スクリーンショットを保存します。");
      await page.screenshot({ path: 'debug-create-project-no-create-btn.png' });
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
      const uiLink = await rowHandle.asElement().$('a[href*="/programManagement"][title="UI"], a[href*="/programManagement"]');

      if (uiLink) {
          console.log("UI管理画面へのリンクをクリックします。");
          await uiLink.click();
          return true;
      }

      // リンクがない場合 (権限不足や構造違い)
      console.log("UI管理画面へのリンクが見つかりません。");
      
      // バックアップ: 3点リーダ -> 編集 (以前のロジック)
      let moreBtn = await rowHandle.asElement().$('button[aria-label="more"], button[aria-label="More"], .fa-ellipsis-h, .fa-ellipsis-v, .dropdown-toggle');
      if (moreBtn) {
        await moreBtn.click();
        await page.waitForTimeout(500);
        const editBtn = page.locator('.dropdown-menu a:has-text("編集"), .dropdown-menu a:has-text("Edit")').first();
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
        console.log("管理画面への遷移がタイムアウトしました。現在のURL:", page.url());
    }
    
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(3000); 

    // 2. 「ページ/コンポーネント」メニューをクリック
    console.log("「ページ/コンポーネント」メニューを探します...");
    // 2. 「ページ/コンポーネント」メニューをクリック
    console.log("「ページ/コンポーネント」メニューを探します...");
    
    // a.dropdown-toggle を優先して探す
    let pageMenu = page.locator('a.dropdown-toggle').filter({ hasText: /プロジェクト\/ページ\/コンポーネント管理|ページ\/コンポーネント/ }).first();
    
    if ((await pageMenu.count()) === 0) {
        console.log("a.dropdown-toggle が見つかりません。汎用検索します。");
        // テキストが厳密に一致するものを探す
        pageMenu = page.locator('a, span').filter({ hasText: /^プロジェクト\/ページ\/コンポーネント管理$/ }).first();
    }
    
    if ((await pageMenu.count()) > 0) {
        console.log("メニュー要素をクリックします。: " + (await pageMenu.textContent()).trim());
        
        // 親の li 要素を取得
        const liElement = pageMenu.locator('..');
        
        await pageMenu.click({ force: true });
        
        // この li 内の ul.dropdown-menu が visible になるのを待つ
        // 複数の ul がある可能性があるため、"ページの追加" を含むものをターゲットにする
        const specificDropdown = liElement.locator('ul.dropdown-menu').filter({ hasText: "ページの追加" }).first();
        
        try {
            await specificDropdown.waitFor({ state: "visible", timeout: 3000 });
            console.log("対象のドロップダウンが表示されました。");
            
            // ドロップダウンの中身をログ出力 (デバッグ用)
            const html = await specificDropdown.innerHTML();
            console.log("Dropdown Content: " + html);
            
        } catch (e) {
            console.log("ドロップダウンの表示待機でタイムアウトしました。再試行します。");
            await pageMenu.click({ force: true });
            await specificDropdown.waitFor({ state: "visible", timeout: 3000 });
        }

        // 3. ドロップダウン内の「ページの追加」をクリック
        // 3. ドロップダウン内の「ページの追加」をクリック
        // Extract Project ID before clicking (from current URL)
        const currentUrl = page.url();
        console.log(`Current URL before page creation: ${currentUrl}`);
        let projectId = '';
        try {
            const urlObj = new URL(currentUrl);
            const sParam = urlObj.searchParams.get('s');
            if (sParam) {
                const decodedS = Buffer.from(sParam, 'base64').toString('utf8');
                console.log(`Decoded S param: ${decodedS}`);
                const params = new URLSearchParams(decodedS);
                projectId = params.get('pid') || params.get('oid'); 
                console.log(`Extracted Project ID: ${projectId}`);
            }
        } catch (e) {
            console.error("Error parsing Project ID:", e);
        }

        const addPageBtn = specificDropdown.locator('a:has-text("ページの追加")').first();
        if ((await addPageBtn.count()) > 0) {
            console.log("「ページの追加」をクリックします。");
            await addPageBtn.evaluate(el => el.click());
            console.log("クリックコマンドを送信しました。");
            await page.waitForTimeout(3000); 

            // Dump HTML to check keys
            const designerHtml = await page.content();
            const fs = require('fs');
            fs.writeFileSync('designer_dump.html', designerHtml);
            console.log("designer_dump.html を保存しました。");

            // Check if we are already in the designer (EditProjectSelf)
            const currentUrlAfterCreate = page.url();
            if (currentUrlAfterCreate.includes("EditProjectSelf") || currentUrlAfterCreate.includes("designer")) {
                console.log(`ページ作成後、自動的にデザイナーに遷移しました: ${currentUrlAfterCreate}`);
                 const finalHtml = await page.content();
                 fs.writeFileSync('designer_final_dump.html', finalHtml);
                 
                 // --- Drag and Drop Implementation ---
                 console.log("Starting Drag and Drop of Label component (Auto-Redirect)...");
                 await performDragAndDrop(page, "ラベル");
                 
                 console.log("Waiting for component to appear on canvas...");
                 await page.waitForTimeout(5000); // 5秒待機
                 
                 // Edit the Label Text directly on Canvas (contenteditable)
                 console.log("Setting Label text to 'Hello world' via canvas element...");
                 
                 // Target the contenteditable element.
                 // We search globally since #rendererContent might have multiple layers
                 const editableLabel = page.locator('.nt-editable').first();
                 
                 try {
                     // Attached状態（DOMに存在）を待つ
                     await editableLabel.waitFor({ state: 'attached', timeout: 10000 });
                     console.log("Found editable label (attached).");
                     
                     // Force update via evaluate
                     await editableLabel.evaluate(el => {
                         el.innerText = "Hello world";
                         el.dispatchEvent(new Event('input', { bubbles: true }));
                         el.dispatchEvent(new Event('change', { bubbles: true }));
                         el.dispatchEvent(new Event('blur', { bubbles: true }));
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
                const nodes = Array.from(document.querySelectorAll('div[data-node-id]'));
                return nodes.map(el => el.getAttribute('data-node-id')).filter(id => id && id.length > 10); // Simple filter
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
                        await page.locator(rowSelector).scrollIntoViewIfNeeded().catch(e => console.log("Scroll failed:", e));
                    }

                    try {
                        // Hover to reveal the menu
                        console.log(`Hovering over ${rowSelector}...`);
                        await page.hover(rowSelector, { timeout: 2000 }); // Short timeout
                        await page.waitForTimeout(500); // Wait for transition
                    } catch (e) {
                         console.log("Hover failed (continuing to click anyway):", e.message);
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
                    const menuItems = await page.$$eval('.n-dropdown-option, .dropdown-menu li', items => items.map(i => i.innerText.trim()));
                    console.log("Dropdown items found:", menuItems);

                    // Try to click "開く" (Open) or "編集" (Edit) or "UI"
                    const clicked = await page.evaluate(() => {
                        // NDropDown often renders options in a popper/body layer.
                        const items = Array.from(document.querySelectorAll('.n-dropdown-option, .dropdown-menu li, .dropdown-item'));
                        // Filter for visible items if possible, but for now just text match
                        const target = items.find(i => 
                            i.innerText.includes('編集') || 
                            i.innerText.includes('開く') || 
                            i.innerText.includes('UI') ||
                            i.innerText.includes('Edit') ||
                            i.innerText.includes('Open')
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
                    await page.waitForFunction(() => document.querySelector('#nt-ui-canvas') || document.querySelector('.newtypeDesigner'), { timeout: 20000 });
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
                fs.writeFileSync('designer_final_dump.html', finalHtml);
                console.log("Saved designer_final_dump.html");

                // --- Drag and Drop Implementation ---
                console.log("Starting Drag and Drop of Input component...");
                await performDragAndDrop(page, "Input");
                // ------------------------------------
            }
            
            await page.screenshot({ path: 'debug-designer-entry.png' });
            
        } else {
            console.log("「ページの追加」メニューが見つかりませんでした。");
            await page.screenshot({ path: 'debug-add-page-not-found.png' });
        }
    } else {
        console.log("「ページ/コンポーネント」メニューが見つかりませんでした。");
          await page.screenshot({ path: 'debug-page-menu-not-found.png' });
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
            console.log(`WaitForSelector failed for ${componentName}. Trying to find if any exist...`);
        }

        const source = page.locator(sourceSelector).first();

        // Check availability
        if ((await source.count()) === 0) {
            console.error(`Visible Component "${componentName}" not found in sidebar.`);
            
            // Debug: check if hidden ones exist
            const anySource = page.locator(`.componentItem:has-text("${componentName}")`);
            const count = await anySource.count();
            if (count > 0) {
                 console.log(`Found ${count} hidden elements matching "${componentName}". Trying to expand sidebar...`);
                 
                 // Try to click toggle bar (left side)
                 // Based on dump: left sider has static-positioned or we pick the first toggle bar
                 const toggler = page.locator('.n-layout-sider--static-positioned .n-layout-toggle-bar').first();
                 if (await toggler.isVisible()) {
                      console.log("Clicking toggle bar...");
                      await toggler.click();
                      await page.waitForTimeout(1000);
                      // Retry finding source
                      if (await source.count() > 0) {
                           console.log("Component became visible!");
                      }
                 }
            }
            return;
        }

        console.log(`Visible component "${componentName}" found.`);

        // Target: Central Canvas
        const targetSelector = '#rendererContent';
        await page.waitForSelector(targetSelector, { timeout: 5000 });
        const target = page.locator(targetSelector).first();

        const sourceBox = await source.boundingBox();
        const targetBox = await target.boundingBox();

        if (sourceBox && targetBox) {
            console.log(`Dragging from (${sourceBox.x}, ${sourceBox.y}) to (${targetBox.x + 100}, ${targetBox.y + 100})`);
            
            // Manual Mouse Drag
            await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2);
            await page.mouse.down();
            await page.waitForTimeout(200);
            
            // Drag moves
            await page.mouse.move(targetBox.x + 100, targetBox.y + 100, { steps: 20 }); 
            await page.waitForTimeout(200);
            
            await page.mouse.up();
            console.log("Drop action completed.");
            
            await page.waitForTimeout(3000); // Wait for UI update

            // Verify
            const canvasContent = await target.innerHTML();
            // Check for both user-visible text or internal classes
            if (canvasContent.includes('n-input') || canvasContent.includes('input') || canvasContent.includes('入力')) {
                 console.log("Verification Success: Component detected in canvas.");
            } else {
                 console.log("Verification Warning: Could not explicitly confirm component in canvas.");
                 console.log("Canvas content snippet: " + canvasContent.substring(0, 200));
            }
        } else {
            console.error("Bounding box missing for drag operation.");
        }
        
        await page.screenshot({ path: 'debug-after-success-dnd.png' });

    } catch (e) {
        console.error("Error during Drag and Drop:", e);
        await page.screenshot({ path: 'debug-dnd-error.png' });
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
async function editComponentProperty(page, propertyLabel, value) {
    try {
        // There might be multiple sidebars sharing this class. 
        // The one with properties is usually the last one or can be identified by content.
        // Based on logs, the first one is component list.
        const sidebar = page.locator('aside.n-layout-sider--right-placement').last();
        await sidebar.waitFor({ state: 'visible', timeout: 5000 });
        
        // Try to find the specific label
        // Debug: Print all available labels
        const allLabels = await sidebar.locator('.title label').allInnerTexts();
        console.log("DEBUG: Available Properties in Sidebar:", allLabels);

        let label = sidebar.locator(`.title label:has-text("${propertyLabel}")`).first();
        
        if (await label.count() === 0) {
            console.log(`Property label "${propertyLabel}" not found. Listing available properties...`);
            const allLabels = await sidebar.locator('.title label').allInnerTexts();
            console.log("Available Properties:", allLabels);
            
             if (propertyLabel === "テキスト") {
                 console.log("Trying to find 'Text' or 'Value' or similar...");
                 const fallbacks = ["Text", "Value", "内容", "表示テキスト", "ツールチップのテキスト"];
                 for (const fb of fallbacks) {
                     label = sidebar.locator(`.title label:has-text("${fb}")`).first();
                     if (await label.count() > 0) {
                         console.log(`Found fallback property: ${fb}`);
                         break;
                     }
                 }
                 
                 // If still not found, defaulting to the VERY FIRST input in the sidebar
                 if (await label.count() === 0) {
                      console.log("No matching property label found. Attempting to target the first text input.");
                      const firstInput = sidebar.locator('input[type="text"]').first();
                      if (await firstInput.count() > 0) {
                          console.log("Found an input. Filling it...");
                          await firstInput.click();
                          await firstInput.fill(value);
                          await firstInput.press('Enter');
                          return;
                      }
                 }
             }
        }

        if (await label.count() > 0) {
            // Traverse to input
            const titleDiv = label.locator('xpath=..');
            
            // Try explicit hierarchy from dump:
            // The input structure in dump: 
            // <div class="title"><label>...</label></div>
            // <div class="n-input ..."> ... <input ...> </div>
            // OR the input is further down.
            
            // We'll search for the first input that appears AFTER this title div, in the same container.
            // Using Playwright locator chaining with xpath is robust.
            
            // Strategy: Find the closest input following the title div
            const inputField = page.locator('input').filter({ has: page.locator(`xpath=preceding::label[contains(text(), "${await label.innerText()}")]`) }).first();
            
            // Check if that actually worked (Playwright sometimes struggles with reversed axis in filter)
            // Let's use simple execution context if locator fails
            const nextInput = titleDiv.locator('xpath=following::input[1]');
            
            if (await nextInput.count() > 0) {
                console.log(`Found input for "${propertyLabel}". Filling with "${value}"...`);
                // Try clicking the parent wrapper first, as the input itself might be hidden/overlayed
                const wrapper = nextInput.locator('xpath=..');
                if (await wrapper.isVisible()) {
                    await wrapper.click({ force: true });
                } else {
                    // Try forcing click on input
                     await nextInput.click({ force: true }).catch(e => console.log("Force click failed:", e.message));
                }

                // Use JS to set value directly to bypass visibility checks
                await nextInput.evaluate((el, val) => {
                    el.value = val;
                    el.dispatchEvent(new Event('input', { bubbles: true }));
                    el.dispatchEvent(new Event('change', { bubbles: true }));
                    el.dispatchEvent(new Event('blur', { bubbles: true }));
                }, value);
                
                await page.waitForTimeout(500);
            } else {
                console.error(`Input field for "${propertyLabel}" not found.`);
            }
        }
        
        await page.waitForTimeout(1000); 

    } catch (e) {
        console.error(`Error editing property "${propertyLabel}":`, e);
    }
}

(async () => {
  const browser = await chromium.launch({ headless: false });
  
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
  const context = await browser.newContext(contextOptions);

  const page = await context.newPage();

  // ログイン状態確認（トップページにアクセスしてみる）
  await page.goto("https://dev.ntmatrix.app/");
  await page.waitForLoadState("networkidle");

  // ログインページにリダイレクトされたか、ログインが必要な要素があるかで判断
  const isLoginPage = page.url().includes("/login");
  
  if (isLoginPage) {
    console.log("ログインが必要です。手動でログインしてください。");
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

    // ログイン成功後、StorageStateを保存
    await context.storageState({ path: STORAGE_STATE_PATH });
    console.log("StorageStateを保存しました。");
    
    // トップページに遷移（念のため）
    if (!page.url().includes("https://dev.ntmatrix.app/") || page.url().includes("/login")) {
        await page.goto("https://dev.ntmatrix.app/");
        await page.waitForLoadState("networkidle");
    }
  } else {
      console.log("ログイン済みです。スキップします。");
  }

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

    // === ここからSSL証明書有効期限チェック ===
    const checkedDomains = new Set();
    for (const link of links) {
      if (!link.href) continue;
      let targetUrl = link.href;
      if (targetUrl.startsWith("/")) {
        targetUrl = "https://dev.ntmatrix.app" + targetUrl;
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
