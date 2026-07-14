// EveryDollar Content Script
// Handles transaction scraping, UI injection, and auto-categorization

(async function () {
    'use strict';

    // Wait for StorageManager and Categorizer to be available
    await new Promise(resolve => setTimeout(resolve, 500));
    await StorageManager.init();

    const EDB = {
        // State
        transactions: [],
        categories: [],
        suggestions: new Map(),
        isProcessing: false,
        currentBudgetMonth: null,
        isSyncingMonth: false,  // Guard flag to prevent recursive observer triggers during month sync
        pendingLearning: [],  // Items to learn when Apply is clicked
        editedSplits: new Map(),  // txId -> edited categorization (also persisted to storage)
        _isAutoLearningInProgress: false,  // Guard: prevents observers from firing during auto-learn tab switching
        _isLoadingMonths: false,  // Guard: prevents observer-triggered pipeline runs during month loading
        _isBackgroundRefreshing: false,  // Guard: prevents ALL observer-triggered pipeline runs during background refresh
        _receiptPromptDismissed: false,    // Session flag: user dismissed the receipt fetch prompt

        // Initialize the extension
        async init() {
            // Load persisted edited splits from storage
            await this.loadEditedSplits();

            // Sync displayed month to URL FIRST (before waiting for transactions)
            // EveryDollar's SPA sometimes ignores the URL and shows the current month
            await this.syncMonthToUrl();
            this.extractBudgetMonth(); // fallback if sync skipped

            // Wait for the app to load - try multiple selectors
            const transactionSelectors = [
                '[data-testid="transaction_collection"]',
                '.ui-app-transaction-collection',
                '[class*="TransactionList"]',
                '[class*="transaction-list"]',
                '[data-testid="transactions"]',
                'main [class*="Transaction"]'
            ];

            let foundElement = false;
            for (const selector of transactionSelectors) {
                try {
                    await this.waitForElement(selector, 3000);
                    foundElement = true;
                    break;
                } catch (e) {
                    // Try next selector
                }
            }

            if (!foundElement) {
                // Still inject UI and set up observers - user may navigate to transactions later
            }

            // Extract budget categories from page
            await this.extractCategories();

            // Inject our UI
            this.injectUI();

            // Set up mutation observer for dynamic content
            this.observeChanges();

            // Set up navigation observer to detect when user navigates to transactions
            this.observeNavigation();

            // Listen for messages from popup/background
            chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
                this.handleMessage(msg, sendResponse);
                return true; // Keep channel open for async response
            });

            // Try cached transactions first for instant load, then background refresh
            const loadStart = performance.now();
            const usedCache = await this.tryLoadFromCache();
            if (usedCache) {
                const cacheTime = performance.now() - loadStart;
                await this.processTransactionPipeline();
                const totalTime = performance.now() - loadStart;
                console.log(`[EDB Timer] Cache hit: ${(cacheTime / 1000).toFixed(1)}s | Pipeline: ${((totalTime - cacheTime) / 1000).toFixed(1)}s | Total: ${(totalTime / 1000).toFixed(1)}s`);

                // Background refresh: full scan, re-run pipeline only if data changed
                this.backgroundRefreshTransactions(loadStart);
            } else {
                // No cache — do full scan (first visit to this month)
                await this.scanTransactions();
                const scanTime = performance.now() - loadStart;
                await this.processTransactionPipeline();
                const totalTime = performance.now() - loadStart;
                console.log(`[EDB Timer] Full scan: ${(scanTime / 1000).toFixed(1)}s | Pipeline: ${((totalTime - scanTime) / 1000).toFixed(1)}s | Total: ${(totalTime / 1000).toFixed(1)}s`);
                // Cache the results for next time
                await this.cacheTransactions();
            }

            // Then check if deep learning is needed (runs once per 24h)
            await this.checkAndRunAutoLearning();

        },

        // Load persisted edited splits from storage
        async loadEditedSplits() {
            try {
                const saved = await StorageManager.get(StorageManager.KEYS.EDITED_SPLITS) || {};

                // One-time cleanup: remove stale skippedReceipt flags that weren't confirmed
                let cleaned = false;
                for (const [key, value] of Object.entries(saved)) {
                    if (value.skippedReceipt && !value.confirmed) {
                        delete saved[key];
                        cleaned = true;
                    }
                }
                if (cleaned) {
                    await StorageManager.set(StorageManager.KEYS.EDITED_SPLITS, saved);
                }

                this.editedSplits = new Map(Object.entries(saved));
                if (this.editedSplits.size > 0) {
                    // Log each split with its confirmed status
                    for (const [key, data] of this.editedSplits.entries()) {
                    }
                }
            } catch (e) {
                console.error('[EDB] Failed to load edited splits:', e);
                this.editedSplits = new Map();
            }
        },

        // Save edited splits to storage
        async saveEditedSplits() {
            try {
                const obj = Object.fromEntries(this.editedSplits);
                await StorageManager.set(StorageManager.KEYS.EDITED_SPLITS, obj);
            } catch (e) {
                console.error('[EDB] Failed to save edited splits:', e);
            }
        },

        // --- Transaction Cache: instant load from previous scan ---

        // Try to load cached transactions for the current budget month
        async tryLoadFromCache() {
            if (!this.currentBudgetMonth) return false;
            try {
                const cache = await StorageManager.get(StorageManager.KEYS.TX_CACHE) || {};
                const entry = cache[this.currentBudgetMonth];
                if (!entry || !entry.transactions || entry.transactions.length === 0) return false;

                // Cache is valid — restore transactions and suggestions
                this.transactions = entry.transactions;
                this.suggestions.clear();
                if (entry.suggestions) {
                    // Restore cached suggestions (skip re-analysis)
                    for (const [id, suggestion] of Object.entries(entry.suggestions)) {
                        this.suggestions.set(id, suggestion);
                    }
                } else {
                    // Old cache format without suggestions — re-analyze
                    for (const tx of this.transactions) {
                        const suggestion = await Categorizer.analyze(tx);
                        if (suggestion) this.suggestions.set(tx.id, suggestion);
                    }
                }
                this.updateBadge(this.transactions.length);
                console.log(`[EDB Cache] Loaded ${this.transactions.length} cached transactions for ${this.currentBudgetMonth} (cached ${Math.round((Date.now() - entry.timestamp) / 60000)}m ago, suggestions: ${entry.suggestions ? 'cached' : 're-analyzed'})`);
                return true;
            } catch (e) {
                console.error('[EDB Cache] Failed to load cache:', e);
                return false;
            }
        },

        // Save current transactions to cache for the current budget month
        async cacheTransactions() {
            if (!this.currentBudgetMonth || this.transactions.length === 0) return;
            try {
                const cache = await StorageManager.get(StorageManager.KEYS.TX_CACHE) || {};
                // Store only serializable fields (no DOM element references)
                // Cache suggestions too (avoids re-running Categorizer.analyze on 856 txs)
                const suggestionsObj = {};
                for (const [id, suggestion] of this.suggestions) {
                    suggestionsObj[id] = suggestion;
                }
                cache[this.currentBudgetMonth] = {
                    transactions: this.transactions.map(tx => ({
                        id: tx.id,
                        name: tx.name,
                        amount: tx.amount,
                        date: tx.date,
                        account: tx.account || ''
                    })),
                    suggestions: suggestionsObj,
                    timestamp: Date.now(),
                    count: this.transactions.length
                };
                // Prune old months — keep only 6 most recent entries
                const months = Object.keys(cache).sort().reverse();
                if (months.length > 6) {
                    for (const old of months.slice(6)) delete cache[old];
                }
                await StorageManager.set(StorageManager.KEYS.TX_CACHE, cache);
                console.log(`[EDB Cache] Saved ${this.transactions.length} transactions for ${this.currentBudgetMonth}`);
            } catch (e) {
                console.error('[EDB Cache] Failed to save cache:', e);
            }
        },

        // Background refresh: full scan, update pipeline only if data changed
        async backgroundRefreshTransactions(loadStart) {
            console.log('[EDB Cache] Starting background refresh...');
            this._isBackgroundRefreshing = true;
            const bgStart = performance.now();

            try {
                // Save the cached transaction IDs for comparison
                const cachedIds = new Set(this.transactions.map(tx => tx.id));
                const cachedCount = cachedIds.size;

                // Do the full scan (loads months, clicks buttons, etc.)
                await this.scanTransactions();
                const scanTime = performance.now() - bgStart;

                // Compare: did the scan find different transactions?
                const newIds = new Set(this.transactions.map(tx => tx.id));
                const added = [...newIds].filter(id => !cachedIds.has(id)).length;
                const removed = [...cachedIds].filter(id => !newIds.has(id)).length;
                const changed = added > 0 || removed > 0;

                if (changed) {
                    console.log(`[EDB Cache] Background refresh found changes: +${added} -${removed} (was ${cachedCount}, now ${newIds.size}). Re-running pipeline.`);
                    await this.processTransactionPipeline();
                } else {
                    console.log(`[EDB Cache] Background refresh: no changes (${newIds.size} transactions)`);
                }

                // Update cache with fresh data
                await this.cacheTransactions();

                const totalBg = performance.now() - bgStart;
                const totalFromStart = performance.now() - loadStart;
                console.log(`[EDB Timer] Background refresh: ${(scanTime / 1000).toFixed(1)}s scan, ${(totalBg / 1000).toFixed(1)}s total (${(totalFromStart / 1000).toFixed(1)}s from page load)`);
            } finally {
                this._isBackgroundRefreshing = false;
            }
        },

        // Remove a transaction from edited splits (after applying)
        async removeEditedSplit(txId) {
            this.editedSplits.delete(txId);
            await this.saveEditedSplits();
        },

        // Reset a split's confirmed flag to move it back to Review Splits
        async resetSplitConfirmation(txId) {
            const editData = this.editedSplits.get(txId);
            if (editData) {
                editData.confirmed = false;
                await this.saveEditedSplits();
                await this.processTransactionPipeline();
            }
        },

        // Check if auto-learn WILL run (without running it) — used to skip initial scan
        async willAutoLearnRun() {
            if (this._isAutoLearningInProgress) return false;
            const lastScan = await StorageManager.get(StorageManager.KEYS.LAST_LEARNING_SCAN);
            const now = Date.now();
            const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;
            return !lastScan || (now - lastScan >= TWENTY_FOUR_HOURS_MS);
        },

        // Auto-learn from ALL tracked transactions on page load (24-hour cooldown)
        async checkAndRunAutoLearning() {
            try {
                const lastScan = await StorageManager.get(StorageManager.KEYS.LAST_LEARNING_SCAN);
                const now = Date.now();
                const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

                // Skip if learned within the last 24 hours
                if (lastScan && (now - lastScan < TWENTY_FOUR_HOURS_MS)) {
                    const hoursAgo = Math.round((now - lastScan) / 3600000);
                    console.log(`[EDB Auto-Learn] Skipping — last scan was ${hoursAgo}h ago (cooldown: 24h)`);
                    return;
                }

                // Skip if already in progress
                if (this._isAutoLearningInProgress) {
                    console.log('[EDB Auto-Learn] Skipping — already in progress');
                    return;
                }

                this._isAutoLearningInProgress = true;
                console.log('[EDB Auto-Learn] Starting silent deep-learn from ALL tracked months...');

                try {
                    await this.runSilentDeepLearning();
                } finally {
                    this._isAutoLearningInProgress = false;
                    // Always re-run pipeline after learn (success or failure)
                    // so stages don't stay hidden/empty
                    const pipelineEl = document.querySelector('.edb-pipeline');
                    if (pipelineEl) pipelineEl.classList.remove('edb-hidden');
                    await this.processTransactionPipeline();
                }
            } catch (e) {
                console.error('[EDB Auto-Learn] Error:', e);
                this._isAutoLearningInProgress = false;
                // Ensure pipeline is visible even on error
                const pipelineEl = document.querySelector('.edb-pipeline');
                if (pipelineEl) pipelineEl.classList.remove('edb-hidden');
                await this.processTransactionPipeline();
            }
        },

        // Show/update/hide the learning progress banner in the panel
        updateLearningBanner(message, phase = null) {
            let banner = document.getElementById('edb-learning-banner');
            if (!message) {
                banner?.remove();
                return;
            }
            if (!banner) {
                banner = document.createElement('div');
                banner.id = 'edb-learning-banner';
                const statusEl = document.getElementById('edb-status');
                if (statusEl) {
                    statusEl.after(banner);
                } else {
                    const content = document.getElementById('edb-content');
                    content?.prepend(banner);
                }
            }
            const dots = phase ? '.' .repeat((phase % 3) + 1) : '...';
            banner.innerHTML = `<div class="edb-learning-banner-inner">
                <span class="edb-learning-spinner"></span>
                <span>${message}${dots}</span>
            </div>`;
        },

        // Silent deep-learn: runs automatically on page load with progress banner
        async runSilentDeepLearning() {
            const startTime = Date.now();
            const fab = document.getElementById('edb-fab');
            fab?.classList.add('edb-learning-pulse');
            this.updateLearningBanner('🔍 Scanning tracked transactions', 0);

            try {
                // Phase 1: Switch to Tracked tab
                const trackedTab = document.querySelector('[data-testid="allocated"], [data-testid="TransactionTab"]:nth-child(2), .TransactionsTabs-tab:nth-child(2)');
                if (!trackedTab) {
                    console.log('[EDB Silent-Learn] No tracked tab found, skipping');
                    return;
                }

                const wasOnNewTab = !trackedTab.classList.contains('active') && !trackedTab.getAttribute('aria-selected')?.includes('true');
                if (wasOnNewTab) {
                    trackedTab.click();
                    await new Promise(r => setTimeout(r, 1000));
                }

                // Phase 2: Load ALL months (up to 50 clicks)
                let loadAttempts = 0;
                while (loadAttempts < 50) {
                    const loadButton = document.querySelector('.TransactionFetcher-action, [data-testid="LoadTransactions"], button[class*="TransactionFetcher"]');
                    if (!loadButton) break;
                    loadButton.click();
                    loadAttempts++;
                    if (loadAttempts % 5 === 0) {
                        this.updateLearningBanner(`📅 Loading transaction history (${loadAttempts} months)`, loadAttempts);
                    }
                    await new Promise(r => setTimeout(r, 1500));
                }
                console.log(`[EDB Silent-Learn] Loaded ${loadAttempts} months of tracked transactions`);
                this.updateLearningBanner('📜 Scrolling through all transactions', 1);

                // Phase 3: Scroll to load all visible cards
                const scrollableEl = this.findScrollableContainer();
                if (scrollableEl) {
                    let lastHeight = 0;
                    let scrollAttempts = 0;
                    while (scrollAttempts < 100) {
                        scrollableEl.scrollTop += 3000;
                        await new Promise(r => setTimeout(r, 150));
                        if (scrollableEl.scrollTop === lastHeight) break;
                        lastHeight = scrollableEl.scrollTop;
                        scrollAttempts++;
                    }
                    scrollableEl.scrollTop = 0;
                    await new Promise(r => setTimeout(r, 300));
                }

                this.updateLearningBanner('🧠 Learning merchant rules from history', 2);

                // Phase 4: Parse all tracked cards (same logic as learnFromAllTrackedTransactions)
                const trackedCards = document.querySelectorAll('.TransactionCard');
                const merchantCategoryPairs = new Map();
                const individualTransactions = [];

                for (const card of trackedCards) {
                    const parsed = this.parseTrackedCard(card);
                    if (parsed && parsed.merchant && parsed.categories.length > 0) {
                        for (const category of parsed.categories) {
                            if (category.includes(',') || /\b(20\d{2}|19\d{2})\b/.test(category) || category.length > 40) continue;
                            const key = `${parsed.merchant}|||${category}`;
                            if (!merchantCategoryPairs.has(key)) {
                                merchantCategoryPairs.set(key, { merchant: parsed.merchant, category, count: 1 });
                            } else {
                                merchantCategoryPairs.get(key).count++;
                            }

                            // Collect individual transaction for learnedTransactions
                            if (parsed.amount) {
                                individualTransactions.push({
                                    name: parsed.merchant,
                                    amount: parsed.amount,
                                    date: parsed.date || '',
                                    category: category,
                                    source: 'auto-deep-learn',
                                    learnedAt: new Date().toISOString()
                                });
                            }
                        }
                    }
                }

                // Phase 5: Save merchant rules + keywords
                const existingRules = await StorageManager.get(StorageManager.KEYS.MERCHANT_RULES) || {};
                const keywordBatch = [];
                const now = new Date().toISOString();
                let newMerchants = 0;

                for (const [key, data] of merchantCategoryPairs) {
                    const normalizedMerchant = StorageManager.normalizeMerchantName(data.merchant);
                    if (!normalizedMerchant) continue;

                    if (!existingRules[normalizedMerchant]) {
                        existingRules[normalizedMerchant] = {
                            category: data.category, count: data.count,
                            firstSeen: now, lastSeen: now, source: 'auto-deep-learn'
                        };
                        newMerchants++;
                    } else if (existingRules[normalizedMerchant].category === data.category) {
                        existingRules[normalizedMerchant].count = (existingRules[normalizedMerchant].count || 1) + data.count;
                        existingRules[normalizedMerchant].lastSeen = now;
                    }

                    const tokens = StorageManager.extractKeywords(data.merchant);
                    if (tokens.length > 0) {
                        keywordBatch.push({ text: data.merchant, category: data.category, tokens });
                    }
                }

                await StorageManager.set(StorageManager.KEYS.MERCHANT_RULES, existingRules);
                if (keywordBatch.length > 0) {
                    await StorageManager.batchLearnKeywords(keywordBatch);
                }

                // Also save individual transactions for return-to-purchase matching
                if (individualTransactions.length > 0) {
                    const existingLearned = await StorageManager.get(StorageManager.KEYS.LEARNED_TRANSACTIONS) || [];
                    // De-duplicate by name+amount+date
                    const existingKeys = new Set(existingLearned.map(l => `${l.name}|${l.amount}|${l.date}`));
                    let newCount = 0;
                    for (const tx of individualTransactions) {
                        const key = `${tx.name}|${tx.amount}|${tx.date}`;
                        if (!existingKeys.has(key)) {
                            existingLearned.push(tx);
                            existingKeys.add(key);
                            newCount++;
                        }
                    }
                    // Keep last 1000 to prevent bloat
                    while (existingLearned.length > 1000) existingLearned.shift();
                    await StorageManager.set(StorageManager.KEYS.LEARNED_TRANSACTIONS, existingLearned);
                    console.log(`[EDB Silent-Learn] Saved ${newCount} new individual transactions (${existingLearned.length} total) for return matching`);
                }

                this.updateLearningBanner(`✅ Learned ${Object.keys(existingRules).length} merchant rules — processing receipts`, 3);

                // Phase 6: Also learn tokens from stored receipts
                try {
                    const receipts = await StorageManager.get(StorageManager.KEYS.STORE_RECEIPTS) || [];
                    if (receipts.length > 0) {
                        await this.learnAllTokens(receipts);
                    }
                } catch (e) {
                    console.warn('[EDB Silent-Learn] Token learning from receipts failed:', e);
                }

                // Phase 7: Save timestamp
                await StorageManager.set(StorageManager.KEYS.LAST_LEARNING_SCAN, Date.now());

                this.updateLearningBanner('🔄 Categorizing your transactions', 4);

                // Phase 8: Switch back to New tab and re-process
                if (wasOnNewTab) {
                    const newTab = document.querySelector('[data-testid="new-tab"], [data-testid="unallocated"], .TransactionsTabs-tab:first-child');
                    if (newTab) {
                        newTab.click();
                        await new Promise(r => setTimeout(r, 500));
                    }
                    await this.scanTransactions();
                }

                const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
                const totalRules = Object.keys(existingRules).length;
                console.log(`[EDB Silent-Learn] Complete in ${elapsed}s — ${newMerchants} new rules, ${totalRules} total, ${trackedCards.length} tracked transactions parsed`);

            } finally {
                this._isAutoLearningInProgress = false; // Ensure cleared even on error
                fab?.classList.remove('edb-learning-pulse');
                this.updateLearningBanner(null); // Remove banner
            }
        },

        // Deep learning: comprehensive scan of ALL receipts and ALL tracked transactions
        // Order matters:
        // 0. (Optional) Fetch fresh receipts from all stores
        // 1. Load receipts (item data for matching)
        // 2. Load tracked transactions (merchant → category mappings)
        // 3. Learn tokens (from both receipts and merchants)
        // 4. Re-analyze current transactions and auto-categorize
        async runDeepLearning(options = {}) {
            const { fetchReceipts = true } = options;  // Fetch receipts by default
            const startTime = Date.now();
            let stats = { merchants: 0, items: 0, tokens: 0, receipts: 0, autoReady: 0, storesFetched: 0 };

            // Hide welcome state if showing, show pipeline
            const welcomeEl = document.getElementById('edb-welcome');
            const pipelineEl = document.querySelector('.edb-pipeline');
            if (welcomeEl) welcomeEl.classList.add('edb-hidden');
            if (pipelineEl) pipelineEl.classList.remove('edb-hidden');

            // Show progress indicator
            this.showDeepLearningProgress(fetchReceipts ? 5 : 4);

            try {
                // ===== PHASE 0: Fetch fresh receipts from all stores =====
                if (fetchReceipts) {
                    this.updateDeepLearningProgress(1, 'Fetching receipts from stores...');
                    this.updateStatus('📚 Step 1/5: Fetching receipts from stores...');
                    const storeStats = await this.fetchAllStoresAndWait();
                    stats.storesFetched = storeStats.storesOpened;

                    // Give a moment for final receipts to save
                    await new Promise(r => setTimeout(r, 2000));
                }

                // ===== PHASE 1: Load all stored receipts =====
                // This gives us item-level data for receipt matching
                const step1Num = fetchReceipts ? 2 : 1;
                this.updateDeepLearningProgress(step1Num, 'Loading stored receipts...');
                this.updateStatus(`📚 Step ${step1Num}/${fetchReceipts ? 5 : 4}: Loading stored receipts...`);
                const receipts = await StorageManager.get(StorageManager.KEYS.STORE_RECEIPTS) || [];
                stats.receipts = receipts.length;

                // ===== PHASE 2: Learn from ALL tracked EveryDollar transactions =====
                // This builds merchant → category rules
                const step2Num = fetchReceipts ? 3 : 2;
                this.updateDeepLearningProgress(step2Num, 'Learning from tracked transactions...');
                this.updateStatus(`📚 Step ${step2Num}/${fetchReceipts ? 5 : 4}: Learning from tracked transactions...`);
                const txStats = await this.learnFromAllTrackedTransactions();
                stats.merchants = txStats.merchants;
                stats.totalRules = txStats.totalRules || 0;
                stats.transactionCount = txStats.transactionCount || 0;

                // ===== PHASE 3: Learn token associations =====
                // Extract tokens from receipt items AND merchant names
                const step3Num = fetchReceipts ? 4 : 3;
                this.updateDeepLearningProgress(step3Num, 'Learning token associations...');
                this.updateStatus(`📚 Step ${step3Num}/${fetchReceipts ? 5 : 4}: Learning token associations...`);
                const tokenStats = await this.learnAllTokens(receipts);
                stats.items = tokenStats.items;
                stats.tokens = tokenStats.tokens;

                // ===== PHASE 4: Re-analyze current transactions =====
                // Apply all learned knowledge to current month's New transactions
                const step4Num = fetchReceipts ? 5 : 4;
                this.updateDeepLearningProgress(step4Num, 'Auto-categorizing current transactions...');
                this.updateStatus(`📚 Step ${step4Num}/${fetchReceipts ? 5 : 4}: Auto-categorizing current transactions...`);
                await this.scanTransactions();  // Re-scan with new knowledge
                const autoStats = await this.processTransactionPipeline();  // Route to appropriate stages
                stats.autoReady = autoStats?.ready || 0;

                // Save scan timestamp
                await StorageManager.set(StorageManager.KEYS.LAST_LEARNING_SCAN, Date.now());

                const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

                // Hide progress indicator
                this.hideDeepLearningProgress();

                // Show detailed stats panel (persists until user clicks away)
                this.showDeepLearningStats(stats, elapsed);

                // Refresh the knowledge panel to show new data
                await this.showKnowledgePanel(true);

                // Store last deep learning results for later viewing
                await StorageManager.set('lastDeepLearnStats', {
                    ...stats,
                    elapsed,
                    timestamp: Date.now()
                });

                return stats;
            } catch (e) {
                console.error('[EDB Deep-Learn] Error:', e);
                this.hideDeepLearningProgress();
                this.updateStatus('❌ Deep learning failed - check console');
                throw e;
            }
        },

        // Learn token associations from all receipts (batched to avoid rate limiting)
        async learnAllTokens(receipts) {
            let itemCount = 0;
            let tokenCount = 0;
            const keywordBatch = [];  // Collect all keywords to save at once

            // Learn from receipt items
            for (const receipt of receipts) {
                if (!receipt.items || !Array.isArray(receipt.items)) continue;

                for (const item of receipt.items) {
                    let category = item.category;
                    if (!category || category === 'Uncategorized') {
                        // Use store's default category mapping
                        category = await StorageManager.getMappedCategory(item.category) ||
                                   StorageManager.STORE_CATEGORY_MAP[receipt.store?.toLowerCase()] ||
                                   'Food and Household';
                    }

                    if (category && category !== 'Uncategorized' && item.name) {
                        const tokens = StorageManager.extractKeywords(item.name);
                        if (tokens.length > 0) {
                            keywordBatch.push({ text: item.name, category, tokens });
                            tokenCount += tokens.length;
                            itemCount++;
                        }
                    }
                }
            }

            // Batch save all keywords at once to avoid rate limiting
            if (keywordBatch.length > 0) {
                await StorageManager.batchLearnKeywords(keywordBatch);
            }

            return { items: itemCount, tokens: tokenCount };
        },

        // Display deep learning stats in a prominent panel
        showDeepLearningStats(stats, elapsed) {

            // Remove any existing stats panel
            document.getElementById('edb-deep-learn-results')?.remove();

            const storesFetchedRow = stats.storesFetched ? `
                <div class="edb-stat-row">
                    <span class="edb-stat-label">Stores fetched:</span>
                    <span class="edb-stat-value">${stats.storesFetched}</span>
                </div>` : '';

            // Create a prominent results panel
            const panel = document.createElement('div');
            panel.id = 'edb-deep-learn-results';
            panel.innerHTML = `
                <div class="edb-deep-stats-modal">
                    <div class="edb-deep-stats-header">
                        <span>✅ Deep Learning Complete!</span>
                        <button class="edb-stats-dismiss" title="Dismiss">×</button>
                    </div>
                    <div class="edb-deep-stats-time">Completed in ${elapsed}s</div>
                    <div class="edb-deep-stats-grid">
                        ${storesFetchedRow}
                        <div class="edb-stat-row">
                            <span class="edb-stat-label">Transactions scanned:</span>
                            <span class="edb-stat-value">${stats.transactionCount || 0}</span>
                        </div>
                        <div class="edb-stat-row">
                            <span class="edb-stat-label">Receipts loaded:</span>
                            <span class="edb-stat-value">${stats.receipts || 0}</span>
                        </div>
                        <div class="edb-stat-row">
                            <span class="edb-stat-label">Merchant rules:</span>
                            <span class="edb-stat-value">${stats.totalRules || 0} total (${stats.merchants || 0} new)</span>
                        </div>
                        <div class="edb-stat-row">
                            <span class="edb-stat-label">Token associations:</span>
                            <span class="edb-stat-value">${stats.tokens || 0}</span>
                        </div>
                        <div class="edb-stat-row edb-stat-highlight">
                            <span class="edb-stat-label">Ready to apply:</span>
                            <span class="edb-stat-value">${stats.autoReady || 0}</span>
                        </div>
                    </div>
                </div>
            `;

            // Insert BEFORE the panel content (but inside the panel) so it survives pipeline refreshes
            // The panel element is #edb-panel, content is #edb-content
            const panelEl = document.getElementById('edb-panel');
            const contentEl = document.getElementById('edb-content');

            if (panelEl && contentEl) {
                // Insert the stats panel right before the content div, inside the main panel
                panelEl.insertBefore(panel, contentEl);
            } else if (contentEl) {
                // Fallback: insert at top of content
                contentEl.insertBefore(panel, contentEl.firstChild);
            } else {
                console.error('[EDB Deep-Learn] Could not find panel or content element!');
            }

            // Add dismiss handler
            panel.querySelector('.edb-stats-dismiss')?.addEventListener('click', () => {
                panel.remove();
            });

            // Also update status briefly
            this.updateStatus('✅ Deep learning complete! See results above.');
        },

        // Show deep learning progress indicator
        showDeepLearningProgress(totalSteps) {
            // Remove any existing progress indicator
            document.getElementById('edb-deep-learn-progress')?.remove();

            const progress = document.createElement('div');
            progress.id = 'edb-deep-learn-progress';
            progress.innerHTML = `
                <div class="edb-progress-modal">
                    <div class="edb-progress-header">
                        <span class="edb-progress-spinner">⏳</span>
                        <span>Deep Learning in Progress...</span>
                    </div>
                    <div class="edb-progress-bar-container">
                        <div class="edb-progress-bar" style="width: 0%"></div>
                    </div>
                    <div class="edb-progress-step">Starting...</div>
                    <div class="edb-progress-substatus"></div>
                </div>
            `;

            // Store total steps for progress calculation
            progress.dataset.totalSteps = totalSteps;

            // Insert before content
            const panelEl = document.getElementById('edb-panel');
            const contentEl = document.getElementById('edb-content');
            if (panelEl && contentEl) {
                panelEl.insertBefore(progress, contentEl);
            }
        },

        // Update deep learning progress
        updateDeepLearningProgress(step, message, substatus = '') {
            const progress = document.getElementById('edb-deep-learn-progress');
            if (!progress) return;

            const totalSteps = parseInt(progress.dataset.totalSteps) || 5;
            const percent = Math.round((step / totalSteps) * 100);

            const bar = progress.querySelector('.edb-progress-bar');
            const stepEl = progress.querySelector('.edb-progress-step');
            const substatusEl = progress.querySelector('.edb-progress-substatus');

            if (bar) bar.style.width = `${percent}%`;
            if (stepEl) stepEl.textContent = `Step ${step}/${totalSteps}: ${message}`;
            if (substatusEl) substatusEl.textContent = substatus;
        },

        // Hide deep learning progress
        hideDeepLearningProgress() {
            document.getElementById('edb-deep-learn-progress')?.remove();
        },

        // Learn from ALL tracked transactions - load until no more available
        async learnFromAllTrackedTransactions() {
            // Switch to Tracked tab
            const trackedTab = document.querySelector('[data-testid="allocated"], [data-testid="TransactionTab"]:nth-child(2), .TransactionsTabs-tab:nth-child(2)');
            if (!trackedTab) {
                return { merchants: 0, tokens: 0 };
            }

            const wasOnNewTab = !trackedTab.classList.contains('active') && !trackedTab.getAttribute('aria-selected')?.includes('true');
            if (wasOnNewTab) {
                trackedTab.click();
                await new Promise(r => setTimeout(r, 1000));
            }

            // Load ALL available transactions (keep clicking until no more)
            let loadAttempts = 0;
            const maxAttempts = 50;  // Safety limit
            while (loadAttempts < maxAttempts) {
                const loadButton = document.querySelector('.TransactionFetcher-action, [data-testid="LoadTransactions"], button[class*="TransactionFetcher"]');
                if (!loadButton) break;

                loadButton.click();
                loadAttempts++;
                await new Promise(r => setTimeout(r, 1500));

                // Update status periodically
                if (loadAttempts % 5 === 0) {
                    this.updateStatus(`📚 Loading transactions... (${loadAttempts} months loaded)`);
                }
            }

            // Scroll to load all visible cards
            const scrollableEl = this.findScrollableContainer();
            if (scrollableEl) {
                let lastHeight = 0;
                let scrollAttempts = 0;
                while (scrollAttempts < 100) {  // Safety limit
                    scrollableEl.scrollTop += 3000;
                    await new Promise(r => setTimeout(r, 150));
                    if (scrollableEl.scrollTop === lastHeight) break;
                    lastHeight = scrollableEl.scrollTop;
                    scrollAttempts++;
                }
                scrollableEl.scrollTop = 0;
                await new Promise(r => setTimeout(r, 300));
            }

            // Parse all tracked cards
            const trackedCards = document.querySelectorAll('.TransactionCard');

            const merchantCategoryPairs = new Map();
            const allDates = [];  // Track dates for stats
            const individualTransactions = [];

            for (const card of trackedCards) {
                const parsed = this.parseTrackedCard(card);
                if (parsed && parsed.merchant && parsed.categories.length > 0) {
                    // Track date for stats (add current year context)
                    if (parsed.date) {
                        allDates.push(parsed.date);
                    }

                    for (const category of parsed.categories) {
                        // Skip bad categories:
                        // 1. Multiple comma-separated categories (split transactions)
                        // 2. Categories with years in them (likely budget item names)
                        // 3. Very long category names (likely user-specific item names)
                        if (category.includes(',')) {
                            continue;
                        }
                        if (/\b(20\d{2}|19\d{2})\b/.test(category)) {
                            continue;
                        }
                        if (category.length > 40) {
                            continue;
                        }

                        const key = `${parsed.merchant}|||${category}`;
                        if (!merchantCategoryPairs.has(key)) {
                            merchantCategoryPairs.set(key, { merchant: parsed.merchant, category, count: 1 });
                        } else {
                            merchantCategoryPairs.get(key).count++;
                        }

                        // Collect individual transaction for return matching
                        if (parsed.amount) {
                            individualTransactions.push({
                                name: parsed.merchant,
                                amount: parsed.amount,
                                date: parsed.date || '',
                                category: category,
                                source: 'deep-learn',
                                learnedAt: new Date().toISOString()
                            });
                        }
                    }
                }
            }

            // Save merchant rules - BATCH keyword collection to avoid rate limiting
            const existingRules = await StorageManager.get(StorageManager.KEYS.MERCHANT_RULES) || {};
            const keywordBatch = [];  // Collect all keywords to save at once
            const now = new Date().toISOString();
            let newMerchants = 0;
            let tokenCount = 0;

            for (const [key, data] of merchantCategoryPairs) {
                const normalizedMerchant = StorageManager.normalizeMerchantName(data.merchant);
                if (!normalizedMerchant) continue;

                // Save/update merchant rule
                if (!existingRules[normalizedMerchant]) {
                    existingRules[normalizedMerchant] = {
                        category: data.category,
                        count: data.count,
                        firstSeen: now,
                        lastSeen: now,
                        source: 'deep-learn'
                    };
                    newMerchants++;
                } else if (existingRules[normalizedMerchant].category === data.category) {
                    existingRules[normalizedMerchant].count = (existingRules[normalizedMerchant].count || 1) + data.count;
                    existingRules[normalizedMerchant].lastSeen = now;
                }

                // Collect keywords for batch save (don't call learnKeywords individually)
                const tokens = StorageManager.extractKeywords(data.merchant);
                if (tokens.length > 0) {
                    keywordBatch.push({ text: data.merchant, category: data.category, tokens });
                    tokenCount += tokens.length;
                }
            }

            await StorageManager.set(StorageManager.KEYS.MERCHANT_RULES, existingRules);

            // Batch save all keywords at once to avoid rate limiting
            if (keywordBatch.length > 0) {
                await StorageManager.batchLearnKeywords(keywordBatch);
            }

            // Save individual transactions for return-to-purchase matching
            if (individualTransactions.length > 0) {
                const existingLearned = await StorageManager.get(StorageManager.KEYS.LEARNED_TRANSACTIONS) || [];
                const existingKeys = new Set(existingLearned.map(l => `${l.name}|${l.amount}|${l.date}`));
                let newTxCount = 0;
                for (const tx of individualTransactions) {
                    const key = `${tx.name}|${tx.amount}|${tx.date}`;
                    if (!existingKeys.has(key)) {
                        existingLearned.push(tx);
                        existingKeys.add(key);
                        newTxCount++;
                    }
                }
                while (existingLearned.length > 1000) existingLearned.shift();
                await StorageManager.set(StorageManager.KEYS.LEARNED_TRANSACTIONS, existingLearned);
                console.log(`[EDB Deep-Learn] Saved ${newTxCount} individual transactions (${existingLearned.length} total) for return matching`);
            }

            // Switch back to New tab
            if (wasOnNewTab) {
                const newTab = document.querySelector('[data-testid="new-tab"], [data-testid="unallocated"], .TransactionsTabs-tab:first-child');
                if (newTab) {
                    newTab.click();
                    await new Promise(r => setTimeout(r, 500));
                }
                await this.scanTransactions();
            }

            const totalRules = Object.keys(existingRules).length;
            return {
                merchants: newMerchants,
                totalRules,
                tokens: tokenCount,
                transactionCount: trackedCards.length,
                validPairs: merchantCategoryPairs.size
            };
        },

        // Run learning from tracked transactions in background (less intrusive than manual scan)
        async runBackgroundLearning() {
            const startTime = Date.now();

            try {
                // Step 1: Switch to Tracked tab
                const trackedTab = document.querySelector('[data-testid="allocated"], [data-testid="TransactionTab"]:nth-child(2), .TransactionsTabs-tab:nth-child(2)');
                if (!trackedTab) {
                    return;
                }

                // Remember current tab to restore later
                const wasOnNewTab = !trackedTab.classList.contains('active') && !trackedTab.getAttribute('aria-selected')?.includes('true');

                if (wasOnNewTab) {
                    trackedTab.click();
                    await new Promise(r => setTimeout(r, 1000));
                }

                // Step 2: Load a few months of transactions (not the full 12 months)
                const maxMonthsToLoad = 3;  // Less aggressive than manual scan
                for (let i = 0; i < maxMonthsToLoad; i++) {
                    const loadButton = document.querySelector('.TransactionFetcher-action, [data-testid="LoadTransactions"], button[class*="TransactionFetcher"]');
                    if (loadButton) {
                        loadButton.click();
                        await new Promise(r => setTimeout(r, 1500));
                    } else {
                        break;
                    }
                }

                // Step 3: Quick scroll to load visible transactions
                const scrollableEl = this.findScrollableContainer();
                if (scrollableEl) {
                    // Quick scroll - just a few iterations
                    for (let i = 0; i < 10; i++) {
                        scrollableEl.scrollTop += 2000;
                        await new Promise(r => setTimeout(r, 200));
                    }
                    scrollableEl.scrollTop = 0;
                    await new Promise(r => setTimeout(r, 300));
                }

                // Step 4: Parse tracked cards
                const trackedCards = document.querySelectorAll('.TransactionCard');

                const merchantCategoryPairs = new Map();
                for (const card of trackedCards) {
                    const parsed = this.parseTrackedCard(card);
                    if (parsed && parsed.merchant && parsed.categories.length > 0) {
                        for (const category of parsed.categories) {
                            const key = `${parsed.merchant}|||${category}`;
                            if (!merchantCategoryPairs.has(key)) {
                                merchantCategoryPairs.set(key, { merchant: parsed.merchant, category, count: 1 });
                            } else {
                                merchantCategoryPairs.get(key).count++;
                            }
                        }
                    }
                }

                // Step 5: Save to storage
                const existingRules = await StorageManager.get(StorageManager.KEYS.MERCHANT_RULES) || {};
                const now = new Date().toISOString();
                let newRulesCount = 0;

                for (const [key, data] of merchantCategoryPairs) {
                    const normalizedMerchant = StorageManager.normalizeMerchantName(data.merchant);
                    if (!normalizedMerchant) continue;

                    if (!existingRules[normalizedMerchant]) {
                        existingRules[normalizedMerchant] = {
                            category: data.category,
                            count: data.count,
                            firstSeen: now,
                            lastSeen: now,
                            source: 'auto-learn'
                        };
                        newRulesCount++;
                    } else if (existingRules[normalizedMerchant].category === data.category) {
                        existingRules[normalizedMerchant].count = (existingRules[normalizedMerchant].count || 1) + data.count;
                        existingRules[normalizedMerchant].lastSeen = now;
                    }
                }

                await StorageManager.set(StorageManager.KEYS.MERCHANT_RULES, existingRules);
                await StorageManager.set(StorageManager.KEYS.LAST_LEARNING_SCAN, Date.now());

                const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

                // Step 6: Switch back to New tab if we were there
                if (wasOnNewTab) {
                    const newTab = document.querySelector('[data-testid="new-tab"], [data-testid="unallocated"], .TransactionsTabs-tab:first-child');
                    if (newTab) {
                        newTab.click();
                        await new Promise(r => setTimeout(r, 500));
                    }

                    // IMPORTANT: Rescan transactions on New tab before processing pipeline
                    // Without this, this.transactions would still be empty from the Tracked tab scan
                    await this.scanTransactions();
                }

                // Update status only if we learned something
                if (newRulesCount > 0) {
                    this.updateStatus(`📚 Learned ${newRulesCount} new merchant rules!`);
                    // Refresh pipeline to apply new rules
                    await this.processTransactionPipeline();
                } else if (wasOnNewTab) {
                    // Even if no new rules, refresh pipeline after switching back to show transactions
                    await this.processTransactionPipeline();
                }

            } catch (e) {
                console.error('[EDB Auto-Learn] Error during background learning:', e);
            }
        },

        // Find a scrollable container for transactions
        findScrollableContainer() {
            const scrollSelectors = [
                '.TransactionDrawer-tabContent',
                '.TransactionDrawer-content',
                '[class*="TransactionDrawer"]',
                '.ui-app-transaction-collection',
                '[data-testid="transaction_collection"]'
            ];

            for (const selector of scrollSelectors) {
                const el = document.querySelector(selector);
                if (el) {
                    const styles = window.getComputedStyle(el);
                    if (styles.overflowY === 'auto' || styles.overflowY === 'scroll' || el.scrollHeight > el.clientHeight) {
                        return el;
                    }
                    if (el.parentElement) {
                        const parentStyles = window.getComputedStyle(el.parentElement);
                        if (parentStyles.overflowY === 'auto' || parentStyles.overflowY === 'scroll' || el.parentElement.scrollHeight > el.parentElement.clientHeight) {
                            return el.parentElement;
                        }
                    }
                }
            }

            // Fallback: find ancestor of transaction card
            const card = document.querySelector('.TransactionCard');
            if (card) {
                let parent = card.parentElement;
                for (let i = 0; i < 10 && parent; i++) {
                    if (parent.scrollHeight > parent.clientHeight + 100) {
                        return parent;
                    }
                    parent = parent.parentElement;
                }
            }

            return null;
        },

        // Wait for an element to appear
        waitForElement(selector, timeout = 10000) {
            return new Promise((resolve, reject) => {
                const element = document.querySelector(selector);
                if (element) {
                    resolve(element);
                    return;
                }

                const observer = new MutationObserver((mutations, obs) => {
                    const el = document.querySelector(selector);
                    if (el) {
                        obs.disconnect();
                        resolve(el);
                    }
                });

                observer.observe(document.body, { childList: true, subtree: true });

                setTimeout(() => {
                    observer.disconnect();
                    reject(new Error(`Timeout waiting for ${selector}`));
                }, timeout);
            });
        },

        // Extract budget month from the URL path
        // Returns "YYYY-MM" string or null if URL doesn't contain budget month
        getMonthFromUrl() {
            const match = window.location.pathname.match(/\/app\/budget\/(\d{4})\/(\d{2})/);
            if (match) {
                return `${match[1]}-${match[2]}`;
            }
            return null;
        },

        // Ensure the displayed month matches the URL month
        // EveryDollar's SPA sometimes ignores the URL and shows the current month
        async syncMonthToUrl() {
            const urlMonth = this.getMonthFromUrl();
            if (!urlMonth) return;
            if (this.isSyncingMonth) return;

            this.isSyncingMonth = true;
            let hiddenEl = null;
            try {

                // Wait for the h1 to be available
                try {
                    await this.waitForElement('h1', 2000);
                } catch (e) {
                    return;
                }

                this.extractBudgetMonth();
                if (!this.currentBudgetMonth) return;
                if (this.currentBudgetMonth === urlMonth) {
                    return;
                }


                // Hide the budget area so user never sees the wrong month
                const h1 = document.querySelector('h1');
                hiddenEl = h1?.closest('[class*="stage"]') || h1?.closest('[class*="budget"]') || h1?.parentElement?.parentElement;
                if (hiddenEl) hiddenEl.style.opacity = '0';

                // Calculate direction and number of clicks needed
                const [urlYear, urlMo] = urlMonth.split('-').map(Number);
                const [domYear, domMo] = this.currentBudgetMonth.split('-').map(Number);
                const diff = (urlYear * 12 + urlMo) - (domYear * 12 + domMo);

                if (Math.abs(diff) > 24) {
                    return;
                }

                const buttonLabel = diff < 0 ? 'Previous Month' : 'Next Month';
                const clicks = Math.abs(diff);

                for (let i = 0; i < clicks; i++) {
                    const button = [...document.querySelectorAll('button')]
                        .find(btn => btn.textContent.trim().includes(buttonLabel) ||
                                     btn.getAttribute('aria-label') === buttonLabel);

                    if (!button) {
                        return;
                    }

                    // Read from live DOM (not cached h1 which may become detached after React re-render)
                    const previousH1Text = document.querySelector('h1')?.textContent || '';
                    button.click();

                    // Wait for h1 to show a different parseable month (not just any DOM change)
                    await new Promise(resolve => {
                        const checkMonth = () => {
                            const h1Text = document.querySelector('h1')?.textContent || '';
                            const match = h1Text.match(/(\w+)\s+(\d{4})/);
                            return match && h1Text !== previousH1Text;
                        };
                        // Check immediately in case it already changed
                        if (checkMonth()) { resolve(); return; }
                        const mo = new MutationObserver(() => {
                            if (checkMonth()) {
                                mo.disconnect();
                                resolve();
                            }
                        });
                        mo.observe(document.body, { childList: true, subtree: true, characterData: true });
                        setTimeout(() => { mo.disconnect(); resolve(); }, 3000); // safety timeout
                    });

                }

                // Wait for target month to appear in h1 (SPA may take time to re-render)
                const [tgtYear, tgtMo] = urlMonth.split('-').map(Number);
                const monthNames = ['january', 'february', 'march', 'april', 'may', 'june',
                    'july', 'august', 'september', 'october', 'november', 'december'];
                const targetMonthName = monthNames[tgtMo - 1];
                for (let poll = 0; poll < 20; poll++) {
                    const h1Now = document.querySelector('h1')?.textContent?.toLowerCase() || '';
                    if (h1Now.includes(targetMonthName) && h1Now.includes(String(tgtYear))) break;
                    await new Promise(r => setTimeout(r, 150));
                }

                this.extractBudgetMonth();
            } finally {
                if (hiddenEl) hiddenEl.style.opacity = '';
                this.isSyncingMonth = false;
            }
        },

        // Update the browser URL to reflect the currently displayed budget month
        updateUrlForMonth(month) {
            if (!month || this.isSyncingMonth) return;
            const [year, mo] = month.split('-');
            const newPath = `/app/budget/${year}/${mo}`;
            if (window.location.pathname !== newPath) {
                history.replaceState(null, '', newPath);
                // Update tracked URL so urlObserver doesn't re-trigger
                this._lastTrackedUrl = location.href;
                this._lastUrlUpdateTime = Date.now();
            }
        },

        // Extract budget month from the page
        extractBudgetMonth() {
            const monthHeader = document.querySelector('h1, [class*="month"]');
            if (monthHeader) {
                const text = monthHeader.textContent;
                const match = text.match(/(\w+)\s+(\d{4})/);
                if (match) {
                    const monthNames = ['january', 'february', 'march', 'april', 'may', 'june',
                        'july', 'august', 'september', 'october', 'november', 'december'];
                    const monthIndex = monthNames.indexOf(match[1].toLowerCase());
                    if (monthIndex !== -1) {
                        const newMonth = `${match[2]}-${String(monthIndex + 1).padStart(2, '0')}`;
                        // If month changed, keep URL in sync (unless we're mid-sync)
                        if (this.currentBudgetMonth && newMonth !== this.currentBudgetMonth && !this.isSyncingMonth) {
                            this.currentBudgetMonth = newMonth;
                            this.updateUrlForMonth(newMonth);
                        } else {
                            this.currentBudgetMonth = newMonth;
                        }
                    }
                }
            }
        },

        // Inject our UI elements
        injectUI() {
            // Create floating action button container
            const container = document.createElement('div');
            container.id = 'edb-container';
            container.innerHTML = `
        <div id="edb-fab" title="EveryDollar Auto-Budget">
          <span id="edb-badge">0</span>
          <svg viewBox="0 0 100 100" width="32" height="32">
            <path fill="#fff" opacity="0.9" d="M50 15c-8 0-25 2-40 20l35 10s15-22 45-20l-40-10z"/>
            <path fill="#fff" opacity="0.7" d="M90 30c-25 0-45 25-45 25l-30-8 3 7 27 9s20-30 45-31v-2z"/>
            <path fill="#fff" opacity="0.5" d="M88 35c-22 2-44 35-44 35l-26-10 3 6 22 9c16-26 32-38 44-40h1z"/>
            <rect x="35" y="52" width="30" height="28" rx="5" fill="#fff"/>
            <circle cx="43" cy="64" r="4" fill="#2e7d32"/>
            <circle cx="57" cy="64" r="4" fill="#2e7d32"/>
            <line x1="50" y1="52" x2="50" y2="44" stroke="#fff" stroke-width="2"/>
            <circle cx="50" cy="42" r="3" fill="#fff"/>
            <rect x="42" y="72" width="16" height="4" rx="1" fill="#2e7d32"/>
          </svg>
        </div>
        <div id="edb-panel" class="edb-hidden">
          <div id="edb-header">
            <h3>🤖 Auto-Budget</h3>
            <div class="edb-header-buttons">
              <button id="edb-rules-btn" title="Rules Manager">⚙</button>
              <button id="edb-refresh" title="Refresh & Rescan">🔄</button>
              <button id="edb-close">&times;</button>
            </div>
          </div>
          <div id="edb-content">
            <div id="edb-status"></div>

            <!-- Welcome / Onboarding (hidden once data exists) -->
            <div id="edb-welcome" class="edb-hidden">
              <div class="edb-welcome-card">
                <div class="edb-welcome-icon">🤖</div>
                <h3>Welcome to Auto-Budget!</h3>
                <p>Let's set up your extension by learning from your transaction history and fetching store receipts.</p>
                <div class="edb-welcome-steps">
                  <div class="edb-welcome-step">
                    <span class="edb-welcome-step-num">1</span>
                    <span>Scan your tracked transactions to learn category rules</span>
                  </div>
                  <div class="edb-welcome-step">
                    <span class="edb-welcome-step-num">2</span>
                    <span>Fetch receipts from Target, Amazon, Costco, Walmart, Fred Meyer</span>
                  </div>
                  <div class="edb-welcome-step">
                    <span class="edb-welcome-step-num">3</span>
                    <span>Auto-categorize your current transactions</span>
                  </div>
                </div>
                <button id="edb-welcome-start" class="edb-btn edb-btn-primary edb-btn-lg edb-welcome-btn">
                  🚀 Get Started — Run Deep Learn
                </button>
                <p class="edb-welcome-hint">This opens store sites to scrape receipts, then scans all your tracked transactions. Takes 1-3 minutes.</p>
              </div>
            </div>

            <!-- ============ TRANSACTION PIPELINE ============ -->
            <div class="edb-pipeline">

              <!-- Stage 1: Awaiting Receipt -->
              <div class="edb-pipeline-stage" id="edb-stage-awaiting">
                <div class="edb-stage-header edb-stage-waiting" data-stage="awaiting">
                  <span class="edb-stage-number">1</span>
                  <span class="edb-stage-icon">⏳</span>
                  <span class="edb-stage-title">Awaiting Receipt</span>
                  <span class="edb-stage-count" id="edb-awaiting-count">0</span>
                  <span class="edb-collapse-arrow">▼</span>
                </div>
                <div class="edb-stage-content" id="edb-awaiting-content">
                  <p class="edb-stage-desc">Store transactions need receipts for accurate categorization.</p>
                  <div class="edb-stage-actions" id="edb-awaiting-actions"></div>
                  <div class="edb-stage-list" id="edb-awaiting-list"></div>
                </div>
              </div>

              <!-- Stage 2: Categorize Items (combined - was Review Splits + Needs Category) -->
              <div class="edb-pipeline-stage" id="edb-stage-categorize">
                <div class="edb-stage-header edb-stage-categorize" data-stage="categorize">
                  <span class="edb-stage-number">2</span>
                  <span class="edb-stage-icon">🏷️</span>
                  <span class="edb-stage-title">Categorize Items</span>
                  <span class="edb-stage-count" id="edb-categorize-count">0</span>
                  <span class="edb-collapse-arrow">▼</span>
                </div>
                <div class="edb-stage-content" id="edb-categorize-content">
                  <p class="edb-stage-desc">Assign categories to receipt items.</p>
                  <div class="edb-stage-list" id="edb-categorize-list"></div>
                </div>
              </div>

              <!-- Stage 3: Ready to Apply -->
              <div class="edb-pipeline-stage" id="edb-stage-ready">
                <div class="edb-stage-header edb-stage-ready" data-stage="ready">
                  <span class="edb-stage-number">3</span>
                  <span class="edb-stage-icon">✓</span>
                  <span class="edb-stage-title">Ready to Apply</span>
                  <span class="edb-stage-count" id="edb-ready-count">0</span>
                  <span class="edb-collapse-arrow">▼</span>
                </div>
                <div class="edb-stage-content" id="edb-ready-content">
                  <p class="edb-stage-desc">Review and apply these to your budget.</p>
                  <div class="edb-stage-actions" id="edb-ready-actions">
                    <button class="edb-btn edb-btn-sm" id="edb-select-all-ready">Select All</button>
                    <button class="edb-btn edb-btn-sm" id="edb-select-none-ready">Select None</button>
                  </div>
                  <div class="edb-stage-list" id="edb-ready-list"></div>
                  <div class="edb-apply-section" id="edb-apply-section">
                    <button class="edb-btn edb-btn-primary edb-btn-lg" id="edb-apply-selected" disabled>
                      ✓ Apply Selected (<span id="edb-selected-count">0</span>)
                    </button>
                  </div>
                </div>
              </div>

            </div>
            <!-- ============ END PIPELINE ============ -->

            <!-- Debug Tools (collapsed by default) -->
            <div class="edb-collapsible-section edb-collapsed edb-debug-section" id="edb-debug-section">
              <div class="edb-section-header edb-debug-header" id="edb-debug-header">
                <span class="edb-collapse-icon">▶</span>
                <h4>🔧 Debug Tools</h4>
              </div>
              <div class="edb-section-content" id="edb-debug-content">

                <div class="edb-debug-subsection">
                  <h5>🧠 Knowledge Base <span id="edb-rules-count" class="edb-section-count">(0 rules)</span></h5>
                  <div class="edb-knowledge-actions">
                    <button id="edb-learn" class="edb-btn edb-btn-sm">📚 Quick Scan (3 mo)</button>
                    <button id="edb-deep-learn" class="edb-btn edb-btn-sm edb-btn-primary">🧠 Deep Learn (All)</button>
                  </div>
                  <p class="edb-hint">Deep Learn scans ALL stored receipts + ALL tracked transactions. Use "Fetch Receipts" first to get new receipts.</p>
                  <div id="edb-knowledge-panel"></div>
                </div>

                <div class="edb-debug-subsection edb-collapsible-subsection" id="edb-receipts-subsection">
                  <div class="edb-subsection-header" data-target="edb-receipts-content">
                    <span class="edb-collapse-icon">▶</span>
                    <h5>🛒 Store Receipts <span id="edb-receipts-count" class="edb-section-count">(0)</span></h5>
                  </div>
                  <div class="edb-subsection-content edb-collapsed" id="edb-receipts-content">
                    <div class="edb-store-buttons">
                      <button class="edb-btn edb-btn-sm edb-store-btn" data-store="target">🎯 Target</button>
                      <button class="edb-btn edb-btn-sm edb-store-btn" data-store="walmart">🏬 Walmart</button>
                      <button class="edb-btn edb-btn-sm edb-store-btn" data-store="amazon">📦 Amazon</button>
                      <button class="edb-btn edb-btn-sm edb-store-btn" data-store="costco">🛒 Costco</button>
                      <button class="edb-btn edb-btn-sm edb-store-btn" data-store="fredmeyer">🥬 Fred Meyer</button>
                    </div>
                    <div style="margin-top: 8px;">
                      <button id="edb-open-all-stores" class="edb-btn edb-btn-sm edb-btn-primary">📥 Open All Stores</button>
                    </div>
                    <div id="edb-receipts-list" class="edb-scrollable-list"></div>
                  </div>
                </div>

                <div class="edb-debug-subsection edb-collapsible-subsection" id="edb-review-subsection">
                  <div class="edb-subsection-header" data-target="edb-review-content">
                    <span class="edb-collapse-icon">▶</span>
                    <h5>❓ Uncategorizable Items <span id="edb-review-count" class="edb-section-count">(0)</span></h5>
                  </div>
                  <div class="edb-subsection-content edb-collapsed" id="edb-review-content">
                    <div id="edb-review-list"></div>
                  </div>
                </div>

                <div class="edb-debug-subsection">
                  <h5>🗑️ Clear & Reset</h5>
                  <p class="edb-hint">Use with caution - these actions cannot be undone.</p>
                  <div class="edb-clear-buttons">
                    <button id="edb-clear-knowledge" class="edb-btn edb-btn-sm edb-btn-danger">🧠 Clear Rules</button>
                    <button id="edb-clear-receipts" class="edb-btn edb-btn-sm edb-btn-danger">🧾 Clear Receipts</button>
                    <button id="edb-reset-splits" class="edb-btn edb-btn-sm edb-btn-danger">✂️ Reset Splits</button>
                    <button id="edb-reset-stage-state" class="edb-btn edb-btn-sm edb-btn-secondary">📐 Reset UI State</button>
                  </div>
                </div>

              </div>
            </div>

          </div>
        </div>
      `;

            document.body.appendChild(container);
            this.positionFab();

            // Core event listeners
            document.getElementById('edb-fab').addEventListener('click', () => this.togglePanel());
            document.getElementById('edb-close').addEventListener('click', () => this.togglePanel(false));
            document.getElementById('edb-rules-btn').addEventListener('click', () => this.openRulesManager());
            document.getElementById('edb-refresh').addEventListener('click', () => this.refreshAll());
            document.getElementById('edb-learn').addEventListener('click', () => this.learnFromTracked());
            document.getElementById('edb-deep-learn').addEventListener('click', () => this.runDeepLearning());

            // Welcome / onboarding button
            document.getElementById('edb-welcome-start')?.addEventListener('click', async () => {
                await this.runDeepLearning({ fetchReceipts: true });
            });

            // Pipeline stage collapse toggles with localStorage caching
            // Restore saved collapse state
            const savedCollapseState = JSON.parse(localStorage.getItem('edb-stage-collapse-state') || '{}');
            document.querySelectorAll('.edb-pipeline-stage').forEach(stage => {
                const stageName = stage.querySelector('.edb-stage-header')?.dataset.stage;
                // Default to collapsed, unless explicitly saved as open (true = open)
                const isCollapsed = savedCollapseState[stageName] !== true;
                stage.classList.toggle('edb-stage-collapsed', isCollapsed);
                const arrow = stage.querySelector('.edb-collapse-arrow');
                if (arrow) arrow.textContent = isCollapsed ? '▶' : '▼';
            });

            document.querySelectorAll('.edb-stage-header').forEach(header => {
                header.addEventListener('click', () => {
                    const stage = header.closest('.edb-pipeline-stage');
                    const stageName = header.dataset.stage;
                    stage.classList.toggle('edb-stage-collapsed');
                    const isCollapsed = stage.classList.contains('edb-stage-collapsed');
                    const arrow = header.querySelector('.edb-collapse-arrow');
                    if (arrow) arrow.textContent = isCollapsed ? '▶' : '▼';

                    // Save state to localStorage
                    const state = JSON.parse(localStorage.getItem('edb-stage-collapse-state') || '{}');
                    state[stageName] = !isCollapsed;  // true = open, false = collapsed
                    localStorage.setItem('edb-stage-collapse-state', JSON.stringify(state));
                });
            });

            // Debug section toggle
            document.getElementById('edb-debug-header').addEventListener('click', () => {
                this.toggleSection('edb-debug-section');
            });

            // Subsection collapse toggles (for Store Receipts and Review sections)
            document.querySelectorAll('.edb-subsection-header').forEach(header => {
                header.addEventListener('click', () => {
                    const targetId = header.dataset.target;
                    const content = document.getElementById(targetId);
                    const icon = header.querySelector('.edb-collapse-icon');
                    if (content) {
                        content.classList.toggle('edb-collapsed');
                        if (icon) icon.textContent = content.classList.contains('edb-collapsed') ? '▶' : '▼';
                    }
                });
            });

            // Store button handlers
            document.querySelectorAll('.edb-store-btn').forEach(btn => {
                btn.addEventListener('click', () => this.openStoreForScraping(btn.dataset.store));
            });

            // Open All Stores button
            document.getElementById('edb-open-all-stores')?.addEventListener('click', () => this.openAllStores());

            // Note: Fetch receipts buttons are created dynamically in renderAwaitingStage()

            // Ready stage actions
            document.getElementById('edb-select-all-ready')?.addEventListener('click', () => {
                document.querySelectorAll('#edb-ready-list .edb-ready-checkbox').forEach(cb => cb.checked = true);
                this.updateReadySelectedCount();
            });
            document.getElementById('edb-select-none-ready')?.addEventListener('click', () => {
                document.querySelectorAll('#edb-ready-list .edb-ready-checkbox').forEach(cb => cb.checked = false);
                this.updateReadySelectedCount();
            });
            document.getElementById('edb-apply-selected')?.addEventListener('click', () => this.applySelectedReady());

            // Clear & Reset buttons in Debug Tools
            document.getElementById('edb-clear-knowledge')?.addEventListener('click', async () => {
                if (confirm('Clear all learned rules? This cannot be undone.')) {
                    await StorageManager.clearLearnedData();
                    this.updateStatus('✓ All rules cleared');
                    await this.showKnowledgePanel(true);
                }
            });

            document.getElementById('edb-clear-receipts')?.addEventListener('click', async () => {
                if (confirm('Clear all stored receipts? This cannot be undone.')) {
                    await StorageManager.set(StorageManager.KEYS.STORE_RECEIPTS, []);
                    await StorageManager.set(StorageManager.KEYS.REVIEW_QUEUE, []);
                    this.updateStatus('✓ All receipts cleared');
                    await this.loadStoreReceipts();
                    await this.processTransactionPipeline();
                }
            });

            document.getElementById('edb-reset-splits')?.addEventListener('click', async () => {
                if (confirm('Reset all split edits? This will re-categorize all receipts from scratch.')) {
                    await StorageManager.set(StorageManager.KEYS.EDITED_SPLITS, {});
                    this.editedSplits.clear();
                    this.updateStatus('✓ Split edits cleared - refreshing...');
                    await this.processTransactionPipeline();
                }
            });

            document.getElementById('edb-reset-stage-state')?.addEventListener('click', () => {
                localStorage.removeItem('edb-stage-collapse-state');
                document.querySelectorAll('.edb-pipeline-stage').forEach(stage => {
                    stage.classList.add('edb-stage-collapsed');
                    const arrow = stage.querySelector('.edb-collapse-arrow');
                    if (arrow) arrow.textContent = '▶';
                });
                this.updateStatus('✓ Stage collapse state reset');
            });

            // Context menu for transactions
            this.injectRenameContextMenu();

            // Load initial data
            this.showKnowledgePanel(true);
            this.loadStoreReceipts();
            this.loadReviewQueue();
        },

        // Keep the FAB pinned in the bottom-right corner.
        positionFab() {
            const fab = document.getElementById('edb-fab');
            if (!fab) return;

            fab.style.position = 'fixed';
            fab.style.bottom = '24px';
            fab.style.right = '24px';
            fab.style.top = 'auto';
            fab.style.left = 'auto';
        },

        // Toggle a collapsible section
        toggleSection(sectionId) {
            const section = document.getElementById(sectionId);
            section.classList.toggle('edb-collapsed');
            const icon = section.querySelector('.edb-collapse-icon');
            if (section.classList.contains('edb-collapsed')) {
                icon.textContent = '▶';
            } else {
                icon.textContent = '▼';
            }
        },

        // Toggle the panel visibility
        togglePanel(show) {
            const panel = document.getElementById('edb-panel');
            if (show === undefined) {
                panel.classList.toggle('edb-hidden');
            } else {
                panel.classList.toggle('edb-hidden', !show);
            }
        },

        // Refresh all data - reload receipts and rescan transactions
        async refreshAll() {
            this.updateStatus('🔄 Refreshing...');

            // Reload store receipts
            await this.loadStoreReceipts();

            // Reload knowledge base panel
            await this.showKnowledgePanel(true);

            // Load items for review
            await this.loadReviewQueue();

            // Rescan transactions
            await this.scanTransactions();

            // Process through pipeline
            await this.processTransactionPipeline();

            this.updateStatus('✓ Refreshed!');

            // Clear status after a moment
            setTimeout(() => {
                const readyCount = document.getElementById('edb-ready-count')?.textContent || '0';
                if (readyCount === '0') {
                    this.updateStatus('No actionable transactions found.');
                }
            }, 2000);
        },

        // Load all transaction months and collect all cards
        async autoScrollToLoadTransactions(container) {
            this.extractBudgetMonth();
            this._isLoadingMonths = true;
            this.updateStatus('Loading all transactions...');

            const cardSelector = '[data-testid="unallocated_card"]';
            this._collectedTransactions = new Map(); // id → parsed transaction

            // EveryDollar loads transactions by month — newer months first.
            // Older months require clicking "Load [Month] Transactions" buttons
            // (class="TransactionFetcher") at the bottom of the list.
            // Full dates (with year) come from React props on each card element.

            const collectAllCards = () => {
                const cards = document.querySelectorAll(cardSelector);
                let newFound = 0;
                for (const card of cards) {
                    const tx = this.parseTransactionCard(card);
                    if (tx && !this._collectedTransactions.has(tx.id)) {
                        this._collectedTransactions.set(tx.id, tx);
                        newFound++;
                    }
                }
                return newFound;
            };

            // Trigger React bridge to populate data-* attributes on initial cards
            this._triggerReactBridge();
            await new Promise(r => setTimeout(r, 200)); // wait for bridge to process

            // Collect initially loaded cards
            collectAllCards();
            console.log(`[EDB Scroll] Initial cards: ${this._collectedTransactions.size}`);

            // Click "Load [Month] Transactions" buttons to fetch older months
            // Scale limit: ~2 clicks per month to reach budget month, capped at 50
            let maxLoads = 4; // default: just a few loads for current/recent month
            if (this.currentBudgetMonth) {
                const now = new Date();
                const [bmY, bmM] = this.currentBudgetMonth.split('-').map(Number);
                const monthsBack = (now.getFullYear() * 12 + now.getMonth() + 1) - (bmY * 12 + bmM);
                maxLoads = Math.min(monthsBack * 2 + 4, 50);
                console.log(`[EDB Scroll] Budget month ${this.currentBudgetMonth} is ${monthsBack} months back, maxLoads=${maxLoads}`);

                // Check if target month is already loaded before clicking any buttons
                const [bmYear0, bmMonth0] = this.currentBudgetMonth.split('-').map(Number);
                const alreadyLoaded = [...this._collectedTransactions.values()].some(tx => {
                    if (!tx.date) return false;
                    const d = new Date(tx.date);
                    return d.getFullYear() === bmYear0 && d.getMonth() + 1 === bmMonth0;
                });
                if (alreadyLoaded) {
                    console.log(`[EDB Scroll] Target month ${this.currentBudgetMonth} already loaded — skipping month loads`);
                    maxLoads = 0;
                }
            }
            let loads = 0;

            while (loads < maxLoads) {
                const loadBtn = document.querySelector('.TransactionFetcher');
                if (!loadBtn) break;

                const btnText = loadBtn.textContent?.trim() || '';
                console.log(`[EDB Scroll] Clicking: "${btnText}"`);
                this.updateStatus(`Loading: ${btnText} (${this._collectedTransactions.size} found)`);

                loadBtn.scrollIntoView({ behavior: 'instant', block: 'center' });
                const clickTarget = loadBtn.querySelector('button') || loadBtn;
                clickTarget.click();

                // Wait for cards to load — poll for new cards instead of fixed wait
                // This avoids wasting 1s on empty months (0 new cards)
                const prevSize = this._collectedTransactions.size;
                const maxWait = loads === 0 ? 1500 : 1000;
                const pollInterval = 150;
                let waited = 0;
                let newFound = 0;
                while (waited < maxWait) {
                    await new Promise(r => setTimeout(r, pollInterval));
                    waited += pollInterval;
                    this._triggerReactBridge();
                    await new Promise(r => setTimeout(r, 50));
                    newFound = collectAllCards();
                    if (newFound > 0 && waited >= 300) break; // cards loaded, done
                    if (waited >= 400 && newFound === 0) break; // empty month, stop early
                }
                console.log(`[EDB Scroll] After load: ${newFound} new, ${this._collectedTransactions.size} total (${waited}ms)`);

                loads++;

                // Safety: if we've clicked multiple load buttons but found 0 cards,
                // we're likely on the Tracked tab or cards use a different selector — stop
                if (loads >= 2 && this._collectedTransactions.size === 0) {
                    console.log('[EDB Scroll] No cards found after multiple loads — stopping');
                    break;
                }

                // If the budget month's transactions are now loaded, we can stop
                if (this.currentBudgetMonth) {
                    const [bmYear, bmMonth] = this.currentBudgetMonth.split('-').map(Number);
                    const hasTargetMonth = [...this._collectedTransactions.values()].some(tx => {
                        if (!tx.date) return false;
                        const d = new Date(tx.date);
                        return d.getFullYear() === bmYear && d.getMonth() + 1 === bmMonth;
                    });
                    if (hasTargetMonth) {
                        // Load one more to be safe (get all transactions for the target month)
                        const nextBtn = document.querySelector('.TransactionFetcher');
                        if (nextBtn) {
                            nextBtn.scrollIntoView({ behavior: 'instant', block: 'center' });
                            const nextClick = nextBtn.querySelector('button') || nextBtn;
                            nextClick.click();
                            // Quick poll — just need to grab any remaining target-month cards
                            let extraWait = 0;
                            while (extraWait < 800) {
                                await new Promise(r => setTimeout(r, 150));
                                extraWait += 150;
                                this._triggerReactBridge();
                                await new Promise(r => setTimeout(r, 50));
                                const extraFound = collectAllCards();
                                if (extraFound > 0 && extraWait >= 300) break;
                                if (extraWait >= 400 && extraFound === 0) break;
                            }
                        }
                        console.log(`[EDB Scroll] Target month ${this.currentBudgetMonth} loaded — stopping`);
                        break;
                    }
                }
            }

            this._isLoadingMonths = false;
            console.log(`[EDB Scroll] Collected ${this._collectedTransactions.size} transactions after ${loads} month loads`);

            // Scroll back to top
            const scrollEl = document.querySelector('.TransactionDrawer-tabContent');
            if (scrollEl) scrollEl.scrollTop = 0;
        },

        // Helper to parse date text like "Jan 15" or "January 15, 2026"
        parseDateText(dateText) {
            try {
                const monthNames = ['jan', 'feb', 'mar', 'apr', 'may', 'jun',
                    'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
                const text = dateText.toLowerCase();

                // Try to find month
                let monthIndex = -1;
                for (let i = 0; i < monthNames.length; i++) {
                    if (text.includes(monthNames[i])) {
                        monthIndex = i;
                        break;
                    }
                }

                if (monthIndex === -1) return null;

                // Try to find day
                const dayMatch = text.match(/(\d{1,2})/);
                const day = dayMatch ? parseInt(dayMatch[1]) : 1;

                // Try to find year, default to current budget year
                const yearMatch = text.match(/(\d{4})/);
                let year = yearMatch ? parseInt(yearMatch[1]) : new Date().getFullYear();

                // If we have a budget month, use its year
                if (this.currentBudgetMonth) {
                    const budgetYear = parseInt(this.currentBudgetMonth.split('-')[0]);
                    const budgetMonthNum = parseInt(this.currentBudgetMonth.split('-')[1]) - 1;

                    // Handle year boundary (e.g., Dec transactions in Jan budget)
                    if (!yearMatch) {
                        if (monthIndex > budgetMonthNum + 1) {
                            year = budgetYear - 1;
                        } else if (monthIndex < budgetMonthNum - 1) {
                            year = budgetYear + 1;
                        } else {
                            year = budgetYear;
                        }
                    }
                }

                return new Date(year, monthIndex, day);
            } catch (e) {
                return null;
            }
        },

        // Scan transactions on the page
        async scanTransactions() {
            if (this.isProcessing) return;
            this.isProcessing = true;

            this.updateStatus('Scanning transactions...');

            // Find transaction elements - try multiple selectors
            const containerSelectors = [
                '[data-testid="transaction_collection"]',
                '.ui-app-transaction-collection',
                '[class*="TransactionList"]',
                '[class*="transaction-list"]',
                '[data-testid="transactions"]',
                'main [class*="Transaction"]'
            ];

            let transactionContainer = null;
            for (const selector of containerSelectors) {
                transactionContainer = document.querySelector(selector);
                if (transactionContainer) {
                    break;
                }
            }

            if (!transactionContainer) {
                this.updateStatus('Navigate to Transactions tab to see suggestions.');
                this.isProcessing = false;
                return;
            }

            // Auto-scroll to load all transactions (handles virtual scrolling)
            await this.autoScrollToLoadTransactions(transactionContainer);

            // Use the transactions collected during scrolling
            this.transactions = [];
            this.suggestions.clear();

            if (this._collectedTransactions && this._collectedTransactions.size > 0) {
                // Use scroll-collected transactions
                for (const tx of this._collectedTransactions.values()) {
                    this.transactions.push(tx);

                    // Get categorization suggestion
                    const suggestion = await Categorizer.analyze(tx);
                    if (suggestion) {
                        this.suggestions.set(tx.id, suggestion);
                    }
                }
                this._collectedTransactions = null;
            } else {
                // Fallback: read whatever cards are currently in the DOM
                const cards = transactionContainer.querySelectorAll('[data-testid="unallocated_card"]');
                for (const card of cards) {
                    const transaction = this.parseTransactionCard(card);
                    if (transaction) {
                        this.transactions.push(transaction);
                        const suggestion = await Categorizer.analyze(transaction);
                        if (suggestion) {
                            this.suggestions.set(transaction.id, suggestion);
                        }
                    }
                }
            }

            // Update UI - pipeline will handle the display
            this.updateBadge(this.transactions.length);
            this.updateStatus(`Found ${this.transactions.length} transactions, ${this.suggestions.size} suggestions`);

            // Auto-cache after every full scan (don't await — fire and forget)
            this.cacheTransactions().catch(() => {});

            this.isProcessing = false;
        },

        // Trigger the MAIN-world React bridge (react-bridge.js) to extract props on current cards.
        // The bridge runs in MAIN world and writes data-edb-react-* attributes on card elements.
        // We use a custom DOM event to communicate across world boundaries.
        _triggerReactBridge() {
            // Use document (shared between MAIN and ISOLATED worlds) not window
            document.dispatchEvent(new CustomEvent('edb-extract-react-props'));
        },

        // Read React transaction data from data-* attributes set by the bridge script
        _getReactTransaction(card) {
            const date = card.dataset.edbReactDate;
            if (!date) return null;
            return {
                id: card.dataset.edbReactId || null,
                merchant: card.dataset.edbReactMerchant || '',
                amount: parseInt(card.dataset.edbReactAmount || '0', 10),
                date: date
            };
        },

        // Parse a transaction card element
        parseTransactionCard(card) {
            try {
                // Primary: read from React props (has full date with year, amount in cents, proper ID)
                const reactTx = this._getReactTransaction(card);
                if (reactTx) {
                    const name = reactTx.merchant || '';
                    const amount = (reactTx.amount || 0) / 100; // cents → dollars
                    const date = reactTx.date || new Date().toISOString();
                    const id = reactTx.id || `${name}-${amount}-${date}`.replace(/\s/g, '_');

                    return {
                        id,
                        name,
                        amount,
                        date,
                        account: '',
                        element: card
                    };
                }

                // Fallback: scrape from visible DOM (in case React bridge hasn't processed this card)
                const nameEl = card.querySelector('[class*="name"], [class*="merchant"], .TransactionCard--name');
                const amountEl = card.querySelector('[class*="amount"], .TransactionCard--amount');
                const dateEl = card.querySelector('[class*="date"], .TransactionCard--date');
                const accountEl = card.querySelector('[class*="account"], .TransactionCard--account');

                const textContent = card.textContent;

                let name = nameEl?.textContent?.trim() || '';
                let amount = amountEl?.textContent?.trim() || '';
                let date = dateEl?.textContent?.trim() || '';

                if (!name && card.getAttribute('aria-label')) {
                    const label = card.getAttribute('aria-label');
                    const parts = label.split(' ');
                    name = parts.slice(0, -1).join(' ');
                }

                const amountMatch = (amount || textContent).match(/(-?)\$?([\d,]+\.?\d*)/);
                const parsedAmount = amountMatch ? parseFloat((amountMatch[1] + amountMatch[2]).replace(',', '')) : 0;

                const dateMatch = (date || textContent).match(/(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s*(\d{1,2})/i);
                let parsedDate = new Date();
                if (dateMatch) {
                    const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
                    const monthIndex = months.indexOf(dateMatch[1].toLowerCase());
                    const day = parseInt(dateMatch[2]);

                    // Use load-batch year tag if available, otherwise proximity to current date
                    let year;
                    const loadYear = card.dataset?.edbLoadYear;
                    if (loadYear) {
                        year = parseInt(loadYear);
                    } else {
                        const now = new Date();
                        year = now.getFullYear();
                        const candidateDate = new Date(year, monthIndex, day);
                        const MS_PER_DAY = 86400000;
                        if (candidateDate - now > 60 * MS_PER_DAY) year--;
                        else if (now - candidateDate > 300 * MS_PER_DAY) year++;
                    }

                    parsedDate = new Date(year, monthIndex, day);
                }

                const id = `${name}-${parsedAmount}-${parsedDate.toISOString()}`.replace(/\s/g, '_');

                return {
                    id,
                    name,
                    amount: parsedAmount,
                    date: parsedDate.toISOString(),
                    account: accountEl?.textContent?.trim() || '',
                    element: card
                };
            } catch (error) {
                console.error('Error parsing transaction card:', error);
                return null;
            }
        },

        // Extract budget item categories from the EveryDollar page
        async extractCategories() {
            const categories = new Set();

            // EveryDollar budget items have .BudgetItem-label with data-text attribute containing the name
            const budgetLabels = document.querySelectorAll('.BudgetItem-label[data-text]');

            for (const label of budgetLabels) {
                const name = label.getAttribute('data-text');
                if (name && name.trim() && !name.startsWith('Add ')) {
                    categories.add(name.trim());
                }
            }

            // Convert to array of objects for consistency
            this.categories = Array.from(categories).sort().map(name => ({ name }));


            return this.categories;
        },

        // Get category names as a simple array (for dropdown options)
        async getBudgetCategoryNames() {
            // First try to get from already extracted categories
            if (this.categories && this.categories.length > 0) {
                return this.categories.map(c => c.name);
            }

            // Otherwise extract from page
            await this.extractCategories();

            if (this.categories && this.categories.length > 0) {
                return this.categories.map(c => c.name);
            }

            // Fallback: try to get from merchant rules
            const rules = await StorageManager.get(StorageManager.KEYS.MERCHANT_RULES) || {};
            const fromRules = new Set();
            for (const value of Object.values(rules)) {
                let category = null;
                if (typeof value === 'string') {
                    category = value;
                } else if (value && typeof value === 'object' && value.category) {
                    category = value.category;
                }
                if (category && typeof category === 'string' && !category.includes(',')) {
                    fromRules.add(category);
                }
            }

            if (fromRules.size > 0) {
                return Array.from(fromRules).sort();
            }

            // Last resort fallback
            return ['Groceries', 'Restaurant', 'Gas', 'Miscellaneous'];
        },

        // Get top N most frequently used categories from user's rules
        async getTopCategories(n = 3) {
            const categoryCounts = {};

            // Count from merchant rules
            const merchantRules = await StorageManager.get(StorageManager.KEYS.MERCHANT_RULES) || {};
            for (const value of Object.values(merchantRules)) {
                let category = null;
                if (typeof value === 'string') {
                    category = value;
                } else if (value && typeof value === 'object' && value.category) {
                    category = value.category;
                }
                if (category && typeof category === 'string' && category !== 'Uncategorized') {
                    categoryCounts[category] = (categoryCounts[category] || 0) + 1;
                }
            }

            // Count from item rules (weight more heavily since these are user-trained)
            const itemRules = await StorageManager.get(StorageManager.KEYS.ITEM_RULES) || {};
            for (const value of Object.values(itemRules)) {
                const category = value?.category;
                const count = value?.count || 1;
                if (category && typeof category === 'string' && category !== 'Uncategorized') {
                    categoryCounts[category] = (categoryCounts[category] || 0) + (count * 2);  // Weight item rules higher
                }
            }

            // Sort by count and return top N
            const sorted = Object.entries(categoryCounts)
                .sort((a, b) => b[1] - a[1])
                .slice(0, n)
                .map(([cat]) => cat);

            // If we don't have enough, add from available categories
            if (sorted.length < n) {
                const allCategories = await this.getBudgetCategoryNames();
                for (const cat of allCategories) {
                    if (!sorted.includes(cat) && sorted.length < n) {
                        sorted.push(cat);
                    }
                }
            }

            return sorted;
        },

        // Check if a transaction matches the current budget month
        txMatchesCurrentMonth(tx) {
            if (!this.currentBudgetMonth || !tx.date) return true; // If we can't determine, show it

            try {
                const txDate = new Date(tx.date);
                const txMonth = `${txDate.getFullYear()}-${String(txDate.getMonth() + 1).padStart(2, '0')}`;
                return txMonth === this.currentBudgetMonth;
            } catch (e) {
                return true; // If we can't parse, show it
            }
        },

        // Get month name from transaction date
        getTxMonthName(tx) {
            if (!tx.date) return 'Unknown';
            try {
                const txDate = new Date(tx.date);
                return txDate.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
            } catch (e) {
                return 'Unknown';
            }
        },

        // ============ PIPELINE PROCESSING ============

        // List of stores we can scrape receipts for
        STORE_PATTERNS: ['target', 'walmart', 'amazon', 'fred meyer', 'fredmeyer', 'kroger', 'costco'],

        // Patterns that look like stores but are actually services/subscriptions (no receipts)
        SERVICE_PATTERNS: ['amazon web services', 'aws', 'amazon prime', 'prime video', 'amazon music'],

        // Check if a transaction is from a supported store
        isStoreTransaction(tx) {
            if (!tx || !tx.name) return false;
            const name = tx.name.toLowerCase();

            // Exclude services that don't have itemized receipts
            if (this.SERVICE_PATTERNS.some(svc => name.includes(svc.toLowerCase()))) {
                return false;
            }

            return this.STORE_PATTERNS.some(store => name.includes(store.toLowerCase()));
        },

        // Identify which store a transaction is from
        getStoreForTransaction(tx) {
            if (!tx || !tx.name) return null;
            const name = tx.name.toLowerCase();
            if (name.includes('target')) return 'target';
            if (name.includes('walmart')) return 'walmart';
            if (name.includes('amazon')) return 'amazon';
            if (name.includes('fred meyer') || name.includes('fredmeyer') || name.includes('kroger')) return 'fredmeyer';
            if (name.includes('costco')) return 'costco';
            return null;
        },

        // Detect refund transactions by keyword and find candidate purchase matches
        // Returns: { refunds: Array<tx>, candidates: Map<refundId, Array<{purchase, score}>> }
        detectRefundTransactions(transactions) {
            const refundPatterns = /refund|return(ed)?|credit back|chargeback/i;
            const refunds = [];
            const purchases = [];

            for (const tx of transactions) {
                const amount = parseFloat(tx.amount);
                const name = tx.name || '';

                if (refundPatterns.test(name) && this.isStoreTransaction(tx)) {
                    refunds.push(tx);
                } else if (amount < 0) {
                    purchases.push(tx);
                }
            }


            // For each refund, compute ranked candidate purchases
            const candidates = new Map();
            for (const refund of refunds) {
                const refundAmount = Math.abs(parseFloat(refund.amount));
                const refundDate = new Date(refund.date);
                const refundStore = this.getStoreForTransaction(refund);
                if (!refundStore) continue;

                const matches = [];
                for (const purchase of purchases) {
                    const purchaseStore = this.getStoreForTransaction(purchase);
                    if (purchaseStore !== refundStore) continue;

                    const purchaseAmount = Math.abs(parseFloat(purchase.amount));
                    const purchaseDate = new Date(purchase.date);
                    const amountDiff = Math.abs(purchaseAmount - refundAmount);

                    if (refundAmount > purchaseAmount * 1.1) continue;
                    if (amountDiff > purchaseAmount * 0.5 && amountDiff > 10) continue;

                    const daysDiff = (refundDate - purchaseDate) / (1000 * 60 * 60 * 24);
                    if (daysDiff < -1 || daysDiff > 45) continue;

                    let score = 0;
                    if (amountDiff < 0.01) score += 50;
                    else if (amountDiff < 1) score += 30;
                    else if (amountDiff < 5) score += 15;

                    if (daysDiff >= 0 && daysDiff < 3) score += 30;
                    else if (daysDiff >= 0 && daysDiff < 7) score += 20;
                    else if (daysDiff >= 0 && daysDiff < 14) score += 10;
                    else if (daysDiff >= 0 && daysDiff < 30) score += 5;

                    if (score > 0) {
                        matches.push({ purchase, score });
                    }
                }

                matches.sort((a, b) => b.score - a.score);
                candidates.set(refund.id, matches.slice(0, 5));
            }

            return { refunds, candidates };
        },

        // Resolve refund pairs: check editedSplits for user-confirmed pairs
        // Returns: { pairedTxIds, pairs, unresolvedRefunds }
        resolveRefundPairs(transactions) {
            const pairedTxIds = new Set();
            const pairs = [];
            const unresolvedRefunds = [];

            const { refunds, candidates } = this.detectRefundTransactions(transactions);

            for (const refund of refunds) {
                const editData = this.editedSplits.get(refund.id);

                if (editData?.manualPair && editData.purchaseId) {
                    // User confirmed a pair
                    const purchase = transactions.find(t => t.id === editData.purchaseId);
                    if (purchase) {
                        const refundAmount = Math.abs(parseFloat(refund.amount));
                        const purchaseAmount = Math.abs(parseFloat(purchase.amount));
                        const netAmount = purchaseAmount - refundAmount;
                        const store = this.getStoreForTransaction(refund);

                        pairs.push({ purchase, refund, netAmount, store });
                        pairedTxIds.add(refund.id);
                        pairedTxIds.add(purchase.id);
                    } else {
                        // Purchase no longer exists - clear stale pair
                        this.editedSplits.delete(refund.id);
                        unresolvedRefunds.push({ refund, candidates: candidates.get(refund.id) || [] });
                    }
                } else if (editData?.dismissed) {
                    // User dismissed - refund flows through normal pipeline
                } else {
                    // Unresolved - needs user input
                    unresolvedRefunds.push({ refund, candidates: candidates.get(refund.id) || [] });
                }
            }

            return { pairedTxIds, pairs, unresolvedRefunds };
        },

        // Process transactions through the pipeline
        async processTransactionPipeline() {

            // If auto-learning is in progress, show placeholder state instead of confusing zeros
            if (this._isAutoLearningInProgress) {
                const welcomeEl = document.getElementById('edb-welcome');
                const pipelineEl = document.querySelector('.edb-pipeline');
                if (welcomeEl) welcomeEl.classList.add('edb-hidden');
                if (pipelineEl) pipelineEl.classList.add('edb-hidden');
                console.log('[EDB Pipeline] Skipping — auto-learning in progress');
                return { awaiting: 0, categorize: 0, ready: 0 };
            }

            // Load receipts from storage - use STORE_RECEIPTS key
            const allReceipts = await StorageManager.get(StorageManager.KEYS.STORE_RECEIPTS) || [];

            // Deduplicate items within each receipt (scrapers may pick up the same item twice)
            for (const receipt of allReceipts) {
                if (receipt.items && receipt.items.length > 1) {
                    const seen = new Set();
                    const origCount = receipt.items.length;
                    receipt.items = receipt.items.filter(item => {
                        const key = item.name?.substring(0, 100).toLowerCase();
                        if (seen.has(key)) return false;
                        seen.add(key);
                        return true;
                    });
                    if (receipt.items.length < origCount) {
                        // Recalculate prices: if all items had evenly split prices, redistribute the total
                        if (receipt.total > 0) {
                            const itemTotal = receipt.items.reduce((s, i) => s + (i.price || 0), 0);
                            if (Math.abs(itemTotal - receipt.total) > 0.02) {
                                const perItem = Math.round((receipt.total / receipt.items.length) * 100) / 100;
                                let remaining = receipt.total;
                                receipt.items.forEach((item, i) => {
                                    if (i === receipt.items.length - 1) {
                                        item.price = Math.round(remaining * 100) / 100;
                                    } else {
                                        item.price = perItem;
                                        remaining -= perItem;
                                    }
                                });
                            }
                        }
                    }
                }
            }

            // Debug: show what's in receipt storage
            if (allReceipts.length > 0) {
            }

            // Pipeline buckets (3 stages)
            const awaiting = [];       // Stage 1: Store transactions without matching receipt
            const categorize = [];     // Stage 2: Items needing categorization (receipts + non-store transactions)
            const ready = [];          // Stage 3: Ready to apply (single category or confirmed)

            // Debug: Show editedSplits state at start of pipeline


            // Debug: show first few transaction names to verify data
            if (this.transactions.length > 0) {
            }

            // Debug: show suggestion keys
            if (this.suggestions.size > 0) {
                const suggestionKeys = [...this.suggestions.keys()].slice(0, 3);
            }

            // Filter transactions to match the budget month the user is viewing.
            // EveryDollar's New tab shows all months, but the panel should only
            // show transactions for the selected budget month.
            const pipelineTxs = this.currentBudgetMonth
                ? this.transactions.filter(tx => this.txMatchesCurrentMonth(tx))
                : this.transactions;
            console.log(`[EDB Pipeline] Budget month: ${this.currentBudgetMonth}, total txs: ${this.transactions.length}, filtered: ${pipelineTxs.length}`);

            // REFUND PAIRING: Detect refund transactions, resolve user-confirmed pairs
            const { pairedTxIds, pairs: refundPairs, unresolvedRefunds } = this.resolveRefundPairs(pipelineTxs);
            const unresolvedRefundIds = new Set(unresolvedRefunds.map(u => u.refund.id));

            let storeCount = 0;
            let nonStoreWithSuggestion = 0;
            let nonStoreNoSuggestion = 0;
            let matchedReceipts = 0;
            let unmatchedStores = [];

            // Track which receipts have been matched to prevent duplicates
            const usedReceiptIds = new Set();

            // Process refund pairs first - try to match with receipts using the purchase transaction
            for (const pair of refundPairs) {
                const { purchase, refund, netAmount, store } = pair;
                storeCount += 2; // Count both transactions

                // Create a virtual "net" transaction for display
                const netTx = {
                    ...purchase,
                    id: `paired-${purchase.id}`,
                    originalPurchaseId: purchase.id,
                    originalRefundId: refund.id,
                    amount: -netAmount, // Negative because it's an expense (0 for full refunds)
                    isPaired: true,
                    isFullRefund: netAmount <= 0,
                    pairInfo: {
                        purchaseName: purchase.name,
                        purchaseAmount: Math.abs(parseFloat(purchase.amount)),
                        refundName: refund.name,
                        refundAmount: Math.abs(parseFloat(refund.amount)),
                        purchaseDate: purchase.date,
                        refundDate: refund.date,
                        store: store
                    }
                };

                // Check if user skipped receipt for this paired transaction
                const pairedEditData = this.editedSplits.get(netTx.id);
                if (pairedEditData?.skippedReceipt) {
                    // User chose to skip receipt - route to categorize as simple transaction
                    categorize.push({ tx: netTx, isSimple: true, skippedReceipt: true, isPaired: true });
                    continue;
                }

                // Try to find matching receipt for the purchase
                // Note: Refunds are always from the SAME order as the purchase, so we only need one receipt
                const availableReceipts = allReceipts.filter(r => !usedReceiptIds.has(r.orderId));
                const matchingReceipt = this.findMatchingReceipt(purchase, availableReceipts);

                // Full refunds (net <= 0) go to categorize - but include receipt data if available
                if (netAmount <= 0) {
                    if (matchingReceipt) {
                        // Has receipt - show item names
                        usedReceiptIds.add(matchingReceipt.orderId);
                        const categorization = await this.categorizeReceipt(matchingReceipt);
                        categorize.push({
                            tx: netTx,
                            receipt: matchingReceipt,
                            categorization,
                            isPaired: true,
                            isFullRefund: true
                        });
                    } else {
                        // No receipt - show as simple transaction
                        categorize.push({ tx: netTx, isSimple: true, isPaired: true, isFullRefund: true });
                    }
                    continue;
                }

                if (!matchingReceipt) {
                    // No receipt found - add to awaiting with pair info
                    awaiting.push({ tx: netTx, store, isPaired: true });
                } else {
                    matchedReceipts++;
                    usedReceiptIds.add(matchingReceipt.orderId);

                    // Categorize the receipt items
                    const editedData = this.editedSplits.get(netTx.id);
                    const categorization = (editedData?.categorization)
                        ? editedData.categorization
                        : await this.categorizeReceipt(matchingReceipt);

                    const uniqueCategories = new Set(categorization.items.map(i => i.category));
                    const realCategories = new Set([...uniqueCategories].filter(c => c !== 'Uncategorized'));
                    const hasUncategorized = uniqueCategories.has('Uncategorized');
                    const isConfirmed = editedData?.confirmed === true;
                    const allHighConfidence = categorization.items.every(i => (i.confidence || 0) >= 0.90);
                    const isAutoSplit = allHighConfidence && !hasUncategorized && realCategories.size >= 1;

                    if (isConfirmed || isAutoSplit) {
                        const allSameCategory = this.getAllSameCategory(categorization);
                        if (allSameCategory) {
                            ready.push({
                                tx: netTx,
                                category: allSameCategory,
                                receipt: matchingReceipt,
                                categorization,
                                source: 'receipt',
                                isSplit: false,
                                isPaired: true,
                                itemNote: this.buildItemNote(categorization.items)
                            });
                        } else if (realCategories.size > 1) {
                            // Split proportionally based on net amount
                            const totalOriginal = Math.abs(parseFloat(purchase.amount));
                            const ratio = netAmount / totalOriginal;
                            for (const [cat, data] of Object.entries(categorization.categoryTotals)) {
                                if (cat === 'Uncategorized') continue;
                                ready.push({
                                    tx: netTx,
                                    category: cat,
                                    amount: data.total * ratio, // Proportional net amount
                                    receipt: matchingReceipt,
                                    categorization,
                                    source: 'receipt',
                                    isSplit: true,
                                    isPaired: true,
                                    splitItems: data.items
                                });
                            }
                        }
                    } else {
                        // Needs categorization
                        categorize.push({
                            tx: netTx,
                            receipt: matchingReceipt,
                            categorization,
                            isPaired: true
                        });
                    }
                }
            }

            // Add unresolved refunds to categorize stage for user pairing
            // Enrich candidates with receipt URLs for transparency/verification
            for (const { refund, candidates } of unresolvedRefunds) {
                const enrichedCandidates = candidates.map(c => {
                    const availableReceipts = allReceipts.filter(r => !usedReceiptIds.has(r.orderId));
                    const receipt = this.findMatchingReceipt(c.purchase, availableReceipts);
                    return { ...c, receiptUrl: receipt?.url || null };
                });
                const refundStore = this.getStoreForTransaction(refund);
                categorize.push({
                    tx: refund,
                    isRefundPending: true,
                    refundCandidates: enrichedCandidates,
                    refundStore: refundStore
                });
            }

            for (const tx of pipelineTxs) {
                // Skip transactions that are part of confirmed refund pairs
                if (pairedTxIds.has(tx.id)) continue;
                // Skip unresolved refunds (already added to categorize above)
                if (unresolvedRefundIds.has(tx.id)) continue;

                // PRIORITY CHECK: If user confirmed via Kanban (isSimple + confirmed),
                // route directly to Ready regardless of store/non-store status
                // EXCEPT: store transactions with multi-item receipts should go to Stage 2
                // so users can split items into different categories
                const kanbanEdit = this.editedSplits.get(tx.id);
                if (kanbanEdit?.isSimple && kanbanEdit?.confirmed && kanbanEdit?.category) {
                    // Check if this store transaction has a multi-item receipt that needs splitting
                    // BUT respect user's explicit Kanban choice (kanbanMultiItem flag)
                    const kanbanStore = this.getStoreForTransaction(tx);
                    let overrideKanban = false;
                    if (kanbanStore && !kanbanEdit.kanbanMultiItem) {
                        const availableReceipts = allReceipts.filter(r => !usedReceiptIds.has(r.orderId));
                        const receipt = this.findMatchingReceipt(tx, availableReceipts);
                        if (receipt && receipt.items && receipt.items.length > 1) {
                            console.log(`[EDB Pipeline] Store tx "${tx.name}" has ${receipt.items.length}-item receipt — routing to Stage 2 for splitting`);
                            this.editedSplits.delete(tx.id);
                            // Persist the deletion so it survives page reloads
                            StorageManager.set(StorageManager.KEYS.EDITED_SPLITS,
                                Object.fromEntries(this.editedSplits));
                            overrideKanban = true;
                        }
                    }
                    if (!overrideKanban) {
                        ready.push({
                            tx,
                            category: kanbanEdit.category,
                            source: 'manual',
                            confidence: 1.0,
                            isSimple: true,
                            // Carry forward kanbanMultiItem flag so it survives pipeline cycles
                            ...(kanbanEdit.kanbanMultiItem && { kanbanMultiItem: true })
                        });
                        continue;
                    }
                }

                const isStore = this.isStoreTransaction(tx);
                const store = this.getStoreForTransaction(tx);

                if (isStore) {
                    storeCount++;

                    // Positive-amount store transactions are credits/refunds from the bank -
                    // there's no receipt to fetch, so skip Awaiting Receipt entirely
                    const txAmount = parseFloat(tx.amount);
                    if (txAmount > 0) {
                        categorize.push({ tx, isSimple: true });
                        continue;
                    }

                    // Check if user skipped receipt for this transaction
                    const editedData = this.editedSplits.get(tx.id);
                    if (editedData?.skippedReceipt) {
                        // User chose to skip receipt - route to categorize as simple transaction
                        categorize.push({ tx, isSimple: true, skippedReceipt: true });
                        continue;
                    }

                    // Try to find matching receipt (excluding already-used receipts)
                    const availableReceipts = allReceipts.filter(r => !usedReceiptIds.has(r.orderId));
                    const matchingReceipt = this.findMatchingReceipt(tx, availableReceipts);

                    if (!matchingReceipt) {
                        // No receipt found - Stage 1
                        awaiting.push({ tx, store });
                        // Debug: Log unmatched Amazon transactions
                        if (store === 'amazon') {
                            const txAmount = Math.abs(parseFloat(tx.amount));
                            const amazonReceipts = availableReceipts.filter(r => r.store === 'amazon');
                            const closeMatches = amazonReceipts.filter(r => {
                                const diff = Math.abs(Math.abs(r.total) - txAmount);
                                return diff < 10;
                            }).map(r => ({ total: r.total, date: r.date?.substring(0, 10), diff: Math.abs(Math.abs(r.total) - txAmount).toFixed(2) }));
                            console.log(`[EDB Pipeline] Unmatched Amazon: "${tx.name}" $${txAmount} | ${amazonReceipts.length} Amazon receipts in storage | Close matches: ${JSON.stringify(closeMatches)}`);
                        }
                        // Track unmatched for debugging (first 5 Target transactions)
                        if (store === 'target' && unmatchedStores.length < 5) {
                            unmatchedStores.push({
                                name: tx.name,
                                amount: tx.amount,
                                date: tx.date
                            });
                        }
                    } else {
                        matchedReceipts++;

                        // Mark this receipt as used to prevent duplicate matching
                        if (matchingReceipt.orderId) {
                            usedReceiptIds.add(matchingReceipt.orderId);
                        }

                        // Check if we have user-edited categorization for this transaction
                        const editedData = this.editedSplits.get(tx.id);

                        // Debug: Log the lookup
                        if (tx.name.toLowerCase().includes('target')) {
                        }

                        const categorization = (editedData?.categorization)
                            ? editedData.categorization  // Use user's edits
                            : await this.categorizeReceipt(matchingReceipt);  // Fresh categorization

                        // Debug: Log what we're using
                        if (tx.name.toLowerCase().includes('target')) {
                        }

                        const uniqueCategories = new Set(categorization.items.map(i => i.category));

                        // Filter out Uncategorized to see if we have real categories
                        const realCategories = new Set([...uniqueCategories].filter(c => c !== 'Uncategorized'));
                        const hasUncategorized = uniqueCategories.has('Uncategorized');
                        const itemCount = categorization.items.length;

                        // Calculate categorized vs uncategorized totals
                        const categorizedItems = categorization.items.filter(i => i.category !== 'Uncategorized');
                        const uncategorizedItems = categorization.items.filter(i => i.category === 'Uncategorized');
                        const categorizedTotal = categorizedItems.reduce((sum, i) => sum + (parseFloat(i.price) || 0), 0);
                        const uncategorizedTotal = uncategorizedItems.reduce((sum, i) => sum + (parseFloat(i.price) || 0), 0);

                        // Check if user has explicitly confirmed this split
                        const isConfirmed = editedData?.confirmed === true;

                        // Check if ALL items have high confidence (90%+) for auto-split
                        // Only auto-route SINGLE-item receipts; multi-item receipts always
                        // go to Stage 2 so user can split items into different categories
                        const AUTO_SPLIT_THRESHOLD = 0.90;
                        const allHighConfidence = categorization.items.every(i => (i.confidence || 0) >= AUTO_SPLIT_THRESHOLD);
                        const isAutoSplit = allHighConfidence && !hasUncategorized && realCategories.size >= 1 && itemCount <= 1;

                        // NEW ROUTING LOGIC:
                        // - User confirmed OR all items 90%+ confidence → Ready to Apply
                        // - Otherwise → Categorize Items stage for review

                        if (isConfirmed || isAutoSplit) {
                            // READY TO APPLY: User confirmed or high confidence auto-categorization

                            // Smart merge: Check if all categorized items have the SAME category
                            const allSameCategory = this.getAllSameCategory(categorization);

                            if (allSameCategory) {
                                // ALL SAME CATEGORY → Single transaction (no split needed)
                                const itemNote = this.buildItemNote(categorization.items);
                                ready.push({
                                    tx,
                                    category: allSameCategory,
                                    receipt: matchingReceipt,
                                    categorization,
                                    source: 'receipt',
                                    confidence: 0.95,
                                    isSplit: false,
                                    itemNote  // Add to transaction notes
                                });
                            } else if (realCategories.size > 1) {
                                // MULTIPLE CATEGORIES → Create separate ready items for each category
                                for (const [cat, data] of Object.entries(categorization.categoryTotals)) {
                                    if (cat === 'Uncategorized') continue;  // Skip uncategorized
                                    ready.push({
                                        tx,
                                        category: cat,
                                        amount: data.total,
                                        receipt: matchingReceipt,
                                        categorization,
                                        source: 'receipt',
                                        confidence: 0.95,
                                        isSplit: true,
                                        splitItems: data.items
                                    });
                                }
                            } else {
                                // Fallback: single category
                                const category = categorization.items[0]?.category || 'Uncategorized';
                                const itemNote = this.buildItemNote(categorization.items);
                                ready.push({
                                    tx,
                                    category,
                                    receipt: matchingReceipt,
                                    categorization,
                                    source: 'receipt',
                                    confidence: 0.95,
                                    isSplit: false,
                                    itemNote
                                });
                            }
                        } else {
                            // NEEDS REVIEW: Route to Categorize Items stage
                            categorize.push({
                                tx,
                                receipt: matchingReceipt,
                                categorization,
                                itemCount: categorization.items.length
                            });
                        }
                    }
                } else {
                    // Non-store transaction - check for confirmed edit first
                    const editedData = this.editedSplits.get(tx.id);

                    if (editedData?.isSimple && editedData?.confirmed) {
                        // User already confirmed this simple transaction - move to Ready
                        nonStoreWithSuggestion++;
                        ready.push({
                            tx,
                            category: editedData.category,
                            source: 'manual',
                            confidence: 1.0,
                            isSimple: true
                        });
                    } else {
                        // Check for suggestions from learned rules
                        const suggestion = this.suggestions.get(tx.id);
                        if (suggestion && suggestion.confidence >= 0.5) {
                            nonStoreWithSuggestion++;
                            ready.push({
                                tx,
                                category: suggestion.category,
                                source: suggestion.source,
                                confidence: suggestion.confidence,
                                reason: suggestion.reason,
                                reasons: suggestion.reasons
                            });
                        } else if (suggestion) {
                            // Low confidence suggestion - still show it but needs review
                            nonStoreWithSuggestion++;
                            ready.push({
                                tx,
                                category: suggestion.category,
                                source: suggestion.source,
                                confidence: suggestion.confidence,
                                reason: suggestion.reason,
                                reasons: suggestion.reasons
                            });
                        } else {
                            nonStoreNoSuggestion++;
                            console.log(`[EDB NoSuggestion] "${tx.name}" (${tx.amount}) has no suggestion → Stage 2`);
                            // Non-store transaction with no suggestion - add to Categorize stage
                            categorize.push({ tx, isSimple: true });
                        }
                    }
                }
            }

            // Store for Kanban access and Amazon targeted scraping
            this.lastCategorizeItems = categorize;
            this.lastReadyItems = ready;
            this.lastAwaitingItems = awaiting;

            // Update all pipeline stage UIs
            this.renderAwaitingStage(awaiting);
            await this.renderCategorizeStage(categorize);
            await this.renderReadyStage(ready);

            // Update badge count (total unallocated transactions)
            this.updateBadge(this.transactions.length);

            // Show welcome state if everything is empty
            const totalPipeline = awaiting.length + categorize.length + ready.length;
            const welcomeEl = document.getElementById('edb-welcome');
            const pipelineEl = document.querySelector('.edb-pipeline');

            if (totalPipeline === 0 && pipelineTxs.length === 0 && this.transactions.length > 0 && this.currentBudgetMonth) {
                // Transactions exist but none match the viewed month
                if (welcomeEl) welcomeEl.classList.add('edb-hidden');
                if (pipelineEl) pipelineEl.classList.remove('edb-hidden');
                // Find which months have transactions
                const monthCounts = {};
                for (const tx of this.transactions) {
                    if (!tx.date) continue;
                    try {
                        const d = new Date(tx.date);
                        const key = d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
                        monthCounts[key] = (monthCounts[key] || 0) + 1;
                    } catch (e) { /* skip */ }
                }
                const monthList = Object.entries(monthCounts)
                    .sort((a, b) => b[1] - a[1])
                    .map(([m, c]) => `${m} (${c})`)
                    .join(', ');
                const [bmYear, bmMonth] = this.currentBudgetMonth.split('-');
                const budgetMonthName = new Date(parseInt(bmYear), parseInt(bmMonth) - 1, 15).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
                this.updateStatus(`No uncategorized transactions for ${budgetMonthName}. Pending: ${monthList}`);
            } else if (totalPipeline === 0 && this.transactions.length === 0) {
                // Check if we have any learned rules
                const rules = await StorageManager.get(StorageManager.KEYS.MERCHANT_RULES) || {};
                const receipts = allReceipts.length;
                const rulesCount = Object.keys(rules).length;

                if (rulesCount === 0 && receipts === 0) {
                    // Truly empty - show welcome
                    if (welcomeEl) welcomeEl.classList.remove('edb-hidden');
                    if (pipelineEl) pipelineEl.classList.add('edb-hidden');
                    this.updateStatus('');
                } else {
                    // Has data but no transactions - probably just no new transactions
                    if (welcomeEl) welcomeEl.classList.add('edb-hidden');
                    if (pipelineEl) pipelineEl.classList.remove('edb-hidden');
                    this.updateStatus('No new transactions to categorize.');
                }
            } else {
                // Has pipeline items - hide welcome, show pipeline
                if (welcomeEl) welcomeEl.classList.add('edb-hidden');
                if (pipelineEl) pipelineEl.classList.remove('edb-hidden');

                // Update status with actionable hint
                if (ready.length > 0) {
                    this.updateStatus(`✓ ${ready.length} transaction${ready.length > 1 ? 's' : ''} ready to apply`);
                } else if (categorize.length > 0) {
                    this.updateStatus('Assign categories to continue');
                } else if (awaiting.length > 0) {
                    this.updateStatus('Fetch receipts to categorize store transactions');
                } else {
                    this.updateStatus('');
                }
            }

            // Show one-click receipt fetch prompt if store transactions need receipts
            if (!this._receiptPromptDismissed && awaiting.length > 0) {
                this.showReceiptPrompt(awaiting);
            } else {
                document.getElementById('edb-receipt-prompt')?.remove();
            }

            // Return stats for callers that need them
            return { awaiting: awaiting.length, categorize: categorize.length, ready: ready.length };
        },

        // Find a receipt that matches a transaction
        findMatchingReceipt(tx, receipts) {
            if (!receipts || receipts.length === 0) return null;

            // Use absolute value since transactions are negative (expenses) but receipts are positive
            const txAmount = Math.abs(parseFloat(tx.amount));
            const txDate = new Date(tx.date);
            const txStore = this.getStoreForTransaction(tx);

            let bestMatch = null;
            let bestScore = 0;

            for (const receipt of receipts) {
                let score = 0;

                // REQUIRED: Store must match (never match Target receipt to Amazon transaction!)
                const receiptStore = (receipt.store || '').toLowerCase();
                if (!txStore || !receiptStore.includes(txStore)) {
                    continue; // Different store, skip entirely
                }

                // Amount match (most important scoring factor)
                const receiptAmount = Math.abs(parseFloat(receipt.total));
                const amountDiff = Math.abs(txAmount - receiptAmount);
                if (amountDiff < 0.01) {
                    score += 50; // Exact match
                } else if (amountDiff < 1.00) {
                    score += 40; // Very close
                } else if (amountDiff < 5.00) {
                    score += 20; // Close enough (fees, tips, etc.)
                } else {
                    continue; // Amount too different, skip
                }

                // Date proximity (scoring factor)
                const receiptDate = new Date(receipt.date);
                const daysDiff = Math.abs((txDate - receiptDate) / (1000 * 60 * 60 * 24));
                if (daysDiff < 1) {
                    score += 20;
                } else if (daysDiff < 3) {
                    score += 10;
                } else if (daysDiff < 7) {
                    score += 5;
                }

                if (score > bestScore) {
                    bestScore = score;
                    bestMatch = receipt;
                }
            }

            // Need at least 20 points (amount within $5) to be considered a match
            // Store match is now required, so we just need a reasonable amount match
            return bestScore >= 20 ? bestMatch : null;
        },

        // Build order link icon for receipt
        // Store order history URLs for looking up purchases/refunds
        STORE_ORDER_URLS: {
            target: 'https://www.target.com/orders',
            costco: 'https://www.costco.com/myaccount/#/app/4900eb1f-0c10-4bd9-99c3-c59e6c1ecebf/ordersandpurchases',
            fredmeyer: 'https://www.fredmeyer.com/mypurchases',
            amazon: 'https://www.amazon.com/gp/css/order-history',
            walmart: 'https://www.walmart.com/orders'
        },

        // Build expandable pair details for refund-paired transactions
        buildPairDetails(tx, receipt) {
            if (!tx.isPaired || !tx.pairInfo) return '';
            const p = tx.pairInfo;
            const purchaseDate = new Date(p.purchaseDate).toLocaleDateString();
            const refundDate = new Date(p.refundDate).toLocaleDateString();
            const netAmount = (p.purchaseAmount - p.refundAmount).toFixed(2);
            const isFullRefund = p.refundAmount >= p.purchaseAmount;

            // Build links to merchant order pages
            const orderUrl = receipt?.url || null;
            const storeOrdersUrl = p.store ? this.STORE_ORDER_URLS[p.store] : null;

            // Purchase link: use receipt URL if available, fallback to store orders page
            const purchaseLink = orderUrl
                ? `<a href="${orderUrl}" target="_blank" class="edb-pair-link" title="View order on merchant site">📦 View Order</a>`
                : (storeOrdersUrl
                    ? `<a href="${storeOrdersUrl}" target="_blank" class="edb-pair-link" title="Open order history to find this purchase">📦 Find Order</a>`
                    : '');

            // Refund link: for most stores, refund info is on the same order page or the orders list
            const refundLink = storeOrdersUrl
                ? `<a href="${orderUrl || storeOrdersUrl}" target="_blank" class="edb-pair-link" title="View refund on merchant site">📦 View Refund</a>`
                : '';

            return `
                <div class="edb-pair-details-toggle" title="Click to view purchase/refund pair details">
                    🔄 ${isFullRefund ? 'Full Refund' : 'Partial Refund'}
                </div>
                <div class="edb-pair-details" style="display:none;">
                    <div class="edb-pair-row edb-pair-purchase">
                        <span class="edb-pair-label">Purchase:</span>
                        <span class="edb-pair-name">${p.purchaseName}</span>
                        <span class="edb-pair-date">${purchaseDate}</span>
                        <span class="edb-pair-amount">-$${p.purchaseAmount.toFixed(2)}</span>
                        ${purchaseLink}
                    </div>
                    <div class="edb-pair-row edb-pair-refund">
                        <span class="edb-pair-label">Refund:</span>
                        <span class="edb-pair-name">${p.refundName}</span>
                        <span class="edb-pair-date">${refundDate}</span>
                        <span class="edb-pair-amount edb-amount-positive">+$${p.refundAmount.toFixed(2)}</span>
                        ${refundLink}
                    </div>
                    <div class="edb-pair-row edb-pair-net">
                        <span class="edb-pair-label">Net:</span>
                        <span></span>
                        <span></span>
                        <span class="edb-pair-amount">${isFullRefund ? '$0.00' : '-$' + netAmount}</span>
                        <span></span>
                    </div>
                </div>
            `;
        },

        buildOrderLinkIcon(receipt) {
            if (!receipt?.url) return '';
            const orderId = receipt.orderId || 'N/A';
            return `<a href="${receipt.url}" target="_blank" class="edb-order-link-icon" title="View Order #${orderId}">📦</a>`;
        },

        // Build expandable source details panel for auditing/transparency
        // Shows where the data came from: bank transaction info, scraped receipt details, order links
        buildSourcePanel(tx, receipt, store) {
            const txDate = new Date(tx.date).toLocaleDateString();
            const txAmount = parseFloat(tx.amount);
            const storeName = store ? this.getStoreName(store) : null;
            const storeOrdersUrl = store ? this.STORE_ORDER_URLS[store] : null;

            let panelContent = '';
            const isCredit = txAmount > 0;

            // Bank transaction source
            panelContent += `
                <div class="edb-source-section">
                    <div class="edb-source-heading">From EveryDollar (bank import)</div>
                    <div class="edb-source-row"><span>Name:</span> <span>${tx.name}</span></div>
                    <div class="edb-source-row"><span>Date:</span> <span>${txDate}</span></div>
                    <div class="edb-source-row"><span>Amount:</span> <span>${txAmount < 0 ? '-' : '+'}$${Math.abs(txAmount).toFixed(2)}${isCredit ? ' (credit)' : ''}</span></div>
                    ${storeName ? `<div class="edb-source-row"><span>Store:</span> <span>${storeName}</span></div>` : ''}
                    <div class="edb-source-note">Your bank reported this transaction. This extension did not create it.</div>
                </div>
            `;

            // Scraped receipt source (if available)
            if (receipt) {
                const receiptDate = new Date(receipt.date).toLocaleDateString();
                const orderLink = receipt.url
                    ? `<a href="${receipt.url}" target="_blank" class="edb-source-link">Open order page</a>`
                    : (storeOrdersUrl
                        ? `<a href="${storeOrdersUrl}" target="_blank" class="edb-source-link">Open order history</a>`
                        : '');

                panelContent += `
                    <div class="edb-source-section">
                        <div class="edb-source-heading">Scraped Receipt ${orderLink}</div>
                        <div class="edb-source-row"><span>Order ID:</span> <span>${receipt.orderId || 'N/A'}</span></div>
                        <div class="edb-source-row"><span>Date:</span> <span>${receiptDate}</span></div>
                        <div class="edb-source-row"><span>Total:</span> <span>$${parseFloat(receipt.total).toFixed(2)}</span></div>
                        <div class="edb-source-row"><span>Items:</span> <span>${receipt.items?.length || 0}</span></div>
                `;

                // List all scraped items
                if (receipt.items && receipt.items.length > 0) {
                    panelContent += `<div class="edb-source-items">`;
                    for (const item of receipt.items) {
                        const qty = item.quantity > 1 ? ` x${item.quantity}` : '';
                        panelContent += `
                            <div class="edb-source-item">
                                <span class="edb-source-item-name">${item.name}${qty}</span>
                                <span class="edb-source-item-price">$${parseFloat(item.price).toFixed(2)}</span>
                            </div>
                        `;
                    }
                    panelContent += `</div>`;
                }

                panelContent += `</div>`;
            } else {
                // No receipt - show status
                const orderHistoryLink = storeOrdersUrl
                    ? `<a href="${storeOrdersUrl}" target="_blank" class="edb-source-link">Open order history</a>`
                    : '';
                if (storeName) {
                    panelContent += `
                        <div class="edb-source-section">
                            <div class="edb-source-heading">Receipt ${orderHistoryLink}</div>
                            <div class="edb-source-row"><span>Status:</span> <span>No receipt matched</span></div>
                        </div>
                    `;
                }
            }

            return `
                <span class="edb-source-toggle" title="View data source details">ℹ️</span>
                <div class="edb-source-panel" style="display:none;">
                    ${panelContent}
                </div>
            `;
        },

        // Attach click handlers for source panel toggle (ℹ️ buttons)
        attachSourceToggleHandlers(container) {
            // Stop propagation on all links inside source panels and pair details
            container.querySelectorAll('.edb-source-link, .edb-pair-link, .edb-order-link-icon').forEach(link => {
                link.addEventListener('click', (e) => e.stopPropagation());
            });

            container.querySelectorAll('.edb-source-toggle').forEach(toggle => {
                toggle.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const panel = toggle.nextElementSibling;
                    if (panel && panel.classList.contains('edb-source-panel')) {
                        const isHidden = panel.style.display === 'none';
                        // Close any other open panels first
                        document.querySelectorAll('.edb-source-panel').forEach(p => {
                            p.style.display = 'none';
                            p.style.position = '';
                        });
                        if (isHidden) {
                            // Position using fixed so it escapes overflow:hidden containers
                            const rect = toggle.getBoundingClientRect();
                            panel.style.position = 'fixed';
                            panel.style.left = rect.left + 'px';
                            panel.style.top = (rect.bottom + 4) + 'px';
                            panel.style.display = 'block';

                            // If panel goes off-screen bottom, flip above
                            const panelRect = panel.getBoundingClientRect();
                            if (panelRect.bottom > window.innerHeight) {
                                panel.style.top = (rect.top - panelRect.height - 4) + 'px';
                            }
                            // If panel goes off-screen right, align to right edge
                            if (panelRect.right > window.innerWidth - 10) {
                                panel.style.left = (window.innerWidth - panelRect.width - 10) + 'px';
                            }

                            // Stop propagation on clicks inside the panel
                            panel.addEventListener('click', (evt) => evt.stopPropagation(), { once: false });

                            // Close on click outside
                            const closeHandler = (evt) => {
                                if (!panel.contains(evt.target) && evt.target !== toggle) {
                                    panel.style.display = 'none';
                                    panel.style.position = '';
                                    document.removeEventListener('click', closeHandler);
                                }
                            };
                            setTimeout(() => document.addEventListener('click', closeHandler), 0);
                        }
                    }
                });
            });
        },

        // Categorize all items in a receipt
        async categorizeReceipt(receipt) {
            const items = receipt.items || [];
            const categorizedItems = [];
            const AUTO_FILL_THRESHOLD = 0.70;  // 70% confidence to auto-fill category

            for (const item of items) {
                const result = await Categorizer.categorizeItem(item.name, item.price);
                const confidence = result?.confidence || 0;
                const suggestedCategory = result?.category || 'Uncategorized';

                // Apply 70% threshold: only auto-fill if confidence >= 0.70
                const category = confidence >= AUTO_FILL_THRESHOLD ? suggestedCategory : 'Uncategorized';

                categorizedItems.push({
                    ...item,
                    category,
                    confidence,  // Track confidence for auto-split logic
                    suggestedCategory,  // Keep the suggestion even if below threshold
                    // Track the original pattern/semantic category for learning mappings
                    originalCategory: result?.originalCategory || suggestedCategory
                });
            }

            // Group by category and sum
            const categoryTotals = {};
            for (const item of categorizedItems) {
                if (!categoryTotals[item.category]) {
                    categoryTotals[item.category] = { total: 0, items: [] };
                }
                categoryTotals[item.category].total += parseFloat(item.price) || 0;
                categoryTotals[item.category].items.push(item);
            }

            return { items: categorizedItems, categoryTotals };
        },

        // Check if all categorized items have the same category
        // Returns the category name if all same, null if mixed
        getAllSameCategory(categorization) {
            const categories = categorization.items
                .map(i => i.category)
                .filter(c => c && c !== 'Uncategorized');

            if (categories.length === 0) return null;  // All uncategorized
            const unique = [...new Set(categories)];
            return unique.length === 1 ? unique[0] : null;  // null = mixed categories
        },

        // Build a note with item details for transaction
        buildItemNote(items) {
            const lines = items.map(i => `• ${i.name}: $${parseFloat(i.price).toFixed(2)}`);
            return lines.join('\n');
        },

        // Render Stage 1: Awaiting Receipt
        // Show a one-click receipt fetch prompt near the FAB when store transactions need receipts
        showReceiptPrompt(awaitingItems) {
            document.getElementById('edb-receipt-prompt')?.remove();
            if (!awaitingItems || awaitingItems.length === 0) return;

            // Collect unique stores
            const stores = [...new Set(awaitingItems.map(i => i.store).filter(Boolean))];
            if (stores.length === 0) return;

            const storeIcons = stores.map(s => this.getStoreIcon(s)).join(' ');
            const txCount = awaitingItems.length;

            const prompt = document.createElement('div');
            prompt.id = 'edb-receipt-prompt';
            prompt.innerHTML = `
                <div class="edb-receipt-prompt-content">
                    <span class="edb-receipt-prompt-text">${storeIcons} ${txCount} transaction${txCount > 1 ? 's' : ''} need receipts</span>
                    <button class="edb-btn edb-btn-sm edb-btn-primary" id="edb-fetch-prompt-btn">📥 Fetch</button>
                    <button class="edb-receipt-prompt-dismiss" id="edb-dismiss-prompt">&times;</button>
                </div>
            `;

            const fab = document.getElementById('edb-fab');
            if (fab && fab.parentElement) {
                fab.parentElement.insertBefore(prompt, fab);
            } else {
                document.body.appendChild(prompt);
            }

            document.getElementById('edb-fetch-prompt-btn').addEventListener('click', () => {
                this.awaitingStores = stores;
                this.fetchAllStoreReceipts();
                prompt.remove();
            });
            document.getElementById('edb-dismiss-prompt').addEventListener('click', () => {
                prompt.remove();
                this._receiptPromptDismissed = true;
            });

            console.log(`[EDB] Receipt prompt shown: ${txCount} transactions across ${stores.join(', ')}`);
        },

        renderAwaitingStage(items) {
            const countEl = document.getElementById('edb-awaiting-count');
            const listEl = document.getElementById('edb-awaiting-list');
            const actionsEl = document.getElementById('edb-awaiting-actions');
            const stageEl = document.getElementById('edb-stage-awaiting');

            if (!listEl) return;

            if (countEl) countEl.textContent = items.length;

            if (items.length === 0) {
                listEl.innerHTML = '<p class="edb-empty">No store transactions awaiting receipts.</p>';
                if (actionsEl) actionsEl.innerHTML = '';
                stageEl?.classList.add('edb-stage-empty');
                return;
            }

            stageEl?.classList.remove('edb-stage-empty');

            // Count items by store for smart fetch button
            const storeCounts = {};
            for (const { store } of items) {
                if (store) {
                    storeCounts[store] = (storeCounts[store] || 0) + 1;
                }
            }

            // Generate single smart fetch button that shows detected stores
            if (actionsEl) {
                const stores = Object.keys(storeCounts);
                const storeList = stores.map(s => this.getStoreIcon(s)).join(' ');
                const storeNames = stores.map(s => this.getStoreName(s)).join(', ');

                // Store the list for when button is clicked
                this.awaitingStores = stores;

                actionsEl.innerHTML = `
                    <button class="edb-btn edb-btn-sm edb-fetch-receipts-btn" id="edb-fetch-all-receipts">
                        📥 Fetch Receipts (${storeList})
                    </button>
                    <span class="edb-fetch-hint">${storeNames}</span>
                `;

                // Attach event handler
                document.getElementById('edb-fetch-all-receipts')?.addEventListener('click', () => {
                    this.fetchAllStoreReceipts();
                });
            }

            // Render item list
            let html = '';
            for (const { tx, store, isPaired } of items) {
                const storeIcon = this.getStoreIcon(store);
                const amount = Math.abs(parseFloat(tx.amount));
                const txId = tx.id || '';
                const sourcePanel = this.buildSourcePanel(tx, null, store);

                // Check if this is a paired refund transaction
                if (isPaired && tx.pairInfo) {
                    const { purchaseAmount, refundAmount } = tx.pairInfo;
                    html += `
                        <div class="edb-pipeline-item edb-awaiting-item edb-paired-item" data-txid="${txId}">
                            <span class="edb-item-store">${storeIcon}</span>
                            <div class="edb-item-details">
                                <span class="edb-item-name" title="${tx.name.replace(/"/g, '&quot;')}">${tx.name}</span>
                                <span class="edb-item-date">${new Date(tx.date).toLocaleDateString()}</span>
                                ${sourcePanel}
                                <span class="edb-pair-badge" title="Purchase: $${purchaseAmount.toFixed(2)}, Refund: $${refundAmount.toFixed(2)}">
                                    🔄 $${purchaseAmount.toFixed(2)} - $${refundAmount.toFixed(2)}
                                </span>
                            </div>
                            <span class="edb-item-amount edb-net-amount">Net: $${amount.toFixed(2)}</span>
                            <button class="edb-btn edb-btn-xs edb-skip-receipt-btn" data-txid="${txId}" title="Categorize without receipt">Skip</button>
                        </div>
                    `;
                } else {
                    html += `
                        <div class="edb-pipeline-item edb-awaiting-item" data-txid="${txId}">
                            <span class="edb-item-store">${storeIcon}</span>
                            <div class="edb-item-details">
                                <span class="edb-item-name" title="${tx.name.replace(/"/g, '&quot;')}">${tx.name}</span>
                                <span class="edb-item-date">${new Date(tx.date).toLocaleDateString()}</span>
                                ${sourcePanel}
                            </div>
                            <span class="edb-item-amount">$${amount.toFixed(2)}</span>
                            <button class="edb-btn edb-btn-xs edb-skip-receipt-btn" data-txid="${txId}" title="Categorize without receipt">Skip</button>
                        </div>
                    `;
                }
            }

            listEl.innerHTML = html;

            // Attach event handlers for skip buttons
            listEl.querySelectorAll('.edb-skip-receipt-btn').forEach(btn => {
                btn.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    const txId = btn.dataset.txid;
                    const item = items.find(i => i.tx.id === txId);
                    if (item) {
                        // Mark as skipped in editedSplits so it goes to categorize next time
                        this.editedSplits.set(txId, {
                            skippedReceipt: true,
                            confirmed: false
                        });
                        await this.saveEditedSplits();
                        // Refresh pipeline
                        await this.processTransactionPipeline();
                    }
                });
            });

            // Attach source panel toggle handlers
            this.attachSourceToggleHandlers(listEl);
        },

        // Get display name for a store
        getStoreName(store) {
            const names = {
                'target': 'Target',
                'amazon': 'Amazon',
                'costco': 'Costco',
                'fredmeyer': 'Fred Meyer',
                'walmart': 'Walmart'
            };
            return names[store] || store;
        },

        // Render Stage 2: Categorize Items (combined - handles both single and multi-item)
        async renderCategorizeStage(items) {
            const countEl = document.getElementById('edb-categorize-count');
            const listEl = document.getElementById('edb-categorize-list');
            const stageEl = document.getElementById('edb-stage-categorize');

            if (!listEl) return;

            if (countEl) countEl.textContent = items.length;

            if (items.length === 0) {
                listEl.innerHTML = '<p class="edb-empty">No items need categorization.</p>';
                stageEl?.classList.add('edb-stage-empty');
                return;
            }

            stageEl?.classList.remove('edb-stage-empty');

            // Get budget categories scraped from the EveryDollar page
            const categoryOptions = await this.getBudgetCategoryNames();

            // Get top 3 most-used categories for quick buttons
            const topCategories = await this.getTopCategories(3);

            // Store for later use in edit modal
            this.categoryOptions = categoryOptions;

            let html = '';
            for (const item of items) {
                const { tx, receipt, categorization, isSimple } = item;

                // REFUND PENDING: Show candidate purchases for user to pair with
                if (item.isRefundPending) {
                    const refundAmount = Math.abs(parseFloat(tx.amount));
                    const candidatesList = item.refundCandidates || [];
                    const refundStore = item.refundStore;
                    const refundSourcePanel = this.buildSourcePanel(tx, null, refundStore);

                    html += `
                        <div class="edb-categorize-card edb-refund-pair-card" data-txid="${tx.id}">
                            <div class="edb-simple-row1">
                                <span class="edb-simple-name" title="${tx.name.replace(/"/g, '&quot;')}">🔄 ${tx.name}</span>
                                <span class="edb-simple-amount edb-amount-positive">+$${refundAmount.toFixed(2)}</span>
                            </div>
                            <div class="edb-simple-row2">
                                <div class="edb-simple-left">
                                    <span class="edb-simple-date">${new Date(tx.date).toLocaleDateString()}</span>
                                    ${refundSourcePanel}
                                </div>
                                <span class="edb-refund-label">Pair with a purchase:</span>
                            </div>
                            <div class="edb-refund-candidates">
                                ${candidatesList.length === 0
                                    ? '<div class="edb-refund-empty">No matching purchases found.</div>'
                                    : candidatesList.map(c => {
                                        const pAmt = Math.abs(parseFloat(c.purchase.amount));
                                        const net = (pAmt - refundAmount).toFixed(2);
                                        const pDate = new Date(c.purchase.date).toLocaleDateString();
                                        // Link to the specific order receipt, or fall back to store orders page
                                        const candidateStoreUrl = refundStore ? this.STORE_ORDER_URLS[refundStore] : null;
                                        const orderLink = c.receiptUrl
                                            ? `<a href="${c.receiptUrl}" target="_blank" class="edb-pair-link" title="View this order on merchant site">📦</a>`
                                            : (candidateStoreUrl
                                                ? `<a href="${candidateStoreUrl}" target="_blank" class="edb-pair-link" title="Open order history to find this purchase">📦</a>`
                                                : '');
                                        return `
                                            <div class="edb-refund-candidate">
                                                <span class="edb-candidate-name" title="${c.purchase.name.replace(/"/g, '&quot;')}">${c.purchase.name}</span>
                                                <span class="edb-candidate-date">${pDate}</span>
                                                ${orderLink}
                                                <span class="edb-candidate-amount">-$${pAmt.toFixed(2)}</span>
                                                <span class="edb-candidate-net">(net: $${net})</span>
                                                <button class="edb-btn edb-btn-xs edb-pair-btn" data-refund-id="${tx.id}" data-purchase-id="${c.purchase.id}">Pair</button>
                                            </div>
                                        `;
                                    }).join('')
                                }
                            </div>
                            <div class="edb-refund-actions">
                                <button class="edb-btn edb-btn-xs edb-btn-secondary edb-dismiss-refund-btn" data-txid="${tx.id}">No Match - Categorize Separately</button>
                            </div>
                        </div>
                    `;
                    continue;
                }

                // SIMPLE TRANSACTION: Non-store transaction without receipt (just needs category)
                if (isSimple) {
                    // Build badges for status area (Skipped only - Full Refund is shown via pair details)
                    const badges = [];

                    // Show "Skipped" badge and Unskip button for transactions that were explicitly skipped
                    const isSkipped = item.skippedReceipt === true;
                    if (isSkipped) {
                        badges.push('<span class="edb-skipped-badge" title="Receipt lookup was skipped">⏭️ Skipped</span>');
                    }
                    const unskipBtn = isSkipped ? `<button class="edb-btn edb-btn-xs edb-unskip-btn" data-txid="${tx.id}" title="Move back to Awaiting Receipt">↩️</button>` : '';

                    // Build pair details section for refund-paired transactions
                    const pairDetailsHtml = this.buildPairDetails(tx, receipt);

                    // Source panel for auditing
                    const simpleStore = this.getStoreForTransaction(tx);
                    const simpleSourcePanel = this.buildSourcePanel(tx, receipt, simpleStore);

                    html += `
                        <div class="edb-categorize-card edb-simple-item" data-txid="${tx.id}" data-simple="true" data-skipped="${isSkipped}">
                            <div class="edb-simple-row1">
                                <span class="edb-simple-name" title="${tx.name.replace(/"/g, '&quot;')}">${tx.name}</span>
                                <span class="edb-simple-amount">${this.formatAmount(tx.amount)}</span>
                            </div>
                            <div class="edb-simple-row2">
                                <div class="edb-simple-left">
                                    <span class="edb-simple-date">${new Date(tx.date).toLocaleDateString()}</span>
                                    ${simpleSourcePanel}
                                </div>
                                <div class="edb-simple-actions">
                                    <select class="edb-item-cat-select edb-simple-select" data-original="Uncategorized">
                                        <option value="Uncategorized" selected>Select...</option>
                                        ${categoryOptions.map(c => `<option value="${c}">${c}</option>`).join('')}
                                    </select>
                                </div>
                                ${badges.length > 0 || unskipBtn ? `<div class="edb-simple-status">${badges.join('')}${unskipBtn}</div>` : ''}
                                <button class="edb-btn edb-btn-sm edb-confirm-btn edb-confirm-right" data-txid="${tx.id}">Done</button>
                            </div>
                            ${pairDetailsHtml}
                        </div>
                    `;
                    continue;
                }

                const actualItemCount = categorization.items.length;
                const uncategorizedCount = categorization.items.filter(i => !i.category || i.category === 'Uncategorized').length;

                // Source panel for auditing (replaces simple order link icon)
                const receiptStore = this.getStoreForTransaction(tx);
                const receiptSourcePanel = this.buildSourcePanel(tx, receipt, receiptStore);

                // SINGLE-ITEM: Same two-row layout as simple transactions for consistency
                if (actualItemCount === 1) {
                    const receiptItem = categorization.items[0];
                    const category = receiptItem.category || 'Uncategorized';
                    const isUncategorized = category === 'Uncategorized';
                    const categoryInOptions = categoryOptions.includes(category);
                    const needsSelection = isUncategorized || !categoryInOptions;

                    // Build pair details section for refund-paired transactions
                    const singlePairDetailsHtml = this.buildPairDetails(tx, receipt);

                    html += `
                        <div class="edb-categorize-card edb-simple-item" data-txid="${tx.id}">
                            <div class="edb-simple-row1">
                                <span class="edb-simple-merchant" title="${tx.name.replace(/"/g, '&quot;')}">${tx.name}</span>
                                <span class="edb-simple-name" title="${receiptItem.name.replace(/"/g, '&quot;')}">${receiptItem.name}</span>
                                <span class="edb-simple-amount">${this.formatAmount(tx.amount)}</span>
                            </div>
                            <div class="edb-simple-row2">
                                <div class="edb-simple-left">
                                    <span class="edb-simple-date">${new Date(tx.date).toLocaleDateString()}</span>
                                    ${receiptSourcePanel}
                                </div>
                                <div class="edb-simple-actions">
                                    <select class="edb-item-cat-select edb-simple-select" data-item-name="${receiptItem.name.replace(/"/g, '&quot;')}" data-original="${category}">
                                        ${needsSelection ? `<option value="Uncategorized" selected>Select...</option>` : ''}
                                        ${categoryOptions.map(c => `<option value="${c}" ${c === category ? 'selected' : ''}>${c}</option>`).join('')}
                                    </select>
                                </div>
                                <button class="edb-btn edb-btn-sm edb-confirm-btn edb-confirm-right${!needsSelection ? ' edb-btn-ready' : ''}" data-txid="${tx.id}">Done</button>
                            </div>
                            ${singlePairDetailsHtml}
                        </div>
                    `;
                } else {
                    // MULTI-ITEM: Expandable card (collapsed by default)
                    // Build pair details section for refund-paired transactions
                    const multiPairDetailsHtml = this.buildPairDetails(tx, receipt);

                    html += `
                        <div class="edb-categorize-card edb-multi-item edb-collapsed" data-txid="${tx.id}">
                            <div class="edb-card-header edb-card-toggle">
                                <span class="edb-expand-icon">▶</span>
                                <strong title="${tx.name.replace(/"/g, '&quot;')}">${tx.name}</strong>
                                <span class="edb-card-meta">${new Date(tx.date).toLocaleDateString()} · ${actualItemCount} items</span>
                                ${receiptSourcePanel}
                                <span>${this.formatAmount(tx.amount)}</span>
                            </div>
                            ${multiPairDetailsHtml}
                            <div class="edb-card-body">
                                <!-- Quick category buttons -->
                                <div class="edb-quick-cats">
                                    <span class="edb-quick-label">Quick:</span>
                                    ${topCategories.map(cat => `<button class="edb-quick-cat-btn" data-category="${cat}">${cat.length > 12 ? cat.substring(0, 10) + '...' : cat}</button>`).join('')}
                                </div>
                                <!-- Select helpers -->
                                <div class="edb-select-helpers">
                                    <span class="edb-select-link edb-select-all">Select All</span>
                                    <span class="edb-select-link edb-select-uncategorized">Select Uncategorized</span>
                                    <span class="edb-select-link edb-select-none">Undo Changes</span>
                                </div>
                                <div class="edb-items-list">
                    `;

                    // Flat list of ALL items with checkboxes and individual dropdowns
                    for (const item of categorization.items) {
                        const category = item.category || 'Uncategorized';
                        const isUncategorized = category === 'Uncategorized';
                        const categoryInOptions = categoryOptions.includes(category);
                        const needsSelection = isUncategorized || !categoryInOptions;
                        const itemClass = needsSelection ? 'edb-item-uncategorized' : 'edb-item-assigned';

                        html += `
                            <div class="edb-item-row ${itemClass}" data-item-name="${item.name.replace(/"/g, '&quot;')}">
                                <input type="checkbox" class="edb-item-checkbox" data-item-name="${item.name.replace(/"/g, '&quot;')}">
                                <span class="edb-item-name" title="${item.name.replace(/"/g, '&quot;')}">${item.name}</span>
                                <span class="edb-item-price">$${parseFloat(item.price).toFixed(2)}</span>
                                <select class="edb-item-cat-select" data-item-name="${item.name.replace(/"/g, '&quot;')}" data-original="${category}">
                                    ${needsSelection ? `<option value="Uncategorized" selected>${!isUncategorized ? `was: ${category.substring(0, 15)}...` : 'Select...'}</option>` : ''}
                                    ${categoryOptions.map(c => `<option value="${c}" ${c === category ? 'selected' : ''}>${c}</option>`).join('')}
                                </select>
                            </div>
                        `;
                    }

                    html += `
                                </div>
                                <div class="edb-card-btns">
                                    <button class="edb-btn edb-btn-sm edb-confirm-btn" data-txid="${tx.id}">✓ Confirm</button>
                                    <button class="edb-btn edb-btn-sm edb-btn-secondary edb-edit-btn" data-txid="${tx.id}">✏️ Edit Items</button>
                                </div>
                            </div>
                        </div>
                    `;
                }
            }

            listEl.innerHTML = html;

            // Add Bulk Sort button combining Stage 2 + Stage 3 items
            // All Stage 2 items are eligible: simple txs, single-item receipts, AND multi-item receipts
            // (multi-item receipts get treated as single-category in Kanban; user can Edit Items for splits)
            const eligibleItems = items.filter(i => !i.isRefundPending);

            // Include Ready-to-Apply items (de-duplicate splits by tx.id)
            const readyItems = this.lastReadyItems || [];
            const seenTxIds = new Set(eligibleItems.map(i => i.tx.id));
            const readyForKanban = [];
            for (const item of readyItems) {
                if (!seenTxIds.has(item.tx.id)) {
                    seenTxIds.add(item.tx.id);
                    readyForKanban.push(item);
                }
            }
            const allKanbanItems = [...eligibleItems, ...readyForKanban];
            console.log(`[EDB Kanban] Stage 2 eligible: ${eligibleItems.length}, Ready for kanban: ${readyForKanban.length}, Total: ${allKanbanItems.length}`);
            console.log(`[EDB Kanban] Stage 2 items:`, eligibleItems.map(i => `${i.tx.name} (${i.isSimple ? 'simple' : 'receipt'}, items: ${i.itemCount || 1})`));

            if (allKanbanItems.length >= 3 && stageEl) {
                const stageHeader = stageEl.querySelector('.edb-stage-header');
                if (stageHeader) {
                    // Remove old button if exists
                    stageHeader.querySelector('.edb-bulk-sort-btn')?.remove();
                    const bulkBtn = document.createElement('button');
                    bulkBtn.className = 'edb-bulk-sort-btn';
                    bulkBtn.textContent = `Bulk Sort (${allKanbanItems.length})`;
                    const collapseArrow = stageHeader.querySelector('.edb-collapse-arrow');
                    if (collapseArrow) {
                        stageHeader.insertBefore(bulkBtn, collapseArrow);
                    } else {
                        stageHeader.appendChild(bulkBtn);
                    }
                    bulkBtn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        this.openKanbanModal(allKanbanItems);
                    });
                }
            }

            // Add card expand/collapse toggle handlers (multi-item cards only)
            listEl.querySelectorAll('.edb-card-toggle').forEach(toggle => {
                toggle.addEventListener('click', (e) => {
                    const card = toggle.closest('.edb-categorize-card');
                    card.classList.toggle('edb-collapsed');
                    const icon = toggle.querySelector('.edb-expand-icon');
                    icon.textContent = card.classList.contains('edb-collapsed') ? '▶' : '▼';
                });
            });

            // Add pair details toggle handlers (refund-paired transactions)
            listEl.querySelectorAll('.edb-pair-details-toggle').forEach(toggle => {
                toggle.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const details = toggle.nextElementSibling;
                    if (details && details.classList.contains('edb-pair-details')) {
                        const isHidden = details.style.display === 'none';
                        details.style.display = isHidden ? 'block' : 'none';
                        toggle.classList.toggle('edb-pair-expanded', isHidden);
                    }
                });
            });

            // Add refund pairing button handlers
            listEl.querySelectorAll('.edb-pair-btn').forEach(btn => {
                btn.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    const refundId = btn.dataset.refundId;
                    const purchaseId = btn.dataset.purchaseId;

                    this.editedSplits.set(refundId, { manualPair: true, purchaseId });
                    await StorageManager.set(StorageManager.KEYS.EDITED_SPLITS,
                        Object.fromEntries(this.editedSplits));

                    // Re-run pipeline to reflect the pairing
                    await this.processTransactionPipeline();
                });
            });

            // Add refund dismiss button handlers
            listEl.querySelectorAll('.edb-dismiss-refund-btn').forEach(btn => {
                btn.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    const txId = btn.dataset.txid;

                    this.editedSplits.set(txId, { dismissed: true });
                    await StorageManager.set(StorageManager.KEYS.EDITED_SPLITS,
                        Object.fromEntries(this.editedSplits));

                    // Re-run pipeline - refund will flow through as normal transaction
                    await this.processTransactionPipeline();
                });
            });

            // Attach source panel toggle handlers
            this.attachSourceToggleHandlers(listEl);

            // Add individual item dropdown change handlers
            listEl.querySelectorAll('.edb-item-cat-select').forEach(select => {
                select.addEventListener('change', async (e) => {
                    const card = e.target.closest('.edb-categorize-card');
                    const txId = card.dataset.txid;
                    const isSimple = card.dataset.simple === 'true';
                    const item = items.find(i => i.tx.id === txId);

                    if (item) {
                        const itemName = e.target.dataset.itemName || item.tx.name;
                        const newCat = e.target.value;
                        const originalCat = e.target.dataset.original;


                        // Update visual state (for multi-item cards)
                        const itemRow = e.target.closest('.edb-item-row');
                        if (itemRow) {
                            if (newCat !== 'Uncategorized') {
                                itemRow.classList.remove('edb-item-uncategorized');
                                itemRow.classList.add('edb-item-assigned');
                            } else {
                                itemRow.classList.add('edb-item-uncategorized');
                                itemRow.classList.remove('edb-item-assigned');
                            }
                        }

                        // Update confirm button state (for single-item cards)
                        const confirmBtn = card.querySelector('.edb-confirm-btn');
                        if (confirmBtn) {
                            if (newCat !== 'Uncategorized') {
                                confirmBtn.classList.add('edb-btn-ready');
                            } else {
                                confirmBtn.classList.remove('edb-btn-ready');
                            }
                        }

                        // Capture and save immediately (skip for simple transactions - they're handled on confirm)
                        if (!isSimple) {
                            await this.captureCardEdits(txId, item);
                        }
                    }
                });
            });

            // Add confirm button handlers (simple, single, and multi-item)
            listEl.querySelectorAll('.edb-confirm-btn').forEach(btn => {
                btn.addEventListener('click', async (e) => {
                    const txId = e.target.dataset.txid;
                    const item = items.find(i => i.tx.id === txId);
                    if (item) {
                        if (item.isSimple) {
                            // Simple transaction - get category from dropdown and confirm
                            const card = e.target.closest('.edb-categorize-card');
                            const select = card.querySelector('.edb-simple-select');
                            const category = select?.value;

                            if (!category || category === 'Uncategorized') {
                                return;
                            }

                            await this.confirmSimpleTransaction(txId, item.tx, category);
                        } else {
                            // Receipt-based transaction - capture edits and confirm
                            await this.captureCardEdits(txId, item);
                            await this.confirmSplit(txId, item);
                        }
                    }
                });
            });

            // Add edit button handlers (multi-item cards only)
            listEl.querySelectorAll('.edb-edit-btn').forEach(btn => {
                btn.addEventListener('click', async (e) => {
                    const txId = e.target.dataset.txid;
                    const item = items.find(i => i.tx.id === txId);
                    if (item) {
                        // Capture current dropdown values before opening modal
                        await this.captureCardEdits(txId, item);
                        await this.openSplitEditor(item);
                    }
                });
            });

            // Add unskip button handlers - move transaction back to Awaiting Receipt
            listEl.querySelectorAll('.edb-unskip-btn').forEach(btn => {
                btn.addEventListener('click', async (e) => {
                    const txId = e.target.dataset.txid;

                    // Remove the skippedReceipt flag from editedSplits
                    if (this.editedSplits.has(txId)) {
                        this.editedSplits.delete(txId);
                    }
                    await this.saveEditedSplits();

                    // Refresh the pipeline to move transaction back to Awaiting Receipt
                    await this.processPipeline();
                });
            });

            // Add quick category button handlers
            listEl.querySelectorAll('.edb-quick-cat-btn').forEach(btn => {
                btn.addEventListener('click', async (e) => {
                    const category = e.target.dataset.category;
                    const card = e.target.closest('.edb-categorize-card');
                    const txId = card.dataset.txid;
                    const item = items.find(i => i.tx.id === txId);

                    // Get all checked items in this card
                    const checkedItems = card.querySelectorAll('.edb-item-checkbox:checked');

                    if (checkedItems.length === 0) {
                        return;
                    }


                    // Apply category to each checked item
                    checkedItems.forEach(checkbox => {
                        const itemRow = checkbox.closest('.edb-item-row');
                        const select = itemRow.querySelector('.edb-item-cat-select');
                        if (select) {
                            select.value = category;
                            // Trigger change event to update styling and persist
                            select.dispatchEvent(new Event('change', { bubbles: true }));
                        }
                        // Uncheck after applying
                        checkbox.checked = false;
                    });

                    // Capture edits
                    if (item) {
                        await this.captureCardEdits(txId, item);
                    }
                });
            });

            // Add select helper handlers
            listEl.querySelectorAll('.edb-select-all').forEach(link => {
                link.addEventListener('click', (e) => {
                    const card = e.target.closest('.edb-categorize-card');
                    card.querySelectorAll('.edb-item-checkbox').forEach(cb => cb.checked = true);
                });
            });

            listEl.querySelectorAll('.edb-select-uncategorized').forEach(link => {
                link.addEventListener('click', (e) => {
                    const card = e.target.closest('.edb-categorize-card');
                    card.querySelectorAll('.edb-item-row').forEach(row => {
                        const checkbox = row.querySelector('.edb-item-checkbox');
                        const isUncategorized = row.classList.contains('edb-item-uncategorized');
                        if (checkbox) {
                            checkbox.checked = isUncategorized;
                        }
                    });
                });
            });

            listEl.querySelectorAll('.edb-select-none').forEach(link => {
                link.addEventListener('click', async (e) => {
                    const card = e.target.closest('.edb-categorize-card');
                    const txId = card.dataset.txid;
                    const item = items.find(i => i.tx.id === txId);

                    // Clear all checkboxes
                    card.querySelectorAll('.edb-item-checkbox').forEach(cb => cb.checked = false);

                    // Restore all dropdowns to their ORIGINAL category (undo user changes)
                    card.querySelectorAll('.edb-item-cat-select').forEach(select => {
                        const originalCat = select.dataset.original || 'Uncategorized';
                        select.value = originalCat;
                        // Update visual state
                        const itemRow = select.closest('.edb-item-row');
                        if (itemRow) {
                            if (originalCat === 'Uncategorized' || !categoryOptions.includes(originalCat)) {
                                itemRow.classList.add('edb-item-uncategorized');
                                itemRow.classList.remove('edb-item-assigned');
                            } else {
                                itemRow.classList.remove('edb-item-uncategorized');
                                itemRow.classList.add('edb-item-assigned');
                            }
                        }
                    });

                    // Restore categorization items to original values
                    if (item) {
                        const { categorization } = item;
                        for (const catItem of categorization.items) {
                            catItem.category = catItem.originalCategory || 'Uncategorized';
                            catItem.userEdited = false;
                        }
                        // Clear the edited splits for this transaction to reset it
                        this.editedSplits.delete(txId);
                        await this.saveEditedSplits();
                    }

                });
            });
        },

        // Capture edits made in the categorize card dropdowns and apply to categorization
        async captureCardEdits(txId, item) {
            const card = document.querySelector(`.edb-categorize-card[data-txid="${txId}"]`);
            if (!card) {
                return;
            }

            const { tx, receipt, categorization } = item;
            // Support both old (.edb-cat-select) and new (.edb-item-cat-select) selectors
            const selects = card.querySelectorAll('.edb-item-cat-select');
            const updates = [];


            selects.forEach(select => {
                const itemName = select.dataset.itemName;
                const originalCat = select.dataset.original;
                const newCat = select.value;

                // Don't overwrite a meaningful category with "Uncategorized" unless user explicitly changed it
                const effectiveCat = (newCat === 'Uncategorized' && originalCat && originalCat !== 'Uncategorized')
                    ? originalCat
                    : newCat;

                // Find and update the item in categorization
                const itemInCat = categorization.items.find(i => i.name === itemName);
                if (itemInCat) {
                    itemInCat.originalCategory = itemInCat.originalCategory || originalCat;
                    itemInCat.category = effectiveCat;
                    itemInCat.userEdited = true;
                    if (effectiveCat !== 'Uncategorized') {
                        updates.push({ itemName, category: effectiveCat, originalCat });
                    }
                }
            });

            // Always save the current state (even if no "changes" detected)
            // Preserve the confirmed flag if it was already set
            const existingData = this.editedSplits.get(txId);
            const preservedConfirmed = existingData?.confirmed || false;

            this.editedSplits.set(txId, {
                tx,
                receipt,
                categorization,
                updates,
                confirmed: preservedConfirmed  // Preserve confirmed state
            });
            await this.saveEditedSplits();
        },

        // Open editor for a split transaction - full item-level editing
        async openSplitEditor(item) {
            const { tx, receipt, categorization } = item;
            // Use categorization.items which already has the computed categories
            const items = categorization.items || [];
            // Ensure we have category options loaded
            const categoryOptions = this.categoryOptions?.length > 0
                ? this.categoryOptions
                : await this.getBudgetCategoryNames();


            // Create modal overlay
            const modal = document.createElement('div');
            modal.className = 'edb-modal-overlay';
            modal.innerHTML = `
                <div class="edb-modal">
                    <div class="edb-modal-header">
                        <h3>Edit Split: ${tx.name}</h3>
                        <button class="edb-modal-close">&times;</button>
                    </div>
                    <div class="edb-modal-body">
                        <div class="edb-modal-summary">
                            <span>Total: <strong>$${tx.amount.toFixed(2)}</strong></span>
                            <span>${new Date(tx.date).toLocaleDateString()}</span>
                        </div>
                        <div class="edb-modal-items">
                            ${items.map((item, idx) => {
                // Use the category directly from categorization.items
                const currentCat = item.category || 'Uncategorized';
                // Track the original detected category for learning mappings
                const originalCat = item.originalCategory || currentCat;
                // Check if category exists in options - if not, show as needing selection
                const catInOptions = categoryOptions.includes(currentCat);
                const showAsUncategorized = currentCat === 'Uncategorized' || !catInOptions;
                return `
                                    <div class="edb-modal-item" data-idx="${idx}">
                                        <div class="edb-modal-item-info">
                                            <span class="edb-modal-item-name">${item.name}</span>
                                            <span class="edb-modal-item-price">$${parseFloat(item.price).toFixed(2)}</span>
                                        </div>
                                        <select class="edb-modal-item-cat" data-item-name="${item.name.replace(/"/g, '&quot;')}" data-original-cat="${originalCat}">
                                            <option value="Uncategorized" ${showAsUncategorized ? 'selected' : ''}>${showAsUncategorized && currentCat !== 'Uncategorized' ? `Select (was: ${currentCat})` : 'Uncategorized'}</option>
                                            ${categoryOptions.map(c => `<option value="${c}" ${c === currentCat ? 'selected' : ''}>${c}</option>`).join('')}
                                        </select>
                                    </div>
                                `;
            }).join('')}
                        </div>
                    </div>
                    <div class="edb-modal-footer">
                        <button class="edb-btn edb-btn-secondary edb-modal-cancel">Cancel</button>
                        <button class="edb-btn edb-btn-primary edb-modal-save">Save Changes</button>
                    </div>
                </div>
            `;

            document.body.appendChild(modal);

            // Close handlers - also refresh pipeline since confirmed flag may have changed
            const closeModal = async (refresh = true) => {
                modal.remove();
                if (refresh) {
                    await this.processTransactionPipeline();
                }
            };
            modal.querySelector('.edb-modal-close').addEventListener('click', () => closeModal(true));
            modal.querySelector('.edb-modal-cancel').addEventListener('click', () => closeModal(true));
            modal.addEventListener('click', (e) => {
                if (e.target === modal) closeModal(true);
            });

            // Save handler - stores edits for later learning (when Apply is clicked)
            modal.querySelector('.edb-modal-save').addEventListener('click', async () => {
                const itemSelects = modal.querySelectorAll('.edb-modal-item-cat');
                const updates = [];

                // Update the categorization.items with user's selections
                for (const select of itemSelects) {
                    const itemName = select.dataset.itemName;
                    const selectedValue = select.value;
                    const originalCat = select.dataset.originalCat;

                    // Don't overwrite a meaningful category with "Uncategorized" unless user explicitly changed it
                    // The dropdown shows "Uncategorized" when the original category isn't in options,
                    // but we should preserve the original category in that case
                    const effectiveCat = (selectedValue === 'Uncategorized' && originalCat && originalCat !== 'Uncategorized')
                        ? originalCat  // Preserve original if dropdown just shows placeholder
                        : selectedValue;


                    // Find this item in categorization and update it
                    const itemInCat = categorization.items.find(i => i.name === itemName);
                    if (itemInCat) {
                        itemInCat.category = effectiveCat;
                        itemInCat.userEdited = true;  // Mark as user-edited
                        itemInCat.originalCategory = originalCat;  // Keep for learning
                    }

                    if (effectiveCat !== 'Uncategorized') {
                        updates.push({ itemName, category: effectiveCat, originalCat });
                    }
                }

                // Rebuild categoryTotals from updated items
                const categoryTotals = {};
                for (const item of categorization.items) {
                    const cat = item.category || 'Uncategorized';
                    if (!categoryTotals[cat]) {
                        categoryTotals[cat] = { total: 0, items: [] };
                    }
                    categoryTotals[cat].total += parseFloat(item.price) || 0;
                    categoryTotals[cat].items.push(item);
                }
                categorization.categoryTotals = categoryTotals;

                // Debug: Log what we're saving

                // Store the edited categorization for this transaction
                // Auto-confirm when ALL items have been categorized
                const existingData = this.editedSplits.get(tx.id);
                const allCategorized = categorization.items.every(i => i.category && i.category !== 'Uncategorized');
                const autoConfirmed = allCategorized || (existingData?.confirmed || false);


                this.editedSplits.set(tx.id, {
                    tx,
                    receipt,
                    categorization,  // Now contains user's edits
                    updates,  // Track what was changed for learning later
                    confirmed: autoConfirmed
                });

                await this.saveEditedSplits();

                await closeModal(false);  // Don't double-refresh, we do it below

                // Refresh the pipeline to show updated categorizations
                await this.processTransactionPipeline();
            });
        },

        // ==================== KANBAN BULK CATEGORIZE ====================

        // Normalize merchant name for grouping (strip noise like ONLINE, ORD, store #s, etc.)
        normalizeForGrouping(name) {
            return name
                .replace(/\s*(online|mobile|order|ord|pos|debit|purchase|sq \*|tst\*|ach|electronic|payment)\s*/gi, ' ')
                .replace(/#\d+/g, '')
                .replace(/\b\d{4,}\b/g, '')
                .replace(/\s+/g, ' ')
                .trim();
        },

        // Group txIds by merchant name, returns Map<merchantKey, txId[]>
        groupByMerchant(txIds, kanbanData) {
            const groups = new Map();
            for (const txId of txIds) {
                const data = kanbanData.get(txId);
                if (!data) continue;
                const key = this.normalizeForGrouping(data.item.tx.name);
                if (!groups.has(key)) groups.set(key, []);
                groups.get(key).push(txId);
            }
            return groups;
        },

        // Build refund-purchase pairs within merchant groups for Kanban display
        // Returns { refundPairs: Map<refundTxId, purchaseTxId>, returnTxIds: Set<txId> }
        // returnTxIds = positive-amount txs from merchants that also have purchases (actual store returns)
        buildKanbanRefundPairs(kanbanData) {
            const refundPairs = new Map();
            const returnTxIds = new Set(); // Only positive txs that are actual store returns
            const allTxIds = Array.from(kanbanData.keys());
            const merchantGroups = this.groupByMerchant(allTxIds, kanbanData);

            for (const [, txIds] of merchantGroups) {
                const purchases = [];
                const refunds = [];

                for (const txId of txIds) {
                    const data = kanbanData.get(txId);
                    const tx = data.item.tx;
                    const amount = parseFloat(tx.amount);
                    const date = new Date(tx.date);

                    if (amount > 0) {
                        refunds.push({ txId, amount, date });
                    } else {
                        purchases.push({ txId, amount: Math.abs(amount), date });
                    }
                }

                if (refunds.length === 0) continue;

                // Determine which positive transactions are actual store returns vs income
                for (const r of refunds) {
                    const data = kanbanData.get(r.txId);
                    const txName = (data?.item?.tx?.name || '').toLowerCase();
                    // Income keywords — these are NOT returns regardless of merchant
                    if (/deposit|dividend|transfer|ach |payroll|income|interest|payment/i.test(txName)) {
                        continue; // Skip — this is income/banking, not a store return
                    }
                    // Only treat as return if merchant also has purchases
                    if (purchases.length > 0) {
                        returnTxIds.add(r.txId);
                    }
                }

                const usedPurchases = new Set();
                for (const refund of refunds) {
                    let bestMatch = null;
                    let bestScore = 0;

                    for (const purchase of purchases) {
                        if (usedPurchases.has(purchase.txId)) continue;

                        // Return can't exceed purchase amount (you don't make money on returns)
                        // Allow tiny overage (<$0.50) for tax rounding edge cases
                        if (refund.amount > purchase.amount + 0.50) continue;

                        // Return should be close to purchase amount — within 20% or $5
                        const amountDiff = Math.abs(purchase.amount - refund.amount);
                        if (amountDiff > purchase.amount * 0.2 && amountDiff > 5) continue;

                        let score = 0;
                        if (amountDiff < 0.01) score += 50;
                        else if (amountDiff < 0.50) score += 40;
                        else if (amountDiff < 1) score += 30;
                        else if (amountDiff < 3) score += 15;
                        else score += 5;

                        const daysDiff = (refund.date - purchase.date) / (1000 * 60 * 60 * 24);
                        if (daysDiff >= 0 && daysDiff < 7) score += 30;
                        else if (daysDiff >= 0 && daysDiff < 14) score += 20;
                        else if (daysDiff >= 0 && daysDiff < 30) score += 10;
                        else if (Math.abs(daysDiff) < 3) score += 15;

                        if (score > bestScore) {
                            bestScore = score;
                            bestMatch = purchase;
                        }
                    }

                    if (bestMatch && bestScore >= 20) {
                        refundPairs.set(refund.txId, bestMatch.txId);
                        usedPurchases.add(bestMatch.txId);
                    }
                }
            }

            return { refundPairs, returnTxIds };
        },

        // Reorder txIds so each purchase is followed by its paired refund(s)
        orderWithRefundPairs(txIds, refundPairs) {
            // Build reverse map: purchaseTxId -> [refundTxId, ...]
            const purchaseToRefunds = new Map();
            const pairedRefundIds = new Set();

            for (const [refundId, purchaseId] of refundPairs) {
                if (txIds.includes(refundId) && txIds.includes(purchaseId)) {
                    if (!purchaseToRefunds.has(purchaseId)) purchaseToRefunds.set(purchaseId, []);
                    purchaseToRefunds.get(purchaseId).push(refundId);
                    pairedRefundIds.add(refundId);
                }
            }

            const ordered = [];
            const added = new Set();

            for (const txId of txIds) {
                if (added.has(txId) || pairedRefundIds.has(txId)) continue;
                ordered.push(txId);
                added.add(txId);
                // Add paired refunds right after this purchase
                if (purchaseToRefunds.has(txId)) {
                    for (const refundId of purchaseToRefunds.get(txId)) {
                        ordered.push(refundId);
                        added.add(refundId);
                    }
                }
            }

            // Add any remaining unpaired refunds at the end
            for (const txId of txIds) {
                if (!added.has(txId)) ordered.push(txId);
            }

            return ordered;
        },

        // Build HTML for a list of cards, wrapping purchase+refund pairs in a visual container
        buildKanbanCardsWithPairs(orderedIds, kanbanData, refundPairs, returnTxIds) {
            // Build reverse map: purchaseId -> [refundIds]
            const purchaseToRefunds = new Map();
            const pairedRefundIds = new Set();
            for (const [refundId, purchaseId] of refundPairs) {
                if (orderedIds.includes(refundId) && orderedIds.includes(purchaseId)) {
                    if (!purchaseToRefunds.has(purchaseId)) purchaseToRefunds.set(purchaseId, []);
                    purchaseToRefunds.get(purchaseId).push(refundId);
                    pairedRefundIds.add(refundId);
                }
            }

            let html = '';
            for (const id of orderedIds) {
                if (pairedRefundIds.has(id)) continue; // rendered with its purchase

                const data = kanbanData.get(id);
                if (!data) continue;
                const isReturn = returnTxIds.has(id);

                if (purchaseToRefunds.has(id)) {
                    // This purchase has paired refunds — wrap them together
                    const refundIds = purchaseToRefunds.get(id);
                    const purchaseDesc = this.getKanbanCardDesc(id, kanbanData);
                    const purchaseCard = this.buildKanbanCardHtml(id, kanbanData, { isPaired: false, isReturn: false });
                    const refundCards = refundIds.map(rid =>
                        this.buildKanbanCardHtml(rid, kanbanData, { isPaired: true, isReturn: true, pairedPurchaseDesc: purchaseDesc })
                    ).join('');

                    // Net amount for the pair
                    const netAmount = [id, ...refundIds].reduce((sum, tid) => {
                        const d = kanbanData.get(tid);
                        return sum + (d ? d.item.tx.amount : 0);
                    }, 0);
                    const netStr = netAmount >= 0 ? `+$${netAmount.toFixed(2)}` : `-$${Math.abs(netAmount).toFixed(2)}`;
                    const netClass = netAmount >= 0 ? 'edb-amount-positive' : '';

                    html += `<div class="edb-kanban-pair-wrapper">
                        ${purchaseCard}
                        ${refundCards}
                        <div class="edb-kanban-pair-net">Net: <span class="${netClass}">${netStr}</span></div>
                    </div>`;
                } else {
                    // Standalone card (no paired refund/purchase)
                    html += this.buildKanbanCardHtml(id, kanbanData, { isPaired: false, isReturn });
                }
            }
            return html;
        },

        // Get a short description for a kanban card (for "Return for:" labels)
        getKanbanCardDesc(txId, kanbanData) {
            const data = kanbanData.get(txId);
            if (!data) return '';
            const tx = data.item.tx;
            const absAmount = `$${Math.abs(tx.amount).toFixed(2)}`;
            const dateStr = tx.date ? new Date(tx.date).toLocaleDateString('en-US', { month: 'numeric', day: 'numeric' }) : '';

            // Try to get receipt item names
            const items = data.item?.categorization?.items;
            if (items && items.length > 0) {
                const names = items.map(i => i.name).filter(Boolean);
                if (names.length > 0) {
                    const desc = names.slice(0, 2).join(', ');
                    const more = names.length > 2 ? ` +${names.length - 2} more` : '';
                    return `${absAmount} ${dateStr} — ${desc}${more}`.replace(/</g, '&lt;');
                }
            }
            return `${absAmount} on ${dateStr}`.replace(/</g, '&lt;');
        },

        // Build HTML for a single Kanban card
        buildKanbanCardHtml(txId, kanbanData, options = {}) {
            const data = kanbanData.get(txId);
            if (!data) return '';
            const tx = data.item.tx;
            const item = data.item;
            const absAmount = Math.abs(tx.amount).toFixed(2);
            const amountClass = tx.amount > 0 ? ' edb-amount-positive' : '';
            const sign = tx.amount > 0 ? '+' : '-';
            const dateStr = tx.date ? new Date(tx.date).toLocaleDateString('en-US', { month: 'numeric', day: 'numeric' }) : '';
            const safeName = (tx.name || '').replace(/"/g, '&quot;').replace(/</g, '&lt;');

            // Return vs income detection
            // Only treat as "return" if options.isReturn is set (merchant has purchases too)
            // Positive amounts from deposit/dividend/income merchants are NOT returns
            const isPositive = tx.amount > 0;
            const isReturn = isPositive && !!options.isReturn;
            const refundBadge = isReturn ? '<span class="edb-kanban-refund-badge">\u21a9 Return</span>' : '';
            const refundClass = isReturn ? ' edb-kanban-card-refund' : '';
            const pairedClass = (isReturn && options.isPaired) ? ' edb-kanban-card-paired' : '';
            const unpairedClass = (isReturn && !options.isPaired) ? ' edb-kanban-card-unpaired' : '';
            const incomeClass = (isPositive && !isReturn) ? ' edb-kanban-card-income' : '';

            // Show what the return is for
            let returnForHtml = '';
            if (isReturn && options.pairedPurchaseDesc) {
                returnForHtml = `<div class="edb-kanban-card-return-for">\u21a9 Return for: ${options.pairedPurchaseDesc}</div>`;
            } else if (isReturn && !options.isPaired) {
                returnForHtml = '<div class="edb-kanban-card-return-for edb-kanban-unmatched">\u26a0 Unmatched return</div>';
            }

            // Pre-categorized badge (Ready items from Stage 3) — clickable for rule audit
            const isReady = item.category && item.confidence !== undefined;
            const readyClass = isReady ? ' edb-kanban-card-ready' : '';
            const confidencePct = isReady ? Math.round(item.confidence * 100) : 0;
            const readyBadge = isReady ? `<span class="edb-kanban-ready-badge edb-kanban-audit-trigger" data-txid="${txId}" title="Click to audit rule">${confidencePct}%</span>` : '';

            // Get item names from receipt if available
            let itemsHtml = '';
            if (item.categorization && item.categorization.items) {
                const itemNames = item.categorization.items
                    .map(i => (i.name || '').replace(/</g, '&lt;'))
                    .filter(n => n);
                if (itemNames.length > 0) {
                    itemsHtml = `<div class="edb-kanban-card-items">${itemNames.join(', ')}</div>`;
                }
            }

            return `<div class="edb-kanban-card${refundClass}${pairedClass}${unpairedClass}${incomeClass}${readyClass}" data-txid="${txId}" draggable="true">
                <div class="edb-kanban-card-row">
                    <span class="edb-kanban-card-name">${safeName}</span>
                    ${refundBadge}
                    ${readyBadge}
                    <span class="edb-kanban-card-amount${amountClass}">${sign}$${absAmount}</span>
                    <span class="edb-kanban-card-date">${dateStr}</span>
                </div>
                ${returnForHtml}
                ${itemsHtml}
            </div>`;
        },

        // Toggle audit detail panel for a Kanban card
        async toggleKanbanAudit(txId, triggerEl) {
            const card = triggerEl.closest('.edb-kanban-card');
            if (!card) return;

            // Toggle off if already open
            const existing = card.querySelector('.edb-kanban-audit');
            if (existing) {
                existing.remove();
                return;
            }

            // Close any other open audit panels
            document.querySelectorAll('.edb-kanban-audit').forEach(el => el.remove());

            const data = this.kanbanState?.kanbanData?.get(txId);
            if (!data) return;

            const { item, suggestion } = data;
            const topSource = item.source || suggestion?.source || suggestion?.allSuggestions?.[0]?.source || 'unknown';
            const sourceDesc = this.getSourceDescription(topSource);

            // Build reason display
            const reasons = item.reasons || suggestion?.reasons || [];
            const primaryReason = item.reason || suggestion?.reason || reasons[0] || 'No reason recorded';

            // Build all suggestions display
            const allSuggestions = suggestion?.allSuggestions || [];
            let allSuggestionsHtml = '';
            if (allSuggestions.length > 1) {
                const otherSugs = allSuggestions
                    .map(s => `<div class="edb-audit-suggestion-row">${this.getSourceDescription(s.source)} → ${s.category} (${Math.round(s.confidence * 100)}%)</div>`)
                    .join('');
                allSuggestionsHtml = `<div class="edb-audit-all-suggestions"><div class="edb-audit-label">All matches:</div>${otherSugs}</div>`;
            }

            // Build category dropdown
            const allCategories = this.kanbanState?.allCategories || [];
            const currentCat = this.kanbanState.assignments.get(txId) || item.category || '';
            // If current category isn't in the list (e.g. pattern match returned a non-budget-item), add it
            const dropdownCats = allCategories.includes(currentCat) ? allCategories : [currentCat, ...allCategories];
            const catOptions = dropdownCats.filter(c => c).map(c =>
                `<option value="${c.replace(/"/g, '&quot;')}"${c === currentCat ? ' selected' : ''}>${c}</option>`
            ).join('');

            // Determine rule key for deletion
            const merchantName = (item.tx?.name || '').toLowerCase().trim();
            const ruleKey = suggestion?.matchedKey || merchantName;

            const auditHtml = `<div class="edb-kanban-audit" data-txid="${txId}">
                <div class="edb-audit-source">${sourceDesc}</div>
                <div class="edb-audit-reason">${primaryReason}</div>
                ${allSuggestionsHtml}
                <div class="edb-audit-actions">
                    <button class="edb-btn-xs edb-audit-delete" data-txid="${txId}" data-rule-key="${ruleKey.replace(/"/g, '&quot;')}" title="Delete the rule that caused this match">Delete Rule</button>
                    <select class="edb-audit-reassign" data-txid="${txId}">${catOptions}</select>
                    <button class="edb-btn-xs edb-audit-uncategorize" data-txid="${txId}" title="Move back to Uncategorized">Uncategorize</button>
                </div>
            </div>`;

            card.insertAdjacentHTML('beforeend', auditHtml);

            // Attach action handlers
            const auditEl = card.querySelector('.edb-kanban-audit');

            auditEl.querySelector('.edb-audit-delete').addEventListener('click', async (e) => {
                e.stopPropagation();
                const key = e.target.dataset.ruleKey;
                const source = topSource;

                // Delete the appropriate rule type
                if (source === 'merchant_rule' || source === 'learned_exact' || source === 'learned_similar') {
                    await StorageManager.deleteMerchantRule(key);
                } else if (source === 'item_rule') {
                    await StorageManager.deleteItemRule(key);
                } else if (source === 'keyword_weights') {
                    // Delete all keywords from the merchant name
                    const keywords = StorageManager.extractKeywords(item.tx?.name || '');
                    for (const kw of keywords) {
                        await StorageManager.deleteKeywordWeight(kw);
                    }
                }

                console.log(`[EDB Audit] Deleted rule: "${key}" (source: ${source})`);

                // Move card to uncategorized
                this.kanbanState.assignments.set(txId, null);
                auditEl.remove();
                this.refreshKanbanColumns();
            });

            auditEl.querySelector('.edb-audit-reassign').addEventListener('change', (e) => {
                e.stopPropagation();
                const newCat = e.target.value;
                this.kanbanState.assignments.set(txId, newCat);

                // Ensure column exists
                if (!this.kanbanState.columns.includes(newCat)) {
                    this.addKanbanColumn(document.querySelector('.edb-kanban-overlay'), newCat);
                }

                auditEl.remove();
                this.refreshKanbanColumns();
                console.log(`[EDB Audit] Reassigned "${item.tx?.name}" → ${newCat}`);
            });

            auditEl.querySelector('.edb-audit-uncategorize').addEventListener('click', (e) => {
                e.stopPropagation();
                this.kanbanState.assignments.set(txId, null);
                auditEl.remove();
                this.refreshKanbanColumns();
                console.log(`[EDB Audit] Uncategorized "${item.tx?.name}"`);
            });
        },

        // Open the Kanban bulk categorize modal
        async openKanbanModal(items) {
            const allCategories = await this.getBudgetCategoryNames();
            const top5 = await this.getTopCategories(5);

            // Build kanban data and check for suggestions
            const kanbanData = new Map();
            const assignments = new Map();
            const readyCategories = new Set(); // Track categories from ready items

            for (const item of items) {
                const tx = item.tx;

                // Detect ready items (already have category + confidence from Stage 3)
                const isReadyItem = item.category && item.confidence !== undefined;

                let suggestion = this.suggestions.get(tx.id);
                if (!suggestion && !isReadyItem) {
                    suggestion = await Categorizer.analyze(tx);
                }

                // For ready items, build a pseudo-suggestion from their existing category
                if (isReadyItem && !suggestion) {
                    suggestion = { category: item.category, confidence: item.confidence, source: item.source };
                }

                kanbanData.set(tx.id, { item, suggestion });

                // Multi-item receipt transactions should stay uncategorized in Kanban
                // so user notices they need item-level splitting
                const hasMultiItemReceipt = item.categorization && item.categorization.items && item.categorization.items.length > 1;

                if (isReadyItem && allCategories.includes(item.category)) {
                    // Ready items: use their pre-assigned category directly
                    assignments.set(tx.id, item.category);
                    readyCategories.add(item.category);
                } else if (hasMultiItemReceipt) {
                    // Multi-item receipt: keep uncategorized so user sees it needs splitting
                    assignments.set(tx.id, null);
                } else if (suggestion && suggestion.confidence >= 0.50 && allCategories.includes(suggestion.category)) {
                    // Stage 2 items with good suggestion: pre-sort
                    assignments.set(tx.id, suggestion.category);
                } else {
                    assignments.set(tx.id, null); // Uncategorized
                }
            }

            // Build columns: Uncategorized + top 5 + any additional ready categories
            const columnSet = new Set(top5);
            for (const cat of readyCategories) {
                columnSet.add(cat);
            }
            const columns = [null, ...Array.from(columnSet).sort()];

            // Items assigned to categories not in visible columns → move to uncategorized
            const visibleCategories = new Set(columns.filter(c => c !== null));
            for (const [txId, cat] of assignments) {
                if (cat !== null && !visibleCategories.has(cat)) {
                    assignments.set(txId, null);
                }
            }

            // Debug: log all assignments
            const uncatCount = [...assignments.values()].filter(v => v === null).length;
            const catCount = [...assignments.values()].filter(v => v !== null).length;
            console.log(`[EDB Kanban] Assignments: ${uncatCount} uncategorized, ${catCount} categorized, ${kanbanData.size} total items`);
            for (const [txId, cat] of assignments) {
                const data = kanbanData.get(txId);
                if (data) console.log(`[EDB Kanban]   "${data.item.tx.name}" → ${cat || 'Uncategorized'}`);
            }

            // Build refund-purchase pairs and identify actual store returns
            const { refundPairs, returnTxIds } = this.buildKanbanRefundPairs(kanbanData);

            this.renderKanbanModal(kanbanData, assignments, columns, allCategories, refundPairs, returnTxIds);
        },

        // Render the full Kanban modal DOM
        renderKanbanModal(kanbanData, assignments, columns, allCategories, refundPairs, returnTxIds) {
            // Remove any existing overlay to prevent duplicates
            const existing = document.querySelector('.edb-kanban-overlay');
            if (existing) existing.remove();

            // Store state
            this.kanbanState = {
                assignments,
                columns,
                kanbanData,
                allCategories,
                refundPairs: refundPairs || new Map(),
                returnTxIds: returnTxIds || new Set(),
                collapsedGroups: new Set(),
                dragType: null,
                dragData: null,
                selectedCards: new Set(),   // Multi-select: set of selected txIds
                lastClickedCard: null       // For shift-click range selection
            };

            const totalCount = kanbanData.size;

            // Build modal
            const overlay = document.createElement('div');
            overlay.className = 'edb-kanban-overlay';

            let columnsHtml = '';
            columns.forEach((category, colIndex) => {
                const isUncategorized = category === null;
                const headerClass = isUncategorized ? ' edb-kanban-col-uncategorized' : '';
                const dataCategory = isUncategorized ? '' : category;

                let headerContent;
                let removeBtn = '';
                if (isUncategorized) {
                    headerContent = `<span class="edb-kanban-col-title">Uncategorized</span>`;
                } else {
                    const options = allCategories.map(c =>
                        `<option value="${c.replace(/"/g, '&quot;')}"${c === category ? ' selected' : ''}>${c}</option>`
                    ).join('');
                    headerContent = `<select class="edb-kanban-col-select">${options}</select>`;
                    removeBtn = `<button class="edb-kanban-col-remove" title="Remove column">&times;</button>`;
                }

                const draggableHeader = isUncategorized ? '' : ' draggable="true"';

                columnsHtml += `
                    <div class="edb-kanban-column" data-category="${dataCategory}" data-col-index="${colIndex}">
                        <div class="edb-kanban-col-header${headerClass}"${draggableHeader}>
                            ${headerContent}
                            <span class="edb-kanban-col-count">0</span>
                            ${removeBtn}
                        </div>
                        <div class="edb-kanban-col-body" data-droppable="true">
                            <p class="edb-kanban-empty">Drop items here</p>
                        </div>
                    </div>`;
            });

            overlay.innerHTML = `
                <div class="edb-kanban-modal">
                    <div class="edb-kanban-header">
                        <h3>Bulk Categorize (${totalCount} items)</h3>
                        <button class="edb-kanban-close">&times;</button>
                    </div>
                    <div class="edb-kanban-board">
                        ${columnsHtml}
                        <div class="edb-kanban-add-column" title="Add category column">
                            <span class="edb-kanban-add-icon">+</span>
                            <span class="edb-kanban-add-text">Add Column</span>
                        </div>
                    </div>
                    <div class="edb-kanban-footer">
                        <div class="edb-kanban-stats">
                            Categorized: <strong>0</strong> / ${totalCount}
                        </div>
                        <div class="edb-kanban-actions">
                            <button class="edb-btn edb-btn-secondary edb-kanban-cancel">Cancel</button>
                            <button class="edb-btn edb-btn-primary edb-kanban-apply" disabled>Save All (0)</button>
                        </div>
                    </div>
                </div>`;

            document.body.appendChild(overlay);

            // Close handlers
            // Auto-save categorized items when closing the Kanban, so progress isn't lost
            const closeKanban = async () => {
                if (this.kanbanState) {
                    const { assignments: asgn, kanbanData: kd } = this.kanbanState;
                    let saved = 0;
                    for (const [txId, category] of asgn) {
                        if (category !== null) {
                            const data = kd.get(txId);
                            if (data) {
                                // Detect multi-item receipt from categorization OR from carried-forward flag
                                const hasMultiItemReceipt = (data?.item?.categorization?.items?.length > 1) || data?.item?.kanbanMultiItem;
                                this.editedSplits.set(txId, {
                                    tx: data.item.tx,
                                    isSimple: true,
                                    category,
                                    confirmed: true,
                                    // Flag so pipeline won't override user's explicit Kanban choice
                                    ...(hasMultiItemReceipt && { kanbanMultiItem: true })
                                });
                                saved++;
                            }
                        }
                    }
                    if (saved > 0) {
                        await this.saveEditedSplits();
                        console.log(`[EDB Kanban] Auto-saved ${saved} categorized items on close`);
                    }
                }
                overlay.remove();
                this.kanbanState = null;
                await this.processTransactionPipeline();
            };

            overlay.querySelector('.edb-kanban-close').addEventListener('click', () => closeKanban());
            overlay.querySelector('.edb-kanban-cancel').addEventListener('click', () => closeKanban());
            overlay.addEventListener('click', (e) => {
                if (e.target === overlay) closeKanban();
            });

            // Add Column handler
            overlay.querySelector('.edb-kanban-add-column').addEventListener('click', () => {
                this.addKanbanColumn(overlay);
            });

            // Click on board background clears selection
            overlay.querySelector('.edb-kanban-modal').addEventListener('click', (e) => {
                if (!e.target.closest('.edb-kanban-card, .edb-kanban-ctx-item, select, button')) {
                    if (this.kanbanState?.selectedCards.size > 0) {
                        this.kanbanState.selectedCards.clear();
                        this.updateKanbanSelection();
                    }
                }
            });

            // Grab-to-pan horizontal scrolling on the board
            const board = overlay.querySelector('.edb-kanban-board');
            let isPanning = false, panStartX = 0, panScrollLeft = 0;
            board.addEventListener('mousedown', (e) => {
                // Only pan from empty board area or column body, not from cards/buttons/selects
                if (e.target.closest('.edb-kanban-card, select, button, .edb-kanban-add-column')) return;
                isPanning = true;
                panStartX = e.pageX;
                panScrollLeft = board.scrollLeft;
                board.classList.add('edb-grabbing');
            });
            board.addEventListener('mousemove', (e) => {
                if (!isPanning) return;
                e.preventDefault();
                const dx = e.pageX - panStartX;
                board.scrollLeft = panScrollLeft - dx;
            });
            board.addEventListener('mouseup', () => {
                isPanning = false;
                board.classList.remove('edb-grabbing');
            });
            board.addEventListener('mouseleave', () => {
                isPanning = false;
                board.classList.remove('edb-grabbing');
            });

            // Shift+scroll for horizontal scrolling (natural mousewheel)
            board.addEventListener('wheel', (e) => {
                if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return; // already horizontal (trackpad)
                if (e.shiftKey || !e.target.closest('.edb-kanban-col-body')) {
                    // Shift+scroll anywhere, or plain scroll on non-column areas → horizontal
                    e.preventDefault();
                    board.scrollLeft += e.deltaY;
                }
            }, { passive: false });

            // Auto-scroll board edges while dragging a card/group
            let dragScrollRAF = null;
            const EDGE_ZONE = 80; // px from edge to trigger scroll
            const SCROLL_SPEED = 12; // px per frame

            board.addEventListener('dragover', (e) => {
                const rect = board.getBoundingClientRect();
                const x = e.clientX;

                if (dragScrollRAF) cancelAnimationFrame(dragScrollRAF);

                if (x < rect.left + EDGE_ZONE) {
                    // Near left edge — scroll left
                    const intensity = 1 - (x - rect.left) / EDGE_ZONE;
                    const step = () => {
                        board.scrollLeft -= Math.ceil(SCROLL_SPEED * Math.max(0.2, intensity));
                        dragScrollRAF = requestAnimationFrame(step);
                    };
                    dragScrollRAF = requestAnimationFrame(step);
                } else if (x > rect.right - EDGE_ZONE) {
                    // Near right edge — scroll right
                    const intensity = 1 - (rect.right - x) / EDGE_ZONE;
                    const step = () => {
                        board.scrollLeft += Math.ceil(SCROLL_SPEED * Math.max(0.2, intensity));
                        dragScrollRAF = requestAnimationFrame(step);
                    };
                    dragScrollRAF = requestAnimationFrame(step);
                }
            });

            // Stop auto-scroll when drag ends or leaves board
            const stopDragScroll = () => {
                if (dragScrollRAF) { cancelAnimationFrame(dragScrollRAF); dragScrollRAF = null; }
            };
            board.addEventListener('dragleave', stopDragScroll);
            board.addEventListener('drop', stopDragScroll);
            document.addEventListener('dragend', stopDragScroll);

            // Column category change handlers
            overlay.querySelectorAll('.edb-kanban-col-select').forEach(select => {
                select.addEventListener('click', (e) => e.stopPropagation());
                select.addEventListener('change', (e) => {
                    const col = e.target.closest('.edb-kanban-column');
                    const colIndex = parseInt(col.dataset.colIndex);
                    const oldCategory = this.kanbanState.columns[colIndex];
                    const newCategory = e.target.value;

                    this.kanbanState.columns[colIndex] = newCategory;
                    col.dataset.category = newCategory;

                    // Reassign items from old category to new
                    for (const [txId, cat] of this.kanbanState.assignments) {
                        if (cat === oldCategory) {
                            this.kanbanState.assignments.set(txId, newCategory);
                        }
                    }

                    this.refreshKanbanColumns();
                });
            });

            // Column header drag-to-reorder handlers
            this.attachColumnReorderHandlers(overlay);

            // Remove column handlers
            overlay.querySelectorAll('.edb-kanban-col-remove').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const col = btn.closest('.edb-kanban-column');
                    this.removeKanbanColumn(col);
                });
            });

            // Apply All handler
            overlay.querySelector('.edb-kanban-apply').addEventListener('click', async () => {
                const { assignments: asgn, kanbanData: kd } = this.kanbanState;

                const toApply = [];
                for (const [txId, category] of asgn) {
                    if (category !== null) {
                        const data = kd.get(txId);
                        if (data) toApply.push({ txId, category, tx: data.item.tx });
                    }
                }

                if (toApply.length === 0) return;

                const applyBtn = overlay.querySelector('.edb-kanban-apply');
                applyBtn.disabled = true;
                applyBtn.textContent = `Saving... (0/${toApply.length})`;

                // Batch set all editedSplits
                for (let i = 0; i < toApply.length; i++) {
                    const { txId, category, tx } = toApply[i];
                    const data = kd.get(txId);
                    // Detect multi-item receipt from categorization OR from carried-forward flag
                    const hasMultiItemReceipt = (data?.item?.categorization?.items?.length > 1) || data?.item?.kanbanMultiItem;
                    this.editedSplits.set(txId, {
                        tx,
                        isSimple: true,
                        category,
                        confirmed: true,
                        // Flag so pipeline won't override user's explicit Kanban choice
                        ...(hasMultiItemReceipt && { kanbanMultiItem: true })
                    });
                    applyBtn.textContent = `Saving... (${i + 1}/${toApply.length})`;
                }

                // Save once, close, refresh
                await this.saveEditedSplits();
                overlay.remove();
                this.kanbanState = null;
                await this.processTransactionPipeline();
            });

            // Attach drag-drop handlers to all column bodies
            this.attachKanbanDropHandlers(overlay);

            // Initial render of column contents
            this.refreshKanbanColumns();
        },

        // Attach drop handlers to a single column body
        attachKanbanDropHandlersToBody(colBody) {
            colBody.addEventListener('dragover', (e) => {
                if (this.kanbanState.dragType === 'column') return; // Column reorder, not card drop
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                colBody.classList.add('edb-drag-over');
            });

            colBody.addEventListener('dragleave', (e) => {
                if (!colBody.contains(e.relatedTarget)) {
                    colBody.classList.remove('edb-drag-over');
                }
            });

            colBody.addEventListener('drop', (e) => {
                e.preventDefault();
                colBody.classList.remove('edb-drag-over');

                const column = colBody.closest('.edb-kanban-column');
                const targetCategory = column.dataset.category || null;
                const resolvedCategory = targetCategory === '' ? null : targetCategory;

                if (this.kanbanState.dragType === 'selection') {
                    // Multi-select drag: move all selected cards
                    const txIds = this.kanbanState.dragData;
                    for (const txId of txIds) {
                        this.kanbanState.assignments.set(txId, resolvedCategory);
                        // Move paired refunds too
                        const { refundPairs } = this.kanbanState;
                        if (refundPairs) {
                            for (const [refundId, purchaseId] of refundPairs) {
                                if (purchaseId === txId) {
                                    this.kanbanState.assignments.set(refundId, resolvedCategory);
                                }
                            }
                        }
                    }
                    this.kanbanState.selectedCards.clear();
                } else if (this.kanbanState.dragType === 'card') {
                    const txId = this.kanbanState.dragData;
                    this.kanbanState.assignments.set(txId, resolvedCategory);

                    // Move paired refunds with their purchase
                    const { refundPairs } = this.kanbanState;
                    if (refundPairs) {
                        for (const [refundId, purchaseId] of refundPairs) {
                            if (purchaseId === txId) {
                                this.kanbanState.assignments.set(refundId, resolvedCategory);
                            }
                        }
                    }
                } else if (this.kanbanState.dragType === 'group') {
                    const merchantKey = this.kanbanState.dragData;
                    // Find all txIds in this merchant group
                    for (const [txId, data] of this.kanbanState.kanbanData) {
                        const key = this.normalizeForGrouping(data.item.tx.name);
                        if (key === merchantKey) {
                            this.kanbanState.assignments.set(txId, resolvedCategory);
                        }
                    }
                }

                this.refreshKanbanColumns();
            });
        },

        // Attach drop handlers to all column bodies in overlay
        attachKanbanDropHandlers(overlay) {
            overlay.querySelectorAll('.edb-kanban-col-body').forEach(colBody => {
                this.attachKanbanDropHandlersToBody(colBody);
            });
        },

        // Attach drag handlers to cards and groups within a container
        attachKanbanDragHandlers(container) {
            // Individual cards — drag + click-to-select
            container.querySelectorAll('.edb-kanban-card').forEach(card => {
                card.addEventListener('dragstart', (e) => {
                    e.stopPropagation(); // prevent group dragstart
                    const txId = card.dataset.txid;

                    // If dragging a selected card, drag ALL selected cards
                    if (this.kanbanState.selectedCards.has(txId) && this.kanbanState.selectedCards.size > 1) {
                        this.kanbanState.dragType = 'selection';
                        this.kanbanState.dragData = [...this.kanbanState.selectedCards];
                    } else {
                        this.kanbanState.dragType = 'card';
                        this.kanbanState.dragData = txId;
                    }

                    card.classList.add('edb-dragging');
                    e.dataTransfer.effectAllowed = 'move';
                    e.dataTransfer.setData('text/plain', txId);
                });
                card.addEventListener('dragend', () => {
                    card.classList.remove('edb-dragging');
                    document.querySelectorAll('.edb-drag-over').forEach(el => el.classList.remove('edb-drag-over'));
                });

                // Left-click to select/deselect
                card.addEventListener('click', (e) => {
                    // Don't select when clicking audit badges or other interactive elements
                    if (e.target.closest('.edb-kanban-audit-trigger, select, button, a')) return;
                    e.stopPropagation();
                    const txId = card.dataset.txid;
                    this.handleKanbanCardClick(txId, card, e);
                });

                // Right-click context menu
                card.addEventListener('contextmenu', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    const txId = card.dataset.txid;
                    // If right-clicking an unselected card, select it first
                    if (!this.kanbanState.selectedCards.has(txId)) {
                        this.kanbanState.selectedCards.clear();
                        this.kanbanState.selectedCards.add(txId);
                        this.updateKanbanSelection();
                    }
                    this.showKanbanContextMenu(e.clientX, e.clientY);
                });
            });

            // Merchant groups
            container.querySelectorAll('.edb-kanban-group').forEach(group => {
                group.addEventListener('dragstart', (e) => {
                    this.kanbanState.dragType = 'group';
                    this.kanbanState.dragData = group.dataset.merchant;
                    group.classList.add('edb-dragging');
                    e.dataTransfer.effectAllowed = 'move';
                    e.dataTransfer.setData('text/plain', group.dataset.merchant);
                });
                group.addEventListener('dragend', () => {
                    group.classList.remove('edb-dragging');
                    document.querySelectorAll('.edb-drag-over').forEach(el => el.classList.remove('edb-drag-over'));
                });
            });

            // Group toggle (collapse/expand)
            container.querySelectorAll('.edb-kanban-group-toggle').forEach(toggle => {
                toggle.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const group = e.target.closest('.edb-kanban-group');
                    const merchantKey = group.dataset.merchant;
                    group.classList.toggle('edb-collapsed');
                    if (this.kanbanState.collapsedGroups.has(merchantKey)) {
                        this.kanbanState.collapsedGroups.delete(merchantKey);
                    } else {
                        this.kanbanState.collapsedGroups.add(merchantKey);
                    }
                });
            });
        },

        // Re-render all Kanban column bodies based on current state
        // Attach drag-to-reorder handlers on column headers
        attachColumnReorderHandlers(overlay) {
            overlay.querySelectorAll('.edb-kanban-col-header[draggable="true"]').forEach(header => {
                // Skip if already has reorder handlers
                if (header._reorderAttached) return;
                header._reorderAttached = true;

                header.addEventListener('dragstart', (e) => {
                    // Don't drag when interacting with select or buttons
                    if (e.target.tagName === 'SELECT' || e.target.tagName === 'OPTION' || e.target.tagName === 'BUTTON') {
                        e.preventDefault(); return;
                    }
                    const col = header.closest('.edb-kanban-column');
                    const colIndex = parseInt(col.dataset.colIndex);
                    if (colIndex === 0) { e.preventDefault(); return; }
                    this.kanbanState.dragType = 'column';
                    this.kanbanState.dragData = colIndex;
                    col.classList.add('edb-dragging');
                    e.dataTransfer.effectAllowed = 'move';
                    e.dataTransfer.setData('text/plain', 'col-' + colIndex);
                });

                header.addEventListener('dragend', () => {
                    const col = header.closest('.edb-kanban-column');
                    col.classList.remove('edb-dragging');
                    overlay.querySelectorAll('.edb-kanban-col-drop-left, .edb-kanban-col-drop-right').forEach(el => {
                        el.classList.remove('edb-kanban-col-drop-left', 'edb-kanban-col-drop-right');
                    });
                });

                header.addEventListener('dragover', (e) => {
                    if (this.kanbanState.dragType !== 'column') return;
                    e.preventDefault();
                    e.dataTransfer.dropEffect = 'move';

                    const col = header.closest('.edb-kanban-column');
                    const targetIndex = parseInt(col.dataset.colIndex);
                    if (targetIndex === 0) return; // Can't drop before Uncategorized

                    const rect = col.getBoundingClientRect();
                    const midX = rect.left + rect.width / 2;
                    col.classList.remove('edb-kanban-col-drop-left', 'edb-kanban-col-drop-right');
                    if (e.clientX < midX) {
                        col.classList.add('edb-kanban-col-drop-left');
                    } else {
                        col.classList.add('edb-kanban-col-drop-right');
                    }
                });

                header.addEventListener('dragleave', () => {
                    const col = header.closest('.edb-kanban-column');
                    col.classList.remove('edb-kanban-col-drop-left', 'edb-kanban-col-drop-right');
                });

                header.addEventListener('drop', (e) => {
                    e.preventDefault();
                    if (this.kanbanState.dragType !== 'column') return;

                    const sourceIndex = this.kanbanState.dragData;
                    const col = header.closest('.edb-kanban-column');
                    const targetIndex = parseInt(col.dataset.colIndex);
                    if (targetIndex === 0 || sourceIndex === targetIndex) return;

                    const rect = col.getBoundingClientRect();
                    const midX = rect.left + rect.width / 2;
                    const dropAfter = e.clientX >= midX;

                    // Calculate insertion index
                    let insertIndex = dropAfter ? targetIndex + 1 : targetIndex;
                    if (sourceIndex < insertIndex) insertIndex--; // Adjust for removal

                    // Reorder columns array
                    const [moved] = this.kanbanState.columns.splice(sourceIndex, 1);
                    this.kanbanState.columns.splice(insertIndex, 0, moved);

                    // Rebuild DOM order
                    const board = overlay.querySelector('.edb-kanban-board');
                    const addBtn = overlay.querySelector('.edb-kanban-add-column');
                    const columns = Array.from(overlay.querySelectorAll('.edb-kanban-column'));
                    const [movedCol] = columns.splice(sourceIndex, 1);
                    columns.splice(insertIndex, 0, movedCol);

                    // Re-insert all columns in new order, before the "+" button
                    columns.forEach((c, i) => {
                        c.dataset.colIndex = i;
                        board.insertBefore(c, addBtn);
                    });

                    // Clean up drop indicators
                    overlay.querySelectorAll('.edb-kanban-col-drop-left, .edb-kanban-col-drop-right').forEach(el => {
                        el.classList.remove('edb-kanban-col-drop-left', 'edb-kanban-col-drop-right');
                    });

                    this.refreshKanbanColumns();
                });
            });
        },

        // Remove a category column, moving its items back to Uncategorized
        removeKanbanColumn(colEl) {
            const colIndex = parseInt(colEl.dataset.colIndex);
            if (colIndex === 0) return; // Can't remove Uncategorized

            const category = this.kanbanState.columns[colIndex];

            // Move all items in this column back to Uncategorized
            for (const [txId, cat] of this.kanbanState.assignments) {
                if (cat === category) {
                    this.kanbanState.assignments.set(txId, null);
                }
            }

            // Remove from columns array and DOM
            this.kanbanState.columns.splice(colIndex, 1);
            colEl.remove();

            // Re-index remaining columns
            const overlay = document.querySelector('.edb-kanban-overlay');
            overlay.querySelectorAll('.edb-kanban-column').forEach((col, i) => {
                col.dataset.colIndex = i;
            });

            this.refreshKanbanColumns();
        },

        // Add a new category column to the Kanban board
        addKanbanColumn(overlay, specificCategory) {
            const { columns, allCategories } = this.kanbanState;

            let newCategory;
            if (specificCategory) {
                // Use the specified category (e.g. from audit reassign)
                if (columns.includes(specificCategory)) return; // already exists
                newCategory = specificCategory;
                // Add to allCategories if not present
                if (!allCategories.includes(specificCategory)) {
                    allCategories.push(specificCategory);
                    allCategories.sort();
                }
            } else {
                // Find a category not already in use
                const usedCategories = new Set(columns.filter(c => c !== null));
                const available = allCategories.filter(c => !usedCategories.has(c));
                if (available.length === 0) return;
                newCategory = available[0];
            }
            const newColIndex = columns.length;
            columns.push(newCategory);

            // Build dropdown options
            const options = allCategories.map(c =>
                `<option value="${c.replace(/"/g, '&quot;')}"${c === newCategory ? ' selected' : ''}>${c}</option>`
            ).join('');

            const colDiv = document.createElement('div');
            colDiv.className = 'edb-kanban-column';
            colDiv.dataset.category = newCategory;
            colDiv.dataset.colIndex = newColIndex;
            colDiv.innerHTML = `
                <div class="edb-kanban-col-header" draggable="true">
                    <select class="edb-kanban-col-select">${options}</select>
                    <span class="edb-kanban-col-count">0</span>
                    <button class="edb-kanban-col-remove" title="Remove column">&times;</button>
                </div>
                <div class="edb-kanban-col-body" data-droppable="true">
                    <p class="edb-kanban-empty">Drop items here</p>
                </div>`;

            // Insert before the "+" button
            const board = overlay.querySelector('.edb-kanban-board');
            const addBtn = overlay.querySelector('.edb-kanban-add-column');
            board.insertBefore(colDiv, addBtn);

            // Attach column reorder handlers to new header
            this.attachColumnReorderHandlers(overlay);

            // Attach remove handler
            colDiv.querySelector('.edb-kanban-col-remove').addEventListener('click', (e) => {
                e.stopPropagation();
                this.removeKanbanColumn(colDiv);
            });

            // Attach dropdown change handler
            const select = colDiv.querySelector('.edb-kanban-col-select');
            select.addEventListener('click', (e) => e.stopPropagation());
            select.addEventListener('change', (e) => {
                const colIndex = parseInt(colDiv.dataset.colIndex);
                const oldCategory = this.kanbanState.columns[colIndex];
                const newCat = e.target.value;

                this.kanbanState.columns[colIndex] = newCat;
                colDiv.dataset.category = newCat;

                for (const [txId, cat] of this.kanbanState.assignments) {
                    if (cat === oldCategory) {
                        this.kanbanState.assignments.set(txId, newCat);
                    }
                }

                this.refreshKanbanColumns();
            });

            // Attach drop handlers to the new column body
            this.attachKanbanDropHandlersToBody(colDiv.querySelector('.edb-kanban-col-body'));

            // Scroll board to show the new column
            board.scrollLeft = board.scrollWidth;

            this.refreshKanbanColumns();
        },

        // Handle left-click on a kanban card for selection
        handleKanbanCardClick(txId, cardEl, event) {
            const { selectedCards } = this.kanbanState;

            if (event.shiftKey && this.kanbanState.lastClickedCard) {
                // Shift+click: select range within same column
                const colBody = cardEl.closest('.edb-kanban-col-body');
                if (colBody) {
                    const allCards = [...colBody.querySelectorAll('.edb-kanban-card')];
                    const lastIdx = allCards.findIndex(c => c.dataset.txid === this.kanbanState.lastClickedCard);
                    const currIdx = allCards.findIndex(c => c.dataset.txid === txId);
                    if (lastIdx !== -1 && currIdx !== -1) {
                        const start = Math.min(lastIdx, currIdx);
                        const end = Math.max(lastIdx, currIdx);
                        for (let i = start; i <= end; i++) {
                            selectedCards.add(allCards[i].dataset.txid);
                        }
                    }
                }
            } else if (event.ctrlKey || event.metaKey) {
                // Ctrl/Cmd+click: toggle individual
                if (selectedCards.has(txId)) {
                    selectedCards.delete(txId);
                } else {
                    selectedCards.add(txId);
                }
            } else {
                // Plain click: toggle if already selected, otherwise select only this
                if (selectedCards.has(txId) && selectedCards.size === 1) {
                    selectedCards.clear();
                } else {
                    selectedCards.clear();
                    selectedCards.add(txId);
                }
            }

            this.kanbanState.lastClickedCard = txId;
            this.updateKanbanSelection();
        },

        // Update visual selection state on all kanban cards
        updateKanbanSelection() {
            const overlay = document.querySelector('.edb-kanban-overlay');
            if (!overlay || !this.kanbanState) return;

            const { selectedCards } = this.kanbanState;
            overlay.querySelectorAll('.edb-kanban-card').forEach(card => {
                card.classList.toggle('edb-kanban-card-selected', selectedCards.has(card.dataset.txid));
            });

            // Update selection count in footer
            let countEl = overlay.querySelector('.edb-kanban-selection-count');
            if (selectedCards.size > 0) {
                if (!countEl) {
                    countEl = document.createElement('span');
                    countEl.className = 'edb-kanban-selection-count';
                    const stats = overlay.querySelector('.edb-kanban-stats');
                    if (stats) stats.appendChild(countEl);
                }
                countEl.textContent = ` · ${selectedCards.size} selected`;
            } else if (countEl) {
                countEl.remove();
            }
        },

        // Show right-click context menu for assigning selected cards
        showKanbanContextMenu(x, y) {
            // Remove any existing context menu
            document.querySelector('.edb-kanban-context-menu')?.remove();

            const { selectedCards, allCategories } = this.kanbanState;
            if (selectedCards.size === 0) return;

            const menu = document.createElement('div');
            menu.className = 'edb-kanban-context-menu';

            const title = document.createElement('div');
            title.className = 'edb-kanban-ctx-title';
            title.textContent = `Move ${selectedCards.size} item${selectedCards.size > 1 ? 's' : ''} to:`;
            menu.appendChild(title);

            // Build category grid (3 columns)
            const grid = document.createElement('div');
            grid.className = 'edb-kanban-ctx-grid';

            // Add "Uncategorized" option first
            const uncatItem = document.createElement('div');
            uncatItem.className = 'edb-kanban-ctx-item edb-kanban-ctx-uncat';
            uncatItem.textContent = '← Uncategorized';
            uncatItem.addEventListener('click', () => {
                this.applyKanbanContextAction(null);
                menu.remove();
            });
            grid.appendChild(uncatItem);

            for (const cat of allCategories) {
                const item = document.createElement('div');
                item.className = 'edb-kanban-ctx-item';
                item.textContent = cat;
                item.title = cat;
                item.addEventListener('click', () => {
                    this.applyKanbanContextAction(cat);
                    menu.remove();
                });
                grid.appendChild(item);
            }

            menu.appendChild(grid);

            // Position the menu
            document.body.appendChild(menu);
            const menuRect = menu.getBoundingClientRect();
            const viewW = window.innerWidth;
            const viewH = window.innerHeight;

            // Adjust if menu would go off-screen
            if (x + menuRect.width > viewW) x = viewW - menuRect.width - 8;
            if (y + menuRect.height > viewH) y = viewH - menuRect.height - 8;
            if (x < 0) x = 8;
            if (y < 0) y = 8;

            menu.style.left = x + 'px';
            menu.style.top = y + 'px';

            // Close on click outside or Escape
            const closeMenu = (e) => {
                if (!menu.contains(e.target)) {
                    menu.remove();
                    document.removeEventListener('click', closeMenu);
                    document.removeEventListener('contextmenu', closeMenu);
                }
            };
            const closeOnEsc = (e) => {
                if (e.key === 'Escape') {
                    menu.remove();
                    document.removeEventListener('keydown', closeOnEsc);
                }
            };
            // Defer to avoid the current click closing it immediately
            setTimeout(() => {
                document.addEventListener('click', closeMenu);
                document.addEventListener('contextmenu', closeMenu);
                document.addEventListener('keydown', closeOnEsc);
            }, 0);
        },

        // Apply context menu category to all selected cards
        applyKanbanContextAction(category) {
            const { selectedCards, assignments, refundPairs } = this.kanbanState;

            // Ensure the target column exists (add if needed)
            if (category !== null && !this.kanbanState.columns.includes(category)) {
                this.kanbanState.columns.push(category);
                // Dynamically add the column to the DOM
                const overlay = document.querySelector('.edb-kanban-overlay');
                if (overlay) {
                    const board = overlay.querySelector('.edb-kanban-board');
                    const addBtn = board.querySelector('.edb-kanban-add-column');
                    const colIndex = this.kanbanState.columns.length - 1;
                    const options = this.kanbanState.allCategories.map(c =>
                        `<option value="${c.replace(/"/g, '&quot;')}"${c === category ? ' selected' : ''}>${c}</option>`
                    ).join('');

                    const colEl = document.createElement('div');
                    colEl.className = 'edb-kanban-column';
                    colEl.dataset.category = category;
                    colEl.dataset.colIndex = colIndex;
                    colEl.innerHTML = `
                        <div class="edb-kanban-col-header" draggable="true">
                            <select class="edb-kanban-col-select">${options}</select>
                            <span class="edb-kanban-col-count">0</span>
                            <button class="edb-kanban-col-remove" title="Remove column">&times;</button>
                        </div>
                        <div class="edb-kanban-col-body" data-droppable="true">
                            <p class="edb-kanban-empty">Drop items here</p>
                        </div>`;
                    board.insertBefore(colEl, addBtn);

                    // Attach handlers to new column
                    this.attachKanbanDropHandlersToBody(colEl.querySelector('.edb-kanban-col-body'));
                    this.attachColumnReorderHandlers(overlay);
                    colEl.querySelector('.edb-kanban-col-select').addEventListener('change', (e) => {
                        const ci = parseInt(colEl.dataset.colIndex);
                        const oldCat = this.kanbanState.columns[ci];
                        const newCat = e.target.value;
                        this.kanbanState.columns[ci] = newCat;
                        colEl.dataset.category = newCat;
                        for (const [txId, cat] of assignments) {
                            if (cat === oldCat) assignments.set(txId, newCat);
                        }
                        this.refreshKanbanColumns();
                    });
                    colEl.querySelector('.edb-kanban-col-remove').addEventListener('click', (e) => {
                        e.stopPropagation();
                        this.removeKanbanColumn(colEl);
                    });
                }
            }

            const movedCount = selectedCards.size;
            for (const txId of selectedCards) {
                assignments.set(txId, category);
                // Move paired refunds too
                if (refundPairs) {
                    for (const [refundId, purchaseId] of refundPairs) {
                        if (purchaseId === txId) {
                            assignments.set(refundId, category);
                        }
                    }
                }
            }

            selectedCards.clear();
            this.kanbanState.lastClickedCard = null;
            this.refreshKanbanColumns();
            console.log(`[EDB Kanban] Context menu: moved ${movedCount} cards to "${category || 'Uncategorized'}"`);
        },

        refreshKanbanColumns() {
            const overlay = document.querySelector('.edb-kanban-overlay');
            if (!overlay || !this.kanbanState) return;

            const { assignments, columns, kanbanData, collapsedGroups, refundPairs, returnTxIds } = this.kanbanState;
            let categorizedCount = 0;
            const totalCount = kanbanData.size;

            columns.forEach((category, colIndex) => {
                const col = overlay.querySelector(`.edb-kanban-column[data-col-index="${colIndex}"]`);
                if (!col) return;

                const body = col.querySelector('.edb-kanban-col-body');
                const countEl = col.querySelector('.edb-kanban-col-count');

                // Collect txIds for this column
                const colTxIds = [];
                for (const [txId, cat] of assignments) {
                    if (cat === category) {
                        colTxIds.push(txId);
                        if (category !== null) categorizedCount++;
                    }
                }

                if (countEl) countEl.textContent = colTxIds.length;

                // Group by merchant
                const grouped = this.groupByMerchant(colTxIds, kanbanData);

                // Build HTML
                let html = '';
                for (const [merchantKey, groupTxIds] of grouped) {
                    // Order cards so purchases are followed by their paired refunds
                    const orderedIds = this.orderWithRefundPairs(groupTxIds, refundPairs);

                    if (orderedIds.length === 1) {
                        // Single card — no group wrapper
                        html += this.buildKanbanCardsWithPairs(orderedIds, kanbanData, refundPairs, returnTxIds);
                    } else {
                        // Merchant group
                        const totalAmount = orderedIds.reduce((sum, id) => {
                            const data = kanbanData.get(id);
                            return sum + (data ? data.item.tx.amount : 0);
                        }, 0);
                        const absTotal = Math.abs(totalAmount).toFixed(2);
                        const collapsedClass = collapsedGroups.has(merchantKey) ? ' edb-collapsed' : '';
                        const safeMerchant = merchantKey.replace(/"/g, '&quot;').replace(/</g, '&lt;');

                        const cardsHtml = this.buildKanbanCardsWithPairs(orderedIds, kanbanData, refundPairs, returnTxIds);

                        html += `<div class="edb-kanban-group${collapsedClass}" data-merchant="${safeMerchant}" draggable="true">
                            <div class="edb-kanban-group-header">
                                <span class="edb-kanban-group-toggle">&#9660;</span>
                                <span class="edb-kanban-group-name">${safeMerchant} (${orderedIds.length})</span>
                                <span class="edb-kanban-group-total">$${absTotal}</span>
                            </div>
                            <div class="edb-kanban-group-cards">
                                ${cardsHtml}
                            </div>
                        </div>`;
                    }
                }

                body.innerHTML = html || '<p class="edb-kanban-empty">Drop items here</p>';

                // Re-attach drag handlers
                this.attachKanbanDragHandlers(body);

                // Attach audit badge click handlers
                body.querySelectorAll('.edb-kanban-audit-trigger').forEach(badge => {
                    badge.addEventListener('click', (e) => {
                        e.stopPropagation();
                        const txId = badge.dataset.txid;
                        this.toggleKanbanAudit(txId, badge);
                    });
                });
            });

            // Restore selection visual state after re-render
            this.updateKanbanSelection();

            // Update footer stats
            const statsEl = overlay.querySelector('.edb-kanban-stats strong');
            if (statsEl) statsEl.textContent = categorizedCount;

            const applyBtn = overlay.querySelector('.edb-kanban-apply');
            if (applyBtn) {
                applyBtn.textContent = `Save All (${categorizedCount})`;
                applyBtn.disabled = categorizedCount === 0;
            }
        },

        // ==================== RULES MANAGER ====================

        async openRulesManager() {
            // Remove existing overlay
            const existing = document.querySelector('.edb-rules-overlay');
            if (existing) existing.remove();

            const allCategories = await this.getBudgetCategoryNames();

            const overlay = document.createElement('div');
            overlay.className = 'edb-rules-overlay';

            overlay.innerHTML = `
                <div class="edb-rules-modal">
                    <div class="edb-rules-header">
                        <h3>Rules Manager</h3>
                        <button class="edb-rules-close">&times;</button>
                    </div>
                    <div class="edb-rules-tabs">
                        <button class="edb-rules-tab edb-rules-tab-active" data-tab="merchant">Merchant Rules</button>
                        <button class="edb-rules-tab" data-tab="item">Item Rules</button>
                        <button class="edb-rules-tab" data-tab="keyword">Keywords</button>
                        <button class="edb-rules-tab" data-tab="catmap">Category Map</button>
                    </div>
                    <div class="edb-rules-search">
                        <input type="text" class="edb-rules-search-input" placeholder="Search rules..." />
                    </div>
                    <div class="edb-rules-body">
                        <div class="edb-rules-loading">Loading rules...</div>
                    </div>
                    <div class="edb-rules-footer">
                        <span class="edb-rules-count"></span>
                    </div>
                </div>`;

            document.body.appendChild(overlay);

            // Store state
            this.rulesManagerState = { activeTab: 'merchant', allCategories, searchQuery: '' };

            // Close handlers
            overlay.querySelector('.edb-rules-close').addEventListener('click', () => {
                overlay.remove();
                this.rulesManagerState = null;
            });
            overlay.addEventListener('click', (e) => {
                if (e.target === overlay) {
                    overlay.remove();
                    this.rulesManagerState = null;
                }
            });

            // Tab handlers
            overlay.querySelectorAll('.edb-rules-tab').forEach(tab => {
                tab.addEventListener('click', () => {
                    overlay.querySelectorAll('.edb-rules-tab').forEach(t => t.classList.remove('edb-rules-tab-active'));
                    tab.classList.add('edb-rules-tab-active');
                    this.rulesManagerState.activeTab = tab.dataset.tab;
                    this.renderRulesTab(overlay);
                });
            });

            // Search handler
            const searchInput = overlay.querySelector('.edb-rules-search-input');
            let searchTimeout;
            searchInput.addEventListener('input', () => {
                clearTimeout(searchTimeout);
                searchTimeout = setTimeout(() => {
                    this.rulesManagerState.searchQuery = searchInput.value.toLowerCase().trim();
                    this.renderRulesTab(overlay);
                }, 200);
            });

            // Initial render
            await this.renderRulesTab(overlay);
        },

        async renderRulesTab(overlay) {
            const body = overlay.querySelector('.edb-rules-body');
            const countEl = overlay.querySelector('.edb-rules-count');
            const { activeTab, allCategories, searchQuery } = this.rulesManagerState;

            body.innerHTML = '<div class="edb-rules-loading">Loading...</div>';

            let rules, html = '', totalCount = 0, shownCount = 0;

            if (activeTab === 'merchant') {
                rules = await StorageManager.getAllMerchantRules();
                const entries = Object.entries(rules).sort((a, b) => a[0].localeCompare(b[0]));
                totalCount = entries.length;

                html = `<table class="edb-rules-table">
                    <thead><tr><th>Merchant Key</th><th>Category</th><th>Count</th><th>Last Seen</th><th>Actions</th></tr></thead>
                    <tbody>`;

                for (const [key, rule] of entries) {
                    if (searchQuery && !key.includes(searchQuery) && !(rule.category || '').toLowerCase().includes(searchQuery)) continue;
                    shownCount++;
                    const lastSeen = rule.lastSeen ? new Date(rule.lastSeen).toLocaleDateString() : '-';
                    const catOptions = allCategories.map(c =>
                        `<option value="${c.replace(/"/g, '&quot;')}"${c === rule.category ? ' selected' : ''}>${c}</option>`
                    ).join('');

                    html += `<tr data-key="${key.replace(/"/g, '&quot;')}" data-type="merchant">
                        <td class="edb-rules-key" title="${key}">${key}</td>
                        <td><select class="edb-rules-cat-select">${catOptions}</select></td>
                        <td class="edb-rules-count-cell">${rule.count || 1}</td>
                        <td class="edb-rules-date">${lastSeen}</td>
                        <td><button class="edb-rules-delete-btn" title="Delete rule">&times;</button></td>
                    </tr>`;
                }
                html += `</tbody></table>`;

            } else if (activeTab === 'item') {
                rules = await StorageManager.getAllItemRules();
                const entries = Object.entries(rules).sort((a, b) => a[0].localeCompare(b[0]));
                totalCount = entries.length;

                html = `<table class="edb-rules-table">
                    <thead><tr><th>Item Key</th><th>Original Name</th><th>Category</th><th>Count</th><th>Actions</th></tr></thead>
                    <tbody>`;

                for (const [key, rule] of entries) {
                    if (searchQuery && !key.includes(searchQuery) && !(rule.category || '').toLowerCase().includes(searchQuery)) continue;
                    shownCount++;
                    const original = (rule.originalName || key).replace(/</g, '&lt;');
                    const catOptions = allCategories.map(c =>
                        `<option value="${c.replace(/"/g, '&quot;')}"${c === rule.category ? ' selected' : ''}>${c}</option>`
                    ).join('');

                    html += `<tr data-key="${key.replace(/"/g, '&quot;')}" data-type="item">
                        <td class="edb-rules-key" title="${key}">${key}</td>
                        <td class="edb-rules-original" title="${original}">${original}</td>
                        <td><select class="edb-rules-cat-select">${catOptions}</select></td>
                        <td class="edb-rules-count-cell">${rule.count || 1}</td>
                        <td><button class="edb-rules-delete-btn" title="Delete rule">&times;</button></td>
                    </tr>`;
                }
                html += `</tbody></table>`;

            } else if (activeTab === 'keyword') {
                rules = await StorageManager.getAllKeywordWeights();
                const entries = Object.entries(rules).sort((a, b) => (b[1].totalCount || 0) - (a[1].totalCount || 0));
                totalCount = entries.length;

                html = `<table class="edb-rules-table">
                    <thead><tr><th>Keyword</th><th>Top Category</th><th>Total Count</th><th>Categories</th><th>Actions</th></tr></thead>
                    <tbody>`;

                for (const [keyword, data] of entries) {
                    if (searchQuery && !keyword.includes(searchQuery)) continue;
                    shownCount++;
                    const cats = data.categories || {};
                    const topCat = Object.entries(cats).sort((a, b) => b[1] - a[1])[0];
                    const topCatName = topCat ? topCat[0] : '-';
                    const catCount = Object.keys(cats).length;

                    html += `<tr data-key="${keyword.replace(/"/g, '&quot;')}" data-type="keyword">
                        <td class="edb-rules-key">${keyword}</td>
                        <td class="edb-rules-top-cat">${topCatName}</td>
                        <td class="edb-rules-count-cell">${data.totalCount || 0}</td>
                        <td class="edb-rules-cat-count">${catCount} categories</td>
                        <td><button class="edb-rules-delete-btn" title="Delete keyword">&times;</button></td>
                    </tr>`;
                }
                html += `</tbody></table>`;

            } else if (activeTab === 'catmap') {
                rules = await StorageManager.getAllCategoryMappings();
                const entries = Object.entries(rules).sort((a, b) => a[0].localeCompare(b[0]));
                totalCount = entries.length;

                html = `<table class="edb-rules-table">
                    <thead><tr><th>Pattern Category</th><th>Budget Item</th><th>Count</th><th>Actions</th></tr></thead>
                    <tbody>`;

                for (const [key, mapping] of entries) {
                    if (searchQuery && !key.includes(searchQuery) && !(mapping.budgetItem || '').toLowerCase().includes(searchQuery)) continue;
                    shownCount++;
                    const catOptions = allCategories.map(c =>
                        `<option value="${c.replace(/"/g, '&quot;')}"${c === mapping.budgetItem ? ' selected' : ''}>${c}</option>`
                    ).join('');

                    html += `<tr data-key="${key.replace(/"/g, '&quot;')}" data-type="catmap">
                        <td class="edb-rules-key" title="${key}">${key}</td>
                        <td><select class="edb-rules-cat-select">${catOptions}</select></td>
                        <td class="edb-rules-count-cell">${mapping.count || 1}</td>
                        <td><button class="edb-rules-delete-btn" title="Delete mapping">&times;</button></td>
                    </tr>`;
                }
                html += `</tbody></table>`;
            }

            if (shownCount === 0) {
                html = '<div class="edb-rules-empty">No rules found.</div>';
            }

            body.innerHTML = html;
            countEl.textContent = searchQuery ? `Showing ${shownCount} of ${totalCount} rules` : `${totalCount} rules`;

            // Attach delete handlers
            body.querySelectorAll('.edb-rules-delete-btn').forEach(btn => {
                btn.addEventListener('click', async () => {
                    const row = btn.closest('tr');
                    const key = row.dataset.key;
                    const type = row.dataset.type;

                    if (type === 'merchant') await StorageManager.deleteMerchantRule(key);
                    else if (type === 'item') await StorageManager.deleteItemRule(key);
                    else if (type === 'keyword') await StorageManager.deleteKeywordWeight(key);
                    else if (type === 'catmap') await StorageManager.deleteCategoryMapping(key);

                    row.remove();
                    // Update count
                    const remaining = body.querySelectorAll('tbody tr').length;
                    totalCount--;
                    countEl.textContent = searchQuery ? `Showing ${remaining} of ${totalCount} rules` : `${totalCount} rules`;
                });
            });

            // Attach edit handlers
            body.querySelectorAll('.edb-rules-cat-select').forEach(select => {
                select.addEventListener('change', async () => {
                    const row = select.closest('tr');
                    const key = row.dataset.key;
                    const type = row.dataset.type;
                    const newCat = select.value;

                    if (type === 'merchant') await StorageManager.updateMerchantRule(key, newCat);
                    else if (type === 'item') await StorageManager.updateItemRule(key, newCat);
                    else if (type === 'catmap') await StorageManager.updateCategoryMapping(key, newCat);

                    // Brief visual feedback
                    row.style.background = '#e8f5e9';
                    setTimeout(() => row.style.background = '', 800);
                });
            });
        },

        // ==================== END KANBAN ====================

        // Render Stage 3: Ready to Apply
        async renderReadyStage(items) {
            const countEl = document.getElementById('edb-ready-count');
            const listEl = document.getElementById('edb-ready-list');
            const stageEl = document.getElementById('edb-stage-ready');
            const actionsEl = document.getElementById('edb-ready-actions');
            const applySection = document.getElementById('edb-apply-section');

            if (!listEl) return;

            if (countEl) countEl.textContent = items.length;

            if (items.length === 0) {
                listEl.innerHTML = '<p class="edb-empty">No transactions ready to apply.</p>';
                stageEl?.classList.add('edb-stage-empty');
                actionsEl?.classList.add('edb-hidden');
                applySection?.classList.add('edb-hidden');
                return;
            }

            stageEl?.classList.remove('edb-stage-empty');
            actionsEl?.classList.remove('edb-hidden');
            applySection?.classList.remove('edb-hidden');

            // Store for later use
            this.readyItems = items;

            // Load category options for dropdowns
            const categoryOptions = this.categoryOptions?.length > 0
                ? this.categoryOptions
                : await this.getBudgetCategoryNames();

            let html = '';
            for (const item of items) {
                const { tx, category, source, confidence, categorization, isSplit, amount, splitItems, reason, reasons } = item;
                const confidenceClass = confidence >= 0.9 ? 'high' : confidence >= 0.7 ? 'medium' : 'low';

                // Display amount: use item.amount for splits, tx.amount otherwise
                const displayAmount = amount ? amount.toFixed(2) : tx.amount.toFixed(2);

                // Build source description
                const sourceDesc = this.getSourceDescription(source);

                // Build the reason text
                let reasonText = '';
                if (reasons && reasons.length > 0) {
                    reasonText = reasons.join('; ');
                } else if (reason) {
                    reasonText = reason;
                } else if (source === 'receipt') {
                    reasonText = 'Matched from store receipt';
                } else if (source === 'merchant_rule') {
                    reasonText = 'Learned merchant rule';
                } else if (source === 'manual') {
                    reasonText = 'Manually confirmed';
                } else {
                    reasonText = sourceDesc;
                }

                // Build items list for splits
                let itemsHtml = '';
                if (splitItems && splitItems.length > 0) {
                    const itemsList = splitItems.slice(0, 5).map(i => `<li>${i.name} - $${parseFloat(i.price).toFixed(2)}</li>`).join('');
                    const moreCount = splitItems.length > 5 ? `<li class="edb-more">+${splitItems.length - 5} more...</li>` : '';
                    itemsHtml = `<div class="edb-ready-items"><strong>Items:</strong><ul>${itemsList}${moreCount}</ul></div>`;
                }

                // Build "will learn" info - show tokens that will be learned
                const tokens = StorageManager.extractKeywords(tx.name);
                const tokensDisplay = tokens.length > 0 ? tokens.join(', ') : '(none)';
                const willLearnHtml = `<div class="edb-ready-learn">📚 <strong>On Apply:</strong> Learn "${tx.name}" → ${category}<br><span class="edb-learn-key">Tokens: ${tokensDisplay}</span></div>`;

                // Build category dropdown
                const categoryOptionsHtml = categoryOptions.map(c =>
                    `<option value="${c}" ${c === category ? 'selected' : ''}>${c}</option>`
                ).join('');

                html += `
                    <div class="edb-pipeline-item edb-ready-item ${isSplit ? 'edb-ready-split' : ''}" data-txid="${tx.id}" data-category="${category}">
                        <div class="edb-ready-main">
                            <input type="checkbox" class="edb-ready-checkbox" data-txid="${tx.id}" data-category="${category}" checked />
                            <div class="edb-ready-info">
                                <span class="edb-item-name" title="${tx.name.replace(/"/g, '&quot;')}">${tx.name}</span>
                                <span class="edb-ready-reason">${reasonText}</span>
                            </div>
                            <select class="edb-ready-cat-select" data-txid="${tx.id}" data-original="${category}">
                                ${categoryOptionsHtml}
                            </select>
                            <span class="edb-item-amount ${parseFloat(tx.amount) < 0 ? 'edb-amount-negative' : ''}">$${displayAmount}</span>
                            <button class="edb-btn-xs edb-ready-details-btn" data-txid="${tx.id}" title="View details">▼</button>
                        </div>
                        <div class="edb-ready-details edb-hidden" data-txid="${tx.id}">
                            <div class="edb-ready-detail-row">
                                <span class="edb-detail-label">Source:</span>
                                <span class="edb-detail-value">${sourceDesc}</span>
                                <span class="edb-confidence edb-confidence-${confidenceClass}">${Math.round(confidence * 100)}%</span>
                            </div>
                            ${itemsHtml}
                            ${willLearnHtml}
                            ${isSplit ? `<button class="edb-btn edb-btn-sm edb-edit-ready-btn" data-txid="${tx.id}">✏️ Edit Items</button>` : ''}
                        </div>
                    </div>
                `;
            }

            listEl.innerHTML = html;

            // Add Bulk Sort button to Stage 3 header for reviewing in Kanban
            if (items.length >= 1 && stageEl) {
                const stageHeader = stageEl.querySelector('.edb-stage-header');
                if (stageHeader) {
                    stageHeader.querySelector('.edb-bulk-sort-btn')?.remove();
                    const bulkBtn = document.createElement('button');
                    bulkBtn.className = 'edb-bulk-sort-btn';
                    bulkBtn.textContent = `Bulk Sort (${items.length})`;
                    const collapseArrow = stageHeader.querySelector('.edb-collapse-arrow');
                    if (collapseArrow) {
                        stageHeader.insertBefore(bulkBtn, collapseArrow);
                    } else {
                        stageHeader.appendChild(bulkBtn);
                    }
                    bulkBtn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        this.openKanbanModal(items);
                    });
                }
            }

            // Add checkbox change handlers
            listEl.querySelectorAll('.edb-ready-checkbox').forEach(cb => {
                cb.addEventListener('change', () => this.updateReadySelectedCount());
            });

            // Add details toggle handlers
            listEl.querySelectorAll('.edb-ready-details-btn').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    // Find the details element within the same parent item (handles splits with same txId)
                    const parentItem = btn.closest('.edb-ready-item');
                    const detailsEl = parentItem?.querySelector('.edb-ready-details');
                    if (detailsEl) {
                        detailsEl.classList.toggle('edb-hidden');
                        btn.textContent = detailsEl.classList.contains('edb-hidden') ? '▼' : '▲';
                    }
                });
            });

            // Add category change handlers
            listEl.querySelectorAll('.edb-ready-cat-select').forEach(select => {
                select.addEventListener('change', async (e) => {
                    const txId = select.dataset.txid;
                    const newCategory = select.value;
                    const originalCategory = select.dataset.original;

                    // Update the item in readyItems
                    const item = this.readyItems?.find(i => i.tx.id === txId && i.category === originalCategory);
                    if (item) {
                        item.category = newCategory;
                        // Update the data attribute on the row
                        const row = select.closest('.edb-ready-item');
                        if (row) {
                            row.dataset.category = newCategory;
                            // Update checkbox data attribute
                            const cb = row.querySelector('.edb-ready-checkbox');
                            if (cb) cb.dataset.category = newCategory;
                        }
                        // Update the "will learn" text in details (find within same parent item)
                        const parentItem = select.closest('.edb-ready-item');
                        const learnEl = parentItem?.querySelector('.edb-ready-learn');
                        if (learnEl) {
                            const tokens = StorageManager.extractKeywords(item.tx.name);
                            const tokensDisplay = tokens.length > 0 ? tokens.join(', ') : '(none)';
                            learnEl.innerHTML = `📚 <strong>On Apply:</strong> Learn "${item.tx.name}" → ${newCategory}<br><span class="edb-learn-key">Tokens: ${tokensDisplay}</span>`;
                        }
                        select.dataset.original = newCategory;
                    }
                });
            });

            // Add edit button handlers for splits
            listEl.querySelectorAll('.edb-edit-ready-btn').forEach(btn => {
                btn.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    const txId = e.target.dataset.txid || e.target.closest('button')?.dataset.txid;
                    const item = items.find(i => i.tx.id === txId);
                    if (item && item.categorization) {
                        // Remove confirmed flag so it goes back to splits after editing
                        const editData = this.editedSplits.get(txId);
                        if (editData) {
                            // Create a new object to ensure the change is saved
                            this.editedSplits.set(txId, {
                                ...editData,
                                confirmed: false
                            });
                            await this.saveEditedSplits();
                        }
                        // Open the editor
                        await this.openSplitEditor({
                            tx: item.tx,
                            receipt: item.receipt,
                            categorization: item.categorization
                        });
                    }
                });
            });

            // Initial count update
            this.updateReadySelectedCount();
        },

        // Get human-readable source description
        getSourceDescription(source) {
            const descriptions = {
                'receipt': '🧾 Store Receipt',
                'merchant_rule': '📚 Learned Rule',
                'learned_exact': '🎯 Exact Match',
                'learned_similar': '🔍 Similar Match',
                'pattern': '📋 Pattern Match',
                'pattern_mapped': '📋 Pattern (Mapped)',
                'semantic': '💭 Semantic Match',
                'semantic_mapped': '💭 Semantic (Mapped)',
                'seasonal': '📅 Seasonal Pattern',
                'manual': '👤 Manual',
                'userRule': '👤 User Rule',
                'item_rule': '📦 Item Rule',
                'keyword_weights': '🔤 Keyword Match'
            };
            return descriptions[source] || `🤖 ${source || 'Auto'}`;
        },

        // Update the selected count for Ready stage
        updateReadySelectedCount() {
            const checkboxes = document.querySelectorAll('#edb-ready-list .edb-ready-checkbox');
            const checked = document.querySelectorAll('#edb-ready-list .edb-ready-checkbox:checked');
            const countEl = document.getElementById('edb-selected-count');
            const applyBtn = document.getElementById('edb-apply-selected');

            if (countEl) countEl.textContent = checked.length;
            if (applyBtn) applyBtn.disabled = checked.length === 0;
        },

        // Apply all selected Ready items
        async applySelectedReady() {
            const checked = document.querySelectorAll('#edb-ready-list .edb-ready-checkbox:checked');
            if (checked.length === 0) return;

            this.updateStatus(`Applying ${checked.length} categorizations...`);

            // Group checked items by txId so splits are handled together
            const byTxId = new Map();
            for (const cb of checked) {
                const txId = cb.dataset.txid;
                const category = cb.dataset.category;
                const item = this.readyItems?.find(i => i.tx.id === txId && i.category === category);
                if (item) {
                    if (!byTxId.has(txId)) byTxId.set(txId, []);
                    byTxId.get(txId).push(item);
                }
            }


            let applied = 0;
            let failed = 0;

            for (const [txId, items] of byTxId) {
                const hasSplit = items.some(i => i.isSplit);
                const firstItem = items[0];

                try {
                    if (hasSplit && items.length >= 2) {
                        // SPLIT: Multiple categories for same transaction
                        // Use applySplitTransaction which handles EveryDollar's split UI
                        await this.applySplitTransaction(firstItem.tx, firstItem.categorization, firstItem.receipt);
                    } else {
                        // SINGLE: One category for this transaction
                        await this.applyCategorizarion(txId, firstItem.category);
                    }
                    applied++;

                    // Learn merchant rule from this apply (so it auto-categorizes next time)
                    if (!hasSplit && firstItem.category && firstItem.tx?.name) {
                        // Detect if user corrected the system's suggestion
                        const checkbox = document.querySelector(`.edb-include-checkbox[data-txid="${txId}"]`);
                        const systemCategory = checkbox?.dataset.systemCategory || '';
                        const wasRecategorized = systemCategory && systemCategory !== firstItem.category;

                        if (wasRecategorized) {
                            console.log(`[EDB Apply] CORRECTION: "${firstItem.tx.name}" system suggested "${systemCategory}" → user applied "${firstItem.category}"`);
                        }

                        const normalizedMerchant = StorageManager.normalizeMerchantName(firstItem.tx.name);
                        if (normalizedMerchant) {
                            const rules = await StorageManager.get(StorageManager.KEYS.MERCHANT_RULES) || {};
                            const now = new Date().toISOString();
                            const source = wasRecategorized ? 'user-correction' : 'apply';

                            if (!rules[normalizedMerchant]) {
                                rules[normalizedMerchant] = {
                                    category: firstItem.category,
                                    count: wasRecategorized ? 3 : 1, // Corrections get extra weight
                                    firstSeen: now,
                                    lastSeen: now,
                                    source
                                };
                                console.log(`[EDB Apply] Learned NEW rule: "${normalizedMerchant}" → ${firstItem.category} (source: ${source})`);
                            } else {
                                const oldCat = rules[normalizedMerchant].category;
                                rules[normalizedMerchant].category = firstItem.category;
                                rules[normalizedMerchant].count = wasRecategorized
                                    ? (rules[normalizedMerchant].count || 1) + 3  // Corrections get extra weight
                                    : (rules[normalizedMerchant].count || 1) + 1;
                                rules[normalizedMerchant].lastSeen = now;
                                if (wasRecategorized) rules[normalizedMerchant].source = source;
                                console.log(`[EDB Apply] ${wasRecategorized ? 'CORRECTED' : 'Updated'} rule: "${normalizedMerchant}" ${oldCat} → ${firstItem.category} (count: ${rules[normalizedMerchant].count})`);
                            }
                            await StorageManager.set(StorageManager.KEYS.MERCHANT_RULES, rules);

                            // Also learn keywords for this merchant
                            const tokens = StorageManager.extractKeywords(firstItem.tx.name);
                            if (tokens.length > 0) {
                                await StorageManager.batchLearnKeywords([{ text: firstItem.tx.name, category: firstItem.category, tokens }]);
                            }
                        }
                    }

                    // Remove from editedSplits after successful apply
                    if (this.editedSplits.has(txId)) {
                        await this.removeEditedSplit(txId);
                    }
                } catch (e) {
                    console.error(`[EDB Apply] Failed to apply ${txId}:`, e);
                    failed++;
                }
            }

            this.updateStatus(`Applied ${applied} transaction${applied !== 1 ? 's' : ''}${failed > 0 ? `, ${failed} failed` : ''}`);

            // Refresh the pipeline
            setTimeout(() => this.refreshAll(), 1000);
        },

        // Apply a split transaction using EveryDollar's native split feature
        async applySplitTransaction(tx, categorization, receipt = null) {

            // Calculate category totals from items
            const categoryTotals = {};
            for (const item of categorization.items) {
                const cat = item.category;
                if (cat && cat !== 'Uncategorized') {
                    if (!categoryTotals[cat]) categoryTotals[cat] = 0;
                    categoryTotals[cat] += parseFloat(item.price) || 0;
                }
            }

            const categories = Object.entries(categoryTotals);

            if (categories.length < 2) {
                // Not actually a split, just apply as single category
                const singleCat = categories[0]?.[0] || categorization.items[0]?.category;
                return this.applyCategorizarion(tx.id, singleCat, true);
            }

            try {
                // Step 1: Click the transaction to open the edit modal

                tx.element?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                await new Promise(r => setTimeout(r, 300));

                const clickTarget = tx.element?.querySelector('a, button, [role="button"]') || tx.element;
                clickTarget?.click();
                await new Promise(r => setTimeout(r, 800));

                // Verify modal is open - try multiple selectors
                const modalSelectors = [
                    '[data-testid="transaction_modal_form"]',
                    '.TransactionForm-details',
                    '[class*="TransactionForm"]',
                    '[class*="TransactionModal"]',
                    '[role="dialog"]'
                ];
                let modal = null;
                for (const sel of modalSelectors) {
                    modal = document.querySelector(sel);
                    if (modal) {
                        break;
                    }
                }

                if (!modal) {
                    console.error('[EDB Split] Modal NOT found. Tried selectors:', modalSelectors);
                    // Log what we can see in the DOM
                    const dialogs = document.querySelectorAll('[role="dialog"], [class*="modal"], [class*="Modal"]');
                    throw new Error('Could not open transaction modal');
                }

                // Log the modal's inner structure for debugging

                // Step 2: For each category, add a split and select category
                for (let i = 0; i < categories.length; i++) {
                    const [category, amount] = categories[i];

                    // Log current state of allocators
                    const currentAllocators = document.querySelectorAll('[data-testid="budget_item_allocator_select"]');
                    const currentAllocations = document.querySelectorAll('[data-testid="budget_item_allocator_allocation"]');

                    if (i > 0) {
                        // Add a new split row - find the "Add a Split" select
                        const addSplitBtn = document.querySelector('[data-testid="budget_item_allocator_select"]');
                        if (addSplitBtn) {
                            addSplitBtn.click();
                            await new Promise(r => setTimeout(r, 500));

                            // Log state after clicking
                            const afterAllocators = document.querySelectorAll('[data-testid="budget_item_allocator_select"]');
                            const afterAllocations = document.querySelectorAll('[data-testid="budget_item_allocator_allocation"]');
                        } else {
                            // Try alternative selectors for "Add a Split"
                            const altAddButtons = document.querySelectorAll('button, [role="button"]');
                            for (const btn of altAddButtons) {
                                if (btn.textContent?.toLowerCase().includes('split') || btn.textContent?.toLowerCase().includes('add')) {
                                }
                            }
                        }
                    }

                    // Find all allocation selects - we need to fill the appropriate one
                    const allocatorSelects = document.querySelectorAll('[data-testid="budget_item_allocator_select"]');

                    // For first category, use first select. For subsequent, use the last (newest) one
                    const targetSelect = i === 0 ? allocatorSelects[0] : allocatorSelects[allocatorSelects.length - 1];

                    if (!targetSelect) {
                        console.error(`[EDB Split] Could not find allocator select for row ${i}`);
                        continue;
                    }

                    // Click to open dropdown
                    const dropdownControl = targetSelect.querySelector('[class*="control"], [class*="Control"]') || targetSelect;
                    dropdownControl?.click();
                    await new Promise(r => setTimeout(r, 400));

                    // Type to search for the category
                    const dropdownInput = targetSelect.querySelector('input[role="combobox"], input[type="text"], input');

                    if (dropdownInput) {
                        dropdownInput.focus();
                        // Clear existing value first
                        dropdownInput.value = '';
                        dropdownInput.dispatchEvent(new Event('input', { bubbles: true }));
                        await new Promise(r => setTimeout(r, 100));

                        // Type the category
                        dropdownInput.value = category;
                        dropdownInput.dispatchEvent(new Event('input', { bubbles: true }));
                        await new Promise(r => setTimeout(r, 500));
                    }

                    // Find dropdown menu options
                    const menuSelectors = [
                        '[class*="menu"] [class*="option"]',
                        '[class*="Menu"] [class*="option"]',
                        '[role="listbox"] [role="option"]',
                        '[id*="react-select"] [id*="option"]',
                        '[class*="option"]',
                        '[role="option"]'
                    ];

                    let menuOptions = [];
                    for (const sel of menuSelectors) {
                        menuOptions = document.querySelectorAll(sel);
                        if (menuOptions.length > 0) {
                            break;
                        }
                    }

                    // Log available options
                    const optionTexts = [...menuOptions].map(o => o.textContent?.trim()).slice(0, 10);

                    const categoryLower = category.toLowerCase();
                    let matched = false;

                    // Try exact match first
                    for (const option of menuOptions) {
                        const optionText = option.textContent?.toLowerCase() || '';
                        if (optionText.includes(categoryLower) || categoryLower.includes(optionText)) {
                            option.click();
                            matched = true;
                            await new Promise(r => setTimeout(r, 400));
                            break;
                        }
                    }

                    // Try partial word match if no exact match
                    if (!matched) {
                        const categoryWords = categoryLower.split(/[\s&]+/).filter(w => w.length > 2);
                        for (const option of menuOptions) {
                            const optionText = option.textContent?.toLowerCase() || '';
                            for (const word of categoryWords) {
                                if (optionText.includes(word)) {
                                    option.click();
                                    matched = true;
                                    await new Promise(r => setTimeout(r, 400));
                                    break;
                                }
                            }
                            if (matched) break;
                        }
                    }

                    if (!matched) {
                    }

                    // Now set the amount for this split
                    const allocationRows = document.querySelectorAll('[data-testid="budget_item_allocator_allocation"]');

                    const targetRow = allocationRows[i];

                    if (targetRow) {

                        // Try multiple selectors for the amount input
                        // EveryDollar uses input[name="amount"] inside .inputGroup
                        const amountSelectors = [
                            'input[name="amount"]',
                            '.inputGroup input',
                            'input[inputmode="decimal"]',
                            'input[type="text"]',
                            'input'
                        ];

                        let amountInput = null;
                        for (const sel of amountSelectors) {
                            amountInput = targetRow.querySelector(sel);
                            if (amountInput) {
                                break;
                            }
                        }

                        if (amountInput) {

                            // Clear and set new amount
                            amountInput.focus();
                            amountInput.select();

                            // Try multiple methods to set the value
                            const newValue = amount.toFixed(2);

                            // Method 1: Direct value set
                            amountInput.value = newValue;
                            amountInput.dispatchEvent(new Event('input', { bubbles: true }));
                            amountInput.dispatchEvent(new Event('change', { bubbles: true }));

                            // Method 2: Also try blur to trigger validation
                            amountInput.dispatchEvent(new Event('blur', { bubbles: true }));

                            await new Promise(r => setTimeout(r, 300));
                        } else {
                        }
                    } else {
                    }
                }

                // Step 2.5: Add receipt details to transaction notes/description
                if (receipt && categorization?.items?.length > 0) {

                    // Try to expand "More Options" if collapsed
                    const moreOptionsBtn = document.querySelector('[class*="MoreOptions"], button:contains("More Options"), [data-testid*="more"]');
                    if (moreOptionsBtn && !moreOptionsBtn.classList.contains('expanded')) {
                        moreOptionsBtn.click();
                        await new Promise(r => setTimeout(r, 300));
                    }

                    // Find notes/description field - try multiple selectors
                    const notesSelectors = [
                        '[data-testid="transaction_notes"]',
                        '[name="notes"]',
                        '[name="description"]',
                        'textarea[placeholder*="note"]',
                        'textarea[placeholder*="Note"]',
                        'textarea[placeholder*="memo"]',
                        '.notes-input textarea',
                        'textarea'
                    ];

                    let notesField = null;
                    for (const sel of notesSelectors) {
                        notesField = document.querySelector(sel);
                        if (notesField && notesField.tagName === 'TEXTAREA') {
                            break;
                        }
                        notesField = null;
                    }

                    if (notesField) {
                        // Build item list for notes
                        const itemLines = categorization.items
                            .filter(item => item.category !== 'Uncategorized')
                            .map(item => `• ${item.name}: $${parseFloat(item.price).toFixed(2)} → ${item.category}`)
                            .join('\n');

                        const receiptUrl = receipt.url || receipt.orderUrl || receipt.receiptUrl || '';
                        const storeInfo = receipt.store ? `Store: ${receipt.store}` : '';
                        const dateInfo = receipt.date ? `Date: ${new Date(receipt.date).toLocaleDateString()}` : '';

                        const notesContent = [
                            '📋 Receipt Items:',
                            itemLines,
                            '',
                            storeInfo,
                            dateInfo,
                            receiptUrl ? `Receipt: ${receiptUrl}` : '',
                            '',
                            '(Auto-categorized by EveryDollar Auto-Budget)'
                        ].filter(line => line !== '').join('\n');

                        // Set the notes content
                        notesField.focus();
                        notesField.value = notesContent;
                        notesField.dispatchEvent(new Event('input', { bubbles: true }));
                        notesField.dispatchEvent(new Event('change', { bubbles: true }));

                    } else {
                    }
                }

                // Step 3: Submit the transaction

                const submitSelectors = [
                    '[data-testid="transaction_modal_submit_button"]',
                    '[id="TransactionModal_submit"]',
                    'button[type="submit"]',
                    'button:contains("Save")'
                ];

                let submitBtn = null;
                for (const sel of submitSelectors) {
                    submitBtn = document.querySelector(sel);
                    if (submitBtn) {
                        break;
                    }
                }

                // Also look for buttons with save text
                if (!submitBtn) {
                    const allButtons = document.querySelectorAll('button');
                    for (const btn of allButtons) {
                        if (btn.textContent?.toLowerCase().includes('save') || btn.textContent?.toLowerCase().includes('submit')) {
                            submitBtn = btn;
                            break;
                        }
                    }
                }

                if (submitBtn) {

                    submitBtn.click();
                    await new Promise(r => setTimeout(r, 800));

                    // Check if modal is still open (might indicate an error)
                    const modalStillOpen = document.querySelector('[data-testid="transaction_modal_form"], [class*="TransactionModal"]');
                    if (modalStillOpen) {
                        // Look for error messages
                        const errors = document.querySelectorAll('[class*="error"], [class*="Error"], [role="alert"]');
                    } else {
                    }

                    // Learn from all items in this split
                    for (const item of categorization.items) {
                        if (item.category && item.category !== 'Uncategorized') {
                            await StorageManager.learnItemRule(item.name, item.category);
                        }
                    }

                    this.updateStatus(`✓ Applied split to ${tx.name}`);
                } else {
                    console.error('[EDB Split] Submit button NOT found');
                    const allButtons = document.querySelectorAll('button');
                    throw new Error('Could not find submit button');
                }

            } catch (error) {
                console.error('[EDB Split] Error applying split:', error);
                this.updateStatus(`Failed to split ${tx.name}: ${error.message}`);

                // Try to close any open modal
                const cancelBtn = document.querySelector('[id="TransactionModal_cancel"]');
                if (cancelBtn) cancelBtn.click();

                throw error;
            }
        },

        // Confirm a split and move to Ready stage
        async confirmSplit(txId, splitData) {
            const { tx, receipt, categorization } = splitData;

            // Check if all items have been categorized
            const uncategorizedItems = categorization.items.filter(i => i.category === 'Uncategorized');
            if (uncategorizedItems.length > 0) {
                this.updateStatus(`⚠️ ${uncategorizedItems.length} item${uncategorizedItems.length > 1 ? 's' : ''} still need a category — use Edit Items to assign`);

                // Flash uncategorized item rows to draw attention
                const card = document.querySelector(`.edb-categorize-card[data-txid="${txId}"]`);
                if (card) {
                    card.querySelectorAll('.edb-item-row').forEach(row => {
                        const select = row.querySelector('.edb-item-cat-select');
                        if (select?.value === 'Uncategorized') {
                            row.style.transition = 'background 0.3s';
                            row.style.background = '#fecaca';
                            setTimeout(() => { row.style.background = ''; }, 1500);
                        }
                    });
                }
                return;
            }

            // Get existing edit data or create new
            const existingEdit = this.editedSplits.get(txId) || {};

            const updates = categorization.items
                .filter(i => i.category !== 'Uncategorized')
                .map(i => ({
                    itemName: i.name,
                    category: i.category,
                    originalCat: i.originalCategory || i.category
                }));

            // Store with confirmed flag set to true
            this.editedSplits.set(txId, {
                tx,
                receipt,
                categorization,
                updates,
                confirmed: true  // This flag moves it to Ready stage
            });
            await this.saveEditedSplits();

            this.updateStatus(`✓ Split confirmed for ${tx.name} - ready to apply`);

            // Refresh the pipeline - this will move it to Ready stage since confirmed=true
            await this.processTransactionPipeline();
        },

        // Confirm a simple (non-store) transaction with selected category
        async confirmSimpleTransaction(txId, tx, category) {
            // Store as a confirmed simple transaction
            // Using editedSplits to track state, but with simpler structure
            this.editedSplits.set(txId, {
                tx,
                isSimple: true,
                category,
                confirmed: true
            });
            await this.saveEditedSplits();

            this.updateStatus(`✓ ${tx.name} → ${category} - ready to apply`);

            // Refresh the pipeline
            await this.processTransactionPipeline();
        },

        // Format amount with +/- sign and color class
        formatAmount(amount) {
            const absAmount = Math.abs(amount).toFixed(2);
            if (amount > 0) {
                return `<span class="edb-amount edb-amount-positive">+$${absAmount}</span>`;
            } else if (amount < 0) {
                return `<span class="edb-amount edb-amount-negative">-$${absAmount}</span>`;
            } else {
                return `<span class="edb-amount">$${absAmount}</span>`;
            }
        },

        // Get store icon
        getStoreIcon(store) {
            const icons = {
                target: '🎯',
                walmart: '🏪',
                amazon: '📦',
                fredmeyer: '🛒',
                costco: '🏬'
            };
            return icons[store] || '🛍️';
        },

        // ============ END PIPELINE PROCESSING ============

        // Update the suggestions list in UI
        updateSuggestionsList() {
            const list = document.getElementById('edb-suggestions-list');
            const settings = StorageManager.get(StorageManager.KEYS.SETTINGS);
            const threshold = settings?.confidenceThreshold || 0.75;

            if (this.suggestions.size === 0) {
                list.innerHTML = '<p class="edb-empty">No suggestions available. Transactions may already be categorized.</p>';
                return;
            }

            let html = '';
            const highConfidenceCurrentMonth = [];
            const lowConfidenceCurrentMonth = [];

            for (const [txId, suggestion] of this.suggestions) {
                const tx = this.transactions.find(t => t.id === txId);
                if (!tx) continue;

                const item = { tx, suggestion };

                if (suggestion.confidence >= threshold) {
                    highConfidenceCurrentMonth.push(item);
                } else {
                    lowConfidenceCurrentMonth.push(item);
                }
            }

            if (highConfidenceCurrentMonth.length > 0) {
                html += `<div class="edb-section">
                    <div class="edb-section-header-row">
                        <h4>✓ High Confidence (${highConfidenceCurrentMonth.length})</h4>
                        <div class="edb-checkbox-controls">
                            <button id="edb-select-all" class="edb-btn-xs">All</button>
                            <button id="edb-select-none" class="edb-btn-xs">None</button>
                        </div>
                    </div>`;
                for (const { tx, suggestion } of highConfidenceCurrentMonth) {
                    html += this.renderSuggestionItem(tx, suggestion, true, true); // showCheckbox=true
                }
                html += '</div>';
            }

            if (lowConfidenceCurrentMonth.length > 0) {
                html += `<div class="edb-section"><h4>⚠️ Review Needed (${lowConfidenceCurrentMonth.length})</h4>`;
                for (const { tx, suggestion } of lowConfidenceCurrentMonth) {
                    html += this.renderSuggestionItem(tx, suggestion, false);
                }
                html += '</div>';
            }

            if (highConfidenceCurrentMonth.length === 0 && lowConfidenceCurrentMonth.length === 0) {
                html += '<p class="edb-empty">No suggestions available for this month.</p>';
            }

            list.innerHTML = html;

            // Update the section header count
            const countBadge = document.getElementById('edb-suggestions-count');
            const totalSuggestions = highConfidenceCurrentMonth.length + lowConfidenceCurrentMonth.length;
            if (countBadge) {
                countBadge.textContent = `(${totalSuggestions})`;
            }

            // Add event listeners
            list.querySelectorAll('.edb-apply-btn').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    const txId = e.target.dataset.txid;
                    const category = e.target.dataset.category;
                    this.applyCategorizarion(txId, category);
                });
            });

            list.querySelectorAll('.edb-rename-btn').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    const txId = e.target.dataset.txid;
                    this.showRenameDialog(txId);
                });
            });

            // Update Apply All button based on checked count
            const updateApplyAllButton = () => {
                const checkedCount = document.querySelectorAll('.edb-include-checkbox:checked').length;
                const applyAllBtn = document.getElementById('edb-apply-all');
                applyAllBtn.disabled = checkedCount === 0;
                applyAllBtn.textContent = `✓ Apply All (${checkedCount})`;
            };

            // Add checkbox change listeners
            list.querySelectorAll('.edb-include-checkbox').forEach(cb => {
                cb.addEventListener('change', updateApplyAllButton);
            });

            // Select All / Uncheck All buttons
            const selectAllBtn = document.getElementById('edb-select-all');
            const selectNoneBtn = document.getElementById('edb-select-none');

            if (selectAllBtn) {
                selectAllBtn.addEventListener('click', () => {
                    list.querySelectorAll('.edb-include-checkbox').forEach(cb => cb.checked = true);
                    updateApplyAllButton();
                });
            }

            if (selectNoneBtn) {
                selectNoneBtn.addEventListener('click', () => {
                    list.querySelectorAll('.edb-include-checkbox').forEach(cb => cb.checked = false);
                    updateApplyAllButton();
                });
            }

            // Initial button state
            updateApplyAllButton();
        },

        // Render a single suggestion item
        renderSuggestionItem(tx, suggestion, isHighConfidence, showCheckbox = false) {
            const confidencePercent = Math.round(suggestion.confidence * 100);
            const confidenceClass = isHighConfidence ? 'edb-confidence-high' : 'edb-confidence-low';
            const systemCategory = suggestion.category || '';
            const checkboxHtml = showCheckbox
                ? `<input type="checkbox" class="edb-include-checkbox" data-txid="${tx.id}" data-system-category="${systemCategory.replace(/"/g, '&quot;')}" checked title="Include in Apply All">`
                : '';

            // Format the date nicely
            let dateStr = '';
            try {
                const txDate = new Date(tx.date);
                dateStr = txDate.toLocaleDateString('en-US', {
                    month: 'short',
                    day: 'numeric',
                    year: 'numeric'
                });
            } catch (e) {
                dateStr = tx.date || 'Unknown date';
            }

            // Account info if available
            const accountStr = tx.account ? ` • ${this.escapeHtml(tx.account)}` : '';

            return `
        <div class="edb-suggestion-item" data-txid="${tx.id}">
          <div class="edb-tx-info">
            ${checkboxHtml}
            <span class="edb-tx-name">${this.escapeHtml(tx.name)}</span>
            <span class="edb-tx-amount">$${tx.amount.toFixed(2)}</span>
          </div>
          <div class="edb-tx-meta">
            <span class="edb-tx-date">📅 ${dateStr}${accountStr}</span>
          </div>
          <div class="edb-suggestion-info">
            <span class="edb-category">${suggestion.category}</span>
            <span class="${confidenceClass}">${confidencePercent}%</span>
          </div>
          <div class="edb-reasons">${suggestion.reasons?.slice(0, 2).join(', ') || ''}</div>
          <div class="edb-item-actions">
            <button class="edb-apply-btn edb-btn-sm" data-txid="${tx.id}" data-category="${suggestion.category}">Apply</button>
            <button class="edb-rename-btn edb-btn-sm" data-txid="${tx.id}">Rename</button>
          </div>
        </div>
      `;
        },

        // Update badge count - shows total actionable items from pipeline
        updateBadge(count) {
            const badge = document.getElementById('edb-badge');
            if (!badge) return;

            // Use the passed count from pipeline (categorize + ready stages)
            const displayCount = count !== undefined ? count : 0;

            badge.textContent = displayCount;
            badge.style.display = displayCount > 0 ? 'flex' : 'none';
        },

        // Update status message
        updateStatus(message) {
            document.getElementById('edb-status').textContent = message;
        },

        // Show knowledge gaps
        async showKnowledgeGaps() {
            const gaps = await StorageManager.get(StorageManager.KEYS.KNOWLEDGE_GAPS) || [];
            const container = document.getElementById('edb-knowledge-gaps');

            if (gaps.length === 0) {
                container.innerHTML = '';
                return;
            }

            container.innerHTML = `
        <div class="edb-gaps-warning">
          <strong>📊 Knowledge Gaps:</strong>
          <span>${gaps.slice(0, 5).join(', ')}${gaps.length > 5 ? ` (+${gaps.length - 5} more)` : ''}</span>
          <br><small>Navigate to these months and click "Learn" to improve accuracy.</small>
        </div>
      `;
        },

        // Apply a categorization to a transaction
        async applyCategorizarion(txId, category) {

            const tx = this.transactions.find(t => t.id === txId);
            if (!tx || !tx.element) {
                console.error('EveryDollar Auto-Budget: Transaction not found:', txId);
                this.updateStatus('Error: Transaction not found. Try rescanning.');
                return;
            }


            try {
                // Step 1: Click the transaction to open the edit modal

                // Scroll the transaction into view first
                tx.element.scrollIntoView({ behavior: 'smooth', block: 'center' });
                await new Promise(r => setTimeout(r, 300));

                // Try to find a clickable element within the card
                const clickTarget = tx.element.querySelector('a, button, [role="button"]') || tx.element;

                // Try different click methods
                clickTarget.click();

                // Wait for modal to open
                await new Promise(r => setTimeout(r, 800));

                // Verify modal is open - try multiple selectors
                let modal = document.querySelector('[data-testid="transaction_modal_form"], .TransactionForm-details, .modal-body, [class*="TransactionForm"]');

                if (!modal) {
                    // Try dispatching a mouse event
                    const clickEvent = new MouseEvent('click', {
                        bubbles: true,
                        cancelable: true,
                        view: window
                    });
                    clickTarget.dispatchEvent(clickEvent);
                    await new Promise(r => setTimeout(r, 800));
                    modal = document.querySelector('[data-testid="transaction_modal_form"], .TransactionForm-details, .modal-body, [class*="TransactionForm"]');
                }

                if (!modal) {
                    // Check if maybe the URL changed (some apps navigate instead of opening modal)
                    const anyModal = document.querySelector('[class*="modal"], [class*="Modal"], [role="dialog"]');

                    console.error('EveryDollar Auto-Budget: Modal did not open');
                    this.updateStatus('Error: Could not open transaction modal. Try clicking manually.');
                    return;
                }

                // Step 2: Find and click the category selector dropdown

                // First check if there's already an allocation (the transaction might already have a category)
                const existingAllocation = modal.querySelector('[data-testid="budget_item_allocator_allocation"]');
                if (existingAllocation) {
                    const existingLabel = existingAllocation.querySelector('[data-testid="budget_item_allocator_allocation_label"]');
                }

                // Find the category dropdown - could be "Add a Split" or the main selector
                const categorySelect = modal.querySelector('[data-testid="budget_item_allocator_select"]');
                if (!categorySelect) {
                    // If no allocator select, look for other category selectors
                    const altSelectors = modal.querySelectorAll('[class*="BudgetItemAllocator"], [class*="allocator"], [class*="category"]');

                    if (altSelectors.length === 0) {
                        console.error('EveryDollar Auto-Budget: No category selector found in modal');
                        // Close modal
                        const cancelBtn = modal.querySelector('[id="TransactionModal_cancel"], button[type="button"]:not([data-testid="transaction_delete_button"])');
                        if (cancelBtn) cancelBtn.click();
                        this.updateStatus('Error: Could not find category selector');
                        return;
                    }
                }

                // Click the dropdown control to open it
                const dropdownControl = categorySelect?.querySelector('[class*="control"], [class*="Control"]') || categorySelect;
                if (dropdownControl) {
                    dropdownControl.click();
                    await new Promise(r => setTimeout(r, 300));
                }

                // Also try clicking the input to focus/open the dropdown
                const dropdownInput = categorySelect?.querySelector('input[role="combobox"]');
                if (dropdownInput) {
                    dropdownInput.focus();
                    dropdownInput.click();
                    await new Promise(r => setTimeout(r, 300));
                }

                // Step 3: Find and click the matching category option

                // React-select creates a menu portal, often at the end of body
                const menuSelectors = [
                    '[class*="menu"]',
                    '[class*="Menu"]',
                    '[id*="react-select"][id*="listbox"]',
                    '[role="listbox"]'
                ];

                let menuOptions = [];
                for (const sel of menuSelectors) {
                    const menus = document.querySelectorAll(sel);
                    for (const menu of menus) {
                        const options = menu.querySelectorAll('[class*="option"], [role="option"]');
                        if (options.length > 0) {
                            menuOptions = options;
                            break;
                        }
                    }
                    if (menuOptions.length > 0) break;
                }

                if (menuOptions.length === 0) {
                    // Try typing the category name to filter
                    if (dropdownInput) {
                        dropdownInput.value = category;
                        dropdownInput.dispatchEvent(new Event('input', { bubbles: true }));
                        await new Promise(r => setTimeout(r, 500));

                        // Look for options again
                        for (const sel of menuSelectors) {
                            const menus = document.querySelectorAll(sel);
                            for (const menu of menus) {
                                const options = menu.querySelectorAll('[class*="option"], [role="option"]');
                                if (options.length > 0) {
                                    menuOptions = options;
                                    break;
                                }
                            }
                            if (menuOptions.length > 0) break;
                        }
                    }
                }

                // Log available options
                const optionTexts = [...menuOptions].map(o => o.textContent?.trim());

                // Find matching option
                const categoryLower = category.toLowerCase();
                let matchingOption = null;

                for (const option of menuOptions) {
                    const optionText = option.textContent?.toLowerCase() || '';
                    if (optionText.includes(categoryLower) || categoryLower.includes(optionText)) {
                        matchingOption = option;
                        break;
                    }
                }

                // If no exact match, try partial word matching
                if (!matchingOption) {
                    const categoryWords = categoryLower.split(/[\s&]+/).filter(w => w.length > 2);
                    for (const option of menuOptions) {
                        const optionText = option.textContent?.toLowerCase() || '';
                        for (const word of categoryWords) {
                            if (optionText.includes(word)) {
                                matchingOption = option;
                                break;
                            }
                        }
                        if (matchingOption) break;
                    }
                }

                if (!matchingOption) {
                    console.error('EveryDollar Auto-Budget: Category not found in dropdown:', category);
                    // Close modal
                    const cancelBtn = document.querySelector('[id="TransactionModal_cancel"]');
                    if (cancelBtn) cancelBtn.click();
                    this.updateStatus(`Category "${category}" not found. Apply manually.`);
                    return;
                }

                // Click the matching option
                matchingOption.click();
                await new Promise(r => setTimeout(r, 300));

                // Step 5: Click the submit button
                const submitBtn = document.querySelector('[data-testid="transaction_modal_submit_button"], [id="TransactionModal_submit"]');
                if (submitBtn) {
                    submitBtn.click();
                    await new Promise(r => setTimeout(r, 500));

                    // Learn from this categorization
                    await StorageManager.learnCategorization(tx, category, 'manual-apply');

                    // Remove from suggestions
                    this.suggestions.delete(txId);
                    this.updateSuggestionsList();
                    this.updateBadge(this.transactions.length);
                    this.updateStatus(`Applied "${category}" to ${tx.name.substring(0, 20)}...`);

                    // Rescan after a delay
                    setTimeout(() => this.scanTransactions(), 1000);
                } else {
                    console.error('EveryDollar Auto-Budget: Submit button not found');
                    this.updateStatus('Error: Could not find submit button');
                }

            } catch (error) {
                console.error('EveryDollar Auto-Budget: Error applying categorization:', error);
                this.updateStatus('Error applying categorization. Check console for details.');
                // Try to close any open modal
                const cancelBtn = document.querySelector('[id="TransactionModal_cancel"]');
                if (cancelBtn) cancelBtn.click();
            }
        },

        // Apply all high-confidence suggestions (current month only, respects checkboxes)
        async applyAllSuggestions() {
            const settings = await StorageManager.get(StorageManager.KEYS.SETTINGS);
            const threshold = settings?.confidenceThreshold || 0.75;

            // Get list of checked transaction IDs
            const checkedTxIds = new Set();
            document.querySelectorAll('.edb-include-checkbox:checked').forEach(cb => {
                checkedTxIds.add(cb.dataset.txid);
            });

            const highConfidence = [];
            for (const [txId, suggestion] of this.suggestions) {
                if (suggestion.confidence >= threshold) {
                    // Only include checked transactions
                    const tx = this.transactions.find(t => t.id === txId);
                    if (tx && checkedTxIds.has(txId)) {
                        highConfidence.push({ txId, category: suggestion.category, tx });
                    }
                }
            }

            if (highConfidence.length === 0) {
                this.updateStatus('No checked transactions to apply.');
                return;
            }

            this.updateStatus(`Applying ${highConfidence.length} categorizations...`);

            // First, learn from all edited splits that are being applied
            await this.executeQueuedLearning(checkedTxIds);

            for (let i = 0; i < highConfidence.length; i++) {
                const { txId, category, tx } = highConfidence[i];
                this.updateStatus(`Applying ${i + 1}/${highConfidence.length}...`);
                await this.applyCategorizarion(txId, category);

                // Learn from this categorization
                await StorageManager.learnCategorization(tx, category, 'auto-applied');

                await new Promise(r => setTimeout(r, 1200)); // Delay between operations to let modal close
            }

            this.updateStatus('All suggestions applied and rules learned!');
            await this.scanTransactions(); // Rescan
        },

        // Execute all queued learning from edited splits
        async executeQueuedLearning(appliedTxIds) {
            let learnedItems = 0;
            let learnedMappings = 0;

            for (const [txId, editData] of this.editedSplits) {
                // Only learn from splits that are being applied
                if (!appliedTxIds || appliedTxIds.has(txId)) {
                    const { updates } = editData;

                    for (const { itemName, category, originalCat } of updates) {
                        // Learn item → category rule
                        await StorageManager.learnItemRule(itemName, category);
                        learnedItems++;

                        // Learn category mapping if different
                        if (originalCat && originalCat !== 'Uncategorized' && originalCat !== category) {
                            await StorageManager.learnCategoryMapping(originalCat, category);
                            learnedMappings++;
                        }
                    }

                    // Remove from pending after learning
                    this.editedSplits.delete(txId);
                }
            }

            if (learnedItems > 0 || learnedMappings > 0) {
            }
        },

        // Learn from all visible tracked transactions
        async learnFromTracked() {
            this.updateStatus('Learning from tracked transactions...');

            // Show loading indicator in knowledge panel
            const knowledgePanel = document.getElementById('edb-knowledge-panel');
            if (knowledgePanel) {
                knowledgePanel.classList.remove('edb-hidden');
                knowledgePanel.innerHTML = `
                    <div class="edb-knowledge-header">
                        <h4>🧠 Knowledge Base</h4>
                        <button id="edb-close-knowledge" class="edb-btn-sm">×</button>
                    </div>
                    <div class="edb-loading">
                        <div class="edb-spinner"></div>
                        <div class="edb-loading-text">Learning from tracked transactions...</div>
                        <div class="edb-loading-progress" id="edb-learning-progress">Initializing...</div>
                    </div>
                `;
                document.getElementById('edb-close-knowledge')?.addEventListener('click', () => {
                    knowledgePanel.classList.add('edb-hidden');
                });
            }

            const updateProgress = (text) => {
                const progressEl = document.getElementById('edb-learning-progress');
                if (progressEl) progressEl.textContent = text;
                this.updateStatus(text);
            };

            // Step 1: Navigate to the Tracked tab
            const trackedTab = document.querySelector('#allocated, [data-testid="TransactionTab"]:nth-child(2), .TransactionsTabs-tab:nth-child(2)');
            if (trackedTab && !trackedTab.classList.contains('active')) {
                updateProgress('Navigating to Tracked tab...');
                trackedTab.click();
                await new Promise(r => setTimeout(r, 1000));
            } else {
            }

            // Step 2: Load transactions for the past year by clicking "Load [Month] Transactions" repeatedly
            const maxMonthsToLoad = 12;
            let monthsLoaded = 0;

            for (let i = 0; i < maxMonthsToLoad; i++) {
                // Look for the "Load [Month] Transactions" button
                const loadButton = document.querySelector('.TransactionFetcher-action, [data-testid="LoadTransactions"], button[class*="TransactionFetcher"]');

                if (loadButton) {
                    const buttonText = loadButton.textContent || '';
                    updateProgress(`Loading: ${buttonText}...`);

                    loadButton.click();
                    monthsLoaded++;

                    // Wait for transactions to load
                    await new Promise(r => setTimeout(r, 1500));

                    // Wait a bit more for the DOM to update
                    await new Promise(r => setTimeout(r, 500));
                } else {
                    break;
                }
            }

            updateProgress(`Loaded ${monthsLoaded} months, scrolling to load all...`);

            // Step 2.5: Scroll through the list to trigger lazy loading
            // Find the scrollable container - try multiple selectors
            const scrollSelectors = [
                '.TransactionDrawer-tabContent',
                '.TransactionDrawer-content',
                '[class*="TransactionDrawer"]',
                '.ui-app-transaction-collection',
                '[data-testid="transaction_collection"]'
            ];

            let scrollableEl = null;
            for (const selector of scrollSelectors) {
                const el = document.querySelector(selector);
                if (el) {
                    // Check if this element or its parent is scrollable
                    const styles = window.getComputedStyle(el);
                    if (styles.overflowY === 'auto' || styles.overflowY === 'scroll' || el.scrollHeight > el.clientHeight) {
                        scrollableEl = el;
                        break;
                    }
                    // Check parent
                    if (el.parentElement) {
                        const parentStyles = window.getComputedStyle(el.parentElement);
                        if (parentStyles.overflowY === 'auto' || parentStyles.overflowY === 'scroll' || el.parentElement.scrollHeight > el.parentElement.clientHeight) {
                            scrollableEl = el.parentElement;
                            break;
                        }
                    }
                }
            }

            // Fallback: find any scrollable element containing transaction cards
            if (!scrollableEl) {
                const card = document.querySelector('.TransactionCard');
                if (card) {
                    let parent = card.parentElement;
                    for (let i = 0; i < 10 && parent; i++) {
                        if (parent.scrollHeight > parent.clientHeight + 100) {
                            scrollableEl = parent;
                            break;
                        }
                        parent = parent.parentElement;
                    }
                }
            }

            if (scrollableEl) {

                let lastCardCount = 0;
                let sameCountIterations = 0;
                const maxScrollAttempts = 100;

                for (let scrollAttempt = 0; scrollAttempt < maxScrollAttempts; scrollAttempt++) {
                    // Scroll down
                    scrollableEl.scrollTop += 1500;
                    await new Promise(r => setTimeout(r, 400));

                    // Check how many cards are now visible
                    const currentCards = document.querySelectorAll('.TransactionCard').length;

                    if (scrollAttempt % 5 === 0) {
                        updateProgress(`Scrolling... found ${currentCards} transactions`);
                    }

                    if (currentCards === lastCardCount) {
                        sameCountIterations++;
                        if (sameCountIterations >= 5) {
                            break;
                        }
                    } else {
                        sameCountIterations = 0;
                        lastCardCount = currentCards;
                    }
                }

                updateProgress(`Found ${lastCardCount} transactions, processing...`);

                // Scroll back to top
                scrollableEl.scrollTop = 0;
                await new Promise(r => setTimeout(r, 500));
            } else {
            }

            // Wait for final DOM updates
            await new Promise(r => setTimeout(r, 1000));

            // Step 3: Find tracked transaction cards - these are ALL visible tracked transactions
            const trackedSelectors = [
                '[data-testid="tracked_card"]',
                '.TransactionCard--tracked',
                '[class*="TrackedTransaction"]',
                '.TransactionCard'  // Fallback - all cards in tracked view
            ];

            let trackedCards = [];
            for (const selector of trackedSelectors) {
                trackedCards = document.querySelectorAll(selector);
                if (trackedCards.length > 0) {
                    break;
                }
            }

            // First pass: collect all data without writing to storage
            let newRulesCount = 0;
            const learnedItems = [];
            const merchantCategoryPairs = new Map(); // merchant -> { category, count }

            for (const card of trackedCards) {
                // Parse the transaction info from the card
                const parsed = this.parseTrackedCard(card);

                if (parsed && parsed.merchant && parsed.categories.length > 0) {
                    // Collect each category for this merchant
                    for (const category of parsed.categories) {
                        const key = `${parsed.merchant}|||${category}`;
                        if (!merchantCategoryPairs.has(key)) {
                            merchantCategoryPairs.set(key, {
                                merchant: parsed.merchant,
                                category,
                                count: 1,
                                amount: parsed.amount,
                                date: parsed.date
                            });
                        } else {
                            merchantCategoryPairs.get(key).count++;
                        }
                        learnedItems.push({ merchant: parsed.merchant, category });
                    }
                }
            }

            updateProgress(`Processing ${merchantCategoryPairs.size} merchant rules...`);

            // Second pass: batch write to storage
            // Get existing data first
            const existingRules = await StorageManager.get(StorageManager.KEYS.MERCHANT_RULES) || {};
            const existingLearned = await StorageManager.get(StorageManager.KEYS.LEARNED_TRANSACTIONS) || [];
            const now = new Date().toISOString();


            for (const [key, data] of merchantCategoryPairs) {
                const normalizedMerchant = StorageManager.normalizeMerchantName(data.merchant);
                if (!normalizedMerchant) {
                    continue;
                }

                const existing = existingRules[normalizedMerchant];
                if (!existing) {
                    // New rule
                    existingRules[normalizedMerchant] = {
                        category: data.category,
                        count: data.count,
                        firstSeen: now,
                        lastSeen: now,
                        source: 'scraped'
                    };
                    newRulesCount++;
                } else if (existing.category === data.category) {
                    // Reinforce existing
                    existing.count = (existing.count || 1) + data.count;
                    existing.lastSeen = now;
                } else {
                    // Category changed - update
                    existing.category = data.category;
                    existing.count = data.count;
                    existing.lastSeen = now;
                }

                // Add to learned transactions
                existingLearned.push({
                    name: data.merchant,
                    amount: data.amount,
                    date: data.date,
                    category: data.category,
                    source: 'scraped',
                    learnedAt: now
                });
            }

            // Keep learned transactions under limit
            while (existingLearned.length > 1000) {
                existingLearned.shift();
            }


            // Single batch write
            try {
                await StorageManager.set(StorageManager.KEYS.MERCHANT_RULES, existingRules);
                await StorageManager.set(StorageManager.KEYS.LEARNED_TRANSACTIONS, existingLearned);
                await StorageManager.set(StorageManager.KEYS.LAST_LEARNING_SCAN, Date.now());
            } catch (e) {
                console.error(`EveryDollar Auto-Budget: ❌ Storage save failed:`, e);
            }

            // Log bulk learning event
            if (learnedItems.length > 0) {
                await StorageManager.addLearningLog('bulk_learn', {
                    transactionsScanned: trackedCards.length,
                    newRules: newRulesCount,
                    samples: learnedItems.slice(0, 5)
                });
            }

            // Switch back to New tab
            const newTab = document.querySelector('[data-testid="new-tab"], .TransactionTabs button:first-child, [class*="New"]');
            if (newTab) {
                newTab.click();
                await new Promise(r => setTimeout(r, 300));
            }

            this.updateStatus(`✓ Learned ${newRulesCount} new rules from ${trackedCards.length} transactions!`);

            // Refresh knowledge panel to show results
            await this.showKnowledgeGaps();
            await this.showKnowledgePanel(true);
        },

        // Parse a tracked transaction card to extract merchant and categories
        parseTrackedCard(card) {
            try {
                // Debug: log the card structure and ancestors for first few cards
                if (!this._trackedCardDebugCount) this._trackedCardDebugCount = 0;
                if (this._trackedCardDebugCount < 5) {

                    // Log parent chain to find category container
                    let parent = card.parentElement;
                    let depth = 0;
                    while (parent && depth < 5) {
                        // Check for any text that looks like a category in parent
                        const directText = [...parent.childNodes].filter(n => n.nodeType === Node.TEXT_NODE).map(n => n.textContent.trim()).filter(t => t).join(' ');
                        parent = parent.parentElement;
                        depth++;
                    }

                    // Log siblings
                    const prevSibling = card.previousElementSibling;
                    if (prevSibling) {
                    }

                    this._trackedCardDebugCount++;
                }

                // The tracked cards in EveryDollar are GROUPED BY CATEGORY
                // The category is in a parent section header, NOT inside the card
                // The card contains: merchant name, date, amount, and ACCOUNT NAME (not category!)

                // Try multiple approaches to get merchant name
                let merchant = null;

                // Approach 1: Look for specific merchant-related classes
                const merchantSelectors = [
                    '.CardBody-merchant',
                    '.TransactionCard-merchant',
                    '.TransactionCard-description',
                    '[class*="Merchant"]',
                    '[class*="merchant"]',
                    '.CardBody-title'
                ];

                for (const selector of merchantSelectors) {
                    const el = card.querySelector(selector);
                    if (el) {
                        merchant = el.textContent?.trim();
                        if (merchant && merchant.length > 2) break;
                    }
                }

                // Approach 2: Get from card structure - find text that's NOT a date, amount, or account name
                if (!merchant) {
                    const allText = card.innerText || card.textContent;
                    const lines = allText.split('\n').map(l => l.trim()).filter(l => l.length > 0);

                    for (const line of lines) {
                        // Skip if it looks like a date (Jan, Feb, etc. followed by number)
                        if (/^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d/i.test(line)) continue;
                        // Skip if it looks like an amount
                        if (/^[-+]?\$/.test(line)) continue;
                        // Skip if it's just a number
                        if (/^\d+$/.test(line)) continue;
                        // Skip very short strings
                        if (line.length < 3) continue;
                        // Skip if it looks like an account/card name (contains card number patterns)
                        if (/\*\d{4}$/.test(line)) continue;
                        if (/visa|mastercard|amex|checking|savings|credit/i.test(line)) continue;
                        // This might be the merchant name
                        merchant = line;
                        break;
                    }
                }

                // Get categories from INSIDE the card - look for .CardBody-budgetItem
                // This contains the budget category like "Restaurant", "Medical", "Car Maintenance"
                let categories = [];

                // Primary approach: Look for the budgetItem element inside the card
                const budgetItemSelectors = [
                    '.CardBody-budgetItem',
                    '[class*="budgetItem"]',
                    '[class*="BudgetItem"]',
                    '.CardBody-category',
                    '[class*="category"]:not([class*="Container"])'
                ];

                for (const selector of budgetItemSelectors) {
                    const el = card.querySelector(selector);
                    if (el) {
                        const text = el.textContent?.trim();
                        if (text && text.length > 1) {
                            categories = [text];
                            break;
                        }
                    }
                }

                // Get amount
                const amountMatch = card.textContent.match(/[-+]?\$[\d,]+\.?\d*/);
                const amount = amountMatch ? parseFloat(amountMatch[0].replace(/[$,]/g, '')) : 0;

                // Get date
                const dateMatch = card.textContent.match(/(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}/i);
                const date = dateMatch ? dateMatch[0] : '';

                if (merchant && categories.length > 0) {
                    return { merchant, categories, amount, date };
                }

                // Debug: log what we couldn't parse
                if (this._trackedCardDebugCount <= 5) {
                }

                return null;
            } catch (e) {
                return null;
            }
        },

        // Show full knowledge panel with log and rules
        // Always shows content (no toggle behavior)
        async showKnowledgePanel(forceRefresh = false) {
            const panel = document.getElementById('edb-knowledge-panel');
            if (!panel) return;

            const stats = await StorageManager.getLearningStats();
            const log = await StorageManager.getLearningLog(10);
            const rules = await StorageManager.getAllMerchantRules();
            const lastDeepLearn = await StorageManager.get('lastDeepLearnStats');

            // Update the rules count badge in the section header
            const countBadge = document.getElementById('edb-rules-count');
            if (countBadge) {
                countBadge.textContent = `(${stats.totalRules} rules)`;
            }


            // Format log entries
            const logHtml = log.map(entry => {
                const time = new Date(entry.timestamp).toLocaleString('en-US', {
                    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
                });

                let icon = '📝';
                let text = '';

                switch (entry.type) {
                    case 'new_rule':
                        icon = '🆕';
                        text = `Learned: "${entry.details.merchant}" → ${entry.details.category}`;
                        break;
                    case 'bulk_learn':
                        icon = '📚';
                        const txCount = entry.details.transactionsScanned || entry.details.transactionsProcessed || '?';
                        text = `Scanned ${txCount} transactions: ${entry.details.newRules} new rules`;
                        break;
                    case 'conflict':
                        icon = '⚠️';
                        text = `Updated: "${entry.details.merchant}" changed ${entry.details.oldCategory} → ${entry.details.newCategory}`;
                        break;
                    case 'manual_apply':
                        icon = '✓';
                        text = `Applied: "${entry.details.merchant}" → ${entry.details.category}`;
                        break;
                    case 'reset':
                        icon = '🗑️';
                        text = 'Knowledge cleared';
                        break;
                    default:
                        text = JSON.stringify(entry.details).substring(0, 50);
                }

                return `<div class="edb-log-entry"><span class="edb-log-time">${time}</span> ${icon} ${text}</div>`;
            }).join('');

            // Format rules by category
            const rulesByCategory = {};
            for (const [merchant, rule] of Object.entries(rules)) {
                if (!rulesByCategory[rule.category]) {
                    rulesByCategory[rule.category] = [];
                }
                rulesByCategory[rule.category].push({ merchant, ...rule });
            }

            const rulesHtml = Object.entries(rulesByCategory)
                .sort((a, b) => b[1].length - a[1].length)
                .slice(0, 8)
                .map(([category, merchants]) => `
                    <div class="edb-category-rules">
                        <strong>${category}</strong>:
                        ${merchants.slice(0, 5).map(m => m.merchant).join(', ')}
                        ${merchants.length > 5 ? `(+${merchants.length - 5} more)` : ''}
                    </div>
                `).join('');

            // Format deep learning results section if available
            let deepLearnHtml = '';
            if (lastDeepLearn && lastDeepLearn.timestamp) {
                const dlTime = new Date(lastDeepLearn.timestamp).toLocaleString('en-US', {
                    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
                });
                deepLearnHtml = `
                <div class="edb-deeplearn-section">
                    <h5>📚 Last Deep Learn <span class="edb-deeplearn-time">(${dlTime})</span></h5>
                    <div class="edb-deeplearn-stats">
                        ${lastDeepLearn.storesFetched ? `<span>🏪 ${lastDeepLearn.storesFetched} stores</span>` : ''}
                        <span>📋 ${lastDeepLearn.transactionCount || 0} transactions</span>
                        <span>🧾 ${lastDeepLearn.receipts || 0} receipts</span>
                        <span>🆕 ${lastDeepLearn.merchants || 0} new rules</span>
                        <span>✅ ${lastDeepLearn.autoReady || 0} ready</span>
                    </div>
                </div>
                `;
            }

            panel.innerHTML = `
                <div class="edb-knowledge-stats">
                    <div class="edb-stat-box">
                        <span class="edb-stat-num">${stats.totalRules}</span>
                        <span class="edb-stat-label">Merchants</span>
                    </div>
                    <div class="edb-stat-box">
                        <span class="edb-stat-num">${stats.totalObservations}</span>
                        <span class="edb-stat-label">Matches</span>
                    </div>
                    <div class="edb-stat-box">
                        <span class="edb-stat-num">${Object.keys(rulesByCategory).length}</span>
                        <span class="edb-stat-label">Categories</span>
                    </div>
                </div>
                ${deepLearnHtml}
                ${rulesHtml ? `
                <div class="edb-rules-section">
                    <h5>📋 Rules by Category</h5>
                    ${rulesHtml}
                </div>
                ` : '<p class="edb-empty">No rules yet. Click "Deep Learn" to get started.</p>'}
                ${logHtml ? `
                <div class="edb-log-section">
                    <h5>📜 Recent Activity</h5>
                    <div class="edb-log-list">
                        ${logHtml}
                    </div>
                </div>
                ` : ''}
            `;
        },

        // Show rename dialog
        showRenameDialog(txId) {
            const tx = this.transactions.find(t => t.id === txId);
            if (!tx) return;

            const newName = prompt(`Rename "${tx.name}" to:`, tx.name);
            if (newName && newName !== tx.name) {
                this.addRenameRule(tx.name, newName);
            }
        },

        // Add rename rule
        async addRenameRule(original, newName) {
            await StorageManager.addRenameRule(original, newName);
            this.updateStatus(`Rename rule added: ${original.substring(0, 20)}... → ${newName}`);

            // Rescan to apply new rule
            await this.scanTransactions();
        },

        // Inject rename context menu
        injectRenameContextMenu() {
            document.addEventListener('contextmenu', async (e) => {
                const card = e.target.closest('[data-testid="unallocated_card"], .TransactionCard');
                if (card) {
                    e.preventDefault();
                    const tx = this.parseTransactionCard(card);
                    if (tx) {
                        this.showRenameDialog(tx.id);
                    }
                }
            });
        },

        // Observe DOM changes for dynamic content
        observeChanges() {
            let lastTransactionCount = 0;
            let stableCount = 0;

            const observer = new MutationObserver((mutations) => {
                // Don't rescan while auto-learning, loading months, or background refreshing
                if (this._isAutoLearningInProgress) return;
                if (this._isLoadingMonths) return;
                if (this._isBackgroundRefreshing) return;

                // Debounce rescanning with longer delay
                clearTimeout(this.scanTimeout);
                this.scanTimeout = setTimeout(async () => {
                    if (!this.isProcessing) {
                        // Re-extract the budget month (also updates URL if changed)
                        const previousMonth = this.currentBudgetMonth;
                        this.extractBudgetMonth();

                        // If month changed, rescan and reprocess pipeline
                        if (previousMonth !== this.currentBudgetMonth) {
                            this.transactions = [];
                            await this.scanTransactions();
                            await this.processTransactionPipeline();
                            return;
                        }

                        // Check if count is stable before rescanning
                        const container = document.querySelector('[data-testid="transaction_collection"]');
                        const currentCount = container?.querySelectorAll('[data-testid="unallocated_card"]').length || 0;

                        if (currentCount === lastTransactionCount) {
                            stableCount++;
                            // Only rescan if count has been stable for 2 checks or is different
                            if (stableCount >= 2 && currentCount !== this.transactions.length) {
                                await this.scanTransactions();
                                await this.processTransactionPipeline();
                                stableCount = 0;
                            }
                        } else {
                            lastTransactionCount = currentCount;
                            stableCount = 0;
                        }
                    }
                }, 2000); // Increased to 2 seconds
            });

            // Try multiple selectors for the container
            const containerSelectors = [
                '[data-testid="transaction_collection"]',
                '.ui-app-transaction-collection',
                '[class*="TransactionList"]',
                '[class*="transaction-list"]'
            ];

            for (const selector of containerSelectors) {
                const container = document.querySelector(selector);
                if (container) {
                    observer.observe(container, { childList: true, subtree: true });
                    break;
                }
            }
        },

        // Observe navigation changes to detect when user navigates to transactions
        observeNavigation() {
            // Watch for URL changes (SPA navigation)
            this._lastTrackedUrl = location.href;
            let lastBudgetMonth = this.currentBudgetMonth;

            const urlObserver = new MutationObserver(async () => {
                if (location.href !== this._lastTrackedUrl) {
                    this._lastTrackedUrl = location.href;

                    // Skip URL changes caused by our own month sync button clicks
                    if (this.isSyncingMonth) return;

                    // Skip during auto-learning, loading months, or background refreshing
                    if (this._isAutoLearningInProgress) return;
                    if (this._isLoadingMonths) return;
                    if (this._isBackgroundRefreshing) return;

                    // Re-scan after navigation
                    setTimeout(async () => {
                        // Only sync month to URL if this URL change wasn't caused by
                        // our own updateUrlForMonth (avoid feedback loop with SPA)
                        const timeSinceUpdate = Date.now() - (this._lastUrlUpdateTime || 0);
                        if (timeSinceUpdate > 2000) {
                            await this.syncMonthToUrl();
                        }

                        const previousMonth = this.currentBudgetMonth;
                        this.extractBudgetMonth();

                        // If month changed, clear and rescan
                        if (previousMonth && previousMonth !== this.currentBudgetMonth) {
                            this.transactions = [];
                        }

                        // Try cache first for instant switch, then background refresh
                        const usedCache = await this.tryLoadFromCache();
                        if (usedCache) {
                            await this.processTransactionPipeline();
                            this.backgroundRefreshTransactions(performance.now());
                        } else {
                            await this.scanTransactions();
                            await this.processTransactionPipeline();
                        }
                        this.observeChanges();
                    }, 1000);
                }
            });

            urlObserver.observe(document.body, { childList: true, subtree: true });

            // Watch for month header changes (clicking prev/next month arrows)
            // extractBudgetMonth() now handles URL updates automatically,
            // so this just needs to detect changes and rescan
            let monthCheckTimeout = null;
            const checkMonthChange = async () => {
                clearTimeout(monthCheckTimeout);
                monthCheckTimeout = setTimeout(async () => {
                    const previousMonth = this.currentBudgetMonth;
                    this.extractBudgetMonth(); // also updates URL if month changed

                    if (previousMonth !== this.currentBudgetMonth && this.currentBudgetMonth) {
                        this.transactions = [];
                        const usedCache = await this.tryLoadFromCache();
                        if (usedCache) {
                            await this.processTransactionPipeline();
                            this.backgroundRefreshTransactions(performance.now());
                        } else {
                            await this.scanTransactions();
                            await this.processTransactionPipeline();
                        }
                    }
                }, 500);
            };

            // Observe the entire document for month changes
            // Instead of filtering for h1-specific mutations (fragile - React may update
            // DOM in ways that don't match our filters), just call checkMonthChange on
            // any mutation. The 500ms debounce in checkMonthChange prevents excessive calls.
            const monthObserver = new MutationObserver(() => {
                if (this._isAutoLearningInProgress) return;
                if (this._isLoadingMonths) return;
                if (this._isBackgroundRefreshing) return;
                checkMonthChange();
            });

            monthObserver.observe(document.body, {
                childList: true,
                subtree: true
            });

            // Also observe for main content changes
            const mainObserver = new MutationObserver((mutations) => {
                if (this._isAutoLearningInProgress) return;
                if (this._isLoadingMonths) return;
                if (this._isBackgroundRefreshing) return;
                for (const mutation of mutations) {
                    for (const node of mutation.addedNodes) {
                        if (node.nodeType === Node.ELEMENT_NODE) {
                            const el = node;
                            if (el.matches && (
                                el.matches('[data-testid="transaction_collection"]') ||
                                el.matches('[class*="TransactionList"]') ||
                                el.querySelector('[data-testid="transaction_collection"], [class*="TransactionList"]')
                            )) {
                                setTimeout(async () => {
                                    if (this._isBackgroundRefreshing) return;
                                    this.extractBudgetMonth(); // Always re-extract month
                                    await this.scanTransactions();
                                    await this.processTransactionPipeline();
                                    this.observeChanges();
                                }, 500);
                            }
                        }
                    }
                }
            });

            mainObserver.observe(document.body, { childList: true, subtree: true });
        },

        // Auto-learn from tracked (already categorized) transactions
        async autoLearnFromTracked() {

            // Look for tracked/categorized transactions on the current view
            const trackedCards = document.querySelectorAll('[data-testid="tracked_card"], .TransactionCard--tracked, [class*="categorized"]');
            let learnedCount = 0;

            for (const card of trackedCards) {
                const tx = this.parseTransactionCard(card);
                if (tx && tx.name) {
                    // Try to find what category it's in
                    const categoryEl = card.closest('[class*="category-group"], [class*="budget-item"], [class*="BudgetItem"]');
                    if (categoryEl) {
                        const categoryName = categoryEl.querySelector('[class*="name"], h4, h5, [class*="title"]')?.textContent?.trim();
                        if (categoryName) {
                            await StorageManager.learnCategorization(tx, categoryName, 'auto-learned');
                            learnedCount++;
                        }
                    }
                }
            }

            if (learnedCount > 0) {
            }

            // Record this month as scraped
            if (this.currentBudgetMonth) {
                await StorageManager.recordScrapedBudget(this.currentBudgetMonth);
            }
        },

        // Simulate drag and drop
        simulateDragDrop(source, target) {
            const dataTransfer = new DataTransfer();

            source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer }));
            target.dispatchEvent(new DragEvent('dragenter', { bubbles: true, dataTransfer }));
            target.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer }));
            target.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer }));
            source.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer }));
        },

        // ==================== STORE RECEIPTS ====================

        // Open a store page for scraping receipts
        async openStoreForScraping(store) {
            this.updateStatus(`Opening ${store}...`);

            try {

                // Add timeout to prevent hanging if service worker is inactive
                const timeoutPromise = new Promise((_, reject) =>
                    setTimeout(() => reject(new Error('Service worker timeout')), 10000)
                );

                // For Amazon, pass target transaction dates so scraper can navigate to the right page
                const message = { action: 'openStoreTab', store };
                if (store === 'amazon' && this.lastAwaitingItems) {
                    const amazonDates = this.lastAwaitingItems
                        .filter(i => i.store === 'amazon' && i.tx?.date)
                        .map(i => i.tx.date);
                    if (amazonDates.length > 0) {
                        message.targetDates = amazonDates;
                        console.log(`[EDB] Passing ${amazonDates.length} target dates to Amazon scraper:`, amazonDates);
                    }
                }

                const messagePromise = chrome.runtime.sendMessage(message);

                const response = await Promise.race([messagePromise, timeoutPromise]);

                if (response && response.success) {
                    this.updateStatus(`Opened ${store} - scraping receipts...`);
                } else {
                    console.error('[EDB] openStoreTab failed:', response);
                    this.updateStatus(`Failed to open ${store}`);
                }
            } catch (error) {
                console.error('[EDB] Failed to open store:', error);
                this.updateStatus(`Failed to open ${store}: ${error.message}`);

                // If service worker timed out, try to wake it up and continue
                if (error.message === 'Service worker timeout') {
                }
            }
        },

        // Open all stores at once (for testing, regardless of transactions)
        async openAllStores() {
            const allStores = ['target', 'walmart', 'amazon', 'costco', 'fredmeyer'];
            this.updateStatus(`Opening ${allStores.length} stores...`);

            for (const store of allStores) {
                await this.openStoreForScraping(store);
            }
        },

        // Fetch receipts from all stores and wait for completion
        // Returns a promise that resolves when all stores have finished scraping
        async fetchAllStoresAndWait() {
            const allStores = ['target', 'walmart', 'amazon', 'costco', 'fredmeyer'];

            // Track which stores we're waiting for
            this.pendingStores = new Set(allStores);
            this.storeCompletionPromise = null;

            // Create a promise that resolves when all stores complete
            const waitPromise = new Promise((resolve) => {
                this.resolveStoreCompletion = resolve;

                // Set a timeout in case stores don't respond (5 minutes max)
                this.storeTimeout = setTimeout(() => {
                    const remaining = this.pendingStores ? [...this.pendingStores].join(', ') : 'none';
                    this.pendingStores.clear();
                    resolve({ storesOpened: allStores.length, timedOut: true });
                }, 5 * 60 * 1000);
            });

            // Open all stores
            for (const store of allStores) {
                this.updateStatus(`📚 Opening ${store}...`);
                await this.openStoreForScraping(store);
                // Small delay between opening stores to avoid overwhelming
                await new Promise(r => setTimeout(r, 1000));
            }

            this.updateStatus(`📚 Waiting for ${allStores.length} stores to finish scraping...`);

            // Wait for all stores to complete
            const result = await waitPromise;

            // Clean up
            if (this.storeTimeout) {
                clearTimeout(this.storeTimeout);
                this.storeTimeout = null;
            }

            return { storesOpened: allStores.length, ...result };
        },

        // Called when a store finishes scraping (from handleReceiptsUpdated)
        storeScrapingComplete(store) {

            if (this.pendingStores && this.pendingStores.has(store)) {
                this.pendingStores.delete(store);

                if (this.pendingStores.size === 0 && this.resolveStoreCompletion) {
                    this.resolveStoreCompletion({ storesOpened: 5, complete: true });
                    this.resolveStoreCompletion = null;
                }
            } else {
            }
        },

        // Fetch receipts from all awaiting stores (opens all stores at once)
        async fetchAllStoreReceipts() {
            const stores = this.awaitingStores || [];
            if (stores.length === 0) {
                this.updateStatus('No stores to fetch receipts from');
                return;
            }

            this.updateStatus(`Opening ${stores.length} store${stores.length > 1 ? 's' : ''}...`);

            // Open all stores at once
            for (const store of stores) {
                await this.openStoreForScraping(store);
            }
        },

        // Load and display scraped store receipts
        async loadStoreReceipts() {
            const receipts = await StorageManager.get(StorageManager.KEYS.STORE_RECEIPTS) || [];

            // Update receipt count badge
            const countBadge = document.getElementById('edb-receipts-count');
            if (countBadge) {
                countBadge.textContent = `(${receipts.length})`;
            }

            const listEl = document.getElementById('edb-receipts-list');
            if (!listEl) return;

            if (receipts.length === 0) {
                listEl.innerHTML = '<p class="edb-empty">No receipts scraped yet. Click a store button to import receipts.</p>';
                return;
            }

            // Group by store
            const byStore = {};
            for (const receipt of receipts) {
                if (!byStore[receipt.store]) byStore[receipt.store] = [];
                byStore[receipt.store].push(receipt);
            }

            // Sort receipts by date (newest first)
            const sortedReceipts = receipts
                .sort((a, b) => new Date(b.date) - new Date(a.date));

            // Pre-analyze categories for all items so we can display them
            const analyzedReceipts = await Promise.all(sortedReceipts.map(async (r) => {
                const analyzedItems = await Promise.all((r.items || []).map(async (item) => {
                    const result = await this.categorizeItemTiered(item, r);
                    return {
                        ...item,
                        displayCategory: result.category,
                        categorySource: result.source
                    };
                }));
                return { ...r, analyzedItems };
            }));

            listEl.innerHTML = `
                <div class="edb-receipts-header">
                    <div class="edb-receipts-summary">
                        ${Object.entries(byStore).map(([store, recs]) =>
                `<span class="edb-store-badge">${this.getStoreIcon(store)} ${recs.length}</span>`
            ).join('')}
                    </div>
                </div>
                <div class="edb-recent-receipts">
                    ${analyzedReceipts.map((r, idx) => `
                        <div class="edb-receipt-card" data-receipt-index="${idx}">
                            <div class="edb-receipt-header" data-receipt-id="${r.orderId}">
                                <span class="edb-receipt-store">${this.getStoreIcon(r.store)}</span>
                                <span class="edb-receipt-date">${new Date(r.date).toLocaleDateString()}</span>
                                <span class="edb-receipt-total">$${r.total?.toFixed(2) || '0.00'}</span>
                                <span class="edb-receipt-items-count">${r.items?.length || 0} items</span>
                                <span class="edb-receipt-expand">▶</span>
                            </div>
                            <div class="edb-receipt-details" style="display: none;">
                                <div class="edb-receipt-meta">
                                    ${r.url ? `<a href="${r.url}" target="_blank" class="edb-order-link">Order #${r.orderId} ↗</a>` : `<span>Order: #${r.orderId}</span>`}
                                    ${r.status ? `<span class="edb-receipt-status">${r.status}</span>` : ''}
                                </div>
                                ${(r.shipping || r.discounts) ? `
                                    <div class="edb-receipt-breakdown">
                                        ${r.subtotal ? `<span>Subtotal: $${r.subtotal.toFixed(2)}</span>` : ''}
                                        ${r.shipping ? `<span>Shipping: +$${r.shipping.toFixed(2)}</span>` : ''}
                                        ${r.discounts ? `<span class="edb-discount">Discounts: -$${r.discounts.toFixed(2)}</span>` : ''}
                                    </div>
                                ` : ''}
                                <div class="edb-receipt-items-list">
                                    ${(r.analyzedItems || []).map(item => `
                                        <div class="edb-receipt-item-row">
                                            <span class="edb-item-name" title="${this.escapeHtml(item.name)}">${this.escapeHtml(item.name.substring(0, 50))}${item.name.length > 50 ? '...' : ''}</span>
                                            <span class="edb-item-category ${item.categorySource === 'user_trained' ? 'edb-user-trained' : ''}">${item.displayCategory || 'Uncategorized'}</span>
                                            <span class="edb-item-price">${item.price ? `$${item.price.toFixed(2)}` : '-'}</span>
                                        </div>
                                    `).join('')}
                                </div>
                                ${this.hasItemsWithoutPrices(r.items) ? '<p class="edb-price-note">💡 Click order link to scrape individual prices</p>' : ''}
                                <button class="edb-btn-small edb-delete-receipt" data-order-id="${r.orderId}">🗑️ Delete</button>
                            </div>
                        </div>
                    `).join('')}
                </div>
            `;

            // Add event listeners for expand/collapse
            listEl.querySelectorAll('.edb-receipt-header').forEach(header => {
                header.addEventListener('click', () => {
                    const card = header.closest('.edb-receipt-card');
                    const details = card.querySelector('.edb-receipt-details');
                    const expand = header.querySelector('.edb-receipt-expand');

                    if (details.style.display === 'none') {
                        details.style.display = 'block';
                        expand.textContent = '▼';
                    } else {
                        details.style.display = 'none';
                        expand.textContent = '▶';
                    }
                });
            });

            // Add individual delete handlers
            listEl.querySelectorAll('.edb-delete-receipt').forEach(btn => {
                btn.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    const orderId = btn.dataset.orderId;
                    const currentReceipts = await StorageManager.get(StorageManager.KEYS.STORE_RECEIPTS) || [];
                    const filtered = currentReceipts.filter(r => r.orderId !== orderId);
                    await StorageManager.set(StorageManager.KEYS.STORE_RECEIPTS, filtered);
                    this.loadStoreReceipts();
                    this.updateStatus('Receipt deleted!');
                });
            });

            // Check for split suggestions
            await this.checkForSplitSuggestions();
        },

        // Load and display items needing review
        async loadReviewQueue() {
            const queue = await StorageManager.getReviewQueue();

            // Update count badge
            const countBadge = document.getElementById('edb-review-count');
            if (countBadge) {
                countBadge.textContent = `(${queue.length})`;
            }

            // Show/hide section based on queue
            const section = document.getElementById('edb-review-section');
            if (section) {
                if (queue.length > 0) {
                    section.style.display = 'block';
                    section.classList.remove('edb-collapsed');
                    section.querySelector('.edb-collapse-icon').textContent = '▼';
                } else {
                    section.style.display = 'none';
                }
            }

            const listEl = document.getElementById('edb-review-list');
            if (!listEl) return;

            if (queue.length === 0) {
                listEl.innerHTML = '<p class="edb-empty">No items need review. Great job!</p>';
                return;
            }

            // Get available categories from budget
            const budgetCategories = this.getAvailableBudgetCategories();

            listEl.innerHTML = queue.map((item, index) => `
                <div class="edb-review-item" data-item-index="${index}">
                    <div class="edb-review-item-info">
                        <span class="edb-review-item-store">${this.getStoreIcon(item.store)}</span>
                        <span class="edb-review-item-name">${this.escapeHtml(item.name)}</span>
                        ${item.price ? `<span class="edb-review-item-price">$${item.price.toFixed(2)}</span>` : ''}
                    </div>
                    ${item.storeCategory ? `<div class="edb-review-store-cat">Store says: "${item.storeCategory}"</div>` : ''}
                    <div class="edb-review-actions">
                        <select class="edb-review-category" data-item-name="${this.escapeHtml(item.name)}">
                            <option value="">-- Select Category --</option>
                            ${budgetCategories.map(cat => `<option value="${cat}">${cat}</option>`).join('')}
                        </select>
                        <button class="edb-btn edb-btn-sm edb-review-save" data-item-name="${this.escapeHtml(item.name)}">✓ Learn</button>
                        <button class="edb-btn edb-btn-sm edb-btn-danger edb-review-skip" data-item-name="${this.escapeHtml(item.name)}">✕</button>
                    </div>
                </div>
            `).join('');

            // Add event listeners
            listEl.querySelectorAll('.edb-review-save').forEach(btn => {
                btn.addEventListener('click', async (e) => {
                    const itemName = e.target.dataset.itemName;
                    const select = listEl.querySelector(`select[data-item-name="${itemName}"]`);
                    const category = select?.value;

                    if (category) {
                        await StorageManager.learnItemRule(itemName, category, 'user');
                        await StorageManager.removeFromReviewQueue(itemName);
                        this.updateStatus(`Learned: ${itemName.substring(0, 20)}... → ${category}`);
                        await this.loadReviewQueue();
                    } else {
                        alert('Please select a category first');
                    }
                });
            });

            listEl.querySelectorAll('.edb-review-skip').forEach(btn => {
                btn.addEventListener('click', async (e) => {
                    const itemName = e.target.dataset.itemName;
                    await StorageManager.removeFromReviewQueue(itemName);
                    await this.loadReviewQueue();
                });
            });
        },

        // Get available budget categories
        getAvailableBudgetCategories() {
            // Use the standard EveryDollar categories
            // These match common budget categories in EveryDollar
            return [
                'Food and Household',
                'Health',
                'Personal',
                'Entertainment',
                'Clothing',
                'Baby',
                'Pet',
                'Transportation',
                'Restaurants',
                'Giving',
                'Housing & Utilities',
                'Insurance',
                'Debt',
                'Savings',
                'Other'
            ];
        },

        // Get store icon
        getStoreIcon(store) {
            const icons = {
                target: '🎯',
                fredmeyer: '🛒',
                amazon: '📦',
                costco: '🏪'
            };
            return icons[store] || '🏬';
        },

        // Check for transactions that match receipts and suggest splits
        async checkForSplitSuggestions() {
            const suggestionsEl = document.getElementById('edb-split-suggestions');
            const needsLinkingEl = document.getElementById('edb-needs-linking');
            const splitsSection = document.getElementById('edb-splits-section');
            const splitsCountEl = document.getElementById('edb-splits-count');

            if (!suggestionsEl) return;

            const receipts = await StorageManager.get(StorageManager.KEYS.STORE_RECEIPTS) || [];

            // Hide section and clear if no receipts
            if (receipts.length === 0) {
                suggestionsEl.innerHTML = '';
                if (needsLinkingEl) needsLinkingEl.innerHTML = '';
                if (splitsSection) splitsSection.classList.add('edb-hidden');
                return;
            }

            // Find transactions that match receipts and those that don't
            const splitSuggestions = [];
            const unmatchedTransactions = [];

            // Store current suggestions for Split All functionality
            this.currentSplitSuggestions = [];

            // First, check if any receipts match by logging them

            // Log all transactions for debugging
            this.transactions.forEach(tx => {
                const isStore = this.transactionLooksLikeStorePurchase(tx);
            });

            for (const tx of this.transactions) {
                // Only check store-like transactions for efficiency
                const looksLikeStore = this.transactionLooksLikeStorePurchase(tx);
                if (!looksLikeStore) continue;


                // First check for manual link
                const manualLink = await StorageManager.getManualReceiptLink(tx.id);
                let matchingReceipt = null;
                let matchInfo = null;

                if (manualLink) {
                    matchingReceipt = await StorageManager.getReceiptByOrderId(manualLink.receiptOrderId);
                    matchInfo = { confidence: 1.0, factors: ['manual_link'] };
                } else {
                    matchInfo = await StorageManager.findMatchingReceiptWithConfidence(tx);
                    matchingReceipt = matchInfo?.receipt || null;
                    if (matchingReceipt) {
                    }
                }

                if (matchingReceipt && matchingReceipt.items?.length > 0) {
                    // Analyze items for category split
                    const categoryBreakdown = await this.analyzeReceiptCategories(matchingReceipt);
                    const numCategories = Object.keys(categoryBreakdown).length;

                    if (numCategories > 1) {
                        // Multiple categories - suggest a split
                        const suggestion = {
                            transaction: tx,
                            receipt: matchingReceipt,
                            categories: categoryBreakdown,
                            matchConfidence: matchInfo?.confidence || 1.0
                        };
                        splitSuggestions.push(suggestion);
                        this.currentSplitSuggestions.push(suggestion);
                    } else {
                    }
                } else if (!matchingReceipt) {
                    // No match found - add to needs linking
                    unmatchedTransactions.push({
                        transaction: tx,
                        partialMatch: matchInfo
                    });
                }
            }

            // Render Needs Linking section
            if (needsLinkingEl) {
                if (unmatchedTransactions.length > 0) {
                    needsLinkingEl.innerHTML = `
                        <div class="edb-needs-linking-section">
                            <h5>🔗 Needs Linking</h5>
                            <p class="edb-section-desc">These transactions might match a receipt but couldn't be auto-linked:</p>
                            <div class="edb-needs-linking-list">
                                ${unmatchedTransactions.map(u => this.renderNeedsLinkingItem(u, receipts)).join('')}
                            </div>
                        </div>
                    `;

                    // Add event listeners for manual linking
                    needsLinkingEl.querySelectorAll('.edb-link-btn').forEach(btn => {
                        btn.addEventListener('click', async (e) => {
                            const txId = e.target.dataset.txId;
                            const select = needsLinkingEl.querySelector(`select[data-tx-id="${txId}"]`);
                            if (select && select.value) {
                                await StorageManager.linkTransactionToReceipt(txId, select.value);
                                this.updateStatus('Transaction linked! Refreshing...');
                                await this.checkForSplitSuggestions();
                            }
                        });
                    });
                } else {
                    needsLinkingEl.innerHTML = '';
                }
            }

            // Calculate total count for section badge
            const totalSplitItems = splitSuggestions.length + unmatchedTransactions.length;

            // Update section visibility and count
            if (splitsSection) {
                if (totalSplitItems > 0) {
                    splitsSection.classList.remove('edb-hidden');
                    if (splitsCountEl) {
                        splitsCountEl.textContent = `(${splitSuggestions.length} ready${unmatchedTransactions.length > 0 ? `, ${unmatchedTransactions.length} needs linking` : ''})`;
                    }
                } else {
                    splitsSection.classList.add('edb-hidden');
                }
            }

            // Render Split Suggestions section
            if (splitSuggestions.length === 0 && unmatchedTransactions.length === 0) {
                suggestionsEl.innerHTML = '';
                return;
            }

            if (splitSuggestions.length === 0) {
                suggestionsEl.innerHTML = '<p class="edb-empty">No transactions ready to split yet. Link transactions above first.</p>';
                return;
            }

            suggestionsEl.innerHTML = `
                <div class="edb-split-header">
                    <div class="edb-split-header-row">
                        <h5>Ready to Split</h5>
                        <div class="edb-split-actions">
                            <button class="edb-btn edb-btn-sm" id="edb-select-all-splits">Select All</button>
                            <button class="edb-btn edb-btn-sm" id="edb-deselect-all-splits">Deselect All</button>
                        </div>
                    </div>
                    <p class="edb-section-desc">These transactions have items in multiple categories:</p>
                </div>
                <div class="edb-split-list">
                    ${splitSuggestions.map((s, idx) => this.renderSplitSuggestion(s, idx)).join('')}
                </div>
                <div class="edb-split-all-container">
                    <button class="edb-btn edb-btn-primary edb-split-all-btn" id="edb-split-all-selected">
                        ✂️ Split All Selected (<span id="edb-split-selected-count">0</span>)
                    </button>
                </div>
            `;

            // Update selected count
            this.updateSplitSelectedCount();

            // Add event listeners for individual split buttons
            suggestionsEl.querySelectorAll('.edb-split-btn').forEach(btn => {
                btn.addEventListener('click', async (e) => {
                    const txId = e.target.dataset.txId;
                    const suggestion = splitSuggestions.find(s => s.transaction.id === txId);
                    if (suggestion) {
                        await this.applySplit(suggestion);
                    }
                });
            });

            // Add category header toggle listeners
            suggestionsEl.querySelectorAll('.edb-split-category-header').forEach(header => {
                header.addEventListener('click', (e) => {
                    const toggle = header.querySelector('.edb-cat-toggle');
                    const itemsList = header.nextElementSibling;
                    if (itemsList && itemsList.classList.contains('edb-split-items-list')) {
                        itemsList.classList.toggle('edb-hidden');
                        toggle.textContent = itemsList.classList.contains('edb-hidden') ? '▶' : '▼';
                    }
                });
            });

            // Add checkbox change listeners
            suggestionsEl.querySelectorAll('.edb-split-checkbox').forEach(cb => {
                cb.addEventListener('change', () => this.updateSplitSelectedCount());
            });

            // Select/Deselect all
            document.getElementById('edb-select-all-splits')?.addEventListener('click', () => {
                suggestionsEl.querySelectorAll('.edb-split-checkbox').forEach(cb => cb.checked = true);
                this.updateSplitSelectedCount();
            });

            document.getElementById('edb-deselect-all-splits')?.addEventListener('click', () => {
                suggestionsEl.querySelectorAll('.edb-split-checkbox').forEach(cb => cb.checked = false);
                this.updateSplitSelectedCount();
            });

            // Split All Selected button
            document.getElementById('edb-split-all-selected')?.addEventListener('click', () => {
                this.applyAllSelectedSplits();
            });
        },

        // Check if a transaction looks like a store purchase
        transactionLooksLikeStorePurchase(tx) {
            const name = (tx.name || '').toLowerCase();
            const storePatterns = ['target', 'fred meyer', 'fredmeyer', 'kroger', 'amazon', 'amzn', 'costco', 'walmart', 'safeway'];
            return storePatterns.some(pattern => name.includes(pattern));
        },

        // Render a needs-linking item with receipt dropdown
        renderNeedsLinkingItem(unmatched, receipts) {
            const { transaction, partialMatch } = unmatched;

            const receiptOptions = receipts.map(r => {
                const storeIcon = this.getStoreIcon(r.store);
                const date = new Date(r.date).toLocaleDateString();
                const selected = partialMatch?.receipt?.orderId === r.orderId ? 'selected' : '';
                return `<option value="${r.orderId}" ${selected}>${storeIcon} ${r.store} - ${date} - $${r.total.toFixed(2)}</option>`;
            }).join('');

            return `
                <div class="edb-needs-linking-item" data-tx-id="${transaction.id}">
                    <div class="edb-linking-tx-info">
                        <span class="edb-tx-name">${this.escapeHtml(transaction.name)}</span>
                        <span class="edb-tx-amount">$${transaction.amount.toFixed(2)}</span>
                        <span class="edb-tx-date">${new Date(transaction.date).toLocaleDateString()}</span>
                    </div>
                    <div class="edb-linking-actions">
                        <select class="edb-receipt-select" data-tx-id="${transaction.id}">
                            <option value="">-- Select Receipt --</option>
                            ${receiptOptions}
                        </select>
                        <button class="edb-btn edb-btn-sm edb-btn-primary edb-link-btn" data-tx-id="${transaction.id}">Link</button>
                    </div>
                </div>
            `;
        },

        // Update the count of selected split suggestions
        updateSplitSelectedCount() {
            const checkboxes = document.querySelectorAll('.edb-split-checkbox:checked');
            const countEl = document.getElementById('edb-split-selected-count');
            if (countEl) {
                countEl.textContent = checkboxes.length;
            }
        },

        // Apply all selected splits
        async applyAllSelectedSplits() {
            const checkboxes = document.querySelectorAll('.edb-split-checkbox:checked');
            if (checkboxes.length === 0) {
                this.updateStatus('No splits selected');
                return;
            }

            const selectedIds = Array.from(checkboxes).map(cb => cb.dataset.txId);
            const selectedSuggestions = this.currentSplitSuggestions.filter(s =>
                selectedIds.includes(s.transaction.id)
            );

            this.updateStatus(`Applying ${selectedSuggestions.length} splits...`);

            let successCount = 0;
            let failCount = 0;

            for (let i = 0; i < selectedSuggestions.length; i++) {
                const suggestion = selectedSuggestions[i];
                this.updateStatus(`Splitting ${i + 1}/${selectedSuggestions.length}: ${suggestion.transaction.name}...`);

                try {
                    await this.applySplit(suggestion);
                    successCount++;

                    // Small delay between operations
                    await new Promise(resolve => setTimeout(resolve, 1000));
                } catch (error) {
                    console.error(`Failed to split ${suggestion.transaction.name}:`, error);
                    failCount++;
                }
            }

            if (failCount > 0) {
                this.updateStatus(`Completed: ${successCount} succeeded, ${failCount} failed`);
            } else {
                this.updateStatus(`Successfully applied ${successCount} splits!`);
            }

            // Refresh the list
            await this.checkForSplitSuggestions();
        },

        // ==================== TIERED ITEM CATEGORIZATION ====================
        // Tier 1: User-trained item rules (HIGHEST PRIORITY)
        // Tier 2: Store categories
        // Tier 3: Keyword matching
        // Tier 4: Route to manual review (instead of silent store default)

        // Analyze receipt items and categorize them using tiered approach
        // Distributes discounts, shipping, and tax proportionally across categories
        async analyzeReceiptCategories(receipt) {

            const categories = {};
            const reviewItems = [];  // Items that need user review

            // Calculate subtotal from items (before adjustments)
            let itemsSubtotal = 0;
            for (const item of receipt.items || []) {
                itemsSubtotal += (item.price || 0) * (item.quantity || 1);
            }

            // Calculate adjustments (discount, shipping, tax, etc.)
            const discount = Math.abs(receipt.discount || 0);
            const shipping = receipt.shipping || 0;
            const tax = receipt.tax || 0;
            const receiptTotal = receipt.total || 0;

            // The adjustment factor accounts for the difference between item subtotal and receipt total
            // This includes discounts (negative), shipping (positive), tax (positive), and any other fees
            const totalAdjustment = receiptTotal - itemsSubtotal;


            for (const item of receipt.items || []) {

                const result = await this.categorizeItemTiered(item, receipt);


                if (result.confidence < 0.5) {
                    // Low confidence - queue for review
                    reviewItems.push({ item, result });
                    await StorageManager.addToReviewQueue(item, receipt);
                }

                // Still add to categories even if low confidence (using best guess)
                const category = result.category;
                if (!categories[category]) {
                    categories[category] = { items: [], total: 0, rawTotal: 0, lowConfidenceCount: 0 };
                }

                const itemTotal = (item.price || 0) * (item.quantity || 1);
                categories[category].items.push({
                    ...item,
                    categorization: result
                });
                categories[category].rawTotal += itemTotal;

                if (result.confidence < 0.5) {
                    categories[category].lowConfidenceCount++;
                }
            }

            // Distribute adjustments proportionally across categories
            if (itemsSubtotal > 0 && totalAdjustment !== 0) {
                for (const [cat, data] of Object.entries(categories)) {
                    const proportion = data.rawTotal / itemsSubtotal;
                    const adjustment = totalAdjustment * proportion;
                    data.total = data.rawTotal + adjustment;
                }
            } else {
                // No adjustments needed - use raw totals
                for (const data of Object.values(categories)) {
                    data.total = data.rawTotal;
                }
            }


            let verifyTotal = 0;
            for (const [cat, data] of Object.entries(categories)) {
                verifyTotal += data.total;
            }

            return categories;
        },

        // Debug flag - set to true for verbose logging
        DEBUG_CATEGORIZATION: false,

        // Tiered categorization for a single item
        async categorizeItemTiered(item, receipt) {
            const itemName = item.name || '';
            const shortName = itemName.substring(0, 40) + (itemName.length > 40 ? '...' : '');

            // ========== TIER 1: User-trained item rules (HIGHEST PRIORITY) ==========
            const itemRule = await StorageManager.getItemRule(itemName);
            if (itemRule) {
                if (this.DEBUG_CATEGORIZATION) console.log(`[EDB] Categorize: "${shortName}" → ${itemRule.category} (user rule)`);
                return { category: itemRule.category, confidence: 0.98, source: 'user_trained' };
            }

            // ========== TIER 2: Store's own category ==========
            if (item.storeCategory) {
                const mapped = StorageManager.mapStoreCategory(item.storeCategory);
                if (mapped) {
                    if (this.DEBUG_CATEGORIZATION) console.log(`[EDB] Categorize: "${shortName}" → ${mapped} (store category)`);
                    return { category: mapped, confidence: 1.0, source: 'store_category' };
                }
            }

            // ========== TIER 2b: Scraper-detected category ==========
            if (item.category) {
                if (this.DEBUG_CATEGORIZATION) console.log(`[EDB] Categorize: "${shortName}" → ${item.category} (scraper)`);
                return { category: item.category, confidence: 0.9, source: 'scraper_detected' };
            }

            // ========== TIER 3: Keyword matching ==========
            const keywordResult = this.categorizeByKeywords(itemName);
            if (keywordResult.category) {
                if (this.DEBUG_CATEGORIZATION) console.log(`[EDB] Categorize: "${shortName}" → ${keywordResult.category} (keyword: ${keywordResult.matchedKeyword})`);
                return {
                    category: keywordResult.category,
                    confidence: 0.7,
                    source: 'keyword_match',
                    matchedKeyword: keywordResult.matchedKeyword
                };
            }

            // ========== TIER 4: Route to manual review ==========
            const defaultCategory = this.getDefaultCategory(receipt?.store);
            if (this.DEBUG_CATEGORIZATION) console.log(`[EDB] Categorize: "${shortName}" → ${defaultCategory} (needs review ⚠)`);

            // This will be caught by the low-confidence check and added to review queue
            return {
                category: defaultCategory,
                confidence: 0.2,  // Very low confidence triggers review queue
                source: 'needs_manual_review',
                needsReview: true,
                reason: 'No matching rules, store category, or keywords found'
            };
        },

        // Keyword-based categorization with tracking
        // Uses sub-categories that match actual EveryDollar budget structure
        categorizeByKeywords(itemName) {
            const name = itemName.toLowerCase();

            // ========== HEALTH CATEGORY ==========
            // Medicine/Vitamins sub-category
            const medicineKeywords = [
                'tylenol', 'advil', 'ibuprofen', 'acetaminophen', 'aspirin', 'motrin', 'aleve',
                'bandaid', 'band-aid', 'bandage', 'first aid', 'neosporin', 'antibiotic',
                'vitamin', 'supplement', 'medicine', 'medication', 'rx', 'prescription',
                'allergy', 'benadryl', 'zyrtec', 'claritin', 'flonase', 'allegra',
                'cold', 'flu', 'cough', 'nyquil', 'dayquil', 'mucinex', 'robitussin',
                'pain relief', 'pharmacy', 'thermometer', 'health',
                'diaper rash', 'rash ointment', 'rash cream', 'desitin', 'triple paste',
                'pedialyte', 'fever', 'thermometer'
            ];
            for (const kw of medicineKeywords) {
                if (name.includes(kw)) return { category: 'Medicine/Vitamins', matchedKeyword: kw };
            }

            // ========== FOOD AND HOUSEHOLD CATEGORY ==========
            // Personal Care Groceries sub-category (diapers, wipes, personal hygiene from grocery stores)
            const personalCareGroceriesKeywords = [
                'diaper', 'huggies', 'pampers', 'luvs', 'wipes', 'baby wipe', 'honest company',
                'shampoo', 'conditioner', 'body wash', 'face wash', 'lotion', 'moisturizer',
                'deodorant', 'antiperspirant', 'toothpaste', 'toothbrush', 'mouthwash', 'floss',
                'razor', 'shaving', 'shave', 'soap', 'hand soap', 'body soap',
                'distilled water',  // Often used for personal care/humidifiers
                'cotton ball', 'cotton swab', 'q-tip', 'feminine', 'tampon', 'pad',
                'sunscreen', 'sunblock', 'lip balm', 'chapstick'
            ];
            for (const kw of personalCareGroceriesKeywords) {
                if (name.includes(kw)) return { category: 'Personal Care Groceries', matchedKeyword: kw };
            }

            // Household Groceries sub-category
            const householdGroceriesKeywords = [
                'paper towel', 'toilet paper', 'tissue', 'kleenex', 'trash bag', 'garbage bag',
                'laundry', 'detergent', 'tide', 'gain', 'downy', 'fabric softener',
                'dish soap', 'dawn', 'palmolive', 'sponge', 'scrubber',
                'bleach', 'lysol', 'clorox', 'disinfectant', 'cleaning', 'cleaner',
                'mop', 'broom', 'dustpan', 'swiffer', 'pledge', 'air freshener',
                'aluminum foil', 'plastic wrap', 'ziploc', 'storage bag', 'trash can'
            ];
            for (const kw of householdGroceriesKeywords) {
                if (name.includes(kw)) return { category: 'Household Groceries', matchedKeyword: kw };
            }

            // Food Groceries sub-category
            const foodGroceriesKeywords = [
                'organic', 'milk', 'bread', 'egg', 'cheese', 'yogurt', 'butter',
                'meat', 'chicken', 'beef', 'pork', 'fish', 'salmon', 'shrimp', 'turkey',
                'vegetable', 'fruit', 'apple', 'banana', 'orange', 'produce', 'lettuce', 'tomato',
                'honeycrisp', 'grapes', 'berries', 'strawberry', 'blueberry',
                'cereal', 'oatmeal', 'granola', 'snack', 'chip', 'cookie', 'cracker',
                'frozen', 'pizza', 'ice cream', 'juice', 'soda', 'water', 'coffee', 'tea',
                'pasta', 'rice', 'beans', 'soup', 'sauce', 'condiment', 'mayo', 'ketchup', 'mustard',
                'serenity kids', 'baby food', 'gerber', 'puree', 'pouch',  // Baby food is still food
                'free range', 'grass fed', 'cage free', 'non-gmo'
            ];
            for (const kw of foodGroceriesKeywords) {
                if (name.includes(kw)) return { category: 'Food Groceries', matchedKeyword: kw };
            }

            // ========== OTHER CATEGORIES ==========
            // Personal (salon, beauty services - different from personal care groceries)
            const personalKeywords = [
                'makeup', 'cosmetic', 'mascara', 'lipstick', 'foundation', 'concealer',
                'beauty', 'skincare', 'hair care', 'nail polish', 'salon', 'spa'
            ];
            for (const kw of personalKeywords) {
                if (name.includes(kw)) return { category: 'Personal', matchedKeyword: kw };
            }

            // Baby (actual baby gear, not consumables)
            const babyKeywords = [
                'stroller', 'crib', 'car seat', 'high chair', 'baby monitor',
                'pacifier', 'bottle', 'sippy', 'bib', 'onesie', 'infant formula',
                'enfamil', 'similac', 'nursery', 'baby clothes'
            ];
            for (const kw of babyKeywords) {
                if (name.includes(kw)) return { category: 'Baby', matchedKeyword: kw };
            }

            // Pet
            const petKeywords = [
                'dog food', 'cat food', 'pet food', 'purina', 'pedigree', 'iams', 'blue buffalo',
                'cat litter', 'kitty litter', 'pet treat', 'dog treat', 'cat treat',
                'leash', 'collar', 'pet toy', 'chew toy'
            ];
            for (const kw of petKeywords) {
                if (name.includes(kw)) return { category: 'Pet', matchedKeyword: kw };
            }

            // Electronics / Entertainment
            const electronicsKeywords = [
                'cable', 'charger', 'adapter', 'battery', 'duracell', 'energizer',
                'hdmi', 'usb', 'phone', 'case', 'headphone', 'earbuds', 'airpods',
                'speaker', 'bluetooth', 'game', 'video game', 'nintendo', 'playstation', 'xbox',
                'toy', 'lego', 'dvd', 'blu-ray', 'movie', 'book'
            ];
            for (const kw of electronicsKeywords) {
                if (name.includes(kw)) return { category: 'Entertainment', matchedKeyword: kw };
            }

            // Clothing
            const clothingKeywords = [
                'shirt', 't-shirt', 'tshirt', 'pants', 'jeans', 'shorts', 'dress',
                'shoes', 'sneaker', 'boot', 'sandal', 'sock', 'underwear', 'boxer', 'brief',
                'jacket', 'coat', 'sweater', 'hoodie', 'sweatshirt'
            ];
            for (const kw of clothingKeywords) {
                if (name.includes(kw)) return { category: 'Clothing', matchedKeyword: kw };
            }

            return { category: null, matchedKeyword: null };
        },

        // Categorize an item based on patterns (legacy - keeping for compatibility)
        categorizeItem(itemName, patterns) {
        },

        // Categorize an item based on patterns (legacy - keeping for compatibility)
        categorizeItem(itemName, patterns) {
            const result = this.categorizeByKeywords(itemName);
            return result.category;
        },

        // Get default category for a store (used as fallback placeholder)
        getDefaultCategory(store) {
            const defaults = {
                target: 'Food Groceries',
                fredmeyer: 'Food Groceries',
                costco: 'Food Groceries',
                amazon: 'Shopping'
            };
            return defaults[store] || 'Other';
        },

        // Render a split suggestion card
        renderSplitSuggestion(suggestion, index) {
            const { transaction, receipt, categories, matchConfidence } = suggestion;
            const categoryList = Object.entries(categories)
                .sort((a, b) => b[1].total - a[1].total)
                .map(([cat, data]) => {
                    // Render items list for this category
                    const itemsList = data.items.map(item => {
                        const itemName = item.name.length > 50 ? item.name.substring(0, 47) + '...' : item.name;
                        return `<div class="edb-split-item">
                            <span class="edb-item-name" title="${this.escapeHtml(item.name)}">${this.escapeHtml(itemName)}</span>
                            <span class="edb-item-price">$${item.adjustedPrice?.toFixed(2) || item.price?.toFixed(2) || '0.00'}</span>
                        </div>`;
                    }).join('');

                    return `
                    <div class="edb-split-category-section">
                        <div class="edb-split-category-header" data-category="${this.escapeHtml(cat)}">
                            <span class="edb-cat-toggle">▶</span>
                            <span class="edb-cat-name">${this.escapeHtml(cat)}</span>
                            <span class="edb-cat-amount">$${data.total.toFixed(2)}</span>
                            <span class="edb-cat-items">(${data.items.length} items)</span>
                        </div>
                        <div class="edb-split-items-list edb-hidden">
                            ${itemsList}
                        </div>
                    </div>
                `}).join('');

            const confidenceClass = matchConfidence >= 0.8 ? 'high' : matchConfidence >= 0.5 ? 'medium' : 'low';

            return `
                <div class="edb-split-card" data-tx-id="${transaction.id}">
                    <div class="edb-split-card-header">
                        <input type="checkbox" class="edb-split-checkbox" data-tx-id="${transaction.id}" checked>
                        <div class="edb-split-tx">
                            <strong>${this.escapeHtml(transaction.name)}</strong>
                            <span>$${transaction.amount.toFixed(2)}</span>
                        </div>
                    </div>
                    <div class="edb-split-receipt">
                        ${this.getStoreIcon(receipt.store)} ${new Date(receipt.date).toLocaleDateString()}
                        - ${receipt.items?.length || 0} items
                        <span class="edb-match-confidence edb-confidence-${confidenceClass}" title="Match confidence">
                            ${Math.round(matchConfidence * 100)}% match
                        </span>
                    </div>
                    <div class="edb-split-breakdown">
                        ${categoryList}
                    </div>
                    <button class="edb-btn edb-btn-primary edb-split-btn" data-tx-id="${transaction.id}">
                        ✂️ Apply Split
                    </button>
                </div>
            `;
        },

        // Apply a split to a transaction
        async applySplit(suggestion) {
            const { transaction, receipt, categories } = suggestion;

            this.updateStatus('Applying split...');

            try {
                // Click on the transaction to open the edit dialog
                transaction.element?.click();

                // Wait for dialog to open
                await new Promise(resolve => setTimeout(resolve, 500));

                // Look for the split button in EveryDollar
                const splitBtn = document.querySelector('[data-testid="split-transaction"], button:contains("Split")');

                if (splitBtn) {
                    splitBtn.click();
                    await new Promise(resolve => setTimeout(resolve, 300));

                    // TODO: Fill in the split amounts based on categories
                    // This requires understanding EveryDollar's split UI

                    this.updateStatus('Split dialog opened. Enter the amounts manually.');
                } else {
                    // No split button found - show manual instructions
                    const amounts = Object.entries(categories)
                        .map(([cat, data]) => `${cat}: $${data.total.toFixed(2)}`)
                        .join('\n');

                    alert(`Split this transaction:\n\n${amounts}\n\nUse EveryDollar's split feature to divide the transaction.`);
                    this.updateStatus('Split amounts calculated. Apply manually.');
                }
            } catch (error) {
                console.error('Failed to apply split:', error);
                this.updateStatus('Failed to apply split');
            }
        },

        // Handle message from store scrapers
        async handleReceiptsUpdated(store, count, autoRefresh = false, scrapeComplete = false) {

            // Remove receipt prompt since receipts are arriving
            document.getElementById('edb-receipt-prompt')?.remove();

            // Notify deep learning if it's waiting for stores
            if (scrapeComplete || count > 0) {
                this.storeScrapingComplete(store);
            }

            // Only update UI if we're not in deep learning mode (to avoid UI thrashing)
            if (!this.pendingStores || this.pendingStores.size === 0) {
                this.updateStatus(`Imported ${count} receipts from ${store}`);
                await this.loadStoreReceipts();

                // Always re-run the pipeline so Awaiting Receipt counts update in real-time
                await this.processTransactionPipeline();
            } else {
                // Just update status during deep learning
                this.updateStatus(`📚 ${store} complete (${this.pendingStores.size} stores remaining)...`);
            }
        },

        // Build a dev snapshot with everything the content script can see.
        async buildEverythingExport() {
            const storage = {
                local: await this.getStorageAreaSnapshot('local'),
                sync: await this.getStorageAreaSnapshot('sync')
            };

            const storageLocal = storage.local?.data || {};
            const storageSync = storage.sync?.data || {};
            const merchantRules = storageLocal[StorageManager.KEYS.MERCHANT_RULES] || {};
            const itemRules = storageLocal[StorageManager.KEYS.ITEM_RULES] || {};
            const keywordWeights = storageLocal[StorageManager.KEYS.KEYWORD_WEIGHTS] || {};
            const categoryMap = storageLocal[StorageManager.KEYS.CATEGORY_MAP] || {};
            const receipts = storageLocal[StorageManager.KEYS.STORE_RECEIPTS] || [];
            const reviewQueue = storageLocal[StorageManager.KEYS.REVIEW_QUEUE] || [];
            const editedSplits = storageLocal[StorageManager.KEYS.EDITED_SPLITS] || {};

            let categoryOptions = [];
            try {
                categoryOptions = await this.getBudgetCategoryNames();
            } catch (error) {
                categoryOptions = [];
            }

            return {
                exportedAt: new Date().toISOString(),
                source: 'everydollar-content-script',
                url: location.href,
                title: document.title,
                page: this.buildPageExport(),
                extensionState: {
                    currentBudgetMonth: this.currentBudgetMonth,
                    isProcessing: this.isProcessing,
                    isSyncingMonth: this.isSyncingMonth,
                    isAutoLearningInProgress: this._isAutoLearningInProgress,
                    isLoadingMonths: this._isLoadingMonths,
                    isBackgroundRefreshing: this._isBackgroundRefreshing,
                    receiptPromptDismissed: this._receiptPromptDismissed
                },
                counts: {
                    transactions: this.transactions.length,
                    suggestions: this.suggestions.size,
                    categories: this.categories?.length || 0,
                    categoryOptions: categoryOptions.length,
                    receipts: receipts.length,
                    merchantRules: Object.keys(merchantRules).length,
                    itemRules: Object.keys(itemRules).length,
                    keywordWeights: Object.keys(keywordWeights).length,
                    categoryMap: Object.keys(categoryMap).length,
                    reviewQueue: Array.isArray(reviewQueue) ? reviewQueue.length : 0,
                    editedSplits: Object.keys(editedSplits).length,
                    awaiting: this.lastAwaitingItems?.length || 0,
                    categorize: this.lastCategorizeItems?.length || 0,
                    ready: this.lastReadyItems?.length || 0
                },
                categories: this.makeExportable(this.categories || []),
                categoryOptions,
                transactions: this.transactions.map(tx => this.serializeTransactionForExport(tx)),
                suggestions: Object.fromEntries(
                    [...this.suggestions.entries()].map(([id, suggestion]) => [id, this.makeExportable(suggestion)])
                ),
                pipeline: {
                    awaiting: this.serializePipelineItemsForExport(this.lastAwaitingItems || []),
                    categorize: this.serializePipelineItemsForExport(this.lastCategorizeItems || []),
                    ready: this.serializePipelineItemsForExport(this.lastReadyItems || [])
                },
                knowledge: {
                    merchantRules,
                    itemRules,
                    keywordWeights,
                    categoryMap,
                    reviewQueue,
                    editedSplits,
                    learnedTransactions: storageLocal[StorageManager.KEYS.LEARNED_TRANSACTIONS] || [],
                    learningLog: storageLocal[StorageManager.KEYS.LEARNING_LOG] || [],
                    lastLearningScan: storageLocal[StorageManager.KEYS.LAST_LEARNING_SCAN] || storageSync[StorageManager.KEYS.LAST_LEARNING_SCAN] || null
                },
                receipts,
                storage
            };
        },

        async getStorageAreaSnapshot(areaName) {
            try {
                const area = chrome.storage?.[areaName];
                if (!area) {
                    return { success: false, error: `chrome.storage.${areaName} is unavailable` };
                }
                const data = await area.get(null);
                let bytesInUse = null;
                if (area.getBytesInUse) {
                    try {
                        bytesInUse = await area.getBytesInUse();
                    } catch (e) {
                        bytesInUse = null;
                    }
                }
                return {
                    success: true,
                    bytesInUse,
                    keys: Object.keys(data),
                    data
                };
            } catch (error) {
                return { success: false, error: error.message };
            }
        },

        buildPageExport() {
            const transactionCards = [...document.querySelectorAll('[data-testid="unallocated_card"], [data-testid="tracked_card"], .TransactionCard')]
                .map(card => this.summarizeElementForExport(card));

            return {
                url: location.href,
                title: document.title,
                readyState: document.readyState,
                viewport: {
                    width: window.innerWidth,
                    height: window.innerHeight,
                    scrollX: window.scrollX,
                    scrollY: window.scrollY
                },
                monthHeader: document.querySelector('h1, [class*="month"]')?.textContent?.trim() || null,
                statusText: document.getElementById('edb-status')?.textContent?.trim() || null,
                extensionUi: {
                    hasContainer: !!document.getElementById('edb-container'),
                    hasPanel: !!document.getElementById('edb-panel'),
                    panelHidden: document.getElementById('edb-panel')?.classList.contains('edb-hidden') ?? null,
                    badge: document.getElementById('edb-badge')?.textContent || null,
                    awaitingCount: document.getElementById('edb-awaiting-count')?.textContent || null,
                    categorizeCount: document.getElementById('edb-categorize-count')?.textContent || null,
                    readyCount: document.getElementById('edb-ready-count')?.textContent || null
                },
                budgetItems: [...document.querySelectorAll('.BudgetItem-label[data-text]')].map(label => ({
                    text: label.textContent?.trim() || '',
                    dataText: label.getAttribute('data-text')
                })),
                transactionCards,
                bodyText: document.body?.innerText || ''
            };
        },

        serializeTransactionForExport(tx) {
            const exported = this.makeExportable(tx);
            return {
                ...exported,
                store: this.getStoreForTransaction(tx),
                isStoreTransaction: this.isStoreTransaction(tx),
                matchesCurrentMonth: this.txMatchesCurrentMonth(tx)
            };
        },

        serializePipelineItemsForExport(items) {
            return items.map(item => this.makeExportable(item));
        },

        makeExportable(value, depth = 0, seen = new WeakSet()) {
            if (value === null || value === undefined) return value;
            if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
            if (typeof value === 'function') return `[Function ${value.name || 'anonymous'}]`;
            if (value instanceof Date) return value.toISOString();
            if (value instanceof Element) return this.summarizeElementForExport(value);
            if (typeof Node !== 'undefined' && value instanceof Node) {
                return {
                    nodeType: value.nodeType,
                    nodeName: value.nodeName,
                    text: value.textContent?.trim()?.slice(0, 500) || ''
                };
            }
            if (depth > 8) return '[MaxDepth]';

            if (typeof value === 'object') {
                if (seen.has(value)) return '[Circular]';
                seen.add(value);
            }

            if (Array.isArray(value)) {
                return value.map(item => this.makeExportable(item, depth + 1, seen));
            }

            if (value instanceof Map) {
                return Object.fromEntries(
                    [...value.entries()].map(([key, mapValue]) => [key, this.makeExportable(mapValue, depth + 1, seen)])
                );
            }

            if (value instanceof Set) {
                return [...value].map(item => this.makeExportable(item, depth + 1, seen));
            }

            const output = {};
            for (const [key, item] of Object.entries(value)) {
                try {
                    output[key] = this.makeExportable(item, depth + 1, seen);
                } catch (error) {
                    output[key] = `[Unserializable: ${error.message}]`;
                }
            }
            return output;
        },

        summarizeElementForExport(element) {
            if (!element) return null;
            const rect = element.getBoundingClientRect();
            return {
                tagName: element.tagName,
                id: element.id || '',
                className: typeof element.className === 'string' ? element.className : '',
                testId: element.getAttribute('data-testid'),
                text: element.textContent?.trim() || '',
                dataset: { ...element.dataset },
                rect: {
                    x: Math.round(rect.x),
                    y: Math.round(rect.y),
                    width: Math.round(rect.width),
                    height: Math.round(rect.height)
                }
            };
        },

        // Handle messages from popup/background
        async handleMessage(msg, sendResponse) {
            switch (msg.action) {
                case 'getStatus':
                    sendResponse({
                        transactionCount: this.transactions.length,
                        suggestionCount: this.suggestions.size,
                        currentMonth: this.currentBudgetMonth
                    });
                    break;

                case 'exportEverything':
                case 'getPreviewSnapshot':
                    sendResponse({
                        success: true,
                        snapshot: await this.buildEverythingExport()
                    });
                    break;

                case 'scan':
                    await this.scanTransactions();
                    sendResponse({ success: true });
                    break;

                case 'applyAll':
                    await this.applyAllSuggestions();
                    sendResponse({ success: true });
                    break;

                case 'receiptsUpdated':
                    // Store scraper finished
                    this.handleReceiptsUpdated(msg.store, msg.count, msg.autoRefresh, msg.scrapeComplete);
                    sendResponse({ success: true });
                    break;

                case 'updateReceipt':
                    // Update transaction with receipt data
                    const { transactionId, receipt } = msg;
                    const tx = this.transactions.find(t => t.id === transactionId);
                    if (tx) {
                        // Calculate split if applicable
                        const split = await Categorizer.calculateSplit(tx, receipt);
                        sendResponse({ success: true, split });
                    }
                    break;

                default:
                    sendResponse({ error: 'Unknown action' });
            }
        },

        // Utility: escape HTML
        escapeHtml(str) {
            const div = document.createElement('div');
            div.textContent = str;
            return div.innerHTML;
        },

        // Check if any items are missing prices
        hasItemsWithoutPrices(items) {
            if (!items || items.length === 0) return false;
            return items.some(item => !item.price);
        }
    };

    // Expose debug utilities - listen for messages from page context
    window.addEventListener('message', async (event) => {
        // Only handle our debug messages (EDB_DEBUG_ prefix)
        if (!event.data?.type?.startsWith('EDB_DEBUG_')) return;

        let result;
        try {
            switch (event.data.type) {
                case 'EDB_DEBUG_CLEAR_RECEIPTS':
                    const receipts = await StorageManager.get(StorageManager.KEYS.STORE_RECEIPTS) || [];
                    const store = event.data.store;
                    let filtered;
                    if (store) {
                        filtered = receipts.filter(r => r.store !== store);
                    } else {
                        filtered = [];
                    }
                    await StorageManager.set(StorageManager.KEYS.STORE_RECEIPTS, filtered);
                    result = { removed: receipts.length - filtered.length, remaining: filtered.length };
                    break;

                case 'EDB_DEBUG_LIST_RECEIPTS':
                    const allReceipts = await StorageManager.get(StorageManager.KEYS.STORE_RECEIPTS) || [];
                    const storeFilter = event.data.store;
                    result = storeFilter ? allReceipts.filter(r => r.store === storeFilter) : allReceipts;
                    break;

                case 'EDB_DEBUG_REFRESH':
                    await EDB.scanTransactions();
                    await EDB.processTransactionPipeline();
                    result = { success: true };
                    break;

                case 'EDB_DEBUG_STATE':
                    result = {
                        transactions: EDB.transactions.length,
                        categories: EDB.categories.length,
                        suggestions: EDB.suggestions.size,
                        editedSplits: EDB.editedSplits.size,
                        budgetMonth: EDB.currentBudgetMonth
                    };
                    break;

                case 'EDB_DEBUG_CLEAR_LEARNING_SCAN':
                    await StorageManager.set(StorageManager.KEYS.LAST_LEARNING_SCAN, null);
                    result = { success: true, message: 'Learning scan timestamp cleared' };
                    break;

                case 'EDB_DEBUG_TRIGGER_LEARN':
                    await StorageManager.set(StorageManager.KEYS.LAST_LEARNING_SCAN, null);
                    EDB.checkAndRunAutoLearning();
                    result = { success: true, message: 'Auto-learning triggered' };
                    break;
            }
        } catch (e) {
            result = { error: e.message };
        }

        window.postMessage({ type: event.data.type + '_RESULT', result }, '*');
    });

    // Debug utilities (inline script injection disabled due to CSP in Manifest V3)
    // Use chrome.storage APIs directly from console instead

    // Initialize when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => EDB.init());
    } else {
        EDB.init();
    }
})();
