// Amazon Order History Scraper
// Extracts itemized receipts from Amazon.com order history

(async function () {
    'use strict';

    const AmazonScraper = {
        async init() {
            console.log('[Amazon Scraper] Initializing on', window.location.href);

            // Check if we're in scraping mode (opened via "Fetch Receipts" button)
            // Supports both old format (scrapingMode.store) and new format (scrapingMode.stores[store])
            const { scrapingMode } = await chrome.storage.local.get('scrapingMode');
            const storeData = scrapingMode?.stores?.amazon || (scrapingMode?.store === 'amazon' ? scrapingMode : null);
            const isScrapingMode = storeData?.active;

            // Also check if flag is stale (older than 5 minutes)
            const isStale = storeData?.timestamp && (Date.now() - storeData.timestamp > 5 * 60 * 1000);

            if (!isScrapingMode || isStale) {
                console.log('[Amazon Scraper] Not in scraping mode, skipping auto-scrape');
                if (isStale) {
                    await chrome.storage.local.remove('scrapingMode');
                }
                return; // Don't auto-scrape when user manually opens order links
            }

            console.log('[Amazon Scraper] Scraping mode active, proceeding...');

            // Store target dates if available (passed from service worker via scrapingMode)
            this.targetDates = storeData.targetDates || [];

            // Check if we're resuming a multi-page targeted scrape
            const { amazonScrapeProgress } = await chrome.storage.local.get('amazonScrapeProgress');
            if (amazonScrapeProgress) {
                this.targetDates = amazonScrapeProgress.targetDates || this.targetDates;
                console.log(`[Amazon Scraper] Resuming targeted scrape from page ${amazonScrapeProgress.page}`);
            }

            if (this.targetDates.length > 0) {
                console.log(`[Amazon Scraper] Target dates for matching: ${this.targetDates.map(d => new Date(d).toLocaleDateString()).join(', ')}`);
            }

            // Add visual indicator
            this.addScraperUI();

            // Auto-detect page type and scrape
            const url = window.location.href;
            if (url.includes('/order-details/') || url.includes('order-details?orderID=')) {
                await this.scrapeOrderDetails();
            } else if (url.includes('/your-orders/') || url.includes('/order-history') || url.includes('/gp/css/order')) {
                await this.scrapeAllOrders();
            } else {
                console.log('[Amazon Scraper] Unknown page type, trying order list scrape anyway');
                await this.scrapeAllOrders();
            }
        },

        addScraperUI() {
            const banner = document.createElement('div');
            banner.id = 'edb-amazon-banner';
            banner.innerHTML = `
        <div style="
          position: fixed;
          top: 0;
          left: 0;
          right: 0;
          background: linear-gradient(135deg, #FF9900, #FFB84D);
          color: #111;
          padding: 10px 20px;
          display: flex;
          justify-content: space-between;
          align-items: center;
          z-index: 999999;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          box-shadow: 0 2px 8px rgba(0,0,0,0.2);
        ">
          <span style="font-weight: 500;">📦 EveryDollar Auto-Budget is scanning Amazon orders...</span>
          <div style="display: flex; gap: 10px;">
            <button id="edb-amazon-scrape" style="
              background: #111;
              color: #FF9900;
              border: none;
              padding: 8px 16px;
              border-radius: 4px;
              cursor: pointer;
              font-weight: bold;
            ">Scrape Orders</button>
            <button id="edb-amazon-scrape-all" style="
              background: #232F3E;
              color: white;
              border: none;
              padding: 8px 16px;
              border-radius: 4px;
              cursor: pointer;
              font-weight: bold;
            ">Scrape All (Auto-scroll)</button>
          </div>
        </div>
      `;
            document.body.prepend(banner);
            document.body.style.marginTop = '50px';

            document.getElementById('edb-amazon-scrape').addEventListener('click', () => {
                this.scrapeOrderList();
            });

            document.getElementById('edb-amazon-scrape-all').addEventListener('click', () => {
                this.scrapeAllOrders();
            });
        },

        // skipCompletion: when true, don't send completion messages (used by scrapeAllOrders)
        async scrapeOrderList(skipCompletion = false) {
            const orders = [];

            // Amazon order history uses various structures
            const orderCards = document.querySelectorAll(
                '.order-card, [class*="order-card"], .a-box-group, ' +
                '[data-testid="order-card"], [data-component-type="s-order-card"]'
            );

            // Fallback: look for order info boxes
            const orderBoxes = document.querySelectorAll('.order-info, [class*="order-info"]');

            const containers = orderCards.length > 0 ? orderCards : orderBoxes;

            console.log(`[Amazon Scraper] Found ${containers.length} order containers`);

            for (const container of containers) {
                try {
                    const order = await this.parseOrderCard(container);
                    if (order && order.total > 0) {
                        console.log(`[Amazon Scraper] Parsed order: ${order.orderId} with ${order.items.length} items, total: $${order.total}`);
                        orders.push(order);
                        await window.StorageManager.addStoreReceipt(order);
                    }
                } catch (e) {
                    console.error('[Amazon Scraper] Error parsing order:', e);
                }
            }

            // Also try to get order links and scrape details
            const orderLinks = document.querySelectorAll('a[href*="order-details?orderID="], a[href*="order-details/"]');

            console.log(`[Amazon Scraper] Found ${orderLinks.length} order detail links`);

            // Only send completion messages if not called from scrapeAllOrders
            if (!skipCompletion) {
                // Notify background script
                chrome.runtime.sendMessage({
                    action: 'receiptsScraped',
                    store: 'amazon',
                    count: orders.length
                });

                const totalItems = orders.reduce((sum, o) => sum + o.items.length, 0);
                this.updateBanner(`Scraped ${orders.length} Amazon orders with ${totalItems} items! Returning to EveryDollar...`);

                // Auto-close and return to EveryDollar
                setTimeout(() => {
                    chrome.runtime.sendMessage({ action: 'scrapeComplete', store: 'amazon' });
                }, 2000);
            }

            return orders;
        },

        async scrapeAllOrders() {
            const hasTargets = this.targetDates && this.targetDates.length > 0;

            if (hasTargets) {
                // DATE-TARGETED SCRAPING: Use pagination to find orders near target dates
                await this.scrapeTargetedOrders();
            } else {
                // FULL SCRAPE: Scroll through all visible orders
                await this.scrapeFullOrderList();
            }
        },

        // Targeted scraping: paginate through Amazon orders to find ones near target dates
        // Uses page navigation with startIndex to move through order history
        async scrapeTargetedOrders() {
            const targetDatesMs = this.targetDates.map(d => new Date(d).getTime());
            const oldestTarget = Math.min(...targetDatesMs);
            const newestTarget = Math.max(...targetDatesMs);
            // Search window: 7 days before oldest target, 7 days after newest
            const searchStart = oldestTarget - 7 * 24 * 60 * 60 * 1000;
            const searchEnd = newestTarget + 7 * 24 * 60 * 60 * 1000;

            // Restore progress from previous page navigation (if resuming)
            const { amazonScrapeProgress } = await chrome.storage.local.get('amazonScrapeProgress');
            let allOrders = [];
            let seenOrderIds = new Set();
            let pageNum = 1;

            if (amazonScrapeProgress) {
                for (const id of (amazonScrapeProgress.seenOrderIds || [])) seenOrderIds.add(id);
                allOrders = amazonScrapeProgress.allOrders || [];
                pageNum = amazonScrapeProgress.page || 1;
                await chrome.storage.local.remove('amazonScrapeProgress');
                console.log(`[Amazon Scraper] Resumed: page ${pageNum}, ${allOrders.length} orders so far`);
            }

            console.log(`[Amazon Scraper] Targeted scrape: looking for orders between ${new Date(searchStart).toLocaleDateString()} and ${new Date(searchEnd).toLocaleDateString()}`);
            this.updateBanner(`Searching page ${pageNum} for orders near ${this.targetDates.map(d => new Date(d).toLocaleDateString()).join(', ')}...`);

            // Scrape current page
            const orders = await this.scrapeOrderList(true);

            let foundInWindow = false;
            let oldestOnPage = Infinity;

            for (const order of orders) {
                if (!seenOrderIds.has(order.orderId)) {
                    seenOrderIds.add(order.orderId);
                    allOrders.push(order);

                    const orderDate = new Date(order.date).getTime();
                    oldestOnPage = Math.min(oldestOnPage, orderDate);

                    if (orderDate >= searchStart && orderDate <= searchEnd) {
                        foundInWindow = true;
                        console.log(`[Amazon Scraper] ✓ Found order in target window: ${order.orderId} (${new Date(order.date).toLocaleDateString()}, $${order.total})`);
                    }
                }
            }

            const passedWindow = oldestOnPage < searchStart;
            console.log(`[Amazon Scraper] Page ${pageNum}: ${orders.length} orders, oldest: ${new Date(oldestOnPage).toLocaleDateString()}, inWindow: ${foundInWindow}, passed: ${passedWindow}`);

            // Decide whether to continue to next page
            const shouldContinue = orders.length > 0 && !passedWindow && pageNum < 30;

            if (shouldContinue) {
                // Need to go deeper — navigate to next page
                const currentUrl = new URL(window.location.href);
                const timeFilter = currentUrl.searchParams.get('timeFilter') || 'year-' + new Date(oldestTarget).getFullYear();
                const nextIndex = (pageNum) * 10; // 10 orders per page
                const nextUrl = `https://www.amazon.com/your-orders/orders?timeFilter=${timeFilter}&startIndex=${nextIndex}`;

                console.log(`[Amazon Scraper] Continuing to page ${pageNum + 1} (startIndex=${nextIndex})`);
                this.updateBanner(`Searching page ${pageNum + 1}... (${allOrders.length} orders found so far)`);

                // Save progress before navigating
                await chrome.storage.local.set({
                    amazonScrapeProgress: {
                        seenOrderIds: [...seenOrderIds],
                        allOrders,
                        targetDates: this.targetDates,
                        page: pageNum + 1
                    }
                });

                window.location.href = nextUrl;
                return; // Will re-init on next page
            }

            // Done — report results
            const totalItems = allOrders.reduce((sum, o) => sum + o.items.length, 0);
            const matchCount = allOrders.filter(o => {
                const t = new Date(o.date).getTime();
                return t >= searchStart && t <= searchEnd;
            }).length;
            this.updateBanner(`Done! ${allOrders.length} orders (${matchCount} near target dates). Returning to EveryDollar...`);
            console.log(`[Amazon Scraper] Targeted scrape complete: ${allOrders.length} orders across ${pageNum} pages, ${matchCount} in target window`);

            chrome.runtime.sendMessage({
                action: 'receiptsScraped',
                store: 'amazon',
                count: allOrders.length
            });

            setTimeout(() => {
                chrome.runtime.sendMessage({ action: 'scrapeComplete', store: 'amazon' });
            }, 2000);
        },

        // Original full scrape: scroll through all visible orders
        async scrapeFullOrderList() {
            this.updateBanner('Scraping all visible orders with auto-scroll...');

            let lastCount = 0;
            let stableCount = 0;
            const allOrders = [];
            const seenOrderIds = new Set();

            while (stableCount < 3) {
                // Scrape current view (skip completion messages)
                const orders = await this.scrapeOrderList(true);

                // Deduplicate by orderId
                for (const order of orders) {
                    if (!seenOrderIds.has(order.orderId)) {
                        seenOrderIds.add(order.orderId);
                        allOrders.push(order);
                    }
                }

                this.updateBanner(`Scraping... found ${allOrders.length} orders so far`);

                // Scroll down
                window.scrollTo(0, document.body.scrollHeight);
                await new Promise(resolve => setTimeout(resolve, 1500));

                // Check for "Load more" or pagination
                const buttons = document.querySelectorAll('button, .a-button');
                const loadMoreBtn = Array.from(buttons).find(btn =>
                    btn.textContent?.toLowerCase().includes('load more') ||
                    btn.textContent?.toLowerCase().includes('show more')
                );
                const paginationNext = document.querySelector('.a-pagination .a-last a, .a-pagination li:last-child a');
                const loadMore = loadMoreBtn || paginationNext;
                if (loadMore) {
                    console.log('[Amazon Scraper] Clicking load more/next page...');
                    loadMore.click();
                    await new Promise(resolve => setTimeout(resolve, 2000));
                }

                // Check if we got new orders
                const currentCount = allOrders.length;
                if (currentCount === lastCount) {
                    stableCount++;
                } else {
                    stableCount = 0;
                }
                lastCount = currentCount;
            }

            const totalItems = allOrders.reduce((sum, o) => sum + o.items.length, 0);
            this.updateBanner(`Finished! Scraped ${allOrders.length} orders with ${totalItems} items. Returning to EveryDollar...`);

            // Send final completion messages
            chrome.runtime.sendMessage({
                action: 'receiptsScraped',
                store: 'amazon',
                count: allOrders.length
            });

            // Auto-close and return to EveryDollar
            setTimeout(() => {
                chrome.runtime.sendMessage({ action: 'scrapeComplete', store: 'amazon' });
            }, 2000);
        },

        parseOrderCard(card) {
            const items = [];
            const seenNames = new Set();
            console.log('[Amazon Scraper] Parsing order card...');

            // Look for item rows within the order
            // Prefer container elements first, then fall back to links
            let itemEls = card.querySelectorAll(
                '.yohtmlc-item, [class*="item-box"], [class*="product"]'
            );
            // Only fall back to product links if no containers found
            if (itemEls.length === 0) {
                itemEls = card.querySelectorAll(
                    'a[href*="/gp/product/"], a[href*="/dp/"]'
                );
            }

            console.log(`[Amazon Scraper] Found ${itemEls.length} item elements in card`);

            for (const itemEl of itemEls) {
                // Skip elements that are children of an element already processed
                if (itemEl.closest('.yohtmlc-item') && itemEl !== itemEl.closest('.yohtmlc-item')) {
                    continue;
                }

                const nameEl = itemEl.querySelector(
                    '.yohtmlc-product-title, [class*="product-title"], ' +
                    '[class*="a-link-normal"], .a-text-bold'
                ) || itemEl;

                const name = nameEl?.textContent?.trim();

                // Validate product name
                if (!this.isValidProductName(name)) {
                    if (name) console.log(`[Amazon Scraper] Skipping invalid name: "${name}"`);
                    continue;
                }

                // Deduplicate: skip if we already have this item name (truncated to match)
                const nameKey = name.substring(0, 100).toLowerCase();
                if (seenNames.has(nameKey)) {
                    console.log(`[Amazon Scraper] Skipping duplicate: "${name.substring(0, 40)}..."`);
                    continue;
                }
                seenNames.add(nameKey);

                // Try to find item price - Amazon often shows prices in order list
                // Look in the item element itself, its parent, and nearby siblings
                let price = 0;
                const priceEl = itemEl.querySelector('[class*="a-color-price"], [class*="item-price"], .price') ||
                    itemEl.parentElement?.querySelector('[class*="a-color-price"], [class*="price"]');
                if (priceEl) {
                    price = this.parsePrice(priceEl.textContent);
                }
                // Also try looking for price pattern in item text
                if (price === 0) {
                    const itemText = (itemEl.parentElement || itemEl).textContent;
                    const priceMatch = itemText.match(/\$(\d+\.\d{2})/);
                    if (priceMatch) {
                        price = parseFloat(priceMatch[1]);
                    }
                }

                // Extract store category using our helper
                const { storeCategory, category } = this.extractStoreCategory(itemEl, name);

                const item = {
                    name: name.substring(0, 100), // Truncate long names
                    price: price,
                    quantity: 1,
                    storeCategory: storeCategory,
                    category: category
                };

                console.log(`[Amazon Scraper] Item: "${item.name.substring(0, 40)}..." | price: $${price} | storeCategory: ${storeCategory} | category: ${category}`);
                items.push(item);
            }

            // Extract order metadata
            // Try specific Amazon order ID format FIRST (XXX-XXXXXXX-XXXXXXX), then fallback
            const orderIdMatch = card.innerHTML.match(/(\d{3}-\d{7}-\d{7})/) ||
                card.textContent.match(/ORDER #\s*([\d-]+)/i) ||
                card.innerHTML.match(/order[^\d]*#?\s*(\d{3}-\d{7}-\d{7})/i);

            const dateEl = card.querySelector(
                '[class*="order-date"], [class*="a-color-secondary"]'
            );

            const totalEl = card.querySelector(
                '[class*="order-total"], [class*="a-text-bold"]'
            );

            // Try to find the total in the card text
            let total = 0;
            const totalMatch = card.textContent.match(/(?:Order Total|Grand Total|Total)[:\s]*\$?([\d,]+\.?\d*)/i);
            if (totalMatch) {
                total = parseFloat(totalMatch[1].replace(',', ''));
            } else if (totalEl) {
                total = this.parsePrice(totalEl.textContent);
            } else {
                // Fallback: find any dollar amount in the card (likely the order total)
                const dollarMatch = card.textContent.match(/\$(\d+\.\d{2})/);
                if (dollarMatch) {
                    total = parseFloat(dollarMatch[1]);
                }
            }

            // Parse date
            let date = new Date().toISOString();
            if (dateEl) {
                const dateText = dateEl.textContent;
                const dateMatch = dateText.match(/(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4}/i);
                if (dateMatch) {
                    date = new Date(dateMatch[0]).toISOString();
                }
            }

            // Find the specific order detail link for this order
            // Amazon uses: /your-orders/order-details?orderID=XXX or /gp/your-account/order-details?orderID=XXX
            let orderUrl = window.location.href; // Default fallback
            const orderDetailLink = card.querySelector(
                'a[href*="order-details?orderID="], a[href*="order-details/"]'
            );
            if (orderDetailLink) {
                const href = orderDetailLink.getAttribute('href');
                // Build full URL if relative
                if (href.startsWith('/')) {
                    orderUrl = `https://www.amazon.com${href}`;
                } else if (href.startsWith('http')) {
                    orderUrl = href;
                }
                console.log(`[Amazon Scraper] Found order detail URL: ${orderUrl.substring(0, 80)}...`);
            }

            // Amazon list view doesn't show individual prices, only order totals
            // Distribute total among items that have $0 price
            const itemsWithoutPrice = items.filter(item => item.price === 0);
            if (itemsWithoutPrice.length > 0 && total > 0) {
                const pricePerItem = Math.round((total / itemsWithoutPrice.length) * 100) / 100;
                // Adjust last item to account for rounding
                let remaining = total;
                for (let i = 0; i < itemsWithoutPrice.length; i++) {
                    if (i === itemsWithoutPrice.length - 1) {
                        itemsWithoutPrice[i].price = Math.round(remaining * 100) / 100;
                    } else {
                        itemsWithoutPrice[i].price = pricePerItem;
                        remaining -= pricePerItem;
                    }
                }
                console.log(`[Amazon Scraper] Distributed $${total} total across ${itemsWithoutPrice.length} items at ~$${pricePerItem} each`);
            }

            return {
                store: 'amazon',
                orderId: orderIdMatch ? orderIdMatch[1] : `amz-${Date.now()}`,
                date: date,
                total: total,
                items: items,
                url: orderUrl
            };
        },

        async scrapeOrderDetails() {
            // Individual order detail page - more detailed item info
            console.log('[Amazon Scraper] Scraping order details page...');
            const items = [];
            const seenNames = new Set();

            // Look for shipment groups
            const shipments = document.querySelectorAll(
                '.shipment, [class*="shipment"], [data-component-type="s-shipment"]'
            );

            const itemContainers = shipments.length > 0 ? shipments : [document.body];
            console.log(`[Amazon Scraper] Found ${itemContainers.length} shipment containers`);

            for (const container of itemContainers) {
                // Prefer container elements, fall back to links
                let itemEls = container.querySelectorAll(
                    '.yohtmlc-item, [class*="a-fixed-left-grid"], .item-box'
                );
                if (itemEls.length === 0) {
                    itemEls = container.querySelectorAll(
                        'a[href*="/gp/product/"], a[href*="/dp/"]'
                    );
                }

                console.log(`[Amazon Scraper] Found ${itemEls.length} items in container`);

                for (const itemEl of itemEls) {
                    // Skip elements nested inside an already-matched container
                    if (itemEl.closest('.yohtmlc-item') && itemEl !== itemEl.closest('.yohtmlc-item')) {
                        continue;
                    }

                    const nameEl = itemEl.querySelector(
                        '.yohtmlc-product-title, [class*="product-title"], ' +
                        'span.a-text-bold, [class*="a-link-normal"]'
                    ) || itemEl.querySelector('a');

                    const priceEl = itemEl.querySelector(
                        '[class*="item-price"], [class*="a-color-price"], .price'
                    );

                    const qtyEl = itemEl.querySelector(
                        '[class*="quantity"], [class*="qty"]'
                    );

                    const name = nameEl?.textContent?.trim();

                    // Validate product name
                    if (!this.isValidProductName(name)) {
                        continue;
                    }

                    // Deduplicate by name
                    const nameKey = name.substring(0, 100).toLowerCase();
                    if (seenNames.has(nameKey)) {
                        console.log(`[Amazon Scraper] Skipping duplicate: "${name.substring(0, 40)}..."`);
                        continue;
                    }
                    seenNames.add(nameKey);

                    // Extract store category using our helper
                    const { storeCategory, category } = this.extractStoreCategory(itemEl, name);

                    const item = {
                        name: name.substring(0, 100),
                        price: this.parsePrice(priceEl?.textContent),
                        quantity: parseInt(qtyEl?.textContent) || 1,
                        storeCategory: storeCategory,
                        category: category
                    };

                    console.log(`[Amazon Scraper] Item: "${item.name.substring(0, 40)}..." | price: $${item.price} | storeCategory: ${storeCategory} | category: ${category}`);
                    items.push(item);
                }
            }

            // Get order totals
            const totalMatch = document.body.textContent.match(/(?:Order Total|Grand Total)[:\s]*\$?([\d,]+\.?\d*)/i);
            const orderIdMatch = window.location.href.match(/orderID=(\d+-\d+-\d+)/i) ||
                document.body.textContent.match(/Order\s*#\s*([\d-]+)/i);
            const dateMatch = document.body.textContent.match(/(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4}/i);

            const order = {
                store: 'amazon',
                orderId: orderIdMatch ? orderIdMatch[1] : `amz-${Date.now()}`,
                date: dateMatch ? new Date(dateMatch[0]).toISOString() : new Date().toISOString(),
                total: totalMatch ? parseFloat(totalMatch[1].replace(',', '')) : 0,
                items: items,
                url: window.location.href
            };

            if (order.items.length > 0) {
                await window.StorageManager.addStoreReceipt(order);

                chrome.runtime.sendMessage({
                    action: 'receiptScraped',
                    store: 'amazon',
                    order: order
                });

                this.updateBanner(`Scraped order with ${items.length} items!`);
            } else {
                this.updateBanner('No items found on this page. Try the main order list.');
            }
        },

        // Extract store category from Amazon's own categorization or product info
        // Returns both raw storeCategory and mapped EveryDollar category
        extractStoreCategory(itemEl, name) {
            const nameLower = name.toLowerCase();

            // Look for breadcrumb or category info from Amazon
            const categoryEl = itemEl.querySelector('[class*="category"], [class*="department"], [class*="breadcrumb"]');
            if (categoryEl) {
                const rawCategory = categoryEl.textContent.trim();
                const mapped = this.mapAmazonCategory(rawCategory.toLowerCase());
                console.log(`[Amazon Scraper] Found Amazon category element: "${rawCategory}" -> "${mapped}"`);
                return { storeCategory: rawCategory, category: mapped };
            }

            // Infer from product name using keywords
            // Health & Personal Care
            if (/vitamin|supplement|medicine|first aid|bandage|pain relief|allergy|cold|flu|aspirin|tylenol|ibuprofen/.test(nameLower)) {
                return { storeCategory: 'Health & Personal Care', category: 'Health' };
            }

            // Electronics
            if (/cable|charger|adapter|battery|hdmi|usb|phone|case|headphone|speaker|bluetooth|electronic|gadget/.test(nameLower)) {
                return { storeCategory: 'Electronics', category: 'Entertainment' };
            }

            // Books & Media
            if (/book|kindle|dvd|blu-ray|movie|album|music|audiobook/.test(nameLower)) {
                return { storeCategory: 'Books & Media', category: 'Entertainment' };
            }

            // Home & Kitchen
            if (/kitchen|cookware|utensil|appliance|vacuum|cleaning|storage|pan|pot|dish|bowl|container/.test(nameLower)) {
                return { storeCategory: 'Home & Kitchen', category: 'Food and Household' };
            }

            // Toys & Games
            if (/toy|game|puzzle|lego|doll|action figure|nerf|hasbro|mattel/.test(nameLower)) {
                return { storeCategory: 'Toys & Games', category: 'Entertainment' };
            }

            // Clothing
            if (/shirt|pants|dress|shoes|sock|jacket|coat|sweater|jeans|clothing|apparel/.test(nameLower)) {
                return { storeCategory: 'Clothing', category: 'Clothing' };
            }

            // Pet supplies
            if (/dog|cat|pet food|pet treat|pet toy|collar|leash|aquarium|fish food/.test(nameLower)) {
                return { storeCategory: 'Pet Supplies', category: 'Pet' };
            }

            // Baby
            if (/baby|diaper|formula|stroller|crib|pacifier|infant|toddler|nursery/.test(nameLower)) {
                return { storeCategory: 'Baby', category: 'Baby' };
            }

            // Grocery/Food
            if (/snack|food|candy|chocolate|coffee|tea|cereal|protein|granola/.test(nameLower)) {
                return { storeCategory: 'Grocery', category: 'Food and Household' };
            }

            console.log(`[Amazon Scraper] No category detected for: "${name.substring(0, 50)}..."`);
            return { storeCategory: null, category: null }; // Unknown
        },

        mapAmazonCategory(categoryText) {
            // Map Amazon's department names to EveryDollar categories
            const catLower = categoryText.toLowerCase();
            if (/health|pharmacy|personal care|beauty|wellness/.test(catLower)) return 'Health';
            if (/electronics|computer|phone|camera|tech/.test(catLower)) return 'Entertainment';
            if (/book|kindle|audible|movie|music|media/.test(catLower)) return 'Entertainment';
            if (/home|kitchen|garden|furniture|housewares/.test(catLower)) return 'Food and Household';
            if (/grocery|food|beverage|snack|pantry/.test(catLower)) return 'Food and Household';
            if (/clothing|shoes|fashion|apparel/.test(catLower)) return 'Clothing';
            if (/toys|games/.test(catLower)) return 'Entertainment';
            if (/pet/.test(catLower)) return 'Pet';
            if (/baby|infant|nursery/.test(catLower)) return 'Baby';
            if (/office|school/.test(catLower)) return 'Giving';
            if (/automotive|car/.test(catLower)) return 'Car Maintenance';
            return 'Shopping';
        },

        // Validate that a name looks like a real product, not UI text
        isValidProductName(name) {
            if (!name || name.length < 5) return false;

            const nameLower = name.toLowerCase();

            // Skip Amazon branding/logos
            if (/amazon|prime|alexa|kindle|logo|icon|badge|banner/.test(nameLower) && name.length < 20) return false;

            // Skip common UI elements
            if (/^(sign in|log in|create account|cart|checkout|account|help|customer service|shop|browse|search|menu|home|orders?|your account|view order|track package)$/i.test(name)) return false;

            // Skip navigation/action text
            if (/^(view|see|show|hide|more|less|details|expand|collapse|close|open|back|next|previous|submit|continue|proceed|buy again|write a review)(\s|$)/i.test(name)) return false;

            // Skip very short generic text
            if (/^(ok|yes|no|add|buy|get|new|sale|save|free|deal)$/i.test(name)) return false;

            // Skip footer/dialog elements
            if (/^(welcome|privacy|terms|contact|about|careers|conditions of use|privacy notice)$/i.test(name)) return false;

            // Skip placeholder/loading text
            if (/loading|please wait|error|unavailable|out of stock/i.test(nameLower)) return false;

            return true;
        },

        parsePrice(text) {
            if (!text) return 0;
            const match = text.match(/\$?([\d,]+\.?\d*)/);
            return match ? parseFloat(match[1].replace(',', '')) : 0;
        },

        updateBanner(message) {
            const banner = document.querySelector('#edb-amazon-banner div');
            if (banner) {
                banner.querySelector('span').textContent = `✓ ${message}`;
            }
        }
    };

    // Wait for page to load
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => AmazonScraper.init());
    } else {
        // Wait a bit for dynamic content
        setTimeout(() => AmazonScraper.init(), 1500);
    }
})();
