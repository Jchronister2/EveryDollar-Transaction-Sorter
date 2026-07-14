// Background Service Worker
// Coordinates between popup, content scripts, and store scrapers

console.log('[Background] Service worker loading...');

// DEBUG: Set to true to keep scraper tabs open after scraping (for debugging scrapers)
const DEBUG_NO_AUTO_CLOSE = true;

// Track active scraper tabs for auto-close
let activeScraperTabs = {};

// Store URLs for scraping
const STORE_URLS = {
    target: 'https://www.target.com/orders',
    costco: 'https://www.costco.com/myaccount/#/app/4900eb1f-0c10-4bd9-99c3-c59e6c1ecebf/ordersandpurchases',
    fredmeyer: 'https://www.fredmeyer.com/mypurchases',
    amazon: 'https://www.amazon.com/gp/css/order-history',
    walmart: 'https://www.walmart.com/orders'
};

console.log('[Background] STORE_URLS defined:', Object.keys(STORE_URLS));

// Listen for installation
chrome.runtime.onInstalled.addListener(async (details) => {
    console.log('EveryDollar Auto-Budget installed:', details.reason);

    // Initialize storage on install
    if (details.reason === 'install') {
        // Storage will be initialized by content script when it loads
        console.log('Extension installed successfully');
    }
});

// Listen for messages from content scripts and popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log('[Background] Received message:', message.action);

    // Handle openStoreTab synchronously with promise
    if (message.action === 'openStoreTab') {
        console.log('[Background] Handling openStoreTab for:', message.store);
        openStoreTab(message.store, message.targetDates)
            .then(() => {
                console.log('[Background] openStoreTab succeeded');
                sendResponse({ success: true });
            })
            .catch((error) => {
                console.error('[Background] openStoreTab failed:', error);
                sendResponse({ success: false, error: error.message });
            });
        return true; // Keep channel open for async response
    }

    // Handle other messages
    handleMessage(message, sender, sendResponse);
    return true; // Keep channel open for async response
});

async function handleMessage(message, sender, sendResponse) {
    console.log('[Background] handleMessage:', message.action);

    switch (message.action) {
        case 'receiptsScraped':
            // Receipt data was scraped from a store
            console.log(`Scraped ${message.count} receipts from ${message.store}`);

            // Notify the EveryDollar tab to refresh (use wildcard to match both www and non-www)
            const edTabs = await chrome.tabs.query({ url: '*://*.everydollar.com/*' });
            console.log(`[Background] Found ${edTabs.length} EveryDollar tabs to notify`);
            for (const tab of edTabs) {
                chrome.tabs.sendMessage(tab.id, {
                    action: 'receiptsUpdated',
                    store: message.store,
                    count: message.count
                }).catch((e) => console.log(`[Background] Failed to notify tab ${tab.id}:`, e.message));
            }
            sendResponse({ success: true });
            break;

        case 'receiptScraped':
            // Single receipt scraped - forward to EveryDollar for real-time updates
            console.log(`[Background] Scraped receipt from ${message.store}:`, message.order);
            const edTabsRT = await chrome.tabs.query({ url: '*://*.everydollar.com/*' });
            for (const tab of edTabsRT) {
                chrome.tabs.sendMessage(tab.id, {
                    action: 'receiptsUpdated',
                    store: message.store,
                    count: 1
                }).catch(() => { });
            }
            sendResponse({ success: true });
            break;

        case 'scrapeComplete':
            // Scraping is fully complete - close tab and refocus EveryDollar
            console.log(`[Background] Scrape complete for ${message.store}, closing tab...`);
            await handleScrapeComplete(message.store, sender.tab?.id);
            sendResponse({ success: true });
            break;

        case 'matchReceipts':
            // Match receipts to transactions
            const matches = await matchReceiptsToTransactions(message.transactions);
            sendResponse({ matches });
            break;

        case 'getStorageStats':
            const stats = await getStorageStats();
            sendResponse(stats);
            break;

        case 'exportData':
            const data = await exportAllData();
            sendResponse({ data });
            break;

        case 'exportEverything':
            const everything = await exportEverything();
            sendResponse(everything);
            break;

        case 'importData':
            const result = await importData(message.data);
            sendResponse(result);
            break;

        default:
            sendResponse({ error: 'Unknown action' });
    }
}

// Open a store tab for scraping
async function openStoreTab(store, targetDates) {
    console.log(`[Background] openStoreTab called for: ${store}`);
    let url = STORE_URLS[store];
    if (!url) {
        console.error(`[Background] Unknown store: ${store}`);
        throw new Error(`Unknown store: ${store}`);
    }

    // For Amazon, construct a targeted URL using timeFilter for the right year
    if (store === 'amazon' && targetDates && targetDates.length > 0) {
        // Find the oldest target date to determine which year to filter
        const years = targetDates.map(d => new Date(d).getFullYear()).filter(y => !isNaN(y));
        if (years.length > 0) {
            const targetYear = Math.min(...years);
            url = `https://www.amazon.com/your-orders/orders?timeFilter=year-${targetYear}`;
            console.log(`[Background] Amazon: targeting year ${targetYear} based on ${targetDates.length} transaction dates`);
        }
    }

    console.log(`[Background] Opening URL: ${url}`);

    // Set scraping mode flag BEFORE opening tab so content script knows to auto-scrape
    // Store as a map of stores to support multiple concurrent scrapers
    const { scrapingMode } = await chrome.storage.local.get('scrapingMode') || {};
    const activeStores = scrapingMode?.stores || {};
    activeStores[store] = { active: true, timestamp: Date.now() };
    // Store target dates for the Amazon scraper to use
    if (store === 'amazon' && targetDates) {
        activeStores[store].targetDates = targetDates;
    }
    await chrome.storage.local.set({
        scrapingMode: { stores: activeStores }
    });
    console.log(`[Background] Set scraping mode for: ${store}, active stores:`, Object.keys(activeStores));

    // Check if tab already exists with the EXACT URL (not subpages)
    // Use broader query first, then filter for exact match
    const existingTabs = await chrome.tabs.query({ url: `${url}*` });
    const exactMatch = existingTabs.find(tab => tab.url === url);
    console.log(`[Background] Found ${existingTabs.length} tabs matching URL pattern, ${exactMatch ? '1 exact match' : 'no exact match'}`);

    let tabId;
    if (exactMatch) {
        // Exact URL match - focus and reload
        tabId = exactMatch.id;
        console.log(`[Background] Focusing exact match tab: ${tabId}`);
        try {
            await retryTabOperation(async () => {
                await chrome.tabs.update(tabId, { active: true });
                await chrome.windows.update(exactMatch.windowId, { focused: true });
            });
            // Reload the tab to trigger scraping with the new flag
            await chrome.tabs.reload(tabId);
        } catch (e) {
            console.log(`[Background] Could not focus existing tab, opening new one:`, e.message);
            tabId = null;
        }
    } else if (existingTabs.length > 0) {
        // Found a related tab (e.g., detail page) - navigate it to the correct URL
        tabId = existingTabs[0].id;
        console.log(`[Background] Found related tab at ${existingTabs[0].url}, navigating to: ${url}`);
        try {
            await retryTabOperation(async () => {
                await chrome.tabs.update(tabId, { active: true, url: url });
                await chrome.windows.update(existingTabs[0].windowId, { focused: true });
            });
        } catch (e) {
            console.log(`[Background] Could not update existing tab, opening new one:`, e.message);
            tabId = null;
        }
    }

    if (!tabId) {
        // Open new tab
        console.log(`[Background] Creating new tab for: ${url}`);
        const newTab = await chrome.tabs.create({ url, active: true });
        tabId = newTab.id;
        console.log(`[Background] Created tab: ${tabId}`);
    }

    // Track this tab for auto-close
    activeScraperTabs[store] = tabId;
    console.log(`[Background] Tracking scraper tab for ${store}: ${tabId}`);
}

// Helper to retry tab operations (Chrome throws if user is dragging a tab)
async function retryTabOperation(operation, maxRetries = 3, delayMs = 200) {
    for (let i = 0; i < maxRetries; i++) {
        try {
            return await operation();
        } catch (e) {
            if (e.message?.includes('dragging') && i < maxRetries - 1) {
                console.log(`[Background] Tab operation failed (attempt ${i + 1}), retrying...`);
                await new Promise(r => setTimeout(r, delayMs));
            } else {
                throw e;
            }
        }
    }
}

// Handle scrape completion - close tab and refocus EveryDollar
async function handleScrapeComplete(store, senderTabId) {
    console.log(`[Background] handleScrapeComplete for ${store}, sender tab: ${senderTabId}`);

    // Notify EveryDollar tab that scraping is complete (important for deep learning)
    const edTabs = await chrome.tabs.query({ url: '*://*.everydollar.com/*' });
    console.log(`[Background] Notifying ${edTabs.length} EveryDollar tabs of scrapeComplete for ${store}`);
    for (const tab of edTabs) {
        chrome.tabs.sendMessage(tab.id, {
            action: 'receiptsUpdated',
            store: store,
            count: 0,  // We don't know count here, but this triggers completion tracking
            scrapeComplete: true
        }).catch((e) => console.log(`[Background] Failed to notify tab ${tab.id}:`, e.message));
    }

    // Clear scraping mode flag for this specific store
    const { scrapingMode } = await chrome.storage.local.get('scrapingMode') || {};
    if (scrapingMode?.stores?.[store]) {
        delete scrapingMode.stores[store];
        await chrome.storage.local.set({ scrapingMode });
        console.log(`[Background] Cleared scraping mode for ${store}, remaining:`, Object.keys(scrapingMode.stores || {}));
    } else {
        // Old format - just remove it
        await chrome.storage.local.remove('scrapingMode');
        console.log(`[Background] Cleared scraping mode flag`);
    }

    // Close the scraper tab (unless debug mode is on)
    if (DEBUG_NO_AUTO_CLOSE) {
        console.log(`[Background] DEBUG_NO_AUTO_CLOSE is true, keeping tab open`);
    } else {
        const tabId = senderTabId || activeScraperTabs[store];
        if (tabId) {
            try {
                await retryTabOperation(() => chrome.tabs.remove(tabId));
                console.log(`[Background] Closed scraper tab: ${tabId}`);
            } catch (e) {
                console.log(`[Background] Could not close tab ${tabId}:`, e.message);
            }
            delete activeScraperTabs[store];
        }
    }

    // Refocus EveryDollar tab (unless debug mode is on)
    if (DEBUG_NO_AUTO_CLOSE) {
        console.log(`[Background] DEBUG_NO_AUTO_CLOSE is true, skipping EveryDollar refocus`);
    } else {
        const edTabs = await chrome.tabs.query({ url: '*://*.everydollar.com/*' });
        if (edTabs.length > 0) {
            try {
                await retryTabOperation(async () => {
                    await chrome.tabs.update(edTabs[0].id, { active: true });
                    await chrome.windows.update(edTabs[0].windowId, { focused: true });
                });
                console.log(`[Background] Refocused EveryDollar tab: ${edTabs[0].id}`);
            } catch (e) {
                console.log(`[Background] Could not refocus EveryDollar tab:`, e.message);
            }
        }
    }

    // Notify EveryDollar to refresh (always do this regardless of debug mode)
    const edTabsRefresh = await chrome.tabs.query({ url: '*://*.everydollar.com/*' });
    if (edTabsRefresh.length > 0) {
        chrome.tabs.sendMessage(edTabsRefresh[0].id, {
            action: 'receiptsUpdated',
            store: store,
            autoRefresh: true
        }).catch(() => { });
    }
}

// Match receipts to EveryDollar transactions
async function matchReceiptsToTransactions(transactions) {
    const receipts = await chrome.storage.sync.get('storeReceipts')
        .then(r => r.storeReceipts || [])
        .catch(() => chrome.storage.local.get('storeReceipts').then(r => r.storeReceipts || []));

    const matches = [];

    for (const tx of transactions) {
        const txDate = new Date(tx.date);
        const txAmount = Math.abs(parseFloat(tx.amount));

        // Find matching receipt
        for (const receipt of receipts) {
            const receiptDate = new Date(receipt.date);
            const daysDiff = Math.abs((txDate - receiptDate) / (1000 * 60 * 60 * 24));
            const amountDiff = Math.abs(receipt.total - txAmount);

            // Match criteria: within 3 days and within $0.50
            if (daysDiff <= 3 && amountDiff < 0.50) {
                // Check if store name matches transaction
                const storeName = receipt.store.toLowerCase();
                const txName = tx.name.toLowerCase();

                const storeMatches =
                    (storeName === 'target' && txName.includes('target')) ||
                    (storeName === 'costco' && txName.includes('costco')) ||
                    (storeName === 'fredmeyer' && (txName.includes('fred') || txName.includes('meyer') || txName.includes('kroger')));

                if (storeMatches || amountDiff < 0.02) {
                    matches.push({
                        transaction: tx,
                        receipt: receipt,
                        confidence: storeMatches ? 0.95 : 0.8
                    });
                    break;
                }
            }
        }
    }

    return matches;
}

// Get storage statistics
async function getStorageStats() {
    const syncUsage = await chrome.storage.sync.getBytesInUse();
    const localUsage = await chrome.storage.local.getBytesInUse();

    const syncData = await chrome.storage.sync.get(null);
    const localData = await chrome.storage.local.get(null);

    return {
        sync: {
            bytesUsed: syncUsage,
            bytesLimit: 102400, // 100KB
            percentUsed: Math.round((syncUsage / 102400) * 100),
            keys: Object.keys(syncData)
        },
        local: {
            bytesUsed: localUsage,
            bytesLimit: 5242880, // 5MB
            percentUsed: Math.round((localUsage / 5242880) * 100),
            keys: Object.keys(localData)
        }
    };
}

// Export all data as JSON
async function exportAllData() {
    const syncData = await chrome.storage.sync.get(null);
    const localData = await chrome.storage.local.get(null);

    return JSON.stringify({
        sync: syncData,
        local: localData,
        exportedAt: new Date().toISOString(),
        version: '1.3.1'
    }, null, 2);
}

async function exportEverything() {
    const storageExport = JSON.parse(await exportAllData());
    const allTabs = await chrome.tabs.query({});
    const everyDollarTabs = allTabs.filter(tab => {
        try {
            const url = new URL(tab.url || '');
            return url.hostname === 'everydollar.com' || url.hostname.endsWith('.everydollar.com');
        } catch (e) {
            return false;
        }
    });

    const contentExports = [];
    for (const tab of everyDollarTabs) {
        try {
            const response = await chrome.tabs.sendMessage(tab.id, { action: 'exportEverything' });
            contentExports.push({
                tab: summarizeTab(tab),
                success: true,
                response
            });
        } catch (error) {
            contentExports.push({
                tab: summarizeTab(tab),
                success: false,
                error: error.message
            });
        }
    }

    return {
        success: true,
        exportedAt: new Date().toISOString(),
        manifest: chrome.runtime.getManifest(),
        extensionId: chrome.runtime.id,
        storage: storageExport,
        tabs: allTabs.map(summarizeTab),
        everyDollarTabs: everyDollarTabs.map(summarizeTab),
        everyDollarContentExports: contentExports
    };
}

function summarizeTab(tab) {
    return {
        id: tab.id,
        windowId: tab.windowId,
        active: tab.active,
        title: tab.title,
        url: tab.url,
        status: tab.status
    };
}

// Import data from JSON
async function importData(jsonString) {
    try {
        const data = JSON.parse(jsonString);

        if (data.sync) {
            await chrome.storage.sync.set(data.sync);
        }
        if (data.local) {
            await chrome.storage.local.set(data.local);
        }

        return { success: true };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

// Set up context menu for quick actions (only if API is available)
if (chrome.contextMenus) {
    chrome.runtime.onInstalled.addListener(() => {
        chrome.contextMenus.create({
            id: 'edb-learn-transaction',
            title: 'Learn this transaction',
            contexts: ['selection'],
            documentUrlPatterns: ['*://everydollar.com/*', '*://www.everydollar.com/*']
        });

        chrome.contextMenus.create({
            id: 'edb-rename-transaction',
            title: 'Rename this transaction',
            contexts: ['selection'],
            documentUrlPatterns: ['*://everydollar.com/*', '*://www.everydollar.com/*']
        });
    });

    chrome.contextMenus.onClicked.addListener((info, tab) => {
        if (info.menuItemId === 'edb-learn-transaction') {
            chrome.tabs.sendMessage(tab.id, {
                action: 'learnSelection',
                selection: info.selectionText
            });
        } else if (info.menuItemId === 'edb-rename-transaction') {
            chrome.tabs.sendMessage(tab.id, {
                action: 'renameSelection',
                selection: info.selectionText
            });
        }
    });
}

// Keep service worker alive (for manifest v3)
if (chrome.alarms) {
    chrome.alarms.create('keepAlive', { periodInMinutes: 1 });
    chrome.alarms.onAlarm.addListener((alarm) => {
        if (alarm.name === 'keepAlive') {
            console.log('[Background] Service worker ping');
        }
    });
}

console.log('[Background] Service worker fully loaded!');
