// Walmart Order History Scraper
// Extracts itemized receipts from Walmart.com order history

(async function () {
    'use strict';

    const WalmartScraper = {
        async init() {
            console.log('[Walmart Scraper] Initializing on', window.location.href);

            // Check if we're in scraping mode (opened via "Fetch Receipts" button)
            // Supports both old format (scrapingMode.store) and new format (scrapingMode.stores[store])
            const { scrapingMode } = await chrome.storage.local.get('scrapingMode');
            const storeData = scrapingMode?.stores?.walmart || (scrapingMode?.store === 'walmart' ? scrapingMode : null);
            const isScrapingMode = storeData?.active;

            // Also check if flag is stale (older than 5 minutes)
            const isStale = storeData?.timestamp && (Date.now() - storeData.timestamp > 5 * 60 * 1000);

            if (!isScrapingMode || isStale) {
                console.log('[Walmart Scraper] Not in scraping mode, skipping auto-scrape');
                if (isStale) {
                    await chrome.storage.local.remove('scrapingMode');
                }
                return; // Don't auto-scrape when user manually opens order links
            }

            console.log('[Walmart Scraper] Scraping mode active, proceeding...');

            // Add visual indicator
            this.addScraperUI();

            // Wait for page to load
            await this.waitForOrders();

            // Scrape orders
            await this.scrapeOrders();
        },

        addScraperUI() {
            const banner = document.createElement('div');
            banner.id = 'edb-walmart-banner';
            banner.innerHTML = `
                <div style="
                    position: fixed;
                    top: 0;
                    left: 0;
                    right: 0;
                    background: linear-gradient(135deg, #0071dc, #004c91);
                    color: white;
                    padding: 10px 20px;
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    z-index: 999999;
                    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                    box-shadow: 0 2px 8px rgba(0,0,0,0.2);
                ">
                    <span style="font-weight: 500;">🏪 EveryDollar Auto-Budget - Scanning Walmart orders...</span>
                    <button id="edb-walmart-stop" style="
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

            document.getElementById('edb-walmart-stop').addEventListener('click', () => {
                document.getElementById('edb-walmart-banner')?.remove();
                document.body.style.marginTop = '0';
            });
        },

        updateBanner(message) {
            const banner = document.querySelector('#edb-walmart-banner div span');
            if (banner) {
                banner.textContent = `🏪 ${message}`;
            }
        },

        async waitForOrders() {
            console.log('[Walmart Scraper] Waiting for orders to load...');
            const maxWait = 15000;
            const checkInterval = 500;
            let waited = 0;

            while (waited < maxWait) {
                // Look for order elements - Walmart uses various patterns
                const orderElements = document.querySelectorAll('[data-testid*="order"], [class*="order-card"], [class*="OrderCard"]');
                const orderLinks = document.querySelectorAll('a[href*="/orders/"]');

                console.log(`[Walmart Scraper] After ${waited}ms: ${orderElements.length} order elements, ${orderLinks.length} order links`);

                if (orderElements.length > 0 || orderLinks.length > 0) {
                    console.log('[Walmart Scraper] Orders detected!');
                    await new Promise(r => setTimeout(r, 1000));
                    return;
                }

                await new Promise(r => setTimeout(r, checkInterval));
                waited += checkInterval;
            }

            console.log('[Walmart Scraper] Timeout waiting for orders, proceeding anyway...');
        },

        async scrapeOrders() {
            console.log('[Walmart Scraper] Starting order scrape...');
            const orders = [];

            // Try to find order cards/containers
            // Walmart's order page structure varies, so we try multiple strategies

            // Strategy 1: Look for order cards with data-testid
            let orderContainers = document.querySelectorAll('[data-testid*="order-card"], [data-testid*="orderCard"]');

            // Strategy 2: Look for elements containing order info patterns
            if (orderContainers.length === 0) {
                // Find elements that look like order containers
                const allDivs = document.querySelectorAll('div');
                orderContainers = Array.from(allDivs).filter(div => {
                    const text = div.innerText || '';
                    // Order containers typically have: order number, date, total, and item names
                    const hasOrderNumber = /order\s*#?\s*\d{10,}/i.test(text);
                    const hasDate = /(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}/i.test(text);
                    const hasPrice = /\$\d+\.\d{2}/.test(text);

                    // Must have at least order number and price, and be a reasonable container size
                    return hasOrderNumber && hasPrice && div.children.length > 2;
                });

                // Deduplicate - keep only outermost containers
                orderContainers = orderContainers.filter(container => {
                    return !orderContainers.some(other =>
                        other !== container && other.contains(container)
                    );
                });
            }

            console.log(`[Walmart Scraper] Found ${orderContainers.length} potential order containers`);

            for (const container of orderContainers) {
                try {
                    const order = this.parseOrderContainer(container);
                    if (order && order.items.length > 0) {
                        orders.push(order);
                        console.log(`[Walmart Scraper] Parsed order #${order.orderId}: ${order.items.length} items, $${order.total}`);
                    }
                } catch (e) {
                    console.error('[Walmart Scraper] Error parsing order:', e);
                }
            }

            // Strategy 3: If no orders found, try scraping from page text
            if (orders.length === 0) {
                console.log('[Walmart Scraper] Trying text-based scraping...');
                const pageOrder = this.scrapeFromPageText();
                if (pageOrder) {
                    orders.push(pageOrder);
                }
            }

            console.log(`[Walmart Scraper] Total orders scraped: ${orders.length}`);

            // Save orders to storage
            for (const order of orders) {
                await window.StorageManager.addStoreReceipt(order);
                console.log('[Walmart Scraper] Saved order:', order.orderId);
                // Notify EveryDollar in real-time
                chrome.runtime.sendMessage({
                    action: 'receiptScraped',
                    store: 'walmart',
                    order: order.orderId
                });
            }

            // Notify completion
            const totalItems = orders.reduce((sum, o) => sum + o.items.length, 0);
            this.updateBanner(`Scraped ${orders.length} orders with ${totalItems} items! Returning to EveryDollar...`);

            chrome.runtime.sendMessage({
                action: 'receiptsScraped',
                store: 'walmart',
                count: orders.length
            });

            // Auto-close and return to EveryDollar
            setTimeout(() => {
                chrome.runtime.sendMessage({ action: 'scrapeComplete', store: 'walmart' });
            }, 2000);
        },

        parseOrderContainer(container) {
            const text = container.innerText || '';

            // Extract order ID
            const orderIdMatch = text.match(/order\s*#?\s*(\d{10,})/i);
            const orderId = orderIdMatch ? orderIdMatch[1] : `walmart-${Date.now()}`;

            // Extract date
            let orderDate = new Date().toISOString();
            const dateMatch = text.match(/(?:placed|ordered|delivered)?\s*(?:on\s+)?([A-Za-z]+\s+\d{1,2}(?:,?\s*\d{4})?)/i);
            if (dateMatch) {
                try {
                    let dateStr = dateMatch[1];
                    // Add year if not present
                    if (!/\d{4}/.test(dateStr)) {
                        dateStr += `, ${new Date().getFullYear()}`;
                    }
                    orderDate = new Date(dateStr).toISOString();
                } catch (e) {
                    console.log('[Walmart Scraper] Could not parse date:', dateMatch[1]);
                }
            }

            // Extract total
            let total = 0;
            const totalMatch = text.match(/total[:\s]*\$(\d+(?:\.\d{2})?)/i);
            if (totalMatch) {
                total = parseFloat(totalMatch[1]);
            } else {
                // Look for any price that could be a total
                const prices = text.match(/\$(\d+\.\d{2})/g) || [];
                if (prices.length > 0) {
                    // Use the largest price as the total
                    total = Math.max(...prices.map(p => parseFloat(p.replace('$', ''))));
                }
            }

            // Extract items
            const items = [];

            // Look for product images with alt text
            const images = container.querySelectorAll('img[alt]');
            for (const img of images) {
                const alt = img.alt?.trim();
                if (!this.isValidProductName(alt)) {
                    if (alt) console.log(`[Walmart Scraper] Skipping invalid img alt: "${alt}"`);
                    continue;
                }
                items.push({
                    name: alt.length > 80 ? alt.substring(0, 80) + '...' : alt,
                    price: 0,
                    quantity: 1,
                    category: this.detectCategory(alt)
                });
            }

            // Look for product links
            if (items.length === 0) {
                const productLinks = container.querySelectorAll('a[href*="/ip/"]');
                for (const link of productLinks) {
                    const linkText = link.textContent?.trim();
                    if (!this.isValidProductName(linkText)) {
                        if (linkText) console.log(`[Walmart Scraper] Skipping invalid product link: "${linkText}"`);
                        continue;
                    }
                    items.push({
                        name: linkText.length > 80 ? linkText.substring(0, 80) + '...' : linkText,
                        price: 0,
                        quantity: 1,
                        category: this.detectCategory(linkText)
                    });
                }
            }

            // Distribute total across items if no individual prices
            if (items.length > 0 && total > 0) {
                const itemPrice = total / items.length;
                items.forEach(item => {
                    item.price = Math.round(itemPrice * 100) / 100;
                });
            }

            // Get order URL
            const orderLink = container.querySelector('a[href*="/orders/"]');
            const orderUrl = orderLink?.href || `https://www.walmart.com/orders/${orderId}`;

            return {
                store: 'walmart',
                orderId: orderId,
                date: orderDate,
                total: total,
                items: items,
                url: orderUrl
            };
        },

        scrapeFromPageText() {
            // Fallback: try to scrape order info from page text
            const text = document.body.innerText;

            const orderIdMatch = text.match(/order\s*#?\s*(\d{10,})/i);
            if (!orderIdMatch) return null;

            const orderId = orderIdMatch[1];

            // Extract date
            let orderDate = new Date().toISOString();
            const dateMatch = text.match(/(?:placed|ordered)\s+(?:on\s+)?([A-Za-z]+\s+\d{1,2},?\s*\d{4})/i);
            if (dateMatch) {
                try {
                    orderDate = new Date(dateMatch[1]).toISOString();
                } catch (e) {}
            }

            // Extract total
            let total = 0;
            const totalMatch = text.match(/(?:order\s+)?total[:\s]*\$(\d+(?:\.\d{2})?)/i);
            if (totalMatch) {
                total = parseFloat(totalMatch[1]);
            }

            // Extract items from product images
            const items = [];
            const images = document.querySelectorAll('img[alt]');
            for (const img of images) {
                const alt = img.alt?.trim();
                if (!this.isValidProductName(alt)) {
                    continue;
                }
                items.push({
                    name: alt.length > 80 ? alt.substring(0, 80) + '...' : alt,
                    price: total > 0 && items.length === 0 ? total : 0,
                    quantity: 1,
                    category: this.detectCategory(alt)
                });
            }

            // Distribute total
            if (items.length > 1 && total > 0) {
                const itemPrice = total / items.length;
                items.forEach(item => {
                    item.price = Math.round(itemPrice * 100) / 100;
                });
            }

            return items.length > 0 ? {
                store: 'walmart',
                orderId: orderId,
                date: orderDate,
                total: total,
                items: items,
                url: window.location.href
            } : null;
        },

        // Validate that a name looks like a real product, not UI text
        isValidProductName(name) {
            if (!name || name.length < 5) return false;

            const nameLower = name.toLowerCase();

            // Skip Walmart branding/logos
            if (/walmart|logo|icon|badge|banner/.test(nameLower)) return false;

            // Skip common UI elements
            if (/^(sign in|log in|create account|cart|checkout|account|help|customer service|shop|browse|search|menu|home|orders?|track|return|cancel)$/i.test(name)) return false;

            // Skip navigation/action text
            if (/^(view|see|show|hide|more|less|details|expand|collapse|close|open|back|next|previous|submit|continue|proceed)(\s|$)/i.test(name)) return false;

            // Skip very short generic text
            if (/^(ok|yes|no|add|buy|get|new|sale|save|free|deal)$/i.test(name)) return false;

            // Skip placeholder/loading text
            if (/loading|please wait|error|unavailable/i.test(nameLower)) return false;

            return true;
        },

        detectCategory(name) {
            const nameLower = name.toLowerCase();

            // Groceries / Food
            if (/food|grocery|produce|meat|dairy|bread|milk|egg|cheese|fruit|vegetable|frozen|snack|beverage|juice|soda|water|cereal|pasta|rice|sauce|condiment|spice/.test(nameLower)) {
                return 'Food and Household';
            }

            // Household
            if (/cleaning|paper towel|toilet paper|tissue|trash bag|laundry|detergent|dish|soap|bleach|lysol|wipe|mop|broom/.test(nameLower)) {
                return 'Food and Household';
            }

            // Health
            if (/vitamin|medicine|pharmacy|health|tylenol|advil|bandaid|first aid|aspirin|allergy|cold|flu|pain relief/.test(nameLower)) {
                return 'Health';
            }

            // Personal care
            if (/shampoo|conditioner|soap|lotion|deodorant|toothpaste|toothbrush|razor|makeup|cosmetic|beauty|hair|skin/.test(nameLower)) {
                return 'Personal';
            }

            // Electronics
            if (/electronic|cable|charger|battery|phone|headphone|speaker|tv|computer|tablet/.test(nameLower)) {
                return 'Entertainment';
            }

            // Baby
            if (/baby|infant|diaper|formula|stroller|pacifier|nursery/.test(nameLower)) {
                return 'Baby';
            }

            // Pet
            if (/dog|cat|pet|animal|bird|fish tank/.test(nameLower)) {
                return 'Pet';
            }

            // Clothing
            if (/shirt|pants|dress|shoes|sock|clothing|apparel|jacket|coat/.test(nameLower)) {
                return 'Clothing';
            }

            return null;
        }
    };

    // Wait for page to load
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => WalmartScraper.init());
    } else {
        WalmartScraper.init();
    }
})();
