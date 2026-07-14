// Costco Order History Scraper
// Extracts itemized receipts from Costco.com order history
// Handles both Online and Warehouse tabs, opens receipt dialogs for warehouse purchases

(async function () {
    'use strict';

    const CostcoScraper = {
        async init() {
            console.log('[Costco Scraper] Initializing on', window.location.href);

            // Check if we're in scraping mode
            const { scrapingMode } = await chrome.storage.local.get('scrapingMode');
            const storeData = scrapingMode?.stores?.costco || (scrapingMode?.store === 'costco' ? scrapingMode : null);
            const isScrapingMode = storeData?.active;
            const isStale = storeData?.timestamp && (Date.now() - storeData.timestamp > 5 * 60 * 1000);

            if (!isScrapingMode || isStale) {
                console.log('[Costco Scraper] Not in scraping mode, skipping auto-scrape');
                if (isStale) {
                    await chrome.storage.local.remove('scrapingMode');
                }
                return;
            }

            console.log('[Costco Scraper] Scraping mode active, proceeding...');
            this.addScraperUI();
            await this.scrapeAllTabs();
        },

        addScraperUI() {
            if (document.getElementById('edb-costco-banner')) return;

            const banner = document.createElement('div');
            banner.id = 'edb-costco-banner';
            banner.innerHTML = `
                <div style="
                    position: fixed;
                    top: 0;
                    left: 0;
                    right: 0;
                    background: linear-gradient(135deg, #005DAA, #0073CF);
                    color: white;
                    padding: 10px 20px;
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    z-index: 999999;
                    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                    box-shadow: 0 2px 8px rgba(0,0,0,0.2);
                ">
                    <span style="font-weight: 500;">📊 EveryDollar Auto-Budget - Scanning Costco orders...</span>
                    <button id="edb-costco-stop" style="
                        background: rgba(255,255,255,0.2);
                        color: white;
                        border: none;
                        padding: 8px 16px;
                        border-radius: 4px;
                        cursor: pointer;
                    ">Stop</button>
                </div>
            `;
            document.body.prepend(banner);
            document.body.style.marginTop = '50px';

            document.getElementById('edb-costco-stop')?.addEventListener('click', () => {
                this.stopped = true;
                this.updateBanner('Stopped.');
                setTimeout(() => {
                    chrome.runtime.sendMessage({ action: 'scrapeComplete', store: 'costco' });
                }, 1000);
            });
        },

        updateBanner(message) {
            const span = document.querySelector('#edb-costco-banner div span');
            if (span) {
                span.textContent = `📊 ${message}`;
            }
        },

        stopped: false,

        // Get the active tab panel using aria-controls from the selected tab
        getActiveTabPanel() {
            const selectedTab = document.querySelector('main [role="tab"][aria-selected="true"]');
            if (selectedTab) {
                const panelId = selectedTab.getAttribute('aria-controls');
                if (panelId) {
                    const panel = document.getElementById(panelId);
                    if (panel) return panel;
                }
            }
            // Fallback: find first visible tabpanel inside main
            const panels = document.querySelectorAll('main [role="tabpanel"]');
            for (const p of panels) {
                if (!p.hidden && getComputedStyle(p).display !== 'none') return p;
            }
            return null;
        },

        // Wait for an element to appear
        async waitForElement(selector, maxWait = 10000) {
            const start = Date.now();
            while (Date.now() - start < maxWait) {
                const el = document.querySelector(selector);
                if (el) return el;
                await new Promise(r => setTimeout(r, 300));
            }
            return null;
        },

        // Wait for elements matching selector
        async waitForElements(selector, maxWait = 10000) {
            const start = Date.now();
            while (Date.now() - start < maxWait) {
                const els = document.querySelectorAll(selector);
                if (els.length > 0) return els;
                await new Promise(r => setTimeout(r, 300));
            }
            return [];
        },

        // Click a tab by name, re-querying the DOM to avoid stale references
        async clickTab(tabName) {
            const tablist = document.querySelector('main [role="tablist"]');
            if (!tablist) return false;

            const tabs = tablist.querySelectorAll('[role="tab"]');
            for (const tab of tabs) {
                if (tab.textContent?.trim().toLowerCase().includes(tabName.toLowerCase())) {
                    console.log(`[Costco Scraper] Clicking "${tabName}" tab`);
                    tab.click();
                    // Wait for the tab panel to update
                    await new Promise(r => setTimeout(r, 2000));
                    return true;
                }
            }
            console.log(`[Costco Scraper] Tab "${tabName}" not found`);
            return false;
        },

        // Change the date range dropdown to show more history
        async expandDateRange() {
            // Wait for the dropdown to appear in the active tab panel
            let select = null;
            for (let i = 0; i < 10; i++) {
                const tabPanel = this.getActiveTabPanel();
                if (tabPanel) {
                    select = tabPanel.querySelector('select, [role="combobox"]');
                    if (select) break;
                }
                await new Promise(r => setTimeout(r, 500));
            }

            if (!select) {
                console.log('[Costco Scraper] No date range dropdown found after waiting');
                return;
            }

            console.log('[Costco Scraper] Found date range dropdown, current value:', select.value);

            // Get all options
            const options = select.querySelectorAll('option');
            const optionTexts = [...options].map(o => o.textContent?.trim());
            console.log(`[Costco Scraper] Date range options: ${optionTexts.join(', ')}`);

            // "Last 3 Months" covers ~90 days which is sufficient for most use cases
            const currentText = select.options?.[select.selectedIndex]?.textContent?.trim() || '';
            console.log(`[Costco Scraper] Current date range: "${currentText}"`);
        },

        // =====================================
        // MAIN: Scrape both Online and Warehouse tabs
        // =====================================
        async scrapeAllTabs() {
            const allOrders = [];

            // Wait for the tablist to actually render (Costco is a React SPA)
            this.updateBanner('Waiting for page to load...');
            console.log('[Costco Scraper] Waiting for tablist to render...');
            const tablist = await this.waitForElement('main [role="tablist"]', 15000);

            if (!tablist) {
                console.log('[Costco Scraper] No tablist found after waiting, trying direct scrape...');
                const orders = await this.scrapeCurrentView();
                allOrders.push(...orders);
            } else {
                // Get tab names from the tablist
                const tabs = tablist.querySelectorAll('[role="tab"]');
                const tabNames = [...tabs].map(t => t.textContent?.trim() || '');
                console.log(`[Costco Scraper] Found ${tabs.length} tabs: ${tabNames.join(', ')}`);

                // Process Warehouse FIRST (most important - has itemized receipts)
                if (tabNames.some(n => n.toLowerCase().includes('warehouse'))) {
                    if (!this.stopped) {
                        this.updateBanner('Switching to Warehouse tab...');
                        const clicked = await this.clickTab('warehouse');
                        if (clicked) {
                            // Wait for warehouse content to load
                            await new Promise(r => setTimeout(r, 2000));
                            await this.expandDateRange();
                            const orders = await this.scrapeWarehouseTab();
                            allOrders.push(...orders);
                        }
                    }
                }

                // Then process Online tab
                if (tabNames.some(n => n.toLowerCase().includes('online'))) {
                    if (!this.stopped) {
                        this.updateBanner('Switching to Online tab...');
                        const clicked = await this.clickTab('online');
                        if (clicked) {
                            await new Promise(r => setTimeout(r, 2000));
                            await this.expandDateRange();
                            const orders = await this.scrapeOnlineTab();
                            allOrders.push(...orders);
                        }
                    }
                }
            }

            // Save all orders
            for (const order of allOrders) {
                await window.StorageManager.addStoreReceipt(order);
                chrome.runtime.sendMessage({
                    action: 'receiptScraped',
                    store: 'costco',
                    order: order.orderId
                });
            }

            // Notify completion
            const totalItems = allOrders.reduce((sum, o) => sum + o.items.length, 0);
            this.updateBanner(`Scraped ${allOrders.length} Costco orders with ${totalItems} items! Returning to EveryDollar...`);

            chrome.runtime.sendMessage({
                action: 'receiptsScraped',
                store: 'costco',
                count: allOrders.length
            });

            setTimeout(() => {
                chrome.runtime.sendMessage({ action: 'scrapeComplete', store: 'costco' });
            }, 2000);
        },

        // =====================================
        // WAREHOUSE TAB: Click "View Receipt" for each receipt
        // =====================================
        async scrapeWarehouseTab() {
            console.log('[Costco Scraper] Scraping Warehouse tab...');
            const orders = [];

            // Wait for warehouse-specific content to load
            // The warehouse tab shows "View Receipt" buttons or "receipts will appear" text
            this.updateBanner('Loading warehouse receipts...');
            let attempts = 0;
            let viewButtons = [];
            let warehouseContentLoaded = false;
            while (attempts < 15) {
                viewButtons = this.findViewReceiptButtons();
                if (viewButtons.length > 0) {
                    console.log(`[Costco Scraper] Found ${viewButtons.length} View Receipt buttons on attempt ${attempts + 1}`);
                    break;
                }

                // Check for warehouse-specific content to know tab has loaded
                const tabPanel = this.getActiveTabPanel();
                const panelText = tabPanel?.textContent || '';

                // "receipts will appear" is warehouse-specific text
                if (panelText.includes('receipts will appear')) {
                    warehouseContentLoaded = true;
                    console.log('[Costco Scraper] Warehouse content loaded, checking for receipts...');
                }

                // Only check for "no receipts" if warehouse content has actually loaded
                // This avoids false-matching "No orders available" from the Online tab during transition
                if (warehouseContentLoaded && viewButtons.length === 0) {
                    // Warehouse is loaded but no View Receipt buttons - give a few more seconds
                    if (attempts > 5) {
                        console.log('[Costco Scraper] Warehouse loaded but no View Receipt buttons found');
                        return orders;
                    }
                }

                await new Promise(r => setTimeout(r, 1000));
                attempts++;
            }

            console.log(`[Costco Scraper] Found ${viewButtons.length} View Receipt buttons`);

            if (viewButtons.length === 0) {
                console.log('[Costco Scraper] No warehouse receipts found after waiting');
                return orders;
            }

            // Get receipt card info (date, total, location) without date filtering
            // The dropdown date range already controls the scope
            const receiptCards = this.getReceiptCards(viewButtons);
            console.log(`[Costco Scraper] Found ${receiptCards.length} receipt cards to process`);

            for (let i = 0; i < receiptCards.length; i++) {
                if (this.stopped) break;

                const card = receiptCards[i];
                this.updateBanner(`Scraping warehouse receipt ${i + 1} of ${receiptCards.length}...`);
                console.log(`[Costco Scraper] Opening receipt ${i + 1}: date=${card.dateStr}, total=$${card.total}`);

                try {
                    // Click the View Receipt button
                    card.button.click();

                    // Wait for the receipt dialog with a table to appear
                    let dialogReady = false;
                    for (let w = 0; w < 20; w++) {
                        await new Promise(r => setTimeout(r, 500));
                        const dialogs = document.querySelectorAll('[role="dialog"]');
                        for (const d of dialogs) {
                            if (d.querySelector('table')) {
                                dialogReady = true;
                                break;
                            }
                        }
                        if (dialogReady) break;
                    }
                    if (!dialogReady) {
                        console.log('[Costco Scraper] Timed out waiting for receipt table in dialog');
                    }

                    // Parse the receipt dialog
                    const order = await this.parseReceiptDialog(card);

                    if (order && order.items.length > 0) {
                        orders.push(order);
                        console.log(`[Costco Scraper] Parsed warehouse receipt: ${order.orderId} with ${order.items.length} items, $${order.total}`);
                    }

                    // Close the dialog
                    await this.closeDialog();
                    await new Promise(r => setTimeout(r, 500));

                } catch (e) {
                    console.error(`[Costco Scraper] Error processing receipt ${i + 1}:`, e);
                    // Try to close any open dialog
                    await this.closeDialog();
                    await new Promise(r => setTimeout(r, 500));
                }
            }

            return orders;
        },

        // Find all "View Receipt" buttons on the page
        findViewReceiptButtons() {
            // Only look within the active tab panel to avoid finding buttons from other tabs
            const tabPanel = this.getActiveTabPanel();
            const container = tabPanel || document;
            const allButtons = container.querySelectorAll('button');
            return Array.from(allButtons).filter(btn => {
                const text = btn.textContent?.trim().toLowerCase() || '';
                return text.includes('view receipt');
            });
        },

        // Extract receipt card info (date, total, location) from the card containing each button
        getReceiptCards(viewButtons) {
            const cards = [];

            for (const button of viewButtons) {
                // Walk up to find the card container
                let container = button.closest('[class*="card"], [class*="Card"], [class*="receipt"], [class*="Receipt"], li, article, section');
                if (!container) {
                    // Try walking up a few levels
                    container = button.parentElement?.parentElement?.parentElement || button.parentElement;
                }

                const text = container?.textContent || '';

                // Extract date - formats like "01/05/2026 - 02:46pm" or "01/05/2026"
                let date = null;
                const dateMatch = text.match(/(\d{1,2}\/\d{1,2}\/\d{4})/);
                if (dateMatch) {
                    try {
                        date = new Date(dateMatch[1]);
                    } catch { }
                }

                // Extract total from card text
                let total = 0;
                const totalMatch = text.match(/\$(\d+(?:\.\d{2})?)/);
                if (totalMatch) {
                    total = parseFloat(totalMatch[1]);
                }

                // Extract location
                const locationMatch = text.match(/(?:ANCHORAGE|[A-Z]{2,}(?:\s+#?\d+)?)/);

                cards.push({
                    button: button,
                    date: date,
                    dateStr: dateMatch ? dateMatch[1] : null,
                    total: total,
                    location: locationMatch ? locationMatch[0] : null,
                    container: container
                });
            }

            console.log(`[Costco Scraper] Receipt cards:`, cards.map(c => `${c.dateStr} $${c.total} @ ${c.location}`));
            return cards;
        },

        // Parse an open receipt dialog
        async parseReceiptDialog(cardInfo) {
            // Look for the dialog/modal - Costco has multiple [role="dialog"] divs,
            // the first is an empty overlay. Find the one that has receipt content.
            const allDialogs = document.querySelectorAll('[role="dialog"], dialog');
            let dialog = null;
            for (const d of allDialogs) {
                // The receipt dialog contains "In-Warehouse Receipt" or has a table
                if (d.querySelector('table') || d.textContent?.includes('In-Warehouse Receipt')) {
                    dialog = d;
                    break;
                }
            }
            if (!dialog) {
                console.log('[Costco Scraper] No receipt dialog found after clicking View Receipt');
                return null;
            }

            console.log('[Costco Scraper] Found receipt dialog, parsing...');

            const items = [];
            const dialogText = dialog.textContent || '';

            // Find the receipt table
            const tables = dialog.querySelectorAll('table');
            console.log(`[Costco Scraper] Found ${tables.length} tables in dialog`);

            for (const table of tables) {
                const rows = table.querySelectorAll('tr');
                console.log(`[Costco Scraper] Table has ${rows.length} rows`);

                for (const row of rows) {
                    const cells = row.querySelectorAll('td, th');
                    if (cells.length < 3) continue;

                    // Get cell texts
                    const cellTexts = Array.from(cells).map(c => c.textContent?.trim() || '');

                    // Skip summary/header rows
                    const rowText = cellTexts.join(' ').toUpperCase();
                    if (/SUBTOTAL|^TAX\b|TOTAL|ITEM\s*COUNT|CHANGE|VISA|MASTERCARD|DEBIT|EBT|COUPON|INSTANT SAVINGS/i.test(rowText)) {
                        continue;
                    }

                    // Warehouse receipt format: flag | item# | item name | price+tax_flag
                    // The item name cell usually has "ITEM NAME PRICE TAX_FLAG" all in one cell,
                    // OR they can be in separate cells
                    // Common patterns observed:
                    //   Cell 0: "" or flag
                    //   Cell 1: item number (6+ digits)
                    //   Cell 2: "ITEM NAME" or "ITEM NAME PRICE TAX_FLAG"
                    //   Cell 3: "PRICE TAX_FLAG" (if separate)

                    let itemName = '';
                    let price = 0;
                    let itemNum = '';

                    // Try to identify item number cell (all digits, 4+ chars)
                    const itemNumIndex = cellTexts.findIndex(t => /^\d{4,}$/.test(t));
                    if (itemNumIndex >= 0) {
                        itemNum = cellTexts[itemNumIndex];

                        // The next cell(s) should have the item name and price
                        const remaining = cellTexts.slice(itemNumIndex + 1).join(' ').trim();

                        // Parse "ITEM NAME 15.99 N" or "ITEM NAME 15.99"
                        const priceMatch = remaining.match(/^(.+?)\s+(\d+\.\d{2})\s*([A-Z])?$/);
                        if (priceMatch) {
                            itemName = priceMatch[1].trim();
                            price = parseFloat(priceMatch[2]);
                        } else {
                            // Maybe price is in a separate cell
                            // Look for price in remaining cells after item number
                            for (let ci = itemNumIndex + 1; ci < cellTexts.length; ci++) {
                                const pMatch = cellTexts[ci].match(/^(\d+\.\d{2})\s*([A-Z])?$/);
                                if (pMatch) {
                                    price = parseFloat(pMatch[1]);
                                } else if (cellTexts[ci].length > 2 && !/^[A-Z]$/.test(cellTexts[ci])) {
                                    // This is likely the item name
                                    if (!itemName) itemName = cellTexts[ci];
                                }
                            }
                        }
                    } else {
                        // No clear item number - try parsing the whole row
                        const fullRow = cellTexts.join(' ').trim();
                        const priceMatch = fullRow.match(/^(.+?)\s+(\d+\.\d{2})\s*([A-Z])?$/);
                        if (priceMatch && priceMatch[1].length > 2) {
                            itemName = priceMatch[1].trim();
                            price = parseFloat(priceMatch[2]);
                        }
                    }

                    // Clean up item name
                    itemName = itemName.replace(/\s+/g, ' ').trim();

                    // Skip empty, too short, or non-product rows
                    if (!itemName || itemName.length < 3) continue;
                    if (/^[A-Z]$/.test(itemName)) continue; // Single letter (tax flag)
                    if (/SUBTOTAL|TAX|TOTAL|ITEM COUNT/i.test(itemName)) continue;

                    const category = this.detectCategory(itemName);
                    items.push({
                        name: this.formatItemName(itemName),
                        price: price,
                        quantity: 1,
                        category: category,
                        itemNumber: itemNum || null
                    });

                    console.log(`[Costco Scraper] Item: "${itemName}" $${price} (#${itemNum})`);
                }
            }

            // If no table found, try parsing dialog text directly
            if (items.length === 0) {
                console.log('[Costco Scraper] No items from tables, trying text parsing...');
                const textItems = this.parseReceiptText(dialogText);
                items.push(...textItems);
            }

            // Extract total from dialog
            let total = cardInfo.total || 0;
            const totalMatch = dialogText.match(/(?:^|\s)Total\s*\$?(\d+\.\d{2})/im);
            if (totalMatch) {
                total = parseFloat(totalMatch[1]);
            }

            // Extract date from dialog or card
            let orderDate = new Date().toISOString();
            if (cardInfo.date) {
                orderDate = cardInfo.date.toISOString();
            } else {
                // Try to extract date from dialog text
                const dateMatch = dialogText.match(/(\d{1,2}\/\d{1,2}\/\d{4})/);
                if (dateMatch) {
                    try {
                        orderDate = new Date(dateMatch[1]).toISOString();
                    } catch { }
                }
            }

            // Extract barcode/receipt ID for orderId
            let orderId = `costco-wh-${Date.now()}`;
            // Look for barcode number (long digit string, typically 20+ digits)
            const barcodeMatch = dialogText.match(/(\d{15,})/);
            if (barcodeMatch) {
                orderId = `costco-wh-${barcodeMatch[1]}`;
            } else if (cardInfo.dateStr) {
                // Use date + total as fallback ID
                orderId = `costco-wh-${cardInfo.dateStr.replace(/\//g, '')}-${total}`;
            }

            // Extract store location
            let storeLoc = '';
            const storeMatch = dialogText.match(/(?:ANCHORAGE|COSTCO)\s*(?:#?\d+)?/i);
            if (storeMatch) {
                storeLoc = storeMatch[0];
            }

            return {
                store: 'costco',
                orderId: orderId,
                date: orderDate,
                total: total,
                items: items,
                url: window.location.href,
                storeLocation: storeLoc || null
            };
        },

        // Parse receipt items from plain text (fallback)
        parseReceiptText(text) {
            const items = [];
            const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);

            for (const line of lines) {
                // Match lines like "ITEM NAME 15.99 N" or "ITEM NAME 15.99"
                const match = line.match(/^([A-Z][A-Z\s&'-]+?)\s+(\d+\.\d{2})\s*([A-Z])?$/);
                if (match) {
                    const name = match[1].trim();
                    const price = parseFloat(match[2]);

                    // Skip summary lines
                    if (/SUBTOTAL|TAX|TOTAL|ITEM COUNT|CHANGE|VISA|MASTERCARD|DEBIT|COUPON/i.test(name)) continue;
                    if (name.length < 3) continue;

                    items.push({
                        name: this.formatItemName(name),
                        price: price,
                        quantity: 1,
                        category: this.detectCategory(name)
                    });
                }
            }

            return items;
        },

        // Close the currently open dialog
        async closeDialog() {
            // Find the receipt dialog (the one with actual content, not the overlay)
            const allDialogs = document.querySelectorAll('[role="dialog"]');
            let receiptDialog = null;
            for (const d of allDialogs) {
                if (d.querySelector('table') || d.textContent?.includes('In-Warehouse Receipt')) {
                    receiptDialog = d;
                    break;
                }
            }

            if (receiptDialog) {
                // Try Close button within receipt dialog
                const closeBtn = receiptDialog.querySelector(
                    'button[aria-label*="close" i], button[aria-label*="Close"]'
                );
                if (closeBtn) {
                    closeBtn.click();
                    await new Promise(r => setTimeout(r, 500));
                    return;
                }

                // Try button with text "Close"
                const buttons = receiptDialog.querySelectorAll('button');
                for (const btn of buttons) {
                    if (btn.textContent?.trim() === 'Close') {
                        btn.click();
                        await new Promise(r => setTimeout(r, 500));
                        return;
                    }
                }
            }

            // Fallback: look for any close button in any dialog
            const closeBtn = document.querySelector(
                '[role="dialog"] button[aria-label*="close" i]'
            );
            if (closeBtn) {
                closeBtn.click();
                await new Promise(r => setTimeout(r, 500));
                return;
            }

            // 3. Press Escape
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
            await new Promise(r => setTimeout(r, 300));

            // 4. Click overlay/backdrop
            const overlay = document.querySelector('[class*="overlay"], [class*="backdrop"], [class*="Overlay"], [class*="Backdrop"]');
            if (overlay) {
                overlay.click();
                await new Promise(r => setTimeout(r, 300));
            }
        },

        // =====================================
        // ONLINE TAB: Parse online order cards
        // =====================================
        async scrapeOnlineTab() {
            console.log('[Costco Scraper] Scraping Online tab...');
            const orders = [];

            await new Promise(r => setTimeout(r, 1500));

            // Check the active tab panel for "no orders" — NOT document.body
            const tabPanel = this.getActiveTabPanel();
            const panelText = tabPanel?.textContent || '';
            if (/no orders are available|no orders found/i.test(panelText)) {
                console.log('[Costco Scraper] No online orders in current date range');
                return orders;
            }

            // Look for order containers - Costco online orders may have different structure
            const searchRoot = tabPanel || document.querySelector('main') || document;
            const orderContainers = searchRoot.querySelectorAll(
                '[class*="order-card"], [class*="OrderCard"], [class*="order-summary"], ' +
                '[data-testid*="order"], [class*="orderGroup"]'
            );

            console.log(`[Costco Scraper] Found ${orderContainers.length} online order containers`);

            for (const container of orderContainers) {
                if (this.stopped) break;
                try {
                    const order = this.parseOnlineOrderContainer(container);
                    if (order && order.items.length > 0) {
                        orders.push(order);
                        console.log(`[Costco Scraper] Online order: ${order.orderId} with ${order.items.length} items, $${order.total}`);
                    }
                } catch (e) {
                    console.error('[Costco Scraper] Error parsing online order:', e);
                }
            }

            return orders;
        },

        // Parse an online order container
        parseOnlineOrderContainer(container) {
            const text = container.textContent || '';
            const items = [];

            // Extract order number
            const orderIdMatch = text.match(/order\s*#?\s*(\d{8,})/i);
            const orderId = orderIdMatch ? `costco-ol-${orderIdMatch[1]}` : `costco-ol-${Date.now()}`;

            // Extract date
            let orderDate = new Date().toISOString();
            const dateMatch = text.match(/(\d{1,2}\/\d{1,2}\/\d{4})/);
            if (dateMatch) {
                try { orderDate = new Date(dateMatch[1]).toISOString(); } catch { }
            } else {
                const dateMatch2 = text.match(/(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\.?\s+\d{1,2},?\s*\d{4}/i);
                if (dateMatch2) {
                    try { orderDate = new Date(dateMatch2[0].replace(/\./g, '')).toISOString(); } catch { }
                }
            }

            // Extract total
            let total = 0;
            const totalMatch = text.match(/total[:\s]*\$(\d+(?:\.\d{2})?)/i);
            if (totalMatch) {
                total = parseFloat(totalMatch[1]);
            }

            // Look for product images with alt text
            const images = container.querySelectorAll('img[alt]');
            for (const img of images) {
                const alt = img.alt?.trim();
                if (!alt || alt.length < 5) continue;
                if (/costco|logo|icon|badge|banner/i.test(alt)) continue;

                items.push({
                    name: alt.length > 80 ? alt.substring(0, 80) + '...' : alt,
                    price: 0,
                    quantity: 1,
                    category: this.detectCategory(alt)
                });
            }

            // Look for product links
            if (items.length === 0) {
                const productLinks = container.querySelectorAll('a[href*="/product"]');
                for (const link of productLinks) {
                    const linkText = link.textContent?.trim();
                    if (!linkText || linkText.length < 5) continue;
                    if (/^(view|see|show|track|return|cancel)/i.test(linkText)) continue;

                    items.push({
                        name: linkText.length > 80 ? linkText.substring(0, 80) + '...' : linkText,
                        price: 0,
                        quantity: 1,
                        category: this.detectCategory(linkText)
                    });
                }
            }

            // Distribute total across items
            if (items.length > 0 && total > 0) {
                const itemPrice = total / items.length;
                items.forEach(item => {
                    item.price = Math.round(itemPrice * 100) / 100;
                });
            }

            return {
                store: 'costco',
                orderId: orderId,
                date: orderDate,
                total: total,
                items: items,
                url: window.location.href
            };
        },

        // =====================================
        // FALLBACK: Scrape whatever is visible
        // =====================================
        async scrapeCurrentView() {
            console.log('[Costco Scraper] Trying generic scrape of current view...');
            const orders = [];

            // Try warehouse-style (View Receipt buttons)
            const viewButtons = this.findViewReceiptButtons();
            if (viewButtons.length > 0) {
                return this.scrapeWarehouseTab();
            }

            // Try online-style (order containers)
            const orderContainers = document.querySelectorAll(
                '[class*="order-card"], [class*="OrderCard"], [data-testid*="order"]'
            );
            for (const container of orderContainers) {
                const order = this.parseOnlineOrderContainer(container);
                if (order && order.items.length > 0) {
                    orders.push(order);
                }
            }

            return orders;
        },

        // Format Costco item names (they're often ALL CAPS abbreviated)
        formatItemName(name) {
            // Costco receipt names are uppercase abbreviated, e.g. "KS BATTERIES", "IRISH STEW"
            // Title-case them for readability
            return name.split(' ')
                .map(word => {
                    if (word.length <= 2) return word; // Keep short words (KS, OG, etc.)
                    return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
                })
                .join(' ');
        },

        // Detect category from item name
        detectCategory(name) {
            const n = name.toLowerCase();

            if (/vitamin|supplement|medicine|tylenol|advil|bandaid|first aid|pharmacy|aspirin|ibuprofen|allergy|cold|flu|cough|pain relief/.test(n)) {
                return 'Health';
            }
            if (/shampoo|conditioner|soap|lotion|deodorant|toothpaste|toothbrush|razor|shaving|makeup|cosmetic|beauty|hair|skin|body wash/.test(n)) {
                return 'Personal';
            }
            if (/cleaning|paper towel|toilet paper|tissue|trash bag|laundry|detergent|dish soap|sponge|bleach|lysol|clorox/.test(n)) {
                return 'Food and Household';
            }
            if (/cable|charger|hdmi|usb|phone|headphone|speaker|tv|television|laptop|computer|tablet/.test(n)) {
                return 'Entertainment';
            }
            if (/battery|batteries/.test(n)) {
                return 'Food and Household';
            }
            if (/organic|milk|bread|egg|cheese|yogurt|meat|chicken|beef|pork|fish|vegetable|fruit|produce|cereal|snack|frozen|pizza|juice|soda|water|coffee|tea|rotisserie|stew|salad|butter|rice|pasta|flour|sugar|oil|vinegar/.test(n)) {
                return 'Food and Household';
            }
            if (/shirt|pants|dress|shoes|sock|underwear|jacket|coat|sweater|jeans|shorts/.test(n)) {
                return 'Clothing';
            }
            if (/dog|cat|pet food|pet treat/.test(n)) {
                return 'Pet';
            }
            if (/baby|infant|diaper|formula/.test(n)) {
                return 'Baby';
            }
            if (/tire|motor oil|wiper|auto/.test(n)) {
                return 'Car Maintenance';
            }

            return 'Food and Household'; // Default for Costco
        },

        parsePrice(text) {
            if (!text) return 0;
            const match = text.match(/\$?([\d,]+\.?\d*)/);
            return match ? parseFloat(match[1].replace(',', '')) : 0;
        }
    };

    // Start
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => CostcoScraper.init());
    } else {
        setTimeout(() => CostcoScraper.init(), 1000);
    }
})();
