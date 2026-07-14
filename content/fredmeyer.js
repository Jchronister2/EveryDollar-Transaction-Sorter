// Fred Meyer / Kroger Order History Scraper
// Extracts itemized receipts from fredmeyer.com purchase history
// Uses page navigation (not fetch) because Fred Meyer uses client-side rendering

(async function () {
    'use strict';

    const FredMeyerScraper = {
        async init() {
            console.log('[Fred Meyer Scraper] Initializing on', window.location.href);

            // Check if we're in scraping mode
            const { scrapingMode } = await chrome.storage.local.get('scrapingMode');
            const storeData = scrapingMode?.stores?.fredmeyer || (scrapingMode?.store === 'fredmeyer' ? scrapingMode : null);
            const isScrapingMode = storeData?.active;
            const isStale = storeData?.timestamp && (Date.now() - storeData.timestamp > 5 * 60 * 1000);

            if (!isScrapingMode || isStale) {
                console.log('[Fred Meyer Scraper] Not in scraping mode, skipping auto-scrape');
                if (isStale) {
                    await chrome.storage.local.remove('scrapingMode');
                }
                return;
            }

            console.log('[Fred Meyer Scraper] Scraping mode active, proceeding...');
            this.addScraperUI();

            // Determine page type
            const url = window.location.href;
            if (url.includes('/mypurchases/detail/')) {
                // Detail page - scrape items then continue to next
                await this.scrapeDetailPage();
            } else if (url.includes('/mypurchases')) {
                // List page - collect URLs and start navigation
                await this.scrapeOrderList();
            }
        },

        addScraperUI() {
            if (document.getElementById('edb-fredmeyer-banner')) return;

            const banner = document.createElement('div');
            banner.id = 'edb-fredmeyer-banner';
            banner.innerHTML = `
                <div style="
                    position: fixed;
                    top: 0;
                    left: 0;
                    right: 0;
                    background: linear-gradient(135deg, #004990, #0066CC);
                    color: white;
                    padding: 10px 20px;
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    z-index: 999999;
                    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                    box-shadow: 0 2px 8px rgba(0,0,0,0.2);
                ">
                    <span style="font-weight: 500;">🛒 EveryDollar Auto-Budget - Scanning Fred Meyer...</span>
                    <button id="edb-fredmeyer-stop" style="
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

            document.getElementById('edb-fredmeyer-stop')?.addEventListener('click', async () => {
                // Clear the queue and stop
                await chrome.storage.local.remove('fmScrapeQueue');
                this.updateBanner('Stopped.');
                setTimeout(() => {
                    chrome.runtime.sendMessage({ action: 'scrapeComplete', store: 'fredmeyer' });
                }, 1000);
            });
        },

        updateBanner(message) {
            const span = document.querySelector('#edb-fredmeyer-banner div span');
            if (span) {
                span.textContent = `🛒 ${message}`;
            }
        },

        // Wait for content to load
        async waitForContent(selector, maxWait = 15000) {
            const start = Date.now();
            while (Date.now() - start < maxWait) {
                const el = document.querySelector(selector);
                if (el) return el;
                await new Promise(r => setTimeout(r, 300));
            }
            return null;
        },

        // =====================================
        // LIST PAGE: Collect URLs and start
        // =====================================
        async scrapeOrderList() {
            console.log('[FM Scraper] On order list page, collecting order URLs...');
            this.updateBanner('Finding orders...');

            // Wait for orders to load
            await this.waitForContent('a[href*="/mypurchases/detail/"]');
            await new Promise(r => setTimeout(r, 1000));

            // Find all order links
            const orderLinks = document.querySelectorAll('a[href*="/mypurchases/detail/"]');
            console.log(`[FM Scraper] Found ${orderLinks.length} order links`);

            if (orderLinks.length === 0) {
                this.updateBanner('No orders found.');
                setTimeout(() => {
                    chrome.runtime.sendMessage({ action: 'scrapeComplete', store: 'fredmeyer' });
                }, 2000);
                return;
            }

            // Parse order summaries
            const orderQueue = [];
            for (const link of orderLinks) {
                const linkText = link.textContent || '';
                const href = link.getAttribute('href');

                // Skip canceled orders
                if (linkText.toLowerCase().includes('canceled')) continue;

                // Extract date
                const dateMatch = linkText.match(/(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\.?\s+\d{1,2},?\s*\d{4}/i);
                // Extract total
                const totalMatch = linkText.match(/\$(\d+(?:\.\d{2})?)/);

                if (href) {
                    // Filter to last 60 days
                    let isRecent = true;
                    if (dateMatch) {
                        try {
                            const cleanDate = dateMatch[0].replace(/\./g, '');
                            const orderDate = new Date(cleanDate);
                            const sixtyDaysAgo = new Date();
                            sixtyDaysAgo.setDate(sixtyDaysAgo.getDate() - 60);
                            isRecent = orderDate >= sixtyDaysAgo;
                        } catch { }
                    }

                    if (isRecent) {
                        orderQueue.push({
                            url: href.startsWith('http') ? href : `https://www.fredmeyer.com${href}`,
                            date: dateMatch ? dateMatch[0].replace(/\./g, '') : null,
                            total: totalMatch ? parseFloat(totalMatch[1]) : 0
                        });
                    }
                }
            }

            console.log(`[FM Scraper] ${orderQueue.length} recent orders to scrape`);

            if (orderQueue.length === 0) {
                this.updateBanner('No recent orders found.');
                setTimeout(() => {
                    chrome.runtime.sendMessage({ action: 'scrapeComplete', store: 'fredmeyer' });
                }, 2000);
                return;
            }

            // Store the queue and navigate to first order
            await chrome.storage.local.set({
                fmScrapeQueue: orderQueue,
                fmScrapeIndex: 0,
                fmScrapedCount: 0
            });

            this.updateBanner(`Found ${orderQueue.length} orders. Starting...`);

            // Navigate to first order
            setTimeout(() => {
                window.location.href = orderQueue[0].url;
            }, 500);
        },

        // =====================================
        // DETAIL PAGE: Scrape items and continue
        // =====================================
        async scrapeDetailPage() {
            console.log('[FM Scraper] On detail page, waiting for items to load...');

            // Get queue state
            const { fmScrapeQueue, fmScrapeIndex, fmScrapedCount } = await chrome.storage.local.get([
                'fmScrapeQueue', 'fmScrapeIndex', 'fmScrapedCount'
            ]);

            if (!fmScrapeQueue || fmScrapeIndex === undefined) {
                console.log('[FM Scraper] No queue found, scraping single page');
                // Single page scrape
                await this.scrapeSinglePage();
                return;
            }

            const currentOrder = fmScrapeQueue[fmScrapeIndex];
            this.updateBanner(`Scraping order ${fmScrapeIndex + 1} of ${fmScrapeQueue.length}...`);

            // Wait for items to load - look for h3 elements in list items
            await this.waitForContent('li h3', 10000);
            await new Promise(r => setTimeout(r, 1500)); // Extra wait for full load

            // Scrape items
            const orderData = this.parseCurrentPage(currentOrder);

            if (orderData && orderData.items.length > 0) {
                await window.StorageManager.addStoreReceipt(orderData);
                console.log(`[FM Scraper] Saved order with ${orderData.items.length} items`);
                await chrome.storage.local.set({ fmScrapedCount: (fmScrapedCount || 0) + 1 });

                // Notify EveryDollar in real-time so Awaiting Receipt count updates
                chrome.runtime.sendMessage({
                    action: 'receiptScraped',
                    store: 'fredmeyer',
                    order: orderData.orderId
                });
            } else {
                console.log('[FM Scraper] No items found on this page');
            }

            // Move to next order
            const nextIndex = fmScrapeIndex + 1;
            if (nextIndex < fmScrapeQueue.length) {
                await chrome.storage.local.set({ fmScrapeIndex: nextIndex });
                this.updateBanner(`Moving to order ${nextIndex + 1} of ${fmScrapeQueue.length}...`);

                setTimeout(() => {
                    window.location.href = fmScrapeQueue[nextIndex].url;
                }, 500);
            } else {
                // Done!
                const finalCount = (fmScrapedCount || 0) + (orderData?.items?.length > 0 ? 1 : 0);
                this.updateBanner(`Done! Scraped ${finalCount} orders.`);

                // Clean up
                await chrome.storage.local.remove(['fmScrapeQueue', 'fmScrapeIndex', 'fmScrapedCount']);

                // Notify completion
                chrome.runtime.sendMessage({
                    action: 'receiptsScraped',
                    store: 'fredmeyer',
                    count: finalCount
                });

                setTimeout(() => {
                    chrome.runtime.sendMessage({ action: 'scrapeComplete', store: 'fredmeyer' });
                }, 2000);
            }
        },

        // Parse the current page's items
        parseCurrentPage(orderSummary) {
            const items = [];

            // Find all product h3 headings in list items
            const itemElements = document.querySelectorAll('li h3');
            console.log(`[FM Scraper] Found ${itemElements.length} h3 elements in list items`);

            for (const h3 of itemElements) {
                const name = h3.textContent?.trim();
                if (!name || name.length < 3) continue;

                // Skip section headers and footer/dialog elements
                if (/^(Pickup|In-store|Out of Stock|Items|Order)/i.test(name)) continue;
                if (/^(Welcome!?|Contacting our|Privacy|Sign in|Create account|Help|Customer Service)/i.test(name)) continue;

                // Skip very short names that are likely UI elements
                if (name.length < 5) continue;

                // Navigate up to find container with price/qty
                const container = h3.closest('li');
                if (!container) {
                    console.log(`[FM Scraper] Skipping h3 without li container: "${name}"`);
                    continue;
                }

                const text = container.textContent || '';
                let price = 0;
                let quantity = 1;

                // Extract quantity from "Received: X"
                const qtyMatch = text.match(/Received:\s*(\d+)/);
                if (qtyMatch) {
                    quantity = parseInt(qtyMatch[1]);
                }

                // Extract price from "Paid:" section
                const paidMatch = text.match(/Paid:.*?\$(\d+(?:\.\d{2})?)/);
                if (paidMatch) {
                    price = parseFloat(paidMatch[1]);
                }

                // Skip if container doesn't have product indicators (Received/Paid)
                if (!qtyMatch && !paidMatch) {
                    console.log(`[FM Scraper] Skipping non-product h3: "${name}"`);
                    continue;
                }

                items.push({
                    name: name,
                    price: price,
                    quantity: quantity,
                    category: this.detectCategory(name)
                });

                console.log(`[FM Scraper] Item: "${name}" qty:${quantity} price:$${price}`);
            }

            // Get order metadata
            const pageText = document.body.textContent || '';
            // Capture full order number including tildes (e.g., 701~00656~2026-01-13~503~551408)
            const orderNumMatch = pageText.match(/Order Number:\s*([\d~-]+)/i);
            const orderId = orderNumMatch ? orderNumMatch[1].trim() : `fm-${Date.now()}`;

            // Get total from page - match standalone "Total" (not "Item Total", "Total Savings", etc.)
            let total = orderSummary?.total || 0;
            const totalMatches = [...pageText.matchAll(/Total\s*\$(\d+(?:\.\d{2})?)/gi)];
            const standaloneTotal = totalMatches.find(m => {
                const before = pageText.substring(Math.max(0, m.index - 5), m.index);
                return !before.match(/Item\s*$/i);
            });
            if (standaloneTotal) {
                total = parseFloat(standaloneTotal[1]);
            }

            // Get date - prefer orderSummary, fallback to parsing from page
            let orderDate = new Date().toISOString();
            if (orderSummary?.date) {
                try {
                    orderDate = new Date(orderSummary.date).toISOString();
                } catch { }
            } else {
                // Try to extract date from page text (e.g., "Jan. 13, 2026" or "Jan 13, 2026")
                const dateMatch = pageText.match(/(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\.?\s+\d{1,2},?\s*\d{4}/i);
                if (dateMatch) {
                    try {
                        const cleanDate = dateMatch[0].replace(/\./g, '');
                        orderDate = new Date(cleanDate).toISOString();
                    } catch { }
                }
            }

            console.log(`[FM Scraper] Parsed order ${orderId}: ${items.length} items, $${total}`);

            return {
                store: 'fredmeyer',
                orderId: orderId,
                date: orderDate,
                total: total,
                items: items,
                url: window.location.href
            };
        },

        // Scrape a single page (when accessed directly)
        async scrapeSinglePage() {
            this.updateBanner('Scanning order...');

            await this.waitForContent('li h3', 10000);
            await new Promise(r => setTimeout(r, 1500));

            const orderData = this.parseCurrentPage({});

            if (orderData && orderData.items.length > 0) {
                await window.StorageManager.addStoreReceipt(orderData);
                this.updateBanner(`Found ${orderData.items.length} items!`);

                chrome.runtime.sendMessage({
                    action: 'receiptsScraped',
                    store: 'fredmeyer',
                    count: 1
                });
            } else {
                this.updateBanner('No items found on this page.');
            }

            setTimeout(() => {
                chrome.runtime.sendMessage({ action: 'scrapeComplete', store: 'fredmeyer' });
            }, 2000);
        },

        // Detect category from item name
        detectCategory(name) {
            const n = name.toLowerCase();

            if (/butter|cheese|milk|egg|yogurt|cream|bread|tortilla|meat|beef|turkey|chicken|pork|banana|apple|orange|onion|avocado|tomato|fruit|vegetable|frozen|cereal|pasta|rice|sauce|snack/.test(n)) {
                return 'Food and Household';
            }
            if (/vitamin|medicine|pharmacy|health|tylenol|advil|bandaid|aspirin|allergy/.test(n)) {
                return 'Health';
            }
            if (/shampoo|conditioner|soap|lotion|deodorant|toothpaste|razor|vaseline|makeup|cosmetic/.test(n)) {
                return 'Personal';
            }
            if (/cleaning|paper towel|toilet paper|tissue|trash bag|laundry|detergent|dish|bleach/.test(n)) {
                return 'Food and Household';
            }
            if (/baby|infant|diaper|formula/.test(n)) {
                return 'Baby';
            }
            if (/dog|cat|pet/.test(n)) {
                return 'Pet';
            }

            return 'Food and Household'; // Default for grocery store
        }
    };

    // Start
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => FredMeyerScraper.init());
    } else {
        setTimeout(() => FredMeyerScraper.init(), 1000);
    }
})();
