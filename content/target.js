// Target Order History Scraper
// Extracts itemized receipts from Target.com order history

(async function () {
    'use strict';

    const TargetScraper = {
        async init() {
            console.log('[Target Scraper] Initializing...');
            console.log('[Target Scraper] Current URL:', window.location.href);
            console.log('[Target Scraper] Pathname:', window.location.pathname);

            // Check if we're in scraping mode (opened via "Fetch Receipts" button)
            // Supports both old format (scrapingMode.store) and new format (scrapingMode.stores[store])
            const { scrapingMode } = await chrome.storage.local.get('scrapingMode');
            const storeData = scrapingMode?.stores?.target || (scrapingMode?.store === 'target' ? scrapingMode : null);
            const isScrapingMode = storeData?.active;

            // Also check if flag is stale (older than 5 minutes)
            const isStale = storeData?.timestamp && (Date.now() - storeData.timestamp > 5 * 60 * 1000);

            if (!isScrapingMode || isStale) {
                console.log('[Target Scraper] Not in scraping mode, skipping auto-scrape');
                if (isStale) {
                    console.log('[Target Scraper] Scraping mode flag was stale, clearing...');
                    await chrome.storage.local.remove('scrapingMode');
                }
                return; // Don't auto-scrape when user manually opens order links
            }

            console.log('[Target Scraper] Scraping mode active, proceeding...');

            // Clear any stale in-store scraping flag from previous sessions
            await chrome.storage.local.remove('targetInStoreScraped');

            // Add visual indicator
            this.addScraperUI();

            // Check if we're on the order history page or order details
            // Handle both /orders and /order-history paths
            if (window.location.pathname === '/orders' || window.location.pathname.includes('/order-history')) {
                console.log('[Target Scraper] On order list page, starting scrape...');
                // Wait for dynamic content to load
                await this.waitForOrders();
                await this.scrapeOrderList();
            } else if (window.location.pathname.includes('/orders/')) {
                console.log('[Target Scraper] On order details page, starting scrape...');
                await this.scrapeOrderDetails();
            } else {
                console.log('[Target Scraper] Not on a recognized order page');
            }
        },

        // Wait for orders to load (Target uses dynamic loading)
        async waitForOrders() {
            console.log('[Target Scraper] Waiting for orders to load...');
            const maxWait = 15000; // 15 seconds max
            const checkInterval = 500;
            let waited = 0;

            while (waited < maxWait) {
                // Look for actual order content, NOT loading skeletons
                // Real orders have images with alt text containing product info
                const realOrderImages = document.querySelectorAll('img[alt]:not([alt=""])');
                const productImages = Array.from(realOrderImages).filter(img =>
                    img.alt && img.alt.length > 10 && !img.alt.includes('Target')
                );

                // Also check for order status text
                const orderStatusElements = document.querySelectorAll('[class*="OrderStatusCard"], [class*="orderStatus"], [class*="packageStatus"]');

                console.log(`[Target Scraper] After ${waited}ms: ${productImages.length} product images, ${orderStatusElements.length} status elements`);

                // Check if loading skeletons are gone
                const loadingElements = document.querySelectorAll('[class*="loading"], [class*="Loading"], [class*="skeleton"]');
                const isStillLoading = loadingElements.length > 5;

                if (productImages.length > 0 && !isStillLoading) {
                    console.log('[Target Scraper] Real orders detected, loading complete!');
                    // Give a little extra time for everything to settle
                    await new Promise(r => setTimeout(r, 1000));
                    return;
                }

                await new Promise(r => setTimeout(r, checkInterval));
                waited += checkInterval;
            }

            console.log('[Target Scraper] Timeout waiting for orders, proceeding anyway...');
        },

        // Load more orders until we have a year's worth
        async loadAllOrders() {
            console.log('[Target Scraper] Loading all orders (up to 1 year)...');
            this.updateBanner('Loading more orders...');

            const oneYearAgo = new Date();
            oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);

            let loadMoreClicks = 0;
            const maxClicks = 50; // Safety limit

            while (loadMoreClicks < maxClicks) {
                // Find the "Load more orders" button
                const loadMoreBtn = Array.from(document.querySelectorAll('button')).find(btn =>
                    btn.textContent.toLowerCase().includes('load more')
                );

                if (!loadMoreBtn) {
                    console.log('[Target Scraper] No more "Load more" button found - all orders loaded');
                    break;
                }

                // Check oldest order date currently visible
                const orderCards = document.querySelectorAll('[class*="orderCard"]');
                let oldestDate = new Date();

                for (const card of orderCards) {
                    const dateText = card.textContent.match(/(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2},?\s*\d{4}/i);
                    if (dateText) {
                        const parsed = new Date(dateText[0]);
                        if (!isNaN(parsed) && parsed < oldestDate) {
                            oldestDate = parsed;
                        }
                    }
                }

                console.log(`[Target Scraper] Oldest order: ${oldestDate.toLocaleDateString()}, target: ${oneYearAgo.toLocaleDateString()}`);

                // If we've gone back far enough, stop
                if (oldestDate <= oneYearAgo) {
                    console.log('[Target Scraper] Reached 1 year of orders');
                    break;
                }

                // Click "Load more"
                this.updateBanner(`Loading more orders... (${orderCards.length} loaded, going back to ${oldestDate.toLocaleDateString()})`);
                loadMoreBtn.click();
                loadMoreClicks++;

                // Wait for new orders to load
                await new Promise(r => setTimeout(r, 2000));

                // Wait for loading to complete
                let loadingWait = 0;
                while (loadingWait < 10000) {
                    const loadingElements = document.querySelectorAll('[class*="loading"], [class*="Loading"], [class*="skeleton"]');
                    if (loadingElements.length < 3) break;
                    await new Promise(r => setTimeout(r, 500));
                    loadingWait += 500;
                }
            }

            const finalCount = document.querySelectorAll('[class*="orderCard"]').length;
            console.log(`[Target Scraper] Finished loading. Total orders: ${finalCount}`);
            this.updateBanner(`Loaded ${finalCount} orders. Scraping...`);
        },

        addScraperUI() {
            const banner = document.createElement('div');
            banner.id = 'edb-target-banner';
            banner.innerHTML = `
        <div style="
          position: fixed;
          top: 0;
          left: 0;
          right: 0;
          background: linear-gradient(135deg, #cc0000, #ff0000);
          color: white;
          padding: 10px 20px;
          display: flex;
          justify-content: space-between;
          align-items: center;
          z-index: 999999;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        ">
          <span>📊 EveryDollar Auto-Budget - Loading Target orders...</span>
          <button id="edb-target-stop" style="
            background: rgba(255,255,255,0.3);
            color: white;
            border: none;
            padding: 8px 16px;
            border-radius: 4px;
            cursor: pointer;
          ">✕ Stop</button>
        </div>
      `;
            document.body.prepend(banner);

            // Stop button removes the banner and clears the queue
            document.getElementById('edb-target-stop').addEventListener('click', async () => {
                await chrome.storage.local.remove('targetOrderQueue');
                document.getElementById('edb-target-banner').remove();
            });
        },

        async scrapeOrderList() {
            console.log('[Target Scraper] scrapeOrderList: starting...');

            // Check which tab we're on (Online or In-store)
            const tabs = document.querySelectorAll('[role="tab"], button[class*="Tab"], a[class*="Tab"]');
            const inStoreTab = Array.from(tabs).find(t => t.textContent.toLowerCase().includes('in-store'));
            const onlineTab = Array.from(tabs).find(t => t.textContent.toLowerCase().includes('online'));

            // Check if In-store tab is currently active
            const isInStoreActive = inStoreTab && (
                inStoreTab.getAttribute('aria-selected') === 'true' ||
                inStoreTab.classList.contains('active') ||
                inStoreTab.closest('[class*="active"]')
            );

            console.log(`[Target Scraper] Found tabs: Online=${!!onlineTab}, In-store=${!!inStoreTab}, In-store active=${isInStoreActive}`);

            // First, load all orders on current tab (up to 1 year)
            await this.loadAllOrders();

            const orders = [];

            // Target uses orderCard class for each order
            const orderCards = document.querySelectorAll('[class*="orderCard"]');
            console.log(`[Target Scraper] Found ${orderCards.length} order cards`);

            // First pass: collect basic order info (skip canceled)
            const validOrders = [];
            for (const card of orderCards) {
                try {
                    const order = this.parseOrderCard(card);
                    if (order && order.items.length > 0) {
                        console.log(`[Target Scraper] Parsed order: #${order.orderId} - ${order.items.length} items, $${order.total}, status: ${order.status}`);
                        validOrders.push(order);
                    }
                } catch (e) {
                    console.error('[Target Scraper] Error parsing order card:', e);
                }
            }

            console.log(`[Target Scraper] ${validOrders.length} valid orders (excluding canceled)`);

            // For single-item orders, we know the price from the total
            // For multi-item orders, we need to open the detail page
            const ordersNeedingDetails = [];

            for (const order of validOrders) {
                if (order.items.length === 1 && order.total > 0) {
                    order.items[0].price = order.total;
                    console.log(`[Target Scraper] Single-item order - assigned total $${order.total} as item price`);
                } else if (order.items.length > 1) {
                    // Multi-item order needs detail page scraping
                    ordersNeedingDetails.push(order);
                }
                orders.push(order);
            }

            console.log(`[Target Scraper] Total orders: ${orders.length}`);
            console.log(`[Target Scraper] Orders needing detail scraping: ${ordersNeedingDetails.length}`);

            // Save to storage
            for (const order of orders) {
                await window.StorageManager.addStoreReceipt(order);
                console.log('[Target Scraper] Saved order:', order.orderId);
            }

            // Notify background script
            chrome.runtime.sendMessage({
                action: 'receiptsScraped',
                store: 'target',
                count: orders.length
            });

            const totalItems = orders.reduce((sum, o) => sum + o.items.length, 0);

            // Check if we need to also scrape the In-store tab
            const hasScrapedInStore = await this.hasScrapedInStoreTab();

            if (!hasScrapedInStore && inStoreTab && !isInStoreActive) {
                // We're on Online tab and haven't done In-store yet
                console.log('[Target Scraper] Switching to In-store tab...');
                this.updateBanner(`Scraped ${orders.length} online orders. Now checking In-store tab...`);

                // Mark that we're about to scrape in-store
                await chrome.storage.local.set({ targetInStoreScraped: true });

                // Click the In-store tab
                inStoreTab.click();

                // Wait for tab content to load, then re-run scrapeOrderList
                await new Promise(r => setTimeout(r, 2000));
                await this.waitForOrders();
                await this.scrapeOrderList();
                return; // The recursive call will handle completion
            }

            // Clear the in-store flag for next time
            await chrome.storage.local.remove('targetInStoreScraped');

            // If there are orders needing details, auto-start fetching prices
            if (ordersNeedingDetails.length > 0) {
                this.updateBanner(`Scraped ${orders.length} orders. Auto-fetching prices for ${ordersNeedingDetails.length} multi-item orders...`);

                // Store the queue for processing
                await this.storeOrderQueue(ordersNeedingDetails.map(o => o.url));

                // Auto-start fetching prices (with a short delay so user can see the message)
                setTimeout(() => {
                    this.startAutoOpen();
                }, 2000);
            } else {
                // All orders done, no detail pages needed - complete and close
                this.updateBanner(`✓ Scraped ${orders.length} Target orders with ${totalItems} items! Returning to EveryDollar...`);

                // Send completion message to close tab and return to EveryDollar
                setTimeout(() => {
                    chrome.runtime.sendMessage({ action: 'scrapeComplete', store: 'target' });
                }, 2000);
            }
        },

        // Check if we've already scraped the in-store tab this session
        async hasScrapedInStoreTab() {
            const result = await chrome.storage.local.get('targetInStoreScraped');
            return result.targetInStoreScraped === true;
        },

        // Store order URLs that need detail scraping
        async storeOrderQueue(urls) {
            await chrome.storage.local.set({ targetOrderQueue: urls });
            console.log(`[Target Scraper] Stored ${urls.length} orders in queue`);
        },

        // Get next order from queue
        async getNextOrderUrl() {
            const result = await chrome.storage.local.get('targetOrderQueue');
            const queue = result.targetOrderQueue || [];
            if (queue.length > 0) {
                const nextUrl = queue.shift();
                await chrome.storage.local.set({ targetOrderQueue: queue });
                return nextUrl;
            }
            return null;
        },

        // Show prompt to auto-open orders
        showAutoOpenPrompt(orders) {
            const banner = document.querySelector('#edb-target-banner div');
            if (banner) {
                banner.innerHTML = `
                    <span>📊 Found ${orders.length} multi-item orders needing price details</span>
                    <div style="display: flex; gap: 8px;">
                        <button id="edb-auto-open" style="
                            background: white;
                            color: #cc0000;
                            border: none;
                            padding: 8px 16px;
                            border-radius: 4px;
                            cursor: pointer;
                            font-weight: bold;
                        ">🔄 Fetch All Prices</button>
                        <button id="edb-skip-details" style="
                            background: rgba(255,255,255,0.3);
                            color: white;
                            border: none;
                            padding: 8px 16px;
                            border-radius: 4px;
                            cursor: pointer;
                        ">Skip</button>
                    </div>
                `;

                document.getElementById('edb-auto-open').addEventListener('click', () => {
                    this.startAutoOpen();
                });

                document.getElementById('edb-skip-details').addEventListener('click', () => {
                    this.updateBanner('Scraping complete! Open individual orders to get item prices.');
                    chrome.storage.local.remove('targetOrderQueue');
                });
            }
        },

        // Start auto-opening orders
        async startAutoOpen() {
            const result = await chrome.storage.local.get('targetOrderQueue');
            const queue = result.targetOrderQueue || [];
            const remaining = queue.length;

            const nextUrl = await this.getNextOrderUrl();
            if (nextUrl) {
                this.updateBanner(`Fetching order details... (${remaining} remaining)`);
                // Navigate to the order detail page
                window.location.href = nextUrl;
            } else {
                this.updateBanner('✓ All orders processed! Return to EveryDollar to see your receipts.');
            }
        },

        // Check if we should continue auto-opening (called from order detail page)
        async checkAndContinueAutoOpen() {
            const result = await chrome.storage.local.get('targetOrderQueue');
            const queue = result.targetOrderQueue || [];

            if (queue.length > 0) {
                // Auto-continue to next order after a short delay
                this.updateBanner(`✓ Order scraped! Auto-continuing to next... (${queue.length} remaining)`);
                setTimeout(() => {
                    this.startAutoOpen();
                }, 1500);
            } else {
                // All orders processed - complete and close
                this.updateBanner('✓ All orders processed! Returning to EveryDollar...');

                // Send completion message to close tab and return to EveryDollar
                setTimeout(() => {
                    chrome.runtime.sendMessage({ action: 'scrapeComplete', store: 'target' });
                }, 2000);
            }
        },

        // Show prompt to continue to next order
        showContinuePrompt(remaining) {
            const banner = document.querySelector('#edb-target-banner div');
            if (banner) {
                banner.innerHTML = `
                    <span>✓ Order scraped! ${remaining} more to go</span>
                    <div style="display: flex; gap: 8px;">
                        <button id="edb-continue-next" style="
                            background: white;
                            color: #cc0000;
                            border: none;
                            padding: 8px 16px;
                            border-radius: 4px;
                            cursor: pointer;
                            font-weight: bold;
                        ">Next Order →</button>
                        <button id="edb-back-to-list" style="
                            background: rgba(255,255,255,0.3);
                            color: white;
                            border: none;
                            padding: 8px 16px;
                            border-radius: 4px;
                            cursor: pointer;
                        ">Back to List</button>
                    </div>
                `;

                document.getElementById('edb-continue-next').addEventListener('click', () => {
                    this.startAutoOpen();
                });

                document.getElementById('edb-back-to-list').addEventListener('click', () => {
                    chrome.storage.local.remove('targetOrderQueue');
                    window.location.href = 'https://www.target.com/orders';
                });
            }
        },

        // Wait for order detail content to load
        async waitForOrderDetails() {
            console.log('[Target Scraper] Waiting for order details to load...');
            const maxWait = 10000;
            const checkInterval = 500;
            let waited = 0;

            while (waited < maxWait) {
                // Look for product images or product info
                const productImages = document.querySelectorAll('img[alt]');
                const realProducts = Array.from(productImages).filter(img =>
                    img.alt && img.alt.length > 10 &&
                    !img.alt.toLowerCase().includes('target') &&
                    !img.alt.toLowerCase().includes('logo')
                );

                // Look for price elements
                const priceElements = document.querySelectorAll('[class*="Price"], [class*="price"]');

                console.log(`[Target Scraper] After ${waited}ms: ${realProducts.length} products, ${priceElements.length} price elements`);

                if (realProducts.length > 0) {
                    console.log('[Target Scraper] Order details loaded!');
                    await new Promise(r => setTimeout(r, 1000)); // Extra settle time
                    return;
                }

                await new Promise(r => setTimeout(r, checkInterval));
                waited += checkInterval;
            }

            console.log('[Target Scraper] Timeout waiting for order details');
        },

        // Parse a single order card element
        parseOrderCard(card) {
            console.log('[Target Scraper] parseOrderCard...');

            // Extract date - it's in a bold text element at the top
            const dateEl = card.querySelector('.h-text-bold.h-text-lg, [class*="h-text-bold"]');
            let orderDate = new Date().toISOString();
            if (dateEl) {
                const dateText = dateEl.textContent.trim();
                console.log('[Target Scraper] Found date text:', dateText);
                try {
                    orderDate = new Date(dateText).toISOString();
                } catch (e) {
                    console.log('[Target Scraper] Could not parse date');
                }
            }

            // Extract price - first grayDark text after date
            const priceEls = card.querySelectorAll('.h-text-grayDark.h-text-md');
            let total = 0;
            if (priceEls.length > 0) {
                const priceText = priceEls[0].textContent.trim();
                const priceMatch = priceText.match(/\$(\d+(?:,\d{3})*(?:\.\d{2})?)/);
                if (priceMatch) {
                    total = parseFloat(priceMatch[1].replace(',', ''));
                    console.log('[Target Scraper] Found price:', total);
                }
            }

            // Extract order ID - second grayDark text, starts with #
            let orderId = '';
            let isInStoreOrder = false;
            if (priceEls.length > 1) {
                const orderIdText = priceEls[1].textContent.trim();
                if (orderIdText.startsWith('#')) {
                    orderId = orderIdText.substring(1);
                    console.log('[Target Scraper] Found order ID:', orderId);
                }
            }

            // Check for in-store indicators
            const cardText = card.innerText.toLowerCase();
            if (cardText.includes('store trip') || cardText.includes('in-store') || cardText.includes('purchased') && cardText.includes('at ')) {
                isInStoreOrder = true;
                console.log('[Target Scraper] Detected in-store order');
            }

            // Generate order ID for in-store orders that don't have one
            if (!orderId) {
                // Use date + total as unique identifier for in-store orders
                const dateForId = orderDate.split('T')[0].replace(/-/g, '');
                orderId = `instore-${dateForId}-${Math.round(total * 100)}`;
                console.log('[Target Scraper] Generated in-store order ID:', orderId);
            }

            // Extract status
            const statusEl = card.querySelector('[class*="Heading"] span, h2 span');
            let status = '';
            if (statusEl) {
                status = statusEl.textContent.trim();
                console.log('[Target Scraper] Found status:', status);
            }

            // Also check for return status which is common for in-store
            const isReturn = cardText.includes('return complete') || cardText.includes('returned');
            if (isReturn) {
                status = status || 'Return complete';
                console.log('[Target Scraper] This is a return');
            }

            // Skip canceled orders (but NOT returns - we want those!)
            if (status.toLowerCase() === 'canceled' || status.toLowerCase() === 'cancelled') {
                console.log('[Target Scraper] Skipping canceled order');
                return null;
            }

            // Extract items from product images
            const imageContainer = card.querySelector('[class*="packageImagesContainer"]');
            const items = [];

            if (imageContainer) {
                const productImages = imageContainer.querySelectorAll('img[alt]');
                console.log('[Target Scraper] Found', productImages.length, 'product images');

                for (const img of productImages) {
                    // Clean up the alt text (decode HTML entities)
                    let itemName = (img.alt || '')
                        .replace(/&#39;/g, "'")
                        .replace(/&#38;/g, "&")
                        .replace(/&amp;/g, "&")
                        .replace(/&#8482;/g, "™")
                        .replace(/&quot;/g, '"')
                        .trim();

                    if (!this.isValidProductName(itemName)) {
                        if (itemName) console.log(`[Target Scraper] Skipping invalid name: "${itemName}"`);
                        continue;
                    }

                    // Truncate long names
                    if (itemName.length > 80) {
                        itemName = itemName.substring(0, 80) + '...';
                    }

                    items.push({
                        name: itemName,
                        price: 0,
                        quantity: 1,
                        storeCategory: null,
                        category: this.detectCategory(itemName)
                    });
                    console.log('[Target Scraper] Item:', itemName.substring(0, 50));
                }
            }

            console.log(`[Target Scraper] Parsed ${items.length} items`);

            if (items.length === 0) return null;

            // Build direct order URL - only for online orders with real order IDs
            const cleanOrderId = orderId.trim().replace(/[^0-9a-zA-Z-]/g, '');
            let orderUrl = null;
            if (!isInStoreOrder && cleanOrderId && !cleanOrderId.startsWith('instore-')) {
                orderUrl = `https://www.target.com/orders/${cleanOrderId}`;
                console.log('[Target Scraper] Order URL:', orderUrl);
            } else {
                console.log('[Target Scraper] In-store order - no detail URL');
            }

            return {
                store: 'target',
                orderId: cleanOrderId,
                date: orderDate,
                total: total,
                status: status,
                isInStore: isInStoreOrder,
                isReturn: isReturn,
                items: items,
                url: orderUrl
            };
        },

        async scrapeOrderDetails() {
            console.log('[Target Scraper] scrapeOrderDetails: starting...');

            // Wait for the order detail content to load
            await this.waitForOrderDetails();

            // More detailed scraping from individual order page
            const items = [];

            console.log('[Target Scraper] Looking for item elements...');

            // Strategy 1: Find product images with alt text and extract prices from parent containers
            const allImages = document.querySelectorAll('img[alt]');
            const productImages = Array.from(allImages).filter(img =>
                img.alt && img.alt.length > 10 &&
                !img.alt.toLowerCase().includes('target') &&
                !img.alt.toLowerCase().includes('logo') &&
                !img.alt.toLowerCase().includes('loading')
            );
            console.log(`[Target Scraper] Found ${productImages.length} product images with alt text`);

            // For each product image, look for price info in nearby elements
            for (const img of productImages) {
                let itemName = (img.alt || '')
                    .replace(/&#39;/g, "'")
                    .replace(/&#38;/g, "&")
                    .replace(/&amp;/g, "&")
                    .replace(/&#8482;/g, "™")
                    .replace(/&quot;/g, '"')
                    .trim();

                if (!this.isValidProductName(itemName)) {
                    continue;
                }

                // Look for price in parent container (up to 8 levels)
                let parent = img.parentElement;
                let price = 0;
                let foundPrice = false;

                // First, try to find a nearby element containing this item's price
                // Target shows "$15.00 unit price" near each product
                for (let i = 0; i < 8 && parent && !foundPrice; i++) {
                    // Method 1: Look for text containing "unit price" pattern
                    const allText = parent.innerText || '';
                    const lines = allText.split('\n');

                    for (const line of lines) {
                        const trimmedLine = line.trim();
                        // Match "$15.00 unit price" or "$15.00\nunit price"
                        const unitPriceMatch = trimmedLine.match(/^\$(\d+(?:\.\d{2})?)\s*(?:unit price|each)?$/i);
                        if (unitPriceMatch) {
                            price = parseFloat(unitPriceMatch[1]);
                            foundPrice = true;
                            console.log(`[Target Scraper] Found unit price $${price} for "${itemName.substring(0, 30)}..."`);
                            break;
                        }
                    }

                    if (foundPrice) break;

                    // Method 2: Look for elements with price-like text
                    const allElements = parent.querySelectorAll('*');
                    for (const el of allElements) {
                        // Only check direct text content (not nested)
                        const directText = Array.from(el.childNodes)
                            .filter(n => n.nodeType === Node.TEXT_NODE)
                            .map(n => n.textContent.trim())
                            .join('');

                        const priceMatch = directText.match(/^\$(\d+(?:\.\d{2})?)$/);
                        if (priceMatch) {
                            // Make sure this isn't a total or shipping price
                            const parentText = el.parentElement?.innerText?.toLowerCase() || '';
                            if (!parentText.includes('total') && !parentText.includes('shipping') && !parentText.includes('subtotal')) {
                                price = parseFloat(priceMatch[1]);
                                foundPrice = true;
                                console.log(`[Target Scraper] Found element price $${price} for "${itemName.substring(0, 30)}..."`);
                                break;
                            }
                        }
                    }

                    parent = parent.parentElement;
                }

                const category = this.detectCategory(itemName);

                items.push({
                    name: itemName.length > 80 ? itemName.substring(0, 80) + '...' : itemName,
                    price: price,
                    quantity: 1,
                    storeCategory: null,
                    category: category
                });

                console.log(`[Target Scraper] Item: "${itemName.substring(0, 40)}..." | price: $${price} | category: ${category}`);
            }

            // Strategy 2: If no items found via images, try product links
            if (items.length === 0) {
                console.log('[Target Scraper] Trying product links strategy...');
                const productLinks = document.querySelectorAll('a[href*="/p/"]');
                console.log(`[Target Scraper] Found ${productLinks.length} product links`);

                for (const link of productLinks) {
                    const linkText = link.textContent.trim();
                    if (linkText && linkText.length > 5 && !linkText.includes('View Product')) {
                        // Look for price near the link
                        let parent = link.parentElement;
                        let price = 0;

                        for (let i = 0; i < 4 && parent; i++) {
                            const allText = parent.innerText || '';
                            const unitPriceMatch = allText.match(/\$(\d+(?:\.\d{2})?)\s*(?:unit price|each)/i);
                            if (unitPriceMatch) {
                                price = parseFloat(unitPriceMatch[1]);
                                break;
                            }
                            parent = parent.parentElement;
                        }

                        items.push({
                            name: linkText,
                            price: price,
                            quantity: 1,
                            storeCategory: null,
                            category: this.detectCategory(linkText)
                        });

                        console.log(`[Target Scraper] Item from link: "${linkText.substring(0, 40)}..." | price: $${price}`);
                    }
                }
            }

            console.log(`[Target Scraper] Scraped ${items.length} items total`);

            // Get order info from URL
            const orderIdMatch = window.location.pathname.match(/orders\/(\d+)/);
            const orderId = orderIdMatch ? orderIdMatch[1] : '';

            // Extract pricing breakdown from page
            const allText = document.body.innerText;

            // Find subtotal, shipping, discounts, and total
            let subtotal = 0;
            let shipping = 0;
            let discounts = 0;
            let total = 0;

            const subtotalMatch = allText.match(/Subtotal[:\s]*\$(\d+(?:\.\d{2})?)/i);
            if (subtotalMatch) {
                subtotal = parseFloat(subtotalMatch[1]);
                console.log(`[Target Scraper] Found subtotal: $${subtotal}`);
            }

            const shippingMatch = allText.match(/Shipping[:\s]*\$(\d+(?:\.\d{2})?)/i);
            if (shippingMatch) {
                shipping = parseFloat(shippingMatch[1]);
                console.log(`[Target Scraper] Found shipping: $${shipping}`);
            }

            // Look for discounts (negative amounts or "Discounts")
            const discountMatch = allText.match(/Discounts?[:\s]*-?\$(\d+(?:\.\d{2})?)/i);
            if (discountMatch) {
                discounts = parseFloat(discountMatch[1]);
                console.log(`[Target Scraper] Found discounts: -$${discounts}`);
            }

            const totalMatch = allText.match(/(?:^|\n)\s*Total[:\s]*\$(\d+(?:\.\d{2})?)/im);
            if (totalMatch) {
                total = parseFloat(totalMatch[1]);
                console.log(`[Target Scraper] Found order total: $${total}`);
            }

            // Distribute shipping and discounts across items proportionally
            const itemSubtotal = items.reduce((sum, i) => sum + i.price, 0);
            console.log(`[Target Scraper] Item subtotal from prices: $${itemSubtotal}`);

            // If we couldn't find individual prices but have subtotal, distribute subtotal first
            const itemsWithoutPrice = items.filter(i => i.price === 0);
            if (itemsWithoutPrice.length === items.length && subtotal > 0) {
                // No prices found - distribute subtotal evenly
                const basePrice = subtotal / items.length;
                console.log(`[Target Scraper] No item prices found. Distributing subtotal $${subtotal} evenly: $${basePrice.toFixed(2)} each`);
                for (const item of items) {
                    item.price = basePrice;
                }
            }

            // Now add shipping and subtract discounts
            const updatedItemSubtotal = items.reduce((sum, i) => sum + i.price, 0);

            if (items.length > 0 && updatedItemSubtotal > 0) {
                // Calculate per-item adjustments
                const shippingPerItem = shipping > 0 ? shipping / items.length : 0;

                for (const item of items) {
                    const originalPrice = item.price;

                    // Add shipping share
                    if (shipping > 0) {
                        item.price += shippingPerItem;
                    }

                    // Subtract discount share (proportionally based on item price)
                    if (discounts > 0 && updatedItemSubtotal > 0) {
                        const discountShare = (originalPrice / updatedItemSubtotal) * discounts;
                        item.price -= discountShare;
                    }

                    // Round to 2 decimal places
                    item.price = Math.round(item.price * 100) / 100;

                    if (shipping > 0 || discounts > 0) {
                        console.log(`[Target Scraper] Final price "${item.name.substring(0, 30)}...": base($${originalPrice.toFixed(2)}) + shipping($${shippingPerItem.toFixed(2)}) - discount = $${item.price}`);
                    }
                }
            }

            // Last resort: if still no prices and we have total, use total
            const stillWithoutPrice = items.filter(i => i.price === 0);
            if (stillWithoutPrice.length > 0 && total > 0 && items.length === stillWithoutPrice.length) {
                const avgPrice = total / items.length;
                console.log(`[Target Scraper] Using total as fallback. Distributing $${total} across ${items.length} items: ~$${avgPrice.toFixed(2)} each`);
                for (const item of items) {
                    item.price = Math.round(avgPrice * 100) / 100;
                }
            }

            // Extract the actual order date from the page
            let orderDate = new Date().toISOString();
            const dateMatch = allText.match(/(?:Placed|Ordered|Order placed)[:\s]*([A-Za-z]+\s+\d{1,2},?\s*\d{4})/i);
            if (dateMatch) {
                try {
                    orderDate = new Date(dateMatch[1]).toISOString();
                    console.log(`[Target Scraper] Found order date: ${orderDate}`);
                } catch (e) {
                    console.log('[Target Scraper] Could not parse order date, using today');
                }
            } else {
                // Try another pattern - look for date near order ID
                const datePattern2 = allText.match(/(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2},?\s*\d{4}/i);
                if (datePattern2) {
                    try {
                        orderDate = new Date(datePattern2[0]).toISOString();
                        console.log(`[Target Scraper] Found order date (pattern 2): ${orderDate}`);
                    } catch (e) {
                        console.log('[Target Scraper] Could not parse date pattern 2');
                    }
                }
            }

            const order = {
                store: 'target',
                orderId: orderId,
                date: orderDate,
                total: total,
                subtotal: subtotal,
                shipping: shipping,
                discounts: discounts,
                items: items,
                url: window.location.href
            };

            if (items.length > 0) {
                await window.StorageManager.addStoreReceipt(order);

                chrome.runtime.sendMessage({
                    action: 'receiptScraped',
                    store: 'target',
                    order: order
                });

                this.updateBanner(`Scraped order with ${items.length} items! (Subtotal: $${subtotal}, Shipping: $${shipping}, Discounts: -$${discounts})`);

                // Check if there are more orders to process
                await this.checkAndContinueAutoOpen();
            } else {
                this.updateBanner(`Could not find items on this page. Try scrolling down.`);
            }
        },

        // Extract store category from Target's own classification
        extractStoreCategory(itemEl, itemName) {
            // Target often shows department info
            const deptEl = itemEl.querySelector('[data-test="department"], [class*="department"], [class*="category"], [class*="Department"]');

            if (deptEl) {
                const rawCategory = deptEl.textContent.trim();
                console.log(`[Target Scraper] Found department: "${rawCategory}"`);

                const dept = rawCategory.toLowerCase();

                if (dept.includes('health') || dept.includes('pharmacy') || dept.includes('medicine')) {
                    return { storeCategory: rawCategory, category: 'Health' };
                }
                if (dept.includes('beauty') || dept.includes('personal care')) {
                    return { storeCategory: rawCategory, category: 'Personal' };
                }
                if (dept.includes('grocery') || dept.includes('food') || dept.includes('pantry') || dept.includes('beverage')) {
                    return { storeCategory: rawCategory, category: 'Food and Household' };
                }
                if (dept.includes('household') || dept.includes('cleaning') || dept.includes('paper')) {
                    return { storeCategory: rawCategory, category: 'Food and Household' };
                }
                if (dept.includes('baby')) {
                    return { storeCategory: rawCategory, category: 'Baby' };
                }
                if (dept.includes('pet')) {
                    return { storeCategory: rawCategory, category: 'Pet' };
                }
                if (dept.includes('electronics') || dept.includes('toys') || dept.includes('entertainment')) {
                    return { storeCategory: rawCategory, category: 'Entertainment' };
                }
                if (dept.includes('clothing') || dept.includes('apparel') || dept.includes('shoes')) {
                    return { storeCategory: rawCategory, category: 'Clothing' };
                }

                return { storeCategory: rawCategory, category: null };
            }

            // Fall back to keyword detection
            const keywordCategory = this.detectCategory(itemName);
            return { storeCategory: null, category: keywordCategory };
        },

        parsePrice(text) {
            if (!text) return 0;
            const match = text.match(/\$?([\d,]+\.?\d*)/);
            return match ? parseFloat(match[1].replace(',', '')) : 0;
        },

        parseDate(text) {
            if (!text) return new Date().toISOString();
            try {
                return new Date(text).toISOString();
            } catch {
                return new Date().toISOString();
            }
        },

        // Detect category from product name
        detectCategory(name) {
            const nameLower = name.toLowerCase();

            // Health items
            if (/vitamin|supplement|medicine|tylenol|advil|bandaid|band-aid|first aid|pharmacy|rx|aspirin|ibuprofen|allergy|cold|flu|cough|pain relief/.test(nameLower)) {
                return 'Health';
            }

            // Personal care
            if (/shampoo|conditioner|soap|lotion|deodorant|toothpaste|toothbrush|razor|shaving|makeup|cosmetic|beauty|hair|skin|body wash|face wash/.test(nameLower)) {
                return 'Personal';
            }

            // Household / Cleaning
            if (/cleaning|paper towel|toilet paper|tissue|trash bag|laundry|detergent|dish soap|sponge|bleach|lysol|clorox|wipe|mop|broom/.test(nameLower)) {
                return 'Food and Household';
            }

            // Electronics / Entertainment
            if (/cable|charger|battery|hdmi|usb|phone|headphone|speaker|game|toy|dvd|blu-ray|movie|nintendo|playstation|xbox/.test(nameLower)) {
                return 'Entertainment';
            }

            // Food
            if (/organic|milk|bread|egg|cheese|yogurt|meat|chicken|beef|pork|fish|vegetable|fruit|produce|cereal|snack|frozen|pizza|juice|soda|water|coffee|tea|grocery/.test(nameLower)) {
                return 'Food and Household';
            }

            // Clothing
            if (/shirt|pants|dress|shoes|sock|underwear|jacket|coat|sweater|jeans|shorts|apparel/.test(nameLower)) {
                return 'Clothing';
            }

            // Baby - only actual baby-specific items (formula, stroller, crib)
            // Note: diapers, wipes, baby food are often categorized as personal care/groceries
            if (/\bformula\b|\bstroller\b|\bcrib\b|\bpacifier\b|\binfant formula\b|\bnursing\b|\bbottle warmer\b/.test(nameLower)) {
                return 'Baby';
            }

            // Pet
            if (/dog|cat|pet food|pet treat|collar|leash/.test(nameLower)) {
                return 'Pet';
            }

            return null; // Unknown - will use default
        },

        // Validate that a name looks like a real product, not UI text
        isValidProductName(name) {
            if (!name || name.length < 5) return false;

            const nameLower = name.toLowerCase();

            // Skip Target branding/logos
            if (/target|bullseye|logo|icon|badge|banner/.test(nameLower)) return false;

            // Skip common UI elements
            if (/^(sign in|log in|create account|cart|checkout|account|help|customer service|shop|browse|search|menu|home|orders?|registry|redcard)$/i.test(name)) return false;

            // Skip navigation/action text
            if (/^(view|see|show|hide|more|less|details|expand|collapse|close|open|back|next|previous|submit|continue|proceed|view product)(\s|$)/i.test(name)) return false;

            // Skip very short generic text
            if (/^(ok|yes|no|add|buy|get|new|sale|save|free|deal)$/i.test(name)) return false;

            // Skip footer/dialog elements
            if (/^(welcome|privacy|terms|contact|about|careers|locations|store locator)$/i.test(name)) return false;

            // Skip placeholder/loading text
            if (/loading|please wait|error|unavailable/i.test(nameLower)) return false;

            return true;
        },

        updateBanner(message) {
            const banner = document.querySelector('#edb-target-banner div');
            if (banner) {
                banner.querySelector('span').textContent = `✓ ${message}`;
            }
        }
    };

    // Wait for page to load
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => TargetScraper.init());
    } else {
        TargetScraper.init();
    }
})();
