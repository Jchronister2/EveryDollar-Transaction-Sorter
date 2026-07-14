// Storage utility with Chrome sync, local fallback, and JSON export/import
// Handles the ~100KB sync limit gracefully

const StorageManager = {
    SYNC_LIMIT: 100000, // ~100KB Chrome sync limit
    _contextInvalidated: false,
    _contextWarningShown: false,

    // Check if extension context is still valid
    isContextValid() {
        try {
            // Try to access chrome.runtime.id - this will throw if context is invalidated
            return !!chrome.runtime?.id;
        } catch (e) {
            return false;
        }
    },

    // Show a warning to the user that they need to refresh
    showContextInvalidatedWarning() {
        if (this._contextWarningShown) return;
        this._contextWarningShown = true;

        // Create a floating warning banner
        const existing = document.getElementById('edb-context-warning');
        if (existing) existing.remove();

        const warning = document.createElement('div');
        warning.id = 'edb-context-warning';
        warning.innerHTML = `
            <div style="position: fixed; top: 10px; left: 50%; transform: translateX(-50%);
                        background: #ff6b6b; color: white; padding: 12px 24px; border-radius: 8px;
                        box-shadow: 0 4px 12px rgba(0,0,0,0.3); z-index: 999999;
                        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                        display: flex; align-items: center; gap: 12px;">
                <span>⚠️ Extension was updated. Please refresh the page to continue.</span>
                <button onclick="location.reload()" style="background: white; color: #ff6b6b;
                        border: none; padding: 6px 12px; border-radius: 4px; cursor: pointer;
                        font-weight: bold;">Refresh Now</button>
                <button onclick="this.parentElement.remove()" style="background: transparent;
                        color: white; border: 1px solid white; padding: 6px 12px; border-radius: 4px;
                        cursor: pointer;">Dismiss</button>
            </div>
        `;
        document.body.appendChild(warning);

    },

    // Storage keys
    KEYS: {
        RENAME_RULES: 'renameRules',
        CATEGORY_PATTERNS: 'categoryPatterns',
        LEARNED_TRANSACTIONS: 'learnedTransactions',
        SEASONAL_PATTERNS: 'seasonalPatterns',
        STORE_RECEIPTS: 'storeReceipts',
        SCRAPED_BUDGETS: 'scrapedBudgets',
        KNOWLEDGE_GAPS: 'knowledgeGaps',
        SETTINGS: 'settings',
        MERCHANT_RULES: 'merchantRules',    // Merchant → Category mapping
        LEARNING_LOG: 'learningLog',         // Log of learning events
        ITEM_RULES: 'itemRules',             // Item name → Category mapping (user-trained)
        REVIEW_QUEUE: 'reviewQueue',         // Items needing user categorization
        KEYWORD_WEIGHTS: 'keywordWeights',   // Keyword → Category weights (word frequency learning)
        CATEGORY_MAP: 'categoryMap',         // Pattern category → Budget item mapping (auto-learned)
        EDITED_SPLITS: 'editedSplits',       // User edits to split transactions (persisted until applied)
        LAST_LEARNING_SCAN: 'lastLearningScan',  // Timestamp of last automatic learning scan
        TX_CACHE: 'txCache'               // Cached transaction scans per budget month
    },

    // Store department → EveryDollar category mapping
    STORE_CATEGORY_MAP: {
        // Fred Meyer / Kroger departments
        'pharmacy': 'Health',
        'health': 'Health',
        'vitamin': 'Health',
        'medicine': 'Health',
        'first aid': 'Health',
        'produce': 'Food and Household',
        'grocery': 'Food and Household',
        'dairy': 'Food and Household',
        'meat': 'Food and Household',
        'seafood': 'Food and Household',
        'bakery': 'Food and Household',
        'frozen': 'Food and Household',
        'deli': 'Food and Household',
        'beverages': 'Food and Household',
        'snacks': 'Food and Household',
        'household': 'Food and Household',
        'cleaning': 'Food and Household',
        'paper': 'Food and Household',
        'beauty': 'Personal',
        'cosmetics': 'Personal',
        'personal care': 'Personal',
        'hair care': 'Personal',
        'skin care': 'Personal',
        'baby': 'Baby',
        'infant': 'Baby',
        'pet': 'Pet',
        'pet supplies': 'Pet',
        'electronics': 'Entertainment',
        'toys': 'Entertainment',
        'games': 'Entertainment',
        'clothing': 'Clothing',
        'apparel': 'Clothing',
        'shoes': 'Clothing',
        // Target departments
        'health & beauty': 'Health',
        'household essentials': 'Food and Household',
        'food & beverage': 'Food and Household',
        'home': 'Food and Household',
        // Amazon departments
        'health & personal care': 'Health',
        'grocery & gourmet food': 'Food and Household',
        'books': 'Entertainment',
        'movies & tv': 'Entertainment',
        'video games': 'Entertainment'
    },

    // Initialize with defaults
    async init() {
        const defaults = {
            [this.KEYS.RENAME_RULES]: {},
            [this.KEYS.CATEGORY_PATTERNS]: this.getDefaultPatterns(),
            [this.KEYS.LEARNED_TRANSACTIONS]: [],
            [this.KEYS.SEASONAL_PATTERNS]: this.getDefaultSeasonalPatterns(),
            [this.KEYS.STORE_RECEIPTS]: [],
            [this.KEYS.SCRAPED_BUDGETS]: {},
            [this.KEYS.KNOWLEDGE_GAPS]: [],
            [this.KEYS.MERCHANT_RULES]: {},       // { "merchantName": { category: "...", count: N, lastSeen: "..." } }
            [this.KEYS.LEARNING_LOG]: [],          // Array of learning events
            [this.KEYS.ITEM_RULES]: {},            // { "normalized_item_name": { category: "...", count: N } }
            [this.KEYS.REVIEW_QUEUE]: [],          // Items needing user categorization
            [this.KEYS.SETTINGS]: {
                autoApplyHighConfidence: true,
                confidenceThreshold: 0.75,
                showNotifications: true
            }
        };

        for (const [key, defaultValue] of Object.entries(defaults)) {
            const existing = await this.get(key);
            if (existing === null || existing === undefined) {
                await this.set(key, defaultValue);
            }
        }
    },

    // Default category patterns (starter ruleset)
    getDefaultPatterns() {
        return {
            'Food and Household': {
                patterns: [
                    'safeway', 'kroger', 'fred\\s*meyer', 'albertsons', 'trader\\s*joe',
                    'whole\\s*foods', 'costco', 'walmart', 'target', 'grocery', 'groceries',
                    'produce', 'market', 'food.*mart', 'carrs', 'three bears'
                ],
                keywords: ['apple', 'milk', 'bread', 'eggs', 'vegetables', 'fruit', 'meat', 'chicken', 'beef']
            },
            'Transportation': {
                patterns: [
                    'shell', 'chevron', 'bp', 'exxon', 'mobil', 'tesoro', 'gas', 'fuel',
                    'uber', 'lyft', 'taxi', 'parking', 'dmv', 'alaska\\s*air', 'delta'
                ],
                keywords: ['gas', 'fuel', 'oil change', 'car wash', 'parking']
            },
            'Housing & Utilities': {
                patterns: [
                    'alaska.*electric', 'enstar', 'gci', 'att', 'verizon', 'comcast',
                    'water.*utility', 'electric', 'power', 'internet', 'cable'
                ],
                keywords: ['rent', 'mortgage', 'electric', 'gas bill', 'water bill', 'internet']
            },
            'Health': {
                patterns: [
                    'cvs', 'walgreens', 'pharmacy', 'medical', 'doctor', 'hospital',
                    'clinic', 'dental', 'vision', 'optom', 'providence', 'alaska.*regional'
                ],
                keywords: ['medicine', 'prescription', 'vitamin', 'health', 'doctor', 'dentist']
            },
            'Giving': {
                patterns: [
                    'church', 'tithe', 'charity', 'donation', 'nonprofit', 'red\\s*cross',
                    'salvation\\s*army', 'goodwill'
                ],
                keywords: ['tithe', 'offering', 'donation', 'charity']
            },
            'Restaurants': {
                patterns: [
                    'mcdonald', 'burger\\s*king', 'wendy', 'subway', 'starbucks', 'dunkin',
                    'pizza', 'grill', 'cafe', 'coffee', 'diner', 'restaurant', 'bar\\s*&\\s*grill',
                    'kaladi', 'moose.*tooth', 'spenard.*roadhouse'
                ],
                keywords: ['restaurant', 'dining', 'takeout', 'delivery', 'doordash', 'grubhub']
            },
            'Entertainment': {
                patterns: [
                    'netflix', 'hulu', 'disney', 'spotify', 'apple.*music', 'amazon.*prime',
                    'movie', 'theater', 'cinema', 'regal', 'amc', 'bowling', 'arcade'
                ],
                keywords: ['movie', 'concert', 'show', 'game', 'subscription', 'streaming']
            },
            'Personal': {
                patterns: [
                    'salon', 'barber', 'spa', 'nail', 'hair', 'beauty', 'cosmetic'
                ],
                keywords: ['haircut', 'salon', 'grooming']
            }
        };
    },

    // Default seasonal patterns
    getDefaultSeasonalPatterns() {
        return {
            'Gifts': {
                dateRanges: [
                    { name: 'Christmas', start: { month: 11, day: 15 }, end: { month: 12, day: 26 } },
                    { name: 'Valentines', start: { month: 2, day: 1 }, end: { month: 2, day: 15 } }
                ],
                patterns: ['gift', 'present', 'toy', 'amazon', 'target', 'walmart']
            }
        };
    },

    // Get data from storage (tries sync first, falls back to local)
    async get(key) {
        // Check if extension context is still valid
        if (!this.isContextValid()) {
            this.showContextInvalidatedWarning();
            return null;
        }

        try {
            // Some keys are always in local storage
            if (this.LOCAL_ONLY_KEYS.includes(key)) {
                const localResult = await chrome.storage.local.get(key);
                return localResult[key];
            }

            // Try sync storage first
            const syncResult = await chrome.storage.sync.get(key);
            if (syncResult[key] !== undefined) {
                return syncResult[key];
            }

            // Fall back to local storage
            const localResult = await chrome.storage.local.get(key);
            return localResult[key];
        } catch (error) {
            // Check if this is a context invalidation error
            if (error.message?.includes('Extension context invalidated')) {
                this.showContextInvalidatedWarning();
                return null;
            }
            console.error('Storage get error:', error);
            return null;
        }
    },

    // Keys that should always use local storage (too large for sync)
    LOCAL_ONLY_KEYS: ['learnedTransactions', 'merchantRules', 'learningLog', 'storeReceipts', 'itemRules', 'reviewQueue', 'keywordWeights', 'categoryMap', 'editedSplits', 'txCache'],

    // Set data to storage (uses sync if under limit, otherwise local)
    async set(key, value) {
        // Check if extension context is still valid
        if (!this.isContextValid()) {
            this.showContextInvalidatedWarning();
            return;
        }

        try {
            // Some keys are always local storage due to size
            if (this.LOCAL_ONLY_KEYS.includes(key)) {
                await chrome.storage.local.set({ [key]: value });
                return;
            }

            const serialized = JSON.stringify({ [key]: value });

            // Chrome sync has ~8KB per item limit and ~100KB total
            if (serialized.length < 8000) {
                await chrome.storage.sync.set({ [key]: value });
            } else {
                await chrome.storage.local.set({ [key]: value });
                // Mark that this key is in local storage
                await chrome.storage.sync.set({ [`${key}_isLocal`]: true });
            }
        } catch (error) {
            // Check if this is a context invalidation error
            if (error.message?.includes('Extension context invalidated')) {
                this.showContextInvalidatedWarning();
                return;
            }
            console.error('Storage set error:', error);
            // Fall back to local on any error
            try {
                await chrome.storage.local.set({ [key]: value });
            } catch (localError) {
                if (localError.message?.includes('Extension context invalidated')) {
                    this.showContextInvalidatedWarning();
                    return;
                }
                console.error('Local storage also failed:', localError);
            }
        }
    },

    // Export all data as JSON
    async exportToJSON() {
        const allData = {};
        for (const key of Object.values(this.KEYS)) {
            allData[key] = await this.get(key);
        }
        return JSON.stringify(allData, null, 2);
    },

    // Import from JSON
    async importFromJSON(jsonString) {
        try {
            const data = JSON.parse(jsonString);
            for (const [key, value] of Object.entries(data)) {
                if (Object.values(this.KEYS).includes(key)) {
                    await this.set(key, value);
                }
            }
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    },

    // Add a rename rule
    async addRenameRule(originalPattern, newName) {
        const rules = await this.get(this.KEYS.RENAME_RULES) || {};
        rules[originalPattern.toLowerCase()] = newName;
        await this.set(this.KEYS.RENAME_RULES, rules);
    },

    // Learn from a categorization
    async learnCategorization(transaction, category, source = 'manual') {
        const learned = await this.get(this.KEYS.LEARNED_TRANSACTIONS) || [];

        learned.push({
            name: transaction.name,
            amount: transaction.amount,
            date: transaction.date,
            category: category,
            source: source, // 'manual', 'scraped', 'imported'
            learnedAt: new Date().toISOString()
        });

        // Keep last 1000 transactions to prevent bloat
        if (learned.length > 1000) {
            learned.shift();
        }

        await this.set(this.KEYS.LEARNED_TRANSACTIONS, learned);
    },

    // Record a scraped budget month
    async recordScrapedBudget(yearMonth) {
        const scraped = await this.get(this.KEYS.SCRAPED_BUDGETS) || {};
        scraped[yearMonth] = {
            scrapedAt: new Date().toISOString(),
            transactionCount: 0
        };
        await this.set(this.KEYS.SCRAPED_BUDGETS, scraped);
        await this.updateKnowledgeGaps();
    },

    // Update knowledge gaps analysis
    async updateKnowledgeGaps() {
        const scraped = await this.get(this.KEYS.SCRAPED_BUDGETS) || {};
        const scrapedMonths = Object.keys(scraped).sort();

        if (scrapedMonths.length === 0) {
            await this.set(this.KEYS.KNOWLEDGE_GAPS, ['No budget data scraped yet']);
            return;
        }

        const gaps = [];
        const now = new Date();
        const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

        // Find gaps between scraped months
        for (let i = 0; i < scrapedMonths.length - 1; i++) {
            const current = scrapedMonths[i];
            const next = scrapedMonths[i + 1];

            const [currYear, currMonth] = current.split('-').map(Number);
            const [nextYear, nextMonth] = next.split('-').map(Number);

            let checkDate = new Date(currYear, currMonth, 1); // Month after current
            const endDate = new Date(nextYear, nextMonth - 1, 1);

            while (checkDate < endDate) {
                const checkMonth = `${checkDate.getFullYear()}-${String(checkDate.getMonth() + 1).padStart(2, '0')}`;
                if (!scraped[checkMonth]) {
                    gaps.push(checkMonth);
                }
                checkDate.setMonth(checkDate.getMonth() + 1);
            }
        }

        // Check if we're missing recent months
        const lastScraped = scrapedMonths[scrapedMonths.length - 1];
        const [lastYear, lastMonth] = lastScraped.split('-').map(Number);
        let checkDate = new Date(lastYear, lastMonth, 1);
        const endDate = new Date(now.getFullYear(), now.getMonth() + 1, 1);

        while (checkDate < endDate) {
            const checkMonth = `${checkDate.getFullYear()}-${String(checkDate.getMonth() + 1).padStart(2, '0')}`;
            if (!scraped[checkMonth]) {
                gaps.push(checkMonth);
            }
            checkDate.setMonth(checkDate.getMonth() + 1);
        }

        await this.set(this.KEYS.KNOWLEDGE_GAPS, gaps);
    },

    // Store receipt data from external stores
    async addStoreReceipt(receipt) {
        const receipts = await this.get(this.KEYS.STORE_RECEIPTS) || [];

        // Check for existing order by orderId (primary) or by store+date+total (fallback)
        const existingIndex = receipts.findIndex(r =>
            (r.orderId && receipt.orderId && r.orderId === receipt.orderId && r.store === receipt.store) ||
            (r.store === receipt.store && r.date === receipt.date && Math.abs(r.total - receipt.total) < 0.02)
        );

        if (existingIndex >= 0) {
            // Merge/update existing receipt - prefer new data but keep original date if new is today
            const existing = receipts[existingIndex];
            const today = new Date().toISOString().split('T')[0];
            const newDateIsToday = receipt.date && receipt.date.startsWith(today);

            // Merge items - update prices if new receipt has them
            let mergedItems = existing.items || [];
            if (receipt.items && receipt.items.length > 0) {
                // If new receipt has item prices, use those items
                const hasNewPrices = receipt.items.some(i => i.price > 0);
                if (hasNewPrices) {
                    mergedItems = receipt.items;
                }
            }

            receipts[existingIndex] = {
                ...existing,
                ...receipt,
                date: newDateIsToday ? existing.date : (receipt.date || existing.date),
                items: mergedItems,
                updatedAt: new Date().toISOString()
            };
        } else {
            // New receipt
            receipts.push({
                ...receipt,
                importedAt: new Date().toISOString()
            });
        }

        await this.set(this.KEYS.STORE_RECEIPTS, receipts);
        return existingIndex < 0; // Returns true if new, false if updated
    },

    // Find matching receipt for a transaction using multi-factor confidence scoring
    async findMatchingReceipt(transaction) {
        const result = await this.findMatchingReceiptWithConfidence(transaction);
        return result?.receipt || null;
    },

    // Find matching receipt with confidence score and details
    async findMatchingReceiptWithConfidence(transaction) {
        const receipts = await this.get(this.KEYS.STORE_RECEIPTS) || [];
        if (receipts.length === 0) return null;

        const txDate = new Date(transaction.date);
        const txAmount = Math.abs(parseFloat(transaction.amount));
        const txName = (transaction.name || '').toLowerCase();

        let bestMatch = null;
        let bestScore = 0;

        // Store name patterns for matching
        const storePatterns = {
            target: ['target'],
            fredmeyer: ['fred meyer', 'fredmeyer', 'kroger', 'fred-meyer'],
            amazon: ['amazon', 'amzn', 'prime'],
            costco: ['costco']
        };

        for (const receipt of receipts) {
            let score = 0;
            const factors = [];

            const receiptDate = new Date(receipt.date);
            const daysDiff = Math.abs((txDate - receiptDate) / (1000 * 60 * 60 * 24));
            const amountDiff = Math.abs(receipt.total - txAmount);

            // Factor 1: Amount match (0-40 points)
            if (amountDiff < 0.02) {
                score += 40;
                factors.push('exact_amount');
            } else if (amountDiff < 1.00) {
                score += 30;
                factors.push('close_amount');
            } else if (amountDiff < 5.00) {
                score += 15;
                factors.push('near_amount');
            }

            // Factor 2: Date proximity (0-30 points)
            if (daysDiff === 0) {
                score += 30;
                factors.push('same_day');
            } else if (daysDiff <= 1) {
                score += 25;
                factors.push('next_day');
            } else if (daysDiff <= 3) {
                score += 20;
                factors.push('within_3_days');
            } else if (daysDiff <= 7) {
                score += 10;
                factors.push('within_week');
            }

            // Factor 3: Store name in transaction (0-30 points)
            const patterns = storePatterns[receipt.store] || [receipt.store];
            for (const pattern of patterns) {
                if (txName.includes(pattern)) {
                    score += 30;
                    factors.push('store_name_match');
                    break;
                }
            }

            // Bonus: Exact order ID match if available (overrides other scoring)
            if (receipt.orderId && txName.includes(receipt.orderId.toLowerCase())) {
                score = 100;
                factors.push('order_id_match');
            }

            if (score > bestScore) {
                bestScore = score;
                bestMatch = {
                    receipt,
                    score,
                    confidence: score / 100,
                    factors
                };
            }
        }

        // Threshold: only return if we have reasonable confidence
        if (bestScore >= 50) {
            return bestMatch;
        }

        return null;
    },

    // Get all unmatched transactions (for manual linking UI)
    async findUnmatchedTransactions(transactions) {
        const unmatched = [];
        for (const tx of transactions) {
            const match = await this.findMatchingReceiptWithConfidence(tx);
            if (!match || match.confidence < 0.5) {
                unmatched.push({
                    transaction: tx,
                    partialMatch: match // might have a low-confidence partial match
                });
            }
        }
        return unmatched;
    },

    // Manually link a transaction to a receipt
    async linkTransactionToReceipt(transactionId, receiptOrderId) {
        const links = await this.get('manualReceiptLinks') || {};
        links[transactionId] = {
            receiptOrderId,
            linkedAt: new Date().toISOString()
        };
        await this.set('manualReceiptLinks', links);
    },

    // Get manual link for a transaction
    async getManualReceiptLink(transactionId) {
        const links = await this.get('manualReceiptLinks') || {};
        return links[transactionId] || null;
    },

    // Find receipt by order ID
    async getReceiptByOrderId(orderId) {
        const receipts = await this.get(this.KEYS.STORE_RECEIPTS) || [];
        return receipts.find(r => r.orderId === orderId) || null;
    },

    // ==================== ITEM RULES (User-trained) ====================

    // Normalize item name for matching
    normalizeItemName(name) {
        if (!name) return null;
        return name
            .toLowerCase()
            .replace(/[#\*\d]+/g, ' ')         // Remove numbers and special chars
            .replace(/\s+/g, ' ')               // Normalize whitespace
            .replace(/\b(oz|lb|ct|pk|fl|ml|g|kg|count|pack|size)\b/gi, '') // Remove units
            .trim()
            .substring(0, 50);                  // Limit length
    },

    // Learn an item → category rule (user-trained)
    // Also extracts keywords and learns word-level associations
    async learnItemRule(itemName, category, source = 'user') {
        const rules = await this.get(this.KEYS.ITEM_RULES) || {};
        const normalized = this.normalizeItemName(itemName);

        if (!normalized || !category) {
            return null;
        }

        const now = new Date().toISOString();
        const existing = rules[normalized];

        if (existing) {
            existing.category = category;
            existing.count = (existing.count || 1) + 1;
            existing.lastSeen = now;
            existing.source = source;
        } else {
            rules[normalized] = {
                category,
                count: 1,
                firstSeen: now,
                lastSeen: now,
                source,
                originalName: itemName  // Keep original for display
            };
        }

        await this.set(this.KEYS.ITEM_RULES, rules);

        // Also learn keyword associations
        await this.learnKeywords(itemName, category);

        return rules[normalized];
    },

    // Extract keywords from text and learn category associations
    async learnKeywords(text, category) {
        const keywords = this.extractKeywords(text);
        if (keywords.length === 0) return;

        const weights = await this.get(this.KEYS.KEYWORD_WEIGHTS) || {};
        const now = new Date().toISOString();

        for (const keyword of keywords) {
            if (!weights[keyword]) {
                weights[keyword] = { categories: {}, totalCount: 0, firstSeen: now };
            }

            if (!weights[keyword].categories[category]) {
                weights[keyword].categories[category] = 0;
            }

            weights[keyword].categories[category]++;
            weights[keyword].totalCount++;
            weights[keyword].lastSeen = now;
        }

        await this.set(this.KEYS.KEYWORD_WEIGHTS, weights);
    },

    // Batch learn keywords from multiple items at once (avoids rate limiting)
    // items: Array of { text, category, tokens } or { text, category }
    async batchLearnKeywords(items) {
        if (!items || items.length === 0) return;

        const weights = await this.get(this.KEYS.KEYWORD_WEIGHTS) || {};
        const now = new Date().toISOString();
        let totalKeywords = 0;

        for (const item of items) {
            const keywords = item.tokens || this.extractKeywords(item.text);
            if (keywords.length === 0) continue;

            for (const keyword of keywords) {
                if (!weights[keyword]) {
                    weights[keyword] = { categories: {}, totalCount: 0, firstSeen: now };
                }

                if (!weights[keyword].categories[item.category]) {
                    weights[keyword].categories[item.category] = 0;
                }

                weights[keyword].categories[item.category]++;
                weights[keyword].totalCount++;
                weights[keyword].lastSeen = now;
            }
            totalKeywords += keywords.length;
        }

        await this.set(this.KEYS.KEYWORD_WEIGHTS, weights);
    },

    // Extract meaningful keywords from item text
    extractKeywords(text) {
        if (!text) return [];

        // Common stop words to ignore
        const stopWords = new Set([
            'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
            'of', 'with', 'by', 'from', 'as', 'is', 'was', 'are', 'were', 'been',
            'be', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would',
            'could', 'should', 'may', 'might', 'must', 'shall', 'can', 'need',
            'each', 'every', 'all', 'both', 'few', 'more', 'most', 'other',
            'some', 'such', 'no', 'nor', 'not', 'only', 'own', 'same', 'so',
            'than', 'too', 'very', 'just', 'also', 'now', 'new', 'good', 'high',
            'long', 'great', 'little', 'small', 'large', 'big', 'old', 'young',
            'ct', 'oz', 'lb', 'pk', 'ea', 'fl', 'ml', 'gal', 'qt', 'pt',
            'size', 'pack', 'count', 'each', 'total', 'item', 'product'
        ]);

        // Extract words: lowercase, remove special chars, split
        const words = text.toLowerCase()
            .replace(/[^a-z0-9\s-]/g, ' ')  // Remove special chars except hyphen
            .split(/\s+/)
            .filter(w => w.length >= 3 && !stopWords.has(w) && !/^\d+$/.test(w));

        return [...new Set(words)]; // Unique words only
    },

    // Get category suggestion based on keyword weights
    async suggestCategoryFromKeywords(text) {
        const keywords = this.extractKeywords(text);
        if (keywords.length === 0) return null;

        const weights = await this.get(this.KEYS.KEYWORD_WEIGHTS) || {};
        const categoryScores = {};
        let matchedKeywords = 0;

        for (const keyword of keywords) {
            const kw = weights[keyword];
            if (kw && kw.categories) {
                matchedKeywords++;
                for (const [cat, count] of Object.entries(kw.categories)) {
                    if (!categoryScores[cat]) categoryScores[cat] = 0;
                    // Weight by frequency of this keyword for this category
                    categoryScores[cat] += count / kw.totalCount;
                }
            }
        }

        if (matchedKeywords === 0) return null;

        // Find best category
        const best = Object.entries(categoryScores)
            .sort((a, b) => b[1] - a[1])[0];

        if (best) {
            const confidence = Math.min(0.85, 0.5 + (matchedKeywords / keywords.length) * 0.35);
            return {
                category: best[0],
                confidence,
                score: best[1],
                matchedKeywords,
                totalKeywords: keywords.length
            };
        }

        return null;
    },

    // Export keyword weights as CSV for analysis
    async exportKeywordsAsCSV() {
        const weights = await this.get(this.KEYS.KEYWORD_WEIGHTS) || {};
        const rows = ['keyword,category,count,percentage'];

        for (const [keyword, data] of Object.entries(weights)) {
            for (const [category, count] of Object.entries(data.categories)) {
                const pct = ((count / data.totalCount) * 100).toFixed(1);
                rows.push(`"${keyword}","${category}",${count},${pct}`);
            }
        }

        return rows.join('\\n');
    },

    // Debug: Show all stored category data
    async debugCategoryData() {
        const itemRules = await this.get(this.KEYS.ITEM_RULES) || {};
        const keywordWeights = await this.get(this.KEYS.KEYWORD_WEIGHTS) || {};
        const merchantRules = await this.get(this.KEYS.MERCHANT_RULES) || {};

        for (const [key, rule] of Object.entries(itemRules)) {
        }

        for (const [keyword, data] of Object.entries(keywordWeights)) {
            const cats = Object.entries(data.categories).map(([c, n]) => `${c}:${n}`).join(', ');
        }

        const categories = new Set();
        for (const rule of Object.values(merchantRules)) {
            const cat = typeof rule === 'string' ? rule : rule?.category;
            if (cat) categories.add(cat);
        }

        return { itemRules, keywordWeights, merchantRules };
    },

    // Clear item rules and keyword weights (reset item learning)
    async clearItemLearning() {
        await this.set(this.KEYS.ITEM_RULES, {});
        await this.set(this.KEYS.KEYWORD_WEIGHTS, {});
    },

    // Learn a mapping from pattern/semantic category to actual budget item
    // e.g., "Food and Household" → "Food Groceries"
    async learnCategoryMapping(patternCategory, budgetItem) {
        if (!patternCategory || !budgetItem || patternCategory === budgetItem) return;
        if (patternCategory === 'Uncategorized') return; // Don't map from Uncategorized

        const map = await this.get(this.KEYS.CATEGORY_MAP) || {};
        const now = new Date().toISOString();

        if (!map[patternCategory]) {
            map[patternCategory] = { budgetItem, count: 1, firstSeen: now, lastSeen: now };
        } else {
            // If same mapping, increment count
            if (map[patternCategory].budgetItem === budgetItem) {
                map[patternCategory].count++;
                map[patternCategory].lastSeen = now;
            } else {
                // Different mapping - if new one used more, switch
                // For now, just update to the newest selection
                map[patternCategory] = { budgetItem, count: 1, firstSeen: now, lastSeen: now };
            }
        }

        await this.set(this.KEYS.CATEGORY_MAP, map);
    },

    // Get the budget item for a pattern category
    async getMappedCategory(patternCategory) {
        if (!patternCategory) return null;
        const map = await this.get(this.KEYS.CATEGORY_MAP) || {};
        const mapping = map[patternCategory];
        if (mapping) {
            return mapping.budgetItem;
        }
        return null;
    },

    // Get item rule if exists
    async getItemRule(itemName) {
        const rules = await this.get(this.KEYS.ITEM_RULES) || {};
        const normalized = this.normalizeItemName(itemName);
        const rule = rules[normalized] || null;
        // Only log when a rule is found (reduces spam)
        if (rule) {
        }
        return rule;
    },

    // Map a store category to EveryDollar category
    mapStoreCategory(storeCategory) {
        if (!storeCategory) return null;

        const normalized = storeCategory.toLowerCase().trim();

        // Check exact match first
        if (this.STORE_CATEGORY_MAP[normalized]) {
            return this.STORE_CATEGORY_MAP[normalized];
        }

        // Check partial match
        for (const [key, value] of Object.entries(this.STORE_CATEGORY_MAP)) {
            if (normalized.includes(key) || key.includes(normalized)) {
                return value;
            }
        }

        return null;
    },

    // Add item to review queue
    async addToReviewQueue(item, receipt) {

        const queue = await this.get(this.KEYS.REVIEW_QUEUE) || [];

        // Check if already in queue
        const exists = queue.some(q =>
            this.normalizeItemName(q.name) === this.normalizeItemName(item.name)
        );

        if (!exists) {
            queue.push({
                name: item.name,
                price: item.price,
                store: receipt.store,
                storeCategory: item.storeCategory || null,
                addedAt: new Date().toISOString(),
                receiptId: receipt.orderId
            });

            // Keep queue to reasonable size
            if (queue.length > 100) {
                queue.splice(0, queue.length - 100);
            }

            await this.set(this.KEYS.REVIEW_QUEUE, queue);
        }
    },

    // Get review queue
    async getReviewQueue() {
        return await this.get(this.KEYS.REVIEW_QUEUE) || [];
    },

    // Remove from review queue (after user categorizes)
    async removeFromReviewQueue(itemName) {
        const queue = await this.get(this.KEYS.REVIEW_QUEUE) || [];
        const normalized = this.normalizeItemName(itemName);
        const filtered = queue.filter(q =>
            this.normalizeItemName(q.name) !== normalized
        );
        await this.set(this.KEYS.REVIEW_QUEUE, filtered);
    },

    // ==================== MERCHANT RULES ====================

    // Learn a merchant → category rule
    async learnMerchantRule(merchantName, category, source = 'scraped') {
        const rules = await this.get(this.KEYS.MERCHANT_RULES) || {};
        const normalizedMerchant = this.normalizeMerchantName(merchantName);

        if (!normalizedMerchant || !category) return null;

        const existing = rules[normalizedMerchant];
        const now = new Date().toISOString();

        if (existing) {
            // Update existing rule
            if (existing.category === category) {
                // Same category - reinforce
                existing.count = (existing.count || 1) + 1;
                existing.lastSeen = now;
            } else {
                // Different category - update if seen more recently and log conflict
                await this.addLearningLog('conflict', {
                    merchant: normalizedMerchant,
                    oldCategory: existing.category,
                    newCategory: category,
                    source
                });
                existing.category = category;
                existing.count = 1;
                existing.lastSeen = now;
                existing.source = source;
            }
        } else {
            // New rule
            rules[normalizedMerchant] = {
                category,
                count: 1,
                firstSeen: now,
                lastSeen: now,
                source
            };

            // Log that we learned something new
            await this.addLearningLog('new_rule', {
                merchant: normalizedMerchant,
                category,
                source
            });
        }

        await this.set(this.KEYS.MERCHANT_RULES, rules);

        // Also learn keyword associations from the full merchant name
        // This helps with fuzzy matching - tokens like "medical", "care", "target" become associated with categories
        await this.learnKeywords(merchantName, category);

        return rules[normalizedMerchant];
    },

    // Normalize merchant name for matching - keeps full cleaned name
    normalizeMerchantName(name) {
        if (!name) return null;

        // Clean up the name - remove noise but keep all meaningful words
        let normalized = name
            .toLowerCase()
            .replace(/[#\*]+/g, '')              // Remove # and *
            .replace(/\b\d{4,}\b/g, '')          // Remove long numbers (account #s, store #s)
            .replace(/\d+\.\d+%/g, '')           // Remove percentage rates (e.g., 0.100%)
            .replace(/\s+/g, ' ')                // Normalize whitespace
            .replace(/\.(com|net|org)/gi, '')   // Remove domain extensions
            .replace(/[']/g, '')                 // Remove apostrophes
            .replace(/\b(inc|llc|corp|ltd)\b/gi, '') // Remove business suffixes
            .replace(/\s+/g, ' ')                // Clean up whitespace again
            .trim();

        // Filter out very short words (1 char) but keep all meaningful words
        const words = normalized.split(' ').filter(w => w.length > 1);
        normalized = words.join(' ');

        return normalized || null;
    },

    // Check if `needle` appears in `haystack` at word boundaries
    isWordBoundaryMatch(haystack, needle) {
        const idx = haystack.indexOf(needle);
        if (idx === -1) return false;
        // Character before must be start-of-string or space
        const before = idx === 0 || haystack[idx - 1] === ' ';
        // Character after must be end-of-string or space
        const afterIdx = idx + needle.length;
        const after = afterIdx >= haystack.length || haystack[afterIdx] === ' ';
        return before && after;
    },

    // Get merchant rule - exact match first, then containment fallback
    async getMerchantRule(merchantName) {
        const rules = await this.get(this.KEYS.MERCHANT_RULES) || {};
        const normalized = this.normalizeMerchantName(merchantName);

        // 1. Exact match (highest confidence)
        if (rules[normalized]) return rules[normalized];

        // 2. Containment fallback - find best rule where key is in name or name is in key
        if (normalized && normalized.length >= 3) {
            let bestMatch = null;
            let bestMatchLength = 0;

            for (const [key, rule] of Object.entries(rules)) {
                if (key.length < 3) continue;

                // Check: rule key contained in normalized name at word boundary
                const keyInName = this.isWordBoundaryMatch(normalized, key);
                // Check: normalized name contained in rule key at word boundary
                const nameInKey = this.isWordBoundaryMatch(key, normalized);

                if ((keyInName || nameInKey) && key.length > bestMatchLength) {
                    bestMatch = { ...rule, fuzzy: true, matchedKey: key };
                    bestMatchLength = key.length;
                }
            }

            if (bestMatch) return bestMatch;
        }

        // Diagnostic: log lookup for transactions that DON'T match
        if (normalized) {
            const words = (normalized || '').split(' ');
            const similarKeys = Object.keys(rules).filter(key =>
                words.some(w => w.length > 2 && key.includes(w))
            ).slice(0, 5);
            console.log(`[EDB RuleLookup] NO MATCH for "${merchantName}" → normalized: "${normalized}"` +
                (similarKeys.length ? ` | Similar keys: ${JSON.stringify(similarKeys)}` : ' | No similar keys'));
        }

        return null;
    },

    // Get all merchant rules (for display)
    async getAllMerchantRules() {
        return await this.get(this.KEYS.MERCHANT_RULES) || {};
    },

    // Delete a merchant rule by normalized key
    async deleteMerchantRule(normalizedKey) {
        const rules = await this.get(this.KEYS.MERCHANT_RULES) || {};
        if (rules[normalizedKey]) {
            delete rules[normalizedKey];
            await this.set(this.KEYS.MERCHANT_RULES, rules);
            console.log(`[EDB Storage] Deleted merchant rule: "${normalizedKey}"`);
            return true;
        }
        return false;
    },

    // Update a merchant rule's category
    async updateMerchantRule(normalizedKey, newCategory) {
        const rules = await this.get(this.KEYS.MERCHANT_RULES) || {};
        if (rules[normalizedKey]) {
            rules[normalizedKey].category = newCategory;
            rules[normalizedKey].lastSeen = new Date().toISOString();
            await this.set(this.KEYS.MERCHANT_RULES, rules);
            console.log(`[EDB Storage] Updated merchant rule: "${normalizedKey}" → ${newCategory}`);
            return true;
        }
        return false;
    },

    // Get all item rules (for display)
    async getAllItemRules() {
        return await this.get(this.KEYS.ITEM_RULES) || {};
    },

    // Delete an item rule by normalized key
    async deleteItemRule(normalizedKey) {
        const rules = await this.get(this.KEYS.ITEM_RULES) || {};
        if (rules[normalizedKey]) {
            delete rules[normalizedKey];
            await this.set(this.KEYS.ITEM_RULES, rules);
            console.log(`[EDB Storage] Deleted item rule: "${normalizedKey}"`);
            return true;
        }
        return false;
    },

    // Update an item rule's category
    async updateItemRule(normalizedKey, newCategory) {
        const rules = await this.get(this.KEYS.ITEM_RULES) || {};
        if (rules[normalizedKey]) {
            rules[normalizedKey].category = newCategory;
            rules[normalizedKey].lastSeen = new Date().toISOString();
            await this.set(this.KEYS.ITEM_RULES, rules);
            console.log(`[EDB Storage] Updated item rule: "${normalizedKey}" → ${newCategory}`);
            return true;
        }
        return false;
    },

    // Get all keyword weights (for display)
    async getAllKeywordWeights() {
        return await this.get(this.KEYS.KEYWORD_WEIGHTS) || {};
    },

    // Delete a keyword weight entry
    async deleteKeywordWeight(keyword) {
        const weights = await this.get(this.KEYS.KEYWORD_WEIGHTS) || {};
        if (weights[keyword]) {
            delete weights[keyword];
            await this.set(this.KEYS.KEYWORD_WEIGHTS, weights);
            console.log(`[EDB Storage] Deleted keyword weight: "${keyword}"`);
            return true;
        }
        return false;
    },

    // Get all category mappings (for display)
    async getAllCategoryMappings() {
        return await this.get(this.KEYS.CATEGORY_MAP) || {};
    },

    // Delete a category mapping
    async deleteCategoryMapping(patternKey) {
        const mappings = await this.get(this.KEYS.CATEGORY_MAP) || {};
        if (mappings[patternKey]) {
            delete mappings[patternKey];
            await this.set(this.KEYS.CATEGORY_MAP, mappings);
            console.log(`[EDB Storage] Deleted category mapping: "${patternKey}"`);
            return true;
        }
        return false;
    },

    // Update a category mapping
    async updateCategoryMapping(patternKey, newBudgetItem) {
        const mappings = await this.get(this.KEYS.CATEGORY_MAP) || {};
        if (mappings[patternKey]) {
            mappings[patternKey].budgetItem = newBudgetItem;
            await this.set(this.KEYS.CATEGORY_MAP, mappings);
            console.log(`[EDB Storage] Updated category mapping: "${patternKey}" → ${newBudgetItem}`);
            return true;
        }
        return false;
    },

    // ==================== LEARNING LOG ====================

    // Add entry to learning log
    async addLearningLog(type, details) {
        const log = await this.get(this.KEYS.LEARNING_LOG) || [];

        log.push({
            type,       // 'new_rule', 'conflict', 'bulk_learn', 'manual_apply'
            details,
            timestamp: new Date().toISOString()
        });

        // Keep last 200 log entries
        if (log.length > 200) {
            log.splice(0, log.length - 200);
        }

        await this.set(this.KEYS.LEARNING_LOG, log);
    },

    // Get learning log
    async getLearningLog(limit = 50) {
        const log = await this.get(this.KEYS.LEARNING_LOG) || [];
        // Return most recent first
        return log.slice(-limit).reverse();
    },

    // Get learning stats
    async getLearningStats() {
        const rules = await this.get(this.KEYS.MERCHANT_RULES) || {};
        const log = await this.get(this.KEYS.LEARNING_LOG) || [];
        const learned = await this.get(this.KEYS.LEARNED_TRANSACTIONS) || [];

        const rulesList = Object.entries(rules);
        const categories = {};
        let totalObservations = 0;

        for (const [merchant, rule] of rulesList) {
            categories[rule.category] = (categories[rule.category] || 0) + 1;
            totalObservations += rule.count || 1;
        }

        return {
            totalRules: rulesList.length,
            totalObservations: totalObservations,
            logEntries: log.length,
            categoryCounts: categories,
            topMerchants: rulesList
                .sort((a, b) => (b[1].count || 1) - (a[1].count || 1))
                .slice(0, 10)
                .map(([merchant, rule]) => ({
                    merchant,
                    category: rule.category,
                    count: rule.count || 1
                }))
        };
    },

    // Clear all learned data (for reset)
    async clearLearnedData() {
        await this.set(this.KEYS.MERCHANT_RULES, {});
        await this.set(this.KEYS.LEARNING_LOG, []);
        await this.set(this.KEYS.LEARNED_TRANSACTIONS, []);
        await this.addLearningLog('reset', { reason: 'manual_clear' });
    }
};

// Make available globally
if (typeof window !== 'undefined') {
    window.StorageManager = StorageManager;
}
