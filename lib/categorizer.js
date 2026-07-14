// Categorizer engine - the brain of the extension
// Handles pattern matching, semantic analysis, seasonal detection, and confidence scoring

const Categorizer = {
    // Analyze a transaction and return categorization suggestions
    async analyze(transaction) {
        const suggestions = [];

        // 0. Check merchant rules FIRST (highest priority - learned from tracked)
        const merchantRule = await this.checkMerchantRule(transaction);
        if (merchantRule) {
            suggestions.push({
                category: merchantRule.category,
                confidence: merchantRule.confidence,
                reason: merchantRule.reason,
                source: 'merchant_rule'
            });
        }

        // 0b. For returns (positive amounts), match against tracked purchases
        const returnMatch = await this.matchReturnToPurchase(transaction);
        if (returnMatch) {
            suggestions.push({
                category: returnMatch.category,
                confidence: returnMatch.confidence,
                reason: returnMatch.reason,
                source: 'return_match'
            });
        }

        // 1. Check for exact learned match (high confidence)
        const exactMatch = await this.findExactMatch(transaction);
        if (exactMatch) {
            suggestions.push({
                category: exactMatch.category,
                confidence: 0.90, // Slightly lower than merchant rules
                reason: exactMatch.formattedReason || `Previously categorized as ${exactMatch.category}`,
                source: 'learned_exact'
            });
        }

        // 2. Check for similar learned transactions
        const similarMatches = await this.findSimilarMatches(transaction);
        for (const match of similarMatches) {
            suggestions.push({
                category: match.category,
                confidence: match.confidence,
                reason: match.reason,
                source: 'learned_similar'
            });
        }

        // 3. Check pattern rules
        const patternMatch = await this.matchPatterns(transaction);
        if (patternMatch) {
            suggestions.push({
                category: patternMatch.category,
                confidence: patternMatch.confidence,
                reason: patternMatch.reason,
                source: 'pattern'
            });
        }

        // 4. Check seasonal patterns
        const seasonalMatch = await this.checkSeasonalPatterns(transaction);
        if (seasonalMatch) {
            suggestions.push({
                category: seasonalMatch.category,
                confidence: seasonalMatch.confidence,
                reason: seasonalMatch.reason,
                source: 'seasonal'
            });
        }

        // 5. Semantic analysis ("sounds like")
        const semanticMatch = await this.semanticAnalysis(transaction);
        if (semanticMatch) {
            suggestions.push({
                category: semanticMatch.category,
                confidence: semanticMatch.confidence,
                reason: semanticMatch.reason,
                source: 'semantic'
            });
        }

        // Diagnostic: log when all 5 sources fail to produce a suggestion
        if (suggestions.length === 0) {
            console.log(`[EDB Categorizer] ALL SOURCES FAILED for "${transaction.name}" (${transaction.amount}): ` +
                `merchantRule=${!!merchantRule}, returnMatch=${!!returnMatch}, exactMatch=${!!exactMatch}, ` +
                `similarMatches=${similarMatches.length}, patternMatch=${!!patternMatch}, ` +
                `seasonalMatch=${!!seasonalMatch}, semanticMatch=${!!semanticMatch}`);
        }

        // Aggregate and return best suggestion
        return this.aggregateSuggestions(suggestions);
    },

    // Check merchant rules (learned from tracked transactions)
    async checkMerchantRule(transaction) {
        const rule = await StorageManager.getMerchantRule(transaction.name);
        if (!rule) return null;

        // Fuzzy matches get lower base confidence
        const baseConfidence = rule.fuzzy ? 0.80 : 0.92;
        const countBonus = Math.min((rule.count - 1) * 0.02, 0.07); // Max +7% for frequently seen
        const matchNote = rule.fuzzy ? ` (fuzzy: matched "${rule.matchedKey}")` : '';

        return {
            category: rule.category,
            confidence: baseConfidence + countBonus,
            reason: `Learned from ${rule.count} tracked transaction${rule.count > 1 ? 's' : ''}${matchNote}`
        };
    },

    // Match a return (positive amount) to a tracked purchase from the same merchant
    // Returns are categorized to the same budget item as the original purchase
    async matchReturnToPurchase(transaction) {
        const amount = parseFloat(transaction.amount);
        if (amount <= 0) return null; // Only for positive amounts (potential returns)

        // Filter out income keywords — these aren't store returns
        const txName = (transaction.name || '').toLowerCase();
        if (/deposit|dividend|transfer|ach |payroll|income|interest|payment/i.test(txName)) {
            return null;
        }

        const txMerchant = this.normalizeName(transaction.name);
        const returnAmount = Math.abs(amount);

        // Strategy 1: Try to match against individual learned transactions (best — amount-aware)
        const learned = await StorageManager.get(StorageManager.KEYS.LEARNED_TRANSACTIONS) || [];
        if (learned.length > 0) {
            let bestMatch = null;
            let bestScore = 0;

            for (const l of learned) {
                const learnedAmount = parseFloat(l.amount);
                // Skip entries with no meaningful amount
                if (!learnedAmount || learnedAmount === 0) continue;
                // We want purchases: negative amounts from bank (New tab) or
                // positive amounts from tracked tab (auto-learn stores absolute values)
                // Either way, compare absolute values

                const learnedMerchant = this.normalizeName(l.name);

                // Merchant must match
                if (txMerchant !== learnedMerchant) {
                    const sim = this.calculateStringSimilarity(txMerchant, learnedMerchant);
                    if (sim < 0.7) continue;
                }

                // Amount must be close (return <= purchase, within 20% or $5)
                const purchaseAmount = Math.abs(learnedAmount);
                if (returnAmount > purchaseAmount + 0.50) continue;
                const amountDiff = Math.abs(purchaseAmount - returnAmount);
                if (amountDiff > purchaseAmount * 0.2 && amountDiff > 5) continue;

                let score = 0;
                if (amountDiff < 0.01) score += 50;
                else if (amountDiff < 0.50) score += 40;
                else if (amountDiff < 1) score += 30;
                else if (amountDiff < 3) score += 15;
                else score += 5;

                if (l.date && transaction.date) {
                    try {
                        const purchaseDate = new Date(l.date);
                        const returnDate = new Date(transaction.date);
                        const daysDiff = (returnDate - purchaseDate) / (1000 * 60 * 60 * 24);
                        if (daysDiff >= 0 && daysDiff < 14) score += 20;
                        else if (daysDiff >= 0 && daysDiff < 45) score += 10;
                        else if (daysDiff >= 0 && daysDiff < 90) score += 5;
                    } catch (e) { }
                }

                if (score > bestScore && l.category) {
                    bestScore = score;
                    bestMatch = l;
                }
            }

            if (bestMatch && bestScore >= 15) {
                const purchaseAmt = `$${Math.abs(parseFloat(bestMatch.amount)).toFixed(2)}`;
                console.log(`[EDB Categorizer] Return matched via learnedTransactions: "${transaction.name}" → ${bestMatch.category} (purchase ${purchaseAmt})`);
                return {
                    category: bestMatch.category,
                    confidence: Math.min(0.85 + (bestScore - 15) * 0.002, 0.95),
                    reason: `Return matched to tracked purchase (${purchaseAmt} → ${bestMatch.category})`
                };
            }
        }

        // Strategy 2: Fall back to merchantRules (auto-learn populates these)
        // This gives us the merchant's known category even without per-amount matching
        const merchantRule = await StorageManager.getMerchantRule(transaction.name);
        const ruleCategory = merchantRule?.category || (typeof merchantRule === 'string' ? merchantRule : null);
        if (ruleCategory) {
            console.log(`[EDB Categorizer] Return matched via merchantRule: "${transaction.name}" → ${ruleCategory}`);
            return {
                category: ruleCategory,
                confidence: 0.80,
                reason: `Return from ${transaction.name} → ${ruleCategory} (merchant rule)`
            };
        }

        return null;
    },

    // Find exact match in learned transactions
    async findExactMatch(transaction) {
        const learned = await StorageManager.get(StorageManager.KEYS.LEARNED_TRANSACTIONS) || [];
        const txName = this.normalizeName(transaction.name);

        const match = learned.find(l => this.normalizeName(l.name) === txName);
        if (match) {
            // Format the date nicely - prefer learnedAt over transaction date
            let dateStr = 'previously';
            try {
                // Use learnedAt date (when we saved it) rather than transaction date
                // since transaction dates may have parsing issues
                const dateToUse = match.learnedAt || match.date;
                const d = new Date(dateToUse);
                // Sanity check - if year is in the future, use current date
                if (d.getFullYear() > new Date().getFullYear()) {
                    dateStr = 'recently';
                } else {
                    dateStr = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
                }
            } catch (e) { }

            const sourceDesc = match.source === 'auto' ? 'auto-applied' :
                match.source === 'auto-applied' ? 'auto-applied' :
                    match.source === 'manual-apply' ? 'manually applied' :
                        match.source === 'scraped' ? 'learned' :
                            match.source === 'auto-learned' ? 'auto-learned' :
                                match.source || 'previously categorized';

            return {
                ...match,
                formattedReason: `Exact match (${sourceDesc} ${dateStr})`
            };
        }
        return null;
    },

    // Find similar matches using fuzzy logic
    async findSimilarMatches(transaction) {
        const learned = await StorageManager.get(StorageManager.KEYS.LEARNED_TRANSACTIONS) || [];
        const txName = this.normalizeName(transaction.name);
        const txAmount = Math.abs(parseFloat(transaction.amount));
        const matches = [];

        for (const l of learned) {
            const learnedName = this.normalizeName(l.name);
            const learnedAmount = Math.abs(parseFloat(l.amount));

            // Calculate similarity score
            let similarity = 0;
            let reasons = [];

            // Name similarity (Levenshtein-ish)
            const nameSim = this.calculateStringSimilarity(txName, learnedName);
            if (nameSim > 0.7) {
                similarity += nameSim * 0.5;
                reasons.push(`Similar name (${Math.round(nameSim * 100)}% match)`);
            }

            // Check if one contains the other (common with transaction codes)
            if (txName.includes(learnedName) || learnedName.includes(txName)) {
                similarity += 0.3;
                reasons.push('Name contains match');
            }

            // Amount similarity (within 20%)
            if (txAmount > 0 && learnedAmount > 0) {
                const amountDiff = Math.abs(txAmount - learnedAmount) / Math.max(txAmount, learnedAmount);
                if (amountDiff < 0.2) {
                    similarity += (1 - amountDiff) * 0.2;
                    reasons.push('Similar amount');
                }
            }

            // Same merchant pattern
            const merchantMatch = this.extractMerchant(txName) === this.extractMerchant(learnedName);
            if (merchantMatch && this.extractMerchant(txName)) {
                similarity += 0.2;
                reasons.push('Same merchant');
            }

            if (similarity > 0.5) {
                matches.push({
                    category: l.category,
                    confidence: Math.min(similarity, 0.9),
                    reason: reasons.join(', ')
                });
            }
        }

        // Return top 3 matches
        return matches.sort((a, b) => b.confidence - a.confidence).slice(0, 3);
    },

    // Match against category patterns
    async matchPatterns(transaction) {
        const patterns = await StorageManager.get(StorageManager.KEYS.CATEGORY_PATTERNS) || {};
        const txName = this.normalizeName(transaction.name);

        for (const [category, config] of Object.entries(patterns)) {
            // Check regex patterns
            for (const pattern of config.patterns || []) {
                try {
                    const regex = new RegExp(pattern, 'i');
                    if (regex.test(txName)) {
                        return {
                            category,
                            confidence: 0.8,
                            reason: `Matches pattern: ${pattern}`
                        };
                    }
                } catch (e) {
                }
            }

            // Check keywords
            for (const keyword of config.keywords || []) {
                if (txName.includes(keyword.toLowerCase())) {
                    return {
                        category,
                        confidence: 0.7,
                        reason: `Contains keyword: ${keyword}`
                    };
                }
            }
        }

        return null;
    },

    // Check seasonal patterns (Christmas gifts, etc.)
    async checkSeasonalPatterns(transaction) {
        const seasonalPatterns = await StorageManager.get(StorageManager.KEYS.SEASONAL_PATTERNS) || {};
        const txDate = new Date(transaction.date);
        const txMonth = txDate.getMonth() + 1;
        const txDay = txDate.getDate();
        const txName = this.normalizeName(transaction.name);

        for (const [category, config] of Object.entries(seasonalPatterns)) {
            for (const range of config.dateRanges || []) {
                const inRange = this.isInDateRange(txMonth, txDay, range.start, range.end);

                if (inRange) {
                    // Check if transaction matches seasonal patterns
                    for (const pattern of config.patterns || []) {
                        if (txName.includes(pattern.toLowerCase())) {
                            return {
                                category,
                                confidence: 0.75,
                                reason: `${range.name} season + matches "${pattern}"`
                            };
                        }
                    }
                }
            }
        }

        return null;
    },

    // Semantic analysis - "sounds like" matching
    async semanticAnalysis(transaction) {
        const txName = this.normalizeName(transaction.name);

        // Semantic word associations
        const semanticMap = {
            'Food and Household': {
                words: ['food', 'eat', 'grocery', 'market', 'produce', 'bakery', 'deli', 'meat', 'dairy', 'organic'],
                suffixes: ['mart', 'foods', 'market', 'grocery']
            },
            'Restaurants': {
                words: ['grill', 'cafe', 'coffee', 'pizza', 'burger', 'taco', 'sushi', 'thai', 'chinese', 'mexican', 'italian', 'diner', 'bistro', 'pub', 'bar', 'brewery', 'kitchen', 'eatery'],
                suffixes: ['grill', 'cafe', 'coffee', 'pizza', 'kitchen', 'diner', 'bistro']
            },
            'Transportation': {
                words: ['auto', 'car', 'vehicle', 'tire', 'oil', 'lube', 'garage', 'motor', 'gas', 'fuel', 'parking'],
                suffixes: ['auto', 'motors', 'automotive', 'tire']
            },
            'Health': {
                words: ['health', 'medical', 'dental', 'vision', 'pharmacy', 'clinic', 'hospital', 'doctor', 'therapy', 'wellness'],
                suffixes: ['health', 'medical', 'dental', 'pharmacy', 'clinic', 'care']
            },
            'Entertainment': {
                words: ['movie', 'theater', 'cinema', 'game', 'play', 'fun', 'entertainment', 'concert', 'show', 'ticket'],
                suffixes: ['theater', 'cinema', 'entertainment', 'games']
            }
        };

        let bestMatch = null;
        let bestScore = 0;

        for (const [category, config] of Object.entries(semanticMap)) {
            let score = 0;
            let matchedWord = null;

            for (const word of config.words) {
                if (txName.includes(word)) {
                    score += 0.6;
                    matchedWord = word;
                    break;
                }
            }

            for (const suffix of config.suffixes) {
                if (txName.endsWith(suffix) || txName.includes(suffix + ' ')) {
                    score += 0.4;
                    matchedWord = matchedWord || suffix;
                }
            }

            if (score > bestScore) {
                bestScore = score;
                bestMatch = {
                    category,
                    confidence: Math.min(score, 0.7),
                    reason: `Sounds like ${category} (contains "${matchedWord}")`
                };
            }
        }

        return bestScore > 0.4 ? bestMatch : null;
    },

    // Aggregate multiple suggestions into a final recommendation
    aggregateSuggestions(suggestions) {
        if (suggestions.length === 0) {
            return null;
        }

        // Group by category and sum confidence (with diminishing returns)
        const categoryScores = {};
        const categoryReasons = {};

        for (const s of suggestions) {
            if (!categoryScores[s.category]) {
                categoryScores[s.category] = 0;
                categoryReasons[s.category] = [];
            }

            // Diminishing returns for multiple signals
            const existingScore = categoryScores[s.category];
            const boost = s.confidence * (1 - existingScore * 0.3);
            categoryScores[s.category] = Math.min(existingScore + boost, 0.98);
            categoryReasons[s.category].push(s.reason);
        }

        // Find best category
        let bestCategory = null;
        let bestScore = 0;

        for (const [category, score] of Object.entries(categoryScores)) {
            if (score > bestScore) {
                bestScore = score;
                bestCategory = category;
            }
        }

        if (!bestCategory) return null;

        return {
            category: bestCategory,
            confidence: bestScore,
            reasons: categoryReasons[bestCategory],
            allSuggestions: suggestions
        };
    },

    // Helper: Normalize transaction name for comparison
    normalizeName(name) {
        return (name || '')
            .toLowerCase()
            .replace(/[^a-z0-9\s]/g, '')
            .replace(/\s+/g, ' ')
            .trim();
    },

    // Helper: Extract likely merchant name from transaction
    extractMerchant(name) {
        const normalized = this.normalizeName(name);
        // Remove common suffixes like card numbers, locations
        const cleaned = normalized
            .replace(/\d{4,}/g, '') // Remove long numbers
            .replace(/\b(visa|mastercard|debit|credit|signature|checking)\b/gi, '')
            .replace(/\b[a-z]{2}\s*$/i, '') // Remove state abbreviations at end
            .trim();

        // Take first 2-3 words as merchant name
        const words = cleaned.split(' ').slice(0, 3);
        return words.join(' ');
    },

    // Helper: Calculate string similarity (simplified Levenshtein ratio)
    calculateStringSimilarity(str1, str2) {
        if (str1 === str2) return 1;
        if (!str1 || !str2) return 0;

        const longer = str1.length > str2.length ? str1 : str2;
        const shorter = str1.length > str2.length ? str2 : str1;

        if (longer.length === 0) return 1;

        // Simple containment check
        if (longer.includes(shorter)) {
            return shorter.length / longer.length;
        }

        // Word overlap
        const words1 = new Set(str1.split(' '));
        const words2 = new Set(str2.split(' '));
        const intersection = new Set([...words1].filter(x => words2.has(x)));
        const union = new Set([...words1, ...words2]);

        return intersection.size / union.size;
    },

    // Helper: Check if date is within a seasonal range
    isInDateRange(month, day, start, end) {
        const dateNum = month * 100 + day;
        const startNum = start.month * 100 + start.day;
        const endNum = end.month * 100 + end.day;

        if (startNum <= endNum) {
            return dateNum >= startNum && dateNum <= endNum;
        } else {
            // Range crosses year boundary (e.g., Dec 15 to Jan 5)
            return dateNum >= startNum || dateNum <= endNum;
        }
    },

    // Apply a rename rule to a transaction name
    async applyRenameRules(name) {
        const rules = await StorageManager.get(StorageManager.KEYS.RENAME_RULES) || {};
        const normalized = this.normalizeName(name);

        for (const [pattern, newName] of Object.entries(rules)) {
            try {
                const regex = new RegExp(pattern, 'i');
                if (regex.test(normalized) || normalized.includes(pattern)) {
                    return newName;
                }
            } catch (e) {
                // Treat as literal string match
                if (normalized.includes(pattern)) {
                    return newName;
                }
            }
        }

        return null; // No rename rule matched
    },

    // Categorize a single item (from a receipt)
    async categorizeItem(itemName, itemPrice) {

        // 1. First check for exact item rule (user-trained)
        const itemRule = await StorageManager.getItemRule(itemName);
        if (itemRule) {
            return {
                category: itemRule.category,
                confidence: Math.min(0.95, 0.85 + (itemRule.count - 1) * 0.02),
                source: 'item_rule'
            };
        }

        // 2. Check keyword-based suggestions (learned word associations)
        const keywordSuggestion = await StorageManager.suggestCategoryFromKeywords(itemName);
        if (keywordSuggestion && keywordSuggestion.confidence > 0.6) {
            return {
                category: keywordSuggestion.category,
                confidence: keywordSuggestion.confidence,
                source: 'keyword_weights'
            };
        }

        // 3. Fallback to general analysis (patterns, semantic)
        // But use a pseudo-transaction WITHOUT checking merchant rules
        // since item names aren't merchants
        const patternMatch = await this.matchPatterns({ name: itemName, amount: itemPrice || 0 });
        if (patternMatch && patternMatch.confidence > 0.6) {
            // Check if we have a learned mapping for this pattern category
            const mappedCategory = await StorageManager.getMappedCategory(patternMatch.category);
            const finalCategory = mappedCategory || patternMatch.category;
            return {
                category: finalCategory,
                confidence: mappedCategory ? patternMatch.confidence + 0.05 : patternMatch.confidence,
                source: mappedCategory ? 'pattern_mapped' : 'pattern',
                originalCategory: patternMatch.category  // Keep original for learning
            };
        }

        const semanticMatch = await this.semanticAnalysis({ name: itemName, amount: itemPrice || 0 });
        if (semanticMatch && semanticMatch.confidence > 0.5) {
            // Check if we have a learned mapping for this semantic category
            const mappedCategory = await StorageManager.getMappedCategory(semanticMatch.category);
            const finalCategory = mappedCategory || semanticMatch.category;
            return {
                category: finalCategory,
                confidence: mappedCategory ? semanticMatch.confidence + 0.05 : semanticMatch.confidence,
                source: mappedCategory ? 'semantic_mapped' : 'semantic',
                originalCategory: semanticMatch.category  // Keep original for learning
            };
        }

        // Fallback: return uncategorized
        return {
            category: 'Uncategorized',
            confidence: 0.3,
            source: 'default'
        };
    },

    // Calculate split based on receipt items
    async calculateSplit(transaction, receipt) {
        if (!receipt || !receipt.items || receipt.items.length === 0) {
            return null;
        }

        const categorizedItems = [];
        let uncategorizedTotal = 0;

        for (const item of receipt.items) {
            const itemAnalysis = await this.analyze({
                name: item.name,
                amount: item.price,
                date: transaction.date
            });

            if (itemAnalysis && itemAnalysis.confidence > 0.6) {
                categorizedItems.push({
                    name: item.name,
                    price: item.price,
                    category: itemAnalysis.category,
                    confidence: itemAnalysis.confidence
                });
            } else {
                uncategorizedTotal += item.price;
            }
        }

        // Group by category
        const splits = {};
        for (const item of categorizedItems) {
            if (!splits[item.category]) {
                splits[item.category] = {
                    amount: 0,
                    items: []
                };
            }
            splits[item.category].amount += item.price;
            splits[item.category].items.push(item.name);
        }

        // Add uncategorized to largest category or create "Other"
        if (uncategorizedTotal > 0) {
            const categories = Object.keys(splits);
            if (categories.length > 0) {
                const largestCategory = categories.reduce((a, b) =>
                    splits[a].amount > splits[b].amount ? a : b
                );
                splits[largestCategory].amount += uncategorizedTotal;
            }
        }

        return splits;
    }
};

// Make available globally
if (typeof window !== 'undefined') {
    window.Categorizer = Categorizer;
}
